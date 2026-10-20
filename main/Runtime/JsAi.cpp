#include "JSBindings.h"
#include "../FileSystem/FileSystem.h"
#include "../Hardware/AudioPlayer.h"
#include "../USBDevice/LogSink.h"
#include "../Utils/StrUtils.h"
#include "../WebManager/WebManager.h"
#include "HttpClient.h"
#include "JsFsJail.h"
#include "JsInternal.h"
#include "esp_task_wdt.h"
#include "esp_memory_utils.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"  // xTaskCreateWithCaps
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "../Boards/Board.h"

// =====================================================
// AI Bindings - chat LLM (objeto AI, API level 18)
// =====================================================
//
// A chave da API NUNCA entra no JS: vive em /local/<provider>_key.txt
// (arquivo protegido pelo jail do FS, gravado pelo dono via celerctl
// push ou file manager da web) e e lida aqui a cada requisicao — trocar
// a chave nao pede reboot (mesma filosofia do /local/ota_url.txt).
//
// Formato OpenAI-compatible (DeepSeek e OpenRouter falam o mesmo schema):
// AI.chat(opts, cb) serializa o propio opts com duk_json_encode (o C++ so
// fixa stream:false e injeta defaults) — nenhuma montagem manual de JSON,
// nenhum escape de aspas do usuario. opts.provider escolhe a casa ("deepseek"
// default, "openrouter" para o app Qwen e afins); o campo sai do payload.
//
// O POST roda em task propria (padrao do Net assincrono em JsNet.cpp) e
// o resultado e entregue ao callback no present() (padrao dos timers em
// JsTimers.cpp: funcao no heap stash, duk_pcall; erro de script PROPAGA
// como erro do app).
//
// Function calling (API 20): `tools`/`tool_choice` no opts ja atravessam
// o duk_json_encode sem toque nosso — o que entra aqui de novo e o parse
// da resposta: choices[0].message.tool_calls vira r.toolCalls
// ([{id,name,args}]; args decodificado quando e JSON valido) e
// choices[0].finish_reason vira r.finishReason ("tool_calls" ou "stop").
//
// Fala (API 24, AI.speak): texto -> audio pelo /audio/speech do OpenRouter
// (gemini TTS) com response_format "pcm" (s16le mono 24 kHz, mesma taxa do
// generateContent nativo do Google — constante AI_TTS_RATE, unica coisa a
// trocar se a hub mudar). O corpo binario NAO passa pela RAM: o BodySink
// toca os chunks AO VIVO (AudioPlayer::PcmFeed) e so grava o .wav quando
// o app pede (opts.save), quando opts.play e false ou quando o alto-falante
// estava ocupado no 1o byte (fallback: arquivo + playWav no fim). O
// arquivo leva header WAV de 44 B com tamanhos remendados no fim, como o
// Net.download. Download E playback acontecem NA WORKER: o JS segue livre
// (boca do cao animando), o cancel corta a fala no chunk
// (AudioPlayer::requestStop).

// Cert (*.deepseek.com, Amazon RSA 2048 / *.openrouter.ai, GTS) ja esta no
// cert bundle FULL e CMN — nenhuma board precisa de PEM custom.
struct AiProvider {
    const char* id;           // nome no opts.provider
    const char* url;
    const char* keyFile;
    const char* defaultModel;
    const char* referer;      // atribuicao opcional (OpenRouter): null = nao ha
    const char* title;
    const char* ttsUrl;       // /audio/speech (AI.speak): null = casa sem TTS
    const char* ttsModel;
    const char* warmUrl;      // GET pequeno e autenticado (AI.warm): abre o TLS
};
static const AiProvider AI_PROVIDERS[] = {
    {"deepseek", "https://api.deepseek.com/chat/completions",
     "/local/deepseek_key.txt", "deepseek-flash", nullptr, nullptr,
     nullptr, nullptr, "https://api.deepseek.com/user/balance"},
    {"openrouter", "https://openrouter.ai/api/v1/chat/completions",
     "/local/openrouter_key.txt", "qwen/qwen3.8-omni-flash",
     "https://os.celer.tec.br", "CelerOS",
     "https://openrouter.ai/api/v1/audio/speech", "google/gemini-3.8-flash-lite-tts",
     "https://openrouter.ai/api/v1/key"},
};
static const AiProvider& aiProviderByName(const char* name) {
    // null/undefined/deepseek = [0]; nome desconhecido tambem cai no [0]
    // (o chat valida e lanca antes de chegar aqui)
    for (const AiProvider& p : AI_PROVIDERS) {
        if (name == nullptr || strcmp(name, p.id) == 0) return p;
    }
    return AI_PROVIDERS[0];
}

// Nome (ou null = default) pertence a tabela de providers?
static bool aiProviderKnown(const char* name) {
    for (const AiProvider& p : AI_PROVIDERS) {
        if (name == nullptr || strcmp(name, p.id) == 0) return true;
    }
    return false;
}

// duk_error SEM varargs (regra do projeto: argumentos de conversao em
// lightfunc corrompem o heap) — mensagem pre-formatada com snprintf
static void aiThrow(duk_context* ctx, const char* fmt, const char* a) {
    char msg[110];
    snprintf(msg, sizeof(msg), fmt, a != nullptr ? a : "?");
    jsThrowMsg(ctx, DUK_ERR_ERROR, msg);
}

// Teto do corpo da resposta (mesmo sink malloc/realloc do Net.get: sem
// RAM a requisicao falha limpa em vez de abortar o aparelho). Com o
// default de max_tokens 1024 a resposta tipica fica em poucos KB.
#define AI_MAX_BODY 32768

// Completions demoradas passam com folga dos 10s do Net.post. O omni
// responde em 5-15 s na pratica; 60 s segura os casos lentos sem deixar
// uma requisicao orfa (app fechado no meio) travar o worker por muito tempo.
#define AI_TIMEOUT_MS 60000

// TTS: a resposta "pcm" do gemini e s16le MONO 24 kHz (mesma taxa do
// generateContent nativo do Google). Taxa da fala longa cabe no LittleFS
// (48 KB/s): 300 chars de texto ~= 20 s ~= 960 KB — teto do texto do speak.
#define AI_TTS_RATE 24000
#define AI_TTS_MAX_TEXT 300
// Fila da voz ao vivo (aiRunSpeak/PcmFeed): capacidade = Content-Length,
// teto AI_TTS_MAX_PCM = 300 chars ~ 20 s a 48 KB/s, na PSRAM.
#define AI_TTS_MAX_PCM (1200 * 1024)
// Voz default do speak (grave, persona de cao). As 30 vozes do modelo
// (Puck, Charon, Kore, Fenrir...) seguem no JS_API_Guide; voz invalida
// devolve 400 do OpenRouter com a mensagem no r.detail.
#define AI_TTS_VOICE "Charon"

// Corpo no JsBodySink do JsInternal.h (teto AI_MAX_BODY, malloc/realloc).

// Um slot serial: assistente conversa uma requisicao por vez. Estado
// guardado por mutex e UM unico escritor — a task dona publica 1->2
// (mesma disciplina de concorrencia do Net assincrono).
struct AiSlot {
    SemaphoreHandle_t mux = nullptr;  // criado no 1o uso
    int state = 0;                    // 0=livre 1=task rodando 2=resultado pronto
    bool discard = false;             // cancel/reset: resultado sera descartado
    bool ok = false;                  // HTTP 2xx
    int status = 0;
    char* body = nullptr;             // malloc (JsBodySink), escrito SO pela task (1->2)
    size_t bodyLen = 0;
    char error[96] = {0};
    // Pedido (imutavel enquanto state==1; a task libera apos o POST)
    char* payload = nullptr;
    size_t payloadLen = 0;
    char* key = nullptr;
    const AiProvider* prov = &AI_PROVIDERS[0];  // resolved no begin
    // AI.speak (API 24): pedido + resultado da fala no MESMO slot (worker
    // ramifica pelo campo). `path` viaja begin->worker->tick: no sucesso a
    // posse passa ao tick (entrega ao app e libera); no descarte a worker
    // libera (ninguem vai ler).
    bool speak = false;
    bool play = true;                 // tocar (ao vivo; arquivo no fallback)
    bool save = false;                // manter o .wav mesmo tocando ao vivo
    char* path = nullptr;             // destino do .wav (malloc)
    size_t outBytes = 0;              // PCM baixado (sem o header)
    bool played = false;              // playWav tocou ate o fim
    char detail[96] = {0};            // message do JSON de erro da API
};
static AiSlot s_aiSlot;
static bool s_aiPending = false;  // callback do app esperando resultado

