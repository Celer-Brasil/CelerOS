#ifndef CELER_BOARDS_CYD_DISPLAY_H
#define CELER_BOARDS_CYD_DISPLAY_H

// ----------------------------------------------------------------------------
// Cheap Yellow Display (ESP32-2432S028R, variante classica witnessmenow):
// ILI9341 240x320 no HSPI NATIVO (SCK=14, MOSI=13, MISO=12, CS=15, DC=2,
// RST=4) com backlight em GPIO21 e o touch XPT2046 em pinos DEDICADOS
// (CLK=25, MOSI=32, MISO=39, CS=33) rodando no VSPI livre.
//
// ATENCAO variante: a primera versao deste driver assumia o pinot do env
// platformio do fork original (TFT no VSPI 18/23/19, touch compartilhando o
// bus) — nessa placa esses pinos nao ligam em nada (tela branca). O pinout
// abaixo e o da placa fisica, conferido contra um projeto que roda nela
// (ESP32-Cheap-Yellow-Display/PINS.md). O slot microSD da variante fica no
// MESMO HSPI do TFT (CS=5): o FileSystem monta o cartao como segundo
// dispositivo do bus (multi-device do driver IDF; video e cartao se
// serializam pelo lock de transacao — ver FileSystem.cpp/mountSD).
// ----------------------------------------------------------------------------

#include <cstdio>
#include "esp_log.h"
#include "../../Display/Display.h"

#include <lgfx/v1/panel/Panel_ST7789.hpp>
#include <lgfx/v1/platforms/esp32/Bus_SPI.hpp>
#include <lgfx/v1/touch/Touch_XPT2046.hpp>

class BoardDisplay : public CelerDisplayBase {
public:
    lgfx::Bus_SPI      _bus;
    lgfx::Panel_ST7789 _panel;
    lgfx::Light_PWM     _light;
    lgfx::Touch_XPT2046 _touch;

    BoardDisplay(void) {
        {
            auto cfg = _bus.config();
            cfg.spi_host = SPI2_HOST;  // HSPI (pinos nativos 13/14/12)
            cfg.freq_write = 40000000;   // 40MHz: pinos IOMUX nativos do HSPI (80/2); frame cheio ~31ms (26MHz: ~47ms)
            cfg.pin_sclk = 14;
            cfg.pin_mosi = 13;
            cfg.pin_miso = 12;
            cfg.pin_dc = 2;
            // MISO dedicado (GPIO12): leitura 4-fios. O default do LovyanGFX
            // (3-wire, le pelo MOSI) devolvia tudo preto no readRect —
            // screencap vazio e blend de icone no modo direto sobre preto.
            cfg.spi_3wire = false;
            // leitura (screencap/readRect) a 8MHz trazia erros de bit
            // esparsos (pixels vermelhos soltos); 5MHz le limpo
            cfg.freq_read = 5000000;
            _bus.config(cfg);
            _panel.setBus(&_bus);
        }
        {
            auto cfg = _panel.config();
            cfg.pin_cs = 15;
            // Reset do TFT vem do EN nesta placa: GPIO4 e o LED VERMELHO do
            // RGB (Board.cpp) — usado como RST ele piscava o LED no boot e
            // impedia o System.led. Sem pino, o LovyanGFX faz reset por
            // comando (SWRESET).
            cfg.pin_rst = -1;
            // Vidro real desta placa: 320x240 LANDSCAPE (RAM inteira do
            // controlador 240x320, girada). Varredura da sonda v5 confirmou:
            // rotacao 3 + offsets 0 + painel cheio = tela toda. O CelerOS
            // nesta placa roda em landscape (profile.rotation = 3).
            cfg.panel_width = 240;
            cfg.panel_height = 320;
            cfg.memory_width = 240;
            cfg.memory_height = 320;
            cfg.offset_x = 0;
            cfg.offset_y = 0;
            cfg.offset_rotation = 0;
            // Leitura (readRect: screencap, blend de icone no modo direto):
            // o controlador desta placa le com 8 bits de dummy (padrao
            // ILI9341), nao os 16 do Panel_ST7789 — com 16 cada pixel lido
            // saia deslocado 1 byte (canais rotacionados: vermelho virava
            // azul). A escrita nao depende disso.
            cfg.dummy_read_pixel = 8;
            _panel.config(cfg);
        }
        {
            auto cfg = _light.config();
            cfg.pin_bl = 21;
            _light.config(cfg);
            _panel.setLight(&_light);
        }
        {
            // Touch em barramento PROPRIO (nao compartilha com o TFT):
            // XPT2046 da placa tem fio proprio — VSPI livre com pinos
            // remapeados pela GPIO matrix.
            auto cfg = _touch.config();
            // Faixa bruta com eixos invertidos (conferido nesta variante);
            // a calibracao interativa de 2 pontos refina e persiste em
            // /local/touch_cal_p.bin
            // Frame PORTRAIT do sensor (o LGFX normaliza p/ 240x320 e so
            // entao aplica a rotacao do painel): valores classicos XPT2046.
            cfg.x_min = 300;
            cfg.x_max = 3800;
            cfg.y_min = 200;
            cfg.y_max = 3700;
            // PENIRQ do XPT2046 (T_IRQ -> GPIO36, so entrada): ALTO = sem
            // dedo e o LGFX nem abre a transacao. Sem ele cada volta do loop
            // (~190/s com o vidro aceso) trocava 57 bytes a 2 MHz so para
            // descobrir que ninguem tocou. O ultimo comando da leitura (0x80)
            // deixa o chip em power-down com o PENIRQ armado.
            cfg.pin_int = 36;
            cfg.bus_shared = false;
            cfg.offset_rotation = 0;
            cfg.spi_host = SPI3_HOST;  // VSPI dedicado ao touch
            cfg.freq = 2000000;
            cfg.pin_sclk = 25;
            cfg.pin_mosi = 32;
            cfg.pin_miso = 39;
            cfg.pin_cs = 33;
            _touch.config(cfg);
            _panel.setTouch(&_touch);
        }
        setPanel(&_panel);
    }


