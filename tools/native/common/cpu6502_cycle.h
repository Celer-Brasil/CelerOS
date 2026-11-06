#pragma once
// CPU 6502/6507 cycle-stepped (Atari 2600/5200 e futuros cores da familia).
//
// Por que nao reusar o Cpu6502 do nucleo Anemoia: ele executa a INSTRUCAO
// INTEIRA e so depois cobra os ciclos (bus.cpuWrite no inicio, cycles += n no
// fim). No NES isso funciona porque a PPU anda em blocos de 113/114 ciclos;
// na TIA do 2600 o desenho acontece DURANTE a instrucao (racing the beam) e
// um STA RESP0 aplicado no ciclo 0 em vez do 4 desloca o sprite ~12 color
// clocks. Aqui cada acesso de barramento cai no ciclo certo:
//
//   rd/wr -> acesso + tick()   (tick avanca 1 ciclo e drena WSYNC/RDY)
//
// A instrucao continua sendo executada por um switch (nao ha micro-codigo por
// ciclo), mas os acessos sao intercalados com os ticks; os ciclos internos que
// sobram sao consumidos no fim pelo orcamento da tabela. E cycle-accurate nos
// pontos que a TIA ve (leituras/escritas): 19.912 ciclos/quadro no 2600.
//
// Barramento INLINE: o executor e template no tipo do barramento (stepT<B>).
// Com ponteiros de funcao eram 2-3 chamadas indiretas por ciclo emulado numa
// pilha funda — no Xtensa (ABI janelada) cada uma ainda arrisca excecao de
// window overflow/underflow; bancada 4848, Pitfall: ~20 ms so de CPU+TIA por
// quadro. O core inclui cpu6502_cycle.cpp no TU unico e chama stepT com um
// barramento de metodos inline; CpuBus + step() continuam para os testes.
//
// Cobre a ISA oficial, o modo decimal NMOS e os ilegais que os jogos de 2600
// realmente usam (LAX/SAX/DCP/ISC/SLO/RLA/SRE/RRA/ANC/ALR/ARR/AXS + NOPs).

#include "emu_compat.h"
#include "emu_state.h"

namespace emu {

struct CpuBus {
    void* ctx = nullptr;
    uint8_t (*read)(void* ctx, uint16_t addr) = nullptr;
    void (*write)(void* ctx, uint16_t addr, uint8_t v) = nullptr;
    // Um ciclo de CPU (3 color clocks na TIA). O core de video avanca aqui.
    void (*tick)(void* ctx) = nullptr;
    // WSYNC (2600) / RDY (5200): CPU parada ate o fim da linha / fim do DMA.
    bool (*stalled)(void* ctx) = nullptr;
    // IRQ nivelado (5200: GTIA/POKEY). nullptr = sem IRQ (2600).
    bool (*irq)(void* ctx) = nullptr;
};

// Adaptador CpuBus -> barramento de template (testes host).
struct FnBus {
    CpuBus* b;
    uint8_t read(uint16_t a) { return b->read(b->ctx, a); }
    void write(uint16_t a, uint8_t v) { b->write(b->ctx, a, v); }
    void tick() { b->tick(b->ctx); }
    bool stalled() { return b->stalled != nullptr && b->stalled(b->ctx); }
    bool irq() { return b->irq != nullptr && b->irq(b->ctx); }
};

#define EMU_CPU_INLINE inline __attribute__((always_inline))

class Cpu6502
{
public:
    static constexpr uint8_t kC = 0x01, kZ = 0x02, kI = 0x04, kD = 0x08;
    static constexpr uint8_t kB = 0x10, kU = 0x20, kV = 0x40, kN = 0x80;

    uint8_t a = 0, x = 0, y = 0, sp = 0xFD;
    uint8_t p = kU | kI;
    uint16_t pc = 0;
    uint64_t cycles = 0;
    bool jammed = false;

    void reset(CpuBus* bus);
    void step(CpuBus* bus);
    void doIrq(CpuBus* bus);
    void doNmi(CpuBus* bus);

    // Barramento de template (B: read/write/tick/stalled/irq inline).
    // Definidos em cpu6502_cycle.cpp: so o TU que o inclui instancia.
    template <class B> void resetT(B& b);
    template <class B> void stepT(B& b);
    template <class B> void doIrqT(B& b);
    template <class B> void doNmiT(B& b);

    bool flag(uint8_t f) const { return (p & f) != 0; }
    void setFlag(uint8_t f, bool on)
    {
        if (on) p |= f;
        else p &= (uint8_t)~f;
    }

    void save(StateWriter& w) const;
    bool load(StateReader& r);

private:
    // --- barramento -------------------------------------------------------
    template <class B> EMU_CPU_INLINE void tick(B& b);
    template <class B> EMU_CPU_INLINE uint8_t rd(B& b, uint16_t addr);
    template <class B> EMU_CPU_INLINE void wr(B& b, uint16_t addr, uint8_t v);
    template <class B> EMU_CPU_INLINE uint8_t fetch(B& b) { return rd(b, pc++); }
    template <class B> EMU_CPU_INLINE uint16_t fetch16(B& b);
    template <class B> uint16_t read16(B& b, uint16_t addr);
    template <class B> EMU_CPU_INLINE void push(B& b, uint8_t v);
    template <class B> EMU_CPU_INLINE uint8_t pull(B& b);

    // --- instrucoes -------------------------------------------------------
    template <class B> void exec(uint8_t op, B& b);
    template <class B> void execImp(uint8_t op, B& b);
    void execAcc(uint8_t op);
    template <class B> void doMem(uint8_t op, uint16_t addr, B& b);
    void doValue(uint8_t op, uint8_t v);
    template <class B> void doStore(uint8_t op, uint16_t addr, B& b);
    template <class B> void doRmw(uint8_t op, uint16_t addr, B& b);
    template <class B> void doIndexed(uint8_t op, uint8_t index, B& b);
    template <class B> void doIzy(uint8_t op, B& b);
    template <class B> void branch(B& b, bool cond);
    template <class B> void brk(B& b);
    template <class B> void jsr(B& b);
    template <class B> void rts(B& b);
    template <class B> void rti(B& b);
    template <class B> void jmpInd(B& b);

    // --- ALU --------------------------------------------------------------
    void setZN(uint8_t v)
    {
        setFlag(kZ, v == 0);
        setFlag(kN, (v & 0x80) != 0);
    }
    bool getC() const { return (p & kC) != 0; }
    void adc(uint8_t m);
    void sbc(uint8_t m);
    void cmp(uint8_t reg, uint8_t m);
};

}  // namespace emu
