#include "JSBindings.h"
#include "JsInternal.h"
#include "../Bluetooth/CelerNet.h"
#include "../Kernel/Core/CelerKernel.h"

// =====================================================
// CelerNet Bindings (malha BLE por flood de advertising, API 26)
//
// Objeto global CelerNet: start/stop (liga o no; persiste no
// setting), broadcast (mensagem para TODA a rede, saltos por TTL),
// poll (mensagens que chegaram, com origem e saltos), nodes
// (presenca: nos ouvidos recentemente) e status. Nenhuma chamada
// bloqueia (a maquina de radio roda no servico ALWAYS) — exceto a
// 1a start, que pode subir o NimBLE (~300 ms).
// =====================================================

duk_ret_t JSBindings::js_meshStart(duk_context *ctx) {
    const char* name = optStr(ctx, 0, "name", nullptr);
    const char* net = optStr(ctx, 0, "net", nullptr);
    bool relay = true;
    if (duk_is_object(ctx, 0) && !duk_is_callable(ctx, 0)) {
        duk_get_prop_string(ctx, 0, "relay");
        if (duk_is_boolean(ctx, -1)) relay = duk_get_boolean(ctx, -1) != 0;
        duk_pop(ctx);
    }
    // a 1a chamada pode inicializar o NimBLE (~300 ms)
    bool ok = jsBlocking([&] { return CelerNet::start(name, net, relay); });
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_meshStop(duk_context *ctx) {
    duk_push_boolean(ctx, CelerNet::stop() ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_meshBroadcast(duk_context *ctx) {
    // Mesma regra do CelerLink.send: string crua, objeto vira JSON — quem
    // le do outro lado decide o formato. jsMsgBytes aplica o teto com erro
    // pre-formatado (duk_error sem varargs).
    uint8_t buf[CelerNet::MAX_MSG];
    size_t len;
    jsMsgBytes(ctx, 0, buf, CelerNet::MAX_MSG, "mensagem", &len);
    uint32_t ttl = CelerNet::TTL_DEFAULT;
    if (!duk_is_null_or_undefined(ctx, 1)) {
        ttl = (uint32_t)duk_require_int(ctx, 1);
        if (ttl < 1) ttl = 1;
        if (ttl > 8) ttl = 8;
    }
    duk_push_boolean(ctx, CelerNet::broadcast(buf, len, (uint8_t)ttl) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_meshSend(duk_context *ctx) {
    const char* to = duk_require_string(ctx, 0);
    uint16_t dst = 0;
    // destino fora da tabela de presenca = false (sem throw): a presenca
    // oscila por natureza, o app decide o que fazer (mesmo contrato do
    // broadcast com a malha desligada e do stub do harness)
    if (!CelerNet::resolveDest(to, &dst)) {
        duk_push_false(ctx);
        return 1;
    }
    // Mesma regra do broadcast: string crua, objeto vira JSON.
    uint8_t buf[CelerNet::MAX_MSG];
    size_t len;
    jsMsgBytes(ctx, 1, buf, CelerNet::MAX_MSG, "mensagem", &len);
    uint32_t ttl = CelerNet::TTL_DEFAULT;
    bool urgent = false;
    uint32_t copies = 2;  // unicast sem ACK: redundancia por duplicata
    if (duk_is_object(ctx, 2) && !duk_is_callable(ctx, 2)) {
        urgent = optBool(ctx, 2, "urgent", false);
        ttl = optUint(ctx, 2, "ttl", ttl);
        copies = optUint(ctx, 2, "copies", copies);
    }
    if (ttl < 1) ttl = 1;
    if (ttl > 8) ttl = 8;
    // fila cheia pode ter acontecido ha pouco: da chance ao tick antes de
    // despachar (sendTo drena o que couber)
    bool ok = jsBlocking([&] {
        return CelerNet::sendTo(dst, buf, len, (uint8_t)ttl, urgent, (uint8_t)copies);
    });
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_meshPoll(duk_context *ctx) {
    CelerNet::Msg m;
    if (!CelerNet::poll(&m)) {
        duk_push_null(ctx);
        return 1;
    }
    duk_push_object(ctx);
    putNodeId(ctx, "from", m.from);
    putStr(ctx, "fromName", m.fromName);
    putLStr(ctx, "msg", (const char*)m.data, (duk_size_t)m.len);
    putBool(ctx, "unicast", m.dst != 0xFFFF);  // API 27: era so pra este no
    putInt(ctx, "hops", m.hops);
    putInt(ctx, "rssi", m.rssi);
    return 1;
}

duk_ret_t JSBindings::js_meshNodes(duk_context *ctx) {
    CelerNet::Node list[CelerNet::NODES_MAX];
    int n = CelerNet::nodes(list, CelerNet::NODES_MAX);
    duk_push_array(ctx);
    for (int i = 0; i < n; i++) {
        duk_push_object(ctx);
        putNodeId(ctx, "id", list[i].id);
        putStr(ctx, "name", list[i].name);
        putUint(ctx, "caps", list[i].caps);  // bits CAPS_* (API 27)
        putInt(ctx, "rssi", list[i].rssi);
        putInt(ctx, "hops", list[i].hops);
        // idade em segundos: e o que se mostra na lista
        putUint(ctx, "lastSeen", list[i].lastSeenMs / 1000);
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)i);
    }
    return 1;
}

duk_ret_t JSBindings::js_meshStatus(duk_context *ctx) {
    CelerNet::Info st;
    CelerNet::info(&st);
    duk_push_object(ctx);
    putBool(ctx, "active", st.active);
    putBool(ctx, "relay", st.relay);
    putNodeId(ctx, "node", st.node);
    putStr(ctx, "name", st.name);
    putStr(ctx, "net", st.net);
    // v3 (API 37): matilha privada (cifrada com chave so dela) ou a aberta
    putBool(ctx, "secure", st.secure);
    putBool(ctx, "provisioned", st.secure);
    putInt(ctx, "txQueued", st.txQueued);
    putUint(ctx, "txDropped", st.txDropped);
    putUint(ctx, "txStarted", st.txStarted);  // quadros que SAIRAM no ar (bench)
    putUint(ctx, "txFail", st.txFail);
    putUint(ctx, "txNoToken", st.txNoToken);
    putUint(ctx, "rxDropped", st.rxDropped);
    putUint(ctx, "relayed", st.relayed);
    putUint(ctx, "relayDropped", st.relayDropped);  // repeticoes descartadas (anel cheio)
    putInt(ctx, "heard", st.heard);
    putUint(ctx, "rxAuthFail", st.rxAuthFail);  // quadros de outra rede (nao autenticaram)
    putUint(ctx, "rxReplay", st.rxReplay);      // seq repetido (dup de relay/replay)
    return 1;
}
