#include "InputBus.h"

#include <freertos/FreeRTOS.h>

namespace InputBus {

namespace {
constexpr uint8_t kKeyRing = 16;
constexpr int16_t kW = 240;  // espaco virtual dos apps (UI::W x UI::H)
constexpr int16_t kH = 320;

KeyEvent s_keys[kKeyRing];
uint8_t s_head = 0;
uint8_t s_tail = 0;
Pointer s_pointer;
portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

inline int16_t clampCoord(int16_t v, int16_t maxV) {
    if (v < 0) return 0;
    if (v > maxV) return maxV;
    return v;
}
}  // namespace

bool pushKey(uint8_t usage, uint8_t mods, bool down) {
    bool ok = false;
    portENTER_CRITICAL(&s_mux);
    const uint8_t next = (uint8_t)((s_head + 1) % kKeyRing);
    if (next != s_tail) {
        s_keys[s_head].usage = usage;
        s_keys[s_head].mods = mods;
        s_keys[s_head].down = down;
        s_head = next;
        ok = true;
    }
    portEXIT_CRITICAL(&s_mux);
    return ok;
}

bool popKey(KeyEvent& out) {
    bool ok = false;
    portENTER_CRITICAL(&s_mux);
    if (s_tail != s_head) {
        out = s_keys[s_tail];
        s_tail = (uint8_t)((s_tail + 1) % kKeyRing);
        ok = true;
    }
    portEXIT_CRITICAL(&s_mux);
    return ok;
}

void setPointer(int16_t x, int16_t y, uint8_t buttons) {
    portENTER_CRITICAL(&s_mux);
    s_pointer.x = clampCoord(x, kW - 1);
    s_pointer.y = clampCoord(y, kH - 1);
    s_pointer.buttons = buttons;
    portEXIT_CRITICAL(&s_mux);
}

Pointer pointer() {
    Pointer p;
    portENTER_CRITICAL(&s_mux);
    p = s_pointer;
    portEXIT_CRITICAL(&s_mux);
    return p;
}

void clear() {
    portENTER_CRITICAL(&s_mux);
    s_head = s_tail = 0;
    s_pointer = Pointer{};
    portEXIT_CRITICAL(&s_mux);
}

}  // namespace InputBus
