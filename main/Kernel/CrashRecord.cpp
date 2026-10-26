#include "CrashRecord.h"
#include "Core/CelerKernel.h"
#include "../Boards/Board.h"
#include "../USBDevice/LogSink.h"
#include <cstring>
#include <cstdio>
#include <cstdint>
#include <ctime>
#include <sys/stat.h>
#include "esp_attr.h"
#include "esp_system.h"
#include "esp_cpu_utils.h"  // esp_cpu_process_stack_pc (mascara o PC do Xtensa)
#include "esp_debug_helpers.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_private/panic_internal.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#if CONFIG_CELEROS_CRASH_SCREEN
#include "../Display/Layout.h"
#include "../Display/Theme.h"
#include "../Display/ScreenCapture.h"
#include "../FileSystem/FileSystem.h"
#include "../Utils/I18n.h"
#include "../UI/Kui.h"
#include "../Compat/Arduino.h"  // delay/digitalRead/pinMode/millis
#endif

#if !defined(CELEROS_VERSION)
#define CELEROS_VERSION "?"
#endif

#if defined(__XTENSA__)
#include "xtensa_context.h"  // XtExcFrame: frame de excecao do panic (IDF)
#endif

namespace {

// ---------------------------------------------------------------------------
// Registro em RAM RTC: sobrevive ao reboot do panic (nao ao power-on — o
// magic descarta lixo de energizacao). Mesmo padrao do s_fatalMsg do kernel.
// ---------------------------------------------------------------------------
constexpr uint32_t kMagic = 0xCE1AC05Eu;
constexpr uint8_t kLayout = 1;
constexpr uint8_t kMaxPcs = 12;

struct Record {
    uint32_t magic;
    uint8_t layout;
    uint8_t nPcs;
    uint16_t cause;      // panic_exception_t cru
    uint32_t uptimeMs;
    uint32_t addr;       // endereco que disparou (panic_info_t::addr)
    uint32_t pcs[kMaxPcs];
};

RTC_NOINIT_ATTR Record s_rec;

// Copia em RAM do boot: o consumeAndLog roda ANTES da tela (para o arquivo
// existir cedo) e limpa o magic quando a gravacao deu certo — a tela que vem
// depois (com o link serial ja de pe) le esta copia.
static Record s_bootRecord;
static bool s_bootValid = false;

// Prepara o struct ANTES do backtrace (que pode andar frame podre): o
// essencial (magic+causa+uptime) ja esta gravado se a walk engasgar.
void recordBasics(uint16_t cause, uint32_t addr) {
    s_rec.magic = kMagic;
    s_rec.layout = kLayout;
    s_rec.cause = cause;
    s_rec.addr = addr;
    s_rec.uptimeMs = (uint32_t)(esp_timer_get_time() / 1000ULL);
    s_rec.nPcs = 0;
}

// Backtrace a mao por frame-pointer (tecnica do IDF/Tactility): o primeiro
// frame vem do FRAME DE EXCECAO do panic (info->frame) — a walker a partir
// da funcao corrente nao enxerga o frame do trap e voltava vazia (bancada
// devkit-s3 2026-10-26: crash.txt com "pcs" sem nada). PCs validados contra
// codigo executavel; frame podre ENCERRA a walk, nao trava.
void recordBacktrace(const void* excFrame) {
    esp_backtrace_frame_t frame;
#if defined(__XTENSA__)
    if (excFrame != nullptr) {
        const XtExcFrame* xt = (const XtExcFrame*)excFrame;
        frame.pc = xt->pc;
        frame.sp = xt->a1;
        frame.next_pc = xt->a0;
        frame.exc_frame = xt;
    } else
#endif
    {
        uint32_t pc = 0, sp = 0, nextPc = 0;
        esp_backtrace_get_start(&pc, &sp, &nextPc);
        frame.pc = pc;
        frame.sp = sp;
        frame.next_pc = nextPc;
        frame.exc_frame = nullptr;
    }
    // PC sempre mascarado como o IDF faz (esp_cpu_process_stack_pc limpa os
    // bits de janela do endereco de retorno do Xtensa: um a0 com 0x80......
    // falharia em esp_ptr_executable e a cadeia inteira seria descartada).
    uint32_t pc0 = esp_cpu_process_stack_pc(frame.pc);
    if (esp_ptr_executable((void*)pc0)) s_rec.pcs[s_rec.nPcs++] = pc0;
    // Mesmo laco do esp_backtrace_print_from_frame (IDF): NAO pre-valida o
    // next_pc (num trap de abort ele pode nao casar com nenhum range na
    // primeira transicao — validar antes cortava a cadeia no 1o frame);
    // o walker valida o stack pointer por dentro.
    for (int i = 0; i < 32 && s_rec.nPcs < kMaxPcs && frame.next_pc != 0; i++) {
        if (!esp_backtrace_get_next_frame(&frame)) break;
        uint32_t pc = esp_cpu_process_stack_pc(frame.pc);
        if (esp_ptr_executable((void*)pc)) s_rec.pcs[s_rec.nPcs++] = pc;
    }
}

const char* causeLabel(uint16_t cause) {
    switch (cause) {
        case PANIC_EXCEPTION_ABORT: return "abort";
        case PANIC_EXCEPTION_FAULT: return "fault";
        case PANIC_EXCEPTION_TWDT:  return "wdt-task";
        case PANIC_EXCEPTION_IWDT:  return "wdt-int";
        case PANIC_EXCEPTION_DEBUG: return "debug";
        default:                    return "?";
    }
}

}  // namespace

