// Verlet nativo (API 31): o step pesado do P.verlet — integracao,
// relaxacao de vinculos e bounds com bounce — em C++ float (FPU single do
// S3; double e soft-fp e custa 5-10x). O JS cria/pinta por indice: os
// pontos NAO vivem no heap Duktape, o mundo inteiro e um buffer nativo
// malloc'ado sob demanda (PSRAM nas placas que tem, RAM interna senao).
//
// Por que so o verlet e nativo: e dado homogeneu sem callbacks — o P.world
// dispara onCollide por par e cada volta ao JS comeria o ganho da
// fronteira. O caminho JS da dep continua valendo (feature-detect): a
// celeros.physics expoe P.verletFast, que cai para o P.verlet interpretado
// em firmware sem este binding.
//
// Estado por app: os mundos saem no JSBindings::init do proximo app
// (jsPhysicsReset) — o app nunca ve mundo de outro, e o malloc nao vaza
// entre execucoes. Sem finalizer: um app usa 1-2 mundos pela vida inteira.
//
// O motor puro (pontos, vinculos, colisao, bounds) vive no
// Utils/Verlet2D.h — o teste host roda o MESMO codigo (molde do Rigid2D.h);
// aqui ficam os mundos por app e os bindings.

#include "JsInternal.h"
#include "../Kernel/Core/CelerKernel.h"
#include "../Utils/Verlet2D.h"
#include "../Utils/Mem.h"
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include "esp_heap_caps.h"

namespace {

using celer::verlet::kMaxPoints;
using celer::verlet::kMaxSticks;
using celer::verlet::kLinkBytes;
using celer::verlet::VerletPoint;
using celer::verlet::VerletStick;
using celer::verlet::VWorld;
using celer::verlet::linkSet;
using celer::verlet::stepWorld;
using celer::verlet::relinkAll;
using celer::verlet::delStick;

constexpr int kMaxWorlds = 4;

VWorld* s_worlds[kMaxWorlds] = { nullptr, nullptr, nullptr, nullptr };

VWorld* worldAt(int id) {
    if (id < 1 || id > kMaxWorlds) return nullptr;
    return s_worlds[id - 1];
}

// numero opcional (lightfunc: pilha sempre tem nargs entradas, faltante =
// undefined — duk_get_number viraria NaN e envenenaria o mundo inteiro)
float numOr(duk_context* ctx, int idx, float def) {
    return duk_is_number(ctx, idx) ? (float)duk_get_number(ctx, idx) : def;
}

// Teto de magnitude de um parametro do step: finito-porem-absurdo (1e29)
// passa no vfin do motor, mas gx*dt2 / damp*velocidade estouram float para
// infinito na primeira conta e o mundo inteiro vira NaN no passo seguinte.
// A faixa (1e6) cobre qualquer jogo no espaco 240x320 com folga.
float clampMag(float v, float lim, float bad) {
    if (!celer::verlet::vfin(v)) return bad;
    if (v > lim) return lim;
    if (v < -lim) return -lim;
    return v;
}

}  // namespace

void jsPhysicsReset() {
    // JSBindings::init do proximo app: mundos do anterior saem (malloc
    // incluso). Roda tambem no boot — s_worlds ja nasce zero.
    for (int i = 0; i < kMaxWorlds; i++) {
        if (s_worlds[i]) {
            free(s_worlds[i]);
            s_worlds[i] = nullptr;
        }
    }
}

duk_ret_t JSBindings::js_verletNew(duk_context* ctx) {
    int iters = duk_is_number(ctx, 0) ? duk_get_int(ctx, 0) : 4;
    if (iters < 1) iters = 1;
    if (iters > 16) iters = 16;
    // radius > 0 liga a colisao ponto-ponto (raio de cada no); NaN vira 0
    // (sem colisao), igual ao negativo
    float radius = duk_is_number(ctx, 1) ? (float)duk_get_number(ctx, 1) : 0.0f;
    if (!(radius > 0.0f) || !celer::verlet::vfin(radius)) radius = 0.0f;
    for (int i = 0; i < kMaxWorlds; i++) {
        if (s_worlds[i]) continue;
        // PSRAM primeiro (os jogos de fisica sao as placas S3); sem ela o
        // mundo vive na RAM interna — ~18KB cabem no Physics Drop sem PSRAM
        void* worldMem = mem::alloc(sizeof(VWorld) + kLinkBytes, mem::Want::Psram);
        if (!worldMem) { duk_push_int(ctx, -1); return 1; }
        memset(worldMem, 0, sizeof(VWorld) + kLinkBytes);
        VWorld* w = (VWorld*)worldMem;
        w->iterations = iters;
        w->radius = radius;
        w->linked = (uint8_t*)worldMem + sizeof(VWorld);
        s_worlds[i] = w;
        duk_push_int(ctx, i + 1);
        return 1;
    }
    duk_push_int(ctx, -1);
    return 1;
}

