#pragma once

/**
 * @file UpdatePolicy.h
 * @brief Politica PURA do check automatico de atualizacao (sem device).
 *
 * Era `data/apps/Nucleo/policy.js`: o "quando" do check morava no servico JS
 * do app, que o OTA de firmware NAO atualiza — um firmware novo nao conserta
 * uma politica quebrada. A partir da API 56 o `UpdateService` nativo chama
 * estas funcoes; a compatibilidade com o Nucleo antigo fica pela mesma
 * Storage (`last_check`/`noted_ver`) e pelo cache do `OtaManager`.
 *
 * Header-only e testavel no host, no molde de AlarmCalc.h/AppManifest.h.
 */

namespace celer {

struct UpdatePolicyState {
    bool wifiConnected = false;
    bool appOpen = false;   // app em foreground COM o vidro aceso (interacao)
    bool busy = false;      // check/instalacao em curso
    bool shell = false;     // sessao do celerctl/debugger ativa
    bool graceOk = false;   // passou o grace pos-(re)conexao
    bool intervalOk = false;  // passou o intervalo entre checks
};

// Gates do check automatico: WiFi no ar, sem app interativo (a definicao de
// "interativo" e do chamador: app em foreground E vidro aceso — dim conta,
// AOD/off nao, entao a casa/watchface dormindo nao bloqueia), sem check em
// curso, sem sessao celerctl, grace de 60 s e intervalo de 24 h.
inline bool updateShouldCheck(const UpdatePolicyState& st) {
    if (!st.wifiConnected || st.appOpen || st.busy || st.shell) return false;
    if (!st.graceOk) return false;
    return st.intervalOk;
}

// "1.2.3" -> tres inteiros; prefixo v/lixo vira 0 (tolerante, igual ao
// SemVer.h e ao policy.js). "-rc1"/"+build" param no primeiro nao-digito.
inline void updateSemverParts(const char* v, int out[3]) {
    out[0] = out[1] = out[2] = 0;
    if (v == nullptr) return;
    if (*v == 'v' || *v == 'V') v++;
    for (int i = 0; i < 3; i++) {
        int n = 0;
        bool any = false;
        while (*v >= '0' && *v <= '9') {
            n = n * 10 + (*v - '0');
            v++;
            any = true;
        }
        out[i] = any ? n : 0;
        if (*v != '.') break;
        v++;
    }
}

inline bool updateSemverGreater(const char* a, const char* b) {
    int pa[3], pb[3];
    updateSemverParts(a, pa);
    updateSemverParts(b, pb);
    for (int i = 0; i < 3; i++) {
        if (pa[i] > pb[i]) return true;
        if (pa[i] < pb[i]) return false;
    }
    return false;
}

// Notifica 1x por versao: disponivel maior que a ultima notificada (vazia =
// nunca notificou). Reboot nao re-notifica a mesma versao.
inline bool updateShouldNotify(const char* lastNoted, const char* availVer) {
    return availVer != nullptr && availVer[0] != '\0' &&
           updateSemverGreater(availVer, lastNoted ? lastNoted : "");
}

}  // namespace celer
