// inimigos.js — os monstros da Lenda de Celer, cada um com um modulo da
// CelerGame no cerebro:
//   polvo     — fsm (anda/para/cospe) + combat.shot (pedra)
//   morcego   — steer (wander + seek na heroina; voa por cima de tudo)
//   esqueleto — path.flow (persegue pelo labirinto, mapa compartilhado)
//   geleia    — pulos curtos na direcao da heroina
//   chefe     — o Guardiao de pedra: fsm de 3 fases (arremesso, investida,
//               chuva de pedras + morcegos)
// Todos sao corpos do combat (time "monstro") com stats; o toque fere a
// heroina por uma hitbox que segue o corpo.

var E = require('celeros.game');
var A = require('arte');
var SOM = require('som');

var I = {};
var DIRS = ['up', 'down', 'left', 'right'];
var DV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function base(tipo, sp, J, o) {
    var C = A.CELL, hb = Math.round(C * (o.tam || 0.7));
    var e = { tipo: tipo, x: sp.x - hb / 2, y: sp.y - hb / 2, w: hb, h: hb, vx: 0, vy: 0,
              dir: 'down', t: 0, dead: false, quadro: 0, spawn: sp };
    e.st = E.stats({ hp: o.hp || 1, def: 0 }, { iframes: o.iframes || 250 });
    E.combat.body(e, { team: 'monstro', stats: e.st, knockRes: o.knockRes || 0,
                       onKill: function () { J.matou(e); } });
    // toque fere a heroina (hitbox que segue o corpo)
    e.toque = E.combat.hit(e, function () { return e; }, { ms: 1e9, once: false, dmg: o.dano || 1,
                                                         knock: C * 6, stop: 0 });
    e.morrer = function () { e.dead = true; e.toque.dead = true; };
    return e;
}
function centro(e) { return { x: e.x + e.w / 2, y: e.y + e.h / 2 }; }
function desenhar(e, idx, k) {
    if (e.st.blink(60)) return;
    var c = centro(e);
    A.at('ini' + idx, c.x, c.y - A.CELL * 0.08, k);
}

// ------------------------------------------------------------ polvo ----
I.polvo = function (sp, J) {
    var C = A.CELL;
    var e = base('polvo', sp, J, { hp: 1 });
    e.fsm = E.fsm(e, {
        anda: {
            enter: function (m) { e.dir = E.m.pick(DIRS); m.data.dur = 0.6 + Math.random() * 1.2; },
            update: function (m) {
                var v = DV[e.dir];
                e.vx = v[0] * C * 1.6; e.vy = v[1] * C * 1.6;
                if (m.time > m.data.dur) return m.go(Math.random() < 0.45 ? 'mira' : 'anda', null, true);
            }
        },
        mira: {
            enter: function () { e.vx = 0; e.vy = 0; },
            update: function (m) {
                if (m.time > 0.45 && !m.data.foi) {
                    m.data.foi = true;
                    var v = DV[e.dir], c = centro(e);
                    E.combat.shot(e, { x: c.x + v[0] * C * 0.4, y: c.y + v[1] * C * 0.4,
                                       vx: v[0] * C * 5, vy: v[1] * C * 5, r: Math.round(C * 0.16),
                                       dmg: 1, knock: C * 5, map: J.W, team: 'monstro',
                                       onWall: function (s) { E.fx.play('pedrinha', s.x, s.y); } });
                }
                if (m.time > 0.8) m.go('anda');
            }
        }
    }, 'anda');
    e.update = function (dt) {
        e.t += dt;
        if (!E.combat.stunned(e)) e.fsm.update(dt);
        var r = E.combat.move(e, dt, J.W);
        if (r && (r.hitX || r.hitY) && e.fsm.is('anda')) e.fsm.go('anda', null, true);
    };
    e.draw = function () { desenhar(e, A.INI.polvo[Math.floor(e.t * 5) % 2]); };
    return e;
};

