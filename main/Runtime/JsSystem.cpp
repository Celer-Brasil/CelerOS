#include "sdkconfig.h"
#include "JSBindings.h"
#include "../USBDevice/LogSink.h"
#include "../Kernel/Core/CelerKernel.h"
#include "../Display/Layout.h"
#include "../Display/ScreenPower.h"
#include "../Hardware/PowerPolicy.h"
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
#include "../Kernel/Core/CelerKernel.h"
#include "../Hardware/BoardIO.h"
#include "../Hardware/Buttons.h"
#include "../USBHost/UsbHost.h"
#include "../Display/ScreenCapture.h"
#include "../Launcher/LauncherUI.h"
#include "../Launcher/Screens.h"
#include <lgfx/v1/misc/DataWrapper.hpp>
#include "JsInternal.h"
#include "../Utils/CelerSettings.h"
#include "../UI/Kui.h"
#include "../Boards/Board.h"
#include "driver/ledc.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#if CONFIG_CELEROS_BLUETOOTH
#include "../Pack/Resources.h"  // localClaim do rele (o dono ganha do remoto)
#endif

// =====================================================
// Touch Input
// =====================================================

// Leitura de toque de app (getTouch e UI.begin): cede o quadro ao vidro,
// trata a topbar (X de sair lanca a saida do app) e devolve o ponto no espaco
// virtual 240x320 (vertical descontando a topbar fixa). false = sem dedo.
bool JSBindings::readAppTouch(duk_context *ctx, int *jx, int *jy) {
    uint16_t tx = 0, ty = 0;
    bool touched = false;
    checkRemoteAppExit(ctx);  // shell "exit": encerra antes de tocar no hardware
    present();  // app cedeu: o frame desenhado ate aqui vai ao vidro
    *jx = 0;
    *jy = 0;
#if CONFIG_CELEROS_UI
    if (!tftInstance) return false;
    touched = kui::readTouch(&tx, &ty);

    // Topbar (X de sair): dispara so no release; toque na faixa e chrome
    if (pollAppChrome(touched, tx, ty)) {
        throwAppExit(ctx);  // nao retorna
    }
    if (!touched) return false;

    // Canvas nativo (API 28): toque em pixels fisicos (sem topbar — o modo
    // recusa app com faixa fixa)
    if (s_nativeCanvas) {
        *jx = (int)tx;
        *jy = (int)ty;
        return true;
    }

    // Coordenadas no espaco de projeto 240x320 (hit-zones dos apps batem);
    // fixo: vertical desconta a topbar; retratil: tela cheia 1:1
    *jx = (int)tx * 240 / tftInstance->width();
    int offY = s_topbarFixed ? UI::topbarH() : 0;
    *jy = ((int)ty - offY) * 320 / ((int)tftInstance->height() - offY);
    return true;
#else
    (void)tx; (void)ty; (void)touched;  // sem vidro: nao ha dedo nem chrome
    return false;
#endif
}

// Returns an object { x, y, touched }
duk_ret_t JSBindings::js_getTouch(duk_context *ctx) {
    int jx = 0, jy = 0;
    bool touched = readAppTouch(ctx, &jx, &jy);
    duk_push_object(ctx);
    putInt(ctx, "x", jx);
    putInt(ctx, "y", jy);
    putBool(ctx, "touched", touched);
    return 1;
}

