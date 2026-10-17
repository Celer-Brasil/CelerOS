#include "WifiConnection.h"
#include "GeneralErrorCodes.h"
#include "CommunicationErrorCodes.h"
#include <cstring>
#include <esp_log.h>
#include <algorithm>

EventGroupHandle_t WifiConnection::_wifiEventGroup = nullptr;
const char *WifiConnection::TAG = "WifiConnection";

/**
 * @file WifiConnection.cpp
 * @brief Implementation of the WifiConnection class for managing WiFi connections in station mode.
 */

WifiConnection::WifiConnection() :
        _ipAddress(), _rssi(0), _lastReportedRssi(0),
        _channel(0), _retryNum(0), _maxRetries(5), _connectionTimeout(20000),  // 20 seconds timeout
        _isConnected(false), _initialized(false), _asyncMode(false),
        _scanInProgress(false), _blockingScan(false), _state(WiFiConnectionState::Idle), 
        _scanMutex(nullptr) {
    _scanMutex = xSemaphoreCreateMutex();
}

WifiConnection::~WifiConnection() {
    disconnect(); //NOLINT
    if (_scanMutex != nullptr) {
        vSemaphoreDelete(_scanMutex);
        _scanMutex = nullptr;
    }
}

void WifiConnection::setState(WiFiConnectionState newState) {
    if (_state != newState) {
        WiFiConnectionState oldState = _state;
        _state = newState;
        ESP_LOGD(TAG, "State changed: %d -> %d", static_cast<int>(oldState), static_cast<int>(newState));
        onStateChanged.trigger(this, oldState, newState);
    }
}

ErrorCode WifiConnection::init() {
    if (_initialized) {
        return CommonErrorCodes::None;
    }

    setState(WiFiConnectionState::Initializing);

    // Ladder de init: ESP_ERR_INVALID_STATE = subsistema ja inicializado por
    // outro dono (netif/event loop/radio) e NAO e erro aqui. Log, estado e
    // retorno sao identicos em todos os degraus.
    auto ok = [this](esp_err_t r, bool toleraInitState, const char* what) -> bool {
        if (r == ESP_OK || (toleraInitState && r == ESP_ERR_INVALID_STATE)) {
            return true;
        }
        ESP_LOGE(TAG, "%s: %s", what, esp_err_to_name(r));
        setState(WiFiConnectionState::Error);
        return false;
    };

    // Initialize NVS Flash (required for WiFi)
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ret = nvs_flash_erase();
        if (!ok(ret, false, "Erro ao apagar NVS")) {
            return CommonErrorCodes::WifiInitFailed;
        }
        ret = nvs_flash_init();
    }
    if (!ok(ret, true, "Erro ao inicializar NVS")) {
        return CommonErrorCodes::WifiInitFailed;
    }

    // Create event group
    if (_wifiEventGroup == nullptr) {
        _wifiEventGroup = xEventGroupCreate();
        if (_wifiEventGroup == nullptr) {
            ESP_LOGE(TAG, "Erro ao criar event group");
            setState(WiFiConnectionState::Error);
            return CommonErrorCodes::WifiInitFailed;
        }
    }

    // netif + event loop (idempotente, compartilhado com o AP)
    ret = netCoreInit();
    if (!ok(ret, false, "Erro ao inicializar netif/event loop")) {
        return CommonErrorCodes::WifiInitFailed;
    }

    // Create STA interface if not exists
    esp_netif_t* sta_netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (sta_netif == nullptr) {
        sta_netif = esp_netif_create_default_wifi_sta();
        if (sta_netif == nullptr) {
            ESP_LOGE(TAG, "Erro ao criar interface STA");
            setState(WiFiConnectionState::Error);
            return CommonErrorCodes::WifiInitFailed;
        }
    }

    // Initialize WiFi
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ret = esp_wifi_init(&cfg);
    if (!ok(ret, true, "Erro ao inicializar WiFi")) {
        return CommonErrorCodes::WifiInitFailed;
    }

    // Register event handlers
    static esp_event_handler_instance_t instance_any_id = nullptr;
    static esp_event_handler_instance_t instance_got_ip = nullptr;

    if (instance_any_id == nullptr) {
        ret = esp_event_handler_instance_register(WIFI_EVENT,
                                                  ESP_EVENT_ANY_ID,
                                                  &eventHandler,
                                                  this,
                                                  &instance_any_id);
        if (!ok(ret, false, "Erro ao registrar handler WIFI_EVENT")) {
            return CommonErrorCodes::WifiInitFailed;
        }
    }

    if (instance_got_ip == nullptr) {
        ret = esp_event_handler_instance_register(IP_EVENT,
                                                  IP_EVENT_STA_GOT_IP,
                                                  &eventHandler,
                                                  this,
                                                  &instance_got_ip);
        if (!ok(ret, false, "Erro ao registrar handler IP_EVENT")) {
            return CommonErrorCodes::WifiInitFailed;
        }
    }

    // Set WiFi mode
    ret = esp_wifi_set_mode(WIFI_MODE_STA);
    if (!ok(ret, false, "Erro ao configurar modo WiFi")) {
        return CommonErrorCodes::WifiInitFailed;
    }

    // Start WiFi
    ret = esp_wifi_start();
    if (!ok(ret, true, "Erro ao iniciar WiFi")) {
        return CommonErrorCodes::WifiInitFailed;
    }

    _initialized = true;
    setState(WiFiConnectionState::Idle);
    ESP_LOGI(TAG, "WiFi initialized successfully");
    return CommonErrorCodes::None;
}

