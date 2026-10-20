#pragma once

// Estado e helpers compartilhados entre os modulos do runtime JS
// (JSBindings.cpp = nucleo: topbar/quadro/init; Js*.cpp = um dominio cada).
#include "sdkconfig.h"
#include <cstdio>
#include <cstdlib>
#include <string>
#include "JSBindings.h"
#include "../Utils/JsThrow.h"
#include "../Display/Layout.h"
#include "../Launcher/LauncherUI.h"
#include "../Display/FrameSprite.h"
#include "../Kernel/Core/CelerKernel.h"
#include "../WebManager/WebManager.h"
#include "../FileSystem/FileSystem.h"
#include <lgfx/v1/misc/DataWrapper.hpp>

extern CelerDisplay* s_jsTft;
extern bool s_topbarFixed;
// Canvas nativo (API 28): o app abriu mao do canvas virtual 240x320 e desenha
// em pixels FISICOS do vidro (480x480 na 4848). Todos os conversores abaixo
// viram identidade; o touch e screenWidth/Height passam a fisicos. Exigido
// app sem topbar fixa (System.setNativeCanvas recusa e devolve false).
extern bool s_nativeCanvas;
extern FrameSprite* s_frame;
// Pedido de push do quadro INTEIRO: o vidro foi sujado por fora do quadro
// (teclado do prompt). Desenho normal no quadro dispensa: a caixa suja do
// FrameSprite ja diz o que mudou.
extern bool s_frameDirty;

// Capabilities do app corrente (F4) e packageName (FS.appData). Os guards
// vivem no init da fachada; js_appData (JsFs.cpp) le s_appPkg.
extern uint32_t s_perms;
extern std::string s_appPkg;
// Pasta do app em execucao (dirname do main.js; vazia p/ .js avulso):
// base do require() de modulos (JsModules.cpp). Alimentada no runFile.
extern std::string s_appDir;
// Deps compartilhadas do app corrente (deps.json da pasta, versoes
// RESOLVIDAS no install): require() cai p/ /local/modules/<nome>/<versao>/
// quando o modulo nao esta na pasta do app. Tambem alimentada no runFile.
void jsLoadAppDeps(const char* appDir);
// Verlet nativo (API 31, JsPhysics.cpp): mundos do app anterior saem no
// init do proximo (malloc incluso). Chamado pelo JSBindings::init.
void jsPhysicsReset();
#if CONFIG_CELEROS_JS_GAME_ACCEL
// Corpo rigido nativo (API 33, JsRigid.cpp): mesmo ciclo do verlet.
void jsRigidReset();
#endif
inline bool perm(uint32_t bit) { return (s_perms & bit) != 0; }

// Saida limpa de app (F2): erro MARCADO com a propriedade celerExit — o
// kernel identifica a marcacao (ou a string "OS_EXIT" exata, compat com
// apps que a lancam direto). Antes qualquer erro cujo texto continha
// "OS_EXIT" fechava o app silenciosamente.
// Saida pedida e "grudenta": um app com try/catch generico no loop engolia
// o erro e o X/exit remoto nunca fechava. Com s_appExitPending, todo ponto
// de espera seguinte (delay/getTouch/keypadPoll) relanca. Zerado no init.
extern bool s_appExitPending;

[[noreturn]] inline void throwAppExit(duk_context* ctx) {
    s_appExitPending = true;
    duk_push_error_object(ctx, DUK_ERR_ERROR, "app exit");
    duk_push_boolean(ctx, 1);
    duk_put_prop_string(ctx, -2, "celerExit");
    (void)duk_throw(ctx);  // longjmp: nunca retorna de verdade
    while (true) { }       // so para calmar o -Wreturn-type
}

// Encerramento remoto do app (shell "exit" / dev loop do SDK): checado nos
// pontos de espera do runtime (delay/getTouch/keypadPoll). Reusa a saida
// limpa do X da topbar — o kernel volta ao launcher normalmente.
inline void checkRemoteAppExit(duk_context* ctx) {
    if (s_appExitPending || LauncherUI::consumeAppExitRequest()) throwAppExit(ctx);
}

