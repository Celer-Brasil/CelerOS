#include "Encoder.h"

#include "driver/gpio.h"
#include "driver/pulse_cnt.h"
#include "esp_log.h"

// ============================================================================
// Implementacao do encoder por PCNT (ver Encoder.h).
// ============================================================================

namespace {

struct Slot {
    pcnt_unit_handle_t unit = nullptr;
    pcnt_channel_handle_t chan = nullptr;
    int pinA = -1;
    int pinB = -1;
};

Slot s_slots[Encoder::kMax];

int findFree() {
    for (int i = 0; i < Encoder::kMax; i++) {
        if (s_slots[i].unit == nullptr) return i;
    }
    return -1;
}

void releaseSlot(int id) {
    Slot& s = s_slots[id];
    if (s.unit) pcnt_unit_disable(s.unit);
    if (s.chan) { pcnt_del_channel(s.chan); s.chan = nullptr; }
    if (s.unit) { pcnt_del_unit(s.unit); s.unit = nullptr; }
    s.pinA = -1;
    s.pinB = -1;
}

}  // namespace

namespace Encoder {

int create(int pinA, int pinB, bool pullup) {
    if (pinA < 0 || pinB < 0 || pinA == pinB) return -1;
    const int id = findFree();
    if (id < 0) {
        ESP_LOGW("celer.enc", "sem unidade PCNT livre (max %d)", kMax);
        return -1;
    }

    pcnt_unit_config_t ucfg = {};
    ucfg.low_limit = -32768;
    ucfg.high_limit = 32767;
    ucfg.flags.accum_count = 1;  // nao "da a volta" a cada 32767 pulsos
    pcnt_unit_handle_t unit = nullptr;
    if (pcnt_new_unit(&ucfg, &unit) != ESP_OK || unit == nullptr) {
        ESP_LOGW("celer.enc", "pcnt_new_unit falhou");
        return -1;
    }

    pcnt_chan_config_t ccfg = {};
    ccfg.edge_gpio_num = pinA;
    ccfg.level_gpio_num = pinB;
    pcnt_channel_handle_t chan = nullptr;
    if (pcnt_new_channel(unit, &ccfg, &chan) != ESP_OK || chan == nullptr) {
        ESP_LOGW("celer.enc", "pcnt_new_channel falhou (pinos %d/%d)", pinA, pinB);
        pcnt_del_unit(unit);
        return -1;
    }

    // Quadratura A/B: flanco em A com B baixo = um sentido; B alto = o outro.
    pcnt_channel_set_edge_action(chan, PCNT_CHANNEL_EDGE_ACTION_DECREASE,
                                 PCNT_CHANNEL_EDGE_ACTION_INCREASE);
    pcnt_channel_set_level_action(chan, PCNT_CHANNEL_LEVEL_ACTION_KEEP,
                                  PCNT_CHANNEL_LEVEL_ACTION_INVERSE);

    if (pullup) {
        gpio_set_pull_mode((gpio_num_t)pinA, GPIO_PULLUP_ONLY);
        gpio_set_pull_mode((gpio_num_t)pinB, GPIO_PULLUP_ONLY);
    }

    if (pcnt_unit_enable(unit) != ESP_OK) {
        pcnt_del_channel(chan);
        pcnt_del_unit(unit);
        return -1;
    }
    pcnt_unit_clear_count(unit);
    if (pcnt_unit_start(unit) != ESP_OK) {
        pcnt_unit_disable(unit);
        pcnt_del_channel(chan);
        pcnt_del_unit(unit);
        return -1;
    }

    s_slots[id].unit = unit;
    s_slots[id].chan = chan;
    s_slots[id].pinA = pinA;
    s_slots[id].pinB = pinB;
    ESP_LOGI("celer.enc", "encoder %d nos pinos %d/%d (pull-up %d)",
             id, pinA, pinB, pullup ? 1 : 0);
    return id;
}

bool read(int id, int* count) {
    if (id < 0 || id >= kMax || count == nullptr || s_slots[id].unit == nullptr) return false;
    int v = 0;
    if (pcnt_unit_get_count(s_slots[id].unit, &v) != ESP_OK) return false;
    *count = v;
    return true;
}

bool reset(int id) {
    if (id < 0 || id >= kMax || s_slots[id].unit == nullptr) return false;
    return pcnt_unit_clear_count(s_slots[id].unit) == ESP_OK;
}

void free(int id) {
    if (id < 0 || id >= kMax) return;
    releaseSlot(id);
}

void resetAll() {
    for (int i = 0; i < kMax; i++) releaseSlot(i);
}

}  // namespace Encoder
