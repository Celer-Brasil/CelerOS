// Teste HOST do core do Detona (studio_games/Detona/native/detona_core.cpp).
//
// O core e C++ puro e roda no PC: a regra do jogo pode ser validada sem
// aparelho (o "industrial" de ter as regras no binario e poder testa-las).
// Compila junto com o core; sem dependencia de Duktape/FreeRTOS.
//
//   g++ -std=c++17 -Wall -Wextra -I tools/native -o /tmp/detona_core_test
//       test/cpp/test_detona_core.cpp studio_games/Detona/native/detona_core.cpp

#include <cstdio>
#include <cstring>
#include <cstdint>

#include "celeros_core.h"

extern "C" uint32_t core_ctl(void* scratch, int32_t cmd, int32_t arg);

namespace {

constexpr int COLS = 15, ROWS = 13, CELL = 32;

// Espelho do wire (tem que bater com WireState/arrays do core e com o
// espelho JS em Assets/Scripts/detona_core.js) — travado em compilacao.
struct WireState {
    int32_t px, py;
    uint16_t gx, gy, lives, score;
    uint16_t range, maxBombs, speed, flags;
    uint16_t timeLeft_ds, invuln_ms, animT_ms, face;
    uint8_t nb, nf, ne, nd;
    uint16_t pad;
};
struct WireBomb { uint8_t c, r, range, owner, remote, pad0; uint16_t t; uint16_t pad1; };
struct WireFlame { uint8_t c, r, owner, pad1; uint16_t t; };
struct WireEnemy { uint8_t c, r, type, hp, maxHp, active; uint16_t aiT; };
struct WireDrop { uint8_t c, r, kind, pad; };
static_assert(sizeof(WireState) == 40, "espelho do estado = 40 B (wire do core)");
static_assert(sizeof(WireBomb) == 10, "espelho da bomba = 10 B");
static_assert(sizeof(WireFlame) == 6, "espelho da chama = 6 B (c,r,owner,pad,t)");
static_assert(sizeof(WireEnemy) == 8, "espelho do inimigo = 8 B");
static_assert(sizeof(WireDrop) == 4, "espelho do drop = 4 B");

// grid de teste A: borda solida, uma caixa em (2,1) e a saida em (3,1) atras
// de outra caixa; jogador em (1,1); um slime em (7,7)
uint32_t buildLevel(uint8_t* dst) {
    int off = 0;
    for (int r = 0; r < ROWS; r++)
        for (int c = 0; c < COLS; c++) {
            uint8_t v = 0;
            if (r == 0 || c == 0 || r == ROWS - 1 || c == COLS - 1) v = 1;
            if (c == 2 && r == 1) v = 2;                 // caixa
            if (c == 3 && r == 1) v = 2;                 // caixa (saida atras)
            dst[off++] = v;
        }
    dst[off++] = 3;   // exitC
    dst[off++] = 1;   // exitR
    dst[off++] = 0;   // mode campaign
    const uint16_t time0 = 1200;  // 120,0 s em ds
    dst[off++] = (uint8_t)(time0 & 0xFF);
    dst[off++] = (uint8_t)(time0 >> 8);
    dst[off++] = 1;   // 1 inimigo
    dst[off++] = 0;   // slime
    dst[off++] = 7;
    dst[off++] = 7;
    dst[off++] = 1;   // hp
    dst[off++] = 1;   // player c
    dst[off++] = 1;   // player r
    return (uint32_t)off;
}

// Cenario generico: borda solida sem caixas; um slime (hp dado) e o jogador
// nas celulas pedidas; relogio em ds (0 = sem relogio, para determinismo).
uint32_t buildLevelAt(uint8_t* dst, int pc, int pr, int ec, int er, int hp,
                      uint16_t time0ds) {
    int off = 0;
    for (int r = 0; r < ROWS; r++)
        for (int c = 0; c < COLS; c++) {
            uint8_t v = 0;
            if (r == 0 || c == 0 || r == ROWS - 1 || c == COLS - 1) v = 1;
            dst[off++] = v;
        }
    dst[off++] = 3;   // exitC
    dst[off++] = 1;   // exitR
    dst[off++] = 0;   // mode campaign
    dst[off++] = (uint8_t)(time0ds & 0xFF);
    dst[off++] = (uint8_t)(time0ds >> 8);
    dst[off++] = 1;   // 1 inimigo
    dst[off++] = 0;   // slime
    dst[off++] = (uint8_t)ec;
    dst[off++] = (uint8_t)er;
    dst[off++] = (uint8_t)hp;
    dst[off++] = (uint8_t)pc;
    dst[off++] = (uint8_t)pr;
    return (uint32_t)off;
}

// o core espera o payload NIBBLE-ENCODADO (2 chars por byte), como o
// nativeWrite do Duktape entrega (CESU-8)
bool loadLevel(uint8_t* scratch, const uint8_t* raw, uint32_t n) {
    uint8_t* level = scratch + core_ctl(scratch, CORE_LEVEL_OFF, 0);
    for (uint32_t i = 0; i < n; i++) {
        level[i * 2] = (uint8_t)(raw[i] >> 4);
        level[i * 2 + 1] = (uint8_t)(raw[i] & 0x0F);
    }
    return core_ctl(scratch, CORE_LOAD_LEVEL, (int32_t)(n * 2)) > 0;
}

// um quadro: cmds do byte baixo, dt em ms no byte alto
void step(uint8_t* scratch, uint16_t cmds, uint16_t dt = 16) {
    core_ctl(scratch, CORE_STEP, (int32_t)(((uint32_t)dt << 8) | (cmds & 0xFF)));
}

int fails = 0;
void check(bool ok, const char* what) {
    if (!ok) { std::printf("FALHOU: %s\n", what); fails++; }
    else std::printf("ok: %s\n", what);
}

}  // namespace

