#include "NetworkCredentialStore.h"
#include "NetworkClock.h"
#include "NVS.h"
#include "CommonErrorCodes.h"
#include "CredCipher.h"
#include "esp_log.h"
#include <algorithm>
#include <cstring>
#include <cstdio>

namespace {

// Espera maxima pela guarda do cache: as regioes criticas so tocam o vector
// em memoria (NVS roda fora delas), entao 100 ms e folga generosa.
constexpr TickType_t kStoreLockTimeout = pdMS_TO_TICKS(100);

} // namespace

NetworkCredentialStore::NetworkCredentialStore()
    : _mutex(nullptr), _initialized(false) {
}

NetworkCredentialStore& NetworkCredentialStore::instance() {
    static NetworkCredentialStore store;
    return store;
}

ErrorCode NetworkCredentialStore::init() {
    if (_initialized) {
        return CommonErrorCodes::None;
    }

    ESP_LOGI(TAG, "Initializing NetworkCredentialStore...");

    // Guarda do cache _networks antes de qualquer acesso: o store e
    // lido/escrito de varias tasks (portal, UI, sys_evt absorvendo scans,
    // NetworkMgr) — sem ela, um push_back/erase realocando o vector virava
    // use-after-free no leitor.
    if (_mutex == nullptr) {  // init repetido depois de uma falha: nao vaza outro
        _mutex = xSemaphoreCreateMutex();
        if (_mutex == nullptr) {
            ESP_LOGE(TAG, "Failed to create store mutex");
            return CommonErrorCodes::OperationFailed;
        }
    }

    // Initialize NVS if not already done
    ErrorCode err = NVS::initialize();
    if (err != CommonErrorCodes::None) {
        ESP_LOGE(TAG, "Failed to initialize NVS: %s", err.description());
        return err;
    }

    // Chave da cifra de senha (AES-CCM, sobe/genera uma vez). Falha fechado:
    // sem cifra o store nao salva — persistir texto claro no NVS seria pior
    // que recusar a rede.
    if (!CredCipher::init()) {
        ESP_LOGE(TAG, "Failed to initialize credential cipher");
        return CommonErrorCodes::OperationFailed;
    }

    // Load existing networks from NVS
    err = loadFromNvs();
    if (err != CommonErrorCodes::None && err != CommonErrorCodes::FileNotFound && 
        err != CommonErrorCodes::FileIsEmpty) {
        ESP_LOGE(TAG, "Failed to load networks from NVS: %s", err.description());
        return err;
    }

    _initialized = true;
    ESP_LOGI(TAG, "NetworkCredentialStore initialized with %zu networks", _networks.size());
    return CommonErrorCodes::None;
}

ErrorCode NetworkCredentialStore::saveNetwork(const KnownNetwork& network) {
    if (!_initialized) {
        return CommonErrorCodes::NotInitialized;
    }

    if (strlen(network.ssid) == 0) {
        ESP_LOGE(TAG, "Cannot save network with empty SSID");
        return CommonErrorCodes::ArgumentError;
    }

    if (xSemaphoreTake(_mutex, kStoreLockTimeout) != pdTRUE) {
        ESP_LOGE(TAG, "Lock timeout saving network");
        return CommonErrorCodes::Timeout;
    }

    // Check if network already exists
    int existingIndex = findNetworkIndex(network.ssid);

    if (existingIndex >= 0) {
        // Update existing network
        _networks[existingIndex] = network;
        ESP_LOGI(TAG, "Updated network: %s", network.ssid);
    } else {
        // Check if we have room for more networks
        if (_networks.size() >= NetworkStoreConstants::MAX_STORED_NETWORKS) {
            ESP_LOGE(TAG, "Maximum number of stored networks reached (%zu)",
                     NetworkStoreConstants::MAX_STORED_NETWORKS);
            xSemaphoreGive(_mutex);
            return CommonErrorCodes::StorageFull;
        }

        // Add new network
        _networks.push_back(network);
        ESP_LOGI(TAG, "Added network: %s", network.ssid);
    }
    xSemaphoreGive(_mutex);

    // Persist to NVS (fora da guarda: saveToNvs tira um snapshot sob lock)
    ErrorCode err = saveToNvs();
    if (err != CommonErrorCodes::None) {
        ESP_LOGE(TAG, "Failed to save networks to NVS: %s", err.description());
        return err;
    }

    return CommonErrorCodes::None;
}

