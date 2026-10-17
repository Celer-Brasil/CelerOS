#include "LogPersist.h"

#include "../Display/Backlight.h"
#include "../Display/ScreenPower.h"
#include "../FileSystem/FileSystem.h"
#include "../Hardware/AudioPlayer.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include <cstdio>
#include <cstring>

// ============================================================
// LogPersist — logs persistentes no padrao /var/log do Linux
// ============================================================
//
// kern.log recebe o firmware (ESP_LOG pelo hook do SerialLink + celer_log_*);
// apps.log recebe os System.print dos apps com o pacote na frente. O staging
// e RAM estatica (sem malloc: alocacao falhando aborta o aparelho) e o flush
// roda no servico "logpersist" do CelerServices (~3 s ou buffer quase cheio),
// com o vidro apagado — ver tick().
//
// O flush copia o staging para um buffer de saida sob o mutex e escreve
// DEPOIS de soltar: o fwrite do LittleFS pode logar erro pelo ESP_LOG, e
// isso voltaria para o staging com o mutex na mao (deadlock). Produtores que
// chegam na janela de copia (~1 ms) perdem a linha no ARQUIVO — o take do
// kern/app e sem espera justamente para nao entalar o roteador de logs.
//
// Spam (retry de link caido, batimento do wake word) colapsa no dedup:
// linha identica a anterior so incrementa o contador; a marcacao
// "... (repetiu N x)" entra quando a linha muda ou no fim do flush. Sem
// isso o ring de 8 KB morria em ~1 min e o arquivo virava o mesmo rio.

