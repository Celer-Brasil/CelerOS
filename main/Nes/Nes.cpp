#include "Nes.h"

#ifndef CELER_HOST_TEST
#include <esp_heap_caps.h>
#include <esp_timer.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#endif

#include <cstdio>
#include <new>

namespace nes {
namespace {
// Sink interno do openScreen: copia os blocos de 8 linhas para o fb proprio
// (host/fallback; stride = SCREEN_W).
void fbSink(void* ctx, const uint16_t* rows, int y, int nrows)
{
    Nes* self = (Nes*)ctx;
    uint16_t* fb = (uint16_t*)self->framebuffer();
    if (fb == nullptr || nrows <= 0) return;
    if (y < 0) return;
    if (y + nrows > SCREEN_H) nrows = SCREEN_H - y;
    memcpy(fb + (size_t)y * SCREEN_W, rows, (size_t)nrows * SCREEN_W * sizeof(uint16_t));
}
}  // namespace

#ifndef CELER_HOST_TEST
namespace {
// APU a CPU/2 = 894,886 kHz: quantos ticks por microssegundo o task deve
// clockar para casar o tempo de parede (o Anemoia era paced pelo i2s_write
// bloqueante, ~2,9 ms por buffer; aqui o relogio e o esp_timer e o sink
// segue dando backpressure quando ha audio).
constexpr int kApuTicksPerMs = 895;
constexpr int64_t kApuMaxCatchUpUs = 20000;  // teto do atraso recuperado (20 ms)

void apuTaskFn(void* arg)
{
    Apu2A03* apu = (Apu2A03*)arg;
    int64_t last = esp_timer_get_time();
    while (true)
    {
        const int64_t now = esp_timer_get_time();
        int64_t elapsed = now - last;
        last = now;
        if (elapsed > kApuMaxCatchUpUs) elapsed = kApuMaxCatchUpUs;
        const int ticks = (int)(elapsed * kApuTicksPerMs / 1000);
        for (int i = 0; i < ticks; i++) apu->clock();
        vTaskDelay(1);  // 1 tick: o burst do proximo laco compensa o relogio
    }
}
}  // namespace
#endif

Nes::~Nes()
{
    apuTaskStop();
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
    apuTaskStop();  // a task referencia cpu.apu: para antes de soltar o cartucho
    if (cart != nullptr)
    {
        delete cart;
        cart = nullptr;
        cpu.bus.cart = nullptr;
    }
}

// Task da APU no core 0 (fora do caminho do quadro, como no Anemoia).
// Criada no audioStart e parada no audioStop/unload: sem audio o APU nao
// precisa clockar (jogos NES nao leem o estado dele para logica).
void Nes::apuTaskStart()
{
#ifndef CELER_HOST_TEST
    if (apu_task != nullptr) return;
    xTaskCreatePinnedToCore(apuTaskFn, "nesapu", 4096, &cpu.apu, 2, (TaskHandle_t*)&apu_task, 0);
#endif
}

void Nes::apuTaskStop()
{
#ifndef CELER_HOST_TEST
    if (apu_task == nullptr) return;
    vTaskDelete((TaskHandle_t)apu_task);
    apu_task = nullptr;
#endif
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
    // host/fallback: os blocos caem neste buffer (sem swap: RGB565 host)
    cpu.bus.ppu.setPaletteByteSwap(false);
    cpu.bus.ppu.setChunkSink(&fbSink, this);
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
    cpu.bus.ppu.setChunkSink(nullptr, nullptr);
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
