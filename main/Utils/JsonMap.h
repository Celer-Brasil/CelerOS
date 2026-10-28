#pragma once

/**
 * @file JsonMap.h
 * @brief Leitor de objeto JSON flat {"chave": "valor", ...} (deps.json do
 * app), header-only e testavel no host (test/cpp).
 *
 * O parser antigo (FileSystem.cpp, API 30) nunca pulava o '{' de abertura
 * nem a ',' entre pares: devolvia 0 pares para QUALQUER deps.json. Efeito
 * no aparelho: o require() de dep compartilhada nunca achava o cache
 * (/local/modules) e o GC do launcher, sem nenhuma referencia, apagava as
 * versoes "orfas" — todas — a cada scan. Aqui '{', ',' e '}' sao
 * separadores; o que nao for par string:string e pulado sem derrubar o
 * resto (estilo tolerante do parseJsonValue).
 */

#include <string>

struct JsonStringPair {
    std::string key;
    std::string value;
};

namespace celer {

inline int parseJsonStringMap(const std::string& json, JsonStringPair* out, int maxPairs) {
    int count = 0;
    size_t i = 0;
    const size_t n = json.length();
    auto skipSep = [&json, &i, n]() {
        while (i < n && (json[i] == ' ' || json[i] == '\t' || json[i] == '\n' || json[i] == '\r' ||
                         json[i] == '{' || json[i] == ',')) i++;
    };
    auto skipWs = [&json, &i, n]() {
        while (i < n && (json[i] == ' ' || json[i] == '\t' || json[i] == '\n' || json[i] == '\r')) i++;
    };
    auto readString = [&json, &i, n](std::string* outStr) -> bool {
        if (i >= n || json[i] != '"') return false;
        size_t start = ++i;
        while (i < n && json[i] != '"') {
            if (json[i] == '\\' && i + 1 < n) i++;  // escape: pula o char
            i++;
        }
        if (i >= n) return false;
        *outStr = json.substr(start, i - start);
        i++;  // fecha aspa
        return true;
    };
    // pula um valor nao-string (numero, true, objeto aninhado raso) ate o
    // proximo separador do nivel de cima
    auto skipValue = [&json, &i, n]() {
        int depth = 0;
        while (i < n) {
            const char c = json[i];
            if (c == '{' || c == '[') depth++;
            else if (c == '}' || c == ']') {
                if (depth == 0) {
                    // fecha solto sem '['/'{' aberto: ']' e lixo e PRECISA sair
                    // (nao avancar aqui travava o parser para sempre em
                    // {"a":"b"] — um app.json/deps.json assim pendurava o
                    // installZip com o mutex de instalacao tomado)
                    if (c == ']') i++;
                    return;
                }
                depth--;
            } else if (c == ',' && depth == 0) return;
            i++;
        }
    };
    while (count < maxPairs && out != nullptr) {
        skipSep();
        if (i >= n || json[i] == '}') break;
        // guarda de progresso: nenhum caminho abaixo pode terminar sem
        // consumir ao menos um byte (laco infinito no parser de pacote)
        const size_t before = i;
        std::string key;
        if (!readString(&key)) {  // lixo fora de string: pula ate o proximo par
            skipValue();
            if (i < n && json[i] == '}') break;
            if (i == before) i++;
            continue;
        }
        skipWs();
        if (i >= n || json[i] != ':') {  // string solta: procura o proximo par
            if (i == before) i++;
            continue;
        }
        i++;
        skipWs();
        std::string value;
        if (!readString(&value)) {               // valor nao-string: ignora o par
            skipValue();
            continue;
        }
        out[count].key = std::move(key);
        out[count].value = std::move(value);
        count++;
    }
    return count;
}

}  // namespace celer
