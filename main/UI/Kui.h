#ifndef CELEROS_KUI_H
#define CELEROS_KUI_H

// ============================================================================
// Kui — mini-framework de UI do CelerOS (W7).
//
// Principios:
//   1. UM dispatcher de input: o Navigator faz o unico poll de touch e
//      roteia eventos (press/drag/release com classificacao tap/swipe
//      correta) para a Screen do topo da pilha.
//   2. Telas sao classes (Screen) numa pilha com back-stack; ninguem
//      escreve em estado global de navegacao.
//   3. Desenho e hit-test da MESMA geometria: widgets expoem Rect; o
//      mesmo Rect desenha e testa o toque — fim dos hit-tests manuais.
//   4. Texto sempre transparente (sem cor de fundo): quem limpa o fundo
//      e o widget, por retangulo inteiro. Fundos "estranhos" acabam.
//   5. Canvas com buffer: o frame e composto fora da tela e enviado de uma
//      vez (zero flicker). Com PSRAM: sprite full-screen; sem PSRAM (CYD):
//      duas faixas horizontais em ping-pong na RAM interna (uma compoe
//      enquanto a outra sai por DMA) — a tela e desenhada N vezes, uma
//      por faixa, entao draw() deve ser idempotente (sem efeitos colaterais
//      alem de calcular geometria).
//   6. Feedback de toque: widgets consultam kui::isPressed(rect) no draw e
//      o Navigator redesenha no press/release — todo alvo tocavel "afunda".
//
// Coordenadas: fisicas (px do display). Para layout, usar UI::sx/sy do
// design 240x320 como hoje.
// ============================================================================

#include <stdint.h>
#include <stddef.h>
#include <functional>
#include <vector>
#include <string>

#include "Boards/Board.h"
#include "Display/Layout.h"
#include "Display/Theme.h"

namespace kui {

// ---------------------------------------------------------------- Rect ----
struct Rect {
    int x = 0, y = 0, w = 0, h = 0;
    bool contains(int px, int py) const { return px >= x && px < x + w && py >= y && py < y + h; }
};

// ----------------------------------------------------------- TouchEvent ----
struct TouchEvent {
    enum Type { Press, Drag, Release } type;
    int x = 0, y = 0;          // posicao atual (fisica)
    int startX = 0, startY = 0;  // posicao do press
    int prevX = 0, prevY = 0;  // posicao do evento anterior (delta p/ scroll)
    uint32_t holdMs = 0;     // duracao ate agora (Release: tempo total)

    int dx() const { return x - startX; }
    int dy() const { return y - startY; }

    // tap = release rapido sem deslocamento relevante
    // (mesma tolerancia do TouchState::moved: o que "afunda" e o que dispara)
    bool isTap() const { return type == Release && holdMs < 800 && abs(dx()) < slopX() && abs(dy()) < slopY(); }
    static int slopX() { return UI::sx(18); }
    static int slopY() { return UI::sy(18); }
    // swipe = release com deslocamento dominante em um eixo
    enum Swipe { SwipeNone, SwipeLeft, SwipeRight, SwipeUp, SwipeDown };
    Swipe swipe() const {
        if (type != Release || holdMs > 700) return SwipeNone;
        int adx = abs(dx()), ady = abs(dy());
        if (adx < UI::sx(60) && ady < UI::sy(60)) return SwipeNone;
        if (adx > ady) return dx() > 0 ? SwipeRight : SwipeLeft;
        return dy() > 0 ? SwipeDown : SwipeUp;
    }
};

// ----------------------------------------------------------- TouchState ----
// Estado do toque em andamento (atualizado pelo TouchPump). Widgets usam no
// draw() para o estado "pressionado".
struct TouchState {
    bool down = false;
    bool moved = false;       // saiu da tolerancia de tap (virou arrasto)
    int x = 0, y = 0;         // posicao atual
    int startX = 0, startY = 0;
};
const TouchState& touchState();
// Toque ativo, sem arrasto, que comecou e continua dentro de r
bool isPressed(const Rect& r);

// ------------------------------------------------------------- Tipografia ----
// Papeis tipograficos (escolhem a fonte certa para a densidade da tela).
// Os numeros de fonte legados (1/2/4) seguem valendo via CelerFont().
namespace type {
const lgfx::IFont* caption();   // legendas, rotulos de icone
const lgfx::IFont* body();      // texto corrido, itens de lista, botoes
const lgfx::IFont* title();     // titulos de tela (negrito)
const lgfx::IFont* display();   // relogio / numeros grandes (negrito)
}  // namespace type

// ---------------------------------------------------------------- Canvas ----
// Superficie de desenho de um frame. O buffer (sprite full-screen na PSRAM
// ou faixa na RAM interna) e unico e compartilhado entre instancias.
class Canvas {
public:
    enum Mode { Direct, FullFrame, Bands };

