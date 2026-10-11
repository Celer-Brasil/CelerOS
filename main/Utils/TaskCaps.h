#ifndef CELEROS_UTILS_TASK_CAPS_H
#define CELEROS_UTILS_TASK_CAPS_H

// Task com pilha na PSRAM ONDE o build permite (S3 com
// CONFIG_SPIRAM_ALLOW_STACK_EXTERNAL_MEMORY); senao pilha interna com o
// tamanho alternativo. No ESP32 classico (esp32-cam) o xTaskCreateWithCaps
// com MALLOC_CAP_SPIRAM caia no configASSERT(portVALID_STACK_MEM) do FreeRTOS
// e a placa entrava em loop de panico (bancada 2026-10-11). O delete segue o
// MESMO modo da criacao (WithCaps x comum).
//
// So para tasks que nao tocam a flash (pilha externa + cache desligada =
// crash): log com staging em RAM e ok; NVS/FS nao.

#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/task.h"
#include "esp_heap_caps.h"
#include "sdkconfig.h"

inline BaseType_t celerTaskCreate(TaskFunction_t fn, const char* name, uint32_t extStack,
                                  uint32_t intStack, void* arg, UBaseType_t prio, TaskHandle_t* out) {
#if CONFIG_SPIRAM_ALLOW_STACK_EXTERNAL_MEMORY
    (void)intStack;
    return xTaskCreateWithCaps(fn, name, extStack, arg, prio, out, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
#else
    (void)extStack;
    return xTaskCreate(fn, name, intStack, arg, prio, out);
#endif
}

inline void celerTaskDelete(TaskHandle_t h) {
#if CONFIG_SPIRAM_ALLOW_STACK_EXTERNAL_MEMORY
    vTaskDeleteWithCaps(h);
#else
    vTaskDelete(h);
#endif
}

#endif  // CELEROS_UTILS_TASK_CAPS_H
