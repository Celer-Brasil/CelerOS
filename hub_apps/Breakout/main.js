// Breakout — arraste a raquete, quebre os tijolos, avance de nivel. Sem a
// engine CelerGame: CelerKit (app/style/icons/widgets/data) + o campo pintado
// com System.* (fundo/tijolos numa area do app e bola/raquete/estouros
// desenhados por cima com apagamento local), entao roda tambem na CYD (sem
// PSRAM). Colisao propria com subpassos (sem tunel), vidas, vida extra a
// cada 500 pontos, recorde no Storage (A.data) e overlays do A.style.
// ES5 puro (Duktape).

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.widgets");
require("celeros.app.data");

A.init();
var T = A.style.preset("soft");
var S = System;
var L = A.L;

var FX = L.x, FW = L.w, FY = 42;
var PADDLE_W = 48, PADDLE_H = 8;
var PADDLE_Y = L.bottom - 20;
var BALL_R = 3;
var BRICK_COLS = 8, BRICK_ROWS = 5;
var BRICK_W = Math.floor((FW - 16) / BRICK_COLS);
var BRICK_H = 12;
var BRICK_X = FX + 8;
var BRICK_Y = FY + 10;
var ROW_COLORS = [T.err, T.warn, T.ok, T.accent, T.accentD];
var ROW_DARK = [];
var ROW_POINTS = [50, 40, 30, 20, 10];
for (var ri = 0; ri < ROW_COLORS.length; ri++) {
    ROW_DARK.push(S.mixColor(ROW_COLORS[ri], 0x0000, 35));
}

var hi = 0;
(function () {
    var h = A.data.loadState("hi", 0);
    hi = (typeof h === "number" && h > 0) ? Math.floor(h) : 0;
    // migracao 1x do recorde da versao CelerGame
    if (!hi) {
        var oldHi = A.data.loadState("breakout.hi", 0);
        if (typeof oldHi === "number" && oldHi > 0) {
            hi = Math.floor(oldHi);
            A.data.saveState("hi", hi);
        }
    }
})();

var bricks = [], pops = [];
var score = 0, lives = 3, level = 1, speed = 130, nextLife = 500;
var paddleX = 0;
var ball = { x: 0, y: 0, vx: 0, vy: 0 };
var serving = true, over = false, paused = false, showResult = false;
var overAt = 0, flashAt = 0, levelAt = 0, novoRec = false, hiBase = 0;
var fieldVer = 1, nowMs = 0, fullFrame = false;
var lastNow = 0, wantNew = false;
var prevBall = { x: -1, y: -1 }, prevPad = -1;
var sigs = {};

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

// ------------------------------------------------------------------ estado ---
function buildBricks() {
    bricks.length = 0;
    for (var r = 0; r < BRICK_ROWS; r++) {
        for (var c = 0; c < BRICK_COLS; c++) {
            bricks.push({
                x: BRICK_X + c * BRICK_W,
                y: BRICK_Y + r * (BRICK_H + 3),
                r: r, alive: true
            });
        }
    }
    fieldVer++;
}

function resetBall() {
    serving = true;
    ball.x = paddleX + PADDLE_W / 2;
    ball.y = PADDLE_Y - BALL_R - 1;
    ball.vx = 0;
    ball.vy = 0;
}

function clampPaddle(x) {
    var nx = x - PADDLE_W / 2;
    if (nx < FX + 3) nx = FX + 3;
    if (nx > FX + FW - PADDLE_W - 3) nx = FX + FW - PADDLE_W - 3;
    paddleX = nx;
}

function newGame() {
    score = 0;
    lives = 3;
    level = 1;
    speed = 130;
    nextLife = 500;
    novoRec = false;
    over = false;
    paused = false;
    showResult = false;
    overAt = 0;
    flashAt = 0;
    levelAt = 0;
    hiBase = hi;
    pops.length = 0;
    paddleX = FX + (FW - PADDLE_W) / 2;
    buildBricks();
    resetBall();
}

function saveHi() {
    if (score <= hi) return;
    hi = score;
    A.data.saveState("hi", hi);
}

function addScore(pts) {
    score += pts;
    if (score > hi) { hi = score; A.data.saveState("hi", hi); }
    while (score >= nextLife && lives < 5) {
        nextLife += 500;
        lives++;
    }
}

function launch() {
    var ang = (Math.random() * 2 - 1) * 0.9;
    if (ang > -0.25 && ang < 0.25) {
        ang = (Math.random() < 0.5 ? -0.3 : 0.3);
    }
    ball.vx = Math.sin(ang);
    ball.vy = -Math.cos(ang);
    serving = false;
    lastNow = nowMs;
}

function levelCleared() {
    for (var i = 0; i < bricks.length; i++) if (bricks[i].alive) return false;
    return true;
}

