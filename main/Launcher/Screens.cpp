#include "Screens.h"
#include "../Kernel/AppRunner.h"
#include "LauncherUI.h"
#include "../Utils/AppGrants.h"
#include "../Display/Icon.h"
#include "../Kernel/TimeManager.h"
#include "../FileSystem/FileSystem.h"
#include "../WebManager/WebManager.h"
#include "../WebManager/WifiSetupPortal.h"
#include "../Boards/Board.h"
#include "../Hardware/BoardIO.h"
#include "../Utils/StrUtils.h"

#include <Arduino.h>
#include <algorithm>
#include <ctime>

using namespace kui;

// ============================================================ Launcher =====

namespace {
int gridHeaderH() { return UI::sy(56); }
int gridTop() { return gridHeaderH() + UI::sy(10); }
int gridAreaH() { return UI::H - gridTop() - UI::sy(28); }
int gridCellW() { return UI::W / LauncherUI::gridCols(); }
int gridCellH() { return gridAreaH() / LauncherUI::gridRows(); }
int gridLeft() { return (UI::W - LauncherUI::gridCols() * gridCellW()) / 2; }
int gridCellsPerPage() { return LauncherUI::gridCols() * LauncherUI::gridRows(); }

// Modo lista (watch): uma coluna, linha = icone + nome, rolagem vertical
bool listMode() { return Board::profile().launcherList; }
int listRowH() { return Icon::SIZE + UI::sy(14); }
int listMargin() { return UI::sx(10) + UI::inset / 2; }
int listBottom() { return UI::H - UI::inset / 3; }

// Area tocavel do status de rede (canto direito do header): abre o WiFi
kui::Rect wifiStatusRect() {
    int hdr = gridHeaderH();
    int w = UI::sx(110);
    return {UI::W - w, 0, w, hdr};
}

// Data curta em pt-BR ("dom, 27 set"); vazia enquanto o relogio nao foi ajustado
std::string shortDate() {
    static const char* const kDays[7] = {"dom", "seg", "ter", "qua", "qui", "sex", "sab"};
    static const char* const kMonths[12] = {"jan", "fev", "mar", "abr", "mai", "jun",
                                             "jul", "ago", "set", "out", "nov", "dez"};
    time_t now = time(nullptr);
    struct tm t;
    localtime_r(&now, &t);
    if (t.tm_year + 1900 < 2020) return "";
    return kstr::fmt("%s, %d %s", kDays[t.tm_wday], t.tm_mday, kMonths[t.tm_mon]);
}

// Glifo de WiFi vetorial: 3 arcos + ponto, base em (cx, by)
void drawWifiGlyph(kui::Canvas& c, int cx, int by, bool on) {
    uint32_t col = on ? THEME_TEXT : THEME_STROKE;
    int t = UI::sx(3) > 2 ? UI::sx(3) : 2;
    for (int i = 1; i <= 3; i++) {
        int r = UI::sx(5) * i;
        c.fillArc(cx, by, r - t, r, 225, 315, (i == 3 && !on) ? THEME_STROKE : col);
    }
    c.fillCircle(cx, by - 1, t - 1 > 0 ? t - 1 : 1, col);
}
}  // namespace

kui::Rect LauncherScreen::cellRect(int entryIndex) const {
    if (listMode()) {
        return {listMargin(), gridTop() + entryIndex * listRowH() - m_scroll,
                UI::W - 2 * listMargin(), listRowH()};
    }
    int cell = entryIndex % gridCellsPerPage();
    int col = cell % LauncherUI::gridCols();
    int row = cell / LauncherUI::gridCols();
    return {gridLeft() + col * gridCellW(), gridTop() + row * gridCellH(), gridCellW(), gridCellH()};
}

void LauncherScreen::onResume() {
    // voltou de app/dialog/erro: o vidro contem conteudo de outra tela —
    // o proximo draw precisa limpar o fundo (modo direto sem sprite)
    m_needClear = true;
}

void LauncherScreen::onEnter() {
    if (LauncherUI::needsRescan) {
        LauncherUI::scanLocalApps();
        LauncherUI::needsRescan = false;
    }
    if (page >= LauncherUI::gridTotalPages()) page = LauncherUI::gridTotalPages() - 1;
    if (page < 0) page = 0;
    clampScroll();  // lista pode ter encolhido: rolagem valida na entrada
    m_noWifiPref = FileSystem::exists("/local/nowifi.txt");
    m_dragDx = 0;
}

// Bateria: corpo + polo + nivel (cor por faixa) e % ao lado; raio quando
// carregando. Devolve a largura ocupada (0 sem bateria) — a pilula de rede
// anda para a esquerda dela.
static int drawBatteryGlyph(kui::Canvas& c, int right, int cy) {
    const int pct = BoardIO::batteryPct();
    if (pct < 0) return 0;
    const int st = BoardIO::chargeState();
    const bool chg = st > 0 && (st & 1);
    const int bw = UI::sx(20), bh = UI::sx(10), tip = UI::sx(2) > 1 ? UI::sx(2) : 2;
    const int x = right - bw - tip, y = cy - bh / 2;
    c.drawRoundRect({x, y, bw, bh}, UI::sx(2), THEME_TEXT_DIM);
    c.fillRect({x + bw, y + bh / 4, tip, bh / 2}, THEME_TEXT_DIM);
    const uint32_t col = chg ? THEME_OK : pct <= 15 ? THEME_ERR : pct <= 30 ? THEME_WARN : THEME_TEXT;
    const int inner = (bw - 4) * pct / 100;
    if (inner > 0) c.fillRect({x + 2, y + 2, inner, bh - 4}, col);
    if (chg) {  // raio por cima do nivel
        const int mx = x + bw / 2;
        c.fillTriangle(mx + UI::sx(2), y - 1, mx - UI::sx(4), cy + 1, mx, cy + 1, THEME_ON_ACCENT);
        c.fillTriangle(mx - UI::sx(2), y + bh + 1, mx + UI::sx(4), cy - 1, mx, cy - 1, THEME_ON_ACCENT);
    }
    char b[16];
    snprintf(b, sizeof(b), "%d%%", pct);
    const lgfx::IFont* f = kui::type::caption();
    const int tw = c.textWidth(b, f);
    c.text(b, x - UI::sx(4), cy, f, chg ? THEME_OK : THEME_TEXT_DIM, MR_DATUM);
    return bw + tip + UI::sx(4) + tw;
}

