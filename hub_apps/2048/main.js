// 2048 — deslize, junte iguais, chegue ao 2048. Porte CelerGame: cena
// static (so redesenha quando algo muda — particulas e tweens incluidos),
// gestos e tipografia do core, titulo/pausa/fim do celeros.game.ui,
// burst/popText/ring do fx no merge, recorde no NVS e transicoes entre
// cenas. A jogada e desacoplada por eventos (celeros.game.events): o move
// emite "merge", o save emite "record" e o desfazer emite "undo"; os
// ouvintes cuidam do fx, do som e dos toasts. ES5 puro (Duktape).

var E = require("celeros.game");       // familia CelerGame: core + fx + ui
require("celeros.game.fx");
require("celeros.game.ui");
require("celeros.game.events");

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
var novoRec = false;
var juiceT = 0;                         // >0: ha particulas vivas, repinta
var paused = false;                     // menu de pausa cobre o jogo
var ajudaDlg = null;                    // dialogo da cena de ajuda

// animacao da jogada: os tiles em voo tem x/y (pixels) e s (escala do
// estouro da fusao). A cena segue static — o update repinta enquanto
// houver tween (anims) ou particula (juiceT) vivos.
var anims = [];                         // tiles deslizando / pops vivos
var animGen = 0;                        // reset invalida onDone pendente
var hold = [];                          // celulas com valor final escondido
var ANIM_MS = 110;                      // deslize (curto: ~3 quadros a 30 fps)
var POP_MS = 130;                       // estouro da peca fundida / nova

var BTN_UNDO = { x: 12, y: 284, w: 104, h: 30 };
var BTN_NEW = { x: 124, y: 284, w: 104, h: 30 };
var BTN_CONT = { x: 68, y: 196, w: 104, h: 34 };   // "continuar" do 2048
var BTN_PAUSE = { x: W - 38, y: 8, w: 30, h: 22 }; // canto do HUD

function idx(x, y) { return y * N + x; }
function cellCX(x) { return GX + x * (CELL + GAP) + CELL / 2; }
function cellCY(y) { return GY + y * (CELL + GAP) + CELL / 2; }
// celula de destino do o-esimo tile da linha k (mesma ordem de line/setLine)
function lineCell(dir, k, o) {
    return {
        x: (dir === "L") ? o : (dir === "R") ? N - 1 - o : k,
        y: (dir === "U") ? o : (dir === "D") ? N - 1 - o : k
    };
}

// ------------------------------------------------------------- eventos ----
// O update so cuida do fluxo (swipe -> move -> spawn -> fim). O "gosto" da
// jogada mora nos ouvintes: fx/som do merge, som da jogada, toast de
// recorde e do desfazer, e a saida para a cena de fim.
var bestMerge = 0;                      // maior fusao da jogada (som)

E.on("merge", function (v, x, y) {
    var cx = cellCX(x), cy = cellCY(y);
    E.fx.burst(cx, cy, { n: 10, color: tileColors(v).bg,
                         speed: 70, life: 0.45, size: 2 });
    E.fx.popText(cx, cy - 8, "+" + v, { color: T.ok, life: 0.7 });
    if (v >= 64) {
        E.fx.ring(cx, cy, { color: tileColors(v).bg, r0: 8,
                            speed: 180, life: 0.4 });
    }
    if (v > bestMerge) bestMerge = v;
    juiceT = 0.8;
});

// fim de uma jogada valida: a maior fusao escolhe o tom; sem fusao, o tique
E.on("played", function (justWon) {
    if (justWon) {
        E.audio.sfx("win");
        E.fx.flash(T.ok, 300);
    } else if (bestMerge) playMerge(bestMerge);
    else E.audio.sfx("move");
    bestMerge = 0;
});

E.on("record", function () {
    novoRec = true;
    E.ui.toast("NOVO RECORDE!", { ms: 1600 });
});

E.on("undo", function () {
    E.ui.toast("Jogada desfeita", { ms: 1200 });
});

E.on("gameover", function () {
    saveHi();
    E.audio.sfx("lose");
    E.goto("fim", { transition: "iris", ms: 450 });
});

