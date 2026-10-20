#include "JSBindings.h"
#include <string.h>
#include "../USBDevice/LogSink.h"
#include "../Kernel/Core/CelerKernel.h"
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
#include "../Display/Backlight.h"
#include "../Display/Theme.h"
#include "../Display/Icon.h"
#include "../OTA/OtaManager.h"
#include "../Launcher/LauncherUI.h"
#include "../Launcher/Screens.h"
#include <lgfx/v1/misc/DataWrapper.hpp>
#include <cstring>
#include <new>  // std::nothrow (KeyboardScreen sem abortar no heap cheio)
#include "JsInternal.h"
#include "../Hardware/Buttons.h"
#include "../Display/ScreenPower.h"
#include "../Display/ScreenCapture.h"

// =====================================================
// Keyboard Bindings
// =====================================================

// API 11: {hint:"num"} — teclado numerico (pagina Num do KeyboardScreen).
// Valor desconhecido devolve 0 (QWERTY normal): firmware antigo que ignora
// a opcao degrada igual.
static char parseHint(duk_context *ctx, duk_idx_t idx) {
    if (!duk_is_object(ctx, idx)) return 0;
    duk_get_prop_string(ctx, idx, "hint");
    char h = 0;
    if (duk_is_string(ctx, -1)) {
        const char *s = duk_get_string(ctx, -1);
        if (s != nullptr && strcmp(s, "num") == 0) h = 'n';
    }
    duk_pop(ctx);
    return h;
}

duk_ret_t JSBindings::js_prompt(duk_context *ctx) {
    const char *promptMsg = "";
    if (duk_is_string(ctx, 0)) promptMsg = duk_require_string(ctx, 0);

    const char *initialText = "";
    if (duk_is_string(ctx, 1)) initialText = duk_require_string(ctx, 1);

    // API level 7: 3o argumento opcional {mask} — senha/PIN em bullets
    bool mask = false;
    if (duk_is_object(ctx, 2)) {
        if (duk_get_prop_string(ctx, 2, "mask") && duk_is_boolean(ctx, -1)) {
            mask = duk_get_boolean(ctx, -1) != 0;
        }
        duk_pop(ctx);
    }
    char hint = parseHint(ctx, 2);  // API 11: {hint:"num"}
    // API 14: {nullOnCancel:true} — cancelar (X) devolve null em vez de ""
    // (o "" de sempre nao distingue cancelar de confirmar vazio; opt-in para
    // nao quebrar apps que fazem .length no resultado)
    bool nullOnCancel = false;
    if (duk_is_object(ctx, 2)) {
        if (duk_get_prop_string(ctx, 2, "nullOnCancel") && duk_is_boolean(ctx, -1)) {
            nullOnCancel = duk_get_boolean(ctx, -1) != 0;
        }
        duk_pop(ctx);
    }

    present();
    // Caps ANTES de construir a std::string: o prompt nao tinha teto e um
    // app hostil (texto de dezenas de KB) pagava a copia e o render O(n^2)
    // do teclado na main task. initial ja era cortado no keypadOpen; aqui
    // vale o mesmo teto do campo.
    std::string prompt;
    prompt.assign(promptMsg, strnlen(promptMsg, 64));
    std::string initial(initialText, strnlen(initialText, 256));
    // O loop modal e do kui: sem este tick, enquanto o teclado estava aberto
    // o "exit" remoto era ignorado e os botoes/estados de tela do watch e a
    // captura de tela paravam. Timers JS NAO rodam aqui (um erro de callback
    // atravessaria o loop C++ do teclado) — retomam no proximo present.
    bool exitReq = false;
    bool cancelled = false;
    std::string result = kui::getString(initial, prompt, 64, mask, hint, [&exitReq]() {
        Buttons::tick(true);
        ScreenPower::tick(true);
        ScreenCapture::service();
        if (s_appExitPending || LauncherUI::consumeAppExitRequest()) {
            exitReq = true;
            return false;
        }
        return true;
    }, &cancelled);
    // o teclado desenhou direto no display: o proximo present repoe o app
    s_frameDirty = true;
    // A digitacao dura a vontade do usuario: a janela do exec-timeout
    // (aberta pelo present() acima) chega vencida aqui e o RangeError
    // matava o app assim que o script retomava
    CelerKernel::noteAppYield();
    if (exitReq) throwAppExit(ctx);

    if (cancelled && nullOnCancel) {
        duk_push_null(ctx);
        return 1;
    }
    duk_push_string(ctx, result.c_str());

    return 1;
}

