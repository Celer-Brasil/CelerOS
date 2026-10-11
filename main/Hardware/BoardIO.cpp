#include "BoardIO.h"
#include "AudioPlayer.h"

#include <Arduino.h>
#include <math.h>
#include "../Boards/Board.h"
#include "../Utils/CelerSettings.h"
#include "driver/i2s_std.h"
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/rmt_tx.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "driver/touch_sens.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "soc/soc_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "mbedtls/base64.h"
#include "../USBDevice/LogSink.h"
#include "esp_heap_caps.h"

namespace BoardIO {

namespace {
constexpr ledc_mode_t kMode = LEDC_LOW_SPEED_MODE;
constexpr ledc_timer_t kLedTimer = LEDC_TIMER_1;
constexpr ledc_channel_t kLedCh[3] = {LEDC_CHANNEL_3, LEDC_CHANNEL_4, LEDC_CHANNEL_5};
constexpr ledc_timer_t kToneTimer = LEDC_TIMER_2;
constexpr ledc_channel_t kToneCh = LEDC_CHANNEL_6;

bool s_ledReady = false;

bool ledInit() {
    if (s_ledReady) return true;
    const RgbLedPins& p = Board::profile().led;
    if (p.r < 0) return false;
    ledc_timer_config_t tim = {};
    tim.speed_mode = kMode;
    tim.timer_num = kLedTimer;
    tim.duty_resolution = LEDC_TIMER_8_BIT;
    tim.freq_hz = 5000;  // mesmo do timer 1 do analogWrite (canais 2..3 compartilham)
    tim.clk_cfg = LEDC_AUTO_CLK;
    if (ledc_timer_config(&tim) != ESP_OK) return false;
    const int pins[3] = {p.r, p.g, p.b};
    int configured = 0;
    for (int i = 0; i < 3; i++) {
        if (pins[i] < 0) continue;  // LED de canal unico (devkit): g/b fora da placa
        ledc_channel_config_t ch = {};
        ch.speed_mode = kMode;
        ch.channel = kLedCh[i];
        ch.timer_sel = kLedTimer;
        ch.gpio_num = pins[i];
        ch.duty = p.activeLow ? 255 : 0;  // apagado
        if (ledc_channel_config(&ch) != ESP_OK) return false;
        configured++;
    }
    s_ledReady = configured > 0;
    return s_ledReady;
}
}  // namespace

bool hasLed() { return Board::profile().led.r >= 0; }

void setLed(uint8_t r, uint8_t g, uint8_t b) {
    if (!ledInit()) return;
    const bool inv = Board::profile().led.activeLow;
    const RgbLedPins& p = Board::profile().led;
    const uint8_t v[3] = {r, g, b};
    const int pins[3] = {p.r, p.g, p.b};
    for (int i = 0; i < 3; i++) {
        if (pins[i] < 0) continue;  // canal fora da placa (LED mono-canal)
        uint32_t duty = inv ? (uint32_t)(255 - v[i]) : v[i];
        ledc_set_duty(kMode, kLedCh[i], duty);
        ledc_update_duty(kMode, kLedCh[i]);
    }
}

void ledOff() {
    if (s_ledReady) setLed(0, 0, 0);
}

bool hasLightSensor() { return Board::profile().lightSensorPin >= 0; }

int lightRaw() {
    const int pin = Board::profile().lightSensorPin;
    if (pin < 0) return -1;
    int sum = 0;
    // 0dB: o LDR da ~0..1V; a 12dB (analogRead) ficava todo no piso do ADC
    for (int i = 0; i < 8; i++) sum += analogReadAtten(pin, 0);  // ADC ruidoso: media
    return sum / 8;
}

int lightLevel() {
    const int raw = lightRaw();
    if (raw < 0) return -1;
    // LDR da CYD: a tensao SOBE no escuro. Medido na placa a 0dB: 0 com a
    // sala iluminada, ~400 com o sensor tampado. Tudo acima de kDark = 0%.
    constexpr int kDark = 400;
    int v = raw > kDark ? kDark : raw;
    return 100 - v * 100 / kDark;
}

bool hasSpeaker() {
    return Board::profile().speakerPin >= 0 || Board::profile().i2s.dout >= 0;
}

namespace {
// Tom I2S: senoide de 256 amostras de 16 bits (amplitude ~0.6, alto e nitido
// sem estourar) + bloco de 512 quadros estereo. Os dois vivem no heap so
// durante o tom (2,5KB que ficavam estaticos na RAM interna — inclusive nas
// placas sem I2S); gerar a tabela custa ~256 sinf por tom, nada perto do DMA.
constexpr int kSineLen = 256;
constexpr uint32_t kToneBlock = 512;

// Tom via amplificador digital I2S (NS4168 na SmartDisplay: 44,1 kHz sem
// MCLK; ES8311 do watch: 16 kHz com MCLK 256x e codec no I2C — wake/sleep
// em volta do tom, PA so durante a transmissao). Aloca o canal, transmite
// a senoide pelo tempo pedido e devolve os pinos ao GPIO matrix.
static bool toneI2sOut(int freqHz, int ms);

// Guarda de saida do AudioPlayer: o I2S0 e UM so (no cao, canal persistente
// compartilhado). Tom no meio de uma fala ao vivo do AI.speak (worker) ou de
// um playWav reconfigurava o clock do canal enquanto a outra task escrevia
// nele — voz distorcida/driver em estado invalido. Ocupado: o tom e pulado
// (os bipes sao melhor esforco; o chamador ja trata false).
bool toneI2s(int freqHz, int ms) {
    if (!AudioPlayer::acquireOutput()) return false;
    const bool ok = toneI2sOut(freqHz, ms);
    AudioPlayer::releaseOutput();
    return ok;
}

static bool toneI2sOut(int freqHz, int ms) {
    const BoardProfile& bp = Board::profile();
    const AudioI2sPins& p = bp.i2s;
    const bool hasCodec = bp.audioCodecWake != nullptr;
    const uint32_t kSampleRate = hasCodec ? 16000 : 44100;  // ES8311: 16 kHz
    if (freqHz >= (int)kSampleRate / 2) return false;
    // Placa com codec: gravacao em curso tem prioridade sobre o som. O canal
    // do tom (I2S0) COMPARTILHA bclk/ws/mclk com o canal do mic (I2S1) —
    // criar e destruir o I2S0 deixa os pinos soltos no GPIO matrix e mata o
    // clock do gravador no meio da captura, e o sleep do codec apos o tom
    // derruba o ADC (bancada 2026-10-02). No cao (MEMS em pinos proprios) o
    // tom segue normal.
    if (hasCodec && micRecActive()) return false;

    // Sem codec o canal e PERSISTENTE (speakerChannel): o amp dessas placas
    // nao tem pino de enable e so descansa frio recebendo silencio com os
    // clocks correndo. Com codec, o canal nasce por som e morre no fim
    // (clocks emprestados do I2S1 do mic + micPinsDirty no teardown).
    i2s_chan_handle_t tx = nullptr;
    bool txKeep = false;  // canal persistente: fica ligado no silencio no fim
    if (hasCodec) {
        i2s_chan_config_t chanCfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
        // I2S_NUM_0 fixo: o I2S1 fica reservado ao microfone (BoardIO::micLevel
        // mantem um canal RX persistente la — NUM_AUTO podia rouba-lo).
        chanCfg.auto_clear = true;  // DMA manda silencio apos o ultimo bloco
        // DMA enxuto: idem AudioPlayer — o default de 6 descritores falha em
        // "allocate DMA buffer failed" com a RAM interna apertada (bancada)
        chanCfg.dma_desc_num = 4;
        if (i2s_new_channel(&chanCfg, &tx, nullptr) != ESP_OK) return false;

        i2s_std_config_t stdCfg = {};
        stdCfg.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(kSampleRate);
        stdCfg.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
        stdCfg.gpio_cfg.mclk = p.mclk >= 0 ? (gpio_num_t)p.mclk : I2S_GPIO_UNUSED;  // ES8311: 256x fs
        stdCfg.gpio_cfg.bclk = (gpio_num_t)p.bclk;
        stdCfg.gpio_cfg.ws = (gpio_num_t)p.lrc;
        stdCfg.gpio_cfg.dout = (gpio_num_t)p.dout;
        stdCfg.gpio_cfg.din = I2S_GPIO_UNUSED;
        if (i2s_channel_init_std_mode(tx, &stdCfg) != ESP_OK || i2s_channel_enable(tx) != ESP_OK) {
            i2s_del_channel(tx);
            return false;
        }
    } else {
        tx = speakerChannel((int)kSampleRate);
        if (tx == nullptr) return false;
        txKeep = true;
    }

    // Codec no I2C (ES8311): acorda, PA sobe, toca, PA desce, dorme
    if (hasCodec) bp.audioCodecWake();
    if (bp.audioPaPin >= 0) {
        pinMode(bp.audioPaPin, OUTPUT);
        digitalWrite(bp.audioPaPin, HIGH);
        delay(2);  // PA estabiliza antes do primeiro sample
    }

    // estereo L/R duplicado (amp mono) + tabela, num bloco so
    int16_t* frames = (int16_t*)malloc(kToneBlock * 2 * sizeof(int16_t) + kSineLen * sizeof(int16_t));
    if (frames != nullptr) {
        // tabela ja com o volume aplicado (escala digital; o codec tambem
        // tem registrador): o laco por amostra fica so com a busca
        int16_t* sine = frames + kToneBlock * 2;
        const int vol = volumePct();
        for (int i = 0; i < kSineLen; i++) {
            sine[i] = (int16_t)((int32_t)(sinf(i * 6.2831853f / kSineLen) * 20000.0f) * vol / 100);
        }
        // Fase em Q16.16 sobre a tabela de 256 amostras.
        const uint32_t step = (uint32_t)(((uint64_t)freqHz << 24) / kSampleRate);
        uint32_t phase = 0;
        const uint32_t framesNeeded = (uint32_t)(((uint64_t)ms * kSampleRate) / 1000);
        uint32_t sent = 0;
        while (sent < framesNeeded) {
            uint32_t n = framesNeeded - sent;
            if (n > kToneBlock) n = kToneBlock;
            for (uint32_t i = 0; i < n; i++) {
                phase += step;
                const int16_t s = sine[(phase >> 16) & 0xFF];
                frames[i * 2] = s;
                frames[i * 2 + 1] = s;
            }
            size_t written = 0;
            i2s_channel_write(tx, frames, n * 2 * sizeof(int16_t), &written, portMAX_DELAY);
            AudioPlayer::feedWatchdog();  // celerbeep nao e inscrita
            sent += n;
        }
        free(frames);
    }
    if (bp.audioPaPin >= 0) digitalWrite(bp.audioPaPin, LOW);
    if (hasCodec) bp.audioCodecSleep();
    if (txKeep) return true;  // persistente: auto_clear segue mandando silencio
    i2s_channel_disable(tx);
    i2s_del_channel(tx);
    speakerPinsPark();
    if (hasCodec) micPinsDirty();  // pins do I2S1 voltam mortos
    return true;
}
}  // namespace

bool tone(int freqHz, int ms) {
    const int pin = Board::profile().speakerPin;
    if (pin < 0 && Board::profile().i2s.dout < 0) return false;
    if (freqHz < 20 || freqHz > 20000 || ms <= 0 || ms > 5000) return false;
    // Serializa contra a task de beep e outros chamadores (o canal I2S e o
    // timer LEDC do tom nao admitem dois donos simultaneos)
    static StaticSemaphore_t sToneMuBuf;
    static SemaphoreHandle_t sToneMu = xSemaphoreCreateMutexStatic(&sToneMuBuf);
    if (xSemaphoreTake(sToneMu, pdMS_TO_TICKS(10000)) != pdTRUE) return false;
    bool ok;
    if (pin < 0) {
        ok = toneI2s(freqHz, ms);
    } else {
        ledc_timer_config_t tim = {};
        tim.speed_mode = kMode;
        tim.timer_num = kToneTimer;
        tim.duty_resolution = LEDC_TIMER_10_BIT;
        tim.freq_hz = (uint32_t)freqHz;
        tim.clk_cfg = LEDC_AUTO_CLK;
        if (ledc_timer_config(&tim) != ESP_OK) {
            xSemaphoreGive(sToneMu);
            return false;
        }
        ledc_channel_config_t ch = {};
        ch.speed_mode = kMode;
        ch.channel = kToneCh;
        ch.timer_sel = kToneTimer;
        ch.gpio_num = pin;
        ch.duty = 512;  // onda quadrada 50%
        if (ledc_channel_config(&ch) != ESP_OK) {
            xSemaphoreGive(sToneMu);
            return false;
        }
        const uint32_t t0 = millis();
        while ((int)(millis() - t0) < ms) {
            AudioPlayer::feedWatchdog();
            delay(10);
        }
        ledc_stop(kMode, kToneCh, 0);
        ok = true;
    }
    xSemaphoreGive(sToneMu);
    return ok;
}

// ---- beep assincrono (UI nao trava tocando) ----

namespace {
constexpr int kBeepQLen = 8;
struct BeepItem { int freq; int ms; int gap; };
BeepItem s_beepQ[kBeepQLen];
int s_beepHead = 0, s_beepTail = 0;
StaticSemaphore_t sBeepMuBuf;
SemaphoreHandle_t sBeepMu = nullptr;
TaskHandle_t s_beepTask = nullptr;

SemaphoreHandle_t beepMu() {
    if (!sBeepMu) sBeepMu = xSemaphoreCreateMutexStatic(&sBeepMuBuf);
    return sBeepMu;
}

// Dorme em task notification entre rajadas: nenhum wakeup periodico que
// impediria o light sleep do watch. Consome a fila inteira a cada acordar.
void beepTaskFunc(void*) {
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        for (;;) {
            BeepItem it;
            bool has = false;
            xSemaphoreTake(beepMu(), portMAX_DELAY);
            if (s_beepHead != s_beepTail) {
                it = s_beepQ[s_beepHead];
                s_beepHead = (s_beepHead + 1) % kBeepQLen;
                has = true;
            }
            xSemaphoreGive(beepMu());
            if (!has) break;
            tone(it.freq, it.ms);
            if (it.gap > 0) vTaskDelay(pdMS_TO_TICKS(it.gap));
        }
    }
}
}  // namespace

