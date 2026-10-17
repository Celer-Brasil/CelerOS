// 2048 — deslize, junte iguais, chegue ao 2048. Porte CelerGame: cena
// static (so redesenha quando algo muda — particulas incluidas), gestos e
// tipografia do core, titulo/pausa/fim do celeros.game.ui, burst/popText/
// ring do fx no merge, recorde no NVS e transicoes entre cenas. ES5 puro
// (Duktape).

var E = require("celeros.game");       // familia CelerGame: core + fx + ui
require("celeros.game.fx");
require("celeros.game.ui");

E.init({ dir: "2048", fps: 30, save: "g2048." });
var T = E.theme, W = E.W, H = E.H;

var N = 4;
var CELL = 46, GAP = 4;
var GX = (W - (N * CELL + (N - 1) * GAP)) / 2;   // 22
var GY = 58;

// recorde: NVS do core — o valor do arquivo da 1.2 entra como migacao 1x
// (opcional: sem a perm "fs" o runtime nao registra o objeto FS)
var hi = E.save.num("hi", 0);
var FSx = typeof FS !== "undefined" ? FS : null;
if (FSx) {
    try {
        var raw = FSx.readTextFile("/local/config_2048_hi.txt");
        var old = raw ? parseInt(raw, 10) : 0;
        if (!isNaN(old) && old > hi) { hi = old; E.save.set("hi", hi); }
    } catch (e) {}
}

// -------------------------------------------------------------- audio ----
// sem musica de fundo: so efeitos. "move" e o tique da jogada valida;
// "merge" tem uma melodia pre-calculada por valor (o tom sobe com a peca,
// zero alocacao por jogada/quadro); "win"/"lose" fecham a partida.
E.audio.sfxTable.move = [180, 26];
E.audio.sfxTable.merge = [[523, 32], [784, 56]];
E.audio.sfxTable.win = [[523, 80], [659, 80], [784, 80], [1047, 200]];
E.audio.sfxTable.lose = [[330, 90], [247, 110], [165, 220]];

// 4, 8, 16, ... 8192: duas notas por valor de fusao (escala pentatonica)
var MERGE_SFX = {};
(function () {
    var notas = [392, 440, 494, 523, 587, 659, 698, 784, 880, 988, 1047, 1175];
    for (var k = 0; k < notas.length; k++) {
        MERGE_SFX[4 << k] = [[notas[k], 32],
                             [Math.round(notas[k] * 1.5), 52]];
    }
})();

function playMerge(v) {
    var m = MERGE_SFX[v];
    E.audio.sfx(m || E.audio.sfxTable.merge);
}

var board, score, won, over;
var prevBoard = null, prevScore = 0;   // 1 passo de desfazer
var merges = [];                        // merges da jogada (p/ particulas)
var novoRec = false;
var juiceT = 0;                         // >0: ha particulas vivas, repinta
var paused = false;                     // menu de pausa cobre o jogo
var ajudaDlg = null;                    // dialogo da cena de ajuda

var BTN_UNDO = { x: 12, y: 284, w: 104, h: 30 };
var BTN_NEW = { x: 124, y: 284, w: 104, h: 30 };
var BTN_CONT = { x: 68, y: 196, w: 104, h: 34 };   // "continuar" do 2048
var BTN_PAUSE = { x: W - 38, y: 8, w: 30, h: 22 }; // canto do HUD

function idx(x, y) { return y * N + x; }

function reset() {
    board = [];
    for (var i = 0; i < N * N; i++) board.push(0);
    score = 0;
    won = false;
    over = false;
    novoRec = false;
    merges.length = 0;
    juiceT = 0;
    spawn();
    spawn();
}

function emptyCells() {
    var out = [];
    for (var i = 0; i < N * N; i++) if (!board[i]) out.push(i);
    return out;
}

function spawn() {
    var e = emptyCells();
    if (!e.length) return;
    var k = e[Math.floor(Math.random() * e.length)];
    board[k] = (Math.random() < 0.9) ? 2 : 4;
}

