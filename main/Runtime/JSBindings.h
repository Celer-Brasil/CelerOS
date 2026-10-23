#ifndef JS_BINDINGS_H
#define JS_BINDINGS_H

#include <Arduino.h>
#include <duktape.h>
#include "../Boards/Board.h"

#include <string>
#include "../Utils/AppPerms.h"  // enum AppPerm/PERM_* (header testavel no host)
using celer::PERM_ALL;

// Superficie dos servicos (JsSvc.cpp, API 42) — amiga da classe
namespace SvcApi {
void install(duk_context* thr, const char* appPkg, uint32_t perms, const char* appDir);
}  // namespace SvcApi

namespace kui {
struct TouchPoint;  // multi-dedo (readAppTouches)
}  // namespace kui

class JSBindings {
public:
    // Fim do app (CelerKernel::runFile, depois do pcall): solta o keepAwake
    // e desfaz brilho/volume/auto-brilho/tempo de tela que um app SEM
    // "system" mudou (so ao vivo — nao persistem nem vazam para o launcher)
    static void appExitCleanup();
    // Apaga o Storage (NVS) de um pacote — desinstalacao pelo launcher
    static bool storageClearPackage(const std::string& pkg);

    // appTitle: nome na topbar do sistema; topbarFixed: false = faixa
    // retratil (swipe da borda superior revela por alguns segundos) com o
    // app em tela cheia — campo "topbar" do app.json
    static void init(duk_context *ctx, CelerDisplay *tft, const char* appTitle = "",
                    bool topbarFixed = true, const char* appPkg = "",
                    uint32_t perms = PERM_ALL);

    // Alvo de desenho do app (sprite do app > quadro automatico > display)
    static lgfx::LGFXBase* gfx();
    // Leva o quadro automatico ao vidro se houve desenho desde o ultimo
    static void present();
    // Recorte do display quando o app desenha direto nele (sem quadro PSRAM):
    // o do app (System.setClip) intersectado com a area abaixo da topbar
    static void setAppDisplayClip(bool on, int x, int y, int w, int h);
    static void applyDisplayClip();
    // Algum recorte ativo (fast path do drawPixel pula o LGFX so sem clipe)
    static bool clipActive();
    // y fisico do desenho no alvo corrente (quadro/display descontam a topbar
    // do sistema; o sprite do app e canvas proprio, origem em 0)
    static int mapY(int v);
    // Toque do app no espaco virtual (present + topbar + exit); false = sem dedo
    static bool readAppTouch(duk_context *ctx, int *jx, int *jy);
    // Multi-dedo (API 43): mesmo caminho do readAppTouch (present, chrome SO
    // no primario, espaco virtual), mas devolve todos os dedos em out — o
    // primario primeiro — e o total escrito
    static size_t readAppTouches(duk_context *ctx, kui::TouchPoint *out, size_t max);
    // Espera de app (System.delay / UI.end): present, GC, WDT, exit remoto
    static void appWait(duk_context *ctx, int ms);
    // true = a chamada corrente roda no callback de um servico (svchost):
    // present() reentraria o pump; bindings bloqueantes so renovam a janela
    static bool inService();

private:
    static CelerDisplay *tftInstance;
    static CelerSprite *tftSprite;
    static duk_context *s_jsCtx;  // heap do app corrente (timers no present)

    // Double Buffering
    static duk_ret_t js_createSprite(duk_context *ctx);
    static duk_ret_t js_deleteSprite(duk_context *ctx);
    static duk_ret_t js_pushSprite(duk_context *ctx);
    static duk_ret_t js_bindSprite(duk_context *ctx);
    static duk_ret_t js_useSprite(duk_context *ctx);   // troca de alvo (API 12)
    static duk_ret_t js_spriteSlots(duk_context *ctx); // limite do pool (API 29)
    static void deleteAllSprites();                    // reset por app
    static bool useSprite;

    // Verlet nativo (API 31, JsPhysics.cpp): mundos em buffer C++ (malloc,
    // PSRAM quando tem), step/integracao em float. O JS cria/pinta por
    // indice — sem objetos no heap Duktape. Reset por app: jsPhysicsReset.
    static duk_ret_t js_verletNew(duk_context *ctx);
    static duk_ret_t js_verletFree(duk_context *ctx);
    static duk_ret_t js_verletAddPoint(duk_context *ctx);
    static duk_ret_t js_verletStick(duk_context *ctx);
    static duk_ret_t js_verletPin(duk_context *ctx);
    static duk_ret_t js_verletSet(duk_context *ctx);
    static duk_ret_t js_verletStep(duk_context *ctx);
    static duk_ret_t js_verletXY(duk_context *ctx);
    static duk_ret_t js_verletSticks(duk_context *ctx);
    static duk_ret_t js_verletCount(duk_context *ctx);
    static duk_ret_t js_verletDelStick(duk_context *ctx);
    static duk_ret_t js_verletDelPoint(duk_context *ctx);
    static duk_ret_t js_verletPins(duk_context *ctx);

