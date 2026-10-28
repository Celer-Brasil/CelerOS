// Campo Minado — o classico sobre o CelerKit (app/style/icons/widgets/data)
// e o motor puro do board.js. Sem a engine CelerGame: o tabuleiro e uma area
// pintada com System.* (A.custom quando existe, senao frame total por
// assinatura), entao roda tambem na CYD (sem PSRAM). Primeira jogada sempre
// segura, bandeiras (modo ou segurar a celula), acorde no numero com as
// bandeiras certas, cronometro, duas dificuldades e melhor tempo por
// dificuldade no Storage (A.data). ES5 puro (Duktape).

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.widgets");
require("celeros.app.data");
var createBoard = require("board");

A.init();
var T = A.style.preset("soft");
var S = System;
var L = A.L;

var MODES = [
    { name: "facil", label: "Fácil 9x11", cols: 9, rows: 11, mines: 10 },
    { name: "duro", label: "Duro 12x14", cols: 12, rows: 14, mines: 28 }
];
var NUMCOL = [0, T.accent, T.ok, T.err, T.warn, T.warn, T.text, T.text, T.textDim];

var TOPH = 36;                       // faixa do HUD
var BOTB = 32;                       // barra de botoes
var best = { facil: 0, duro: 0 };
(function () {
    var b = A.data.loadState("melhor", null);
    if (b && typeof b.facil === "number" && typeof b.duro === "number") {
        best.facil = Math.max(0, Math.floor(b.facil));
        best.duro = Math.max(0, Math.floor(b.duro));
        return;
    }
    // migracao 1x dos melhores tempos da versao CelerGame
    var f = A.data.loadState("minado.bfacil", 0);
    var d = A.data.loadState("minado.bduro", 0);
    if (typeof f === "number" && typeof d === "number") {
        best.facil = Math.max(0, Math.floor(f));
        best.duro = Math.max(0, Math.floor(d));
        if (best.facil || best.duro) A.data.saveState("melhor", best);
    }
})();

var modeIdx = 0;
var board = null;
var cell = 22, gx = 0, gy = 0, gw = 0, gh = 0;
var flagMode = false;
var started = false, running = false, finished = false, won = false;
var startStamp = 0, elapsed = 0, resultAt = 0;
var paused = false, showResult = false, wantNew = false;
var wasOverlay = false, stamp = 1, nowMs = 0, fullFrame = false;
var boomX = -1, boomY = -1;
var sigs = {};

var holdX = -1, holdY = -1, holdT0 = 0, holdDone = false, wasDown = false;

var BW = Math.floor((L.w - 8) / 2);
var BTN_Y = L.bottom - 26;

function sfx(mel) {
    if (typeof System.sfx === "function") System.sfx(mel);
}

// ---------------------------------------------------------- area pintada ----
function paint(id, x, y, w, h, sig, draw, bg) {
    if (bg === undefined) bg = T.bg;
    if (A.custom) return A.custom(id, x, y, w, h, sig, draw, { bg: bg });
    var k = "p" + id;
    if (!fullFrame && sigs[k] === sig) return false;
    sigs[k] = sig;
    if (!fullFrame) S.fillRect(x, y, w, h, bg);
    draw(x, y, w, h);
    return true;
}

function fmtTime(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
}

// ------------------------------------------------------------------ estado ---
function newGame() {
    var m = MODES[modeIdx];
    board = createBoard(m.cols, m.rows, m.mines);
    var availH = L.bottom - BOTB - TOPH;
    cell = Math.min(Math.floor(L.w / m.cols), Math.floor(availH / m.rows));
    gw = m.cols * cell;
    gh = m.rows * cell;
    gx = L.x + Math.floor((L.w - gw) / 2);
    gy = TOPH + Math.floor((availH - gh) / 2);
    flagMode = false;
    started = false;
    running = false;
    finished = false;
    won = false;
    elapsed = 0;
    startStamp = 0;
    resultAt = 0;
    paused = false;
    showResult = false;
    boomX = -1;
    boomY = -1;
    holdX = -1;
    holdY = -1;
    holdDone = false;
    wasDown = false;
    stamp++;
}

function cellAt(x, y) {
    var cx = Math.floor((x - gx) / cell);
    var cy = Math.floor((y - gy) / cell);
    if (cx < 0 || cy < 0 || cx >= MODES[modeIdx].cols || cy >= MODES[modeIdx].rows) {
        return null;
    }
    return { x: cx, y: cy };
}

function ensureStarted() {
    if (started) return;
    started = true;
    elapsed = 0;
    startStamp = nowMs;
    running = true;
}

