// Toolkit de UI imediato para apps JS (API 22): objeto global `UI`.
//
// Modo imediato no loop bloqueante de sempre:
//   while (true) {
//       var full = UI.begin(T.bg);          // le o toque 1x; true = redesenho total
//       if (full) { ...desenho custom... }  // primitivas do app
//       if (UI.button("Salvar", 20, 260, 200, 40)) salvar();
//       UI.end();                           // present + ritmo (~30 fps)
//   }
//
// Os widgets SEMPRE fazem hit-test; DESENHAM so no frame total ou quando o
// proprio estado visual mudou (press, arrasto, valor, texto) — limpando so o
// proprio retangulo com o fundo corrente (principio 4 do Kui). Na CYD (sem
// quadro PSRAM, desenho direto no vidro) isso evita o pisca de redesenhar a
// tela a cada press; com quadro o FrameSprite ja empurra so a caixa suja.
// Um tap que dispara acao marca o PROXIMO frame como total (a acao do app
// quase sempre muda a tela).
//
// O visual vem dos pintores do Kui (kui::paint) — mesmos das telas nativas.
// Coordenadas JS virtuais 240x320 -> fisicas por jsx/jsy/jsH (JsInternal.h).
// Estado por widget numa tabela fixa de slots (id = hash de geometria ou id
// explicito), zerada no init de cada app.

#include "JsInternal.h"
#include "../UI/Kui.h"
#include "../Display/Icon.h"
#include "../Display/Theme.h"
#include <cmath>
#include <cstring>

#include "esp_attr.h"

namespace {

// ------------------------------------------------------------- toque ----
struct UiTouch {
    bool down = false;      // dedo no vidro neste frame
    bool moved = false;     // saiu da tolerancia de tap (virou arrasto)
    bool released = false;  // soltou neste frame
    bool tap = false;       // released && !moved && rapido
    int x = 0, y = 0;       // posicao atual (ultima conhecida apos soltar)
    int px = 0, py = 0;     // posicao do frame anterior (delta de arrasto)
    int sx = 0, sy = 0;     // posicao do pouso
    uint32_t t0 = 0;        // ms do pouso
};
UiTouch s_t;

constexpr int kSlop = 18;       // tolerancia de tap (virtual, = TouchEvent)
constexpr int kTapMaxMs = 800;

// ------------------------------------------------------------- slots ----
struct Slot {
    uint32_t id = 0;
    uint32_t frame = 0;      // ultimo frame em que o widget foi chamado
    int32_t vis = 0;         // assinatura do ultimo desenho
    bool drawn = false;      // ja desenhou desde que o slot nasceu
    float scroll = 0, vel = 0;
    bool drag = false;
    uint32_t lastMs = 0;
    int16_t bx = 0, by = 0, bw = 0, bh = 0;  // bbox fisico do ultimo texto
};
constexpr int kSlots = 48;
EXT_RAM_BSS_ATTR Slot s_slots[kSlots];  // ~1,9 KB: PSRAM quando existe

uint32_t s_frameNo = 0;
bool s_full = true;         // proximo begin redesenha tudo
bool s_drawFull = true;     // frame corrente e total
bool s_tapUsed = false;     // um tap dispara um widget so
uint32_t s_lastEndMs = 0;

constexpr int kBgDepth = 8;
uint32_t s_bg[kBgDepth];    // pilha de fundo (RGB888): tela, cards
int s_bgDepth = 0;

// Viewport do scroll aberto (virtual): toque fora dele nao vale para widgets
// de dentro (conteudo recortado nao pode receber tap)
bool s_scrollOpen = false;
int s_svx = 0, s_svy = 0, s_svw = 0, s_svh = 0;
Slot* s_scrollSlot = nullptr;
int s_scrollContentH = 0;
int32_t s_savedClip[4] = {0, 0, 0, 0};

#if CONFIG_CELEROS_UI_EXTRAS
// Pilha de recorte (UI.clip/unclip): cada entrada guarda o recorte ANTERIOR.
// s_clipBase e' o recorte de um frame que fechou sem clip aberto — o begin
// seguinte volta para ele se o app quebrou no meio de um clip (mesma cura do
// scroll). Sem isso, um throw entre clip/unclip deixaria o vidro recortado.
constexpr int kClipDepth = 8;
int32_t s_clipStack[kClipDepth][4];
int s_clipDepth = 0;
int32_t s_clipBase[4] = {0, 0, 0, 0};
bool s_clipBaseOk = false;
#endif

// Toast do app (UI.toast): pilula sobre o frame, redesenhada a cada UI.end
// (widgets que se redesenham por baixo nao a apagam); ao vencer, frame total
char s_toastMsg[96] = {0};
uint32_t s_toastUntil = 0;

uint32_t fnv(const char* s, uint32_t h = 2166136261u) {
    while (s && *s) {
        h ^= (uint8_t)*s++;
        h *= 16777619u;
    }
    return h;
}
uint32_t fnvInt(int v, uint32_t h) {
    for (int i = 0; i < 4; i++) {
        h ^= (uint8_t)(v >> (i * 8));
        h *= 16777619u;
    }
    return h;
}
uint32_t rectId(const char* kind, int x, int y, int w, int h) {
    uint32_t k = fnv(kind);
    k = fnvInt(x, k);
    k = fnvInt(y, k);
    k = fnvInt(w, k);
    return fnvInt(h, k) | 1u;  // 0 = slot livre
}

Slot& slot(uint32_t id) {
    Slot* free = nullptr;
    Slot* oldest = &s_slots[0];
    for (auto& s : s_slots) {
        if (s.id == id) {
            s.frame = s_frameNo;
            return s;
        }
        if (s.id == 0 && free == nullptr) free = &s;
        // despejo: o de quadro mais antigo; no empate, o sem rolagem viva
        if (s.frame < oldest->frame ||
            (s.frame == oldest->frame && oldest->scroll != 0 && s.scroll == 0)) oldest = &s;
    }
    Slot* s = free ? free : oldest;
    *s = Slot();
    s->id = id;
    s->frame = s_frameNo;
    return *s;
}

// Desenha agora? frame total ou assinatura visual nova. clear = limpar o
// proprio retangulo antes (frame parcial).
bool needDraw(Slot& s, int32_t vis, bool* clear) {
    bool d = s_drawFull || !s.drawn || s.vis != vis;
    *clear = d && !s_drawFull;
    s.vis = vis;
    s.drawn = true;
    return d;
}

uint32_t bg() { return s_bgDepth > 0 ? s_bg[s_bgDepth - 1] : THEME_BG; }

bool inR(int px, int py, int x, int y, int w, int h) { return px >= x && px < x + w && py >= y && py < y + h; }

// O pouso vale para widgets (fora do viewport de um scroll aberto = nao)
bool startOk() { return !s_scrollOpen || inR(s_t.sx, s_t.sy, s_svx, s_svy, s_svw, s_svh); }

// Estado "afundado": dedo parado que pousou e continua no retangulo
bool pressedIn(int x, int y, int w, int h) {
    return s_t.down && !s_t.moved && startOk() && inR(s_t.sx, s_t.sy, x, y, w, h) && inR(s_t.x, s_t.y, x, y, w, h);
}

// Tap consumivel no retangulo; marca o proximo frame como total
bool tapIn(int x, int y, int w, int h) {
    if (!s_t.tap || s_tapUsed || !startOk()) return false;
    if (!inR(s_t.sx, s_t.sy, x, y, w, h) || !inR(s_t.x, s_t.y, x, y, w, h)) return false;
    s_tapUsed = true;
    s_full = true;
    return true;
}

// ----------------------------------------------------------- opcoes JS ----
// optInt/optBool/optStr/optColor/argStr/requireText vieram para o
// JsInternal.h (compartilhados com os demais modulos do runtime).

const lgfx::IFont* roleFont(const char* role) {
    if (role) {
        if (!strcmp(role, "caption")) return kui::type::caption();
        if (!strcmp(role, "title")) return kui::type::title();
        if (!strcmp(role, "display")) return kui::type::display();
    }
    return kui::type::body();
}

// Fisico <-> virtual
kui::Rect pr(int x, int y, int w, int h) { return {jsx(x), jsy(y), jsx(w), jsH(h)}; }
int vW(int physW) { return (int)((long)physW * 240 / UI::W); }
int vH(int physH) { return (int)(physH / appScaleY() + 0.5f); }

// Estado de texto/fonte/recorte do app intacto em volta do desenho do toolkit.
// Diferente do GfxStateGuard: o recorte do sistema (topbar no desenho direto)
// FICA — o toolkit desenha dentro do que o app pode desenhar.
struct UiGuard {
    lgfx::LGFXBase& g;
    lgfx::TextStyle style;
    const lgfx::IFont* font;
    int32_t cx, cy, cw, ch;
    explicit UiGuard(lgfx::LGFXBase& t) : g(t), style(t.getTextStyle()), font(t.getFont()) {
        g.getClipRect(&cx, &cy, &cw, &ch);
        g.setTextSize(1);
    }
    ~UiGuard() {
        g.setTextStyle(style);
        g.setFont(font);
        g.setClipRect(cx, cy, cw, ch);
    }
    // recorte = intersecao do recorte do app com r (fisico)
    void clip(const kui::Rect& r) {
        int x0 = r.x > cx ? r.x : cx, y0 = r.y > cy ? r.y : cy;
        int x1 = (r.x + r.w) < (cx + cw) ? (r.x + r.w) : (cx + cw);
        int y1 = (r.y + r.h) < (cy + ch) ? (r.y + r.h) : (cy + ch);
        if (x1 < x0) x1 = x0;
        if (y1 < y0) y1 = y0;
        g.setClipRect(x0, y0, x1 - x0, y1 - y0);
    }
    void unclip() { g.setClipRect(cx, cy, cw, ch); }
    UiGuard(const UiGuard&) = delete;
    UiGuard& operator=(const UiGuard&) = delete;
};

// Fisica de rolagem compartilhada (lista e scroll): arrasto com media movel
// da velocidade, fling no release e atrito. Devolve true se o pouso foi
// dentro e o gesto e arrasto (o tap fica para quem chamou).
void scrollPhysics(Slot& s, int x, int y, int w, int h, int contentH) {
    uint32_t now = millis();
    uint32_t dt = s.lastMs ? now - s.lastMs : 0;
    s.lastMs = now;
    const bool mine = inR(s_t.sx, s_t.sy, x, y, w, h);
    if (s_t.down && mine) {
        if (s_t.moved) {
            float dy = (float)(s_t.y - s_t.py);
            s.scroll -= dy;
            if (dt > 0) s.vel = 0.6f * s.vel + 0.4f * (-dy / (float)dt);
            s.drag = true;
        } else {
            s.vel = 0;  // toque segura a inercia
        }
    } else if (s_t.released && mine && s.drag) {
        s.drag = false;
        if (s.vel > 3.0f) s.vel = 3.0f;
        if (s.vel < -3.0f) s.vel = -3.0f;
    } else if (!s_t.down) {
        s.drag = false;
        if (std::fabs(s.vel) >= 0.02f && dt > 0) {
            if (dt > 50) dt = 50;
            s.scroll += s.vel * (float)dt;
            s.vel *= std::pow(0.995f, (float)dt);
        } else {
            s.vel = 0;
        }
    }
    int maxS = contentH - h;
    if (maxS < 0) maxS = 0;
    if (s.scroll < 0) { s.scroll = 0; s.vel = 0; }
    if (s.scroll > maxS) { s.scroll = (float)maxS; s.vel = 0; }
}

// Escurece o quadro PSRAM abaixo da topbar (fundo de modal)
void dimFrame() {
    if (s_frame == nullptr || JSBindings::gfx() != s_frame) return;
    uint16_t* p = (uint16_t*)s_frame->getBuffer();
    if (p == nullptr) return;
    const int w = s_frame->width(), h = s_frame->height();
    int y0 = jsy(0);
    if (y0 < 0) y0 = 0;
    for (size_t i = (size_t)y0 * w, n = (size_t)w * h; i < n; i++) {
        uint16_t c = (uint16_t)((p[i] >> 8) | (p[i] << 8));
        c = (uint16_t)(((c >> 2) & 0x39E7) + ((c >> 3) & 0x18E3));
        p[i] = (uint16_t)((c >> 8) | (c << 8));
    }
    s_frameDirty = true;  // buffer mexido por fora: push do quadro inteiro
}

}  // namespace

