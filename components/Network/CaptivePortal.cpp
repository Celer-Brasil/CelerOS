#include "CaptivePortal.h"
#include "NetworkManager.h"
#include "WifiConnection.h"

#include "esp_log.h"
#include "esp_http_server.h"
#include "esp_wifi.h"
#include "lwip/sockets.h"
#include "lwip/dns.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include <cstring>
#include <cstdio>
#include <algorithm>

// Pagina de configuracao: components/Network/captive_portal.html, gzipada no
// build (CMakeLists) e servida com Content-Encoding: gzip — ~10 KB de texto
// cru viravam ~3 KB, e cada GET / deixa de copiar a pagina para o heap.
extern const uint8_t portal_gz_start[] asm("_binary_captive_portal_html_gz_start");
extern const uint8_t portal_gz_end[] asm("_binary_captive_portal_html_gz_end");

CaptivePortal::CaptivePortal() :
    _state(CaptivePortalState::Stopped),
    _httpServer(nullptr),
    _dnsSocket(nullptr),
    _dnsTask(nullptr),
    _dnsRunning(false),
    _dnsDone(false),
    _connState(PortalConnState::Idle),
    _connMutex(nullptr) {
    _connMutex = xSemaphoreCreateMutex();
}

CaptivePortal::CaptivePortal(const CaptivePortalConfig& config) :
    _config(config),
    _state(CaptivePortalState::Stopped),
    _httpServer(nullptr),
    _dnsSocket(nullptr),
    _dnsTask(nullptr),
    _dnsRunning(false),
    _dnsDone(false),
    _connState(PortalConnState::Idle),
    _connMutex(nullptr) {
    _connMutex = xSemaphoreCreateMutex();
}

CaptivePortal::~CaptivePortal() {
    stop();
    if (_connMutex != nullptr) {
        vSemaphoreDelete(_connMutex);
        _connMutex = nullptr;
    }
}

bool CaptivePortal::start() {
    return start(_config.apSsid, _config.apPassword);
}

bool CaptivePortal::start(const std::string& apSsid, const std::string& apPassword) {
    if (_state == CaptivePortalState::Running) {
        ESP_LOGW(TAG, "Portal already running");
        return true;
    }

    _config.apSsid = apSsid;
    _config.apPassword = apPassword;
    setState(CaptivePortalState::Starting);

    ESP_LOGI(TAG, "Starting Captive Portal: %s", _config.apSsid.c_str());

    // Start Access Point
    auto& ap = WifiAP::instance();
    if (!ap.start(_config.apSsid, _config.apPassword)) {
        ESP_LOGE(TAG, "Failed to start AP");
        setState(CaptivePortalState::Error);
        return false;
    }

    // Scan for networks if configured
    if (_config.scanOnStart) {
        scanNetworks();
    }

    // Start DNS server (for captive portal redirect)
    if (!startDnsServer()) {
        ESP_LOGE(TAG, "Failed to start DNS server");
        ap.stop();
        setState(CaptivePortalState::Error);
        return false;
    }

    // Start HTTP server
    if (!startHttpServer()) {
        ESP_LOGE(TAG, "Failed to start HTTP server");
        stopDnsServer();
        ap.stop();
        setState(CaptivePortalState::Error);
        return false;
    }

    setState(CaptivePortalState::Running);
    ESP_LOGI(TAG, "Captive Portal running on http://%s", ap.getIPAddress().c_str());

    return true;
}

bool CaptivePortal::stop() {
    if (_state == CaptivePortalState::Stopped) {
        return true;
    }

    setState(CaptivePortalState::Stopping);
    ESP_LOGI(TAG, "Stopping Captive Portal...");

    stopHttpServer();
    stopDnsServer();
    WifiAP::instance().stop();

    // Reseta o resultado da tentativa anterior: sem isto, a proxima sessao
    // do portal via "connected"/"failed" velho no 1o poll de /status, antes
    // de qualquer /connect novo.
    if (_connMutex != nullptr) {
        xSemaphoreTake(_connMutex, portMAX_DELAY);
    }
    _connState = PortalConnState::Idle;
    _connIp.clear();
    if (_connMutex != nullptr) {
        xSemaphoreGive(_connMutex);
    }

    setState(CaptivePortalState::Stopped);

    ESP_LOGI(TAG, "Captive Portal stopped");
    return true;
}

