#include "Boards/Board.h"
#include "../../Hardware/BoardIO.h"

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <esp_intr_alloc.h>
#include <esp_log.h>
#include <soc/interrupts.h>
#include <soc/lcd_cam_struct.h>
#include <hal/lcd_hal.h>
#include <esp_lcd_io_i80.h>

// Perfil da Guition ESP32-S3-4848S040 (SmartDisplay 4").
//
// Material do fabricante (4.0inch_ESP32-4848S040): alto-falante via
// amplificador Nsiway NS4168 em I2S (DOUT=40, BCLK=1, LRC=2, sem MCLK). As
// SKUs "Y" (caixa 86 switch) usam os MESMOS pinos como linhas de rele
// L1/L2/L3 — CELEROS_SMARTDISPLAY_RELAYS troca o alto-falante por N reles.

#define CELEROS_STR2(x) #x
#define CELEROS_STR(x) CELEROS_STR2(x)

namespace {
BoardDisplay s_display;

// Init do display no NUCLEO 1. O Bus_RGB do LovyanGFX reinicia o DMA do
// painel na interrupcao de fim de VSYNC (prioridade 1, compartilhada), e o
// esp_intr_alloc liga a ISR ao nucleo de quem chama — era o 0, o mesmo da
// task principal (Duktape), do WiFi e do BT. Cada secao critica do
// heap_caps_malloc (o Duktape aloca/libera o tempo todo) atrasava o
// reinicio do quadro, e a 12 MHz de pclk 1 us de atraso = ~12 px: a imagem
// INTEIRA tremia so com app JS aberto, ate em menu parado (bancada
// 2026-10-09: zero underflow de DMA, zero quadro empurrado, e o vidro
// balancando). No nucleo 1 a ISR nao disputa com nada disso.
SemaphoreHandle_t s_initDone = nullptr;

// ISR do VSYNC em IRAM. O Bus_RGB aloca a dele SEM ESP_INTR_FLAG_IRAM (so o
// handler e IRAM_ATTR): durante QUALQUER operacao na flash (NVS, LittleFS,
// notifications.txt, OTA) o IDF desliga as interrupcoes nao-IRAM nos dois
// nucleos, o reinicio do DMA do quadro esperava o erase/escrita acabar e a
// imagem embaralhava a cada gravacao — sem underflow (o lcddma dava 0), o
// DMA so seguia fora de fase com o VSYNC (bancada 2026-10-11: app gravando
// NVS em loop = 1 embaralhada por escrita). O handler so toca registradores
// do LCD_CAM/GDMA e o proprio Bus_RGB (DRAM: s_display e estatico) — seguro
// com o cache desligado (conferido no objdump: nenhuma chamada para flash).
//
// O LovyanGFX e submodulo upstream (nao se edita): o handle e o handler sao
// privados, e o acesso vem do idioma de ponteiro-para-membro por
// instanciacao explicita de template (a regra de acesso nao vale nela).
template <typename Tag, typename Tag::type M>
struct PrivAccess {
    friend typename Tag::type privGet(Tag) { return M; }
};
struct BusIntrHandle {
    typedef intr_handle_t lgfx::Bus_RGB::*type;
    friend type privGet(BusIntrHandle);
};
struct BusIsrHandler {
    typedef void (*type)(void*);
    friend type privGet(BusIsrHandler);
};
struct BusI80 {
    typedef esp_lcd_i80_bus_handle_t lgfx::Bus_RGB::*type;
    friend type privGet(BusI80);
};
template struct PrivAccess<BusIntrHandle, &lgfx::Bus_RGB::_intr_handle>;
template struct PrivAccess<BusIsrHandler, &lgfx::Bus_RGB::lcd_default_isr_handler>;
template struct PrivAccess<BusI80, &lgfx::Bus_RGB::_i80_bus>;

// Prefixo do esp_lcd_i80_bus_t (esp_lcd/i80/esp_lcd_panel_io_i80.c, IDF
// v6.1 — struct privada do driver). O Bus_RGB cria um i80 bus so para ligar
// o clock do LCD_CAM e nunca cria device nele, mas o bus aloca a fonte
// LCD_CAM COMPARTILHADA e sem IRAM (o i80 do v6.1 nao tem opcao IRAM-safe):
// enquanto ela existir, nenhuma alocacao IRAM da mesma fonte e aceita. A
// interrupcao do bus so seria habilitada por um device (nunca ha), entao
// liberar a dela nao muda nada no driver. Conferir o layout ao trocar de IDF.
struct I80BusPrefix {
    int bus_id;
    portMUX_TYPE spinlock;
    lcd_hal_context_t hal;
    size_t bus_width;
    intr_handle_t intr;
};

void displayInitTask(void*) {
    s_display.init();
    xSemaphoreGive(s_initDone);
    vTaskDelete(nullptr);
}

void initDisplayOnCore1() {
#if !CONFIG_FREERTOS_UNICORE
    s_initDone = xSemaphoreCreateBinary();
    if (s_initDone != nullptr &&
        xTaskCreatePinnedToCore(displayInitTask, "lcdinit", 6144, nullptr, 5, nullptr, 1) == pdPASS) {
        xSemaphoreTake(s_initDone, portMAX_DELAY);
        vSemaphoreDelete(s_initDone);
        s_initDone = nullptr;
        return;
    }
    if (s_initDone != nullptr) {
        vSemaphoreDelete(s_initDone);
        s_initDone = nullptr;
    }
#endif
    s_display.init();  // fallback: sem task, no nucleo atual
}
}  // namespace

