// Campo Minado — classico completo. Porte CelerGame: o motor do tabuleiro
// segue em board.js (require local); o desenho incremental celula-a-celula
// vira a camada suja E.dirty — o painter repinta so as celulas da caixa
// tocada (arquitetura do Detona), cronometro/minas no cabecalho sujo,
// estilhacos na abertura em cadeia e flash na mina. Menu, ajuda e fim de
// jogo usam o modulo compartilhado celeros.game.ui. Os efeitos seguem
// locais: a soma enxuta de main+board+core+ui+fx passaria do teto de 48 KB
// da CYD, entao a dep celeros.game.fx nao entra. Melhor tempo por
// dificuldade no NVS.

var E = require("celeros.game");       // familia CelerGame: core
require("celeros.game.ui");            // E.ui: menu, dialogo e gameOver

E.init({ dir: "Campo Minado", fps: 30, save: "minado." });
var T = E.theme, W = E.W, H = E.H;

var MODES = [
    { name: "facil", cols: 9,  rows: 11, mines: 10, cell: 22 },
    { name: "duro",  cols: 12, rows: 14, mines: 28, cell: 18 }
];
var modeIdx = 0;

var createBoard = require("board");

// Som: tabela do core + E.audio.sfx. Na API 32 o efeito e misturado por
// cima da trilha sem travar; firmware antigo cai no playTone (o fallback
// que o jogo ja usava vive dentro do E.audio.sfx).
var SFX = E.audio.sfxTable;
SFX.open = [[620, 12], [820, 18]];
SFX.flag = [540, 30];
SFX.boom = [[120, 400]];
SFX.win = [[660, 90], [880, 90], [1320, 160]];

// cores dos numeros por perigo (tema do sistema)
var NUMCOL = [0, T.accent, T.ok, T.err, T.warn, T.warn, T.text, T.text, T.textDim];

// ---------------------------------------------------------------- estado ---
var board = null;
var gridX = 0, gridY = 30, CELL = 22, gridEnd = 0;
var flagMode = false;
var startMs = 0, started = false, elapsedMs = 0, lastClock = -1;

var BTN_MODO = { x: 8, y: 288, w: 116, h: 26 };
var BTN_NOVO = { x: 124, y: 288, w: 108, h: 26 };

// ------------------------------------------------- efeitos locais (sem fx) ---
// Flash de tela cheia + estilhacos: o par minimo do celeros.game.fx que o
// jogo usa, sobre as primitivas do core. Cada particular registra a caixa
// na camada suja (E.dirty.add) — a borracha do quadro seguinte apaga.
var FX = [];
function fxFlash(cor, ms) { FX.push({ fl: 1, c: cor, t: ms / 1000, T: ms / 1000 }); }
function fxBurst(x, y, n, cor, spd, life, grav) {
    for (var i = 0; i < n; i++) {
        var a = Math.random() * 6.2832, v = spd * (0.4 + Math.random() * 0.6);
        FX.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
                  t: life * (0.6 + Math.random() * 0.4), c: cor, g: grav || 0 });
    }
}
function fxTick(dt) {
    for (var i = FX.length - 1; i >= 0; i--) {
        var p = FX[i];
        p.t -= dt;
        if (p.t <= 0) { FX.splice(i, 1); continue; }
        if (!p.fl) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.g * dt; }
    }
}
function fxDraw() {
    for (var i = 0; i < FX.length; i++) {
        var p = FX[i];
        if (p.fl) {
            System.fillRect(0, 0, W, H, System.mixColor(p.c, T.bg,
                          Math.round(70 * p.t / (p.T || 1))));
            E.dirty.add(0, 0, W, H);
        } else {
            System.fillCircle(p.x, p.y, 2, p.c);
            E.dirty.add(p.x - 3, p.y - 3, 7, 7);
        }
    }
}

