#ifndef WIFI_CONNECTION_H
#define WIFI_CONNECTION_H

#include <string>
#include <vector>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "ErrorCode.h"
#include "IPAddress.h"
#include "WifiErrorCodes.h"
#include "Event.h"
#include "NetworkTypes.h"

/**
 * @file WifiConnection.h
 * @brief This file defines the WifiConnection class for managing WiFi connections in station mode.
 * 
 * The class is fully event-driven, emitting events for all state changes including
 * scan operations, connection attempts, authentication results, and signal changes.
 */

/**
 * @enum WiFiConnectionState
 * @brief Internal states of the WiFi connection.
 */
enum class WiFiConnectionState {
    Idle,           /**< Not initialized or disconnected */
    Initializing,   /**< Initializing WiFi subsystem */
    Scanning,       /**< Scanning for networks */
    Connecting,     /**< Attempting to connect */
    Connected,      /**< Successfully connected */
    Disconnecting,  /**< Disconnecting from network */
    Error           /**< Error state */
};

/**
 * @struct WiFiScanResult
 * @brief Result of a WiFi scan operation.
 */
struct WiFiScanResult {
    std::vector<ScannedNetwork> networks;   /**< List of found networks */
    int count;                               /**< Number of networks found */
    bool success;                            /**< Whether scan completed successfully */
    ErrorCode error;                         /**< Error code if scan failed */
};

/**
 * @struct WiFiConnectionEvent
 * @brief Data passed with connection-related events.
 */
struct WiFiConnectionEvent {
    std::string ssid;           /**< SSID of the network */
    int8_t rssi;                /**< Signal strength */
    IPAddress ip;               /**< IP address (if connected) */
    ErrorCode error;            /**< Error code (if applicable) */
    uint8_t retryCount;         /**< Number of connection retries */
};

/**
 * @class WifiConnection
 * @brief Manages a WiFi connection in station (STA) mode.
 * 
 * This class provides a fully event-driven interface for WiFi operations. All major
 * state changes are reported through events, allowing consumers to react to WiFi
 * events without polling.
 */
class WifiConnection {
public:
    /**
     * @brief Constructor.
     */
    WifiConnection();

    /**
     * @brief Destructor. Disconnects from the WiFi network if connected.
     */
    ~WifiConnection();

    /**
     * @brief Initialize the WiFi subsystem.
     * 
     * Must be called before any other WiFi operations.
     * 
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode init();

    /**
     * @brief Connects to a WiFi access point.
     *
     * This method is non-blocking when asyncConnect is true. Connection result
     * will be reported through events.
     *
     * @param ssid The SSID (name) of the WiFi network.
     * @param password The password for the WiFi network.
     * @param asyncConnect If true, returns immediately and reports result via events.
     * @return ErrorCode indicating success or failure (or pending if async).
     */
    ErrorCode connect(const std::string& ssid, const std::string& password, bool asyncConnect = false);

    /**
     * @brief Disconnects from the currently connected WiFi network.
     */
    void disconnect();

    /**
     * @brief Checks if the device is currently connected to a WiFi network.
     *
     * @return True if connected, false otherwise.
     */
    [[nodiscard]] bool isConnected() const;

    /**
     * @brief Gets the current connection state.
     * @return The current WiFiConnectionState.
     */
    [[nodiscard]] WiFiConnectionState getState() const;

    /**
     * @brief Gets the SSID of the currently connected WiFi network.
     *
     * @return The SSID as a string, or an empty string if not connected.
     */
    [[nodiscard]] std::string getSSID() const;

    /**
     * @brief Gets the IP address of the device on the WiFi network.
     *
     * @return The IPAddress, or an invalid IPAddress if not connected.
     */
    [[nodiscard]] IPAddress getIPAddress() const;

    /**
     * @brief Gets the current signal strength (RSSI).
     * @return Signal strength in dBm, or 0 if not connected.
     */
    [[nodiscard]] int8_t getRSSI() const;

    /**
     * @brief Gets the current WiFi channel.
     * @return Channel number, or 0 if not connected.
     */
    [[nodiscard]] uint8_t getChannel() const;

    /**
     * @brief Gets complete network information.
     * @return NetworkInfo structure with all connection details.
     * @note IP addresses in returned struct are strings.
     */
    [[nodiscard]] NetworkInfo getNetworkInfo() const;