function loseLife() {
    lives--;
    sfx([[320, 90], [200, 160]]);
    flashAt = nowMs;
    if (lives <= 0) {
        over = true;
        overAt = nowMs;
        saveHi();
        novoRec = (score > hiBase && score > 0);
        if (novoRec) A.toast("NOVO RECORDE!", 1600);
        serving = true;
        resetBall();
        UI.invalidate();
    } else {
        resetBall();
    }
}

function breakBrick(b) {
    b.alive = false;
    addScore(ROW_POINTS[b.r]);
    pops.push({ x: b.x, y: b.y, w: BRICK_W - 2, h: BRICK_H,
                t0: nowMs, c: ROW_COLORS[b.r] });
    if (pops.length > 6) pops.splice(0, pops.length - 6);
    sfx([[740, 30], [990, 45]]);
    fieldVer++;
}

function checkLevel() {
    if (!levelCleared()) return false;
    level++;
    speed += 20;
    addScore(100);
    levelAt = nowMs;
    sfx([[523, 80], [659, 80], [784, 150]]);
    buildBricks();
    pops.length = 0;
    resetBall();
    return true;
}

// ------------------------------------------------------------- fisica -------
function stepPhysics(dt) {
    if (serving || over) return;
    var dist = speed * dt;
    var n = Math.ceil(dist / 4);
    if (n < 1) n = 1;
    if (n > 12) n = 12;
    var sdt = dt / n;
    for (var s = 0; s < n; s++) {
        ball.x += ball.vx * speed * sdt;
        ball.y += ball.vy * speed * sdt;

        // paredes do campo (a bola nunca cobre a moldura)
        if (ball.x < FX + BALL_R + 2) {
            ball.x = FX + BALL_R + 2;
            ball.vx = Math.abs(ball.vx);
        }
        if (ball.x > FX + FW - BALL_R - 2) {
            ball.x = FX + FW - BALL_R - 2;
            ball.vx = -Math.abs(ball.vx);
        }
        if (ball.y < FY + BALL_R + 2) {
            ball.y = FY + BALL_R + 2;
            ball.vy = Math.abs(ball.vy);
        }

        // raquete (so descendo)
        if (ball.vy > 0 &&
            ball.y + BALL_R >= PADDLE_Y &&
            ball.y - BALL_R <= PADDLE_Y + PADDLE_H &&
            ball.x + BALL_R >= paddleX &&
            ball.x - BALL_R <= paddleX + PADDLE_W) {
            ball.y = PADDLE_Y - BALL_R;
            var rel = (ball.x - (paddleX + PADDLE_W / 2)) / (PADDLE_W / 2);
            if (rel < -1) rel = -1;
            if (rel > 1) rel = 1;
            var ang = rel * 1.05;
            ball.vx = Math.sin(ang);
            ball.vy = -Math.abs(Math.cos(ang));
            sfx([[240, 45]]);
        }

        // tijolos: um por passo, eixo pela menor penetracao
        var bw = BRICK_W - 2;
        for (var i = 0; i < bricks.length; i++) {
            var b = bricks[i];
            if (!b.alive) continue;
            if (ball.x + BALL_R <= b.x || ball.x - BALL_R >= b.x + bw ||
                ball.y + BALL_R <= b.y || ball.y - BALL_R >= b.y + BRICK_H) {
                continue;
            }
            var ox = Math.min(ball.x + BALL_R, b.x + bw) -
                     Math.max(ball.x - BALL_R, b.x);
            var oy = Math.min(ball.y + BALL_R, b.y + BRICK_H) -
                     Math.max(ball.y - BALL_R, b.y);
            if (ox < oy) {
                ball.x = (ball.x < b.x + bw / 2)
                         ? b.x - BALL_R : b.x + bw + BALL_R;
                ball.vx = -ball.vx;
            } else {
                ball.y = (ball.y < b.y + BRICK_H / 2)
                         ? b.y - BALL_R : b.y + BRICK_H + BALL_R;
                ball.vy = -ball.vy;
            }
            breakBrick(b);
            if (checkLevel()) { lastNow = nowMs; return; }
            break;
        }

        // fundo: perde vida
        if (ball.y - BALL_R > L.bottom + 4) {
            loseLife();
            lastNow = nowMs;
            return;
        }
    }
}

// ----------------------------------------------------------------- desenho ---
function drawBrick(b) {
    var bw = BRICK_W - 2;
    S.fillGradient(b.x, b.y, bw, BRICK_H,
                   ROW_COLORS[b.r], ROW_DARK[b.r], 3);
}