// melhor tempo: NVS (migracao 1x dos best_*.txt da versao anterior; sem a
// perm "fs" o runtime nao registra o objeto FS e a migracao e pulada)
function bestTime(i) {
    var k = "b" + MODES[i].name;
    var v = E.save.num(k, 0);
    var FSx = typeof FS !== "undefined" ? FS : null;
    if (!v && FSx) {
        try {
            v = parseInt(FSx.readTextFile((FSx.appData ? FSx.appData() : "/local/") +
                        "best_" + MODES[i].name + ".txt"), 10) || 0;
            if (v) E.save.set(k, v);
        } catch (e) {}
    }
    return v;
}

function newGame() {
    var m = MODES[modeIdx];
    CELL = m.cell;
    board = createBoard(m.cols, m.rows, m.mines);
    gridX = Math.floor((W - m.cols * CELL) / 2);
    gridEnd = gridY + m.rows * CELL;
    flagMode = false;
    started = false;
    elapsedMs = 0;
    lastClock = -1;
    FX.length = 0;
}

function fmtTime(ms) {
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    s = s % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
}

// ---------------------------------------------------------------- desenho ---
// desenho de UMA celula em coords absolutas (cru: e chamado pelo painter
// da camada suja, que nao pode registrar caixas)
var wellCol = null;

function paintCellRaw(x, y) {
    var c = board.cell(x, y);
    if (!c) return;
    var px = gridX + x * CELL, py = gridY + y * CELL;
    if (!c.open) {
        System.fillRoundRect(px + 1, py + 1, CELL - 2, CELL - 2, 4, T.raised);
        System.drawRoundRect(px + 1, py + 1, CELL - 2, CELL - 2, 4, T.stroke);
        if (c.flag) {
            var cx = px + CELL / 2, cy = py + CELL / 2;
            System.fillTriangle(cx - 2, cy - CELL / 3, cx + CELL / 3, cy - 1, cx - 2, cy + CELL / 4, T.err);
            System.drawFastVLine(Math.floor(cx) - 2, Math.floor(cy - CELL / 3), Math.floor(CELL * 0.6), T.text);
        }
        return;
    }
    System.fillRect(px + 1, py + 1, CELL - 2, CELL - 2, wellCol);
    if (c.mine) {
        System.fillSmoothCircle(px + CELL / 2, py + CELL / 2, (CELL - 6) / 2, T.err);
        System.fillSmoothCircle(px + CELL / 2 - 2, py + CELL / 2 - 2, 2, T.text);
    } else if (c.n > 0) {
        System.setTextColor(NUMCOL[c.n], wellCol);
        System.setTextDatum(5);           // MC (LovyanGFX: 4 e middle-left)
        System.drawString(String(c.n), Math.floor(px + CELL / 2), Math.floor(py + CELL / 2), 2);
        System.setTextDatum(0);
    }
}

// cabecalho cru (fundo + textos): chamado no frame cheio e pelo painter
// quando uma caixa toca a faixa de cima
function paintHeaderRaw() {
    var rem = board.remaining();
    System.fillRect(0, 0, W, 26, T.card);
    System.drawFastHLine(0, 25, W, T.stroke);
    System.setTextColor(rem === 0 ? T.ok : T.text, T.card);
    var remS = (rem > 0 ? "" : "+") + Math.abs(rem);
    System.drawString(remS, 10, 3, 2);
    var rw = System.textWidth(remS, 2) + 6;
    System.setTextColor(T.textDim, T.card);
    System.drawString("minas", 12 + rw, 8, 1);
    System.setTextDatum(2);               // TR
    System.setTextColor(T.textDim, T.card);
    System.drawString(fmtTime(elapsedMs), W - 10, 7, 1);
    var bt = bestTime(modeIdx);
    if (bt) System.drawString("melhor " + fmtTime(bt), 118, 7, 1);
    System.setTextDatum(0);
}

