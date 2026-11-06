// Teste host do nucleo do Atari 2600 (gate g++ do CI).
//
// Cobre: CPU cycle-stepped (semantica/ciclos/decimal/ilegais/IRQ), TIA
// (RESP/HMOVE/playfield/colisoes/WSYNC/audio), cartuchos (2K/4K/F8/F6/F4/3F/
// E0/UA/SC), RIOT (timer/portas) e um quadro real de um kernel sintetico
// (VSYNC + 37 linhas de VBLANK + 192 visiveis com playfield) + save/load
// deterministico.

#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <vector>

#include "a2600.h"
#include "cpu6502_cycle.h"
#include "emu_state.h"
#include "emu_video.h"
#include "cart_a2600.h"
#include "riot6532.h"
#include "tia.h"

using namespace emu;
using namespace emu::a2600;

static int g_fails = 0, g_checks = 0;
#define CHECK(c, m)                                                       \
    do {                                                                  \
        g_checks++;                                                       \
        if (!(c)) {                                                       \
            g_fails++;                                                    \
            printf("FAIL %s (%s:%d)\n", m, __FILE__, __LINE__);           \
        }                                                                 \
    } while (0)

// ---------------------------------------------------------------- CPU
struct CpuRam {
    uint8_t mem[65536];
    int ticks;
    bool stall;
    bool irqLine;
};
static uint8_t cpuRd(void* c, uint16_t a) { return ((CpuRam*)c)->mem[a]; }
static void cpuWr(void* c, uint16_t a, uint8_t v) { ((CpuRam*)c)->mem[a] = v; }
static void cpuTick(void* c) { ((CpuRam*)c)->ticks++; }
static bool cpuStall(void* c) { return ((CpuRam*)c)->stall; }
static bool cpuIrq(void* c) { return ((CpuRam*)c)->irqLine; }

static CpuBus cpuBus(CpuRam* r)
{
    CpuBus b;
    b.ctx = r;
    b.read = cpuRd;
    b.write = cpuWr;
    b.tick = cpuTick;
    b.stalled = cpuStall;
    b.irq = cpuIrq;
    return b;
}

static void cpuSetup(Cpu6502& cpu, CpuRam& r, const uint8_t* prog, int n, uint16_t at = 0x8000)
{
    memset(&r, 0, sizeof(r));
    memcpy(r.mem + at, prog, (size_t)n);
    cpu.pc = at;
    cpu.p = Cpu6502::kU | Cpu6502::kI;
    cpu.sp = 0xFD;
    cpu.cycles = 0;
    cpu.jammed = false;
    r.mem[0xFFFC] = 0x00;
    r.mem[0xFFFD] = 0x80;
    r.mem[0xFFFE] = 0x00;
    r.mem[0xFFFF] = 0x90;
    r.mem[0xFFFA] = 0x00;
    r.mem[0xFFFB] = 0xA0;
}

