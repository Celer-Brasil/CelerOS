#include "SensorRes.h"

#include <string.h>
#include <strings.h>

#include "../Boards/Board.h"
#include "../Hardware/BoardIO.h"
#include "DataLink.h"

// Ponta nativa de sensor dos recursos da matilha (ver SensorRes.h). Amostra
// de 8 B no fio: [ts u32][f32 LE] — o tickTimers do Resources chama tick()
// sob o mutex, e o envio pelo DataLink e o mesmo caminho do controle em
// banda (sendEnv/KIND_DATA), seguro sob o lock.

namespace SensorRes {
namespace {

enum { S_LUM = 0, S_BAT = 1, S_COUNT = 2 };

struct Sess {
    bool used;
    uint16_t sid;
    uint8_t idx;
    uint8_t mac[6];
    uint32_t token;
    uint16_t rateMs;   // 0 = so por pedido
    uint32_t nextMs;
    uint16_t seq;
};
constexpr int MAX = 4;
constexpr uint16_t RATE_MIN = 250, RATE_MAX = 60000;
Sess s_s[MAX];

uint32_t nowMs() { return (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS); }

Sess* bySid(uint16_t sid) {
    for (int i = 0; i < MAX; i++) {
        if (s_s[i].used && s_s[i].sid == sid) return &s_s[i];
    }
    return nullptr;
}

// A leitura de hardware em si (BoardIO ja trata ADC/PMU/cache)
bool sample(int idx, float* v) {
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
        default:
            return false;
    }
}

int encodeSample(int idx, uint8_t out[8]) {
    float v;
    if (!sample(idx, &v)) return 0;
    const uint32_t ts = nowMs();
    memcpy(out, &ts, 4);
    memcpy(out + 4, &v, 4);
    return 8;
}

}  // namespace

int count() { return S_COUNT; }

const char* name(int idx) { return idx == S_LUM ? "lum" : "bat"; }

bool available(int idx) {
    if (idx < 0 || idx >= S_COUNT) return false;
    return idx == S_LUM ? BoardIO::hasLightSensor() : Board::profile().batteryPin >= 0;
}

int indexOf(const char* n) {
    if (n == nullptr) return -1;
    for (int i = 0; i < S_COUNT; i++) {
        if (strcasecmp(name(i), n) == 0) return i;
    }
    return -1;
}

bool busy(uint16_t sid) { return bySid(sid) != nullptr; }

bool serveStart(uint16_t sid, const uint8_t mac[6], uint32_t token, int sensorIdx, int rateMs) {
    if (!available(sensorIdx)) return false;
    if (bySid(sid) != nullptr) return true;  // OPEN repetido: ja serve
    Sess* s = nullptr;
    for (int i = 0; i < MAX && s == nullptr; i++) {
        if (!s_s[i].used) s = &s_s[i];
    }
    if (s == nullptr) return false;  // tabela cheia: 4 leitores por vez
    s->used = true;
    s->sid = sid;
    s->idx = (uint8_t)sensorIdx;
    memcpy(s->mac, mac, 6);
    s->token = token;
    if (rateMs < 0) rateMs = 0;
    s->rateMs = (uint16_t)(rateMs > RATE_MAX ? RATE_MAX : rateMs);
    s->nextMs = nowMs() + (s->rateMs != 0 ? s->rateMs : RATE_MAX);
    s->seq = 0;
    return true;
}

void serveStop(uint16_t sid) {
    Sess* s = bySid(sid);
    if (s != nullptr) s->used = false;
}

int sampleOnce(int sensorIdx, uint8_t out[8]) {
    if (!available(sensorIdx)) return 0;
    return encodeSample(sensorIdx, out);
}

void tick() {
    const uint32_t now = nowMs();
    for (int i = 0; i < MAX; i++) {
        Sess& s = s_s[i];
        if (!s.used || s.rateMs == 0 || (int32_t)(now - s.nextMs) < 0) continue;
        s.nextMs = now + s.rateMs;
        uint8_t p[8];
        const int n = encodeSample(s.idx, p);
        if (n > 0) DataLink::send(s.mac, DataLink::KIND_DATA, s.sid, s.token, ++s.seq, p, (size_t)n);
    }
}

}  // namespace SensorRes
