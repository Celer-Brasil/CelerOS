#ifndef MAPPER001_H
#define MAPPER001_H

#include "../mapper.h"

Mapper createMapper001(uint8_t PRG_banks, uint8_t CHR_banks, Cartridge* cart);

void mapper001_mapPages(Mapper* mapper, Bus* bus);
void mapper001_mapPPUPages(Mapper* mapper, Ppu2C02* ppu);
void mapper001_reset(Mapper* mapper);
void mapper001_dumpState(Mapper* mapper, File& state);
void mapper001_loadState(Mapper* mapper, File& state);
#endif