int main() {
    static uint8_t scratch[4096];
    std::memset(scratch, 0, sizeof(scratch));

    check(core_ctl(scratch, CORE_INIT, 0) == 1, "INIT");

    uint8_t raw[512];
    const uint32_t n = buildLevel(raw);
    check(loadLevel(scratch, raw, n), "LOAD_LEVEL");

    uint8_t* out = scratch + core_ctl(scratch, CORE_OUT_OFF, 0);
    CelerCoreHead* head = (CelerCoreHead*)out;
    WireState* st = (WireState*)(out + 8);
    WireEnemy* we = (WireEnemy*)(out + 8 + sizeof(WireState)
                                 + 16 * sizeof(WireBomb) + 64 * sizeof(WireFlame));
    const uint32_t stateBytes = head->stateBytes;

    const uint32_t arrays = 16 * sizeof(WireBomb) + 64 * sizeof(WireFlame)
                          + 24 * sizeof(WireEnemy) + 16 * sizeof(WireDrop);
    check(stateBytes == sizeof(WireState) + arrays,
          "stateBytes cobre estado + arrays (espelho = core)");
    check(head->version == 1, "head na versao do contrato");
    check(st->gx == 1 && st->gy == 1, "jogador no spawn");
    check(st->lives == 3 && st->range == 1 && st->maxBombs == 1, "stats iniciais");
    check(head->dirtyCount == COLS * ROWS, "primeiro quadro suja o tabuleiro inteiro");

    // relogio com tick de 16 ms: 62 quadros = 992 ms -> 9 ds. O `dt / 100`
    // antigo truncava para 0 e o relogio da fase congelava no 60 fps.
    for (int i = 0; i < 62; i++) step(scratch, 0);
    check(st->timeLeft_ds == 1200 - 9, "relogio desce no tick de 16 ms");

    // passo para a direita: (2,1) e caixa -> bloqueado (nao muda de celula)
    step(scratch, 8 /*right*/);
    check(st->gx == 1 && st->gy == 1, "caixa bloqueia o passo");

    // bomba em (1,1) e 1,6 s de quadro (dt 1600)
    step(scratch, 16 /*BOMB*/);
    check(st->nb == 1, "bomba plantada");
    // 100 quadros de 16 ms = 1,6 s (o dt real; 1600 de uma vez expirava o
    // fogo no mesmo quadro)
    for (int i = 0; i < 100; i++) step(scratch, 0);
    check(st->nf > 0, "bomba explodiu (chamas no bloco)");

    // a caixa em (2,1) foi destruida e o fogo cobriu (2,1); o jogador tomou dano
    // (esta em (1,1), vizinho da explosao)
    check(st->lives == 2, "explosao feriu o jogador");

    // caixa destruida: agora (2,1) esta livre -> o jogador pode andar
    const uint16_t beforeC = st->gx;
    step(scratch, 8 /*right*/);
    check(st->gx == beforeC + 1, "caixa destruida liberou o passo");

    // passo com tween: px anda na direcao da nova celula
    check(st->px > (int32_t)beforeC * CELL * 256, "tween do passo comeca");

    // 4 quadros de 16 ms fecham o passo (120 ms)
    for (int i = 0; i < 8; i++) step(scratch, 0);
    check(st->px == (int32_t)st->gx * CELL * 256 + CELL * 128, "tween terminou na celula");

    // ---- cenario B: chama fere UMA vez por explosao (paridade detona.js) ----
    // jogador (1,1), slime hp 3 em (2,1), sem relogio. Quadro 1: o slime anda
    // para cima do jogador (fere: 2 vidas, invulneravel). Quadro 2: bomba em
    // (1,1). Ao explodir a chama tira 1 hp do slime — e nao 1 por quadro
    // enquanto o fogo dura (o core antigo derretia o inimigo parado no fogo).
    const uint32_t nb = buildLevelAt(raw, 1, 1, 2, 1, 3, 0);
    check(loadLevel(scratch, raw, nb), "LOAD_LEVEL B");
    step(scratch, 0);            // slime sobe para (1,1) e fere o jogador
    check(st->lives == 2, "inimigo em cima fere o jogador");
    step(scratch, 16 /*BOMB*/);
    for (int i = 0; i < 100; i++) step(scratch, 0);
    check(we[0].hp == 2 && we[0].active == 1, "explosao fere o inimigo uma vez");
    check(st->lives == 2, "invulnerabilidade poupa o jogador da propria bomba");
    for (int i = 0; i < 30; i++) step(scratch, 0);
    check(we[0].hp == 2 && we[0].active == 1, "chama nao derrete o inimigo por quadro");
    check(st->nf == 0, "chamas apagam sozinhas");

    // ---- cenario C: RESET restaura o elenco da fase e limpa a partida ----
    step(scratch, 16 /*BOMB*/);
    check(st->nb == 1, "bomba antes do RESET");
    check(core_ctl(scratch, CORE_RESET, 7) == 1, "RESET");
    check(st->nb == 0 && st->nf == 0 && st->lives == 3, "RESET limpa a partida");
    check(we[0].hp == 3 && we[0].active == 1, "RESET restaura os inimigos da fase");
    check(st->score == 0, "RESET zera o placar");

    // ---- cenario D: o dano devolve o jogador ao canto seguro (1,1) ----
    const uint32_t nd = buildLevelAt(raw, 5, 5, 13, 11, 1, 0);
    check(loadLevel(scratch, raw, nd), "LOAD_LEVEL D");
    step(scratch, 2 /*down*/);   // tween para (5,6); o slime anda longe
    step(scratch, 16 /*BOMB no (5,6)*/);
    for (int i = 0; i < 100; i++) step(scratch, 0);
    check(st->lives == 2, "explosao D feriu o jogador");
    check(st->gx == 1 && st->gy == 1, "dano devolve ao canto seguro (1,1)");
    check(st->px == (int32_t)1 * CELL * 256 + CELL * 128,
          "jogador de volta no centro de (1,1)");

    std::printf(fails ? "\nFALHAS: %d\n" : "\nOK: regras do core do Detona\n", fails);
    return fails ? 1 : 0;
}
