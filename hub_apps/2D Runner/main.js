// Neon Surfer (2D Runner) 3.1 — corrida infinita neon em 3 faixas, na
// CelerGame 1.7 + UI 1.3 (ES5 puro, Duktape).
//
// Novidades da 3.1:
// - controle por DESLIZE em qualquer lugar da pista: o stick nasce onde o
//   dedo pousa e segue o traco (re-ancora a cada passo = faixas seguidas
//   num arrasto continuo); o toque seco virou ATAQUE — tap num drone
//   derruba ele, e o drone voltou mais frequente pra virar alvo, nao
//   sentenca.
// - power-ups na pista: escudo (invencivel e atropela trem), ima (moedas
//   de qualquer faixa voam pro jogador) e x2 (pontos em dobro), com chip
//   de tempo restante no topo da pista.
//
// Vem da 3.0:
// - arte IA em spritesheet de VERDADE: arte.js descreve a folha 4x4 pelo
//   E.spr.meta e o jogo pede clipes com E.spr.animOf (heroi/trem/moeda);
//   o prescale continua gravando os quadros na escala da tela num slot so.
// - slots com dono: o fundo da cidade e alocado pelo E.slots.create (dono
//   "runner:fundo"), depois de consultar o orcamento E.slots.fit; a geracao
//   do slot (E.slots.gen) e conferida antes de cada restauracao, entao um
//   id reciclado nunca pinta arte nova no lugar da antiga.
// - culling: entidades num E.group e particulas num E.pool, desenhadas com
//   {cull:true} (fora da tela nao custa chamada nativa).
// - sono da tela (API 51): E.onSleep pausa a partida e E.onWake devolve o
//   quadro; o init solta o keepAwake para o aparelho poder dormir.
// - menu/HUD na UI 1.3: tokens/preset neon, E.ui.title, E.ui.hud memoizado,
//   E.ui.dialog, E.ui.pause/gameOver e os 12 icones compartilhados.
// - E.prof sob flag nos ajustes (input/mods/update/draw em us no HUD).
//
// O resto segue igual: 3 faixas, trens/moedas, velocidade crescente e
// recorde no NVS. A arte de IA e a pista justa do pista.js continuam.

var E = require("celeros.game");       // core 1.7 (loop, input, dirty, slots)
require("celeros.game.spr");           // sprites/anim/meta/prescale
require("celeros.game.ui");            // UI 1.3 (tokens, widgets, icones)
var ART = require("arte");             // metadados da folha de IA
var PISTA = require("pista");          // regras de justica do nascimento

E.init({ dir: "2D Runner", fps: 60, save: "surfer.", keepAwake: false,
         bases: ["/local/apps/2D Runner/", "/sd/apps/2D Runner/"] });

var T = E.theme, W = E.W, H = E.H, S = System;
var TK = E.ui.preset("neon");
var ROAD_X = 20, ROAD_W = 200, LANE_W = ROAD_W / 3;
var LANES = [ROAD_X + LANE_W / 2, ROAD_X + 3 * LANE_W / 2, ROAD_X + 5 * LANE_W / 2];
var HUD_H = 34, AI_KEY = 0xF81F;
var ROAD_BG = E.color.mix(T.bg, T.raised, 0.45);

// power-ups (timers em segundos; DUR = duracao da ativacao)
var PW_KINDS = ["escudo", "ima", "x2"];
var PW_DUR = { escudo: 6, ima: 8, x2: 8 };
var PW_COR = { escudo: T.accent, ima: 0x07FF, x2: 0x07E0 };
var PW_GLYPH = { escudo: "E", ima: "M", x2: "x2" };
var PW_NOME = { escudo: "ESCUDO!", ima: "IMA!", x2: "PONTOS x2!" };

// recorde no NVS do core (sem permissao "fs": o appData da 1.x morreu)
var hi = E.save.num("hi", 0);

// ajustes persistentes (diagnostico no HUD)
var showFPS = E.save.num("aj.fps", 0) === 1;
var showTemp = E.save.num("aj.tmp", 0) === 1;
var showProf = E.save.num("aj.prof", 0) === 1;
E.prof.on = showProf;

// Sons de tabela (API 32 mistura por cima da trilha; antes cai no playTone)
E.audio.sfxTable.lane = [620, 18];
E.audio.sfxTable.coin = [[988, 45], [1319, 70]];
E.audio.sfxTable.crash = [[150, 220], [90, 160]];
E.audio.sfxTable.record = [[784, 70], [1047, 110]];
E.audio.sfxTable.alerta = [[880, 55], [660, 55], [880, 90]];
E.audio.sfxTable.kill = [[1047, 35], [1568, 60]];
E.audio.sfxTable.pw = [[659, 40], [880, 40], [1175, 70]];
function sfx(what) { E.audio.sfx(what); }

// ---------------------------------------------------------------- estado ---
var playerLane, playerX, playerY, playerBob;
var score, coins, speed, distance, spawnT, newRecord, morto;
var rnd = null, moveStep = 0;
var pausado = false, pressPause = false, pressT = 0, marco = 0;
var pw = { escudo: 0, ima: 0, x2: 0 };
var drones = 0;
var dlg = null;

var PLAN_H = 10, planoObs = null, planoCoin = null, planoPw = null, planoRow = 0;

// drone (perseguicao por forcas, sem dep: seek + evade + corredor)
var drone = null, droneVoo = 0, droneEspera = 6;
var AREA_DRONE = { x: ROAD_X + 4, y: HUD_H + 4, w: ROAD_W - 8, h: H - HUD_H - 8 };

// stick local multitoque: nasce ONDE o dedo pousa e segue o traco; cada
// STK_PASSO px de arrasto horizontal = uma faixa (re-ancora no passo).
// Toque seco (sem arrastar) = ataque — derruba o drone sob o dedo.
var stk = { finger: null, active: false, cx: W / 2, cy: H - 12,
            x: 0, y: 0, r: 18 };
