#pragma once
// Composicao direta no vidro (FRAME_SCREEN, API 60) para os cores de
// emulador: escala nearest + carimbos do overlay, linha a linha, escritos UMA
// vez no alvo (framebuffer do painel por GDMA, ou o quadro do app).
//
// Mesmo algoritmo do Anemoia (tools/native/nes/NESBlob.cpp), generalizado:
//  - o alvo pode ser a TELA INTEIRA e o quadro escalado fica centrado nele:
//    as faixas de letterbox saem pretas daqui, e os carimbos (d-pad, botoes)
//    podem ficar fora do retangulo do jogo;
//  - o core entrega linhas de origem (row) enquanto emula; end() fecha as
//    linhas do alvo fora do quadro (faixas).
// Linha do alvo que nao mudou (hash da linha de origem + assinatura dos
// carimbos que a cobrem) nao e reescrita: o cenario parado do Atari custa
// quase nada.
//
// O caminho antigo (FRAME + SET_SCALE + nativeDraw) passava o quadro tres
// vezes pela PSRAM (escala, nativeDraw, present) mais o overlay em JS: bancada
// 4848, Pitfall: ~63 ms por quadro renderizado so de video.

#include "emu_compat.h"

#ifndef CLRN_FAST
#define CLRN_FAST
#endif

namespace emu {

struct NativeScreen {  // espelho do JsNative.cpp (API 60)
    uint16_t* px;
    int32_t stride;
    int32_t w;
    int32_t h;
    int32_t arg;
    int32_t flags;  // bit0: 1 = framebuffer do painel; bit1: redesenho total
    // linha pronta para o firmware (GDMA no painel); nullptr = memcpy aqui
    void (*put)(void* ctx, int32_t y, const uint16_t* src);
    void* putCtx;
};

class ScreenComposer
{
public:
    static constexpr int kMaxW = 512;
    static constexpr int kMaxH = 512;
    static constexpr int kMaxSrcW = 320;
    static constexpr int kMaxSrcH = 256;
    static constexpr int kMaxStamps = 32;
    static constexpr int kMaxSlots = 8;

    // lineBase/lineMix: 2 x kMaxW pixels; col: kMaxSrcW + 1 entradas. O blob
    // passa buffers da regiao fast (RAM interna): sao o caminho quente.
    void init(uint8_t* scratch, uint32_t grabOff, uint32_t grabCap, uint32_t stampOff,
              uint32_t stampCap, uint16_t* lineBase, uint16_t* lineMix, uint16_t* col)
    {
        scratch_ = scratch;
        grabOff_ = grabOff;
        grabCap_ = grabCap;
        stampOff_ = stampOff;
        stampCap_ = stampCap;
        lineBase_ = lineBase;
        lineMix_ = lineMix;
        col_ = col;
        srcW_ = srcH_ = scaleW_ = scaleH_ = 0;
        tgtW_ = tgtH_ = -1;
        lastTarget_ = -1;
        force_ = true;
        scr_ = nullptr;
        stampReset();
    }

    // Quadro de origem srcW x srcH escalado para scaleW x scaleH no centro
    // do alvo (o mesmo SET_SCALE do caminho antigo).
    bool setScale(int srcW, int srcH, int scaleW, int scaleH)
    {
        if (srcW <= 0 || srcW > kMaxSrcW || srcH <= 0 || srcH > kMaxSrcH) return false;
        if (scaleW <= 0 || scaleW > kMaxW || scaleH <= 0 || scaleH > kMaxH) return false;
        srcW_ = srcW;
        srcH_ = srcH;
        scaleW_ = scaleW;
        scaleH_ = scaleH;
        tgtW_ = tgtH_ = -1;  // geometria do alvo refeita no proximo begin
        return true;
    }

