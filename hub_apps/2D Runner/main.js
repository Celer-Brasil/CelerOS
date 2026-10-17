// Neon Surfer (2D Runner) — corrida infinita em 3 faixas. Revamp 2.3:
// titulo, pausa e fim de jogo pela CelerGame UI (celeros.game.ui), fundo em
// 3 camadas procedurais (E.fx.parallax) rolando com a corrida, rastro da
// prancha + escapamento e anel na moeda, sons de tabela no E.audio. A cena
// de jogo continua na camada suja (redraw integral afundava a 8 fps no
// 4848) e a troca de faixa segue decidida no PRESS. ES5 puro (Duktape).

var E = require("celeros.game");       // familia CelerGame: core + fx + spr + ui
require("celeros.game.fx");
require("celeros.game.spr");
require("celeros.game.ui");
var PISTA = require("pista");          // regras de nascimento (fuzz no sdk)

E.init({ dir: "2D Runner", fps: 60, save: "surfer." });
var T = E.theme, W = E.W, H = E.H, S = System;

var ROAD_X = 20, ROAD_W = 200;          // pista com 3 faixas de ~66 px
var LANE_W = ROAD_W / 3;
var LANES = [ROAD_X + LANE_W / 2, ROAD_X + 3 * LANE_W / 2, ROAD_X + 5 * LANE_W / 2];
var HUD_H = 34;
var ROAD_BG = S.mixColor(T.bg, T.raised, 45);

// paleta do fundo: cores derivadas do tema, calculadas 1x (o painter roda a
// cada caixa suja — nada de mixColor por celula/quadro)
var STAR_C = S.mixColor(T.bg, T.text, 60);
var STAR_C2 = S.mixColor(T.bg, T.accent, 45);
var WIN_C = S.mixColor(ROAD_BG, T.accentD, 75);
var WIN_C2 = S.mixColor(ROAD_BG, T.warn, 22);
var GRID_C = S.mixColor(ROAD_BG, T.accent, 22);

// recorde: NVS do core — o valor do appData entra como migacao 1x
// (opcional: sem a perm "fs" o runtime nao registra o objeto FS)
var hi = E.save.num("hi", 0);
var FSx = typeof FS !== "undefined" ? FS : null;
if (FSx) {
    try {
        var rawHi = FSx.readTextFile((FSx.appData ? FSx.appData() : "/local/") + "hi.txt");
        var oldHi = rawHi ? parseInt(rawHi, 10) : 0;
        if (!isNaN(oldHi) && oldHi > hi) { hi = oldHi; E.save.set("hi", hi); }
    } catch (e) {}
}

// Sons: E.audio escolhe sozinho System.sfx (API 32, mistura por cima da
// trilha) ou playTone (firmware antigo). Tabela propria para os eventos do
// jogo; "coin"/"record" ja existem no core e sao redefinidos aqui.
E.audio.sfxTable.lane = [620, 18];
E.audio.sfxTable.coin = [[988, 45], [1319, 70]];
E.audio.sfxTable.crash = [[150, 220], [90, 160]];
E.audio.sfxTable.record = [[784, 70], [1047, 110]];
function sfx(what) { E.audio.sfx(what); }

// ---------------------------------------------------------------- estado ---
// ajustes persistentes (2.1 gravava nada — "os ajustes nao sao salvos")
var showFPS = E.save.num("aj.fps", 0) === 1;
var showTemp = E.save.num("aj.tmp", 0) === 1;

var playerLane, playerY, playerBob, playerX;   // playerX anima a troca
var score, coins, speed, distance, entities, spawnT, newRecord;
var rastro = null, escap = null;
var pausado = false, pressPause = false;
var dlg = null;                                // dialogo do "Como jogar"
var pressT = 0, marco = 0;                     // piso do toque e marco de pontos
var RASTRO = { x: 0, y: 0 };                   // scratch da fonte do rastro
var XAUSTO = { x: 0, y: 0 };                   // scratch do escapamento

var BTN_AJ = { x: W / 2 - 48, y: H - 40, w: 96, h: 26 };
var BTN_PAUSE = { x: W - 34, y: 4, w: 28, h: 26 };
var COMO_JOGAR = "Toque na faixa para onde quer ir ou deslize para os lados. " +
                 "Desvie dos trens, colete as moedas e bata o recorde. " +
                 "A velocidade aumenta com o tempo. O botão de pausa fica no topo.";

