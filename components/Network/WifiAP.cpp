#include "WifiAP.h"

#include "NetworkTypes.h"

#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_log.h"
#include "lwip/inet.h"

#include <cstring>
#include <cstdio>

namespace {

// Cliente do AP a partir do MAC reportado pela lista ou pelos eventos.
WifiAPClientInfo makeClientInfo(const uint8_t* mac, int8_t rssi) {
    WifiAPClientInfo info;
    memcpy(info.mac, mac, 6);
    char mac_str[18];
    macToString(info.mac, mac_str);
    info.macString = mac_str;
    info.rssi = rssi;
    return info;
}

} // namespace

WifiAP* WifiAP::_instance = nullptr;

WifiAP::WifiAP() :
    _state(WifiAPState::Stopped),
    _netif(nullptr),
    _wifiInitialized(false) {
    _instance = this;
}

WifiAP::~WifiAP() {
    stop();
    _instance = nullptr;
}

WifiAP& WifiAP::instance() {
    static WifiAP instance;
    return instance;
}

bool WifiAP::start(const std::string& ssid) {
    WifiAPConfig config;
    config.ssid = ssid;
    config.password = "";
    return start(config);
}

bool WifiAP::start(const std::string& ssid, const std::string& password) {
    WifiAPConfig config;
    config.ssid = ssid;
    config.password = password;
    return start(config);
}

bool WifiAP::start(const WifiAPConfig& config) {
    if (_state == WifiAPState::Running) {
        ESP_LOGW(TAG, "AP already running");
        return true;
    }

    _config = config;
    setState(WifiAPState::Starting);

    ESP_LOGI(TAG, "Starting AP: %s", _config.ssid.c_str());

    // Initialize WiFi
    if (!initWifi()) {
        setState(WifiAPState::Error);
        return false;
    }

    // Configure network
    if (!configureNetwork()) {
        setState(WifiAPState::Error);
        return false;
    }

    // Configure AP
    wifi_config_t wifi_config = {};
    
    // Copy SSID
    strncpy(reinterpret_cast<char*>(wifi_config.ap.ssid),
            _config.ssid.c_str(),
            sizeof(wifi_config.ap.ssid) - 1);
    // Tamanho do que foi DE FATO copiado (o strncpy acima para em 31): o
    // length() cru dizia mais que os bytes gravados e, se a string viesse
    // maior, ainda embrulhava no uint8_t
    wifi_config.ap.ssid_len = static_cast<uint8_t>(
        strnlen(reinterpret_cast<const char*>(wifi_config.ap.ssid),
                sizeof(wifi_config.ap.ssid)));

    // Configure security
    if (_config.password.empty()) {
        wifi_config.ap.authmode = WIFI_AUTH_OPEN;
        ESP_LOGI(TAG, "AP mode: Open (no password)");
    } else if (_config.password.length() < 8) {
        ESP_LOGE(TAG, "Password too short (min 8 chars for WPA2)");
        setState(WifiAPState::Error);
        return false;
    } else {
        strncpy(reinterpret_cast<char*>(wifi_config.ap.password),
                _config.password.c_str(),
                sizeof(wifi_config.ap.password) - 1);
        wifi_config.ap.authmode = WIFI_AUTH_WPA2_PSK;
        ESP_LOGI(TAG, "AP mode: WPA2-PSK");
    }

    wifi_config.ap.channel = _config.channel;
    wifi_config.ap.max_connection = _config.maxConnections;
    wifi_config.ap.ssid_hidden = _config.hidden ? 1 : 0;
    wifi_config.ap.beacon_interval = _config.beaconInterval;
    wifi_config.ap.pmf_cfg.required = false;

    // Set mode to AP — ou APSTA quando o STA ja esta ativo (captive portal
    // aberto por um dispositivo conectado nao pode derrubar a estacao)
    wifi_mode_t curMode = WIFI_MODE_NULL;
    esp_wifi_get_mode(&curMode);
    bool staActive = (curMode == WIFI_MODE_STA) || (curMode == WIFI_MODE_APSTA);
    esp_err_t err = esp_wifi_set_mode(staActive ? WIFI_MODE_APSTA : WIFI_MODE_AP);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to set WiFi mode: %s", esp_err_to_name(err));
        setState(WifiAPState::Error);
        return false;
    }

    // Apply configuration
    err = esp_wifi_set_config(WIFI_IF_AP, &wifi_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to set AP config: %s", esp_err_to_name(err));
        setState(WifiAPState::Error);
        return false;
    }

    // Start WiFi
    err = esp_wifi_start();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start WiFi: %s", esp_err_to_name(err));
        setState(WifiAPState::Error);
        return false;
    }

    setState(WifiAPState::Running);
    ESP_LOGI(TAG, "AP started: %s on channel %d", _config.ssid.c_str(), _config.channel);
    ESP_LOGI(TAG, "AP IP: %s", getIPAddress().c_str());

    return true;
}

