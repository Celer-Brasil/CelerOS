#include "Services.h"

#include <Arduino.h>

#if CONFIG_CELEROS_UI
#include "../../UI/Kui.h"
#endif
#include "../../WebManager/WebManager.h"
#include "../../Kernel/TimeManager.h"
#include "../../Kernel/Alarms.h"
#include "../../Kernel/AppServices.h"
#include "../../Kernel/Notifications.h"
#include "../../Display/Backlight.h"
#if CONFIG_CELEROS_UI
#include "../../Display/ScreenCapture.h"
#endif
#include "../../Display/ScreenPower.h"
#include "../../Hardware/Buttons.h"
#include "../../Hardware/PowerPolicy.h"
#include "../../Launcher/LauncherUI.h"
#if CONFIG_CELEROS_UI
#include "../../Launcher/AlarmScreen.h"
#include "../../Launcher/WatchPanels.h"
#include "../../Launcher/NotificationAlert.h"
#endif
#include "../../USBDevice/LogPersist.h"
#include "../../USBDevice/DebugBridge.h"
#include "../../OTA/OtaManager.h"
#if CONFIG_CELEROS_BLUETOOTH
#include "../../Bluetooth/CelerNet.h"
#include "../../Pack/Pack.h"
#endif
#if CONFIG_CELEROS_PHONE_LINK
#include "../../Bluetooth/PhoneLink.h"
#include "../../Launcher/PhoneScreens.h"
#endif

// main.cpp: confirmacao do slot OTA apos 30s de boot sao
void confirmPendingOta();

