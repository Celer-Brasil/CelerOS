// Servico de movimento do watch (F2): task propria lendo o QMI8658 a ~30 Hz,
// alimentando pedometro e detector de "levantar o pulso" — portas fieis do
// firmware Rust (waveshare-watch-rs): Pedometer de crates/watch-sdk/src/
// fitness.rs e RaiseDetector de src/peripherals/imu.rs.
//
// Compilado so para a board waveshare-watch (main/CMakeLists.txt); a face
// generica do CelerOS ve o servico pelos hooks do BoardProfile (raisePoll).
// Passos persistem no NVS (CelerSettings) a cada 20 e rolam no dia novo.

#include "Boards/Board.h"
#include "Qmi8658.h"
#include "Motion.h"

#include "../../Utils/CelerSettings.h"
#include "../../Kernel/TimeManager.h"
#include "../../Display/ScreenPower.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

namespace Motion {

// ---- Pedometer (porte do fitness.rs; unidades em g) ------------------------
// Pico/vale sobre a aceleracao DINAMICA (magnitude - gravidade via LP de 1
// polo). Warm-up de 10 amostras com LP mais rapido estabiliza a linha de base.
namespace {
constexpr float kPeakMinG = 0.20f;   // pico minimo (g)
constexpr float kPeakMaxG = 2.20f;   // pico maximo (rejeita spike/tranco)
constexpr uint32_t kMinStepMs = 280; // cadencia minima entre passos
constexpr int kPedoWarm = 10;

struct Pedometer {
    float lp = 1.0f;        // linha de base (gravidade ~1g)
    float prev = 0.0f;      // hp anterior
    float peak = 0.0f;
    bool rising = false;
    int warm = 0;
    uint32_t sinceMs = 0;

    bool feed(float ax, float ay, float az, uint32_t dtMs) {
        float mag = sqrtf(ax * ax + ay * ay + az * az);
        uint32_t dt = dtMs < 1 ? 1 : (dtMs > 250 ? 250 : dtMs);
        sinceMs += dt;
        if (warm < kPedoWarm) {
            lp = (warm == 0) ? mag : lp * 0.6f + mag * 0.4f;
            prev = 0.0f;
            warm++;
            return false;
        }
        lp = lp * 0.90f + mag * 0.10f;
        float hp = mag - lp;
        bool step = false;
        if (hp >= prev) {
            if (!rising) { rising = true; peak = hp; }
            else if (hp > peak) peak = hp;
        } else if (rising) {  // fim da subida = pico
            rising = false;
            if (peak >= kPeakMinG && peak <= kPeakMaxG && sinceMs >= kMinStepMs) {
                step = true;
                sinceMs = 0;
            }
            peak = 0.0f;
        }
        prev = hp;
        return step;
    }
};

// ---- RaiseDetector (porte do imu.rs) ---------------------------------------
// Filtro de 2 amostras: |az| baixo (punho caido) numa amostra -> |az| alto
// (face pra cima) na seguinte, com |ax|+|ay| pequeno (recusa twist). O
// cooldown de 4 amostras evita retrigger no balanco do gesto.
struct RaiseDetector {
    float lastZ = 0.0f;
    bool have = false;
    int cool = 0;