ErrorCode NetworkCredentialStore::removeNetwork(const std::string& ssid) {
    ErrorCode err = CommonErrorCodes::None;
    if (_mutex == nullptr) {
        return CommonErrorCodes::NotInitialized;
    }
    if (xSemaphoreTake(_mutex, kStoreLockTimeout) != pdTRUE) {
        ESP_LOGE(TAG, "Lock timeout removing network");
        return CommonErrorCodes::Timeout;
    }
    KnownNetwork* net = findNetwork(ssid, err);
    if (net == nullptr) {
        xSemaphoreGive(_mutex);
        if (err == CommonErrorCodes::FileNotFound) {
            ESP_LOGW(TAG, "Network not found: %s", ssid.c_str());
        }
        return err;
    }

    // Remove from memory (indice no cache via aritmetica de ponteiro)
    _networks.erase(_networks.begin() + (net - _networks.data()));
    xSemaphoreGive(_mutex);
    ESP_LOGI(TAG, "Removed network: %s", ssid.c_str());

    // Persist to NVS
    err = saveToNvs();
    if (err != CommonErrorCodes::None) {
        ESP_LOGE(TAG, "Failed to save networks to NVS: %s", err.description());
        return err;
    }

    return CommonErrorCodes::None;
}

ErrorCode NetworkCredentialStore::clearAllNetworks() {
    if (!_initialized) {
        return CommonErrorCodes::NotInitialized;
    }

    ESP_LOGI(TAG, "Clearing all stored networks...");

    if (xSemaphoreTake(_mutex, kStoreLockTimeout) != pdTRUE) {
        ESP_LOGE(TAG, "Lock timeout clearing networks");
        return CommonErrorCodes::Timeout;
    }

    _networks.clear();
    xSemaphoreGive(_mutex);

    // Apaga apenas as chaves deste namespace. NAO usar NVS::eraseData():
    // ele apaga a particao NVS inteira e levaria junto dados de outros
    // namespaces (webauth/pin do "celer", otadata, ...).
    ErrorCode err = saveToNvs();  // count=0 + limpeza das keys residuais
    if (err != CommonErrorCodes::None) {
        ESP_LOGW(TAG, "Failed to clear NVS keys: %s", err.description());
        // antes devolvia None: quem chama (forgetAllNetworks) achava que a
        // flash estava limpa e as senhas voltavam no proximo boot
        return err;
    }

    ESP_LOGI(TAG, "All networks cleared");
    return CommonErrorCodes::None;
}

std::vector<KnownNetwork> NetworkCredentialStore::getKnownNetworks() const {
    std::vector<KnownNetwork> copy;
    if (_mutex == nullptr) {
        return copy;  // init nem rodou: cache vazio mesmo
    }
    if (xSemaphoreTake(_mutex, kStoreLockTimeout) == pdTRUE) {
        copy = _networks;
        xSemaphoreGive(_mutex);
    } else {
        ESP_LOGW(TAG, "Lock timeout in getKnownNetworks");
    }
    return copy;
}

ErrorCode NetworkCredentialStore::getNetwork(const std::string& ssid, KnownNetwork& network) const {
    ErrorCode err = CommonErrorCodes::None;
    if (_mutex == nullptr) {
        return CommonErrorCodes::NotInitialized;
    }
    if (xSemaphoreTake(_mutex, kStoreLockTimeout) != pdTRUE) {
        ESP_LOGW(TAG, "Lock timeout in getNetwork");
        return CommonErrorCodes::Timeout;
    }
    const KnownNetwork* net = findNetwork(ssid, err);
    if (net == nullptr) {
        xSemaphoreGive(_mutex);
        return err;
    }

    network = *net;
    xSemaphoreGive(_mutex);
    return CommonErrorCodes::None;
}

bool NetworkCredentialStore::isKnownNetwork(const std::string& ssid) const {
    if (_mutex == nullptr) {
        return false;
    }
    if (xSemaphoreTake(_mutex, kStoreLockTimeout) != pdTRUE) {
        return false;  // ocupado: trata como desconhecida (so marca de UI)
    }
    bool known = findNetworkIndex(ssid) >= 0;
    xSemaphoreGive(_mutex);
    return known;
}