function drawFrame() {
    S.fillRect(FX + 1, FY + 1, FW - 2, 1, T.stroke);
    S.fillRect(FX + 1, L.bottom - 2, FW - 2, 1, T.stroke);
    S.fillRect(FX + 1, FY + 1, 1, L.bottom - FY - 2, T.stroke);
    S.fillRect(FX + FW - 2, FY + 1, 1, L.bottom - FY - 2, T.stroke);
}

function drawBg() {
    S.fillRect(0, FY, 240, 320 - FY, T.bg);
    drawFrame();
    for (var i = 0; i < bricks.length; i++) if (bricks[i].alive) drawBrick(bricks[i]);
    if (serving) {
        S.setTextColor(T.textDim);
        S.setTextDatum(5);
        S.drawString("toque para lançar a bola", 120, PADDLE_Y - 55, 2);
        S.setTextDatum(0);
    }
}

// repinta so a caixa de fundo (apaga bola/raquete/estouro sem repintar tudo)
function repaintBg(x, y, w, h) {
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var x1 = Math.ceil(x + w), y1 = Math.ceil(y + h);
    if (x0 < 0) x0 = 0;
    if (y0 < FY) y0 = FY;
    if (x1 > 240) x1 = 240;
    if (y1 > 320) y1 = 320;
    if (x1 <= x0 || y1 <= y0) return;
    S.fillRect(x0, y0, x1 - x0, y1 - y0, T.bg);
    drawFrame();
    for (var i = 0; i < bricks.length; i++) {
        var b = bricks[i];
        if (!b.alive) continue;
        var bw = BRICK_W - 2;
        if (b.x + bw <= x0 || b.x >= x1 || b.y + BRICK_H <= y0 || b.y >= y1) {
            continue;
        }
        drawBrick(b);
    }
}

function drawPaddle() {
    S.fillGradient(Math.round(paddleX), PADDLE_Y, PADDLE_W, PADDLE_H,
                   T.accent, T.accentD, 4);
}

function drawBall() {
    S.fillSmoothCircle(Math.round(ball.x), Math.round(ball.y), BALL_R, T.text);
}

function drawPops() {
    for (var i = pops.length - 1; i >= 0; i--) {
        var p = pops[i];
        var e = (nowMs - p.t0) / 240;
        if (e >= 1) { pops.splice(i, 1); continue; }
        var g = Math.round(1 + 4 * e);
        S.drawRect(p.x - g, p.y - g, p.w + 2 * g, p.h + 2 * g, p.c);
    }
}

function erasePrev() {
    if (prevBall.x >= 0) {
        repaintBg(prevBall.x - BALL_R - 2, prevBall.y - BALL_R - 2,
                  BALL_R * 2 + 5, BALL_R * 2 + 5);
    }
    if (prevPad >= 0) repaintBg(prevPad - 1, PADDLE_Y - 1,
                                PADDLE_W + 2, PADDLE_H + 2);
    for (var i = 0; i < pops.length; i++) {
        var p = pops[i];
        repaintBg(p.x - 8, p.y - 8, p.w + 16, p.h + 16);
    }
}

function drawObjects() {
    drawPaddle();
    drawBall();
    drawPops();
    prevBall.x = ball.x;
    prevBall.y = ball.y;
    prevPad = paddleX;
}

// ------------------------------------------------------------------ telas ----
function drawDeco() {
    S.fillRect(0, 124, 240, 60, T.bg);
    for (var r = 0; r < 3; r++) {
        for (var c = 0; c < BRICK_COLS; c++) {
            S.fillGradient(BRICK_X + c * BRICK_W, 132 + r * (BRICK_H + 3),
                           BRICK_W - 2, BRICK_H,
                           ROW_COLORS[(r + c) % ROW_COLORS.length],
                           ROW_DARK[(r + c) % ROW_DARK.length], 3);
        }
    }
}

