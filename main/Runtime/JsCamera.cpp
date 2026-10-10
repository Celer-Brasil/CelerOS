// Camera.* (API 35): sensor OV2640 da esp32-cam (AI-Thinker) para apps JS.
//
// Duas fachadas sobre o mesmo driver esp32-camera:
//   - fotos:   Camera.setup({pixformat:'jpeg'}) + capture()/save() — o frame
//              e copiado para um slot retido (PSRAM) e o buffer do driver
//              volta imediatamente para a fila;
//   - QR:      Camera.scanQR() — pipeline grayscale (1 byte/pixel direto no
//              quirc, sem decode JPEG), com recurso por tentativa e LED de
//              flash opcional.
//
// A alternancia foto/QR e um esp_camera_deinit()+init() (o sensor nao troca
// de pixel format em voo): cada fachada garante o proprio modo e a troca so
// paga as dezenas de ms quando o app mistura as duas coisas.
//
// Disciplina da casa: present() antes das esperas longas (jsBlocking) e
// CelerKernel::noteAppYield() por tentativa de decode/captura — o loop do
// app nunca pode estourar a janela do exec-timeout (precedente js_netDownload).

#include "JSBindings.h"
#include "JsInternal.h"
#include "JsFsJail.h"
#include "../Kernel/Core/CelerKernel.h"
#include "../USBDevice/LogSink.h"
#include "../Boards/Board.h"
#include "esp_camera.h"
#include "quirc.h"
#include "esp_heap_caps.h"
#include "esp_task_wdt.h"
#include "driver/gpio.h"
#include <cstdio>
#include <cstring>
#include <string>

#if CONFIG_CELEROS_JS_CAMERA