function resetGame() {
    playerLane = 1;
    playerX = LANES[1];
    playerY = 262;
    playerBob = 0;
    score = 0;
    coins = 0;
    speed = 150;
    distance = 0;
    entities = [];
    spawnT = 0;
    newRecord = false;
    pressT = 0;
    marco = 0;
    pressPause = false;
}

// ------------------------------------------------------------- sprites -----
// PNG nos slots nativos (drawPNG 1x no load; blit com cor-chave preta);
// sem slots/PNG (CYD) o painter procedural desenha a arte vetorial antiga.
function paintHeroi(w, h, x, y) {
    var cx = x + w / 2, cy = y + h / 2;
    E.gfx.circle(cx, y + h - 5, 10, T.accentD, { smooth: true });
    E.gfx.circle(cx, y + h - 5, 6, T.accent, { smooth: true });
    E.gfx.rect(cx - 13, cy - 18, 26, 34, T.accent, { r: 8 });
    E.gfx.rect(cx - 8, cy - 12, 16, 10, T.onAccent, { r: 4 });
    E.gfx.circle(cx, cy + 3, 4, T.text, { smooth: true });
}
function paintTrem(w, h, x, y) {
    E.gfx.rect(x + 2, y, w - 4, h, T.err, { r: 8 });
    E.gfx.rect(x + 8, y + 6, w - 16, 16, T.onAccent, { r: 4 });
    E.gfx.rect(x + 6, y + h - 16, 12, 8, T.warn);
    E.gfx.rect(x + w - 18, y + h - 16, 12, 8, T.warn);
}
function paintMoeda(w, h, x, y) {
    E.gfx.circle(x + w / 2, y + h / 2, 9, T.warn, { smooth: true });
    E.gfx.circle(x + w / 2 - 2, y + h / 2 - 2, 4,
                 S.mixColor(T.warn, T.text, 40), { smooth: true });
}
function paintCidade(w, h, x, y) {
    var alt = [30, 52, 24, 64, 40, 58, 28, 46];
    for (var i = 0; i < 8; i++) {
        E.gfx.rect(x + i * 30, y + h - alt[i], 26, alt[i], T.accentD);
    }
}
E.spr.load([
    { name: "heroi", file: "heroi", w: 36, h: 48, paint: paintHeroi },
    { name: "trem", file: "trem", w: 56, h: 80, paint: paintTrem },
    { name: "moeda", file: "moeda", w: 20, h: 20, paint: paintMoeda },
    { name: "cidade", file: "cidade", w: 240, h: 76, paint: paintCidade }
]);

// ------------------------------------------------------------- paralaxe ----
// 3 camadas procedurais atras da pista (estrelas, janelas da cidade e grid
// neon). O paint desenha UMA celula em coords de tela com System direto:
// nao registra caixa suja e cabe inteiro na celula, entao o painter da
// camada suja repinta qualquer recorte sem deixar buraco. Nada aloca por
// celula. O E.cam.y e o motor do scroll (a cena nao usa a camera).
function hash2(x, y) {
    var h = (x * 374761393 + y * 668265263) | 0;
    h = ((h ^ (h >> 13)) * 1274126177) | 0;
    return (h ^ (h >> 16)) >>> 0;
}
function paintEstrela(x, y) {
    var k = hash2(x, y);
    if ((k & 3) === 0) return;                 // 1/4 das celulas vazia
    S.fillRect(x + 2 + (k % 30), y + 2 + ((k >> 4) % 30), 1, 1,
               (k & 8) ? STAR_C : STAR_C2);
}
function paintJanela(x, y) {
    var k = hash2(x + 101, y + 57);
    if ((k % 3) !== 0) return;            // 1/3 das celulas acende
    var n = 1 + (k % 2);
    var bx = x + 2 + ((k >> 5) % 36);   // espalha na celula (sem coluna fixa)
    var by = y + 2 + ((k >> 9) % 24);
    for (var i = 0; i < n; i++) {
        S.fillRect(bx, by + i * 6, 3, 3, (i & 1) ? WIN_C : WIN_C2);
    }
}
function paintGrid(x, y) {
    var k = hash2(x + 7, y + 13);
    if ((k & 3) !== 0) return;
    S.fillRect(x + (k % 24), y + ((k >> 6) % 28), 10, 1, GRID_C);
}
var fundo = E.fx.parallax([
    { speed: 0.16, gap: 36, rowH: 36, paint: paintEstrela },
    { speed: 0.34, gap: 44, rowH: 44, paint: paintJanela },
    { speed: 0.62, gap: 40, rowH: 40, paint: paintGrid }
]);