    // Aceleradores de jogo (API 33, CONFIG_CELEROS_JS_GAME_ACCEL): corpo
    // rigido nativo (JsRigid.cpp, solver em Utils/Rigid2D.h; reset por app:
    // jsRigidReset) e sprite girado/escalado (JsGfx.cpp)
    static duk_ret_t js_rigidNew(duk_context *ctx);
    static duk_ret_t js_rigidFree(duk_context *ctx);
    static duk_ret_t js_rigidBox(duk_context *ctx);
    static duk_ret_t js_rigidCircle(duk_context *ctx);
    static duk_ret_t js_rigidRemove(duk_context *ctx);
    static duk_ret_t js_rigidSet(duk_context *ctx);
    static duk_ret_t js_rigidImpulse(duk_context *ctx);
    static duk_ret_t js_rigidStep(duk_context *ctx);
    static duk_ret_t js_rigidState(duk_context *ctx);
    static duk_ret_t js_rigidCount(duk_context *ctx);
    static duk_ret_t js_drawSprite(duk_context *ctx);
    static duk_ret_t js_blitSprite(duk_context *ctx);
    static duk_ret_t js_copySprite(duk_context *ctx);

    // Timers JS (API 12): globais setTimeout/setInterval/clear*
    static duk_ret_t js_setTimeout(duk_context *ctx);
    static duk_ret_t js_setInterval(duk_context *ctx);
    static duk_ret_t js_clearTimeout(duk_context *ctx);
    static duk_ret_t js_clearInterval(duk_context *ctx);
    static void timersResetAll();               // reset por app
public:
    // Host do svchost (API 42): zera os slots do servico e troca o host
    // CORRENTE dos bindings (app <-> servicos) durante o dispatch.
    // timersTick e o drain: present() (host do app) e AppServices (servicos)
    static void timersTick(duk_context *ctx);
    static void timersResetSvc();
    static void timersUseSvcHost(bool svc);
    // Hooks do dispatch do svchost: identidade do dono do slot por callback
    // (svcIdentity/svcIdentityRestore) e o consumo do erro de callback (o
    // ofensor para; sem isso o duk_throw sem frame protegido ia ao fatal
    // handler do heap = reboot). begin/end/crash podem ser nullptr.
    static void timersSvcHooks(void (*begin)(duk_context*), void (*end)(duk_context*),
                              void (*crash)(duk_context*, const char*));
    // Um servico parou: mata os timers DAQUELA thread (interval nao refire)
    static void timersClearCtx(duk_context* ctx);
    // O heap do app vai morrer (duk_destroy_heap): solta TODA referencia
    // pendente a ele — s_jsCtx dangle faria o present() de um servico bombear
    // timers do heap destruido (UAF).
    static void heapDetaching();

    // Modulos JS (API 23): require("nome") carrega <pasta do app>/nome.js
    // embrulhado como funcao(module, exports, require) — CommonJS enxuto
    // (JsModules.cpp)
    static duk_ret_t js_require(duk_context *ctx);

    // GPIO Bindings
    static duk_ret_t js_pinMode(duk_context *ctx);
    static duk_ret_t js_digitalWrite(duk_context *ctx);
    static duk_ret_t js_digitalRead(duk_context *ctx);
    static duk_ret_t js_analogRead(duk_context *ctx);
    static duk_ret_t js_analogWrite(duk_context *ctx);
    static duk_ret_t js_pulseIn(duk_context *ctx);
    static duk_ret_t js_servo(duk_context *ctx);    // 50 Hz via LEDC (API 10)
    static duk_ret_t js_servoOff(duk_context *ctx);

