#ifndef NVS_H
#define NVS_H

#include <string>
#include <map>
#include <cstdlib>
#include <nvs_flash.h>
#include <nvs_handle.hpp>
#include <nvs.h>
#include "CommonErrorCodes.h"
#include "esp_log.h"

/**
 * @file NVS.h
 * @brief Defines the NVS class for interacting with the ESP32's non-volatile storage (NVS).
 */

/**
 * @namespace NVSConstants
 * @brief Contains constants related to the NVS module.
 */
namespace NVSConstants {
    static constexpr const char* PartitionName = "nvs"; /**< Default NVS partition name. */
}

/**
 * @class NVS
 * @brief Provides a simplified interface for storing and retrieving key-value data in NVS.
 */
class NVS {
public:
    /**
     * @brief Initializes the NVS flash memory.
     * 
     * This method must be called before any other NVS operations.
     * If initialization fails, the ESP32 might need to be restarted.
     *
     * @return ErrorCode indicating the result of the initialization process.
     */
    static ErrorCode initialize();

    /**
     * @brief Erases all data in the NVS partition.
     *
     * @return ErrorCode indicating success or failure.
     */
    static ErrorCode eraseData();

    /**
     * @brief Erases a single key from a namespace.
     *
     * Erasing a key that does not exist is a no-op (returns None) — callers
     * use this to clean up stale entries without tracking what was written.
     *
     * @param namespaceName The namespace holding the key.
     * @param key The key to erase.
     * @return ErrorCode indicating success or failure.
     */
    static ErrorCode eraseKey(const std::string& namespaceName, const std::string& key);

    /**
     * @brief Stores a value in NVS associated with a specific key and namespace.
     *
     * @tparam T The type of the value to be stored. Must be a supported NVS data type.
     * @param namespaceName The namespace where the key-value pair will be stored.
     * @param key The key to associate with the value.
     * @param value The value to be stored.
     * @param overwrite If true, an existing key in the namespace will be overwritten. If false,
     *        the function will return CommonErrorCodes::KeyAlreadyExists if the key already exists. 
     * @return ErrorCode indicating success or failure of the storage operation.
     */
    template<typename T>
    static ErrorCode storeValue(const std::string& namespaceName, const std::string& key,
                                const T& value, bool overwrite = true);

    /**
     * @brief Reads a value from NVS associated with a specific key and namespace.
     *
     * @tparam T The type of the value to be read. Must be a supported NVS data type.
     * @param namespaceName The namespace where the key-value pair is stored.
     * @param key The key associated with the value.
     * @param value A reference to a variable to store the read value.
     * @return ErrorCode indicating success or failure of the read operation.
     */
    template<typename T>
    static ErrorCode readValue(const std::string& namespaceName, const std::string& key, T& value);

    /**
     * @brief Gets all key-value pairs within a specified namespace.
     *
     * @tparam T The type of the values to be read. Must be a supported NVS data type.
     * @param namespaceName The namespace to read the keys and values from.
     * @param dataMap A reference to a map that will be populated with the key-value pairs.
     * @return ErrorCode indicating success or failure of the operation.
     */
    template<typename T>
    static ErrorCode getEntriesFromNamespace(const std::string& namespaceName, std::map<std::string, T>& dataMap);

private:
    /**
     * @brief Helper function to open an NVS handle.
     *
     * @param namespaceName The namespace to open.
     * @param handle A reference to an nvs_handle_t where the opened handle will be stored.
     * @param readWriteMode The access mode (NVS_READONLY or NVS_READWRITE).
     * @return ErrorCode indicating success or failure of opening the handle.
     */
    static ErrorCode openNamespace(const std::string& namespaceName, nvs_handle_t& handle, nvs_open_mode_t readWriteMode);
};

