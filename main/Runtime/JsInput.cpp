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

// Campo inteiro opcional de um objeto {..}: default quando ausente/nao
// numero; RangeError fora da janela (antes de tocar o bus).
int optField(duk_context* ctx, duk_idx_t objIdx, const char* name, int def, int lo, int hi,
             const char* what) {
    duk_get_prop_string(ctx, objIdx, name);
    const bool has = duk_is_number(ctx, -1);
    const int v = has ? duk_get_int(ctx, -1) : def;
    duk_pop(ctx);
    if (v < lo || v > hi) jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, what);
    return v;
}

// Input.pad({buttons, dpad, lx, ly, rx, ry}) (API 61): injeta o estado
// corrente do gamepad no canal de broadcast. E Chamado pelo driver
// residente a cada report (25 ms); consumidores fazem o diff de bordas.
duk_ret_t JSBindings::js_inputPad(duk_context *ctx) {
    requireInput(ctx);
    if (!duk_is_object(ctx, 0)) {
        jsThrowMsg(ctx, DUK_ERR_TYPE_ERROR, "Input.pad: objeto {buttons, dpad, lx..}");
    }
    InputBus::PadState st;
    // eixos sao int8: -127..127 (0 = centro); bitmask sem sinal
    st.buttons = (uint32_t)optField(ctx, 0, "buttons", 0, 0, 0x7FFFFF, "Input.pad: buttons fora de 0..0x7FFFFF");
    st.dpad = (uint8_t)optField(ctx, 0, "dpad", 0, 0, 15, "Input.pad: dpad fora de 0..15");
    st.lx = (int8_t)optField(ctx, 0, "lx", 0, -127, 127, "Input.pad: lx fora de -127..127");
    st.ly = (int8_t)optField(ctx, 0, "ly", 0, -127, 127, "Input.pad: ly fora de -127..127");
    st.rx = (int8_t)optField(ctx, 0, "rx", 0, -127, 127, "Input.pad: rx fora de -127..127");
    st.ry = (int8_t)optField(ctx, 0, "ry", 0, -127, 127, "Input.pad: ry fora de -127..127");
    InputBus::pushPad(st);
    return 0;
}

// Input.padState() (API 61): estado corrente do canal (seq sobe a cada
// Input.pad; 0 = nenhum driver injetou). Bitmask cru — os nomes ficam na
// dep celeros.gamepad / driver.
duk_ret_t JSBindings::js_inputPadState(duk_context *ctx) {
    requireInput(ctx);
    const InputBus::PadState p = InputBus::pad();
    duk_push_object(ctx);
    duk_push_uint(ctx, p.seq);
    duk_put_prop_string(ctx, -2, "seq");
    duk_push_uint(ctx, p.buttons);
    duk_put_prop_string(ctx, -2, "buttons");
    duk_push_int(ctx, p.dpad);
    duk_put_prop_string(ctx, -2, "dpad");
    duk_push_int(ctx, p.lx);
    duk_put_prop_string(ctx, -2, "lx");
    duk_push_int(ctx, p.ly);
    duk_put_prop_string(ctx, -2, "ly");
    duk_push_int(ctx, p.rx);
    duk_put_prop_string(ctx, -2, "rx");
    duk_push_int(ctx, p.ry);
    duk_put_prop_string(ctx, -2, "ry");
    return 1;
}
