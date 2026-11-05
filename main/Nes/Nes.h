#pragma once
// Fachada do nucleo Anemoia (emulador de NES, GPLv3, Shim06/Anemoia-ESP32)
// para o CelerOS. O Anemoia original orquestrava o nucleo com SD + TFT +
// FreeRTOS (task da APU, i2s_write, pushPixelsDMA); aqui o app JS e o dono:
//
//   load(bytes)  -> parse iNES + mapper; ROM inteira em memoria (PSRAM)
//   frame(btns)  -> 1 quadro (CPU+PPU+APU inline); frame 256x240 RGB565 no
//                   buffer entregue em open(); o app blit no sprite do pool
//                   audio sai pelo sink setado em setAudioSink (PcmFeed)
//   saveState    -> formato do Anemoia ("ANEMOIA"+CRC) serializado em buffer;
//                   o binding persiste no FileSystem do app
//
// Host-testavel: sem esp/arduino (o teste do test/cpp compila o mesmo TU).

#include "nes_compat.h"

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

    // Parse iNES + cria o mapper. Nao copia a ROM: data tem que viver enquanto
    // o cartucho estiver inserido (o binding cuida do ciclo: readFile -> load
    // -> unload). Devolve false para arquivo curto, mapper fora da lista ou
    // falha de alocacao do mapper (detalhe em *err).
    bool load(const uint8_t* data, uint32_t size, uint32_t* crc32 = nullptr, uint8_t* mapperId = nullptr,
              const char** err = nullptr);
    void unload();
    bool loaded() const { return cart != nullptr && cart->isValid() && cpu.bus.cart != nullptr; }

    // Framebuffer 256x240 RGB565, alocado aqui (PSRAM no device). Tem que ser
    // aberto antes do primeiro frame. *fb nunca e null depois de open() ok.
    bool openScreen();
    void closeScreen();
    const uint16_t* framebuffer() const { return fb; }

    void reset();
    void frame(uint8_t buttons, bool render = true);

    // Save state no formato do Anemoia ("ANEMOIA" + CRC hex + RAM/CPU/PPU/mapper).
    // out/in são buffers de memoria do nes::File (o binding faz o FS).
    bool saveState(File& out);
    bool loadState(File& in);

    void setAudioSink(Apu2A03::AudioSink sink) { cpu.apu.setAudioSink(sink); }
    void setVolume(uint8_t vol) { cpu.apu.setVolume(vol); }

    Cpu6502 cpu;

private:
    Cartridge* cart = nullptr;
    uint16_t* fb = nullptr;
};

}  // namespace nes
