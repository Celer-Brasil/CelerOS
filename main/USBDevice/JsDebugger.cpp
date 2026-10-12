#include "JsDebugger.h"
#include "HostLink.h"
#include "LogSink.h"

#include "freertos/FreeRTOS.h"
#include "freertos/stream_buffer.h"
#include "esp_task_wdt.h"
#include "esp_heap_caps.h"
#include "Launcher/LauncherUI.h"

#include <string.h>

// ---------------------------------------------------------------------------
// Debug do Duktape sobre o canal do celerctl. O protocolo do debugger e
// binario (dmsg) e viaja inteiro dentro de frames KL_DEBUG_DATA; as duas
// pontas vivem em tasks DIFERENTES (dbg_link produz, a task do app consome
// dentro do executor), entao o sentido host->device e um StreamBuffer.
// O executor checa o debugger pelo MESMO interrupt counter do exec-timeout:
// pausado (attach, breakpoint, step) ele fica no read esperando comandos, e
// com o debugger attachado o exec-timeout nao dispara (pausa e laco
// inspecionado nao viram RangeError).
//
// Suporte por placa: Kconfig CELEROS_JS_DEBUGGER (celeros_fixup.h liga o
// DUK_USE_DEBUGGER_SUPPORT e o fileName por funcao que os breakpoints
// exigem). O handshake e UNILATERAL: duk_debugger_attach so ESCREVE a linha de
// versao do target, nunca le nada do cliente — qualquer byte "de versao"
// do cliente vira initial byte invalido e derruba a sessao (Detaching 1).
// Por isso o gate do attach e a flag s_client (KL_DEBUG_CTL do proxy depois
// do accept), nunca bytes no buffer. Sem o suporte tudo vira stub e a flag
// `debug on` avisa.
// ---------------------------------------------------------------------------

#if defined(DUK_USE_DEBUGGER_SUPPORT)

