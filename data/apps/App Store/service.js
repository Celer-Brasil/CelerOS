// service.js - atualizacao automatica dos apps (API 50).
//
// Roda no svchost (sem vidro, sem UI): todo dia as 02:00 locais aplica o lote
// de atualizacoes dos apps instalados pelo app.zip do hub. Uma vez por dia
// (Storage.auto_day = dd/mm/yyyy); se o aparelho estava desligado, sem rede ou
// com app aberto as 02:00, a rodada acontece na primeira oportunidade do dia
// em que esses gates abrirem - a janela e aberta para tras de proposito.
//
// A politica esta no arquivo /local/appstore_auto.json (store.js):
//   {"auto":true,"hour":2,"pins":{"celeros.snake":1}}
// "pins" e a trava de versao do usuario (o app nao entra no lote automatico;
// o botao do detalhe na loja continua atualizando na mao).
//
// Gates (System.* do svchost): OTA em curso, shell/celerctl ativo e app em
// primeiro plano - o pump do svchost e o MESMO do loop, entao a rodada nao
// pode disputar o vidro com quem esta usando o aparelho. Sem PSRAM o heap do
// servico ja fica suspenso com app aberto; com PSRAM o gate evita o
// congelamento do frame durante os downloads.
//
// Watch (radio desligado com a tela apagada, wifi_sleep_min=10): se o firmware
// tiver System.wifiWake (API 53) o radio e acordado para a janela; sem ele a
// rodada cai no catch-up do dia (primeira vez com rede e sem app aberto).

var U = require("store");

var DAY_KEY = "auto_day";        // dd/mm/yyyy da ultima rodada concluida
var AT_KEY = "auto_at";          // quando foi a ultima rodada (diagnostico)
var RES_KEY = "auto_result";     // resultado da ultima rodada (texto curto)
var TICK_MS = 30000;             // giro do servico (o timer do svchost)
var RETRY_MS = 600000;           // plano/rede falhou: nova tentativa em 10 min
var MAX_LIST = 40;

var busy = false;
var nextTry = 0;

function log(m) { try { System.print("[auto] " + String(m)); } catch (e) {} }
function nowMs() { try { return Number(System.millis()) || 0; } catch (e) { return 0; } }
function txt(fn, d) { try { var v = fn(); return v === undefined || v === null ? d : String(v); } catch (e) { return d; } }
function storeGet(k, d) { try { var v = Storage.get(k, d); return v === undefined || v === null ? d : String(v); } catch (e) { return d; } }
function storeSet(k, v) { try { Storage.set(k, String(v)); return true; } catch (e) { return false; } }
function notify(t, m) { try { System.notify(t, m); } catch (e) {} }

// O svchost nao expoe present()/UI: estes gates dizem se o aparelho esta
// ocupado com algo que a rodada atrapalharia.
function gate() {
    try {
        if (System.updateBusy && System.updateBusy()) return "ota";
        if (System.shellActive && System.shellActive()) return "shell";
        if (System.appOpen && System.appOpen()) return "app";
    } catch (e) { /* API velha: sem gate */ }
    return "";
}

function wifiUp() { try { return Net.isConnected() === true; } catch (e) { return false; } }

// Placa que desliga o radio com a tela apagada: pede a janela de manutencao
// ao firmware, quando ele oferecer. Sem a API, o catch-up do dia cobre.
function wifiWake() {
    try {
        if (typeof System.wifiWake === "function") { System.wifiWake(10); return true; }
    } catch (e) { /* segue para o catch-up */ }
    return false;
}

function summary(done, fail) {
    var s = "";
    if (done.length) { s = done.length + (done.length === 1 ? " app atualizado: " : " apps atualizados: ");
        var names = [];
        for (var i = 0; i < done.length && i < 3; i++) names.push(done[i]);
        s += names.join(", ") + (done.length > names.length ? " (+" + (done.length - names.length) + ")" : ""); }
    if (fail.length) { if (s) s += " | "; s += fail.length + (fail.length === 1 ? " falhou: " : " falharam: ");
        for (var j = 0; j < fail.length && j < 2; j++) s += fail[j] + (j + 1 < fail.length && j + 1 < 2 ? ", " : ""); }
    return s;
}

function run() {
    var c = U.cfgLoad();
    if (!c.auto) return;                                   // rotina desligada na loja
    var timeValid = true;
    try { if (System.timeValid) timeValid = System.timeValid() === true; } catch (e) { timeValid = false; }
    if (!timeValid) return;                                // sem hora certa nao existe 02:00
    var day = txt(System.getDate, ""), time = txt(System.getTime, "");
    var last = storeGet(DAY_KEY, "");
    // Primeiro avistamento DEPOIS da hora configurada: marca o dia e nao roda
    // agora. Instalar a loja as 15h nao pode virar um lote de updates as 15h;
    // a primeira rodada automatica e a proxima 02:00. Antes da hora a rodada
    // de hoje ainda vem (o marcador nasce vazio e dueNow decide).
    if (!last) { var base0 = (c.hour === undefined || c.hour === null) ? 2 : c.hour, h0 = U.hourOf(time);
        if (h0 >= 0 && h0 >= base0) { storeSet(DAY_KEY, day);
            log("primeira rodada agendada para amanha as " + base0 + ":00"); return; } }
    if (!U.dueNow(c, last, time, day)) return;
    var g = gate();
    if (g) return;                                         // aparelho em uso: proximo giro
    if (!wifiUp()) { wifiWake(); return; }                  // sem rede: acorda o radio e volta
    var inst = U.scanInstalled();
    var list = U.planUpdates(inst, c, MAX_LIST);
    if (list === null) { nextTry = nowMs() + RETRY_MS; log("catalogo indisponivel"); return; }
    var res = { done: [], fail: [] };
    if (list.length) { log("lote: " + list.length + " app(s)"); res = U.runBatch(list, null); }
    // Marca o dia mesmo com falhas: repetir a rodada inteira a cada 30 s por
    // causa de um app quebrado castigaria a bateria. O resultado fica no
    // Storage (celerctl shell "apps log" mostra o print acima).
    storeSet(DAY_KEY, day);
    storeSet(AT_KEY, time + " " + day);
    var msg = summary(res.done, res.fail);
    storeSet(RES_KEY, msg || "nada a atualizar");
    log(msg || "nada a atualizar");
    if (res.done.length) notify("Apps atualizados", summary(res.done, []));
    else if (res.fail.length) notify("Atualizacao automatica", summary([], res.fail));
}

function tick() {
    if (busy) return;
    if (nowMs() < nextTry) return;
    busy = true;
    try { run(); } catch (e) { log("erro: " + (e && e.message ? e.message : e)); nextTry = nowMs() + RETRY_MS; }
    finally { busy = false; }
}

var startCfg = U.cfgLoad();
log("no ar: auto=" + (startCfg.auto ? "on" : "off") + " hora=" + startCfg.hour + " ult=" + storeGet(AT_KEY, "-"));
tick();
setInterval(tick, TICK_MS);