void LauncherScreen::clampScroll() {
    int total = LauncherUI::gridTotalEntries() * listRowH();
    int maxS = total - (listBottom() - gridTop());
    if (maxS < 0) maxS = 0;
    if (m_scroll > maxS) m_scroll = maxS;
    if (m_scroll < 0) m_scroll = 0;
}

void LauncherScreen::drawStatusBar(kui::Canvas& c) {
    int hdr = gridHeaderH();
    c.fillGradient({0, 0, UI::W, hdr}, 0, THEME_CARD, THEME_BG);

    // relogio + data (esquerda; inset = cantos arredondados do vidro)
    int x = UI::sx(14) + UI::inset;
    std::string date = shortDate();
    if (date.empty()) {
        c.text(TimeManager::getFormattedTime(), x, hdr / 2, kui::type::display(), THEME_TEXT, ML_DATUM);
    } else {
        c.text(TimeManager::getFormattedTime(), x, hdr * 2 / 5, kui::type::display(), THEME_TEXT, ML_DATUM);
        c.text(date, x + UI::sx(1), hdr * 4 / 5, kui::type::caption(), THEME_TEXT_DIM, ML_DATUM);
    }

    // rede (direita): glifo + pilula "Sem WiFi" quando offline
    bool wifi = WebManager::isActive();
    kui::Rect st = wifiStatusRect();
    if (kui::isPressed(st)) c.fillRoundRect({st.x + UI::sx(4), UI::sy(8), st.w - UI::sx(8), hdr - UI::sy(16)}, UI::sx(8), THEME_RAISED);
    int gx = UI::W - UI::sx(26) - UI::inset;
    drawWifiGlyph(c, gx, hdr / 2 + UI::sx(8), wifi);
    // bateria a esquerda do glifo de rede; o resto anda junto
    int bat = drawBatteryGlyph(c, gx - UI::sx(22), hdr / 2);
    if (bat > 0) gx -= bat + UI::sx(10);
    if (!wifi && !m_noWifiPref) {
        const lgfx::IFont* f = kui::type::caption();
        const char* msg = "Sem WiFi";
        int pw = c.textWidth(msg, f) + UI::sx(16);
        int ph = UI::sy(20);
        kui::Rect pill{gx - UI::sx(22) - pw, (hdr - ph) / 2, pw, ph};
        c.drawRoundRect(pill, ph / 2, THEME_WARN);
        c.text(msg, pill.x + pw / 2, pill.y + ph / 2, f, THEME_WARN, MC_DATUM);
    } else if (!wifi) {
        c.text("offline", gx - UI::sx(22), hdr / 2, kui::type::caption(), THEME_TEXT_DIM, MR_DATUM);
    }
}

