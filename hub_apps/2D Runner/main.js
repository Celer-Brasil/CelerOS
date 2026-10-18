// Neon Surfer (2D Runner) — corrida infinita em 3 faixas. Revamp 2.4:
// arte de IA (atlas 4x4 de 64 px e cidade 256x256) desenhada por
// E.spr.stamp; a cidade e cozida 1x num sprite de tela cheia e o painter
// da camada suja restaura so a caixa pedida (System.blitSprite, API 34) —
// o jogo segue a 60 fps no 4848. Stick inferior do E.pad troca de faixa no
// multitoque; toque na faixa e deslize continuam valendo. A pista nasce de
// padroes do E.gen (scatter de trens + salas/corredores para as moedas,
// com semente) e um drone do E.steer.agent persegue o heroi (seek/evade/
// within). ES5 puro (Duktape).

var E = require("celeros.game");       // familia CelerGame: core + modulos
require("celeros.game.fx");
require("celeros.game.spr");
require("celeros.game.ui");
require("celeros.game.pad");           // stick do 4848 (multitoque)
require("celeros.game.gen");           // padroes de pista/obstaculos
require("celeros.game.steer");         // drone perseguidor
var PISTA = require("pista");          // regras de justica do nascimento

E.init({ dir: "2D Runner", fps: 60, save: "surfer.",
         bases: ["/local/apps/2D Runner/", "/sd/apps/2D Runner/"] });
var T = E.theme, W = E.W, H = E.H, S = System;

var ROAD_X = 20, ROAD_W = 200;          // pista com 3 faixas de ~66 px
var LANE_W = ROAD_W / 3;
var LANES = [ROAD_X + LANE_W / 2, ROAD_X + 3 * LANE_W / 2, ROAD_X + 5 * LANE_W / 2];
var HUD_H = 34;
var ROAD_BG = S.mixColor(T.bg, T.raised, 45);
var AI_KEY = 0xF81F;                    // magenta do fundo do atlas de IA
var PAD_Y = H - 66;                     // faixa inferior do stick

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
E.audio.sfxTable.alerta = [[880, 55], [660, 55], [880, 90]];
function sfx(what) { E.audio.sfx(what); }

// ---------------------------------------------------------------- estado ---
// ajustes persistentes (2.1 gravava nada — "os ajustes nao sao salvos")
var showFPS = E.save.num("aj.fps", 0) === 1;
var showTemp = E.save.num("aj.tmp", 0) === 1;

var playerLane, playerY, playerBob, playerX;   // playerX anima a troca
var score, coins, speed, distance, entities, spawnT, newRecord;
var rastro = null, escap = null;
var pausado = false, pressPause = false, pressPad = false;
var dlg = null;                                // dialogo do "Como jogar"
var pressT = 0, marco = 0;                     // piso do toque e marco de pontos
var RASTRO = { x: 0, y: 0 };                   // scratch da fonte do rastro
var XAUSTO = { x: 0, y: 0 };                   // scratch do escapamento

// pista gerada (E.gen): 10 linhas de 3 faixas; a semente vem do run para
// a mesma partida do emulador reproduzir os mesmos padroes
var PLAN_H = 10;
var rnd = null;                                // E.rng do run (gen + drone)
var planoObs = null, planoCoin = null, planoRow = 0;

// drone perseguidor (E.steer.agent): alvo scratch para nao alocar por
// trem/quadro; AREA_DRONE e o corredor onde ele voa
var drone = null, droneVoo = 0, droneEspera = 10;
var AREA_DRONE = { x: ROAD_X + 4, y: HUD_H + 4, w: ROAD_W - 8, h: H - HUD_H - 8 };
var DRONE_ALVO = { x: 0, y: 0, vx: 0, vy: 0 };

// stick do pad (criado no enter da cena jogo)
var stk = null, stickLock = 0, ultimoStickX = W / 2;

