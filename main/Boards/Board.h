#ifndef CELER_BOARDS_BOARD_H
#define CELER_BOARDS_BOARD_H

#include <stdint.h>
#include <time.h>  // struct tm dos hooks readRtc/writeRtc
#include "../Display/Display.h"
#include "BoardDisplay.h"  // resolve para main/Boards/<placa>/ (include path do CMake)

// ============================================================================
// HAL de placas do CelerOS.
//
// O build seleciona exatamente uma placa (-DCELEROS_BOARD=<smartdisplay|cyd>);
// o CMake compila Boards/<placa>/Board.cpp e coloca o diretorio no include
// path. Nenhum outro arquivo do firmware pode conter #ifdef de placa —
// caracteristicas diferentes vivem no BoardProfile abaixo.
// ============================================================================

struct SdConfig {
    int cs, sck, miso, mosi;
    int freqKhz;
    // Host SPI do slot (-1 = SPI2, o classico das placas RGB). Placas cujo
    // display toma o SPI2 (ex.: QSPI do watch) apontam o SPI3 aqui.
    int spiHost = -1;
};

// LED RGB de status (PWM). r < 0 = placa sem LED.
struct RgbLedPins {
    int r, g, b;
    bool activeLow;  // catodo no GPIO (acende em nivel baixo)
};

// Saida de audio digital I2S para amplificador na placa (NS4168 na
// SmartDisplay 4848S040: 16-bit stereo, sem MCLK; ES8311 do watch: 16 kHz
// com MCLK 256x). dout < 0 = sem I2S.
struct AudioI2sPins {
    int dout = -1;
    int bclk = -1;
    int lrc = -1;
    int mclk = -1;   // codec que precisa de MCLK do pino (ES8311: 4,096 MHz)
};

// Rele(s) da placa (linhas L1..L3 da SmartDisplay 4848S040 variante Y,
// que substituem o I2S: mesmos pinos). relayCount = 0 = sem reles.
struct RelayConfig {
    int count = 0;
    int pins[3] = {-1, -1, -1};  // L1, L2, L3 (ativa em nivel alto)
};

// Servos PWM 50 Hz (System.servo mapeia pin->canal LEDC). count = 0 = nenhum;
// pins < 0 = canal do perfil nao soldado (ex.: cauda opcional do cao robotico).
struct ServoPins {
    int count = 0;
    int pins[5] = {-1, -1, -1, -1, -1};
};

// Microfone digital I2S (RX, slot esquerdo). ws < 0 = sem microfone.
// ATENCAO (cao ZZPET): o pino do clock NUNCA pode ser usado como ADC —
// reconfigura-lo como canal analogico desconecta a matriz GPIO e mata o mic.
struct MicI2sPins {
    int ws = -1;
    int bck = -1;
    int din = -1;
};

// Fitas WS2812 (RMT, sem DMA). count = 0 = sem fitas.
struct LedStrips {
    int count = 0;
    int pins[2] = {-1, -1};
    int ledsPerStrip = 0;  // max 8 (RMT sem DMA: 24 simbolos por LED)
};

// Camera OV2640 no barramento DVP da placa (AI-Thinker ESP32-CAM). pin_xclk
// < 0 = placa sem camera. O LED de flash do sensor (quando ha) fica aqui
// para Camera.led()/scanQR({led}) — nao no struct led (e atuator do sensor,
// nao status da placa). Verificado no bring-up: pinos 34-39 sao input-only.
struct CameraPins {
    int pwdn = -1, reset = -1, xclk = -1;
    int siod = -1, sioc = -1;            // SCCB (I2C do sensor)
    int y9 = -1, y8 = -1, y7 = -1, y6 = -1, y5 = -1, y4 = -1, y3 = -1, y2 = -1;
    int vsync = -1, href = -1, pclk = -1;
    int flashLed = -1;                   // LED de flash branco (GPIO4 na AI-Thinker)
    bool present() const { return xclk >= 0; }
};

