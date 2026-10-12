// Breakout — quebre os tijolos, arraste a raquete. Porte CelerGame: a
// camada suja E.dirty apaga o rastro da bola/raquete (o painter repinta
// fundo e tijolos so na caixa tocada — antes era fillCircle manual das
// posicoes anteriores), burst/popText na quebra, rastro na bola, flash ao
// perder vida e transicao iris no fim. ES5 puro (Duktape).

var E = require("celeros.game");       // familia CelerGame: core + fx
require("celeros.game.fx");

E.init({ dir: "Breakout", fps: 60, save: "breakout." });
var T = E.theme, W = E.W, H = E.H;

var FX = 4, FY = 44;                 // canto do campo
var FW = W - 2 * FX, FH = H - FY - 2;
var BRICK_COLS = 8, BRICK_ROWS = 5;
var BRICK_W = (FW - 16) / BRICK_COLS;   // 27
var BRICK_H = 12;
var BRICK_TOP = FY + 10;
var PADDLE_W = 48, PADDLE_H = 8, PADDLE_Y = H - 22;
var BALL_R = 3;

var ROW_COLORS = [T.err, T.warn, T.ok, T.accent, T.accentD];
var ROW_POINTS = [50, 40, 30, 20, 10];

// recorde: NVS do core — o valor do arquivo da 1.2 entra como migacao 1x
// (opcional: sem a perm "fs" o runtime nao registra o objeto FS)
var hi = E.save.num("hi", 0);
var FSx = typeof FS !== "undefined" ? FS : null;
if (FSx) {
    try {
        var raw = FSx.readTextFile("/local/config_breakout_hi.txt");
        var old = raw ? parseInt(raw, 10) : 0;
        if (!isNaN(old) && old > hi) { hi = old; E.save.set("hi", old); }
    } catch (e) {}
}

// ------------------------------------------------------------- estado ------
var bricks, score, lives, level, state;   // state: serve|play|levelup|over
var paddleX, ball, speed;
var nextLife = 500;                       // vida extra a cada 500 pts (max 5)
var novoRec = false;
var BTN = { x: 68, y: 196, w: 104, h: 34 };

function buildBricks() {
    bricks = [];
    for (var r = 0; r < BRICK_ROWS; r++) {
        for (var c = 0; c < BRICK_COLS; c++) {
            bricks.push({ x: FX + 8 + c * BRICK_W, y: BRICK_TOP + r * (BRICK_H + 3),
                          r: r, alive: true });
        }
    }
}

function resetBall() {
    state = "serve";
    ball = { x: paddleX + PADDLE_W / 2, y: PADDLE_Y - BALL_R - 1, dx: 0, dy: 0 };
}

function newGame() {
    score = 0;
    lives = 3;
    level = 1;
    speed = 130;
    nextLife = 500;
    novoRec = false;
    paddleX = (W - PADDLE_W) / 2;
    buildBricks();
    resetBall();
}

function launch() {
    // angulo inicial levemente aleatorio para a direita/esquerda
    var ang = (-60 - Math.random() * 60) * Math.PI / 180;   // para cima
    if (Math.random() < 0.5) ang = -ang + Math.PI;
    ball.dx = Math.cos(ang);
    ball.dy = Math.sin(ang);
    state = "play";
}

// ---------------------------------------------------------- fisica (dt s) --
function step(dt) {
    if (state !== "play") return;
    var dist = speed * dt;
    var n = Math.ceil(dist / 3);            // sub-passos anti-tunel
    var sd = dist / n;
    for (var i = 0; i < n; i++) {
        ball.x += ball.dx * sd;
        ball.y += ball.dy * sd;
        collide();
        if (state !== "play") return;
    }
}

function reflectX() { ball.dx = -ball.dx; }
function reflectY() { ball.dy = -ball.dy; }

function brickRect(b) { return { x: b.x, y: b.y, w: BRICK_W - 2, h: BRICK_H }; }

