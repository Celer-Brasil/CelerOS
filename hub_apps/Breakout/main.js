// Breakout — quebre os tijolos, arraste a raquete. Porte CelerGame:
// a bola x tijolos/raquete usa E.collide (sweep anti-tunel + rect + push,
// normal em E.collide.normal), o fluxo vive numa E.fsm
// (serve/play/levelup/over) e o jogo avisa por E.events
// ("brick"/"score"/"life"/"level"), com E.ui.toast para nivel/recorde.
// A camada suja E.dirty continua dona do campo: o painter repinta a caixa
// e o fundo AI (ai_bg.png) entra por blitSprite, so na caixa pedida.
// ES5 puro (Duktape).

var E = require("celeros.game");       // familia CelerGame: core + modulos
require("celeros.game.spr");
require("celeros.game.fx");
require("celeros.game.ui");
require("celeros.game.collide");
require("celeros.game.fsm");
require("celeros.game.events");

E.init({ dir: "Breakout", fps: 60, save: "breakout.",
         bases: ["/local/apps/Breakout/", "/sd/apps/Breakout/"] });
var T = E.theme, W = E.W, H = E.H;
var C = E.collide;

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

// ------------------------------------------------------------- fundo AI ----
// ai_bg.png (256x256, piso arcade) vive num slot de sheet; o stamp escala
// uma unica vez para um sprite 240x240, e o painter blita SO a caixa suja.
// Sem slot/clip/blitSprite (firmware velho) fica o fundo chapado de antes.
var BG_S = E.W / 256;
var BG = null;
(function () {
    if (!E.spr || typeof E.spr.sheet !== "function") return;
    try {
        var slots = E.spr.sheet("aibg", {
            file: "ai_bg", w: 256, h: 256,
            regions: { bg: [0, 0, 256, 256] }
        });
        if (!slots || !slots.bg || !slots.bg.id) return;
        if (!E.caps.sprites || !E.caps.clip ||
            typeof System.createSprite !== "function" ||
            typeof System.blitSprite !== "function") return;
        var sz = Math.round(256 * BG_S);
        var id = System.createSprite(sz, sz);
        if (!id) return;
        System.useSprite(id);
        System.fillScreen(0x0000);
        var ok = E.spr.stamp("bg", 0, 0, { scale: BG_S, key: null });
        System.useSprite(0);
        if (!ok) { System.deleteSprite(id); return; }
        BG = { id: id, w: sz, h: sz };
    } catch (e) {
        BG = null;
    }
})();

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
var bricks, score, lives, level, speed;
var paddleX, ball;
var nextLife = 500;                       // vida extra a cada 500 pts (max 5)
var novoRec = false;
var paused = false, pauseAct = null;      // menu de pausa (acao do draw)
var overAct = null;                       // menu de fim (acao do draw)
var PB = { x: W - 28, y: 3, w: 22, h: 18 };   // botao de pausa no HUD
var help = null;                          // dialogo retido do "Como jogar"
var HELP_TXT = "Arraste o dedo para mover a raquete. Toque para lançar a bola. " +
               "Quebre todos os tijolos para subir de nível. A cada 500 pontos " +
               "você ganha uma vida. Não deixe a bola cair!";

var game;                                 // E.fsm do fluxo do jogo

// rastro curto da bola: parado/serve/pausa nao semeia (follow devolve null)
var trail = E.fx.trail(function () {
    if (!game || !game.is("play") || paused) return null;
    return { x: ball.x, y: ball.y };
}, { rate: 30, life: 0.35, size: 2, color: T.textDim });
trail.stop();

// ------------------------------------------------------------- mundo -------
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
    game.go("serve", null, true);         // force: reentra mesmo ja em serve
}

function launch() {
    // angulo inicial levemente aleatorio para a direita/esquerda
    var ang = (-60 - Math.random() * 60) * Math.PI / 180;   // para cima
    if (Math.random() < 0.5) ang = -ang + Math.PI;
    ball.dx = Math.cos(ang);
    ball.dy = Math.sin(ang);
}

function levelCleared() {
    for (var i = 0; i < bricks.length; i++) if (bricks[i].alive) return false;
    return true;
}

// ------------------------------------------------------- formas (collide) --
// a bola e um circulo, mas o sweep da engine trabalha com AABB: a caixa
// de 2r x 2r e a mesma que o jogador ve; raquete/tijolo sao retangulos
function ballRect() {
    return { x: ball.x - BALL_R, y: ball.y - BALL_R, w: BALL_R * 2, h: BALL_R * 2 };
}

