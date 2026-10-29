#include "WebManager.h"
#include "../USBDevice/LogSink.h"
#include <atomic>
#include <new>
#include <string>
#include <cstring>
#include <cstdio>
#include <vector>
#include <sys/stat.h>
#include <unistd.h>

#include "sdkconfig.h"
#include "esp_http_server.h"
#include "esp_ota_ops.h"
#include "esp_wifi.h"
#include "esp_heap_caps.h"
#include "nvs_flash.h"
#include "ArduinoJson.h"

#include "NetworkCredentialStore.h"
#include "CaptivePortal.h"
#include "../FileSystem/FileSystem.h"
#include "../Utils/StrUtils.h"
#include "../Utils/CelerSettings.h"
#include "../Utils/Settings.h"
#include "../Kernel/TimeManager.h"
#include "../OTA/OtaGuard.h"
#include "../OTA/OtaManager.h"
#include "../Display/ScreenCapture.h"
#include "../UI/Kui.h"
#include "../Boards/Board.h"
#include "../USBDevice/DebugBridge.h"
#include "WebAuth.h"

static const char* WM_TAG = "celer.web";

#if CONFIG_CELEROS_WEB_SERVER
// Paginas web embutidas ja comprimidas (gzip gerado no build a partir de
// filemanager.html / ota_upload.html — ver main/CMakeLists.txt)
extern const uint8_t filemanager_gz_start[] asm("_binary_filemanager_html_gz_start");
extern const uint8_t filemanager_gz_end[] asm("_binary_filemanager_html_gz_end");
extern const uint8_t ota_upload_gz_start[] asm("_binary_ota_upload_html_gz_start");
extern const uint8_t ota_upload_gz_end[] asm("_binary_ota_upload_html_gz_end");
#if CONFIG_CELEROS_UI
extern const uint8_t screen_gz_start[] asm("_binary_screen_html_gz_start");
extern const uint8_t screen_gz_end[] asm("_binary_screen_html_gz_end");
#endif

static esp_err_t sendGzipHtml(httpd_req_t* req, const uint8_t* start, const uint8_t* end) {
    httpd_resp_set_type(req, "text/html");
    httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
    // Paginas de administracao (file manager, /update): sem isto o navegador
    // cacheava heuristically e exibia UI velha depois de um OTA; e a pagina
    // autenticada nao deve persistir em cache compartilhado.
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, (const char*)start, end - start);
}
#endif

static httpd_handle_t s_server = nullptr;
static bool s_nmEventsBound = false;
// atomico: com o service ALWAYS, o drain roda nos dois pumps — no build
// padrao a mesma task, com CELEROS_APP_TASK tasks distintas
static std::atomic_bool s_rebootPending{false};
// Start do servidor diferido para o tick: o handler do evento roda na task
// sys_evt sob o mutex do Event (components/Utility — um so, global) e o
// httpd_start aloca e cria task na hora; dentro do trigger isso segurava o
// Event inteiro do firmware. O handler so seta a flag.
static std::atomic_bool s_serverStartPending{false};
// Porta 80 de outro dono (captive portal de configuracao): bloqueia o start
// automatico enquanto o portal vive.
static std::atomic_bool s_serverSuppressed{false};
// Requisicoes em voo (routeGuard). httpd_stop ESPERA o handler corrente
// terminar: chamado da main task durante um /update de minutos, estourava o
// TWDT de 15 s (PANIC) e reiniciava o aparelho. Com o contador, o stop e o
// disable do WiFi sao adiados para o tick quando o httpd esta ocioso.
static std::atomic<int> s_activeReqs{0};
static std::atomic_bool s_stopPending{false};
static std::atomic_bool s_disablePending{false};

// ---------------------------------------------------------------------------
// NetworkManager (componente Connection) glue
// ---------------------------------------------------------------------------

static NetworkManager& nm() { return NetworkManager::instance(); }

// Flags de config em NVS (F3; web_on.txt/nowifi.txt/config_install_sd.txt
// sao importados e apagados no primeiro boot com CelerSettings::migrateLegacy)
static bool cfgFlag(const char* key) { return Settings::getBool(key); }

WifiConnection& WebManager::wifi() { return *nm().getWifiConnection(); }

// Estado de rede: NTP na conexao e (re)subida do servidor quando habilitado.
// Handlers so setam flags — o Event do componente dispara sob o mutex global
// e nada pesado (httpd_start) roda dentro dele; o tick efetiva.
void WebManager::onNetworkStateChanged(NetworkState /*oldState*/, NetworkState newState) {
    if (newState == NetworkState::Connected) {
        ESP_LOGI(WM_TAG, "WiFi conectado, IP=%s", nm().getIpAddress().c_str());
        TimeManager::syncNTP();  // leve por design (esp_netif_sntp, thread-safe)
        s_serverStartPending = true;
    }
}

// Import one-shot do wifi.txt legado ("ssid\npass") para o
// NetworkCredentialStore (NVS). Renomeia para wifi.txt.migrated —
// idempotente e seguro mesmo com store ja populado.
void WebManager::importLegacyWifiTxt() {
    const char* legacy[] = {"/sd/wifi.txt", "/local/wifi.txt"};
    for (const char* path : legacy) {
        if (!FileSystem::exists(path)) continue;

        std::string content = FileSystem::readTextFile(path);
        int nl = kstr::indexOf(content, '\n');
        std::string ssid, pass;
        if (nl < 0) {
            ssid = kstr::trim(content);
        } else {
            ssid = kstr::trim(content.substr(0, nl));
            pass = kstr::trim(content.substr(nl + 1));
        }

        if (!ssid.empty() && nm().getCredentialStore().getNetworkCount() == 0) {
            nm().getCredentialStore().saveNetwork(KnownNetwork(ssid.c_str(), pass.c_str()));
            celer_log_print("wifi.txt migrado para o credential store (NVS): ");
            celer_log_println(ssid.c_str());
        }
        // Esvazia ANTES de renomear: a senha nao pode ficar em plaintext no
        // disco (o .migrated so existe para marcar "ja processado").
        FileSystem::writeTextFile(path, "");
        FileSystem::renameFile(path, (std::string(path) + ".migrated").c_str());
        return;  // so o primeiro que existir (SD tem preferencia)
    }
}

