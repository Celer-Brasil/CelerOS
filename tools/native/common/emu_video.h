#pragma once
// Saida de video comum dos emuladores nativos.
//
// Formato: RGB565 com os BYTES TROCADOS (swap565), que e o que o
// nativeDraw/nativeScreen e o FrameSprite do CelerOS esperam. O core nunca
// desenha no vidro: ele preenche um buffer na scratch e o app manda desenhar.
//
// O Scaler faz nearest por RUNS: le cada pixel de origem UMA vez e escreve a
// faixa de destino correspondente. A divisao inteira do nearest fica fora do
// laco quente (mapa de colunas/linhas pre-computado) — no Xtensa a divisao e
// software e custava ~20 ms por quadro no Anemoia (256 colunas x 450 linhas).

#include "emu_compat.h"

namespace emu {

static inline uint16_t emu_swap16(uint16_t v) { return (uint16_t)((v >> 8) | (v << 8)); }

// RGB888 -> RGB565 ja com bytes trocados (o valor que o buffer guarda).
static inline uint16_t emu_rgb565(uint8_t r, uint8_t g, uint8_t b)
{
    const uint16_t v = (uint16_t)(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
    return emu_swap16(v);
}

// Paleta de 8/16/256 cores do console -> RGB565 swap. `bit` e o nivel de
// cinza dos consoles que so tem luminancia (Atari 2600 em modo P/B).
static inline uint16_t emu_gray565(uint8_t level)
{
    return emu_rgb565(level, level, level);
}

class Scaler
{
public:
    static constexpr int kMaxSrcW = 320;
    static constexpr int kMaxSrcH = 240;
    static constexpr int kMaxDstW = 512;
    static constexpr int kMaxDstH = 512;

    // dst aponta para a scratch do blob (nativeDraw le de la). Devolve false
    // se a geometria estoura os mapas; o app cai no tamanho nativo.
    bool configure(int srcW, int srcH, int dstW, int dstH, uint16_t* dst)
    {
        if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return false;
        if (srcW > kMaxSrcW || srcH > kMaxSrcH || dstW > kMaxDstW || dstH > kMaxDstH)
            return false;
        if (dst == nullptr) return false;
        srcW_ = srcW;
        srcH_ = srcH;
        dstW_ = dstW;
        dstH_ = dstH;
        dst_ = dst;
        for (int x = 0; x <= srcW; x++) col_[x] = (uint16_t)(((uint32_t)x * dstW) / srcW);
        for (int y = 0; y < dstH; y++) row_[y] = (uint16_t)(((uint32_t)y * srcH) / dstH);
        return true;
    }

    bool ready() const { return dst_ != nullptr; }
    uint16_t* target() const { return dst_; }
    int dstW() const { return dstW_; }
    int dstH() const { return dstH_; }

    void scale(const uint16_t* src, int srcStride)
    {
        if (dst_ == nullptr || src == nullptr) return;
        for (int y = 0; y < dstH_; y++) {
            const uint16_t* s = src + (int)row_[y] * srcStride;
            uint16_t* d = dst_ + (int)y * dstW_;
            for (int x = 0; x < srcW_; x++) {
                const uint16_t v = s[x];
                int x0 = col_[x];
                const int x1 = col_[x + 1];
                while (x0 < x1) d[x0++] = v;
            }
        }
    }

    void clear(uint16_t swap565)
    {
        if (dst_ == nullptr) return;
        const uint32_t n = (uint32_t)dstW_ * dstH_;
        for (uint32_t i = 0; i < n; i++) dst_[i] = swap565;
    }

private:
    uint16_t col_[kMaxSrcW + 1];
    uint16_t row_[kMaxDstH];
    int srcW_ = 0, srcH_ = 0, dstW_ = 0, dstH_ = 0;
    uint16_t* dst_ = nullptr;
};

}  // namespace emu
