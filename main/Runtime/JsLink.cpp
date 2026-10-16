#include "JSBindings.h"
#include "JsInternal.h"
#include "../Bluetooth/CelerLink.h"
#include "../Pack/PackId.h"
#include "../Kernel/Core/CelerKernel.h"

// =====================================================
// CelerLink Bindings (Bluetooth entre CelerOS, API 9)
//
// Objeto global CelerLink: start/stop (papel peripheral),
// scan/connect/disconnect (papel central), send/poll
// (mensagens de ate 240 bytes) e status. Chamadas bloqueantes
// seguem o padrao wifiScan: present() antes, timeout com clamp.
// Pareamento por codigo de 6 digitos: API 11 (start {pairing},
// verify, unpair e os campos pairing/verified/code do status).
// =====================================================

duk_ret_t JSBindings::js_linkStart(duk_context *ctx) {
    const char* name = nullptr;
    // lightfunc: a pilha SEMPRE tem nargs valores (faltante = undefined),
    // entao duk_get_top nao detecta argumento omitido — testa o valor
    if (!duk_is_null_or_undefined(ctx, 0)) {
        name = duk_require_string(ctx, 0);
    }
    // API 14: pareamento por codigo e o PADRAO (link aberto deixava qualquer
    // aparelho BLE por perto mandar comandos). Abrir exige {pairing:false}.
    bool pairing = true;
    if (duk_is_object(ctx, 1) && !duk_is_callable(ctx, 1)) {
        duk_get_prop_string(ctx, 1, "pairing");
        if (duk_is_boolean(ctx, -1)) pairing = duk_get_boolean(ctx, -1) != 0;
        duk_pop(ctx);
    }
    present();  // a 1a chamada inicializa o NimBLE (~300ms)
    duk_push_boolean(ctx, CelerLink::start(name, pairing) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_linkStop(duk_context *ctx) {
    duk_push_boolean(ctx, CelerLink::stop() ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_linkScan(duk_context *ctx) {
    int timeoutMs = 2500;
    if (!duk_is_null_or_undefined(ctx, 0)) timeoutMs = duk_require_int(ctx, 0);  // scan() sem arg lancava TypeError
    if (timeoutMs < 500) timeoutMs = 500;
    if (timeoutMs > 8000) timeoutMs = 8000;

    // Bloqueante por segundos: a tela fica viva e a janela do exec-timeout
    // renova para o retorno (espera de 0,5-8s)
    CelerLink::Peer peers[16];  // = cache do scan; RSSI mais forte primeiro
    int n = jsBlocking([&] { return CelerLink::scan((uint32_t)timeoutMs, peers, 16); });

    duk_push_array(ctx);
    for (int i = 0; i < n; i++) {
        duk_push_object(ctx);
        putStr(ctx, "id", peers[i].id);
        putStr(ctx, "name", peers[i].name);
        putInt(ctx, "rssi", peers[i].rssi);
        // id do no na malha (PackId): o mesmo do Pack.members() (API 40)
        putInt(ctx, "node", packid::nodeFromLinkId(peers[i].id));
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)i);
    }
    return 1;
}

duk_ret_t JSBindings::js_linkConnect(duk_context *ctx) {
    const char* id = duk_require_string(ctx, 0);
    int timeoutMs = 4000;
    if (!duk_is_null_or_undefined(ctx, 1)) timeoutMs = duk_require_int(ctx, 1);  // connect(id) idem
    if (timeoutMs < 1000) timeoutMs = 1000;
    if (timeoutMs > 8000) timeoutMs = 8000;

    bool ok = jsBlocking([&] { return CelerLink::connect(id, (uint32_t)timeoutMs); });  // espera de 1-8s
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_linkDisconnect(duk_context *ctx) {
    duk_push_boolean(ctx, CelerLink::disconnect() ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_linkVerify(duk_context *ctx) {
    const char* code = duk_require_string(ctx, 0);
    // write + read ATT podem esperar segundos
    bool ok = jsBlocking([&] { return CelerLink::verify(code); });
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_linkUnpair(duk_context *ctx) {
    const char* id = nullptr;
    if (!duk_is_null_or_undefined(ctx, 0)) {
        id = duk_require_string(ctx, 0);
    }
    duk_push_boolean(ctx, CelerLink::unpair(id) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_linkSend(duk_context *ctx) {
    // String vai crua (bytes UTF-8); objeto e serializado como JSON —
    // comunicacao estruturada sem parser no firmware (quem le decide).
    // jsMsgBytes: teto com erro pre-formatado (duk_error sem varargs).
    uint8_t buf[CelerLink::MAX_MSG];
    size_t len;
    const char* data = jsMsgBytes(ctx, 0, buf, CelerLink::MAX_MSG, "mensagem", &len);
    duk_push_boolean(ctx, CelerLink::send(data, len) ? 1 : 0);
    return 1;
}

// CelerLink.sendSealed(objOuString) -> bool (API 21): igual ao send, mas
// AES-128-GCM com a chave do pareamento (CelerLink::sendSealed). Teto menor
// (MAX_SEALED): o selo ocupa nonce + tag. false sem bond com o peer.
duk_ret_t JSBindings::js_linkSendSealed(duk_context *ctx) {
    uint8_t buf[CelerLink::MAX_MSG];
    size_t len;
    const char* data = jsMsgBytes(ctx, 0, buf, CelerLink::MAX_SEALED, "mensagem selada", &len);
    const bool ok = CelerLink::sendSealed(data, len);
    memset(buf, 0, sizeof(buf));  // segredo nao fica na pilha
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}

// CelerLink.pollSealed() -> string | null (API 21): so mensagens seladas que
// autenticaram com o bond do peer conectado. O poll() comum nunca as ve.
duk_ret_t JSBindings::js_linkPollSealed(duk_context *ctx) {
    char buf[CelerLink::MAX_MSG];
    size_t len = 0;
    if (!CelerLink::pollSealed(buf, sizeof(buf), &len)) {
        duk_push_null(ctx);
        return 1;
    }
    duk_push_lstring(ctx, buf, (duk_size_t)len);
    memset(buf, 0, sizeof(buf));
    return 1;
}

duk_ret_t JSBindings::js_linkPoll(duk_context *ctx) {
    char buf[CelerLink::MAX_MSG];
    size_t len = 0;
    if (!CelerLink::poll(buf, sizeof(buf), &len)) {
        duk_push_null(ctx);
        return 1;
    }
    duk_push_lstring(ctx, buf, (duk_size_t)len);
    return 1;
}

duk_ret_t JSBindings::js_linkStatus(duk_context *ctx) {
    CelerLink::Info st;
    CelerLink::info(&st);
    duk_push_object(ctx);
    putBool(ctx, "connected", st.connected);
    putStr(ctx, "peer", st.peer);
    putInt(ctx, "node", packid::nodeFromLinkId(st.peer));  // 0 sem conexao (API 40)
    putBool(ctx, "listening", st.listening);
    // "central" = nos conectamos; "peripheral" = conectaram em nos
    putStr(ctx, "role", !st.connected ? "" : (st.central ? "central" : "peripheral"));
    putStr(ctx, "name", st.name);
    putBool(ctx, "pairing", st.pairing);
    putBool(ctx, "verified", st.verified);
    // so faz sentido no peripheral em handshake pendente ("" nos demais):
    // e o codigo pra MOSTRAR NA TELA, nunca vai parar no peer
    putStr(ctx, "code", st.code);
    putInt(ctx, "mtu", st.mtu);
    putInt(ctx, "rssi", st.rssi);
    putInt(ctx, "pending", st.pending);
    putUint(ctx, "dropped", st.dropped);
    return 1;
}
