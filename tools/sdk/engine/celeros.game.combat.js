// game.combat.js — CelerGame COMBAT (dep "celeros.game.combat"): combate de
// acao — corpos com time (heroi x monstros), hitboxes que vivem alguns ms
// (golpe de espada, explosao), projeteis (pedra, flecha, bumerangue que
// volta), dano pelos atributos do celeros.game.stats (iframes inclusos),
// knockback e hitstop. Decora o core no require:
//
//   var E = require("celeros.game");
//   require("celeros.game.combat");
//   E.combat.body(heroi, { team: "heroi", stats: heroi.st });
//   E.combat.body(polvo, { team: "monstro", stats: polvo.st,
//                          onKill: function (p) { p.dead = true; } });
//   // no golpe: espada a frente por 120 ms
//   E.combat.sword(heroi, heroi.dir, { reach: 26, width: 22, dmg: 1, knock: 220 });
//   // tiro do polvo
//   E.combat.shot(polvo, { x: polvo.x, y: polvo.y, vx: 0, vy: 140, r: 5,
//                          dmg: 1, map: mapa });
//   // movimento com knockback (no update de cada entidade):
//   E.combat.move(heroi, dt, mapa);
//
// Corpo = retangulo de CANTO {x, y, w, h} da entidade (o mesmo do
// collide.move), com folga o {ox, oy, w, h} opcional. Time: hitbox nunca
// fere o proprio time nem o dono. Sem stats o corpo usa ent.hp. Tudo
// resolvido no tick da engine (congela no E.pause). Com celeros.game.events
// carregado emite "hit" (alvo, dano, fonte) e "kill" (alvo, fonte).
//
// 1.0.1: ate 24 corpos o teste e direto, sem hash nem closure por quadro
// (o hash custava ~9 ms/quadro no 4848 com 4 corpos); golpe sem dano
// (bumerangue) so atordoa.

var E = require('celeros.game');
require('celeros.game.collide');

var _bodies = [], _hits = [], _shots = [];
var _hash = null;
var _box = { x: 0, y: 0, w: 0, h: 0 };

// caixa de dano do corpo (scratch: o teste le na hora)
function boxOf(b) {
    var e = b.ent;
    _box.x = e.x + b.ox;
    _box.y = e.y + b.oy;
    _box.w = b.w !== undefined ? b.w : (e.w || 16);
    _box.h = b.h !== undefined ? b.h : (e.h || 16);
    return _box;
}
// centro do corpo (direcao do knockback)
function cx(b) { var e = b.ent; return e.x + b.ox + (b.w !== undefined ? b.w : (e.w || 16)) / 2; }
function cy(b) { var e = b.ent; return e.y + b.oy + (b.h !== undefined ? b.h : (e.h || 16)) / 2; }

// aplica um golpe ao corpo; devolve o dano efetivo (0 = iframes/imune)
function strike(b, dmg, src, kx, ky, knock, o) {
    if (b.dead) return 0;
    var e = b.ent, real;
    var dir = null;
    var L = Math.sqrt(kx * kx + ky * ky);
    if (L > 0) { dir = { x: kx / L, y: ky / L }; }
    if (b.immune && b.immune(src, o)) return 0;
    // golpe sem dano (bumerangue): so atordoa
    if (!(dmg > 0)) {
        if (o && o.stun > 0) {
            e._stunT = Math.max(e._stunT || 0, o.stun);
            if (b.onHit) b.onHit(e, 0, src);
        }
        return 0;
    }
    if (b.stats) real = b.stats.damage(dmg, { source: src, dir: dir, pierce: o && o.pierceDef });
    else {
        if (b._invT > 0) return 0;
        real = Math.min(dmg, e.hp === undefined ? dmg : e.hp);
        if (e.hp !== undefined) e.hp -= real;
        b._invT = b.iframes;
    }
    if (!(real > 0)) return 0;
    if (knock > 0 && dir && b.knockRes < 1) {
        var k = knock * (1 - b.knockRes);
        E.combat.knock(e, dir.x * k, dir.y * k, o && o.knockMs);
    }
    if (o && o.stun > 0) e._stunT = Math.max(e._stunT || 0, o.stun);
    if (b.onHit) b.onHit(e, real, src);
    if (E.emit) E.emit('hit', e, real, src);
    var morto = b.stats ? b.stats.dead : (e.hp !== undefined && e.hp <= 0);
    if (morto) {
        b.dead = true;
        if (b.onKill) b.onKill(e, src);
        if (E.emit) E.emit('kill', e, src);
    }
    if (E.freeze && (o ? o.stop !== 0 : true)) E.freeze(o && o.stop !== undefined ? o.stop : E.combat.hitstop);
    return real;
}