static void testCpu()
{
    CpuRam r;
    Cpu6502 cpu;
    CpuBus b = cpuBus(&r);

    {
        const uint8_t p[] = {0xA9, 0x42, 0x85, 0x10, 0xA2, 0x05, 0xE8, 0xCA};
        cpuSetup(cpu, r, p, sizeof(p));
        cpu.step(&b);
        CHECK(cpu.a == 0x42, "LDA imm");
        CHECK(r.ticks == 2, "LDA imm 2 ciclos");
        cpu.step(&b);
        CHECK(r.mem[0x10] == 0x42, "STA zp");
        CHECK(r.ticks == 5, "STA zp 3 ciclos");
        cpu.step(&b);
        cpu.step(&b);
        cpu.step(&b);
        CHECK(cpu.x == 0x05, "LDX/INX/DEX");
    }
    {
        const uint8_t p[] = {0xF8, 0xA9, 0x99, 0x18, 0x69, 0x01};
        cpuSetup(cpu, r, p, sizeof(p));
        for (int i = 0; i < 4; i++) cpu.step(&b);
        CHECK(cpu.a == 0x00, "ADC decimal 99+01");
        CHECK(cpu.flag(Cpu6502::kC), "ADC decimal carry");
        CHECK(!cpu.flag(Cpu6502::kZ), "ADC decimal Z binario (NMOS)");
    }
    {
        const uint8_t p[] = {0xF8, 0x38, 0xA9, 0x00, 0xE9, 0x01};
        cpuSetup(cpu, r, p, sizeof(p));
        for (int i = 0; i < 4; i++) cpu.step(&b);
        CHECK(cpu.a == 0x99, "SBC decimal 00-01");
        CHECK(!cpu.flag(Cpu6502::kC), "SBC decimal borrow");
    }
    {
        const uint8_t p[] = {0xA9, 0xFF, 0xA2, 0x0F, 0x87, 0x20, 0xA7, 0x20};
        cpuSetup(cpu, r, p, sizeof(p));
        cpu.step(&b);
        cpu.step(&b);
        cpu.step(&b);
        CHECK(r.mem[0x20] == 0x0F, "SAX");
        cpu.a = 0;
        cpu.x = 0;
        cpu.step(&b);
        CHECK(cpu.a == 0x0F && cpu.x == 0x0F, "LAX");
    }
    {
        const uint8_t p[] = {0xA9, 0x0F, 0xC7, 0x20};
        cpuSetup(cpu, r, p, sizeof(p));
        r.mem[0x20] = 0x10;
        cpu.step(&b);
        cpu.step(&b);
        CHECK(r.mem[0x20] == 0x0F, "DCP decrementa");
        CHECK(cpu.flag(Cpu6502::kZ) && cpu.flag(Cpu6502::kC), "DCP flags");
    }
    {
        const uint8_t p[] = {0xA9, 0x01, 0x07, 0x20};
        cpuSetup(cpu, r, p, sizeof(p));
        r.mem[0x20] = 0x40;
        cpu.step(&b);
        cpu.step(&b);
        CHECK(r.mem[0x20] == 0x80, "SLO ASL mem");
        CHECK(cpu.a == 0x81, "SLO ORA");
    }
    {
        const uint8_t p[] = {0xA2, 0x01, 0xBD, 0xFF, 0x80};
        cpuSetup(cpu, r, p, sizeof(p));
        r.mem[0x8100] = 0x77;
        cpu.step(&b);
        const int t0 = r.ticks;
        cpu.step(&b);
        CHECK(cpu.a == 0x77, "LDA abs,X");
        CHECK(r.ticks - t0 == 5, "LDA abs,X page cross = 5");
    }
    {
        const uint8_t p[] = {0xA9, 0x00, 0xF0, 0x02, 0xEA, 0xA9, 0x01};
        cpuSetup(cpu, r, p, sizeof(p));
        cpu.step(&b);
        const int t0 = r.ticks;
        cpu.step(&b);
        CHECK(cpu.pc == 0x8006, "BEQ destino");
        CHECK(r.ticks - t0 == 3, "BEQ tomado = 3");
    }
    {
        const uint8_t p[] = {0x20, 0x10, 0x80, 0xA9, 0x55, 0x00, 0x00, 0x00,
                             0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                             0xA9, 0x7E, 0x60};
        cpuSetup(cpu, r, p, sizeof(p));
        cpu.step(&b);
        CHECK(cpu.pc == 0x8010, "JSR entra");
        cpu.step(&b);
        const int t0 = r.ticks;
        cpu.step(&b);
        CHECK(cpu.pc == 0x8003, "RTS volta");
        CHECK(cpu.a == 0x7E, "subrotina rodou");
        CHECK(r.ticks - t0 == 6, "RTS 6 ciclos");
    }
    {
        const uint8_t p[] = {0xEA, 0xEA};
        cpuSetup(cpu, r, p, sizeof(p));
        cpu.p &= (uint8_t)~Cpu6502::kI;
        r.irqLine = true;
        cpu.step(&b);
        CHECK(cpu.pc == 0x9000, "IRQ vetor");
        CHECK(cpu.flag(Cpu6502::kI), "IRQ seta I");
        CHECK(r.mem[0x01FD] == 0x80, "IRQ empilha PCH");
        r.irqLine = false;
    }
}

// ---------------------------------------------------------------- TIA
static void tiaLine(Tia& t, int ticks)
{
    for (int i = 0; i < ticks; i++) t.tick();
}

