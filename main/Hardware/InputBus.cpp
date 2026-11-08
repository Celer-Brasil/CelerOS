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
#if !CONFIG_CELEROS_UI
    (void)inApp;  // headless: sem Navigator, o contexto do pump nao decide nada
#endif
    const PadState p = pad();
    const bool guide = (p.buttons & kBitGuide) != 0;
    // A borda e consumida UMA vez: os DOIS pumps chamam este tick (celerLoop
    // na task da UI e present() na task do app — servico ALWAYS). Sem o lock,
    // os dois liam s_prevGuide antes de qualquer gravar: o guide agia DUAS
    // vezes (ou no pump errado).
    bool borda = false;
    portENTER_CRITICAL(&s_mux);
    if (guide != s_prevGuide) {
        s_prevGuide = guide;
        borda = true;
    }
    portEXIT_CRITICAL(&s_mux);
    if (!borda) return;
    if (!guide) return;  // so a borda de descida (apertar) age
    // botao de sistema: activity acorda (mesmo hub do toque/botoes fisicos)
    Backlight::noteActivity();
    // O flag inApp descreve O PUMP, nao o estado: o celerLoop roda com
    // inApp=false MESMO com app em foreground, e decidir por ele fazia o
    // guide dentro do app cair em Navigator::home() (arrancava a pilha de
    // telas por baixo do app, sem o caminho limpo de saida). Quem manda e o
    // estado real do launcher; requestAppExit e seguro de qualquer task
    // (flag com mux proprio) e Navigator::home so roda no pump da UI.
    if (LauncherUI::appRunning()) {
        LauncherUI::requestAppExit();  // caminho limpo pelo X do topbar
        return;
    }
#if CONFIG_CELEROS_UI
    if (!inApp) kui::Navigator::home();  // celerLoop = task da UI (muta a pilha)
#endif
}

void clear() {
    portENTER_CRITICAL(&s_mux);
    s_head = s_tail = 0;
    s_pointer = Pointer{};
    s_pad = PadState{};
    s_prevGuide = false;  // bench reset no meio do guide: a proxima pressao tem que ser borda nova
    portEXIT_CRITICAL(&s_mux);
}

}  // namespace InputBus
