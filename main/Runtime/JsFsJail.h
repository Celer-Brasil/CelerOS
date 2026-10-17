#pragma once

// Jail do FS para os bindings JS (F6). Header proprio para nao engordar o
// JsInternal.h: so JsFs.cpp, JsNet.cpp e o nucleo (copy/remove) precisam disto.
#include <cstring>
#ifdef CELER_HOST_TEST
// testes host (test/cpp): o teste fornece perm()/s_appPkg sem o Duktape
#include <string>
#include "../Utils/AppPerms.h"
#else
#include "JsInternal.h"
#endif

// Caminho CANONICO dentro de um ponto de montagem: comeca com o segmento
// inteiro "/local" ou "/sd" e nao tem segmento vazio ("//"), "." nem "..".
// O LittleFS resolve "/local/./wifi.txt", "/local//wifi.txt" e
// "/local/data/../wifi.txt" para o mesmo arquivo que "/local/wifi.txt":
// a comparacao exata da lista protegida nao pegava essas formas, e
// "/local/." passava como raiz no removeDirectory/copyDirectory.
// Uma unica barra final e tolerada ("/sd/apps/").
inline bool fsPathCanonical(const char* path) {
    if (path == nullptr) return false;
    const char* rest;
    if (strncmp(path, "/local", 6) == 0) rest = path + 6;
    else if (strncmp(path, "/sd", 3) == 0) rest = path + 3;
    else return false;
    if (*rest != '\0' && *rest != '/') return false;  // "/localfoo", "/sdcard"
    while (*rest == '/') {
        const char* seg = rest + 1;
        const char* end = strchr(seg, '/');
        size_t n = end ? (size_t)(end - seg) : strlen(seg);
        if (n == 0) {
            if (end == nullptr) return true;  // barra final unica
            return false;                     // "//"
        }
        if ((n == 1 && seg[0] == '.') || (n == 2 && seg[0] == '.' && seg[1] == '.')) return false;
        if (end == nullptr) return true;
        rest = end;
    }
    return *rest == '\0';
}

// Raiz de um ponto de montagem ("/local", "/local/", "/sd", "/sd/")
inline bool fsIsMountRoot(const char* path, const char* mount) {
    size_t n = strlen(mount);
    return strncmp(path, mount, n) == 0 && (path[n] == '\0' || (path[n] == '/' && path[n + 1] == '\0'));
}

// Teto de path vindo do JS. O VFS do IDF aceita ate ~255 (LittleFS limita o
// componente a 64, o FAT a 255); acima disto so o app paga alocacao: os
// nomes derivados ("<path>.tmp"/"<path>.part") viram std::string e o
// crescimento sem excecoes ABORTA o aparelho. Quem monta nome derivado checa.
constexpr size_t kJsPathMax = 192;

// Pasta de apps instalados (/local/apps, /sd/apps e tudo abaixo): o codigo
// de OUTROS apps. Escrever ali reescreveria o main.js de um app com mais
// permissoes concedidas e herdaria a concessao (AppGrants) — so "system".
// O FAT do /sd e CASE-INSENSITIVE: "/sd/Apps" e o MESMO diretorio de
// "/sd/apps", entao a comparacao ali ignora caixa (o LittleFS do /local e
// sensivel e segue exato — "/local/APPS" e outra pasta).
inline bool fsUnderAppsDir(const char* path) {
    auto under = [](const char* p, const char* dir, bool foldCase) {
        size_t n = strlen(dir);
        for (size_t i = 0; i < n; i++) {
            char a = p[i], b = dir[i];
            if (foldCase) {
                if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
                if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
            }
            if (a != b) return false;
            if (a == '\0') return false;  // prefixo curto: nao e a pasta
        }
        return p[n] == '\0' || p[n] == '/';
    };
    return under(path, "/local/apps", false) || under(path, "/sd/apps", true);
}

// Modulos compartilhados do hub (/local/modules/<nome>/<versao>/): codigo
// que os apps carregam por require() (engine/fisica). Escrever ali trocaria
// o codigo que OUTROS apps executam — mesma regra das pastas de apps.
// Leitura segue livre (o require le com fopen, sem jail).
inline bool fsUnderSharedModules(const char* path) {
    size_t n = strlen("/local/modules");
    return strncmp(path, "/local/modules", n) == 0 &&
           (path[n] == '\0' || path[n] == '/');
}

// /local/data/<pkg>/ e a pasta privada de CADA app (FS.appData): a de outro
// pacote e invisivel. A raiz /local/data (lista de nomes) segue legivel.
inline bool fsOtherAppData(const char* path) {
    static const char kData[] = "/local/data/";
    const size_t n = sizeof(kData) - 1;
    if (strncmp(path, kData, n) != 0 || path[n] == '\0') return false;
    const char* seg = path + n;
    const char* end = strchr(seg, '/');
    size_t len = end ? (size_t)(end - seg) : strlen(seg);
    return s_appPkg.empty() || len != s_appPkg.size() || strncmp(seg, s_appPkg.c_str(), len) != 0;
}