// ------------------------------------------------------------- simulacao ---
function move(dir) {
    var nl = playerLane + dir;
    if (nl < 0 || nl > 2) return;
    playerLane = nl;
    sfx("lane");
}

// faixa mais proxima do x tocado (limites no meio das faixas 0|1 e 1|2)
function laneAt(x) { return x < 87 ? 0 : (x < 153 ? 1 : 2); }

function update(dt) {
    var move_ = speed * dt;
    distance += move_;
    playerBob = Math.sin(S.millis() / 150.0) * 5;
    E.cam.y = -distance;   // so o parallax usa a camera (o draw zera o mundo)

    // troca de faixa suave (interp para o centro da faixa alvo)
    var target = LANES[playerLane];
    playerX += (target - playerX) * Math.min(1, dt * 14);
    if (Math.abs(target - playerX) < 0.5) playerX = target;

    spawnT += dt;
    var rate = Math.max(0.24, 1.0 - speed / 1000.0);
    if (spawnT > rate) {
        spawnT = 0;
        // justica do nascimento vive no pista.js (I1 espaco na mesma faixa,
        // I2 teia entre faixas vizinhas, I3 moeda alcancavel, I4 saturacao
        // desiste): o que sai daqui e sempre passavel
        var n = PISTA.nascer(entities, { speed: speed, hudH: HUD_H });
        if (n) {
            if (n.type === "fileira") {
                for (var c = 0; c < 3; c++) {
                    entities.push({ type: "coin", lane: n.lane, y: n.y - c * 30 });
                }
            } else {
                entities.push(n);
            }
        }
    }

    var px = playerX - 15, pw = 30, py = playerY - 20 + playerBob, ph = 40;
    for (var i = entities.length - 1; i >= 0; i--) {
        var e = entities[i];
        e.y += move_;
        if (e.y > H + 20) {
            entities.splice(i, 1);
            if (e.type === "train") score += 5;
            continue;
        }
        // colisao por proximidade de faixa (a troca em curso conta)
        var near = Math.abs(LANES[e.lane] - playerX) < LANE_W / 2;
        if (!near) continue;
        if (e.type === "train") {
            if (py < e.y + e.h && py + ph > e.y) {
                sfx("crash");
                if (score > hi) { hi = score; newRecord = true; E.save.set("hi", hi); }
                if (newRecord) sfx("record");
                E.fx.ring(playerX, playerY, { color: T.err, r0: 8, speed: 220, life: 0.5 });
                E.fx.burst(playerX, playerY, { n: 22, color: T.err, colors: [T.err, T.warn],
                                               speed: 140, life: 0.7, grav: 160 });
                E.fx.flash(T.err, 250);
                E.goto("fim", { transition: "iris", ms: 500 });
                return;
            }
        } else if (py < e.y + 10 && py + ph > e.y - 10) {
            score += 50;
            coins++;
            sfx("coin");
            E.fx.burst(LANES[e.lane], e.y, { n: 8, color: T.warn, speed: 70,
                                             life: 0.4, size: 2 });
            E.fx.ring(LANES[e.lane], e.y, { color: T.warn, r0: 4, speed: 90, life: 0.35 });
            E.fx.popText(LANES[e.lane], Math.max(HUD_H + 6, e.y - 6), "+50",
                         { color: T.warn, life: 0.6 });
            entities.splice(i, 1);
        }
    }
    speed += dt * 5.0;
}

// ---------------------------------------------------------------- desenho ---
// painter da camada suja: repita o CENARIO fixo (ceu, manto da estrada,
// parallax, bordas neon) so dentro da caixa pedida — tracinhos, entidades,
// heroi e fx se apagam sozinhos entre quadros. O parallax vem DEPOIS do
// manto da pista para as camadas aparecerem tambem dentro dela (cor sutil,
// nunca atrapalha a leitura das faixas).
function paintRoad(x, y, w, h) {
    S.fillRect(x, y, w, h, T.bg);
    var rx = ROAD_X - 12, rw = ROAD_W + 24;
    var ix = Math.max(x, rx), ix2 = Math.min(x + w, rx + rw);
    if (ix2 > ix) S.fillRect(ix, y, ix2 - ix, h, ROAD_BG);
    fundo.draw(x, y, w, h);
    if (y < HUD_H + 12 && y + h > HUD_H) {
        S.fillGradient(x, HUD_H, w, 12, T.raised, ROAD_BG);
    }
    for (var k = 0; k < 2; k++) {
        var bx = k === 0 ? ROAD_X - 8 : ROAD_X + ROAD_W + 8;
        if (bx + 2 > x && bx - 2 < x + w) {
            S.fillRect(bx - 2, y, 4, h, T.accentD);
            S.fillRect(bx - 1, y, 1, h, T.accent);
        }
    }
}

