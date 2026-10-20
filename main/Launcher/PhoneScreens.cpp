#include "PhoneScreens.h"
#include "AlarmScreen.h"
#include "../Bluetooth/PhoneLink.h"
#include "../Display/Backlight.h"
#include "../Display/ScreenPower.h"
#include "../Display/Theme.h"
#include "../Hardware/BoardIO.h"
#include "../Kernel/Alarms.h"
#include "../UI/Kui.h"
#include <Arduino.h>
#include <stdio.h>
#include <string>

namespace {

// Telas na pilha (topo OU cobertas): o service nao re-empilha as instancias
// estaticas. Zeradas no onExit (saida de verdade — pop/home/remove); ser
// coberta NAO passa por ali (Navigator chama onCovered, no-op). Mesma guarda
// do AlarmScreen: com o antigo "top() == &s_x" um alerta cobrindo a tela
// fazia o service re-empilhar POR CIMA do alerta e congelar o onTick dele.
bool s_callPushed = false;
bool s_pairPushed = false;

// Digitos grandes: fonte 8 (7-seg 75 px) no vidro grande; 4 nos pequenos
uint8_t bigDigitsFont() { return UI::W >= 400 ? 8 : 4; }

class PairScreen : public kui::Screen {
public:
    void onEnter() override { Backlight::noteActivity(); }
    void onExit() override {
        // Saiu de VERDADE da pilha (pop/home/remove): solta a guarda do
        // service (ser coberta NAO passa por aqui)
        s_pairPushed = false;
    }
    void draw(kui::Canvas& c) override {
        if (c.mode() == kui::Canvas::Direct) c.fill(THEME_BG);
        char b[12];
        snprintf(b, sizeof(b), "%06lu", (unsigned long)PhoneLink::passkey());
        c.text("Código", UI::cx(), UI::sy(70) + UI::inset / 3, kui::type::body(), THEME_TEXT_DIM, MC_DATUM);
        c.text(b, UI::cx(), UI::cy(), bigDigitsFont(), THEME_TEXT, MC_DATUM);
        c.text("digite no celular", UI::cx(), UI::H - UI::sy(70) - UI::inset / 3, kui::type::caption(),
               THEME_TEXT_DIM, MC_DATUM);
    }
    bool onTouch(const kui::TouchEvent&) override { return true; }
    void onTick(uint32_t) override {
        ScreenPower::keepAwakeFor(3000);
        if (PhoneLink::passkey() == 0) {
            kui::Navigator::pop();
            if (PhoneLink::connected()) kui::Navigator::toast("Celular pareado", THEME_OK, 2500);
        }
    }
    bool allowsBackGesture() const override { return false; }
};
PairScreen s_pair;

class CallScreen : public kui::Screen {
public:
    void onEnter() override {
        m_ringAccum = 1500;  // toca ja no primeiro tick
        m_done = false;
        Backlight::noteActivity();
        PhoneLink::callInfo(m_name, m_number);
    }
    void onExit() override {
        // saiu sem escolher (BOOT/home): so para de tocar aqui
        m_done = true;
        // e solta a guarda do service (saida de verdade da pilha)
        s_callPushed = false;
    }
    void draw(kui::Canvas& c) override {
        if (c.mode() == kui::Canvas::Direct) c.fill(THEME_BG);
        const int top = UI::sy(56) + UI::inset / 3;
        c.text("Chamada", UI::cx(), top, kui::type::body(), THEME_TEXT_DIM, MC_DATUM);
        const std::string who = m_name.empty() ? m_number : m_name;
        c.text(c.ellipsize(who.empty() ? "Desconhecido" : who, kui::type::title(), UI::W - UI::sx(30) - UI::inset),
               UI::cx(), UI::sy(120), kui::type::title(), THEME_TEXT, MC_DATUM);
        if (!m_name.empty() && !m_number.empty()) {
            c.text(m_number, UI::cx(), UI::sy(150), kui::type::caption(), THEME_TEXT_DIM, MC_DATUM);
        }
        kui::Rect r = rejectRect(), a = acceptRect();
        c.fillCircle(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, kui::isPressed(r) ? 0x902020u : THEME_ERR);
        c.fillCircle(a.x + a.w / 2, a.y + a.h / 2, a.w / 2, kui::isPressed(a) ? 0x107040u : THEME_OK);
        c.text("Recusar", r.x + r.w / 2, r.y + r.h + UI::sy(12), kui::type::caption(), THEME_TEXT, MC_DATUM);
        c.text("Atender", a.x + a.w / 2, a.y + a.h + UI::sy(12), kui::type::caption(), THEME_TEXT, MC_DATUM);
    }
    bool onTouch(const kui::TouchEvent& ev) override {
        if (ev.type != kui::TouchEvent::Release) {
            markDirty();
            return true;
        }
        if (!ev.isTap()) return true;
        if (rejectRect().contains(ev.x, ev.y)) finish(0);
        else if (acceptRect().contains(ev.x, ev.y)) finish(1);
        return true;
    }
    void onTick(uint32_t dtMs) override {
        if (m_done) return;
        std::string n, num;
        if (!PhoneLink::callInfo(n, num)) {  // celular avisou o fim
            m_done = true;
            kui::Navigator::pop();
            return;
        }
        ScreenPower::keepAwakeFor(3000);
        m_ringAccum += dtMs;
        if (m_ringAccum >= 1500) {
            m_ringAccum = 0;
            BoardIO::toneAsync(1200, 200, 80);  // fora do tick: UI livre p/ tocar
            BoardIO::toneAsync(1500, 200);
        }
    }
    bool allowsBackGesture() const override { return false; }

private:
    kui::Rect rejectRect() const {
        const int d = UI::sx(64);
        return {UI::cx() - UI::sx(52) - d / 2, UI::sy(200), d, d};
    }
    kui::Rect acceptRect() const {
        const int d = UI::sx(64);
        return {UI::cx() + UI::sx(52) - d / 2, UI::sy(200), d, d};
    }
    void finish(int action) {
        if (m_done) return;
        m_done = true;
        BoardIO::toneStop();  // nao segue bipando apos atender/recusar
        PhoneLink::callAnswer(action);
        kui::Navigator::pop();
    }
    std::string m_name, m_number;
    uint32_t m_ringAccum = 0;
    bool m_done = false;
};
CallScreen s_call;

}  // namespace

namespace PhoneScreens {

void service(bool inApp) {
    if (inApp) return;  // empurrar tela sobre app aberto e papel do PhoneLink::tick
    // Alarme tocando no topo: chamada/pareamento NAO cobrem a tela do alarme.
    // O service roda todo tick: encerrado o alarme (Parar/Soneca/2 min), a
    // chamada ainda ativa ou o codigo ainda valido sobem aqui mesmo.
    if (Alarms::ringing() && AlarmScreen::onTop()) return;
    // Guarda pelas FLAGS (nao pelo topo), como o AlarmScreen::service: um
    // alerta de notificacao cobrindo a chamada faria o service re-empilhar
    // a tela POR CIMA do alerta (onTick do alerta congelado). O service roda
    // so na task da UI (LOOP), dona da pilha.
    std::string n, num;
    if (PhoneLink::callInfo(n, num)) {
        if (!s_callPushed) {
            s_callPushed = true;
            kui::Navigator::push(&s_call);
        }
        return;
    }
    if (PhoneLink::passkey() != 0 && !s_pairPushed && !s_callPushed) {
        s_pairPushed = true;
        kui::Navigator::push(&s_pair);
    }
}

}  // namespace PhoneScreens