// Arquivo protegido: caminho exato, o ".tmp" da escrita atomica ao lado e a
// forma com UMA barra final. O LittleFS ignora a barra final ("/local/
// wifi.txt/" resolve para o MESMO arquivo): a comparacao exata deixava o app
// ler/gravar/apagar o wifi.txt com uma barra no fim.
inline bool fsProtectedHit(const char* path, const char* prot) {
    size_t n = strlen(prot);
    if (strncmp(path, prot, n) != 0) return false;
    const char* rest = path + n;
    if (*rest == '\0') return true;
    if (strcmp(rest, ".tmp") == 0 || strcmp(rest, ".tmp/") == 0) return true;
    return rest[0] == '/' && rest[1] == '\0';
}

// Arquivos do SISTEMA sob /local (credenciais, PIN, boot, OTA) so sao
// visiveis a apps com a capability "system". /sd e o resto de /local
// (incluindo o appData do proprio app) seguem abertos para quem tem "fs".
// Sensores de metadados (exists/isFile/...) tratam negado como "nao
// existe"; operacoes de conteudo lancam erro legivel (fsDeny no JsFs.cpp).
// Caminho nao canonico e negado para TODOS (inclusive "system"): nao ha uso
// legitimo e o fopen cru do readFile/writeFile alcancaria o VFS inteiro.
inline bool fsPathAllowed(const char* path) {
    if (!fsPathCanonical(path)) return false;
    if (perm(celer::PERM_SYSTEM)) return true;
    if (strncmp(path, "/local/", 7) != 0) return true;  // /sd
    if (fsOtherAppData(path)) return false;
    static const char* const kProtected[] = {
        "/local/wifi.txt",
        "/local/wifi.txt.migrated",
        "/local/settings_pin.txt",
        "/local/settings_pin2.bin",
        "/local/touch_cal_p.bin",
        "/local/autostart.txt",
        "/local/ota_url.txt",
        "/local/ota_allow_http.txt",
        "/local/deepseek_key.txt",   // chave da API de IA: so o framework C++ le
        "/local/openrouter_key.txt", // idem (provider do objeto AI)
        "/local/config_time.txt",
        "/local/nowifi.txt",
        "/local/web_on.txt",
        "/local/brightness.txt",
        "/local/config_install_sd.txt",
        "/local/notifications.txt",
    };
    for (const char* p : kProtected) {
        // tambem o ".tmp" da escrita atomica (writeTextFile escreve ao lado
        // e renomeia por cima: o app nao pode plantar o tmp)
        if (fsProtectedHit(path, p)) return false;
    }
    return true;
}

// Escrita/remocao/criacao: a regra de leitura + nada nas pastas de apps nem
// no cache de modulos compartilhados
inline bool fsWriteAllowed(const char* path) {
    if (!fsPathAllowed(path)) return false;
    if (perm(celer::PERM_SYSTEM)) return true;
    // Raiz de montagem e a raiz de /local/data nao sao alvo de escrita de
    // app: o rename de DIRETORIO do LittleFS e permitido, entao um
    // FS.renameFile("/local/data", ...) moveria a pasta privada de TODOS os
    // apps (e "/local" e o proprio ponto de montagem). FS.appData() cria a
    // pasta do app pelo lado C++, sem passar por aqui.
    if (fsIsMountRoot(path, "/local") || fsIsMountRoot(path, "/sd") ||
        fsIsMountRoot(path, "/local/data")) {
        return false;
    }
    return !fsUnderAppsDir(path) && !fsUnderSharedModules(path);
}

// Operacoes de ARVORE (copiar a origem): a raiz /local (credenciais, PIN,
// outros apps) e a raiz /local/data (dados de todos os apps) so para
// "system".
inline bool fsTreeAllowed(const char* path) {
    if (!fsPathCanonical(path)) return false;
    if (perm(celer::PERM_SYSTEM)) return true;
    if (fsIsMountRoot(path, "/local") || fsIsMountRoot(path, "/local/data")) return false;
    return fsPathAllowed(path);
}

// Arvore como DESTINO ou removida (copyDirectory/removeDirectory/rmdir):
// alem da leitura, nenhuma raiz de montagem (o /sd contem /sd/apps; o
// /local, os protegidos) e nada nas pastas de apps/modulos compartilhados.
inline bool fsTreeWriteAllowed(const char* path) {
    if (!fsTreeAllowed(path)) return false;
    if (perm(celer::PERM_SYSTEM)) return true;
    if (fsIsMountRoot(path, "/sd")) return false;
    return !fsUnderAppsDir(path) && !fsUnderSharedModules(path);
}
