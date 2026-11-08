#ifndef CELEROS_UI_KEYBOARD_H
#define CELEROS_UI_KEYBOARD_H

// ============================================================================
// Keyboard — teclado QWERTY on-screen do CelerOS.
//
// Layout padrao de teclado virtual (Android/iOS): linhas escalonadas, shift
// one-shot (toque duplo = caps lock), paginas de simbolos + acentos PT-BR,
// espaco/backspace/OK na linha de baixo e X (cancelar) no cabecalho. A
// geometria e calculada por tela (240x320 de design via UI::sx/sy; no modo
// com campo as teclas crescem ate 5/3 da largura para aproveitar telas baixas
// como a CYD landscape) e a MESMA lista de Rects desenha e faz hit-test.
//
// Otimizacoes p/ touch resistivo pequeno (CYD): tecla dispara no release na
// posicao do POUSO (o dedo deriva ao soltar), snap para a tecla mais proxima
// (gaps/beiradas nao sao zona morta), tap sem teto de tempo (pressionar firme
// digita) e backspace com auto-repeat ao segurar.
//
// Hint de layout (API 11, System.prompt/keypadOpen {hint:"num"}): setHint('n')
// abre na pagina numerica (discagem 3x3 de alvos grandes). E uma SUGESTAO, nao
// uma trava — a tecla de modo continua ("ABC"/"123") e o usuario pode trocar.
// Valores desconhecidos sao ignorados (QWERTY normal), entao firmware antigo
// degrada gracilmente quando o app pede um hint que ele nao conhece.
//
// Duas formas de usar:
//   1. Modal sincrono: kui::getString() — bloqueia com loop proprio (Canvas
//      + TouchPump) SEM tocar na pilha do Navigator, para funcionar sobre
//      telas que nao sao Kui (apps JS, telas legacy). Ao sair, quem chamou
//      redesenha a propria tela (mesmo contrato do MyKeyboard antigo).
//   2. Screen Kui: Navigator::push(new KeyboardScreen(...)) com onResult;
//      o callback recebe (texto, ok) e deve chamar Navigator::pop().
// ============================================================================

#include <functional>
#include <string>
#include "Kui.h"

namespace kui {

class KeyboardScreen : public Screen {
public:
    KeyboardScreen(const std::string& prompt, const std::string& initial = "", int maxLen = 64);

    // Disparado uma vez no OK (ok=true, texto confirmado) ou no X (ok=false,
    // texto vazio). O teclado nao tira a si mesmo da pilha — quem empilhou da
    // o pop (modo 2) ou o loop da ponte sai (modo 1).
    std::function<void(const std::string& text, bool ok)> onResult;

    // Modo acoplado (System.keypad* dos apps JS): OK nao encerra — dispara
    // onEnter com o texto, limpa o buffer e segue aberto. Mudancas no buffer
    // (tecla/backspace/espaco) disparam onChange para o app re-ecoar a linha.
    std::function<void(const std::string& text)> onEnter;
    std::function<void()> onChange;
    void setPersistent(bool p) { m_persistent = p; }

    // Teclado puro (System.keypadOpen({field:false})): sem cabecalho, campo
    // nem X — as teclas comecam no topo e o cancelamento e por keypadClose().
    void setShowField(bool s) {
        if (m_showField == s) return;
        m_showField = s;
        if (!s) m_showKeys = true;   // keypad sem campo PRECISA das teclas
        rebuild();
    }

    // Esconde a GRADE de teclas e deixa so o campo (API 62): quando ha
    // teclado fisico conectado e o ajuste kbd_keys esta desligado, o modal
    // abre assim — o usuario digita no teclado BT/USB e ve o texto no campo.
    // Nunca esconde o campo: sem grade E sem campo nao haveria como digitar.
    void setShowKeys(bool s);

    // Texto oculto (senha/PIN): campo em bullets com botao ver/ocu ao lado do
    // X. O botao so existe quando o mask esta ligado.
    void setMask(bool m) { m_mask = m; }

    // Hint de layout inicial: 'n' = pagina numerica (a tecla de modo segue
    // disponivel para voltar as letras). 0 = QWERTY normal.
    void setHint(char h);

