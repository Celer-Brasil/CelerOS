#ifndef MAPPER_H
#define MAPPER_H

// Base dos mappers do Anemoia. O BankCache LRU (bancos copiados do SD sob
// demanda) ficou no Anemoia: aqui a ROM inteira esta em memoria e os bancos
// sao ponteiros diretos no buffer (caminho FLASH do original), entao nao ha
// cache nem File.

#include <stdint.h>
#include <stdlib.h>

#include "../nes_compat.h"
#include "mirror_mode.h"

#include <cstring>

class Cartridge;
class Bus;
class Ppu2C02;
class Mapper
{
public:
    void* state = nullptr;
};

inline void mapperNoScanline(Mapper*)
{
}
inline void mapperNoCycle(Mapper*, int)
{
}

#endif