// alvos que a forma toca: direto (poucos corpos) ou pelo hash; fn(caixa)
// chamada por corpo tocado. Handlers sem closure por quadro (estado em
// _cH/_cSh/_cS)
var HASH_MIN = 24;
var _cH = null, _cSh = null, _cS = null;
function alvos(shape, fn, usaHash) {
    if (usaHash) { _hash.query(shape, fn); return; }
    for (var k = 0; k < _bodies.length; k++) {
        var bx = _bodies[k]._bx;
        if (bx && E.collide.test(shape, bx)) fn(bx);
    }
}
function acertoHit(q) {
    var h = _cH, sh = _cSh, tb = q.b;
    if (tb.dead || tb.ent === h.owner) return;
    if (h.team !== '*' && tb.team === h.team) return;
    if (h.once && h.got.indexOf(tb) >= 0) return;
    var dirFixa = h.fx !== undefined && (h.fx || h.fy);
    var kx = dirFixa ? h.fx : cx(tb) - (sh.r !== undefined ? sh.x : sh.x + sh.w / 2);
    var ky = dirFixa ? h.fy : cy(tb) - (sh.r !== undefined ? sh.y : sh.y + sh.h / 2);
    var real = strike(tb, h.dmg, h.owner, kx, ky, h.knock, h);
    if (h.once) h.got.push(tb);
    if (real > 0 && h.onHit) h.onHit(tb.ent, h);
}
function acertoShot(q) {
    var s = _cS, tb = q.b;
    if (s.dead || tb.dead || tb.ent === s.owner) return;
    if (s.team !== '*' && tb.team === s.team) return;
    if (s._got.indexOf(tb) >= 0) return;
    var real = strike(tb, s.dmg, s.owner, s.vx, s.vy, s.knock, s);
    s._got.push(tb);
    if (s.onHit) s.onHit(tb.ent, s, real);
    if (!s.pierce) s.dead = true;
}

