// CelerOS Tic Tac Toe — jogo da velha no tema do OS. Porte CelerGame:
// cenas do core (menu static com seletores segmentados, tabuleiro static,
// fim de jogo proprio no lugar do dialogo nativo), bot jogando pelo
// E.after (antes o loop bloqueava 250 ms "pensando"), placar no NVS e fx
// na linha vencedora. 1 jogador (minimax no impossivel) ou 2 no mesmo
// aparelho.

var E = require("celeros.game");       // familia CelerGame: core + fx
require("celeros.game.fx");

E.init({ dir: "Tic Tac Toe", fps: 30, save: "velha." });
var T = E.theme, W = E.W, H = E.H;

// placar: NVS do core — o score.txt da versao anterior entra como migricao
var score = { v: E.save.num("v", 0), d: E.save.num("d", 0), e: E.save.num("e", 0) };
try {
    var raw = FS.readTextFile((FS.appData ? FS.appData() : "/local/") + "score.txt");
    var p = raw ? raw.split(",") : [];
    if (p.length === 3) {
        score.v = Math.max(score.v, parseInt(p[0], 10) || 0);
        score.d = Math.max(score.d, parseInt(p[1], 10) || 0);
        score.e = Math.max(score.e, parseInt(p[2], 10) || 0);
        E.save.set("v", score.v); E.save.set("d", score.d); E.save.set("e", score.e);
    }
} catch (e) {}
function saveScore() {
    E.save.set("v", score.v); E.save.set("d", score.d); E.save.set("e", score.e);
}

// Som: System.sfx (API 32) mistura por cima da trilha sem travar o loop;
// firmware antigo cai no playTone (bloqueante)
var somFn = typeof System.sfx === "function" ? System.sfx :
            (typeof System.playTone === "function" ? System.playTone : null);
function tone(hz, ms) { if (somFn) { try { somFn([[hz, ms]]); } catch (e) {} } }

var board = [0, 0, 0, 0, 0, 0, 0, 0, 0];   // 0 vazio | 1 X | 2 O
var turn = 1;
var winner = 0;                             // 0 ninguem | 1 X | 2 O | 3 empate
var winLine = -1;                           // indice do trio vencedor
var twoPlayers = false;
var difficulty = 1;                         // 0 facil | 1 medio | 2 impossivel
var diffNames = ["Fácil", "Médio", "Impossível"];
var botPend = null;                         // timer do "bot pensando"
var juiceT = 0;                             // particulas vivas: repinta

var CELL = 62, OX = 27, OY = 88;

var WINS = [
    0, 1, 2, 3, 4, 5, 6, 7, 8,
    0, 3, 6, 1, 4, 7, 2, 5, 8,
    0, 4, 8, 2, 4, 6
];

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

function minimax(b, depth, bot) {
    if (depth === 1) System.delay(1);       // cede ao watchdog nos ramos fundos
    var r = checkBoard(b);
    if (r) {
        if (r.who === 2) return 10 - depth;
        if (r.who === 1) return depth - 10;
        return 0;
    }
    if (depth > 7) return 0;                // teto de profundidade pro ESP32
    var best = bot ? -99 : 99;
    for (var i = 0; i < 9; i++) {
        if (b[i] !== 0) continue;
        b[i] = bot ? 2 : 1;
        var s = minimax(b, depth + 1, !bot);
        b[i] = 0;
        if (bot ? s > best : s < best) best = s;
    }
    return best;
}

function botMove() {
    var empty = [];
    for (var e = 0; e < 9; e++) if (board[e] === 0) empty.push(e);

    var rnd = false;
    if (difficulty === 0) rnd = true;
    else if (difficulty === 1) rnd = Math.random() > 0.6;
    var choice = -1;

    if (empty.length === 0) return;
    if (rnd) {
        choice = empty[Math.floor(Math.random() * empty.length)];
    } else if (empty.length === 9) {
        choice = Math.random() > 0.5 ? 4 : [0, 2, 6, 8][Math.floor(Math.random() * 4)];
    } else {
        var bestScore = -99;
        for (var i = 0; i < empty.length; i++) {
            var spot = empty[i];
            board[spot] = 2;
            var s = minimax(board, 0, false);
            board[spot] = 0;
            if (s > bestScore || (s === bestScore && Math.random() > 0.5)) {
                bestScore = s;
                choice = spot;
            }
        }
    }
    if (choice >= 0) board[choice] = 2;
    tone(392, 40);
}

