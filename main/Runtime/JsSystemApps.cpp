#include "JSBindings.h"
#include <algorithm>
#include <stdio.h>
#include <string.h>
#include "../Kernel/Alarms.h"
#include "../Kernel/Notifications.h"
#include "../Kernel/Core/CelerKernel.h"
#include "../Hardware/MusicSynth.h"
#include "../USBDevice/LogSink.h"
#include "../Display/Layout.h"
#include "../FileSystem/FileSystem.h"
#include "../UI/Keyboard.h"
#include "../WebManager/WebManager.h"
#include "../WebManager/WebAuth.h"
#include "../Kernel/TimeManager.h"
#include "../Utils/StrUtils.h"
#include "../Utils/PinStore.h"
#include "../Utils/CelerSettings.h"
#include "esp_sleep.h"
#include "esp_task_wdt.h"
#include "../Hardware/BoardIO.h"
#include "../Hardware/AudioPlayer.h"
#include "../UI/Kui.h"
#include "driver/gpio.h"
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
#include "JsInternal.h"
#include "JsFsJail.h"
#include "../Boards/Board.h"
#include "../Kernel/AppRunner.h"

// =====================================================
// System nivel 3 — suporte aos apps de sistema em JS (W8)
// =====================================================

// Brilho/volume/auto/tempo de tela sao config GLOBAL: so app "system"
// (Settings) grava na NVS. Os demais mudam ao vivo e o appExitCleanup
// devolve o valor do lancamento — antes um fade de brilho gravava a NVS a
// cada frame e o nivel do jogo virava o do aparelho.
extern bool s_hwTouched;
static bool hwPersist() {
    const bool sys = perm(celer::PERM_SYSTEM);
    if (!sys) s_hwTouched = true;
    return sys;
}

duk_ret_t JSBindings::js_setBrightness(duk_context *ctx) {
    int v = duk_require_int(ctx, 0);
    Backlight::set(v, hwPersist());
    return 0;
}

duk_ret_t JSBindings::js_getBrightness(duk_context *ctx) {
    duk_push_int(ctx, Backlight::get());
    return 1;
}

// Volume do audio (API 13): I2S escala digital + registrador do codec
// (ES8311 do watch); buzzer LEDC e ganho fixo (so persiste o valor).
duk_ret_t JSBindings::js_setVolume(duk_context *ctx) {
    int v = duk_require_int(ctx, 0);
    BoardIO::setVolumePct(v, hwPersist());
    return 0;
}

duk_ret_t JSBindings::js_getVolume(duk_context *ctx) {
    duk_push_int(ctx, BoardIO::volumePct());
    return 1;
}

// System.setAutoBrightness(bool) -> bool (false sem sensor de luz)
duk_ret_t JSBindings::js_setAutoBrightness(duk_context *ctx) {
    bool on = duk_to_boolean(ctx, 0);
    Backlight::setAuto(on, hwPersist());
    duk_push_boolean(ctx, Backlight::isAuto() == on ? 1 : 0);
    return 1;
}