var STK_PASSO = 30;
var PAUSE_B = { x: W - 36, y: 4, w: 26, h: 26 };

var COMO_JOGAR = "Deslize o dedo na pista para trocar de faixa (o stick segue o " +
                 "traco). Toque num drone para derruba-lo antes que ele te alcance. " +
                 "Desvie dos trens, colete moedas e pegue os power-ups: escudo " +
                 "(invencivel e atropela trem), ima (atrai moedas) e x2 (pontos em " +
                 "dobro). A velocidade aumenta com o tempo. Pausa no topo.";

// ------------------------------------------------------------- sprites -----
// painter procedural = fallback quando o PNG/slot nao carrega
function paintAi(nome, x, y, k) {
    var s = 64 * (k || 1), cx = x + s / 2, cy = y + s / 2;
    if (nome === "ai1") {
        S.fillRect(x + s * 0.03, y + s * 0.04, s * 0.94, s * 0.92, T.err);
        S.fillRect(x + s * 0.13, y + s * 0.12, s * 0.74, s * 0.24, T.onAccent);
        S.fillRect(x + s * 0.1, y + s * 0.74, s * 0.19, s * 0.12, T.warn);
        S.fillRect(x + s * 0.71, y + s * 0.74, s * 0.19, s * 0.12, T.warn);
    } else if (nome === "ai2") {
        S.fillCircle(cx, cy, s * 0.34, T.warn);
        S.fillCircle(cx - s * 0.03, cy - s * 0.03, s * 0.16,
                     S.mixColor(T.warn, T.text, 40));
    } else {
        S.fillCircle(cx, cy + s * 0.4, s * 0.16, T.accentD);
        S.fillCircle(cx, cy + s * 0.4, s * 0.09, T.accent);
        S.fillRect(cx - s * 0.2, cy - s * 0.28, s * 0.4, s * 0.52, T.accent);
        S.fillRect(cx - s * 0.12, cy - s * 0.2, s * 0.24, s * 0.16, T.onAccent);
    }
}

// E.spr.meta monta a grade (1 slot) e descreve os clipes; animOf le os
// quadros/fps/loop do metadado — a arte fica num modulo de dados (arte.js)
ART.atlas.paint = paintAi;              // fallback sem PNG nas regioes
E.spr.meta("atlas", ART.atlas);
var temAtlas = E.spr.backed("ai0");
var AN_HEROI = E.spr.animOf("atlas", "heroi") || E.anim(["ai0"], 6, true);
var AN_TREM = E.spr.animOf("atlas", "trem") || E.anim(["ai1"], 4, true);
var AN_MOEDA = E.spr.animOf("atlas", "moeda") || E.anim(["ai2"], 8, true);

// trem/moeda/heroi JA na escala da tela (prescale, 1 slot): o stamp com
// escala por quadro era drawSprite afim por entidade (~1,25 ms cada)
var _TREM_O = { key: AI_KEY, ax: 0.5, ay: 0 };
var _CENTRO_O = { key: AI_KEY, cx: 1 };
if (temAtlas && E.spr.prescale) {
    if (E.spr.prescale([["ai1", 1.25, "@trem"], ["ai2", 0.35, "@moeda"],
                        ["ai0", 0.75, "@heroi"]], { key: AI_KEY, name: "runner_ps" })) {
        AN_TREM.frames = ["@trem"];
        AN_MOEDA.frames = ["@moeda"];
        AN_HEROI.frames = ["@heroi"];
    }
}

// cidade IA num sheet de 256x256; o fundo cozido de tela cheia e um slot
// PROPRIO do app, alocado pelo ledger depois do orcamento E.slots.fit
E.spr.sheet("aibg", { file: "ai_bg", w: 256, h: 256,
                      regions: { bg: [0, 0, 256, 256] } });
var temBg = E.spr.backed("bg");
var bgSpr = 0, bgGen = 0;
function montaFundo() {
    bgSpr = 0; bgGen = 0;
    if (!temBg) return;
    var fit = E.slots.fit(W, H);
    // orcamento e ADVISORIO: no host/emulador nao ha PSRAM e ele nega; o
    // create e a trava de verdade (falha barulhenta no log)
    if (!fit.ok) E._warn("fundo: " + fit.motivo);
    var id = E.slots.create("runner:fundo", W, H);
    if (!id) return;
    var on = E.dirty.on;
    E.dirty.on = false;
    S.useSprite(id);
    S.fillScreen(T.bg);
    E.spr.alvo = id;
    var k = W / 256;
    E.spr.stamp("bg", 0, 0, { scale: k, key: null });
    E.spr.stamp("bg", 0, Math.round(256 * k), { scale: k, key: null });
    E.spr.alvo = 0;
    S.useSprite(0);
    E.dirty.on = on;
    bgSpr = id;
    bgGen = E.slots.gen(id);
}
function desenhaFundo(x, y, w, h) {
    if (!bgSpr) return false;
    if (E.slots.gen(bgSpr) !== bgGen) { bgSpr = 0; return false; }
    if (typeof S.blitSprite !== "function") return false;
    S.blitSprite(bgSpr, x, y, w, h);
    return true;
}
montaFundo();

// -------------------------------------------------------- particulas/pool ---
// E.pool com {cull:true}: 64 particulas recicladas, zero alocacao por
// spawn (init de campos num objeto semeado) e fora da tela nem desenha
var _seed = { x: 0, y: 0, vx: 0, vy: 0, life: 0.5, size: 2, color: 0xFFFF,
              grav: 0, ring: false, grow: 0 };
