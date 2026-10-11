// Quica — jogo de exemplo da familia CelerGame (criado com `celer.js new --game`).
// Segure as bolas no ar com a raquete (arraste o dedo): cada rebatida vale
// 1 ponto, bolas novas entram a cada poucos segundos e 3 perdidas encerram.
//
// E um tour pela engine: cenas (titulo/jogo/fim), input (tap/drag), particulas,
// audio e recorde no NVS. Use como base do seu jogo — sprites PNG entram com
// a dep celeros.game.spr (E.spr.load), grade de cenario com celeros.game.tilemap.
//
// FISICA DE ARCADE NAO PRECISA DE ENGINE: sao 4 bolas, uma raquete e quatro
// paredes — pools pre-alocados + reflexao na mao custam nada e nao geram
// lixo pro GC do Duktape. Quando o jogo pedir mais (cordas/panos: P.verletFast;
// empilhamento com rotacao: P.rigid — nativos em System.verlet*/System.rigid*),
// ai sim declare a dep celeros.physics no app.json. Veja a "escada de fisica"
// no Game Engine Guide.
//
// Boas praticas de render (core 1.0): menus sao cenas `static` (desenham
// 1x e so repintam no press de botao), o jogo liga a camada suja E.dirty
// (cada quadro apaga so o que o anterior desenhou — nada de fillScreen por
// frame) e o texto vai por papel (ts: "title", "label"...) ou px, nunca
// size cru: a escala acompanha a tela (E.u / E.U).
// A familia CelerGame e DEP do app.json (instalada pelo hub em
// /local/modules — sem copia dentro do jogo): este exemplo adota o core +
// fx; cada modulo a mais e uma dep a mais no app.json.

var E = require("celeros.game");
require("celeros.game.fx");

E.init({ dir: "{{APP_NAME}}", fps: 30, save: "quica." });
var W = E.W, H = E.H;
var T = E.theme;

var GRAV = 220;          // px/s^2 — mesma conta que a fisica antiga fazia
var PADDLE_W = 64, PADDLE_H = 10, PADDLE_Y = H - 22;

// --------------------------------------------- estado do jogo corrente ---
var g = {
    balls: [],                       // pool: {x, y, vx, vy, r} (sem alocar por quadro)
    paddleX: 0,
    score: 0, lives: 3, spawnIn: 0, newBest: false
};

// estado exposto ao harness (testes/CI); no aparelho __harness nao existe
if (typeof __harness !== "undefined") __harness.quica = { g: g, E: E };

function novaBola() {
    g.balls.push({
        x: E.m.rand(40, W - 40), y: 24, r: 7,
        vx: E.m.rand(-70, 70), vy: 60
    });
}

// Um passo de fisica de bola: gravidade, paredes laterais/teto e raquete.
// A raquete e testada por travessia (a bola cruzou o topo entre um quadro e
// o outro?) — bullet-proof contra tunelamento, sem sub-passos.
function stepBola(b, dt) {
    b.vy += GRAV * dt;
    b.x += b.vx * dt;
    var y0 = b.y;
    b.y += b.vy * dt;

    if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
    else if (b.x + b.r > W) { b.x = W - b.r; b.vx = -Math.abs(b.vx); }
    if (b.y - b.r < 0) { b.y = b.r; b.vy = Math.abs(b.vy); }

    // raquete: a bola cruzou a face de cima dentro da largura?
    var top = PADDLE_Y - PADDLE_H / 2;
    if (y0 + b.r <= top && b.y + b.r > top &&
        Math.abs(b.x - g.paddleX) <= PADDLE_W / 2 + b.r) {
        b.y = top - b.r;
        b.vy = -Math.abs(b.vy) - 40;   // sempre sai pra cima
        return true;                    // rebateu!
    }
    return false;
}

function resetJogo() {
    g.balls = [];
    g.paddleX = W / 2;
    g.score = 0;
    g.lives = 3;
    g.spawnIn = 4;
    g.newBest = false;
    novaBola();
}

