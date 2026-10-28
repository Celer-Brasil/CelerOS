#include "WatchPanels.h"
#include "AlarmScreen.h"
#include "LauncherUI.h"
#include "../Boards/Board.h"
#include "../Display/Backlight.h"
#include "../Display/ScreenPower.h"
#include "../Display/Theme.h"
#include "../Hardware/BoardIO.h"
#include "../Kernel/Alarms.h"
#include "../Kernel/Notifications.h"
#include "../Kernel/TimeManager.h"
#include "../WebManager/WebManager.h"
#include "sdkconfig.h"
#if CONFIG_CELEROS_PHONE_LINK
#include "../Bluetooth/PhoneLink.h"
#endif
#include <Arduino.h>
#include <stdio.h>
#include <time.h>
#include <string>
#include <vector>

namespace {

// Borda de inicio do gesto (px fisicos derivados do design 240x320)
int edgeTop() { return UI::sy(18); }
int edgeLeft() { return UI::sx(14); }

bool s_returnHome = false;          // painel aberto a partir do app casa
portMUX_TYPE s_reqMux = portMUX_INITIALIZER_UNLOCKED;
volatile WatchPanels::Panel s_req = WatchPanels::Panel::None;
volatile bool s_reqHome = false;

// Fecha o painel do topo; vindo do app casa, volta para ele.
void closePanel() {
    kui::Navigator::pop();
    if (s_returnHome && kui::Navigator::depth() <= 1) LauncherUI::launchHome();
    s_returnHome = false;
}

// Moldura comum: margem lateral que respeita os cantos do vidro
int sideMargin() { return UI::sx(10) + UI::inset / 2; }

// ---------------------------------------------------------------- Lanterna --
class FlashlightScreen : public kui::Screen {
public:
    void onEnter() override {
        m_prev = Backlight::get();
        Backlight::set(100, false);
    }
    void onExit() override { Backlight::set(m_prev, false); }
    void draw(kui::Canvas& c) override {
        c.fill(0xFFFFFFu);
        c.text("Toque para sair", UI::cx(), UI::H - UI::sy(24) - UI::inset / 2, kui::type::caption(),
               0x909090u, MC_DATUM);
    }
    bool onTouch(const kui::TouchEvent& ev) override {
        if (ev.isTap()) kui::Navigator::pop();
        return true;
    }
    void onTick(uint32_t) override { ScreenPower::keepAwakeFor(2000); }

private:
    int m_prev = 80;
};
FlashlightScreen s_flash;

// ------------------------------------------------------- Ajustes rapidos --
// Painel estatico na pilha: a GUARDA contra instancias duplicadas e o
// Navigator::bringToFront (topo: no-op; coberto: sobe; ausente: empilha).
// Antes do bringToFront um painel COBERTO (alerta/chamada por cima) fazia o
// service consumir o pedido sem subir nada — o "toque: central" do alerta
// pedia a central e nada acontecia. E com o antigo "top() == target" a mesma
// instancia estatica chegava a empilhar DUAS vezes (fechar uma mostrava a
// outra), motivo das flags que existiam aqui.

class QuickSettingsScreen : public kui::Screen {
public:
    void onEnter() override {
        m_bright.value = Backlight::get();
        m_bright.onLiveChange = [](int v) { Backlight::set(v < 5 ? 5 : v, false); };
        m_bright.onChange = [](int v) { Backlight::set(v < 5 ? 5 : v, true); };
        m_vol.value = BoardIO::volumePct();
        m_vol.onChange = [](int v) {
            BoardIO::setVolumePct(v, true);
            BoardIO::tone(1200, 40);  // amostra do volume novo
        };
        m_clockAccum = 0;
    }

