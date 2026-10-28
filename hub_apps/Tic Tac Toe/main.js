// Tic Tac Toe — jogo da velha no tema do OS. Sem a engine CelerGame:
// CelerKit (app/style/icons/widgets/data) + tabuleiro pintado com System.*
// numa area do app, entao roda tambem na CYD (sem PSRAM). Um jogador com
// tres niveis (minimax no Impossivel) ou dois jogadores no mesmo aparelho;
// placar no Storage (A.data), linha de vitoria riscada, particulas e anel
// no fim. O bot joga por tempo (millis), sem timer extra. ES5 puro.

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.widgets");
require("celeros.app.data");

A.init();
var T = A.style.preset("soft");
var S = System;
var L = A.L;

var CELL = Math.min(64, Math.floor((L.w - 16) / 3));
var BW = CELL * 3;
var BX = Math.round(120 - BW / 2);
var BY = 64;

var WINS = [
    0, 1, 2, 3, 4, 5, 6, 7, 8,
    0, 3, 6, 1, 4, 7, 2, 5, 8,
    0, 4, 8, 2, 4, 6
];

var board = [0, 0, 0, 0, 0, 0, 0, 0, 0];
var turn = 1, winner = 0, winLine = -1;
var twoPlayers = false, difficulty = 1;
var diffNames = ["Fácil", "Médio", "Impossível"];
var score = { v: 0, d: 0, e: 0 };
var paused = false, showResult = false, resultAt = 0, botAt = 0;
var stamp = 1, nowMs = 0, fullFrame = false, wantNew = false;
var wasOverlay = false, parts = [], sigs = {};

(function () {
    var sc = A.data.loadState("placar", null);
    if (sc && typeof sc.v === "number" && typeof sc.d === "number" &&
        typeof sc.e === "number") {
        score.v = Math.max(0, Math.floor(sc.v));
        score.d = Math.max(0, Math.floor(sc.d));
        score.e = Math.max(0, Math.floor(sc.e));
        return;
    }
    // migracao 1x do placar da versao CelerGame
    var v = A.data.loadState("velha.v", 0);
    var d = A.data.loadState("velha.d", 0);
    var e = A.data.loadState("velha.e", 0);
    if (typeof v === "number" && typeof d === "number" && typeof e === "number") {
        score.v = Math.max(0, Math.floor(v));
        score.d = Math.max(0, Math.floor(d));
        score.e = Math.max(0, Math.floor(e));
        if (score.v || score.d || score.e) A.data.saveState("placar", score);
    }
})();

function saveScore() { A.data.saveState("placar", score); }

// som misturado quando o firmware tem (API 32); placa muda fica em silencio
function sfx(mel) {
    if (typeof System.sfx === "function") System.sfx(mel);
}

// ---------------------------------------------------------- area pintada ----
// A.custom (S3/local) ou frame total por assinatura no caminho base (CYD).
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

// ------------------------------------------------------------------ regras ---
function checkBoard(b) {
    for (var m = 0; m < 24; m += 3) {
        var v = b[WINS[m]];
        if (v !== 0 && v === b[WINS[m + 1]] && v === b[WINS[m + 2]]) {
            return { who: v, line: m / 3 };
        }
    }
    for (var j = 0; j < 9; j++) if (b[j] === 0) return null;
    return { who: 3, line: -1 };
}

// minimax com poda alfa-beta (mesma escolha otima, bem menos nos na CYD)
function minimax(b, depth, bot, alpha, beta) {
    var r = checkBoard(b);
    if (r) {
        if (r.who === 2) return 10 - depth;
        if (r.who === 1) return depth - 10;
        return 0;
    }
    if (depth > 8) return 0;
    var best = bot ? -99 : 99;
    for (var i = 0; i < 9; i++) {
        if (b[i] !== 0) continue;
        b[i] = bot ? 2 : 1;
        var s = minimax(b, depth + 1, !bot, alpha, beta);
        b[i] = 0;
        if (bot) {
            if (s > best) best = s;
            if (best > alpha) alpha = best;
        } else {
            if (s < best) best = s;
            if (best < beta) beta = best;
        }
        if (beta <= alpha) break;
    }
    return best;
}