ErrorCode WifiConnection::ensureInitialized() {
    if (!_initialized) {
        return init();
    }
    return CommonErrorCodes::None;
}

ErrorCode WifiConnection::connect(const std::string &ssid, const std::string &password, bool asyncConnect) {
    ErrorCode err = ensureInitialized();
    if (err != CommonErrorCodes::None) {
        return err;
    }

    _ssid = ssid;
    _password = password;
    _asyncMode = asyncConnect;

    // Clear event bits for new connection attempt
    xEventGroupClearBits(_wifiEventGroup, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT);

    // Configure WiFi connection
    wifi_config_t wifi_config = {};
    // SSID de 32 e PSK de 64 caracteres ocupam o campo inteiro sem '\0' (o IDF
    // aceita); o resto ja e zero pelo {} acima. memcpy limitado = sem truncagem.
    std::memcpy(wifi_config.sta.ssid, ssid.data(), std::min(ssid.size(), sizeof(wifi_config.sta.ssid)));
    std::memcpy(wifi_config.sta.password, password.data(),
                std::min(password.size(), sizeof(wifi_config.sta.password)));

    esp_err_t ret = esp_wifi_set_config(WIFI_IF_STA, &wifi_config);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Erro ao configurar WiFi: %s", esp_err_to_name(ret));
        setState(WiFiConnectionState::Error);
        return CommonErrorCodes::WifiInitFailed;
    }

    // Reset retry counter
    _retryNum = 0;
    _isConnected = false;

    // Update state and trigger event
    setState(WiFiConnectionState::Connecting);

    ESP_LOGI(TAG, "Connecting to WiFi network: %s", ssid.c_str());

    // Clear any previous event bits before starting connection
    xEventGroupClearBits(_wifiEventGroup, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT);
    _retryNum = 0;

    // Start connection
    ret = esp_wifi_connect();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Erro ao iniciar conexão WiFi: %s", esp_err_to_name(ret));
        setState(WiFiConnectionState::Error);
        onAuthFailed.trigger(this, ssid, CommonErrorCodes::WifiInitFailed);
        return CommonErrorCodes::WifiInitFailed;
    }

    // If async mode, return immediately
    if (asyncConnect) {
        return CommonErrorCodes::None;
    }

    // Wait for connection or failure (blocking mode)
    EventBits_t bits = xEventGroupWaitBits(_wifiEventGroup,
                                           WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
                                           pdTRUE,   // Clear bits on exit
                                           pdFALSE,  // Wait for any bit
                                           pdMS_TO_TICKS(_connectionTimeout));

    if (bits & WIFI_CONNECTED_BIT) {
        ESP_LOGI(TAG, "Connected to WiFi network: %s", ssid.c_str());
        return CommonErrorCodes::None;
    } else if (bits & WIFI_FAIL_BIT) {
        ESP_LOGE(TAG, "Failed to connect to WiFi network: %s", ssid.c_str());
        return CommonErrorCodes::WifiConnectionFailed;
    } else {
        ESP_LOGE(TAG, "Timeout waiting for WiFi connection.");
        setState(WiFiConnectionState::Idle);
        return CommonErrorCodes::Timeout;
    }
}

