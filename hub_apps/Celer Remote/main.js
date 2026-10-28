// Celer Remote — controle remoto de CelerOS proximos pelo Celer Link.
// UI 2.0 sobre o CelerKit (deps celeros.app.*): header do A.widgets com
// acao WiFi, D-pad circular com anel de status (bateria do robo) desenhado
// por System.fillArc, sheets de truques e afino sobre a tela de controle e
// lista de pares rica do A.list.view. O protocolo Celer Link e o MESMO:
// scan/connect/verify, {type:move,dir}, {type:stop}, tel/say, truques,
// afino hop/stance e WiFi selado (sendSealed). Robo velho sem tel.modes,
// tel.tricks ou tel.tune simplesmente nao mostra o botao.
//
// Seguranca: segurar a seta repete o move a cada 250 ms (o robo para sozinho
// se a repeticao some) e soltar manda stop; queda do link tenta reconectar
// no mesmo par antes de voltar para a lista. Pareamento (API 11): codigo de
// 6 digitos na tela do robo digitado aqui e verificado no firmware.

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.widgets");   // header/acoes, sheet, anel; traz icons

A.init();
var T = A.style.T;
var L = A.L, LX = L.x, LW = L.w;

var peers = [];
var target = null;        // par conectado (para reconectar)
var tel = null;
var ctrlVisivel = false;
var sheet = null;         // null | "tricks" | "tune"
var sheetMsg = "", sheetErr = false;

var REPEAT_MS = 250;
var RECONNECT_TRIES = 3;

// ---- avisos na tela de controle (fila, um por vez) ------------------------
var notes = [], noteUntil = 0;
function note(msg, ms) {
    notes.push({ t: msg, ms: ms || 6000 });
    if (notes.length > 4) notes.shift();
    if (notes.length === 1) noteUntil = System.millis() + notes[0].ms;
}
function curNote() {
    while (notes.length && System.millis() >= noteUntil) {
        notes.shift();
        if (notes.length) noteUntil = System.millis() + notes[0].ms;
    }
    return notes.length ? notes[0].t : "";
}

// espera com o overlay do kit; o frame que ele abre/fecha pede repinta total
function spin(msg) { A.busy(msg); UI.invalidate(); }

// esvazia a fila do link; devolve a 1a mensagem do tipo `want`
var lastHop = null, lastStance = null;
function pollLink(want) {
    for (var k = 0; k < 8; k++) {
        var m = CelerLink.poll();
        if (m === null) break;
        var v = null;
        try { v = JSON.parse(m); } catch (e) { v = null; }
        if (!v) continue;
        if (v.type === "tel") tel = v;
        else if (v.type === "say") note("cão: " + String(v.text || "").substring(0, 60), 6000);
        else if (v.type === "hop") lastHop = v;
        else if (v.type === "stance") lastStance = v;
        if (want && v.type === want) return v;
    }
    return null;
}
function waitMsg(type, ms) {
    var t0 = System.millis();
    while (System.millis() - t0 < ms) {
        var v = pollLink(type);
        if (v) return v;
        if (!CelerLink.status().connected) return null;
        System.delay(50);
    }
    return null;
}

// barras de sinal (0..4) da curva de RSSI que nasceu neste app
function bars(rssi) {
    if (typeof rssi !== "number" || rssi >= 0) return -1;
    if (rssi > -55) return 4;
    if (rssi > -67) return 3;
    if (rssi > -78) return 2;
    if (rssi > -88) return 1;
    return 0;
}
function battFrac() {
    if (!tel || typeof tel.batt !== "number") return 0;
    var f = (tel.batt - 3300) / 900;
    return f < 0 ? 0 : (f > 1 ? 1 : f);
}

// ---- lista de pares (linhas reconstruidas so quando o scan muda) ----------
var peerRows = null, peerStamp = "";
function rowsPeers() {
    var st = peers.length + ":" + (peers.length ? peers[0].id + peers[0].rssi : "");
    if (st !== peerStamp) {
        peerStamp = st;
        peerRows = [];
        for (var i = 0; i < peers.length; i++) {
            peerRows.push({ label: peers[i].name || "(sem nome)", sub: peers[i].id,
                            right: peers[i].rssi + " dBm", bars: bars(peers[i].rssi) });
        }
    }
    return peerRows || [];
}