void toneAsync(int freqHz, int ms, int gapMs) {
    if (freqHz < 20 || freqHz > 20000 || ms <= 0 || ms > 5000) return;
    xSemaphoreTake(beepMu(), portMAX_DELAY);
    if (s_beepTask == nullptr) {  // criacao sob o lock: sem janela de task dupla
        if (xTaskCreate(beepTaskFunc, "celerbeep", 4096, nullptr, 2, &s_beepTask) != pdPASS) {
            s_beepTask = nullptr;
            xSemaphoreGive(beepMu());
            return;
        }
    }
    const int next = (s_beepTail + 1) % kBeepQLen;
    if (next != s_beepHead) {  // fila cheia: descarta (beep e best-effort)
        s_beepQ[s_beepTail] = {freqHz, ms, gapMs};
        s_beepTail = next;
    }
    xSemaphoreGive(beepMu());
    xTaskNotifyGive(s_beepTask);
}

void toneStop() {
    if (sBeepMu == nullptr) return;
    xSemaphoreTake(beepMu(), portMAX_DELAY);
    s_beepHead = s_beepTail = 0;
    xSemaphoreGive(beepMu());
}

// ---- reles ----

namespace {
bool s_relayInit = false;
bool s_relayState[3] = {false, false, false};
}  // namespace