// painter da camada suja: repinta celulas que tocam a caixa (estado atual
// do board — celula aberta pinta aberta), a faixa do cabecalho quando
// tocada e so fundo nas faixas de fora (botoes/trevos)
function paintField(x, y, w, h) {
    var x2 = x + w, y2 = y + h;
    if (y < gridY) paintHeaderRaw();
    if (y2 > gridEnd) System.fillRect(x, Math.max(y, gridEnd), w, y2 - Math.max(y, gridEnd), T.bg);
    var m = MODES[modeIdx];
    var c0 = Math.max(0, Math.floor((x - gridX) / CELL));
    var c1 = Math.min(m.cols - 1, Math.floor((x2 - gridX - 1) / CELL));
    var r0 = Math.max(0, Math.floor((y - gridY) / CELL));
    var r1 = Math.min(m.rows - 1, Math.floor((y2 - gridY - 1) / CELL));
    for (var ry = r0; ry <= r1; ry++) {
        for (var cx = c0; cx <= c1; cx++) paintCellRaw(cx, ry);
    }
    // faixas laterais do grid
    if (x < gridX) System.fillRect(x, Math.max(y, gridY), gridX - x, h, T.bg);
    if (x2 > gridX + m.cols * CELL) {
        var gx2 = gridX + m.cols * CELL;
        System.fillRect(Math.max(x, gx2), Math.max(y, gridY), x2 - Math.max(x, gx2), h, T.bg);
    }
}

// marca as celulas abertas na camada suja (o painter as repinta no estado
// novo no proximo quadro)
function markCells(list) {
    for (var i = 0; i < list.length; i++) {
        E.dirty.add(gridX + list[i].x * CELL, gridY + list[i].y * CELL, CELL, CELL);
    }
}

function cellCenter(x, y) {
    return { x: gridX + x * CELL + CELL / 2, y: gridY + y * CELL + CELL / 2 };
}

// ---------------------------------------------------------------- jogada ---
var resultado = null;   // {won, ms, best, novo} — a cena fim le daqui

function finish(win) {
    var antes = bestTime(modeIdx);
    if (win) {
        if (!antes || elapsedMs < antes) E.save.set("b" + MODES[modeIdx].name, elapsedMs);
        E.audio.sfx("win");
    } else {
        E.audio.sfx("boom");
        fxFlash(T.err, 300);
    }
    resultado = { won: win, ms: elapsedMs, best: bestTime(modeIdx),
                  novo: win && (!antes || elapsedMs < antes) };
    // deixa o tabuleiro (e a explosao) visivel antes da tela de fim
    E.after(600, function () {
        E.goto("fim", { transition: win ? "iris" : "fade", ms: 450 });
    });
}

function play(x, y) {
    if (board.lost() || board.won()) return;
    if (!started) { started = true; startMs = System.millis(); }

    if (flagMode) {
        if (board.toggleFlag(x, y)) E.audio.sfx("flag");
        E.dirty.add(gridX + x * CELL, gridY + y * CELL, CELL, CELL);
        E.dirty.add(0, 0, 120, 26);       // contador de minas
        return;
    }
    var c = board.cell(x, y);
    var r = (c && c.open) ? board.chord(x, y) : board.reveal(x, y);
    markCells(r.opened);
    if (r.opened.length > 3) {
        // abertura em cadeia: estouro na celula de inicio
        var cc = cellCenter(x, y);
        fxBurst(cc.x, cc.y, 12, T.accent, 60, 0.5, 0);
    }
    if (r.hit) {
        var mc = cellCenter(x, y);
        fxBurst(mc.x, mc.y, 20, T.err, 120, 0.7, 140);
        // derrota revela todas as minas (classico): o board abre elas no
        // estado, mas so a tocada vinha na lista — as demais ficavam
        // escondidas (ninguem via onde elas estavam)
        board.eachMine(function (mx, my) {
            E.dirty.add(gridX + mx * CELL, gridY + my * CELL, CELL, CELL);
        });
        finish(false);
        return;
    }
    if (r.opened.length) E.audio.sfx("open");
    if (board.won()) { finish(true); return; }
    E.dirty.add(0, 0, 120, 26);
}

var ajuda = null;
var AJUDA = "Toque para abrir: o primeiro toque nunca é mina. Bandeira marca " +
            "minas; tocar num número com as bandeiras certas abre os vizinhos. " +
            "Abra todas as células sem mina para vencer. O melhor tempo fica salvo.";