// ---------------------------------------------------------------- desenho ----
function cellCenter(idx) {
    return {
        x: OX + (idx % 3) * CELL + CELL / 2,
        y: OY + Math.floor(idx / 3) * CELL + CELL / 2
    };
}

function drawMark(idx) {
    var c = cellCenter(idx);
    var v = board[idx];
    if (v === 1) {
        var r = 15;
        E.gfx.line(c.x - r, c.y - r, c.x + r, c.y + r, T.accent, { w: 5 });
        E.gfx.line(c.x - r, c.y + r, c.x + r, c.y - r, T.accent, { w: 5 });
    } else if (v === 2) {
        E.gfx.circle(c.x, c.y, 18, T.warn, { smooth: true });
        E.gfx.circle(c.x, c.y, 13, T.card, { smooth: true });
    }
}

function drawBoard() {
    var vez = twoPlayers ? ("Vez do " + (turn === 1 ? "X" : "O"))
                         : (turn === 1 ? "Sua vez (X)" : "Bot pensando...");
    E.gfx.text(vez, 12, 12, { ts: "title", color: turn === 1 ? T.accent : T.warn });
    E.gfx.rect(168, 12, E.gfx.measure("V" + score.v + " D" + score.d + " E" + score.e,
                                      { ts: "small" }) + 12, 20, T.raised, { r: 10 });
    E.gfx.text("V" + score.v + " D" + score.d + " E" + score.e, 174, 15, { ts: "small" });
    E.gfx.rect(OX - 8, OY - 8, CELL * 3 + 16, CELL * 3 + 16, T.card, { r: 14 });
    for (var k = 1; k < 3; k++) {
        E.gfx.rect(OX + k * CELL - 2, OY + 4, 4, CELL * 3 - 8, T.stroke, { r: 2 });
        E.gfx.rect(OX + 4, OY + k * CELL - 2, CELL * 3 - 8, 4, T.stroke, { r: 2 });
    }
    for (var idx = 0; idx < 9; idx++) drawMark(idx);
    // linha de vitoria riscando o trio
    if (winLine >= 0) {
        var base = winLine * 3;
        var a = cellCenter(WINS[base]);
        var b = cellCenter(WINS[base + 2]);
        E.gfx.line(a.x, a.y, b.x, b.y, T.ok, { w: 6 });
    }
}

// seletor segmentado (o papel das abas do toolkit): devolve o index tocado
function segmented(opts, sel, x, y, w, h) {
    var bw = (w - (opts.length - 1) * 4) / opts.length;
    for (var i = 0; i < opts.length; i++) {
        var r = E.gfx.button(opts[i], x + i * (bw + 4), y, bw, h,
                             { primary: i === sel, px: 12 });
        if (E.hit(r)) return i;
    }
    return -1;
}

// ------------------------------------------------------------------ fluxo ----
function finishTurn() {
    var r = checkBoard(board);
    if (!r) return false;
    winner = r.who;
    winLine = r.line;
    if (winner === 3) {
        score.e++;
        tone(330, 120);
        E.fx.flash(T.stroke, 200);
    } else if (twoPlayers || winner === 1) {
        if (!twoPlayers) score.v++;
        tone(784, 80);
        tone(1047, 110);
        // estouro nas celulas da linha vencedora
        var base = winLine * 3;
        for (var k = 0; k < 3; k++) {
            var c = cellCenter(WINS[base + k]);
            E.fx.burst(c.x, c.y, { n: 10, color: T.ok, speed: 80, life: 0.6, size: 2 });
        }
    } else {
        score.d++;
        tone(196, 200);
        E.fx.flash(T.err, 220);
    }
    saveScore();
    juiceT = 0.8;
    E.after(700, function () {
        E.goto("fim", { transition: "iris", ms: 450 });
    });
    return true;
}

function resetGame() {
    for (var c = 0; c < 9; c++) board[c] = 0;
    turn = 1;
    winner = 0;
    winLine = -1;
    if (botPend) { E.cancel(botPend); botPend = null; }
}

// agenda a jogada do bot (o "pensando" vira espera viva, nao bloqueante)
function agendaBot() {
    botPend = E.after(300, function () {
        botPend = null;
        botMove();
        if (!finishTurn()) turn = 1;
        E.redraw();
    });
}

