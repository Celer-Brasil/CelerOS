#include "OtaManager.h"
#include <string>
#include <cstdio>
#include <atomic>
#include <Arduino.h>
#include "esp_http_client.h"
#include "esp_ota_ops.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "OtaGuard.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_task_wdt.h"
#include "HttpClient.h"
#include "NetworkManager.h"
#include "../FileSystem/FileSystem.h"
#include "../Kernel/Notifications.h"
#include "../Launcher/LauncherUI.h"
#include "../USBDevice/DebugBridge.h"
#include "../Utils/CelerSettings.h"
#include "../Utils/StrUtils.h"
#include "../Utils/SemVer.h"
#include "../Boards/Board.h"

OtaUpdateInfo OtaManager::info;
std::string OtaManager::lastError;

namespace {

// Um check/instalacao POR VEZ (guarda compartilhada pelos tres caminhos:
// check manual do Ajustes, check automatico e performUpdate): o TLS do
// HttpClient nao e reentrante e a RAM do CYD (sem PSRAM) nao comporta dois
// TLS vivos.
std::atomic<bool> s_busy{false};

// Agendamento do check automatico, consumido pelo servico "updcheck" no
// loop principal (celerLoop/present). A (re)conexao e detectada por
// SONDA do estado (nao por evento): o servico roda a cada tick, a
// transicao desconectado->conectado ancora o grace de 1 min e dispensa a
// inscricao no onStateChanged (um handler a menos, zero problema de
// ordenacao no boot).
std::atomic<bool> s_taskRunning{false};

// Id fixo da nota de update: o push com extId != 0 SUBSTITUI a nota anterior
// em vez de empilhar uma por check (mesmo truque do K_NOTE_BASE da Matilha).
constexpr uint32_t kOtaNoteId = 0x4F544100u;  // "OTA\0"

}  // namespace

// Canal de updates da placa (perfil em Boards/<placa>/Board.cpp)
static const char* CELEROS_UPDATE_CHANNEL = Board::profile().otaChannel;

// Fonte canonica dos updates do CelerOS (hub proprio). Trocar aqui (ou usar
// /local/ota_url.txt no dispositivo) para apontar outro servidor.
static const char* CELEROS_UPDATE_BASE =
    "https://os.celer.tec.br/updates";

std::string OtaManager::getUpdateJsonUrl() {
    // Override para testes com servidor local (tools/ota_server.py). Artefato
    // de dev por design: continua como ARQUIVO (gravavel pelo file manager
    // com auth), lido no momento do check — NVS exigiria reboot para trocar
    if (FileSystem::exists("/local/ota_url.txt")) {
        std::string url_Override = kstr::trim(FileSystem::readTextFile("/local/ota_url.txt"));
        if (url_Override.length() > 0) {
            if (!kstr::endsWith(url_Override, ".json")) {
                if (!kstr::endsWith(url_Override, "/")) url_Override += "/";
                url_Override += "update.json";
            }
            return url_Override;
        }
    }
    return std::string(CELEROS_UPDATE_BASE) + "/" + CELEROS_UPDATE_CHANNEL + "/update.json";
}

// Flash de firmware so por HTTPS, ou HTTP com opt-in local explicito
// (/local/ota_allow_http.txt — criado pelo dono via celerctl/file manager
// para o fluxo dev com tools/ota_server.py). Sem isso, gravar
// /local/ota_url.txt apontando para um servidor do atacante bastava para
// instalar firmware arbitrario na proxima atualizacao.
static bool urlSchemeAllowed(const std::string& url) {
    if (kstr::startsWith(url, "https://")) return true;
    return kstr::startsWith(url, "http://") &&
           FileSystem::exists("/local/ota_allow_http.txt");
}

static const char* HTTP_BLOCKED_MSG =
    "OTA bloqueado: http:// requer /local/ota_allow_http.txt no aparelho";

