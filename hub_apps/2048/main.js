// 2048 — deslize, junte iguais, chegue ao 2048. Sem a engine CelerGame:
// CelerKit (app/style/icons/widgets/data) + System.* no tabuleiro, entao roda
// tambem na CYD (sem PSRAM). O tabuleiro e uma area pintada pelo app (A.custom
// quando existe, senao o caminho de frame total por assinatura); o HUD, os
// botoes e os overlays usam o UI nativo. Recorde no Storage (A.data), sem FS.
// Animacao de deslize/estouro por millis (nenhum timer extra) e particulas
// simples nas fusoes. ES5 puro (Duktape).

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.widgets");
require("celeros.app.data");

A.init();
var T = A.style.preset("soft");
var S = System;
var L = A.L;

var N = 4;
var GAP = 5;
var CELL = Math.floor((L.w - (N - 1) * GAP) / N);
var BW = N * CELL + (N - 1) * GAP;
var BX = L.x + Math.floor((L.w - BW) / 2);
var BY = 54;
var PX = L.x + L.w - 26;                 // botao de pausa no HUD
var RX = PX - 6;                         // placar alinhado a direita
var BTN_Y = L.bottom - 26;
var BTN_W = Math.floor((L.w - 8) / 2);
var BTN_H = 24;

// cor/realce/frente por expoente (2, 4, 8...) — pre-calculado, uma vez
var TILE_BG = [], TILE_LO = [], TILE_FG = [];
(function () {
    for (var i = 1; i <= 16; i++) {
        var bg, fg;
        if (i <= 1) { bg = T.raised; fg = T.text; }
        else if (i === 2) { bg = T.stroke; fg = T.text; }
        else if (i === 3) { bg = T.accentD; fg = T.text; }
        else if (i === 4) { bg = T.accent; fg = T.onAccent; }
        else if (i === 5) { bg = T.warn; fg = T.onAccent; }
        else if (i === 6) { bg = T.err; fg = T.onAccent; }
        else {
            var k = i - 7;
            if (k > 6) k = 6;
            bg = S.mixColor(T.ok, T.bg, k * 5);
            fg = T.onAccent;
        }
        TILE_BG[i] = bg;
        TILE_LO[i] = S.mixColor(bg, 0xFFFF, 12);
        TILE_FG[i] = fg;
    }
})();

// notas da fusao por expoente (sem alocar melodia por jogada)
var NOTES = [0, 392, 440, 494, 523, 587, 659, 698, 784, 880, 988, 1047,
             1175, 1319, 1568, 1760, 1976];

var board = [], score = 0, hi = 0, won = false, over = false, paused = false;
var prevBoard = null, prevScore = 0, novoRec = false;
var anims = [], parts = [], HOLD = [];
var stamp = 1, nowMs = 0, fullFrame = false, wantNew = false;
var wasOverlay = false, recAt = 0;
var sigs = {};

var hv = A.data.loadState("hi", 0);
hi = (typeof hv === "number" && hv > 0) ? Math.floor(hv) : 0;
// migracao 1x do recorde da versao CelerGame (NVS do mesmo pacote)
if (!hi) {
    var oldHi = A.data.loadState("g2048.hi", 0);
    if (typeof oldHi === "number" && oldHi > 0) {
        hi = Math.floor(oldHi);
        A.data.saveState("hi", hi);
    }
}

function sfx(mel) {
    if (typeof System.sfx === "function") System.sfx(mel);
}
function playMerge(v) {
    var e = expOf(v);
    var n = NOTES[e] || 1047;
    sfx([[n, 30], [Math.round(n * 1.5), 45]]);
}

// ---------------------------------------------------------- area pintada ----
// A.custom (S3/local) ou o mesmo contrato no caminho base: no frame total
// pinta sempre; no parcial so quando a assinatura muda (e limpa a area).
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

// -------------------------------------------------------------- tabuleiro ---
function idx(x, y) { return y * N + x; }
function cellX(x) { return BX + x * (CELL + GAP); }
function cellY(y) { return BY + y * (CELL + GAP); }
function cellCX(x) { return cellX(x) + CELL / 2; }
function cellCY(y) { return cellY(y) + CELL / 2; }

