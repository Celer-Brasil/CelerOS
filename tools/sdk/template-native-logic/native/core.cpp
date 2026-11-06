// Core de LOGICA do app (blob CLRN) — template do `celer.js new --native-logic`.
//
// Este arquivo e o "miolo industrial": as regras e o estado do jogo vivem
// AQUI, compiladas para Xtensa, e viajam no pacote do app como core.bin. O
// main.js fica so com input, desenho e UI.
//
// Contrato (tools/native/celeros_core.h, incluido com -I tools/native):
// entrada unica `core_ctl`, estado quente no .bss do blob, resultado no
// SCRATCH num bloco fixo que o JS le por nativeRead em fatias de 256 B.
// Nada de libc/RTOS: sem malloc, arquivo, task, tempo ou IO — e tick curto
// (um quadro por chamada).
//
// O exemplo e um "coletor" de 12x12: ande com as setas e pegue as 8 moedas;
// o botao B acende um sinal no chao (evento para o JS tocar som/efeito).

#include "celeros_core.h"

namespace {

constexpr int kCols = 12;
constexpr int kRows = 12;
constexpr int kCoins = 8;
constexpr int kCell = 32;  // px do tabuleiro (o JS desenha no mesmo tamanho)

// Layout FIXO da scratch (o app descobre por core_ctl, nunca hardcoda):
//   ENTRADA do nivel (kCoins u16) | BLOCO DE SAIDA
constexpr uint32_t kLevelOff = 0;
constexpr uint32_t kLevelCap = 64;
constexpr uint32_t kOutOff = 64;

// Estado que o JS precisa desenhar (wire, espelho no main.js). Multiple de 4.
struct DemoState {
    int32_t px, py;        // posicao em Q16.16, em px do tabuleiro
    uint16_t score;
    uint16_t tick;
    uint16_t flags;        // bit0 = venceu
    uint16_t coinMask;     // bit i = moeda i ja coletada
    uint16_t coinCell[kCoins];
    uint16_t sparkCell;    // 0xFFFF = sem sinal
    uint16_t pad;
};

// Estado quente do core (nao vai no wire).
struct Demo {
    int32_t px, py;        // Q16.16
    uint16_t tick;
    uint16_t score;
    uint16_t coinMask;
    uint16_t coinCell[kCoins];
    uint16_t sparkCell;    // 0xFFFF = sem sinal
    uint16_t sparkTicks;
};
static Demo g;
static CelerCoreOut g_out;

// Bits de input (convencao do template; o JS manda a mascara em CORE_STEP).
enum { IN_UP = 1, IN_DOWN = 2, IN_LEFT = 4, IN_RIGHT = 8, IN_A = 16, IN_B = 32 };

inline uint16_t cellOf(int x, int y) { return (uint16_t)(y * kCols + x); }

void markCell(int x, int y) {
    if (x < 0 || y < 0 || x >= kCols || y >= kRows) return;
    celer_core_dirty(&g_out, cellOf(x, y));
}

void resetDemo() {
    g.px = celer_fx(kCols / 2 * kCell);
    g.py = celer_fx(kRows / 2 * kCell);
    g.tick = 0;
    g.score = 0;
    g.coinMask = 0;
    g.sparkCell = 0xFFFF;
    g.sparkTicks = 0;
    // moedas: padrao embutido se o app nao carregou um nivel
    static const uint8_t kDefault[kCoins] = { 1, 4, 9, 14, 23, 32, 97, 118 };
    for (int i = 0; i < kCoins; i++) g.coinCell[i] = kDefault[i];
    // primeiro quadro: tudo sujo (o JS pinta o tabuleiro inteiro)
    for (int c = 0; c < kCols * kRows; c++) celer_core_dirty(&g_out, (uint16_t)c);
}

void publish() {
    DemoState* s = (DemoState*)celer_core_state(&g_out);
    s->px = g.px;
    s->py = g.py;
    s->score = g.score;
    s->tick = g.tick;
    s->flags = (g.coinMask == (uint16_t)((1u << kCoins) - 1)) ? 1 : 0;
    s->coinMask = g.coinMask;
    for (int i = 0; i < kCoins; i++) s->coinCell[i] = g.coinCell[i];
    s->sparkCell = g.sparkCell;
    s->pad = 0;
    celer_core_end(&g_out);
}

void step(uint16_t in) {
    int x = celer_px(g.px), y = celer_px(g.py);
    const int speed = 8;  // px por tick

    if (in & IN_LEFT)  x -= speed;
    if (in & IN_RIGHT) x += speed;
    if (in & IN_UP)    y -= speed;
    if (in & IN_DOWN)  y += speed;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x > (kCols - 1) * kCell) x = (kCols - 1) * kCell;
    if (y > (kRows - 1) * kCell) y = (kRows - 1) * kCell;