// extrai a linha (x,y fixo, direcao) como array de valores nao nulos
function line(dir, x, y) {
    var v = [];
    for (var i = 0; i < N; i++) {
        var xx = (dir === "L") ? i : (dir === "R") ? N - 1 - i : x;
        var yy = (dir === "U") ? i : (dir === "D") ? N - 1 - i : y;
        var val = board[idx(xx, yy)];
        if (val) v.push({ x: xx, y: yy, v: val });
    }
    return v;
}

function setLine(dir, x, y, arr) {
    for (var i = 0; i < N; i++) {
        var xx = (dir === "L") ? i : (dir === "R") ? N - 1 - i : x;
        var yy = (dir === "U") ? i : (dir === "D") ? N - 1 - i : y;
        board[idx(xx, yy)] = (i < arr.length) ? arr[i] : 0;
    }
}

// move/merge em uma direcao; true se o tabuleiro mudou (merges registra
// a celula e o valor de cada fusao pro fx)
function move(dir) {
    var snapB = board.slice(), snapS = score;
    var changed = false;
    merges.length = 0;
    for (var k = 0; k < N; k++) {
        var x = (dir === "L" || dir === "R") ? 0 : k;
        var y = (dir === "U" || dir === "D") ? 0 : k;
        var vals = [];
        var ln = line(dir, x, y);
        for (var i = 0; i < ln.length; i++) vals.push(ln[i].v);
        var merged = [];
        for (var j = 0; j < vals.length; j++) {
            if (j + 1 < vals.length && vals[j] === vals[j + 1]) {
                var v2 = vals[j] * 2;
                merged.push(v2);
                score += v2;
                if (v2 === 2048) won = true;
                // a fusao aterra na (j)-esima celula ocupada da linha
                merges.push({ x: ln[j].x, y: ln[j].y, v: v2 });
                j++;
            } else merged.push(vals[j]);
        }
        var before = line(dir, x, y);
        setLine(dir, x, y, merged);
        var after = line(dir, x, y);
        if (before.length !== after.length) changed = true;
        else {
            for (var m = 0; m < before.length; m++) {
                // posicao tambem: deslizar sem fundir tambem muda o tabuleiro
                if (before[m].v !== after[m].v ||
                    before[m].x !== after[m].x ||
                    before[m].y !== after[m].y) changed = true;
            }
        }
    }
    if (changed) {
        prevBoard = snapB;
        prevScore = snapS;
    }
    return changed;
}