function paddleRect() {
    return { x: paddleX, y: PADDLE_Y, w: PADDLE_W, h: PADDLE_H };
}

function brickRect(b) { return { x: b.x, y: b.y, w: BRICK_W - 2, h: BRICK_H }; }

// -------------------------------------------------------------- eventos ----
// "brick": juice + som do tijolo quebrado (quem quebrou ja cuidou do resto)
E.on("brick", function (b) {
    var bc = brickRect(b);
    E.fx.burst(bc.x + bc.w / 2, bc.y + bc.h / 2,
               { n: 10, color: ROW_COLORS[b.r], speed: 80, life: 0.4, size: 2 });
    E.fx.ring(bc.x + bc.w / 2, bc.y + bc.h / 2,
              { r0: 4, speed: 160, color: ROW_COLORS[b.r], life: 0.35 });
    E.fx.popText(bc.x + bc.w / 2, bc.y, "+" + ROW_POINTS[b.r],
                 { color: ROW_COLORS[b.r], life: 0.6 });
    E.audio.sfx("brick");
});

// "score": ponto entra e pode render vida extra (que dispara "life")
E.on("score", function (pts) {
    score += pts;
    while (score >= nextLife && lives < 5) {
        nextLife += 500;
        E.emit("life", 1);
    }
});

// "life": delta de vidas; perder vida pisca e toca o som de queda
E.on("life", function (d) {
    lives += d;
    if (d < 0) {
        E.fx.flash(T.err, 200);
        E.audio.sfx("lose");
    }
});

// "level": aviso que some sozinho (ui 1.2) + som de fase
E.on("level", function (lv) {
    E.ui.toast("Nível " + lv + "!", { color: T.warn });
    E.audio.sfx("win");
});

// ---------------------------------------------------------------- fsm ------
function paddleBounce() {
    ball.y = PADDLE_Y - BALL_R;
    var rel = (ball.x - (paddleX + PADDLE_W / 2)) / (PADDLE_W / 2);  // -1..1
    var ang = rel * 1.1;                                             // rad p/ vertical
    var sp = Math.sqrt(ball.dx * ball.dx + ball.dy * ball.dy);
    ball.dx = sp * Math.sin(ang);
    ball.dy = -Math.abs(sp * Math.cos(ang));
    E.audio.sfx("paddle");
}

function breakBrick(b) {
    b.alive = false;
    E.emit("brick", b);
    E.emit("score", ROW_POINTS[b.r]);
    if (levelCleared()) game.go("levelup");
}

function loseLife() {
    E.emit("life", -1);
    if (lives <= 0) {
        game.go("over");
        return;
    }
    game.go("serve");                     // serve.enter repoe a bola
}

// fisica (dt s): um passo por quadro com sweep; o pedaco restante do
// deslocamento continua depois do rebote (2-3 contatos por quadro no max)
function step(dt) {
    if (!game.is("play")) return;
    var remaining = speed * dt;
    var guard = 0;
    while (remaining > 0.001 && guard++ < 12 && game.is("play")) {
        var vx = ball.dx * remaining, vy = ball.dy * remaining;
        var ar = ballRect();
        var bestT = 2.0, hit = null, hnx = 0, hny = 0, push = null;

        // raquete: so conta descendo (como antes)
        if (vy > 0) {
            var pr = paddleRect();
            var tp = C.sweep(ar, vx, vy, pr);
            if (tp >= 0) {
                if (C.normal.x || C.normal.y) {
                    bestT = tp; hit = "paddle";
                    hnx = C.normal.x; hny = C.normal.y;
                }
            } else if (C.rect(ar, pr)) {
                bestT = 0; hit = "paddle";       // ja dentro: repoem no topo
            }
        }

        // tijolos: sweep pega o mais proximo do quadro; rect+push resolve
        // o caso de ja estar sobreposto (spawn/teleporte/erro de ponto)
        for (var i = 0; i < bricks.length; i++) {
            var b = bricks[i];
            if (!b.alive) continue;
            var br = brickRect(b);
            if (C.rect(ar, br)) {
                var pv = C.push(ar, br);
                if (pv) {
                    bestT = 0; hit = b; push = pv;
                    hnx = pv.x ? (pv.x > 0 ? 1 : -1) : 0;
                    hny = pv.y ? (pv.y > 0 ? 1 : -1) : 0;
                    break;
                }
            }
            var t = C.sweep(ar, vx, vy, br);
            if (t < 0) continue;
            var nx = C.normal.x, ny = C.normal.y;
            if (!nx && !ny) continue;         // encostado e saindo: ignora
            if (t < bestT) {
                bestT = t; hit = b; push = null;
                hnx = nx; hny = ny;
            }
        }

        if (!hit) {                           // sem contato: anda o resto
            ball.x += vx;
            ball.y += vy;
            break;
        }
        if (hit === "paddle") {
            if (bestT > 0) {
                ball.x += vx * bestT;
                ball.y += vy * bestT;
                remaining *= (1 - bestT);
            }
            paddleBounce();
            continue;
        }
        // tijolo: reposiciona (sweep) ou empurra (push) e reflete no eixo
        if (push) {
            ball.x += push.x;
            ball.y += push.y;
        } else {
            ball.x += vx * bestT;
            ball.y += vy * bestT;
            remaining *= (1 - bestT);
        }
        if (hnx) ball.dx = hnx * Math.abs(ball.dx);
        if (hny) ball.dy = hny * Math.abs(ball.dy);
        breakBrick(hit);
        if (!game.is("play")) return;
    }

    // paredes (o campo fechado, como antes)
    if (ball.x < FX + BALL_R) { ball.x = FX + BALL_R; ball.dx = Math.abs(ball.dx); }
    if (ball.x > FX + FW - BALL_R) {
        ball.x = FX + FW - BALL_R;
        ball.dx = -Math.abs(ball.dx);
    }
    if (ball.y < FY + BALL_R) { ball.y = FY + BALL_R; ball.dy = Math.abs(ball.dy); }

    // fundo: perde vida
    if (ball.y > H + 8) loseLife();
}