void LauncherScreen::draw(kui::Canvas& c) {
    // Sem sprite (Direct): limpar o fundo e redesenhar tudo pisca a tela.
    // O fundo so precisa ser repintado quando a composicao MUDA (entrada,
    // troca/arrasto de pagina, estado de clique) — no resto, o conteudo
    // redesenha opaco sobre as mesmas coordenadas (sem blink).
    bool clearBg = m_needClear || m_dragDx != 0;
    m_needClear = false;
    if (clearBg) c.fill(THEME_BG);
    if (c.visible({0, 0, UI::W, gridHeaderH()})) drawStatusBar(c);

    if (listMode()) {
        // lista: fundo sempre limpo (a rolagem move tudo); o canvas do watch
        // tem framebuffer, sem piscada
        if (!clearBg) c.fillRect({0, gridHeaderH(), UI::W, UI::H - gridHeaderH()}, THEME_BG);
        c.setClip({0, gridHeaderH(), UI::W, listBottom() - gridHeaderH()});
        const lgfx::IFont* f = kui::type::body();
        for (int entry = 0; entry < LauncherUI::gridTotalEntries(); entry++) {
            kui::Rect r = cellRect(entry);
            if (r.y + r.h <= gridHeaderH() || r.y >= listBottom()) continue;
            kui::Rect card{r.x, r.y + UI::sy(3), r.w, r.h - UI::sy(6)};
            c.fillRoundRect(card, card.h / 2, kui::isPressed(card) ? THEME_RAISED : THEME_CARD);
            const int iconX = card.x + UI::sx(8);
            const int iconY = card.y + (card.h - Icon::SIZE) / 2;
            const std::string& label = LauncherUI::appEntryName(entry);
            const std::string& icon = LauncherUI::appEntryIcon(entry);
            if (!icon.empty() && Icon::available(icon.c_str())) {
                c.drawIcon(icon.c_str(), iconX, iconY);
            } else {
                c.drawAppTile(label.c_str(), iconX, iconY);
            }
            const int tx = iconX + Icon::SIZE + UI::sx(10);
            c.text(c.ellipsize(label, f, card.x + card.w - tx - UI::sx(12)), tx, card.y + card.h / 2, f,
                   THEME_TEXT, ML_DATUM);
        }
        c.clearClip();
        return;
    }

    // grid: pagina atual deslocada pelo arrasto + vizinha entrando pela borda
    const lgfx::IFont* labelFont = kui::type::caption();
    const int labelGap = UI::big ? 8 : 4;
    auto drawPage = [&](int pg, int xOff) {
        if (pg < 0 || pg >= LauncherUI::gridTotalPages()) return;
        for (int entry = pg * gridCellsPerPage();
             entry < LauncherUI::gridTotalEntries() && entry < (pg + 1) * gridCellsPerPage(); entry++) {
            kui::Rect cell = cellRect(entry);
            cell.x += xOff;
            if (cell.x + cell.w <= 0 || cell.x >= UI::W || !c.visible(cell)) continue;
            int iconX = cell.x + (cell.w - Icon::SIZE) / 2;
            int labelH = c.fontHeight(labelFont);
            int iconY = cell.y + (cell.h - Icon::SIZE - labelGap - labelH) / 2;

            if (xOff == 0 && kui::canvasBuffered() && kui::isPressed(cell)) {
                int pad = UI::sx(6);
                c.fillRoundRect({cell.x + pad, iconY - pad, cell.w - 2 * pad, Icon::SIZE + labelGap + labelH + 2 * pad},
                                UI::sx(12), THEME_RAISED);
            }

            const std::string& label = LauncherUI::appEntryName(entry);
            const std::string& icon = LauncherUI::appEntryIcon(entry);
            if (!icon.empty() && Icon::available(icon.c_str())) {
                c.drawIcon(icon.c_str(), iconX, iconY);
            } else {
                c.drawAppTile(label.c_str(), iconX, iconY);
            }
            c.text(c.ellipsize(label, labelFont, cell.w - UI::sx(6)), cell.x + cell.w / 2,
                   iconY + Icon::SIZE + labelGap, labelFont, THEME_TEXT, TC_DATUM);
        }
    };
    c.setClip({0, gridHeaderH(), UI::W, UI::H - gridHeaderH()});
    drawPage(page, m_dragDx);
    if (m_dragDx < 0) drawPage(page + 1, m_dragDx + UI::W);
    if (m_dragDx > 0) drawPage(page - 1, m_dragDx - UI::W);
    c.clearClip();

    // indicador de pagina: pilula na atual
    int tp = LauncherUI::gridTotalPages();
    if (tp > 1) {
        int dotsY = UI::H - UI::sy(14);
        int d = UI::sx(3);
        int activeW = UI::sx(16);
        int gap = UI::sx(8);
        int total = (tp - 1) * (2 * d + gap) + activeW;
        int x = UI::cx() - total / 2;
        for (int i = 0; i < tp; i++) {
            int w = (i == page) ? activeW : 2 * d;
            c.fillRoundRect({x, dotsY - d, w, 2 * d}, d, i == page ? THEME_ACCENT : THEME_STROKE);
            x += w + gap;
        }
    }
}

int LauncherScreen::entryAt(int x, int y) const {
    if (listMode()) {
        if (y < gridHeaderH() || y >= listBottom()) return -1;
        for (int entry = 0; entry < LauncherUI::gridTotalEntries(); entry++) {
            if (cellRect(entry).contains(x, y)) return entry;
        }
        return -1;
    }
    for (int entry = page * gridCellsPerPage();
         entry < (page + 1) * gridCellsPerPage() && entry < LauncherUI::gridTotalEntries(); entry++) {
        if (cellRect(entry).contains(x, y)) return entry;
    }
    return -1;
}

void LauncherScreen::openAppActions(int entry) {
    const std::string name = LauncherUI::appEntryName(entry);
    m_dlg.buttons.clear();
    m_dlg.tickUnder = false;  // m_dlg e reaproveitado: o consentimento liga estes
    m_dlg.timeoutMs = 0;
    m_dlg.onTimeout = nullptr;
    kui::Button cancel;
    cancel.label = "Cancelar";
    cancel.style = kui::Button::Ghost;
    cancel.onTap = [] { Navigator::closeDialog(); };
    if (LauncherUI::appEntryIsSystem(entry)) {
        // apps de sistema nao saem pelo launcher (Settings > Reset repoe)
        m_dlg.title = name;
        m_dlg.body = "App de sistema";
        cancel.label = "OK";
        m_dlg.buttons.push_back(cancel);
    } else {
        m_dlg.title = "Remover " + name + "?";
        m_dlg.body = "Apaga o app e os dados";
        m_dlg.buttons.push_back(cancel);
        kui::Button rm;
        rm.label = "Remover";
        rm.style = kui::Button::Danger;
        rm.onTap = [this, entry] {
            Navigator::closeDialog();
            uninstall(entry);
        };
        m_dlg.buttons.push_back(rm);
    }
    Navigator::showDialog(&m_dlg);
}

