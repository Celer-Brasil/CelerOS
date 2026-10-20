#include "HttpClient.h"

#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_crt_bundle.h"

#include <cstring>

HttpClient::HttpClient() :
    _headerCount(0),
    _responseBody(nullptr),
    _contentLength(-1) {
}

HttpClient::HttpClient(const HttpConfig& config) :
    _config(config),
    _headerCount(0),
    _responseBody(nullptr),
    _contentLength(-1) {
}

HttpClient::~HttpClient() {
    if (_handle != nullptr) {  // handle persistente (setKeepHandle)
        esp_http_client_cleanup(_handle);
        _handle = nullptr;
    }
}

// ========== Configuration ==========

HttpClient& HttpClient::setTimeout(uint32_t timeoutMs) {
    _config.timeoutMs = timeoutMs;
    return *this;
}

HttpClient& HttpClient::setBufferSize(uint32_t bytes) {
    if (bytes >= 512 && bytes <= 64 * 1024) {
        _config.bufferSize = bytes;
    }
    return *this;
}

HttpClient& HttpClient::setBufferSizeTx(uint32_t bytes) {
    if (bytes >= 512 && bytes <= 64 * 1024) {
        _config.bufferSizeTx = bytes;
    }
    return *this;
}

HttpClient& HttpClient::setHeader(const std::string& name, const std::string& value) {
    for (size_t i = 0; i < _headerCount; i++) {
        if (_headers[i].name == name) {
            _headers[i].value = value;  // mesmo nome: sobrescreve
            return *this;
        }
    }
    if (_headerCount < kMaxHeaders) {
        _headers[_headerCount].name = name;
        _headers[_headerCount].value = value;
        _headerCount++;
    } else {
        ESP_LOGW(TAG, "Header table full (%u): '%s' ignored",
                 (unsigned)kMaxHeaders, name.c_str());
    }
    return *this;
}

HttpClient& HttpClient::removeHeader(const std::string& name) {
    for (size_t i = 0; i < _headerCount; i++) {
        if (_headers[i].name == name) {
            // desloca os seguintes uma casa para tras
            for (size_t j = i + 1; j < _headerCount; j++) {
                _headers[j - 1] = std::move(_headers[j]);
            }
            _headerCount--;
            _headers[_headerCount].name.clear();
            _headers[_headerCount].value.clear();
            break;
        }
    }
    return *this;
}

HttpClient& HttpClient::clearHeaders() {
    for (size_t i = 0; i < _headerCount; i++) {
        _headers[i].name.clear();
        _headers[i].value.clear();
    }
    _headerCount = 0;
    return *this;
}

HttpClient& HttpClient::setCertPEM(const std::string& certPem) {
    _certPem = certPem;
    return *this;
}

HttpClient& HttpClient::setCertPEM(const uint8_t* certStart, const uint8_t* certEnd) {
    if (certStart != nullptr && certEnd != nullptr && certEnd > certStart) {
        _certPem = std::string(reinterpret_cast<const char*>(certStart), 
                               certEnd - certStart);
    }
    return *this;
}

HttpClient& HttpClient::setBasicAuth(const std::string& username, const std::string& password) {
    _username = username;
    _password = password;
    return *this;
}

HttpClient& HttpClient::setBearerAuth(const std::string& token) {
    return setHeader("Authorization", "Bearer " + token);
}

HttpClient& HttpClient::setProgressCallback(ProgressCallback callback) {
    _progressCallback = callback;
    return *this;
}

HttpClient& HttpClient::setBodySink(BodySink sink) {
    _bodySink = std::move(sink);
    return *this;
}

HttpClient& HttpClient::setOnStatus(std::function<void(int, int64_t)> cb) {
    _onStatus = std::move(cb);
    return *this;
}

HttpClient& HttpClient::setKeepHandle(bool on) {
    if (!on && _handle != nullptr) {
        esp_http_client_cleanup(_handle);
        _handle = nullptr;
    }
    _keepHandle = on;
    return *this;
}

// ========== HTTP Methods ==========

HttpResponse HttpClient::get(const std::string& url) {
    return request(HttpMethod::GET, url, "");
}