void initRelays() {
    const RelayConfig& r = Board::profile().relay;
    if (s_relayInit || r.count <= 0) return;
    for (int i = 0; i < r.count && i < 3; i++) {
        pinMode(r.pins[i], OUTPUT);
        digitalWrite(r.pins[i], LOW);  // desligado no boot, como no demo do fab.
        s_relayState[i] = false;
    }
    s_relayInit = true;
}

int relayCount() {
    return Board::profile().relay.count;
}

bool setRelay(int n, bool on) {
    const RelayConfig& r = Board::profile().relay;
    if (n < 1 || n > r.count || n > 3) return false;
    initRelays();
    digitalWrite(r.pins[n - 1], on ? HIGH : LOW);
    s_relayState[n - 1] = on;
    return true;
}

int relayState(int n) {
    const RelayConfig& r = Board::profile().relay;
    if (n < 1 || n > r.count || n > 3) return -1;
    return s_relayState[n - 1] ? 1 : 0;
}

// ---- bateria ----

namespace {
// Calibracao raw->mV do ADC (curve fitting no S3; line fitting no ESP32
// classico). O raw vem do analogRead do Compat (adc_oneshot a 12 dB), que
// ja cria/unifica a unidade ADC.
adc_cali_handle_t s_battCali = nullptr;
int64_t s_battAt = 0;
int s_battMv = -1;
bool s_battFail = false;  // sem esquema de calibracao: nao tenta de novo

bool battCaliInit() {
    if (s_battCali) return true;
    if (s_battFail) return false;
    // A unidade ADC1 e criada pelo Compat sob demanda; a cali e independente.
    esp_err_t err = ESP_ERR_NOT_SUPPORTED;
#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
    adc_cali_curve_fitting_config_t c = {};
    c.unit_id = ADC_UNIT_1;
    c.atten = ADC_ATTEN_DB_12;
    c.bitwidth = ADC_BITWIDTH_12;
    err = adc_cali_create_scheme_curve_fitting(&c, &s_battCali);
#elif ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
    adc_cali_line_fitting_config_t c = {};
    c.unit_id = ADC_UNIT_1;
    c.atten = ADC_ATTEN_DB_12;
    c.bitwidth = ADC_BITWIDTH_12;
    err = adc_cali_create_scheme_line_fitting(&c, &s_battCali);
#endif
    if (err != ESP_OK) {
        s_battCali = nullptr;
        s_battFail = true;
    }
    return err == ESP_OK;
}
}  // namespace

int batteryMv() {
    const BoardProfile& bp = Board::profile();
    if (bp.batteryPin < 0 && !bp.readBatteryMv) return -1;
    const int64_t now = (int64_t)millis();
    if (s_battMv >= 0 && now - s_battAt < 2000) return s_battMv;  // cache 2 s
    // Bateria por PMU (AXP2101 do watch): hook da placa vem antes do ADC.
    // Sem resposta do PMU nao ha fallback util (a placa nao tem divisor).
    if (bp.readBatteryMv) {
        int mv = 0;
        if (!bp.readBatteryMv(&mv)) return -1;
        s_battMv = mv;
        s_battAt = now;
        return mv;
    }
    if (!battCaliInit()) return -1;
    // ADC ruidoso (servos puxando corrente): media de 16 leituras
    int sum = 0;
    for (int i = 0; i < 16; i++) sum += analogRead(bp.batteryPin);  // 12 dB (Compat)
    int mv = 0;
    if (adc_cali_raw_to_voltage(s_battCali, sum / 16, &mv) != ESP_OK) return -1;
    // mV no pino -> mV da bateria (divisor resistivo da placa)
    mv = mv * bp.batteryScalePct / 100;
    s_battMv = mv;
    s_battAt = now;
    return mv;
}

int batteryPct() {
    const BoardProfile& bp = Board::profile();
    static int64_t s_at = 0;
    static int s_pct = -1;
    const int64_t now = (int64_t)millis();
    if (s_pct >= 0 && now - s_at < 2000) return s_pct;  // cache 2 s
    int pct = -1;
    if (bp.readBatteryPct) pct = bp.readBatteryPct();
    if (pct < 0) {
        // Curva LiPo 1S em repouso (aproximada): mV -> % por interpolacao
        static const int16_t kMv[] = {3300, 3600, 3700, 3750, 3800, 3870, 3950, 4050, 4200};
        static const int8_t kPct[] = {0, 5, 12, 25, 40, 55, 70, 85, 100};
        const int mv = batteryMv();
        if (mv < 0) return -1;
        const int n = sizeof(kMv) / sizeof(kMv[0]);
        if (mv <= kMv[0]) {
            pct = 0;
        } else if (mv >= kMv[n - 1]) {
            pct = 100;
        } else {
            for (int i = 1; i < n; i++) {
                if (mv <= kMv[i]) {
                    pct = kPct[i - 1] + (mv - kMv[i - 1]) * (kPct[i] - kPct[i - 1]) /
                                            (kMv[i] - kMv[i - 1]);
                    break;
                }
            }
        }
    }
    s_pct = pct;
    s_at = now;
    return pct;
}

int chargeState() {
    const BoardProfile& bp = Board::profile();
    if (!bp.readChargeState) return 0;
    static int64_t s_at = -10000;
    static int s_state = -1;
    const int64_t now = (int64_t)millis();
    if (now - s_at < 2000) return s_state;  // cache 2 s (bus I2C compartilhado)
    s_state = bp.readChargeState();
    s_at = now;
    return s_state;
}

// ---- servos (PWM 50 Hz por LEDC) ----
//
// Canais escolhidos para NAO colidir com o resto do mapa LEDC (topo do
// BoardIO.h): primeiro os que a placa deixa livres (7 sem backlight PWM,
// 6 sem buzzer LEDC, 3..5 sem LED RGB), por ultimo 0..2 (os do analogWrite
// — so quando nao ha outro). Timer 2 dedicado (o do tom LEDC); placa com
// buzzer LEDC usa o timer 0 como antes. No cao: 5 servos nos canais 3..7,
// timer 2 — isolados do analogWrite e das fitas (RMT).

