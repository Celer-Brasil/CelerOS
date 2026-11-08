// Core de LOGICA do Detona (blob CLRN) — a simulacao da FASE vive aqui.
//
// Cobre o que era JS no `Assets/Scripts/detona.js`: movimento na grade,
// bombas, chamas, caixas, inimigos (slime/hunter/ghost/rei), drops, saida,
// tempo e vidas. O JS fica com input (joystick/botoes), DESENHO, HUD, FX,
// audio, rede do duelo, sobrevivencia e as telas de titulo/mapa/vitoria.
//
// ABI: tools/native/celeros_core.h. Uma chamada por quadro:
//   nativeCall(h, 0, CORE_STEP, (dtMs << 8) | cmds)
//   cmds: 1 cima, 2 baixo, 4 esquerda, 8 direita, 16 BOMBA, 32 DETONAR
// O estado/eventos/sujos saem no bloco de saida do scratch; o espelho do
// layout esta em Assets/Scripts/detona_core.js.
//
// Payload do nivel (CORE_LOAD_LEVEL, bytes ja copiados em LEVEL_OFF):
//   [COLS*ROWS grid][exitC][exitR][mode][time0_ds u16][ne][ (type,c,r,hp) x ne ]
// grid: 0 livre, 1 parede, 2 caixa (a saida e caixa ate revelar).

#include "celeros_core.h"

namespace {

constexpr int COLS = 15;
constexpr int ROWS = 13;
constexpr int CELL = 32;
constexpr int NCEL = COLS * ROWS;

constexpr uint32_t kLevelOff = 0;
// area de nivel do scratch: o payload chega NIBBLE-ENCODADO (2 chars por
// byte), entao a region precisa do dobro do maior payload decodificado
// (grade 195 + cabecalho + 24 inimigos x 4 + jogador = 299 B -> 598 chars).
constexpr uint32_t kLevelCap = 1024;
constexpr uint32_t kOutOff = kLevelCap;

enum CellKind { FREE = 0, SOLID = 1, CRATE = 2, EXITC = 3 };
enum { MODE_CAMPAIGN = 0, MODE_SURVIVE = 1, MODE_DUEL = 2 };

// cmds (byte baixo de CORE_STEP); o dt vem em ms no byte alto.
enum { CMD_UP = 1, CMD_DOWN = 2, CMD_LEFT = 4, CMD_RIGHT = 8, CMD_BOMB = 16, CMD_DETONATE = 32 };

enum { DIR_DOWN = 0, DIR_LEFT = 1, DIR_RIGHT = 2, DIR_UP = 3 };
enum { EN_SLIME = 0, EN_HUNTER = 1, EN_GHOST = 2, EN_BOSS = 3 };

enum {
    EV_EXPLODE = 1, EV_CRATE = 2, EV_DROP = 3, EV_KILL = 4, EV_HURT = 5,
    EV_EXIT = 6, EV_WIN = 7, EV_LOSE = 8, EV_BOSS_BOMB = 9, EV_PICKUP = 10, EV_BOMB = 11,
};

enum { DROP_RANGE = 0, DROP_BOMB = 1, DROP_SPEED = 2, DROP_REMOTE = 3, DROP_SHIELD = 4, DROP_LIFE = 5 };

// ---------------------------------------------------------- wire (espelho)
// O JS le exatamente esta estrutura logo apos o head de 8 B.
struct WireState {
    int32_t px, py;                              // posicao do jogador, px*256
    uint16_t gx, gy, lives, score;
    uint16_t range, maxBombs, speed, flags;      // speed Q8.8; flags: 1 lost,2 won,4 shield,8 remote,16 exit,32 moving,64 bossDead
    uint16_t timeLeft_ds, invuln_ms, animT_ms, face;
    uint8_t nb, nf, ne, nd;
    uint16_t pad;
};
struct WireBomb { uint8_t c, r, range, owner, remote, pad0; uint16_t t; uint16_t pad1; };
struct WireFlame { uint8_t c, r, owner, pad1; uint16_t t; };
struct WireEnemy { uint8_t c, r, type, hp, maxHp, active; uint16_t aiT; };
struct WireDrop { uint8_t c, r, kind, pad; };

// ABI host x blob (x86 x xtensa, ambos little-endian ILP32): os structs do
// wire so tem u8/u16/i32 com pad explicito — o sizeof tem que bater nos
// dois (os valores sao o espelho em Assets/Scripts/detona_core.js).
static_assert(sizeof(WireState) == 40, "wire estado = 40 B (espelho JS ST=40)");
static_assert(sizeof(WireBomb) == 10, "wire bomba = 10 B (passo 10 no espelho JS)");
static_assert(sizeof(WireFlame) == 6, "wire chama = 6 B (passo 6 no espelho JS)");
static_assert(sizeof(WireEnemy) == 8, "wire inimigo = 8 B (passo 8 no espelho JS)");
static_assert(sizeof(WireDrop) == 4, "wire drop = 4 B (passo 4 no espelho JS)");

constexpr uint32_t kArraysBytes = 16 * sizeof(WireBomb) + 64 * sizeof(WireFlame)
                                + 24 * sizeof(WireEnemy) + 16 * sizeof(WireDrop);
// o bloco de ESTADO do contrato cobre o WireState E os arrays: a lista de
// sujos comeca em 8+stateBytes (por isso stateBytes = estado + arrays)
constexpr uint32_t kStateBytes = sizeof(WireState) + kArraysBytes;
static_assert((kStateBytes % 4) == 0, "stateBytes multiplo de 4 (alinhamento das listas)");
constexpr uint32_t kOutBytes = CELER_OUT_BYTES(kStateBytes);

// ---------------------------------------------------------------- estado
struct Bomb { uint8_t c, r, range, owner, remote; uint16_t t; };
struct Flame { uint8_t c, r, owner, pad; uint16_t t; };
struct Enemy { uint8_t c, r, type, hp, maxHp, active; uint16_t aiT; };
struct Drop { uint8_t c, r, kind; };

struct Sim {
    uint8_t grid[NCEL];
    uint8_t exitC, exitR, exitRevealed;
    uint8_t mode;

