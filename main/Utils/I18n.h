#pragma once

/**
 * @file I18n.h
 * @brief Strings de UI do firmware nativo em PT-BR/EN (F4).
 *
 * Idioma em CelerSettings ("lang": "pt" | "en"; default "pt"). Apps JS
 * seguem no idioma em que foram escritos — esta tabela cobre o que o
 * FIRMWARE poe na tela: splash, telas de erro do runtime, toasts de
 * diagnostico e o teclado de calibracao.
 */

#include "CelerSettings.h"
#include <cstring>

namespace i18n {

inline const char* lang() {
    static const char* cached = nullptr;
    static bool done = false;
    if (!done) {
        done = true;
        cached = strdup(CelerSettings::get("lang", "pt").c_str());
        // strdup sem RAM volta nullptr e o strcmp do TR derrubaria o aparelho:
        // literal estatico, sem alocacao
        if (cached == nullptr) cached = "pt";
    }
    return cached;
}

// TR(pt, en): escolhe no ponto de uso (sem tabela global — cada string vive
// ao lado do codigo que a usa)
inline const char* TR(const char* pt, const char* en) {
    return strcmp(lang(), "en") == 0 ? en : pt;
}

}  // namespace i18n
