// Breakout — quebre os tijolos, arraste a raquete. Porte CelerGame: a
// camada suja E.dirty apaga o rastro da bola/raquete (o painter repinta
// fundo e tijolos so na caixa tocada), burst/popText na quebra e agora
// rastro E.fx.trail na bola, anel E.fx.ring no tijolo e flash ao perder
// vida. Titulo, pausa e fim de jogo pela celeros.game.ui. ES5 puro (Duktape).

var E = require("celeros.game");       // familia CelerGame: core + fx + ui
require("celeros.game.fx");
require("celeros.game.ui");

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

// sons do jogo na tabela do core: paddle/brick/lose/win/record
// (E.audio.sfx escolhe a tabela; caps.speaker falso = no-op em placa muda)
E.audio.sfxTable.paddle = [240, 45];
E.audio.sfxTable.brick = [[740, 30], [990, 45]];
E.audio.sfxTable.lose = [[320, 90], [200, 160]];
E.audio.sfxTable.win = [[523, 80], [659, 80], [784, 150]];
E.audio.sfxTable.record = [[659, 60], [784, 60], [988, 60], [1319, 180]];

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
var paused = false, pauseAct = null;      // menu de pausa (acao do draw)
var overAct = null;                       // menu de fim (acao do draw)
var PB = { x: W - 28, y: 3, w: 22, h: 18 };   // botao de pausa no HUD
var help = null;                          // dialogo retido do "Como jogar"
var HELP_TXT = "Arraste o dedo para mover a raquete. Toque para lançar a bola. " +
               "Quebre todos os tijolos para subir de nível. A cada 500 pontos " +
               "você ganha uma vida. Não deixe a bola cair!";

// rastro curto da bola: parado/serve/pausa nao semeia (follow devolve null)
var trail = E.fx.trail(function () {
    if (state !== "play" || paused) return null;
    return { x: ball.x, y: ball.y };
}, { rate: 30, life: 0.35, size: 2, color: T.textDim });
trail.stop();

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
        E.audio.sfx("paddle");
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
        // juice: estouro na cor da fileira + anel + pontos flutuando; a
        // caixa suja da particula ja apaga o tijolo (o painter nao o repinta)
        var bc = brickRect(b);
        E.fx.burst(bc.x + bc.w / 2, bc.y + bc.h / 2,
                   { n: 10, color: ROW_COLORS[b.r], speed: 80, life: 0.4, size: 2 });
        E.fx.ring(bc.x + bc.w / 2, bc.y + bc.h / 2,
                  { r0: 4, speed: 160, color: ROW_COLORS[b.r], life: 0.35 });
        E.fx.popText(bc.x + bc.w / 2, bc.y, "+" + ROW_POINTS[b.r],
                     { color: ROW_COLORS[b.r], life: 0.6 });
        E.audio.sfx("brick");
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
            E.audio.sfx("win");
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
        E.audio.sfx("lose");
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
    E.gfx.text("Nível " + level, 10, 24,
               { ts: "small", color: T.accent, bg: T.card });
    E.gfx.text("Vidas " + lives + "  ·  Rec " + hi, W - 10, 25,
               { ts: "small", align: "right", color: T.textDim, bg: T.card });
    // botao de pausa: card arredondado + duas barras (sem glifo/emoji)
    E.gfx.rect(PB.x, PB.y, PB.w, PB.h, T.raised, { r: 5, screen: true });
    E.gfx.rect(PB.x + 6, PB.y + 5, 3, PB.h - 10, T.accent, { screen: true });
    E.gfx.rect(PB.x + PB.w - 9, PB.y + 5, 3, PB.h - 10, T.accent, { screen: true });
    E.gfx.rect(0, 40, W, 2, T.accent, { screen: true });
    E.dirty.on = on;
}

