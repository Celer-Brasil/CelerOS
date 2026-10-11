#ifndef NETWORK_MANAGER_H
#define NETWORK_MANAGER_H

#include <string>
#include <vector>
#include <optional>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "NetworkTypes.h"
#include "NetworkCredentialStore.h"
#include "NetworkSelector.h"
#include "Event.h"
#include "ErrorCode.h"

// Forward declaration to avoid circular dependency
// WifiConnection is defined in Wifi component
class WifiConnection;
struct WiFiConnectionEvent;
struct WiFiScanResult;
enum class WiFiConnectionState;

/**
 * @file NetworkManager.h
 * @brief Central network connectivity manager similar to Android's ConnectivityManager.
 * 
 * NetworkManager provides a unified interface for managing network connections,
 * including WiFi (and future Bluetooth support). It handles:
 * - Automatic network selection based on signal strength and priority
 * - Persistent credential storage
 * - Background scanning and aggressive reconnection
 * - Network roaming to better networks
 * - Event-driven state notifications
 */

/**
 * @struct NetworkManagerStats
 * @brief Statistics about network operations.
 */
struct NetworkManagerStats {
    uint32_t totalConnections;      /**< Total successful connections */
    uint32_t failedConnections;     /**< Total failed connection attempts */
    uint32_t roamingEvents;         /**< Number of roaming events */
    uint32_t scanCount;             /**< Number of scans performed */
    uint32_t reconnections;         /**< Number of automatic reconnections */
    uint32_t uptimeSeconds;         /**< Time connected in seconds */
    
    NetworkManagerStats() : totalConnections(0), failedConnections(0),
                           roamingEvents(0), scanCount(0), reconnections(0),
                           uptimeSeconds(0) {}
};

/**
 * @class NetworkManager
 * @brief Central manager for all network connectivity operations.
 * 
 * This class replaces the old ConnectionManager and provides a comprehensive
 * event-driven interface for managing network connections. It integrates:
 * - WiFiConnection for WiFi operations
 * - NetworkCredentialStore for persistent storage
 * - NetworkSelector for intelligent network selection
 * 
 * The NetworkManager runs a background task for continuous monitoring and
 * aggressive reconnection to maintain optimal connectivity.
 */
class NetworkManager {
public:
    /**
     * @brief Get the singleton instance.
     * @return Reference to the NetworkManager instance.
     */
    static NetworkManager& instance();

    /**
     * @brief Initialize the NetworkManager.
     * 
     * Initializes all subsystems (WiFi, credential store, etc.) and
     * optionally starts the background monitoring task.
     * 
     * @param startBackgroundTask If true, starts background scan/reconnect task.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode init(bool startBackgroundTask = true);

    /**
     * @brief Deinitialize and cleanup resources.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode deinit();

    // ========== Connection Management ==========

    /**
     * @brief Connect to a specific network.
     * 
     * If the network is not known, it will be saved automatically on success.
     * 
     * @param ssid Network SSID.
     * @param password Network password.
     * @param saveOnSuccess If true, save credentials on successful connection.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode connect(const std::string& ssid, const std::string& password, 
                      bool saveOnSuccess = true);

    /**
     * @brief Connect to the best available known network.
     * 
     * Scans for networks and connects to the best one based on
     * priority and signal strength.
     * 
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode connectToKnown();

    /**
     * @brief Disconnect from the current network.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode disconnect();

    /**
     * @brief Reconnect to the last connected network.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode reconnect();

    // ========== Network Management ==========

    /**
     * @brief Add a network to the known networks list.
     * @param network The network to add.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode addNetwork(const KnownNetwork& network);

    /**
     * @brief Remove a network from the known networks list.
     * @param ssid SSID of the network to remove.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode removeNetwork(const std::string& ssid);

    /**
     * @brief Set the priority of a known network.
     * @param ssid SSID of the network.
     * @param priority New priority (0-100).
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode setNetworkPriority(const std::string& ssid, int8_t priority);

    /**
     * @brief Get all known networks.
     * @return Vector of known networks.
     */
    std::vector<KnownNetwork> getKnownNetworks() const;