function lineCell(dir, k, o) {
    return {
        x: (dir === "L") ? o : (dir === "R") ? N - 1 - o : k,
        y: (dir === "U") ? o : (dir === "D") ? N - 1 - o : k
    };
}

function emptyCells() {
    var out = [];
    for (var i = 0; i < N * N; i++) if (!board[i]) out.push(i);
    return out;
}

function canMove() {
    if (emptyCells().length) return true;
    for (var y = 0; y < N; y++) {
        for (var x = 0; x < N; x++) {
            var v = board[idx(x, y)];
            if (x + 1 < N && board[idx(x + 1, y)] === v) return true;
            if (y + 1 < N && board[idx(x, y + 1)] === v) return true;
        }
    }
    return false;
}

function expOf(v) {
    var e = 0;
    while (v > 1) { v = v / 2; e++; }
    return e < 1 ? 1 : (e > 16 ? 16 : e);
}

// --------------------------------------------------------------- animacao ---
var ANIM = 120, POP = 140;

function clearAnims() {
    anims.length = 0;
    parts.length = 0;
}

function slideAnim(sx, sy, dx, dy, v, delay) {
    anims.push({
        k: 0, v: v, dest: idx(dx, dy),
        x0: cellCX(sx), y0: cellCY(sy),
        x1: cellCX(dx), y1: cellCY(dy),
        t0: nowMs + delay, t1: nowMs + delay + ANIM
    });
}

function popAnim(x, y, v, delay) {
    anims.push({
        k: 1, v: v, dest: idx(x, y), cx: cellCX(x), cy: cellCY(y),
        t0: nowMs + delay, t1: nowMs + delay + POP
    });
}

function burst(cx, cy, color) {
    for (var i = 0; i < 6; i++) {
        var a = Math.random() * 6.2832;
        var sp = 30 + Math.random() * 35;
        parts.push({
            x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
            t0: nowMs, life: 240 + Math.random() * 120, c: color
        });
    }
    if (parts.length > 36) parts.splice(0, parts.length - 36);
}

function prune() {
    for (var i = anims.length - 1; i >= 0; i--) {
        if (nowMs >= anims[i].t1) anims.splice(i, 1);
    }
    for (var j = parts.length - 1; j >= 0; j--) {
        if (nowMs >= parts[j].t0 + parts[j].life) parts.splice(j, 1);
    }
}

function alive() {
    if (parts.length) return true;
    for (var i = 0; i < anims.length; i++) if (nowMs < anims[i].t1) return true;
    return false;
}

function easeOut(p) { var q = 1 - p; return 1 - q * q * q; }
function easeBack(p) {
    var q = p - 1;
    return 1 + 2.70158 * q * q * q + 1.70158 * q * q;
}

// ------------------------------------------------------------------ jogada ---
function line(dir, x, y) {
    var out = [];
    for (var i = 0; i < N; i++) {
        var xx = (dir === "L") ? i : (dir === "R") ? N - 1 - i : x;
        var yy = (dir === "U") ? i : (dir === "D") ? N - 1 - i : y;
        var v = board[idx(xx, yy)];
        if (v) out.push({ x: xx, y: yy, v: v });
    }
    return out;
}

function setLine(dir, x, y, arr) {
    for (var i = 0; i < N; i++) {
        var xx = (dir === "L") ? i : (dir === "R") ? N - 1 - i : x;
        var yy = (dir === "U") ? i : (dir === "D") ? N - 1 - i : y;
        board[idx(xx, yy)] = (i < arr.length) ? arr[i] : 0;
    }
}

function spawn(pop) {
    var e = emptyCells();
    if (!e.length) return -1;
    var k = e[Math.floor(Math.random() * e.length)];
    board[k] = (Math.random() < 0.9) ? 2 : 4;
    if (pop) popAnim(k % N, Math.floor(k / N), board[k], 0);
    return k;
}