// (API 43) Multi-dedo: mesmo caminho do readAppTouch — present, chrome SO no
// primario (o app nunca ve toque da topbar/X/bordas), espaco virtual 240x320
// — mas devolve todos os dedos, primario em out[0].
size_t JSBindings::readAppTouches(duk_context *ctx, kui::TouchPoint *out, size_t max) {
    checkRemoteAppExit(ctx);  // shell "exit": encerra antes de tocar no hardware
    present();  // app cedeu: o frame desenhado ate aqui vai ao vidro
#if CONFIG_CELEROS_UI
    if (out == nullptr || max == 0 || !tftInstance) return 0;
    kui::TouchPoint pts[kui::kTouchMax];
    size_t n = kui::readTouches(pts, kui::kTouchMax);
    // chrome TAMBEM nos polls sem dedo (n = 0): o release do X/arquivo e um
    // poll vazio — sem isso o pollAppChrome nunca ve o release, o X nao
    // disparava NUNCA no caminho multi (getTouches do motor) e o gesto de
    // revelar virava zumbi (s_tbSwipe so terminava vendo !touched)
    bool prim = (n > 0);
    uint16_t px = prim ? pts[0].x : 0;
    uint16_t py = prim ? pts[0].y : 0;
    if (pollAppChrome(prim, px, py)) throwAppExit(ctx);  // nao retorna
    if (n > 0) {
        if (!prim) {  // primario consumido pelo chrome: sai do array
            for (size_t i = 1; i < n; i++) pts[i - 1] = pts[i];
            n--;
        }
    }
    int offY = s_topbarFixed ? UI::topbarH() : 0;
    for (size_t i = 0; i < n && i < max; i++) {
        if (s_nativeCanvas) {  // Canvas nativo (API 28): toque em pixels fisicos
            out[i].x = pts[i].x;
            out[i].y = pts[i].y;
        } else {
            out[i].x = (uint16_t)((int)pts[i].x * 240 / tftInstance->width());
            out[i].y = (uint16_t)(((int)pts[i].y - offY) * 320 /
                                  ((int)tftInstance->height() - offY));
        }
        out[i].id = pts[i].id;
        out[i].size = pts[i].size;
    }
    return n < max ? n : max;
#else
    (void)out; (void)max;
    return 0;
#endif
}

// (API 43) Returns an array of { id, x, y, size } — primario primeiro, []
// sem dedo. Mesma cedida de quadro do getTouch: use UM dos dois por loop.
duk_ret_t JSBindings::js_getTouches(duk_context *ctx) {
    kui::TouchPoint pts[kui::kTouchMax];
    size_t n = readAppTouches(ctx, pts, kui::kTouchMax);
    duk_idx_t arr = duk_push_array(ctx);
    for (size_t i = 0; i < n; i++) {
        duk_push_object(ctx);
        putInt(ctx, "id", pts[i].id);
        putInt(ctx, "x", pts[i].x);
        putInt(ctx, "y", pts[i].y);
        putInt(ctx, "size", pts[i].size);
        duk_put_prop_index(ctx, arr, (duk_uarridx_t)i);
    }
    return 1;
}

// Botao fisico 1 da placa como input do app (API 17, placas buttonToApp —
// devkit barebone). Poll consumivel, no estilo da casa (raisePoll/pmuKey):
// devolve o evento pendente desde a ultima leitura e zera.
//   0 = nada, 1 = toque curto, 2 = segurar ~1,2 s
// Em placas comuns o botao e "home" do OS (nao ha latch) e sempre devolve 0 —
// apps headless testam getInfo().board ou simplesmente tratam 0 como "sem botao".
duk_ret_t JSBindings::js_button(duk_context *ctx) {
    checkRemoteAppExit(ctx);  // shell "exit": encerra antes de ler o botao
    present();  // bombeia Buttons::tick (alimenta o latch) e os timers
    duk_push_int(ctx, Buttons::buttonEvents());
    return 1;
}

// =====================================================
// System Utilities
// =====================================================

// Relogio de 64 bits como Number (double: exato ate 2^53): o uint32 do
// Compat dava a volta — micros() a cada ~71 min e millis() a cada ~49 dias
// — e "agora - t0" ficava negativo nos apps.
duk_ret_t JSBindings::js_millis(duk_context *ctx) {
    duk_push_number(ctx, (duk_double_t)(esp_timer_get_time() / 1000));
    return 1;
}

duk_ret_t JSBindings::js_micros(duk_context *ctx) {
    duk_push_number(ctx, (duk_double_t)esp_timer_get_time());
    return 1;
}

duk_ret_t JSBindings::js_delay(duk_context *ctx) {
    appWait(ctx, duk_require_int(ctx, 0));
    return 0;
}