duk_ret_t JSBindings::js_verletFree(duk_context* ctx) {
    VWorld* w = worldAt(duk_require_int(ctx, 0));
    if (!w) return 0;
    for (int i = 0; i < kMaxWorlds; i++) {
        if (s_worlds[i] == w) s_worlds[i] = nullptr;
    }
    free(w);
    return 0;
}

duk_ret_t JSBindings::js_verletAddPoint(duk_context* ctx) {
    VWorld* w = worldAt(duk_require_int(ctx, 0));
    float x = (float)duk_require_number(ctx, 1);
    float y = (float)duk_require_number(ctx, 2);
    // NaN/inf nao entra: um ponto assim envenenaria px/py do mundo (o x do
    // vizinho menos inf e' NaN na relaxacao de vinculos)
    if (!w || w->nPts >= kMaxPoints || !celer::verlet::vfin(x) || !celer::verlet::vfin(y)) {
        duk_push_int(ctx, -1);
        return 1;
    }
    VerletPoint& p = w->pts[w->nPts];
    p.x = p.px = x;
    p.y = p.py = y;
    p.pin = false;
    duk_push_int(ctx, w->nPts++);
    return 1;
}

duk_ret_t JSBindings::js_verletStick(duk_context* ctx) {
    VWorld* w = worldAt(duk_require_int(ctx, 0));
    int a = duk_require_int(ctx, 1);
    int b = duk_require_int(ctx, 2);
    if (!w || a < 0 || b < 0 || a >= w->nPts || b >= w->nPts || w->nSticks >= kMaxSticks) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
    VerletStick& s = w->sticks[w->nSticks++];
    s.a = (int16_t)a;
    s.b = (int16_t)b;
    if (duk_is_number(ctx, 3)) {
        float len = (float)duk_get_number(ctx, 3);
        if (!celer::verlet::vfin(len) || len < 0.0f) {
            // comprimento NaN/negativo: o vinculo nasceria quebrado (f na
            // relaxacao e' (d - len)/d) — recusa em vez de criar lixo
            w->nSticks--;
            duk_push_boolean(ctx, 0);
            return 1;
        }
        s.len = len;
    } else {
        float dx = w->pts[b].x - w->pts[a].x, dy = w->pts[b].y - w->pts[a].y;
        s.len = sqrtf(dx * dx + dy * dy);
    }
    linkSet(w, a, b);
    linkSet(w, b, a);
    duk_push_boolean(ctx, 1);
    return 1;
}

duk_ret_t JSBindings::js_verletPin(duk_context* ctx) {
    VWorld* w = worldAt(duk_require_int(ctx, 0));
    int idx = duk_require_int(ctx, 1);
    bool on = !duk_is_boolean(ctx, 2) || duk_get_boolean(ctx, 2);
    if (!w || idx < 0 || idx >= w->nPts) { duk_push_boolean(ctx, 0); return 1; }
    w->pts[idx].pin = on;
    duk_push_boolean(ctx, 1);
    return 1;
}

duk_ret_t JSBindings::js_verletSet(duk_context* ctx) {
    // move um ponto (o dedo puxando): NAO toca em px/py — a velocidade
    // implicita nasce na diferenca, igual ao caminho JS
    VWorld* w = worldAt(duk_require_int(ctx, 0));
    int idx = duk_require_int(ctx, 1);
    float x = (float)duk_require_number(ctx, 2);
    float y = (float)duk_require_number(ctx, 3);
    // teleporte NaN envenenaria o ponto (e os vinculos dele na relaxacao)
    if (!w || idx < 0 || idx >= w->nPts || !celer::verlet::vfin(x) || !celer::verlet::vfin(y)) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
    w->pts[idx].x = x;
    w->pts[idx].y = y;
    duk_push_boolean(ctx, 1);
    return 1;
}