HttpResponse HttpClient::post(const std::string& url,
                               const std::string& body,
                               const std::string& contentType) {
    setHeader("Content-Type", contentType);
    return request(HttpMethod::POST, url, body);
}

HttpResponse HttpClient::postJson(const std::string& url, const std::string& json) {
    return post(url, json, "application/json");
}

HttpResponse HttpClient::put(const std::string& url,
                              const std::string& body,
                              const std::string& contentType) {
    setHeader("Content-Type", contentType);
    return request(HttpMethod::PUT, url, body);
}

HttpResponse HttpClient::del(const std::string& url) {
    return request(HttpMethod::DELETE_, url, "");
}

HttpResponse HttpClient::head(const std::string& url) {
    return request(HttpMethod::HEAD, url, "");
}

HttpResponse HttpClient::patch(const std::string& url,
                                const std::string& body,
                                const std::string& contentType) {
    setHeader("Content-Type", contentType);
    return request(HttpMethod::PATCH, url, body);
}

HttpResponse HttpClient::request(HttpMethod method, 
                                  const std::string& url,
                                  const std::string& body) {
    return performRequest(method, url, body);
}

// ========== Internal ==========

// Config base do esp_http_client compartilhada por performRequest e
// downloadToFile: url/event_handler/user_data + timeout/buffers/redirects/
// keep-alive + TLS (cert_pem ou bundle para https) + basic auth. So o
// event_handler muda entre os dois fluxos.
esp_http_client_config_t HttpClient::baseConfig(const std::string& url,
                                                http_event_handle_cb handler) {
    esp_http_client_config_t config = {};
    config.url = url.c_str();
    config.event_handler = handler;
    config.user_data = this;
    config.timeout_ms = static_cast<int>(_config.timeoutMs);
    config.buffer_size = static_cast<int>(_config.bufferSize);
    config.buffer_size_tx = static_cast<int>(_config.bufferSizeTx);
    config.disable_auto_redirect = !_config.followRedirects;
    config.max_redirection_count = _config.maxRedirects;
    config.keep_alive_enable = _config.keepAlive;

    // TLS configuration
    if (!_certPem.empty()) {
        config.cert_pem = _certPem.c_str();
        config.cert_len = _certPem.length() + 1;
    } else if (url.find("https://") == 0) {
        // Use bundle for HTTPS if no specific cert provided
        config.crt_bundle_attach = esp_crt_bundle_attach;
    }

    // Basic auth
    if (!_username.empty()) {
        config.username = _username.c_str();
        config.password = _password.c_str();
        config.auth_type = HTTP_AUTH_TYPE_BASIC;
    }

    return config;
}

void HttpClient::applyContentLength(HttpClient* self, const char* key, const char* value) {
    if (self != nullptr && strcasecmp(key, "Content-Length") == 0) {
        self->_contentLength = strtoll(value, nullptr, 10);
    }
}

bool HttpClient::interimResponse(esp_http_client_handle_t client) const {
    // O esp_http_client_perform le o corpo da resposta 3xx/401 inteiro (e o
    // entrega em ON_DATA) ANTES de refazer a requisicao: sem este filtro o
    // "Moved"/"Unauthorized" do servidor ia parar na frente do corpo real
    // (Net.get) ou do arquivo baixado (Net.download/instalacao de app).
    const int st = esp_http_client_get_status_code(client);
    if (_config.followRedirects &&
        (st == 301 || st == 302 || st == 303 || st == 307 || st == 308)) {
        return true;
    }
    return st == 401 && !_username.empty();
}

