#include "PinStore.h"
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <unistd.h>

#include "../FileSystem/FileSystem.h"
#include "psa/crypto.h"
#include "esp_random.h"
#include "esp_rom_md5.h"
#include "esp_log.h"
#include "nvs.h"

static const char* PS_TAG = "celer.pin";
static const char* PIN_FILE = "/local/settings_pin2.bin";
static const char* PIN_LEGACY = "/local/settings_pin.txt";
static const char* NVS_NS = "celer";
static const char* NVS_FLAG = "pin_set";

// CP2 = Celer PIN v2: magic + salt + sha256(salt||pin)
struct PinRecord {
    char magic[3];
    uint8_t salt[16];
    uint8_t hash[32];
};

static bool validPin(const char* pin) {
    if (pin == nullptr) return false;
    size_t n = strlen(pin);
    if (n < 4 || n > 6) return false;
    for (size_t i = 0; i < n; i++) {
        if (pin[i] < '0' || pin[i] > '9') return false;
    }
    return true;
}

static bool computeHash(const uint8_t salt[16], const char* pin, uint8_t out[32]) {
    uint8_t buf[16 + 6];
    memcpy(buf, salt, 16);
    size_t n = strlen(pin);
    if (n > 6) n = 6;
    memcpy(buf + 16, pin, n);
    size_t olen = 0;
    // Falha do PSA (OOM no primeiro uso) deixava out[32] sem escrita e o
    // PIN correto nunca mais autenticava (hash de lixo persistido). Sem
    // sucesso e 32 bytes, nao ha hash valido.
    if (psa_crypto_init() != PSA_SUCCESS) return false;
    if (psa_hash_compute(PSA_ALG_SHA_256, buf, 16 + n, out, 32, &olen) != PSA_SUCCESS) return false;
    return olen == 32;
}

static bool writeRecord(const PinRecord& rec) {
    // mesmo contrato atomico do FileSystem::writeTextFile: tmp + rename
    std::string tmp = std::string(PIN_FILE) + ".tmp";
    FILE* f = fopen(tmp.c_str(), "wb");
    if (f == nullptr) return false;
    bool ok = fwrite(&rec, 1, sizeof(rec), f) == sizeof(rec);
    ok = (fclose(f) == 0) && ok;
    if (!ok || rename(tmp.c_str(), PIN_FILE) != 0) {
        unlink(tmp.c_str());
        return false;
    }
    return true;
}

static void setNvsFlag(bool set) {
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
    if (set) {
        uint8_t one = 1;
        nvs_set_u8(h, NVS_FLAG, one);
    } else {
        nvs_erase_key(h, NVS_FLAG);
    }
    nvs_commit(h);
    nvs_close(h);
}

static bool nvsFlagSet() {
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) return false;
    uint8_t v = 0;
    bool set = nvs_get_u8(h, NVS_FLAG, &v) == ESP_OK && v == 1;
    nvs_close(h);
    return set;
}

bool PinStore::set(const char* pin) {
    if (!validPin(pin)) return false;

    PinRecord rec;
    memcpy(rec.magic, "CP2", 3);
    for (int i = 0; i < 16; i++) rec.salt[i] = (uint8_t)(esp_random() & 0xFF);
    if (!computeHash(rec.salt, pin, rec.hash)) {
        ESP_LOGE(PS_TAG, "falha ao calcular o hash do PIN (PSA)");
        return false;
    }

    if (!writeRecord(rec)) {
        ESP_LOGE(PS_TAG, "falha ao gravar %s", PIN_FILE);
        return false;
    }
    FileSystem::deleteFile(PIN_LEGACY);  // dormente desde a migracao
    setNvsFlag(true);
    return true;
}

bool PinStore::verify(const char* pin) {
    if (pin == nullptr) return false;

    FILE* f = fopen(PIN_FILE, "rb");
    if (f != nullptr) {
        PinRecord rec;
        bool ok = fread(&rec, 1, sizeof(rec), f) == sizeof(rec) &&
                  memcmp(rec.magic, "CP2", 3) == 0;
        fclose(f);
        if (!ok) return false;
        uint8_t h[32];
        if (!computeHash(rec.salt, pin, h)) return false;
        return memcmp(h, rec.hash, 32) == 0;
    }

    // Legado: settings_pin.txt com MD5 hex (32 chars). Sucesso = upgrade.
    std::string legacy = FileSystem::readTextFile(PIN_LEGACY);
    if (legacy.length() < 32) return false;
    legacy = legacy.substr(0, 32);

    md5_context_t c;  // esp_rom_md5: mesmo hash do System.md5 do JS legado
    uint8_t digest[16];
    esp_rom_md5_init(&c);
    esp_rom_md5_update(&c, pin, (uint32_t)strlen(pin));
    esp_rom_md5_final(digest, &c);
    char hex[33];
    for (int i = 0; i < 16; i++) sprintf(hex + i * 2, "%02x", digest[i]);
    hex[32] = 0;

    if (strcmp(hex, legacy.c_str()) != 0) return false;
    if (set(pin)) {
        ESP_LOGI(PS_TAG, "PIN legado migrado para %s", PIN_FILE);
    }
    return true;
}

bool PinStore::clear() {
    bool ok = FileSystem::deleteFile(PIN_FILE);
    FileSystem::deleteFile(PIN_LEGACY);
    setNvsFlag(false);
    return ok;
}

int PinStore::state() {
    bool file = FileSystem::exists(PIN_FILE) || FileSystem::exists(PIN_LEGACY);
    if (file) return 1;
    return nvsFlagSet() ? 2 : 0;
}
