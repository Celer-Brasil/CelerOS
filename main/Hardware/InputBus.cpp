#include "InputBus.h"

#include <freertos/FreeRTOS.h>

#include "../Display/Backlight.h"
#if CONFIG_CELEROS_UI
#include "../UI/Kui.h"
#endif
#include "../Launcher/LauncherUI.h"
#include "sdkconfig.h"

namespace InputBus {

namespace {
constexpr uint8_t kKeyRing = 16;
constexpr int16_t kW = 240;  // espaco virtual dos apps (UI::W x UI::H)
constexpr int16_t kH = 320;

KeyEvent s_keys[kKeyRing];
uint8_t s_head = 0;
uint8_t s_tail = 0;
Pointer s_pointer;
PadState s_pad;
portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

inline int16_t clampCoord(int16_t v, int16_t maxV) {
    if (v < 0) return 0;
    if (v > maxV) return maxV;
    return v;
}

// diff de bordas do guide dentro do sysTick (task dos pumps)
constexpr uint32_t kBitGuide = 1u << 10;
bool s_prevGuide = false;
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

void pushPad(const PadState& st) {
    portENTER_CRITICAL(&s_mux);
    s_pad = st;
    s_pad.seq = s_pad.seq + 1;
    portEXIT_CRITICAL(&s_mux);
}

PadState pad() {
    PadState p;
    portENTER_CRITICAL(&s_mux);
    p = s_pad;
    portEXIT_CRITICAL(&s_mux);
    return p;
}

void sysTick(bool inApp) {
    const PadState p = pad();
    const bool guide = (p.buttons & kBitGuide) != 0;
    if (guide == s_prevGuide) return;
    s_prevGuide = guide;
    if (!guide) return;  // so a borda de descida age
    // botao de sistema: activity acorda (mesmo hub do toque/botoes fisicos)
    Backlight::noteActivity();
    if (inApp) {
        LauncherUI::requestAppExit();  // caminho limpo pelo X do topbar
    } else {
#if CONFIG_CELEROS_UI
        kui::Navigator::home();
#endif
    }
}

void clear() {
    portENTER_CRITICAL(&s_mux);
    s_head = s_tail = 0;
    s_pointer = Pointer{};
    s_pad = PadState{};
    portEXIT_CRITICAL(&s_mux);
}

}  // namespace InputBus
