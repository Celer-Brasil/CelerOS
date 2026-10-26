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
#include "esp_debug_helpers.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_private/panic_internal.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#if CONFIG_CELEROS_CRASH_SCREEN
#include "../Display/Layout.h"
#include "../Display/Theme.h"
#include "../Utils/I18n.h"
#include "../UI/Kui.h"
#include "../Compat/Arduino.h"  // delay/digitalRead/pinMode/millis
#endif

#if !defined(CELEROS_VERSION)
#define CELEROS_VERSION "?"
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

// Backtrace a mao por frame-pointer (tecnica do IDF/Tactility): PCs validados
// contra codigo executavel; frame invalido ENCERRA a walk, nao trava.
void recordBacktrace() {
    esp_backtrace_frame_t frame;
    uint32_t pc = 0, sp = 0, nextPc = 0;
    esp_backtrace_get_start(&pc, &sp, &nextPc);
    frame.pc = pc;
    frame.sp = sp;
    frame.next_pc = nextPc;
    frame.exc_frame = nullptr;
    if (esp_ptr_executable((void*)pc)) s_rec.pcs[s_rec.nPcs++] = pc;
    for (int i = 0; i < 32 && s_rec.nPcs < kMaxPcs; i++) {
        if (frame.next_pc == 0 || !esp_ptr_executable((void*)frame.next_pc)) break;
        if (!esp_backtrace_get_next_frame(&frame)) break;
        if (esp_ptr_executable((void*)frame.pc)) s_rec.pcs[s_rec.nPcs++] = frame.pc;
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
    recordBacktrace();
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
    // O magic zera ANTES: um novo panic nesta sessao sobrescreve o registro.
    s_rec.magic = 0;

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
        celer_log_printf("crash.txt: /local indisponivel (%u B perdidos)\n", (unsigned)n);
        return;
    }
    bool ok = fwrite(line, 1, (size_t)n, f) == (size_t)n;
    ok = (fclose(f) == 0) && ok;
    celer_log_printf("crash.txt: %s (%u B)\n", ok ? "gravado" : "falhou ao gravar", (unsigned)n);
}

#if CONFIG_CELEROS_CRASH_SCREEN

void showScreen() {
    if (!pending()) return;

    CelerDisplay& tft = Board::display();
    tft.startWrite();
    tft.fillScreen(THEME_BG);
    const int hdr = UI::sy(52);
    tft.fillRect(0, 0, UI::W, hdr, THEME_CARD);
    tft.fillRect(0, hdr - UI::sy(3), UI::W, UI::sy(3), THEME_ERR);
    tft.setTextDatum(ML_DATUM);
    tft.setTextColor(THEME_TEXT);
    tft.drawString(i18n::TR("O sistema reiniciou após um erro", "System restarted after a crash"),
                   UI::sx(14), hdr / 2, kui::type::title());
    tft.setTextDatum(TL_DATUM);
    tft.setTextColor(THEME_TEXT_DIM);

    char buf[96];
    snprintf(buf, sizeof(buf), "CelerOS %s  |  %s", CELEROS_VERSION, Board::profile().id);
    tft.drawString(buf, UI::sx(14), hdr + UI::sy(14), kui::type::body());
    snprintf(buf, sizeof(buf), "causa: %s  (uptime %lus)", causeLabel(s_rec.cause),
             (unsigned long)(s_rec.uptimeMs / 1000UL));
    tft.drawString(buf, UI::sx(14), hdr + UI::sy(32), kui::type::body());
    snprintf(buf, sizeof(buf), "addr 0x%08x  pc 0x%08x", (unsigned)s_rec.addr,
             s_rec.nPcs > 0 ? (unsigned)s_rec.pcs[0] : 0u);
    tft.drawString(buf, UI::sx(14), hdr + UI::sy(50), kui::type::body());
    if (CelerKernel::crashPkg()[0]) {
        snprintf(buf, sizeof(buf), "app: %s (%s)", CelerKernel::crashTitle(),
                 CelerKernel::crashPkg());
        tft.drawString(buf, UI::sx(14), hdr + UI::sy(68), kui::type::body());
    }
    tft.endWrite();

    // QR com o resumo: o tecnico fotografar resolve sem servidor de
    // simbolizacao. Módulos de ~2 px (v5 = 37x37) saem legiveis a partir de
    // ~92 px; centralizado no terco de baixo.
    char qr[152];
    snprintf(qr, sizeof(qr), "CelerOS %s %s c=%s u=%lus a=%08x p=%08x",
             CELEROS_VERSION, Board::profile().id, causeLabel(s_rec.cause),
             (unsigned long)(s_rec.uptimeMs / 1000UL), (unsigned)s_rec.addr,
             s_rec.nPcs > 0 ? (unsigned)s_rec.pcs[0] : 0u);
    const int qw = (UI::W < UI::H ? UI::W : UI::H) * 2 / 5;
    tft.qrcode(qr, (UI::W - qw) / 2, UI::sy(160), qw, 5);

    // ~7 s de leitura (ou botao fisico para pular): nao trava o boot — no
    // varejo, aparelho parado parece defeito.
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
