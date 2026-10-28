#include "WebAuth.h"
#include <cstring>
#include <cstdio>

#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "nvs.h"
#include "mbedtls/base64.h"
#include "esp_rom_md5.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char* WA_TAG = "celer.webauth";

static const char* NVS_NS = "celer";
static const char* KEY_PASS = "webauth_pass";

// Alfabeto sem caracteres ambiguos (0/O, 1/l/I) para leitura facil na tela
static const char ALPHABET[] = "abcdefghjkmnpqrstuvwxyz23456789";
constexpr int PASS_LEN = 8;

// s_pass e tocada pela task httpd (check) e pela main task (setPassword via
// binding JS) — mutex simples; s_shown segura a copia devolvida por
// password() (callers copiam imediatamente: duk_push_string/snprintf).
static std::string s_pass;
static SemaphoreHandle_t s_lock = nullptr;
static char s_shown[32] = "";
static bool s_loaded = false;
static uint8_t s_fails = 0;
static int64_t s_lockUntilUs = 0;

static void lock() {
    if (s_lock != nullptr) xSemaphoreTake(s_lock, portMAX_DELAY);
}
static void unlock() {
    if (s_lock != nullptr) xSemaphoreGive(s_lock);
}

void WebAuth::init() {
    if (s_lock == nullptr) s_lock = xSemaphoreCreateMutex();
    lock();
    if (s_loaded) {
        unlock();
        return;
    }
    s_loaded = true;

    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) == ESP_OK) {
        char buf[40];
        size_t len = sizeof(buf);
        if (nvs_get_str(h, KEY_PASS, buf, &len) == ESP_OK && len > 1) {
            s_pass.assign(buf, len - 1);  // len inclui o '\0'
        }
        nvs_close(h);
    }
    bool empty = s_pass.empty();
    unlock();

    if (empty) regenerate();
}

void WebAuth::regenerate() {
    char p[PASS_LEN + 1];
    for (int i = 0; i < PASS_LEN; i++) {
        p[i] = ALPHABET[esp_random() % (sizeof(ALPHABET) - 1)];
    }
    p[PASS_LEN] = '\0';
    if (!setPassword(p)) {
        lock();
        s_pass = p;  // NVS indisponivel: senha nova vale ate o reboot
        unlock();
        ESP_LOGE(WA_TAG, "NVS rejeitou a senha nova (vale ate reiniciar)");
    }
}

bool WebAuth::setPassword(const char* p) {
    if (p == nullptr) return false;
    size_t len = strlen(p);
    if (len < 6 || len > 31) return false;

    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return false;
    bool ok = nvs_set_str(h, KEY_PASS, p) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);

    if (ok) {
        lock();
        s_pass = p;
        s_fails = 0;
        s_lockUntilUs = 0;
        unlock();
    }
    return ok;
}

const char* WebAuth::password() {
    init();
    lock();
    snprintf(s_shown, sizeof(s_shown), "%s", s_pass.c_str());
    unlock();
    return s_shown;
}

// Comparacao via MD5 (tamanho fixo): nao vaza timing nem comprimento da senha
static bool passMatches(const char* attempt, size_t alen, const std::string& real) {
    md5_context_t c;
    uint8_t ha[16], hb[16];
    esp_rom_md5_init(&c);
    esp_rom_md5_update(&c, attempt, (uint32_t)alen);
    esp_rom_md5_final(ha, &c);
    esp_rom_md5_init(&c);
    esp_rom_md5_update(&c, real.data(), (uint32_t)real.size());
    esp_rom_md5_final(hb, &c);
    return memcmp(ha, hb, 16) == 0;
}

static void sendDenied(httpd_req_t* req, bool locked) {
    if (locked) {
        httpd_resp_set_status(req, "429 Too Many Requests");
        httpd_resp_set_type(req, HTTPD_TYPE_TEXT);
        httpd_resp_sendstr(req, "Too many failed attempts. Try again in 30s.");
        return;
    }
    httpd_resp_set_status(req, "401 Unauthorized");
    httpd_resp_set_type(req, HTTPD_TYPE_TEXT);
    httpd_resp_set_hdr(req, "WWW-Authenticate",
                       "Basic realm=\"CelerOS\", charset=\"UTF-8\"");
    httpd_resp_sendstr(req, "Unauthorized: password required (user 'admin')");
}

bool WebAuth::check(httpd_req_t* req) {
    init();

    lock();
    bool empty = s_pass.empty();
    bool lockedOut = esp_timer_get_time() < s_lockUntilUs;
    unlock();
    if (empty) {
        // Janela do init (s_pass ainda vazio) ou NVS sem senha: NEGAR em vez
        // de fail-open. Antes, uma requisicao nessa janela passava sem auth;
        // o dono recebe 503 e tenta de novo em instantes (init gera a senha).
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_set_type(req, HTTPD_TYPE_TEXT);
        httpd_resp_sendstr(req, "Auth not ready");
        return false;
    }
    if (lockedOut) {
        sendDenied(req, true);
        return false;
    }

    char auth[128];
    bool ok = false;
    bool attempted = false;  // veio mesmo um "Basic ..." na requisicao?
    if (httpd_req_get_hdr_value_str(req, "Authorization", auth, sizeof(auth)) == ESP_OK &&
        strncmp(auth, "Basic ", 6) == 0) {
        attempted = true;
        uint8_t dec[80];
        size_t dlen = sizeof(dec);
        if (mbedtls_base64_decode(dec, dlen, &dlen, (const uint8_t*)auth + 6,
                                  strlen(auth) - 6) == 0) {
            uint8_t* colon = (uint8_t*)memchr(dec, ':', dlen);
            if (colon != nullptr) {
                lock();
                ok = passMatches((const char*)colon + 1,
                                 dlen - (size_t)(colon + 1 - dec), s_pass);
                unlock();
            }
        }
    }

    if (ok) {
        lock();
        s_fails = 0;
        unlock();
        return true;
    }

    // So a senha ERRADA consome o lockout: sondas sem credencial (scanner de
    // porta, <img> de outro site, a primeira visita anonima) respondiam 401 e
    // AINDA somavam falha — 5 requisicoes anonimas travavam o dono por 30 s.
    if (!attempted) {
        sendDenied(req, false);
        return false;
    }
    lock();
    bool tripLock = (++s_fails >= 5);
    if (tripLock) {
        s_fails = 0;
        s_lockUntilUs = esp_timer_get_time() + 30LL * 1000000LL;
    }
    unlock();
    if (tripLock) {
        ESP_LOGW(WA_TAG, "5 senhas erradas — acesso web travado por 30s");
    }
    sendDenied(req, false);
    return false;
}