// Espera de app (System.delay, UI.end): present + GC espacado + fatias com
// WDT e "exit" remoto
void JSBindings::appWait(duk_context *ctx, int ms) {
    checkRemoteAppExit(ctx);  // shell "exit": app parado num delay longo tambem sai
    present();
    uint32_t t0 = millis();
    // Mark-and-sweep completo (so ciclos; o resto e refcount) custa ms em
    // heaps grandes: antes rodava a CADA delay (loops de 20 ms gastavam boa
    // parte do tempo aqui). Agora no maximo 1x/s, ou ja se o heap aperta.
    // Com PSRAM, 1x a cada 10 s: o custo e o heap VIVO, nao o lixo — num jogo
    // grande (Detona, 4848) cada varredura levava ~40 ms e virava um quadro
    // perdido por segundo; o GC voluntario do Duktape (DUK_USE_VOLUNTARY_GC)
    // segue rodando pelas alocacoes e o piso de heap continua forcando
    static uint32_t lastGcMs = 0;
    static const uint32_t kGcEveryMs = Board::profile().hasPsram ? 10000 : 1000;
    if (t0 - lastGcMs > kGcEveryMs || ESP.getMaxAllocHeap() < 24 * 1024) {
        duk_gc(ctx, 0);
        lastGcMs = t0;
    }
    if (ms > 30000) ms = 30000;  // teto de 30 s (antes delay(60000) nao esperava NADA)
    if (ms > 0) {
        // fatias de 4s com reset do watchdog (F2): um System.delay(30000)
        // nao pode derrubar o WDT de 15s da main task (app rodando = sem
        // celerLoop; os pontos de espera alimentam o WDT)
        // O GC acima pode ja ter comido o prazo inteiro: sem este teste a
        // subtracao sem sinal dava a volta e um delay(6) virava ~49 dias.
        const uint32_t spent = millis() - t0;
        uint32_t remain = spent < (uint32_t)ms ? (uint32_t)ms - spent : 0;
        // cede PELO MENOS 1 tick: com o present/GC acima comendo o prazo do
        // delay(1) do loop de jogo, a main (prio 1) nao bloqueava nunca e o
        // IDLE0 passava fome ate o TWDT reiniciar a placa (Supernova pesado:
        // era a leitura I2C sincrona do toque que, por acaso, cedia o nucleo)
        if (remain == 0) remain = 1;
        while (remain > 0) {
            esp_task_wdt_reset();
            uint32_t slice = remain > 4000 ? 4000 : remain;
#if CONFIG_CELEROS_UI
            ScreenCapture::serviceDelay(slice);  // espera atendendo a tela no navegador
#else
            delay(slice);  // sem vidro: nao ha stream de tela atendendo na espera
#endif
            remain -= slice;
            checkRemoteAppExit(ctx);  // delay de ate 30s tambem responde ao "exit"
        }
    }
}

duk_ret_t JSBindings::js_delayMicroseconds(duk_context *ctx) {
    int us = duk_require_int(ctx, 0);
    // espera ocupada (nao cede): teto de 1 s — acima disso use System.delay.
    // Sem teto, delayMicroseconds(2e9) prendia a CPU ate o WDT reiniciar.
    if (us > 1000000) us = 1000000;
    if (us > 0) {
        esp_task_wdt_reset();
        delayMicroseconds(us);
    }
    return 0;
}

duk_ret_t JSBindings::js_print(duk_context *ctx) {
    const char *msg = duk_safe_to_string(ctx, 0);  // print(5)/print(obj) nao lancam
    // Print de app: entra com o PACOTE na frente ("[app:dogface]" — filtro
    // "logcat --grep app" segue funcionando) e persiste no apps.log do
    // LogPersist; o celer_log_* comum e firmware (kern.log)
    celer_log_app(s_appPkg.empty() ? nullptr : s_appPkg.c_str(), msg);
    return 0;
}

duk_ret_t JSBindings::js_getTemperature(duk_context *ctx) {
    float temp = temperatureRead();
    duk_push_number(ctx, temp);
    return 1;
}