function move(dir) {
    clearAnims();
    var snapB = board.slice(), snapS = score;
    var changed = false;
    for (var k = 0; k < N; k++) {
        var x = (dir === "L" || dir === "R") ? 0 : k;
        var y = (dir === "U" || dir === "D") ? 0 : k;
        var ln = line(dir, x, y);
        var out = [];
        var o = 0;
        for (var j = 0; j < ln.length; j++) {
            var dst = lineCell(dir, k, o);
            if (j + 1 < ln.length && ln[j].v === ln[j + 1].v) {
                var v2 = ln[j].v * 2;
                out.push(v2);
                score += v2;
                if (v2 === 2048) won = true;
                slideAnim(ln[j].x, ln[j].y, dst.x, dst.y, ln[j].v, 0);
                slideAnim(ln[j + 1].x, ln[j + 1].y, dst.x, dst.y, ln[j + 1].v, 0);
                popAnim(dst.x, dst.y, v2, ANIM);
                burst(cellCX(dst.x), cellCY(dst.y), TILE_BG[expOf(v2)]);
                playMerge(v2);
                j++;
            } else {
                out.push(ln[j].v);
                if (ln[j].x !== dst.x || ln[j].y !== dst.y) {
                    slideAnim(ln[j].x, ln[j].y, dst.x, dst.y, ln[j].v, 0);
                }
            }
            o++;
        }
        setLine(dir, x, y, out);
        if (ln.length !== out.length) changed = true;
        else {
            for (var m = 0; m < ln.length; m++) {
                var dc = lineCell(dir, k, m);
                if (ln[m].v !== out[m] || ln[m].x !== dc.x || ln[m].y !== dc.y) changed = true;
            }
        }
    }
    if (changed) {
        prevBoard = snapB;
        prevScore = snapS;
        spawn(true);
        stamp++;
        saveHi();
    }
    return changed;
}

function reset() {
    clearAnims();
    board.length = 0;
    for (var i = 0; i < N * N; i++) board.push(0);
    score = 0;
    won = false;
    over = false;
    paused = false;
    novoRec = false;
    prevBoard = null;
    prevScore = 0;
    stamp++;
    spawn(true);
    spawn(true);
}

function undo() {
    if (!prevBoard) return;
    clearAnims();
    board = prevBoard;
    prevBoard = null;
    score = prevScore;
    over = false;
    won = false;
    stamp++;
}

function saveHi() {
    if (score <= hi) return;
    hi = score;
    A.data.saveState("hi", hi);
    if (!novoRec) {
        novoRec = true;
        recAt = nowMs;
    }
}

// ----------------------------------------------------------------- desenho ---
function drawTile(px, py, size, v) {
    var e = expOf(v);
    var r = Math.max(3, Math.round(size / 9));
    var x = Math.round(px), y = Math.round(py);
    var sz = Math.round(size);
    S.fillGradient(x, y, sz, sz, TILE_LO[e], TILE_BG[e], r);
    S.setTextColor(TILE_FG[e]);
    S.setTextDatum(5);
    S.drawString(String(v), x + Math.round(sz / 2), y + Math.round(sz / 2),
                 (v < 100 && sz > 34) ? 4 : 2);
    S.setTextDatum(0);
}

function drawField() {
    S.fillSmoothRoundRect(BX - 7, BY - 7, BW + 14, BW + 14, 12, T.card);
    S.drawRoundRect(BX - 7, BY - 7, BW + 14, BW + 14, 12, T.stroke);

    var i;
    for (i = 0; i < N * N; i++) HOLD[i] = false;
    for (i = 0; i < anims.length; i++) if (nowMs < anims[i].t1) HOLD[anims[i].dest] = true;

    for (var y = 0; y < N; y++) {
        for (var x = 0; x < N; x++) {
            var px = cellX(x), py = cellY(y);
            var v = board[idx(x, y)];
            if (!v) {
                S.fillRoundRect(px, py, CELL, CELL, 6, T.bg);
            } else if (!HOLD[idx(x, y)]) {
                drawTile(px, py, CELL, v);
            }
        }
    }

    // pecas em voo e estouros
    for (i = 0; i < anims.length; i++) {
        var a = anims[i];
        if (nowMs < a.t0) continue;
        var p = (nowMs - a.t0) / (a.t1 - a.t0);
        if (p > 1) p = 1;
        if (a.k === 0) {
            var q = easeOut(p);
            var cx = a.x0 + (a.x1 - a.x0) * q;
            var cy = a.y0 + (a.y1 - a.y0) * q;
            drawTile(cx - CELL / 2, cy - CELL / 2, CELL, a.v);
        } else {
            var sc = CELL * (0.55 + 0.45 * easeBack(p));
            drawTile(a.cx - sc / 2, a.cy - sc / 2, sc, a.v);
        }
    }

    // particulas da fusao (posicao derivada do tempo, sem estado por quadro)
    for (i = 0; i < parts.length; i++) {
        var pt = parts[i];
        var dt = (nowMs - pt.t0) / 1000;
        var bx = pt.x + pt.vx * dt;
        var by = pt.y + pt.vy * dt + 60 * dt * dt;
        S.fillSmoothCircle(Math.round(bx), Math.round(by), 2, pt.c);
    }
}

