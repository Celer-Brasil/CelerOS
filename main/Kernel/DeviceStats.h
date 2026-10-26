#ifndef CELER_DEVICESTATS_H
#define CELER_DEVICESTATS_H

#include <stddef.h>
#include <stdint.h>

// Coletor unico do profiling do celerctl (opcode KL_STATS e o comando top do
// shell): uma foto de heap + tasks + carga. Todos os contadores sao
// CUMULATIVOS desde o boot — quem calcula taxa (CPU% por task, busy%, fps) e
// o consumidor, por delta entre duas fotos; o device nao guarda janela.
//
// Este cabecalho e host-compilavel (sem depends de ESP-IDF): toJson() e pura
// e rodava nos testes C++ do host (test/cpp). A coleta em si (take) e os
// contadores vivem no DeviceStats.cpp do firmware.
namespace DeviceStats {

// == configMAX_TASK_NAME_LEN do sdkconfig (16, default do IDF); o .cpp
// trava com static_assert se um dia mudar.
constexpr size_t kTaskNameLen = 16;
constexpr size_t kMaxTasks = 32;

struct TaskInfo {
    char name[kTaskNameLen + 1];
    char state;          // R rodando | r pronta | B bloqueada | S suspensa | D morta
    uint8_t prio;
    uint32_t stackFree;  // watermark em bytes: o minimo que ja ficou livre
    uint64_t runTimeUs;  // tempo acumulado no CPUs (clock esp_timer)
};

struct Snapshot {
    // heap 8-bit geral (mesmo recorte do "free" do shell: inclui PSRAM) e interna
    uint32_t heapFree, heapMin, heapLargest;
    uint32_t intFree, intMin, intLargest;
    // RAM interna no limite (MemWatch): espelho do ultimo classify(). O
    // celerctl mostra "RAM INTERNA BAIXA" sem outra consulta.
    bool memLow;
    uint32_t psramFree, psramTotal, psramMin, psramLargest;
    // app JS corrente: consumo = launchFree - nowFree (mesma semantica do
    // System.getInfo().appRAM); alocacoes Duktape VIVAS (contagem, nao bytes —
    // o my_realloc nao conhece o tamanho antigo e header por bloco num heap
    // base de ~8KB esta fora de questao)
    bool jsActive;
    uint32_t jsLaunchFree, jsNowFree;
    uint32_t jsAllocs, jsAllocsPeak;
    // carga (cumulativos): celerLoop do SO/launcher (congela com app aberto —
    // ai quem bombeia e o present()) e o present() dos apps
    uint64_t loopBusyUs, loopTotalUs;
    uint64_t uiFrames, uiPresents, uiFrameUs, uiFrameUsMax;
    // Quadro da UI NATIVA (Canvas::render: launcher, paineis, teclado),
    // separado do present() dos apps: compor = fill + draw(); push = entrega
    // ao vidro. No 4848 o push e uma copia PSRAM->PSRAM do framebuffer RGB
    // (460 KB) que divide banda com o DMA do painel — esta medida existe
    // para enxergar esse custo, que o present dos apps nao mostra.
    uint64_t kuiPresents, kuiComposeUs, kuiPushUs, kuiMaxUs;
    uint64_t kuiPartial, kuiFull;  // quadros parciais (arrasto) x completos
    uint64_t kuiPartComposeUs, kuiPartPushUs;  // custo SOMENTE dos parciais
    uint64_t uptimeUs;
    uint32_t cpuFreqMHz;
    uint32_t taskCount;
    uint64_t totalRunTimeUs;
    bool truncated;  // lista de tasks cortada no kMaxTasks
    // svchost de servicos (API 42): contadores CUMULATIVOS do pump, medios
    // via noteSvcTick() — o INCREMENTO vive no AppServices::tick (fim do
    // giro: busy = millis() - t0, orcamento = kTickBudgetMs). O estado do
    // heap e a contagem de servicos NAO vao aqui: a foto fresca e do
    // AppServices::info(), e o shell/celerctl combina os dois.
    uint32_t svcTicks;      // giros do pump do svchost
    uint32_t svcOverruns;   // giros que estouraram o orcamento de ms
    uint32_t svcBusyMsMax;  // pior giro ja visto (ms)
    uint32_t svcBusyMsSum;  // ms somados (media = sum/ticks no consumidor)
    TaskInfo tasks[kMaxTasks];
};

// Serializa a foto em JSON compacto (uma resposta KL_STATS inteira cabe num
// frame: ~45 tasks * ~50B). Devolve os bytes escritos (sem o NUL); 0 se nao
// coube. Tasks vao por ultimo: cap curto corta a lista e acenda "trunc":1.
size_t toJson(const Snapshot& s, char* buf, size_t cap);

// Coleta uma foto completa (false so se faltar RAM para a tabela de tasks).
// Implementado no .cpp do firmware (depends de ESP-IDF).
bool take(Snapshot& out);

// Instrumentacao viva (todas thread-safe, atomics relaxed no .cpp):
// alocacoes Duktape vivas (my_alloc/my_free/my_realloc do CelerKernel),
// iteracao do celerLoop (busy = sem o delay) e cada present() dos apps
// (pushedFrame = quadro que efetivamente foi ao vidro).
void noteJsAlloc();
void noteJsFree();
void noteLoopIter(uint32_t busyUs, uint32_t totalUs);
void notePresent(uint32_t us, bool pushedFrame);
// Um quadro da UI nativa (Canvas::render/renderRegion). composeUs = montagem
// no buffer, pushUs = copia ao vidro (0 no modo Direct, que desenha direto no
// alvo). fullFrame = composicao do quadro inteiro (false = passada parcial do
// arrasto, que compoe/empurra so a faixa que mudou).
void noteKuiFrame(uint32_t composeUs, uint32_t pushUs, bool fullFrame);
// Um giro do pump do svchost (AppServices::tick): busyMs = ms do giro,
// budgetMs = orcamento (kTickBudgetMs) — acima dele conta overrun.
void noteSvcTick(uint32_t busyMs, uint32_t budgetMs);

// Nivel de RAM interna do MemWatch (transicao Ok<->Low). O snapshot le o
// ultimo valor; toJson publica heap.low.
void noteMemLevel(bool low);

}  // namespace DeviceStats

