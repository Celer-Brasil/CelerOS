#include "JSBindings.h"
#include <stdio.h>
#include <algorithm>
#include <new>
#include "../Kernel/Core/CelerKernel.h"
#include "../Kernel/Services.h"
#include "../Kernel/DeviceStats.h"
#include "../USBDevice/JsDebugger.h"
#include "../USBDevice/LogSink.h"
#include "../Display/Layout.h"
#include "../FileSystem/FileSystem.h"
#include "../UI/Keyboard.h"
#include "../WebManager/WebManager.h"
#include "../WebManager/WebAuth.h"
#include "../Kernel/TimeManager.h"
#include "../Utils/StrUtils.h"
#include "../Utils/PinStore.h"
#include "HttpClient.h"
#include "SystemInfo.h"
#include "esp_rom_md5.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "../Display/Backlight.h"
#include "../Display/ScreenCapture.h"
#include "../Display/ScreenPower.h"
#include "../Hardware/Buttons.h"
#include "../Hardware/BoardIO.h"
#include "../Display/Theme.h"
#include "../Display/Icon.h"
#include "../OTA/OtaManager.h"
#include "../Launcher/LauncherUI.h"
#include "../Launcher/Screens.h"
#include <lgfx/v1/misc/DataWrapper.hpp>
#include "JsInternal.h"
#if CONFIG_CELEROS_WAKE_WORD
#include "../Hardware/WakeWord.h"
#endif
#include "../Kernel/Alarms.h"
#include "../Launcher/WatchPanels.h"
#include "../Launcher/NotificationAlert.h"
#include "../Hardware/PowerPolicy.h"
#include "JsFsJail.h"
#include "../Utils/CelerSettings.h"
#include "../Boards/Board.h"
#include "driver/ledc.h"
#if CONFIG_CELEROS_BLUETOOTH
#include "../Bluetooth/CelerLink.h"
#include "../Pack/Resources.h"
#endif
#if CONFIG_CELEROS_PHONE_LINK
#include "../Bluetooth/PhoneLink.h"
#endif

void confirmPendingOta();  // main.cpp

// ---------------------------------------------------------------------------
// Camada de compatibilidade JS: canvas virtual 240x320 + cores RGB565.
//
// Os apps da loja sao escritos para o alvo classico (CYD): cores literais
// RGB565 (0xF800, 0x18E3...) e geometria 240x320. Em paineis maiores o
// runtime "mente" para o app: reporta 240x320, escala coordenadas/tamanhos
// para a tela fisica (UI::sx/sy) e converte cores RGB565 -> formato nativo.
// No alvo classico os fatores sao 1:1 e a camada e transparente.
// ---------------------------------------------------------------------------
CelerDisplay* s_jsTft = nullptr;  // setado no JSBindings::init
#if !CONFIG_CELEROS_UI
// definicao que vivia no JsGfx.cpp (fora do build sem vidro): a init real
// (ressuscitada pelo servico launcher headless) reseta o modo nativo
bool s_nativeCanvas = false;
#endif
uint32_t s_perms = celer::PERM_ALL;   // capabilities do app corrente (F4)
std::string s_appPkg;                 // packageName do app corrente (F4)
bool s_appExitPending = false;        // saida pedida (throwAppExit): relancada nas esperas
static bool s_svcActive = false;      // callback do svchost (nao chamar present)

// Ajustes globais (brilho/volume/auto/tempo de tela) mudados por app sem
// "system": valem so enquanto ele roda. Valores do lancamento + flag.
static int s_launchBright = 100, s_launchVol = 100;
static bool s_launchAuto = false;
static uint32_t s_launchIdle = 0;
bool s_hwTouched = false;  // JsSystemApps marca ao aplicar sem persistir

void JSBindings::appExitCleanup() {
    ScreenPower::keepAwake(false);   // latched (keepAwake(true)) de um app
    ScreenPower::keepAwakeFor(0);    // e o prazo (Clock: 30 min depois de sair)
    // app saiu no meio de uma gravacao: o mic seguia ate o ms (10 s) e o
    // buffer ficava alocado ate o init do proximo app — devolve AGORA
    BoardIO::micRecCancel();
    // Estado nativo do app volta ao heap na SAIDA (antes so no init do
    // proximo app): mundos verlet/rigidos, sprites e corpos pendentes de
    // net/AI seguravam dezenas de KB durante o intervalo no launcher — e
    // durante um OTA push/web comecado logo apos a saida. Mesmos resets
    // idempotentes do init; nada deles toca o heap Duktape (ainda vivo).
#if CONFIG_CELEROS_JS_PHYSICS
    jsPhysicsReset();
#endif
#if CONFIG_CELEROS_JS_GAME_ACCEL
    jsRigidReset();
#endif
#if CONFIG_CELEROS_BLUETOOTH
    // canais do app saem JA (REVOKE "gone" aos clientes) e os handles fecham:
    // antes so no init do proximo app, e no launcher os KEEPs dos clientes
    // mantinham vivo um canal cujo dono ja tinha saido (bancada 2026-10-11)
    Resources::appReset();
#endif
#if CONFIG_CELEROS_UI
    deleteAllSprites();
#endif
    netAsyncReset();
    aiReset();
#if CONFIG_CELEROS_USB_HOST
    usbAppReset();  // solta interfaces/listeners DELE (o registry do SO fica)
#endif
#if CONFIG_CELEROS_JS_CAMERA
    cameraAppReset();  // sensor, framebuffers retidos e quirc voltam ao heap
#endif
    if (s_hwTouched) {
        s_hwTouched = false;
        Backlight::setAuto(s_launchAuto, false);
        Backlight::set(s_launchBright, false);
        Backlight::setIdleTimeout(s_launchIdle, false);
        BoardIO::setVolumePct(s_launchVol, false);
    }
}


// Topbar do sistema (titulo + X de sair): s_exitArmed = dedo sobre o X no
// ultimo poll (tambem e o estado "hot" da faixa); s_barOnGlass/s_barHotOnGlass
// = estado da faixa que ja esta no vidro (present so recompoem quando muda).
//
// Dois modos (app.json "topbar"):
//   fixo    — faixa sempre visivel; o canvas do app e a area abaixo dela;
//   retratil — app em tela cheia; swipe de cima para baixo no terco direito
//              da borda revela a faixa por alguns segundos (RETRACT_MS). Todo
//              o gesto de revelar e consumido: o app nunca ve press/release
//              dele (os tercos esquerdo/central sao os paineis de borda).
static bool s_exitArmed = false;
static bool s_barOnGlass = false;
static bool s_barHotOnGlass = false;
static int s_armX = 0, s_armY = 0;   // onde o toque no X comecou
static const char* s_appTitle = "";
bool s_topbarFixed = true;    // setado por app pelo launcher (init)
static bool s_barShown = false;      // retratil: faixa visivel agora
static uint32_t s_barShownAt = 0;
static bool s_tbSwipe = false;       // gesto de revelar em andamento
static int s_tbSwipeY0 = 0;
// Faixa FANTASMA: o estado ja escondeu (RETRACT_MS) mas os pixels dela ainda
// estao no vidro — cena estatica nunca redesenha a faixa. Enquanto valer, o
// X visivel continua ativo (o toque cai no chrome comum); o app redesenhando
// a area da faixa encerra o fantasma (os pixels dele cobrem o X).
static bool s_barGhost = false;
static const uint32_t RETRACT_MS = 3000;  // "aparece por alguns segundos"

// Conteudo custom da faixa (System.topbarText/topbarButtons — API 6):
// texto no lugar do nome do app e chips tocaveis a direita, antes do X. Os
// toques nos chips viram fila para System.topbarPop() (devolve o label).
struct TbButton {
    std::string label;
    int x = 0, w = 0;   // rect virtual (240 de largura; altura = faixa inteira)
};
static std::vector<TbButton> s_tbButtons;      // [0] = o mais a direita
static std::vector<std::string> s_tbTaps;      // FIFO de toques pendentes
static std::string s_tbText;                   // vazio = usa o nome do app
static bool s_tbTextCustom = false;
static int s_tbHotBtn = -1;                    // chip sob o dedo (feedback)
static int s_tbBtnArmed = 0;                   // chip armado p/ disparo no release (indice+1)
static bool s_tbDirty = false;                 // faixa precisa recompor
static int s_tbHotOnGlass = -2;                // hot state ja composto (-2 = nada)

// Banner do SISTEMA na faixa (alarme com app aberto): ocupa a topbar por
// BANNER_MS mesmo no modo retratil. Vazio = sem banner.
static std::string s_bannerText;
static uint32_t s_bannerUntil = 0;
static const uint32_t BANNER_MS = 8000;
#if CONFIG_CELEROS_UI
static bool bannerActive() { return !s_bannerText.empty(); }

// expira a faixa retratil; true se ela acabou de sair. Um press armado no X
// SOBREVIVE ao expiry: o dedo pousou quando a faixa estava visivel — cortar
// o armamento no auto-hide engolia o tap na fronteira dos 3 s (o release
// chegava depois do hide e o X nao fazia nada).
static bool retractTick() {
    if (!s_topbarFixed && s_barShown && millis() - s_barShownAt > RETRACT_MS) {
        s_barShown = false;
        celer_log_println("[TB] auto-hide");
        return true;
    }
    return false;
}
#endif  // CONFIG_CELEROS_UI

// Escala vertical do canvas JS: no modo fixo a topbar fica FORA do canvas (o
// app desenha em 240x320 mapeado na area abaixo da faixa); no retratil o app
// e tela cheia (mapa identico ao pre-topbar).
// Escala vertical fracionaria (drawBMP/drawPNG escalam por float)
// jsy (alvo-dependent: quadro/display x sprite do app) vive depois das
// declaracoes de tftSprite/useSprite, logo abaixo.
// jsy e mapa de COORDENADA (soma o offset da faixa no modo fixo); jsH e a
// escala pura de TAMANHO vertical — altura/largura-vertical nunca podem
// receber o offset (uma linha de 3px viraria uma faixa de ~31px)

// Wrapper stdio para o drawPngFile do LGFX (a especializacao DataWrapperT<FILE>
// do upstream so ativa com macros do newlib que nao estao definidas no IDF)

CelerDisplay* JSBindings::tftInstance = nullptr;

// ---------------------------------------------------------------------------
// Quadro automatico (double buffer transparente para o app).
//
// Com PSRAM, TODO desenho do app vai para um sprite do tamanho da tela e so
// aparece no vidro quando o script "cede" (delay/getTouch/prompt ou antes de
// uma chamada bloqueante — rede, OTA, scan). Apps que fazem fillScreen +
// redesenho completo a cada evento deixam de piscar sem mudar uma linha.
// Sem PSRAM (CYD) o desenho segue direto no display, como antes.
// Prioridade do alvo: sprite do app (bindSprite) > quadro > display.
// O present() empurra so a caixa suja do quadro (FrameSprite): o Watchface
// trocando a barra de segundos manda alguns KB ao vidro, nao a tela inteira.
// ---------------------------------------------------------------------------
FrameSprite* s_frame = nullptr;
bool s_frameDirty = false;
static bool s_frameSuppressed = false;  // AOD/off: vidro mostrou outra coisa