// ------------------------------------------------------------------ cenas ---
E.run({
    titulo: {
        draw: function () {
            E.gfx.rect(0, 0, W, H, T.bg, { screen: true });
            // faixa de tijolos decorativa no rodape (identidade do jogo)
            var dy = H - 58;
            for (var r = 0; r < 3; r++) {
                for (var c = 0; c < BRICK_COLS; c++) {
                    E.gfx.rect(FX + 8 + c * BRICK_W, dy + r * (BRICK_H + 3),
                               BRICK_W - 2, BRICK_H,
                               ROW_COLORS[(r + c) % ROW_COLORS.length], { screen: true });
                }
            }
            var act = E.ui.title({ game: "BREAKOUT", best: hi, extra: "Como jogar" });
            if (help) {
                if (!help.draw(15, H * 0.42, W - 30)) help = null;
                return;
            }
            if (act === "start" || (!act && E.input.tap)) {
                // toque fora dos botoes tambem comeca: o titulo e a unica
                // cena antes do jogo (nada de tela morta no primeiro toque)
                E.goto("jogo", { transition: "fade", ms: 300 });
            } else if (act === "extra") {
                help = E.ui.dialog(HELP_TXT, { name: "Como jogar", speed: 40 });
            }
        }
    },

    jogo: {
        enter: function () {
            newGame();
            paused = false;
            pauseAct = null;
            trail.start();
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
            if (paused) {
                var act = pauseAct;
                pauseAct = null;
                if (act === "resume") {
                    paused = false;
                    trail.start();
                } else if (act === "restart") {
                    paused = false;
                    trail.start();
                    newGame();
                    hudKey = -1;
                    E.dirty.full();
                } else if (act === "quit") {
                    paused = false;
                    trail.stop();
                    E.goto("titulo", { transition: "fade", ms: 300 });
                    return;
                } else {
                    return;   // menu aberto: update congelado
                }
            }
            // botao de pausa no HUD
            if (E.hit(PB)) {
                paused = true;
                pauseAct = null;
                trail.stop();
                return;
            }
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
            if (paused) {
                // veu de pausa por cima do jogo congelado; solta o recorte
                // para o veu cobrir tambem a faixa do HUD
                E.dirty.unclip();
                var act = E.ui.pause({ title: "PAUSA" });
                if (act) pauseAct = act;
                return;
            }
            // so o que se MEXE entra na camada suja (tijolos ficam no painter)
            var by = state === "levelup" ? PADDLE_Y - BALL_R - 1 : ball.y;
            if (state === "serve") {
                // dica dentro do campo (a camada suja apaga quando o jogo anda)
                E.gfx.text("toque para lançar", W / 2, PADDLE_Y - 26,
                           { ts: "small", align: "center", color: T.textDim, screen: true });
            }
            if (state !== "over") {
                E.gfx.circle(ball.x, by, BALL_R, T.text, { smooth: true });
                // gradiente cru como o original (dir 4) + caixa na camada
                if (E.dirty.on) E.dirty.add(paddleX, PADDLE_Y, PADDLE_W, PADDLE_H);
                System.fillGradient(paddleX, PADDLE_Y, PADDLE_W, PADDLE_H,
                                    T.accent, T.accentD, 4);
            }
            E.fx.draw();
        },
        exit: function () {
            paused = false;
            trail.stop();
            E.dirty.off();
        }
    },

    fim: {
        enter: function () {
            overAct = null;
            if (novoRec) E.audio.sfx("record");
        },
        update: function () {
            if (overAct === "again") {
                overAct = null;
                E.goto("jogo", { transition: "wipe", ms: 300 });
            } else if (overAct === "quit") {
                overAct = null;
                E.goto("titulo", { transition: "fade", ms: 300 });
            }
        },
        draw: function () {
            var act = E.ui.gameOver({
                title: "FIM DE JOGO", score: score, best: hi, isNew: novoRec,
                labels: ["Jogar de novo", "Sair"]
            });
            if (act) overAct = act;
        }
    }
}, "titulo");
