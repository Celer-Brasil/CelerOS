// Timer — contagem regressiva em segundo plano no CelerKit.
// ES5 puro (Duktape). O tempo corre no firmware (System.setTimer): sair do
// app nao para nada; ao terminar, a tela de alarme do sistema toca.
// O loop e o header vem do core (A.run); botoes nativos do toolkit
// (UI.button) e aviso dentro do app (A.toast). O formato m:ss / h:mm:ss e
// do app (o A.fmt.dur do kit e narrado, nao cronometrado).

var A = require("celeros.app");
require("celeros.app.fmt");
A.init();

var INFO = {};
try { INFO = System.getInfo() || {}; } catch (e) { INFO = {}; }
var M = 12 + Math.round((INFO.inset || 0) / 2);   // margem lateral (cantos do vidro)

var PRESETS = [1, 3, 5, 10, 15, 30];   // minutos
var pick = 5 * 60;                      // segundos escolhidos (parado)
var last = "";

// cronometro: "5:00", "1:05:30" (A.fmt nao tem duracao de timer — fica aqui)
function fmt(s) {
    var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    return (h > 0 ? h + ":" + A.fmt.pad2(m) : String(m)) + ":" + A.fmt.pad2(ss);
}
function ctext(s, y, f, col) {
    System.setTextColor(col);
    System.drawString(s, Math.round((240 - System.textWidth(s, f)) / 2), y, f);
}

// geometria
var GW = Math.floor((240 - 2 * M - 12) / 3);
function presetRect(i) { return [M + (i % 3) * (GW + 6), 150 + Math.floor(i / 3) * 44, GW, 36]; }
var MINUS = [M, 82, 44, 44], PLUS = [240 - M - 44, 82, 44, 44];
var GO = [M + 20, 248, 240 - 2 * M - 40, 44];

// os botoes hit-testam E desenham (so quando precisa); devolvem o toque
function botoes(st) {
    if (st) {
        return UI.button("Cancelar", GO[0], GO[1], GO[2], GO[3], { style: "ghost" });
    }
    var r = "";
    if (UI.button("-", MINUS[0], MINUS[1], MINUS[2], MINUS[3], { style: "ghost" })) {
        pick = Math.max(30, pick - (pick > 300 ? 60 : 30));
        r = "pick";
    } else if (UI.button("+", PLUS[0], PLUS[1], PLUS[2], PLUS[3], { style: "ghost" })) {
        pick = Math.min(86400, pick + (pick >= 300 ? 60 : 30));
        r = "pick";
    } else if (UI.button("Iniciar", GO[0], GO[1], GO[2], GO[3], {})) {
        r = "go";
    } else {
        for (var i = 0; i < PRESETS.length; i++) {
            var rc = presetRect(i);
            var on = pick === PRESETS[i] * 60;
            // fonte caption: "10 min" cabe no botao estreito sem cortar
            if (UI.button(PRESETS[i] + " min", rc[0], rc[1], rc[2], rc[3],
                    on ? { color: A.T.accentD, textColor: A.T.text, role: "caption" }
                       : { style: "ghost", role: "caption" })) {
                pick = PRESETS[i] * 60;
                r = "pick";
            }
        }
    }
    return r;
}

A.run({
    main: function (c) {
        if (A.header("Timer")) return A.BACK;
        var st = System.getTimer();
        var sig = st ? "r" + st.remaining : "p" + pick;
        if (sig !== last) { last = sig; UI.invalidate(); }
        if (st) {
            if (c.full) {
                ctext(st.label ? st.label : "Timer", 76, 2, A.T.textDim);
                ctext(fmt(st.remaining), 116, 4, A.T.warn);
                ctext("roda em segundo plano", 170, 1, A.T.textDim);
            }
            if (botoes(st)) System.cancelTimer();
        } else {
            if (c.full) ctext(fmt(pick), 96, 4, A.T.text);
            var acao = botoes(st);
            if (acao === "pick") UI.invalidate();
            else if (acao === "go") {
                if (System.setTimer(pick, "Timer " + fmt(pick))) A.toast("Timer: " + fmt(pick));
            }
        }
    }
}, "main", { fps: 5 });
