#include "NetKeys.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <string>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "psa/crypto.h"

#include "../Utils/CelerSettings.h"

// Chaves e cifra da CelerNet v3 (ver NetKeys.h).

namespace NetKeys {
namespace {

const char* TAG = "celer.keys";

constexpr psa_algorithm_t kCcm4 = PSA_ALG_AEAD_WITH_SHORTENED_TAG(PSA_ALG_CCM, 4);
constexpr uint32_t K_PBKDF2_ITER = 4096;
constexpr uint32_t K_SEQ_BLOCK = 4096;  // reserva no NVS (gravada na metade)

Net s_nets[NETS_MAX];
bool s_inited = false;
bool s_openSecondary = false;

// seqs proprios e a reserva gravada no NVS
portMUX_TYPE s_seqMux = portMUX_INITIALIZER_UNLOCKED;
uint32_t s_seqMesh = 0, s_resMesh = 0;
uint32_t s_seqNow = 0, s_resNow = 0;

std::string hex(const uint8_t* b, size_t n) {
    static const char* d = "0123456789abcdef";
    std::string s;
    for (size_t i = 0; i < n; i++) {
        s += d[b[i] >> 4];
        s += d[b[i] & 15];
    }
    return s;
}

bool unhex(const std::string& s, uint8_t* out, size_t n) {
    if (s.size() != n * 2) return false;
    auto v = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    for (size_t i = 0; i < n; i++) {
        const int a = v(s[2 * i]), b = v(s[2 * i + 1]);
        if (a < 0 || b < 0) return false;
        out[i] = (uint8_t)((a << 4) | b);
    }
    return true;
}

bool hkdf(const uint8_t* ikm, size_t ikmLen, const uint8_t* salt, size_t saltLen, const uint8_t* info,
          size_t infoLen, uint8_t* out, size_t outLen) {
    psa_key_derivation_operation_t op = PSA_KEY_DERIVATION_OPERATION_INIT;
    bool ok = psa_key_derivation_setup(&op, PSA_ALG_HKDF(PSA_ALG_SHA_256)) == PSA_SUCCESS &&
              psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_SALT, salt, saltLen) == PSA_SUCCESS &&
              psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_SECRET, ikm, ikmLen) == PSA_SUCCESS &&
              psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_INFO, info, infoLen) == PSA_SUCCESS &&
              psa_key_derivation_output_bytes(&op, out, outLen) == PSA_SUCCESS;
    psa_key_derivation_abort(&op);
    return ok;
}

bool pbkdf2(const char* pwd, const uint8_t* salt, size_t saltLen, uint32_t iter, uint8_t* out, size_t outLen) {
    psa_key_derivation_operation_t op = PSA_KEY_DERIVATION_OPERATION_INIT;
    bool ok = psa_key_derivation_setup(&op, PSA_ALG_PBKDF2_HMAC(PSA_ALG_SHA_256)) == PSA_SUCCESS &&
              psa_key_derivation_input_integer(&op, PSA_KEY_DERIVATION_INPUT_COST, iter) == PSA_SUCCESS &&
              psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_SALT, salt, saltLen) == PSA_SUCCESS &&
              psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_PASSWORD, (const uint8_t*)pwd,
                                             strlen(pwd)) == PSA_SUCCESS &&
              psa_key_derivation_output_bytes(&op, out, outLen) == PSA_SUCCESS;
    psa_key_derivation_abort(&op);
    return ok;
}

bool importAes(const uint8_t key[KEY_LEN], psa_algorithm_t alg, psa_key_usage_t usage, uint32_t* id) {
    psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_type(&a, PSA_KEY_TYPE_AES);
    psa_set_key_bits(&a, 128);
    psa_set_key_usage_flags(&a, usage);
    psa_set_key_algorithm(&a, alg);
    psa_key_id_t k = 0;
    const bool ok = psa_import_key(&a, key, KEY_LEN, &k) == PSA_SUCCESS;
    *id = ok ? (uint32_t)k : 0;
    return ok;
}

void release(Net& n) {
    if (n.encId) psa_destroy_key((psa_key_id_t)n.encId);
    if (n.privId) psa_destroy_key((psa_key_id_t)n.privId);
    memset(&n, 0, sizeof(n));
}