// mux/body do slot vieram para o JsInternal.h (jsSlotMuxTake/jsSlotFreeBody,
// templates compartilhados com o Net assincrono)

static char* aiDupBuf(const char* src, size_t n) {
    char* p = (char*)malloc(n + 1);
    if (p == nullptr) return nullptr;
    memcpy(p, src, n);
    p[n] = '\0';
    return p;
}

static std::string aiReadKey(const AiProvider& p) {
    if (!FileSystem::exists(p.keyFile)) return std::string();
    return kstr::trim(FileSystem::readTextFile(p.keyFile));
}

// Header WAV canonico de 44 B (PCM16 mono, taxa do TTS). Escreve-se com
// dataBytes 0 no comeco do .part e remenda-se no fim, quando o total e
// conhecido — o parser do AudioPlayer aceita data truncado, mas o arquivo
// final fica valido para qualquer leitor.
static void ttsWavHeader(uint8_t h[44], uint32_t dataBytes) {
    uint32_t r = AI_TTS_RATE;
    const uint8_t proto[44] = {
        'R','I','F','F', 0,0,0,0, 'W','A','V','E',
        'f','m','t',' ', 16,0,0,0, 1,0, 1,0,
        0,0,0,0, 0,0,0,0, 2,0, 16,0,
        'd','a','t','a', 0,0,0,0
    };
    memcpy(h, proto, 44);
    auto wr32 = [](uint8_t* p, uint32_t v) {
        p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8);
        p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
    };
    wr32(h + 4, 36 + dataBytes);   // tamanho RIFF
    wr32(h + 24, r);               // sample rate
    wr32(h + 28, r * 2);           // byte rate (16-bit mono)
    wr32(h + 40, dataBytes);       // tamanho data
}

// {"error":{"message":"texto"}} do OpenRouter sem parser JSON: acha o valor
// de "message" e copia ate a aspa final (so vira r.detail — escapes crus
// nao matam ninguem). Corpo de erro e pequeno (1 registro).
static void ttsDetailFrom(const char* body, char* out, size_t outLen) {
    out[0] = '\0';
    if (body == nullptr) return;
    const char* m = strstr(body, "\"message\"");
    if (m == nullptr) return;
    m = strchr(m + 9, ':');
    if (m == nullptr) return;
    while (*m == ':' || *m == ' ') ++m;
    if (*m != '"') return;
    ++m;
    size_t i = 0;
    while (m[i] != '\0' && m[i] != '"' && i + 1 < outLen) {
        out[i] = m[i];
        ++i;
    }
    out[i] = '\0';
}

// Chamado no lancamento de cada app (JSBindings::init): a requisicao do
// app anterior e descartada e o stash com o callback morreu com o heap.
void JSBindings::aiReset() {
    s_aiPending = false;
    AiSlot& s = s_aiSlot;
    if (!jsSlotMuxTake(s)) return;
    // fala do app anterior ainda na worker: silencia na hora (o slot pode
    // estar no meio do playback, que ignora o discard sozinho)
    if (s.speak && s.state == 1) AudioPlayer::requestStop();
    s.discard = true;
    // state 1 = worker VIVA: payload/key/path sao dela (ela libera ao
    // consumir; liberar aqui seria double free/UAF). state 0/2 = ninguem
    // mais toca: devolve TUDO — o caminho "worker nao nasceu" deixava o
    // payload (centenas de KB no audio do Qwen) preso ate o proximo AI.*.
    if (s.state != 1) {
        s.state = 0;
        jsSlotFreeBody(s);
        free(s.path);
        s.path = nullptr;
        free(s.payload);
        s.payload = nullptr;
        s.payloadLen = 0;
        free(s.key);
        s.key = nullptr;
    }
    xSemaphoreGive(s.mux);
}

// Cliente HTTP PERSISTENTE da worker: chat e speak do openrouter (mesmo
// host) compartilham a MESMA conexao TLS — DNS+TCP+handshake so na 1a vez
// (segundos inteiros por pedido neste chip). Sem PSRAM o handle nao fica
// vivo entre pedidos (a RAM interna da CYD nao banca buffers+TLS parados).
// Objeto estatico (sem new: alocacao falhando aborta o aparelho); so a
// worker toca nele.
// Buffers de 8 KB DE PROPOSITO: o malloc ate SPIRAM_MALLOC_ALWAYSINTERNAL
// (4096 no cao/watch) cai na RAM INTERNA — os 4096+4096 de antes ficavam
// presos nela com o handle vivo (a interna do cao foi a 600 B e o TLS do
// pedido seguinte nao abria). Acima do teto vao para a PSRAM.
#define AI_HTTP_BUF 8192
static HttpClient s_aiHttp;
static bool s_aiHttpCfg = false;
static HttpClient& aiHttp() {
    if (!s_aiHttpCfg) {
        s_aiHttpCfg = true;
        s_aiHttp.setTimeout(AI_TIMEOUT_MS);
        s_aiHttp.setBufferSize(AI_HTTP_BUF);   // PCM/respostas em pedacos maiores
        s_aiHttp.setBufferSizeTx(AI_HTTP_BUF); // upload do base64 do audio
        s_aiHttp.setKeepHandle(Board::profile().hasPsram);
    }
    return s_aiHttp;
}

