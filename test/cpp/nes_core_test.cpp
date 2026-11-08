// Contratos do core NES (tools/native/nes) fora da APU: o que um jogo de
// NES espera do hardware e que a bancada do 4848 (SMB) nao exercita.
// Cada CHECK aqui fixa uma correcao da caca (ou um comportamento do
// hardware que nao pode regredir):
//   - ROM truncada (header declara mais PRG/CHR que o arquivo) e recusada,
//     sem leitura fora do buffer (era segfault no CRC32);
//   - RESET quente PRESERVA o PRG-RAM do cartucho (save de bateria);
//     o zero so acontece no power-on (load);
//   - mascara da coluna esquerda ($2001 bits 1/2): fundo e sprites escondidos
//     nos 8 primeiros pixels quando os bits valem 0;
//   - sprite overflow ($2002 bit 5) so sobe quando um 9o sprite esta na
//     linha (com exatamente 8, nao sobe);
//   - mappers 2/3 mascaram o banco pelo tamanho da ROM (banco maior que o
//     cartucho nao le fora do PRG/CHR).
//
// g++ -std=c++17 -Wall -Wextra -DCELER_HOST_TEST -Itools/native/nes
//     -o nes_core_test test/cpp/nes_core_test.cpp tools/native/nes/NesCore.cpp
//     tools/native/nes/Nes.cpp && ./nes_core_test
#include "Nes.h"

#include <cstdio>
#include <cstring>
#include <vector>