function _pInit(q) {
    q.x = _seed.x; q.y = _seed.y; q.vx = _seed.vx; q.vy = _seed.vy;
    q.t = 0; q.life = _seed.life; q.size = _seed.size; q.color = _seed.color;
    q.grav = _seed.grav; q.ring = _seed.ring; q.grow = _seed.grow;
    q.w = q.h = 4;
}
var _pO = { fill: true, screen: false };
var _ringP = { fill: false, screen: false };
var parts = E.pool(64, function () {
    return {
        dead: true, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, size: 2,
        color: 0xFFFF, grav: 0, grow: 0, ring: false, w: 4, h: 4,
        update: function (dt) {
            this.t += dt;
            if (this.t >= this.life) { this.dead = true; return; }
            this.vy += this.grav * dt;
            this.x += this.vx * dt;
            this.y += this.vy * dt;
            var s = this.ring ? (this.size + this.t * this.grow)
                              : Math.max(1, this.size * (1 - this.t / this.life));
            this.w = this.h = Math.round(s * 2 + 2);
        },
        draw: function () {
            var k = 1 - this.t / this.life;
            if (this.ring) {
                E.gfx.circle(Math.round(this.x), Math.round(this.y),
                             Math.round(this.size + this.t * this.grow), this.color, _ringP);
            } else {
                var r = Math.max(1, Math.round(this.size * k));
                if (r <= 1) E.gfx.rect(Math.round(this.x), Math.round(this.y), 2, 2, this.color, _pO);
                else E.gfx.circle(Math.round(this.x), Math.round(this.y), r, this.color, _pO);
            }
        }
    };
});
function pPut(x, y, vx, vy, o) {
    _seed.x = x; _seed.y = y; _seed.vx = vx; _seed.vy = vy;
    _seed.life = (o.life || 0.5) * (0.7 + Math.random() * 0.3);
    _seed.size = o.size || 2;
    _seed.color = o.colors ? o.colors[(Math.random() * o.colors.length) | 0] :
                  (o.color === undefined ? 0xFFFF : o.color);
    _seed.grav = o.grav || 0;
    _seed.ring = !!o.ring;
    _seed.grow = o.grow || 0;
    return !!parts.spawn(_pInit);
}
function pBurst(x, y, o) {
    var n = o.n === undefined ? 10 : o.n;
    var sp = o.speed === undefined ? 60 : o.speed;
    var sp2 = o.speed2 === undefined ? sp : o.speed2;
    for (var i = 0; i < n; i++) {
        var a = Math.random() * Math.PI * 2;
        var v = sp + Math.random() * (sp2 - sp);
        pPut(x, y, Math.cos(a) * v, Math.sin(a) * v, o);
    }
}
function pRing(x, y, o) {
    pPut(x, y, 0, 0, { ring: true, life: o.life || 0.45, size: o.r0 || 4,
                       color: o.color, grow: o.speed || 220 });
}
var FLO = [];
function pText(x, y, str, color) {
    FLO.push({ x: x, y: y, s: String(str), c: color === undefined ? T.warn : color,
               t: 0, life: 0.7 });
    if (FLO.length > 8) FLO.shift();
}
function fxClear() {
    parts.clear();
    FLO.length = 0;
}
function fxTick(dt) {
    parts.update(dt);
    for (var i = FLO.length - 1; i >= 0; i--) {
        FLO[i].t += dt;
        FLO[i].y -= 22 * dt;
        if (FLO[i].t >= FLO[i].life) FLO.splice(i, 1);
    }
}
function fxDraw() {
    parts.draw({ cull: true, pad: 8 });
    for (var i = 0; i < FLO.length; i++) {
        E.gfx.text(FLO[i].s, Math.round(FLO[i].x), Math.round(FLO[i].y),
                   { ts: "label", align: "center", color: FLO[i].c, screen: true });
    }
}

// ------------------------------------------------------------ entidades -----
var entities = E.group();

function drawTrem() {
    var x = Math.round(LANES[this.lane]);
    if (temAtlas) AN_TREM.draw(x, Math.round(this.y), _TREM_O);
    else {
        S.fillRect(x - 28, Math.round(this.y), 56, 80, T.err);
        S.fillRect(x - 20, Math.round(this.y) + 6, 40, 16, T.onAccent);
        S.fillRect(x - 22, Math.round(this.y) + 64, 12, 8, T.warn);
        S.fillRect(x + 10, Math.round(this.y) + 64, 12, 8, T.warn);
    }
}
function updTrem() {
    this.y += moveStep;
    if (this.y > H + 12) { this.dead = true; score += soma(5); return; }
    if (morto) return;
    var py = playerY - 20 + playerBob;
    if (Math.abs(LANES[this.lane] - playerX) < LANE_W / 2 &&
        py < this.y + this.h && py + 40 > this.y) {
        if (pw.escudo > 0) {
            // escudo ativo: atropela o trem
            this.dead = true;
            score += soma(25);
            sfx("kill");
            pBurst(LANES[this.lane], this.y + 40, { n: 14, colors: [T.err, T.warn],
                                                    speed: 90, speed2: 160, life: 0.5 });
            pText(LANES[this.lane], this.y + 20, "+25");
        } else bater();
    }
}
function drawMoeda() {
    var y = this.y + Math.round(Math.sin((distance + this.y) / 18) * 2);
    var x = Math.round(this.px);
    if (temAtlas) AN_MOEDA.draw(x, y, _CENTRO_O);
    else {
        S.fillCircle(x, y, 9, T.warn);
        S.fillCircle(x - 2, y - 2, 4, S.mixColor(T.warn, T.text, 40));
    }
}
function updMoeda(dt) {
    this.y += moveStep;
    if (this.y > H + 12) { this.dead = true; return; }
    if (morto) return;
    if (pw.ima > 0) this.px += (playerX - this.px) * Math.min(1, dt * 8);
    var py = playerY - 20 + playerBob;
    if (Math.abs(this.px - playerX) < LANE_W / 2 &&
        py < this.y + 10 && py + 40 > this.y - 10) {
        score += soma(50);
        coins++;
        sfx("coin");
        pBurst(this.px, this.y, { n: 8, color: T.warn, speed: 50, speed2: 90,
                                  life: 0.4, size: 2 });
        pRing(this.px, this.y, { color: T.warn, r0: 4, speed: 90, life: 0.35 });
        pText(this.px, Math.max(HUD_H + 6, this.y - 6), "+" + soma(50));
        this.dead = true;
    }
}
function addTrem(lane, y) {
    entities.add({ type: "train", lane: lane, y: y,
                   x: LANES[lane] - 40, w: 80, h: 80,
                   draw: drawTrem, update: updTrem });
}
function addMoeda(lane, y) {
    entities.add({ type: "coin", lane: lane, y: y, px: LANES[lane],
                   x: LANES[lane] - 10, w: 20, h: 20,
                   draw: drawMoeda, update: updMoeda });
}

