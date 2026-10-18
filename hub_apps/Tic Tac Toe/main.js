// CelerOS Tic Tac Toe — jogo da velha no tema do OS. Porte CelerGame com a
// familia completa: core + fx + ui + fsm + events. O fluxo titulo -> jogo ->
// fim vive num E.fsm (enter/update/draw/after), o turno jogador/bot em outro,
// a pausa empilha por cima (push/pop) e o tabuleiro segue visivel. O bot joga
// pelo E.after (o loop nao bloqueia), o placar vive no NVS e o score.txt da
// versao anterior entra como migracao opcional. Sons e efeitos ouvem os
// eventos mark/win/draw/score (E.events), e um recorde novo vira toast.

var E = require("celeros.game");       // familia CelerGame: core
require("celeros.game.fx");            // decoradores: particulas e juice
require("celeros.game.ui");            // telas de titulo/menu/pausa/fim + toast
require("celeros.game.fsm");           // fluxo titulo -> jogo -> fim e turno
require("celeros.game.events");        // barramento mark/win/draw/score

E.init({ dir: "Tic Tac Toe", fps: 30, save: "velha." });
var T = E.theme, W = E.W, H = E.H;

// placar: NVS do core — o score.txt da versao anterior entra como migracao
// opcional: sem a perm "fs" o runtime nao registra o objeto FS (a migracao
// so faria sentido num aparelho que ja teve a versao antiga — e esse tem a
// concessao de quando ela pediu)
var score = { v: E.save.num("v", 0), d: E.save.num("d", 0), e: E.save.num("e", 0) };
var FSx = typeof FS !== "undefined" ? FS : null;
if (FSx) {
    try {
        var raw = FSx.readTextFile((FSx.appData ? FSx.appData() : "/local/") + "score.txt");
        var p = raw ? raw.split(",") : [];
        if (p.length === 3) {
            score.v = Math.max(score.v, parseInt(p[0], 10) || 0);
            score.d = Math.max(score.d, parseInt(p[1], 10) || 0);
            score.e = Math.max(score.e, parseInt(p[2], 10) || 0);
            E.save.set("v", score.v); E.save.set("d", score.d); E.save.set("e", score.e);
        }
    } catch (e) {}
}
function saveScore() {
    E.save.set("v", score.v); E.save.set("d", score.d); E.save.set("e", score.e);
}

// Som: a sfxTable do core escolhe System.sfx (misturado, API 32) ou
// playTone conforme o firmware — nada de bloquear o loop aqui.
E.audio.sfxTable.mark = [523, 40];
E.audio.sfxTable.win = [[523, 90], [659, 90], [784, 160]];
E.audio.sfxTable.lose = [[300, 90], [220, 90], [140, 220]];
E.audio.sfxTable.draw = [330, 140];

var board = [0, 0, 0, 0, 0, 0, 0, 0, 0];   // 0 vazio | 1 X | 2 O
var turn = 1;
var winner = 0;                             // 0 ninguem | 1 X | 2 O | 3 empate
var winLine = -1;                           // indice do trio vencedor
var twoPlayers = false;
var difficulty = 1;                         // 0 facil | 1 medio | 2 impossivel
var diffNames = ["Fácil", "Médio", "Impossível"];
var botPend = null;                         // timer do "bot pensando"
var juiceT = 0;                             // particulas vivas: repinta
var paused = false;                         // estado de pausa (veu por cima)

// tabuleiro um pouco menor que a versao anterior: sobram ~70 px embaixo
// para o botao de pausa (jogo) e para o menu de fim (tabuleiro visivel)
var CELL = 54, OX = 39, OY = 78;
var BTN_PAUSE = { x: 16, y: 262, w: 208, h: 38 };

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