var BTN_AJ = { x: W / 2 - 48, y: H - 40, w: 96, h: 26 };
var BTN_PAUSE = { x: W - 34, y: 4, w: 28, h: 26 };
var COMO_JOGAR = "Toque na faixa para onde quer ir, deslize para os lados ou arraste o " +
                 "stick da faixa de baixo. Desvie dos trens e do drone, colete as moedas " +
                 "e bata o recorde. A velocidade aumenta com o tempo. O botao de pausa " +
                 "fica no topo.";

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
    pressPad = false;
    rnd = E.rng((Math.random() * 2147483647) | 0);
    novoPlano();
    drone = null;
    droneVoo = 0;
    droneEspera = 10;
}

// ------------------------------------------------------------- sprites -----
// Atlas de IA 4x4 de 64 px: ai0 heroi, ai1 trem, ai2 moeda (ai3 e o resto da
// folha fica magenta = vazio). A folha do fundo e um PNG 256x256 com a
// cidade. Os painters procedurais sao o fallback de quando o PNG nao carrega
// (harness/firmware sem drawPNG): E.spr.backed() decide o caminho.
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

// fallback do atlas quando o slot existe mas o firmware nao tem drawSprite:
// desenha a mesma peca (simplificada) escalada na caixa da regiao
function paintAi(nome, x, y, k) {
    var s = 64 * (k || 1), cx = x + s / 2, cy = y + s / 2;
    if (nome === "ai0") {
        S.fillCircle(cx, y + s * 0.9, s * 0.16, T.accentD);
        S.fillCircle(cx, y + s * 0.9, s * 0.09, T.accent);
        S.fillRect(cx - s * 0.2, cy - s * 0.28, s * 0.4, s * 0.52, T.accent);
        S.fillRect(cx - s * 0.12, cy - s * 0.2, s * 0.24, s * 0.16, T.onAccent);
        S.fillCircle(cx, cy + s * 0.04, s * 0.065, T.text);
    } else if (nome === "ai1") {
        S.fillRect(x + s * 0.03, y + s * 0.04, s * 0.94, s * 0.92, T.err);
        S.fillRect(x + s * 0.13, y + s * 0.12, s * 0.74, s * 0.24, T.onAccent);
        S.fillRect(x + s * 0.1, y + s * 0.74, s * 0.19, s * 0.12, T.warn);
        S.fillRect(x + s * 0.71, y + s * 0.74, s * 0.19, s * 0.12, T.warn);
    } else {
        S.fillCircle(cx, cy, s * 0.34, T.warn);
        S.fillCircle(cx - s * 0.03, cy - s * 0.03, s * 0.16,
                     S.mixColor(T.warn, T.text, 40));
    }
}
E.spr.grid("ai", { file: "ai_atlas", cols: 4, rows: 4, tw: 64, th: 64,
                   prefix: "ai", paint: paintAi });
E.spr.sheet("aibg", { file: "ai_bg", w: 256, h: 256,
                      regions: { bg: [0, 0, 256, 256] } });
var temAtlas = E.spr.backed("ai0");
// trem/moeda/heroi JA na escala da tela (spr 1.5 prescale, 1 slot): o
// stamp com escala por quadro era drawSprite afim por entidade a 60 fps
// (~1,25 ms cada no 4848). Sem slot os nomes "@" sao apelidos do original
if (temAtlas && E.spr.prescale) {
    E.spr.prescale([["ai1", 1.25, "@trem"], ["ai2", 0.35, "@moeda"], ["ai0", 0.75, "@heroi"]],
                   { key: AI_KEY, name: "runner_ps" });
}
var _tremO = { key: AI_KEY, ax: 0.5, ay: 0 };
var _centroO = { key: AI_KEY, ax: 0.5, ay: 0.5 };