// power-up: token circular com glifo (E/M/x2), anel pulsante
var _PW_RING = { fill: false };
function drawPw() {
    var x = Math.round(LANES[this.lane]);
    var y = this.y + Math.round(Math.sin((distance + this.y) / 16) * 2);
    var c = PW_COR[this.kind];
    S.fillCircle(x, y, 10, TK.surface3);
    E.gfx.circle(x, y, 11, c, _PW_RING);
    E.gfx.circle(x, y, 13 + Math.round(Math.sin(S.millis() / 130) * 2), c, _PW_RING);
    E.gfx.text(PW_GLYPH[this.kind], x, y,
               { ts: "tiny", align: "center", valign: "middle", color: T.text });
}
function updPw() {
    this.y += moveStep;
    if (this.y > H + 12) { this.dead = true; return; }
    if (morto) return;
    var py = playerY - 20 + playerBob;
    if (Math.abs(LANES[this.lane] - playerX) < LANE_W / 2 &&
        py < this.y + 12 && py + 40 > this.y - 12) {
        ativaPw(this.kind);
        this.dead = true;
    }
}
function addPw(lane, y, kind) {
    entities.add({ type: "pw", lane: lane, y: y, kind: kind,
                   x: LANES[lane] - 12, w: 24, h: 24,
                   draw: drawPw, update: updPw });
}
function ativaPw(kind) {
    pw[kind] = PW_DUR[kind];
    sfx("pw");
    pRing(playerX, playerY + playerBob, { color: PW_COR[kind], r0: 6, speed: 150,
                                          life: 0.4 });
    pText(playerX, Math.max(HUD_H + 6, playerY - 30), PW_NOME[kind], PW_COR[kind]);
}
// pontos com x2 ligado dobram
function soma(n) { return pw.x2 > 0 ? n * 2 : n; }

// ---------------------------------------------------------- pista (gen) ----
// Plano de 10 linhas x 3 faixas: 14 trens espalhados (minDist 2, como o
// E.gen.scatter fazia) e 9 moedas em celulas livres. O pista.js valida cada
// nascimento contra as entidades VIVAS: sobreposicao continua impossivel.
function novoPlano() {
    var g = [], r, c, i, k;
    for (r = 0; r < PLAN_H; r++) {
        var ln = [];
        for (c = 0; c < 3; c++) ln.push(".");
        g.push(ln);
    }
    var livres = [], postos = [];
    for (r = 0; r < PLAN_H; r++) for (c = 0; c < 3; c++) livres.push(r * 3 + c);
    E.m.shuffle(livres, rnd);
    for (i = 0; i < livres.length && postos.length < 14; i++) {
        var fr = (livres[i] / 3) | 0, fc = livres[i] % 3, ok = true;
        for (k = 0; k < postos.length; k++) {
            if (Math.abs(postos[k].c - fc) < 2 && Math.abs(postos[k].r - fr) < 2) { ok = false; break; }
        }
        if (!ok) continue;
        g[fr][fc] = "T";
        postos.push({ c: fc, r: fr });
    }
    planoObs = g;
    planoCoin = [];
    for (r = 0; r < PLAN_H; r++) {
        var lc = [];
        for (c = 0; c < 3; c++) lc.push(".");
        planoCoin.push(lc);
    }
    var livres2 = [];
    for (r = 0; r < PLAN_H; r++) for (c = 0; c < 3; c++) if (g[r][c] === ".") livres2.push(r * 3 + c);
    E.m.shuffle(livres2, rnd);
    var nc = 0;
    for (i = 0; i < livres2.length && nc < 9; i++) {
        var cr = (livres2[i] / 3) | 0, cc = livres2[i] % 3;
        planoCoin[cr][cc] = "c";
        nc++;
    }
    // power-up: 1 por plano com sorte (55%), em celula livre de trem E moeda
    planoPw = [];
    for (r = 0; r < PLAN_H; r++) {
        var lp = [];
        for (c = 0; c < 3; c++) lp.push(".");
        planoPw.push(lp);
    }
    if (rnd() < 0.55) {
        var liv3 = [];
        for (r = 0; r < PLAN_H; r++) for (c = 0; c < 3; c++) {
            if (g[r][c] === "." && planoCoin[r][c] === ".") liv3.push(r * 3 + c);
        }
        E.m.shuffle(liv3, rnd);
        if (liv3.length) {
            var pr = (liv3[0] / 3) | 0, pc = liv3[0] % 3;
            planoPw[pr][pc] = PW_KINDS[(rnd() * PW_KINDS.length) | 0];
        }
    }
    planoRow = 0;
}

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
        var tr = PISTA.trem(entities.items, tremLane, cfg);
        if (tr) addTrem(tremLane, tr.y);
    }
    var yF = HUD_H + 26;
    for (i = 0; i < 3; i++) {
        if (planoCoin[r][i] !== "c") continue;
        if (rnd() < 0.3) {
            if (!PISTA.seguraPraMoeda(entities.items, i, yF - 60, yF + 20, cfg)) continue;
            for (var c = 0; c < 3; c++) addMoeda(i, yF - c * 30);
        } else {
            if (!PISTA.seguraPraMoeda(entities.items, i, yF - 20, yF + 20, cfg)) continue;
            addMoeda(i, yF);
        }
        break;                          // uma fileira/moeda por linha
    }
    // power-up da linha: so nasce em faixa segura (mesma regra da moeda)
    for (i = 0; i < 3; i++) {
        var kp = planoPw[r][i];
        if (kp === ".") continue;
        if (PISTA.seguraPraMoeda(entities.items, i, yF - 14, yF + 14, cfg)) {
            addPw(i, yF, kp);
        }
        break;                          // um power-up por linha
    }
}

