#include "JSBindings.h"
#include "JsInternal.h"
#include <Arduino.h>
#include <string>
#include "nvs.h"
#include <cstdio>
#include "../Utils/AppPerms.h"
#include "../Utils/AppGrants.h"

// =====================================================
// Storage (API 12): persistencia chave-valor PRIVADA do app
// =====================================================
//
// O localStorage dos apps: NVS namespace proprio por packageName (nome
// longo = hash do nome completo, ver pkgNamespace) (o
// System.setting e global e apps colidiam entre si; appData e arquivo
// solto). Valores sao strings (numeros/booleans sao serializados com
// duk_to_string — get devolve SEMPRE string, quem gravou numero converte
// de volta). Chave ate 15 chars (limite do NVS), valor ate 4 KB.
//
// App sem packageName (.js avulso) compartilha o namespace "app__anon" —
// documentado: script solto nao tem identidade.

namespace {

// Namespace legado: "app_" + packageName sanitizado, cortado em 15 chars
// (limite do NVS). Com o prefixo "celeros." sobravam 3 chars uteis e
// pacotes como "celeros.notes"/"celeros.notepad" dividiam o mesmo Storage.
std::string legacyNamespace(const std::string& pkg) {
    // Sem packageName (script solto) = anonimo. O teste e o pkg VAZIO, nao o
    // tamanho do namespace: um pacote de 1 char ("a" -> "app_a") caia no
    // mesmo "app__anon" dos scripts avulsos e dividia o Storage com eles.
    if (pkg.empty()) return "app__anon";
    std::string ns = "app_";
    for (size_t i = 0; i < pkg.size() && ns.size() < 15; i++) {
        char c = pkg[i];
        ns += (c == '.' || c == '-' || c == '_') ? '_' :
              ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) ? c : '_';
    }
    return ns;
}

uint32_t fnv1a(const std::string& s) {
    uint32_t h = 2166136261u;
    for (char c : s) h = (h ^ (uint8_t)c) * 16777619u;
    return h;
}

// Nome cabe inteiro (<= 11 chars): namespace legado (dados existentes
// seguem no lugar). Maior: "h_" + FNV-1a de 32 bits do nome COMPLETO.
bool usesHash(const std::string& pkg) { return pkg.size() > 11; }

std::string pkgNamespace(const std::string& pkg) {
    if (!usesHash(pkg)) return legacyNamespace(pkg);
    char buf[16];
    snprintf(buf, sizeof(buf), "h_%08x", (unsigned)fnv1a(pkg));
    return buf;
}

// Marca "ja migrado" FORA do namespace do app (Storage.clear nao a apaga —
// senao a proxima abertura ressuscitaria os dados antigos).
const char* kMigNs = "stor_mig";

void markMigrated(const std::string& pkg) {
    nvs_handle_t h;
    if (nvs_open(kMigNs, NVS_READWRITE, &h) != ESP_OK) return;
    char key[12];
    snprintf(key, sizeof(key), "%08x", (unsigned)fnv1a(pkg));
    nvs_set_u8(h, key, 1);
    nvs_commit(h);
    nvs_close(h);
}