static void testTia()
{
    static uint16_t fb[160 * 192];
    static Tia t;

    // fundo
    t.setFramebuffer(fb);
    t.reset();
    t.write(0x09, 0x00);  // COLUBK preto
    t.write(0x01, 0x00);  // VBLANK off
    tiaLine(t, 76);
    bool allBlack = true;
    for (int i = 0; i < 160; i++)
        if (t.lineBuffer()[i] != 0) allBlack = false;
    CHECK(allBlack, "TIA fundo preto");

    // player: RESP em clock 66; 8 px = 66..73; visiveis 68..73 (x 0..5)
    t.reset();
    t.setFramebuffer(fb);
    t.write(0x01, 0x00);
    t.write(0x06, 0x1E);  // COLUP0 ouro
    t.write(0x1B, 0xFF);  // GRP0
    tiaLine(t, 22);       // clock 66
    t.write(0x10, 0x00);  // RESP0
    tiaLine(t, 54);       // fecha a linha
    const uint16_t gold = emu_rgb565(255, 226, 80);
    CHECK(t.lineBuffer()[0] == gold, "player em x=0");
    CHECK(t.lineBuffer()[5] == gold, "player ate x=5");
    CHECK(t.lineBuffer()[6] == 0, "player termina em x=6");

    // HMOVE +1 desloca um pixel: 67..74 -> x 0..6
    t.reset();
    t.setFramebuffer(fb);
    t.write(0x01, 0x00);
    t.write(0x06, 0x1E);
    t.write(0x1B, 0xFF);
    tiaLine(t, 22);
    t.write(0x20, 0x10);  // HMP0 = +1
    t.write(0x10, 0x00);  // RESP0
    t.write(0x2A, 0x00);  // HMOVE
    tiaLine(t, 54);
    CHECK(t.lineBuffer()[0] == gold, "HMOVE x=0");
    CHECK(t.lineBuffer()[6] == gold, "HMOVE x=6");
    CHECK(t.lineBuffer()[7] == 0, "HMOVE termina em x=7");

    // playfield: PF2 bits 5-7 on -> x 0..11 ligados; x=20 desligado
    t.reset();
    t.setFramebuffer(fb);
    t.write(0x01, 0x00);
    t.write(0x08, 0x1E);  // COLUPF
    t.write(0x0F, 0xE0);  // PF2
    tiaLine(t, 76);
    CHECK(t.lineBuffer()[0] == gold, "playfield x=0");
    CHECK(t.lineBuffer()[20] == 0, "playfield x=20 off");

    // colisoes: P0 e P1 em 66; CXPPMM bit7 e limpo na leitura
    t.reset();
    t.setFramebuffer(fb);
    t.write(0x01, 0x00);
    t.write(0x06, 0x1E);
    t.write(0x07, 0x1E);
    t.write(0x1B, 0xFF);
    t.write(0x1C, 0xFF);
    tiaLine(t, 22);
    t.write(0x10, 0x00);
    t.write(0x11, 0x00);
    tiaLine(t, 54);
    CHECK((t.read(0x37) & 0x80) != 0, "colisao P0-P1");
    CHECK((t.read(0x37) & 0x80) == 0, "leitura limpa colisao");

    // WSYNC para a CPU ate o fim da linha
    t.reset();
    t.setFramebuffer(fb);
    tiaLine(t, 10);
    t.write(0x02, 0x00);
    CHECK(t.wsync(), "WSYNC liga");
    tiaLine(t, 66);
    CHECK(!t.wsync(), "WSYNC solta no fim da linha");

    // audio: canal 0 com volume gera PCM no downsampler
    static int16_t pcm[2048];
    static AudioDownsampler ds;
    t.reset();
    t.setFramebuffer(fb);
    ds.configure(1193182, 44100, pcm, 2048);
    t.setAudio(&ds);
    t.write(0x15, 0x0C);  // AUDC0
    t.write(0x17, 0x01);  // AUDF0
    t.write(0x19, 0x0F);  // AUDV0
    tiaLine(t, 76);
    CHECK(ds.count() > 0, "TIA audio gera PCM");
}

// ---------------------------------------------------------------- carts
static std::vector<uint8_t> mkRom(uint32_t size, int seed)
{
    std::vector<uint8_t> r(size);
    for (uint32_t i = 0; i < size; i++) r[i] = (uint8_t)((i * 7u + (uint32_t)seed) & 0xFF);
    return r;
}

