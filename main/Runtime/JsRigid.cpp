// Corpo rigido nativo (API 33): caixas orientadas e circulos com impulsos
// sequenciais, atrito, restituicao, sono e sub-passos anti-tunel — o
// solver e o header puro Utils/Rigid2D.h (o teste host roda o MESMO
// codigo). O JS cria por indice e le o estado num array plano por quadro:
// nada de objeto por corpo no heap Duktape.
//
// Por que nativo: empilhar caixas que giram pede ~10 iteracoes de impulso
// a 120 Hz — no interpretado um castelo de 30 pecas nao fecha o quadro.
// Aqui sao ~1-2 ms no S3 (float single).
//
// Estado por app: os mundos saem no JSBindings::init do proximo app
// (jsRigidReset). Compilado so com CONFIG_CELEROS_JS_GAME_ACCEL (placas
// S3): no ESP32 classico o binding nao existe e o app faz feature-detect.

#include "JsInternal.h"
#include "../Kernel/Core/CelerKernel.h"
#include "../Utils/Rigid2D.h"
#include "../Utils/Mem.h"
#include <cstdlib>
#include "esp_heap_caps.h"

namespace {

namespace R = celer::rigid;

constexpr int kMaxWorlds = 2;
R::World* s_rworlds[kMaxWorlds] = { nullptr, nullptr };

R::World* rworldAt(int id) {
    if (id < 1 || id > kMaxWorlds) return nullptr;
    return s_rworlds[id - 1];
}

float numOr(duk_context* ctx, int idx, float def) {
    return duk_is_number(ctx, idx) ? (float)duk_get_number(ctx, idx) : def;
}

}  // namespace

void jsRigidReset() {
    for (int i = 0; i < kMaxWorlds; i++) {
        if (s_rworlds[i]) {
            free(s_rworlds[i]);
            s_rworlds[i] = nullptr;
        }
    }
}

duk_ret_t JSBindings::js_rigidNew(duk_context* ctx) {
    int iters = duk_is_number(ctx, 0) ? duk_get_int(ctx, 0) : 10;
    for (int i = 0; i < kMaxWorlds; i++) {
        if (s_rworlds[i]) continue;
        // ~60 KB por mundo: PSRAM primeiro (as placas do binding tem)
        void* worldMem = mem::alloc(sizeof(R::World), mem::Want::Psram);
        if (!worldMem) { duk_push_int(ctx, -1); return 1; }
        R::World* w = (R::World*)worldMem;
        R::worldInit(w, iters);
        s_rworlds[i] = w;
        duk_push_int(ctx, i + 1);
        return 1;
    }
    duk_push_int(ctx, -1);
    return 1;
}

duk_ret_t JSBindings::js_rigidFree(duk_context* ctx) {
    int id = duk_require_int(ctx, 0);
    R::World* w = rworldAt(id);
    if (!w) return 0;
    s_rworlds[id - 1] = nullptr;
    free(w);
    return 0;
}

duk_ret_t JSBindings::js_rigidBox(duk_context* ctx) {
    // (id, x, y, w, h, angulo, densidade, atrito, quique); densidade 0 = estatico
    R::World* w = rworldAt(duk_require_int(ctx, 0));
    if (!w) { duk_push_int(ctx, -1); return 1; }
    float x = (float)duk_require_number(ctx, 1);
    float y = (float)duk_require_number(ctx, 2);
    float bw = (float)duk_require_number(ctx, 3);
    float bh = (float)duk_require_number(ctx, 4);
    int i = R::addBody(w, R::BOX, x, y, bw * 0.5f, bh * 0.5f, numOr(ctx, 5, 0),
                       numOr(ctx, 6, 1), numOr(ctx, 7, 0.6f), numOr(ctx, 8, 0.1f));
    duk_push_int(ctx, i);
    return 1;
}

duk_ret_t JSBindings::js_rigidCircle(duk_context* ctx) {
    // (id, x, y, raio, densidade, atrito, quique)
    R::World* w = rworldAt(duk_require_int(ctx, 0));
    if (!w) { duk_push_int(ctx, -1); return 1; }
    float x = (float)duk_require_number(ctx, 1);
    float y = (float)duk_require_number(ctx, 2);
    float r = (float)duk_require_number(ctx, 3);
    int i = R::addBody(w, R::CIRCLE, x, y, r, r, 0, numOr(ctx, 4, 1),
                       numOr(ctx, 5, 0.6f), numOr(ctx, 6, 0.1f));
    duk_push_int(ctx, i);
    return 1;
}