    void draw(kui::Canvas& c) override {
        if (c.mode() == kui::Canvas::Direct) c.fill(THEME_BG);
        const int m = sideMargin();
        // cabecalho: hora + bateria
        const int hy = UI::sy(22) + UI::inset / 3;
        c.text(TimeManager::getFormattedTime(), UI::cx(), hy, kui::type::title(), THEME_TEXT, MC_DATUM);
        const int pct = BoardIO::batteryPct();
        if (pct >= 0) {
            const int st = BoardIO::chargeState();
            char b[16];
            snprintf(b, sizeof(b), (st > 0 && (st & 1)) ? "+%d%%" : "%d%%", pct);
            c.text(b, UI::W - m, hy, kui::type::caption(), pct <= 15 ? THEME_ERR : THEME_TEXT_DIM,
                   MR_DATUM);
        }
        // sliders
        c.text("Brilho", m, UI::sy(46), kui::type::caption(), THEME_TEXT_DIM, ML_DATUM);
        m_bright.rect = {m + UI::sx(8), UI::sy(52), UI::W - 2 * m - UI::sx(16), UI::sy(26)};
        m_bright.draw(c);
        c.text("Volume", m, UI::sy(88), kui::type::caption(), THEME_TEXT_DIM, ML_DATUM);
        m_vol.rect = {m + UI::sx(8), UI::sy(94), UI::W - 2 * m - UI::sx(16), UI::sy(26)};
        m_vol.draw(c);
        // tiles 2 colunas x N linhas
        for (int i = 0; i < tileCount(); i++) drawTile(c, i);
        c.text("arraste para cima para fechar", UI::cx(), UI::H - UI::sy(8) - UI::inset / 3,
               kui::type::caption(), THEME_STROKE, MC_DATUM);
    }

    bool onTouch(const kui::TouchEvent& ev) override {
        if (m_bright.onTouch(ev, m_bright.rect)) return true;
        if (m_vol.onTouch(ev, m_vol.rect)) return true;
        if (ev.type != kui::TouchEvent::Release) return true;
        if (ev.swipe() == kui::TouchEvent::SwipeUp ||
            (ev.swipe() == kui::TouchEvent::SwipeRight && ev.startX < edgeLeft())) {
            closePanel();
            return true;
        }
        if (!ev.isTap()) return true;
        for (int i = 0; i < tileCount(); i++) {
            if (tileRect(i).contains(ev.x, ev.y)) {
                tap(tileAt(i));
                break;
            }
        }
        return true;
    }

    void onTick(uint32_t dtMs) override {
        m_clockAccum += dtMs;
        if (m_clockAccum < 1000) return;
        m_clockAccum = 0;
        // Cabecalho muda de VALOR raramente (HH:MM por minuto, bateria com
        // cache de 2s, wifi raramente): comparar antes de sujar evita o
        // compose+push full-frame por segundo com o painel aberto (mesmo
        // padrao do relogio do launcher em Screens.cpp)
        std::string clock = TimeManager::getFormattedTime();
        const bool wifi = WebManager::isActive();
        const int pct = BoardIO::batteryPct();
        if (clock != m_lastClock || wifi != m_lastWifi || pct != m_lastBatt) {
            m_lastClock = clock;
            m_lastWifi = wifi;
            m_lastBatt = pct;
            markDirty();
        }
    }

    bool allowsBackGesture() const override { return false; }  // borda = fechar (onTouch)

private:
    // Ids fixos dos tiles: 0 WiFi, 1 Nao perturbe, 2 Levantar pulso,
    // 3 Sempre ligada, 4 Lanterna, 5 Ajustes, +6 Celular, +7 Achar celular
    // (PHONE_LINK). "Levantar pulso" e "Sempre ligada" so existem com a
    // maquina de estados de tela (watch): fora dela o painel os oculta e a
    // numeracao dos slots pula direto para a Lanterna.
    static int tileCount() {
        int n = ScreenPower::active() ? 6 : 4;
#if CONFIG_CELEROS_PHONE_LINK
        n += 2;
#endif
        return n;
    }
    static int tileAt(int slot) { return ScreenPower::active() || slot < 2 ? slot : slot + 2; }

    kui::Slider m_bright;
    kui::Slider m_vol;
    uint32_t m_clockAccum = 0;
    std::string m_lastClock;
    bool m_lastWifi = false;
    int m_lastBatt = -999;

    kui::Rect tileRect(int i) const {
        const int m = sideMargin();
        const int gap = UI::sx(8);
        const int w = (UI::W - 2 * m - gap) / 2;
        const int top = UI::sy(128);
        const int h = tileCount() > 6 ? UI::sy(38) : UI::sy(50);
        const int row = i / 2, col = i % 2;
        return {m + col * (w + gap), top + row * (h + UI::sy(6)), w, h};
    }