// =====================================================
// Keyboard acoplado (API level 5) — sessao NAO-bloqueante
//
// O app abre o teclado (keypadOpen), bombeia com keypadPoll no proprio loop
// e desenha em volta: o teclado vai no MESMO alvo do app (gfx(): sprite do
// app > quadro PSRAM > display) e sobrevive ao present(). Eventos chegam um
// por poll: change (buffer mudou), enter (OK: texto em ev.text) e cancel
// (X — encerra a sessao sozinho). O canto de saida do OS segue valendo.
// =====================================================

static kui::KeyboardScreen *s_kb = nullptr;
static kui::TouchPump s_kbPump;
static uint32_t s_kbLastPollMs = 0;
enum KbEvent { KB_EV_NONE = 0, KB_EV_CHANGE, KB_EV_ENTER, KB_EV_CANCEL };
static int s_kbEvent = KB_EV_NONE;
static std::string s_kbEnterText;

void keypadCloseSession() {
    if (s_kb) {
        delete s_kb;
        s_kb = nullptr;
    }
    s_kbEvent = KB_EV_NONE;
    s_kbEnterText.clear();
    s_kbPump.reset();  // dedo preso na sessao encerrada nao vira Release fantasma
    s_frameDirty = true;  // proximo present restaura o frame do app
}

duk_ret_t JSBindings::js_keypadOpen(duk_context *ctx) {
    if (!tftInstance) {
        duk_push_false(ctx);
        return 1;
    }
    if (s_kb) {  // so uma sessao por vez
        duk_push_false(ctx);
        return 1;
    }

    std::string title, initial;
    int maxLen = 64;
    bool field = true;
    bool mask = false;
    char hint = 0;
    if (duk_is_object(ctx, 0)) {
        if (duk_get_prop_string(ctx, 0, "title") && duk_is_string(ctx, -1)) title = duk_get_string(ctx, -1);
        duk_pop(ctx);
        if (duk_get_prop_string(ctx, 0, "initial") && duk_is_string(ctx, -1)) initial = duk_get_string(ctx, -1);
        duk_pop(ctx);
        if (duk_get_prop_string(ctx, 0, "maxLen") && duk_is_number(ctx, -1)) maxLen = duk_get_int(ctx, -1);
        duk_pop(ctx);
        if (duk_get_prop_string(ctx, 0, "field") && duk_is_boolean(ctx, -1)) field = duk_get_boolean(ctx, -1) != 0;
        duk_pop(ctx);
        if (duk_get_prop_string(ctx, 0, "mask") && duk_is_boolean(ctx, -1)) mask = duk_get_boolean(ctx, -1) != 0;
        duk_pop(ctx);
        hint = parseHint(ctx, 0);  // API 11
    }
    if (maxLen < 1) maxLen = 1;

    present();
    // Textos do app hostil: o titulo so cabe numa linha e o inicial tem o
    // teto do proprio campo (o KeyboardScreen clampa o maxLen em 256 mas
    // NAO corta o initial recebido). Sem os cortes, um app derrubava o
    // aparelho nas copias para std::string (sem excecoes) com o heap cheio.
    if (title.size() > 64) title.resize(64);
    if (initial.size() > 256) initial.resize(256);
    s_kb = new (std::nothrow) kui::KeyboardScreen(title, initial, maxLen);
    if (s_kb == nullptr) {  // sem RAM: false (o app segue sem teclado)
        duk_push_false(ctx);
        return 1;
    }
    s_kb->setPersistent(true);
    s_kb->setShowField(field);
    s_kb->setMask(mask);
    s_kb->setHint(hint);
    s_kb->onChange = [] { s_kbEvent = KB_EV_CHANGE; };
    s_kb->onEnter = [](const std::string& t) {
        s_kbEnterText = t;
        s_kbEvent = KB_EV_ENTER;
    };
    s_kb->onResult = [](const std::string&, bool ok) {
        if (!ok) s_kbEvent = KB_EV_CANCEL;  // X (so existe com field)
    };
    s_kbEvent = KB_EV_NONE;
    s_kbEnterText.clear();
    s_kbLastPollMs = millis();

    {
        GfxStateGuard guard(*JSBindings::gfx());  // cor/datum do app intactos
        kui::Canvas c(*tftInstance, JSBindings::gfx());
        s_kb->draw(c);
    }
    duk_push_boolean(ctx, true);
    return 1;
}