// devolve a casa escolhida (o evento mark leva o indice)
function botMove() {
    var empty = [];
    for (var e = 0; e < 9; e++) if (board[e] === 0) empty.push(e);

    var rnd = false;
    if (difficulty === 0) rnd = true;
    else if (difficulty === 1) rnd = Math.random() > 0.6;
    var choice = -1;

    if (empty.length === 0) return choice;
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
    return choice;
}

// ---------------------------------------------------------------- desenho ----
function cellCenter(idx) {
    return {
        x: OX + (idx % 3) * CELL + CELL / 2,
        y: OY + Math.floor(idx / 3) * CELL + CELL / 2
    };
}

function lineCenter(line) {
    var base = line * 3;
    var a = cellCenter(WINS[base]);
    var b = cellCenter(WINS[base + 2]);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function boardCenter() {
    return { x: OX + CELL * 1.5, y: OY + CELL * 1.5 };
}

function drawMark(idx) {
    var c = cellCenter(idx);
    var v = board[idx];
    if (v === 1) {
        var r = 13;
        E.gfx.line(c.x - r, c.y - r, c.x + r, c.y + r, T.accent, { w: 4 });
        E.gfx.line(c.x - r, c.y + r, c.x + r, c.y - r, T.accent, { w: 4 });
    } else if (v === 2) {
        E.gfx.circle(c.x, c.y, 16, T.warn, { smooth: true });
        E.gfx.circle(c.x, c.y, 12, T.card, { smooth: true });
    }
}

function drawHeader() {
    if (winner) {
        var msg, col;
        if (winner === 3) { msg = "EMPATE"; col = T.textDim; }
        else if (twoPlayers) { msg = (winner === 1 ? "X" : "O") + " VENCEU"; col = T.ok; }
        else if (winner === 1) { msg = "VITÓRIA"; col = T.ok; }
        else { msg = "DERROTA"; col = T.err; }
        E.gfx.text(msg, W / 2, 8, { ts: "title", align: "center", color: col });
        E.gfx.text("V " + score.v + "  E " + score.e + "  D " + score.d, W / 2, 42,
                   { ts: "small", align: "center", color: T.textDim });
        return;
    }
    var vez = twoPlayers ? ("Vez do " + (turn === 1 ? "X" : "O"))
                         : (turn === 1 ? "Sua vez (X)" : "Bot pensando...");
    E.gfx.text(vez, 12, 12, { ts: "body", color: turn === 1 ? T.accent : T.warn });
    var txt = "V" + score.v + " D" + score.d + " E" + score.e;
    var tw = E.gfx.measure(txt, { ts: "small" });
    E.gfx.rect(W - tw - 20, 10, tw + 12, 22, T.raised, { r: 10 });
    E.gfx.text(txt, W - 14, 13, { ts: "small", align: "right" });
}

function drawBoard() {
    drawHeader();
    E.gfx.rect(OX - 8, OY - 8, CELL * 3 + 16, CELL * 3 + 16, T.card, { r: 14 });
    for (var k = 1; k < 3; k++) {
        E.gfx.rect(OX + k * CELL - 2, OY + 4, 4, CELL * 3 - 8, T.stroke, { r: 2 });
        E.gfx.rect(OX + 4, OY + k * CELL - 2, CELL * 3 - 8, 4, T.stroke, { r: 2 });
    }
    for (var idx = 0; idx < 9; idx++) drawMark(idx);
    // linha de vitoria riscando o trio (vermelha quando o bot vence)
    if (winLine >= 0) {
        var base = winLine * 3;
        var a = cellCenter(WINS[base]);
        var b = cellCenter(WINS[base + 2]);
        E.gfx.line(a.x, a.y, b.x, b.y,
                   (winner === 2 && !twoPlayers) ? T.err : T.ok, { w: 6 });
    }
}

// tela de jogo inteira (jogo, pausa e anuncio compartilham): o tabuleiro
// fica no vidro por baixo do veu e durante o fim
function drawGame() {
    E.gfx.rect(0, 0, W, H, T.bg, { screen: true });
    drawBoard();
    if (!winner) {
        E.gfx.button("Pausa", BTN_PAUSE.x, BTN_PAUSE.y, BTN_PAUSE.w,
                     BTN_PAUSE.h, { primary: false });
    }
    E.fx.draw();
}

// ---------------------------------------------------------------- eventos ---
// O jogo so anuncia o que aconteceu; som e efeitos moram nos ouvintes.
E.on("mark", function () {
    E.audio.sfx("mark");
});

E.on("win", function (p) {
    var c;
    if (p.two || p.who === 1) {
        E.audio.sfx("win");
        E.fx.flash(T.ok, 260);
        c = lineCenter(p.line);
        E.fx.ring(c.x, c.y, { r0: 14, speed: 210, color: T.ok, life: 0.6 });
        E.fx.popText(c.x, c.y, p.two ? ((p.who === 1 ? "X" : "O") + " VENCEU") : "VITÓRIA",
                     { color: T.ok, life: 0.9, ts: "title" });
        // estouro nas celulas da linha vencedora
        var base = p.line * 3;
        for (var k = 0; k < 3; k++) {
            var cc = cellCenter(WINS[base + k]);
            E.fx.burst(cc.x, cc.y, { n: 10, color: T.ok, speed: 80, life: 0.6, size: 2 });
        }
    } else {
        E.audio.sfx("lose");
        E.fx.flash(T.err, 260);
        c = lineCenter(p.line);
        E.fx.ring(c.x, c.y, { r0: 14, speed: 210, color: T.err, life: 0.6 });
        E.fx.popText(c.x, c.y, "DERROTA", { color: T.err, life: 0.9, ts: "title" });
    }
});

E.on("draw", function () {
    E.audio.sfx("draw");
    E.fx.flash(T.stroke, 220);
    var c = boardCenter();
    E.fx.ring(c.x, c.y, { r0: 12, speed: 170, color: T.textDim, life: 0.6 });
    E.fx.popText(c.x, c.y, "EMPATE", { color: T.textDim, life: 0.9, ts: "title" });
});

// persistencia e comemoracao saem do fluxo do jogo
E.on("score", function (s) {
    saveScore();
    if (s.novo) E.ui.toast("NOVO RECORDE!", { ms: 1600 });
});

// ------------------------------------------------------------------ fluxo ----
function finishTurn() {
    var r = checkBoard(board);
    if (!r) return false;
    winner = r.who;
    winLine = r.line;
    if (winner === 3) {
        score.e++;
        E.emit("draw");
        E.emit("score", { v: score.v, d: score.d, e: score.e, novo: false, kind: "draw" });
    } else if (twoPlayers || winner === 1) {
        var antes = score.v;
        if (!twoPlayers) score.v++;
        E.emit("win", { who: winner, line: winLine, two: twoPlayers });
        E.emit("score", { v: score.v, d: score.d, e: score.e,
                          novo: !twoPlayers && score.v > antes, kind: "win" });
    } else {
        score.d++;
        E.emit("win", { who: winner, line: winLine, two: false });
        E.emit("score", { v: score.v, d: score.d, e: score.e, novo: false, kind: "lose" });
    }
    juiceT = 1.2;
    // o anuncio (0.9 s) e o "after" do estado; o tabuleiro e os efeitos
    // continuam no vidro ate a tela de fim
    if (flow) flow.go("anuncio");
    return true;
}

function resetGame() {
    for (var c = 0; c < 9; c++) board[c] = 0;
    turn = 1;
    winner = 0;
    winLine = -1;
    paused = false;
    if (botPend) { E.cancel(botPend); botPend = null; }
    turnFsm.go("jogador", null, true);
}

// agenda a jogada do bot (o "pensando" vira espera viva, nao bloqueante)
function agendaBot() {
    if (botPend) return;
    botPend = E.after(300, function () {
        botPend = null;
        if (paused || winner || !flow.is("jogo")) return;   // retoma ao continuar
        var idx = botMove();
        if (!finishTurn()) {
            E.emit("mark", idx);
            turn = 1;
        }
        turnFsm.go("jogador");
        E.redraw();
    });
}

function pauseGame() {
    paused = true;
    if (botPend) { E.cancel(botPend); botPend = null; }
    E.audio.sfx("ui");
    E.redraw();
}

function resumeGame() {
    paused = false;
    if (!winner && !twoPlayers && turn === 2) turnFsm.go("bot", null, true);
    E.redraw();
}

// turno de 1 jogador: "jogador" espera o toque, "bot" agenda o E.after.
// Em 2 jogadores o estado fica em "jogador" (os dois se revezam no toque).
var turnFsm = E.fsm(null, {
    jogador: {},
    bot: {
        enter: function () { agendaBot(); },
        exit: function () {
            if (botPend) { E.cancel(botPend); botPend = null; }
        }
    }
}, "jogador");

// ------------------------------------------------------------------ cenas ---
// Uma cena estatica so: quem manda no desenho e o E.fsm do fluxo.
// "anuncio" usa o after do fsm (0.9 s) e mantem o tabuleiro visivel.
var flow = E.fsm(null, {
    titulo: {
        enter: function () { E.redraw(); },
        draw: function (m) {
            E.gfx.rect(0, 0, W, H, T.bg, { screen: true });
            var act = E.ui.title({
                game: "TIC TAC TOE",
                subtitle: "voce contra a maquina ou um amigo",
                best: score.v,
                extra: "Como jogar"
            });
            if (act === "start") {
                E.audio.sfx("ui");
                m.go("menu");
            } else if (act === "extra") {
                E.audio.sfx("ui");
                m.go("ajuda");
            }
        }
    },

    // texto datilografado: a revelacao avanca no draw, entao o update pede
    // redraw enquanto o dialogo nao termina (cena estatica)
    ajuda: {
        enter: function () {
            this.dlg = E.ui.dialog(
                "Cada jogador marca uma casa vazia; X comeca. Alinhe tres na " +
                "horizontal, vertical ou diagonal para vencer. Em 1 jogador a " +
                "dificuldade escolhe o bot: Facil sorteia, Medio as vezes erra " +
                "e Impossivel nunca perde. Em 2 jogadores, X e O se revezam no " +
                "mesmo aparelho. O placar fica salvo no aparelho.",
                { name: "COMO JOGAR", speed: 55 });
        },
        update: function () {
            if (this.dlg && (!this.dlg.done || E.input.tap)) E.redraw();
        },
        draw: function (m) {
            E.gfx.rect(0, 0, W, H, T.bg, { screen: true });
            if (!this.dlg || !this.dlg.draw(16, 74, W - 32)) {
                E.audio.sfx("ui");
                m.go("titulo");
            }
        }
    },

    menu: {
        draw: function (m) {
            E.gfx.rect(0, 0, W, H, T.bg, { screen: true });
            E.gfx.text("JOGO DA VELHA", W / 2, 18, { ts: "title", align: "center" });
            E.gfx.panel(16, 54, 208, 52);
            var cols = [[52, "voce", score.v, T.ok], [120, "empates", score.e, T.text],
                        [188, "bot", score.d, T.err]];
            for (var i = 0; i < 3; i++) {
                E.gfx.text(cols[i][1], cols[i][0], 62,
                           { ts: "tiny", align: "center", color: T.textDim });
                E.gfx.text(String(cols[i][2]), cols[i][0], 76,
                           { ts: "label", align: "center", color: cols[i][3] });
            }
            var modo = twoPlayers ? "2 jogadores"
                                  : ("1 jogador - " + diffNames[difficulty]);
            E.gfx.text(modo, W / 2, 112, { ts: "small", align: "center", color: T.textDim });
            var pick = E.ui.menu([
                { label: "1 jogador", value: 0 },
                { label: "2 jogadores", value: 1 },
                { label: "Dificuldade: " + diffNames[difficulty], value: 2,
                  disabled: twoPlayers },
                { label: "Jogar", value: 3 }
            ], { x: 16, y: 130, w: 208, row: 36 });
            if (pick === 0) { twoPlayers = false; E.audio.sfx("ui"); E.redraw(); }
            else if (pick === 1) { twoPlayers = true; E.audio.sfx("ui"); E.redraw(); }
            else if (pick === 2) {
                difficulty = (difficulty + 1) % 3;
                E.audio.sfx("ui");
                E.redraw();
            } else if (pick === 3) {
                resetGame();
                E.audio.sfx("ok");
                m.go("jogo");
            }
            E.gfx.text("toque na dificuldade para trocar", W / 2, 290,
                       { ts: "tiny", align: "center", color: T.textDim });
        }
    },

    jogo: {
        enter: function () { paused = false; E.redraw(); },
        // volta da pausa: o turno do bot e reagendado se era a vez dele
        resume: function () { resumeGame(); },
        // sem reset no exit: o estado fim desenha o tabuleiro final com a
        // linha vencedora (o reset acontece ao ENTRAR numa partida nova);
        // o timer do bot morre para nao jogar no estado seguinte
        exit: function () {
            if (botPend) { E.cancel(botPend); botPend = null; }
        },
        update: function (m, dt) {
            if (!paused && juiceT > 0) { juiceT -= dt; E.redraw(); }
            var t = E.input.tap;
            if (!winner && t && E.hit(BTN_PAUSE)) {
                m.push("pausa");
                return;
            }
            if (winner || !t) return;
            if (turn === 2 && !twoPlayers) return;   // vez do bot (agendado)
            if (t.x < OX || t.x >= OX + CELL * 3 || t.y < OY || t.y >= OY + CELL * 3) return;
            var idx = Math.floor((t.y - OY) / CELL) * 3 + Math.floor((t.x - OX) / CELL);
            if (board[idx] !== 0) return;
            board[idx] = turn;
            if (!finishTurn()) {
                E.emit("mark", idx);
                turn = turn === 1 ? 2 : 1;
                if (!twoPlayers && turn === 2) turnFsm.go("bot");
            }
            E.redraw();
        },
        draw: function () { drawGame(); }
    },

    // tabuleiro congelado + veu; o E.ui.pause e imediato-mode por cima
    pausa: {
        enter: function () { pauseGame(); },
        draw: function (m) {
            drawGame();
            var act = E.ui.pause({});
            if (act === "resume") m.pop();
            else if (act === "restart") {
                resetGame();
                m.pop();
            } else if (act === "quit") {
                E.audio.sfx("back");
                m.pop();
                m.go("menu");
            }
        }
    },

    // anuncio do resultado: particulas vivas e tabuleiro no vidro; o fsm
    // sai sozinho para o fim depois de 0.9 s
    anuncio: {
        enter: function () { E.redraw(); },
        update: function (m, dt) {
            if (juiceT > 0) juiceT -= dt;
            E.redraw();                       // efeitos avancam no draw
        },
        draw: function () { drawGame(); },
        after: [0.9, "fim"]
    },

    fim: {
        draw: function (m) {
            E.gfx.rect(0, 0, W, H, T.bg, { screen: true });
            drawBoard();                      // tabuleiro final continua visivel
            var pick = E.ui.menu(["De novo", "Menu"], { y: 252, row: 34 });
            if (pick === "De novo") {
                resetGame();
                E.audio.sfx("ui");
                m.go("jogo");
            } else if (pick === "Menu") {
                E.audio.sfx("ui");
                m.go("menu");
            }
        }
    }
}, "titulo", {
    onChange: function () { E.redraw(); }
});

// cena unica: o fsm do fluxo e quem recebe update/draw
E.run({
    velha: {
        static: true,
        update: function (dt) { flow.update(dt); },
        draw: function () { flow.draw(); }
    }
}, "velha");