duk_ret_t JSBindings::js_hasTemperatureSensor(duk_context *ctx) {
    float temp = temperatureRead();
    // 53.33 is a common return value when the sensor is unsupported or disconnected internally
    bool hasSensor = (temp != 53.33f);
    duk_push_boolean(ctx, hasSensor);
    return 1;
}

duk_ret_t JSBindings::js_getInfo(duk_context *ctx) {
    SystemInfo& sys = SystemInfo::instance();
    MemoryInfo mem = sys.getMemoryInfo();
    ChipInfo chip = sys.getChipInfo();

    duk_push_object(ctx);

    // RAM
    putUint(ctx, "totalRAM", mem.totalHeap);

    putUint(ctx, "freeRAM", mem.freeHeap);

    putUint(ctx, "minFreeRAM", mem.minFreeHeap);

    putUint(ctx, "maxAllocRAM", mem.largestFreeBlock);

    putUint(ctx, "totalPSRAM", mem.totalPsram);

    putUint(ctx, "freePSRAM", mem.freePsram);

    // Heap livre no INICIO deste app (antes do fonte/heap JS): quanto um app
    // pode ocupar nesta placa. freeRAM e medido agora, com o app atual ja
    // carregado — a loja usa appRAM para o teto de tamanho sem PSRAM.
    putUint(ctx, "appRAM", (duk_uint_t)CelerKernel::appLaunchFreeHeap);

    // perifericos da placa (API 7): feature detection sem tentativa e erro
    putBool(ctx, "hasLed", BoardIO::hasLed());
    putBool(ctx, "hasLightSensor", BoardIO::hasLightSensor());
    putBool(ctx, "hasSpeaker", BoardIO::hasSpeaker());
    // API 46: capacidades do menu de features (Kconfig por placa) — o
    // PERIFERICO pode existir e o BUILD nao traze-lo. hasSpeaker true com
    // hasAudio false = so tom analogico (playTone/beep; alto-falante da CYD
    // no GPIO26); playWav/playMusic/sfx devolvem false/0. hasMic acompanha
    // o nascimento do objeto Mic (hardware E build); hasPhysics, o verlet
    // nativo (sem ele a dep celeros.physics cai no P.verlet interpretado).
#if CONFIG_CELEROS_AUDIO
    putBool(ctx, "hasAudio", true);
#else
    putBool(ctx, "hasAudio", false);
#endif
#if CONFIG_CELEROS_MIC
    putBool(ctx, "hasMic", Board::profile().mic.ws >= 0);  // API 13
#else
    putBool(ctx, "hasMic", false);  // build sem canal de captura
#endif
#if CONFIG_CELEROS_JS_PHYSICS
    putBool(ctx, "hasPhysics", true);
#else
    putBool(ctx, "hasPhysics", false);
#endif
    // API 48: USB Host presente E instalado (objeto USB existe com a perm)
#if CONFIG_CELEROS_USB_HOST
    putBool(ctx, "hasUsbHost", UsbHost::available());
#else
    putBool(ctx, "hasUsbHost", false);
#endif
    putBool(ctx, "hasImu", Board::profile().imuAccel != nullptr);  // API 13
    // API 15: bateria, placa e geometria do vidro (relogio: cantos mortos)
    putBool(ctx, "hasBattery", BoardIO::batteryMv() >= 0);
    putStr(ctx, "board", Board::profile().id);
    // inset em coordenadas virtuais 240 (arredondado p/ cima: margem segura)
    putInt(ctx, "inset", (Board::profile().screenInset * 240 + UI::W - 1) / UI::W);
    // API 17: placas headless (devkit) nao tem vidro — apps que desenham
    // fazem feature detect aqui antes de tocar em Canvas/tela
    duk_push_string(ctx, Board::profile().headless ? "headless"
                   : Board::profile().screenInset > 0 ? "rounded" : "rect");
    duk_put_prop_string(ctx, -2, "shape");
    putBool(ctx, "hasDisplay", Board::profile().headless ? 0 : 1);
    // vidro fisico: apps que desenham geometria (ponteiros) compensam a
    // escala nao uniforme do 240x320
    putInt(ctx, "screenW", UI::W);
    putInt(ctx, "screenH", UI::H);

    // Chip & CPU (frequencia vem do Compat — SystemInfo nao expoe)
    putUint(ctx, "cpuFreqMHz", ESP.getCpuFreqMHz());

    putStr(ctx, "chipModel", sys.getChipModel().c_str());

    putUint(ctx, "chipCores", chip.cores);

    putUint(ctx, "chipRevision", chip.revision);

    putUint(ctx, "flashSize", sys.getFlashSize());

    // Uptime e identidade
    putNum(ctx, "uptimeMs", (duk_double_t)sys.getUptimeMillis());  // sem volta aos 49 dias

    putStr(ctx, "macAddress", sys.getMacAddress().c_str());

    putStr(ctx, "resetReason", sys.getResetReasonString().c_str());

    putStr(ctx, "idfVersion", sys.getIdfVersion().c_str());

    return 1;
}