// Monta a rede a partir da netKey (deriva as subchaves e importa no PSA)
bool build(Net& n, const char* name, const uint8_t netKey[KEY_LEN], bool open) {
    static const uint8_t kSalt[] = {'c', 'e', 'l', 'e', 'r', 'n', 'e', 't', '-', 'v', '3'};
    uint8_t enc[KEY_LEN], priv[KEY_LEN], admin[KEY_LEN], nid = 0;
    if (!hkdf(netKey, KEY_LEN, kSalt, sizeof(kSalt), (const uint8_t*)"enc", 3, enc, KEY_LEN) ||
        !hkdf(netKey, KEY_LEN, kSalt, sizeof(kSalt), (const uint8_t*)"priv", 4, priv, KEY_LEN) ||
        !hkdf(netKey, KEY_LEN, kSalt, sizeof(kSalt), (const uint8_t*)"admin", 5, admin, KEY_LEN) ||
        !hkdf(netKey, KEY_LEN, kSalt, sizeof(kSalt), (const uint8_t*)"nid", 3, &nid, 1)) {
        return false;
    }
    Net t;
    memset(&t, 0, sizeof(t));
    if (!importAes(enc, kCcm4, PSA_KEY_USAGE_ENCRYPT | PSA_KEY_USAGE_DECRYPT, &t.encId) ||
        !importAes(priv, PSA_ALG_ECB_NO_PADDING, PSA_KEY_USAGE_ENCRYPT, &t.privId)) {
        release(t);
        return false;
    }
    t.used = true;
    t.open = open;
    snprintf(t.name, sizeof(t.name), "%s", name);
    t.nid = nid;
    t.iv = 0;
    memcpy(t.netKey, netKey, KEY_LEN);
    memcpy(t.adminKey, admin, KEY_LEN);
    release(n);
    n = t;
    return true;
}

// chave publica da rede aberta: SHA-256 de um rotulo fixo (sem PBKDF2: o
// boot nao paga 0,3 s por uma chave que todo mundo conhece)
bool openKey(uint8_t out[KEY_LEN]) {
    static const char kLabel[] = "celernet:celer:open-v3";
    uint8_t h[32];
    size_t hl = 0;
    if (psa_hash_compute(PSA_ALG_SHA_256, (const uint8_t*)kLabel, sizeof(kLabel) - 1, h, sizeof(h), &hl) !=
        PSA_SUCCESS) {
        return false;
    }
    memcpy(out, h, KEY_LEN);
    return true;
}

bool buildOpen(Net& n) {
    uint8_t k[KEY_LEN];
    return openKey(k) && build(n, OPEN_NAME, k, true);
}

// slot 0 = primaria; slot 1 = aberta como secundaria (se pedida e a
// primaria for privada)
void layout() {
    if (!s_nets[0].used || s_nets[0].open || !s_openSecondary) {
        release(s_nets[1]);
        return;
    }
    if (!s_nets[1].used) buildOpen(s_nets[1]);
}

bool sealRaw(uint32_t id, const uint8_t nonce[13], const uint8_t* aad, size_t aadLen, const uint8_t* in,
             size_t len, uint8_t* out) {
    size_t ol = 0;
    return psa_aead_encrypt((psa_key_id_t)id, kCcm4, nonce, 13, aad, aadLen, in, len, out, len + 4, &ol) ==
               PSA_SUCCESS &&
           ol == len + 4;
}

bool openRaw(uint32_t id, const uint8_t nonce[13], const uint8_t* aad, size_t aadLen, const uint8_t* in,
             size_t len, uint8_t* out) {
    size_t ol = 0;
    return psa_aead_decrypt((psa_key_id_t)id, kCcm4, nonce, 13, aad, aadLen, in, len + 4, out, len, &ol) ==
               PSA_SUCCESS &&
           ol == len;
}

// adaptadores para o netframe::Cipher (ctx = Net*)
bool cSeal(void* ctx, const uint8_t n[13], const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
           uint8_t* out) {
    return sealRaw(((const Net*)ctx)->encId, n, aad, aadLen, in, len, out);
}
bool cOpen(void* ctx, const uint8_t n[13], const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
           uint8_t* out) {
    return openRaw(((const Net*)ctx)->encId, n, aad, aadLen, in, len, out);
}
void cEcb(void* ctx, const uint8_t in[16], uint8_t out[16]) {
    size_t ol = 0;
    if (psa_cipher_encrypt((psa_key_id_t)((const Net*)ctx)->privId, PSA_ALG_ECB_NO_PADDING, in, 16, out, 16, &ol) !=
        PSA_SUCCESS) {
        memset(out, 0, 16);
    }
}