namespace {

// Staging GRANDE onde ha PSRAM: o flush espera o vidro apagar (ver tick), e
// quanto maior o staging, mais raro o flush de emergencia "quase cheio" com
// a tela acesa (8 KB = a malha ruidosa flusha a cada ~8 min, nao a cada 3 s).
// Sem PSRAM (CYD/devkit) o footprint fica o de sempre: estourar a interna
// aborta o aparelho, nao rejeita a alocacao.
constexpr size_t kKernBig = 8192;
constexpr size_t kAppsBig = 4096;
constexpr size_t kKernSmall = 1536;
constexpr size_t kAppsSmall = 768;
constexpr size_t kFlushBig = 8192;
constexpr size_t kFlushSmall = 2048;
constexpr size_t kLastCmp = 96;     // janela de comparacao do dedup

struct Stage {
    char* buf;         // PSRAM grande ou interna pequena (init)
    size_t cap;        // o que couber em buf
    size_t n;
    char last[kLastCmp];
    size_t lastLen;
    uint32_t repeats;
};

// Ponteiros alocados no init: PSRAM quando ha (a RAM interna do cao foi a
// 188 B livres — 4,4 KB de staging estatico entalhavam o DMA do alto-falante)
Stage* s_kern = nullptr;
Stage* s_apps = nullptr;
char* s_flush = nullptr;
size_t s_flushCap = 0;
SemaphoreHandle_t s_mux = nullptr;
bool s_ok = true;        // fopen/fwrite falhou: desiste ate o reboot (ring segue)
bool s_dirTried = false;
bool s_bootMark = false;

void stageLine(Stage& st, const char* line, size_t len) {
    // dedup: compara o comeco da linha (janela kLastCmp) com a anterior,
    // IGNORANDO o prefixo de nivel+uptime do ESP_LOG ("I (12345) ") — o
    // mesmo evento em instantes distintos tem timestamps diferentes e o
    // dedup ingenuo nunca colapsava nada do firmware
    size_t pre = 0;
    if (len > 4 && line[1] == ' ' && (line[0] == 'I' || line[0] == 'W' ||
                                      line[0] == 'E' || line[0] == 'D') && line[2] == '(') {
        size_t i = 2;
        while (i < len && line[i] != ')') i++;
        if (i + 1 < len && line[i + 1] == ' ') pre = i + 2;
    }
    const size_t cmpLen = len - pre > kLastCmp - 1 ? kLastCmp - 1 : len - pre;
    if (cmpLen == st.lastLen && memcmp(line + pre, st.last, cmpLen) == 0) {
        st.repeats++;
        return;
    }
    if (st.repeats > 0) {
        char mark[48];
        int m = snprintf(mark, sizeof(mark), "... (repetiu %u x)\n", (unsigned)st.repeats);
        if (m > 0 && st.n + (size_t)m < st.cap) {
            memcpy(st.buf + st.n, mark, (size_t)m);
            st.n += (size_t)m;
        }
        st.repeats = 0;
    }
    if (st.n + len >= st.cap) return;  // cheio: o tick esta atrasado
    memcpy(st.buf + st.n, line, len);
    st.n += len;
    memcpy(st.last, line + pre, cmpLen);
    st.lastLen = cmpLen;
}

void writeOut(const char* name, const char* data, size_t n) {
    if (!s_ok || n == 0) return;
    // SD montado e a casa dos logs (teto maior); littlefs e o fallback.
    // sdMounted e so um flag: o getTotalSpace antigo fazia f_getfree, que
    // num cartao com FSInfo invalido varre a FAT inteira (> 45 s no SDSPI)
    // aqui na task main — task WDT e crash-loop (esp32-cam, 2026-10-10).
    const bool sd = FileSystem::sdMounted();
    const char* base = sd ? "/sd/log" : "/local/log";
    if (!s_dirTried) {
        FileSystem::mkdir(base);  // idempotente
        s_dirTried = true;
    }
    char path[40];
    snprintf(path, sizeof(path), "%s/%s.log", base, name);
    const size_t cap = sd ? 64 * 1024 : 8 * 1024;
    size_t size = FileSystem::getFileSize(path);
    if (size + n > cap) {  // rotacao logrotate: o .1 guarda a geracao anterior
        char old[46];
        snprintf(old, sizeof(old), "%s.1", path);
        FileSystem::deleteFile(old);
        if (!FileSystem::renameFile(path, old)) {
            s_ok = false;
            return;
        }
        size = 0;
    }
    FILE* f = fopen(path, "a");
    if (f == nullptr) {
        s_ok = false;
        return;
    }
    if (!s_bootMark) {  // marcador de boot no arquivo corrente (1x por boot)
        fprintf(f, "\n===== boot CelerOS " CELEROS_VERSION " =====\n");
        s_bootMark = true;
    }
    const size_t w = fwrite(data, 1, n, f);
    if (fclose(f) != 0 || w != n) s_ok = false;
}

void flushStage(Stage& st, const char* name) {
    if (st.n == 0 && st.repeats == 0) return;
    if (xSemaphoreTake(s_mux, portMAX_DELAY) != pdTRUE) return;
    if (st.repeats > 0) {  // spam contando ate o fim do flush sem linha nova
        char mark[48];
        int m = snprintf(mark, sizeof(mark), "... (repetiu %u x)\n", (unsigned)st.repeats);
        if (m > 0 && st.n + (size_t)m < st.cap) {
            memcpy(st.buf + st.n, mark, (size_t)m);
            st.n += (size_t)m;
        }
        st.repeats = 0;
    }
    size_t n = st.n > s_flushCap ? s_flushCap : st.n;
    memcpy(s_flush, st.buf, n);
    st.n -= n;
    memmove(st.buf, st.buf + n, st.n);  // sobra drena no proximo tick
    xSemaphoreGive(s_mux);
    writeOut(name, s_flush, n);
}

// Staging de um canal: PSRAM com o teto grande; sem PSRAM, interna com o
// footprint pequeno (o tamanho grande ali aborta o boot).
Stage* novoStage(size_t big, size_t small) {
    size_t cap = big;
    void* b = heap_caps_malloc(cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (b == nullptr) {
        cap = small;
        b = heap_caps_malloc(cap, MALLOC_CAP_8BIT);
    }
    if (b == nullptr) return nullptr;
    void* h = heap_caps_malloc(sizeof(Stage), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (h == nullptr) h = heap_caps_malloc(sizeof(Stage), MALLOC_CAP_8BIT);
    if (h == nullptr) {
        free(b);
        return nullptr;
    }
    memset(h, 0, sizeof(Stage));
    Stage* s = (Stage*)h;
    s->buf = (char*)b;
    s->cap = cap;
    return s;
}

}  // namespace

namespace LogPersist {

void init() {
    if (s_mux == nullptr) s_mux = xSemaphoreCreateMutex();
    if (s_kern == nullptr) {
        Stage* k = novoStage(kKernBig, kKernSmall);
        Stage* a = novoStage(kAppsBig, kAppsSmall);
        size_t fcap = kFlushBig;
        void* f = heap_caps_malloc(fcap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (f == nullptr) {
            fcap = kFlushSmall;
            f = heap_caps_malloc(fcap, MALLOC_CAP_8BIT);
        }
        if (k == nullptr || a == nullptr || f == nullptr) {
            if (k != nullptr) {
                free(k->buf);
                free(k);
            }
            if (a != nullptr) {
                free(a->buf);
                free(a);
            }
            free(f);
            return;  // fica desligado (kern/app ja guardam contra nulos)
        }
        s_kern = k;
        s_apps = a;
        s_flush = (char*)f;
        s_flushCap = fcap;
    }
}

void kern(const char* line, size_t n) {
    if (s_mux == nullptr || s_kern == nullptr || !s_ok || line == nullptr || n == 0) return;
    if (xSemaphoreTake(s_mux, 0) != pdTRUE) return;  // flush copiando: descarta
    stageLine(*s_kern, line, n);
    xSemaphoreGive(s_mux);
}

void app(const char* pkg, const char* msg) {
    if (s_mux == nullptr || s_apps == nullptr || !s_ok) return;
    char line[224];
    int n = snprintf(line, sizeof(line), "[%s] %s\n",
                     (pkg != nullptr && pkg[0] != '\0') ? pkg : "js",
                     msg != nullptr ? msg : "");
    if (n <= 0) return;
    if ((size_t)n >= sizeof(line)) n = (int)sizeof(line) - 1;
    if (xSemaphoreTake(s_mux, 0) != pdTRUE) return;
    stageLine(*s_apps, line, (size_t)n);
    xSemaphoreGive(s_mux);
}

void tick() {
    if (s_mux == nullptr || s_kern == nullptr || !s_ok) return;
    static uint32_t s_last = 0;
    const uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
    const bool due = (uint32_t)(now - s_last) >= 3000;
    const bool quase = s_kern->n + 256 > s_kern->cap ||
                       s_apps->n + 256 > s_apps->cap;
    if (!due && !quase) return;
    // Som tocando (fala do AI.speak, wav, tom): escrever na flash desliga o
    // cache dos DOIS nucleos por dezenas de ms e o player do I2S (codigo e
    // fila fora da IRAM) para — o DMA so segura ~40 ms: a voz engasgava a
    // cada flush. O staging segura as linhas ate o fim do som (cheio, o
    // excedente fica so no ring RAM do logcat).
    if (AudioPlayer::active()) return;
    // Varredura de livres do SD segurando o volume (1a montagem de um cartao
    // com FSInfo invalido, ~1 min): cada fopen/stat esperaria ate 10 s pelo
    // lock aqui na task main — o staging segura ate ela terminar.
    if (FileSystem::sdScanBusy()) return;
    // Vidro aceso: escrever na flash suspende o cache e estaciona o outro
    // nucleo por dezenas de ms — o DMA do painel RGB varre o framebuffer em
    // PSRAM dentro da janela e a imagem embaralha no meio do quadro (bancada
    // 2026-10-16: rajada de rm+touch no sh embaralhou os 2 4848 na hora; a
    // ISR do VSYNC em IRAM do 345b034 pontualiza o reinicio mas nao protege
    // a janela). O flush espera o vidro apagar (backlight off; no watch,
    // SLPIN — AOD ainda mostra e espera junto) e so flusha aceso no estagio
    // quase cheio: perder log e pior que um embaralhado raro. Sem backlight
    // (headless) flusha sempre, como antes. Debug ao vivo nao muda: o
    // logcat --dump le o ring em RAM.
    if (!quase && Backlight::isSupported() && !Backlight::isOff() &&
        ScreenPower::state() > 0) {
        return;
    }
    s_last = now;
    flushStage(*s_kern, "kern");
    flushStage(*s_apps, "apps");
}

}  // namespace LogPersist
