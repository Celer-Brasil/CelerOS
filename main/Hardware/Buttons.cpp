#include "Buttons.h"

#include <Arduino.h>
#include "../Boards/Board.h"
#include "../Display/Backlight.h"
#include "../Display/Display.h"
#if CONFIG_CELEROS_UI
#include "../Display/ScreenCapture.h"
#endif
#include "../Display/ScreenPower.h"
#include "../Launcher/LauncherUI.h"
#include "../UI/Kui.h"
#include "../Utils/CelerSettings.h"
#include "esp_log.h"
#include <stdio.h>
#include <string>

// ---- screenshot BMP 24-bit (segurar o botao 1) ------------------------------
// Le a tela linha a linha pelo ScreenCapture (estamos na task da UI em ambos
// os contextos de tick) e grava bottom-up. SD primeiro, LittleFS como reserva.

namespace {

struct BtnState {
    int pin = -1;
    bool raw = true;        // ultimo nivel crudo (true = solto)
    uint32_t lastChange = 0;
    bool down = false;      // estado estavel
    uint32_t downAt = 0;
    bool longFired = false;
};

BtnState s_b1, s_b2;
bool s_inited = false;
// Latch do botao 1 p/ apps (placas buttonToApp): 0 nada, 1 curto, 2 longo.
// System.button() le e consome (padrao poll da casa, como raisePoll/pmuKey).
uint8_t s_btnEvent = 0;

#if CONFIG_CELEROS_UI
void put16(uint8_t* p, uint16_t v) { p[0] = v & 0xFF; p[1] = v >> 8; }
void put32(uint8_t* p, uint32_t v) {
    p[0] = v & 0xFF; p[1] = (v >> 8) & 0xFF; p[2] = (v >> 16) & 0xFF; p[3] = (v >> 24) & 0xFF;
}

bool sdAvailable() {
    // Sem acessor publico de mount no FileSystem: probe barato no VFS
    FILE* f = fopen("/sd/.probe", "w");
    if (!f) return false;
    fclose(f);
    remove("/sd/.probe");
    return true;
}

void saveScreenshot() {
    CelerDisplay& tft = Board::display();
    int w = tft.width(), h = tft.height();
    int rowBytes = w * 3;
    int pad = (4 - (rowBytes % 4)) % 4;

    static const uint8_t zero4[4] = {0, 0, 0, 0};

    long n = atol(CelerSettings::get("shot_n", "0").c_str()) + 1;
    char sd[40], local[32];
    snprintf(sd, sizeof(sd), "/sd/SHOT%03ld.BMP", n);
    snprintf(local, sizeof(local), "/local/shot%03ld.bmp", ((n - 1) % 3) + 1);
    const char* path = sdAvailable() ? sd : local;

    // Linhas no heap so durante a captura (eram 2,6KB estaticos de RAM
    // interna parados para um gesto raro)
    uint16_t* row565 = (uint16_t*)malloc((size_t)w * sizeof(uint16_t));
    uint8_t* row888 = (uint8_t*)malloc((size_t)rowBytes);
    FILE* f = (row565 && row888) ? fopen(path, "wb") : nullptr;
    if (!f) {
        free(row565);
        free(row888);
        kui::Navigator::toast("Screenshot: sem onde gravar", THEME_WARN, 2500);
        return;
    }

    uint8_t hdr[54] = {};
    hdr[0] = 'B'; hdr[1] = 'M';
    put32(&hdr[2], 54 + (uint32_t)(rowBytes + pad) * h);
    put32(&hdr[10], 54);
    put32(&hdr[14], 40);
    put32(&hdr[18], (uint32_t)w);
    put32(&hdr[22], (uint32_t)h);   // positivo = bottom-up
    put16(&hdr[26], 1);
    put16(&hdr[28], 24);
    put32(&hdr[34], (uint32_t)(rowBytes + pad) * h);
    fwrite(hdr, 1, 54, f);

    bool ok = true;
    for (int y = h - 1; y >= 0; --y) {
        if (ScreenCapture::readRows((uint16_t)y, 1, row565) != 1) {
            ok = false;
            break;
        }
        for (int x = 0; x < w; ++x) {
            uint16_t p = row565[x];
            row888[x * 3 + 0] = (uint8_t)(((p >> 11) & 0x1F) * 255 / 31);  // B (bottom-up + BGR)
            row888[x * 3 + 1] = (uint8_t)(((p >> 5) & 0x3F) * 255 / 63);   // G
            row888[x * 3 + 2] = (uint8_t)((p & 0x1F) * 255 / 31);          // R
        }
        fwrite(row888, 1, rowBytes, f);
        if (pad) fwrite(zero4, 1, pad, f);
    }
    fclose(f);
    free(row565);
    free(row888);
    if (!ok) return;  // captura incompleta: numeracao nao avanca

    char v[16];
    snprintf(v, sizeof(v), "%ld", n);
    CelerSettings::set("shot_n", v);
    ESP_LOGI("celer.btn", "screenshot: %s", path);
    kui::Navigator::toast(std::string("Screenshot: ") + path, THEME_ACCENT, 2500);
}
#endif  // CONFIG_CELEROS_UI

void onShort1(bool inApp) {
    if (Board::profile().buttonToApp && inApp) {
        // botao e input do app: o curto fica no latch (System.button le e
        // consome); a saida do app e o longo
        s_btnEvent = 1;
        return;
    }
    if (inApp) {
        // Encerramento limpo pelo mecanismo do X da topbar: o app sai no
        // proximo ponto de espera (delay/getTouch) e o launcher volta.
        LauncherUI::requestAppExit();
#if CONFIG_CELEROS_UI
    } else if (kui::Navigator::depth() <= 1 && LauncherUI::launchHome()) {
        // ja na raiz do launcher: BOOT leva para a casa (watchface no watch;
        // no devkit headless relanca o homeApp — launcher invisivel nao e casa)
    } else {
        kui::Navigator::home();
#else
    } else {
        // sem vidro: launcher invisivel nao e casa — tenta relancar o homeApp
        LauncherUI::launchHome();
#endif
    }
}

void onLong1(bool inApp) {
    if (Board::profile().buttonToApp) {
        if (inApp) {
            s_btnEvent = 2;                       // registro no latch...
            LauncherUI::requestAppExit();         // ...e saida limpa do app
        }
        // no launcher nao ha o que fazer: sem vidro, screenshot e lixo
        return;
    }
#if CONFIG_CELEROS_UI
    saveScreenshot();
#else
    (void)inApp;
#endif
}

void poll(BtnState& b, uint32_t now, void (*onShort)(bool), void (*onLong)(bool), bool inApp) {
    if (b.pin < 0) return;
    bool raw = digitalRead(b.pin) == LOW;  // ativo-baixo
    if (raw != b.raw) {
        b.raw = raw;
        b.lastChange = now;
    }
    // debounce: nivel estavel por >= 20 ms
    if (now - b.lastChange < 20) return;
    if (raw != b.down) {
        b.down = raw;
        if (raw) {
            b.downAt = now;
            b.longFired = false;
        } else if (!b.longFired && now - b.downAt >= 40) {
            if (onShort) onShort(inApp);
        }
        return;
    }
    if (b.down && !b.longFired && now - b.downAt >= 1200) {
        b.longFired = true;
        if (onLong) onLong(inApp);
    }
}

// Qualquer press confirmado acorda a tela (hub do Backlight; o ScreenPower
// observa o edge e religa o painel). O retorno "consumiu" do noteActivity
// nao se aplica a botao: a acao do botao roda de qualquer forma.
void notePress() { Backlight::noteActivity(); }

// Botao 2 (PWR) segurado ~1,2 s: deep sleep de verdade (acorda por EXT1).
// No watch o pino 2 fica desligado (o PWR fisico fala com o AXP2101), mas
// o caminho fica pronto para placas com botao GPIO de verdade.
void pwrLong(bool inApp) {
    (void)inApp;
    ScreenPower::deepSleepNow();
}

}  // namespace

