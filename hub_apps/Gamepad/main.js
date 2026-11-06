// Gamepad 1.0 — tester do gamepad Bluetooth LE HID (API 57) no CelerKit UI.
//
// Pareia um pad HID (Xbox One S/Series, 8bitdo em modo BLE) pela API BT
// crua com a dep celeros.gamepad fazendo o parser do descriptor HID; mostra
// sticks, dpad, botoes, gatilhos e bateria ao vivo e dispara rumble.
//
// DualShock 4/DualSense/Switch Pro NAO funcionam aqui: sao Bluetooth
// CLASSIC e o radio do S3 nao tem BR/EDR. Sem BT no build (CYD e cia) o
// objeto BT nem existe e o app explica em vez de estourar.

var A = require("celeros.app");
require("celeros.app.style");
var G = require("celeros.gamepad");

A.init();
var T = A.style.T;
var LX = A.L.x, LW = A.L.w, CX = A.L.cx, BOT = A.L.bottom;

var HAS_BT = typeof BT !== "undefined";
var HAS_PADBUS = typeof Input !== "undefined" && typeof Input.padState === "function";
var gp = null;            // Gamepad da dep (null = desconectado)
var pads = [];            // resultado do ultimo scan
var st = null;            // ultimo estado normalizado do pad
var busyMsg = "";

// nomes dos bits do canal Input.pad (doc: InputBus.h) — a mesma tabela do
// driver Controle BT; com o driver rodando ele drena o BT.read cru, entao o
// tester mostra a VISAO DO OS (Input.padState) em vez de brigar pela fila
var BITS = { a: 1, b: 2, x: 4, y: 8, l1: 16, r1: 32, l2: 64, r2: 128,
             select: 256, start: 512, guide: 1024, ls: 2048, rs: 4096 };
var DPAD_BITS = ["n", "e", "s", "w"];
function doCanal(ps) {
    var b = {}, nomes = [];
    for (var k in BITS) {
        if ((ps.buttons & BITS[k]) !== 0) { b[k] = true; nomes.push(k); }
    }
    var d = "";
    for (var i = 0; i < 4; i++) {
        if ((ps.dpad & (1 << i)) !== 0) d += DPAD_BITS[i];
    }
    return {
        lx: ps.lx / 127, ly: ps.ly / 127, rx: ps.rx / 127, ry: ps.ry / 127,
        l2: (ps.buttons & BITS.l2) ? 1 : 0, r2: (ps.buttons & BITS.r2) ? 1 : 0,
        dpad: d, buttons: b, b: nomes, pressed: [], released: [], battery: -1
    };
}

function phaseInfo() {
    if (!HAS_BT) return "sem BT neste firmware/placa";
    var s = BT.state();
    if (s.phase === "error") return "erro: " + (s.err || "?");
    if (s.phase === "connecting") return "conectando...";
    if (s.phase === "ready") return "pronto: " + (s.name || s.addr);
    return "procurando pelo pad...";
}

// ---------------------------------------------------------------- live --
function stickBox(x, y, vx, vy, label) {
    A.style.card(x, y, 64, 64, { draw: function (c) {
        var cx = c.x + 32, cy = c.y + 26;
        System.drawCircle(cx, cy, 22, T.stroke);
        System.drawCircle(cx, cy, 2, T.stroke);
        var dx = Math.round(vx * 18), dy = Math.round(vy * 18);
        System.fillCircle(cx + dx, cy + dy, 6, Math.abs(vx) + Math.abs(vy) > 0.01 ? T.ok : T.textDim);
        UI.text(label, c.x + 6, c.y + 48, { role: "caption", color: T.textDim, w: 52, lines: 1 });
    }});
}

function btnDot(x, y, on, label) {
    System.fillCircle(x + 11, y + 11, on ? 11 : 9, on ? T.ok : T.stroke);
    System.drawCircle(x + 11, y + 11, 9, on ? T.ok : T.stroke);
    UI.text(label, x, y + 6, { role: "caption", w: 22, lines: 1,
                               color: on ? T.bg : T.textDim });
}