// Fundo: o PNG da cidade vira UM sprite de tela cheia cozido na entrada
// (2 tiles de 240 px de altura) em vez de reescalar a folha em cada caixa
// suja. O painter restaura so o recorte com System.blitSprite (API 34) ou,
// no firmware anterior, com setClip + pushSprite. Sem PNG/slot, o painter
// cai no fundo chapado e o menu na cidade procedural antiga.
var bgSpr = 0;
function montaFundo() {
    bgSpr = 0;
    if (!E.spr.backed("bg")) return;
    if (typeof S.createSprite !== "function" || typeof S.drawSprite !== "function") return;
    var id = S.createSprite(W, H);
    if (!id) return;
    var on = E.dirty.on;
    E.dirty.on = false;                 // cozimento nao e desenho de quadro
    S.useSprite(id);
    S.fillScreen(T.bg);
    var k = W / 256;
    E.spr.stamp("bg", 0, 0, { scale: k, key: null });
    E.spr.stamp("bg", 0, Math.round(256 * k), { scale: k, key: null });
    S.useSprite(0);
    E.dirty.on = on;
    bgSpr = id;
}
function desenhaFundo(x, y, w, h) {
    if (!bgSpr) return false;
    if (typeof S.blitSprite === "function") {
        S.blitSprite(bgSpr, x, y, w, h);
        return true;
    }
    if (E.caps.clip && typeof S.setClip === "function") {
        S.setClip(x, y, w, h);
        S.useSprite(bgSpr);
        S.pushSprite(0, 0);
        S.useSprite(0);
        // o painter da camada suja ja estava recortado na area de jogo
        if (E.dirty.on) S.setClip(0, HUD_H, W, H - HUD_H);
        else S.clearClip();
        return true;
    }
    return false;
}
montaFundo();

// ------------------------------------------------------------- paralaxe ----
// A cidade de IA substitui as 3 camadas procedurais antigas (estrelas,
// janelas e grid): o fundo agora e uma imagem unica e estatica, repintada
// so nas caixas sujas — nada de hash/celulas por quadro.

// ------------------------------------------------------------ pista gen ---
// Cada plano usa a semente do run: E.gen.scatter espalha os trens numa
// grade 3xPLAN_H e E.gen.rooms gera salas/corredores cujas celulas livres
// viram moedas (E.gen.scatter + findAll). A moeda nunca cai na mesma
// celula/faixa de um trem do plano e o PISTA valida contra o que ja existe
// na pista antes de nascer — sobreposicao impossivel.
function novoPlano() {
    planoObs = E.gen.grid(3, PLAN_H, ".");
    E.gen.scatter(planoObs, "T", 14, { rnd: rnd, on: ".", minDist: 2 });
    var mapa = E.gen.rooms(9, PLAN_H, { rnd: rnd, rooms: 5, min: 2, max: 3, tries: 120 });
    E.gen.scatter(mapa.grid, "c", 9, { rnd: rnd, on: ".", minDist: 2 });
    planoCoin = E.gen.grid(3, PLAN_H, ".");
    var cs = E.gen.findAll(mapa.grid, "c");
    for (var i = 0; i < cs.length; i++) {
        var ln = cs[i].c % 3;
        if (planoObs[cs[i].r][ln] === "T") continue;
        planoCoin[cs[i].r][ln] = "c";
    }
    planoRow = 0;
}

// Uma linha do plano por nascimento: no maximo um trem e uma moeda/fileira,
// com a justica do pista.js (espaco na mesma faixa e teia entre vizinhas).
function nascerDoPlano() {
    if (!planoObs) novoPlano();
    if (planoRow >= PLAN_H) novoPlano();
    var r = planoRow++;
    var cfg = { speed: speed, hudH: HUD_H };
    var tremLane = -1, i;
    for (i = 0; i < 3; i++) {
        if (planoObs[r][i] === "T" && (tremLane < 0 || rnd() < 0.5)) tremLane = i;
    }
    if (tremLane >= 0) {
        var tr = PISTA.trem(entities, tremLane, cfg);
        if (tr) entities.push(tr);
    }
    var yF = HUD_H + 26;
    for (i = 0; i < 3; i++) {
        if (planoCoin[r][i] !== "c") continue;
        if (rnd() < 0.3) {
            if (!PISTA.seguraPraMoeda(entities, i, yF - 60, yF + 20, cfg)) continue;
            for (var c = 0; c < 3; c++) {
                entities.push({ type: "coin", lane: i, y: yF - c * 30 });
            }
        } else {
            if (!PISTA.seguraPraMoeda(entities, i, yF - 20, yF + 20, cfg)) continue;
            entities.push({ type: "coin", lane: i, y: yF });
        }
        break;                          // uma fileira/moeda por linha
    }
}

