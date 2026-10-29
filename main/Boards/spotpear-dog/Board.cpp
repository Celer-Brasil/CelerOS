#include "Boards/Board.h"
#include "DogUlp.h"
#include "../../Hardware/BoardIO.h"  // speakerChannel no boot (mesma forma da smartdisplay)

// Cao robotico SpotBear/ZZPET (ESP32-S3-Ai-Dog-(A), SKU zzpet-s3): ESP32-S3R8
// (8MB PSRAM octal EMBUTIDA — o anuncio diz "S3R2" mas o chip reporta R8),
// flash 16MB, OLED SH1106 na cara, 4 servos de perna (+canal de cauda vazio),
// microfone I2S, alto-falante I2S, 2 fitas WS2812, pad capacitivo e divisor
// de bateria. Pinout completo extraido via JTAG — ver repo maikramer/zzpet-s3-dog.

namespace {
BoardDisplay s_display;
}  // namespace

namespace Board {

static const BoardProfile s_profile = {
    .id = "spotpear-dog",
    .otaChannel = "spotpear_zzpet",
    .name = "cao robotico SpotBear/ZZPET (ESP32-S3R8)",
    .sd = {.cs = -1, .sck = -1, .miso = -1, .mosi = -1, .freqKhz = 0},
    .hasPsram = true,        // 8MB octal embutida no S3R8
    .backlightPwm = false,   // contraste via setBrightness do proprio painel
    .capacitiveTouch = true, // sem calibracao interativa (nao ha touchscreen)
    .speakerPin = -1,        // audio e digital: I2S0 abaixo
    .rotation = 3,           // bring-up: vidro girado + 180 (validado na HW)
    .led = {-1, -1, -1, false},   // sem LED RGB avulso (fitas WS2812 abaixo)
    .lightSensorPin = -1,
    .i2s = {.dout = 7, .bclk = 15, .lrc = 16},   // amp classe D, 16 kHz mono
    .relay = {},
    // Pernas: GPIO14=tras-dir, 17=frente-esq, 12=cauda (NAO SOLDADA nesta
    // unidade — o firmware do vendor trata "sem cauda" como caso normal),
    // 13=frente-dir, 18=tras-esq. 1500 us = pe de boa.
    .servo = {.count = 5, .pins = {14, 17, 12, 13, 18}},
    // Microfone I2S1 RX (slot esquerdo). GPIO4 = clock: nunca usar como ADC.
    .mic = {.ws = 4, .bck = 5, .din = 6},
    // Fitas WS2812: corpo (GPIO8) e segunda fita (GPIO48), 4 LEDs cada.
    .strips = {.count = 2, .pins = {8, 48}, .ledsPerStrip = 4},
    .batteryPin = 2,   // divisor 2:1 no ADC1_CH1 (~2066 mV no pino sob USB)
    .batteryScalePct = 200,  // System.battery() devolve a tensao da celula
    .touchPad = 10,    // pad capacitivo: 1 toque = tap, segurar = hold
    .ulpArm = DogUlp::arm,  // watchdog de bateria por ULP no deep sleep
    .homeApp = "celeros.dogface",  // a cara do cao e a casa do robô
    // 4/5/6: I2S1 RX do microfone (4 e o clock — reconfigura-lo como ADC
    // desconecta a matriz GPIO e mata o mic, ver Board.h); 7/15/16: I2S do
    // alto-falante (dout/bclk/lrc); 19/20: USJ do console/celerctl; 41/42:
    // I2C0 do OLED SH1106. 33..37: DQ4..7/DQS da PSRAM octal (S3R8). Servos,
    // fitas e pad de toque NAO entram (têm API JS nativa que divide o pino).
    .gpioDeniedMask = 0x3E00000000ULL | (1ULL << 4) | (1ULL << 5) | (1ULL << 6) |
                      (1ULL << 7) | (1ULL << 15) | (1ULL << 16) |
                      (1ULL << 19) | (1ULL << 20) | (1ULL << 41) | (1ULL << 42),
};

void init() {
    // Wake do watchdog ULP (bateria fraca no deep sleep): log cedo — a cara
    // do cao mostra o estado da celula e o celerctl logcat ve o motivo.
    DogUlp::wake();
    s_display.init();
    // Painel 1-bit monochromo: sem conversao RGB565 (nada a trocar).
    // Canal do alto-falante NASCE AQUI (persistente): criado lazy no 1o som
    // podia perder a disputa de RAM interna (~3,8 KB de DMA) para o NimBLE
    // recem-conectado e o cao ficava MUDO ate o reboot (bancada 2026-10-05:
    // i2s_alloc_dma_desc failed com o Remote pareado). No boot a interna
    // esta na melhor faixa livre do ciclo.
    BoardIO::speakerChannel(16000);
}

CelerDisplay& display() {
    return s_display;
}

const BoardProfile& profile() {
    return s_profile;
}

}  // namespace Board