void WifiConnection::disconnect() {
    if (_state == WiFiConnectionState::Idle) {
        return;
    }

    // Conexao EM CURSO tambem e cancelavel: o caminho antigo so chamava
    // esp_wifi_disconnect() quando ja associado — um "desligar WiFi" dado
    // durante o connect deixava a maquina interna tentando associar e o
    // aparelho conectava DEPOIS do disable (o toggle e o wifi_sleep_min do
    // PowerPolicy nao pegavam quando a janela caia no meio de um connect).
    const bool wasConnecting = (_state == WiFiConnectionState::Connecting);

    setState(WiFiConnectionState::Disconnecting);

    if (isConnected()) {
        WiFiConnectionEvent event = makeEvent(CommonErrorCodes::None);

        esp_wifi_disconnect();

        _isConnected = false;
        ESP_LOGI(TAG, "Disconnected from WiFi network.");

        onDisconnected.trigger(this, event);
    } else if (wasConnecting) {
        // Aborta a associacao em curso (sem AP: devolve erro inofensivo) e
        // acorda o waiter bloqueante do connect() — sem o bit ele ficaria
        // preso ate o timeout cheio achando que a tentativa seguia viva.
        esp_wifi_disconnect();
        xEventGroupSetBits(_wifiEventGroup, WIFI_FAIL_BIT);
    }

    setState(WiFiConnectionState::Idle);
    _ssid.clear();
    _ipAddress = IPAddress();
    _rssi = 0;
    _channel = 0;
}

bool WifiConnection::isConnected() const {
    return _isConnected;
}

WiFiConnectionState WifiConnection::getState() const {
    return _state;
}

std::string WifiConnection::getSSID() const {
    if (!isConnected()) {
        return "";
    }

    wifi_config_t wifi_config;
    if (esp_wifi_get_config(WIFI_IF_STA, &wifi_config) == ESP_OK) {
        // SSID de 32 bytes pode vir SEM terminador: o std::string(ptr) antigo
        // lia alem do fim do campo. Constroi com o tamanho limitado ao array.
        const char* ssid = reinterpret_cast<const char*>(wifi_config.sta.ssid);
        return std::string(ssid, strnlen(ssid, sizeof(wifi_config.sta.ssid)));
    }
    return _ssid;
}

IPAddress WifiConnection::getIPAddress() const {
    return _ipAddress;
}

int8_t WifiConnection::getRSSI() const {
    if (!isConnected()) {
        return 0;
    }
    
    wifi_ap_record_t ap_info;
    if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
        return ap_info.rssi;
    }
    return _rssi;
}

uint8_t WifiConnection::getChannel() const {
    return _channel;
}

NetworkInfo WifiConnection::getNetworkInfo() const {
    NetworkInfo info;
    
    if (!isConnected()) {
        return info;
    }

    info.type = NetworkType::WiFi;
    info.ssid = getSSID();
    info.rssi = getRSSI();
    info.ip = _ipAddress.toString();
    info.channel = _channel;

    wifi_ap_record_t ap_info;
    if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
        char bssid[18];
        macToString(ap_info.bssid, bssid);
        info.bssid = bssid;
        info.authMode = toWiFiAuthMode(ap_info.authmode);
    }

    // Get gateway and netmask
    esp_netif_t* netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif != nullptr) {
        esp_netif_ip_info_t ip_info;
        if (esp_netif_get_ip_info(netif, &ip_info) == ESP_OK) {
            info.gateway = IPAddress(ip_info.gw).toString();
            info.netmask = IPAddress(ip_info.netmask).toString();
        }
    }

    return info;
}

void WifiConnection::setMaxRetries(uint8_t maxRetries) {
    _maxRetries = maxRetries;
}