    /**
     * @brief Scans for available WiFi networks (blocking).
     *
     * @param ap_list Array to store the found access points.
     * @param max_aps Maximum number of access points to scan for.
     * @return Number of networks found, or negative value on error.
     */
    int scan(wifi_ap_record_t* ap_list, uint16_t max_aps);

    /**
     * @brief Starts an asynchronous WiFi scan.
     * 
     * Results will be reported through the onScanCompleted event.
     * 
     * @return ErrorCode indicating if scan was started successfully.
     */
    ErrorCode startScanAsync();

    /**
     * @brief Gets the last scan results.
     * @return WiFiScanResult with the networks found in the last scan.
     */
    [[nodiscard]] WiFiScanResult getLastScanResults() const;

    /**
     * @brief Sets the maximum number of connection retries.
     * @param maxRetries Maximum retry count (default: 5).
     */
    void setMaxRetries(uint8_t maxRetries);

    /**
     * @brief Sets the connection timeout.
     * @param timeoutMs Timeout in milliseconds (default: 10000).
     */
    void setConnectionTimeout(uint32_t timeoutMs);

    // ========== Events ==========

    /**
     * @brief Event triggered when WiFi state changes.
     * Parameters: (WifiConnection*, old_state, new_state)
     */
    Event<WifiConnection*, WiFiConnectionState, WiFiConnectionState> onStateChanged;

    /**
     * @brief Event triggered when a scan completes.
     * Parameters: (WifiConnection*, WiFiScanResult)
     */
    Event<WifiConnection*, const WiFiScanResult&> onScanCompleted;

    /**
     * @brief Event triggered when WiFi connection is established.
     * Parameters: (WifiConnection*, WiFiConnectionEvent)
     */
    Event<WifiConnection*, const WiFiConnectionEvent&> onConnected;

    /**
     * @brief Event triggered when authentication fails.
     * Parameters: (WifiConnection*, ssid, error)
     */
    Event<WifiConnection*, const std::string&, ErrorCode> onAuthFailed;

    /**
     * @brief Event triggered when connection is lost.
     * Parameters: (WifiConnection*, WiFiConnectionEvent)
     */
    Event<WifiConnection*, const WiFiConnectionEvent&> onDisconnected;

    /**
     * @brief Event triggered when RSSI changes significantly.
     * Parameters: (WifiConnection*, old_rssi, new_rssi)
     */
    Event<WifiConnection*, int8_t, int8_t> onSignalChanged;

    // Removidos por falta de assinante (triagem 2026-10): onScanStarted,
    // onConnecting e onRetrying (o pass-through do onRetrying no
    // NetworkManager foi junto com o evento espelho dele).


private:
    static void eventHandler(void* arg, esp_event_base_t event_base, int32_t event_id, void* event_data);
    static void scanDoneHandler(void* arg, esp_event_base_t event_base, int32_t event_id, void* event_data);
    
    /**
     * @brief Changes the internal state and triggers onStateChanged event.
     * @param newState The new state.
     */
    void setState(WiFiConnectionState newState);

    /**
     * @brief Initializes the WiFi subsystem if not already initialized.
     * @return ErrorCode indicating success or failure.
     */
    ErrorCode ensureInitialized();

    /**
     * @brief Updates RSSI and triggers event if changed significantly.
     */
    void updateRssi();

    /**
     * @brief Process scan results and populate the results structure.
     * @param result Output structure to populate.
     */
    void processScanResults(WiFiScanResult& result);

    /** @brief Resultado da guarda de concorrencia de scan (lockScan). */
    enum class ScanLock {
        Ok,         /**< Mutex tomado, scan pode comecar */
        NoMutex,    /**< Mutex inexistente (construtor falhou) */
        Busy        /**< Outro scan em curso */
    };

    /**
     * @brief Guarda compartilhada dos dois caminhos de scan (async e
     *        bloqueante): null-check do mutex, take com 100 ms e flag
     *        _scanInProgress. Em Ok o mutex fica TOMADO — o chamador o
     *        devolve com unlockScan().
     * @param async true ajusta as mensagens de log ao fluxo async.
     */
    ScanLock lockScan(bool async);

