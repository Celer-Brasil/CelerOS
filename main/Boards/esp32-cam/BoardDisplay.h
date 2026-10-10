#ifndef CELER_BOARDS_ESP32_CAM_DISPLAY_H
#define CELER_BOARDS_ESP32_CAM_DISPLAY_H

// ----------------------------------------------------------------------------
// ESP32-CAM (AI-Thinker, modulo ESP32-S): SEM display — o vidro da placa e o
// sensor OV2640. Mesmo padrao do devkit barebone: painel stub que aceita as
// chamadas de desenho e joga fora, zero RAM de framebuffer e zero barramento
// (a PSRAM de 4MB fica inteira para o runtime JS, os buffers TLS e, na rodada
// da camera, os framebuffers JPEG).
//
// Com CELEROS_UI=n (sdkconfig desta placa) a pilha de video nem e compilada:
// este stub existe para o tipo CelerDisplay continuar concreto (Boards/Board.h)
// e para os testes/possiveis builds com UI ligada.
// ----------------------------------------------------------------------------

#include "../../Display/Display.h"

#include <lgfx/v1/misc/pixelcopy.hpp>  // pixelcopy_t (o Panel_FrameBufferBase so previa)
#include <lgfx/v1/panel/Panel_FrameBufferBase.hpp>

class BoardDisplay : public CelerDisplayBase {
public:
    BoardDisplay(void) {
        {
            auto cfg = _panel.config();
            cfg.memory_width = 240;   // mesmo espaco virtual das outras placas:
            cfg.memory_height = 320;  // UI::sx/sy = 1 e apps nao precisam saber
            cfg.panel_width = 240;
            cfg.panel_height = 320;
            cfg.bus_shared = false;
            _panel.config(cfg);
        }
        setPanel(&_panel);
    }

private:
    // Painel burro: tudo que escrever some; leitura devolve zeros.
    class StubPanel : public lgfx::Panel_FrameBufferBase {
    public:
        void setWindow(uint_fast16_t xs, uint_fast16_t ys, uint_fast16_t xe, uint_fast16_t ye) override {
            (void)xs; (void)ys; (void)xe; (void)ye;
        }
        void drawPixelPreclipped(uint_fast16_t x, uint_fast16_t y, uint32_t rawcolor) override {
            (void)x; (void)y; (void)rawcolor;
        }
        void writeFillRectPreclipped(uint_fast16_t x, uint_fast16_t y, uint_fast16_t w, uint_fast16_t h, uint32_t rawcolor) override {
            (void)x; (void)y; (void)w; (void)h; (void)rawcolor;
        }
        void writeBlock(uint32_t rawcolor, uint32_t length) override {
            (void)rawcolor; (void)length;
        }
        void writeImage(uint_fast16_t x, uint_fast16_t y, uint_fast16_t w, uint_fast16_t h, lgfx::pixelcopy_t* param, bool use_dma) override {
            (void)x; (void)y; (void)w; (void)h; (void)param; (void)use_dma;
        }
        void writeImageARGB(uint_fast16_t x, uint_fast16_t y, uint_fast16_t w, uint_fast16_t h, lgfx::pixelcopy_t* param) override {
            (void)x; (void)y; (void)w; (void)h; (void)param;
        }
        void writePixels(lgfx::pixelcopy_t* param, uint32_t len, bool use_dma) override {
            (void)param; (void)len; (void)use_dma;
        }
        void display(uint_fast16_t x, uint_fast16_t y, uint_fast16_t w, uint_fast16_t h) override {
            (void)x; (void)y; (void)w; (void)h;
        }
        void copyRect(uint_fast16_t dst_x, uint_fast16_t dst_y, uint_fast16_t w, uint_fast16_t h, uint_fast16_t src_x, uint_fast16_t src_y) override {
            (void)dst_x; (void)dst_y; (void)w; (void)h; (void)src_x; (void)src_y;
        }
        void readRect(uint_fast16_t x, uint_fast16_t y, uint_fast16_t w, uint_fast16_t h, void* dst, lgfx::pixelcopy_t* param) override {
            (void)x; (void)y;
            size_t rowBytes = ((size_t)w * param->dst_bits + 7) / 8;
            memset(dst, 0, rowBytes * h);
        }
    };

    StubPanel _panel;
};

#endif  // CELER_BOARDS_ESP32_CAM_DISPLAY_H
