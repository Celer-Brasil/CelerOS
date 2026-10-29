// arrasa.js - controlador da versao NATIVA do Arrasa! no Celer Studio.
// Cada fase e uma cena com as pecas como ENTIDADES (sprite/rotacao do
// runtime); este script cria os corpos do P.rigid, sincroniza os transforms,
// cuida do estilingue, turnos, dano, TNT, pontuacao e HUD.
//
// Cenas: Titulo / Mapa / Fase 1..10 / Fim.

var P = require('celeros.physics');

var SONG = {
    bpm: 120, loops: 16,
    tracks: [
        { wave: 'tri', vol: 52, notes: [
            [48, 2], [55, 2], [48, 2], [55, 2], [43, 2], [50, 2], [43, 2], [50, 2],
            [45, 2], [52, 2], [45, 2], [52, 2], [41, 2], [48, 2], [41, 2], [48, 2]
        ] },
        { wave: 'sq25', vol: 24, notes: [
            [72, 2], [76, 2], [79, 2], [76, 2], [74, 2], [71, 2], [67, 4],
            [69, 2], [72, 2], [76, 2], [72, 2], [77, 3], [76, 1], [74, 4]
        ] },
        { drum: true, vol: 40, notes: [
            [36, 2], [42, 2], [38, 2], [42, 2], [36, 2], [36, 2], [38, 2], [42, 2],
            [36, 2], [42, 2], [38, 2], [42, 2], [36, 2], [42, 2], [38, 2], [38, 2]
        ] }
    ]
};

var SND = {
    throw: [[420, 25], [700, 30], [1100, 45]],
    hit: [[170, 18], [110, 24]],
    boom: [[110, 50], [70, 70], [45, 130]],
    win: [[523, 90], [659, 90], [784, 90], [1047, 240]],
    fail: [[392, 150], [330, 150], [262, 280]],
    madeira: [[320, 22], [190, 30]],
    vidro: [[1900, 18], [2600, 18], [1500, 30]],
    pedra: [[150, 28], [95, 40]],
    goblin: [[900, 35], [700, 35], [450, 70]],
    rei: [[900, 45], [700, 45], [520, 55], [330, 130]],
    racha: [[1300, 22], [1700, 30]],
    dispara: [[600, 20], [1200, 25], [2000, 40]],
    volta: [[900, 30], [700, 30], [900, 30], [1200, 40]],
    bota: [[700, 25], [500, 30], [300, 40]],
    vitoria: [[523, 90], [659, 90], [784, 90], [1047, 240]],
    derrota: [[392, 150], [330, 150], [262, 280]]
};

var MAT = {
    madeira: { dens: 0.6, atrito: 0.75, quique: 0.05, hp: 150, pts: 100 },
    vidro: { dens: 0.45, atrito: 0.3, quique: 0.05, hp: 70, pts: 80 },
    pedra: { dens: 1.8, atrito: 0.85, quique: 0.02, hp: 380, pts: 150 },
    tnt: { dens: 0.6, atrito: 0.7, quique: 0.05, hp: 18, pts: 200 },
    rocha: { estatico: true, atrito: 0.9, quique: 0 },
    goblin: { dens: 0.5, atrito: 0.6, quique: 0.25, hp: 45, pts: 500 },
    rei: { dens: 0.5, atrito: 0.6, quique: 0.25, hp: 120, pts: 1500 }
};
var TIRO = {
    pedra: { r: 6.5, dens: 2.2, atrito: 0.6, quique: 0.25 },
    pedrao: { r: 9, dens: 3.0, atrito: 0.7, quique: 0.15 },
    tripla: { r: 5.5, dens: 2.2, atrito: 0.5, quique: 0.3 },
    bomba: { r: 6.5, dens: 2.0, atrito: 0.6, quique: 0.2 },
    flecha: { r: 6, dens: 2.6, atrito: 0.4, quique: 0.2 },
    bumerangue: { r: 6.5, dens: 2.2, atrito: 0.6, quique: 0.25 },
    chocadeira: { r: 7, dens: 1.8, atrito: 0.6, quique: 0.25 },
    ovo: { r: 5, dens: 4.0, atrito: 0.6, quique: 0 }
};

var MW = 320, GROUND = 290, GRAV = 400;
var BERCO = { x: 51.3, y: 239 }, GARFO = [{ x: 38, y: 234.7 }, { x: 64, y: 234.7 }];
var PUXAO_MAX = 42, K_LANCE = 9.2, CARENCIA = 1.0;
var NS = 6, SX = 0, SY = 1, SA = 2, SHIT = 3, SVEL = 4, SFL = 5;

// arte.png: grade 8x3 de 32 px (text2d animate-set/items/vfx) em tamanho
// de desenho (escala 1). Projetil que gira (flecha, bumerangue, galinha,
// bomba) e sprite solto: regiao de folha nao gira
var ART = [];
for (var _a = 0; _a < 24; _a++) ART.push('arte#a' + _a);
var A_GOB = 0, A_REI = 4, A_PUFF = 16;
var SHOT_ART = { pedra: 8, pedrao: 9, tripla: 10, bomba: 11, flecha: 12,
                 bumerangue: 13, chocadeira: 14, ovo: 15 };
var SHOT_ROT = { bomba: 'bomba', flecha: 'flecha', bumerangue: 'bumerangue',
                 chocadeira: 'chocadeira' };
var BOOM = ['boom#b0', 'boom#b1', 'boom#b2', 'boom#b3', 'boom#b4', 'boom#b5'];
var FX_T = 0.06;            // segundos por quadro de vfx (6 quadros)
var OPT_ART = { key: 0xF81F };
var OPT_ROT = { key: 0xF81F, angle: 0 };
var UI_THEME = { accent: '#ffc21a', accent2: '#ff7a00', onAccent: 0x0000, radius: 14 };