    // Inicio do quadro renderizado. false = alvo/geometria invalidos (o core
    // devolve "sem alvo" e o app cai no caminho antigo).
    bool begin(const NativeScreen* scr)
    {
        if (scr == nullptr || scr->px == nullptr || scaleW_ <= 0) return false;
        if (scr->w <= 0 || scr->w > kMaxW || scr->h <= 0 || scr->h > kMaxH) return false;
        if (scr->w < scaleW_ || scr->h < scaleH_) return false;
        geometry(scr->w, scr->h);
        // alvo trocou (painel <-> quadro do app) ou o vidro foi pintado por
        // fora desde o ultimo quadro (flags bit1, do firmware): tudo de novo
        if ((scr->flags & 2) || (scr->flags & 1) != lastTarget_) force_ = true;
        lastTarget_ = scr->flags & 1;
        scr_ = scr;
        return true;
    }

    // Linha de origem sy (srcW pixels, RGB565 swap) -> linhas do alvo.
    void row(int sy, const uint16_t* src)
    {
        if (scr_ == nullptr || sy < 0 || sy >= srcH_) return;
        const uint32_t hsh = rowHash(src);
        const bool changed = force_ || hsh != rowHash_[sy];
        rowHash_[sy] = hsh;
        bool built = false;
        for (int y = gy_ + y0_[sy], ye = gy_ + y0_[sy + 1]; y < ye; y++) {
            const uint32_t sig = stampSig(y);
            if (!changed && sig == rowSig_[y]) continue;
            if (!built) {
                buildScaled(src);
                built = true;
            }
            emit(y, sig, lineBase_);
        }
    }

    // Fim do quadro: faixas fora do quadro escalado (preto + carimbos).
    void end()
    {
        if (scr_ == nullptr) return;
        for (int y = 0; y < tgtH_; y++) {
            if (y >= gy_ && y < gy_ + scaleH_) {
                y = gy_ + scaleH_ - 1;
                continue;
            }
            const uint32_t sig = stampSig(y);
            if (!force_ && sig == rowSig_[y]) continue;
            memset(lineBase_, 0, (size_t)tgtW_ * 2);
            emit(y, sig, lineBase_);
        }
        force_ = false;
        scr_ = nullptr;
    }

    // Quadro renderizado pelo caminho antigo: o vidro foi pintado por fora.
    void invalidate() { force_ = true; }

    // ---- carimbos -----------------------------------------------------
    uint32_t grabOff(int which) const { return grabOff_ + (which ? grabCap_ : 0); }

    // Carimbo de dois grabs (swap565): alpha pela diferenca de verde entre
    // o fundo branco e o preto; a cor sobre preto JA e a pre-multiplicada.
    bool stampMake(int id, int w, int h)
    {
        if (id < 0 || id >= kMaxStamps || w <= 0 || h <= 0) return false;
        if ((uint32_t)w * h * 2 > grabCap_) return false;
        const uint16_t* gb = (const uint16_t*)(scratch_ + grabOff_);
        const uint16_t* gw = (const uint16_t*)(scratch_ + grabOff_ + grabCap_);
        const uint32_t base = stampOff_ + stampTop_;
        const uint32_t idxBytes = 4u * (h + 1u);
        if (stampTop_ + idxBytes > stampCap_) return false;
        uint32_t* idx = (uint32_t*)(scratch_ + base);
        Run* runs = (Run*)(scratch_ + base + idxBytes);
        const uint32_t maxRuns = (stampCap_ - stampTop_ - idxBytes) / sizeof(Run);
        uint32_t nr = 0;
        for (int y = 0; y < h; y++) {
            idx[y] = nr;
            for (int x = 0; x < w; x++) {
                const uint32_t b = __builtin_bswap16(gb[y * w + x]);
                const uint32_t wv = __builtin_bswap16(gw[y * w + x]);
                int diff = (int)((wv >> 5) & 63) - (int)((b >> 5) & 63);
                if (diff < 0) diff = 0;
                const int a5 = ((63 - diff) * 32 + 31) / 63;  // 0..32
                if (a5 <= 0) continue;  // transparente: fora dos runs
                const uint32_t v = spread565(b) | ((uint32_t)(32 - (a5 > 32 ? 32 : a5)) << 27);
                if (nr > idx[y] && runs[nr - 1].v == v &&
                    runs[nr - 1].x + runs[nr - 1].len == x) {
                    runs[nr - 1].len++;
                    continue;
                }
                if (nr >= maxRuns) return false;
                runs[nr].x = (uint16_t)x;
                runs[nr].len = 1;
                runs[nr].v = v;
                nr++;
            }
        }
        idx[h] = nr;
        Stamp& st = stamps_[id];
        st.off = base;
        st.w = (uint16_t)w;
        st.h = (uint16_t)h;
        stampTop_ += (idxBytes + nr * (uint32_t)sizeof(Run) + 7u) & ~7u;
        return true;
    }