    // Topo da area das teclas (fisico): quem acopla o teclado nao desenha
    // abaixo desta linha (System.keypadRect devolve o mesmo espaco em 240x320)
    int keysTop() const { return m_keysTop; }
    const std::string& text() const { return m_text; }

    void draw(Canvas& c) override;
    bool onTouch(const TouchEvent& ev) override;
    void onTick(uint32_t dtMs) override;
    // Cancelar e so pelo X: o swipe de borda esbarraria na coluna "q/a/z"
    bool allowsBackGesture() const override { return false; }

private:
    enum Mode { Lower, Upper, Sym1, Sym2, Accents, Num };
    enum Kind { KChar, KShift, KSymPage, KBksp, KMode, KSpace, KOk };
    struct Key {
        Rect r;
        Kind kind;
        char ch;           // KChar ASCII (rotulo e saida)
        const char* sym;   // KChar UTF-8 da pagina de acentos (NULL nos demais)
    };

    void rebuild();  // (re)calcula a geometria dos keys do modo atual
    static bool isLetters(Mode m) { return m == Lower || m == Upper; }
    void handleKey(int idx);
    void finish(bool ok);
    // teclado fisico (InputBus): drena a fila de teclas e aplica no buffer
    void pumpPhysical();
    void drainPhysical();          // descarta o que chegou antes do campo
    bool defaultShowKeys() const;  // ajuste kbd_keys + teclado fisico presente
    char labelChar(char ch) const;
    Rect fieldRect() const;
    Rect cancelRect() const;
    Rect eyeRect() const;   // botao ver/ocu (existe so com mask)
    int keyAt(int x, int y) const;  // hit-test com snap p/ tecla mais proxima
    void backspace();       // apaga 1 codepoint (UTF-8) e notifica onChange
    const char* modeLabel() const;  // rotulo da tecla de pagina (KMode)

    std::string m_prompt;
    std::string m_text;
    int m_maxLen;
    Mode m_mode = Lower;
    char m_hint = 0;               // 'n' = numerico (0 = sem hint)
    std::vector<Key> m_keys;
    bool m_persistent = false;
    bool m_showField = true;
    bool m_showKeys = true;        // false = so campo (teclado fisico)
    bool m_mask = false;
    bool m_showPlain = false;      // botao ver/ocu revela apesar do mask
    bool m_capsLock = false;       // toque duplo no shift trava o Upper
    uint32_t m_lastShiftMs = 0;    // deteccao do toque duplo no shift
    uint32_t m_repeatArmMs = 0;    // press no backspace (0 = sem auto-repeat)
    uint32_t m_nextRepeatMs = 0;
    int m_repeatCount = 0;         // repeat acelera apos as primeiras delecoes
    uint8_t m_labelFont = 2;       // rotulo das teclas (por largura fisica)
    uint8_t m_legendFont = 1;      // "space"/"?123"/"àç"
    int m_keyW = 0;                // unidade de largura (p/ o snap do keyAt)
    int m_keysTop = 0;
    int m_flashKey = -1;       // feedback visual do ultimo toque
    uint32_t m_flashMs = 0;
    // teclado fisico: Caps Lock e o estado do HOST (o report so traz o
    // evento da tecla); o repeat do backspace e nosso (o device repete o
    // mesmo report e o diff de bordas nao veria nada)
    bool m_physCaps = false;
    int m_physBksp = -1;           // usage do backspace fisico segurado
    uint32_t m_physNextMs = 0;
    int m_physRepeat = 0;
    uint32_t m_blinkMs = 0;    // cursor piscando
    bool m_cursorOn = true;
    bool m_done = false;
};

// Ponte sincrona: exibe o teclado modal e devolve o texto digitado
// (string vazia se cancelado ou confirmado vazio). hint: 'n' = numerico.
// tick (opcional) roda a cada volta do loop modal — quem chama bombeia o
// que o loop nao conhece (botoes, estados de tela, captura); devolver
// false aborta o teclado como cancelado.
// cancelled (opcional) = true quando o usuario fechou no X (ou o tick
// abortou) — distingue de "confirmou vazio".
std::string getString(const std::string& initialText, const std::string& promptMsg, int maxLen = 64,
                      bool mask = false, char hint = 0, const std::function<bool()>& tick = nullptr,
                      bool* cancelled = nullptr);

}  // namespace kui

#endif  // CELEROS_UI_KEYBOARD_H
