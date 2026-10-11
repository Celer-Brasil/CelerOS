// Bilheteria - gateway da malha (roda no no com internet, ex. SmartDisplay).
//
// NAO e app de fabrica: e o lado "gateway" da demo do modulo de camera na
// CelerNet. Drena o Pack.poll() a cada quadro (padrao Matilha/Sentinela),
// valida o ticket POR REGRA LOCAL e responde {t:'ok'} ao no-sensor. A
// validacao de verdade (API HTTP) entra no validate(): Net.post ja existe,
// e o slot de URL fica num Storage setting para nao recompilar app.
//
// 0.2: painel de verdade em 4 abas. Alem de validar, o gateway ADMINISTRA o
// no-camera pela malha (protocolo cmd/ack/stat/log do QrNode 0.2): status
// vivo, pause/retome, cfg (vga/led/intervalo/janela), foto no SD da cam,
// tail do log, reboot - tudo com ack e retry. Dados persistentes: placares
// em Storage, historico em appData/hist.txt (rotativo) e export CSV.
//
// Regra local da demo: ticket valido = "CEL-" + 6 hex, ainda nao usado
// (anti-reuso no Storage do gateway - trocar a bateria do no-sensor nao
// reemite).

var HIST_MAX_MEM = 100;   // eventos vivos na RAM (abas Validar/Dados)
var HIST_MAX_FILE = 200;  // linhas mantidas no hist.txt apos rotacao
var HIST_ROTATE = 16384;  // bytes que disparam a rotacao

var tabSel = 0;
var last = { code: "-", info: "aguardando o no-sensor...", valid: false };
var score = { ok: 0, no: 0 };                 // placar da sessao
var totals = { ok: 0, no: 0, un: 0, rw: 0 };   // placar persistido (Storage)

// ---- historico persistente (appData/hist.txt) ----
var histEvents = [];  // {t:"hh:mm", code, valid, info, node} mais recente ao fim
var histFile = "";

function histLoad() {
    if (typeof FS === "undefined") return;  // perm fs ainda nao concedida
    histFile = FS.appData() + "hist.txt";
    if (!FS.exists(histFile)) return;
    var txt = FS.readTextFile(histFile);
    if (txt === null || txt === "") return;
    var lines = txt.split("\n");
    var start = Math.max(0, lines.length - 1 - 30);
    for (var i = start; i < lines.length; i++) {
        var p = lines[i].split("|");
        if (p.length >= 4) histEvents.push({ t: p[0], code: p[1], valid: p[2] === "V", info: p[3], node: p[4] || "?" });
    }
}
function histAppend(ev) {
    histEvents.push(ev);
    if (histEvents.length > HIST_MAX_MEM) histEvents.shift();
    if (typeof FS === "undefined" || histFile === "") return;
    FS.appendTextFile(histFile, ev.t + "|" + ev.code + "|" + (ev.valid ? "V" : "X") + "|" + ev.info + "|" + ev.node + "\n");
    var sz = FS.getFileSize(histFile);
    if (sz !== null && sz > HIST_ROTATE) {
        // rotacao: reescreve so as ultimas linhas (FS le do inicio, nao ha tail)
        var txt = FS.readTextFile(histFile);
        if (txt !== null) {
            var lines = txt.split("\n");
            var keep = Math.max(0, lines.length - 1 - HIST_MAX_FILE);
            var out = [];
            for (var i = keep; i < lines.length; i++) {
                if (lines[i] !== "") out.push(lines[i]);
            }
            FS.writeTextFile(histFile, out.join("\n") + "\n");
        }
    }
}
function totalsLoad() {
    totals.ok = parseInt(Storage.get("sc_ok", "0"), 10) || 0;
    totals.no = parseInt(Storage.get("sc_no", "0"), 10) || 0;
    totals.un = parseInt(Storage.get("sc_un", "0"), 10) || 0;
    totals.rw = parseInt(Storage.get("sc_rw", "0"), 10) || 0;
}
function totalsSave() {
    Storage.set("sc_ok", "" + totals.ok);
    Storage.set("sc_no", "" + totals.no);
    Storage.set("sc_un", "" + totals.un);
    Storage.set("sc_rw", "" + totals.rw);
}