duk_ret_t JSBindings::js_verletStep(duk_context* ctx) {
    VWorld* w = worldAt(duk_require_int(ctx, 0));
    if (!w) { duk_push_boolean(ctx, 0); return 1; }
    float dt = (float)duk_require_number(ctx, 1);
    // opcionais via numOr: undefined virava NaN pelo duk_get_number e
    // envenenava posicao/bounds do mundo inteiro (mesmo padrao do JsRigid)
    float gx = numOr(ctx, 2, 0);
    float gy = numOr(ctx, 3, 0);
    float damp = numOr(ctx, 4, 1.0f);
    float minx = numOr(ctx, 5, 0);
    float miny = numOr(ctx, 6, 0);
    float maxx = numOr(ctx, 7, 0);
    float maxy = numOr(ctx, 8, 0);
    float bounce = numOr(ctx, 9, 0.5f);
    // dt absurdo (finito, mas 1e30) estoura dt2 no motor: passo de 1 s e o
    // teto plausivel (o normal e 1/60). dt <= 0 e NaN seguem recusados pelo
    // stepWorld (devolve false, mundo intocado).
    if (celer::verlet::vfin(dt) && dt > 1.0f) dt = 1.0f;
    gx = clampMag(gx, 1e6f, 0);
    gy = clampMag(gy, 1e6f, 0);
    // damp negativo e amplificacao por quadro (bomba de energia) e NaN vira
    // o default do motor: nunca maior que 10x por passo
    damp = clampMag(damp, 10.0f, 1.0f);
    if (damp < 0.0f) damp = 1.0f;
    bounce = clampMag(bounce, 10.0f, 0);
    // bounds NaN/inf ja desligam a caixa sozinhos (comparacoes falsas)
    CelerKernel::noteAppYield();  // step pesado renova o exec-timeout (padrao 4b5b9ce)
    // devolve se o passo RODOU: dt NaN/infinito/<= 0 e' recusado dentro do
    // stepWorld (mundo intocado) em vez de envenenar posicoes
    duk_push_boolean(ctx, stepWorld(w, dt, gx, gy, damp, minx, miny, maxx, maxy, bounce));
    return 1;
}

duk_ret_t JSBindings::js_verletXY(duk_context* ctx) {
    // array plano [x0, y0, x1, y1, ...] — UMA alocacao por frame; o desenho
    // do app itera sobre numeros puros (leitura de array JS e rapida)
    VWorld* w = worldAt(duk_require_int(ctx, 0));
    int n = w ? w->nPts : 0;
    duk_push_array(ctx);
    for (int i = 0; i < n; i++) {
        duk_push_number(ctx, w->pts[i].x);
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)(i * 2));
        duk_push_number(ctx, w->pts[i].y);
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)(i * 2 + 1));
    }
    return 1;
}

duk_ret_t JSBindings::js_verletSticks(duk_context* ctx) {
    // array plano [a0, b0, a1, b1, ...] — indices dos pontos de cada vinculo
    VWorld* w = worldAt(duk_require_int(ctx, 0));
    int n = w ? w->nSticks : 0;
    duk_push_array(ctx);
    for (int i = 0; i < n; i++) {
        duk_push_int(ctx, w->sticks[i].a);
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)(i * 2));
        duk_push_int(ctx, w->sticks[i].b);
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)(i * 2 + 1));
    }
    return 1;
}

duk_ret_t JSBindings::js_verletCount(duk_context* ctx) {
    VWorld* w = worldAt(duk_require_int(ctx, 0));
    duk_push_int(ctx, w ? w->nPts : 0);
    return 1;
}

duk_ret_t JSBindings::js_verletDelStick(duk_context* ctx) {
    // swap-remove do vinculo i — o contrato de indices (o ultimo entra no
    // lugar, corte do maior para o menor) e a manutencao da bitmask de
    // vinculados (relinkAll) vivem no delStick do Utils/Verlet2D.h
    VWorld* w = worldAt(duk_require_int(ctx, 0));
    duk_push_boolean(ctx, delStick(w, duk_require_int(ctx, 1)));
    return 1;
}

duk_ret_t JSBindings::js_verletDelPoint(duk_context* ctx) {
    // remove o ponto idx: vinculos ligados a ele saem, o ULTIMO ponto entra
    // no lugar (indices > idx descem 1 — chame do maior para o menor) e a
    // bitmask de pares e' recompute em O(sticks).
    VWorld* w = worldAt(duk_require_int(ctx, 0));
    int idx = duk_require_int(ctx, 1);
    if (!w || idx < 0 || idx >= w->nPts) { duk_push_boolean(ctx, 0); return 1; }
    int last = w->nPts - 1;
    int j = 0;
    for (int i = 0; i < w->nSticks; i++) {
        const VerletStick& s = w->sticks[i];
        if (s.a == idx || s.b == idx) continue;
        VerletStick& keep = w->sticks[j++];
        keep = s;
        if (s.a == last) keep.a = (int16_t)idx;
        if (s.b == last) keep.b = (int16_t)idx;
    }
    w->nSticks = j;
    if (idx != last) w->pts[idx] = w->pts[last];
    w->nPts = last;
    relinkAll(w);
    duk_push_boolean(ctx, 1);
    return 1;
}

duk_ret_t JSBindings::js_verletPins(duk_context* ctx) {
    // estado dos pinos por ponto (0/1) — para destacar e alternar no app
    VWorld* w = worldAt(duk_require_int(ctx, 0));
    int n = w ? w->nPts : 0;
    duk_push_array(ctx);
    for (int i = 0; i < n; i++) {
        duk_push_int(ctx, w->pts[i].pin ? 1 : 0);
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)i);
    }
    return 1;
}