// Handoff de buffer malloc para o heap JS: duk_push_lstring LANCA (longjmp)
// se faltar RAM para a string, e o free do dono nunca rodaria — o buffer
// vazaria ate o reboot (pior caso: o WAV do Mic.stop, centenas de KB). O
// push roda sob duk_safe_call; o dono e sempre liberado e o erro, repassado
// ao script. Devolve 1 (string no stack).
struct JsPushBuf { const char* p; size_t len; };
inline duk_ret_t jsPushBufSafe(duk_context* ctx, void* u) {
    JsPushBuf* b = (JsPushBuf*)u;
    duk_push_lstring(ctx, b->p, b->len);
    return 1;
}
inline int jsPushOwnedString(duk_context* ctx, char* p, size_t len) {
    JsPushBuf b{p, len};
    duk_int_t rc = duk_safe_call(ctx, jsPushBufSafe, &b, 0, 1);
    free(p);
    if (rc != DUK_EXEC_SUCCESS) duk_throw(ctx);
    return 1;
}

bool pollAppChrome(bool& touched, uint16_t& x, uint16_t& y);
bool imagePathOk(const char* path);
void keypadCloseSession();

// Desenho do SISTEMA no alvo do app (faixa, teclado acoplado): salva o
// estado de texto (cor/datum/tamanho/fonte) e o recorte do app, desenha
// limpo e restaura na saida do escopo — nada vaza em nenhum sentido.
struct GfxStateGuard {
    lgfx::LGFXBase& g;
    lgfx::TextStyle style;
    const lgfx::IFont* font;
    int32_t cx, cy, cw, ch;
    explicit GfxStateGuard(lgfx::LGFXBase& target) : g(target), style(target.getTextStyle()), font(target.getFont()) {
        g.getClipRect(&cx, &cy, &cw, &ch);
        g.clearClipRect();
        g.setTextSize(1);
    }
    ~GfxStateGuard() {
        g.setTextStyle(style);
        g.setFont(font);
        g.setClipRect(cx, cy, cw, ch);
    }
    GfxStateGuard(const GfxStateGuard&) = delete;
    GfxStateGuard& operator=(const GfxStateGuard&) = delete;
};

inline uint32_t jsc(uint32_t c) {
    // Cores JS sao RGB565. No LovyanGFX o TIPO decide o formato: uint32_t e
    // lido como RGB888 — passar o 565 cru (como antes, "painel 16-bit")
    // trocava as cores. Expande sempre para 888; o LGFX converte ao nativo.
    uint32_t r = (c >> 11) & 0x1F, g = (c >> 5) & 0x3F, b = c & 0x1F;
    return (((r << 3) | (r >> 2)) << 16) | (((g << 2) | (g >> 4)) << 8) | ((b << 3) | (b >> 2));
}
// Fonte numerica do JS (drawString/textWidth/fontHeight): so 1..8 existem
// no fontdata[] do LovyanGFX (9 = nullptr, >9/negativo = alem do fim do
// array, e o CelerFont(uint8_t) truncava 300 em 44) — drawString(s, x, y,
// 9) derrubava o aparelho. Fora da faixa vira a fonte padrao (2).
inline const lgfx::IFont* jsFont(int f) {
    if (f < 1 || f > 8) f = 2;
    return CelerFont(UI::font(f));
}
inline int jsx(int v) { return s_nativeCanvas ? v : UI::sx(v); }
inline int appSh(int v) {
    if (s_nativeCanvas) return v;
    return s_topbarFixed ? (v * (UI::H - UI::topbarH()) / 320) : v * UI::H / 320;
}
inline float appScaleY() {
    if (s_nativeCanvas) return 1.0f;
    return (float)(s_topbarFixed ? (UI::H - UI::topbarH()) : UI::H) / 320.0f;
}
// Raio "uniforme": MINIMO das duas escalas. O circulo desenhado no vidro tem
// um unico raio fisico, mas o app raciocina num bbox virtual (cx±r, cy±r) —
// com o minimo ele fica CONTIDO nesse bbox nos dois eixos. A media antiga
// estourava o eixo menor em escala nao-inteira (4848: sx 2 / sy 1,5 → r4
// virava 7 fisicos e passava 1px da celula), e apps que apagam circulo com
// fillRect do retangulo virtual deixavam a ultima linha viva (artefato).
inline int jsu(int v) {
    int a = UI::sx(v), b = appSh(v);
    return a < b ? a : b;
}
inline int jsH(int v) { return appSh(v); }
inline int jsy(int v) { return JSBindings::mapY(v); }