int CaptivePortal::scanNetworks() {
    ESP_LOGI(TAG, "Scanning for networks...");
    
    _scannedNetworks.clear();

    // O scan bloqueante passa pelo WifiConnection (mesma chamada dos tres
    // caminhos de scan do NetworkManager): ele toma o mutex/flag de scan
    // (_scanInProgress) antes de tocar no radio. Chamando esp_wifi_scan_*
    // cru aqui, um scan da STA (roaming/Ajustes) no meio do voo cancelava o
    // scan do portal (e vice-versa).
    WifiConnection* wifi = NetworkManager::instance().getWifiConnection();
    if (wifi == nullptr) {
        ESP_LOGE(TAG, "Scan failed: NetworkManager not initialized");
        return -1;
    }
    std::vector<wifi_ap_record_t> ap_records(20);
    int count = wifi->scan(ap_records.data(), (uint16_t)ap_records.size());
    if (count < 0) {
        ESP_LOGE(TAG, "Scan failed: WifiConnection::scan error");
        return -1;
    }
    if (count == 0) {
        ESP_LOGW(TAG, "No networks found");
        return 0;
    }

    // Process results (filter duplicates and empty SSIDs)
    std::vector<std::string> seen_ssids;
    for (int i = 0; i < count; i++) {
        const wifi_ap_record_t& record = ap_records[i];
        std::string ssid = reinterpret_cast<const char*>(record.ssid);
        
        // Skip empty or invalid SSIDs
        if (ssid.empty() || ssid[0] == '\0') {
            continue;
        }

        // Skip duplicates
        if (std::find(seen_ssids.begin(), seen_ssids.end(), ssid) != seen_ssids.end()) {
            continue;
        }

        seen_ssids.push_back(ssid);
        _scannedNetworks.push_back({ssid, record.rssi});
    }

    // Sort by signal strength
    std::sort(_scannedNetworks.begin(), _scannedNetworks.end(),
              [](const auto& a, const auto& b) { return a.second > b.second; });

    ESP_LOGI(TAG, "Found %zu networks", _scannedNetworks.size());
    return static_cast<int>(_scannedNetworks.size());
}

void CaptivePortal::reportConnectionState(PortalConnState state, const std::string& ip) {
    // _connIp e std::string: o /status roda na task do httpd e um assign
    // concorrente (free do buffer antigo + new) rasgava a leitura de
    // .c_str() — troca sob a guarda.
    if (_connMutex != nullptr) {
        xSemaphoreTake(_connMutex, portMAX_DELAY);
    }
    _connState = state;
    _connIp = (state == PortalConnState::Connected) ? ip : "";
    if (_connMutex != nullptr) {
        xSemaphoreGive(_connMutex);
    }
}

bool CaptivePortal::startDnsServer() {
    ESP_LOGI(TAG, "Starting DNS server on port %d", _config.dnsPort);

    _dnsRunning = true;
    _dnsDone = false;

    // Create DNS task
    BaseType_t ret = xTaskCreate(
        dnsTaskFunc,
        "dns_server",
        4096,
        this,
        5,
        reinterpret_cast<TaskHandle_t*>(&_dnsTask)
    );

    if (ret != pdPASS) {
        ESP_LOGE(TAG, "Failed to create DNS task");
        _dnsRunning = false;
        return false;
    }

    return true;
}

void CaptivePortal::stopDnsServer() {
    _dnsRunning = false;  // encerra o loop no proximo retorno do recvfrom

    // O socket nao e fechado daqui: a task pode estar dentro do recvfrom e
    // fecharia o mesmo numero de fd depois — se o indice ja tiver sido
    // reciclado (ex.: web server subindo no mesmo instante), o close tardio
    // derruba um socket vivo. Acordamos a task com um datagrama local e o
    // close fica exclusivo de quem criou o socket (a propria task).
    if (_dnsSocket != nullptr) {
        struct sockaddr_in addr;
        memset(&addr, 0, sizeof(addr));
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = inet_addr(WifiAP::instance().getIPAddress().c_str());
        addr.sin_port = htons(_config.dnsPort);
        int wake = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        if (wake >= 0) {
            char c = 0;
            sendto(wake, &c, 1, 0, (struct sockaddr*)&addr, sizeof(addr));
            close(wake);
        }
    }

    if (_dnsTask != nullptr) {
        // Timeout do recvfrom e 1s; o datagrama acima costuma acordar em ms
        for (int i = 0; i < 20 && !_dnsDone; ++i) {
            vTaskDelay(pdMS_TO_TICKS(100));
        }
        _dnsTask = nullptr;
    }
}