// ============================================================ reset ========

void JSBindings::uiReset() {
    s_t = UiTouch();
    for (auto& s : s_slots) s = Slot();
    s_frameNo = 0;
    s_full = true;
    s_drawFull = true;
    s_tapUsed = false;
    s_lastEndMs = 0;
    s_bgDepth = 0;
    s_scrollOpen = false;
    s_scrollSlot = nullptr;
    s_toastMsg[0] = 0;
    s_toastUntil = 0;
#if CONFIG_CELEROS_UI_EXTRAS
    s_clipDepth = 0;
    s_clipBaseOk = false;
#endif
}

// ============================================================ frame ========

duk_ret_t JSBindings::js_uiBegin(duk_context* ctx) {
    uint32_t bgc = duk_is_number(ctx, 0) ? jsc(duk_get_uint(ctx, 0)) : THEME_BG;
    // Erro do app (try/catch no frame) entre scrollBegin/scrollEnd: o recorte
    // do scroll ficou no alvo e s_scrollOpen vivo — sem isto todo frame
    // seguinte desenhava com o recorte do quadro que quebrou
    if (s_scrollOpen) {
        s_scrollOpen = false;
        s_scrollSlot = nullptr;
        if (tftInstance) gfx()->setClipRect(s_savedClip[0], s_savedClip[1], s_savedClip[2], s_savedClip[3]);
    }
    int jx = 0, jy = 0;
    bool touched = readAppTouch(ctx, &jx, &jy);  // present + topbar + exit
#if CONFIG_CELEROS_UI_EXTRAS
    // clip aberto de um frame que quebrou: volta ao recorte do ultimo frame
    // bom ANTES de guardar o novo (o present acima pode ter mexido nele)
    if (s_clipDepth > 0) {
        s_clipDepth = 0;
        if (tftInstance && s_clipBaseOk) {
            gfx()->setClipRect(s_clipBase[0], s_clipBase[1], s_clipBase[2], s_clipBase[3]);
        }
    }
    if (tftInstance) {
        gfx()->getClipRect(&s_clipBase[0], &s_clipBase[1], &s_clipBase[2], &s_clipBase[3]);
        s_clipBaseOk = true;
    }
#endif
    uint32_t now = millis();

    const bool wasDown = s_t.down;
    s_t.px = s_t.x;
    s_t.py = s_t.y;
    s_t.released = false;
    s_t.tap = false;
    if (touched) {
        if (!wasDown) {
            s_t.sx = s_t.px = jx;
            s_t.sy = s_t.py = jy;
            s_t.t0 = now;
            s_t.moved = false;
        }
        s_t.x = jx;
        s_t.y = jy;
        if (std::abs(jx - s_t.sx) > kSlop || std::abs(jy - s_t.sy) > kSlop) s_t.moved = true;
        s_t.down = true;
    } else {
        s_t.released = wasDown;
        s_t.down = false;
        s_t.tap = wasDown && !s_t.moved && (now - s_t.t0) < (uint32_t)kTapMaxMs;
    }

    s_frameNo++;
    s_tapUsed = false;
    s_drawFull = s_full;
    s_full = false;
    s_bgDepth = 1;
    s_bg[0] = bgc;
    s_scrollOpen = false;
    if (s_drawFull && tftInstance) gfx()->fillScreen(bgc);
    duk_push_boolean(ctx, s_drawFull ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_uiEnd(duk_context* ctx) {
    int fps = duk_is_number(ctx, 0) ? duk_get_int(ctx, 0) : 30;
    if (fps < 1) fps = 1;
    if (fps > 60) fps = 60;
    uint32_t now = millis();
    if (s_toastUntil != 0 && tftInstance) {
        if ((int32_t)(s_toastUntil - now) > 0) {
            lgfx::LGFXBase* g = gfx();
            UiGuard guard(*g);
            kui::Canvas c(*tftInstance, g);
            const lgfx::IFont* f = kui::type::body();
            std::string m = c.ellipsize(s_toastMsg, f, jsx(208));
            int tw = c.textWidth(m.c_str(), f) + jsx(32);
            kui::Rect r{(UI::W - tw) / 2, jsy(266), tw, jsH(32)};
            c.fillRoundRect(r, r.h / 2, THEME_RAISED);
            c.drawRoundRect(r, r.h / 2, THEME_ACCENT);
            c.text(m, r.x + r.w / 2, r.y + r.h / 2, f, THEME_TEXT, MC_DATUM);
        } else {
            s_toastUntil = 0;
            s_full = true;  // tira a pilula: redesenho total
        }
    }
    int wait = 1000 / fps - (int)(now - s_lastEndMs);
    if (wait < 0 || s_lastEndMs == 0) wait = 0;
    if (wait > 1000) wait = 1000;
    appWait(ctx, wait);  // present + GC + exit remoto
    s_lastEndMs = millis();
    return 0;
}

// UI.toast(msg, [ms]) -> aviso curto dentro do app (System.toast so aparece
// quando o app sai)
duk_ret_t JSBindings::js_uiToast(duk_context* ctx) {
    const char* msg = requireText(ctx, 0);
    int ms = duk_is_number(ctx, 1) ? duk_get_int(ctx, 1) : 1800;
    if (ms < 300) ms = 300;
    if (ms > 10000) ms = 10000;
    strncpy(s_toastMsg, msg, sizeof(s_toastMsg) - 1);
    s_toastMsg[sizeof(s_toastMsg) - 1] = 0;
    if (s_toastUntil != 0) s_full = true;  // troca de mensagem: limpa a anterior
    s_toastUntil = millis() + (uint32_t)ms;
    if (s_toastUntil == 0) s_toastUntil = 1;
    return 0;
}

// UI.touch() -> {down, x, y, tap, released, moved, sx, sy} do frame corrente (o que
// os widgets viram): widgets proprios do app e "persistir ao soltar"
duk_ret_t JSBindings::js_uiTouch(duk_context* ctx) {
    duk_push_object(ctx);
    putBool(ctx, "down", s_t.down);
    putInt(ctx, "x", s_t.x);
    putInt(ctx, "y", s_t.y);
    putBool(ctx, "tap", (s_t.tap && !s_tapUsed));
    putBool(ctx, "released", s_t.released);
    putBool(ctx, "moved", s_t.moved);
    putInt(ctx, "sx", s_t.sx);  // pouso: swipe = (x - sx, y - sy) no released
    putInt(ctx, "sy", s_t.sy);
    return 1;
}

duk_ret_t JSBindings::js_uiInvalidate(duk_context* ctx) {
    (void)ctx;
    s_full = true;
    return 0;
}

// ============================================================ texto ========

// UI.text(s, x, y, {role, color, align, w, lines, bg}) -> altura usada
duk_ret_t JSBindings::js_uiText(duk_context* ctx) {
    const char* str = requireText(ctx, 0);
    int x = duk_require_int(ctx, 1), y = duk_require_int(ctx, 2);
    const lgfx::IFont* f = roleFont(optStr(ctx, 3, "role", "body"));
    uint32_t color = optColor(ctx, 3, "color", THEME_TEXT);
    const char* align = optStr(ctx, 3, "align", "left");
    int maxW = optInt(ctx, 3, "w", 0);
    int lines = optInt(ctx, 3, "lines", 1);
    uint32_t bgc = optColor(ctx, 3, "bg", bg());
    if (lines < 1) lines = 1;
    if (lines > 64) lines = 64;
    int datum = TL_DATUM;
    if (!strcmp(align, "center")) datum = TC_DATUM;
    else if (!strcmp(align, "right")) datum = TR_DATUM;
    if (!tftInstance) {
        duk_push_int(ctx, 0);
        return 1;
    }

    lgfx::LGFXBase* g = gfx();
    const int lh = g->fontHeight(f);
    Slot& s = slot(rectId("text", x, y, optInt(ctx, 3, "id", 0), 0));
    uint32_t sig = fnv(str);
    sig = fnvInt((int)color, sig);
    sig = fnvInt((int)(intptr_t)f, sig);
    sig = fnvInt(maxW * 16 + lines, sig);
    sig = fnvInt(datum, sig);
    bool clear = false;
    if (!needDraw(s, (int32_t)sig, &clear)) {
        duk_push_int(ctx, vH(s.bh));
        return 1;
    }

    UiGuard guard(*g);
    kui::Canvas c(*tftInstance, g);
    if (clear && s.bw > 0) c.fillRect({s.bx, s.by, s.bw, s.bh}, bgc);

    const int px = jsx(x), py = jsy(y);
    const int pw = maxW > 0 ? jsx(maxW) : 0;
    int n = 1, widest = 0;
    if (pw > 0 && lines > 1) {
        auto ls = c.wrapText(str, f, pw, lines);
        n = (int)ls.size();
        for (int i = 0; i < n; i++) {
            c.text(ls[i], px, py + i * lh, f, color, datum);
            int tw = c.textWidth(ls[i].c_str(), f);
            if (tw > widest) widest = tw;
        }
        if (n == 0) n = 1;
    } else if (pw > 0) {
        std::string e = c.ellipsize(str, f, pw);
        c.text(e, px, py, f, color, datum);
        widest = c.textWidth(e.c_str(), f);
    } else {
        c.text(str, px, py, f, color, datum);
        widest = c.textWidth(str, f);
    }
    // bbox para limpar na proxima mudanca (cobre o alinhamento)
    int bx = px;
    if (datum == TC_DATUM) bx = px - widest / 2;
    else if (datum == TR_DATUM) bx = px - widest;
    s.bx = (int16_t)(bx - 1);
    s.by = (int16_t)py;
    s.bw = (int16_t)(widest + 2);
    s.bh = (int16_t)(n * lh);
    duk_push_int(ctx, vH(n * lh));
    return 1;
}

// UI.measure(s, role) -> largura virtual
duk_ret_t JSBindings::js_uiMeasure(duk_context* ctx) {
    const char* str = requireText(ctx, 0);
    const char* role = duk_is_string(ctx, 1) ? duk_get_string(ctx, 1) : "body";
    if (!tftInstance) {
        duk_push_int(ctx, 0);
        return 1;
    }
    duk_push_int(ctx, vW(gfx()->textWidth(str, roleFont(role))));
    return 1;
}

// UI.measureWrap(s, w, role) -> altura virtual do texto quebrado por palavra
// em largura w (ate 64 linhas) — layout de baloes/cards antes de desenhar
duk_ret_t JSBindings::js_uiMeasureWrap(duk_context* ctx) {
    const char* str = requireText(ctx, 0);
    int w = duk_require_int(ctx, 1);
    const char* role = duk_is_string(ctx, 2) ? duk_get_string(ctx, 2) : "body";
    if (!tftInstance || w <= 0) {
        duk_push_int(ctx, 0);
        return 1;
    }
    lgfx::LGFXBase* g = gfx();
    kui::Canvas c(*tftInstance, g);
    const lgfx::IFont* f = roleFont(role);
    int n = (int)c.wrapText(str, f, jsx(w), 64).size();
    if (n < 1) n = 1;
    duk_push_int(ctx, vH(n * g->fontHeight(f)));
    return 1;
}

// UI.lineHeight(role) -> altura virtual da linha
duk_ret_t JSBindings::js_uiLineHeight(duk_context* ctx) {
    const char* role = duk_is_string(ctx, 0) ? duk_get_string(ctx, 0) : "body";
    if (!tftInstance) {
        duk_push_int(ctx, 0);
        return 1;
    }
    duk_push_int(ctx, vH(gfx()->fontHeight(roleFont(role))));
    return 1;
}

// ============================================================ widgets ======

constexpr int kHeaderH = 40;

// UI.header(title, {sub, back}) -> true quando "voltar" foi tocado
duk_ret_t JSBindings::js_uiHeader(duk_context* ctx) {
    const char* title = requireText(ctx, 0);
    const char* sub = optStr(ctx, 1, "sub", "");
    bool back = optBool(ctx, 1, "back", false);
    bool tapped = back && tapIn(0, 0, kHeaderH + 8, kHeaderH);
    bool pressed = back && pressedIn(0, 0, kHeaderH + 8, kHeaderH);
    if (tftInstance) {
        Slot& s = slot(rectId("header", 0, 0, 240, kHeaderH));
        uint32_t sig = fnv(sub, fnv(title)) ^ (back ? 2u : 0u) ^ (pressed ? 1u : 0u);
        bool clear;
        if (needDraw(s, (int32_t)sig, &clear)) {
            lgfx::LGFXBase* g = gfx();
            UiGuard guard(*g);
            kui::Canvas c(*tftInstance, g);
            kui::paint::header(c, pr(0, 0, 240, kHeaderH), title, sub, back, pressed);
        }
    }
    duk_push_boolean(ctx, tapped ? 1 : 0);
    return 1;
}

// UI.button(label, x, y, w, h, {style, disabled, id}) -> true no tap
duk_ret_t JSBindings::js_uiButton(duk_context* ctx) {
    const char* label = requireText(ctx, 0);
    int x = duk_require_int(ctx, 1), y = duk_require_int(ctx, 2), w = duk_require_int(ctx, 3), h = duk_require_int(ctx, 4);
    const char* st = optStr(ctx, 5, "style", "primary");
    bool disabled = optBool(ctx, 5, "disabled", false);
    kui::paint::ButtonStyle style = kui::paint::BtnPrimary;
    if (!strcmp(st, "ghost")) style = kui::paint::BtnGhost;
    else if (!strcmp(st, "danger")) style = kui::paint::BtnDanger;
    if (disabled) style = kui::paint::BtnGhost;

    // cor propria (teclados de calculadora, jogos): fill + texto do app
    const int customFill = optInt(ctx, 5, "color", -1);
    const uint32_t customText = optColor(ctx, 5, "textColor", THEME_TEXT);
    const char* role = optStr(ctx, 5, "role", "body");

    bool tapped = !disabled && tapIn(x, y, w, h);
    bool pressed = !disabled && pressedIn(x, y, w, h);
    if (tftInstance) {
        Slot& s = slot(rectId("btn", x, y, w, h) ^ (uint32_t)optInt(ctx, 5, "id", 0));
        uint32_t sig = fnv(label) ^ ((uint32_t)style << 1) ^ (pressed ? 1u : 0u) ^ (disabled ? 8u : 0u);
        sig = fnvInt(customFill, fnvInt((int)customText, fnv(role, sig)));
        bool clear;
        if (needDraw(s, (int32_t)sig, &clear)) {
            lgfx::LGFXBase* g = gfx();
            UiGuard guard(*g);
            kui::Canvas c(*tftInstance, g);
            kui::Rect r = pr(x, y, w, h);
            if (clear) c.fillRect(r, bg());
            if (customFill >= 0 && !disabled) {
                uint32_t fill = jsc((uint32_t)customFill);
                if (pressed) fill = Icon::mix(fill, 0x000000, 70);
                const lgfx::IFont* f = roleFont(role);
                c.fillRoundRect(r, UI::sx(8), fill);
                if (pressed) c.drawRoundRect(r, UI::sx(8), THEME_ACCENT);
                c.text(c.ellipsize(label, f, r.w - UI::sx(8)), r.x + r.w / 2, r.y + r.h / 2, f, customText, MC_DATUM);
            } else {
                kui::paint::button(c, r, label, style, pressed, roleFont(role));
            }
            if (disabled) {
                // rotulo apagado por cima do ghost (sem estado no pintor)
                c.fillRoundRect({r.x + 1, r.y + 1, r.w - 2, r.h - 2}, UI::sx(8), THEME_CARD);
                c.text(c.ellipsize(label, kui::type::body(), r.w - UI::sx(8)), r.x + r.w / 2, r.y + r.h / 2,
                       kui::type::body(), THEME_TEXT_DIM, MC_DATUM);
            }
        }
    }
    duk_push_boolean(ctx, tapped ? 1 : 0);
    return 1;
}

// UI.toggle(x, y, on, {id}) -> novo estado (44x24 virtual; alvo com folga)
duk_ret_t JSBindings::js_uiToggle(duk_context* ctx) {
    int x = duk_require_int(ctx, 0), y = duk_require_int(ctx, 1);
    bool on = duk_to_boolean(ctx, 2) != 0;
    const int w = 44, h = 24, pad = 6;
    if (tapIn(x - pad, y - pad, w + 2 * pad, h + 2 * pad)) on = !on;
    bool pressed = pressedIn(x - pad, y - pad, w + 2 * pad, h + 2 * pad);
    if (tftInstance) {
        Slot& s = slot(rectId("tgl", x, y, w, h) ^ (uint32_t)optInt(ctx, 3, "id", 0));
        bool clear;
        if (needDraw(s, (on ? 1 : 0) | (pressed ? 2 : 0), &clear)) {
            lgfx::LGFXBase* g = gfx();
            UiGuard guard(*g);
            kui::Canvas c(*tftInstance, g);
            kui::Rect r = pr(x, y, w, h);
            if (clear) c.fillRect(r, bg());
            kui::paint::toggle(c, r, on, pressed);
        }
    }
    duk_push_boolean(ctx, on ? 1 : 0);
    return 1;
}

// UI.slider(x, y, w, value, {min, max, step}) -> valor (arrasto ao vivo)
duk_ret_t JSBindings::js_uiSlider(duk_context* ctx) {
    int x = duk_require_int(ctx, 0), y = duk_require_int(ctx, 1), w = duk_require_int(ctx, 2);
    double v = duk_require_number(ctx, 3);
    int mn = optInt(ctx, 4, "min", 0), mx = optInt(ctx, 4, "max", 100), step = optInt(ctx, 4, "step", 1);
    if (mx <= mn) mx = mn + 1;
    if (step < 1) step = 1;
    const int h = 28;
    // arrasto: dono e quem recebeu o pouso (mesmo saindo da faixa depois)
    bool active = s_t.down && startOk() && inR(s_t.sx, s_t.sy, x - 8, y, w + 16, h);
    if (active) {
        int rel = s_t.x - x;
        if (rel < 0) rel = 0;
        if (rel > w) rel = w;
        double nv = mn + (double)rel * (mx - mn) / (w > 0 ? w : 1);
        nv = mn + std::floor((nv - mn) / step + 0.5) * step;
        if (nv > mx) nv = mx;
        v = nv;
    }
    if (v < mn) v = mn;
    if (v > mx) v = mx;
    int pct = (int)((v - mn) * 100.0 / (mx - mn) + 0.5);
    if (tftInstance) {
        Slot& s = slot(rectId("sld", x, y, w, h) ^ (uint32_t)optInt(ctx, 4, "id", 0));
        bool clear;
        if (needDraw(s, pct | (active ? 0x1000 : 0), &clear)) {
            lgfx::LGFXBase* g = gfx();
            UiGuard guard(*g);
            kui::Canvas c(*tftInstance, g);
            kui::Rect r = pr(x, y, w, h);
            // o botao (raio 9) passa das pontas: limpa com folga
            if (clear) c.fillRect({r.x - UI::sy(10), r.y, r.w + 2 * UI::sy(10), r.h}, bg());
            kui::paint::slider(c, r, pct, active);
        }
    }
    duk_push_number(ctx, v);
    return 1;
}

// UI.progress(x, y, w, h, pct)
duk_ret_t JSBindings::js_uiProgress(duk_context* ctx) {
    int x = duk_require_int(ctx, 0), y = duk_require_int(ctx, 1), w = duk_require_int(ctx, 2), h = duk_require_int(ctx, 3);
    int pct = duk_require_int(ctx, 4);
    if (!tftInstance) return 0;
    Slot& s = slot(rectId("prg", x, y, w, h));
    bool clear;
    if (needDraw(s, pct, &clear)) {
        lgfx::LGFXBase* g = gfx();
        UiGuard guard(*g);
        kui::Canvas c(*tftInstance, g);
        kui::Rect r = pr(x, y, w, h);
        if (clear) c.fillRect(r, bg());
        kui::paint::progress(c, r, pct);
    }
    return 0;
}

// UI.spinner(cx, cy, r, color) — anima sozinho (redesenha a cada frame)
duk_ret_t JSBindings::js_uiSpinner(duk_context* ctx) {
    int cx = duk_require_int(ctx, 0), cy = duk_require_int(ctx, 1), r = duk_require_int(ctx, 2);
    uint32_t color = duk_is_number(ctx, 3) ? jsc(duk_get_uint(ctx, 3)) : THEME_ACCENT;
    if (!tftInstance || r <= 0) return 0;
    lgfx::LGFXBase* g = gfx();
    UiGuard guard(*g);
    kui::Canvas c(*tftInstance, g);
    kui::Rect rr = pr(cx - r, cy - r, 2 * r, 2 * r);
    c.fillRect(rr, bg());
    kui::paint::spinner(c, rr, color);
    return 0;
}

// Le o item i da lista (string ou {label, sub, right, bars, enabled}).
// Deixa 1 valor na pilha (o item) — quem chama faz duk_pop.
struct ListItem {
    const char* label = "";
    const char* sub = "";
    const char* right = "";
    int bars = -1;
    bool enabled = true;
    uint32_t rightColor = THEME_TEXT_DIM;
};
static ListItem readItem(duk_context* ctx, duk_idx_t arr, int i) {
    ListItem it;
    duk_get_prop_index(ctx, arr, (duk_uarridx_t)i);
    duk_idx_t o = duk_get_top_index(ctx);
    if (duk_is_object(ctx, o)) {
        it.label = optStr(ctx, o, "label", "");
        it.sub = optStr(ctx, o, "sub", "");
        it.right = optStr(ctx, o, "right", "");
        it.bars = optInt(ctx, o, "bars", -1);
        it.enabled = optBool(ctx, o, "enabled", true);
        it.rightColor = optColor(ctx, o, "rightColor", THEME_TEXT_DIM);
    } else if (!duk_is_null_or_undefined(ctx, o)) {
        it.label = duk_to_string(ctx, o);
    }
    return it;
}

// UI.list(id, x, y, w, h, items, {rowH, selected}) -> indice tocado ou -1
duk_ret_t JSBindings::js_uiList(duk_context* ctx) {
    const char* id = requireText(ctx, 0);
    int x = duk_require_int(ctx, 1), y = duk_require_int(ctx, 2), w = duk_require_int(ctx, 3), h = duk_require_int(ctx, 4);
    const duk_idx_t arr = 5;
    const int n = duk_is_array(ctx, arr) ? (int)duk_get_length(ctx, arr) : 0;
    int rowH = optInt(ctx, 6, "rowH", 0);
    int selected = optInt(ctx, 6, "selected", -1);
    if (rowH <= 0) {
        // 2 linhas quando algum item visivel tem legenda
        rowH = 36;
        for (int i = 0; i < n && i < 32; i++) {
            ListItem it = readItem(ctx, arr, i);
            bool hasSub = it.sub && *it.sub;
            duk_pop(ctx);
            if (hasSub) {
                rowH = 48;
                break;
            }
        }
    }

    Slot& s = slot(fnv(id, fnv("list")) | 1u);
    const int contentH = n * rowH;
    // lista nova com item selecionado: abre rolada ate ele (centrado)
    if (!s.drawn && s.scroll == 0 && selected > 0 && selected * rowH + rowH > h) {
        s.scroll = (float)(selected * rowH - (h - rowH) / 2);
    }
    scrollPhysics(s, x, y, w, h, contentH);
    const int scroll = (int)s.scroll;

    int result = -1;
    if (!s.drag && tapIn(x, y, w, h)) {
        int idx = (s_t.sy - y + scroll) / rowH;
        if (idx >= 0 && idx < n) {
            ListItem it = readItem(ctx, arr, idx);
            if (it.enabled) result = idx;
            duk_pop(ctx);
        }
    }
    int pressedRow = -1;
    if (!s.drag && pressedIn(x, y, w, h)) pressedRow = (s_t.sy - y + scroll) / rowH;

    if (!tftInstance) {
        duk_push_int(ctx, result);
        return 1;
    }
    // assinatura: rolagem + press + selecao + conteudo das linhas visiveis
    const int first = scroll / rowH;
    uint32_t sig = fnvInt(scroll, fnvInt(pressedRow, fnvInt(selected, fnvInt(n, 2166136261u))));
    for (int i = first; i < n && (i - first) * rowH < h + rowH; i++) {
        ListItem it = readItem(ctx, arr, i);
        sig = fnv(it.right, fnv(it.sub, fnv(it.label, sig))) ^ (uint32_t)(it.bars + 1) ^ (it.enabled ? 0u : 64u);
        sig = fnvInt((int)it.rightColor, sig);
        duk_pop(ctx);
    }
    bool clear;
    if (needDraw(s, (int32_t)sig, &clear)) {
        lgfx::LGFXBase* g = gfx();
        UiGuard guard(*g);
        kui::Canvas c(*tftInstance, g);
        kui::Rect r = pr(x, y, w, h);
        if (clear) c.fillRect(r, bg());
        kui::paint::listFrame(c, r, jsH(scroll), jsH(contentH));
        guard.clip({r.x, r.y + UI::sy(2), r.w, r.h - UI::sy(4)});
        for (int i = first; i < n; i++) {
            int vy = y + i * rowH - scroll;
            if (vy >= y + h) break;
            ListItem it = readItem(ctx, arr, i);
            kui::Rect row{r.x, jsy(vy), r.w, jsH(rowH)};
            kui::paint::listRow(c, row, it.label, it.sub, it.right, it.bars, it.enabled, i == pressedRow,
                                i == selected, i + 1 >= n, it.rightColor);
            duk_pop(ctx);
        }
        guard.unclip();
    }
    duk_push_int(ctx, result);
    return 1;
}

// UI.tabs(x, y, w, h, labels, sel) -> indice ativo
duk_ret_t JSBindings::js_uiTabs(duk_context* ctx) {
    int x = duk_require_int(ctx, 0), y = duk_require_int(ctx, 1), w = duk_require_int(ctx, 2), h = duk_require_int(ctx, 3);
    int sel = duk_require_int(ctx, 5);
    int n = duk_is_array(ctx, 4) ? (int)duk_get_length(ctx, 4) : 0;
    if (n > 8) n = 8;
    if (n <= 0) {
        duk_push_int(ctx, sel);
        return 1;
    }
    int segW = w / n;
    // w < n (ou w negativo) dava segW = 0 e o hit-test dividia por zero:
    // excecao do xtensa = reboot do aparelho
    if (segW < 1) segW = 1;
    if (s_t.tap && inR(s_t.sx, s_t.sy, x, y, w, h)) {
        int i = (s_t.sx - x) / segW;
        if (i >= n) i = n - 1;
        if (tapIn(x, y, w, h)) sel = i;
    }
    int pressed = pressedIn(x, y, w, h) ? (s_t.sx - x) / segW : -1;
    if (tftInstance) {
        const char* labels[8];
        uint32_t sig = fnvInt(sel, fnvInt(pressed, 2166136261u));
        for (int i = 0; i < n; i++) {
            duk_get_prop_index(ctx, 4, (duk_uarridx_t)i);
            labels[i] = duk_is_string(ctx, -1) ? duk_get_string(ctx, -1) : "?";  // viva no array
            sig = fnv(labels[i], sig);
            duk_pop(ctx);
        }
        Slot& s = slot(rectId("tabs", x, y, w, h));
        bool clear;
        if (needDraw(s, (int32_t)sig, &clear)) {
            lgfx::LGFXBase* g = gfx();
            UiGuard guard(*g);
            kui::Canvas c(*tftInstance, g);
            kui::Rect r = pr(x, y, w, h);
            if (clear) c.fillRect(r, bg());
            kui::paint::tabs(c, r, labels, n, sel, pressed);
        }
    }
    duk_push_int(ctx, sel);
    return 1;
}

// UI.card(x, y, w, h, {color, radius, stroke}) — superficie; empilha o fundo
duk_ret_t JSBindings::js_uiCard(duk_context* ctx) {
    int x = duk_require_int(ctx, 0), y = duk_require_int(ctx, 1), w = duk_require_int(ctx, 2), h = duk_require_int(ctx, 3);
    uint32_t color = optColor(ctx, 4, "color", THEME_CARD);
    int radius = optInt(ctx, 4, "radius", 10);
    bool stroke = optBool(ctx, 4, "stroke", false);
    if (s_drawFull && tftInstance) {
        lgfx::LGFXBase* g = gfx();
        UiGuard guard(*g);
        kui::Canvas c(*tftInstance, g);
        kui::Rect r = pr(x, y, w, h);
        c.fillRoundRect(r, jsu(radius), color);
        if (stroke) c.drawRoundRect(r, jsu(radius), THEME_STROKE);
    }
    if (s_bgDepth < kBgDepth) s_bg[s_bgDepth++] = color;
    return 0;
}

duk_ret_t JSBindings::js_uiCardEnd(duk_context* ctx) {
    (void)ctx;
    if (s_bgDepth > 1) s_bgDepth--;
    return 0;
}

// UI.scrollBegin(id, x, y, w, h, contentH) -> deslocamento (o app desenha
// em y - off). Conteudo e redesenhado no frame total: rolar marca o proximo.
duk_ret_t JSBindings::js_uiScrollBegin(duk_context* ctx) {
    const char* id = requireText(ctx, 0);
    int x = duk_require_int(ctx, 1), y = duk_require_int(ctx, 2), w = duk_require_int(ctx, 3), h = duk_require_int(ctx, 4);
    int contentH = duk_require_int(ctx, 5);
    Slot& s = slot(fnv(id, fnv("scroll")) | 1u);
    int before = (int)s.scroll;
    scrollPhysics(s, x, y, w, h, contentH);
    int off = (int)s.scroll;
    if (off != before) s_full = true;
    s_scrollOpen = true;
    s_svx = x;
    s_svy = y;
    s_svw = w;
    s_svh = h;
    s_scrollSlot = &s;
    s_scrollContentH = contentH;
    if (tftInstance) {
        lgfx::LGFXBase* g = gfx();
        g->getClipRect(&s_savedClip[0], &s_savedClip[1], &s_savedClip[2], &s_savedClip[3]);
        kui::Rect r = pr(x, y, w, h);
        int x0 = r.x > s_savedClip[0] ? r.x : s_savedClip[0];
        int y0 = r.y > s_savedClip[1] ? r.y : s_savedClip[1];
        int x1 = (r.x + r.w) < (s_savedClip[0] + s_savedClip[2]) ? (r.x + r.w) : (s_savedClip[0] + s_savedClip[2]);
        int y1 = (r.y + r.h) < (s_savedClip[1] + s_savedClip[3]) ? (r.y + r.h) : (s_savedClip[1] + s_savedClip[3]);
        g->setClipRect(x0, y0, x1 > x0 ? x1 - x0 : 0, y1 > y0 ? y1 - y0 : 0);
    }
    duk_push_int(ctx, off);
    return 1;
}

duk_ret_t JSBindings::js_uiScrollEnd(duk_context* ctx) {
    (void)ctx;
    if (!s_scrollOpen) return 0;
    s_scrollOpen = false;
    if (!tftInstance) return 0;
    lgfx::LGFXBase* g = gfx();
    g->setClipRect(s_savedClip[0], s_savedClip[1], s_savedClip[2], s_savedClip[3]);
    if (s_drawFull && s_scrollSlot && s_scrollContentH > s_svh) {
        // barra fina a direita (mesma do List)
        kui::Rect r = pr(s_svx, s_svy, s_svw, s_svh);
        int contentP = jsH(s_scrollContentH), maxP = contentP - r.h;
        // h virtual 0 com conteudo >= 1: jsH(1) arredonda para 0 na escala
        // com topbar fixa (1*294/320) — a barra dividia por zero
        if (contentP < 1) contentP = 1;
        int barH = r.h * r.h / contentP;
        if (barH < UI::sy(16)) barH = UI::sy(16);
        int barY = r.y + (maxP > 0 ? (r.h - barH) * jsH((int)s_scrollSlot->scroll) / maxP : 0);
        g->fillRoundRect(r.x + r.w - UI::sx(4), barY, UI::sx(3), barH, UI::sx(1), (uint32_t)THEME_STROKE);
    }
    s_scrollSlot = nullptr;
    return 0;
}

// UI.scrollTo(id, y): posiciona a lista/area id (y grande = fim; o proximo
// scrollBegin/list limita ao conteudo) e para a inercia
duk_ret_t JSBindings::js_uiScrollTo(duk_context* ctx) {
    const char* id = requireText(ctx, 0);
    double y = duk_require_number(ctx, 1);
    if (y < 0) y = 0;
    if (y > 1e6) y = 1e6;
    Slot& a = slot(fnv(id, fnv("list")) | 1u);
    Slot& b = slot(fnv(id, fnv("scroll")) | 1u);
    for (Slot* s : {&a, &b}) {
        if ((int)s->scroll != (int)y) s_full = true;
        s->scroll = (float)y;
        s->vel = 0;
        s->drawn = false;
    }
    return 0;
}

duk_ret_t JSBindings::js_uiResetScroll(duk_context* ctx) {
    const char* id = requireText(ctx, 0);
    uint32_t a = fnv(id, fnv("list")) | 1u, b = fnv(id, fnv("scroll")) | 1u;
    for (auto& s : s_slots) {
        if (s.id == a || s.id == b) {
            s.scroll = 0;
            s.vel = 0;
            s.drag = false;
            s.drawn = false;
        }
    }
    return 0;
}

#if CONFIG_CELEROS_UI_EXTRAS
// ============================================================ extras =======

// UI.custom(id, x, y, w, h, sig, draw, [opts]) -> desenhou neste frame?
// Area PINTADA PELO APP (JS): o slot limpa o retangulo no frame parcial,
// recorta e chama draw(x, y, w, h). O callback tem que pintar TUDO (nao use
// UI.text/UI.card la dentro: os slots deles pularao no parcial e o clear do
// custom apagaria o texto). Nao consome tap. opts: {bg, clear}.
duk_ret_t JSBindings::js_uiCustom(duk_context* ctx) {
    const char* id = requireText(ctx, 0);
    int x = duk_require_int(ctx, 1), y = duk_require_int(ctx, 2);
    int w = duk_require_int(ctx, 3), h = duk_require_int(ctx, 4);
    if (!duk_is_function(ctx, 6)) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
    if (!tftInstance) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
    // assinatura: string (hash), numero ou booleano; undefined = desenha 1x
    int32_t vis = 0;
    if (duk_is_string(ctx, 5)) vis = (int32_t)fnv(duk_get_string(ctx, 5));
    else if (duk_is_number(ctx, 5)) vis = (int32_t)duk_get_int(ctx, 5);
    else if (duk_is_boolean(ctx, 5)) vis = duk_get_boolean(ctx, 5) ? 1 : 0;
    Slot& s = slot((rectId("custom", x, y, w, h) ^ fnv(id)) | 1u);
    bool clear = false;
    if (!needDraw(s, vis, &clear)) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
    uint32_t bgc = optColor(ctx, 7, "bg", bg());
    bool paint = optBool(ctx, 7, "clear", true);
    lgfx::LGFXBase* g = gfx();
    kui::Rect r = pr(x, y, w, h);
    duk_int_t rc;
    {
        UiGuard guard(*g);
        kui::Canvas c(*tftInstance, g);
        if (clear && paint) c.fillRect(r, bgc);
        guard.clip(r);
        duk_dup(ctx, 6);  // funcao
        duk_push_int(ctx, x);
        duk_push_int(ctx, y);
        duk_push_int(ctx, w);
        duk_push_int(ctx, h);
        rc = duk_pcall(ctx, 4);
    }  // guard: restaura fonte/estilo/recorte ANTES de propagar o erro
    if (rc != DUK_EXEC_SUCCESS) {
        // needDraw marcou o slot como desenhado antes do pcall: um callback
        // que quebrou no meio deixaria a area limpada/velha ate o proximo
        // frame total. Desmarca (se o slot foi reciclado durante o callback,
        // o dono novo so desenha uma vez a mais — inofensivo).
        s.drawn = false;
        duk_throw(ctx);
    }
    duk_push_boolean(ctx, 1);
    return 1;
}

// UI.clip(x, y, w, h): empilha o recorte corrente e restringe ao retangulo
// (coords virtuais). Par com UI.unclip(); o app que quebrar no meio e' curado
// no proximo UI.begin.
duk_ret_t JSBindings::js_uiClip(duk_context* ctx) {
    int x = duk_require_int(ctx, 0), y = duk_require_int(ctx, 1);
    int w = duk_require_int(ctx, 2), h = duk_require_int(ctx, 3);
    if (!tftInstance || s_clipDepth >= kClipDepth) return 0;
    lgfx::LGFXBase* g = gfx();
    int32_t* saved = s_clipStack[s_clipDepth];
    g->getClipRect(&saved[0], &saved[1], &saved[2], &saved[3]);
    s_clipDepth++;
    kui::Rect r = pr(x, y, w, h);
    int x0 = r.x > saved[0] ? r.x : saved[0];
    int y0 = r.y > saved[1] ? r.y : saved[1];
    int x1 = (r.x + r.w) < (saved[0] + saved[2]) ? (r.x + r.w) : (saved[0] + saved[2]);
    int y1 = (r.y + r.h) < (saved[1] + saved[3]) ? (r.y + r.h) : (saved[1] + saved[3]);
    g->setClipRect(x0, y0, x1 > x0 ? x1 - x0 : 0, y1 > y0 ? y1 - y0 : 0);
    return 0;
}

duk_ret_t JSBindings::js_uiUnclip(duk_context* ctx) {
    (void)ctx;
    if (!tftInstance || s_clipDepth <= 0) return 0;
    s_clipDepth--;
    int32_t* saved = s_clipStack[s_clipDepth];
    gfx()->setClipRect(saved[0], saved[1], saved[2], saved[3]);
    return 0;
}
#endif  // CONFIG_CELEROS_UI_EXTRAS

// UI.badge(text, x, y, {color, textColor}) -> largura virtual
duk_ret_t JSBindings::js_uiBadge(duk_context* ctx) {
    const char* text = requireText(ctx, 0);
    int x = duk_require_int(ctx, 1), y = duk_require_int(ctx, 2);
    uint32_t color = optColor(ctx, 3, "color", THEME_ACCENT_D);
    uint32_t tcolor = optColor(ctx, 3, "textColor", THEME_TEXT);
    if (!tftInstance) {
        duk_push_int(ctx, 0);
        return 1;
    }
    lgfx::LGFXBase* g = gfx();
    Slot& s = slot(rectId("badge", x, y, 0, 0));
    bool clear;
    if (needDraw(s, (int32_t)(fnv(text) ^ fnvInt((int)color, fnvInt((int)tcolor, 0))), &clear)) {
        UiGuard guard(*g);
        kui::Canvas c(*tftInstance, g);
        if (clear && s.bw > 0) c.fillRect({s.bx, s.by, s.bw, s.bh}, bg());
        int w = kui::paint::badge(c, jsx(x), jsy(y), text, color, tcolor);
        s.bx = (int16_t)jsx(x);
        s.by = (int16_t)jsy(y);
        s.bw = (int16_t)w;
        s.bh = (int16_t)(c.fontHeight(kui::type::caption()) + UI::sy(6));
    }
    duk_push_int(ctx, vW(s.bw));
    return 1;
}

// ============================================================ dialogos =====

// Laco modal (confirm/alert): desenha o card sobre o quadro escurecido e
// espera um tap num botao. Nada RAII vive atraves do present/appWait (timers
// e saida do app fazem longjmp). Devolve o indice do botao.
static int runDialog(duk_context* ctx, const char* title, const char* body, const char* const* labels,
                     const kui::paint::ButtonStyle* styles, int n) {
    JSBindings::present();
    dimFrame();
    const kui::Rect area{0, jsy(0), UI::W, jsH(320)};
    const kui::Rect card = kui::paint::dialogCard(area, n);
    bool down = false, moved = false;
    int sx = 0, sy = 0, lastPressed = -2;
    while (true) {
        int jx = 0, jy = 0;
        bool touched = JSBindings::readAppTouch(ctx, &jx, &jy);
        const int px = jsx(jx), py = jsy(jy);
        int hit = -1;
        if (touched) {
            if (!down) {
                sx = px;
                sy = py;
                moved = false;
            }
            if (std::abs(px - sx) > UI::sx(kSlop) || std::abs(py - sy) > UI::sy(kSlop)) moved = true;
        }
        for (int i = 0; i < n; i++) {
            if (kui::paint::dialogButton(card, i, n).contains(sx, sy)) hit = i;
        }
        int pressed = (touched && !moved && hit >= 0 && kui::paint::dialogButton(card, hit, n).contains(px, py))
                          ? hit
                          : -1;
        if (!touched && down && !moved && hit >= 0) {
            // soltou dentro do botao em que pousou
            s_t = UiTouch();  // o release do dialogo nao vira tap embaixo
            s_full = true;
            return hit;
        }
        down = touched;
        if (pressed != lastPressed) {
            lastPressed = pressed;
            lgfx::LGFXBase* g = JSBindings::gfx();
            {
                UiGuard guard(*g);
                kui::Canvas c(Board::display(), g);
                kui::paint::dialog(c, card, title, body, labels, styles, n, pressed);
            }
        }
        JSBindings::appWait(ctx, 16);
    }
}

// UI.confirm(title, body, {yes, no, danger}) -> true = sim
duk_ret_t JSBindings::js_uiConfirm(duk_context* ctx) {
    const char* title = requireText(ctx, 0);
    const char* body = argStr(ctx, 1);
    const char* labels[2] = {optStr(ctx, 2, "no", "Cancelar"), optStr(ctx, 2, "yes", "OK")};
    kui::paint::ButtonStyle styles[2] = {
        kui::paint::BtnGhost, optBool(ctx, 2, "danger", false) ? kui::paint::BtnDanger : kui::paint::BtnPrimary};
    int r = runDialog(ctx, title, body, labels, styles, 2);
    duk_push_boolean(ctx, r == 1 ? 1 : 0);
    return 1;
}

// UI.alert(title, body, okLabel)
duk_ret_t JSBindings::js_uiAlert(duk_context* ctx) {
    const char* title = requireText(ctx, 0);
    const char* body = argStr(ctx, 1);
    const char* labels[1] = {duk_is_string(ctx, 2) ? duk_get_string(ctx, 2) : "OK"};
    kui::paint::ButtonStyle styles[1] = {kui::paint::BtnPrimary};
    runDialog(ctx, title, body, labels, styles, 1);
    return 0;
}

// ============================================================ primitivas ===
// (API 22) no objeto System: AA, gradiente, arco, mistura de cor

duk_ret_t JSBindings::js_fillGradient(duk_context* ctx) {
    if (!tftInstance) return 0;
    int x = duk_require_int(ctx, 0), y = duk_require_int(ctx, 1), w = duk_require_int(ctx, 2), h = duk_require_int(ctx, 3);
    uint32_t top = jsc(duk_require_uint(ctx, 4)), bottom = jsc(duk_require_uint(ctx, 5));
    int r = duk_is_number(ctx, 6) ? duk_get_int(ctx, 6) : 0;
    Icon::fillGradientRoundRect(gfx(), jsx(x), jsy(y), jsx(w), jsH(h), jsu(r), top, bottom);
    return 0;
}

duk_ret_t JSBindings::js_fillArc(duk_context* ctx) {
    if (!tftInstance) return 0;
    int cx = duk_require_int(ctx, 0), cy = duk_require_int(ctx, 1), r0 = duk_require_int(ctx, 2), r1 = duk_require_int(ctx, 3);
    float a0 = (float)duk_require_number(ctx, 4), a1 = (float)duk_require_number(ctx, 5);
    gfx()->fillArc(jsx(cx), jsy(cy), jsu(r0), jsu(r1), a0, a1, jsc(duk_require_uint(ctx, 6)));
    return 0;
}

duk_ret_t JSBindings::js_fillSmoothCircle(duk_context* ctx) {
    if (!tftInstance) return 0;
    int cx = duk_require_int(ctx, 0), cy = duk_require_int(ctx, 1), r = duk_require_int(ctx, 2);
    gfx()->fillSmoothCircle(jsx(cx), jsy(cy), jsu(r), jsc(duk_require_uint(ctx, 3)));
    return 0;
}

duk_ret_t JSBindings::js_fillSmoothRoundRect(duk_context* ctx) {
    if (!tftInstance) return 0;
    int x = duk_require_int(ctx, 0), y = duk_require_int(ctx, 1), w = duk_require_int(ctx, 2), h = duk_require_int(ctx, 3);
    int r = duk_require_int(ctx, 4);
    gfx()->fillSmoothRoundRect(jsx(x), jsy(y), jsx(w), jsH(h), jsu(r), jsc(duk_require_uint(ctx, 5)));
    return 0;
}

duk_ret_t JSBindings::js_drawWideLine(duk_context* ctx) {
    if (!tftInstance) return 0;
    int x0 = duk_require_int(ctx, 0), y0 = duk_require_int(ctx, 1), x1 = duk_require_int(ctx, 2), y1 = duk_require_int(ctx, 3);
    float wd = (float)duk_require_number(ctx, 4);
    if (wd < 1) wd = 1;
    // largura virtual -> raio fisico (escala uniforme, como jsu)
    float r = wd * (float)jsu(100) / 200.0f;
    gfx()->drawWideLine(jsx(x0), jsy(y0), jsx(x1), jsy(y1), r, jsc(duk_require_uint(ctx, 5)));
    return 0;
}

// System.mixColor(a, b, pct): RGB565; pct 0 = a, 100 = b
duk_ret_t JSBindings::js_mixColor(duk_context* ctx) {
    uint32_t a = duk_require_uint(ctx, 0) & 0xFFFF, b = duk_require_uint(ctx, 1) & 0xFFFF;
    int p = duk_require_int(ctx, 2);
    if (p < 0) p = 0;
    if (p > 100) p = 100;
    auto ch = [&](int shift, int mask) {
        int ca = (int)(a >> shift) & mask, cb = (int)(b >> shift) & mask;
        return (uint32_t)((ca + (cb - ca) * p / 100) & mask) << shift;
    };
    duk_push_uint(ctx, ch(11, 0x1F) | ch(5, 0x3F) | ch(0, 0x1F));
    return 1;
}