function doScan() {
    spin("procurando CelerOS por perto...");
    peers = CelerLink.scan(3000);
    peers.sort(function (a, b) { return b.rssi - a.rssi; });
    peerRows = null;
    UI.resetScroll("peers");
    UI.invalidate();
}

// ---- scan -----------------------------------------------------------------
function scanFrame(c) {
    var h = A.widgets.header("Celer Remote", { full: c.full, back: false,
        sub: peers.length ? peers.length + " por perto" : "",
        actions: [{ icon: "search", id: "scan" }] });
    if (h.action === "scan") doScan();

    if (!peers.length) {
        A.style.card(LX, 56, LW, 150, { full: c.full, elev: 1, grad: true,
            draw: function (r) {
                A.icons.draw("wifi", r.x + (r.w - 32) / 2, r.y + 6, 32, { color: T.stroke });
                UI.text("Nenhum CelerOS por perto", LX + LW / 2, r.y + 48,
                        { role: "title", align: "center", color: T.textDim, w: r.w });
                UI.text("Ligue o robô (ou outro aparelho com Celer Link), pareie e pilote.",
                        LX + LW / 2, r.y + 76,
                        { role: "caption", align: "center", color: T.textDim, w: r.w, lines: 3 });
            }
        });
    } else {
        var k = UI.list("peers", LX, 48, LW, 214, rowsPeers(), { rowH: 48 });
        if (k >= 0) return connectTo(peers[k]) ? "ctrl" : undefined;
    }
    UI.text("1 ligue · 2 pareie · 3 pilote", 120, 238,
            { role: "caption", align: "center", color: T.textDim });
    if (A.style.button(peers.length ? "Procurar de novo" : "Procurar", LX, 262, LW, 40,
                       { variant: peers.length ? "ghost" : "primary" })) {
        doScan();
    }
}

function connectTo(p) {
    spin("conectando " + (p.name || p.id) + "...");
    if (!CelerLink.connect(p.id, 5000)) {
        UI.toast("falha ao conectar: " + (p.name || p.id), 4000);
        UI.invalidate();
        return false;
    }
    if (!afterConnect(p)) return false;
    enterCtrl(p, "pareado!");
    return true;
}

// ---- pareamento por codigo -------------------------------------------------
function pairCard(name, err) {
    UI.card(20, 80, 200, 150);
    UI.text("Digite o código", 120, 96, { role: "title", align: "center" });
    UI.text("código na tela do robô", 120, 128, { align: "center", color: T.accent });
    UI.text("6 dígitos, válido por 60 s", 120, 156, { role: "caption", align: "center", color: T.textDim });
    UI.cardEnd();
    UI.text(name || "robô", 120, 60, { role: "caption", align: "center", color: T.textDim });
    if (err) UI.text(err, 120, 186, { align: "center", color: T.err, w: LW });
}
function ensurePairing(name) {
    var err = null;
    for (var wrong = 0; wrong < 3; ) {
        pairCard(name, err);
        var c = System.prompt("codigo do robo (6 digitos)", "", { hint: "num" });
        if (!c) { leaveLink("pareamento cancelado"); return "cancel"; }
        if (!/^[0-9]{6}$/.test(c)) { err = "só números, 6 dígitos"; continue; }
        if (CelerLink.verify(c)) return "ok";
        wrong++;
        err = "código errado (" + wrong + "/3)";
    }
    leaveLink("código errado 3x");
    return "fail";
}
function afterConnect(p) {
    if (!CelerLink.status().pairing) return true;
    return ensurePairing(p && (p.name || p.id)) === "ok";
}

// ---- estado do link ---------------------------------------------------------
function enterCtrl(p, msg) {
    target = p;
    tel = null;
    held = -1;
    padDrawn = -2;
    chromeSig = "";
    sheet = null;
    ctrlVisivel = true;
    if (msg) note(msg, 2500);
    UI.invalidate();
}
function leaveLink(msg) {
    var st = CelerLink.status();
    if (st.connected || st.pairing) {
        if (st.connected) CelerLink.send({ type: "stop" });
        CelerLink.disconnect();
    }
    target = null;
    held = -1;
    sheet = null;
    ctrlVisivel = false;
    if (msg) UI.toast(msg, 4000);
    UI.invalidate();
}
function reconnect() {
    for (var k = 1; k <= RECONNECT_TRIES; k++) {
        spin("reconectando (" + k + "/" + RECONNECT_TRIES + ")...");
        if (CelerLink.connect(target.id, 4000) && afterConnect(target)) {
            UI.invalidate();
            return true;
        }
        if (!ctrlVisivel) return false;
        System.delay(300);
    }
    return false;
}