void CaptivePortal::dnsTaskFunc(void* param) {
    CaptivePortal* self = static_cast<CaptivePortal*>(param);
    
    // Create UDP socket
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        ESP_LOGE(TAG, "Failed to create DNS socket");
        self->_dnsRunning = false;
        self->_dnsDone = true;
        vTaskDelete(nullptr);
        return;
    }

    self->_dnsSocket = reinterpret_cast<void*>(static_cast<intptr_t>(sock));

    // Set socket timeout
    struct timeval tv;
    tv.tv_sec = 1;
    tv.tv_usec = 0;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    // Bind to port
    struct sockaddr_in server_addr;
    memset(&server_addr, 0, sizeof(server_addr));
    server_addr.sin_family = AF_INET;
    server_addr.sin_addr.s_addr = htonl(INADDR_ANY);
    server_addr.sin_port = htons(self->_config.dnsPort);

    if (bind(sock, (struct sockaddr*)&server_addr, sizeof(server_addr)) < 0) {
        ESP_LOGE(TAG, "Failed to bind DNS socket");
        close(sock);
        self->_dnsSocket = nullptr;
        self->_dnsRunning = false;
        self->_dnsDone = true;
        vTaskDelete(nullptr);
        return;
    }

    ESP_LOGI(TAG, "DNS server started");

    // Get AP IP for responses
    std::string ap_ip = WifiAP::instance().getIPAddress();
    // inet_addr do lwip: ordem de rede, igual ao a|b<<8|c<<16|d<<24 de antes
    uint32_t ip_addr = inet_addr(ap_ip.c_str());
    if (ip_addr == IPADDR_NONE) ip_addr = 0;

    uint8_t buffer[512];
    struct sockaddr_in client_addr;
    socklen_t client_len = sizeof(client_addr);

    while (self->_dnsRunning) {
        int len = recvfrom(sock, buffer, sizeof(buffer), 0,
                          (struct sockaddr*)&client_addr, &client_len);
        
        if (len < 12) {
            continue;  // Invalid DNS packet or timeout
        }

        // Build DNS response (redirect all queries to AP IP)
        // Simple response: copy query and add answer pointing to AP IP
        
        // Set response flags
        buffer[2] = 0x81;  // Response, recursion desired
        buffer[3] = 0x80;  // Recursion available
        buffer[6] = 0x00;  // Answer count high
        buffer[7] = 0x01;  // Answer count low

        // Find end of query. O salto por comprimento de label pode passar
        // do fim do pacote (query truncada/malformada): validar antes de
        // escrever a resposta, senao estoura o buffer de 512 bytes da stack.
        int query_end = 12;
        while (query_end < len && buffer[query_end] != 0) {
            query_end += buffer[query_end] + 1;
        }
        // Precisa caber o fim da query (null + qtype + qclass) dentro do
        // pacote recebido e a resposta (16 bytes de answer + 4 de IP) no buffer
        if (query_end + 5 > len || query_end + 5 + 16 + 4 > (int)sizeof(buffer)) {
            continue;  // descarta pacote invalido
        }
        query_end += 5;  // Skip null + qtype + qclass

        // Add answer
        int answer_start = query_end;
        buffer[answer_start++] = 0xC0;  // Pointer to name
        buffer[answer_start++] = 0x0C;  // Offset 12
        buffer[answer_start++] = 0x00;  // Type A
        buffer[answer_start++] = 0x01;
        buffer[answer_start++] = 0x00;  // Class IN
        buffer[answer_start++] = 0x01;
        buffer[answer_start++] = 0x00;  // TTL
        buffer[answer_start++] = 0x00;
        buffer[answer_start++] = 0x00;
        buffer[answer_start++] = 0x3C;  // 60 seconds
        buffer[answer_start++] = 0x00;  // Data length
        buffer[answer_start++] = 0x04;  // 4 bytes
        
        // IP address (already in network byte order)
        memcpy(&buffer[answer_start], &ip_addr, 4);
        answer_start += 4;

        // Send response
        sendto(sock, buffer, answer_start, 0,
               (struct sockaddr*)&client_addr, client_len);
    }

    close(sock);
    self->_dnsSocket = nullptr;
    self->_dnsDone = true;
    ESP_LOGI(TAG, "DNS server stopped");
    vTaskDelete(nullptr);
}

