#include "CamRes.h"

#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "../Runtime/CameraCore.h"
#include "../USBDevice/LogSink.h"
#include "DataLink.h"
#include "../Utils/TaskCaps.h"

// Camera dos recursos da matilha (ver CamRes.h).

namespace CamRes {
namespace {

const char* TAG = "celer.cam";

constexpr size_t BULK_HDR = 9;               // xfer + total + off
constexpr uint32_t K_ACK_WAIT_MS = 600;      // espera do bitmap por rodada
constexpr int K_ROUNDS = 4;                  // rodadas de reenvio da foto
constexpr uint32_t K_GAP_MS = 250;           // rajada parada: o cliente manda o bitmap

uint32_t nowMs() {
    return (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
}

void* psram(size_t n) {
    void* p = heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    return p != nullptr ? p : malloc(n);
}

inline void put32(uint8_t* p, uint32_t v) {
    p[0] = (uint8_t)(v >> 24);
    p[1] = (uint8_t)(v >> 16);
    p[2] = (uint8_t)(v >> 8);
    p[3] = (uint8_t)v;
}
inline uint32_t get32(const uint8_t* p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

// ------------------------------------------------------------ provedor

struct Serve {
    volatile bool run = false;
    volatile bool alive = false;
    uint8_t mac[6] = {0};
    uint16_t sid = 0;
    uint32_t token = 0;
    int quality = 12;
    int fps = 0;
    TaskHandle_t task = nullptr;
    // ultimo bitmap do cliente (escrito pela res_rx, lido pela task)
    portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
    volatile bool ackNew = false;
    uint8_t ackXfer = 0;
    uint16_t ackN = 0;
    uint8_t ackBits[MAX_CHUNKS / 8] = {0};
};
Serve s_srv;

bool sendChunk(uint8_t xfer, const uint8_t* img, size_t len, size_t idx, uint16_t& seq) {
    uint8_t p[BULK_HDR + CHUNK];
    const size_t off = idx * CHUNK;
    const size_t n = len - off < CHUNK ? len - off : CHUNK;
    p[0] = xfer;
    put32(p + 1, (uint32_t)len);
    put32(p + 5, (uint32_t)off);
    memcpy(p + BULK_HDR, img + off, n);
    // fila do driver cheia: espera escoar (a 24 Mbps um bloco sai em ~0,5 ms)
    for (int tries = 0; tries < 50 && s_srv.run; tries++) {
        if (DataLink::send(s_srv.mac, DataLink::KIND_BULK, s_srv.sid, s_srv.token, ++seq, p,
                           BULK_HDR + n)) {
            return true;
        }
        vTaskDelay(pdMS_TO_TICKS(2));
    }
    return false;
}

void serveTask(void*) {
    uint8_t xfer = 0;
    uint16_t seq = 0;
    uint32_t frames = 0, resent = 0, fails = 0;
    while (s_srv.run) {
        const uint32_t t0 = nowMs();
        uint8_t* img = nullptr;
        size_t len = 0;
        int w = 0, h = 0;
        if (!CameraCore::snapJpeg(s_srv.quality, &img, &len, &w, &h) || len == 0 || len > MAX_IMAGE) {
            free(img);
            if (fails == 0) celer_log_printf("[cam] provedor: foto falhou (len %u)\n", (unsigned)len);
            fails++;
            vTaskDelay(pdMS_TO_TICKS(200));
            if (s_srv.fps == 0 && fails >= 5) break;  // foto que nao sai: desiste
            continue;
        }
        xfer++;
        const size_t n = (len + CHUNK - 1) / CHUNK;
        for (size_t i = 0; i < n && s_srv.run; i++) sendChunk(xfer, img, len, i, seq);
        if (s_srv.fps == 0) {
            // foto: confiavel — reenvia o que o bitmap disser que faltou
            bool done = false;
            for (int round = 0; round < K_ROUNDS && s_srv.run && !done; round++) {
                const uint32_t tw = nowMs();
                bool got = false;
                while (s_srv.run && nowMs() - tw < K_ACK_WAIT_MS) {
                    if (s_srv.ackNew) {
                        got = true;
                        break;
                    }
                    vTaskDelay(pdMS_TO_TICKS(10));
                }
                uint8_t bits[MAX_CHUNKS / 8];
                bool forUs = false;
                if (got) {
                    portENTER_CRITICAL(&s_srv.mux);
                    s_srv.ackNew = false;
                    forUs = s_srv.ackXfer == xfer && s_srv.ackN == n;
                    memcpy(bits, s_srv.ackBits, sizeof(bits));
                    portEXIT_CRITICAL(&s_srv.mux);
                }
                size_t missing = 0;
                for (size_t i = 0; i < n && s_srv.run; i++) {
                    const bool have = forUs && (bits[i / 8] & (1u << (i % 8)));
                    if (!have) {
                        missing++;
                        sendChunk(xfer, img, len, i, seq);
                    }
                }
                if (forUs && missing == 0) done = true;
                resent += missing;
            }
            celer_log_printf("[cam] foto %dx%d %u B em %u blocos -> sessao %u (%s, %u reenvios)\n", w, h,
                     (unsigned)len, (unsigned)n, (unsigned)s_srv.sid, done ? "entregue" : "sem confirmacao",
                     (unsigned)resent);
            free(img);
            break;  // uma foto por sessao
        }
        free(img);
        frames++;
        // video: cadencia pelo fps (o tempo do JPEG/envio ja conta)
        const uint32_t period = 1000 / (uint32_t)s_srv.fps;
        const uint32_t spent = nowMs() - t0;
        if (spent < period) vTaskDelay(pdMS_TO_TICKS(period - spent));
    }
    if (s_srv.fps > 0) {
        ESP_LOGI(TAG, "video parou (sessao %u, %u quadros)", (unsigned)s_srv.sid, (unsigned)frames);
    }
    s_srv.alive = false;
    vTaskSuspend(nullptr);  // pilha com caps: o serveStop apaga (como o mic)
}

// ------------------------------------------------------------- cliente

struct Asm {
    bool used = false;
    bool video = false;
    // imagem em curso
    uint8_t xfer = 0;
    bool active = false;
    uint8_t* buf = nullptr;
    uint32_t total = 0;
    uint16_t n = 0, nGot = 0;
    uint8_t bits[MAX_CHUNKS / 8] = {0};
    uint32_t lastChunkMs = 0, lastAckMs = 0;
    bool complete = false;
    bool ackNow = false;  // bitmap cheio a mandar (completou / bloco repetido)
    // ultima completa
    uint8_t* done = nullptr;
    size_t doneLen = 0;
    bool doneNew = false;
    uint32_t frames = 0;
};
Asm s_asm[SLOTS];

void sendAck(Asm& a, const uint8_t mac[6], uint16_t sid, uint32_t token) {
    uint8_t p[3 + MAX_CHUNKS / 8];
    p[0] = a.xfer;
    p[1] = (uint8_t)(a.n >> 8);
    p[2] = (uint8_t)a.n;
    const size_t nb = (a.n + 7) / 8;
    memcpy(p + 3, a.bits, nb);
    DataLink::send(mac, DataLink::KIND_BULK_ACK, sid, token, 0, p, 3 + nb);
    a.lastAckMs = nowMs();
}

}  // namespace

bool available() {
    return CameraCore::available();
}

bool serveStart(const uint8_t mac[6], uint16_t sid, uint32_t token, int quality, int fps) {
    if (!available() || s_srv.alive) return false;
    if (s_srv.task != nullptr) {
        celerTaskDelete(s_srv.task);
        s_srv.task = nullptr;
    }
    memcpy(s_srv.mac, mac, 6);
    s_srv.sid = sid;
    s_srv.token = token;
    s_srv.quality = quality;
    s_srv.fps = fps < 0 ? 0 : fps > 10 ? 10 : fps;
    s_srv.ackNew = false;
    s_srv.run = true;
    s_srv.alive = true;
    // pilha na PSRAM: driver da camera, JPEG por software e esp_now_send —
    // nada de flash. 8 KB: o frame2jpg usa bem a pilha
    // interna (ESP32 classico): 8 KB — com 6 KB o video (frame2jpg VGA a cada
    // quadro) derrubava a cam depois de 3 quadros (bancada 2026-10-11)
    if (celerTaskCreate(serveTask, "res_cam", 8192, 8192, nullptr, 4, &s_srv.task) != pdPASS) {
        s_srv.run = false;
        s_srv.alive = false;
        s_srv.task = nullptr;
        celer_log_printf("[cam] provedor: task res_cam nao subiu (interna %u)\n",
                         (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
        return false;
    }
    ESP_LOGI(TAG, "camera -> sessao %u (%s, qualidade %d)", (unsigned)sid,
             s_srv.fps > 0 ? "video" : "foto", quality);
    return true;
}

void serveStop(uint16_t sid) {
    if (s_srv.sid != sid) return;
    s_srv.run = false;
    // a task sai no fim do quadro em curso (um JPEG leva ate ~300 ms)
    for (int i = 0; i < 60 && s_srv.alive; i++) vTaskDelay(pdMS_TO_TICKS(10));
    if (!s_srv.alive && s_srv.task != nullptr) {
        celerTaskDelete(s_srv.task);
        s_srv.task = nullptr;
    }
}

bool serving(uint16_t sid) {
    return s_srv.alive && s_srv.sid == sid;
}

void onAck(uint16_t sid, const uint8_t* p, size_t len) {
    if (sid != s_srv.sid || len < 3) return;
    const uint16_t n = (uint16_t)((p[1] << 8) | p[2]);
    const size_t nb = (n + 7) / 8;
    if (n > MAX_CHUNKS || len < 3 + nb) return;
    portENTER_CRITICAL(&s_srv.mux);
    s_srv.ackXfer = p[0];
    s_srv.ackN = n;
    memset(s_srv.ackBits, 0, sizeof(s_srv.ackBits));
    memcpy(s_srv.ackBits, p + 3, nb);
    s_srv.ackNew = true;
    portEXIT_CRITICAL(&s_srv.mux);
}

void clientBegin(int slot, bool video) {
    if (slot < 0 || slot >= SLOTS) return;
    clientEnd(slot);
    s_asm[slot].used = true;
    s_asm[slot].video = video;
}

void clientEnd(int slot) {
    if (slot < 0 || slot >= SLOTS) return;
    Asm& a = s_asm[slot];
    free(a.buf);
    free(a.done);
    a = Asm{};
}

bool clientChunk(int slot, const uint8_t* p, size_t len) {
    if (slot < 0 || slot >= SLOTS || len <= BULK_HDR) return false;
    Asm& a = s_asm[slot];
    if (!a.used) return false;
    const uint8_t xfer = p[0];
    const uint32_t total = get32(p + 1), off = get32(p + 5);
    const size_t n = len - BULK_HDR;
    if (total == 0 || total > MAX_IMAGE || off % CHUNK != 0 || off + n > total) return false;
    if (a.active && xfer == a.xfer && a.complete) {
        a.ackNow = true;  // reenvio de uma imagem que ja temos: o ACK se perdeu
        return false;
    }
    if (!a.active || xfer != a.xfer) {
        // imagem nova (video: a anterior incompleta e descartada)
        free(a.buf);
        a.buf = (uint8_t*)psram(total);
        if (a.buf == nullptr) {
            a.active = false;
            return false;
        }
        a.active = true;
        a.complete = false;
        a.ackNow = false;
        a.xfer = xfer;
        a.total = total;
        a.n = (uint16_t)((total + CHUNK - 1) / CHUNK);
        a.nGot = 0;
        memset(a.bits, 0, sizeof(a.bits));
    }
    if (total != a.total) return false;
    const size_t idx = off / CHUNK;
    a.lastChunkMs = nowMs();
    if (a.bits[idx / 8] & (1u << (idx % 8))) return false;  // repetido
    memcpy(a.buf + off, p + BULK_HDR, n);
    a.bits[idx / 8] |= (uint8_t)(1u << (idx % 8));
    if (++a.nGot < a.n) return false;
    // completou: vira a "ultima completa" (o buffer troca de dono)
    a.complete = true;
    a.ackNow = !a.video;  // video nao confirma (sem reenvio)
    free(a.done);
    a.done = a.buf;
    a.doneLen = a.total;
    a.doneNew = true;
    a.frames++;
    a.buf = nullptr;
    return true;
}

void clientTimers(int slot, const uint8_t mac[6], uint16_t sid, uint32_t token) {
    if (slot < 0 || slot >= SLOTS) return;
    Asm& a = s_asm[slot];
    if (!a.used || a.video || !a.active) return;
    const uint32_t now = nowMs();
    if (a.ackNow) {
        a.ackNow = false;
        sendAck(a, mac, sid, token);
    } else if (!a.complete && now - a.lastChunkMs > K_GAP_MS && now - a.lastAckMs > K_GAP_MS) {
        sendAck(a, mac, sid, token);  // rajada parou com buracos: pede o resto
    }
}

void clientProgress(int slot, uint32_t* bytes, uint32_t* total, uint32_t* frames) {
    *bytes = *total = *frames = 0;
    if (slot < 0 || slot >= SLOTS || !s_asm[slot].used) return;
    const Asm& a = s_asm[slot];
    *total = a.total;
    *bytes = a.complete ? a.total : (uint32_t)a.nGot * CHUNK > a.total ? a.total : (uint32_t)a.nGot * CHUNK;
    *frames = a.frames;
}

bool clientTakeImage(int slot, uint8_t** buf, size_t* len) {
    if (slot < 0 || slot >= SLOTS) return false;
    Asm& a = s_asm[slot];
    if (!a.used || a.video || !a.doneNew || a.done == nullptr) return false;
    *buf = a.done;
    *len = a.doneLen;
    a.done = nullptr;
    a.doneNew = false;
    return true;
}

bool clientLatest(int slot, uint8_t** buf, size_t* len) {
    if (slot < 0 || slot >= SLOTS) return false;
    Asm& a = s_asm[slot];
    if (!a.used || !a.doneNew || a.done == nullptr) return false;
    *buf = a.done;  // o chamador libera; o proximo quadro aloca o seu
    *len = a.doneLen;
    a.done = nullptr;
    a.doneNew = false;
    return true;
}

}  // namespace CamRes
