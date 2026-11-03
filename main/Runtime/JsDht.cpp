#include "JSBindings.h"

#include "../Boards/Board.h"
#include "../Hardware/Dht.h"
#include "JsInternal.h"
#include "driver/gpio.h"
#include "esp_private/esp_gpio_reserve.h"

#include <cstdio>

// ============================================================================
// System.dht (API 55) — DHT11/DHT22 nativo.
//
// System.dht.read(pin, [tipo]) -> {ok, temp, humidity, error}
//
// O protocolo e de microssegundos (janela critica no C++); o app so recebe
// os valores. O driver cacheia por 1 s (DHT11) / 2 s (DHT22) — chamar em
// loop nao martela o sensor. Mesma permissao do System.gpio ("gpio").
// ============================================================================

namespace {

int requirePin(duk_context* ctx, duk_idx_t idx) {
    const int pin = duk_require_int(ctx, idx);
    const bool valid = pin >= 0 && pin < 64 && GPIO_IS_VALID_OUTPUT_GPIO(pin);
    const uint64_t bit = valid ? (1ULL << pin) : 0;
    if (!valid || esp_gpio_is_reserved(bit) || (Board::profile().gpioDeniedMask & bit)) {
        char msg[64];
        snprintf(msg, sizeof(msg), "GPIO %d invalido para DHT", pin);
        jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, msg);
    }
    return pin;
}

}  // namespace

duk_ret_t JSBindings::js_dhtRead(duk_context* ctx) {
    const int pin = requirePin(ctx, 0);
    int type = 22;
    if (!duk_is_null_or_undefined(ctx, 1)) type = duk_require_int(ctx, 1);
    if (type != 11 && type != 22) {
        jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, "DHT: tipo deve ser 11 ou 22");
    }

    Dht::Reading r;
    Dht::read(pin, type, &r);
    // A leitura bloqueia ~20 ms (start + 40 bits): renova a janela do
    // executor para o retorno nao cair no timeout de 1 s.
    CelerKernel::noteAppYield();

    duk_push_object(ctx);
    duk_push_boolean(ctx, r.ok ? 1 : 0);
    duk_put_prop_string(ctx, -2, "ok");
    duk_push_number(ctx, r.tempC);
    duk_put_prop_string(ctx, -2, "temp");
    duk_push_number(ctx, r.humidity);
    duk_put_prop_string(ctx, -2, "humidity");
    duk_push_string(ctx, r.error != nullptr ? r.error : "");
    duk_put_prop_string(ctx, -2, "error");
    return 1;
}

// Fim do app: descarta a leitura cacheada do app anterior.
void jsDhtReset() { Dht::reset(); }
