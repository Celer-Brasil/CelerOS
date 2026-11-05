#ifndef MAPPER002_H
#define MAPPER002_H

#include "../mapper.h"

struct Mapper002_state
{
    Cartridge* cart = nullptr;
    MappedROM* mROM = nullptr;
    uint8_t number_PRG_banks;
    uint8_t number_CHR_banks;
    uint8_t* ptr_PRG_bank_16K[2];
    uint8_t* CHR_bank = nullptr;
};

Mapper createMapper002(uint8_t PRG_banks, uint8_t CHR_banks, Cartridge* cart);
void mapper002_destroy(Mapper* mapper);  // solta estado + RAMs do mapper

void mapper002_mapPages(Mapper* mapper, Bus* bus);
void mapper002_mapPPUPages(Mapper* mapper, Ppu2C02* ppu);
void mapper002_reset(Mapper* mapper);
void mapper002_dumpState(Mapper* mapper, File& state);
void mapper002_loadState(Mapper* mapper, File& state);
#endif
