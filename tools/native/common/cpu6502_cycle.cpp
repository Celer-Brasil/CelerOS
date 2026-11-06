// CPU 6502 cycle-stepped — implementacao.
//
// Ver cpu6502_cycle.h para o porque. A tabela de 256 opcodes traz modo de
// enderecamento + ciclos-base (sem a penalidade de pagina, que o acesso
// dummy adiciona). O executor intercala os acessos de barramento com tick():
// a TIA ve cada leitura/escrita no ciclo certo; os ciclos internos que sobram
// sao consumidos no fim pelo orcamento.

#include "cpu6502_cycle.h"

namespace emu {
namespace {

enum class Op : uint8_t {
    BRK, ORA, JAM, SLO, NOP, ASL, PHP, ANC, BPL, CLC, JSR, AND, BIT, ROL, PLP, BMI,
    SEC, RTI, EOR, LSR, PHA, ALR, JMP, BVC, CLI, RTS, ADC, ROR, PLA, ARR, BVS, SEI,
    STA, STY, STX, SAX, DEY, TXA, XAA, BCC, TYA, TXS, TAS, SHY, SHX, AHX, LDY, LDA,
    LDX, LAX, TAY, TAX, LXA, BCS, CLV, TSX, LAS, CPY, CMP, DEC, INY, DEX, AXS, BNE,
    CLD, CPX, SBC, INC, INX, BEQ, SED, ISC, DCP, RLA, SRE, RRA,
};

enum class Mode : uint8_t {
    IMP, ACC, IMM, ZP, ZPX, ZPY, ABS, ABX, ABY, IND, IZX, IZY, REL,
};

struct Instr {
    uint8_t op;
    uint8_t mode;
    uint8_t cycles;
};

#define I(o, m, c) Instr{ (uint8_t)Op::o, (uint8_t)Mode::m, (uint8_t)(c) }

// Matriz oficial + ilegais (linhas de 16). Ciclos-base sem page-cross.
const Instr kInstr[256] = {
    // 0x00
    I(BRK, IMP, 7), I(ORA, IZX, 6), I(JAM, IMP, 2), I(SLO, IZX, 8),
    I(NOP, ZP, 3),  I(ORA, ZP, 3),  I(ASL, ZP, 5),  I(SLO, ZP, 5),
    I(PHP, IMP, 3), I(ORA, IMM, 2), I(ASL, ACC, 2), I(ANC, IMM, 2),
    I(NOP, ABS, 4), I(ORA, ABS, 4), I(ASL, ABS, 6), I(SLO, ABS, 6),
    // 0x10
    I(BPL, REL, 2), I(ORA, IZY, 5), I(JAM, IMP, 2), I(SLO, IZY, 8),
    I(NOP, ZPX, 4), I(ORA, ZPX, 4), I(ASL, ZPX, 6), I(SLO, ZPX, 6),
    I(CLC, IMP, 2), I(ORA, ABY, 4), I(NOP, IMP, 2), I(SLO, ABY, 7),
    I(NOP, ABX, 4), I(ORA, ABX, 4), I(ASL, ABX, 7), I(SLO, ABX, 7),
    // 0x20
    I(JSR, ABS, 6), I(AND, IZX, 6), I(JAM, IMP, 2), I(RLA, IZX, 8),
    I(BIT, ZP, 3),  I(AND, ZP, 3),  I(ROL, ZP, 5),  I(RLA, ZP, 5),
    I(PLP, IMP, 4), I(AND, IMM, 2), I(ROL, ACC, 2), I(ANC, IMM, 2),
    I(BIT, ABS, 4), I(AND, ABS, 4), I(ROL, ABS, 6), I(RLA, ABS, 6),
    // 0x30
    I(BMI, REL, 2), I(AND, IZY, 5), I(JAM, IMP, 2), I(RLA, IZY, 8),
    I(NOP, ZPX, 4), I(AND, ZPX, 4), I(ROL, ZPX, 6), I(RLA, ZPX, 6),
    I(SEC, IMP, 2), I(AND, ABY, 4), I(NOP, IMP, 2), I(RLA, ABY, 7),
    I(NOP, ABX, 4), I(AND, ABX, 4), I(ROL, ABX, 7), I(RLA, ABX, 7),
    // 0x40
    I(RTI, IMP, 6), I(EOR, IZX, 6), I(JAM, IMP, 2), I(SRE, IZX, 8),
    I(NOP, ZP, 3),  I(EOR, ZP, 3),  I(LSR, ZP, 5),  I(SRE, ZP, 5),
    I(PHA, IMP, 3), I(EOR, IMM, 2), I(LSR, ACC, 2), I(ALR, IMM, 2),
    I(JMP, ABS, 3), I(EOR, ABS, 4), I(LSR, ABS, 6), I(SRE, ABS, 6),
    // 0x50
    I(BVC, REL, 2), I(EOR, IZY, 5), I(JAM, IMP, 2), I(SRE, IZY, 8),
    I(NOP, ZPX, 4), I(EOR, ZPX, 4), I(LSR, ZPX, 6), I(SRE, ZPX, 6),
    I(CLI, IMP, 2), I(EOR, ABY, 4), I(NOP, IMP, 2), I(SRE, ABY, 7),
    I(NOP, ABX, 4), I(EOR, ABX, 4), I(LSR, ABX, 7), I(SRE, ABX, 7),
    // 0x60
    I(RTS, IMP, 6), I(ADC, IZX, 6), I(JAM, IMP, 2), I(RRA, IZX, 8),
    I(NOP, ZP, 3),  I(ADC, ZP, 3),  I(ROR, ZP, 5),  I(RRA, ZP, 5),
    I(PLA, IMP, 4), I(ADC, IMM, 2), I(ROR, ACC, 2), I(ARR, IMM, 2),
    I(JMP, IND, 5), I(ADC, ABS, 4), I(ROR, ABS, 6), I(RRA, ABS, 6),
    // 0x70
    I(BVS, REL, 2), I(ADC, IZY, 5), I(JAM, IMP, 2), I(RRA, IZY, 8),
    I(NOP, ZPX, 4), I(ADC, ZPX, 4), I(ROR, ZPX, 6), I(RRA, ZPX, 6),
    I(SEI, IMP, 2), I(ADC, ABY, 4), I(NOP, IMP, 2), I(RRA, ABY, 7),
    I(NOP, ABX, 4), I(ADC, ABX, 4), I(ROR, ABX, 7), I(RRA, ABX, 7),
    // 0x80
    I(NOP, IMM, 2), I(STA, IZX, 6), I(NOP, IMM, 2), I(SAX, IZX, 6),
    I(STY, ZP, 3),  I(STA, ZP, 3),  I(STX, ZP, 3),  I(SAX, ZP, 3),
    I(DEY, IMP, 2), I(NOP, IMM, 2), I(TXA, IMP, 2), I(XAA, IMM, 2),
    I(STY, ABS, 4), I(STA, ABS, 4), I(STX, ABS, 4), I(SAX, ABS, 4),
    // 0x90
    I(BCC, REL, 2), I(STA, IZY, 6), I(JAM, IMP, 2), I(AHX, IZY, 6),
    I(STY, ZPX, 4), I(STA, ZPX, 4), I(STX, ZPY, 4), I(SAX, ZPY, 4),
    I(TYA, IMP, 2), I(STA, ABY, 5), I(TXS, IMP, 2), I(TAS, ABY, 5),
    I(SHY, ABX, 5), I(STA, ABX, 5), I(SHX, ABY, 5), I(AHX, ABY, 5),
    // 0xA0
    I(LDY, IMM, 2), I(LDA, IZX, 6), I(LDX, IMM, 2), I(LAX, IZX, 6),
    I(LDY, ZP, 3),  I(LDA, ZP, 3),  I(LDX, ZP, 3),  I(LAX, ZP, 3),
    I(TAY, IMP, 2), I(LDA, IMM, 2), I(TAX, IMP, 2), I(LXA, IMM, 2),
    I(LDY, ABS, 4), I(LDA, ABS, 4), I(LDX, ABS, 4), I(LAX, ABS, 4),
    // 0xB0
    I(BCS, REL, 2), I(LDA, IZY, 5), I(JAM, IMP, 2), I(LAX, IZY, 5),
    I(LDY, ZPX, 4), I(LDA, ZPX, 4), I(LDX, ZPY, 4), I(LAX, ZPY, 4),
    I(CLV, IMP, 2), I(LDA, ABY, 4), I(TSX, IMP, 2), I(LAS, ABY, 4),
    I(LDY, ABX, 4), I(LDA, ABX, 4), I(LDX, ABY, 4), I(LAX, ABY, 4),
    // 0xC0
    I(CPY, IMM, 2), I(CMP, IZX, 6), I(NOP, IMM, 2), I(DCP, IZX, 8),
    I(CPY, ZP, 3),  I(CMP, ZP, 3),  I(DEC, ZP, 5),  I(DCP, ZP, 5),
    I(INY, IMP, 2), I(CMP, IMM, 2), I(DEX, IMP, 2), I(AXS, IMM, 2),
    I(CPY, ABS, 4), I(CMP, ABS, 4), I(DEC, ABS, 6), I(DCP, ABS, 6),
    // 0xD0
    I(BNE, REL, 2), I(CMP, IZY, 5), I(JAM, IMP, 2), I(DCP, IZY, 8),
    I(NOP, ZPX, 4), I(CMP, ZPX, 4), I(DEC, ZPX, 6), I(DCP, ZPX, 6),
    I(CLD, IMP, 2), I(CMP, ABY, 4), I(NOP, IMP, 2), I(DCP, ABY, 7),
    I(NOP, ABX, 4), I(CMP, ABX, 4), I(DEC, ABX, 7), I(DCP, ABX, 7),
    // 0xE0
    I(CPX, IMM, 2), I(SBC, IZX, 6), I(NOP, IMM, 2), I(ISC, IZX, 8),
    I(CPX, ZP, 3),  I(SBC, ZP, 3),  I(INC, ZP, 5),  I(ISC, ZP, 5),
    I(INX, IMP, 2), I(SBC, IMM, 2), I(NOP, IMP, 2), I(SBC, IMM, 2),
    I(CPX, ABS, 4), I(SBC, ABS, 4), I(INC, ABS, 6), I(ISC, ABS, 6),
    // 0xF0
    I(BEQ, REL, 2), I(SBC, IZY, 5), I(JAM, IMP, 2), I(ISC, IZY, 8),
    I(NOP, ZPX, 4), I(SBC, ZPX, 4), I(INC, ZPX, 6), I(ISC, ZPX, 6),
    I(SED, IMP, 2), I(SBC, ABY, 4), I(NOP, IMP, 2), I(ISC, ABY, 7),
    I(NOP, ABX, 4), I(SBC, ABX, 4), I(INC, ABX, 7), I(ISC, ABX, 7),
};

#undef I

bool isReadOp(uint8_t op)
{
    switch ((Op)op) {
    case Op::ORA: case Op::AND: case Op::EOR: case Op::ADC:
    case Op::CMP: case Op::SBC: case Op::LDA: case Op::LDX:
    case Op::LDY: case Op::BIT: case Op::LAX: case Op::LAS:
    case Op::ANC: case Op::ALR: case Op::ARR: case Op::AXS:
    case Op::LXA: case Op::XAA:
        return true;
    default:
        return false;
    }
}

bool isStoreOp(uint8_t op)
{
    switch ((Op)op) {
    case Op::STA: case Op::STX: case Op::STY: case Op::SAX:
    case Op::AHX: case Op::SHX: case Op::SHY: case Op::TAS:
        return true;
    default:
        return false;
    }
}

bool isRmwOp(uint8_t op)
{
    switch ((Op)op) {
    case Op::ASL: case Op::ROL: case Op::LSR: case Op::ROR:
    case Op::DEC: case Op::INC: case Op::SLO: case Op::RLA:
    case Op::SRE: case Op::RRA: case Op::DCP: case Op::ISC:
        return true;
    default:
        return false;
    }
}

}  // namespace

void Cpu6502::reset(CpuBus* b)
{
    a = x = y = 0;
    sp = 0xFD;
    p = (uint8_t)(kU | kI);
    jammed = false;
    cycles = 0;
    const uint8_t lo = b->read(b->ctx, 0xFFFC);
    b->tick(b->ctx);
    const uint8_t hi = b->read(b->ctx, 0xFFFD);
    b->tick(b->ctx);
    cycles += 2;
    pc = (uint16_t)(lo | (hi << 8));
}

void Cpu6502::tick(CpuBus* b)
{
    b->tick(b->ctx);
    cycles++;
    // WSYNC/RDY: o CPU fica parada ate o fim da linha / do DMA. Os ciclos da
    // parada contam como ciclos de barramento (o orcamento da instrucao ja
    // passou, entao step() encerra normalmente).
    if (b->stalled != nullptr) {
        while (b->stalled(b->ctx)) {
            b->tick(b->ctx);
            cycles++;
        }
    }
}

uint8_t Cpu6502::rd(CpuBus* b, uint16_t addr)
{
    const uint8_t v = b->read(b->ctx, addr);
    tick(b);
    return v;
}

void Cpu6502::wr(CpuBus* b, uint16_t addr, uint8_t v)
{
    b->write(b->ctx, addr, v);
    tick(b);
}

uint16_t Cpu6502::fetch16(CpuBus* b)
{
    const uint8_t lo = fetch(b);
    const uint8_t hi = fetch(b);
    return (uint16_t)(lo | (hi << 8));
}

uint16_t Cpu6502::read16(CpuBus* b, uint16_t addr)
{
    const uint8_t lo = rd(b, addr);
    const uint8_t hi = rd(b, (uint16_t)(addr + 1));
    return (uint16_t)(lo | (hi << 8));
}

void Cpu6502::push(CpuBus* b, uint8_t v)
{
    wr(b, (uint16_t)(0x100 | sp), v);
    sp--;
}

uint8_t Cpu6502::pull(CpuBus* b)
{
    sp++;
    return rd(b, (uint16_t)(0x100 | sp));
}

void Cpu6502::step(CpuBus* b)
{
    if (jammed) {
        tick(b);
        return;
    }
    if (b->irq != nullptr && b->irq(b->ctx) && !(p & kI)) {
        doIrq(b);
        return;
    }
    const uint64_t start = cycles;
    const uint8_t op = fetch(b);
    exec(op, b);
    const int base = kInstr[op].cycles;
    while ((int)(cycles - start) < base) tick(b);
}

void Cpu6502::doIrq(CpuBus* b)
{
    rd(b, pc);  // leitura dummy do PC
    push(b, (uint8_t)(pc >> 8));
    push(b, (uint8_t)(pc & 0xFF));
    push(b, (uint8_t)((p & (uint8_t)~kB) | kU));
    p |= kI;
    pc = read16(b, 0xFFFE);
}

void Cpu6502::doNmi(CpuBus* b)
{
    rd(b, pc);
    push(b, (uint8_t)(pc >> 8));
    push(b, (uint8_t)(pc & 0xFF));
    push(b, (uint8_t)((p & (uint8_t)~kB) | kU));
    p |= kI;
    pc = read16(b, 0xFFFA);
}

void Cpu6502::exec(uint8_t op, CpuBus* b)
{
    switch (op) {
    case 0x00: brk(b); return;
    case 0x20: jsr(b); return;
    case 0x4C: pc = fetch16(b); return;
    case 0x6C: jmpInd(b); return;
    default: break;
    }

    const Instr& ins = kInstr[op];
    switch ((Mode)ins.mode) {
    case Mode::IMP: execImp(ins.op, b); return;
    case Mode::ACC: execAcc(ins.op); return;
    case Mode::IMM: doValue(ins.op, fetch(b)); return;
    case Mode::ZP: doMem(ins.op, fetch(b), b); return;
    case Mode::ZPX: doMem(ins.op, (uint8_t)(fetch(b) + x), b); return;
    case Mode::ZPY: doMem(ins.op, (uint8_t)(fetch(b) + y), b); return;
    case Mode::ABS: doMem(ins.op, fetch16(b), b); return;
    case Mode::ABX: doIndexed(ins.op, x, b); return;
    case Mode::ABY: doIndexed(ins.op, y, b); return;
    case Mode::IND: return;  // so JMP usa (tratado acima)
    case Mode::IZX: {
        const uint8_t zp = fetch(b);
        const uint8_t lo = rd(b, zp);
        const uint8_t hi = rd(b, (uint8_t)(zp + 1));
        doMem(ins.op, (uint16_t)(lo | (hi << 8)), b);
        return;
    }
    case Mode::IZY: doIzy(ins.op, b); return;
    case Mode::REL: {
        // branches: condicao pelo opcode
        switch ((Op)ins.op) {
        case Op::BPL: branch(b, !(p & kN)); return;
        case Op::BMI: branch(b, (p & kN) != 0); return;
        case Op::BVC: branch(b, !(p & kV)); return;
        case Op::BVS: branch(b, (p & kV) != 0); return;
        case Op::BCC: branch(b, !(p & kC)); return;
        case Op::BCS: branch(b, (p & kC) != 0); return;
        case Op::BNE: branch(b, !(p & kZ)); return;
        case Op::BEQ: branch(b, (p & kZ) != 0); return;
        default: return;
        }
    }
    }
}

void Cpu6502::execImp(uint8_t op, CpuBus* b)
{
    switch ((Op)op) {
    case Op::NOP: break;
    case Op::PHP: push(b, (uint8_t)(p | kB | kU)); break;
    case Op::PLP: p = (uint8_t)((pull(b) & (uint8_t)~kB) | kU); break;
    case Op::PHA: push(b, a); break;
    case Op::PLA: a = pull(b); setZN(a); break;
    case Op::RTS: rts(b); break;
    case Op::RTI: rti(b); break;
    case Op::CLC: p &= (uint8_t)~kC; break;
    case Op::SEC: p |= kC; break;
    case Op::CLI: p &= (uint8_t)~kI; break;
    case Op::SEI: p |= kI; break;
    case Op::CLV: p &= (uint8_t)~kV; break;
    case Op::CLD: p &= (uint8_t)~kD; break;
    case Op::SED: p |= kD; break;
    case Op::DEY: y--; setZN(y); break;
    case Op::INY: y++; setZN(y); break;
    case Op::DEX: x--; setZN(x); break;
    case Op::INX: x++; setZN(x); break;
    case Op::TAY: y = a; setZN(y); break;
    case Op::TAX: x = a; setZN(x); break;
    case Op::TYA: a = y; setZN(a); break;
    case Op::TXA: a = x; setZN(a); break;
    case Op::TSX: x = sp; setZN(x); break;
    case Op::TXS: sp = x; break;
    case Op::JAM: jammed = true; break;
    default: break;
    }
}

void Cpu6502::execAcc(uint8_t op)
{
    switch ((Op)op) {
    case Op::ASL:
        setFlag(kC, (a & 0x80) != 0);
        a <<= 1;
        setZN(a);
        break;
    case Op::ROL: {
        const bool c = getC();
        setFlag(kC, (a & 0x80) != 0);
        a = (uint8_t)((a << 1) | (c ? 1 : 0));
        setZN(a);
        break;
    }
    case Op::LSR:
        setFlag(kC, (a & 1) != 0);
        a >>= 1;
        setZN(a);
        break;
    case Op::ROR: {
        const bool c = getC();
        setFlag(kC, (a & 1) != 0);
        a = (uint8_t)((a >> 1) | (c ? 0x80 : 0));
        setZN(a);
        break;
    }
    default: break;
    }
}

void Cpu6502::doMem(uint8_t op, uint16_t addr, CpuBus* b)
{
    if (isReadOp(op)) {
        doValue(op, rd(b, addr));
    } else if (isStoreOp(op)) {
        doStore(op, addr, b);
    } else if (isRmwOp(op)) {
        doRmw(op, addr, b);
    } else {
        rd(b, addr);  // NOP com modo de memoria: o barramento ve a leitura
    }
}

void Cpu6502::doIndexed(uint8_t op, uint8_t index, CpuBus* b)
{
    const uint16_t base = fetch16(b);
    const uint16_t addr = (uint16_t)(base + index);
    if (isStoreOp(op)) {
        // store abs,X/Y: leitura dummy no endereco com o high byte velho
        rd(b, (uint16_t)((base & 0xFF00) | (addr & 0xFF)));
        doStore(op, addr, b);
        return;
    }
    if (isRmwOp(op)) {
        doRmw(op, addr, b);  // RMW abs,X/Y nao paga penalidade de pagina
        return;
    }
    if ((base ^ addr) & 0xFF00) rd(b, (uint16_t)((base & 0xFF00) | (addr & 0xFF)));
    doMem(op, addr, b);
}

void Cpu6502::doIzy(uint8_t op, CpuBus* b)
{
    const uint8_t zp = fetch(b);
    const uint8_t lo = rd(b, zp);
    const uint8_t hi = rd(b, (uint8_t)(zp + 1));
    const uint16_t base = (uint16_t)(lo | (hi << 8));
    const uint16_t addr = (uint16_t)(base + y);
    if (isStoreOp(op)) {
        rd(b, (uint16_t)((base & 0xFF00) | (addr & 0xFF)));
        doStore(op, addr, b);
        return;
    }
    if (isRmwOp(op)) {
        doRmw(op, addr, b);
        return;
    }
    if ((base ^ addr) & 0xFF00) rd(b, (uint16_t)((base & 0xFF00) | (addr & 0xFF)));
    doMem(op, addr, b);
}

void Cpu6502::doValue(uint8_t op, uint8_t v)
{
    switch ((Op)op) {
    case Op::ORA: a |= v; setZN(a); break;
    case Op::AND: a &= v; setZN(a); break;
    case Op::EOR: a ^= v; setZN(a); break;
    case Op::ADC: adc(v); break;
    case Op::SBC: sbc(v); break;
    case Op::CMP: cmp(a, v); break;
    case Op::CPX: cmp(x, v); break;
    case Op::CPY: cmp(y, v); break;
    case Op::LDA: a = v; setZN(a); break;
    case Op::LDX: x = v; setZN(x); break;
    case Op::LDY: y = v; setZN(y); break;
    case Op::BIT:
        setFlag(kZ, (a & v) == 0);
        setFlag(kN, (v & 0x80) != 0);
        setFlag(kV, (v & 0x40) != 0);
        break;
    case Op::LAX: a = v; x = v; setZN(v); break;
    case Op::LAS: a = (uint8_t)(v & sp); x = a; sp = a; setZN(a); break;
    case Op::ANC: a &= v; setZN(a); setFlag(kC, (a & 0x80) != 0); break;
    case Op::ALR:
        a &= v;
        setFlag(kC, (a & 1) != 0);
        a >>= 1;
        setZN(a);
        break;
    case Op::ARR: {
        const uint8_t t = (uint8_t)(a & v);
        const bool c = getC();
        a = (uint8_t)((t >> 1) | (c ? 0x80 : 0));
        setZN(a);
        setFlag(kC, (t & 0x40) != 0);
        setFlag(kV, (((t >> 6) ^ (t >> 5)) & 1) != 0);
        break;
    }
    case Op::AXS: {
        const uint8_t ax = (uint8_t)(a & x);
        setFlag(kC, ax >= v);
        x = (uint8_t)(ax - v);
        setZN(x);
        break;
    }
    case Op::LXA: a = (uint8_t)((a | 0xEE) & v); x = a; setZN(a); break;
    case Op::XAA: a = (uint8_t)((a | 0xEE) & x & v); setZN(a); break;
    default: break;
    }
}

void Cpu6502::doStore(uint8_t op, uint16_t addr, CpuBus* b)
{
    uint8_t v = 0;
    switch ((Op)op) {
    case Op::STA: v = a; break;
    case Op::STX: v = x; break;
    case Op::STY: v = y; break;
    case Op::SAX: v = (uint8_t)(a & x); break;
    case Op::AHX: v = (uint8_t)(a & x & (uint8_t)((addr >> 8) + 1)); break;
    case Op::SHX: v = (uint8_t)(x & (uint8_t)((addr >> 8) + 1)); break;
    case Op::SHY: v = (uint8_t)(y & (uint8_t)((addr >> 8) + 1)); break;
    case Op::TAS:
        sp = (uint8_t)(a & x);
        v = (uint8_t)(sp & (uint8_t)((addr >> 8) + 1));
        break;
    default: break;
    }
    wr(b, addr, v);
}

void Cpu6502::doRmw(uint8_t op, uint16_t addr, CpuBus* b)
{
    const uint8_t v = rd(b, addr);
    uint8_t r = v;
    bool setzn = true;
    switch ((Op)op) {
    case Op::ASL:
        setFlag(kC, (v & 0x80) != 0);
        r = (uint8_t)(v << 1);
        break;
    case Op::ROL: {
        const bool c = getC();
        setFlag(kC, (v & 0x80) != 0);
        r = (uint8_t)((v << 1) | (c ? 1 : 0));
        break;
    }
    case Op::LSR:
        setFlag(kC, (v & 1) != 0);
        r = (uint8_t)(v >> 1);
        break;
    case Op::ROR: {
        const bool c = getC();
        setFlag(kC, (v & 1) != 0);
        r = (uint8_t)((v >> 1) | (c ? 0x80 : 0));
        break;
    }
    case Op::DEC: r = (uint8_t)(v - 1); break;
    case Op::INC: r = (uint8_t)(v + 1); break;
    case Op::SLO:
        setFlag(kC, (v & 0x80) != 0);
        r = (uint8_t)(v << 1);
        a |= r;
        setZN(a);
        setzn = false;
        break;
    case Op::RLA: {
        const bool c = getC();
        setFlag(kC, (v & 0x80) != 0);
        r = (uint8_t)((v << 1) | (c ? 1 : 0));
        a &= r;
        setZN(a);
        setzn = false;
        break;
    }
    case Op::SRE:
        setFlag(kC, (v & 1) != 0);
        r = (uint8_t)(v >> 1);
        a ^= r;
        setZN(a);
        setzn = false;
        break;
    case Op::RRA: {
        const bool c = getC();
        setFlag(kC, (v & 1) != 0);
        r = (uint8_t)((v >> 1) | (c ? 0x80 : 0));
        adc(r);
        setzn = false;
        break;
    }
    case Op::DCP:
        r = (uint8_t)(v - 1);
        cmp(a, r);
        setzn = false;
        break;
    case Op::ISC:
        r = (uint8_t)(v + 1);
        sbc(r);
        setzn = false;
        break;
    default: break;
    }
    // RMW do 6502: escreve o valor velho (dummy) e depois o novo. Na TIA o
    // dummy write e visivel, por isso ele existe aqui.
    wr(b, addr, v);
    wr(b, addr, r);
    if (setzn) setZN(r);
}

void Cpu6502::branch(CpuBus* b, bool cond)
{
    const int8_t off = (int8_t)fetch(b);
    if (!cond) return;
    tick(b);  // ciclo interno (leitura dummy do PC)
    const uint16_t old = pc;
    pc = (uint16_t)(pc + off);
    if ((old & 0xFF00) != (pc & 0xFF00)) tick(b);
}

void Cpu6502::brk(CpuBus* b)
{
    rd(b, pc);  // leitura dummy do byte seguinte
    push(b, (uint8_t)(pc >> 8));
    push(b, (uint8_t)(pc & 0xFF));
    push(b, (uint8_t)(p | kB | kU));
    p |= kI;
    pc = read16(b, 0xFFFE);
}

void Cpu6502::jsr(CpuBus* b)
{
    const uint8_t lo = fetch(b);
    tick(b);  // ciclo interno antes dos pushes
    push(b, (uint8_t)(pc >> 8));
    push(b, (uint8_t)(pc & 0xFF));
    const uint8_t hi = fetch(b);
    pc = (uint16_t)((hi << 8) | lo);
}

void Cpu6502::jmpInd(CpuBus* b)
{
    const uint16_t ptr = fetch16(b);
    const uint8_t lo = rd(b, ptr);
    // bug classico do NMOS: o high byte vem de (ptr & FF00) | ((ptr+1) & FF)
    const uint16_t hiAddr = (uint16_t)((ptr & 0xFF00) | ((ptr + 1) & 0xFF));
    const uint8_t hi = rd(b, hiAddr);
    pc = (uint16_t)((hi << 8) | lo);
}

void Cpu6502::rts(CpuBus* b)
{
    rd(b, pc);  // dummy
    const uint8_t lo = pull(b);
    const uint8_t hi = pull(b);
    pc = (uint16_t)(((hi << 8) | lo) + 1);
}

void Cpu6502::rti(CpuBus* b)
{
    rd(b, pc);  // dummy
    p = (uint8_t)((pull(b) & (uint8_t)~kB) | kU);
    const uint8_t lo = pull(b);
    const uint8_t hi = pull(b);
    pc = (uint16_t)((hi << 8) | lo);
}

void Cpu6502::adc(uint8_t m)
{
    const uint8_t c = getC() ? 1 : 0;
    if (p & kD) {
        const uint16_t bin = (uint16_t)a + m + c;
        // NMOS: N/V/Z saem do resultado BINARIO; C do carry decimal
        setFlag(kZ, (bin & 0xFF) == 0);
        setFlag(kN, (bin & 0x80) != 0);
        setFlag(kV, ((~(a ^ m) & (a ^ bin)) & 0x80) != 0);
        uint16_t al = (uint16_t)((a & 0x0F) + (m & 0x0F) + c);
        if (al > 0x09) al += 0x06;
        uint16_t ah = (uint16_t)((a >> 4) + (m >> 4) + (al > 0x0F ? 1 : 0));
        if (ah > 0x09) ah += 0x06;
        setFlag(kC, ah > 0x0F);
        a = (uint8_t)(((ah << 4) | (al & 0x0F)) & 0xFF);
    } else {
        const uint16_t sum = (uint16_t)a + m + c;
        setFlag(kC, sum > 0xFF);
        const uint8_t r = (uint8_t)sum;
        setFlag(kV, ((~(a ^ m) & (a ^ r)) & 0x80) != 0);
        setZN(r);
        a = r;
    }
}

void Cpu6502::sbc(uint8_t m)
{
    const uint8_t c = getC() ? 1 : 0;
    const uint16_t bin = (uint16_t)a - m - (c ? 0 : 1);
    const uint8_t r = (uint8_t)bin;
    setFlag(kC, bin < 0x100);
    setFlag(kZ, r == 0);
    setFlag(kN, (r & 0x80) != 0);
    setFlag(kV, (((a ^ m) & (a ^ r)) & 0x80) != 0);
    if (p & kD) {
        int al = (a & 0x0F) - (m & 0x0F) - (c ? 0 : 1);
        int ah = (a >> 4) - (m >> 4);
        if (al < 0) {
            al -= 6;
            ah--;
        }
        if (ah < 0) ah -= 6;
        a = (uint8_t)(((ah << 4) | (al & 0x0F)) & 0xFF);
    } else {
        a = r;
    }
}

void Cpu6502::cmp(uint8_t reg, uint8_t m)
{
    const uint16_t d = (uint16_t)reg - m;
    setFlag(kC, reg >= m);
    setFlag(kZ, (d & 0xFF) == 0);
    setFlag(kN, (d & 0x80) != 0);
}

void Cpu6502::save(StateWriter& w) const
{
    w.begin(kTagCpu);
    w.u8(a);
    w.u8(x);
    w.u8(y);
    w.u8(sp);
    w.u8(p);
    w.u16(pc);
    w.u64(cycles);
    w.u8(jammed ? 1 : 0);
    w.end();
}

bool Cpu6502::load(StateReader& r)
{
    if (!r.find(kTagCpu)) return false;
    a = r.u8();
    x = r.u8();
    y = r.u8();
    sp = r.u8();
    p = r.u8();
    pc = r.u16();
    cycles = r.u64();
    jammed = r.u8() != 0;
    return r.ok();
}

}  // namespace emu
