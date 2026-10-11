#ifndef CELER_BOARDS_SMARTDISPLAY_DISPLAY_H
#define CELER_BOARDS_SMARTDISPLAY_DISPLAY_H

// ----------------------------------------------------------------------------
// Guition ESP32-S3-4848S040 "SmartDisplay ESP32-S3 4.0 inch"
//
// Painel 4" IPS 480x480, ST7701 em RGB paralelo 16-bit; init do painel via
// SPI 3-wire (CS=39, SCK=48, MOSI=47); backlight em GPIO38 (PWM); touch
// capacitivo GT911 (I2C SDA=19, SCL=45, addr 0x5D — driver i2c_master oficial
// em main/Display/Touch_GT911_IDF.h porque o LL do LovyanGFX falha no IDF 6.1).
// Ordem dos pin_data = D0..D15 = B0..B4, G0..G5, R0..R4 (little-endian).
// ----------------------------------------------------------------------------

#include "../../Display/Display.h"

#include "../../Display/Touch_GT911_IDF.h"
#include <lgfx/v1/platforms/esp32s3/Panel_RGB.hpp>
#include <lgfx/v1/platforms/esp32s3/Bus_RGB.hpp>

// O init do fabricante (embutido na lib) seleciona RGB666 (0x3A=0x60), mas o
// framebuffer do LCD_CAM e 16-bit (RGB565) — com 0x60 as cores saem corrompidas.
// Este painel reaproveita o init do fabricante e corrige o formato de cor.
class CelerPanel : public lgfx::Panel_ST7701_guition_esp32_4848S040 {
public:
    bool init(bool use_reset) override {
        if (!lgfx::Panel_ST7701_guition_esp32_4848S040::init(use_reset)) return false;
        static constexpr const uint8_t rgb565_patch[] = {0x3A, 1, 0x50, 0xFF, 0xFF};
        command_list(rgb565_patch);
        return true;
    }
};

// Bus_RGB com duas correcoes (corpo em Board.cpp; o LovyanGFX e submodulo):
//  - init idempotente: o LGFX_Device::init chama initBus() e o
//    Panel_Device::init chama _bus->init() DE NOVO — cada chamada aloca
//    framebuffer (460 KB de PSRAM), descritores de DMA e uma ISR nova, e a
//    1a ISR ficava viva e orfa (duas LCD_CAM na tabela do nucleo 1);
//  - ISR do VSYNC realocada com ESP_INTR_FLAG_IRAM (ver Board.cpp).
class CelerBusRGB : public lgfx::Bus_RGB {
public:
    bool init(void) override;
    void release(void) override {
        _ready = false;
        lgfx::Bus_RGB::release();
    }
private:
    bool _ready = false;
};

class BoardDisplay : public CelerDisplayBase {
public:
    CelerBusRGB       _bus;
    CelerPanel        _panel;
    lgfx::Light_PWM   _light;
    lgfx::Touch_GT911_IDF _touch;

    BoardDisplay(void) {
        {
            auto cfg = _panel.config();
            cfg.memory_width  = 480;
            cfg.memory_height = 480;
            cfg.panel_width   = 480;
            cfg.panel_height  = 480;
            cfg.offset_x = 0;
            cfg.offset_y = 0;
            _panel.config(cfg);
        }
        {
            auto cfg = _panel.config_detail();
            cfg.pin_cs   = 39;  // SPI 3-wire do init do painel (bit-bang)
            cfg.pin_sclk = 48;
            cfg.pin_mosi = 47;
            cfg.use_psram = 1;  // framebuffer na PSRAM
            _panel.config_detail(cfg);
        }
        {
            auto cfg = _bus.config();
            cfg.panel = &_panel;
            // D0..D15 = B0..B4, G0..G5, R0..R4 (little-endian do LCD_CAM)
            cfg.pin_d0  = 4;   // B0
            cfg.pin_d1  = 5;   // B1
            cfg.pin_d2  = 6;   // B2
            cfg.pin_d3  = 7;   // B3
            cfg.pin_d4  = 15;  // B4
            cfg.pin_d5  = 8;   // G0
            cfg.pin_d6  = 20;  // G1
            cfg.pin_d7  = 3;   // G2
            cfg.pin_d8  = 46;  // G3
            cfg.pin_d9  = 9;   // G4
            cfg.pin_d10 = 10;  // G5
            cfg.pin_d11 = 11;  // R0
            cfg.pin_d12 = 12;  // R1
            cfg.pin_d13 = 13;  // R2
            cfg.pin_d14 = 14;  // R3
            cfg.pin_d15 = 0;   // R4
            cfg.pin_henable = 18;  // DE
            cfg.pin_vsync   = 17;
            cfg.pin_hsync   = 16;
            cfg.pin_pclk    = 21;
            // 12 MHz (mais alto causa flicker neste painel). A esta pclk, 1 us
            // de atraso na ISR de VSYNC do Bus_RGB (que recomeca o DMA a cada
            // quadro) desloca a imagem ~12 px: por isso o init roda no nucleo
            // 1 (Board.cpp) — ver boards/AGENTS.md "SMARTDISPLAY RGB PANEL"
            cfg.freq_write  = 12000000;
            cfg.hsync_polarity    = 1;
            cfg.hsync_front_porch = 10;
            cfg.hsync_pulse_width = 8;
            cfg.hsync_back_porch  = 50;
            cfg.vsync_polarity    = 1;
            cfg.vsync_front_porch = 10;
            cfg.vsync_pulse_width = 8;
            cfg.vsync_back_porch  = 20;
            cfg.pclk_active_neg = 0;
            cfg.pclk_idle_high  = 0;
            _bus.config(cfg);
        }
        _panel.setBus(&_bus);

        {
            auto cfg = _light.config();
            cfg.pin_bl = 38;
            cfg.invert = false;
            _light.config(cfg);
        }
        _panel.light(&_light);

        {
            auto cfg = _touch.config();
            cfg.x_min = 0;
            cfg.x_max = 479;
            cfg.y_min = 0;
            cfg.y_max = 479;
            cfg.pin_int = -1;   // INT nao conectado na placa
            cfg.pin_rst = -1;   // RST nao conectado na placa
            cfg.bus_shared = false;
            cfg.offset_rotation = 0;
            cfg.pin_sda = 19;
            cfg.pin_scl = 45;
            cfg.freq = 400000;
            cfg.i2c_addr = 0x5D;  // (0x5D ou 0x14)
            _touch.config(cfg);
            _panel.setTouch(&_touch);
        }

        setPanel(&_panel);
    }

    // Touch capacitivo: calibracao do XPT2046 nao se aplica (base = no-op)
};

#endif  // CELER_BOARDS_SMARTDISPLAY_DISPLAY_H
