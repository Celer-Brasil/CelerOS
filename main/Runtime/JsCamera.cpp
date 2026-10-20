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
#include "img_converters.h"
#include "CameraCore.h"
#include "freertos/semphr.h"
#include "quirc.h"
#include "esp_heap_caps.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "driver/gpio.h"
#include <cstdio>
#include <cstring>
#include <string>

#if CONFIG_CELEROS_JS_CAMERA

namespace {

// ---- estado do modulo -------------------------------------------------------
bool s_inited = false;          // esp_camera_init ok

// Dono do driver: o JS (setup/capture/scanQR/troca de app) e o provedor
// "camera" dos recursos da matilha (CameraCore::snapJpeg, outra task).
// Recursivo: ensureMode/teardown rodam dentro de quem ja o tem.
SemaphoreHandle_t camLock() {
    static SemaphoreHandle_t s = xSemaphoreCreateRecursiveMutex();
    return s;
}
// Espera em fatias alimentando o TWDT: o provedor da matilha pode segurar o
// driver por segundos (um fb_get sem quadro espera ate 4 s no driver), e a
// task do app parada no mutex sem alimentar o watchdog derrubava a cam a
// cada ~50 s (TWDT no main, bancada 2026-10-11). A janela do executor JS
// tambem e renovada (a espera nao e loop do app).
struct CamGuard {
    CamGuard() {
        while (xSemaphoreTakeRecursive(camLock(), pdMS_TO_TICKS(200)) != pdTRUE) {
            if (esp_task_wdt_status(nullptr) == ESP_OK) esp_task_wdt_reset();
            CelerKernel::noteAppYield();
        }
    }
    ~CamGuard() { xSemaphoreGiveRecursive(camLock()); }
};
bool s_qrMode = false;          // false = modo foto (jpeg/etc), true = gray p/ QR
bool s_qrVga = false;           // modo QR vigente em VGA (false = QVGA)
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
struct quirc_code* s_qcode = nullptr;  // buffers do decode (PSRAM): ver decodeBuffers
struct quirc_data* s_qdata = nullptr;

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

// LED de flash com teto termico. O da AI-Thinker (GPIO4) e um LED de
// potencia sem limitacao de corrente na placa, feito para pulsos de foto:
// o scanQR({led:true}) em loop o deixava ~96% do tempo aceso e ele
// esquentava muito (bancada 2026-10-10). Regras, valendo para Camera.led e
// para o scanQR:
//   - aceso continuo no maximo kFlashMaxOnUs (esp_timer apaga a forca);
//   - acendimento longo (> kFlashFreeUs) bloqueia o proximo por
//     kFlashCoolX vezes o tempo aceso — duty <= ~20% no pior caso; pulsos
//     curtos (piscadas de veredito) passam livres.
constexpr int64_t kFlashMaxOnUs = 800000;
constexpr int64_t kFlashFreeUs = 250000;
constexpr int64_t kFlashCoolX = 4;
portMUX_TYPE s_flashMux = portMUX_INITIALIZER_UNLOCKED;
esp_timer_handle_t s_flashTimer = nullptr;
bool s_flashOn = false;
int64_t s_flashOnAt = 0;
int64_t s_flashBlockUntil = 0;

// apaga e contabiliza o resfriamento (chamado com o mux tomado)
void flashOffLocked(int pin, int64_t now) {
    gpio_set_level((gpio_num_t)pin, 0);
    if (!s_flashOn) return;
    s_flashOn = false;
    const int64_t lit = now - s_flashOnAt;
    if (lit > kFlashFreeUs) s_flashBlockUntil = now + lit * kFlashCoolX;
}

void flashTimerCb(void*) {
    const int pin = Board::profile().camera.flashLed;
    portENTER_CRITICAL(&s_flashMux);
    flashOffLocked(pin, esp_timer_get_time());
    portEXIT_CRITICAL(&s_flashMux);
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
        esp_timer_create_args_t ta = {};
        ta.callback = flashTimerCb;
        ta.name = "cam_flash";
        esp_timer_create(&ta, &s_flashTimer);
        s_pinCfg = true;
    }
    const int64_t now = esp_timer_get_time();
    bool arm = false;
    portENTER_CRITICAL(&s_flashMux);
    if (!on) {
        flashOffLocked(pin, now);
    } else if (!s_flashOn && now >= s_flashBlockUntil) {
        gpio_set_level((gpio_num_t)pin, 1);
        s_flashOn = true;
        s_flashOnAt = now;
        arm = true;
    }
    portEXIT_CRITICAL(&s_flashMux);
    if (s_flashTimer != nullptr) {
        esp_timer_stop(s_flashTimer);  // ESP_ERR_INVALID_STATE se parado: ok
        if (arm) esp_timer_start_once(s_flashTimer, kFlashMaxOnUs);
    }
}

