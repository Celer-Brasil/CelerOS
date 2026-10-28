#include "WakeWord.h"
#include "sdkconfig.h"

#if CONFIG_CELEROS_WAKE_WORD

// Detector "Hi Celer" (microWakeWord, modelo proprio int8): duas etapas na
// task, ambas no chip —
//   1. frontend C++ (Wake/frontend, mesma pipeline do treino): audio mono
//      16 kHz -> 40 features a cada 10 ms (janela 30 ms);
//   2. TFLite Micro rodando o modelo streaming embutido
//      (Assets/Wake/HiCelerModel.h): invoke a cada 3 features (30 ms),
//      saida uint8 = probabilidade; deteccao quando a janela mobivel
//      fica acima do cutoff por N slices seguidos (semantica portada do
//      micro_wake_word do ESPHome, Apache-2.0).
//
// Sem particao de modelos nem libs pre-compiladas: o .tflite (~60 KB) vai
// no firmware como array C, a arena sai do heap (PSRAM-eligible).

#include "../Assets/Wake/HiCelerModel.h"
#include "../USBDevice/LogSink.h"
#include "tensorflow/lite/experimental/microfrontend/lib/frontend.h"
#include "tensorflow/lite/experimental/microfrontend/lib/frontend_util.h"
#include "BoardIO.h"
#include "AudioPlayer.h"  // active(): detector dorme enquanto o falante toca
#include "esp_log.h"
#include <math.h>
#include <new>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/idf_additions.h"  // xTaskCreatePinnedToCoreWithCaps
#include "esp_heap_caps.h"
#include "tensorflow/lite/core/c/common.h"
#include "tensorflow/lite/schema/schema_generated.h"  // tflite::GetModel
#include "tensorflow/lite/micro/micro_allocator.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/micro/micro_resource_variable.h"

