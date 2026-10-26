#include "MemWatch.h"

#include "DeviceStats.h"

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char* TAG = "celer.memwatch";

namespace {
MemWatch::Level s_level = MemWatch::Level::Ok;
uint32_t s_lastMs = 0;
}  // namespace

namespace MemWatch {

Level level() { return s_level; }

void tick() {
    const uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
    if (now - s_lastMs < 1000) return;  // 1 Hz; unsigned cobre o wrap
    s_lastMs = now;

    const uint32_t freeBytes =
        (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    const uint32_t largestBytes =
        (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);

    const Level next = classify(freeBytes, largestBytes, s_level);
    if (next == s_level) return;
    s_level = next;
    DeviceStats::noteMemLevel(next == Level::Low);

    // Sem toast aqui de proposito: Navigator::toast recebe std::string e
    // copia para o Toast (aloca). Justamente com a RAM no limite isso pode
    // abortar. O aviso fica no log e no KL_STATS (heap.low), que o
    // `celerctl stats/top` mostra; a UI pode ler level() sem alocar.
    if (next == Level::Low) {
        ESP_LOGW(TAG, "RAM interna baixa: livre %u B, maior bloco %u B", freeBytes,
                 largestBytes);
    } else {
        ESP_LOGI(TAG, "RAM interna recuperou: livre %u B, maior bloco %u B", freeBytes,
                 largestBytes);
    }
}

}  // namespace MemWatch