// ---------------------------------------------------------- morcego ----
I.morcego = function (sp, J) {
    var C = A.CELL;
    var e = base('morcego', sp, J, { hp: 1, tam: 0.6 });
    var ag = E.steer.agent(e, { speed: C * 2.6, force: C * 9 });
    var area = { x: J.W.ox + C * 0.5, y: J.W.oy + C * 0.5, w: J.W.pw - C, h: J.W.ph - C };
    e.pausa = Math.random();
    e.update = function (dt) {
        e.t += dt;
        if (E.combat.stunned(e)) { e.vx = 0; e.vy = 0; }
        else {
            // voo em rajadas: pousa um pouco a cada 2-3 s (o classico morcego)
            e.pausa -= dt;
            if (e.pausa < -2.4) e.pausa = 0.4 + Math.random() * 0.5;
            if (e.pausa > 0) { ag.stop(); }
            else {
                var hc = J.heroiCentro(), c = centro(e);
                if (E.m.dist(hc.x, hc.y, c.x, c.y) < C * 4.5) ag.seek(hc.x - e.w / 2, hc.y - e.h / 2, 0.8);
                ag.wander(1.2, { dist: C, r: C * 0.8, jitter: 0.9 });
                ag.within(area, C, 3);
                ag.update(dt);
            }
        }
        // o steer ja moveu o corpo: aqui so o empurrao do golpe (voa: sem mapa)
        if (E.combat.knocked(e)) {
            var svx = e.vx, svy = e.vy;
            e.vx = 0; e.vy = 0;
            E.combat.move(e, dt, null);
            e.vx = svx; e.vy = svy;
        }
    };
    e.draw = function () {
        var bate = e.pausa > 0 ? 0 : Math.floor(e.t * 10) % 2;
        desenhar(e, A.INI.morcego[bate]);
    };
    return e;
};

// -------------------------------------------------------- esqueleto ----
I.esqueleto = function (sp, J) {
    var C = A.CELL;
    var e = base('esqueleto', sp, J, { hp: 2, knockRes: 0.3, iframes: 350 });
    e.alvo = null;
    e.update = function (dt) {
        e.t += dt;
        if (E.combat.stunned(e)) { e.vx = 0; e.vy = 0; }
        else {
            var c = centro(e), cel = J.W.toCell(c.x, c.y);
            var fl = J.fluxo();
            var nx = cel && fl ? fl.next(cel.c, cel.r) : null;
            if (nx) {
                var rc = J.W.cellRect(nx.c, nx.r);
                var tx = rc.x + rc.w / 2, ty = rc.y + rc.h / 2;
                var dx = tx - c.x, dy = ty - c.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
                e.vx = dx / d * C * 1.9;
                e.vy = dy / d * C * 1.9;
                e.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
            } else { e.vx = 0; e.vy = 0; }
        }
        E.combat.move(e, dt, J.W);
    };
    e.draw = function () { desenhar(e, A.INI.esqueleto[e.dir === 'left' ? 1 : 0]); };
    return e;
};

// ----------------------------------------------------------- geleia ----
I.geleia = function (sp, J) {
    var C = A.CELL;
    var e = base('geleia', sp, J, { hp: 1 });
    e.salto = Math.random() * 0.8;
    e.voando = 0;
    e.update = function (dt) {
        e.t += dt;
        if (E.combat.stunned(e)) { e.vx = 0; e.vy = 0; e.voando = 0; }
        else if (e.voando > 0) {
            e.voando -= dt;
            if (e.voando <= 0) { e.vx = 0; e.vy = 0; }
        } else {
            e.salto -= dt;
            if (e.salto <= 0) {
                var hc = J.heroiCentro(), c = centro(e);
                var a = Math.atan2(hc.y - c.y, hc.x - c.x) + (Math.random() - 0.5) * 0.9;
                e.vx = Math.cos(a) * C * 4;
                e.vy = Math.sin(a) * C * 4;
                e.voando = 0.25;
                e.salto = 0.7 + Math.random() * 0.7;
            }
        }
        E.combat.move(e, dt, J.W);
    };
    e.draw = function () { desenhar(e, A.INI.geleia[e.voando > 0 ? 0 : 1]); };
    return e;
};