ErrorCode NetworkCredentialStore::setNetworkPriority(const std::string& ssid, int8_t priority) {
    ErrorCode err = CommonErrorCodes::None;
    if (_mutex == nullptr) {
        return CommonErrorCodes::NotInitialized;
    }
    if (xSemaphoreTake(_mutex, kStoreLockTimeout) != pdTRUE) {
        ESP_LOGE(TAG, "Lock timeout setting priority");
        return CommonErrorCodes::Timeout;
    }
    KnownNetwork* net = findNetwork(ssid, err);
    if (net == nullptr) {
        xSemaphoreGive(_mutex);
        return err;
    }

    // Clamp priority to valid range
    priority = std::max<int8_t>(0, std::min<int8_t>(100, priority));
    net->priority = priority;
    xSemaphoreGive(_mutex);

    ESP_LOGI(TAG, "Set priority for %s to %d", ssid.c_str(), priority);

    return saveToNvs();
}

ErrorCode NetworkCredentialStore::updateLastConnected(const std::string& ssid, uint32_t timestamp) {
    ErrorCode err = CommonErrorCodes::None;
    if (_mutex == nullptr) {
        return CommonErrorCodes::NotInitialized;
    }
    if (xSemaphoreTake(_mutex, kStoreLockTimeout) != pdTRUE) {
        ESP_LOGD(TAG, "Lock timeout in updateLastConnected");
        return CommonErrorCodes::Timeout;
    }
    KnownNetwork* net = findNetwork(ssid, err);
    if (net == nullptr) {
        xSemaphoreGive(_mutex);
        return err;
    }

    // Use current time if timestamp is 0
    if (timestamp == 0) {
        timestamp = nowSeconds();  // Convert to seconds
    }

    net->lastConnected = timestamp;
    xSemaphoreGive(_mutex);
    ESP_LOGD(TAG, "Updated lastConnected for %s to %lu", ssid.c_str(),
             static_cast<unsigned long>(timestamp));

    // So em memoria (como o lastRssi): o timestamp e uptime (esp_timer), sem
    // sentido depois de um reboot, e cada conexao chamava isto DUAS vezes
    // (connect + evento) — cada saveToNvs reescrevia a lista inteira com
    // ~160 open/commit de NVS no caminho da conexao, desgastando a flash a
    // cada religada do WiFi (o watch religa a cada vez que a tela acende).
    return CommonErrorCodes::None;
}

ErrorCode NetworkCredentialStore::updateLastRssi(const std::string& ssid, int8_t rssi) {
    ErrorCode err = CommonErrorCodes::None;
    if (_mutex == nullptr) {
        return CommonErrorCodes::NotInitialized;
    }
    if (xSemaphoreTake(_mutex, kStoreLockTimeout) != pdTRUE) {
        ESP_LOGD(TAG, "Lock timeout in updateLastRssi");
        return CommonErrorCodes::Timeout;
    }
    KnownNetwork* net = findNetwork(ssid, err);
    if (net == nullptr) {
        xSemaphoreGive(_mutex);
        return err;
    }

    net->lastRssi = rssi;
    xSemaphoreGive(_mutex);

    // Don't save to NVS for RSSI updates (too frequent)
    return CommonErrorCodes::None;
}

ErrorCode NetworkCredentialStore::setAutoConnect(const std::string& ssid, bool autoConnect) {
    ErrorCode err = CommonErrorCodes::None;
    if (_mutex == nullptr) {
        return CommonErrorCodes::NotInitialized;
    }
    if (xSemaphoreTake(_mutex, kStoreLockTimeout) != pdTRUE) {
        ESP_LOGE(TAG, "Lock timeout setting autoConnect");
        return CommonErrorCodes::Timeout;
    }
    KnownNetwork* net = findNetwork(ssid, err);
    if (net == nullptr) {
        xSemaphoreGive(_mutex);
        return err;
    }

    net->autoConnect = autoConnect;
    xSemaphoreGive(_mutex);
    ESP_LOGI(TAG, "Set autoConnect for %s to %s", ssid.c_str(), autoConnect ? "true" : "false");

    return saveToNvs();
}

