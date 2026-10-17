#include "JSBindings.h"
#include "JsInternal.h"
#include <Arduino.h>
#include "esp_task_wdt.h"

// =====================================================
// Timers JS (API 12): setTimeout/setInterval/clearTimeout/clearInterval
// =====================================================
//
// Sem event loop dedicado, os timers cooperam com o app: disparam no
// present() — que roda no comeco de System.delay, System.getTouch e de
// toda chamada bloqueante. Um app em loop apertado SEM ceder (sem
// delay/getTouch) nao ve os timers dispararem (e ja derruba o WDT sozinho).
//
// Erro no callback PROPAGA para o frame do app (mesma politica de erro de
// qualquer binding): o app morre com a tela de erro e a stack do callback.
// O present() e sempre a 1a linha dos bindings que o chamam, então o
// longjmp nao atravessa recurso C alocado (convencao do runtime).
//
// Estado: tabela C fixa (8 slots) + referencias das funcoes num array do
// heap stash "_tmr" (morre com o heap do app — nada atravessa apps).
//
// API 42: o host virou instancia (TimerHost) com DUAS vivas — a do app
// (como sempre) e a dos servicos em segundo plano (AppServices). Cada slot
// guarda o proprio duk_context: no svchost, um unico pool de timers atende
// todas as threads (uma por servico). O binding (js_setTimeout...) roda no
// host CORRENTE (s_cur), trocado pelo dispatch do svchost.

namespace {

struct TimerSlot {
    duk_context* ctx = nullptr;  // thread dona do callback (app = o heap do app)
    bool used = false;
    bool repeat = false;
    uint32_t period = 0;     // ms (interval) / timeout (timeout)
    uint32_t nextFire = 0;   // ms()
    int id = 0;              // handle unico do app (>= 1); slot reusado ganha id novo
};

constexpr int kTimerSlots = 8;

struct TimerHost {
    TimerSlot slots[kTimerSlots];
    bool inTick = false;   // callback chamou present(): adia o proximo disparo
    int nextId = 0;
    // svchost (API 42): identidade do DONO do slot durante o dispatch e o
    // destino do erro de callback (o ofensor para; o aparelho e os outros
    // servicos seguem). Nulos no host do app: erro propaga como sempre.
    void (*slotBegin)(duk_context* tctx) = nullptr;  // troca a identidade
    void (*slotEnd)(duk_context* tctx) = nullptr;    // restaura (+ Service.stop)
    void (*slotCrash)(duk_context* tctx, const char* err) = nullptr;  // consome
};

TimerHost s_appHost;   // o app em foreground (present())
TimerHost s_svcHost;   // servicos em segundo plano (AppServices::tick)
TimerHost* s_cur = &s_appHost;  // host que os bindings js_setTimeout... enxergam

void timerHostReset(TimerHost& h) {
    for (auto& t : h.slots) t = TimerSlot{};
    h.nextId = 0;
    h.inTick = false;
    // As referencias vivem no heap stash: morrem com o heap.
}

// Ajusta a base do array "_tmr" no heap stash (cria se 1a vez). Pilha: +1
// (o array fica no topo).
void timerStashArray(duk_context* ctx) {
    duk_push_heap_stash(ctx);
    duk_get_prop_string(ctx, -1, "_tmr");
    if (duk_is_array(ctx, -1)) {
        duk_remove(ctx, -2);  // tira o stash, fica o array
        return;
    }
    duk_pop(ctx);
    duk_push_array(ctx);
    for (int i = 0; i < kTimerSlots; i++) {
        duk_push_undefined(ctx);
        duk_put_prop_index(ctx, -2, i);
    }
    duk_put_prop_string(ctx, -2, "_tmr");
    duk_pop(ctx);              // stash
    duk_push_heap_stash(ctx);
    duk_get_prop_string(ctx, -1, "_tmr");
    duk_remove(ctx, -2);
}

}  // namespace

namespace JSBindingsTimers {
void setHost(TimerHost* h) { s_cur = h; }
}

// Chamado pelo present() (host do app) e pelo dispatch do svchost (host dos
// servicos). Pode lancar (erro do callback propagando).
void JSBindings::timersTick(duk_context* ctx) {
    TimerHost& h = *s_cur;
    if (ctx == nullptr || h.inTick) return;
    uint32_t now = millis();
    for (int i = 0; i < kTimerSlots; i++) {
        TimerSlot& t = h.slots[i];
        if (!t.used || (int32_t)(now - t.nextFire) < 0) continue;
        duk_context* tctx = t.ctx != nullptr ? t.ctx : ctx;

        // Agenda ANTES de disparar: um interval que demora mais que o
        // periodo nao dispara em rajada (pula os atrasados)
        if (t.repeat) {
            t.nextFire += t.period;
            while ((int32_t)(now - t.nextFire) >= 0) t.nextFire += t.period;
        } else {
            t.used = false;
        }

        timerStashArray(tctx);
        duk_get_prop_index(tctx, -1, i);
        duk_require_callable(tctx, -1);  // slot valido sempre tem callable
        // remove a referencia de one-shot JA disparado / de quem cancelou
        if (!t.used) {
            duk_push_undefined(tctx);
            duk_put_prop_index(tctx, -3, i);
        }
        duk_remove(tctx, -2);  // tira o array; fn no topo

        if (h.slotBegin != nullptr) h.slotBegin(tctx);
        h.inTick = true;
        esp_task_wdt_reset();  // callback pode desenhar bastante
        duk_int_t rc = duk_pcall(tctx, 0);
        h.inTick = false;
        if (h.slotEnd != nullptr) h.slotEnd(tctx);
        if (rc != DUK_EXEC_SUCCESS) {
            if (h.slotCrash != nullptr) {
                // svchost: o erro e CONSUMIDO aqui (sem frame protegido no
                // pump, o duk_throw ia ao fatal handler = reboot/boot loop).
                // O dono para (noteCrash + timersClearCtx); os outros seguem.
                h.slotCrash(tctx, duk_safe_to_string(tctx, -1));
                continue;
            }
            duk_throw(tctx);  // erro do callback vira erro do app (nao retorna)
        }
        now = millis();
    }
}

