#include "JSBindings.h"
#include "esp_heap_caps.h"
#include "../USBDevice/LogSink.h"
#include "../Display/Layout.h"
#include "../FileSystem/FileSystem.h"
#include "../UI/Keyboard.h"
#include "../WebManager/WebManager.h"
#include "../WebManager/WebAuth.h"
#include "../Kernel/TimeManager.h"
#include "../Utils/StrUtils.h"
#include "../Utils/PinStore.h"
#include "HttpClient.h"
#include "SystemInfo.h"
#include "esp_task_wdt.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_rom_md5.h"
#include "../Kernel/Core/CelerKernel.h"
#include "../Display/Backlight.h"
#include "../Display/Theme.h"
#include "../Display/Icon.h"
#include "../OTA/OtaManager.h"
#include "../Launcher/LauncherUI.h"
#include "../Launcher/Screens.h"
#include <lgfx/v1/misc/DataWrapper.hpp>
#include "JsInternal.h"
#include "JsFsJail.h"

// =====================================================
// Network Bindings - HTTP (objeto Net, API level 2)
// =====================================================

// Custo de memoria: o TLS (https) pede ~45KB de heap durante a chamada,
// concorrendo com o heap do Duktape — respostas grandes podem estourar o
// ~90KB do runtime JS. Limitar payloads a dezenas de KB.
#define NET_MAX_BODY 32768

// URL absurda (app hostil) vira std::string dentro do HttpClient (cada copia
// cresce sem excecoes e ABORTA no heap apertado da CYD): teto com RangeError
// pre-formatado. 2 KB cobre qualquer URL real com query longa.
#define NET_MAX_URL 2048

// O duk_require_string fica NO BINDING (o app_lint infere a aridade minima
// dos corpos e um helper proprio esconderia o argumento obrigatorio).
static const char* netCheckUrl(duk_context* ctx, const char* url) {
    if (strlen(url) > NET_MAX_URL) {
        duk_error(ctx, DUK_ERR_RANGE_ERROR, "Net: URL longa demais (max 2048)");
    }
    return url;
}

// Corpo no JsBodySink do JsInternal.h (teto NET_MAX_BODY aplicado no
// stream, malloc/realloc — ver comentario do helper).

