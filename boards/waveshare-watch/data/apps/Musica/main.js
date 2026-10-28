// Musica — controle do player do celular (Phone Link/Gadgetbridge) no
// CelerKit UI 2.0. ES5 puro (Duktape). Phone.musicInfo() traz faixa/artista/
// estado; Phone.music(cmd) manda play/pause/next/previous/volume. O loop, o
// header e o tema vem do core (A.run/A.init); o cartao e os botoes de volume
// sao tokens do celeros.app.style e os controles de transporte sao uma area
// pintada (A.style.custom: UI.custom nativo nas S3, frame total + assinatura
// na CYD) com glifos vetoriais proprios (o set compartilhado nao tem
// pause/next/prev). O texto que chega do celular passa pelo celeros.app.text.
//
// 2.0.0: UI 2.0 no vidro redondo — cartao "tocando agora" com estado, faixa,
// artista, album e o nome do celular; transporte com botoes circulares
// (anterior/tocar-pausar/proxima) e volume; degrada sem Phone Link e sem
// celular pareado. Phone.music/musicInfo seguem iguais.

var A = require("celeros.app");
require("celeros.app.text");
require("celeros.app.style");
A.init();

var S = System;
var T = A.style.T;
var LX = A.L.x, LW = A.L.w, CX = A.L.cx;

var HAS = typeof Phone !== "undefined" && Phone && typeof Phone.music === "function";
var st = { connected: false, name: "" }, mi = null;
var last = "";

// ---- geometria -------------------------------------------------------------
var CARD_Y = 48, CARD_H = 112;
var CTL_Y = 168, CTL_H = 84, CTL_CY = CTL_Y + 42;
var VOL_Y = 262, VOL_H = 34;
var BTN_R = 30, SIDE_R = 20;

// ---- estado do player ------------------------------------------------------
function refresh() {
    st = HAS ? (Phone.status() || { connected: false }) : { connected: false };
    mi = HAS && typeof Phone.musicInfo === "function" ? Phone.musicInfo() : null;
    var sig = JSON.stringify(st) + JSON.stringify(mi);
    if (sig !== last) { last = sig; UI.invalidate(); }
}

function playing() { return !!(mi && mi.state === "play"); }
function stateText() {
    if (!HAS) return "Sem Phone Link";
    if (!st.connected) return "Celular desconectado";
    if (!mi) return "Nada tocando";
    if (mi.state === "play") return "Tocando";
    if (mi.state === "pause") return "Pausado";
    return "Parado";
}
function stateColor() {
    if (!HAS || !st.connected) return T.textDim;
    return playing() ? T.ok : T.textDim;
}

function send(cmd) {
    if (!HAS || !st.connected) return;
    try {
        Phone.music(cmd);
        if (S.beep) S.beep(1500, 15);
    } catch (e) { /* link caiu no meio: o poll corrige */ }
}

// ---- glifos do transporte (vetoriais, pintados no custom) ------------------
function glyph(kind, cx, cy, col) {
    if (kind === "play") {
        S.fillTriangle(cx - 5, cy - 9, cx - 5, cy + 9, cx + 10, cy, col);
    } else if (kind === "pause") {
        S.fillRect(cx - 7, cy - 8, 5, 16, col);
        S.fillRect(cx + 2, cy - 8, 5, 16, col);
    } else if (kind === "prev") {
        S.fillTriangle(cx + 7, cy - 8, cx + 7, cy + 8, cx - 7, cy, col);
        S.fillRect(cx - 11, cy - 8, 3, 16, col);
    } else if (kind === "next") {
        S.fillTriangle(cx - 7, cy - 8, cx - 7, cy + 8, cx + 7, cy, col);
        S.fillRect(cx + 8, cy - 8, 3, 16, col);
    }
}
function circleBtn(cx, cy, r, on, bg) {
    S.fillCircle(cx, cy, r, bg);
    S.drawCircle(cx, cy, r, on ? T.accent : T.stroke);
}

// transporte: pinta TUDO (cartao + 3 botoes + glifos) — nada de UI.* dentro
function transporte(t) {
    var pressed = "";
    if (HAS && st.connected && t.down) {
        var dxp = t.x - CX, dyp = t.y - CTL_CY;
        if (dxp * dxp + dyp * dyp <= BTN_R * BTN_R) pressed = "play";
        else if (t.x >= LX + 4 && t.x <= LX + 64 && Math.abs(t.y - CTL_CY) <= SIDE_R) pressed = "prev";
        else if (t.x >= LX + LW - 64 && t.x <= LX + LW - 4 && Math.abs(t.y - CTL_CY) <= SIDE_R) pressed = "next";
    }
    var sig = (playing() ? 1 : 0) + "|" + pressed + "|" + (HAS ? 1 : 0) + "|" +
              (st.connected ? 1 : 0);
    A.style.custom("mus-ctl", LX, CTL_Y, LW, CTL_H, sig, function (x, y, w, h) {
        S.fillRoundRect(x, y, w, h, T.radius, T.card);
        S.drawRoundRect(x, y, w, h, T.radius, T.stroke);
        var live = HAS && st.connected;
        var fg = live ? T.accent : T.stroke;
        // anterior / proxima (circulos menores)
        circleBtn(x + 34, CTL_CY, SIDE_R, pressed === "prev",
                  pressed === "prev" ? T.stroke : T.raised);
        glyph("prev", x + 34, CTL_CY, live ? T.text : T.textDim);
        circleBtn(x + w - 34, CTL_CY, SIDE_R, pressed === "next",
                  pressed === "next" ? T.stroke : T.raised);
        glyph("next", x + w - 34, CTL_CY, live ? T.text : T.textDim);
        // tocar/pausar (circulo grande)
        circleBtn(x + w / 2, CTL_CY, BTN_R, pressed === "play",
                  pressed === "play" ? T.accentD : fg);
        glyph(playing() ? "pause" : "play", x + w / 2, CTL_CY,
              live ? T.onAccent : T.card);
    }, { bg: T.bg });
}

