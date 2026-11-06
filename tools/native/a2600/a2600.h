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
    // quadro sem saida (frameskip) ou por linha (FRAME_SCREEN); ver Tia
    void setVideoOut(uint16_t* fb, Tia::LineSink sink, void* ctx)
    {
        tia_.setFramebuffer(fb);
        tia_.setLineSink(sink, ctx);
    }
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
    // RAM do RIOT (zero page do jogo) para inspecao no host
    uint8_t dbgRam(uint16_t addr) const { return riot_.readRam(addr); }
    // posicao horizontal atual de um objeto da TIA (color clocks)
    int dbgPlayerPos(int i) const { return tia_.dbgPos(i); }
    uint32_t dbgTiaReadCounter(int a) const { return tia_.dbgReadCounter(a); }

    // sincroniza TIA/RIOT antes de serializar (o estado pendente vira estado)
    void save(StateWriter& w);
    bool loadState(StateReader& r);

    // barramento do 6507 (inline no executor via Cpu6502::stepT)
    uint8_t busRead(uint16_t addr);
    void busWrite(uint16_t addr, uint8_t v);

private:
    struct Bus {
        A2600* s;
        EMU_CPU_INLINE uint8_t read(uint16_t a) { return s->busRead(a); }
        EMU_CPU_INLINE void write(uint16_t a, uint8_t v) { s->busWrite(a, v); }
        // TIA/RIOT andam em lote no acesso (syncTia/syncRiot): o ciclo em si
        // so conta no relogio da CPU
        EMU_CPU_INLINE void tick() {}
        // WSYNC vira ciclos somados na escrita; o 6507 nao tem IRQ
        bool stalled() { return false; }
        bool irq() { return false; }
    };

    Cpu6502 cpu_;
    Tia tia_;
    CartA2600 cart_;
    Riot6532 riot_;
    // relogio da CPU ate onde TIA/RIOT ja andaram
    uint64_t tiaSync_ = 0, riotSync_ = 0;
    void syncTia()
    {
        const uint32_t n = (uint32_t)(cpu_.cycles - tiaSync_);
        if (n != 0) {
            tia_.advance(n);
            tiaSync_ = cpu_.cycles;
        }
    }
    void syncRiot()
    {
        const uint32_t n = (uint32_t)(cpu_.cycles - riotSync_);
        if (n != 0) {
            riot_.advance(n);
            riotSync_ = cpu_.cycles;
        }
    }
    AudioDownsampler audio_;
    uint16_t* fb_ = nullptr;
    uint32_t romCrc_ = 0;
    uint8_t switches_ = 0;
    uint8_t paddles_[4] = {0, 0, 0, 0};
};

}  // namespace a2600
}  // namespace emu
