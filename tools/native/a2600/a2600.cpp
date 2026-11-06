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
    tiaSync_ = riotSync_ = 0;
    Bus bus{this};
    cpu_.resetT(bus);
}

void A2600::setFramebuffer(uint16_t* fb)
{
    fb_ = fb;
    tia_.setFramebuffer(fb);
}

void A2600::setPcm(int16_t* buf, uint32_t cap)
{
    // a TIA entrega duas amostras por linha (31,4 kHz NTSC)
    audio_.configure(Tia::kAudioRate, 44100, buf, cap);
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
    Bus bus{this};
    while (!tia_.frameReady() && cpu_.cycles < cap) cpu_.stepT(bus);
}

EMU_CPU_INLINE uint8_t A2600::busRead(uint16_t addr)
{
    if (addr & 0x1000) return cart_.read(addr);
    if ((addr & 0x80) == 0) {
        // UA troca banco lendo os espelhos $0220/$0240 (regiao da TIA).
        if (cart_.isUA()) {
            if (addr == 0x0220) cart_.selectBank(0);
            else if (addr == 0x0240) cart_.selectBank(1);
        }
        syncTia();
        return tia_.read(addr);
    }
    if (addr & 0x200) {
        syncRiot();
        return riot_.read(addr);
    }
    return riot_.readRam(addr);
}

EMU_CPU_INLINE void A2600::busWrite(uint16_t addr, uint8_t v)
{
    if (addr & 0x1000) {
        cart_.write(addr, v);
        return;
    }
    if ((addr & 0x80) == 0) {
        // 3F/3E: escrita em $003F troca o banco de 2K (snoop no barramento).
        if (cart_.is3F() && addr == 0x003F) cart_.write(0x003F, v);
        syncTia();
        tia_.write(addr, v);
        // WSYNC: a CPU fica parada ate a borda do blank; os ciclos da parada
        // entram no relogio e a TIA anda por eles no proximo acesso
        if ((addr & 0x3F) == 0x02) cpu_.cycles += (uint64_t)tia_.wsyncStall();
        return;
    }
    if (addr & 0x200) {
        syncRiot();
        riot_.write(addr, v);
        return;
    }
    riot_.writeRam(addr, v);
}

void A2600::save(StateWriter& w)
{
    syncTia();
    syncRiot();
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
    tiaSync_ = riotSync_ = cpu_.cycles;  // o state foi salvo sincronizado
    return ok;
}

}  // namespace a2600
}  // namespace emu