// ------------------------------------------------------------------ telas ----
function menu(c) {
    fullFrame = c.full;
    A.style.card(L.x, 34, L.w, 118, { full: c.full, draw: function (r) {
        var cx = r.x + r.w / 2;
        UI.text("2048", cx, r.y, { role: "display", align: "center",
                                   w: r.w, color: T.accent, bg: r.bg });
        UI.text("Junte as peças iguais e chegue ao 2048.", cx, r.y + 34,
                { role: "caption", align: "center", w: r.w,
                  color: T.textDim, bg: r.bg, lines: 2 });
        UI.text("Recorde: " + hi, cx, r.y + 68,
                { role: "body", align: "center", w: r.w,
                  color: T.text, bg: r.bg });
    }});
    if (A.style.button("JOGAR", L.x + 24, 170, L.w - 48, 40)) {
        wantNew = true;
        return "jogo";
    }
    if (A.style.button("Como jogar", L.x + 24, 220, L.w - 48, 32,
                       { variant: "secondary" })) return "ajuda";
    UI.text("deslize para mover", 120, 274,
            { role: "caption", align: "center", color: T.textDim });
    var t = UI.touch();
    if (t.tap || (t.released && t.moved)) {
        wantNew = true;
        return "jogo";
    }
}
menu.fps = 20;

function ajuda(c) {
    fullFrame = c.full;
    A.style.card(12, 28, 216, 232, { full: c.full, draw: function (r) {
        UI.text("Como jogar", r.x, r.y, { role: "title", color: T.text, bg: r.bg,
                                          w: r.w });
        UI.text("Deslize para mover as peças. Iguais se juntam e dobram de valor. " +
                "Chegue à peça 2048. O botão Desfazer volta a última jogada, uma " +
                "vez por partida. Use Pausa para recomeçar ou sair.",
                r.x, r.y + 28, { role: "caption", color: T.textDim, bg: r.bg,
                                 w: r.w, lines: 9 });
    }});
    if (A.style.button("Voltar", 70, 274, 100, 32)) return A.BACK;
    if (UI.touch().tap) return A.BACK;
}
ajuda.fps = 15;

function drawPause(c) {
    A.style.card(16, 78, 208, 178, { full: c.full, draw: function (r) {
        var cx = r.x + r.w / 2;
        UI.text("PAUSA", cx, r.y, { role: "title", align: "center",
                                    w: r.w, color: T.text, bg: r.bg });
        UI.text("O jogo está congelado.", cx, r.y + 24,
                { role: "caption", align: "center", w: r.w,
                  color: T.textDim, bg: r.bg });
    }});
    if (A.style.button("Continuar", 36, 132, 168, 30)) return "resume";
    if (A.style.button("Recomeçar", 36, 170, 168, 30,
                       { variant: "secondary" })) return "restart";
    if (A.style.button("Menu", 36, 208, 168, 30,
                       { variant: "secondary" })) return "quit";
    return null;
}

