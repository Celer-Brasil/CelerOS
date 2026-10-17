#include "JSBindings.h"
#include "../USBDevice/LogSink.h"
#include "../Display/Layout.h"
#include "../FileSystem/FileSystem.h"
#include "../UI/Keyboard.h"
#include "../Boards/Board.h"
#include "../WebManager/WebManager.h"
#include "../WebManager/WebAuth.h"
#include "../Kernel/TimeManager.h"
#include "../Utils/StrUtils.h"
#include "../Utils/PinStore.h"
#include "HttpClient.h"
#include "SystemInfo.h"
#include "esp_rom_md5.h"
#include "../Display/Backlight.h"
#include "../Display/Theme.h"
#include "../Display/Icon.h"
#include "../OTA/OtaManager.h"
#include "../Launcher/LauncherUI.h"
#include "../Launcher/Screens.h"
#include <lgfx/v1/misc/DataWrapper.hpp>
#include "JsInternal.h"
#include "../Hardware/BoardIO.h"
#include "esp_task_wdt.h"
#include "driver/gpio.h"
#include "esp_private/esp_gpio_reserve.h"

// =====================================================
// GPIO Bindings
// =====================================================

// Pino invalido ou reservado pelo sistema (flash/PSRAM — o IDF reserva no
// boot): RangeError legivel. Antes pinMode(-1) era shift indefinido e
// mexer num pino da flash/PSRAM derrubava o aparelho.
// Pinos que ja passaram por aqui: o IDF 6 RESERVA o GPIO quando o proprio
// runtime liga PWM/RMT nele (ledc_channel_config -> esp_gpio_reserve), entao
// o 2o servo()/analogWrite()/neopixel no MESMO pino caia no "reservado" — o
// Dog Face parava na primeira passada com "GPIO 17 invalido". Reserva feita
// por nos nao conta; a do boot (flash/PSRAM) segue barrando.
static uint64_t s_jsPins = 0;

static int requirePin(duk_context *ctx, duk_idx_t idx, bool output) {
    int pin = duk_require_int(ctx, idx);
    const bool valid = output ? GPIO_IS_VALID_OUTPUT_GPIO(pin) : GPIO_IS_VALID_GPIO(pin);
    // gpioDeniedMask do perfil cobre o que o esp_gpio_is_reserved nao sabe
    // (linhas DQ4..7/DQS da PSRAM octal do S3: um PWM ali corrompe o heap
    // que vive na PSRAM). Guarda do shift: pin fora de 0..63 e UB.
    const bool inRange = valid && pin >= 0 && pin < 64;
    const uint64_t bit = inRange ? (1ULL << pin) : 0;
    if (!inRange || (!(s_jsPins & bit) && esp_gpio_is_reserved(bit)) ||
        (Board::profile().gpioDeniedMask & bit)) {
        // Mensagem PRE-FORMATADA e duk_error SEM argumentos de conversao:
        // throw com %d a partir de um lightfunc corrompe o heap do runtime
        // (repro: try{pinMode(99,OUT)}catch(e){} derrubava o aparelho;
        // throws sem args e os das macros duk_require_* sao estaveis —
        // bancada 2026-10-02)
        char msg[64];
        snprintf(msg, sizeof(msg), "GPIO %d invalido ou reservado pelo sistema", pin);
        duk_error(ctx, DUK_ERR_RANGE_ERROR, msg);
    }
    s_jsPins |= bit;
    return pin;
}

duk_ret_t JSBindings::js_pinMode(duk_context *ctx) {
    int pin = requirePin(ctx, 0, false);
    int mode = duk_require_int(ctx, 1);
    pinMode(pin, mode);
    return 0;
}

duk_ret_t JSBindings::js_digitalWrite(duk_context *ctx) {
    int pin = requirePin(ctx, 0, true);
    int val = duk_require_int(ctx, 1);
    digitalWrite(pin, val);
    return 0;
}

duk_ret_t JSBindings::js_digitalRead(duk_context *ctx) {
    int pin = requirePin(ctx, 0, false);
    int val = digitalRead(pin);
    duk_push_int(ctx, val);
    return 1;
}

duk_ret_t JSBindings::js_analogRead(duk_context *ctx) {
    int pin = requirePin(ctx, 0, false);
    int val = analogRead(pin);
    duk_push_int(ctx, val);
    return 1;
}

duk_ret_t JSBindings::js_analogWrite(duk_context *ctx) {
    int pin = requirePin(ctx, 0, true);
    int val = duk_require_int(ctx, 1);
    analogWrite(pin, val);
    return 0;
}

duk_ret_t JSBindings::js_pulseIn(duk_context *ctx) {
    int pin = requirePin(ctx, 0, false);
    int state = duk_require_int(ctx, 1);
    unsigned long timeout = 1000000L; // default 1 second timeout
    // lightfunc: arg omitido chega como undefined (duk_get_top e sempre 3 —
    // pulseIn(pin, state) lancava TypeError)
    if (!duk_is_null_or_undefined(ctx, 2)) {
        timeout = duk_require_uint(ctx, 2);
    }
    // espera ocupada sem ceder: teto de 1 s (um timeout enorme prendia a CPU
    // ate o watchdog reiniciar o aparelho)
    if (timeout > 1000000UL) timeout = 1000000UL;
    // espera de ate 1 s e NATIVA: present antes (quadro do app) e
    // noteAppYield no retorno — sem isso a janela do exec-timeout vencia e o
    // RangeError matava o app logo depois de medir o pulso
    unsigned long duration = jsBlocking([&] {
        esp_task_wdt_reset();
        return pulseIn(pin, state, timeout);
    });
    duk_push_uint(ctx, duration);
    return 1;
}

// ---- servos (API 10): PWM 50 Hz por LEDC ----
// Alocacao de canal/timer no BoardIO (mapa LEDC unico do firmware).

// System.gpio.servo(pin, angulo) -> bool. Angulo 0..180 vira pulso de
// 500..2500 us (convencao 9g/SG90); aceita fracao (rampas suaves).
duk_ret_t JSBindings::js_servo(duk_context *ctx) {
    int pin = requirePin(ctx, 0, true);
    double angle = duk_require_number(ctx, 1);
    if (!(angle >= 0)) angle = 0;  // NaN tambem
    if (angle > 180) angle = 180;
    duk_push_boolean(ctx, BoardIO::servoWrite(pin, (int)(500 + angle * 2000.0 / 180.0 + 0.5)) ? 1 : 0);
    return 1;
}

// System.gpio.servoOff(pin) -> bool. Para o PWM e libera o canal (o servo
// fica solto, sem forca).
duk_ret_t JSBindings::js_servoOff(duk_context *ctx) {
    duk_push_boolean(ctx, BoardIO::servoOff(duk_require_int(ctx, 0)) ? 1 : 0);
    return 1;
}