// ---------------------------------------------------------------------------
// Wrap do esp_panic_handler (link: -Wl,--wrap=esp_panic_handler): roda ANTES
// do handler de verdade (que imprime e reinicia). Contexto de panic: nada de
// malloc/std::string/ESP_LOG — so gravacao em RAM RTC e leitura de frame.
// ---------------------------------------------------------------------------
extern "C" void __real_esp_panic_handler(panic_info_t* info);
extern "C" void __wrap_esp_panic_handler(panic_info_t* info) {
    recordBasics((uint16_t)info->exception, (uint32_t)(uintptr_t)info->addr);
    recordBacktrace(info->frame);
    __real_esp_panic_handler(info);
}

namespace CrashRecord {

void installPanicHook() {
    // O wrap e ligado pelo linker; aqui so garantimos que o espaco RTC existe
    // no binario (referencia viva) e normalizamos um estado inicial.
    if (s_rec.magic != kMagic) s_rec.magic = 0;
}

bool pending() {
    return esp_reset_reason() == ESP_RST_PANIC &&
           s_rec.magic == kMagic && s_rec.layout == kLayout;
}

void consumeAndLog() {
    if (!pending()) return;

    // Copia o registro ANTES de qualquer limpeza: a tela (depois do link
    // serial) le daqui; o magic so cai quando o arquivo foi persistido.
    s_bootRecord = s_rec;
    s_bootValid = true;

    // App corrente vem do kernel (s_crashApp/s_crashPkg sao estaticos em RAM:
    // leitura segura no boot, o valor e o do momento do panic)
    const char* app = CelerKernel::crashTitle();
    const char* pkg = CelerKernel::crashPkg();

    char when[32] = "sem relogio (NTP fora)";
    time_t now = time(nullptr);
    if (now > 1600000000) {
        struct tm tmv;
        localtime_r(&now, &tmv);
        strftime(when, sizeof(when), "%Y-%m-%d %H:%M", &tmv);
    }

    char line[448];
    int n = snprintf(line, sizeof(line),
                     "CelerOS %s | %s | uptime %lus | causa %s (%u) addr 0x%08x | app: %s (%s) | pcs",
                     CELEROS_VERSION, when, (unsigned long)(s_rec.uptimeMs / 1000UL),
                     causeLabel(s_rec.cause), (unsigned)s_rec.cause, (unsigned)s_rec.addr,
                     app[0] ? app : "-", pkg[0] ? pkg : "-");
    if (n < 0) return;
    for (uint8_t i = 0; i < s_rec.nPcs && n < (int)sizeof(line) - 16; i++) {
        n += snprintf(line + n, sizeof(line) - n, " 0x%08x", (unsigned)s_rec.pcs[i]);
    }
    if (n > (int)sizeof(line) - 2) n = (int)sizeof(line) - 2;
    line[n++] = '\n';

    // /local/log pode ainda nao existir (o LogPersist cria mais tarde no boot)
    mkdir("/local/log", 0777);

    // Anexa; acima de 32 KB recomeca o arquivo (um crash por linha ~300 B).
    const char* kPath = "/local/log/crash.txt";
    FILE* probe = fopen(kPath, "r");
    bool full = false;
    if (probe != nullptr) {
        fseek(probe, 0, SEEK_END);
        full = ftell(probe) > 32768;
        fclose(probe);
    }
    FILE* f = fopen(kPath, full ? "w" : "a");
    if (f == nullptr) {
        // FS cheio/indisponivel: NAO limpa o magic — o registro segue em RAM
        // RTC e o proximo boot tenta de novo (a CYD da bancada com /local
        // cheio perdia o crash para sempre no desenho anterior).
        celer_log_printf("crash.txt: /local indisponivel (%u B retidos no RTC)\n", (unsigned)n);
        return;
    }
    bool ok = fwrite(line, 1, (size_t)n, f) == (size_t)n;
    ok = (fclose(f) == 0) && ok;
    if (ok) {
        s_rec.magic = 0;  // persistido: o proximo panic sobrescreve o registro
    }
    celer_log_printf("crash.txt: %s (%u B)%s\n", ok ? "gravado" : "falhou ao gravar",
                     (unsigned)n, ok ? "" : " (retido no RTC)");
}

#if CONFIG_CELEROS_CRASH_SCREEN

// ---------------------------------------------------------------------------
// Foto da tela de crash em BMP 24-bit (top-down) ao lado do crash.txt: a
// evidencia fica PERMANENTE no aparelho e e pullavel como o log (o agente de
// frota pode subir junto) — sem depender do timing do USB, que so responde
// depois do reboot (bancada 2026-10-26: a janela de 7 s nao era capturavel
// de fora). Best-effort: /sd quando montado, senao /local/log; FS cheio = sem
// foto (o crash.txt do consumeAndLog continua sendo a fonte primaria).
// Pixels vem de ScreenCapture::stream (RLE {u16 count, u16 rgb565} LE), na
// task da UI: leitura direta, sem fila.
// ---------------------------------------------------------------------------
static bool saveCrashShot(CelerDisplay& tft) {
    const int w = (int)tft.width();
    const int h = (int)tft.height();
    if (w <= 0 || h <= 0 || w > 1024 || h > 1024) return false;
    const uint32_t stride = ((uint32_t)w * 3u + 3u) & ~3u;

    const bool sd = FileSystem::sdMounted();
    const char* dir = sd ? "/sd/log" : "/local/log";
    const char* path = sd ? "/sd/log/crash.bmp" : "/local/log/crash.bmp";
    mkdir(dir, 0777);
    FILE* f = fopen(path, "wb");
    if (f == nullptr) {
        celer_log_printf("crash.bmp: %s indisponivel\n", dir);
        return false;
    }

    // Cabecalho BMP (54 B). Altura NEGATIVA = linhas de cima para baixo
    // (o stream vem em ordem de varredura, sem precisar buffer da tela toda).
    uint8_t hdr[54] = {0};
    const uint32_t imgSize = stride * (uint32_t)h;
    const uint32_t fileSize = 54 + imgSize;
    hdr[0] = 'B'; hdr[1] = 'M';
    memcpy(hdr + 2, &fileSize, 4);
    const uint32_t off = 54;
    memcpy(hdr + 10, &off, 4);
    const uint32_t biSize = 40;
    memcpy(hdr + 14, &biSize, 4);
    int32_t bw = w, bh = -h;
    memcpy(hdr + 18, &bw, 4);
    memcpy(hdr + 22, &bh, 4);
    const uint16_t planes = 1, bpp = 24;
    memcpy(hdr + 26, &planes, 2);
    memcpy(hdr + 28, &bpp, 2);
    memcpy(hdr + 34, &imgSize, 4);
    if (fwrite(hdr, 1, sizeof(hdr), f) != sizeof(hdr)) {
        fclose(f);
        return false;
    }

    struct Cursor {
        FILE* f;
        int w;
        int x;
        uint32_t stride;
    } cur = {f, w, 0, stride};
    auto sink = [&cur](const uint8_t* data, size_t n) -> bool {
        for (size_t i = 0; i + 3 < n; i += 4) {
            const uint16_t count = (uint16_t)(data[i] | (data[i + 1] << 8));
            const uint16_t px = (uint16_t)(data[i + 2] | (data[i + 3] << 8));
            const uint8_t b = (uint8_t)((px & 0x1F) << 3);
            const uint8_t g = (uint8_t)(((px >> 5) & 0x3F) << 2);
            const uint8_t rr = (uint8_t)(((px >> 11) & 0x1F) << 3);
            for (uint16_t k = 0; k < count; k++) {
                const uint8_t bgr[3] = {b, g, rr};
                if (fwrite(bgr, 1, 3, cur.f) != 3) return false;
                if (++cur.x == cur.w) {
                    // padding de linha do BMP ate multiplo de 4
                    const uint32_t pad = cur.stride - (uint32_t)cur.w * 3u;
                    const uint8_t zeros[3] = {0, 0, 0};
                    if (pad > 0 && fwrite(zeros, 1, pad, cur.f) != pad) return false;
                    cur.x = 0;
                }
            }
        }
        return true;
    };

    uint8_t buf[1024];
    bool ok = ScreenCapture::stream(true, buf, sizeof(buf), sink);
    ok = (fclose(f) == 0) && ok;
    if (!ok) {
        remove(path);  // arquivo parcial nao serve de evidencia
        celer_log_printf("crash.bmp: falhou ao gravar (%dx%d)\n", w, h);
    } else {
        celer_log_printf("crash.bmp: gravado %s (%dx%d, %u B)\n", path, w, h, (unsigned)fileSize);
    }
    return ok;
}

// Desenha cabendo na largura: usa a fonte grande se couber, cai para a
// pequena e, em ultimo caso, trunca com "..." — no watch (412 px reais) o
// titulo do tamanho do smartdisplay vazava a borda direita (bancada).
static void drawFit(CelerDisplay& tft, const char* s, int x, int y, int maxW,
                    const lgfx::IFont* big, const lgfx::IFont* small) {
    if (tft.textWidth(s, big) <= maxW) {
        tft.drawString(s, x, y, big);
        return;
    }
    if (tft.textWidth(s, small) <= maxW) {
        tft.drawString(s, x, y, small);
        return;
    }
    char buf[96];
    snprintf(buf, sizeof(buf), "%s", s);
    size_t n = strlen(buf);
    while (n > 1) {
        buf[n] = '\0';
        char withDots[100];
        snprintf(withDots, sizeof(withDots), "%s...", buf);
        if (tft.textWidth(withDots, small) <= maxW) {
            tft.drawString(withDots, x, y, small);
            return;
        }
        n--;
    }
    tft.drawString(buf, x, y, small);
}

void showScreen() {
    // Registro da copia em RAM (consumeAndLog ja rodou e pode ter limpado o
    // magic com o arquivo gravado) ou direto do RTC se ainda nao consumido.
    if (!s_bootValid && !pending()) return;
    const Record& rec = s_bootValid ? s_bootRecord : s_rec;

    CelerDisplay& tft = Board::display();
    tft.startWrite();
    tft.fillScreen(THEME_BG);
    const int hdr = UI::sy(52);
    tft.fillRect(0, 0, UI::W, hdr, THEME_CARD);
    tft.fillRect(0, hdr - UI::sy(3), UI::W, UI::sy(3), THEME_ERR);
    tft.setTextDatum(ML_DATUM);
    tft.setTextColor(THEME_TEXT);
    drawFit(tft, i18n::TR("O sistema reiniciou após um erro", "System restarted after a crash"),
            UI::sx(14), hdr / 2, UI::W - UI::sx(20), kui::type::title(), kui::type::body());
    tft.setTextDatum(TL_DATUM);
    tft.setTextColor(THEME_TEXT_DIM);

    const int maxW = UI::W - UI::sx(20);
    char buf[96];
    snprintf(buf, sizeof(buf), "CelerOS %s  |  %s", CELEROS_VERSION, Board::profile().id);
    drawFit(tft, buf, UI::sx(14), hdr + UI::sy(14), maxW, kui::type::body(), kui::type::caption());
    snprintf(buf, sizeof(buf), "causa: %s  (uptime %lus)", causeLabel(rec.cause),
             (unsigned long)(rec.uptimeMs / 1000UL));
    drawFit(tft, buf, UI::sx(14), hdr + UI::sy(32), maxW, kui::type::body(), kui::type::caption());
    snprintf(buf, sizeof(buf), "addr 0x%08x  pc 0x%08x", (unsigned)rec.addr,
             rec.nPcs > 0 ? (unsigned)rec.pcs[0] : 0u);
    drawFit(tft, buf, UI::sx(14), hdr + UI::sy(50), maxW, kui::type::body(), kui::type::caption());
    if (CelerKernel::crashPkg()[0]) {
        snprintf(buf, sizeof(buf), "app: %s (%s)", CelerKernel::crashTitle(),
                 CelerKernel::crashPkg());
        drawFit(tft, buf, UI::sx(14), hdr + UI::sy(68), maxW, kui::type::body(), kui::type::caption());
    }
    tft.endWrite();

    // QR com o resumo: o tecnico fotografar resolve sem servidor de
    // simbolizacao. Módulos de ~2 px (v5 = 37x37) saem legiveis a partir de
    // ~92 px; centralizado no terco de baixo.
    char qr[152];
    snprintf(qr, sizeof(qr), "CelerOS %s %s c=%s u=%lus a=%08x p=%08x",
             CELEROS_VERSION, Board::profile().id, causeLabel(rec.cause),
             (unsigned long)(rec.uptimeMs / 1000UL), (unsigned)rec.addr,
             rec.nPcs > 0 ? (unsigned)rec.pcs[0] : 0u);
    const int qw = (UI::W < UI::H ? UI::W : UI::H) * 2 / 5;
    tft.qrcode(qr, (UI::W - qw) / 2, UI::sy(160), qw, 5);

    // Evidencia permanente: a foto da tela vai para <log>/crash.bmp (pullavel
    // como o crash.txt; o agente de frota pode anexar no evento de crash)
    saveCrashShot(tft);

    // ~7 s de leitura (ou botao fisico para pular): nao trava o boot — no
    // varejo, aparelho parado parece defeito. O link serial ja esta de pe
    // (a tela roda depois do SerialLink::init): celerctl screencap captura.
    const uint32_t t0 = millis();
    const int pin = Board::profile().buttonPin;
    if (pin >= 0) pinMode(pin, INPUT_PULLUP);
    while (millis() - t0 < 7000) {
        if (pin >= 0 && digitalRead(pin) == LOW) break;
        delay(50);
    }
}

#endif  // CONFIG_CELEROS_CRASH_SCREEN

}  // namespace CrashRecord