// ===================== helpers compartilhados dos bindings =====================
// put*: propriedade tipada no objeto de retorno do topo da pilha. Encurtam os
// corpos js_* (o par push+put_prop se repetia ~240x); o parser do manifest
// (tools/app_lint) le apenas o init() do JSBindings, que segue com as
// chamadas literais — os corpos nao passam por ele.
inline void putInt(duk_context* ctx, const char* k, int v) {
    duk_push_int(ctx, v);
    duk_put_prop_string(ctx, -2, k);
}
inline void putUint(duk_context* ctx, const char* k, unsigned int v) {
    duk_push_uint(ctx, v);
    duk_put_prop_string(ctx, -2, k);
}
inline void putNum(duk_context* ctx, const char* k, double v) {
    duk_push_number(ctx, v);
    duk_put_prop_string(ctx, -2, k);
}
inline void putBool(duk_context* ctx, const char* k, bool v) {
    duk_push_boolean(ctx, v ? 1 : 0);
    duk_put_prop_string(ctx, -2, k);
}
inline void putStr(duk_context* ctx, const char* k, const char* v) {
    duk_push_string(ctx, v);
    duk_put_prop_string(ctx, -2, k);
}
inline void putLStr(duk_context* ctx, const char* k, const char* v, size_t len) {
    duk_push_lstring(ctx, v, (duk_size_t)len);
    duk_put_prop_string(ctx, -2, k);
}

// Id hex de 4 digitos do no da malha (CelerNet/Pack) como propriedade de um
// objeto de retorno: o par snprintf+"%04X" era copiado 6x entre JsMesh/JsPack.
inline void putNodeId(duk_context* ctx, const char* k, uint16_t id) {
    char s[8];
    snprintf(s, sizeof(s), "%04X", id);
    duk_push_string(ctx, s);
    duk_put_prop_string(ctx, -2, k);
}

// jsThrowMsg (mensagem pre-formatada, sem variadicos) vive em
// Utils/JsThrow.h: o teste/duk compila o corpo de JsModules.cpp sem este
// header e precisa do mesmo helper.

// String crua (bytes UTF-8) ou objeto serializado como JSON — quem le do
// outro lado decide o formato (mesma regra do CelerLink.send). Teto com
// RangeError pre-formatado (duk_error com %d a partir de lightfunc corrompe
// o heap — bancada 2026-10-02) e TypeError se o valor nao serializa. Os
// dois caminhos COPIAM para buf (>= cap bytes) e devolvem buf: os chamadores
// de Mesh/Pack mandam buf direto (antes o caminho string devolvia o ponteiro
// do duk e buf seguia lixo de pilha). "what" abre a mensagem de tamanho
// ("mensagem", "mensagem selada", "envelope"...).
inline const char* jsMsgBytes(duk_context* ctx, duk_idx_t idx, void* buf,
                              size_t cap, const char* what, size_t* len) {
    const char* src;
    if (duk_is_object(ctx, idx) && !duk_is_callable(ctx, idx)) {
        src = duk_json_encode(ctx, idx);
        if (src == nullptr) duk_error(ctx, DUK_ERR_TYPE_ERROR, "valor nao serializa como JSON");
        *len = strlen(src);
    } else {
        src = duk_require_lstring(ctx, idx, len);
    }
    if (*len == 0 || *len > cap) {
        char msg[64];
        snprintf(msg, sizeof(msg), "%s deve ter 1 a %d bytes", what, (int)cap);
        jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, msg);
    }
    memcpy(buf, src, *len);
    return (const char*)buf;
}

