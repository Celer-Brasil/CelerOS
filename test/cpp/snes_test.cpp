// Teste host do nucleo do SNES (gate g++ do CI).
//
// O core e o LakeSnes (MIT) com o renderizador de linha, o escalonador por
// eventos, o barramento por paginas e o relogio inteiro da APU do CelerOS.
// A equivalencia pixel a pixel com o LakeSnes original foi conferida na
// bancada contra ROMs reais (golden por quadro); aqui vai o que roda sem ROM
// de terceiros: uma ROM SINTETICA original montada abaixo (65816 a mao) que
//   - espera o IPL da APU responder ($2140/$2141 = AA/BB: SPC700 + timers),
//   - soma 1..100 em 16 bits (CPU em modo nativo),
//   - monta modo 1 com um tile 4bpp em duas paletas e liga o BG1,
//   - a cada NMI anda o scroll horizontal e copia o auto-joypad.
// Cobre tambem: espelho da ROM fora de potencia de 2, mapa rapido de leitura
// x caminho original (todas as 2048 paginas), save/load deterministico e
// quadro pulado (frameskip) sem efeito na emulacao.

#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <vector>
#include <map>
#include <string>

#include "emu_compat.h"
#include "SnesCore.cpp"

static int g_fails = 0, g_checks = 0;
#define CHECK(c, m)                                                       \
    do {                                                                  \
        g_checks++;                                                       \
        if (!(c)) {                                                       \
            g_fails++;                                                    \
            printf("FAIL %s (%s:%d)\n", m, __FILE__, __LINE__);           \
        }                                                                 \
    } while (0)

// ---------------------------------------------------------------- montador
// Bytes + rotulos; saltos relativos de 8 bits resolvidos no fim.
struct Asm {
    std::vector<uint8_t> b;
    uint16_t org = 0x8000;
    std::map<std::string, uint16_t> lab;
    std::vector<std::pair<size_t, std::string>> rel;
    void o(std::initializer_list<int> v) { for (int x : v) b.push_back((uint8_t)x); }
    uint16_t pc() const { return (uint16_t)(org + b.size()); }
    void L(const char* n) { lab[n] = pc(); }
    void br(int op, const char* n) { b.push_back((uint8_t)op); rel.push_back({b.size(), n}); b.push_back(0); }
    void sta(uint16_t a) { o({0x8D, a & 0xFF, a >> 8}); }        // sta abs
    void lda8(int v) { o({0xA9, v & 0xFF}); }                    // lda #imm (A 8 bits)
    void w8(uint16_t reg, int v) { lda8(v); sta(reg); }
    void fix()
    {
        for (auto& r : rel) {
            int d = (int)lab.at(r.second) - (int)(org + r.first + 1);
            b[r.first] = (uint8_t)(int8_t)d;
        }
    }
};

