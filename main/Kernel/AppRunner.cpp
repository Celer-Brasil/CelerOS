#include "AppRunner.h"

#ifdef CELEROS_APP_TASK

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_task_wdt.h"
#include "Core/CelerKernel.h"
#include "../../UI/Kui.h"
#include "../../USBDevice/LogSink.h"

namespace {

struct AppParams {
    std::string filePath;
    std::string title;
    bool topbarFixed;
    std::string appPkg;
    uint32_t perms = 0xFFFFFFFFu;
};

TaskHandle_t s_task = nullptr;
volatile bool s_running = false;
volatile bool s_wifiSetupRequested = false;

void appTask(void* raw) {
    AppParams* p = (AppParams*)raw;

    // mesma disciplina da main task: watchdog com panic (app travado
    // reinicia em ~15s — os pontos de espera ja alimentam o WDT)
    esp_task_wdt_add(nullptr);

    CelerKernel::runFile(p->filePath.c_str(), p->title.c_str(), p->topbarFixed,
                         p->appPkg.c_str(), p->perms);

    delete p;
    s_running = false;
    s_task = nullptr;
    vTaskDelete(nullptr);
}

}  // namespace

namespace AppRunner {

bool supported() { return true; }

bool start(const std::string& filePath, const std::string& title, bool topbarFixed,
                      const std::string& appPkg, uint32_t perms) {
    if (s_task != nullptr) return false;  // um app por vez

    AppParams* p = new AppParams{filePath, title, topbarFixed, appPkg, perms};
    if (xTaskCreatePinnedToCore(appTask, "celerapp", 32768, p, 1, &s_task, portNUM_PROCESSORS - 1) != pdPASS) {
        delete p;
        s_task = nullptr;
        return false;
    }
    s_running = true;

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