    explicit Canvas(CelerDisplay& dev);

    // Desenho direto num alvo arbitrario (Direct fixo, sem render()): usado
    // pela ponte JS para compor widgets (teclado acoplado) no MESMO alvo do
    // app — gfx(): quadro PSRAM, sprite do app ou display.
    Canvas(CelerDisplay& dev, lgfx::LGFXBase* directTarget);

    // Compoe um frame: chama fn uma vez (FullFrame/Direct) ou uma vez por
    // faixa (Bands) e apresenta o resultado. direct=true desenha direto no
    // display (telas legacy, que limpam/desenham por conta propria).
    void render(const std::function<void(Canvas&)>& fn, bool direct = false);

    // Frame PARCIAL: o buffer ja contem o quadro anterior, entao NAO pinta o
    // fundo da tela nem empurra o quadro inteiro — compoe com recorte em `r`
    // e empurra so `r` (o recorte do pushImage do LGFX limita a copia).
    // So vale no FullFrame (PSRAM); nos outros modos cai no render() normal.
    // Invariante: ao fim de cada passada, buffer e vidro continuam iguais —
    // quem chama compoe exatamente a regiao que mudou desde a ultima.
    void renderRegion(const Rect& r, const std::function<void(Canvas&)>& fn);

    // A passada em andamento e parcial (renderRegion)?
    bool partial() const { return m_partial; }

    // Modo do frame em andamento
    Mode mode() const { return m_mode; }

    // r cruza a area desenhada nesta passada? (Bands: a faixa corrente;
    // demais modos: sempre). Telas pulam blocos inteiros fora da faixa — o
    // recorte do sprite descarta os pixels, mas nao o custo de calcular.
    bool visible(const Rect& r) const {
        if (m_mode != Bands) return true;
        return r.y < m_offY + m_target->height() && r.y + r.h > m_offY;
    }

    // Primitivas (unidades fisicas; cores RGB888 como o resto do firmware)
    void fill(uint32_t color);
    void fillRect(const Rect& r, uint32_t color);
    void fillRoundRect(const Rect& r, int radius, uint32_t color);
    void fillGradient(const Rect& r, int radius, uint32_t top, uint32_t bottom);
    void drawRoundRect(const Rect& r, int radius, uint32_t color);
    void drawRect(const Rect& r, uint32_t color);
    void drawLine(int x0, int y0, int x1, int y1, uint32_t color);
    void drawFastHLine(int x, int y, int w, uint32_t color);
    void drawCircle(int cx, int cy, int r, uint32_t color);
    void fillCircle(int cx, int cy, int r, uint32_t color);
    void fillTriangle(int x0, int y0, int x1, int y1, int x2, int y2, uint32_t color);
    // Arco preenchido (angulos em graus, 0 = 3h, sentido horario)
    void fillArc(int cx, int cy, int r0, int r1, float a0, float a1, uint32_t color);
    void pushImage(int x, int y, int w, int h, const uint16_t* data);
    // Icone do pacote (Icon::draw): compoe o alpha sobre o fundo atual
    void drawIcon(const char* name, int x, int y);
    // Tile de app do usuario (gradiente + inicial)
    void drawAppTile(const char* appName, int x, int y);
    // Escurece o frame; keep (se nao-vazio) fica fora do escurecimento — o
    // card do dialogo e desenhado opaco por cima, entao pular seus pixels
    // economiza ~30% do loop sem mudar o resultado.
    void dim(const Rect& keep = {0, 0, 0, 0});
    // Passada parcial (buffer full-frame): desloca os pixels de r em dx na
    // horizontal dentro do buffer (o que sai da tela e descartado; a faixa
    // que fica para tras NAO e limpa). false fora do buffer full-frame.
    bool shiftX(const Rect& r, int dx);
    // Recorte (coordenadas fisicas); clearClip restaura a tela inteira
    void setClip(const Rect& r);
    void clearClip();

