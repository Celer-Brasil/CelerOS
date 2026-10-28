// Timer — contagem regressiva em segundo plano no CelerKit UI 2.0.
// ES5 puro (Duktape). O tempo corre no firmware (System.setTimer): sair do
// app nao para nada; ao terminar, a tela de alarme do sistema toca em tela
// cheia mesmo com o vidro apagado. O loop, o header e o tema vem do core
// (A.run/A.init); os cartoes e botoes sao tokens do celeros.app.style e o
// anel e uma area pintada pelo app (A.style.custom: UI.custom nativo nas S3,
// frame total + assinatura na CYD). O formato m:ss / h:mm:ss fica no app (o
// A.fmt.dur do kit e narrado, nao cronometrado).
//
// 2.0.0: UI 2.0 com anel de progresso, atalhos 1..30 min em chips, ajuste
// fino de 30 s/1 min, cartao do estado e cancelar em vermelho; o total do
// timer fica no Storage para o anel nascer certo quando o app reabre com um
// timer ja rodando.

var A = require("celeros.app");
require("celeros.app.fmt");
require("celeros.app.style");
A.init();

var T = A.style.T;
var S = System;
var LX = A.L.x, LW = A.L.w, CX = A.L.cx;

var PRESETS = [1, 3, 5, 10, 15, 30];   // minutos
var pick = 5 * 60;                      // segundos escolhidos (parado)
var total = 0;                          // total do timer em curso (anel)
var last = "";

// ---- geometria (vidro redondo encolhe A.L; nada fixo de tela) --------------
var CARD_Y = 48, CARD_H = 132;
var RING_CY = CARD_Y + 58, RING_R = 48;
var ADJ_Y = 184, ADJ_H = 36;
var PRE_Y = 234, PRE_H = 28;
var GO_Y = 266, GO_H = 34;

// cronometro: "5:00", "1:05:30"
function fmt(s) {
    var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    return (h > 0 ? h + ":" + A.fmt.pad2(m) : String(m)) + ":" + A.fmt.pad2(ss);
}

// total do timer em curso: gravado ao iniciar, para o anel sobreviver ao
// fechar/abrir o app; sem ele (timer criado por outro app) adota o restante
function saveTotal(sec) {
    total = sec;
    try { Storage.set("timer.total", String(sec)); } catch (e) { /* sem NVS: so o anel */ }
}
function loadTotal(remaining) {
    if (total > remaining) return total;
    var t = 0;
    try { t = parseInt(Storage.get("timer.total", "0"), 10) || 0; } catch (e) { t = 0; }
    total = t > remaining ? t : remaining;
    return total;
}

// ---- anel: area pintada (pinta TUDO com System.*, nada de UI.text dentro) --
function anel(c, frac, big, sub, color) {
    var sig = (big ? big : "") + "|" + sub + "|" + Math.round(frac * 240) + "|" + color;
    A.style.custom("timer-anel", LX, CARD_Y, LW, CARD_H, sig, function (x, y, w, h) {
        var cx = x + w / 2, cy = RING_CY;
        S.fillRoundRect(x, y, w, h, T.radius, T.card);
        S.drawRoundRect(x, y, w, h, T.radius, T.stroke);
        S.fillArc(cx, cy, RING_R - 8, RING_R, 0, 360, T.raised);
        if (frac > 0.004) S.fillArc(cx, cy, RING_R - 8, RING_R, -90, -90 + 360 * frac, color);
        var font = String(big).length > 5 ? 2 : 4;
        S.setTextColor(T.text);
        S.setTextDatum(5);
        S.drawString(String(big), cx, cy - 10, font);
        S.setTextColor(T.textDim);
        S.drawString(String(sub), cx, cy + RING_R + 8, 2);
        S.setTextDatum(0);
        S.setTextSize(1);
    }, { bg: T.bg });
}