static std::vector<uint8_t> buildTestRom()
{
    Asm a;
    // reset (modo emulacao -> nativo)
    a.o({0x78, 0x18, 0xFB});          // sei; clc; xce
    a.o({0xC2, 0x30});                // rep #$30
    a.o({0xA2, 0xFF, 0x1F, 0x9A});    // ldx #$1FFF; txs
    a.o({0xE2, 0x20});                // sep #$20 (A 8 bits, X/Y 16)
    a.w8(0x2100, 0x80);               // forced blank
    a.L("ipl");                       // espera o IPL da APU
    a.o({0xAD, 0x40, 0x21, 0xC9, 0xAA}); a.br(0xD0, "ipl");
    a.o({0xAD, 0x41, 0x21, 0xC9, 0xBB}); a.br(0xD0, "ipl");
    a.lda8(0x5A); a.sta(0x0000);      // marcador: APU respondeu
    a.w8(0x2105, 0x01);               // modo 1
    a.w8(0x2107, 0x04);               // BG1 tilemap @ palavra $0400
    a.w8(0x210B, 0x01);               // BG1 chr @ palavra $1000
    a.w8(0x2115, 0x80);               // VMAIN: incrementa apos o byte alto
    a.o({0xA2, 0x10, 0x10, 0x8E, 0x16, 0x21});  // ldx #$1010; stx $2116 (tile 1)
    a.o({0xA0, 0x08, 0x00});          // ldy #8
    a.L("tile");
    a.w8(0x2118, 0xFF);               // plano 0 = FF (pixel = 1)
    a.o({0x9C, 0x19, 0x21});          // stz $2119 (plano 1 = 0)
    a.o({0x88}); a.br(0xD0, "tile");  // dey; bne
    a.o({0xA2, 0x00, 0x04, 0x8E, 0x16, 0x21});  // tilemap (0,0)
    a.w8(0x2118, 0x01); a.o({0x9C, 0x19, 0x21});  // tile 1, paleta 0
    a.w8(0x2118, 0x00); a.o({0x9C, 0x19, 0x21});  // (1,0) vazio
    a.w8(0x2118, 0x01); a.w8(0x2119, 0x04);       // (2,0) tile 1, paleta 1
    a.o({0x9C, 0x21, 0x21});          // CGRAM 0
    a.o({0x9C, 0x22, 0x21, 0x9C, 0x22, 0x21});    // cor 0 = preto
    a.w8(0x2122, 0x1F); a.o({0x9C, 0x22, 0x21});  // cor 1 = vermelho
    a.w8(0x2121, 17);
    a.w8(0x2122, 0xE0); a.w8(0x2122, 0x03);       // cor 17 = verde
    a.w8(0x212C, 0x01);               // BG1 no main
    a.w8(0x2100, 0x0F);               // brilho cheio
    a.w8(0x4200, 0x81);               // NMI + auto-joypad
    a.o({0xC2, 0x20});                // rep #$20 (A 16)
    a.o({0xA9, 0x00, 0x00, 0xA2, 0x64, 0x00});    // lda #0; ldx #100
    a.L("sum");
    a.o({0x86, 0x12, 0x18, 0x65, 0x12, 0xCA});    // stx $12; clc; adc $12; dex
    a.br(0xD0, "sum");
    a.o({0x85, 0x10});                // sta $10 (5050)
    a.o({0xE2, 0x20});                // sep #$20
    a.L("main");
    a.o({0xCB}); a.br(0x80, "main");  // wai; bra
    a.L("nmi");
    a.o({0xEE, 0x02, 0x00});          // inc $0002 (contador de quadros)
    a.o({0xAD, 0x02, 0x00}); a.sta(0x210D); a.o({0x9C, 0x0D, 0x21});  // BG1 hscroll
    a.o({0xAD, 0x19, 0x42}); a.sta(0x0004);   // auto-joypad (B Y Sel St U D L R)
    a.o({0xAD, 0x18, 0x42}); a.sta(0x0003);   // (A X L R)
    a.o({0xAD, 0x10, 0x42});          // ack do NMI
    a.o({0x40});                      // rti
    a.L("irq");
    a.o({0x40});
    a.fix();

    std::vector<uint8_t> rom(0x8000, 0xFF);
    memcpy(rom.data(), a.b.data(), a.b.size());
    // cabecalho LoROM em $7FC0
    const char* name = "CELEROS SNES TEST    ";
    memcpy(&rom[0x7FC0], name, 21);
    rom[0x7FD5] = 0x20;  // LoROM, SlowROM
    rom[0x7FD6] = 0x00;  // so ROM
    rom[0x7FD7] = 0x05;  // 32 KB
    rom[0x7FD8] = 0x00;
    rom[0x7FD9] = 0x01;  // NTSC
    rom[0x7FDA] = 0x00;
    rom[0x7FDB] = 0x00;
    rom[0x7FDC] = 0x34; rom[0x7FDD] = 0x12;  // complemento + checksum = FFFF
    rom[0x7FDE] = 0xCB; rom[0x7FDF] = 0xED;
    auto vec = [&](int at, uint16_t v) { rom[at] = (uint8_t)v; rom[at + 1] = (uint8_t)(v >> 8); };
    vec(0x7FEA, a.lab["nmi"]);   // NMI nativo
    vec(0x7FEE, a.lab["irq"]);   // IRQ nativo
    vec(0x7FE6, a.lab["irq"]);   // BRK nativo
    vec(0x7FFC, 0x8000);         // RESET (emulacao)
    vec(0x7FFE, a.lab["irq"]);
    return rom;
}