function validate(code) {
    if (!/^CEL-[0-9A-F]{6}$/.test(code)) {
        return { valid: false, info: "formato invalido" };
    }
    var key = "used_" + code;
    if (Storage.get(key, "") === "1") {
        totals.rw += 1;
        return { valid: false, info: "ticket reutilizado" };
    }
    Storage.set(key, "1");
    totals.un += 1;
    return { valid: true, info: "ticket valido" };
}

// ---- malha: nos ----
function camNode() {
    var ms = Pack.members();
    for (var i = 0; i < ms.length; i++) {
        if (ms[i].caps && ms[i].caps.camera) return ms[i];
    }
    return null;
}
function membersLine() {
    var ms = Pack.members();
    var parts = [];
    for (var i = 0; i < ms.length; i++) {
        var c = ms[i].caps || {};
        parts.push(ms[i].name + " " + ms[i].rssi + "dBm" +
                   (c.hub ? " hub" : "") + (c.camera ? " cam" : ""));
    }
    var s = parts.length ? parts.join("  ") : "ninguem ouvido";
    return s.length > 44 ? s.slice(0, 44) + "..." : s;
}

// ---- maquina de comandos (1 por vez, ack em 3 s, retry x2) ----
var pending = null;  // {id, obj, label, tries, t0, n}
var nonceC = 1;
var lastAck = null;  // {cmd, ok, info, bytes, w, h}
var camStat = null;  // ultimo {t:'stat'}
var camStatAt = 0;
var pingPend = null; // {id, t0}
var pingMs = -1;
var logParts = {}, logTotal = 0;  // chunks {t:'log'} do cmd log

function sendCmd(extra, label) {
    if (pending !== null) { UI.toast("comando em andamento..."); return false; }
    var cam = camNode();
    if (cam === null) { UI.toast("no-camera nao ouvido"); return false; }
    var obj = { t: "cmd", n: nonceC };
    nonceC += 1;
    for (var k in extra) obj[k] = extra[k];
    pending = { id: cam.id, obj: obj, label: label, tries: 0, t0: System.millis(), n: obj.n };
    Pack.send(cam.id, obj, { urgent: true });
    return true;
}
function cmdTick() {
    if (pending === null) return;
    if (System.millis() - pending.t0 < 3000) return;
    pending.tries += 1;
    if (pending.tries > 2) {
        UI.toast(pending.label + ": sem ack");
        pending = null;
        return;
    }
    pending.t0 = System.millis();
    Pack.send(pending.id, pending.obj, { urgent: true });
}
function sendPing() {
    var cam = camNode();
    if (cam === null) { UI.toast("no-camera nao ouvido"); return; }
    pingPend = { id: cam.id, t0: System.millis() };
    pingMs = -1;
    Pack.send(cam.id, { t: "ping" }, { urgent: true });
}

// ---- envelopes que chegam ----
function envData(env) {
    var d = env.data;
    if (typeof d === "string") {
        try { d = JSON.parse(d); } catch (e) { d = null; }
    }
    return d;
}

function fmtUp(s) {
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m" + (s % 60) + "s";
    return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
}
function fmtKB(b) {
    return Math.round(b / 1024) + "K";
}

function onEnvelope(env) {
    var d = envData(env);
    if (d === null) return;
    var node = env.fromName || env.from;
    if (d.t === "ping") {
        Pack.send(env.from, { t: "pong" }, { urgent: true });
        return;
    }
    if (d.t === "pong") {
        if (pingPend !== null && env.from === pingPend.id) {
            pingMs = System.millis() - pingPend.t0;
            pingPend = null;
        }
        return;
    }
    if (d.t === "ack") {
        if (pending !== null && d.n === pending.n && env.from === pending.id) {
            lastAck = d;
            UI.toast(pending.label + ": " + (d.ok ? (d.info || "ok") : "FALHOU " + (d.info || "")));
            pending = null;
        }
        return;
    }
    if (d.t === "stat") {
        camStat = d;
        camStatAt = System.millis();
        return;
    }
    if (d.t === "log") {
        logParts[d.i] = d.s;
        logTotal = d.n;
        return;
    }
    if (d.t !== "qr") return;
    var v = validate(d.code);
    Pack.send(env.from, { t: "ok", valid: v.valid, info: v.info }, { urgent: true });
    if (v.valid) { score.ok += 1; totals.ok += 1; } else { score.no += 1; totals.no += 1; }
    totalsSave();
    last = { code: d.code, info: v.info, valid: v.valid };
    histAppend({ t: System.getTime(), code: d.code, valid: v.valid, info: v.info, node: node });
    System.beep(v.valid ? 1400 : 350, 90);
    System.notify("bilheteria", d.code + ": " + (v.valid ? "VALIDO" : "INVALIDO"));
}

