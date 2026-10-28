#include "SystemInfo.h"

#include "esp_system.h"
#include "esp_chip_info.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_flash.h"
#include "esp_idf_version.h"
#include "esp_log.h"
#include "spi_flash_mmap.h"

#include <cstdio>
#include <cstring>

SystemInfo& SystemInfo::instance() {
    static SystemInfo instance;
    return instance;
}

// ========== Chip Information ==========

ChipInfo SystemInfo::getChipInfo() const {
    ChipInfo info;
    esp_chip_info_t chip_info;
    esp_chip_info(&chip_info);

    // Determine model name
    switch (chip_info.model) {
        case CHIP_ESP32:
            info.model = "ESP32";
            break;
        case CHIP_ESP32S2:
            info.model = "ESP32-S2";
            break;
        case CHIP_ESP32S3:
            info.model = "ESP32-S3";
            break;
        case CHIP_ESP32C3:
            info.model = "ESP32-C3";
            break;
        case CHIP_ESP32C2:
            info.model = "ESP32-C2";
            break;
        case CHIP_ESP32C6:
            info.model = "ESP32-C6";
            break;
        case CHIP_ESP32H2:
            info.model = "ESP32-H2";
            break;
        default:
            info.model = "Unknown";
            break;
    }

    info.cores = chip_info.cores;
    info.revision = chip_info.revision;
    info.hasWifi = (chip_info.features & CHIP_FEATURE_WIFI_BGN) != 0;
    info.hasBluetooth = (chip_info.features & CHIP_FEATURE_BT) != 0;
    info.hasBLE = (chip_info.features & CHIP_FEATURE_BLE) != 0;
    info.hasEmbeddedFlash = (chip_info.features & CHIP_FEATURE_EMB_FLASH) != 0;
    info.hasEmbeddedPsram = (chip_info.features & CHIP_FEATURE_EMB_PSRAM) != 0;

    return info;
}

std::string SystemInfo::getChipModel() const {
    return getChipInfo().model;
}

uint8_t SystemInfo::getCoreCount() const {
    esp_chip_info_t chip_info;
    esp_chip_info(&chip_info);
    return chip_info.cores;
}

uint16_t SystemInfo::getChipRevision() const {
    esp_chip_info_t chip_info;
    esp_chip_info(&chip_info);
    return chip_info.revision;
}

// ========== Memory Information ==========

MemoryInfo SystemInfo::getMemoryInfo() const {
    MemoryInfo info;
    
    info.freeHeap = esp_get_free_heap_size();
    info.minFreeHeap = esp_get_minimum_free_heap_size();
    info.largestFreeBlock = heap_caps_get_largest_free_block(MALLOC_CAP_DEFAULT);
    info.totalHeap = heap_caps_get_total_size(MALLOC_CAP_DEFAULT);
    
    // PSRAM info
    info.freePsram = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    info.totalPsram = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);

    return info;
}

uint32_t SystemInfo::getFreeHeap() const {
    return esp_get_free_heap_size();
}

uint32_t SystemInfo::getMinFreeHeap() const {
    return esp_get_minimum_free_heap_size();
}

uint32_t SystemInfo::getLargestFreeBlock() const {
    return heap_caps_get_largest_free_block(MALLOC_CAP_DEFAULT);
}

bool SystemInfo::hasPsram() const {
    return heap_caps_get_total_size(MALLOC_CAP_SPIRAM) > 0;
}

uint32_t SystemInfo::getFreePsram() const {
    return heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
}

// ========== Identification ==========

std::string SystemInfo::getMacAddress() const {
    uint8_t mac[6];
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) {
        return "00:00:00:00:00:00";
    }
    
    char buffer[18];
    snprintf(buffer, sizeof(buffer), "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return std::string(buffer);
}

bool SystemInfo::getMacAddressBytes(uint8_t* mac) const {
    if (mac == nullptr) {
        return false;
    }
    return esp_read_mac(mac, ESP_MAC_WIFI_STA) == ESP_OK;
}

std::string SystemInfo::getDeviceId() const {
    uint8_t mac[6];
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) {
        return "000000";
    }
    
    char buffer[7];
    snprintf(buffer, sizeof(buffer), "%02X%02X%02X", mac[3], mac[4], mac[5]);
    return std::string(buffer);
}