    // Texto SEMPRE transparente (o widget limpa o proprio fundo antes)
    void text(const char* s, int x, int y, uint8_t font, uint32_t color, int datum = TL_DATUM);
    void text(const std::string& s, int x, int y, uint8_t font, uint32_t color, int datum = TL_DATUM);
    void text(const char* s, int x, int y, const lgfx::IFont* font, uint32_t color, int datum = TL_DATUM);
    void text(const std::string& s, int x, int y, const lgfx::IFont* font, uint32_t color, int datum = TL_DATUM);
    int textWidth(const char* s, uint8_t font);
    int textWidth(const char* s, const lgfx::IFont* font);
    int fontHeight(const lgfx::IFont* font);
    // Corta s com ".." ate caber em maxW
    std::string ellipsize(const std::string& s, const lgfx::IFont* font, int maxW);
    // Quebra por palavra em ate maxLines linhas que cabem em maxW; a ultima
    // leva o resto com "..". So geometria (draw idempotente segue valendo).
    std::vector<std::string> wrapText(const std::string& s, const lgfx::IFont* font, int maxW,
                                      int maxLines);

    int width() const;
    int height() const;

private:
    CelerDisplay& m_dev;
    lgfx::LGFXBase* m_target;
    int m_offY = 0;        // topo da faixa corrente (Bands)
    Mode m_mode = Direct;
    // Recorte duro da passada parcial: setClip()/clearClip() da tela nunca
    // abrem alem dele (senao o buffer ganharia pixels que nao foram ao vidro
    // e a invariante "buffer == vidro" quebraria na passada seguinte).
    Rect m_clip;
    bool m_clipOn = false;
    bool m_partial = false;
    int Y(int y) const { return y - m_offY; }
};

// True quando o Canvas tem buffer offscreen (full-frame PSRAM): telas podem
// optar por animacoes de arrasto continuo; no modo direto (sem PSRAM) cada
// redraw e visivel — melhor trocar paginas no release do que seguir o dedo.
bool canvasBuffered();

// Devolve o buffer do Canvas ao heap (16KB de RAM interna sem PSRAM): usado
// antes de um app JS assumir o vidro. O proximo render realoca sozinho.
void releaseCanvasBuffer();

// Cabecalho padrao das telas Kui: faixa com titulo; devolve a altura.
int headerHeight();
void drawHeader(Canvas& c, const char* title);

// ---------------------------------------------------------------- paint ----
// Pintores puros dos widgets: geometria + estado visual entram por parametro
// (nada de isPressed/estado do Navigator). Os widgets Kui e o toolkit `UI`
// dos apps JS (Runtime/JsUi.cpp) desenham pelos MESMOS pintores — o app JS
// fica com o mesmo visual das telas do sistema. Coordenadas fisicas.
namespace paint {
enum ButtonStyle { BtnPrimary, BtnGhost, BtnDanger };
// Cabecalho (faixa de altura h com marcador de acento + titulo). sub opcional
// (legenda a direita); back desenha a seta de voltar e desloca o titulo.
void header(Canvas& c, const Rect& r, const char* title, const char* sub, bool back, bool backPressed);
// font nullptr = type::body()
void button(Canvas& c, const Rect& r, const char* label, ButtonStyle style, bool pressed,
            const lgfx::IFont* font = nullptr);
void toggle(Canvas& c, const Rect& r, bool on, bool pressed);
// value 0..100
void slider(Canvas& c, const Rect& r, int value, bool active);
void progress(Canvas& c, const Rect& r, int value);
void spinner(Canvas& c, const Rect& r, uint32_t color);
// Fundo do card da lista + indicador de scroll (contentH = altura total)
void listFrame(Canvas& c, const Rect& r, int scroll, int contentH);
void signalBars(Canvas& c, int right, int cy, int level, uint32_t on, uint32_t off);
// Uma linha de lista; sub (2a linha, caption) opcional; last = sem separador
void listRow(Canvas& c, const Rect& row, const char* label, const char* sub, const char* right, int bars,
             bool enabled, bool pressed, bool selected, bool last, uint32_t rightColor = THEME_TEXT_DIM);
// Controle segmentado: n rotulos, sel = indice ativo, pressed = indice sob o dedo (-1)
void tabs(Canvas& c, const Rect& r, const char* const* labels, int n, int sel, int pressed);
// Card de dialogo centrado em area (corpo com quebra de linha); botoes na base
Rect dialogCard(const Rect& area, int nButtons);
void dialog(Canvas& c, const Rect& card, const char* title, const char* body, const char* const* buttons,
            const ButtonStyle* styles, int n, int pressed);
// Retangulo do i-esimo botao do dialogo (desenho e hit-test da mesma geometria)
Rect dialogButton(const Rect& card, int i, int n);
// Pilula com texto (caption); devolve a largura
int badge(Canvas& c, int x, int y, const char* text, uint32_t color, uint32_t textColor);
}  // namespace paint

// ---------------------------------------------------------------- Screen ----
class Screen {
public:
    virtual ~Screen() = default;

