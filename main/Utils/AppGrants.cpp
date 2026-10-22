#include "AppGrants.h"

#include <cstdio>
#include "nvs.h"
#include "AppPerms.h"

namespace {

const char* kNs = "app_grants";
const char* kMigKey = "_mig";

struct Record {
    uint32_t mask;
    uint32_t pathHash;
};

uint32_t fnv1a(const std::string& s) {
    uint32_t h = 2166136261u;
    for (char c : s) h = (h ^ (uint8_t)c) * 16777619u;
    return h;
}

// Caminho sem barra final: "/local/apps/X/" e "/local/apps/X" sao o mesmo app
std::string normPath(const std::string& path) {
    std::string p = path;
    while (p.size() > 1 && p.back() == '/') p.pop_back();
    return p;
}

// Chave NVS (<= 15): "g" + FNV-1a do packageName
void keyFor(const std::string& pkg, char out[12]) {
    snprintf(out, 12, "g%08x", (unsigned)fnv1a(pkg));
}

}  // namespace

namespace AppGrants {

bool lookup(const std::string& pkg, const std::string& path, uint32_t* mask) {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READONLY, &h) != ESP_OK) return false;
    char key[12];
    keyFor(pkg, key);
    Record r{};
    size_t len = sizeof(r);
    bool ok = nvs_get_blob(h, key, &r, &len) == ESP_OK && len == sizeof(r) &&
              r.pathHash == fnv1a(normPath(path));
    nvs_close(h);
    if (ok && mask) *mask = r.mask;
    return ok;
}

bool grant(const std::string& pkg, const std::string& path, uint32_t mask) {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) return false;
    char key[12];
    keyFor(pkg, key);
    Record r{mask, fnv1a(normPath(path))};
    bool ok = nvs_set_blob(h, key, &r, sizeof(r)) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    return ok;
}

void revoke(const std::string& pkg) {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) return;
    char key[12];
    keyFor(pkg, key);
    nvs_erase_key(h, key);
    nvs_commit(h);
    nvs_close(h);
}

bool migrated() {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READONLY, &h) != ESP_OK) return false;
    uint8_t v = 0;
    bool ok = nvs_get_u8(h, kMigKey, &v) == ESP_OK && v == 1;
    nvs_close(h);
    return ok;
}

void setMigrated() {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_u8(h, kMigKey, 1);
    nvs_commit(h);
    nvs_close(h);
}

std::string describe(uint32_t mask) {
    std::string out;
    auto add = [&](uint32_t bit, const char* name) {
        if (!(mask & bit)) return;
        if (!out.empty()) out += ", ";
        out += name;
    };
    add(celer::PERM_FS, "arquivos");
    add(celer::PERM_NET, "rede");
    add(celer::PERM_GPIO, "GPIO");
    add(celer::PERM_SYSTEM, "sistema");
    add(celer::PERM_MIC, "microfone");
    add(celer::PERM_CAMERA, "camera");
    add(celer::PERM_USB, "dispositivos USB");
    add(celer::PERM_INPUT, "teclado e mouse");
    return out;
}

}  // namespace AppGrants