function drawWin(c) {
    A.style.card(16, 72, 208, 190, { full: c.full, draw: function (r) {
        var cx = r.x + r.w / 2;
        UI.text("Você chegou ao 2048!", cx, r.y, { role: "title",
                align: "center", w: r.w, color: T.ok, bg: r.bg, lines: 2 });
        UI.text("Pontos: " + score, cx, r.y + 46, { role: "body",
                align: "center", w: r.w, color: T.text, bg: r.bg });
        UI.text("Recorde: " + hi, cx, r.y + 64, { role: "caption",
                align: "center", w: r.w, color: T.textDim, bg: r.bg });
    }});
    if (A.style.button("Continuar", 48, 196, 144, 34)) return "continue";
    return null;
}

function drawOver(c) {
    A.style.card(16, 78, 208, 178, { full: c.full, draw: function (r) {
        var cx = r.x + r.w / 2;
        UI.text("Sem movimentos!", cx, r.y, { role: "title",
                align: "center", w: r.w, color: T.err, bg: r.bg });
        UI.text("Pontos: " + score, cx, r.y + 30, { role: "body",
                align: "center", w: r.w, color: T.text, bg: r.bg });
        UI.text("Recorde: " + hi, cx, r.y + 50, { role: "caption",
                align: "center", w: r.w, color: T.textDim, bg: r.bg });
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
        reset();
    }
    prune();

    // jogada: so swipe (tap nao mexe no tabuleiro)
    if (!paused && !over && !won) {
        var t = UI.touch();
        if (t.released && t.moved) {
            var dx = t.x - t.sx, dy = t.y - t.sy;
            var adx = dx < 0 ? -dx : dx;
            var ady = dy < 0 ? -dy : dy;
            if (adx > 22 || ady > 22) {
                var dir = adx > ady ? (dx > 0 ? "R" : "L")
                                    : (dy > 0 ? "D" : "U");
                if (move(dir) && !canMove()) {
                    over = true;
                    saveHi();
                }
            }
        }
    }

    // overlay aberto: congela o tabuleiro (o card e slots nao podem ser
    // apagados pelo repaint da area pintada) — no frame total ele repinta
    var overlay = paused || won || over;
    if (overlay) {
        clearAnims();
        if (!wasOverlay) UI.invalidate();
    }
    wasOverlay = overlay;
    var sig = stamp + (alive() ? ":" + nowMs : "");
    if (!overlay || c.full) {
        paint("board", BX - 8, BY - 8, BW + 16, BW + 16, sig, drawField, T.bg);
    }

    // HUD
    UI.text("2048", L.x, 2, { role: "title", color: T.text, id: 1 });
    if (novoRec && nowMs - recAt < 1500) {
        UI.text("NOVO RECORDE!", L.x, 28, { role: "caption", color: T.ok, id: 2 });
    } else {
        UI.text("Recorde " + hi, L.x, 28, { role: "caption", color: T.textDim, id: 2 });
    }
    UI.text("PONTOS", RX, 2, { role: "caption", align: "right",
                               color: T.textDim, w: 100, id: 3 });
    UI.text(String(score), RX, 12, { role: "title", align: "right",
                                     color: T.text, w: 100, id: 4 });

    if (!overlay) {
        if (A.widgets.iconButton("menu", PX, 4, 26)) {
            paused = true;
            UI.invalidate();
        }
        if (A.style.button("Desfazer", L.x, BTN_Y, BTN_W, BTN_H,
                           { variant: "secondary", disabled: !prevBoard })) {
            undo();
        }
        if (A.style.button("Novo jogo", L.x + BTN_W + 8, BTN_Y, BTN_W, BTN_H,
                           { variant: "secondary" })) {
            saveHi();
            reset();
            UI.invalidate();
        }
    }

    if (paused) {
        var pa = drawPause(c);
        if (pa === "resume") { paused = false; UI.invalidate(); }
        else if (pa === "restart") { paused = false; reset(); UI.invalidate(); }
        else if (pa === "quit") { paused = false; return A.BACK; }
        return;
    }
    if (won) {
        var wa = drawWin(c);
        if (wa === "continue") { won = false; UI.invalidate(); }
        return;
    }
    if (over) {
        var oa = drawOver(c);
        if (oa === "again") { reset(); UI.invalidate(); }
        else if (oa === "menu") { saveHi(); return A.BACK; }
    }
}
jogo.fps = 30;

A.run({ menu: menu, ajuda: ajuda, jogo: jogo }, "menu");
