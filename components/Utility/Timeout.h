//
// Created by maikeu on 08/07/2021.
//

#ifndef TIMEOUT_H
#define TIMEOUT_H

#ifdef STM32L1
#include <FreeRTOS.h>
#include <task.h>
#elif defined(ESP_PLATFORM)

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#else
// Host (g++ puro, sem FreeRTOS — mesmo padrao do Event.h): tick = ms
// monotonicos do processo e pdMS_TO_TICKS identidade. timeoutHostClock()
// deixa o teste congelar o relogio para provar bordas (>=) e wrap de
// uint32 sem depender de sleep; no firmware esse branch nao existe.
#include <cstdint>
#include <ctime>

using TickType_t = uint32_t;

struct TimeoutHostClock {
    bool fixed = false;   /**< true = xTaskGetTickCount() devolve value fixo */
    uint32_t value = 0;   /**< tick congelado para o teste */
};

inline TimeoutHostClock& timeoutHostClock() {
    static TimeoutHostClock s;
    return s;
}

inline TickType_t xTaskGetTickCount() {
    TimeoutHostClock& c = timeoutHostClock();
    if (c.fixed) {
        return static_cast<TickType_t>(c.value);
    }
    timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return static_cast<TickType_t>(static_cast<uint64_t>(ts.tv_sec) * 1000u +
                                   static_cast<uint64_t>(ts.tv_nsec) / 1000000u);
}

inline TickType_t pdMS_TO_TICKS(TickType_t ms) {
    return ms;
}
#endif

class Timeout {
public:
    Timeout(uint32_t timeout, bool start) : Timeout() {
        _timeout = pdMS_TO_TICKS(timeout);
        _running = start;
    }

    Timeout() {
        _start = xTaskGetTickCount();
    }

    void SetTimeout(uint32_t timeout) {
        _timeout = pdMS_TO_TICKS(timeout);
    }

    void Start() {
        _start = xTaskGetTickCount();
        _running = true;
    }


    void Stop() {
        _running = false;
    }

    bool TrueUntilTimeout() {
        if (!_running) return true;
        auto now = xTaskGetTickCount();
        if (now - _start < _timeout) {
            return true;
        }
        return false;
    }

    bool TimeoutOccurred() {
        if (!_running) return false;
        auto now = xTaskGetTickCount();
        // >= : no instante exato do timeout TrueUntilTimeout() ja devolve
        // false; com '>' o mesmo instante respondia "nao expirou" nos dois
        return (now - _start >= _timeout);
    }

private:
    bool _running = false;
    TickType_t _timeout = UINT32_MAX;
    TickType_t _start = 0;
};

#endif //TIMEOUT_H