// HUD fora da camada suja (as caixas do jogo nao sobem alem do HUD) e com
// memo: so repinta quando um valor muda, quando o botao de pausa muda de
// estado OU quando algo tocou a faixa dele (o repaint do fim do veu de
// transicao cobre a faixa com o fundo — sem isso os restos do wipe/iris
// ficavam em cima do placar ate o proximo ponto)
var hudS = -1, hudF = -1, hudH = -1, hudT = -1, hudP = false;
function drawHud(force) {
    var t10 = 0;
    if (showTemp && typeof S.getTemperature === "function") {
        try { t10 = Math.round(S.getTemperature() * 10); } catch (err) {}
    }
    var f = showFPS ? E.fps : 0;
    var pOn = E.press(BTN_PAUSE);
    if (!force && !pOn && pOn === hudP && score === hudS && f === hudF &&
        hi === hudH && t10 === hudT && !E.dirty.touches(0, 0, W, HUD_H)) return;
    hudS = score; hudF = f; hudH = hi; hudT = t10; hudP = pOn;
    var on = E.dirty.on;
    E.dirty.on = false;
    E.gfx.rect(0, 0, W, HUD_H, T.raised, { screen: true });
    S.drawFastHLine(0, HUD_H - 1, W, T.stroke);
    E.gfx.text("Pontos " + score, 10, 8, { ts: "body", bg: T.raised, screen: true });
    E.gfx.text("Rec " + hi, W - 42, 12, { ts: "small", align: "right", bg: T.raised,
                                          color: newRecord ? T.ok : T.textDim, screen: true });
    // botao de pausa no canto direito do HUD (alvo de 28x26, folga no dedo)
    E.gfx.rect(BTN_PAUSE.x, BTN_PAUSE.y, BTN_PAUSE.w, BTN_PAUSE.h,
               pOn ? T.accent : T.accentD, { r: 7, screen: true });
    E.gfx.rect(BTN_PAUSE.x + 9, BTN_PAUSE.y + 7, 3, 12,
               pOn ? T.onAccent : T.text, { screen: true });
    E.gfx.rect(BTN_PAUSE.x + 16, BTN_PAUSE.y + 7, 3, 12,
               pOn ? T.onAccent : T.text, { screen: true });
    // leituras de diagnostico na 2a linha do HUD (a 1a e do placar/recorde;
    // o canto direito e do botao de pausa)
    var tx = 10;
    if (showFPS) { E.gfx.text(f + " fps", tx, 21, { ts: "small", color: T.textDim,
                                                    bg: T.raised, screen: true }); tx = 62; }
    if (showTemp && t10 > 0) {
        E.gfx.text((t10 / 10).toFixed(0) + "\u00B0C", tx, 21,
                   { ts: "small", color: T.textDim, bg: T.raised, screen: true });
    }
    E.dirty.on = on;
}

var DASH_O = { r: 2, screen: true };   // scratch: 12 dashes x quadro sem alocar
function drawJogo() {
    // a camera so move o parallax; o mundo e desenhado em coords de tela
    var camx = E.cam.x, camy = E.cam.y;
    E.cam.x = 0; E.cam.y = 0;
    // tracinhos entre faixas rolando com a distancia (dinamicos)
    var off = Math.floor(distance) % 44;
    for (var y = -44; y < H; y += 44) {
        var ry = y + off;
        if (ry < HUD_H + 8 || ry > H - 18) continue;
        E.gfx.rect(ROAD_X + LANE_W - 2, ry, 4, 22, T.stroke, DASH_O);
        E.gfx.rect(ROAD_X + 2 * LANE_W - 2, ry, 4, 22, T.stroke, DASH_O);
    }
    // entidades (sprites com cor-chave; painters de fallback sem slot)
    for (var i = 0; i < entities.length; i++) {
        var e = entities[i];
        if (e.type === "train") E.spr.blit("trem", LANES[e.lane] - 28, e.y);
        else E.spr.blit("moeda", LANES[e.lane] - 10, e.y - 10 + Math.round(Math.sin((distance + e.y) / 18) * 2));
    }
    // heroi
    E.spr.blit("heroi", Math.round(playerX) - 18, Math.round(playerY - 24 + playerBob));
    E.fx.draw();
    E.cam.x = camx; E.cam.y = camy;
}