void freeRetained() {
    for (int i = 0; i < kRetMax; i++) {
        free(s_ret[i].buf);
        s_ret[i] = {};
    }
}

// Buffers do APP (frames retidos, quirc, LED): saem na troca de app. O
// driver da camera FICA no ar — ele nao aguenta ciclos deinit+init (o 3o
// init caia em "camera not supported") e, na esp32-cam, um init depois do
// WiFi + NimBLE subia sem entregar quadro nenhum por falta de RAM interna
// (bancada 2026-10-11). So o Camera.setup explicito reconfigura.
void appRelease() {
    freeRetained();
    if (s_qr != nullptr) {
        quirc_destroy(s_qr);
        s_qr = nullptr;
        s_qrW = s_qrH = 0;
    }
    free(s_qcode);
    free(s_qdata);
    s_qcode = nullptr;
    s_qdata = nullptr;
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

// Sensor no modo QR: contraste no maximo (bordas dos modulos mais duras),
// correcao de lente (a OV2640 da AI-Thinker escurece muito os cantos e o
// limiar global do quirc via o canto escuro como "preto"), pixels mortos
// corrigidos e AEC/AGC ligados. Os 1os frames apos o init saem com a
// exposicao ainda subindo: descarta 3.
void tuneForQr() {
    sensor_t* s = esp_camera_sensor_get();
    if (s != nullptr) {
        if (s->set_contrast) s->set_contrast(s, 2);
        if (s->set_brightness) s->set_brightness(s, 0);
        if (s->set_lenc) s->set_lenc(s, 1);
        if (s->set_bpc) s->set_bpc(s, 1);
        if (s->set_wpc) s->set_wpc(s, 1);
        if (s->set_exposure_ctrl) s->set_exposure_ctrl(s, 1);
        if (s->set_aec2) s->set_aec2(s, 1);
        if (s->set_gain_ctrl) s->set_gain_ctrl(s, 1);
        if (s->set_gainceiling) s->set_gainceiling(s, GAINCEILING_16X);
    }
    for (int i = 0; i < 3; i++) {
        camera_fb_t* fb = esp_camera_fb_get();
        if (fb != nullptr) esp_camera_fb_return(fb);
    }
}

// garante o modo pedido (desliga/religa so quando muda de fato). QR em QVGA
// (rapido) ou VGA (codes pequenos/longe: dobra os pixels por modulo)
//
// O modo vigente PRECISA ser registrado: sem isso todo scanQR via "modo
// mudou" e fazia deinit+init — o driver nao aguenta o ciclo repetido (o 3o
// init ja caia em "Detected camera not supported" e dali em diante a camera
// nunca mais subia; bancada esp32-cam 2026-10-10).
bool ensureMode(bool qr, bool qrVga = false) {
    if (s_inited && s_qrMode == qr && (!qr || s_qrVga == qrVga)) return true;
    if (s_inited) {
        esp_camera_deinit();
        s_inited = false;
    }
    bool ok;
    if (qr) {
        // grayscale: 1 byte/pixel entra direto no quirc. VGA a 10 MHz de XCLK:
        // a 20 MHz o DMA do ESP32 (PSRAM a 40 MHz) perdia linhas e o driver
        // jogava fora 2 de cada 3 quadros ("FB-SIZE: 305280 != 307200",
        // bancada 2026-10-11) — metade da taxa de pixel, quadro inteiro
        const int xclk = s_xclkMhz;
        if (qrVga) s_xclkMhz = 10;
        ok = initCamera(qrVga ? FRAMESIZE_VGA : FRAMESIZE_QVGA, PIXFORMAT_GRAYSCALE);
        s_xclkMhz = xclk;
    } else {
        ok = initCamera(s_photoSize, s_photoFmt);
    }
    if (ok) {
        s_qrMode = qr;
        s_qrVga = qrVga;
        if (qr) tuneForQr();
    }
    return ok;
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
// Duas passadas por frame:
//   A) imagem crua: o quirc binariza com UM limiar global (Otsu) — basta com
//      luz uniforme;
//   B) limiar local: grade de 20x15 blocos, cada pixel comparado a media da
//      vizinhanca 3x3 de blocos (~1/7 da largura). Resolve vinheta da lente,
//      reflexo de tela e sombra da mao, que derrubavam a passada A. Bloco
//      sem contraste (max-min < kFlatRange) vira branco: o ruido do sensor
//      nao gera falsos "modulos".
// Cada code achado que falha no ECC e tentado de novo espelhado
// (quirc_flip): QR visto por tras/espelhado pelo sensor.
constexpr int kTx = 20, kTy = 15;   // grade do limiar local
constexpr int kFlatRange = 28;      // contraste minimo de um bloco (0..255)
constexpr int kBias = 6;            // pixel "preto" = abaixo da media - bias
uint8_t s_tMean[kTy][kTx], s_tMin[kTy][kTx], s_tMax[kTy][kTx];

// diagnostico (log a cada ~3 s de scan sem sucesso): mostra de fora se o
// sensor ve o QR (grades achadas) e se a luz/contraste servem
struct QrDiag {
    uint32_t lastLog = 0;
    int frames = 0, gridsA = 0, gridsB = 0;
    int lastErr = -1;
    int mean = 0, lo = 255, hi = 0;
} s_diag;

void localThreshold(uint8_t* img, int w, int h) {
    const int tw = w / kTx, th = h / kTy;
    int gMin = 255, gMax = 0;
    uint32_t gSum = 0;
    for (int ty = 0; ty < kTy; ty++) {
        for (int tx = 0; tx < kTx; tx++) {
            uint32_t sum = 0;
            int mn = 255, mx = 0;
            for (int y = ty * th; y < (ty + 1) * th; y++) {
                const uint8_t* row = img + y * w + tx * tw;
                for (int x = 0; x < tw; x++) {
                    const int v = row[x];
                    sum += v;
                    if (v < mn) mn = v;
                    if (v > mx) mx = v;
                }
            }
            s_tMean[ty][tx] = (uint8_t)(sum / (uint32_t)(tw * th));
            s_tMin[ty][tx] = (uint8_t)mn;
            s_tMax[ty][tx] = (uint8_t)mx;
            gSum += s_tMean[ty][tx];
            if (mn < gMin) gMin = mn;
            if (mx > gMax) gMax = mx;
        }
    }
    s_diag.mean = (int)(gSum / (kTx * kTy));
    s_diag.lo = gMin;
    s_diag.hi = gMax;
    for (int ty = 0; ty < kTy; ty++) {
        for (int tx = 0; tx < kTx; tx++) {
            int sum = 0, n = 0, mn = 255, mx = 0;
            for (int dy = -1; dy <= 1; dy++) {
                const int yy = ty + dy;
                if (yy < 0 || yy >= kTy) continue;
                for (int dx = -1; dx <= 1; dx++) {
                    const int xx = tx + dx;
                    if (xx < 0 || xx >= kTx) continue;
                    sum += s_tMean[yy][xx];
                    n++;
                    if (s_tMin[yy][xx] < mn) mn = s_tMin[yy][xx];
                    if (s_tMax[yy][xx] > mx) mx = s_tMax[yy][xx];
                }
            }
            const bool flat = mx - mn < kFlatRange;
            const int t = sum / n - kBias;
            const int y1 = ty == kTy - 1 ? h : (ty + 1) * th;  // resto da divisao
            const int x1 = tx == kTx - 1 ? w : (tx + 1) * tw;
            for (int y = ty * th; y < y1; y++) {
                uint8_t* row = img + y * w;
                for (int x = tx * tw; x < x1; x++) {
                    row[x] = (flat || row[x] >= t) ? 255 : 0;
                }
            }
        }
    }
}

// quirc_code + quirc_data somam ~13 KB: NUNCA na pilha. Na task main (20 KB,
// ja funda no Duktape) o quirc_decode zera o quirc_data inteiro e passava do
// fim da pilha — que fica logo acima do .bss, onde mora o estado do NimBLE:
// ble_gap_vars virava NULL e o tick seguinte da malha caia em LoadProhibited
// (ble_gap_disc_active). So acontecia quando o QR ERA achado: toda leitura
// reiniciava a placa antes do LED/log (bancada esp32-cam 2026-10-11).
bool decodeBuffers() {
    if (s_qcode == nullptr) {
        s_qcode = (struct quirc_code*)heap_caps_malloc(sizeof(struct quirc_code),
                                                       MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (s_qcode == nullptr) s_qcode = (struct quirc_code*)malloc(sizeof(struct quirc_code));
    }
    if (s_qdata == nullptr) {
        s_qdata = (struct quirc_data*)heap_caps_malloc(sizeof(struct quirc_data),
                                                       MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (s_qdata == nullptr) s_qdata = (struct quirc_data*)malloc(sizeof(struct quirc_data));
    }
    return s_qcode != nullptr && s_qdata != nullptr;
}

// decodifica o que o quirc achou na ultima passada; true = `out` preenchido
bool decodeGrids(int n, std::string& out) {
    if (n > 0 && !decodeBuffers()) return false;
    for (int i = 0; i < n; i++) {
        struct quirc_code& code = *s_qcode;  // s_qcode existe (n > 0)
        struct quirc_data& data = *s_qdata;
        quirc_extract(s_qr, i, &code);
        quirc_decode_error_t err = quirc_decode(&code, &data);
        if (err == QUIRC_ERROR_DATA_ECC || err == QUIRC_ERROR_FORMAT_ECC) {
            quirc_flip(&code);
            err = quirc_decode(&code, &data);
        }
        if (err != QUIRC_SUCCESS) {
            s_diag.lastErr = (int)err;
            continue;
        }
        if (data.payload_len >= (int)sizeof(data.payload)) continue;
        data.payload[data.payload_len] = 0;  // garante fim de string
        out.assign((const char*)data.payload, data.payload_len);
        return true;
    }
    return false;
}

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
        const size_t px = (size_t)fb->width * fb->height;
        s_diag.frames++;
        // A) crua, limiar global do quirc
        uint8_t* img = quirc_begin(s_qr, nullptr, nullptr);
        if (img == nullptr) break;
        memcpy(img, fb->buf, px);
        quirc_end(s_qr);
        int n = quirc_count(s_qr);
        s_diag.gridsA += n;
        if (decodeGrids(n, out)) { ok = true; break; }
        esp_task_wdt_reset();
        CelerKernel::noteAppYield();
        // B) limiar local
        img = quirc_begin(s_qr, nullptr, nullptr);
        memcpy(img, fb->buf, px);
        localThreshold(img, fb->width, fb->height);
        quirc_end(s_qr);
        n = quirc_count(s_qr);
        s_diag.gridsB += n;
        if (decodeGrids(n, out)) ok = true;
    } while (0);
    esp_camera_fb_return(fb);

    const uint32_t now = millis();
    if (ok) {
        celer_log_printf("[qr] lido apos %d frames (grades A:%d B:%d)\n",
                         s_diag.frames, s_diag.gridsA, s_diag.gridsB);
        s_diag = QrDiag();
        s_diag.lastLog = now;
    } else if (now - s_diag.lastLog > 3000) {
        celer_log_printf("[qr] %d frames %dx%d luz %d (%d..%d) grades A:%d B:%d erro %s\n",
                         s_diag.frames, s_qrW, s_qrH, s_diag.mean, s_diag.lo, s_diag.hi,
                         s_diag.gridsA, s_diag.gridsB,
                         s_diag.lastErr < 0 ? "-" : quirc_strerror((quirc_decode_error_t)s_diag.lastErr));
        s_diag = QrDiag();
        s_diag.lastLog = now;
    }
    return ok;
}

}  // namespace

// reset por app (init/appExitCleanup): camera desligada, slots e quirc livres
static void teardown() {
    if (s_inited) {
        esp_camera_deinit();
        s_inited = false;
    }
    appRelease();
}

void JSBindings::cameraAppReset() {
    CamGuard g;
    appRelease();  // driver segue no ar (ver appRelease)
}

void CameraCore::warmup() {
    if (!available()) return;
    CamGuard g;
    // cinza VGA a 10 MHz, o modo do QR (o app de QR e o provedor da matilha
    // usam este mesmo): sobe com a RAM interna ainda inteira, antes do NimBLE
    if (!s_inited && ensureMode(true, true)) celer_log_printf("[cam] driver aquecido no boot (QR VGA)\n");
}

// ---- nucleo nativo (provedor "camera" dos recursos) ---------------------------

bool CameraCore::available() {
    return Board::profile().camera.present();
}

bool CameraCore::snapJpeg(int quality, uint8_t** out, size_t* len, int* w, int* h) {
    if (!available() || out == nullptr || len == nullptr) return false;
    if (quality < 5) quality = 5;
    if (quality > 63) quality = 63;
    CamGuard g;
    // camera parada (nenhum app a usa): sobe no modo que a bancada provou —
    // cinza VGA a 10 MHz, o mesmo do QrNode (o JPEG do driver nessa placa nao
    // entregava quadro nenhum: fb_get estourava, bancada 2026-10-11) — e FICA:
    // o proximo pedido nao paga o init, e um app de QR que chegue depois nao
    // troca de modo (o driver nao aguenta ciclos deinit+init)
    if (!s_inited && !ensureMode(true, true)) {
        celer_log_printf("[cam] snap: camera nao subiu\n");
        return false;
    }
    camera_fb_t* fb = esp_camera_fb_get();
    if (fb == nullptr) {
        celer_log_printf("[cam] snap: quadro nao veio\n");
        return false;
    }
    bool ok = false;
    if (fb->format == PIXFORMAT_JPEG) {
        uint8_t* b = (uint8_t*)heap_caps_malloc(fb->len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (b == nullptr) b = (uint8_t*)malloc(fb->len);
        if (b != nullptr) {
            memcpy(b, fb->buf, fb->len);
            *out = b;
            *len = fb->len;
            ok = true;
        }
    } else {
        // modo QR (cinza) ou RGB: JPEG por software do quadro vigente
        ok = frame2jpg(fb, (uint8_t)(100 - quality * 100 / 64), out, len);
        if (!ok) {
            celer_log_printf("[cam] snap: frame2jpg %dx%d fmt %d falhou (interna %u, maior %u)\n", fb->width,
                             fb->height, (int)fb->format, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
        }
    }
    if (w != nullptr) *w = fb->width;
    if (h != nullptr) *h = fb->height;
    esp_camera_fb_return(fb);
    return ok;
}

// ---- bindings ----------------------------------------------------------------

duk_ret_t JSBindings::js_cameraSetup(duk_context *ctx) {
    CamGuard g;  // antes de tocar o estado: o provedor da matilha pode estar
                 // num initCamera concorrente lendo estes campos (snapJpeg)
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

// qualidade do JPEG por software no capture a partir do quadro cinza do
// modo QR: a mesma escala 5..63 do snapJpeg com o default 12
constexpr uint8_t kCapJpgQ = (uint8_t)(100 - 12 * 100 / 64);

duk_ret_t JSBindings::js_cameraCapture(duk_context *ctx) {
    JSBindings::present();  // captura bloqueia ate o frame: app cede antes
    CamGuard g;
    // Sem ciclo deinit+init quando o driver ja esta no modo QR (cinza): o
    // JPEG sai por software do quadro vigente (frame2jpg — a mesma filosofia
    // do CameraCore::snapJpeg), porque o modo JPEG do driver nao entrega
    // quadro nenhum na esp32-cam e cada religadura arrisca o "camera not
    // supported" do 3o init (bancadas 2026-10-10/11). rgb565 (ou driver
    // parado) troca de modo como antes; o resultado informa o w/h real.
    const bool inPlace = s_inited && s_qrMode &&
                         (s_photoFmt == PIXFORMAT_JPEG || s_photoFmt == PIXFORMAT_GRAYSCALE);
    if (!inPlace && !ensureMode(false)) {
        duk_push_null(ctx);
        return 1;
    }
    camera_fb_t* fb = esp_camera_fb_get();
    if (fb == nullptr) {
        duk_push_null(ctx);
        return 1;
    }
    int id = 0;
    pixformat_t fmt = fb->format;
    const int w = fb->width, h = fb->height;  // antes do fb_return (fb morre la)
    if (inPlace && s_photoFmt == PIXFORMAT_JPEG) {
        // quadro cinza do modo QR -> JPEG no slot retido
        uint8_t* jpg = nullptr;
        size_t jlen = 0;
        if (frame2jpg(fb, kCapJpgQ, &jpg, &jlen) && jpg != nullptr) {
            id = retainFrame(jpg, jlen, fb->width, fb->height, PIXFORMAT_JPEG);
            free(jpg);
        }
    } else {
        id = retainFrame(fb->buf, fb->len, fb->width, fb->height, fb->format);
    }
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
    if (!perm(celer::PERM_FS) || !fsWriteAllowed(path)) {  // lint-perm: fs
        // mesma regra do FS.writeFile/Pack.snap: a permissao "camera" libera
        // o sensor, gravar arquivo no disco pede "fs"
        char msg[160];
        snprintf(msg, sizeof(msg), "FS: escrita negada em %s (permissao fs)", path);
        jsThrowMsg(ctx, DUK_ERR_ERROR, msg);
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
    bool vga = false;
    if (duk_is_object(ctx, 0)) {
        timeoutMs = optInt(ctx, "timeoutMs", timeoutMs);
        attempts = optInt(ctx, "attempts", 0);
        duk_get_prop_string(ctx, 0, "led");
        led = duk_get_boolean(ctx, -1) != 0;
        duk_pop(ctx);
        duk_get_prop_string(ctx, 0, "vga");
        vga = duk_get_boolean(ctx, -1) != 0;
        duk_pop(ctx);
    }
    if (timeoutMs < 250) timeoutMs = 250;
    if (attempts <= 0) attempts = timeoutMs / (vga ? 400 : 250);
    if (attempts > 60) attempts = 60;

    JSBindings::present();  // decode e iterativo e bloqueante: cede antes
    {
        CamGuard g;
        if (!ensureMode(true, vga)) {
            duk_push_null(ctx);
            return 1;
        }
    }
    if (led) flashLed(true);

    std::string out;
    const uint32_t t0 = millis();
    bool found = false;
    for (int i = 0; i < attempts && !found; i++) {
        esp_task_wdt_reset();
        CelerKernel::noteAppYield();  // cada tentativa renova a janela
        {
            // por tentativa: o provedor "camera" da matilha pega o driver entre
            // duas (uma foto pedida pela rede nao espera o scan inteiro)
            CamGuard g;
            if (!s_inited || !s_qrMode) ensureMode(true, vga);
            found = qrDecodeOnce(out);
        }
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