static void testCarts()
{
    {
        std::vector<uint8_t> rom = mkRom(2048, 1);
        CartA2600 c;
        CHECK(c.load(rom.data(), (uint32_t)rom.size()), "cart 2K load");
        CHECK(c.read(0x000) == rom[0], "2K base");
        CHECK(c.read(0x800) == rom[0], "2K espelha");
    }
    {
        std::vector<uint8_t> rom = mkRom(4096, 2);
        CartA2600 c;
        CHECK(c.load(rom.data(), (uint32_t)rom.size()), "cart 4K load");
        CHECK(c.read(0xFFF) == rom[0xFFF], "4K topo");
    }
    {
        std::vector<uint8_t> rom = mkRom(8192, 3);
        CartA2600 c;
        CHECK(c.load(rom.data(), (uint32_t)rom.size()), "cart F8 load");
        CHECK(c.read(0x000) == rom[0x000], "F8 banco 0");
        c.read(0xFF9);
        CHECK(c.bank() == 1, "F8 hotspot");
        CHECK(c.read(0x000) == rom[0x1000], "F8 banco 1");
    }
    {
        std::vector<uint8_t> rom = mkRom(16384, 4);
        CartA2600 c;
        CHECK(c.load(rom.data(), (uint32_t)rom.size()), "cart F6 load");
        c.read(0xFF8);
        CHECK(c.bank() == 2, "F6 hotspot");
        CHECK(c.read(0x000) == rom[0x2000], "F6 banco 2");
    }
    {
        std::vector<uint8_t> rom = mkRom(32768, 5);
        CartA2600 c;
        CHECK(c.load(rom.data(), (uint32_t)rom.size()), "cart F4 load");
        c.read(0xFFA);
        CHECK(c.bank() == 6, "F4 hotspot");
        CHECK(c.read(0x000) == rom[0x6000], "F4 banco 6");
    }
    {
        std::vector<uint8_t> rom = mkRom(8192, 6);
        CartA2600 c;
        CHECK(c.load(rom.data(), (uint32_t)rom.size(), CartA2600::k3F), "cart 3F load");
        c.write(0x03F, 2);
        CHECK(c.bank() == 2, "3F banco");
        CHECK(c.read(0x800) == rom[2 * 0x800], "3F banco 2 em F800");
    }
    {
        std::vector<uint8_t> rom = mkRom(8192, 7);
        CartA2600 c;
        CHECK(c.load(rom.data(), (uint32_t)rom.size(), CartA2600::kE0), "cart E0 load");
        c.read(0xFE2);
        CHECK(c.bank() == 2, "E0 banco");
        CHECK(c.read(0x000) == rom[2 * 0x400], "E0 1K switch");
        CHECK(c.read(0x400) == rom[0x1400], "E0 3K fixo");
    }
    {
        std::vector<uint8_t> rom = mkRom(8192, 8);
        CartA2600 c;
        CHECK(c.load(rom.data(), (uint32_t)rom.size(), CartA2600::kUA), "cart UA load");
        c.selectBank(1);
        CHECK(c.read(0x000) == rom[0x1000], "UA banco 1");
    }
    {
        std::vector<uint8_t> rom = mkRom(8192, 9);
        CartA2600 c;
        CHECK(c.load(rom.data(), (uint32_t)rom.size(), CartA2600::kF8SC), "cart F8SC load");
        c.write(0x10, 0xAB);
        CHECK(c.read(0x10) == 0xAB, "SC RAM sobre a ROM");
    }
    {
        CartA2600 c;
        std::vector<uint8_t> rom = mkRom(3000, 10);
        CHECK(!c.load(rom.data(), (uint32_t)rom.size()), "tamanho invalido recusado");
    }
}

// ---------------------------------------------------------------- RIOT
static void testRiot()
{
    Riot6532 r;
    r.reset();
    r.setInputs(0x01, 0x01);  // up pressionado, select pressionado
    CHECK((r.read(0x00) & 0x01) == 0, "SWCHA up ativo baixo");
    CHECK((r.read(0x00) & 0x02) != 0, "SWCHA down solto");
    CHECK((r.read(0x02) & 0x02) == 0, "SWCHB select ativo baixo");

    r.write(0x05, 0x00);  // TIMINT: prescaler 1
    r.write(0x04, 5);     // INTIM = 5
    for (int i = 0; i < 3; i++) r.tick();
    CHECK(r.read(0x04) == 2, "RIOT timer decrementa");
    for (int i = 0; i < 5; i++) r.tick();
    CHECK((r.read(0x05) & 0x80) != 0, "RIOT timer flag no wrap");
    r.read(0x04);  // leitura limpa
    CHECK((r.read(0x05) & 0x80) == 0, "RIOT flag limpo na leitura");
}

