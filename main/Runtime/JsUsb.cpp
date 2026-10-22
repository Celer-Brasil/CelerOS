#include "JSBindings.h"
#include "JsInternal.h"
#include "JsFsJail.h"

#include "../Kernel/Core/CelerKernel.h"
#include "../USBHost/UsbHost.h"
#include "../Utils/AppPerms.h"

#include <stdlib.h>
#include <string.h>

// =====================================================
// USB (API 48): USB Host cru para drivers em JS
// =====================================================
//
// O firmware NAO conhece impressora/HID/pendrive: entrega devices,
// descritores e transfers. Bytes trafegam como ARRAY DE NUMEROS (0..255): o
// Duktape lean compilado aqui nao tem Uint8Array/ArrayBuffer. Teto de 4KB
// por transfer (maior so por sendFile, que le o arquivo no lado C++).
//
// Chamadas bloqueantes (control/out/in/sendFile) cedem o quadro no app e
// apenas renovam a janela do executor no svchost — present() a partir de um
// servico reentraria o pump.

namespace {

constexpr uint32_t kDefaultTimeoutMs = 250;
constexpr uint32_t kMaxTimeoutMs = 5000;

uint8_t requireU8(duk_context* ctx, duk_idx_t idx, const char* what) {
    const int v = duk_require_int(ctx, idx);
    if (v < 0 || v > 255) jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, what);
    return (uint8_t)v;
}

uint8_t requireAddr(duk_context* ctx, duk_idx_t idx) {
    const int v = duk_require_int(ctx, idx);
    if (v < 1 || v > 127) jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, "USB: device addr 1..127");
    return (uint8_t)v;
}

uint16_t requireU16(duk_context* ctx, duk_idx_t idx, const char* what) {
    const int v = duk_require_int(ctx, idx);
    if (v < 0 || v > 0xFFFF) jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, what);
    return (uint16_t)v;
}

uint32_t optTimeout(duk_context* ctx, duk_idx_t idx) {
    if (!duk_is_number(ctx, idx)) return kDefaultTimeoutMs;
    int v = duk_get_int(ctx, idx);
    if (v <= 0) return kDefaultTimeoutMs;
    if ((uint32_t)v > kMaxTimeoutMs) return kMaxTimeoutMs;
    return (uint32_t)v;
}

// Copia um array de bytes do JS (cada elemento 0..255).
size_t readBytes(duk_context* ctx, duk_idx_t idx, uint8_t* buf, size_t cap, const char* what) {
    if (!duk_is_array(ctx, idx)) jsThrowMsg(ctx, DUK_ERR_TYPE_ERROR, what);
    const duk_size_t n = duk_get_length(ctx, idx);
    if (n > cap) jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, what);
    for (duk_size_t i = 0; i < n; i++) {
        duk_get_prop_index(ctx, idx, (duk_uarridx_t)i);
        const int v = duk_get_int(ctx, -1);
        duk_pop(ctx);
        if (v < 0 || v > 255) jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, what);
        buf[i] = (uint8_t)v;
    }
    return (size_t)n;
}

void pushBytes(duk_context* ctx, const uint8_t* data, size_t n) {
    duk_push_array(ctx);
    for (size_t i = 0; i < n; i++) {
        duk_push_int(ctx, data[i]);
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)i);
    }
}

int pushResult(duk_context* ctx, const UsbHost::Result& r, bool withData, const uint8_t* data,
               size_t n) {
    duk_push_object(ctx);
    duk_push_boolean(ctx, r.ok ? 1 : 0);
    duk_put_prop_string(ctx, -2, "ok");
    duk_push_string(ctx, r.status);
    duk_put_prop_string(ctx, -2, "status");
    if (withData) {
        duk_push_int(ctx, (int)n);
        duk_put_prop_string(ctx, -2, "len");
        pushBytes(ctx, data, n);
        duk_put_prop_string(ctx, -2, "data");
    } else {
        duk_push_int(ctx, (int)r.transferred);
        duk_put_prop_string(ctx, -2, "sent");
    }
    return 1;
}

// Chamada que espera o URB: no app cede o quadro (jsBlocking); no svchost so
// renova a janela do executor.
template <typename F>
auto usbCall(F&& f) -> decltype(f()) {
    if (JSBindings::inService()) {
        auto r = f();
        CelerKernel::noteAppYield();
        return r;
    }
    return jsBlocking(f);
}