function pauseClock() {
    if (running) {
        elapsed = nowMs - startStamp;
        running = false;
    }
}

function resumeClock() {
    if (started && !finished && !running) {
        startStamp = nowMs - elapsed;
        running = true;
    }
}

function finish(win) {
    if (finished) return;
    finished = true;
    won = win;
    running = false;
    elapsed = started ? (nowMs - startStamp) : 0;
    resultAt = nowMs;
    if (win) {
        var k = MODES[modeIdx].name;
        if (!best[k] || elapsed < best[k]) {
            best[k] = elapsed;
            A.data.saveState("melhor", best);
            A.toast("NOVO RECORDE!", 1500);
        }
        sfx([[660, 90], [880, 90], [1320, 160]]);
    } else {
        sfx([[120, 400]]);
    }
    stamp++;
    UI.invalidate();
}

function toggleFlag(x, y) {
    var c = board.cell(x, y);
    if (!c || c.open || finished) return;
    ensureStarted();
    var on = board.toggleFlag(x, y);
    if (on) sfx([[540, 30]]);
    stamp++;
}

function handleTap(x, y) {
    var p = cellAt(x, y);
    if (!p || finished) return;
    var c = board.cell(p.x, p.y);
    if (!c) return;
    if (flagMode) {
        if (!c.open) toggleFlag(p.x, p.y);
        return;
    }
    if (c.open) {
        if (c.n <= 0) return;
        var r0 = board.chord(p.x, p.y);
        if (r0.hit) {
            boomX = p.x;
            boomY = p.y;
            finish(false);
            return;
        }
        if (r0.opened.length) {
            ensureStarted();
            sfx([[620, 12], [820, 18]]);
            stamp++;
            if (board.won()) finish(true);
        }
        return;
    }
    ensureStarted();
    var r = board.reveal(p.x, p.y);
    if (r.hit) {
        boomX = p.x;
        boomY = p.y;
        finish(false);
        return;
    }
    if (r.opened.length) sfx([[620, 12], [820, 18]]);
    stamp++;
    if (board.won()) finish(true);
}

// ----------------------------------------------------------------- desenho ---
function drawCell(x, y) {
    var c = board.cell(x, y);
    if (!c) return;
    var px = gx + x * cell, py = gy + y * cell;
    var cx = px + cell / 2, cy = py + cell / 2;
    if (!c.open) {
        S.fillRoundRect(px + 1, py + 1, cell - 2, cell - 2, 4, T.raised);
        S.drawRoundRect(px + 1, py + 1, cell - 2, cell - 2, 4, T.stroke);
        if (c.flag) {
            S.fillTriangle(cx - 2, cy - cell * 0.28, cx + cell * 0.22, cy - 2,
                           cx - 2, cy + cell * 0.16, T.err);
            S.fillRect(cx - 2, cy - cell * 0.28, 2, Math.round(cell * 0.56), T.text);
        }
        return;
    }
    S.fillRect(px + 1, py + 1, cell - 2, cell - 2, S.mixColor(T.bg, T.card, 55));
    if (c.mine) {
        S.fillSmoothCircle(cx, cy, Math.round(cell * 0.26), T.err);
        S.fillSmoothCircle(cx - 2, cy - 2, 2, 0xFFFF);
    } else if (c.n > 0) {
        S.setTextColor(NUMCOL[c.n]);
        S.setTextDatum(5);
        S.drawString(String(c.n), Math.round(cx), Math.round(cy), 2);
        S.setTextDatum(0);
    }
}

// marca de bandeira errada depois da derrota (X em vermelho)
function drawWrongFlag(x, y) {
    var c = board.cell(x, y);
    if (!c || !c.flag || c.mine) return;
    var px = gx + x * cell, py = gy + y * cell;
    var cx = px + cell / 2, cy = py + cell / 2;
    var r = Math.round(cell * 0.25);
    S.drawWideLine(cx - r, cy - r, cx + r, cy + r, 2, T.err);
    S.drawWideLine(cx - r, cy + r, cx + r, cy - r, 2, T.err);
}

