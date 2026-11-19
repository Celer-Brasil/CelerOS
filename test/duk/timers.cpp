// Exercita os bindings do firmware com relogio controlado e Duktape real.
#include <cassert>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include "duktape.h"

static uint32_t clockMs, reads;
static uint32_t millis() { ++reads; return clockMs; }
static void esp_task_wdt_reset() {}
static duk_context* s_jsCtx;
extern "C" duk_bool_t celer_exec_timeout_check(void*) { return 0; }

namespace JSBindings {
void timersTick(duk_context*);
duk_ret_t js_setTimeout(duk_context*);
duk_ret_t js_setInterval(duk_context*);
duk_ret_t js_clearTimeout(duk_context*);
duk_ret_t js_clearInterval(duk_context*);
void timersResetAll();
void timersResetSvc();
void timersUseSvcHost(bool);
void timersSvcHooks(void (*)(duk_context*), void (*)(duk_context*),
                    void (*)(duk_context*, const char*));
void timersClearCtx(duk_context*);
void heapDetaching();
}
#include "timers_body.inc"

static void eval(duk_context* ctx, const char* src) {
    if (duk_peval_string(ctx, src) != 0) {
        fprintf(stderr, "%s\n", duk_safe_to_string(ctx, -1));
        abort();
    }
    assert(duk_to_boolean(ctx, -1));
    duk_pop(ctx);
}

int main() {
    using namespace JSBindings;
    duk_context* ctx = duk_create_heap_default();
    assert(ctx);
    duk_push_c_function(ctx, js_setInterval, 2); duk_put_global_string(ctx, "interval");
    duk_push_c_function(ctx, js_setTimeout, 2); duk_put_global_string(ctx, "timeout");
    duk_push_c_function(ctx, js_clearTimeout, 1); duk_put_global_string(ctx, "cancel");
    timersResetAll();
    timersTick(ctx);
    assert(reads == 0);

    clockMs = UINT32_MAX - 4;
    eval(ctx, "var n=0, i=interval(function(){n++},10); i===1");
    clockMs = 4; timersTick(ctx); eval(ctx, "n===0");
    clockMs = 5; timersTick(ctx); eval(ctx, "n===1");
    clockMs += 86400003; timersTick(ctx); eval(ctx, "n===2");  // 24h de atraso
    clockMs += 6; timersTick(ctx); eval(ctx, "n===2");
    ++clockMs; timersTick(ctx); eval(ctx, "n===3");
    s_appHost.nextId = INT32_MAX;  // o handle 1 ainda esta vivo
    eval(ctx, "var j=timeout(function(){cancel(i);n+=7},10); j!==i && j>0");
    clockMs += 10; timersTick(ctx); eval(ctx, "n===11");
    reads = 0; timersTick(ctx); assert(reads == 0);

    eval(ctx, "var ids=[]; for(var k=0;k<8;k++)ids.push(timeout(function(){},10));"
              "ids.every(function(id){return id>0}) && timeout(function(){},10)===0");
    eval(ctx, "cancel(ids[3]); var fresh=interval(function(){},100); fresh>0 && fresh!==ids[3]");
    timersResetAll(); reads = 0; timersTick(ctx); assert(reads == 0);

    timersResetSvc();
    timersUseSvcHost(true);
    duk_push_thread(ctx);
    duk_context* svc = duk_get_context(ctx, -1);
    eval(svc, "var svcId=interval(function(){n++},10);svcId>0");
    eval(ctx, "cancel(svcId);true");  // outro contexto nao cancela o timer
    clockMs += 10; timersTick(ctx); eval(svc, "n===12");
    timersClearCtx(svc); reads = 0; timersTick(ctx); assert(reads == 0);
    timersUseSvcHost(false);
    duk_destroy_heap(ctx);
}