// Topbar no estilo da barra que o Terminal desenhava: card, linha de stroke,
// titulo a esquerda e X a direita. hot (dedo sobre o X) clareia o traco e
// acende a pastilha — feedback antes de soltar.
#if CONFIG_CELEROS_UI
static void drawAppTopbarRaw(lgfx::LGFXBase& g, bool hot);

// Tira o ultimo CARACTERE (UTF-8): pop_back puro deixava o byte inicial de
// "a"/"c" com acento sozinho e a faixa desenhava um glifo lixo
static void popUtf8(std::string& s) {
    while (!s.empty() && ((uint8_t)s.back() & 0xC0) == 0x80) s.pop_back();  // continuacoes
    if (!s.empty()) s.pop_back();
}

// A faixa e desenhada no MESMO alvo do app (quadro/display): o estado de
// texto (cor, datum, tamanho) e o recorte do app nao podem vazar para ela
// (setTextSize(2) do app dobrava o titulo; setClip cortava a faixa) nem ela
// para o app (depois do present, setTextColor/datum do app viravam os da
// faixa). Salva, desenha limpo, restaura.
static void drawAppTopbar(lgfx::LGFXBase& g, bool hot) {
    GfxStateGuard guard(g);
    drawAppTopbarRaw(g, hot);
}

static void drawAppTopbarRaw(lgfx::LGFXBase& g, bool hot) {
    int h = UI::topbarH();
    if (bannerActive()) {
        // banner do sistema: faixa inteira em destaque, sem chips nem X
        // (some sozinho em BANNER_MS; o toque na faixa segue mascarado)
        g.fillRect(0, 0, UI::W, h, THEME_WARN);
        std::string label = s_bannerText;
        while (!label.empty() && g.textWidth(label.c_str(), kui::type::caption()) > UI::W - UI::sx(12)) {
            popUtf8(label);
        }
        g.setTextDatum(MC_DATUM);
        g.setTextColor(THEME_BG);
        g.drawString(label.c_str(), UI::W / 2, h / 2, kui::type::caption());
        return;
    }
    g.fillRect(0, 0, UI::W, h, THEME_CARD);
    g.drawFastHLine(0, h - 1, UI::W, THEME_STROKE);

    // X: glifo menor e colado a direita (a zona de TOQUE continua 40 px —
    // alvo generoso, glifo discreto)
    if (hot) {
        g.fillRoundRect(UI::W - UI::topbarExitW() - UI::inset + UI::sx(3), 1,
                        UI::topbarExitW() - 2 * UI::sx(3), h - 2, UI::sx(6), THEME_RAISED);
    }
    int gx = UI::W - UI::sx(13) - UI::inset;  // inset: canto arredondado do vidro
    int r = h / 3;       // meia-diagonal do X (menor: era h*2/5)
    int t = h / 9;       // meia-espessura do traco
    if (t < 1) t = 1;
    uint32_t col = hot ? THEME_TEXT : THEME_TEXT_DIM;
    // barras diagonais espessas: 2 triangulos por barra (offset perpendicular)
    auto bar = [&](int ax, int ay, int bx, int by, int px, int py) {
        g.fillTriangle(ax + px, ay + py, bx + px, by + py, bx - px, by - py, col);
        g.fillTriangle(ax + px, ay + py, bx - px, by - py, ax - px, ay - py, col);
    };
    bar(gx - r, h / 2 - r, gx + r, h / 2 + r, t, -t);  // "\"
    bar(gx - r, h / 2 + r, gx + r, h / 2 - r, t, t);   // "/"

    // chips custom (topbarButtons): da direita p/ a esquerda, antes do X
    for (int i = 0; i < (int)s_tbButtons.size(); i++) {
        const TbButton& b = s_tbButtons[i];
        int bx = UI::sx(b.x), bw = UI::sx(b.w);
        bool chipHot = (i == s_tbHotBtn);
        g.fillRoundRect(bx, 2, bw, h - 4, UI::sx(5), chipHot ? THEME_ACCENT_D : THEME_RAISED);
        g.drawRoundRect(bx, 2, bw, h - 4, UI::sx(5), THEME_STROKE);
        g.setTextDatum(MC_DATUM);
        g.setTextColor(chipHot ? THEME_TEXT : THEME_TEXT_DIM);
        g.drawString(b.label.c_str(), bx + bw / 2, h / 2, kui::type::caption());
    }

    // texto: custom (topbarText) ou nome do app; corta antes do 1o chip
    std::string label = s_tbTextCustom ? s_tbText : (s_appTitle ? s_appTitle : "");
    int rightLimit = UI::W - UI::topbarExitW() - UI::inset;
    if (!s_tbButtons.empty()) rightLimit = UI::sx(s_tbButtons.back().x);
    while (!label.empty() &&
           g.textWidth(label.c_str(), kui::type::caption()) > rightLimit - UI::sx(10)) {
        popUtf8(label);
    }
    g.setTextDatum(ML_DATUM);
    g.setTextColor(THEME_TEXT);
    g.drawString(label.c_str(), UI::sx(6) + UI::inset, h / 2, kui::type::caption());
}

// indice do chip sob o x virtual (ou -1)
static int tbButtonAt(int jx) {
    for (int i = 0; i < (int)s_tbButtons.size(); i++) {
        if (jx >= s_tbButtons[i].x && jx < s_tbButtons[i].x + s_tbButtons[i].w) return i;
    }
    return -1;
}

// Saida de app com "debounce": dispara so no RELEASE em que o toque comecou
// no X (armado) e o dedo nao se afastou mais que a tolerancia de tap — jitter
// do controlador nao desarma (bug do glifo: mudava de cor e nao saia), e
// arrasto para a area do app devolve o gesto a ele. Toque na faixa e
// mascarado: o app nunca ve coordenadas do chrome. Chips (topbarButtons)
// seguem o mesmo contrato e viram fila em System.topbarPop().
// Gestos de borda do relogio (API 15, BoardProfile::watchGestures): o dedo
// que nasce numa borda e cruza o limiar encerra o app pelo caminho do X —
// borda de cima em tercos: esquerda pede os Ajustes rapidos, centro a central
// de notificacoes, direito NAO abre painel (e o gesto que revela a topbar
// retratil, tratado no bloco retratil abaixo), baixo a central, esquerda so
// sai. Nao consome o toque (o X/topbar e os apps seguem vendo a borda); o
// app so perde o gesto que virou sistema.
static bool pollWatchEdges(bool touched, uint16_t x, uint16_t y) {
    static int s_edge = 0;  // borda do gesto em curso (0 = nenhum)
    static int s_x0 = 0, s_y0 = 0;
    static bool s_prev = false;
    const bool began = touched && !s_prev;
    s_prev = touched;
    if (began) {
        s_edge = WatchPanels::edgeAt(x, y);
        s_x0 = x;
        s_y0 = y;
    }
    if (s_edge == 0) return false;
    if (!touched) {
        s_edge = 0;
        return false;
    }
    const int dx = (int)x - s_x0, dy = (int)y - s_y0;
    WatchPanels::Panel p = WatchPanels::Panel::None;
    if (s_edge == 1 && dy >= UI::sy(60)) {
        const int third = WatchPanels::topThirdAt(s_x0);
        if (third == 0) {
            p = WatchPanels::Panel::Quick;
        } else if (third == 1) {
            p = WatchPanels::Panel::Notifications;
        } else {
            s_edge = 0;  // terco direito: fica com o app (revelar a topbar)
            return false;
        }
    } else if (s_edge == 2 && dy <= -UI::sy(60)) {
        p = WatchPanels::Panel::Notifications;
    } else if (!(s_edge == 3 && dx >= UI::sx(70) && abs(dy) < UI::sy(50))) {
        return false;
    }
    s_edge = 0;
    if (p != WatchPanels::Panel::None) {
        WatchPanels::request(p, s_appPkg == LauncherUI::homeTarget());
    }
    s_exitArmed = false;
    return true;
}

bool pollAppChrome(bool& touched, uint16_t& x, uint16_t& y) {
    const int slopX = UI::sx(18), slopY = UI::sy(18);

    if (Board::profile().watchGestures && pollWatchEdges(touched, x, y)) {
        touched = false;
        return true;  // sai do app; o launcher empilha o painel pedido
    }

    if (!s_topbarFixed) {
        // ---- modo retratil: gesto de revelar + faixa transitoria ----
        retractTick();
        if (s_tbSwipe) {  // dedo ainda no gesto de revelar (ate o release)
            if (!touched) {
                s_tbSwipe = false;             // soltou: gesto acabou
            } else if (!s_barShown && (int)y - s_tbSwipeY0 >= UI::sy(12)) {
                s_barShown = true;             // revela por RETRACT_MS
                s_barShownAt = millis();
                celer_log_println("[TB] show");
            }
            touched = false;                   // gesto inteiro e chrome
            return false;
        }
        // revelar so pelo terco direito: esquerda/centro sao os paineis de
        // borda (pollWatchEdges) e nao podem piscar a faixa no caminho.
        // Com faixa fantasma no vidro NAO comeca gesto: o toque e chrome
        // (o X visivel continua funcionando apos o auto-hide)
        if (touched && !s_barShown && !s_barGhost && UI::inTopbar(x, y) &&
            WatchPanels::topThirdAt(x) == 2) {
            s_tbSwipe = true;                  // pode virar o gesto de revelar
            s_tbSwipeY0 = y;
            touched = false;
            return false;
        }
        if (!s_barShown && !s_barGhost) return false;  // faixa oculta: tudo e do app
        // visivel (no estado ou fantasma no vidro): cai no chrome comum abaixo
        // (X/chips armaveis, faixa mascarada)
    }

    if (touched && UI::inTopbar(x, y)) {
        // dedo na faixa mantem a janela de revelacao aberta: ler o titulo e
        // mirar o X custa mais que RETRACT_MS (o auto-hide comia o tap)
        if (!s_topbarFixed && s_barShown) s_barShownAt = millis();
        int jx = s_jsTft ? ((int)x * 240 / s_jsTft->width()) : 0;
        int btn = tbButtonAt(jx);
        if (btn >= 0) {
            // chip: armamento proprio com disparo no release (mesmo contrato do X)
            if (s_tbBtnArmed != btn + 1) {
                s_tbBtnArmed = btn + 1;
                s_tbHotBtn = btn;
                s_armX = x;
                s_armY = y;
            } else if (abs((int)x - s_armX) > slopX || abs((int)y - s_armY) > slopY) {
                s_tbBtnArmed = 0;              // deslizou: nao e tap
                s_tbHotBtn = -1;
            }
            s_exitArmed = false;
        } else {
            if (s_tbBtnArmed) {                // saiu do chip para a faixa
                s_tbBtnArmed = 0;
                s_tbHotBtn = -1;
            }
            if (!s_exitArmed) {
                if (UI::hitTopbarExit(x, y)) {
                    s_exitArmed = true;
                    s_armX = x;
                    s_armY = y;
                }
            } else if (abs((int)x - s_armX) > slopX || abs((int)y - s_armY) > slopY) {
                s_exitArmed = false;  // deslizou dentro da faixa: nao e tap no X
            }
        }
        touched = false;
        return false;
    }
    if (touched) {
        if (s_tbBtnArmed) {                    // arrastou para a area do app
            s_tbBtnArmed = 0;
            s_tbHotBtn = -1;
        }
        if (s_exitArmed && (abs((int)x - s_armX) > slopX || abs((int)y - s_armY) > slopY)) {
            s_exitArmed = false;  // deslizou para a area do app: gesto do app
        }
        return false;
    }
    if (s_tbBtnArmed) {                        // release no chip: evento ao app
        int b = s_tbBtnArmed - 1;
        s_tbBtnArmed = 0;
        s_tbHotBtn = -1;
        // fila limitada: app que nunca chama topbarPop nao cresce sem fim
        if (b < (int)s_tbButtons.size() && s_tbTaps.size() < 16) s_tbTaps.push_back(s_tbButtons[b].label);
        return false;
    }
    bool fire = s_exitArmed;
    s_exitArmed = false;
    return fire;
}
#endif  // CONFIG_CELEROS_UI

