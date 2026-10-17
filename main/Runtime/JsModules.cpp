// Modulos JS (API 23): require("nome") carrega <pasta do app>/nome.js.
//
// CommonJS enxuto: o fonte do modulo e compilado embrulhado como
//   function(module, exports, require){ ... }
// e executado com duk_pcall — o modulo popula module.exports (ou exports,
// alias criado junto) e o require devolve esse objeto. O require do corpo e
// o MESMO global, entao modulos requerem modulos (resolvidos sempre da
// pasta do app corrente, sem caminhos relativos).
//
// Linhas do erro: o wrapper abre NA MESMA linha do primeiro codigo do
// modulo e o JsStripper preserva quebras — o "line N" do Duktape bate com a
// linha N do arquivo do modulo.
//
// Cache por app-run no heap stash (morre com o heap): a entrada e gravada
// ANTES do eval (ciclo recebe exports parciais, padrao CommonJS) e
// atualizada DEPOIS (module.exports pode ter sido trocado). Falha de
// compile/eval remove a entrada — retry recarrega do disco.
//
// Dependencias compartilhadas (API 30): se o arquivo NAO esta na pasta do
// app e o deps.json dela referencia o nome, o require cai para o cache
// publico /local/modules/<nome>/<versao>/<nome>.js — a engine/fisica do
// hub instaladas pela loja. Precedencia da pasta local (vendoring) e o
// deps.json e gravado pelo installer (loja/celerctl) com a versao
// RESOLVIDA do range declarado no app.json; o GC do launcher (scanLocalApps)
// remove versoes sem app referenciando.
//
// Sem gate de permissao: e codigo do proprio app e a resolucao e restrita a
// s_appDir (nome [A-Za-z0-9_.-], sem "..", sem subpasta), entao o jail do FS
// nem entra. noteAppYield antes do eval renova a janela do exec-timeout
// (padrao do fix 4b5b9ce: carregar N modulos no boot nao pode virar
// RangeError).

#include "JsInternal.h"
#include "../Kernel/Core/CelerKernel.h"
#include "../Utils/JsStrip.h"
#include "../FileSystem/FileSystem.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>

// Pasta do app em execucao (dirname do main.js; vazia p/ .js avulso do
// shell). Alimentada pelo CelerKernel::runFile, lida pelo require.
std::string s_appDir;

namespace {

// O compile+eval do modulo roda dentro do pcall do app: cada nivel de
// require aninhado soma C-stack da task (20KB na CYD; pico medido do
// compile ~8,5KB). Teto explicito e baixo em vez de stack overflow.
constexpr int kMaxRequireDepth = 8;
int g_depth = 0;
// Deps compartilhadas do app corrente (deps.json resolvido no install).
constexpr int kMaxSharedDeps = 8;
struct SharedDep {
    char name[64];
    char ver[24];
};
SharedDep s_sharedDeps[kMaxSharedDeps];
int s_sharedDepCount = 0;

// Nome de modulo: [A-Za-z0-9_.-], 1..63 chars (sufixo ".js" opcional). O
// ponto entrou com as deps compartilhadas (identidade "celeros.engine");
// nome so de pontuacao ("..") e barrado na hora.
bool validModuleName(const char* s, size_t n) {
    if (n == 0 || n > 63) return false;
    bool hasAlnum = false;
    for (size_t i = 0; i < n; i++) {
        char c = s[i];
        bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                  (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.';
        if (!ok) return false;
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) hasAlnum = true;
    }
    return hasAlnum;
}

// Versao de dep no path: so digitos e pontos ("1.0.0"), ao menos 1 digito.
bool validDepVersion(const char* s) {
    bool hasDigit = false;
    for (const char* p = s; *p; p++) {
        if (*p >= '0' && *p <= '9') { hasDigit = true; continue; }
        if (*p != '.') return false;
    }
    return hasDigit;
}

const SharedDep* findSharedDep(const char* mod) {
    for (int i = 0; i < s_sharedDepCount; i++) {
        if (strcmp(s_sharedDeps[i].name, mod) == 0) return &s_sharedDeps[i];
    }
    return nullptr;
}

}  // namespace

