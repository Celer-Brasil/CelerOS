#include "AppRunner.h"

#ifdef CELEROS_APP_TASK

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_task_wdt.h"
#include "Core/CelerKernel.h"
#include "../../UI/Kui.h"
#include "../../USBDevice/LogSink.h"
#include "../../USBDevice/LogPersist.h"
#include <cstdio>

namespace {

struct AppParams {
    std::string filePath;
    std::string title;
    bool topbarFixed;
    std::string appPkg;
    uint32_t perms = 0xFFFFFFFFu;
};

volatile bool s_running = false;
volatile bool s_wifiSetupRequested = false;

void appTask(void* raw) {
    AppParams* p = (AppParams*)raw;

    // mesma disciplina da main task: watchdog com panic (app travado
    // reinicia em ~15s — os pontos de espera ja alimentam o WDT)
    esp_task_wdt_add(nullptr);

    CelerKernel::runFile(p->filePath.c_str(), p->title.c_str(), p->topbarFixed,
                         p->appPkg.c_str(), p->perms);

    // Sobra de stack da task do app (palavras de 4B), junto da linha de
    // sessao que o runFile emite. O caminho sincrono roda na task do
    // launcher — la nao existe "HWM do app" para reportar.
    {
        char msg[48];
        snprintf(msg, sizeof(msg), "sessao: hwm da task = %u words",
                 (unsigned)uxTaskGetStackHighWaterMark(nullptr));
        LogPersist::app(p->appPkg.c_str(), msg);
    }

    // Desinscreve ANTES do vTaskDelete: no IDF 6.x o TWDT nao tem hook de
    // exclusao — entry pendurada apontava para um TCB ja livre (o idle
    // desaloca) e o proximo timeout do WDT andava em memoria morta.
    esp_task_wdt_delete(nullptr);

    delete p;
    // Ordem importa: s_running e o UNICO estado compartilhado escrito aqui
    // (o handle da task nao e guardado — so start() o via, na criacao).
    // Depois deste ponto a task nao toca nada compartilhado, so vTaskDelete.
    s_running = false;
    vTaskDelete(nullptr);
}

}  // namespace

namespace AppRunner {

bool supported() { return true; }

bool start(const std::string& filePath, const std::string& title, bool topbarFixed,
                      const std::string& appPkg, uint32_t perms) {
    if (s_running) return false;  // um app por vez

    // Reclama ANTES do xTaskCreate: se o app terminar antes do retorno da
    // criacao (a task ja roda na outra core), um "s_running = true" tardio
    // deixava a UI esperando para sempre com o input suspenso. O handle da
    // task nao e guardado: com a task podendo terminar antes do retorno de
    // xTaskCreate, escrever nele apos o fim era escrever em task morta.
    s_running = true;
    AppParams* p = new AppParams{filePath, title, topbarFixed, appPkg, perms};
    if (xTaskCreatePinnedToCore(appTask, "celerapp", 32768, p, 1, nullptr, portNUM_PROCESSORS - 1) != pdPASS) {
        delete p;
        s_running = false;
        return false;
    }

    // O app e dono do touch (le o I2C em System.getTouch) e do vidro
    // (present/drawString): a UI da main task pausa o pump e o redraw.
#if CONFIG_CELEROS_UI
    kui::Navigator::setInputSuspended(true);
#endif
    celer_log_println("app iniciado em task propria (celerapp)");
    return true;
}

bool running() { return s_running; }

void requestWifiSetup() { s_wifiSetupRequested = true; }

bool consumeWifiSetupRequest() {
    if (!s_wifiSetupRequested) return false;
    s_wifiSetupRequested = false;
    return true;
}

}  // namespace AppRunner

#else  // caminho sincrono: stubs, o AppHostScreen nem tenta

namespace AppRunner {

bool supported() { return false; }
bool start(const std::string&, const std::string&, bool, const std::string&, uint32_t) { return false; }
bool running() { return false; }
void requestWifiSetup() {}
bool consumeWifiSetupRequest() { return false; }

}  // namespace AppRunner

#endif