int HttpClient::eventHandler(esp_http_client_event_t* event) {
    HttpClient* self = static_cast<HttpClient*>(event->user_data);

    switch (event->event_id) {
        case HTTP_EVENT_ERROR:
            ESP_LOGD(TAG, "HTTP_EVENT_ERROR");
            break;

        case HTTP_EVENT_ON_CONNECTED:
            ESP_LOGD(TAG, "HTTP_EVENT_ON_CONNECTED");
            if (self != nullptr && self->_connectMs == 0) {
                self->_connectMs = (uint32_t)((esp_timer_get_time() - self->_t0) / 1000);
            }
            break;

        case HTTP_EVENT_HEADER_SENT:
            ESP_LOGD(TAG, "HTTP_EVENT_HEADER_SENT");
            break;

        case HTTP_EVENT_ON_HEADER:
            ESP_LOGD(TAG, "Header: %s = %s", event->header_key, event->header_value);
            if (self != nullptr && self->_firstByteMs == 0) {
                self->_firstByteMs = (uint32_t)((esp_timer_get_time() - self->_t0) / 1000);
            }
            // tamanho conhecido: o corpo cresce uma vez so (sem dobrar)
            applyContentLength(self, event->header_key, event->header_value);
            break;

        case HTTP_EVENT_ON_DATA:
            ESP_LOGD(TAG, "HTTP_EVENT_ON_DATA, len=%d", event->data_len);
            if (self != nullptr && self->interimResponse(event->client)) break;
            if (self != nullptr && self->_onStatus && !self->_statusSeen) {
                // status da resposta FINAL, 1x, antes do 1o byte do corpo: o
                // sink decide o que fazer (AI.speak so toca PCM de 2xx)
                self->_statusSeen = true;
                self->_onStatus(esp_http_client_get_status_code(event->client), self->_contentLength);
            }
            if (self != nullptr && self->_bodySink && event->data_len > 0 && !self->_bodyOom) {
                if (!self->_bodySink(static_cast<const char*>(event->data), (size_t)event->data_len)) {
                    self->_bodyOom = true;
                }
                self->_sinkBytes += (size_t)event->data_len;
                break;
            }
            if (self != nullptr && self->_responseBody != nullptr && event->data_len > 0 && !self->_bodyOom) {
                // Crescimento SEM abort: sem excecoes, o realloc do
                // std::string que falha chama abort() (medido: corpo de 8KB
                // num heap fragmentado da CYD derrubava o aparelho). Cresce
                // para o Content-Length (ou dobra) so se o bloco existir;
                // senao a requisicao vira erro limpo.
                std::string* b = self->_responseBody;
                const size_t need = b->size() + (size_t)event->data_len;
                if (need > b->capacity()) {
                    size_t want = b->capacity() * 2 > need ? b->capacity() * 2 : need;
                    if (want < 1024) want = 1024;
                    if (self->_contentLength > 0 && (size_t)self->_contentLength >= need) {
                        want = (size_t)self->_contentLength;
                    }
                    // sonda real: o TLSF pode recusar um bloco pouco maior que
                    // o pedido mesmo com o "maior bloco livre" acima dele
                    auto fits = [](size_t n) {
                        void* p = malloc(n + 1);
                        free(p);
                        return p != nullptr;
                    };
                    if (!fits(want)) want = need;
                    if (!fits(want)) {
                        self->_bodyOom = true;
                        ESP_LOGW(TAG, "corpo nao cabe: %u B", (unsigned)need);
                        break;
                    }
                    b->reserve(want);
                }
                // Append data to response body
                self->_responseBody->append(
                    static_cast<const char*>(event->data), 
                    event->data_len
                );

                // Call progress callback if set
                if (self->_progressCallback) {
                    self->_progressCallback(
                        static_cast<int64_t>(self->_responseBody->size()),
                        self->_contentLength
                    );
                }
            }
            break;

        case HTTP_EVENT_ON_FINISH:
            ESP_LOGD(TAG, "HTTP_EVENT_ON_FINISH");
            break;

        case HTTP_EVENT_DISCONNECTED:
            ESP_LOGD(TAG, "HTTP_EVENT_DISCONNECTED");
            break;

        case HTTP_EVENT_REDIRECT:
            ESP_LOGD(TAG, "HTTP_EVENT_REDIRECT");
            break;

        default:
            break;
    }

    return ESP_OK;
}

int HttpClient::toEspMethod(HttpMethod method) {
    switch (method) {
        case HttpMethod::GET:
            return HTTP_METHOD_GET;
        case HttpMethod::POST:
            return HTTP_METHOD_POST;
        case HttpMethod::PUT:
            return HTTP_METHOD_PUT;
        case HttpMethod::DELETE_:
            return HTTP_METHOD_DELETE;
        case HttpMethod::HEAD:
            return HTTP_METHOD_HEAD;
        case HttpMethod::PATCH:
            return HTTP_METHOD_PATCH;
        default:
            return HTTP_METHOD_GET;
    }
}

