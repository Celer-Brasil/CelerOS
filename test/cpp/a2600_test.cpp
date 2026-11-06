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
#include "emu_screen.h"
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

    // player: RESP no ciclo que comeca no clock 66 vale no FIM do ciclo
    // (69) + 5 de atraso do contador -> 8 px em 74..81. O GRP vem DEPOIS do
    // RESP: escrito antes, o player apareceria na posicao inicial durante os
    // clocks anteriores (fiel ao hardware, mas nao e o teste).
    const uint16_t gold = t.color565(0x1E);
    t.reset();
    t.setFramebuffer(fb);
    t.write(0x01, 0x00);
    t.write(0x06, 0x1E);  // COLUP0 ouro
    tiaLine(t, 22);       // clock 66
    t.write(0x10, 0x00);  // RESP0
    t.write(0x1B, 0xFF);  // GRP0
    tiaLine(t, 54);       // fecha a linha
    CHECK(t.lineBuffer()[74] == gold, "player em x=74 (RESP + 5)");
    CHECK(t.lineBuffer()[81] == gold, "player ate x=81");
    CHECK(t.lineBuffer()[0] == 0, "player nao vaza para x=0");
    CHECK(t.lineBuffer()[73] == 0, "player comeca em x=74");
    CHECK(t.lineBuffer()[82] == 0, "player termina em x=82");

    // HMOVE: HMP0 positivo move para a ESQUERDA (0x10 = 1 px), negativo
    // para a direita (0xF0 = 1 px). O sinal invertido fazia o sprite andar
    // de costas no ajuste fino e saltar no reposicionamento grosso.
    t.reset();
    t.setFramebuffer(fb);
    t.write(0x01, 0x00);
    t.write(0x06, 0x1E);
    tiaLine(t, 22);
    t.write(0x20, 0x10);  // HMP0 = 1 px para a esquerda
    t.write(0x10, 0x00);  // RESP0 -> 74
    t.write(0x2A, 0x00);  // HMOVE -> 73
    t.write(0x1B, 0xFF);  // GRP0
    tiaLine(t, 54);
    CHECK(t.lineBuffer()[72] == 0, "HMOVE +1: nada em x=72");
    CHECK(t.lineBuffer()[73] == gold, "HMOVE +1 move para a esquerda (x=73)");
    CHECK(t.lineBuffer()[80] == gold, "HMOVE +1 ate x=80");
    CHECK(t.lineBuffer()[81] == 0, "HMOVE +1 termina em x=81");

    t.reset();
    t.setFramebuffer(fb);
    t.write(0x01, 0x00);
    t.write(0x06, 0x1E);
    tiaLine(t, 22);
    t.write(0x20, 0xF0);  // HMP0 = 1 px para a direita
    t.write(0x10, 0x00);
    t.write(0x2A, 0x00);
    t.write(0x1B, 0xFF);
    tiaLine(t, 54);
    CHECK(t.lineBuffer()[74] == 0, "HMOVE -1: saiu de x=74");
    CHECK(t.lineBuffer()[75] == gold, "HMOVE -1 move para a direita (x=75)");

    // HMOVE no blank: a proxima linha sai com os 8 primeiros pixels pretos
    t.reset();
    t.setFramebuffer(fb);
    t.write(0x01, 0x00);
    t.write(0x09, 0x1E);  // COLUBK ouro
    tiaLine(t, 54);       // clock 162: blank
    t.write(0x2A, 0x00);  // HMOVE
    tiaLine(t, 22 + 76);  // fecha esta linha e desenha a proxima
    CHECK(t.lineBuffer()[7] == 0, "pente do HMOVE: x=7 preto");
    CHECK(t.lineBuffer()[8] == gold, "pente do HMOVE: x=8 com fundo");

    // VDELP0: o GRP0 que aparece e o latch VELHO, copiado do novo quando o
    // jogo escreve GRP1 (kernels de 6 digitos)
    t.reset();
    t.setFramebuffer(fb);
    t.write(0x01, 0x00);
    t.write(0x06, 0x1E);
    t.write(0x25, 0x01);  // VDELP0
    tiaLine(t, 22);
    t.write(0x10, 0x00);  // RESP0 -> 74
    t.write(0x1B, 0xFF);  // GRP0 novo = FF (velho ainda 0)
    tiaLine(t, 54);
    CHECK(t.lineBuffer()[74] == 0, "VDELP0: GRP0 novo nao aparece sozinho");
    t.write(0x1C, 0x00);  // GRP1 copia GRP0 novo -> velho
    tiaLine(t, 76);
    CHECK(t.lineBuffer()[74] == gold, "VDELP0: aparece depois do GRP1");

    // playfield: PF0 bits 4-5 -> x=0..7; PF2 bits 5-7 -> x=68..79 (o
    // playfield comeca na borda esquerda do vidro). Escrita vale no FIM do
    // ciclo: registradores escritos no clock 0 pegam a partir de x=3, por
    // isso as checagens abaixo olham x=4.
    t.reset();
    t.setFramebuffer(fb);
    t.write(0x01, 0x00);
    t.write(0x08, 0x1E);  // COLUPF
    t.write(0x0D, 0x30);  // PF0
    t.write(0x0F, 0xE0);  // PF2
    tiaLine(t, 76);
    CHECK(t.lineBuffer()[4] == gold, "playfield PF0 em x=4");
    CHECK(t.lineBuffer()[20] == 0, "playfield x=20 off");
    CHECK(t.lineBuffer()[70] == gold, "playfield PF2 alinhado ao vidro (x=70)");

    // VBLANK no MEIO da janela de 192 linhas: a linha vira PRETA e consome a
    // posicao — antes ela era pulada e o framebuffer guardava o pixel do
    // quadro anterior (o logo do titulo ficava por cima do jogo).
    t.reset();
    t.setFramebuffer(fb);
    memset(fb, 0xAA, sizeof(fb));  // "pixel velho" de proposito
    t.write(0x08, 0x1E);  // COLUPF ouro
    t.write(0x0D, 0x30);  // PF0
    t.write(0x01, 0x00);  // VBLANK off: a janela abre na 1a linha
    tiaLine(t, 76);       // y=0 visivel
    tiaLine(t, 76);       // y=1 visivel
    t.write(0x01, 0x02);  // VBLANK on
    tiaLine(t, 76);       // y=2 blankada -> preta
    t.write(0x01, 0x00);  // VBLANK off de novo
    tiaLine(t, 76);       // y=3 visivel, na mesma posicao
    CHECK(fb[0 * 160 + 4] == gold, "janela: linha 0 visivel");
    CHECK(fb[2 * 160 + 4] == 0, "linha blankada dentro da janela vira preta");
    CHECK(fb[3 * 160 + 4] == gold, "linha apos o blank nao pula a posicao");

    // quadro CURTO (o jogo desenha menos de 192 linhas): a cauda da janela
    // vira preta no VSYNC em vez de guardar o pixel do quadro anterior
    t.reset();
    t.setFramebuffer(fb);
    memset(fb, 0xAA, sizeof(fb));
    t.write(0x08, 0x1E);  // COLUPF ouro
    t.write(0x0D, 0x30);  // PF0
    t.write(0x01, 0x00);  // VBLANK off
    tiaLine(t, 76);       // y=0 visivel
    t.write(0x01, 0x02);  // VBLANK on (fim da area ativa)
    tiaLine(t, 76);       // y=1 blankada
    t.write(0x00, 0x02);  // VSYNC on
    t.write(0x00, 0x00);  // VSYNC off: fecha o quadro e limpa a cauda
    CHECK(fb[0 * 160 + 4] == gold, "quadro curto: linha 0 visivel");
    CHECK(fb[191 * 160 + 4] == 0, "quadro curto: cauda da janela vira preta");

    // colisoes: P0 e P1 no mesmo lugar; so o CXCLR limpa
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
    CHECK((t.read(0x07) & 0x80) != 0, "colisao espelhada e NAO limpa na leitura");
    t.write(0x2C, 0x00);  // CXCLR
    CHECK((t.read(0x37) & 0x80) == 0, "CXCLR limpa colisao");

    // WSYNC para a CPU ate a borda do horizontal blank (clock 160)
    t.reset();
    t.setFramebuffer(fb);
    tiaLine(t, 10);       // clock 30
    t.write(0x02, 0x00);
    CHECK(t.wsync(), "WSYNC liga");
    tiaLine(t, 44);       // 132 clocks -> 162: passou da borda (160)
    CHECK(!t.wsync(), "WSYNC solta na borda do blank");

    // audio: canal 0 com volume gera PCM no downsampler
    static int16_t pcm[2048];
    static AudioDownsampler ds;
    t.reset();
    t.setFramebuffer(fb);
    ds.configure(Tia::kAudioRate, 44100, pcm, 2048);
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
        CHECK(c.read(0x000) == rom[2 * 0x800], "3F banco 2 em F000");
        CHECK(c.read(0x800) == rom[3 * 0x800], "3F: 2K altos fixos no ultimo banco");
    }
    {
        std::vector<uint8_t> rom = mkRom(8192, 7);
        CartA2600 c;
        CHECK(c.load(rom.data(), (uint32_t)rom.size(), CartA2600::kE0), "cart E0 load");
        c.read(0xFE2);
        CHECK(c.bank() == 2, "E0 banco");
        CHECK(c.read(0x000) == rom[2 * 0x400], "E0 1K switch");
        CHECK(c.read(0x400) == rom[0x1400], "E0 fatia 1 inicial = banco 5");
        c.read(0xFE9);
        CHECK(c.read(0x400) == rom[1 * 0x400], "E0 fatia 1 troca em FE8-FEF");
        c.read(0xFF3);
        CHECK(c.read(0x800) == rom[3 * 0x400], "E0 fatia 2 troca em FF0-FF7");
        CHECK(c.read(0xC00) == rom[7 * 0x400], "E0 fatia 3 fixa no banco 7");
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
        CHECK(c.read(0x90) == 0xAB, "SC RAM: escreve em $000, le em $080");
        c.read(0xFF9);
        CHECK(c.read(0x200) == rom[0x1200], "SC: ROM fora da RAM");
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
    // SWCHA: P0 no nibble ALTO (D4=up, D5=down, D6=left, D7=right, ativo baixo)
    CHECK((r.read(0x00) & 0x10) == 0, "SWCHA up ativo baixo (D4)");
    CHECK((r.read(0x00) & 0x20) != 0, "SWCHA down solto (D5)");
    CHECK((r.read(0x00) & 0x0F) == 0x0F, "SWCHA P1 solto no nibble baixo");
    CHECK((r.read(0x02) & 0x02) == 0, "SWCHB select ativo baixo");

    // SWCHB D3 = cor (1=cor); D6 = dificuldade do P0 (1=A, 0=B)
    r.setInputs(0, 0x04);
    CHECK((r.read(0x02) & 0x08) != 0, "SWCHB cor = D3=1");
    CHECK((r.read(0x02) & 0x40) == 0, "SWCHB dificuldade B = D6=0");
    r.setInputs(0, 0x0C);  // cor + dif A
    CHECK((r.read(0x02) & 0x40) != 0, "SWCHB dificuldade A = D6=1");

    // TIM64T (0x296): o divisor sai do endereco, nao do valor. Antes so o
    // 0x294 carregava o timer e o 0x295 mexia no divisor; TIM64T/T1024T, os
    // que os jogos usam, eram ignorados (quadro com o tempo errado).
    r.write(0x296, 3);
    r.tick();
    CHECK(r.read(0x284) == 2, "TIM64T: 1o decremento no ciclo seguinte");
    for (int i = 0; i < 63; i++) r.tick();
    CHECK(r.read(0x284) == 2, "TIM64T segura 64 ciclos");
    r.tick();
    CHECK(r.read(0x284) == 1, "TIM64T decrementa a cada 64");
    for (int i = 0; i < 128; i++) r.tick();
    CHECK((r.read(0x285) & 0x80) != 0, "TIMINT D7 no estouro");
    CHECK(r.read(0x284) == 0xFF, "estouro vai para 0xFF");
    r.tick();
    CHECK(r.read(0x284) == 0xFE, "depois do estouro conta a cada ciclo");
    CHECK((r.read(0x285) & 0x80) == 0, "INTIM limpa o flag");
    r.write(0x297, 2);  // T1024T
    for (int i = 0; i < 1025; i++) r.tick();
    CHECK(r.read(0x284) == 0, "T1024T");
    r.write(0x294, 2);  // TIM1T
    r.tick();
    r.tick();
    CHECK(r.read(0x284) == 0, "TIM1T");
    r.write(0x295, 9);  // TIM8T
    for (int i = 0; i < 9; i++) r.tick();
    CHECK(r.read(0x284) == 7, "TIM8T");
    // portas: 0x280..0x283 e espelhos; DDR seleciona saida
    r.write(0x281, 0xF0);
    r.write(0x280, 0x00);
    CHECK((r.read(0x280) & 0xF0) == 0x00, "SWCHA bit de saida le o latch");
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

    // saida por LINHA (FRAME_SCREEN) = mesmo quadro do framebuffer
    {
        static uint16_t byLine[160 * 192];
        StateReader r2(state, n, kConsoleA2600, a.romCrc());
        CHECK(a.loadState(r2), "load state (linha)");
        a.setVideoOut(nullptr, [](void* ctx, int y, const uint16_t* line) {
            memcpy((uint16_t*)ctx + y * 160, line, 320);
        }, byLine);
        a.frame(0x01, 0, nullptr);
        a.setVideoOut(fb, nullptr, nullptr);
        CHECK(emu_crc32(byLine, sizeof(byLine)) == crcRef, "sink por linha = framebuffer");
    }

    // state de outro console/ROM e recusado
    StateReader bad(state, n, kConsoleA5200, a.romCrc());
    CHECK(!bad.ok(), "state de outro console recusado");
    StateReader badRom(state, n, kConsoleA2600, a.romCrc() ^ 1u);
    CHECK(!badRom.ok(), "state de outra ROM recusado");
}