// ---- implementacao inline (host-testavel) ----
#ifdef __cplusplus

#include <stdarg.h>
#include <stdio.h>

namespace DeviceStats {

namespace detail {

// Append com vsnprintf sobre o espaco restante; ovf congela o buffer.
struct JsonBuf {
    char* p;
    size_t left;
    bool ovf;
    explicit JsonBuf(char* b, size_t c) : p(b), left(c), ovf(c == 0) {}
    void add(const char* fmt, ...) {
        if (ovf) return;
        va_list ap;
        va_start(ap, fmt);
        int w = vsnprintf(p, left, fmt, ap);
        va_end(ap);
        if (w < 0 || (size_t)w >= left) {
            ovf = true;
            return;
        }
        p += w;
        left -= (size_t)w;
    }
};

}  // namespace detail

inline size_t toJson(const Snapshot& s, char* buf, size_t cap) {
    if (cap < 32) return 0;  // nem o esqueleto minimo caberia
    detail::JsonBuf j(buf, cap);
    j.add("{\"uptime_us\":%llu,\"cpu_mhz\":%u,"
          "\"heap\":{\"free\":%u,\"min\":%u,\"largest\":%u,"
          "\"int_free\":%u,\"int_min\":%u,\"int_largest\":%u,\"low\":%d,"
          "\"psram_free\":%u,\"psram_total\":%u,\"psram_min\":%u,\"psram_largest\":%u},"
          "\"js\":{\"active\":%d,\"launch_free\":%u,\"now_free\":%u,"
          "\"allocs\":%u,\"allocs_peak\":%u},"
          "\"loop\":{\"busy_us\":%llu,\"total_us\":%llu},"
          "\"ui\":{\"frames\":%llu,\"presents\":%llu,\"us\":%llu,\"us_max\":%llu},"
          "\"kui\":{\"presents\":%llu,\"compose_us\":%llu,\"push_us\":%llu,\"us_max\":%llu,"
          "\"partial\":%llu,\"full\":%llu,\"pcompose_us\":%llu,\"ppush_us\":%llu},",
          (unsigned long long)s.uptimeUs, (unsigned)s.cpuFreqMHz,
          s.heapFree, s.heapMin, s.heapLargest,
          s.intFree, s.intMin, s.intLargest, s.memLow ? 1 : 0,
          s.psramFree, s.psramTotal, s.psramMin, s.psramLargest,
          s.jsActive ? 1 : 0, s.jsLaunchFree, s.jsNowFree, s.jsAllocs, s.jsAllocsPeak,
          (unsigned long long)s.loopBusyUs, (unsigned long long)s.loopTotalUs,
          (unsigned long long)s.uiFrames, (unsigned long long)s.uiPresents,
          (unsigned long long)s.uiFrameUs, (unsigned long long)s.uiFrameUsMax,
          (unsigned long long)s.kuiPresents, (unsigned long long)s.kuiComposeUs,
          (unsigned long long)s.kuiPushUs, (unsigned long long)s.kuiMaxUs,
          (unsigned long long)s.kuiPartial, (unsigned long long)s.kuiFull,
          (unsigned long long)s.kuiPartComposeUs, (unsigned long long)s.kuiPartPushUs);
    if (!j.ovf) {
        j.add("\"total_rt_us\":%llu,\"tasks\":[", (unsigned long long)s.totalRunTimeUs);
        bool truncated = s.truncated;
        for (uint32_t i = 0; !j.ovf && i < s.taskCount && i < kMaxTasks; i++) {
            const TaskInfo& t = s.tasks[i];
            // marca a ultima task COMPLETA: task parcial volta para tras
            char* mark = j.p;
            size_t markLeft = j.left;
            j.add("%s{\"n\":\"%s\",\"s\":\"%c\",\"p\":%u,\"stk\":%u,\"rt\":%llu}",
                  i == 0 ? "" : ",", t.name, t.state, (unsigned)t.prio,
                  t.stackFree, (unsigned long long)t.runTimeUs);
            if (j.ovf) {
                j.p = mark;
                j.left = markLeft;
                j.ovf = false;
                truncated = true;
                break;
            }
        }
        if (!j.ovf) {
            j.add("],\"trunc\":%d", truncated ? 1 : 0);
            if (!j.ovf) {
                // svchost (API 42): bloco final OPCIONAL antes da chave que
                // fecha — se nao couber, rollback (mesmo padrao das tasks) e
                // o JSON fecha sem ele (celerctl antigo segue parseando)
                char* mark = j.p;
                size_t markLeft = j.left;
                j.add(",\"svc\":{\"ticks\":%u,\"overruns\":%u,\"max_ms\":%u,\"sum_ms\":%u}",
                      s.svcTicks, s.svcOverruns, s.svcBusyMsMax, s.svcBusyMsSum);
                if (j.ovf) {
                    j.p = mark;
                    j.left = markLeft;
                    j.ovf = false;
                }
                j.add("}");
                if (!j.ovf) return (size_t)(j.p - buf);
            }
        }
    }
    // header inteiro ou fechamento nao couberam: esqueleto minimo valido
    int w = snprintf(buf, cap, "{\"uptime_us\":%llu,\"trunc\":1}",
                     (unsigned long long)s.uptimeUs);
    return (w > 0 && (size_t)w < cap) ? (size_t)w : 0;
}

}  // namespace DeviceStats

#endif  // __cplusplus

#endif  // CELER_DEVICESTATS_H