// liga/desliga os emissores com a pausa (pausado tambem congela o rastro)
function fxFonte(on) {
    if (!rastro) return;
    if (on) { rastro.start(); if (escap) escap.start(); }
    else { rastro.stop(); if (escap) escap.stop(); }
}

// camada suja + HUD do jogo (entrada, retomada e recomeco)
function armaJogo() {
    E.dirty.enable(paintRoad);
    // o apagar/redesenho do mundo nao invade o HUD
    E.dirty.clip(0, HUD_H, W, H - HUD_H);
    hudS = -1; hudP = false;
    drawHud(true);
}

function pausar() {
    pausado = true;
    E.dirty.off();          // congela o quadro atual (o veu cobre tudo)
    fxFonte(false);
    sfx("ui");
}

function retomar() {
    pausado = false;
    fxFonte(true);
    armaJogo();
}

// ------------------------------------------------------------------ cenas ---
E.run({
    menu: {
        static: true,       // vira false enquanto o dialogo datilografa
        fps: 30,
        enter: function () {
            dlg = null;
            this.static = true;
            E.cam.x = 0;
            E.cam.y = 0;
        },
        update: function () {
            // o dialogo revela o texto no draw: precisa de quadro por quadro
            if (dlg && !dlg.closed) E.redraw();
        },
        draw: function () {
            E.gfx.gradient(0, 0, W, H, T.raised, T.bg, { screen: true });
            fundo.draw();                       // parallax atras do titulo
            E.spr.blit("cidade", 0, H - 76);
            var act = E.ui.title({ game: "NEON SURFER", subtitle: "corra, desvie, colete",
                                   best: hi, extra: "Como jogar" });
            E.gfx.button("Ajustes", BTN_AJ.x, BTN_AJ.y, BTN_AJ.w, BTN_AJ.h,
                         { primary: false, screen: true });
            if (!dlg) {
                if (act === "start") {
                    E.goto("jogo", { transition: "fade", ms: 400 });
                    return;
                }
                if (act === "extra") {
                    dlg = E.ui.dialog(COMO_JOGAR, { name: "COMO JOGAR", speed: 45 });
                    this.static = false;
                    sfx("ui");
                } else if (E.hit(BTN_AJ)) {
                    E.goto("ajustes", { transition: "wipe", ms: 250 });
                    return;
                }
            }
            if (dlg) {
                // veu do modal do titulo para baixo (o painel do dialogo nao
                // deixa os botoes do titulo aparecerem por baixo; o nome do
                // jogo, acima, continua visivel)
                E.gfx.rect(0, 96, W, H - 96, T.bg, { screen: true });
                if (!dlg.draw(18, 100, 204)) {
                    dlg = null;
                    this.static = true;
                    E.redraw();
                }
            }
        }
    },

    ajustes: {
        static: true,
        fps: 30,
        update: function () {
            if (E.input.tap && E.input.tap.x < 40 && E.input.tap.y < 40) {
                E.goto("menu", { transition: "wipe", ms: 250 });
                return;
            }
            var t = E.input.tap;
            if (t && t.y > 80 && t.y < 108 && t.x > 160) {
                showFPS = !showFPS;
                E.save.set("aj.fps", showFPS ? 1 : 0);
                E.redraw();
            }
            if (t && t.y > 120 && t.y < 148 && t.x > 160) {
                showTemp = !showTemp;
                E.save.set("aj.tmp", showTemp ? 1 : 0);
                E.redraw();
            }
        },
        draw: function () {
            E.gfx.rect(0, 0, W, H, T.bg, { screen: true });
            E.gfx.button("<", 2, 2, 36, 36, { primary: false, screen: true });
            E.gfx.text("Ajustes", 46, 10, { ts: "title", screen: true });
            E.gfx.text("mostrar", 16, 66, { ts: "big", screen: true });
            E.gfx.text("contador de FPS", 16, 90, { ts: "body", screen: true });
            E.gfx.rect(180, 82, 40, 22, showFPS ? T.accent : T.stroke, { r: 11, screen: true });
            E.gfx.circle(showFPS ? 208 : 192, 93, 8, showFPS ? T.onAccent : T.textDim,
                         { smooth: true, screen: true });
            E.gfx.text("temperatura do chip", 16, 130, { ts: "body", screen: true });
            E.gfx.rect(180, 122, 40, 22, showTemp ? T.accent : T.stroke, { r: 11, screen: true });
            E.gfx.circle(showTemp ? 208 : 192, 133, 8, showTemp ? T.onAccent : T.textDim,
                         { smooth: true, screen: true });
            E.gfx.text("ajustes salvos no aparelho", W / 2, 300,
                       { ts: "small", align: "center", color: T.textDim, screen: true });
        }
    },

    jogo: {
        fps: 60,
        enter: function () {
            resetGame();
            pausado = false;
            E.cam.x = 0;
            E.cam.y = 0;
            armaJogo();
            // rastro neon que segue a prancha (fonte parada nao deixa nada;
            // posicao em scratch — o follow rodava 26x/s e alocava um objeto
            // por chamada) + emissor continuo do escapamento (rate baixo)
            rastro = E.fx.trail(function () {
                RASTRO.x = playerX;
                RASTRO.y = playerY + playerBob + 26;
                return RASTRO;
            }, { rate: 26, life: 0.35, size: 3, color: T.accent });
            escap = E.fx.emitter({
                rate: 9, life: 0.3, size: 2, color: T.accentD,
                speed: 25, speed2: 65, angle: Math.PI / 2, spread: 0.6, grav: 50,
                follow: function () {
                    XAUSTO.x = playerX;
                    XAUSTO.y = playerY + playerBob + 20;
                    return XAUSTO;
                }
            });
        },
        exit: function () {
            if (rastro) { rastro.stop(); rastro.dead = true; rastro = null; }
            if (escap) { escap.stop(); escap.dead = true; escap = null; }
            pausado = false;
            E.dirty.off();
        },
        update: function (dt) {
            if (pausado) {
                this.fps = 20;      // o veu parado nao precisa de 60 fps
                return;             // pausado congela a simulacao
            }
            this.fps = 60;
            var i = E.input;
            if (i.justDown) {
                pressT = S.millis();
                pressPause = i.y < HUD_H;   // toque comecou no HUD
            } else if (i.justUp && !i.moved) {
                if (pressPause) {
                    if (E.hit(BTN_PAUSE)) { pausar(); return; }
                } else if (S.millis() - pressT >= 40) {
                    // toque seco: um passo NA DIRECAO da faixa tocada. Decidido
                    // na liberacao (posicao final do dedo: a 1a amostra do touch
                    // bateria e movia pro lado errado) e com piso de 40 ms
                    // (raspao/injecao nao move)
                    var alvo = laneAt(i.x);
                    if (alvo > playerLane) move(1);
                    else if (alvo < playerLane) move(-1);
                }
            } else if (i.swipe && !pressPause) {
                if (i.swipe.dir === "left") move(-1);
                else if (i.swipe.dir === "right") move(1);
            }
            update(dt);
            // marco a cada 1000 pontos: popText + fanfarra curta
            var m = Math.floor(score / 1000);
            if (m > marco) {
                marco = m;
                E.fx.popText(W / 2, HUD_H + 20, (m * 1000) + "!",
                             { color: T.accent, life: 0.8 });
                sfx("ok");
            }
            drawHud(false);
        },
        draw: function () {
            if (pausado) {
                var act = E.ui.pause({ title: "PAUSA",
                                       labels: ["Continuar", "Recomecar", "Sair"] });
                if (act === "resume") { retomar(); sfx("ui"); }
                else if (act === "restart") {
                    resetGame();
                    pausado = false;
                    fxFonte(true);
                    armaJogo();
                    sfx("ui");
                } else if (act === "quit") {
                    pausado = false;
                    E.goto("menu", { transition: "wipe", ms: 300 });
                }
                return;
            }
            drawJogo();
        }
    },

    fim: {
        static: true,
        fps: 30,
        draw: function () {
            var act = E.ui.gameOver({ title: "BATEU", score: score, best: hi,
                                      isNew: newRecord });
            if (act === "again") E.goto("jogo", { transition: "wipe", ms: 300 });
            else if (act === "quit") E.goto("menu", { transition: "wipe", ms: 300 });
        }
    }
}, "menu");