struct BoardProfile {
    const char* id;          // "smartdisplay_4in" / "cyd"
    const char* otaChannel;  // canal de updates (updates/<canal>/)
    const char* name;        // nome amigavel (shell/info)
    SdConfig sd;
    bool hasPsram;
    bool backlightPwm;       // brilho controlavel
    bool capacitiveTouch;    // sem calibracao interativa
    int speakerPin;          // buzzer passivo p/ System.beep (LEDC); -1 = nao ha
    int rotation;            // rotação fixa do painel no boot (0-3; CYD clássica = 3, landscape)
    RgbLedPins led;          // LED RGB (System.led); r < 0 = nao ha
    int lightSensorPin;      // LDR no ADC (System.lightLevel, brilho automatico); -1 = nao ha
    AudioI2sPins i2s;        // amplificador I2S (System.beep); dout < 0 = nao ha
    RelayConfig relay;       // reles da placa (System.relay); count = 0 = nao ha
    ServoPins servo;         // servos da placa (perfil p/ apps de robo); count = 0 = nao ha
    MicI2sPins mic;          // microfone I2S (System.micLevel); ws < 0 = nao ha
    LedStrips strips;        // fitas WS2812 (System.neopixel); count = 0 = nao ha
    CameraPins camera = {};  // sensor OV2640 (Camera.*, API 35); vazio = nao ha
    int batteryPin = -1;     // divisor de bateria no ADC (System.battery); -1 = nao ha
    int batteryScalePct = 100;  // mV da bateria = mV no pino * scale / 100 (divisor 2:1 = 200)
    int touchPad = -1;       // pad capacitivo avulso (System.touchPad); -1 = nao ha
    // Hooks de hardware opcional da placa (nullptr = nao ha). Padrao usado
    // pelos campos acima: diferenca de placa vive no perfil, nunca em #ifdef.
    bool (*readRtc)(struct tm&) = nullptr;        // RTC externo (PCF85063)
    bool (*writeRtc)(const struct tm&) = nullptr; // gravar apos NTP/manual
    bool (*readBatteryMv)(int* mv) = nullptr;     // bateria por PMU (AXP2101),
                                                  // antes do caminho ADC
    int (*readBatteryPct)() = nullptr;            // fuel gauge 0..100 (-1 = falhou);
                                                  // nullptr = estima pela curva LiPo
    int (*readChargeState)() = nullptr;           // bit0 carregando, bit1 USB,
                                                  // bit2 cheia (-1 = falhou)
    // Botoes fisicos (ativo-baixo, pull-up; -1 = nao ha). Comportamento
    // padrao (buttonToApp = false): botao 1, curto = home/encerra app,
    // segurar ~1,2 s = screenshot; botao 2 acorda a tela. Com buttonToApp
    // (devkit headless), o botao 1 e input do app: curto/longo ficam
    // disponiveis em System.button() (latch consumido pelo JS) e segurar
    // ~1,2 s sai do app; no launcher, curto relanca o homeApp.
    int buttonPin = -1;
    int buttonPin2 = -1;
    bool (*raisePoll)() = nullptr;                // gesto "levantar o pulso"
                                                  // (consumivel: true 1x/gesto)
    // Sono REAL do painel (ScreenPower): SLPIN/SLPOUT do AMOLED do watch.
    // screenSleep != nullptr liga a maquina de estados de tela (dim/AOD/off).
    void (*screenSleep)() = nullptr;
    void (*screenWake)() = nullptr;
    // IMU (Sensors.* do runtime JS, API 13). imuAccel != nullptr marca
    // "tem IMU" no getInfo().
    bool (*imuAccel)(float* x, float* y, float* z) = nullptr;  // cache, em g
    int32_t (*imuSteps)() = nullptr;                           // passos do dia
    // dias fechados, mais recente 1o (yyyymmdd + passos); devolve quantos
    int (*imuStepHistory)(int32_t* days, int32_t* counts, int max) = nullptr;
    bool (*imuTemp)(float* c) = nullptr;                       // die, °C
    // Audio com codec I2C (ES8311 do watch): wake/sleep em volta do tom
    // (o codec dorme de verdade entre beeps) + PA do amp.
    int audioPaPin = -1;
    bool (*audioCodecWake)() = nullptr;
    void (*audioCodecSleep)() = nullptr;
    // Codec de CAPTURA (ES7210 do watch: o mic dual; o ES8311 e so DAC).
    // Wake em volta de cada gravacao/micLevel — a mesma disciplina do
    // audioCodecWake com os beeps. nullptr = mic MEMS sempre ligado (cao).
    bool (*micCodecWake)() = nullptr;
    void (*micCodecSleep)() = nullptr;
    // Ritual pre-deep-sleep da placa (persistir estado, desligar IMU...).
    void (*sleepPrep)() = nullptr;
    // Tecla de power no PMU (watch: PEK do AXP2101, sem pino INT — poll).
    // 0 = nada, 1 = toque curto, 2 = segurar.
    int (*pmuKeyPoll)() = nullptr;
    // Recorte dos cantos do vidro (px fisicos; 0 = vidro retangular):
    // afasta relogio/glyphs da barra de status e o X da topbar da zona morta
    // dos cantos arredondados (watch).
    int screenInset = 0;
    // Gestos de relogio (API 15): borda de cima puxa os Ajustes rapidos,
    // borda de baixo a central de notificacoes, borda esquerda sai do app JS.
    bool watchGestures = false;
    // Launcher em lista vertical (icone + nome, rolagem continua) em vez da
    // grade paginada: telas pequenas/estreitas como o watch.
    bool launcherList = false;
    // Energia (API 15, Hardware/PowerPolicy): DFS + light sleep automatico
    // com a tela apagada (exige CONFIG_PM_ENABLE no sdkconfig da placa) e
    // minutos de tela apagada ate o WiFi ocioso desligar (0 = nunca).
    bool autoLightSleep = false;
    int wifiSleepMin = 0;
    // INT do IMU ligada a um GPIO RTC (ativo-baixo): acorda do deep sleep
    // com movimento quando o ajuste "imu_wake" = 1. -1 = nao ha.
    int imuWakePin = -1;
    // Sentinela ULP do deep sleep (watch, ulp/ulp_main.c): o coprocessador
    // vigia o que so ele alcanca com os nucleos dormindo. ulpArm entra no
    // ritual do deep sleep (apos sleepPrep); retorna 0 se nao armou, bit0 =
    // armada, bit1 = o ULP cuida do wake por movimento (a INT1 sai do EXT1,
    // que acordava cru em qualquer esbarrão). ulpWake consome o motivo do
    // wake no primeiro tick pos-boot: 1 = tecla (PEK), 2 = raise, 3 =
    // bateria fraca, 4 = cabo plugado — 1/2/4 devem acender a tela.
    // nullptr = placa sem ULP.
    int (*ulpArm)() = nullptr;
    int (*ulpWake)() = nullptr;
    // App que abre sozinho no boot (ex.: a cara do cao robotico). nullptr =
    // launcher normal. /local/autostart.txt tem precedencia sobre este campo.
    const char* homeApp = nullptr;
    // Placa sem vidro (devkit barebone): o painel e um stub que descarta os
    // flush (BoardDisplay.h). Pula o splash do boot e marca hasDisplay=false
    // / shape="headless" no getInfo() dos apps JS.
    bool headless = false;
    // Botao 1 e input do app em vez de "home" (devkit headless): curto/longo
    // chegam via System.button(), segurar ~1,2 s sai do app; no launcher, o
    // curto relanca o homeApp (o device nunca fica preso no launcher).
    bool buttonToApp = false;
    // GPIOs que o requirePin recusa alem dos strapping/USB (esp_gpio_is_reserved
    // nao conhece o modo da PSRAM nem o console): no ESP32-S3 com PSRAM OCTAL
    // (modulo N16R8, ex. 4848S040) GPIO33..37 sao as linhas DQ4..7/DQS — um PWM
    // ali corrompe a PSRAM (onde vive o heap do runtime JS); os pinos da UART0
    // (43/44 no S3, 1/3 no ESP32) matam o console/celerctl. Bit n = GPIO n.
    uint64_t gpioDeniedMask = 0;
};

// Display concreto da placa (BoardDisplay, de Boards/<placa>/BoardDisplay.h).
using CelerDisplay = BoardDisplay;

namespace Board {

// Inicializa o display da placa (chamar uma vez no boot, antes da UI).
void init();

// Display global (valido apos init(); a instancia vive no Board.cpp da placa)
CelerDisplay& display();

const BoardProfile& profile();

}  // namespace Board

#endif  // CELER_BOARDS_BOARD_H
