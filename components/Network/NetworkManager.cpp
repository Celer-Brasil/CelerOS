#include "NetworkManager.h"
#include "WifiConnection.h"
#include "NetworkClock.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include <algorithm>

NetworkManager::NetworkManager()
    : _wifiConnection(nullptr)
    , _state(NetworkState::Disconnected)
    , _backgroundTask(nullptr)
    , _mutex(nullptr)
    , _backgroundTaskRunning(false)
    , _initialized(false)
    , _lastScanTime(0)
    , _connectionStartTime(0) {
    
    _mutex = xSemaphoreCreateMutex();
}

NetworkManager::~NetworkManager() {
    deinit();
    if (_wifiConnection != nullptr) {
        delete _wifiConnection;
        _wifiConnection = nullptr;
    }
    if (_mutex != nullptr) {
        vSemaphoreDelete(_mutex);
        _mutex = nullptr;
    }
}

WifiConnection* NetworkManager::getWifiConnection() {
    return _wifiConnection;
}

NetworkManager& NetworkManager::instance() {
    static NetworkManager manager;
    return manager;
}

ErrorCode NetworkManager::init(bool startBackgroundTask) {
    if (_initialized) {
        return CommonErrorCodes::None;
    }

    ESP_LOGI(TAG, "Initializing NetworkManager...");

    // Create WiFi connection instance
    _wifiConnection = new WifiConnection();
    if (_wifiConnection == nullptr) {
        ESP_LOGE(TAG, "Failed to allocate WifiConnection");
        return CommonErrorCodes::OperationFailed;
    }

    // Initialize WiFi connection
    ErrorCode err = _wifiConnection->init();
    if (err != CommonErrorCodes::None) {
        ESP_LOGE(TAG, "Failed to initialize WiFi: %s", err.description());
        delete _wifiConnection;
        _wifiConnection = nullptr;
        return err;
    }

    // Initialize credential store
    err = NetworkCredentialStore::instance().init();
    if (err != CommonErrorCodes::None) {
        ESP_LOGE(TAG, "Failed to initialize credential store: %s", err.description());
        return err;
    }

    // Register event handlers
    _wifiConnection->onStateChanged.addHandler(
        [this](WifiConnection* conn, WiFiConnectionState oldState, WiFiConnectionState newState) {
            onWifiStateChanged(conn, oldState, newState);
        });

    _wifiConnection->onConnected.addHandler(
        [this](WifiConnection* conn, const WiFiConnectionEvent& event) {
            onWifiConnected(conn, event);
        });

    _wifiConnection->onDisconnected.addHandler(
        [this](WifiConnection* conn, const WiFiConnectionEvent& event) {
            onWifiDisconnected(conn, event);
        });

    _wifiConnection->onScanCompleted.addHandler(
        [this](WifiConnection* conn, const WiFiScanResult& result) {
            onWifiScanCompleted(conn, result);
        });

    _wifiConnection->onAuthFailed.addHandler(
        [this](WifiConnection* conn, const std::string& ssid, ErrorCode error) {
            onWifiAuthFailed(conn, ssid, error);
        });

    _wifiConnection->onSignalChanged.addHandler(
        [this](WifiConnection* conn, int8_t oldRssi, int8_t newRssi) {
            onWifiSignalChanged(conn, oldRssi, newRssi);
        });

    _initialized = true;
    ESP_LOGI(TAG, "NetworkManager initialized");

    // Start background task if requested
    if (startBackgroundTask) {
        err = this->startBackgroundTask();
        if (err != CommonErrorCodes::None) {
            ESP_LOGW(TAG, "Failed to start background task: %s", err.description());
            // Non-fatal error, continue
        }
    }

    return CommonErrorCodes::None;
}

ErrorCode NetworkManager::deinit() {
    if (!_initialized) {
        return CommonErrorCodes::None;
    }

    ESP_LOGI(TAG, "Deinitializing NetworkManager...");

    // Stop background task
    stopBackgroundTask();

    // Disconnect if connected
    if (isConnected()) {
        disconnect();
    }

    _initialized = false;
    ESP_LOGI(TAG, "NetworkManager deinitialized");
    return CommonErrorCodes::None;
}