    bool feed(float ax, float ay, float az, int sens) {
        float z = fabsf(az);
        float xy = fabsf(ax) + fabsf(ay);
        if (cool > 0) { cool--; lastZ = z; have = true; return false; }
        float down, up, xyMax;
        if (sens == 0)      { down = 0.22f; up = 0.88f; xyMax = 0.55f; }
        else if (sens == 2) { down = 0.48f; up = 0.58f; xyMax = 1.10f; }
        else                { down = 0.35f; up = 0.70f; xyMax = 0.80f; }
        bool hit = have && lastZ < down && z > up && xy < xyMax;
        lastZ = z;
        have = true;
        if (hit) cool = 4;
        return hit;
    }
};

// ---- estado do servico ------------------------------------------------------
Pedometer s_pedo;
RaiseDetector s_raise;
portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
volatile bool s_raisePending = false;  // consumido pelo raisePoll()
TaskHandle_t s_task = nullptr;
int32_t s_steps = 0;
int32_t s_dayKey = 0;      // yyyymmdd do acumulo corrente (roll diario)
int32_t s_pendingPersist = 0;
int s_raiseSens = 1;
int s_raiseCount = 0;
float s_ax = 0, s_ay = 0, s_az = 1;   // ultima amostra (cache p/ Sensors JS)
volatile bool s_imuOk = false;
// I2C do IMU: a task e o Sensors.temp (task do app) nao podem intercalar
// transacoes no meio de um lote da FIFO (REQ_FIFO -> leitura -> saida)
SemaphoreHandle_t s_imuLock = nullptr;

struct ImuLock {
    ImuLock() { if (s_imuLock) xSemaphoreTake(s_imuLock, portMAX_DELAY); }
    ~ImuLock() { if (s_imuLock) xSemaphoreGive(s_imuLock); }
};

// FIFO com a tela apagada/AOD: a task acordava a CPU 30x/s (2 transacoes
// I2C por amostra) inclusive dormindo; em lotes acorda 5x/s. O primeiro uso
// e autotestado contra a leitura direta: FIFO que nao confere vira polling
// de sempre (o watch nunca perde passos/raise por causa disto).
enum class Fifo { Unknown, Ok, Broken };
Fifo s_fifo = Fifo::Unknown;
constexpr uint32_t kBatchMs = 200;   // lote com a tela apagada (+<=200ms no raise)
constexpr uint32_t kSampleMs = 33;   // ODR de 30,12 Hz

int32_t dayKey() {
    return TimeManager::getYear() * 10000 + TimeManager::getMonth() * 100 + TimeManager::getDay();
}

void persist() {
    char v[16];
    snprintf(v, sizeof(v), "%ld", (long)s_steps);
    CelerSettings::set("steps", v);
    snprintf(v, sizeof(v), "%ld", (long)s_dayKey);
    CelerSettings::set("steps_day", v);
    s_pendingPersist = 0;
}

// Historico diario (Sensors.stepHistory, API 15): ate HIST_MAX dias
// fechados em "steps_hist" = "yyyymmdd:n,yyyymmdd:n,..." (mais recente 1o).
constexpr int HIST_MAX = 7;

void pushHistory(int32_t day, int32_t n) {
    if (day <= 0) return;
    std::string cur = CelerSettings::get("steps_hist", "");
    char head[24];
    snprintf(head, sizeof(head), "%ld:%ld", (long)day, (long)n);
    std::string out = head;
    int kept = 1;
    size_t p = 0;
    while (p < cur.size() && kept < HIST_MAX) {
        size_t c = cur.find(',', p);
        if (c == std::string::npos) c = cur.size();
        if (c > p) {
            out += ',';
            out.append(cur, p, c - p);
            kept++;
        }
        p = c + 1;
    }
    // 7 x ~15 = ~105 B: exige o teto de 160 B do CelerSettings (o antigo,
    // 63 B, recusava a gravacao a partir do 4o dia sem avisar).
    CelerSettings::set("steps_hist", out.c_str());
}

// Virada do dia: fecha o acumulado no historico e zera a contagem.
void rollDay(int32_t today) {
    pushHistory(s_dayKey, s_steps);
    portENTER_CRITICAL(&s_mux);
    s_steps = 0;
    portEXIT_CRITICAL(&s_mux);
    s_dayKey = today;
    persist();
    ESP_LOGI("celer.imu", "dia novo (%ld): passos zerados", (long)today);
}

void load() {
    // Chamado pela task depois de ~3 s (FS/NVS ja montados no boot).
    std::string sens = CelerSettings::get("raise_sens", "1");
    s_raiseSens = atoi(sens.c_str());
    if (s_raiseSens < 0 || s_raiseSens > 2) s_raiseSens = 1;
    std::string d = CelerSettings::get("steps_day", "");
    if (!d.empty()) s_dayKey = atol(d.c_str());
    std::string s = CelerSettings::get("steps", "");
    const int32_t savedSteps = s.empty() ? 0 : atol(s.c_str());
    // Sem hora valida (RTC zerado/NTP ainda nao): dayKey() vira 1970 e a
    // comparacao abaixo apagava o acumulado do dia salvo. Mantem o dia e os
    // passos; a virada acontece quando o relogio valer (loop de 10 s).
    if (!TimeManager::isTimeValid()) {
        s_steps = savedSteps;
        return;
    }
    int32_t today = dayKey();
    if (s_dayKey != today) {
        if (s_dayKey == 0) {
            // primeiro dia com hora: adota o dia sem zerar o que ja andou
            s_dayKey = today;
            s_steps = savedSteps;
            persist();
            return;
        }
        // dia novo: fecha o anterior e recomeca
        pushHistory(s_dayKey, savedSteps);
        s_dayKey = today;
        s_steps = 0;
        persist();
        return;
    }
    s_steps = savedSteps;
}

void motionTask(void*) {
    ESP_LOGI("celer.imu", "task de movimento no ar (espera FS 3 s)");
    // Espera o boot assentar (FS/NVS): Board::init roda antes do FileSystem.
    vTaskDelay(pdMS_TO_TICKS(3000));
    load();
    ESP_LOGI("celer.imu", "estado carregado (passos %ld, dia %ld)",
             (long)s_steps, (long)s_dayKey);

    if (!Qmi8658::init()) {
        ESP_LOGE("celer.imu", "servico de movimento sem IMU");
        s_task = nullptr;
        vTaskDelete(nullptr);
        return;
    }
    Qmi8658::idleAccel30Hz(0x10);  // threshold medio
    if (!Qmi8658::fifoStart()) {
        s_fifo = Fifo::Broken;
        ESP_LOGW("celer.imu", "FIFO nao respondeu ao CTRL9: polling a 30 Hz");
    }
    ESP_LOGI("celer.imu", "QMI8658 ativo (30 Hz, pedo+raise sens=%d)", s_raiseSens);
    portENTER_CRITICAL(&s_mux);
    s_imuOk = true;
    portEXIT_CRITICAL(&s_mux);

    int32_t lastLoggedMilestone = (s_steps / 500) * 500;
    uint32_t dayCheckMs = 0;
    bool batching = false;
    int fifoChecks = 0, fifoEmpty = 0;

    // Uma amostra (de onde vier) passa pelo cache, pedometro e raise
    auto consume = [&](float ax, float ay, float az, uint32_t dtMs) {
        portENTER_CRITICAL(&s_mux);
        s_ax = ax; s_ay = ay; s_az = az;
        portEXIT_CRITICAL(&s_mux);

        if (s_pedo.feed(ax, ay, az, dtMs)) {
            portENTER_CRITICAL(&s_mux);
            s_steps++;
            portEXIT_CRITICAL(&s_mux);
            if (++s_pendingPersist >= 20) persist();
            if (s_steps - lastLoggedMilestone >= 500) {
                lastLoggedMilestone = (s_steps / 500) * 500;
                ESP_LOGI("celer.imu", "passos: %ld", (long)s_steps);
            }
        }

        if (s_raise.feed(ax, ay, az, s_raiseSens)) {
            portENTER_CRITICAL(&s_mux);
            s_raisePending = true;
            portEXIT_CRITICAL(&s_mux);
            s_raiseCount++;
            if (s_raiseCount <= 3 || (s_raiseCount % 10) == 0) {
                ESP_LOGI("celer.imu", "raise detectado (#%d)", s_raiseCount);
            }
        }
    };

    TickType_t last = xTaskGetTickCount();
    while (true) {
        // Tela acesa: polling direto (Sensors.accel e jogos querem a amostra
        // fresca). Apagada/AOD: lotes da FIFO, se ela passou no autoteste.
        const bool wantBatch = s_fifo != Fifo::Broken && ScreenPower::state() <= 1;
        vTaskDelay(pdMS_TO_TICKS(wantBatch ? kBatchMs : kSampleMs));
        if (!s_imuOk) {  // powerDown (pre-deep-sleep): nada de I2C em NACK
            vTaskDelay(pdMS_TO_TICKS(500));
            continue;
        }
        uint32_t dtMs = (uint32_t)(xTaskGetTickCount() - last) * portTICK_PERIOD_MS;
        last = xTaskGetTickCount();

        // Virada da meia-noite com o relogio ligado (antes so no boot)
        dayCheckMs += dtMs;
        if (dayCheckMs >= 10000) {
            dayCheckMs = 0;
            if (TimeManager::isTimeValid()) {
                const int32_t today = dayKey();
                if (today != s_dayKey) rollDay(today);
            }
            // sensibilidade do raise mudada no Settings vale sem reboot
            int sens = atoi(CelerSettings::get("raise_sens", "1").c_str());
            if (sens >= 0 && sens <= 2) s_raiseSens = sens;
        }

        if (wantBatch != batching) {
            ImuLock lk;
            if (wantBatch) {
                // entra em lote: so amostras novas (as antigas ja foram lidas)
                if (!Qmi8658::fifoReset()) s_fifo = Fifo::Broken;
            } else {
                // volta ao direto: o resto do lote ainda conta passos
                float buf[Qmi8658::kFifoMax][3];
                int n = Qmi8658::fifoReadAccelG(buf, Qmi8658::kFifoMax);
                for (int i = 0; i < n; i++) consume(buf[i][0], buf[i][1], buf[i][2], kSampleMs);
            }
            batching = wantBatch && s_fifo != Fifo::Broken;
            Qmi8658::clearMotionIrq();
            continue;
        }

        if (batching) {
            float buf[Qmi8658::kFifoMax][3];
            float dx = 0, dy = 0, dz = 0;
            int n;
            bool direct = false;
            {
                ImuLock lk;
                n = Qmi8658::fifoReadAccelG(buf, Qmi8658::kFifoMax);
                if (s_fifo == Fifo::Unknown && n > 0) direct = Qmi8658::readAccelG(&dx, &dy, &dz);
                Qmi8658::clearMotionIrq();
            }
            if (s_fifo == Fifo::Unknown) {
                // Autoteste: a ultima amostra do lote tem no maximo ~1 ODR a
                // mais que a leitura direta. Pulso parado confere de primeira;
                // em movimento, ate 8 tentativas. Vazia/erro 3x = quebrada.
                if (n > 0 && direct && fabsf(buf[n - 1][0] - dx) < 0.30f &&
                    fabsf(buf[n - 1][1] - dy) < 0.30f && fabsf(buf[n - 1][2] - dz) < 0.30f) {
                    s_fifo = Fifo::Ok;
                    ESP_LOGI("celer.imu", "FIFO conferida (%d amostras/lote)", n);
                } else if (n <= 0 ? ++fifoEmpty >= 3 : ++fifoChecks >= 8) {
                    s_fifo = Fifo::Broken;
                    batching = false;
                    ESP_LOGW("celer.imu", "FIFO nao conferiu (n=%d): polling a 30 Hz", n);
                    continue;
                }
            }
            for (int i = 0; i < n; i++) consume(buf[i][0], buf[i][1], buf[i][2], kSampleMs);
            continue;
        }

        float ax, ay, az;
        {
            ImuLock lk;
            if (!Qmi8658::readAccelG(&ax, &ay, &az)) continue;
            Qmi8658::clearMotionIrq();
        }
        consume(ax, ay, az, dtMs);
    }
}

}  // namespace

void start() {
    if (s_task != nullptr) return;
    if (s_imuLock == nullptr) s_imuLock = xSemaphoreCreateMutex();
    xTaskCreate(motionTask, "celerimu", 4096, nullptr, 2, &s_task);
}

bool raisePoll() {
    portENTER_CRITICAL(&s_mux);
    bool v = s_raisePending;
    s_raisePending = false;
    portEXIT_CRITICAL(&s_mux);
    return v;
}

int32_t steps() {
    portENTER_CRITICAL(&s_mux);
    int32_t v = s_steps;
    portEXIT_CRITICAL(&s_mux);
    return v;
}

int stepHistory(int32_t* days, int32_t* counts, int max) {
    std::string cur = CelerSettings::get("steps_hist", "");
    int n = 0;
    size_t p = 0;
    while (p < cur.size() && n < max) {
        size_t c = cur.find(',', p);
        if (c == std::string::npos) c = cur.size();
        std::string item = cur.substr(p, c - p);
        size_t sep = item.find(':');
        if (sep != std::string::npos) {
            days[n] = atol(item.c_str());
            counts[n] = atol(item.c_str() + sep + 1);
            n++;
        }
        p = c + 1;
    }
    return n;
}

bool accel(float* x, float* y, float* z) {
    portENTER_CRITICAL(&s_mux);
    bool ok = s_imuOk;
    *x = s_ax; *y = s_ay; *z = s_az;
    portEXIT_CRITICAL(&s_mux);
    return ok;
}

bool temp(float* c) {
    if (!s_imuOk) return false;
    ImuLock lk;
    return Qmi8658::readTemp(c);
}

void prepareSleep() {
    portENTER_CRITICAL(&s_mux);
    bool ok = s_imuOk;
    s_imuOk = false;
    portEXIT_CRITICAL(&s_mux);
    if (!ok) return;
    if (s_pendingPersist > 0) persist();
    ImuLock lk;
    if (CelerSettings::get("imu_wake", "") == "1") {
        // Wake por movimento: AnyMotion com threshold alto (so gesto firme)
        // na INT1 ativo-baixo; o ScreenPower soma o pino ao EXT1.
        Qmi8658::idleAccel30Hz(0x20);
        Qmi8658::clearMotionIrq();
        ESP_LOGI("celer.imu", "IMU em wake-on-motion p/ deep sleep (passos: %ld)", (long)s_steps);
        return;
    }
    Qmi8658::powerDown();
    ESP_LOGI("celer.imu", "IMU desligado p/ deep sleep (passos: %ld)", (long)s_steps);
}

}  // namespace Motion