    uint8_t gc, gr, fromC, fromR, toC, toR, face;
    int32_t px, py;            // px*256
    uint16_t moveT, moving;    // ms
    uint8_t lives, range, maxBombs, shield, remote;
    uint16_t score, speed, invuln, timeLeft, time0, animT;
    uint16_t clockAcc;         // ms do quadro ainda nao virados em ds
    uint8_t done, lost, won, bossDead;

    Bomb bombs[16]; uint8_t nb;
    Flame flames[64]; uint8_t nf;
    Enemy enemies[24]; uint8_t ne;
    Drop drops[16]; uint8_t nd;

    uint32_t rng;
};

static Sim s;
static CelerCoreOut g_out;

// --------------------------------------------------------------- helpers
inline int32_t fx(int v) { return (int32_t)v * 256; }
inline int center(int c) { return c * CELL + CELL / 2; }
inline int absI(int v) { return v < 0 ? -v : v; }

uint32_t rnd() {
    uint32_t x = s.rng;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    s.rng = x ? x : 0x1234567u;
    return s.rng;
}
bool chance(uint32_t pct) { return (rnd() % 100u) < pct; }

uint8_t gridAt(int c, int r) {
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return SOLID;
    return s.grid[r * COLS + c];
}
void setGrid(int c, int r, uint8_t v) {
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return;
    s.grid[r * COLS + c] = v;
}
void markCell(int c, int r) {
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return;
    celer_core_dirty(&g_out, (uint16_t)(r * COLS + c));
}

int bombAt(int c, int r) {
    for (int i = 0; i < s.nb; i++)
        if (s.bombs[i].c == c && s.bombs[i].r == r) return i;
    return -1;
}

void addFlame(int c, int r, uint8_t owner) {
    for (int i = 0; i < s.nf; i++)
        if (s.flames[i].c == c && s.flames[i].r == r) { s.flames[i].t = 350; markCell(c, r); return; }
    if (s.nf >= 64) return;
    s.flames[s.nf].c = (uint8_t)c; s.flames[s.nf].r = (uint8_t)r;
    s.flames[s.nf].owner = owner; s.flames[s.nf].t = 350;
    s.nf++;
    markCell(c, r);
}

void maybeDrop(int c, int r) {
    if (!chance(38)) return;
    if (s.nd >= 16) return;
    const uint32_t w = rnd() % 100u;
    uint8_t kind = DROP_RANGE;
    if (w < 26) kind = DROP_RANGE;
    else if (w < 50) kind = DROP_BOMB;
    else if (w < 68) kind = DROP_SPEED;
    else if (w < 80) kind = DROP_REMOTE;
    else if (w < 90) kind = DROP_SHIELD;
    else kind = DROP_LIFE;
    s.drops[s.nd].c = (uint8_t)c; s.drops[s.nd].r = (uint8_t)r; s.drops[s.nd].kind = kind;
    s.nd++;
    celer_core_event(&g_out, EV_DROP, (uint16_t)(r * COLS + c), kind, 0);
}

void destroyCrate(int c, int r) {
    if (gridAt(c, r) != CRATE) return;
    const bool isExit = (c == s.exitC && r == s.exitR);
    setGrid(c, r, isExit ? EXITC : FREE);
    s.score += 10;
    markCell(c, r);
    celer_core_event(&g_out, EV_CRATE, (uint16_t)(r * COLS + c), 0, 0);
    if (isExit) {
        s.exitRevealed = 1;
        celer_core_event(&g_out, EV_EXIT, (uint16_t)(r * COLS + c), 0, 0);
    } else {
        maybeDrop(c, r);
    }
}

void hurtPlayer();
void hitEnemiesAt(int c, int r, uint8_t owner);

void explode(int bi) {
    const Bomb b = s.bombs[bi];
    s.bombs[bi] = s.bombs[--s.nb];
    addFlame(b.c, b.r, b.owner);
    static const int8_t DIRS[4][2] = { { 0, -1 }, { 0, 1 }, { -1, 0 }, { 1, 0 } };
    for (int d = 0; d < 4; d++) {
        for (int n = 1; n <= b.range; n++) {
            const int c = b.c + DIRS[d][0] * n, r = b.r + DIRS[d][1] * n;
            if (c < 0 || r < 0 || c >= COLS || r >= ROWS) break;
            const uint8_t v = gridAt(c, r);
            if (v == SOLID) break;
            if (v == CRATE) { addFlame(c, r, b.owner); destroyCrate(c, r); break; }
            addFlame(c, r, b.owner);
            const int other = bombAt(c, r);
            if (other >= 0) s.bombs[other].t = 0;
        }
    }
    // dano NO INSTANTE da explosao (paridade com o detona.js): chamas do
    // dono ferem os inimigos uma vez; qualquer chama queima o jogador. O
    // updateFlames so envelhece — dano por quadro derretia o inimigo parado
    // no fogo.
    for (int i = 0; i < s.nf; i++)
        if (s.flames[i].owner == b.owner)
            hitEnemiesAt(s.flames[i].c, s.flames[i].r, b.owner);
    for (int i = 0; i < s.nf; i++)
        if (s.flames[i].c == s.gc && s.flames[i].r == s.gr) { hurtPlayer(); break; }
    celer_core_event(&g_out, EV_EXPLODE, (uint16_t)(b.r * COLS + b.c), b.owner, 0);
}

void hurtPlayer() {
    if (s.invuln > 0 || s.done || s.lost) return;
    if (s.shield) {
        s.shield = 0;
        s.invuln = 1400;
        celer_core_event(&g_out, EV_HURT, s.lives, 1, 0);
        return;
    }
    if (s.lives > 0) s.lives--;
    s.invuln = 2000;
    celer_core_event(&g_out, EV_HURT, s.lives, 0, 0);
    if (s.lives == 0) {
        s.lost = 1; s.done = 1;
        celer_core_event(&g_out, EV_LOSE, 0, 0, 0);
        return;
    }
    // volta ao canto seguro (1,1), como o detona.js (hurtPlayer): sem isto o
    // nativo deixava o jogador em cima da bomba que acabou de ferir
    s.moving = 0; s.moveT = 0;
    markCell(s.gc, s.gr);
    s.gc = 1; s.gr = 1;
    s.px = fx(center(1)); s.py = fx(center(1));
    markCell(1, 1);
}

void hitEnemiesAt(int c, int r, uint8_t owner) {
    for (int i = 0; i < s.ne; i++) {
        Enemy& e = s.enemies[i];
        if (!e.active) continue;
        if (e.type == EN_BOSS && owner == 1) continue;
        if (e.c != c || e.r != r) continue;
        if (e.hp > 0) e.hp--;
        markCell(e.c, e.r);
        if (e.hp == 0) {
            e.active = 0;
            markCell(e.c, e.r);
            const uint16_t pts = (e.type == EN_BOSS) ? 500 : 50;
            s.score += pts;
            if (e.type == EN_BOSS) s.bossDead = 1;
            celer_core_event(&g_out, EV_KILL, (uint16_t)(e.r * COLS + e.c), pts, e.type);
        }
    }
}

bool canStep(int c, int r) {
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return false;
    const uint8_t v = gridAt(c, r);
    if (v == SOLID || v == CRATE) return false;
    if (bombAt(c, r) >= 0) return false;
    return true;
}

void beginStep(int dc, int dr) {
    if (s.moving > 0 || s.done || s.lost) return;
    s.face = dc < 0 ? DIR_LEFT : (dc > 0 ? DIR_RIGHT : (dr < 0 ? DIR_UP : DIR_DOWN));
    const int c = s.gc + dc, r = s.gr + dr;
    if (!canStep(c, r)) return;
    s.fromC = s.gc; s.fromR = s.gr;
    s.toC = (uint8_t)c; s.toR = (uint8_t)r;
    s.gc = (uint8_t)c; s.gr = (uint8_t)r;
    s.moveT = (uint16_t)((120u * 256u) / (s.speed ? s.speed : 256u));
    s.moving = s.moveT;
    markCell(s.fromC, s.fromR);
    markCell(s.toC, s.toR);
}

void placeBomb() {
    if (s.done || s.lost) return;
    if (s.nb >= s.maxBombs || s.nb >= 16) return;
    if (bombAt(s.gc, s.gr) >= 0) return;
    Bomb& b = s.bombs[s.nb++];
    b.c = s.gc; b.r = s.gr; b.t = 1600; b.range = s.range;
    b.owner = 0; b.remote = s.remote;
    markCell(s.gc, s.gr);
    celer_core_event(&g_out, EV_BOMB, (uint16_t)(s.gr * COLS + s.gc), 0, 0);
}

void detonateRemote() {
    for (int i = 0; i < s.nb; i++)
        if (s.bombs[i].remote && s.bombs[i].owner == 0) s.bombs[i].t = 0;
}

void updateBombs(uint16_t dt) {
    for (int i = 0; i < s.nb; i++)
        s.bombs[i].t = (s.bombs[i].t > dt) ? (uint16_t)(s.bombs[i].t - dt) : 0;
    int guard = 64;
    while (guard-- > 0) {
        int boom = -1;
        for (int i = 0; i < s.nb; i++) if (s.bombs[i].t == 0) { boom = i; break; }
        if (boom < 0) break;
        explode(boom);
    }
}

void updateFlames(uint16_t dt) {
    // so envelhece: o dano aconteceu uma vez, dentro do explode()
    for (int i = 0; i < s.nf;) {
        if (s.flames[i].t > dt) { s.flames[i].t = (uint16_t)(s.flames[i].t - dt); i++; continue; }
        markCell(s.flames[i].c, s.flames[i].r);
        s.flames[i] = s.flames[--s.nf];
    }
}

uint16_t enemyInterval(const Enemy& e) {
    switch (e.type) {
    case EN_HUNTER: return 420;
    case EN_GHOST: return 580;
    case EN_BOSS: return 1000;
    default: return 820;
    }
}

bool moveEnemy(Enemy& e, int dc, int dr) {
    const int nc = e.c + dc, nr = e.r + dr;
    if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) return false;
    const uint8_t v = gridAt(nc, nr);
    if (v == SOLID) return false;
    if (v == CRATE && e.type != EN_GHOST) return false;
    if (bombAt(nc, nr) >= 0) return false;
    markCell(e.c, e.r);
    e.c = (uint8_t)nc; e.r = (uint8_t)nr;
    markCell(e.c, e.r);
    return true;
}