    // Display Bindings - Drawing
    static duk_ret_t js_fillScreen(duk_context *ctx);
    static duk_ret_t js_fillRect(duk_context *ctx);
    static duk_ret_t js_drawRect(duk_context *ctx);
    static duk_ret_t js_drawFastVLine(duk_context *ctx);
    static duk_ret_t js_drawFastHLine(duk_context *ctx);
    static duk_ret_t js_drawLine(duk_context *ctx);
    static duk_ret_t js_drawPixel(duk_context *ctx);
    static duk_ret_t js_drawCircle(duk_context *ctx);
    static duk_ret_t js_fillCircle(duk_context *ctx);
    static duk_ret_t js_drawTriangle(duk_context *ctx);
    static duk_ret_t js_fillTriangle(duk_context *ctx);
    static duk_ret_t js_drawRoundRect(duk_context *ctx);
    static duk_ret_t js_fillRoundRect(duk_context *ctx);
    static duk_ret_t js_drawBMP(duk_context *ctx);
    static duk_ret_t js_drawPNG(duk_context *ctx);
    static duk_ret_t js_drawJPG(duk_context *ctx);

    // Display Bindings - Text
    static duk_ret_t js_drawString(duk_context *ctx);
    static duk_ret_t js_setTextColor(duk_context *ctx);
    static duk_ret_t js_setTextSize(duk_context *ctx);
    static duk_ret_t js_setTextDatum(duk_context *ctx);  // API 12

    // Storage (API 12): chave-valor NVS privado por packageName
    static duk_ret_t js_storageGet(duk_context *ctx);
    static duk_ret_t js_storageSet(duk_context *ctx);
    static duk_ret_t js_storageRemove(duk_context *ctx);
    static duk_ret_t js_storageClear(duk_context *ctx);
    static duk_ret_t js_storageClearFor(duk_context *ctx);  // system-gated

    // Energia/tela e alarme (API 12)
    static duk_ret_t js_setScreenTimeout(duk_context *ctx);
    static duk_ret_t js_screenTimeout(duk_context *ctx);
    static duk_ret_t js_deepSleep(duk_context *ctx);  // "system"
    static duk_ret_t js_setAlarm(duk_context *ctx);
    static duk_ret_t js_clearAlarm(duk_context *ctx);
    static duk_ret_t js_getAlarm(duk_context *ctx);
    static duk_ret_t js_alarms(duk_context *ctx);        // API 15: Kernel/Alarms
    static duk_ret_t js_addAlarm(duk_context *ctx);
    static duk_ret_t js_updateAlarm(duk_context *ctx);
    static duk_ret_t js_removeAlarm(duk_context *ctx);
    static duk_ret_t js_setTimer(duk_context *ctx);
    static duk_ret_t js_getTimer(duk_context *ctx);
    static duk_ret_t js_cancelTimer(duk_context *ctx);
    static duk_ret_t js_unreadNotifications(duk_context *ctx);  // API 15
    static duk_ret_t js_playTone(duk_context *ctx);   // sequencia de notas
    static duk_ret_t js_playWav(duk_context *ctx);   // arquivo WAV (API 13)
    static duk_ret_t js_playMusic(duk_context *ctx);   // chiptune N trilhas (API 25)
    static duk_ret_t js_musicStop(duk_context *ctx);   // corta a musica (API 25)
    static duk_ret_t js_sfx(duk_context *ctx);         // efeito misturado, nao bloqueia (API 32)
    static duk_ret_t js_musicPlaying(duk_context *ctx);  // tocando? (API 25)
    static duk_ret_t js_musicPos(duk_context *ctx);   // ms desde o inicio (API 25)

    // Sensors do IMU da placa (API 13: watch)
    static duk_ret_t js_sensorsAccel(duk_context *ctx);   // {x,y,z} em g
    static duk_ret_t js_sensorsSteps(duk_context *ctx);   // passos do dia
    static duk_ret_t js_sensorsTemp(duk_context *ctx);    // die do IMU, °C
    static duk_ret_t js_sensorsStepHistory(duk_context *ctx);  // API 15: dias fechados
    static duk_ret_t js_getWeekday(duk_context *ctx);     // 0=dom..6=sab
    static duk_ret_t js_keepAwake(duk_context *ctx);      // jogos: tela acesa
    static duk_ret_t js_notify(duk_context *ctx);     // toast + historico
    static duk_ret_t js_notifications(duk_context *ctx);      // lista (system)
    static duk_ret_t js_notificationsClear(duk_context *ctx); // limpar (system)

    // Display Bindings - Utility
    static duk_ret_t js_color(duk_context *ctx);
    static duk_ret_t js_screenWidth(duk_context *ctx);
    static duk_ret_t js_screenHeight(duk_context *ctx);
    static duk_ret_t js_setNativeCanvas(duk_context *ctx);  // API 28

    // Touch Input
    static duk_ret_t js_getTouch(duk_context *ctx);
    static duk_ret_t js_getTouches(duk_context *ctx);  // API 43: multi-dedo
    static duk_ret_t js_button(duk_context *ctx);  // API 17: botao fisico (buttonToApp)

