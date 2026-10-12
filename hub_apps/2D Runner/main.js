// Neon Surfer (2D Runner) — corrida infinita em 3 faixas. Porte CelerGame:
// cenas do core (menu/ajustes/jogo/fim com transicoes), gestos pelo
// E.input, recorde no NVS e fx — rastro na hoverboard, estouro na moeda,
// flash + iris na batida. Primitivas 22 (gradiente, pecas suavizadas,
// drawWideLine nas bordas neon) seguem as mesmas.

var E = require("celeros.game");       // familia CelerGame: core + fx
require("celeros.game.fx");

E.init({ dir: "2D Runner", fps: 60, save: "surfer." });
var T = E.theme, W = E.W, H = E.H;

var ROAD_X = 20, ROAD_W = 200;          // pista com 3 faixas de ~66 px
var LANE_W = ROAD_W / 3;
var LANES = [ROAD_X + LANE_W / 2, ROAD_X + 3 * LANE_W / 2, ROAD_X + 5 * LANE_W / 2];
var HUD_H = 34;

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

// Som: System.sfx (API 32) mistura o efeito por cima da trilha e NAO trava
// o loop do jogo; firmware antigo cai no playTone (bloqueante)
var somFn = typeof System.sfx === "function" ? System.sfx :
            (typeof System.playTone === "function" ? System.playTone : null);
function tone(hz, ms) { if (somFn) { try { somFn([[hz, ms]]); } catch (e) {} } }
function tune(notes) { if (somFn) { try { somFn(notes); } catch (e) {} } }

// ---------------------------------------------------------------- estado ---
var showFPS = false;
var showTemp = false;

var playerLane, playerY, playerBob, playerX;   // playerX anima a troca
var score, speed, distance, entities, spawnT, newRecord;
var rastro = null;

var BTN_JOGAR = { x: 40, y: 190, w: 160, h: 48 };
var BTN_AJ = { x: 40, y: 246, w: 160, h: 44 };
var BTN_DNV = { x: 40, y: 200, w: 160, h: 48 };
var BTN_MENU = { x: 40, y: 256, w: 160, h: 44 };

function resetGame() {
    playerLane = 1;
    playerX = LANES[1];
    playerY = 262;
    playerBob = 0;
    score = 0;
    speed = 150;
    distance = 0;
    entities = [];
    spawnT = 0;
    newRecord = false;
}

function saveHi() {
    if (score > hi) {
        hi = score;
        newRecord = true;
        E.save.set("hi", hi);
        tune([[784, 80], [1047, 110]]);
    }
}

// ------------------------------------------------------------- simulacao ---
function update(dt) {
    var move = speed * dt;
    distance += move;
    playerBob = Math.sin(System.millis() / 150.0) * 5;

    // troca de faixa suave (interp para o centro da faixa alvo)
    var target = LANES[playerLane];
    playerX += (target - playerX) * Math.min(1, dt * 14);
    if (Math.abs(target - playerX) < 0.5) playerX = target;

    spawnT += dt;
    var rate = Math.max(0.2, 1.0 - speed / 1000.0);
    if (spawnT > rate) {
        spawnT = 0;
        var lane = Math.floor(Math.random() * 3);
        if (lane > 2) lane = 2;
        if (Math.random() > 0.3) {
            entities.push({ type: "train", lane: lane, y: -100, h: 80 });
        } else {
            entities.push({ type: "coin", lane: lane, y: -20, h: 20 });
        }
    }

    var px = playerX - 15, pw = 30, py = playerY - 20 + playerBob, ph = 40;
    for (var i = entities.length - 1; i >= 0; i--) {
        var e = entities[i];
        e.y += move;
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
                tone(150, 250);
                saveHi();
                E.fx.burst(playerX, playerY, { n: 22, color: T.err, colors: [T.err, T.warn],
                                               speed: 140, life: 0.7, grav: 160 });
                E.fx.flash(T.err, 250);
                E.goto("fim", { transition: "iris", ms: 500 });
                return;
            }
        } else if (py < e.y + 10 && py + ph > e.y - 10) {
            score += 50;
            tone(988, 40);
            E.fx.burst(LANES[e.lane], e.y, { n: 8, color: T.warn, speed: 70,
                                             life: 0.4, size: 2 });
            E.fx.popText(LANES[e.lane], e.y - 6, "+50", { color: T.warn, life: 0.6 });
            entities.splice(i, 1);
        }
    }
    speed += dt * 5.0;
}