    // estado de cada tile: -1 = acao (sem on/off)
    int tileState(int i) const {
        switch (i) {
            case 0: return WebManager::wifiEnabled() ? 1 : 0;
            case 1: return Notifications::dnd() ? 1 : 0;
            case 2: return ScreenPower::raiseWake() ? 1 : 0;
            case 3: return ScreenPower::aodEnabled() ? 1 : 0;
#if CONFIG_CELEROS_PHONE_LINK
            case 6: return PhoneLink::enabled() ? 1 : 0;
#endif
            default: return -1;
        }
    }

    void drawTile(kui::Canvas& c, int slot) {
        // Geometria = slot na grade. Identidade = tileAt: sem a maquina de
        // tela, os slots 2 e 3 SAO lanterna e ajustes (o toque ja usava
        // tileAt; o desenho mostrava "Levantar pulso" / "Sempre ligada").
        const int id = tileAt(slot);
        static const char* kNames[8] = {"WiFi",     "Não perturbe", "Levantar pulso", "Sempre ligada",
                                        "Lanterna", "Ajustes",      "Celular",        "Achar celular"};
        kui::Rect r = tileRect(slot);
        const int st = tileState(id);
        uint32_t bg = st == 1 ? THEME_ACCENT : THEME_CARD;
        if (kui::isPressed(r)) bg = st == 1 ? THEME_ACCENT_D : THEME_RAISED;
        c.fillRoundRect(r, r.h / 3, bg);
        const uint32_t fg = st == 1 ? THEME_ON_ACCENT : THEME_TEXT;
        char dyn[16];
        const char* name = kNames[id];
        if (id == 0 && st == 1) name = WebManager::isActive() ? "WiFi ligado" : "WiFi...";
#if CONFIG_CELEROS_PHONE_LINK
        if (id == 6 && st == 1) {
            const uint32_t pk = PhoneLink::passkey();
            if (pk) {
                snprintf(dyn, sizeof(dyn), "%06lu", (unsigned long)pk);
                name = dyn;
            } else {
                name = PhoneLink::connected() ? "Conectado" : "Celular...";
            }
        }
#else
        (void)dyn;
#endif
        c.text(c.ellipsize(name, kui::type::body(), r.w - UI::sx(12)), r.x + r.w / 2, r.y + r.h / 2,
               kui::type::body(), fg, MC_DATUM);
    }

    void tap(int i) {
        switch (i) {
            case 0:
                if (WebManager::wifiEnabled()) {
                    WebManager::disablePersist();
                } else {
                    WebManager::enableAsync();
                }
                break;
            case 1: Notifications::setDnd(!Notifications::dnd()); break;
            case 2: ScreenPower::setRaiseWake(!ScreenPower::raiseWake()); break;
            case 3: ScreenPower::setAodEnabled(!ScreenPower::aodEnabled()); break;
            case 4: kui::Navigator::push(&s_flash); break;
#if CONFIG_CELEROS_PHONE_LINK
            case 6: PhoneLink::setEnabled(!PhoneLink::enabled()); break;
            case 7:
                // sem confirmacao do Android: o Gadgetbridge decide se toca
                // (Ping tone no GB; Android 10+ pede pareamento via Companion
                // Device — gadgetbridge.org/basics/features/find-phone)
                kui::Navigator::toast(PhoneLink::findPhone(true) ? "Pedido enviado ao celular"
                                                                 : "Celular desconectado",
                                      THEME_ACCENT, 2500);
                break;
#endif
            case 5:
                s_returnHome = false;
                kui::Navigator::home();
                LauncherUI::requestLaunch("celeros.settings");
                break;
            default: break;
        }
        markDirty();
    }
};
QuickSettingsScreen s_quick;

// -------------------------------------------------- Central de notificacoes --
class NotificationCenterScreen : public kui::Screen {
public:
    void onEnter() override {
        m_rows.clear();
        m_rows.reserve(20);
        for (const Notifications::Note& n : Notifications::list()) {
            Row r;
            r.n = n;
            formatWhen(n.epoch, r.whenBuf, sizeof(r.whenBuf));
            if (n.src.rfind("phone:", 0) == 0) r.line = n.src.substr(6) + ": " + n.msg;
            else r.line = n.msg;
            m_rows.push_back(std::move(r));
        }
        Notifications::markAllRead();
        m_scroll = 0;
        m_expanded = -1;
    }