// ---------------------------------------------------------------- quadro
// ROM ORIGINAL de teste (test/fixtures/a2600/joystick.a26): VSYNC + 37 linhas
// VBLANK + 192 visiveis; playfield branco, sprite laranja posicionado pelo
// joystick (SWCHA) via atraso antes do RESP0 e FOGO trocando a cor.
static std::vector<uint8_t> loadFixture(const char* path)
{
    FILE* f = fopen(path, "rb");
    if (f == nullptr) return {};
    fseek(f, 0, SEEK_END);
    const long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n <= 0) { fclose(f); return {}; }
    std::vector<uint8_t> v((size_t)n);
    const size_t got = fread(v.data(), 1, v.size(), f);
    fclose(f);
    if (got != v.size()) v.clear();
    return v;
}

static uint32_t frameCrc(const uint16_t* fb)
{
    return emu_crc32(fb, 160u * 192u * 2u);
}

static int firstColorX(const uint16_t* fb, int y, uint16_t color)
{
    for (int x = 0; x < 160; x++)
        if (fb[y * 160 + x] == color) return x;
    return -1;
}

static void testFrame()
{
    static uint16_t fb[160 * 192];
    static int16_t pcm[8192];
    std::vector<uint8_t> rom = loadFixture("test/fixtures/a2600/joystick.a26");
    CHECK(!rom.empty(), "fixture joystick.a26");
    if (rom.empty()) return;

    static A2600 a;
    CHECK(a.load(rom.data(), (uint32_t)rom.size()), "A2600 load");
    a.setFramebuffer(fb);
    a.setPcm(pcm, sizeof(pcm));

    // roda 3 quadros para o kernel estabilizar (o 1o fecha no VSYNC de init)
    for (int i = 0; i < 3; i++) a.frame(0, 0, nullptr);
    CHECK(a.pcmLen() > 0, "A2600 PCM no quadro");

    Tia pal;
    pal.reset();
    const uint16_t white = pal.color565(0x0E);
    const uint16_t orange = pal.color565(0x46);
    const uint16_t gold = pal.color565(0x1E);
    CHECK(fb[100 * 160 + 0] == white, "playfield branco em x=0");
    CHECK(fb[100 * 160 + 20] == 0, "fundo preto em x=20");
    const int x0 = firstColorX(fb, 100, orange);
    CHECK(x0 > 0, "sprite laranja visivel");

    for (int i = 0; i < 3; i++) a.frame(0x80, 0, nullptr);  // direita
    const int x1 = firstColorX(fb, 100, orange);
    CHECK(x1 > x0, "joystick direita move o sprite");

    for (int i = 0; i < 6; i++) a.frame(0x40, 0, nullptr);  // esquerda
    const int x2 = firstColorX(fb, 100, orange);
    CHECK(x2 < x1, "joystick esquerda move o sprite");

    a.frame(0x01, 0, nullptr);  // fogo
    const int x3 = firstColorX(fb, 100, gold);
    CHECK(x3 >= 0, "fogo troca a cor do sprite");
    CHECK(firstColorX(fb, 100, orange) < 0, "sem laranja com fogo");

    // save -> roda -> load -> roda com a MESMA entrada: mesmo CRC de quadro
    static uint8_t state[40960];
    StateWriter w(state, sizeof(state), kConsoleA2600, a.romCrc());
    a.save(w);
    const uint32_t n = w.finish();
    CHECK(n > 0 && n < sizeof(state), "save state cabe");
    a.frame(0x01, 0, nullptr);
    const uint32_t crcRef = frameCrc(fb);

    StateReader r(state, n, kConsoleA2600, a.romCrc());
    CHECK(r.ok(), "state reader valido");
    CHECK(a.loadState(r), "load state");
    a.frame(0x01, 0, nullptr);
    CHECK(frameCrc(fb) == crcRef, "load state reproduz o quadro");

    // state de outro console/ROM e recusado
    StateReader bad(state, n, kConsoleA5200, a.romCrc());
    CHECK(!bad.ok(), "state de outro console recusado");
    StateReader badRom(state, n, kConsoleA2600, a.romCrc() ^ 1u);
    CHECK(!badRom.ok(), "state de outra ROM recusado");
}

int main()
{
    testCpu();
    testTia();
    testCarts();
    testRiot();
    testFrame();
    printf("%d checks, %d falhas\n", g_checks, g_fails);
    return g_fails ? 1 : 0;
}
