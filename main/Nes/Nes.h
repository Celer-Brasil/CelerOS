#pragma once
// Fachada do nucleo Anemoia (emulador de NES, GPLv3, Shim06/Anemoia-ESP32)
// para o CelerOS. O Anemoia original orquestrava o nucleo com SD + TFT +
// FreeRTOS (task da APU, i2s_write, pushPixelsDMA); aqui o app JS e o dono:
//
//   load(bytes)  -> parse iNES + mapper; ROM inteira em memoria (PSRAM)
//   frame(btns)  -> 1 quadro (CPU+PPU); frame 256x240 RGB565 no alvo de
//                   renderTo() (o binding aponta para a regiao do frame do
//                   painel, sem copia intermediaria) ou no buffer proprio de
//                   openScreen(). audio sai pelo sink de setAudioSink
//                   (PcmFeed), alimentado pela task da APU no device.
//   saveState    -> formato do Anemoia ("ANEMOIA"+CRC) serializado em buffer;
//                   o binding persiste no FileSystem do app
//
// Arquitetura igual ao Anemoia original: a APU roda numa task propria (core
// 0 no device; no host o tick fica inline no clock() para o teste rodar
// sem FreeRTOS) e o frame sai direto no destino — o original empurrava
// blocos de 8 scanlines por DMA, aqui a PPU escreve linha a linha no alvo.
//
// Host-testavel: sem esp/arduino (o teste do test/cpp compila o mesmo TU).

#include "nes_compat.h"

#include <new>

#include "core/cartridge.h"
#include "core/cpu6502.h"

namespace nes {

constexpr int SCREEN_W = 256;
constexpr int SCREEN_H = 240;
constexpr uint32_t MAX_ROM_SIZE = 1U * 1024U * 1024U;  // teto de ROM (PSRAM aguenta; mappers maiores ficam de fora)

// Botões no bitmask do controller (mesma ordem do Anemoia/protocolo NES):
constexpr uint8_t BTN_A = 1 << 0;
constexpr uint8_t BTN_B = 1 << 1;
constexpr uint8_t BTN_SELECT = 1 << 2;
constexpr uint8_t BTN_START = 1 << 3;
constexpr uint8_t BTN_UP = 1 << 4;
constexpr uint8_t BTN_DOWN = 1 << 5;
constexpr uint8_t BTN_LEFT = 1 << 6;
constexpr uint8_t BTN_RIGHT = 1 << 7;

class Nes
{
public:
    ~Nes();

    // O objeto inteiro (~21 KB: RAM do 6502, VRAM/OAM/scanline da PPU, bloco
    // de 8 linhas, APU) e o estado QUENTE do emulador: o Anemoia o tinha como
    // `static Nes nes` na DRAM. Um `new` comum cai na PSRAM (limiar de 1 KB
    // do malloc), onde cada acesso disputa o barramento com o DMA do painel
    // RGB — a emulacao ficava 2x mais lenta. Vai para a RAM interna; PSRAM
    // so se a interna nao tiver o bloco.
    static void* operator new(size_t size, const std::nothrow_t&) noexcept;
    static void operator delete(void* p) noexcept;

    // Parse iNES + cria o mapper. Nao copia a ROM: data tem que viver enquanto
    // o cartucho estiver inserido (o binding cuida do ciclo: readFile -> load
    // -> unload). Devolve false para arquivo curto, mapper fora da lista ou
    // falha de alocacao do mapper (detalhe em *err).
    bool load(const uint8_t* data, uint32_t size, uint32_t* crc32 = nullptr, uint8_t* mapperId = nullptr,
              const char** err = nullptr);
    void unload();
    bool loaded() const { return cart != nullptr && cart->isValid() && cpu.bus.cart != nullptr; }

    // Framebuffer 256x240 RGB565 proprio, alocado aqui (PSRAM no device).
    // Caminho do host/fallback: instala um sink interno que copia os blocos
    // de 8 linhas do PPU para este buffer (o teste e o emulador local leem
    // framebuffer()).
    bool openScreen();
    void closeScreen();
    const uint16_t* framebuffer() const { return fb; }

    // Sink dos blocos de 8 scanlines (o Anemoia empurrava por DMA no TFT; o
    // binding entrega ao pushImage do LovyanGFX). Substitui o alvo de
    // openScreen quando o app desenha no vidro.
    void setChunkSink(Ppu2C02::ChunkSink cb, void* ctx) { cpu.bus.ppu.setChunkSink(cb, ctx); }
    // Byte order da paleta: true = tabelas _swap (o caminho pushImage do OS
    // copia os valores como vierem para o framebuffer swapped do painel).
    void setByteSwap(bool on) { cpu.bus.ppu.setPaletteByteSwap(on); }

    void reset();
    void frame(uint8_t buttons, bool render = true);

    // Save state no formato do Anemoia ("ANEMOIA" + CRC hex + RAM/CPU/PPU/mapper).
    // out/in são buffers de memoria do nes::File (o binding faz o FS).
    bool saveState(File& out);
    bool loadState(File& in);

    void setAudioSink(Apu2A03::AudioSink sink) { cpu.apu.setAudioSink(sink); }
    void setVolume(uint8_t vol) { cpu.apu.setVolume(vol); }

    // Task da APU no device (core 0, como o Anemoia): clocka a APU a CPU/2
    // (~895 kHz) em fatias de 1 ms; o sink (PcmFeed) da o backpressure
    // quando a fila enche. No host e no-op (tick inline no clock()).
    void apuTaskStart();
    void apuTaskStop();

    Cpu6502 cpu;

private:
    Cartridge* cart = nullptr;
    uint16_t* fb = nullptr;
#ifndef CELER_HOST_TEST
    void* apu_task = nullptr;  // TaskHandle_t
#endif
};

}  // namespace nes