// ---------------------------------------------------------------- desenho ---
function drawScene() {
    E.gfx.rect(0, 0, W, H, T.bg, { screen: true });

    // ceu neon: gradiente escuro a trevas acima da pista
    E.gfx.gradient(0, 0, W, HUD_H, T.raised, T.bg, { screen: true });
    E.gfx.rect(ROAD_X - 12, HUD_H, ROAD_W + 24, H - HUD_H,
               System.mixColor(T.bg, T.raised, 45), { screen: true });

    // bordas neon com brilho (linha grossa + fina clara)
    E.gfx.line(ROAD_X - 8, HUD_H, ROAD_X - 8, H, T.accentD, { w: 3, screen: true });
    E.gfx.line(ROAD_X - 8, HUD_H, ROAD_X - 8, H, T.accent, { screen: true });
    E.gfx.line(ROAD_X + ROAD_W + 8, HUD_H, ROAD_X + ROAD_W + 8, H, T.accentD, { w: 3, screen: true });
    E.gfx.line(ROAD_X + ROAD_W + 8, HUD_H, ROAD_X + ROAD_W + 8, H, T.accent, { screen: true });

    // tracinhos entre faixas rolando com a distancia
    var off = Math.floor(distance) % 44;
    for (var y = -44; y < H; y += 44) {
        var ry = y + off;
        if (ry < HUD_H || ry > H - 18) continue;
        E.gfx.rect(ROAD_X + LANE_W - 2, ry, 4, 22, T.stroke, { r: 2, screen: true });
        E.gfx.rect(ROAD_X + 2 * LANE_W - 2, ry, 4, 22, T.stroke, { r: 2, screen: true });
    }

    // entidades
    for (var i = 0; i < entities.length; i++) {
        var e = entities[i];
        var ex = LANES[e.lane];
        if (e.type === "train") {
            E.gfx.rect(ex - 28, e.y, 56, e.h, T.err, { r: 8, screen: true });
            E.gfx.rect(ex - 22, e.y + 6, 44, 16, T.onAccent, { r: 4, screen: true });
            E.gfx.rect(ex - 20, e.y + e.h - 14, 40, 4, T.warn, { screen: true });
        } else {
            E.gfx.circle(ex, e.y, 12, T.warn, { smooth: true, screen: true });
            E.gfx.circle(ex - 3, e.y - 3, 5, System.mixColor(T.warn, T.text, 40),
                         { smooth: true, screen: true });
        }
    }

    // hoverboard do jogador
    var pxx = playerX, pyy = playerY + playerBob;
    E.gfx.circle(pxx, pyy + 22, 10, T.accentD, { smooth: true, screen: true });   // sombra/glow
    E.gfx.circle(pxx, pyy + 22, 6, T.accent, { smooth: true, screen: true });
    E.gfx.rect(pxx - 15, pyy - 18, 30, 40, T.accent, { r: 9, screen: true });
    E.gfx.rect(pxx - 9, pyy - 12, 18, 12, T.onAccent, { r: 5, screen: true });
    E.gfx.circle(pxx, pyy + 4, 4, T.text, { smooth: true, screen: true });

    E.fx.draw();

    // HUD (drawString direto: muda todo frame)
    E.gfx.rect(0, 0, W, HUD_H, T.raised, { screen: true });
    System.drawFastHLine(0, HUD_H - 1, W, T.stroke);
    E.gfx.text("Pontos " + score, 10, 8, { ts: "body", bg: T.raised });
    E.gfx.text("Rec " + hi, W - 10, 12, { ts: "small", align: "right", bg: T.raised,
                                          color: newRecord ? T.ok : T.textDim });
    if (showFPS) {
        E.gfx.text(E.fps + " fps", 108, 12, { ts: "small", color: T.textDim, bg: T.raised });
    }
    if (showTemp && typeof System.getTemperature === "function") {
        try {
            E.gfx.text(System.getTemperature().toFixed(0) + "\u00B0C", 152, 12,
                       { ts: "small", color: T.textDim, bg: T.raised });
        } catch (err) {}
    }
}