size_t NetworkCredentialStore::getNetworkCount() const {
    // _networks e escrito por varias tasks; size() por fora da guarda corria
    // contra push_back/erase (o resto da classe ja usa o mutex). Regioes da
    // guarda sao curtas (NVS roda fora), entao esperar aqui e seguro.
    if (_mutex == nullptr) {
        return 0;
    }
    size_t count = 0;
    if (xSemaphoreTake(_mutex, portMAX_DELAY) == pdTRUE) {
        count = _networks.size();
        xSemaphoreGive(_mutex);
    }
    return count;
}

std::vector<KnownNetwork> NetworkCredentialStore::getNetworksByPriority() const {
    std::vector<KnownNetwork> sorted = getKnownNetworks();
    std::sort(sorted.begin(), sorted.end(), compareByPriority);
    return sorted;
}

std::vector<KnownNetwork> NetworkCredentialStore::getAutoConnectNetworks() const {
    std::vector<KnownNetwork> result;
    if (_mutex == nullptr) {
        return result;
    }
    if (xSemaphoreTake(_mutex, kStoreLockTimeout) == pdTRUE) {
        for (const auto& network : _networks) {
            if (network.autoConnect) {
                result.push_back(network);
            }
        }
        xSemaphoreGive(_mutex);
    } else {
        ESP_LOGW(TAG, "Lock timeout in getAutoConnectNetworks");
    }
    // Sort by priority
    std::sort(result.begin(), result.end(), compareByPriority);
    return result;
}

// Private methods

ErrorCode NetworkCredentialStore::loadFromNvs() {
    if (xSemaphoreTake(_mutex, kStoreLockTimeout) != pdTRUE) {
        return CommonErrorCodes::Timeout;
    }
    _networks.clear();

    // Read the network count
    uint8_t count = 0;
    ErrorCode err = NVS::readValue<uint8_t>(NetworkStoreConstants::NVS_NAMESPACE,
                                            NetworkStoreConstants::INDEX_KEY, count);

    if (err == CommonErrorCodes::FileNotFound) {
        ESP_LOGI(TAG, "No stored networks found");
        xSemaphoreGive(_mutex);
        return CommonErrorCodes::None;
    }

    if (err != CommonErrorCodes::None) {
        ESP_LOGE(TAG, "Failed to read network count: %s", err.description());
        xSemaphoreGive(_mutex);
        return err;
    }

    ESP_LOGI(TAG, "Loading %d networks from NVS...", count);

    // Load each network
    bool sawLegacy = false;
    bool sawPlain = false;
    for (uint8_t i = 0; i < count && i < NetworkStoreConstants::MAX_STORED_NETWORKS; i++) {
        KnownNetwork network;
        bool legacy = false;
        bool plain = false;  // por entrada: o loadNetwork zera a flag logo na entrada
        err = loadNetworkFromNvs(i, network, &legacy, &plain);
        if (legacy) sawLegacy = true;
        if (plain) sawPlain = true;
        if (err == CommonErrorCodes::None) {
            _networks.push_back(network);
            ESP_LOGD(TAG, "Loaded network: %s (priority: %d)", network.ssid, network.priority);
        } else {
            ESP_LOGW(TAG, "Failed to load network at index %d: %s", i, err.description());
        }
    }

    const size_t loaded = _networks.size();
    // Entrada em formato antigo (pipe legado ou senha em claro): regrava tudo
    // no formato atual (senha cifrada) — migracao transparente, uma unica
    // vez. Fora da guarda, o saveToNvs tira o proprio snapshot.
    const bool migrate = (sawLegacy || sawPlain) && loaded > 0;
    xSemaphoreGive(_mutex);

    if (migrate) {
        ESP_LOGI(TAG, "Migrating legacy network entries (senha passa a ser cifrada)...");
        saveToNvs();
    }

    ESP_LOGI(TAG, "Successfully loaded %zu networks", loaded);
    return CommonErrorCodes::None;
}

// Keys por campo do formato v2: "net<i>" + sufixo curto (limite NVS: 15
// chars). Campos ausentes assumem default — redes salvas por versoes antigas
// ganham os campos novos sem invalidar o registro.
static std::string fieldKey(size_t index, const char* suffix) {
    char key[16];
    snprintf(key, sizeof(key), "net%u%s", (unsigned)index, suffix);
    return std::string(key);
}

