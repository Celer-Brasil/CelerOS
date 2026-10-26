#include "Settings.h"

#include "CelerSettings.h"

#include <cstdio>

#include "esp_timer.h"

namespace Settings {

namespace {

// Fila do debounce: chave curta (as do manifesto tem <= 14) e valor decimal.
struct Pending {
    char key[16];
    char val[16];
    uint32_t dueMs;
    bool used;
};

constexpr size_t kPendingSlots = 8;
Pending s_pending[kPendingSlots];

uint32_t nowMs() { return (uint32_t)(esp_timer_get_time() / 1000); }

void writePending(Pending& p) {
    CelerSettings::set(p.key, p.val);
    p.used = false;
}

int defaultIntOf(const KeyDef& d) {
    int v = 0;
    if (!parseInt(d.def, &v)) v = 0;
    return clampInt(d, v);
}

}  // namespace

bool getBool(const char* key, bool def) {
    const char* d = def ? "1" : "";
    const std::string s = CelerSettings::get(key, d);
    bool v = def;
    return parseBool(s.c_str(), &v) ? v : def;
}

bool getBool(const char* key) {
    const KeyDef* d = lookup(key);
    const bool def = (d != nullptr && d->type == Type::Bool) ? (d->def[0] == '1') : false;
    return getBool(key, def);
}

int getInt(const char* key, int def) {
    const KeyDef* d = lookup(key);
    int v = def;
    const std::string s = CelerSettings::get(key, "");
    if (!s.empty() && parseInt(s.c_str(), &v)) {
        return (d != nullptr) ? clampInt(*d, v) : v;
    }
    return (d != nullptr) ? clampInt(*d, def) : def;
}

int getInt(const char* key) {
    const KeyDef* d = lookup(key);
    return getInt(key, (d != nullptr) ? defaultIntOf(*d) : 0);
}

std::string getStr(const char* key, const char* def) {
    return CelerSettings::get(key, def);
}

bool setBool(const char* key, bool value) {
    if (key == nullptr) return false;
    const KeyDef* d = lookup(key);
    if (d != nullptr && d->type != Type::Bool) return false;
    // false apaga a chave (convencao do WebManager/Notifications); todo
    // leitor do firmware compara com "1".
    return CelerSettings::set(key, value ? "1" : "");
}

bool setInt(const char* key, int value) {
    if (key == nullptr) return false;
    const KeyDef* d = lookup(key);
    if (d != nullptr) {
        if (d->type != Type::Int) return false;
        value = clampInt(*d, value);
    }
    char buf[16];
    const int n = snprintf(buf, sizeof(buf), "%d", value);
    if (n <= 0 || (size_t)n >= sizeof(buf)) return false;
    return CelerSettings::set(key, buf);
}

bool setStr(const char* key, const char* value) {
    if (key == nullptr) return false;
    return CelerSettings::set(key, value);
}

bool setIntDebounced(const char* key, int value, uint32_t delayMs) {
    if (key == nullptr) return false;
    const KeyDef* d = lookup(key);
    if (d != nullptr) {
        if (d->type != Type::Int) return false;
        value = clampInt(*d, value);
    }
    char val[16];
    const int n = snprintf(val, sizeof(val), "%d", value);
    if (n <= 0 || (size_t)n >= sizeof(val)) return false;

    // Mesma chave pendente: so atualiza valor e prazo (ultimo vence).
    Pending* free_slot = nullptr;
    for (auto& p : s_pending) {
        if (p.used && std::strcmp(p.key, key) == 0) {
            std::strncpy(p.val, val, sizeof(p.val) - 1);
            p.val[sizeof(p.val) - 1] = '\0';
            p.dueMs = nowMs() + delayMs;
            return true;
        }
        if (!p.used && free_slot == nullptr) free_slot = &p;
    }
    if (free_slot == nullptr) {
        // Fila cheia: nao perde o ajuste, grava agora.
        return setInt(key, value);
    }
    std::strncpy(free_slot->key, key, sizeof(free_slot->key) - 1);
    free_slot->key[sizeof(free_slot->key) - 1] = '\0';
    std::strncpy(free_slot->val, val, sizeof(free_slot->val) - 1);
    free_slot->val[sizeof(free_slot->val) - 1] = '\0';
    free_slot->dueMs = nowMs() + delayMs;
    free_slot->used = true;
    return true;
}

void tick() {
    static uint32_t s_last = 0;
    const uint32_t now = nowMs();
    if (now - s_last < 200) return;  // resolucao do debounce
    s_last = now;
    for (auto& p : s_pending) {
        if (p.used && (int32_t)(now - p.dueMs) >= 0) writePending(p);
    }
}

void flush() {
    for (auto& p : s_pending) {
        if (p.used) writePending(p);
    }
}

void migrate() {
    // Import one-shot dos .txt da era pre-NVS (idempotente). Antes isso so
    // rodava no WebManager; nas placas sem web server nunca acontecia.
    CelerSettings::migrateLegacy();

    int ver = 0;
    const std::string s = CelerSettings::get("settings_ver", "");
    if (s.empty() || !parseInt(s.c_str(), &ver) || ver < kSchemaVersion) {
        char buf[8];
        const int n = snprintf(buf, sizeof(buf), "%d", kSchemaVersion);
        if (n > 0 && (size_t)n < sizeof(buf)) CelerSettings::set("settings_ver", buf);
    }
}

}  // namespace Settings