    void draw(kui::Canvas& c) override {
        if (c.mode() == kui::Canvas::Direct) c.fill(THEME_BG);
        const int m = sideMargin();
        const int top = headerH();
        // cabecalho: titulo a esquerda + X de fechar a direita (arrastar para
        // baixo a partir do topo continua fechando)
        char hdr[32];
        snprintf(hdr, sizeof(hdr), "Notificações (%d)", (int)m_rows.size());
        c.text(c.ellipsize(hdr, kui::type::title(), UI::W - 2 * m - closeRect().w - UI::sx(8)), m,
               top / 2 + UI::inset / 4, kui::type::title(), THEME_TEXT, ML_DATUM);
        const kui::Rect xr = closeRect();
        c.fillRoundRect(xr, xr.h / 3, kui::isPressed(xr) ? THEME_RAISED : THEME_CARD);
        c.text("X", xr.x + xr.w / 2, xr.y + xr.h / 2, kui::type::body(), THEME_TEXT, MC_DATUM);

        if (m_rows.empty()) {
            c.text("Nada por aqui", UI::cx(), UI::cy(), kui::type::body(), THEME_TEXT_DIM, MC_DATUM);
            c.text("toque no X ou arraste para baixo", UI::cx(), UI::H - UI::sy(14) - UI::inset / 3,
                   kui::type::caption(), THEME_STROKE, MC_DATUM);
            return;
        }
        c.setClip({0, top, UI::W, listBottom() - top});
        int y = top - m_scroll;
        for (int i = 0; i < (int)m_rows.size(); i++) {
            const int h = rowH(i);
            if (y + h > top && y < listBottom()) drawRow(c, i, {m, y, UI::W - 2 * m, h - UI::sy(6)});
            y += h;
        }
        c.clearClip();
        drawScrollbar(c);
        kui::Rect clr = clearRect();
        c.fillRoundRect(clr, clr.h / 2, kui::isPressed(clr) ? THEME_RAISED : THEME_CARD);
        c.text("Limpar tudo", clr.x + clr.w / 2, clr.y + clr.h / 2, kui::type::body(), THEME_TEXT,
               MC_DATUM);
    }

    bool onTouch(const kui::TouchEvent& ev) override {
        const kui::Rect xr = closeRect();
        if (ev.type == kui::TouchEvent::Drag) {
            // arrasto que nasce no X nao rola a lista (e chrome)
            if (!xr.contains(ev.startX, ev.startY) && abs(ev.dy()) > abs(ev.dx())) {
                m_scroll -= ev.y - ev.prevY;
                clampScroll();
            }
            return true;
        }
        if (ev.type != kui::TouchEvent::Release) return true;
        if (ev.isTap() && xr.contains(ev.x, ev.y)) {
            closePanel();
            return true;
        }
        const kui::TouchEvent::Swipe sw = ev.swipe();
        // fechar: arrastar para baixo a partir do topo da lista / borda esquerda
        if ((sw == kui::TouchEvent::SwipeDown && (m_scroll == 0 || ev.startY < headerH())) ||
            (sw == kui::TouchEvent::SwipeRight && ev.startX < edgeLeft())) {
            closePanel();
            return true;
        }
        if (!m_rows.empty() && ev.isTap() && clearRect().contains(ev.x, ev.y)) {
            Notifications::clear();
            m_rows.clear();
            closePanel();
            return true;
        }
        int idx = rowAt(ev.startY);
        if (idx < 0) return true;
        if (sw == kui::TouchEvent::SwipeLeft || sw == kui::TouchEvent::SwipeRight) {
            // m_rows e o retrato da ENTRADA: uma notificacao nova (task do
            // BLE) desloca list() e o removeAt(idx) apagava OUTRA nota (o
            // indice de list() deixava de casar com a linha). Casa a linha
            // pela identidade antes de remover.
            const Notifications::Note& want = m_rows[idx].n;
            const std::vector<Notifications::Note> all = Notifications::list();
            for (int i = 0; i < (int)all.size(); i++) {
                const bool same = want.id != 0
                                      ? all[i].id == want.id
                                      : (all[i].epoch == want.epoch && all[i].title == want.title);
                if (same) {
                    Notifications::removeAt(i);
                    break;
                }
            }
            m_rows.erase(m_rows.begin() + idx);
            m_expanded = -1;
            clampScroll();
        } else if (ev.isTap()) {
            m_expanded = (m_expanded == idx) ? -1 : idx;
            clampScroll();
        }
        return true;
    }