namespace {

// ---- estado do modulo -------------------------------------------------------
bool s_inited = false;          // esp_camera_init ok
bool s_qrMode = false;          // false = modo foto (jpeg/etc), true = gray p/ QR
framesize_t s_photoSize = FRAMESIZE_QVGA;
pixformat_t s_photoFmt = PIXFORMAT_JPEG;
int s_fbCount = 2;
int s_xclkMhz = 20;

// frames retidos para o JS (copias na PSRAM; o fb do driver e devolvido)
struct Retained {
    uint8_t* buf;
    size_t len;
    int w, h;
    pixformat_t fmt;
};
Retained s_ret[2] = {};
constexpr int kRetMax = 2;

struct quirc* s_qr = nullptr;   // alocado no 1o scanQR; imagem na PSRAM (patch)
int s_qrW = 0, s_qrH = 0;       // tamanho do buffer atual do quirc

const char* fmtName(pixformat_t f) {
    switch (f) {
        case PIXFORMAT_JPEG: return "jpeg";
        case PIXFORMAT_GRAYSCALE: return "gray";
        case PIXFORMAT_RGB565: return "rgb565";
        default: return "raw";
    }
}

// helpers de leitura de opts no objeto do indice 0 (ausente = default).
// Strings: ler do stack ANTES do pop — o ponteiro do duk_get_string nao
// sobrevive a coleta se o valor perde a referencia.
int optInt(duk_context* ctx, const char* key, int def) {
    duk_get_prop_string(ctx, 0, key);
    duk_int_t v = duk_get_int_default(ctx, -1, def);
    duk_pop(ctx);
    return (int)v;
}

void flashLed(bool on) {
    const int pin = Board::profile().camera.flashLed;
    if (pin < 0) return;
    static bool s_pinCfg = false;
    if (!s_pinCfg) {
        gpio_config_t io = {};
        io.pin_bit_mask = 1ULL << pin;
        io.mode = GPIO_MODE_OUTPUT;
        gpio_config(&io);
        s_pinCfg = true;
    }
    gpio_set_level((gpio_num_t)pin, on ? 1 : 0);
}

void freeRetained() {
    for (int i = 0; i < kRetMax; i++) {
        free(s_ret[i].buf);
        s_ret[i] = {};
    }
}

void teardown() {
    if (s_inited) {
        esp_camera_deinit();
        s_inited = false;
    }
    freeRetained();
    if (s_qr != nullptr) {
        quirc_destroy(s_qr);
        s_qr = nullptr;
        s_qrW = s_qrH = 0;
    }
    flashLed(false);
}

bool initCamera(framesize_t fs, pixformat_t fmt) {
    const CameraPins& cp = Board::profile().camera;
    camera_config_t cfg = {};
    cfg.ledc_channel = LEDC_CHANNEL_0;
    cfg.ledc_timer = LEDC_TIMER_0;
    cfg.pin_pwdn = cp.pwdn;
    cfg.pin_reset = cp.reset;
    cfg.pin_xclk = cp.xclk;
    cfg.pin_sccb_sda = cp.siod;
    cfg.pin_sccb_scl = cp.sioc;
    cfg.pin_d7 = cp.y9;
    cfg.pin_d6 = cp.y8;
    cfg.pin_d5 = cp.y7;
    cfg.pin_d4 = cp.y6;
    cfg.pin_d3 = cp.y5;
    cfg.pin_d2 = cp.y4;
    cfg.pin_d1 = cp.y3;
    cfg.pin_d0 = cp.y2;
    cfg.pin_vsync = cp.vsync;
    cfg.pin_href = cp.href;
    cfg.pin_pclk = cp.pclk;
    cfg.xclk_freq_hz = s_xclkMhz * 1000000;
    cfg.pixel_format = fmt;
    cfg.frame_size = fs;
    cfg.jpeg_quality = 10;
    cfg.fb_count = s_fbCount;
    cfg.fb_location = Board::profile().hasPsram ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
    cfg.grab_mode = CAMERA_GRAB_LATEST;
    esp_err_t err = esp_camera_init(&cfg);
    if (err != ESP_OK) {
        celer_log_printf("[cam] init falhou: %d\n", (int)err);
        return false;
    }
    s_inited = true;
    return true;
}

// garante o modo pedido (desliga/religa so quando muda de fato)
bool ensureMode(bool qr) {
    if (s_inited && s_qrMode == qr) return true;
    if (s_inited) {
        esp_camera_deinit();
        s_inited = false;
    }
    if (qr) {
        // grayscale QVGA: 1 byte/pixel entra direto no quirc; codes grandes
        // (impressos pequenos) pedem VGA via setup({framesize:'vga'}) antes
        return initCamera(FRAMESIZE_QVGA, PIXFORMAT_GRAYSCALE);
    }
    return initCamera(s_photoSize, s_photoFmt);
}

framesize_t parseFrameSize(const char* s) {
    if (!strcmp(s, "qqvga")) return FRAMESIZE_QQVGA;
    if (!strcmp(s, "qvga")) return FRAMESIZE_QVGA;
    if (!strcmp(s, "vga")) return FRAMESIZE_VGA;
    if (!strcmp(s, "svga")) return FRAMESIZE_SVGA;
    if (!strcmp(s, "hd")) return FRAMESIZE_HD;
    if (!strcmp(s, "sxga")) return FRAMESIZE_SXGA;
    if (!strcmp(s, "uxga")) return FRAMESIZE_UXGA;
    return FRAMESIZE_QVGA;
}

pixformat_t parsePixFormat(const char* s) {
    if (!strcmp(s, "gray")) return PIXFORMAT_GRAYSCALE;
    if (!strcmp(s, "rgb565")) return PIXFORMAT_RGB565;
    return PIXFORMAT_JPEG;
}

// copia o fb do driver para um slot retido; devolve o id (1..2) ou 0
int retainFrame(const uint8_t* data, size_t len, int w, int h, pixformat_t fmt) {
    int slot = -1;
    for (int i = 0; i < kRetMax; i++) {
        if (s_ret[i].buf == nullptr) { slot = i; break; }
    }
    if (slot < 0) {  // cheio: recicla o primeiro
        slot = 0;
        free(s_ret[slot].buf);
        s_ret[slot] = {};
    }
    uint8_t* copy = (uint8_t*)heap_caps_malloc(len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (copy == nullptr) {
        copy = (uint8_t*)malloc(len);
        if (copy == nullptr) return 0;
    }
    memcpy(copy, data, len);
    s_ret[slot] = {copy, len, w, h, fmt};
    return slot + 1;
}

// ---- QR: captura + decode de um frame grayscale -----------------------------
// devolve true e preenche `out` quando decodifica; false = tentar de novo
bool qrDecodeOnce(std::string& out) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (fb == nullptr) return false;
    bool ok = false;
    do {
        if (fb->format != PIXFORMAT_GRAYSCALE) break;
        if (s_qr == nullptr) s_qr = quirc_new();
        if (s_qr == nullptr) break;
        if (s_qrW != fb->width || s_qrH != fb->height) {
            if (quirc_resize(s_qr, fb->width, fb->height) < 0) break;
            s_qrW = fb->width;
            s_qrH = fb->height;
        }
        uint8_t* img = quirc_begin(s_qr, nullptr, nullptr);
        if (img == nullptr) break;
        memcpy(img, fb->buf, (size_t)fb->width * fb->height);
        quirc_end(s_qr);
        const int n = quirc_count(s_qr);
        for (int i = 0; i < n && !ok; i++) {
            struct quirc_code code;
            struct quirc_data data;
            quirc_extract(s_qr, i, &code);
            if (quirc_decode(&code, &data) != QUIRC_SUCCESS) continue;
            if (data.payload_len >= sizeof(data.payload)) continue;
            data.payload[data.payload_len] = 0;  // garante fim de string
            out.assign((const char*)data.payload, data.payload_len);
            ok = true;
        }
    } while (0);
    esp_camera_fb_return(fb);
    return ok;
}

}  // namespace

