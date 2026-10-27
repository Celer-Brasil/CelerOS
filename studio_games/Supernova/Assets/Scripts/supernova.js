// supernova.js - controlador da versao NATIVA do Supernova no Celer Studio.
// Cenas: Titulo / Campanha / Infinito / Vitoria / Fim. A nave e uma entidade
// da cena (sprite do atlas); inimigos, tiros, orbes e HUD sao desenhados pelo
// controlador. Campanha = 10 ondas com chefe a cada 5; Infinito = endless.

var SONG = {
    bpm: 132, loops: 8,
    tracks: [
        { drum: true, vol: 70, notes: [
            [36, 2], [42, 1], [42, 1], [38, 2], [42, 1], [42, 1],
            [36, 1], [36, 1], [42, 1], [42, 1], [38, 2], [42, 2],
            [36, 2], [42, 1], [42, 1], [38, 2], [36, 1], [36, 1],
            [42, 1], [42, 1], [38, 1], [38, 1], [42, 1], [42, 1], [42, 2]
        ] },
        { wave: 'tri', vol: 55, notes: [
            [45, 2], [45, 2], [57, 2], [45, 2], [45, 2], [57, 2], [45, 2], [45, 2],
            [41, 2], [41, 2], [53, 2], [41, 2], [41, 2], [53, 2], [41, 2], [41, 2],
            [43, 2], [43, 2], [55, 2], [43, 2], [43, 2], [55, 2], [43, 2], [43, 2],
            [45, 2], [45, 2], [57, 2], [45, 2], [45, 2], [57, 2], [45, 2], [45, 2]
        ] },
        { wave: 'sq', vol: 38, notes: [
            [69, 2], [0, 2], [72, 2], [0, 2], [76, 4], [74, 4],
            [72, 2], [0, 2], [69, 2], [0, 2], [71, 4], [69, 4],
            [72, 2], [0, 2], [76, 2], [0, 2], [79, 4], [77, 4],
            [76, 2], [74, 2], [72, 2], [71, 2], [69, 6], [0, 2]
        ] }
    ]
};

var CIANO = 0x07FF, CIANOD = 0x03EF, MAGENTA = 0xF81F, LARANJA = 0xFD20;
var OURO = 0xFFE0, BRANCO = 0xFFFF, VERDE = 0x07E0, VERMELHO = 0xF800;
var ESCURO = 0x0861, PAINEL = 0x10C3, TEXTO = 0xE71C, TEXTO2 = 0x9CF3;

var HIT_R = 14;

// naves.png: grade 8x3 de 48 px (text2d generate/vfx/items). Par = normal,
// impar = silhueta branca do golpe; nomes prontos (concatenar por quadro
// pesa no Duktape)
var N = [];
for (var _n = 0; _n < 24; _n++) N.push('naves#n' + _n);
var ENEMY_ART = { drone: 0, sentinel: 2, splitter: 4, mini: 6 };
var A_BOOM = 8, A_ORB = 14, A_TRIPLE = 16, A_LIFE = 17;
var BOSS_ART = ['chefe#c0', 'chefe#c1'];
var OPT_ART = { key: 0xF81F };
var OPT_BOOM2 = { key: 0xF81F, scale: 2 };
var BG_BAKE = { scale: 2, ax: 0, ay: 0, key: null };
var BOOM_T = 0.05;          // segundos por quadro da explosao (6 quadros)
var DROP_NAME = { orb: '+25', triple: 'TIRO TRIPLO', life: '+1 VIDA' };
var BOOM_CYAN = [0x07FF, 0xFFFF];
var BOOM_GOLD = [0xFFE0, 0xFD20, 0xFFFF];
var UI_THEME = { accent: '#22e4ff', accent2: '#7a4dff', onAccent: 0x0000, radius: 14 };

function C(hex) {
    return ((hex >> 19) & 31) << 11 | ((hex >> 10) & 63) << 5 | ((hex >> 3) & 31);
}

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function dist2(ax, ay, bx, by) {
    var dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
}
function rnd() { return Math.random(); }

exports.create = function (ctx) { return { ctx: ctx }; };