    const int oldCx = celer_px(g.px) / kCell, oldCy = celer_px(g.py) / kCell;
    g.px = celer_fx(x);
    g.py = celer_fx(y);
    const int cx = x / kCell, cy = y / kCell;
    if (cx != oldCx || cy != oldCy) {
        markCell(oldCx, oldCy);
        markCell(cx, cy);
    }

    // coleta: a celula do jogador bate com a de uma moeda ainda nao pega
    for (int i = 0; i < kCoins; i++) {
        if (g.coinMask & (1u << i)) continue;
        if (g.coinCell[i] != cellOf(cx, cy)) continue;
        g.coinMask |= (uint16_t)(1u << i);
        g.score += 10;
        markCell(cx, cy);
        celer_core_event(&g_out, 2 /* COIN */, (uint16_t)i, g.score, cellOf(cx, cy));
        if (g.coinMask == (uint16_t)((1u << kCoins) - 1))
            celer_core_event(&g_out, 3 /* WIN */, g.tick, 0, 0);
    }

    if (in & IN_B) {
        g.sparkCell = cellOf(cx, cy);
        g.sparkTicks = 6;
        markCell(cx, cy);
        celer_core_event(&g_out, 1 /* SPARK */, g.sparkCell, 0, 0);
    }
    if (g.sparkTicks > 0) {
        g.sparkTicks--;
        if (g.sparkTicks == 0) {
            const uint16_t c = g.sparkCell;
            g.sparkCell = 0xFFFF;
            markCell(c % kCols, c / kCols);
        }
    }
    g.tick++;
}

}  // namespace

extern "C" uint32_t core_ctl(void* scratch, int32_t cmd, int32_t arg) {
    uint8_t* sc = (uint8_t*)scratch;
    switch (cmd) {
    case CORE_INIT:
        if (sc == nullptr) return 0;
        celer_core_begin(&g_out, sc + kOutOff,
                         (uint16_t)CELER_OUT_BYTES(sizeof(DemoState)), sizeof(DemoState));
        resetDemo();
        publish();
        return 1;
    case CORE_RESET:
        resetDemo();
        publish();
        return 1;
    case CORE_STEP:
        step((uint16_t)arg);
        publish();
        return CELER_STEP_ALL;
    case CORE_LOAD_LEVEL: {
        if (sc == nullptr || arg < (int32_t)(kCoins * 2)) return 0;
        const uint16_t* cells = (const uint16_t*)(sc + kLevelOff);
        resetDemo();  // jogador no centro, tudo sujo
        for (int i = 0; i < kCoins; i++)
            g.coinCell[i] = cells[i] < (uint16_t)(kCols * kRows) ? cells[i] : 0;
        publish();
        return 1;
    }
    case CORE_OUT_OFF:
        return kOutOff;
    case CORE_OUT_SIZE:
        return CELER_OUT_BYTES(sizeof(DemoState));
    case CORE_LEVEL_OFF:
        return kLevelOff;
    case CORE_LEVEL_SIZE:
        return kLevelCap;
    case CORE_SAVE:
        return 0;  // o template nao tem save state (o jogo pode implementar)
    case CORE_LOAD_STATE:
        (void)arg;
        return 0;
    default:
        return 0;
    }
}
