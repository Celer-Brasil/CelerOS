#pragma once

#include <algorithm>
#include "Display.h"
#include "DirtyRects.h"

/**
 * @brief Quadro automatico do app (PSRAM) com caixa suja.
 *
 * O present() empurrava o quadro INTEIRO ao vidro a cada mudanca: no watch
 * (410x502 por QSPI + framebuffer do painel) eram ~400 KB de memcpy PSRAM e
 * de flush por segundo so para o Watchface trocar a barra de segundos. Aqui
 * todo desenho no quadro passa por um painel que acumula os retangulos
 * tocados (ate kMaxDirty caixas, DirtyRects.h), e o present() empurra so
 * eles.
 *
 * Como: o LGFX_Sprite desenha pelo ponteiro _panel e gerencia o buffer pelo
 * membro _panel_sprite. O DirtyPanel e um Panel_Sprite apontando para o
 * MESMO buffer (setBuffer: pre-alocado, nunca liberado por ele) que entra no
 * lugar do _panel; createSprite/pushSprite seguem no _panel_sprite.
 *
 * Invariantes: rotacao 0 e sem recriar o buffer depois do createFrame()
 * (setColorDepth/createSprite/deleteSprite no quadro desligariam o buffer
 * compartilhado) — o quadro e criado uma vez e reaproveitado entre apps.
 */
/// Mistura RGB565 de um pixel: out = d + (s - d) * a / 255, por canal.
inline uint16_t blend565(uint16_t d, uint16_t s, uint8_t a) {
    const uint32_t ia = 255 - a;
    const uint32_t dr = (d >> 11) & 0x1F, dg = (d >> 5) & 0x3F, db = d & 0x1F;
    const uint32_t sr = (s >> 11) & 0x1F, sg = (s >> 5) & 0x3F, sb = s & 0x1F;
    uint32_t r = dr * ia + sr * a, g = dg * ia + sg * a, b = db * ia + sb * a;
    r = (r + 128 + (r >> 8)) >> 8;  // div255 exato para x <= 65025
    g = (g + 128 + (g >> 8)) >> 8;
    b = (b + 128 + (b >> 8)) >> 8;
    return (uint16_t)((r << 11) | (g << 5) | b);
}

class FrameSprite : public CelerSprite {
public:
    explicit FrameSprite(lgfx::LovyanGFX* parent) : CelerSprite(parent) {}
    ~FrameSprite() override { _panel = &_panel_sprite; }

    /// Cria o buffer (PSRAM, 16 bits) e liga o rastreio. nullptr = sem memoria.
    void* createFrame(int32_t w, int32_t h) {
        _panel = &_panel_sprite;
        setPsram(true);
        setColorDepth(16);
        void* buf = createSprite(w, h);
        if (buf == nullptr) return nullptr;
        _dirty.setColorDepth(_write_conv.depth);
        _dirty.setBuffer(buf, w, h, &_write_conv);
        _panel = &_dirty;
        _dirty.markAll();
        return buf;
    }

    static constexpr int kMaxDirty = 32;

    /// Pixel direto no buffer (fast path do System.drawPixel: pixel
    /// ESPALHADO pelo caminho completo do LGFX custava ~0,2 ms — as
    /// estrelas/balas dos jogos somavam 12-46 ms por quadro). false =
    /// fora do quadro (o chamador cai no caminho do LGFX). Nao trata
    /// clipe: so chame sem clipe ativo (invariante do quadro: rotacao 0).
    /// A cor chega em RGB565 nativo; o buffer guarda os BYTES TROCADOS
    /// (mesma convencao do Canvas::dim: e o que o pushSprite entrega ao
    /// painel), entao a escrita passa pelo bswap.
    bool pokePixel(int32_t x, int32_t y, uint16_t c565) {
        if (x < 0 || y < 0 || x >= width() || y >= height()) return false;
        _img16[(size_t)_dirty.bitWidth() * y + x] = (uint16_t)__builtin_bswap16(c565);
        _dirty.add(x, y, x, y);
        return true;
    }

    /// Caixas sujas desde a ultima chamada (e zera): ate kMaxDirty em out,
    /// ja recortadas ao quadro. 0 = nada mudou.
    int takeDirty(celer::DirtyRect* out) { return _dirty.take(out); }

    /// Mistura so a intersecao com o clipe do LGFX (ja limitado ao quadro).
    /// O buffer guarda RGB565 com bytes trocados. O present consome uma
    /// unica caixa para o retangulo inteiro.
    void blendRect(int32_t x, int32_t y, int32_t w, int32_t h, uint16_t c565, uint8_t a) {
        if (a == 0 || w <= 0 || h <= 0) return;
        int32_t cx, cy, cw, ch;
        getClipRect(&cx, &cy, &cw, &ch);
        const int32_t x0 = std::max(x, cx), y0 = std::max(y, cy);
        const int32_t x1 = std::min<int64_t>((int64_t)x + w, cx + cw);
        const int32_t y1 = std::min<int64_t>((int64_t)y + h, cy + ch);
        if (x0 >= x1 || y0 >= y1) return;
        const int32_t pitch = _dirty.bitWidth();
        for (int32_t yy = y0; yy < y1; ++yy) {
            uint16_t* row = _img16 + (size_t)yy * pitch;
            for (int32_t xx = x0; xx < x1; ++xx) {
                uint16_t dst = __builtin_bswap16(row[xx]);
                row[xx] = __builtin_bswap16(blend565(dst, c565, a));
            }
        }
        _dirty.add(x0, y0, x1 - 1, y1 - 1);
    }