// System.getAutoBrightness() -> true | false | null (null = placa sem sensor)
duk_ret_t JSBindings::js_getAutoBrightness(duk_context *ctx) {
    if (!Backlight::autoSupported()) { duk_push_null(ctx); return 1; }
    duk_push_boolean(ctx, Backlight::isAuto() ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_backlightSupported(duk_context *ctx) {
    duk_push_boolean(ctx, Backlight::isSupported() ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_openWifiSetup(duk_context *ctx) {
    present();  // chamada bloqueante: o que o app desenhou aparece antes
#if CONFIG_CELEROS_UI
    // Empilha a tela nativa de WiFi. Como o app JS roda sincrono, a tela
    // so entra em cena quando o script devolver o controle ao loop do Kui
    // (o app deve chamar System.exitApp() logo em seguida).
    // App em task propria (CELEROS_APP_TASK): empilhar agora pintaria a
    // tela nativa POR CIMA do app vivo — o pedido e atendido pelo
    // AppHostScreen::finishApp quando o app sai (task da UI).
    if (AppRunner::running()) AppRunner::requestWifiSetup();
    else kui::Navigator::push(WifiSetupScreen::instance());
#else
    // Sem vidro nao ha tela de setup: o caminho headless e o celerctl
    // (celerctl wifi ...), como no devkit barebone.
    celer_log_println("[wifi] setup pedido sem vidro: use celerctl wifi");
#endif
    return 0;
}

#if CONFIG_CELEROS_UI
duk_ret_t JSBindings::js_setClip(duk_context *ctx) {
    // Recorte no canvas virtual: desenho fora de (x,y,w,h) e descartado
    const int x = jsx(duk_require_int(ctx, 0)), y = jsy(duk_require_int(ctx, 1));
    const int w = jsx(duk_require_int(ctx, 2)), h = jsH(duk_require_int(ctx, 3));
    if (gfx() == tftInstance) {
        // direto no display: intersecta com o recorte da faixa do sistema
        setAppDisplayClip(true, x, y, w, h);
        return 0;
    }
    gfx()->setClipRect(x, y, w, h);
    return 0;
}

duk_ret_t JSBindings::js_clearClip(duk_context *ctx) {
    (void)ctx;
    if (gfx() == tftInstance) {
        setAppDisplayClip(false, 0, 0, 0, 0);  // o recorte da faixa continua
        return 0;
    }
    gfx()->clearClipRect();
    return 0;
}
#endif  // CONFIG_CELEROS_UI

duk_ret_t JSBindings::js_present(duk_context *ctx) {
    // Apresentacao explicita do quadro (animacoes/loops sem delay/getTouch)
    (void)ctx;
    present();
    return 0;
}

duk_ret_t JSBindings::js_isBuffered(duk_context *ctx) {
    duk_push_boolean(ctx, s_frame != nullptr ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_exitApp(duk_context *ctx) {
    // Mesmo protocolo do X da topbar: erro MARCADO (celerExit). O antigo
    // duk_error("OS_EXIT") criava um Error sem a marca — o kernel so aceita
    // o marcado ou a string crua "OS_EXIT", entao exitApp caia na tela de
    // "Erro no app".
    throwAppExit(ctx);
}

duk_ret_t JSBindings::js_launchApp(duk_context *ctx) {
    // API 16: abre outro app pelo packageName (ou caminho/nome da pasta) e
    // sai pela mesma porta do X: o launcher consome o pedido no tick seguinte
    // a saida. O consentimento de permissoes do app de destino segue valendo.
    const char* target = duk_require_string(ctx, 0);
    if (!*target) duk_error(ctx, DUK_ERR_TYPE_ERROR, "launchApp: alvo vazio");
    if (s_appExitPending) return 0;  // saida ja armada: nao empilha outro pedido
    LauncherUI::requestLaunch(target);
    throwAppExit(ctx);
    return 0;
}

duk_ret_t JSBindings::js_wifiStatus(duk_context *ctx) {
    duk_push_object(ctx);
    putBool(ctx, "connected", WebManager::isActive());
    putStr(ctx, "ip", WebManager::getIPAddress().c_str());
    putBool(ctx, "webServer", WebManager::isServerRunning());
    putBool(ctx, "savedNetworks", WebManager::hasSavedNetworks());
    return 1;
}

duk_ret_t JSBindings::js_md5(duk_context *ctx) {
    // Mesmo formato do FileSystem::getFileMD5 (hex minusculo) — o PIN do
    // Settings JS tem que bater com o arquivo legado settings_pin.txt.
    const char* s = duk_require_string(ctx, 0);
    md5_context_t c;
    esp_rom_md5_init(&c);
    esp_rom_md5_update(&c, s, (uint32_t)strlen(s));
    uint8_t hash[16];
    esp_rom_md5_final(hash, &c);

    char hex[33];
    for (int i = 0; i < 16; i++) sprintf(hex + i * 2, "%02x", hash[i]);
    hex[32] = 0;
    duk_push_string(ctx, hex);
    return 1;
}

// ---- PIN do Settings (nativo, com salt) -----------------------------------
// Substitui o fluxo JS antigo (md5 em settings_pin.txt): qualquer app podia
// ler o hash e apagar o arquivo para destravar o Settings. O estado mora no
// nativo (PinStore: settings_pin2.bin + flag NVS) e nao ha hash exposto.

duk_ret_t JSBindings::js_setPin(duk_context *ctx) {
    const char* pin = duk_require_string(ctx, 0);
    duk_push_boolean(ctx, PinStore::set(pin) ? 1 : 0);
    return 1;
}

// Forca bruta: o PIN tem 4-6 digitos (10^4 tentativas no pior caso). Depois
// de 5 erros seguidos, cada tentativa espera um castigo que dobra (30s, 60s,
// ... ate 15 min) — antes um loop JS testava todos em segundos. Estado em
// RAM (reboot zera, mas reboot custa ~3s por rodada de 5).
static uint8_t s_pinFails = 0;
static uint32_t s_pinLockUntil = 0;

duk_ret_t JSBindings::js_verifyPin(duk_context *ctx) {
    const char* pin = duk_require_string(ctx, 0);
    if (s_pinLockUntil != 0 && (int32_t)(millis() - s_pinLockUntil) < 0) {
        duk_push_boolean(ctx, 0);  // bloqueado: nem confere
        return 1;
    }
    bool ok = PinStore::verify(pin);
    if (ok) {
        s_pinFails = 0;
        s_pinLockUntil = 0;
    } else if (++s_pinFails >= 5) {
        uint32_t shift = s_pinFails - 5;
        uint32_t penalty = 30000u << (shift > 5 ? 5 : shift);
        if (penalty > 900000u) penalty = 900000u;
        s_pinLockUntil = millis() + penalty;
        if (s_pinLockUntil == 0) s_pinLockUntil = 1;
    }
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_pinClear(duk_context *ctx) {
    PinStore::clear();
    return 0;
}

duk_ret_t JSBindings::js_pinState(duk_context *ctx) {
    // 0 = sem PIN, 1 = ativo, 2 = corrompido (flag NVS sem arquivo)
    duk_push_int(ctx, PinStore::state());
    return 1;
}

// ---- senha do Web Server ---------------------------------------------------

duk_ret_t JSBindings::js_webAuthInfo(duk_context *ctx) {
    duk_push_object(ctx);
    putStr(ctx, "user", "admin");
    putStr(ctx, "pass", WebAuth::password());
    return 1;
}

duk_ret_t JSBindings::js_webAuthSetPass(duk_context *ctx) {
    const char* p = duk_require_string(ctx, 0);
    duk_push_boolean(ctx, WebAuth::setPassword(p) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_rescanApps(duk_context *ctx) {
    LauncherUI::requestRescan();
    return 0;
}

duk_ret_t JSBindings::js_factoryReset(duk_context *ctx) {
    present();  // chamada bloqueante: o que o app desenhou aparece antes
    const char* mode = duk_is_string(ctx, 0) ? duk_require_string(ctx, 0) : "configs";

    if (strcmp(mode, "total") == 0) {
        // LittleFS inteiro (apps + icones + configs). Recuperacao exige
        // reflashe de data/ (tools/flash_data.sh) ou celerctl apps install.
        WebManager::forgetAllNetworks();
        FileSystem::formatLittleFS();
        PinStore::clear();     // flag NVS nao vive no LittleFS
        CelerSettings::eraseAll();  // idem: configs NVS nao sobrevivem ao total
        WebAuth::regenerate();
        duk_push_boolean(ctx, 1);
        return 1;
    }

    // "configs": zera configuracoes e credenciais, preserva apps/icones
    const char* cfgFiles[] = {
        "/local/brightness.txt", "/local/settings_pin.txt", "/local/nowifi.txt",
        "/local/web_on.txt", "/local/config_install_sd.txt", "/local/ota_url.txt",
        "/local/config_time.txt", "/local/touch_cal_p.bin", "/local/wifi.txt",
        "/local/settings_pin2.bin", "/local/ota_allow_http.txt",
    };
    for (const char* f : cfgFiles) FileSystem::deleteFile(f);
    CelerSettings::eraseAll();  // configs vivem no NVS desde a F3: o reset
                                // tinha ficado pela metade (brilho/web_on
                                // sobreviviam ao factoryReset "configs")
    PinStore::clear();        // limpa tambem a flag NVS do PIN
    WebAuth::regenerate();    // senha web nova (a antiga era "config")
    WebManager::forgetAllNetworks();
    duk_push_boolean(ctx, 1);
    return 1;
}

duk_ret_t JSBindings::js_otaCheck(duk_context *ctx) {
    present();  // chamada bloqueante: o que o app desenhou aparece antes
    OtaManager::checkForUpdates();
    CelerKernel::noteAppYield();  // fetch HTTPS do update.json passa de 1s
    const OtaUpdateInfo& info = OtaManager::info;
    duk_push_object(ctx);
    putBool(ctx, "fetchFailed", info.fetchFailed);
    putBool(ctx, "available", info.available);
    putBool(ctx, "hasFirmware", info.hasFirmware);
    putInt(ctx, "apiVersion", info.apiVersion);
    putStr(ctx, "version", info.version.c_str());
    putStr(ctx, "url", info.firmwareUrl.c_str());
    putStr(ctx, "changelog", info.changelog.c_str());
    putStr(ctx, "guide", info.guide.c_str());
    putStr(ctx, "type", info.type.c_str());
    return 1;
}

// performUpdate roda na mesma task do script e invoca onProgress de dentro
// do loop de flash: reentrar no Duktape pelo stash e seguro.
static duk_context* s_otaCtx = nullptr;
static void otaProgressTrampoline(int percent) {
    if (!s_otaCtx) return;
    duk_push_global_stash(s_otaCtx);
    duk_get_prop_string(s_otaCtx, -1, "_otaCb");
    if (duk_is_function(s_otaCtx, -1)) {
        duk_push_int(s_otaCtx, percent);
        duk_pcall(s_otaCtx, 1);
    }
    duk_pop_2(s_otaCtx);
    // present() roda os timers e o erro de um callback PROPAGA (longjmp):
    // aqui ele atravessaria o performUpdate no meio do flash (handle de OTA
    // e cliente HTTP abertos). Protegido: erro de timer e descartado.
    duk_safe_call(s_otaCtx, [](duk_context*, void*) -> duk_ret_t {
        JSBindings::present();
        return 0;
    }, nullptr, 0, 1);
    duk_pop(s_otaCtx);
}

duk_ret_t JSBindings::js_otaStart(duk_context *ctx) {
    present();  // chamada bloqueante: o que o app desenhou aparece antes
    const char* url = duk_require_string(ctx, 0);
    bool hasCb = duk_is_function(ctx, 1) ? true : false;

    if (hasCb) {
        duk_push_global_stash(ctx);
        duk_dup(ctx, 1);
        duk_put_prop_string(ctx, -2, "_otaCb");
        duk_pop(ctx);
        s_otaCtx = ctx;
    }

    bool ok = OtaManager::performUpdate(url, hasCb ? otaProgressTrampoline : nullptr);
    CelerKernel::noteAppYield();  // flash demora; o trampoline so cobre com callback

    if (hasCb) {
        duk_push_global_stash(ctx);
        duk_push_undefined(ctx);
        duk_put_prop_string(ctx, -2, "_otaCb");
        duk_pop(ctx);
        s_otaCtx = nullptr;
    }

    duk_push_object(ctx);
    putBool(ctx, "ok", ok);
    if (!ok) {
        putStr(ctx, "error", OtaManager::lastError.c_str());
    }
    return 1;
}

duk_ret_t JSBindings::js_setTimezone(duk_context *ctx) {
    // TZ POSIX ("<-03>3", "UTC-5"...): o config_time.txt separa campos por
    // '|' — um fuso com '|' ou quebra de linha corrompia a leitura no boot
    duk_push_boolean(ctx, TimeManager::setTimezone(duk_require_string(ctx, 0)) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_setManualTime(duk_context *ctx) {
    // false = campo fora da faixa (antes o mktime "normalizava" lixo)
    duk_push_boolean(ctx, TimeManager::setManualTime(duk_require_int(ctx, 0), duk_require_int(ctx, 1),
                                                     duk_require_int(ctx, 2), duk_require_int(ctx, 3),
                                                     duk_require_int(ctx, 4)) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_set24hFormat(duk_context *ctx) {
    TimeManager::setTimeFormat(duk_require_boolean(ctx, 0) ? true : false);
    return 0;
}

duk_ret_t JSBindings::js_get24hFormat(duk_context *ctx) {
    duk_push_boolean(ctx, TimeManager::use24hFormat ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_setNtpEnabled(duk_context *ctx) {
    TimeManager::setNTPEnabled(duk_require_boolean(ctx, 0) ? true : false);
    return 0;
}

duk_ret_t JSBindings::js_getNtpEnabled(duk_context *ctx) {
    duk_push_boolean(ctx, TimeManager::ntpEnabled ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_webActive(duk_context *ctx) {
    duk_push_boolean(ctx, WebManager::isServerRunning() ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_webSetActive(duk_context *ctx) {
    // Toggle do servidor web (persiste na flag NVS web_on e age ao vivo),
    // igual a tela C++ original — mas sem reboot. NAO desliga o WiFi (isso
    // e o nowifi / WebManager::disable). Antes gravava o /local/web_on.txt
    // legado: o boot decide pelo NVS, entao desligar nao sobrevivia ao
    // reboot (a migracao one-shot consumia o arquivo e o NVS "1" vencia).
    if (duk_require_boolean(ctx, 0)) {
        CelerSettings::set("web_on", "1");
        if (WebManager::isActive()) WebManager::startWebServerIfNeeded();
    } else {
        CelerSettings::set("web_on", "");  // valor vazio apaga a key
        WebManager::stopWebServer();
    }
    return 0;
}

// --- Net nivel 3 (WiFi) ---

duk_ret_t JSBindings::js_wifiScan(duk_context *ctx) {
    present();  // chamada bloqueante: o que o app desenhou aparece antes
    // Scan bloqueante (~2s) — mesmo comportamento da tela nativa.
    CelerScanEntry entries[20];
    int n = WebManager::scanNetworks(entries, 20);
    CelerKernel::noteAppYield();  // espera >1s: renova a janela p/ o retorno

    duk_push_array(ctx);
    for (int i = 0; i < n; i++) {
        duk_push_object(ctx);
        putStr(ctx, "ssid", entries[i].ssid.c_str());
        putInt(ctx, "rssi", entries[i].rssi);
        putBool(ctx, "secure", entries[i].secure);
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)i);
    }
    return 1;
}

duk_ret_t JSBindings::js_wifiConnect(duk_context *ctx) {
    present();  // chamada bloqueante: o que o app desenhou aparece antes
    const char* ssid = duk_require_string(ctx, 0);
    const char* pass = duk_is_string(ctx, 1) ? duk_require_string(ctx, 1) : "";
    bool ok = WebManager::connect(ssid, pass);
    CelerKernel::noteAppYield();  // connect espera ate 15s
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_wifiDisconnect(duk_context *ctx) {
    WebManager::disconnect();
    return 0;
}


// ---- Energia/tela e alarme (API 12) ----

// System.setScreenTimeout(ms): 0 = nunca apagar (default). O primeiro toque
// depois de apagado so acorda (e e consumido).
duk_ret_t JSBindings::js_setScreenTimeout(duk_context *ctx) {
    uint32_t ms = duk_require_uint(ctx, 0);
    Backlight::setIdleTimeout(ms, hwPersist());
    return 0;
}

duk_ret_t JSBindings::js_screenTimeout(duk_context *ctx) {
    duk_push_uint(ctx, Backlight::idleTimeout());
    return 1;
}

// System.deepSleep(ms[, wakePin]): dorme DE VERDADE (reboot ao acordar —
// apps nao sobrevivem). Timer sempre armado; wakePin opcional acorda com
// nivel ALTO (touch INT, botao...). Requer "system": derruba o aparelho.
duk_ret_t JSBindings::js_deepSleep(duk_context *ctx) {
    uint32_t ms = duk_require_uint(ctx, 0);
    if (ms == 0) {
        duk_error(ctx, DUK_ERR_RANGE_ERROR, "deepSleep: ms deve ser > 0");
    }
    present();  // ultimo frame e despedida visiveis
    // Mesmo ritual do ScreenPower::deepSleepNow: painel desligado, estado
    // da placa persistido (passos no NVS, IMU fora), radio desligado e a
    // sentinela ULP armada — a tecla PWR do watch acorda tambem daqui.
    const BoardProfile& bp = Board::profile();
    if (bp.screenSleep != nullptr) bp.screenSleep();
    if (bp.sleepPrep != nullptr) bp.sleepPrep();
    BoardIO::speakerChannelDown();  // canal TX do amp: dorme com pinos em nivel baixo
    esp_wifi_stop();
    if (bp.ulpArm != nullptr) bp.ulpArm();
    if (duk_is_number(ctx, 1)) {
        int pin = duk_require_int(ctx, 1);
        if (pin >= 0) {
            // ext0 (nivel alto): disponivel no ESP32 classico e no S3
            esp_sleep_enable_ext0_wakeup((gpio_num_t)pin, 1);
        }
    }
    esp_sleep_enable_timer_wakeup((uint64_t)ms * 1000ULL);
    esp_deep_sleep_start();
    return 0;  // nunca chega (reboot ao acordar)
}

duk_ret_t JSBindings::js_setAlarm(duk_context *ctx) {
    int h = duk_require_int(ctx, 0);
    int m = duk_require_int(ctx, 1);
    const char* msg = duk_is_string(ctx, 2) ? duk_require_string(ctx, 2) : "";
    duk_push_boolean(ctx, TimeManager::setAlarm(h, m, msg) ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_clearAlarm(duk_context *ctx) {
    (void)ctx;
    TimeManager::clearAlarm();
    return 0;
}

duk_ret_t JSBindings::js_getAlarm(duk_context *ctx) {
    // Objeto montado direto: o JSON de buffer fixo (96 B) cortava mensagens
    // longas no meio e o duk_json_decode lancava SyntaxError
    int h = 0, m = 0;
    std::string msg;
    if (!TimeManager::getAlarm(h, m, msg)) { duk_push_null(ctx); return 1; }
    duk_push_object(ctx);
    putBool(ctx, "armed", 1);
    putInt(ctx, "hour", h);
    putInt(ctx, "minute", m);
    putLStr(ctx, "msg", msg.data(), msg.size());
    return 1;
}

// ---- Alarmes multiplos + timer (API 15, Kernel/Alarms) ----

// {hour, minute, days?, enabled?, label?} -> AlarmSpec; erro de tipo se faltar hora
static celer::AlarmSpec alarmFromObj(duk_context* ctx, duk_idx_t idx) {
    if (!duk_is_object(ctx, idx)) duk_error(ctx, DUK_ERR_TYPE_ERROR, "alarme: esperado objeto");
    celer::AlarmSpec a;
    duk_get_prop_string(ctx, idx, "hour");
    a.hour = duk_is_number(ctx, -1) ? duk_get_int(ctx, -1) : -1;
    duk_pop(ctx);
    duk_get_prop_string(ctx, idx, "minute");
    a.minute = duk_is_number(ctx, -1) ? duk_get_int(ctx, -1) : -1;
    duk_pop(ctx);
    duk_get_prop_string(ctx, idx, "days");
    a.days = duk_is_number(ctx, -1) ? (uint8_t)(duk_get_int(ctx, -1) & 0x7F) : 0;
    duk_pop(ctx);
    duk_get_prop_string(ctx, idx, "enabled");
    a.enabled = duk_is_undefined(ctx, -1) ? true : duk_to_boolean(ctx, -1);
    duk_pop(ctx);
    duk_get_prop_string(ctx, idx, "label");
    if (duk_is_string(ctx, -1)) a.label = duk_get_string(ctx, -1);
    duk_pop(ctx);
    return a;
}

// System.alarms() -> [{id, hour, minute, days, enabled, label, next}]
// next = epoch (s) do proximo toque, 0 desligado/hora invalida
duk_ret_t JSBindings::js_alarms(duk_context *ctx) {
    duk_idx_t arr = duk_push_array(ctx);
    duk_uarridx_t n = 0;
    time_t now;
    time(&now);
    for (int i = 0; i < Alarms::MAX; i++) {
        celer::AlarmSpec a;
        if (!Alarms::get(i, a)) continue;
        duk_push_object(ctx);
        putInt(ctx, "id", i);
        putInt(ctx, "hour", a.hour);
        putInt(ctx, "minute", a.minute);
        putInt(ctx, "days", a.days);
        putBool(ctx, "enabled", a.enabled);
        putLStr(ctx, "label", a.label.data(), a.label.size());
        time_t next = (a.enabled && TimeManager::isTimeValid()) ? celer::nextAlarmAfter(a, now) : 0;
        putNum(ctx, "next", (double)next);
        duk_put_prop_index(ctx, arr, n++);
    }
    return 1;
}

// System.addAlarm({hour, minute, days, label}) -> id ou -1 (cheio/invalido)
duk_ret_t JSBindings::js_addAlarm(duk_context *ctx) {
    duk_push_int(ctx, Alarms::add(alarmFromObj(ctx, 0)));
    return 1;
}

// System.updateAlarm(id, {...}) -> bool
duk_ret_t JSBindings::js_updateAlarm(duk_context *ctx) {
    int id = duk_require_int(ctx, 0);
    duk_push_boolean(ctx, Alarms::set(id, alarmFromObj(ctx, 1)));
    return 1;
}

// System.removeAlarm(id) -> bool
duk_ret_t JSBindings::js_removeAlarm(duk_context *ctx) {
    duk_push_boolean(ctx, Alarms::remove(duk_require_int(ctx, 0)));
    return 1;
}

// System.setTimer(segundos, rotulo?) -> bool (1..86400; substitui o atual)
duk_ret_t JSBindings::js_setTimer(duk_context *ctx) {
    int sec = duk_require_int(ctx, 0);
    const char* lbl = duk_is_string(ctx, 1) ? duk_get_string(ctx, 1) : "";
    duk_push_boolean(ctx, sec > 0 && Alarms::setTimer((uint32_t)sec, lbl));
    return 1;
}

// System.getTimer() -> {remaining, label} ou null
duk_ret_t JSBindings::js_getTimer(duk_context *ctx) {
    std::string lbl;
    int32_t rem = Alarms::timerRemaining(&lbl);
    if (rem < 0) {
        duk_push_null(ctx);
        return 1;
    }
    duk_push_object(ctx);
    putInt(ctx, "remaining", rem);
    putLStr(ctx, "label", lbl.data(), lbl.size());
    return 1;
}

duk_ret_t JSBindings::js_cancelTimer(duk_context *ctx) {
    (void)ctx;
    Alarms::cancelTimer();
    return 0;
}

// ---- Audio em sequencia e notificacoes (API 12) ----

// System.playTone([[freq,ms],...]): melodia bloqueante — cada nota toca no
// hardware (LEDC/I2S do beep) com o watchdog alimentado entre notas. Pares
// como array-de-arrays ou plano [f,ms,f,ms]; max 64 notas / 15 s no total.
duk_ret_t JSBindings::js_playTone(duk_context *ctx) {
    if (!duk_is_array(ctx, 0)) {
        duk_error(ctx, DUK_ERR_TYPE_ERROR, "playTone: esperado array [freq,ms,...]");
    }
    present();  // bloqueante: o que o app desenhou aparece antes

    duk_size_t n = duk_get_length(ctx, 0);
    bool flat = false;
    if (n > 0) {
        duk_get_prop_index(ctx, 0, 0);
        flat = duk_is_number(ctx, -1);
        duk_pop(ctx);
    }
    int notes = flat ? (int)n / 2 : (int)n;
    if (notes < 1 || notes > 64) {
        duk_error(ctx, DUK_ERR_RANGE_ERROR, "playTone: 1 a 64 notas");
    }

    int total = 0;
    int played = 0;
    for (int i = 0; i < notes; i++) {
        int f, ms;
        if (flat) {
            duk_get_prop_index(ctx, 0, i * 2); f = duk_require_int(ctx, -1); duk_pop(ctx);
            duk_get_prop_index(ctx, 0, i * 2 + 1); ms = duk_require_int(ctx, -1); duk_pop(ctx);
        } else {
            duk_get_prop_index(ctx, 0, i);
            if (!duk_is_array(ctx, -1)) {
                duk_pop(ctx);
                char msg[64];  // pre-formatado: duk_error com %d em lightfunc corrompe o heap
                snprintf(msg, sizeof(msg), "playTone: nota %d nao e [freq,ms]", i);
                duk_error(ctx, DUK_ERR_TYPE_ERROR, msg);
            }
            duk_get_prop_index(ctx, -1, 0); f = duk_require_int(ctx, -1); duk_pop(ctx);
            duk_get_prop_index(ctx, -1, 1); ms = duk_require_int(ctx, -1); duk_pop(ctx);
            duk_pop(ctx);
        }
        if (f < 20 || f > 20000 || ms <= 0 || ms > 2000) {
            char msg[96];  // pre-formatado: duk_error com %d em lightfunc corrompe o heap
            snprintf(msg, sizeof(msg), "playTone: nota %d fora da faixa (20-20kHz, 1-2000ms)", i);
            duk_error(ctx, DUK_ERR_RANGE_ERROR, msg);
        }
        total += ms;
        if (total > 15000) {
            duk_error(ctx, DUK_ERR_RANGE_ERROR, "playTone: maximo 15s no total");
        }
    }
    for (int i = 0; i < notes; i++) {
        int f, ms;
        if (flat) {
            duk_get_prop_index(ctx, 0, i * 2); f = duk_require_int(ctx, -1); duk_pop(ctx);
            duk_get_prop_index(ctx, 0, i * 2 + 1); ms = duk_require_int(ctx, -1); duk_pop(ctx);
        } else {
            duk_get_prop_index(ctx, 0, i);
            duk_get_prop_index(ctx, -1, 0); f = duk_require_int(ctx, -1); duk_pop(ctx);
            duk_get_prop_index(ctx, -1, 1); ms = duk_require_int(ctx, -1); duk_pop(ctx);
            duk_pop(ctx);
        }
        esp_task_wdt_reset();
        CelerKernel::noteAppYield();  // melodia de ate 15s: janela fresca por nota
        if (BoardIO::tone(f, ms)) played++;
    }
    duk_push_int(ctx, played);
    return 1;
}

// System.playMusic(song[, opts]) (API 25; opts na 27): chiptune de ate 4
// trilhas misturadas ao vivo na task do MusicSynth — NAO bloqueia
// (System.musicPos acompanha o progresso, System.musicStop corta). song =
// {bpm:60..200, loops:1..8, tracks:[{wave:"sq"|"sq25"|"tri"|"saw",
// drum:true, vol:0..100, notes:[[midi,semicolcheias],...]}]} — midi 0 =
// pausa; trilha drum usa as notas GM (36 bumbo, 38 caixa, 42 chimbal).
// opts.startMs pula para o meio (handoff da matilha: retoma de onde parou
// no vizinho). Valores sao clampados AQUI e de novo no MusicEngine::compile
// (o app nunca e confiavel o suficiente). false = alto-falante ocupado
// (fala do AI.speak/tom/playWav em curso), sem audio na placa ou musica vazia.
duk_ret_t JSBindings::js_playMusic(duk_context *ctx) {
    present();  // o app segue livre: so acordamos a task do sintetizador
    if (!duk_is_object(ctx, 0)) {
        duk_error(ctx, DUK_ERR_TYPE_ERROR, "playMusic: esperado objeto {bpm,loops,tracks}");
    }
    uint32_t startMs = 0;
    if (duk_is_object(ctx, 1) && !duk_is_callable(ctx, 1)) {
        duk_get_prop_string(ctx, 1, "startMs");
        if (duk_is_number(ctx, -1)) {
            const int ms = duk_get_int(ctx, -1);
            if (ms > 0) startMs = (uint32_t)ms;  // negativo = do inicio
        }
        duk_pop(ctx);
    }
    MusicEngine::Song song;
    duk_get_prop_string(ctx, 0, "bpm");
    if (duk_is_number(ctx, -1)) song.bpm = (uint16_t)duk_get_int(ctx, -1);
    duk_pop(ctx);
    duk_get_prop_string(ctx, 0, "loops");
    if (duk_is_number(ctx, -1)) song.loops = (uint8_t)duk_get_int(ctx, -1);
    duk_pop(ctx);
    duk_get_prop_string(ctx, 0, "tracks");
    if (!duk_is_array(ctx, -1)) {
        duk_pop(ctx);
        duk_error(ctx, DUK_ERR_TYPE_ERROR, "playMusic: tracks deve ser um array");
    }
    const duk_uarridx_t nTracks = duk_get_length(ctx, -1);
    for (duk_uarridx_t t = 0; t < nTracks && song.nTracks < MusicEngine::kMaxTracks; t++) {
        duk_get_prop_index(ctx, -1, t);
        if (!duk_is_object(ctx, -1)) { duk_pop(ctx); continue; }
        MusicEngine::Track& tr = song.tracks[song.nTracks];
        duk_get_prop_string(ctx, -1, "drum");
        tr.drum = duk_get_boolean(ctx, -1) != 0;
        duk_pop(ctx);
        duk_get_prop_string(ctx, -1, "wave");
        if (duk_is_string(ctx, -1)) {
            const char* w = duk_get_string(ctx, -1);
            tr.wave = strcmp(w, "sq25") == 0 ? MusicEngine::kWaveSq25
                    : strcmp(w, "tri") == 0 ? MusicEngine::kWaveTri
                    : strcmp(w, "saw") == 0 ? MusicEngine::kWaveSaw
                    : MusicEngine::kWaveSq;
        }
        duk_pop(ctx);
        duk_get_prop_string(ctx, -1, "vol");
        if (duk_is_number(ctx, -1)) tr.vol = (uint8_t)duk_get_int(ctx, -1);
        duk_pop(ctx);
        duk_get_prop_string(ctx, -1, "notes");
        if (duk_is_array(ctx, -1)) {
            const duk_uarridx_t n = duk_get_length(ctx, -1);
            for (duk_uarridx_t i = 0; i < n && tr.count < MusicEngine::kMaxNotes; i++) {
                duk_get_prop_index(ctx, -1, i);
                if (duk_is_array(ctx, -1) && duk_get_length(ctx, -1) >= 2) {
                    duk_get_prop_index(ctx, -1, 0);
                    const int midi = duk_get_int(ctx, -1);
                    duk_pop(ctx);
                    duk_get_prop_index(ctx, -1, 1);
                    const int len = duk_get_int(ctx, -1);
                    duk_pop(ctx);
                    if (midi >= 0 && midi <= 127 && len >= 1) {
                        tr.notes[tr.count].midi = (uint8_t)midi;
                        tr.notes[tr.count].len16 = (uint8_t)(len > 64 ? 64 : len);
                        tr.count++;
                    }
                }
                duk_pop(ctx);
            }
        }
        duk_pop(ctx);  // notes
        duk_pop(ctx);  // track
        if (tr.count > 0) song.nTracks++;  // trilha sem nota nao ocupa slot
    }
    duk_pop(ctx);  // tracks
    duk_push_boolean(ctx, MusicSynth::play(song, startMs) ? 1 : 0);
    return 1;
}

// System.musicStop() (API 25): corta a musica no proximo bloco (~15 ms).
duk_ret_t JSBindings::js_musicStop(duk_context *ctx) {
    const bool had = MusicSynth::playing();
    MusicSynth::stop();
    duk_push_boolean(ctx, had ? 1 : 0);
    return 1;
}

// System.musicPlaying() (API 25): true enquanto a task do sintetizador toca.
duk_ret_t JSBindings::js_musicPlaying(duk_context *ctx) {
    duk_push_boolean(ctx, MusicSynth::playing() ? 1 : 0);
    return 1;
}

// System.musicPos() (API 25): ms desde o inicio do audio, ou -1 se parado.
duk_ret_t JSBindings::js_musicPos(duk_context *ctx) {
    duk_push_int(ctx, MusicSynth::posMs());
    return 1;
}

// System.sfx(mel) (API 32): efeito curto [[freq, ms], ...] (ou [f, ms]
// solto, ou plano [f, ms, f, ms]) misturado pela task do sintetizador POR
// CIMA da trilha — nao bloqueia (o playTone segura a thread JS nota a
// nota: o loop de um jogo congelava 50-600 ms por explosao). freq 0 =
// pausa. Sem present(): chamado de dentro do draw nao empurra quadro pela
// metade. Devolve os tons aceitos (0 = alto-falante ocupado/sem audio).
duk_ret_t JSBindings::js_sfx(duk_context *ctx) {
    if (!duk_is_array(ctx, 0)) {
        duk_error(ctx, DUK_ERR_TYPE_ERROR, "sfx: esperado array [freq,ms] ou [[freq,ms],...]");
    }
    MusicEngine::SfxTone tones[MusicEngine::kMaxSfxTones];
    int n = 0;
    const duk_size_t len = duk_get_length(ctx, 0);
    bool flat = false;
    if (len > 0) {
        duk_get_prop_index(ctx, 0, 0);
        flat = duk_is_number(ctx, -1);
        duk_pop(ctx);
    }
    const int count = flat ? (int)len / 2 : (int)len;
    for (int i = 0; i < count && n < MusicEngine::kMaxSfxTones; i++) {
        int f, ms;
        if (flat) {
            duk_get_prop_index(ctx, 0, i * 2); f = duk_to_int(ctx, -1); duk_pop(ctx);
            duk_get_prop_index(ctx, 0, i * 2 + 1); ms = duk_to_int(ctx, -1); duk_pop(ctx);
        } else {
            duk_get_prop_index(ctx, 0, i);
            if (!duk_is_array(ctx, -1)) { duk_pop(ctx); continue; }  // efeito: tolera lixo
            duk_get_prop_index(ctx, -1, 0); f = duk_to_int(ctx, -1); duk_pop(ctx);
            duk_get_prop_index(ctx, -1, 1); ms = duk_to_int(ctx, -1); duk_pop(ctx);
            duk_pop(ctx);
        }
        if (f < 0 || f > 20000 || ms <= 0) continue;  // o SfxVoice clampa o resto
        tones[n].freq = (uint16_t)f;
        tones[n].ms = (uint16_t)(ms > 1000 ? 1000 : ms);
        n++;
    }
    duk_push_int(ctx, n > 0 ? MusicSynth::sfx(tones, n) : 0);
    return 1;
}

// System.notify(titulo[, msg]): toast AGORA + registra no historico
// (/local/notifications.txt, cap 20 — o Settings lista em Notificacoes).
duk_ret_t JSBindings::js_notify(duk_context *ctx) {
    const char* title = duk_require_string(ctx, 0);
    const char* msg = duk_is_string(ctx, 1) ? duk_require_string(ctx, 1) : "";
    // Kernel/Notifications (API 15): historico + toast + glance/bipe
    // respeitando o Nao Perturbe
    Notifications::push(title, msg, "");
    return 0;
}

// Notificacoes para o Settings: lista (array de {epoch,title,msg,src,read},
// mais ANTIGA primeiro — ordem da API 12) e limpeza
duk_ret_t JSBindings::js_notifications(duk_context *ctx) {
    std::vector<Notifications::Note> l = Notifications::list();
    std::reverse(l.begin(), l.end());
    duk_push_array(ctx);
    for (size_t i = 0; i < l.size(); i++) {
        duk_push_object(ctx);
        putNum(ctx, "epoch", (duk_double_t)l[i].epoch);
        putStr(ctx, "title", l[i].title.c_str());
        putStr(ctx, "msg", l[i].msg.c_str());
        putStr(ctx, "src", l[i].src.c_str());
        putBool(ctx, "read", l[i].read);
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)i);
    }
    return 1;
}

// System.unreadNotifications() -> nao lidas (API 15; aberto: so a contagem,
// o conteudo segue com a permissao "system")
duk_ret_t JSBindings::js_unreadNotifications(duk_context *ctx) {
    duk_push_int(ctx, Notifications::unread());
    return 1;
}

duk_ret_t JSBindings::js_notificationsClear(duk_context *ctx) {
    (void)ctx;
    Notifications::clear();
    return 0;
}

// System.playWav(path) (API 13): toca WAV PCM 16-bit (mono/stereo, 8-48 kHz)
// do FS em streaming pelo I2S. true = tocou; false = sem audio na placa,
// arquivo ausem ou cabecalho invalido. Bloqueante — desenhe antes.
duk_ret_t JSBindings::js_playWav(duk_context *ctx) {
    const char* path = duk_require_string(ctx, 0);
    if (!fsPathAllowed(path)) {
        char msg[176];  // pre-formatado: duk_error com %s em lightfunc corrompe o heap
        snprintf(msg, sizeof(msg), "System.playWav: %s e arquivo do sistema", path);
        duk_error(ctx, DUK_ERR_ERROR, msg);
    }
    present();
    AudioPlayer::WavError we = AudioPlayer::playWav(path);
    CelerKernel::noteAppYield();  // audio longo: renova a janela p/ o retorno
    duk_push_boolean(ctx, we == AudioPlayer::WavError::None ? 1 : 0);
    return 1;
}