duk_ret_t JSBindings::js_restart(duk_context *ctx) {
    present();  // chamada bloqueante: o que o app desenhou aparece antes
    ESP.restart();
    return 0;
}

duk_ret_t JSBindings::js_getTime(duk_context *ctx) {
    duk_push_string(ctx, TimeManager::getFormattedTime().c_str());
    return 1;
}

duk_ret_t JSBindings::js_getSeconds(duk_context *ctx) {
    duk_push_int(ctx, TimeManager::getSeconds());
    return 1;
}

// API 49: epoch UTC absoluto (segundos desde 1970). As bindings de tempo
// existentes so entregam a hora LOCAL formatada; um app que fala com nuvem
// (carimbo entered_at de ticket, TTL de token...) precisa do instante
// absoluto. Sem hora valida (boot sem NTP/RTC) devolve o epoch persistido
// no boot ou 0 — o app confere com System.timeValid quando o carimbo importa.
duk_ret_t JSBindings::js_epoch(duk_context *ctx) {
    time_t now = time(nullptr);
    duk_push_number(ctx, (duk_double_t)now);
    return 1;
}

duk_ret_t JSBindings::js_getWeekday(duk_context *ctx) {
    duk_push_int(ctx, TimeManager::getWeekday());
    return 1;
}

duk_ret_t JSBindings::js_keepAwake(duk_context *ctx) {
    // Jogos/apps que seguram a tela acesa (maquina de estados do ScreenPower
    // pula os estagios dim/AOD). Duas formas: booleano (latched, solta com
    // false) ou duracao em ms (expira sozinho — o Touch Test usa 300000).
    // Sem estados de tela na placa: no-op.
    if (duk_is_number(ctx, 0)) {
        ScreenPower::keepAwakeFor((uint32_t)duk_require_uint(ctx, 0));
    } else {
        ScreenPower::keepAwake(duk_require_boolean(ctx, 0) != 0);
    }
    return 0;
}

duk_ret_t JSBindings::js_getDate(duk_context *ctx) {
    duk_push_string(ctx, TimeManager::getFormattedDate().c_str());
    return 1;
}

duk_ret_t JSBindings::js_getYear(duk_context *ctx) {
    duk_push_int(ctx, TimeManager::getYear());
    return 1;
}

duk_ret_t JSBindings::js_getMonth(duk_context *ctx) {
    duk_push_int(ctx, TimeManager::getMonth());
    return 1;
}

duk_ret_t JSBindings::js_getDay(duk_context *ctx) {
    duk_push_int(ctx, TimeManager::getDay());
    return 1;
}

duk_ret_t JSBindings::js_getTimezone(duk_context *ctx) {
    duk_push_string(ctx, TimeManager::currentTimezone.c_str());
    return 1;
}

duk_ret_t JSBindings::js_getOSVersion(duk_context *ctx) {
    duk_push_string(ctx, CELEROS_VERSION);
    return 1;
}

duk_ret_t JSBindings::js_getAPILevel(duk_context *ctx) {
    duk_push_int(ctx, CELEROS_API_LEVEL);
    return 1;
}

