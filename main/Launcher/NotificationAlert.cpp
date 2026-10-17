#include "NotificationAlert.h"
#include "AlarmScreen.h"
#include "LauncherUI.h"
#include "WatchPanels.h"
#include "../Display/Backlight.h"
#include "../Display/ScreenPower.h"
#include "../Display/Theme.h"
#include "../Kernel/Alarms.h"
#include "../Kernel/Notifications.h"
#include "../Kernel/TimeManager.h"
#include "../UI/Kui.h"
#include <Arduino.h>
#include <stdio.h>
#include <string>
#include <vector>

namespace {

constexpr uint32_t kStaleMs = 15000;  // pedido mais velho que isso morre
constexpr uint32_t kShowMs = 8000;    // sem toque: volta a dormir
constexpr int kTitleLines = 2;
constexpr int kBodyLines = 6;

// Par pedido/idade escrito pela task do BLE e consumido pela UI: sob
// portMUX (mesmo padrao do WatchPanels::request) — sem ele a UI podia ler
// o s_req novo com o s_reqAt velho e matar o alerta como "pedido velho".
portMUX_TYPE s_reqMux = portMUX_INITIALIZER_UNLOCKED;
volatile bool s_req = false;
volatile uint32_t s_reqAt = 0;

class AlertScreen : public kui::Screen {
public:
    void onEnter() override {
        m_wasAsleep = ScreenPower::state() <= 2;
        Backlight::noteActivity();  // acorda: edges do tick fazem o resto
        load();
        m_ageMs = 0;
    }

    // Notificacao nova com o alerta ja na tela: troca o conteudo e renova.
    void refresh() {
        load();
        m_ageMs = 0;
        markDirty();
    }

    void draw(kui::Canvas& c) override {
        c.fill(THEME_BG);
        // primeiro meio segundo: repinta enquanto o painel acorda (o push
        // inicial pode ter ido ao vidro ainda em SLPIN)
        if (m_ageMs < 500) markDirty();

        // geometria em duas passadas: mede o conteudo e dimensiona o card
        // (card curto para notificacao curta, em vez de vidro vazio embaixo)
        const int m = UI::sx(10) + UI::inset / 2;
        const int top = UI::sy(22) + UI::inset / 3;
        const int bot = UI::H - UI::sy(30) - UI::inset / 3;
        const int x = m + UI::sx(18);
        const int w = UI::W - 2 * m - UI::sx(30);
        const lgfx::IFont* fc = kui::type::body();
        const lgfx::IFont* ft = kui::type::title();

        const std::string title = m_title.empty() ? m_msg : m_title;
        const std::vector<std::string> titleLines =
            c.wrapText(title, ft, w, kTitleLines);
        std::vector<std::string> bodyLines;
        if (!m_msg.empty() && !m_title.empty())
            bodyLines = c.wrapText(m_msg, fc, w, kBodyLines);

        int contentH = UI::sy(12) + UI::sy(26) + (int)titleLines.size() * UI::sy(26);
        if (!bodyLines.empty()) contentH += UI::sy(8) + (int)bodyLines.size() * UI::sy(19);
        if (m_unread > 1) contentH += UI::sy(22);
        contentH += UI::sy(10);  // respiro de baixo

        const int area = bot - top;
        const int cardH = contentH < UI::sy(110) ? UI::sy(110)
                                                : (contentH > area ? area : contentH);
        const kui::Rect card = {m, top + (area - cardH) / 2, UI::W - 2 * m, cardH};
        c.fillRoundRect(card, UI::sx(14), THEME_CARD);
        c.fillRoundRect({card.x + UI::sx(7), card.y + UI::sy(12), UI::sx(3), card.h - UI::sy(24)},
                        1, THEME_ACCENT);

        int y = card.y + UI::sy(12);
        std::string src = m_src.empty() ? "Aviso" : m_src;
        c.text(c.ellipsize(src, fc, w - UI::sx(70)), x, y, fc, THEME_ACCENT, ML_DATUM);
        c.text(when(), card.x + card.w - UI::sx(14), y, fc, THEME_TEXT_DIM, MR_DATUM);
        y += UI::sy(26);

        for (const std::string& ln : titleLines) {
            c.text(ln, x, y, ft, THEME_TEXT, ML_DATUM);
            y += UI::sy(26);
        }
        y += UI::sy(8);
        for (const std::string& ln : bodyLines) {
            c.text(ln, x, y, fc, THEME_TEXT_DIM, ML_DATUM);
            y += UI::sy(19);
        }

        if (m_unread > 1) {
            char b[24];
            snprintf(b, sizeof(b), "e mais %d", m_unread - 1);
            c.text(b, card.x + card.w / 2, card.y + card.h - UI::sy(12), fc, THEME_ACCENT,
                   MC_DATUM);
        }
        c.text("toque: central", UI::cx(), UI::H - UI::sy(12) - UI::inset / 3, fc, THEME_STROKE,
               MC_DATUM);
    }