bool WebManager::init() {
    nvs_flash_init();  // exigido pelo esp_wifi e pelo credential store (NVS)

    ErrorCode err = nm().init(true);  // background task: reconexao/roaming
    if (err != CommonErrorCodes::None) {
        celer_log_println("NetworkManager init failed.");
        return false;
    }
    CelerSettings::migrateLegacy();

    if (!s_nmEventsBound) {
        s_nmEventsBound = true;
        nm().onStateChanged.addHandler(
            [](NetworkState o, NetworkState n) { WebManager::onNetworkStateChanged(o, n); });
    }

    importLegacyWifiTxt();

    // Ja conectado (ex.: captive portal acabou de conectar): nao refaz
    // connectToKnown, so garante o servidor se habilitado
    if (nm().isConnected()) {
        if (cfgFlag("web_on")) {
            startWebServerIfNeeded();
        }
        return true;
    }

    if (nm().getCredentialStore().getNetworkCount() == 0) {
        celer_log_println("No saved networks (NVS store vazio).");
        return false;
    }
    if (cfgFlag("nowifi")) {
        celer_log_println("WiFi desligado pelo usuario (nowifi.txt).");
        return false;
    }

    celer_log_println("Connecting to known network(s)...");
    err = nm().connectToKnown();  // bloqueante: escolhe a melhor rede conhecida
    if (err != CommonErrorCodes::None || !nm().isConnected()) {
        celer_log_println("WiFi connection failed.");
        return false;
    }

    // GATE do servidor web ("web server OFF nessa fw", bancada 2026-10-09):
    // o CONFIG_CELEROS_WEB_SERVER (Kconfig, default y) apenas COMPILA o
    // servidor; em execucao ele SOBE somente com a flag NVS web_on=1
    // (migrada de /local/web_on.txt; o app Web Server / System.webSetActive
    // liga e desliga ao vivo). Default desligado e proposital: httpd + rotas
    // custam RAM interna propria (stack de 10 KB + alocacoes do esp_http_
    // server) que a CYD de 4 MB nao paga de graca — e um servidor de
    // arquivos com senha nao deve acordar ligado de fabrica.
    if (!cfgFlag("web_on")) {
        celer_log_println("Web Server desligado (flag web_on ausente; app Web Server liga).");
        return true;  // WiFi conectado, servidor nao sobe
    }

    startWebServerIfNeeded();
    return true;
}

bool WebManager::startAsync() {
    nvs_flash_init();

    if (cfgFlag("nowifi")) {
        celer_log_println("WiFi desligado pelo usuario (nowifi.txt).");
        return false;
    }

    ErrorCode err = nm().init(true);  // task de reconexao/roaming conecta
    if (err != CommonErrorCodes::None) {
        celer_log_println("NetworkManager init failed.");
        return false;
    }
    CelerSettings::migrateLegacy();

    if (!s_nmEventsBound) {
        s_nmEventsBound = true;
        nm().onStateChanged.addHandler(
            [](NetworkState o, NetworkState n) { WebManager::onNetworkStateChanged(o, n); });
    }
    importLegacyWifiTxt();
    return true;
}

bool WebManager::enable() {
    nm().setAutoReconnect(true);
    return WebManager::init();
}

bool WebManager::enableAsync() {
    Settings::setBool("nowifi", false);
    nm().setAutoReconnect(true);
    return startAsync();  // init idempotente; a task de reconexao conecta
}

void WebManager::disablePersist() {
    Settings::setBool("nowifi", true);
    disable();
}

bool WebManager::wifiEnabled() { return !cfgFlag("nowifi"); }

void WebManager::disable() {
    // Desconectar o radio no meio de um upload tambem quebra o handler; o
    // adiamento e o mesmo do stop (o tick retoma quando o httpd esvaziar).
    if (s_activeReqs.load(std::memory_order_relaxed) > 0) {
        s_disablePending = true;
        celer_log_println("WiFi disable adiado (requisicao web em curso)");
        return;
    }
    s_disablePending = false;
    nm().setAutoReconnect(false);  // silencia a background task
    stopWebServer();
    // O stop pode ter sido ADIADO de novo (uma requisicao entrou entre o
    // check acima e o stop): desconectar agora derrubaria o radio no meio do
    // handler. O tick retoma quando o httpd esvaziar.
    if (s_server != nullptr) {
        s_disablePending = true;
        celer_log_println("WiFi disable adiado (requisicao web em curso)");
        return;
    }
    nm().disconnect();
    celer_log_println("WiFi disabled at runtime");
}

void WebManager::stopWebServer() {
    if (s_server == nullptr) return;
    // Fecha a porta para requisicoes NOVAS antes de olhar o contador: sem
    // isso uma requisicao longa podia comecar entre o check e o httpd_stop.
    s_stopPending = true;
    if (s_activeReqs.load(std::memory_order_relaxed) > 0) {
        celer_log_println("Web Server: parada adiada (requisicao em curso)");
        return;
    }
    httpd_stop(s_server);
    s_server = nullptr;
    s_stopPending = false;
    celer_log_println("Web Server stopped");
}

void WebManager::suppressServerStart(bool on) {
    s_serverSuppressed = on;
    if (!on && nm().isConnected() && cfgFlag("web_on")) {
        // Portal acabou (conectou ou foi cancelado) com o WiFi ja de pe:
        // re-arma o start — o tick efetiva na proxima passada. Sem isto o
        // servidor so voltava na PROXIMA transicao Connected.
        s_serverStartPending = true;
    }
}


bool WebManager::isServerRunning() {
    return s_server != nullptr;
}

void WebManager::tick() {
    // (Re)conexao e responsabilidade da background task do NetworkManager;
    // aqui: start diferido do servidor, reboot diferido do upload web de
    // firmware e modo de baixa latencia da sessao bridge.
    //
    // Service ALWAYS: com o app preso no foreground apos o evictRunningApp
    // esgotar os 2 s, o pump LOOP nao volta a rodar — o reboot prometido ao
    // navegador ficava pendente ate o app fechar. O PRESENT drena tambem; o
    // exchange garante que so um contexto reinicia (com CELEROS_APP_TASK os
    // pumps sao tasks distintas).

    // Stop/disable adiados por requisicao em curso: so age com o httpd
    // ocioso, senao o httpd_stop (e o disconnect) esperam o handler e a
    // main task morre no TWDT.
    if (s_disablePending.load(std::memory_order_relaxed) &&
        s_activeReqs.load(std::memory_order_relaxed) == 0) {
        disable();
    }
    if (s_stopPending.load(std::memory_order_relaxed) &&
        s_activeReqs.load(std::memory_order_relaxed) == 0) {
        stopWebServer();
    }

    // Conectou (flag do handler do evento): sobe o servidor se habilitado e
    // a porta 80 nao for de outro dono (captive portal).
    if (s_serverStartPending.exchange(false)) {
        if (!s_serverSuppressed && !s_stopPending.load(std::memory_order_relaxed) &&
            !s_disablePending.load(std::memory_order_relaxed) && cfgFlag("web_on")) {
            startWebServerIfNeeded();
        }
    }

    // Shell/OTA por TCP engasga com o modem dormindo entre beacons (DTIM do
    // AP): enquanto ha cliente bridge autenticado, radio acordado (custo de
    // corrente so durante a sessao; ve NetworkManager::setLowLatency).
#if CONFIG_CELEROS_DEBUG_BRIDGE
    nm().setLowLatency(DebugBridge::sessionActive());
#endif

    if (s_rebootPending.exchange(false)) {
        celer_log_println("Rebooting after web OTA...");
        delay(500);  // da tempo para a resposta HTTP chegar ao navegador
        ESP.restart();
    }
}

