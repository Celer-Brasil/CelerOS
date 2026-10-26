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

var HUD_H = 64;
var PLAYER_Y = 384;
var HIT_R = 14;

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
    s.btnPause = null;
    s.btnSuper = null;
    s.btnResume = null;
    s.btnMenuPause = null;
    s.btnRetry = null;
    s.btnMenuEnd = null;
    s.btnAgain = null;
    s.btnTitle = null;

    if (typeof __harness !== 'undefined') __harness.supernova = s;

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
    s.HUD_H = Math.round(32 * E.U);
    s.playH = s.H - s.HUD_H;
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
    s.stars = [];
    for (var i = 0; i < 64; i++) {
        s.stars.push({ x: Math.random() * s.W, y: s.HUD_H + Math.random() * s.playH,
                       z: 1 + Math.floor(Math.random() * 3), v: 18 + Math.random() * 90 });
    }
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

function updateTitle(s, E, ctx) {
    if (s.btnCamp && E.hit(s.btnCamp)) {
        E.audio && E.audio.sfx('ok');
        E.data.score = 0;
        E.data.mode = 'campaign';
        ctx.go('Campanha');
    } else if (s.btnEnd && E.hit(s.btnEnd)) {
        E.audio && E.audio.sfx('ok');
        E.data.score = 0;
        E.data.mode = 'endless';
        ctx.go('Infinito');
    }
}

function updateEnd(s, E, ctx) {
    if (s.btnAgain && E.hit(s.btnAgain)) {
        E.data.score = 0;
        ctx.go(s.mode === 'endless' ? 'Infinito' : 'Campanha');
    } else if (s.btnTitle && E.hit(s.btnTitle)) {
        ctx.go('Titulo');
    }
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
    if (s.paused) {
        if (s.btnResume && E.hit(s.btnResume)) s.paused = false;
        else if (s.btnMenuPause && E.hit(s.btnMenuPause)) ctx.go('Titulo');
        return;
    }
    if (s.btnPause && E.hit(s.btnPause)) { s.paused = true; return; }
    if (s.btnSuper && s.charge >= 100 && E.hit(s.btnSuper)) {
        fireSuper(s, E);
        return;
    }

    if (s.msgT > 0) { s.msgT -= dt; if (s.msgT <= 0) s.msg = ''; }
    if (s.triple > 0) s.triple -= dt;
    if (s.streakT > 0) {
        s.streakT -= dt;
        if (s.streakT <= 0) { s.streak = 0; s.mult = 1; }
    }
    if (s.superT > 0) s.superT -= dt;

    var p = s.player;
    if (E.input.down) p.x = clamp(p.x + E.input.dx, 30, s.W - 30);
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

    updateStars(s, dt);
    updateWave(s, E, dt);
    updateEnemies(s, E, dt);
    updateBullets(s, E, dt);
    updateOrbs(s, E, dt);
    if (s.playerEnt) {
        s.playerEnt.x = p.x;
        s.playerEnt.y = p.y;
    }
}

function updateStars(s, dt) {
    var st = s.stars;
    for (var i = 0; i < st.length; i++) {
        var o = st[i];
        o.y += o.v * dt;
        if (o.y > s.H + 2) {
            o.y = s.HUD_H - 2;
            o.x = Math.random() * s.W;
        }
    }
}

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
    var e = { type: type, x: 40 + Math.random() * (W - 80), y: s.HUD_H + 24,
              hp: 1, maxhp: 1, r: 20, speed: 46, t: 0, cool: 1.2, seed: Math.random() * 9 };
    if (type === 'drone') { e.hp = 1; e.maxhp = 1; e.r = 20; e.speed = 46; }
    else if (type === 'sentinel') { e.hp = 3; e.maxhp = 3; e.r = 24; e.speed = 28; e.cool = 1.6; }
    else if (type === 'splitter') { e.hp = 2; e.maxhp = 2; e.r = 20; e.speed = 38; }
    else if (type === 'mini') { e.hp = 1; e.maxhp = 1; e.r = 12; e.speed = 85; e.mini = true; }
    s.enemies.push(e);
}