CelerSprite* JSBindings::tftSprite = nullptr;
bool JSBindings::useSprite = false;
duk_context* JSBindings::s_jsCtx = nullptr;  // heap do app corrente (timers)

int JSBindings::mapY(int v) {
    // Nativo: y JA e fisico; topbar fixa nao existe (setNativeCanvas recusa)
    if (s_nativeCanvas) return v;
    return (useSprite && tftSprite) ? appSh(v)
                                    : (s_topbarFixed ? UI::topbarH() : 0) + appSh(v);
}


lgfx::LGFXBase* JSBindings::gfx() {
    if (useSprite && tftSprite) return tftSprite;
    if (s_frame != nullptr) return s_frame;  // o FrameSprite rastreia o que muda
    return tftInstance;
}

// Sem quadro (CYD): o app desenha DIRETO no display. Para a faixa nao ser
// coberta (e redesenhada a cada frame — piscava na taxa do loop do app), o
// display fica recortado abaixo dela enquanto visivel; o System.setClip do
// app e intersectado com esse recorte.
static int s_sysClipTop = 0;             // topo do recorte do sistema (0 = nenhum)
static bool s_appClipOn = false;         // app pediu recorte (coords fisicas)
static int s_appClip[4] = {0, 0, 0, 0};

void JSBindings::setAppDisplayClip(bool on, int x, int y, int w, int h) {
    s_appClipOn = on;
    s_appClip[0] = x;
    s_appClip[1] = y;
    s_appClip[2] = w;
    s_appClip[3] = h;
    applyDisplayClip();
}

void JSBindings::applyDisplayClip() {
    if (tftInstance == nullptr) return;
    int x = 0, y = 0, w = tftInstance->width(), h = tftInstance->height();
    if (s_appClipOn) {
        x = s_appClip[0];
        y = s_appClip[1];
        w = s_appClip[2];
        h = s_appClip[3];
    }
    if (y < s_sysClipTop) {
        h -= s_sysClipTop - y;
        y = s_sysClipTop;
    }
    if (!s_appClipOn && s_sysClipTop == 0) {
        tftInstance->clearClipRect();
    } else {
        tftInstance->setClipRect(x, y, w, h < 0 ? 0 : h);
    }
}

/// Algum recorte de sistema/app ativo no display (o fast path do
/// drawPixel nao pode pular o LGFX com clipe ligado).
bool JSBindings::clipActive() {
    return s_appClipOn || s_sysClipTop > 0;
}

void JSBindings::present() {
    // Profiling (celerctl top): duracao do present e quais chamadas levaram
    // quadro ao vidro (fps real). RAII cobre os returns antecipados (sem
    // display, AOD suprimindo) sem espalhar nota por cada saida.
    bool pushedFrame = false;
    const int64_t presStart = esp_timer_get_time();
    struct PresentNote {
        const int64_t t0;
        const bool& pushed;
        ~PresentNote() { DeviceStats::notePresent((uint32_t)(esp_timer_get_time() - t0), pushed); }
    } presentNote{presStart, pushedFrame};

    // App vivo e cedendo: alimenta o TWDT AQUI, no ponto de cedida
    // universal. Antes so o delay() alimentava (em fatias): um loop de jogo
    // `while(true){System.getTouch()}` legitimo derrubava o aparelho inteiro
    // aos 15s. O reset e barato e todo chamador passa por aqui. Loop JS
    // puro sem NENHUMA chamada continua no WDT — conter esse exige o
    // interrupt do executor do Duktape (proximo degrau, ver ENGINE_NOTES).
    esp_task_wdt_reset();
    // Cedida universal: alem do WDT, reinicia a janela do interrupt do
    // executor (loop JS puro sem passar AQUI virava reboot do aparelho)
    CelerKernel::noteAppYield();
    // Timers (API 12) disparam aqui: present() roda no inicio de delay/
    // getTouch/keypadPoll e das chamadas bloqueantes — os pontos onde o app
    // cede. Callback que desenha marca o quadro sujo e o push abaixo o leva
    // ao vidro. Erro no callback PROPAGA (present e 1a linha dos bindings
    // chamadores — o longjmp nao atravessa recurso C aberto).
    if (s_jsCtx != nullptr) {
        timersTick(s_jsCtx);
        aiTick(s_jsCtx);  // AI (API 18): entrega a resposta ao callback do app
        // Debugger (debug on): segunda chance do attach — o cliente pode ter
        // conectado depois do lancamento; attacha com a versao dele ja no buffer
        JsDebugger::maybeAttach(s_jsCtx);
    }
#if CONFIG_CELEROS_UI
    if (tftInstance == nullptr) return;
    // Servicos do OS (Backlight, Buttons, ScreenPower, PowerPolicy,
    // PhoneLink, alerta de notificacao, confirmacao de OTA, alarmes 1x/s):
    // a MESMA lista ordenada que o celerLoop percorre — ver Kernel/Services.
    CelerServices::tickPresent();
    if (ScreenPower::suppressAppFrame()) {  // AOD/off: quadro do app nao vai ao vidro
        s_frameSuppressed = true;
        return;
    }
    if (s_frameSuppressed) {
        // o vidro mostrou o AOD (ou dormiu): a caixa suja nao cobre isso
        s_frameSuppressed = false;
        s_frameDirty = true;
    }
    ScreenCapture::service();  // captura pedida por outra task (navegador/celerctl)
    retractTick();
    // Banner da faixa (notificacoes) expira sozinho
    {
        const uint32_t now = millis();
        if (bannerActive() && (int32_t)(now - s_bannerUntil) >= 0) {
            s_bannerText.clear();
            s_tbDirty = true;
            s_frameDirty = true;  // retratil: a area da faixa volta ao app
        }
    }
    bool wantBar = s_topbarFixed || s_barShown || bannerActive();
    if (s_frame != nullptr) {
        // A topbar vai DENTRO do quadro, antes do push: chega ao vidro atomica
        // com o conteudo do app (nao pisca) e o app nao consegue cobri-la. No
        // retratil, parar de compo-la restaura a area no proximo push. So
        // recompoe quando a faixa muda (texto/chips, hot, entrou/saiu) ou o
        // app desenhou nela.
        const bool barChanged = s_tbDirty || wantBar != s_barOnGlass ||
                                (wantBar && (s_exitArmed != s_barHotOnGlass || s_tbHotBtn != s_tbHotOnGlass));
        // a faixa saiu do estado (auto-hide) e estava composta: se o app nao
        // redesenhar a faixa dela, os pixels continuam no vidro = fantasma
        if (!wantBar && s_barOnGlass) s_barGhost = true;
        if (s_frameDirty) s_frame->markAllDirty();
        if (wantBar && (barChanged || s_frame->dirtyAbove(UI::topbarH()))) {
            drawAppTopbar(*s_frame, s_exitArmed);  // entra nas caixas sujas
            s_barGhost = false;                    // faixa composta: nao e fantasma
        }
        celer::DirtyRect rs[FrameSprite::kMaxDirty];
        const int nr = s_frame->takeDirty(rs);
        if (!wantBar && s_barGhost) {
            // o app repintou a area da faixa: os pixels dele cobrem o X e o
            // fantasma encerra (tap no topo volta a ser do app/gesto)
            for (int i = 0; i < nr && s_barGhost; i++) {
                if (rs[i].t < UI::topbarH()) s_barGhost = false;
            }
        }
        if (nr > 0) {
            // Recorte no destino, caixa a caixa: o pushImage do LovyanGFX so
            // transfere a area recortada (no watch, o framebuffer do painel
            // so faz flush dela, ja alinhada). Varias caixas pequenas no
            // lugar da uniao: 2 sprites em cantos opostos nao sujam mais o
            // vidro inteiro (banda da PSRAM do painel RGB = sem tremor).
            // NAO copiar direto sprite->framebuffer por memcpy aqui: uma
            // copia de quadro inteiro satura a PSRAM, o LCD_CAM perde
            // prazo e o painel "embaralha" linhas ate o vsync seguinte
            // (bancada 2026-10-09); o pushSprite por pixel e mais LENTO
            // justamente por nao afogar o barramento.
            pushedFrame = true;  // profiling: quadro que chegou ao vidro
            int32_t cx, cy, cw, ch;
            tftInstance->getClipRect(&cx, &cy, &cw, &ch);
            for (int i = 0; i < nr; i++) {
                tftInstance->setClipRect(rs[i].l, rs[i].t, rs[i].r - rs[i].l + 1, rs[i].b - rs[i].t + 1);
                s_frame->pushSprite(tftInstance, 0, 0);
            }
            tftInstance->setClipRect(cx, cy, cw, ch);
        }
        s_frameDirty = false;
        s_tbDirty = false;
        s_barOnGlass = wantBar;
        s_barHotOnGlass = wantBar && s_exitArmed;
        s_tbHotOnGlass = s_tbHotBtn;
    } else {
        // Sem quadro (CYD): o app desenha direto no display. A faixa so vai
        // ao vidro quando MUDA (entrou, hot, texto/chips) — o recorte abaixo
        // dela impede o app de cobri-la. Ao esconder a retratil, o recorte
        // sai e a faixa permanece ate o app repintar a regiao.
        const bool needDraw = wantBar && (!s_barOnGlass || s_tbDirty || s_exitArmed != s_barHotOnGlass ||
                                          s_tbHotBtn != s_tbHotOnGlass);
        const int top = wantBar ? UI::topbarH() : 0;
        if (needDraw) {
            tftInstance->clearClipRect();
            drawAppTopbar(*tftInstance, s_exitArmed);
        }
        if (needDraw || top != s_sysClipTop) {
            s_sysClipTop = top;
            applyDisplayClip();
        }
        s_tbDirty = false;
        s_barOnGlass = wantBar;
        s_barHotOnGlass = wantBar && s_exitArmed;
        s_tbHotOnGlass = s_tbHotBtn;
    }
#else
    // Sem vidro (CELEROS_UI=n): o present segue sendo o ponto de cedida
    // universal — WDT, janela do exec-timeout, timers/AI/debugger acima e
    // os servicos ALWAYS do OS aqui (buttons, screenpower, web upload/OTA
    // push, logpersist, debug bridge). Nao ha quadro para levar ao vidro.
    CelerServices::tickPresent();
#endif
}

