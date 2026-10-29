#include "Boards/Board.h"
#include "Axp2101.h"
#include "Pcf85063.h"
#include "Es8311.h"
#include "Es7210.h"
#include "Motion.h"
#include "WatchUlp.h"
#include "Hardware/BoardIO.h"
#include "esp_attr.h"

// Latch do INT do touch FT3168 (Display/Touch_FT3168_IDF.h): definicao unica
namespace lgfx {
inline namespace v1 {
DRAM_ATTR volatile bool g_ft3168IntFlag = true;
void IRAM_ATTR ft3168IntIsr(void*) { g_ft3168IntFlag = true; }
}  // namespace v1
}  // namespace lgfx

// Smartwatch Waveshare ESP32-S3-Touch-AMOLED-2.06: ESP32-S3R8 (8MB PSRAM
// octal, 32MB flash), AMOLED 410x502 CO5300 em QSPI, PMU AXP2101, touch
// FT3168, RTC PCF85063 e IMU QMI8658 no mesmo I2C0, audio ES8311 e SD em
// SPI3. Pinout e sequencias portados do firmware Rust do watch
// (waveshare-watch-rs, src/board.rs).

namespace {
BoardDisplay s_display;
}  // namespace

namespace Board {

static const BoardProfile s_profile = {
    .id = "waveshare-amoled206",
    .otaChannel = "waveshare_amoled206",
    .name = "smartwatch Waveshare AMOLED 2.06 (ESP32-S3R8)",
    .sd = {.cs = 17, .sck = 2, .miso = 3, .mosi = 1, .freqKhz = 4000, .spiHost = SPI3_HOST},
    .hasPsram = true,        // 8MB octal embutida no S3R8
    .backlightPwm = true,    // brilho = WRDISBV do painel AMOLED (DCS 0x51)
    .capacitiveTouch = true, // FT3168, sem calibracao interativa
    .speakerPin = -1,        // audio e ES8311+I2S0 (campo i2s abaixo)
    .rotation = 0,           // painel ja e portrait 410x502
    .led = {-1, -1, -1, false},
    .lightSensorPin = -1,
    .i2s = {.dout = 40, .bclk = 41, .lrc = 45, .mclk = 16},  // ES8311: 16 kHz, MCLK 4,096 MHz
    .relay = {},
    .servo = {},
    // Microfone = ADC do ES8311 (ASDOUT GPIO42): o canal I2S1 do micLevel
    // e master nos mesmos clocks do codec (MCLK pelo campo i2s.mclk acima).
    .mic = {.ws = 45, .bck = 41, .din = 42},
    .strips = {},
    .batteryPin = -1,        // bateria vem do AXP2101 pelo hook abaixo
    .batteryScalePct = 100,
    .touchPad = -1,
    .readRtc = Pcf85063::read,        // hora sobrevive a reboot sem rede
    .writeRtc = Pcf85063::write,      // gravado apos NTP/ajuste manual/fuso
    .readBatteryMv = Axp2101::readBatteryMv,
    .readBatteryPct = Axp2101::readBatteryPct,
    .readChargeState = Axp2101::readChargeState,
    .buttonPin = 0,     // BOOT: curto = home/encerra app; segurar = screenshot
    .buttonPin2 = -1,   // GPIO10 le LOW com pull-up nesta HW (nao e botao):
                        // o PWR do watch fala com o AXP2101 direto (poll
                        // da PEK pelo hook pmuKeyPoll abaixo)
    .raisePoll = Motion::raisePoll,   // raise-to-wake (consumido pelo ScreenPower)
    .screenSleep = []() { s_display.panelSleep(); },   // SLPIN do AMOLED
    .screenWake  = []() { s_display.panelWakeup(); },  // SLPOUT (GRAM intacta)
    .imuAccel = Motion::accel,   // Sensors.accel() — cache da task
    .imuSteps = Motion::steps,   // Sensors.steps() — pedometro do dia
    .imuStepHistory = Motion::stepHistory,  // Sensors.stepHistory() (API 15)
    .imuTemp  = Motion::temp,    // Sensors.temp() — die do QMI8658
    .audioPaPin = 46,            // amp PA: alto so durante o beep
    .audioCodecWake = []() {
        return Es8311::init() && Es8311::unmuteVolume(BoardIO::volumePct());
    },
    .audioCodecSleep = []() { Es8311::shutdown(); },
    // Captura: o mic dual e o ES7210 (o ES8311 e so DAC) — dado no GPIO42
    .micCodecWake = []() { return Es7210::init(); },
    .micCodecSleep = []() { Es7210::shutdown(); },
    .sleepPrep = []() { Motion::prepareSleep(); },  // passos no NVS + IMU off
    .pmuKeyPoll = Axp2101::pollPowerKey,  // PWR fisico do watch (via PMU)
    .screenInset = 40,   // cantos arredondados: afasta relogio/X da zona morta
    .watchGestures = true,  // bordas: ajustes rapidos / notificacoes / voltar
    .launcherList = true,   // apps em lista vertical (icone + nome)
    .autoLightSleep = true,  // DFS + light sleep com a tela apagada (PowerPolicy)
    .wifiSleepMin = 10,      // WiFi ocioso cai apos 10 min de tela apagada
    .imuWakePin = 21,        // INT1 do QMI8658 (AnyMotion, ativo-baixo)
    .ulpArm = WatchUlp::arm,   // sentinela ULP no deep sleep: PEK acorda,
    .ulpWake = WatchUlp::wake, // raise filtrado e VBAT (ulp/ulp_main.c)
    .homeApp = "celeros.watchface",  // o relogio e a casa do watch
    // Nada do que a placa ja usa vira GPIO de app (requirePin/GpioRes/SensorRes
    // recusam): 1/2/3/17: SD em SPI3 (cs/sck/miso/mosi); 4..8/11/12: painel
    // AMOLED QSPI (SDIO0..3, RST, SCLK, CS); 14/15: I2C0 do touch FT3168, do
    // PMU AXP2101, do RTC PCF85063 e do IMU QMI8658 (um app reconfigurando-o
    // derruba os quatro); 16: MCLK do codec (ES8311/ES7210); 19/20: USB OTG
    // nativo (CDC do celerctl); 40/41/45: I2S do audio (ES8311), 42: ASDOUT
    // do mic, 46: PA do amp; 43/44: UART0 de fallback; 33..37: DQ4..7/DQS da
    // PSRAM octal (S3R8).
    .gpioDeniedMask = (1ULL << 1) | (1ULL << 2) | (1ULL << 3) | (1ULL << 4) |
                      (1ULL << 5) | (1ULL << 6) | (1ULL << 7) | (1ULL << 8) |
                      (1ULL << 11) | (1ULL << 12) | (1ULL << 14) | (1ULL << 15) |
                      (1ULL << 16) | (1ULL << 17) | (1ULL << 19) | (1ULL << 20) |
                      0x3E00000000ULL | (1ULL << 40) | (1ULL << 41) | (1ULL << 42) |
                      (1ULL << 43) | (1ULL << 44) | (1ULL << 45) | (1ULL << 46),
};

void init() {
    // Trilhos do PMU antes de tudo: sem DCDC1/ALDO1 em 3,3V o AMOLED fica
    // preto mesmo inicializado (o AXP2101 solta o bus I2C ao terminar; o
    // driver do touch abre o dele em seguida).
    Axp2101::enableDisplayRails(GPIO_NUM_15, GPIO_NUM_14);
    s_display.init();
    s_display.setSwapBytes(true);
    // Framebuffer na PSRAM (~402 KB): o CO5300 so escreve janelas alinhadas
    // a par e nao tem readback — o FB resolve os dois (+readRect/screencap).
    s_display.enableFrameBuffer(true);
    // IMU (pedometro + raise): task propria no bus I2C compartilhado.
    Motion::start();
    // Tecla de power (PEK do AXP2101): poll pelo ScreenPower
    Axp2101::initPek();
    Axp2101::initGauge();  // percent da bateria (System.batteryInfo)
}

CelerDisplay& display() {
    return s_display;
}

const BoardProfile& profile() {
    return s_profile;
}

}  // namespace Board