// ------------------------------------------------------------- drone ------
// Perseguidor do E.steer: seek no heroi, evade dos trens que passam e
// within no corredor da pista. Depois de 14 s ele sobe e sai (o jogador
// ganha um respiro ate o proximo). Aviso pelo fx e som proprio.
function nasceDrone() {
    var ln = Math.floor(rnd() * 3);
    drone = { x: LANES[ln], y: HUD_H - 14, vx: 0, vy: 0, t: 0, fuga: false };
    drone.ag = E.steer.agent(drone, {
        speed: 86 + Math.min(40, score / 250),
        force: 300,
        agility: 5
    });
    E.fx.popText(W / 2, HUD_H + 18, "DRONE!", { color: T.err, life: 1.0 });
    sfx("alerta");
}
function atualizaDrone(dt) {
    if (!drone) {
        droneVoo += dt;
        if (droneVoo > droneEspera && distance > 900) {
            droneVoo = 0;
            droneEspera = 12 + rnd() * 6;
            nasceDrone();
        }
        return false;
    }
    var d = drone, i, e;
    d.t += dt;
    if (d.t > 14) {
        // fim da perseguicao: sobe reto e libera a tela
        if (!d.fuga) { d.fuga = true; d.ag.stop(); }
        d.x += d.vx * dt;
        d.y -= 170 * dt;
        if (d.y < HUD_H - 30) drone = null;
    } else {
        d.ag.seek(playerX, playerY + playerBob, 1);
        for (i = 0; i < entities.length; i++) {
            e = entities[i];
            if (e.type !== "train") continue;
            DRONE_ALVO.x = LANES[e.lane];
            DRONE_ALVO.y = e.y + e.h / 2;
            DRONE_ALVO.vx = 0;
            DRONE_ALVO.vy = speed;
            d.ag.evade(DRONE_ALVO, 1.4, 64);
        }
        d.ag.within(AREA_DRONE, 14, 2);
        d.ag.update(dt);
    }
    if (!d.fuga && Math.abs(d.x - playerX) < 16 &&
        Math.abs(d.y - (playerY + playerBob)) < 22) {
        bater();
        return true;
    }
    return false;
}

// ------------------------------------------------------------- simulacao ---
function move(dir) {
    var nl = playerLane + dir;
    if (nl < 0 || nl > 2) return;
    playerLane = nl;
    sfx("lane");
}

// faixa mais proxima do x tocado (limites no meio das faixas 0|1 e 1|2)
function laneAt(x) { return x < 87 ? 0 : (x < 153 ? 1 : 2); }

// stick do pad: um passo por empurrao (volta ao centro rearma); o tap seco
// na faixa inferior vira o toque na faixa (fallback do toque unico)
function lePad() {
    if (!stk) return;
    if (stk.active) ultimoStickX = stk.cx;
    if (stk.tap) {
        var alvo = laneAt(ultimoStickX);
        if (alvo > playerLane) move(1);
        else if (alvo < playerLane) move(-1);
        return;
    }
    if (!stk.active) { stickLock = 0; return; }
    if (stk.x > 0.55) {
        if (stickLock !== 1) { move(1); stickLock = 1; }
    } else if (stk.x < -0.55) {
        if (stickLock !== -1) { move(-1); stickLock = -1; }
    } else if (Math.abs(stk.x) < 0.3) {
        stickLock = 0;
    }
}

