#include "JSBindings.h"
#include "JsInternal.h"
#include <unistd.h>
#include <string>
#include "JsFsJail.h"
#include "../Bluetooth/CelerNet.h"
#include "../Bluetooth/NetFrame.h"
#include "../Kernel/Core/CelerKernel.h"
#include "../Pack/Pack.h"
#include "../Pack/Resources.h"
#include "../Pack/Provision.h"
#include "../Bluetooth/NetKeys.h"
#include "../Boards/Board.h"
#include "../Utils/AppPerms.h"

#include <stdio.h>
#include "esp_heap_caps.h"
#include <string.h>
#include <strings.h>

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
    // API 40: em que matilha estou (a aberta "celer" = nao provisionado)
    NetKeys::init();
    const NetKeys::Net* net = NetKeys::primary();
    putStr(ctx, "net", net != nullptr ? net->name : "");
    putBool(ctx, "provisioned", NetKeys::provisioned());
    return 1;
}

// --- Entrar na matilha (API 40): as portas da senha e do convite ---
// Mexem na chave da rede do aparelho: perm "system" (a mesma do
// wifiConnect/OTA). A chave nunca passa pelo JS.

duk_ret_t JSBindings::js_packJoin(duk_context *ctx) {
    const char* name = duk_require_string(ctx, 0);
    const char* pass = duk_require_string(ctx, 1);
    const size_t nl = strlen(name);
    if (!perm(celer::PERM_SYSTEM) || nl == 0 || nl > 15 || strlen(pass) < 8) {
        duk_push_false(ctx);
        return 1;
    }
    // PBKDF2 ~0,3 s: a tela segue viva
    const int ok = jsBlocking([&] { return Provision::joinPassword(name, pass) ? 1 : 0; });
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_packLeave(duk_context *ctx) {
    if (!perm(celer::PERM_SYSTEM)) {
        duk_push_false(ctx);
        return 1;
    }
    Provision::leave();
    duk_push_true(ctx);
    return 1;
}

duk_ret_t JSBindings::js_packAcceptInvite(duk_context *ctx) {
    const bool on = duk_is_null_or_undefined(ctx, 0) ? true : duk_to_boolean(ctx, 0) != 0;
    if (!perm(celer::PERM_SYSTEM)) {
        duk_push_false(ctx);
        return 1;
    }
    present();  // a 1a chamada pode inicializar o NimBLE (~300 ms)
    duk_push_boolean(ctx, Provision::acceptInvite(on) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_packInvite(duk_context *ctx) {
    if (!perm(celer::PERM_SYSTEM)) {
        duk_push_false(ctx);
        return 1;
    }
    duk_push_boolean(ctx, Provision::invite() ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_packInviteStatus(duk_context *ctx) {
    duk_push_string(ctx, Provision::stateName(Provision::state()));
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

// =====================================================
// Recursos da matilha (API 36, Pack/Resources.h)
//
// Cada no expoe o que tem (mic, speaker, camera e canais de dados do app) e
// qualquer membro abre o recurso de outro. Nada bloqueia: open() devolve o
// handle na hora e status(h) conta quando o dono respondeu. Handles sao
// numeros (0..7), validos ate o close ou a troca de app.
// =====================================================

namespace {
// teto do DATA no firmware (1458 com ESP-NOW) — o buffer cobre o maior caso.
// Sem PSRAM (CYD) nao ha ESP-NOW: 4 buffers de 1,4 KB no .bss interno nao
// valeriam o que custam
#if CONFIG_SPIRAM
constexpr size_t kResBuf = 1458;
#else
constexpr size_t kResBuf = resproto::MAX_DATA;
#endif
// UM buffer para read/write/publish/pollWrite (o JS e uma task so; nenhum
// deles chama o outro), alocado no 1o uso e na PSRAM: 4 estaticos de 1,4 KB
// no .bss comiam a RAM interna que o DMA do mic do relogio precisa
// (bancada 2026-10-11: interna 7 KB, I2S do mic sem descritor)
uint8_t* resBuf() {
    static uint8_t* s_buf = nullptr;
    if (s_buf == nullptr) {
        s_buf = (uint8_t*)heap_caps_malloc(kResBuf, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (s_buf == nullptr) s_buf = (uint8_t*)heap_caps_malloc(kResBuf, MALLOC_CAP_8BIT);
    }
    return s_buf;
}
static_assert(kResBuf >= resproto::MAX_DATA, "buffer menor que o DATA da malha");

const char* stateName(Resources::State s) {
    switch (s) {
        case Resources::ST_OPENING: return "opening";
        case Resources::ST_OPEN: return "open";
        case Resources::ST_REFUSED: return "refused";
        case Resources::ST_REVOKED: return "revoked";
        case Resources::ST_LOST: return "lost";
        case Resources::ST_CLOSED: return "closed";
        case Resources::ST_DONE: return "done";
        default: return "free";
    }
}
}  // namespace

duk_ret_t JSBindings::js_packResources(duk_context *ctx) {
    // filtro opcional: tipo ("mic", "speaker", "camera", "gpio", "sensor", "data")
    const char* only = duk_is_string(ctx, 0) ? duk_get_string(ctx, 0) : nullptr;
    static Resources::Remote list[24];  // fora da pilha do app
    int n = Resources::remotes(list, 24);
    duk_push_array(ctx);
    duk_uarridx_t k = 0;
    for (int i = 0; i < n; i++) {
        const char* type = resproto::typeName(list[i].e.type);
        if (only != nullptr && strcmp(only, type) != 0) continue;
        duk_push_object(ctx);
        putNodeId(ctx, "node", list[i].node);
        putStr(ctx, "nodeName", list[i].nodeName);
        putStr(ctx, "name", list[i].e.name);
        putStr(ctx, "type", type);
        putBool(ctx, "busy", (list[i].e.flags & resproto::FLAG_BUSY) != 0);
        putBool(ctx, "shared", (list[i].e.flags & resproto::FLAG_SHARED) != 0);
        putBool(ctx, "ready", (list[i].e.flags & resproto::FLAG_READY) != 0);
        // metadados (API 38; nos velhos nao mandam): unidade/faixa de sensor,
        // esquema dos params do OPEN
        if (list[i].m.unit[0] != '\0') putStr(ctx, "unit", list[i].m.unit);
        if (list[i].m.hasRange) {
            duk_push_number(ctx, list[i].m.rangeMin);
            duk_put_prop_string(ctx, -2, "min");
            duk_push_number(ctx, list[i].m.rangeMax);
            duk_put_prop_string(ctx, -2, "max");
        }
        if (list[i].m.schema[0] != '\0') putStr(ctx, "schema", list[i].m.schema);
        duk_put_prop_index(ctx, -2, k++);
    }
    return 1;
}

duk_ret_t JSBindings::js_packOpen(duk_context *ctx) {
    const char* to = duk_require_string(ctx, 0);
    const char* name = duk_require_string(ctx, 1);
    // o dado do mic/camera de outro no e tao sensivel quanto o local: pede a
    // MESMA permissao que o Mic/Camera daqui pediriam. gpio/sensor (API 38)
    // idem: e o dominio de pinos — o analogRead local tambem pede "gpio"
    const bool gpioName = strncasecmp(name, "rele", 4) == 0 || strcasecmp(name, "gpio") == 0 ||
                          strcasecmp(name, "lum") == 0 || strcasecmp(name, "bat") == 0 ||
                          strncasecmp(name, "adc", 3) == 0;
    if ((strcasecmp(name, "mic") == 0 && !perm(celer::PERM_MIC)) ||
        (strcasecmp(name, "camera") == 0 && !perm(celer::PERM_CAMERA)) ||
        (gpioName && !perm(celer::PERM_GPIO))) {
        duk_push_int(ctx, -1);
        return 1;
    }
    uint16_t dst = 0;
    if (!Resources::resolve(to, &dst)) {  // no sumido: -1, sem throw
        duk_push_int(ctx, -1);
        return 1;
    }
    // opts vira params (JSON compacto, ate 48 B) — o provedor interpreta
    uint8_t params[resproto::PARAMS_MAX];
    size_t plen = 0;
    if (duk_is_object(ctx, 2) && !duk_is_callable(ctx, 2)) {
        jsMsgBytes(ctx, 2, params, sizeof(params), "opts do recurso", &plen);
    }
    duk_push_int(ctx, Resources::open(dst, name, params, plen));
    return 1;
}

duk_ret_t JSBindings::js_packStatus(duk_context *ctx) {
    Resources::HandleInfo hi;
    if (!Resources::info(duk_require_int(ctx, 0), &hi)) {
        duk_push_null(ctx);
        return 1;
    }
    duk_push_object(ctx);
    putStr(ctx, "state", stateName(hi.state));
    putStr(ctx, "reason", hi.reason ? resproto::reasonName(hi.reason) : "");
    putNodeId(ctx, "node", hi.node);
    putStr(ctx, "name", hi.name);
    // plano de dados da sessao aberta: "espnow" (rapido, ate 1458 B) ou "mesh"
    putStr(ctx, "via", hi.state == Resources::ST_OPEN ? (hi.espnow ? "espnow" : "mesh") : "");
    if (hi.total > 0 || hi.frames > 0) {  // camera: progresso da foto / quadros do video
        putUint(ctx, "bytes", hi.bytes);
        putUint(ctx, "total", hi.total);
        putUint(ctx, "frames", hi.frames);
    }
    return 1;
}

duk_ret_t JSBindings::js_packRead(duk_context *ctx) {
    uint8_t* buf = resBuf();
    if (buf == nullptr) duk_error(ctx, DUK_ERR_RANGE_ERROR, "sem RAM para o dado do recurso");
    size_t len = 0;
    if (!Resources::read(duk_require_int(ctx, 0), buf, kResBuf, &len)) {
        duk_push_null(ctx);
        return 1;
    }
    duk_push_lstring(ctx, (const char*)buf, (duk_size_t)len);
    return 1;
}

duk_ret_t JSBindings::js_packWrite(duk_context *ctx) {
    const int h = duk_require_int(ctx, 0);
    uint8_t* buf = resBuf();
    if (buf == nullptr) duk_error(ctx, DUK_ERR_RANGE_ERROR, "sem RAM para o dado do recurso");
    size_t len;
    jsMsgBytes(ctx, 1, buf, Resources::dataCap(), "dado do recurso", &len);
    duk_push_boolean(ctx, Resources::write(h, buf, len) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_packClose(duk_context *ctx) {
    Resources::close(duk_require_int(ctx, 0));
    return 0;
}

duk_ret_t JSBindings::js_packExpose(duk_context *ctx) {
    const char* name = duk_require_string(ctx, 0);
    bool shared = true;
    resproto::Meta meta;
    bool hasMeta = false;
    if (duk_is_object(ctx, 1)) {
        duk_get_prop_string(ctx, 1, "shared");
        if (duk_is_boolean(ctx, -1)) shared = duk_get_boolean(ctx, -1) != 0;
        duk_pop(ctx);
        // metadados do catalogo (API 38): {unit, min, max} — quem consome o
        // canal de outro no ve a unidade e a faixa no Pack.resources()
        duk_get_prop_string(ctx, 1, "unit");
        if (duk_is_string(ctx, -1)) {
            snprintf(meta.unit, sizeof(meta.unit), "%s", duk_get_string(ctx, -1));
            hasMeta = true;
        }
        duk_pop(ctx);
        duk_get_prop_string(ctx, 1, "min");
        if (duk_is_number(ctx, -1)) {
            meta.rangeMin = (float)duk_get_number(ctx, -1);
            meta.hasRange = true;
            hasMeta = true;
        }
        duk_pop(ctx);
        duk_get_prop_string(ctx, 1, "max");
        if (duk_is_number(ctx, -1)) {
            meta.rangeMax = (float)duk_get_number(ctx, -1);
            meta.hasRange = true;
            hasMeta = true;
        }
        duk_pop(ctx);
    }
    duk_push_boolean(ctx, Resources::expose(name, shared, hasMeta ? &meta : nullptr) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_packUnexpose(duk_context *ctx) {
    duk_push_boolean(ctx, Resources::unexpose(duk_require_string(ctx, 0)) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_packPublish(duk_context *ctx) {
    const char* name = duk_require_string(ctx, 0);
    uint8_t* buf = resBuf();
    if (buf == nullptr) duk_error(ctx, DUK_ERR_RANGE_ERROR, "sem RAM para o dado do recurso");
    size_t len;
    jsMsgBytes(ctx, 1, buf, Resources::dataCap(), "dado do recurso", &len);
    duk_push_int(ctx, Resources::publish(name, buf, len));
    return 1;
}

duk_ret_t JSBindings::js_packSessions(duk_context *ctx) {
    duk_push_int(ctx, Resources::sessions(duk_require_string(ctx, 0)));
    return 1;
}

duk_ret_t JSBindings::js_packPollWrite(duk_context *ctx) {
    char res[resproto::RES_NAME_MAX + 1];
    char fromName[16];
    uint16_t from = 0;
    uint8_t* buf = resBuf();
    if (buf == nullptr) duk_error(ctx, DUK_ERR_RANGE_ERROR, "sem RAM para o dado do recurso");
    size_t len = kResBuf;
    if (!Resources::pollWrite(res, sizeof(res), &from, fromName, sizeof(fromName), buf, &len)) {
        duk_push_null(ctx);
        return 1;
    }
    duk_push_object(ctx);
    putStr(ctx, "res", res);
    putNodeId(ctx, "from", from);
    putStr(ctx, "fromName", fromName);
    putLStr(ctx, "data", (const char*)buf, len);
    return 1;
}

// ---- audio da matilha (API 36, R3): mic/speaker de outro no -------------
// Tudo nativo (stream PCM 16 kHz pelo ESP-NOW): o JS so abre e fecha. Abrir
// o mic de outro no pede a MESMA permissao "mic" do Mic local.

namespace {
// destino (id/nome) -> no; false = sumiu da malha
bool packNode(duk_context* ctx, uint16_t* out) {
    return Resources::resolve(duk_require_string(ctx, 0), out);
}
}  // namespace

// Pack.listen(no) -> h: o mic do no toca no NOSSO alto-falante (interfone)
duk_ret_t JSBindings::js_packListen(duk_context *ctx) {
    uint16_t dst = 0;
    if (!perm(celer::PERM_MIC) || !packNode(ctx, &dst)) {
        duk_push_int(ctx, -1);
        return 1;
    }
    duk_push_int(ctx, Resources::open(dst, "mic", nullptr, 0, Resources::MODE_PLAY));
    return 1;
}

// Pack.speak(no) -> h: o NOSSO mic toca no alto-falante do no
duk_ret_t JSBindings::js_packSpeak(duk_context *ctx) {
    uint16_t dst = 0;
    if (!perm(celer::PERM_MIC) || Board::profile().mic.ws < 0 || !packNode(ctx, &dst)) {
        duk_push_int(ctx, -1);
        return 1;
    }
    duk_push_int(ctx, Resources::open(dst, "speaker", nullptr, 0, Resources::MODE_SPEAK));
    return 1;
}

// Pack.record(no, [{ms}]) -> h: grava o mic do no aqui (WAV no recordStop)
duk_ret_t JSBindings::js_packRecord(duk_context *ctx) {
    uint16_t dst = 0;
    if (!perm(celer::PERM_MIC) || !packNode(ctx, &dst)) {
        duk_push_int(ctx, -1);
        return 1;
    }
    const int ms = optInt(ctx, 1, "ms", 6000);
    duk_push_int(ctx, Resources::open(dst, "mic", nullptr, 0, Resources::MODE_REC,
                                      (uint32_t)(ms < 200 ? 200 : ms > 10000 ? 10000 : ms)));
    return 1;
}

// Pack.recording(h) -> bool (false no teto ou com a sessao caida)
duk_ret_t JSBindings::js_packRecording(duk_context *ctx) {
    duk_push_boolean(ctx, Resources::recording(duk_require_int(ctx, 0)) ? 1 : 0);
    return 1;
}

// Pack.level() -> RMS 0..100 do audio remoto sendo gravado (-1 parado)
duk_ret_t JSBindings::js_packLevel(duk_context *ctx) {
    duk_push_int(ctx, Resources::recLevel());
    return 1;
}

// Pack.recordStop(h, [{raw, path}]) -> base64 do WAV | WAV cru | null.
// {path}: grava o WAV direto no arquivo (perm "fs", mesmo jail do FS) e
// devolve true/false — 10 s de audio sao 320 KB, que nao atravessam o JS
// (FS.writeFile tem teto de 64 KB)
duk_ret_t JSBindings::js_packRecordStop(duk_context *ctx) {
    const int h = duk_require_int(ctx, 0);
    bool raw = false;
    std::string path;
    if (duk_is_object(ctx, 1) && !duk_is_array(ctx, 1)) {
        duk_get_prop_string(ctx, 1, "raw");
        raw = duk_get_boolean(ctx, -1) != 0;
        duk_pop(ctx);
        duk_get_prop_string(ctx, 1, "path");
        if (duk_is_string(ctx, -1)) path = duk_get_string(ctx, -1);
        duk_pop(ctx);
    }
    if (!path.empty() && (!perm(celer::PERM_FS) || !fsWriteAllowed(path.c_str()))) {
        duk_error(ctx, DUK_ERR_ERROR, "Pack.recordStop: escrita negada nesse caminho");
    }
    size_t len = 0;
    uint32_t ms = 0;
    char* p = Resources::recStop(h, !raw && path.empty(), &len, &ms);
    if (p == nullptr) {
        if (!path.empty()) duk_push_false(ctx);
        else duk_push_null(ctx);
        return 1;
    }
    if (!path.empty()) {
        // /local: tmp + rename (atomico no LittleFS); SD: direto
        const bool atomic = path.compare(0, 7, "/local/") == 0;
        const std::string tmp = atomic ? path + ".tmp" : path;
        FILE* f = fopen(tmp.c_str(), "wb");
        bool ok = f != nullptr && fwrite(p, 1, len, f) == len;
        if (f != nullptr) ok = fclose(f) == 0 && ok;
        if (atomic && (!ok || rename(tmp.c_str(), path.c_str()) != 0)) {
            unlink(tmp.c_str());
            ok = false;
        }
        free(p);
        duk_push_boolean(ctx, ok ? 1 : 0);
        return 1;
    }
    return jsPushOwnedString(ctx, p, len);
}

// ---- camera de outro no (API 36, R3): foto confiavel e video JPEG ---------
// Mesma permissao "camera" da Camera local. ESP-NOW obrigatorio ("noLink").

// Pack.snap(no, {path, quality}) -> h: a foto chega e e gravada em path (perm
// "fs"); status(h).state vira "done" (bytes/total mostram o progresso)
duk_ret_t JSBindings::js_packSnap(duk_context *ctx) {
    uint16_t dst = 0;
    if (!perm(celer::PERM_CAMERA) || !packNode(ctx, &dst)) {
        duk_push_int(ctx, -1);
        return 1;
    }
    std::string path = "/local/snap.jpg";
    if (duk_is_object(ctx, 1)) {
        duk_get_prop_string(ctx, 1, "path");
        if (duk_is_string(ctx, -1)) path = duk_get_string(ctx, -1);
        duk_pop(ctx);
    }
    if (path.size() >= 64 || !perm(celer::PERM_FS) || !fsWriteAllowed(path.c_str())) {
        duk_error(ctx, DUK_ERR_ERROR, "Pack.snap: escrita negada nesse caminho (perm fs)");
    }
    const int q = optInt(ctx, 1, "quality", 12);
    duk_push_int(ctx, Resources::openCamera(dst, false, 0, q, path.c_str()));
    return 1;
}

// Pack.view(no, {fps, quality}) -> h: video da camera (o app desenha o
// ultimo quadro com Pack.drawFrame)
duk_ret_t JSBindings::js_packView(duk_context *ctx) {
    uint16_t dst = 0;
    if (!perm(celer::PERM_CAMERA) || !packNode(ctx, &dst)) {
        duk_push_int(ctx, -1);
        return 1;
    }
    int fps = optInt(ctx, 1, "fps", 3);
    if (fps < 1) fps = 1;
    if (fps > 10) fps = 10;
    duk_push_int(ctx, Resources::openCamera(dst, true, fps, optInt(ctx, 1, "quality", 14), nullptr));
    return 1;
}

#if CONFIG_CELEROS_UI
// Pack.drawFrame(h, x, y) -> bool: desenha o quadro NOVO do video (o mesmo
// decoder do System.drawJPG, na escala do canvas); false = nenhum novo
duk_ret_t JSBindings::js_packDrawFrame(duk_context *ctx) {
    const int h = duk_require_int(ctx, 0);
    const int x = duk_require_int(ctx, 1);
    const int y = duk_require_int(ctx, 2);
    uint8_t* jpg = nullptr;
    size_t len = 0;
    if (!tftInstance || !Resources::takeFrame(h, &jpg, &len)) {
        duk_push_false(ctx);
        return 1;
    }
    const bool ok = gfx()->drawJpg(jpg, len, jsx(x), jsy(y), 0, 0, 0, 0,
                                   s_nativeCanvas ? 1.0f : (float)UI::W / 240.0f, appScaleY());
    free(jpg);
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}
#else
duk_ret_t JSBindings::js_packDrawFrame(duk_context *ctx) {
    duk_push_false(ctx);
    return 1;
}
#endif
