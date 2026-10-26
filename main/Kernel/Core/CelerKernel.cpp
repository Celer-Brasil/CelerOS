#include "CelerKernel.h"
#include "../../Boards/Board.h"  // perfil (buttonPin dispensa erro de runtime no headless)
#include "../../USBDevice/JsDebugger.h"
#include "../../USBDevice/LogSink.h"
#include "../../USBDevice/LogPersist.h"
#include "../../Display/Layout.h"
#include "../../Runtime/JSBindings.h"
#include "../../FileSystem/FileSystem.h"
#include "../../Utils/StrUtils.h"
#include "../../Display/Theme.h"
#include "../../UI/Kui.h"
#include "../../Display/Icon.h"
#include "../../Display/Backlight.h"
#include "../../Hardware/BoardIO.h"
#include "../../Compat/Arduino.h"  // celerAnalogWriteReset (fim de app)
#include "../../Utils/JsStrip.h"
#include "../../Utils/I18n.h"
#include "../../Utils/Mem.h"
#include "../DeviceStats.h"
#include <vector>
#include "esp_heap_caps.h"
#include "esp_attr.h"
#include <cstring>
#include <ctime>
#include <cstdio>
#include "esp_task_wdt.h"
#include "esp_debug_helpers.h"

#if !defined(CELEROS_VERSION)
#define CELEROS_VERSION "?"
#endif

duk_context *CelerKernel::ctx = nullptr;
CelerDisplay *CelerKernel::tftInstance = nullptr;
size_t CelerKernel::appLaunchFreeHeap = 0;

// ---------------------------------------------------------------------------
// Timeout de execucao do Duktape (DUK_USE_EXEC_TIMEOUT_CHECK, disparado pelo
// interrupt counter a cada ~256K instrucoes): trecho de JS puro sem NENHUMA
// chamada a bindings nunca passa por present(), e ate 2026-10 o TWDT derrubava
// o aparelho inteiro. Aqui o WDT e alimentado durante uma janela de cortesia
// (1s); um trecho que nao cede faz o executor levantar RangeError ("execution
// timeout") — erro legivel do app em vez de reboot. "Ceder" = qualquer
// chamada que passe por JSBindings::present() (delay, getTouch, net, fs...):
// ela reinicia a janela via noteAppYield(). O timeout e travado (retorna 1
// ate sair do duk_pcall) para o app nao engolir o erro num catch e continuar.
// Chamado do duktape.c (C): extern "C". Tudo na task do app: sem lock.
// ---------------------------------------------------------------------------
static uint32_t s_jsSliceStart = 0;
static bool s_jsTimedOut = false;
static uint32_t s_jsSliceMs = 1000;  // apps; servicos rodem com 250 (API 42)

// Telemetria da sessao corrente do app (uma linha no apps.log no fim do
// runFile): motivo de saida preenchido pelo checkJSError, pelo hook de
// timeout e pelos returns antecipados de carga. O fatal do Duktape reinicia
// o aparelho e NUNCA passa aqui — esse caminho fica no RTC s_fatalMsg.
static const char* s_exitReason = "ok";
static uint32_t s_sessionStart = 0;

// Alocador do Duktape (definicao junto das reservas, abaixo)
static void* my_alloc(void* udata, duk_size_t size);
static void* my_realloc(void* udata, void* ptr, duk_size_t size);
static void my_free(void* udata, void* ptr);

void CelerKernel::noteAppYield() {
    s_jsSliceStart = millis();
    s_jsTimedOut = false;
}

void CelerKernel::setExecSliceMs(uint32_t ms) { s_jsSliceMs = ms; }

// Wrappers publicos do alocador (o svchost cria o segundo heap com as
// mesmas reservas por placa — ver AppServices)
void* CelerKernel::heapAlloc(void* udata, duk_size_t size) { return my_alloc(udata, size); }
void* CelerKernel::heapRealloc(void* udata, void* ptr, duk_size_t size) {
    return my_realloc(udata, ptr, size);
}
void CelerKernel::heapFree(void* udata, void* ptr) { my_free(udata, ptr); }

