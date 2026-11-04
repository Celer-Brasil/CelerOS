#pragma once

/**
 * @file AppManifest.h
 * @brief Campos do app.json que o RUNTIME valida no aparelho.
 *
 * O hub, o app_lint e a Loja ja validam o manifesto; este header repete a
 * regra no firmware para que um pacote que nao passou por eles (cartao SD,
 * `celerctl apps install`, `installZip`) nao entre em vigor com um contrato
 * que o runtime nao le. Antes, `api` era ignorado no lancamento e um app
 * incompativel morria com TypeError; `main` era validado na instalacao e
 * ignorado aqui (sempre main.js).
 *
 * Sem parser JSON completo: as chaves de topo sao procuradas FORA de string
 * (um `"api": 99` dentro de `description` nao vale) e os valores tem teto e
 * alfabeto. Header-only e testavel no host, no molde de AppPerms.h/SemVer.h.
 */

#include <string>
#include <cstdint>
#include <cstring>

namespace celer {

struct AppManifest {
    bool hasApi = false;
    int api = 0;              // 0 = ausente; hasApi distingue de "ilegivel"
    bool apiInvalid = false;  // presente e fora de 1..999 (ou nao numerico)
    std::string main = "main.js";  // entry flat dentro da pasta do app
    bool mainInvalid = false;      // "main" presente e invalido (cai no default)
    std::string version;           // "" = ausente/invalida (nao bloqueia)
    bool requiresPsram = false;
    bool isSystem = false;         // "system": true (app de sistema/protegido)
    std::string id;                // packageName ("" = ausente/invalido)
};

namespace app_manifest_detail {

inline bool isSpace(char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

// Posicao do VALOR da chave de TOPO (depois do ':'), pulando literais de
// string e objetos/arrays aninhados. Um `"api":` dentro de um valor string ou
// de um objeto interno (`"extra":{"api":77}`) nao casa. Devolve false se a
// chave nao existe ou o literal esta malformado.
inline bool keyValuePos(const std::string& js, const char* key, size_t& pos) {
    const size_t klen = strlen(key);
    size_t i = 0;
    int depth = 0;
    while (i < js.size()) {
        const char c = js[i];
        if (c != '"') {
            if (c == '{' || c == '[') depth++;
            else if (c == '}' || c == ']') depth--;
            i++;
            continue;
        }
        // Le o literal inteiro (com escape) e compara com a chave.
        size_t j = i + 1;
        std::string lit;
        bool esc = false;
        for (; j < js.size(); j++) {
            const char d = js[j];
            if (esc) { lit += d; esc = false; continue; }
            if (d == '\\') { esc = true; continue; }
            if (d == '"') break;
            lit += d;
        }
        if (j >= js.size()) return false;  // literal sem fechamento
        if (depth == 1 && lit.size() == klen && memcmp(lit.data(), key, klen) == 0) {
            size_t c2 = j + 1;
            while (c2 < js.size() && isSpace(js[c2])) c2++;
            if (c2 < js.size() && js[c2] == ':') {
                pos = c2 + 1;
                return true;
            }
        }
        i = j + 1;
    }
    return false;
}

// Valor string na posicao: aceita os escapes JSON usuais; \uXXXX e recusado
// (nenhum campo do manifesto precisa dele e aceitar seria inventar regra).
inline bool readString(const std::string& js, size_t pos, std::string& out) {
    while (pos < js.size() && isSpace(js[pos])) pos++;
    if (pos >= js.size() || js[pos] != '"') return false;
    pos++;
    out.clear();
    while (pos < js.size()) {
        const char c = js[pos++];
        if (c == '"') return true;
        if (c == '\\') {
            if (pos >= js.size()) return false;
            switch (js[pos++]) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                default: return false;
            }
        } else {
            out += c;
        }
        if (out.size() > 128) return false;  // valor de manifesto e curto
    }
    return false;
}

// Inteiro na posicao. Fracao/expoente (`1.5`, `1e3`) e recusado: o campo do
// manifesto e um nivel de API inteiro, e aceitar 1e3 como 1 esconderia um
// valor fora do contrato.
inline bool readInt(const std::string& js, size_t pos, int& out) {
    while (pos < js.size() && isSpace(js[pos])) pos++;
    bool neg = false;
    if (pos < js.size() && js[pos] == '-') { neg = true; pos++; }
    if (pos >= js.size() || js[pos] < '0' || js[pos] > '9') return false;
    long v = 0;
    while (pos < js.size() && js[pos] >= '0' && js[pos] <= '9') {
        v = v * 10 + (js[pos++] - '0');
        if (v > 9999) return false;
    }
    if (pos < js.size() && (js[pos] == '.' || js[pos] == 'e' || js[pos] == 'E')) return false;
    out = (int)(neg ? -v : v);
    return true;
}

// Booleano JSON literal na posicao (true/false, sem aspas).
inline bool readBool(const std::string& js, size_t pos, bool& out) {
    while (pos < js.size() && isSpace(js[pos])) pos++;
    if (js.compare(pos, 4, "true") == 0) { out = true; return true; }
    if (js.compare(pos, 5, "false") == 0) { out = false; return true; }
    return false;
}

inline bool arrayHas(const std::string& js, const char* key, const char* token) {
    size_t pos = 0;
    if (!keyValuePos(js, key, pos)) return false;
    while (pos < js.size() && isSpace(js[pos])) pos++;
    if (pos >= js.size() || js[pos] != '[') return false;
    const size_t close = js.find(']', pos);
    if (close == std::string::npos) return false;
    // O array so tem strings: procurar o literal exato nao casa "xpsram".
    std::string lit = "\"";
    lit += token;
    lit += '"';
    return js.find(lit, pos) != std::string::npos &&
           js.find(lit, pos) < close;
}

// Entry do app: arquivo flat .js dentro da pasta, sem caminho e sem "..".
inline bool validEntryName(const std::string& s) {
    if (s.size() < 4 || s.size() > 64) return false;  // .js no minimo
    if (s.compare(s.size() - 3, 3, ".js") != 0) return false;
    if (s[0] == '.' || s.find("..") != std::string::npos) return false;
    for (char c : s) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                        (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
        if (!ok) return false;
    }
    return true;
}

// packageName: identidade do app (mesmo alfabeto que o launcher aceita como
// caminho de /local/data/<pkg>). "" = ausente/invalido.
inline bool validPackageId(const std::string& s) {
    if (s.empty() || s.size() > 64) return false;
    if (s.find("..") != std::string::npos) return false;
    for (char c : s) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                        (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
        if (!ok) return false;
    }
    return true;
}

inline bool validVersion(const std::string& s) {
    if (s.empty() || s.size() > 32) return false;
    for (char c : s) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                        (c >= '0' && c <= '9') || c == '.' || c == '+' || c == '-';
        if (!ok) return false;
    }
    return true;
}

}  // namespace app_manifest_detail