    bool onTouch(const kui::TouchEvent& ev) override {
        if (ev.type != kui::TouchEvent::Release) return true;
        if (ev.isTap()) {
            // central com volta para a casa (WatchPanels::service empilha no
            // proximo tick; o pop abaixo fecha o alerta)
            kui::Navigator::pop();
            WatchPanels::request(WatchPanels::Panel::Notifications, true);
        } else {
            kui::Navigator::pop();  // swipe dispensa o alerta
        }
        return true;
    }

    void onTick(uint32_t dtMs) override {
        ScreenPower::keepAwakeFor(2500);
        m_ageMs += dtMs;
        if (m_ageMs >= kShowMs) {
            kui::Navigator::pop();
            if (m_wasAsleep) ScreenPower::sleepNow();  // ninguem tocou: dorme
        }
    }

    bool allowsBackGesture() const override { return false; }

private:
    // Hora da NOTIFICACAO (nao a corrente): HH:MM; sem epoch valida, a hora
    // de agora.
    std::string when() const {
        if (m_epoch == 0) return TimeManager::getFormattedTime();
        time_t e = (time_t)m_epoch;
        struct tm t;
        localtime_r(&e, &t);
        char b[8];
        snprintf(b, sizeof(b), "%02d:%02d", t.tm_hour, t.tm_min);
        return b;
    }

    void load() {
        m_title.clear();
        m_msg.clear();
        m_src.clear();
        m_epoch = 0;
        m_unread = 0;
        for (const Notifications::Note& n : Notifications::list()) {
            if (n.read) continue;
            if (m_unread == 0) {
                m_title = n.title;
                m_msg = n.msg;
                m_src = n.src.rfind("phone:", 0) == 0 && n.src.size() > 6 ? n.src.substr(6)
                                                                         : std::string(n.src);
                m_epoch = n.epoch;
            }
            m_unread++;
        }
    }

    std::string m_title, m_msg, m_src;
    int64_t m_epoch = 0;
    int m_unread = 0;
    uint32_t m_ageMs = 0;
    bool m_wasAsleep = false;
};
AlertScreen s_alert;

}  // namespace

namespace NotificationAlert {

void request() {
    portENTER_CRITICAL(&s_reqMux);
    s_reqAt = millis();
    s_req = true;
    portEXIT_CRITICAL(&s_reqMux);
}

void service(bool inApp) {
    if (!s_req) return;  // fast path; o par (pedido, idade) e lido no mux
    // Pedido velho morre sozinho: lidos e consumidos atomicamente, para nao
    // ler o s_req novo com o s_reqAt antigo.
    bool stale = false;
    portENTER_CRITICAL(&s_reqMux);
    if (s_req && millis() - s_reqAt > kStaleMs) {
        s_req = false;
        stale = true;
    }
    portEXIT_CRITICAL(&s_reqMux);
    if (stale) return;
    if (inApp) {
        // tela acesa e usuario dentro de um app: nao interrompe e nao fica
        // pendente (sai do app = sem alerta surpresa depois) — mas tambem
        // nao fica em silencio: no watch o push nao faz toast (virou
        // alerta), entao o heads-up aqui e o toast com o titulo.
        if (ScreenPower::state() >= 3) {
            s_req = false;
            for (const Notifications::Note& n : Notifications::list()) {
                if (!n.read) {
                    kui::Navigator::toast(n.title, THEME_ACCENT, 3000);
                    break;
                }
            }
            return;
        }
        LauncherUI::requestAppExit();
        return;
    }
    // Alarme tocando no topo: o alerta NAO cobre a tela do alarme. O pedido
    // fica pendente (o service volta aqui a cada tick): alarme atendido em
    // ate kStaleMs, o alerta sobe; alem disso, morre pelo caminho normal de
    // pedido velho — a notificacao segue na central.
    if (Alarms::ringing() && AlarmScreen::onTop()) return;
    portENTER_CRITICAL(&s_reqMux);
    s_req = false;  // consumido: sobe o alerta ou renova o que ja esta nele
    portEXIT_CRITICAL(&s_reqMux);
    if (kui::Navigator::top() == &s_alert) {
        s_alert.refresh();
        return;
    }
    kui::Navigator::push(&s_alert);
}

}  // namespace NotificationAlert