function collide() {
    // paredes
    if (ball.x < FX + BALL_R) { ball.x = FX + BALL_R; reflectX(); }
    if (ball.x > FX + FW - BALL_R) { ball.x = FX + FW - BALL_R; reflectX(); }
    if (ball.y < FY + BALL_R) { ball.y = FY + BALL_R; reflectY(); }

    // raquete: rebote depende do ponto de contato
    if (ball.dy > 0 && ball.y + BALL_R >= PADDLE_Y &&
        ball.y + BALL_R <= PADDLE_Y + PADDLE_H + 6 &&
        ball.x >= paddleX - BALL_R && ball.x <= paddleX + PADDLE_W + BALL_R) {
        ball.y = PADDLE_Y - BALL_R;
        var rel = (ball.x - (paddleX + PADDLE_W / 2)) / (PADDLE_W / 2);  // -1..1
        var ang = rel * 1.1;                                             // rad p/ vertical
        var sp = Math.sqrt(ball.dx * ball.dx + ball.dy * ball.dy);
        ball.dx = sp * Math.sin(ang);
        ball.dy = -Math.abs(sp * Math.cos(ang));
    }

    // tijolos
    for (var i = 0; i < bricks.length; i++) {
        var b = bricks[i];
        if (!b.alive) continue;
        if (ball.x + BALL_R < b.x || ball.x - BALL_R > b.x + BRICK_W ||
            ball.y + BALL_R < b.y || ball.y - BALL_R > b.y + BRICK_H) continue;
        b.alive = false;
        score += ROW_POINTS[b.r];
        if (score >= nextLife && lives < 5) {
            lives++;
            nextLife += 500;
        }
        // juice: estouro na cor da fileira + pontos flutuando; a caixa suja
        // da particula ja apaga o tijolo quebrado (o painter nao o repinta)
        var bc = brickRect(b);
        E.fx.burst(bc.x + bc.w / 2, bc.y + bc.h / 2,
                   { n: 10, color: ROW_COLORS[b.r], speed: 80, life: 0.4, size: 2 });
        E.fx.popText(bc.x + bc.w / 2, bc.y, "+" + ROW_POINTS[b.r],
                     { color: ROW_COLORS[b.r], life: 0.6 });
        // reflete no eixo de menor penetracao
        var cx = (b.x + BRICK_W / 2) - ball.x;
        var cy = (b.y + BRICK_H / 2) - ball.y;
        var ox = (BRICK_W / 2 + BALL_R) - Math.abs(cx);
        var oy = (BRICK_H / 2 + BALL_R) - Math.abs(cy);
        if (ox < oy) reflectX(); else reflectY();
        if (levelCleared()) {
            level++;
            speed += 22;
            score += 100;
            state = "levelup";
            E.fx.popText(W / 2, 152, "Nível " + level + "!", { color: T.warn, life: 1.2 });
            E.after(900, function () {
                buildBricks();
                resetBall();
                E.dirty.full();
            });
        }
        break;
    }

    // fundo: perde vida
    if (ball.y > H + 8) {
        lives--;
        E.fx.flash(T.err, 200);
        if (lives <= 0) {
            state = "over";
            if (E.save.best("hi", score)) novoRec = score > 0;
            hi = Math.max(hi, score);
            E.goto("fim", { transition: "iris", ms: 450 });
            return;
        }
        resetBall();
    }
}

function levelCleared() {
    for (var i = 0; i < bricks.length; i++) if (bricks[i].alive) return false;
    return true;
}

// ------------------------------------------------------------- desenho -----
// painter da camada suja: repinta o FUNDO (bg + moldura + tijolos vivos)
// so dentro da caixa pedida — o rastro da bola/raquete/particulas apaga
// sozinho e os tijolos voltam intactos
function paintField(x, y, w, h) {
    System.fillRect(x, y, w, h, T.bg);
    var x2 = x + w, y2 = y + h;
    for (var i = 0; i < bricks.length; i++) {
        var b = bricks[i];
        if (!b.alive) continue;
        var bx = b.x, by = b.y, bw = BRICK_W - 2;
        if (bx >= x2 || bx + bw <= x || by >= y2 || by + BRICK_H <= y) continue;
        System.fillGradient(bx, by, bw, BRICK_H, ROW_COLORS[b.r],
                            System.mixColor(ROW_COLORS[b.r], 0, 35), 3);
    }
    // moldura do campo quando a caixa toca as bordas
    if (x <= FX + 2 || x2 >= FX + FW - 2 || y <= FY + 2 || y2 >= FY + FH - 2) {
        System.drawRect(FX, FY, FW, FH, T.stroke);
    }
}

