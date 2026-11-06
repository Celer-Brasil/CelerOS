#ifndef CELEROS_SCREENS_H
#define CELEROS_SCREENS_H

// Telas Kui do CelerOS (W7c). O LauncherScreen e a base da pilha do
// Navigator; as telas antigas (ainda nao portadas) rodam embrulhadas em
// LegacyScreen ate sua migracao.

#include "../UI/Kui.h"
#include "../UI/Keyboard.h"

// ---------------------------------------------------------------- Launcher --
class LauncherScreen : public kui::Screen {
public:
    void onEnter() override;
    void onResume() override;
    void draw(kui::Canvas& c) override;
    bool onTouch(const kui::TouchEvent& ev) override;
    void onTick(uint32_t dtMs) override;
    // Arrasto de pagina por passadas parciais (ver draw): devolve a faixa que
    // mudou desde a ultima composicao. false = quadro inteiro.
    bool partialFrame(kui::Rect& out) override;

private:
    kui::Rect cellRect(int entryIndex) const;
    void drawStatusBar(kui::Canvas& c);
    // Arrasto de pagina: a pagina que ENTRA (capa) e o deslocamento dela
    int dragPage() const;
    int dragXOff() const;
    int page = 0;
    std::string lastClock;
    bool lastWifi = false;
    int lastUnread = -1;          // ponto de nao-lidas na barra (notificacoes)
    bool m_noWifiPref = false;     // /local/nowifi.txt (lido no onEnter, nao por frame)
    uint32_t m_pollAccumMs = 0;    // relogio/wifi checados a cada 250 ms
    int m_dragDx = 0;              // arrasto horizontal em curso (pagina acompanha o dedo)
    int m_dragPushed = 0;          // m_dragDx da ultima passada composta (buffer == vidro)
    int m_dragAccum = 0;           // modo direto: dx acumulado do arrasto (flip no release)
    bool m_needClear = true;       // Direct sem sprite: so limpa o fundo quando o desenho muda de fato (anti-flicker)
    int m_scroll = 0;              // modo lista (BoardProfile::launcherList): rolagem vertical em px
    void clampScroll();

    // Navegacao por gamepad (API 61, canal InputBus::pad): dpad/esquerdo
    // move o foco pela grade, A abre, B volta pagina. Bordas e repeticao
    // (segurar repete, como teclado) sao estado LOCAL desta tela — o canal
    // e broadcast e cada consumidor diff de copy propria.
    void padNav();
    int m_focus = -1;              // entrada em foco (indice global; -1 = nenhuma)
    uint32_t m_padSeq = 0;         // ultimo seq visto (0 = nenhum pad injetou)
    uint32_t m_prevPadButtons = 0; // diff de borda de A/B
    int8_t m_navDirX = 0;          // direcao corrente segurada (repeticao)
    int8_t m_navDirY = 0;
    uint32_t m_lastNavMs = 0;

    // Pressionar e segurar num app (sem arrastar) abre "Remover app?"
    int entryAt(int x, int y) const;
    void openAppActions(int entry);
    void uninstall(int entry);
    // Abre o app passando pelo consentimento (AppGrants): permissoes
    // declaradas e ainda nao concedidas viram um dialogo Permitir/Cancelar
    void launchEntry(int entry);
    uint32_t m_pressMs = 0;
    int m_pressEntry = -1;
    bool m_longFired = false;      // o release desse toque nao abre o app
    kui::Dialog m_dlg;
};

// ------------------------------------------------------------ Tela de app JS --
// Executa o app JS: por padrao sincrono (congela o SO ate o app sair via
// celerExit/OS_EXIT); com CELEROS_APP_TASK (F3) roda na task "celerapp" e a
// UI segue viva. Ao sair, volta ao launcher (ou a tela nativa empilhada).
class AppHostScreen : public kui::Screen {
public:
    static AppHostScreen* instance(int appIndex);
    explicit AppHostScreen(int appIndex);
    void onEnter() override;
    void draw(kui::Canvas& c) override;
    void onTick(uint32_t dtMs) override;
    bool suppressRedraw() const override;

private:
    void finishApp();

    int m_appIndex;
    bool m_started = false;
};

#endif  // CELEROS_SCREENS_H