    bool allowsBackGesture() const override { return false; }  // fechar e do onTouch

private:
    // Linha pronta na entrada: o redraw em faixas (CYD, ~dezena de passadas
    // por quadro) nao remonta "origem: msg" nem reformata a hora a cada faixa.
    struct Row {
        Notifications::Note n;
        char whenBuf[8];
        std::string line;
        std::string titleShown;
        std::string lineShown;
        bool titleReady = false;
        bool lineReady = false;
    };
    std::vector<Row> m_rows;
    int m_scroll = 0;
    int m_expanded = -1;

    int headerH() const { return UI::sy(40) + UI::inset / 3; }
    int listBottom() const { return UI::H - UI::sy(54) - UI::inset / 3; }
    kui::Rect clearRect() const {
        const int w = UI::sx(140);
        return {(UI::W - w) / 2, listBottom() + UI::sy(8), w, UI::sy(36)};
    }
    kui::Rect closeRect() const {
        const int h = UI::sy(32);
        return {UI::W - sideMargin() - UI::sx(44), (headerH() - h) / 2, UI::sx(44), h};
    }
    int rowH(int i) const { return i == m_expanded ? UI::sy(120) : UI::sy(56); }

    int totalH() const {
        int total = 0;
        for (int i = 0; i < (int)m_rows.size(); i++) total += rowH(i);
        return total;
    }

    // polegar a direita (dentro da margem) quando a lista transborda
    void drawScrollbar(kui::Canvas& c) const {
        const int view = listBottom() - headerH();
        const int total = totalH();
        if (total <= view) return;
        const int th = view * view / total;
        const int ty = headerH() + (view - th) * m_scroll / (total - view);
        c.fillRoundRect({UI::W - UI::sx(6), ty, UI::sx(3), th}, UI::sx(3) / 2, THEME_STROKE);
    }

    int rowAt(int py) const {
        int y = headerH() - m_scroll;
        if (py < headerH() || py >= listBottom()) return -1;
        for (int i = 0; i < (int)m_rows.size(); i++) {
            if (py >= y && py < y + rowH(i)) return i;
            y += rowH(i);
        }
        return -1;
    }

    void clampScroll() {
        int maxS = totalH() - (listBottom() - headerH());
        if (maxS < 0) maxS = 0;
        if (m_scroll > maxS) m_scroll = maxS;
        if (m_scroll < 0) m_scroll = 0;
    }

    static void formatWhen(int64_t epoch, char* b, size_t n) {
        if (b == nullptr || n < 6) {  // "HH:MM"/"MM/DD" + NUL
            if (b != nullptr && n > 0) b[0] = '\0';
            return;
        }
        time_t e = (time_t)epoch;
        struct tm t;
        struct tm nowTm;
        localtime_r(&e, &t);
        TimeManager::copyLocal(nowTm);
        if (t.tm_yday == nowTm.tm_yday && t.tm_year == nowTm.tm_year) {
            // tm vem do newlib: os limites abaixo deixam o compilador provar
            // que %02d nao estoura o buffer de 8 da Row.
            int hh = t.tm_hour < 0 ? 0 : (t.tm_hour > 23 ? 23 : t.tm_hour);
            int mm = t.tm_min < 0 ? 0 : (t.tm_min > 59 ? 59 : t.tm_min);
            snprintf(b, n, "%02d:%02d", hh, mm);
        } else {
            int day = t.tm_mday < 1 ? 1 : (t.tm_mday > 31 ? 31 : t.tm_mday);
            int mon = t.tm_mon < 0 ? 0 : (t.tm_mon > 11 ? 11 : t.tm_mon);
            snprintf(b, n, "%02d/%02d", day, mon + 1);
        }
    }

