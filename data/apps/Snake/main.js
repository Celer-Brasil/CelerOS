// CelerOS Snake — classico da cobrinha no CelerKit UI 2.0. HUD em card
// (placar, recorde e nivel), tabuleiro pintado em A.custom (redesenha so o
// retangulo do campo; UI.custom nativo nas S3), pausa e fim de jogo em sheet,
// swipe vira e toque pausa. Fruta dourada a cada 5 frutas (+3, pisca e
// expira). Recorde persistido em /local/config_snake_hi.txt. ES5 (Duktape).

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.widgets");
A.init();
var T = A.style.T;
// nucleo antigo (hub 1.1.0) sem A.custom: cai no desenho direto do quadro
var CUSTOM = !!(A.custom && A.custom.call);

var CELL = 12;
var COLS = Math.floor(A.L.w / CELL);            // 18 no 240x320
var BY = 52;
// linhas que cabem na area segura (20 no retangular; menos no watch redondo)
var ROWS = Math.max(12, Math.min(20, Math.floor((A.L.bottom - BY - 14) / CELL)));
var BW = COLS * CELL, BH = ROWS * CELL;
var BX = A.L.x + Math.floor((A.L.w - BW) / 2);
var HI_FILE = "/local/config_snake_hi.txt";
var GOLD_EVERY = 5;
var GOLD_MS = 7000;

// Som: System.sfx (API 32) nao trava; firmware antigo cai no playTone
var somFn = typeof System.sfx === "function" ? System.sfx :
            (typeof System.playTone === "function" ? System.playTone : null);
function tone(hz, ms) { if (somFn) { try { somFn([[hz, ms]]); } catch (e) {} } }
function tune(notes) { if (somFn) { try { somFn(notes); } catch (e) {} } }
if (typeof System.keepAwake === "function") {
    try { System.keepAwake(120000); } catch (e0) {}
}

var hi = 0;
try {
    var raw = FS.readTextFile(HI_FILE);
    if (raw) { var p = parseInt(raw, 10); if (!isNaN(p)) hi = p; }
} catch (e1) {}

// ---- estado ---------------------------------------------------------------
var snake, dir, nextDir, food, gold, score, interval, state, growPending;
var fruits, goldUntil, newRecord, tick, countUntil, lastTick;
var sheetKind = 0, sheetOpen = false, sheetUntil = 0, wasBusy = false;

function reset() {
    var x0 = Math.floor(COLS / 2), y0 = Math.floor(ROWS / 2);
    snake = [{ x: x0, y: y0 }, { x: x0 - 1, y: y0 }, { x: x0 - 2, y: y0 }];
    dir = { dx: 1, dy: 0 };
    nextDir = null;
    score = 0;
    interval = 220;
    growPending = 0;
    fruits = 0;
    gold = null;
    goldUntil = 0;
    newRecord = false;
    tick = 0;
    state = "count";
    countUntil = System.millis() + 1500;
    lastTick = System.millis();
    spawnFood();
    UI.invalidate();
}
function level() { return 1 + Math.floor((220 - interval) / 6); }

function onSnake(x, y) {
    for (var i = 0; i < snake.length; i++) {
        if (snake[i].x === x && snake[i].y === y) return true;
    }
    return false;
}
function busyCell(x, y) {
    return onSnake(x, y) || (food && food.x === x && food.y === y) ||
           (gold && gold.x === x && gold.y === y);
}
function freeCell() {
    for (var tries = 0; tries < 300; tries++) {
        var x = Math.floor(Math.random() * COLS);
        var y = Math.floor(Math.random() * ROWS);
        if (!busyCell(x, y)) return { x: x, y: y };
    }
    for (var j = 0; j < ROWS; j++) {
        for (var i = 0; i < COLS; i++) if (!busyCell(i, j)) return { x: i, y: j };
    }
    return null;
}
function spawnFood() {
    food = freeCell();
    if (!food) { state = "over"; openSheet(2); }
}
function spawnGold() {
    var c = freeCell();
    if (!c) return;
    gold = c;
    goldUntil = System.millis() + GOLD_MS;
}