function botMove() {
    var empty = [];
    for (var e = 0; e < 9; e++) if (board[e] === 0) empty.push(e);
    if (!empty.length) return -1;
    var choice = -1;
    var rnd = difficulty === 0 ||
              (difficulty === 1 && Math.random() > 0.6);
    if (rnd) {
        choice = empty[Math.floor(Math.random() * empty.length)];
    } else if (empty.length === 9) {
        choice = (Math.random() > 0.5) ? 4
                 : [0, 2, 6, 8][Math.floor(Math.random() * 4)];
    } else {
        var bestScore = -99;
        for (var i = 0; i < empty.length; i++) {
            var spot = empty[i];
            board[spot] = 2;
            var s = minimax(board, 0, false, -99, 99);
            board[spot] = 0;
            if (s > bestScore || (s === bestScore && Math.random() > 0.5)) {
                bestScore = s;
                choice = spot;
            }
        }
    }
    if (choice >= 0) board[choice] = 2;
    return choice;
}

// ------------------------------------------------------------------ estado ---
function ccx(i) { return BX + (i % 3) * CELL + CELL / 2; }
function ccy(i) { return BY + Math.floor(i / 3) * CELL + CELL / 2; }

function resultText() {
    if (winner === 3) return "EMPATE";
    if (twoPlayers) return winner === 1 ? "X VENCEU" : "O VENCEU";
    return winner === 1 ? "VITÓRIA" : "DERROTA";
}
function resultColor() {
    if (winner === 3) return T.textDim;
    if (!twoPlayers && winner === 2) return T.err;
    return T.ok;
}

function spawnEnd(line, color) {
    parts.length = 0;
    var n = (line >= 0) ? 3 : 1;
    for (var k = 0; k < n; k++) {
        var idx = (line >= 0) ? WINS[line * 3 + k] : 4;
        var cx = ccx(idx), cy = ccy(idx);
        for (var j = 0; j < 6; j++) {
            var a = Math.random() * 6.2832;
            var sp = 30 + Math.random() * 30;
            parts.push({ x: cx, y: cy,
                         vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                         t0: nowMs, life: 460 + Math.random() * 220,
                         c: color });
        }
    }
}

function finishTurn() {
    var r = checkBoard(board);
    if (!r) return false;
    winner = r.who;
    winLine = r.line;
    if (winner === 3) {
        score.e++;
        sfx([[330, 140]]);
        spawnEnd(-1, T.textDim);
    } else if (winner === 1) {
        score.v++;
        sfx([[523, 90], [659, 90], [784, 160]]);
        if (!twoPlayers) A.toast("NOVO RECORDE!", 1400);
        spawnEnd(winLine, T.ok);
    } else {
        score.d++;
        sfx(twoPlayers ? [[523, 90], [659, 90], [784, 160]]
                       : [[300, 90], [220, 90], [140, 220]]);
        spawnEnd(winLine, twoPlayers ? T.ok : T.err);
    }
    saveScore();
    resultAt = nowMs;
    stamp++;
    UI.invalidate();
    return true;
}

function resetGame() {
    for (var i = 0; i < 9; i++) board[i] = 0;
    turn = 1;
    winner = 0;
    winLine = -1;
    paused = false;
    showResult = false;
    botAt = 0;
    resultAt = 0;
    parts.length = 0;
    stamp++;
}

function animating() {
    return parts.length > 0 ||
           (winner !== 0 && nowMs - resultAt < 560);
}

// ----------------------------------------------------------------- desenho ---
function drawMark(i) {
    var v = board[i];
    if (!v) return;
    var cx = ccx(i), cy = ccy(i);
    var r = Math.round(CELL * 0.22);
    if (v === 1) {
        S.drawWideLine(cx - r, cy - r, cx + r, cy + r, 5, T.accent);
        S.drawWideLine(cx - r, cy + r, cx + r, cy - r, 5, T.accent);
    } else {
        S.fillSmoothCircle(cx, cy, r + 4, T.warn);
        S.fillSmoothCircle(cx, cy, r - 1, T.card);
    }
}