// Identidade do servico no svchost (API 42): o dispatch do AppServices troca
// a pasta base do require() para a do servico corrente e restaura depois.
void jsModulesSetAppDir(const char* appDir) { s_appDir = appDir ? appDir : ""; }
const std::string& jsModulesGetAppDir() { return s_appDir; }

void jsLoadAppDeps(const char* appDir) {
    // Mapa nome->versao do deps.json (gravado pelo installer com a versao
    // RESOLVIDA do range do app.json). Chamado no runFile junto com o
    // s_appDir; sem pasta/deps.json = nenhuma dep (vendoring puro).
    s_sharedDepCount = 0;
    if (appDir == nullptr || appDir[0] == '\0') return;
    std::string json = FileSystem::readTextFile((std::string(appDir) + "/deps.json").c_str());
    if (json.empty()) return;
    JsonStringPair pairs[kMaxSharedDeps];
    int n = FileSystem::parseJsonStringMap(json, pairs, kMaxSharedDeps);
    for (int i = 0; i < n && s_sharedDepCount < kMaxSharedDeps; i++) {
        const char* nm = pairs[i].key.c_str();
        const char* vr = pairs[i].value.c_str();
        if (!validModuleName(nm, strlen(nm))) continue;
        if (!validDepVersion(vr) || strlen(vr) >= sizeof(SharedDep::ver)) continue;
        SharedDep& d = s_sharedDeps[s_sharedDepCount++];
        strncpy(d.name, nm, sizeof(d.name) - 1);
        d.name[sizeof(d.name) - 1] = '\0';
        strcpy(d.ver, vr);
    }
}

