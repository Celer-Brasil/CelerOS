#ifndef CELEROS_UTILS_SETTINGS_H
#define CELEROS_UTILS_SETTINGS_H

#include <stddef.h>
#include <stdint.h>

#include <cstdlib>
#include <cstring>
#include <string>

// Registro tipado das configuracoes do sistema (por cima do CelerSettings/NVS).
//
// O NVS continua sendo o backend (namespace "settings", string). Este layer
// acrescenta o que faltava: default por chave, faixa, leitura tipada e um
// debounce para controles continuos. Chave desconhecida continua passando
// pelo CelerSettings como string — nenhum `System.setting` de app quebra.
//
// Convencao de bool: true grava "1"; false APAGA a chave (""), que e o que
// WebManager/Notifications ja faziam. Todo leitor do firmware compara com
// "1", entao "0" e "" (e "false"/"off") contam como false.
namespace Settings {

enum class Type : uint8_t { Bool, Int, Str };

struct KeyDef {
    const char* key;
    Type type;
    const char* def;
    int min;  // so para Int
    int max;
};

// So entram chaves cujo default e faixa sao conhecidos no codigo atual.
// Contadores/compostos (steps_hist, timer_at, epoch, shot_n...) ficam fora:
// seguem string no CelerSettings. wifi_sleep_min fica fora porque o default
// e da placa (Board::profile().wifiSleepMin).
constexpr KeyDef kKeys[] = {
    {"brightness", Type::Int, "100", 5, 100},
    {"auto_brightness", Type::Bool, "0", 0, 1},
    // ms; 0 = desliga so pelo screen_off_min. Teto de 4 h (Backlight).
    {"screen_timeout", Type::Int, "0", 0, 14400000},
    {"screen_off_min", Type::Int, "3", 1, 5},
    {"deep_sleep_min", Type::Int, "15", 0, 120},
    {"glance_sec", Type::Int, "5", 3, 8},
    {"raise_wake", Type::Bool, "1", 0, 1},
    {"aod", Type::Bool, "1", 0, 1},
    {"home_idle_s", Type::Int, "30", 0, 3600},
    {"volume", Type::Int, "100", 0, 100},
    {"dnd", Type::Bool, "0", 0, 1},
    // Off quando ausente (era CelerSettings::get("web_on") == "1"); o
    // web_on.txt legado, se existir, e importado antes por migrate().
    {"web_on", Type::Bool, "0", 0, 1},
    {"nowifi", Type::Bool, "0", 0, 1},
    {"phone_on", Type::Bool, "1", 0, 1},
    {"celernet", Type::Bool, "0", 0, 1},
};

constexpr size_t kKeyCount = sizeof(kKeys) / sizeof(kKeys[0]);
constexpr int kSchemaVersion = 1;

inline const KeyDef* lookup(const char* key) {
    if (key == nullptr) return nullptr;
    for (size_t i = 0; i < kKeyCount; ++i) {
        if (std::strcmp(kKeys[i].key, key) == 0) return &kKeys[i];
    }
    return nullptr;
}

// "1"/"true"/"on" -> true; "0"/""/"false"/"off" -> false.
inline bool parseBool(const char* s, bool* out) {
    if (s == nullptr || out == nullptr) return false;
    if (s[0] == '\0') {
        *out = false;
        return true;
    }
    if (std::strcmp(s, "1") == 0 || std::strcmp(s, "true") == 0 ||
        std::strcmp(s, "on") == 0) {
        *out = true;
        return true;
    }
    if (std::strcmp(s, "0") == 0 || std::strcmp(s, "false") == 0 ||
        std::strcmp(s, "off") == 0) {
        *out = false;
        return true;
    }
    return false;
}

inline bool parseInt(const char* s, int* out) {
    if (s == nullptr || out == nullptr || s[0] == '\0') return false;
    char* end = nullptr;
    const long v = std::strtol(s, &end, 10);
    if (end == s || *end != '\0') return false;
    if (v < -2147483647L - 1 || v > 2147483647L) return false;
    *out = (int)v;
    return true;
}

inline int clampInt(const KeyDef& d, int value) {
    if (value < d.min) return d.min;
    if (value > d.max) return d.max;
    return value;
}

// ---- API de leitura (default da tabela quando omitido) ----
bool getBool(const char* key);
bool getBool(const char* key, bool def);
int getInt(const char* key);
int getInt(const char* key, int def);
std::string getStr(const char* key, const char* def = "");

// ---- escrita validada ----
// Bool: true -> "1", false -> "" (apaga), a convencao do WebManager.
// Int: clampa na faixa conhecida (o caller ja clampava; isto centraliza).
// Str: compat total (qualquer chave, como o System.setting dos apps).
bool setBool(const char* key, bool value);
bool setInt(const char* key, int value);
bool setStr(const char* key, const char* value);

// Grava so depois de `delayMs` sem novo valor (sliders/volume). O servico
// "settings" chama tick(); flush() grava tudo (usado antes de dormir).
bool setIntDebounced(const char* key, int value, uint32_t delayMs = 2000);
void tick();
void flush();

// Import dos .txt legados (idempotente) + carimbo de schema no NVS.
// Chamado no boot (main.cpp) — antes so rodava junto do WebManager, entao
// nas placas sem web server o import nunca acontecia.
void migrate();

}  // namespace Settings

#endif  // CELEROS_UTILS_SETTINGS_H