std::string SystemInfo::getFullDeviceId() const {
    uint8_t mac[6];
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) {
        return "000000000000";
    }
    
    char buffer[13];
    snprintf(buffer, sizeof(buffer), "%02X%02X%02X%02X%02X%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return std::string(buffer);
}

// ========== Runtime Information ==========

uint32_t SystemInfo::getUptimeSeconds() const {
    return static_cast<uint32_t>(esp_timer_get_time() / 1000000ULL);
}

uint64_t SystemInfo::getUptimeMillis() const {
    return esp_timer_get_time() / 1000ULL;
}

std::string SystemInfo::getFormattedUptime() const {
    uint32_t total_seconds = getUptimeSeconds();
    uint32_t days = total_seconds / 86400;
    uint32_t hours = (total_seconds % 86400) / 3600;
    uint32_t minutes = (total_seconds % 3600) / 60;
    uint32_t seconds = total_seconds % 60;
    
    char buffer[32];
    if (days > 0) {
        snprintf(buffer, sizeof(buffer), "%lud %02lu:%02lu:%02lu",
                 (unsigned long)days, (unsigned long)hours, 
                 (unsigned long)minutes, (unsigned long)seconds);
    } else {
        snprintf(buffer, sizeof(buffer), "%02lu:%02lu:%02lu",
                 (unsigned long)hours, (unsigned long)minutes, (unsigned long)seconds);
    }
    return std::string(buffer);
}

ResetReason SystemInfo::getResetReason() const {
    esp_reset_reason_t reason = esp_reset_reason();
    
    switch (reason) {
        case ESP_RST_POWERON:
            return ResetReason::PowerOn;
        case ESP_RST_EXT:
            return ResetReason::ExternalReset;
        case ESP_RST_SW:
            return ResetReason::Software;
        case ESP_RST_PANIC:
            return ResetReason::Panic;
        case ESP_RST_INT_WDT:
            return ResetReason::IntWatchdog;
        case ESP_RST_TASK_WDT:
            return ResetReason::TaskWatchdog;
        case ESP_RST_WDT:
            return ResetReason::Watchdog;
        case ESP_RST_DEEPSLEEP:
            return ResetReason::DeepSleep;
        case ESP_RST_BROWNOUT:
            return ResetReason::Brownout;
        case ESP_RST_SDIO:
            return ResetReason::Sdio;
        default:
            return ResetReason::Unknown;
    }
}

std::string SystemInfo::getResetReasonString() const {
    switch (getResetReason()) {
        case ResetReason::PowerOn:
            return "Power-on";
        case ResetReason::ExternalReset:
            return "External reset";
        case ResetReason::Software:
            return "Software reset";
        case ResetReason::Panic:
            return "Panic/Exception";
        case ResetReason::IntWatchdog:
            return "Interrupt watchdog";
        case ResetReason::TaskWatchdog:
            return "Task watchdog";
        case ResetReason::Watchdog:
            return "Watchdog";
        case ResetReason::DeepSleep:
            return "Deep sleep wake";
        case ResetReason::Brownout:
            return "Brownout";
        case ResetReason::Sdio:
            return "SDIO reset";
        default:
            return "Unknown";
    }
}

// ========== Flash Information ==========

FlashInfo SystemInfo::getFlashInfo() const {
    FlashInfo info;
    
    // Get flash size
    uint32_t flash_size = 0;
    if (esp_flash_get_size(nullptr, &flash_size) == ESP_OK) {
        info.size = flash_size;
    } else {
        // Fallback to compiled size based on config
        #if defined(CONFIG_ESPTOOLPY_FLASHSIZE_4MB)
            info.size = 4 * 1024 * 1024;
        #elif defined(CONFIG_ESPTOOLPY_FLASHSIZE_2MB)
            info.size = 2 * 1024 * 1024;
        #elif defined(CONFIG_ESPTOOLPY_FLASHSIZE_8MB)
            info.size = 8 * 1024 * 1024;
        #elif defined(CONFIG_ESPTOOLPY_FLASHSIZE_16MB)
            info.size = 16 * 1024 * 1024;
        #elif defined(CONFIG_ESPTOOLPY_FLASHSIZE_32MB)
            info.size = 32 * 1024 * 1024;
        #else
            info.size = 4 * 1024 * 1024;  // Default
        #endif
    }
    
    // Get flash speed and mode from compile-time config
    #if defined(CONFIG_ESPTOOLPY_FLASHFREQ_80M)
        info.speed = 80000000;
    #elif defined(CONFIG_ESPTOOLPY_FLASHFREQ_40M)
        info.speed = 40000000;
    #elif defined(CONFIG_ESPTOOLPY_FLASHFREQ_26M)
        info.speed = 26000000;
    #elif defined(CONFIG_ESPTOOLPY_FLASHFREQ_20M)
        info.speed = 20000000;
    #else
        info.speed = 40000000;  // Default
    #endif
    
    #if defined(CONFIG_ESPTOOLPY_FLASHMODE_QIO)
        info.mode = "QIO";
    #elif defined(CONFIG_ESPTOOLPY_FLASHMODE_QOUT)
        info.mode = "QOUT";
    #elif defined(CONFIG_ESPTOOLPY_FLASHMODE_DIO)
        info.mode = "DIO";
    #elif defined(CONFIG_ESPTOOLPY_FLASHMODE_DOUT)
        info.mode = "DOUT";
    #else
        info.mode = "Unknown";
    #endif

    return info;
}