bool WebManager::isActive() {
    return nm().isConnected();
}

bool WebManager::isWifiConnected() {
    return nm().isConnected();
}

std::string WebManager::getIPAddress() {
    if (nm().isConnected()) {
        return nm().getIpAddress();
    }
    return "";
}

bool WebManager::connect(const std::string& ssid, const std::string& password,
                          bool saveCreds, uint32_t timeoutMs) {
    if (ssid.empty() || ssid.length() > 32 || password.length() > 64) return false;

    if (nm().init(true) != CommonErrorCodes::None) return false;
    nm().getWifiConnection()->setConnectionTimeout(timeoutMs);
    ErrorCode err = nm().connect(ssid, password, saveCreds);  // salva no NVS
    nm().getWifiConnection()->setConnectionTimeout(10000);
    return (err == CommonErrorCodes::None) && nm().isConnected();
}

void WebManager::disconnect() {
    nm().disconnect();
}

int WebManager::scanNetworks(CelerScanEntry* out, int maxN) {
    if (out == nullptr || maxN <= 0) return 0;
    if (nm().init(true) != CommonErrorCodes::None) return 0;

    if (nm().startScan(true) != CommonErrorCodes::None) return 0;
    std::vector<ScannedNetwork> results = nm().getLastScanResults();

    int count = 0;
    for (const auto& net : results) {
        if (count >= maxN) break;
        std::string ssid = net.ssid;
        if (ssid.empty()) continue;
        // dedup por SSID (o scan ja vem ordenado por RSSI)
        bool dup = false;
        for (int j = 0; j < count; j++) {
            if (out[j].ssid == ssid) { dup = true; break; }
        }
        if (dup) continue;
        out[count].ssid = ssid;
        out[count].rssi = net.rssi;
        out[count].secure = net.authMode != WIFI_AUTH_OPEN;
        count++;
    }
    return count;
}

bool WebManager::startScanAsync() {
    return nm().init(true) == CommonErrorCodes::None &&
           nm().startScan(false) == CommonErrorCodes::None;
}

std::vector<CelerScanEntry> WebManager::getLastScan() {
    std::vector<CelerScanEntry> out;
    for (const auto& net : nm().getLastScanResults()) {
        if (net.ssid[0] == '\0') continue;
        CelerScanEntry e;
        e.ssid = net.ssid;
        e.rssi = net.rssi;
        e.secure = net.authMode != WIFI_AUTH_OPEN;
        out.push_back(e);
    }
    return out;
}

bool WebManager::hasSavedNetworks() {
    if (nm().getCredentialStore().getNetworkCount() > 0) return true;
    // wifi.txt legado ainda nao importado (ex.: boot com nowifi.txt pula o init)
    return FileSystem::exists("/sd/wifi.txt") || FileSystem::exists("/local/wifi.txt");
}

void WebManager::forgetAllNetworks() {
    nm().setAutoReconnect(false);
    nm().getCredentialStore().clearAllNetworks();
    FileSystem::deleteFile("/sd/wifi.txt");
    FileSystem::deleteFile("/local/wifi.txt");
    FileSystem::deleteFile("/sd/wifi.txt.migrated");
    FileSystem::deleteFile("/local/wifi.txt.migrated");
    disable();
}

#if CONFIG_CELEROS_WEB_SERVER
// ---------------------------------------------------------------------------
// esp_http_server — helpers
// ---------------------------------------------------------------------------

// Prefixos aceitos; "/littlefs" (alias antigo do SPA) vira "/local"
static std::string normalizePath(const std::string& in) {
    if (kstr::startsWith(in, "/littlefs")) {
        return "/local" + in.substr(9);
    }
    return in;
}

// Segmento inteiro: "/localfoo"/"/sdcard" passavam no prefixo cru e o
// sendFile faz fopen direto (o FileSystem:: ja checava o segmento)
static bool pathAllowed(const std::string& p) {
    auto under = [&p](const char* mount) {
        size_t n = strlen(mount);
        return p.compare(0, n, mount) == 0 && (p.size() == n || p[n] == '/');
    };
    return under("/local") || under("/sd");
}

// Sem CORS ("Access-Control-Allow-Origin: *" deixava QUALQUER site aberto
// no navegador de alguem da rede LER os arquivos do aparelho). A pagina do
// file manager e servida pelo proprio aparelho: mesma origem, nao precisa.
static void addCORS(httpd_req_t* req) { (void)req; }

// Anti-CSRF: rotas que alteram estado (POST/DELETE) exigem o cabecalho
// X-Celer-Request. Um formulario/fetch "simples" de outro site nao consegue
// envia-lo (header customizado forca preflight, que o servidor nao aprova).
// As paginas do proprio aparelho (file manager, /update) enviam o header.
static const char* CSRF_HEADER = "X-Celer-Request";

// Cadeia de guarda de cada rota: WebAuth (Basic Auth — toda requisicao,
// GET incluso) -> CSRF (mutacoes) -> handler real. Antes da v1.3 so as
// mutacoes tinham o csrfGuard e qualquer cliente da LAN podia ler arquivos
// e regravar firmware.
struct RouteCtx {
    esp_err_t (*handler)(httpd_req_t* req);
    bool csrf;
};

// Conta a requisicao durante toda a vida do handler (inclusive auth/CSRF).
struct ActiveReq {
    ActiveReq() { s_activeReqs.fetch_add(1, std::memory_order_relaxed); }
    ~ActiveReq() { s_activeReqs.fetch_sub(1, std::memory_order_relaxed); }
};

static esp_err_t routeGuard(httpd_req_t* req) {
    // Conta a requisicao ANTES de qualquer guarda: o stop/disable da main task
    // le este contador para saber se pode derrubar o httpd. Incrementar
    // depois do check deixava uma janela em que a requisicao ja entrou mas o
    // contador ainda lia 0 — o httpd_stop entao ESPERAVA o handler (upload
    // de minutos) e a main task morria no TWDT.
    ActiveReq active;
    // Servidor em parada: nao deixa um upload NOVO entrar e prolongar o
    // httpd_stop que a main task esta esperando.
    if (s_stopPending.load(std::memory_order_relaxed)) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_set_type(req, HTTPD_TYPE_TEXT);
        httpd_resp_sendstr(req, "Server stopping");
        return ESP_OK;
    }
    if (!WebAuth::check(req)) return ESP_OK;  // 401/429 ja enviados

    RouteCtx* c = (RouteCtx*)req->user_ctx;
    if (c->csrf) {
        char v[8];
        if (httpd_req_get_hdr_value_str(req, CSRF_HEADER, v, sizeof(v)) != ESP_OK) {
            httpd_resp_set_status(req, "403 Forbidden");
            httpd_resp_set_type(req, HTTPD_TYPE_TEXT);
            httpd_resp_sendstr(req, "Forbidden: missing X-Celer-Request header");
            return ESP_OK;
        }
    }
    return c->handler(req);
}

