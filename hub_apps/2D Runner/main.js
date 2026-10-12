// Neon Surfer (2D Runner) — corrida infinita em 3 faixas. Revamp 2.2:
// sprites text2d (heroi/trem/moeda + titulo/cidade do menu) nos slots
// nativos com painter procedural de fallback, cena de jogo na camada suja
// (o redraw integral de 2.0 afundava a 8 fps no 4848 e o poll de toque
// engolia os toques), troca de faixa no PRESS (resposta imediata) e
// ajustes persistentes. ES5 puro (Duktape).

var E = require("celeros.game");       // familia CelerGame: core + fx + spr
require("celeros.game.fx");
require("celeros.game.spr");
var PISTA = require("pista");          // regras de nascimento (fuzz no sdk)

E.init({ dir: "2D Runner", fps: 60, save: "surfer." });
var T = E.theme, W = E.W, H = E.H, S = System;

var ROAD_X = 20, ROAD_W = 200;          // pista com 3 faixas de ~66 px
var LANE_W = ROAD_W / 3;
var LANES = [ROAD_X + LANE_W / 2, ROAD_X + 3 * LANE_W / 2, ROAD_X + 5 * LANE_W / 2];
var HUD_H = 34;
var ROAD_BG = S.mixColor(T.bg, T.raised, 45);

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
var somFn = typeof S.sfx === "function" ? S.sfx :
            (typeof S.playTone === "function" ? S.playTone : null);
function tone(hz, ms) { if (somFn) { try { somFn([[hz, ms]]); } catch (e) {} } }
function tune(notes) { if (somFn) { try { somFn(notes); } catch (e) {} } }

// ---------------------------------------------------------------- estado ---
// ajustes persistentes (2.1 gravava nada — "os ajustes nao sao salvos")
var showFPS = E.save.num("aj.fps", 0) === 1;
var showTemp = E.save.num("aj.tmp", 0) === 1;

var playerLane, playerY, playerBob, playerX;   // playerX anima a troca
var score, coins, speed, distance, entities, spawnT, newRecord;
var rastro = null;
var pressT = 0, marco = 0;                     // piso do toque e marco de pontos
var RASTRO = { x: 0, y: 0 };                   // scratch da fonte do rastro

var BTN_JOGAR = { x: 40, y: 216, w: 160, h: 46 };
var BTN_AJ = { x: 40, y: 268, w: 160, h: 36 };
var BTN_DNV = { x: 40, y: 208, w: 160, h: 46 };
var BTN_MENU = { x: 40, y: 260, w: 160, h: 36 };

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
function paintTitulo(w, h, x, y) {
    E.gfx.text("NEON", x + w / 2, y + 14, { ts: "huge", align: "center", color: T.accent });
    E.gfx.text("SURFER", x + w / 2, y + 44, { ts: "huge", align: "center" });
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
    { name: "titulo", file: "titulo", w: 232, h: 84, paint: paintTitulo },
    { name: "cidade", file: "cidade", w: 240, h: 76, paint: paintCidade }
]);

// ------------------------------------------------------------- simulacao ---
function move(dir) {
    var nl = playerLane + dir;
    if (nl < 0 || nl > 2) return;
    playerLane = nl;
    tone(dir > 0 ? 620 : 520, 18);
}

// faixa mais proxima do x tocado (limites no meio das faixas 0|1 e 1|2)
function laneAt(x) { return x < 87 ? 0 : (x < 153 ? 1 : 2); }