function saveHi() {
    if (score > hi) {
        hi = score;
        newRecord = true;
        try { FS.writeTextFile(HI_FILE, String(hi)); } catch (e) {}
        tune([[880, 90], [1320, 120]]);
    }
}

// ---- passo ----------------------------------------------------------------
function die() {
    tone(150, 220);
    saveHi();
    state = "over";
    openSheet(2);
}
function step() {
    if (nextDir) {
        if (!(nextDir.dx === -dir.dx && nextDir.dy === -dir.dy)) dir = nextDir;
        nextDir = null;
    }
    var head = { x: snake[0].x + dir.dx, y: snake[0].y + dir.dy };
    if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) return die();
    if (onSnake(head.x, head.y)) {
        var tail = snake[snake.length - 1];
        if (!(growPending === 0 && tail.x === head.x && tail.y === head.y)) return die();
    }
    var ate = 0;
    if (food && head.x === food.x && head.y === food.y) ate = 1;
    else if (gold && head.x === gold.x && head.y === gold.y) ate = 3;

    snake.unshift(head);
    if (ate > 0) {
        if (ate === 3) gold = null;
        fruits++;
        score += ate;
        if (score > hi) newRecord = true;
        growPending += ate + 1;
        interval = Math.max(90, 220 - fruits * 6);
        tone(ate === 3 ? 990 : 660, ate === 3 ? 70 : 45);
        if (fruits % GOLD_EVERY === 0 && !gold) spawnGold();
        if (ate === 1) spawnFood();
    } else if (growPending > 0) {
        growPending--;
    } else {
        snake.pop();
    }
    if (gold && System.millis() > goldUntil) gold = null;
    tick++;
}

// ---- desenho do tabuleiro (A.custom pinta tudo com System.*) ---------------
function drawBoard(x, y, w, h) {
    var now = System.millis();
    System.fillRect(x, y, w, h, T.card);
    System.drawRoundRect(x, y, w, h, 10, T.stroke);

    var i, cx, cy;
    for (i = 0; i < snake.length; i++) {
        cx = x + snake[i].x * CELL;
        cy = y + snake[i].y * CELL;
        System.fillRoundRect(cx + 1, cy + 1, CELL - 2, CELL - 2, 3,
                             i === 0 ? T.ok : T.accent);
    }
    if (food) {
        System.fillSmoothCircle(x + food.x * CELL + CELL / 2,
                                y + food.y * CELL + CELL / 2, 4, T.err);
    }
    if (gold && Math.floor(now / 220) % 2 === 0) {
        System.fillSmoothCircle(x + gold.x * CELL + CELL / 2,
                                y + gold.y * CELL + CELL / 2, 5, T.warn);
    }
    if (state === "count") {
        var n = Math.ceil((countUntil - now) / 500);
        if (n > 3) n = 3;
        System.setTextDatum(5);                    // MC
        System.setTextColor(T.accent, T.card);
        System.drawString(String(n), x + w / 2, y + Math.round(h * .3), 4);
        System.setTextDatum(0);
    }
}

// ---- sheets ----------------------------------------------------------------
function openSheet(k) { sheetKind = k; sheetOpen = true; UI.invalidate(); }
function closeSheet() {
    sheetOpen = false;
    sheetUntil = System.millis() + 260;
    lastTick = System.millis();
    UI.invalidate();
}

function pauseSheet(c) {
    // full so com o sheet aberto: o veu apaga a base (fill opaco) e na saida
    // o cartao tem de deslizar sobre o tabuleiro, nao sobre a tela limpa
    return A.widgets.sheet("snk-pause",
        { open: sheetOpen, full: c.full && sheetOpen, h: 210, title: "Pausado", dim: 38 },
        function (r) {
            UI.text("Nível " + level() + "  ·  " + score + " pontos",
                    r.x, r.y, { role: "body", color: T.text, bg: r.bg, w: r.w, id: "pinfo" });
            UI.text("recorde: " + hi, r.x, r.y + 18,
                    { role: "caption", color: T.textDim, bg: r.bg, w: r.w, id: "phi" });
            var go = A.style.button("Continuar", r.x, r.y + 48, r.w, 44);
            if (sheetOpen && go) closeSheet();
            var rs = A.style.button("Reiniciar", r.x, r.y + 100, r.w, 38, { variant: "ghost" });
            if (sheetOpen && rs) {
                reset();
                closeSheet();
            }
        });
}