bool OtaManager::checkForUpdates() {
    // Guarda compartilhada: outro check/instalacao em curso devolve o
    // resultado corrente (fresco: so pode ter sido escrito ha poucos s)
    bool freeSlot = false;
    if (!s_busy.compare_exchange_strong(freeSlot, true)) {
        ESP_LOGW("celer.ota", "check ignorado: outro check/instalacao em curso");
        return info.available;
    }
    const bool available = runCheck();
    s_busy = false;
    return available;
}

bool OtaManager::runCheck() {
    info = OtaUpdateInfo();
    std::string url = getUpdateJsonUrl();
    if (!urlSchemeAllowed(url)) {
        info.fetchFailed = true;
        lastError = HTTP_BLOCKED_MSG;
        ESP_LOGE("celer.ota", "%s (url: %s)", HTTP_BLOCKED_MSG, url.c_str());
        return false;
    }

    HttpClient http;
    // 10 s como o netFetch: o fetch roda na main task inscrita no Task
    // Watchdog (15 s com PANIC) — timeout maior que a janela do TWDT
    // reiniciava o aparelho antes de devolver o erro.
    http.setTimeout(10000);
    HttpResponse resp = http.get(url);
    if (!resp.isOk()) {
        info.fetchFailed = true;
        return false;
    }
    std::string payload = resp.body;

    info.version = FileSystem::parseJsonValue(payload, "version");
    info.changelog = FileSystem::parseJsonValue(payload, "changelog");
    info.guide = FileSystem::parseJsonValue(payload, "guide");
    info.firmwareUrl = FileSystem::parseJsonValue(payload, "firmware_url");

    info.changelog = kstr::replaceAll(info.changelog, "\\n", "\n");
    info.guide = kstr::replaceAll(info.guide, "\\n", "\n");

    bool major = FileSystem::parseJsonValue(payload, "major_update") == "true";
    bool minor = FileSystem::parseJsonValue(payload, "minor_update") == "true";
    bool security = FileSystem::parseJsonValue(payload, "security_update") == "true";

    if (major) info.type = "Major System Update Available!";
    else if (minor) info.type = "Minor Update Available!";
    else if (security) info.type = "Security Update Available!";
    else info.type = "Update Available!";

    // firmware_url relativa resolve contra o diretorio do update.json
    // (conveniente para o servidor local de testes)
    if (info.firmwareUrl.length() > 0 && !kstr::startsWith(info.firmwareUrl, "http")) {
        int slash = kstr::lastIndexOf(url, '/');
        if (slash >= 0) info.firmwareUrl = url.substr(0, slash + 1) + info.firmwareUrl;
    }
    info.hasFirmware = info.firmwareUrl.length() > 0;

    // Variante (API da SKU): update.json pode declarar "variant" e o
    // dispositivo recusa firmware de outra variante — o caso real e a
    // SmartDisplay "Y" (reles): o canal generico desinstalaria o suporte a
    // rele (os pinos voltam a ser I2S/alto-falante). Dispositivo COM reles
    // tambem recusa manifest SEM variant (a imagem generica e que tira os
    // reles); dispositivo padrao aceita manifest sem variant (retrocompat).
    std::string manifestVariant = FileSystem::parseJsonValue(payload, "variant");
    std::string mine = Board::profile().relay.count > 0
                           ? std::string("smartdisplay-y") +
                                 std::to_string(Board::profile().relay.count)
                           : std::string("");
    if (!mine.empty() && manifestVariant != mine) {
        info.available = false;
        info.hasFirmware = false;
        info.type = "Atualizacao para outra variante";
        info.changelog = "Este aparelho e a variante " + mine +
                         " e a atualizacao publicada e para outra variante (" +
                         (manifestVariant.empty() ? std::string("padrao") : manifestVariant) +
                         "). Nao instalar.";
        info.guide = "";
        ESP_LOGW("celer.ota", "variante %s != %s: update recusado",
                 manifestVariant.c_str(), mine.c_str());
        return false;
    }

    // api_version (nivel de API do firmware ofertado): o manifest do hub
    // sempre declara. Sem o campo — ou lixo no lugar — o manifest e
    // suspeito (nao veio do publicador) e o update e recusado. Abaixo do
    // nivel atual tambem recusa: OTA nao toca na LittleFS, os apps
    // instalados que ja exigem API maior parariam de rodar.
    {
        std::string apiStr = FileSystem::parseJsonValue(payload, "api_version");
        int api = 0;
        bool apiOk = !apiStr.empty() && apiStr.length() <= 3;
        for (size_t i = 0; i < apiStr.length(); i++) {
            if (apiStr[i] < '0' || apiStr[i] > '9') apiOk = false;
        }
        if (apiOk) api = atoi(apiStr.c_str());
        if (!apiOk || api <= 0) {
            info.available = false;
            info.hasFirmware = false;
            info.type = "Manifest sem api_version valido";
            info.changelog = "O update.json oferecido nao declara api_version "
                             "(ou veio com valor ilegivel) e foi recusado.";
            info.guide = "";
            ESP_LOGW("celer.ota", "api_version ausente/invalido no manifest: update recusado");
            return false;
        }
        if (api < CELEROS_API_LEVEL) {
            info.available = false;
            info.hasFirmware = false;
            info.type = "Atualizacao com API menor que a atual";
            info.changelog = "O firmware oferecido tem API " + std::to_string(api) +
                             " e este aparelho roda API " + std::to_string(CELEROS_API_LEVEL) +
                             ": apps instalados que exigem API maior parariam de rodar.";
            info.guide = "";
            ESP_LOGW("celer.ota", "api_version %d < atual %d: update recusado",
                     api, (int)CELEROS_API_LEVEL);
            return false;
        }
        info.apiVersion = api;
    }

    if (celer::versionGreater(info.version, CELEROS_VERSION)) {
        info.available = true;
    }
    return info.available;
}

