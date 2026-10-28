// Celular — o link com o Gadgetbridge (Phone Link) no CelerKit UI 2.0.
// ES5 puro (Duktape). Mostra o estado, o codigo de pareamento (grande) e
// as acoes: ligar/desligar, achar celular, esquecer o pareamento.
// O loop e o header vem do core (A.run); o cartao de estado usa os tokens do
// celeros.app.style e o icone de estado o celeros.app.icons. As acoes ficam
// na mesma faixa do layout antigo (o toque do harness nao muda) e o layout
// lateral sai do A.L/A.style.content (vidro redondo do watch).
// Sem Phone no firmware (CYD e outras placas) o app abre explicando.

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
A.init();
var T = A.style.preset("soft");

var L = A.style.content();
var X = L.x, W = L.w, CX = A.L.cx;
var HAS = typeof Phone !== "undefined" && Phone && typeof Phone.status === "function";

var B1 = [X, 176, W, 36], B2 = [X, 218, W, 36], B3 = [X, 262, W, 36];
var finding = false, confirmForget = false, last = "";

function pad6(n) {
    var s = String(n);
    while (s.length < 6) s = "0" + s;
    return s;
}

function drawStatus(st, full) {
    var on = !!st.enabled, con = !!st.connected;
    var ic = con ? "wifi" : on ? "search" : "close";
    var col = con ? T.ok : on ? T.warn : T.textDim;
    A.style.card(X, L.y, W, 102, { full: full, pad: 10, draw: function (q) {
        A.icons.draw(ic, q.x, q.y + 7, 22, { color: col });
        UI.text(!on ? "Desligado" : con ? "Conectado" : "Aguardando celular",
                q.x + 30, q.y + 8,
                { role: "title", color: T.text, bg: q.bg, id: "stt", w: q.w - 30, lines: 1 });
        var l1, l2;
        if (!on) {
            l1 = "O Phone Link está desligado.";
            l2 = "Toque em Ligar para parear.";
        } else if (!con) {
            l1 = "Gadgetbridge > + > Bangle.js";
            l2 = "aparece como:";
        } else {
            l1 = "Notificações, hora, música,";
            l2 = "clima e chamadas chegam aqui.";
        }
        UI.text(l1, q.x, q.y + 46, { role: "caption", color: T.textDim, bg: q.bg, w: q.w, lines: 1 });
        UI.text(l2, q.x, q.y + 62, { role: "caption", color: T.textDim, bg: q.bg, w: q.w, lines: 1 });
        if (on && !con) {
            UI.text(st.name || "", q.x, q.y + 78,
                    { role: "caption", color: T.accent, bg: q.bg, w: q.w, lines: 1 });
        }
    }});
}

function drawCode(st, full) {
    A.style.card(X, L.y, W, 160, { full: full, pad: 10, draw: function (q) {
        UI.text("Código de pareamento", CX, q.y + 10,
                { role: "caption", align: "center", color: T.textDim, bg: q.bg, w: q.w, lines: 1 });
        UI.text(pad6(st.passkey), CX, q.y + 34,
                { role: "display", align: "center", color: T.text, bg: q.bg, id: "pk", w: q.w, lines: 1 });
        UI.text("Digite este código no celular", CX, q.y + 78,
                { role: "body", align: "center", color: T.accent, bg: q.bg, w: q.w, lines: 2 });
        A.icons.draw("info", CX - 7, q.y + 116, 14, { color: T.textDim });
        UI.text("Gadgetbridge > + > Bangle.js", CX, q.y + 132,
                { role: "caption", align: "center", color: T.textDim, bg: q.bg, w: q.w, lines: 1 });
    }});
}

var main = function (c) {
    var st = HAS ? Phone.status() : null;
    var state = !st ? "sem link" : !st.enabled ? "desligado" : st.connected ? "conectado" : "aguardando";
    if (A.header("Celular", { sub: state })) return A.BACK;
    if (A.every(200, "st")) {
        var sig = JSON.stringify(st) + "|" + finding + "|" + confirmForget;
        if (sig !== last) { last = sig; UI.invalidate(); }
    }

    if (!HAS) {
        A.style.card(X, L.y, W, 120, { full: c.full, pad: 10, draw: function (q) {
            A.icons.draw("alert", q.x, q.y + 6, 18, { color: T.warn });
            UI.text("Sem Phone Link nesta placa", q.x + 24, q.y + 6,
                    { role: "title", color: T.warn, bg: q.bg, w: q.w - 24, lines: 2 });
            UI.text("Este app precisa do Bluetooth e do Phone Link do relógio para falar com o celular.",
                    q.x, q.y + 48,
                    { role: "caption", color: T.textDim, bg: q.bg, w: q.w, lines: 3 });
        }});
        return;
    }

    if (st.passkey) {
        drawCode(st, c.full);
        return;
    }

    drawStatus(st, c.full);
    if (A.style.button(st.enabled ? "Desligar" : "Ligar",
            B1[0], B1[1], B1[2], B1[3],
            { variant: st.enabled ? "ghost" : "primary" })) {
        Phone.setEnabled(!st.enabled);
        confirmForget = false;
        UI.invalidate();
    }
    if (A.style.button(finding ? "Parar de tocar" : "Achar celular",
            B2[0], B2[1], B2[2], B2[3],
            finding ? { color: T.warn, textColor: T.text, disabled: !st.connected }
                    : { variant: "ghost", disabled: !st.connected })) {
        finding = !finding;
        Phone.find(finding);
        UI.invalidate();
    }
    // fonte caption: o rotulo longo cabe sem cortar
    if (A.style.button(confirmForget ? "Confirmar: esquecer" : "Esquecer pareamento",
            B3[0], B3[1], B3[2], B3[3],
            { variant: confirmForget ? "danger" : "ghost", role: "caption" })) {
        if (!confirmForget) {
            confirmForget = true;
            UI.invalidate();
        } else {
            confirmForget = false;
            Phone.forget();
            A.toast("Esqueça no Android também");
        }
    }
    // toque fora dos botoes desfaz o braco de confirmacao
    var t = UI.touch();
    if (t.tap && confirmForget) {
        confirmForget = false;
        UI.invalidate();
    }
};
main.fps = 5;

A.run({ main: main }, "main");