    /**
     * @brief Check if a network is in the known list.
     * @param ssid SSID to check.
     * @return True if network is known.
     */
    bool isKnownNetwork(const std::string& ssid) const;

    // ========== Scanning ==========

    /**
     * @brief Start a WiFi scan.
     * 
     * Results will be reported through onScanCompleted event.
     * 
     * @param blocking If true, blocks until scan completes.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode startScan(bool blocking = false);

    /**
     * @brief Get results from the last scan.
     * @return Vector of scanned networks.
     */
    std::vector<ScannedNetwork> getLastScanResults() const;

    // ========== State Queries ==========

    /**
     * @brief Get the current network state.
     * @return Current NetworkState.
     */
    NetworkState getState() const;

    /**
     * @brief Check if connected to any network.
     * @return True if connected.
     */
    bool isConnected() const;

    /**
     * @brief Get information about the active network.
     * @return NetworkInfo structure (empty if not connected).
     */
    NetworkInfo getActiveNetwork() const;

    /**
     * @brief Get the current signal strength.
     * @return RSSI in dBm, or 0 if not connected.
     */
    int8_t getCurrentRssi() const;

    /**
     * @brief Get the current IP address.
     * @return IP address as string, or empty if not connected.
     */
    std::string getIpAddress() const;

    /**
     * @brief Get operation statistics.
     * @return NetworkManagerStats structure.
     */
    NetworkManagerStats getStats() const;

    // ========== Configuration ==========

    /**
     * @brief Enable or disable automatic reconnection.
     * @param enabled True to enable.
     */
    void setAutoReconnect(bool enabled);

    /**
     * @brief Segura o canal do radio (CelerOS: sessoes ESP-NOW dos recursos
     * da matilha). Com o pedido ativo a background task NAO faz scan de
     * roaming nem a busca de quem ja estava sem rede: o scan pula de canal
     * por segundos e as sessoes ESP-NOW (que vivem no canal atual) perderiam
     * tudo nesse tempo. Quem caiu do AP ha menos de 2 min reconecta mesmo
     * assim (a internet do no tem prioridade; a sessao renegocia o canal).
     * Contador: cada hold(true) pede um hold(false).
     */
    void holdChannel(bool on);
    bool channelHeld() const { return _channelHolds > 0; }

    /**
     * @brief Check if auto-reconnect is enabled.
     * @return True if enabled.
     */
    bool isAutoReconnectEnabled() const;

    /**
     * @brief Set the background scan interval.
     * @param seconds Interval in seconds (minimum 10).
     */
    void setBackgroundScanInterval(uint32_t seconds);

    /**
     * @brief Get the current scan interval.
     * @return Interval in seconds.
     */
    uint32_t getBackgroundScanInterval() const;

    /**
     * @brief Set the roaming RSSI threshold.
     * @param threshold RSSI improvement needed to trigger roaming (dB).
     */
    void setRoamingThreshold(int8_t threshold);

    /**
     * @brief Enable or disable network roaming.
     * @param enabled True to enable.
     */
    void setRoamingEnabled(bool enabled);

    /**
     * @brief Get the full configuration.
     * @return Current NetworkConfig.
     */
    const NetworkConfig& getConfig() const;

    /**
     * @brief Set the full configuration.
     * @param config New configuration.
     */
    void setConfig(const NetworkConfig& config);

    // ========== Background Task Control ==========

    /**
     * @brief Start the background monitoring task.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode startBackgroundTask();

    /**
     * @brief Stop the background monitoring task.
     */
    void stopBackgroundTask();

    /**
     * @brief Check if background task is running.
     * @return True if running.
     */
    bool isBackgroundTaskRunning() const;

    // ========== Events ==========

    /**
     * @brief Event triggered when network state changes.
     * Parameters: (old_state, new_state)
     */
    Event<NetworkState, NetworkState> onStateChanged;

    /**
     * @brief Event triggered when scan completes.
     * Parameter: Vector of scanned networks.
     */
    Event<const std::vector<ScannedNetwork>&> onScanCompleted;

    // Demais eventos removidos (triagem 2026-10, zero assinantes no
    // firmware): onNetworkAvailable/onNetworkLost/onNetworkChanged/
    // onConnectionFailed/onRetrying. Estado va via onStateChanged ou
    // polling (getActiveNetwork/isConnected/getStats).