    virtual void onEnter() {}                    // entrou na pilha
    virtual void onExit() {}                     // saiu da pilha de verdade (pop/home/remove/replace)
    // OUTRA tela entrou por cima (Navigator::push): a tela CONTINUA na pilha,
    // so deixou de ser o topo. onExit nao roda aqui — quem precisa pausar/
    // parar algo ao ser coberto sobrescreve; o padrao e nao fazer nada (a
    // tela volta ao topo pelo onEnter/onResume do pop)
    virtual void onCovered() {}
    // voltou ao TOPO da pilha (pop/home/remove de quem estava em cima, ou
    // dialog fechou): telas com estado visual incremental usam para saber
    // que precisam redesenhar do zero (ex.: launcher limpa o fundo)
    virtual void onResume() {}
    virtual void draw(Canvas& c) = 0;            // redesenho completo da tela
    virtual bool onTouch(const TouchEvent& ev) { (void)ev; return false; }
    virtual void onTick(uint32_t dtMs) { (void)dtMs; }
    // Telas antigas (embrulhadas) desenham direto no display, sem sprite
    virtual bool wantsDirectDraw() const { return false; }
    // Quadro parcial (opcional): devolve a UNICA regiao que mudou desde o
    // ultimo desenho e o Navigator compoe/empurra so ela (renderRegion).
    // So telas que mantem a invariante "buffer == vidro" podem usar: nada
    // de fill da tela inteira nem de desenhar fora da regiao devolvida.
    // false = quadro inteiro, como sempre.
    virtual bool partialFrame(Rect& out) { (void)out; return false; }
    // Swipe a partir da borda esquerda volta (Navigator::pop)
    virtual bool allowsBackGesture() const { return true; }
    // true = o conteudo desta tela e gerenciado por OUTRA task (app JS em
    // task propria): o Navigator nao deve redesenhar o frame (o app e dono
    // do vidro) nem os toasts por cima dele
    virtual bool suppressRedraw() const { return false; }

    void markDirty() { m_dirty = true; }
    bool consumeDirty() {
        bool d = m_dirty;
        m_dirty = false;
        return d;
    }

private:
    bool m_dirty = true;
};

// --------------------------------------------------------------- Widgets ----
class Widget {
public:
    virtual ~Widget() = default;
    virtual void draw(Canvas& c) = 0;
    virtual bool onTouch(const TouchEvent& ev, Rect myRect) { (void)ev; (void)myRect; return false; }
    virtual void onTick(uint32_t) {}

    Rect rect;
    bool visible = true;
};

class Button : public Widget {
public:
    enum Style { Primary, Ghost, Danger };

    std::string label;
    Style style = Primary;
    std::function<void()> onTap;

    void draw(Canvas& c) override;
    bool onTouch(const TouchEvent& ev, Rect myRect) override;
};

class Label : public Widget {
public:
    std::string text;
    uint8_t font = 2;
    uint32_t color = THEME_TEXT;
    int datum = TL_DATUM;

    void draw(Canvas& c) override;
};

// Lista rolavel: itens de uma linha, selecao por tap, scroll por pixel com
// inercia (fling). O dono chama tick(dt) no onTick e marca dirty se true.
class List : public Widget {
public:
    struct Item {
        std::string label;
        std::string right;   // texto a direita (opcional)
        int bars = -1;       // 0..4: indicador de sinal a direita (-1 = nenhum)
        bool enabled = true;
    };

