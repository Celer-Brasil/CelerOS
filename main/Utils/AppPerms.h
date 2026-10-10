#pragma once

/**
 * @file AppPerms.h
 * @brief Capabilities declaradas no app.json (F4), header-only e testável
 * no host (F5). Extraído do JSBindings.h para o CI não puxar headers do
 * Duktape.
 */

#include <string>
#include <cstdint>

namespace celer {

enum AppPerm : uint32_t {
    PERM_FS     = 1u << 0,
    PERM_NET    = 1u << 1,
    PERM_GPIO   = 1u << 2,
    PERM_SYSTEM = 1u << 3,   // restart/factoryReset/OTA/web/wifiConnect
    PERM_MIC    = 1u << 4,   // gravacao de microfone (Mic.*, API 19)
    PERM_CAMERA = 1u << 5,   // captura de camera (Camera.*, API 35)
    PERM_ALL    = 0xFFFFFFFFu,
};

// "permissions": ["fs","net","gpio","system","mic","camera"] — campo ausente
// (ou array mal formado) = PERM_ALL (compat; o consentimento do launcher pede
// as seis). Array VALIDO sem nenhuma capability conhecida ("[]") = nenhuma:
// e o que o autor quis dizer — antes virava PERM_ALL.
inline uint32_t parsePermissions(const std::string& appJson) {
    size_t key = appJson.find("\"permissions\"");
    if (key == std::string::npos) return PERM_ALL;
    size_t open = appJson.find('[', key);
    size_t close = appJson.find(']', key);
    if (open == std::string::npos || close == std::string::npos || close < open) {
        return PERM_ALL;
    }
    std::string arr = appJson.substr(open, close - open);
    uint32_t m = 0;
    if (arr.find("\"fs\"") != std::string::npos) m |= PERM_FS;
    if (arr.find("\"net\"") != std::string::npos) m |= PERM_NET;
    if (arr.find("\"gpio\"") != std::string::npos) m |= PERM_GPIO;
    if (arr.find("\"system\"") != std::string::npos) m |= PERM_SYSTEM;
    if (arr.find("\"mic\"") != std::string::npos) m |= PERM_MIC;
    if (arr.find("\"camera\"") != std::string::npos) m |= PERM_CAMERA;
    return m;
}

}  // namespace celer