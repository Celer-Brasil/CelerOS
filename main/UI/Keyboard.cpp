#include "Keyboard.h"

#include <Arduino.h>
#include <LovyanGFX.hpp>
#include <cstring>
#include "esp_task_wdt.h"

namespace kui {

// ---- keysets ---------------------------------------------------------------
// Letras em minusculo (Upper aplica toupper ao desenhar/digitar). Simbolos
// cobrem todo o ASCII imprimivel entre as duas paginas (chars comuns de
// senha se repetem entre paginas de proposito). A pagina de acentos cobre
// os diacriticos PT-BR uteis (literais em UTF-8; o glifo vive na DejaVu).

static const char* LET_ROWS[3] = {"qwertyuiop", "asdfghjkl", "zxcvbnm"};
static const char* SY1_ROWS[3] = {"1234567890", "@#$%&-+()/", "*\"':;!?"};
static const char* SY2_ROWS[3] = {"~`|\\_<>[]{", "}=^*\"'-+/", "*\"'=+!?"};
// Pagina de acentos: literais UTF-8 estaticos (a tecla aponta p/ a flash)
static const char* AC_ROWS[3][5] = {
    {"á", "à", "â", "ã", nullptr},
    {"é", "ê", "í", "ó", "ô"},
    {"õ", "ú", "ü", "ç", nullptr},
};

// ---- glifos desenhados (fontes nativas nao tem setas) ----------------------
// Setinha de shift (contorno, cheia quando ativo) e backspace classico
// (pentagono com X), dimensionados pela menor face da tecla.

static void drawShiftGlyph(Canvas& c, const Rect& r, uint32_t col, bool filled) {
    const int cx = r.x + r.w / 2;
    const int cy = r.y + r.h / 2;
    const int s = r.w < r.h ? r.w : r.h;
    const int hw = s * 3 / 10;   // meia-largura da cabeca
    const int hh = s * 3 / 10;   // altura da cabeca
    const int sw = s / 8;        // meia-largura da haste
    const int sh = s * 3 / 10;   // profundidade da haste
    if (filled) {
        c.fillTriangle(cx, cy - hh, cx - hw, cy + sw, cx + hw, cy + sw, col);
        c.fillRect({cx - sw, cy, 2 * sw, sh}, col);
        return;
    }
    c.drawLine(cx, cy - hh, cx - hw, cy, col);           // ombro esquerdo
    c.drawLine(cx - hw, cy, cx - sw, cy, col);
    c.drawLine(cx - sw, cy, cx - sw, cy + sh, col);      // desce a haste
    c.drawLine(cx - sw, cy + sh, cx + sw, cy + sh, col);
    c.drawLine(cx + sw, cy + sh, cx + sw, cy, col);      // sobe a haste
    c.drawLine(cx + sw, cy, cx + hw, cy, col);
    c.drawLine(cx + hw, cy, cx, cy - hh, col);           // ombro direito
}

static void drawBackGlyph(Canvas& c, const Rect& r, uint32_t col) {
    const int cy = r.y + r.h / 2;
    const int s = r.w < r.h ? r.w : r.h;
    const int gw = s * 3 / 4;   // largura total do glifo
    const int hh = s / 4;       // meia-altura do corpo
    const int tip = s / 5;      // profundidade da ponta
    const int x0 = r.x + (r.w - gw) / 2;  // ponta (esquerda)
    const int xb = x0 + tip;              // inicio do corpo
    const int x1 = x0 + gw;               // direita
    c.drawLine(x0, cy, xb, cy - hh, col);
    c.drawLine(xb, cy - hh, x1, cy - hh, col);
    c.drawLine(x1, cy - hh, x1, cy + hh, col);
    c.drawLine(x1, cy + hh, xb, cy + hh, col);
    c.drawLine(xb, cy + hh, x0, cy, col);
    const int ccx = (xb + x1) / 2;        // X dentro do corpo
    const int k = s / 8;
    c.drawLine(ccx - k, cy - k, ccx + k, cy + k, col);
    c.drawLine(ccx - k, cy + k, ccx + k, cy - k, col);
}

// ============================================================ KeyboardScreen

KeyboardScreen::KeyboardScreen(const std::string& prompt, const std::string& initial, int maxLen)
    : m_prompt(prompt), m_text(initial), m_maxLen(maxLen > 0 ? maxLen : 64) {
    if (m_maxLen > 256) m_maxLen = 256;
    rebuild();
}

void KeyboardScreen::setHint(char h) {
    m_hint = h;
    // abre ja na pagina do hint (so quando ainda esta no modo inicial)
    if (m_hint == 'n' && m_mode == Lower) m_mode = Num;
    rebuild();
}

Rect KeyboardScreen::fieldRect() const {
    int m = UI::sx(4);
    return {m, UI::sy(26), UI::W - 2 * m, UI::sy(26)};
}

Rect KeyboardScreen::cancelRect() const {
    int m = UI::sx(4);
    int h = UI::sy(20);
    if (h < 20) h = 20;  // piso fisico: alvo de toque (CYD landscape sy(20)=15)
    // inset: vidro de cantos arredondados (watch) — mesmo recuo do X do
    // topbar (Layout.h hitTopbarExit) e do glifo de rede do relogio
    return {UI::W - m - UI::sx(34) - UI::inset, UI::sy(2), UI::sx(34), h};
}

Rect KeyboardScreen::eyeRect() const {
    // botao ver/ocu do mask, a esquerda do X na mesma faixa do cabecalho
    Rect xr = cancelRect();
    return {xr.x - UI::sx(4) - UI::sx(30), xr.y, UI::sx(30), xr.h};
}

const char* KeyboardScreen::modeLabel() const {
    if (m_mode == Num) return "ABC";
    if (isLetters(m_mode)) return (m_hint == 'n') ? "123" : "?123";
    return (m_mode == Accents) ? "ABC" : "àç";
}

// Hit-test com snap: a tecla mais proxima vence se o toque cair a ate ~1
// unidade/4 fora dela (perdoa gap de 2px e beirada do bloco — zona morta
// nao existe); alem disso (ex.: eco do Terminal acima do teclado) = nada.
int KeyboardScreen::keyAt(int x, int y) const {
    const int snap = m_keyW / 4 + UI::sx(3);
    int best = -1;
    int bestD = snap + 1;
    for (int i = 0; i < (int)m_keys.size(); i++) {
        const Rect& r = m_keys[i].r;
        int dx = (x < r.x) ? r.x - x : (x >= r.x + r.w) ? x - (r.x + r.w) + 1 : 0;
        int dy = (y < r.y) ? r.y - y : (y >= r.y + r.h) ? y - (r.y + r.h) + 1 : 0;
        int d = dx > dy ? dx : dy;
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    }
    return best;
}

// Apaga 1 codepoint: remove a sequencia UTF-8 inteira (acento = 2 bytes)
void KeyboardScreen::backspace() {
    if (m_text.empty()) return;
    m_text.pop_back();
    while (!m_text.empty()) {
        unsigned char b = (unsigned char)m_text.back();
        if (b >= 0x80 && b < 0xC0) m_text.pop_back();  // byte de continuacao
        else break;
    }
    if (onChange) onChange();
}

void KeyboardScreen::rebuild() {
    m_keys.clear();

    const int g = UI::sx(2);
    // unidade = largura de uma tecla da linha de cima (10 keys)
    const int u = (UI::W - 2 * UI::sx(4) - 9 * g) / 10;
    if (u < 4) return;  // display impossivel: sem keys, so field
    m_keyW = u;

    const int rowGap = UI::sy(2);
    // Tecla com proporcao fixa (~1.25x a largura), bloco ancorado no rodape:
    // preencher o resto da tela virava tecla de 90px+ (teclado comendo a tela
    // no 480x480). O espaco que sobra fica entre o campo e as teclas.
    const int bottom = UI::H - UI::sy(4);
    int keyH = u + u / 4;
    int top = bottom - (4 * keyH + 3 * rowGap);
    const int minTop = m_showField ? fieldRect().y + fieldRect().h + UI::sy(5) : UI::sy(2);
    // Tela baixa com campo (CYD landscape): estica as teclas ate encostar no
    // campo em vez de deixar uma faixa morta no meio da tela — com teto de
    // 5/3 da largura para nao reincidir no "teclado comendo a tela". Sem
    // campo (Terminal acoplado) nada muda: o app precisa do espaco de eco.
    if (m_showField && top > minTop) {
        int fillH = (bottom - minTop - 3 * rowGap) / 4;
        const int cap = u * 5 / 3;
        if (fillH > cap) fillH = cap;
        if (fillH > keyH) {
            keyH = fillH;
            top = bottom - (4 * keyH + 3 * rowGap);
        }
    }
    if (top < minTop) {  // pouco espaco: encolhe as teclas para caber
        top = minTop;
        keyH = (bottom - top - 3 * rowGap) / 4;
        if (keyH < 12) keyH = 12;  // display minimo: deixa transbordar
    }
    m_keysTop = top;

    // Rotulo por tamanho fisico da tecla: DejaVu24 quando a tecla e larga o
    // bastante (CYD landscape ~29px; o 480x480 ja entra nisso via UI::big)
    m_labelFont = (!UI::big && u >= 26) ? 4 : UI::font(2);
    m_legendFont = (m_labelFont >= 4) ? 2 : 1;

    auto addRow = [&](int row, const float* wu, int n, const Kind* kinds, const char* chars) {
        float units = 0;
        for (int i = 0; i < n; i++) units += wu[i];
        int total = (int)(units * u) + (n - 1) * g;
        int x = (UI::W - total) / 2;
        int y = top + row * (keyH + rowGap);
        for (int i = 0; i < n; i++) {
            int w = (int)(wu[i] * u);
            m_keys.push_back({{x, y, w, keyH}, kinds[i], chars ? chars[i] : '\0', nullptr});
            x += w + g;
        }
    };

    if (m_mode == Accents) {
        // Pagina de acentos: teclas 2u (alvos generosos para o resistivo),
        // agrupadas por vogal; rotulo e saida vem dos literais estaticos
        auto addSymRow = [&](int row, const char* const* syms, int n) {
            const int w = 2 * u;
            int total = n * w + (n - 1) * g;
            int x = (UI::W - total) / 2;
            int y = top + row * (keyH + rowGap);
            for (int i = 0; i < n; i++) {
                m_keys.push_back({{x, y, w, keyH}, KChar, 0, syms[i]});
                x += w + g;
            }
        };
        addSymRow(0, AC_ROWS[0], 4);
        addSymRow(1, AC_ROWS[1], 5);
        // linha 2: acentos + backspace alinhado a direita como nas outras
        const int bw = (int)(1.5f * u);
        const int bkspX = UI::W - UI::sx(4) - bw;
        const int avail = bkspX - g - UI::sx(4);
        const int total = 4 * (2 * u) + 3 * g;
        int x = UI::sx(4) + (avail - total) / 2;
        if (x < UI::sx(4)) x = UI::sx(4);
        int y2 = top + 2 * (keyH + rowGap);
        for (int i = 0; i < 4; i++) {
            m_keys.push_back({{x, y2, 2 * u, keyH}, KChar, 0, AC_ROWS[2][i]});
            x += 2 * u + g;
        }
        m_keys.push_back({{bkspX, y2, bw, keyH}, KBksp, 0, nullptr});
        // linha 3 padrao
        float w3[5] = {1.5f, 1, 4, 1, 1.5f};
        Kind k3[5] = {KMode, KChar, KSpace, KChar, KOk};
        char c3[5] = {0, ',', 0, '.', 0};
        addRow(3, w3, 5, k3, c3);
        return;
    }

    if (m_mode == Num) {
        // Pagina numerica (hint "num"): discagem 3x3 com alvos 2.5u + linha
        // [ABC][0][backspace][OK]. Sem espaco/pontuacao — quem pede hint num
        // valida digitos; a tecla ABC segue ai porque hint e sugestao.
        float d3[3] = {2.5f, 2.5f, 2.5f};
        Kind kc[3] = {KChar, KChar, KChar};
        const char* digRows[3] = {"123", "456", "789"};
        addRow(0, d3, 3, kc, digRows[0]);
        addRow(1, d3, 3, kc, digRows[1]);
        addRow(2, d3, 3, kc, digRows[2]);
        float w4[4] = {1.5f, 2.5f, 1.5f, 2.0f};
        Kind k4[4] = {KMode, KChar, KBksp, KOk};
        char c4[4] = {0, '0', 0, 0};
        addRow(3, w4, 4, k4, c4);
        return;
    }

    const bool letters = isLetters(m_mode);
    const char* const* rows = (m_mode == Sym1) ? SY1_ROWS : (m_mode == Sym2) ? SY2_ROWS : LET_ROWS;

    // linhas 0/1: so caracteres, centradas (9 keys na do meio = escalonado)
    float one10[10] = {1, 1, 1, 1, 1, 1, 1, 1, 1, 1};
    float one9[9] = {1, 1, 1, 1, 1, 1, 1, 1, 1};
    Kind kChar[10] = {KChar, KChar, KChar, KChar, KChar, KChar, KChar, KChar, KChar, KChar};
    addRow(0, one10, (int)strlen(rows[0]), kChar, rows[0]);
    addRow(1, one9, (int)strlen(rows[1]), kChar, rows[1]);

    // linha 2: [shift/simbolos 1.5u] chars [backspace 1.5u]
    float w2[9] = {1.5f, 1, 1, 1, 1, 1, 1, 1, 1.5f};
    Kind k2[9] = {letters ? KShift : KSymPage, KChar, KChar, KChar, KChar, KChar, KChar, KChar, KBksp};
    char c2[9] = {0, 0, 0, 0, 0, 0, 0, 0, 0};
    for (int i = 0; i < 7 && i < (int)strlen(rows[2]); i++) c2[i + 1] = rows[2][i];
    addRow(2, w2, 9, k2, c2);

    // linha 3: [modo] [,] [espaco 4u] [.] [OK]
    float w3[5] = {1.5f, 1, 4, 1, 1.5f};
    Kind k3[5] = {KMode, KChar, KSpace, KChar, KOk};
    char c3[5] = {0, ',', 0, '.', 0};
    addRow(3, w3, 5, k3, c3);
}

char KeyboardScreen::labelChar(char ch) const {
    if (m_mode == Upper && ch >= 'a' && ch <= 'z') return ch - ('a' - 'A');
    return ch;
}

void KeyboardScreen::draw(Canvas& c) {
    // Render em faixas (CYD sem PSRAM): draw() roda uma vez por faixa e o
    // visible() faz cada faixa pagar so o que cruza — sem isso eram ~20
    // passadas x todas as teclas por redraw (cursor piscando inclusive).
    Rect f = fieldRect();
    if (m_showField) {
        // cabecalho: prompt (esquerda, cortado se nao couber) + ver/ocu (mask)
        // + X cancelar
        Rect xr = cancelRect();
        Rect hdr = {0, 0, UI::W, xr.y + xr.h};  // faixa toda do cabecalho
        if (c.visible(hdr)) {
            c.fillRoundRect(xr, UI::sx(6), THEME_CARD);
            c.drawRoundRect(xr, UI::sx(6), THEME_STROKE);
            c.text("X", xr.x + xr.w / 2, xr.y + xr.h / 2, UI::font(2), THEME_TEXT_DIM, MC_DATUM);

            int promptMaxX = xr.x;
            if (m_mask) {
                Rect er = eyeRect();
                promptMaxX = er.x;
                c.fillRoundRect(er, UI::sx(6), m_showPlain ? THEME_ACCENT : THEME_CARD);
                c.drawRoundRect(er, UI::sx(6), THEME_STROKE);
                c.text(m_showPlain ? "ocu" : "ver", er.x + er.w / 2, er.y + er.h / 2, UI::font(1),
                       m_showPlain ? THEME_ON_ACCENT : THEME_TEXT_DIM, MC_DATUM);
            }

            if (!m_prompt.empty()) {
                const int avail = promptMaxX - UI::sx(8);
                std::string p = m_prompt;
                if (c.textWidth(p.c_str(), UI::font(1)) > avail) {
                    const int dots = c.textWidth("..", UI::font(1));
                    while (!p.empty() && c.textWidth(p.c_str(), UI::font(1)) + dots > avail) {
                        p.pop_back();  // UTF-8: descarta continuacao junto
                        while (!p.empty() && ((unsigned char)p.back() & 0xC0) == 0x80) p.pop_back();
                    }
                    p += "..";
                }
                c.text(p, UI::sx(4), f.y / 2, UI::font(1), THEME_TEXT_DIM, ML_DATUM);
            }
        }

        if (c.visible(f)) {
            // campo de texto com cursor piscando; texto longo mostra o final.
            // Com mask, o campo mostra um bullet por codepoint (ver/ocu revela).
            c.fillRoundRect(f, UI::sx(6), THEME_CARD);
            c.drawRoundRect(f, UI::sx(6), THEME_STROKE);
            const int pad = UI::sx(8);
            const int avail = f.w - 2 * pad - UI::sx(4);
            std::string shown;
            if (m_mask && !m_showPlain) {
                size_t glyphs = 0;
                for (unsigned char ch : m_text) {
                    if ((ch & 0xC0) != 0x80) glyphs++;
                }
                shown.reserve(glyphs * 3);
                for (size_t i = 0; i < glyphs; i++) shown += "\xE2\x80\xA2";  // U+2022
            } else {
                shown = m_text;
            }
            while (!shown.empty() && c.textWidth(shown.c_str(), UI::font(2)) > avail) {
                // UTF-8: descarta bytes de continuacao junto com o glifo
                shown.erase(shown.begin());
                while (!shown.empty() && ((unsigned char)shown.front() & 0xC0) == 0x80) {
                    shown.erase(shown.begin());
                }
            }
            int ty = f.y + f.h / 2;
            if (!shown.empty()) {
                c.text(shown, f.x + pad, ty, UI::font(2), THEME_TEXT, ML_DATUM);
            }
            if (m_cursorOn) {
                int tw = c.textWidth(shown.c_str(), UI::font(2));
                int ch = c.fontHeight(CelerFont(UI::font(2)));
                c.fillRect({f.x + pad + tw + UI::sx(1), ty - ch / 2, UI::sx(2), ch}, THEME_ACCENT);
            }
        }
    }

    // teclas
    uint32_t now = millis();
    for (int i = 0; i < (int)m_keys.size(); i++) {
        const Key& k = m_keys[i];
        const Rect& r = k.r;
        if (!c.visible(r)) continue;
        bool flash = (i == m_flashKey && now - m_flashMs < 150) || isPressed(r);

        switch (k.kind) {
            case KOk:
                c.fillRoundRect(r, UI::sx(3), flash ? THEME_ACCENT_D : THEME_ACCENT);
                c.text("OK", r.x + r.w / 2, r.y + r.h / 2, m_labelFont, flash ? THEME_TEXT : THEME_ON_ACCENT,
                       MC_DATUM);
                break;
            case KChar: {
                char s[2] = {labelChar(k.ch), 0};
                c.fillRoundRect(r, UI::sx(3), flash ? THEME_ACCENT_D : THEME_CARD);
                c.drawRoundRect(r, UI::sx(3), THEME_STROKE);
                c.text(k.sym ? k.sym : s, r.x + r.w / 2, r.y + r.h / 2, m_labelFont, THEME_TEXT, MC_DATUM);
                break;
            }
            case KSpace:
                c.fillRoundRect(r, UI::sx(3), flash ? THEME_ACCENT_D : THEME_CARD);
                c.drawRoundRect(r, UI::sx(3), THEME_STROKE);
                c.text("space", r.x + r.w / 2, r.y + r.h / 2, m_legendFont, THEME_TEXT_DIM, MC_DATUM);
                break;
            case KShift:
                c.fillRoundRect(r, UI::sx(3), (m_mode == Upper || flash) ? THEME_ACCENT_D : THEME_CARD);
                c.drawRoundRect(r, UI::sx(3), THEME_STROKE);
                drawShiftGlyph(c, r, m_mode == Upper ? THEME_TEXT : THEME_TEXT_DIM, m_mode == Upper);
                if (m_capsLock && m_mode == Upper) {  // travado: pino sob a seta
                    const int s = r.w < r.h ? r.w : r.h;
                    const int bw = s * 2 / 5;
                    int bh = s / 12;
                    if (bh < 2) bh = 2;
                    c.fillRect({r.x + r.w / 2 - bw / 2, r.y + r.h - bh - r.h / 8, bw, bh}, THEME_ACCENT);
                }
                break;
            case KSymPage:
                c.fillRoundRect(r, UI::sx(3), flash ? THEME_ACCENT_D : THEME_CARD);
                c.drawRoundRect(r, UI::sx(3), THEME_STROKE);
                c.text(m_mode == Sym2 ? "?123" : "*+=", r.x + r.w / 2, r.y + r.h / 2, m_legendFont,
                       THEME_TEXT, MC_DATUM);
                break;
            case KBksp:
                c.fillRoundRect(r, UI::sx(3), flash ? THEME_ACCENT_D : THEME_CARD);
                c.drawRoundRect(r, UI::sx(3), THEME_STROKE);
                drawBackGlyph(c, r, flash ? THEME_TEXT : THEME_TEXT_DIM);
                break;
            case KMode:
                c.fillRoundRect(r, UI::sx(3), flash ? THEME_ACCENT_D : THEME_CARD);
                c.drawRoundRect(r, UI::sx(3), THEME_STROKE);
                c.text(modeLabel(), r.x + r.w / 2, r.y + r.h / 2, m_legendFont, THEME_TEXT, MC_DATUM);
                break;
        }
    }
}

bool KeyboardScreen::onTouch(const TouchEvent& ev) {
    if (m_done) return false;

    // press no backspace arma o auto-repeat (onTick dispara segurando)
    if (ev.type == TouchEvent::Press) {
        int idx = keyAt(ev.startX, ev.startY);
        if (idx >= 0 && m_keys[idx].kind == KBksp) {
            uint32_t now = millis();
            m_repeatArmMs = now ? now : 1;
            m_nextRepeatMs = m_repeatArmMs + 450;
            m_repeatCount = 0;
        }
        return idx >= 0;
    }
    if (ev.type != TouchEvent::Release) return false;  // arrasto: nada

    // Tap local SEM teto de tempo: no resistivo e normal segurar firme um
    // pouco mais (o isTap global corta em 800ms e o toque "sumia"). So nao
    // pode ter deslocado alem da tolerancia.
    if (abs(ev.dx()) >= TouchEvent::slopX() || abs(ev.dy()) >= TouchEvent::slopY()) return false;

    // Hit-test na posicao do POUSO: entre o press e o release o dedo deriva
    // (a tolerancia de tap e ~2 teclas na CYD) — mira onde o usuario pousou,
    // nao onde o dedo escorregou ao soltar.
    const int hx = ev.startX, hy = ev.startY;
    if (m_showField) {
        if (cancelRect().contains(hx, hy)) {
            finish(false);
            return true;
        }
        if (m_mask && eyeRect().contains(hx, hy)) {
            m_showPlain = !m_showPlain;
            markDirty();
            return true;
        }
    }
    int idx = keyAt(hx, hy);
    if (idx < 0) return false;
    if (m_keys[idx].kind == KBksp) {
        // repeat ja apagou durante o hold: o release nao apaga de novo
        if (m_repeatArmMs && millis() - m_repeatArmMs >= 450) {
            m_repeatArmMs = 0;
            return true;
        }
        m_repeatArmMs = 0;  // soltou rapido: repeat nao chega a rodar
    }
    handleKey(idx);
    return true;
}

void KeyboardScreen::handleKey(int idx) {
    const Key& k = m_keys[idx];
    m_flashKey = idx;
    m_flashMs = millis();
    m_blinkMs = 0;      // cursor solido enquanto digita (nao some no meio)
    m_cursorOn = true;
    markDirty();

    switch (k.kind) {
        case KChar:
            if ((int)m_text.size() < m_maxLen) {
                if (k.sym) m_text += k.sym;  // acento: literal UTF-8
                else m_text += labelChar(k.ch);
                if (m_mode == Upper && !m_capsLock) {  // shift one-shot
                    m_mode = Lower;
                    rebuild();
                }
                if (onChange) onChange();
            }
            break;
        case KSpace:
            if ((int)m_text.size() < m_maxLen) {
                m_text += ' ';
                if (onChange) onChange();
            }
            break;
        case KBksp:
            backspace();
            break;
        case KShift: {
            // toque simples alterna; toque duplo (<=400ms) trava o caps lock
            uint32_t now = millis();
            bool dbl = (m_mode == Upper && !m_capsLock && now - m_lastShiftMs < 400);
            m_lastShiftMs = now;
            if (dbl) {
                m_capsLock = true;
            } else {
                m_capsLock = false;
                m_mode = (m_mode == Upper) ? Lower : Upper;
            }
            rebuild();
            break;
        }
        case KSymPage:
            m_mode = (m_mode == Sym2) ? Sym1 : Sym2;
            rebuild();
            break;
        case KMode:
            if (m_hint == 'n') {
                // hint numerico: ciclo curto num <-> letras
                m_mode = (m_mode == Num) ? Lower : Num;
            } else if (isLetters(m_mode)) {
                // ciclo de paginas: ABC -> ?123 -> acentos -> ABC
                m_mode = Sym1;
            } else if (m_mode == Accents) {
                m_mode = Lower;
            } else {
                m_mode = Accents;
            }
            if (m_mode == Lower && m_capsLock) m_mode = Upper;  // caps volta travado
            rebuild();
            break;
        case KOk:
            if (m_persistent) {
                // acoplado: OK executa, nao encerra — o buffer zera e o
                // teclado segue aberto para o proximo comando/linha
                if (onEnter) onEnter(m_text);
                m_text.clear();
                if (m_mode == Upper && !m_capsLock) {  // shift nao "gruda"
                    m_mode = Lower;
                    rebuild();
                }
                markDirty();
            } else {
                finish(true);
            }
            break;
    }
}

void KeyboardScreen::finish(bool ok) {
    if (m_done) return;
    m_done = true;
    if (onResult) onResult(ok ? m_text : std::string(), ok);
}

void KeyboardScreen::onTick(uint32_t dtMs) {
    m_blinkMs += dtMs;
    if (m_blinkMs >= 530) {
        m_blinkMs = 0;
        m_cursorOn = !m_cursorOn;
        markDirty();
    }
    if (m_flashKey >= 0 && millis() - m_flashMs >= 150) {
        m_flashKey = -1;
        markDirty();
    }

    // Auto-repeat do backspace: dedo ainda seguro na tecla. Tolerancia de
    // deriva propria (segurar firme no resistivo sempre escorrega um pouco;
    // o isPressed global corta no primeiro arrasto). Todo TouchPump —
    // Navigator, getString e keypad JS — alimenta o touchState global.
    if (m_repeatArmMs) {
        const TouchState& t = touchState();
        int idx = keyAt(t.startX, t.startY);
        bool held = t.down && idx >= 0 && m_keys[idx].kind == KBksp &&
                    abs(t.x - t.startX) < UI::sx(12) && abs(t.y - t.startY) < UI::sy(12);
        if (!held) {
            m_repeatArmMs = 0;
        } else {
            uint32_t now = millis();
            if ((int32_t)(now - m_nextRepeatMs) >= 0) {
                backspace();
                // acelera depois das primeiras: apagar frase longa nao custa
                // um toque a cada 130ms ate o fim
                m_nextRepeatMs = now + (m_repeatCount >= 8 ? 80 : 130);
                m_repeatCount++;
                m_flashKey = idx;  // tecla segue "afundada" durante o repeat
                m_flashMs = now;
                markDirty();
            }
        }
    }
}

// ============================================================ getString =====

std::string getString(const std::string& initialText, const std::string& promptMsg, int maxLen, bool mask,
                      char hint, const std::function<bool()>& tick, bool* cancelled) {
    KeyboardScreen kb(promptMsg, initialText, maxLen);
    kb.setMask(mask);
    kb.setHint(hint);

    std::string result;
    bool done = false;
    bool ok = false;
    kb.onResult = [&](const std::string& text, bool confirmed) {
        result = text;
        ok = confirmed;
        done = true;
    };

    // Loop modal auto-contido: nao passa pelo Navigator para nao clobberar a
    // tela por baixo ao fechar (apps JS redesenham por conta propria).
    Canvas canvas(Board::display());
    TouchPump pump;
    while (!done) {
        esp_task_wdt_reset();  // digitacao pode levar mais que o WDT (15s)
        if (tick && !tick()) break;  // quem chamou pediu para encerrar (cancelado)
        pump.poll([&](const TouchEvent& ev) {
            kb.onTouch(ev);
            if (ev.type != TouchEvent::Drag) kb.markDirty();  // tecla "afunda"
        });
        kb.onTick(5);
        if (kb.consumeDirty()) canvas.render([&](Canvas& c) { kb.draw(c); });
        delay(5);
    }
    if (cancelled) *cancelled = !ok;  // X, ou o tick abortou (done fica false)
    return ok ? result : std::string();
}

}  // namespace kui
