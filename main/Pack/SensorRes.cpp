#include "SensorRes.h"

#include <string.h>
#include <strings.h>

#include "driver/gpio.h"
#include "esp_private/esp_gpio_reserve.h"

#include <Arduino.h>  // analogRead (Compat)

#include "../Boards/Board.h"
#include "../Hardware/BoardIO.h"
#include "DataLink.h"
#include "ResProto.h"

// Ponta nativa de sensor dos recursos da matilha (ver SensorRes.h). Amostra
// de 8 B no fio: [ts u32][f32 LE] — o tickTimers do Resources chama tick()
// sob o mutex, e o envio pelo DataLink e o mesmo caminho do controle em
// banda (sendEnv/KIND_DATA), seguro sob o lock.

namespace SensorRes {
namespace {

enum { S_LUM = 0, S_BAT = 1, S_TEMP = 2, S_ADC = 3, S_COUNT = 4 };

struct Sess {
    bool used;
    uint16_t sid;
    uint8_t idx;
    int arg;           // S_ADC: pino lido (params {"pin":N} do OPEN)
    uint8_t mac[6];
    uint32_t token;
    uint16_t rateMs;   // 0 = so por pedido (ou so threshold)
    uint32_t nextMs;
    uint16_t seq;
    // threshold (API 47): evento na TRANSICAO do limiar, sem stream continuo.
    // h re-arma (histerese); o cooldown de 1 s evita tempestade no ruido.
    bool hasGt, hasLt;
    float gt, lt, h;
    bool armedGt, armedLt;
    uint32_t lastEvtMs;
};
constexpr int MAX = 4;
constexpr uint16_t RATE_MIN = 250, RATE_MAX = 60000;
constexpr uint16_t EVAL_MS = 1000;          // taxa de avaliacao so-threshold
constexpr uint32_t EVT_COOLDOWN_MS = 1000;  // 1 evento por cruzamento/sessao
Sess s_s[MAX];
SendHook s_send = nullptr;  // registrado pelo Resources (DataLink ou USB)

uint32_t nowMs() { return (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS); }

Sess* bySid(uint16_t sid) {
    for (int i = 0; i < MAX; i++) {
        if (s_s[i].used && s_s[i].sid == sid) return &s_s[i];
    }
    return nullptr;
}

// Guarda de pino de LEITURA (diferente da de saida do GpioRes): ADC aceita
// pinos sem driver de saida, mas nunca linha reservada pelo boot (flash/
// PSRAM) nem a deniedMask do perfil (as DQ da PSRAM octal do S3)
bool adcAllowed(int pin) {
    if (pin < 0 || pin >= 64 || !GPIO_IS_VALID_GPIO(pin)) return false;
    const uint64_t bit = 1ULL << pin;
    if (esp_gpio_is_reserved(bit) || (Board::profile().gpioDeniedMask & bit) != 0) return false;
    return true;
}

// A leitura de hardware em si (BoardIO ja trata ADC/PMU/cache). arg so vale
// para S_ADC (o pino da sessao).
bool sample(int idx, int arg, float* v) {
    switch (idx) {
        case S_LUM: {
            const int l = BoardIO::lightLevel();  // 0..100; -1 sem sensor
            if (l < 0) return false;
            *v = (float)l;
            return true;
        }
        case S_BAT: {
            const int b = BoardIO::batteryPct();  // 0..100; -1 sem bateria
            if (b < 0) return false;
            *v = (float)b;
            return true;
        }
        case S_TEMP: {
            float c = 0.0f;
            if (Board::profile().imuTemp == nullptr || !Board::profile().imuTemp(&c)) return false;
            *v = c;
            return true;
        }
        case S_ADC: {
            if (!adcAllowed(arg)) return false;
            *v = (float)analogRead(arg);  // bruto 0..4095 (12 bits)
            return true;
        }
        default:
            return false;
    }
}

int encodeSample(int idx, int arg, uint8_t out[8]) {
    float v;
    if (!sample(idx, arg, &v)) return 0;
    return (int)resproto::encodeSensorSample(nowMs(), v, out);
}

// Evento de threshold pelo mesmo hook do stream (o Resources decide o
// transporte: ESP-NOW, cabo ou o DATA da malha — o evento e pequeno).
void emitEvent(Sess& s, uint32_t now, float v, uint8_t dir) {
    if (s.lastEvtMs != 0 && now - s.lastEvtMs < EVT_COOLDOWN_MS) return;
    s.lastEvtMs = now;
    uint8_t p[resproto::SENSOR_EVENT_LEN];
    const size_t n = resproto::encodeSensorEvent(now, v, dir, p);
    if (s_send != nullptr) {
        s_send(s.sid, s.mac, s.token, p, n);
    } else {
        DataLink::send(s.mac, DataLink::KIND_DATA, s.sid, s.token, ++s.seq, p, n);
    }
}

// Avalia os limiares com a leitura JA feita: evento na transicao; a
// histerese re-arma (so volta a disparar depois de cruzar o limiar +/- h).
void evalThreshold(Sess& s, uint32_t now, float v) {
    if (s.hasGt) {
        if (s.armedGt && v >= s.gt) {
            s.armedGt = false;
            emitEvent(s, now, v, resproto::SENSOR_EV_GT);
        } else if (!s.armedGt && v <= s.gt - s.h) {
            s.armedGt = true;
        }
    }
    if (s.hasLt) {
        if (s.armedLt && v <= s.lt) {
            s.armedLt = false;
            emitEvent(s, now, v, resproto::SENSOR_EV_LT);
        } else if (!s.armedLt && v >= s.lt + s.h) {
            s.armedLt = true;
        }
    }
}

}  // namespace

int count() { return S_COUNT; }

const char* name(int idx) {
    switch (idx) {
        case S_LUM: return "lum";
        case S_BAT: return "bat";
        case S_TEMP: return "temp";
        case S_ADC: return "adc";
        default: return "?";
    }
}

bool available(int idx) {
    if (idx < 0 || idx >= S_COUNT) return false;
    switch (idx) {
        case S_LUM: return BoardIO::hasLightSensor();
        case S_BAT: return Board::profile().batteryPin >= 0;
        case S_TEMP: return Board::profile().imuTemp != nullptr;
        case S_ADC: return true;  // o pino vem no OPEN ({"pin":N})
        default: return false;
    }
}

int indexOf(const char* n) {
    if (n == nullptr) return -1;
    for (int i = 0; i < S_COUNT; i++) {
        if (strcasecmp(name(i), n) == 0) return i;
    }
    return -1;
}

void setSendHook(SendHook h) { s_send = h; }

bool busy(uint16_t sid) { return bySid(sid) != nullptr; }

bool serveStart(uint16_t sid, const uint8_t mac[6], uint32_t token, int sensorIdx, int rateMs,
                const uint8_t* params, size_t plen) {
    if (!available(sensorIdx)) return false;
    int arg = 0;
    if (sensorIdx == S_ADC) {
        arg = resproto::paramInt(params, plen, "pin", -1);
        if (!adcAllowed(arg)) return false;
    }
    if (bySid(sid) != nullptr) return true;  // OPEN repetido: ja serve
    Sess* s = nullptr;
    for (int i = 0; i < MAX && s == nullptr; i++) {
        if (!s_s[i].used) s = &s_s[i];
    }
    if (s == nullptr) return false;  // tabela cheia: 4 leitores por vez
    s->used = true;
    s->sid = sid;
    s->idx = (uint8_t)sensorIdx;
    s->arg = arg;
    memcpy(s->mac, mac, 6);
    s->token = token;
    if (rateMs < 0) rateMs = 0;
    // RATE_MIN e o piso do stream: sem o clamp, {"rate":1} (ou 5) abria um
    // bloqueio de leitura por milissegundo e inundava o radio/o cabo
    if (rateMs != 0 && rateMs < RATE_MIN) rateMs = RATE_MIN;
    s->rateMs = (uint16_t)(rateMs > RATE_MAX ? RATE_MAX : rateMs);
    // threshold (API 47): {"gt":x} / {"lt":x} + histerese {"h":d}
    s->hasGt = resproto::paramHas(params, plen, "gt");
    s->hasLt = resproto::paramHas(params, plen, "lt");
    s->gt = resproto::paramFloat(params, plen, "gt", 0.0f);
    s->lt = resproto::paramFloat(params, plen, "lt", 0.0f);
    s->h = resproto::paramFloat(params, plen, "h", 0.0f);
    if (!(s->h >= 0.0f)) s->h = 0.0f;  // negativo E NaN (comparacao falsa)
    s->armedGt = true;
    s->armedLt = true;
    s->lastEvtMs = 0;
    const bool thr = s->hasGt || s->hasLt;
    s->nextMs = nowMs() + (s->rateMs != 0 ? s->rateMs : (thr ? EVAL_MS : RATE_MAX));
    s->seq = 0;
    return true;
}

void serveStop(uint16_t sid) {
    Sess* s = bySid(sid);
    if (s != nullptr) s->used = false;
}

int sampleOnce(int sensorIdx, uint8_t out[8]) {
    if (!available(sensorIdx)) return 0;
    return encodeSample(sensorIdx, 0, out);
}

int sampleOnceSid(uint16_t sid, uint8_t out[8]) {
    const Sess* s = bySid(sid);
    if (s == nullptr) return 0;
    return encodeSample(s->idx, s->arg, out);
}

void tick() {
    const uint32_t now = nowMs();
    for (int i = 0; i < MAX; i++) {
        Sess& s = s_s[i];
        if (!s.used) continue;
        const bool thr = s.hasGt || s.hasLt;
        const uint16_t period = s.rateMs != 0 ? s.rateMs : (thr ? EVAL_MS : 0);
        if (period == 0 || (int32_t)(now - s.nextMs) < 0) continue;
        s.nextMs = now + period;
        float v;
        if (!sample(s.idx, s.arg, &v)) continue;
        if (s.rateMs != 0) {  // stream: amostra continua
            uint8_t p[resproto::SENSOR_SAMPLE_LEN];
            const size_t n = resproto::encodeSensorSample(now, v, p);
            if (s_send != nullptr) {
                s_send(s.sid, s.mac, s.token, p, n);  // o hook escolhe o cabo
            } else {
                DataLink::send(s.mac, DataLink::KIND_DATA, s.sid, s.token, ++s.seq, p, n);
            }
        }
        if (thr) evalThreshold(s, now, v);
    }
}

}  // namespace SensorRes
