#include "NetworkManager.h"
#include "WifiConnection.h"
#include "NetworkClock.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include <algorithm>
#include <new>

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
        // Um init(false) anterior deixava a task de reconexao desligada para
        // sempre (o init idempotente so devolvia None): o pedido posterior
        // com startBackgroundTask=true tem que subi-la.
        if (startBackgroundTask && !_backgroundTaskRunning) {
            this->startBackgroundTask();
        }
        return CommonErrorCodes::None;
    }

    ESP_LOGI(TAG, "Initializing NetworkManager...");

    // Create WiFi connection instance. nothrow: sem excecoes um new que falha
    // aborta o aparelho (convencao da casa para caminho sem PSRAM)
    _wifiConnection = new (std::nothrow) WifiConnection();
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
        // Sem store nao ha conexao: devolve a instancia. Antes ela ficava
        // viva (vazando) e o proximo init criava outra, com os handlers do
        // esp_event ainda apontando para a primeira.
        delete _wifiConnection;
        _wifiConnection = nullptr;
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

    // Libera a instancia (o destrutor do WifiConnection desregistra os
    // handlers do esp_event). Sem isto um init posterior criava uma segunda
    // WifiConnection e a primeira ficava viva para sempre, dona dos eventos.
    if (_wifiConnection != nullptr) {
        delete _wifiConnection;
        _wifiConnection = nullptr;
    }
    // _activeNetwork carrega std::string (NetworkInfo) e e escrito por DUAS
    // tasks (sys_evt nos handlers de wifi, task chamadora no disconnect):
    // clear() concorrente com o assign do onWifiConnected rasgava o string
    // (free do buffer + new = heap corrompido). Mesma guarda do _lastScan.
    if (_mutex != nullptr) {
        xSemaphoreTake(_mutex, portMAX_DELAY);
        _activeNetwork.clear();
        _state = NetworkState::Disconnected;
        xSemaphoreGive(_mutex);
    }

    _initialized = false;
    ESP_LOGI(TAG, "NetworkManager deinitialized");
    return CommonErrorCodes::None;
}

void NetworkManager::setState(NetworkState newState) {
    if (_mutex == nullptr) {
        return;  // construtor sem mutex: nada a proteger
    }
    // portMAX_DELAY: a guarda so e tomada aqui e por regioes minusculas; com
    // o timeout de 100 ms uma transicao (ex.: Connected) era descartada em
    // silencio quando outra task estava do lado de dentro.
    xSemaphoreTake(_mutex, portMAX_DELAY);
    if (_state == newState) {
        xSemaphoreGive(_mutex);
        return;
    }
    NetworkState oldState = _state;
    _state = newState;
    xSemaphoreGive(_mutex);

    ESP_LOGI(TAG, "State: %s -> %s",
             networkStateToString(oldState), networkStateToString(newState));
    onStateChanged.trigger(oldState, newState);
}

// Alvo da reconexao: veja o contrato no header. Regioes curtas (so os dois
// assigns), mesmo padrao de guarda null-safe do resto da classe.
void NetworkManager::setLastTarget(const std::string& ssid, const std::string& password) {
    if (_mutex == nullptr) {
        _lastSsid = ssid;
        _lastPassword = password;
        return;
    }
    xSemaphoreTake(_mutex, portMAX_DELAY);
    _lastSsid = ssid;
    _lastPassword = password;
    xSemaphoreGive(_mutex);
}

void NetworkManager::getLastTarget(std::string& ssid, std::string& password) const {
    if (_mutex == nullptr) {
        ssid = _lastSsid;
        password = _lastPassword;
        return;
    }
    xSemaphoreTake(_mutex, portMAX_DELAY);
    ssid = _lastSsid;
    password = _lastPassword;
    xSemaphoreGive(_mutex);
}

// ========== Connection Management ==========