// ----------------------------------------------------------- opcoes JS ----
// Propriedade opcional de um objeto de opcoes no idx: ausente ou tipo errado
// devolve o default (lightfunc: a pilha SEMPRE tem nargs entradas, faltante
// = undefined — por isso o teste de tipo, nao de contagem).
inline int optInt(duk_context* ctx, duk_idx_t idx, const char* key, int def) {
    if (!duk_is_object(ctx, idx)) return def;
    int v = def;
    if (duk_get_prop_string(ctx, idx, key) && duk_is_number(ctx, -1)) v = duk_get_int(ctx, -1);
    duk_pop(ctx);
    return v;
}
inline unsigned int optUint(duk_context* ctx, duk_idx_t idx, const char* key, unsigned int def) {
    if (!duk_is_object(ctx, idx)) return def;
    unsigned int v = def;
    if (duk_get_prop_string(ctx, idx, key) && duk_is_number(ctx, -1)) v = duk_get_uint(ctx, -1);
    duk_pop(ctx);
    return v;
}
inline bool optBool(duk_context* ctx, duk_idx_t idx, const char* key, bool def) {
    if (!duk_is_object(ctx, idx)) return def;
    bool v = def;
    if (duk_get_prop_string(ctx, idx, key) && !duk_is_undefined(ctx, -1)) v = duk_to_boolean(ctx, -1) != 0;
    duk_pop(ctx);
    return v;
}
// Ponteiro valido enquanto o objeto de opcoes estiver vivo (argumento)
inline const char* optStr(duk_context* ctx, duk_idx_t idx, const char* key, const char* def) {
    if (!duk_is_object(ctx, idx)) return def;
    const char* v = def;
    if (duk_get_prop_string(ctx, idx, key) && duk_is_string(ctx, -1)) v = duk_get_string(ctx, -1);
    duk_pop(ctx);
    return v;
}
// Cor JS (RGB565) opcional -> RGB888; def ja em 888
inline uint32_t optColor(duk_context* ctx, duk_idx_t idx, const char* key, uint32_t def) {
    int v = optInt(ctx, idx, key, -1);
    return v < 0 ? def : jsc((uint32_t)v);
}
// Texto de argumento (qualquer tipo vira string; undefined/null = "")
inline const char* argStr(duk_context* ctx, duk_idx_t idx) {
    if (duk_is_null_or_undefined(ctx, idx)) return "";
    return duk_to_string(ctx, idx);
}
// Texto obrigatorio: undefined e erro de tipo (o resto vira string). Nome no
// molde require* para o app_lint inferir a aridade minima.
inline const char* requireText(duk_context* ctx, duk_idx_t idx) {
    if (duk_is_undefined(ctx, idx)) duk_error(ctx, DUK_ERR_TYPE_ERROR, "texto obrigatorio");
    return argStr(ctx, idx);
}

// Chamada de rede exige WiFi conectado: erro legivel no script em vez de um
// null silencioso (prefixo do modulo na mensagem — "Net:", "AI:"). duk_error
// SEM argumentos de conversao (regra do lightfunc).
inline void jsRequireWifi(duk_context* ctx, const char* who) {
    if (WebManager::isWifiConnected()) return;
    char msg[48];
    snprintf(msg, sizeof(msg), "%s: WiFi is not connected", who);
    jsThrowMsg(ctx, DUK_ERR_ERROR, msg);
}

// Pasta privada do app corrente (/local/data/<pkg>), criando a arvore.
// Vazia quando o app nao tem packageName — o chamador decide o que fazer.
inline std::string jsAppDataDir() {
    if (s_appPkg.empty()) return std::string();
    std::string dir = "/local/data/" + s_appPkg;
    FileSystem::mkdir("/local/data");
    FileSystem::mkdir(dir.c_str());
    return dir;
}