// ---- D-pad + anel de status ------------------------------------------------
var CX = 120, CY = 168, PR = 80;
// areas de toque medidas a partir do centro (o desenho e o circulo por cima)
var PAD = [
    [CX - 32, CY - 76, 64, 50, "up"],
    [CX - 32, CY + 28, 64, 50, "down"],
    [CX - 84, CY - 28, 54, 56, "left"],
    [CX + 30, CY - 28, 54, 56, "right"],
    [CX - 26, CY - 24, 52, 48, "stop"]
];
var STOP_IDX = 4;
function inR(t, r) { return t.x >= r[0] && t.x < r[0] + r[2] && t.y >= r[1] && t.y < r[1] + r[3]; }
function hitPad(t) {
    for (var i = 0; i < PAD.length; i++) if (inR(t, PAD[i])) return i;
    return -1;
}
function sendDir(i) {
    var dir = PAD[i][4];
    CelerLink.send(dir === "stop" ? { type: "stop" } : { type: "move", dir: dir });
    lastSend = System.millis();
}

var held = -1;
var padDrawn = -2;
var lastSend = 0;
var ringKey = "";

function drawPad(full) {
    if (full) { padDrawn = -2; ringKey = ""; }
    if (full || padDrawn !== held) {
        padDrawn = held;
        System.fillSmoothCircle(CX, CY, PR, T.card);
        System.fillSmoothCircle(CX, CY, PR - 2, T.raised);
        var a = 16;
        var tris = [
            [CX, CY - 64, CX - a, CY - 40, CX + a, CY - 40],
            [CX, CY + 64, CX - a, CY + 40, CX + a, CY + 40],
            [CX - 64, CY, CX - 40, CY - a, CX - 40, CY + a],
            [CX + 64, CY, CX + 40, CY - a, CX + 40, CY + a]
        ];
        for (var i = 0; i < 4; i++) {
            var t = tris[i];
            if (held === i) {
                var hx = (t[0] + t[2] + t[4]) / 3, hy = (t[1] + t[3] + t[5]) / 3;
                System.fillSmoothCircle(Math.round(hx), Math.round(hy), 26, T.accentD);
            }
            System.fillTriangle(t[0], t[1], t[2], t[3], t[4], t[5],
                                held === i ? T.accent : T.text);
        }
        System.fillSmoothCircle(CX, CY, 24, held === STOP_IDX ? T.err : T.bg);
        System.fillSmoothRoundRect(CX - 8, CY - 8, 16, 16, 3,
                                   held === STOP_IDX ? T.text : T.err);
    }
    // anel de status: bateria do robo (ou o stroke quando sem telemetria)
    var f = battFrac(), connected = CelerLink.status().connected;
    var key = Math.round(f * 100) + (connected ? 1 : 0);
    if (full || key !== ringKey) {
        ringKey = key;
        System.fillArc(CX, CY, 84, 88, 0, 360, T.raised);
        if (connected && f > 0.01) {
            System.fillArc(CX, CY, 84, 88, -90, -90 + 360 * f,
                           f < 0.2 ? T.err : (f < 0.4 ? T.warn : T.ok));
        }
    }
}

// faixa: modo do robo + truques + afino (so com o que a telemetria anuncia)
var MODE_BTN = [LX, 256, 92, 30];
var TRICK_BTN = [LX + 96, 256, 62, 30];
var TUNE_BTN = [LX + 162, 256, 70, 30];
var chromeSig = "";
function hasModes() { return !!(tel && tel.mode && tel.modes && tel.modes.length > 1); }
function hasTricks() { return !!(tel && tel.tricks && tel.tricks.length); }
function hasTune() { return !!(tel && tel.tune); }
function wifiAvailable() { return !!(tel && tel.wifi && typeof CelerLink.sendSealed === "function"); }

