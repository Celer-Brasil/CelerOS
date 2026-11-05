#include "Nes.h"

#ifndef CELER_HOST_TEST
#include <esp_heap_caps.h>
#endif

#include <cstdio>
#include <new>

namespace nes {

Nes::~Nes()
{
    closeScreen();
    unload();
}

bool Nes::load(const uint8_t* data, uint32_t size, uint32_t* crc32, uint8_t* mapperId, const char** err)
{
    if (err) *err = nullptr;
    if (cart != nullptr) unload();

    if (data == nullptr || size < 16 || size > MAX_ROM_SIZE)
    {
        if (err) *err = "rom vazia ou grande demais";
        return false;
    }
    if (data[0] != 'N' || data[1] != 'E' || data[2] != 'S' || data[3] != 0x1A)
    {
        if (err) *err = "nao e arquivo iNES";
        return false;
    }

    cart = new (std::nothrow) Cartridge(data, size);
    if (cart == nullptr)
    {
        if (err) *err = "sem memoria para o cartucho";
        return false;
    }
    if (!cart->isValid())
    {
        delete cart;
        cart = nullptr;
        if (err) *err = "mapper nao suportado";
        return false;
    }
    if (cart->mapper.state == nullptr)
    {
        delete cart;
        cart = nullptr;
        if (err) *err = "sem memoria para o mapper";
        return false;
    }

    if (crc32) *crc32 = cart->CRC32;
    if (mapperId) *mapperId = cart->getMapperId();
    cpu.bus.insertCartridge(cart);
    return true;
}

void Nes::unload()
{
    if (cart != nullptr)
    {
        delete cart;
        cart = nullptr;
        cpu.bus.cart = nullptr;
    }
}

bool Nes::openScreen()
{
    if (fb != nullptr) return true;
    if (cart == nullptr) return false;

    // PSRAM no device (122 KB nao cabem no heap interno do app); malloc no host
#ifndef CELER_HOST_TEST
    fb = (uint16_t*)heap_caps_malloc(SCREEN_W * SCREEN_H * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    if (fb == nullptr) fb = (uint16_t*)malloc(SCREEN_W * SCREEN_H * sizeof(uint16_t));
#else
    fb = (uint16_t*)malloc(SCREEN_W * SCREEN_H * sizeof(uint16_t));
#endif
    if (fb == nullptr) return false;
    memset(fb, 0, SCREEN_W * SCREEN_H * sizeof(uint16_t));
    cpu.bus.ppu.connectFramebuffer((uint8_t*)fb);
    return true;
}

void Nes::closeScreen()
{
    if (fb == nullptr) return;
#ifndef CELER_HOST_TEST
    heap_caps_free(fb);
#else
    free(fb);
#endif
    fb = nullptr;
    cpu.bus.ppu.connectFramebuffer(nullptr);
}

void Nes::reset()
{
    if (!loaded()) return;
    cpu.reset();  // ja refaz as tabelas do bus por dentro (bus.reset())
}

void Nes::frame(uint8_t buttons, bool render)
{
    if (!loaded()) return;
    cpu.bus.setController(buttons);
    cpu.clockFrame(render);
}

bool Nes::saveState(File& out)
{
    if (!loaded()) return false;

    // Mesma sequencia do saveState do Anemoia (nes.cpp): header + RAM + CPU +
    // PPU + mapper. Quem consome os bytes e o binding (FileSystem do app).
    char crcStr[9];
    snprintf(crcStr, sizeof(crcStr), "%08lX", (unsigned long)cpu.bus.cart->CRC32);
    out.write((const uint8_t*)"ANEMOIA", 7);
    out.write((const uint8_t*)crcStr, 8);

    out.write(cpu.bus.RAM, sizeof(cpu.bus.RAM));
    cpu.dumpState(out);
    cpu.bus.ppu.dumpState(out);
    cpu.bus.cart->dumpState(out);
    return true;
}

bool Nes::loadState(File& in)
{
    if (!loaded()) return false;

    char header[8] = {};
    char crc[9] = {};
    char crcStr[9];
    snprintf(crcStr, sizeof(crcStr), "%08lX", (unsigned long)cpu.bus.cart->CRC32);

    if (in.read((uint8_t*)header, 7) != 7) return false;
    if (in.read((uint8_t*)crc, 8) != 8) return false;
    if (memcmp(header, "ANEMOIA", 7) != 0 || memcmp(crc, crcStr, 8) != 0) return false;

    in.read(cpu.bus.RAM, sizeof(cpu.bus.RAM));
    cpu.loadState(in);
    cpu.bus.ppu.loadState(in);
    cpu.bus.cart->loadState(in);
    return true;
}

}  // namespace nes
