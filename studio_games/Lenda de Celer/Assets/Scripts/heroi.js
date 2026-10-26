// heroi.js — Celer, a heroina: anda com o stick (analogico), golpeia com a
// espada (A), usa o item equipado (B: bomba ou bumerangue), leva dano com
// knockback e pisca nos iframes. Estados numa E.fsm.

var E = require('celeros.game');
var A = require('arte');
var SOM = require('som');

var H = {};
var DIRV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

H.criar = function (J) {
    var C = A.CELL, hb = Math.round(C * 0.68);
    var h = { x: 0, y: 0, w: hb, h: hb, vx: 0, vy: 0, dir: 'down', tipo: 'heroi',
              speed: C * 3.4, t: 0, item: null, golpe: null };
    h.st = E.stats({ hp: J.d.hpMax, def: 0 }, {
        iframes: 1000,
        onHit: function () { SOM.fx('hit'); E.cam.shake(Math.round(3 * A.K), 0.15); },
        onDeath: function () { h.fsm.go('morto'); }
    });
    h.st.hp = Math.min(J.d.hp || J.d.hpMax, J.d.hpMax);
    h.anim = E.anim.dir({
        down: ['heroi' + A.HEROI.down[0], 'heroi' + A.HEROI.down[1]],
        up: ['heroi' + A.HEROI.up[0], 'heroi' + A.HEROI.up[1]],
        right: ['heroi' + A.HEROI.right[0], 'heroi' + A.HEROI.right[1]],
        left: ['heroi' + A.HEROI.left[0], 'heroi' + A.HEROI.left[1]]
    }, 7);
    E.combat.body(h, { team: 'heroi', stats: h.st, knockRes: 0 });

    h.fsm = E.fsm(h, {
        andar: {
            update: function (m, dt) {
                var c = J.ctl;
                var mx = c.x, my = c.y;
                h.vx = mx * h.speed;
                h.vy = my * h.speed;
                var mexe = mx * mx + my * my > 0.02;
                if (mexe) {
                    if (Math.abs(mx) > Math.abs(my)) h.dir = mx > 0 ? 'right' : 'left';
                    else h.dir = my > 0 ? 'down' : 'up';
                }
                h.anim.face(h.dir);
                h.anim.walk(mexe && !E.combat.knocked(h));
                if (c.a) return m.go('espada');
                if (c.b) H.usarItem(h, J);
            }
        },
        espada: {
            enter: function (m) {
                h.vx = 0; h.vy = 0;
                h.anim.walk(false);
                SOM.fx('espada');
                J.interagir();                 // bau/porta/arbusto a frente
                h.golpe = E.combat.sword(h, h.dir, {
                    reach: Math.round(A.CELL * 0.95), width: Math.round(A.CELL * 0.85),
                    dmg: J.d.forca || 1, knock: A.CELL * 7, ms: 170,
                    onHit: function (alvo) {
                        var v = DIRV[h.dir];
                        E.fx.play('corte', alvo.x + (alvo.w || 0) / 2, alvo.y + (alvo.h || 0) / 2,
                                  { dir: Math.atan2(v[1], v[0]) });
                    }
                });
                J.cortarArbusto(h);
            },
            after: [0.2, 'andar']
        },
        item: { after: [0.18, 'andar'] },
        // erguendo um item novo (pose de 1,2 s com o item acima da cabeca)
        erguer: {
            enter: function (m, item) { m.data.item = item; h.vx = 0; h.vy = 0; h.anim.walk(false); h.anim.face('down'); },
            after: [1.3, 'andar']
        },
        // parado (dialogo, transicao de area)
        parado: { enter: function () { h.vx = 0; h.vy = 0; h.anim.walk(false); } },
        morto: {
            enter: function (m) {
                h.vx = 0; h.vy = 0;
                SOM.parar();
                SOM.fx('morte');
                E.fx.play('poof', h.x + h.w / 2, h.y + h.h / 2);
            },
            update: function (m) { if (m.time > 1.4 && !m.data.foi) { m.data.foi = true; J.morreu(); } }
        }
    }, 'andar');
    return h;
};

H.usarItem = function (h, J) {
    var it = J.d.itemB;
    if (it === 'bomba') {
        if (J.d.bombas <= 0) { SOM.fx('bad'); return; }
        // uma bomba por vez no chao (como no classico)
        if (J.bombaViva()) return;
        J.d.bombas--;
        var v = DIRV[h.dir];
        J.soltarBomba(h.x + h.w / 2 + v[0] * A.CELL * 0.8, h.y + h.h / 2 + v[1] * A.CELL * 0.8);
        h.fsm.go('item');
    } else if (it === 'bumerangue') {
        if (J.bumerangue && !J.bumerangue.dead) return;
        var d = DIRV[h.dir], cx = h.x + h.w / 2, cy = h.y + h.h / 2;
        SOM.fx('bumerangue');
        J.bumerangue = E.combat.shot(h, {
            x: cx, y: cy, vx: d[0], vy: d[1], r: Math.round(A.CELL * 0.3), dmg: 0,
            team: 'heroi', stun: 1500, map: J.W.fechado,
            boomerang: { range: A.CELL * 5, speed: A.CELL * 9 },
            onHit: function (alvo) { if (alvo.tipo === 'pickup') alvo.pegar(); }
        });
        J.bumerangue.giro = 0;
        h.fsm.go('item');
    } else {
        SOM.fx('bad');
        if (E.ui && E.ui.toast) E.ui.toast('Sem item no B', { ms: 900 });
    }
};

H.update = function (h, dt) {
    h.fsm.update(dt);
    if (h.fsm.is('morto')) return;
    h.anim.tick(dt);
};

// desenha deslocado (sx, sy) — o slide da sala carrega a heroina junto
H.draw = function (h, sx, sy) {
    if (h.st.blink(70) && !h.fsm.is('morto')) return;
    var cx = h.x + h.w / 2 + (sx || 0), cy = h.y + h.h / 2 + (sy || 0) - A.CELL * 0.12;
    if (h.fsm.is('morto')) return;
    if (h.fsm.is('espada')) {
        var v = DIRV[h.dir];
        // espada atras quando golpeia para cima (o corpo cobre o cabo)
        if (h.dir === 'up') A.at('heroi' + A.ESPADA.up, cx + A.CELL * 0.18, cy - A.CELL * 0.8);
        var idx = A.HEROI[h.dir][0];
        A.at('heroi' + idx, cx, cy);
        if (h.dir !== 'up') A.at('heroi' + A.ESPADA[h.dir], cx + v[0] * A.CELL * 0.85, cy + v[1] * A.CELL * 0.8 + (v[1] ? 0 : A.CELL * 0.1));
        return;
    }
    if (h.fsm.is('erguer')) {
        A.at('heroi' + A.HEROI.down[0], cx, cy);
        var it = h.fsm.data.item;
        if (it && A.ITEM[it] !== undefined) A.at('item' + A.ITEM[it], cx, cy - A.CELL * 0.9);
        return;
    }
    _o.scale = A.K;
    h.anim.draw(cx, cy, _o);
};
var _o = { cx: true, cy: true, scale: 1 };

module.exports = H;