bool WifiAP::stop() {
    if (_state == WifiAPState::Stopped) {
        return true;
    }

    setState(WifiAPState::Stopping);
    ESP_LOGI(TAG, "Stopping AP...");

    // Em APSTA o STA continua de pe — so derruba o AP. So para o radio
    // inteiro quando o AP era o unico modo ativo. E se o AP NEM CHEGOU a
    // subir (start falhou antes do set_mode, ex. senha curta -> estado
    // Error), o modo segue STA: dar esp_wifi_stop() aqui derrubava a
    // estacao que nada tem a ver com o AP.
    wifi_mode_t curMode = WIFI_MODE_NULL;
    esp_wifi_get_mode(&curMode);
    esp_err_t err;
    if (curMode == WIFI_MODE_APSTA) {
        err = esp_wifi_set_mode(WIFI_MODE_STA);
    } else if (curMode == WIFI_MODE_AP) {
        err = esp_wifi_stop();
    } else {
        err = ESP_OK;  // AP nunca ativou o radio: nada a fazer
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to stop WiFi: %s", esp_err_to_name(err));
    }

    setState(WifiAPState::Stopped);

    ESP_LOGI(TAG, "AP stopped");
    return true;
}

bool WifiAP::initWifi() {
    if (_wifiInitialized) {
        return true;
    }

    // TCP/IP stack + event loop (idempotente, compartilhado com a STA)
    esp_err_t err = netCoreInit();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init netif/event loop: %s", esp_err_to_name(err));
        return false;
    }

    // Create AP network interface
    if (_netif == nullptr) {
        _netif = esp_netif_create_default_wifi_ap();
        if (_netif == nullptr) {
            ESP_LOGE(TAG, "Failed to create AP netif");
            return false;
        }
    }

    // Initialize WiFi with default config
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&cfg);
    if (err != ESP_OK && err != ESP_ERR_WIFI_INIT_STATE) {
        ESP_LOGE(TAG, "Failed to init WiFi: %s", esp_err_to_name(err));
        return false;
    }

    // Register event handlers
    err = esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                              eventHandler, this, nullptr);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(TAG, "Event handler registration: %s", esp_err_to_name(err));
    }

    _wifiInitialized = true;
    return true;
}

bool WifiAP::configureNetwork() {
    if (_netif == nullptr) {
        return false;
    }

    esp_netif_t* netif = static_cast<esp_netif_t*>(_netif);

    // Stop DHCP server before changing config
    esp_netif_dhcps_stop(netif);

    // Set IP info
    esp_netif_ip_info_t ip_info;
    memset(&ip_info, 0, sizeof(ip_info));
    
    ip_info.ip.addr = ipaddr_addr(_config.ipAddress.c_str());
    ip_info.gw.addr = ipaddr_addr(_config.gateway.c_str());
    ip_info.netmask.addr = ipaddr_addr(_config.netmask.c_str());

    esp_err_t err = esp_netif_set_ip_info(netif, &ip_info);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to set IP info: %s", esp_err_to_name(err));
        return false;
    }

    // Start DHCP server
    err = esp_netif_dhcps_start(netif);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start DHCP server: %s", esp_err_to_name(err));
        return false;
    }

    return true;
}