extern "C" duk_bool_t celer_exec_timeout_check(void* udata) {
    (void)udata;
    esp_task_wdt_reset();
    // Sessao de debug pausada (breakpoint/step): o executor processa as
    // mensagens do debugger no MESMO interrupt — renovar a janela em vez
    // de matar o app que o dev esta inspecionando
    if (JsDebugger::attached(CelerKernel::ctx)) {
        CelerKernel::noteAppYield();
        return 0;
    }
    const uint32_t now = millis();
    if (s_jsTimedOut) return 1;
    if (s_jsSliceStart == 0) {
        s_jsSliceStart = now;  // primeira fatia desde a cedida
        return 0;
    }
    if (now - s_jsSliceStart > s_jsSliceMs) {
        s_jsTimedOut = true;
        s_exitReason = "timeout";
        return 1;  // o executor levanta RangeError "execution timeout"
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Tela de erro do runtime (tema do OS): titulo, texto quebrado em linhas e
// "toque para voltar" — qualquer toque (fisico ou injetado) fecha. Antes era
// um fundo vermelho cru com um "X" que so respondia no canto superior.
// ---------------------------------------------------------------------------
#if CONFIG_CELEROS_UI
static void wrapInto(CelerDisplay* tft, const std::string& text, const lgfx::IFont* f, int maxW,
                     std::vector<std::string>& out, size_t maxLines) {
    size_t start = 0;
    while (start <= text.size() && out.size() < maxLines) {
        size_t nl = text.find('\n', start);
        std::string para = text.substr(start, nl == std::string::npos ? std::string::npos : nl - start);
        // quebra por largura (palavra a palavra; palavra gigante e cortada)
        std::string line;
        size_t i = 0;
        while (i <= para.size() && out.size() < maxLines) {
            size_t sp = para.find(' ', i);
            std::string word = para.substr(i, sp == std::string::npos ? std::string::npos : sp - i);
            std::string cand = line.empty() ? word : line + " " + word;
            if (!line.empty() && tft->textWidth(cand.c_str(), f) > maxW) {
                out.push_back(line);
                line = word;
            } else {
                line = cand;
            }
            while (tft->textWidth(line.c_str(), f) > maxW && line.size() > 1 && out.size() < maxLines) {
                size_t cut = line.size();
                while (cut > 1 && tft->textWidth(line.substr(0, cut).c_str(), f) > maxW) cut--;
                out.push_back(line.substr(0, cut));
                line = line.substr(cut);
            }
            if (sp == std::string::npos) break;
            i = sp + 1;
        }
        if (!line.empty() && out.size() < maxLines) out.push_back(line);
        if (nl == std::string::npos) break;
        start = nl + 1;
    }
}

static void showRuntimeError(const char* title, const std::string& detail) {
    CelerDisplay* tft = CelerKernel::tftInstance;
    if (!tft) return;
    tft->clearClipRect();  // recorte do app (faixa/System.setClip) nao vale aqui
    const lgfx::IFont* body = kui::type::body();
    const lgfx::IFont* cap = kui::type::caption();

    tft->startWrite();
    tft->fillScreen(THEME_BG);
    int hdr = UI::sy(52);
    tft->fillRect(0, 0, UI::W, hdr, THEME_CARD);
    tft->fillRect(0, hdr - UI::sy(3), UI::W, UI::sy(3), THEME_ERR);
    tft->setTextDatum(ML_DATUM);
    tft->setTextColor(THEME_TEXT);
    tft->drawString(title, UI::sx(14), hdr / 2, kui::type::title());

    std::vector<std::string> lines;
    int lineH = tft->fontHeight(cap) + UI::sy(3);
    size_t maxLines = (size_t)((UI::H - hdr - UI::sy(70)) / lineH);
    wrapInto(tft, detail, cap, UI::W - UI::sx(28), lines, maxLines);
    tft->setTextDatum(TL_DATUM);
    tft->setTextColor(THEME_TEXT_DIM);
    int y = hdr + UI::sy(12);
    for (const auto& l : lines) {
        tft->drawString(l.c_str(), UI::sx(14), y, cap);
        y += lineH;
    }

    int bh = UI::sy(34);
    int by = UI::H - bh - UI::sy(12);
    tft->fillRoundRect(UI::sx(40), by, UI::W - UI::sx(80), bh, UI::sx(8), THEME_RAISED);
    tft->setTextDatum(MC_DATUM);
    tft->setTextColor(THEME_TEXT);
    tft->drawString(i18n::TR("Toque para voltar", "Touch to go back"), UI::cx(), by + bh / 2, body);
    tft->endWrite();

    // espera soltar (o toque que causou o erro), depois um tap completo —
    // usuario pode demorar: alimenta o watchdog da main task enquanto espera.
    // Placas headless (devkit) nao tem touch: o botao fisico (buttonPin)
    // tambem dispensa — sem isso o erro ficava preso para sempre no devkit.
    auto dismissHeld = []() {
        uint16_t tx, ty;
        if (kui::readTouch(&tx, &ty)) return true;
        const int pin = Board::profile().buttonPin;
        return pin >= 0 && digitalRead(pin) == LOW;  // ativo-baixo (pull-up do Buttons::init)
    };
    while (dismissHeld()) { esp_task_wdt_reset(); delay(20); }
    while (!dismissHeld()) { esp_task_wdt_reset(); delay(20); }
    while (dismissHeld()) { esp_task_wdt_reset(); delay(20); }
}
#else
// Sem vidro (CELEROS_UI=n): o erro do runtime vai para o logcat (kern.log)
// com uma pausa curta para o log ir a agua abaixo antes do fluxo seguir.
static void showRuntimeError(const char* title, const std::string& detail) {
    celer_log_printf("[kernel] %s: %s\n", title, detail.c_str());
    delay(1200);
}
#endif

// dica de OOM no idioma configurado (primeiro uso trava o idioma)
static const char* oomHint() {
    return i18n::TR("O app precisa de mais memória do que esta placa tem livre. "
                    "Em placas sem PSRAM, prefira apps menores.",
                    "The app needs more memory than this board has free. "
                    "On boards without PSRAM, prefer smaller apps.");
}
#define kOomHint oomHint()

// ---------------------------------------------------------------------------
// Alocador do Duktape.
//
// O malloc do IDF manda todo bloco < 4 KB (SPIRAM_MALLOC_ALWAYSINTERNAL) para
// a RAM interna — e um script grande (o Settings compila ~1000 linhas) e
// quase so blocos pequenos: esgotava a interna e o WiFi abortava ao acordar
// do power-save (esp_timer_create -> ESP_ERR_NO_MEM em phy_track_pll_init).
// Com PSRAM: interna so enquanto sobrar folga para o sistema (WiFi/lwIP/
// timers); passou disso, PSRAM. Sem PSRAM (CYD): malloc padrao.
// ---------------------------------------------------------------------------
static constexpr size_t kInternalReserve = 72 * 1024;
// Sem PSRAM (CYD): o heap Duktape compete com WiFi/lwIP pela RAM interna
// (~70KB livres no boot). Sem piso, ele comia o heap ate o ultimo byte
// (heap_min de 48 BYTES medido no device) e o sistema abortava — agora
// nega alocacao abaixo do piso e o Duktape ve OOM (soft-error "Sem
// memoria"), nao um abort no meio da tela de erro.
static constexpr size_t kNoPsramFloor = 20 * 1024;

// Sem PSRAM (CYD): a DRAM 8-bit e do Duktape so enquanto sobrarem ~24KB
// para o sistema — o handshake TLS de um app com rede (verificacao do
// certificado, ~20KB de blocos pequenos) e o WiFi precisam dela. Passou
// disso, o Duktape TRANSBORDA para a IRAM acessivel a byte (unicore +
// CONFIG_ESP32_IRAM_AS_8BIT_ACCESSIBLE_MEMORY): mais lenta (acesso de 8/16
// bits vira excecao), mas o app segue em vez de OOM ou de sufocar o TLS.
static constexpr size_t kDramReserve = 24 * 1024;

// Folga da regiao preferida acima da reserva, descontada a cada bloco: o
// heap_caps_get_free_size por alocacao (o compile do Settings faz ~5800)
// varre todos os heaps registrados. A folga e reconsultada quando o bloco
// nao cabe nela ou a cada kCapsRefresh alocacoes — o que absorve os free()
// do proprio Duktape e o consumo das outras tasks (WiFi/lwIP) entre elas.
static constexpr int kCapsRefresh = 64;
static size_t s_capsHeadroom = 0;
static int s_capsCalls = 0;

static void duk_caps_refresh(bool psram) {
    const size_t freeB = heap_caps_get_free_size(psram ? MALLOC_CAP_INTERNAL : MALLOC_CAP_8BIT);
    const size_t reserve = psram ? kInternalReserve : kDramReserve;
    s_capsHeadroom = freeB > reserve ? freeB - reserve : 0;
    s_capsCalls = 0;
}

// Destino preferido de um bloco e o alternativo (tentado se o primeiro falhar)
static void duk_caps(size_t size, uint32_t* first, uint32_t* second) {
    const bool psram = Board::profile().hasPsram;
    if (++s_capsCalls >= kCapsRefresh || size >= s_capsHeadroom) duk_caps_refresh(psram);
    // mesmas regras de antes: sem PSRAM, DRAM enquanto sobrar kDramReserve
    // alem do bloco (senao IRAM de transbordo); com PSRAM, interna enquanto
    // sobrar kInternalReserve (senao PSRAM)
    const bool preferred = psram ? s_capsHeadroom > 0 : s_capsHeadroom > size;
    if (preferred) s_capsHeadroom -= (size < s_capsHeadroom ? size : s_capsHeadroom);
    if (!psram) {
        *first = preferred ? MALLOC_CAP_8BIT : MALLOC_CAP_IRAM_8BIT;
        *second = preferred ? MALLOC_CAP_IRAM_8BIT : MALLOC_CAP_8BIT;
        return;
    }
    *second = MALLOC_CAP_8BIT;
    *first = preferred ? MALLOC_CAP_8BIT : MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
}

// Orçamento para ABRIR um app (piso só no create, nunca no run): sem PSRAM,
// exigir folga generosa — app que estourar vai de OOM fatal ao my_fatal, e
// o sistema recupera com a tela de erro.
// Heap base do Duktape + API inteira com builtins em ROM e bindings
// lightfunc (medido na CYD: ~7,6KB; eram ~50KB com builtins na RAM)
static constexpr size_t kDukBase = 8 * 1024;

// Heap que ainda falta com o fonte JA carregado: base + temporarios do
// compile (~0.75x o fonte enxuto) + folga do sistema
static size_t dukHeapNeed(size_t srcLen) {
    return kNoPsramFloor + kDukBase + srcLen * 3 / 4;
}

static bool dukHeapBudgetOk(size_t srcLen) {
    if (Board::profile().hasPsram) return true;
    // Recusa ANTES (mensagem limpa) quando claramente nao cabe — OOM no
    // meio do compile/run leva ao my_fatal (reinicio). Conta a IRAM de
    // transbordo (duk_caps) junto da DRAM.
    return heap_caps_get_free_size(MALLOC_CAP_8BIT) + heap_caps_get_free_size(MALLOC_CAP_IRAM_8BIT) >
           dukHeapNeed(srcLen);
}

// Le o main.js ENXUTO (sem comentarios/indentacao, linhas preservadas — ver
// Utils/JsStrip.h) num bloco exato: passada 1 conta, passada 2 preenche.
// Sem PSRAM o fonte inteiro precisa de um bloco contiguo durante o compile
// (App Store: 44KB -> ~31KB); o std::string de antes abortava (new sem
// excecao) quando o heap fragmentado nao tinha o bloco. nullptr = sem
// arquivo; *oom = true quando faltou memoria.
static char* loadAppSource(const char* path, size_t* lenOut, bool* oom) {
    *oom = false;
    FILE* f = fopen(path, "rb");
    if (f == nullptr) return nullptr;
    if (Board::profile().hasPsram) {
        // Com PSRAM o bloco do tamanho do arquivo cru e barato: uma leitura
        // so e o enxugamento IN-PLACE (o JsStripper nunca escreve a frente
        // do que ja leu — test/cpp confere contra as duas passadas em todos
        // os apps). Eram duas leituras do LittleFS + dois strips por launch.
        size_t raw = 0;
        if (fseek(f, 0, SEEK_END) == 0) {
            long sz = ftell(f);
            if (sz > 0) raw = (size_t)sz;
            rewind(f);
        }
        if (raw > 0) {
            char* buf = (char*)mem::alloc(raw + 1, mem::Want::Psram);
            if (buf == nullptr) {
                fclose(f);
                *oom = true;
                return nullptr;
            }
            const size_t got = fread(buf, 1, raw, f);
            fclose(f);
            celer::JsStripper strip(buf);
            strip.feed(buf, got);
            const size_t len = strip.finish();
            if (len == 0) {
                free(buf);
                return nullptr;
            }
            buf[len] = 0;
            *lenOut = len;
            return buf;
        }
        // tamanho desconhecido: cai nas duas passadas
    }
    char chunk[512];
    size_t n;
    celer::JsStripper count;
    while ((n = fread(chunk, 1, sizeof(chunk), f)) > 0) count.feed(chunk, n);
    const size_t len = count.finish();
    if (len == 0) {
        fclose(f);
        return nullptr;
    }
    // PSRAM quando ha; sem PSRAM, a IRAM livre acessivel a byte (CYD:
    // CONFIG_ESP32_IRAM_AS_8BIT_ACCESSIBLE_MEMORY, ~40KB que o heap 8-bit
    // nao usa) — o fonte sai do heap durante o pico do compile. Cada acesso
    // a byte la custa uma excecao (~167 ciclos): ~30ms num app de 30KB.
    char* buf = (char*)heap_caps_malloc(len + 1, Board::profile().hasPsram ? (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
                                                                            : MALLOC_CAP_IRAM_8BIT);
    if (buf == nullptr) buf = (char*)heap_caps_malloc(len + 1, MALLOC_CAP_8BIT);
    if (buf == nullptr) {
        fclose(f);
        *oom = true;
        return nullptr;
    }
    rewind(f);
    celer::JsStripper fill(buf);
    while ((n = fread(chunk, 1, sizeof(chunk), f)) > 0) fill.feed(chunk, n);
    fill.finish();
    fclose(f);
    buf[len] = 0;
    *lenOut = len;
    return buf;
}

static void *my_alloc(void *udata, duk_size_t size) {
    (void)udata;
    if (size == 0) return nullptr;
    // NOTA: sem piso AQUI de proposito — negar alocacao no meio do run
    // derruba o Duktape no caminho de erro (intern -> throw error object ->
    // malloc -> spinlock corrupto, LoadStoreError medido no device). O piso
    // age so no duk_create_heap (dukHeapBudgetOk no runFile).
    uint32_t first, second;
    duk_caps(size, &first, &second);
    void *p = heap_caps_malloc(size, first);
    if (!p && second != first) p = heap_caps_malloc(size, second);
    if (!p) {
        static int oomLogs = 0;
        if (oomLogs++ < 1) {
            char b[80];
            snprintf(b, sizeof(b), "[duk-oom] size=%u free=%u", (unsigned)size,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT));
            celer_log_println(b);
        }
    } else {
        DeviceStats::noteJsAlloc();  // profiling (celerctl top): vivas + pico
    }
    return p;
}

static void *my_realloc(void *udata, void *ptr, duk_size_t size) {
    (void)udata;
    if (size == 0) {
        free(ptr);
        if (ptr) DeviceStats::noteJsFree();
        return nullptr;
    }
    uint32_t first, second;
    duk_caps(size, &first, &second);
    void *p = heap_caps_realloc(ptr, size, first);
    if (!p && second != first) p = heap_caps_realloc(ptr, size, second);
    if (!p) {
        // Mesmo rate-limit do my_alloc (1 log): o realloc e gancho do
        // Duktape — um app em loop de OOM cuspiria "out of memory" por
        // chamada e inundava o logcat.
        static int oomLogs = 0;
        if (oomLogs++ < 1) {
            char b[80];
            snprintf(b, sizeof(b), "[duk-oom] realloc size=%u free=%u", (unsigned)size,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT));
            celer_log_println(b);
        }
    } else if (ptr == nullptr) {
        DeviceStats::noteJsAlloc();  // realloc(nullptr) = alloc novo bloco
    }
    // realloc de bloco existente: contagem viva nao muda
    return p;
}

static void my_free(void *udata, void *ptr) {
    if (ptr) DeviceStats::noteJsFree();
    free(ptr);
}

// Motivo do ultimo fatal do Duktape: RAM RTC sobrevive ao ESP.restart (nao
// a um power-on). O fatal reinicia sem coredump e o logcat (RAM) se perde —
// sem isto o reinicio era mudo. Lido uma vez no boot (takeLastFatal).
RTC_NOINIT_ATTR static uint32_t s_fatalMagic;
RTC_NOINIT_ATTR static char s_fatalMsg[80];
static constexpr uint32_t kFatalMagic = 0xCE1EFA7Au;

// Contexto do app corrente para o /local/lastcrash.txt: titulo e pacote do
// app em execucao (populados no runFile; o my_fatal os embute na mensagem
// que sobrevive ao reinicio)
static char s_crashApp[64] = {0};
static char s_crashPkg[64] = {0};

const char* CelerKernel::takeLastFatal() {
    if (s_fatalMagic != kFatalMagic) return nullptr;
    s_fatalMagic = 0;
    s_fatalMsg[sizeof(s_fatalMsg) - 1] = 0;
    return s_fatalMsg;
}

// App corrente para o CrashRecord (chamado no contexto do panic: leitura de
// .bss, sem alocacao, sem flash)
const char* CelerKernel::crashTitle() { return s_crashApp; }
const char* CelerKernel::crashPkg() { return s_crashPkg; }

// ---------------------------------------------------------------------------
// Last crash persistente: a stack de um erro de app antes so existia no
// logcat (ring de RAM) — reboot ou tela de erro fechada e ela sumia. Gravado
// em TODO erro de app (inclusive OOM, que antes nem logava) e, no boot
// seguinte, para o fatal do runtime. Escrita direta com fopen/fwrite e
// buffer de malloc puro (NULL em falha): o caminho de OOM nao pode passar
// por std::string/new, que abortam o aparelho justamente ali.
// ---------------------------------------------------------------------------
static const char* K_LAST_CRASH = "/local/lastcrash.txt";

void CelerKernel::recordCrash(const char* kind, const char* detail) {
    // header em buffer de stack; detail escrito DIRETO do ponteiro do
    // chamador (truncado): zero malloc aqui — no OOM o heap Duktape ainda
    // esta vivo (duk_destroy_heap vem depois do checkJSError) e um pedido
    // de bloco grande falha justo quando o erro e o mais valioso
    char when[32] = "sem relogio valido (NTP fora)";
    time_t now = time(nullptr);
    if (now > 1600000000) {  // epoch setado (NTP/manual): hora real
        struct tm tmv;
        localtime_r(&now, &tmv);
        strftime(when, sizeof(when), "%Y-%m-%d %H:%M", &tmv);
    }
    char head[192];
    int hn = snprintf(head, sizeof(head),
                      "CelerOS %s | %s | uptime %lus | app: %s (%s)\n%s\n",
                      CELEROS_VERSION, when, (unsigned long)(millis() / 1000),
                      s_crashApp[0] ? s_crashApp : "-", s_crashPkg[0] ? s_crashPkg : "-", kind);

    size_t dn = detail != nullptr ? strlen(detail) : 0;
    if (dn > 3000) dn = 3000;  // stack inteira nao cabe nem ajuda: trunca
    size_t total = (hn > 0 ? (size_t)hn : 0) + dn + 1;

    FILE* f = fopen(K_LAST_CRASH, "wb");
    if (f == nullptr) {
        celer_log_println("lastcrash: /local indisponivel neste momento");
        return;
    }
    bool ok = true;
    if (hn > 0) ok = fwrite(head, 1, (size_t)hn, f) == (size_t)hn;
    if (ok && dn > 0) ok = fwrite(detail, 1, dn, f) == dn;
    if (ok && (dn == 0 || detail[dn - 1] != '\n')) ok = fputc('\n', f) != EOF;
    ok = (fclose(f) == 0) && ok;  // disco cheio aparece no fclose
    celer_log_printf("lastcrash: %s (%u B)\n", ok ? "gravado" : "falhou ao gravar", (unsigned)total);
}

// Dummy fatal error handler if duktape aborts
static void my_fatal(void *udata, const char *msg) {
    celer_log_print("Duktape fatal error: ");
    celer_log_println(msg ? msg : "no message");
    // app corrente embutido na mensagem RTC: o fatal e quase sempre OOM do
    // app em execucao, e saber qual importa no boot seguinte
    char rtc[80];
    snprintf(rtc, sizeof(rtc), "[%s] %s", s_crashApp[0] ? s_crashApp : "?",
             msg ? msg : "sem mensagem");
    strncpy(s_fatalMsg, rtc, sizeof(s_fatalMsg) - 1);
    s_fatalMsg[sizeof(s_fatalMsg) - 1] = 0;
    s_fatalMagic = kFatalMagic;

    // Tela estatica SEM alocacao: o fatal tipico e OOM ("alloc failed") e o
    // heap do sistema pode estar esgotado — std::string aqui era abort()
    // dentro do proprio handler (o device rebootava sem mostrar nada).
#if CONFIG_CELEROS_UI
    CelerDisplay* tft = CelerKernel::tftInstance;
    if (tft) {
        tft->clearClipRect();
        tft->startWrite();
        tft->fillScreen(THEME_BG);
        int hdr = UI::sy(52);
        tft->fillRect(0, 0, UI::W, hdr, THEME_CARD);
        tft->fillRect(0, hdr - UI::sy(3), UI::W, UI::sy(3), THEME_ERR);
        tft->setTextDatum(ML_DATUM);
        tft->setTextColor(THEME_TEXT);
        tft->drawString(i18n::TR("Erro fatal do runtime", "Runtime fatal error"),
                        UI::sx(14), hdr / 2, kui::type::title());
        tft->setTextDatum(TL_DATUM);
        tft->setTextColor(THEME_TEXT_DIM);
        bool oom = (msg && strstr(msg, "alloc"));
        tft->drawString(oom ? i18n::TR("O app ficou sem memória.", "The app ran out of memory.")
                            : i18n::TR("O app travou o runtime.", "The app broke the runtime."),
                        UI::sx(14), hdr + UI::sy(16), kui::type::body());
        tft->drawString(i18n::TR("O sistema vai reiniciar...", "The system will restart..."),
                        UI::sx(14), hdr + UI::sy(34), kui::type::body());
        tft->endWrite();
    }
#endif
    delay(2500);
    ESP.restart(); // Reboot when they close it
}

void CelerKernel::init(CelerDisplay *tft) {
    tftInstance = tft;
    // Duktape heap is no longer initialized here to save 60-80KB of RAM for the WebServer/WiFi.
    // It will be allocated on-demand in runFile().
    celer_log_println("CelerKernel initialized successfully.");
}

// ---------------------------------------------------------------------------
// Telemetria de fim de sessao (apps.log, uma linha por app): duracao, motivo
// de saida e o heap antes/depois. Buffer de stack + LogPersist::app (zero
// malloc): roda tambem nos caminhos de OOM, onde std::string/new abortariam
// o aparelho.
// ---------------------------------------------------------------------------
static void logAppSession(const char* appPkg, uint32_t startMs, size_t heapStart) {
    const size_t heapEnd = heap_caps_get_free_size(MALLOC_CAP_8BIT) +
                           heap_caps_get_free_size(MALLOC_CAP_IRAM_8BIT);
    char msg[112];
    snprintf(msg, sizeof(msg), "sessao=%.1fs saida=%s heap %u->%u",
             (millis() - startMs) / 1000.0f, s_exitReason,
             (unsigned)heapStart, (unsigned)heapEnd);
    LogPersist::app((appPkg != nullptr && appPkg[0] != '\0') ? appPkg : "run", msg);
}

void CelerKernel::checkJSError(duk_context *ctx, duk_int_t result) {
    if (result != 0) {
        // Saida limpa: erro marcado com a propriedade celerExit (throwAppExit
        // do JSBindings) ou a string "OS_EXIT" exata lancada por apps legado
        // (ex. Terminal relanca a que recebe). Antes comparava substring:
        // qualquer erro contendo "OS_EXIT" fechava o app em silencio.
        if (duk_is_error(ctx, -1)) {
            duk_get_prop_string(ctx, -1, "celerExit");
            bool marked = duk_is_boolean(ctx, -1) && duk_get_boolean(ctx, -1);
            duk_pop(ctx);
            if (marked) {
                duk_pop(ctx);
                s_exitReason = "exitApp";
                return;
            }
        } else if (duk_is_string(ctx, -1) &&
                   strcmp(duk_safe_to_string(ctx, -1), "OS_EXIT") == 0) {
            duk_pop(ctx);
            s_exitReason = "exitApp";
            return;
        }

        // Texto do erro direto do value stack (vivo ate o duk_pop abaixo):
        // sem std::string — no OOM o heap do sistema pode nao ter o bloco
        // para copiar uma stack longa e o new sem excecao abortava o
        // aparelho justamente no caminho que devia mostrar o erro
        if (duk_is_error(ctx, -1)) {
            duk_get_prop_string(ctx, -1, "stack");
            duk_replace(ctx, -2);  // a stack substitui o objeto de erro
        }
        const char* errorMsg = duk_safe_to_string(ctx, -1);

        // Intercept OOM signals
        if (strstr(errorMsg, "alloc") != nullptr || strstr(errorMsg, "out of memory") != nullptr) {
            // antes este caminho era mudo (nem no UART): morte silenciosa do app
            celer_log_printf("JS OOM (sem memoria): %s\n", errorMsg);
            s_exitReason = "oom";
            recordCrash("OOM (sem memoria)", errorMsg);
            showRuntimeError(i18n::TR("Sem memória", "Out of memory"), kOomHint);
            duk_pop(ctx);
            // This is a soft-error (not Duktape fatal), so we can just return safely to Launcher
            return;
        }

        // O RangeError do hook de timeout ja marca la cima; substring aqui so
        // cobre o caso de o app re-lancar o erro dele mesmo
        s_exitReason = strstr(errorMsg, "execution timeout") != nullptr ? "timeout" : "erro";

        celer_log_print("JS Execution Error: ");
        celer_log_println(errorMsg);
        recordCrash("Erro no app", errorMsg);

        showRuntimeError(i18n::TR("Erro no app", "App error"), errorMsg);
    } else {
        s_exitReason = "ok";
    }
    duk_pop(ctx); // pop result or error
}

void CelerKernel::executeJS(const char* jsCode) {
    if (!ctx) return;
    
    duk_int_t rc = duk_peval_string(ctx, jsCode);
    checkJSError(ctx, rc);
}

void CelerKernel::runFile(const char* filePath, const char* appTitle, bool topbarFixed,
                         const char* appPkg, uint32_t perms) {
    // Abrir app acorda a tela (AOD/dim escondiam o app recem-launchado em
    // launches remotos/autostart: sem toque, o ScreenPower nunca sabia).
    Backlight::noteActivity();
    // contexto do lastcrash: quem estava rodando quando o erro aconteceu
    strncpy(s_crashApp, appTitle ? appTitle : "", sizeof(s_crashApp) - 1);
    s_crashApp[sizeof(s_crashApp) - 1] = 0;
    strncpy(s_crashPkg, appPkg ? appPkg : "", sizeof(s_crashPkg) - 1);
    s_crashPkg[sizeof(s_crashPkg) - 1] = 0;
    s_sessionStart = millis();
    s_exitReason = "ok";
    if (ctx) {
        JSBindings::heapDetaching();  // heap morto: present() de servico nao bombeia
        duk_destroy_heap(ctx);
        ctx = nullptr;
    }

    // Sem PSRAM: o app e dono do vidro — buffer do Canvas (16KB) e caches
    // de icone (~10KB cada) voltam ao heap para o Duktape; o launcher
    // realoca/recarrega sozinho ao voltar
#if CONFIG_CELEROS_UI
    if (!Board::profile().hasPsram) {
        kui::releaseCanvasBuffer();
        Icon::releaseAll();
    }
#endif
    // heap que o app pode usar: DRAM + IRAM de transbordo (duk_caps)
    appLaunchFreeHeap = heap_caps_get_free_size(MALLOC_CAP_8BIT) + heap_caps_get_free_size(MALLOC_CAP_IRAM_8BIT);

    const uint32_t t0 = millis();
    // Fonte PRIMEIRO: o bloco contiguo sai do heap ainda pouco fragmentado
    // (antes do heap Duktape espalhar alocacoes pequenas)
    size_t srcLen = 0;
    bool srcOom = false;
    char* src = loadAppSource(filePath, &srcLen, &srcOom);
    if (src == nullptr) {
        celer_log_printf(srcOom ? "sem bloco para o fonte: %s (maior bloco %u)\n" : "Failed to read JS file: %s\n",
                         filePath, (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
        if (srcOom) showRuntimeError(i18n::TR("Sem memória", "Out of memory"), kOomHint);
        s_exitReason = "fonte_oom";
        logAppSession(appPkg, s_sessionStart, appLaunchFreeHeap);
        return;
    }

    if (!dukHeapBudgetOk(srcLen)) {
        celer_log_printf("heap baixo p/ app JS: livre=%u precisa=%u (fonte %u)\n",
                         (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT), (unsigned)dukHeapNeed(srcLen),
                         (unsigned)srcLen);
        s_exitReason = "budget_oom";
        logAppSession(appPkg, s_sessionStart, appLaunchFreeHeap);
        free(src);
        showRuntimeError(i18n::TR("Sem memória", "Out of memory"), kOomHint);
        return; // Soft exit back to OS
    }

    celer_log_printf("[duk] fonte lido: %u ms\n", (unsigned)(millis() - t0));
    const size_t freeBefore = heap_caps_get_free_size(MALLOC_CAP_8BIT);
    ctx = duk_create_heap(my_alloc, my_realloc, my_free, nullptr, my_fatal);
    if (!ctx) {
        free(src);
        celer_log_println("Failed to create Duktape heap for app.");
        s_exitReason = "heap_oom";
        logAppSession(appPkg, s_sessionStart, appLaunchFreeHeap);
        showRuntimeError(i18n::TR("Sem memória", "Out of memory"), kOomHint);
        return; // Soft exit back to OS
    }
    s_jsSliceStart = 0;
    s_jsTimedOut = false;

    // `debug on` (celerctl debug): attacha ANTES de compilar/executar, com
    // o heap ainda vazio — breakpoints e o handshake completos do app
    JsDebugger::noteApp(filePath);
    if (JsDebugger::requested()) JsDebugger::attach(ctx);

    // Pasta do app p/ require() de modulos (API 23): so quando o entry e o
    // main.js de uma pasta de app; .js avulso (shell run) nao ganha modulos
    {
        extern std::string s_appDir;  // Runtime/JsInternal.h; define JsModules.cpp
        extern void jsLoadAppDeps(const char* appDir);  // idem, JsModules.cpp
        const char* slash = strrchr(filePath, '/');
        if (slash && strcmp(slash + 1, "main.js") == 0)
            s_appDir.assign(filePath, (size_t)(slash - filePath));
        else
            s_appDir.clear();
        // Deps compartilhadas (API 30): deps.json da pasta resolve os
        // require() que caem fora dela (cache do hub em /local/modules)
        jsLoadAppDeps(s_appDir.c_str());
    }

    JSBindings::init(ctx, tftInstance, appTitle, topbarFixed, appPkg, perms);
    celer_log_printf("[duk] heap base+API: %u B (livre %u, iram %u)\n",
                     (unsigned)(freeBefore - heap_caps_get_free_size(MALLOC_CAP_8BIT)),
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_IRAM_8BIT));
    
    {
        duk_push_string(ctx, filePath);
        duk_int_t rc = duk_pcompile_lstring_filename(ctx, 0, src, srcLen);
        free(src);  // o bytecode ja esta no heap: o fonte volta antes do app rodar
        celer_log_printf("[duk] compilado: livre %u (fonte %u B, %u ms)\n",
                         (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT), (unsigned)srcLen,
                         (unsigned)(millis() - t0));
        if (rc != 0) {
            checkJSError(ctx, rc);
            s_exitReason = "compile";  // checkJSError marcou "erro": o app nem rodou
            logAppSession(appPkg, s_sessionStart, appLaunchFreeHeap);
            JsDebugger::detach(ctx);
            JSBindings::heapDetaching();
            duk_destroy_heap(ctx);
            ctx = nullptr;
            return;
        }
    }

    duk_int_t rc = duk_pcall(ctx, 0);
    s_jsSliceStart = 0;  // fora do app: a janela do timeout recomeca no proximo
    s_jsTimedOut = false;
    // o recorte do display e do app (faixa/System.setClip): o launcher e as
    // telas de erro desenham na tela inteira
    if (tftInstance) tftInstance->clearClipRect();
    BoardIO::ledOff();  // LED e estado do app: nao fica aceso depois que ele sai
    BoardIO::stripsOff();  // idem fitas WS2812
    BoardIO::servosOff();  // servo sem dono nao segura forca (esquenta/gasta bateria)
    celerAnalogWriteReset();  // canais LEDC 0..2 do analogWrite idem (vazavam entre apps)
    JSBindings::appExitCleanup();  // keepAwake + brilho/volume/tela de app comum
    checkJSError(ctx, rc);
    JsDebugger::detach(ctx);

    // Destroy heap after app exits to free RAM
    JSBindings::heapDetaching();  // antes do destroy: nem um tick de servico
    duk_destroy_heap(ctx);
    ctx = nullptr;

    logAppSession(appPkg, s_sessionStart, appLaunchFreeHeap);
}

void CelerKernel::loop() {
    
}