    // Primitivas extras (API 22)
    static duk_ret_t js_fillGradient(duk_context *ctx);
    static duk_ret_t js_fillArc(duk_context *ctx);
    static duk_ret_t js_fillSmoothCircle(duk_context *ctx);
    static duk_ret_t js_fillSmoothRoundRect(duk_context *ctx);
    static duk_ret_t js_drawWideLine(duk_context *ctx);
    static duk_ret_t js_mixColor(duk_context *ctx);

    // Toolkit UI imediato (API 22, JsUi.cpp): mesmo visual do Kui
    static duk_ret_t js_uiBegin(duk_context *ctx);
    static duk_ret_t js_uiEnd(duk_context *ctx);
    static duk_ret_t js_uiInvalidate(duk_context *ctx);
    static duk_ret_t js_uiTouch(duk_context *ctx);
    static duk_ret_t js_uiToast(duk_context *ctx);
    static duk_ret_t js_uiText(duk_context *ctx);
    static duk_ret_t js_uiMeasure(duk_context *ctx);
    static duk_ret_t js_uiLineHeight(duk_context *ctx);
    static duk_ret_t js_uiMeasureWrap(duk_context *ctx);
    static duk_ret_t js_uiScrollTo(duk_context *ctx);
    static duk_ret_t js_uiHeader(duk_context *ctx);
    static duk_ret_t js_uiButton(duk_context *ctx);
    static duk_ret_t js_uiToggle(duk_context *ctx);
    static duk_ret_t js_uiSlider(duk_context *ctx);
    static duk_ret_t js_uiProgress(duk_context *ctx);
    static duk_ret_t js_uiSpinner(duk_context *ctx);
    static duk_ret_t js_uiList(duk_context *ctx);
    static duk_ret_t js_uiTabs(duk_context *ctx);
    static duk_ret_t js_uiCard(duk_context *ctx);
    static duk_ret_t js_uiCardEnd(duk_context *ctx);
    static duk_ret_t js_uiScrollBegin(duk_context *ctx);
    static duk_ret_t js_uiScrollEnd(duk_context *ctx);
    static duk_ret_t js_uiResetScroll(duk_context *ctx);
    static duk_ret_t js_uiBadge(duk_context *ctx);
    static duk_ret_t js_uiConfirm(duk_context *ctx);
    static duk_ret_t js_uiAlert(duk_context *ctx);
    static void uiReset();  // reset por app (init)

    // System Utilities
    static duk_ret_t js_millis(duk_context *ctx);
    static duk_ret_t js_micros(duk_context *ctx);
    static duk_ret_t js_delay(duk_context *ctx);
    static duk_ret_t js_delayMicroseconds(duk_context *ctx);
    static duk_ret_t js_print(duk_context *ctx);
    static duk_ret_t js_getTemperature(duk_context *ctx);
    static duk_ret_t js_hasTemperatureSensor(duk_context *ctx);
    static duk_ret_t js_getInfo(duk_context *ctx);
    static duk_ret_t js_restart(duk_context *ctx);

    static duk_ret_t js_getTime(duk_context *ctx);
    static duk_ret_t js_getSeconds(duk_context *ctx);
    static duk_ret_t js_epoch(duk_context *ctx);  // UTC em segundos (API 49)
    static duk_ret_t js_getDate(duk_context *ctx);
    static duk_ret_t js_getYear(duk_context *ctx);
    static duk_ret_t js_getMonth(duk_context *ctx);
    static duk_ret_t js_getDay(duk_context *ctx);
    static duk_ret_t js_getTimezone(duk_context *ctx);
    
    static duk_ret_t js_getOSVersion(duk_context *ctx);
    static duk_ret_t js_getAPILevel(duk_context *ctx);

    // Network Bindings
    static duk_ret_t js_getIPAddress(duk_context *ctx);
    static duk_ret_t js_isWiFiActive(duk_context *ctx);

    // Network Bindings - HTTP (objeto Net, API level 2)
    static duk_ret_t js_netGet(duk_context *ctx);
    static duk_ret_t js_netGetJSON(duk_context *ctx);
    static duk_ret_t js_netPost(duk_context *ctx);
    static duk_ret_t js_netRequest(duk_context *ctx);  // headers proprios + status (API 49)
    static duk_ret_t js_netDownload(duk_context *ctx);  // streaming p/ arquivo (API 6)
    static duk_ret_t js_netIsConnected(duk_context *ctx);