var OURO = 0xFFE0, BRANCO = 0xFFFF, VERDE = 0x07E0, VERMELHO = 0xF800;
var TEXT = 0xE71C, TEXT2 = 0x9CF3, PAINEL = 0x10C3, ESCURO = 0x0861;

function C(hex) {
    return ((hex >> 19) & 31) << 11 | ((hex >> 10) & 63) << 5 | ((hex >> 3) & 31);
}
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function mass(c) {
    var mt = MAT[c.mat] || TIRO[c.tipo];
    var d = mt && mt.dens ? mt.dens : 1;
    return c.r ? d * 3.14159265 * c.r * c.r : d * c.w * c.h;
}
exports.create = function (ctx) { return { ctx: ctx }; };

exports.start = function (ctx) {
    var s = this;
    var E = s.E = ctx.E;
    s.ctx = ctx;
    s.scene = ctx.scene;
    s.W = E.W; s.H = E.H; s.U = E.U;
    s.screen = (ctx.scene.data && ctx.scene.data.screen) || 'title';
    s.unlocked = E.save.num('nivel', 0);
    s.selected = 0;
    s.how = false;
    s.paused = false;
    s.ended = false;
    s.endT = 0;
    s.won = false;
    s.msg = '';
    s.msgT = 0;
    s.best = E.save.num('best', 0);

    if (E.audio && E.audio.sfxTable) {
        for (var k in SND) E.audio.sfxTable[k] = SND[k];
    }

    if (typeof __harness !== 'undefined') __harness.arrasa = s;
    if (E.ui) {
        E.ui.preset('soft');
        E.ui.theme(UI_THEME);
    }
    s.act = null;
    s.art = !!(E.spr && E.spr.has && E.spr.has(ART[0]));

    if (s.screen === 'title') {
        if (E.audio) E.audio.music(SONG);
    } else if (s.screen === 'map') {
        s.levels = (ctx.scene.data && ctx.scene.data.levels) || [];
        if (E.audio) E.audio.music(SONG);
    } else if (s.screen === 'end') {
        s.result = E.data.result || { won: false, level: 1, score: 0, stars: 0 };
        if (E.audio) E.audio.music(SONG);
    } else {
        startGame(s, ctx);
    }
};

// ------------------------------------------------------------- fisica ----

function startGame(s, ctx) {
    var E = s.E = ctx.E;
    var d = ctx.scene.data || {};
    s.ESC = s.W / MW;
    s.level = d.level || 1;
    s.levelName = d.name || ('Fase ' + s.level);
    s.shotsQueue = (d.shots || ['pedra', 'pedra']).slice();
    s.world = P.rigid({ iterations: 10 });
    s.corpos = [];
    s.pieces = [];
    s.state = null;
    s.goblins = 0;
    s.score = 0;
    s.t = 0;
    s.tiro = null;
    s.holding = false;
    s.trail = [];
    s.trailNew = [];
    s.paused = false;
    s.ended = false;
    s.endT = 0;
    s.won = false;
    s.msg = '';
    s.msgT = 0;
    s.aim = [];
    s.animT = 0;       // relogio do ciclo novo dos goblins
    s.entPieces = [];
    s.vfx = [];        // explosoes e fumacas (quadros do text2d)
    s.art = !!(E.spr && E.spr.has && E.spr.has(ART[0]));
    setupBackground(s, E, ctx);
    if (!s.world) {
        s.msg = 'SEM CORPO RIGIDO';
        s.msgT = 99;
        return;
    }
    var ground = s.world.box(MW / 2, GROUND + 60, MW * 4, 120,
        { static: true, friction: 0.9, bounce: 0 });
    s.corpos[ground] = { k: 'chao', i: ground, fixo: true };
    var ents = ctx.scene.entities;
    for (var i = 0; i < ents.length; i++) {
        var e = ents[i];
        if (!e.data || (e.data.kind !== 'box' && e.data.kind !== 'goblin')) continue;
        addPiece(s, e);
    }
    nextShot(s);
    s.state = s.world.state();
    s.shotsTotal = s.shotsQueue.length + 1;
    s.metas = starGoals(s);
    if (E.audio) E.audio.music(SONG);
    if (E.fx) E.fx.clear();
}

function addPiece(s, e) {
    var d = e.data;
    var wx = e.x / s.ESC, wy = e.y / s.ESC;
    var c;
    if (d.kind === 'box') {
        var mt = MAT[d.mat] || MAT.madeira;
        var idx = s.world.box(wx, wy, d.w, d.h, {
            angle: d.angle || 0, static: !!mt.estatico,
            density: mt.dens, friction: mt.atrito, bounce: mt.quique
        });
        if (idx < 0) return;
        c = { k: 'box', mat: d.mat, w: d.w, h: d.h, angle: d.angle || 0,
              i: idx, ent: e, hp: mt.hp || 0, hp0: mt.hp || 0,
              pts: mt.pts || 0, m: 0, fixo: !!mt.estatico, morto: false };
        c.m = mass(c);
    } else {
        var gt = d.type === 'rei' ? MAT.rei : MAT.goblin;
        var r = d.r || (d.type === 'rei' ? 10 : 7);
        var j = s.world.circle(wx, wy, r, { density: gt.dens, friction: gt.atrito, bounce: gt.quique });
        if (j < 0) return;
        c = { k: 'goblin', tipo: d.type || 'goblin', mat: d.type === 'rei' ? 'rei' : 'goblin',
              r: r, i: j, ent: e, hp: gt.hp, hp0: gt.hp, pts: gt.pts,
              m: 0, fixo: false, morto: false };
        c.m = mass(c);
        s.goblins++;
    }
    c.semente = (c.i * 7919 + s.level * 104729) % 9973;
    s.corpos[c.i] = c;
    s.pieces.push(c);
    e.active = true;
    s.entPieces.push(c);
}

function addFx(s, x, y, kind) {
    if (!s.vfx) return;
    if (s.vfx.length >= 10) s.vfx.shift();
    s.vfx.push({ x: x, y: y, t: 0, kind: kind });
}