// Template Method Implementations
template<typename T>
ErrorCode NVS::storeValue(const std::string& namespaceName, const std::string& key,
                          const T& value, bool overwrite) {
    nvs_handle_t handle;
    ErrorCode err = openNamespace(namespaceName, handle, NVS_READWRITE);
    if (err != CommonErrorCodes::None) {
        return err;
    }

    // Check if the key already exists (if overwrite is false)
    if (!overwrite) {
        T existingValue;
        err = readValue<T>(namespaceName, key, existingValue); // Read the value to check if it exists
        if (err == CommonErrorCodes::None) {
            nvs_close(handle);
            ESP_LOGW("NVS", "Key '%s' already exists in namespace '%s'", key.c_str(), namespaceName.c_str());
            return CommonErrorCodes::FileExists;
        } else if (err != CommonErrorCodes::FileNotFound && err != CommonErrorCodes::FileIsEmpty) {
            nvs_close(handle);
            return err; // Return other errors from readValue
        }
        // If the key was not found, proceed to write the new value.
    }

    // Store the value based on its type
    esp_err_t esp_err;
    if constexpr (std::is_same_v<T, std::string>) {
        esp_err = nvs_set_str(handle, key.c_str(), value.c_str());
    } else if constexpr (std::is_same_v<T, int8_t>) {
        esp_err = nvs_set_i8(handle, key.c_str(), value);
    } else if constexpr (std::is_same_v<T, int>) {
        // int e 32 bits: i8 truncava 1000 -> 232 em silencio
        esp_err = nvs_set_i32(handle, key.c_str(), (int32_t)value);
    } else if constexpr (std::is_same_v<T, uint8_t>) {
        esp_err = nvs_set_u8(handle, key.c_str(), value);
    } else if constexpr (std::is_same_v<T, unsigned int>) {
        esp_err = nvs_set_u32(handle, key.c_str(), (uint32_t)value);
    } else if constexpr (std::is_same_v<T, int16_t>) {
        esp_err = nvs_set_i16(handle, key.c_str(), value);
    } else if constexpr (std::is_same_v<T, uint16_t>) {
        esp_err = nvs_set_u16(handle, key.c_str(), value);
    } else if constexpr (std::is_same_v<T, int32_t>) {
        esp_err = nvs_set_i32(handle, key.c_str(), value);
    } else if constexpr (std::is_same_v<T, uint32_t>) {
        esp_err = nvs_set_u32(handle, key.c_str(), value);
    } else if constexpr (std::is_same_v<T, int64_t>) {
        esp_err = nvs_set_i64(handle, key.c_str(), value);
    } else if constexpr (std::is_same_v<T, uint64_t>) {
        esp_err = nvs_set_u64(handle, key.c_str(), value);
    } else {
        nvs_close(handle);
        ESP_LOGE("NVS", "Unsupported data type for NVS storage.");
        return CommonErrorCodes::ArgumentError;
    }

    if (esp_err != ESP_OK) {
        nvs_close(handle);
        ESP_LOGE("NVS", "Failed to store value: %s", esp_err_to_name(esp_err));
        return CommonErrorCodes::StorageWriteError;
    }

    esp_err = nvs_commit(handle);
    nvs_close(handle);

    if (esp_err != ESP_OK) {
        ESP_LOGE("NVS", "Failed to commit NVS changes: %s", esp_err_to_name(esp_err));
        return CommonErrorCodes::StorageWriteError;
    }

    return CommonErrorCodes::None;
}