HttpResponse HttpClient::performRequest(HttpMethod method,
                                          const std::string& url,
                                          const std::string& body) {
    HttpResponse response;
    std::string responseBody;
    _responseBody = &responseBody;
    _contentLength = -1;
    _bodyOom = false;
    _sinkBytes = 0;
    _connectMs = 0;
    _firstByteMs = 0;
    _statusSeen = false;

    uint64_t startTime = esp_timer_get_time();
    _t0 = (int64_t)startTime;

    // Configure HTTP client
    esp_http_client_config_t config = baseConfig(url, eventHandler);

    // Handle persistente (setKeepHandle): pedidos em serie no mesmo host
    // pulam DNS+TCP+TLS (segundos de handshake neste chip). Host diferente
    // reconecta sozinho dentro do perform.
    const bool reuse = (_keepHandle && _handle != nullptr);
    esp_http_client_handle_t client = reuse ? _handle : esp_http_client_init(&config);
    if (client == nullptr) {
        response.success = false;
        response.errorMessage = "Failed to create HTTP client";
        ESP_LOGE(TAG, "%s", response.errorMessage.c_str());
        _responseBody = nullptr;
        return response;
    }
    if (_keepHandle) _handle = client;

    // Arma metodo/headers/corpo no handle (o mesmo roteiro no pedido fresco
    // do retry — os headers do pedido ANTERIOR persistem no handle reusado,
    // os de mesmo nome sao substituidos aqui)
    auto armRequest = [&]() {
        esp_http_client_set_url(client, url.c_str());
        esp_http_client_set_method(client, static_cast<esp_http_client_method_t>(toEspMethod(method)));
        for (size_t i = 0; i < _headerCount; i++) {
            esp_http_client_set_header(client, _headers[i].name.c_str(),
                                       _headers[i].value.c_str());
        }
        if (!body.empty() && (method == HttpMethod::POST ||
                              method == HttpMethod::PUT ||
                              method == HttpMethod::PATCH)) {
            esp_http_client_set_post_field(client, body.c_str(), static_cast<int>(body.length()));
        } else if (reuse) {
            // handle reusado: o post_field do pedido ANTERIOR (ponteiro para
            // um corpo ja destruido) iria junto de um GET/HEAD
            esp_http_client_set_post_field(client, nullptr, 0);
        }
    };
    armRequest();

    // Perform request
    esp_err_t err = esp_http_client_perform(client);
    if (err != ESP_OK && reuse) {
        // Retry SO se nada do corpo chegou. Antes o handle era refeito em
        // qualquer erro e o corpo parcial permanecia em responseBody/sink:
        // a segunda resposta era concatenada (JSON invalido, audio
        // duplicado) sem erro visivel. _statusSeen tambem impede o retry
        // quando o sink ja reagiu ao status da primeira resposta.
        const size_t got = responseBody.size() + _sinkBytes;
        if (got == 0 && !_statusSeen) {
            // conexao idle caiu (servidor fechou entre pedidos): descarta o
            // handle e REFAZ limpo
            ESP_LOGW(TAG, "conexao keep-alive parada (0x%x): reconectando", err);
            esp_http_client_cleanup(client);
            client = esp_http_client_init(&config);
            _handle = client;
            if (client != nullptr) {
                // estado do corpo/headers da tentativa morta nao vaza
                responseBody.clear();
                _contentLength = -1;
                _bodyOom = false;
                _sinkBytes = 0;
                _statusSeen = false;
                armRequest();
                err = esp_http_client_perform(client);
            }
        } else {
            ESP_LOGW(TAG, "conexao caiu com %u B de corpo: sem retry",
                     (unsigned)got);
        }
    }
    if (client == nullptr) {  // init do retry falhou: nao ha o que ler
        response.success = false;
        response.errorMessage = "Failed to create HTTP client";
        _responseBody = nullptr;
        return response;
    }

    // Get results
    response.statusCode = esp_http_client_get_status_code(client);
    response.contentLength = esp_http_client_get_content_length(client);
    if (err == ESP_OK && _bodyOom) err = ESP_ERR_NO_MEM;
    response.body = std::move(responseBody);
    response.durationMs = static_cast<uint32_t>((esp_timer_get_time() - startTime) / 1000);
    response.connectMs = _connectMs;
    response.firstByteMs = _firstByteMs;

    if (err == ESP_OK) {
        response.success = true;
        ESP_LOGI(TAG, "Request to %s completed: %d (%d bytes in %lu ms)",
                 url.c_str(), response.statusCode,
                 static_cast<int>(response.body.length() + _sinkBytes),
                 (unsigned long)response.durationMs);
    } else {
        response.success = false;
        // Codigo numerico SEMPRE: com CONFIG_ESP_ERR_TO_NAME_LOOKUP desligado
        // (economia de flash) esp_err_to_name so diz "UNKNOWN ERROR" e o hex
        // e a unica pista do erro real (bancada 2026-10-02)
        char msg[64];
        snprintf(msg, sizeof(msg), "%s (0x%x)", esp_err_to_name(err), err);
        response.errorMessage = msg;
        ESP_LOGE(TAG, "Request to %s failed: %s", url.c_str(), response.errorMessage.c_str());
    }

    // Cleanup
    if (!_keepHandle) esp_http_client_cleanup(client);
    _responseBody = nullptr;

    return response;
}

