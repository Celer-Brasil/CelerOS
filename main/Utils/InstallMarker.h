#ifndef INSTALL_MARKER_H
#define INSTALL_MARKER_H

#include <string>
#include "SemVer.h"

/**
 * @file InstallMarker.h
 * @brief Politica do script de instalacao do app (install.sh): roda UMA vez
 * por versao. O marcador (versao ja processada) vive fora da pasta do app —
 * o pacote novo substitui a pasta inteira — em CelerSettings ("setup_<pkg>",
 * namespace "settings"). Header puro, testavel no host (test/cpp).
 */

namespace celer::setup {

// true quando o script precisa rodar: versao instalada valida e (nunca rodou
// ou a versao instalada e MAIOR que a processada — downgrade nao re-roda).
inline bool due(const std::string& installedVer, const std::string& doneVer) {
    if (installedVer.empty()) return false;
    return doneVer.empty() || versionGreater(installedVer, doneVer);
}

}  // namespace celer::setup

#endif  // INSTALL_MARKER_H
