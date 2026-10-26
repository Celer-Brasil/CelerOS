#include "DeviceStats.h"

// Coleta de uma foto (take) e instrumentacao viva (note*) do profiling do
// celerctl. Os contadores sao atomics relaxed: chamados de qualquer task
// (main/launcher, app JS na celerapp, duk allocators) sem lock — diagnostico
// nao paga sincronizacao.
//
// Nota: toJson fica inline no header (host-testavel); aqui so o que depende
// de ESP-IDF.

#include <atomic>
#include <cstdlib>
#include <cstring>

#include "esp_private/esp_clk.h"  // IDF 6: esp_clk.h publico saiu (mesmo uso do CelerCompat)
#include "esp_heap_caps.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "Core/CelerKernel.h"

namespace DeviceStats {

static_assert(kTaskNameLen >= configMAX_TASK_NAME_LEN,
              "kTaskNameLen acompanha configMAX_TASK_NAME_LEN (sdkconfig)");

// ---- instrumentacao (produtores) ----

static std::atomic<uint32_t> s_jsAlive{0};
static std::atomic<uint32_t> s_jsPeak{0};
static std::atomic<uint64_t> s_loopBusyUs{0};
static std::atomic<uint64_t> s_loopTotalUs{0};
static std::atomic<uint64_t> s_uiFrames{0};
static std::atomic<uint64_t> s_uiPresents{0};
static std::atomic<uint64_t> s_uiFrameUs{0};
static std::atomic<uint64_t> s_uiFrameUsMax{0};
static std::atomic<uint32_t> s_svcTicks{0};
static std::atomic<uint32_t> s_svcOverruns{0};
static std::atomic<uint32_t> s_svcBusyMsMax{0};
static std::atomic<uint64_t> s_svcBusyMsSum{0};
static std::atomic<bool> s_memLow{false};

void noteJsAlloc() {
    uint32_t n = s_jsAlive.fetch_add(1, std::memory_order_relaxed) + 1;
    uint32_t p = s_jsPeak.load(std::memory_order_relaxed);
    while (n > p && !s_jsPeak.compare_exchange_weak(p, n, std::memory_order_relaxed)) {
    }
}

void noteJsFree() {
    s_jsAlive.fetch_sub(1, std::memory_order_relaxed);
}

void noteLoopIter(uint32_t busyUs, uint32_t totalUs) {
    s_loopBusyUs.fetch_add(busyUs, std::memory_order_relaxed);
    s_loopTotalUs.fetch_add(totalUs, std::memory_order_relaxed);
}

void notePresent(uint32_t us, bool pushedFrame) {
    s_uiPresents.fetch_add(1, std::memory_order_relaxed);
    s_uiFrameUs.fetch_add(us, std::memory_order_relaxed);
    uint64_t m = s_uiFrameUsMax.load(std::memory_order_relaxed);
    while (us > m && !s_uiFrameUsMax.compare_exchange_weak(m, us, std::memory_order_relaxed)) {
    }
    if (pushedFrame) s_uiFrames.fetch_add(1, std::memory_order_relaxed);
}

void noteSvcTick(uint32_t busyMs, uint32_t budgetMs) {
    s_svcTicks.fetch_add(1, std::memory_order_relaxed);
    s_svcBusyMsSum.fetch_add(busyMs, std::memory_order_relaxed);
    uint32_t m = s_svcBusyMsMax.load(std::memory_order_relaxed);
    while (busyMs > m && !s_svcBusyMsMax.compare_exchange_weak(m, busyMs, std::memory_order_relaxed)) {
    }
    if (budgetMs > 0 && busyMs > budgetMs) s_svcOverruns.fetch_add(1, std::memory_order_relaxed);
}

void noteMemLevel(bool low) {
    s_memLow.store(low, std::memory_order_relaxed);
}

// ---- coleta (consumidores: handleStats do HostLink, top do shell) ----

static char stateChar(eTaskState s) {
    switch (s) {
        case eRunning: return 'R';
        case eReady: return 'r';
        case eBlocked: return 'B';
        case eSuspended: return 'S';
        case eDeleted: return 'D';
        default: return '?';
    }
}

bool take(Snapshot& out) {
    memset(&out, 0, sizeof(out));

    out.uptimeUs = (uint64_t)esp_timer_get_time();
    out.cpuFreqMHz = (uint32_t)(esp_clk_cpu_freq() / 1000000);

    // mesmo recorte do "free" do shell (o "heap" geral inclui a PSRAM)
    out.heapFree = (uint32_t)esp_get_free_heap_size();
    out.heapMin = (uint32_t)esp_get_minimum_free_heap_size();
    out.heapLargest = (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT);

    multi_heap_info_t mi;
    heap_caps_get_info(&mi, MALLOC_CAP_INTERNAL);
    out.intFree = (uint32_t)mi.total_free_bytes;
    out.intMin = (uint32_t)mi.minimum_free_bytes;
    out.intLargest = (uint32_t)mi.largest_free_block;
    out.memLow = s_memLow.load(std::memory_order_relaxed);
    heap_caps_get_info(&mi, MALLOC_CAP_SPIRAM);  // sem PSRAM: zeros
    out.psramFree = (uint32_t)mi.total_free_bytes;
    // IDF 6 tirou o campo total_bytes do multi_heap_info_t
    out.psramTotal = (uint32_t)(mi.total_free_bytes + mi.total_allocated_bytes);
    out.psramMin = (uint32_t)mi.minimum_free_bytes;
    out.psramLargest = (uint32_t)mi.largest_free_block;

    // app JS: mesmas contas do appLaunchFreeHeap para o delta fazer sentido
    out.jsActive = CelerKernel::ctx != nullptr;
    out.jsLaunchFree = (uint32_t)CelerKernel::appLaunchFreeHeap;
    out.jsNowFree = (uint32_t)(heap_caps_get_free_size(MALLOC_CAP_8BIT) +
                               heap_caps_get_free_size(MALLOC_CAP_IRAM_8BIT));
    out.jsAllocs = s_jsAlive.load(std::memory_order_relaxed);
    out.jsAllocsPeak = s_jsPeak.load(std::memory_order_relaxed);

    out.loopBusyUs = s_loopBusyUs.load(std::memory_order_relaxed);
    out.loopTotalUs = s_loopTotalUs.load(std::memory_order_relaxed);
    out.uiFrames = s_uiFrames.load(std::memory_order_relaxed);
    out.uiPresents = s_uiPresents.load(std::memory_order_relaxed);
    out.uiFrameUs = s_uiFrameUs.load(std::memory_order_relaxed);
    out.uiFrameUsMax = s_uiFrameUsMax.load(std::memory_order_relaxed);

    out.svcTicks = s_svcTicks.load(std::memory_order_relaxed);
    out.svcOverruns = s_svcOverruns.load(std::memory_order_relaxed);
    out.svcBusyMsMax = s_svcBusyMsMax.load(std::memory_order_relaxed);
    out.svcBusyMsSum = (uint32_t)s_svcBusyMsSum.load(std::memory_order_relaxed);

    // tasks: tabela so durante a coleta (mesma economia de RAM do ps do shell)
    UBaseType_t want = uxTaskGetNumberOfTasks();
    if (want == 0) return true;
    TaskStatus_t* sts = (TaskStatus_t*)malloc(want * sizeof(TaskStatus_t));
    if (sts == nullptr) return false;
    // configRUN_TIME_COUNTER_TYPE (U64 no nosso sdkconfig; local para nao
    // quebrar de vez num sdkconfig stale ainda em U32)
    configRUN_TIME_COUNTER_TYPE totalRt = 0;
    UBaseType_t got = uxTaskGetSystemState(sts, want, &totalRt);
    out.totalRunTimeUs = (uint64_t)totalRt;
    for (UBaseType_t i = 0; i < got; i++) {
        if (out.taskCount >= kMaxTasks) {
            out.truncated = true;
            break;
        }
        TaskInfo& t = out.tasks[out.taskCount++];
        strncpy(t.name, sts[i].pcTaskName, kTaskNameLen);
        t.name[kTaskNameLen] = '\0';
        t.state = stateChar(sts[i].eCurrentState);  // IDF 6: eTaskState -> eCurrentState
        t.prio = (uint8_t)sts[i].uxCurrentPriority;
        t.stackFree = (uint32_t)sts[i].usStackHighWaterMark;  // bytes no IDF
        t.runTimeUs = (uint64_t)sts[i].ulRunTimeCounter;
    }
    free(sts);
    return true;
}

}  // namespace DeviceStats
