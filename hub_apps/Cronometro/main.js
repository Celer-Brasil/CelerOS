// Cronometro — centesimos, voltas e intervalos. ES5 puro (Duktape).
// Migrado para o CelerKit: o core celeros.app fica dono do frame (A.run)
// e cacheia tema/layout; celeros.app.fmt empresta o pad2 do sistema. O
// formato de relogio com centesimos (MM:SS.CC) e especifico do cronometro —
// o A.fmt.dur do kit nao tem essa precisao, entao se monta aqui com o pad2.

var A = require("celeros.app");
require("celeros.app.fmt");

// base de tempo: System.millis() acumulado; o tempo e as voltas sao
// UI.text — so o que muda vai ao vidro
var running = false;
var accMs = 0;          // tempo acumulado dos intervalos parados
var startMs = 0;        // System.millis() do ultimo start
var laps = [];          // totais no momento de cada volta

function elapsed() {
    return accMs + (running ? (System.millis() - startMs) : 0);
}

// cronometro com centesimos: "MM:SS.CC"
function swFmt(ms) {
    var cs = Math.floor(ms / 10) % 100;
    var s = Math.floor(ms / 1000) % 60;
    var m = Math.floor(ms / 60000);
    return A.fmt.pad2(m) + ":" + A.fmt.pad2(s) + "." + A.fmt.pad2(cs);
}

// Volta | Iniciar | Zerar (coordenadas fixas: o teste do js_harness toca aqui)
var BTN_Y = 252, BTN_H = 48, BTN_W = 70, BTN_GAP = 6;
var BX = [8, 8 + BTN_W + BTN_GAP, 8 + 2 * (BTN_W + BTN_GAP)];

// ------------------------------------------------------------- desenho -----
function drawLaps() {
    var T = A.T;
    UI.card(A.L.x, 122, A.L.w, BTN_Y - 130);
    // melhor/pior split (so faz sentido com 3+ voltas)
    var bestI = -1, worstI = -1, best = 1e15, worst = -1;
    for (var k = 1; k < laps.length; k++) {
        var sp = laps[k] - laps[k - 1];
        if (sp < best) { best = sp; bestI = k; }
        if (sp > worst) { worst = sp; worstI = k; }
    }
    var vazio = !laps.length;
    var start = Math.max(0, laps.length - 4);
    var rx = A.L.x + A.L.w - 12;
    for (var row = 0; row < 4; row++) {
        var i = laps.length - 1 - row;
        var y = 132 + row * 28;
        if (i < start) {
            UI.text(vazio ? "as voltas aparecem aqui" : "",
                    vazio ? A.L.cx : A.L.x + 12, y + 4,
                    { role: "caption", align: vazio ? "center" : "left",
                      color: T.textDim, id: 10 + row });
            UI.text("", rx, y, { align: "right", id: 20 + row });
            continue;
        }
        var total = laps[i];
        var split = total - (i > 0 ? laps[i - 1] : 0);
        var col = T.text;
        if (laps.length >= 3 && i === bestI && i > 0) col = T.ok;
        else if (laps.length >= 3 && i === worstI && i > 0) col = T.err;
        UI.text("V" + (i + 1) + "  +" + swFmt(split), A.L.x + 12, y, { color: col, id: 10 + row });
        UI.text(swFmt(total), rx, y, { align: "right", color: T.textDim, id: 20 + row });
    }
    UI.cardEnd();
}

// -------------------------------------------------------------- acoes ------
function toggleRun() {
    if (running) {
        accMs = elapsed();
        running = false;
    } else {
        startMs = System.millis();
        running = true;
    }
}

function lap() {
    if (!running) return;
    laps.push(elapsed());
}

function resetAll() {
    running = false;
    accMs = 0;
    laps = [];
}

// ------------------------------------------------------------------ main ---
A.run({
    main: function () {
        var T = A.T;
        // estado + tempo grande (centesimos ao vivo: so o texto muda)
        UI.badge(running ? "rodando" : "parado", 12, 14,
                 { color: running ? T.ok : T.raised,
                   textColor: running ? T.onAccent : T.textDim });
        UI.text("voltas: " + laps.length, A.L.x + A.L.w - 12, 16,
                { role: "caption", align: "right", color: T.textDim });
        UI.text(swFmt(elapsed()), A.L.cx, 56, { role: "display", align: "center" });
        // split da volta em curso (so quando ha cronometro andando e volta aberta)
        if (running && laps.length > 0) {
            UI.text("volta +" + swFmt(elapsed() - laps[laps.length - 1]), A.L.cx, 92,
                    { role: "caption", align: "center", color: T.textDim });
        }
        drawLaps();

        if (UI.button("Volta", BX[0], BTN_Y, BTN_W, BTN_H, { style: "ghost", disabled: !running })) lap();
        if (UI.button(running ? "Pausar" : "Iniciar", BX[1], BTN_Y, BTN_W, BTN_H)) toggleRun();
        if (UI.button("Zerar", BX[2], BTN_Y, BTN_W, BTN_H, { style: "ghost" })) resetAll();
    }
}, "main", { fps: 30 });