    // FileSystem Bindings
    static duk_ret_t js_readTextFile(duk_context *ctx);
    static duk_ret_t js_writeTextFile(duk_context *ctx);
    static duk_ret_t js_appendTextFile(duk_context *ctx);
    static duk_ret_t js_readFile(duk_context *ctx);    // binario (API 12)
    static duk_ret_t js_writeFile(duk_context *ctx);   // binario (API 12)
    static duk_ret_t js_deleteFile(duk_context *ctx);
    static duk_ret_t js_renameFile(duk_context *ctx);
    static duk_ret_t js_fileExists(duk_context *ctx);
    static duk_ret_t js_listDir(duk_context *ctx);
    static duk_ret_t js_mkdir(duk_context *ctx);
    static duk_ret_t js_rmdir(duk_context *ctx);
    static duk_ret_t js_isDirectory(duk_context *ctx);
    static duk_ret_t js_isFile(duk_context *ctx);
    static duk_ret_t js_getFileSize(duk_context *ctx);
    static duk_ret_t js_getTotalSpace(duk_context *ctx);
    static duk_ret_t js_getUsedSpace(duk_context *ctx);
    static duk_ret_t js_getFreeSpace(duk_context *ctx);
    static duk_ret_t js_getFileMD5(duk_context *ctx);
    static duk_ret_t js_mountSD(duk_context *ctx);
    static duk_ret_t js_unmountSD(duk_context *ctx);

    // Keyboard Bindings
    static duk_ret_t js_prompt(duk_context *ctx);

    // Keyboard acoplado (System.keypad*, API level 5 — sessao nao-bloqueante)
    static duk_ret_t js_keypadOpen(duk_context *ctx);
    static duk_ret_t js_keypadPoll(duk_context *ctx);
    static duk_ret_t js_keypadText(duk_context *ctx);
    static duk_ret_t js_keypadRect(duk_context *ctx);
    static duk_ret_t js_keypadDraw(duk_context *ctx);
    static duk_ret_t js_keypadClose(duk_context *ctx);

    // Topbar custom (API level 6) — texto e chips da faixa
    static duk_ret_t js_topbarText(duk_context *ctx);
    static duk_ret_t js_topbarButtons(duk_context *ctx);
    static duk_ret_t js_topbarPop(duk_context *ctx);

    // System nivel 3 (apps de sistema em JS — W8)
    static duk_ret_t js_textWidth(duk_context *ctx);
    static duk_ret_t js_fontHeight(duk_context *ctx);
    static duk_ret_t js_theme(duk_context *ctx);
    static duk_ret_t js_drawIcon(duk_context *ctx);
    static duk_ret_t js_copyFile(duk_context *ctx);
    static duk_ret_t js_copyDirectory(duk_context *ctx);
    static duk_ret_t js_removeDirectory(duk_context *ctx);
    static duk_ret_t js_setBrightness(duk_context *ctx);
    static duk_ret_t js_getBrightness(duk_context *ctx);
    static duk_ret_t js_setVolume(duk_context *ctx);   // API 13 (audio)
    static duk_ret_t js_getVolume(duk_context *ctx);
    static duk_ret_t js_backlightSupported(duk_context *ctx);
    static duk_ret_t js_openWifiSetup(duk_context *ctx);
    static duk_ret_t js_exitApp(duk_context *ctx);
    static duk_ret_t js_launchApp(duk_context *ctx);  // API 16
    static duk_ret_t js_present(duk_context *ctx);
    static duk_ret_t js_setClip(duk_context *ctx);
    static duk_ret_t js_clearClip(duk_context *ctx);
    static duk_ret_t js_isBuffered(duk_context *ctx);
    static duk_ret_t js_wifiStatus(duk_context *ctx);
    static duk_ret_t js_md5(duk_context *ctx);
    static duk_ret_t js_setPin(duk_context *ctx);
    static duk_ret_t js_verifyPin(duk_context *ctx);
    static duk_ret_t js_pinClear(duk_context *ctx);
    static duk_ret_t js_pinState(duk_context *ctx);
    static duk_ret_t js_webAuthInfo(duk_context *ctx);
    static duk_ret_t js_webAuthSetPass(duk_context *ctx);
    static duk_ret_t js_setting(duk_context *ctx);
    static duk_ret_t js_toast(duk_context *ctx);
    static duk_ret_t js_beep(duk_context *ctx);
    static duk_ret_t js_led(duk_context *ctx);
    static duk_ret_t js_relay(duk_context *ctx);
    static duk_ret_t js_relayState(duk_context *ctx);
    static duk_ret_t js_relayCount(duk_context *ctx);
    static duk_ret_t js_battery(duk_context *ctx);
    static duk_ret_t js_batteryInfo(duk_context *ctx);  // API 15
    static duk_ret_t js_micLevel(duk_context *ctx);
    static duk_ret_t js_touchPad(duk_context *ctx);
    static duk_ret_t js_neopixel(duk_context *ctx);
    static duk_ret_t js_setAutoBrightness(duk_context *ctx);
    static duk_ret_t js_getAutoBrightness(duk_context *ctx);
    static duk_ret_t js_lightLevel(duk_context *ctx);
    static duk_ret_t js_appData(duk_context *ctx);
    static duk_ret_t js_rescanApps(duk_context *ctx);
    static duk_ret_t js_factoryReset(duk_context *ctx);
    static duk_ret_t js_otaCheck(duk_context *ctx);
    static duk_ret_t js_otaStart(duk_context *ctx);
    static duk_ret_t js_installZip(duk_context *ctx);
    static duk_ret_t js_setTimezone(duk_context *ctx);
    static duk_ret_t js_setManualTime(duk_context *ctx);
    static duk_ret_t js_set24hFormat(duk_context *ctx);
    static duk_ret_t js_get24hFormat(duk_context *ctx);
    static duk_ret_t js_setNtpEnabled(duk_context *ctx);
    static duk_ret_t js_getNtpEnabled(duk_context *ctx);
    static duk_ret_t js_webActive(duk_context *ctx);
    static duk_ret_t js_webSetActive(duk_context *ctx);

