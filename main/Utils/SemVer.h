#pragma once

/**
 * @file SemVer.h
 * @brief Comparador de versões simples (x.y.z), header-only e testável no
 * host (F5): extraído do OtaManager.cpp para poder rodar no CI sem ESP-IDF.
 */

#include <string>
#include <cstdlib>

namespace celer {

namespace semver_detail {

struct Parts {
    int num[3] = {0, 0, 0};
    std::string pre;  // pre-release ("": versao final); "+build" e ignorado
};

inline void parse(const std::string& v, Parts* out) {
    std::string core = v;
    const size_t plus = core.find('+');  // metadados de build nao comparam
    if (plus != std::string::npos) core.resize(plus);
    const size_t dash = core.find('-');
    if (dash != std::string::npos) {
        out->pre = core.substr(dash + 1);
        core.resize(dash);
    }
    int pt = 0, st = 0;
    while (pt < 3 && st < (int)core.length()) {
        int d = (int)core.find('.', st);
        if (d == -1 || d == (int)std::string::npos) {
            out->num[pt] = atoi(core.substr(st).c_str());
            break;
        }
        out->num[pt] = atoi(core.substr(st, d - st).c_str());
        st = d + 1;
        pt++;
    }
}

inline bool numericField(const std::string& f) {
    if (f.empty()) return false;
    for (char c : f) {
        if (c < '0' || c > '9') return false;
    }
    return true;
}

// Compara duas pre-releases campo a campo (SemVer 11): campo numerico compara
// por valor (rc10 > rc9), numerico < alfanumerico e menos campos = menor.
inline int cmpPre(const std::string& a, const std::string& b) {
    size_t ia = 0, ib = 0;
    for (;;) {
        const bool endA = ia >= a.size(), endB = ib >= b.size();
        if (endA && endB) return 0;
        if (endA) return -1;
        if (endB) return 1;
        size_t ea = a.find('.', ia);
        if (ea == std::string::npos) ea = a.size();
        size_t eb = b.find('.', ib);
        if (eb == std::string::npos) eb = b.size();
        const std::string fa = a.substr(ia, ea - ia), fb = b.substr(ib, eb - ib);
        const bool na = numericField(fa), nb = numericField(fb);
        if (na && nb) {
            const long long va = strtoll(fa.c_str(), nullptr, 10);
            const long long vb = strtoll(fb.c_str(), nullptr, 10);
            if (va != vb) return va < vb ? -1 : 1;
        } else if (na != nb) {
            return na ? -1 : 1;  // numerico tem precedencia menor
        } else {
            const int c = fa.compare(fb);
            if (c != 0) return c < 0 ? -1 : 1;
        }
        ia = ea + 1;
        ib = eb + 1;
    }
}

}  // namespace semver_detail

inline bool versionGreater(const std::string& newVer, const std::string& oldVer) {
    semver_detail::Parts a, b;
    semver_detail::parse(newVer, &a);
    semver_detail::parse(oldVer, &b);
    for (int i = 0; i < 3; i++) {
        if (a.num[i] != b.num[i]) return a.num[i] > b.num[i];
    }
    // Mesmo nucleo numerico: a versao FINAL e maior que qualquer pre-release
    // (1.0.0 > 1.0.0-rc1) e duas pre-releases comparam campo a campo. Antes o
    // sufixo era descartado: um aparelho em 1.0.0-rc1 nunca via a 1.0.0 final
    // e rc2 nunca substituia rc1 (o OTA dizia "sem atualizacao").
    if (a.pre.empty() != b.pre.empty()) return a.pre.empty();
    if (a.pre.empty()) return false;
    return semver_detail::cmpPre(a.pre, b.pre) > 0;
}

}  // namespace celer