void WifiConnection::setConnectionTimeout(uint32_t timeoutMs) {
    _connectionTimeout = timeoutMs;
}

// Guarda de concorrencia compartilhada pelos caminhos de scan (async e
// bloqueante): null-check do mutex, take com 100 ms e flag _scanInProgress.
// Em Ok o mutex fica TOMADO — o chamador o devolve com unlockScan().
WifiConnection::ScanLock WifiConnection::lockScan(bool async) {
    if (_scanMutex == nullptr) {
        ESP_LOGE(TAG, "Scan mutex not initialized");
        return ScanLock::NoMutex;
    }

    // Try to acquire mutex with timeout
    if (xSemaphoreTake(_scanMutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGW(TAG, "%s", async ? "Scan already in progress, skipping async scan..."
                                  : "Scan already in progress, skipping...");
        return ScanLock::Busy;
    }

    // Check if another scan is still running
    if (_scanInProgress) {
        ESP_LOGW(TAG, "%s", async ? "Scan already running, aborting async scan..."
                                  : "Scan already running, aborting...");
        xSemaphoreGive(_scanMutex);
        return ScanLock::Busy;
    }

    return ScanLock::Ok;
}

// Fim de scan (sucesso ou falha): estado Idle, flags zeradas e mutex devolvido.
void WifiConnection::unlockScan(bool blocking) {
    setState(WiFiConnectionState::Idle);
    _scanInProgress = false;
    if (blocking) {
        _blockingScan = false;
    }
    xSemaphoreGive(_scanMutex);
}

// Config de scan dos dois caminhos: todos os canais, ocultas inclusas, ativa
// com 120..300 ms por canal (timing para melhor deteccao).
wifi_scan_config_t WifiConnection::defaultScanConfig() {
    wifi_scan_config_t scan_config = {};
    scan_config.ssid = nullptr;
    scan_config.bssid = nullptr;
    scan_config.channel = 0;  // Scan all channels
    scan_config.show_hidden = true;  // Also show hidden networks
    scan_config.scan_type = WIFI_SCAN_TYPE_ACTIVE;
    scan_config.scan_time.active.min = 120;  // Min 120ms per channel
    scan_config.scan_time.active.max = 300;  // Max 300ms per channel
    return scan_config;
}

WiFiScanResult WifiConnection::failScanResult() {
    WiFiScanResult result;
    result.success = false;
    result.error = CommonErrorCodes::WifiScanFailed;
    result.count = 0;
    return result;
}

// Evento de conexao montado do estado atual (campos identicos nos sitios que
// disparam onConnected/onDisconnected).
WiFiConnectionEvent WifiConnection::makeEvent(const ErrorCode& error) const {
    WiFiConnectionEvent event;
    event.ssid = _ssid;
    event.rssi = _rssi;
    event.ip = _ipAddress;
    event.error = error;
    return event;
}

ErrorCode WifiConnection::startScanAsync() {
    ErrorCode err = ensureInitialized();
    if (err != CommonErrorCodes::None) {
        return err;
    }

    // Protect against concurrent scans
    switch (lockScan(true)) {
        case ScanLock::Ok:
            break;
        case ScanLock::NoMutex:
            return CommonErrorCodes::NotInitialized;
        default:
            return CommonErrorCodes::WifiScanFailed;
    }

    _scanInProgress = true;
    setState(WiFiConnectionState::Scanning);

    ESP_LOGI(TAG, "Starting async WiFi scan...");

    // Stop any pending scan first
    esp_wifi_scan_stop();

    // Start non-blocking scan
    wifi_scan_config_t scan_config = defaultScanConfig();
    esp_err_t ret = esp_wifi_scan_start(&scan_config, false);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Erro ao iniciar scan: %s", esp_err_to_name(ret));
        unlockScan(false);
        onScanCompleted.trigger(this, failScanResult());
        return CommonErrorCodes::WifiScanFailed;
    }

    // Note: mutex will be released when scan completes (in event handler)
    // For now, release it as we're in async mode
    xSemaphoreGive(_scanMutex);

    return CommonErrorCodes::None;
}

