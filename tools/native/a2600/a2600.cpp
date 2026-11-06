// Fachada do Atari 2600 — implementacao.

#include "a2600.h"

namespace emu {
namespace a2600 {

bool A2600::load(const uint8_t* rom, uint32_t size, int mapperOverride)
{
    if (!cart_.load(rom, size, mapperOverride)) return false;
    romCrc_ = emu_crc32(rom, size);
    reset();
    return true;
}

void A2600::reset()
{
    cart_.reset();
    riot_.reset();
    tia_.setFramebuffer(fb_);
    tia_.setAudio(&audio_);
    tia_.reset();
    bus_.ctx = this;
    bus_.read = &A2600::busRead;
    bus_.write = &A2600::busWrite;
    bus_.tick = &A2600::busTick;
    bus_.stalled = &A2600::busStalled;
    bus_.irq = nullptr;  // o 6507 nao tem pino de IRQ
    cpu_.reset(&bus_);
}

void A2600::setFramebuffer(uint16_t* fb)
{
    fb_ = fb;
    tia_.setFramebuffer(fb);
}

void A2600::setPcm(int16_t* buf, uint32_t cap)
{
    // 19.912 ciclos por quadro a 59,94 Hz = 1.193.182 Hz de CPU (NTSC).
    audio_.configure(1193182, 44100, buf, cap);
}

void A2600::frame(uint8_t buttons, uint8_t switches, const uint8_t* paddles)
{
    switches_ = switches;
    if (paddles != nullptr) {
        for (int i = 0; i < 4; i++) paddles_[i] = paddles[i];
    }

    const uint8_t dirs = (uint8_t)(((buttons & 0x10) ? 0x01 : 0) | ((buttons & 0x20) ? 0x02 : 0) |
                                   ((buttons & 0x40) ? 0x04 : 0) | ((buttons & 0x80) ? 0x08 : 0));
    const uint8_t inpt4 = (buttons & 0x01) ? 0x00 : 0x80;  // fire ativo baixo
    tia_.setInputs(inpt4, 0x80, paddles_);

    uint8_t sw = (uint8_t)(switches_ & 0x1C);  // cor/dificuldades
    if (buttons & 0x04) sw |= 0x01;            // select
    if (buttons & 0x08) sw |= 0x02;            // reset
    riot_.setInputs(dirs, sw);

    audio_.reset();
    tia_.clearFrameReady();

    // Roda ate o VSYNC do jogo (borda de descida). O teto de 2 quadros evita
    // travar num ROM que nunca sincroniza; o app continua chamando FRAME.
    const uint64_t cap = cpu_.cycles + 40000;
    while (!tia_.frameReady() && cpu_.cycles < cap) cpu_.step(&bus_);
}

uint8_t A2600::busRead(void* ctx, uint16_t addr)
{
    A2600* s = (A2600*)ctx;
    if (addr & 0x1000) return s->cart_.read(addr);
    if ((addr & 0x80) == 0) {
        // UA troca banco lendo os espelhos $0220/$0240 (regiao da TIA).
        if (s->cart_.isUA()) {
            if (addr == 0x0220) s->cart_.selectBank(0);
            else if (addr == 0x0240) s->cart_.selectBank(1);
        }
        return s->tia_.read(addr);
    }
    if (addr & 0x200) return s->riot_.read(addr);
    return s->riot_.readRam(addr);
}

void A2600::busWrite(void* ctx, uint16_t addr, uint8_t v)
{
    A2600* s = (A2600*)ctx;
    if (addr & 0x1000) {
        s->cart_.write(addr, v);
        return;
    }
    if ((addr & 0x80) == 0) {
        // 3F/3E: escrita em $003F troca o banco de 2K (snoop no barramento).
        if (s->cart_.is3F() && addr == 0x003F) s->cart_.write(0x003F, v);
        s->tia_.write(addr, v);
        return;
    }
    if (addr & 0x200) {
        s->riot_.write(addr, v);
        return;
    }
    s->riot_.writeRam(addr, v);
}

void A2600::busTick(void* ctx)
{
    A2600* s = (A2600*)ctx;
    s->tia_.tick();
    s->riot_.tick();
}

bool A2600::busStalled(void* ctx)
{
    return ((A2600*)ctx)->tia_.wsync();
}

void A2600::save(StateWriter& w) const
{
    cpu_.save(w);
    tia_.save(w);
    cart_.save(w);
    riot_.save(w);
}

bool A2600::loadState(StateReader& r)
{
    bool ok = cpu_.load(r);
    ok = tia_.load(r) && ok;
    ok = cart_.loadState(r) && ok;
    ok = riot_.load(r) && ok;
    return ok;
}

}  // namespace a2600
}  // namespace emu
