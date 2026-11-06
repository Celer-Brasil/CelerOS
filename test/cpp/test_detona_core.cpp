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

struct WireState {
    int32_t px, py;
    uint16_t gx, gy, lives, score;
    uint16_t range, maxBombs, speed, flags;
    uint16_t timeLeft_ds, invuln_ms, animT_ms, face;
    uint8_t nb, nf, ne, nd;
    uint16_t pad;
};
struct WireBomb { uint8_t c, r, range, owner, remote, pad0; uint16_t t; uint16_t pad1; };
struct WireFlame { uint8_t c, r, pad0, pad1; uint16_t t; };
struct WireEnemy { uint8_t c, r, type, hp, maxHp, active; uint16_t aiT; };
struct WireDrop { uint8_t c, r, kind, pad; };

// grid de teste: borda solida, uma caixa em (2,1) e a saida em (3,1) atras
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
    // o core espera o payload NIBBLE-ENCODADO (2 chars por byte), como o
    // nativeWrite do Duktape entrega (CESU-8)
    uint8_t* level = scratch + core_ctl(scratch, CORE_LEVEL_OFF, 0);
    for (uint32_t i = 0; i < n; i++) {
        level[i * 2] = (uint8_t)(raw[i] >> 4);
        level[i * 2 + 1] = (uint8_t)(raw[i] & 0x0F);
    }
    check(core_ctl(scratch, CORE_LOAD_LEVEL, (int32_t)(n * 2)) > 0, "LOAD_LEVEL");

    uint8_t* out = scratch + core_ctl(scratch, CORE_OUT_OFF, 0);
    CelerCoreHead* head = (CelerCoreHead*)out;
    WireState* st = (WireState*)(out + 8);
    const uint32_t stateBytes = head->stateBytes;

    const uint32_t arrays = 16 * sizeof(WireBomb) + 64 * sizeof(WireFlame)
                          + 24 * sizeof(WireEnemy) + 16 * sizeof(WireDrop);
    check(stateBytes == sizeof(WireState) + arrays,
          "stateBytes cobre estado + arrays (espelho = core)");
    check(st->gx == 1 && st->gy == 1, "jogador no spawn");
    check(st->lives == 3 && st->range == 1 && st->maxBombs == 1, "stats iniciais");
    check(head->dirtyCount == COLS * ROWS, "primeiro quadro suja o tabuleiro inteiro");

    // passo para a direita: (2,1) e caixa -> bloqueado (nao muda de celula)
    core_ctl(scratch, CORE_STEP, ((uint16_t)16 << 8) | 8 /*right*/);
    check(st->gx == 1 && st->gy == 1, "caixa bloqueia o passo");

    // bomba em (1,1) e 1,6 s de quadro (dt 1600)
    core_ctl(scratch, CORE_STEP, ((uint16_t)16 << 8) | 16 /*BOMB*/);
    check(st->nb == 1, "bomba plantada");
    // 100 quadros de 16 ms = 1,6 s (o dt real; 1600 de uma vez expirava o
    // fogo no mesmo quadro)
    for (int i = 0; i < 100; i++) core_ctl(scratch, CORE_STEP, ((uint16_t)16 << 8) | 0);
    check(st->nf > 0, "bomba explodiu (chamas no bloco)");

    // a caixa em (2,1) foi destruida e o fogo cobriu (2,1); o jogador tomou dano
    // (esta em (1,1), vizinho da explosao)
    check(st->lives == 2, "explosao feriu o jogador");

    // caixa destruida: agora (2,1) esta livre -> o jogador pode andar
    const uint16_t beforeC = st->gx;
    core_ctl(scratch, CORE_STEP, ((uint16_t)16 << 8) | 8 /*right*/);
    check(st->gx == beforeC + 1, "caixa destruida liberou o passo");

    // passo com tween: px anda na direcao da nova celula
    check(st->px > (int32_t)beforeC * CELL * 256, "tween do passo comeca");

    // 4 quadros de 16 ms fecham o passo (120 ms)
    for (int i = 0; i < 8; i++) core_ctl(scratch, CORE_STEP, ((uint16_t)16 << 8) | 0);
    check(st->px == (int32_t)st->gx * CELL * 256 + CELL * 128, "tween terminou na celula");

    std::printf(fails ? "\nFALHAS: %d\n" : "\nOK: regras do core do Detona\n", fails);
    return fails ? 1 : 0;
}