// ---- UI ----
// botoes de acao destrutiva em 2 tempos: 1o toque arma ("confirmar?"), o 2o
// em ate 3 s executa - evita o modal de confirm no meio do loop imediato
var armReboot = 0, armWipe = 0;
var uiVga = 1, uiLed = 0, uiIv = 200, uiTo = 2000;

function syncUiFromStat() {
    if (camStat === null) return;
    uiVga = camStat.vga ? 1 : 0;
    uiLed = camStat.led ? 1 : 0;
    uiIv = camStat.iv;
    uiTo = camStat.to;
}

function drawValidar() {
    var col = last.valid ? 0x07E0 : (last.code === "-" ? 0x7BEF : 0xF800);
    UI.card(12, 76, 216, 56, {});
    UI.text(last.code, 120, 94, { align: "center", role: "title", color: col });
    UI.text(last.info, 120, 116, { align: "center", role: "body" });
    UI.text("sessao " + score.ok + "/" + score.no + "   total " + totals.ok + "/" + totals.no +
            "   unicos " + totals.un, 120, 146, { align: "center", role: "caption" });
    var items = [];
    for (var i = histEvents.length - 1; i >= 0 && items.length < 9; i--) {
        var e = histEvents[i];
        items.push({ label: (e.valid ? "V " : "X ") + e.code, sub: e.t + " - " + e.info + " (" + e.node + ")",
                     rightColor: e.valid ? 0x07E0 : 0xF800 });
    }
    if (items.length === 0) items.push({ label: "sem leituras ainda", sub: "mostre um QR a camara" });
    UI.list("hist", 12, 158, 216, 98, items, {});
    if (UI.button("zerar placares", 12, 264, 216, 30, {})) {
        score = { ok: 0, no: 0 };
        totals = { ok: 0, no: 0, un: 0, rw: 0 };
        totalsSave();
        UI.toast("placares zerados (tickets usados mantidos)");
    }
}

