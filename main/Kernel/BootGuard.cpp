#include "BootGuard.h"

#include <Arduino.h>
#include <esp_attr.h>
#include <esp_system.h>
#include "../USBDevice/LogSink.h"  // celer_log_printf

namespace {

// RTC_NOINIT: sobrevive a panic, watchdog e reboot sem gastar NVS. O magic
// descarta lixo de power-on; o layout permite mudar o struct no futuro.
struct BootRec {
    uint32_t magic;
    uint32_t layout;
    uint32_t count;
};
RTC_NOINIT_ATTR BootRec s_rec;

constexpr uint32_t kMagic = 0x424F4F54;  // 'BOOT'
constexpr uint32_t kLayout = 1;
constexpr uint32_t kSafeAfter = 3;     // 3 boots sem estabilizar = modo seguro
constexpr uint32_t kStableMs = 15000;  // tempo de uptime que conta como "subiu"
constexpr uint32_t kCountCap = 10;     // teto (nao interessa contar mais)

bool s_safeThisBoot = false;
bool s_lastBootUnstable = false;
bool s_cleared = false;  // o tick roda a cada laco; grava no RTC UMA vez

bool resetsCounter(esp_reset_reason_t why) {
    // Nao sao falhas de boot: energia, deep sleep (acordar por timer), queda
    // de energia e reset externo (o usuario apertou o botao).
    return why == ESP_RST_POWERON || why == ESP_RST_DEEPSLEEP ||
           why == ESP_RST_BROWNOUT || why == ESP_RST_EXT;
}

}  // namespace

namespace BootGuard {

void noteBoot() {
    const esp_reset_reason_t why = esp_reset_reason();
    if (s_rec.magic != kMagic || s_rec.layout != kLayout || resetsCounter(why)) {
        s_rec.magic = kMagic;
        s_rec.layout = kLayout;
        s_rec.count = 0;
    }
    if (s_rec.count < kCountCap) s_rec.count++;
    s_safeThisBoot = (s_rec.count >= kSafeAfter);
    s_lastBootUnstable = (s_rec.count >= 2);  // o anterior nao zerou o contador
    if (s_safeThisBoot) {
        celer_log_printf("[boot] modo seguro: %u boots sem estabilizar (reset=%d)\n",
                         (unsigned)s_rec.count, (int)why);
    }
}

bool safeMode() { return s_safeThisBoot; }
bool lastBootUnstable() { return s_lastBootUnstable; }

void tick() {
    if (s_cleared) return;
    if (s_rec.magic != kMagic) return;
    if (millis() < kStableMs) return;
    s_rec.count = 0;  // chegou vivo ao launcher: o proximo boot comeca do zero
    s_cleared = true;
}

}  // namespace BootGuard