duk_ret_t JSBindings::js_rigidRemove(duk_context* ctx) {
    R::World* w = rworldAt(duk_require_int(ctx, 0));
    int i = duk_require_int(ctx, 1);
    duk_push_boolean(ctx, w && R::removeBody(w, i));
    return 1;
}

duk_ret_t JSBindings::js_rigidSet(duk_context* ctx) {
    // teleporte + velocidade (id, idx, x, y, angulo, vx, vy, w); acorda
    R::World* w = rworldAt(duk_require_int(ctx, 0));
    int i = duk_require_int(ctx, 1);
    if (!w) { duk_push_boolean(ctx, 0); return 1; }
    bool ok = R::setBody(w, i, (float)duk_require_number(ctx, 2), (float)duk_require_number(ctx, 3),
                         numOr(ctx, 4, 0), numOr(ctx, 5, 0), numOr(ctx, 6, 0), numOr(ctx, 7, 0));
    duk_push_boolean(ctx, ok);
    return 1;
}

duk_ret_t JSBindings::js_rigidImpulse(duk_context* ctx) {
    R::World* w = rworldAt(duk_require_int(ctx, 0));
    int i = duk_require_int(ctx, 1);
    bool ok = w && R::impulse(w, i, (float)duk_require_number(ctx, 2), (float)duk_require_number(ctx, 3));
    duk_push_boolean(ctx, ok);
    return 1;
}

duk_ret_t JSBindings::js_rigidStep(duk_context* ctx) {
    // (id, dt em s, gx, gy, maxSub) -> sub-passos rodados
    R::World* w = rworldAt(duk_require_int(ctx, 0));
    if (!w) { duk_push_int(ctx, 0); return 1; }
    float dt = (float)duk_require_number(ctx, 1);
    if (dt > 0.1f) dt = 0.1f;   // quadro engasgado nao vira teletransporte
    int maxSub = duk_is_number(ctx, 4) ? duk_get_int(ctx, 4) : 12;
    CelerKernel::noteAppYield();  // step pesado renova o exec-timeout (padrao 4b5b9ce)
    int n = R::step(w, dt, numOr(ctx, 2, 0), numOr(ctx, 3, 0), maxSub);
    duk_push_int(ctx, n);
    return 1;
}

duk_ret_t JSBindings::js_rigidState(duk_context* ctx) {
    // [x, y, angulo, hit, rapidez, flags] por slot; flags: 1 vivo, 2 acordado.
    // 2o arg opcional: o array do quadro anterior, preenchido NO LUGAR e
    // devolvido — um array novo de 6 x n numeros por quadro era realloc do
    // array part + lixo para o GC do Duktape. Firmware sem o arg ignora e
    // devolve um novo: quem usa o RETORNO funciona nos dois.
    R::World* w = rworldAt(duk_require_int(ctx, 0));
    int n = w ? w->nBodies : 0;
    bool reuse = duk_is_array(ctx, 1);
    if (reuse) duk_dup(ctx, 1);
    else duk_push_array(ctx);
    duk_uarridx_t k = 0;
    for (int i = 0; i < n; i++) {
        const R::Body& b = w->bodies[i];
        duk_push_number(ctx, b.x);
        duk_put_prop_index(ctx, -2, k++);
        duk_push_number(ctx, b.y);
        duk_put_prop_index(ctx, -2, k++);
        duk_push_number(ctx, b.a);
        duk_put_prop_index(ctx, -2, k++);
        duk_push_number(ctx, b.hit);
        duk_put_prop_index(ctx, -2, k++);
        duk_push_number(ctx, b.alive ? R::speedOf(b) : 0);
        duk_put_prop_index(ctx, -2, k++);
        duk_push_int(ctx, (b.alive ? 1 : 0) | (b.alive && b.awake && b.invM > 0 ? 2 : 0));
        duk_put_prop_index(ctx, -2, k++);
    }
    if (reuse) {
        // mundo encolheu (remove no fim): a cauda velha sai — slot alem da
        // marca d'agua nao pode continuar "vivo" no array
        duk_push_uint(ctx, k);
        duk_put_prop_string(ctx, -2, "length");
    }
    return 1;
}

duk_ret_t JSBindings::js_rigidCount(duk_context* ctx) {
    R::World* w = rworldAt(duk_require_int(ctx, 0));
    duk_push_int(ctx, w ? w->nBodies : 0);
    return 1;
}