void updateEnemies(uint16_t dt) {
    for (int i = 0; i < s.ne; i++) {
        Enemy& e = s.enemies[i];
        if (!e.active) continue;
        if (e.c == s.gc && e.r == s.gr) { hurtPlayer(); continue; }
        if (e.aiT > dt) { e.aiT = (uint16_t)(e.aiT - dt); continue; }
        e.aiT = enemyInterval(e);
        const int dc = (s.gc == e.c) ? 0 : (s.gc > e.c ? 1 : -1);
        const int dr = (s.gr == e.r) ? 0 : (s.gr > e.r ? 1 : -1);
        if (absI(s.gc - e.c) > absI(s.gr - e.r)) {
            if (!moveEnemy(e, dc, 0)) moveEnemy(e, 0, dr);
        } else {
            if (!moveEnemy(e, 0, dr)) moveEnemy(e, dc, 0);
        }
        if (e.c == s.gc && e.r == s.gr) hurtPlayer();
        if (e.type == EN_BOSS && chance(18) && s.nb < 5) {
            Bomb& b = s.bombs[s.nb++];
            b.c = e.c; b.r = e.r; b.t = 2200; b.range = 2;
            b.owner = 1; b.remote = 0;
            markCell(e.c, e.r);
            celer_core_event(&g_out, EV_BOSS_BOMB, (uint16_t)(e.r * COLS + e.c), 0, 0);
        }
    }
}