E.combat = {
    version: '1.0.1',
    hitstop: 45,        // ms de congelamento por golpe que acerta (0 desliga)

    // registra a entidade como alvo: o {team, stats, ox, oy, w, h,
    // knockRes 0..1 (1 = nao recua), iframes (ms, sem stats), immune(src,
    // hit) -> true ignora, onHit(ent, dano, src), onKill(ent, src)}
    body: function (ent, o) {
        o = o || {};
        var b = { ent: ent, team: o.team || 'neutro', stats: o.stats || null,
                  ox: o.ox || 0, oy: o.oy || 0, w: o.w, h: o.h,
                  knockRes: o.knockRes || 0, iframes: o.iframes === undefined ? 300 : o.iframes,
                  _invT: 0, dead: false, immune: o.immune || null,
                  onHit: o.onHit || null, onKill: o.onKill || null };
        b.remove = function () { b.dead = true; };
        ent._cbody = b;
        _bodies.push(b);
        return b;
    },
    // hitbox viva por ms: shape {x, y, w, h} | {x, y, r} de MUNDO ou
    // fn() -> shape (segue o dono). o {team (default do dono), dmg (1),
    // knock (px/s), ms (100), once (true: cada alvo 1x por hitbox), stun
    // (ms), stop (hitstop ms), onHit(alvo, hb)}
    hit: function (owner, shape, o) {
        o = o || {};
        var ob = owner && owner._cbody;
        var h = { owner: owner, shape: shape, team: o.team || (ob ? ob.team : 'neutro'),
                  dmg: o.dmg === undefined ? 1 : o.dmg, knock: o.knock || 0,
                  t: 0, ms: o.ms === undefined ? 100 : o.ms, once: o.once !== false,
                  stun: o.stun || 0, stop: o.stop, knockMs: o.knockMs,
                  onHit: o.onHit || null, dead: false, got: [], fx: o.fx, fy: o.fy };
        _hits.push(h);
        return h;
    },
    // golpe a frente do dono: dir 'up'|'down'|'left'|'right' (ou {x, y});
    // o {reach (px a frente, 24), width (largura do golpe, 20), ms (110)}
    // + as opts do hit. O knockback empurra NA direcao do golpe
    sword: function (owner, dir, o) {
        o = o || {};
        var reach = o.reach || 24, wid = o.width || 20;
        var dx = 0, dy = 0;
        if (typeof dir === 'object' && dir) { dx = dir.x; dy = dir.y; }
        else if (dir === 'up') dy = -1;
        else if (dir === 'down') dy = 1;
        else if (dir === 'left') dx = -1;
        else dx = 1;
        var sh = { x: 0, y: 0, w: 0, h: 0 };
        var f = function () {
            var w = owner.w || 16, hh = owner.h || 16;
            var mx = owner.x + w / 2, my = owner.y + hh / 2;
            if (dx !== 0) {
                sh.w = reach; sh.h = wid;
                sh.x = dx > 0 ? owner.x + w : owner.x - reach;
                sh.y = my - wid / 2;
            } else {
                sh.w = wid; sh.h = reach;
                sh.x = mx - wid / 2;
                sh.y = dy > 0 ? owner.y + hh : owner.y - reach;
            }
            return sh;
        };
        var oo = {};
        for (var k in o) oo[k] = o[k];
        if (oo.ms === undefined) oo.ms = 110;
        oo.fx = dx; oo.fy = dy;
        return E.combat.hit(owner, f, oo);
    },
    // explosao: circulo de raio r em (x, y) por 1 tick; fere TODOS os
    // times (team: 'todos') salvo o.team. o.walls(cx, cy, r) opcional
    blast: function (x, y, r, o) {
        o = o || {};
        var oo = { team: o.team || '*', dmg: o.dmg === undefined ? 2 : o.dmg,
                   knock: o.knock === undefined ? 260 : o.knock, ms: o.ms === undefined ? 60 : o.ms,
                   stop: o.stop, onHit: o.onHit };
        return E.combat.hit(o.owner || null, { x: x, y: y, r: r }, oo);
    },
    // projetil: o {x, y (centro), vx, vy (px/s), r (5), dmg (1), knock,
    // life (ms, 2000), team (do dono), map (solidAt: some na parede),
    // pierce (atravessa alvos), boomerang {range px, speed} (vai, volta ao
    // dono; volta antes se bater), onWall(s), onHit(alvo, s), stun}
    shot: function (owner, o) {
        o = o || {};
        var ob = owner && owner._cbody;
        var s = { owner: owner, x: o.x, y: o.y, vx: o.vx || 0, vy: o.vy || 0, r: o.r || 5,
                  team: o.team || (ob ? ob.team : 'neutro'), dmg: o.dmg === undefined ? 1 : o.dmg,
                  knock: o.knock || 0, life: o.life || 2000, t: 0, dead: false,
                  pierce: !!o.pierce, map: o.map || null, stun: o.stun || 0,
                  _boom: o.boomerang || null, back: false, dist: 0, _got: [],
                  onWall: o.onWall || null, onHit: o.onHit || null, onBack: o.onBack || null };
        if (s._boom) {
            var sp = s._boom.speed || Math.sqrt(s.vx * s.vx + s.vy * s.vy) || 200;
            var L = Math.sqrt(s.vx * s.vx + s.vy * s.vy) || 1;
            s.vx = s.vx / L * sp; s.vy = s.vy / L * sp;
            s.speed = sp;
            s.pierce = true;
        }
        _shots.push(s);
        return s;
    },
    // empurra ent com velocidade (kx, ky) px/s que decai em ms (180)
    knock: function (ent, kx, ky, ms) {
        ent._kx = kx;
        ent._ky = ky;
        ent._kt = ms || 180;
        ent._k0 = ent._kt;
    },
    // ent ainda sendo empurrado? (sem controle do jogador)
    knocked: function (ent) { return (ent._kt || 0) > 0; },
    stunned: function (ent) { return (ent._stunT || 0) > 0; },
    // move ent por (vx, vy) + knockback em dt contra o map (collide.move,
    // desliza na parede) ou livre; devolve o resultado do collide.move
    move: function (ent, dt, map) {
        var kx = 0, ky = 0;
        if (ent._kt > 0) {
            var f = ent._kt / ent._k0;
            kx = ent._kx * f;
            ky = ent._ky * f;
        }
        var stun = ent._stunT > 0;
        var vx = (stun ? 0 : (ent.vx || 0)) + kx, vy = (stun ? 0 : (ent.vy || 0)) + ky;
        if (map) {
            var keep = { vx: ent.vx, vy: ent.vy };
            var r = E.collide.move(ent, vx * dt, vy * dt, map);
            // o move zera vx/vy no eixo que bateu: so a velocidade PROPRIA
            // conta (o knockback na parede para tambem)
            if (r.hitX) { ent._kx = 0; ent.vx = 0; } else ent.vx = keep.vx;
            if (r.hitY) { ent._ky = 0; ent.vy = 0; } else ent.vy = keep.vy;
            return r;
        }
        ent.x += vx * dt;
        ent.y += vy * dt;
        return null;
    },
    // vivos (diagnostico)
    count: function () { return { bodies: _bodies.length, hits: _hits.length, shots: _shots.length }; },
    // zera tudo (troca de sala/cena)
    clear: function () { _bodies.length = 0; _hits.length = 0; _shots.length = 0; },
    // corpos de um time (para IA: alvo mais perto)
    team: function (name) {
        var out = [];
        for (var i = 0; i < _bodies.length; i++) {
            if (!_bodies[i].dead && _bodies[i].team === name) out.push(_bodies[i].ent);
        }
        return out;
    },

    _tick: function (dt) {
        var ms = dt * 1000, i, b;
        if (!_hash) _hash = E.collide.hash(32);
        // timers de corpo (iframes sem stats, knockback, atordoado)
        for (i = 0; i < _bodies.length; i++) {
            b = _bodies[i];
            var e = b.ent;
            if (b._invT > 0) b._invT -= ms;
            if (e._kt > 0) e._kt -= ms;
            if (e._stunT > 0) e._stunT -= ms;
            if (e.dead) b.dead = true;
        }
        var w = 0;
        for (i = 0; i < _bodies.length; i++) if (!_bodies[i].dead) _bodies[w++] = _bodies[i];
        _bodies.length = w;
        // caixas dos corpos (copia: o scratch boxOf nao pode ir para o hash).
        // Ate HASH_MIN corpos o teste e DIRETO (sem hash, sem closure por
        // quadro): no Duktape o hash com chave string + array por consulta
        // custava ~9 ms/quadro no 4848 com 4 corpos — o jogo caia a 14 fps
        var usaHash = _bodies.length > HASH_MIN;
        if (usaHash) _hash.clear();
        for (i = 0; i < _bodies.length; i++) {
            b = _bodies[i];
            var bx = boxOf(b);
            if (!b._bx) b._bx = { x: 0, y: 0, w: 0, h: 0, b: null };
            b._bx.x = bx.x; b._bx.y = bx.y; b._bx.w = bx.w; b._bx.h = bx.h; b._bx.b = b;
            if (usaHash) _hash.add(b._bx);
        }
        // hitboxes
        for (i = 0; i < _hits.length; i++) {
            var h = _hits[i];
            if (h.dead) continue;
            _cH = h;
            _cSh = typeof h.shape === 'function' ? h.shape() : h.shape;
            alvos(_cSh, acertoHit, usaHash);
            h.t += ms;
            if (h.t >= h.ms) h.dead = true;
        }
        w = 0;
        for (i = 0; i < _hits.length; i++) if (!_hits[i].dead) _hits[w++] = _hits[i];
        _hits.length = w;
        // projeteis
        for (i = 0; i < _shots.length; i++) {
            var s = _shots[i];
            if (s.dead) continue;
            s.t += ms;
            if (s._boom) {
                if (!s.back && s.dist >= (s._boom.range || 120)) s.back = true;
                if (s.back) {
                    var ow = s.owner;
                    var tx = ow ? ow.x + (ow.w || 0) / 2 : s.x, ty = ow ? ow.y + (ow.h || 0) / 2 : s.y;
                    var dx = tx - s.x, dy = ty - s.y, d = Math.sqrt(dx * dx + dy * dy);
                    if (d < s.speed * dt + s.r || !ow) {
                        s.dead = true;
                        if (s.onBack) s.onBack(s);
                        continue;
                    }
                    s.vx = dx / d * s.speed;
                    s.vy = dy / d * s.speed;
                }
            }
            var mvx = s.vx * dt, mvy = s.vy * dt;
            s.x += mvx;
            s.y += mvy;
            s.dist += Math.sqrt(mvx * mvx + mvy * mvy);
            if (s.map && s.map.solidAt(s.x, s.y)) {
                if (s.onWall) s.onWall(s);
                if (s._boom) { s.back = true; s.x -= mvx; s.y -= mvy; }
                else { s.dead = true; continue; }
            }
            _cS = s;
            alvos(s, acertoShot, usaHash);
            if (s.t >= s.life) s.dead = true;
        }
        w = 0;
        for (i = 0; i < _shots.length; i++) if (!_shots[i].dead) _shots[w++] = _shots[i];
        _shots.length = w;
    },

    // desenho padrao dos projeteis (circulo) — jogos com sprite passam
    // fn(s) para desenhar cada um
    drawShots: function (fn, color) {
        for (var i = 0; i < _shots.length; i++) {
            var s = _shots[i];
            if (fn) fn(s);
            else E.gfx.circle(s.x, s.y, s.r, color === undefined ? 0xFFFF : color);
        }
    },
    shots: function () { return _shots; }
};

E._modTicks.push(function (dt) { E.combat._tick(dt); });
E._mods.push('combat');

module.exports = E;
