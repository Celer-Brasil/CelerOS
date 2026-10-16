#include "GpioRes.h"

#include <stdio.h>
#include <stdlib.h>
#include <strings.h>
#include <string.h>

#include "esp_log.h"
#include "driver/gpio.h"
#include "esp_private/esp_gpio_reserve.h"

#include "../Boards/Board.h"
#include "../Hardware/BoardIO.h"

// Ponta nativa de GPIO/relé dos recursos da matilha (ver GpioRes.h). As
// guardas de pino reproduzem as do System.gpio (Runtime/JsGpio.cpp): um pino
// de saida remoto errado nao pode alcançar flash/PSRAM.

namespace GpioRes {
namespace {

const char* TAG = "celer.gpio";

// "chave":valor no JSON de params do OPEN (sem parser: o cliente monta;
// mesma forma do paramInt do Resources)
int paramInt(const uint8_t* params, size_t plen, const char* key, int def) {
    char k[16];
    snprintf(k, sizeof(k), "\"%s\":", key);
    const size_t kl = strlen(k);
    for (size_t i = 0; i + kl < plen; i++) {
        if (memcmp(params + i, k, kl) == 0) return atoi((const char*)params + i + kl);
    }
    return def;
}

struct Sess {
    bool used;
    uint16_t sid;
    bool relay;    // true = rele (idx 1-based do perfil); false = pino generico
    int idx;       // numero do rele ou pino do GPIO
};
constexpr int MAX = 8;  // = LEASES do Resources
Sess s_s[MAX];
// Pinos que NOSSAS sessoes reservaram: a 2a sessao no mesmo pino nao pode
// morrer na guarda de "reservado" (o IDF reserva no ledc/gpio_config; o
// bitmap e o s_jsPins do JsGpio, aqui por sessao de rede)
uint64_t s_myPins = 0;

Sess* bySid(uint16_t sid) {
    for (int i = 0; i < MAX; i++) {
        if (s_s[i].used && s_s[i].sid == sid) return &s_s[i];
    }
    return nullptr;
}

Sess* freeSlot() {
    for (int i = 0; i < MAX; i++) {
        if (!s_s[i].used) return &s_s[i];
    }
    return nullptr;
}

// Mesmas guardas do requirePin do JsGpio (sem o bitmap dos apps): pino
// valido de saida, nao reservado pelo boot (flash/PSRAM) e fora do
// gpioDeniedMask do perfil (linhas DQ da PSRAM octal do S3)
bool pinAllowed(int pin) {
    if (!GPIO_IS_VALID_OUTPUT_GPIO(pin) || pin < 0 || pin >= 64) return false;
    const uint64_t bit = 1ULL << pin;
    if ((s_myPins & bit) != 0) return true;  // nosso: OPEN repetido/reaberto
    if (esp_gpio_is_reserved(bit) || (Board::profile().gpioDeniedMask & bit) != 0) return false;
    return true;
}

void writeOut(const Sess& s, bool on) {
    if (s.relay) {
        BoardIO::setRelay(s.idx, on);
    } else {
        digitalWrite(s.idx, on ? HIGH : LOW);
    }
}

int readBack(const Sess& s) {
    return s.relay ? BoardIO::relayState(s.idx) : digitalRead(s.idx);
}

}  // namespace

bool available() { return Board::profile().relay.count > 0; }

bool busy(uint16_t sid) { return bySid(sid) != nullptr; }

bool serveStart(uint16_t sid, const char* name, const uint8_t* params, size_t plen) {
    if (name == nullptr || name[0] == '\0') return false;
    if (bySid(sid) != nullptr) return true;  // OPEN repetido: ja serve
    Sess s = {};
    s.used = true;  // NUNCA esquecer: o *slot = s copia o struct inteiro —
    s.sid = sid;    // sem isto a sessao nasce morta (bySid nao casa NUNCA:
                    // write/auto-off caem no "sem sessao") — bancada 2026-10-16
    if (strncasecmp(name, "rele", 4) == 0) {
        const int n = atoi(name + 4);
        if (n < 1 || n > Board::profile().relay.count) return false;
        s.relay = true;
        s.idx = n;
    } else if (strcasecmp(name, "gpio") == 0) {
        const int pin = paramInt(params, plen, "pin", -1);
        if (!pinAllowed(pin)) return false;
        s.relay = false;
        s.idx = pin;
        s_myPins |= 1ULL << pin;
        pinMode(pin, OUTPUT);
    } else {
        return false;  // nome de TYPE_GPIO desconhecido
    }
    Sess* slot = freeSlot();
    if (slot == nullptr) {
        if (!s.relay) s_myPins &= ~(1ULL << s.idx);
        return false;
    }
    *slot = s;
    return true;
}

void serveStop(uint16_t sid, bool autoOff) {
    Sess* s = bySid(sid);
    if (s == nullptr) return;
    if (autoOff) {  // o fim do lease desliga o atuador (oraculo do bench)
        writeOut(*s, false);
        ESP_LOGI(TAG, "\"%s\": auto-off do fim da sessao (estado %d)", s->relay ? "rele" : "gpio",
                 readBack(*s));
    }
    if (!s->relay) {
        s_myPins &= ~(1ULL << s->idx);
        pinMode(s->idx, INPUT);  // para de dirigir o pino (rele nao solta, BoardIO cuida)
    }
    s->used = false;
}

bool data(uint16_t sid, const uint8_t* d, size_t n, uint8_t* reply, size_t* replyLen) {
    *replyLen = 0;
    const Sess* s = bySid(sid);
    if (s == nullptr || d == nullptr || n < 1) {
        ESP_LOGW(TAG, "DATA sem sessao %u (n=%u)", sid, (unsigned)n);
        return false;
    }
    switch (d[0]) {
        case 1: {  // WRITE [1][0|1]
            if (n < 2) return false;
            writeOut(*s, d[1] != 0);
            ESP_LOGI(TAG, "\"%s\": WRITE %d -> estado %d", s->relay ? "rele" : "gpio", d[1],
                     readBack(*s));
            return true;
        }
        case 2:  // READ -> [2][0|1]
            reply[0] = 2;
            reply[1] = readBack(*s) > 0 ? 1 : 0;
            *replyLen = 2;
            ESP_LOGI(TAG, "\"%s\": READ -> %d", s->relay ? "rele" : "gpio", reply[1]);
            return true;
        default:  // ops de onda futura (pulso/PWM): erro explicito
            reply[0] = 0xFF;
            *replyLen = 1;
            return true;
    }
}

}  // namespace GpioRes