void applyDrop(uint8_t kind) {
    switch (kind) {
    case DROP_RANGE: if (s.range < 5) s.range++; break;
    case DROP_BOMB: if (s.maxBombs < 5) s.maxBombs++; break;
    case DROP_SPEED: {
        uint32_t v = (uint32_t)s.speed * 302u / 256u;
        s.speed = (uint16_t)(v > 563u ? 563u : v);
        break;
    }
    case DROP_REMOTE: s.remote = 1; break;
    case DROP_SHIELD: s.shield = 1; break;
    case DROP_LIFE: if (s.lives < 5) s.lives++; break;
    default: break;
    }
    s.score += 25;
    celer_core_event(&g_out, EV_PICKUP, kind, s.score, 0);
}

void updateDrops() {
    for (int i = 0; i < s.nd;) {
        if (s.drops[i].c == s.gc && s.drops[i].r == s.gr) {
            applyDrop(s.drops[i].kind);
            markCell(s.drops[i].c, s.drops[i].r);
            s.drops[i] = s.drops[--s.nd];
            continue;
        }
        i++;
    }
}

int aliveEnemies() {
    int n = 0;
    for (int i = 0; i < s.ne; i++) if (s.enemies[i].active) n++;
    return n;
}

void checkExit() {
    if (s.mode != MODE_CAMPAIGN || s.done || s.lost) return;
    if (s.gc != s.exitC || s.gr != s.exitR) return;
    if (!s.exitRevealed || aliveEnemies()) return;
    s.done = 1;
    s.won = 1;
    s.score = (uint16_t)(s.score + 100 + (s.timeLeft / 10) * 10);
    celer_core_event(&g_out, EV_WIN, s.score, 0, 0);
}