    // Net assincrono (F3): handle + poll
    static duk_ret_t js_netBeginGet(duk_context *ctx);
    static duk_ret_t js_netPollGet(duk_context *ctx);
    static duk_ret_t js_netCancelGet(duk_context *ctx);
    // Descarta zumbis/resultados do app anterior (chamado no init de cada app)
    static void netAsyncReset();

    // AI (API 18): chat LLM com callback (DeepSeek/OpenRouter pelo
    // opts.provider). A chave fica no aparelho (/local/<provider>_key.txt,
    // protegida pelo jail do FS) e nunca entra no JS
    static duk_ret_t js_aiChat(duk_context *ctx);        // opts + cb 1x
    static duk_ret_t js_aiSpeak(duk_context *ctx);       // opts + cb 1x (TTS, API 24)
    static duk_ret_t js_aiWarm(duk_context *ctx);        // [provider] -> abre o TLS antes (API 24)
    static duk_ret_t js_aiConfigured(duk_context *ctx);  // chave presente?
    static duk_ret_t js_aiCancel(duk_context *ctx);      // esquece a requisicao
    static void aiTick(duk_context *ctx);                // entrega no present()
    static void aiReset();                               // reset por app

    // Mic (API 19): gravacao de microfone — capability "mic" (JsMic.cpp)
    static duk_ret_t js_micRecStart(duk_context *ctx);    // Mic.start({ms})
    static duk_ret_t js_micRecStop(duk_context *ctx);     // Mic.stop({raw}) -> base64|wav|null
    static duk_ret_t js_micRecRecording(duk_context *ctx); // Mic.recording()
    static duk_ret_t js_micRecLevel(duk_context *ctx);    // Mic.level()

