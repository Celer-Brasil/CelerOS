#!/usr/bin/env python3
"""Testes de bindings no Duktape REAL (host).

O harness Node (test/js_harness) emula a API em JS: nao compila com o
Duktape do firmware, entao diferencas de engine passam despercebidas (ex.:
o require() compilava o wrapper como PROGRAMA e o Duktape recusava
"function(" sem nome — todo require falhava no aparelho com os testes
verdes). Aqui o corpo de JSBindings::js_require e extraido VERBATIM de
main/Runtime/JsModules.cpp, compilado contra components/duktape/duktape.c
(mesma config do firmware) + o JsStripper real, e roda a fixture
test/js_harness/fixtures/modapp com as mesmas expectativas do harness.

Uso: python3 test/duk/run.py   (precisa de gcc/g++; ~20 s na 1a vez,
o duktape.o fica em cache em test/duk/.build)
"""
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BUILD = os.path.join(os.path.dirname(__file__), '.build')
DUK = os.path.join(ROOT, 'components', 'duktape')
FIXTURE = os.path.join(ROOT, 'test', 'js_harness', 'fixtures', 'modapp')

EXPECT = [
    'nota: tocando alerta',
    'dobra: 42',
    'beep: beep p/tocando x',
    'loads: 1', 'loads pos-cache: 1',
    'deep: profundo',
    'ciclo: parcial-ok',
    'quebrado capturado',
    'fantasma capturado',
]

DRIVER = r'''
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include "duktape.h"
#include "Utils/JsStrip.h"
#include "Utils/JsonMap.h"
// shim do FileSystem (o require le o deps.json desde a API 30): mesmo
// parser do firmware (Utils/JsonMap.h), leitura por stdio
namespace FileSystem {
inline std::string readTextFile(const char* p) {
    std::string s; FILE* f = fopen(p, "rb"); if (!f) return s;
    char b[4096]; size_t n; while ((n = fread(b, 1, sizeof b, f)) > 0) s.append(b, n);
    fclose(f); return s;
}
inline int parseJsonStringMap(const std::string& j, JsonStringPair* o, int m) {
    return celer::parseJsonStringMap(j, o, m);
}
}
// shim do heap do IDF (API 44: a tabela de deps vive no heap so com deps)
#define MALLOC_CAP_SPIRAM 1
#define MALLOC_CAP_8BIT 2
inline void* heap_caps_malloc(size_t n, unsigned) { return malloc(n); }
inline void heap_caps_free(void* p) { free(p); }
extern "C" duk_bool_t celer_exec_timeout_check(void* udata) { (void)udata; return 0; }
namespace CelerKernel { inline void noteAppYield() {} }
std::string s_appDir;
%BODY%
static duk_ret_t print(duk_context* ctx) { printf("%s\n", duk_safe_to_string(ctx, 0)); return 0; }
static duk_ret_t exitApp(duk_context* ctx) { return duk_error(ctx, DUK_ERR_ERROR, "app exit"); }
int main(int argc, char** argv) {
    s_appDir = argv[1];
    duk_context* ctx = duk_create_heap_default();
    duk_push_c_lightfunc(ctx, js_require, 1, 1, 0);
    duk_put_global_string(ctx, "require");
    duk_push_object(ctx);
    duk_push_c_lightfunc(ctx, print, 1, 1, 0);
    duk_put_prop_string(ctx, -2, "print");
    duk_push_c_lightfunc(ctx, exitApp, 0, 0, 0);
    duk_put_prop_string(ctx, -2, "exitApp");
    duk_put_global_string(ctx, "System");
    std::string src;
    FILE* f = fopen((s_appDir + "/main.js").c_str(), "rb");
    if (!f) return 2;
    char b[8192];
    size_t n = fread(b, 1, sizeof(b), f);
    fclose(f);
    src.assign(b, n);
    if (duk_peval_lstring(ctx, src.data(), src.size()) != 0) {
        const char* e = duk_safe_to_string(ctx, -1);
        if (strstr(e, "app exit") == nullptr) printf("ERRO: %s\n", e);
    }
    duk_destroy_heap(ctx);
    return 0;
}
'''


def extract_require():
    s = open(os.path.join(ROOT, 'main', 'Runtime', 'JsModules.cpp')).read()
    body = s[s.index('namespace {'):]
    body = body.replace('#include "esp_heap_caps.h"', '')
    body = body.replace('duk_ret_t JSBindings::js_require(duk_context* ctx) {',
                        'static duk_ret_t js_require(duk_context* ctx) {')
    return body


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stdout + r.stderr)
        sys.exit('falha: ' + ' '.join(cmd[:3]))
    return r.stdout


def main():
    os.makedirs(BUILD, exist_ok=True)
    inc = os.path.join(BUILD, 'inc')
    os.makedirs(inc, exist_ok=True)
    open(os.path.join(inc, 'sdkconfig.h'), 'w').close()  # duk_config.h inclui
    duk_o = os.path.join(BUILD, 'duktape.o')
    duk_c = os.path.join(DUK, 'duktape.c')
    if not os.path.exists(duk_o) or os.path.getmtime(duk_o) < os.path.getmtime(duk_c):
        run(['gcc', '-c', '-O1', '-w', '-I', inc, '-I', DUK, '-o', duk_o, duk_c])
    drv = os.path.join(os.path.dirname(__file__), '.build', 'require_test.cpp')
    open(drv, 'w').write(DRIVER.replace('%BODY%', extract_require()))
    exe = os.path.join(BUILD, 'require_test')
    run(['g++', '-std=c++17', '-O0', '-w', '-I', inc, '-I', DUK,
         '-I', os.path.join(ROOT, 'main'), '-o', exe, drv, duk_o, '-lm'])
    out = run([exe, FIXTURE])

    fails = 0
    print('Duktape real: require() (main/Runtime/JsModules.cpp)')
    ok = 'ERRO:' not in out
    print(('  PASS  ' if ok else '  FAIL  ') + 'fixture roda sem erro' + ('' if ok else '  << ' + out.strip()))
    fails += 0 if ok else 1
    for want in EXPECT:
        hit = want in out
        print(('  PASS  ' if hit else '  FAIL  ') + 'require: ' + want)
        fails += 0 if hit else 1
    print()
    if fails:
        print('FALHAS: %d' % fails)
        sys.exit(1)
    print('OK: todos os testes passaram')


if __name__ == '__main__':
    main()