namespace {

// Resposta HTTP de uma vez (tipo + corpo); usada pelos handlers abaixo.
esp_err_t sendStr(httpd_req_t* req, const char* type, const char* body, size_t len) {
    httpd_resp_set_type(req, type);
    return httpd_resp_send(req, body, len);
}

// Escapa para string JSON so os metacaracteres (" \\ e controles); UTF-8
// passa inteiro (a pagina insere via textContent).
void appendJsonEscaped(std::string& out, const std::string& in) {
    for (unsigned char c : in) {
        if (c == '"') {
            out += "\\\"";
        } else if (c == '\\') {
            out += "\\\\";
        } else if (c < 0x20) {
            char esc[8];
            snprintf(esc, sizeof(esc), "\\u%04x", (unsigned)c);
            out += esc;
        } else {
            out += static_cast<char>(c);
        }
    }
}

} // namespace

bool CaptivePortal::startHttpServer() {
    ESP_LOGI(TAG, "Starting HTTP server on port %d", _config.httpPort);

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = _config.httpPort;
    // 4 handlers proprios + 7 URIs de deteccao de captive: 11 no total —
    // com 8 os tres ultimos falhavam em silencio e o popup do Windows
    // (ncsi.txt/connecttest.txt/fwlink) nao abria
    config.max_uri_handlers = 12;
    config.stack_size = 8192;
    config.lru_purge_enable = true;

    httpd_handle_t server = nullptr;
    esp_err_t err = httpd_start(&server, &config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start HTTP server: %s", esp_err_to_name(err));
        return false;
    }

    _httpServer = server;

    // Register handlers
    CaptivePortal* self = this;

    // Root handler - serves the configuration page
    httpd_uri_t root_uri = {
        .uri = "/",
        .method = HTTP_GET,
        .handler = [](httpd_req_t* req) -> esp_err_t {
            httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
            // Mesmo motivo do sendGzipHtml do WebManager: sem Cache-Control o
            // navegador cacheia heuristically (nao ha validator) e o telefone
            // podia exibir a pagina do portal de um firmware anterior.
            httpd_resp_set_hdr(req, "Cache-Control", "no-store");
            sendStr(req, "text/html", (const char*)portal_gz_start,
                    (size_t)(portal_gz_end - portal_gz_start));
            return ESP_OK;
        },
        .user_ctx = self
    };
    httpd_register_uri_handler(server, &root_uri);

    // Scan handler
    httpd_uri_t scan_uri = {
        .uri = "/scan",
        .method = HTTP_GET,
        .handler = [](httpd_req_t* req) -> esp_err_t {
            CaptivePortal* portal = static_cast<CaptivePortal*>(req->user_ctx);
            // Falha do scan (radio ocupado por outro scan/reconexao, erro do
            // driver) vira 500: a pagina mostra "Erro ao buscar redes" e o
            // usuario tenta de novo. Antes o erro saia como lista vazia e a
            // pagina dizia "Nenhuma rede encontrada" — mentira que faz o
            // usuario desistir de configurar com o AP no ar.
            if (portal->scanNetworks() < 0) {
                return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Scan failed");
            }
            std::string json = portal->generateScanJson();
            sendStr(req, "application/json", json.c_str(), json.length());
            return ESP_OK;
        },
        .user_ctx = self
    };
    httpd_register_uri_handler(server, &scan_uri);

    // Connect handler
    httpd_uri_t connect_uri = {
        .uri = "/connect",
        .method = HTTP_POST,
        .handler = [](httpd_req_t* req) -> esp_err_t {
            CaptivePortal* portal = static_cast<CaptivePortal*>(req->user_ctx);
            
            // Read POST data — o corpo pode chegar em varios pedacos: um recv
            // unico truncava corpos > 255 B em silencio (senha pela metade =
            // falha de autenticacao sem pista). 512 B: ssid de 32 + senha de
            // 64 urlencoded no pior caso (%XX em cada byte) passa de 256 B e
            // o teto antigo recusava senha legitima com 413.
            char buf[512];
            if (req->content_len >= sizeof(buf)) {
                // Drena ate um orcamento curto para nao deixar bytes no meio da
                // conexao keep-alive do httpd. content_len e do CLIENTE: drenar
                // o corpo inteiro prendia a task do httpd (unica, atende todos
                // os handlers) por um POST arbitrariamente grande — o portal
                // parava de responder /status e /scan ate o corpo acabar.
                constexpr size_t kDrainMax = 4096;
                char sink[128];
                size_t drained = 0;
                while (drained < req->content_len && drained < kDrainMax) {
                    size_t want = req->content_len - drained;
                    if (want > sizeof(sink)) want = sizeof(sink);
                    if (want > kDrainMax - drained) want = kDrainMax - drained;
                    int n = httpd_req_recv(req, sink, want);
                    if (n <= 0) break;  // cliente sumiu / timeout do httpd
                    drained += (size_t)n;
                }
                httpd_resp_send_err(req, HTTPD_413_CONTENT_TOO_LARGE, "Payload too large");
                // Sobrou corpo: ESP_FAIL fecha a sessao (o resto e descartado);
                // ESP_OK aqui envenenaria a proxima requisicao keep-alive.
                if (drained < req->content_len) {
                    return ESP_FAIL;
                }
                return ESP_OK;
            }
            size_t received = 0;
            while (received < req->content_len) {
                int ret = httpd_req_recv(req, buf + received, sizeof(buf) - 1 - received);
                if (ret <= 0) {
                    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "No data");
                    return ESP_FAIL;
                }
                received += (size_t)ret;
            }
            buf[received] = '\0';

            // Parse ssid and password
            std::string data(buf);
            std::string ssid, password;
            
            size_t ssid_pos = data.find("ssid=");
            size_t pass_pos = data.find("password=");
            
            if (ssid_pos != std::string::npos) {
                size_t end = data.find('&', ssid_pos);
                ssid = urlDecode(data.substr(ssid_pos + 5, 
                    end != std::string::npos ? end - ssid_pos - 5 : std::string::npos));
            }
            
            if (pass_pos != std::string::npos) {
                size_t end = data.find('&', pass_pos);
                password = urlDecode(data.substr(pass_pos + 9,
                    end != std::string::npos ? end - pass_pos - 9 : std::string::npos));
            }

            ESP_LOGI(TAG, "Connection request for: %s", ssid.c_str());

            // Trigger event
            WiFiCredentials creds;
            creds.ssid = ssid;
            creds.password = password;
            // /status le _connState/_connIp sob _connMutex: publica pelo
            // mesmo caminho do hospedeiro (reportConnectionState) em vez de
            // escrever a flag fora da guarda
            portal->reportConnectionState(PortalConnState::Connecting);
            portal->onCredentialsReceived.trigger(creds);

            // Simple response - actual connection should be handled by event subscriber
            std::string response = "{\"success\":true,\"message\":\"Credenciais recebidas\",\"ip\":\"Verificar na rede\"}";
            sendStr(req, "application/json", response.c_str(), response.length());

            return ESP_OK;
        },
        .user_ctx = self
    };
    httpd_register_uri_handler(server, &connect_uri);

    // Status handler — a pagina faz poll pos-/connect para ver o resultado
    // da conexao (quem conecta e o hospedeiro, via onCredentialsReceived)
    httpd_uri_t status_uri = {
        .uri = "/status",
        .method = HTTP_GET,
        .handler = [](httpd_req_t* req) -> esp_err_t {
            CaptivePortal* portal = static_cast<CaptivePortal*>(req->user_ctx);
            // Snapshot do estado/IP sob a guarda: _connIp e atribuido pela
            // task do hospedeiro (reportConnectionState) — ler .c_str()
            // direto corria contra o free/alloc do assign.
            PortalConnState st = PortalConnState::Idle;
            char ip[48] = "";
            if (portal->_connMutex != nullptr) {
                xSemaphoreTake(portal->_connMutex, portMAX_DELAY);
            }
            st = portal->_connState;
            strncpy(ip, portal->_connIp.c_str(), sizeof(ip) - 1);
            ip[sizeof(ip) - 1] = '\0';
            if (portal->_connMutex != nullptr) {
                xSemaphoreGive(portal->_connMutex);
            }
            const char* s = "idle";
            switch (st) {
                case PortalConnState::Connecting: s = "connecting"; break;
                case PortalConnState::Connected:  s = "connected"; break;
                case PortalConnState::Failed:     s = "failed"; break;
                default: break;
            }
            // title/device: a pagina e estatica e le os dois daqui no load
            std::string json = "{\"state\":\"";
            json += s;
            json += "\",\"ip\":\"";
            json += ip;
            json += "\",\"title\":\"";
            appendJsonEscaped(json, portal->_config.title);
            json += "\",\"device\":\"";
            appendJsonEscaped(json, portal->_config.deviceName);
            json += "\"}";
            sendStr(req, "application/json", json.c_str(), json.length());
            return ESP_OK;
        },
        .user_ctx = self
    };
    httpd_register_uri_handler(server, &status_uri);

    // Captive portal detection handlers
    const char* captive_uris[] = {
        "/generate_204",           // Android
        "/gen_204",                // Android
        "/hotspot-detect.html",    // Apple
        "/library/test/success.html", // Apple
        "/ncsi.txt",               // Windows
        "/connecttest.txt",        // Windows
        "/fwlink"                  // Microsoft
    };

    for (const char* uri : captive_uris) {
        httpd_uri_t captive_uri = {
            .uri = uri,
            .method = HTTP_GET,
            .handler = [](httpd_req_t* req) -> esp_err_t {
                // Redirect to root
                httpd_resp_set_status(req, "302 Found");
                httpd_resp_set_hdr(req, "Location", "/");
                httpd_resp_send(req, nullptr, 0);
                return ESP_OK;
            },
            .user_ctx = nullptr
        };
        esp_err_t reg = httpd_register_uri_handler(server, &captive_uri);
        if (reg != ESP_OK) {
            ESP_LOGE(TAG, "Failed to register captive URI %s", uri);
        }
    }

    ESP_LOGI(TAG, "HTTP server started");
    return true;
}