// UI Bindings=====================================================
// Network Bindings
// =====================================================

duk_ret_t JSBindings::js_getIPAddress(duk_context *ctx) {
    duk_push_string(ctx, WebManager::getIPAddress().c_str());
    return 1;
}

duk_ret_t JSBindings::js_isWiFiActive(duk_context *ctx) {
    duk_push_boolean(ctx, WebManager::isActive());
    return 1;
}


// ---- Config em NVS (F3) / notificacao e buzzer (F4) ------------------------

duk_ret_t JSBindings::js_setting(duk_context *ctx) {
    // System.setting(k) -> "1" | null; System.setting(k, v) -> bool
    // Leitura aberta; ESCRITA so "system": as keys sao globais do aparelho
    // (web_on liga o servidor web no boot, nowifi desliga o radio...)
    const char* key = duk_require_string(ctx, 0);
    if (strlen(key) == 0 || strlen(key) > 15) {
        duk_error(ctx, DUK_ERR_RANGE_ERROR, "System.setting: chave deve ter 1 a 15 caracteres");
    }
    // Segundo argumento DEFINIDO = escrita; qualquer tipo vira string (o
    // d.ts anuncia number e System.setting("x", 5) lia em silencio em vez de
    // gravar). null/undefined continuam leitura.
    if (!duk_is_null_or_undefined(ctx, 1)) {
        if (!perm(celer::PERM_SYSTEM)) {
            duk_error(ctx, DUK_ERR_ERROR, "System.setting(k, v) requer permissao \"system\" (use Storage)");
        }
        const char* val = duk_to_string(ctx, 1);
        if (strlen(val) > 63) {  // CelerSettings::get le ate 63: maior virava "ausente"
            duk_error(ctx, DUK_ERR_RANGE_ERROR, "System.setting: valor acima de 63 caracteres");
        }
        bool ok = CelerSettings::set(key, val);
        // ajustes de tela/energia valem na hora (sem reboot)
        ScreenPower::reloadSettings();
        PowerPolicy::reloadSettings();
        duk_push_boolean(ctx, ok ? 1 : 0);
        return 1;
    }
    std::string v = CelerSettings::get(key);
    if (v.empty()) { duk_push_null(ctx); return 1; }
    duk_push_string(ctx, v.c_str());
    return 1;
}

duk_ret_t JSBindings::js_toast(duk_context *ctx) {
    const char* msg = duk_require_string(ctx, 0);
#if CONFIG_CELEROS_UI
    kui::Navigator::toast(msg);
#else
    celer_log_printf("[toast] %s\n", msg);  // sem vidro: o aviso vai pro logcat
#endif
    return 0;
}

duk_ret_t JSBindings::js_beep(duk_context *ctx) {
    int freq = duk_require_int(ctx, 0);
    int ms = duk_require_int(ctx, 1);
    if (freq < 20 || freq > 20000 || ms <= 0 || ms > 5000) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
    present();  // chamada bloqueante: o que o app desenhou aparece antes
    bool ok = BoardIO::tone(freq, ms);
    CelerKernel::noteAppYield();  // ate 5s: renova a janela p/ o retorno
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}

// System.led(r, g, b) -> bool (0..255 por canal; sem argumentos apaga).
// false em placa sem LED RGB.
duk_ret_t JSBindings::js_led(duk_context *ctx) {
    if (!BoardIO::hasLed()) { duk_push_boolean(ctx, 0); return 1; }
    auto ch = [ctx](duk_idx_t i) {
        int v = duk_is_number(ctx, i) ? duk_get_int(ctx, i) : 0;
        return (uint8_t)(v < 0 ? 0 : (v > 255 ? 255 : v));
    };
    BoardIO::setLed(ch(0), ch(1), ch(2));
    duk_push_boolean(ctx, 1);
    return 1;
}

// System.lightLevel() -> 0 (escuro) .. 100 (claro); -1 sem sensor de luz
duk_ret_t JSBindings::js_lightLevel(duk_context *ctx) {
    duk_push_int(ctx, BoardIO::lightLevel());
    return 1;
}