int HttpClient::dlFileEventHandler(esp_http_client_event_t* evt) {
    HttpClient* self = static_cast<HttpClient*>(evt->user_data);
    if (self == nullptr) return 0;

    switch (evt->event_id) {
        case HTTP_EVENT_ON_HEADER:
            // total para o progresso (antes ficava sempre -1); um redirect
            // reescreve com o Content-Length da resposta final
            applyContentLength(self, evt->header_key, evt->header_value);
            break;
        case HTTP_EVENT_ON_DATA: {
            if (self->interimResponse(evt->client)) break;  // corpo do 3xx/401
            FILE* f = static_cast<FILE*>(self->_dlFile);
            if (f != nullptr && evt->data != nullptr && evt->data_len > 0 && !self->_dlWriteErr) {
                size_t written = fwrite(evt->data, 1, evt->data_len, f);
                // disco cheio: o fwrite curto antes passava em silencio e o
                // arquivo truncado era renomeado por cima do destino
                if (written != (size_t)evt->data_len) self->_dlWriteErr = true;
                self->_dlReceived += (int64_t)written;
                if (self->_progressCallback) {
                    self->_progressCallback(self->_dlReceived, self->_contentLength);
                }
            }
            break;
        }
        default:
            break;
    }
    return 0;
}

HttpResponse HttpClient::downloadToFile(const std::string& url, const std::string& filePath) {
    HttpResponse response;
    _responseBody = nullptr;
    _contentLength = -1;
    _dlReceived = 0;
    _dlWriteErr = false;

    uint64_t startTime = esp_timer_get_time();

    FILE* f = fopen(filePath.c_str(), "wb");
    if (f == nullptr) {
        response.errorMessage = "Cannot open " + filePath + " for writing";
        return response;
    }
    _dlFile = f;

    esp_http_client_config_t config = baseConfig(url, dlFileEventHandler);

    esp_http_client_handle_t client = esp_http_client_init(&config);
    esp_err_t err = (client != nullptr) ? esp_http_client_perform(client) : ESP_FAIL;

    if (client != nullptr) {
        response.statusCode = esp_http_client_get_status_code(client);
        response.contentLength = esp_http_client_get_content_length(client);
        esp_http_client_cleanup(client);
    }

    // fclose faz o flush final: o erro de disco cheio tambem aparece aqui
    if (fclose(f) != 0) _dlWriteErr = true;
    _dlFile = nullptr;
    if (err == ESP_OK && _dlWriteErr) err = ESP_ERR_NO_MEM;

    response.success = (err == ESP_OK && response.statusCode >= 200 && response.statusCode < 300);
    response.durationMs = (uint32_t)((esp_timer_get_time() - startTime) / 1000);

    if (!response.success) {
        if (_dlWriteErr) {
            response.errorMessage = "write failed (disk full?)";
        } else if (err != ESP_OK) {
            response.errorMessage = esp_err_to_name(err);
        } else {
            response.errorMessage = "HTTP status " + std::to_string(response.statusCode);
        }
        remove(filePath.c_str());  // nao deixa arquivo parcial
        return response;
    }

    return response;
}
