#include "JSBindings.h"

#include "../Boards/Board.h"
#include "../Hardware/Encoder.h"
#include "JsInternal.h"
#include "driver/gpio.h"
#include "esp_private/esp_gpio_reserve.h"

#include <cstdio>

// ============================================================================
// System.encoder (API 55) — encoder incremental A/B no PCNT.
//
// System.encoder.create(pinA, pinB, [pullup]) -> id (0..3) ou -1
// System.encoder.read(id)   -> contagem (int) ou null
// System.encoder.reset(id)  -> boolean
// System.encoder.free(id)   -> boolean
//
// A contagem e do hardware (PCNT): o app le quando quiser, sem polling de
// GPIO em JS. Pinos sao entradas; o pull-up interno cobre encoder
// open-collector. Mesma permissao do System.gpio ("gpio").
// ============================================================================

namespace {

int requirePin(duk_context* ctx, duk_idx_t idx) {
    const int pin = duk_require_int(ctx, idx);
    const bool valid = pin >= 0 && pin < 64 && GPIO_IS_VALID_GPIO(pin);
    const uint64_t bit = valid ? (1ULL << pin) : 0;
    // Reserva do PROPRIO runtime nao barra (JsGpio::requirePin, bancada
    // 2026-10-02): o esp_gpio_reserve do LEDC nao tem unreserve — servo no
    // pino em outro app deixava encoder.create falhando ate o reboot.
#if CONFIG_CELEROS_JS_GPIO
    const bool own = jsGpioOwnPin(pin);
#else
    const bool own = false;  // sem System.gpio nao ha LEDC de JS no pino
#endif
    if (!valid || (!own && esp_gpio_is_reserved(bit)) ||
        (Board::profile().gpioDeniedMask & bit)) {
        char msg[64];
        snprintf(msg, sizeof(msg), "GPIO %d invalido para encoder", pin);
        jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, msg);
    }
    return pin;
}

int requireId(duk_context* ctx, duk_idx_t idx) {
    const int id = duk_require_int(ctx, idx);
    if (id < 0 || id >= Encoder::kMax) {
        char msg[64];
        snprintf(msg, sizeof(msg), "encoder %d invalido (0..%d)", id, Encoder::kMax - 1);
        jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, msg);
    }
    return id;
}

}  // namespace

duk_ret_t JSBindings::js_encoderCreate(duk_context* ctx) {
    const int pinA = requirePin(ctx, 0);
    const int pinB = requirePin(ctx, 1);
    if (pinA == pinB) {
        jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, "encoder: pinos A e B nao podem ser o mesmo");
    }
    bool pullup = true;
    if (!duk_is_null_or_undefined(ctx, 2)) pullup = duk_require_boolean(ctx, 2) != 0;
    duk_push_int(ctx, Encoder::create(pinA, pinB, pullup));
    return 1;
}

duk_ret_t JSBindings::js_encoderRead(duk_context* ctx) {
    const int id = requireId(ctx, 0);
    int count = 0;
    if (!Encoder::read(id, &count)) {
        duk_push_null(ctx);
        return 1;
    }
    duk_push_int(ctx, count);
    return 1;
}

duk_ret_t JSBindings::js_encoderReset(duk_context* ctx) {
    const int id = requireId(ctx, 0);
    duk_push_boolean(ctx, Encoder::reset(id) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_encoderFree(duk_context* ctx) {
    const int id = requireId(ctx, 0);
    Encoder::free(id);
    duk_push_boolean(ctx, 1);
    return 1;
}

// Fim do app (init/exit): libera as unidades PCNT do app anterior.
void jsEncoderReset() { Encoder::resetAll(); }
