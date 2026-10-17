#ifndef CELEROS_ALARM_SCREEN_H
#define CELEROS_ALARM_SCREEN_H

// Tela de alarme em tela cheia (API 15): acende o vidro, bipa em ciclos ate
// Parar/Soneca (ou 2 min sem resposta = soneca automatica). Empilhada pelo
// service() no loop da UI quando o Kernel/Alarms tem toque pendente; com app
// aberto o present() pede a saida do app antes. BOOT/home tambem param.
// Coberta por outra tela NAO dispensa o toque (onCovered padrao): a tela
// segue na pilha e retoma o bip quando volta ao topo.

#include "../UI/Kui.h"

class AlarmScreen : public kui::Screen {
public:
    // Chamar no loop da UI: empilha a tela quando ha toque pendente.
    static void service();
    // A tela do alarme esta no TOPO da pilha? (guarda de prioridade dos
    // servicos que empilham overlays: nada cobre o alarme tocando)
    static bool onTop();

    void onEnter() override;
    void onExit() override;
    void draw(kui::Canvas& c) override;
    bool onTouch(const kui::TouchEvent& ev) override;
    void onTick(uint32_t dtMs) override;
    bool allowsBackGesture() const override { return false; }

private:
    kui::Rect snoozeRect() const;
    kui::Rect stopRect() const;
    void finish(bool snooze);

    uint32_t m_startMs = 0;
    uint32_t m_beepAccum = 0;
    bool m_done = false;
    bool m_canSnooze = true;
    bool m_wasAsleep = false;  // vidro dormia quando o alarme empilhou
    std::string m_label;
    std::string m_kind;
};

#endif  // CELEROS_ALARM_SCREEN_H