void LauncherScreen::launchEntry(int entry) {
    const uint32_t missing = LauncherUI::appEntryMissingPerms(entry);
    if (missing == 0) {
        Navigator::push(AppHostScreen::instance(entry));
        return;
    }
    m_dlg.buttons.clear();
    m_dlg.title = "Permitir " + LauncherUI::appEntryName(entry) + "?";
    m_dlg.body = "Acesso a: " + AppGrants::describe(missing);
    kui::Button cancel;
    cancel.label = "Cancelar";
    cancel.style = kui::Button::Ghost;
    cancel.onTap = [] { Navigator::closeDialog(); };
    m_dlg.buttons.push_back(cancel);
    kui::Button allow;
    allow.label = "Permitir";
    allow.onTap = [entry] {
        Navigator::closeDialog();
        LauncherUI::grantEntry(entry);
        Navigator::push(AppHostScreen::instance(entry));
    };
    m_dlg.buttons.push_back(allow);
    // O launcher segue atendendo "run" remoto com o dialogo aberto (o shell
    // `grant` + `run` resolve sem toque) e o pedido expira em 60 s: numa tela
    // apagada, no relogio no pulso ou no headless ninguem responde, e o
    // dialogo prendia o launcher — todo `apps run` seguinte esperava para
    // sempre (bancada 2026-10-11, 4848 parado em "Permitir 2048?")
    m_dlg.tickUnder = true;
    m_dlg.timeoutMs = 60000;
    m_dlg.onTimeout = [] {
        Navigator::closeDialog();
        Navigator::toast("Permissão não respondida", THEME_WARN);
    };
    Navigator::showDialog(&m_dlg);
}

void LauncherScreen::uninstall(int entry) {
    const std::string name = LauncherUI::appEntryName(entry);
    bool ok = LauncherUI::uninstallEntry(entry);
    LauncherUI::scanLocalApps();  // ja: a grade reflete na hora
    LauncherUI::needsRescan = false;
    if (page >= LauncherUI::gridTotalPages()) page = LauncherUI::gridTotalPages() - 1;
    clampScroll();  // entrada sumida: rolagem/lista em modo lista volta pro fim
    Navigator::toast(ok ? name + " removido" : "Falha ao remover " + name, ok ? THEME_OK : THEME_ERR);
    markDirty();
}

bool LauncherScreen::onTouch(const kui::TouchEvent& ev) {
    const int tp = LauncherUI::gridTotalPages();

    if (ev.type == TouchEvent::Press) {
        m_pressMs = millis();
        m_pressEntry = entryAt(ev.x, ev.y);
        m_longFired = false;
        // realce do pressionado so com buffer (offscreen); no modo direto
        // cada press/release limparia a tela inteira — e o Z do touch
        // resistivo oscila ao deslizar (re-deteccoes = piscadas)
        if (kui::canvasBuffered()) m_needClear = true;
        return false;
    }
    if (ev.type == TouchEvent::Release && m_longFired) {
        m_longFired = false;  // o toque longo ja abriu o dialogo
        m_pressEntry = -1;
        if (kui::canvasBuffered()) m_needClear = true;
        return true;
    }
    if (ev.type == TouchEvent::Release) {
        m_pressEntry = -1;
        if (kui::canvasBuffered()) m_needClear = true;
    }

    if (listMode()) {
        if (ev.type == TouchEvent::Drag) {
            if (kui::touchState().moved && ev.startY > gridHeaderH()) {
                m_scroll -= ev.y - ev.prevY;
                clampScroll();
                return true;
            }
            return false;
        }
        if (ev.type != TouchEvent::Release || !ev.isTap()) return ev.type == TouchEvent::Release;
        if (wifiStatusRect().contains(ev.x, ev.y)) {
            Navigator::push(WifiSetupScreen::instance());
            return true;
        }
        int entry = entryAt(ev.x, ev.y);
        if (entry >= 0) launchEntry(entry);
        return entry >= 0;
    }

    // arrasto horizontal: a pagina acompanha o dedo
    if (ev.type == TouchEvent::Drag) {
        if (kui::touchState().moved && ev.startY > gridHeaderH() && abs(ev.dx()) > abs(ev.dy())) {
            // Sem buffer offscreen (modo direto): seguir o dedo exige um
            // redraw completo POR EVENTO — dezenas de piscadas por gesto.
            // Acumula o deslocamento e troca a pagina no release (redraw
            // unico). Com buffer, o arrasto continuo segue como sempre.
            if (!kui::canvasBuffered()) {
                m_dragAccum = ev.dx();
                return false;
            }
            int dx = ev.dx();
            if ((page == 0 && dx > 0) || (page == tp - 1 && dx < 0)) dx /= 3;  // resistencia nas pontas
            if (dx != m_dragDx) {
                m_dragDx = dx;
                return true;
            }
        }
        return false;
    }
    if (ev.type != TouchEvent::Release) return false;

    if (!kui::canvasBuffered() && m_dragAccum != 0) {
        // flip direto pelo acumulado do arrasto (modo sem buffer)
        int dx = m_dragAccum;
        m_dragAccum = 0;
        bool fast = ev.swipe() == TouchEvent::SwipeLeft || ev.swipe() == TouchEvent::SwipeRight;
        if ((dx < -UI::W / 4 || (fast && dx < 0)) && page < tp - 1) page++;
        else if ((dx > UI::W / 4 || (fast && dx > 0)) && page > 0) page--;
        m_needClear = true;
        return true;
    }
    if (m_dragDx != 0 || ev.swipe() == TouchEvent::SwipeLeft || ev.swipe() == TouchEvent::SwipeRight) {
        int dx = ev.dx();
        bool fast = ev.swipe() == TouchEvent::SwipeLeft || ev.swipe() == TouchEvent::SwipeRight;
        if ((dx < -UI::W / 4 || (fast && dx < 0)) && page < tp - 1) page++;
        else if ((dx > UI::W / 4 || (fast && dx > 0)) && page > 0) page--;
        m_dragDx = 0;
        return true;
    }

    if (!ev.isTap()) return false;

    if (wifiStatusRect().contains(ev.x, ev.y)) {
        Navigator::push(WifiSetupScreen::instance());
        return true;
    }

    for (int entry = page * gridCellsPerPage();
         entry < (page + 1) * gridCellsPerPage() && entry < LauncherUI::gridTotalEntries(); entry++) {
        if (!cellRect(entry).contains(ev.x, ev.y)) continue;
        launchEntry(entry);
        return true;
    }
    return false;
}

