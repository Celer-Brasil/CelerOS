// RIOT 6532 — implementacao.

#include "riot6532.h"

namespace emu {
namespace a2600 {

void Riot6532::reset()
{
    memset(ram_, 0, sizeof(ram_));
    portA_ = ddrA_ = portB_ = ddrB_ = 0;
    inputA_ = 0xFF;
    inputB_ = 0x03;  // reset/select soltos
    timer_ = 0;
    timint_ = 0;
    presc_ = 0;
    irq_ = false;
}

void Riot6532::setInputs(uint8_t dirs, uint8_t switches)
{
    // SWCHA (Stella Guide 5.3): D7-D4 = P0, D3-D0 = P1; dentro do nibble
    // D7=right, D6=left, D5=down, D4=up, ativo baixo. `dirs` usa
    // up=0x01, down=0x02, left=0x04, right=0x08.
    inputA_ = (uint8_t)(((~dirs & 0x0F) << 4) | 0x0F);  // P1 solto

    // SWCHB: D7=P1 dif, D6=P0 dif (0=B/amador, 1=A/pro); D3=cor (0=P/B,
    // 1=cor); D1=select e D0=reset ativos baixos.
    uint8_t sw = 0x00;
    sw |= (switches & 0x02) ? 0x00 : 0x01;  // reset
    sw |= (switches & 0x01) ? 0x00 : 0x02;  // select
    sw |= (switches & 0x04) ? 0x08 : 0x00;  // 1 = cor
    sw |= (switches & 0x08) ? 0x40 : 0x00;  // 1 = dif A do P0
    sw |= (switches & 0x10) ? 0x80 : 0x00;  // 1 = dif A do P1
    inputB_ = sw;
}

uint8_t Riot6532::read(uint16_t addr)
{
    const uint16_t a = addr & 0x07;
    dbg_reads_[a]++;
    switch (a) {
    case 0:  // SWCHA
        return (uint8_t)((portA_ & ddrA_) | (inputA_ & (uint8_t)~ddrA_));
    case 1:  // SWACNT (DDR A)
        return ddrA_;
    case 2:  // SWCHB
        return (uint8_t)((portB_ & ddrB_) | (inputB_ & (uint8_t)~ddrB_));
    case 3:  // SWBCNT (DDR B)
        return ddrB_;
    case 4: {  // INTIM: le e limpa o flag
        const uint8_t v = timer_;
        irq_ = false;
        return v;
    }
    case 5:  // TIMINT
        return (uint8_t)((timint_ & 0x03) | (irq_ ? 0x80 : 0x00));
    default:
        return 0;
    }
}

void Riot6532::write(uint16_t addr, uint8_t v)
{
    switch (addr & 0x07) {
    case 0: portA_ = v; break;
    case 1: ddrA_ = v; break;
    case 2: portB_ = v; break;
    case 3: ddrB_ = v; break;
    case 4:
        timer_ = v;
        break;
    case 5:
        timint_ = (uint8_t)(v & 0x03);
        presc_ = 0;
        break;
    default:
        break;
    }
}

void Riot6532::tick()
{
    static const int kDiv[4] = {1, 8, 64, 1024};
    const int div = kDiv[timint_ & 0x03];
    if (++presc_ >= div) {
        presc_ = 0;
        if (timer_ == 0) {
            timer_ = 0xFF;
            irq_ = true;
        } else {
            timer_--;
        }
    }
}

void Riot6532::save(emu::StateWriter& w) const
{
    w.begin(emu::emu_tag('R', 'I', 'O', 'T'));
    w.bytes(ram_, sizeof(ram_));
    w.u8(portA_);
    w.u8(ddrA_);
    w.u8(portB_);
    w.u8(ddrB_);
    w.u8(inputA_);
    w.u8(inputB_);
    w.u8(timer_);
    w.u8(timint_);
    w.u16((uint16_t)presc_);
    w.u8(irq_ ? 1 : 0);
    w.end();
}

bool Riot6532::load(emu::StateReader& r)
{
    if (!r.find(emu::emu_tag('R', 'I', 'O', 'T'))) return false;
    r.bytes(ram_, sizeof(ram_));
    portA_ = r.u8();
    ddrA_ = r.u8();
    portB_ = r.u8();
    ddrB_ = r.u8();
    inputA_ = r.u8();
    inputB_ = r.u8();
    timer_ = r.u8();
    timint_ = r.u8();
    presc_ = (int16_t)r.u16();
    irq_ = r.u8() != 0;
    return r.ok();
}

}  // namespace a2600
}  // namespace emu