function update(dt) {
    var move_ = speed * dt;
    distance += move_;
    playerBob = Math.sin(S.millis() / 150.0) * 5;

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
                tone(150, 250);
                if (score > hi) { hi = score; newRecord = true; E.save.set("hi", hi); }
                if (newRecord) tune([[784, 80], [1047, 110]]);
                E.fx.burst(playerX, playerY, { n: 22, color: T.err, colors: [T.err, T.warn],
                                               speed: 140, life: 0.7, grav: 160 });
                E.fx.flash(T.err, 250);
                E.goto("fim", { transition: "iris", ms: 500 });
                return;
            }
        } else if (py < e.y + 10 && py + ph > e.y - 10) {
            score += 50;
            coins++;
            tone(988, 40);
            E.fx.burst(LANES[e.lane], e.y, { n: 8, color: T.warn, speed: 70,
                                             life: 0.4, size: 2 });
            E.fx.popText(LANES[e.lane], Math.max(HUD_H + 6, e.y - 6), "+50",
                         { color: T.warn, life: 0.6 });
            entities.splice(i, 1);
        }
    }
    speed += dt * 5.0;
}

// ---------------------------------------------------------------- desenho ---
// painter da camada suja: repita o CENARIO fixo (ceu, manto da estrada,
// bordas neon) so dentro da caixa pedida — tracinhos, entidades, heroi e
// fx se apagam sozinhos entre quadros
function paintRoad(x, y, w, h) {
    S.fillRect(x, y, w, h, T.bg);
    var rx = ROAD_X - 12, rw = ROAD_W + 24;
    var ix = Math.max(x, rx), ix2 = Math.min(x + w, rx + rw);
    if (ix2 > ix) S.fillRect(ix, y, ix2 - ix, h, ROAD_BG);
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
// memo: so repinta quando um valor muda OU quando algo tocou a faixa dele
// (o repaint do fim do veu de transicao cobre a faixa com o fundo — sem
// isso os restos do wipe/iris ficavam em cima do placar ate o proximo
// ponto)
var hudS = -1, hudF = -1, hudH = -1, hudT = -1;
function drawHud(force) {
    var t10 = 0;
    if (showTemp && typeof S.getTemperature === "function") {
        try { t10 = Math.round(S.getTemperature() * 10); } catch (err) {}
    }
    var f = showFPS ? E.fps : 0;
    if (!force && score === hudS && f === hudF && hi === hudH && t10 === hudT &&
        !E.dirty.touches(0, 0, W, HUD_H)) return;
    hudS = score; hudF = f; hudH = hi; hudT = t10;
    var on = E.dirty.on;
    E.dirty.on = false;
    E.gfx.rect(0, 0, W, HUD_H, T.raised, { screen: true });
    S.drawFastHLine(0, HUD_H - 1, W, T.stroke);
    E.gfx.text("Pontos " + score, 10, 8, { ts: "body", bg: T.raised });
    E.gfx.text("Rec " + hi, W - 10, 12, { ts: "small", align: "right", bg: T.raised,
                                          color: newRecord ? T.ok : T.textDim });
    var tx = 108;
    if (showFPS) { E.gfx.text(f + " fps", tx, 12, { ts: "small", color: T.textDim, bg: T.raised }); tx += 42; }
    if (showTemp && t10 > 0) {
        E.gfx.text((t10 / 10).toFixed(0) + "\u00B0C", tx, 12, { ts: "small", color: T.textDim, bg: T.raised });
    }
    E.dirty.on = on;
}

var DASH_O = { r: 2, screen: true };   // scratch: 12 dashes x quadro sem alocar
function drawJogo() {
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
}

// ------------------------------------------------------------------ cenas ---
E.run({
    menu: {
        static: true,
        update: function () {
            if (E.hit(BTN_JOGAR)) { E.goto("jogo", { transition: "wipe", ms: 300 }); }
            else if (E.hit(BTN_AJ)) E.goto("ajustes", { transition: "wipe", ms: 250 });
        },
        draw: function () {
            E.gfx.gradient(0, 0, W, H, T.raised, T.bg, { screen: true });
            E.spr.blit("titulo", 4, 4);
            E.gfx.text("NEON SURFER", W / 2, 90, { ts: "title", align: "center",
                                                  color: T.text });
            E.spr.blit("cidade", 0, 110);
            var rw = E.gfx.measure("recorde " + hi, { ts: "small" }) + 16;
            E.gfx.rect(W / 2 - rw / 2, 194, rw, 20, T.accentD, { r: 10 });
            E.gfx.text("recorde " + hi, W / 2, 197, { ts: "small", align: "center",
                                                      color: T.text });
            E.gfx.button("JOGAR", BTN_JOGAR.x, BTN_JOGAR.y, BTN_JOGAR.w, BTN_JOGAR.h);
            E.gfx.button("Ajustes", BTN_AJ.x, BTN_AJ.y, BTN_AJ.w, BTN_AJ.h, { primary: false });
            E.gfx.text("toque na faixa ou deslize para desviar", W / 2, 306,
                       { ts: "small", align: "center", color: T.textDim });
        }
    },

    ajustes: {
        static: true,
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
            E.gfx.text("ajustes salvos no aparelho", W / 2, 300,
                       { ts: "small", align: "center", color: T.textDim });
        }
    },

    jogo: {
        enter: function () {
            resetGame();
            hudS = -1;
            E.dirty.enable(paintRoad);   // 1o quadro: cenario inteiro
            // o apagar/redesenho do mundo nao invade o HUD
            E.dirty.clip(0, HUD_H, W, H - HUD_H);
            drawHud(true);
            // rastro neon que segue a prancha (fonte parada nao deixa
            // nada; posicao em scratch — o follow rodava 26x/s e alocava
            // um objeto por chamada)
            rastro = E.fx.trail(function () {
                RASTRO.x = playerX;
                RASTRO.y = playerY + playerBob + 26;
                return RASTRO;
            }, { rate: 26, life: 0.35, size: 3, color: T.accent });
        },
        exit: function () {
            if (rastro) rastro.stop();
            E.dirty.off();
        },
        update: function (dt) {
            var i = E.input;
            if (i.justDown) {
                pressT = S.millis();
            } else if (i.justUp && !i.moved) {
                // toque seco: um passo NA DIRECAO da faixa tocada. Decidido
                // na liberacao (posicao final do dedo: a 1a amostra do touch
                // bateria e movia pro lado errado) e com piso de 40 ms
                // (raspao/injecao nao move)
                if (S.millis() - pressT >= 40) {
                    var alvo = laneAt(i.x);
                    if (alvo > playerLane) move(1);
                    else if (alvo < playerLane) move(-1);
                }
            } else if (i.swipe) {
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
                tone(1175, 50);
            }
            drawHud(false);
        },
        draw: function () { drawJogo(); }
    },

    fim: {
        static: true,
        update: function () {
            if (E.hit(BTN_DNV)) E.goto("jogo", { transition: "wipe", ms: 300 });
            else if (E.hit(BTN_MENU)) E.goto("menu", { transition: "wipe", ms: 300 });
        },
        draw: function () {
            E.gfx.gradient(0, 0, W, H, T.raised, T.bg, { screen: true });
            E.gfx.text("BATEU!", W / 2, 58, { ts: "huge", align: "center", color: T.err });
            E.gfx.text("pontos " + score, W / 2, 108, { ts: "title", align: "center" });
            E.gfx.text(Math.floor(distance / 10) + " m percorridos", W / 2, 136,
                       { ts: "small", align: "center", color: T.textDim });
            if (newRecord) {
                E.gfx.rect(W / 2 - 52, 152, 104, 20, T.ok, { r: 10 });
                E.gfx.text("novo recorde!", W / 2, 155, { ts: "small", align: "center",
                                                          color: T.onAccent });
            } else {
                E.gfx.rect(W / 2 - 46, 152, 92, 20, T.accentD, { r: 10 });
                E.gfx.text("recorde " + hi, W / 2, 155, { ts: "small", align: "center" });
            }
            E.gfx.button("De novo", BTN_DNV.x, BTN_DNV.y, BTN_DNV.w, BTN_DNV.h);
            E.gfx.button("Menu", BTN_MENU.x, BTN_MENU.y, BTN_MENU.w, BTN_MENU.h,
                         { primary: false });
        }
    }
}, "menu");