function drawBoard() {
    S.fillSmoothRoundRect(BX - 5, BY - 5, BW + 10, BW + 10, 12, T.card);
    S.drawRoundRect(BX - 5, BY - 5, BW + 10, BW + 10, 12, T.stroke);
    for (var k = 1; k < 3; k++) {
        S.fillRoundRect(BX + k * CELL - 1, BY + 6, 3, BW - 12, 2, T.stroke);
        S.fillRoundRect(BX + 6, BY + k * CELL - 1, BW - 12, 3, 2, T.stroke);
    }
    for (var i = 0; i < 9; i++) drawMark(i);

    if (winLine >= 0) {
        var a = WINS[winLine * 3], b = WINS[winLine * 3 + 2];
        var col = resultColor();
        var ax = ccx(a), ay = ccy(a), bx = ccx(b), by = ccy(b);
        S.drawWideLine(ax, ay, bx, by, 9, S.mixColor(col, T.bg, 55));
        S.drawWideLine(ax, ay, bx, by, 6, col);
    }

    // anel curto do fim (expande e some)
    if (winner !== 0 && nowMs - resultAt < 560) {
        var p = (nowMs - resultAt) / 560;
        S.drawCircle(120, BY + BW / 2, Math.round(12 + 58 * p), T.textDim);
    }

    for (var j = 0; j < parts.length; j++) {
        var pt = parts[j];
        var dt = (nowMs - pt.t0) / 1000;
        S.fillSmoothCircle(Math.round(pt.x + pt.vx * dt),
                           Math.round(pt.y + pt.vy * dt), 2, pt.c);
    }
}

// ------------------------------------------------------------------ telas ----
function menu(c) {
    fullFrame = c.full;
    A.style.card(L.x, 16, L.w, 76, { full: c.full, draw: function (r) {
        var cx = r.x + r.w / 2;
        UI.text("Jogo da Velha", cx, r.y, { role: "display", align: "center",
                w: r.w, lines: 2, color: T.accent, bg: r.bg });
        UI.text("Você contra a máquina ou um amigo", cx, r.y + 46,
                { role: "caption", align: "center", w: r.w,
                  color: T.textDim, bg: r.bg });
    }});

    A.style.card(L.x, 100, L.w, 58, { full: c.full, draw: function (r) {
        var lab = twoPlayers ? ["X", "Empates", "O"] : ["Você", "Empates", "Bot"];
        var val = [score.v, score.e, score.d];
        var col = [T.ok, T.text, T.err];
        var cols = [r.x + r.w / 6, r.x + r.w / 2, r.x + r.w * 5 / 6];
        for (var i = 0; i < 3; i++) {
            UI.text(lab[i], cols[i], r.y + 4,
                    { role: "caption", align: "center", w: r.w / 3,
                      color: T.textDim, bg: r.bg });
            UI.text(String(val[i]), cols[i], r.y + 18,
                    { role: "title", align: "center", w: r.w / 3,
                      color: col[i], bg: r.bg });
        }
    }});

    UI.text("Modo", L.x, 162, { role: "caption", color: T.textDim, id: 21 });
    var sel = twoPlayers ? 1 : 0;
    var mi = A.widgets.segmented(L.x, 172, L.w, 28,
                                 ["1 jogador", "2 jogadores"], sel);
    if ((mi === 1) !== twoPlayers) {
        twoPlayers = (mi === 1);
        UI.invalidate();
    }

    var diffLabel = twoPlayers ? "Só no modo 1 jogador"
                               : ("Dificuldade: " + diffNames[difficulty]);
    if (A.style.button(diffLabel, L.x, 206, L.w, 30,
                       { variant: "secondary", disabled: twoPlayers })) {
        difficulty = (difficulty + 1) % 3;
        UI.invalidate();
    }

    if (A.style.button("JOGAR", L.x, 244, L.w, 36)) {
        wantNew = true;
        return "jogo";
    }
    if (A.style.button("Como jogar", L.x, 286, L.w, 28,
                       { variant: "secondary" })) return "ajuda";
}
menu.fps = 20;