duk_ret_t JSBindings::js_keypadPoll(duk_context *ctx) {
    checkRemoteAppExit(ctx);  // shell "exit": encerra mesmo sem teclado aberto
    if (!s_kb || !tftInstance) {
        duk_push_null(ctx);
        return 1;
    }
    present();
    // present() roda os timers do app: um timer pode chamar
    // System.keypadClose() e deletar s_kb. A checagem acima e anterior ao
    // present; sem re-checar, o poll seguinte desreferenciava ponteiro nulo.
    if (!s_kb) {
        duk_push_null(ctx);
        return 1;
    }

    uint16_t tx = 0, ty = 0;
    // pollAppChrome SEMPRE roda: o disparo da saida e no release (readTouch
    // false) — dentro de um if(readTouch) o release nunca seria visto e o X
    // acendia sem sair (bug do Terminal)
    bool touched = kui::readTouch(&tx, &ty);
    if (pollAppChrome(touched, tx, ty)) {
        keypadCloseSession();
        throwAppExit(ctx);  // nao retorna
    }

    s_kbEvent = KB_EV_NONE;
    s_kbPump.poll([](const kui::TouchEvent& ev) {
        s_kb->onTouch(ev);
        if (ev.type != kui::TouchEvent::Drag) s_kb->markDirty();  // tecla "afunda"
    });
    uint32_t now = millis();
    uint32_t dt = now - s_kbLastPollMs;
    if (dt > 100) dt = 100;
    s_kbLastPollMs = now;
    s_kb->onTick(dt);
    if (s_kb->consumeDirty()) {
        GfxStateGuard guard(*JSBindings::gfx());  // cor/datum do app intactos
        kui::Canvas c(*tftInstance, JSBindings::gfx());
        s_kb->draw(c);
    }

    if (s_kbEvent == KB_EV_NONE) {
        duk_push_null(ctx);
        return 1;
    }

    duk_push_object(ctx);
    if (s_kbEvent == KB_EV_ENTER) {
        putStr(ctx, "type", "enter");
        putStr(ctx, "text", s_kbEnterText.c_str());
        s_kbEnterText.clear();
    } else if (s_kbEvent == KB_EV_CHANGE) {
        putStr(ctx, "type", "change");
    } else {  // cancel: o X encerrou a sessao
        putStr(ctx, "type", "cancel");
        keypadCloseSession();
    }
    return 1;
}

duk_ret_t JSBindings::js_keypadText(duk_context *ctx) {
    duk_push_string(ctx, s_kb ? s_kb->text().c_str() : "");
    return 1;
}

duk_ret_t JSBindings::js_keypadRect(duk_context *ctx) {
    // Area das teclas no espaco virtual 240x320; fechado: faixa nula no rodape.
    // O espaco do app comeca abaixo da topbar do sistema.
    int topV = 320;
    if (s_kb && tftInstance) {
        int offY = s_topbarFixed ? UI::topbarH() : 0;
        int appH = tftInstance->height() - offY;
        if (appH < 1) appH = 1;
        topV = (int)(((long)s_kb->keysTop() - offY) * 320 / appH);
        if (topV < 0) topV = 0;
        if (topV > 320) topV = 320;
    }
    duk_push_object(ctx);
    putInt(ctx, "x", 0);
    putInt(ctx, "y", topV);
    putInt(ctx, "w", 240);
    putInt(ctx, "h", 320 - topV);
    return 1;
}

duk_ret_t JSBindings::js_keypadDraw(duk_context *ctx) {
    // App redesenhou a tela: repoe o teclado por cima (mesmo alvo do app)
    if (s_kb && tftInstance) {
        GfxStateGuard guard(*JSBindings::gfx());  // cor/datum do app intactos
        kui::Canvas c(*tftInstance, JSBindings::gfx());
        s_kb->draw(c);
    }
    return 0;
}

duk_ret_t JSBindings::js_keypadClose(duk_context *ctx) {
    keypadCloseSession();
    return 0;
}