// ---- tela ------------------------------------------------------------------
function main(c) {
    if (A.header("Timer")) return A.BACK;
    var st = null;
    try { st = System.getTimer(); } catch (e) { st = null; }
    var sig = st ? "r" + st.remaining : "p" + pick;
    if (sig !== last) { last = sig; UI.invalidate(); }

    if (st) {
        // rodando: anel esvazia; cancelar em vermelho
        var tot = loadTotal(st.remaining);
        var frac = tot > 0 ? st.remaining / tot : 0;
        anel(c, frac, fmt(st.remaining),
             st.label ? st.label : "em segundo plano", T.warn);
        // decorrido x total: o que o anel representa (o getTimer so traz o
        // restante; o total veio do Storage na largada)
        A.style.card(LX, ADJ_Y, LW, 52, { full: c.full, r: 12, draw: function (r) {
            UI.text("decorrido", r.x, r.y, { role: "caption", color: T.textDim,
                                              id: "elb" });
            UI.text(fmt(tot - st.remaining), r.x + r.w, r.y,
                    { role: "body", align: "right", color: T.text, id: "elv" });
            UI.text("total", r.x, r.y + 16, { role: "caption", color: T.textDim,
                                               id: "totb" });
            UI.text(fmt(tot), r.x + r.w, r.y + 16,
                    { role: "body", align: "right", color: T.text, id: "totv" });
        }});
        var cancelar = A.style.button("Cancelar", LX + 12, GO_Y, LW - 24, GO_H,
                                      { variant: "danger" });
        if (cancelar) {
            System.cancelTimer();
            UI.invalidate();
        }
        UI.text("toca mesmo com a tela apagada", CX, GO_Y - 16,
                { role: "caption", align: "center", color: T.textDim,
                  w: LW, lines: 1, id: "hintrun" });
        return;
    }

    // parado: anel enche conforme o tempo escolhido (escala de 30 min)
    total = 0;
    anel(c, Math.min(1, pick / 1800), fmt(pick), "selecionado", T.accent);

    // ajuste fino: -30 s / +30 s ate 5 min, depois -1 min / +1 min
    if (A.style.button("-", LX, ADJ_Y, 44, ADJ_H, { variant: "secondary", role: "title" })) {
        pick = Math.max(30, pick - (pick > 300 ? 60 : 30));
        UI.invalidate();
    }
    if (A.style.button("+", LX + LW - 44, ADJ_Y, 44, ADJ_H,
                       { variant: "secondary", role: "title" })) {
        pick = Math.min(86400, pick + (pick >= 300 ? 60 : 30));
        UI.invalidate();
    }
    UI.text("ajuste fino", CX, ADJ_Y + 6,
            { role: "caption", align: "center", color: T.textDim,
              w: LW - 96, lines: 1, id: "adjl" });
    UI.text(pick >= 300 ? "1 min por toque" : "30 s por toque", CX, ADJ_Y + 18,
            { role: "caption", align: "center", color: T.stroke,
              w: LW - 96, lines: 1, id: "adjs" });

    // chips 1..30 min numa linha (fonte caption MEDIDA para nao cortar)
    var cw = Math.floor((LW - 5 * 4) / 6);
    for (var i = 0; i < PRESETS.length; i++) {
        var on = pick === PRESETS[i] * 60;
        var bx = LX + i * (cw + 4);
        if (A.style.button(String(PRESETS[i]), bx, PRE_Y, cw, PRE_H,
                           on ? { color: T.accentD, textColor: T.text, role: "caption" }
                              : { variant: "ghost", role: "caption" })) {
            pick = PRESETS[i] * 60;
            UI.invalidate();
        }
    }
    UI.text("atalhos", CX, PRE_Y - 10,
            { role: "caption", align: "center", color: T.textDim,
              w: LW, lines: 1, id: "minl" });

    if (A.style.button("Iniciar", LX + 8, GO_Y, LW - 16, GO_H,
                       { color: T.accent, textColor: T.onAccent, role: "title" })) {
        saveTotal(pick);
        if (System.setTimer(pick, "Timer " + fmt(pick))) A.toast("Timer: " + fmt(pick));
        UI.invalidate();
    }
}

A.run({ main: main }, "main", { fps: 5 });