function undo() {
    if (!prevBoard) return;
    board = prevBoard;
    prevBoard = null;
    score = prevScore;
    over = false;
    won = false;
    E.redraw();
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

function saveHi() {
    if (score > 0 && E.save.best("hi", score)) novoRec = true;
    hi = Math.max(hi, score);
}

// -------------------------------------------------------------- desenho ----
function tileColors(v) {
    if (v <= 2)   return { bg: T.raised, fg: T.text };
    if (v <= 4)   return { bg: T.stroke, fg: T.text };
    if (v <= 8)   return { bg: T.accentD, fg: T.text };
    if (v <= 16)  return { bg: T.accent, fg: T.onAccent };
    if (v <= 32)  return { bg: T.warn,   fg: T.onAccent };
    if (v <= 64)  return { bg: T.err,    fg: T.onAccent };
    return { bg: T.ok, fg: T.onAccent };              // 128+
}

// cor do tabuleiro no fim de jogo: puxada para o fundo, mas visivel
function dimColor(c) {
    return E.caps.wide ? System.mixColor(c, T.bg, 50) : c;
}

function drawBoard(dim) {
    E.gfx.rect(GX - 6, GY - 6, N * CELL + (N - 1) * GAP + 12,
               N * CELL + (N - 1) * GAP + 12, dim ? dimColor(T.card) : T.card,
               { r: 10 });
    for (var y = 0; y < N; y++) {
        for (var x = 0; x < N; x++) {
            var v = board[idx(x, y)];
            var px = GX + x * (CELL + GAP), py = GY + y * (CELL + GAP);
            if (!v) {
                E.gfx.rect(px, py, CELL, CELL, dim ? dimColor(T.bg) : T.bg,
                           { r: 8 });
                continue;
            }
            var c = tileColors(v);
            E.gfx.rect(px, py, CELL, CELL, dim ? dimColor(c.bg) : c.bg, { r: 8 });
            var papel = v < 100 ? "big" : (v < 1000 ? "body" : "small");
            E.gfx.text(String(v), px + CELL / 2, py + CELL / 2,
                       { ts: papel, align: "center", valign: "middle",
                         color: dim ? dimColor(c.fg) : c.fg });
        }
    }
}

// o placar cede o canto direito ao botao de pausa (sem encostar)
function drawHeader() {
    E.gfx.text("2048", 12, 10, { ts: "title" });
    E.gfx.text("PONTOS " + score, W - 46, 8,
               { ts: "small", align: "right",
                 color: novoRec ? T.ok : T.text });
    E.gfx.text("Rec " + hi, W - 46, 24,
               { ts: "small", align: "right", color: T.textDim });
}

// ------------------------------------------------------------------ cenas ---
E.run({
    titulo: {
        static: true,
        update: function () {
            // o gesto do jogo tambem comeca: deslizar e o comando da casa
            if (E.input.swipe) E.goto("jogo", { transition: "fade" });
        },
        draw: function () {
            E.gfx.rect(0, 0, W, H, T.bg, { screen: true });
            var act = E.ui.title({ game: "2048", subtitle: "deslize e junte",
                                   best: hi, extra: "Como jogar" });
            if (act === "start") E.goto("jogo", { transition: "fade" });
            else if (act === "extra") E.goto("ajuda", { transition: "fade" });
        }
    },

    ajuda: {
        // comum (nao static): o dialogo revela o texto no draw
        enter: function () {
            ajudaDlg = E.ui.dialog(
                "Deslize para mover as peças. Iguais se juntam e dobram de valor. " +
                "Chegue à peça 2048. Dica: o botão Desfazer volta a última jogada " +
                "(uma vez por partida).",
                { name: "Como jogar", speed: 40 });
        },
        draw: function () {
            E.gfx.rect(0, 0, W, H, T.bg, { screen: true });
            var aberto = ajudaDlg.draw(20, 72, W - 40);
            E.gfx.text("toque para continuar", W / 2, 210,
                       { ts: "small", align: "center", color: T.textDim });
            if (!aberto) E.goto("titulo", { transition: "fade" });
        }
    },

    jogo: {
        static: true,   // parado nao repinta nada; juice pinta so o que vive
        enter: function () { paused = false; reset(); },
        update: function (dt) {
            if (paused) return;   // congelado: o menu vive no draw
            if (juiceT > 0) { juiceT -= dt; E.redraw(); }   // particulas
            if (E.hit(BTN_PAUSE)) { paused = true; E.redraw(); return; }
            if (E.hit(BTN_UNDO)) { undo(); return; }
            if (E.hit(BTN_NEW)) { saveHi(); reset(); E.redraw(); return; }
            if (won && E.hit(BTN_CONT)) { won = false; E.redraw(); return; }
            var sw = E.input.swipe;
            if (!sw) return;
            var dir = sw.dir === "left" ? "L" : sw.dir === "right" ? "R" :
                      sw.dir === "up" ? "U" : "D";
            var wasWon = won;
            if (!move(dir)) return;
            spawn();
            saveHi();
            // juice: cada fusao estoura na celula com a cor do tile novo;
            // >= 64 ganha tambem a onda de choque do fx
            var bestMerge = 0;
            for (var m = 0; m < merges.length; m++) {
                var mg = merges[m];
                var cx = GX + mg.x * (CELL + GAP) + CELL / 2;
                var cy = GY + mg.y * (CELL + GAP) + CELL / 2;
                E.fx.burst(cx, cy, { n: 10, color: tileColors(mg.v).bg,
                                     speed: 70, life: 0.45, size: 2 });
                E.fx.popText(cx, cy - 8, "+" + mg.v, { color: T.ok, life: 0.7 });
                if (mg.v >= 64) {
                    E.fx.ring(cx, cy, { color: tileColors(mg.v).bg, r0: 8,
                                        speed: 180, life: 0.4 });
                }
                if (mg.v > bestMerge) bestMerge = mg.v;
            }
            if (merges.length) juiceT = 0.8;
            E.redraw();
            if (won && !wasWon) {
                // chegou no 2048: flash verde da borda + fanfarra
                E.audio.sfx("win");
                E.fx.flash(T.ok, 300);
            } else if (bestMerge) playMerge(bestMerge);
            else E.audio.sfx("move");
            if (!canMove()) {
                saveHi();
                E.audio.sfx("lose");
                E.goto("fim", { transition: "iris", ms: 450 });
            }
        },
        draw: function () {
            // fundo inteiro: veu da pausa/transicao/overlay nao deixa resto
            E.gfx.rect(0, 0, W, H, T.bg, { screen: true });
            drawHeader();
            drawBoard();
            E.gfx.text("deslize para mover", W / 2, 268,
                       { ts: "small", align: "center", color: T.textDim });
            E.gfx.button("Desfazer", BTN_UNDO.x, BTN_UNDO.y, BTN_UNDO.w, BTN_UNDO.h,
                         { primary: false });
            E.gfx.button("Novo jogo", BTN_NEW.x, BTN_NEW.y, BTN_NEW.w, BTN_NEW.h,
                         { primary: false });
            E.gfx.button("II", BTN_PAUSE.x, BTN_PAUSE.y, BTN_PAUSE.w, BTN_PAUSE.h,
                         { primary: false, px: 16 });
            if (won) {
                // veu do "chegou ao 2048" por cima do tabuleiro parado
                var dim = E.caps.wide ? System.mixColor(T.bg, 0x0000, 62) : T.bg;
                E.gfx.rect(0, 0, W, H, dim, { screen: true });
                E.gfx.text("Você chegou ao 2048!", W / 2, 150,
                           { ts: "big", align: "center", color: T.ok,
                             fit: W - 24 });
                E.gfx.button("Continuar", BTN_CONT.x, BTN_CONT.y, BTN_CONT.w,
                             BTN_CONT.h, { primary: false });
            }
            E.fx.draw();
            if (paused) {
                var act = E.ui.pause({ title: "PAUSA",
                                       labels: ["Continuar", "Recomecar", "Sair"] });
                if (act === "resume") { paused = false; E.redraw(); }
                else if (act === "restart") {
                    paused = false; saveHi(); reset(); E.redraw();
                } else if (act === "quit") {
                    paused = false;
                    E.goto("titulo", { transition: "fade" });
                }
            }
        }
    },

    fim: {
        static: true,
        draw: function () {
            E.gfx.rect(0, 0, W, H, T.bg, { screen: true });
            drawBoard(true);             // tabuleiro visivel, cores atenuadas
            drawHeader();                // HUD por cima, nitido
            // duas linhas: "Sem movimentos!" inteiro nao cabe no title
            E.gfx.text("Sem", W / 2, 84,
                       { ts: "title", align: "center", color: T.err, bg: T.card });
            E.gfx.text("movimentos!", W / 2, 108,
                       { ts: "title", align: "center", color: T.err, bg: T.card });
            E.gfx.text("Pontos: " + score, W / 2, 136,
                       { ts: "big", align: "center", bg: T.card });
            if (novoRec) E.gfx.text("NOVO RECORDE!", W / 2, 160,
                                    { ts: "label", align: "center", color: T.ok,
                                      bg: T.card });
            // menu na faixa de baixo: o tabuleiro fica livre atras
            var act = E.ui.menu(["Jogar de novo", "Menu"],
                                { y: H - 58, row: 30 });
            if (act === "Jogar de novo") {
                E.goto("jogo", { transition: "wipe", ms: 300 });
            } else if (act === "Menu") {
                E.goto("titulo", { transition: "fade" });
            }
        }
    }
}, "titulo");