// ------------------------------------------------------------------ cenas ---
E.run({
    menu: {
        static: true,
        draw: function () {
            E.gfx.text("Campo Minado", W / 2, 36,
                       { ts: "huge", align: "center", fit: W - 16 });
            var pick = E.ui.menu(["Fácil", "Duro", "Como jogar"]);
            if (pick === "Fácil") { modeIdx = 0; E.goto("jogo", { transition: "wipe", ms: 300 }); }
            else if (pick === "Duro") { modeIdx = 1; E.goto("jogo", { transition: "wipe", ms: 300 }); }
            else if (pick === "Como jogar") E.goto("ajuda", { transition: "fade", ms: 250 });
            var b0 = bestTime(0), b1 = bestTime(1);
            E.gfx.text("Fácil 9x11: " + (b0 ? fmtTime(b0) : "--:--"),
                       W / 2, 226, { ts: "small", align: "center", color: b0 ? T.text : T.textDim });
            E.gfx.text("Duro 12x14: " + (b1 ? fmtTime(b1) : "--:--"),
                       W / 2, 242, { ts: "small", align: "center", color: b1 ? T.text : T.textDim });
        }
    },

    ajuda: {
        enter: function () {
            ajuda = E.ui.dialog(AJUDA, { name: "Como jogar", speed: 50 });
            E.dirty.enable(T.bg);
        },
        exit: function () { E.dirty.off(); },
        draw: function () {
            if (!ajuda.draw(20, 60, 200))
                E.goto("menu", { transition: "fade", ms: 250 });
        }
    },

    jogo: {
        enter: function () {
            newGame();
            wellCol = System.mixColor(T.bg, T.card, 60);
            E.dirty.enable(paintField);   // frame cheio: tudo pelo painter
        },
        exit: function () { E.dirty.off(); },
        update: function (dt) {
            fxTick(dt);
            if (started && !board.lost() && !board.won()) {
                elapsedMs = System.millis() - startMs;
                // relogio a cada 500 ms (caixa suja na faixa do cabecalho)
                var seg = Math.floor(elapsedMs / 500);
                if (seg !== lastClock) {
                    lastClock = seg;
                    E.dirty.add(W - 66, 0, 66, 26);
                }
            }
            var t = E.input.tap;
            if (t && t.x >= gridX && t.y >= gridY && t.y < gridEnd) {
                var gx = Math.floor((t.x - gridX) / CELL);
                var gy = Math.floor((t.y - gridY) / CELL);
                if (board.cell(gx, gy)) play(gx, gy);
            }
            if (E.hit(BTN_MODO)) flagMode = !flagMode;
            if (E.hit(BTN_NOVO)) {
                newGame();
                E.dirty.full();
            }
        },
        draw: function () {
            // so o que flutua por cima do cenario: particulas e botoes
            E.gfx.button(flagMode ? "Bandeira ON" : "Modo cavar",
                         BTN_MODO.x, BTN_MODO.y, BTN_MODO.w, BTN_MODO.h,
                         { primary: flagMode, px: 12 });
            E.gfx.button("Novo", BTN_NOVO.x, BTN_NOVO.y, BTN_NOVO.w, BTN_NOVO.h,
                         { primary: false, px: 12 });
            fxDraw();
        }
    },

    fim: {
        static: true,
        draw: function () {
            var r = resultado;
            var act = E.ui.gameOver({
                title: r.won ? "VITORIA!" : "BOOM!",
                labels: ["Jogar de novo", "Menu"]
            });
            E.gfx.text("Tempo " + fmtTime(r.ms), W / 2, 102,
                       { ts: "title", align: "center", color: T.text });
            E.gfx.text(r.novo ? "NOVO RECORDE! " + fmtTime(r.best)
                              : "Melhor " + (r.best ? fmtTime(r.best) : "--:--"),
                       W / 2, 138,
                       { ts: "label", align: "center", color: r.novo ? T.accent : T.textDim });
            if (act === "again") E.goto("jogo", { transition: "wipe", ms: 300 });
            else if (act === "quit") E.goto("menu", { transition: "fade", ms: 300 });
        }
    }
}, "menu");