function updateFx(s, dt) {
    for (var i = s.vfx.length - 1; i >= 0; i--) {
        s.vfx[i].t += dt;
        if (s.vfx[i].t >= FX_T * 6) s.vfx.splice(i, 1);
    }
}

// fundo de 480 px em escala 1: no device a camada suja restaura cada caixa
// com um blitSprite do slot do proprio asset (antes a entidade Fundo era
// carimbada inteira todo quadro). O host nao pinta blit: la a entidade fica
function setupBackground(s, E, ctx) {
    s.bgEnt = ctx.scene.find('Fundo');
    if (typeof __harness !== 'undefined') return;
    var id = E.spr && E.spr.id ? E.spr.id('fundo') : 0;
    if (!id || typeof System === 'undefined' ||
        typeof System.blitSprite !== 'function' || !E.dirty || !E.dirty.enable) return;
    if (s.bgEnt) s.bgEnt.active = false;
    E.dirty.enable(function (x, y, w, h) {
        System.fillRect(x, y, w, h, 0);
        System.blitSprite(id, x, y, w, h);
    });
    E.redraw();
}

function nextShot(s) {
    if (!s.shotsQueue.length) { s.tiro = null; return false; }
    s.tiro = { tipo: s.shotsQueue.shift(), estado: 'carregando', idx: -1,
               extras: [], t: 0, bateu: -1, usado: false, parado: 0,
               px: undefined, py: undefined, v: null, shot: null };
    s.pullX = 0; s.pullY = 0;
    return true;
}

function pedraNoBerco(s) {
    return { x: BERCO.x + (s.pullX || 0), y: BERCO.y + (s.pullY || 0) };
}

function grab(s, wx, wy) {
    var t = s.tiro;
    if (!t || t.estado !== 'pronto') return false;
    var dx = wx - BERCO.x, dy = wy - BERCO.y;
    if (dx * dx + dy * dy > 34 * 34) return false;
    t.estado = 'mirando';
    drag(s, wx, wy);
    return true;
}

function drag(s, wx, wy) {
    var t = s.tiro;
    if (!t || t.estado !== 'mirando') return;
    var dx = wx - BERCO.x, dy = wy - BERCO.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d > PUXAO_MAX) { dx *= PUXAO_MAX / d; dy *= PUXAO_MAX / d; }
    var def = TIRO[t.tipo];
    if (BERCO.y + dy > GROUND - def.r) dy = GROUND - def.r - BERCO.y;
    s.pullX = dx; s.pullY = dy;
}

function launch(s) {
    var t = s.tiro;
    if (!t || t.estado !== 'mirando') return;
    var d = Math.sqrt(s.pullX * s.pullX + s.pullY * s.pullY);
    if (d / PUXAO_MAX < 0.2) {
        t.estado = 'pronto';
        s.pullX = 0; s.pullY = 0;
        return;
    }
    var def = TIRO[t.tipo];
    var p = pedraNoBerco(s);
    var vx = -s.pullX * K_LANCE, vy = -s.pullY * K_LANCE;
    var i = s.world.circle(p.x, p.y, def.r,
        { density: def.dens, friction: def.atrito, bounce: def.quique });
    if (i < 0) return;
    s.world.set(i, p.x, p.y, 0, vx, vy, 0);
    var c = { k: 'tiro', tipo: t.tipo, r: def.r, i: i, tiro: true,
              m: 0, morto: false, nasc: s.t };
    c.m = mass(c);
    s.corpos[i] = c;
    t.idx = i; t.estado = 'voando'; t.t = 0;
    s.pullX = 0; s.pullY = 0;
    s.trailNew = [p.x, p.y];
    s.trail = [];
    s.holding = false;
    if (s.E.audio) s.E.audio.sfx('throw', { gap: 0 });
    if (s.E.fx) s.E.fx.burst(p.x * s.ESC, p.y * s.ESC, { n: 8, color: OURO, speed: 60, life: 0.3 });
}

function predicted(s, n, dt) {
    var p = pedraNoBerco(s);
    var vx = -(s.pullX || 0) * K_LANCE, vy = -(s.pullY || 0) * K_LANCE;
    var out = [];
    for (var k = 1; k <= n; k++) {
        var tt = k * dt;
        out.push(p.x + vx * tt, p.y + vy * tt + GRAV * tt * tt / 2);
    }
    return out;
}

function ability(s) {
    var t = s.tiro;
    if (!t || t.estado !== 'voando' || t.usado) return;
    var st = s.state, i = t.idx;
    if (i < 0 || !s.corpos[i]) return;
    if (t.tipo === 'tripla') {
        if (t.bateu >= 0) return;
        t.usado = true;
        var x = s.world.x(i, st), y = s.world.y(i, st);
        var vx = t.v ? t.v.x : 200, vy = t.v ? t.v.y : 0;
        var sp = Math.sqrt(vx * vx + vy * vy), ang = Math.atan2(vy, vx);
        for (var k = -1; k <= 1; k += 2) {
            var a = ang + k * 0.22;
            var j = newShot(s, 'tripla', x + Math.cos(a) * 7, y + Math.sin(a) * 7,
                Math.cos(a) * sp, Math.sin(a) * sp);
            if (j >= 0) t.extras.push(j);
        }
        if (s.E.audio) s.E.audio.sfx('racha', { gap: 0 });
    } else if (t.tipo === 'flecha' || t.tipo === 'bumerangue' || t.tipo === 'chocadeira') {
        if (t.bateu >= 0 || !t.v) return;
        t.usado = true;
        var fx = s.world.x(i, st), fy = s.world.y(i, st), fa = s.world.angle(i, st);
        var fvx = t.v.x, fvy = t.v.y;
        if (t.tipo === 'flecha') {
            var fsp = Math.sqrt(fvx * fvx + fvy * fvy) || 1;
            var nsp = Math.max(fsp * 2.4, 520);
            s.world.set(i, fx, fy, fa, fvx / fsp * nsp, fvy / fsp * nsp, 0);
            if (s.E.audio) s.E.audio.sfx('dispara', { gap: 0 });
        } else if (t.tipo === 'bumerangue') {
            s.world.set(i, fx, fy, fa, -fvx * 1.35 - 60, Math.min(fvy, 0) - 170, -12);
            if (s.E.audio) s.E.audio.sfx('volta', { gap: 0 });
        } else {
            var o = newShot(s, 'ovo', fx, fy + 9, fvx * 0.2, 380);
            if (o >= 0) { s.corpos[o].ovo = true; t.extras.push(o); }
            s.world.set(i, fx, fy - 2, fa, fvx * 1.15, -300, 0);
            if (s.E.audio) s.E.audio.sfx('bota', { gap: 0 });
        }
    } else if (t.tipo === 'bomba') {
        t.usado = true;
        var bx = s.world.x(i, st), by = s.world.y(i, st);
        removeBody(s, i, true);
        t.idx = -1;
        explode(s, bx, by, 62, 300);
    }
    if (s.E.fx) s.E.fx.burst(s.world.x(i, st) * s.ESC, s.world.y(i, st) * s.ESC,
        { n: 12, color: OURO, speed: 140, life: 0.4 });
}