function drawField() {
    var i;
    for (var y = 0; y < MODES[modeIdx].rows; y++) {
        for (var x = 0; x < MODES[modeIdx].cols; x++) drawCell(x, y);
    }
    if (finished && !won) {
        for (y = 0; y < MODES[modeIdx].rows; y++) {
            for (x = 0; x < MODES[modeIdx].cols; x++) drawWrongFlag(x, y);
        }
    }

    var p = (nowMs - resultAt) / 600;
    if (p < 0) p = 0;
    if (p > 1) p = 1;
    if (finished && nowMs - resultAt < 600) {
        if (!won && boomX >= 0) {
            var bx = gx + boomX * cell + cell / 2;
            var by = gy + boomY * cell + cell / 2;
            S.drawCircle(bx, by, Math.round(3 + cell * 0.55 * p), T.warn);
            S.drawRect(gx + boomX * cell, gy + boomY * cell, cell - 1, cell - 1, T.err);
        } else if (won) {
            S.drawRect(gx - 3, gy - 3, gw + 5, gh + 5, T.ok);
            S.drawRect(gx - 2, gy - 2, gw + 3, gh + 3, T.ok);
        }
    }
}

// ------------------------------------------------------------------ telas ----
function menu(c) {
    fullFrame = c.full;
    A.style.card(L.x, 16, L.w, 78, { full: c.full, draw: function (r) {
        var cx = r.x + r.w / 2;
        UI.text("Campo Minado", cx, r.y, { role: "display", align: "center",
                w: r.w, lines: 2, color: T.accent, bg: r.bg });
        UI.text("Abra todas as casas sem pisar nas minas", cx, r.y + 42,
                { role: "caption", align: "center", w: r.w, lines: 2,
                  color: T.textDim, bg: r.bg });
    }});

    if (A.widgets.button("Fácil 9x11", L.x, 108, L.w, 36,
                         { icon: "play" })) {
        modeIdx = 0;
        wantNew = true;
        return "jogo";
    }
    UI.text("Melhor tempo: " + (best.facil ? fmtTime(best.facil) : "--:--"),
            L.x + L.w / 2, 148, { role: "caption", align: "center",
                                  color: best.facil ? T.text : T.textDim, id: 41 });

    if (A.widgets.button("Duro 12x14", L.x, 166, L.w, 36,
                         { icon: "play" })) {
        modeIdx = 1;
        wantNew = true;
        return "jogo";
    }
    UI.text("Melhor tempo: " + (best.duro ? fmtTime(best.duro) : "--:--"),
            L.x + L.w / 2, 206, { role: "caption", align: "center",
                                  color: best.duro ? T.text : T.textDim, id: 42 });

    if (A.style.button("Como jogar", L.x, 238, L.w, 30,
                       { variant: "secondary" })) return "ajuda";
    UI.text("a primeira jogada é sempre segura", L.x + L.w / 2, 282,
            { role: "caption", align: "center", w: L.w,
              color: T.textDim, id: 43 });
}
menu.fps = 20;

function ajuda(c) {
    fullFrame = c.full;
    A.style.card(12, 26, 216, 224, { full: c.full, draw: function (r) {
        UI.text("Como jogar", r.x, r.y, { role: "title", color: T.text, bg: r.bg, w: r.w });
        UI.text("Toque para abrir uma casa: a primeira jogada nunca é mina. " +
                "Segure uma casa fechada (ou use o modo bandeira) para marcar. " +
                "Tocar num número com as bandeiras certas abre os vizinhos. " +
                "Abra todas as casas sem mina para vencer. O melhor tempo fica " +
                "salvo por dificuldade.",
                r.x, r.y + 28, { role: "caption", color: T.textDim, bg: r.bg,
                                 w: r.w, lines: 10 });
    }});
    if (A.style.button("Voltar", 70, 262, 100, 30)) return A.BACK;
    if (UI.touch().tap) return A.BACK;
}
ajuda.fps = 15;

function drawPause(c) {
    A.style.card(16, 76, 208, 170, { full: c.full, draw: function (r) {
        var cx = r.x + r.w / 2;
        UI.text("PAUSA", cx, r.y, { role: "title", align: "center",
                                     w: r.w, color: T.text, bg: r.bg });
        UI.text("O cronômetro está parado.", cx, r.y + 24,
                { role: "caption", align: "center", w: r.w,
                  color: T.textDim, bg: r.bg });
    }});
    if (A.style.button("Continuar", 36, 132, 168, 30)) return "resume";
    if (A.style.button("Recomeçar", 36, 168, 168, 30,
                       { variant: "secondary" })) return "restart";
    if (A.style.button("Menu", 36, 204, 168, 30,
                       { variant: "secondary" })) return "quit";
    return null;
}