// ---- tela ------------------------------------------------------------------
function main(c) {
    if (A.header("Música")) return A.BACK;
    if (A.every(200, "mi")) refresh();

    if (!HAS) {
        A.style.card(LX, CARD_Y, LW, CARD_H, { full: c.full, draw: function (r) {
            UI.text("Esta placa não tem", r.x, r.y, { role: "body", color: T.text,
                                                      w: r.w, lines: 1, id: "nb1" });
            UI.text("Phone Link", r.x, r.y + 18, { role: "title", color: T.accent,
                                                    w: r.w, lines: 1, id: "nb2" });
            UI.text("O controle do player vem do", r.x, r.y + 48,
                    { role: "caption", color: T.textDim, w: r.w, lines: 1, id: "nb3" });
            UI.text("Gadgetbridge (Bluetooth).", r.x, r.y + 62,
                    { role: "caption", color: T.textDim, w: r.w, lines: 1, id: "nb4" });
        }});
        return;
    }

    if (!st.connected) {
        A.style.card(LX, CARD_Y, LW, CARD_H, { full: c.full, draw: function (r) {
            UI.text("Celular desconectado", r.x, r.y, { role: "title", color: T.warn,
                                                        w: r.w, lines: 1, id: "dc1" });
            UI.text("Pareie o celular", r.x, r.y + 28,
                    { role: "body", color: T.text, w: r.w, lines: 1, id: "dc2" });
            UI.text("Adicione o relógio como", r.x, r.y + 50,
                    { role: "caption", color: T.textDim, w: r.w, lines: 1, id: "dc3" });
            UI.text("Bangle.js no Gadgetbridge.", r.x, r.y + 64,
                    { role: "caption", color: T.textDim, w: r.w, lines: 1, id: "dc4" });
        }});
        return;
    }

    // tocando agora
    A.style.card(LX, CARD_Y, LW, CARD_H, { full: c.full, draw: function (r) {
        S.fillCircle(r.x + 3, r.y + 5, 3, stateColor());   // led do estado
        UI.text(stateText(), r.x + 12, r.y,
                { role: "caption", color: stateColor(), w: r.w - 12, lines: 1, id: "st" });
        UI.text(A.text.fit(mi && mi.track ? mi.track : "Nada tocando"), r.x, r.y + 16,
                { role: "title", color: T.text, w: r.w, lines: 2, id: "trk" });
        UI.text(A.text.fit(mi && mi.artist ? mi.artist : ""), r.x, r.y + 44,
                { role: "body", color: T.textDim, w: r.w, lines: 1, id: "art" });
        UI.text(A.text.fit(mi && mi.album ? mi.album : ""), r.x, r.y + 60,
                { role: "caption", color: T.stroke, w: r.w, lines: 1, id: "alb" });
        A.style.divider(r.x, r.y + 74, r.w);
        UI.text(A.text.fit(st.name ? "via " + st.name : "Gadgetbridge"), r.x, r.y + 80,
                { role: "caption", color: T.textDim, w: r.w, lines: 1, id: "via" });
    }});

    // transporte (area pintada) + comando no toque
    var t = UI.touch();
    if (t.tap) {
        var dx = t.x - CX, dy = t.y - CTL_CY;
        if (dx * dx + dy * dy <= BTN_R * BTN_R) send("playpause");
        else if (t.x >= LX + 4 && t.x <= LX + 64 && Math.abs(dy) <= SIDE_R) send("previous");
        else if (t.x >= LX + LW - 64 && t.x <= LX + LW - 4 && Math.abs(dy) <= SIDE_R) send("next");
    }
    transporte(t);

    // volume no celular (botoes nativos; o toque deles nao chega ao transporte)
    var vw = Math.floor((LW - 8) / 2);
    if (A.style.button("Volume -", LX, VOL_Y, vw, VOL_H,
                       { variant: "secondary", role: "caption" })) send("volumedown");
    if (A.style.button("Volume +", LX + LW - vw, VOL_Y, vw, VOL_H,
                       { variant: "secondary", role: "caption" })) send("volumeup");
}

A.run({ main: main }, "main", { fps: 5 });