exports.start = function (ctx) {
    var s = this;
    var E = s.E = ctx.E;
    s.ctx = ctx;
    s.scene = ctx.scene;
    s.W = E.W;
    s.H = E.H;
    s.U = E.U;
    s.screen = (ctx.scene.data && ctx.scene.data.screen) || 'title';
    s.best = E.save.num('best', 0);
    s.score = E.data.score || 0;
    s.mode = (ctx.scene.data && ctx.scene.data.mode) || 'campaign';
    s.maxWave = (ctx.scene.data && ctx.scene.data.maxWave) || 10;
    s.wave = 0;
    s.lives = 3;
    s.charge = 0;
    s.streak = 0;
    s.streakT = 0;
    s.mult = 1;
    s.kills = 0;
    s.triple = 0;
    s.over = false;
    s.overT = 0;
    s.won = false;
    s.paused = false;
    s.newBest = false;
    s.enemies = [];
    s.bullets = [];
    s.ebullets = [];
    s.orbs = [];
    s.stars = [];
    s.waveQueue = [];
    s.waveT = 0;
    s.nextWaveT = 0.9;
    s.waveActive = false;
    s.boss = null;
    s.bossPhase = 0;
    s.superT = 0;
    s.msg = '';
    s.msgT = 0;
    s.player = null;
    s.playerEnt = null;
    s.act = null;
    s.grab = false;

    if (typeof __harness !== 'undefined') __harness.supernova = s;
    if (E.ui) {
        E.ui.preset('neon');
        E.ui.theme(UI_THEME);
    }

    if (s.screen === 'title') {
        if (E.audio) E.audio.music(SONG);
    } else if (s.screen === 'win' || s.screen === 'lose') {
        s.mode = E.data.mode || 'campaign';
        s.score = E.data.score || 0;
        s.best = E.save.num('best', 0);
        s.newBest = !!(E.data.newBest);
        if (E.audio) E.audio.music(SONG);
    } else {
        startGame(s, ctx);
    }
};

function startGame(s, ctx) {
    var E = s.E = ctx.E;
    var d = ctx.scene.data || {};
    s.mode = d.mode || 'campaign';
    s.maxWave = d.maxWave || (s.mode === 'endless' ? 999 : 10);
    s.W = E.W; s.H = E.H; s.U = E.U;
    s.HUD_H = Math.round(22 * E.U);
    s.top = 0;
    s.bot = s.H - s.HUD_H;
    s.playH = s.bot;
    s.player = { x: s.W / 2, y: s.H * 0.8, r: HIT_R, cool: 0, invuln: 1.2, vx: 0 };
    s.playerEnt = ctx.scene.find('Nave');
    if (s.playerEnt) {
        s.playerEnt.x = s.player.x;
        s.playerEnt.y = s.player.y;
        s.playerEnt.active = true;
    }
    s.bgEnt = ctx.scene.find('Fundo');
    s.enemies = [];
    s.bullets = [];
    s.ebullets = [];
    s.orbs = [];
    s.waveQueue = [];
    // campo de estrelas da engine: so as que mudaram de pixel pintam, e a
    // area para antes do HUD (estrela nao suja a caixa memoizada)
    s.stars = E.fx ? E.fx.stars(56, { h: s.bot, vy: 70, stride: 2,
                                      colors: [0x8410, 0xCE79] }) : null;
    s.booms = [];
    s.t = 0;
    s.art = !!(E.spr && E.spr.has && E.spr.has(N[0]));
    setupBackground(s, E, ctx);
    s.wave = 0;
    s.waveActive = false;
    s.nextWaveT = 0.9;
    s.score = 0;
    s.lives = 3;
    s.charge = 0;
    s.streak = 0;
    s.streakT = 0;
    s.mult = 1;
    s.kills = 0;
    s.triple = 0;
    s.over = false;
    s.overT = 0;
    s.won = false;
    s.paused = false;
    s.boss = null;
    s.bossPhase = 0;
    s.superT = 0;
    s.msg = '';
    s.msgT = 0;
    s.newBest = false;
    if (E.audio) E.audio.music(SONG);
}

exports.update = function (dt, ctx) {
    var s = this, E = s.E;
    if (s.screen === 'title') return updateTitle(s, E, ctx);
    if (s.screen === 'win' || s.screen === 'lose') return updateEnd(s, E, ctx);
    updateGame(s, E, ctx, dt);
};

// os widgets do kit de UI decidem no draw e deixam a acao em s.act; o
// update do quadro seguinte a executa (troca de cena fora do draw)
function takeAct(s) {
    var a = s.act;
    s.act = null;
    return a;
}

function updateTitle(s, E, ctx) {
    var a = takeAct(s);
    if (a === 'camp' || a === 'endless') {
        if (E.audio) E.audio.sfx('ok');
        E.data.score = 0;
        E.data.mode = a === 'camp' ? 'campaign' : 'endless';
        ctx.go(a === 'camp' ? 'Campanha' : 'Infinito');
    }
}

function updateEnd(s, E, ctx) {
    var a = takeAct(s);
    if (a === 'again') {
        E.data.score = 0;
        ctx.go(s.mode === 'endless' ? 'Infinito' : 'Campanha');
    } else if (a === 'title') {
        ctx.go('Titulo');
    }
}