// =====================================================
// Topbar custom (API level 6) — texto e chips da faixa
// =====================================================
#if CONFIG_CELEROS_UI

duk_ret_t JSBindings::js_topbarText(duk_context *ctx) {
    const char *t = duk_require_string(ctx, 0);
    s_tbText = t ? t : "";
    s_tbTextCustom = (s_tbText[0] != '\0');   // "" volta ao nome do app
    s_tbDirty = true;
    return 0;
}

duk_ret_t JSBindings::js_topbarButtons(duk_context *ctx) {
    if (!tftInstance) return 0;
    s_tbButtons.clear();
    s_tbHotBtn = -1;
    s_tbBtnArmed = 0;
    s_tbDirty = true;
    if (!duk_is_array(ctx, 0)) {
        duk_push_int(ctx, 0);
        return 1;
    }
    int n = (int)duk_get_length(ctx, 0);
    if (n > 3) n = 3;                          // espaco nao comporta mais que isso
    int cursor = 240 - 40 - 4;                 // borda direita disponivel (antes do X)
    for (int i = 0; i < n; i++) {
        if (!duk_get_prop_index(ctx, 0, (duk_uarridx_t)i) || !duk_is_string(ctx, -1)) {
            duk_pop(ctx);
            continue;
        }
        const char *lb = duk_get_string(ctx, -1);
        duk_pop(ctx);
        if (!lb || !lb[0]) continue;
        int pw = tftInstance->textWidth(lb, kui::type::caption());
        int vw = (int)((long)pw * 240 / tftInstance->width()) + 12;   // padding virtual
        if (vw < 28) vw = 28;
        if (cursor - vw < 60) break;           // sem espaco: reserva o titulo
        TbButton b;
        b.label = lb;
        b.w = vw;
        b.x = cursor - vw;
        cursor = b.x - 6;
        s_tbButtons.push_back(b);
    }
    duk_push_int(ctx, (int)s_tbButtons.size());   // quantos couberam
    return 1;
}

duk_ret_t JSBindings::js_topbarPop(duk_context *ctx) {
    if (s_tbTaps.empty()) {
        duk_push_null(ctx);
        return 1;
    }
    duk_push_string(ctx, s_tbTaps.front().c_str());
    s_tbTaps.erase(s_tbTaps.begin());
    return 1;
}

duk_ret_t JSBindings::js_textWidth(duk_context *ctx) {
    if (!tftInstance) { duk_push_int(ctx, 0); return 1; }
    const char* str = duk_require_string(ctx, 0);
    int font = duk_get_int_default(ctx, 1, 2);
    // mede no ALVO do desenho (sprite > quadro > display), onde o
    // setTextSize do app vale — o display cru ignorava o tamanho no S3
    int w = gfx()->textWidth(str, jsFont(font));
    // devolve no espaco do app: virtual 240x320 (inverso do jsx()) ou, no
    // canvas nativo (API 28), pixels fisicos — ate a API 31 dividia sempre e
    // no 480 nativo a largura vinha pela METADE (texto centrado na mao e a
    // caixa suja da engine erravam meia largura)
    duk_push_int(ctx, s_nativeCanvas ? w : (int)((long)w * 240 / tftInstance->width()));
    return 1;
}

duk_ret_t JSBindings::js_fontHeight(duk_context *ctx) {
    // Altura da fonte no canvas virtual (para centralizar texto de verdade:
    // as fontes proporcionais nao tem a altura fixa das numericas antigas)
    if (!tftInstance) { duk_push_int(ctx, 0); return 1; }
    int font = duk_get_int_default(ctx, 0, 2);
    int h = gfx()->fontHeight(jsFont(font));
    duk_push_int(ctx, (int)(h / appScaleY()));
    return 1;
}
#endif  // CONFIG_CELEROS_UI

duk_ret_t JSBindings::js_theme(duk_context *ctx) {
    // Cores do tema do OS ja em RGB565 (espaco de cor do JS) — os apps de
    // sistema herdam a identidade visual do Kui em qualquer placa.
    auto put = [&](const char* k, uint32_t rgb888) {
        uint32_t r = (rgb888 >> 16) & 0xFF, g = (rgb888 >> 8) & 0xFF, b = rgb888 & 0xFF;
        duk_push_uint(ctx, (duk_uint_t)(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)));
        duk_put_prop_string(ctx, -2, k);
    };
    duk_push_object(ctx);
    put("bg", THEME_BG);
    put("card", THEME_CARD);
    put("raised", THEME_RAISED);
    put("stroke", THEME_STROKE);
    put("accent", THEME_ACCENT);
    put("accentD", THEME_ACCENT_D);
    put("onAccent", THEME_ON_ACCENT);
    put("text", THEME_TEXT);
    put("textDim", THEME_TEXT_DIM);
    put("ok", THEME_OK);
    put("warn", THEME_WARN);
    put("err", THEME_ERR);
    return 1;
}

#if CONFIG_CELEROS_UI
duk_ret_t JSBindings::js_drawIcon(duk_context *ctx) {
    if (!tftInstance) return 0;
    const char* name = duk_require_string(ctx, 0);
    int x = duk_require_int(ctx, 1);
    int y = duk_require_int(ctx, 2);
    // caminho de arquivo: canonico em /local ou /sd (como drawPNG/drawBMP);
    // antes "/local/../x" ou qualquer ponto do VFS ia direto ao decoder
    if (name[0] == '/' && !imagePathOk(name)) return 0;
    Icon::draw(gfx(), name, jsx(x), jsy(y));
    return 0;
}

duk_ret_t JSBindings::js_drawJPG(duk_context *ctx) {
    // JPEG baseline pelo TJpgDec do LovyanGFX (decode em blocos 8x8, sem o
    // quadro inteiro na RAM) — a foto do Pack.snap/Camera.save na tela
    if (!tftInstance) return 0;
    const char *path = duk_require_string(ctx, 0);
    int x = duk_require_int(ctx, 1);
    int y = duk_require_int(ctx, 2);
    if (!imagePathOk(path)) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
    CelerFileWrapper file;
    duk_push_boolean(ctx, gfx()->drawJpgFile(&file, path, jsx(x), jsy(y), 0, 0, 0, 0,
                                            s_nativeCanvas ? 1.0f : (float)UI::W / 240.0f,
                                            appScaleY()));
    return 1;
}

duk_ret_t JSBindings::js_drawPNG(duk_context *ctx) {
    // Desenho streaming (linha a linha via pngle do LovyanGFX): nao aloca
    // framebuffer da imagem inteira, so a janela do deflate (~44 KB durante
    // o decode). Alpha do PNG e composto sobre o fundo pelo proprio LGFX.
    if (!tftInstance) return 0;
    const char *path = duk_require_string(ctx, 0);
    int x = duk_require_int(ctx, 1);
    int y = duk_require_int(ctx, 2);
    if (!imagePathOk(path)) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
    CelerFileWrapper file;
    duk_push_boolean(ctx, gfx()->drawPngFile(&file, path, jsx(x), jsy(y), 0, 0, 0, 0,
                                            s_nativeCanvas ? 1.0f : (float)UI::W / 240.0f,
                                            appScaleY()));
    return 1;
}
#endif  // CONFIG_CELEROS_UI
duk_ret_t JSBindings::js_copyFile(duk_context *ctx) {
    present();  // chamada bloqueante: o que o app desenhou aparece antes
    const char* from = duk_require_string(ctx, 0);
    const char* to = duk_require_string(ctx, 1);
    // origem E destino: copiar POR CIMA de um arquivo do sistema (ota_url,
    // PIN...) era tao perigoso quanto ler um
    if (!fsPathAllowed(from)) {
        char msg[160];  // pre-formatado: duk_error com %s em lightfunc corrompe o heap
        snprintf(msg, sizeof(msg), "FS: %s e arquivo do sistema", from);
        jsThrowMsg(ctx, DUK_ERR_ERROR, msg);
    }
    if (!fsWriteAllowed(to)) {
        char msg[160];
        snprintf(msg, sizeof(msg), "FS: escrita negada em %s", to);
        jsThrowMsg(ctx, DUK_ERR_ERROR, msg);
    }
    duk_push_boolean(ctx, FileSystem::copyFile(from, to) ? 1 : 0);
    CelerKernel::noteAppYield();  // arquivo grande passa de 1s
    return 1;
}

duk_ret_t JSBindings::js_copyDirectory(duk_context *ctx) {
    present();  // chamada bloqueante: o que o app desenhou aparece antes
    const char* from = duk_require_string(ctx, 0);
    const char* to = duk_require_string(ctx, 1);
    if (!fsTreeAllowed(from)) {
        char msg[160];  // pre-formatado: duk_error com %s em lightfunc corrompe o heap
        snprintf(msg, sizeof(msg), "FS: copiar %s requer permissao \"system\"", from);
        jsThrowMsg(ctx, DUK_ERR_ERROR, msg);
    }
    // destino na raiz /local sobrescreveria os arquivos protegidos (que
    // moram la): mesma regra de arvore da origem
    if (!fsTreeWriteAllowed(to)) {
        char msg[160];
        snprintf(msg, sizeof(msg), "FS: copiar para %s requer permissao \"system\"", to);
        jsThrowMsg(ctx, DUK_ERR_ERROR, msg);
    }
    bool ok = FileSystem::copyDirectory(from, to);
    CelerKernel::noteAppYield();  // arvore grande (instalacao via SD): segundos
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}

// Remocao recursiva (app = pasta com app.json/main.js/icon.bin...). rmdir so
// aceita pasta vazia; sem isso o Settings nao conseguiria desinstalar apps.
// Re-lista em passos de 50: pastas com mais filhos saiam truncadas (o
// buffer fixo fazia a remocao parar no 50o sem erro).
static bool removeTree(const std::string& dir) {
    for (;;) {
        FileEntry entries[50];
        int n = FileSystem::listDirectory(dir.c_str(), entries, 50);
        if (n < 0) n = 0;
        if (n == 0) break;
        int removed = 0;
        for (int i = 0; i < n; i++) {
            if (!fsWriteAllowed(entries[i].path.c_str())) continue;  // jail: nao e dono
            if (entries[i].isDir) {
                if (!removeTree(entries[i].path)) return false;
            } else if (!FileSystem::deleteFile(entries[i].path.c_str())) {
                return false;
            }
            removed++;
        }
        // re-lista so se este lote removeu algo: entradas negadas pelo jail
        // voltam iguais e, com 50+, o for(;;) nunca terminava (WDT)
        if (n < 50 || removed == 0) break;
    }
    return FileSystem::rmdir(dir.c_str());
}

duk_ret_t JSBindings::js_removeDirectory(duk_context *ctx) {
    present();  // chamada bloqueante: o que o app desenhou aparece antes
    const char* path = duk_require_string(ctx, 0);
    if (!fsTreeWriteAllowed(path)) {
        char msg[160];  // pre-formatado: duk_error com %s em lightfunc corrompe o heap
        snprintf(msg, sizeof(msg), "FS: remover %s requer permissao \"system\"", path);
        jsThrowMsg(ctx, DUK_ERR_ERROR, msg);
    }
    bool ok = removeTree(path);
    CelerKernel::noteAppYield();  // desinstalacao de arvore: pode passar de 1s
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}

