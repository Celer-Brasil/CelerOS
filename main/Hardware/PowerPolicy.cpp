#include "PowerPolicy.h"
#include "AudioPlayer.h"
#include "BoardIO.h"
#include "../Boards/Board.h"
#include "../Display/Backlight.h"
#include "../Display/ScreenPower.h"
#include "../Utils/CelerSettings.h"
#include "../WebManager/WebManager.h"
#include "../USBDevice/DebugBridge.h"
#include "esp_log.h"
#include "sdkconfig.h"
#include <Arduino.h>
#include <atomic>
#include <stdlib.h>
#include <string>
#if CONFIG_PM_ENABLE
#include "esp_pm.h"
#endif

namespace {

bool s_on = false;
uint32_t s_checkAt = 0;
uint32_t s_offSince = 0;      // tela apagada desde (0 = acesa)
bool s_wifiAutoOff = false;   // nos desligamos (religa ao acender)
int s_wifiSleepMin = 0;
#if CONFIG_PM_ENABLE
esp_pm_lock_handle_t s_cpuLock = nullptr;   // CPU_FREQ_MAX com a tela acesa
esp_pm_lock_handle_t s_litLock = nullptr;   // NO_LIGHT_SLEEP com a tela acesa (UI sem latencia de wake)
esp_pm_lock_handle_t s_usbLock = nullptr;   // NO_LIGHT_SLEEP com USB presente
esp_pm_lock_handle_t s_audioLock = nullptr; // NO_LIGHT_SLEEP com audio/mic ativo
bool s_cpuHeld = false;
bool s_litHeld = false;
bool s_usbHeld = false;
// Donos do s_audioLock: playWav/PcmFeed/tom/musica (guarda do I2S) e a
// gravacao de mic. Contador porque os dois podem coexistir (mic + alto-
// falante em pinos separados) — com um booleano o fim de um soltava o lock
// do outro. Pareamento garantido por quem chama (ver PowerPolicy.h).
std::atomic<int> s_audioUsers{0};

void hold(esp_pm_lock_handle_t l, bool& held, bool want) {
    if (l == nullptr || held == want) return;
    held = want;
    if (want) {
        esp_pm_lock_acquire(l);
    } else {
        esp_pm_lock_release(l);
    }
}
#endif

}  // namespace

namespace PowerPolicy {

void init() {
    const BoardProfile& bp = Board::profile();
    if (!bp.autoLightSleep) return;
#if CONFIG_PM_ENABLE
    esp_pm_config_t cfg = {};
    cfg.max_freq_mhz = CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ;
    cfg.min_freq_mhz = 40;
    cfg.light_sleep_enable = true;
    if (esp_pm_configure(&cfg) != ESP_OK) {
        ESP_LOGW("celer.power", "esp_pm_configure falhou: sem light sleep");
        return;
    }
    esp_pm_lock_create(ESP_PM_CPU_FREQ_MAX, 0, "celer.ui", &s_cpuLock);
    esp_pm_lock_create(ESP_PM_NO_LIGHT_SLEEP, 0, "celer.lit", &s_litLock);
    esp_pm_lock_create(ESP_PM_NO_LIGHT_SLEEP, 0, "celer.usb", &s_usbLock);
    esp_pm_lock_create(ESP_PM_NO_LIGHT_SLEEP, 0, "celer.audio", &s_audioLock);
    // audio ja em curso durante o init (beep de boot): assume o lock agora
    if (s_audioLock != nullptr && s_audioUsers.load() > 0) esp_pm_lock_acquire(s_audioLock);
    hold(s_cpuLock, s_cpuHeld, true);  // boot com a tela acesa
    hold(s_litLock, s_litHeld, true);
    hold(s_usbLock, s_usbHeld, true);  // ate o 1o tick ler o VBUS
    s_on = true;
    ESP_LOGI("celer.power", "PM ativo: DFS 40..%d MHz + light sleep com a tela apagada",
             CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ);
#endif
    reloadSettings();
}

void reloadSettings() {
    std::string v = CelerSettings::get("wifi_sleep_min", "");
    s_wifiSleepMin = v.empty() ? Board::profile().wifiSleepMin : atoi(v.c_str());
}

void audioBusy(bool on) {
#if CONFIG_PM_ENABLE
    // O contador vale mesmo antes do lock existir (som de boot): o init ve
    // s_audioUsers > 0 e assume o lock na criacao. Sem PM (autoLightSleep
    // off) o handle fica nulo e so o contador anda — pareado, volta a zero.
    if (on) {
        if (s_audioUsers.fetch_add(1) == 0 && s_audioLock != nullptr) {
            esp_pm_lock_acquire(s_audioLock);
        }
    } else {
        const int antes = s_audioUsers.fetch_sub(1);
        if (antes <= 0) {          // false sem o true correspondente: nao
            s_audioUsers.store(0); // desce de zero nem solta lock alheio
            return;
        }
        if (antes == 1 && s_audioLock != nullptr) esp_pm_lock_release(s_audioLock);
    }
#else
    (void)on;
#endif
}

void tick() {
    if (!s_on) return;
    const uint32_t now = millis();
    if (now - s_checkAt < 1000) return;
    s_checkAt = now;
    const int st = ScreenPower::state();
    const bool lit = st >= 2;
#if CONFIG_PM_ENABLE
    // Rede de seguranca do audio: os donos do som chamam audioBusy(true/false)
    // na hora (latencia zero), mas um caminho novo que esqueca a chamada
    // ainda e pego aqui em <=1 s. A gravacao tambem segura (mic rec).
    const bool audio = AudioPlayer::active() || BoardIO::micRecActive();
    hold(s_cpuLock, s_cpuHeld, lit);
    hold(s_litLock, s_litHeld, lit || audio);
    const int chg = BoardIO::chargeState();
    hold(s_usbLock, s_usbHeld, chg > 0 && (chg & 2));
#endif
    // WiFi ocioso com a tela apagada
    if (lit) {
        s_offSince = 0;
        if (s_wifiAutoOff) {
            s_wifiAutoOff = false;
            if (WebManager::wifiEnabled()) WebManager::enableAsync();
            ESP_LOGI("celer.power", "tela acesa: WiFi religado");
        }
    } else if (st == 0) {
        if (s_offSince == 0) s_offSince = now;
        if (s_wifiSleepMin > 0 && !s_wifiAutoOff && WebManager::isActive() &&
            !DebugBridge::sessionActive() &&  // celerctl por WiFi em uso: radio fica
            now - s_offSince >= (uint32_t)s_wifiSleepMin * 60000UL) {
            s_wifiAutoOff = true;
            WebManager::disable();  // nao persiste: a flag nowifi segue intacta
            ESP_LOGI("celer.power", "tela apagada ha %d min: WiFi desligado", s_wifiSleepMin);
        }
    }
}

int loopDelayMs() {
    // Sem PM (CYD, SmartDisplay, cao, devkit): com o backlight apagado pelo
    // timeout o loop so precisa ver o toque que acorda — 20 ms (50 Hz de
    // poll do touch) em vez de 200 voltas/s de I2C/SPI e servicos a toa.
    if (!s_on) return Backlight::isOff() ? 20 : 5;
    return ScreenPower::state() >= 2 ? 5 : 50;
}

}  // namespace PowerPolicy