void LauncherScreen::onTick(uint32_t dtMs) {
    // rescan pedido com o launcher OCIOSO no topo (celerctl apps install,
    // shell rescan/run): antes so o onEnter ou um launch consumiam o pedido,
    // e o app instalado so aparecia na grade depois de reiniciar — o
    // waitEntry do "run" esperava um scan que nunca vinha
    if (LauncherUI::needsRescan) {
        LauncherUI::scanLocalApps();
        LauncherUI::needsRescan = false;
        if (page >= LauncherUI::gridTotalPages()) page = LauncherUI::gridTotalPages() - 1;
        if (page < 0) page = 0;
        clampScroll();  // apps a menos: rolagem antiga apontava alem do fim
        markDirty();
    }

    // "run" do shell (celerctl shell "run <app>")
    std::string req;
    if (LauncherUI::takeLaunchRequest(req)) {
        if (LauncherUI::needsRescan) {
            LauncherUI::scanLocalApps();
            LauncherUI::needsRescan = false;
        }
        int idx = LauncherUI::findEntry(req);
        if (idx >= 0) {
            // pedido novo vence o consentimento pendente (de outro app ou do
            // mesmo, ja concedido pelo shell `grant`): o launchEntry reabre o
            // dialogo se este ainda precisar dele
            if (Navigator::dialogOpen()) Navigator::closeDialog();
            launchEntry(idx);  // run remoto/autostart tambem pede consentimento
            return;
        }
        Navigator::toast("App não encontrado: " + req, THEME_ERR);
    }

    // pressionar e segurar (600 ms, sem arrastar) num app: acoes do app
    const kui::TouchState& ts = kui::touchState();
    if (m_pressEntry >= 0 && !m_longFired) {
        if (!ts.down || ts.moved || m_dragDx != 0) {
            if (!ts.down) m_pressEntry = -1;
        } else if (millis() - m_pressMs >= 600) {
            m_longFired = true;
            openAppActions(m_pressEntry);
        }
    }

    // relogio/rede mudam no maximo por segundo: sem formatar string a cada 5 ms
    m_pollAccumMs += dtMs;
    if (m_pollAccumMs < 250) return;
    m_pollAccumMs = 0;
    std::string clock = TimeManager::getFormattedTime();
    bool wifi = WebManager::isActive();
    if (clock != lastClock || wifi != lastWifi) {
        lastClock = clock;
        lastWifi = wifi;
        markDirty();
    }
}

// ============================================================ App host =====

namespace {
AppHostScreen* s_appHost[50] = {};
}

AppHostScreen* AppHostScreen::instance(int appIndex) {
    if (appIndex < 0 || appIndex >= 50) return nullptr;
    if (s_appHost[appIndex] == nullptr) s_appHost[appIndex] = new AppHostScreen(appIndex);
    return s_appHost[appIndex];
}

AppHostScreen::AppHostScreen(int appIndex) : m_appIndex(appIndex) {}

void AppHostScreen::draw(kui::Canvas& c) {
    c.fill(THEME_BG);
    c.text("Carregando app...", c.width() / 2, c.height() / 2, UI::font(2), THEME_TEXT_DIM, MC_DATUM);
}

void AppHostScreen::onEnter() { m_started = false; }

bool AppHostScreen::suppressRedraw() const {
    // app em task propria (CELEROS_APP_TASK): enquanto roda, o app e dono do
    // vidro — a UI nao pode pintar frame/toasts por cima
    return m_started && AppRunner::running();
}

void AppHostScreen::onTick(uint32_t) {
#ifdef CELEROS_APP_TASK
    if (m_started) {
        if (AppRunner::running()) return;
        // a task do app terminou: retoma input, mesma sequencia de saida do
        // caminho sincrono
        kui::Navigator::setInputSuspended(false);
        finishApp();
        return;
    }
    m_started = true;
    if (LauncherUI::launchAppAsync(m_appIndex)) return;  // roda na celerapp
    // sem suporte ou task nao criada: caminho sincrono classico
#endif
    LauncherUI::launchApp(m_appIndex);
    finishApp();
}

void AppHostScreen::finishApp() {
    // O toque que fechou o app (X do canto, botao do proprio app, erro) morre
    // aqui: sem isso o release vira tap no launcher — e o WiFi mora no mesmo
    // canto do X.
    TouchPump::quarantine(300);
    // O app pode ter empilhado tela nativa (System.openWifiSetup + exitApp):
    // no modo task o pedido foi registrado pelo binding e e atendido AQUI,
    // na main task (Navigator nao e thread-safe)
    if (AppRunner::consumeWifiSetupRequest()) {
        Navigator::push(WifiSetupScreen::instance());
    }
    // o host sai da pilha sem derrubar o que veio por cima
    if (Navigator::top() == this) Navigator::home();
    else Navigator::remove(this);
}

