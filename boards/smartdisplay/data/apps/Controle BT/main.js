// Controle BT 1.0 — painel do driver do gamepad (API 61) no CelerKit UI.
//
// Mostra o estado do pad (nome/bateria/fase), liga/desliga o driver e o
// ponteiro (chaves "on"/"ptr" no Storage — o servico reler a cada ~2 s) e
// pareia um pad novo (scan -> connect; o bond fica no NVS e o servico
// reconecta sozinho a partir dai).
//
// DualShock 4/DualSense/Switch Pro NAO funcionam: sao Bluetooth CLASSIC e o
// radio do S3 nao tem BR/EDR. Pads BLE: Xbox One S/Series, 8bitdo BLE.

var A = require("celeros.app");
require("celeros.app.style");
var G = require("celeros.gamepad");

A.init();
var T = A.style.T;
var LX = A.L.x, LW = A.L.w, CX = A.L.cx, BOT = A.L.bottom;

var HAS_BT = typeof BT !== "undefined";
var pads = [];
var busyMsg = "";

function prefOn(key) {
    try { return Storage.get(key, "1") === "1"; } catch (e) { return true; }
}
function setPref(key, v) {
    try { Storage.set(key, v ? "1" : "0"); } catch (e2) {}
}

function fase() {
    if (!HAS_BT) return "sem BT neste firmware/placa";
    var s = BT.state();
    if (s.phase === "ready") return s.name || s.addr;
    if (s.phase === "error") return "erro: " + (s.err || "?");
    if (s.phase === "connecting") return "conectando...";
    return "procurando pelo pad pareado...";
}

// ------------------------------------------------------------ pads --
function telaPads() {
    var h = A.header("Controle BT", { sub: "gamepad do OS" });
    if (h) return A.BACK;

    var ps = BT.state();

    // status do pad
    A.style.card(LX, 46, LW, 64, { draw: function (c) {
        UI.text(fase(), c.x, c.y, { role: "title", w: c.w, lines: 1 });
        var l2 = ps.phase === "ready";
        var bat = l2 && ps.battery >= 0 ? " · bateria " + ps.battery + "%" : "";
        UI.text(l2 ? "conectado" + bat + " · rssi " + ps.rssi
                   : "o servico reconecta sozinho quando o pad ligar",
                c.x, c.y + 26, { role: "caption", color: T.textDim, w: c.w, lines: 2 });
    }});

    // toggles do driver e do ponteiro
    var on = prefOn("on");
    if (A.style.button(on ? "Driver: ligado (tocar p/ desligar)" : "Driver: desligado (tocar p/ ligar)",
                       LX, 118, LW, 36, { variant: on ? "filled" : "ghost" })) {
        setPref("on", !on);
        A.toast(on ? "driver desligado" : "driver ligado");
    }
    var ptr = prefOn("ptr");
    if (A.style.button(ptr ? "Ponteiro (stick dir.): ligado" : "Ponteiro (stick dir.): desligado",
                       LX, 160, LW, 36, { variant: ptr ? "filled" : "ghost" })) {
        setPref("ptr", !ptr);
        A.toast(ptr ? "ponteiro desligado" : "ponteiro ligado");
    }

    // parear um pad novo
    if (A.style.button(busyMsg ? busyMsg : "Procurar pad", LX, 204, LW, 36, { variant: "filled" })) {
        busyMsg = "escaneando...";
        UI.invalidate();
        G.scan(3000);
        pads = G.pads();
        busyMsg = "";
        UI.invalidate();
        if (!pads.length) A.toast("nenhum pad HID achado");
    }
    var rows = [];
    for (var i = 0; i < pads.length; i++) {
        rows.push({
            label: pads[i].name || pads[i].addr,
            sub: pads[i].addr + " · " + pads[i].rssi + " dBm" +
                 (pads[i].gamepad ? " · gamepad" : " · HID")
        });
    }
    var sel = UI.list("c-list", LX, 248, LW, BOT - 296, rows, { rowH: 44 });
    if (sel >= 0) {
        busyMsg = "conectando...";
        UI.invalidate();
        var r = G.connect(pads[sel].addr);
        busyMsg = "";
        UI.invalidate();
        A.toast(r && r.ok ? "pad pareado" : "falhou: " + ((r && r.err) || "?"));
    }
}
telaPads.fps = 10;

if (!HAS_BT) {
    // placa/build sem BLE HID: explica e sai
    A.run({ so: function () {
        var h = A.header("Controle BT");
        if (h) return A.BACK;
        A.style.card(LX, 46, LW, 96, { draw: function (c) {
            UI.text("Sem gamepad BT", c.x, c.y, { role: "title", w: c.w, lines: 1 });
            UI.text("Este firmware nao tem o host BLE HID (API 57+). O driver roda no SmartDisplay e no watch.",
                    c.x, c.y + 24, { role: "caption", color: T.textDim, w: c.w, lines: 4 });
        }});
    }}, "so", { fps: 5 });
} else {
    A.run({ pads: telaPads }, "pads", { fps: 15 });
}