static duk_ret_t timerStart(duk_context *ctx, bool repeat) {
    duk_require_callable(ctx, 0);
    duk_uint_t ms = duk_require_uint(ctx, 1);
    TimerHost& h = *s_cur;

    int slot = -1;
    for (int i = 0; i < kTimerSlots; i++)
        if (!h.slots[i].used) { slot = i; break; }
    if (slot < 0) { duk_push_int(ctx, 0); return 1; }  // sem slot

    timerStashArray(ctx);
    duk_dup(ctx, 0);
    duk_put_prop_index(ctx, -2, slot);
    duk_pop(ctx);  // array

    TimerSlot& t = h.slots[slot];
    t.ctx = ctx;
    t.used = true;
    t.repeat = repeat;
    t.period = ms < 10 ? 10 : ms;  // piso de 10ms: dispara no proximo present()
    t.nextFire = millis() + t.period;
    // id monotonico por app (nunca o slot): o id de um timeout que ja
    // disparou nao pode cancelar o timer novo que reusou o mesmo slot
    if (++h.nextId <= 0) h.nextId = 1;
    t.id = h.nextId;
    duk_push_int(ctx, t.id);  // >= 1 (0 = falha: sem slot)
    return 1;
}

duk_ret_t JSBindings::js_setTimeout(duk_context *ctx) {
    return timerStart(ctx, false);
}

duk_ret_t JSBindings::js_setInterval(duk_context *ctx) {
    return timerStart(ctx, true);
}

// clearTimeout e clearInterval sao o mesmo corretor: id 0/ausente nao faz nada
static duk_ret_t timerClear(duk_context *ctx) {
    TimerHost& h = *s_cur;
    // id = handle opaco do setTimeout/setInterval: procura o slot VIVO com
    // esse id (id de timer ja disparado/cancelado nao acha nada)
    int id = duk_is_number(ctx, 0) ? duk_require_int(ctx, 0) : 0;
    if (id < 1) return 0;
    for (int i = 0; i < kTimerSlots; i++) {
        if (!h.slots[i].used || h.slots[i].id != id) continue;
        duk_context* tctx = h.slots[i].ctx != nullptr ? h.slots[i].ctx : ctx;
        h.slots[i].used = false;
        timerStashArray(tctx);
        duk_push_undefined(tctx);
        duk_put_prop_index(tctx, -2, i);
        duk_pop(tctx);  // array
        break;
    }
    return 0;
}

duk_ret_t JSBindings::js_clearTimeout(duk_context *ctx) { return timerClear(ctx); }
duk_ret_t JSBindings::js_clearInterval(duk_context *ctx) { return timerClear(ctx); }

// Reset por app (chamado no init da fachada)
void JSBindings::timersResetAll() {
    timerHostReset(s_appHost);
    JSBindingsTimers::setHost(&s_appHost);
}

// Host do svchost (API 42): zera slots e troca o corrente durante o dispatch
void JSBindings::timersResetSvc() { timerHostReset(s_svcHost); }
void JSBindings::timersUseSvcHost(bool svc) {
    JSBindingsTimers::setHost(svc ? &s_svcHost : &s_appHost);
}

// Hooks do dispatch do svchost: identidade do dono do slot (svcIdentity/
// Restore, feitos no AppServices) e o consumo do erro de callback. Uma vez
// na vida do processo (o reset de slots nao os toca).
void JSBindings::timersSvcHooks(void (*begin)(duk_context*), void (*end)(duk_context*),
                               void (*crash)(duk_context*, const char*)) {
    s_svcHost.slotBegin = begin;
    s_svcHost.slotEnd = end;
    s_svcHost.slotCrash = crash;
}

// Um servico parou/crashou: os timers DELE morrem (um interval repetindo
// dispararia no GC do stash ou em thread morta). No host do app (ctx ==
// nullptr) nao faz nada: os timers do app morrem com o heap dele.
void JSBindings::timersClearCtx(duk_context* ctx) {
    if (ctx == nullptr) return;
    TimerHost& h = s_svcHost;
    for (int i = 0; i < kTimerSlots; i++) {
        if (!h.slots[i].used || h.slots[i].ctx != ctx) continue;
        h.slots[i] = TimerSlot{};
        duk_push_heap_stash(ctx);
        duk_get_prop_string(ctx, -1, "_tmr");
        if (duk_is_array(ctx, -1)) {
            duk_push_undefined(ctx);
            duk_put_prop_index(ctx, -2, i);
        }
        duk_pop_2(ctx);
    }
}

// O heap do app vai morrer (duk_destroy_heap): solta a referencia pendente.
// Sobra de app morto no s_jsCtx fazia o present() de um servico (otaCheck,
// installZip...) bombear os timers do heap DESTRUIDO (UAF).
void JSBindings::heapDetaching() { s_jsCtx = nullptr; }