// Decodifica %XX e '+' usando a implementacao do portal de configuracao
// (mesma semantica; era uma copia local deste arquivo).
static bool getQueryParam(httpd_req_t* req, const char* key, std::string& out) {
    char query[512];
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK) return false;
    char value[400];
    if (httpd_query_key_value(query, key, value, sizeof(value)) != ESP_OK) return false;
    out = CaptivePortal::urlDecode(value);
    return true;
}

// ---------------------------------------------------------------------------
// Corpo urlencoded em buffer mallocado (nothrow)
// ---------------------------------------------------------------------------

// Corpo do POST em buffer mallocado: um std::string de ate 8 KB no heap
// apertado da CYD aborta o device quando o new falha (-fno-exceptions:
// operator new sem excecao = abort). Mesmo padrao do HttpClient::setBodySink
// para caminhos sem PSRAM.
struct BodyBuf {
    char* data = nullptr;  // NUL-terminado (quando len>0)
    size_t len = 0;
    ~BodyBuf() { free(data); }
};

static int hexVal(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// Le o corpo inteiro (urlencoded, ate limit bytes).
// Retorna 0 = ok; 1 = corpo acima do limite (drenado ate 64 KB — cliente
// legitimo recebe resposta limpa sem envenenar a conexao keep-alive; acima
// disso o httpd fecha a sessao sozinho ao parser o lixo seguinte);
// 2 = heap recusou o buffer ou a leitura caiu no meio.
static int readBody(httpd_req_t* req, BodyBuf& out, size_t limit = 8192) {
    size_t remaining = req->content_len;
    if (remaining > limit) {
        char sink[512];
        size_t drained = 0;
        while (drained < 65536 && remaining > 0) {
            size_t want = remaining < sizeof(sink) ? remaining : sizeof(sink);
            int r = httpd_req_recv(req, sink, want);
            if (r <= 0) break;  // cliente sumiu / timeout do httpd
            drained += (size_t)r;
            remaining -= (size_t)r;
        }
        return 1;
    }
    out.data = (char*)malloc(remaining + 1);
    if (out.data == nullptr) return 2;
    size_t got = 0;
    while (got < remaining) {
        int r = httpd_req_recv(req, out.data + got, remaining - got);
        if (r <= 0) return 2;
        got += (size_t)r;
    }
    out.data[got] = '\0';
    out.len = got;
    return 0;
}

// Parametro urlencoded do corpo para buffer de capacidade fixa: acha "key="
// no inicio do corpo ou logo apos um '&', recorta ate o '&' seguinte e
// decodifica %XX/'+' direto no destino (decodificado nunca e maior que o
// cru — a escrita corre atras da leitura, entao out pode ser o PROPRIO
// buffer do corpo: decodificacao in place, sem copia). false = ausente,
// nao cabe no destino ou valor vazio (allowEmpty: valor vazio vale).
static bool bodyParam(const BodyBuf& body, const char* key, char* out, size_t cap,
                      bool allowEmpty = false) {
    size_t keyLen = strlen(key);
    if (body.data == nullptr || keyLen == 0 || cap == 0) return false;

    size_t i = 0;
    bool found = false;
    while (i + keyLen + 1 <= body.len) {
        if ((i == 0 || body.data[i - 1] == '&') &&
            memcmp(body.data + i, key, keyLen) == 0 && body.data[i + keyLen] == '=') {
            found = true;
            break;
        }
        i++;
    }
    if (!found) return false;

    size_t start = i + keyLen + 1;
    size_t end = start;
    while (end < body.len && body.data[end] != '&') end++;

    size_t o = 0;
    for (size_t p = start; p < end; p++) {
        char c = body.data[p];
        char dec;
        int step = 1;
        if (c == '%' && p + 2 < end) {
            int hi = hexVal(body.data[p + 1]);
            int lo = hexVal(body.data[p + 2]);
            if (hi >= 0 && lo >= 0) {
                dec = (char)((hi << 4) | lo);
                step = 3;
            } else {
                dec = c;
            }
        } else if (c == '+') {
            dec = ' ';
        } else {
            dec = c;
        }
        if (o + 1 >= cap) return false;  // nao cabe no destino
        out[o++] = dec;
        p += (size_t)(step - 1);
    }
    out[o] = '\0';
    return allowEmpty || o > 0;
}

// Variante para os campos pequenos (path/type/oldPath/newPath): teto de 300
// no valor — path maior que isso e hostile e vira 400 no chamador.
static bool bodyParam(const BodyBuf& body, const char* key, std::string& out) {
    char buf[300];
    if (!bodyParam(body, key, buf, sizeof(buf))) return false;
    out = buf;
    return true;
}

static void sendText(httpd_req_t* req, int code, const char* text) {
    httpd_resp_set_status(req, code == 200 ? "200 OK" :
                                code == 400 ? "400 Bad Request" :
                                code == 404 ? "404 Not Found" :
                                code == 413 ? "413 Content Too Large" :
                                code == 500 ? "500 Server Error" : "418 I'm a teapot");
    httpd_resp_set_type(req, HTTPD_TYPE_TEXT);
    addCORS(req);
    httpd_resp_send(req, text, strlen(text));
}

// Segmento ".." no caminho: o VFS entrega o resto literal ao driver (FATFS
// resolve ".."; LittleFS nao tem entrada "."/".." mas aceita o nome) —
// nenhum uso legitimo no file manager e a defesa custa uma passada. Nome
// COM ".." no meio ("a..b.txt") segue valido.
static bool hasDotDot(const std::string& p) {
    size_t pos = 0;
    while ((pos = p.find("..", pos)) != std::string::npos) {
        bool startOk = (pos == 0 || p[pos - 1] == '/');
        bool endOk = (pos + 2 >= p.size() || p[pos + 2] == '/');
        if (startOk && endOk) return true;
        pos += 2;
    }
    return false;
}

// Prologo comum das rotas de arquivo: normaliza e valida o segmento do
// caminho; fora das montagens permitidas (ou com segmento "..") responde
// 400 e devolve false.
static bool safePath(httpd_req_t* req, std::string& path) {
    path = normalizePath(path);
    if (pathAllowed(path) && !hasDotDot(path)) return true;
    sendText(req, 400, "Invalid storage");
    return false;
}

// Prologo das rotas de arquivo por query string: le ?<key>= (responde 400
// "Missing <key> parameter" se ausente) e valida a montagem com safePath.
static bool queryPath(httpd_req_t* req, const char* key, std::string& path) {
    if (!getQueryParam(req, key, path)) {
        sendText(req, 400, (std::string("Missing ") + key + " parameter").c_str());
        return false;
    }
    return safePath(req, path);
}

// Prologo das rotas POST de arquivo (corpo urlencoded): le o body, extrai
// "path" e o campo extra informado (400 "Missing parameters" se algo faltar
// ou nao couber; 413 corpo acima do limite; 500 heap recusou o buffer) e
// valida a montagem com safePath. O BodyBuf vive so no escopo: liberado ao
// voltar (o conteudo que o handler usa ja foi copiado/gravado).
static bool bodyPath(httpd_req_t* req, const char* extraKey, std::string& path, std::string& extra) {
    BodyBuf body;
    int rc = readBody(req, body);
    if (rc == 1) {
        sendText(req, 413, "Body too large");
        return false;
    }
    if (rc != 0 || !bodyParam(body, "path", path) || !bodyParam(body, extraKey, extra)) {
        sendText(req, rc != 0 ? 500 : 400, rc != 0 ? "sem memoria" : "Missing parameters");
        return false;
    }
    return safePath(req, path);
}

// Epilogo das mutacoes de arquivo: 200 "OK" ou 500 com a mensagem de falha
static void replyOk(httpd_req_t* req, bool ok, const char* failMsg) {
    sendText(req, ok ? 200 : 500, ok ? "OK" : failMsg);
}

// Envia arquivo em chunks (download/editor)
static void sendFile(httpd_req_t* req, const std::string& path, const char* type, bool attachment) {
    FILE* f = fopen(path.c_str(), "rb");
    if (f == nullptr) {
        sendText(req, 404, "File not found");
        return;
    }
    httpd_resp_set_type(req, type);
    addCORS(req);
    if (attachment) {
        std::string basename = path;
        int slash = kstr::lastIndexOf(basename, '/');
        if (slash >= 0) basename = basename.substr(slash + 1);
        // Aspas/CR/LF no nome do arquivo (criado pelo proprio upload) eram
        // injecao de cabecalho na resposta; qualquer controle vira '_'.
        for (char& c : basename) {
            if (c == '"' || (unsigned char)c < 0x20) c = '_';
        }
        std::string cd = "attachment; filename=\"" + basename + "\"";
        httpd_resp_set_hdr(req, "Content-Disposition", cd.c_str());
    }
    char buf[2048];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
        if (httpd_resp_send_chunk(req, buf, n) != ESP_OK) {
            fclose(f);
            return;
        }
    }
    fclose(f);
    httpd_resp_send_chunk(req, nullptr, 0);
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

static esp_err_t handler_index(httpd_req_t* req) {
    addCORS(req);
    sendGzipHtml(req, filemanager_gz_start, filemanager_gz_end);
    return ESP_OK;
}

static esp_err_t handler_list(httpd_req_t* req) {
    std::string dirPath;
    if (!queryPath(req, "dir", dirPath)) {
        return ESP_OK;
    }
    if (!FileSystem::isDirectory(dirPath.c_str())) {
        sendText(req, 404, "Not a directory");
        return ESP_OK;
    }

    // No heap, nao na pilha do httpd (64 x FileEntry ~3 KB era o pico dela);
    // nothrow: sem excecoes, um new que falha abortaria o aparelho
    constexpr int kMax = 64;
    FileEntry* entries = new (std::nothrow) FileEntry[kMax];
    if (entries == nullptr) {
        sendText(req, 500, "sem memoria");
        return ESP_OK;
    }
    int count = FileSystem::listDirectory(dirPath.c_str(), entries, kMax);

    JsonDocument doc;
    JsonArray array = doc.to<JsonArray>();
    for (int i = 0; i < count; i++) {
        JsonObject item = array.add<JsonObject>();
        item["name"] = entries[i].name;
        item["type"] = entries[i].isDir ? "dir" : "file";
        item["size"] = entries[i].isDir ? 0 : FileSystem::getFileSize(entries[i].path.c_str());
    }
    delete[] entries;

    std::string response;
    serializeJson(doc, response);
    httpd_resp_set_type(req, "application/json");
    addCORS(req);
    httpd_resp_send(req, response.c_str(), response.length());
    return ESP_OK;
}

static esp_err_t handler_edit_get(httpd_req_t* req) {
    std::string path;
    if (!queryPath(req, "path", path)) {
        return ESP_OK;
    }
    if (!FileSystem::exists(path.c_str())) {
        sendText(req, 404, "File not found");
        return ESP_OK;
    }
    sendFile(req, path, "text/plain", false);
    return ESP_OK;
}

static esp_err_t handler_edit_post(httpd_req_t* req) {
    BodyBuf body;
    int rc = readBody(req, body);
    if (rc != 0) {
        // 1 = corpo acima do limite (drenado); 2 = heap/leitura falhou
        sendText(req, rc == 1 ? 413 : 500, rc == 1 ? "Body too large" : "sem memoria");
        return ESP_OK;
    }
    // "path" vai para std::string ANTES do decode in place do "content":
    // o decode reescreve o proprio buffer do corpo.
    std::string path;
    if (!bodyParam(body, "path", path) || !safePath(req, path)) {
        sendText(req, 400, "Missing parameters");
        return ESP_OK;
    }
    // Conteudo decodificado DENTRO do buffer do corpo (nunca cresce) e
    // gravado como const char*: nenhum std::string grande no caminho —
    // o post de 8 KB do editor nao aposta o device num malloc falho.
    // allowEmpty: salvar o editor VAZIO (limpar um arquivo) e legitimo — sem
    // isso o campo vazio virava "Missing parameters" e o arquivo nao limpava.
    if (!bodyParam(body, "content", body.data, body.len + 1, true)) {
        sendText(req, 400, "Missing parameters");
        return ESP_OK;
    }
    bool ok = FileSystem::writeTextFile(path.c_str(), body.data);
    replyOk(req, ok, "Failed to write file");
    return ESP_OK;
}

static esp_err_t handler_download(httpd_req_t* req) {
    std::string path;
    if (!queryPath(req, "path", path)) {
        return ESP_OK;
    }
    if (!FileSystem::exists(path.c_str())) {
        sendText(req, 404, "File not found");
        return ESP_OK;
    }
    sendFile(req, path, "application/octet-stream", true);
    return ESP_OK;
}

static esp_err_t handler_delete(httpd_req_t* req) {
    std::string path;
    if (!queryPath(req, "path", path)) {
        return ESP_OK;
    }

    bool ok;
    if (FileSystem::isDirectory(path.c_str())) {
        ok = FileSystem::rmdir(path.c_str());
    } else {
        ok = FileSystem::deleteFile(path.c_str());
    }
    replyOk(req, ok, "Delete failed");
    return ESP_OK;
}

static esp_err_t handler_create(httpd_req_t* req) {
    std::string path, type;
    if (!bodyPath(req, "type", path, type)) {
        return ESP_OK;
    }

    bool ok;
    if (type == "folder") {
        ok = FileSystem::mkdir(path.c_str());
    } else {
        ok = FileSystem::writeTextFile(path.c_str(), "");
    }
    replyOk(req, ok, "Create failed");
    return ESP_OK;
}

static esp_err_t handler_rename(httpd_req_t* req) {
    // Prologo manual (nao encaixa no bodyPath): extrai e valida DOIS
    // caminhos — old e new
    BodyBuf body;
    int rc = readBody(req, body);
    if (rc != 0) {
        sendText(req, rc == 1 ? 413 : 500, rc == 1 ? "Body too large" : "sem memoria");
        return ESP_OK;
    }
    std::string oldPath, newPath;
    if (!bodyParam(body, "oldPath", oldPath) || !bodyParam(body, "newPath", newPath)) {
        sendText(req, 400, "Missing parameters");
        return ESP_OK;
    }
    if (!safePath(req, oldPath) || !safePath(req, newPath)) {
        return ESP_OK;
    }

    // Mesmo ponto de montagem (rename cross-device nao existe em POSIX)
    bool sameMount = (kstr::startsWith(oldPath, "/sd") == kstr::startsWith(newPath, "/sd"));
    if (!sameMount) {
        sendText(req, 400, "Cannot rename across different storages");
        return ESP_OK;
    }
    bool ok = FileSystem::renameFile(oldPath.c_str(), newPath.c_str());
    replyOk(req, ok, "Rename failed");
    return ESP_OK;
}

// ---------------------------------------------------------------------------
// Parser multipart compartilhado (upload de arquivos e firmware web)
// ---------------------------------------------------------------------------

struct MultipartCtx {
    std::string boundary;      // ja com "--" prefixo
    std::string dataMarker;    // "\r\n" + boundary, montado UMA vez: construir
                               // por chunk (2 KB) alocava a cada pacote do upload
    std::string tail;
    bool firmwareRoute = false;  // POST /update: qualquer parte com arquivo e
                                 // firmware (a pagina manda campo "update" com
                                 // filename relativo — "CelerOS.bin")
    bool opened = false;         // alguma parte de arquivo/firmware apareceu?
    enum State { PREAMBLE, HEADERS, DATA, DONE } state = PREAMBLE;

    // destino
    FILE* file = nullptr;
    std::string filePath;
    std::string partPath;      // escrita em curso (renomeada para filePath no fim)
    bool isFirmware = false;
    esp_ota_handle_t ota = 0;
    const esp_partition_t* part = nullptr;
    bool errored = false;
    std::string error;

    void fail(const std::string& msg) {
        if (!errored) {
            errored = true;
            error = msg;
            ESP_LOGE(WM_TAG, "multipart: %s", msg.c_str());
        }
    }

    void openDest(std::string fname) {
        opened = true;  // parte de arquivo reconhecida (mesmo que falhe depois)
        if (firmwareRoute) {
            isFirmware = true;
            if (!OtaGuard::acquire()) {  // celerctl push em curso: nao pisa
                fail("another OTA write in progress (celerctl?)");
                return;
            }
            // O mesmo motivo do ota push: app aberto disputa flash/PSRAM com
            // as gravacoes e derruba o upload no meio — sai dele antes do
            // primeiro esp_ota_begin (guard ja seguro: recusado acima nao
            // derruba o app a toa)
            OtaManager::evictRunningApp();
            part = esp_ota_get_next_update_partition(nullptr);
            if (part == nullptr) { fail("no ota partition"); OtaGuard::release(); return; }
            esp_err_t err = esp_ota_begin(part, OTA_SIZE_UNKNOWN, &ota);
            if (err != ESP_OK) { fail(esp_err_to_name(err)); OtaGuard::release(); return; }
            ESP_LOGI(WM_TAG, "OTA web: escrevendo em %s", part->label);
            return;
        }

        // Upload de arquivo comum: filename do form e o caminho absoluto
        filePath = normalizePath(fname);
        // Mesma defesa das rotas query/body (safePath): segmento ".." sai do
        // diretorio no FATFS do SD ("../x" sobe da pasta de destino)
        if (!pathAllowed(filePath) || hasDotDot(filePath)) { fail("invalid path " + filePath); return; }

        // Intercepta apps e respeita o local padrao de instalacao
        if (kstr::startsWith(filePath, "/local/apps/") || kstr::startsWith(filePath, "/sd/apps/")) {
            bool defaultSD = cfgFlag("install_sd");
            int appsIndex = kstr::indexOf(filePath, "/apps/");
            std::string relativePath = filePath.substr(appsIndex + 6);
            if (defaultSD && FileSystem::exists("/sd/")) {
                filePath = "/sd/apps/" + relativePath;
            } else {
                filePath = "/local/apps/" + relativePath;
            }
        }

        // Garante diretorios pais
        int pos = 0;
        while ((pos = kstr::indexOf(filePath, '/', pos + 1)) > 0) {
            std::string dirPath = filePath.substr(0, pos);
            if (!FileSystem::exists(dirPath.c_str())) {
                FileSystem::mkdir(dirPath.c_str());
            }
        }

        // Escreve ao lado e so troca no fim: abrir o destino com "wb" zerava
        // o arquivo existente e uma queda no meio do upload (WiFi, aba
        // fechada) o apagava de vez — reenviar o main.js de um app que
        // falhava deixava o app sem fonte
        partPath = filePath + ".part";
        file = fopen(partPath.c_str(), "wb");
        if (file == nullptr) fail("cannot open " + filePath);
    }

    void writeData(const char* data, size_t len) {
        if (errored || len == 0) return;
        if (isFirmware) {
            if (esp_ota_write(ota, data, len) != ESP_OK) fail("ota write");
        } else if (file != nullptr) {
            if (fwrite(data, 1, len, file) != len) fail("file write");
        }
    }

    void closeDest(bool finished) {
        if (file != nullptr) {
            if (fclose(file) != 0) fail("file write");  // flush final (disco cheio)
            file = nullptr;
            if (errored || !finished) {
                remove(partPath.c_str());  // nao deixa parcial; o original fica
            } else if (!FileSystem::renameFile(partPath.c_str(), filePath.c_str())) {
                remove(partPath.c_str());
                fail("cannot replace " + filePath);
            }
        }
        if (isFirmware && ota != 0) {
            if (errored || !finished) {
                esp_ota_abort(ota);
            } else if (esp_ota_end(ota) != ESP_OK) {
                fail("esp_ota_end");
            } else if (esp_ota_set_boot_partition(part) != ESP_OK) {
                fail("set_boot_partition");
            } else {
                ESP_LOGI(WM_TAG, "OTA web: flash OK, agendando reboot");
                s_rebootPending = true;
            }
            ota = 0;
            OtaGuard::release();  // slot livre p/ celerctl/hub de novo
        }
    }
};

// Processa um chunk do corpo multipart
static void multipartFeed(MultipartCtx& ctx, const char* data, size_t len) {
    if (ctx.errored) return;
    // Corpo depois do "--boundary--" final: o parser nao tem mais trabalho;
    // sem este retorno o tail acumulava TUDO que o cliente seguiu mandando
    // (Content-Length maior que o corpo real) ate esgotar o heap — com
    // -fno-exceptions o abort derruba o aparelho (DoS com um POST /api/upload
    // ou /update seguido de lixo infinito).
    if (ctx.state == MultipartCtx::DONE) return;
    ctx.tail.append(data, len);

    // Limite de seguranca do buffer de headers
    while (!ctx.errored) {
        if (ctx.state == MultipartCtx::PREAMBLE) {
            int pos = kstr::indexOf(ctx.tail, ctx.boundary);
            if (pos < 0) {
                // descarta tudo exceto um possivel boundary parcial no fim
                if (ctx.tail.size() > ctx.boundary.size() + 4) {
                    ctx.tail.erase(0, ctx.tail.size() - (ctx.boundary.size() + 4));
                }
                return;
            }
            ctx.tail.erase(0, pos + ctx.boundary.size());
            // apos o boundary: "--" (fim) ou "\r\n" (headers)
            if (kstr::startsWith(ctx.tail, "--")) { ctx.state = MultipartCtx::DONE; return; }
            if (kstr::startsWith(ctx.tail, "\r\n")) ctx.tail.erase(0, 2);
            ctx.state = MultipartCtx::HEADERS;

        } else if (ctx.state == MultipartCtx::HEADERS) {
            int sep = kstr::indexOf(ctx.tail, "\r\n\r\n");
            if (sep < 0) {
                if (ctx.tail.size() > 1024) ctx.fail("headers too large");
                return;
            }
            std::string headers = ctx.tail.substr(0, sep);
            ctx.tail.erase(0, sep + 4);

            // Content-Disposition: form-data; name="x"; filename="y".
            // O "name" do campo nao decide mais nada (a rota decide: /update
            // trata qualquer parte com arquivo como firmware; /api/upload
            // exige filename absoluto) — so o filename e lido.
            std::string fileName;
            int cd = kstr::indexOf(headers, "Content-Disposition:");
            if (cd < 0) cd = kstr::indexOf(headers, "content-disposition:");
            if (cd < 0) { ctx.fail("no content-disposition"); return; }

            int fq = kstr::indexOf(headers, "filename=\"", cd);
            if (fq >= 0) {
                int endf = kstr::indexOf(headers, '"', fq + 10);
                if (endf > 0) fileName = headers.substr(fq + 10, endf - fq - 10);
            }

            if ((ctx.firmwareRoute && !fileName.empty()) ||
                (!ctx.firmwareRoute && !fileName.empty() && fileName[0] == '/')) {
                ctx.openDest(fileName);
                ctx.state = MultipartCtx::DATA;
            } else {
                // campo sem arquivo (ex: submit) — descarta ate o proximo boundary
                ctx.state = MultipartCtx::DATA;
                ctx.filePath = "";  // sem destino
            }

        } else if (ctx.state == MultipartCtx::DATA) {
            const std::string& marker = ctx.dataMarker;
            int pos = kstr::indexOf(ctx.tail, marker);
            if (pos < 0) {
                // mantem apenas um tail suficiente p/ conter o marker parcial
                size_t keep = marker.size() + 4;
                if (ctx.tail.size() > keep) {
                    size_t emit = ctx.tail.size() - keep;
                    if (!ctx.filePath.empty() || ctx.isFirmware) ctx.writeData(ctx.tail.data(), emit);
                    ctx.tail.erase(0, emit);
                }
                return;
            }
            // emite ate o marker
            if (pos > 0 && (!ctx.filePath.empty() || ctx.isFirmware)) {
                ctx.writeData(ctx.tail.data(), pos);
            }
            ctx.tail.erase(0, pos + marker.size());
            ctx.closeDest(true);
            ctx.isFirmware = false;
            ctx.filePath = "";

            if (kstr::startsWith(ctx.tail, "--")) { ctx.state = MultipartCtx::DONE; return; }
            if (kstr::startsWith(ctx.tail, "\r\n")) ctx.tail.erase(0, 2);
            ctx.state = MultipartCtx::HEADERS;

        } else {  // DONE
            return;
        }
    }
}

// Consome o corpo inteiro de um POST multipart. firmwareRoute: POST /update
// (qualquer parte com arquivo vai para o slot OTA); false: /api/upload
// (filename absoluto e caminho no fs).
// Teto do corpo multipart: o firmware de fabrica e ~2,5 MB e uploads de
// arquivos ficam longe disso; um Content-Length gigante (ou infinito, pingando
// byte a byte) mantinha o handler (e o httpd) preso drenando para sempre —
// o mesmo DoS que o readBody fecha com o limite dele.
constexpr size_t kMultipartMax = 16 * 1024 * 1024;

static esp_err_t handleMultipart(httpd_req_t* req, const char* okMsg, bool firmwareRoute) {
    char ct[160];
    if (httpd_req_get_hdr_value_str(req, "Content-Type", ct, sizeof(ct)) != ESP_OK) {
        sendText(req, 400, "Missing Content-Type");
        return ESP_OK;
    }
    int bpos = kstr::indexOf(ct, "boundary=");
    if (bpos < 0) {
        sendText(req, 400, "Missing boundary");
        return ESP_OK;
    }
    std::string bval = ct + bpos + 9;
    int bend = kstr::indexOf(bval, ';');
    if (bend > 0) bval = bval.substr(0, bend);
    bval = kstr::trim(bval);
    // RFC 2046 permite boundary entre aspas (curl/custom fazem; browsers nao):
    // sem tirar as aspas o parser nunca casa e o corpo inteiro era descartado.
    if (bval.size() >= 2 && bval.front() == '"' && bval.back() == '"') {
        bval = bval.substr(1, bval.size() - 2);
    }
    // 70 = teto do RFC 2046; boundary vazio/absurdo viraria "--" e casaria
    // com qualquer coisa (ou varreria o buffer sem achar nada)
    if (bval.empty() || bval.size() > 70) {
        sendText(req, 400, "Bad boundary");
        return ESP_OK;
    }

    if (req->content_len > kMultipartMax) {
        sendText(req, 413, "Body too large");
        return ESP_OK;
    }

    MultipartCtx ctx;
    ctx.firmwareRoute = firmwareRoute;
    ctx.boundary = "--" + bval;
    ctx.dataMarker = "\r\n" + ctx.boundary;

    size_t remaining = req->content_len;
    char buf[2048];
    size_t drained = 0;  // descarte apos o fim do multipart (teto igual ao readBody)
    while (remaining > 0 && !ctx.errored) {
        size_t want = remaining > sizeof(buf) ? sizeof(buf) : remaining;
        int got = httpd_req_recv(req, buf, want);
        if (got <= 0) { ctx.fail("connection lost"); break; }
        remaining -= (size_t)got;
        if (ctx.state == MultipartCtx::DONE) {
            // excedente do Content-Length: drena (cliente legitimo recebe a
            // resposta limpa sem envenenar o keep-alive) com o mesmo teto de
            // 64 KB do readBody — acima disso o httpd fecha a sessao sozinho
            drained += (size_t)got;
            if (drained > 65536) break;
            continue;
        }
        multipartFeed(ctx, buf, (size_t)got);
    }

    // fecha o que ficou aberto (fim abrupto)
    ctx.closeDest(!ctx.errored && ctx.state == MultipartCtx::DONE);

    if (ctx.errored) {
        sendText(req, 500, ctx.error.c_str());
    } else if (!ctx.opened) {
        // Corpo sem NENHUMA parte de arquivo: resposta 200 aqui era sucesso
        // falso (o /update "flasava" sem escrever um byte).
        sendText(req, 400, "No file in body");
    } else {
        sendText(req, 200, okMsg);
    }
    return ESP_OK;
}

static esp_err_t handler_upload(httpd_req_t* req) {
    return handleMultipart(req, "Upload Complete", false);
}

// ---------------------------------------------------------------------------
// Tela no navegador: /screen (pagina), /api/screen (um quadro RLE), /api/touch
// ---------------------------------------------------------------------------
#if CONFIG_CELEROS_UI

static esp_err_t handler_screen_page(httpd_req_t* req) {
    return sendGzipHtml(req, screen_gz_start, screen_gz_end);
}

// Um quadro: u16 w + u16 h + u8 formato (1 = RLE) e os pares {u16 contagem,
// u16 pixel RGB565} LE — mesmo formato do `celerctl screencap`. A leitura
// passa pela task da UI (ScreenCapture), em blocos de linhas: o aparelho
// segue fluido enquanto alguem assiste.
static esp_err_t handler_screen_frame(httpd_req_t* req) {
    constexpr size_t kCap = 2048;
    uint8_t* buf = (uint8_t*)malloc(kCap);
    if (buf == nullptr) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "sem memoria");
        return ESP_OK;
    }
    CelerDisplay& tft = Board::display();
    const uint16_t w = (uint16_t)tft.width(), h = (uint16_t)tft.height();
    httpd_resp_set_type(req, "application/octet-stream");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    const uint8_t head[5] = {(uint8_t)w, (uint8_t)(w >> 8), (uint8_t)h, (uint8_t)(h >> 8), 1};
    bool ok = httpd_resp_send_chunk(req, (const char*)head, sizeof(head)) == ESP_OK;
    if (ok) {
        ok = ScreenCapture::stream(true, buf, kCap, [req](const uint8_t* d, size_t n) {
            return httpd_resp_send_chunk(req, (const char*)d, n) == ESP_OK;
        });
    }
    free(buf);
    httpd_resp_send_chunk(req, nullptr, 0);  // fim do chunked (tambem apos falha)
    return ESP_OK;
}