namespace {
constexpr int kServoMax = 5;
constexpr int kServoPeriodUs = 20000;       // 50 Hz
constexpr uint32_t kServoDutyMax = 16383;   // 14 bits
ledc_channel_t s_servoCh[kServoMax];
int s_servoChCount = -1;                    // -1 = lista ainda nao montada
int8_t s_servoPin[kServoMax] = {-1, -1, -1, -1, -1};  // -1 = canal livre
bool s_servoTimerOk = false;

// Timer so dos servos (50 Hz/14 bits). O timer 0 de antes (placas com
// buzzer LEDC, a CYD) e o do analogWrite: quem configurava por ultimo
// mudava a frequencia do outro (servo a 5 kHz ou PWM a 50 Hz).
ledc_timer_t servoTimer() {
    const BoardProfile& bp = Board::profile();
    if (bp.speakerPin < 0) return LEDC_TIMER_2;  // timer do tom LEDC sobra
#if SOC_LEDC_SUPPORT_HS_MODE
    return LEDC_TIMER_3;  // o backlight do LGFX vive no bloco de ALTA velocidade
#else
    if (!bp.backlightPwm) return LEDC_TIMER_3;
    return LEDC_TIMER_0;  // sem timer livre: ultimo recurso (divide com analogWrite)
#endif
}

void servoChannels() {
    if (s_servoChCount >= 0) return;
    const BoardProfile& bp = Board::profile();
    int n = 0;
    auto add = [&](int ch) { if (n < kServoMax) s_servoCh[n++] = (ledc_channel_t)ch; };
    if (!bp.backlightPwm) add(7);
    if (bp.speakerPin < 0) add(6);
    if (bp.led.r < 0) { add(5); add(4); add(3); }
    add(0); add(1); add(2);  // compartilhados com o analogWrite (ultimo recurso)
    if (n > kServoMax) n = kServoMax;  // add() cerca o array, mas o COUNT nao:
    // sem o clamp o servoWrite varre alem de s_servoCh/s_servoPin (le canal
    // lixo no ledc_channel_config e escreve s_servoPin fora do array —
    // corrupcao que derruba o heap do runtime JS depois)
    s_servoChCount = n;
}
}  // namespace

bool servoWrite(int pin, int us) {
    if (!GPIO_IS_VALID_OUTPUT_GPIO(pin)) return false;
    servoChannels();
    int slot = -1;
    for (int i = 0; i < s_servoChCount; i++) {
        if (s_servoPin[i] == pin) { slot = i; break; }  // ja esta neste pino
    }
    if (slot < 0) {
        // primeiro canal livre que o analogWrite tambem nao esteja usando
        // (0..2 sao dele; a reserva impede que ele os tome depois)
        for (int i = 0; i < s_servoChCount && slot < 0; i++) {
            if (s_servoPin[i] < 0 && celerLedcClaim((int)s_servoCh[i])) slot = i;
        }
    }
    if (slot < 0) return false;  // canais esgotados: servoOff libera um
    if (us < 400) us = 400;
    if (us > 2600) us = 2600;
    const uint32_t duty = (uint32_t)(((int64_t)us * (kServoDutyMax + 1)) / kServoPeriodUs);
    if (s_servoPin[slot] != pin) {
        if (!s_servoTimerOk) {
            ledc_timer_config_t tim = {};
            tim.speed_mode = kMode;
            tim.timer_num = servoTimer();
            tim.duty_resolution = LEDC_TIMER_14_BIT;
            tim.freq_hz = 50;
            tim.clk_cfg = LEDC_AUTO_CLK;
            if (ledc_timer_config(&tim) != ESP_OK) return false;
            s_servoTimerOk = true;  // reconfigurar a cada pino glitchava os outros
        }
        ledc_channel_config_t ch = {};
        ch.speed_mode = kMode;
        ch.channel = s_servoCh[slot];
        ch.timer_sel = servoTimer();
        ch.gpio_num = pin;
        ch.duty = duty;  // ja nasce no angulo pedido (sem pulso 0 no meio)
        if (ledc_channel_config(&ch) != ESP_OK) {
            celerLedcRelease((int)s_servoCh[slot]);
            return false;
        }
        s_servoPin[slot] = (int8_t)pin;
        return true;
    }
    ledc_set_duty(kMode, s_servoCh[slot], duty);
    ledc_update_duty(kMode, s_servoCh[slot]);
    return true;
}

bool servoOff(int pin) {
    for (int i = 0; i < s_servoChCount; i++) {
        if (s_servoPin[i] == pin) {
            ledc_stop(kMode, s_servoCh[i], 0);
            s_servoPin[i] = -1;
            celerLedcRelease((int)s_servoCh[i]);
            return true;
        }
    }
    return false;
}

void servosOff() {
    for (int i = 0; i < s_servoChCount; i++) {
        if (s_servoPin[i] >= 0) {
            ledc_stop(kMode, s_servoCh[i], 0);
            s_servoPin[i] = -1;
            celerLedcRelease((int)s_servoCh[i]);
        }
    }
}

// ---- fitas WS2812 (RMT sem DMA) ----
//
// Validado no cao ZZPET: 2 canais TX sem DMA, 96 simbolos cada (exato para
// 4 LEDs; 8 e o teto com o bloco de memoria do S3). Com with_dma=true o
// segundo allocate falha ("no free tx channels").

namespace {
rmt_channel_handle_t s_stripCh[2] = {nullptr, nullptr};
rmt_encoder_handle_t s_stripEnc = nullptr;
bool s_stripReady = false;
bool s_stripFail = false;  // init falhou: nao re-tenta (e nao vaza canais)
bool s_stripLit = false;   // algum app acendeu (stripsOff so age entao)

void stripFree() {
    for (int i = 0; i < 2; i++) {
        if (s_stripCh[i]) {
            rmt_disable(s_stripCh[i]);
            rmt_del_channel(s_stripCh[i]);
            s_stripCh[i] = nullptr;
        }
    }
    if (s_stripEnc) {
        rmt_del_encoder(s_stripEnc);
        s_stripEnc = nullptr;
    }
}

bool stripInit() {
    const LedStrips& s = Board::profile().strips;
    if (s.count <= 0 || s_stripFail) return false;
    if (s_stripReady) return true;
    rmt_copy_encoder_config_t ec;  // struct vazia no IDF 6
    bool ok = rmt_new_copy_encoder(&ec, &s_stripEnc) == ESP_OK;
    for (int i = 0; ok && i < s.count && i < 2; i++) {
        rmt_tx_channel_config_t cfg = {};
        cfg.gpio_num = (gpio_num_t)s.pins[i];
        cfg.clk_src = RMT_CLK_SRC_DEFAULT;
        cfg.resolution_hz = 10 * 1000 * 1000;  // 100 ns por tick
        cfg.mem_block_symbols = 96;            // 4 LEDs x 24 bits (sem DMA)
        cfg.trans_queue_depth = 4;
        ok = rmt_new_tx_channel(&cfg, &s_stripCh[i]) == ESP_OK && rmt_enable(s_stripCh[i]) == ESP_OK;
    }
    if (!ok) {
        stripFree();
        s_stripFail = true;
        return false;
    }
    s_stripReady = true;
    return true;
}
}  // namespace

bool hasStrips() { return Board::profile().strips.count > 0; }

bool neopixelSet(int strip, const uint32_t* colors, int n) {
    const LedStrips& s = Board::profile().strips;
    if (!colors || strip < 0 || strip >= s.count || strip >= 2) return false;
    if (n <= 0 || n > 8) return false;
    if (!stripInit()) return false;
    // WS2812: bit 1 = 800/500 ns, bit 0 = 400/900 ns (ticks de 100 ns), GRB.
    rmt_symbol_word_t syms[8 * 24];
    rmt_symbol_word_t one = {.duration0 = 8, .level0 = 1, .duration1 = 5, .level1 = 0};
    rmt_symbol_word_t zero = {.duration0 = 4, .level0 = 1, .duration1 = 9, .level1 = 0};
    for (int led = 0; led < n; led++) {
        const uint32_t c = colors[led];
        uint32_t grb = ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF);
        for (int b = 0; b < 24; b++) syms[led * 24 + b] = ((grb >> (23 - b)) & 1) ? one : zero;
    }
    rmt_transmit_config_t tx = {};
    tx.loop_count = 0;
    if (rmt_transmit(s_stripCh[strip], s_stripEnc, syms, (size_t)n * 24 * sizeof(syms[0]), &tx) != ESP_OK)
        return false;
    // O encoder de copia le syms (pilha) durante a transmissao: nao sair
    // antes do fim. 8 LEDs = ~250 us; 50 ms e so a rede de seguranca.
    if (rmt_tx_wait_all_done(s_stripCh[strip], 50) != ESP_OK) return false;
    s_stripLit = true;
    return true;
}

