// Campo Minado — classico completo. Porte CelerGame: o motor do tabuleiro
// segue em board.js (require local); o desenho incremental celula-a-celula
// vira a camada suja E.dirty — o painter repinta so as celulas da caixa
// tocada (arquitetura do Detona), cronometro/minas no cabecalho sujo, fx
// na abertura em cadeia e na mina. Melhor tempo por dificuldade no NVS.

var E = require("celeros.game");       // familia CelerGame: core + fx
require("celeros.game.fx");

E.init({ dir: "Campo Minado", fps: 30, save: "minado." });
var T = E.theme, W = E.W, H = E.H;

var MODES = [
    { name: "facil", cols: 9,  rows: 11, mines: 10, cell: 22 },
    { name: "duro",  cols: 12, rows: 14, mines: 28, cell: 18 }
];
var modeIdx = 0;

var createBoard = require("board");

// Som: System.sfx (API 32) mistura o efeito por cima da trilha e NAO trava
// o loop do jogo; firmware antigo cai no playTone (bloqueante)
var somFn = typeof System.sfx === "function" ? System.sfx :
            (typeof System.playTone === "function" ? System.playTone : null);
function tone(hz, ms) { if (somFn) { try { somFn([[hz, ms]]); } catch (e) {} } }
function tune(notes) { if (somFn) { try { somFn(notes); } catch (e) {} } }

// cores dos numeros por perigo (tema do sistema)
var NUMCOL = [0, T.accent, T.ok, T.err, T.warn, T.warn, T.text, T.text, T.textDim];

// ---------------------------------------------------------------- estado ---
var board = null;
var gridX = 0, gridY = 30, CELL = 22, gridEnd = 0;
var flagMode = false;
var startMs = 0, started = false, elapsedMs = 0, lastClock = -1;
var won = false;

var BTN_MODO = { x: 8, y: 288, w: 116, h: 26 };
var BTN_NOVO = { x: 124, y: 288, w: 108, h: 26 };
var BTN_DNV = { x: 40, y: 218, w: 160, h: 44 };

// melhor tempo: NVS (migracao 1x dos best_*.txt da versao anterior; sem a
// perm "fs" o runtime nao registra o objeto FS e a migracao e pulada)
function bestKey() { return "b" + MODES[modeIdx].name; }
function bestTime() {
    var v = E.save.num(bestKey(), 0);
    var FSx = typeof FS !== "undefined" ? FS : null;
    if (!v && FSx) {
        try {
            var r = FSx.readTextFile((FSx.appData ? FSx.appData() : "/local/") +
                                    "best_" + MODES[modeIdx].name + ".txt");
            var old = r ? parseInt(r, 10) : 0;
            if (old && !isNaN(old)) { v = old; E.save.set(bestKey(), old); }
        } catch (e) {}
    }
    return v;
}
function saveBest(ms) {
    var b = E.save.num(bestKey(), 0);
    if (!b || ms < b) E.save.set(bestKey(), ms);
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
    won = false;
}

function fmtTime(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    function two(n) { return (n < 10 ? "0" : "") + n; }
    return two(m) + ":" + two(s);
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
    var bt = bestTime();
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
var resultado = null;   // {won, elapsedMs} — cena fim le daqui

function finish(win) {
    won = win;
    if (win) {
        saveBest(elapsedMs);
        tune([[660, 90], [880, 90], [1320, 160]]);
    } else {
        tone(120, 400);
        E.fx.flash(T.err, 300);
    }
    resultado = { won: win, ms: elapsedMs };
    E.after(600, function () {
        E.goto("fim", { transition: win ? "iris" : "fade", ms: 450 });
    });
}

function play(x, y) {
    if (board.lost() || board.won()) return;
    if (!started) { started = true; startMs = System.millis(); }

    if (flagMode) {
        if (board.toggleFlag(x, y)) tone(520, 30);
        else tone(300, 20);
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
        E.fx.burst(cc.x, cc.y, { n: 12, color: T.accent, speed: 60, life: 0.5, size: 2 });
    }
    if (r.hit) {
        var mc = cellCenter(x, y);
        E.fx.burst(mc.x, mc.y, { n: 20, color: T.err, speed: 120, life: 0.7,
                                 grav: 140, size: 2 });
        // derrota revela todas as minas (classico): o board abre elas no
        // estado, mas so a tocada vinha na lista — as demais ficavam
        // escondidas (ninguem via onde elas estavam)
        board.eachMine(function (mx, my) {
            E.dirty.add(gridX + mx * CELL, gridY + my * CELL, CELL, CELL);
        });
        finish(false);
        return;
    }
    tone(700, 14);
    if (board.won()) { finish(true); return; }
    E.dirty.add(0, 0, 120, 26);
}

// ------------------------------------------------------------------ cenas ---
E.run({
    menu: {
        static: true,
        update: function () {
            var seg = [{ x: 16, y: 134, w: 104, h: 36 }, { x: 124, y: 134, w: 100, h: 36 }];
            for (var i = 0; i < 2; i++) {
                if (E.hit(seg[i])) { modeIdx = i; E.redraw(); return; }
            }
            if (E.hit({ x: 40, y: 214, w: 160, h: 48 })) {
                E.goto("jogo", { transition: "wipe", ms: 300 });
            }
        },
        draw: function () {
            E.gfx.text("Campo Minado", W / 2, 56, { ts: "huge", align: "center" });
            E.gfx.text("dificuldade", 16, 112, { ts: "label", color: T.textDim });
            var labels = ["fácil 9x11", "duro 12x14"];
            E.gfx.button(labels[0], 16, 134, 104, 36, { primary: modeIdx === 0, px: 12 });
            E.gfx.button(labels[1], 124, 134, 100, 36, { primary: modeIdx === 1, px: 12 });
            var b = bestTime();
            E.gfx.text(b ? "melhor tempo: " + fmtTime(b) : "sem tempo nesta dificuldade",
                       W / 2, 188, { ts: "small", align: "center", color: T.textDim });
            E.gfx.button("Jogar", 40, 214, 160, 48, { px: Math.round(20 * E.U) });
            E.gfx.text("toque abre · bandeira marca · numero com bandeiras certas abre vizinhos",
                       W / 2, 282, { ts: "small", align: "center", color: T.textDim });
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
            E.fx.draw();
        }
    },

    fim: {
        static: true,
        update: function () {
            if (E.hit(BTN_DNV)) E.goto("jogo", { transition: "wipe", ms: 300 });
            else if (E.input.tap && E.input.tap.y > 270) E.goto("menu", { transition: "fade", ms: 300 });
        },
        draw: function () {
            var bt = bestTime();
            E.gfx.text(resultado && resultado.won ? "Venceu!" : "Boom!", W / 2, 90,
                       { ts: "huge", align: "center",
                         color: resultado && resultado.won ? T.ok : T.err });
            if (resultado && resultado.won) {
                E.gfx.text("Tempo " + fmtTime(resultado.ms), W / 2, 140,
                           { ts: "title", align: "center" });
                if (resultado.ms <= bt) E.gfx.text("novo melhor tempo!", W / 2, 170,
                                                   { ts: "label", align: "center", color: T.ok });
            } else {
                E.gfx.text("As minas venceram esta rodada.", W / 2, 140,
                           { ts: "body", align: "center" });
            }
            E.gfx.button("De novo", BTN_DNV.x, BTN_DNV.y, BTN_DNV.w, BTN_DNV.h);
            E.gfx.button("Menu", 40, 270, 160, 40, { primary: false });
        }
    }
}, "menu");