// ------------------------------------------------------------- cenas -----
E.run({
    titulo: {
        static: true,   // desenha 1x; repinta sozinha so no press dos botoes
        enter: function () {
            E.cam.reset();
        },
        update: function () {
            if (E.hit(this.btnJogar)) { E.audio.sfx("ok"); E.goto("jogo"); }
            else if (E.hit(this.btnSair)) System.exitApp();
        },
        draw: function () {
            System.fillScreen(T.bg);
            E.gfx.text("QUICA", W / 2, 64, { ts: "huge", align: "center", color: T.accent });
            E.gfx.text("segure as bolas com a raquete", W / 2, 112,
                       { align: "center", color: T.textDim, ts: "small", fit: W - 16 });
            this.btnJogar = E.gfx.button("JOGAR", W / 2 - 70, 156, 140, 44);
            this.btnSair = E.gfx.button("SAIR", W / 2 - 70, 212, 140, 36,
                                        { primary: false });
        }
    },

    jogo: {
        enter: function () {
            resetJogo();
            E.dirty.enable(T.bg);   // apaga so o que mudou (1o quadro: tudo)
        },
        update: function (dt) {
            // raquete segue o dedo (arraste em qualquer lugar da tela)
            if (E.input.down) {
                g.paddleX = E.m.clamp(E.input.x, PADDLE_W / 2 + 4, W - PADDLE_W / 2 - 4);
            }
            // bolas novas entram cada vez mais rapido
            g.spawnIn -= dt;
            if (g.spawnIn <= 0 && g.balls.length < 4) {
                novaBola();
                g.spawnIn = Math.max(2.5, 6 - g.score * 0.15);
            }
            for (var k = g.balls.length - 1; k >= 0; k--) {
                var b = g.balls[k];
                if (stepBola(b, dt)) {
                    g.score++;
                    E.fx.burst(b.x, b.y, { n: 10, color: T.accent, speed: 90, life: 0.5 });
                    E.fx.popText(b.x, b.y - 14, "+1", { color: T.accent });
                    E.audio.sfx("coin");
                }
                // bola perdida: caiu alem da raquete
                if (b.y - b.r > H + 20) {
                    g.balls.splice(k, 1);
                    g.lives--;
                    E.audio.sfx("bad");
                    E.cam.shake(4, 0.25);
                    E.fx.flash(T.err, 120);
                    if (g.lives <= 0) {
                        g.newBest = E.save.best("recorde", g.score);
                        E.goto("fim");
                        return;
                    }
                }
            }
        },
        draw: function () {
            // (a engine ja apagou as caixas do quadro anterior)
            for (var k = 0; k < g.balls.length; k++) {
                var b = g.balls[k];
                E.gfx.circle(b.x, b.y, b.r, T.accent);
                E.gfx.circle(b.x - 2, b.y - 2, 2, T.onAccent);
            }
            E.gfx.rect(g.paddleX - PADDLE_W / 2, PADDLE_Y - PADDLE_H / 2,
                       PADDLE_W, PADDLE_H, T.text, { r: 5 });
            E.gfx.text(String(g.score), 8, 6, { ts: "big", color: T.text, bg: T.bg });
            for (var l = 0; l < g.lives; l++) {
                E.gfx.circle(W - 14 - l * 16, 14, 5, T.err);
            }
            E.fx.draw();
        }
    },

    fim: {
        static: true,
        enter: function () {
            this.t = 0;
        },
        update: function (dt) {
            this.t += dt;
            if (this.t < 0.4) return;   // engole o tap fantasma do fim
            if (E.hit(this.btnNovo)) { E.audio.sfx("ok"); E.goto("jogo"); }
            else if (E.hit(this.btnSair)) System.exitApp();
        },
        draw: function () {
            System.fillScreen(T.bg);
            E.gfx.panel(W / 2 - 90, 56, 180, 168);
            E.gfx.text("FIM DE JOGO", W / 2, 80,
                       { ts: "big", align: "center", color: T.text });
            E.gfx.text(g.score + " rebatidas", W / 2, 112,
                       { align: "center", color: T.text, ts: "label" });
            if (g.newBest) {
                E.gfx.text("NOVO RECORDE!", W / 2, 134,
                           { align: "center", color: T.warn, ts: "small" });
            } else {
                E.gfx.text("recorde " + E.save.num("recorde", 0), W / 2, 134,
                           { align: "center", color: T.textDim, ts: "small" });
            }
            this.btnNovo = E.gfx.button("DE NOVO", W / 2 - 70, 156, 140, 40);
            this.btnSair = E.gfx.button("SAIR", W / 2 - 70, 204, 140, 34,
                                        { primary: false });
        }
    }
}, "titulo");