int WifiConnection::scan(wifi_ap_record_t* ap_list, uint16_t max_aps) {
    if (ap_list == nullptr || max_aps == 0) {
        ESP_LOGE(TAG, "Parâmetros inválidos para scan");
        return -1;
    }

    ErrorCode err = ensureInitialized();
    if (err != CommonErrorCodes::None) {
        return -1;
    }

    // Protect against concurrent scans
    if (lockScan(false) != ScanLock::Ok) {
        return -1;
    }

    _scanInProgress = true;
    _blockingScan = true;  // Mark as blocking scan - event handler should not consume results
    setState(WiFiConnectionState::Scanning);

    ESP_LOGI(TAG, "Iniciando scan WiFi...");

    // Stop any pending scan first
    esp_wifi_scan_stop();

    // Start blocking scan
    wifi_scan_config_t scan_config = defaultScanConfig();
    esp_err_t ret = esp_wifi_scan_start(&scan_config, true);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Erro ao iniciar scan: %s", esp_err_to_name(ret));
        unlockScan(true);
        onScanCompleted.trigger(this, failScanResult());
        return -1;
    }

    // Get scan results
    uint16_t ap_count = 0;
    ret = esp_wifi_scan_get_ap_num(&ap_count);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Erro ao obter número de APs: %s", esp_err_to_name(ret));
        unlockScan(true);
        return -1;
    }

    ESP_LOGI(TAG, "Encontradas %d redes WiFi", ap_count);

    if (ap_count > max_aps) {
        ap_count = max_aps;
    }

    if (ap_count > 0) {
        ret = esp_wifi_scan_get_ap_records(&ap_count, ap_list);
        if (ret != ESP_OK) {
            ESP_LOGE(TAG, "Erro ao obter lista de APs: %s", esp_err_to_name(ret));
            unlockScan(true);
            return -1;
        }
    }

    // Process and cache results
    _lastScanResult.networks.clear();
    _lastScanResult.count = ap_count;
    _lastScanResult.success = true;
    _lastScanResult.error = CommonErrorCodes::None;

    for (uint16_t i = 0; i < ap_count; i++) {
        _lastScanResult.networks.emplace_back(ap_list[i]);
    }

    // Sort by RSSI
    std::sort(_lastScanResult.networks.begin(), _lastScanResult.networks.end(), compareByRssi);

    unlockScan(true);

    onScanCompleted.trigger(this, _lastScanResult);

    ESP_LOGI(TAG, "Scan concluído, retornando %d redes", ap_count);
    return static_cast<int>(ap_count);
}

WiFiScanResult WifiConnection::getLastScanResults() const {
    return _lastScanResult;
}

void WifiConnection::processScanResults(WiFiScanResult& result) {
    uint16_t ap_count = 0;
    esp_err_t ret = esp_wifi_scan_get_ap_num(&ap_count);
    
    if (ret != ESP_OK) {
        result.success = false;
        result.error = CommonErrorCodes::WifiScanFailed;
        result.count = 0;
        return;
    }

    result.networks.clear();
    result.count = ap_count;
    result.success = true;
    result.error = CommonErrorCodes::None;

    if (ap_count == 0) {
        return;
    }

    // Allocate temporary buffer for AP records
    std::vector<wifi_ap_record_t> ap_records(ap_count);
    ret = esp_wifi_scan_get_ap_records(&ap_count, ap_records.data());
    
    if (ret != ESP_OK) {
        result.success = false;
        result.error = CommonErrorCodes::WifiScanFailed;
        return;
    }

    // Convert to ScannedNetwork
    for (const auto& record : ap_records) {
        result.networks.emplace_back(record);
    }

    // Sort by RSSI
    std::sort(result.networks.begin(), result.networks.end(), compareByRssi);
}

void WifiConnection::updateRssi() {
    if (!isConnected()) {
        return;
    }

    int8_t currentRssi = getRSSI();
    int8_t diff = currentRssi - _lastReportedRssi;
    
    if (diff > RSSI_CHANGE_THRESHOLD || diff < -RSSI_CHANGE_THRESHOLD) {
        int8_t oldRssi = _lastReportedRssi;
        _lastReportedRssi = currentRssi;
        _rssi = currentRssi;
        onSignalChanged.trigger(this, oldRssi, currentRssi);
    }
}