// ============================================================ WiFi setup ===

namespace {
WifiSetupScreen* s_wifiSetup = nullptr;

// Ponte do evento de scan (disparado na task do WiFi) para a tela: o handler
// so copia os resultados e acorda uma flag; o onTick consome no loop da UI.
// O vector e protegido por mutex e entregue por swap — o handler nunca
// realoca o buffer que a UI itera.
std::vector<ScannedNetwork> s_scanResults;   // escrito pelo handler (com lock)
std::vector<ScannedNetwork> s_scanBuffer;    // lido pelo rebuildList (so na UI)
SemaphoreHandle_t s_scanMutex = nullptr;
volatile bool s_scanDelivered = false;
bool s_scanHandlerBound = false;

// Nivel de sinal 1..4 (desenhado como barras pela List)
int rssiLevel(int32_t rssi) {
    if (rssi >= -50) return 4;
    if (rssi >= -62) return 3;
    if (rssi >= -74) return 2;
    return 1;
}
}  // namespace

WifiSetupScreen* WifiSetupScreen::instance() {
    if (s_wifiSetup == nullptr) {
        s_wifiSetup = new WifiSetupScreen();
        s_wifiSetup->m_btnBack.onTap = [] { Navigator::pop(); };
        s_wifiSetup->m_btnScan.onTap = [s = s_wifiSetup] { s->startScan(); };
        s_wifiSetup->m_btnWeb.onTap = [s = s_wifiSetup] { s->enterWebPortal(); };
        s_wifiSetup->m_list.onSelect = [s = s_wifiSetup](int idx) {
            if (idx < 0) return;
            if (idx >= (int)s->m_nets.size()) {  // item fixo "Outra rede"
                s->askHiddenSsid();
                return;
            }
            const NetEntry& n = s->m_nets[idx];
            if (n.secure) s->askPassword(n.ssid);
            else s->tryConnect(n.ssid, "", false);
        };
    }
    return s_wifiSetup;
}

void WifiSetupScreen::startScan() {
    if (!s_scanHandlerBound) {
        s_scanHandlerBound = true;
        if (s_scanMutex == nullptr) s_scanMutex = xSemaphoreCreateMutex();
        NetworkManager::instance().onScanCompleted.addHandler(
            [](const std::vector<ScannedNetwork>& nets) {
                if (xSemaphoreTake(s_scanMutex, portMAX_DELAY) == pdTRUE) {
                    s_scanResults.assign(nets.begin(), nets.end());
                    s_scanDelivered = true;
                    xSemaphoreGive(s_scanMutex);
                }
            });
    }
    s_scanDelivered = false;
    m_scanning = WebManager::startScanAsync();
    m_scanStartMs = millis();
    m_scanStarted = true;
    if (!m_scanning) Navigator::toast("Falha ao iniciar o scan", THEME_ERR);
    updateStatus();
    markDirty();
}

void WifiSetupScreen::rebuildList() {
    m_nets.clear();
    for (const auto& net : s_scanBuffer) {
        if (net.ssid[0] == '\0') continue;  // ocultas entram via "Outra rede"
        std::string ssid = net.ssid;
        bool dup = false;
        for (const auto& n : m_nets) {
            if (n.ssid == ssid) { dup = true; break; }
        }
        if (!dup) m_nets.push_back({ssid, net.rssi, net.authMode != WIFI_AUTH_OPEN});
    }

    // mais forte primeiro (a List corta rotulos longos com "..")
    std::sort(m_nets.begin(), m_nets.end(), [](const NetEntry& a, const NetEntry& b) { return a.rssi > b.rssi; });
    m_list.items.clear();
    for (const auto& n : m_nets) {
        List::Item it;
        it.label = n.ssid;
        it.right = n.secure ? "" : "aberta";
        it.bars = rssiLevel(n.rssi);
        m_list.items.push_back(it);
    }
    List::Item hidden;
    hidden.label = "Outra rede (oculta)...";
    m_list.items.push_back(hidden);
    m_list.selected = -1;
    m_list.scrollToTop();
}

void WifiSetupScreen::updateStatus() {
    if (m_phase == WebPortal) {
        m_status.clear();
        return;
    }
    if (m_scanning) {
        m_status = "Buscando redes...";
        return;
    }
    if (WebManager::isActive()) {
        std::string ip = WebManager::getIPAddress();
        m_status = "Conectado" + (ip.empty() ? "" : " - " + ip);
        return;
    }
    if (m_nets.empty()) {
        m_status = m_scanStarted ? "Nenhuma rede encontrada" : "";
        return;
    }
    m_status = kstr::fmt("%d redes - toque para conectar", (int)m_nets.size());
}

void WifiSetupScreen::askPassword(const std::string& ssid) {
    KeyboardScreen* kb = new KeyboardScreen("Senha: " + ssid, "", 64);
    kb->setMask(true);  // campo em bullets com botao ver/ocu no cabecalho
    m_kbTrash = m_kb;  // teclado anterior sai fora da cadeia de chamadas dele
    m_kb = kb;
    kb->onResult = [this, ssid](const std::string& text, bool ok) {
        Navigator::pop();  // tira o teclado; esta tela volta ao topo
        std::string pass = kstr::trim(text);
        if (ok && !pass.empty()) tryConnect(ssid, pass, true);
    };
    Navigator::push(kb);
}

