#include "JSBindings.h"
#include "JsInternal.h"

#include "../Bluetooth/BleHid.h"
#include "../Kernel/Core/CelerKernel.h"
#include "../Utils/AppPerms.h"

#include <stdlib.h>
#include <string.h>
#include "esp_task_wdt.h"

// =====================================================
// BT (API 57): gamepad Bluetooth LE HID cru (placas com CELEROS_BLE_HID)
// =====================================================
//
// O firmware NAO conhece gamepad: entrega devices do scan, o Report Map
// cru (o descriptor HID que a dep JS celeros.gamepad faz o parser), a
// lista de reports (id/tipo do Report Reference) e os reports de entrada
// crus. Bytes trafegam como ARRAY DE NUMEROS (0..255): o Duktape lean
// compilado aqui nao tem Uint8Array/ArrayBuffer. Teto de 64 bytes por
// report (HOGP nao passa disso na pratica).
//
// Chamadas bloqueantes (scan/connect/write) cedem o quadro no app e apenas
// renovam a janela do executor no svchost — present() a partir de um
// servico reentraria o pump.

namespace {

constexpr size_t kMaxReport = BleHid::MAX_REPORT;  // 64 bytes

// Validacao SEM buffer: valida tipo/teto/0..255 ANTES de qualquer malloc
// (um erro depois do malloc vazaria o buffer — longjmp pula o free).
void validateBytes(duk_context* ctx, duk_idx_t idx, size_t cap, const char* what) {
    if (!duk_is_array(ctx, idx)) jsThrowMsg(ctx, DUK_ERR_TYPE_ERROR, what);
    const duk_size_t n = duk_get_length(ctx, idx);
    if (n > cap) jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, what);
    for (duk_size_t i = 0; i < n; i++) {
        duk_get_prop_index(ctx, idx, (duk_uarridx_t)i);
        const int v = duk_get_int(ctx, -1);
        duk_pop(ctx);
        if (v < 0 || v > 255) jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, what);
    }
}

void pushBytes(duk_context* ctx, const uint8_t* data, size_t n) {
    duk_push_array(ctx);
    for (size_t i = 0; i < n; i++) {
        duk_push_int(ctx, data[i]);
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)i);
    }
}

// Entrada de chamada bloqueante: o present() roda timers/AI e um erro de
// callback longjmpa para fora do binding — o que pode lancar vem antes.
// No svchost so alimenta o TWDT (o present reentraria o pump do app).
void btEnter() {
    if (JSBindings::inService()) esp_task_wdt_reset();
    else JSBindings::present();
}

// Chamada que espera o radio: renova a janela do executor no retorno (o
// scan pode esperar o prazo inteiro sem outro ponto de cedida).
template <typename F>
auto btCall(F&& f) -> decltype(f()) {
    auto r = f();
    CelerKernel::noteAppYield();
    return r;
}

const char* phaseStr(const char* p) { return p; }

}  // namespace

duk_ret_t JSBindings::js_btScan(duk_context *ctx) {
    uint32_t ms = 2500;
    if (duk_is_number(ctx, 0)) {
        int v = duk_get_int(ctx, 0);
        if (v > 0) ms = (uint32_t)v;
    }
    btEnter();  // scan bloqueia ate ms: cede o quadro antes
    duk_push_boolean(ctx, btCall([&] { return BleHid::scan(ms); }) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_btScanResults(duk_context *ctx) {
    BleHid::Peer peers[BleHid::MAX_PEERS];
    const int n = BleHid::scanResults(peers, BleHid::MAX_PEERS);
    duk_push_array(ctx);
    for (int i = 0; i < n; i++) {
        duk_push_object(ctx);
        duk_push_string(ctx, peers[i].id);
        duk_put_prop_string(ctx, -2, "addr");
        duk_push_int(ctx, peers[i].addrType);
        duk_put_prop_string(ctx, -2, "addrType");
        duk_push_string(ctx, peers[i].name);
        duk_put_prop_string(ctx, -2, "name");
        duk_push_int(ctx, peers[i].rssi);
        duk_put_prop_string(ctx, -2, "rssi");
        duk_push_int(ctx, peers[i].appearance);
        duk_put_prop_string(ctx, -2, "appearance");
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)i);
    }
    return 1;
}

duk_ret_t JSBindings::js_btConnect(duk_context *ctx) {
    const char* id = duk_require_string(ctx, 0);
    btEnter();  // conexao + pareamento + descoberta: cede o quadro antes
    const bool ok = btCall([&] { return BleHid::connect(id, 0); });
    duk_push_object(ctx);
    duk_push_boolean(ctx, ok ? 1 : 0);
    duk_put_prop_string(ctx, -2, "ok");
    if (!ok) {
        BleHid::Info info;
        BleHid::info(&info);
        duk_push_string(ctx, info.err);
        duk_put_prop_string(ctx, -2, "err");
    }
    return 1;
}