void stripsOff() {
    if (!s_stripLit || !s_stripReady) return;
    const LedStrips& s = Board::profile().strips;
    const uint32_t black[8] = {0};
    int n = s.ledsPerStrip > 0 && s.ledsPerStrip <= 8 ? s.ledsPerStrip : 8;
    for (int i = 0; i < s.count && i < 2; i++) neopixelSet(i, black, n);
    s_stripLit = false;
}

// ---- microfone I2S (RX persistente na I2S1) ----
//
// Cao ZZPET: mic MEMS I2S padrao (WS+BCK+DATA — NAO e PDM puro: o S3 nao tem
// conversor PDM->PCM na porta 1) com o audio no slot esquerdo. O canal fica
// aberto: DMA descarta o que nao e lido entre chamadas.
// ATENCAO: o pino do clock (ws) jamais pode virar canal ADC — a reconfiguracao
// desconecta a matriz GPIO e mata o microfone ate reiniciar o canal.

// O tom/playWav (I2S0) EMPRESTA os pinos compartilhados bclk/ws/mclk do
// canal do mic (I2S1) e os devolve soltos no GPIO matrix — quem roteou por
// ultimo domina o pino, e o I2S1 so re-roteia ao (re)nascer. Sem isto, todo
// beep mata as capturas seguintes (bancada 2026-10-03: "primeiro audio
// perfeito, seguintes mudos" — o ES7210 fica sem MCLK e o gravador le zeros).
volatile bool s_micPinsDirty = false;
// Leitores do canal I2S do mic (gravador, micLevel, wake word): quem vai
// ler trava isto por chunk (~32 ms) para nao roubar audio do outro.
SemaphoreHandle_t s_micChanMux = nullptr;