duk_ret_t JSBindings::js_require(duk_context* ctx) {
    const char* name = duk_require_string(ctx, 0);
    size_t nlen = strlen(name);
    if (nlen > 3 && strcmp(name + nlen - 3, ".js") == 0) nlen -= 3;
    char mod[80];
    char err[160];

    if (!validModuleName(name, nlen)) {
        // NAO ecoa o nome no duk_error: texto do app viraria format-string
        // (require("%d") = heap corrompido; padrao do guard duk_error)
        duk_error(ctx, DUK_ERR_ERROR,
                  "require: nome de modulo invalido (use [A-Za-z0-9_.-], sem caminho)");
    }
    snprintf(mod, sizeof(mod), "%.*s", (int)nlen, name);
    if (s_appDir.empty()) {
        duk_error(ctx, DUK_ERR_ERROR,
                  "require: sem pasta de app (so funciona dentro de um app)");
    }

    // path nao vai em mensagem de erro (a pasta pode ter caracteres do
    // sideload): o modulo e identificado pelo nome validado acima
    char path[192];
    snprintf(path, sizeof(path), "%s/%s.js", s_appDir.c_str(), mod);

    // Cache no heap stash, chaveado pela PASTA + nome: no svchost o heap e
    // UNICO para todos os servicos — sem a pasta na chave, dois apps dando
    // require("utils") compartilhariam a instancia (e a pasta) do primeiro.
    char cacheKey[112];
    snprintf(cacheKey, sizeof(cacheKey), "%s/%s", s_appDir.c_str(), mod);

    // Cache no heap stash do app corrente: [.. name(0) stash(1) cache(2)]
    duk_push_heap_stash(ctx);
    duk_get_prop_string(ctx, -1, "modules");
    if (!duk_is_object(ctx, -1)) {
        duk_pop(ctx);
        duk_push_object(ctx);
        duk_dup(ctx, -1);
        duk_put_prop_string(ctx, -3, "modules");
    }
    if (duk_has_prop_string(ctx, 2, cacheKey)) {
        duk_get_prop_string(ctx, 2, cacheKey);  // cache hit: devolve direto
        duk_replace(ctx, 0);               // [hit, stash, cache] -> hit na base
        duk_pop_n(ctx, 2);
        return 1;
    }

    // Le o fonte e enxuga IN-PLACE (JsStripper: linhas preservadas). O
    // wrapper abre na mesma linha do primeiro codigo do modulo.
    static const char kWrapA[] = "function(module,exports,require){";
    const size_t pre = sizeof(kWrapA) - 1;
    FILE* f = fopen(path, "rb");
    if (!f) {
        // Dep compartilhada (API 30): arquivo nao esta na pasta do app e o
        // deps.json referencia o nome -> cache publico do hub em
        // /local/modules/<nome>/<versao>/ (instalado pela loja)
        const SharedDep* dep = findSharedDep(mod);
        if (dep) {
            snprintf(path, sizeof(path), "/local/modules/%s/%s/%s.js",
                     dep->name, dep->ver, dep->name);
            f = fopen(path, "rb");
        }
        if (!f) {
            if (dep)
                snprintf(err, sizeof(err),
                         "require: dependencia %s %s ausente — reinstale o app pela loja",
                         dep->name, dep->ver);
            else
                snprintf(err, sizeof(err), "require: modulo nao encontrado: %s.js", mod);
            duk_error(ctx, DUK_ERR_ERROR, err);
        }
    }
    fseek(f, 0, SEEK_END);
    long fsz = ftell(f);
    fseek(f, 0, SEEK_SET);
    char* src = nullptr;
    if (fsz >= 0) src = (char*)malloc(pre + (size_t)fsz + 2);
    if (!src) {
        fclose(f);
        duk_error(ctx, DUK_ERR_ERROR, "require: sem memoria p/ o modulo");
    }
    size_t got = fread(src + pre, 1, (size_t)fsz, f);
    fclose(f);
    celer::JsStripper strip(src + pre);
    strip.feed(src + pre, got);
    size_t len = strip.finish();
    src[pre + len] = '\n';
    src[pre + len + 1] = '}';
    const size_t srcLen = pre + len + 2;
    memcpy(src, kWrapA, pre);

    // module/exports: objetos irmãos — exports e o valor inicial de
    // module.exports (alias, como no CommonJS)
    duk_push_object(ctx);                     // 3: module
    duk_push_object(ctx);                     // 4: exports
    duk_dup(ctx, 4);
    duk_put_prop_string(ctx, 3, "exports");
    duk_get_prop_string(ctx, 3, "exports");   // 5: exports (cache parcial)
    duk_put_prop_string(ctx, 2, cacheKey);    // cache[<pasta>/<mod>] = exports

    // compile: [name stash cache module(3) exports(4)] -> fn no topo.
    // DUK_COMPILE_FUNCTION: o fonte E uma expressao de funcao. Com flags 0
    // (programa) o Duktape le "function(" como DECLARACAO sem nome e lanca
    // "SyntaxError: function name required" — todo require falhava no
    // aparelho (o harness Node nao compila com o Duktape e nao via isso).
    duk_push_string(ctx, path);
    duk_int_t rc = duk_pcompile_lstring_filename(ctx, DUK_COMPILE_FUNCTION, src, srcLen);
    free(src);  // bytecode no heap: o fonte sai antes do eval
    if (rc != 0) {
        duk_del_prop_string(ctx, 2, cacheKey);  // falha nao memoiza
        return duk_throw(ctx);             // erro de sintaxe propagado ao app
    }
    // fn(5) -> vira idx 3, acima de module/exports; require por ultimo:
    // pcall(3) chama fn(module, exports, require)
    duk_insert(ctx, 3);
    duk_get_global_string(ctx, "require");
    // preserva o module ABAIXO da chamada p/ ler o exports final depois
    duk_dup(ctx, 4);      // module ref
    duk_insert(ctx, 3);   // [module(3) fn(4) module(5) exports(6) require(7)]

    if (g_depth >= kMaxRequireDepth) {
        duk_error(ctx, DUK_ERR_ERROR,
                  "require: profundidade maxima (ciclo sem caso base?)");
    }
    g_depth++;
    CelerKernel::noteAppYield();  // eval do modulo = bytecode: renova a janela
    rc = duk_pcall(ctx, 3);
    g_depth--;
    if (rc != 0) {
        duk_del_prop_string(ctx, 2, mod);  // retry recarrega do disco
        return duk_throw(ctx);             // erro do modulo propagado ao app
    }
    duk_pop(ctx);  // resultado do eval (undefined) nao interessa

    // cache e retorno = module.exports FINAL (o modulo pode ter trocado)
    duk_get_prop_string(ctx, 3, "exports");  // final
    duk_dup(ctx, 4);
    duk_put_prop_string(ctx, 2, cacheKey);   // cache atualizado (pasta/nome)
    duk_replace(ctx, 0);                     // [final, stash, cache, module]
    duk_pop_n(ctx, 3);
    return 1;
}