    void drawRow(kui::Canvas& c, int i, kui::Rect r) {
        Row& row = m_rows[i];
        c.fillRoundRect(r, UI::sx(10), THEME_CARD);
        const int pad = UI::sx(10);
        const lgfx::IFont* fb = kui::type::body();
        const lgfx::IFont* fc = kui::type::caption();
        const int ww = c.textWidth(row.whenBuf, fc);
        int ty = r.y + UI::sy(14);
        if (!row.titleReady) {
            row.titleShown = c.ellipsize(row.n.title, fb, r.w - 3 * pad - ww);
            row.titleReady = true;
        }
        c.text(row.titleShown, r.x + pad, ty, fb, THEME_TEXT, ML_DATUM);
        c.text(row.whenBuf, r.x + r.w - pad, ty, fc, THEME_TEXT_DIM, MR_DATUM);
        if (i != m_expanded) {
            if (!row.lineReady) {
                row.lineShown = c.ellipsize(row.line, fc, r.w - 2 * pad);
                row.lineReady = true;
            }
            c.text(row.lineShown, r.x + pad, r.y + UI::sy(36), fc, THEME_TEXT_DIM, ML_DATUM);
            return;
        }
        int ly = r.y + UI::sy(34);
        for (const std::string& line : c.wrapText(row.line, fc, r.w - 2 * pad, 5)) {
            c.text(line, r.x + pad, ly, fc, THEME_TEXT_DIM, ML_DATUM);
            ly += UI::sy(16);
        }
    }
};
NotificationCenterScreen s_notif;

// Sobe o painel estatico (ver o comentario dos Ajustes rapidos): topo no-op,
// coberto traz a frente, ausente empilha — nunca duplica a instancia.
void pushPanel(kui::Screen* s) { kui::Navigator::bringToFront(s); }

bool edgeGestureHook(const kui::TouchEvent& ev) {
    if (ev.type != kui::TouchEvent::Release) return false;
    const kui::TouchEvent::Swipe sw = ev.swipe();
    kui::Screen* top = kui::Navigator::top();
    if (top == &s_quick || top == &s_notif || top == &s_flash) return false;
    const int edge = WatchPanels::edgeAt(ev.startX, ev.startY);
    if (edge == 1 && sw == kui::TouchEvent::SwipeDown) {
        const int third = WatchPanels::topThirdAt(ev.startX);
        if (third == 2) return false;  // terco direito: so o app (topbar retratil)
        s_returnHome = false;
        pushPanel(third == 0 ? (kui::Screen*)&s_quick : (kui::Screen*)&s_notif);
        return true;
    }
    if (edge == 2 && sw == kui::TouchEvent::SwipeUp) {
        s_returnHome = false;
        pushPanel(&s_notif);
        return true;
    }
    return false;
}

}  // namespace

namespace WatchPanels {

bool enabled() { return Board::profile().watchGestures; }

void init() {
    if (!enabled()) return;
    kui::Navigator::setGestureHook(edgeGestureHook);
}

int edgeAt(int x, int y) {
    if (y < edgeTop()) return 1;
    if (y >= UI::H - edgeTop()) return 2;
    if (x < edgeLeft()) return 3;
    return 0;
}

int topThirdAt(int x) {
    if (x < UI::sx(80)) return 0;
    return x < UI::sx(160) ? 1 : 2;
}

void request(Panel p, bool returnHome) {
    portENTER_CRITICAL(&s_reqMux);
    s_req = p;
    s_reqHome = returnHome;
    portEXIT_CRITICAL(&s_reqMux);
}

void service() {
    if (s_req == Panel::None) return;
    // Alarme tocando no topo: painel de borda NAO cobre a tela do alarme. O
    // pedido NAO e consumido — fica pendente e sobe no tick seguinte ao fim
    // do alarme (gestos de borda ja sao bloqueados pelo allowsBackGesture
    // da tela do alarme; aqui e o caminho programatico, ex.: "toque:
    // central" do alerta).
    if (Alarms::ringing() && AlarmScreen::onTop()) return;
    portENTER_CRITICAL(&s_reqMux);
    Panel p = s_req;
    bool home = s_reqHome;
    s_req = Panel::None;
    portEXIT_CRITICAL(&s_reqMux);
    kui::Screen* target = p == Panel::Quick ? (kui::Screen*)&s_quick : (kui::Screen*)&s_notif;
    if (kui::Navigator::top() == target) return;
    s_returnHome = home;
    pushPanel(target);
}

}  // namespace WatchPanels