// ------------------------------------------------------------------ saida
void publish() {
    WireState* w = (WireState*)celer_core_state(&g_out);
    w->px = s.px;
    w->py = s.py;
    w->gx = s.gc; w->gy = s.gr;
    w->lives = s.lives;
    w->score = s.score;
    w->range = s.range;
    w->maxBombs = s.maxBombs;
    w->speed = s.speed;
    w->flags = (uint16_t)((s.lost ? 1 : 0) | (s.won ? 2 : 0) | (s.shield ? 4 : 0) |
                          (s.remote ? 8 : 0) | (s.exitRevealed ? 16 : 0) |
                          (s.moving > 0 ? 32 : 0) | (s.bossDead ? 64 : 0));
    w->timeLeft_ds = s.timeLeft;
    w->invuln_ms = s.invuln;
    w->animT_ms = s.animT;
    w->face = s.face;
    w->nb = s.nb; w->nf = s.nf; w->ne = s.ne; w->nd = s.nd;
    w->pad = 0;

    uint8_t* p = (uint8_t*)w + sizeof(WireState);
    WireBomb* wb = (WireBomb*)p;
    for (int i = 0; i < s.nb; i++) {
        wb[i].c = s.bombs[i].c; wb[i].r = s.bombs[i].r;
        wb[i].range = s.bombs[i].range; wb[i].owner = s.bombs[i].owner;
        wb[i].remote = s.bombs[i].remote; wb[i].pad0 = 0; wb[i].pad1 = 0;
        wb[i].t = s.bombs[i].t;
    }
    p += 16 * sizeof(WireBomb);
    WireFlame* wf = (WireFlame*)p;
    for (int i = 0; i < s.nf; i++) {
        wf[i].c = s.flames[i].c; wf[i].r = s.flames[i].r;
        wf[i].owner = s.flames[i].owner; wf[i].pad1 = 0; wf[i].t = s.flames[i].t;
    }
    p += 64 * sizeof(WireFlame);
    WireEnemy* we = (WireEnemy*)p;
    for (int i = 0; i < s.ne; i++) {
        we[i].c = s.enemies[i].c; we[i].r = s.enemies[i].r;
        we[i].type = s.enemies[i].type; we[i].hp = s.enemies[i].hp;
        we[i].maxHp = s.enemies[i].maxHp; we[i].active = s.enemies[i].active;
        we[i].aiT = s.enemies[i].aiT;
    }
    p += 24 * sizeof(WireEnemy);
    WireDrop* wd = (WireDrop*)p;
    for (int i = 0; i < s.nd; i++) {
        wd[i].c = s.drops[i].c; wd[i].r = s.drops[i].r;
        wd[i].kind = s.drops[i].kind; wd[i].pad = 0;
    }
    celer_core_end(&g_out);
}

