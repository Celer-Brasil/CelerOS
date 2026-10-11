#pragma once
/**
 * @file Rigid2D.h
 * @brief Corpo rigido 2D (caixas orientadas e circulos) em float puro,
 *        header-only: o System.rigid* (API 33) e o teste host usam este
 *        mesmo codigo.
 *
 * Solver de impulsos sequenciais no molde do box2d-lite (Erin Catto, zlib):
 * SAT caixa-caixa com recorte de aresta incidente (ate 2 contatos com
 * chave de feature), impulso normal/atrito ACUMULADOS com warm start entre
 * steps (as pilhas ficam em pe), penetracao corrigida por SPLIT IMPULSE
 * (pseudo-velocidade que so mexe na posicao — o Baumgarte na velocidade
 * fazia pilhas tremerem sem dormir) e restituicao acima de um limiar de
 * velocidade — so no PRIMEIRO sub-passo de cada contato, e com o alvo
 * limitado (kMaxBounce): repetir o alvo em contato persistente injeta
 * energia quando um corpo leve fica preso entre um pesado e um estatico.
 * Espelho JS: tools/sdk/lib/rigid2d.js (harness/emulador) —
 * mexeu aqui, mexa la. Extras para jogo:
 *  - sub-passos adaptativos (anti-tunel): ninguem anda, por sub-passo,
 *    mais que uma fracao da MENOR meia-espessura do mundo — a pedra rapida
 *    nao atravessa a tabua fina;
 *  - sono por corpo: sem sair da ancora por kSleepTime vira estatico ate
 *    encostar nele um corpo acordado com velocidade, ou o app mexer;
 *  - `hit` por corpo: o maior impulso de impacto do ultimo step (aproximacao
 *    x massa efetiva) — o app tira dano disso. Mesmo portao do quique
 *    (kBounceMin): abaixo disso e' assentamento, nao impacto — contato em
 *    repouso chega com g*dt por sub-passo e gravaria o "peso" do corpo;
 *  - indices ESTAVEIS: remover libera o slot (o proximo add reaproveita).
 *
 * Coordenadas de tela: y cresce para baixo; angulo em radianos (horario na
 * tela). Unidades livres (o app escolhe; gravidade em unidades/s^2).
 */

#include <cmath>
#include <cstdint>
#include <cstring>