// Uma vez por pacote: copia as chaves do namespace legado (truncado) para o
// novo. O legado NAO e apagado — pode ser compartilhado com outro pacote
// de mesmo prefixo, que migra a propria copia quando abrir.
// O marcador so e gravado quando a copia terminou por INTEIRO: NVS cheia
// (set_blob falho) ou malloc recusado deixavam chaves para tras e o
// "ja migrado" impedia qualquer nova tentativa (dado antigo perdido para
// sempre). Sem o marcador, a proxima abertura tenta de novo.
void migrateLegacy(const std::string& pkg) {
    char key[12];
    snprintf(key, sizeof(key), "%08x", (unsigned)fnv1a(pkg));
    nvs_handle_t mh;
    if (nvs_open(kMigNs, NVS_READONLY, &mh) == ESP_OK) {
        uint8_t v = 0;
        bool done = nvs_get_u8(mh, key, &v) == ESP_OK;
        nvs_close(mh);
        if (done) return;
    }
    const std::string oldNs = legacyNamespace(pkg);
    const std::string newNs = pkgNamespace(pkg);
    nvs_handle_t src, dst;
    bool ok = true;        // copia completa
    bool haveSrc = false;  // namespace legado existe (tem o que copiar)
    if (nvs_open(oldNs.c_str(), NVS_READONLY, &src) == ESP_OK) {
        haveSrc = true;
        if (nvs_open(newNs.c_str(), NVS_READWRITE, &dst) == ESP_OK) {
            nvs_iterator_t it = nullptr;
            esp_err_t e = nvs_entry_find("nvs", oldNs.c_str(), NVS_TYPE_BLOB, &it);
            // NOT_FOUND = namespace sem entradas (nada a copiar); qualquer
            // outro erro deixa a migracao incompleta (sem marcador)
            if (e != ESP_OK && e != ESP_ERR_NVS_NOT_FOUND) ok = false;
            while (e == ESP_OK && it != nullptr) {
                nvs_entry_info_t info;
                nvs_entry_info(it, &info);
                size_t len = 0;
                if (nvs_get_blob(src, info.key, nullptr, &len) == ESP_OK && len > 0) {
                    void* buf = malloc(len);
                    if (buf == nullptr) {
                        ok = false;  // sem RAM: tenta na proxima abertura
                    } else {
                        if (nvs_get_blob(src, info.key, buf, &len) != ESP_OK ||
                            nvs_set_blob(dst, info.key, buf, len) != ESP_OK) {
                            ok = false;
                        }
                        free(buf);
                    }
                }
                e = nvs_entry_next(&it);
            }
            if (it != nullptr) nvs_release_iterator(it);
            if (nvs_commit(dst) != ESP_OK) ok = false;
            nvs_close(dst);
        } else {
            ok = false;  // sem o destino nao ha migracao: tenta depois
        }
        nvs_close(src);
    }
    // Sem namespace legado (nada a migrar) ou copia inteira: marca. Falha
    // parcial mantem o marcador fora para a proxima abertura tentar de novo.
    if (!haveSrc || ok) markMigrated(pkg);
}

// Namespace do app corrente; migra na primeira chamada de cada app
std::string storageNamespace() {
    static std::string s_cachedPkg;
    static std::string s_cachedNs;
    static bool s_cached = false;
    if (!s_cached || s_cachedPkg != s_appPkg) {
        s_cachedPkg = s_appPkg;
        s_cachedNs = pkgNamespace(s_appPkg);
        if (usesHash(s_appPkg)) migrateLegacy(s_appPkg);
        s_cached = true;
    }
    return s_cachedNs;
}

const char* requireKey(duk_context* ctx, duk_idx_t idx) {
    const char* k = duk_require_string(ctx, idx);
    size_t len = strlen(k);
    if (len == 0 || len > 15) {
        duk_error(ctx, DUK_ERR_RANGE_ERROR,
                  "Storage: chave deve ter 1 a 15 caracteres (limite do NVS)");
    }
    return k;
}

// A NVS (20 KB, ~500 entradas de 32 B) e a mesma das credenciais WiFi,
// calibracao do PHY e ajustes do sistema: um app nao pode enche-la. Cada
// gravacao precisa deixar esta folga livre.
constexpr size_t kNvsReserveEntries = 128;

// Capacidade: 4 KB por valor (blob NVS). Grava e devolve sucesso.
// Valor vazio remove a chave (mesma semantica do CelerSettings).
bool nvsPut(const std::string& ns, const char* key, const char* data, size_t len) {
    if (len > 0) {
        nvs_stats_t st;
        const size_t need = len / 32 + 2;  // blob: indice + dados em entradas de 32 B
        if (nvs_get_stats(nullptr, &st) != ESP_OK || st.free_entries < need + kNvsReserveEntries) {
            return false;
        }
    }
    nvs_handle_t h;
    if (nvs_open(ns.c_str(), NVS_READWRITE, &h) != ESP_OK) return false;
    bool ok;
    if (len == 0) {
        nvs_erase_key(h, key);  // ausente nao e erro
        ok = true;
    } else {
        ok = nvs_set_blob(h, key, data, len) == ESP_OK;
    }
    ok = ok && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    return ok;
}

