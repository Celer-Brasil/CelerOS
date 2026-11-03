#include "Dht.h"

#include "driver/gpio.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <stdint.h>

// ============================================================================
// Implementacao do DHT11/DHT22 (ver Dht.h).
// ============================================================================

namespace {

portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

// Cache por (pino, tipo): o chip nao aceita leituras mais rapidas que 1 s
// (DHT11) ou 2 s (DHT22); devolver a ultima evita falhas em loop.
int s_pin = -1;
int s_type = 0;
uint32_t s_lastMs = 0;
Dht::Reading s_last;

int waitLevel(int pin, int level, int64_t timeoutUs) {
    const int64_t t0 = esp_timer_get_time();
    while (gpio_get_level((gpio_num_t)pin) != level) {
        if (esp_timer_get_time() - t0 > timeoutUs) return -1;
    }
    return 0;
}

// Dentro da janela critica: resposta (80 us low + 80 us high) e 40 bits
// (50 us low + high de 26..28 us = 0 / 70 us = 1).
int readBits(int pin, uint8_t bytes[5]) {
    if (waitLevel(pin, 0, 250) < 0) return -1;  // resposta: low
    if (waitLevel(pin, 1, 250) < 0) return -1;  // resposta: high
    for (int i = 0; i < 40; i++) {
        if (waitLevel(pin, 0, 120) < 0) return -2;  // 50 us low do bit
        if (waitLevel(pin, 1, 120) < 0) return -2;  // inicio do high
        const int64_t t0 = esp_timer_get_time();
        if (waitLevel(pin, 0, 120) < 0) return -2;  // fim do high
        const int64_t dt = esp_timer_get_time() - t0;
        if (dt > 45) bytes[i >> 3] |= (uint8_t)(1u << (7 - (i & 7)));
    }
    return 0;
}

bool decode(const uint8_t b[5], int type, Dht::Reading* out) {
    const uint8_t sum = (uint8_t)(b[0] + b[1] + b[2] + b[3]);
    if (sum != b[4]) {
        out->ok = false;
        out->error = "checksum";
        return false;
    }
    if (type == 11) {
        out->humidity = b[0] + b[1] * 0.1f;
        float t = b[2] + (b[3] & 0x7F) * 0.1f;
        if (b[3] & 0x80) t = -t;
        out->tempC = t;
    } else {
        out->humidity = (float)(((uint16_t)b[0] << 8) | b[1]) * 0.1f;
        const int16_t raw = (int16_t)((((uint16_t)b[2] & 0x7F) << 8) | b[3]);
        float t = raw * 0.1f;
        if (b[2] & 0x80) t = -t;
        out->tempC = t;
    }
    out->ok = true;
    out->error = "";
    return true;
}

}  // namespace

namespace Dht {

bool read(int pin, int type, Reading* out) {
    if (out == nullptr) return false;
    const uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
    const uint32_t minMs = (type == 11) ? 1000u : 2000u;
    if (s_pin == pin && s_type == type && s_lastMs != 0 && (now - s_lastMs) < minMs) {
        *out = s_last;
        return s_last.ok;
    }

    *out = Reading{};
    uint8_t bytes[5] = {0};

    // Start: prende o data em low (18 ms no DHT11, 1 ms no DHT22) e solta.
    gpio_set_direction((gpio_num_t)pin, GPIO_MODE_OUTPUT_OD);
    gpio_set_level((gpio_num_t)pin, 0);
    vTaskDelay(pdMS_TO_TICKS(type == 11 ? 18 : 1));
    gpio_set_level((gpio_num_t)pin, 1);
    gpio_set_direction((gpio_num_t)pin, GPIO_MODE_INPUT);
    gpio_set_pull_mode((gpio_num_t)pin, GPIO_PULLUP_ONLY);

    // ~5 ms de janela critica: um ISR no meio dos 40 bits trocaria 0 por 1.
    taskENTER_CRITICAL(&s_mux);
    const int rc = readBits(pin, bytes);
    taskEXIT_CRITICAL(&s_mux);

    if (rc == -1) {
        out->error = "sem resposta";
    } else if (rc == -2) {
        out->error = "timeout";
    } else {
        decode(bytes, type, out);
    }

    s_pin = pin;
    s_type = type;
    s_lastMs = now;
    s_last = *out;
    return out->ok;
}

void reset() {
    s_pin = -1;
    s_type = 0;
    s_lastMs = 0;
    s_last = Reading{};
}

}  // namespace Dht