// System.relay(n, on) -> bool. n e 1-based (1 = L1 da placa); false sem
// reles ou indice invalido.
duk_ret_t JSBindings::js_relay(duk_context *ctx) {
    int n = duk_require_int(ctx, 0);
    bool on = duk_require_boolean(ctx, 1) ? true : false;
#if CONFIG_CELEROS_BLUETOOTH
    // o dono vem primeiro: sessao remota no nosso rele (Pack.open("releN")
    // de outro no, API 38) e revogada — o fisico nao pode ter dois
    // comandantes (mesmo contrato do Mic.start com o mic)
    Resources::localClaim(resproto::TYPE_GPIO);
#endif
    duk_push_boolean(ctx, BoardIO::setRelay(n, on) ? 1 : 0);
    return 1;
}

// System.relayState(n) -> 1 ligado, 0 desligado, -1 sem rele/indice invalido
duk_ret_t JSBindings::js_relayState(duk_context *ctx) {
    duk_push_int(ctx, BoardIO::relayState(duk_require_int(ctx, 0)));
    return 1;
}

// System.relayCount() -> quantas linhas de rele a placa tem (0..3)
duk_ret_t JSBindings::js_relayCount(duk_context *ctx) {
    duk_push_int(ctx, BoardIO::relayCount());
    return 1;
}

// System.battery() -> tensao em mV; -1 sem divisor de bateria na placa
duk_ret_t JSBindings::js_battery(duk_context *ctx) {
    duk_push_int(ctx, BoardIO::batteryMv());
    return 1;
}

// System.batteryInfo() -> {mv, pct, charging, usb, full} (API 15); null sem
// bateria. pct vem do fuel gauge do PMU ou da curva LiPo sobre mv.
duk_ret_t JSBindings::js_batteryInfo(duk_context *ctx) {
    const int mv = BoardIO::batteryMv();
    if (mv < 0) {
        duk_push_null(ctx);
        return 1;
    }
    const int st = BoardIO::chargeState();
    duk_push_object(ctx);
    putInt(ctx, "mv", mv);
    putInt(ctx, "pct", BoardIO::batteryPct());
    putBool(ctx, "charging", st > 0 && (st & 1));
    putBool(ctx, "usb", st > 0 && (st & 2));
    putBool(ctx, "full", st > 0 && (st & 4));
    return 1;
}

// System.micLevel() -> 0..100 (RMS curto); -1 sem microfone. Bloqueante
// curto (~100 ms de audio) — o desenho pendente aparece antes.
duk_ret_t JSBindings::js_micLevel(duk_context *ctx) {
    present();
    duk_push_int(ctx, BoardIO::micLevel());
    return 1;
}

// System.touchPad() -> 1 tocado, 0 solto; -1 sem pad capacitivo
duk_ret_t JSBindings::js_touchPad(duk_context *ctx) {
    duk_push_int(ctx, BoardIO::touchPad());
    return 1;
}

// System.neopixel(strip, cores) -> bool. cores: array de 0x00RRGGBB
// (ate 8 leds). false sem fitas WS2812 na placa.
duk_ret_t JSBindings::js_neopixel(duk_context *ctx) {
    int strip = duk_require_int(ctx, 0);
    if (!duk_is_array(ctx, 1)) return duk_error(ctx, DUK_ERR_TYPE_ERROR, "cores deve ser array");
    const duk_uarridx_t n = duk_get_length(ctx, 1);
    if (n < 1 || n > 8) return duk_error(ctx, DUK_ERR_RANGE_ERROR, "1..8 cores");
    uint32_t colors[8];
    for (duk_uarridx_t i = 0; i < n && i < 8; i++) {
        duk_get_prop_index(ctx, 1, i);
        colors[i] = (uint32_t)duk_get_uint(ctx, -1);
        duk_pop(ctx);
    }
    present();
    duk_push_boolean(ctx, BoardIO::neopixelSet(strip, colors, (int)n) ? 1 : 0);
    return 1;
}