bool eraseNamespace(const std::string& ns) {
    nvs_handle_t h;
    bool ok = false;
    if (nvs_open(ns.c_str(), NVS_READWRITE, &h) == ESP_OK) {
        ok = nvs_erase_all(h) == ESP_OK && nvs_commit(h) == ESP_OK;
        nvs_close(h);
    }
    return ok;
}

}  // namespace

// Ausente: o default do app (2o arg) — ou "" se omitido (o doc promete
// "sempre string"; antes vinha undefined)
static void pushDefault(duk_context* ctx) {
    if (duk_is_undefined(ctx, 1)) duk_push_string(ctx, "");
    else duk_dup(ctx, 1);
}

duk_ret_t JSBindings::js_storageGet(duk_context *ctx) {
    const char* key = requireKey(ctx, 0);
    nvs_handle_t h;
    std::string ns = storageNamespace();
    if (nvs_open(ns.c_str(), NVS_READONLY, &h) != ESP_OK) {
        // namespace novo: valor padrao (2o arg) ou string vazia
        pushDefault(ctx);
        return 1;
    }
    size_t len = 0;
    if (nvs_get_blob(h, key, nullptr, &len) != ESP_OK) {
        nvs_close(h);
        pushDefault(ctx);
        return 1;
    }
    char* buf = (char*)malloc(len);
    if (buf == nullptr) {
        nvs_close(h);
        pushDefault(ctx);
        return 1;
    }
    esp_err_t got = nvs_get_blob(h, key, buf, &len);
    nvs_close(h);
    if (got != ESP_OK) {  // corrida/valor mudou: nao devolve bytes velhos
        free(buf);
        pushDefault(ctx);
        return 1;
    }
    // valor pode conter NUL (binario ok)
    return jsPushOwnedString(ctx, buf, len);
}

duk_ret_t JSBindings::js_storageSet(duk_context *ctx) {
    const char* key = requireKey(ctx, 0);
    duk_to_string(ctx, 1);  // numero/boolean serializa; string segue crua
    size_t len = 0;
    const char* val = duk_get_lstring(ctx, 1, &len);  // binario: NUL nao corta (o get ja era)
    if (len > 4096) {
        duk_error(ctx, DUK_ERR_RANGE_ERROR, "Storage: valor acima de 4KB");
    }
    duk_push_boolean(ctx, nvsPut(storageNamespace(), key, val, len) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_storageRemove(duk_context *ctx) {
    const char* key = requireKey(ctx, 0);
    nvs_handle_t h;
    if (nvs_open(storageNamespace().c_str(), NVS_READWRITE, &h) == ESP_OK) {
        nvs_erase_key(h, key);  // chave ausente nao e erro
        nvs_commit(h);
        nvs_close(h);
    }
    return 0;
}

// Apaga TUDO do app (usado pelo proprio app e pela desinstalacao via loja)
duk_ret_t JSBindings::js_storageClear(duk_context *ctx) {
    duk_push_boolean(ctx, eraseNamespace(storageNamespace()) ? 1 : 0);
    return 1;
}

bool JSBindings::storageClearPackage(const std::string& pkg) {
    bool ok = eraseNamespace(pkgNamespace(pkg));
    // Nome longo: o namespace legado (truncado) pode ser de OUTRO pacote de
    // mesmo prefixo — nao apaga; so marca migrado para a reinstalacao nao
    // ressuscitar os dados antigos.
    if (usesHash(pkg)) markMigrated(pkg);
    return ok;
}

// clearFor(pkg): apaga o Storage de OUTRO app (desinstalacao pela loja).
// Capability "system": um app comum nao pode apagar o dado de terceiros.
duk_ret_t JSBindings::js_storageClearFor(duk_context *ctx) {
    if (!perm(celer::PERM_SYSTEM)) {
        duk_error(ctx, DUK_ERR_ERROR, "Storage.clearFor requer permissao \"system\"");
    }
    std::string pkg = duk_require_string(ctx, 0);
    bool ok = storageClearPackage(pkg);
    // a loja chama na desinstalacao: a concessao de permissoes vai junto
    // (reinstalar pede consentimento de novo)
    AppGrants::revoke(pkg);
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}
