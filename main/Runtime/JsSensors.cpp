// Sensors.* (API 13) — leitura do IMU da placa (hooks BoardProfile::imu*,
// hoje so o watch Waveshare: QMI8658). Leituras abertas (sem permissao):
// sao sensores do proprio aparelho, no padrao dos demais (bateria, luz).

#include "JSBindings.h"
#include "JsInternal.h"
#include "../Boards/Board.h"

duk_ret_t JSBindings::js_sensorsAccel(duk_context* ctx) {
    const BoardProfile& bp = Board::profile();
    if (bp.imuAccel == nullptr) {
        duk_push_null(ctx);
        return 1;
    }
    float x = 0, y = 0, z = 0;
    if (!bp.imuAccel(&x, &y, &z)) {
        duk_push_null(ctx);
        return 1;
    }
    duk_push_object(ctx);
    putNum(ctx, "x", x);
    putNum(ctx, "y", y);
    putNum(ctx, "z", z);
    return 1;
}

duk_ret_t JSBindings::js_sensorsSteps(duk_context* ctx) {
    const BoardProfile& bp = Board::profile();
    if (bp.imuSteps == nullptr) {
        duk_push_int(ctx, -1);
        return 1;
    }
    duk_push_int(ctx, (duk_int_t)bp.imuSteps());
    return 1;
}

duk_ret_t JSBindings::js_sensorsTemp(duk_context* ctx) {
    const BoardProfile& bp = Board::profile();
    float c = 0;
    if (bp.imuTemp == nullptr || !bp.imuTemp(&c)) {
        duk_push_number(ctx, -255);   // sem sensor (bateria/IMU ausente)
        return 1;
    }
    duk_push_number(ctx, c);
    return 1;
}

// Sensors.stepHistory() -> [{date: yyyymmdd, steps: n}, ...] (API 15): dias
// FECHADOS, mais recente primeiro (ate 7); [] sem IMU ou sem historico.
duk_ret_t JSBindings::js_sensorsStepHistory(duk_context* ctx) {
    const BoardProfile& bp = Board::profile();
    int32_t days[7];
    int32_t counts[7];
    int n = bp.imuStepHistory ? bp.imuStepHistory(days, counts, 7) : 0;
    // contrato do hook e <= 7; um perfil defeituoso nao pode estourar as
    // pilhas acima na leitura
    if (n < 0) n = 0;
    if (n > 7) n = 7;
    duk_idx_t arr = duk_push_array(ctx);
    for (int i = 0; i < n; i++) {
        duk_push_object(ctx);
        putInt(ctx, "date", (duk_int_t)days[i]);
        putInt(ctx, "steps", (duk_int_t)counts[i]);
        duk_put_prop_index(ctx, arr, (duk_uarridx_t)i);
    }
    return 1;
}
