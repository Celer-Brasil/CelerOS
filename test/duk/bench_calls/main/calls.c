/* ESP32 sem PSRAM, mesma conta em C, JS e JS chamando um binding.
 * Na pasta bench_calls: idf.py build e idf.py qemu --qemu-extra-args="-icount 3"
 * O tempo emulado serve para comparar duas builds com os mesmos argumentos.
 */
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>

#include "duktape.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"

enum { ITERACOES = 10000 };
static unsigned alocacoes;
extern const char grid_js[] asm("_binary_celeros_grid_js_start");

static void *alocar(void *udata, duk_size_t size) {
    (void)udata;
    ++alocacoes;
    return malloc(size);
}

static void *realocar(void *udata, void *ptr, duk_size_t size) {
    (void)udata;
    return realloc(ptr, size);
}

static void liberar(void *udata, void *ptr) {
    (void)udata;
    free(ptr);
}

duk_bool_t celer_exec_timeout_check(void *udata) {
    (void)udata;
    return 0;
}

/* Impede que o compilador incorpore a chamada de referencia no laco C. */
static __attribute__((noinline)) int passo(int x, int i) {
    return (x * 3 + i) & 65535;
}

static duk_ret_t passo_nativo(duk_context *ctx) {
    duk_push_int(ctx, passo(duk_require_int(ctx, 0), duk_require_int(ctx, 1)));
    return 1;
}

static void medir_js(duk_context *ctx, const char *nome, int repeticoes, int esperado) {
    duk_get_global_string(ctx, nome);
    duk_push_int(ctx, repeticoes);
    unsigned antes = alocacoes;
    int64_t inicio = esp_timer_get_time();
    duk_int_t rc = duk_pcall(ctx, 1);
    int64_t tempo = esp_timer_get_time() - inicio;
    if (rc || duk_require_int(ctx, -1) != esperado) abort();
    printf("%s: %" PRId64 " us, %u malloc, soma=%d\n", nome, tempo, alocacoes - antes, esperado);
    duk_pop(ctx);
}

void app_main(void) {
    duk_context *ctx = duk_create_heap(alocar, realocar, liberar, NULL, NULL);
    if (!ctx) abort();
    duk_push_c_lightfunc(ctx, passo_nativo, 2, 2, 0);
    duk_put_global_string(ctx, "passoNativo");
    duk_eval_string_noresult(ctx,
        "function passoJS(x,i){return (x*3+i)&65535;}"
        "function js(n){var x=0;for(var i=0;i<n;++i)x=passoJS(x,i);return x;}"
        "function aritmetica(n){var x=0;for(var i=0;i<n;++i)x=(x*3+i)&65535;return x;}"
        "function binding(n){var x=0;for(var i=0;i<n;++i)x=passoNativo(x,i);return x;}"
        "function profundidade(n){return n ? 1+profundidade(n-1) : 0;}");
    int x = 0;
    int64_t inicio = esp_timer_get_time();
    for (int i = 0; i < ITERACOES; ++i) x = passo(x, i);
    printf("C: %" PRId64 " us, soma=%d\n", esp_timer_get_time() - inicio, x);
    for (int i = 0; i < 5; ++i) {
        medir_js(ctx, "aritmetica", ITERACOES, x);
        medir_js(ctx, "js", ITERACOES, x);
        medir_js(ctx, "binding", ITERACOES, x);
    }
    /* A mesma pilha ja cresceu antes da medicao. O delta com e sem cache
     * mostra quanto fica retido ao voltar de 32 chamadas ate o proximo GC. */
    for (int i = 0; i < 2; ++i) {
        duk_gc(ctx, 0);
        duk_get_global_string(ctx, "profundidade");
        duk_push_int(ctx, 32);
        size_t antes = heap_caps_get_free_size(MALLOC_CAP_8BIT);
        duk_call(ctx, 1);
        if (duk_require_int(ctx, -1) != 32) abort();
        duk_pop(ctx);
        size_t depois = heap_caps_get_free_size(MALLOC_CAP_8BIT);
        duk_gc(ctx, 0);
        size_t apos_gc = heap_caps_get_free_size(MALLOC_CAP_8BIT);
        printf("pilha 32: livre %u -> %u -> %u (apos GC)\n",
               (unsigned)antes, (unsigned)depois, (unsigned)apos_gc);
    }
    /* Percorre uma grade com a dep real do SDK. O unico vao da parede
     * fica na ultima linha: 12 passos para baixo, 14 a direita, 12 acima. */
    duk_eval_string_noresult(ctx, "var module={exports:{}};");
    duk_eval_string_noresult(ctx, grid_js);
    duk_eval_string_noresult(ctx,
        "var grade=module.exports,mapa=grade.nova(15,13,'.');"
        "for(var r=0;r<12;++r)mapa[r][7]='#';"
        "function livre(ch){return ch!=='#';}"
        "function mapaJS(){return grade.flow(mapa,14,0,livre).dist(0,0);}");
    for (int i = 0; i < 5; ++i) medir_js(ctx, "mapaJS", 1, 38);
    duk_destroy_heap(ctx);
    puts("bench OK");
}