function drawResult(c) {
    A.style.card(16, 78, 208, 184, { full: c.full, draw: function (r) {
        var cx = r.x + r.w / 2;
        UI.text(won ? "VITÓRIA!" : "BOOM!", cx, r.y, { role: "title",
                align: "center", w: r.w, color: won ? T.ok : T.err, bg: r.bg });
        UI.text("Tempo " + fmtTime(elapsed), cx, r.y + 30, { role: "body",
                align: "center", w: r.w, color: T.text, bg: r.bg });
        UI.text("Melhor " + (best[MODES[modeIdx].name]
                             ? fmtTime(best[MODES[modeIdx].name]) : "--:--"),
                cx, r.y + 48, { role: "caption", align: "center",
                w: r.w, color: T.textDim, bg: r.bg });
    }});
    if (A.style.button("Jogar de novo", 36, 166, 168, 32)) return "again";
    if (A.style.button("Menu", 36, 206, 168, 32,
                       { variant: "secondary" })) return "menu";
    return null;
}

function jogo(c) {
    fullFrame = c.full;
    nowMs = c.now;
    if (c.entered || wantNew) {
        wantNew = false;
        newGame();
    }
    if (running && !paused && !finished) elapsed = nowMs - startStamp;

    var show = (finished && nowMs - resultAt >= 600);
    showResult = show;
    var overlay = paused || showResult;
    if (overlay && !wasOverlay) UI.invalidate();
    wasOverlay = overlay;

    // toque: tap abre/acorde, segurar marca bandeira
    if (!overlay && !finished) {
        var t = UI.touch();
        if (t.down) {
            if (!wasDown) {
                var p0 = cellAt(t.sx, t.sy);
                holdX = p0 ? p0.x : -1;
                holdY = p0 ? p0.y : -1;
                holdT0 = nowMs;
                holdDone = false;
            } else if (t.moved) {
                holdX = -1;
                holdY = -1;
            } else if (!holdDone && holdX >= 0 &&
                       nowMs - holdT0 >= 420) {
                var hc = board.cell(holdX, holdY);
                if (hc && !hc.open) {
                    toggleFlag(holdX, holdY);
                    holdDone = true;
                }
            }
        } else {
            if (t.released && t.tap && !holdDone) handleTap(t.x, t.y);
            holdX = -1;
            holdY = -1;
            holdDone = false;
        }
        wasDown = t.down;
    } else {
        wasDown = false;
        holdX = -1;
        holdY = -1;
    }

    var sig = stamp + ((finished && nowMs - resultAt < 600) ? ":" + nowMs : "");
    if (!overlay || c.full) {
        paint("campo", 0, 32, 240, L.bottom - 62, sig, drawField, T.bg);
    }

    // HUD: minas, cronometro e melhor tempo
    var m = MODES[modeIdx];
    var rem = board.remaining();
    var remS = (rem < 0 ? "-" + (-rem) : String(rem)) + " minas";
    UI.text(remS, L.x + 32, 6, { role: "body",
                                 color: rem === 0 ? T.ok : T.text, id: 51 });
    UI.text(fmtTime(elapsed), L.x + L.w, 4,
            { role: "title", align: "right", w: 90, color: T.text, id: 52 });
    if (best[m.name]) {
        UI.text("rec " + fmtTime(best[m.name]), L.x + L.w, 22,
                { role: "caption", align: "right", w: 90,
                  color: T.textDim, id: 53 });
    }

    if (!overlay && !finished) {
        if (A.widgets.iconButton("menu", L.x, 2, 26)) {
            paused = true;
            pauseClock();
            UI.invalidate();
        }
        if (A.style.button(flagMode ? "Bandeira ON" : "Modo cavar",
                           L.x, BTN_Y, BW, 26,
                           { variant: flagMode ? "primary" : "secondary" })) {
            flagMode = !flagMode;
            UI.invalidate();
        }
        if (A.style.button("Novo", L.x + BW + 8, BTN_Y, L.w - BW - 8, 26,
                           { variant: "secondary" })) {
            newGame();
            UI.invalidate();
        }
    }

    if (paused) {
        var pa = drawPause(c);
        if (pa === "resume") {
            paused = false;
            resumeClock();
            UI.invalidate();
        } else if (pa === "restart") {
            paused = false;
            newGame();
            UI.invalidate();
        } else if (pa === "quit") {
            paused = false;
            return A.BACK;
        }
        return;
    }
    if (showResult) {
        var ra = drawResult(c);
        if (ra === "again") {
            newGame();
            UI.invalidate();
        } else if (ra === "menu") {
            return A.BACK;
        }
    }
}
jogo.fps = 30;


A.run({ menu: menu, ajuda: ajuda, jogo: jogo }, "menu");
