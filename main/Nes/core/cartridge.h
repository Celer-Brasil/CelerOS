#ifndef CARTRIDGE_H
#define CARTRIDGE_H

#include <stdint.h>

#include "../nes_compat.h"
#include "mapper.h"
#include "mappers/mapper000.h"
#include "mappers/mapper001.h"
#include "mappers/mapper002.h"
#include "mappers/mapper003.h"
#include "mappers/mapper004.h"
#include "mappers/mapper069.h"
#include "mirror_mode.h"
#include "ppu2C02.h"

class Bus;
class Cartridge
{
public:
    Cartridge(const uint8_t* data, uint32_t size);
    ~Cartridge();

    void ppuScanline();
    void cpuCycle(int cycles);
    void reset();

    void mapPages(Bus* bus);
    void mapPPUPages(Ppu2C02* ppu);

    void setMirrorMode(MIRROR mirror);
    MIRROR getMirrorMode();
    uint8_t getMapperId() const { return mapper_ID; }
    void connectBus(Bus* n)
    {
        bus = n;
    }
    void IRQ();

    void dumpState(File& state);
    void loadState(File& state);
    bool isValid();

    MIRROR hardware_mirror;
    MIRROR mirror = MIRROR::HORIZONTAL;
    uint32_t CRC32 = ~0U;
    MappedROM mROM;
    Mapper mapper;

private:
    Bus* bus = nullptr;
    bool is_valid = true;
    const uint8_t* rom_data = nullptr;
    uint32_t rom_size = 0;
    uint32_t prg_base;  // offset do PRG dentro do arquivo
    uint32_t chr_base;  // offset do CHR dentro do arquivo

    uint8_t mapper_ID = 0;
    void createMapper(uint8_t number_PRG_banks, uint8_t number_CHR_banks);
    uint32_t crc32(const void* buf, size_t size, uint32_t seed = ~0U);
};

#endif
