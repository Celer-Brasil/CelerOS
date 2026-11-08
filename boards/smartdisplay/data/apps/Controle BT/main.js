// Controle BT 1.1 — painel do driver HID Bluetooth LE (API 62) no CelerKit UI.
//
// O servico de fundo (service.js) mantem UM device HID pareado conectado e
// injeta no barramento do OS: gamepad -> Input.pad/ponteiro; teclado ->
// Input.key (digita nos campos de texto); mouse -> Input.move.
//
// Este painel mostra o estado e pareia um device novo. As preferencias sao
// as MESMAS do Ajustes (System.setting — fonte unica): bt_on, bt_ptr,
// bt_dev, mouse_on, mouse_speed. O Ajustes > Entrada/Bluetooth tem a tela
// completa (tipo, bateria, esquecer, fones).
//
// DualShock 4/DualSense/Switch Pro NAO funcionam: sao Bluetooth CLASSIC e o
// radio do S3 nao tem BR/EDR. Fones BT tambem nao (S3 sem A2DP). Pads BLE:
// Xbox One S/Series, 8bitdo BLE; teclados/mouse BLE HOGP.

var A = require("celeros.app");
require("celeros.app.style");
var H = require("celeros.hid");

A.init();
var T = A.style.T;
var LX = A.L.x, LW = A.L.w, BOT = A.L.bottom;

var HAS_BT = typeof BT !== "undefined";
var devs = [];
var busyMsg = "";

function prefBool(k, def) {
    var v = null;
    try { v = System.setting(k); } catch (e) { v = null; }
    if (v === null || v === "") return def;
    return v === "1" || v === "true" || v === "on";
}
function prefSet(k, v) {
    try { System.setting(k, v ? "1" : "0"); } catch (e) {
        A.toast("Sem permissao: configure no Ajustes");
    }
}
function prefSetStr(k, v) {
    try { System.setting(k, v); } catch (e) {
        A.toast("Sem permissao: configure no Ajustes");
    }
}

// O servico de fundo roda em OUTRA task e reconecta sozinho: sem o bt_busy
// ele entra com BT.connect no MEIO do scan/connect deste painel (o BleHid e
// single-link e os procedimentos sao bloqueantes — duas passadas em paralelo
// foi o que congelou o 4848). Mesmo contrato do Ajustes; a janela do lado do
// servico expira em 60 s, entao a lista em tela nao precisa renovar o selo.
var radioBusy = false;
function btBusy() {
    radioBusy = true;
    prefSetStr("bt_busy", String(System.millis()));
}
function btFree() {
    radioBusy = false;
    prefSetStr("bt_busy", "");
}

function kn(kind) {
    if (kind === "kbd") return "teclado";
    if (kind === "mouse") return "mouse";
    if (kind === "combo") return "teclado + mouse";
    if (kind === "pad") return "gamepad";
    return "HID";
}

function fase() {
    if (!HAS_BT) return "sem BT neste firmware/placa";
    var s = BT.state();
    if (s.phase === "ready") return s.name || s.addr;
    if (s.phase === "error") return "erro: " + (s.err || "?");
    if (s.phase === "connecting") return "conectando...";
    var alvo = "";
    try { alvo = System.setting("bt_dev") || ""; } catch (e) {}
    return alvo ? "procurando " + alvo : "nenhum device escolhido";
}

function telaHome() {
    var h = A.header("Controle BT", { sub: "teclado, mouse e gamepad" });
    if (h) {
        if (radioBusy) btFree();  // saiu com a lista em tela: solta o radio
        return A.BACK;
    }

    var ps = HAS_BT ? BT.state() : { phase: "off" };
    var l2 = ps.phase === "ready";

    A.style.card(LX, 46, LW, 70, { draw: function (c) {
        UI.text(fase(), c.x, c.y, { role: "title", w: c.w, lines: 1 });
        var sub = l2 ? kn(ps.kind) : "o servico reconecta quando o device ligar";
        if (l2 && ps.battery >= 0) sub += " · bateria " + ps.battery + "%";
        if (l2) sub += " · rssi " + ps.rssi;
        UI.text(sub, c.x, c.y + 26, { role: "caption", color: T.textDim, w: c.w, lines: 2 });
    }});

    var on = prefBool("bt_on", true);
    if (A.style.button(on ? "Driver: ligado" : "Driver: desligado", LX, 124, 106, 36,
                       { variant: on ? "filled" : "ghost" })) {
        prefSet("bt_on", !on);
        A.toast(on ? "driver desligado" : "driver ligado");
    }
    var ptr = prefBool("bt_ptr", true);
    if (A.style.button(ptr ? "Ponteiro: on" : "Ponteiro: off", LX + 118, 124, 106, 36,
                       { variant: ptr ? "filled" : "ghost" })) {
        prefSet("bt_ptr", !ptr);
        A.toast(ptr ? "ponteiro desligado" : "ponteiro ligado");
    }

    if (A.style.button(busyMsg ? busyMsg : "Procurar device", LX, 168, LW, 36,
                       { variant: "filled" })) {
        busyMsg = "escaneando...";
        UI.invalidate();
        btBusy();  // o servico para ANTES do disconnect (nao reconecta no meio)
        // o BleHid recusa scan com enlace vivo ("pad ja conectado") e o
        // resultado viraria a lista VELHA do cache sem aviso: derruba antes,
        // como o Ajustes faz. O selo FICA enquanto a lista esta em tela (a
        // janela do servico expira em 60 s; voltar/tapar limpa antes).
        if (BT.state().phase === "ready") BT.disconnect();
        devs = H.scan(3000);
        busyMsg = "";
        UI.invalidate();
        if (!devs.length) A.toast("nenhum device HID achado");
    }

    var rows = [];
    for (var i = 0; i < devs.length; i++) {
        rows.push({
            label: devs[i].name || devs[i].addr,
            sub: devs[i].addr + " · " + devs[i].rssi + " dBm · " +
                 kn(devs[i].kind)
        });
    }
    var sel = UI.list("c-list", LX, 212, LW, BOT - 260, rows, { rowH: 44 });
    if (sel >= 0) {
        busyMsg = "conectando...";
        UI.invalidate();
        btBusy();  // renova o selo: o servico nao disputa este connect
        var r = H.connect(devs[sel].addr);
        busyMsg = "";
        UI.invalidate();
        if (r && r.ok) {
            prefSetStr("bt_dev", devs[sel].addr);  // alvo novo ANTES de soltar o radio
            btFree();
            A.toast("pareado: " + kn(BT.state().kind));
        } else {
            btFree();  // falhou: o servico volta para o alvo que ja tinha
            A.toast("falhou: " + ((r && r.err) || "?"));
        }
    }
    UI.text("um device por vez · ajustes completos em Ajustes > Bluetooth",
            120, BOT - 26, { role: "caption", align: "center", color: T.textDim,
                             w: LW, id: "c-hint" });
}
telaHome.fps = 10;

if (!HAS_BT) {
    // placa/build sem BLE HID: explica e sai
    A.run({ so: function () {
        var h = A.header("Controle BT");
        if (h) return A.BACK;
        A.style.card(LX, 46, LW, 96, { draw: function (c) {
            UI.text("Sem HID BT", c.x, c.y, { role: "title", w: c.w, lines: 1 });
            UI.text("Este firmware nao tem o host BLE HID (API 57+). O driver roda no SmartDisplay e no watch.",
                    c.x, c.y + 24, { role: "caption", color: T.textDim, w: c.w, lines: 4 });
        }});
    }}, "so", { fps: 5 });
} else {
    A.run({ home: telaHome }, "home", { fps: 15 });
}
