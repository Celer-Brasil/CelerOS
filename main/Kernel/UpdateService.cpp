#include "UpdateService.h"

#include <Arduino.h>
#include "../Boards/Board.h"
#include "../OTA/OtaManager.h"
#include "../Launcher/LauncherUI.h"
#include "../USBDevice/DebugBridge.h"
#include "../Runtime/JSBindings.h"
#include "../Utils/UpdatePolicy.h"
#include "../WebManager/WebManager.h"
#include "../Display/ScreenPower.h"
#include "../Display/Backlight.h"
#include "../USBDevice/LogSink.h"  // celer_log_printf
#include "Notifications.h"

namespace {

constexpr uint32_t kTickMs = 1000;
constexpr uint32_t kGraceMs = 60000;                  // 60 s pos-(re)conexao
constexpr uint32_t kIntervalMs = 24UL * 3600UL * 1000UL;  // 24 h por sessao
constexpr const char* kNucleoPkg = "celeros.nucleo";  // painel do Nucleo

uint32_t s_lastTick = 0;
uint32_t s_connectedAt = 0;
bool s_wasConnected = false;
uint32_t s_lastCheck = 0;
bool s_didCheck = false;

// Diferenca de millis robusta ao wrap de 32 bits.
inline bool elapsed(uint32_t now, uint32_t since, uint32_t ms) {
    return (int32_t)(now - since) >= (int32_t)ms;
}

}  // namespace

namespace UpdateService {

void tick() {
    const uint32_t now = millis();
    if (!elapsed(now, s_lastTick, kTickMs)) return;
    s_lastTick = now;

    const bool connected = WebManager::isWifiConnected();
    if (connected && !s_wasConnected) s_connectedAt = now;  // ancora o grace
    s_wasConnected = connected;

    celer::UpdatePolicyState st;
    st.wifiConnected = connected;
    // App em foreground SO bloqueia com o vidro ACESO (mesma definicao de
    // System.isScreenOn: dim conta, AOD/off nao). Casa em AOD/tela apagada
    // (watchface) nao e interacao: o check roda sem congelar nada visivel —
    // antes o app da casa bloqueava o check para sempre. Aparelho com a tela
    // sempre acesa (screen_timeout 0) continua checando no launcher.
    const bool screenOn = !Backlight::isOff() && ScreenPower::state() >= 2;
    st.appOpen = LauncherUI::appRunning() && screenOn;
    st.busy = OtaManager::checkBusy();
    st.shell = DebugBridge::sessionActive();
    st.graceOk = connected && elapsed(now, s_connectedAt, kGraceMs);
    st.intervalOk = !s_didCheck || elapsed(now, s_lastCheck, kIntervalMs);
    if (!celer::updateShouldCheck(st)) return;

    // Marca ANTES do fetch: uma falha tambem conta, senao o hub caido seria
    // martelado a cada tick (mesma decisao do Nucleo/policy.js).
    s_didCheck = true;
    s_lastCheck = now;
    celer_log_println("[update] check automatico (servico nativo)");

    // useCache: se o Nucleo antigo (service.js) acabou de checar, este tick
    // reaproveita o resultado em vez de abrir outra TLS no hub.
    OtaManager::checkForUpdates(/*useCache=*/true);
    const OtaUpdateInfo& info = OtaManager::info;

    // Painel do Nucleo: mesmas chaves da Storage do app ("falha"/"-"/versao).
    // Manifesto recusado (assinatura/api/variante) tambem e falha visivel.
    const char* status = (info.fetchFailed || info.rejected)
                             ? "falha"
                             : (info.available ? info.version.c_str() : "-");
    JSBindings::storageSetFor(kNucleoPkg, "last_check", status);

    if (!info.fetchFailed && !info.rejected && info.available && !info.version.empty()) {
        const std::string noted = JSBindings::storageGetFor(kNucleoPkg, "noted_ver");
        if (celer::updateShouldNotify(noted.c_str(), info.version.c_str())) {
            const std::string body = info.changelog.empty()
                                         ? std::string("Nova versao disponivel.")
                                         : info.changelog;
            Notifications::push("Atualizacao " + info.version, body);
            // Grava depois do push: o Nucleo antigo le a mesma chave e nao
            // re-notifica a mesma versao.
            JSBindings::storageSetFor(kNucleoPkg, "noted_ver", info.version.c_str());
        }
    }
}

}  // namespace UpdateService