/**
 * @brief Le os campos que o runtime aplica (api, main, version, requires).
 *
 * Tolerante com o passado: campo ausente nao invalida o app (o lint/hub
 * cobram no publish). Campo PRESENTE e invalido e marcado para o chamador
 * decidir (hoje: `api` ilegivel bloqueia o lancamento com mensagem; `main`
 * invalido cai no default main.js; `version` invalida vira "").
 */
inline AppManifest parseAppManifest(const std::string& appJson) {
    AppManifest m;
    size_t pos = 0;

    if (app_manifest_detail::keyValuePos(appJson, "api", pos)) {
        m.hasApi = true;
        int api = 0;
        if (!app_manifest_detail::readInt(appJson, pos, api) || api < 1 || api > 999) {
            m.apiInvalid = true;
        } else {
            m.api = api;
        }
    }

    if (app_manifest_detail::keyValuePos(appJson, "main", pos)) {
        std::string entry;
        if (!app_manifest_detail::readString(appJson, pos, entry) ||
            !app_manifest_detail::validEntryName(entry)) {
            m.mainInvalid = true;
        } else {
            m.main = entry;
        }
    }

    if (app_manifest_detail::keyValuePos(appJson, "version", pos)) {
        std::string v;
        if (app_manifest_detail::readString(appJson, pos, v) &&
            app_manifest_detail::validVersion(v)) {
            m.version = v;
        }
    }

    if (app_manifest_detail::keyValuePos(appJson, "packageName", pos)) {
        std::string id;
        if (app_manifest_detail::readString(appJson, pos, id) &&
            app_manifest_detail::validPackageId(id)) {
            m.id = id;
        }
    }

    m.requiresPsram = app_manifest_detail::arrayHas(appJson, "requires", "psram");

    // "system": true (booleano; a string "true" NAO vale — o app.json real
    // usa booleano e aceitar string divergiria do resto do ecossistema).
    if (app_manifest_detail::keyValuePos(appJson, "system", pos)) {
        bool sys = false;
        if (app_manifest_detail::readBool(appJson, pos, sys)) m.isSystem = sys;
    }
    return m;
}

}  // namespace celer