namespace {

#if CONFIG_CELEROS_UI
void svcNavigator(bool) { kui::Navigator::tick(); }
#endif
void svcWebManager(bool) { WebManager::tick(); }
void svcTimeManager(bool) { TimeManager::tick(WebManager::isActive()); }
void svcBacklight(bool) { Backlight::tick(); }
#if CONFIG_CELEROS_UI
void svcScreenCapture(bool) { ScreenCapture::service(); }
#endif
void svcButtons(bool inApp) { Buttons::tick(inApp); }
void svcScreenPower(bool inApp) { ScreenPower::tick(inApp); }
void svcIdleHome(bool) { LauncherUI::idleHomeTick(); }
#if CONFIG_CELEROS_UI
void svcAlarmScreen(bool) { AlarmScreen::service(); }
void svcWatchPanels(bool) { WatchPanels::service(); }
#endif
void svcPowerPolicy(bool) { PowerPolicy::tick(); }
#if CONFIG_CELEROS_PHONE_LINK
void svcPhoneLink(bool inApp) { PhoneLink::tick(inApp); }
void svcPhoneScreens(bool inApp) { PhoneScreens::service(inApp); }
#endif
#if CONFIG_CELEROS_BLUETOOTH
// Malha CelerNet: infraestrutura (sobrevive a troca de app) — scanner,
// bursts de repeticao e presenca; o JS drena com CelerNet.poll().
void svcCelerNet(bool) { CelerNet::tick(); }
// Matilha (Pack): caps no BEAT, envelopes do OS e handoff de musica —
// depois do celernet na fila: consume no MESMO giro o que o tick da malha
// acabou de receber.
void svcPack(bool) { Pack::tick(); }
#endif
#if CONFIG_CELEROS_UI
void svcNotificationAlert(bool inApp) { NotificationAlert::service(inApp); }
#else
// Launcher invisivel: sem o LauncherScreen (fora do build sem vidro), este
// servico e quem CONSUME os pedidos de lancamento — sem ele o gc-sections
// descartava a cadeia inteira (takeLaunchRequest -> launchApp -> runApp ->
// CelerKernel::runFile -> JSBindings::init) e o binario ficava SEM o
// runtime JS (devkit/cam construidos assim nao abriam app nenhum; pegado
// no size + strings do bin, a bancada ainda pendente).
// Consome: autostart do boot (applyAutostart -> requestLaunch), `run` do
// shell/celerctl, System.launchApp de outro app, botao home do perfil.
void svcLauncherHeadless(bool) {
    if (LauncherUI::needsRescan) {
        LauncherUI::scanLocalApps();
        LauncherUI::needsRescan = false;
    }
    std::string req;
    if (!LauncherUI::takeLaunchRequest(req)) return;
    if (LauncherUI::appRunning()) return;  // app vivo: o pedido espera a saida
    const int idx = LauncherUI::findEntry(req);
    if (idx >= 0) LauncherUI::launchApp(idx);
}
#endif
void svcOtaConfirm(bool) { confirmPendingOta(); }
// LogPersist (kern.log/apps.log): flush a cada ~3 s — ALWAYS para roda com
// app aberto (o teste de voz do cao acontece DENTRO do Dog Face)
void svcLogPersist(bool) { LogPersist::tick(); }
// ALWAYS: com app aberto o bridge segue vivo (logcat/debug de um app em run)
void svcDebugBridge(bool inApp) { DebugBridge::tick(inApp); }

// Alarmes/timer (Kernel/Alarms) conferidos 1x/s ANTES do corte do AOD: com a
// tela apagada/AOD (o normal no watchface) o alarme toca do mesmo jeito. O
// toque e a AlarmScreen nativa: o app sai pelo caminho limpo do X e o
// launcher a empilha (AlarmScreen::service).
void svcAlarmsCheck(bool) {
    static uint32_t s_alarmCheckAt = 0;
    const uint32_t nowA = millis();
    if (nowA - s_alarmCheckAt >= 1000) {
        s_alarmCheckAt = nowA;
        if (Alarms::tick()) LauncherUI::requestAppExit();
    }
}

// Gravacao adiada do historico de notificacoes (push vem da task do BLE).
void svcNotifications(bool) { Notifications::tick(); }

// A lista e a arquitetura: UM lugar, OS DOIS pumps (celerLoop e present()).
// A ordem preserva a relativa de cada contexto. Diferenca consciente vs o
// celerLoop antigo: NotificationAlert roda DEPOIS de PowerPolicy/PhoneLink
// no contexto LOOP (antes era antes do PowerPolicy) — o pedido de
// acordar/abrir a tela e visto pelo PowerPolicy uma volta depois (~ms).
const CelerServices::Service kServices[] = {
#if CONFIG_CELEROS_UI
    {"navigator", svcNavigator, CelerServices::LOOP},
#else
    // substituto do launcher visual: consumidor dos pedidos de lancamento
    {"launcher", svcLauncherHeadless, CelerServices::LOOP},
#endif
    // ALWAYS: se o evictRunningApp esgota os 2 s com o app aberto, o pump
    // LOOP nao volta a rodar — o reboot do upload web drena tambem pelo
    // PRESENT (o corpo do tick e so isso; ver WebManager::tick).
    {"webmanager", svcWebManager, CelerServices::ALWAYS},
    // ALWAYS: os deveres do TimeManager (retry de SNTP, saveEpoch, gravacao
    // unica do RTC externo) precisam seguir vivos com app aberto — LOOP only
    // congelava tudo (e no watch com home-app o celerLoop nem roda).
    {"timemanager", svcTimeManager, CelerServices::ALWAYS},
    {"backlight", svcBacklight, CelerServices::ALWAYS},
#if CONFIG_CELEROS_UI
    // present() chama o SEU ScreenCapture depois do corte do AOD
    // (suppressAppFrame): captura durante AOD com app aberto continua
    // sendo servida so quando o vidro acorda — comportamento preservado.
    {"screencapture", svcScreenCapture, CelerServices::LOOP},
#endif
    {"buttons", svcButtons, CelerServices::ALWAYS},
    {"screenpower", svcScreenPower, CelerServices::ALWAYS},
    {"idlehome", svcIdleHome, CelerServices::LOOP},
#if CONFIG_CELEROS_UI
    {"alarmscreen", svcAlarmScreen, CelerServices::LOOP},
    {"watchpanels", svcWatchPanels, CelerServices::LOOP},
#endif
    {"powerpolicy", svcPowerPolicy, CelerServices::ALWAYS},
#if CONFIG_CELEROS_PHONE_LINK
    {"phonelink", svcPhoneLink, CelerServices::ALWAYS},
    {"phonescreens", svcPhoneScreens, CelerServices::LOOP},
#endif
#if CONFIG_CELEROS_BLUETOOTH
    {"celernet", svcCelerNet, CelerServices::ALWAYS},
    {"pack", svcPack, CelerServices::ALWAYS},
#endif
#if CONFIG_CELEROS_APP_SERVICES
    // Servicos em segundo plano de APPS instalados (API 42): depois do pack
    // — consome no mesmo giro o que a malha acabou de receber (Regras), com
    // orcamento de ms para nao roubar o vidro do app em foreground.
    {"appsvc", [](bool inApp) { AppServices::tick(inApp); }, CelerServices::ALWAYS},
#endif
#if CONFIG_CELEROS_UI
    {"notificationalert", svcNotificationAlert, CelerServices::ALWAYS},
#endif
    {"otaconfirm", svcOtaConfirm, CelerServices::ALWAYS},
    // "updcheck" saiu: a politica do check automatico e o servico JS do app
    // Nucleo (data/apps/Nucleo/service.js, API 42) sobre System.otaCheck.
    {"logpersist", svcLogPersist, CelerServices::ALWAYS},
    {"notifications", svcNotifications, CelerServices::ALWAYS},
    {"dbgbridge", svcDebugBridge, CelerServices::ALWAYS},
    // fim da fila no present(): erro no callback de alarme nao pula o resto
    {"alarmscheck", svcAlarmsCheck, CelerServices::PRESENT},
};
constexpr int kServiceCount = (int)(sizeof(kServices) / sizeof(kServices[0]));

}  // namespace

void CelerServices::tickLoop() {
    for (int i = 0; i < kServiceCount; i++) {
        if (kServices[i].ctx & LOOP) kServices[i].tick(false);
    }
}

void CelerServices::tickPresent() {
    for (int i = 0; i < kServiceCount; i++) {
        if (kServices[i].ctx & PRESENT) kServices[i].tick(true);
    }
}
