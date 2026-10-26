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
    s.entPieces = [];
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

function updateTitle(s, E, ctx) {
    if (s.how) {
        if (E.input.tap) { s.how = false; E.redraw(); }
        return;
    }
    if (s.btnPlay && E.hit(s.btnPlay)) {
        E.audio && E.audio.sfx('ok');
        ctx.go('Mapa');
    } else if (s.btnHow && E.hit(s.btnHow)) {
        s.how = true;
        E.redraw();
    }
}

function updateMap(s, E, ctx) {
    if (!s.cards) return;
    for (var i = 0; i < s.cards.length; i++) {
        var c = s.cards[i];
        if (!E.hit(c)) continue;
        if (c.locked) {
            s.msg = 'FASE BLOQUEADA';
            s.msgT = 1.2;
            E.redraw();
            return;
        }
        E.audio && E.audio.sfx('ok');
        ctx.go('Fase ' + c.n);
        return;
    }
    if (s.btnBack && E.hit(s.btnBack)) ctx.go('Titulo');
}

function updateEnd(s, E, ctx) {
    if (s.btnNext && E.hit(s.btnNext)) {
        E.data.result = null;
        ctx.go('Fase ' + (s.result.level + 1));
    } else if (s.btnRetry && E.hit(s.btnRetry)) {
        E.data.result = null;
        ctx.go('Fase ' + s.result.level);
    } else if (s.btnMap && E.hit(s.btnMap)) {
        E.data.result = null;
        ctx.go('Mapa');
    }
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
    if (s.paused) {
        if (s.btnResume && E.hit(s.btnResume)) s.paused = false;
        else if (s.btnMapPause && E.hit(s.btnMapPause)) ctx.go('Mapa');
        return;
    }
    if (s.btnPause && E.hit(s.btnPause)) { s.paused = true; return; }
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

function drawTitle(s, E) {
    var W = s.W, H = s.H;
    E.gfx.rect(0, 180, W, H - 180, C(0x0A1A12), { screen: true });
    E.gfx.text('ARRASA!', W / 2, 226, { px: 48, align: 'center', valign: 'middle',
        color: 0xFFE0, shadow: 0x0000 });
    E.gfx.text('derrube a fortaleza', W / 2, 272,
        { px: 18, align: 'center', color: TEXT });
    E.gfx.text('10 fases  ·  ' + totalStars(s) + ' estrelas', W / 2, 300,
        { px: 14, align: 'center', color: VERDE });
    s.btnPlay = E.gfx.button('JOGAR', W / 2 - 105, 332, 210, 50,
        { primary: true, screen: true, px: 21 });
    s.btnHow = E.gfx.button('COMO JOGAR', W / 2 - 105, 396, 210, 38,
        { primary: false, screen: true, px: 14 });
    if (s.how) {
        E.gfx.rect(0, 0, W, H, C(0x05080E), { screen: true });
        s.btnPlay = null;
        s.btnHow = null;
        E.gfx.panel(30, 80, W - 60, 330, { bg: PAINEL, stroke: OURO, r: 12, screen: true });
        E.gfx.text('COMO JOGAR', W / 2, 114, { px: 28, align: 'center', color: OURO });
        E.gfx.text('puxe a pedra no estilingue e solte', W / 2, 158,
            { px: 15, align: 'center', color: BRANCO });
        E.gfx.text('toque durante o voo: poder da pedra', W / 2, 188,
            { px: 15, align: 'center', color: BRANCO });
        E.gfx.text('derrube todos os goblins e o rei', W / 2, 218,
            { px: 15, align: 'center', color: BRANCO });
        E.gfx.text('TNT, vidro, madeira e pedra reagem diferente', W / 2, 248,
            { px: 13, align: 'center', color: TEXT2 });
        E.gfx.text('toque para voltar', W / 2, 340, { px: 14, align: 'center', color: OURO });
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
    E.gfx.rect(0, 0, W, H, C(0x0A1A12), { screen: true });
    E.gfx.text('ESCOLHA A FASE', W / 2, 28, { px: 28, align: 'center', color: OURO });
    E.gfx.text(s.unlocked + 1 + '/10 liberadas  ·  ' + totalStars(s) + ' estrelas',
        W / 2, 62, { px: 14, align: 'center', color: TEXT2 });
    var names = ['Primeiro estrago', 'Casinha', 'Vidracaria', 'Torre de pedra',
                 'Polvora', 'Fortaleza', 'Penhasco', 'Linha de frente',
                 'Atras do muro', 'Castelo do Rei'];
    var CW = 208, CH = 60, GX = 12, GY = 8;
    var x0 = (W - (CW * 2 + GX)) / 2, y0 = 86;
    s.cards = [];
    for (var n = 1; n <= 10; n++) {
        var col = (n - 1) % 2, row = Math.floor((n - 1) / 2);
        var x = x0 + col * (CW + GX), y = y0 + row * (CH + GY);
        var locked = n > s.unlocked + 1;
        E.gfx.panel(x, y, CW, CH, { bg: locked ? C(0x10141E) : C(0x162338),
            stroke: locked ? C(0x222B3D) : OURO, r: 8, screen: true });
        E.gfx.text((locked ? 'X ' : '') + n + '  ' + names[n - 1], x + 10, y + 8,
            { px: 13, color: locked ? C(0x5A6A84) : (n - 1 === s.unlocked ? OURO : BRANCO) });
        var st = starsOf(s, n - 1);
        var txt = '';
        for (var k = 0; k < 3; k++) txt += k < st ? '*' : '-';
        E.gfx.text(txt + '   ' + s.E.save.num('pts' + (n - 1), 0) + ' pts',
            x + 10, y + 30, { px: 12, color: locked ? C(0x5A6A84) : TEXT2 });
        s.cards.push({ x: x, y: y, w: CW, h: CH, n: n, locked: locked });
    }
    s.btnBack = E.gfx.button('VOLTAR', W / 2 - 80, H - 50, 160, 34,
        { primary: false, screen: true, px: 14 });
    if (s.msg) E.gfx.text(s.msg, W / 2, H - 14,
        { px: 12, align: 'center', color: C(0xFF8B8B) });
}

function drawEnd(s, E) {
    var W = s.W, H = s.H;
    var r = s.result;
    E.gfx.rect(0, 0, W, H, C(0x0A1A12), { screen: true });
    E.gfx.panel(40, 100, W - 80, 300, { bg: PAINEL,
        stroke: r.won ? OURO : VERMELHO, r: 12, screen: true });
    E.gfx.text(r.won ? 'ARRASOU!' : 'SEM PEDRAS',
        W / 2, 142, { px: 36, align: 'center', color: r.won ? OURO : VERMELHO });
    E.gfx.text('fase ' + r.level + '  ·  ' + r.score + ' pts',
        W / 2, 190, { px: 18, align: 'center', color: BRANCO });
    if (r.won) {
        var st = '';
        for (var k = 0; k < 3; k++) st += k < r.stars ? '*' : '-';
        E.gfx.text(st, W / 2, 222, { px: 22, align: 'center', color: C(0xFFD479) });
    }
    if (r.won && r.level < 10) {
        s.btnNext = E.gfx.button('PROXIMA', W / 2 - 100, 250, 200, 44,
            { primary: true, screen: true, px: 17 });
        s.btnRetry = E.gfx.button('DE NOVO', W / 2 - 80, 302, 160, 32,
            { primary: false, screen: true, px: 13 });
        s.btnMap = E.gfx.button('FASES', W / 2 - 55, 344, 110, 30,
            { primary: false, screen: true, px: 12 });
    } else if (r.won) {
        s.btnRetry = E.gfx.button('DE NOVO', W / 2 - 100, 268, 200, 42,
            { primary: true, screen: true, px: 16 });
        s.btnMap = E.gfx.button('FASES', W / 2 - 70, 322, 140, 32,
            { primary: false, screen: true, px: 13 });
    } else {
        s.btnRetry = E.gfx.button('TENTAR DE NOVO', W / 2 - 130, 252, 260, 42,
            { primary: true, screen: true, px: 15 });
        s.btnMap = E.gfx.button('FASES', W / 2 - 70, 306, 140, 32,
            { primary: false, screen: true, px: 13 });
    }
}

function drawGame(s, E) {
    var W = s.W, H = s.H, ESC = s.ESC, i;
    var groundY = GROUND * ESC;
    // chao
    E.gfx.rect(0, groundY, W, 3, 0x05E0, { screen: true });
    E.gfx.rect(0, groundY + 3, W, 6, 0x02A0, { screen: true });
    // estilingue
    var bx = BERCO.x * ESC, by = BERCO.y * ESC;
    E.gfx.line(GARFO[0].x * ESC, GARFO[0].y * ESC, bx, by, C((0x7A4A20)), { w: 3 });
    E.gfx.line(GARFO[1].x * ESC, GARFO[1].y * ESC, bx, by, C((0x7A4A20)), { w: 3 });
    var px = bx + (s.pullX || 0) * ESC, py = by + (s.pullY || 0) * ESC;
    E.gfx.line(GARFO[0].x * ESC, GARFO[0].y * ESC, px, py, C((0x4A2A10)), { w: 2 });
    E.gfx.line(GARFO[1].x * ESC, GARFO[1].y * ESC, px, py, C((0x4A2A10)), { w: 2 });
    // pedra no berco
    if (s.tiro && (s.tiro.estado === 'pronto' || s.tiro.estado === 'carregando' || s.tiro.estado === 'mirando')) {
        E.spr.stamp('ai_atlas#ai3', px, py, { scale: 0.34, key: 0xF81F });
    }
    // mira
    var aim = s.aim || [];
    for (i = 0; i + 1 < aim.length; i += 2) {
        E.gfx.circle(aim[i] * ESC, aim[i + 1] * ESC, 2.2, OURO, { fill: true, screen: true });
    }
    // rastro
    var tr = s.trail || [];
    for (i = 0; i + 1 < tr.length; i += 2) {
        E.gfx.circle(tr[i] * ESC, tr[i + 1] * ESC, 2, 0xCE79, { fill: true, screen: true });
    }
    // projeteis
    for (i = 0; i < s.corpos.length; i++) {
        var c = s.corpos[i];
        if (!c || c.k !== 'tiro' || c.morto) continue;
        var o = i * NS, st = s.state;
        if (!st || !(st[o + SFL] & 1)) continue;
        var x = st[o + SX] * ESC, y = st[o + SY] * ESC;
        var name = c.tipo === 'ovo' ? 'bomba' :
            (c.tipo === 'pedra' || c.tipo === 'pedrao' ? 'ai_atlas#ai3' : c.tipo);
        var sc = c.r * 2 * ESC / 64;
        if (name === 'ai_atlas#ai3') {
            E.spr.stamp(name, x, y, { scale: sc, key: 0xF81F });
        } else {
            E.spr.stamp(name, x, y, { scale: sc, key: 0xF81F,
                angle: st[o + SA] * 180 / Math.PI });
        }
    }
    // HUD
    drawHud(s, E);
    if (s.msg) {
        E.gfx.text(s.msg, W / 2, 92, { px: 20, align: 'center', valign: 'middle',
            color: OURO, bg: C(0x0A1A12), screen: true });
    }
    if (s.paused) {
        E.gfx.rect(0, 0, W, H, C(0x05080E), { screen: true });
        E.gfx.panel(60, 150, W - 120, 190, { bg: PAINEL, stroke: OURO, r: 12, screen: true });
        E.gfx.text('PAUSA', W / 2, 186, { px: 32, align: 'center', color: OURO });
        s.btnResume = E.gfx.button('CONTINUAR', W / 2 - 100, 228, 200, 42,
            { primary: true, screen: true, px: 17 });
        s.btnMapPause = E.gfx.button('MAPA', W / 2 - 60, 282, 120, 32,
            { primary: false, screen: true, px: 13 });
    }
    if (s.ended) {
        E.gfx.text(s.won ? 'FASE LIMPA!' : 'SEM PEDRAS',
            W / 2, H / 2 - 10, { px: 34, align: 'center', valign: 'middle',
                color: s.won ? OURO : VERMELHO, bg: C(0x0A1A12), screen: true });
        E.gfx.text('fase ' + s.level + '  ·  ' + s.score + ' pts',
            W / 2, H / 2 + 28, { px: 16, align: 'center', color: BRANCO,
                bg: C(0x0A1A12), screen: true });
    }
}

function drawHud(s, E) {
    var W = s.W, H = s.H;
    s.btnPause = { x: 6, y: 6, w: 36, h: 28 };
    E.gfx.rect(s.btnPause.x, s.btnPause.y, s.btnPause.w, s.btnPause.h,
        PAINEL, { r: 6, screen: true });
    E.gfx.text('II', s.btnPause.x + s.btnPause.w / 2, s.btnPause.y + s.btnPause.h / 2,
        { px: 14, align: 'center', valign: 'middle', color: BRANCO, screen: true });
    E.gfx.text('PONTOS ' + s.score, W - 10, 8,
        { px: 16, align: 'right', color: BRANCO, screen: true });
    E.gfx.text('FASE ' + s.level + '  ' + s.levelName, 54, 8,
        { px: 13, color: TEXT, screen: true });
    E.gfx.text('GOBLINS ' + s.goblins + '   TIROS ' +
        (s.shotsQueue ? s.shotsQueue.length : 0), 54, 28,
        { px: 12, color: TEXT2, screen: true });
    var t = s.tiro;
    if (t) {
        E.gfx.text(t.tipo.toUpperCase() + (t.estado === 'pronto' ? '  PRONTA' : ''),
            W / 2, H - 24, { px: 14, align: 'center', color: OURO, screen: true });
    }
}
