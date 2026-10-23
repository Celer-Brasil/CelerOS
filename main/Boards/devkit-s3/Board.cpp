#include "Boards/Board.h"

// Perfil do ESP32-S3-DevKitC-1 (modulo N16R8: 16MB flash QIO + 8MB PSRAM
// octal), sem display. Dois conectores USB-C com papeis diferentes:
//
//   - "UART" (bridge CP2102N): console/celerctl na UART0 (GPIO43/44) e a
//     porta de gravacao. E o caminho do SerialLink (sem CELEROS_LINK_ON_USJ).
//   - "USB" (nativo, GPIO19/20): USB-OTG como HOST (CELEROS_USB_HOST) — o
//     host da API JS USB.*. No S3 o OTG e a USB-Serial/JTAG dividem o mesmo
//     PHY interno; com o host instalado a USJ nao existe. Por isso
//     CELEROS_USB_NATIVE e CELEROS_LINK_ON_USJ ficam DESLIGADOS na placa.
//
// A placa normalmente alimenta os dois conectores; o VBUS do host (5V para o
// dispositivo) NAO e chaveado por GPIO no DevKitC-1 — use hub alimentado se
// o dispositivo pedir mais corrente do que a placa fornece.
//
// LED: WS2812 enderecavel no GPIO38 (DevKitC-1 v1.1+). Na v1.0 nao ha LED —
// o perfil fica igual e o System.neopixel simplesmente nao acende nada.
// Botao BOOT (GPIO0) = input do app (buttonToApp), como no devkit classico.

namespace {
BoardDisplay s_display;
}  // namespace

namespace Board {

static const BoardProfile s_profile = {
    .id = "devkit-s3",
    .otaChannel = "devkit-s3",
    .name = "devkit-s3 (ESP32-S3 N16R8, USB host, sem display)",
    .sd = {.cs = -1, .sck = -1, .miso = -1, .mosi = -1, .freqKhz = 0},
    .hasPsram = true,        // 8MB octal (N16R8)
    .backlightPwm = false,   // sem vidro
    .capacitiveTouch = true, // sem vidro: nunca entra no calibrador de touch
    .speakerPin = -1,
    .rotation = 0,
    .led = {-1, -1, -1, false},  // sem LED RGB de 3 canais; o WS2812 vai em strips
    .lightSensorPin = -1,
    .i2s = {-1, -1, -1},
    .relay = {},
    .servo = {},
    .mic = {},
    .strips = {.count = 1, .pins = {38, -1}, .ledsPerStrip = 1},
    .buttonPin = 0,       // BOOT (o buttonToApp sem pin era inerte: nada lia o botao)
    .headless = true,     // sem vidro: splash pulado, getInfo().hasDisplay = false
    .buttonToApp = true,  // BOOT e input do app; longo sai, curto no launcher relanca o homeApp
    // 19/20: USB-OTG (host); 26..32: flash SPI do modulo; 33..37: DQ4..7/DQS
    // da PSRAM octal; 43/44: UART0 (console/celerctl). Bit n = GPIO n.
    .gpioDeniedMask = (1ULL << 19) | (1ULL << 20) |
                      (0x3FFCULL << 24) |  // 26..37
                      (1ULL << 43) | (1ULL << 44),
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