// ---- tela de controle ------------------------------------------------------
function ctrlFrame(c) {
    if (c.entered) { held = -1; padDrawn = -2; chromeSig = ""; sheet = null; }
    var st = CelerLink.status();
    if (!st.connected) {
        held = -1;
        if (!reconnect()) {
            if (ctrlVisivel) leaveLink("conexão perdida: " + (target ? (target.name || target.id) : "?"));
            return A.BACK;
        }
        return undefined;
    }
    pollLink(null);
    var sig = (hasModes() ? "m" : "") + (hasTricks() ? "t" : "") + (hasTune() ? "a" : "") + (wifiAvailable() ? "w" : "");
    if (sig !== chromeSig) { chromeSig = sig; UI.invalidate(); }

    var name = (target && target.name) || st.peer || "?";
    var open = !!sheet;
    var fechou = false;
    if (!open) {
        // estado: conexao + telemetria + aviso corrente
        UI.badge(st.connected ? "conectado" : "desconectado", LX + 2, 48,
                 { color: st.connected ? T.ok : T.err, textColor: T.onAccent });
        UI.text(tel ? "batt " + tel.batt + (tel.state ? "  ·  " + tel.state : "")
                     : "aguardando telemetria...",
                240 - LX - 2, 50, { role: "caption", align: "right", color: T.textDim, w: 150 });
        UI.text(curNote(), 120, 66, { role: "caption", align: "center",
                                     color: T.accent, w: LW, lines: 2 });

        drawPad(c.full);

        if (hasModes() && A.style.button("marcha: " + tel.mode, MODE_BTN[0], MODE_BTN[1],
                                         MODE_BTN[2], MODE_BTN[3], { variant: "ghost", role: "caption" })) {
            var next = tel.modes[(tel.modes.indexOf(tel.mode) + 1) % tel.modes.length];
            CelerLink.send({ type: "mode", walk: next });
        }
        if (hasTricks() && A.style.button("truques", TRICK_BTN[0], TRICK_BTN[1],
                                          TRICK_BTN[2], TRICK_BTN[3], { variant: "ghost", role: "caption" })) {
            held = -1;
            openSheet("tricks");
        }
        if (hasTune() && A.style.button("afinar", TUNE_BTN[0], TUNE_BTN[1],
                                        TUNE_BTN[2], TUNE_BTN[3], { variant: "ghost", role: "caption" })) {
            held = -1;
            openSheet("tune");
        }
        UI.text("segure para andar · solte para parar", 120, 300,
                { role: "caption", align: "center", color: T.textDim });

        // D-pad: segurar repete o move; soltar a seta manda stop
        var t = UI.touch();
        var h2 = t.down ? hitPad(t) : -1;
        if (h2 !== held) {
            var was = held;
            held = h2;
            if (held >= 0) sendDir(held);
            else if (was >= 0 && was !== STOP_IDX) CelerLink.send({ type: "stop" });
        } else if (held >= 0 && held !== STOP_IDX && System.millis() - lastSend > REPEAT_MS) {
            sendDir(held);
        }
    } else {
        drawPad(c.full);   // visual de fundo (o sheet cobre a interacao)
    }

    if (sheet === "tricks") fechou = sheetTricks(c) === "close";
    else if (sheet === "tune") fechou = sheetTune(c) === "close";

    // O header e desenhado DEPOIS do sheet: o veu do sheet apaga a tela toda
    // e o frame parcial seguinte nao repinta o header (o slot nao mudou).
    // Desenhando por cima, voltar e WiFi continuam legiveis com o sheet aberto.
    var h = A.widgets.header(name, { full: c.full, back: true,
        sub: st.rssi ? st.rssi + " dBm" : "",
        actions: wifiAvailable() ? [{ icon: "wifi", id: "wifi" }] : null });
    if (h.back) {
        // toque na seta com o sheet aberto: o mesmo tap ja fechou o sheet
        if (!fechou) { leaveLink(null); return A.BACK; }
    } else if (h.action === "wifi" && !fechou) { sheet = null; return "wifi"; }
}

// ---- sheets (truques e afino) ----------------------------------------------
var pendingTrick = null, pendingBump = null, pendingTest = false;

function openSheet(kind) {
    sheet = kind;
    sheetMsg = "";
    sheetErr = false;
    if (kind === "tune") {
        // sem overlay aqui: um frame extra do A.busy comeria um quadro da
        // animacao do sheet (os testes tocam no + ja no 2o frame)
        sheetMsg = "lendo o robo...";
        UI.invalidate();
        if (!CelerLink.send({ type: "tune" })) {
            sheetMsg = "falha ao pedir o estado";
            sheetErr = true;
        } else {
            lastHop = waitMsg("hop", 3000);
            lastStance = waitMsg("stance", 1500);
            if (!lastHop) {
                sheetMsg = "robo nao respondeu (Dog Face 1.9.7+)";
                sheetErr = true;
            } else sheetMsg = "";
        }
        UI.invalidate();
    }
}
function closeSheet() {
    if (sheet === "tune") CelerLink.send({ type: "stop" });
    sheet = null;
    UI.invalidate();
}

