#pragma once

/**
 * @brief Conjunto pequeno de retangulos sujos (parte PURA do FrameSprite).
 *
 * Uma caixa unica (a uniao de tudo que mudou) e o pior caso de jogo: dois
 * sprites em cantos opostos sujavam o vidro INTEIRO e o present() copiava
 * ~460 KB de PSRAM por quadro na 4848 — o DMA do painel RGB, que varre o
 * framebuffer da mesma PSRAM, perdia banda e a imagem "vibrava em
 * flashes". Aqui ate K caixas convivem: um desenho novo funde-se a uma
 * caixa vizinha quando a area adicional compensa o push, cascateando; sem vaga,
 * entra na caixa que menos cresce. No take(), se as caixas cobrem quase a
 * uniao toda, sai so a uniao (um push grande custa menos que varios
 * sobrepostos).
 *
 * Header-only e sem LovyanGFX: roda no host (test/cpp/run_tests.cpp).
 * Coordenadas inclusivas (l,t)-(r,b), como o Panel_Sprite as entrega.
 */

#include <stdint.h>

namespace celer {

struct DirtyRect {
    int32_t l, t, r, b;  // inclusivo
};

template <int K>
class DirtyRects {
public:
    static constexpr int32_t kGap = 8;  // caixas vizinhas a < 8 px viram uma

    void clear() { _n = 0; }
    bool any() const { return _n > 0; }
    int count() const { return _n; }
    const DirtyRect& at(int i) const { return _rs[i]; }

    void markAll(int32_t w, int32_t h) {
        _rs[0] = {0, 0, w - 1, h - 1};
        _n = 1;
        _last = 0;
    }

    // alguma caixa comeca acima de y (a faixa da topbar foi suja)
    bool touchesAbove(int32_t y) const {
        for (int i = 0; i < _n; i++)
            if (_rs[i].t < y) return true;
        return false;
    }

    void add(int32_t l, int32_t t, int32_t r, int32_t b) {
        if (r < l || b < t) return;
        // caminho quente (pixel de estrela, glifo): cai dentro da ultima
        if (_last < _n) {
            const DirtyRect& q = _rs[_last];
            if (l >= q.l && t >= q.t && r <= q.r && b <= q.b) return;
        }
        const DirtyRect nr = {l, t, r, b};
        for (int i = 0; i < _n; i++) {
            if (worthMerging(_rs[i], nr)) {
                unite(_rs[i], nr);
                cascade(i);
                return;
            }
        }
        if (_n < K) {
            _rs[_n] = nr;
            _last = _n++;
            return;
        }
        // sem vaga: funde na caixa cuja area cresce menos
        int best = 0;
        int64_t bestGrow = -1;
        for (int i = 0; i < _n; i++) {
            DirtyRect u = _rs[i];
            unite(u, nr);
            const int64_t grow = area(u) - area(_rs[i]);
            if (bestGrow < 0 || grow < bestGrow) {
                bestGrow = grow;
                best = i;
            }
        }
        unite(_rs[best], nr);
        cascade(best);
    }

    // Recorta ao painel (pw x ph) e entrega as caixas em out[] (>= K), ou
    // so a uniao quando elas ja cobrem >= 3/4 dela. Zera o conjunto.
    int take(DirtyRect* out, int32_t pw, int32_t ph) {
        int m = 0;
        int64_t sum = 0;
        DirtyRect u = {0, 0, -1, -1};
        for (int i = 0; i < _n; i++) {
            DirtyRect c = _rs[i];
            if (c.l < 0) c.l = 0;
            if (c.t < 0) c.t = 0;
            if (c.r >= pw) c.r = pw - 1;
            if (c.b >= ph) c.b = ph - 1;
            if (c.r < c.l || c.b < c.t) continue;
            if (m == 0) u = c;
            else unite(u, c);
            sum += area(c);
            out[m++] = c;
        }
        _n = 0;
        _last = 0;
        if (m > 1 && sum * 4 >= area(u) * 3) {
            out[0] = u;
            m = 1;
        }
        return m;
    }

private:
    DirtyRect _rs[K];
    int _n = 0;
    int _last = 0;

    static int64_t area(const DirtyRect& a) {
        return (int64_t)(a.r - a.l + 1) * (int64_t)(a.b - a.t + 1);
    }
    static bool worthMerging(const DirtyRect& a, const DirtyRect& b) {
        if (b.l > a.r + kGap || b.r < a.l - kGap || b.t > a.b + kGap || b.b < a.t - kGap)
            return false;
        // Spans alinhados e contiguos: a uniao nao inclui pixels extras.
        if ((a.l == b.l && a.r == b.r && b.t <= a.b + 1 && a.t <= b.b + 1) ||
            (a.t == b.t && a.b == b.b && b.l <= a.r + 1 && a.l <= b.r + 1)) return true;
        DirtyRect u = a;
        unite(u, b);
        // Dois lados de uma moldura se tocam, mas a caixa deles pode cobrir
        // o painel inteiro. Aceita alguma folga para amortizar um push curto.
        const int64_t aa = area(a), ab = area(b);
        // A folga depende da menor caixa. Usa-la sobre a soma deixava um
        // pixel por vez inflar a diagonal ate a tela inteira.
        const int64_t smaller = aa < ab ? aa : ab;
        return area(u) <= aa + ab + smaller / 4 + 32;
    }
    static void unite(DirtyRect& a, const DirtyRect& b) {
        if (b.l < a.l) a.l = b.l;
        if (b.t < a.t) a.t = b.t;
        if (b.r > a.r) a.r = b.r;
        if (b.b > a.b) a.b = b.b;
    }
    // a caixa i cresceu: engole as vizinhas que passou a tocar
    void cascade(int i) {
        bool merged = true;
        while (merged) {
            merged = false;
            for (int j = 0; j < _n; j++) {
                if (j == i || !worthMerging(_rs[i], _rs[j])) continue;
                unite(_rs[i], _rs[j]);
                _rs[j] = _rs[_n - 1];
                _n--;
                if (i == _n) i = j;  // a caixa i foi movida para o buraco
                merged = true;
                break;
            }
        }
        _last = i;
    }
};

}  // namespace celer