function newShot(s, tipo, x, y, vx, vy) {
    var def = TIRO[tipo];
    var j = s.world.circle(x, y, def.r,
        { density: def.dens, friction: def.atrito, bounce: def.quique });
    if (j < 0) return -1;
    s.world.set(j, x, y, 0, vx, vy, 0);
    var c = { k: 'tiro', tipo: tipo, r: def.r, i: j, tiro: true,
              m: 0, morto: false, nasc: s.t };
    c.m = mass(c);
    s.corpos[j] = c;
    return j;
}

function ferir(s, c, dano) {
    if (!c.hp0 || c.morto) return;
    c.hp -= dano;
    if (c.hp > 0) return;
    c.morto = true;
}

function removeBody(s, i, semPontos) {
    var c = s.corpos[i];
    if (!c) return;
    var st = s.state;
    var x = s.world.x(i, st), y = s.world.y(i, st);
    s.world.remove(i);
    s.corpos[i] = null;
    if (c.ent) c.ent.active = false;
    if (!semPontos) s.score += c.pts || 0;
    if (c.k === 'goblin') {
        s.goblins--;
        addFx(s, x * s.ESC, y * s.ESC, 'puff');
        if (s.E.fx) s.E.fx.burst(x * s.ESC, y * s.ESC,
            { n: 14, color: c.tipo === 'rei' ? OURO : VERDE, speed: 140, life: 0.5 });
        if (s.E.audio) s.E.audio.sfx(c.tipo === 'rei' ? 'rei' : 'goblin', { gap: 0 });
    } else if (c.k === 'box' && !semPontos) {
        if (s.E.fx) s.E.fx.burst(x * s.ESC, y * s.ESC,
            { n: 10, color: c.mat === 'vidro' ? 0x07FF : 0xFD20, speed: 110, life: 0.4 });
        if (s.E.audio) s.E.audio.sfx(c.mat === 'vidro' ? 'vidro' :
            (c.mat === 'pedra' || c.mat === 'rocha' ? 'pedra' : 'madeira'), { gap: 0 });
    }
}

function explode(s, x, y, R, dvMax) {
    addFx(s, x * s.ESC, y * s.ESC, 'boom');
    if (s.E.fx) {
        s.E.fx.burst(x * s.ESC, y * s.ESC, { n: 26, color: 0xFD20, speed: 220, life: 0.6 });
        s.E.fx.flash(0xFD20, 160);
    }
    if (s.E.audio) s.E.audio.sfx('boom', { gap: 0 });
    for (var i = 0; i < s.corpos.length; i++) {
        var c = s.corpos[i];
        if (!c || c.fixo || c.k === 'chao' || c.morto) continue;
        var o = i * NS;
        var st = s.state;
        if (!(st[o + SFL] & 1)) continue;
        var dx = st[o + SX] - x, dy = st[o + SY] - y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d >= R) continue;
        var f = 1 - d / R;
        var nx = d > 0.01 ? dx / d : 0, ny = d > 0.01 ? dy / d : -1;
        var dv = dvMax * f;
        s.world.impulse(i, nx * dv * c.m, (ny - 0.35) * dv * c.m);
        if (c.hp0) ferir(s, c, dv * 1.1);
    }
}