void NetworkManager::setState(NetworkState newState) {
    if (xSemaphoreTake(_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        if (_state != newState) {
            NetworkState oldState = _state;
            _state = newState;
            ESP_LOGI(TAG, "State: %s -> %s", 
                     networkStateToString(oldState), networkStateToString(newState));
            xSemaphoreGive(_mutex);
            onStateChanged.trigger(oldState, newState);
        } else {
            xSemaphoreGive(_mutex);
        }
    }
}

// ========== Connection Management ==========

ErrorCode NetworkManager::connect(const std::string& ssid, const std::string& password, 
                                  bool saveOnSuccess) {
    if (!_initialized) {
        return CommonErrorCodes::NotInitialized;
    }

    ESP_LOGI(TAG, "Connecting to network: %s", ssid.c_str());

    _lastSsid = ssid;
    _lastPassword = password;

    setState(NetworkState::Connecting);

    ErrorCode err = _wifiConnection->connect(ssid, password, false);

    if (err == CommonErrorCodes::None) {
        _stats.totalConnections++;
        _connectionStartTime = nowSeconds();

        // Save credentials if requested
        if (saveOnSuccess) {
            KnownNetwork network(ssid.c_str(), password.c_str());
            network.lastConnected = _connectionStartTime;
            network.lastRssi = _wifiConnection->getRSSI();
            NetworkCredentialStore::instance().saveNetwork(network);
        } else {
            // Just update last connected time if already known
            NetworkCredentialStore::instance().updateLastConnected(ssid);
        }

        ESP_LOGI(TAG, "Connected to %s", ssid.c_str());
    } else {
        _stats.failedConnections++;
        setState(NetworkState::Disconnected);
        ESP_LOGE(TAG, "Failed to connect to %s: %s", ssid.c_str(), err.description());
    }

    return err;
}

ErrorCode NetworkManager::connectToKnown() {
    if (!_initialized) {
        return CommonErrorCodes::NotInitialized;
    }

    ESP_LOGI(TAG, "Connecting to best known network...");

    // First, scan for available networks
    setState(NetworkState::Scanning);
    
    wifi_ap_record_t ap_list[20];
    int count = _wifiConnection->scan(ap_list, 20);
    
    if (count <= 0) {
        ESP_LOGW(TAG, "No networks found during scan");
        setState(NetworkState::Disconnected);
        return CommonErrorCodes::WifiScanFailed;
    }

    _stats.scanCount++;

    // Convert to ScannedNetwork vector
    std::vector<ScannedNetwork> scannedNetworks;
    for (int i = 0; i < count; i++) {
        scannedNetworks.emplace_back(ap_list[i]);
    }

    // Get known networks
    std::vector<KnownNetwork> knownNetworks = NetworkCredentialStore::instance().getKnownNetworks();
    
    if (knownNetworks.empty()) {
        ESP_LOGW(TAG, "No known networks configured");
        setState(NetworkState::Disconnected);
        return CommonErrorCodes::FileNotFound;
    }

    // Mark scanned networks as known
    for (auto& scanned : scannedNetworks) {
        scanned.isKnown = NetworkCredentialStore::instance().isKnownNetwork(scanned.ssid);
    }

    // Select best network
    auto bestNetwork = NetworkSelector::instance().selectBestNetwork(scannedNetworks, knownNetworks);
    
    if (!bestNetwork.has_value()) {
        ESP_LOGW(TAG, "No suitable network found");
        setState(NetworkState::Disconnected);
        return CommonErrorCodes::FileNotFound;
    }

    // Connect to selected network
    _lastScanTime = nowSeconds();  // o scan inline conta p/ roaming (sem isto
                                   // o 1o ciclo conectado re-escaneava na hora)
    return connect(bestNetwork->ssid, bestNetwork->password, false);
}

ErrorCode NetworkManager::disconnect() {
    if (!_initialized) {
        return CommonErrorCodes::NotInitialized;
    }

    ESP_LOGI(TAG, "Disconnecting...");

    // Update uptime stats
    if (_connectionStartTime > 0) {
        uint32_t now = nowSeconds();
        _stats.uptimeSeconds += (now - _connectionStartTime);
        _connectionStartTime = 0;
    }

    _wifiConnection->disconnect();
    setState(NetworkState::Disconnected);
    _activeNetwork.clear();

    return CommonErrorCodes::None;
}

ErrorCode NetworkManager::reconnect() {
    if (!_initialized) {
        return CommonErrorCodes::NotInitialized;
    }

    if (_lastSsid.empty()) {
        ESP_LOGW(TAG, "No previous network to reconnect to");
        return connectToKnown();
    }

    ESP_LOGI(TAG, "Reconnecting to %s...", _lastSsid.c_str());
    _stats.reconnections++;
    
    return connect(_lastSsid, _lastPassword, false);
}

// ========== Network Management ==========

ErrorCode NetworkManager::addNetwork(const KnownNetwork& network) {
    return NetworkCredentialStore::instance().saveNetwork(network);
}

ErrorCode NetworkManager::removeNetwork(const std::string& ssid) {
    return NetworkCredentialStore::instance().removeNetwork(ssid);
}

ErrorCode NetworkManager::setNetworkPriority(const std::string& ssid, int8_t priority) {
    return NetworkCredentialStore::instance().setNetworkPriority(ssid, priority);
}

std::vector<KnownNetwork> NetworkManager::getKnownNetworks() const {
    return NetworkCredentialStore::instance().getKnownNetworks();
}

bool NetworkManager::isKnownNetwork(const std::string& ssid) const {
    return NetworkCredentialStore::instance().isKnownNetwork(ssid);
}

// ========== Scanning ==========

// Absorve o resultado de um scan para _lastScan marcando isKnownNetwork
// (loop identico nos caminhos bloqueante, background e evento async).
void NetworkManager::absorbScanResults(const wifi_ap_record_t* ap_list, int count) {
    _lastScan.clear();
    for (int i = 0; i < count; i++) {
        ScannedNetwork net(ap_list[i]);
        net.isKnown = isKnownNetwork(net.ssid);
        _lastScan.push_back(net);
    }
}

void NetworkManager::absorbScanResults(const std::vector<ScannedNetwork>& networks) {
    _lastScan.clear();
    for (const auto& net : networks) {
        ScannedNetwork scanned = net;
        scanned.isKnown = isKnownNetwork(scanned.ssid);
        _lastScan.push_back(scanned);
    }
}

ErrorCode NetworkManager::startScan(bool blocking) {
    if (!_initialized) {
        return CommonErrorCodes::NotInitialized;
    }

    setState(NetworkState::Scanning);
    _stats.scanCount++;

    if (blocking) {
        wifi_ap_record_t ap_list[20];
        int count = _wifiConnection->scan(ap_list, 20);

        if (count < 0) {
            setState(_wifiConnection->isConnected() ? NetworkState::Connected : NetworkState::Disconnected);
            return CommonErrorCodes::WifiScanFailed;
        }

        absorbScanResults(ap_list, count);

        setState(_wifiConnection->isConnected() ? NetworkState::Connected : NetworkState::Disconnected);
        _lastScanTime = nowSeconds();
        onScanCompleted.trigger(_lastScan);

        return CommonErrorCodes::None;
    } else {
        return _wifiConnection->startScanAsync();
    }
}

std::vector<ScannedNetwork> NetworkManager::getLastScanResults() const {
    return _lastScan;
}

// ========== State Queries ==========

NetworkState NetworkManager::getState() const {
    return _state;
}

bool NetworkManager::isConnected() const {
    return _wifiConnection != nullptr && _wifiConnection->isConnected();
}

NetworkInfo NetworkManager::getActiveNetwork() const {
    if (isConnected() && _wifiConnection != nullptr) {
        return _wifiConnection->getNetworkInfo();
    }
    return NetworkInfo();
}

int8_t NetworkManager::getCurrentRssi() const {
    return _wifiConnection != nullptr ? _wifiConnection->getRSSI() : 0;
}

std::string NetworkManager::getIpAddress() const {
    if (isConnected() && _wifiConnection != nullptr) {
        return _wifiConnection->getIPAddress().toString();
    }
    return "";
}

NetworkManagerStats NetworkManager::getStats() const {
    NetworkManagerStats stats = _stats;
    
    // Update uptime if currently connected
    if (_connectionStartTime > 0) {
        uint32_t now = nowSeconds();
        stats.uptimeSeconds += (now - _connectionStartTime);
    }
    
    return stats;
}

// ========== Configuration ==========

void NetworkManager::setAutoReconnect(bool enabled) {
    _config.autoReconnect = enabled;
}

bool NetworkManager::isAutoReconnectEnabled() const {
    return _config.autoReconnect;
}

void NetworkManager::setBackgroundScanInterval(uint32_t seconds) {
    _config.backgroundScanInterval = std::max(seconds, MIN_SCAN_INTERVAL);
}

uint32_t NetworkManager::getBackgroundScanInterval() const {
    return _config.backgroundScanInterval;
}

void NetworkManager::setRoamingThreshold(int8_t threshold) {
    _config.roamingThreshold = threshold;
}

void NetworkManager::setRoamingEnabled(bool enabled) {
    _config.enableRoaming = enabled;
}

const NetworkConfig& NetworkManager::getConfig() const {
    return _config;
}

void NetworkManager::setConfig(const NetworkConfig& config) {
    _config = config;
    
    // Apply to WiFi connection
    if (_wifiConnection != nullptr) {
        _wifiConnection->setMaxRetries(_config.maxRetries);
        _wifiConnection->setConnectionTimeout(_config.connectionTimeout);
    }
}

// ========== Background Task ==========

ErrorCode NetworkManager::startBackgroundTask() {
    if (_backgroundTaskRunning) {
        return CommonErrorCodes::None;  // Already running
    }

    ESP_LOGI(TAG, "Starting background task...");

    _backgroundTaskRunning = true;
    
    BaseType_t result = xTaskCreate(
        backgroundTaskFunc,
        "NetworkMgr",
        BACKGROUND_TASK_STACK_SIZE,
        this,
        BACKGROUND_TASK_PRIORITY,
        &_backgroundTask
    );

    if (result != pdPASS) {
        _backgroundTaskRunning = false;
        ESP_LOGE(TAG, "Failed to create background task");
        return CommonErrorCodes::OperationFailed;
    }

    ESP_LOGI(TAG, "Background task started");
    return CommonErrorCodes::None;
}

void NetworkManager::stopBackgroundTask() {
    if (!_backgroundTaskRunning) {
        return;
    }

    ESP_LOGI(TAG, "Stopping background task...");
    
    _backgroundTaskRunning = false;
    
    // Wait for task to finish
    if (_backgroundTask != nullptr) {
        // Give the task time to exit gracefully
        vTaskDelay(pdMS_TO_TICKS(200));
        
        // Force delete if still running
        TaskHandle_t task = _backgroundTask;
        _backgroundTask = nullptr;
        if (task != nullptr && eTaskGetState(task) != eDeleted) {
            vTaskDelete(task);
        }
    }

    ESP_LOGI(TAG, "Background task stopped");
}

bool NetworkManager::isBackgroundTaskRunning() const {
    return _backgroundTaskRunning;
}

// Roaming so procura outro AP abaixo deste sinal (dBm)
static constexpr int8_t K_ROAM_SCAN_RSSI = -70;

void NetworkManager::holdChannel(bool on) {
    if (on) {
        __atomic_add_fetch(&_channelHolds, 1, __ATOMIC_SEQ_CST);
    } else if (__atomic_sub_fetch(&_channelHolds, 1, __ATOMIC_SEQ_CST) < 0) {
        __atomic_store_n(&_channelHolds, 0, __ATOMIC_SEQ_CST);
    }
}

// Dono do radio: esp_wifi_set_ps mora aqui. Default do IDF = WIFI_PS_MIN_MODEM
// (acorda por DTIM): o TCP interativo engasga no intervalo do beacon do AP
// (100-500 ms tipico, pior com APs que acumulam buffer) — bancada 2026-10-09,
// shell do celerctl por WiFi. WIFI_PS_NONE mantem o radio acordado: latencia
// de rede a nivel de cabo. Trade-off medido em bancada (nota do JsAi,
// 2026-10-05): com BT ligado a coexistencia acorda o radio de todo jeito
// ("Coexist!!! only keep waked"), entao o NONE nao piora o cenario BLE; sem
// BT custa mais corrente de RX — o pedido fica com quem precisa de latencia
// (sessao bridge ativa, via WebManager::tick) e o PowerPolicy desliga o
// WiFi inteiro apos wifi_sleep_min com a tela apagada, limitando a janela.
void NetworkManager::applyPowerSave() {
    if (_wifiConnection == nullptr) {
        return;  // radio nem iniciado: esp_wifi_set_ps falharia sem pista
    }
    esp_wifi_set_ps(_lowLatency ? WIFI_PS_NONE : WIFI_PS_MIN_MODEM);
}

void NetworkManager::setLowLatency(bool on) {
    if (_lowLatency == on) {
        return;  // chamado a cada tick do pump: idempotente e barato
    }
    _lowLatency = on;
    applyPowerSave();
}

void NetworkManager::backgroundTaskFunc(void* param) {
    NetworkManager* self = static_cast<NetworkManager*>(param);
    
    ESP_LOGI(TAG, "Background task running");

    // Track consecutive failures to implement exponential backoff
    uint32_t consecutiveFailures = 0;
    const uint32_t MAX_BACKOFF_SECONDS = 60;  // Max wait time between retries

    while (self->_backgroundTaskRunning) {
        uint32_t now = nowSeconds();
        uint32_t timeSinceLastScan = now - self->_lastScanTime;

        // Don't do anything if we're currently in the middle of scanning or connecting
        if (self->_state == NetworkState::Scanning || self->_state == NetworkState::Connecting) {
            vTaskDelay(pdMS_TO_TICKS(1000));  // Wait a bit and check again
            continue;
        }

        // Check if it's time for a background scan (only when connected for roaming).
        // CelerOS: so com MAIS DE UMA rede salva — com uma so nao ha para onde
        // migrar, e o scan conectado derruba pacotes de requisicoes em curso
        // (HTTP chunked falhando, medido) e aloca resultados a cada 30s.
        // E so com o sinal FRACO: com o AP atual bom nao ha melhora possivel
        // que valha um scan — e cada scan conectado toma o radio por ~9 s
        // com o Bluetooth ligado (o coex da prioridade ao WiFi): a malha
        // CelerNet e o Celer Link ficavam surdos 9 s a cada 39 (bancada
        // 2026-10-07, relogio com 2 redes salvas).
        // Canal segurado (sessoes ESP-NOW): o scan pula de canal por segundos
        // e as sessoes perdem tudo nesse tempo. Segura o scan de ROAMING e a
        // busca de quem ja estava sem rede — mas NUNCA a reconexao de quem
        // caiu do AP agora ha pouco: a internet do no vale mais que a sessao
        // (a sessao renegocia o canal sozinha). Na bancada 2026-10-11 o 4848
        // desassociou sob carga e o hold o deixou offline ate a sessao fechar.
        static uint32_t s_lastConnectedSec = 0;
        if (self->isConnected()) s_lastConnectedSec = now;
        if (self->_channelHolds > 0) {
            const bool justDropped = s_lastConnectedSec != 0 && now - s_lastConnectedSec < 120;
            if (self->isConnected() || !justDropped) {
                vTaskDelay(pdMS_TO_TICKS(1000));
                continue;
            }
        }

        if (self->isConnected() && self->_config.enableRoaming &&
            timeSinceLastScan >= self->_config.backgroundScanInterval) {
            wifi_ap_record_t cur;
            const bool weak = esp_wifi_sta_get_ap_info(&cur) != ESP_OK || cur.rssi < K_ROAM_SCAN_RSSI;
            if (weak && NetworkCredentialStore::instance().getKnownNetworks().size() > 1) {
                self->performBackgroundScan();
            } else {
                self->_lastScanTime = now;  // reavalia no proximo intervalo
            }
        }

        // If disconnected and auto-reconnect enabled, try to reconnect with backoff
        if (!self->isConnected() && self->_config.autoReconnect) {
            // Check if there are any known networks first
            std::vector<KnownNetwork> knownNetworks = NetworkCredentialStore::instance().getKnownNetworks();
            
            if (!knownNetworks.empty()) {
                ESP_LOGI(TAG, "Auto-reconnecting...");
                self->tryReconnect();
                
                // Check result
                if (self->isConnected()) {
                    consecutiveFailures = 0;  // Reset on success
                } else {
                    consecutiveFailures++;
                }
            } else {
                // No known networks, no point in scanning repeatedly
                ESP_LOGD(TAG, "No known networks configured, skipping auto-reconnect");
            }
        }

        // Calculate delay with exponential backoff (but cap it)
        uint32_t delaySeconds = 5;  // Base delay
        if (consecutiveFailures > 0 && !self->isConnected()) {
            uint32_t failuresForCalc = (consecutiveFailures > 4) ? 4 : consecutiveFailures;
            uint32_t backoffDelay = 5 * (1 << failuresForCalc);  // 5, 10, 20, 40, 80...
            delaySeconds = (backoffDelay > MAX_BACKOFF_SECONDS) ? MAX_BACKOFF_SECONDS : backoffDelay;
        }

        // AP fora do alcance: o ciclo acabou de varrer TODOS os canais e nao
        // achou nenhuma rede conhecida — repetir o scan de ~2-4 s a cada 5 s
        // nao traz o AP mais rapido, so queima bateria e interrompe o light
        // sleep (tempestade de retry da bancada). Piso de 15 s NESTE caso
        // (ultima rede vazia = o ciclo foi de scan completo); quem caiu do AP
        // e tenta o _lastSsid segue no backoff normal. Custo: ate 15 s a mais
        // para achar um AP que acabou de ligar.
        if (!self->isConnected() && self->_lastSsid.empty()) {
            if (delaySeconds < 15) delaySeconds = 15;
        }

        vTaskDelay(pdMS_TO_TICKS(delaySeconds * 1000));
    }

    ESP_LOGI(TAG, "Background task exiting");
    vTaskDelete(nullptr);
}

void NetworkManager::performBackgroundScan() {
    ESP_LOGD(TAG, "Performing background scan...");

    // Don't interrupt if we're in the middle of something
    if (_state == NetworkState::Connecting || _state == NetworkState::Scanning) {
        return;
    }

    _lastScanTime = nowSeconds();

    // Perform scan without changing state if connected
    wifi_ap_record_t ap_list[20];
    int count = _wifiConnection->scan(ap_list, 20);

    if (count < 0) {
        ESP_LOGW(TAG, "Background scan failed");
        return;
    }

    _stats.scanCount++;

    // Update scan results
    absorbScanResults(ap_list, count);

    // Check for better network if roaming is enabled
    if (_config.enableRoaming && isConnected()) {
        checkForBetterNetwork();
    }
}

void NetworkManager::checkForBetterNetwork() {
    if (!isConnected() || !_config.enableRoaming) {
        return;
    }

    NetworkInfo currentNetwork = getActiveNetwork();
    std::vector<KnownNetwork> knownNetworks = getKnownNetworks();

    for (const auto& scanned : _lastScan) {
        if (NetworkSelector::instance().isBetterNetwork(
                currentNetwork, scanned, knownNetworks, _config.roamingThreshold)) {
            
            ESP_LOGI(TAG, "Roaming to better network: %s (RSSI: %d vs %d)",
                     scanned.ssid, scanned.rssi, currentNetwork.rssi);

            // Find credentials
            KnownNetwork network;
            if (NetworkCredentialStore::instance().getNetwork(scanned.ssid, network) == CommonErrorCodes::None) {
                NetworkInfo oldNetwork = currentNetwork;
                
                setState(NetworkState::Roaming);
                _stats.roamingEvents++;

                // Atualiza _last* no inicio do roam, como o connect() faz: um
                // reconnect() manual depois do roam A->B dar certo usaria a
                // senha de A contra B (staleness do caminho de sucesso).
                _lastSsid = network.ssid;
                _lastPassword = network.password;

                // Disconnect and connect to new network
                _wifiConnection->disconnect();
                ErrorCode err = _wifiConnection->connect(network.ssid, network.password, false);

                if (err == CommonErrorCodes::None) {
                    // Sucesso do roam: _activeNetwork e atualizado pelo
                    // onWifiConnected que chega junto.
                } else {
                    // Roaming failed, try to reconnect to old network.
                    // A senha TEM que vir do store: _lastSsid/_lastPassword
                    // agora descrevem a rede ALVO do roam que falhou
                    // (A->B ok, B->C falhou => _lastPassword e a senha de
                    // C): autenticar B com ela falhava sempre.
                    ESP_LOGW(TAG, "Roaming failed, reconnecting to previous network");
                    KnownNetwork previous;
                    if (NetworkCredentialStore::instance().getNetwork(oldNetwork.ssid, previous) ==
                        CommonErrorCodes::None) {
                        _wifiConnection->connect(oldNetwork.ssid, previous.password, false);
                    } else {
                        _wifiConnection->connect(oldNetwork.ssid, _lastPassword, false);
                    }
                }
            }
            break;  // Only try one roaming target
        }
    }
}

void NetworkManager::tryReconnect() {
    // Don't try to reconnect if already connected
    if (_wifiConnection->isConnected()) {
        ESP_LOGD(TAG, "Already connected, skipping reconnect");
        setState(NetworkState::Connected);
        return;
    }

    // First try last connected network
    if (!_lastSsid.empty()) {
        ESP_LOGI(TAG, "Trying to reconnect to %s", _lastSsid.c_str());
        ErrorCode err = connect(_lastSsid, _lastPassword, false);
        if (err == CommonErrorCodes::None) {
            _stats.reconnections++;
            return;
        }
    }

    // If that fails, try connecting to any known network
    ESP_LOGI(TAG, "Trying to connect to any known network");
    connectToKnown();
}

// ========== Event Handlers ==========

void NetworkManager::onWifiStateChanged(WifiConnection* conn, WiFiConnectionState oldState, 
                                        WiFiConnectionState newState) {
    ESP_LOGD(TAG, "WiFi state: %d -> %d", static_cast<int>(oldState), static_cast<int>(newState));

    // Map WiFi states to Network states
    switch (newState) {
        case WiFiConnectionState::Idle:
            // Don't change to Disconnected if we're actually still connected
            // This can happen after a scan completes while connected
            if (_state != NetworkState::Roaming && !_wifiConnection->isConnected()) {
                setState(NetworkState::Disconnected);
            } else if (_wifiConnection->isConnected()) {
                // Restore Connected state after scan
                setState(NetworkState::Connected);
            }
            break;
        case WiFiConnectionState::Scanning:
            // CelerOS: scan com a STA associada (roaming, Ajustes) nao e queda
            // de rede — virar Scanning e voltar a Connected disparava o
            // "conectou" de novo em cada scan: NTP de novo, servidor web
            // re-checado e a ponte do celerctl derrubando a sessao TCP
            // (OTA por WiFi caia no meio; bancada 2026-10-07)
            if (!_wifiConnection->isConnected()) setState(NetworkState::Scanning);
            break;
        case WiFiConnectionState::Connecting:
            setState(NetworkState::Connecting);
            break;
        case WiFiConnectionState::Connected:
            setState(NetworkState::Connected);
            break;
        case WiFiConnectionState::Error:
            setState(NetworkState::Error);
            break;
        default:
            break;
    }
}

void NetworkManager::onWifiConnected(WifiConnection* conn, const WiFiConnectionEvent& event) {
    ESP_LOGI(TAG, "WiFi connected: %s (IP: %s, RSSI: %d)",
             event.ssid.c_str(), event.ip.toString().c_str(), event.rssi);

    // esp_wifi_stop/start (disable/enable do PowerPolicy) devolve o PS ao
    // default do IDF: reafirma o modo pedido a cada conexao.
    applyPowerSave();

    _activeNetwork = _wifiConnection->getNetworkInfo();
    _connectionStartTime = nowSeconds();

    // Update credential store
    NetworkCredentialStore::instance().updateLastConnected(event.ssid);
    NetworkCredentialStore::instance().updateLastRssi(event.ssid, event.rssi);

    setState(NetworkState::Connected);
}

void NetworkManager::onWifiDisconnected(WifiConnection* conn, const WiFiConnectionEvent& event) {
    ESP_LOGI(TAG, "WiFi disconnected: %s", event.ssid.c_str());

    _activeNetwork.clear();

    // Update uptime stats
    if (_connectionStartTime > 0) {
        uint32_t now = nowSeconds();
        _stats.uptimeSeconds += (now - _connectionStartTime);
        _connectionStartTime = 0;
    }

    if (_state != NetworkState::Roaming) {
        setState(NetworkState::Disconnected);
    }
}

void NetworkManager::onWifiScanCompleted(WifiConnection* conn, const WiFiScanResult& result) {
    ESP_LOGI(TAG, "WiFi scan completed: %d networks found", result.count);

    absorbScanResults(result.networks);

    _lastScanTime = nowSeconds();
    
    // Restore proper state after scan
    if (_wifiConnection->isConnected()) {
        setState(NetworkState::Connected);
    } else {
        setState(NetworkState::Disconnected);
    }
    
    onScanCompleted.trigger(_lastScan);
}

void NetworkManager::onWifiAuthFailed(WifiConnection* conn, const std::string& ssid, ErrorCode error) {
    ESP_LOGW(TAG, "WiFi auth failed for %s: %s", ssid.c_str(), error.description());

    _stats.failedConnections++;
    setState(NetworkState::Disconnected);
}

void NetworkManager::onWifiSignalChanged(WifiConnection* conn, int8_t oldRssi, int8_t newRssi) {
    ESP_LOGD(TAG, "WiFi signal changed: %d -> %d dBm", oldRssi, newRssi);

    // Update active network info
    if (isConnected()) {
        _activeNetwork.rssi = newRssi;
        
        // Update in credential store
        NetworkCredentialStore::instance().updateLastRssi(_activeNetwork.ssid, newRssi);
    }
}