void resetSim(uint16_t seed) {
    // comeca uma PARTIDA nova: as listas de sujos/eventos nao acumulam entre
    // INIT/LOAD_LEVEL (o celer_core_begin so roda no INIT)
    g_out.dirtyCount = 0;
    g_out.eventCount = 0;
    s.nb = s.nf = s.nd = 0;
    // o RESET volta o elenco da fase (a saida exige a fase limpa; sem isto um
    // RESET depois de inimigos mortos entregava a fase concluida)
    for (int i = 0; i < s.ne; i++) {
        s.enemies[i].active = 1;
        s.enemies[i].hp = s.enemies[i].maxHp;
        s.enemies[i].aiT = 0;
    }
    // a saida revelada mora na grade (EXITC): deriva da celula, nao de estado solto
    s.exitRevealed = (gridAt(s.exitC, s.exitR) == EXITC) ? 1 : 0;
    s.lives = 3; s.range = 1; s.maxBombs = 1; s.speed = 256;
    s.shield = s.remote = s.done = s.lost = s.won = s.bossDead = 0;
    s.invuln = 0; s.score = 0; s.animT = 0;
    s.moving = 0; s.moveT = 0; s.face = DIR_DOWN;
    s.clockAcc = 0;
    s.timeLeft = s.time0;
    s.rng = 0x9E3779B9u ^ (uint32_t)seed * 2654435761u;
    for (int i = 0; i < NCEL; i++) markCell(i % COLS, i / COLS);
}

}  // namespace