game = E.fsm(null, {
    serve: {
        enter: function () { resetBall(); },
        draw: function () {
            // dica dentro do campo (a camada suja apaga quando o jogo anda)
            E.gfx.text("toque para lançar", W / 2, PADDLE_Y - 26,
                       { ts: "small", align: "center", color: T.textDim, screen: true });
            drawBall(ball.y);
            drawPaddle();
            E.fx.draw();
        },
        on: {
            launch: function () { launch(); return "play"; }
        }
    },
    play: {
        update: function (m, dt) { step(dt); },
        draw: function () {
            drawBall(ball.y);
            drawPaddle();
            E.fx.draw();
        }
    },
    levelup: {
        enter: function () {
            level++;
            speed += 22;
            E.emit("score", 100);
            E.emit("level", level);
        },
        after: [0.9, "serve"],
        exit: function (m, next) {
            if (next === "serve") {
                buildBricks();
                E.dirty.full();
            }
        },
        draw: function () {
            drawBall(PADDLE_Y - BALL_R - 1);
            drawPaddle();
            E.fx.draw();
        }
    },
    over: {
        enter: function () {
            if (E.save.best("hi", score)) {
                novoRec = score > 0;
                if (novoRec) E.ui.toast("Novo recorde!", { color: T.accent });
            }
            hi = Math.max(hi, score);
            E.goto("fim", { transition: "iris", ms: 450 });
        },
        draw: function () {}
    }
}, "serve");

// ------------------------------------------------------------- desenho -----
function drawBall(y) {
    E.gfx.circle(ball.x, y, BALL_R, T.text, { smooth: true });
}

function drawPaddle() {
    // gradiente cru como o original (dir 4) + caixa na camada suja
    if (E.dirty.on) E.dirty.add(paddleX, PADDLE_Y, PADDLE_W, PADDLE_H);
    System.fillGradient(paddleX, PADDLE_Y, PADDLE_W, PADDLE_H,
                        T.accent, T.accentD, 4);
}

// painter da camada suja: repinta o FUNDO (bg AI + moldura + tijolos vivos)
// so dentro da caixa pedida — o rastro da bola/raquete/particulas apaga
// sozinho e os tijolos voltam intactos
function paintField(x, y, w, h) {
    System.fillRect(x, y, w, h, T.bg);
    if (BG) System.blitSprite(BG.id, x, y, w, h);   // so a caixa (API 34)
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
function hudCode() {
    return score * 1000 + lives * 100 + level * 10 + (game.is("serve") ? 1 : 0);
}

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
                if (game.is("serve")) ball.x = paddleX + PADDLE_W / 2;
            } else if (i.justUp && game.is("serve")) {
                game.send("launch");
            }
            game.update(dt);
            // placar so quando muda, ou quando algo tocou a faixa dele
            // (repaint integral do fim do veu, flash de tela cheia — o
            // memo so de valores deixava restos na faixa de cima)
            var k = hudCode();
            if (k !== hudKey || E.dirty.touches(0, 0, W, 42)) {
                hudKey = k;
                if (!game.is("over")) drawHeader();
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
            game.draw();   // serve/play/levelup desenham bola, raquete e fx
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