// -------------------------------------------------------------- drone ------
function nasceDrone() {
    var ln = Math.floor(rnd() * 3);
    drone = { x: LANES[ln], y: HUD_H - 14, vx: 0, vy: 0, t: 0, fuga: false };
    pText(W / 2, HUD_H + 18, "DRONE!", T.err);
    sfx("alerta");
}
function atualizaDrone(dt) {
    if (!drone) {
        droneVoo += dt;
        if (droneVoo > droneEspera && distance > 500) {
            droneVoo = 0;
            droneEspera = 5 + rnd() * 4;   // vem mais vezes: virou alvo, nao sentenca
            nasceDrone();
        }
        return false;
    }
    var d = drone, i, e;
    d.t += dt;
    if (d.t > 12) {
        if (!d.fuga) d.fuga = true;
        d.x += d.vx * dt;
        d.y -= 170 * dt;
        if (d.y < HUD_H - 30) drone = null;
    } else {
        var sp = 86 + Math.min(40, score / 250);
        var tx = playerX, ty = playerY + playerBob;
        var dx = tx - d.x, dy = ty - d.y, l = Math.sqrt(dx * dx + dy * dy) || 1;
        var wx = dx / l * sp, wy = dy / l * sp;
        // evade dos trens: empurrao lateral quando um trem chega perto
        for (i = 0; i < entities.items.length; i++) {
            e = entities.items[i];
            if (e.dead || e.type !== "train") continue;
            var ex = LANES[e.lane], ey = e.y + 40;
            if (Math.abs(ex - d.x) < 30 && Math.abs(ey - d.y) < 60) {
                wx += (d.x >= ex ? 1 : -1) * sp * 1.4;
            }
        }
        // corredor da pista
        if (d.x < AREA_DRONE.x + 14) wx += sp;
        else if (d.x > AREA_DRONE.x + AREA_DRONE.w - 14) wx -= sp;
        if (d.y < AREA_DRONE.y + 14) wy += sp;
        else if (d.y > AREA_DRONE.y + AREA_DRONE.h - 14) wy -= sp;
        var k = Math.min(1, dt * 5);
        d.vx += (wx - d.vx) * k;
        d.vy += (wy - d.vy) * k;
        var v = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
        if (v > sp) { d.vx = d.vx / v * sp; d.vy = d.vy / v * sp; }
        d.x += d.vx * dt;
        d.y += d.vy * dt;
    }
    if (!d.fuga && Math.abs(d.x - playerX) < 16 &&
        Math.abs(d.y - (playerY + playerBob)) < 22) {
        if (pw.escudo > 0) destruirDrone();
        else bater();
        return true;
    }
    return false;
}

// ataque (toque seco): derruba o drone sob o dedo
function atacar(x, y) {
    if (drone && Math.abs(x - drone.x) < 22 && Math.abs(y - drone.y) < 24) {
        destruirDrone();
        return true;
    }
    return false;
}
function destruirDrone() {
    if (!drone) return;
    drones++;
    score += soma(120);
    sfx("kill");
    pBurst(drone.x, drone.y, { n: 16, colors: [T.err, T.warn, T.text],
                               speed: 90, speed2: 170, life: 0.6, grav: 60 });
    pRing(drone.x, drone.y, { color: T.err, r0: 6, speed: 200, life: 0.45 });
    pText(drone.x, Math.max(HUD_H + 6, drone.y - 8), "+" + soma(120));
    drone = null;
    droneVoo = 0;
}

// ------------------------------------------------------------ simulacao ---
function resetGame() {
    playerLane = 1;
    playerX = LANES[1];
    playerY = 262;
    playerBob = 0;
    score = 0;
    coins = 0;
    speed = 150;
    distance = 0;
    spawnT = 0;
    newRecord = false;
    morto = false;
    pressT = 0;
    marco = 0;
    pressPause = false;
    pw.escudo = 0;
    pw.ima = 0;
    pw.x2 = 0;
    drones = 0;
    rnd = E.rng((Math.random() * 2147483647) | 0);
    novoPlano();
    drone = null;
    droneVoo = 0;
    droneEspera = 6;
    entities.clear();
    fxClear();
}

function move(dir) {
    var nl = playerLane + dir;
    if (nl < 0 || nl > 2) return;
    playerLane = nl;
    sfx("lane");
}