static const char* F_SSID = "s";
static const char* F_PASS = "w";   // legado (texto claro): so leitura + migracao
static const char* F_CPASS = "cw"; // senha cifrada (hex nonce||ct||tag)
static const char* F_PRIO = "pr";
static const char* F_RSSI = "r";
static const char* F_LASTC = "lc";
static const char* F_AUTO = "ac";
static const char* F_AUTH = "am";

ErrorCode NetworkCredentialStore::saveToNvs() {
    // Snapshot sob a guarda: gravar o NVS (open/commit por campo, dezenas
    // de ms) segurando o lock travaria leitores (scan, roaming, UI). Fora
    // dela, o pior caso e gravar o estado de quem salvou por ultimo.
    std::vector<KnownNetwork> snapshot;
    if (_mutex == nullptr) {
        return CommonErrorCodes::NotInitialized;
    }
    if (xSemaphoreTake(_mutex, kStoreLockTimeout) == pdTRUE) {
        snapshot = _networks;
        xSemaphoreGive(_mutex);
    } else {
        ESP_LOGE(TAG, "Lock timeout snapshotting networks for NVS");
        return CommonErrorCodes::Timeout;
    }

    // Save the network count
    uint8_t count = static_cast<uint8_t>(snapshot.size());
    ErrorCode err = NVS::storeValue<uint8_t>(NetworkStoreConstants::NVS_NAMESPACE,
                                             NetworkStoreConstants::INDEX_KEY, count, true);

    if (err != CommonErrorCodes::None) {
        ESP_LOGE(TAG, "Failed to save network count: %s", err.description());
        return err;
    }

    // Save each network
    for (size_t i = 0; i < snapshot.size(); i++) {
        err = saveNetworkToNvs(i, snapshot[i]);
        if (err != CommonErrorCodes::None) {
            ESP_LOGE(TAG, "Failed to save network at index %zu: %s", i, err.description());
            return err;
        }
    }

    // Chaves residuais de redes removidas (indices >= count): sem isso, uma
    // rede apagada deixava senha/ssid fantasma no NVS para sempre.
    for (size_t i = snapshot.size(); i < NetworkStoreConstants::MAX_STORED_NETWORKS; i++) {
        NVS::eraseKey(NetworkStoreConstants::NVS_NAMESPACE, fieldKey(i, F_SSID));
        NVS::eraseKey(NetworkStoreConstants::NVS_NAMESPACE, fieldKey(i, F_PASS));
        NVS::eraseKey(NetworkStoreConstants::NVS_NAMESPACE, fieldKey(i, F_CPASS));
        NVS::eraseKey(NetworkStoreConstants::NVS_NAMESPACE, fieldKey(i, F_PRIO));
        NVS::eraseKey(NetworkStoreConstants::NVS_NAMESPACE, fieldKey(i, F_RSSI));
        NVS::eraseKey(NetworkStoreConstants::NVS_NAMESPACE, fieldKey(i, F_LASTC));
        NVS::eraseKey(NetworkStoreConstants::NVS_NAMESPACE, fieldKey(i, F_AUTO));
        NVS::eraseKey(NetworkStoreConstants::NVS_NAMESPACE, fieldKey(i, F_AUTH));
        NVS::eraseKey(NetworkStoreConstants::NVS_NAMESPACE,
                      getNetworkKey(i));  // chave do formato pipe legado
    }

    ESP_LOGD(TAG, "Saved %zu networks to NVS", snapshot.size());
    return CommonErrorCodes::None;
}