// =====================================================
// Init - Register ALL bindings
// =====================================================

// Registro por tabela: {nome JS, funcao C, nargs} -> propriedade do objeto
// no topo da pilha. Menos codigo que um push+put por binding. A struct JsFn
// e o putFns de 3 args sao publicos no header (JsSvc.cpp monta a superficie
// dos servicos com as mesmas tabelas).
void JSBindings::putFns(duk_context* ctx, const JsFn* fns, int n) {
    for (int i = 0; i < n; i++) {
        duk_push_c_lightfunc(ctx, fns[i].fn, fns[i].nargs, fns[i].nargs, 0);
        duk_put_prop_string(ctx, -2, fns[i].name);
    }
}

// Lightfunc: o binding vira um valor tagged (ponteiro C + nargs) em vez de um
// objeto funcao no heap — ~130 bindings deixam de custar ~10KB de RAM por
// app (decisivo na CYD sem PSRAM). Unica diferenca visivel: sem .name.
// (a forma de tabela estatica e o template-membro no header)

// ---- Identidade do svchost (API 42): pkg/perms/ctx/pasta do servico ----
static std::string s_savedPkg;
static uint32_t s_savedPerms = 0;
static std::string s_savedDir;
static duk_context* s_savedCtx = nullptr;

void JSBindings::svcIdentity(duk_context* thr, const char* appPkg, uint32_t perms,
                             const char* appDir) {
    extern void jsModulesSetAppDir(const char* d);        // JsModules.cpp
    extern const std::string& jsModulesGetAppDir();       // idem
    s_savedPkg = s_appPkg;
    s_savedPerms = s_perms;
    s_savedCtx = s_jsCtx;
    s_savedDir = jsModulesGetAppDir();
    s_appPkg = appPkg ? appPkg : "";
    s_perms = perms;
    s_jsCtx = thr;
    s_svcActive = true;
    jsModulesSetAppDir(appDir);
}

void JSBindings::svcIdentityRestore() {
    extern void jsModulesSetAppDir(const char* d);        // JsModules.cpp
    s_appPkg = s_savedPkg;
    s_perms = s_savedPerms;
    s_jsCtx = s_savedCtx;
    s_svcActive = false;
    jsModulesSetAppDir(s_savedDir.c_str());
}

bool JSBindings::inService() { return s_svcActive; }