function drawNos() {
    UI.text(membersLine(), 120, 78, { align: "center", role: "caption" });
    var cam = camNode();
    if (cam === null) {
        UI.card(12, 88, 216, 64, {});
        UI.text("no-camera nao ouvido", 120, 108, { align: "center", role: "body" });
        UI.text("ligue a esp32-cam e aguarde o BEAT (~15 s)", 120, 128, { align: "center", role: "caption" });
        return;
    }
    UI.card(12, 88, 216, 78, {});
    if (camStat === null) {
        UI.text("sem stat ainda - peca [status]", 120, 108, { align: "center", role: "body" });
        UI.text("heartbeat do no chega a cada 30 s", 120, 126, { align: "center", role: "caption" });
    } else {
        var age = Math.round((System.millis() - camStatAt) / 1000);
        UI.text("up " + fmtUp(camStat.up) + "  ram " + fmtKB(camStat.ram) + "  ps " + fmtKB(camStat.ps) +
                (camStat.st ? "  [PAUSADO]" : ""), 120, 104, { align: "center", role: "caption" });
        UI.text("ip " + (camStat.ip || "-") + "  ping " + (pingMs >= 0 ? pingMs + " ms" : "-") +
                "  stat ha " + age + "s", 120, 120, { align: "center", role: "caption" });
        UI.text("scan " + camStat.sc + "  lidos " + camStat.rd + "  entregues " + camStat.dl +
                "  perdidos " + camStat.lk, 120, 136, { align: "center", role: "caption" });
        UI.text("os " + camStat.os + " api " + camStat.api + "  gw " + (camStat.gw || "-") +
                " " + camStat.rssi + "dBm", 120, 152, { align: "center", role: "caption" });
    }
    if (UI.button("status", 12, 172, 68, 30, {})) sendCmd({ cmd: "status" }, "status");
    if (UI.button("ping", 84, 172, 68, 30, {})) sendPing();
    if (UI.button("pisca", 156, 172, 72, 30, {})) sendCmd({ cmd: "blink", times: 5 }, "pisca");
    var paused = camStat !== null && camStat.st;
    if (UI.button(paused ? "retomar" : "pausar", 12, 206, 68, 30, {}))
        sendCmd({ cmd: paused ? "resume" : "pause" }, paused ? "retomar" : "pausar");
    if (UI.button("foto", 84, 206, 68, 30, {})) sendCmd({ cmd: "photo" }, "foto");
    if (UI.button("log", 156, 206, 72, 30, {})) { logParts = {}; logTotal = 0; sendCmd({ cmd: "log" }, "log"); }
    var rl = armReboot > 0 ? "confirmar reboot?" : "reiniciar cam";
    if (UI.button(rl, 12, 240, 104, 30, {})) {
        if (armReboot > 0) { armReboot = 0; sendCmd({ cmd: "reboot" }, "reboot"); }
        else armReboot = System.millis();
    }
    if (armReboot > 0 && System.millis() - armReboot > 3000) armReboot = 0;
    // cfg remota: espelha o stat; mudanca local vira cmd cfg (ack confirma)
    UI.text("vga", 126, 244, { role: "caption" });
    var nv = UI.toggle(146, 242, uiVga !== 0, {});
    if (nv !== (uiVga !== 0)) { uiVga = nv ? 1 : 0; sendCmd({ cmd: "cfg", vga: uiVga }, "cfg vga"); }
    UI.text("led", 176, 244, { role: "caption" });
    var nl = UI.toggle(196, 242, uiLed !== 0, {});
    if (nl !== (uiLed !== 0)) { uiLed = nl ? 1 : 0; sendCmd({ cmd: "cfg", led: uiLed }, "cfg led"); }
    UI.text("respiro " + uiIv + " ms", 12, 278, { role: "caption" });
    var iv = UI.slider(12, 292, 104, uiIv, { min: 0, max: 2000, step: 100, id: 1 });
    if (iv !== uiIv) { uiIv = iv; sendCmd({ cmd: "cfg", iv: uiIv }, "cfg respiro"); }
    UI.text("janela " + uiTo + " ms", 124, 278, { role: "caption" });
    var to = UI.slider(124, 292, 104, uiTo, { min: 1000, max: 8000, step: 500, id: 2 });
    if (to !== uiTo) { uiTo = to; sendCmd({ cmd: "cfg", to: uiTo }, "cfg janela"); }
}

function drawDados() {
    UI.card(12, 76, 216, 62, {});
    UI.text("validos: " + totals.ok + "    invalidos: " + totals.no, 120, 94, { align: "center", role: "body" });
    UI.text("tickets unicos: " + totals.un + "    reusos: " + totals.rw, 120, 114, { align: "center", role: "body" });
    UI.text("historico: " + histEvents.length + " eventos em memoria" +
            (typeof FS !== "undefined" && histFile !== "" && FS.exists(histFile) ? " (persistido)" : ""), 120, 130, { align: "center", role: "caption" });
    // leituras por hora (ultimas 6 horas com eventos das ~100 em memoria)
    var byHour = {}, hours = [];
    for (var i = 0; i < histEvents.length; i++) {
        var h = histEvents[i].t.slice(0, 2);
        if (byHour[h] === undefined) { byHour[h] = 0; hours.push(h); }
        byHour[h] += 1;
    }
    hours.sort();
    var show = hours.slice(Math.max(0, hours.length - 6));
    UI.text("leituras por hora", 120, 152, { align: "center", role: "caption" });
    if (show.length === 0) {
        UI.text("sem dados", 120, 180, { align: "center", role: "caption" });
    } else {
        var maxC = 1;
        for (var j = 0; j < show.length; j++) if (byHour[show[j]] > maxC) maxC = byHour[show[j]];
        var bw = Math.floor(200 / show.length);
        for (var k = 0; k < show.length; k++) {
            var bh = Math.round(44 * byHour[show[k]] / maxC);
            System.fillRect(20 + k * bw, 204 - bh, bw - 6, Math.max(bh, 2), 0x35D7);
            UI.text(show[k] + "h " + byHour[show[k]], 20 + k * bw + Math.floor((bw - 6) / 2), 212, { role: "caption", align: "center" });
        }
    }
    if (UI.button("exportar CSV", 12, 232, 216, 30, {})) exportCsv();
    var wl = armWipe > 0 ? "confirmar limpar TUDO?" : "limpar historico e tickets";
    if (UI.button(wl, 12, 266, 216, 30, {})) {
        if (armWipe > 0) { armWipe = 0; wipeAll(); }
        else armWipe = System.millis();
    }
    if (armWipe > 0 && System.millis() - armWipe > 3000) armWipe = 0;
}

