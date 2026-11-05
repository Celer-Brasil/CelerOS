#ifndef PPU2C02_H
#define PPU2C02_H

#include <stdint.h>

#include "../nes_compat.h"
#include "cartridge.h"
#include "mirror_mode.h"
#include "ppu_palettes.h"

#define BUFFER_SIZE          (256 + 8 + 8)
#define SCANLINE_SIZE        256
#define SCANLINES_PER_BUFFER 8
#define TILES_PER_SCANLINE   32
#define PIXELS_PER_TILE      8

// SCANLINES_PER_BUFFER segue sendo o passo do scanline_counter serializado no
// save state (formato do Anemoia); o frame nao usa mais buffer rolante.

class Cartridge;
class Bus;
class Ppu2C02
{
public:
    Ppu2C02();
    ~Ppu2C02();

    void buildPPUPageTables();
    void remapNametablePages();

    void ppuWrite(uint16_t addr, uint8_t data);
    uint8_t ppuRead(uint16_t addr);
    uint8_t* ppuReadPtr(uint16_t addr);
    void cpuWrite(uint16_t addr, uint8_t data);
    uint8_t cpuRead(uint16_t addr);

    void renderScanline(uint16_t current_scanline);
    void fakeSpriteHit(uint16_t current_scanline);
    void setVBlank();
    void clearVBlank();
    void reset();

    void connectBus(Bus* n)
    {
        bus = n;
    }
    void connectCartridge(Cartridge* cartridge);
    // Alvo do frame: stride/offset em PIXELS (o CelerOS pode render direto
    // numa regiao do framebuffer do painel, sem copia intermediaria).
    void connectFramebuffer(uint8_t* framebuffer, int stride = SCANLINE_SIZE, int x0 = 0, int y0 = 0);
    void setMirror(MIRROR mirror);
    MIRROR getMirror();

    void dumpState(File& state);
    void loadState(File& state);

    enum Palette : uint8_t
    {
        NTSC565,
        PAL565,
        NTSC222,
        PAL222,
        PaletteCount
    };
    // Sink dos blocos de 8 scanlines (RGB565, 256 px por linha): o desenho
    // no vidro e responsabilidade do dono — no Anemoia era o pushPixelsDMA no
    // TFT; aqui o binding usa o pushImage do LovyanGFX (o caminho suportado
    // do painel RGB: copia crua no framebuffer viola a regra da cache line de
    // 64 B do 4848 e faulta na bancada).
    typedef void (*ChunkSink)(void* ctx, const uint16_t* rows, int y, int nrows);
    void setChunkSink(ChunkSink cb, void* ctx)
    {
        chunk_sink = cb;
        chunk_ctx = ctx;
    }
    void setPalette(uint8_t palette);
    // Byte order do alvo: o painel/FrameSprite do CelerOS usa a convencao
    // setSwapBytes(true) — quem escreve RAW (o PPU) precisa das tabelas
    // _swap. O Anemoia escolhia em compile-time (SCREEN_SWAP_BYTES).
    void setPaletteByteSwap(bool on)
    {
        byte_swap = on;
        applyPalette();
    }

    static constexpr int PPU_PAGE_SIZE = 256;
    static constexpr int NUM_PPU_PAGES = 0x4000 / PPU_PAGE_SIZE;
    using PPUReadHandler = uint8_t (*)(Ppu2C02*, uint16_t);
    using PPUWriteHandler = void (*)(Ppu2C02*, uint16_t, uint8_t);

    uint8_t* ppu_read_pages[NUM_PPU_PAGES] = {};
    uint8_t* ppu_write_pages[NUM_PPU_PAGES] = {};
    PPUReadHandler ppu_read_handlers[NUM_PPU_PAGES] = {};
    PPUWriteHandler ppu_write_handlers[NUM_PPU_PAGES] = {};

private:
    Cartridge* cart = nullptr;
    Bus* bus = nullptr;