// ------------------------------------------------------------------ cenas ---
E.run({
    menu: {
        static: true,
        update: function () {
            if (E.hit(BTN_JOGAR)) { E.goto("jogo", { transition: "wipe", ms: 300 }); }
            else if (E.hit(BTN_AJ)) E.goto("ajustes", { transition: "fade", ms: 250 });
        },
        draw: function () {
            E.gfx.text("NÉON", W / 2, 70, { ts: "huge", align: "center", color: T.accent });
            E.gfx.text("SURFER", W / 2, 112, { ts: "huge", align: "center" });
            E.gfx.rect(12, 150, E.gfx.measure("recorde " + hi, { ts: "small" }) + 12, 18,
                       T.accentD, { r: 9 });
            E.gfx.text("recorde " + hi, 18, 153, { ts: "small", color: T.text });
            E.gfx.button("JOGAR", BTN_JOGAR.x, BTN_JOGAR.y, BTN_JOGAR.w, BTN_JOGAR.h);
            E.gfx.button("Ajustes", BTN_AJ.x, BTN_AJ.y, BTN_AJ.w, BTN_AJ.h, { primary: false });
            E.gfx.text("toque ou deslize para trocar de faixa", W / 2, 300,
                       { ts: "small", align: "center", color: T.textDim });
        }
    },

    ajustes: {
        static: true,
        update: function () {
            if (E.input.tap && E.input.tap.x < 40 && E.input.tap.y < 40) {
                E.goto("menu", { transition: "fade", ms: 250 });
                return;
            }
            var t = E.input.tap;
            if (t && t.y > 80 && t.y < 108 && t.x > 160) showFPS = !showFPS;
            if (t && t.y > 120 && t.y < 148 && t.x > 160) showTemp = !showTemp;
        },
        draw: function () {
            E.gfx.button("<", 2, 2, 36, 36, { primary: false });
            E.gfx.text("Ajustes", 46, 10, { ts: "title" });
            E.gfx.text("mostrar", 16, 66, { ts: "big" });
            E.gfx.text("contador de FPS", 16, 90, { ts: "body" });
            E.gfx.rect(180, 82, 40, 22, showFPS ? T.accent : T.stroke, { r: 11 });
            E.gfx.circle(showFPS ? 208 : 192, 93, 8, showFPS ? T.onAccent : T.textDim,
                         { smooth: true });
            E.gfx.text("temperatura do chip", 16, 130, { ts: "body" });
            E.gfx.rect(180, 122, 40, 22, showTemp ? T.accent : T.stroke, { r: 11 });
            E.gfx.circle(showTemp ? 208 : 192, 133, 8, showTemp ? T.onAccent : T.textDim,
                         { smooth: true });
            E.gfx.text("os ajustes não são salvos", W / 2, 300,
                       { ts: "small", align: "center", color: T.textDim });
        }
    },

    jogo: {
        enter: function () {
            resetGame();
            // rastro neon que segue a prancha (fonte parada nao deixa nada)
            rastro = E.fx.trail(function () { return { x: playerX, y: playerY + playerBob + 26 }; },
                                 { rate: 26, life: 0.35, size: 3, color: T.accent });
        },
        exit: function () { if (rastro) rastro.stop(); },
        update: function (dt) {
            var i = E.input;
            if (i.tap) {
                // toque seco: lado da tela move a faixa
                if (i.tap.x < W / 2) { if (playerLane > 0) { playerLane--; tone(520, 18); } }
                else { if (playerLane < 2) { playerLane++; tone(520, 18); } }
            } else if (i.swipe && (i.swipe.dir === "left" || i.swipe.dir === "right")) {
                if (i.swipe.dir === "right") { if (playerLane < 2) { playerLane++; tone(620, 18); } }
                else { if (playerLane > 0) { playerLane--; tone(620, 18); } }
            }
            update(dt);
        },
        draw: function () { drawScene(); }
    },

    fim: {
        static: true,
        update: function () {
            if (E.hit(BTN_DNV)) E.goto("jogo", { transition: "wipe", ms: 300 });
            else if (E.hit(BTN_MENU)) E.goto("menu", { transition: "fade", ms: 300 });
        },
        draw: function () {
            E.gfx.text("BATEU!", W / 2, 70, { ts: "huge", align: "center", color: T.err });
            E.gfx.text("pontos " + score, W / 2, 120, { ts: "title", align: "center" });
            if (newRecord) {
                E.gfx.rect(W / 2 - 44, 143, 88, 20, T.ok, { r: 10 });
                E.gfx.text("novo recorde!", W / 2, 146, { ts: "small", align: "center",
                                                          color: T.onAccent });
            } else {
                E.gfx.rect(W / 2 - 40, 143, 80, 20, T.accentD, { r: 10 });
                E.gfx.text("recorde " + hi, W / 2, 146, { ts: "small", align: "center" });
            }
            E.gfx.button("De novo", BTN_DNV.x, BTN_DNV.y, BTN_DNV.w, BTN_DNV.h);
            E.gfx.button("Menu", BTN_MENU.x, BTN_MENU.y, BTN_MENU.w, BTN_MENU.h,
                         { primary: false });
        }
    }
}, "menu");