    // arg = slot | id << 4 | (x+256) << 10 | (y+256) << 20 (x/y no alvo);
    // id fora da tabela esvazia o slot
    bool stampPlace(int32_t arg)
    {
        const int slot = arg & 15, id = (arg >> 4) & 63;
        if (slot >= kMaxSlots) return false;
        if (id >= kMaxStamps || stamps_[id].w == 0) {
            slots_[slot].id = -1;
            return true;
        }
        slots_[slot].id = (int8_t)id;
        slots_[slot].x = (int16_t)(((arg >> 10) & 1023) - 256);
        slots_[slot].y = (int16_t)(((arg >> 20) & 1023) - 256);
        return true;
    }

    void stampReset()
    {
        for (int k = 0; k < kMaxSlots; k++) slots_[k].id = -1;
        for (int i = 0; i < kMaxStamps; i++) stamps_[i].w = stamps_[i].h = 0;
        stampTop_ = 0;
    }

private:
    struct Stamp {
        uint32_t off;  // na scratch: indice u32[h+1] (1o run de cada linha) + runs
        uint16_t w, h;
    };
    // Carimbo em RUNS de pixels iguais: os controles sao preenchimentos
    // lisos, aneis e texto — poucos runs por linha.
    struct Run {
        uint16_t x, len;
        uint32_t v;  // cor pre-multiplicada espalhada | ia << 27 (0 = opaco)
    };
    struct Slot {
        int8_t id;  // -1 = vazio
        int16_t x, y;
    };

    static uint32_t spread565(uint32_t c) { return (c | (c << 16)) & 0x07E0F81Fu; }

    // run sobre a linha em bytes TROCADOS: out = pm + d * ia / 32
    static void blendRun(uint16_t* line, uint32_t v, int n)
    {
        const uint32_t ia = v >> 27;
        const uint32_t pm = v & 0x07E0F81Fu;
        if (ia == 0) {
            const uint16_t c = (uint16_t)__builtin_bswap16((uint16_t)(pm | (pm >> 16)));
            for (int i = 0; i < n; i++) line[i] = c;
            return;
        }
        for (int i = 0; i < n; i++) {
            const uint32_t d = __builtin_bswap16(line[i]);
            uint32_t r = pm + (((spread565(d) * ia) >> 5) & 0x07E0F81Fu);
            r &= 0x07E0F81Fu;
            line[i] = (uint16_t)__builtin_bswap16((uint16_t)(r | (r >> 16)));
        }
    }

    void geometry(int w, int h)
    {
        if (w == tgtW_ && h == tgtH_) return;
        tgtW_ = w;
        tgtH_ = h;
        gx_ = (w - scaleW_) / 2;
        gy_ = (h - scaleH_) / 2;
        // limite de coluna por pixel de origem: a divisao fica FORA do laco
        for (int sx = 0; sx <= srcW_; sx++)
            col_[sx] = (uint16_t)(gx_ + ((uint32_t)sx * scaleW_) / srcW_);
        // linha do quadro y mostra a linha de origem y*srcH/scaleH: a faixa
        // de sy comeca no menor y com y*srcH/scaleH >= sy
        for (int sy = 0; sy <= srcH_; sy++)
            y0_[sy] = (uint16_t)(((uint32_t)sy * scaleH_ + srcH_ - 1) / srcH_);
        force_ = true;
    }