function spawnBoss(s, E, n) {
    var b = { type: 'boss', x: s.W / 2, y: s.HUD_H + 50, hp: 26 + 3 * n, maxhp: 26 + 3 * n,
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
            if (e.y < s.HUD_H + 90) e.y += 32 * dt;
            e.x = s.W / 2 + Math.sin(e.t * 0.7 + e.seed) * (s.W * 0.22);
        } else {
            if (e.type === 'sentinel') {
                if (e.y < s.HUD_H + 105) e.y += e.speed * dt;
                else e.x += Math.sin(e.t * 1.4 + e.seed) * 22 * dt;
            } else if (e.type === 'mini') {
                e.y += e.speed * dt;
                e.x += (p.x > e.x ? 1 : -1) * 55 * dt;
            } else {
                e.y += e.speed * dt;
                e.x += Math.sin(e.t * 1.8 + e.seed) * 18 * dt;
            }
            if (e.y > s.H + 40 || e.x < -50 || e.x > s.W + 50) {
                s.enemies.splice(i, 1);
                continue;
            }
        }
        // tiro inimigo
        if ((e.type === 'sentinel' || e.boss || e.type === 'splitter') && e.cool <= 0) {
            if (e.boss) bossShoot(s, E, e);
            else if (e.type === 'sentinel') aimedFan(s, e.x, e.y, 3, 130);
            else aimedShot(s, e.x, e.y, 120);
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
        if (b.y < s.HUD_H - 20) { s.bullets.splice(i, 1); continue; }
        var hit = false;
        for (j = s.enemies.length - 1; j >= 0; j--) {
            var e = s.enemies[j];
            if (dist2(b.x, b.y, e.x, e.y) < (e.r + b.r) * (e.r + b.r)) {
                e.hp -= b.dmg;
                e.flash = 0.08;
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
        if (eb.y < s.HUD_H - 20 || eb.y > s.H + 30 || eb.x < -30 || eb.x > s.W + 30) {
            s.ebullets.splice(i, 1);
            continue;
        }
        if (dist2(eb.x, eb.y, p.x, p.y) < (p.r + eb.r) * (p.r + eb.r)) {
            s.ebullets.splice(i, 1);
            hurtPlayer(s, E);
            if (s.over) return;
        }
    }
}

function updateOrbs(s, E, dt) {
    var p = s.player;
    for (var i = s.orbs.length - 1; i >= 0; i--) {
        var o = s.orbs[i];
        o.y += 58 * dt;
        if (o.y > s.H + 20) { s.orbs.splice(i, 1); continue; }
        if (dist2(o.x, o.y, p.x, p.y) < 28 * 28) {
            s.orbs.splice(i, 1);
            s.charge = clamp(s.charge + 25, 0, 100);
            s.score += 15;
            if (E.audio) E.audio.sfx('power', { gap: 60 });
            if (E.fx) E.fx.popText(o.x, o.y, '+25', { color: CIANO, life: 0.6 });
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
    if (E.fx) E.fx.burst(e.x, e.y, { n: e.boss ? 30 : 12, color: e.boss ? OURO : CIANO,
                                     speed: e.boss ? 220 : 120, life: e.boss ? 0.8 : 0.4 });
    if (e.type === 'splitter' && !e.boss) {
        for (var k = 0; k < 2; k++) {
            s.enemies.push({ type: 'mini', x: e.x + (k ? 12 : -12), y: e.y + 8,
                             hp: 1, maxhp: 1, r: 12, speed: 85, t: 0, cool: 99,
                             seed: Math.random() * 9, mini: true });
        }
    }
    if (e.boss) {
        s.triple = 10;
        s.orbs.push({ x: e.x - 18, y: e.y, r: 12 });
        s.orbs.push({ x: e.x + 18, y: e.y, r: 12 });
        if (s.mode === 'campaign' && s.wave >= s.maxWave) winGame(s, E);
    } else if (Math.random() < 0.12) {
        s.orbs.push({ x: e.x, y: e.y, r: 12 });
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

function drawTitle(s, E) {
    var W = s.W, H = s.H;
    // a arte do titulo e uma entidade; esta faixa cobre a parte de baixo
    E.gfx.rect(0, 236, W, H - 236, C(0x05060A), { screen: true });
    E.gfx.text('SUPERNOVA', W / 2, 270, { px: 44, align: 'center', valign: 'middle',
        color: OURO, shadow: 0x0000 });
    E.gfx.text('campanha de 10 ondas  ·  chefe final', W / 2, 310,
        { px: 14, align: 'center', color: TEXTO2 });
    E.gfx.text('recorde  ' + s.best, W / 2, 334, { px: 14, align: 'center', color: CIANO });
    s.btnCamp = E.gfx.button('CAMPANHA', W / 2 - 110, 366, 220, 46,
        { primary: true, screen: true, px: 19 });
    s.btnEnd = E.gfx.button('INFINITO', W / 2 - 90, 420, 180, 36,
        { primary: false, screen: true, px: 15 });
}

function drawEnd(s, E) {
    var W = s.W, H = s.H;
    E.gfx.rect(0, 0, W, H, C(0x05060A), { screen: true });
    E.gfx.panel(40, 100, W - 80, 300, { bg: PAINEL, stroke: s.screen === 'win' ? OURO : VERMELHO, r: 12, screen: true });
    E.gfx.text(s.screen === 'win' ? 'SETOR LIVRE' : 'NAVE PERDIDA',
        W / 2, 145, { px: 34, align: 'center', color: s.screen === 'win' ? OURO : VERMELHO });
    E.gfx.text('pontos  ' + s.score, W / 2, 195, { px: 22, align: 'center', color: BRANCO });
    E.gfx.text('recorde  ' + s.best, W / 2, 226, { px: 15, align: 'center', color: TEXTO2 });
    if (s.newBest) E.gfx.text('NOVO RECORDE!', W / 2, 250,
        { px: 15, align: 'center', color: VERDE });
    s.btnAgain = E.gfx.button('DE NOVO', W / 2 - 105, 290, 210, 44,
        { primary: true, screen: true, px: 18 });
    s.btnTitle = E.gfx.button('MENU', W / 2 - 75, 346, 150, 34,
        { primary: false, screen: true, px: 14 });
}

function drawGame(s, E) {
    var W = s.W, H = s.H, i, p = s.player;
    // estrelas (por cima do fundo; pequenas)
    var st = s.stars;
    for (i = 0; i < st.length; i++) {
        var o = st[i];
        var c = o.z === 3 ? 0xCE79 : (o.z === 2 ? 0x8410 : 0x4208);
        E.gfx.rect(o.x, o.y, o.z === 3 ? 2 : 1, o.z === 3 ? 2 : 1, c, { screen: true });
    }
    // inimigos
    for (i = 0; i < s.enemies.length; i++) {
        var e = s.enemies[i];
        if (e.boss) {
            E.spr.stamp('ai_atlas#ai2', e.x, e.y, { scale: 2.06, key: 0xF81F });
        } else {
            E.spr.stamp('ai_atlas#ai1', e.x, e.y, { scale: e.r * 2 / 64, key: 0xF81F });
        }
        if (e.flash > 0) {
            if (e.boss) {
                E.gfx.circle(e.x - 24, e.y - 16, 3, BRANCO, { fill: true, screen: true });
                E.gfx.circle(e.x + 20, e.y - 22, 2, BRANCO, { fill: true, screen: true });
                E.gfx.circle(e.x + 2, e.y + 20, 3, BRANCO, { fill: true, screen: true });
            } else {
                E.gfx.circle(e.x, e.y, e.r + 2, BRANCO, { fill: false, screen: true });
            }
        }
        if (e.boss) {
            E.gfx.bar(e.x - 70, e.y - 60, 140, 8, e.hp / e.maxhp,
                { fg: MAGENTA, bg: 0x3008, r: 4, screen: true });
        }
    }
    // orbes
    for (i = 0; i < s.orbs.length; i++) {
        var orb = s.orbs[i];
        E.spr.stamp('ai_atlas#ai3', orb.x, orb.y, { scale: 0.7, key: 0xF81F });
    }
    // tiros
    for (i = 0; i < s.bullets.length; i++) {
        var b = s.bullets[i];
        E.gfx.rect(b.x - 2, b.y - 8, 4, 16, CIANO, { r: 2, screen: true });
    }
    for (i = 0; i < s.ebullets.length; i++) {
        var eb = s.ebullets[i];
        E.gfx.circle(eb.x, eb.y, eb.r, eb.color, { fill: true, screen: true });
        E.gfx.circle(eb.x - 1, eb.y - 1, 1.4, BRANCO, { fill: true, screen: true });
    }
    if (s.superT > 0) {
        E.gfx.circle(W / 2, H / 2, (0.55 - s.superT) * 900, CIANO, { fill: false, screen: true });
    }

    drawHud(s, E);
    if (s.msg) {
        E.gfx.text(s.msg, W / 2, H / 2, { px: 28, align: 'center', valign: 'middle',
            color: OURO, bg: C(0x05060A), screen: true });
    }
    if (s.paused) {
        E.gfx.rect(0, 0, W, H, C(0x05060A), { screen: true });
        E.gfx.panel(60, 150, W - 120, 190, { bg: PAINEL, stroke: CIANO, r: 12, screen: true });
        E.gfx.text('PAUSA', W / 2, 186, { px: 32, align: 'center', color: CIANO });
        s.btnResume = E.gfx.button('CONTINUAR', W / 2 - 100, 228, 200, 42,
            { primary: true, screen: true, px: 17 });
        s.btnMenuPause = E.gfx.button('MENU', W / 2 - 65, 282, 130, 34,
            { primary: false, screen: true, px: 14 });
    }
    if (s.over) {
        E.gfx.text('NAVE PERDIDA', W / 2, H / 2, { px: 34, align: 'center', valign: 'middle',
            color: VERMELHO, bg: C(0x05060A), screen: true });
    }
}

function drawHud(s, E) {
    var W = s.W, HUD = s.HUD_H;
    E.gfx.rect(0, 0, W, HUD, C(0x080C16), { screen: true });
    E.gfx.rect(0, HUD - 2, W, 2, CIANOD, { screen: true });
    E.gfx.text('PONTOS ' + s.score, 8, 6, { px: 16, color: BRANCO, screen: true });
    E.gfx.text('ONDA ' + Math.max(1, s.wave) + (s.mode === 'campaign' ? '/' + s.maxWave : ''),
        8, 27, { px: 13, color: TEXTO2, screen: true });
    E.gfx.text('x' + s.mult, 8, 44, { px: 14, color: s.mult > 1 ? OURO : TEXTO2, screen: true });
    // vidas
    E.gfx.hearts(s.lives, 3, 98, 44, { size: 11, color: VERMELHO, empty: 0x3008, screen: true });
    E.gfx.text('REC ' + s.best, W / 2, 6, { px: 13, align: 'center', color: TEXTO2, screen: true });
    if (s.triple > 0) {
        E.gfx.text('TRIPLO ' + Math.ceil(s.triple), W / 2, 26,
            { px: 13, align: 'center', color: OURO, screen: true });
    }
    // barra de supernova
    var bx = W - 190, by = 46;
    E.gfx.bar(bx, by, 110, 10, s.charge / 100,
        { fg: s.charge >= 100 ? OURO : CIANO, bg: 0x10C3, r: 4, screen: true });
    // botao super
    s.btnSuper = { x: W - 72, y: 6, w: 62, h: 28 };
    E.gfx.rect(s.btnSuper.x, s.btnSuper.y, s.btnSuper.w, s.btnSuper.h,
        s.charge >= 100 ? OURO : 0x18E3, { r: 7, screen: true });
    E.gfx.text('SUPER', s.btnSuper.x + s.btnSuper.w / 2, s.btnSuper.y + s.btnSuper.h / 2,
        { px: 12, align: 'center', valign: 'middle',
          color: s.charge >= 100 ? 0x0000 : TEXTO2, screen: true });
    // pausa
    s.btnPause = { x: W - 34, y: 36, w: 26, h: 22 };
    E.gfx.rect(s.btnPause.x, s.btnPause.y, s.btnPause.w, s.btnPause.h, PAINEL,
        { r: 5, screen: true });
    E.gfx.text('II', s.btnPause.x + s.btnPause.w / 2, s.btnPause.y + s.btnPause.h / 2,
        { px: 13, align: 'center', valign: 'middle', color: BRANCO, screen: true });
    if (s.boss) {
        E.gfx.text('SENTINELA-MOR', W / 2, 44, { px: 11, align: 'center', color: MAGENTA, screen: true });
    }
}
