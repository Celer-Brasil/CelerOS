#include "AudioRes.h"

#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"

#include "../Boards/Board.h"
#include "../Hardware/AudioPlayer.h"
#include "../Hardware/BoardIO.h"
#include "DataLink.h"
#include "../Utils/TaskCaps.h"

// Pontas de audio dos recursos da matilha (ver AudioRes.h).

namespace AudioRes {
namespace {

const char* TAG = "celer.audio";

// ---- fonte (mic -> par) ----
struct Source {
    volatile bool run = false;
    volatile bool alive = false;   // task ainda no loop (stop espera ela sair)
    uint16_t sid = 0;
    uint32_t token = 0;
    uint8_t mac[6] = {0};
    TaskHandle_t task = nullptr;
};
Source s_src;
uint32_t s_srcFrames = 0, s_srcFail = 0;

void srcTask(void*) {
    const BoardProfile& bp = Board::profile();
    BoardIO::micEnsureChannel();
    if (bp.micCodecWake != nullptr) bp.micCodecWake();  // ES7210 do watch: ADC ligado
    int16_t pcm[256];  // 16 ms
    uint16_t seq = 0;
    int errs = 0, lastErr = 0;
    while (s_src.run) {
        const int n = BoardIO::micReadMonoLocked(pcm, 256);
        if (n <= 0) {
            // -2 lock ocupado, -3 canal nao subiu, -4 sem clock/dados, -1 erro
            if (n != lastErr || ++errs % 50 == 1) {
                ESP_LOGW(TAG, "mic: leitura %d (x%d)", n, errs);
                lastErr = n;
            }
            vTaskDelay(pdMS_TO_TICKS(10));  // canal ocupado/sem clock: tenta de novo
            continue;
        }
        if (DataLink::send(s_src.mac, DataLink::KIND_STREAM, s_src.sid, s_src.token, ++seq, pcm,
                           (size_t)n * 2)) {
            s_srcFrames++;
        } else {
            s_srcFail++;  // fila do driver cheia: o bloco cai (tempo real)
        }
    }
    if (bp.micCodecSleep != nullptr) bp.micCodecSleep();
    s_src.alive = false;
    // pilha com caps: quem apaga e o sourceStop (a doc do IDF desaconselha o
    // auto-delete dessas tasks) — aqui so estaciona
    vTaskSuspend(nullptr);
}

// ---- tocar (stream -> speaker) ----
AudioPlayer::PcmFeed* s_feed = nullptr;
uint16_t s_playSid = 0;
uint32_t s_playFrames = 0;
constexpr uint32_t K_PREBUFFER_MS = 160;  // jitter do ar: ~10 blocos

// ---- gravar (stream -> WAV) ----
struct Rec {
    bool on = false;
    uint16_t sid = 0;
    uint32_t startMs = 0, maxMs = 0;  // prazo de parede: sem audio chegando, encerra
    int16_t* pcm = nullptr;
    size_t cap = 0, n = 0;  // amostras
    int level = -1;
};
Rec s_rec;
uint32_t s_recFrames = 0;

inline void u16le(uint8_t* p, uint16_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}
inline void u32le(uint8_t* p, uint32_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

}  // namespace

bool micAvailable() {
    return Board::profile().mic.ws >= 0;
}

bool speakerAvailable() {
    return Board::profile().i2s.dout >= 0;  // PcmFeed precisa do I2S (buzzer LEDC nao toca PCM)
}

bool sourceStart(const uint8_t mac[6], uint16_t sid, uint32_t token) {
    if (!micAvailable() || s_src.alive) return false;
    if (s_src.task != nullptr) {  // task da sessao anterior estacionada
        celerTaskDelete(s_src.task);
        s_src.task = nullptr;
    }
    memcpy(s_src.mac, mac, 6);
    s_src.sid = sid;
    s_src.token = token;
    s_src.run = true;
    s_src.alive = true;
    // pilha na PSRAM: a task so le o I2S e chama o esp_now_send (nada de
    // flash) — a RAM interna do relogio e o que o DMA do proprio mic precisa
    if (celerTaskCreate(srcTask, "res_mic", 4096, 3072, nullptr, 5, &s_src.task) != pdPASS) {
        s_src.run = false;
        s_src.alive = false;
        return false;
    }
    ESP_LOGI(TAG, "mic -> sessao %u (stream PCM 16 kHz)", (unsigned)sid);
    return true;
}

void sourceStop(uint16_t sid) {
    if (!s_src.alive || s_src.sid != sid) return;
    s_src.run = false;
    // a task sai no fim da leitura em curso (<= 150 ms de timeout do I2S)
    for (int i = 0; i < 40 && s_src.alive; i++) vTaskDelay(pdMS_TO_TICKS(10));
    if (!s_src.alive && s_src.task != nullptr) {
        celerTaskDelete(s_src.task);
        s_src.task = nullptr;
    }
    ESP_LOGI(TAG, "mic parou (sessao %u, %u blocos, %u sem fila)", (unsigned)sid,
             (unsigned)s_srcFrames, (unsigned)s_srcFail);
}

bool sourceActive() {
    return s_src.alive;
}

bool playStart(uint16_t sid) {
    if (!speakerAvailable() || s_feed != nullptr) return false;
    AudioPlayer::PcmFeed* f = new (std::nothrow) AudioPlayer::PcmFeed();
    if (f == nullptr) return false;
    // 1 s de fila (32 KB na PSRAM): sobra para o jitter e para rajadas
    if (!f->begin(RATE, RATE * 2)) {
        delete f;
        return false;  // speaker ocupado (playWav/fala) ou gravando no codec
    }
    s_feed = f;
    s_playSid = sid;
    ESP_LOGI(TAG, "speaker <- sessao %u", (unsigned)sid);
    return true;
}

void playFeed(uint16_t sid, const uint8_t* pcm, size_t len) {
    if (s_feed == nullptr || sid != s_playSid || len == 0) return;
    // nao bloqueia o tick: fila cheia (fonte mais rapida que o I2S) descarta
    if (s_feed->bufferedMs() > 900) return;
    s_feed->write(pcm, len);
    s_playFrames++;
    if (!s_feed->started() && s_feed->bufferedMs() >= K_PREBUFFER_MS) s_feed->start();
}

void playStop(uint16_t sid) {
    if (s_feed == nullptr || sid != s_playSid) return;
    ESP_LOGI(TAG, "speaker parou (sessao %u, %u blocos, %u faltas / %u ms)", (unsigned)sid,
             (unsigned)s_playFrames, (unsigned)s_feed->starves(), (unsigned)s_feed->starveMs());
    s_feed->end();
    delete s_feed;
    s_feed = nullptr;
    s_playSid = 0;
}

bool playActive() {
    return s_feed != nullptr;
}

bool recStart(uint16_t sid, uint32_t maxMs) {
    if (s_rec.on || s_rec.pcm != nullptr) return false;
    if (maxMs < 200) maxMs = 200;
    if (maxMs > 10000) maxMs = 10000;  // mesmo teto do gravador local (320 KB)
    s_rec.cap = (size_t)maxMs * (RATE / 1000);
    s_rec.pcm = (int16_t*)heap_caps_malloc(s_rec.cap * 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_rec.pcm == nullptr) return false;
    s_rec.n = 0;
    s_rec.sid = sid;
    s_rec.on = true;
    s_rec.level = 0;
    s_rec.startMs = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
    s_rec.maxMs = maxMs;
    return true;
}

void recFeed(uint16_t sid, const uint8_t* pcm, size_t len) {
    if (!s_rec.on || sid != s_rec.sid || s_rec.pcm == nullptr) return;
    size_t n = len / 2;
    if (s_rec.n + n > s_rec.cap) n = s_rec.cap - s_rec.n;
    memcpy(s_rec.pcm + s_rec.n, pcm, n * 2);
    s_rec.level = BoardIO::rmsLevel100(s_rec.pcm + s_rec.n, (int)n, 1, 0);
    s_rec.n += n;
    s_recFrames++;
    if (s_rec.n >= s_rec.cap) s_rec.on = false;  // teto: o app ve recording() virar false
}

bool recActive(uint16_t sid) {
    if (!s_rec.on || s_rec.sid != sid) return false;
    // o mic remoto pode nao mandar nada (falhou, saiu do ar): o app que espera
    // recording() virar false nao pode ficar preso — teto + 1 s de folga
    const uint32_t now = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
    if (now - s_rec.startMs > s_rec.maxMs + 1000) s_rec.on = false;
    return s_rec.on;
}

int recLevel() {
    return s_rec.pcm != nullptr ? s_rec.level : -1;
}

char* recStop(bool base64, size_t* lenOut, uint32_t* msOut) {
    if (s_rec.pcm == nullptr) return nullptr;
    s_rec.on = false;
    const size_t dataLen = s_rec.n * 2;
    if (msOut != nullptr) *msOut = (uint32_t)(s_rec.n / (RATE / 1000));
    uint8_t* wav = (uint8_t*)heap_caps_malloc(44 + dataLen, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    char* out = nullptr;
    if (wav != nullptr) {
        // header PCM16 mono 16 kHz de 44 B (o mesmo do gravador local)
        memcpy(wav, "RIFF", 4);
        u32le(wav + 4, 36 + (uint32_t)dataLen);
        memcpy(wav + 8, "WAVE", 4);
        memcpy(wav + 12, "fmt ", 4);
        u32le(wav + 16, 16);
        u16le(wav + 20, 1);
        u16le(wav + 22, 1);
        u32le(wav + 24, RATE);
        u32le(wav + 28, RATE * 2);
        u16le(wav + 32, 2);
        u16le(wav + 34, 16);
        memcpy(wav + 36, "data", 4);
        u32le(wav + 40, (uint32_t)dataLen);
        memcpy(wav + 44, s_rec.pcm, dataLen);
        if (!base64) {
            out = (char*)wav;
            if (lenOut != nullptr) *lenOut = 44 + dataLen;
        } else {
            size_t b64len = 0;
            mbedtls_base64_encode(nullptr, 0, &b64len, wav, 44 + dataLen);
            out = (char*)heap_caps_malloc(b64len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
            if (out != nullptr) {
                mbedtls_base64_encode((unsigned char*)out, b64len, &b64len, wav, 44 + dataLen);
                if (lenOut != nullptr) *lenOut = b64len;
            }
            heap_caps_free(wav);
        }
    }
    heap_caps_free(s_rec.pcm);
    s_rec.pcm = nullptr;
    s_rec.n = s_rec.cap = 0;
    s_rec.sid = 0;
    s_rec.level = -1;
    return out;
}

void stats(Stats* out) {
    out->srcFrames = s_srcFrames;
    out->srcFail = s_srcFail;
    out->playFrames = s_playFrames;
    out->playStarves = s_feed != nullptr ? s_feed->starves() : 0;
    out->recFrames = s_recFrames;
}

}  // namespace AudioRes
