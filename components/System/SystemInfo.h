#ifndef SYSTEM_INFO_H
#define SYSTEM_INFO_H

#include <string>
#include <cstdint>

/**
 * @file SystemInfo.h
 * @brief Provides system information about the ESP32 device.
 * 
 * This singleton class provides easy access to hardware and runtime
 * information including chip details, memory statistics, MAC address,
 * uptime, and reset reason.
 */

/**
 * @enum ResetReason
 * @brief Enumeration of possible reset reasons.
 */
enum class ResetReason {
    Unknown,        /**< Unknown reset reason */
    PowerOn,        /**< Power-on reset */
    ExternalReset,  /**< External pin reset */
    Software,       /**< Software reset via esp_restart() */
    Panic,          /**< Software reset due to exception/panic */
    IntWatchdog,    /**< Interrupt watchdog reset */
    TaskWatchdog,   /**< Task watchdog reset */
    Watchdog,       /**< Other watchdog reset */
    DeepSleep,      /**< Reset after exiting deep sleep */
    Brownout,       /**< Brownout reset (power voltage drop) */
    Sdio            /**< Reset over SDIO */
};

/**
 * @struct ChipInfo
 * @brief Information about the ESP32 chip.
 */
struct ChipInfo {
    std::string model;      /**< Chip model name (e.g., "ESP32", "ESP32-S3") */
    uint8_t cores;          /**< Number of CPU cores */
    uint16_t revision;      /**< Silicon revision (IDF: major*100+minor; nao cabe em 8 bits) */
    bool hasWifi;           /**< Has WiFi capability */
    bool hasBluetooth;      /**< Has Bluetooth capability */
    bool hasBLE;            /**< Has Bluetooth Low Energy capability */
    bool hasEmbeddedFlash;  /**< Has embedded flash */
    bool hasEmbeddedPsram;  /**< Has embedded PSRAM */
};

/**
 * @struct MemoryInfo
 * @brief Information about system memory.
 */
struct MemoryInfo {
    uint32_t freeHeap;          /**< Current free heap in bytes */
    uint32_t minFreeHeap;       /**< Minimum free heap ever recorded */
    uint32_t largestFreeBlock;  /**< Largest contiguous free block */
    uint32_t totalHeap;         /**< Total heap size */
    uint32_t freePsram;         /**< Free PSRAM (0 if not available) */
    uint32_t totalPsram;        /**< Total PSRAM (0 if not available) */
};

/**
 * @struct FlashInfo
 * @brief Information about flash memory.
 */
struct FlashInfo {
    uint32_t size;          /**< Flash size in bytes */
    uint32_t speed;         /**< Flash speed in Hz */
    std::string mode;       /**< Flash mode (QIO, QOUT, DIO, DOUT) */
};

/**
 * @class SystemInfo
 * @brief Singleton class providing system information.
 * 
 * Usage:
 * @code
 * auto& sys = SystemInfo::instance();
 * ESP_LOGI(TAG, "MAC: %s", sys.getMacAddress().c_str());
 * ESP_LOGI(TAG, "Free heap: %lu", sys.getMemoryInfo().freeHeap);
 * @endcode
 */
class SystemInfo {
public:
    /**
     * @brief Get the singleton instance.
     * @return Reference to the SystemInfo instance.
     */
    static SystemInfo& instance();

    // ========== Chip Information ==========

    /**
     * @brief Get chip information.
     * @return ChipInfo structure with chip details.
     */
    ChipInfo getChipInfo() const;

    /**
     * @brief Get chip model as string.
     * @return Chip model name (e.g., "ESP32", "ESP32-S3").
     */
    std::string getChipModel() const;

    /**
     * @brief Get number of CPU cores.
     * @return Number of cores (1 or 2).
     */
    uint8_t getCoreCount() const;

    /**
     * @brief Get silicon revision.
     * @return Revision number (IDF: major*100+minor).
     */
    uint16_t getChipRevision() const;

    // ========== Memory Information ==========

    /**
     * @brief Get memory information.
     * @return MemoryInfo structure with memory statistics.
     */
    MemoryInfo getMemoryInfo() const;

    /**
     * @brief Get current free heap size.
     * @return Free heap in bytes.
     */
    uint32_t getFreeHeap() const;

    /**
     * @brief Get minimum free heap ever recorded.
     * @return Minimum free heap in bytes.
     */
    uint32_t getMinFreeHeap() const;

    /**
     * @brief Get largest contiguous free block.
     * @return Largest block size in bytes.
     */
    uint32_t getLargestFreeBlock() const;

    /**
     * @brief Check if PSRAM is available.
     * @return True if PSRAM is present and enabled.
     */
    bool hasPsram() const;

    /**
     * @brief Get free PSRAM.
     * @return Free PSRAM in bytes (0 if not available).
     */
    uint32_t getFreePsram() const;

    // ========== Identification ==========

    /**
     * @brief Get WiFi MAC address.
     * @return MAC address as string (e.g., "AA:BB:CC:DD:EE:FF").
     */
    std::string getMacAddress() const;

    /**
     * @brief Get WiFi MAC address as bytes.
     * @param mac Output buffer (6 bytes).
     * @return True if successful.
     */
    bool getMacAddressBytes(uint8_t* mac) const;

    /**
     * @brief Get unique device ID based on MAC address.
     * @return Device ID string (last 6 hex chars of MAC).
     */
    std::string getDeviceId() const;

    /**
     * @brief Get full device ID (all MAC bytes).
     * @return Full device ID string (12 hex chars).
     */
    std::string getFullDeviceId() const;

    // ========== Runtime Information ==========

    /**
     * @brief Get system uptime in seconds.
     * @return Uptime in seconds since boot.
     */
    uint32_t getUptimeSeconds() const;

    /**
     * @brief Get system uptime in milliseconds.
     * @return Uptime in milliseconds since boot.
     */
    uint64_t getUptimeMillis() const;

    /**
     * @brief Get formatted uptime string.
     * @return Uptime as "HH:MM:SS" or "Xd HH:MM:SS" if > 24h.
     */
    std::string getFormattedUptime() const;

    /**
     * @brief Get the reason for the last reset.
     * @return ResetReason enumeration value.
     */
    ResetReason getResetReason() const;

    /**
     * @brief Get reset reason as string.
     * @return Human-readable reset reason.
     */
    std::string getResetReasonString() const;

    // ========== Flash Information ==========

    /**
     * @brief Get flash information.
     * @return FlashInfo structure with flash details.
     */
    FlashInfo getFlashInfo() const;

    /**
     * @brief Get flash size in bytes.
     * @return Flash size.
     */
    uint32_t getFlashSize() const;

    // ========== IDF Information ==========

    /**
     * @brief Get ESP-IDF version.
     * @return IDF version string (e.g., "v5.1.2").
     */
    std::string getIdfVersion() const;

    // ========== Formatted Output ==========

    /**
     * @brief Get a summary of all system information.
     * @return Multi-line string with system summary.
     */
    std::string getSummary() const;

private:
    SystemInfo() = default;
    ~SystemInfo() = default;
    SystemInfo(const SystemInfo&) = delete;
    SystemInfo& operator=(const SystemInfo&) = delete;

    static constexpr const char* TAG = "SystemInfo";
};

#endif // SYSTEM_INFO_H
