#pragma once
// Shim comum dos cores de emulador nativos (blobs CLRN) do CelerOS.
//
// Um core de emulador e um TU freestanding (tools/native/build_core.py) que
// nao inclui Arduino/ESP-IDF, nao cria task, nao abre arquivo e roda UM
// quadro por chamada de core_ctl. Este header entrega o que todo core
// precisa e que o host (test/cpp) e o blob compartilham:
//   - atributos IRAM/DMA/DRAM vazios (host e blob sao blocos planos);
//   - log no stderr no host, calado no device;
//   - emu_alloc: RAM interna primeiro no firmware, malloc no host/blob;
//   - emu_crc32: identificacao da ROM no header do save state (o formato do
//     NES usava o CRC do PRG; aqui todo o arquivo, que e o que o cart ve).
//
// O core NAO inclui este header para "usar o sistema": ele e deliberadamente
// pequeno para caber no orcamento de .bss/RAM interna do loader.

#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#if defined(CELER_HOST_TEST) || defined(EMU_BLOB)
// Host e blob CLRN: sem secoes especiais (o blob e um bloco plano na PSRAM;
// o estado quente vai de CLRN_FAST, definido no runtime.c do blob).
#ifndef IRAM_ATTR
#define IRAM_ATTR
#endif
#ifndef DMA_ATTR
#define DMA_ATTR
#endif
#ifndef DRAM_ATTR
#define DRAM_ATTR
#endif
#else
#include "esp_attr.h"
#include "esp_heap_caps.h"
#endif

#if defined(CELER_HOST_TEST)
#define EMU_LOGF(...) fprintf(stderr, __VA_ARGS__)
#else
#define EMU_LOGF(...) \
    do {              \
    } while (0)
#endif
#define EMU_LOG(...) EMU_LOGF(__VA_ARGS__)

#define EMU_UNUSED(x) (void)(x)

// Alocacao de carga (cart RAM, buffers de estado): no firmware tenta a RAM
// interna antes da PSRAM; no host/blob o malloc e o do runtime freestanding.
// Libera sempre com free().
inline void* emu_alloc(size_t n)
{
#if !defined(CELER_HOST_TEST) && !defined(EMU_BLOB)
    void* p = heap_caps_malloc(n, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (p != nullptr) return p;
#endif
    return malloc(n);
}

// CRC32 (IEEE, o mesmo do zlib/Anemoia) sem tabela: a ROM e lida uma vez no
// LOAD; 8 iteracoes por byte em 4-64 KB nao pesa e economiza 1 KB de rodata.
inline uint32_t emu_crc32(const void* data, size_t n)
{
    const uint8_t* p = (const uint8_t*)data;
    uint32_t crc = 0xFFFFFFFFu;
    while (n--) {
        crc ^= *p++;
        for (int i = 0; i < 8; i++)
            crc = (crc >> 1) ^ (0xEDB88320u & (uint32_t)(-(int32_t)(crc & 1u)));
    }
    return ~crc;
}

// Leitura little-endian de buffers de ROM/estado (o Xtensa e LE, mas o codigo
// tambem roda no host e nao depende de cast desalinhado).
static inline uint16_t emu_rd16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static inline uint32_t emu_rd32(const uint8_t* p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static inline void emu_wr16(uint8_t* p, uint16_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}
static inline void emu_wr32(uint8_t* p, uint32_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}