// POST com re-tentativas: o connect que NEM ABRIU (nenhum header de
// resposta, falha rapida — handshake TLS sem RAM, DNS, socket) ganha ate 2
// re-tentativas com espera crescente. Pedido que chegou a receber algo ou
// morreu por timeout NAO repete: o corpo ja pode ter ido ao sink (speak) e
// um timeout repetido segurava a voz por 3 x 60 s. Falha final descarta o
// handle persistente para o proximo pedido nunca partir de estado morto.
// (Ate 2026-10-05 o laco forcava WIFI_PS_NONE e culpava a coexistencia
// BLE: os logs mostraram mbedtls_ssl_setup -0x008D = RAM interna esgotada;
// o PS_NONE nem vale com BT ligado — "Coexist!!! ... only keep waked".)
static bool aiConnectNeverOpened(const HttpResponse& r) {
    return !r.success && r.statusCode == 0 && r.firstByteMs == 0 && r.durationMs < 10000;
}
static HttpResponse aiHttpPost(HttpClient& http, const char* url, const std::string& body) {
    HttpResponse resp = http.postJson(url, body);
    int tent = 0;
    while (aiConnectNeverOpened(resp) && tent < 2) {
        celer_log_printf("[ai] conexao nao abriu (%s): tentativa %d em %d ms (interna livre %u B)\n",
                         resp.errorMessage.c_str(), tent + 1, 500 + tent * 1000,
                         (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
        vTaskDelay(pdMS_TO_TICKS(500 + tent * 1000));
        resp = http.postJson(url, body);
        tent++;
    }
    if (!resp.success) {  // setKeepHandle(false) limpa o handle; liga de novo
        http.setKeepHandle(false);
        http.setKeepHandle(Board::profile().hasPsram);
    }
    return resp;
}

// Um POST: le o pedido do slot (state==1) e publica o resultado (state==2).
// Corpo do worker persistente abaixo.
static void aiRunRequest(AiSlot* s) {
    JsBodySink<AI_MAX_BODY> got;
    bool ok;
    int status;
    char err[96];
    {
        HttpClient& http = aiHttp();
        // o onStatus do pedido anterior (speak) nao pode sobreviver: a
        // lambda capturava locais dele ja mortos
        http.setOnStatus(nullptr);
        http.setBearerAuth(s->key ? s->key : "");
        if (s->prov->referer != nullptr) {  // atribuicao OpenRouter (opcional)
            http.setHeader("HTTP-Referer", s->prov->referer);
            http.setHeader("X-Title", s->prov->title);
        }
        http.setBodySink([&got](const char* d, size_t len) { return got.append(d, len); });
        // Pedido consumido ja na copia do corpo: o worker e o unico que toca
        // payload/key enquanto state==1 (o begin so reescreve quando ele esta
        // dormindo no semaforo). Libera o malloc ANTES do POST — o audio
        // base64 da voz (~150 KB) nao fica em dobro durante o upload.
        const size_t payloadLen = s->payloadLen;
        std::string body(s->payload ? s->payload : "", s->payloadLen);
        free(s->payload);
        s->payload = nullptr;
        s->payloadLen = 0;
        HttpResponse resp = aiHttpPost(http, s->prov->url, body);
        http.setBodySink(nullptr);  // lambda capturava `got` (local deste pedido)
        ok = resp.isOk();
        status = resp.statusCode;
        // marcos de latencia da voz/chat (logcat): conexao = DNS+TCP+TLS
        // (0 = TLS reusada); 1o byte - conexao = upload + modelo pensando
        celer_log_printf("[ai] pedido %u B: conexao %lu ms, 1o byte %lu ms, total %lu ms (HTTP %d, %u B)\n",
                         (unsigned)payloadLen, (unsigned long)resp.connectMs,
                         (unsigned long)resp.firstByteMs, (unsigned long)resp.durationMs,
                         status, (unsigned)got.n);
        // %.95s: a mensagem pode vir maior que err[96] — corta em vez de
        // acionar o -Werror=format-truncation do GCC do IDF
        snprintf(err, sizeof(err), "%.95s", resp.success ? "" : resp.errorMessage.c_str());
    }  // TLS viva no cliente persistente: o resultado publica sem ela em jogo
    free(s->key);
    s->key = nullptr;
    jsSlotPublish(*s, got.p, got.n, ok, status, err);
}

// Um POST de FALA (AI.speak), tudo na worker (o JS segue livre). O status
// 200 decide o destino ANTES do 1o byte: feed AO VIVO no I2S (a voz sai no
// comeco do download) e, so quando preciso, o .part com header WAV
// (opts.save, opts.play false, ou alto-falante ocupado -> playWav do
// arquivo no fim). Sem save o caminho ao vivo NAO toca o LittleFS: ~1 MB
// de escrita por fala (desgaste + fwrite travando o feed) saiu. Corpo de
// erro (JSON pequeno) fica na RAM e vira r.detail — nunca toca o
// alto-falante. Cancel/app fechado: o sink aborta o download no chunk
// seguinte e o requestStop corta a fala ja no I2S.
#define AI_TTS_ERR_MAX 640
static void aiRunSpeak(AiSlot* s) {
    bool ok = false;
    char err[96] = {0};
    char detail[96] = {0};
    size_t bytes = 0;
    bool played = false;

    AudioPlayer::PcmFeed feed;
    bool statusOk = false, liveOpened = false, feedOk = true;
    bool toFile = false, fileOpened = false;
    FILE* f = nullptr;
    JsBodySink<AI_MAX_BODY> errBody;
    char part[104];
    snprintf(part, sizeof(part), "%s.part", s->path);
    // Voz ao vivo: o download so ENFILEIRA no PcmFeed (player proprio, fila
    // na PSRAM) e continua descendo enquanto a voz toca. O gemini entrega o
    // PCM as vezes ABAIXO do tempo real (bancada: 19-31 KB/s, outras vezes
    // 67, contra 48 KB/s da voz), entao o inicio e CALCULADO pela taxa
    // medida (ver `pronto`). Sem Content-Length: 3 s em maos (ou o fim).
    bool started = false;
    int64_t tFirst = 0;        // 1o byte de PCM (us)
    uint32_t startMs = 0, startBufMs = 0;  // telemetria do inicio da voz
    const double kVoz = AI_TTS_RATE * 2.0;  // B/s que a voz consome
    int64_t total = -1;        // Content-Length do PCM

    // payload sai do slot antes do POST (mesma disciplina do chat)
    std::string body(s->payload ? s->payload : "{}", s->payload ? s->payloadLen : 2);
    free(s->payload);
    s->payload = nullptr;
    s->payloadLen = 0;

    // .part com header WAV (destino de arquivo: save/play false/fallback)
    auto openPart = [&]() -> bool {
        if (f != nullptr) return true;
        toFile = true;
        f = fopen(part, "wb");
        uint8_t hdr[44];
        ttsWavHeader(hdr, 0);  // tamanhos remendados no fim
        if (f != nullptr && fwrite(hdr, 1, sizeof(hdr), f) != sizeof(hdr)) {
            fclose(f);
            FileSystem::deleteFile(part);
            f = nullptr;
        }
        fileOpened = (f != nullptr);
        return fileOpened;
    };
    // O download segue durante a fala INTEIRA: sem engasgo enquanto o resto
    // descer antes da voz chegar nele — no pior ponto (o fim), tempo para
    // baixar o que falta <= duracao total da fala. Folga de 20% para a
    // taxa medida (ruidosa no comeco) e 0,4 s em maos contra o jitter. Rede
    // mais rapida que a voz: abre em ~0,4 s; rede a 30 KB/s numa fala de
    // 7 s: abre com ~metade baixada. (A 1a versao comparava com o audio EM
    // MAOS e segurava ~2 s mesmo com a rede a 67 KB/s.)
    auto pronto = [&]() -> bool {
        if (bytes == 0) return false;
        const double el = (esp_timer_get_time() - tFirst) / 1e6;
        const double emMaos = bytes / kVoz;  // s de voz baixados
        if (total <= 0) return emMaos >= 3.0;
        if ((int64_t)bytes >= total) return true;
        if (el < 0.25 || emMaos < 0.4) return false;  // taxa ainda sem sentido
        const double taxa = bytes / el;              // B/s medidos
        const double falta = (double)(total - (int64_t)bytes) / taxa;  // s
        return falta <= (total / kVoz) * 0.8;
    };

    HttpClient& http = aiHttp();
    http.setBearerAuth(s->key ? s->key : "");
    if (s->prov->referer != nullptr) {  // atribuicao OpenRouter
        http.setHeader("HTTP-Referer", s->prov->referer);
        http.setHeader("X-Title", s->prov->title);
    }
    http.setOnStatus([&](int st, int64_t len) {
        statusOk = (st == 200);
        total = len;
        if (!statusOk || s->discard) return;
        if (s->save || !s->play) {
            if (!openPart()) return;  // sink aborta: sem destino
        }
        if (!s->play) return;
        const size_t cap = (len > 0 && len <= (int64_t)AI_TTS_MAX_PCM) ? (size_t)len : AI_TTS_MAX_PCM;
        liveOpened = feed.begin(AI_TTS_RATE, cap);
        // ocupado (tom/playWav do app) ou sem RAM: arquivo + playWav no fim
        if (!liveOpened) openPart();
    });
    http.setBodySink([&](const char* d, size_t len) {
        if (s->discard) return false;  // cancel: corta o download aqui
        if (!statusOk) {               // erro da API: guarda o JSON (pequeno)
            if (errBody.n < AI_TTS_ERR_MAX) {
                errBody.append(d, len < AI_TTS_ERR_MAX - errBody.n ? len : AI_TTS_ERR_MAX - errBody.n);
            }
            return true;
        }
        if (toFile && f == nullptr) return false;  // destino de arquivo falhou
        if (bytes == 0) tFirst = esp_timer_get_time();
        bytes += len;
        // falha de fwrite (disco cheio) derruba o pedido limpo
        if (f != nullptr && fwrite(d, 1, len, f) != len) return false;
        if (liveOpened && feedOk) {
            feedOk = feed.write(d, len);  // so enfileira (o player toca)
            if (!started && pronto()) {
                started = true;
                startMs = (uint32_t)((esp_timer_get_time() - tFirst) / 1000);
                startBufMs = feed.bufferedMs();
                feed.start();
            }
        }
        AudioPlayer::feedWatchdog();  // worker do AI nao e inscrita
        return true;
    });
    HttpResponse resp = aiHttpPost(http, s->prov->ttsUrl, body);
    // lambdas capturavam locais deste pedido: nao sobrevivem no cliente
    http.setOnStatus(nullptr);
    http.setBodySink(nullptr);
    const int64_t tFim = esp_timer_get_time();
    bool inteiro = false;
    if (liveOpened) {
        if (!started && resp.isOk() && !s->discard) {  // clipe curto: tudo em maos
            startMs = (uint32_t)((tFim - tFirst) / 1000);
            startBufMs = feed.bufferedMs();
        }
        inteiro = (resp.isOk() && !s->discard && feedOk) ? feed.finish() : false;
    }
    const uint32_t starves = feed.starves(), starveMs = feed.starveMs();
    feed.end();  // player parado, canal fechado, guarda solta
    if (f != nullptr) fclose(f);
    ok = resp.isOk();
    const int status = resp.statusCode;
    snprintf(err, sizeof(err), "%.95s", resp.success ? "" : resp.errorMessage.c_str());
    free(s->key);
    s->key = nullptr;

    if (ok && bytes == 0) {
        ok = false;
        snprintf(err, sizeof(err), "resposta vazia do TTS");
    }
    if (ok && toFile && !fileOpened && !liveOpened) {
        ok = false;
        snprintf(err, sizeof(err), "abrir %.70s falhou", part);
    }
    if (!ok && errBody.n > 0 && errBody.append("", 1)) {  // NUL p/ o strstr
        ttsDetailFrom(errBody.p, detail, sizeof(detail));
    }
    free(errBody.p);

    bool keepFile = false;
    if (ok && fileOpened) {
        // tamanhos reais no header (RIFF em +4, data em +40)
        bool patched = false;
        FILE* g = fopen(part, "r+b");
        if (g != nullptr) {
            uint8_t sz[4] = {(uint8_t)bytes, (uint8_t)(bytes >> 8),
                             (uint8_t)(bytes >> 16), (uint8_t)(bytes >> 24)};
            uint8_t riff[4] = {(uint8_t)(bytes + 36), (uint8_t)((bytes + 36) >> 8),
                               (uint8_t)((bytes + 36) >> 16), (uint8_t)((bytes + 36) >> 24)};
            patched = fseek(g, 40, SEEK_SET) == 0 && fwrite(sz, 1, 4, g) == 4;
            patched = patched && fseek(g, 4, SEEK_SET) == 0 && fwrite(riff, 1, 4, g) == 4;
            fclose(g);
        }
        keepFile = patched && FileSystem::renameFile(part, s->path);
        if (!keepFile && !liveOpened) {  // o arquivo era o unico destino
            ok = false;
            snprintf(err, sizeof(err), "gravar %.70s falhou", s->path);
        }
    }
    if (fileOpened && !keepFile) FileSystem::deleteFile(part);

    if (liveOpened) {
        played = ok && inteiro;  // false = cortado (cancel) ou fila morta
    } else if (ok && keepFile && s->play && !s->discard) {
        // feed ao vivo nao abriu (alto-falante ocupado): toca do arquivo
        played = (AudioPlayer::playWav(s->path) == AudioPlayer::WavError::None);
    }
    if (keepFile && !s->save && s->play) {  // arquivo era so o fallback
        FileSystem::deleteFile(s->path);
        keepFile = false;
    }
    // telemetria da fala no logcat (mesma sonda do chat): conexao 0 ms =
    // TLS reusada do pedido anterior; bytes/48000 = duracao (s)
    // engasgos = vezes que o player ficou sem dado (rede atras da voz);
    // taxa = KB/s do PCM (a voz consome 48); voz apos = espera do 1o byte
    // ate o som (colchao calculado) e quanto audio havia em maos
    const double dlS = tFirst ? (tFim - tFirst) / 1e6 : 0;
    celer_log_printf("[ai] speak %s: %u B pcm (HTTP %d, conexao %lu ms, 1o byte %lu ms, "
                     "total %lu ms, %s%s) taxa %u KB/s, voz apos %lu ms com %lu ms em maos, "
                     "engasgos %u (%u ms), interna livre %u B\n",
                     played ? "ok" : (ok ? "sem tocar" : "falhou"),
                     (unsigned)bytes, status, (unsigned long)resp.connectMs,
                     (unsigned long)resp.firstByteMs, (unsigned long)resp.durationMs,
                     liveOpened ? "ao vivo" : "arquivo", keepFile ? ", salvo" : "",
                     (unsigned)(dlS > 0 ? bytes / dlS / 1024 : 0),
                     (unsigned long)startMs, (unsigned long)startBufMs,
                     (unsigned)starves, (unsigned)starveMs,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    if (!keepFile) {  // nada em disco: r.path vem vazio
        free(s->path);
        s->path = nullptr;
    }

    if (jsSlotMuxTake(*s)) {
        jsSlotFreeBody(*s);
        if (s->discard) {
            free(s->path);
            s->path = nullptr;
            s->ok = false;
            s->status = 0;
            s->outBytes = 0;
            s->played = false;
            snprintf(s->error, sizeof(s->error), "cancelado");
            s->detail[0] = '\0';
        } else {
            s->ok = ok;
            s->status = status;
            s->outBytes = bytes;
            s->played = played;
            snprintf(s->error, sizeof(s->error), "%s", err);
            snprintf(s->detail, sizeof(s->detail), "%s", detail);
            // s->path fica para o tick (posse transferida ao slot)
        }
        s->discard = false;
        s->state = 2;
        xSemaphoreGive(s->mux);
    } else {
        free(s->path);
        s->path = nullptr;
    }
}

// Worker PERSISTENTE (nao nasce/morre por pedido): a stack de 24KB vem da
// RAM INTERNA do xTaskCreate, e apos a 1a sessao TLS o heap interno do watch
// fragmenta a ponto de nao ter mais bloco de 24KB (bancada 2026-10-02: a
// 2a chamada devolvia "ocupado" para sempre). Nasce no 1o chat do boot e
// dorme num semaforo binario ate o proximo — custo zero entre pedidos.
static TaskHandle_t s_aiWorker = nullptr;
static SemaphoreHandle_t s_aiWork = nullptr;

// AI.warm: pedido de aquecimento FORA do slot (sob o mux do slot). O chat
// que chega durante o aquecimento NAO ve "ocupado": o give dele fica no
// semaforo binario e a worker o atende logo apos o GET.
static const AiProvider* s_aiWarmProv = nullptr;
static char* s_aiWarmKey = nullptr;

// GET pequeno e autenticado na casa do provider (saldo/limites da chave):
// deixa a conexao TLS viva no cliente persistente para o chat que vem a
// seguir — DNS+TCP+handshake (~2,2 s no cao) saem do caminho critico da
// voz e correm enquanto o dono ainda fala. Corpo descartado.
static void aiRunWarm() {
    AiSlot& s = s_aiSlot;
    if (!jsSlotMuxTake(s)) return;
    const AiProvider* prov = s_aiWarmProv;
    char* key = s_aiWarmKey;
    s_aiWarmProv = nullptr;
    s_aiWarmKey = nullptr;
    xSemaphoreGive(s.mux);
    if (prov == nullptr) {
        free(key);
        return;
    }
    HttpClient& http = aiHttp();
    http.setOnStatus(nullptr);
    http.setBearerAuth(key ? key : "");
    if (prov->referer != nullptr) {
        http.setHeader("HTTP-Referer", prov->referer);
        http.setHeader("X-Title", prov->title);
    }
    size_t n = 0;
    http.setBodySink([&n](const char*, size_t len) { n += len; return true; });
    HttpResponse r = http.get(prov->warmUrl);
    http.setBodySink(nullptr);
    free(key);
    celer_log_printf("[ai] warm %s: conexao %lu ms, total %lu ms (HTTP %d, %u B), interna livre %u B\n",
                     prov->id, (unsigned long)r.connectMs, (unsigned long)r.durationMs,
                     r.statusCode, (unsigned)n,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    if (!r.success) {  // handle morto nao fica para o chat
        http.setKeepHandle(false);
        http.setKeepHandle(Board::profile().hasPsram);
    }
}

// Conexao persistente fecha apos AI_IDLE_CLOSE_MS sem pedido: o handle
// vivo segura ~7 KB de RAM INTERNA (structs pequenas do esp_http_client,
// esp_tls e socket ficam abaixo do SPIRAM_MALLOC_ALWAYSINTERNAL; bancada
// 2026-10-05: 16 KB livres em repouso -> 9 KB com a conexao aberta) e o
// servidor derruba keep-alive ocioso de qualquer jeito. O AI.warm do wake
// word reabre a tempo do proximo comando.
#define AI_IDLE_CLOSE_MS 20000

static void aiWorker(void*) {
    bool open = false;  // handle persistente com conexao (ou tentativa) viva
    for (;;) {
        if (xSemaphoreTake(s_aiWork, open ? pdMS_TO_TICKS(AI_IDLE_CLOSE_MS) : portMAX_DELAY) != pdTRUE) {
            HttpClient& http = aiHttp();
            http.setKeepHandle(false);  // fecha TLS + libera o handle
            http.setKeepHandle(Board::profile().hasPsram);
            open = false;
            celer_log_printf("[ai] conexao ociosa fechada (interna livre %u B)\n",
                             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
            continue;
        }
        open = Board::profile().hasPsram;  // qualquer pedido abaixo deixa o handle vivo
        aiRunWarm();  // no-op sem pedido de aquecimento
        // Acordar nao implica pedido (warm, give atrasado): so roda com o
        // slot em 1. speak e fixado no begin ANTES do state 1 (sob lock)
        bool run = false;
        if (jsSlotMuxTake(s_aiSlot)) {
            run = (s_aiSlot.state == 1);
            xSemaphoreGive(s_aiSlot.mux);
        }
        if (!run) continue;
        if (s_aiSlot.speak) aiRunSpeak(&s_aiSlot);
        else aiRunRequest(&s_aiSlot);
    }
}

// Cria a worker (1x por boot). false = sem RAM para a stack.
static bool aiEnsureWorker() {
    if (s_aiWork == nullptr) s_aiWork = xSemaphoreCreateBinary();
    if (s_aiWork != nullptr && s_aiWorker == nullptr) {
        // Stack de 24KB: mesma do Net assincrono (JsNet) — o TLS do
        // handshake nao cabe em 12KB (bancada 2026-10-02). A worker nasce
        // UMA vez e dorme entre pedidos (ver aiWorker); a falha de
        // nascimento so ocorre no 1o pedido do boot, com o heap inteiro.
        TaskHandle_t h = nullptr;
        BaseType_t okc = pdFAIL;
        if (Board::profile().hasPsram) {
            // Stack na PSRAM nas placas que tem (S3 do cao/watch: 8 MB
            // livres) — a RAM interna do boot do watch nao garante bloco de
            // 24 KB (bancada 2026-10-02, o xTaskCreate puro falhava em
            // TODA criacao e o app so via "ocupado")
            okc = xTaskCreateWithCaps(aiWorker, "jsai", 24576, nullptr, 3, &h,
                                      MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        }
        if (okc != pdPASS) {
            okc = xTaskCreate(aiWorker, "jsai", 24576, nullptr, 3, &h);
        }
        if (okc != pdPASS) {
            celer_log_println("[ai] worker -1: xTaskCreate falhou (RAM p/ stack de 24KB)");
        } else {
            s_aiWorker = h;
        }
    }
    return s_aiWorker != nullptr && s_aiWork != nullptr;
}

// Callback do app no heap stash (chat e speak): morre com o app (nada
// atravessa o exit). O cb vive no indice 1 da pilha nos dois bindings.
static void aiStashCallback(duk_context* ctx) {
    duk_push_heap_stash(ctx);
    duk_get_prop_string(ctx, -1, "_ai");
    if (!duk_is_array(ctx, -1)) {
        duk_pop(ctx);  // nao e array (novo heap): cria
        duk_push_array(ctx);
        duk_put_prop_string(ctx, -2, "_ai");
        duk_get_prop_string(ctx, -1, "_ai");
        duk_remove(ctx, -2);
    }
    duk_dup(ctx, 1);
    duk_put_prop_index(ctx, -2, 0);
    duk_pop(ctx);  // array
    duk_pop(ctx);  // stash
    s_aiPending = true;
}

// Pre-cria o array "_ai" do stash do app (slot 0 ja alocado) ANTES do
// encode grande: com o heap apertado (payload de audio de centenas de KB) o
// push_array podia lancar DEPOIS do slot em state=1 e da worker acordada —
// o slot ficava "ocupado" para sempre (AI.chat devolvia false ate reiniciar).
// Depois disto, aiStashCallback so escreve num indice existente (sem alloc).
static void aiEnsureCallbackArray(duk_context* ctx) {
    duk_push_heap_stash(ctx);
    duk_get_prop_string(ctx, -1, "_ai");
    if (!duk_is_array(ctx, -1)) {
        duk_pop(ctx);                 // valor antigo (ou undefined)
        duk_push_array(ctx);          // [stash, arr]
        duk_push_undefined(ctx);      // [stash, arr, undef]
        duk_put_prop_index(ctx, -2, 0);
        duk_put_prop_string(ctx, -2, "_ai");
    } else {
        duk_pop(ctx);                 // [stash]
    }
    duk_pop(ctx);                     // []
}

// Acorda (ou cria) a worker. false = worker nao nasceu (RAM p/ stack): o
// slot e devolvido e o callback do stash esquecido — o app ve false.
static bool aiWakeWorker(duk_context* ctx) {
    aiEnsureWorker();
    if (s_aiWorker == nullptr || s_aiWork == nullptr) {
        // worker nao nasceu: devolve o slot, esquece o callback e libera o
        // pedido (ninguem vai consumir payload/key/path; antes ficavam
        // presos ate o proximo AI.* — ate o audio base64 do Qwen)
        AiSlot& s = s_aiSlot;
        jsSlotMuxTake(s);
        if (s.state == 1) s.state = 0;
        free(s.payload);
        s.payload = nullptr;
        s.payloadLen = 0;
        free(s.key);
        s.key = nullptr;
        free(s.path);
        s.path = nullptr;
        xSemaphoreGive(s.mux);
        s_aiPending = false;
        duk_push_heap_stash(ctx);
        duk_get_prop_string(ctx, -1, "_ai");
        duk_push_undefined(ctx);
        duk_put_prop_index(ctx, -2, 0);
        duk_pop(ctx);   // array
        duk_pop(ctx);   // stash
        return false;
    }
    xSemaphoreGive(s_aiWork);  // acorda a worker (pedido ja esta no slot)
    return true;
}

// true = pedido no ar (o callback dispara 1x); false = ocupado/sem RAM
// (NENHUM callback). Erros de configuracao lancam (script ve mensagem
// legivel; o app pode checar AI.configured()/Net.isConnected() antes).
duk_ret_t JSBindings::js_aiChat(duk_context *ctx) {
    JSBindings::present();  // cedida universal: o "Pensando..." aparece antes
    duk_require_object(ctx, 0);
    duk_require_callable(ctx, 1);
    jsRequireWifi(ctx, "AI");
    // Provider (opts.provider): "deepseek" e o default. Nome desconhecido
    // lanca na cara do app — errar a casa mandaria a chave pro lugar errado.
    duk_get_prop_string(ctx, 0, "provider");
    const char* provName = duk_is_string(ctx, -1) ? duk_get_string(ctx, -1) : nullptr;
    duk_pop(ctx);
    if (!aiProviderKnown(provName)) {
        aiThrow(ctx, "AI: provider '%.40s' desconhecido", provName);
    }
    const AiProvider& prov = aiProviderByName(provName);
    std::string key = aiReadKey(prov);
    if (key.empty()) {
        aiThrow(ctx, "AI: chave ausente (%.60s)", prov.keyFile);
    }

    // Defaults do framework por cima do opts do app
    duk_dup(ctx, 0);
    duk_del_prop_string(ctx, -1, "provider");  // campo interno: nao viaja no JSON
    putBool(ctx, "stream", 0);  // o runtime nao consome SSE
    if (!duk_has_prop_string(ctx, -1, "model")) {
        putStr(ctx, "model", prov.defaultModel);
    }
    if (!duk_has_prop_string(ctx, -1, "max_tokens")) {
        putInt(ctx, "max_tokens", 1024);  // limita latencia e o corpo longe do teto
    }
    duk_get_prop_string(ctx, -1, "messages");
    if (!duk_is_array(ctx, -1)) {
        duk_error(ctx, DUK_ERR_TYPE_ERROR, "AI: opts.messages deve ser um array");
    }
    duk_pop(ctx);
    // callback a prova de OOM antes do encode grande (ver aiEnsureCallbackArray)
    aiEnsureCallbackArray(ctx);
    // JSON codificado fica na pilha ate o malloc do slot: sem std::string
    // intermediaria (o audio base64 do Qwen chega a centenas de KB — eram
    // tres copias vivas no pico: string do duk, std::string e o malloc)
    duk_size_t encLen = 0;
    duk_json_encode(ctx, -1);
    const char* encoded = duk_get_lstring(ctx, -1, &encLen);

    AiSlot& s = s_aiSlot;
    if (!jsSlotMuxTake(s)) { duk_pop(ctx); duk_push_boolean(ctx, 0); return 1; }
    if (s.state == 1) {  // requisicao em curso (ou zumbi cancelado)
        xSemaphoreGive(s.mux);
        duk_pop(ctx);
        duk_push_boolean(ctx, 0);
        return 1;
    }
    // state 0/2: slot livre (resultado anterior nao consumido some aqui)
    s.discard = false;
    s.ok = false;
    s.status = 0;
    jsSlotFreeBody(s);
    s.error[0] = '\0';
    s.speak = false;  // este pedido e chat (a worker ramifica pelo campo)
    free(s.path);
    s.path = nullptr;
    free(s.payload);
    s.payload = aiDupBuf(encoded ? encoded : "{}", encoded ? encLen : 2);
    free(s.key);
    s.key = aiDupBuf(key.data(), key.size());
    if (s.payload == nullptr || s.key == nullptr) {
        free(s.payload); s.payload = nullptr;
        free(s.key); s.key = nullptr;
        xSemaphoreGive(s.mux);
        duk_error(ctx, DUK_ERR_ERROR, "AI: sem RAM para montar o pedido");
    }
    s.payloadLen = encoded ? encLen : 2;
    duk_pop(ctx);  // JSON copiado para o slot: a string do heap JS pode ir
    s.prov = &prov;
    s.state = 1;
    xSemaphoreGive(s.mux);

    aiStashCallback(ctx);
    // encode + copia do pedido sao NATIVOS (audio base64 do Qwen chega a
    // centenas de KB): renova a janela antes de voltar ao bytecode
    CelerKernel::noteAppYield();
    duk_push_boolean(ctx, aiWakeWorker(ctx) ? 1 : 0);
    return 1;
}

// AI.speak (API 24): texto -> fala (opts + cb 1x). So o openrouter tem TTS.
// opts: {text (1..300 chars), voice?, model?, path?, play?, save?} — o destino
// default e o appData do app corrente; path alternativo valida no jail
// (fsWriteAllowed) AQUI, na thread JS: a worker nao tem ctx nem perms.
// Mesmo slot serial do chat: fala em curso deixa AI.chat/AI.speak "ocupado".
duk_ret_t JSBindings::js_aiSpeak(duk_context *ctx) {
    JSBindings::present();  // cedida universal: o "Pensando..." aparece antes
    duk_require_object(ctx, 0);
    duk_require_callable(ctx, 1);
    jsRequireWifi(ctx, "AI");
    const AiProvider& prov = aiProviderByName("openrouter");
    if (prov.ttsUrl == nullptr) {
        duk_error(ctx, DUK_ERR_ERROR, "AI.speak: provider sem TTS");
    }
    std::string key = aiReadKey(prov);
    if (key.empty()) {
        aiThrow(ctx, "AI: chave ausente (%.60s)", prov.keyFile);
    }

    // Texto: obrigatorio. Teto de AI_TTS_MAX_TEXT chars — fala longa e
    // LittleFS (48 KB/s de wav) e dinheiro da chave do dono. A string
    // FICA na pilha ate o payload copiar os bytes (o ponteiro do
    // duk_get_lstring nao sobrevive a um GC depois do pop).
    duk_size_t textLen = 0;
    const char* text = nullptr;
    duk_get_prop_string(ctx, 0, "text");
    if (duk_is_string(ctx, -1)) text = duk_get_lstring(ctx, -1, &textLen);
    if (text == nullptr || textLen == 0) {
        duk_error(ctx, DUK_ERR_TYPE_ERROR, "AI.speak: opts.text (string) e obrigatorio");
    }
    if (textLen > AI_TTS_MAX_TEXT) {
        // NUNCA lanca: a resposta da LLM vem do tamanho que ela quiser e um
        // throw aqui derrubava o app DENTRO do callback do chat (bancada
        // 2026-10-05: persona loquaz > 300 chars matava o Dog Face). Corta.
        char msg[80];
        snprintf(msg, sizeof(msg), "AI.speak: texto de %d chars cortado em %d",
                 (int)textLen, AI_TTS_MAX_TEXT);
        celer_log_printf("%s\n", msg);
        textLen = AI_TTS_MAX_TEXT;
    }
    // callback a prova de OOM antes do encode/copia do pedido
    aiEnsureCallbackArray(ctx);

    // Destino: appData do app corrente por default (mesma casa do
    // FS.appData); um path explicito segue as regras do jail de escrita.
    char path[96] = {0};
    duk_get_prop_string(ctx, 0, "path");
    if (duk_is_string(ctx, -1)) {
        snprintf(path, sizeof(path), "%.90s", duk_get_string(ctx, -1));
    }
    duk_pop(ctx);
    if (path[0] == '\0') {
        // destino default = appData do app corrente (mesma casa do FS.appData)
        std::string dir = jsAppDataDir();
        if (dir.empty()) {
            duk_error(ctx, DUK_ERR_ERROR, "AI.speak: app sem packageName; passe opts.path");
        }
        snprintf(path, sizeof(path), "%s/tts.wav", dir.c_str());
    }
    if (!fsWriteAllowed(path)) {
        aiThrow(ctx, "AI.speak: caminho negado (%.60s)", path);
    }

    // Payload pelo duk_json_encode (mesma regra do chat: nenhuma montagem
    // manual, nenhum escape de aspas do usuario)
    duk_push_object(ctx);
    duk_get_prop_string(ctx, 0, "model");
    if (duk_is_string(ctx, -1)) duk_put_prop_string(ctx, -2, "model");
    else {
        duk_pop(ctx);
        putStr(ctx, "model", prov.ttsModel);
    }
    duk_get_prop_string(ctx, 0, "voice");
    if (duk_is_string(ctx, -1)) duk_put_prop_string(ctx, -2, "voice");
    else {
        duk_pop(ctx);
        putStr(ctx, "voice", AI_TTS_VOICE);
    }
    putStr(ctx, "response_format", "pcm");  // mp3 saiu do firmware (migracao QOA)
    duk_dup(ctx, -2);  // text (2 abaixo do objeto): vira o campo input
    duk_put_prop_string(ctx, -2, "input");
    duk_json_encode(ctx, -1);
    duk_size_t encLen = 0;
    const char* encoded = duk_get_lstring(ctx, -1, &encLen);

    duk_get_prop_string(ctx, 0, "play");
    const bool playFlag = duk_is_boolean(ctx, -1) ? (duk_get_boolean(ctx, -1) != 0) : true;
    duk_pop(ctx);
    // save: manter o .wav no path (default false — tocando ao vivo nada
    // vai pro disco). play:false implica arquivo (senao o pedido nao serve)
    duk_get_prop_string(ctx, 0, "save");
    const bool saveFlag = duk_is_boolean(ctx, -1) && duk_get_boolean(ctx, -1) != 0;
    duk_pop(ctx);

    AiSlot& s = s_aiSlot;
    if (!jsSlotMuxTake(s)) { duk_pop_2(ctx); duk_push_boolean(ctx, 0); return 1; }
    if (s.state == 1) {  // chat/fala em curso (ou zumbi cancelado)
        xSemaphoreGive(s.mux);
        duk_pop_2(ctx);
        duk_push_boolean(ctx, 0);
        return 1;
    }
    s.discard = false;
    s.ok = false;
    s.status = 0;
    jsSlotFreeBody(s);
    s.error[0] = '\0';
    s.outBytes = 0;
    s.played = false;
    s.detail[0] = '\0';
    free(s.path);
    free(s.payload);
    s.payload = aiDupBuf(encoded ? encoded : "{}", encoded ? encLen : 2);
    free(s.key);
    s.key = aiDupBuf(key.data(), key.size());
    s.path = aiDupBuf(path, strlen(path));
    if (s.payload == nullptr || s.key == nullptr || s.path == nullptr) {
        free(s.payload); s.payload = nullptr;
        free(s.key); s.key = nullptr;
        free(s.path); s.path = nullptr;
        xSemaphoreGive(s.mux);
        duk_error(ctx, DUK_ERR_ERROR, "AI: sem RAM para montar o pedido");
    }
    s.payloadLen = encoded ? encLen : 2;
    duk_pop_2(ctx);  // json copiado pro slot + text (payload ja tem os bytes)
    s.prov = &prov;
    s.speak = true;  // este pedido e fala (a worker ramifica pelo campo)
    s.play = playFlag;
    s.save = saveFlag || !playFlag;
    s.state = 1;
    xSemaphoreGive(s.mux);

    aiStashCallback(ctx);
    CelerKernel::noteAppYield();  // encode/copia do pedido (tempo NATIVO)
    duk_push_boolean(ctx, aiWakeWorker(ctx) ? 1 : 0);
    return 1;
}

// AI.configured() = DeepSeek; AI.configured("openrouter") checa a casa certa.
// Nome desconhecido devolve false (nao lanca: e um detector, nao uma chamada)
duk_ret_t JSBindings::js_aiConfigured(duk_context *ctx) {
    const char* provName = duk_is_string(ctx, 0) ? duk_get_string(ctx, 0) : nullptr;
    bool known = aiProviderKnown(provName);
    duk_push_boolean(ctx, (known && !aiReadKey(aiProviderByName(provName)).empty()) ? 1 : 0);
    return 1;
}

// AI.warm([provider]) (API 24): abre a conexao TLS com a casa do provider
// AGORA, para o proximo AI.chat/AI.speak pular DNS+TCP+handshake (~2 s no
// cao). Uso tipico: o app de voz chama no wake word, enquanto o dono ainda
// fala. Fora do slot serial: um chat logo em seguida NAO ve "ocupado" (a
// worker atende depois do GET). Melhor esforco, sem callback: false =
// nada a fazer (sem WiFi/chave, provider desconhecido, placa sem PSRAM —
// la o handle nao fica vivo entre pedidos — ou pedido ja no ar).
duk_ret_t JSBindings::js_aiWarm(duk_context *ctx) {
    const char* provName = duk_is_string(ctx, 0) ? duk_get_string(ctx, 0) : nullptr;
    if (!aiProviderKnown(provName) || !Board::profile().hasPsram || !WebManager::isWifiConnected()) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
    const AiProvider& prov = aiProviderByName(provName);
    std::string key = aiReadKey(prov);
    char* k = key.empty() ? nullptr : aiDupBuf(key.data(), key.size());
    if (k == nullptr || !aiEnsureWorker()) {
        free(k);
        duk_push_boolean(ctx, 0);
        return 1;
    }
    AiSlot& s = s_aiSlot;
    bool queued = false;
    if (jsSlotMuxTake(s)) {
        if (s.state != 1) {  // pedido no ar ja usa (e aquece) a conexao
            free(s_aiWarmKey);
            s_aiWarmKey = k;
            s_aiWarmProv = &prov;
            k = nullptr;
            queued = true;
        }
        xSemaphoreGive(s.mux);
    }
    free(k);
    if (queued) xSemaphoreGive(s_aiWork);
    duk_push_boolean(ctx, queued ? 1 : 0);
    return 1;
}

// Esquece a requisicao em curso (botao "cancelar" do app; o exit do app
// chama aiReset que faz o mesmo). Nao mata a task (matar no meio do TLS
// vaza): ela mesma publica "cancelado" num slot que ninguem vai ler.
// Fala do TTS em playback: o requestStop corta o som no proximo chunk.
duk_ret_t JSBindings::js_aiCancel(duk_context *ctx) {
    AiSlot& s = s_aiSlot;
    bool dropped = false;
    if (jsSlotMuxTake(s)) {
        if (s.state == 1) {
            s.discard = true;
            dropped = true;
            if (s.speak) AudioPlayer::requestStop();
        }
        xSemaphoreGive(s.mux);
    }
    s_aiPending = false;
    duk_push_boolean(ctx, dropped ? 1 : 0);
    return 1;
}

// Monta o objeto do callback. Body (malloc) ainda do chamador: nada aqui
// pode vazar — duk_safe_call captura o longjmp de OOM e o dono libera.
struct AiResult {
    bool ok;
    int status;
    char* body;
    size_t bodyLen;
    const char* error;
    // AI.speak: resultado compacto (sem envelope OpenAI)
    bool speak = false;
    size_t outBytes = 0;
    bool played = false;
    char detail[96] = {0};
    char path[96] = {0};
};

// decode protegido: resposta cortada no teto de 32KB vem com JSON invalido
// (content fica null e o raw cru segue pro app, que decide)
static duk_ret_t aiDecodeJson(duk_context* ctx, void*) {
    duk_json_decode(ctx, -1);
    return 1;
}

// message.tool_calls -> array [{id,name,args}] no topo da pilha (API 20).
// `args` e o `function.arguments` decodificado quando JSON valido, senao a
// string crua — o app de ES5 nao teria como tratar falha de parse. Chamado
// com o message no topo; nao lanca (decode vem sob safe_call).
static void aiToolCallsFromMessage(duk_context* ctx) {
    duk_push_array(ctx);
    duk_uarridx_t nOut = 0;
    duk_get_prop_string(ctx, -2, "tool_calls");
    if (duk_is_array(ctx, -1)) {
        const duk_uarridx_t n = (duk_uarridx_t)duk_get_length(ctx, -1);
        for (duk_uarridx_t i = 0; i < n; i++) {
            duk_get_prop_index(ctx, -1, i);              // tc
            duk_push_object(ctx);                        // item
            duk_get_prop_string(ctx, -2, "id");
            if (duk_is_string(ctx, -1)) duk_put_prop_string(ctx, -2, "id");
            else duk_pop(ctx);
            duk_get_prop_string(ctx, -2, "function");
            if (duk_is_object(ctx, -1)) {
                duk_get_prop_string(ctx, -1, "name");
                if (duk_is_string(ctx, -1)) duk_put_prop_string(ctx, -3, "name");
                else duk_pop(ctx);
                duk_get_prop_string(ctx, -1, "arguments");
                if (duk_is_string(ctx, -1)) {
                    duk_dup(ctx, -1);                    // copia p/ o decode
                    if (duk_safe_call(ctx, aiDecodeJson, nullptr, 1, 1) == DUK_EXEC_SUCCESS &&
                        (duk_is_object(ctx, -1) || duk_is_array(ctx, -1))) {
                        duk_remove(ctx, -2);             // tira a string, fica o obj
                    } else {
                        duk_pop(ctx);                    // lixo do decode; fica a string
                    }
                }
                duk_put_prop_string(ctx, -3, "args");    // objeto ou string crua
                duk_pop(ctx);                            // function
            } else {
                duk_pop(ctx);
            }
            // pilha: [.. out, tool_calls, tc, item] — o item vai para o array
            // de SAIDA (-4) e so depois sai o tc. (Ate 2026-10 o pop tirava o
            // item e o tc era gravado de volta em tool_calls: r.toolCalls
            // chegava SEMPRE vazio com finishReason "tool_calls".)
            duk_put_prop_index(ctx, -4, nOut++);         // out[nOut] = item
            duk_pop(ctx);                                // tc
        }
    }
    duk_pop(ctx);  // tool_calls — array de saida fica no topo
}

// Resultado do AI.speak: {ok, status, path, bytes, played, error?, detail?}.
// bytes = PCM baixado (48 KB/s a 24 kHz); path = .wav gravado (opts.save ou
// play:false) ou "" quando a fala so tocou ao vivo. played=false com ok=true
// significa opts.play:false ou playback cortado pelo cancel.
static duk_ret_t aiPushSpeakResult(duk_context* ctx, void* udata) {
    AiResult* r = (AiResult*)udata;
    duk_push_object(ctx);
    putBool(ctx, "ok", r->ok);
    putInt(ctx, "status", r->status);
    putStr(ctx, "path", r->path);
    putInt(ctx, "bytes", (duk_int_t)r->outBytes);
    putBool(ctx, "played", r->played);
    if (!r->ok) {
        putStr(ctx, "error", r->error);
        if (r->detail[0] != '\0') {
            putStr(ctx, "detail", r->detail);
        }
    }
    return 1;
}

static duk_ret_t aiPushResult(duk_context* ctx, void* udata) {
    AiResult* r = (AiResult*)udata;
    duk_push_object(ctx);
    putBool(ctx, "ok", r->ok);
    putInt(ctx, "status", r->status);
    putLStr(ctx, "raw", r->body ? r->body : "", r->bodyLen);
    duk_push_null(ctx);
    duk_put_prop_string(ctx, -2, "content");
    if (!r->ok) {
        putStr(ctx, "error", r->error);
        // Detalhe do erro da API (corpo {"error":{"message":...}}): chave
        // invalida, saldo, rate limit — sem isso o app so ve "HTTP 401"
        duk_push_lstring(ctx, r->body ? r->body : "", r->bodyLen);
        if (duk_safe_call(ctx, aiDecodeJson, nullptr, 1, 1) == DUK_EXEC_SUCCESS &&
            duk_is_object(ctx, -1)) {
            duk_get_prop_string(ctx, -1, "error");        // [res, parsed, err]
            if (duk_is_object(ctx, -1)) {
                duk_get_prop_string(ctx, -1, "message");  // +message
                if (duk_is_string(ctx, -1)) {
                    duk_substring(ctx, -1, 0, 120);
                    duk_put_prop_string(ctx, -4, "detail");  // res.detail
                } else {
                    duk_pop(ctx);
                }
                duk_pop(ctx);  // err
            } else {
                duk_pop(ctx);
            }
        }
        duk_pop(ctx);  // parsed (ou string de parse quebrado)
        return 1;
    }
    // Envelope OpenAI: choices[0].message.content + usage. Falha de parse
    // NAO e erro da entrega (o app tem o raw).
    duk_push_lstring(ctx, r->body ? r->body : "", r->bodyLen);
    if (duk_safe_call(ctx, aiDecodeJson, nullptr, 1, 1) == DUK_EXEC_SUCCESS &&
        duk_is_object(ctx, -1)) {
        duk_get_prop_string(ctx, -1, "choices");  // [res, parsed, choices]
        if (duk_is_array(ctx, -1)) {
            duk_get_prop_index(ctx, -1, 0);           // +choices[0]
            duk_get_prop_string(ctx, -1, "message");  // +message
            duk_get_prop_string(ctx, -1, "content");  // +content
            if (duk_is_string(ctx, -1)) {
                duk_put_prop_string(ctx, -6, "content");  // res.content
            } else {
                duk_pop(ctx);
            }
            // Function calling (API 20): res.finishReason (choices[0]) e
            // res.toolCalls (message) quando o modelo responde com chamada
            // de ferramenta em vez de texto. Stack: [res,parsed,choices,c0,msg]
            duk_get_prop_string(ctx, -2, "finish_reason");
            if (duk_is_string(ctx, -1)) {
                duk_put_prop_string(ctx, -6, "finishReason");
            } else {
                duk_pop(ctx);
            }
            aiToolCallsFromMessage(ctx);  // +arr
            duk_put_prop_string(ctx, -6, "toolCalls");
            duk_pop(ctx);  // message
            duk_pop(ctx);  // choices[0]
        }
        duk_pop(ctx);  // choices
        duk_get_prop_string(ctx, -1, "usage");  // [res, parsed, usage]
        if (duk_is_object(ctx, -1)) {
            duk_put_prop_string(ctx, -3, "usage");  // res.usage
        } else {
            duk_pop(ctx);
        }
    }
    duk_pop(ctx);  // parsed (ou string de parse quebrado)
    return 1;
}

// Chamado pelo present() (apos timersTick). Entrega 1x o resultado ao
// callback do app. Erro de script PROPAGA (mesma politica dos timers: o
// app morre com a tela de erro; o present e 1a linha dos bindings
// chamadores, o longjmp nao atravessa recurso C aberto).
void JSBindings::aiTick(duk_context* ctx) {
    if (ctx == nullptr || !s_aiPending) return;
    // O ctx do present pode ser o heap do SVCHOST: um servico que chama um
    // binding bloqueante (FS.copyFile/listDir...) dispara present() com a
    // identidade do servico. O resultado da IA do APP era entao consumido e
    // DESCARTADO (o stash "_ai" nao existe naquele heap) e o app nunca
    // recebia o callback. Sem o array neste ctx nao ha o que entregar:
    // preserva slot/pending para o proximo present do app.
    duk_push_heap_stash(ctx);
    duk_get_prop_string(ctx, -1, "_ai");
    const bool hasCallback = duk_is_array(ctx, -1);
    duk_pop_2(ctx);
    if (!hasCallback) return;
    AiSlot& s = s_aiSlot;
    if (!jsSlotMuxTake(s)) return;
    if (s.state != 2) {
        xSemaphoreGive(s.mux);
        return;
    }
    // Toma posse do resultado sob o lock e monta o objeto fora dele
    char errBuf[96];
    AiResult r{s.ok, s.status, s.body, s.bodyLen, errBuf};
    memcpy(errBuf, s.error, sizeof(errBuf));  // s.error sempre NUL-terminado
    r.speak = s.speak;
    r.outBytes = s.outBytes;
    r.played = s.played;
    memcpy(r.detail, s.detail, sizeof(r.detail));
    if (s.path != nullptr) {
        snprintf(r.path, sizeof(r.path), "%s", s.path);
        free(s.path);  // posse do path consumida aqui (o app ja tem a copia)
        s.path = nullptr;
    } else {
        r.path[0] = '\0';
    }
    s.body = nullptr;
    s.bodyLen = 0;
    s.outBytes = 0;
    s.played = false;
    s.state = 0;  // slot liberado para o proximo chat
    s_aiPending = false;
    xSemaphoreGive(s.mux);

    // callback do stash (one-shot: a referencia sai ja)
    duk_push_heap_stash(ctx);
    duk_get_prop_string(ctx, -1, "_ai");
    if (!duk_is_array(ctx, -1)) {
        duk_pop_2(ctx);
        free(r.body);
        return;
    }
    duk_get_prop_index(ctx, -1, 0);
    duk_push_undefined(ctx);
    duk_put_prop_index(ctx, -3, 0);
    duk_remove(ctx, -2);  // tira o array
    duk_remove(ctx, -2);  // tira o stash — fn no topo
    if (!duk_is_callable(ctx, -1)) {
        duk_pop(ctx);
        free(r.body);
        return;
    }

    char* owned = r.body;
    duk_int_t rc = duk_safe_call(ctx, r.speak ? aiPushSpeakResult : aiPushResult, &r, 0, 1);
    free(owned);
    if (rc != DUK_EXEC_SUCCESS) duk_throw(ctx);
    esp_task_wdt_reset();  // callback pode desenhar bastante
    if (duk_pcall(ctx, 1) != DUK_EXEC_SUCCESS) duk_throw(ctx);
}