// Chamada bloqueante com a tela viva: present() antes (o quadro/progresso do
// app aparece durante a espera) e noteAppYield() depois (renova a janela do
// exec-timeout para o retorno — o present de entrada nao cobre o tempo DA
// chamada bloqueante).
template <typename F>
static inline auto jsBlocking(F&& f) -> decltype(f()) {
    JSBindings::present();
    auto r = f();
    CelerKernel::noteAppYield();
    return r;
}

// Corpo acumulado em malloc/realloc (sink do HttpClient): sem RAM a
// requisicao falha limpa (null no script). Com std::string, o crescimento
// sem excecao abortava o aparelho no heap apertado da CYD (medido).
template <size_t MAX>
struct JsBodySink {
    char* p = nullptr;
    size_t n = 0, cap = 0;
    bool append(const char* d, size_t len) {
        if (n >= MAX) return true;  // teto: descarta o excedente
        if (len > MAX - n) len = MAX - n;
        if (n + len > cap) {
            size_t want = cap * 2 > n + len ? cap * 2 : n + len;
            if (want < 1024) want = 1024;
            if (want > MAX) want = MAX;
            char* q = (char*)realloc(p, want);
            if (q == nullptr) q = (char*)realloc(p, want = n + len);  // exato
            if (q == nullptr) return false;
            p = q;
            cap = want;
        }
        memcpy(p + n, d, len);
        n += len;
        return true;
    }
};

// Slot serial de tarefa assincrona (Net async / AI): UM escritor publica o
// resultado (1->2) sob mutex; o app consome/devolve no present. Os campos
// mux/discard/ok/status/body/bodyLen/error/state sao o contrato comum dos
// dois slots (o tamanho do error, 64/96 B, entra pelo sizeof do campo).
template <typename S>
static inline bool jsSlotMuxTake(S& s) {
    if (s.mux == nullptr) s.mux = xSemaphoreCreateMutex();
    return s.mux != nullptr && xSemaphoreTake(s.mux, portMAX_DELAY) == pdTRUE;
}
template <typename S>
static inline void jsSlotFreeBody(S& s) {
    free(s.body);
    s.body = nullptr;
    s.bodyLen = 0;
}
// Publicacao do resultado pela task dona (1->2): descartado se o app saiu,
// posse do corpo transferida ao slot. Sem mutex: corpo liberado na task.
template <typename S>
static inline void jsSlotPublish(S& s, char* body, size_t bodyLen, bool ok, int status, const char* err) {
    if (jsSlotMuxTake(s)) {
        jsSlotFreeBody(s);
        if (s.discard) {
            free(body);
            s.ok = false;
            s.status = 0;
            snprintf(s.error, sizeof(s.error), "cancelado");
        } else {
            s.ok = ok;
            s.status = status;
            s.body = body;
            s.bodyLen = bodyLen;
            snprintf(s.error, sizeof(s.error), "%s", err);
        }
        s.discard = false;
        s.state = 2;
        xSemaphoreGive(s.mux);
    } else {
        free(body);
    }
}

struct CelerFileWrapper : public lgfx::DataWrapper {
    bool open(const char* path) override {
        while (nullptr == (_fp = fopen(path, "rb")) && path[0] == '/') ++path;
        return _fp != nullptr;
    }
    int read(uint8_t* buf, uint32_t len) override { return (int)fread(buf, 1, len, _fp); }
    void skip(int32_t offset) override { fseek(_fp, offset, SEEK_CUR); }
    bool seek(uint32_t offset) override { return fseek(_fp, offset, SEEK_SET) == 0; }
    void close(void) override {
        if (_fp) {
            fclose(_fp);
            _fp = nullptr;
        }
    }
    int32_t tell(void) override { return ftell(_fp); }

private:
    FILE* _fp = nullptr;
};