// deslize: QUALQUER dedo que pousar na pista (abaixo do HUD) vira o stick;
// o stick segue o traco — a cada STK_PASSO px de arrasto horizontal move uma
// faixa e re-ancora (um arrasto continuo percorre as 3 faixas). Toque seco
// (levantou sem arrastar) = ATAQUE: derruba o drone sob o dedo. O dedo
// primario nao ataca aqui (o ramo justUp do update cuida — evita ataque duplo)
function leStick() {
    var ts = E.input.touches || EMPTY_L, f, i;
    f = stk.finger !== null ? E.input.finger(stk.finger) : null;
    if (f && !f.down) {
        if (!f.moved && !f.primary) atacar(f.x, f.y);
        stk.finger = null;
        stk.active = false;
        f = null;
    }
    if (!f) {
        for (i = 0; i < ts.length; i++) {
            var g = ts[i];
            if (g.justDown && g.y >= HUD_H) {
                f = g;
                stk.finger = g.id;
                stk.active = true;
                stk.cx = g.x;
                stk.cy = g.y;
                break;
            }
        }
    }
    if (!f) { stk.x = 0; stk.y = 0; return; }
    var dx = f.x - stk.cx, dy = f.y - stk.cy;
    if (Math.abs(dx) >= STK_PASSO) {
        move(dx > 0 ? 1 : -1);
        stk.cx = f.x;                    // re-ancora: traco continuo = faixas seguidas
        dx = 0;
    }
    stk.x = Math.max(-1, Math.min(1, dx / stk.r));
    stk.y = Math.max(-1, Math.min(1, dy / stk.r));
}
var EMPTY_L = [];
var _ringO = { fill: false };
var _knobO = { fill: true, smooth: true };
function desenhaStick() {
    if (!stk.active) return;             // o stick so existe enquanto o dedo desliza
    E.gfx.circle(stk.cx, stk.cy, stk.r, T.accent, _ringO);
    E.gfx.circle(stk.cx + stk.x * stk.r * 0.7, stk.cy + stk.y * stk.r * 0.7,
                 Math.round(stk.r * 0.38), T.accent, _knobO);
}

// dedo extra no botao de pausa (o primario pode estar no stick)
function toquePausaExtra() {
    var ts = E.input.touches;
    if (!ts) return false;
    for (var i = 0; i < ts.length; i++) {
        var f = ts[i];
        if (f.primary || !f.justUp || f.moved) continue;
        if (f.x >= PAUSE_B.x - 4 && f.x <= PAUSE_B.x + PAUSE_B.w + 4 &&
            f.y >= PAUSE_B.y - 4 && f.y <= PAUSE_B.y + PAUSE_B.h + 4) return true;
    }
    return false;
}

function bater() {
    if (morto || pw.escudo > 0) return;
    morto = true;
    sfx("crash");
    if (score > hi) { hi = score; newRecord = true; E.save.set("hi", hi); }
    if (newRecord) sfx("record");
    pRing(playerX, playerY, { color: T.err, r0: 8, speed: 220, life: 0.5 });
    pBurst(playerX, playerY, { n: 22, colors: [T.err, T.warn], speed: 80,
                              speed2: 170, life: 0.7, grav: 160 });
    E.goto("fim", { transition: "iris", ms: 500 });
}

var _TRAIL_O = { life: 0.35, size: 3, color: T.accent };
var trailAcc = 0;

function simula(dt) {
    moveStep = speed * dt;
    distance += moveStep;
    playerBob = Math.sin(S.millis() / 150.0) * 5;

    var target = LANES[playerLane];
    playerX += (target - playerX) * Math.min(1, dt * 14);
    if (Math.abs(target - playerX) < 0.5) playerX = target;

    spawnT += dt;
    var rate = Math.max(0.24, 1.0 - speed / 1000.0);
    if (spawnT > rate) {
        spawnT = 0;
        nascerDoPlano();
    }

    entities.update(dt);
    if (morto) return;
    atualizaDrone(dt);
    if (morto) return;
    speed += dt * 5.0;
    var pk;
    for (pk in pw) if (pw[pk] > 0) { pw[pk] -= dt; if (pw[pk] < 0) pw[pk] = 0; }

    // rastro da prancha + escapamento (emissores alimentados pelo pool)
    trailAcc += dt * 26;
    while (trailAcc >= 1) {
        trailAcc--;
        pPut(playerX, playerY + playerBob + 26, 0, 20, _TRAIL_O);
    }
    fxTick(dt);
    // QUADRO TOTAL na area da pista: a pista inteira rola todo quadro
    // (distance) e as faixas do asfalto + emissores deixavam restos quando a
    // camada suja apagava so as caixas dos sprites — era o "artefato ao
    // mover". O fundo e um slot ja cozido: repintar o recorte inteiro e um
    // copySprite, mais barato que dezenas de restauros parciais.
    if (E.dirty && E.dirty.full) E.dirty.full();
}

function desenhaHeroi() {
    var hx = Math.round(playerX), hy = Math.round(playerY + playerBob);
    if (pw.escudo > 0) {
        // aura pulsante do escudo (2 aneis; some com fade nos ultimos 1,5 s)
        var rs = 27 + Math.round(Math.sin(S.millis() / 90) * 2);
        var cs = pw.escudo < 1.5 ? (Math.floor(S.millis() / 120) % 2 === 0 ?
                                    T.accent : TK.glow) : T.accent;
        E.gfx.circle(hx, hy + 20, rs, cs, _ringO);
        E.gfx.circle(hx, hy + 20, rs - 5, TK.glow, _ringO);
    }
    if (temAtlas) AN_HEROI.draw(hx, hy, _CENTRO_O);
    else paintAi("ai0", hx - 18, hy - 24, 0.75);
}
function desenhaDrone() {
    if (!drone) return;
    var d = drone;
    var y = d.y + Math.sin(d.t * 9) * 2;
    E.gfx.line(d.x - 13, y - 9, d.x - 5, y - 9, T.textDim, { w: 2 });
    E.gfx.line(d.x + 5, y - 9, d.x + 13, y - 9, T.textDim, { w: 2 });
    E.gfx.circle(d.x - 13, y - 9, 3, T.accentD, { smooth: true });
    E.gfx.circle(d.x + 13, y - 9, 3, T.accentD, { smooth: true });
    E.gfx.circle(d.x, y, 8, T.err, { smooth: true });
    E.gfx.circle(d.x, y, 4, T.warn, { smooth: true });
    if (Math.floor(d.t * 6) % 4 !== 0) E.gfx.circle(d.x, y, 2, T.text, { smooth: true });
}

// painter da camada suja: restaura a cidade so no recorte pedido e repinta
// o manto da pista + bordas neon
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

