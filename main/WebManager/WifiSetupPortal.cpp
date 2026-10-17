#include "WifiSetupPortal.h"
#include "../USBDevice/LogSink.h"
#include "WebManager.h"
#include "CaptivePortal.h"   // componente Wifi/
#include "NetworkManager.h"
#include "../Utils/StrUtils.h"

#include "esp_mac.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// Estado compartilhado entre a task do httpd (handlers do componente) e o
// poll. Credenciais sao copiadas antes da flag; races benignas.
static CaptivePortal s_portal;
static volatile bool s_credsPending = false;
static std::string s_pendingSsid;
static std::string s_pendingPass;
static std::string s_apSsid;
static bool s_handlersBound = false;

// Conexao em task propria (mesmo formato da wifi_conn da tela local): o
// poll e chamado no onTick da tela de setup, e conectar no contexto do
// chamador travava a UI inteira por ate 15s — exatamente quando o usuario
// espera o "Conectado!" aparecer. 0 ocioso, 1 conectando, 2 ok, 3 falhou.
static volatile int s_connState = 0;
static std::string s_connIp;

// Geracao da tentativa: cada spawn incrementa; so a tarefa da geracao ATUAL
// escreve resultado. Sem isto, uma portal_conn presa que enfim retornasse
// DEPOIS de um timeout/watchdog ressuscitava estado velho ("Conectado!" de
// uma rede que o usuario ja trocou, portal derrubado na hora errada).
// Escrita so no contexto do poll/begin/end (task da UI); a portal_conn so le.
static volatile uint32_t s_connGen = 0;
static int64_t s_connStartedUs = 0;
// O connect bloqueante entrega em ~15 s (timeout fixado na task); 30 s de
// silencio = tarefa perdida (flash lenta, wifi internals presos) — o poll
// desiste dela e libera a tela para nova tentativa.
static constexpr int64_t K_CONN_WATCHDOG_US = 30LL * 1000000LL;

// ++/compound em volatile e deprecado no C++20 (build usa -Werror=volatile):
// le + soma + grava, atomico de facto aqui (unico escritor).
static uint32_t bumpGen() {
    uint32_t g = s_connGen;
    s_connGen = g + 1;
    return g;
}

struct PortalJob {
    std::string ssid, pass;
    uint32_t gen;
};

static void portalConnTask(void* arg) {
    PortalJob* job = (PortalJob*)arg;
    NetworkManager& nm = NetworkManager::instance();
    nm.getWifiConnection()->setConnectionTimeout(15000);
    ErrorCode err = nm.connect(job->ssid, job->pass, true);  // salva no NVS
    nm.getWifiConnection()->setConnectionTimeout(10000);
    if (job->gen == s_connGen) {  // geracao trocada (watchdog/nova tentativa): resultado ignorado
        if (err == CommonErrorCodes::None && nm.isConnected()) {
            s_connIp = nm.getIpAddress();  // antes do estado: poll so le apos o 2
            s_connState = 2;
        } else {
            s_connState = 3;
        }
    }
    delete job;
    vTaskDelete(nullptr);
}

bool WifiSetupPortal::begin() {
    WebManager::stopWebServer();  // a porta 80 e do portal enquanto ele vive
    WebManager::suppressServerStart(true);  // o Connected do connect NAO reabre em cima do portal

    // STA primeiro (o init do WifiConnection forca modo STA); o componente
    // promove para APSTA ao subir o AP (patch do WifiAP)
    if (NetworkManager::instance().init(true) != CommonErrorCodes::None) return false;

    // Sufixo do AP: 4 ultimos hex do MAC (softAP)
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    s_apSsid = "CelerOS-Setup-" + kstr::fmt("%X", mac[4]) + kstr::fmt("%X", mac[5]);

    CaptivePortalConfig cfg;
    cfg.apSsid = s_apSsid;
    cfg.title = "CelerOS WiFi Setup";
    cfg.deviceName = "CelerOS";
    cfg.scanOnStart = true;
    s_portal.setConfig(cfg);

    if (!s_handlersBound) {
        s_handlersBound = true;
        // Handler roda na task do httpd: so copia e seta flag
        s_portal.onCredentialsReceived.addHandler([](const WiFiCredentials& creds) {
            s_pendingSsid = creds.ssid;
            s_pendingPass = creds.password;
            s_credsPending = true;
        });
    }

    s_credsPending = false;
    bumpGen();  // tentativa anterior (se houvesse) nao reporta mais
    s_connState = 0;
    if (!s_portal.start()) {
        celer_log_println("Falha ao iniciar captive portal");
        return false;
    }
    return true;
}

WifiSetupPortal::State WifiSetupPortal::poll(std::string& detail) {
    // Resultado da task: reporta UMA vez no portal (a pagina ve pelo /status)
    if (s_connState == 2) {
        s_connState = 0;
        s_portal.reportConnectionState(PortalConnState::Connected, s_connIp);
        detail = s_connIp;
        s_portal.stop();  // APSTA -> STA (conexao preservada)
        WebManager::suppressServerStart(false);  // re-arma o servidor (web_on) no tick
        return Connected;
    }
    if (s_connState == 3) {
        s_connState = 0;
        s_portal.reportConnectionState(PortalConnState::Failed);
        return Failed;
    }
    // Watchdog: portal_conn que nunca volta nao prende a tela para sempre —
    // geracao invalidada, estado limpo, Failed reportado (a task velha, se
    // um dia acordar, cai fora pelo casamento de geracao).
    if (s_connState == 1 && esp_timer_get_time() - s_connStartedUs > K_CONN_WATCHDOG_US) {
        ESP_LOGW("celer.portal", "portal_conn preso ha 30 s: desistindo da tentativa");
        bumpGen();  // resultado tardio da task velha e ignorado
        s_connState = 0;
        s_portal.reportConnectionState(PortalConnState::Failed);
        return Failed;
    }
    if (s_connState == 1 || !s_credsPending) return Waiting;

    s_credsPending = false;
    detail = s_pendingSsid;
    s_portal.reportConnectionState(PortalConnState::Connecting);

    // O httpd do portal segue vivo na task dele respondendo /status
    PortalJob* job = new PortalJob{s_pendingSsid, s_pendingPass, bumpGen()};
    if (xTaskCreate(portalConnTask, "portal_conn", 6144, job, 5, nullptr) != pdPASS) {
        delete job;
        // geracao bumpada e morta sem task: nada para invalidar
        s_portal.reportConnectionState(PortalConnState::Failed);
        return Failed;
    }
    s_connState = 1;
    s_connStartedUs = esp_timer_get_time();
    return Waiting;
}

void WifiSetupPortal::end() {
    bumpGen();  // nenhuma tentativa em curso reporta depois daqui
    s_connState = 0;
    s_portal.stop();
    WebManager::suppressServerStart(false);
}

const char* WifiSetupPortal::apSsid() {
    return s_apSsid.c_str();
}
