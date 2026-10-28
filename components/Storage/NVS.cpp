#include "NVS.h"
#include <esp_log.h>

/**
 * @file NVS.cpp
 * @brief Implementation of the NVS class for non-volatile storage operations.
 */

ErrorCode NVS::initialize() {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        // ESP_ERROR_CHECK abortava o aparelho no boot; a API devolve
        // ErrorCode e o chamador decide (o store falha fechado)
        esp_err_t eraseErr = nvs_flash_erase();
        if (eraseErr != ESP_OK) {
            ESP_LOGE("NVS", "NVS erase failed: %s", esp_err_to_name(eraseErr));
            return CommonErrorCodes::StorageInitFailed;
        }
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        ESP_LOGE("NVS", "NVS initialization failed: %s", esp_err_to_name(err));
        return CommonErrorCodes::StorageInitFailed;
    }
    return CommonErrorCodes::None;
}

ErrorCode NVS::eraseData() {
    esp_err_t err = nvs_flash_erase_partition(NVSConstants::PartitionName);
    if (err != ESP_OK) {
        ESP_LOGE("NVS", "Failed to erase NVS partition: %s", esp_err_to_name(err));
        return CommonErrorCodes::OperationFailed;
    }
    // Re-initialize NVS after erasing
    return initialize();
}

ErrorCode NVS::eraseKey(const std::string& namespaceName, const std::string& key) {
    nvs_handle_t handle;
    ErrorCode err = openNamespace(namespaceName, handle, NVS_READWRITE);
    if (err != CommonErrorCodes::None) {
        // READWRITE on a namespace that was never written: nothing to erase
        if (err == CommonErrorCodes::FileNotFound) return CommonErrorCodes::None;
        return err;
    }
    esp_err_t esp_err = nvs_erase_key(handle, key.c_str());
    if (esp_err == ESP_ERR_NVS_NOT_FOUND) {
        nvs_close(handle);
        return CommonErrorCodes::None;  // no-op, not an error
    }
    if (esp_err != ESP_OK) {
        nvs_close(handle);
        ESP_LOGE("NVS", "Failed to erase key '%s': %s", key.c_str(), esp_err_to_name(esp_err));
        return CommonErrorCodes::OperationFailed;
    }
    esp_err = nvs_commit(handle);
    nvs_close(handle);
    if (esp_err != ESP_OK) {
        ESP_LOGE("NVS", "Failed to commit NVS erase: %s", esp_err_to_name(esp_err));
        return CommonErrorCodes::OperationFailed;
    }
    return CommonErrorCodes::None;
}

ErrorCode NVS::openNamespace(const std::string& namespaceName, nvs_handle_t& handle, nvs_open_mode_t readWriteMode) {
    esp_err_t esp_err = nvs_open_from_partition(NVSConstants::PartitionName, namespaceName.c_str(),
                                                readWriteMode, &handle);
    if (esp_err != ESP_OK) {
        // For READONLY mode, FileNotFound is expected if namespace doesn't exist yet
        // (this is normal for first run)
        if (readWriteMode == NVS_READONLY && esp_err == ESP_ERR_NVS_NOT_FOUND) {
            ESP_LOGD("NVS", "Namespace '%s' not found (first run)", namespaceName.c_str());
            return CommonErrorCodes::FileNotFound;
        }
        
        // For READWRITE mode, namespaces are created automatically on first write
        // ESP_ERR_NVS_NOT_FOUND in READWRITE mode shouldn't happen unless partition is corrupted
        ESP_LOGE("NVS", "Failed to open namespace '%s': %s", namespaceName.c_str(), esp_err_to_name(esp_err));
        return CommonErrorCodes::StorageInitFailed;
    }
    return CommonErrorCodes::None;
}