    // Input (API 48): barramento de input do OS — capability "input".
    // Um driver JS injeta; qualquer app com a permissao le (JsInput.cpp).
    static duk_ret_t js_inputKey(duk_context *ctx);       // Input.key(usage, mods, down)
    static duk_ret_t js_inputPoll(duk_context *ctx);      // Input.poll() -> {key,mods,down}|null
    static duk_ret_t js_inputMove(duk_context *ctx);      // Input.move(x, y, buttons)
    static duk_ret_t js_inputPointer(duk_context *ctx);   // Input.pointer() -> {x,y,buttons}
    static duk_ret_t js_inputClear(duk_context *ctx);     // Input.clear()
#include "sdkconfig.h"
#if CONFIG_CELEROS_USB_HOST
    // USB Host (API 48) — capability "usb" (JsUsb.cpp). Drivers de
    // dispositivo sao JS; aqui so o hardware cru.
    static duk_ret_t js_usbDevices(duk_context *ctx);
    static duk_ret_t js_usbPoll(duk_context *ctx);
    static duk_ret_t js_usbClaim(duk_context *ctx);
    static duk_ret_t js_usbRelease(duk_context *ctx);
    static duk_ret_t js_usbControlIn(duk_context *ctx);
    static duk_ret_t js_usbControlOut(duk_context *ctx);
    static duk_ret_t js_usbOut(duk_context *ctx);
    static duk_ret_t js_usbIn(duk_context *ctx);
    static duk_ret_t js_usbSendFile(duk_context *ctx);
    static duk_ret_t js_usbListen(duk_context *ctx);
    static duk_ret_t js_usbRead(duk_context *ctx);
    static duk_ret_t js_usbUnlisten(duk_context *ctx);
    static duk_ret_t js_usbFlush(duk_context *ctx);
    static void usbAppReset();                            // solta claims/listeners do app
#endif
#if CONFIG_CELEROS_JS_CAMERA
    // Camera (API 35): OV2640 da esp32-cam — capability "camera" (JsCamera.cpp)
    static duk_ret_t js_cameraSetup(duk_context *ctx);    // Camera.setup({framesize,pixformat,fbcount,xclkMhz})
    static duk_ret_t js_cameraCapture(duk_context *ctx);  // Camera.capture() -> {id,w,h,len,format}|null
    static duk_ret_t js_cameraSave(duk_context *ctx);     // Camera.save(id, path) -> bytes|-1
    static duk_ret_t js_cameraFree(duk_context *ctx);     // Camera.free(id)
    static duk_ret_t js_cameraLed(duk_context *ctx);      // Camera.led(bool) — flash do sensor
    static duk_ret_t js_cameraScanQR(duk_context *ctx);   // Camera.scanQR({timeoutMs,attempts,led}) -> string|null
    static void cameraAppReset();                         // teardown por app
#endif
#if CONFIG_CELEROS_WAKE_WORD
    static duk_ret_t js_wakeStart(duk_context *ctx);      // WakeWord.start()
    static duk_ret_t js_wakeStop(duk_context *ctx);       // WakeWord.stop()
    static duk_ret_t js_wakePoll(duk_context *ctx);       // WakeWord.poll() -> bool
    static duk_ret_t js_wakeLevel(duk_context *ctx);      // WakeWord.level() -> 0..100
    static duk_ret_t js_wakeRunning(duk_context *ctx);    // WakeWord.running()
#endif

    // Net nivel 3 (WiFi)
    static duk_ret_t js_wifiScan(duk_context *ctx);
    static duk_ret_t js_wifiConnect(duk_context *ctx);
    static duk_ret_t js_wifiDisconnect(duk_context *ctx);

    // Celer Link Bluetooth (objeto global CelerLink, API 9 — requer
    // CONFIG_CELEROS_BLUETOOTH; desligado, o objeto nao existe).
    // Pareamento por codigo: API 11 (verify/unpair, start com opts).
    static duk_ret_t js_linkStart(duk_context *ctx);
    static duk_ret_t js_linkStop(duk_context *ctx);
    static duk_ret_t js_linkScan(duk_context *ctx);
    static duk_ret_t js_linkConnect(duk_context *ctx);
    static duk_ret_t js_linkDisconnect(duk_context *ctx);
    static duk_ret_t js_linkSend(duk_context *ctx);
    static duk_ret_t js_linkPoll(duk_context *ctx);
    static duk_ret_t js_linkSendSealed(duk_context *ctx);  // CelerLink.sendSealed (API 21)
    static duk_ret_t js_linkPollSealed(duk_context *ctx);  // CelerLink.pollSealed (API 21)
    static duk_ret_t js_linkStatus(duk_context *ctx);
    static duk_ret_t js_linkVerify(duk_context *ctx);
    static duk_ret_t js_linkUnpair(duk_context *ctx);

    // CelerNet (objeto global CelerNet, API 26 — malha BLE por flood de
    // advertising; requer CONFIG_CELEROS_BLUETOOTH). v2 na API 27: send
    // (unicast), caps no nodes/poll.
    static duk_ret_t js_meshStart(duk_context *ctx);
    static duk_ret_t js_meshStop(duk_context *ctx);
    static duk_ret_t js_meshBroadcast(duk_context *ctx);
    static duk_ret_t js_meshSend(duk_context *ctx);  // CelerNet.send (API 27)
    static duk_ret_t js_meshPoll(duk_context *ctx);
    static duk_ret_t js_meshNodes(duk_context *ctx);
    static duk_ret_t js_meshStatus(duk_context *ctx);