// POST /api/touch?d=1|0&x=..&y=.. (pixels fisicos): mesma fila do
// `celerctl tap` (TouchInjector) — o toque do navegador vale como o do dedo
static esp_err_t handler_touch(httpd_req_t* req) {
    char q[48] = "", v[8];
    httpd_req_get_url_query_str(req, q, sizeof(q));
    kui::TouchInjector::Sample s;
    s.down = httpd_query_key_value(q, "d", v, sizeof(v)) == ESP_OK && v[0] == '1';
    s.x = httpd_query_key_value(q, "x", v, sizeof(v)) == ESP_OK ? (uint16_t)atoi(v) : 0;
    s.y = httpd_query_key_value(q, "y", v, sizeof(v)) == ESP_OK ? (uint16_t)atoi(v) : 0;
    s.delayMs = 0;
    if (!kui::TouchInjector::push(&s, 1)) {
        httpd_resp_set_status(req, "409 Conflict");
        httpd_resp_sendstr(req, "fila de toque cheia");
        return ESP_OK;
    }
    httpd_resp_sendstr(req, "ok");
    return ESP_OK;
}
#endif  // CONFIG_CELEROS_UI

static esp_err_t handler_update_get(httpd_req_t* req) {
    addCORS(req);
    sendGzipHtml(req, ota_upload_gz_start, ota_upload_gz_end);
    return ESP_OK;
}