function sheetTricks(c) {
    var names = (tel && tel.tricks) || [];
    var r = A.widgets.sheet("tricks", { open: true, h: 280, full: c.full, pad: 12 },
        function (q) {
            UI.text(names.length + " truques", 228, q.y - 9,
                    { role: "caption", align: "right", color: T.textDim, w: 80 });
            var rows = [];
            for (var i = 0; i < names.length; i++) rows.push({ label: names[i] });
            var k = UI.list("tricklist", q.x, q.y, q.w, q.h - 28, rows, { rowH: 36 });
            if (k >= 0) pendingTrick = names[k];
            UI.text("toque fora para fechar", q.x + q.w / 2, q.y + q.h - 16,
                    { role: "caption", align: "center", color: T.textDim, w: q.w });
            if (pendingTrick) {
                UI.text("mandando " + pendingTrick + "...", q.x + q.w / 2, q.y + q.h - 10,
                        { role: "caption", align: "center", color: T.accent, w: q.w });
            }
        });
    if (pendingTrick) {
        var nm = pendingTrick;
        pendingTrick = null;
        closeSheet();
        if (!CelerLink.send({ type: "trick", name: nm })) {
            note("falha ao enviar " + nm, 6000);
        } else {
            spin("truque: rodando " + nm + "...");
            var res = waitMsg("trick_res", 6000);
            note(nm + (!res ? ": sem resposta" : (res.ok ? "!" : " recusou (bateria?)")), 6000);
        }
        return undefined;
    }
    if (r === "close") closeSheet();
    pollLink(null);
    if (!CelerLink.status().connected) { sheet = null; }
    return r;
}

// afino de bancada (Dog Face 1.9.7): cada toque manda {type:tune} e o eco
// ({type:hop}/{type:stance}) e a verdade — o robo aplica na hora e persiste
var TUNE_ROWS = [
    { k: "air",    lbl: "abertura", min: -200, max: 800,  stp: 10, grp: "hop" },
    { k: "leanR",  lbl: "traseira", min: 0,    max: 40,   stp: 5,  grp: "stance" },
    { k: "spin",   lbl: "giro",     min: 40,   max: 110,  stp: 10, grp: "hop" },
    { k: "fall",   lbl: "queda",    min: 0,    max: 1200, stp: 20, grp: "hop" },
    { k: "land",   lbl: "pouso",    min: 0,    max: 600,  stp: 10, grp: "hop" },
    { k: "settle", lbl: "deslize",  min: 0,    max: 800,  stp: 10, grp: "hop" },
    { k: "rest",   lbl: "descanso", min: 0,    max: 2000, stp: 25, grp: "hop" }
];
function tuneVal(r) {
    var src = r.grp === "hop" ? lastHop : lastStance;
    var v = src ? src[r.k] : null;
    return (typeof v === "number") ? v : 0;
}
function tuneBump(r, delta) {
    var v = Math.max(r.min, Math.min(r.max, tuneVal(r) + delta));
    var msg = { type: "tune" };
    if (r.grp === "hop") { msg.hop = {}; msg.hop[r.k] = v; } else msg[r.k] = v;
    if (CelerLink.send(msg)) {
        var eco = waitMsg(r.grp === "hop" ? "hop" : "stance", 2000);
        sheetMsg = eco ? "afinado: " + r.lbl + " = " + v : "mandado (sem eco)";
        sheetErr = !eco;
    } else {
        sheetMsg = "falha ao enviar";
        sheetErr = true;
    }
    UI.invalidate();
}