function menu(c) {
    fullFrame = c.full;
    A.style.card(L.x, 16, L.w, 94, { full: c.full, draw: function (r) {
        var cx = r.x + r.w / 2;
        UI.text("BREAKOUT", cx, r.y, { role: "display", align: "center",
                w: r.w, color: T.accent, bg: r.bg });
        UI.text("Quebre os tijolos e não deixe a bola cair", cx, r.y + 30,
                { role: "caption", align: "center", w: r.w, lines: 2,
                  color: T.textDim, bg: r.bg });
        UI.text("Recorde: " + hi, cx, r.y + 64, { role: "body",
                align: "center", w: r.w, color: T.text, bg: r.bg });
    }});
    paint("deco", 0, 124, 240, 60, 1, drawDeco, T.bg);

    if (A.style.button("JOGAR", L.x, 196, L.w, 40)) {
        wantNew = true;
        return "jogo";
    }
    if (A.style.button("Como jogar", L.x, 246, 100, 30,
                       { variant: "secondary" })) return "ajuda";
    UI.text("toque para lançar a bola", 120, 288,
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
    A.style.card(12, 26, 216, 224, { full: c.full, draw: function (r) {
        UI.text("Como jogar", r.x, r.y, { role: "title", color: T.text, bg: r.bg, w: r.w });
        UI.text("Arraste o dedo para mover a raquete. Toque para lançar a bola. " +
                "Quebre todos os tijolos para subir de nível (a bola acelera). " +
                "A cada 500 pontos você ganha uma vida, até cinco. Não deixe a " +
                "bola cair: são três vidas. O recorde fica salvo.",
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
        UI.text("O jogo está congelado.", cx, r.y + 24,
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
        UI.text("FIM DE JOGO", cx, r.y, { role: "title", align: "center",
                w: r.w, color: T.err, bg: r.bg });
        UI.text("Pontos " + score, cx, r.y + 28, { role: "title",
                align: "center", w: r.w, color: T.text, bg: r.bg });
        UI.text("Recorde " + hi, cx, r.y + 48, { role: "caption",
                align: "center", w: r.w, color: T.textDim, bg: r.bg });
        if (novoRec) {
            UI.text("NOVO RECORDE!", cx, r.y + 64, { role: "caption",
                    align: "center", w: r.w, color: T.ok, bg: r.bg });
        }
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
        lastNow = nowMs;
    }
    var dt = lastNow ? (nowMs - lastNow) / 1000 : 0.016;
    lastNow = nowMs;
    if (dt < 0.001) dt = 0.001;
    if (dt > 0.05) dt = 0.05;

    var show = (over && nowMs - overAt >= 700);
    showResult = show;
    var overlay = paused || showResult;

    // HUD
    UI.text("Pontos " + score, L.x, 4, { role: "title", color: T.text, id: 71 });
    UI.text("Nível " + level, L.x, 22, { role: "caption",
                                         color: T.accent, id: 72 });
    UI.text("Vidas " + lives + "  Rec " + hi, L.x + L.w - 32, 22,
            { role: "caption", align: "right", w: 110,
              color: T.textDim, id: 73 });

    if (!overlay && !over) {
        if (A.widgets.iconButton("menu", L.x + L.w - 26, 4, 26)) {
            paused = true;
            pops.length = 0;
            UI.invalidate();
            overlay = true;
        }
    }

    // arrasto/launch (so no campo; nao roubar o toque do HUD)
    if (!overlay && !over) {
        var t = UI.touch();
        if (t.down && t.y >= FY) {
            clampPaddle(t.x);
            if (serving) {
                ball.x = paddleX + PADDLE_W / 2;
                ball.y = PADDLE_Y - BALL_R - 1;
            }
        }
        if (t.released && t.y >= FY && serving) {
            launch();
            UI.invalidate();
        }
        if (serving) {
            ball.x = paddleX + PADDLE_W / 2;
            ball.y = PADDLE_Y - BALL_R - 1;
        }
    }

    if (!overlay) stepPhysics(dt);
    if (over) show = (nowMs - overAt >= 700);

    // campo: fundo/tijolos na area pintada; bola/raquete por cima
    var flash = (nowMs - flashAt < 300);
    var levelFlash = (nowMs - levelAt < 400);
    var fsig = fieldVer + (serving ? "s" : "p") +
               ((flash || levelFlash) ? ":" + nowMs : "");
    if (overlay) {
        if (c.full) {
            paint("field", 0, FY, 240, 320 - FY, fsig, drawBg, T.bg);
            prevBall.x = -1;
            prevPad = -1;
            drawObjects();
        }
    } else {
        var bg = paint("field", 0, FY, 240, 320 - FY, fsig, drawBg, T.bg);
        if (!bg && !c.full) erasePrev();
        drawObjects();
        if (flash) S.drawRect(FX + 1, FY + 1, FW - 2, L.bottom - FY - 2, T.err);
        if (levelFlash) {
            S.drawRect(FX + 1, FY + 1, FW - 2, L.bottom - FY - 2, T.warn);
            S.drawRect(FX + 2, FY + 2, FW - 4, L.bottom - FY - 4, T.warn);
        }
    }

    if (paused) {
        var pa = drawPause(c);
        if (pa === "resume") {
            paused = false;
            lastNow = nowMs;
            UI.invalidate();
        } else if (pa === "restart") {
            paused = false;
            newGame();
            lastNow = nowMs;
            UI.invalidate();
        } else if (pa === "quit") {
            paused = false;
            return A.BACK;
        }
        return;
    }
    if (show) {
        var ra = drawResult(c);
        if (ra === "again") {
            newGame();
            lastNow = nowMs;
            UI.invalidate();
        } else if (ra === "menu") {
            return A.BACK;
        }
    }
}
jogo.fps = 30;

A.run({ menu: menu, ajuda: ajuda, jogo: jogo }, "menu");
