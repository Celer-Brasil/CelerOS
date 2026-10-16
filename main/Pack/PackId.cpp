#include "PackId.h"

#include <string.h>
#include <string>

#include "esp_mac.h"

#include "../Utils/CelerSettings.h"

namespace {

uint16_t s_node = 0;
// Nome persistido em cache: "" = default "Celer-XXXX". Escrito so do tick
// (init/setName), lido de qualquer task — string curta, escrita rara.
char s_name[packid::NAME_LEN + 1] = {0};

}  // namespace

namespace PackId {

uint16_t nodeId() {
    if (s_node == 0) {
        uint8_t mac[6] = {0};
        esp_read_mac(mac, ESP_MAC_BT);
        s_node = packid::nodeFromMac(mac);
    }
    return s_node;
}

void btMac(uint8_t out[6]) {
    esp_read_mac(out, ESP_MAC_BT);
}

void staMac(uint8_t out[6]) {
    esp_read_mac(out, ESP_MAC_WIFI_STA);
}

uint16_t pcNode() {
    return packid::pcNodeOf(nodeId());
}

void init() {
    nodeId();
    const std::string cur = CelerSettings::get("celernet_name", "");
    snprintf(s_name, sizeof(s_name), "%.*s", (int)packid::NAME_LEN, cur.c_str());
}

void name(char* out, size_t cap) {
    if (s_name[0] != '\0') snprintf(out, cap, "%s", s_name);
    else packid::defaultName(nodeId(), out, cap);
}

bool setName(const char* name) {
    char buf[packid::NAME_LEN + 1] = {0};
    if (name != nullptr) snprintf(buf, sizeof(buf), "%.*s", (int)packid::NAME_LEN, name);
    if (!CelerSettings::set("celernet_name", buf)) return false;
    memcpy(s_name, buf, sizeof(s_name));
    return true;
}

}  // namespace PackId