// ---- constantes do frontend (batem com o treino microWakeWord/ESPHome) ----
namespace {
constexpr int kFeatureSize = 40;    // features por slice
constexpr int kWindowMs = 30;       // janela do frontend
constexpr int kStepMs = 10;         // passo entre slices
constexpr int kSampleRate = 16000;

// ---- deteccao (semantica do ESPHome streaming_model) ----
constexpr uint8_t kProbCutoff = 217;         // ~0.85: 0 falsos/h no ambiente do teste (v2)
constexpr int kSlidingWindow = 5;            // invokes na janela mobivel
constexpr int kSlicesAfterDetection = 100;   // ~1 s de refractario

constexpr size_t kTensorArena = 32 * 1024;   // probe manual se estourar
constexpr size_t kVarArena = 1024;           // resource variables do modelo

TaskHandle_t s_task = nullptr;
volatile bool s_stopReq = false;
volatile bool s_taskDone = false;  // laco da task terminou (o stop libera)
int s_readFails = 0;                // leituras do mic falhas seguidas (telemetria)
uint8_t s_maxProb = 0;              // maior probabilidade desde o ultimo batimento
volatile bool s_detected = false;
volatile int s_level = -1;

// runtime do modelo: arenas no heap e o interpreter construido SOBRE elas a
// cada start (placement new) e destruido no stop. Um interpreter `static`
// guardava a arena do 1o start, liberada pelo stop: o start seguinte (o app
// reaberto) escrevia em memoria solta
alignas(tflite::MicroInterpreter) uint8_t s_interpMem[sizeof(tflite::MicroInterpreter)];
tflite::MicroInterpreter* s_interp = nullptr;

void dropInterp() {
    if (s_interp != nullptr) s_interp->~MicroInterpreter();
    s_interp = nullptr;
}
uint8_t* s_arena = nullptr;
uint8_t* s_varArena = nullptr;

int s_strideStep = 0;             // features acumuladas no stride corrente
int s_lastN = 0;                  // indice na janela mobivel
uint8_t s_probs[kSlidingWindow];  // ultimas probabilidades
int s_ignoreWindows = -kSlicesAfterDetection;

// frontend (estado alocado internamente pelo FrontendPopulateState)
struct FrontendConfig s_feCfg;
struct FrontendState s_feState;
bool s_feInited = false;

bool registerOps(tflite::MicroMutableOpResolver<20>& r) {
    return r.AddCallOnce() == kTfLiteOk && r.AddVarHandle() == kTfLiteOk &&
           r.AddReshape() == kTfLiteOk && r.AddReadVariable() == kTfLiteOk &&
           r.AddStridedSlice() == kTfLiteOk && r.AddConcatenation() == kTfLiteOk &&
           r.AddAssignVariable() == kTfLiteOk && r.AddConv2D() == kTfLiteOk &&
           r.AddMul() == kTfLiteOk && r.AddAdd() == kTfLiteOk &&
           r.AddMean() == kTfLiteOk && r.AddFullyConnected() == kTfLiteOk &&
           r.AddLogistic() == kTfLiteOk && r.AddQuantize() == kTfLiteOk &&
           r.AddDepthwiseConv2D() == kTfLiteOk && r.AddAveragePool2D() == kTfLiteOk &&
           r.AddMaxPool2D() == kTfLiteOk && r.AddPad() == kTfLiteOk &&
           r.AddPack() == kTfLiteOk && r.AddSplitV() == kTfLiteOk;
}

void resetProbs() {
    for (int i = 0; i < kSlidingWindow; i++) s_probs[i] = 0;
    s_lastN = 0;
    s_ignoreWindows = -kSlicesAfterDetection;
    s_strideStep = 0;
}

// features -> tensor int8: escala historica do micro_speech (uint16 ~0..670
// -> float 0..26 -> int8), em inteiro (formula do ESPHome)
inline int8_t featToInt8(uint16_t v) {
    int32_t x = ((v * 256) + 333) / 666 + INT8_MIN;
    if (x < INT8_MIN) x = INT8_MIN;
    if (x > INT8_MAX) x = INT8_MAX;
    return (int8_t)x;
}

// um invoke do modelo streaming; true = deteccao
bool inferSlice(const int8_t feats[kFeatureSize]) {
    TfLiteTensor* in = s_interp->input(0);
    const int stride = in->dims->data[1];  // slices por invoke (3)
    s_strideStep %= stride;
    int8_t* dst = tflite::GetTensorData<int8_t>(in) + kFeatureSize * s_strideStep;
    memcpy(dst, feats, kFeatureSize);
    s_strideStep++;
    if (s_strideStep < stride) return false;
    if (s_interp->Invoke() != kTfLiteOk) {
        celer_log_printf("[wakeword] invoke falhou\n");
        resetProbs();
        return false;
    }
    const uint8_t prob = s_interp->output(0)->data.uint8[0];
    if (prob > s_maxProb) s_maxProb = prob;
    s_lastN = (s_lastN + 1) % kSlidingWindow;
    s_probs[s_lastN] = prob;
    if (prob < kProbCutoff && s_ignoreWindows < 0) s_ignoreWindows++;
    if (s_ignoreWindows < 0) return false;
    for (int i = 0; i < kSlidingWindow; i++) {
        if (s_probs[i] < kProbCutoff) return false;
    }
    resetProbs();
    return true;
}

void wakeTask(void*) {
    // Leituras de 32 ms alimentam o frontend; cada 10 ms de audio novo gera
    // um slice de 40 features (invoke a cada 3). O lock por leitura deixa o
    // gravador assumir o canal sem disputa; com gravacao em curso a task nem
    // le (o comando vale mais).
    int16_t buf[512];
    int8_t feats[kFeatureSize];
    int tele = 0;
    while (!s_stopReq) {
        if (BoardIO::micRecActive()) {
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }
        // Alto-falante tocando (wav/tom/fala do TTS): a task DORME em vez de
        // inferir — o cao nao precisa se ouvir e a CPU do slice de TFLite
        // fica livre para o feed do I2S (engasgo da voz, bancada 2026-10-05).
        // Sem desmontar nada: o modelo/task seguem de pe, resume no proximo
        // ciclo; o eco acustico da cauda e coberto pelo mute do app.
        if (AudioPlayer::active()) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        const int n = BoardIO::micReadMonoLocked(buf, 512);
        if (n <= 0) {
            // leitura falhando em sequencia: avisa com o motivo (1a vez e a
            // cada ~100) — sem isto o detector ficava surdo em silencio
            if (s_readFails++ % 100 == 0) {
                celer_log_printf("[wakeword] leitura do mic falhou (%d, x%d): %s\n", n, s_readFails,
                                 n == -2 ? "canal ocupado" : n == -3 ? "canal nao subiu"
                                 : n == -4 ? "timeout (sem clock?)" : "erro i2s");
            }
            // leitura falhou (canal ocupado/erro): da passagem de CPU — sem
            // isso um erro instantaneo vira spin que mata o app por prioridade
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        s_readFails = 0;
        s_level = BoardIO::rmsLevel100(buf, n, 1, 0);  // mesma escala do micLevel

        // consome o bloco: cada chamada le ate fechar uma janela e diz quantas
        // amostras usou (o laco antigo repassava o MESMO bloco e nunca saia)
        const int16_t* p = buf;
        size_t left = (size_t)n;
        while (left > 0) {
            size_t used = 0;
            struct FrontendOutput out = FrontendProcessSamples(&s_feState, p, left, &used);
            if (used == 0 || used > left) break;  // defensivo: sem progresso
            p += used;
            left -= used;
            if (out.size == 0) continue;
            for (int i = 0; i < kFeatureSize && i < (int)out.size; i++)
                feats[i] = featToInt8(out.values[i]);
            if (inferSlice(feats)) {
                s_detected = true;
                celer_log_printf("[wakeword] Hi Celer detectado\n");
            }
        }
        if (++tele % 300 == 0) {  // batimento no logcat (~10 s)
            // max = maior probabilidade do modelo na janela (0..255; dispara
            // com kProbCutoff por kSlidingWindow invokes seguidos)
            celer_log_printf("[wakeword] vivo lvl=%d max=%u\n", s_level, (unsigned)s_maxProb);
            s_maxProb = 0;
        }
        // Cede a CPU todo ciclo: leitura que volta na hora (backlog do DMA,
        // I2S mal configurado) + invoke do modelo viravam um laco sem
        // bloqueio que, acima da prioridade da main, matava IDLE/main de
        // fome -> TWDT -> reboot em loop (Dog Face nunca subia, servos sem
        // torque). O DMA do I2S segura o audio desse tick.
        vTaskDelay(1);
    }
    s_level = -1;
    // stack na PSRAM (WithCaps): a task nao se autodeleta — avisa e espera
    // o stop() liberar com vTaskDeleteWithCaps
    s_taskDone = true;
    vTaskSuspend(nullptr);
}

}  // namespace

namespace WakeWord {

bool start() {
    celer_log_printf("[wakeword] start (task=%p modelo=%u B)\n", (void*)s_task, (unsigned)kHiCelerModelLen);
    if (s_task != nullptr) return true;
    if (kHiCelerModelLen == 0) {
        celer_log_printf("[wakeword] ERRO modelo hi celer ausente (placeholder) — rode o treino\n");
        return false;
    }
    if (!BoardIO::micEnsureChannel()) {
        celer_log_printf("[wakeword] ERRO canal I2S do mic indisponivel (ver [mic] no logcat)\n");
        return false;
    }

    // frontend: 40 features, janela 30 ms, passo 10 ms, PCAN/noise-reduction
    // (constantes do treino microWakeWord — ver preprocessor_settings ESPHome)
    FrontendFillConfigWithDefaults(&s_feCfg);
    s_feCfg.window.size_ms = kWindowMs;
    s_feCfg.window.step_size_ms = kStepMs;
    s_feCfg.filterbank.num_channels = kFeatureSize;
    s_feCfg.filterbank.lower_band_limit = 125.0f;
    s_feCfg.filterbank.upper_band_limit = 7500.0f;
    s_feCfg.noise_reduction.smoothing_bits = 10;
    s_feCfg.noise_reduction.even_smoothing = 0.025f;
    s_feCfg.noise_reduction.odd_smoothing = 0.06f;
    s_feCfg.noise_reduction.min_signal_remaining = 0.05f;
    s_feCfg.pcan_gain_control.enable_pcan = true;
    s_feCfg.pcan_gain_control.strength = 0.95f;
    s_feCfg.pcan_gain_control.offset = 80.0f;
    s_feCfg.pcan_gain_control.gain_bits = 21;
    s_feCfg.log_scale.enable_log = true;
    s_feCfg.log_scale.scale_shift = 6;
    if (!FrontendPopulateState(&s_feCfg, &s_feState, kSampleRate)) {
        celer_log_printf("[wakeword] ERRO frontend nao alocou (RAM?)\n");
        return false;
    }
    s_feInited = true;

    // ops do streaming: registrados UMA vez (re-registrar e erro no TFLM —
    // o 2o start falhava aqui e o wake word morria ao reabrir o app)
    static tflite::MicroMutableOpResolver<20> resolver;
    static bool opsOk = registerOps(resolver);
    if (!opsOk) {
        celer_log_printf("[wakeword] ERRO op resolver falhou\n");
        FrontendFreeStateContents(&s_feState);
        s_feInited = false;
        return false;
    }
    // arenas na PSRAM: a de variaveis (1 KB) caia na RAM interna pelo
    // SPIRAM_MALLOC_ALWAYSINTERNAL — a interna e o recurso escasso do cao
    s_varArena = (uint8_t*)heap_caps_malloc(kVarArena, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_varArena == nullptr) s_varArena = (uint8_t*)malloc(kVarArena);
    s_arena = (uint8_t*)heap_caps_malloc(kTensorArena, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_arena == nullptr) s_arena = (uint8_t*)malloc(kTensorArena);
    auto falhaArena = [&]() {
        free(s_arena);
        free(s_varArena);
        s_arena = s_varArena = nullptr;
        FrontendFreeStateContents(&s_feState);
        s_feInited = false;
    };
    if (s_arena == nullptr || s_varArena == nullptr) {
        celer_log_printf("[wakeword] ERRO arena nao alocou (%d KB)\n", (int)kTensorArena / 1024);
        falhaArena();
        return false;
    }
    auto* ma = tflite::MicroAllocator::Create(s_varArena, kVarArena);
    auto* resVars = tflite::MicroResourceVariables::Create(ma, 20);
    s_interp = new (s_interpMem) tflite::MicroInterpreter(tflite::GetModel(kHiCelerModel), resolver,
                                                          s_arena, kTensorArena, resVars);
    if (s_interp->AllocateTensors() != kTfLiteOk) {
        celer_log_printf("[wakeword] ERRO allocateTensors falhou (arena %d KB pequena?)\n",
                 (int)kTensorArena / 1024);
        dropInterp();
        falhaArena();
        return false;
    }
    const TfLiteTensor* in = s_interp->input(0);
    // data[1] (slices por invoke) tambem entra na validacao: o inferSlice faz
    // `s_strideStep %= data[1]` — 0 aqui e divisao por zero na 1a fatia de
    // audio (modelo quebrado/placeholder derrubava a task e o aparelho).
    if (in->dims->size != 3 || in->dims->data[0] != 1 || in->dims->data[1] < 1 ||
        in->dims->data[2] != kFeatureSize || in->type != kTfLiteInt8) {
        celer_log_printf("[wakeword] ERRO tensor de entrada inesperado\n");
        dropInterp();
        falhaArena();
        return false;
    }

    resetProbs();
    s_detected = false;
    s_stopReq = false;
    s_level = -1;
    // ultimo core (convencao do repo: portNUM_PROCESSORS - 1): a inferencia
    // pesa e nao pode disputar o core da main/UI
    // Stack de 8 KB na PSRAM: com Celer Link + DMA do mic a RAM interna nao
    // tem bloco de 8 KB e a criacao falhava calada (wake word "indisponivel"
    // so com a Dog Face, que liga o link). A task nao toca a flash.
    s_taskDone = false;
    if (xTaskCreatePinnedToCoreWithCaps(wakeTask, "wakeword", 8192, nullptr, 3, &s_task,
                                        portNUM_PROCESSORS - 1,
                                        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdPASS) {
        celer_log_printf("[wakeword] ERRO task nao criada (stack 8 KB)\n");
        dropInterp();
        falhaArena();
        s_task = nullptr;
        return false;
    }
    ESP_LOGI("celer.wake", "Hi Celer ativo: modelo %d B, arena %d KB, stride %d",
             (int)kHiCelerModelLen, (int)kTensorArena / 1024, in->dims->data[1]);
    return true;
}

void stop() {
    if (s_task != nullptr) {
        s_stopReq = true;
        while (!s_taskDone) vTaskDelay(pdMS_TO_TICKS(5));
        vTaskDeleteWithCaps(s_task);
        s_task = nullptr;
    }
    dropInterp();
    free(s_arena);
    free(s_varArena);
    s_arena = s_varArena = nullptr;
    if (s_feInited) FrontendFreeStateContents(&s_feState);
    s_feInited = false;
    s_detected = false;
}

bool running() { return s_task != nullptr; }

bool poll() {
    if (!s_detected) return false;
    s_detected = false;
    return true;
}

int level() { return s_level; }

}  // namespace WakeWord

#endif  // CONFIG_CELEROS_WAKE_WORD