function overSheet(c) {
    var win = snake.length >= COLS * ROWS;
    return A.widgets.sheet("snk-over",
        { open: sheetOpen, full: c.full && sheetOpen, h: 224, dim: 38,
          title: win ? "Você venceu!" : "Fim de jogo" },
        function (r) {
            UI.text("Pontos: " + score, r.x, r.y,
                    { role: "title", color: T.text, bg: r.bg, w: r.w, id: "oinfo" });
            UI.text(newRecord ? "Novo recorde!" : "Recorde: " + hi, r.x, r.y + 20,
                    { role: "caption", color: newRecord ? T.ok : T.textDim,
                      bg: r.bg, w: r.w, id: "ohi" });
            var ag = A.style.button("Jogar de novo", r.x, r.y + 54, r.w, 44);
            if (sheetOpen && ag) {
                reset();
                closeSheet();
            }
            var ex = A.style.button("Sair", r.x, r.y + 106, r.w, 36, { variant: "ghost" });
            if (sheetOpen && ex) {
                System.exitApp();
            }
        });
}

// ---- tela ------------------------------------------------------------------
reset();

A.run({
    main: function (c) {
        var now = System.millis(), busy = sheetKind !== 0;

        // HUD: placar / recorde / nivel (o teste do harness procura estes textos)
        A.style.card(A.L.x, 6, A.L.w, 38, { full: c.full, r: 12, draw: function (r) {
            UI.text("Pontos " + score, r.x, r.y,
                    { role: "title", color: T.text, bg: r.bg, id: "pts" });
            UI.text("Rec " + hi, r.x + r.w, r.y + 2,
                    { role: "caption", align: "right", w: 90,
                      color: newRecord ? T.ok : T.textDim, bg: r.bg, id: "hi" });
            UI.text("Nv " + level() + "  ·  " +
                    (state === "play" ? "jogando" : state === "count" ? "preparar" : "fim"),
                    r.x, r.y + 14,
                    { role: "caption", color: T.textDim, bg: r.bg, w: r.w, lines: 1, id: "lvl" });
        }});

        // entrada (fora do sheet): swipe vira, toque pausa
        if (!busy) {
            var t = UI.touch();
            if (t.released && state === "play") {
                var dx = t.x - t.sx, dy = t.y - t.sy;
                if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
                    openSheet(1);            // toque seco: pausa
                } else if (Math.abs(dx) > Math.abs(dy)) {
                    nextDir = { dx: dx > 0 ? 1 : -1, dy: 0 };
                } else {
                    nextDir = { dx: 0, dy: dy > 0 ? 1 : -1 };
                }
            }
            if (state === "count" && now >= countUntil) {
                state = "play";
                lastTick = now;
            } else if (state === "play" && now - lastTick >= interval) {
                lastTick = now;
                step();
            }
        }

        // tabuleiro (so repinta quando o passo/pisca muda; "p" congela no sheet)
        var sig = busy ? "p" :
            (state + "|" + tick + "|" + (gold ? Math.floor(now / 220) % 2 : 9) +
             "|" + (state === "count" ? Math.ceil((countUntil - now) / 500) : 0));
        if (CUSTOM) {
            A.custom("snake", BX, BY, BW, BH, sig, drawBoard,
                     { bg: T.card, clear: true });
        } else {
            drawBoard(BX, BY, BW, BH);
        }

        UI.text("deslize vira · toque pausa", 120, A.L.bottom - 8,
                { role: "caption", align: "center", color: T.textDim,
                  w: A.L.w, lines: 1, id: "hint" });

        if (busy) {
            var r = sheetKind === 1 ? pauseSheet(c) : overSheet(c);
            if (r === "close") {
                if (sheetKind === 2) reset();     // fechar o fim de jogo comeca outro
                closeSheet();
            }
            if (!sheetOpen && now > sheetUntil) {
                sheetKind = 0;
                UI.invalidate();
            }
        }
        if (wasBusy && !busy) UI.invalidate();
        wasBusy = busy;
    }
}, "main", { fps: 30 });