function step(s, dt) {
    if (!s.world || !s.tiro) return;
    if (dt > 0.05) dt = 0.05;
    s.t += dt;
    s.animT = (s.animT || 0) + dt;
    var t = s.tiro;
    if (t.estado === 'carregando') {
        t.t += dt;
        if (t.t >= 0.35) { t.estado = 'pronto'; t.t = 0; }
    }
    s.world.step(dt, { gravity: { x: 0, y: GRAV }, maxSub: 12 });
    var st = s.state = s.world.state();
    var n = s.world.count();
    var i, c, o;

    for (i = 0; i < n; i++) {
        c = s.corpos[i];
        o = i * NS;
        if (!c || !(st[o + SFL] & 1)) continue;
        var x = st[o + SX], y = st[o + SY];
        if (x < -50 || x > MW + 50 || y > GROUND + 70) {
            c.morto = c.k !== 'chao';
            c.caiu = true;
            continue;
        }
        if (!c.hp0 || s.t < CARENCIA) continue;
        var hit = st[o + SHIT];
        if (hit <= 0) continue;
        var dv = hit / c.m;
        var lim = c.k === 'goblin' ? 32 : 55;
        if (dv > lim) {
            ferir(s, c, dv - lim);
            if (dv > lim * 2.2 && s.E.fx) {
                s.E.fx.burst(x * s.ESC, y * s.ESC, { n: 6, color: 0xFFE0, speed: 70, life: 0.3 });
            }
        }
    }

    if (t.estado === 'voando') {
        t.t += dt;
        var vivos = 0, ativos = 0;
        for (var k = -1; k < t.extras.length; k++) {
            var j = k < 0 ? t.idx : t.extras[k];
            if (j < 0) continue;
            var cj = s.corpos[j];
            if (!cj || cj.morto) continue;
            var oj = j * NS;
            if (!(st[oj + SFL] & 1)) continue;
            vivos++;
            var tx = st[oj + SX], ty = st[oj + SY];
            if (j === t.idx) {
                if (t.px !== undefined && dt > 0) {
                    t.v = t.v || { x: 0, y: 0 };
                    t.v.x = (tx - t.px) / dt;
                    t.v.y = (ty - t.py) / dt;
                }
                t.px = tx; t.py = ty;
                if (t.bateu < 0 && st[oj + SHIT] > 0 && t.t > 0.05) {
                    t.bateu = t.t;
                    if (s.E.audio) s.E.audio.sfx('hit', { gap: 0 });
                }
                if (t.bateu < 0) {
                    var L = s.trailNew.length;
                    var lx = s.trailNew[L - 2], ly = s.trailNew[L - 1];
                    if ((tx - lx) * (tx - lx) + (ty - ly) * (ty - ly) > 81) {
                        s.trailNew.push(tx, ty);
                    }
                }
            }
            if (tx < -50 || tx > MW + 50 || ty > GROUND + 70) {
                cj.morto = true;
                continue;
            }
            if (cj.ovo && s.t - cj.nasc > 0.05 && st[oj + SHIT] > 0) {
                removeBody(s, j, true);
                explode(s, tx, ty, 46, 300);
                continue;
            }
            if (st[oj + SVEL] > 9) ativos++;
        }
        if (t.tipo === 'bomba' && !t.usado && t.bateu >= 0 && t.t - t.bateu > 1.5) ability(s);
        if (vivos === 0 || ativos === 0) t.parado += dt;
        else t.parado = 0;
        if (vivos === 0 || t.parado > 0.8 || t.t > 9) {
            t.estado = 'assentando';
            t.t = 0;
            s.calmo = 0;
            s.trail = s.trailNew;
            s.trailNew = [];
            for (k = -1; k < t.extras.length; k++) {
                j = k < 0 ? t.idx : t.extras[k];
                if (j >= 0 && s.corpos[j]) {
                    s.world.remove(j);
                    s.corpos[j] = null;
                }
            }
        }
    }

    for (var volta = 0; volta < 4; volta++) {
        var algum = false;
        for (i = 0; i < s.corpos.length; i++) {
            c = s.corpos[i];
            if (!c || !c.morto) continue;
            algum = true;
            var ex = st[i * NS + SX], ey = st[i * NS + SY];
            removeBody(s, i, c.caiu && c.k !== 'goblin');
            if (c.mat === 'tnt' && !c.caiu) explode(s, ex, ey, 58, 320);
        }
        if (!algum) break;
        st = s.state = s.world.state();
    }

    if (t.estado === 'assentando') {
        t.t += dt;
        var acordado = false;
        for (i = 0; i < s.corpos.length; i++) {
            c = s.corpos[i];
            o = i * NS;
            if (c && !c.fixo && c.k !== 'chao' && (st[o + SFL] & 1) && st[o + SVEL] > 6) {
                acordado = true;
                break;
            }
        }
        s.calmo = acordado ? 0 : (s.calmo || 0) + dt;
        if (s.calmo > 0.5 || t.t > 3) {
            t.estado = 'fim';
            if (s.goblins <= 0) victory(s);
            else if (s.shotsQueue.length) { nextShot(s); s.msg = 'NOVO TIRO'; s.msgT = 0.8; }
            else defeat(s);
        }
    } else if (!s.ended && s.goblins <= 0 && (!t || (t.estado !== 'voando' && t.estado !== 'mirando'))) {
        victory(s);
    }
    syncPieces(s);
}

function victory(s) {
    if (s.ended) return;
    s.ended = true;
    s.won = true;
    s.endT = 1.6;
    var rest = s.shotsQueue.length + (s.tiro && s.tiro.estado !== 'fim' ? 1 : 0);
    s.score += rest * 1000;
    var stars = 1;
    if (s.metas) {
        if (s.score >= s.metas[2]) stars = 3;
        else if (s.score >= s.metas[1]) stars = 2;
    }
    s.stars = stars;
    var lv = s.level - 1;
    var prev = s.E.save.num('est' + lv, 0);
    if (stars > prev) s.E.save.set('est' + lv, stars);
    var pts = s.E.save.num('pts' + lv, 0);
    if (s.score > pts) s.E.save.set('pts' + lv, s.score);
    var unlocked = s.E.save.num('nivel', 0);
    if (lv + 1 > unlocked) s.E.save.set('nivel', lv + 1);
    if (s.E.audio) {
        s.E.audio.stop();
        s.E.audio.sfx('win', { gap: 0 });
    }
    if (s.E.fx) s.E.fx.flash(OURO, 300, { full: true });
}

function defeat(s) {
    if (s.ended) return;
    s.ended = true;
    s.won = false;
    s.endT = 1.6;
    s.stars = 0;
    if (s.E.audio) {
        s.E.audio.stop();
        s.E.audio.sfx('fail', { gap: 0 });
    }
}

function starGoals(s) {
    var g = 0, bl = 0;
    for (var i = 0; i < s.pieces.length; i++) {
        var c = s.pieces[i];
        var mt = MAT[c.mat] || MAT.goblin;
        if (c.k === 'goblin') g += mt.pts || 0;
        else if (!mt.estatico) bl += mt.pts || 0;
    }
    return [g, Math.round((g + bl * 0.5) / 100) * 100,
            Math.round((g + bl * 0.6 + 1000) / 100) * 100];
}