static uint32_t crc(const void* p, size_t n)
{
    return emu_crc32(p, n);
}

static uint16_t g_fb[256 * 239];

static void testRom()
{
    std::vector<uint8_t> rom = buildTestRom();
    static uint8_t snapq[64 * 1024];
    CHECK((size_t)ppu_snapQueueBytes() <= sizeof(snapq), "fila de linhas cabe");
    Snes* s = snes_init();
    ppu_setSnapBuffer(s->ppu, snapq);  // renderizacao adiada (caminho do blob)
    CHECK(snes_loadRom(s, rom.data(), (int)rom.size()), "ROM sintetica carrega (LoROM)");
    CHECK(s->cart->type == 1 && s->cart->romSize == 0x8000, "tipo/tamanho do cart");
    snes_setFrameBuffer(s, g_fb);
    for (int i = 0; i < 4; i++) snes_runFrame(s);
    CHECK(s->ram[0] == 0x5A, "IPL da APU respondeu AA/BB (SPC700 rodando)");
    CHECK((s->ram[0x10] | (s->ram[0x11] << 8)) == 5050, "soma 1..100 em 16 bits = 5050");
    CHECK(s->ram[2] >= 2, "NMI conta quadros");

    // tile vermelho (paleta 0) e verde (paleta 1) na linha 0, andando com o
    // scroll que o NMI do quadro anterior escreveu
    int hs = s->ram[2] - 1;
    const uint16_t RED = 0x00F8, GREEN = 0xE007;  // RGB565 com bytes trocados
    int reds = 0, greens = 0, firstRed = -1;
    for (int x = 0; x < 256; x++) {
        uint16_t p = g_fb[x];
        if (p == RED) { reds++; if (firstRed < 0) firstRed = x; }
        if (p == GREEN) greens++;
    }
    CHECK(reds == 8 && greens == 8, "8 px vermelhos + 8 verdes na linha 0");
    int expect = (256 - (hs & 0xFF)) & 0xFF;
    if (expect > 248) expect = 0;  // tile cortado pela borda esquerda
    CHECK(firstRed == expect || hs == 0, "tile anda com o scroll horizontal");
    CHECK(g_fb[255 * 0 + 128] == 0x0000, "fundo = cor 0 (preto)");

    // auto-joypad: B (bit 0 do estado) aparece no bit 7 de $4219
    s->input1->currentState = 1;
    snes_runFrame(s);
    snes_runFrame(s);
    CHECK((s->ram[4] & 0x80) != 0, "auto-joypad le B em $4219.7");
    s->input1->currentState = 0x100;  // A -> $4218.7
    snes_runFrame(s);
    snes_runFrame(s);
    CHECK((s->ram[3] & 0x80) != 0 && (s->ram[4] & 0x80) == 0, "auto-joypad le A em $4218.7");
    s->input1->currentState = 0;

    // mapa rapido x caminho original em todas as paginas mapeadas
    int mapped = 0, bad = 0, badT = 0;
    for (int p = 0; p < 2048; p++) {
        uint32_t adr = ((uint32_t)p << 13) | 0x0123;
        if (s_rdMap[p] != nullptr) {
            mapped++;
            if (s_rdMap[p][0x0123] != snes_rread(s, adr)) bad++;
        }
        if (s_accTime[p] != 0 && s_accTime[p] != snes_getAccessTime(s, adr)) badT++;
    }
    CHECK(mapped > 1000 && bad == 0, "pagina rapida le o mesmo byte do caminho original");
    CHECK(badT == 0, "tempo de acesso tabelado = snes_getAccessTime");

    // save/load deterministico
    std::vector<uint8_t> st(512 * 1024);
    int n = snes_saveStateTo(s, st.data(), (int)st.size());
    CHECK(n > 256 * 1024, "save state serializa WRAM/VRAM/ARAM");
    CHECK(snes_saveStateTo(s, st.data(), 1000) == 0, "buffer pequeno = 0 (sem estourar)");
    n = snes_saveStateTo(s, st.data(), (int)st.size());
    uint32_t a[20];
    for (int i = 0; i < 20; i++) { snes_runFrame(s); a[i] = crc(g_fb, 256 * 224 * 2) ^ crc(s->ram, 0x20000); }
    CHECK(snes_loadState(s, st.data(), n), "load state aceita o proprio save");
    bool same = true;
    for (int i = 0; i < 20; i++) {
        snes_runFrame(s);
        if ((crc(g_fb, 256 * 224 * 2) ^ crc(s->ram, 0x20000)) != a[i]) same = false;
    }
    CHECK(same, "20 quadros apos o load = mesmos quadros apos o save");
    st[20] ^= 0xFF;
    CHECK(!snes_loadState(s, st.data(), n - 7), "state truncado e recusado");

    snes_free(s);

    // quadro pulado: a emulacao segue identica (UMA instancia por vez: o
    // mapa de paginas e estatico, como no blob)
    static uint16_t fb2[256 * 239];
    static uint8_t ramA[0x20000];
    uint64_t cycA;
    {
        Snes* t = snes_init();
        snes_loadRom(t, rom.data(), (int)rom.size());
        snes_setFrameBuffer(t, fb2);
        for (int i = 0; i < 60; i++) snes_runFrame(t);
        memcpy(ramA, t->ram, sizeof(ramA));
        cycA = t->cycles;
        snes_free(t);
    }
    {
        Snes* u = snes_init();
        snes_loadRom(u, rom.data(), (int)rom.size());
        snes_setFrameBuffer(u, nullptr);
        for (int i = 0; i < 60; i++) {
            u->ppu->renderOn = (i % 2) == 0;
            snes_runFrame(u);
        }
        CHECK(memcmp(ramA, u->ram, sizeof(ramA)) == 0 && cycA == u->cycles,
              "frameskip nao muda a emulacao (WRAM e ciclos iguais)");
        snes_free(u);
    }
}

