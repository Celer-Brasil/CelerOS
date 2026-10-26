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

// -------------------------------------------------------------- WiFi setup --
// Configurador de WiFi (W8). Fluxo primario LOCAL: scan assincrono, lista
// rolavel de redes (abre teclado de senha nas protegidas), entrada de rede
// oculta e conexao via WebManager. A opcao "Via web" (botao do rodape) sobe
// o AP + captive portal por conexao direta (WifiSetupPortal) sem sair da
// tela — o modo web e secundario, sempre explicito.
class WifiSetupScreen : public kui::Screen {
public:
    static WifiSetupScreen* instance();
    void onEnter() override;
    void onExit() override;
    void draw(kui::Canvas& c) override;
    bool onTouch(const kui::TouchEvent& ev) override;
    void onTick(uint32_t dtMs) override;
    // Conexao em andamento roda numa task: sair da tela no meio perderia o resultado
    bool allowsBackGesture() const override { return m_phase != Connecting; }

private:
    enum Phase { LocalList, Connecting, WebPortal };
    struct NetEntry {
        std::string ssid;
        int32_t rssi = 0;
        bool secure = false;
    };

    void startScan();      // dispara scan assincrono e aguarda no onTick
    void rebuildList();    // resultados do evento -> itens da lista
    void updateStatus();   // linha de estado sob o header
    void askPassword(const std::string& ssid);  // teclado de senha
    void askHiddenSsid();                       // teclado de SSID oculto
    // Conecta numa task propria (o connect bloqueia ate 15 s); a UI segue
    // viva com spinner e o resultado e colhido no onTick
    void tryConnect(const std::string& ssid, const std::string& password, bool secure);
    void finishConnect(bool ok);
    void enterWebPortal();
    void leaveWebPortal();

    Phase m_phase = LocalList;
    std::string m_connSsid;
    bool m_connSecure = false;
    uint32_t m_spinMs = 0;        // animacao do spinner (Connecting)
    bool m_scanStarted = false;   // ja disparou um scan nesta sessao
    bool m_scanning = false;      // aguardando o evento de scan
    uint32_t m_scanStartMs = 0;   // guarda de scan perdido (>20s)
    std::vector<NetEntry> m_nets;
    std::string m_status;

    kui::KeyboardScreen* m_kb = nullptr;        // teclado empilhado agora
    kui::KeyboardScreen* m_kbTrash = nullptr;   // fora da cadeia de chamadas; delete no onTick

    bool m_portalStarted = false;
    int m_portalState = 0;   // 0 esperando, 1 conectado, 2 falhou
    std::string m_portalDetail;
    uint32_t m_portalDoneAtMs = 0;

    kui::List m_list;
    kui::Button m_btnBack, m_btnScan, m_btnWeb;
};

#endif  // CELEROS_SCREENS_H