ErrorCode NetworkCredentialStore::saveNetworkToNvs(size_t index, const KnownNetwork& network) {
    const std::string ns = NetworkStoreConstants::NVS_NAMESPACE;
    ErrorCode err = NVS::storeValue<std::string>(ns, fieldKey(index, F_SSID), network.ssid, true);
    if (err != CommonErrorCodes::None) return err;

    // Senha cifrada em "cw"; a chave "w" em claro e apagada (migracao). Rede
    // aberta (sem senha): nenhum dos dois campos existe.
    if (network.password[0] != '\0') {
        char hex[192];
        if (!CredCipher::encrypt(network.password, hex, sizeof(hex))) {
            ESP_LOGE(TAG, "Falhou ao cifrar a senha de %s", network.ssid);
            return CommonErrorCodes::OperationFailed;
        }
        err = NVS::storeValue<std::string>(ns, fieldKey(index, F_CPASS), hex, true);
        if (err != CommonErrorCodes::None) return err;
        NVS::eraseKey(ns, fieldKey(index, F_PASS));
    } else {
        NVS::eraseKey(ns, fieldKey(index, F_CPASS));
        NVS::eraseKey(ns, fieldKey(index, F_PASS));
    }

    err = NVS::storeValue<int8_t>(ns, fieldKey(index, F_PRIO), network.priority, true);
    if (err != CommonErrorCodes::None) return err;
    err = NVS::storeValue<int8_t>(ns, fieldKey(index, F_RSSI), network.lastRssi, true);
    if (err != CommonErrorCodes::None) return err;
    err = NVS::storeValue<uint32_t>(ns, fieldKey(index, F_LASTC), network.lastConnected, true);
    if (err != CommonErrorCodes::None) return err;
    err = NVS::storeValue<uint8_t>(ns, fieldKey(index, F_AUTO),
                                   network.autoConnect ? 1 : 0, true);
    if (err != CommonErrorCodes::None) return err;
    return NVS::storeValue<uint8_t>(ns, fieldKey(index, F_AUTH),
                                    static_cast<uint8_t>(network.authMode), true);
}

ErrorCode NetworkCredentialStore::loadNetworkFromNvs(size_t index, KnownNetwork& network,
                                                     bool* legacyUsed, bool* plainUsed) {
    if (legacyUsed != nullptr) *legacyUsed = false;
    if (plainUsed != nullptr) *plainUsed = false;
    const std::string ns = NetworkStoreConstants::NVS_NAMESPACE;

    std::string ssid;
    ErrorCode err = NVS::readValue<std::string>(ns, fieldKey(index, F_SSID), ssid);
    if (err == CommonErrorCodes::None) {
        strncpy(network.ssid, ssid.c_str(), sizeof(network.ssid) - 1);
        network.ssid[sizeof(network.ssid) - 1] = '\0';
        // saveNetwork recusa SSID vazio: um registro assim so vem de
        // corrupcao e viraria uma "rede fantasma" na lista/busca
        if (network.ssid[0] == '\0') {
            ESP_LOGE(TAG, "Registro corrompido no indice %zu (SSID vazio)", index);
            return CommonErrorCodes::OperationFailed;
        }

        // Senha: primeiro o formato cifrado atual ("cw"); se ausente, cai para
        // o texto claro das versoes antigas ("w") e marca migracao — o
        // loadFromNvs regravara tudo com a senha cifrada.
        std::string cpass;
        if (NVS::readValue<std::string>(ns, fieldKey(index, F_CPASS), cpass) ==
            CommonErrorCodes::None) {
            if (!CredCipher::decrypt(cpass.c_str(), network.password,
                                     sizeof(network.password))) {
                // chave perdida/trocada: rede continua listada, mas a senha
                // nao e recuperavel — o usuario redigita na proxima conexao
                ESP_LOGW(TAG, "Senha indecifrável no indice %zu (chave perdida?)", index);
                network.password[0] = '\0';
            }
        } else {
            std::string pass;
            if (NVS::readValue<std::string>(ns, fieldKey(index, F_PASS), pass) ==
                CommonErrorCodes::None) {
                strncpy(network.password, pass.c_str(), sizeof(network.password) - 1);
                network.password[sizeof(network.password) - 1] = '\0';
                if (network.password[0] != '\0' && plainUsed != nullptr) *plainUsed = true;
            } else {
                network.password[0] = '\0';
            }
        }

        int8_t prio = 0, rssi = 0;
        uint32_t lastC = 0;
        uint8_t autoC = 1, auth = 0;
        NVS::readValue<int8_t>(ns, fieldKey(index, F_PRIO), prio);
        NVS::readValue<int8_t>(ns, fieldKey(index, F_RSSI), rssi);
        NVS::readValue<uint32_t>(ns, fieldKey(index, F_LASTC), lastC);
        NVS::readValue<uint8_t>(ns, fieldKey(index, F_AUTO), autoC);
        NVS::readValue<uint8_t>(ns, fieldKey(index, F_AUTH), auth);
        network.priority = prio;
        network.lastRssi = rssi;
        network.lastConnected = lastC;
        network.autoConnect = autoC != 0;
        network.authMode = static_cast<WiFiAuthMode>(auth);
        return CommonErrorCodes::None;
    }
    if (err != CommonErrorCodes::FileNotFound) return err;

    // Formato legado: "ssid|password|priority|lastRssi|lastConnected|autoConnect|authMode"
    // em uma unica string. Quebrava com '|' no SSID/senha e parseava numeros
    // sem try/catch. Mantido so para leitura + migracao.
    std::string serialized;
    err = NVS::readValue<std::string>(ns, getNetworkKey(index), serialized);
    if (err != CommonErrorCodes::None) return err;
    if (legacyUsed != nullptr) *legacyUsed = true;

    // Sem excecoes (o firmware compila com -fno-exceptions): numero invalido
    // marca a entrada como corrompida em vez de abortar.
    auto parseNum = [](const std::string& s, long& out) {
        if (s.empty()) return false;
        char* end = nullptr;
        out = strtol(s.c_str(), &end, 10);
        return end != nullptr && *end == '\0';
    };

    size_t pos = 0;
    int fieldIndex = 0;
    bool ok = true;
    while (ok && pos <= serialized.length()) {
        size_t bar = serialized.find('|', pos);
        std::string field = (bar == std::string::npos)
                                ? serialized.substr(pos)
                                : serialized.substr(pos, bar - pos);
        long num = 0;
        switch (fieldIndex) {
            case 0:
                strncpy(network.ssid, field.c_str(), sizeof(network.ssid) - 1);
                network.ssid[sizeof(network.ssid) - 1] = '\0';
                break;
            case 1:
                strncpy(network.password, field.c_str(), sizeof(network.password) - 1);
                network.password[sizeof(network.password) - 1] = '\0';
                break;
            case 2:
                ok = parseNum(field, num);
                network.priority = static_cast<int8_t>(num);
                break;
            case 3:
                ok = parseNum(field, num);
                network.lastRssi = static_cast<int8_t>(num);
                break;
            case 4:
                ok = parseNum(field, num);
                network.lastConnected = static_cast<uint32_t>(num);
                break;
            case 5:
                network.autoConnect = (field == "1");
                break;
            case 6:
                ok = parseNum(field, num);
                network.authMode = static_cast<WiFiAuthMode>(num);
                break;
        }
        fieldIndex++;
        if (bar == std::string::npos) break;
        pos = bar + 1;
    }
    if (!ok) {
        ESP_LOGE(TAG, "Corrupt legacy network entry at index %zu", index);
        return CommonErrorCodes::OperationFailed;
    }
    if (network.ssid[0] == '\0') {
        ESP_LOGE(TAG, "Legacy network entry at index %zu has empty SSID", index);
        return CommonErrorCodes::OperationFailed;
    }

    return CommonErrorCodes::None;
}

