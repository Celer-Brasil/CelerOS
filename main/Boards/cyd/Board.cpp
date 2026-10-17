#include "Boards/Board.h"

// Perfil da CYD classica (ESP32-2432S028R witnessmenow): TFT no HSPI nativo,
// touch XPT2046 em pinos dedicados, backlight GPIO21. Variante testada.

namespace {
BoardDisplay s_display;
}  // namespace

namespace Board {

static const BoardProfile s_profile = {
    .id = "cyd",
    .otaChannel = "esp32",
    .name = "cyd (ESP32-2432S028R classica)",
    // Slot microSD desta variante fica no MESMO HSPI do TFT (CS=5): funciona
    // em bus compartilhado — o display (LovyanGFX) inicializa o host e o
    // mount do SD anexa um segundo dispositivo; o lock do driver IDF
    // serializa as transferencias (video x cartao). 10MHz e conservador para
    // as trilhas compartilhadas da placa; FAT/SPI a essa freq ja e mais
    // rapido que o flash interno em escrita.
    .sd = {.cs = 5, .sck = 14, .miso = 12, .mosi = 13, .freqKhz = 10000},
    .hasPsram = false,
    .backlightPwm = true,   // GPIO22 via Light_PWM (antes era fixo 100%)
    .capacitiveTouch = false,
    .speakerPin = 26,  // saida de audio (amplificador SC8002B -> conector do alto-falante)
    .rotation = 3,     // vidro landscape 320x240 (varredura de sonda confirmou R3)
    .led = {4, 16, 17, true},  // LED RGB no verso: R=4, G=16, B=17, acende em nivel baixo
    .lightSensorPin = 34,      // LDR ao lado da tela (ADC1_CH6)
    .i2s = {-1, -1, -1},       // alto-falante e analogico (speakerPin acima)
    .relay = {},
    .servo = {},
    .mic = {},
    .strips = {},               // sem fitas WS2812
    .watchGestures = true,  // bordas: ajustes rapidos / notificacoes / voltar
    // 1/3: UART0 (console/celerctl do CH340); 6..11: SPI flash do modulo
    // (o IDF ja reserva no boot, mas o perfil documenta e cobre um boot
    // atipico — nunca sao GPIO de app).
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