// ------------------------------------------------------------ animacao ----
// Mata os tweens em voo (reset/novo jogo). animGen invalida o onDone que
// ainda ia criar o pop de uma fusao.
function clearAnims() {
    animGen++;
    for (var i = 0; i < anims.length; i++) {
        anims[i].dead = true;
        E.killTweensOf(anims[i]);
    }
    anims.length = 0;
}

// tile que desliza de (sx,sy) ate (dx,dy); popV > 0 = segundo tile de uma
// fusao: quando chega, estoura o tile fundido na celula de destino
function slideTile(sx, sy, dx, dy, v, g, popV) {
    var a = { x: cellCX(sx), y: cellCY(sy), s: 1, v: v,
              ix: idx(dx, dy), dead: false };
    anims.push(a);
    E.tween(a, { x: cellCX(dx), y: cellCY(dy) }, ANIM_MS, {
        ease: E.m.outCubic,
        onDone: function () {
            a.dead = true;
            if (popV && g === animGen) popTile(dx, dy, popV);
        }
    });
}

// estouro: a peca fundida (ou a que acabou de nascer) aparece pequena e
// cresce com um leve overshoot
function popTile(x, y, v) {
    var a = { x: cellCX(x), y: cellCY(y), s: 0.55, v: v,
              ix: idx(x, y), dead: false };
    anims.push(a);
    E.tween(a, { s: 1 }, POP_MS, {
        ease: E.m.outBack,
        onDone: function () { a.dead = true; }
    });
}

// tira os mortos e devolve quantos continuam vivos (repintar se > 0)
function pruneAnims() {
    var n = 0;
    for (var i = anims.length - 1; i >= 0; i--) {
        if (anims[i].dead) anims.splice(i, 1);
        else n++;
    }
    return n;
}

function reset() {
    clearAnims();
    board = [];
    for (var i = 0; i < N * N; i++) board.push(0);
    score = 0;
    won = false;
    over = false;
    novoRec = false;
    juiceT = 0;
    bestMerge = 0;
    spawn();
    spawn();
}

function emptyCells() {
    var out = [];
    for (var i = 0; i < N * N; i++) if (!board[i]) out.push(i);
    return out;
}

