#pragma once

/**
 * @file UpdateCheck.h
 * @brief Política da verificação automática de atualização (header puro,
 * testável no host): o "quando" mora aqui, o "como" (HTTP, NVS, task) fica
 * no OtaManager.
 *
 * Regras: uma checagem por sessão de WiFi (após o grace de conexão — NTP e
 * boot assentam antes) e no máximo uma a cada 24 h. Nunca com app JS aberto
 * (o fetch disputa RAM/rede com o app), com check/instalação em curso ou
 * com sessão celerctl ativa (debug/ota push no meio seria atropelado).
 */

#include "../Utils/SemVer.h"
#include <cstdint>
#include <string>

namespace celer::updchk {

inline constexpr uint32_t kGraceMs = 60u * 1000u;            // 1 min pós-conexão
inline constexpr uint32_t kIntervalMs = 24u * 60u * 60u * 1000u;  // 24 h entre checks

struct State {
    bool wifiConnected = false;
    bool appOpen = false;          // app JS na frente (pump PRESENT)
    bool busy = false;             // checkForUpdates/performUpdate em curso
    bool shellSession = false;     // DebugBridge com sessão celerctl ativa
    bool checkedThisSession = false;  // um check já rodou desde o boot
    uint32_t sinceConnectMs = 0;   // tempo desde a ÚLTIMA conexão (0 = sem WiFi)
    uint32_t sinceLastCheckMs = 0; // válido só com checkedThisSession
};

inline bool due(const State& s) {
    if (!s.wifiConnected || s.appOpen || s.busy || s.shellSession) return false;
    if (s.sinceConnectMs < kGraceMs) return false;
    return !s.checkedThisSession || s.sinceLastCheckMs >= kIntervalMs;
}

// Notifica 1x por versão nova: a disponível é maior que a última notificada
// (vazia = nunca notificou → 0.0.0 na comparação). Re-notifica quando o hub
// publica versão mais nova ainda; reboot não re-notifica a mesma versão.
inline bool shouldNotify(const std::string& lastNotedVer, const std::string& availVer) {
    return !availVer.empty() && versionGreater(availVer, lastNotedVer);
}

}  // namespace celer::updchk