    // Calibracao no formato proprio [x_min, x_max, y_min, y_max, 0],
    // persistida pelo TouchCalibrator em /local/touch_cal_p.bin. Os eixos
    // crus ja vem no frame correto: o calibrador de 5 pontos deriva qual
    // eixo do XPT2046 e X/Y logico (abaixo) — o load e 1:1.
    void setTouch(uint16_t* calData) override {
        auto cfg = _touch.config();
        cfg.x_min = calData[0];
        cfg.x_max = calData[1];
        cfg.y_min = calData[2];
        cfg.y_max = calData[3];
        _touch.config(cfg);
        // CRITICO: sem isto a matriz afina do painel NAO e recalculada — a
        // calibracao salva era ignorada e o mapeamento usava os defaults do
        // driver para sempre (bug da calibracao 'que nao pegava').
        _panel.setTouch(&_touch);
    }

    // Calibracao interativa de 5 PONTOS (4 cantos + centro) AUTO-DERIVANTE:
    // descobre em runtime qual eixo cru do XPT2046 mapeia para X/Y logico
    // (TL->TR define X, TL->BL define Y) — funciona em qualquer
    // rotacao/variante, sem flips chumbados. Tela limpa por ponto,
    // contador n/5, ack verde e timeouts (leitura fantasma nao trava).
    void calibrateTouch(uint16_t* calData, uint32_t color, uint32_t bg, uint8_t size) override {
        (void)size;
        const int N = 5;
        const int32_t w = width(), h = height();
        const int32_t m = 26;
        const int32_t pos[N][2] = {
            {m, m}, {w - m, m}, {w - m, h - m}, {m, h - m}, {w / 2, h / 2},
        };
        lgfx::touch_point_t raw[N];
        bool ok[N] = {false, false, false, false, false};

        for (int i = 0; i < N; i++) {
            for (int tent = 0; tent < 3 && !ok[i]; tent++) {
                fillScreen(bg);
                setTextDatum(MC_DATUM);
                setTextColor(color, bg);
                drawLine(pos[i][0] - 20, pos[i][1], pos[i][0] + 20, pos[i][1], color);
                drawLine(pos[i][0], pos[i][1] - 20, pos[i][0], pos[i][1] + 20, color);
                fillCircle(pos[i][0], pos[i][1], 5, color);
                char lbl[8];
                snprintf(lbl, sizeof(lbl), "%d/%d", i + 1, N);
                setTextColor(0xFFFF, bg);
                drawString(lbl, w / 2, h / 2 - 46, 4);
                drawString("touch the crosshair", w / 2, h / 2 + 28, 2);

                lgfx::touch_point_t tp;
                // espera soltar (max 3s — leitura fantasma nao trava)
                uint32_t t0 = lgfx::millis();
                while (getTouchRaw(&tp, 1) && lgfx::millis() - t0 < 3000) delay(20);
                delay(300);
                // espera tocar (max 12s)
                t0 = lgfx::millis();
                bool touched = false;
                while (lgfx::millis() - t0 < 12000) {
                    if (getTouchRaw(&tp, 1)) { touched = true; break; }
                    delay(20);
                }
                if (!touched) continue;

                int32_t sx = 0, sy = 0;
                int got = 0;
                t0 = lgfx::millis();
                while (got < 10 && lgfx::millis() - t0 < 1500) {
                    if (getTouchRaw(&tp, 1)) { sx += tp.x; sy += tp.y; got++; }
                    delay(15);
                }
                if (got >= 6) {
                    raw[i].x = sx / got;
                    raw[i].y = sy / got;
                    ok[i] = true;
                    fillCircle(pos[i][0], pos[i][1], 11, 0x07E0);  // ack verde
                    delay(350);
                }
            }
        }

        for (int i = 0; i < N; i++) {
            ESP_LOGI("cyd.cal", "ponto %d ok=%d raw=(%d,%d)", i, ok[i] ? 1 : 0, (int)raw[i].x, (int)raw[i].y);
        }

        // Derivacao em DOIS passos:
        //  (1) qual eixo CRU rastreia X/Y logico (TL->TR varia X, TL->BL Y);
        //  (2) em qual LADO LOGICO esta cada extremo do frame PORTRAIT do
        //      sensor — e o frame que a matriz afina do LGFX espera
        //      (x_min/y_min = canto sup-esq do PORTRAIT 240x320, antes da
        //      rotacao do painel), replicando a formula do convertRawXY.
        int32_t dTRx = raw[1].x - raw[0].x, dTRy = raw[1].y - raw[0].y;
        int32_t dBLx = raw[3].x - raw[0].x, dBLy = raw[3].y - raw[0].y;
        bool xIsRawX = (dTRx >= 0 ? dTRx : -dTRx) >= (dTRy >= 0 ? dTRy : -dTRy);
        bool yIsRawX = (dBLx >= 0 ? dBLx : -dBLx) >= (dBLy >= 0 ? dBLy : -dBLy);
        bool valid = ok[0] && ok[1] && ok[2] && ok[3] && (xIsRawX != yIsRawX);
        if (valid) {
            // Agregados por lado LOGICO projetados no eixo cru que rastreia
            // cada eixo, e EXTRAPOLACAO linear ate as bordas reais: os
            // cruzes ficam a `m` px da borda e o LGFX mapeia x_min->0 /
            // x_max->fim — usar o raw do cruz como borda estica o espaco e
            // deixa as beiradas inclicaveis (painel resistivo e linear, a
            // extrapolacao e exata).
            auto projX = [&](int i) { return xIsRawX ? raw[i].x : raw[i].y; };
            auto projY = [&](int i) { return yIsRawX ? raw[i].x : raw[i].y; };
            int32_t rxL = (projX(0) + projX(3)) / 2;  // cruz na coluna x=m
            int32_t rxR = (projX(1) + projX(2)) / 2;  // x=w-m
            int32_t ryT = (projY(0) + projY(1)) / 2;  // y=m
            int32_t ryB = (projY(3) + projY(2)) / 2;  // y=h-m
            float kX = (float)(rxR - rxL) / (float)(w - 2 * m);  // raw por px logico
            float kY = (float)(ryB - ryT) / (float)(h - 2 * m);
            int32_t xAt[2] = {(int32_t)(rxL - kX * m), (int32_t)(rxR + kX * m)};  // raw em x=0 / x=w
            int32_t yAt[2] = {(int32_t)(ryT - kY * m), (int32_t)(ryB + kY * m)};  // raw em y=0 / y=h

            // portrait -> logico (formula do Panel_Device::convertRawXY)
            const int32_t r = getRotation() & 3;
            const bool vflip = ((1 << r) & 0b10010110) != 0;
            auto rot = [&](int32_t px, int32_t py, int32_t* ox, int32_t* oy) {
                int32_t a = px, b = py;
                if (r) {
                    if (r & 1) std::swap(a, b);
                    if (r & 2) a = width() - 1 - a;
                    if (vflip) b = height() - 1 - b;
                }
                *ox = a; *oy = b;
            };
            // para onde aponta +x e +y do PORTRAIT no espaco logico
            int32_t ax, ay, bx, by;
            rot(24, 160, &ax, &ay); rot(0, 160, &bx, &by);
            int32_t dpxx = ax - bx, dpxy = ay - by;
            rot(120, 24, &ax, &ay); rot(120, 0, &bx, &by);
            int32_t dpyx = ax - bx, dpyy = ay - by;

            // portrait x: eixo logico dominante + ordem (px pequeno = x_min)
            if ((dpxx >= 0 ? dpxx : -dpxx) >= (dpxy >= 0 ? dpxy : -dpxy)) {
                calData[0] = (uint16_t)(dpxx > 0 ? xAt[0] : xAt[1]);
                calData[1] = (uint16_t)(dpxx > 0 ? xAt[1] : xAt[0]);
            } else {
                calData[0] = (uint16_t)(dpxy > 0 ? yAt[0] : yAt[1]);
                calData[1] = (uint16_t)(dpxy > 0 ? yAt[1] : yAt[0]);
            }
            // portrait y
            if ((dpyx >= 0 ? dpyx : -dpyx) >= (dpyy >= 0 ? dpyy : -dpyy)) {
                calData[2] = (uint16_t)(dpyx > 0 ? xAt[0] : xAt[1]);
                calData[3] = (uint16_t)(dpyx > 0 ? xAt[1] : xAt[0]);
            } else {
                calData[2] = (uint16_t)(dpyy > 0 ? yAt[0] : yAt[1]);
                calData[3] = (uint16_t)(dpyy > 0 ? yAt[1] : yAt[0]);
            }
            int32_t rr = (int32_t)calData[1] - calData[0];
            int32_t rs = (int32_t)calData[3] - calData[2];
            ESP_LOGI("cyd.cal", "xIsRawX=%d yIsRawX=%d cal=[%d %d %d %d] ranges=%d/%d rot=%d",
                     xIsRawX ? 1 : 0, yIsRawX ? 1 : 0, calData[0], calData[1], calData[2], calData[3],
                     (int)rr, (int)rs, (int)getRotation());
            valid = (rr >= 0 ? rr : -rr) > 300 && (rs >= 0 ? rs : -rs) > 300;
        }
        calData[4] = 0;
        if (!valid) {
            // amostras inconsistentes: NAO salva padroes como se fossem
            // calibracao — sinaliza falha (calData[4]=1) p/ o chamador
            // reiniciar e tentar de novo com toques mais firmes
            calData[4] = 1;
            fillScreen(bg);
            setTextDatum(MC_DATUM);
            setTextColor(0xF800, bg);
            drawString("calibracao falhou", w / 2, h / 2 - 12, 2);
            drawString("toque mais firme - de novo", w / 2, h / 2 + 14, 2);
            ESP_LOGW("cyd.cal", "derivacao invalida — recusa");
            delay(1800);
        }
    }
};

#endif  // CELEROS_BOARDS_CYD_DISPLAY_H
