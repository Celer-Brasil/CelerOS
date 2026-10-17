/* Nucleo — servico do OS (API 42). Politica migrada do firmware:
 *   - check automatico de atualizacao (era OtaManager::tickCheck +
 *     UpdateCheck.h): o QUANDO mora aqui; o COMO segue nativo (o
 *     System.otaCheck spawna a task de fetch de 16 KB).
 *   - cadencias do relogio (era TimeManager::tick): retry de SNTP a cada
 *     30 s enquanto a hora e invalida e persistencia do epoch a cada
 *     10 min. O TimeManager nativo vira watchdog: se este servico ficar
 *     15 min sem girar, as cadencias voltam para la (auto-cura).
 * 1 tick = 1 s (setInterval): contadores monotonicos, sem aritmetica de
 * relogio de parede. */
var pol = require("policy");

var GRACE_TICKS = 60;                 // 60 s pos-conexao (era kGraceMs)
var CHECK_INTERVAL_TICKS = 24 * 3600; // 24 h entre checks (era kIntervalMs)
var SYNC_EVERY_TICKS = 30;            // retry de SNTP (era 30000 ms)
var PERSIST_EVERY_TICKS = 600;        // saveEpoch (era 600000 ms)

var ticks = 0;
var connected = false;
var connectedAt = 0;                  // tick da ultima (re)conexao
var lastSync = -1000000;
var lastPersist = -1000000;
var checkedThisSession = false;
var lastCheckAt = 0;

function doCheck() {
    var r = System.otaCheck();        // bloqueante: fetch do update.json
    if (!r || r.fetchFailed || !r.available) return;
    var noted = Storage.get("noted_ver", "");
    if (pol.shouldNotify(noted, r.version)) {
        System.notify("Atualizacao " + r.version,
                      r.changelog ? r.changelog : "Nova versao disponivel.");
        Storage.set("noted_ver", r.version);  // reboot nao re-notifica
    }
}

function tick() {
    ticks++;

    // ---- relogio (era TimeManager::tick) ----
    if (!System.timeValid()) {
        if (ticks - lastSync >= SYNC_EVERY_TICKS) {
            lastSync = ticks;
            System.syncTime();
        }
    } else if (ticks - lastPersist >= PERSIST_EVERY_TICKS) {
        lastPersist = ticks;
        System.persistTime();
    }

    // ---- check de atualizacao (era UpdateCheck.h::due) ----
    var conn = System.wifiStatus().connected === true;
    if (conn && !connected) connectedAt = ticks;  // (re)conexao ancora o grace
    connected = conn;
    var st = {
        wifiConnected: conn,
        appOpen: System.appOpen() === true,
        busy: System.updateBusy() === true,
        shell: System.shellActive() === true,
        graceOk: conn && (ticks - connectedAt) >= GRACE_TICKS,
        intervalOk: !checkedThisSession || (ticks - lastCheckAt) >= CHECK_INTERVAL_TICKS
    };
    if (pol.shouldCheck(st)) {
        checkedThisSession = true;
        lastCheckAt = ticks;
        doCheck();  // falha de fetch tambem conta (nao martelar o hub caido)
    }
}

setInterval(tick, 1000);