int WifiAP::getConnectedClients() const {
    wifi_sta_list_t sta_list;
    if (esp_wifi_ap_get_sta_list(&sta_list) != ESP_OK) {
        return 0;
    }
    return sta_list.num;
}

std::vector<WifiAPClientInfo> WifiAP::getClientList() const {
    std::vector<WifiAPClientInfo> clients;
    
    wifi_sta_list_t sta_list;
    if (esp_wifi_ap_get_sta_list(&sta_list) != ESP_OK) {
        return clients;
    }

    for (int i = 0; i < sta_list.num; i++) {
        clients.push_back(makeClientInfo(sta_list.sta[i].mac, sta_list.sta[i].rssi));
    }

    return clients;
}

std::string WifiAP::getIPAddress() const {
    if (_netif == nullptr) {
        return _config.ipAddress;
    }

    esp_netif_ip_info_t ip_info;
    if (esp_netif_get_ip_info(static_cast<esp_netif_t*>(_netif), &ip_info) != ESP_OK) {
        return _config.ipAddress;
    }

    char ip_str[16];
    snprintf(ip_str, sizeof(ip_str), IPSTR, IP2STR(&ip_info.ip));
    return std::string(ip_str);
}

bool WifiAP::disconnectClient(const uint8_t* mac) {
    if (mac == nullptr) {
        return false;
    }

    // Deauth do cliente ESPECIFICO: o esp_wifi_deauth_sta(0) antigo derrubava
    // TODOS os clientes do AP (aid 0 = todos). O aid individual vem da
    // tabela do driver; MAC ausente = falha, sem estrago colateral.
    uint16_t aid = 0;
    if (esp_wifi_ap_get_sta_aid(mac, &aid) != ESP_OK) {
        return false;  // cliente nao esta associado
    }
    return esp_wifi_deauth_sta(aid) == ESP_OK;
}

void WifiAP::setState(WifiAPState newState) {
    if (_state != newState) {
        ESP_LOGD(TAG, "State: %d -> %d", static_cast<int>(_state), static_cast<int>(newState));
        _state = newState;
    }
}

void WifiAP::eventHandler(void* arg, esp_event_base_t event_base,
                          int32_t event_id, void* event_data) {
    WifiAP* self = static_cast<WifiAP*>(arg);
    if (self == nullptr) {
        return;
    }

    if (event_base == WIFI_EVENT) {
        switch (event_id) {
            case WIFI_EVENT_AP_START:
                ESP_LOGI(TAG, "AP started");
                break;

            case WIFI_EVENT_AP_STOP:
                ESP_LOGI(TAG, "AP stopped");
                break;

            case WIFI_EVENT_AP_STACONNECTED: {
                wifi_event_ap_staconnected_t* event =
                    static_cast<wifi_event_ap_staconnected_t*>(event_data);

                WifiAPClientInfo info = makeClientInfo(event->mac, 0);

                ESP_LOGI(TAG, "Client connected: %s (AID=%d)",
                         info.macString.c_str(), event->aid);
                break;
            }

            case WIFI_EVENT_AP_STADISCONNECTED: {
                wifi_event_ap_stadisconnected_t* event =
                    static_cast<wifi_event_ap_stadisconnected_t*>(event_data);

                WifiAPClientInfo info = makeClientInfo(event->mac, 0);

                ESP_LOGI(TAG, "Client disconnected: %s (AID=%d)",
                         info.macString.c_str(), event->aid);
                break;
            }

            default:
                break;
        }
    }
}
