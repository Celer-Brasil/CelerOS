#include "GpioRes.h"
#include "ResProto.h"

#include <stdio.h>
#include <stdlib.h>
#include <strings.h>
#include <string.h>

#include "esp_log.h"
#include "driver/gpio.h"
#include "esp_private/esp_gpio_reserve.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <Arduino.h>  // pinMode/digitalWrite/analogWrite (Compat)

#include "../Boards/Board.h"
#include "../Hardware/BoardIO.h"

// Ponta nativa de GPIO/relé dos recursos da matilha (ver GpioRes.h). As
// guardas de pino reproduzem as do System.gpio (Runtime/JsGpio.cpp): um pino
// de saida remoto errado nao pode alcançar flash/PSRAM.

namespace GpioRes {
namespace {

const char* TAG = "celer.gpio";

// pilha dos pulsos: o tick compara o prazo (mesmo relogio do SensorRes)
uint32_t nowMs() { return (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS); }

// parse de params do OPEN ({"pin":N}) e o paramInt unico do ResProto.h
using resproto::paramInt;

struct Sess {
    bool used;
    uint16_t sid;
    bool relay;    // true = rele (idx 1-based do perfil); false = pino generico
    int idx;       // numero do rele ou pino do GPIO
    // pulso em curso (API 47): o tick desliga no prazo. WRITE/PWM cancelam.
    bool pulse;
    uint32_t pulseEndMs;
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
    s->pulse = false;  // sessao morta nao aciona mais tarde
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

// Pilha dos pulsos: o tick (tickTimers) desliga o que venceu. Sem task nova:
// o prazo e comparado no mesmo tick do Resources (50 ms de granularidade).
void tick() {
    const uint32_t now = nowMs();
    for (int i = 0; i < MAX; i++) {
        Sess& s = s_s[i];
        if (!s.used || !s.pulse || (int32_t)(now - s.pulseEndMs) < 0) continue;
        s.pulse = false;
        writeOut(s, false);
        ESP_LOGI(TAG, "\"%s\": pulso terminou (estado %d)", s.relay ? "rele" : "gpio", readBack(s));
    }
}

bool data(uint16_t sid, const uint8_t* d, size_t n, uint8_t* reply, size_t* replyLen) {
    *replyLen = 0;
    Sess* s = bySid(sid);
    if (s == nullptr || d == nullptr || n < 1) {
        ESP_LOGW(TAG, "DATA sem sessao %u (n=%u)", sid, (unsigned)n);
        return false;
    }
    // Forma TEXTUAL (API 47): {"w":0|1} / {"r":1} / {"p":ms} / {"d":%}.
    // O app JS manda objetos porque string UTF-8 codifica byte >0x7F em dois
    // (ms de pulso de 500 = 0xF4 nao viaja cru); o binario abaixo continua
    // para o celerctl e firmwares <= 46.
    if (d[0] == '{') {
        using resproto::paramHas;
        using resproto::paramInt;
        if (paramHas(d, n, "r")) {
            reply[0] = resproto::GPIO_READ;
            reply[1] = readBack(*s) > 0 ? 1 : 0;
            *replyLen = 2;
            return true;
        }
        if (paramHas(d, n, "w")) {
            s->pulse = false;
            writeOut(*s, paramInt(d, n, "w", 0) != 0);
            return true;
        }
        if (paramHas(d, n, "p")) {
            const int ms = paramInt(d, n, "p", 0);
            if (ms <= 0 || ms > 0xFFFF) {
                reply[0] = resproto::RES_ERR;
                *replyLen = 1;
                return true;
            }
            writeOut(*s, true);
            s->pulse = true;
            s->pulseEndMs = nowMs() + (uint32_t)ms;
            ESP_LOGI(TAG, "\"%s\": PULSO de %dms", s->relay ? "rele" : "gpio", ms);
            return true;
        }
        if (paramHas(d, n, "d")) {
            const int duty = paramInt(d, n, "d", -1);
            if (s->relay || duty < 0 || duty > 100) {
                reply[0] = resproto::RES_ERR;  // rele comuta rede: nao e dimmer
                *replyLen = 1;
                return true;
            }
            s->pulse = false;
            analogWrite(s->idx, (int)((uint32_t)duty * 255 / 100));
            ESP_LOGI(TAG, "gpio%d: PWM %d%%", s->idx, duty);
            return true;
        }
        reply[0] = resproto::RES_ERR;
        *replyLen = 1;
        return true;
    }
    switch (d[0]) {
        case resproto::GPIO_WRITE: {  // WRITE [1][0|1]
            if (n < 2) return false;
            s->pulse = false;  // escrita explicita manda no pulso em curso
            writeOut(*s, d[1] != 0);
            ESP_LOGI(TAG, "\"%s\": WRITE %d -> estado %d", s->relay ? "rele" : "gpio", d[1],
                     readBack(*s));
            return true;
        }
        case resproto::GPIO_READ:  // READ -> [2][0|1]
            reply[0] = resproto::GPIO_READ;
            reply[1] = readBack(*s) > 0 ? 1 : 0;
            *replyLen = 2;
            ESP_LOGI(TAG, "\"%s\": READ -> %d", s->relay ? "rele" : "gpio", reply[1]);
            return true;
        case resproto::GPIO_PULSE: {  // PULSO [3][ms u16 LE]
            uint16_t ms = 0;
            if (!resproto::decodeGpioPulse(d, n, &ms) || ms == 0) {
                reply[0] = resproto::RES_ERR;
                *replyLen = 1;
                return true;
            }
            writeOut(*s, true);
            s->pulse = true;
            s->pulseEndMs = nowMs() + ms;
            ESP_LOGI(TAG, "\"%s\": PULSO de %ums", s->relay ? "rele" : "gpio", (unsigned)ms);
            return true;
        }
        case resproto::GPIO_PWM: {  // PWM [4][duty 0..100] — so pino generico
            if (n < 2 || d[1] > 100) {
                reply[0] = resproto::RES_ERR;
                *replyLen = 1;
                return true;
            }
            if (s->relay) {  // rele comuta rede eletrica: nao e dimmer
                reply[0] = resproto::RES_ERR;
                *replyLen = 1;
                return true;
            }
            s->pulse = false;
            analogWrite(s->idx, (int)((uint32_t)d[1] * 255 / 100));
            ESP_LOGI(TAG, "gpio%d: PWM %u%%", s->idx, (unsigned)d[1]);
            return true;
        }
        default:  // op desconhecida: erro explicito
            reply[0] = resproto::RES_ERR;
            *replyLen = 1;
            return true;
    }
}

}  // namespace GpioRes