static void setOtaError(const char* stage, esp_err_t err) {
    char msg[64];
    snprintf(msg, sizeof(msg), "OTA failed: %s (0x%X)", stage, (unsigned)err);
    OtaManager::lastError = msg;
    ESP_LOGE("celer.ota", "%s", msg);
}

// Veja OtaManager.h. O pedido (requestAppExit) vira saida limpa no proximo
// ponto de cedida do runtime (delay/getTouch — um jogo cede a cada quadro,
// tipicamente <100 ms); app preso numa chamada nativa longa expira o prazo
// e a gravacao segue do jeito que esta (melhor esforco, como o shell exit).
void OtaManager::evictRunningApp() {
    if (!LauncherUI::appRunning()) return;
    ESP_LOGW("celer.ota", "app aberto: encerrando antes de gravar o slot OTA");
    LauncherUI::requestAppExit();
    for (int i = 0; i < 20 && LauncherUI::appRunning(); i++) vTaskDelay(pdMS_TO_TICKS(100));
    if (LauncherUI::appRunning())
        ESP_LOGW("celer.ota", "app nao saiu em 2 s: gravando com ele aberto");
}

// Alimenta o Task Watchdog se (e so se) a task corrente esta inscrita nele —
// mesma guarda do AudioPlayer::feedWatchdog (o reset sem inscricao loga
// "task not found" por chamada). O download do performUpdate roda minutos na
// main task e antes so era alimentado nos limites de porcentagem do
// onProgress, que ainda exigia callback E Content-Length: TWDT de 15 s com
// PANIC reiniciava o aparelho no meio de um download lento.
static void feedWatchdog() {
    if (esp_task_wdt_status(nullptr) == ESP_OK) esp_task_wdt_reset();
}