var hudKey = -1;   // score*1000 + lives*100 + level*10 + stateCode
function hudCode() { return score * 1000 + lives * 100 + level * 10 + (state === "serve" ? 1 : 0); }

function drawHeader() {
    // faixa acima do campo: pintada FORA da camada suja (as caixas do jogo
    // nao sobem alem do FY; registrar aqui faria o painter apagar o placar)
    var on = E.dirty.on;
    E.dirty.on = false;
    E.gfx.rect(0, 0, W, 40, T.card, { screen: true });
    E.gfx.text("Pontos " + score, 10, 4, { ts: "title", bg: T.card });
    E.gfx.text("Vidas " + lives + "  ·  Rec " + hi, W - 10, 6,
               { ts: "small", align: "right", color: T.textDim, bg: T.card });
    E.gfx.text("Nível " + level + (state === "serve" ? "  ·  toque para lançar" : ""),
               10, 24, { ts: "small", color: T.accent, bg: T.card });
    E.gfx.rect(0, 40, W, 2, T.accent, { screen: true });
    E.dirty.on = on;
}

// ------------------------------------------------------------------ cenas ---
E.run({
    jogo: {
        enter: function () {
            newGame();
            E.dirty.enable(paintField);   // 1o quadro: campo inteiro
            // o apagar/redesenho do mundo nao sobe alem do placar: sem o
            // recorte, o repaint integral do 1o quadro (e de cada full,
            // ex. nivel novo) apagava o cabecalho pintado no update — ele
            // so reaparecia no proximo ponto
            E.dirty.clip(0, 42, W, H - 42);
            hudKey = -1;
            drawHeader();
        },
        update: function (dt) {
            // arrasto da raquete (serve acompanha a bola na saida)
            var i = E.input;
            if (i.down) {
                var nx = i.x - PADDLE_W / 2;
                if (nx < FX + 1) nx = FX + 1;
                if (nx > FX + FW - PADDLE_W - 1) nx = FX + FW - PADDLE_W - 1;
                paddleX = nx;
                if (state === "serve") ball.x = paddleX + PADDLE_W / 2;
            } else if (i.justUp && state === "serve") {
                launch();
            }
            step(dt);
            // placar so quando muda, ou quando algo tocou a faixa dele
            // (repaint integral do fim do veu, flash de tela cheia — o
            // memo so de valores deixava restos na faixa de cima)
            var k = hudCode();
            if (k !== hudKey || E.dirty.touches(0, 0, W, 42)) {
                hudKey = k;
                if (state !== "over") drawHeader();
            }
        },
        draw: function () {
            // so o que se MEXE entra na camada suja (tijolos ficam no painter)
            var by = state === "levelup" ? PADDLE_Y - BALL_R - 1 : ball.y;
            if (state !== "over") {
                E.gfx.circle(ball.x, by, BALL_R, T.text, { smooth: true });
                // gradiente cru como o original (dir 4) + caixa na camada
                if (E.dirty.on) E.dirty.add(paddleX, PADDLE_Y, PADDLE_W, PADDLE_H);
                System.fillGradient(paddleX, PADDLE_Y, PADDLE_W, PADDLE_H,
                                    T.accent, T.accentD, 4);
            }
            E.fx.draw();
        },
        exit: function () { E.dirty.off(); }
    },

    fim: {
        static: true,
        update: function () {
            if (E.hit(BTN)) { E.goto("jogo", { transition: "wipe", ms: 300 }); }
        },
        draw: function () {
            E.gfx.text("Fim de jogo", W / 2, 128,
                       { ts: "title", align: "center", color: T.err });
            E.gfx.text("Pontos: " + score + "   Recorde: " + hi, W / 2, 160,
                       { ts: "body", align: "center" });
            if (novoRec) E.gfx.text("NOVO RECORDE!", W / 2, 182,
                                    { ts: "label", align: "center", color: T.ok });
            E.gfx.button("Jogar de novo", BTN.x, BTN.y + 20, BTN.w, BTN.h);
        }
    }
}, "jogo");