duk_ret_t JSBindings::js_btDisconnect(duk_context *ctx) {
    duk_push_boolean(ctx, BleHid::disconnect() ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_btState(duk_context *ctx) {
    BleHid::Info info;
    BleHid::info(&info);
    duk_push_object(ctx);
    duk_push_string(ctx, phaseStr(info.phase));
    duk_put_prop_string(ctx, -2, "phase");
    duk_push_string(ctx, info.addr);
    duk_put_prop_string(ctx, -2, "addr");
    duk_push_string(ctx, info.name);
    duk_put_prop_string(ctx, -2, "name");
    duk_push_int(ctx, info.rssi);
    duk_put_prop_string(ctx, -2, "rssi");
    duk_push_int(ctx, info.battery);
    duk_put_prop_string(ctx, -2, "battery");
    duk_push_int(ctx, info.mtu);
    duk_put_prop_string(ctx, -2, "mtu");
    duk_push_int(ctx, (int)info.queued);
    duk_put_prop_string(ctx, -2, "queued");
    duk_push_uint(ctx, info.dropped);
    duk_put_prop_string(ctx, -2, "dropped");
    duk_push_string(ctx, info.err);
    duk_put_prop_string(ctx, -2, "err");
    duk_push_array(ctx);
    for (int i = 0; i < info.nReports; i++) {
        duk_push_object(ctx);
        duk_push_int(ctx, info.reports[i].id);
        duk_put_prop_string(ctx, -2, "id");
        duk_push_int(ctx, info.reports[i].type);
        duk_put_prop_string(ctx, -2, "type");
        duk_push_int(ctx, info.reports[i].size);
        duk_put_prop_string(ctx, -2, "size");
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)i);
    }
    duk_put_prop_string(ctx, -2, "reports");
    return 1;
}

duk_ret_t JSBindings::js_btReportMap(duk_context *ctx) {
    uint8_t buf[BleHid::MAX_MAP];
    const size_t n = BleHid::reportMap(buf, sizeof(buf));
    if (n == 0) {
        duk_push_null(ctx);
        return 1;
    }
    pushBytes(ctx, buf, n);
    return 1;
}

duk_ret_t JSBindings::js_btRead(duk_context *ctx) {
    uint8_t id = 0;
    uint8_t buf[BleHid::MAX_REPORT];
    size_t len = 0;
    if (!BleHid::poll(&id, buf, sizeof(buf), &len)) {
        duk_push_null(ctx);
        return 1;
    }
    duk_push_object(ctx);
    duk_push_int(ctx, id);
    duk_put_prop_string(ctx, -2, "id");
    pushBytes(ctx, buf, len);
    duk_put_prop_string(ctx, -2, "data");
    return 1;
}

duk_ret_t JSBindings::js_btWrite(duk_context *ctx) {
    // valida ANTES de ceder o quadro: bytes sao o payload do report de
    // output JA COM o report id no byte 0 quando o pad usa ids
    validateBytes(ctx, 0, kMaxReport, "BT.write: data 0..255");
    btEnter();
    uint8_t buf[kMaxReport];
    const duk_size_t n = duk_get_length(ctx, 0);
    for (duk_size_t i = 0; i < n; i++) {
        duk_get_prop_index(ctx, 0, (duk_uarridx_t)i);
        buf[i] = (uint8_t)duk_get_int(ctx, -1);
        duk_pop(ctx);
    }
    const bool ok = btCall([&] { return BleHid::write(buf, (size_t)n); });
    duk_push_object(ctx);
    duk_push_boolean(ctx, ok ? 1 : 0);
    duk_put_prop_string(ctx, -2, "ok");
    if (ok) {
        duk_push_int(ctx, (int)n);
        duk_put_prop_string(ctx, -2, "sent");
    } else {
        duk_push_string(ctx, "output indisponivel ou pad sem enlace");
        duk_put_prop_string(ctx, -2, "err");
    }
    return 1;
}

duk_ret_t JSBindings::js_btPaired(duk_context *ctx) {
    BleHid::Peer peers[BleHid::MAX_PEERS];
    const int n = BleHid::paired(peers, BleHid::MAX_PEERS);
    duk_push_array(ctx);
    for (int i = 0; i < n; i++) {
        duk_push_object(ctx);
        duk_push_string(ctx, peers[i].id);
        duk_put_prop_string(ctx, -2, "addr");
        duk_push_int(ctx, peers[i].addrType);
        duk_put_prop_string(ctx, -2, "addrType");
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)i);
    }
    return 1;
}

duk_ret_t JSBindings::js_btForget(duk_context *ctx) {
    const char* id = nullptr;
    if (!duk_is_undefined(ctx, 0)) {
        id = duk_require_string(ctx, 0);
    }
    duk_push_boolean(ctx, BleHid::forget(id) ? 1 : 0);
    return 1;
}

// Saida do app: limpa a fila de reports e o cache do scan (o ENLACE do pad
// segue vivo — trocar de app nao derruba o controle).
void JSBindings::btAppReset() {
    BleHid::appReset();
}
