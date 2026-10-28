// CelerOS Cronometro — centesimos, voltas e total de cada intervalo no
// CelerKit UI 2.0: status em pill, tempo grande com anel de progresso no
// A.widgets.ring, voltas em lista rica (parcial + total, melhor/pior
// destacadas) e botoes grandes no A.style. Tudo no tema; sem PSRAM.
// ES5 (Duktape).

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.widgets");
A.init();

var T = A.style.T;

// layout na area segura (watch redondo encolhe a largura/rodape); no
// retangular os valores sao os mesmos de sempre (8/84/160, y=252)
var LX = A.L.x, LW = A.L.w, TOP = A.L.top, BOT = A.L.bottom;
var BW = Math.floor((LW - 12) / 3);
var BX0 = LX, BX1 = LX + BW + 6, BX2 = LX + 2 * (BW + 6);
var BY = BOT - 60;

// ---- estado ----------------------------------------------------------------
var running = false;
var accMs = 0;          // tempo acumulado dos intervalos parados
var startMs = 0;        // millis do ultimo start
var laps = [];          // total no momento de cada volta
var ringKey = -999;

function elapsed() { return accMs + (running ? System.millis() - startMs : 0); }

function pad2(n) { return (n < 10 ? "0" : "") + n; }
// "MM:SS.CC" — centesimos que o A.fmt.dur nao tem
function swFmt(ms) {
    return pad2(Math.floor(ms / 60000)) + ":" + pad2(Math.floor(ms / 1000) % 60) +
           "." + pad2(Math.floor(ms / 10) % 100);
}

// ---- voltas (lista nativa; reconstroi so quando muda) -----------------------
var lapRows = null, lapStamp = -1;
function buildLaps() {
    if (lapStamp === laps.length && lapRows) return lapRows;
    lapStamp = laps.length;
    var rows = [], bestI = -1, worstI = -1, best = 1e15, worst = -1;
    for (var k = 1; k < laps.length; k++) {
        var sp = laps[k] - laps[k - 1];
        if (sp < best) { best = sp; bestI = k; }
        if (sp > worst) { worst = sp; worstI = k; }
    }
    for (var i = laps.length - 1; i >= 0; i--) {
        var total = laps[i];
        var split = total - (i > 0 ? laps[i - 1] : 0);
        var col = T.textDim;
        if (laps.length >= 3 && i > 0) {
            if (i === bestI) col = T.ok;
            else if (i === worstI) col = T.err;
        }
        rows.push({ label: "V" + (i + 1), sub: "+" + swFmt(split),
                    right: swFmt(total), rightColor: col });
    }
    lapRows = rows;
    return rows;
}

// ---- acoes -----------------------------------------------------------------
function toggleRun() {
    if (running) {
        accMs = elapsed();
        running = false;
    } else {
        startMs = System.millis();
        running = true;
    }
    UI.invalidate();
}
function addLap() {
    if (!running) return;
    laps.push(elapsed());
    UI.invalidate();
}
function resetAll() {
    running = false;
    accMs = 0;
    laps = [];
    UI.invalidate();
}

// ---- tela ------------------------------------------------------------------
A.run({
    main: function (c) {
        var ms = elapsed();

        var h = A.widgets.header("Cronômetro", { full: c.full });
        if (h.back) return A.BACK;

        UI.badge(running ? "rodando" : "parado", LX + 4, TOP - 2,
                 { color: running ? T.ok : T.raised,
                   textColor: running ? T.onAccent : T.textDim });
        UI.text("voltas: " + laps.length, LX + LW - 12, 49,
                { role: "caption", align: "right", color: T.textDim, id: "nl" });

        // tempo grande + anel do minuto corrente
        A.style.card(LX, TOP + 22, LW, 78, { full: c.full, r: 12, draw: function () {
            var key = Math.floor((ms % 60000) / 50) + (running ? 100000 : 0);
            if (c.full || key !== ringKey) {
                ringKey = key;
                A.widgets.ring(LX + 44, TOP + 61, 27, (ms % 60000) / 60000,
                               { th: 4, color: running ? T.ok : T.raised });
            }
            UI.text(pad2(Math.floor(ms / 60000)) + ":" +
                    pad2(Math.floor(ms / 1000) % 60), LX + 82, 86,
                    { role: "display", color: T.text, id: "t" });
            UI.text("." + pad2(Math.floor(ms / 10) % 100), LX + 82, 106,
                    { role: "title", color: T.accent, id: "cs" });
            if (running && laps.length) {
                // "parcial" curto: "volta em curso +MM:SS.CC" nao cabia nos
                // 132px ao lado do anel e o UI.text cortava para ".."
                UI.text("parcial +" + swFmt(ms - laps[laps.length - 1]),
                        LX + 82, 123, { role: "caption", color: T.textDim,
                                       w: LW - 92, lines: 1, id: "cur" });
            }
        }});

        // voltas
        var rows = buildLaps();
        if (!rows.length) {
            A.style.card(LX, TOP + 106, LW, BY - 6 - (TOP + 106), { full: c.full, r: 12, draw: function (r) {
                UI.text("as voltas aparecem aqui", r.x + r.w / 2, r.y + 34,
                        { role: "caption", align: "center", color: T.textDim,
                          w: r.w, id: "vaz" });
            }});
        } else {
            UI.list("crono-voltas", LX, TOP + 106, LW, BY - 6 - (TOP + 106), rows, { rowH: 30 });
        }

        // Volta | Iniciar/Pausar | Zerar (coordenadas do teste do js_harness)
        if (A.style.button("Volta", BX0, BY, BW, 48, { variant: "ghost", disabled: !running }))
            addLap();
        if (A.style.button(running ? "Pausar" : "Iniciar", BX1, BY, BW, 48,
                           { color: running ? T.warn : T.accent,
                             textColor: T.onAccent }))
            toggleRun();
        if (A.style.button("Zerar", BX2, BY, BW, 48, { variant: "ghost" }))
            resetAll();
    }
}, "main", { fps: 30 });