// ---------------------------------------------------------------- vidro
// Compositor do FRAME_SCREEN: quadro centrado no alvo, faixas pretas,
// carimbo misturado por cima e linha que nao mudou nao e reescrita.
static void testScreen()
{
    static uint8_t scratch[64 * 1024];
    static uint16_t base[512], mix[512], col[321];
    static uint16_t tgt[40 * 30];
    static int puts[30];
    ScreenComposer sc;
    sc.init(scratch, 0, 8 * 1024, 16 * 1024, 48 * 1024, base, mix, col);
    CHECK(sc.setScale(4, 2, 32, 20), "compositor: escala 4x2 -> 32x20");
    NativeScreen scr;
    memset(&scr, 0, sizeof(scr));
    scr.px = tgt;
    scr.stride = 40;
    scr.w = 40;
    scr.h = 30;
    scr.flags = 1;
    scr.put = [](void* ctx, int32_t y, const uint16_t* src) {
        memcpy(tgt + y * 40, src, 80);
        ((int*)ctx)[y]++;
    };
    scr.putCtx = puts;
    for (int i = 0; i < 40 * 30; i++) tgt[i] = 0x1234;
    const uint16_t src0[4] = {0x1111, 0x2222, 0x3333, 0x4444};
    const uint16_t src1[4] = {0x5555, 0x5555, 0x5555, 0x5555};
    CHECK(sc.begin(&scr), "compositor: begin");
    sc.row(0, src0);
    sc.row(1, src1);
    sc.end();
    // quadro 32x20 centrado em 40x30: x 4..35, y 5..24
    CHECK(tgt[0] == 0 && tgt[29 * 40 + 39] == 0, "compositor: faixas pretas");
    CHECK(tgt[5 * 40 + 3] == 0 && tgt[5 * 40 + 4] == 0x1111, "compositor: borda esquerda do quadro");
    CHECK(tgt[5 * 40 + 11] == 0x1111 && tgt[5 * 40 + 12] == 0x2222, "compositor: escala x8");
    CHECK(tgt[5 * 40 + 35] == 0x4444 && tgt[5 * 40 + 36] == 0, "compositor: borda direita");
    CHECK(tgt[14 * 40 + 4] == 0x1111 && tgt[15 * 40 + 4] == 0x5555, "compositor: escala y10");
    // 2o quadro igual: nenhuma linha reescrita
    memset(puts, 0, sizeof(puts));
    CHECK(sc.begin(&scr), "compositor: begin 2");
    sc.row(0, src0);
    sc.row(1, src1);
    sc.end();
    int total = 0;
    for (int y = 0; y < 30; y++) total += puts[y];
    CHECK(total == 0, "compositor: quadro igual nao reescreve");
    // carimbo opaco 2x2 branco (grab igual sobre preto e branco) em (0,0)
    uint16_t* gb = (uint16_t*)scratch;
    uint16_t* gw = (uint16_t*)(scratch + 8 * 1024);
    for (int i = 0; i < 4; i++) gb[i] = gw[i] = 0xFFFF;
    CHECK(sc.stampMake(0, 2, 2), "compositor: carimbo");
    CHECK(sc.stampPlace(0 | (0 << 4) | (256 << 10) | (256 << 20)), "compositor: place");
    memset(puts, 0, sizeof(puts));
    CHECK(sc.begin(&scr), "compositor: begin 3");
    sc.row(0, src0);
    sc.row(1, src1);
    sc.end();
    CHECK(tgt[0] == 0xFFFF && tgt[41] == 0xFFFF && tgt[2] == 0, "compositor: carimbo na faixa");
    CHECK(puts[0] == 1 && puts[1] == 1 && puts[2] == 0 && puts[5] == 0,
          "compositor: so as linhas do carimbo mudam");
}

int main()
{
    testCpu();
    testTia();
    testCarts();
    testRiot();
    testFrame();
    testScreen();
    printf("%d checks, %d falhas\n", g_checks, g_fails);
    return g_fails ? 1 : 0;
}