// ------------------------------------------------------------ chefe ----
// O Guardiao: 3x3 celulas, 10 de vida. Fase 1 anda e arremessa 3 pedras;
// fase 2 (<= 6) investe ate a parede e fica tonto (bom de bater); fase 3
// (<= 3) chuva de pedras em anel e chama morcegos.
I.chefe = function (sp, J) {
    var C = A.CELL;
    var e = base('chefe', sp, J, { hp: 10, tam: 2.2, knockRes: 0.85, iframes: 700, dano: 2 });
    e.fase = 1;
    e.chamou = false;
    function arremesso(n, abre) {
        var c = centro(e), hc = J.heroiCentro();
        var a0 = Math.atan2(hc.y - c.y, hc.x - c.x);
        for (var i = 0; i < n; i++) {
            var a = n === 1 ? a0 : a0 + (i - (n - 1) / 2) * abre;
            E.combat.shot(e, { x: c.x, y: c.y, vx: Math.cos(a) * C * 4.5, vy: Math.sin(a) * C * 4.5,
                               r: Math.round(C * 0.22), dmg: 1, knock: C * 6, map: J.W, team: 'monstro',
                               onWall: function (s) { E.fx.play('pedrinha', s.x, s.y); } });
        }
        SOM.fx('boom');
    }
    e.fsm = E.fsm(e, {
        '*': { update: function (m) {
            var f = e.st.hp <= 3 ? 3 : (e.st.hp <= 6 ? 2 : 1);
            if (f !== e.fase) { e.fase = f; E.cam.shake(Math.round(6 * A.K), 0.4); SOM.fx('alerta'); }
        } },
        anda: {
            enter: function (m) { m.data.dur = 1.6 + Math.random(); },
            update: function (m) {
                var hc = J.heroiCentro(), c = centro(e);
                var dx = hc.x - c.x;
                e.vx = E.m.clamp(dx, -1, 1) * C * (e.fase === 1 ? 1.1 : 1.6);
                e.vy = Math.sin(m.time * 2) * C * 0.8;
                if (m.time > m.data.dur) {
                    if (e.fase >= 2 && Math.random() < 0.55) return m.go('prepara');
                    return m.go('arremessa');
                }
            }
        },
        arremessa: {
            enter: function () { e.vx = 0; e.vy = 0; },
            update: function (m) {
                if (m.time > 0.35 && !m.data.a) { m.data.a = 1; arremesso(e.fase === 3 ? 5 : 3, 0.32); }
                if (e.fase === 3 && m.time > 0.8 && !m.data.b) {
                    m.data.b = 1;
                    arremesso(8, Math.PI * 2 / 8);
                    if (!e.chamou) { e.chamou = true; J.chamarMorcegos(2); }
                }
                if (m.time > 1.2) m.go('anda');
            }
        },
        prepara: {
            enter: function () { e.vx = 0; e.vy = 0; SOM.fx('alerta'); },
            update: function (m) {
                if (m.time > 0.6) {
                    var hc = J.heroiCentro(), c = centro(e);
                    var a = Math.atan2(hc.y - c.y, hc.x - c.x);
                    m.go('investe', a);
                }
            }
        },
        investe: {
            enter: function (m, a) { e.vx = Math.cos(a) * C * 7; e.vy = Math.sin(a) * C * 7; },
            update: function (m) { if (m.time > 1.6) m.go('anda'); }
        },
        tonto: {
            enter: function () { e.vx = 0; e.vy = 0; E.cam.shake(Math.round(8 * A.K), 0.35); SOM.fx('boomGra'); },
            after: [1.4, 'anda']
        }
    }, 'anda');
    e.update = function (dt) {
        e.t += dt;
        e.fsm.update(dt);
        var r = E.combat.move(e, dt, J.W);
        if (r && (r.hitX || r.hitY) && e.fsm.is('investe')) e.fsm.go('tonto');
    };
    e.draw = function () {
        if (e.st.blink(60)) return;
        var c = centro(e);
        var ferido = e.st.invuln() || e.fsm.is('tonto');
        A.at('chefe' + (ferido ? 1 : 0), c.x, c.y - C * 0.2);
    };
    return e;
};

// ------------------------------------------------------------- sabio ---
// NPC: fala quando a heroina chega perto e aperta A (jogo.interagir)
I.sabio = function (sp, J) {
    var C = A.CELL;
    var e = { tipo: 'sabio', x: sp.x - C * 0.4, y: sp.y - C * 0.4, w: C * 0.8, h: C * 0.8, t: 0, dead: false, npc: true };
    e.update = function (dt) { e.t += dt; };
    e.draw = function () {
        var c = centro(e);
        A.at('ini' + A.INI.sabio[0], c.x, c.y - C * 0.1);
        // chamas azuis ao lado (a gruta e magica)
        var f = Math.floor(e.t * 6) % 2;
        A.at('ini' + A.INI.chama[f], c.x - C * 1.6, c.y, 0.8);
        A.at('ini' + A.INI.chama[1 - f], c.x + C * 1.6, c.y, 0.8);
    };
    e.morrer = function () { e.dead = true; };
    return e;
};

I.criar = function (tipo, sp, J) { return I[tipo] ? I[tipo](sp, J) : null; };

module.exports = I;