// ================================================================ entrada
extern "C" uint32_t core_ctl(void* scratch, int32_t cmd, int32_t arg) {
    uint8_t* sc = (uint8_t*)scratch;
    switch (cmd) {
    case CORE_INIT:
        if (sc == nullptr) return 0;
        celer_core_begin(&g_out, sc + kOutOff, (uint16_t)kOutBytes, (uint16_t)kStateBytes);
        s.time0 = 0;
        resetSim(1);
        publish();
        return 1;
    case CORE_LOAD_LEVEL: {
        if (sc == nullptr) return 0;
        // payload vem NIBBLE-ENCODADO do JS (2 chars por byte): a string do
        // Duktape e CESU-8, entao qualquer byte > 0x7F viraria 2 bytes no
        // nativeWrite e desalinharia o resto. Aqui volta a ser 1 byte.
        static uint8_t lv[kLevelCap / 2];
        const uint8_t* raw = sc + kLevelOff;
        const int32_t n = arg / 2;
        // minimo decodificado: grade + cabecalho + 1 inimigo; o teto e a
        // propria area de nivel (o decode nunca le fora da regiao)
        if (n < (int32_t)(NCEL + 6) || n > (int32_t)(kLevelCap / 2)) return 0;
        for (int32_t i = 0; i < n; i++)
            lv[i] = (uint8_t)((raw[i * 2] << 4) | (raw[i * 2 + 1] & 0x0F));
        for (int i = 0; i < NCEL; i++) s.grid[i] = lv[i] & 0x03;   // 0 livre..3 saida
        s.exitC = lv[NCEL] < COLS ? lv[NCEL] : (uint8_t)(COLS - 1);
        s.exitR = lv[NCEL + 1] < ROWS ? lv[NCEL + 1] : (uint8_t)(ROWS - 1);
        const uint8_t m = lv[NCEL + 2];
        s.mode = (m > (uint8_t)MODE_DUEL) ? (uint8_t)MODE_CAMPAIGN : m;
        s.time0 = (uint16_t)(lv[NCEL + 3] | (lv[NCEL + 4] << 8));
        int off = NCEL + 5;
        const int ne = lv[off++];
        s.ne = 0;
        for (int i = 0; i < ne && i < 24; i++) {
            if (off + 4 > n) break;   // payload truncado: nao le lixo de carga antiga
            Enemy& e = s.enemies[s.ne++];
            e.type = lv[off] & 0x03;
            e.c = lv[off + 1] < COLS ? lv[off + 1] : (uint8_t)(COLS - 1);
            e.r = lv[off + 2] < ROWS ? lv[off + 2] : (uint8_t)(ROWS - 1);
            e.maxHp = lv[off + 3] ? lv[off + 3] : 1;
            e.hp = e.maxHp;
            e.active = 1;
            e.aiT = 0;
            off += 4;
        }
        // jogador: o JS manda a celula inicial no fim do payload
        if (n >= off + 2) {
            s.gc = lv[off] < COLS ? lv[off] : (uint8_t)(COLS - 1);
            s.gr = lv[off + 1] < ROWS ? lv[off + 1] : (uint8_t)(ROWS - 1);
            s.px = fx(center(s.gc));
            s.py = fx(center(s.gr));
        }
        resetSim((uint16_t)(s.time0 ^ (s.mode * 257)));
        publish();
        return (uint32_t)off;
    }
    case CORE_RESET:
        resetSim((uint16_t)arg);
        publish();
        return 1;
    case CORE_STEP: {
        const uint16_t dt = (uint16_t)(((uint32_t)arg >> 8) & 0xFFFF);
        const uint16_t cmds = (uint16_t)((uint32_t)arg & 0xFF);
        if (s.done || s.lost) return 0;
        if (cmds & CMD_LEFT) beginStep(-1, 0);
        if (cmds & CMD_RIGHT) beginStep(1, 0);
        if (cmds & CMD_UP) beginStep(0, -1);
        if (cmds & CMD_DOWN) beginStep(0, 1);
        if (cmds & CMD_BOMB) placeBomb();
        if (cmds & CMD_DETONATE) detonateRemote();

        if (s.moving > 0) {
            s.moving = (s.moving > dt) ? (uint16_t)(s.moving - dt) : 0;
            const uint32_t total = s.moveT ? s.moveT : 1;
            const uint32_t gone = total - s.moving;
            const int32_t x0 = fx(center(s.fromC)), y0 = fx(center(s.fromR));
            const int32_t x1 = fx(center(s.toC)), y1 = fx(center(s.toR));
            // 32 bits basta: |delta| <= 32*256 e gone <= total <= 255
            s.px = x0 + ((x1 - x0) * (int32_t)gone) / (int32_t)total;
            s.py = y0 + ((y1 - y0) * (int32_t)gone) / (int32_t)total;
            if (s.moving == 0) { s.px = x1; s.py = y1; }
        } else {
            s.px = fx(center(s.gc));
            s.py = fx(center(s.gr));
        }

        if (s.invuln > 0) s.invuln = (s.invuln > dt) ? (uint16_t)(s.invuln - dt) : 0;
        s.animT = (uint16_t)(s.animT + dt);
        if (s.time0 > 0) {
            // o quadro chega em ms (16..255): acumula e vira ds quando fecha
            // 100 — o `dt / 100` antigo truncava para 0 no tick de 16 ms e o
            // relogio da fase NUNCA descia
            const uint32_t acc = (uint32_t)s.clockAcc + dt;
            const uint16_t ds = (uint16_t)(acc / 100u);
            s.clockAcc = (uint16_t)(acc % 100u);
            if (s.timeLeft > ds) s.timeLeft = (uint16_t)(s.timeLeft - ds);
            else {
                s.timeLeft = 0;
                s.clockAcc = 0;
                hurtPlayer();
                if (!s.lost) s.timeLeft = (uint16_t)(s.time0 / 2);
            }
        }

        updateBombs(dt);
        updateFlames(dt);
        updateEnemies(dt);
        updateDrops();
        checkExit();
        publish();
        return CELER_STEP_ALL;
    }
    case CORE_OUT_OFF:
        return kOutOff;
    case CORE_OUT_SIZE:
        return kOutBytes;
    case CORE_LEVEL_OFF:
        return kLevelOff;
    case CORE_LEVEL_SIZE:
        return kLevelCap;
    default:
        return 0;
    }
}