function exportCsv() {
    if (typeof FS === "undefined") { UI.toast("sem perm fs"); return; }
    var lines = ["hora,codigo,valido,info,no"];
    for (var i = 0; i < histEvents.length; i++) {
        var e = histEvents[i];
        lines.push(e.t + "," + e.code + "," + (e.valid ? "V" : "X") + "," + e.info + "," + e.node);
    }
    var path = FS.exists("/sd") ? "/sd/bilheteria.csv" : FS.appData() + "bilheteria.csv";
    FS.writeTextFile(path, lines.join("\n") + "\n");
    UI.toast("CSV: " + path + " (" + (histEvents.length) + " eventos)");
}

function wipeAll() {
    histEvents = [];
    if (typeof FS !== "undefined" && histFile !== "") FS.deleteFile(histFile);
    Storage.clear();  // placares + todos os used_<code> (anti-reuso)
    totals = { ok: 0, no: 0, un: 0, rw: 0 };
    score = { ok: 0, no: 0 };
    UI.toast("historico e tickets limpos");
}

function drawLog() {
    var items = [];
    if (logTotal === 0) {
        items.push({ label: "sem log coletado", sub: "use [log] na aba Nos" });
    } else {
        for (var i = 0; i < logTotal; i++) {
            var s = logParts[i];
            var ls = (s === undefined ? "...parte " + i + " perdida" : s).split("\n");
            for (var j = 0; j < ls.length; j++) items.push({ label: ls[j] });
        }
    }
    UI.list("camlog", 12, 76, 216, 200, items, {});
    if (UI.button("coletar de novo", 12, 282, 216, 30, {})) { logParts = {}; logTotal = 0; sendCmd({ cmd: "log" }, "log"); }
}

function draw() {
    UI.begin();
    UI.header("Bilheteria", { sub: "gateway da malha" });
    var t = UI.tabs(12, 44, 216, 24, ["Validar", "Nos", "Dados", "Log"], tabSel);
    if (t !== tabSel) { tabSel = t; syncUiFromStat(); }
    if (tabSel === 0) drawValidar();
    else if (tabSel === 1) drawNos();
    else if (tabSel === 2) drawDados();
    else drawLog();
    UI.end(10);
}

if (typeof Pack === "undefined" || typeof CelerNet === "undefined") {
    // build sem Bluetooth: nada a gatewayar - avisa e sai (sem loop vazio)
    System.notify("bilheteria", "build sem Bluetooth: a malha nao existe aqui");
} else {
// malha do APARELHO (rede/nome do Matilha, padrao "celer"): o start com
// name/net PERSISTE nos settings — o gateway e um aparelho de uso geral e
// forcar rede aqui tirava o 4848 da "celer" (Celer Remote/robo sumiam)
CelerNet.start({});
totalsLoad();
histLoad();
syncUiFromStat();
while (true) {
    var env = Pack.poll();
    while (env !== null) {
        onEnvelope(env);
        env = Pack.poll();
    }
    cmdTick();
    draw();
    System.delay(100);
}
}
