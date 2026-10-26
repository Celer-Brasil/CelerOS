#ifndef NETWORK_CREDENTIAL_STORE_H
#define NETWORK_CREDENTIAL_STORE_H

#include <string>
#include <vector>
#include <cstdint>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "NetworkTypes.h"
#include "ErrorCode.h"

/**
 * @file NetworkCredentialStore.h
 * @brief Persistent storage for known network credentials using NVS.
 * 
 * This class manages the storage and retrieval of known WiFi networks
 * including their credentials, priorities, and connection history.
 * Data is persisted in ESP32's Non-Volatile Storage (NVS).
 */

/**
 * @namespace NetworkStoreConstants
 * @brief Constants for the NetworkCredentialStore.
 */
namespace NetworkStoreConstants {
    constexpr const char* NVS_NAMESPACE = "net_creds";      /**< NVS namespace for credentials */
    constexpr const char* INDEX_KEY = "net_index";          /**< Key for network index/count */
    constexpr const char* NETWORK_PREFIX = "net_";          /**< Prefix for network entries */
    constexpr size_t MAX_STORED_NETWORKS = 20;              /**< Maximum number of stored networks */
}

/**
 * @class NetworkCredentialStore
 * @brief Manages persistent storage of known network credentials.
 *
 * This class provides methods to save, load, update, and remove network
 * credentials from NVS. It uses a simple indexing system where each
 * network is stored with a unique index and an index list is maintained.
 *
 * Thread-safe: o cache em memoria (_networks) e lido/escrito de varias
 * tasks (portal, UI, sys_evt absorvendo scans, NetworkMgr) — tudo passa
 * por _mutex, com regioes criticas curtas (so memoria; o NVS roda fora,
 * sobre um snapshot).
 */
class NetworkCredentialStore {
public:
    /**
     * @brief Get the singleton instance.
     * @return Reference to the NetworkCredentialStore instance.
     */
    static NetworkCredentialStore& instance();

    /**
     * @brief Initialize the credential store.
     * 
     * Loads existing networks from NVS into memory.
     * 
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode init();

    /**
     * @brief Save a network to persistent storage.
     * 
     * If a network with the same SSID already exists, it will be updated.
     * 
     * @param network The network to save.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode saveNetwork(const KnownNetwork& network);

    /**
     * @brief Remove a network from persistent storage.
     * @param ssid The SSID of the network to remove.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode removeNetwork(const std::string& ssid);

    /**
     * @brief Remove all stored networks.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode clearAllNetworks();

    /**
     * @brief Get all known networks.
     * @return Vector of all stored networks.
     */
    std::vector<KnownNetwork> getKnownNetworks() const;

    /**
     * @brief Get a specific network by SSID.
     * @param ssid The SSID to search for.
     * @param network Output parameter for the found network.
     * @return ErrorCode::None if found, error otherwise.
     */
    ErrorCode getNetwork(const std::string& ssid, KnownNetwork& network) const;

    /**
     * @brief Check if a network is known (saved).
     * @param ssid The SSID to check.
     * @return True if the network is in the known list.
     */
    bool isKnownNetwork(const std::string& ssid) const;

    /**
     * @brief Update the priority of a network.
     * @param ssid The SSID of the network.
     * @param priority The new priority (0-100).
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode setNetworkPriority(const std::string& ssid, int8_t priority);

    /**
     * @brief Update the last connected timestamp for a network (memoria so;
     *        nao vai ao NVS, como o lastRssi).
     * @param ssid The SSID of the network.
     * @param timestamp The timestamp (uptime seconds). If 0, uses current time.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode updateLastConnected(const std::string& ssid, uint32_t timestamp = 0);

    /**
     * @brief Update the last known RSSI for a network.
     * @param ssid The SSID of the network.
     * @param rssi The signal strength.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode updateLastRssi(const std::string& ssid, int8_t rssi);

    /**
     * @brief Set auto-connect preference for a network.
     * @param ssid The SSID of the network.
     * @param autoConnect Whether to auto-connect.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode setAutoConnect(const std::string& ssid, bool autoConnect);

    /**
     * @brief Get the number of stored networks.
     * @return Number of networks in storage.
     */
    size_t getNetworkCount() const;

    /**
     * @brief Get networks sorted by priority (highest first).
     * @return Vector of networks sorted by priority.
     */
    std::vector<KnownNetwork> getNetworksByPriority() const;

    /**
     * @brief Get networks that have auto-connect enabled.
     * @return Vector of auto-connect enabled networks.
     */
    std::vector<KnownNetwork> getAutoConnectNetworks() const;

    // Sem eventos (onNetworkSaved/onNetworkRemoved): nenhum assinante em
    // todo o firmware (triagem 2026-10) — so custavam heap.

private:
    NetworkCredentialStore();
    ~NetworkCredentialStore() = default;
    NetworkCredentialStore(const NetworkCredentialStore&) = delete;
    NetworkCredentialStore& operator=(const NetworkCredentialStore&) = delete;

    /**
     * @brief Load all networks from NVS into memory.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode loadFromNvs();

    /**
     * @brief Save all networks from memory to NVS.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode saveToNvs();

    /**
     * @brief Save a single network to NVS.
     * @param index The index to save at.
     * @param network The network to save.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode saveNetworkToNvs(size_t index, const KnownNetwork& network);

    /**
     * @brief Load a single network from NVS.
     * @param index The index to load from.
     * @param network Output parameter for the loaded network.
     * @param legacyUsed Optional: set to true when the entry came from the
     *        legacy pipe-serialized format (triggers a one-time migration).
     * @param plainUsed Optional: set to true when the password came from the
     *        legacy plaintext field "w" (triggers re-save with encryption).
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode loadNetworkFromNvs(size_t index, KnownNetwork& network,
                                 bool* legacyUsed = nullptr, bool* plainUsed = nullptr);

    /**
     * @brief Find network index by SSID.
     *
     * Chamador deve segurar _mutex: itera _networks.
     * @param ssid The SSID to search for.
     * @return Index if found, -1 otherwise.
     */
    int findNetworkIndex(const std::string& ssid) const;

    /**
     * @brief Guarda compartilhada dos metodos por SSID: store inicializado +
     *        rede presente no cache.
     *
     * Chamador deve segurar _mutex: devolve ponteiro DENTRO de _networks
     * (invalido apos um push_back/erase concurrente).
     * @param ssid SSID procurado.
     * @param err Recebe NotInitialized ou FileNotFound quando devolve nullptr
     *            (None quando devolve ponteiro).
     * @return Ponteiro para a rede em _networks, ou nullptr (com 'err').
     */
    KnownNetwork* findNetwork(const std::string& ssid, ErrorCode& err);
    const KnownNetwork* findNetwork(const std::string& ssid, ErrorCode& err) const;

    /**
     * @brief Generate NVS key for a network index.
     * @param index The network index.
     * @return The NVS key string.
     */
    static std::string getNetworkKey(size_t index);

    std::vector<KnownNetwork> _networks;    /**< In-memory cache of networks (guardado por _mutex) */
    SemaphoreHandle_t _mutex;               /**< Guarda de _networks: criado no init() */
    bool _initialized;                       /**< Initialization flag */
    
    static constexpr const char* TAG = "NetCredStore";
};

#endif // NETWORK_CREDENTIAL_STORE_H