void WifiSetupScreen::askHiddenSsid() {
    KeyboardScreen* kb = new KeyboardScreen("Nome da rede (SSID)", "", 32);
    m_kbTrash = m_kb;
    m_kb = kb;
    kb->onResult = [this](const std::string& text, bool ok) {
        Navigator::pop();
        std::string ssid = kstr::trim(text);
        if (ok && !ssid.empty()) askPassword(ssid);
    };
    Navigator::push(kb);
}

namespace {
// Resultado da task de conexao: -1 rodando/ocioso, 0 falhou, 1 conectou
volatile int s_connResult = -1;
bool s_connRunning = false;

struct ConnJob {
    std::string ssid, password;
};

void connectTask(void* arg) {
    ConnJob* job = (ConnJob*)arg;
    bool ok = WebManager::connect(job->ssid, job->password, true, 15000);
    delete job;
    s_connResult = ok ? 1 : 0;
    vTaskDelete(nullptr);
}
}  // namespace

void WifiSetupScreen::tryConnect(const std::string& ssid, const std::string& password,
                                 bool secure) {
    if (s_connRunning) return;
    m_connSsid = ssid;
    m_connSecure = secure;
    s_connResult = -1;
    ConnJob* job = new ConnJob{ssid, password};
    if (xTaskCreate(connectTask, "wifi_conn", 6144, job, 5, nullptr) != pdPASS) {
        delete job;
        Navigator::toast("Sem memória para conectar", THEME_ERR);
        return;
    }
    s_connRunning = true;
    m_phase = Connecting;
    m_spinMs = 0;
    markDirty();
}

void WifiSetupScreen::finishConnect(bool ok) {
    s_connRunning = false;
    s_connResult = -1;
    m_phase = LocalList;
    if (ok) {
        WebManager::enable();  // religa o servidor web se o usuario o tinha ligado
        Navigator::toast("Conectado a " + m_connSsid, THEME_OK);
        m_scanStarted = false;  // proxima entrada refaz o scan
        Navigator::pop();       // volta para quem abriu (launcher/settings)
        return;
    }
    Navigator::toast("Falha ao conectar", THEME_ERR);
    updateStatus();
    markDirty();
    if (m_connSecure) askPassword(m_connSsid);  // senha provavelmente errada: pede de novo
}

void WifiSetupScreen::enterWebPortal() {
    m_phase = WebPortal;
    m_portalState = 0;
    m_portalDetail.clear();
    m_portalStarted = WifiSetupPortal::begin();
    if (!m_portalStarted) {
        Navigator::toast("Falha ao abrir o portal", THEME_ERR);
        m_phase = LocalList;
    }
    markDirty();
}

void WifiSetupScreen::leaveWebPortal() {
    if (m_portalStarted) {
        WifiSetupPortal::end();
        m_portalStarted = false;
    }
    m_phase = LocalList;
    m_portalState = 0;
    m_portalDetail.clear();
    startScan();  // o radio trocou de modo; a lista antiga esta stale
}

void WifiSetupScreen::onEnter() {
    if (m_phase == WebPortal) {
        if (!m_portalStarted) m_portalStarted = WifiSetupPortal::begin();
    } else if (!m_scanStarted) {
        startScan();
    } else {
        updateStatus();  // estado pode ter mudado desde a ultima visita
    }
    markDirty();
}

void WifiSetupScreen::onExit() {
    // onExit roda tambem ao EMPILHAR o teclado por cima — so derruba o
    // portal quando a tela sai de vez ainda em modo web sem conexao.
    if (m_phase == WebPortal && m_portalState != 1 && m_portalStarted) {
        WifiSetupPortal::end();
        m_portalStarted = false;
        m_phase = LocalList;
    }
}