    // Pack (objeto global Pack, API 27 — matilha: membros com papel,
    // envelopes custom e handoff de musica; requer CONFIG_CELEROS_BLUETOOTH).
    static duk_ret_t js_packMe(duk_context *ctx);
    static duk_ret_t js_packMembers(duk_context *ctx);
    static duk_ret_t js_packSend(duk_context *ctx);
    static duk_ret_t js_packResources(duk_context *ctx);
    static duk_ret_t js_packOpen(duk_context *ctx);
    static duk_ret_t js_packStatus(duk_context *ctx);
    static duk_ret_t js_packRead(duk_context *ctx);
    static duk_ret_t js_packOnEvent(duk_context *ctx);
    static duk_ret_t js_packRuleAdd(duk_context *ctx);
    static duk_ret_t js_packRuleDel(duk_context *ctx);
    static duk_ret_t js_packRuleList(duk_context *ctx);
    static duk_ret_t js_packWrite(duk_context *ctx);
    static duk_ret_t js_packClose(duk_context *ctx);
    static duk_ret_t js_packExpose(duk_context *ctx);
    static duk_ret_t js_packUnexpose(duk_context *ctx);
    static duk_ret_t js_packPublish(duk_context *ctx);
    static duk_ret_t js_packSessions(duk_context *ctx);
    static duk_ret_t js_packPollWrite(duk_context *ctx);
    static duk_ret_t js_packListen(duk_context *ctx);
    static duk_ret_t js_packSpeak(duk_context *ctx);
    static duk_ret_t js_packRecord(duk_context *ctx);
    static duk_ret_t js_packRecording(duk_context *ctx);
    static duk_ret_t js_packLevel(duk_context *ctx);
    static duk_ret_t js_packRecordStop(duk_context *ctx);
    static duk_ret_t js_packSnap(duk_context *ctx);
    static duk_ret_t js_packView(duk_context *ctx);
    static duk_ret_t js_packDrawFrame(duk_context *ctx);
    static duk_ret_t js_packPoll(duk_context *ctx);
    static duk_ret_t js_packHandoffMusic(duk_context *ctx);
    static duk_ret_t js_packJoin(duk_context *ctx);
    static duk_ret_t js_packLeave(duk_context *ctx);
    static duk_ret_t js_packAcceptInvite(duk_context *ctx);
    static duk_ret_t js_packInvite(duk_context *ctx);
    static duk_ret_t js_packInviteStatus(duk_context *ctx);

    // Phone (API 15, CONFIG_CELEROS_PHONE_LINK): celular via Gadgetbridge
    static duk_ret_t js_phoneStatus(duk_context *ctx);
    static duk_ret_t js_phoneSetEnabled(duk_context *ctx);
    static duk_ret_t js_phoneMusic(duk_context *ctx);
    static duk_ret_t js_phoneMusicInfo(duk_context *ctx);
    static duk_ret_t js_phoneWeather(duk_context *ctx);
    static duk_ret_t js_phoneFind(duk_context *ctx);
    static duk_ret_t js_phoneForget(duk_context *ctx);

public:
    // ---- Superficie dos SERVICOS em segundo plano (API 42, JsSvc.cpp) ----
    // putFns publica para os modulos que montam superficie propria (JsSvc)
    struct JsFn {
        const char* name;
        duk_c_function fn;
        duk_idx_t nargs;
    };
    static void putFns(duk_context *ctx, const JsFn* fns, int n);
    // forma de tabela estatica (a usada em init()): herda o N do array
    template <size_t N>
    static void putFns(duk_context* ctx, const JsFn (&fns)[N]) {
        putFns(ctx, fns, (int)N);
    }

    // Troca de identidade para o svchost (API 42): o dispatch de um servico
    // roda os MESMOS bindings com pkg/perms/pasta/ctx dele (single task, sem
    // corrida); restore devolve a identidade do app antes do dispatch.
    static void svcIdentity(duk_context* thr, const char* appPkg, uint32_t perms, const char* appDir);
    static void svcIdentityRestore();

    // Getters de gate para a politica dos servicos (API 42, PERM_SYSTEM)
    static duk_ret_t js_appOpen(duk_context *ctx);
    static duk_ret_t js_updateBusy(duk_context *ctx);
    static duk_ret_t js_shellActive(duk_context *ctx);
    static duk_ret_t js_syncTime(duk_context *ctx);
    static duk_ret_t js_timeValid(duk_context *ctx);
    static duk_ret_t js_persistTime(duk_context *ctx);
    static duk_ret_t js_svcStop(duk_context *ctx);

    friend void SvcApi::install(duk_context* thr, const char* appPkg, uint32_t perms,
                                const char* appDir);
};

// Superficie dos servicos (JsSvc.cpp): registra o subconjunto sem UI na
// thread do servico e media o Service.stop() pedido dentro do pcall.
namespace SvcApi {
void install(duk_context* thr, const char* appPkg, uint32_t perms, const char* appDir);
bool consumeStopRequest();
}  // namespace SvcApi

#endif // JS_BINDINGS_H