namespace {

constexpr size_t K_DBG_RX = 4096;  // host -> device (mensagens do cliente)

volatile bool s_request = false;
volatile bool s_client = false;  // proxy com cliente TCP conectado
volatile bool s_attached = false;
duk_context* s_ctx = nullptr;
StreamBufferHandle_t s_rx = nullptr;
char s_appPath[160] = "";  // main.js do app em execucao (noteApp)

// Cria o buffer host->device UMA vez mesmo com as duas tasks (feedHost na
// task do link, attach na task do app) chegando juntas: sem a guarda, a
// interleave criava dois handles — o perdedor vazava 4 KB e bytes ja
// escritos nele ficavam presos (dessincroniza o dmsg binario).
portMUX_TYPE s_rxMux = portMUX_INITIALIZER_UNLOCKED;
StreamBufferHandle_t ensureRx() {
    StreamBufferHandle_t rx = s_rx;
    if (rx != nullptr) return rx;
    StreamBufferHandle_t fresh = xStreamBufferCreate(K_DBG_RX, 1);
    if (fresh == nullptr) return nullptr;
    taskENTER_CRITICAL(&s_rxMux);
    rx = s_rx;
    if (rx == nullptr) {
        s_rx = rx = fresh;
        taskEXIT_CRITICAL(&s_rxMux);
        return fresh;
    }
    taskEXIT_CRITICAL(&s_rxMux);
    vStreamBufferDelete(fresh);  // outra task criou antes: a nossa sobra sai
    return rx;
}
// Uma sessao por EXECUCAO de app: o Detach do cliente (`q`) nao pode ser
// desfeito pelo maybeAttach do proximo yield do mesmo app (re-attach =
// pausa de novo); o app seguinte (run id novo) attacha normalmente
uint32_t s_runId = 0;
uint32_t s_attachedRun = UINT32_MAX;

// Bloqueante enquanto o cliente existir: read devolvendo 0 significa ERRO
// DE TRANSPORTE (o debugger desattacha). Pausado num breakpoint o executor
// fica aqui esperando o proximo comando — o TWDT da task do app e
// alimentado a cada fatia. Cliente sumiu (DEBUG_CTL 0): devolve 0, o
// Duktape desattacha e o app volta a rodar em vez de ficar pendurado.
size_t dbgRead(void* udata, char* buf, size_t len) {
    (void)udata;
    if (s_rx == nullptr || len == 0) return 0;
    while (s_client) {
        size_t got = xStreamBufferReceive(s_rx, buf, len, pdMS_TO_TICKS(200));
        if (got > 0) return got;
        esp_task_wdt_reset();
    }
    return 0;
}

// Dados disponiveis sem consumir (o executor pergunta a cada cooperate).
duk_size_t dbgPeek(void* udata) {
    (void)udata;
    if (s_rx == nullptr) return 0;
    return xStreamBufferBytesAvailable(s_rx);
}

// Device -> host: frame KL_DEBUG_DATA pelo canal da sessao ativa. Sem
// cliente (proxy fechou) e erro de transporte: o Duktape desattacha em vez
// de mandar frames binarios para um canal que ja voltou a ser console.
duk_size_t dbgWrite(void* udata, const char* buf, size_t len) {
    (void)udata;
    if (!s_client) return 0;
    if (!HostLink::sendDebugFrame((const uint8_t*)buf, len)) return 0;
    return len;
}

// AppRequest do cliente (comando 0x22): primeiro valor = nome do pedido.
//   "restart" -> fecha o app e o relanca (codigo novo do disco; o cliente
//                reabre os breakpoints na sessao seguinte)
//   "info"    -> [main.js, heap livre, maior bloco livre] em bytes
// Roda na task do app, dentro do processamento de mensagens do Duktape.
duk_idx_t dbgRequest(duk_context* ctx, void* udata, duk_idx_t nvalues) {
    (void)udata;
    const char* what = nvalues > 0 ? duk_get_string(ctx, -nvalues) : nullptr;
    if (what != nullptr && strcmp(what, "restart") == 0) {
        if (s_appPath[0] == '\0') {
            duk_push_string(ctx, "app desconhecido");
            return -1;
        }
        char dir[sizeof(s_appPath)];
        memcpy(dir, s_appPath, sizeof(dir));
        char* slash = strrchr(dir, '/');
        if (slash != nullptr && slash != dir) *slash = '\0';  // pasta do app
        LauncherUI::requestRescan();
        LauncherUI::requestLaunch(dir);
        LauncherUI::requestAppExit();  // efetiva no proximo yield do app
        duk_push_string(ctx, dir);
        return 1;
    }
    if (what != nullptr && strcmp(what, "info") == 0) {
        duk_push_string(ctx, s_appPath);
        duk_push_uint(ctx, (duk_uint_t)heap_caps_get_free_size(MALLOC_CAP_8BIT));
        duk_push_uint(ctx, (duk_uint_t)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
        return 3;
    }
    duk_push_string(ctx, "pedido desconhecido (restart|info)");
    return -1;
}

// Sessao caiu (cliente desconectou/erro de transporte): o estado local
// acompanha — duk_debugger_attached() nao e API publica no 2.7.
void dbgDetached(duk_context* ctx, void* udata) {
    (void)ctx; (void)udata;
    s_attached = false;
    s_ctx = nullptr;
    celer_log_println("debugger JS: sessao encerrada");
}

}  // namespace

namespace JsDebugger {

void setRequested(bool on) {
    s_request = on;
    if (!on) s_client = false;
    celer_log_printf("debugger JS: %s (vale para o proximo app lancado)\n",
                     on ? "armado" : "desarmado");
}

bool requested() { return s_request; }

void noteApp(const char* mainPath) {
    s_runId++;
    strncpy(s_appPath, mainPath != nullptr ? mainPath : "", sizeof(s_appPath) - 1);
    s_appPath[sizeof(s_appPath) - 1] = '\0';
}

void setClient(bool on) {
    if (!on && !s_client && !s_request) return;  // fim de sessao sem debugger
    s_client = on;
    s_request = on;
    if (on) s_attachedRun = UINT32_MAX;  // cliente novo pode attachar o app que ja roda
    celer_log_printf("debugger JS: cliente %s\n", on ? "conectado (attach no proximo app/yield)" : "saiu");
}

bool attach(duk_context* ctx) {
    if (ctx == nullptr) return false;
    if (ensureRx() == nullptr) return false;
    // o attach PAUSA o app e o executor passa a esperar comandos: sem
    // cliente do outro lado o app ficaria parado. So attacha com o proxy
    // avisando que ha cliente — o runFile tenta primeiro e o present() do
    // JSBindings da a segunda chance no proximo yield do app
    if (!s_request || !s_client || s_attachedRun == s_runId) return false;
    // o cliente so fala depois da linha de versao: o que estiver no buffer
    // e resto da sessao anterior (comando mandado depois do detach) e viraria
    // a 1a mensagem desta
    xStreamBufferReset(s_rx);
    duk_debugger_attach(ctx, dbgRead, dbgWrite, dbgPeek,
                        nullptr, nullptr, dbgRequest, dbgDetached, nullptr);
    s_ctx = ctx;
    s_attached = true;
    s_attachedRun = s_runId;
    celer_log_println("debugger JS: attachado (celerctl debug no outro lado)");
    return true;
}

void detach(duk_context* ctx) {
    if (ctx == nullptr || !s_attached || ctx != s_ctx) return;
    duk_debugger_detach(ctx);
    s_attached = false;
    s_ctx = nullptr;
    celer_log_println("debugger JS: desattachado");
}

bool maybeAttach(duk_context* ctx) {
    if (ctx == nullptr) return false;
    // proxy fechou com o app rodando: desattacha aqui, na task do app (o
    // Duktape nao e thread-safe — o link so derruba a flag)
    if (s_attached && !s_client) {
        detach(ctx);
        return false;
    }
    if (s_attached || !s_request) return false;
    return attach(ctx);
}

bool attached(duk_context* ctx) {
    return s_attached && ctx != nullptr && ctx == s_ctx;
}

void feedHost(const uint8_t* data, size_t n) {
    if (data == nullptr || n == 0) return;
    // o buffer pode ser criado aqui (task do link): comandos que chegarem
    // antes do attach esperam no buffer
    StreamBufferHandle_t rx = ensureRx();
    if (rx == nullptr) return;
    // cheio = o app nao esta consumindo (rodando sem cooperar) e o cliente
    // despeja comandos: byte perdido dessincroniza o dmsg — melhor avisar
    if (xStreamBufferSend(rx, data, n, pdMS_TO_TICKS(100)) != n) {
        celer_log_println("debugger JS: buffer de comandos cheio, bytes perdidos");
    }
}

}  // namespace JsDebugger

#else  // !DUK_USE_DEBUGGER_SUPPORT — stubs (infra compilada, suporte off)

namespace JsDebugger {

void setRequested(bool) {
    celer_log_println("debugger JS: suporte nao compilado neste firmware "
                      "(Kconfig CELEROS_JS_DEBUGGER)");
}
bool requested() { return false; }
void setClient(bool) {}
void noteApp(const char*) {}
bool attach(duk_context*) { return false; }
void detach(duk_context*) {}
bool maybeAttach(duk_context*) { return false; }
bool attached(duk_context*) { return false; }
void feedHost(const uint8_t*, size_t) {}

}  // namespace JsDebugger

#endif  // DUK_USE_DEBUGGER_SUPPORT