// Executa GET/POST e EMPILHA o body (string). false = falhou (nada
// empilhado). Sem WiFi conectado: duk_error (o script ve um erro legivel em
// vez de um null silencioso).
static bool netFetch(duk_context *ctx, bool isPost) {
    JSBindings::present();  // "Carregando..." do app aparece durante a requisicao
    jsRequireWifi(ctx, "Net");
    const char *url = netCheckUrl(ctx, duk_require_string(ctx, 0));

    std::string body;
    std::string contentType = "text/plain";
    if (isPost) {
        size_t blen = 0;
        const char* b = duk_require_lstring(ctx, 1, &blen);
        // corpo do POST e copiado para std::string (HttpClient): teto evita
        // que um app hostil derrube o aparelho no crescimento sem excecoes
        if (blen > 64 * 1024) {
            duk_error(ctx, DUK_ERR_RANGE_ERROR, "Net.post: corpo acima de 64KB");
        }
        body.assign(b, blen);
        if (duk_is_string(ctx, 2)) contentType = duk_get_string(ctx, 2);
    }

    // Componente Http (esp_http_client): https usa o cert bundle do sistema
    JsBodySink<NET_MAX_BODY> got;
    bool ok;
    char failWhy[64] = "";  // copia: o HttpResponse morre no fim do bloco
    {
        HttpClient http;
        http.setTimeout(10000);
        http.setBodySink([&got](const char* d, size_t len) { return got.append(d, len); });
        HttpResponse resp = isPost ? http.post(url, body, contentType) : http.get(url);
        ok = resp.isOk();
        if (!ok) snprintf(failWhy, sizeof(failWhy), "%s", resp.errorMessage.c_str());  // diagnostico (log)
    }  // TLS/cliente liberados antes de copiar o corpo para o heap JS
    // A requisicao inteira rodou sem bytecode: a janela do exec-timeout
    // (aberta pelo present() de entrada) vence em 1s e o RangeError matava
    // o app logo apos o retorno — TLS sozinho passa disso. Mesma familia
    // do fix do Net.download.
    CelerKernel::noteAppYield();
    if (!ok) {
        celer_log_printf("[net] get falhou: why=%s internal=%u\n",
                         failWhy[0] ? failWhy : "?",
                         (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
        free(got.p);
        return false;
    }
    // Copia para o heap JS protegida: sem RAM o Duktape lanca (longjmp) — o
    // buffer C e liberado antes de repassar o erro ao script (helper
    // jsPushOwnedString do JsInternal.h)
    return jsPushOwnedString(ctx, got.p, got.n) == 1;
}

duk_ret_t JSBindings::js_netGet(duk_context *ctx) {
    if (!netFetch(ctx, false)) duk_push_null(ctx);
    return 1;
}

duk_ret_t JSBindings::js_netGetJSON(duk_context *ctx) {
    if (!netFetch(ctx, false)) { duk_push_null(ctx); return 1; }
    duk_json_decode(ctx, -1);  // parse falho vira erro visivel no script
    return 1;
}

duk_ret_t JSBindings::js_netPost(duk_context *ctx) {
    if (!netFetch(ctx, true)) duk_push_null(ctx);
    return 1;
}

// API 6: download em streaming direto para arquivo — o corpo NAO passa pela
// heap do Duktape (chunk a chunk vai pro FILE*), entao nao sofre o teto de
// 32KB do Net.get. Uso: Net.download(url, path[, onProgress]) -> true|false;
// onProgress(bytes, total) por chunk (total = -1 se o server nao mandou
// Content-Length). O callback roda DENTRO do esp_http_client: duk_pcall para
// um erro de script nao estourar o longjmp no meio do download.
duk_ret_t JSBindings::js_netDownload(duk_context *ctx) {
    JSBindings::present();  // "Carregando..." do app aparece durante a requisicao
    jsRequireWifi(ctx, "Net");
    const char *url = netCheckUrl(ctx, duk_require_string(ctx, 0));
    const char *path = duk_require_string(ctx, 1);
    // Grava no FS: mesma capability e mesmo jail do FS.writeFile. Antes so
    // "net" bastava e o destino era livre (ota_url.txt, main.js de app de
    // sistema...).
    if (!perm(celer::PERM_FS)) {  // lint-perm: fs
        duk_error(ctx, DUK_ERR_ERROR, "Net.download requer permissao \"fs\"");
    }
    if (!fsWriteAllowed(path)) {
        char msg[176];  // pre-formatado: duk_error com %s em lightfunc corrompe o heap
        snprintf(msg, sizeof(msg), "Net.download: destino %s nao permitido", path);
        jsThrowMsg(ctx, DUK_ERR_ERROR, msg);
    }
    // "<path>.part" em buffer de pilha: path absurdo (app hostil) virava
    // std::string que aborta o aparelho no -fno-exceptions
    if (strlen(path) > kJsPathMax) {
        duk_error(ctx, DUK_ERR_RANGE_ERROR, "Net.download: caminho longo demais");
    }
    const bool hasProgress = duk_is_function(ctx, 2);

    // Baixa ao lado e so troca no sucesso: o "wb" do downloadToFile zerava
    // o arquivo existente ANTES da requisicao (404/sem rede = arquivo perdido)
    char part[kJsPathMax + 8];
    snprintf(part, sizeof(part), "%s.part", path);
    bool exitReq = false;  // X/exit pedido de dentro do callback

    HttpClient http;
    http.setTimeout(15000);
    http.setBufferSize(4096);  // chunk maior = menos chamadas do callback
    // callback SEMPRE presente: o reset do watchdog por chunk cobre o
    // download sem progress (o loop do app nao roda enquanto isso)
    http.setProgressCallback([ctx, hasProgress, &exitReq](int64_t got, int64_t total) {
        esp_task_wdt_reset();
        // Chunk recebido e cedida de rede: cada um renova a janela do
        // exec-timeout (present() so roda UMA vez, no inicio do binding — um
        // download de app grande passava de 1s e o executor matava a loja com
        // RangeError "execution timeout" DEPOIS de engolir o mesmo erro nos
        // callbacks deste duk_pcall; o arquivo chegava inteiro, mas o app
        // morria no meio da instalacao).
        CelerKernel::noteAppYield();
        if (!hasProgress || exitReq) return;
        duk_dup(ctx, 2);  // funcao segue no stack (arg 2 da chamada)
        duk_push_number(ctx, (duk_double_t)got);
        duk_push_number(ctx, (duk_double_t)total);
        if (duk_pcall(ctx, 2) != DUK_EXEC_SUCCESS) {
            // saida limpa (X/System.exitApp) nao pode morrer no pcall: o
            // app sai quando o download devolver o controle
            if (duk_is_error(ctx, -1)) {
                duk_get_prop_string(ctx, -1, "celerExit");
                exitReq = duk_to_boolean(ctx, -1) != 0;
                duk_pop(ctx);
            }
        }
        duk_pop(ctx);  // resultado ou erro
    });
    HttpResponse resp = http.downloadToFile(url, part);
    // Sem progresso (DNS/TLS/handshake parado ate o timeout de 15s) nenhum
    // chunk renovou a janela: o retorno cairia no RangeError do executor
    // mesmo com o arquivo baixado. Renova AQUI, antes do rename/retorno.
    CelerKernel::noteAppYield();
    bool ok = resp.isOk() && FileSystem::renameFile(part, path);
    if (!ok) FileSystem::deleteFile(part);
    if (exitReq) throwAppExit(ctx);
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_netIsConnected(duk_context *ctx) {
    duk_push_boolean(ctx, WebManager::isWifiConnected());
    return 1;
}

// ---- Net assincrono (F3): handle + poll, no estilo keypadOpen/keypadPoll -
//
// Sem Promise no Duktape, a API de cooperacao e explicita:
//   var h = Net.beginGet(url);        // -1 se sem slot/WiFi
//   var r = Net.pollGet(h);           // null = rodando; {done,ok,status,
//                                     //  body,error} quando termina
//   Net.cancelGet(h);                 // abandona: o proximo pollGet concluido
//                                     // devolve {ok:false,error:"cancelado"}
//                                     // e libera o slot (a task zumbi roda
//                                     // ate o timeout dela, so que descartada)
// A requisicao roda em task propria: o app continua desenhando/respondendo
// enquanto o HTTP/TLS resolve. Pool de 2 slots; cada slot ocupa a task so
// durante a requisicao (timeout 10s).
//
// Concorrencia (S3 e dual-core): um mutex por slot e UM unico escritor —
// a task dona escreve resultado/estado sob lock; o beginGet so prepara o
// slot quando nenhuma task esta viva (state 0); o pollGet so transita
// 2->0. Antes o cancelGet liberava o slot com a task ainda escrevendo e o
// beginGet reusava o slot: duas tasks no mesmo std::string.
struct NetAsyncSlot {
    SemaphoreHandle_t mux = nullptr;  // criado no 1o uso (beginGet/reset)
    int state = 0;                    // 0=livre 1=task rodando 2=resultado pronto
    bool discard = false;             // cancelGet/reset: resultado sera descartado
    bool ok = false;
    int status = 0;
    std::string url;                  // imutavel enquanto state==1
    char* body = nullptr;             // malloc (NetBody), escrito SO pela task (1->2)
    size_t bodyLen = 0;
    char error[64] = {0};
};
static NetAsyncSlot s_netAsync[2];

// Chamado no lancamento de cada app: zumbis do app anterior descartam,
// resultados nao consumidos sao liberados. O slot nunca atravessa apps.
void JSBindings::netAsyncReset() {
    for (NetAsyncSlot& s : s_netAsync) {
        if (!jsSlotMuxTake(s)) continue;
        s.discard = true;
        if (s.state == 2) {
            s.state = 0;
            jsSlotFreeBody(s);
        }
        xSemaphoreGive(s.mux);
    }
}

static void netAsyncTask(void* raw) {
    NetAsyncSlot* s = (NetAsyncSlot*)raw;
    // Corpo no mesmo sink do Net.get: teto de 32 KB APLICADO durante o
    // download (antes o corpo inteiro crescia num std::string e so depois
    // era cortado — uma resposta grande esgotava o heap)
    JsBodySink<NET_MAX_BODY> got;
    bool ok;
    int status;
    char err[64];
    {
        HttpClient http;
        http.setTimeout(10000);
        http.setBodySink([&got](const char* d, size_t len) { return got.append(d, len); });
        HttpResponse resp = http.get(s->url.c_str());
        ok = resp.isOk();
        status = resp.statusCode;
        snprintf(err, sizeof(err), "%s", resp.success ? "" : resp.errorMessage.c_str());
    }  // TLS/cliente liberados antes de publicar o resultado
    jsSlotPublish(*s, got.p, got.n, ok, status, err);
    vTaskDelete(nullptr);
}

duk_ret_t JSBindings::js_netBeginGet(duk_context *ctx) {
    const char* url = netCheckUrl(ctx, duk_require_string(ctx, 0));
    if (!WebManager::isWifiConnected()) {
        celer_log_println("[net] beginGet -1: wifi fora (state)");
        duk_push_int(ctx, -1);
        return 1;
    }

    for (int i = 0; i < 2; i++) {
        NetAsyncSlot& s = s_netAsync[i];
        if (!jsSlotMuxTake(s)) continue;
        if (s.state == 1) {  // task viva (rodando ou zumbi cancelado)
            xSemaphoreGive(s.mux);
            celer_log_printf("[net] beginGet -1: slot %d ocupado (state 1)\n", i);
            continue;
        }
        // state 0 (livre) ou 2 (resultado nao consumido): reusa
        s.discard = false;
        s.ok = false;
        s.status = 0;
        jsSlotFreeBody(s);
        s.error[0] = '\0';
        s.url = url;  // nenhuma task viva: seguro reescrever
        s.state = 1;
        xSemaphoreGive(s.mux);

        // Stack de 24KB: o caminho assincrono roda o MESMO HttpClient/TLS do
        // Net.get (que execute na main de ~27KB TOTAL, com UI junto; aqui so
        // http) — 12KB estourava o handshake ("UNKNOWN ERROR") e 32KB nao
        // nascia (xTaskCreate falhava com a RAM interna da arvore API 17,
        // bancada 2026-10-02). Boards sem PSRAM nao abrem apps com "net".
        if (xTaskCreate(netAsyncTask, "jsnet", 24576, &s, 3, nullptr) != pdPASS) {
            celer_log_println("[net] beginGet -1: xTaskCreate falhou (RAM p/ stack de 24KB)");
            // task nao nasceu: nada escrevera o slot, devolve ao estado livre
            jsSlotMuxTake(s);
            if (s.state == 1) s.state = 0;
            xSemaphoreGive(s.mux);
            break;
        }
        duk_push_int(ctx, i);
        return 1;
    }
    duk_push_int(ctx, -1);
    return 1;
}

// Monta {done,ok,status,body,error} — em duk_safe_call: sem RAM o Duktape
// lanca e o corpo (malloc) ainda precisa ser liberado pelo chamador
struct NetPollResult {
    bool ok;
    int status;
    const char* body;
    size_t bodyLen;
    const char* error;
};

static duk_ret_t netPushPoll(duk_context *ctx, void *udata) {
    const NetPollResult* r = (const NetPollResult*)udata;
    duk_push_object(ctx);
    putBool(ctx, "done", 1);
    putBool(ctx, "ok", r->ok);
    putInt(ctx, "status", r->status);
    putLStr(ctx, "body", r->body ? r->body : "", r->bodyLen);  // corpo pode conter NUL
    putStr(ctx, "error", r->error);
    return 1;
}

duk_ret_t JSBindings::js_netPollGet(duk_context *ctx) {
    int h = duk_require_int(ctx, 0);
    if (h < 0 || h >= 2) { duk_push_null(ctx); return 1; }
    NetAsyncSlot& s = s_netAsync[h];
    if (!jsSlotMuxTake(s)) { duk_push_null(ctx); return 1; }
    if (s.state != 2) {
        xSemaphoreGive(s.mux);
        duk_push_null(ctx);
        return 1;  // ainda rodando
    }

    // Toma posse do resultado sob o lock (sem copia/malloc: antes um malloc
    // falho virava {ok:true, body:""}) e monta o objeto fora dele
    char errBuf[64];
    NetPollResult r{s.ok, s.status, s.body, s.bodyLen, errBuf};
    snprintf(errBuf, sizeof(errBuf), "%s", s.error);
    s.body = nullptr;
    s.bodyLen = 0;
    s.state = 0;  // slot liberado para o proximo beginGet
    xSemaphoreGive(s.mux);

    char* owned = (char*)r.body;
    duk_int_t rc = duk_safe_call(ctx, netPushPoll, &r, 0, 1);
    free(owned);
    if (rc != DUK_EXEC_SUCCESS) duk_throw(ctx);
    return 1;
}

duk_ret_t JSBindings::js_netCancelGet(duk_context *ctx) {
    int h = duk_require_int(ctx, 0);
    if (h < 0 || h >= 2) return 0;
    // Nao mata a task (matar no meio do TLS vaza): marca como descartavel —
    // quando a task terminar (timeout 10s no pior caso) ela mesma grava o
    // resultado "cancelado" e libera o slot
    NetAsyncSlot& s = s_netAsync[h];
    if (jsSlotMuxTake(s)) {
        if (s.state == 1) s.discard = true;
        xSemaphoreGive(s.mux);
    }
    return 0;
}