var DASH_O = { r: 2, screen: true };
var _CHIP_TX = { ts: "tiny", color: 0, fit: 21, screen: true };
// chips dos power-ups ativos: barra colorida + glifo + segundos restantes,
// empilhados da direita pra esquerda no topo da pista (a pista repinta o
// quadro inteiro todo frame, entao o chip pode ser dinamico)
function desenhaPwChips() {
    var x = W - 6;
    for (var k = PW_KINDS.length - 1; k >= 0; k--) {
        var nome = PW_KINDS[k];
        var t = pw[nome];
        if (t <= 0) continue;
        var c = PW_COR[nome];
        x -= 32;
        S.fillRect(x + 2, HUD_H + 3, 30, 13, TK.surface2);
        S.fillRect(x + 2, HUD_H + 3, 3, 13, c);
        _CHIP_TX.color = T.text;
        E.gfx.text(PW_GLYPH[nome] + " " + Math.ceil(t), x + 8, HUD_H + 4, _CHIP_TX);
    }
}
function drawJogo() {
    var off = Math.floor(distance) % 44;
    for (var y = -44; y < H; y += 44) {
        var ry = y + off;
        if (ry < HUD_H + 8 || ry > H - 18) continue;
        E.gfx.rect(ROAD_X + LANE_W - 2, ry, 4, 22, T.stroke, DASH_O);
        E.gfx.rect(ROAD_X + 2 * LANE_W - 2, ry, 4, 22, T.stroke, DASH_O);
    }
    entities.draw({ cull: true, pad: 16 });
    desenhaHeroi();
    desenhaDrone();
    fxDraw();
    desenhaStick();
    desenhaPwChips();
}

// ------------------------------------------------------------------ HUD ----
// E.ui.hud memoiza a assinatura e repinta so quando algo muda ou a camada
// suja toca a faixa; o botao de pausa e um iconButton da UI 1.3 ao lado
var LI = [{ icon: "star", text: "0", color: 0 },
          { icon: null, text: "", color: 0 },
          { icon: null, text: "", color: 0 },
          { icon: null, text: "", color: 0 }];
var HL = [[LI[0]], [LI[0], LI[1]], [LI[0], LI[2]], [LI[0], LI[1], LI[2]], [LI[0], LI[3]]];
var HUD_O = { x: 0, y: 0, w: W - 42, h: HUD_H, bg: TK.surface, key: "runner",
              best: 0, score: 0, left: HL[0] };
var tempTxt = "";
function drawHud() {
    LI[0].text = String(coins);
    LI[0].color = TK.warn;
    LI[1].text = E.fps + "fps";
    LI[1].color = TK.textDim;
    LI[2].text = tempTxt;
    LI[2].color = TK.textDim;
    var li = 0;
    if (showProf) {
        LI[3].text = "u" + ((E.prof.update / 1000) | 0) + " d" + ((E.prof.draw / 1000) | 0);
        LI[3].color = TK.textDim;
        li = 4;
    } else if (showFPS && showTemp) li = 3;
    else if (showFPS) li = 1;
    else if (showTemp) li = 2;
    HUD_O.left = HL[li];
    HUD_O.best = hi;
    HUD_O.score = score;
    E.ui.hud(HUD_O);
    if (E.ui.iconButton("pause", PAUSE_B.x, PAUSE_B.y, PAUSE_B.w,
                        { variant: "primary" })) pausar();
}

// liga/desliga a camada suja e o HUD da cena jogo
function armaJogo() {
    E.dirty.enable(paintRoad);
    E.dirty.clip(0, HUD_H, W, H - HUD_H);
}
function pausar() {
    if (pausado) return;
    pausado = true;
    E.dirty.off();
    sfx("ui");
}
function retomar() {
    pausado = false;
    stk.finger = null;
    stk.active = false;
    armaJogo();
    drawHud();
}

// gancho do harness/emulador (test.js ou --events): estado para o smoke
if (typeof __harness !== "undefined") {
    __harness.runner = {
        estado: function () {
            return { score: score, distance: distance, lane: playerLane, pausado: pausado,
                     fps: E.fps, prof: E.prof.on, linha: planoRow, entidades: entities.count,
                     vivo: !morto, drones: drones,
                     pw: { escudo: pw.escudo, ima: pw.ima, x2: pw.x2 },
                     drone: drone ? { x: drone.x, y: drone.y, t: drone.t, fuga: drone.fuga } : null,
                     stick: { active: stk.active, x: stk.x, finger: stk.finger },
                     atlas: temAtlas, fundo: bgSpr, slots: E.slots.n() };
        },
        comecar: function () { E.goto("jogo", { transition: "fade", ms: 0 }); },
        forcarDrone: function (x, y) {
            distance = 1000;
            if (typeof x === "number") {
                drone = { x: x, y: y, vx: 0, vy: 0, t: 0, fuga: false };
            } else {
                droneVoo = 99;
                droneEspera = 0;
            }
        },
        darPw: function (k) { addPw(playerLane, playerY - 10, k); },
        forcarMoeda: function (lane, y) {
            addMoeda(lane === undefined ? playerLane : lane,
                     y === undefined ? playerY - 10 : y);
        },
        forcarTrem: function (lane, y) {
            addTrem(lane === undefined ? playerLane : lane,
                    y === undefined ? playerY - 30 : y);
        },
        limpar: function () { entities.clear(); }
    };
}

// ------------------------------------------------------- sono da tela ------
// com a tela apagada o loop para; pausar a partida evita perder no escuro
E.onSleep = function () {
    if (E.sceneName === "jogo" && !pausado) pausar();
};
E.onWake = function () { E.redraw(); };