// ------------------------------------------------------------------ cenas ---
E.run({
    menu: {
        static: true,
        update: function () {
            var m = segmented(["1 jogador", "2 jogadores"], twoPlayers ? 1 : 0, 16, 144, 208, 32);
            if (m >= 0) { twoPlayers = m === 1; E.redraw(); return; }
            if (!twoPlayers) {
                var d = segmented(diffNames, difficulty, 16, 186, 208, 32);
                if (d >= 0) { difficulty = d; E.redraw(); return; }
            }
            if (E.hit({ x: 16, y: 236, w: 208, h: 48 })) {
                resetGame();
                E.goto("jogo", { transition: "fade", ms: 300 });
            }
        },
        draw: function () {
            E.gfx.text("Jogo da Velha", W / 2, 28, { ts: "title", align: "center" });
            E.gfx.panel(16, 66, 208, 64);
            var cols = [[52, "você", score.v, T.ok], [120, "empates", score.e, T.text],
                        [188, "bot", score.d, T.err]];
            for (var i = 0; i < 3; i++) {
                E.gfx.text(cols[i][1], cols[i][0], 74, { ts: "small", align: "center",
                                                         color: T.textDim });
                E.gfx.text(String(cols[i][2]), cols[i][0], 92, { ts: "title",
                                                                 align: "center", color: cols[i][3] });
            }
            segmented(["1 jogador", "2 jogadores"], twoPlayers ? 1 : 0, 16, 144, 208, 32);
            if (!twoPlayers) segmented(diffNames, difficulty, 16, 186, 208, 32);
            else E.gfx.text("X e O no mesmo aparelho", W / 2, 194,
                            { ts: "small", align: "center", color: T.textDim });
            E.gfx.button("Jogar", 16, 236, 208, 48, { px: Math.round(20 * E.U) });
            E.gfx.text("X começa; o placar fica salvo no aparelho", W / 2, 296,
                       { ts: "small", align: "center", color: T.textDim });
        }
    },

    jogo: {
        static: true,
        enter: function () { E.redraw(); },
        // sem reset no exit: a cena fim desenha o tabuleiro final com a
        // linha vencedora (o reset acontece ao ENTRAR numa partida nova)
        update: function (dt) {
            if (juiceT > 0) { juiceT -= dt; E.redraw(); }
            var t = E.input.tap;
            if (winner || !t) return;
            if (turn === 2 && !twoPlayers) return;   // vez do bot (agendado)
            if (t.x < OX || t.x >= OX + CELL * 3 || t.y < OY || t.y >= OY + CELL * 3) return;
            var idx = Math.floor((t.y - OY) / CELL) * 3 + Math.floor((t.x - OX) / CELL);
            if (board[idx] !== 0) return;
            board[idx] = turn;
            if (!finishTurn()) {
                tone(523, 35);
                turn = turn === 1 ? 2 : 1;
                if (!twoPlayers && turn === 2) agendaBot();
            }
            E.redraw();
        },
        draw: function () {
            drawBoard();
            E.fx.draw();
        }
    },

    fim: {
        static: true,
        update: function () {
            if (E.hit({ x: 16, y: 226, w: 99, h: 44 })) {
                resetGame();
                E.goto("jogo", { transition: "wipe", ms: 300 });
            } else if (E.hit({ x: 125, y: 226, w: 99, h: 44 })) {
                E.goto("menu", { transition: "fade", ms: 300 });
            }
        },
        draw: function () {
            var msg;
            if (winner === 3) msg = "Empate!";
            else if (twoPlayers) msg = (winner === 1 ? "X" : "O") + " venceu!";
            else if (winner === 1) msg = "Você venceu!";
            else msg = "Bot venceu!";
            drawBoard();
            E.gfx.text(msg, W / 2, 42, { ts: "title", align: "center" });
            E.gfx.text("V " + score.v + "  E " + score.e + "  D " + score.d, W / 2, 62,
                       { ts: "small", align: "center", color: T.textDim });
            E.gfx.button("Jogar de novo", 16, 226, 99, 44, { px: 12 });
            E.gfx.button("Menu", 125, 226, 99, 44, { primary: false, px: 12 });
        }
    }
}, "menu");
