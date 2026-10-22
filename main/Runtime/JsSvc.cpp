#include "JSBindings.h"
#include "sdkconfig.h"
#include "JsInternal.h"
#include "JsFsJail.h"
#include <string.h>
#include <Arduino.h>

// =====================================================
// Superficie JS dos SERVICOS em segundo plano (API 42)
// =====================================================
//
// O svchost (Kernel/AppServices) cria UM heap Duktape compartilhado e uma
// THREAD por servico (global object proprio). Cada thread recebe daqui o
// subconjunto da API que faz sentido fora do vidro:
//
//   - globais de timer (host próprio do svchost, disparam no pump dele)
//   - require() da propria pasta do app (mesmo carregador do app;
//     o s_appDir global e trocado pelo dispatch — single task, sem corrida)
//   - Storage (NVS privado do packageName) e FS com a jail de sempre
//   - objeto System ENXUTO: leitura de hora/bateria/rede, setting,
//     otaCheck, installZip, notify e os getters de gate da politica
//   - objeto Service: controle do proprio servico (stop)
//
// FORA de proposito no svchost v1: UI/touch/desenho (o vidro e do app em
// foreground), Net.* (async entregue no present do app; os servicos usam
// System.otaCheck sincrono), AI/Mic/Camera/WakeWord/Phone (tasks e hardware
// que competem com o app). Tudo isso continua existindo para o APP; um
// servico que precisa deles deve pedir ao usuario para abrir o app.

namespace {

// O servico corrente pediu a propria parada (Service.stop()): o dispatch
// consulta e consome depois do pcall; o svchost nao reagenda os timers dele.
bool s_svcStopRequested = false;

}  // namespace

duk_ret_t JSBindings::js_svcStop(duk_context *ctx) {
    (void)ctx;
    s_svcStopRequested = true;
    return 0;
}

