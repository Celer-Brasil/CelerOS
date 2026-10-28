#include "CredCipher.h"
#include "NVS.h"
#include "CommonErrorCodes.h"
#include "esp_log.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "psa/crypto.h"
#include <cstdint>
#include <cstring>

namespace {

constexpr const char* TAG = "CredCipher";

// Mesma chave/namespace do NetworkCredentialStore (a cifra e parte do store,
// separada so para nao misturar PSA com a mecanica de NVS).
constexpr const char* NS = "net_creds";
constexpr const char* KEY_HEX = "k";

constexpr size_t KEY_LEN = 16;   // AES-128
constexpr size_t NONCE_LEN = 12; // CCM padrao
constexpr size_t TAG_LEN = 8;    // tag encurtada (sobram 64B de senha: 12+64+8=84 -> 168 hex)
constexpr psa_algorithm_t kCcm8 = PSA_ALG_AEAD_WITH_SHORTENED_TAG(PSA_ALG_CCM, TAG_LEN);

// Chave em RAM imutavel apos init() + o id da chave volatil no PSA. As
// operacoes de cifra sao thread-safe a partir dai (PSA serializa por dentro;
// ninguem escreve nestes statics depois do boot).
uint8_t s_key[KEY_LEN];
psa_key_id_t s_keyId = 0;
bool s_ready = false;

bool psaReady() {
    // Re-init em TF-PSA (mbedTLS 4) e idempotente: PSA_SUCCESS nas chamadas
    // seguintes (NetKeys faz igual)
    return psa_crypto_init() == PSA_SUCCESS;
}

bool hexEncode(const uint8_t* in, size_t n, char* out, size_t cap) {
    if (cap < n * 2 + 1) return false;
    static const char* digits = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) {
        out[i * 2] = digits[in[i] >> 4];
        out[i * 2 + 1] = digits[in[i] & 0xF];
    }
    out[n * 2] = '\0';
    return true;
}

int hexVal(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

bool hexDecode(const char* in, uint8_t* out, size_t outCap, size_t* outLen) {
    size_t n = strlen(in);
    if (n == 0 || (n & 1) != 0 || n / 2 > outCap) return false;
    for (size_t i = 0; i < n; i += 2) {
        int hi = hexVal(in[i]), lo = hexVal(in[i + 1]);
        if (hi < 0 || lo < 0) return false;
        out[i / 2] = (uint8_t)((hi << 4) | lo);
    }
    *outLen = n / 2;
    return true;
}

}  // namespace

namespace CredCipher {

bool init() {
    if (s_ready) return true;
    if (!psaReady()) {
        ESP_LOGE(TAG, "psa_crypto_init falhou");
        return false;
    }

    // Carrega a chave existente ou gera na primeira inicializacao.
    std::string hex;
    ErrorCode err = NVS::readValue<std::string>(NS, KEY_HEX, hex);
    if (err == CommonErrorCodes::None) {
        size_t n = 0;
        if (!hexDecode(hex.c_str(), s_key, sizeof(s_key), &n) || n != KEY_LEN) {
            ESP_LOGE(TAG, "chave corrompida no NVS (senha antigas viram indecifráveis)");
            return false;
        }
    } else if (err != CommonErrorCodes::FileNotFound && err != CommonErrorCodes::FileIsEmpty) {
        // Erro de leitura (corrupcao, tipo trocado, NVS ilegivel) NAO e
        // "primeira execucao": gerar chave nova por cima tornaria todas as
        // senhas ja cifradas indecifraveis. Falha fechado, como o store pede.
        ESP_LOGE(TAG, "falha ao ler a chave do NVS (%s); nao gero outra", err.description());
        return false;
    } else {
        esp_fill_random(s_key, sizeof(s_key));
        char enc[KEY_LEN * 2 + 1];
        if (!hexEncode(s_key, sizeof(s_key), enc, sizeof(enc))) return false;
        err = NVS::storeValue<std::string>(NS, KEY_HEX, enc, true);
        if (err != CommonErrorCodes::None) {
            ESP_LOGE(TAG, "falhou ao persistir a chave: %s", err.description());
            return false;
        }
    }

    psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_type(&a, PSA_KEY_TYPE_AES);
    psa_set_key_bits(&a, 128);
    psa_set_key_usage_flags(&a, PSA_KEY_USAGE_ENCRYPT | PSA_KEY_USAGE_DECRYPT);
    psa_set_key_algorithm(&a, kCcm8);
    psa_key_id_t id = 0;
    if (psa_import_key(&a, s_key, KEY_LEN, &id) != PSA_SUCCESS || id == 0) {
        ESP_LOGE(TAG, "psa_import_key falhou");
        return false;
    }
    s_keyId = id;
    s_ready = true;
    return true;
}

bool encrypt(const char* plain, char* hexOut, size_t hexCap) {
    if (!s_ready || plain == nullptr) return false;
    const size_t len = strlen(plain);
    if (len == 0) return false;

    uint8_t nonce[NONCE_LEN];
    esp_fill_random(nonce, sizeof(nonce));

    uint8_t out[64 + TAG_LEN];
    if (len > 64) return false;  // KnownNetwork::password[65]
    size_t ol = 0;
    if (psa_aead_encrypt(s_keyId, kCcm8, nonce, NONCE_LEN, nullptr, 0,
                         (const uint8_t*)plain, len, out, sizeof(out), &ol) != PSA_SUCCESS) {
        ESP_LOGE(TAG, "psa_aead_encrypt falhou");
        return false;
    }

    uint8_t blob[NONCE_LEN + sizeof(out)];
    memcpy(blob, nonce, NONCE_LEN);
    memcpy(blob + NONCE_LEN, out, ol);
    return hexEncode(blob, NONCE_LEN + ol, hexOut, hexCap);
}

bool decrypt(const char* hex, char* out, size_t outCap) {
    if (!s_ready || hex == nullptr) return false;
    uint8_t blob[NONCE_LEN + 64 + TAG_LEN];
    size_t n = 0;
    if (!hexDecode(hex, blob, sizeof(blob), &n)) return false;
    if (n <= NONCE_LEN + TAG_LEN) return false;
    const size_t ctLen = n - NONCE_LEN;

    size_t ol = 0;
    if (psa_aead_decrypt(s_keyId, kCcm8, blob, NONCE_LEN, nullptr, 0,
                         blob + NONCE_LEN, ctLen, (uint8_t*)out, outCap, &ol) != PSA_SUCCESS) {
        return false;  // tag errada / chave trocada: tratado como senha vazia
    }
    if (ol >= outCap) return false;
    out[ol] = '\0';
    return true;
}

}  // namespace CredCipher