function sheetTune(c) {
    var r = A.widgets.sheet("tune", { open: true, h: 280, full: c.full, pad: 12 },
        function (q) {
            UI.text("afinar", 228, q.y - 9, { role: "caption", align: "right", color: T.textDim, w: 80 });
            var y = q.y;
            for (var i = 0; i < TUNE_ROWS.length; i++) {
                var row = TUNE_ROWS[i];
                UI.text(row.lbl, q.x, y + 8, { role: "caption", color: T.textDim, w: 96 });
                UI.text(String(tuneVal(row)), 160, y + 8,
                        { role: "caption", align: "right", color: T.text, w: 46 });
                if (A.style.button("-", 162, y, 30, 28, { variant: "ghost", role: "caption" }))
                    pendingBump = [row, -row.stp];
                if (A.style.button("+", 198, y, 30, 28, { variant: "ghost", role: "caption" }))
                    pendingBump = [row, row.stp];
                y += 30;
            }
            if (A.style.button("testar: andar 3 s", q.x, y + 2, q.w, 28)) pendingTest = true;
            UI.text(sheetMsg || "cada toque aplica na hora", q.x + q.w / 2, y + 34,
                    { role: "caption", align: "center", w: q.w, lines: 1,
                      color: sheetErr ? T.err : T.textDim });
        });
    if (pendingBump) {
        var b = pendingBump;
        pendingBump = null;
        tuneBump(b[0], b[1]);
    }
    if (pendingTest) {
        pendingTest = false;
        spin("andando 3 s (solte o robô!)...");
        CelerLink.send({ type: "gait", name: "walk", repeat: true });
        System.delay(3000);
        CelerLink.send({ type: "stop" });
        UI.invalidate();
    }
    if (r === "close") closeSheet();
    pollLink(null);
    if (!CelerLink.status().connected) { sheet = null; note("conexão perdida", 6000); }
    return r;
}

// ---- WiFi do robo (API 21): senha selada -----------------------------------
var wifiNets = [];
function wifiFrame(c) {
    if (c.entered) {
        wifiNets = [];
        spin("WiFi: procurando redes...");
        if (!CelerLink.send({ type: "wifi_scan" })) { note("falha ao pedir o scan", 6000); return A.BACK; }
        var res = waitMsg("wifi_list", 9000);
        if (!res) { note("robô não respondeu ao scan", 6000); return A.BACK; }
        wifiNets = res.nets || [];
        return undefined;
    }
    var h = A.widgets.header("WiFi do robô", { full: c.full, back: true,
        sub: wifiNets.length ? "" : "nenhuma rede vista" });
    if (h.back) { note("WiFi: cancelado", 6000); return A.BACK; }
    var rows = [];
    for (var i = 0; i < wifiNets.length; i++) {
        rows.push({ label: wifiNets[i][0], sub: wifiNets[i][2] ? "protegida" : "aberta",
                    right: wifiNets[i][1] + " dBm", bars: bars(wifiNets[i][1]) });
    }
    rows.push({ label: "Outra rede...", sub: "digitar o nome (SSID)" });

    var k = UI.list("wifi", LX, 48, LW, 264, rows, { rowH: 40 });
    if (k === rows.length - 1) {
        var nm = System.prompt("nome da rede (SSID)", "", { nullOnCancel: true });
        if (!nm) { note("WiFi: cancelado", 6000); return A.BACK; }
        return wifiSend(nm, true);
    } else if (k >= 0) {
        return wifiSend(wifiNets[k][0], wifiNets[k][2] === 1);
    }
    pollLink(null);
    if (!CelerLink.status().connected) { note("conexão perdida", 6000); return A.BACK; }
}

function wifiSend(ssid, secure) {
    var pass = "";
    if (secure) {
        pass = System.prompt("senha de " + ssid, "", { mask: true, nullOnCancel: true });
        if (pass === null || pass === undefined) { note("WiFi: cancelado", 6000); return A.BACK; }
    }
    spin("WiFi: enviando (cifrado)...");
    var ok = CelerLink.sendSealed({ type: "wifi", ssid: ssid, pass: pass });
    pass = null;
    if (!ok) { note("falha ao enviar (pareie de novo pelo código)", 6000); return A.BACK; }
    spin("WiFi: robô conectando em " + ssid + "...");
    var r2 = waitMsg("wifi_res", 25000);
    if (!r2) note("sem resposta do robô", 6000);
    else note(r2.ok ? "robô online: " + r2.ip : "robô não conectou em " + ssid + " (senha?)", 8000);
    return A.BACK;
}

// ---- sem Celer Link (placa sem BT) -----------------------------------------
if (typeof CelerLink === "undefined") {
    UI.alert("Sem Celer Link", "Esta placa não tem Bluetooth.", "Sair");
    System.exitApp();
}

doScan();
A.run({ scan: scanFrame, ctrl: ctrlFrame, wifi: wifiFrame }, "scan", { fps: 30 });
