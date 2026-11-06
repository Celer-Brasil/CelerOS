#pragma once

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

    /// Mistura um trecho de linha no buffer (API 59, System.setAlpha): o
    /// pixel que JA esta no quadro recebe `c565` com peso a/255 — e o que
    /// deixa os controles em overlay TRANSLUCIDOS por cima do jogo. A cor
    /// chega em RGB565 NATIVO; o buffer guarda os bytes trocados (a mesma
    /// convencao do Canvas::dim e do pokePixel), entao le e escreve com
    /// bswap — sem isso o blend reinterpreta os canais e o overlay sai com
    /// as cores trocadas. Respeita o recorte do quadro e marca a caixa suja.
    void blendSpan(int32_t x, int32_t y, int32_t w, uint16_t c565, uint8_t a) {
        if (w <= 0 || a == 0 || y < 0 || y >= height()) return;
        int32_t x0 = x, x1 = x + w;
        int32_t cx, cy, cw, ch;
        getClipRect(&cx, &cy, &cw, &ch);
        if (y < cy || y >= cy + ch) return;
        if (x0 < cx) x0 = cx;
        if (x1 > cx + cw) x1 = cx + cw;
        if (x0 < 0) x0 = 0;
        if (x1 > width()) x1 = width();
        if (x1 <= x0) return;
        uint16_t* row = _img16 + (size_t)_dirty.bitWidth() * (size_t)y;
        for (int32_t i = x0; i < x1; i++) {
            const uint16_t d = (uint16_t)__builtin_bswap16(row[i]);
            row[i] = (uint16_t)__builtin_bswap16(blend565(d, c565, a));
        }
        _dirty.add(x0, y, x1 - 1, y);
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
