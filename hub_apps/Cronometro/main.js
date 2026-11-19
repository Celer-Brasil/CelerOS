// CelerOS Cronometro — centesimos, voltas e total de cada intervalo no
// CelerKit UI 2.0: status em pill, tempo grande com anel de progresso no
// A.widgets.ring, voltas em lista rica (parcial + total, melhor/pior
// destacadas) e botoes grandes no A.style. Tudo no tema; sem PSRAM.
// ES5 (Duktape).

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.layout");
require("celeros.app.icons");
require("celeros.app.widgets");
A.init();

var T = A.style.T;

var area = A.layout.bounds({ top: 40 });
var gap = 6, footerH = 44;
var footer = { x: area.x, y: area.y + area.h - footerH, w: area.w, h: footerH };
var buttons = [];
for (var n = 0; n < 3; n++) buttons.push(A.layout.cell(footer, 3, 1, n, gap));
var body = { x: area.x, y: area.y, w: area.w, h: area.h - footerH - gap };
var wide = A.layout.columns(body, 200, gap) >= 2;
var lineH = UI.lineHeight("caption");
var clockH = UI.lineHeight("display");
var rowH = Math.max(32, UI.lineHeight("body") + lineH + 6);
var dial, list;
if (wide) {
    dial = A.layout.cell(body, 2, 1, 0, gap);
    list = A.layout.cell(body, 2, 1, 1, gap);
    // A lista precisa acomodar dois tempos e o numero da volta.
    var extra = Math.min(12, dial.w - 90);
    dial.w -= extra;
    list.x -= extra;
    list.w += extra;
} else {
    dial = { x: body.x, y: body.y, w: body.w, h: Math.max(76, clockH + lineH + 30) };
    list = { x: body.x, y: body.y + dial.h + gap, w: body.w, h: body.h - dial.h - gap };
}
var ringR = wide ? 36 : 23;
var ringX = dial.x + (wide ? Math.floor(dial.w / 2) : ringR + 10);
var ringY = dial.y + Math.floor(dial.h / 2) - (wide ? 22 : 0);
var timeX = wide ? ringX : ringX + ringR + 9;
var timeY = wide ? ringY + ringR + 6 : dial.y + Math.floor((dial.h - clockH) / 2);
var timeW = wide ? dial.w - 8 : dial.x + dial.w - timeX - 6;
var timeRole = UI.measure("00:00", "display") <= timeW ? "display" : "title";
var actionRole = UI.measure("Iniciar", "body") <= buttons[1].w - 12 ? "body" : "caption";
var align = wide ? "center" : "left";
var rowLabelH = lineH + 8;

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
        var number = "V" + (i + 1);
        rows.push({ label: wide ? swFmt(total) : number, sub: "+" + swFmt(split),
                    right: wide ? number : swFmt(total), rightColor: col });
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

        A.style.card(dial.x, dial.y, dial.w, dial.h, { full: c.full, elev: 0, draw: function () {
            var key = Math.floor((ms % 60000) / 50);
            if (c.full || key !== ringKey) {
                ringKey = key;
                A.widgets.ring(ringX, ringY, ringR, (ms % 60000) / 60000,
                               { th: 4, color: T.accent });
            }
            var statusY = wide ? ringY - ringR - lineH - 8 : timeY - lineH - 3;
            UI.text(running ? "rodando" : (accMs ? "pausado" : "parado"), timeX, statusY,
                    { role: "caption", color: running ? T.ok : T.textDim, align: align, w: timeW });
            UI.text("." + pad2(Math.floor(ms / 10) % 100), ringX, ringY - lineH / 2,
                    { role: "caption", color: T.accent, align: "center", w: ringR * 2 - 12 });
            var time = pad2(Math.floor(ms / 60000)) + ":" + pad2(Math.floor(ms / 1000) % 60);
            UI.text(time, timeX, timeY, { role: timeRole, color: T.text, align: align, w: timeW });
            if (running && laps.length) {
                UI.text("+" + swFmt(ms - laps[laps.length - 1]), timeX, timeY + clockH + 2,
                        { role: "caption", color: T.accent, align: align, w: timeW });
            }
        }});

        var rows = buildLaps();
        UI.text("Voltas", list.x + 4, list.y + 3, { role: "caption", color: T.textDim });
        UI.text(String(rows.length), list.x + list.w - 4, list.y + 3,
                { role: "caption", align: "right", color: T.accent });
        var listY = list.y + rowLabelH, listH = list.h - rowLabelH;
        if (rows.length) {
            UI.list("crono-voltas", list.x, listY, list.w, listH, rows, { rowH: rowH });
        } else {
            A.style.card(list.x, listY, list.w, listH, { full: c.full, elev: 0, draw: function (r) {
                UI.text("Nenhuma volta", r.x + r.w / 2, r.y + (r.h - lineH) / 2,
                        { role: "caption", align: "center", color: T.textDim, w: r.w });
            }});
        }

        var b = buttons[0];
        if (A.style.button("Volta", b.x, b.y, b.w, b.h, { variant: "ghost", disabled: !running }))
            addLap();
        b = buttons[1];
        if (A.style.button(running ? "Pausar" : "Iniciar", b.x, b.y, b.w, b.h,
                           { color: running ? T.warn : T.accent, textColor: T.onAccent, role: actionRole }))
            toggleRun();
        b = buttons[2];
        if (A.style.button("Zerar", b.x, b.y, b.w, b.h, { variant: "ghost" }))
            resetAll();
    }
}, "main", { fps: 30 });