uint32_t loadU32(const char* key) {
    const std::string v = CelerSettings::get(key, "");
    return v.empty() ? 0 : (uint32_t)strtoul(v.c_str(), nullptr, 10);
}

void saveU32(const char* key, uint32_t v) {
    char b[16];
    snprintf(b, sizeof(b), "%u", (unsigned)v);
    CelerSettings::set(key, b);
}

}  // namespace

bool init() {
    if (s_inited) return true;
    if (psa_crypto_init() != PSA_SUCCESS) return false;
    // seqs: comecam na reserva gravada (tudo abaixo dela pode ter sido usado
    // antes do reboot) e ja reservam o bloco seguinte
    s_seqMesh = loadU32("cn3_seqm");
    s_seqNow = loadU32("cn3_seqn");
    s_resMesh = s_seqMesh + K_SEQ_BLOCK;
    s_resNow = s_seqNow + K_SEQ_BLOCK;
    saveU32("cn3_seqm", s_resMesh);
    saveU32("cn3_seqn", s_resNow);
    // matilha provisionada? (nome + netKey + adminKey no NVS)
    const std::string name = CelerSettings::get("cn3_net", "");
    uint8_t key[KEY_LEN];
    bool ok = false;
    if (!name.empty() && unhex(CelerSettings::get("cn3_key", ""), key, KEY_LEN)) {
        ok = build(s_nets[0], name.c_str(), key, false);
        if (!ok) ESP_LOGW(TAG, "matilha \"%s\" no NVS nao montou: volto para a aberta", name.c_str());
    }
    if (!ok) ok = buildOpen(s_nets[0]);
    layout();
    s_inited = ok;
    if (ok) {
        ESP_LOGI(TAG, "rede \"%s\" (%s, nid %02X)", s_nets[0].name, s_nets[0].open ? "aberta" : "matilha",
                 s_nets[0].nid);
    }
    return ok;
}

bool joinWithKeys(const char* name, const uint8_t netKey[KEY_LEN], const uint8_t adminKey[KEY_LEN]) {
    if (!init()) return false;
    (void)adminKey;  // derivada da netKey (mesmo HKDF): o parametro confere
    Net t;
    memset(&t, 0, sizeof(t));
    if (!build(t, name, netKey, false)) return false;
    if (adminKey != nullptr && memcmp(t.adminKey, adminKey, KEY_LEN) != 0) {
        release(t);
        return false;  // chave de admin nao bate com a da rede: pacote corrompido
    }
    release(s_nets[0]);
    s_nets[0] = t;
    CelerSettings::set("cn3_net", name);
    CelerSettings::set("cn3_key", hex(netKey, KEY_LEN).c_str());
    layout();
    ESP_LOGI(TAG, "entrou na matilha \"%s\" (nid %02X)", name, s_nets[0].nid);
    return true;
}

bool join(const char* name, const char* password) {
    if (!init()) return false;
    if (name == nullptr || name[0] == '\0' || password == nullptr || password[0] == '\0' ||
        strcmp(name, OPEN_NAME) == 0) {
        leave();
        return true;
    }
    if (strlen(name) >= sizeof(Net::name)) return false;
    std::string salt = std::string("celernet:") + name;
    uint8_t key[KEY_LEN];
    if (!pbkdf2(password, (const uint8_t*)salt.data(), salt.size(), K_PBKDF2_ITER, key, KEY_LEN)) return false;
    return joinWithKeys(name, key, nullptr);
}

void leave() {
    if (!init()) return;
    CelerSettings::set("cn3_net", "");
    CelerSettings::set("cn3_key", "");
    buildOpen(s_nets[0]);
    layout();
    ESP_LOGI(TAG, "voltou para a rede aberta");
}

void setOpenSecondary(bool on) {
    if (!init()) return;
    s_openSecondary = on;
    layout();
}

bool provisioned() {
    return s_inited && s_nets[0].used && !s_nets[0].open;
}

const Net* primary() {
    return s_inited && s_nets[0].used ? &s_nets[0] : nullptr;
}

const Net* net(int i) {
    return s_inited && i >= 0 && i < NETS_MAX && s_nets[i].used ? &s_nets[i] : nullptr;
}

netframe::Cipher cipherOf(const Net* n) {
    netframe::Cipher c;
    c.ctx = (void*)n;
    c.nid = n->nid;
    c.iv = n->iv;
    c.seal = cSeal;
    c.open = cOpen;
    c.ecb = cEcb;
    return c;
}

