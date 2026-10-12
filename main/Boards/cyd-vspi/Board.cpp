#include "Boards/Board.h"

// Perfil da variante CYD com TFT no VSPI (NAO TESTADA — ver BoardDisplay.h).

namespace {
BoardDisplay s_display;
}  // namespace

namespace Board {

static const BoardProfile s_profile = {
    .id = "cyd-vspi",
    .otaChannel = "esp32",
    .name = "cyd-vspi (CYD pinout VSPI — nao testada)",
    .sd = {.cs = 15, .sck = 14, .miso = 26, .mosi = 13, .freqKhz = 0},  // HSPI dedicado (0 = default do driver)
    .hasPsram = false,
    .backlightPwm = true,   // GPIO22 via Light_PWM (antes era fixo 100%)
    .capacitiveTouch = false,
    .speakerPin = -1,  // sem buzzer na placa; setar o GPIO quando houver
    .rotation = 0,     // portrait 240x320 (como o env original)
    .led = {-1, -1, -1, false},
    .lightSensorPin = -1,
    .i2s = {-1, -1, -1},
    .relay = {},
    .servo = {},
    .mic = {},
    .strips = {},  // sem reles
    .watchGestures = true,  // bordas: ajustes rapidos / notificacoes / voltar
    .gpioDeniedMask = (1ULL << 1) | (1ULL << 3),  // GPIO1/3: UART0 = console/celerctl (CH340)
};

void init() {
    s_display.init();
    // Arrays RGB565 padrao (icones, BMPs de apps JS) e o readRect (screencap)
    // exigem conversao de ordem de bytes: o barramento SPI envia MSB-first,
    // formato nativo 565 trocado (rgb565_2Byte do LovyanGFX). Sem isso o
    // pushImage copia cru e as cores saem trocadas no vidro.
    s_display.setSwapBytes(true);
}

CelerDisplay& display() {
    return s_display;
}

const BoardProfile& profile() {
    return s_profile;
}

}  // namespace Board