// nasce 2/4 numa celula vazia; anim = pop curto (a peca "cai" na jogada)
function spawn(anim) {
    var e = emptyCells();
    if (!e.length) return -1;
    var k = e[Math.floor(Math.random() * e.length)];
    board[k] = (Math.random() < 0.9) ? 2 : 4;
    if (anim) popTile(k % N, Math.floor(k / N), board[k]);
    return k;
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

// move/merge em uma direcao; true se o tabuleiro mudou. Emite "merge"
// (valor + celula de destino) e agenda o deslize/estouro dos tiles.
function move(dir) {
    // jogada nova durante a animacao anterior: descarta o voo velho (o
    // tabuleiro ja esta no estado final dele) para nao desenhar pecas
    // sobre celulas que a jogada nova acabou de mudar
    clearAnims();
    var snapB = board.slice(), snapS = score;
    var changed = false;
    var gen = animGen;
    for (var k = 0; k < N; k++) {
        var x = (dir === "L" || dir === "R") ? 0 : k;
        var y = (dir === "U" || dir === "D") ? 0 : k;
        var ln = line(dir, x, y);
        var merged = [];
        var o = 0;                          // indice de saida na linha
        for (var j = 0; j < ln.length; j++) {
            var dst = lineCell(dir, k, o);
            if (j + 1 < ln.length && ln[j].v === ln[j + 1].v) {
                var v2 = ln[j].v * 2;
                merged.push(v2);
                score += v2;
                if (v2 === 2048) won = true;
                // os dois tiles deslizam ate o destino; o segundo estoura o
                // valor fundido quando chega
                slideTile(ln[j].x, ln[j].y, dst.x, dst.y, ln[j].v, gen, 0);
                slideTile(ln[j + 1].x, ln[j + 1].y, dst.x, dst.y,
                          ln[j + 1].v, gen, v2);
                E.emit("merge", v2, dst.x, dst.y);
                j++;
            } else {
                merged.push(ln[j].v);
                if (ln[j].x !== dst.x || ln[j].y !== dst.y)
                    slideTile(ln[j].x, ln[j].y, dst.x, dst.y, ln[j].v, gen, 0);
            }
            o++;
        }
        setLine(dir, x, y, merged);
        if (ln.length !== merged.length) changed = true;
        else {
            for (var m = 0; m < ln.length; m++) {
                // posicao tambem: deslizar sem fundir tambem muda o tabuleiro
                var dc = lineCell(dir, k, m);
                if (ln[m].v !== merged[m] ||
                    ln[m].x !== dc.x || ln[m].y !== dc.y) changed = true;
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
    clearAnims();
    board = prevBoard;
    prevBoard = null;
    score = prevScore;
    over = false;
    won = false;
    E.emit("undo");
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
    var novo = score > 0 && E.save.best("hi", score);
    hi = Math.max(hi, score);
    // 1 toast por partida: o recorde pode subir a cada jogada e o aviso
    // ficaria piscando para sempre
    if (novo && !novoRec) E.emit("record", hi);
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

// tile (retangulo arredondado + valor) com lado size e canto em px/py
function drawTile(px, py, size, v, dim) {
    var c = tileColors(v);
    E.gfx.rect(px, py, size, size, dim ? dimColor(c.bg) : c.bg, { r: 8 });
    var papel = v < 100 ? "big" : (v < 1000 ? "body" : "small");
    E.gfx.text(String(v), px + size / 2, py + size / 2,
               { ts: papel, align: "center", valign: "middle",
                 color: dim ? dimColor(c.fg) : c.fg });
}

function drawBoard(dim) {
    E.gfx.rect(GX - 6, GY - 6, N * CELL + (N - 1) * GAP + 12,
               N * CELL + (N - 1) * GAP + 12, dim ? dimColor(T.card) : T.card,
               { r: 10 });
    // celula de destino de um tile em voo/pop: o valor final fica escondido
    // (o tile animado e desenhado por cima no fim)
    var i;
    for (i = 0; i < N * N; i++) hold[i] = false;
    for (i = 0; i < anims.length; i++) {
        if (!anims[i].dead) hold[anims[i].ix] = true;
    }
    for (var y = 0; y < N; y++) {
        for (var x = 0; x < N; x++) {
            var v = board[idx(x, y)];
            var px = GX + x * (CELL + GAP), py = GY + y * (CELL + GAP);
            if (!v) {
                E.gfx.rect(px, py, CELL, CELL, dim ? dimColor(T.bg) : T.bg,
                           { r: 8 });
            } else if (!hold[idx(x, y)]) {
                drawTile(px, py, CELL, v, dim);
            }
        }
    }
    // tiles em voo: posicao interpolada pelo tween e escala do pop
    for (i = 0; i < anims.length; i++) {
        var a = anims[i];
        if (a.dead) continue;
        var sz = CELL * a.s;
        drawTile(a.x - sz / 2, a.y - sz / 2, sz, a.v, dim);
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
        enter: function () { clearAnims(); },   // nada em voo do jogo antigo
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
        static: true,   // parado nao repinta nada; juice/anim pinta o que vive
        enter: function () { paused = false; reset(); },
        update: function (dt) {
            if (paused) return;   // congelado: o menu vive no draw
            var alive = pruneAnims();                       // deslizes/pops
            if (juiceT > 0) { juiceT -= dt; alive++; }      // particulas
            if (alive > 0) E.redraw();
            if (E.hit(BTN_PAUSE)) { paused = true; E.redraw(); return; }
            if (E.hit(BTN_UNDO)) { undo(); return; }
            if (E.hit(BTN_NEW)) { saveHi(); reset(); E.redraw(); return; }
            if (won && E.hit(BTN_CONT)) { won = false; E.redraw(); return; }
            var sw = E.input.swipe;
            if (!sw) return;
            var dir = sw.dir === "left" ? "L" : sw.dir === "right" ? "R" :
                      sw.dir === "up" ? "U" : "D";
            var wasWon = won;
            if (!move(dir)) return;             // move emite "merge" e anima
            spawn(true);
            saveHi();
            E.emit("played", won && !wasWon);   // som + flash da vitoria
            E.redraw();
            if (!canMove()) E.emit("gameover");
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
        enter: function () { clearAnims(); },   // tabuleiro final inteiro
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