const char* owner() { return s_appPkg.c_str(); }

}  // namespace

duk_ret_t JSBindings::js_usbDevices(duk_context *ctx) {
    const int n = UsbHost::deviceCount();
    duk_push_array(ctx);
    for (int i = 0; i < n; i++) {
        UsbHost::DeviceInfo d;
        if (!UsbHost::deviceAt(i, d)) continue;

        duk_push_object(ctx);
        duk_push_int(ctx, d.addr);
        duk_put_prop_string(ctx, -2, "addr");
        duk_push_int(ctx, d.vid);
        duk_put_prop_string(ctx, -2, "vid");
        duk_push_int(ctx, d.pid);
        duk_put_prop_string(ctx, -2, "pid");
        duk_push_int(ctx, d.cls);
        duk_put_prop_string(ctx, -2, "cls");
        duk_push_int(ctx, d.subcls);
        duk_put_prop_string(ctx, -2, "subcls");
        duk_push_int(ctx, d.proto);
        duk_put_prop_string(ctx, -2, "proto");
        duk_push_int(ctx, d.speed);
        duk_put_prop_string(ctx, -2, "speed");

        duk_push_array(ctx);  // claimed: interfaces presas por algum dono
        for (int c = 0; c < d.nClaims; c++) {
            duk_push_int(ctx, d.claims[c].iface);
            duk_put_prop_index(ctx, -2, (duk_uarridx_t)c);
        }
        duk_put_prop_string(ctx, -2, "claimed");

        duk_push_array(ctx);  // ifs
        for (int f = 0; f < d.desc.nIfs; f++) {
            const usbdesc::IfDesc& in = d.desc.ifs[f];
            duk_push_object(ctx);
            duk_push_int(ctx, in.num);
            duk_put_prop_string(ctx, -2, "n");
            duk_push_int(ctx, in.alt);
            duk_put_prop_string(ctx, -2, "alt");
            duk_push_int(ctx, in.cls);
            duk_put_prop_string(ctx, -2, "cls");
            duk_push_int(ctx, in.subcls);
            duk_put_prop_string(ctx, -2, "subcls");
            duk_push_int(ctx, in.proto);
            duk_put_prop_string(ctx, -2, "proto");
            duk_push_array(ctx);  // eps
            for (int e = 0; e < in.nEps; e++) {
                const usbdesc::EpDesc& ep = in.eps[e];
                duk_push_object(ctx);
                duk_push_int(ctx, ep.addr);
                duk_put_prop_string(ctx, -2, "addr");
                duk_push_int(ctx, ep.type);
                duk_put_prop_string(ctx, -2, "type");
                duk_push_int(ctx, ep.mps);
                duk_put_prop_string(ctx, -2, "mps");
                duk_push_int(ctx, ep.interval);
                duk_put_prop_string(ctx, -2, "ivl");
                duk_put_prop_index(ctx, -2, (duk_uarridx_t)e);
            }
            duk_put_prop_string(ctx, -2, "eps");
            duk_put_prop_index(ctx, -2, (duk_uarridx_t)f);
        }
        duk_put_prop_string(ctx, -2, "ifs");
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)i);
    }
    return 1;
}

duk_ret_t JSBindings::js_usbPoll(duk_context *ctx) {
    UsbHost::Event ev;
    if (!UsbHost::pollEvent(ev)) {
        duk_push_null(ctx);
        return 1;
    }
    duk_push_object(ctx);
    duk_push_string(ctx, ev.type == UsbHost::kEventAdd ? "add" : "remove");
    duk_put_prop_string(ctx, -2, "type");
    duk_push_int(ctx, ev.addr);
    duk_put_prop_string(ctx, -2, "addr");
    duk_push_int(ctx, ev.vid);
    duk_put_prop_string(ctx, -2, "vid");
    duk_push_int(ctx, ev.pid);
    duk_put_prop_string(ctx, -2, "pid");
    return 1;
}