namespace celer {
namespace rigid {

constexpr int kMaxBodies = 96;
constexpr int kMaxArbiters = 320;
constexpr int kMaxSub = 16;

constexpr float kSlop = 0.15f;          // penetracao tolerada (sem vies)
constexpr float kBiasFactor = 0.2f;     // fracao da penetracao corrigida por sub-passo
constexpr float kBounceMin = 40.0f;     // aproximacao minima p/ quicar
constexpr float kMaxBounce = 8.0f * kBounceMin;  // teto do alvo de quique (valvula)
constexpr float kSleepLin = 12.0f;      // rapidez (borda inclusa) abaixo disso conta pro sono
constexpr float kSleepDrift = 0.8f;     // ...e sem sair da ancora mais que isso
constexpr float kSleepTurn = 0.04f;     // ...nem girar mais que isso (rad)
constexpr float kSleepTime = 0.5f;      // segundos parado ate dormir
constexpr float kWakeVel = 18.0f;       // rapidez do vizinho que acorda quem dorme
constexpr float kMaxSubDt = 1.0f / 120.0f;
constexpr float kLinDamp = 0.05f;       // arrasto linear (1/s)
constexpr float kAngDamp = 0.8f;        // arrasto angular (1/s)
constexpr float kRollDamp = 5.0f;       // resistencia ao rolamento (circulo encostado)

enum Shape : uint8_t { BOX = 0, CIRCLE = 1 };

struct Body {
    uint8_t alive, shape, awake, touch;   // touch: teve contato no sub-passo
    float x, y, a;          // centro e angulo
    float vx, vy, w;        // velocidade linear e angular
    float hw, hh;           // meias medidas (circulo: hw = hh = raio)
    float invM, invI;       // 0 = estatico
    float mu, e;            // atrito e restituicao
    float sleepT;
    float sx, sy, sa;       // ancora do sono (onde estava quando parou)
    float hit;              // maior impulso de impacto do ultimo step
    float c, s;             // cos/sin de a (cache: valem para o angulo ca)
    float ca;
    float bvx, bvy, bw;     // pseudo-velocidade da correcao de posicao
    float br;               // raio envolvente (fixo: a forma nao muda)
};

struct Contact {
    float px, py;           // ponto de contato
    float sep;              // separacao (negativa = penetrando)
    float r1x, r1y, r2x, r2y;
    float mN, mT;           // massas efetivas normal/tangente
    float vbias;            // restituicao (velocidade alvo de saida)
    float pbias;            // correcao de penetracao (pseudo-velocidade)
    float pn, pt;           // impulsos acumulados (warm start)
    float pb;               // impulso acumulado da correcao (zera por sub-passo)
    uint32_t fid;           // chave de feature (casamento entre steps)
};

struct Arbiter {
    int16_t a, b;           // a < b
    uint8_t n, live;
    float nx, ny;           // normal de a para b
    float mu, e;
    Contact c[2];
};

struct World {
    int nBodies;            // marca d'agua dos slots
    int nArb;
    int iterations;
    Body bodies[kMaxBodies];
    Arbiter arb[kMaxArbiters];
};

// ------------------------------------------------------------- utilidades --

inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline float absf(float v) { return v < 0 ? -v : v; }

// numero util (rejeita NaN e infinito): o duk aceita NaN como numero e um
// unico valor assim vindo de conta errada no app envenenaria o mundo — nas
// comparacoes da fase larga NaN nunca e' "maior que", o corpo para de ser
// rejeitado pelo AABB e vira despertador eterno dos vizinhos
inline bool finf(float v) { return v == v && v < 1e30f && v > -1e30f; }

inline void worldInit(World* w, int iterations) {
    memset(w, 0, sizeof(World));
    w->iterations = iterations < 1 ? 1 : (iterations > 30 ? 30 : iterations);
}

inline int allocSlot(World* w) {
    for (int i = 0; i < w->nBodies; i++) {
        if (!w->bodies[i].alive) return i;
    }
    if (w->nBodies >= kMaxBodies) return -1;
    return w->nBodies++;
}

inline void setMass(Body& b, float density) {
    // !(density > 0) pega NaN tambem (comparacao com NaN e' sempre falsa);
    // densidade nao-finita vira estatico em vez de invM = NaN
    if (!(density > 0) || !finf(density)) { b.invM = 0; b.invI = 0; return; }
    float m, I;
    if (b.shape == CIRCLE) {
        float r = b.hw;
        m = density * 3.14159265f * r * r;
        I = 0.5f * m * r * r;
    } else {
        float W = b.hw * 2, H = b.hh * 2;
        m = density * W * H;
        I = m * (W * W + H * H) / 12.0f;
    }
    b.invM = 1.0f / m;
    b.invI = 1.0f / I;
    // densidade denormal: m subnormal e 1/m estoura p/ inf — o warm start
    // viraria NaN (inf * 0). Massa de poeira (invM > 1e12) e' estatico,
    // como densidade invalida (probe: dens 1e-45 destrua o mundo inteiro)
    if (b.invM > 1e12f || !finf(b.invM) || !finf(b.invI)) { b.invM = 0; b.invI = 0; }
}

inline int addBody(World* w, uint8_t shape, float x, float y, float hw, float hh, float a,
                   float density, float mu, float e) {
    // medida/posicao/angulo invalidos (zero, negativo, NaN, infinito) nao
    // entram: um corpo assim nunca morre nem colide direito
    if (!(hw > 0) || !(hh > 0) || !finf(hw) || !finf(hh) || !finf(x) || !finf(y) || !finf(a)) return -1;
    int i = allocSlot(w);
    if (i < 0) return -1;
    Body& b = w->bodies[i];
    memset(&b, 0, sizeof(Body));
    b.alive = 1;
    b.shape = shape;
    b.awake = 1;
    b.x = x; b.y = y; b.a = a;
    b.hw = hw; b.hh = hh;
    b.mu = finf(mu) ? (mu < 0 ? 0 : mu) : 0;   // NaN/inf: sem atrito
    b.e = finf(e) ? clampf(e, 0, 1) : 0;       // ...e sem quique
    // fase larga, speedOf e o anti-tunel leem o raio a cada par/sub-passo:
    // o sqrt da caixa sai uma vez aqui
    b.br = shape == CIRCLE ? hw : sqrtf(hw * hw + hh * hh);
    b.c = cosf(a); b.s = sinf(a); b.ca = a;
    setMass(b, density);
    return i;
}

inline void wakeAll(World* w) {
    for (int i = 0; i < w->nBodies; i++) {
        Body& b = w->bodies[i];
        if (b.alive && b.invM > 0) { b.awake = 1; b.sleepT = 0; }
    }
}

inline bool removeBody(World* w, int i) {
    if (i < 0 || i >= w->nBodies || !w->bodies[i].alive) return false;
    w->bodies[i].alive = 0;
    w->bodies[i].hit = 0;   // slot morto nao carrega hit velho pro rigidState
    // contatos do corpo saem; o resto do mundo acorda (o que estava em cima
    // precisa cair)
    int j = 0;
    for (int k = 0; k < w->nArb; k++) {
        if (w->arb[k].a == i || w->arb[k].b == i) continue;
        if (j != k) w->arb[j] = w->arb[k];
        j++;
    }
    w->nArb = j;
    while (w->nBodies > 0 && !w->bodies[w->nBodies - 1].alive) w->nBodies--;
    wakeAll(w);
    return true;
}

// ------------------------------------------------------------- colisao ----

struct ClipV { float x, y; uint8_t e[4]; };   // e = inEdge1, outEdge1, inEdge2, outEdge2

enum { NO_EDGE = 0, EDGE1, EDGE2, EDGE3, EDGE4 };

inline uint32_t fkey(const uint8_t* e) {
    return (uint32_t)e[0] | ((uint32_t)e[1] << 8) | ((uint32_t)e[2] << 16) | ((uint32_t)e[3] << 24);
}

// rot (c, s): col1 = (c, s), col2 = (-s, c)
inline void incidentEdge(ClipV* v, float hx, float hy, float px, float py,
                         float c, float s, float nx, float ny) {
    // normal no espaco local do corpo incidente, invertida
    float lx = -(c * nx + s * ny), ly = -(-s * nx + c * ny);
    memset(v, 0, sizeof(ClipV) * 2);
    if (absf(lx) > absf(ly)) {
        if (lx > 0) {
            v[0].x = hx;  v[0].y = -hy; v[0].e[2] = EDGE3; v[0].e[3] = EDGE4;
            v[1].x = hx;  v[1].y = hy;  v[1].e[2] = EDGE4; v[1].e[3] = EDGE1;
        } else {
            v[0].x = -hx; v[0].y = hy;  v[0].e[2] = EDGE1; v[0].e[3] = EDGE2;
            v[1].x = -hx; v[1].y = -hy; v[1].e[2] = EDGE2; v[1].e[3] = EDGE3;
        }
    } else {
        if (ly > 0) {
            v[0].x = hx;  v[0].y = hy;  v[0].e[2] = EDGE4; v[0].e[3] = EDGE1;
            v[1].x = -hx; v[1].y = hy;  v[1].e[2] = EDGE1; v[1].e[3] = EDGE2;
        } else {
            v[0].x = -hx; v[0].y = -hy; v[0].e[2] = EDGE2; v[0].e[3] = EDGE3;
            v[1].x = hx;  v[1].y = -hy; v[1].e[2] = EDGE3; v[1].e[3] = EDGE4;
        }
    }
    for (int i = 0; i < 2; i++) {
        float x = v[i].x, y = v[i].y;
        v[i].x = px + c * x - s * y;
        v[i].y = py + s * x + c * y;
    }
}

inline int clipSegment(ClipV* out, const ClipV* in, float nx, float ny, float off, uint8_t edge) {
    int n = 0;
    float d0 = nx * in[0].x + ny * in[0].y - off;
    float d1 = nx * in[1].x + ny * in[1].y - off;
    if (d0 <= 0) out[n++] = in[0];
    if (d1 <= 0) out[n++] = in[1];
    if (d0 * d1 < 0) {
        float t = d0 / (d0 - d1);
        out[n].x = in[0].x + t * (in[1].x - in[0].x);
        out[n].y = in[0].y + t * (in[1].y - in[0].y);
        if (d0 > 0) {
            memcpy(out[n].e, in[0].e, 4);
            out[n].e[0] = edge; out[n].e[2] = NO_EDGE;
        } else {
            memcpy(out[n].e, in[1].e, 4);
            out[n].e[1] = edge; out[n].e[3] = NO_EDGE;
        }
        n++;
    }
    return n;
}

// caixa x caixa. Devolve 0..2 contatos (normal de A para B em nx/ny)
inline int collideBoxes(const Body& A, const Body& B, Contact* cs, float* nx, float* ny) {
    float hax = A.hw, hay = A.hh, hbx = B.hw, hby = B.hh;
    float ca = A.c, sa = A.s, cb = B.c, sb = B.s;
    float dpx = B.x - A.x, dpy = B.y - A.y;
    // dA = RotA^T dp ; dB = RotB^T dp
    float dAx = ca * dpx + sa * dpy, dAy = -sa * dpx + ca * dpy;
    float dBx = cb * dpx + sb * dpy, dBy = -sb * dpx + cb * dpy;
    // C = RotA^T RotB
    float c11 = ca * cb + sa * sb, c21 = -sa * cb + ca * sb;
    float c12 = -ca * sb + sa * cb, c22 = sa * sb + ca * cb;
    float a11 = absf(c11), a21 = absf(c21), a12 = absf(c12), a22 = absf(c22);
    float faX = absf(dAx) - hax - (a11 * hbx + a12 * hby);
    float faY = absf(dAy) - hay - (a21 * hbx + a22 * hby);
    if (faX > 0 || faY > 0) return 0;
    float fbX = absf(dBx) - (a11 * hax + a21 * hay) - hbx;
    float fbY = absf(dBy) - (a12 * hax + a22 * hay) - hby;
    if (fbX > 0 || fbY > 0) return 0;

    const float relTol = 0.95f, absTol = 0.01f;
    int axis = 0;   // 0 A.x, 1 A.y, 2 B.x, 3 B.y
    float sep = faX;
    float n_x = dAx > 0 ? ca : -ca, n_y = dAx > 0 ? sa : -sa;
    if (faY > relTol * sep + absTol * hay) {
        axis = 1; sep = faY;
        n_x = dAy > 0 ? -sa : sa; n_y = dAy > 0 ? ca : -ca;
    }
    if (fbX > relTol * sep + absTol * hbx) {
        axis = 2; sep = fbX;
        n_x = dBx > 0 ? cb : -cb; n_y = dBx > 0 ? sb : -sb;
    }
    if (fbY > relTol * sep + absTol * hby) {
        axis = 3; sep = fbY;
        n_x = dBy > 0 ? -sb : sb; n_y = dBy > 0 ? cb : -cb;
    }

    float fnx, fny, front, snx, sny, negSide, posSide;
    uint8_t negEdge, posEdge;
    ClipV inc[2];
    if (axis == 0) {
        fnx = n_x; fny = n_y;
        front = A.x * fnx + A.y * fny + hax;
        snx = -sa; sny = ca;
        float side = A.x * snx + A.y * sny;
        negSide = -side + hay; posSide = side + hay;
        negEdge = EDGE3; posEdge = EDGE1;
        incidentEdge(inc, hbx, hby, B.x, B.y, cb, sb, fnx, fny);
    } else if (axis == 1) {
        fnx = n_x; fny = n_y;
        front = A.x * fnx + A.y * fny + hay;
        snx = ca; sny = sa;
        float side = A.x * snx + A.y * sny;
        negSide = -side + hax; posSide = side + hax;
        negEdge = EDGE2; posEdge = EDGE4;
        incidentEdge(inc, hbx, hby, B.x, B.y, cb, sb, fnx, fny);
    } else if (axis == 2) {
        fnx = -n_x; fny = -n_y;
        front = B.x * fnx + B.y * fny + hbx;
        snx = -sb; sny = cb;
        float side = B.x * snx + B.y * sny;
        negSide = -side + hby; posSide = side + hby;
        negEdge = EDGE3; posEdge = EDGE1;
        incidentEdge(inc, hax, hay, A.x, A.y, ca, sa, fnx, fny);
    } else {
        fnx = -n_x; fny = -n_y;
        front = B.x * fnx + B.y * fny + hby;
        snx = cb; sny = sb;
        float side = B.x * snx + B.y * sny;
        negSide = -side + hbx; posSide = side + hbx;
        negEdge = EDGE2; posEdge = EDGE4;
        incidentEdge(inc, hax, hay, A.x, A.y, ca, sa, fnx, fny);
    }
    ClipV c1[2], c2[2];
    if (clipSegment(c1, inc, -snx, -sny, negSide, negEdge) < 2) return 0;
    if (clipSegment(c2, c1, snx, sny, posSide, posEdge) < 2) return 0;
    int n = 0;
    for (int i = 0; i < 2; i++) {
        float s = fnx * c2[i].x + fny * c2[i].y - front;
        if (s <= 0) {
            Contact& c = cs[n];
            c.sep = s;
            c.px = c2[i].x - s * fnx;
            c.py = c2[i].y - s * fny;
            uint8_t e[4];
            memcpy(e, c2[i].e, 4);
            if (axis >= 2) {   // feature trocada: chave igual vista de A
                uint8_t t = e[0]; e[0] = e[2]; e[2] = t;
                t = e[1]; e[1] = e[3]; e[3] = t;
            }
            c.fid = fkey(e);
            n++;
        }
    }
    *nx = n_x; *ny = n_y;
    return n;
}

// circulo (A) x circulo (B)
inline int collideCircles(const Body& A, const Body& B, Contact* cs, float* nx, float* ny) {
    float dx = B.x - A.x, dy = B.y - A.y;
    float rr = A.hw + B.hw;
    float d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr) return 0;
    float d = sqrtf(d2);
    if (d < 1e-6f) { *nx = 0; *ny = 1; d = 0; }
    else { *nx = dx / d; *ny = dy / d; }
    cs[0].sep = d - rr;
    cs[0].px = A.x + *nx * (A.hw + cs[0].sep * 0.5f);
    cs[0].py = A.y + *ny * (A.hw + cs[0].sep * 0.5f);
    cs[0].fid = 1;
    return 1;
}

// caixa (Q) x circulo (C): normal da caixa para o circulo
inline int collideBoxCircle(const Body& Q, const Body& C, Contact* cs, float* nx, float* ny) {
    float dx = C.x - Q.x, dy = C.y - Q.y;
    float lx = Q.c * dx + Q.s * dy, ly = -Q.s * dx + Q.c * dy;   // centro no local da caixa
    float r = C.hw;
    float qx = clampf(lx, -Q.hw, Q.hw), qy = clampf(ly, -Q.hh, Q.hh);
    float ex = lx - qx, ey = ly - qy;
    float d2 = ex * ex + ey * ey;
    float lnx, lny, sep;
    if (d2 > 1e-10f) {
        if (d2 >= r * r) return 0;
        float d = sqrtf(d2);
        lnx = ex / d; lny = ey / d;
        sep = d - r;
    } else {
        // centro dentro da caixa: sai pela face mais proxima
        float ox = Q.hw - absf(lx), oy = Q.hh - absf(ly);
        if (ox < oy) { lnx = lx < 0 ? -1.0f : 1.0f; lny = 0; qx = lnx * Q.hw; sep = -ox - r; }
        else { lnx = 0; lny = ly < 0 ? -1.0f : 1.0f; qy = lny * Q.hh; sep = -oy - r; }
    }
    *nx = Q.c * lnx - Q.s * lny;
    *ny = Q.s * lnx + Q.c * lny;
    cs[0].sep = sep;
    cs[0].px = Q.x + Q.c * qx - Q.s * qy;
    cs[0].py = Q.y + Q.s * qx + Q.c * qy;
    cs[0].fid = 1;
    return 1;
}

// ------------------------------------------------------------- solver -----

inline float boundR(const Body& b) { return b.br; }

// busca o arbitro do par (a < b) no array ORDENADO por (a, b) — a fase
// larga so chama o narrow com i < j do duplo laco ordenado, entao a chave
// do par e' canonica. Devolve o indice, ou ~(ponto de insercao) quando nao
// existe (molde do lower_bound); quem cria insere ja no lugar (narrow).
// Antes era varredura linear por par colidente por sub-passo (~1M+ de
// comparacoes por quadro em cena densa)
inline int findArb(World* w, int a, int b) {
    int lo = 0, hi = w->nArb;
    while (lo < hi) {
        int mid = (lo + hi) >> 1;
        const Arbiter& ar = w->arb[mid];
        if (ar.a < a || (ar.a == a && ar.b < b)) lo = mid + 1;
        else hi = mid;
    }
    if (lo < w->nArb && w->arb[lo].a == a && w->arb[lo].b == b) return lo;
    return ~lo;
}

// Invariante do array de arbitros (sempre compilado, custo zero se nao
// chamado): estritamente ordenado por (a, b) com a < b, sem duplicata, todo
// par aponta pra corpo vivo com indice valido e a marca d'agua no teto. O
// teste host (martelo) confere apos CADA step de sequencias adversarias —
// findArb e a insercao ordenada do narrow() dependem disso
inline bool arbOk(const World* w) {
    if (w->nArb < 0 || w->nArb > kMaxArbiters) return false;
    for (int k = 0; k < w->nArb; k++) {
        const Arbiter& ar = w->arb[k];
        if (ar.a < 0 || ar.b < 0 || ar.a >= ar.b || ar.a >= w->nBodies || ar.b >= w->nBodies) return false;
        if (!w->bodies[ar.a].alive || !w->bodies[ar.b].alive) return false;
        if (ar.n == 0 || ar.n > 2) return false;
        if (k > 0) {
            const Arbiter& pv = w->arb[k - 1];
            if (pv.a > ar.a || (pv.a == ar.a && pv.b >= ar.b)) return false;
        }
    }
    return true;
}

// colide o par (a < b) e atualiza/cria o arbitro com warm start
inline void narrow(World* w, int ia, int ib) {
    Body& A = w->bodies[ia];
    Body& B = w->bodies[ib];
    Contact cs[2];
    float nx = 0, ny = 0;
    int n;
    if (A.shape == BOX && B.shape == BOX) {
        n = collideBoxes(A, B, cs, &nx, &ny);
    } else if (A.shape == CIRCLE && B.shape == CIRCLE) {
        n = collideCircles(A, B, cs, &nx, &ny);
    } else if (A.shape == BOX) {
        n = collideBoxCircle(A, B, cs, &nx, &ny);
    } else {
        n = collideBoxCircle(B, A, cs, &nx, &ny);
        nx = -nx; ny = -ny;      // normal sempre de A para B
    }
    if (n == 0) return;          // arbitro velho (se existe) morre no fim do sub-passo
    int k = findArb(w, ia, ib);  // so pares com contato pagam a busca
    if (k < 0) {
        if (w->nArb >= kMaxArbiters) return;
        k = ~k;                  // entra ja na posicao ordenada: a ordem e
                                 // invariante dos arbitros (busca binaria)
        if (k < w->nArb) memmove(&w->arb[k + 1], &w->arb[k], sizeof(Arbiter) * (size_t)(w->nArb - k));
        w->nArb++;
        Arbiter& nw = w->arb[k];
        nw.a = (int16_t)ia; nw.b = (int16_t)ib; nw.n = 0;
    }
    Arbiter& ar = w->arb[k];
    for (int i = 0; i < n; i++) {
        cs[i].pn = 0; cs[i].pt = 0;
        for (int j = 0; j < ar.n; j++) {
            if (ar.c[j].fid == cs[i].fid) {
                cs[i].pn = ar.c[j].pn;
                cs[i].pt = ar.c[j].pt;
                break;
            }
        }
    }
    ar.n = (uint8_t)n;
    ar.c[0] = cs[0];
    if (n > 1) ar.c[1] = cs[1];
    ar.nx = nx; ar.ny = ny;
    ar.mu = sqrtf(A.mu * B.mu);
    ar.e = A.e > B.e ? A.e : B.e;
    ar.live = 1;
}

// corpo que participa da resolucao como movel (acordado e dinamico)
inline bool moving(const Body& b) { return b.invM > 0 && b.awake; }

// rapidez do ponto mais rapido do corpo (translacao + giro na borda)
inline float speedOf(const Body& b) {
    return sqrtf(b.vx * b.vx + b.vy * b.vy) + absf(b.w) * boundR(b);
}

inline void subStep(World* w, float dt, float gx, float gy) {
    const float invDt = 1.0f / dt;
    // cache de rotacao + integracao das forcas
    for (int i = 0; i < w->nBodies; i++) {
        Body& b = w->bodies[i];
        if (!b.alive) continue;
        // so quem girou paga cos/sin (libm em software no S3; estatico e
        // dormindo — a maior parte do castelo — nunca mudam o angulo)
        if (b.a != b.ca) { b.c = cosf(b.a); b.s = sinf(b.a); b.ca = b.a; }
        if (!moving(b)) continue;
        // rolamento: o atrito do contato amarra v a w — frear w freia a bola
        if (b.shape == CIRCLE && b.touch) b.w *= 1.0f / (1.0f + dt * kRollDamp);
        b.touch = 0;
        b.vx += gx * dt;
        b.vy += gy * dt;
        float ld = 1.0f / (1.0f + dt * kLinDamp), ad = 1.0f / (1.0f + dt * kAngDamp);
        b.vx *= ld; b.vy *= ld; b.w *= ad;
    }
    // fase larga: n^2 em AABB por raio envolvente (corpos de jogo ~40)
    for (int k = 0; k < w->nArb; k++) w->arb[k].live = 0;
    for (int i = 0; i < w->nBodies; i++) {
        Body& A = w->bodies[i];
        if (!A.alive) continue;
        float ra = boundR(A);
        for (int j = i + 1; j < w->nBodies; j++) {
            Body& B = w->bodies[j];
            if (!B.alive) continue;
            if (!moving(A) && !moving(B)) continue;
            float rb = boundR(B) + ra;
            float dx = B.x - A.x, dy = B.y - A.y;
            if (absf(dx) > rb || absf(dy) > rb) continue;
            if (dx * dx + dy * dy > rb * rb) continue;
            narrow(w, i, j);
        }
    }
    // arbitros sem contato neste sub-passo saem (compactacao preserva a
    // ordem: o array e ordenado por par — ver findArb)
    int keep = 0;
    for (int k = 0; k < w->nArb; k++) {
        if (!w->arb[k].live) continue;
        if (keep != k) w->arb[keep] = w->arb[k];
        keep++;
    }
    w->nArb = keep;

    // pre-step: massas efetivas, vies, impacto, acordar, warm start
    for (int k = 0; k < w->nArb; k++) {
        Arbiter& ar = w->arb[k];
        Body& A = w->bodies[ar.a];
        Body& B = w->bodies[ar.b];
        A.touch = 1; B.touch = 1;
        // quem dorme encostado em corpo acordado que se mexe de verdade
        // (chegando, escorregando ou rolando por cima) acorda
        if (A.invM > 0 && !A.awake && moving(B) && speedOf(B) > kWakeVel) { A.awake = 1; A.sleepT = 0; }
        if (B.invM > 0 && !B.awake && moving(A) && speedOf(A) > kWakeVel) { B.awake = 1; B.sleepT = 0; }
        float imA = moving(A) ? A.invM : 0, iiA = moving(A) ? A.invI : 0;
        float imB = moving(B) ? B.invM : 0, iiB = moving(B) ? B.invI : 0;
        float nx = ar.nx, ny = ar.ny, tx = ny, ty = -nx;
        for (int i = 0; i < ar.n; i++) {
            Contact& c = ar.c[i];
            c.r1x = c.px - A.x; c.r1y = c.py - A.y;
            c.r2x = c.px - B.x; c.r2y = c.py - B.y;
            float rn1 = c.r1x * nx + c.r1y * ny, rn2 = c.r2x * nx + c.r2y * ny;
            float kN = imA + imB + iiA * (c.r1x * c.r1x + c.r1y * c.r1y - rn1 * rn1)
                                 + iiB * (c.r2x * c.r2x + c.r2y * c.r2y - rn2 * rn2);
            c.mN = kN > 0 ? 1.0f / kN : 0;
            float rt1 = c.r1x * tx + c.r1y * ty, rt2 = c.r2x * tx + c.r2y * ty;
            float kT = imA + imB + iiA * (c.r1x * c.r1x + c.r1y * c.r1y - rt1 * rt1)
                                 + iiB * (c.r2x * c.r2x + c.r2y * c.r2y - rt2 * rt2);
            c.mT = kT > 0 ? 1.0f / kT : 0;
            // velocidade relativa no ponto (B - A)
            float dvx = B.vx - B.w * c.r2y - A.vx + A.w * c.r1y;
            float dvy = B.vy + B.w * c.r2x - A.vy - A.w * c.r1x;
            float vn = dvx * nx + dvy * ny;
            // split impulse: a penetracao sai por pseudo-velocidade (so mexe
            // na posicao); a velocidade real so ganha a restituicao — o
            // vies de Baumgarte na velocidade fazia pilhas tremerem sem dormir
            float pen = c.sep + kSlop;
            c.pbias = pen < 0 ? -kBiasFactor * invDt * pen : 0;
            c.pb = 0;
            // Restituicao so em contato FRESCO (pn carregado = 0): quicar e'
            // evento do primeiro sub-passo do contato. Repetir o alvo em
            // contato persistente e' bomba de energia quando um corpo leve
            // fica preso entre um pesado e um estatico — o alvo e' relativo
            // a vn ATUAL, que ja embute o quique anterior, e cresce (1+e)
            // por ciclo: probe com razao de massa 75x ejectou o corpo a
            // 6369 u/s e o anti-tunel (teto do maxSub) deixou atravessar o
            // chao. O teto kMaxBounce e' a segunda valvula do mesmo probe
            // (razao 37500x): quique legitimo de jogo nao chega perto dele
            // (queda de tela inteira a e=0.6 da ~300)
            c.vbias = (vn < -kBounceMin && ar.e > 0 && c.pn == 0) ? clampf(-ar.e * vn, 0, kMaxBounce) : 0;
            if (vn < -kBounceMin) {
                // impacto: impulso p/ zerar a aproximacao (massa efetiva
                // CHEIA, mesmo contra quem dorme — o dano nao some). O portao
                // e' o mesmo do quique: abaixo de kBounceMin e' assentamento
                // (contato em repouso chega com g*dt por sub-passo e o hit
                // gravava o "peso" do corpo TODO step — pilha parada
                // reportava impulso de impacto)
                float kf = A.invM + B.invM + A.invI * (c.r1x * c.r1x + c.r1y * c.r1y - rn1 * rn1)
                                           + B.invI * (c.r2x * c.r2x + c.r2y * c.r2y - rn2 * rn2);
                float imp = kf > 0 ? -vn / kf : 0;
                if (imp > A.hit) A.hit = imp;
                if (imp > B.hit) B.hit = imp;
            }
            // warm start
            float Px = c.pn * nx + c.pt * tx, Py = c.pn * ny + c.pt * ty;
            A.vx -= imA * Px; A.vy -= imA * Py;
            A.w -= iiA * (c.r1x * Py - c.r1y * Px);
            B.vx += imB * Px; B.vy += imB * Py;
            B.w += iiB * (c.r2x * Py - c.r2y * Px);
        }
    }

    // impulsos sequenciais
    for (int it = 0; it < w->iterations; it++) {
        for (int k = 0; k < w->nArb; k++) {
            Arbiter& ar = w->arb[k];
            Body& A = w->bodies[ar.a];
            Body& B = w->bodies[ar.b];
            float imA = moving(A) ? A.invM : 0, iiA = moving(A) ? A.invI : 0;
            float imB = moving(B) ? B.invM : 0, iiB = moving(B) ? B.invI : 0;
            if (imA == 0 && imB == 0) continue;
            float nx = ar.nx, ny = ar.ny, tx = ny, ty = -nx;
            for (int i = 0; i < ar.n; i++) {
                Contact& c = ar.c[i];
                float dvx = B.vx - B.w * c.r2y - A.vx + A.w * c.r1y;
                float dvy = B.vy + B.w * c.r2x - A.vy - A.w * c.r1x;
                float vn = dvx * nx + dvy * ny;
                float dPn = c.mN * (-vn + c.vbias);
                float pn0 = c.pn;
                c.pn = pn0 + dPn > 0 ? pn0 + dPn : 0;
                dPn = c.pn - pn0;
                float Px = dPn * nx, Py = dPn * ny;
                A.vx -= imA * Px; A.vy -= imA * Py;
                A.w -= iiA * (c.r1x * Py - c.r1y * Px);
                B.vx += imB * Px; B.vy += imB * Py;
                B.w += iiB * (c.r2x * Py - c.r2y * Px);

                dvx = B.vx - B.w * c.r2y - A.vx + A.w * c.r1y;
                dvy = B.vy + B.w * c.r2x - A.vy - A.w * c.r1x;
                float vt = dvx * tx + dvy * ty;
                float dPt = c.mT * (-vt);
                float maxPt = ar.mu * c.pn;
                float pt0 = c.pt;
                c.pt = clampf(pt0 + dPt, -maxPt, maxPt);
                dPt = c.pt - pt0;
                Px = dPt * tx; Py = dPt * ty;
                A.vx -= imA * Px; A.vy -= imA * Py;
                A.w -= iiA * (c.r1x * Py - c.r1y * Px);
                B.vx += imB * Px; B.vy += imB * Py;
                B.w += iiB * (c.r2x * Py - c.r2y * Px);
            }
        }
    }

    // correcao de penetracao em pseudo-velocidade (nao vira energia)
    for (int it = 0; it < w->iterations; it++) {
        for (int k = 0; k < w->nArb; k++) {
            Arbiter& ar = w->arb[k];
            Body& A = w->bodies[ar.a];
            Body& B = w->bodies[ar.b];
            float imA = moving(A) ? A.invM : 0, iiA = moving(A) ? A.invI : 0;
            float imB = moving(B) ? B.invM : 0, iiB = moving(B) ? B.invI : 0;
            if (imA == 0 && imB == 0) continue;
            float nx = ar.nx, ny = ar.ny;
            for (int i = 0; i < ar.n; i++) {
                Contact& c = ar.c[i];
                if (c.pbias <= 0 && c.pb <= 0) continue;
                float dvx = B.bvx - B.bw * c.r2y - A.bvx + A.bw * c.r1y;
                float dvy = B.bvy + B.bw * c.r2x - A.bvy - A.bw * c.r1x;
                float vn = dvx * nx + dvy * ny;
                float d = c.mN * (-vn + c.pbias);
                float p0 = c.pb;
                c.pb = p0 + d > 0 ? p0 + d : 0;
                d = c.pb - p0;
                float Px = d * nx, Py = d * ny;
                A.bvx -= imA * Px; A.bvy -= imA * Py;
                A.bw -= iiA * (c.r1x * Py - c.r1y * Px);
                B.bvx += imB * Px; B.bvy += imB * Py;
                B.bw += iiB * (c.r2x * Py - c.r2y * Px);
            }
        }
    }

    // integra posicao + sono
    for (int i = 0; i < w->nBodies; i++) {
        Body& b = w->bodies[i];
        if (!b.alive) continue;
        float bvx = b.bvx, bvy = b.bvy, bw = b.bw;
        b.bvx = b.bvy = b.bw = 0;
        if (!moving(b)) continue;
        b.x += (b.vx + bvx) * dt;
        b.y += (b.vy + bvy) * dt;
        b.a += (b.w + bw) * dt;
        // sono por DERIVA, nao por velocidade instantanea: pilha precaria
        // treme alguns u/s sem sair do lugar — se em kSleepTime o corpo nao
        // saiu da ancora, ele dorme
        if (speedOf(b) < kSleepLin && absf(b.x - b.sx) < kSleepDrift &&
            absf(b.y - b.sy) < kSleepDrift && absf(b.a - b.sa) < kSleepTurn) {
            b.sleepT += dt;
            if (b.sleepT >= kSleepTime) {
                b.awake = 0;
                b.vx = b.vy = b.w = 0;
            }
        } else {
            b.sleepT = 0;
            b.sx = b.x; b.sy = b.y; b.sa = b.a;
        }
    }
}

/// Um step do app (dt em segundos): escolhe os sub-passos para que nenhum
/// corpo ande mais que 40% da menor meia-espessura por sub-passo. Devolve
/// quantos sub-passos rodou.
inline int step(World* w, float dt, float gx, float gy, int maxSub) {
    // dt denormal (1e-45 passa no dt > 0): sdt subnormal e invDt = inf —
    // pbias vira inf, bvx inf e a posicao NaN (probe). Step menor que um
    // microssegundo nao move nada mesmo: descarta
    if (!(dt >= 1e-6f)) return 0;
    // NaN tambem cai aqui (comparacao falsa) — igual dt <= 0
    if (!(maxSub >= 1)) maxSub = 1;
    if (maxSub > kMaxSub) maxSub = kMaxSub;
    // gravidade nao-finita vinda de conta errada do app envenenaria v de
    // todo corpo: ignora (0 = sem gravidade neste eixo)
    if (!finf(gx)) gx = 0;
    if (!finf(gy)) gy = 0;
    float minHalf = 1e9f, maxDisp = 0;
    for (int i = 0; i < w->nBodies; i++) {
        Body& b = w->bodies[i];
        if (!b.alive) continue;
        b.hit = 0;
        float h = b.hw < b.hh ? b.hw : b.hh;
        if (h < minHalf) minHalf = h;
        if (!moving(b)) continue;
        // ponta do corpo girando conta junto
        float sp = speedOf(b);
        if (sp * dt > maxDisp) maxDisp = sp * dt;
    }
    if (minHalf > 1e8f) return 0;
    // piso: sub-passo nunca maior que kMaxSubDt (pilha estavel pede ~120 Hz).
    // Razao gigante (dt ou velocidade absurda) e' tolhida no 64 antes do
    // cast: converter float maior que INT_MAX para int e' UB e o resultado
    // cai no clamp do maxSub de qualquer forma (maxSub <= kMaxSub = 16)
    float base = dt / kMaxSubDt;
    int sub = base > 64.0f ? 64 : (int)ceilf(base - 0.001f);
    if (sub < 1) sub = 1;
    float lim = minHalf * 0.4f;
    if (maxDisp > lim * sub) {
        float need = maxDisp / lim;
        sub = need > 64.0f ? 64 : (int)ceilf(need);
    }
    if (sub > maxSub) sub = maxSub;
    float sdt = dt / sub;
    for (int s = 0; s < sub; s++) subStep(w, sdt, gx, gy);
    return sub;
}

inline bool setBody(World* w, int i, float x, float y, float a, float vx, float vy, float av) {
    if (i < 0 || i >= w->nBodies || !w->bodies[i].alive) return false;
    // teleporte com NaN/infinito (conta errada no app) e' recusado INTEIRO,
    // antes de acordar vizinho ou mexer em qualquer campo
    if (!finf(x) || !finf(y) || !finf(a) || !finf(vx) || !finf(vy) || !finf(av)) return false;
    Body& b = w->bodies[i];
    // acordar quem encostava no ANTIGO lugar do corpo (posicao ainda nao
    // trocada): o que estava em cima precisa cair. Nao da para acordar so
    // os parceiros de arbitro — pilha dormida nao tem arbitro nenhum (a
    // fase larga pula par todo dormindo e o contato morre na compactacao),
    // entao o vizinho e' achado por proximidade (circulo envolvente, a
    // mesma metrica da fase larga). Mais preciso que o wakeAll do
    // removeBody: setBody roda a cada quadro de arrasto e acordar o mundo
    // inteiro toda vez acabaria com o sono
    float ra = boundR(b);
    for (int k = 0; k < w->nBodies; k++) {
        Body& o = w->bodies[k];
        if (k == i || !o.alive || o.invM <= 0) continue;
        float rb = ra + boundR(o);
        float dx = o.x - b.x, dy = o.y - b.y;
        if (dx * dx + dy * dy <= rb * rb) { o.awake = 1; o.sleepT = 0; }
    }
    b.x = x; b.y = y; b.a = a;
    b.vx = vx; b.vy = vy; b.w = av;
    b.awake = 1; b.sleepT = 0;
    // contatos guardados ficaram velhos (teleporte)
    int j = 0;
    for (int k = 0; k < w->nArb; k++) {
        if (w->arb[k].a == i || w->arb[k].b == i) continue;
        if (j != k) w->arb[j] = w->arb[k];
        j++;
    }
    w->nArb = j;
    return true;
}

inline bool impulse(World* w, int i, float jx, float jy) {
    if (i < 0 || i >= w->nBodies || !w->bodies[i].alive) return false;
    Body& b = w->bodies[i];
    if (b.invM <= 0) return false;
    if (!finf(jx) || !finf(jy)) return false;   // impulso NaN envenenaria v
    b.vx += jx * b.invM;
    b.vy += jy * b.invM;
    b.awake = 1; b.sleepT = 0;
    return true;
}

}  // namespace rigid
}  // namespace celer