int NetworkCredentialStore::findNetworkIndex(const std::string& ssid) const {
    for (size_t i = 0; i < _networks.size(); i++) {
        if (_networks[i].matchesSsid(ssid)) {
            return static_cast<int>(i);
        }
    }
    return -1;
}

// Guarda compartilhada dos metodos que operam numa rede conhecida: valida o
// init e resolve o SSID para o registro no cache (nullptr = err diz o que
// houve: NotInitialized/FileNotFound). Substituia o par
// "if (!_initialized)... findNetworkIndex < 0..." repetido em 7 metodos.
KnownNetwork* NetworkCredentialStore::findNetwork(const std::string& ssid, ErrorCode& err) {
    if (!_initialized) {
        err = CommonErrorCodes::NotInitialized;
        return nullptr;
    }
    int index = findNetworkIndex(ssid);
    if (index < 0) {
        err = CommonErrorCodes::FileNotFound;
        return nullptr;
    }
    err = CommonErrorCodes::None;
    return &_networks[static_cast<size_t>(index)];
}

const KnownNetwork* NetworkCredentialStore::findNetwork(const std::string& ssid, ErrorCode& err) const {
    // delega ao nao-const: nenhum caminho muta o cache aqui
    return const_cast<NetworkCredentialStore*>(this)->findNetwork(ssid, err);
}

std::string NetworkCredentialStore::getNetworkKey(size_t index) {
    return std::string(NetworkStoreConstants::NETWORK_PREFIX) + std::to_string(index);
}