namespace Buttons {

void init() {
    s_b1.pin = Board::profile().buttonPin;
    s_b2.pin = Board::profile().buttonPin2;
    s_btnEvent = 0;  // estado novo por boot (regra do runtime: reset no init)
    if (s_b1.pin >= 0) pinMode(s_b1.pin, INPUT_PULLUP);
    if (s_b2.pin >= 0) pinMode(s_b2.pin, INPUT_PULLUP);
    s_inited = s_b1.pin >= 0 || s_b2.pin >= 0;
    if (s_inited) {
        // Diagnostico de bancada: nivel crudo dos botoes com pull-up
        ESP_LOGI("celer.btn", "botoes: b1(GPIO%d)=%d b2(GPIO%d)=%d",
                 s_b1.pin, s_b1.pin >= 0 ? digitalRead(s_b1.pin) : -1,
                 s_b2.pin, s_b2.pin >= 0 ? digitalRead(s_b2.pin) : -1);
    }
}

void tick(bool inApp) {
    if (!s_inited) return;
    uint32_t now = millis();
    bool wasDown1 = s_b1.down, wasDown2 = s_b2.down;
    poll(s_b1, now, onShort1, onLong1, inApp);
    // PWR (b2): curto = acorda a tela (notePress); segurado ~2 s dorme.
    poll(s_b2, now, nullptr, pwrLong, inApp);
    if ((!wasDown1 && s_b1.down) || (!wasDown2 && s_b2.down)) notePress();
}

int buttonEvents() {
    int ev = s_btnEvent;
    s_btnEvent = 0;
    return ev;
}

}  // namespace Buttons