function telaLive() {
    var s = BT.state();
    if (s.phase !== "ready") {
        A.toast("pad desconectado");
        return "pads";
    }
    var h = A.header(gp ? gp.name : "Gamepad", { sub: "BLE HID" });
    if (h) {
        G.disconnect();
        gp = null;
        UI.invalidate();
        return "pads";
    }

    // visao do OS primeiro (funciona com o driver Controle BT rodando — ele
    // drena o BT.read cru); sem driver/sem canal, drena o pad direto
    if (HAS_PADBUS) {
        var ps = Input.padState();
        if (ps.seq > 0) st = doCanal(ps);
        else st = gp.poll() || st;
    } else {
        st = gp.poll() || st;
    }

    // sticks
    stickBox(LX, 46, st ? st.lx : 0, st ? -st.ly : 0, "L");
    stickBox(LX + 72, 46, st ? st.rx : 0, st ? -st.ry : 0, "R");

    // dpad + gatilhos
    var dp = st ? st.dpad : "";
    A.style.card(LX + 144, 46, LW - 144, 64, { draw: function (c) {
        var cx = c.x + 28, cy = c.y + 26;
        System.drawCircle(cx, cy, 20, T.stroke);
        var ar = dp.indexOf("n") >= 0 || dp === "ne" || dp === "nw";
        var er = dp.indexOf("e") >= 0 || dp === "ne" || dp === "se";
        var sr = dp.indexOf("s") >= 0 || dp === "se" || dp === "sw";
        var wr = dp.indexOf("w") >= 0 || dp === "nw" || dp === "sw";
        if (ar) System.fillTriangle(cx, cy - 18, cx - 5, cy - 9, cx + 5, cy - 9, T.ok);
        else System.drawTriangle(cx, cy - 18, cx - 5, cy - 9, cx + 5, cy - 9, T.stroke);
        if (sr) System.fillTriangle(cx, cy + 18, cx - 5, cy + 9, cx + 5, cy + 9, T.ok);
        else System.drawTriangle(cx, cy + 18, cx - 5, cy + 9, cx + 5, cy + 9, T.stroke);
        if (er) System.fillTriangle(cx + 18, cy, cx + 9, cy - 5, cx + 9, cy + 5, T.ok);
        else System.drawTriangle(cx + 18, cy, cx + 9, cy - 5, cx + 9, cy + 5, T.stroke);
        if (wr) System.fillTriangle(cx - 18, cy, cx - 9, cy - 5, cx - 9, cy + 5, T.ok);
        else System.drawTriangle(cx - 18, cy, cx - 9, cy - 5, cx - 9, cy + 5, T.stroke);
        // gatilhos L2/R2
        var l2 = st ? st.l2 : 0, r2 = st ? st.r2 : 0;
        System.fillRect(c.x + 52, c.y + 8, 6, 40, T.stroke);
        System.fillRect(c.x + 52, c.y + 8 + Math.round((1 - l2) * 40), 6, Math.round(l2 * 40), T.ok);
        System.fillRect(c.x + 62, c.y + 8, 6, 40, T.stroke);
        System.fillRect(c.x + 62, c.y + 8 + Math.round((1 - r2) * 40), 6, Math.round(r2 * 40), T.ok);
        UI.text("L2", c.x + 52, c.y + 48, { role: "caption", color: T.textDim, w: 14, lines: 1 });
        UI.text("R2", c.x + 62, c.y + 48, { role: "caption", color: T.textDim, w: 14, lines: 1 });
    }});

    // botoes nomeados (2 fileiras)
    var b = st ? st.buttons : {};
    var nomes1 = ["a", "b", "x", "y", "l1", "r1"];
    var nomes2 = ["ls", "rs", "select", "start", "guide"];
    for (var i = 0; i < nomes1.length; i++) {
        btnDot(LX + i * 26, 122, !!b[nomes1[i]], nomes1[i]);
    }
    for (var j = 0; j < nomes2.length; j++) {
        btnDot(LX + j * 26, 148, !!b[nomes2[j]], nomes2[j]);
    }
    if (st && st.b && st.b.length) {
        var extras = [];
        for (var k = 0; k < st.b.length; k++) {
            if (nomes1.indexOf(st.b[k]) < 0 && nomes2.indexOf(st.b[k]) < 0) extras.push(st.b[k]);
        }
        if (extras.length) {
            UI.text("+ " + extras.join(" "), LX, 176, { role: "caption", color: T.warn, w: LW, lines: 1 });
        }
    }

    // status + rumble
    var bat = s.battery >= 0 ? "bateria " + s.battery + "%" : "sem bateria";
    UI.text(bat + " · rssi " + s.rssi, LX, 194, { role: "caption", color: T.textDim, w: LW, lines: 1 });
    if (A.style.button("Rumble", LX, 216, LW, 38, { variant: "filled" })) {
        gp.rumble(0.3, 1.0, 400);
    }
}
telaLive.fps = 30;