    // ========== Direct Access (Advanced) ==========

    /**
     * @brief Get direct access to WiFiConnection (for advanced use).
     * @return Pointer to the WiFiConnection instance (nullptr if not initialized).
     */
    WifiConnection* getWifiConnection();

    /**
     * @brief Get direct access to NetworkCredentialStore.
     * @return Reference to the NetworkCredentialStore instance.
     */
    NetworkCredentialStore& getCredentialStore() { return NetworkCredentialStore::instance(); }

    /**
     * @brief Get direct access to NetworkSelector.
     * @return Reference to the NetworkSelector instance.
     */
    NetworkSelector& getSelector() { return NetworkSelector::instance(); }

private:
    NetworkManager();
    ~NetworkManager();
    NetworkManager(const NetworkManager&) = delete;
    NetworkManager& operator=(const NetworkManager&) = delete;

    /**
     * @brief Set the network state and trigger event.
     * @param newState New state to set.
     */
    void setState(NetworkState newState);

    /**
     * @brief Handle WiFi state change events.
     */
    void onWifiStateChanged(WifiConnection* conn, WiFiConnectionState oldState, 
                           WiFiConnectionState newState);

    /**
     * @brief Handle WiFi connection event.
     */
    void onWifiConnected(WifiConnection* conn, const WiFiConnectionEvent& event);

    /**
     * @brief Handle WiFi disconnection event.
     */
    void onWifiDisconnected(WifiConnection* conn, const WiFiConnectionEvent& event);

    /**
     * @brief Handle WiFi scan completed event.
     */
    void onWifiScanCompleted(WifiConnection* conn, const WiFiScanResult& result);

    /**
     * @brief Handle WiFi auth failed event.
     */
    void onWifiAuthFailed(WifiConnection* conn, const std::string& ssid, ErrorCode error);

    /**
     * @brief Handle WiFi signal change event.
     */
    void onWifiSignalChanged(WifiConnection* conn, int8_t oldRssi, int8_t newRssi);

    /**
     * @brief Background task function.
     */
    static void backgroundTaskFunc(void* param);

    /**
     * @brief Perform background scan and potential roaming.
     */
    void performBackgroundScan();

    /**
     * @brief Check if should roam to a better network.
     */
    void checkForBetterNetwork();

    /**
     * @brief Try to reconnect after connection loss.
     */
    void tryReconnect();

    /**
     * @brief Absorve o resultado de um scan para _lastScan marcando quais
     *        redes sao conhecidas (mesmo loop nos tres caminhos de scan).
     */
    void absorbScanResults(const wifi_ap_record_t* ap_list, int count);
    void absorbScanResults(const std::vector<ScannedNetwork>& networks);

    WifiConnection* _wifiConnection;        /**< WiFi connection handler (heap allocated) */
    NetworkConfig _config;                   /**< Configuration */
    NetworkState _state;                     /**< Current state */
    NetworkInfo _activeNetwork;              /**< Currently connected network info */
    NetworkManagerStats _stats;              /**< Statistics */
    std::vector<ScannedNetwork> _lastScan;   /**< Last scan results */
    std::string _lastSsid;                   /**< Last connected SSID */
    std::string _lastPassword;               /**< Last connected password */

    TaskHandle_t _backgroundTask;            /**< Background task handle */
    SemaphoreHandle_t _mutex;                /**< Thread safety mutex */
    volatile bool _backgroundTaskRunning;    /**< Background task flag */
    volatile int _channelHolds = 0;  // holdChannel(): scans de fundo suspensos
    volatile bool _initialized;              /**< Initialization flag */
    uint32_t _lastScanTime;                  /**< Timestamp of last scan */
    uint32_t _connectionStartTime;           /**< When current connection started */

    static constexpr const char* TAG = "NetworkManager";
    static constexpr uint32_t BACKGROUND_TASK_STACK_SIZE = 8192;  // Increased for WiFi operations
    static constexpr UBaseType_t BACKGROUND_TASK_PRIORITY = 5;
    static constexpr uint32_t MIN_SCAN_INTERVAL = 10;  // Minimum 10 seconds
};

#endif // NETWORK_MANAGER_H