function inRect(r, x, y) {
    return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

function updateGame(s, E, ctx, dt) {
    if (s.over) {
        s.overT -= dt;
        if (s.overT <= 0) {
            E.data.score = s.score;
            E.data.mode = s.mode;
            E.data.newBest = s.newBest;
            ctx.go('Fim');
        }
        return;
    }
    if (s.won) {
        s.overT -= dt;
        if (s.overT <= 0) {
            E.data.score = s.score;
            E.data.mode = s.mode;
            E.data.newBest = s.newBest;
            ctx.go('Vitoria');
        }
        return;
    }
    var act = takeAct(s);
    if (s.paused) {
        if (act === 'resume') { s.paused = false; E.redraw(); }
        else if (act === 'menu') ctx.go('Titulo');
        return;
    }
    // pausa/SUPER no press: o arrasto da nave nao espera o release
    if (E.input.justDown) {
        if (inRect(BTN_PAUSE, E.input.x, E.input.y)) { s.paused = true; s.grab = true; return; }
        if (inRect(BTN_SUPER, E.input.x, E.input.y)) {
            s.grab = true;
            if (s.charge >= 100) fireSuper(s, E);
            return;
        }
        s.grab = false;
    }

    if (s.msgT > 0) { s.msgT -= dt; if (s.msgT <= 0) s.msg = ''; }
    if (s.triple > 0) s.triple -= dt;
    if (s.streakT > 0) {
        s.streakT -= dt;
        if (s.streakT <= 0) { s.streak = 0; s.mult = 1; }
    }
    if (s.superT > 0) s.superT -= dt;

    var p = s.player;
    if (E.input.down && !s.grab) p.x = clamp(p.x + E.input.dx, 30, s.W - 30);
    if (!E.input.down) s.grab = false;
    p.y = s.H * 0.8;
    if (p.invuln > 0) {
        p.invuln -= dt;
        if (s.playerEnt) s.playerEnt.active = Math.floor(p.invuln * 12) % 2 === 0;
        if (p.invuln <= 0 && s.playerEnt) s.playerEnt.active = true;
    }

    // tiro automatico
    p.cool -= dt;
    if (p.cool <= 0) {
        p.cool = 0.16;
        firePlayer(s);
    }

    s.t += dt;
    if (s.stars) s.stars.update(dt);
    updateBooms(s, dt);
    updateWave(s, E, dt);
    updateEnemies(s, E, dt);
    updateBullets(s, E, dt);
    updateOrbs(s, E, dt);
    if (s.playerEnt) {
        s.playerEnt.x = p.x;
        s.playerEnt.y = p.y;
    }
}

function updateBooms(s, dt) {
    for (var i = s.booms.length - 1; i >= 0; i--) {
        s.booms[i].t += dt;
        if (s.booms[i].t >= BOOM_T * 6) s.booms.splice(i, 1);
    }
}

function addBoom(s, x, y, big) {
    if (s.booms.length >= 12) s.booms.shift();
    s.booms.push({ x: x, y: y, t: 0, big: !!big });
}

// fundo: a nebulosa de 240 px (limite de 128 KB por asset) e assada em 2x
// num slot de tela na entrada; a camada suja restaura cada caixa com um
// blitSprite (o Fundo antigo, 192 px em escala 2.5, era um afim de tela
// cheia por quadro). O host nao pinta blit: la a entidade em escala 2 fica
function setupBackground(s, E, ctx) {
    s.bgEnt = ctx.scene.find('Fundo');
    s.bg = 0;
    if (typeof __harness !== 'undefined') return;
    if (!E.spr || !E.spr.has || !E.spr.has('fundo') || !E.slots || !E.slots.create ||
        typeof System === 'undefined' || typeof System.blitSprite !== 'function' ||
        !E.dirty || !E.dirty.enable) return;
    var slot = E.slots.create('supernova:fundo', s.W, s.H);
    if (!slot) return;
    E.dirty._mute++;
    System.useSprite(slot);
    E.spr.alvo = slot;
    System.fillScreen(0);
    E.spr.stamp('fundo', 0, 0, BG_BAKE);
    E.spr.alvo = 0;
    System.useSprite(0);
    E.dirty._mute--;
    s.bg = slot;
    if (s.bgEnt) s.bgEnt.active = false;
    E.dirty.enable(function (x, y, w, h) {
        System.fillRect(x, y, w, h, 0);
        System.blitSprite(slot, x, y, w, h);
    });
    E.redraw();
}

exports.destroy = function () {
    var s = this, E = s.E;
    if (s && s.bg && E && E.slots) E.slots.release(s.bg);
    if (s) s.bg = 0;
};

// ------------------------------------------------------------- ondas ----

function waveDef(n) {
    var base = [
        { groups: [{ type: 'drone', n: 4, every: 0.85 }], rest: 1.7 },
        { groups: [{ type: 'drone', n: 4, every: 0.70 },
                   { type: 'sentinel', n: 1, every: 0, delay: 1.2 }], rest: 1.7 },
        { groups: [{ type: 'splitter', n: 2, every: 1.1 },
                   { type: 'drone', n: 3, every: 0.8, delay: 0.5 }], rest: 1.9 },
        { groups: [{ type: 'sentinel', n: 2, every: 1.4 },
                   { type: 'drone', n: 5, every: 0.65, delay: 0.7 }], rest: 2.2 }
    ];
    return base[(n - 1) % 4];
}

function startWave(s, E, n) {
    s.wave = n;
    s.waveActive = true;
    s.waveT = 0;
    s.waveQueue = [];
    if (n % 5 === 0) {
        spawnBoss(s, E, n);
        if (E.fx) E.fx.popText(s.W / 2, s.H * 0.28, 'SENTINELA-MOR', { color: MAGENTA, life: 1.2 });
        return;
    }
    var def = waveDef(n);
    var extra = Math.floor((n - 1) / 4);
    for (var g = 0; g < def.groups.length; g++) {
        var gr = def.groups[g];
        var count = gr.n + (gr.type === 'drone' ? extra : 0);
        var every = gr.every > 0 ? gr.every : 0.01;
        var delay = gr.delay || 0;
        for (var i = 0; i < count; i++) {
            s.waveQueue.push({ t: delay + i * every, type: gr.type });
        }
    }
    s.waveQueue.sort(function (a, b) { return a.t - b.t; });
    if (n > 1 && E.fx) E.fx.popText(s.W / 2, s.H * 0.28, 'ONDA ' + n,
        { color: CIANO, life: 0.8 });
}

function updateWave(s, E, dt) {
    if (!s.waveActive) {
        if (s.wave >= s.maxWave) return;
        s.nextWaveT -= dt;
        if (s.nextWaveT <= 0) startWave(s, E, s.wave + 1);
        return;
    }
    s.waveT += dt;
    while (s.waveQueue.length && s.waveQueue[0].t <= s.waveT) {
        var q = s.waveQueue.shift();
        spawnEnemy(s, E, q.type);
    }
    if (!s.waveQueue.length && !s.enemies.length) {
        if (s.wave >= s.maxWave) {
            winGame(s, E);
            return;
        }
        s.waveActive = false;
        s.nextWaveT = 1.7;
    }
}

function spawnEnemy(s, E, type) {
    var W = s.W;
    var e = { type: type, x: 40 + Math.random() * (W - 80), y: s.top - 24,
              hp: 1, maxhp: 1, r: 20, speed: 46, t: 0, cool: 1.2, seed: Math.random() * 9 };
    if (type === 'drone') { e.hp = 1; e.maxhp = 1; e.r = 20; e.speed = 46; }
    else if (type === 'sentinel') { e.hp = 3; e.maxhp = 3; e.r = 24; e.speed = 28; e.cool = 1.6; }
    else if (type === 'splitter') { e.hp = 2; e.maxhp = 2; e.r = 20; e.speed = 38; }
    else if (type === 'mini') { e.hp = 1; e.maxhp = 1; e.r = 12; e.speed = 85; e.mini = true; }
    s.enemies.push(e);
}

function spawnBoss(s, E, n) {
    var b = { type: 'boss', x: s.W / 2, y: s.top - 60, hp: 26 + 3 * n, maxhp: 26 + 3 * n,
              r: 46, speed: 34, t: 0, cool: 1.8, alt: 0, seed: 1.7, boss: true };
    s.boss = b;
    s.enemies.push(b);
    s.bossPhase = 0;
}

// ------------------------------------------------------------- combate ----

function firePlayer(s) {
    var p = s.player;
    var n = s.triple > 0 ? 3 : 2;
    for (var i = 0; i < n; i++) {
        var vx = (i - (n - 1) / 2) * 95;
        s.bullets.push({ x: p.x + (i - (n - 1) / 2) * 8, y: p.y - 24,
                         vx: vx, vy: -560, r: 3.2, dmg: 1 });
    }
}

function fireSuper(s, E) {
    s.charge = 0;
    s.superT = 0.55;
    s.ebullets.length = 0;
    var all = s.enemies;
    for (var i = all.length - 1; i >= 0; i--) {
        var e = all[i];
        e.hp -= 15;
        e.flash = 0.2;
        if (e.hp <= 0) killEnemy(s, E, e, i, true);
    }
    if (E.fx) {
        E.fx.flash(CIANO, 260, { full: true });
        E.fx.burst(s.W / 2, s.H / 2, { n: 40, color: CIANO, speed: 260, life: 0.7 });
    }
    if (E.audio) E.audio.sfx([90, 140, 220, 330, 494, 740, 1109],
        { gap: 0 });
    s.msg = 'SUPERNOVA!';
    s.msgT = 1.2;
}

function updateEnemies(s, E, dt) {
    var p = s.player;
    for (var i = s.enemies.length - 1; i >= 0; i--) {
        var e = s.enemies[i];
        e.t += dt;
        e.cool -= dt;
        if (e.flash > 0) e.flash -= dt;
        if (e.boss) {
            if (e.y < s.top + 110) e.y += 40 * dt;
            e.x = s.W / 2 + Math.sin(e.t * 0.7 + e.seed) * (s.W * 0.22);
        } else {
            if (e.type === 'sentinel') {
                if (e.y < s.top + 120) e.y += e.speed * dt;
                else e.x += Math.sin(e.t * 1.4 + e.seed) * 22 * dt;
            } else if (e.type === 'mini') {
                e.y += e.speed * dt;
                e.x += (p.x > e.x ? 1 : -1) * 55 * dt;
            } else {
                e.y += e.speed * dt;
                e.x += Math.sin(e.t * 1.8 + e.seed) * 18 * dt;
            }
            if (e.y > s.bot + 30 || e.x < -50 || e.x > s.W + 50) {
                s.enemies.splice(i, 1);
                continue;
            }
        }
        // tiro inimigo
        if ((e.type === 'sentinel' || e.boss || e.type === 'splitter') && e.cool <= 0) {
            if (e.boss) bossShoot(s, E, e);
            // rearma: sem isto o cool ficava <= 0 e o inimigo atirava todo
            // quadro (um "laser" de tiros colados)
            else if (e.type === 'sentinel') { aimedFan(s, e.x, e.y, 3, 130); e.cool = 1.8; }
            else { aimedShot(s, e.x, e.y, 120); e.cool = 1.4; }
        }
        // corpo
        if (dist2(e.x, e.y, p.x, p.y) < (e.r + p.r) * (e.r + p.r)) {
            hurtPlayer(s, E);
            if (s.over) return;
        }
    }
    // fase do chefe
    if (s.boss && s.boss.hp > 0) {
        var frac = s.boss.hp / s.boss.maxhp;
        var ph = frac > 0.66 ? 1 : (frac > 0.33 ? 2 : 3);
        if (ph !== s.bossPhase) {
            s.bossPhase = ph;
            if (E.fx) E.fx.burst(s.boss.x, s.boss.y, { n: 18, color: LARANJA, speed: 150, life: 0.6 });
        }
    }
}

function bossShoot(s, E, b) {
    b.alt = (b.alt + 1) % 3;
    var ph = s.bossPhase || 1;
    if (b.alt === 0) {
        aimedFan(s, b.x, b.y, ph >= 3 ? 5 : 3, 145);
        b.cool = ph >= 3 ? 1.0 : 1.4;
    } else if (b.alt === 1) {
        var n = ph >= 3 ? 18 : (ph === 2 ? 14 : 12);
        var gap = Math.floor(Math.random() * n);
        for (var i = 0; i < n; i++) {
            if (i === gap || i === (gap + 1) % n) continue;
            var a = (i / n) * Math.PI * 2;
            s.ebullets.push({ x: b.x, y: b.y, vx: Math.cos(a) * 105, vy: Math.sin(a) * 105,
                              r: 5, color: MAGENTA });
        }
        b.cool = 1.6;
    } else {
        aimedShot(s, b.x, b.y, 175);
        b.cool = 0.8;
    }
    if (E.audio) E.audio.sfx('hit', { gap: 90 });
}

function aimedShot(s, x, y, speed) {
    var p = s.player;
    var dx = p.x - x, dy = p.y - y;
    var d = Math.sqrt(dx * dx + dy * dy) || 1;
    s.ebullets.push({ x: x, y: y, vx: dx / d * speed, vy: dy / d * speed,
                      r: 4.5, color: LARANJA });
}

function aimedFan(s, x, y, n, speed) {
    var p = s.player;
    var base = Math.atan2(p.y - y, p.x - x);
    for (var i = 0; i < n; i++) {
        var a = base + (i - (n - 1) / 2) * 0.22;
        s.ebullets.push({ x: x, y: y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
                          r: 4.5, color: MAGENTA });
    }
}

function updateBullets(s, E, dt) {
    var p = s.player;
    var i, j;
    for (i = s.bullets.length - 1; i >= 0; i--) {
        var b = s.bullets[i];
        b.x += b.vx * dt; b.y += b.vy * dt;
        if (b.y < s.top - 20) { s.bullets.splice(i, 1); continue; }
        var hit = false;
        for (j = s.enemies.length - 1; j >= 0; j--) {
            var e = s.enemies[j];
            if (dist2(b.x, b.y, e.x, e.y) < (e.r + b.r) * (e.r + b.r)) {
                e.hp -= b.dmg;
                // chefe sob fogo continuo: 1 quadro de silhueta, nao 50% branco
                e.flash = e.boss ? 0.03 : 0.08;
                if (e.hp <= 0) killEnemy(s, E, e, j, false);
                hit = true;
                break;
            }
        }
        if (hit) s.bullets.splice(i, 1);
    }
    for (i = s.ebullets.length - 1; i >= 0; i--) {
        var eb = s.ebullets[i];
        eb.x += eb.vx * dt; eb.y += eb.vy * dt;
        if (eb.y < s.top - 20 || eb.y > s.bot + 10 || eb.x < -30 || eb.x > s.W + 30) {
            s.ebullets.splice(i, 1);
            continue;
        }
        if (dist2(eb.x, eb.y, p.x, p.y) < (p.r + eb.r) * (p.r + eb.r)) {
            s.ebullets.splice(i, 1);
            // hurtPlayer zera ebullets: seguir o laco lia indice morto
            // (TypeError a cada tiro levado sem morrer)
            hurtPlayer(s, E);
            return;
        }
    }
}

function updateOrbs(s, E, dt) {
    var p = s.player;
    for (var i = s.orbs.length - 1; i >= 0; i--) {
        var o = s.orbs[i];
        o.y += 58 * dt;
        if (o.y > s.bot) { s.orbs.splice(i, 1); continue; }
        if (dist2(o.x, o.y, p.x, p.y) < 30 * 30) {
            s.orbs.splice(i, 1);
            var k = o.kind || 'orb';
            if (k === 'triple') s.triple = 8;
            else if (k === 'life') s.lives = Math.min(3, s.lives + 1);
            else s.charge = clamp(s.charge + 25, 0, 100);
            s.score += 15;
            if (E.audio) E.audio.sfx('power', { gap: 60 });
            if (E.fx) E.fx.popText(o.x, o.y, DROP_NAME[k], { color: k === 'life' ? VERMELHO : (k === 'triple' ? OURO : CIANO), life: 0.7 });
        }
    }
}

function killEnemy(s, E, e, index, silent) {
    s.enemies.splice(index, 1);
    if (e === s.boss) s.boss = null;
    var pts = e.boss ? 300 : (e.type === 'sentinel' ? 30 : (e.type === 'splitter' ? 20 : (e.mini ? 5 : 10)));
    s.streak++;
    s.streakT = 2.2;
    s.mult = clamp(1 + Math.floor(s.streak / 8), 1, 5);
    s.score += pts * s.mult;
    s.kills++;
    if (E.audio && !silent) E.audio.sfx(e.boss ? 'boom' : 'hit', { gap: 40 });
    addBoom(s, e.x, e.y, e.boss);
    if (E.fx) {
        E.fx.burst(e.x, e.y, { n: e.boss ? 30 : 10, colors: e.boss ? BOOM_GOLD : BOOM_CYAN,
                               speed: e.boss ? 220 : 120, life: e.boss ? 0.8 : 0.35,
                               shape: 'spark' });
        if (e.boss) {
            E.fx.ring(e.x, e.y, { speed: 420, color: OURO });
            E.fx.flash(OURO, 260, { full: true });
        }
    }
    if (e.type === 'splitter' && !e.boss) {
        for (var k = 0; k < 2; k++) {
            s.enemies.push({ type: 'mini', x: e.x + (k ? 12 : -12), y: e.y + 8,
                             hp: 1, maxhp: 1, r: 12, speed: 85, t: 0, cool: 99,
                             seed: Math.random() * 9, mini: true });
        }
    }
    if (e.boss) {
        s.triple = 10;
        s.orbs.push({ x: e.x - 18, y: e.y, r: 12, kind: 'orb' });
        s.orbs.push({ x: e.x + 18, y: e.y, r: 12, kind: 'orb' });
        if (s.mode === 'campaign' && s.wave >= s.maxWave) winGame(s, E);
    } else {
        var roll = Math.random();
        if (roll < 0.11) s.orbs.push({ x: e.x, y: e.y, r: 12, kind: 'orb' });
        else if (roll < 0.135) s.orbs.push({ x: e.x, y: e.y, r: 12, kind: 'triple' });
        else if (roll < 0.15 && s.lives < 3) s.orbs.push({ x: e.x, y: e.y, r: 12, kind: 'life' });
    }
}

function hurtPlayer(s, E) {
    if (s.over || s.player.invuln > 0) return;
    s.player.invuln = 2.2;
    s.lives--;
    s.streak = 0;
    s.mult = 1;
    s.charge = Math.max(0, s.charge - 25);
    s.ebullets.length = 0;
    if (E.audio) E.audio.sfx('bad', { gap: 0 });
    if (E.fx) {
        E.fx.flash(VERMELHO, 220, { full: true });
        E.fx.burst(s.player.x, s.player.y, { n: 20, color: LARANJA, speed: 180, life: 0.5 });
        addBoom(s, s.player.x, s.player.y, false);
    }
    if (s.lives <= 0) {
        s.lives = 0;
        s.over = true;
        s.overT = 1.4;
        s.newBest = s.score > s.best;
        if (s.newBest) s.best = s.score;
        E.save.set('best', s.best);
        if (E.audio) E.audio.stop();
    }
}

function winGame(s, E) {
    if (s.won) return;
    s.won = true;
    s.overT = 1.4;
    s.newBest = s.score > s.best;
    if (s.newBest) s.best = s.score;
    E.save.set('best', s.best);
    if (E.audio) {
        E.audio.stop();
        E.audio.sfx('win', { gap: 0 });
    }
    if (E.fx) E.fx.flash(OURO, 300, { full: true });
}

// ---------------------------------------------------------------- draw ----

exports.draw = function (ctx) {
    var s = this, E = s.E;
    if (s.screen === 'title') return drawTitle(s, E);
    if (s.screen === 'win' || s.screen === 'lose') return drawEnd(s, E);
    drawGame(s, E);
};

// ---------------------------------------------------------------- menus

var LOGO_TXT = { px: 56, align: 'center', valign: 'middle', color: OURO,
                 outline: C(0x2A0838), screen: true };
var SUB_TXT = { px: 14, align: 'center', valign: 'middle', color: C(0xB8C4DC), screen: true };
var BTN_CAMP = { variant: 'primary', ts: 'label' };
var BTN_ENDL = { variant: 'secondary', icon: 'refresh' };
var BTN_AGAIN = { variant: 'primary', icon: 'refresh' };
var BTN_HOME = { variant: 'secondary', icon: 'home' };
var BIG_SHIP = { key: 0xF81F, scale: 2 };

function drawTitle(s, E) {
    var W = s.W;
    // a arte do titulo (parallax text2d) e a entidade TituloArte
    if (E.spr.has('nave')) E.spr.stamp('nave', W / 2, 150, BIG_SHIP);
    E.gfx.text('SUPERNOVA', W / 2, 262, LOGO_TXT);
    E.gfx.text('10 ondas  ·  chefe em 3 fases  ·  modo infinito', W / 2, 300, SUB_TXT);
    var c = E.ui.card(40, 318, W - 80, 150);
    if (E.ui.button('CAMPANHA', c.x, c.y, c.w - 110, 58, BTN_CAMP)) s.act = 'camp';
    E.ui.badge('REC ' + s.best, c.x + c.w - 100, c.y + 11, { w: 100, color: OURO, textColor: 0x0000 });
    if (E.ui.button('INFINITO', c.x, c.y + 70, c.w, 44, BTN_ENDL)) s.act = 'endless';
}

function drawEnd(s, E) {
    var W = s.W, win = s.screen === 'win';
    E.gfx.text(win ? 'SETOR LIVRE' : 'NAVE PERDIDA', W / 2, 70,
               { px: 30, align: 'center', valign: 'middle', color: win ? OURO : VERMELHO,
                 outline: 0x0000, screen: true });
    if (E.spr.has('nave')) E.spr.stamp('nave', W / 2, 160, BIG_SHIP);
    var c = E.ui.card(40, 230, W - 80, 230);
    E.gfx.text('PONTOS', c.x, c.y, SUB_LEFT);
    E.gfx.text('' + s.score, c.x, c.y + 20, SCORE_TXT);
    E.gfx.text('recorde ' + s.best, c.x, c.y + 64, SUB_LEFT);
    if (s.newBest) E.ui.badge('NOVO RECORDE!', c.x + c.w - 150, c.y + 24,
                              { w: 150, color: VERDE, textColor: 0x0000 });
    if (E.ui.button('DE NOVO', c.x, c.y + 100, c.w, 50, BTN_AGAIN)) s.act = 'again';
    if (E.ui.button('MENU', c.x + c.w / 2 - 80, c.y + 160, 160, 40, BTN_HOME)) s.act = 'title';
}

// ---------------------------------------------------------------- jogo

var SUB_LEFT = { px: 14, color: C(0xB8C4DC), screen: true };
var SCORE_TXT = { px: 30, color: CIANO, screen: true };
var BTN_PAUSE = { x: 10, y: 10, w: 48, h: 48 };
var BTN_SUPER = { x: 400, y: 8, w: 72, h: 72 };
var PAUSE_BTNS = [{ label: 'Menu', value: 'menu', icon: 'home' },
                  { label: 'Continuar', value: 'resume' }];
var BULLET = { r: 2, screen: true };
var EBUL = { fill: true, screen: true };
var RING_O = { fill: false, screen: true };
var BOSS_BAR = { fg: MAGENTA, bg: 0x3008 };
var BOSS_TXT = { px: 11, align: 'center', color: MAGENTA, outline: 0x0000, screen: true };
var MSG_TXT = { px: 28, align: 'center', valign: 'middle', color: OURO,
                outline: 0x0000, screen: true };
var OVER_TXT = { px: 30, align: 'center', valign: 'middle', color: VERMELHO,
                 outline: 0x0000, screen: true };
var SUPER_RING = { th: 6, color: CIANO, bg: 0x18E3 };
var SUPER_TXT = { px: 11, align: 'center', valign: 'middle', screen: true, color: TEXTO2 };
var PANEL_O = { r: 12, screen: true, bw: 2, stroke: CIANOD };

function drawGame(s, E) {
    var W = s.W, H = s.H, i, art = s.art;
    if (s.stars) s.stars.draw();
    // inimigos: silhueta branca no quadro do golpe (sem afim: escala 1)
    for (i = 0; i < s.enemies.length; i++) {
        var e = s.enemies[i];
        var hit = e.flash > 0 ? 1 : 0;
        if (!art) {
            E.gfx.circle(e.x, e.y, e.r, hit ? BRANCO : MAGENTA, EBUL);
        } else if (e.boss) {
            E.spr.stamp(BOSS_ART[hit], e.x, e.y, OPT_ART);
        } else {
            E.spr.stamp(N[ENEMY_ART[e.type] + hit], e.x, e.y, OPT_ART);
        }
    }
    // drops: orbe pulsa em 2 quadros
    for (i = 0; i < s.orbs.length; i++) {
        var o = s.orbs[i];
        var k = o.kind === 'triple' ? A_TRIPLE : (o.kind === 'life' ? A_LIFE :
                A_ORB + (Math.floor(s.t * 6) % 2));
        if (art) E.spr.stamp(N[k], o.x, o.y, OPT_ART);
        else E.gfx.circle(o.x, o.y, 10, CIANO, EBUL);
    }
    // explosoes (vfx text2d): 6 quadros; a do chefe em escala 2
    for (i = 0; i < s.booms.length; i++) {
        var bm = s.booms[i];
        var f = Math.floor(bm.t / BOOM_T);
        if (art && f < 6) E.spr.stamp(N[A_BOOM + f], bm.x, bm.y, bm.big ? OPT_BOOM2 : OPT_ART);
    }
    // tiros
    var bc = s.triple > 0 ? OURO : CIANO;
    for (i = 0; i < s.bullets.length; i++) {
        var b = s.bullets[i];
        E.gfx.rect(b.x - 2, b.y - 8, 4, 16, bc, BULLET);
    }
    for (i = 0; i < s.ebullets.length; i++) {
        var eb = s.ebullets[i];
        E.gfx.circle(eb.x, eb.y, eb.r, eb.color, EBUL);
        E.gfx.circle(eb.x - 1, eb.y - 1, 1.4, BRANCO, EBUL);
    }
    if (s.superT > 0) {
        E.gfx.circle(W / 2, H / 2, (0.55 - s.superT) * 900, CIANO, RING_O);
    }
    // chefe: barra no alto
    if (s.boss && E.ui) {
        E.ui.progress(W / 2 - 110, 14, 220, 12, s.boss.hp / s.boss.maxhp, BOSS_BAR);
        E.gfx.text('SENTINELA-MOR  ·  FASE ' + (s.bossPhase || 1), W / 2, 32, BOSS_TXT);
    }
    // pausa e SUPER (anel = carga)
    E.gfx.rect(BTN_PAUSE.x, BTN_PAUSE.y, BTN_PAUSE.w, BTN_PAUSE.h, C(0x0A1020), PANEL_O);
    E.ui.icon('pause', BTN_PAUSE.x + 12, BTN_PAUSE.y + 12, 24, { color: TEXTO });
    var full = s.charge >= 100;
    var scx = BTN_SUPER.x + BTN_SUPER.w / 2, scy = BTN_SUPER.y + BTN_SUPER.h / 2;
    E.gfx.circle(scx, scy, 28, full ? OURO : C(0x0A1020), EBUL);
    SUPER_RING.color = full ? BRANCO : CIANO;
    E.ui.ring(scx, scy, 35, s.charge / 100, SUPER_RING);
    SUPER_TXT.color = full ? 0x0000 : TEXTO2;
    E.gfx.text(full ? 'SUPER' : (s.charge | 0) + '%', scx, scy, SUPER_TXT);

    drawHud(s, E);
    if (s.msg) E.gfx.text(s.msg, W / 2, s.bot / 2, MSG_TXT);
    if (s.paused) {
        var r = E.ui.modal('pausa', { title: 'PAUSA', dismiss: false,
                                      body: 'onda ' + Math.max(1, s.wave) + '  ·  ' + s.score + ' pts',
                                      buttons: PAUSE_BTNS });
        if (r !== null) s.act = r;
    }
    if (s.over) E.gfx.text('NAVE PERDIDA', W / 2, s.bot / 2, OVER_TXT);
}

// HUD de baixo pelo E.ui.hud: memoizado pela assinatura (o antigo repintava
// 10 textos e 2 barras por quadro)
var HUD_O = { y: 0, h: 0, lives: 3, maxLives: 3, level: '', score: 0, best: 0,
              bg: C(0x080C16), left: null };
var HUD_L = [{ icon: null, text: 'x1', color: TEXTO2 },
             { icon: 'plus', text: '', color: OURO }];
var HUD_L1 = [HUD_L[0]];

function drawHud(s, E) {
    if (!E.ui) return;
    HUD_O.y = s.bot;
    HUD_O.h = s.HUD_H;
    HUD_O.lives = s.lives;
    HUD_O.level = 'ONDA ' + Math.max(1, s.wave) + (s.mode === 'campaign' ? '/' + s.maxWave : '');
    HUD_O.score = s.score;
    HUD_O.best = s.best;
    HUD_L[0].text = 'x' + s.mult;
    HUD_L[0].color = s.mult > 1 ? OURO : TEXTO2;
    if (s.triple > 0) {
        HUD_L[1].text = 'TRIPLO ' + Math.ceil(s.triple);
        HUD_O.left = HUD_L;
    } else HUD_O.left = HUD_L1;
    E.ui.hud(HUD_O);
}