    /**
     * @brief Fim de scan (sucesso ou falha): estado Idle, flags zeradas e
     *        mutex devolvido.
     * @param blocking true quando o scan bloqueante zera tambem
     *        _blockingScan.
     */
    void unlockScan(bool blocking);

    /**
     * @brief Config de scan dos dois caminhos: todos os canais, ocultas
     *        inclusas, ativa com 120..300 ms por canal.
     */
    static wifi_scan_config_t defaultScanConfig();

    /**
     * @brief Resultado de falha disparado no onScanCompleted.
     */
    static WiFiScanResult failScanResult();

    /**
     * @brief Evento de conexao montado a partir do estado atual
     *        (ssid/rssi/ip); o sítio que dispara completa o que falta.
     * @param error Codigo de erro transportado no evento.
     */
    WiFiConnectionEvent makeEvent(const ErrorCode& error) const;

    static EventGroupHandle_t _wifiEventGroup; /**< Event group for WiFi events. */
    static const int WIFI_CONNECTED_BIT = BIT0; /**< Event bit for successful connection. */
    static const int WIFI_FAIL_BIT = BIT1; /**< Event bit for connection failure. */
    static const int WIFI_SCAN_DONE_BIT = BIT2; /**< Event bit for scan completion. */
    static const char* TAG; /**< Log tag for the class. */

    /**
     * @brief Registro do esp_event do WIFI_EVENT/IP_EVENT (dono UNICO).
     *
     * Os handlers recebem `this` como arg: precisam ser re-registrados quando
     * outra instancia vira a dona (um function-local static antigo deixava a
     * instancia nova surda e entregava eventos no `this` ja liberado).
     */
    static esp_event_handler_instance_t _instanceAnyId;
    static esp_event_handler_instance_t _instanceGotIp;
    static WifiConnection* _eventOwner; /**< Instancia registrada como arg. */

    std::string _ssid; /**< SSID of the target WiFi network (escrito pela task chamadora em connect()/disconnect() e lido pelo handler do esp_event: acesso sob _ssidMutex). */
    std::string _password; /**< Password of the target WiFi network (mesma guarda do _ssid: dois connect() de tasks diferentes escreviam concorrente). */
    IPAddress _ipAddress; /**< The current IP address of the device. */
    int8_t _rssi; /**< Current signal strength. */
    int8_t _lastReportedRssi; /**< Last RSSI value reported via event. */
    uint8_t _channel; /**< Current WiFi channel. */
    uint8_t _retryNum; /**< Number of connection retry attempts. */
    uint8_t _maxRetries; /**< Maximum retry attempts. */
    uint32_t _connectionTimeout; /**< Connection timeout in ms. */
    bool _isConnected; /**< Flag indicating if the connection is active. */
    bool _initialized; /**< Flag indicating if WiFi subsystem is initialized. */
    bool _asyncMode; /**< Flag indicating if in async connection mode. */
    bool _scanInProgress; /**< Flag indicating if a scan is currently running. */
    bool _blockingScan; /**< Flag indicating if current scan is blocking (results handled by caller). */
    /**
     * @brief Suprime o proximo WIFI_EVENT_STA_DISCONNECTED.
     *
     * connect() sobre uma estacao associada chama esp_wifi_disconnect()
     * POR CONTA PROPRIA antes de associar ao novo AP: o evento gerado por
     * esse disconnect chega depois e, sem a flag, era lido como falha da
     * NOVA tentativa (retry espurio ou FAIL_BIT que derrubava a conexao
     * que estava subindo).
     */
    bool _suppressNextDisconnect;
    WiFiConnectionState _state; /**< Current connection state. */
    WiFiScanResult _lastScanResult; /**< Results from the last scan. */
    SemaphoreHandle_t _scanMutex; /**< Mutex to protect scan operations. */
    SemaphoreHandle_t _ssidMutex; /**< Guarda de _ssid/_password: std::string escritos pela task chamadora (connect/disconnect) e lidos pelo handler do esp_event (makeEvent/onAuthFailed) — assign/clear concorrente com a copia do handler rasgava o heap. */

    static constexpr int8_t RSSI_CHANGE_THRESHOLD = 5; /**< RSSI change threshold for events (dB). */
};

#endif // WIFI_CONNECTION_H
