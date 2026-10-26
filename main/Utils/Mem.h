#ifndef CELEROS_UTILS_MEM_H
#define CELEROS_UTILS_MEM_H

#include <stddef.h>

#include "esp_heap_caps.h"

// Alocacao por capacidade: o "PSRAM primeiro, senao qualquer 8-bit" que
// estava repetido a mao em Runtime/ e OTA. Reduz a chance de esquecer o
// fallback ou trocar a ordem.
//
// Regra: `desired` e preferencia; `required` e o piso (Want::Any = qualquer
// 8-bit, o mesmo fallback antigo de MALLOC_CAP_8BIT). Nao lanca: OOM devolve
// nullptr, como todo o firmware (-fno-exceptions).
//
//	uint8_t* p = (uint8_t*)mem::alloc(n, mem::Want::Psram);      // prefere PSRAM
//	void* dma = mem::alloc(n, mem::Want::Internal);              // DMA/interna
namespace mem {

enum class Want : unsigned {
    Internal,  // RAM interna 8-bit
    Psram,     // PSRAM 8-bit
    Any,       // sem preferencia (heap 8-bit padrao)
};

inline unsigned caps(Want want) {
    switch (want) {
        case Want::Internal: return MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
        case Want::Psram: return MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
        default: return MALLOC_CAP_8BIT;
    }
}

inline void* alloc(size_t size, Want desired, Want required = Want::Any) {
    if (size == 0) return nullptr;
    void* p = heap_caps_malloc(size, caps(desired));
    if (p == nullptr && required != desired) {
        p = heap_caps_malloc(size, caps(required));
    }
    return p;
}

}  // namespace mem

#endif  // CELEROS_UTILS_MEM_H