namespace {

int g_fail = 0;

#define CHECK(cond, msg)                                                                       \
    do                                                                                         \
    {                                                                                          \
        if (cond) { printf("OK: %s\n", msg); }                                                 \
        else { printf("FALHA: %s\n", msg); g_fail++; }                                         \
    } while (0)

// iNES: 16 bytes de header + PRG + CHR (byte8 = 1: 8 KB de PRG-RAM)
std::vector<uint8_t> makeRom(uint8_t prgBanks, uint8_t chrBanks, uint8_t byte6, uint8_t byte7,
                             uint32_t prgBytes, uint32_t chrBytes)
{
    uint8_t h[16] = {'N', 'E', 'S', 0x1A, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
    h[4] = prgBanks;
    h[5] = chrBanks;
    h[6] = byte6;
    h[7] = byte7;
    h[8] = 1;
    std::vector<uint8_t> rom;
    rom.insert(rom.end(), h, h + 16);
    rom.resize(rom.size() + prgBytes, 0xEA);  // NOPs no PRG
    rom.resize(rom.size() + chrBytes, 0x00);
    return rom;
}

// Escrita de registrador da PPU (o bus mascara $2000-$2007 antes de chamar o
// objeto; direto no objeto o endereco ja vai 0..7)
void regWrite(Ppu2C02& ppu, uint16_t reg, uint8_t v) { ppu.cpuWrite(reg & 7, v); }
uint8_t regRead(Ppu2C02& ppu, uint16_t reg) { return ppu.cpuRead(reg & 7); }

// $2006/$2007: aponta v e escreve um byte no espaco da PPU
void ppuAddrWrite(Ppu2C02& ppu, uint16_t addr, uint8_t v)
{
    regWrite(ppu, 0x2006, (uint8_t)(addr >> 8));
    regWrite(ppu, 0x2006, (uint8_t)addr);
    regWrite(ppu, 0x2007, v);
}

}  // namespace

// A ROM truncada e recusada sem ler fora do arquivo (bancada do executor: o
// CRC32 lia number_PRG_banks * 16K alem do fim e segfaultava no host; no
// blob seria leitura de PSRAM alheia depois do bloco da scratch)
int testTruncatedRom()
{
    // header declara 8 bancos PRG (128 KB), arquivo so tem 2 + 8 KB CHR
    std::vector<uint8_t> rom = makeRom(8, 1, 0x00, 0x00, 32 * 1024, 8 * 1024);
    nes::Nes n;
    const char* err = nullptr;
    bool ok = n.load(rom.data(), (uint32_t)rom.size(), nullptr, nullptr, &err);
    printf("  (truncada: declara 128K PRG, tem 32K) load=%d err=%s\n", ok ? 1 : 0, err ? err : "-");
    CHECK(!ok, "ROM truncada e recusada");
    return 0;
}

// Decode do mapper: iNES e NES 2.0 poem o nibble alto nos bits 4-7 do byte 7
int testMapperDecode()
{
    {
        std::vector<uint8_t> rom = makeRom(32, 0, 0x50, 0x40, 32 * 16384, 0);  // iNES 0x45
        nes::Nes n;
        uint8_t mapper = 0;
        n.load(rom.data(), (uint32_t)rom.size(), nullptr, &mapper, nullptr);
        CHECK(mapper == 69, "mapper 69 no iNES (byte7 = 0x40)");
    }
    {
        std::vector<uint8_t> rom = makeRom(32, 0, 0x50, 0x48, 32 * 16384, 0);  // NES 2.0
        nes::Nes n;
        uint8_t mapper = 0;
        n.load(rom.data(), (uint32_t)rom.size(), nullptr, &mapper, nullptr);
        CHECK(mapper == 69, "mapper 69 no NES 2.0 (byte7 = 0x48)");
    }
    {
        // NES 2.0 com mapper 1 (nibble alto 0): o marcador 0x08 nao pode
        // vazar para o numero do mapper
        std::vector<uint8_t> rom = makeRom(2, 1, 0x10, 0x08, 2 * 16384, 8 * 1024);
        nes::Nes n;
        uint8_t mapper = 0;
        bool ok = n.load(rom.data(), (uint32_t)rom.size(), nullptr, &mapper, nullptr);
        CHECK(ok && mapper == 1, "NES 2.0 com mapper baixo (byte7 = 0x08)");
    }
    return 0;
}

// RESET quente preserva o PRG-RAM (save de bateria em $6000-$7FFF)
int testBatteryReset()
{
    std::vector<uint8_t> rom = makeRom(2, 1, 0x10, 0x00, 2 * 16384, 8 * 1024);  // mapper 1
    nes::Nes n;
    CHECK(n.load(rom.data(), (uint32_t)rom.size(), nullptr, nullptr, nullptr), "load mapper 1");
    CHECK(n.openScreen(), "openScreen");
    n.reset();  // monta as tabelas de pagina (fluxo do CORE_LOAD)
    n.cpu.bus.cpuWrite(0x6000, 0xAB);
    n.reset();
    uint8_t v = n.cpu.bus.cpuRead(0x6000);
    printf("  ($6000 apos RESET) = 0x%02X\n", v);
    CHECK(v == 0xAB, "PRG-RAM preservado no RESET quente");
    return 0;
}

// Mascara da coluna esquerda ($2001 bit1: fundo; bit2: sprites)
int testLeftColumnMask()
{
    std::vector<uint8_t> rom = makeRom(2, 1, 0x00, 0x00, 2 * 16384, 8 * 1024);  // mapper 0
    nes::Nes n;
    CHECK(n.load(rom.data(), (uint32_t)rom.size(), nullptr, nullptr, nullptr), "load mapper 0");
    CHECK(n.openScreen(), "openScreen");
    n.reset();
    Ppu2C02& ppu = n.cpu.bus.ppu;

    // CHR: tile 1 com todos os pixels = cor 3 (lo = hi = 0xFF)
    memset(rom.data() + 16 + 2 * 16384 + 16, 0xFF, 16);

    // paleta: $3F00 = backdrop (0x00), $3F03 = cor 3 (0x30)
    ppuAddrWrite(ppu, 0x3F00, 0x00);
    ppuAddrWrite(ppu, 0x3F03, 0x30);
    // nametable: linha 0, tiles 0..1 = tile 1 (sem transparencia)
    ppuAddrWrite(ppu, 0x2000, 0x01);
    ppuAddrWrite(ppu, 0x2001, 0x01);
    // t -> $2000, scroll fino 0 (depois das escritas de nametable)
    regWrite(ppu, 0x2006, 0x20);
    regWrite(ppu, 0x2006, 0x00);
    regWrite(ppu, 0x2005, 0x00);
    regWrite(ppu, 0x2005, 0x00);

    // fundo ligado, coluna esquerda cortada: $2001 = 0b00001000
    regWrite(ppu, 0x2001, 0x08);
    ppu.renderScanline(0);
    printf("  (bit1=0) px[0]=0x%02X px[7]=0x%02X px[8]=0x%02X\n", ppu.ptr_buffer[0],
           ppu.ptr_buffer[7], ppu.ptr_buffer[8]);
    CHECK(ppu.ptr_buffer[0] == 0x00 && ppu.ptr_buffer[7] == 0x00,
          "coluna esquerda = backdrop quando bit1 de $2001 = 0");
    CHECK(ppu.ptr_buffer[8] == 0x30, "resto da linha com o tile");

    // coluna esquerda mostrada: $2001 = 0b00001010
    regWrite(ppu, 0x2001, 0x0A);
    ppu.renderScanline(0);
    CHECK(ppu.ptr_buffer[0] == 0x30, "coluna esquerda com tile quando bit1 de $2001 = 1");

    // sprite na coluna esquerda com bit2 = 0: nao desenha nem marca hit
    uint8_t* o = ppu.ptr_sprite;
    o[0] = 4;  // y (linha 5)
    o[1] = 1;  // tile 1 (cor 3)
    o[2] = 0;  // attribute: frente, sem flip
    o[3] = 0;  // x = 0: invade a coluna cortada
    ppu.clearVBlank();
    regWrite(ppu, 0x2001, 0x18);  // fundo + sprite, colunas cortadas (bits 1/2 = 0)
    ppu.renderScanline(5);
    printf("  (bit2=0, sprite x=0) px[0]=0x%02X px[7]=0x%02X px[8]=0x%02X\n", ppu.ptr_buffer[0],
           ppu.ptr_buffer[7], ppu.ptr_buffer[8]);
    CHECK(ppu.ptr_buffer[0] == 0x00 && ppu.ptr_buffer[7] == 0x00 && ppu.ptr_buffer[8] == 0x30,
          "sprite nao pinta a coluna esquerda quando bit2 de $2001 = 0");
    return 0;
}

// Sprite overflow: o flag ($2002 bit 5) so sobe com um 9o sprite na linha
int testSpriteOverflow()
{
    std::vector<uint8_t> rom = makeRom(2, 1, 0x00, 0x00, 2 * 16384, 8 * 1024);  // mapper 0
    nes::Nes n;
    CHECK(n.load(rom.data(), (uint32_t)rom.size(), nullptr, nullptr, nullptr), "load mapper 0");
    CHECK(n.openScreen(), "openScreen");
    n.reset();
    Ppu2C02& ppu = n.cpu.bus.ppu;
    memset(rom.data() + 16 + 2 * 16384 + 16, 0xFF, 16);  // tile 1 nao transparente

    // OAM fora da tela (y = 0xF8), como os jogos preenchem
    for (int i = 0; i < 64; i++) ppu.ptr_sprite[i * 4] = 0xF8;
    for (int i = 0; i < 8; i++)
    {
        uint8_t* o = ppu.ptr_sprite + i * 4;
        o[0] = 4;  // sprite_y = 5
        o[1] = 1;
        o[2] = 0;
        o[3] = (uint8_t)(10 + i * 8);
    }
    regWrite(ppu, 0x2000, 0x00);  // sprites 8x8 na tabela $0000
    regWrite(ppu, 0x2001, 0x10);  // sprites ligados
    ppu.renderScanline(5);
    uint8_t st = regRead(ppu, 0x2002);
    printf("  (8 sprites na linha) overflow = %d\n", (st >> 5) & 1);
    CHECK(((st >> 5) & 1) == 0, "8 sprites nao setam overflow");

    uint8_t* o = ppu.ptr_sprite + 8 * 4;
    o[0] = 4;
    o[1] = 1;
    o[2] = 0;
    o[3] = 90;
    ppu.clearVBlank();
    ppu.renderScanline(5);
    st = regRead(ppu, 0x2002);
    printf("  (9 sprites na linha) overflow = %d\n", (st >> 5) & 1);
    CHECK(((st >> 5) & 1) == 1, "9 sprites setam overflow");
    return 0;
}

// Mappers 2/3 mascaram o banco pelo tamanho da ROM
int testBankMask()
{
    {
        // CNROM com 8 bancos de CHR: banco 7 (o & 0x03 antigo limitava a 4)
        std::vector<uint8_t> rom = makeRom(4, 8, 0x30, 0x00, 4 * 16384, 8 * 8192);  // mapper 3
        nes::Nes n;
        CHECK(n.load(rom.data(), (uint32_t)rom.size(), nullptr, nullptr, nullptr), "load mapper 3");
        CHECK(n.openScreen(), "openScreen");
        n.reset();
        memset(rom.data() + 16 + 4 * 16384 + 7 * 8192, 0x33, 32);
        n.cpu.bus.cpuWrite(0x8000, 7);  // seleciona banco 7
        Ppu2C02& ppu = n.cpu.bus.ppu;
        regWrite(ppu, 0x2006, 0x00);
        regWrite(ppu, 0x2006, 0x10);          // tile 1, row 0
        regRead(ppu, 0x2007);                 // $2007 le bufferizado: 1a devolve lixo
        uint8_t v = regRead(ppu, 0x2007);
        printf("  (banco CHR 7) tile 1 lo[0] = 0x%02X\n", v);
        CHECK(v == 0x33, "mapper 3 enxerga bancos de CHR acima de 4");
    }
    {
        // UNROM com 8 bancos de PRG: banco 7 (o & 0x0F deixava, mas com 4
        // bancos escolheria fora do cartucho)
        std::vector<uint8_t> rom = makeRom(4, 0, 0x20, 0x00, 4 * 16384, 0);  // mapper 2, CHR-RAM
        nes::Nes n;
        CHECK(n.load(rom.data(), (uint32_t)rom.size(), nullptr, nullptr, nullptr), "load mapper 2");
        CHECK(n.openScreen(), "openScreen");
        n.reset();
        memset(rom.data() + 16 + 3 * 16384, 0x5A, 32);  // marca o banco 3 (ultimo)
        n.cpu.bus.cpuWrite(0x8000, 3);
        uint8_t v = n.cpu.bus.cpuRead(0x8000);
        printf("  (banco PRG 3) $8000 = 0x%02X\n", v);
        CHECK(v == 0x5A, "mapper 2 troca para o banco pedido");
    }
    return 0;
}

int main()
{
    testMapperDecode();
    testTruncatedRom();
    testBatteryReset();
    testLeftColumnMask();
    testSpriteOverflow();
    testBankMask();
    if (g_fail)
    {
        printf("\n%s (%d falhas)\n", "FALHAS", g_fail);
        return 1;
    }
    printf("\nOK: contratos do core NES\n");
    return 0;
}