function syncPieces(s) {
    var st = s.state;
    if (!st) return;
    for (var p = 0; p < s.pieces.length; p++) {
        var c = s.pieces[p];
        if (!c) continue;
        var e = c.ent;
        if (!e) continue;
        var i = c.i, o = i * NS;
        if (!s.corpos[i] || !(st[o + SFL] & 1)) {
            if (c.morto) e.active = false;
            continue;
        }
        var x = st[o + SX], y = st[o + SY];
        e.x = x * s.ESC;
        e.y = y * s.ESC;
        if (c.k === 'goblin' && s.art) {
            e.spr = ART[(c.tipo === 'rei' ? A_REI : A_GOB) +
                        (Math.floor(s.animT * 6 + c.semente) % 4)];
        }
        if (c.k === 'box') e.rot = st[o + SA] * 180 / Math.PI;
    }
}

// --------------------------------------------------------------- update ---

exports.update = function (dt, ctx) {
    var s = this, E = s.E;
    if (s.screen === 'title') return updateTitle(s, E, ctx);
    if (s.screen === 'map') return updateMap(s, E, ctx);
    if (s.screen === 'end') return updateEnd(s, E, ctx);
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
    if (s.how) E.redraw();          // modal anima: a cena estatica repinta
    if (a === 'play') {
        E.audio && E.audio.sfx('ok');
        ctx.go('Mapa');
    } else if (a === 'how') {
        s.how = true;
        E.redraw();
    } else if (a === 'howClose') {
        s.how = false;
        E.redraw();
    }
}

function updateMap(s, E, ctx) {
    var a = takeAct(s);
    if (a === 'back') { ctx.go('Titulo'); return; }
    if (a === 'locked') {
        if (E.ui) E.ui.toast('Termine a fase anterior', { type: 'warn', icon: 'lock' });
        return;
    }
    if (a) {
        E.audio && E.audio.sfx('ok');
        ctx.go(a);
    }
}

function updateEnd(s, E, ctx) {
    var a = takeAct(s);
    if (!a) return;
    var lv = s.result.level;
    E.data.result = null;
    if (a === 'next') ctx.go('Fase ' + (lv + 1));
    else if (a === 'retry') ctx.go('Fase ' + lv);
    else if (a === 'map') ctx.go('Mapa');
}