void JSBindings::init(duk_context *ctx, CelerDisplay *tft, const char* appTitle,
                      bool topbarFixed, const char* appPkg, uint32_t perms) {
    s_jsTft = tft;
    tftInstance = tft;
    s_jsCtx = ctx;
    s_appTitle = appTitle ? appTitle : "";
    s_topbarFixed = topbarFixed;
    s_appPkg = appPkg ? appPkg : "";
    s_perms = perms;
    s_appExitPending = false;
    s_hwTouched = false;
    s_nativeCanvas = false;  // app anterior pode ter saido no modo nativo
    s_launchBright = Backlight::get();
    s_launchAuto = Backlight::isAuto();
    s_launchIdle = Backlight::idleTimeout();
    s_launchVol = BoardIO::volumePct();
    celer_log_printf("[TB] init app='%s' fixed=%d\n", s_appTitle ? s_appTitle : "", topbarFixed);

    // Estado grafico limpo por app: sprites de um app anterior (que saiu
    // sem deleteSprite) vazavam e ainda capturavam o desenho do proximo.
#if CONFIG_CELEROS_UI
    deleteAllSprites();
#endif
    timersResetAll();
#if CONFIG_CELEROS_JS_PHYSICS
    jsPhysicsReset();  // mundos verlet nativos (malloc incluso)
#endif
#if CONFIG_CELEROS_JS_GAME_ACCEL
    jsRigidReset();    // mundos rigidos nativos (API 33)
#endif

    // Sessao de teclado acoplado de um app anterior (saiu sem keypadClose)
#if CONFIG_CELEROS_UI
    keypadCloseSession();
#endif

    // Evento de botao fisico pendente de um app anterior nao atravessa
    // (placas buttonToApp: o longo que encerrou o app anterior ficaria aqui)
    Buttons::buttonEvents();

    // Sessao Celer Link de um app anterior (saiu sem stop/disconnect)
#if CONFIG_CELEROS_BLUETOOTH
    CelerLink::appReset();
    // canais e handles de recursos do app anterior (API 36)
    Resources::appReset();
#endif

    // Requisicoes async de um app anterior: zumbis descartam o resultado e
    // resultados nao consumidos sao liberados (o slot nunca atravessa apps)
    netAsyncReset();

    // Requisicao AI de um app anterior: descartada (o callback morreu no
    // heap stash do app que saiu)
    aiReset();

#if CONFIG_CELEROS_JS_CAMERA
    // Camera de um app anterior: desligada (sensor, slots retidos e quirc)
    cameraAppReset();
#endif

    // Gravacao de microfone de um app anterior: descartada (nenhum audio
    // atravessa apps; a task morre e o buffer e liberado)
    BoardIO::micRecCancel();
#if CONFIG_CELEROS_WAKE_WORD
    // Detector de wake word de um app anterior: idem (o proximo app liga
    // de novo se quiser — o custo de religar e o create do modelo)
    WakeWord::stop();
#endif

    // Toolkit UI (API 22): slots/toque/fundo do app anterior nao atravessam
#if CONFIG_CELEROS_UI
    uiReset();
#endif

    // Topbar limpa: sem faixa/hot/gesto/conteudo custom herdados do app anterior
    s_exitArmed = false;
    s_barOnGlass = false;
    s_barHotOnGlass = false;
    s_barShown = false;
    s_tbSwipe = false;
    s_barGhost = false;
    s_tbButtons.clear();
    s_tbTaps.clear();
    s_tbText.clear();
    s_tbTextCustom = false;
    s_tbHotBtn = -1;
    s_tbBtnArmed = 0;
    s_tbDirty = false;
    s_tbHotOnGlass = -2;
    s_bannerText.clear();

    // Quadro automatico: alocado uma vez (PSRAM) e reaproveitado entre apps
#if CONFIG_CELEROS_UI
    if (s_frame == nullptr && Board::profile().hasPsram) {
        // nothrow: sem excecoes um new que falha aborta o OS inteiro
        s_frame = new (std::nothrow) FrameSprite(tft);
        if (s_frame != nullptr) {
            s_frame->setSwapBytes(true);  // mesma convencao do display (icones, readRect)
            if (s_frame->createFrame(tft->width(), tft->height()) == nullptr) {
                delete s_frame;
                s_frame = nullptr;
            }
        }
    }
    if (s_frame != nullptr) {
        s_frame->fillScreen(TFT_BLACK);  // mesmo fundo que o launcher pinta antes do app
        s_frame->setTextColor(TFT_WHITE);
        s_frame->setTextSize(1);
        s_frame->setTextDatum(TL_DATUM);
        s_frame->clearClipRect();
    }
#endif
    tft->clearClipRect();
    s_sysClipTop = 0;
    s_appClipOn = false;
    s_frameDirty = false;
    tft->setTextSize(1);
    tft->setTextDatum(TL_DATUM);  // datum de app anterior nao atravessa

    // --- System Object ---
    duk_push_global_object(ctx);
    duk_push_object(ctx); // System

#if CONFIG_CELEROS_JS_GPIO
    // System.gpio: funcoes E constantes so com a capability "gpio" (F4).
    // Antes o if so decidia o sub-objeto: sem a permissao as funcoes caiam
    // soltas no objeto System (System.pinMode/digitalWrite chamaveis).
    if (perm(celer::PERM_GPIO)) {
        duk_push_object(ctx);
        static const JsFn kFns1[] = {
            {"pinMode", js_pinMode, 2},
            {"digitalWrite", js_digitalWrite, 2},
            {"digitalRead", js_digitalRead, 1},
            {"analogRead", js_analogRead, 1},
            {"analogWrite", js_analogWrite, 2},
            {"pulseIn", js_pulseIn, 3},
            {"servo", js_servo, 2},
            {"servoOff", js_servoOff, 1},
        };
        putFns(ctx, kFns1);

        // GPIO Constants
        duk_push_int(ctx, OUTPUT); duk_put_prop_string(ctx, -2, "OUTPUT");
        duk_push_int(ctx, INPUT); duk_put_prop_string(ctx, -2, "INPUT");
        duk_push_int(ctx, INPUT_PULLUP); duk_put_prop_string(ctx, -2, "INPUT_PULLUP");
        duk_push_int(ctx, HIGH); duk_put_prop_string(ctx, -2, "HIGH");
        duk_push_int(ctx, LOW); duk_put_prop_string(ctx, -2, "LOW");

        duk_put_prop_string(ctx, -2, "gpio");
    }
#endif

    // --- Drawing Primitives ---
#if CONFIG_CELEROS_UI
    static const JsFn kFns2[] = {
        {"createSprite", js_createSprite, 2},
        {"deleteSprite", js_deleteSprite, 1},
        {"pushSprite", js_pushSprite, 3},  // 3o = cor-chave (API 28)
        {"bindSprite", js_bindSprite, 1},
        {"useSprite", js_useSprite, 1},
        {"spriteSlots", js_spriteSlots, 0},  // limite do pool (API 29)
        {"drawFastVLine", js_drawFastVLine, 4},
        {"drawFastHLine", js_drawFastHLine, 4},
    };
    putFns(ctx, kFns2);
#endif

    // Verlet nativo (API 31): a dep celeros.physics feature-detecta e expoe
    // P.verletFast; em firmware velho o P.verlet JS segue valendo. Nao e
    // desenho: fica no build sem vidro (CELEROS_UI=n). Perfil lite
    // (CELEROS_JS_PHYSICS=n, placas sem PSRAM): o bloco nem compila —
    // typeof System.verletNew === "undefined" e a dep cai no P.verlet JS.
#if CONFIG_CELEROS_JS_PHYSICS
    static const JsFn kFnsVerlet[] = {
        {"verletNew", js_verletNew, 2},
        {"verletFree", js_verletFree, 1},
        {"verletAddPoint", js_verletAddPoint, 3},
        {"verletStick", js_verletStick, 4},
        {"verletPin", js_verletPin, 3},
        {"verletSet", js_verletSet, 4},
        {"verletStep", js_verletStep, 10},
        {"verletXY", js_verletXY, 1},
        {"verletSticks", js_verletSticks, 1},
        {"verletCount", js_verletCount, 1},
        {"verletDelStick", js_verletDelStick, 2},
        {"verletDelPoint", js_verletDelPoint, 2},
        {"verletPins", js_verletPins, 1},
    };
    putFns(ctx, kFnsVerlet);
#endif  // CONFIG_CELEROS_JS_PHYSICS

#if CONFIG_CELEROS_JS_GAME_ACCEL
    // Aceleradores de jogo (API 33, placas S3): corpo rigido nativo (a dep
    // celeros.physics expoe P.rigid), sprite girado/escalado e (API 34) o
    // blit recortado do fundo (blitSprite: painter da camada suja)
    static const JsFn kFnsAccel[] = {
        {"rigidNew", js_rigidNew, 1},
        {"rigidFree", js_rigidFree, 1},
        {"rigidBox", js_rigidBox, 9},
        {"rigidCircle", js_rigidCircle, 7},
        {"rigidRemove", js_rigidRemove, 2},
        {"rigidSet", js_rigidSet, 8},
        {"rigidImpulse", js_rigidImpulse, 4},
        {"rigidStep", js_rigidStep, 5},
        {"rigidState", js_rigidState, 2},
        {"rigidCount", js_rigidCount, 1},
        {"drawSprite", js_drawSprite, 8},
        {"blitSprite", js_blitSprite, 5},
        {"copySprite", js_copySprite, 8},  // API 45: regiao de sprite -> alvo corrente
    };
    putFns(ctx, kFnsAccel);
#endif

#if CONFIG_CELEROS_UI
    static const JsFn kFns3[] = {
        {"fillScreen", js_fillScreen, 1},
        {"fillRect", js_fillRect, 5},
        {"drawRect", js_drawRect, 5},
        {"drawLine", js_drawLine, 5},
        {"drawPixel", js_drawPixel, 3},
        {"drawCircle", js_drawCircle, 4},
        {"fillCircle", js_fillCircle, 4},
        {"drawTriangle", js_drawTriangle, 7},
        {"fillTriangle", js_fillTriangle, 7},
        {"drawRoundRect", js_drawRoundRect, 6},
        {"fillRoundRect", js_fillRoundRect, 6},
        // API 22: AA, gradiente, arco e mistura de cor
        {"fillGradient", js_fillGradient, 7},
        {"fillArc", js_fillArc, 7},
        {"fillSmoothCircle", js_fillSmoothCircle, 4},
        {"fillSmoothRoundRect", js_fillSmoothRoundRect, 6},
        {"drawWideLine", js_drawWideLine, 6},
        {"mixColor", js_mixColor, 3},
    };
    putFns(ctx, kFns3);

    static const JsFn kFns4[] = {
        {"drawBMP", js_drawBMP, 3},
        {"drawPNG", js_drawPNG, 3},
        {"drawJPG", js_drawJPG, 3},           // API 36: JPEG (Pack.snap / Camera.save)
    };
    putFns(ctx, kFns4);

    // --- Text ---
    static const JsFn kFns5[] = {
        {"drawString", js_drawString, 4},
        {"setTextColor", js_setTextColor, 2},
        {"setTextSize", js_setTextSize, 1},
        {"setTextDatum", js_setTextDatum, 1},
        {"textWidth", js_textWidth, 2},
        {"fontHeight", js_fontHeight, 1},
    };
    putFns(ctx, kFns5);

    // --- Utility ---
    static const JsFn kFns6[] = {
        {"color", js_color, 3},
        {"screenWidth", js_screenWidth, 0},
        {"screenHeight", js_screenHeight, 0},
    };
    putFns(ctx, kFns6);
#endif  // CONFIG_CELEROS_UI

    // --- Touch Input ---
    static const JsFn kFns7[] = {
        {"getTouch", js_getTouch, 0},
        {"getTouches", js_getTouches, 0},  // API 43: multi-dedo (array)
        {"button", js_button, 0},  // API 17: botao fisico como input (placas buttonToApp)
        {"millis", js_millis, 0},
        {"micros", js_micros, 0},
        {"delay", js_delay, 1},
        {"delayMicroseconds", js_delayMicroseconds, 1},
        {"print", js_print, 1},
        {"getTemperature", js_getTemperature, 0},
        {"hasTemperatureSensor", js_hasTemperatureSensor, 0},
        {"getInfo", js_getInfo, 0},
    };
    putFns(ctx, kFns7);
    
    static const JsFn kFns8[] = {
        {"getTime", js_getTime, 0},
        {"getSeconds", js_getSeconds, 0},
        {"epoch", js_epoch, 0},             // UTC absoluto (API 49)
        {"getDate", js_getDate, 0},
        {"getYear", js_getYear, 0},
        {"getMonth", js_getMonth, 0},
        {"getDay", js_getDay, 0},
        {"getTimezone", js_getTimezone, 0},
        {"getWeekday", js_getWeekday, 0},   // API 13 (watchface)
        {"keepAwake", js_keepAwake, 1},     // API 13 (jogos: tela acesa)
    };
    putFns(ctx, kFns8);

    static const JsFn kFns9[] = {
        {"getOSVersion", js_getOSVersion, 0},
    };
    putFns(ctx, kFns9);

    static const JsFn kFns10[] = {
        {"getAPILevel", js_getAPILevel, 0},
    };
    putFns(ctx, kFns10);

    static const JsFn kFns11[] = {
        {"getIPAddress", js_getIPAddress, 0},
    };
    putFns(ctx, kFns11);

    static const JsFn kFns12[] = {
        {"isWiFiActive", js_isWiFiActive, 0},
    };
    putFns(ctx, kFns12);

    // --- Keyboard ---
#if CONFIG_CELEROS_UI
    static const JsFn kFns13[] = {
        {"prompt", js_prompt, 3},  // (msg, initial, {mask}) — opts e API level 7
    };
    putFns(ctx, kFns13);

    // --- Keyboard acoplado (API level 5): sessao nao-bloqueante p/ apps ---
    static const JsFn kFns14[] = {
        {"keypadOpen", js_keypadOpen, 1},
        {"keypadPoll", js_keypadPoll, 0},
        {"keypadText", js_keypadText, 0},
        {"keypadRect", js_keypadRect, 0},
        {"keypadDraw", js_keypadDraw, 0},
        {"keypadClose", js_keypadClose, 0},
    };
    putFns(ctx, kFns14);

    // --- Topbar custom (API level 6): texto e chips da faixa ---
    static const JsFn kFns15[] = {
        {"topbarText", js_topbarText, 1},
        {"topbarButtons", js_topbarButtons, 1},
        {"topbarPop", js_topbarPop, 0},
    };
    putFns(ctx, kFns15);
#endif  // CONFIG_CELEROS_UI

    // --- System nivel 3 (apps de sistema em JS) ---
    static const JsFn kFns16[] = {
        {"setBrightness", js_setBrightness, 1},
        {"getBrightness", js_getBrightness, 0},
        {"setVolume", js_setVolume, 1},   // API 13: audio do OS
        {"getVolume", js_getVolume, 0},
        {"backlightSupported", js_backlightSupported, 0},
        {"setAutoBrightness", js_setAutoBrightness, 1},
        {"getAutoBrightness", js_getAutoBrightness, 0},
        {"exitApp", js_exitApp, 0},
        {"launchApp", js_launchApp, 1},  // API 16: abre outro app e sai
        {"present", js_present, 0},
        {"isBuffered", js_isBuffered, 0},
        {"wifiStatus", js_wifiStatus, 0},
        {"md5", js_md5, 1},
        {"pinState", js_pinState, 0},
        {"rescanApps", js_rescanApps, 0},
        {"setting", js_setting, 2},
        {"toast", js_toast, 1},
        {"beep", js_beep, 2},
        {"battery", js_battery, 0},
        {"batteryInfo", js_batteryInfo, 0},  // API 15
        {"micLevel", js_micLevel, 0},
        {"touchPad", js_touchPad, 0},
        {"lightLevel", js_lightLevel, 0},
        {"get24hFormat", js_get24hFormat, 0},
        {"getNtpEnabled", js_getNtpEnabled, 0},
        {"theme", js_theme, 0},
        {"setScreenTimeout", js_setScreenTimeout, 1},
        {"screenTimeout", js_screenTimeout, 0},
        {"setAlarm", js_setAlarm, 3},
        {"clearAlarm", js_clearAlarm, 0},
        {"getAlarm", js_getAlarm, 0},
        {"alarms", js_alarms, 0},              // API 15: agendador persistente
        {"addAlarm", js_addAlarm, 1},
        {"updateAlarm", js_updateAlarm, 2},
        {"removeAlarm", js_removeAlarm, 1},
        {"setTimer", js_setTimer, 2},
        {"getTimer", js_getTimer, 0},
        {"cancelTimer", js_cancelTimer, 0},
        {"unreadNotifications", js_unreadNotifications, 0},
        {"playTone", js_playTone, 1},
        {"playWav", js_playWav, 1},
        {"playMusic", js_playMusic, 2},        // API 25: chiptune N trilhas; opts {startMs} na 27
        {"musicStop", js_musicStop, 0},        // API 25
        {"sfx", js_sfx, 1},                    // API 32
        {"musicPlaying", js_musicPlaying, 0},  // API 25
        {"musicPos", js_musicPos, 0},          // API 25
        {"notify", js_notify, 2},
    };
    putFns(ctx, kFns16);

#if CONFIG_CELEROS_UI
    // Desenho/canvas do app (só com vidro): recorte, pixels físicos, icone
    static const JsFn kFns16ui[] = {
        {"setClip", js_setClip, 4},
        {"clearClip", js_clearClip, 0},
        {"setNativeCanvas", js_setNativeCanvas, 1},  // API 28: pixels fisicos
        {"drawIcon", js_drawIcon, 3},
    };
    putFns(ctx, kFns16ui);
#endif

    // Hardware EXTERNO ligado a pinos: capability "gpio" (a mesma dos
    // servos/digitalWrite). Nas SKUs "Y" o relay comuta rede eletrica —
    // um app de loja sem "gpio" nao pode acionar. Sensores de leitura
    // (battery/micLevel/lightLevel/touchPad) seguem abertos.
    static const JsFn kFnsHw[] = {
        {"led", js_led, 3},
        {"relay", js_relay, 2},
        {"relayState", js_relayState, 1},
        {"relayCount", js_relayCount, 0},
        {"neopixel", js_neopixel, 2},
    };
    if (perm(celer::PERM_GPIO)) putFns(ctx, kFnsHw);

    // Chamadas que comprometem o aparelho: capability "system" (F4)
    static const JsFn kFnsSysDanger[] = {
        {"restart", js_restart, 0},
        {"openWifiSetup", js_openWifiSetup, 0},
        {"factoryReset", js_factoryReset, 1},
        {"otaCheck", js_otaCheck, 0},
        {"otaStart", js_otaStart, 2},
        {"installZip", js_installZip, 2},
        // Gates da politica dos servicos (API 42): getters burros que o
        // svchost usa para decidir QUANDO agir; uteis tambem a apps de
        // sistema (Ajustes mostra "checando...", evita check em cima).
        {"appOpen", js_appOpen, 0},
        {"updateBusy", js_updateBusy, 0},
        {"shellActive", js_shellActive, 0},
        {"syncTime", js_syncTime, 0},
        {"timeValid", js_timeValid, 0},
        {"persistTime", js_persistTime, 0},
        {"webActive", js_webActive, 0},
        {"webSetActive", js_webSetActive, 1},
        {"webAuthInfo", js_webAuthInfo, 0},
        {"webAuthSetPass", js_webAuthSetPass, 1},
        {"deepSleep", js_deepSleep, 2},
        // PIN do Settings e relogio do sistema: antes qualquer app podia
        // apagar o PIN (pinClear), testar PINs a vontade (verifyPin) ou
        // mudar a hora/fuso de todo o aparelho
        {"setPin", js_setPin, 1},
        {"verifyPin", js_verifyPin, 1},
        {"pinClear", js_pinClear, 0},
        {"setTimezone", js_setTimezone, 1},
        {"setManualTime", js_setManualTime, 5},
        {"set24hFormat", js_set24hFormat, 1},
        {"setNtpEnabled", js_setNtpEnabled, 1},
    };
    if (perm(celer::PERM_SYSTEM)) putFns(ctx, kFnsSysDanger);

    // Historico de notificacoes so interessa a quem pode limpar/tocar nele
    static const JsFn kFnsNotif[] = {
        {"notifications", js_notifications, 0},
        {"notificationsClear", js_notificationsClear, 0},
    };
    if (perm(celer::PERM_SYSTEM)) putFns(ctx, kFnsNotif);

    // Assign to global variable 'System'
    duk_put_prop_string(ctx, -2, "System");

    // Globais de timer (API 12), no padrao do navegador: disparam no
    // present() (delay/getTouch/chamadas bloqueantes). Sem Promise no
    // Duktape, isto e a fundacao de "event loop" cooperativo dos apps.
    static const JsFn kFnsTimers[] = {
        {"setTimeout", js_setTimeout, 2},
        {"setInterval", js_setInterval, 2},
        {"clearTimeout", js_clearTimeout, 1},
        {"clearInterval", js_clearInterval, 1},
    };
    putFns(ctx, kFnsTimers);

    // Modulos JS (API 23): require("nome") carrega <pasta do app>/nome.js
    // como funcao(module, exports, require) com cache por app-run (heap
    // stash). Sem gate de permissao: e codigo do proprio app (JsModules.cpp)
    static const JsFn kFnsModules[] = {
        {"require", js_require, 1},
    };
    putFns(ctx, kFnsModules);

    // Storage (API 12): chave-valor NVS PRIVADO do app (namespace =
    // packageName). Sem permissao: e dado do proprio app, nao do sistema.
    duk_push_object(ctx);  // Storage
    static const JsFn kFnsStorage[] = {
        {"get", js_storageGet, 2},
        {"set", js_storageSet, 2},
        {"remove", js_storageRemove, 1},
        {"clear", js_storageClear, 0},
    };
    putFns(ctx, kFnsStorage);
    // clearFor apaga o Storage de OUTRO app (desinstalacao): so "system"
    static const JsFn kFnsStorageSys[] = {
        {"clearFor", js_storageClearFor, 1},
    };
    if (perm(celer::PERM_SYSTEM)) putFns(ctx, kFnsStorageSys);
    duk_put_prop_string(ctx, -2, "Storage");

    // Sensors (API 13): IMU da placa (hoje o watch — hooks imu* do perfil).
    // Leituras abertas, no padrao dos demais sensores (bateria/luz).
    duk_push_object(ctx);  // Sensors
    static const JsFn kFnsSensors[] = {
        {"accel", js_sensorsAccel, 0},   // {x,y,z} em g (ou null)
        {"steps", js_sensorsSteps, 0},   // passos do dia (-1 sem IMU)
        {"temp", js_sensorsTemp, 0},     // die do IMU em °C (-255 sem sensor)
        {"stepHistory", js_sensorsStepHistory, 0},  // API 15: ate 7 dias fechados
    };
    putFns(ctx, kFnsSensors);
    duk_put_prop_string(ctx, -2, "Sensors");

#if CONFIG_CELEROS_UI
    // UI (API 22): toolkit imediato com o visual do Kui (JsUi.cpp)
    duk_push_object(ctx);  // UI
    static const JsFn kFnsUi[] = {
        {"begin", js_uiBegin, 1},            // ([bg]) -> true = frame total
        {"end", js_uiEnd, 1},                // ([fps]) present + ritmo
        {"invalidate", js_uiInvalidate, 0},  // proximo frame total
        {"touch", js_uiTouch, 0},            // {down,x,y,tap,released,moved} do frame
        {"toast", js_uiToast, 2},            // (msg, [ms]) aviso curto dentro do app
        {"text", js_uiText, 4},              // (s, x, y, {role,color,align,w,lines,bg}) -> altura
        {"measure", js_uiMeasure, 2},        // (s, role) -> largura
        {"lineHeight", js_uiLineHeight, 1},  // (role) -> altura da linha
        {"measureWrap", js_uiMeasureWrap, 3},  // (s, w, [role]) -> altura do texto quebrado
        {"header", js_uiHeader, 2},          // (title, {sub,back}) -> voltar?
        {"button", js_uiButton, 6},          // (label, x, y, w, h, {style,disabled,id}) -> tap?
        {"toggle", js_uiToggle, 4},          // (x, y, on, {id}) -> on
        {"slider", js_uiSlider, 5},          // (x, y, w, v, {min,max,step}) -> v
        {"progress", js_uiProgress, 5},      // (x, y, w, h, pct)
        {"spinner", js_uiSpinner, 4},        // (cx, cy, r, [color])
        {"list", js_uiList, 7},              // (id, x, y, w, h, items, {rowH,selected}) -> idx|-1
        {"tabs", js_uiTabs, 6},              // (x, y, w, h, labels, sel) -> sel
        {"card", js_uiCard, 5},              // (x, y, w, h, {color,radius,stroke})
        {"cardEnd", js_uiCardEnd, 0},
        {"scrollBegin", js_uiScrollBegin, 6},  // (id, x, y, w, h, contentH) -> off
        {"scrollEnd", js_uiScrollEnd, 0},
        {"resetScroll", js_uiResetScroll, 1},
        {"scrollTo", js_uiScrollTo, 2},      // (id, y) posiciona (y grande = fim)
        {"badge", js_uiBadge, 4},            // (text, x, y, {color,textColor}) -> largura
        {"confirm", js_uiConfirm, 3},        // (title, body, {yes,no,danger}) -> bool (bloqueia)
        {"alert", js_uiAlert, 3},            // (title, body, [ok]) (bloqueia)
    };
    putFns(ctx, kFnsUi);
    duk_put_prop_string(ctx, -2, "UI");
#endif  // CONFIG_CELEROS_UI

    // --- Net Object (HTTP para apps, API level 2) — capability "net" (F4) ---
    if (perm(celer::PERM_NET)) {
    duk_push_object(ctx); // Net
    static const JsFn kFns17[] = {
        {"get", js_netGet, 1},
        {"getJSON", js_netGetJSON, 1},
        {"post", js_netPost, 3},
        {"request", js_netRequest, 1},  // API 49: headers proprios + status
        {"download", js_netDownload, 3},
        {"beginGet", js_netBeginGet, 1},
        {"pollGet", js_netPollGet, 1},
        {"cancelGet", js_netCancelGet, 1},
        {"isConnected", js_netIsConnected, 0},
        {"wifiScan", js_wifiScan, 0},
    };
    putFns(ctx, kFns17);
    // wifiConnect/wifiDisconnect gravam credenciais: exigem "system" tambem
    static const JsFn kFnsNetSys[] = {
        {"wifiConnect", js_wifiConnect, 2},
        {"wifiDisconnect", js_wifiDisconnect, 0},
    };
    if (perm(celer::PERM_SYSTEM)) putFns(ctx, kFnsNetSys);
    duk_put_prop_string(ctx, -2, "Net");
    }

    // --- AI Object (API 18): chat LLM (opts.provider: deepseek|openrouter)
    // + AI.speak TTS (API 24, openrouter) — capability "net" (HTTPS) ---
    if (perm(celer::PERM_NET)) {
    duk_push_object(ctx); // AI
    static const JsFn kFnsAI[] = {
        {"chat", js_aiChat, 2},              // cb({ok,content,raw,status,usage,toolCalls[{id,name,args}],finishReason}) 1x (API 20: toolCalls)
        {"speak", js_aiSpeak, 2},            // cb({ok,status,path,bytes,played,error?,detail?}) 1x (TTS, API 24)
        {"warm", js_aiWarm, 1},              // [provider]: abre o TLS antes do chat (API 24)
        {"configured", js_aiConfigured, 1},  // chave no aparelho? ([provider])
        {"cancel", js_aiCancel, 0},          // esquece a requisicao em curso
    };
    putFns(ctx, kFnsAI);
    duk_put_prop_string(ctx, -2, "AI");
    }

    // --- Mic Object (API 19): gravacao de microfone — capability "mic".
    // O audio do dono e dado sensivel: o objeto so nasce para app
    // autorizado, em placa com microfone no perfil (cao e watch hoje).
    // Build sem o canal (CELEROS_MIC=n, perfil lite): o objeto nem chega ao
    // app — typeof Mic === "undefined", como no perfil sem hardware. ---
#if CONFIG_CELEROS_MIC
    if (perm(celer::PERM_MIC) && Board::profile().mic.ws >= 0) {
    duk_push_object(ctx); // Mic
    static const JsFn kFnsMic[] = {
        {"start", js_micRecStart, 1},          // Mic.start({ms}) -> bool
        {"stop", js_micRecStop, 1},            // Mic.stop({raw}) -> base64|wav|null
        {"recording", js_micRecRecording, 0},  // capturando (false no teto)
        {"level", js_micRecLevel, 0},          // RMS 0..100 (-1 parado)
    };
    putFns(ctx, kFnsMic);
    duk_put_prop_string(ctx, -2, "Mic");
    }
#endif  // CONFIG_CELEROS_MIC
#if CONFIG_CELEROS_JS_CAMERA
    // --- Camera Object (API 35): OV2640 da esp32-cam — capability "camera".
    // Objeto so nasce em placa com sensor no perfil E build com o driver
    // (CELEROS_JS_CAMERA): apps feature-detectam com typeof Camera. ---
    if (perm(celer::PERM_CAMERA) && Board::profile().camera.present()) {
    duk_push_object(ctx);  // Camera
    static const JsFn kFnsCam[] = {
        {"setup", js_cameraSetup, 1},      // ({framesize,pixformat,fbcount,xclkMhz}) -> bool
        {"capture", js_cameraCapture, 0},  // () -> {id,w,h,len,format}|null
        {"save", js_cameraSave, 2},        // (id, path) -> bytes gravados|-1
        {"free", js_cameraFree, 1},        // (id)
        {"led", js_cameraLed, 1},          // (bool): LED de flash do sensor
        {"scanQR", js_cameraScanQR, 1},    // ({timeoutMs,attempts,led}) -> string|null
    };
    putFns(ctx, kFnsCam);
    duk_put_prop_string(ctx, -2, "Camera");
    }
#endif
#if CONFIG_CELEROS_WAKE_WORD
    // Wake word on-device "Hi ESP" (API 20): mesma permissao do mic (ouvir
    // o dono), mesma placa-requisito, e so no build com esp-sr (o cao).
    if (perm(celer::PERM_MIC) && Board::profile().mic.ws >= 0) {
    duk_push_object(ctx); // WakeWord
    static const JsFn kFnsWake[] = {
        {"start", js_wakeStart, 0},          // sobe modelo+task -> bool
        {"stop", js_wakeStop, 0},            // encerra e libera RAM
        {"poll", js_wakePoll, 0},            // true = detectado (consome)
        {"level", js_wakeLevel, 0},          // RMS 0..100 (-1 parado)
        {"running", js_wakeRunning, 0},      // task viva?
    };
    putFns(ctx, kFnsWake);
    duk_put_prop_string(ctx, -2, "WakeWord");
    }
#endif

    // --- FS Object — capability "fs" (F4) ---
    if (perm(celer::PERM_FS)) {
    duk_push_object(ctx); // FS
    static const JsFn kFns18[] = {
        {"readTextFile", js_readTextFile, 1},
        {"readFile", js_readFile, 2},
        {"writeTextFile", js_writeTextFile, 2},
        {"writeFile", js_writeFile, 2},
        {"appendTextFile", js_appendTextFile, 2},
        {"deleteFile", js_deleteFile, 1},
        {"renameFile", js_renameFile, 2},
        {"exists", js_fileExists, 1},
        {"listDir", js_listDir, 1},
        {"mkdir", js_mkdir, 1},
        {"rmdir", js_rmdir, 1},
        {"isDirectory", js_isDirectory, 1},
        {"isFile", js_isFile, 1},
        {"getFileSize", js_getFileSize, 1},
        {"getTotalSpace", js_getTotalSpace, 1},
        {"getUsedSpace", js_getUsedSpace, 1},
        {"getFreeSpace", js_getFreeSpace, 1},
        {"getFileMD5", js_getFileMD5, 1},
        {"mountSD", js_mountSD, 0},
        {"unmountSD", js_unmountSD, 0},
        {"copyFile", js_copyFile, 2},
        {"copyDirectory", js_copyDirectory, 2},
        {"removeDirectory", js_removeDirectory, 1},
        {"appData", js_appData, 0},
    };
    putFns(ctx, kFns18);

    // Assign to global variable 'FS'
    duk_put_prop_string(ctx, -2, "FS");
    }

#if CONFIG_CELEROS_BLUETOOTH
    // --- CelerLink Object (Bluetooth entre CelerOS, API 9; pareamento
    // por codigo na API 11) — sem capability propria (as mensagens sao
    // do app; o gate de pareamento e do link, ver CelerLink.h) ---
    duk_push_object(ctx); // CelerLink
    static const JsFn kFns19[] = {
        {"start", js_linkStart, 2},
        {"stop", js_linkStop, 0},
        {"scan", js_linkScan, 1},
        {"connect", js_linkConnect, 2},
        {"disconnect", js_linkDisconnect, 0},
        {"send", js_linkSend, 1},
        {"poll", js_linkPoll, 0},
        {"sendSealed", js_linkSendSealed, 1},   // API 21: AES-GCM com o bond
        {"pollSealed", js_linkPollSealed, 0},   // API 21: so selos autenticados
        {"status", js_linkStatus, 0},
        {"verify", js_linkVerify, 1},
        {"unpair", js_linkUnpair, 1},
    };
    putFns(ctx, kFns19);
    duk_put_prop_string(ctx, -2, "CelerLink");

    // --- CelerNet Object (malha BLE por flood de advertising, API 26) —
    // infraestrutura persistente (nao e sessao de app), sem capability
    // (o filtro e o ID da rede; ver CelerNet.h) ---
    duk_push_object(ctx);  // CelerNet
    static const JsFn kFnsMesh[] = {
        {"start", js_meshStart, 1},          // opts {name, net, relay}
        {"stop", js_meshStop, 0},
        {"broadcast", js_meshBroadcast, 2},  // msg, ttl opcional (default 4)
        {"send", js_meshSend, 3},            // to (id "A1B2" ou nome), msg, opts (API 27)
        {"poll", js_meshPoll, 0},            // {from, fromName, msg, unicast, hops, rssi} | null
        {"nodes", js_meshNodes, 0},          // presenca ouvida (com caps na API 27)
        {"status", js_meshStatus, 0},
    };
    putFns(ctx, kFnsMesh);
    duk_put_prop_string(ctx, -2, "CelerNet");

    // --- Pack Object (matilha, API 27) — papeis no BEAT, envelopes
    // custom unicast e handoff de musica; infraestrutura persistente,
    // sem capability (mesma porta do CelerNet: o filtro e o ID da rede) ---
    duk_push_object(ctx);  // Pack
    static const JsFn kFnsPack[] = {
        {"me", js_packMe, 0},                        // {id, name, caps, net, provisioned}
        {"members", js_packMembers, 0},              // bando ouvido (caps decodificados)
        {"send", js_packSend, 3},                    // to (id/nome), msg, opts {urgent}
        {"poll", js_packPoll, 0},                    // envelopes custom | null
        {"handoffMusic", js_packHandoffMusic, 1},    // [to] passa a musica em curso
        // entrar na matilha (API 40, perm "system"): senha ou convite do CelerLink
        {"join", js_packJoin, 2},                    // nome, senha -> bool
        {"leave", js_packLeave, 0},                  // volta a rede aberta "celer"
        {"acceptInvite", js_packAcceptInvite, 1},    // [on] janela de convite (10 min)
        {"invite", js_packInvite, 0},                // convida o peer do CelerLink verificado
        {"inviteStatus", js_packInviteStatus, 0},    // idle|waiting|joined|sent|ok|fail
        // recursos da matilha (API 36): handles numericos, nada bloqueia
        {"resources", js_packResources, 1},          // [tipo] recursos dos vizinhos (cache + DESCRIBE)
        {"open", js_packOpen, 3},                    // no, nome, [opts] -> handle | -1
        {"status", js_packStatus, 1},                // h -> {state, reason, node, name} | null
        {"read", js_packRead, 1},                    // h -> dado | null
        {"onEvent", js_packOnEvent, 1},              // h -> {v, dir, at} | null (threshold, API 47)
        // reflexos nativos (API 47, perm "system"): a regra mora neste no
        {"ruleAdd", js_packRuleAdd, 1},              // {sensor, op, valor, h, alvo, no, on, notificar} -> id | -1
        {"ruleDel", js_packRuleDel, 1},              // id -> bool
        {"ruleList", js_packRuleList, 0},            // regras persistidas no NVS
        {"write", js_packWrite, 2},                  // h, dado -> bool
        {"close", js_packClose, 1},                  // h
        {"expose", js_packExpose, 2},                // nome, [opts {shared}] canal de dados do app
        {"unexpose", js_packUnexpose, 1},            // nome
        {"publish", js_packPublish, 2},              // nome, dado -> sessoes alcancadas
        {"sessions", js_packSessions, 1},            // nome -> sessoes vivas | -1
        {"pollWrite", js_packPollWrite, 0},          // {res, from, fromName, data} | null
        // audio de outro no (R3, ESP-NOW; perm "mic"): handles dos recursos
        {"listen", js_packListen, 1},                // no -> h: mic dele no nosso speaker
        {"speak", js_packSpeak, 1},                  // no -> h: nosso mic no speaker dele
        {"record", js_packRecord, 2},                // no, [{ms}] -> h: grava o mic dele aqui
        {"recording", js_packRecording, 1},          // h -> bool
        {"level", js_packLevel, 0},                  // RMS 0..100 da gravacao remota
        {"recordStop", js_packRecordStop, 2},        // h, [{raw, path}] -> base64|wav|bool|null
        // camera de outro no (R3, ESP-NOW; perm "camera")
        {"snap", js_packSnap, 2},                    // no, {path, quality} -> h (state "done")
        {"view", js_packView, 2},                    // no, [{fps, quality}] -> h (video)
        {"drawFrame", js_packDrawFrame, 3},          // h, x, y -> bool (quadro novo desenhado)
    };
    putFns(ctx, kFnsPack);
    duk_put_prop_string(ctx, -2, "Pack");
#endif

#if CONFIG_CELEROS_PHONE_LINK
    // --- Phone Object (API 15): celular pareado pelo Gadgetbridge ---
    duk_push_object(ctx);  // Phone
    static const JsFn kFnsPhone[] = {
        {"status", js_phoneStatus, 0},
        {"setEnabled", js_phoneSetEnabled, 1},  // lint-perm: system
        {"music", js_phoneMusic, 1},
        {"musicInfo", js_phoneMusicInfo, 0},
        {"weather", js_phoneWeather, 0},
        {"find", js_phoneFind, 1},
        {"forget", js_phoneForget, 0},  // lint-perm: system
    };
    putFns(ctx, kFnsPhone);
    duk_put_prop_string(ctx, -2, "Phone");
#endif

    // --- Input Object (API 48): barramento de teclado/mouse do OS ---
    // O driver (JS) injeta; o app com a capability "input" le. Sem driver de
    // hardware aqui — e a porta para teclado/mouse USB e para o que vier.
    if (perm(celer::PERM_INPUT)) {
        duk_push_object(ctx);  // Input
        static const JsFn kFnsInput[] = {
            {"key", js_inputKey, 3},
            {"poll", js_inputPoll, 0},
            {"move", js_inputMove, 3},
            {"pointer", js_inputPointer, 0},
            {"clear", js_inputClear, 0},
        };
        putFns(ctx, kFnsInput);
        duk_put_prop_string(ctx, -2, "Input");
    }

#if CONFIG_CELEROS_USB_HOST
    // --- USB Object (API 48): USB Host cru (placa devkit-s3) ---
    // Drivers de dispositivo sao JS; aqui so devices/descritores/transfers.
    if (perm(celer::PERM_USB)) {
        duk_push_object(ctx);  // USB
        static const JsFn kFnsUsb[] = {
            {"devices", js_usbDevices, 0},
            {"poll", js_usbPoll, 0},
            {"claim", js_usbClaim, 3},
            {"release", js_usbRelease, 2},
            {"controlIn", js_usbControlIn, 7},
            {"controlOut", js_usbControlOut, 7},
            {"out", js_usbOut, 4},
            {"in", js_usbIn, 4},
            {"sendFile", js_usbSendFile, 5},
            {"listen", js_usbListen, 4},
            {"read", js_usbRead, 2},
            {"unlisten", js_usbUnlisten, 2},
            {"flush", js_usbFlush, 2},
        };
        putFns(ctx, kFnsUsb);
        duk_put_prop_string(ctx, -2, "USB");
    }
#endif

    // --- Color Constants on global scope ---
    // Common TFT colors so JS apps don't need hex
    duk_push_uint(ctx, 0x0000); duk_put_prop_string(ctx, -2, "BLACK");
    duk_push_uint(ctx, 0xFFFF); duk_put_prop_string(ctx, -2, "WHITE");
    duk_push_uint(ctx, 0xF800); duk_put_prop_string(ctx, -2, "RED");
    duk_push_uint(ctx, 0x07E0); duk_put_prop_string(ctx, -2, "GREEN");
    duk_push_uint(ctx, 0x001F); duk_put_prop_string(ctx, -2, "BLUE");
    duk_push_uint(ctx, 0xFFE0); duk_put_prop_string(ctx, -2, "YELLOW");
    duk_push_uint(ctx, 0x07FF); duk_put_prop_string(ctx, -2, "CYAN");
    duk_push_uint(ctx, 0xF81F); duk_put_prop_string(ctx, -2, "MAGENTA");
    duk_push_uint(ctx, 0xFDA0); duk_put_prop_string(ctx, -2, "ORANGE");
    duk_push_uint(ctx, 0x7BEF); duk_put_prop_string(ctx, -2, "DARKGREY");

    duk_pop(ctx); // pop global object
}