// Download RETOMAVEL direto na particao OTA (bloqueante). Era um unico
// esp_https_ota sem retentativa: ~2,5 MB pelo WiFi — que divide o radio com
// o BLE (malha, Phone Link) — e qualquer soluco no meio jogava fora o que ja
// tinha baixado. Agora uma conexao que cai e reaberta com "Range: bytes=N-"
// e o download continua do byte N (servidor que ignora Range devolve 200:
// pulamos os N bytes ja gravados; o 206 "atrasado", cujo corpo e maior que
// o que faltava, recebe a mesma cura de pular bytes). Dois tetos: 6 falhas
// SEGUIDAS sem progresso (espera crescente) e um total de 50 conexoes — sem
// o segundo, um servidor que entrega 1 byte por conexao e fecha (progresso
// "real" que zera a conta de falhas) prenderia o aparelho no download para
// sempre, com o watchdog alimentado. HTTPS valida o servidor contra o
// bundle de CAs; o esp_ota_end confere a imagem inteira (checksum/SHA/chip)
// antes de marcar o boot — falha em qualquer etapa deixa o slot atual
// intacto.
bool OtaManager::performUpdate(const std::string& firmwareUrl, void (*onProgress)(int percent)) {
    // Mesma guarda do check: instalar com um check em voo briga pelo TLS/RAM
    bool freeSlot = false;
    if (!s_busy.compare_exchange_strong(freeSlot, true)) {
        lastError = "OTA failed: verificacao/instalacao em curso";
        ESP_LOGE("celer.ota", "%s", lastError.c_str());
        return false;
    }
    const bool ok = runUpdate(firmwareUrl, onProgress);
    s_busy = false;
    return ok;
}