    std::vector<Item> items;
    int selected = -1;
    std::function<void(int)> onSelect;

    void draw(Canvas& c) override;
    bool onTouch(const TouchEvent& ev, Rect myRect) override;
    bool tick(uint32_t dtMs);   // anima a inercia; true = precisa redesenhar
    void ensureVisible(int idx);
    void scrollToTop() { m_scroll = 0; m_vel = 0; }

    int visibleRows(const Rect& myRect) const;
    static int rowH();

private:
    int maxScroll() const;
    void clampScroll();
    float m_scroll = 0;      // px rolados
    float m_vel = 0;         // px/ms (positivo = conteudo sobe)
    uint32_t m_lastDragMs = 0;
    bool m_dragging = false;
};

// Switch: pilula on/off. Tap alterna (feedback de press como o Button).
class Switch : public Widget {
public:
    bool on = false;
    std::function<void(bool)> onChange;
    void draw(Canvas& c) override;
    bool onTouch(const TouchEvent& ev, Rect myRect) override;
};

// Slider horizontal 0..100: arrasto define o valor (live) e o release
// confirma (onChange).
class Slider : public Widget {
public:
    int value = 50;   // 0..100
    std::function<void(int)> onLiveChange;  // durante o arrasto
    std::function<void(int)> onChange;      // ao soltar
    void draw(Canvas& c) override;
    bool onTouch(const TouchEvent& ev, Rect myRect) override;
};

// ProgressBar: preenchimento 0..100 (sem interacao).
class ProgressBar : public Widget {
public:
    int value = 0;   // 0..100
    void draw(Canvas& c) override;
};

// Spinner: arco girando enquanto espera. Chame onTick(dt) no onTick da
// tela e redesenhe; o angulo vive do millis() (draw e idempotente).
class Spinner : public Widget {
public:
    uint32_t color = THEME_ACCENT;
    void draw(Canvas& c) override;
};

// Dialog modal: overlay escuro + card + botoes. Exibido pelo Navigator
// ACIMA da tela corrente; nao bloqueia o loop.
class Dialog : public Widget {
public:
    std::string title;
    std::string body;
    std::vector<Button> buttons;  // desenham lado a lado
    // tickUnder: a tela de baixo segue recebendo onTick (o launcher consome
    // os "run" remotos com o consentimento aberto). timeoutMs > 0: fecha
    // sozinho depois do prazo (onTimeout, se houver, decide o que fazer) —
    // sem isso um dialogo numa tela apagada/headless prendia o launcher
    bool tickUnder = false;
    uint32_t timeoutMs = 0;
    std::function<void()> onTimeout;
    uint32_t shownAtMs = 0;  // preenchido pelo Navigator::showDialog

    void draw(Canvas& c) override;
    bool onTouch(const TouchEvent& ev, Rect myRect) override;

    Rect cardRect() const;
};

// Toast: mensagem curta no topo, auto-dismiss. Fila gerenciada pelo Navigator.
class Toast {
public:
    std::string message;
    uint32_t shownAtMs = 0;
    uint32_t durationMs = 2500;
    uint32_t color = THEME_ACCENT;
};

// Teto de dedos que a pilha rastreia (GT911/FT5x06 tem 5; XPT2046 devolve 1).
constexpr size_t kTouchMax = 5;

// Ponto de toque bruto (coords fisicas). id = track id do controlador
// (identifica o dedo entre quadros; injetado usa o indice do dedo). size =
// area de contato (0 quando o controlador nao informa).
struct TouchPoint {
    uint16_t x = 0, y = 0;
    uint8_t id = 0;
    uint16_t size = 0;
};

// Leitura multi-dedo (fisico ou injetado): escreve ate max pontos em out e
// devolve quantos escreveu. O PRIMARIO (dedo mais antigo ainda na tela) vem
// na posicao 0 — levantar um segundo dedo nao "solta" o toque da UI.
// readTouch e o caso de 1 pontinho. Chamar por quadro.
size_t readTouches(TouchPoint* out, size_t max);

// Leitura unica do touch (fisico ou injetado pelo celerctl). Todo consumidor
// (TouchPump, apps JS) passa por aqui. Sem toque, x/y nao sao escritos.
bool readTouch(uint16_t* x, uint16_t* y);

// ------------------------------------------------------------- TouchPump ----
// Classificador de touch: converte o estado bruto do display em eventos
// Press/Drag/Release (com tap/swipe derivados no TouchEvent). O Navigator
// usa um; modais auto-contidos (ex.: Keyboard::getString) usam o proprio.
class TouchPump {
public:
    using Handler = std::function<void(const TouchEvent&)>;