template<typename T>
ErrorCode NVS::readValue(const std::string& namespaceName, const std::string& key, T& value) {
    nvs_handle_t handle;
    ErrorCode err = openNamespace(namespaceName, handle, NVS_READONLY);
    if (err != CommonErrorCodes::None) {
        return err;
    }

    esp_err_t esp_err;
    if constexpr (std::is_same_v<T, std::string>) {
        size_t requiredSize;
        esp_err = nvs_get_str(handle, key.c_str(), nullptr, &requiredSize); // Get required size
        if (esp_err != ESP_OK) {
            nvs_close(handle);
            // So NOT_FOUND e "primeira execucao"; mascarar os demais erros
            // (tipo trocado, chave invalida) como FileNotFound fazia o
            // CredCipher tratar corrupcao como primeira vez e gerar uma
            // chave nova por cima das senhas ja cifradas
            if (esp_err != ESP_ERR_NVS_NOT_FOUND) {
                ESP_LOGE("NVS", "Failed to read string '%s' in '%s': %s", key.c_str(),
                         namespaceName.c_str(), esp_err_to_name(esp_err));
                return CommonErrorCodes::StorageReadError;
            }
            return CommonErrorCodes::FileNotFound;
        }
        // malloc em vez de new[]: sem excecoes, um new que falha aborta o
        // aparelho — aqui a leitura devolve erro limpo (mesmo padrao do
        // HttpClient::setBodySink)
        char* valueBuffer = static_cast<char*>(malloc(requiredSize));
        if (valueBuffer == nullptr) {
            nvs_close(handle);
            ESP_LOGE("NVS", "Out of memory reading key '%s'", key.c_str());
            return CommonErrorCodes::StorageReadError;
        }
        esp_err = nvs_get_str(handle, key.c_str(), valueBuffer, &requiredSize);
        if (esp_err == ESP_OK) {
            // requiredSize volta com o tamanho real (inclui o '\0')
            value.assign(valueBuffer, requiredSize - 1);
        }
        free(valueBuffer);
    } else if constexpr (std::is_same_v<T, int8_t>) {
        esp_err = nvs_get_i8(handle, key.c_str(), &value);
    } else if constexpr (std::is_same_v<T, int>) {
        int32_t v = 0;
        esp_err = nvs_get_i32(handle, key.c_str(), &v);
        if (esp_err == ESP_OK) value = (T)v;
    } else if constexpr (std::is_same_v<T, uint8_t>) {
        esp_err = nvs_get_u8(handle, key.c_str(), &value);
    } else if constexpr (std::is_same_v<T, unsigned int>) {
        uint32_t v = 0;
        esp_err = nvs_get_u32(handle, key.c_str(), &v);
        if (esp_err == ESP_OK) value = (T)v;
    } else if constexpr (std::is_same_v<T, int16_t>) {
        esp_err = nvs_get_i16(handle, key.c_str(), &value);
    } else if constexpr (std::is_same_v<T, uint16_t>) {
        esp_err = nvs_get_u16(handle, key.c_str(), &value);
    } else if constexpr (std::is_same_v<T, int32_t>) {
        esp_err = nvs_get_i32(handle, key.c_str(), &value);
    } else if constexpr (std::is_same_v<T, uint32_t>) {
        esp_err = nvs_get_u32(handle, key.c_str(), &value);
    } else if constexpr (std::is_same_v<T, int64_t>) {
        esp_err = nvs_get_i64(handle, key.c_str(), &value);
    } else if constexpr (std::is_same_v<T, uint64_t>) {
        esp_err = nvs_get_u64(handle, key.c_str(), &value);
    } else {
        nvs_close(handle);
        ESP_LOGE("NVS", "Unsupported data type for NVS storage.");
        return CommonErrorCodes::ArgumentError;
    }

    nvs_close(handle);

    if (esp_err == ESP_ERR_NVS_NOT_FOUND) {
        // Key not found - this is normal if the key hasn't been stored yet
        ESP_LOGD("NVS", "Key '%s' not found in namespace '%s'", key.c_str(), namespaceName.c_str());
        return CommonErrorCodes::FileNotFound;
    } else if (esp_err != ESP_OK) {
        ESP_LOGE("NVS", "Failed to read value: %s", esp_err_to_name(esp_err));
        return CommonErrorCodes::StorageReadError;
    }

    return CommonErrorCodes::None;
}

template<typename T>
ErrorCode NVS::getEntriesFromNamespace(const std::string& namespaceName, std::map<std::string, T>& dataMap) {
    nvs_handle_t handle;
    ErrorCode err = openNamespace(namespaceName, handle, NVS_READONLY);
    if (err != CommonErrorCodes::None) {
        return err;
    }

    dataMap.clear();

    // Iterate through all entries in the namespace
    // Note: We can't use typeid with -fno-rtti, so we iterate all entries and try to read them
    // In ESP-IDF v6.0, we use NVS_TYPE_ANY to iterate all types
    nvs_iterator_t it = nullptr;
    esp_err_t findErr = nvs_entry_find(NVSConstants::PartitionName, namespaceName.c_str(),
                                       NVS_TYPE_ANY, &it);
    if (findErr != ESP_OK && findErr != ESP_ERR_NVS_NOT_FOUND) {
        // NO_MEM/chave invalida virando "namespace vazio" escondia a falha
        nvs_close(handle);
        ESP_LOGE("NVS", "Failed to enumerate namespace '%s': %s",
                 namespaceName.c_str(), esp_err_to_name(findErr));
        return CommonErrorCodes::StorageReadError;
    }
    
    while (it != nullptr) {
        nvs_entry_info_t info;
        nvs_entry_info(it, &info);
        T value;
        ErrorCode readErr = readValue(namespaceName, std::string(info.key), value);
        if (readErr == CommonErrorCodes::None) {
            // Successfully read the value, add to map
        dataMap[info.key] = value;
        } else {
            // Skip entries that don't match the type T
            ESP_LOGD("NVS", "Skipping key '%s' (type mismatch or read error)", info.key);
        }
        nvs_entry_next(&it);
    }

    if (it != nullptr) {
    nvs_release_iterator(it);
    }
    nvs_close(handle);

    if (dataMap.empty()) {
        return CommonErrorCodes::FileIsEmpty;
    }

    return CommonErrorCodes::None;
}

// Private helper method - implementation in NVS.cpp

#endif // NVS_H