    /// Um pixel misturado (drawLine/drawCircle com alpha).
    bool blendPixel(int32_t x, int32_t y, uint16_t c565, uint8_t a) {
        if (a == 0) return true;
        if (x < 0 || y < 0 || x >= width() || y >= height()) return false;
        int32_t cx, cy, cw, ch;
        getClipRect(&cx, &cy, &cw, &ch);
        if (x < cx || y < cy || x >= cx + cw || y >= cy + ch) return false;
        uint16_t* p = _img16 + (size_t)_dirty.bitWidth() * (size_t)y + x;
        const uint16_t d = (uint16_t)__builtin_bswap16(*p);
        *p = (uint16_t)__builtin_bswap16(blend565(d, c565, a));
        _dirty.add(x, y, x, y);
        return true;
    }

    /// Alguma caixa suja comeca acima de y (faixa da topbar).
    bool dirtyAbove(int32_t y) const { return _dirty.rects.touchesAbove(y); }

    /// Retangulo escrito por fora do LGFX (System.nativeScreen no buffer).
    void markDirty(int32_t x0, int32_t y0, int32_t x1, int32_t y1) { _dirty.add(x0, y0, x1, y1); }

    /// Largura alocada de linha do buffer em pixels (indexacao de _img16).
    int32_t stride() const { return _dirty.bitWidth(); }

    /// Tudo sujo (vidro foi sujado por fora do quadro).
    void markAllDirty() { _dirty.markAll(); }

private:
    struct DirtyPanel : public lgfx::Panel_Sprite {
        celer::DirtyRects<kMaxDirty> rects;

        void add(int32_t x0, int32_t y0, int32_t x1, int32_t y1) {
            if (_rotation != 0) {  // fora do invariante: nao arrisca
                markAll();
                return;
            }
            rects.add(x0, y0, x1, y1);
        }
        void markAll() { rects.markAll((int32_t)_panel_width, (int32_t)_panel_height); }
        int take(celer::DirtyRect* out) {
            return rects.take(out, (int32_t)_panel_width, (int32_t)_panel_height);
        }
        /// Largura ALOCADA de linha do buffer (pode ter padding alem do
        /// _panel_width); o buffer do sprite e indexado por ela.
        int32_t bitWidth() const { return (int32_t)_bitwidth; }

        // Pontos de escrita do Panel_Sprite: writeBlock/writePixels escrevem
        // dentro da janela do setWindow; o alpha/effect do IPanel cai no
        // writeImage.
        void setWindow(uint_fast16_t xs, uint_fast16_t ys, uint_fast16_t xe, uint_fast16_t ye) override {
            lgfx::Panel_Sprite::setWindow(xs, ys, xe, ye);
            add(xs, ys, xe, ye);
        }
        void drawPixelPreclipped(uint_fast16_t x, uint_fast16_t y, uint32_t rawcolor) override {
            lgfx::Panel_Sprite::drawPixelPreclipped(x, y, rawcolor);
            add(x, y, x, y);
        }
        void writeFillRectPreclipped(uint_fast16_t x, uint_fast16_t y, uint_fast16_t w, uint_fast16_t h,
                                     uint32_t rawcolor) override {
            lgfx::Panel_Sprite::writeFillRectPreclipped(x, y, w, h, rawcolor);
            add(x, y, x + w - 1, y + h - 1);
        }
        void writeImage(uint_fast16_t x, uint_fast16_t y, uint_fast16_t w, uint_fast16_t h,
                        lgfx::pixelcopy_t* param, bool use_dma) override {
            lgfx::Panel_Sprite::writeImage(x, y, w, h, param, use_dma);
            add(x, y, x + w - 1, y + h - 1);
        }
        void writeImageARGB(uint_fast16_t x, uint_fast16_t y, uint_fast16_t w, uint_fast16_t h,
                            lgfx::pixelcopy_t* param) override {
            lgfx::Panel_Sprite::writeImageARGB(x, y, w, h, param);
            add(x, y, x + w - 1, y + h - 1);
        }
        void copyRect(uint_fast16_t dst_x, uint_fast16_t dst_y, uint_fast16_t w, uint_fast16_t h,
                      uint_fast16_t src_x, uint_fast16_t src_y) override {
            lgfx::Panel_Sprite::copyRect(dst_x, dst_y, w, h, src_x, src_y);
            add(dst_x, dst_y, dst_x + w - 1, dst_y + h - 1);
        }
    };

    DirtyPanel _dirty;
};
