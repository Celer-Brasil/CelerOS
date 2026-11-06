#pragma once
// Fachada do Atari 2600: barramento (TIA/RIOT/RAM/cart), frame e save state.
//
// O barramento do 2600 (addr < 0x1000):
//   A7=0            -> TIA (registrador = addr & 0x3F; espelhos ate 0x0FFF)
//   A7=1, A9=0      -> RAM do RIOT (128 B, espelhada)
//   A7=1, A9=1      -> registradores do RIOT (SWCHA/SWCHB/INTIM/TIMINT)
//   A12=1           -> cartucho (0xF000-0xFFFF no PC / 0x1000-0x1FFF no 6507)
// Snoops: 3F escreve em $003F para trocar banco; UA le $0220/$0240.

#include "../common/cpu6502_cycle.h"
#include "../common/emu_audio.h"
#include "../common/emu_state.h"
#include "core/cart_a2600.h"
#include "core/riot6532.h"
#include "core/tia.h"

namespace emu {
namespace a2600 {

class A2600
{
public:
    bool load(const uint8_t* rom, uint32_t size, int mapperOverride = -1);
    void reset();

    void setFramebuffer(uint16_t* fb);
    void setPcm(int16_t* buf, uint32_t cap);

    // buttons: bit0 fire, bit2 select, bit3 reset, bits 4-7 direcoes.
    // switches: bit2 cor, bit3 dif A P0, bit4 dif A P1.
    void frame(uint8_t buttons, uint8_t switches, const uint8_t* paddles);

    uint32_t pcmLen() const { return audio_.bytes(); }
    const uint16_t* frameBuffer() const { return fb_; }
    int width() const { return Tia::kVisibleWidth; }
    int height() const { return Tia::kVisibleHeight; }
    int mapper() const { return cart_.mapper(); }
    uint32_t romCrc() const { return romCrc_; }
    uint64_t cycles() const { return cpu_.cycles; }

    // diagnostico (testes host): PC e quantas leituras de input o jogo fez
    uint16_t cpuPc() const { return cpu_.pc; }
    uint32_t dbgInptReads(int i) const { return tia_.dbgInptReads(i); }
    uint32_t dbgPortReads(int r) const { return riot_.dbgReads(r); }

    void save(StateWriter& w) const;
    bool loadState(StateReader& r);

private:
    static uint8_t busRead(void* ctx, uint16_t addr);
    static void busWrite(void* ctx, uint16_t addr, uint8_t v);
    static void busTick(void* ctx);
    static bool busStalled(void* ctx);

    Cpu6502 cpu_;
    Tia tia_;
    CartA2600 cart_;
    Riot6532 riot_;
    CpuBus bus_{};
    AudioDownsampler audio_;
    uint16_t* fb_ = nullptr;
    uint32_t romCrc_ = 0;
    uint8_t switches_ = 0;
    uint8_t paddles_[4] = {0, 0, 0, 0};
};

}  // namespace a2600
}  // namespace emu