function ajuda(c) {
    fullFrame = c.full;
    A.style.card(12, 26, 216, 224, { full: c.full, draw: function (r) {
        UI.text("Como jogar", r.x, r.y, { role: "title", color: T.text, bg: r.bg, w: r.w });
        UI.text("Cada jogador marca uma casa vazia; X começa. Alinhe três na " +
                "horizontal, vertical ou diagonal para vencer. Em 1 jogador, a " +
                "dificuldade escolhe o bot: Fácil sorteia, Médio às vezes erra e " +
                "Impossível nunca perde. Em 2 jogadores, X e O se revezam no " +
                "mesmo aparelho. O placar fica salvo.",
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
        UI.text("A partida está congelada.", cx, r.y + 24,
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
    A.style.card(16, 84, 208, 152, { full: c.full, draw: function (r) {
        var cx = r.x + r.w / 2;
        UI.text(resultText(), cx, r.y, { role: "title", align: "center",
                w: r.w, color: resultColor(), bg: r.bg });
        UI.text(twoPlayers ? ("X " + score.v + "  Empates " + score.e + "  O " + score.d)
                           : ("Você " + score.v + "  Empates " + score.e + "  Bot " + score.d),
                cx, r.y + 28, { role: "caption", align: "center", w: r.w,
                                color: T.textDim, bg: r.bg });
    }});
    if (A.style.button("De novo", 36, 148, 168, 30)) return "again";
    if (A.style.button("Menu", 36, 186, 168, 30,
                       { variant: "secondary" })) return "menu";
    return null;
}

function jogo(c) {
    fullFrame = c.full;
    nowMs = c.now;
    if (c.entered || wantNew) {
        wantNew = false;
        resetGame();
    }

    // vez do bot: jogada por tempo (sem timer extra)
    if (!paused && !winner && !twoPlayers && turn === 2 && botAt &&
        nowMs >= botAt) {
        botAt = 0;
        if (botMove() >= 0) {
            stamp++;
            sfx([[523, 40]]);
            if (!finishTurn()) turn = 1;
        }
    }

    var show = (winner !== 0 && nowMs - resultAt >= 700);
    showResult = show;
    var overlay = paused || showResult;
    if (overlay) {
        parts.length = 0;
        if (!wasOverlay) UI.invalidate();
    }
    wasOverlay = overlay;

    // toque numa casa vazia (so na vez do humano)
    if (!overlay && !winner) {
        var t = UI.touch();
        if (t.tap) {
            var gx = Math.floor((t.x - BX) / CELL);
            var gy = Math.floor((t.y - BY) / CELL);
            if (gx >= 0 && gx < 3 && gy >= 0 && gy < 3) {
                var idx = gy * 3 + gx;
                var humano = twoPlayers || turn === 1;
                if (humano && board[idx] === 0) {
                    board[idx] = turn;
                    stamp++;
                    sfx([[523, 40]]);
                    if (!finishTurn()) {
                        turn = turn === 1 ? 2 : 1;
                        if (!twoPlayers && turn === 2) botAt = nowMs + 320;
                    }
                }
            }
        }
    }

    var sig = stamp + (animating() ? ":" + nowMs : "");
    if (!overlay || c.full) {
        paint("velha", 0, 44, 240, 222, sig, drawBoard, T.bg);
    }

    // HUD
    var status, scol;
    if (winner !== 0) {
        status = resultText();
        scol = resultColor();
    } else if (twoPlayers) {
        status = "Vez do " + (turn === 1 ? "X" : "O");
        scol = turn === 1 ? T.accent : T.warn;
    } else {
        status = turn === 1 ? "Sua vez (X)" : "Bot pensando...";
        scol = turn === 1 ? T.accent : T.warn;
    }
    UI.text(status, L.x + 32, 6, { role: "body", color: scol, id: 31 });
    UI.text(twoPlayers ? ("X " + score.v + "  E " + score.e + "  O " + score.d)
                       : ("V " + score.v + "  E " + score.e + "  D " + score.d),
            L.x + 32, 22, { role: "caption", color: T.textDim, id: 32 });

    if (!overlay && !winner) {
        if (A.widgets.iconButton("menu", L.x, 4, 26)) {
            paused = true;
            botAt = 0;
            UI.invalidate();
        }
    }
    UI.text((!winner && !overlay) ? "toque numa casa" : "",
            120, 270, { role: "caption", align: "center",
                        color: T.textDim, bg: T.bg, id: 33 });

    if (paused) {
        var pa = drawPause(c);
        if (pa === "resume") {
            paused = false;
            if (!twoPlayers && !winner && turn === 2) botAt = nowMs + 300;
            UI.invalidate();
        } else if (pa === "restart") {
            resetGame();
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
            resetGame();
            UI.invalidate();
        } else if (ra === "menu") {
            return A.BACK;
        }
    }
}
jogo.fps = 30;

A.run({ menu: menu, ajuda: ajuda, jogo: jogo }, "menu");
