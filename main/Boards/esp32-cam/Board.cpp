#include "Boards/Board.h"

// Perfil da ESP32-CAM AI-Thinker (modulo ESP32-S: ESP32 classico, 4MB flash
// DIO/40M + 4MB PSRAM quad no barramento do modulo, OV2640, microSD, sem
// display). A "tela" da placa e o sensor: a interface com o mundo e o
// celerctl na UART0 (FTDI/CAM-MB), o web server e a malha CelerNet.
//
// Mapa de pinos OV2640 (AI-Thinker, para a rodada Camera.* — API 35):
//   PWDN 32 | XCLK 0 | SIOD 26 (SDA) | SIOC 27 (SCL)
//   Y2..Y9 = 5, 18, 19, 21, 35, 34, 39, 36 | VSYNC 25 | HREF 23 | PCLK 22
//   (34-39 sao input-only; SIOD/SIOC sao o SCCB compartilhado com o I2C)
//
// microSD em modo SPI (SDSPI, HAL das outras placas — sem codigo novo):
//   CLK 14 | CMD/MOSI 15 | D0/MISO 2 | CS/D3 13
//   1-bit: D1 (GPIO4) e D2 (GPIO12) ficam livres. GPIO12 e strap MTD (nivel
//   alto no boot muda o VDD da flash p/ 1,8V): NUNCA usar como saida.
//   GPIO4 = LED de flash branco (torch dos apps, ja permitido no gpioMask).
//   GPIO16/17 = linhas da PSRAM quad do modulo (fora do gpioDeniedMask nao
//   por esquecimento: esp_gpio_is_reserved nao conhece o modo da PSRAM).
//
// Bancada: brownout e a falha n1 do ESP32-CAM — alimentar 5V por fonte/
// programador robusto (nao pelo 3V3 do FTDI). Para gravar: GPIO0 no GND no
// reset (o CAM-MB faz no botao IO0). O XCLK do sensor e o proprio GPIO0:
// depois do boot ele e do driver da camera.

namespace {
BoardDisplay s_display;
}  // namespace

namespace Board {

static const BoardProfile s_profile = {
    .id = "esp32-cam",
    .otaChannel = "esp32-cam",
    .name = "esp32-cam (AI-Thinker ESP32-S: camera + SD, sem display)",
    .sd = {.cs = 13, .sck = 14, .miso = 2, .mosi = 15, .freqKhz = 10000},
    .hasPsram = true,       // 4MB quad (40MHz: rev1 do modulo nao segura 80)
    .backlightPwm = false,
    .capacitiveTouch = true,  // sem vidro: nunca entra no calibrador de touch
    .speakerPin = -1,
    .rotation = 0,
    .led = {33, -1, -1, true},  // LED vermelho traseiro (ativo-baixo na placa de ref.)
    .lightSensorPin = -1,
    .i2s = {-1, -1, -1},
    .relay = {},
    .servo = {},
    .mic = {},
    .strips = {},
    // OV2640 no DVP (mapa AI-Thinker) + LED de flash no GPIO4 (Camera.led)
    .camera = {
        .pwdn = 32, .reset = -1, .xclk = 0,
        .siod = 26, .sioc = 27,
        .y9 = 35, .y8 = 34, .y7 = 39, .y6 = 36,
        .y5 = 21, .y4 = 19, .y3 = 18, .y2 = 5,
        .vsync = 25, .href = 23, .pclk = 22,
        .flashLed = 4,
    },
    .headless = true,   // sem vidro: splash pulado, getInfo().hasDisplay = false
    .buttonToApp = false,  // sem botao fisico util (GPIO0 e XCLK/strap de gravacao)
    // Camera (OV2640) + slot SD + PSRAM (16/17) + UART0 (1/3, console) + XCLK
    // (0) + strap MTD (12): o que sobra p/ apps e o LED flash (GPIO4), o LED
    // vermelho (GPIO33) e as leituras dos input-only 34-39.
    .gpioDeniedMask = (1ULL << 0) | (1ULL << 1) | (1ULL << 2) | (1ULL << 3) |
                      (1ULL << 5) | (1ULL << 12) | (1ULL << 13) | (1ULL << 14) |
                      (1ULL << 15) | (1ULL << 16) | (1ULL << 17) | (1ULL << 18) |
                      (1ULL << 19) | (1ULL << 21) | (1ULL << 22) | (1ULL << 23) |
                      (1ULL << 25) | (1ULL << 26) | (1ULL << 27) | (1ULL << 32),
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