int ciphers(netframe::Cipher* out, int max) {
    int k = 0;
    for (int i = 0; i < NETS_MAX && k < max; i++) {
        if (s_inited && s_nets[i].used) out[k++] = cipherOf(&s_nets[i]);
    }
    return k;
}

bool seal(const Net* n, const uint8_t nonce[13], const uint8_t* aad, size_t aadLen, const uint8_t* in,
          size_t len, uint8_t* out) {
    return n != nullptr && sealRaw(n->encId, nonce, aad, aadLen, in, len, out);
}

bool open(const Net* n, const uint8_t nonce[13], const uint8_t* aad, size_t aadLen, const uint8_t* in,
          size_t len, uint8_t* out) {
    return n != nullptr && openRaw(n->encId, nonce, aad, aadLen, in, len, out);
}

const Net* byNid(uint8_t nid) {
    for (int i = 0; i < NETS_MAX; i++) {
        if (s_inited && s_nets[i].used && s_nets[i].nid == nid) return &s_nets[i];
    }
    return nullptr;
}

uint32_t reserveSeqMesh(uint32_t n) {
    if (n == 0) n = 1;
    portENTER_CRITICAL(&s_seqMux);
    uint32_t v = s_seqMesh + 1;
    s_seqMesh += n;
    if (s_seqMesh > netframe::SEQ_MAX) {  // limite da v3.0 (ver NetFrame.h)
        s_seqMesh = netframe::SEQ_MAX;
        v = netframe::SEQ_MAX - n + 1;
    }
    portEXIT_CRITICAL(&s_seqMux);
    return v;
}

uint32_t nextSeqMesh() {
    return reserveSeqMesh(1);
}

uint32_t nextSeqNow() {
    portENTER_CRITICAL(&s_seqMux);
    const uint32_t v = ++s_seqNow;
    portEXIT_CRITICAL(&s_seqMux);
    return v;
}

void persistTick() {
    // grava a reserva seguinte quando a metade do bloco foi usada: a seq
    // nunca alcanca a reserva gravada antes do proximo tick
    if (!s_inited) return;
    if (s_seqMesh + K_SEQ_BLOCK / 2 >= s_resMesh) {
        s_resMesh = s_seqMesh + K_SEQ_BLOCK;
        saveU32("cn3_seqm", s_resMesh);
    }
    if (s_seqNow + K_SEQ_BLOCK / 2 >= s_resNow) {
        s_resNow = s_seqNow + K_SEQ_BLOCK;
        saveU32("cn3_seqn", s_resNow);
    }
}

