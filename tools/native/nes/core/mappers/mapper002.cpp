#include "mapper002.h"
#include "../bus.h"
#include "../cartridge.h"

static void mapper002_remapWindows(Mapper002_state* state, Bus* bus)
{
    for (int p = 0x80; p <= 0xBF; p++)
        bus->read_pages[p] = state->ptr_PRG_bank_16K[0] + ((p - 0x80) * 256);
}

static void mapper002_bankWrite(Bus* bus, uint16_t addr, uint8_t data)
{
    Mapper002_state* state = (Mapper002_state*)bus->cart->mapper.state;

    uint8_t bank = data & 0x0F;
    state->ptr_PRG_bank_16K[0] = (uint8_t*)(state->mROM->prg_base + (bank * 16U * 1024U));
    mapper002_remapWindows(state, bus);
}

void mapper002_reset(Mapper* mapper)
{
    Mapper002_state* state = (Mapper002_state*)mapper->state;
    state->ptr_PRG_bank_16K[0] = (uint8_t*)state->mROM->prg_base;
    state->ptr_PRG_bank_16K[1] =
        (uint8_t*)(state->mROM->prg_base + (state->mROM->prg_size - (16U * 1024U)));

    if (state->number_CHR_banks != 0) state->CHR_bank = (uint8_t*)state->mROM->chr_base;
}

void mapper002_mapPages(Mapper* mapper, Bus* bus)
{
    Mapper002_state* state = (Mapper002_state*)mapper->state;

    // $8000-$FFFF: Bank switch
    for (int p = 0x80; p <= 0xFF; p++)
    {
        bus->write_pages[p] = nullptr;
        bus->write_handlers[p] = mapper002_bankWrite;
    }

    // $C000-$FFFF: fixed to last bank, never remapped by writes
    for (int p = 0xC0; p <= 0xFF; p++)
        bus->read_pages[p] = state->ptr_PRG_bank_16K[1] + ((p - 0xC0) * 256);

    // Map bank reads ($8000-$BFFF, switchable)
    mapper002_remapWindows(state, bus);
}

void mapper002_mapPPUPages(Mapper* mapper, Ppu2C02* ppu)
{
    Mapper002_state* state = (Mapper002_state*)mapper->state;
    for (int p = 0x00; p <= 0x1F; p++)
    {
        ppu->ppu_read_pages[p] = state->CHR_bank + (p * 256);
        if (state->number_CHR_banks == 0) ppu->ppu_write_pages[p] = state->CHR_bank + (p * 256);
    }
}

void mapper002_dumpState(Mapper* mapper, File& state)
{
    Mapper002_state* s = (Mapper002_state*)mapper->state;
    uint8_t PRG_16K;
    PRG_16K = (s->ptr_PRG_bank_16K[0] - (uint8_t*)s->mROM->prg_base) / (16U * 1024U);
    state.write((uint8_t*)&PRG_16K, sizeof(PRG_16K));
    if (s->number_CHR_banks == 0) { state.write(s->CHR_bank, 8U * 1024U); }
}

void mapper002_loadState(Mapper* mapper, File& state)
{
    Mapper002_state* s = (Mapper002_state*)mapper->state;
    uint8_t PRG_16K;
    state.read((uint8_t*)&PRG_16K, sizeof(PRG_16K));
    s->ptr_PRG_bank_16K[0] = (uint8_t*)(s->mROM->prg_base + (PRG_16K * (16U * 1024U)));
    if (s->number_CHR_banks == 0) { state.read(s->CHR_bank, 8U * 1024U); }
}

Mapper createMapper002(uint8_t PRG_banks, uint8_t CHR_banks, Cartridge* cart)
{
    Mapper mapper;
    Mapper002_state* state = new (std::nothrow) Mapper002_state;
    if (!state) return mapper;

    if (CHR_banks == 0) state->CHR_bank = (uint8_t*)nes_fast_alloc(8U * 1024U);
    state->mROM = &cart->mROM;

    state->number_PRG_banks = PRG_banks;
    state->number_CHR_banks = CHR_banks;
    state->cart = cart;
    mapper.state = state;
    return mapper;
}

void mapper002_destroy(Mapper* mapper)
{
    if (mapper->state == nullptr) return;
    auto* s = (Mapper002_state*)mapper->state;
    if (s->number_CHR_banks == 0) free(s->CHR_bank);  // senao aponta para a ROM
    delete s;
    mapper->state = nullptr;
}