    // Le o touch agora e entrega 0..1 eventos ao handler.
    void poll(const Handler& onEvent);

    // Janela de quarentena: os pumps descartam eventos ate a janela vencer E o
    // vidro ler dedo solto. Para transicoes feitas pelo sistema (app JS
    // fechando): o release do toque que fechou o app nao pode virar tap na
    // tela de baixo (ex.: X do canto -> icone de WiFi do launcher).
    static void quarantine(uint32_t ms);

    // Zera o estado interno (como se o vidro estivesse limpo): usado quando
    // a UI solta o touch para um app em task propria e depois retoma
    void reset();

private:
    bool m_down = false;
    uint32_t m_releaseSinceMs = 0;  // 1a leitura vazia do release pendente (0 = nenhum)
    int m_lastX = 0, m_lastY = 0;
    int m_pressX = 0, m_pressY = 0;
    uint32_t m_pressMs = 0;
};

// ------------------------------------------------------------ TouchInjector ----
// Fila de amostras de touch sinteticas (celerctl tap/swipe). Os TouchPump
// consomem a fila durante o poll; enquanto houver amostras pendentes (ou
// espera de timing), o touch fisico e ignorado — o gesto injetado e dono do
// pump. Preenchida pela task do HostLink, drenada pelo loop da UI.
class TouchInjector {
public:
    struct Sample {
        bool down;
        uint16_t x = 0, y = 0;
        uint16_t delayMs = 0;  // espera ANTES de virar estado do dedo
        uint8_t finger = 0;    // dedo sintetico (0 = primario; multi: mtap)
    };

    static bool push(const Sample* samples, size_t n);  // false: fila cheia
    static bool active();                               // gesto em curso
    static bool take(Sample& out);                      // pop se o delay venceu

private:
    TouchInjector() = delete;
};

// -------------------------------------------------------------- Navigator ----
class Navigator {
public:
    static void begin(CelerDisplay& dev);

    // Pilha
    static void push(Screen* s);       // entra por cima (desenha s)
    static void pop();                 // volta para a anterior (redesenha)
    static void replace(Screen* s);    // troca o topo
    static void remove(Screen* s);     // tira s da pilha (mesmo sem ser o topo)
    // s COBERTA na pilha: sobe para o topo (o topo antigo leva onCovered, s
    // reajusta estado com onEnter+onResume, como no pop); ausente: empilha
    // (mesmo contrato do push, inclusive a fila de outra task); no topo: no-op.
    // Painel de borda coberto por alerta/chamada que recebe pedido de servico
    // — antes o pedido era consumido e o painel nao subia nunca.
    static void bringToFront(Screen* s);
    static void home();                // esvazia ate a base (launcher)
    static Screen* top();
    static int depth();

    // Dialog/modal por cima da tela atual (nao entra na pilha)
    static void showDialog(Dialog* d);
    static void closeDialog();
    static bool dialogOpen();

    // Toasts (um por vez, fila)
    static void toast(const std::string& message, uint32_t color = THEME_ACCENT, uint32_t durationMs = 2500);

    // Loop: poll de touch + tick + redraw. Chamar do celerLoop.
    static void tick();

    // Suspende o poll de touch da UI: usado quando um app JS roda em task
    // propria (F3) — o app le o touch (I2C) em System.getTouch e duas tasks
    // nao podem ler o mesmo barramento.
    static void setInputSuspended(bool suspended);
    // Gestos de sistema (ex.: bordas do watch): chamado antes da tela do
    // topo em todo evento; true = consumido. nullptr = nenhum.
    static void setGestureHook(bool (*hook)(const TouchEvent& ev));

    // Redesenho forcado da tela do topo
    static void repaint();

    static void pumpEvents();  // gera eventos a partir do estado do touch

private:
    Navigator() = delete;
};

}  // namespace kui

#endif  // CELEROS_KUI_H