    uint32_t rowHash(const uint16_t* src) const
    {
        const uint32_t* p = (const uint32_t*)src;
        uint32_t h = 2166136261u;
        for (int i = 0; i < srcW_ / 2; i++) h = (h ^ p[i]) * 16777619u;
        return h;
    }

    // assinatura dos carimbos que cobrem a linha y do alvo (0 = nenhum)
    uint32_t stampSig(int y) const
    {
        uint32_t sig = 0;
        for (int k = 0; k < kMaxSlots; k++) {
            const Slot& sl = slots_[k];
            if (sl.id < 0 || y < sl.y || y >= sl.y + stamps_[sl.id].h) continue;
            sig = (sig ^ ((uint32_t)(k + 1) << 28) ^ ((uint32_t)sl.id << 22) ^
                   ((uint32_t)(sl.x + 256) << 11) ^ (uint32_t)(y - sl.y)) * 16777619u;
            sig |= 1u;  // linha com carimbo nunca tem assinatura 0
        }
        return sig;
    }

    void buildScaled(const uint16_t* src)
    {
        uint16_t* d = lineBase_;
        int x = 0;
        while (x < gx_) d[x++] = 0;
        for (int sx = 0; sx < srcW_; sx++) {
            const int next = col_[sx + 1];
            const uint16_t px = src[sx];
            while (x < next) d[x++] = px;
        }
        while (x < tgtW_) d[x++] = 0;
    }

    // linha y pronta (base) + carimbos -> alvo
    void emit(int y, uint32_t sig, const uint16_t* base)
    {
        const uint16_t* out = base;
        if (sig != 0) {
            memcpy(lineMix_, base, (size_t)tgtW_ * 2);
            for (int k = 0; k < kMaxSlots; k++) {
                const Slot& sl = slots_[k];
                if (sl.id < 0) continue;
                const Stamp& st = stamps_[sl.id];
                const int ry = y - sl.y;
                if (ry < 0 || ry >= st.h) continue;
                const uint32_t* idx = (const uint32_t*)(scratch_ + st.off);
                const Run* runs = (const Run*)(scratch_ + st.off + 4u * (st.h + 1u));
                for (uint32_t r = idx[ry], re = idx[ry + 1]; r < re; r++) {
                    int x0 = sl.x + runs[r].x, x1 = x0 + runs[r].len;
                    if (x0 < 0) x0 = 0;
                    if (x1 > tgtW_) x1 = tgtW_;
                    if (x0 < x1) blendRun(lineMix_ + x0, runs[r].v, x1 - x0);
                }
            }
            out = lineMix_;
        }
        rowSig_[y] = sig;
        const NativeScreen* scr = scr_;
        if (scr->put != nullptr) scr->put(scr->putCtx, y, out);
        else memcpy(scr->px + (size_t)y * scr->stride, out, (size_t)tgtW_ * 2);
    }

    uint8_t* scratch_ = nullptr;
    uint32_t grabOff_ = 0, grabCap_ = 0, stampOff_ = 0, stampCap_ = 0, stampTop_ = 0;
    uint16_t* lineBase_ = nullptr;
    uint16_t* lineMix_ = nullptr;
    uint16_t* col_ = nullptr;
    int srcW_ = 0, srcH_ = 0, scaleW_ = 0, scaleH_ = 0;
    int tgtW_ = -1, tgtH_ = -1, gx_ = 0, gy_ = 0;
    int lastTarget_ = -1;
    bool force_ = true;
    const NativeScreen* scr_ = nullptr;
    uint16_t y0_[kMaxSrcH + 1] = {0};
    uint32_t rowHash_[kMaxSrcH] = {0};
    uint32_t rowSig_[kMaxH] = {0};
    Stamp stamps_[kMaxStamps] = {};
    Slot slots_[kMaxSlots] = {};
};

}  // namespace emu
