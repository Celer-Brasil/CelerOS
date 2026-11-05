#pragma once
// Shim do nucleo Anemoia (emulador NES, GPLv3, Shim06) para o CelerOS.
//
// O nucleo em core/ veio do projeto Anemoia-ESP32 e esperava Arduino/ESP-IDF:
// SD (File de save state), IRAM_ATTR/DMA_ATTR, driver/i2s (escrita bloqueante
// na task da APU), profiler e debug LOGF. Tudo isso vive aqui:
//   - File            -> buffer de memoria (save state serializa em RAM; o
//                        JS pega os bytes e persiste no FileSystem do app)
//   - IRAM/DMA_ATTR   -> no-op (host e CelerOS nao usam secoes IRAM aqui)
//   - LOG/LOGF        -> stderr no host (CELER_HOST_TEST), calado no device
//   - PROFILE_SCOPE   -> no-op (o profiler de ciclos ficou no Anemoia)
//   - MappedROM       -> ponteiros prg/chr direto no buffer da ROM (o Anemoia
//                        mmapava a particao "nesrom"; aqui a ROM inteira ja
//                        esta na PSRAM, o efeito e o mesmo: banco = ponteiro)
// O nucleo nao inclui nada de esp/arduino: host e device compilam os mesmos
// fontes (gate g++ do test/cpp e build IDF compartilham esta arvore).

#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <vector>

#if defined(CELER_HOST_TEST)
// No host os atributos de secao nao existem. No device o esp_attr.h do IDF
// define os reais: incluir aqui (antes de qualquer uso do nucleo) para nao
// redefinir — o build do firmware e -Werror.
#define IRAM_ATTR
#define DMA_ATTR
#define DRAM_ATTR
#else
#include "esp_attr.h"
#endif

#if !defined(CELER_HOST_TEST)
#include "esp_heap_caps.h"
#endif
#include <stdlib.h>

// Alocacao do estado quente (objeto Nes, CHR-RAM, PRG-RAM dos mappers): RAM
// interna primeiro. No Anemoia (ESP32 sem PSRAM) tudo isso era DRAM; aqui um
// malloc acima de 1 KB vai para a PSRAM, que no 4848 divide o barramento com
// o DMA do painel RGB e custa cache miss a cada linha renderizada. Fallback
// na PSRAM para nao recusar o jogo. Libera com free() (vale para os dois).
inline void* nes_fast_alloc(size_t size)
{
#if !defined(CELER_HOST_TEST)
    void* p = heap_caps_malloc(size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (p != nullptr) return p;
#endif
    return malloc(size);
}

#if defined(CELER_HOST_TEST)
#define NES_LOGF(...) fprintf(stderr, __VA_ARGS__)
#else
#define NES_LOGF(...) \
    do {              \
    } while (0)
#endif
#define LOG(...)   NES_LOGF(__VA_ARGS__)
#define LOGF(...)  NES_LOGF(__VA_ARGS__)

// profiler.h do Anemoia: secoes e relatorio por quadro eram Instrumentação de
// ciclos com esp_timer; aqui viram no-op (o celerctl top mede o quadro inteiro).
#define PROFILE_SCOPE(x)
inline void profileReport(int)
{
}

namespace nes {

// "File" do SD no Anemoia: so write(buf,n)/read(buf,n) eram usados para
// serializar save state. Buffer de memoria com a mesma cara; write acumula
// (save), read consome (load). Bytes saem/entram pelo binding (FileSystem).
class File
{
public:
    File() {}
    explicit File(const uint8_t* data, size_t size) : _r(data), _size(size) {}

    size_t write(const uint8_t* p, size_t n)
    {
        _w.insert(_w.end(), p, p + n);
        return n;
    }
    size_t read(uint8_t* p, size_t n)
    {
        if (_rpos + n > _size) n = (_rpos < _size) ? _size - _rpos : 0;
        memcpy(p, _r + _rpos, n);
        _rpos += n;
        return n;
    }

    const std::vector<uint8_t>& bytes() const { return _w; }

private:
    std::vector<uint8_t> _w;       // modo escrita (save)
    const uint8_t* _r = nullptr;   // modo leitura (load)
    size_t _size = 0;
    size_t _rpos = 0;
};

// Antes em flash_mmap.h: o Anemoia mmapava a particao "nesrom"; aqui os
// ponteiros caem dentro do buffer da ROM carregada (PSRAM). mmap_handle sai.
struct MappedROM
{
    const uint8_t* prg_base = nullptr;
    const uint8_t* chr_base = nullptr;
    uint32_t prg_size = 0;
    uint32_t chr_size = 0;
};

}  // namespace nes

// O nucleo Anemoia usa "File" e "MappedROM" sem qualificacao (vinham do
// Arduino SD e do flash_mmap.h globais): reexporta no escopo de quem inclui.
using nes::File;
using nes::MappedROM;