static esp_err_t handler_update_post(httpd_req_t* req) {
    return handleMultipart(req, "OK - rebooting", true);
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

void WebManager::startWebServerIfNeeded() {
    if (s_server != nullptr) return;
    WebAuth::init();  // garante senha antes do primeiro 401

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = 80;
    // Pilha interna (os handlers gravam flash: LittleFS e OTA). Pico medido
    // no watch com list + upload + download + tela: ~6,3 KB, ~3 KB dele o
    // FileEntry[64] do list, que foi para o heap. 10 KB = ~2x o pico; os
    // 16 KB de antes custavam 6 KB a mais de RAM interna em toda placa.
    config.stack_size = 10240;
    config.max_uri_handlers = 16;
    config.lru_purge_enable = true;

    if (httpd_start(&s_server, &config) != ESP_OK) {
        s_server = nullptr;
        celer_log_println("Failed to start web server");
        return;
    }

    // Tabela unica {uri, metodo, RouteCtx}: antes eram duas listas paralelas
    // (14 RouteCtx nomeados + array httpd_uri_t) mantidas em sincronia a mao.
    // O array e static const: o RouteCtx embutido vive em storage estatico —
    // o user_ctx do esp_http_server e um ponteiro, nao uma copia.
    static const struct RouteDef {
        const char* uri;
        httpd_method_t method;
        RouteCtx ctx;
    } kRoutes[] = {
        {"/",             HTTP_GET,    {handler_index, false}},
        {"/api/list",     HTTP_GET,    {handler_list, false}},
        {"/api/edit",     HTTP_GET,    {handler_edit_get, false}},
        {"/api/edit",     HTTP_POST,   {handler_edit_post, true}},
        {"/api/download", HTTP_GET,    {handler_download, false}},
        {"/api/delete",   HTTP_DELETE, {handler_delete, true}},
        {"/api/create",   HTTP_POST,   {handler_create, true}},
        {"/api/rename",   HTTP_POST,   {handler_rename, true}},
        {"/api/upload",   HTTP_POST,   {handler_upload, true}},
        {"/update",       HTTP_GET,    {handler_update_get, false}},
        {"/update",       HTTP_POST,   {handler_update_post, true}},
#if CONFIG_CELEROS_UI
        {"/screen",       HTTP_GET,    {handler_screen_page, false}},
        {"/api/screen",   HTTP_GET,    {handler_screen_frame, false}},
        {"/api/touch",    HTTP_POST,   {handler_touch, true}},  // injeta toque: exige o header anti-CSRF
#endif
    };
    for (const auto& r : kRoutes) {
        const httpd_uri_t uri = {r.uri, r.method, routeGuard, (void*)&r.ctx};
        httpd_register_uri_handler(s_server, &uri);
    }

    celer_log_println("Web Server started on port 80 (senha: app Web Server / celerctl info)");
}

#else  // !CONFIG_CELEROS_WEB_SERVER: build sem servidor web (file manager + /update)

void WebManager::startWebServerIfNeeded() {}

#endif