// ------------------------------------------------------------------ cenas ---
E.run({
    menu: {
        static: true,
        fps: 30,
        enter: function () {
            dlg = null;
            this.static = true;
            fxClear();
        },
        update: function () {
            if (dlg && !dlg.closed) E.redraw();
        },
        draw: function () {
            E.gfx.gradient(0, 0, W, H, TK.surface, TK.bg, { screen: true });
            if (!desenhaFundo(0, H - 140, W, 140)) {
                var alt = [30, 52, 24, 64, 40, 58, 28, 46];
                for (var i = 0; i < 8; i++) {
                    E.gfx.rect(i * 30, H - alt[i], 26, alt[i], T.accentD, { screen: true });
                }
            }
            E.ui.badge("v3.1", 6, 6, { color: TK.accent2 });
            if (dlg) {
                if (!dlg.draw(18, 72, 204)) {
                    dlg = null;
                    this.static = true;
                    E.redraw();
                }
                return;
            }
            var act = E.ui.title({ game: "NEON SURFER", subtitle: "corra, desvie, colete",
                                   best: hi, extra: "Como jogar", bg: false });
            if (act === "start") {
                E.goto("jogo", { transition: "fade", ms: 400 });
                return;
            }
            if (act === "extra") {
                dlg = E.ui.dialog(COMO_JOGAR, { name: "COMO JOGAR", speed: 45, sound: true });
                this.static = false;
                sfx("ui");
                return;
            }
            if (E.ui.button("Ajustes", W / 2 - 60, 258, 120, 30, { variant: "secondary" })) {
                E.goto("ajustes", { transition: "wipe", ms: 250 });
            }
        }
    },

    ajustes: {
        static: true,
        fps: 30,
        update: function () {
            if (E.input.down || E.input.tap) E.redraw();
        },
        draw: function () {
            E.gfx.gradient(0, 0, W, H, TK.surface, TK.bg, { screen: true });
            if (E.ui.iconButton("back", 4, 4, 32, { variant: "secondary" })) {
                E.goto("menu", { transition: "wipe", ms: 250 });
                return;
            }
            E.gfx.text("AJUSTES", 46, 9, { ts: "title", color: TK.text, screen: true });

            var c = E.ui.card(8, 52, W - 16, 152, { pad: 12 });
            var y = c.y;
            var f0 = showFPS, t0 = showTemp, p0 = showProf;
            showFPS = E.ui.toggle(c.x, y, showFPS, { label: "contador de FPS" });
            y += 36;
            showTemp = E.ui.toggle(c.x, y, showTemp, { label: "temperatura" });
            y += 36;
            showProf = E.ui.toggle(c.x, y, showProf, { label: "perfil E.prof" });
            y += 38;
            E.ui.divider(c.x, y - 8, c.w);
            E.gfx.text("engine " + E.version + "  UI " + E.ui.version,
                       c.x, y, { ts: "tiny", color: TK.textDim, fit: c.w, screen: true });

            if (f0 !== showFPS) E.save.set("aj.fps", showFPS ? 1 : 0);
            if (t0 !== showTemp) E.save.set("aj.tmp", showTemp ? 1 : 0);
            if (p0 !== showProf) { E.save.set("aj.prof", showProf ? 1 : 0); E.prof.on = showProf; }
            // o widget desenha antes de devolver o novo estado: sem um redraw
            // a cena static ficaria com o switch velho no vidro
            if (f0 !== showFPS || t0 !== showTemp || p0 !== showProf) E.redraw();

            E.gfx.text("ajustes salvos no aparelho", W / 2, 300,
                       { ts: "small", align: "center", color: TK.textDim, screen: true });
        }
    },

    jogo: {
        fps: 60,
        enter: function () {
            resetGame();
            pausado = false;
            armaJogo();
            drawHud();
        },
        exit: function () {
            fxClear();
            stk.finger = null;
            stk.active = false;
            pausado = false;
            E.dirty.off();
        },
        update: function (dt) {
            if (pausado) {
                this.fps = 20;
                return;
            }
            this.fps = 60;
            if (showTemp && typeof S.getTemperature === "function") {
                try { tempTxt = Math.round(S.getTemperature()) + "\u00B0C"; } catch (e) {}
            }
            var i = E.input;
            leStick();
            if (i.justDown) {
                pressT = S.millis();
                pressPause = i.y < HUD_H;
            } else if (i.justUp && !i.moved) {
                // toque seco do primario: pausa no botao, ATAQUE no resto da
                // pista (o traco/deslize e o controle; o tap virou acao)
                if (pressPause) {
                    if (E.hit(PAUSE_B)) { pausar(); return; }
                } else {
                    atacar(i.x, i.y);
                }
            }
            if (toquePausaExtra()) { pausar(); return; }
            simula(dt);
            if (morto) return;
            var m = Math.floor(score / 1000);
            if (m > marco) {
                marco = m;
                pText(W / 2, HUD_H + 20, (m * 1000) + "!", T.accent);
                sfx("ok");
            }
            drawHud();
        },
        draw: function () {
            if (pausado) {
                var act = E.ui.pause({ title: "PAUSA", clear: true,
                                       labels: ["Continuar", "Recomecar", "Sair"] });
                if (act === "resume") { retomar(); sfx("ui"); }
                else if (act === "restart") {
                    resetGame();
                    retomar();
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
        // camada suja DESLIGADA ao sair do jogo: ela ficava ligada com o
        // recorte da pista e repintava a estrada por cima do card de fim
        // (so o botao Sair aparecia solto no meio do asfalto)
        enter: function () { fxClear(); if (E.dirty) E.dirty.off(); },
        draw: function () {
            E.gfx.gradient(0, 0, W, H, TK.surface, TK.bg, { screen: true });
            var act = E.ui.gameOver({ title: "BATEU", score: score, best: hi,
                                      isNew: newRecord, clear: true });
            if (act === "again") E.goto("jogo", { transition: "wipe", ms: 300 });
            else if (act === "quit") E.goto("menu", { transition: "wipe", ms: 300 });
        }
    }
}, "menu");