bool OtaManager::runUpdate(const std::string& firmwareUrl, void (*onProgress)(int percent)) {
    lastError = "";

    if (!urlSchemeAllowed(firmwareUrl)) {
        lastError = HTTP_BLOCKED_MSG;
        ESP_LOGE("celer.ota", "%s (url: %s)", HTTP_BLOCKED_MSG, firmwareUrl.c_str());
        return false;
    }
    if (!OtaGuard::acquire()) {  // celerctl/upload web gravando o slot agora
        lastError = "OTA failed: outra gravacao OTA em curso (celerctl/web?)";
        ESP_LOGE("celer.ota", "%s", lastError.c_str());
        return false;
    }
    const esp_partition_t* part = esp_ota_get_next_update_partition(nullptr);
    esp_ota_handle_t ota = 0;
    esp_err_t err = part == nullptr ? ESP_ERR_NOT_FOUND : esp_ota_begin(part, OTA_SIZE_UNKNOWN, &ota);
    if (err != ESP_OK) {
        OtaGuard::release();
        setOtaError("begin", err);
        return false;
    }

    constexpr size_t kBuf = 8192;
    char* buf = (char*)heap_caps_malloc(kBuf, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (buf == nullptr) buf = (char*)malloc(kBuf);
    if (buf == nullptr) {
        esp_ota_abort(ota);
        OtaGuard::release();
        setOtaError("buffer", ESP_ERR_NO_MEM);
        return false;
    }

    constexpr int kMaxFails = 6;   // falhas SEGUIDAS sem progresso
    constexpr int kMaxConns = 50;  // teto TOTAL de conexoes da tentativa
    size_t written = 0;
    int64_t total = -1;
    int fails = 0, conns = 0, lastPct = -1;
    bool done = false, fatal = false;  // fatal: flash/imagem — repetir nao ajuda
    err = ESP_FAIL;
    while (!done && !fatal && fails < kMaxFails && conns < kMaxConns) {
        conns++;
        feedWatchdog();  // TWDT: open/fetch_headers bloqueiam por conta do timeout
        if (fails > 0) {
            ESP_LOGW("celer.ota", "retomando do byte %u (falha %d/%d)", (unsigned)written, fails, kMaxFails);
            vTaskDelay(pdMS_TO_TICKS(1000 * fails));
            feedWatchdog();  // a espera de backoff ja passou, a tentativa comeca alimentada
        }
        esp_http_client_config_t http = {};
        http.url = firmwareUrl.c_str();
        // 10 s (nao 15): o watchdog e alimentado por chunk, mas um unico
        // esp_http_client_read travado bloqueia por timeout_ms — colinear
        // com a janela do TWDT (15 s) era corrida para o PANIC. O loop de
        // retomada Range acima torna a reconexao barata.
        http.timeout_ms = 10000;
        http.buffer_size = 4096;
        if (kstr::startsWith(firmwareUrl, "https://")) http.crt_bundle_attach = esp_crt_bundle_attach;
        esp_http_client_handle_t cli = esp_http_client_init(&http);
        if (cli == nullptr) { fails++; err = ESP_ERR_NO_MEM; continue; }
        char range[40];
        if (written > 0) {
            snprintf(range, sizeof(range), "bytes=%u-", (unsigned)written);
            esp_http_client_set_header(cli, "Range", range);
        }
        err = esp_http_client_open(cli, 0);
        int64_t len = err == ESP_OK ? esp_http_client_fetch_headers(cli) : -1;
        const int status = err == ESP_OK ? esp_http_client_get_status_code(cli) : 0;
        size_t skip = 0;  // 200 apos Range: o servidor mandou do inicio
        if (err != ESP_OK || (status != 200 && status != 206)) {
            if (err == ESP_OK) err = ESP_ERR_INVALID_RESPONSE;
            esp_http_client_cleanup(cli);
            fails++;
            continue;
        }
        if (status == 200) {
            skip = written;
            if (len > 0) total = len;
        } else if (len > 0) {
            if (total < 0) {
                total = (int64_t)written + len;  // 206 honesto: falta exatamente len
            } else if ((int64_t)len > total - (int64_t)written) {
                // 206 "atrasado": corpo maior que o que faltava gravar — o
                // servidor comecou antes do byte pedido; pula o trecho ja
                // gravado (mesma cura do 200 sem Range)
                skip = (size_t)((int64_t)len - (total - (int64_t)written));
            }
        }
        bool progressed = false;
        for (;;) {
            feedWatchdog();  // read + esp_ota_write nunca deixam a task bloquear: alimenta por chunk
            int n = esp_http_client_read(cli, buf, kBuf);
            if (n < 0) { err = ESP_FAIL; break; }  // conexao caiu: retoma
            if (n == 0) {
                // fim do corpo: completo se bateu o tamanho (ou se o
                // servidor nao informou e a conexao fechou limpa)
                if (esp_http_client_is_complete_data_received(cli) &&
                    (total < 0 || (int64_t)written >= total)) done = true;
                else err = ESP_FAIL;
                break;
            }
            const char* data = buf;
            if (skip > 0) {  // pula o que ja esta gravado (servidor sem Range)
                size_t k = (size_t)n < skip ? (size_t)n : skip;
                skip -= k;
                data += k;
                n -= (int)k;
                if (n == 0) continue;
            }
            err = esp_ota_write(ota, data, (size_t)n);
            if (err != ESP_OK) { fatal = true; break; }
            written += (size_t)n;
            progressed = true;
            if (total > 0 && onProgress != nullptr) {
                int pct = (int)((int64_t)written * 100 / total);
                if (pct != lastPct) {
                    lastPct = pct;
                    onProgress(pct);
                }
            }
        }
        esp_http_client_cleanup(cli);
        // falhas SEGUIDAS sem progresso: conexao que andou e caiu zera a conta
        if (!done && !fatal) fails = progressed ? 1 : fails + 1;
    }
    free(buf);
    if (!done) {
        esp_ota_abort(ota);
        OtaGuard::release();
        if (conns >= kMaxConns)
            ESP_LOGE("celer.ota", "download nao fecha apos %d conexoes "
                     "(servidor entregando migalhas com progresso?)", conns);
        setOtaError("download", err);
        return false;
    }
    err = esp_ota_end(ota);  // valida a imagem inteira
    if (err == ESP_OK) err = esp_ota_set_boot_partition(part);
    OtaGuard::release();
    if (err != ESP_OK) {
        setOtaError("finish", err);
        return false;
    }
    ESP_LOGI("celer.ota", "OTA ok: %u bytes em %s", (unsigned)written, part->label);
    return true;
}

// ========================= Verificacao automatica ==========================
// A POLITICA (quando checar, quando notificar) migraram para o servico JS
// do app "Nucleo" (data/apps/Nucleo/service.js + policy.js, API 42): o
// update.json vem pelo System.otaCheck (o fetch nativo de sempre, task de
// 16 KB) e a notificacao 1x por versao e do proprio servico (Storage
// "noted_ver"). Quem sobrou aqui e so o gate: checkBusy() para o servico
// nao disparar check em cima do check manual/OTA em curso.

bool OtaManager::checkBusy() {
    return s_busy || s_taskRunning;
}