duk_ret_t JSBindings::js_usbClaim(duk_context *ctx) {
    const uint8_t addr = requireAddr(ctx, 0);
    const uint8_t iface = requireU8(ctx, 1, "USB.claim: interface 0..255");
    uint8_t alt = 0;
    if (duk_is_number(ctx, 2)) alt = requireU8(ctx, 2, "USB.claim: alternate 0..255");
    duk_push_boolean(ctx, UsbHost::claim(owner(), addr, iface, alt) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_usbRelease(duk_context *ctx) {
    const uint8_t addr = requireAddr(ctx, 0);
    const uint8_t iface = requireU8(ctx, 1, "USB.release: interface 0..255");
    duk_push_boolean(ctx, UsbHost::release(owner(), addr, iface) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_usbControlIn(duk_context *ctx) {
    const uint8_t addr = requireAddr(ctx, 0);
    const uint8_t type = requireU8(ctx, 1, "USB.controlIn: bmRequestType 0..255");
    const uint8_t req = requireU8(ctx, 2, "USB.controlIn: bRequest 0..255");
    const uint16_t val = requireU16(ctx, 3, "USB.controlIn: wValue 0..65535");
    const uint16_t idx = requireU16(ctx, 4, "USB.controlIn: wIndex 0..65535");
    const int len = duk_require_int(ctx, 5);
    if (len < 0 || (size_t)len > UsbHost::kMaxControl) {
        jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, "USB.controlIn: len acima do limite");
    }
    const uint32_t timeout = optTimeout(ctx, 6);
    uint8_t* buf = (uint8_t*)malloc((size_t)len > 0 ? (size_t)len : 1);
    if (buf == nullptr) jsThrowMsg(ctx, DUK_ERR_ERROR, "USB.controlIn: sem RAM");

    UsbHost::Result r = usbCall([&] {
        return UsbHost::controlIn(addr, type, req, val, idx, buf, (size_t)len, timeout);
    });
    pushResult(ctx, r, true, buf, r.transferred);
    free(buf);
    return 1;
}

duk_ret_t JSBindings::js_usbControlOut(duk_context *ctx) {
    const uint8_t addr = requireAddr(ctx, 0);
    const uint8_t type = requireU8(ctx, 1, "USB.controlOut: bmRequestType 0..255");
    const uint8_t req = requireU8(ctx, 2, "USB.controlOut: bRequest 0..255");
    const uint16_t val = requireU16(ctx, 3, "USB.controlOut: wValue 0..65535");
    const uint16_t idx = requireU16(ctx, 4, "USB.controlOut: wIndex 0..65535");
    uint8_t* buf = (uint8_t*)malloc(UsbHost::kMaxControl);
    if (buf == nullptr) jsThrowMsg(ctx, DUK_ERR_ERROR, "USB.controlOut: sem RAM");
    const size_t len = readBytes(ctx, 5, buf, UsbHost::kMaxControl, "USB.controlOut: data 0..255");
    const uint32_t timeout = optTimeout(ctx, 6);
    UsbHost::Result r = usbCall([&] {
        return UsbHost::controlOut(addr, type, req, val, idx, buf, len, timeout);
    });
    free(buf);
    pushResult(ctx, r, false, nullptr, 0);
    return 1;
}

duk_ret_t JSBindings::js_usbOut(duk_context *ctx) {
    const uint8_t addr = requireAddr(ctx, 0);
    const uint8_t ep = requireU8(ctx, 1, "USB.out: endpoint 0..255");
    if ((ep & 0x80) != 0) jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, "USB.out: endpoint IN (use USB.in)");
    uint8_t* buf = (uint8_t*)malloc(UsbHost::kMaxTransfer);
    if (buf == nullptr) jsThrowMsg(ctx, DUK_ERR_ERROR, "USB.out: sem RAM");
    const size_t len = readBytes(ctx, 2, buf, UsbHost::kMaxTransfer, "USB.out: data 0..255");
    const uint32_t timeout = optTimeout(ctx, 3);
    UsbHost::Result r = usbCall([&] { return UsbHost::out(addr, ep, buf, len, timeout); });
    free(buf);
    pushResult(ctx, r, false, nullptr, 0);
    return 1;
}

duk_ret_t JSBindings::js_usbIn(duk_context *ctx) {
    const uint8_t addr = requireAddr(ctx, 0);
    const uint8_t ep = requireU8(ctx, 1, "USB.in: endpoint 0..255");
    if ((ep & 0x80) == 0) jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, "USB.in: endpoint OUT (use USB.out)");
    const int len = duk_require_int(ctx, 2);
    if (len <= 0 || (size_t)len > UsbHost::kMaxTransfer) {
        jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, "USB.in: len fora do limite");
    }
    const uint32_t timeout = optTimeout(ctx, 3);
    uint8_t* buf = (uint8_t*)malloc((size_t)len);
    if (buf == nullptr) jsThrowMsg(ctx, DUK_ERR_ERROR, "USB.in: sem RAM");
    UsbHost::Result r = usbCall([&] {
        return UsbHost::in(addr, ep, buf, (size_t)len, timeout);
    });
    pushResult(ctx, r, true, buf, r.transferred);
    free(buf);
    return 1;
}

