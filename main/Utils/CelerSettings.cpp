#include "CelerSettings.h"
#include "../FileSystem/FileSystem.h"
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char* CS_TAG = "celer.settings";
static const char* NVS_NS = "settings";

std::string CelerSettings::get(const char* key, const char* def) {
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) return def ? def : "";
    // 160 B: comporta valores compostos como steps_hist (7 dias x ~15 B).
    // O teto antigo de 63 B fazia o historico parar de gravar no 4o dia
    // (o set devolvia false e o chamador ignorava).
    char buf[160];
    size_t len = sizeof(buf);
    std::string out = (def != nullptr) ? def : "";
    if (nvs_get_str(h, key, buf, &len) == ESP_OK && len > 1) {
        out.assign(buf, len - 1);  // len inclui o '\0'
    }
    nvs_close(h);
    return out;
}

bool CelerSettings::set(const char* key, const char* value) {
    // Teto simetrico ao get (buf[160]): sem isto o nvs_set_str aceitava valor
    // maior e a leitura seguinte devolvia o default — o chamador achava que
    // estava gravado. (O binding JS System.setting segue em 63; aqui fecha
    // para todo caller C++.)
    if (value != nullptr && strlen(value) > 159) return false;
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return false;
    bool ok;
    if (value == nullptr || value[0] == '\0') {
        ok = true;
        nvs_erase_key(h, key);  // ausente nao e erro
    } else {
        ok = nvs_set_str(h, key, value) == ESP_OK;
    }
    ok = nvs_commit(h) == ESP_OK && ok;
    nvs_close(h);
    return ok;
}

bool CelerSettings::erase(const char* key) { return set(key, ""); }

bool CelerSettings::eraseAll() {
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return false;
    // nvs_erase_all apaga TODAS as chaves do namespace do handle. A coleta
    // via iterator anterior capava em 16 chaves (8 alarmes + timer/soneca +
    // brilho + System.setting arbitrario...) e abandonava o resto: o reset
    // de fabrica deixava configuracoes para tras.
    bool ok = nvs_erase_all(h) == ESP_OK;
    ok = nvs_commit(h) == ESP_OK && ok;
    nvs_close(h);
    return ok;
}

void CelerSettings::migrateLegacy() {
    nvs_flash_init();  // idempotente

    // flags: arquivo presente = "1". strings: conteudo trimado.
    struct Legacy {
        const char* key;
        const char* file;
        bool isFlag;
    };
    const Legacy legacy[] = {
        {"web_on",     "/local/web_on.txt",            true},
        {"nowifi",     "/local/nowifi.txt",            true},
        {"install_sd", "/local/config_install_sd.txt", true},
        {"brightness", "/local/brightness.txt",        false},
    };

    for (const auto& l : legacy) {
        if (!get(l.key).empty()) continue;      // NVS ja tem: arquivo e lixo
        if (!FileSystem::exists(l.file)) continue;
        if (l.isFlag) {
            set(l.key, "1");
        } else {
            std::string v = FileSystem::readTextFile(l.file);
            while (!v.empty() && (v.back() == '\n' || v.back() == '\r' || v.back() == ' ')) v.pop_back();
            if (!v.empty()) set(l.key, v.c_str());
        }
        FileSystem::deleteFile(l.file);
        ESP_LOGI(CS_TAG, "%s migrado para NVS (%s)", l.file, l.key);
    }
}
