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