// reset por app (init/appExitCleanup): camera desligada, slots e quirc livres
void JSBindings::cameraAppReset() {
    teardown();
}

// ---- bindings ----------------------------------------------------------------

duk_ret_t JSBindings::js_cameraSetup(duk_context *ctx) {
    s_photoSize = FRAMESIZE_QVGA;
    s_photoFmt = PIXFORMAT_JPEG;
    s_fbCount = Board::profile().hasPsram ? 2 : 1;
    s_xclkMhz = 20;
    if (duk_is_object(ctx, 0)) {
        duk_get_prop_string(ctx, 0, "framesize");
        if (duk_is_string(ctx, -1)) s_photoSize = parseFrameSize(duk_get_string(ctx, -1));
        duk_pop(ctx);
        duk_get_prop_string(ctx, 0, "pixformat");
        if (duk_is_string(ctx, -1)) s_photoFmt = parsePixFormat(duk_get_string(ctx, -1));
        duk_pop(ctx);
        const int fbc = optInt(ctx, "fbcount", s_fbCount);
        if (fbc >= 1 && fbc <= 2) s_fbCount = fbc;
        const int x = optInt(ctx, "xclkMhz", s_xclkMhz);
        if (x == 10 || x == 20) s_xclkMhz = x;
    }
    // sem PSRAM o modo foto fica no QVGA (framebuffer na DRAM)
    if (!Board::profile().hasPsram && s_photoSize > FRAMESIZE_QVGA) {
        s_photoSize = FRAMESIZE_QVGA;
    }
    s_qrMode = false;
    teardown();  // reconfiguracao explicita: desliga o que havia
    duk_push_boolean(ctx, initCamera(s_photoSize, s_photoFmt) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_cameraCapture(duk_context *ctx) {
    JSBindings::present();  // captura bloqueia ate o frame: app cede antes
    if (!ensureMode(false)) {
        duk_push_null(ctx);
        return 1;
    }
    camera_fb_t* fb = esp_camera_fb_get();
    if (fb == nullptr) {
        duk_push_null(ctx);
        return 1;
    }
    const int id = retainFrame(fb->buf, fb->len, fb->width, fb->height, fb->format);
    const pixformat_t fmt = fb->format;
    const int w = fb->width, h = fb->height;
    esp_camera_fb_return(fb);
    CelerKernel::noteAppYield();
    if (id == 0) {
        duk_push_null(ctx);
        return 1;
    }
    const size_t len = s_ret[id - 1].len;
    duk_push_object(ctx);
    putInt(ctx, "id", id);
    putInt(ctx, "w", w);
    putInt(ctx, "h", h);
    putInt(ctx, "len", (int)len);
    duk_push_string(ctx, fmtName(fmt));
    duk_put_prop_string(ctx, -2, "format");
    return 1;
}

duk_ret_t JSBindings::js_cameraSave(duk_context *ctx) {
    const int id = duk_require_int(ctx, 0);
    const char* path = duk_require_string(ctx, 1);
    if (id < 1 || id > kRetMax || s_ret[id - 1].buf == nullptr) {
        duk_push_int(ctx, -1);
        return 1;
    }
    if (!fsWriteAllowed(path)) {
        char msg[160];
        snprintf(msg, sizeof(msg), "FS: escrita negada em %s", path);
        duk_error(ctx, DUK_ERR_ERROR, msg);
    }
    const Retained& r = s_ret[id - 1];
    // mesmo contrato do FS.writeFile: /local atomico via rename, SD direto
    const bool atomic = strncmp(path, "/local/", 7) == 0;
    std::string tmp = atomic ? std::string(path) + ".tmp" : std::string(path);
    FILE* f = fopen(tmp.c_str(), "wb");
    if (f == nullptr) {
        duk_push_int(ctx, -1);
        return 1;
    }
    size_t written = 0;
    while (written < r.len) {
        const size_t chunk = r.len - written > 4096 ? 4096 : r.len - written;
        if (fwrite(r.buf + written, 1, chunk, f) != chunk) break;
        written += chunk;
        esp_task_wdt_reset();         // foto VGA+ no SD: grava em fatias
        CelerKernel::noteAppYield();  // mesma regra do download por chunk
    }
    const bool ok = fclose(f) == 0 && written == r.len;
    if (atomic && (!ok || rename(tmp.c_str(), path) != 0)) {
        unlink(tmp.c_str());
        duk_push_int(ctx, -1);
        return 1;
    }
    duk_push_int(ctx, ok ? (duk_int_t)written : -1);
    return 1;
}

duk_ret_t JSBindings::js_cameraFree(duk_context *ctx) {
    const int id = duk_require_int(ctx, 0);
    if (id >= 1 && id <= kRetMax) {
        free(s_ret[id - 1].buf);
        s_ret[id - 1] = {};
    }
    return 0;
}

duk_ret_t JSBindings::js_cameraLed(duk_context *ctx) {
    flashLed(duk_require_boolean(ctx, 0) != 0);
    return 0;
}

duk_ret_t JSBindings::js_cameraScanQR(duk_context *ctx) {
    int timeoutMs = 6000;
    int attempts = 0;  // 0 = deriva do timeout (~250 ms por tentativa no QVGA)
    bool led = false;
    if (duk_is_object(ctx, 0)) {
        timeoutMs = optInt(ctx, "timeoutMs", timeoutMs);
        attempts = optInt(ctx, "attempts", 0);
        duk_get_prop_string(ctx, 0, "led");
        led = duk_get_boolean(ctx, -1) != 0;
        duk_pop(ctx);
    }
    if (timeoutMs < 250) timeoutMs = 250;
    if (attempts <= 0) attempts = timeoutMs / 250;
    if (attempts > 60) attempts = 60;

    JSBindings::present();  // decode e iterativo e bloqueante: cede antes
    if (!ensureMode(true)) {
        duk_push_null(ctx);
        return 1;
    }
    if (led) flashLed(true);

    std::string out;
    const uint32_t t0 = millis();
    bool found = false;
    for (int i = 0; i < attempts && !found; i++) {
        esp_task_wdt_reset();
        CelerKernel::noteAppYield();  // cada tentativa renova a janela
        found = qrDecodeOnce(out);
        if (!found && millis() - t0 > (uint32_t)timeoutMs) break;
    }
    if (led) flashLed(false);
    CelerKernel::noteAppYield();

    if (!found) {
        duk_push_null(ctx);
        return 1;
    }
    duk_push_lstring(ctx, out.data(), (duk_size_t)out.size());
    return 1;
}

#endif  // CONFIG_CELEROS_JS_CAMERA