namespace {
i2s_chan_handle_t s_mic = nullptr;
bool s_micFail = false;       // ultima tentativa falhou (ve o prazo abaixo)
int64_t s_micFailAtUs = 0;    // quando falhou

// Falha de init NAO e mais permanente: no boot do cao o heap interno encosta
// em ~3 KB (Dog Face + BLE + servos subindo juntos) e os descritores DMA do
// I2S1 (~6 KB) nao nascem — bancada 2026-10-02, o latch antigo deixava o mic
// morto ate reiniciar. Segura novas tentativas por 3 s (micLevel segue barato:
// sem retry a cada chamada) e depois cura sozinho com o heap ja acomodado.
// Cria/recria o canal. Chamar COM o s_micChanMux na mao: a recriacao apaga
// o canal, e um leitor (wake word, em outra task) no meio do read usaria o
// canal liberado.
bool micInitUnlocked() {
    const MicI2sPins& m = Board::profile().mic;
    if (m.ws < 0) return false;
    if (s_mic) {
        if (!s_micPinsDirty) return true;
        // beep/playWav passou por aqui: re-roteia os pinos no GPIO matrix
        // (ver comentario do s_micPinsDirty) SEM soltar o canal — recriar
        // pedia os descritores DMA de novo, e com o WiFi do ESP-NOW no ar o
        // DMA interno do relogio nao tinha 3 KB inteiros (o mic morria a cada
        // som, bancada 2026-10-11). So recria se o re-roteamento falhar.
        i2s_std_gpio_config_t g = {};
        g.mclk = Board::profile().i2s.mclk >= 0 ? (gpio_num_t)Board::profile().i2s.mclk : I2S_GPIO_UNUSED;
        g.bclk = (gpio_num_t)m.bck;
        g.ws = (gpio_num_t)m.ws;
        g.dout = I2S_GPIO_UNUSED;
        g.din = (gpio_num_t)m.din;
        i2s_channel_disable(s_mic);
        if (i2s_channel_reconfig_std_gpio(s_mic, &g) == ESP_OK && i2s_channel_enable(s_mic) == ESP_OK) {
            s_micPinsDirty = false;
            return true;
        }
        i2s_del_channel(s_mic);
        s_mic = nullptr;
        s_micPinsDirty = false;
    }
    if (s_micFail) {
        if (esp_timer_get_time() - s_micFailAtUs < 3000000LL) {
            celer_log_printf("[mic] falha recente: nova tentativa em ate 3 s\n");
            return false;
        }
        s_micFail = false;
    }
    i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    // 6 x 128 frames (stereo 16-bit = 512 B cada, 48 ms no total): eram 6 x
    // 256 (1 KB cada). Com o WiFi do ESP-NOW no ar o DMA interno do relogio
    // fragmenta (maior bloco 2,5 KB com 10 KB livres) e o canal nao subia
    // ("allocate DMA buffer failed", bancada 2026-10-11). Os leitores pedem
    // 256 frames por chamada: o i2s_channel_read junta 2 buffers.
    cc.dma_desc_num = 6;
    cc.dma_frame_num = 128;
    esp_err_t e = i2s_new_channel(&cc, nullptr, &s_mic);
    if (e != ESP_OK) {
        celer_log_printf("[mic] i2s_new_channel: %s (RAM interna %u)\n", esp_err_to_name(e),
                         (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
        s_mic = nullptr;
        s_micFail = true;
        s_micFailAtUs = esp_timer_get_time();
        return false;
    }
    i2s_std_config_t cfg = {};
    cfg.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(16000);
    cfg.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
    cfg.gpio_cfg.mclk = Board::profile().i2s.mclk >= 0
                            ? (gpio_num_t)Board::profile().i2s.mclk
                            : I2S_GPIO_UNUSED;  // codec (ES8311): MCLK do I2S1
    cfg.gpio_cfg.bclk = (gpio_num_t)m.bck;
    cfg.gpio_cfg.ws = (gpio_num_t)m.ws;
    cfg.gpio_cfg.dout = I2S_GPIO_UNUSED;
    cfg.gpio_cfg.din = (gpio_num_t)m.din;
    e = i2s_channel_init_std_mode(s_mic, &cfg);
    if (e == ESP_OK) e = i2s_channel_enable(s_mic);
    if (e != ESP_OK) {
        celer_log_printf("[mic] init/enable do canal: %s (RAM interna %u, DMA %u)\n", esp_err_to_name(e),
                         (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                         (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_DMA));
        i2s_del_channel(s_mic);
        s_mic = nullptr;
        s_micFail = true;
        s_micFailAtUs = esp_timer_get_time();
        return false;
    }
    return true;
}

bool micInit() {
    if (Board::profile().mic.ws < 0) return false;
    if (s_micChanMux == nullptr) s_micChanMux = xSemaphoreCreateMutex();
    if (s_micChanMux == nullptr) return false;
    if (xSemaphoreTake(s_micChanMux, pdMS_TO_TICKS(500)) != pdTRUE) {
        celer_log_printf("[mic] canal ocupado por outro leitor (mutex 500 ms)\n");
        return s_mic != nullptr && !s_micPinsDirty;  // leitor segurando: canal vivo
    }
    const bool ok = micInitUnlocked();
    xSemaphoreGive(s_micChanMux);
    return ok;
}

// ---- gravacao (Mic.* do runtime, API 19): estado + task de captura ----
//
// Mesmo canal I2S1 do micLevel: enquanto a task vive ela e a unica leitora.
// Grava chunks de 32 ms (slot L, 16 kHz mono) ate o teto de amostras ou um
// stop/cancel, entao marca done e morre deixando o buffer intacto para o
// micRecStop montar o WAV. Chamadas publicas so vem da task do app (uma
// por vez); a mutacao concorrente relevante e o append do buffer, sob mux.
struct MicRecState {
    SemaphoreHandle_t mux = nullptr;
    TaskHandle_t task = nullptr;
    int16_t* pcm = nullptr;      // amostras 16-bit mono (PSRAM: > 4 KB)
    volatile int levelR = 0;     // RMS do slot DIREITO (telemetria de slot)
    size_t cap = 0;              // amostras alocadas
    size_t n = 0;                // amostras gravadas (so a task escreve)
    volatile bool stopReq = false;
    volatile bool done = false;  // task terminou; buffer aguardando leitura
    volatile int level = 0;      // RMS 0..100 do ultimo chunk (mesma escala do micLevel)
    bool overflow = false;       // amostra descartada (teto/lock lento)
    int state = 0;               // 0 livre, 1 gravando (done=true = teto alcancado)
};
MicRecState s_rec;

void micRecTask(void*) {
    int16_t buf[512];  // 256 frames stereo = 32 ms
    int tele = 0;      // telemetria ~1x/s: RMS dos dois slots (logcat)
    while (!s_rec.stopReq) {
        size_t r = 0;
        // so devolve o mutex que pegou: soltar sem ter (lock falhou) corrompe
        // o dono do mutex no FreeRTOS
        if (!BoardIO::micChanLock(250)) continue;
        const esp_err_t rr = i2s_channel_read(s_mic, buf, sizeof(buf), &r, pdMS_TO_TICKS(150));
        BoardIO::micChanUnlock();
        if (rr != ESP_OK || r < 4) continue;
        const int frames = (int)(r / 4);
        bool dropped = false;
        if (xSemaphoreTake(s_rec.mux, pdMS_TO_TICKS(50)) == pdTRUE) {
            for (int i = 0; i < frames; i++) {
                if (s_rec.n < s_rec.cap) s_rec.pcm[s_rec.n++] = buf[2 * i];  // slot L (mono capturado)
                else dropped = true;
            }
            if (dropped) s_rec.overflow = true;
            xSemaphoreGive(s_rec.mux);
        } else {
            s_rec.overflow = true;
        }
        s_rec.level = rmsLevel100(buf, frames, 2, 0);
        s_rec.levelR = rmsLevel100(buf, frames, 2, 1);  // telemetria de slot
        if (++tele % 31 == 0)  // ~1 s de chunks de 32 ms
            celer_log_printf("[micrec] slotL=%d slotR=%d\n", s_rec.level, s_rec.levelR);
        if (s_rec.n >= s_rec.cap) break;  // teto: encerra sozinho
    }
    s_rec.level = 0;
    s_rec.done = true;
    s_rec.task = nullptr;
    vTaskDelete(nullptr);
}
}  // namespace

int rmsLevel100(const int16_t* samples, int n, int stride, int slot) {
    if (n <= 0) return 0;
    // Mic MEMS tem offset DC: RMS da componente AC (variancia), senao o
    // "silencio" mede o offset e o nivel nunca chega perto de 0. Escala
    // unica no firmware (micLevel, gravacao e wake word).
    int64_t sum = 0, acc = 0;
    for (int i = 0; i < n; i++) {
        const int32_t v = samples[i * stride + slot];
        sum += v;
        acc += (int64_t)v * v;
    }
    const int64_t mean = sum / n;
    int64_t var = acc / n - mean * mean;
    if (var < 0) var = 0;
    const int lvl = (int)sqrtf((float)var) / 60;  // fundo ~0-3, voz/media sala 15-40, grito >60
    return lvl > 100 ? 100 : lvl;
}

void micPinsDirty() { s_micPinsDirty = true; }

// ---- alto-falante: canal TX persistente das placas sem codec ---------------
//
// O amp classe D do cao (e o NS4168 da SmartDisplay) nao tem pino de enable:
// ele fica interpretando o I2S0 para sempre. Apagar o canal a cada som congela
// bclk/ws/dout no ultimo nivel (o i2s_del_channel nao devolve os pinos) e o
// chip passa a viver SEM clock — nessa condicao a saida nao e silencio e a
// bobina cozinha devagar (bancada 2026-10-03: o coletor de amostras do wake
// word, bips de 70 ms intercalados com idle, deixou o alto-falante do cao
// queimando de morno; o mesmo hardware nunca esquentou com o firmware do
// fornecedor, que mantem o canal habilitado mandando zeros). O canal aqui
// nasce no PRIMEIRO som (o heap apertado do boot do cao nao paga os ~3,8 KB
// dos descritores DMA por antecipacao), reconfigura a taxa quando ela muda e
// nao morre mais: entre sons o auto_clear mantem clocks + silencio, que e o
// unico repouso comprovadamente frio. Placas com codec (watch) nao passam
// por aqui: os clocks sao emprestados do I2S1 do mic e o canal segue
// nascendo/morrendo por som, com o PA descido e o codec dormindo no meio.
namespace {
i2s_chan_handle_t s_spk = nullptr;  // canal TX persistente (sem codec)
int s_spkRate = 0;                  // taxa atual do canal (0 = ainda nao usado)
bool s_spkOn = false;               // canal habilitado (reconfig exige desabilitar)
}  // namespace

i2s_chan_handle_t speakerChannel(int sampleRateHz) {
    const BoardProfile& bp = Board::profile();
    if (bp.audioCodecWake != nullptr || bp.i2s.dout < 0) return nullptr;
    if (s_spk != nullptr && s_spkRate != sampleRateHz) {
        // taxa nova (ex.: tom 44,1 kHz -> WAV 16 kHz): reconfigura o clock
        if (s_spkOn) {
            i2s_channel_disable(s_spk);  // reconfig so vale canal desabilitado
            s_spkOn = false;
        }
        i2s_std_clk_config_t clk = I2S_STD_CLK_DEFAULT_CONFIG((uint32_t)sampleRateHz);
        if (i2s_channel_reconfig_std_clock(s_spk, &clk) == ESP_OK) {
            s_spkRate = sampleRateHz;
        } else {  // taxa nao pegou: recria o canal inteiro
            i2s_del_channel(s_spk);
            s_spk = nullptr;
            s_spkRate = 0;
        }
    }
    if (s_spk == nullptr) {
        i2s_chan_config_t chanCfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
        // I2S_NUM_0 fixo: o I2S1 fica reservado ao microfone (mesma regra do
        // toneI2s/gravador)
        chanCfg.auto_clear = true;  // silencio entre sons: o repouso do amp
        // DMA enxuto (4 descritores ~3,8 KB internos em vez dos 6 default):
        // com a RAM interna apertada o default falhava em "allocate DMA
        // buffer failed" (bancada) — e agora a alocacao e vitalicia
        chanCfg.dma_desc_num = 4;
        if (i2s_new_channel(&chanCfg, &s_spk, nullptr) != ESP_OK) {
            s_spk = nullptr;
            return nullptr;
        }
        i2s_std_config_t stdCfg = {};
        stdCfg.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG((uint32_t)sampleRateHz);
        stdCfg.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
        stdCfg.gpio_cfg.mclk = bp.i2s.mclk >= 0 ? (gpio_num_t)bp.i2s.mclk : I2S_GPIO_UNUSED;
        stdCfg.gpio_cfg.bclk = (gpio_num_t)bp.i2s.bclk;
        stdCfg.gpio_cfg.ws = (gpio_num_t)bp.i2s.lrc;
        stdCfg.gpio_cfg.dout = (gpio_num_t)bp.i2s.dout;
        stdCfg.gpio_cfg.din = I2S_GPIO_UNUSED;
        if (i2s_channel_init_std_mode(s_spk, &stdCfg) != ESP_OK) {
            i2s_del_channel(s_spk);
            s_spk = nullptr;
            return nullptr;
        }
        s_spkRate = sampleRateHz;
    }
    if (!s_spkOn && i2s_channel_enable(s_spk) == ESP_OK) s_spkOn = true;
    return s_spkOn ? s_spk : nullptr;
}

void speakerChannelDown() {
    if (s_spk == nullptr) return;
    if (s_spkOn) i2s_channel_disable(s_spk);
    i2s_del_channel(s_spk);
    s_spk = nullptr;
    s_spkRate = 0;
    s_spkOn = false;
    speakerPinsPark();  // dormindo: pinos em nivel definido, amp sem input solto
}

void speakerPinsPark() {
    const BoardProfile& bp = Board::profile();
    const bool hasCodec = bp.audioCodecWake != nullptr;
    const int pins[3] = {bp.i2s.dout, hasCodec ? -1 : bp.i2s.bclk, hasCodec ? -1 : bp.i2s.lrc};
    for (int pin : pins) {
        if (pin < 0) continue;
        gpio_reset_pin((gpio_num_t)pin);
        gpio_set_direction((gpio_num_t)pin, GPIO_MODE_OUTPUT);
        gpio_set_level((gpio_num_t)pin, 0);
    }
}

bool micEnsureChannel() { return micInit(); }

bool micChanLock(int timeoutMs) {
    if (s_micChanMux == nullptr) return false;
    return xSemaphoreTake(s_micChanMux, pdMS_TO_TICKS(timeoutMs)) == pdTRUE;
}

void micChanUnlock() {
    if (s_micChanMux != nullptr) xSemaphoreGive(s_micChanMux);
}

int micReadMonoLocked(int16_t* out, int maxSamples) {
    int16_t buf[512];  // 256 frames stereo = 32 ms
    size_t r = 0;
    if (!micChanLock(200)) return -2;  // outro leitor segurando o canal
    // beep/playWav desviou os pinos (ou o canal caiu): o leitor de fundo
    // recria ele mesmo — sem isso o wake word ficava surdo apos qualquer som
    if ((s_mic == nullptr || s_micPinsDirty) && !micInitUnlocked()) {
        micChanUnlock();
        return -3;  // canal nao subiu
    }
    const esp_err_t rr = i2s_channel_read(s_mic, buf, sizeof(buf), &r, pdMS_TO_TICKS(150));
    micChanUnlock();
    if (rr != ESP_OK || r < 4) return rr == ESP_ERR_TIMEOUT ? -4 : -1;  // -4: sem clock/dados
    const int frames = (int)(r / 4);
    const int n = frames < maxSamples ? frames : maxSamples;
    for (int i = 0; i < n; i++) out[i] = buf[2 * i];  // slot L
    return n;
}

int micLevel() {
    // Gravacao em curso: a task do gravador e a unica leitora do canal —
    // o nivel ao vivo sai dela (ler aqui roubaria chunks do audio)
    if (s_rec.state != 0) return s_rec.done ? -1 : s_rec.level;
    // Placa com codec de captura (watch): o ES7210 dorme entre usos —
    // religa a cada leitura (~1 ms de I2C; os clocks ja correm pelo canal).
    const BoardProfile& bp = Board::profile();
    if (bp.micCodecWake != nullptr && !bp.micCodecWake()) return -1;

    int16_t mono[256];  // 32 ms de audio (um chunk do canal)
    const int n = micReadMonoLocked(mono, 256);
    if (n < 16) return -1;  // janela curta demais (antes: r < 64 bytes)
    return rmsLevel100(mono, n, 1, 0);
}

// ---- gravacao de microfone: API do runtime (Mic.*) ---------------------------

namespace {
inline void u16le(uint8_t* p, uint16_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
inline void u32le(uint8_t* p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}
// Header PCM16 mono 16 kHz canonico de 44 bytes (o que o input_audio das
// LLMs e o System.playWav esperam)
void wavHeader(uint8_t* h, uint32_t dataLen) {
    memcpy(h, "RIFF", 4); u32le(h + 4, 36 + dataLen); memcpy(h + 8, "WAVE", 4);
    memcpy(h + 12, "fmt ", 4); u32le(h + 16, 16);
    u16le(h + 20, 1);  u16le(h + 22, 1);          // PCM, mono
    u32le(h + 24, 16000); u32le(h + 28, 32000);   // fs, byte rate
    u16le(h + 32, 2); u16le(h + 34, 16);          // block align, bits
    memcpy(h + 36, "data", 4); u32le(h + 40, dataLen);
}

// Depois da gravacao o codec de captura do watch volta a dormir (o
// micLevel religa na proxima leitura)
void micRecCodecDown() {
    if (Board::profile().micCodecSleep != nullptr) Board::profile().micCodecSleep();
}

void micRecFree() {
    free(s_rec.pcm);
    s_rec.pcm = nullptr;
    s_rec.cap = 0;
    s_rec.n = 0;
    s_rec.state = 0;
}

// Monta WAV (ou base64 dele) do buffer gravado. Chamado SO com done=true
// (nenhum escritor vivo). Pico transitorio: WAV + base64 na PSRAM.
char* micRecBuildOut(bool base64, size_t* lenOut, uint32_t* msOut) {
    // Corta o SILENCIO das pontas antes de montar: a janela abre antes da
    // fala e fecha 550 ms DEPOIS dela (a guarda de quietud) — esse colchao
    // viajava inteiro no base64/upload e a LLM cobra por token de audio
    // (menos audio = resposta mais rapida). 160 ms antes da 1a voz, 240 ms
    // depois da ultima, minimo de 100 ms; gravacao toda muda segue como
    // esta (o fluxo "comando none" precisa do audio que havia).
    if (s_rec.n > 1600) {  // acima de 100 ms: menos que isso nao ha o cortar
        // nivel 0-3 do Mic.level (RMS%) e o ruido de sala: o corte fica
        // ACIMA dele e ABAIXO da fala (15-40). Ajuste fino na bancada.
        const int kThresh = 1200;  // ~3,7% da escala
        // A busca da 1a voz comeca DEPOIS dos primeiros 300 ms: o beep do
        // cue/beep do proprio alto-falante entra no microfone e era tomado
        // como "fala" — o trim mantinha so a janela do beep e cortava a
        // frase de verdade (bancada 2026-10-05: clips de 0,26 s)
        const size_t scanFrom = s_rec.n > 4800 ? 4800 : 0;  // 300 ms
        size_t first = s_rec.n, last = 0;
        for (size_t i = scanFrom; i < s_rec.n; i++) {
            if (s_rec.pcm[i] > kThresh || s_rec.pcm[i] < -kThresh) { first = i; break; }
        }
        if (first < s_rec.n) {
            for (size_t i = s_rec.n; i-- > 0;) {
                if (s_rec.pcm[i] > kThresh || s_rec.pcm[i] < -kThresh) { last = i; break; }
            }
            size_t a = first > 2560 ? first - 2560 : 0;  // 160 ms de pre-roll
            size_t b = last + 3840 < s_rec.n ? last + 3840 : s_rec.n;  // 240 ms pos
            if (b - a < 1600) {  // minimo de 100 ms em volta da voz
                a = first > 800 ? first - 800 : 0;
                b = a + 1600 < s_rec.n ? a + 1600 : s_rec.n;
            }
            if (a > 0) memmove(s_rec.pcm, s_rec.pcm + a, (b - a) * sizeof(int16_t));
            s_rec.n = b - a;
        }
    }
    if (msOut != nullptr) *msOut = (uint32_t)(s_rec.n / 16);  // 16000 amostras/s
    const size_t dataLen = s_rec.n * sizeof(int16_t);
    uint8_t* wav = (uint8_t*)malloc(44 + dataLen);
    if (wav == nullptr) return nullptr;
    wavHeader(wav, (uint32_t)dataLen);
    if (dataLen > 0) memcpy(wav + 44, s_rec.pcm, dataLen);
    if (!base64) {
        if (lenOut != nullptr) *lenOut = 44 + dataLen;
        return (char*)wav;
    }
    size_t b64len = 0;
    mbedtls_base64_encode(nullptr, 0, &b64len, wav, 44 + dataLen);
    char* b64 = (char*)malloc(b64len);
    if (b64 == nullptr) {
        free(wav);
        return nullptr;
    }
    mbedtls_base64_encode((unsigned char*)b64, b64len, &b64len, wav, 44 + dataLen);
    free(wav);
    if (lenOut != nullptr) *lenOut = b64len;  // sem o NUL final
    return b64;
}

// Espera a task morrer (ela pode estar ate 150 ms dentro do i2s_read)
void micRecJoin() {
    s_rec.stopReq = true;
    while (!s_rec.done) vTaskDelay(pdMS_TO_TICKS(2));
}
}  // namespace

bool micRecStart(int maxMs) {
    if (!micInit()) return false;
    if (s_rec.state != 0) return false;  // ja gravando (ou buffer nao lido)
    const BoardProfile& bp = Board::profile();
    if (bp.micCodecWake != nullptr && !bp.micCodecWake()) return false;  // ES7210: ADC ligado
    if (maxMs < 200) maxMs = 200;
    if (maxMs > 10000) maxMs = 10000;  // 10 s = 320 KB de PCM (PSRAM)
    if (s_rec.mux == nullptr) s_rec.mux = xSemaphoreCreateMutex();
    if (s_rec.mux == nullptr) return false;
    s_rec.pcm = (int16_t*)malloc((size_t)maxMs * 16 * sizeof(int16_t));
    if (s_rec.pcm == nullptr) return false;
    s_rec.cap = (size_t)maxMs * 16;
    s_rec.n = 0;
    s_rec.stopReq = false;
    s_rec.done = false;
    s_rec.overflow = false;
    s_rec.level = 0;
    s_rec.state = 1;
    if (xTaskCreate(micRecTask, "micrec", 3072, nullptr, 3, &s_rec.task) != pdPASS) {
        s_rec.task = nullptr;
        micRecFree();
        micRecCodecDown();
        return false;
    }
    return true;
}

bool micRecActive() { return s_rec.state == 1 && !s_rec.done; }

int micRecLevel() { return s_rec.state == 1 ? s_rec.level : -1; }

char* micRecStop(bool base64, size_t* lenOut, uint32_t* msOut) {
    if (s_rec.state != 1 || s_rec.pcm == nullptr) return nullptr;
    micRecJoin();
    char* out = micRecBuildOut(base64, lenOut, msOut);
    micRecFree();
    micRecCodecDown();
    return out;
}

void micRecCancel() {
    if (s_rec.state != 1) return;
    micRecJoin();
    micRecFree();
    micRecCodecDown();
}

// ---- volume (System.setVolume, API 13) --------------------------------------

namespace {
int s_volume = -1;  // 0..100; -1 = ainda nao carregou do NVS

void volumeLoad() {
    if (s_volume >= 0) return;
    int v = atoi(CelerSettings::get("volume", "100").c_str());
    s_volume = (v < 0 || v > 100) ? 100 : v;
}
}  // namespace

int volumePct() {
    volumeLoad();
    return s_volume;
}

void setVolumePct(int pct, bool persist) {
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    s_volume = pct;
    if (persist) {
        char v[8];
        snprintf(v, sizeof(v), "%d", pct);
        CelerSettings::set("volume", v);
    }
}

// ---- pad capacitivo avulso (touch driver novo do IDF, hw v2 do S3) ----

#if SOC_TOUCH_SENSOR_SUPPORTED && SOC_TOUCH_SENSOR_VERSION == 2
namespace {
touch_sensor_handle_t s_ts = nullptr;
touch_channel_handle_t s_tsCh = nullptr;
bool s_tsFail = false;
uint32_t s_tsBase = 0;
bool s_tsBaseOk = false;
bool s_tsDown = false;

bool tsInit() {
    const int gpio = Board::profile().touchPad;
    if (gpio < 0 || s_tsFail) return false;
    if (s_ts) return true;
    // No S3 o canal touch n equivale ao GPIO n (1..14).
    touch_sensor_sample_config_t sample = TOUCH_SENSOR_V2_DEFAULT_SAMPLE_CONFIG(
        500, TOUCH_VOLT_LIM_L_0V8, TOUCH_VOLT_LIM_H_2V4);
    touch_sensor_config_t sens = TOUCH_SENSOR_DEFAULT_BASIC_CONFIG(1, &sample);
    if (touch_sensor_new_controller(&sens, &s_ts) != ESP_OK) {
        s_ts = nullptr;
        s_tsFail = true;
        return false;
    }
    touch_channel_config_t chan = {};
    chan.active_thresh[0] = 2000;  // exigido pelo driver; a decisao e nossa (abaixo)
    if (touch_sensor_new_channel(s_ts, gpio, &chan, &s_tsCh) != ESP_OK ||
        touch_sensor_enable(s_ts) != ESP_OK) {
        if (s_tsCh) touch_sensor_del_channel(s_tsCh);
        touch_sensor_del_controller(s_ts);
        s_tsCh = nullptr;
        s_ts = nullptr;
        s_tsFail = true;
        return false;
    }
    return true;
}
}  // namespace

int touchPad() {
    if (!tsInit()) return -1;
    uint32_t val = 0;
    if (touch_channel_read_data(s_tsCh, TOUCH_CHAN_DATA_TYPE_SMOOTH, &val) != ESP_OK) return -1;
    if (!s_tsBaseOk) {
        // Referencia na primeira leitura (pad solto): media rapida.
        uint32_t sum = val;
        for (int i = 0; i < 7; i++) {
            delay(4);
            if (touch_channel_read_data(s_tsCh, TOUCH_CHAN_DATA_TYPE_SMOOTH, &val) == ESP_OK) sum += val;
        }
        s_tsBase = sum / 8;
        s_tsBaseOk = true;
        return 0;
    }
    // No S3 o valor sobe com o toque (mais carga). Histerese: entra acima
    // de base + margem, sai abaixo de base + margem/2 (sem pisca-pisca na
    // borda do limiar).
    const uint32_t margin = s_tsBase / 8 + 1000;
    const uint32_t on = s_tsBase + margin, off = s_tsBase + margin / 2;
    s_tsDown = s_tsDown ? (val > off) : (val > on);
    // A referencia deriva com temperatura/umidade (e se o pad estava tocado
    // no boot, nasce alta): segue devagar enquanto solto e desce na hora
    // se a leitura ficar abaixo dela.
    if (!s_tsDown) {
        if (val < s_tsBase) s_tsBase = val;
        else s_tsBase = s_tsBase + (val - s_tsBase) / 64;
    }
    return s_tsDown ? 1 : 0;
}
#else
int touchPad() {
    return -1;  // SoC sem touch v2 (driver novo): nenhuma placa com pad aqui
}
#endif

}  // namespace BoardIO
