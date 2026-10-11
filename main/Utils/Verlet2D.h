#pragma once
/**
 * @file Verlet2D.h
 * @brief Motor verlet puro (pontos + vinculos, colisao ponto-ponto, bounds
 *        com rebote), header-only: o System.verlet* (API 31, JsPhysics.cpp)
 *        e o teste host usam este mesmo codigo — mesmo molde do Rigid2D.h.
 *
 * O mundo e um buffer contiguo: struct VWorld + bitmask linked (kLinkBytes
 * bytes) no MESMO malloc. O dono do malloc e o binding (JsPhysics.cpp:
 * PSRAM primeiro); aqui so a logica.
 */

#include <cmath>
#include <cstdint>
#include <cstring>

namespace celer {
namespace verlet {

constexpr int kMaxPoints = 256;
constexpr int kMaxSticks = 640;
// bitmask de pares vinculados (a*256+b): a colisao ponto-ponto nao separa
// quem ja tem um stick controlando a distancia — 8KB por mundo
constexpr int kLinkBytes = kMaxPoints * kMaxPoints / 8;

struct VerletPoint { float x, y, px, py; bool pin; };
struct VerletStick { int16_t a, b; float len; };

struct VWorld {
    int nPts, nSticks, iterations;
    float radius;        // > 0: colisao ponto-ponto com este raio
    uint8_t* linked;     // kLinkBytes (dentro do malloc do mundo)
    VerletPoint pts[kMaxPoints];
    VerletStick sticks[kMaxSticks];
};

inline void linkSet(VWorld* w, int a, int b) {
    int idx = a * kMaxPoints + b;
    w->linked[idx >> 3] |= (uint8_t)(1u << (idx & 7));
}

// numero util (rejeita NaN e infinito) — mesmo molde do finf do Rigid2D.h:
// um unico valor assim vindo de conta errada no app envenenaria px/py do
// mundo inteiro (e NaN nao e' "maior que" nas comparacoes de bounds)
inline bool vfin(float v) { return v == v && v < 1e30f && v > -1e30f; }

inline bool linked(VWorld* w, int a, int b) {
    int idx = a * kMaxPoints + b;
    return (w->linked[idx >> 3] >> (idx & 7)) & 1;
}

// recomputa a bitmask apos delPoint/delStick (indices/conjunto mudaram) —
// O(sticks), raro
inline void relinkAll(VWorld* w) {
    memset(w->linked, 0, kLinkBytes);
    for (int i = 0; i < w->nSticks; i++) {
        linkSet(w, w->sticks[i].a, w->sticks[i].b);
        linkSet(w, w->sticks[i].b, w->sticks[i].a);
    }
}

// remove o vinculo i (o ultimo entra no lugar — o JS re-le sticks() a cada
// corte, entao o indice so e' valido entre leituras; para varios cortes,
// delete do MAIOR indice para o menor). A bitmask e' recompute em
// relinkAll: sem isso o par cortado ficava marcado como vinculado PARA
// SEMPRE e parava de colidir com o proprio pedaco
inline bool delStick(VWorld* w, int i) {
    if (!w || i < 0 || i >= w->nSticks) return false;
    w->sticks[i] = w->sticks[w->nSticks - 1];
    w->nSticks--;
    relinkAll(w);
    return true;
}

/// Um step. Parametros nao-finitos (conta errada no app) nao entram:
/// gravidade/damp/bounce estranhos caem no default; bounds com NaN
/// desligam sozinhos (maxx > minx nunca e' verdadeiro). dt nao-finito ou
/// <= 0 nao tem passo — devolve false e o mundo fica intocado. damp
/// negativo e' amplificacao por quadro (bomba de energia): tambem vira 1.
inline bool stepWorld(VWorld* w, float dt, float gx, float gy, float damp,
                      float minx, float miny, float maxx, float maxy, float bounce) {
    if (!vfin(dt) || dt <= 0.0f) return false;
    if (!vfin(gx)) gx = 0;
    if (!vfin(gy)) gy = 0;
    if (!vfin(damp) || damp < 0.0f) damp = 1.0f;
    if (!vfin(bounce)) bounce = 0.5f;
    // mesma matematica do P.verlet (celeros.physics.js), em float
    const float dt2 = dt * dt;
    for (int i = 0; i < w->nPts; i++) {
        VerletPoint& p = w->pts[i];
        if (p.pin) { p.px = p.x; p.py = p.y; continue; }
        float vx = (p.x - p.px) * damp, vy = (p.y - p.py) * damp;
        p.px = p.x; p.py = p.y;
        p.x += vx + gx * dt2;
        p.y += vy + gy * dt2;
    }
    for (int k = 0; k < w->iterations; k++) {
        for (int i = 0; i < w->nSticks; i++) {
            const VerletStick& s = w->sticks[i];
            VerletPoint& A = w->pts[s.a];
            VerletPoint& B = w->pts[s.b];
            float dx = B.x - A.x, dy = B.y - A.y;
            float d = sqrtf(dx * dx + dy * dy);
            if (d < 1e-6f) continue;
            float ma = A.pin ? 0.0f : 1.0f, mb = B.pin ? 0.0f : 1.0f;
            float tot = ma + mb;
            if (tot == 0.0f) continue;
            float f = (d - s.len) / d / tot;
            A.x += dx * f * ma;
            A.y += dy * f * ma;
            B.x -= dx * f * mb;
            B.y -= dy * f * mb;
        }
    }
    // colisao ponto-ponto (radius > 0): pares NAO vinculados mais perto que
    // 2r separam metade cada (prensados nao mexem). O(n^2) em float — no
    // interpretado isso nao caberia; aqui sao ~1ms para 120 pontos
    if (w->radius > 0.0f) {
        const float rr = w->radius * 2.0f, rr2 = rr * rr;
        for (int i = 0; i < w->nPts; i++) {
            VerletPoint& A = w->pts[i];
            for (int j = i + 1; j < w->nPts; j++) {
                if (linked(w, i, j)) continue;
                VerletPoint& B = w->pts[j];
                float dx = B.x - A.x, dy = B.y - A.y;
                float d2 = dx * dx + dy * dy;
                if (d2 >= rr2 || d2 < 1e-9f) continue;
                float d = sqrtf(d2);
                float push = (rr - d) / d * 0.5f;
                float ox = dx * push, oy = dy * push;
                // px/py junto do x/y: a separacao e reposicionamento, nao
                // impulso — senao cada step injeta energia e os nos ejetam
                if (!A.pin) { A.x -= ox; A.y -= oy; A.px -= ox; A.py -= oy; }
                if (!B.pin) { B.x += ox; B.y += oy; B.px += ox; B.py += oy; }
            }
        }
    }
    // bounds opcionais (maxx > minx ativa); mesmo esquema de rebote do JS
    if (maxx > minx) {
        for (int i = 0; i < w->nPts; i++) {
            VerletPoint& p = w->pts[i];
            if (p.pin) continue;
            if (p.x < minx) { float vx = p.x - p.px; p.x = minx; p.px = p.x + vx * bounce; }
            if (p.x > maxx) { float vx = p.x - p.px; p.x = maxx; p.px = p.x + vx * bounce; }
            if (p.y < miny) { float vy = p.y - p.py; p.y = miny; p.py = p.y + vy * bounce; }
            if (p.y > maxy) { float vy = p.y - p.py; p.y = maxy; p.py = p.y + vy * bounce; }
        }
    }
    return true;
}

}  // namespace verlet
}  // namespace celer