duk_ret_t JSBindings::js_usbSendFile(duk_context *ctx) {
    const uint8_t addr = requireAddr(ctx, 0);
    const uint8_t ep = requireU8(ctx, 1, "USB.sendFile: endpoint 0..255");
    const char* path = duk_require_string(ctx, 2);
    if (!perm(celer::PERM_FS)) {
        jsThrowMsg(ctx, DUK_ERR_ERROR, "USB.sendFile: requer permissao \"fs\"");  // lint-perm: fs
    }
    if (!fsPathAllowed(path)) {
        jsThrowMsg(ctx, DUK_ERR_ERROR, "USB.sendFile: caminho negado");  // lint-perm: fs
    }
    if (strlen(path) > kJsPathMax) {
        jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, "USB.sendFile: caminho longo demais");
    }
    size_t maxBytes = UsbHost::kMaxFileJob;
    if (duk_is_number(ctx, 3)) {
        const int v = duk_get_int(ctx, 3);
        if (v > 0) maxBytes = (size_t)v;
    }
    const uint32_t timeout = optTimeout(ctx, 4);
    UsbHost::Result r = usbCall([&] {
        return UsbHost::sendFile(addr, ep, path, maxBytes, timeout);
    });
    pushResult(ctx, r, false, nullptr, 0);
    return 1;
}

duk_ret_t JSBindings::js_usbListen(duk_context *ctx) {
    const uint8_t addr = requireAddr(ctx, 0);
    const uint8_t ep = requireU8(ctx, 1, "USB.listen: endpoint 0..255");
    const int len = duk_require_int(ctx, 2);
    if (len <= 0 || (size_t)len > UsbHost::kMaxListenLen) {
        jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, "USB.listen: len 1..256");
    }
    uint8_t depth = 4;
    if (duk_is_number(ctx, 3)) depth = requireU8(ctx, 3, "USB.listen: depth 1..8");
    duk_push_boolean(ctx, UsbHost::listen(owner(), addr, ep, (uint16_t)len, depth) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_usbRead(duk_context *ctx) {
    const uint8_t addr = requireAddr(ctx, 0);
    const uint8_t ep = requireU8(ctx, 1, "USB.read: endpoint 0..255");
    uint8_t buf[UsbHost::kMaxListenLen];
    const int n = UsbHost::read(addr, ep, buf, sizeof(buf));
    if (n <= 0) {
        duk_push_null(ctx);
        return 1;
    }
    pushBytes(ctx, buf, (size_t)n);
    return 1;
}

duk_ret_t JSBindings::js_usbUnlisten(duk_context *ctx) {
    const uint8_t addr = requireAddr(ctx, 0);
    const uint8_t ep = requireU8(ctx, 1, "USB.unlisten: endpoint 0..255");
    duk_push_boolean(ctx, UsbHost::unlisten(addr, ep) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_usbFlush(duk_context *ctx) {
    const uint8_t addr = requireAddr(ctx, 0);
    const uint8_t ep = requireU8(ctx, 1, "USB.flush: endpoint 0..255");
    duk_push_boolean(ctx, UsbHost::flush(addr, ep) ? 1 : 0);
    return 1;
}

// Saida do app: solta interfaces e listeners DELE (o registry de devices e
// do SO e segue vivo; o servico HID nao perde o teclado).
void JSBindings::usbAppReset() {
    UsbHost::releaseOwner(s_appPkg.c_str());
}