void WifiSetupScreen::draw(Canvas& c) {
    c.fill(THEME_BG);
    drawHeader(c, "WiFi");
    int hdr = headerHeight();

    if (m_phase == Connecting) {
        // spinner: arco de 90 graus girando sobre trilho
        int r = UI::sx(22), t = UI::sx(5);
        int cy = UI::sy(150);
        c.fillArc(UI::cx(), cy, r - t, r, 0, 360, THEME_CARD);
        float a0 = (float)((m_spinMs * 360 / 1000) % 360);
        c.fillArc(UI::cx(), cy, r - t, r, a0, a0 + 90, THEME_ACCENT);
        c.text("Conectando em", UI::cx(), UI::sy(200), type::body(), THEME_TEXT_DIM, MC_DATUM);
        c.text(c.ellipsize(m_connSsid, type::title(), UI::W - UI::sx(24)), UI::cx(), UI::sy(226), type::title(),
               THEME_TEXT, MC_DATUM);
        return;
    }

    if (m_phase == WebPortal) {
        c.text("1. Conecte no ponto de acesso:", UI::cx(), UI::sy(92), UI::font(2), THEME_TEXT, MC_DATUM);
        c.text(WifiSetupPortal::apSsid(), UI::cx(), UI::sy(114), UI::font(2), THEME_ACCENT, MC_DATUM);
        c.text("2. Abra no navegador:", UI::cx(), UI::sy(144), UI::font(2), THEME_TEXT, MC_DATUM);
        c.text("http://192.168.4.1", UI::cx(), UI::sy(166), UI::font(2), THEME_ACCENT, MC_DATUM);

        const char* status = "Aguardando configuração...";
        uint32_t statusColor = THEME_TEXT_DIM;
        if (!m_portalStarted) {
            status = "Falha ao iniciar o portal";
            statusColor = THEME_ERR;
        } else if (m_portalState == 1) {
            status = "Conectado!";
            statusColor = THEME_OK;
        } else if (m_portalState == 2) {
            status = "Falhou - tente de novo pela pagina";
            statusColor = THEME_ERR;
        }
        c.text(status, UI::cx(), UI::sy(202), UI::font(1), statusColor, MC_DATUM);
        if (m_portalState == 1 && !m_portalDetail.empty()) {
            c.text(m_portalDetail, UI::cx(), UI::sy(220), UI::font(1), THEME_TEXT_DIM, MC_DATUM);
        }

        m_btnBack.label = "Voltar";
        m_btnBack.style = Button::Ghost;
        m_btnBack.rect = {UI::sx(70), UI::sy(270), UI::sx(100), UI::sy(32)};
        m_btnBack.draw(c);
        return;
    }

    if (!m_status.empty()) {
        c.text(m_status, UI::cx(), hdr + UI::sy(13), UI::font(1),
               m_scanning ? THEME_ACCENT : THEME_TEXT_DIM, MC_DATUM);
    }

    int by = UI::H - UI::sy(40);
    int gap = UI::sx(6);
    int bw = (UI::W - UI::sx(16) - 2 * gap) / 3;
    m_btnBack.label = "Voltar";
    m_btnBack.style = Button::Ghost;
    m_btnBack.rect = {UI::sx(8), by, bw, UI::sy(32)};
    m_btnScan.label = "Buscar";
    m_btnScan.style = Button::Ghost;
    m_btnScan.rect = {UI::sx(8) + bw + gap, by, bw, UI::sy(32)};
    m_btnWeb.label = "Via web";
    m_btnWeb.style = Button::Ghost;
    m_btnWeb.rect = {UI::sx(8) + 2 * (bw + gap), by, bw, UI::sy(32)};

    int listTop = hdr + UI::sy(22);
    m_list.rect = {UI::sx(8), listTop, UI::W - UI::sx(16), by - UI::sy(8) - listTop};
    if (m_list.items.empty()) {
        int midY = (listTop + by) / 2;
        if (!m_scanning) {
            c.text("Nenhuma rede encontrada", UI::cx(), midY - UI::sy(8), UI::font(2),
                   THEME_TEXT_DIM, MC_DATUM);
            if (m_scanStarted) {
                c.text("Toque em Buscar para tentar de novo", UI::cx(), midY + UI::sy(12),
                       UI::font(1), THEME_TEXT_DIM, MC_DATUM);
            }
        }
    } else {
        m_list.draw(c);
    }
    m_btnBack.draw(c);
    m_btnScan.draw(c);
    m_btnWeb.draw(c);
}

bool WifiSetupScreen::onTouch(const TouchEvent& ev) {
    if (m_phase == Connecting) return false;
    if (m_phase == WebPortal) return m_btnBack.onTouch(ev, m_btnBack.rect);
    if (m_btnBack.onTouch(ev, m_btnBack.rect)) return true;
    if (m_btnScan.onTouch(ev, m_btnScan.rect)) return true;
    if (m_btnWeb.onTouch(ev, m_btnWeb.rect)) return true;
    return m_list.onTouch(ev, m_list.rect);
}

void WifiSetupScreen::onTick(uint32_t dtMs) {
    // Teclado descartado so e deletado aqui, fora da cadeia de chamadas dele
    if (m_kbTrash != nullptr) {
        delete m_kbTrash;
        m_kbTrash = nullptr;
    }

    if (m_phase == Connecting) {
        uint32_t before = m_spinMs / 40;
        m_spinMs += dtMs;
        if (m_spinMs / 40 != before) markDirty();  // ~25 fps
        if (s_connResult >= 0) finishConnect(s_connResult == 1);
        return;
    }

    if (m_list.tick(dtMs)) markDirty();  // inercia do scroll

    if (m_phase == LocalList) {
        if (s_scanDelivered) {
            bool doRebuild = false;
            if (xSemaphoreTake(s_scanMutex, portMAX_DELAY) == pdTRUE) {
                s_scanDelivered = false;
                if (m_scanning) {
                    m_scanning = false;
                    s_scanBuffer.swap(s_scanResults);
                    s_scanResults.clear();
                    doRebuild = true;
                }
                xSemaphoreGive(s_scanMutex);
            }
            if (doRebuild) {
                rebuildList();
                updateStatus();
                markDirty();
            }
        } else if (m_scanning && millis() - m_scanStartMs > 20000) {
            m_scanning = false;  // o evento de scan se perdeu
            updateStatus();
            markDirty();
        }
        return;
    }

    // Modo web: poll nao-bloqueante do portal
    if (m_portalStarted && m_portalState == 0) {
        std::string detail;
        WifiSetupPortal::State st = WifiSetupPortal::poll(detail);
        if (st == WifiSetupPortal::Connected) {
            m_portalState = 1;
            m_portalDetail = detail;
            m_portalDoneAtMs = millis();
            markDirty();
        } else if (st == WifiSetupPortal::Failed) {
            m_portalState = 2;
            markDirty();
        }
    }
    if (m_portalState == 1 && millis() - m_portalDoneAtMs > 1500) {
        m_phase = LocalList;   // onExit nao deve derrubar a STA conectada
        m_portalStarted = false;
        m_scanStarted = false;
        Navigator::toast("WiFi conectado", THEME_OK);
        Navigator::pop();
    }
}