    void renderBackground();
    void renderSprites();
    void transferScroll();
    void incrementY();
    void finishScanline();
    uint8_t nametable[2048];
    uint8_t* ptr_nametable[4];
    uint8_t palette_table[32];
    uint8_t scanline_counter = 0;
    uint8_t scanline_buffer[BUFFER_SIZE];
    uint8_t scanline_metadata[BUFFER_SIZE];
    // Bloco rolante de 8 scanlines (4 KB, RAM interna) + sink do bloco: o
    // modelo do Anemoia original. O render NUNCA escreve no framebuffer do
    // vidro (na PSRAM do painel cada escrita e um cache miss e a copia crua
    // viola a regra da cache line); a cada 8 linhas o bloco sai pelo sink
    // (pushImage do LovyanGFX no binding, incremental como o pushPixelsDMA).
    static constexpr int kChunkRows = SCANLINES_PER_BUFFER;
    uint16_t chunk_buffer[kChunkRows * SCANLINE_SIZE];
    int chunk_rows = 0;  // linhas prontas no bloco atual
    void flushChunk();
    ChunkSink chunk_sink = nullptr;
    void* chunk_ctx = nullptr;

    const uint16_t (*nes_palette)[64] = palette_NTSC565;
    uint8_t palette_idx = 0;
    bool byte_swap = false;
    // (alvo do frame: o sink de blocos; ver setChunkSink)
    int fb_x0 = 0;
    int fb_y0 = 0;
    void applyPalette();
    static constexpr uint8_t palette_mirror[32] = {
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A,
        0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x00, 0x11, 0x12, 0x13, 0x04, 0x15,
        0x16, 0x17, 0x08, 0x19, 0x1A, 0x1B, 0x0C, 0x1D, 0x1E, 0x1F
    };

    // PPU Registers
    // PPUCTRL
    union
    {
        struct
        {
            uint8_t nametable_x : 1;
            uint8_t nametable_y : 1;
            uint8_t VRAM_addr_increment : 1;
            uint8_t sprite_table_addr : 1;
            uint8_t background_table_addr : 1;
            uint8_t sprite_size : 1;
            uint8_t PPU_master_select : 1;
            uint8_t Vblank_NMI : 1;
        };
        uint8_t reg = 0x00;
    } control;

    // PPUMASK
    union
    {
        struct
        {
            uint8_t grayscale : 1;
            uint8_t render_background_left : 1;
            uint8_t render_sprite_left : 1;
            uint8_t render_background : 1;
            uint8_t render_sprite : 1;
            uint8_t emphasize : 3;
        };
        uint8_t reg = 0x00;
    } mask;

    // PPUSTATUS
    union
    {
        struct
        {
            uint8_t unused : 5;
            uint8_t sprite_overflow : 1;
            uint8_t sprite_zero_hit : 1;
            uint8_t VBlank : 1;
        };
        uint8_t reg = 0x00;
    } status;

    // OAMADDR
    uint8_t OAMADDR = 0x00;
    // OAMDATA
    uint8_t OAMDATA = 0x00;

    // Internal register
    typedef union
    {
        struct
        {
            uint16_t coarse_x : 5;
            uint16_t coarse_y : 5;
            uint16_t nametable_x : 1;
            uint16_t nametable_y : 1;
            uint16_t fine_y : 3;
            uint16_t unused : 1;
        };
        uint16_t reg = 0x00;
    } internal_register;

    // OAM
    typedef struct
    {
        uint8_t y;
        uint8_t index;
        uint8_t attribute;
        uint8_t x;
    } OAM;

    OAM sprite[64];
    internal_register v;
    internal_register t;
    uint8_t x;
    uint8_t w;
    uint8_t PPUDATA_buffer = 0x00;

    // Rendering
    uint16_t scanline = 0x00;
    uint8_t* ptr_scanline_meta = nullptr;

    static uint8_t paletteReadHandler(Ppu2C02* ppu, uint16_t addr);
    static void paletteWriteHandler(Ppu2C02* ppu, uint16_t addr, uint8_t data);
    static uint8_t defaultPPUReadHandler(Ppu2C02* ppu, uint16_t addr);
    static void defaultPPUWriteHandler(Ppu2C02* ppu, uint16_t addr, uint8_t data);

public:
    uint8_t* ptr_sprite = (uint8_t*)sprite;
    uint8_t* ptr_buffer = scanline_buffer;
};

#endif