void CaptivePortal::stopHttpServer() {
    if (_httpServer != nullptr) {
        httpd_stop(static_cast<httpd_handle_t>(_httpServer));
        _httpServer = nullptr;
        ESP_LOGI(TAG, "HTTP server stopped");
    }
}

std::string CaptivePortal::generateScanJson() {
    std::string json = "{\"networks\":[";

    bool first = true;
    for (const auto& network : _scannedNetworks) {
        if (!first) json += ",";
        first = false;

        // SSID cru: so os metacaracteres do JSON sao escapados (" \ e
        // controles). O filtro antigo (32..126) descartava todo byte >= 127
        // — "Rede Cafe" com acento chegava como "Rede Caf" e o
        // toque-para-conectar enviava o SSID mutilado. UTF-8 valido passa
        // inteiro (JSON aceita); a pagina insere via textContent.
        json += "{\"ssid\":\"";
        appendJsonEscaped(json, network.first);
        char entry[24];
        snprintf(entry, sizeof(entry), "\",\"rssi\":%d}", network.second);
        json += entry;
    }

    json += "]}";
    return json;
}

void CaptivePortal::setState(CaptivePortalState newState) {
    if (_state != newState) {
        ESP_LOGD(TAG, "State: %d -> %d", static_cast<int>(_state), static_cast<int>(newState));
        _state = newState;
    }
}

std::string CaptivePortal::urlDecode(const std::string& str) {
    std::string result;
    result.reserve(str.length());
    
    for (size_t i = 0; i < str.length(); i++) {
        if (str[i] == '%' && i + 2 < str.length()) {
            // dois digitos hex EXIGIDOS: o sscanf "%x" aceitava "%4g" como
            // 0x04 e engolia o 'g' (e alocava um substr por byte escapado)
            auto hexv = [](char c) -> int {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                return -1;
            };
            const int hi = hexv(str[i + 1]), lo = hexv(str[i + 2]);
            if (hi >= 0 && lo >= 0) {
                result += static_cast<char>((hi << 4) | lo);
                i += 2;
            } else {
                result += str[i];
            }
        } else if (str[i] == '+') {
            result += ' ';
        } else {
            result += str[i];
        }
    }
    
    return result;
}