bool selftest(PrintFn pr, void* ctx) {
    psa_crypto_init();
    bool all = true;
    auto report = [&](const char* name, bool ok) {
        pr(ctx, "  %-28s %s\r\n", name, ok ? "ok" : "FALHOU");
        all = all && ok;
    };
    // RFC 3610, Packet Vector #1 (CCM, MIC de 8 bytes)
    {
        const uint8_t key[16] = {0xC0, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7,
                                 0xC8, 0xC9, 0xCA, 0xCB, 0xCC, 0xCD, 0xCE, 0xCF};
        const uint8_t nonce[13] = {0x00, 0x00, 0x00, 0x03, 0x02, 0x01, 0x00, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5};
        const uint8_t aad[8] = {0, 1, 2, 3, 4, 5, 6, 7};
        uint8_t pt[23];
        for (int i = 0; i < 23; i++) pt[i] = (uint8_t)(8 + i);
        const uint8_t want[31] = {0x58, 0x8C, 0x97, 0x9A, 0x61, 0xC6, 0x63, 0xD2, 0xF0, 0x66, 0xD0,
                                  0xC2, 0xC0, 0xF9, 0x89, 0x80, 0x6D, 0x5F, 0x6B, 0x61, 0xDA, 0xC3,
                                  0x84, 0x17, 0xE8, 0xD1, 0x2C, 0xFD, 0xF9, 0x26, 0xE0};
        const psa_algorithm_t a8 = PSA_ALG_AEAD_WITH_SHORTENED_TAG(PSA_ALG_CCM, 8);
        uint32_t id = 0;
        uint8_t out[31];
        size_t ol = 0;
        bool ok = importAes(key, a8, PSA_KEY_USAGE_ENCRYPT, &id) &&
                  psa_aead_encrypt((psa_key_id_t)id, a8, nonce, 13, aad, 8, pt, 23, out, sizeof(out), &ol) ==
                      PSA_SUCCESS &&
                  ol == 31 && memcmp(out, want, 31) == 0;
        if (id) psa_destroy_key((psa_key_id_t)id);
        report("AES-CCM (RFC 3610 #1)", ok);
    }
    // RFC 5869, Test Case 1 (HKDF-SHA256)
    {
        uint8_t ikm[22];
        memset(ikm, 0x0b, sizeof(ikm));
        const uint8_t salt[13] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12};
        const uint8_t info[10] = {0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9};
        const uint8_t want[42] = {0x3c, 0xb2, 0x5f, 0x25, 0xfa, 0xac, 0xd5, 0x7a, 0x90, 0x43, 0x4f, 0x64, 0xd0, 0x36,
                                  0x2f, 0x2a, 0x2d, 0x2d, 0x0a, 0x90, 0xcf, 0x1a, 0x5a, 0x4c, 0x5d, 0xb0, 0x2d, 0x56,
                                  0xec, 0xc4, 0xc5, 0xbf, 0x34, 0x00, 0x72, 0x08, 0xd5, 0xb8, 0x87, 0x18, 0x58, 0x65};
        uint8_t out[42];
        report("HKDF-SHA256 (RFC 5869 #1)",
               hkdf(ikm, sizeof(ikm), salt, sizeof(salt), info, sizeof(info), out, sizeof(out)) &&
                   memcmp(out, want, 42) == 0);
    }
    // PBKDF2-HMAC-SHA256("password", "salt", 1)
    {
        const uint8_t want[32] = {0x12, 0x0f, 0xb6, 0xcf, 0xfc, 0xf8, 0xb3, 0x2c, 0x43, 0xe7, 0x22,
                                  0x52, 0x56, 0xc4, 0xf8, 0x37, 0xa8, 0x65, 0x48, 0xc9, 0x2c, 0xcc,
                                  0x35, 0x48, 0x08, 0x05, 0x98, 0x7c, 0xb7, 0x0b, 0xe1, 0x7b};
        uint8_t out[32];
        report("PBKDF2-HMAC-SHA256 (c=1)", pbkdf2("password", (const uint8_t*)"salt", 4, 1, out, 32) &&
                                               memcmp(out, want, 32) == 0);
    }
    // ida e volta do quadro v3 com a rede primaria (PSA de verdade)
    {
        const Net* n = primary();
        bool ok = n != nullptr;
        if (ok) {
            netframe::Cipher c = cipherOf(n);
            netframe::Frame f;
            f.type = netframe::TYPE_DATA;
            f.src = 0x1234;
            f.seq = 77;
            const uint8_t d[5] = {'o', 'l', 'a', '!', 0};
            f.data = d;
            f.dlen = 5;
            uint8_t buf[netframe::ADV_MAX], plain[netframe::DATA_MAX];
            const size_t len = netframe::encode(f, c, buf, sizeof(buf));
            netframe::Frame g;
            int idx = -1;
            ok = len > 0 && netframe::decode(buf, len, &c, 1, &g, plain, &idx) && g.seq == 77 &&
                 memcmp(plain, d, 5) == 0;
            if (ok) {
                buf[len - 1] ^= 1;  // MIC adulterado: tem que cair
                ok = !netframe::decode(buf, len, &c, 1, &g, plain, &idx);
            }
        }
        report("quadro v3 (rede primaria)", ok);
    }
    // custo: CCM de um quadro ESP-NOW cheio (1453 B) e de um quadro da malha
    {
        const Net* n = primary();
        uint8_t* in = (uint8_t*)malloc(1460);
        uint8_t* out = (uint8_t*)malloc(1470);
        if (n != nullptr && in != nullptr && out != nullptr) {
            memset(in, 0x5A, 1460);
            uint8_t nonce[13] = {1};
            int64_t t0 = esp_timer_get_time();
            for (int i = 0; i < 20; i++) sealRaw(n->encId, nonce, in, 8, in, 1453, out);
            const int64_t big = (esp_timer_get_time() - t0) / 20;
            t0 = esp_timer_get_time();
            for (int i = 0; i < 100; i++) sealRaw(n->encId, nonce, in, 2, in, 16, out);
            const int64_t small = (esp_timer_get_time() - t0) / 100;
            pr(ctx, "  custo CCM: 1453 B %d us (%d KB/s)  16 B %d us\r\n", (int)big,
               big > 0 ? (int)(1453 * 1000 / big) : 0, (int)small);
        }
        free(in);
        free(out);
    }
    return all;
}

}  // namespace NetKeys
