#include "mapper000.h"
#include "../bus.h"
#include "../cartridge.h"
#include "../ppu2C02.h"

void mapper000_reset(Mapper* mapper)
{
    Mapper000_state* state = (Mapper000_state*)mapper->state;
    state->PRG_banks[0] = (uint8_t*)state->mROM->prg_base;
    state->PRG_banks[1] = (state->number_PRG_banks > 1)
                              ? (uint8_t*)(state->mROM->prg_base + (16U * 1024U))
                              : (uint8_t*)state->mROM->prg_base;
    state->CHR_bank =
        (state->number_CHR_banks == 0) ? state->CHR_ROM : (uint8_t*)state->mROM->chr_base;
}

void mapper000_mapPages(Mapper* mapper, Bus* bus)
{
    Mapper000_state* state = (Mapper000_state*)mapper->state;

    // $8000-$BFFF: bank 0, $C000-$FFFF: bank 1 (mirrors bank 0 if only 1 bank present)
    for (int p = 0x80; p <= 0xBF; p++)
        bus->read_pages[p] = state->PRG_banks[0] + ((p - 0x80) * 256);
    for (int p = 0xC0; p <= 0xFF; p++)
        bus->read_pages[p] = state->PRG_banks[1] + ((p - 0xC0) * 256);
}

void mapper000_mapPPUPages(Mapper* mapper, Ppu2C02* ppu)
{
    Mapper000_state* state = (Mapper000_state*)mapper->state;

    // $0000-1FFF: CHR-ROM/RAM
    for (int p = 0x00; p <= 0x1F; p++)
    {
        ppu->ppu_read_pages[p] = state->CHR_bank + (p * 256);
        if (state->number_CHR_banks == 0) ppu->ppu_write_pages[p] = state->CHR_bank + (p * 256);
    }
}

void mapper000_dumpState(Mapper* mapper, File& state)
{
    Mapper000_state* s = (Mapper000_state*)mapper->state;
    if (s->number_CHR_banks == 0 && s->CHR_bank) state.write(s->CHR_bank, 8U * 1024U);
    return;
}

void mapper000_loadState(Mapper* mapper, File& state)
{
    Mapper000_state* s = (Mapper000_state*)mapper->state;
    if (s->number_CHR_banks == 0 && s->CHR_bank) state.read(s->CHR_bank, 8U * 1024U);
    return;
}

Mapper createMapper000(uint8_t PRG_banks, uint8_t CHR_banks, Cartridge* cart)
{
    Mapper mapper;
    Mapper000_state* state = new (std::nothrow) Mapper000_state;
    if (!state) return mapper;

    if (CHR_banks == 0) state->CHR_ROM = (uint8_t*)nes_fast_alloc(8U * 1024U);
    state->mROM = &cart->mROM;

    state->number_PRG_banks = PRG_banks;
    state->number_CHR_banks = CHR_banks;
    state->cart = cart;
    mapper.state = state;
    return mapper;
}

void mapper000_destroy(Mapper* mapper)
{
    if (mapper->state == nullptr) return;
    auto* s = (Mapper000_state*)mapper->state;
    free(s->CHR_ROM);  // CHR-RAM (so existe sem CHR-ROM)
    delete s;
    mapper->state = nullptr;
}
