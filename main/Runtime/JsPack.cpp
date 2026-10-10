#include "JSBindings.h"
#include "JsInternal.h"
#include "../Bluetooth/CelerNet.h"
#include "../Bluetooth/NetFrame.h"
#include "../Kernel/Core/CelerKernel.h"
#include "../Pack/Pack.h"

#include <stdio.h>
#include <string.h>

// =====================================================
// Pack Bindings (matilha, API 27)
//
// Objeto global Pack: a SEMANTICA da malha por cima do transporte
// CelerNet — membros com o papel de cada um (caps do BEAT), envelopes
// custom unicast (dedup por msgId no firmware) e o handoff da musica em
// curso (a festa chiptune continua no vizinho com alto-falante, do mesmo
// ponto). Nada bloqueia; o handoff devolve false se nao ha musica
// tocando, malha desligada ou vizinho sem speaker.
// =====================================================

namespace {
// caps num bitmask -> {speaker, mic, display, motors, leds, hub}
void pushCaps(duk_context* ctx, uint8_t caps) {
    duk_push_object(ctx);
    putBool(ctx, "speaker", (caps & netframe::CAPS_SPEAKER));
    putBool(ctx, "mic", (caps & netframe::CAPS_MIC));
    putBool(ctx, "display", (caps & netframe::CAPS_DISPLAY));
    putBool(ctx, "motors", (caps & netframe::CAPS_MOTORS));
    putBool(ctx, "leds", (caps & netframe::CAPS_LEDS));
    putBool(ctx, "hub", (caps & netframe::CAPS_HUB));
    putBool(ctx, "camera", (caps & netframe::CAPS_CAMERA));
}
}  // namespace

duk_ret_t JSBindings::js_packMe(duk_context *ctx) {
    CelerNet::Info st;
    CelerNet::info(&st);
    duk_push_object(ctx);
    putNodeId(ctx, "id", st.node);
    putStr(ctx, "name", st.name);
    pushCaps(ctx, Pack::myCaps());
    duk_put_prop_string(ctx, -2, "caps");
    putBool(ctx, "meshActive", st.active);
    return 1;
}

duk_ret_t JSBindings::js_packMembers(duk_context *ctx) {
    Pack::Member list[CelerNet::NODES_MAX];
    int n = Pack::members(list, CelerNet::NODES_MAX);
    duk_push_array(ctx);
    for (int i = 0; i < n; i++) {
        duk_push_object(ctx);
        putNodeId(ctx, "id", list[i].id);
        putStr(ctx, "name", list[i].name);
        pushCaps(ctx, list[i].caps);
        duk_put_prop_string(ctx, -2, "caps");
        putInt(ctx, "rssi", list[i].rssi);
        putInt(ctx, "hops", list[i].hops);
        putUint(ctx, "lastSeen", list[i].lastSeenMs / 1000);
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)i);
    }
    return 1;
}

duk_ret_t JSBindings::js_packSend(duk_context *ctx) {
    const char* to = duk_require_string(ctx, 0);
    uint16_t dst = 0;
    // Destino sumido devolve FALSE (nao throw): a presenca na malha oscila
    // por natureza e um app de radio movel nao pode morrer porque o vizinho
    // saiu da tabela no instante do send — mesmo contrato do stub do
    // harness e do CelerNet.broadcast com a malha desligada.
    if (!CelerNet::resolveDest(to, &dst)) {
        duk_push_false(ctx);
        return 1;
    }
    uint8_t buf[Pack::MAX_PAYLOAD];
    size_t len;
    jsMsgBytes(ctx, 1, buf, Pack::MAX_PAYLOAD, "envelope", &len);
    bool urgent = false;
    if (duk_is_object(ctx, 2) && !duk_is_callable(ctx, 2)) {
        duk_get_prop_string(ctx, 2, "urgent");
        if (duk_is_boolean(ctx, -1)) urgent = duk_get_boolean(ctx, -1) != 0;
        duk_pop(ctx);
    }
    duk_push_boolean(ctx, Pack::send(dst, Pack::KIND_CUSTOM, buf, len, urgent) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_packPoll(duk_context *ctx) {
    uint16_t from = 0;
    char fromName[16];
    uint8_t data[Pack::MAX_PAYLOAD];
    size_t len = sizeof(data);
    if (!Pack::pollCustom(&from, fromName, sizeof(fromName), data, &len)) {
        duk_push_null(ctx);
        return 1;
    }
    duk_push_object(ctx);
    putNodeId(ctx, "from", from);
    putStr(ctx, "fromName", fromName);
    putLStr(ctx, "data", (const char*)data, (duk_size_t)len);
    return 1;
}

duk_ret_t JSBindings::js_packHandoffMusic(duk_context *ctx) {
    uint16_t to = 0;
    if (!duk_is_null_or_undefined(ctx, 0)) {
        const char* dest = duk_require_string(ctx, 0);
        // destino sumido = false (sem throw), como o resto da API de rede
        if (!CelerNet::resolveDest(dest, &to)) {
            duk_push_false(ctx);
            return 1;
        }
    }
    // o envio drena a fila da malha: da chance ao tick antes do handoff
    bool ok = jsBlocking([&] { return Pack::handoffMusic(to); });
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}