bool CelerBusRGB::init(void) {
    if (_ready) return true;  // 2a chamada (Panel_Device::init): ja configurado
    if (!lgfx::Bus_RGB::init()) return false;
    _ready = true;
    lgfx::Bus_RGB* self = this;
    intr_handle_t& h = self->*privGet(BusIntrHandle());
    if (h == nullptr) return true;
    esp_intr_free(h);
    h = nullptr;
    esp_lcd_i80_bus_handle_t i80 = self->*privGet(BusI80());
    if (i80 != nullptr) {
        I80BusPrefix* b = reinterpret_cast<I80BusPrefix*>(i80);
        // sanidade do layout: bus 0 e o hal apontando para o LCD_CAM
        if (b->bus_id == 0 && b->hal.dev == &LCD_CAM && b->intr != nullptr) {
            esp_intr_free(b->intr);
            b->intr = nullptr;
        } else {
            ESP_LOGW("board", "i80 bus com layout inesperado: ISR do painel fica sem IRAM");
        }
    }
    // nivel 3 primeiro (acima das ISRs nivel 1 do nucleo 1, ex.: I2C do
    // touch, que dividia a linha com ela); sem linha livre, qualquer nivel
    const int base = ESP_INTR_FLAG_IRAM | ESP_INTR_FLAG_INTRDISABLED;
    esp_err_t err = esp_intr_alloc(ETS_LCD_CAM_INTR_SOURCE, base | ESP_INTR_FLAG_LEVEL3,
                                   privGet(BusIsrHandler()), self, &h);
    if (err != ESP_OK) {
        err = esp_intr_alloc(ETS_LCD_CAM_INTR_SOURCE, base | ESP_INTR_FLAG_LOWMED,
                             privGet(BusIsrHandler()), self, &h);
    }
    if (err == ESP_OK) {
        esp_intr_enable(h);
        ESP_LOGI("board", "ISR do painel em IRAM (linha %d, nucleo %d)", esp_intr_get_intno(h),
                 esp_intr_get_cpu(h));
    } else {
        ESP_LOGE("board", "ISR do painel: realocacao em IRAM falhou (%d) - painel sem VSYNC", (int)err);
    }
    return true;
}

namespace Board {

#if defined(CONFIG_CELEROS_SMARTDISPLAY_RELAYS) && CONFIG_CELEROS_SMARTDISPLAY_RELAYS > 0
static const BoardProfile s_profile = {
    .id = "smartdisplay_4in",
    .otaChannel = "smartdisplay_4848S040",
    .name = "smartdisplay_4in (4848S040 +"
        " " CELEROS_STR(CONFIG_CELEROS_SMARTDISPLAY_RELAYS) " reles)",
    .sd = {.cs = 42, .sck = 48, .miso = 41, .mosi = 47, .freqKhz = 4000},  // bus compartilhado com o init do painel
    .hasPsram = true,
    .backlightPwm = true,
    .capacitiveTouch = true,
    .speakerPin = -1,  // pinos 40/2/1 sao rele nesta variante
    .rotation = 0,     // painel quadrado 480x480, sem rotação
    .led = {-1, -1, -1, false},
    .lightSensorPin = -1,
    .i2s = {-1, -1, -1},
    .relay = {.count = CONFIG_CELEROS_SMARTDISPLAY_RELAYS, .pins = {40, 2, 1}},  // L1, L2, L3
    .gpioDeniedMask = 0x3E00000000ULL | (1ULL << 43) | (1ULL << 44) | (1ULL << 19) | (1ULL << 45),  // 33..37: DQ4..7/DQS da PSRAM octal (N16R8); 43/44: UART0 (console/celerctl + conector); 19/45: I2C do touch GT911
};
#else
static const BoardProfile s_profile = {
    .id = "smartdisplay_4in",
    .otaChannel = "smartdisplay_4848S040",
    .name = "smartdisplay_4in (ESP32-S3-4848S040)",
    .sd = {.cs = 42, .sck = 48, .miso = 41, .mosi = 47, .freqKhz = 4000},  // bus compartilhado com o init do painel
    .hasPsram = true,
    .backlightPwm = true,
    .capacitiveTouch = true,
    .speakerPin = -1,  // sem buzzer; o alto-falante e digital (I2S, abaixo)
    .rotation = 0,     // painel quadrado 480x480, sem rotação
    .led = {-1, -1, -1, false},
    .lightSensorPin = -1,
    .i2s = {.dout = 40, .bclk = 1, .lrc = 2},  // NS4168
    .relay = {},
    .servo = {},
    .mic = {},
    .strips = {},  // variante sem rele (padrao)
    .gpioDeniedMask = 0x3E00000000ULL | (1ULL << 43) | (1ULL << 44) | (1ULL << 19) | (1ULL << 45),  // 33..37: DQ4..7/DQS da PSRAM octal (N16R8); 43/44: UART0 (console/celerctl + conector); 19/45: I2C do touch GT911
};
#endif

void init() {
    initDisplayOnCore1();
    // Arrays RGB565 padrao (icones, BMPs de apps JS) e o readRect (screencap)
    // exigem a conversao de ordem de bytes: o framebuffer nativo do LCD_CAM
    // e 565 com bytes trocados (rgb565_2Byte do LovyanGFX). Sem isso o
    // pushImage copia cru e as cores saem trocadas no vidro.
    s_display.setSwapBytes(true);
    // Variante Y: rele desligado no boot (nivel baixo), como no demo do fab.
    BoardIO::initRelays();
}

CelerDisplay& display() {
    return s_display;
}

const BoardProfile& profile() {
    return s_profile;
}

}  // namespace Board