namespace SvcApi {

bool consumeStopRequest() {
    bool v = s_svcStopRequested;
    s_svcStopRequested = false;
    return v;
}

void install(duk_context* thr, const char* appPkg, uint32_t perms, const char* appDir) {
    // A IDENTIDADE (pkg/perms/pasta) NAO e daqui: quem troca e o chamador —
    // em volta do compile+top-level (AppServices::loadService) e de cada
    // callback (hooks do host de timers). Aqui so instala a superficie.
    (void)appPkg;
    (void)perms;
    (void)appDir;

    // ---- globais de timer (mesmas assinaturas do app) ----
    duk_push_global_object(thr);
    static const JSBindings::JsFn kSvcTimers[] = {
        {"setTimeout", JSBindings::js_setTimeout, 2},
        {"setInterval", JSBindings::js_setInterval, 2},
        {"clearTimeout", JSBindings::js_clearTimeout, 1},
        {"clearInterval", JSBindings::js_clearInterval, 1},
        {"require", JSBindings::js_require, 1},
    };
    JSBindings::putFns(thr, kSvcTimers, 5);

    // ---- objeto System enxuto (leitura + gates + acoes de sistema) ----
    duk_push_object(thr);
    static const JSBindings::JsFn kSvcSys[] = {
        {"getTime", JSBindings::js_getTime, 0},
        {"getSeconds", JSBindings::js_getSeconds, 0},
        {"getDate", JSBindings::js_getDate, 0},
        {"getYear", JSBindings::js_getYear, 0},
        {"getMonth", JSBindings::js_getMonth, 0},
        {"getDay", JSBindings::js_getDay, 0},
        {"getWeekday", JSBindings::js_getWeekday, 0},
        {"millis", JSBindings::js_millis, 0},
        {"getTimezone", JSBindings::js_getTimezone, 0},
        {"syncTime", JSBindings::js_syncTime, 0},          // API 42
        {"timeValid", JSBindings::js_timeValid, 0},        // API 42
        {"persistTime", JSBindings::js_persistTime, 0},    // API 42
        {"getInfo", JSBindings::js_getInfo, 0},
        {"getOSVersion", JSBindings::js_getOSVersion, 0},
        {"getAPILevel", JSBindings::js_getAPILevel, 0},
        {"wifiStatus", JSBindings::js_wifiStatus, 0},
        {"battery", JSBindings::js_battery, 0},
        {"batteryInfo", JSBindings::js_batteryInfo, 0},
        {"setting", JSBindings::js_setting, 2},
        {"md5", JSBindings::js_md5, 1},
        {"otaCheck", JSBindings::js_otaCheck, 0},
        {"installZip", JSBindings::js_installZip, 2},
        {"notify", JSBindings::js_notify, 2},
        {"print", JSBindings::js_print, 1},                // log do servico
        {"appOpen", JSBindings::js_appOpen, 0},            // API 42
        {"updateBusy", JSBindings::js_updateBusy, 0},      // API 42
        {"shellActive", JSBindings::js_shellActive, 0},    // API 42
    };
    JSBindings::putFns(thr, kSvcSys, 27);
    duk_put_prop_string(thr, -2, "System");

    // ---- Service: controle do proprio servico ----
    duk_push_object(thr);
    static const JSBindings::JsFn kSvcSelf[] = {
        {"stop", JSBindings::js_svcStop, 0},
    };
    JSBindings::putFns(thr, kSvcSelf, 1);
    duk_put_prop_string(thr, -2, "Service");

    // ---- Storage (NVS privado do packageName do servico) ----
    duk_push_object(thr);
    static const JSBindings::JsFn kSvcStorage[] = {
        {"get", JSBindings::js_storageGet, 2},
        {"set", JSBindings::js_storageSet, 2},
        {"remove", JSBindings::js_storageRemove, 1},
        {"clear", JSBindings::js_storageClear, 0},
    };
    JSBindings::putFns(thr, kSvcStorage, 4);
    duk_put_prop_string(thr, -2, "Storage");

    duk_pop(thr);  // global object

    // ---- FS com a jail de sempre (so com a perm) ----
    if (perms & celer::PERM_FS) {
        duk_push_global_object(thr);
        duk_push_object(thr);
        static const JSBindings::JsFn kSvcFs[] = {
            {"readTextFile", JSBindings::js_readTextFile, 1},
            {"readFile", JSBindings::js_readFile, 2},
            {"writeTextFile", JSBindings::js_writeTextFile, 2},
            {"writeFile", JSBindings::js_writeFile, 2},
            {"appendTextFile", JSBindings::js_appendTextFile, 2},
            {"deleteFile", JSBindings::js_deleteFile, 1},
            {"renameFile", JSBindings::js_renameFile, 2},
            {"exists", JSBindings::js_fileExists, 1},
            {"listDir", JSBindings::js_listDir, 1},
            {"mkdir", JSBindings::js_mkdir, 1},
            {"rmdir", JSBindings::js_rmdir, 1},
            {"isDirectory", JSBindings::js_isDirectory, 1},
            {"isFile", JSBindings::js_isFile, 1},
            {"getFileSize", JSBindings::js_getFileSize, 1},
            {"getFreeSpace", JSBindings::js_getFreeSpace, 1},
            {"getFileMD5", JSBindings::js_getFileMD5, 1},
            {"copyFile", JSBindings::js_copyFile, 2},
            {"removeDirectory", JSBindings::js_removeDirectory, 1},
            {"appData", JSBindings::js_appData, 0},
        };
        JSBindings::putFns(thr, kSvcFs, 19);
        duk_put_prop_string(thr, -2, "FS");
        duk_pop(thr);
    }

    // ---- Input + USB (API 48): o driver HID/impressora roda de fundo ----
    // Mesma superficie do app (o servico tem as permissoes declaradas no
    // app.json; sem elas o objeto nem nasce).
    duk_push_global_object(thr);
    if (perms & celer::PERM_INPUT) {
        duk_push_object(thr);
        static const JSBindings::JsFn kSvcInput[] = {
            {"key", JSBindings::js_inputKey, 3},
            {"poll", JSBindings::js_inputPoll, 0},
            {"move", JSBindings::js_inputMove, 3},
            {"pointer", JSBindings::js_inputPointer, 0},
            {"clear", JSBindings::js_inputClear, 0},
        };
        JSBindings::putFns(thr, kSvcInput, 5);
        duk_put_prop_string(thr, -2, "Input");
    }
#if CONFIG_CELEROS_USB_HOST
    if (perms & celer::PERM_USB) {
        duk_push_object(thr);
        static const JSBindings::JsFn kSvcUsb[] = {
            {"devices", JSBindings::js_usbDevices, 0},
            {"poll", JSBindings::js_usbPoll, 0},
            {"claim", JSBindings::js_usbClaim, 3},
            {"release", JSBindings::js_usbRelease, 2},
            {"controlIn", JSBindings::js_usbControlIn, 7},
            {"controlOut", JSBindings::js_usbControlOut, 7},
            {"out", JSBindings::js_usbOut, 4},
            {"in", JSBindings::js_usbIn, 4},
            {"sendFile", JSBindings::js_usbSendFile, 5},
            {"listen", JSBindings::js_usbListen, 4},
            {"read", JSBindings::js_usbRead, 2},
            {"unlisten", JSBindings::js_usbUnlisten, 2},
            {"flush", JSBindings::js_usbFlush, 2},
        };
        JSBindings::putFns(thr, kSvcUsb, 13);
        duk_put_prop_string(thr, -2, "USB");
    }
#endif
    duk_pop(thr);

#if CONFIG_CELEROS_BLUETOOTH
    // ---- CelerNet + Pack (a malha sobrevive a troca de app; o servico
    // drena com poll() como qualquer app) ----
    duk_push_global_object(thr);
    duk_push_object(thr);
    static const JSBindings::JsFn kSvcMesh[] = {
        {"broadcast", JSBindings::js_meshBroadcast, 2},
        {"send", JSBindings::js_meshSend, 3},
        {"poll", JSBindings::js_meshPoll, 0},
        {"nodes", JSBindings::js_meshNodes, 0},
        {"status", JSBindings::js_meshStatus, 0},
    };
    JSBindings::putFns(thr, kSvcMesh, 5);
    duk_put_prop_string(thr, -2, "CelerNet");

    duk_push_object(thr);
    static const JSBindings::JsFn kSvcPack[] = {
        {"me", JSBindings::js_packMe, 0},
        {"members", JSBindings::js_packMembers, 0},
        {"send", JSBindings::js_packSend, 3},
        {"poll", JSBindings::js_packPoll, 0},
    };
    JSBindings::putFns(thr, kSvcPack, 4);
    duk_put_prop_string(thr, -2, "Pack");
    duk_pop(thr);
#endif  // CONFIG_CELEROS_BLUETOOTH
}

}  // namespace SvcApi