function inRect(r, x, y) {
    return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

function updateGame(s, E, ctx, dt) {
    if (s.ended) {
        s.endT -= dt;
        if (s.endT <= 0) {
            E.data.result = { won: s.won, level: s.level, score: s.score, stars: s.stars };
            E.data.score = s.score;
            ctx.go('Fim');
        }
        return;
    }
    var act = takeAct(s);
    if (s.paused) {
        if (act === 'resume') { s.paused = false; E.redraw(); }
        else if (act === 'map') ctx.go('Mapa');
        return;
    }
    if (E.input.justDown && inRect(BTN_PAUSE, E.input.x, E.input.y)) {
        s.paused = true;
        return;
    }
    if (s.msgT > 0) { s.msgT -= dt; if (s.msgT <= 0) s.msg = ''; }

    var t = s.tiro;
    var wx = E.input.x / s.ESC, wy = E.input.y / s.ESC;
    if (E.input.down) {
        if (!s.holding && t && t.estado === 'pronto') {
            if (grab(s, wx, wy)) s.holding = true;
        } else if (s.holding && t && t.estado === 'mirando') {
            drag(s, wx, wy);
        }
    }
    if (E.input.justUp && s.holding) {
        launch(s);
        s.holding = false;
    }
    if (E.input.tap && t && t.estado === 'voando') ability(s);

    if (!s.world) return;
    step(s, dt);
    updateFx(s, dt);
    if (t && t.estado === 'mirando') {
        s.aim = predicted(s, 10, 0.055);
    } else {
        s.aim = [];
    }
}

// ---------------------------------------------------------------- draw ----

exports.draw = function (ctx) {
    var s = this, E = s.E;
    if (s.screen === 'title') return drawTitle(s, E);
    if (s.screen === 'map') return drawMap(s, E);
    if (s.screen === 'end') return drawEnd(s, E);
    drawGame(s, E);
};

var LOGO_TXT = { px: 56, align: 'center', valign: 'middle', color: OURO,
                 outline: C(0x4A2A10), screen: true };
var SUB_TXT = { px: 16, align: 'center', valign: 'middle', color: BRANCO,
                outline: C(0x1A3020), screen: true };
var HEAD_TXT = { px: 30, align: 'center', valign: 'middle', color: OURO,
                 outline: C(0x4A2A10), screen: true };
var CARD_T = { px: 14, color: BRANCO, screen: true };
var CARD_S = { px: 13, color: TEXT2, screen: true };
var LOCK_T = { px: 13, color: C(0x5A6A84), screen: true };
var BTN_PLAY = { variant: 'primary', icon: 'play', ts: 'big' };
var BTN_HOW = { variant: 'secondary', icon: 'info' };
var BTN_BACK = { variant: 'secondary', icon: 'back' };
var BIG2 = { key: 0xF81F, scale: 2.5 };
var HOW_BODY = 'Puxe a pedra no estilingue e solte. Toque no voo: poder da ' +
               'pedra. Derrube todos os goblins.';
var HOW_BTNS = [{ label: 'Entendi', value: 1, icon: 'check' }];
var NAMES = ['Primeiro estrago', 'Casinha', 'Vidracaria', 'Torre de pedra',
             'Polvora', 'Fortaleza', 'Penhasco', 'Linha de frente',
             'Atras do muro', 'Castelo do Rei'];

function drawStars(E, cx, cy, n, r) {
    for (var i = 0; i < 3; i++) {
        E.gfx.star(cx + (i - 1) * r * 2.4, cy, r, r * 0.45, 5,
                   i < n ? C(0xFFC83C) : C(0x2A3350), { screen: true, fill: true });
    }
}

function drawTitle(s, E) {
    var W = s.W;
    E.gfx.text('ARRASA!', W / 2, 70, LOGO_TXT);
    E.gfx.text('derrube a fortaleza', W / 2, 118, SUB_TXT);
    if (s.art) {
        E.spr.stamp(ART[A_REI], 330, 200, BIG2);
        E.spr.stamp(ART[A_GOB], 400, 214, BIG2);
        E.spr.stamp(ART[SHOT_ART.pedra], 120, 214, BIG2);
    }
    // Menu no helper da engine (altura derivada dos itens, ancorado no
    // rodape): card fixo de 190 px em y=270 com botoes de 58/42 ficava
    // gigante no vidro de 480 e o COMO JOGAR raspava o rodape.
    var MITEMS = [
        { label: 'JOGAR', value: 'play', icon: 'play' },
        { label: 'COMO JOGAR', value: 'how' }
    ];
    var mbox = E.ui.menuBox(MITEMS);
    var bx = mbox.x + mbox.pad;
    bx += E.ui.badge('10 FASES', bx, mbox.y - 30) + 8;
    E.ui.badge(totalStars(s) + '/30', bx, mbox.y - 30,
               { color: C(0xFFC83C), textColor: 0x0000 });
    var mpick = E.ui.menuCard(MITEMS);
    if (mpick) s.act = mpick;
    if (s.how) {
        var r = E.ui.modal('how', { title: 'COMO JOGAR', body: HOW_BODY, buttons: HOW_BTNS });
        if (r !== null) s.act = 'howClose';
    }
}

function totalStars(s) {
    var n = 0;
    for (var i = 0; i < 10; i++) n += s.E.save.num('est' + i, 0);
    return n;
}

function starsOf(s, i) {
    return s.E.save.num('est' + i, 0);
}

function drawMap(s, E) {
    var W = s.W, H = s.H;
    E.gfx.text('ESCOLHA A FASE', W / 2, 26, HEAD_TXT);
    E.gfx.text((s.unlocked + 1) + '/10 liberadas  ·  ' + totalStars(s) + '/30', W / 2, 58, SUB_TXT);
    var CW = 214, CH = 64, GX = 12, GY = 8;
    var x0 = (W - (CW * 2 + GX)) / 2, y0 = 78;
    for (var n = 1; n <= 10; n++) {
        var col = (n - 1) % 2, row = Math.floor((n - 1) / 2);
        var x = x0 + col * (CW + GX), y = y0 + row * (CH + GY);
        var locked = n > s.unlocked + 1;
        var cur = n - 1 === s.unlocked;
        E.ui.card(x, y, CW, CH, { pad: 0, stroke: locked ? C(0x222B3D) : (cur ? OURO : C(0x3DDC84)),
                                  bg: locked ? C(0x0C1018) : C(0x14241C) });
        E.gfx.text(n + '  ' + NAMES[n - 1], x + 12, y + 10, locked ? LOCK_T : CARD_T);
        if (locked) {
            E.ui.icon('lock', x + CW - 40, y + 18, 26, { color: C(0x5A6A84) });
        } else {
            drawStars(E, x + 36, y + 44, starsOf(s, n - 1), 8);
            E.gfx.text(s.E.save.num('pts' + (n - 1), 0) + ' pts', x + CW - 12, y + 38,
                       { px: 13, align: 'right', color: TEXT2, screen: true });
        }
        var hit = { x: x, y: y, w: CW, h: CH };
        E._btns.push(hit);
        if (E.input.tap && E.hit(hit)) s.act = locked ? 'locked' : 'Fase ' + n;
    }
    if (E.ui.button('VOLTAR', W / 2 - 90, H - 50, 180, 42, BTN_BACK)) s.act = 'back';
}

var END_NEXT = { variant: 'primary', icon: 'play' };
var END_SEC = { variant: 'secondary', icon: 'refresh' };
var END_MAP = { variant: 'ghost', icon: 'menu' };

function drawEnd(s, E) {
    var W = s.W, r = s.result;
    E.gfx.text(r.won ? 'ARRASOU!' : 'SEM PEDRAS', W / 2, 74,
               { px: r.won ? 56 : 40, align: 'center', valign: 'middle', color: r.won ? OURO : VERMELHO,
                 outline: 0x0000, screen: true });
    var c = E.ui.card(40, 140, W - 80, 320);
    E.gfx.text('FASE ' + r.level + '  ·  ' + NAMES[r.level - 1], c.x + c.w / 2, c.y + 6,
               { px: 14, align: 'center', color: TEXT2, screen: true });
    E.gfx.text(r.score + ' pts', c.x + c.w / 2, c.y + 40,
               { px: 30, align: 'center', valign: 'middle', color: BRANCO, screen: true });
    if (r.won) drawStars(E, c.x + c.w / 2, c.y + 92, r.stars, 18);
    else if (s.art) E.spr.stamp(ART[A_REI], c.x + c.w / 2, c.y + 92, BIG2);
    var y = c.y + 134;
    if (r.won && r.level < 10) {
        if (E.ui.button('PROXIMA', c.x, y, c.w, 50, END_NEXT)) s.act = 'next';
        y += 60;
    }
    if (E.ui.button(r.won ? 'DE NOVO' : 'TENTAR DE NOVO', c.x, y, c.w, 44, r.won && r.level < 10 ? END_SEC : END_NEXT)) s.act = 'retry';
    if (E.ui.button('FASES', c.x + c.w / 2 - 80, y + 54, 160, 40, END_MAP)) s.act = 'map';
}

// ---------------------------------------------------------------- jogo

var PAUSE_BTNS = [{ label: 'Mapa', value: 'map', icon: 'menu' },
                  { label: 'Continuar', value: 'resume' }];
var BTN_PAUSE = { x: 428, y: 438, w: 44, h: 36 };
var AIM_O = { fill: true, screen: true };
var TRAIL_O = { fill: true, screen: true };
var SLING_O = { w: 3 };
var BAND_O = { w: 2 };
var MSG_TXT = { px: 20, align: 'center', valign: 'middle', color: OURO,
                outline: 0x0000, screen: true };
var END_TXT = { px: 34, align: 'center', valign: 'middle', color: OURO,
                outline: 0x0000, screen: true };
var Q_TXT = { px: 13, valign: 'middle', color: BRANCO, outline: 0x0000, screen: true };
var PANEL_O = { r: 10, screen: true, bw: 2, stroke: C(0xFFC21A) };

function drawShot(s, E, tipo, x, y, ang) {
    if (!s.art) {
        E.gfx.circle(x, y, (TIRO[tipo] ? TIRO[tipo].r : 6) * s.ESC, C(0x808080), AIM_O);
        return;
    }
    var rot = SHOT_ROT[tipo];
    if (rot && ang && E.spr.has(rot)) {
        OPT_ROT.angle = ang;
        E.spr.stamp(rot, x, y, OPT_ROT);
    } else {
        E.spr.stamp(ART[SHOT_ART[tipo] || SHOT_ART.pedra], x, y, OPT_ART);
    }
}

function drawGame(s, E) {
    var W = s.W, H = s.H, ESC = s.ESC, i;
    // estilingue
    var bx = BERCO.x * ESC, by = BERCO.y * ESC;
    var px = bx + (s.pullX || 0) * ESC, py = by + (s.pullY || 0) * ESC;
    E.gfx.line(GARFO[0].x * ESC, GARFO[0].y * ESC, px, py, C(0x4A2A10), BAND_O);
    // pedra no berco
    if (s.tiro && (s.tiro.estado === 'pronto' || s.tiro.estado === 'carregando' ||
                   s.tiro.estado === 'mirando')) {
        drawShot(s, E, s.tiro.tipo, px, py, 0);
    }
    E.gfx.line(GARFO[1].x * ESC, GARFO[1].y * ESC, px, py, C(0x4A2A10), BAND_O);
    // mira: pontos que encolhem
    var aim = s.aim || [];
    for (i = 0; i + 1 < aim.length; i += 2) {
        E.gfx.circle(aim[i] * ESC, aim[i + 1] * ESC, 3.4 - i * 0.12, OURO, AIM_O);
    }
    // rastro
    var tr = s.trail || [];
    for (i = 0; i + 1 < tr.length; i += 2) {
        E.gfx.circle(tr[i] * ESC, tr[i + 1] * ESC, 2, 0xCE79, TRAIL_O);
    }
    // projeteis
    for (i = 0; i < s.corpos.length; i++) {
        var c = s.corpos[i];
        if (!c || c.k !== 'tiro' || c.morto) continue;
        var o = i * NS, st = s.state;
        if (!st || !(st[o + SFL] & 1)) continue;
        drawShot(s, E, c.tipo, st[o + SX] * ESC, st[o + SY] * ESC,
                 st[o + SA] * 180 / Math.PI);
    }
    // explosoes e fumacas (vfx text2d)
    for (i = 0; i < s.vfx.length; i++) {
        var v = s.vfx[i];
        var f = Math.floor(v.t / FX_T);
        if (f > 5) continue;
        if (v.kind === 'boom') { if (E.spr.has(BOOM[f])) E.spr.stamp(BOOM[f], v.x, v.y, OPT_ART); }
        else if (s.art) E.spr.stamp(ART[A_PUFF + f], v.x, v.y, OPT_ART);
    }
    // particulas/flash do E.fx (estouro da pedra, TNT, fagulhas do poder):
    // o draw da cena e quem desenha — antes nada disso aparecia
    if (E.fx) E.fx.draw();
    drawHud(s, E);
    if (s.msg) E.gfx.text(s.msg, W / 2, 100, MSG_TXT);
    if (s.paused) {
        var r = E.ui.modal('pausa', { title: 'PAUSA', dismiss: false,
                                      body: 'fase ' + s.level + '  ·  ' + s.score + ' pts',
                                      buttons: PAUSE_BTNS });
        if (r !== null) s.act = r;
    }
    if (s.ended) {
        END_TXT.color = s.won ? OURO : VERMELHO;
        E.gfx.text(s.won ? 'FASE LIMPA!' : 'SEM PEDRAS', W / 2, H / 2 - 20, END_TXT);
    }
}

// HUD de topo pelo E.ui.hud; a fila de pedras e a pausa ficam na faixa do
// chao (embaixo), longe da mira
var HUD_O = { h: 0, level: '', score: 0, left: null, bg: C(0x14241C) };
var HUD_L = [{ icon: 'alert', text: '', color: VERDE }];

function drawHud(s, E) {
    var W = s.W, H = s.H;
    HUD_O.h = Math.round(20 * E.U);
    HUD_O.level = 'FASE ' + s.level;
    HUD_O.score = s.score;
    HUD_L[0].text = s.goblins + (s.goblins === 1 ? ' goblin' : ' goblins');
    HUD_O.left = HUD_L;
    E.ui.hud(HUD_O);
    // fila: a pedra da vez some do berco quando voa; aqui as que faltam
    var q = s.shotsQueue || [];
    var x = 16, y = H - 22;
    E.gfx.text(q.length ? 'PROXIMAS' : 'ULTIMA PEDRA', x, y, Q_TXT);
    x += q.length ? 84 : 0;
    for (var i = 0; i < q.length && i < 6; i++) {
        drawShot(s, E, q[i], x + i * 30 + 14, y, 0);
    }
    E.gfx.rect(BTN_PAUSE.x, BTN_PAUSE.y, BTN_PAUSE.w, BTN_PAUSE.h, C(0x14241C), PANEL_O);
    E.ui.icon('pause', BTN_PAUSE.x + 11, BTN_PAUSE.y + 7, 22, { color: BRANCO });
}