// toque extra (multitoque) no botao de pausa: o dedo primario pode estar
// segurando o stick quando o segundo toca o HUD
function toquePausaExtra() {
    var ts = E.input.touches;
    if (!ts) return false;
    for (var i = 0; i < ts.length; i++) {
        var f = ts[i];
        if (f.primary || !f.justUp || f.moved) continue;
        if (f.x >= BTN_PAUSE.x - 3 && f.x <= BTN_PAUSE.x + BTN_PAUSE.w + 3 &&
            f.y >= BTN_PAUSE.y - 3 && f.y <= BTN_PAUSE.y + BTN_PAUSE.h + 3) return true;
    }
    return false;
}

function bater() {
    sfx("crash");
    if (score > hi) { hi = score; newRecord = true; E.save.set("hi", hi); }
    if (newRecord) sfx("record");
    E.fx.ring(playerX, playerY, { color: T.err, r0: 8, speed: 220, life: 0.5 });
    E.fx.burst(playerX, playerY, { n: 22, color: T.err, colors: [T.err, T.warn],
                                   speed: 140, life: 0.7, grav: 160 });
    E.fx.flash(T.err, 250);
    E.goto("fim", { transition: "iris", ms: 500 });
}

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
        nascerDoPlano();
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
                bater();
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
    if (atualizaDrone(dt)) return;
    speed += dt * 5.0;
}