static void testMirror()
{
    // ROM de 96 KB (3 bancos LoROM de 32 KB): expande para 128 KB espelhando
    // o banco 2 no 3 — como o LakeSnes fazia copiando, aqui por tabela
    std::vector<uint8_t> rom = buildTestRom();
    std::vector<uint8_t> big(3 * 0x8000);
    memcpy(&big[0], rom.data(), 0x8000);  // so o banco 0 tem cabecalho
    for (int bk = 0; bk < 3; bk++) big[bk * 0x8000 + 0x10] = (uint8_t)(0xB0 + bk);
    Snes* s = snes_init();
    CHECK(snes_loadRom(s, big.data(), (int)big.size()), "ROM de 96 KB carrega");
    CHECK(s->cart->romSize == 0x20000, "romSize = proxima potencia de 2 (128 KB)");
    CHECK(snes_read(s, 0x008010) == 0xB0 && snes_read(s, 0x018010) == 0xB1 &&
          snes_read(s, 0x028010) == 0xB2, "bancos 0-2 diretos");
    CHECK(snes_read(s, 0x038010) == 0xB2, "banco 3 espelha o 2 (expansao do LakeSnes)");
    CHECK(snes_read(s, 0x048010) == 0xB0, "banco 4 volta ao 0 (mascara)");
    CHECK(s_rdMap[(0x03 << 3) | 4] != nullptr && s_rdMap[(0x03 << 3) | 4][0x10] == 0xB2,
          "pagina rapida do banco 3 aponta para o espelho");
    snes_free(s);
}

int main()
{
    testRom();
    testMirror();
    printf("snes_test: %d checks, %d falhas\n", g_checks, g_fails);
    return g_fails == 0 ? 0 : 1;
}
