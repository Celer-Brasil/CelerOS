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
    // Slot microSD da placa fisica: mesmo VSPI do TFT (SCK18/MOSI23/MISO19)
    // com CS=5 — compartilhar o bus exige o caminho multi-device do mount
    // (FileSystem.cpp), o mesmo da CYD classica, no host do display (SPI3).
    // Fica INATIVO enquanto CONFIG_CELEROS_SD_CARD=n (variante nao testada).
    .sd = {.cs = 5, .sck = 18, .miso = 19, .mosi = 23, .freqKhz = 10000, .spiHost = SPI3_HOST},
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
    .strips = {},  // sem fitas WS2812
    .watchGestures = true,  // bordas: ajustes rapidos / notificacoes / voltar
    // 1/3: UART0 (console/celerctl do CH340); 6..11: SPI flash do modulo.
    .gpioDeniedMask = (1ULL << 1) | (1ULL << 3) | (1ULL << 6) | (1ULL << 7) | (1ULL << 8) |
                      (1ULL << 9) | (1ULL << 10) | (1ULL << 11),
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