// ---------------------------------------------------------------- pads --
function telaPads() {
    var h = A.header("Gamepad", { sub: "Bluetooth LE HID" });
    if (h) return A.BACK;

    if (!HAS_BT) {
        A.style.card(LX, 46, LW, 92, { draw: function (c) {
            UI.text("Sem gamepad BT", c.x, c.y, { role: "title", w: c.w, lines: 1 });
            UI.text("Este firmware/placa nao tem o host BLE HID (API 57). O teste roda no SmartDisplay e no watch, com a permissao \"input\".",
                    c.x, c.y + 22, { role: "caption", color: T.textDim, w: c.w, lines: 4 });
        }});
        UI.text("DualShock 4 nao funciona: e Bluetooth CLASSIC e o radio do S3 nao tem BR/EDR. Pads BLE: Xbox One S/Series e 8bitdo em modo BLE.",
                LX, 146, { role: "caption", color: T.warn, w: LW, lines: 4 });
        return;
    }

    // status do host
    A.style.card(LX, 46, LW, 40, { draw: function (c) {
        UI.text(phaseInfo(), c.x, c.y, { role: "caption", color: T.textDim, w: c.w, lines: 2 });
    }});

    if (A.style.button(busyMsg ? busyMsg : "Procurar pads", LX, 94, LW, 38, { variant: "filled" })) {
        busyMsg = "escaneando...";
        UI.invalidate();
        G.scan(3000);
        pads = G.pads();
        busyMsg = "";
        UI.invalidate();
        if (!pads.length) A.toast("nenhum pad HID achado");
    }

    // lista do ultimo scan
    var rows = [];
    for (var i = 0; i < pads.length; i++) {
        rows.push({
            label: pads[i].name || pads[i].addr,
            sub: pads[i].addr + " · " + pads[i].rssi + " dBm" +
                 (pads[i].gamepad ? " · gamepad" : " · HID"),
            right: pads[i].gamepad ? "BLE" : ""
        });
    }
    if (!rows.length) {
        UI.text("Coloque o pad em modo de pareamento (segure o botao de parear) e toque em Procurar.",
                LX, 142, { role: "caption", color: T.textDim, w: LW, lines: 4 });
    }
    var sel = UI.list("g-list", LX, 140, LW, BOT - 190, rows, { rowH: 48 });
    if (sel >= 0) {
        var alvo = pads[sel];
        busyMsg = "conectando...";
        UI.invalidate();
        var r = G.connect(alvo.addr);
        busyMsg = "";
        if (!r || !r.ok) {
            A.toast("falhou: " + ((r && r.err) || "?"));
            UI.invalidate();
            return;
        }
        gp = G.setup();
        if (!gp) {
            A.toast("pad sem HID map legivel");
            return;
        }
        UI.invalidate();
        return "live";
    }

    // bonds conhecidos (reconectar sem scan): botao "esquecer" por peer
    var bon = HAS_BT ? BT.paired() : [];
    for (var q = 0; q < bon.length && q < 2; q++) {
        if (A.style.button("Esquecer " + bon[q].addr.slice(-5), LX + q * 118, BOT - 26,
                           114, 22, { variant: "ghost" })) {
            BT.forget(bon[q].addr);
            A.toast("bond apagado");
        }
    }
}
telaPads.fps = 10;

// fps POR TELA (telaPads.fps / telaLive.fps): o opts.fps do A.run ganharia
// das duas e o tester ao vivo rodaria a 15 em vez de 30
A.run({ pads: telaPads, live: telaLive }, "pads");
