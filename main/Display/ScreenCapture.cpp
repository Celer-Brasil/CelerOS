#include "ScreenCapture.h"

#include <stdlib.h>
#include <string.h>
#include <Arduino.h>
#include "../Boards/Board.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

namespace ScreenCapture {

namespace {
TaskHandle_t s_uiTask = nullptr;
SemaphoreHandle_t s_reqLock = nullptr;  // um pedinte por vez (sessao inteira)
SemaphoreHandle_t s_done = nullptr;     // UI -> pedinte: bloco lido

// Ciclo de vida do pedido (estado escrito/lido sob s_reqMux — SMP: os
// nucleos compartilham a DRAM, mas o volatile sozinho nao ordena; e o mux
// que da o happens-before dos PARAMETROS lidos pela UI):
//   kIdle    -> nenhum pedido
//   kQueued  -> pedido postado, a UI ainda nao pegou
//   kClaimed -> a UI esta lendo (readDirect) escrevendo no s_dst do pedinte
enum : uint8_t { kIdle = 0, kQueued = 1, kClaimed = 2 };
portMUX_TYPE s_reqMux = portMUX_INITIALIZER_UNLOCKED;
volatile uint8_t s_reqState = kIdle;
uint16_t s_y = 0, s_n = 0;
uint16_t* s_dst = nullptr;
int s_got = 0;

int readDirect(uint16_t y, uint16_t n, uint16_t* dst) {
    CelerDisplay& tft = Board::display();
    const int h = tft.height();
    if (y >= h) return 0;
    if (y + n > h) n = (uint16_t)(h - y);
    tft.readRect(0, y, tft.width(), n, dst);  // RGB565 (swapBytes: ordem LE)
    return n;
}
}  // namespace

void init() {
    s_uiTask = xTaskGetCurrentTaskHandle();
    if (s_reqLock == nullptr) s_reqLock = xSemaphoreCreateMutex();
    if (s_done == nullptr) s_done = xSemaphoreCreateBinary();
}

int readRows(uint16_t y, uint16_t n, uint16_t* dst, uint32_t timeoutMs) {
    if (s_uiTask == nullptr || xTaskGetCurrentTaskHandle() == s_uiTask) return readDirect(y, n, dst);
    if (xSemaphoreTake(s_reqLock, pdMS_TO_TICKS(timeoutMs)) != pdTRUE) return 0;
    xSemaphoreTake(s_done, 0);  // descarta sinal velho (pedido anterior que expirou)
    portENTER_CRITICAL(&s_reqMux);
    s_y = y;
    s_n = n;
    s_dst = dst;
    s_got = 0;
    s_reqState = kQueued;
    portEXIT_CRITICAL(&s_reqMux);
    int got = 0;
    if (xSemaphoreTake(s_done, pdMS_TO_TICKS(timeoutMs)) == pdTRUE) {
        got = s_got;
    } else {
        // A UI nao atendeu a tempo (app preso?). Cancela: em kQueued a UI nem
        // chega a pegar o pedido; em kClaimed ela esta COM o nosso buffer em
        // maos — espera o fim do readDirect dela, porque o buffer so pode ser
        // devolvido/liberado pelo chamador quando ninguem mais escreve nele
        // (antes o write-after-free acontecia: a UI atendia um pedido que o
        // pedinte ja havia abandonado).
        bool claimed = false;
        portENTER_CRITICAL(&s_reqMux);
        if (s_reqState == kQueued) {
            s_reqState = kIdle;
        } else if (s_reqState == kClaimed) {
            claimed = true;
        }
        portEXIT_CRITICAL(&s_reqMux);
        // kClaimed: a UI esta escrevendo no NOSSO buffer. Esperar sem teto e
        // obrigatorio — o timeout de 2 s devolvia o controle ao chamador,
        // que podia liberar dst enquanto a UI ainda escrevia (write-after-free).
        // Se a UI travar de vez, o chamador fica preso (melhor que corromper).
        if (claimed) xSemaphoreTake(s_done, portMAX_DELAY);
    }
    xSemaphoreGive(s_reqLock);
    return got;
}

void service() {
    if (s_reqState != kQueued) return;  // fast path sem lock (confirmado abaixo)
    if (xTaskGetCurrentTaskHandle() != s_uiTask) return;
    portENTER_CRITICAL(&s_reqMux);
    if (s_reqState != kQueued) {  // pedinte cancelou entre o fast path e aqui
        portEXIT_CRITICAL(&s_reqMux);
        return;
    }
    s_reqState = kClaimed;
    portEXIT_CRITICAL(&s_reqMux);
    // Leitura lenta FORA do spinlock; os parametros sao os postados sob o
    // mesmo mux do claim (happens-before).
    const int got = readDirect(s_y, s_n, s_dst);
    portENTER_CRITICAL(&s_reqMux);
    s_got = got;
    s_reqState = kIdle;
    portEXIT_CRITICAL(&s_reqMux);
    xSemaphoreGive(s_done);
}

void serviceDelay(uint32_t ms) {
    const uint32_t t0 = millis();
    for (;;) {
        service();
        uint32_t el = millis() - t0;
        if (el >= ms) break;
        uint32_t slice = ms - el;
        delay(slice > 10 ? 10 : slice);  // sem pedido: so dorme em fatias
    }
}

bool stream(bool rle, uint8_t* out, size_t cap, const std::function<bool(const uint8_t*, size_t)>& sink) {
    CelerDisplay& tft = Board::display();
    const uint16_t w = (uint16_t)tft.width();
    const uint16_t h = (uint16_t)tft.height();
    constexpr uint16_t kRows = 8;  // bloco por pedido: ~12ms de SPI na CYD
    uint16_t* rows = (uint16_t*)malloc((size_t)w * kRows * 2);
    if (rows == nullptr) return false;

    bool ok = true;
    size_t used = 0;
    auto flush = [&]() {
        if (used > 0 && ok) ok = sink(out, used);
        used = 0;
    };
    uint16_t runPx = 0, runLen = 0;
    auto emitRun = [&]() {
        if (runLen == 0) return;
        if (used + 4 > cap) flush();
        out[used++] = (uint8_t)runLen;
        out[used++] = (uint8_t)(runLen >> 8);
        out[used++] = (uint8_t)runPx;
        out[used++] = (uint8_t)(runPx >> 8);
        runLen = 0;
    };

    for (uint16_t y = 0; y < h && ok; y += kRows) {
        int n = readRows(y, kRows, rows);
        if (n <= 0) {
            ok = false;
            break;
        }
        const uint16_t* px = rows;
        const size_t count = (size_t)w * n;
        if (!rle) {
            const uint8_t* src = (const uint8_t*)px;
            size_t rem = count * 2;
            while (rem > 0 && ok) {
                size_t k = cap - used < rem ? cap - used : rem;
                memcpy(out + used, src, k);
                used += k;
                src += k;
                rem -= k;
                if (used == cap) flush();
            }
            continue;
        }
        for (size_t i = 0; i < count; i++) {
            if (runLen > 0 && px[i] == runPx && runLen < 0xFFFF) {
                runLen++;
            } else {
                emitRun();
                runPx = px[i];
                runLen = 1;
            }
        }
    }
    emitRun();
    flush();
    free(rows);
    return ok;
}

}  // namespace ScreenCapture
