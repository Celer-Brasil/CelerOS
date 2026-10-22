#include "JSBindings.h"
#include "JsInternal.h"

#include "../Hardware/InputBus.h"
#include "../Utils/AppPerms.h"

// =====================================================
// Input (API 48): barramento de input do OS
// =====================================================
//
// O driver de teclado/mouse (JS) injeta com Input.key/Input.move; o app le
// com Input.poll/Input.pointer. Em placa com tela o ponteiro tambem entra no
// readTouches (Kui) como dedo sintetico, entao o mouse clica/dirige a UI.
//
// Usage IDs sao os do HID (Keyboard/Keypad, 0x04..0xE7): 0x04=A, 0x1D=Z,
// 0x28=Enter, 0x29=Esc, 0x2C=Espaco. `mods` e o byte de modificadores HID
// (bit0 LCtrl, bit1 LShift, bit2 LAlt, bit3 LGUI, bit4 RCtrl, ...). Sem
// tabela de traducao no firmware — quem entende teclado e o driver JS.

namespace {

void requireInput(duk_context* ctx) {
    if (!perm(celer::PERM_INPUT)) {
        jsThrowMsg(ctx, DUK_ERR_ERROR, "Input: requer permissao \"input\"");
    }
}

uint8_t requireByte(duk_context* ctx, duk_idx_t idx, const char* msg) {
    const int v = duk_require_int(ctx, idx);
    if (v < 0 || v > 255) jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, msg);
    return (uint8_t)v;
}

}  // namespace

duk_ret_t JSBindings::js_inputKey(duk_context *ctx) {
    requireInput(ctx);
    const uint8_t usage = requireByte(ctx, 0, "Input.key: usage deve ser 0..255");
    const uint8_t mods = requireByte(ctx, 1, "Input.key: mods deve ser 0..255");
    const bool down = duk_require_boolean(ctx, 2) != 0;
    duk_push_boolean(ctx, InputBus::pushKey(usage, mods, down) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_inputPoll(duk_context *ctx) {
    requireInput(ctx);
    InputBus::KeyEvent ev;
    if (!InputBus::popKey(ev)) {
        duk_push_null(ctx);
        return 1;
    }
    duk_push_object(ctx);
    duk_push_int(ctx, ev.usage);
    duk_put_prop_string(ctx, -2, "key");
    duk_push_int(ctx, ev.mods);
    duk_put_prop_string(ctx, -2, "mods");
    duk_push_boolean(ctx, ev.down ? 1 : 0);
    duk_put_prop_string(ctx, -2, "down");
    return 1;
}

duk_ret_t JSBindings::js_inputMove(duk_context *ctx) {
    requireInput(ctx);
    const int x = duk_require_int(ctx, 0);
    const int y = duk_require_int(ctx, 1);
    const uint8_t buttons = requireByte(ctx, 2, "Input.move: buttons deve ser 0..255");
    InputBus::setPointer((int16_t)x, (int16_t)y, buttons);
    return 0;
}

duk_ret_t JSBindings::js_inputPointer(duk_context *ctx) {
    requireInput(ctx);
    const InputBus::Pointer p = InputBus::pointer();
    duk_push_object(ctx);
    duk_push_int(ctx, p.x);
    duk_put_prop_string(ctx, -2, "x");
    duk_push_int(ctx, p.y);
    duk_put_prop_string(ctx, -2, "y");
    duk_push_int(ctx, p.buttons);
    duk_put_prop_string(ctx, -2, "buttons");
    return 1;
}

duk_ret_t JSBindings::js_inputClear(duk_context *ctx) {
    requireInput(ctx);
    InputBus::clear();
    return 0;
}