uint32_t SystemInfo::getFlashSize() const {
    uint32_t flash_size = 0;
    if (esp_flash_get_size(nullptr, &flash_size) == ESP_OK) {
        return flash_size;
    }
    // Fallback
    #if defined(CONFIG_ESPTOOLPY_FLASHSIZE_4MB)
        return 4 * 1024 * 1024;
    #elif defined(CONFIG_ESPTOOLPY_FLASHSIZE_2MB)
        return 2 * 1024 * 1024;
    #elif defined(CONFIG_ESPTOOLPY_FLASHSIZE_8MB)
        return 8 * 1024 * 1024;
    #elif defined(CONFIG_ESPTOOLPY_FLASHSIZE_16MB)
        return 16 * 1024 * 1024;
    #elif defined(CONFIG_ESPTOOLPY_FLASHSIZE_32MB)
        return 32 * 1024 * 1024;
    #else
        return 4 * 1024 * 1024;
    #endif
}

// ========== IDF Information ==========

std::string SystemInfo::getIdfVersion() const {
    return std::string(esp_get_idf_version());
}

// ========== Formatted Output ==========

std::string SystemInfo::getSummary() const {
    ChipInfo chip = getChipInfo();
    MemoryInfo mem = getMemoryInfo();
    FlashInfo flash = getFlashInfo();

    // Flash em MB com 1 decimal sem float no printf: decimos =
    // (size*5)/2^19 com arredondamento half-even — saida identica ao
    // "%.1f" antigo (size/(1024.0f*1024.0f) e exato: divisao por potencia
    // de 2). Evita puxar o conversor de doubles da libc so por esta linha.
    const uint64_t mb5 = (uint64_t)flash.size * 5;  // x10 ja aplicado
    const uint64_t mbQ = mb5 >> 19, mbR = mb5 & ((1ULL << 19) - 1);
    const unsigned mbTenths = (unsigned)(mbQ +
        ((mbR > (1ULL << 18) || (mbR == (1ULL << 18) && (mbQ & 1))) ? 1 : 0));

    char buffer[512];
    snprintf(buffer, sizeof(buffer),
        "=== System Info ===\n"
        "Chip: %s Rev %d (%d cores)\n"
        "MAC: %s\n"
        "Device ID: %s\n"
        "IDF: %s\n"
        "Flash: %u.%u MB (%s @ %lu MHz)\n"
        "Heap: %lu KB free / %lu KB total\n"
        "Min free: %lu KB, Largest block: %lu KB\n"
        "%s"
        "Uptime: %s\n"
        "Reset: %s\n",
        chip.model.c_str(), chip.revision, chip.cores,
        getMacAddress().c_str(),
        getDeviceId().c_str(),
        getIdfVersion().c_str(),
        mbTenths / 10, mbTenths % 10, flash.mode.c_str(),
        (unsigned long)(flash.speed / 1000000),
        (unsigned long)(mem.freeHeap / 1024),
        (unsigned long)(mem.totalHeap / 1024),
        (unsigned long)(mem.minFreeHeap / 1024),
        (unsigned long)(mem.largestFreeBlock / 1024),
        hasPsram() ? "PSRAM: Available\n" : "",
        getFormattedUptime().c_str(),
        getResetReasonString().c_str()
    );

    return std::string(buffer);
}