void WifiConnection::eventHandler(void *arg, esp_event_base_t event_base,
                                  int32_t event_id, void *event_data) {
    auto *self = static_cast<WifiConnection *>(arg);

    if (event_base == WIFI_EVENT) {
        switch (event_id) {
            case WIFI_EVENT_STA_START:
                // WiFi started, don't auto-connect here
                ESP_LOGD(TAG, "WIFI_EVENT_STA_START");
                break;

            case WIFI_EVENT_STA_DISCONNECTED: {
                auto* disconnect_event = static_cast<wifi_event_sta_disconnected_t*>(event_data);
                ESP_LOGI(TAG, "Disconnected from AP, reason: %d", disconnect_event->reason);

                bool wasConnected = self->_isConnected;
                self->_isConnected = false;

                // Check if this is an auth failure
                bool authFailed = (disconnect_event->reason == WIFI_REASON_AUTH_FAIL ||
                                   disconnect_event->reason == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT ||
                                   disconnect_event->reason == WIFI_REASON_HANDSHAKE_TIMEOUT);

                if (self->_state == WiFiConnectionState::Connecting) {
                    if (authFailed) {
                        // Authentication failed
                        self->setState(WiFiConnectionState::Idle);
                        xEventGroupSetBits(_wifiEventGroup, WIFI_FAIL_BIT);
                        self->onAuthFailed.trigger(self, self->_ssid, CommonErrorCodes::WifiAuthFailed);
                    } else if (self->_retryNum < self->_maxRetries) {
                        // Retry connection
                        self->_retryNum++;
                        ESP_LOGI(TAG, "Retrying connection (%d/%d)...", self->_retryNum, self->_maxRetries);
                        esp_wifi_connect();
                    } else {
                        // Max retries reached
                        self->setState(WiFiConnectionState::Idle);
                        xEventGroupSetBits(_wifiEventGroup, WIFI_FAIL_BIT);
                        self->onAuthFailed.trigger(self, self->_ssid, CommonErrorCodes::WifiConnectionFailed);
                    }
                } else if (wasConnected) {
                    // Was connected, now disconnected
                    WiFiConnectionEvent event = self->makeEvent(CommonErrorCodes::WifiConnectionFailed);

                    self->setState(WiFiConnectionState::Idle);
                    self->onDisconnected.trigger(self, event);
                }
                break;
            }

            case WIFI_EVENT_SCAN_DONE: {
                ESP_LOGI(TAG, "WIFI_EVENT_SCAN_DONE");
                
                // Only process results here for async scans
                // For blocking scans, results are processed in scan() function directly
                if (!self->_blockingScan) {
                    // Reset scan in progress flag only for async scans
                    self->_scanInProgress = false;
                    
                    if (self->_state == WiFiConnectionState::Scanning) {
                        self->processScanResults(self->_lastScanResult);
                        self->setState(WiFiConnectionState::Idle);
                        self->onScanCompleted.trigger(self, self->_lastScanResult);
                    }
                }
                // For blocking scans, the scan() function handles everything
                xEventGroupSetBits(_wifiEventGroup, WIFI_SCAN_DONE_BIT);
                break;
            }

            default:
                break;
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        auto *event = static_cast<ip_event_got_ip_t *>(event_data);
        self->_ipAddress = IPAddress(event->ip_info.ip);
        self->_retryNum = 0;
        self->_isConnected = true;

        // Get additional info
        wifi_ap_record_t ap_info;
        if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
            self->_rssi = ap_info.rssi;
            self->_lastReportedRssi = ap_info.rssi;
            self->_channel = ap_info.primary;
        }

        self->setState(WiFiConnectionState::Connected);
        xEventGroupSetBits(_wifiEventGroup, WIFI_CONNECTED_BIT);

        // Trigger new event
        WiFiConnectionEvent connEvent = self->makeEvent(CommonErrorCodes::None);
        connEvent.retryCount = self->_retryNum;
        self->onConnected.trigger(self, connEvent);

        ESP_LOGI(TAG, "Connected! IP: %s, RSSI: %d dBm, Channel: %d",
                 self->_ipAddress.toString().c_str(), self->_rssi, self->_channel);
    }
}
