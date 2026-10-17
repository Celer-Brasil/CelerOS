#include "AlarmScreen.h"
#include "../Kernel/Alarms.h"
#include "../Kernel/TimeManager.h"
#include "../Display/Backlight.h"
#include "../Display/ScreenPower.h"
#include "../Display/Theme.h"
#include "../Hardware/BoardIO.h"
#include <Arduino.h>

namespace {
AlarmScreen s_screen;
// Tela na pilha (topo OU coberta por outra): o service nao re-empilha a
// instancia estatica. Zerada no onExit (saida de verdade — pop/home/remove);
// ser coberta NAO passa por aqui (Navigator chama onCovered, no-op).
bool s_pushed = false;
constexpr uint32_t kBeepEveryMs = 1500;
constexpr uint32_t kAutoSnoozeMs = 120000;  // 2 min sem resposta
}  // namespace

void AlarmScreen::service() {
    if (!Alarms::ringing()) return;
    // Guarda pela flag (nao pelo topo): coberta por outra tela a instancia
    // continua na pilha e o antigo "top() == &s_screen" a empilharia DUAS
    // vezes. O service roda so na task da UI (LOOP), dona da pilha.
    if (s_pushed) return;
    Backlight::noteActivity();  // acorda o vidro (o ScreenPower segue o edge)
    s_pushed = true;
    kui::Navigator::push(&s_screen);
}

bool AlarmScreen::onTop() { return kui::Navigator::top() == &s_screen; }

void AlarmScreen::onEnter() {
    Alarms::Ring r;
    Alarms::ringing(&r);
    m_label = r.label;
    m_canSnooze = r.kind != Alarms::Kind::Timer;
    m_kind = r.kind == Alarms::Kind::Timer ? "Timer" : r.kind == Alarms::Kind::Snooze ? "Soneca" : "Alarme";
    m_startMs = millis();
    m_beepAccum = kBeepEveryMs;  // bipa ja no primeiro tick
    m_done = false;
    m_wasAsleep = ScreenPower::state() <= 2;  // o alarme e quem acordou o vidro
    Backlight::noteActivity();
}

void AlarmScreen::onExit() {
    // Saiu de VERDADE da pilha (pop/home/remove — coberta nao passa aqui):
    // solta a guarda do service e, sem escolher (BOOT/home), para o toque
    s_pushed = false;
    if (!m_done) Alarms::dismiss();
    m_done = true;
}

kui::Rect AlarmScreen::snoozeRect() const {
    const int m = UI::sx(16) + UI::inset / 2;
    return {m, UI::sy(200), UI::W - 2 * m, UI::sy(44)};
}

kui::Rect AlarmScreen::stopRect() const {
    const int m = UI::sx(16) + UI::inset / 2;
    return {m, UI::sy(256), UI::W - 2 * m, UI::sy(44)};
}

void AlarmScreen::draw(kui::Canvas& c) {
    c.fill(THEME_BG);
    c.text(m_kind, UI::cx(), UI::sy(40) + UI::inset / 2, kui::type::title(), THEME_WARN, MC_DATUM);
    c.text(TimeManager::getFormattedTime(), UI::cx(), UI::sy(100), kui::type::display(), THEME_TEXT, MC_DATUM);
    if (!m_label.empty()) {
        c.text(m_label, UI::cx(), UI::sy(150), kui::type::body(), THEME_TEXT_DIM, MC_DATUM);
    }
    if (m_canSnooze) {
        kui::Rect s = snoozeRect();
        c.fillRoundRect(s, s.h / 2, kui::isPressed(s) ? THEME_RAISED : THEME_CARD);
        c.text("Soneca 5 min", s.x + s.w / 2, s.y + s.h / 2, kui::type::body(), THEME_TEXT, MC_DATUM);
    }
    kui::Rect p = stopRect();
    c.fillRoundRect(p, p.h / 2, kui::isPressed(p) ? THEME_ACCENT_D : THEME_ACCENT);
    c.text("Parar", p.x + p.w / 2, p.y + p.h / 2, kui::type::body(), THEME_ON_ACCENT, MC_DATUM);
}

bool AlarmScreen::onTouch(const kui::TouchEvent& ev) {
    if (ev.type != kui::TouchEvent::Release) {
        markDirty();  // feedback de pressionado
        return true;
    }
    if (!ev.isTap()) return true;
    if (stopRect().contains(ev.x, ev.y)) {
        finish(false);
    } else if (m_canSnooze && snoozeRect().contains(ev.x, ev.y)) {
        finish(true);
    }
    return true;
}

void AlarmScreen::onTick(uint32_t dtMs) {
    if (m_done) return;
    if (!Alarms::ringing()) {  // dispensado por outro caminho
        m_done = true;
        kui::Navigator::pop();
        return;
    }
    ScreenPower::keepAwakeFor(3000);  // sem dim/AOD enquanto toca
    if (millis() - m_startMs >= kAutoSnoozeMs) {
        finish(m_canSnooze);
        // Ninguem respondeu em 2 min (device no pulso, dono dormindo): o
        // alarme FOI quem acordou o vidro, entao ele devolve o sono — sem
        // isso a tela ficava acesa ate o timeout de tela (mesmo contrato do
        // m_wasAsleep do alerta de notificacao). Toque em Parar/Soneca sai
        // pelo onTouch e a tela segue acesa (usuario presente).
        if (m_wasAsleep) ScreenPower::sleepNow();
        return;
    }
    m_beepAccum += dtMs;
    if (m_beepAccum >= kBeepEveryMs) {
        m_beepAccum = 0;
        // Jingle fora do tick: tone() bloqueante congelava a UI ~600 ms por
        // ciclo, justo quando o usuario tenta tocar em Parar/Soneca
        for (int i = 0; i < 3; i++) BoardIO::toneAsync(1800, 120, 80);
        markDirty();  // relogio na tela acompanha
    }
}

void AlarmScreen::finish(bool snooze) {
    if (m_done) return;
    m_done = true;
    BoardIO::toneStop();  // nao continua bipando apos atender/dispensar
    if (snooze) {
        Alarms::snooze();
        kui::Navigator::toast("Soneca: 5 min", THEME_ACCENT, 2000);
    } else {
        Alarms::dismiss();
    }
    kui::Navigator::pop();
}
