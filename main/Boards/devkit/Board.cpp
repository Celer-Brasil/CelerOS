#include "Boards/Board.h"

// Perfil do devkit "barebone" (ESP32 comum 4MB, ex.: DOIT DevKit v1): sem
// display, sem touch, sem SD. Interface minima = LED on-board de 1 canal
// (GPIO2 no DOIT v1) + botao BOOT (GPIO0) + console UART0 (celerctl).
// O painel e um stub que descarta os flush (BoardDisplay.h): o OS boota
// igual nas outras placas, o launcher fica invisivel e apps JS rodam
// headless — a "casa" do device e o homeApp (/local/autostart.txt), pois
// sem homeApp o launcher invisivel so sai por celerctl/web.

namespace {
BoardDisplay s_display;
}  // namespace

namespace Board {

static const BoardProfile s_profile = {
    .id = "devkit",
    .otaChannel = "devkit",
    .name = "devkit (ESP32 barebone, sem display)",
    .sd = {.cs = -1, .sck = -1, .miso = -1, .mosi = -1, .freqKhz = 0},
    .hasPsram = false,
    .backlightPwm = false,
    .capacitiveTouch = true,  // sem vidro: nunca entra no calibrador de touch
    .speakerPin = -1,
    .rotation = 0,
    .led = {2, -1, -1, false},  // LED on-board de 1 canal (DOIT v1: GPIO2, acende em nivel alto)
    .lightSensorPin = -1,
    .i2s = {-1, -1, -1},
    .relay = {},
    .servo = {},
    .mic = {},
    .strips = {},
    .buttonPin = 0,       // BOOT (o buttonToApp sem pin era inerte: nada lia o botao)
    .headless = true,     // sem vidro: splash pulado, getInfo().hasDisplay = false
    .buttonToApp = true,  // BOOT e input do app (System.button); longo sai, curto no launcher relanca o homeApp
    // 1/3: UART0 (console/celerctl); 6..11: SPI flash do modulo (o IDF
    // reserva no boot; o perfil documenta e cobre um boot atipico).
    .gpioDeniedMask = (1ULL << 1) | (1ULL << 3) | (1ULL << 6) | (1ULL << 7) | (1ULL << 8) |
                      (1ULL << 9) | (1ULL << 10) | (1ULL << 11),
};

void init() {
    s_display.init();
}

CelerDisplay& display() {
    return s_display;
}

const BoardProfile& profile() {
    return s_profile;
}

}  // namespace Board