// ---------------------------------------------------------------- desenho ---
// painter da camada suja: restaura a cidade so no recorte pedido e repinta
// o manto da pista + bordas neon. O manto cobre ROAD_X..ROAD_X+ROAD_W (sem
// a folga antiga de 12 px), deixando a cidade aparecer nas laterais.
function paintRoad(x, y, w, h) {
    if (!desenhaFundo(x, y, w, h)) S.fillRect(x, y, w, h, T.bg);
    var ix = Math.max(x, ROAD_X), ix2 = Math.min(x + w, ROAD_X + ROAD_W);
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

function desenhaTrem(e) {
    if (temAtlas) {
        E.spr.stamp("@trem", Math.round(LANES[e.lane]), Math.round(e.y), _tremO);
    } else {
        paintTrem(56, 80, Math.round(LANES[e.lane]) - 28, Math.round(e.y));
    }
}
function desenhaMoeda(e) {
    var yy = e.y + Math.round(Math.sin((distance + e.y) / 18) * 2);
    if (temAtlas) {
        E.spr.stamp("@moeda", Math.round(LANES[e.lane]), yy, _centroO);
    } else {
        paintMoeda(20, 20, Math.round(LANES[e.lane]) - 10, yy - 10);
    }
}
function desenhaHeroi() {
    if (temAtlas) {
        E.spr.stamp("@heroi", Math.round(playerX), Math.round(playerY + playerBob), _centroO);
    } else {
        paintHeroi(36, 48, Math.round(playerX) - 18, Math.round(playerY - 24 + playerBob));
    }
}
function desenhaDrone() {
    if (!drone) return;
    var d = drone;
    var y = d.y + Math.sin(d.t * 9) * 2;
    // helices + corpo neon; o olho pisca para ler a direcao
    E.gfx.line(d.x - 13, y - 9, d.x - 5, y - 9, T.textDim, { w: 2 });
    E.gfx.line(d.x + 5, y - 9, d.x + 13, y - 9, T.textDim, { w: 2 });
    E.gfx.circle(d.x - 13, y - 9, 3, T.accentD, { smooth: true });
    E.gfx.circle(d.x + 13, y - 9, 3, T.accentD, { smooth: true });
    E.gfx.circle(d.x, y, 8, T.err, { smooth: true });
    E.gfx.circle(d.x, y, 4, T.warn, { smooth: true });
    if (Math.floor(d.t * 6) % 4 !== 0) {
        E.gfx.circle(d.x, y, 2, T.text, { smooth: true });
    }
}

function drawJogo() {
    // tracinhos entre faixas rolando com a distancia (dinamicos)
    var off = Math.floor(distance) % 44;
    for (var y = -44; y < H; y += 44) {
        var ry = y + off;
        if (ry < HUD_H + 8 || ry > H - 18) continue;
        E.gfx.rect(ROAD_X + LANE_W - 2, ry, 4, 22, T.stroke, DASH_O);
        E.gfx.rect(ROAD_X + 2 * LANE_W - 2, ry, 4, 22, T.stroke, DASH_O);
    }
    // entidades (atlas de IA com stamp escalado; painter sem slot/PNG)
    for (var i = 0; i < entities.length; i++) {
        var e = entities[i];
        if (e.type === "train") desenhaTrem(e);
        else desenhaMoeda(e);
    }
    desenhaHeroi();
    desenhaDrone();
    E.fx.draw();
    if (stk) E.pad.draw();
    // o stamp/clip do sprite nao conhece o recorte do HUD: trem entrando
    // pelo topo pode pintar por cima do placar. Quando alguma caixa deste
    // quadro toca a faixa do HUD, o memo e forcado a repintar por cima.
    if (E.dirty.touches(0, 0, W, HUD_H)) drawHud(true);
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
    if (stk) stk.tap = false;   // toque da pausa nao vira troca de faixa
    stickLock = 0;
    fxFonte(true);
    armaJogo();
}

// gancho do harness/emulador (test.js ou --events): estado para o smoke
if (typeof __harness !== "undefined") {
    __harness.runner = {
        E: E,
        estado: function () {
            return {
                score: score, distance: distance, lane: playerLane, pausado: pausado,
                fps: E.fps,
                drone: drone ? { x: drone.x, y: drone.y, t: drone.t, fuga: drone.fuga } : null,
                linha: planoRow, entidades: entities ? entities.length : 0,
                pad: stk ? { active: stk.active, x: stk.x, cx: stk.cx,
                             tap: stk.tap, finger: stk.finger } : null,
                atlas: temAtlas, fundo: bgSpr
            };
        },
        forcarDrone: function () { distance = 1000; droneVoo = 99; droneEspera = 0; },
        limpar: function () { if (entities) entities.length = 0; }
    };
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
            // cidade de IA no rodape (mesmo PNG do fundo do jogo; sem ele a
            // skyline procedural antiga continua valendo)
            if (!desenhaFundo(0, H - 140, W, 140)) paintCidade(W, 76, 0, H - 76);
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
            // stick da faixa inferior (multitoque no 4848: o dedo do stick
            // tem dono e o segundo dedo segue livre, ex. para a pausa)
            stk = E.pad.stick({
                zone: { x: 0, y: PAD_Y, w: W, h: H - PAD_Y },
                x: W / 2, y: H - 12, r: 18,
                float: true, dead: 0.22, dirs: 4, visible: true
            });
            stickLock = 0;
            ultimoStickX = W / 2;
            pressPad = false;
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
            if (stk) { E.pad.clear(); stk = null; }
            drone = null;
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
            lePad();
            if (i.justDown) {
                pressT = S.millis();
                pressPause = i.y < HUD_H;   // toque comecou no HUD
                pressPad = i.y >= PAD_Y;    // toque comecou na faixa do stick
            } else if (i.justUp && !i.moved) {
                if (pressPause) {
                    if (E.hit(BTN_PAUSE)) { pausar(); return; }
                } else if (!pressPad && S.millis() - pressT >= 40) {
                    // toque seco: um passo NA DIRECAO da faixa tocada. Decidido
                    // na liberacao (posicao final do dedo: a 1a amostra do touch
                    // bateria e movia pro lado errado) e com piso de 40 ms
                    // (raspao/injecao nao move)
                    var alvo = laneAt(i.x);
                    if (alvo > playerLane) move(1);
                    else if (alvo < playerLane) move(-1);
                }
            } else if (i.swipe && !pressPause && !pressPad) {
                if (i.swipe.dir === "left") move(-1);
                else if (i.swipe.dir === "right") move(1);
            }
            if (toquePausaExtra()) { pausar(); return; }
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
                if (act === "resume") { retomar(); this.fps = 60; sfx("ui"); }
                else if (act === "restart") {
                    resetGame();
                    pausado = false;
                    this.fps = 60;
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