ErrorCode NetworkManager::connect(const std::string& ssid, const std::string& password,
                                  bool saveOnSuccess) {
    if (!_initialized) {
        return CommonErrorCodes::NotInitialized;
    }

    ESP_LOGI(TAG, "Connecting to network: %s", ssid.c_str());

    setLastTarget(ssid, password);

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
    // Guarda: o onWifiConnected do sys_evt pode estar no meio do assign de
    // _activeNetwork (std::string) para o AP que acabou de cair.
    if (_mutex != nullptr) {
        xSemaphoreTake(_mutex, portMAX_DELAY);
        _activeNetwork.clear();
        xSemaphoreGive(_mutex);
    }

    return CommonErrorCodes::None;
}

ErrorCode NetworkManager::reconnect() {
    if (!_initialized) {
        return CommonErrorCodes::NotInitialized;
    }

    std::string ssid, password;
    getLastTarget(ssid, password);
    if (ssid.empty()) {
        ESP_LOGW(TAG, "No previous network to reconnect to");
        return connectToKnown();
    }

    ESP_LOGI(TAG, "Reconnecting to %s...", ssid.c_str());
    _stats.reconnections++;

    return connect(ssid, password, false);
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
// _lastScan e escrito pela task do WiFi (scan async), pela task de fundo e
// pela task chamadora, e lido por UI/httpd: a troca do vector passa pela
// guarda (_mutex), senao um clear/push_back concorrente com o leitor virava
// use-after-free.
void NetworkManager::absorbScanResults(const wifi_ap_record_t* ap_list, int count) {
    std::vector<ScannedNetwork> nets;
    nets.reserve((size_t)count);
    for (int i = 0; i < count; i++) {
        ScannedNetwork net(ap_list[i]);
        net.isKnown = isKnownNetwork(net.ssid);
        nets.push_back(net);
    }
    if (_mutex != nullptr) {
        xSemaphoreTake(_mutex, portMAX_DELAY);
        _lastScan.swap(nets);
        xSemaphoreGive(_mutex);
    }
}

void NetworkManager::absorbScanResults(const std::vector<ScannedNetwork>& networks) {
    std::vector<ScannedNetwork> nets;
    nets.reserve(networks.size());
    for (const auto& net : networks) {
        ScannedNetwork scanned = net;
        scanned.isKnown = isKnownNetwork(scanned.ssid);
        nets.push_back(scanned);
    }
    if (_mutex != nullptr) {
        xSemaphoreTake(_mutex, portMAX_DELAY);
        _lastScan.swap(nets);
        xSemaphoreGive(_mutex);
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
        // copia sob a guarda: _lastScan pode ser trocado pela task do WiFi
        // enquanto os handlers rodam (trigger passa referencia)
        std::vector<ScannedNetwork> results = getLastScanResults();
        onScanCompleted.trigger(results);

        return CommonErrorCodes::None;
    } else {
        ErrorCode err = _wifiConnection->startScanAsync();
        if (err != CommonErrorCodes::None) {
            // o scan nem comecou (outro em curso/erro do driver): o estado
            // ficava Scanning e a background task pulava o loop para sempre
            setState(_wifiConnection->isConnected() ? NetworkState::Connected
                                                   : NetworkState::Disconnected);
        }
        return err;
    }
}

std::vector<ScannedNetwork> NetworkManager::getLastScanResults() const {
    std::vector<ScannedNetwork> copy;
    if (_mutex == nullptr) {
        return copy;
    }
    xSemaphoreTake(_mutex, portMAX_DELAY);
    copy = _lastScan;
    xSemaphoreGive(_mutex);
    return copy;
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

    // Resta de um stop() recente cuja task ainda esta drenando (connect
    // bloqueante em curso): esperar o handle zerar antes de criar outra,
    // senao duas NetworkMgr varrem/reconectam em paralelo ate a velha sair.
    for (int i = 0; i < 400 && _backgroundTask != nullptr; ++i) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (_backgroundTask != nullptr) {
        ESP_LOGW(TAG, "Task de fundo antiga ainda saindo; criando assim mesmo");
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

    // ESPERA COOPERATIVA, sem vTaskDelete forcado: o laco da task dorme em
    // fatias de 100 ms (ver bgDelay), entao ela ve a flag cair em <= 100 ms
    // e se autodeleta APÓS zerar o handle. Matar a task de fora podia
    // apanha-la com o mutex do credential store tomado (saveNetwork/
    // getKnownNetworks) ou dentro de uma escrita LittleFS — o mutex/FS
    // ficava preso para sempre. Teto de 40 s: cobre o pior corpo (scan de
    // ~9 s + connect bloqueante de connectionTimeout=20 s). Estourou, a
    // task sai sozinha depois e o handle zera nela; nada fica tomado.
    for (int i = 0; i < 400 && _backgroundTask != nullptr; ++i) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (_backgroundTask != nullptr) {
        ESP_LOGW(TAG, "Task de fundo nao saiu em 40 s (reconnect em curso?); sai sozinha");
    }

    ESP_LOGI(TAG, "Background task stopped");
}

bool NetworkManager::isBackgroundTaskRunning() const {
    return _backgroundTaskRunning;
}

// Roaming so procura outro AP abaixo deste sinal (dBm)
static constexpr int8_t K_ROAM_SCAN_RSSI = -70;

// Sono do laco de fundo em fatias de 100 ms: o stopBackgroundTask derruba
// _backgroundTaskRunning e a task sai em <= 100 ms em vez de completar o
// backoff inteiro (ate 60 s) para so entao ser forcada com vTaskDelete.
static void bgDelay(volatile bool& running, uint32_t ms) {
    while (ms > 0 && running) {
        const uint32_t passo = ms > 100 ? 100 : ms;
        vTaskDelay(pdMS_TO_TICKS(passo));
        ms -= passo;
    }
}

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
    esp_err_t err = esp_wifi_set_ps(_lowLatency ? WIFI_PS_NONE : WIFI_PS_MIN_MODEM);
    if (err != ESP_OK) {
        // antes era engolido: o pedido de baixa latencia "sumia" sem pista
        ESP_LOGW(TAG, "esp_wifi_set_ps falhou: %s", esp_err_to_name(err));
    }
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
            bgDelay(self->_backgroundTaskRunning, 1000);  // Wait a bit and check again
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
                bgDelay(self->_backgroundTaskRunning, 1000);
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
        // e tenta o alvo guardado segue no backoff normal. Custo: ate 15 s a
        // mais para achar um AP que acabou de ligar.
        if (!self->isConnected()) {
            std::string lastSsid, lastPassword;
            self->getLastTarget(lastSsid, lastPassword);
            if (lastSsid.empty() && delaySeconds < 15) delaySeconds = 15;
        }

        bgDelay(self->_backgroundTaskRunning, delaySeconds * 1000);
    }

    ESP_LOGI(TAG, "Background task exiting");
    // Zera o handle ANTES de se deletar: depois do vTaskDelete(NULL) o TCB
    // e liberado e stopBackgroundTask nao pode mais tocar nele
    self->_backgroundTask = nullptr;
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
    // copia: _lastScan pode ser trocado pela task do WiFi (scan async)
    std::vector<ScannedNetwork> scan = getLastScanResults();

    for (const auto& scanned : scan) {
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
                setLastTarget(network.ssid, network.password);

                // Disconnect and connect to new network
                _wifiConnection->disconnect();
                ErrorCode err = _wifiConnection->connect(network.ssid, network.password, false);

                if (err == CommonErrorCodes::None) {
                    // Sucesso do roam: _activeNetwork e atualizado pelo
                    // onWifiConnected que chega junto.
                } else {
                    // Roaming failed, try to reconnect to old network.
                    // A senha TEM que vir do store: _last* agora descrevem a
                    // rede ALVO do roam que falhou (A->B ok, B->C falhou =>
                    // o alvo guardado e C): autenticar B com ela falhava
                    // sempre.
                    ESP_LOGW(TAG, "Roaming failed, reconnecting to previous network");
                    KnownNetwork previous;
                    if (NetworkCredentialStore::instance().getNetwork(oldNetwork.ssid, previous) ==
                        CommonErrorCodes::None) {
                        if (_wifiConnection->connect(oldNetwork.ssid, previous.password, false) ==
                            CommonErrorCodes::None) {
                            // Voltamos para a rede antiga: _last* (postos no
                            // alvo do roam) precisam descrever a rede ATIVA,
                            // senao reconnect()/tryReconnect tentariam a
                            // senha do alvo no SSID velho
                            setLastTarget(oldNetwork.ssid, previous.password);
                        }
                    } else {
                        std::string oldSsid, oldPassword;
                        getLastTarget(oldSsid, oldPassword);
                        _wifiConnection->connect(oldNetwork.ssid, oldPassword, false);
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
    std::string lastSsid, lastPassword;
    getLastTarget(lastSsid, lastPassword);
    if (!lastSsid.empty()) {
        ESP_LOGI(TAG, "Trying to reconnect to %s", lastSsid.c_str());
        ErrorCode err = connect(lastSsid, lastPassword, false);
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

    // _activeNetwork e lido pelo onWifiSignalChanged (sys_evt) e escrito na
    // task chamadora (disconnect/deinit): assign sob a guarda, fora dela so
    // o que nao toca no campo.
    NetworkInfo info = _wifiConnection->getNetworkInfo();
    if (_mutex != nullptr) {
        xSemaphoreTake(_mutex, portMAX_DELAY);
        _activeNetwork = info;
        xSemaphoreGive(_mutex);
    }
    _connectionStartTime = nowSeconds();

    // Update credential store
    NetworkCredentialStore::instance().updateLastConnected(event.ssid);
    NetworkCredentialStore::instance().updateLastRssi(event.ssid, event.rssi);

    setState(NetworkState::Connected);
}

void NetworkManager::onWifiDisconnected(WifiConnection* conn, const WiFiConnectionEvent& event) {
    ESP_LOGI(TAG, "WiFi disconnected: %s", event.ssid.c_str());

    // Mesma guarda do onWifiConnected: clear de std::string concorrente com
    // o assign rasga o heap.
    if (_mutex != nullptr) {
        xSemaphoreTake(_mutex, portMAX_DELAY);
        _activeNetwork.clear();
        xSemaphoreGive(_mutex);
    }

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

    // copia sob a guarda (mesmo padrao do caminho bloqueante): entre o
    // absorbScanResults e o trigger outro scan (bloqueante de outra task ou
    // o proximo async) pode trocar o vector, e os handlers recebem
    // referencia — iterar _lastScan trocavel era use-after-free
    std::vector<ScannedNetwork> results = getLastScanResults();
    onScanCompleted.trigger(results);
}

void NetworkManager::onWifiAuthFailed(WifiConnection* conn, const std::string& ssid, ErrorCode error) {
    ESP_LOGW(TAG, "WiFi auth failed for %s: %s", ssid.c_str(), error.description());

    _stats.failedConnections++;
    setState(NetworkState::Disconnected);
}

void NetworkManager::onWifiSignalChanged(WifiConnection* conn, int8_t oldRssi, int8_t newRssi) {
    ESP_LOGD(TAG, "WiFi signal changed: %d -> %d dBm", oldRssi, newRssi);

    // Update active network info. O .ssid sai copiado SOB a guarda (o
    // disconnect da task chamadora da clear() concorrente); a escrita no
    // store fica FORA dela (I/O de NVS nao segura o mutex do estado).
    if (isConnected()) {
        std::string ssid;
        if (_mutex != nullptr) {
            xSemaphoreTake(_mutex, portMAX_DELAY);
            _activeNetwork.rssi = newRssi;
            ssid = _activeNetwork.ssid;
            xSemaphoreGive(_mutex);
        }

        // Update in credential store
        NetworkCredentialStore::instance().updateLastRssi(ssid, newRssi);
    }
}
