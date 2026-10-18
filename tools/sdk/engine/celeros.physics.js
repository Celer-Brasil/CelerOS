// physics.js — fisica para apps CelerOS (ES5 puro, zero dependencia). Modulo
// OPCIONAL da engine. E a escada de fisica do CelerOS a partir do degrau 1:
// arcade de poucos corpos fica na mao (pools + reflexao — template do
// `celer.js new --game` e o Game Engine Guide, secao 15).
//
//   var P = require("celeros.physics");
//
//   P.hit(a, b)                    // sobreposicao estatica (circ/circ, caixa, misto)
//   var v = P.verletFast({...});   // corda/pano/softbody — NATIVO (API 31,
//                                  //   System.verlet*) com fallback JS transparente
//   var w = P.rigid({...});        // corpo rigido que gira e empilha — NATIVO
//                                  //   (API 33, System.rigid*, placas S3)
//
// Coordenadas: y cresce para BAIXO (tela); x,y do corpo e o CENTRO. Corpo
// circular tem r; caixa tem w/h.
//
// 2.1: rigid.state() devolve SEMPRE o mesmo array, preenchido no lugar
// (System.rigidState com o 2o arg) — 6 x n numeros novos por quadro eram
// realloc + lixo para o GC. Firmware antigo ignora o arg e devolve um novo:
// o wrapper guarda o retorno, entao o app nao muda nos dois casos. Quem
// precisa de um retrato do quadro anterior copia (slice) antes do step.
//
// 2.0: P.world/P.tiles/P.flow SAIRAM do modulo (solver arcade interpretado,
// zero consumidores na loja — o caminho objeto-por-corpo que vira pressao de
// GC no Duktape; perseguicao em grade e com celeros.grid). Ficam P.hit,
// P.verlet, P.verletFast e P.rigid.
//
// 1.5: P.rigid — corpo rigido NATIVO (API 33, System.rigid*): caixas que
// giram e empilham, circulos que rolam, impulsos com atrito e sono. Sem
// fallback JS (um castelo de 30 pecas nao fecha o quadro no interpretado):
// em firmware sem o binding P.rigid devolve null e o app avisa.

// 2.1.1: verletFast com os mundos nativos ESGOTADOS (verletNew -> -1)
// devolvia um objeto "nativo" morto (todo step/add ia ao id -1 em silencio
// e a corda nunca aparecia) — cai no fallback JS como o firmware antigo.

var P = { version: '2.1.1' };

function isCircle(b) { return b.r !== undefined && b.r !== null; }

// teste estatico de sobreposicao, qualquer par de formas
P.hit = function (a, b) {
    var ac = isCircle(a), bc = isCircle(b);
    if (ac && bc) {
        var dx = a.x - b.x, dy = a.y - b.y, r = a.r + b.r;
        return dx * dx + dy * dy <= r * r;
    }
    if (!ac && !bc) {
        return Math.abs(a.x - b.x) * 2 <= a.w + b.w &&
               Math.abs(a.y - b.y) * 2 <= a.h + b.h;
    }
    var c = ac ? a : b, q = ac ? b : a;
    var cx = Math.max(q.x - q.w / 2, Math.min(c.x, q.x + q.w / 2));
    var cy = Math.max(q.y - q.h / 2, Math.min(c.y, q.y + q.h / 2));
    var ddx = c.x - cx, ddy = c.y - cy;
    return ddx * ddx + ddy * ddy <= c.r * c.r;
};

// corda/pano/softbody (Verlet, pontos + hastes) — o esquema do Physics Drop
P.verlet = function (opts) {
    opts = opts || {};
    var pts = opts.points || [];
    var sticks = opts.sticks || [];
    var v = { points: pts, sticks: sticks, iterations: opts.iterations || 4 };
    var i, p;
    for (i = 0; i < pts.length; i++) {
        p = pts[i];
        if (p.px === undefined) { p.px = p.x; p.py = p.y; }
        if (p.pin === undefined) p.pin = false;
    }
    v.stickLen = function (s) {
        var A = pts[s.a], B = pts[s.b];
        s.len = Math.sqrt((A.x - B.x) * (A.x - B.x) + (A.y - B.y) * (A.y - B.y));
        return s.len;
    };
    for (i = 0; i < sticks.length; i++) {
        if (sticks[i].len === undefined) v.stickLen(sticks[i]);
    }
    v.stick = function (a, b, len) {
        var s = { a: a, b: b, len: len };
        if (len === undefined) v.stickLen(s);
        sticks.push(s);
        return s;
    };
    v.pin = function (i, on) { pts[i].pin = on === undefined ? true : !!on; };

    v.step = function (dt, o) {
        o = o || {};
        var g = o.gravity || { x: 0, y: 900 };
        var damp = o.damp === undefined ? 1 : o.damp;
        var dt2 = dt * dt;
        var i, p;
        for (i = 0; i < pts.length; i++) {
            p = pts[i];
            if (p.pin) { p.px = p.x; p.py = p.y; continue; }
            var vx = (p.x - p.px) * damp, vy = (p.y - p.py) * damp;
            p.px = p.x;
            p.py = p.y;
            p.x += vx + (g.x || 0) * dt2;
            p.y += vy + (g.y || 0) * dt2;
        }
        for (var k = 0; k < v.iterations; k++) {
            for (i = 0; i < sticks.length; i++) {
                var s = sticks[i];
                var A = pts[s.a], B = pts[s.b];
                var dx = B.x - A.x, dy = B.y - A.y;
                var d = Math.sqrt(dx * dx + dy * dy);
                if (d < 1e-6) continue;
                var ma = A.pin ? 0 : 1, mb = B.pin ? 0 : 1;
                var tot = ma + mb;
                if (!tot) continue;
                var f = (d - s.len) / d / tot;
                A.x += dx * f * ma;
                A.y += dy * f * ma;
                B.x -= dx * f * mb;
                B.y -= dy * f * mb;
            }
        }
        if (o.bounds) {
            var B2 = o.bounds, bb = o.bounce === undefined ? 0.5 : o.bounce;
            for (i = 0; i < pts.length; i++) {
                p = pts[i];
                if (p.pin) continue;
                if (p.x < B2.x) { var vx2 = p.x - p.px; p.x = B2.x; p.px = p.x + vx2 * bb; }
                if (p.x > B2.x + B2.w) { var vx3 = p.x - p.px; p.x = B2.x + B2.w; p.px = p.x + vx3 * bb; }
                if (p.y < B2.y) { var vy2 = p.y - p.py; p.y = B2.y; p.py = p.y + vy2 * bb; }
                if (p.y > B2.y + B2.h) { var vy3 = p.y - p.py; p.y = B2.y + B2.h; p.py = p.y + vy3 * bb; }
            }
        }
    };
    return v;
};

// P.verletFast — o mesmo verlet, acelerado: quando o firmware tem o step
// nativo (API 31, System.verletNew — JsPhysics.cpp, mundo em buffer C++ em
// float), a integracao/relaxacao/bounds roda fora do interpretador; sem o
// binding (firmware antigo, harness Node), cai para o P.verlet JS com a
// MESMA cara de uso — so que acessando por indice (xy()[2i], xy()[2i+1])
// em vez de array de objetos.
//
//   var v = P.verletFast({ iterations: 4 });
//   var a = v.add(20, 20), b = v.add(20, 80);
//   v.stick(a, b);            // len = distancia atual
//   v.pin(a);
//   v.step(1/60, { gravity: {x:0, y:900}, damp: 1,
//                  bounds: {x:0, y:0, w:240, h:320}, bounce: 0.5 });
//   var xy = v.xy();          // [xa, ya, xb, yb, ...] plano
//   var st = v.sticks();      // [a0, b0, a1, b1, ...]
//   v.set(b, 60, 40);         // move (o dedo puxando)
//   v.free();                 // devolve o mundo (Limpar/Refazer)
// 1.3.0: opts.radius liga a colisao ponto-ponto (nativo; O(n^2) em C++ —
// o fallback JS nao tem colisao), delStick/delPoint/pins completam o
// manuseio (tesoura/borracha/pinos) nos dois caminhos.
P.verletFast = function (opts) {
    opts = opts || {};
    if (typeof System === "undefined" || !System.verletNew) return verletFastJS(opts);
    var id = System.verletNew(opts.iterations || 4, opts.radius || 0);
    if (!(id > 0)) return verletFastJS(opts);
    var v = {
        native: true, id: id,
        step: function (dt, o) {
            o = o || {};
            var g = o.gravity || { x: 0, y: 900 };
            var b = o.bounds;
            System.verletStep(id, dt, g.x || 0, g.y || 0,
                              o.damp === undefined ? 1 : o.damp,
                              b ? b.x : 0, b ? b.y : 0,
                              b ? b.x + b.w : 0, b ? b.y + b.h : 0,
                              o.bounce === undefined ? 0.5 : o.bounce);
        },
        xy: function () { return System.verletXY(id); },
        sticks: function () { return System.verletSticks(id); },
        add: function (x, y) { return System.verletAddPoint(id, x, y); },
        stick: function (a, b, len) { System.verletStick(id, a, b, len); },
        pin: function (i, on) { System.verletPin(id, i, on === undefined ? true : !!on); },
        set: function (i, x, y) { System.verletSet(id, i, x, y); },
        count: function () { return System.verletCount(id); },
        delStick: function (i) { return System.verletDelStick(id, i); },
        delPoint: function (i) { return System.verletDelPoint(id, i); },
        pins: function () { return System.verletPins(id); },
        free: function () {
            if (id > 0) System.verletFree(id);
            id = -1;
        }
    };
    return v;
};

// fallback JS: o P.verlet classico embrulhado na MESMA interface do
// verletFast (indices + arrays planos) — sem o binding nativo o app nao
// muda; so a colisao ponto-ponto nao existe (O(n^2) interpretado nao cabe)
function verletFastJS(opts) {
    var v = P.verlet(opts);
    return {
        native: false,
        step: function (dt, o) { v.step(dt, o); },
        xy: function () {
            var out = [];
            for (var i = 0; i < v.points.length; i++) out.push(v.points[i].x, v.points[i].y);
            return out;
        },
        sticks: function () {
            var out = [];
            for (var i = 0; i < v.sticks.length; i++) out.push(v.sticks[i].a, v.sticks[i].b);
            return out;
        },
        add: function (x, y) {
            v.points.push({ x: x, y: y, px: x, py: y, pin: false });
            return v.points.length - 1;
        },
        stick: function (a, b, len) { v.stick(a, b, len); },
        pin: function (i, on) { v.pin(i, on); },
        set: function (i, x, y) {
            var p = v.points[i];
            if (p) { p.x = x; p.y = y; }
        },
        count: function () { return v.points.length; },
        delStick: function (i) {
            if (i >= 0 && i < v.sticks.length) { v.sticks.splice(i, 1); return true; }
            return false;
        },
        delPoint: function (idx) {
            if (idx < 0 || idx >= v.points.length) return false;
            v.points.splice(idx, 1);
            var keep = [];
            for (var k = 0; k < v.sticks.length; k++) {
                var s = v.sticks[k];
                if (s.a === idx || s.b === idx) continue;
                keep.push({ a: s.a > idx ? s.a - 1 : s.a,
                            b: s.b > idx ? s.b - 1 : s.b, len: s.len });
            }
            v.sticks = keep;
            return true;
        },
        pins: function () {
            var out = [];
            for (var i = 0; i < v.points.length; i++) out.push(v.points[i].pin ? 1 : 0);
            return out;
        },
        free: function () { v.points = []; v.sticks = []; }
    };
};

// ------------------------------------------------------------ rigid -------
// Corpo rigido nativo (API 33): o solver roda em C++ (main/Utils/Rigid2D.h)
// e o JS conversa por INDICE estavel — nada de objeto por corpo no heap.
//
//   var w = P.rigid({ iterations: 10 });     // null sem o binding
//   var chao = w.box(160, 270, 400, 20, { static: true });
//   var tabua = w.box(200, 240, 48, 6, { density: 0.6, friction: 0.7 });
//   var pedra = w.circle(40, 200, 6, { density: 3, bounce: 0.3 });
//   w.set(pedra, 40, 200, 0, 420, -40, 0);  // teleporte + velocidade
//   w.step(dt, { gravity: { x: 0, y: 400 } });
//   var s = w.state();      // [x, y, ang, hit, rapidez, flags] por indice
//   w.x(tabua, s) ...       // leitores sobre o array do quadro
//   s[i * w.N + 5] & 1      // laco quente: indexe direto (sem chamada)
//
// Unidades livres (as do app), angulo em radianos, y para baixo. hit = o
// maior impulso de impacto do ultimo step (o app tira dano disso); flags:
// 1 vivo, 2 acordado (dormindo = parado ha 0,5 s, vira estatico ate levar
// pancada). remove() libera o indice para o proximo add.
P.rigid = function (opts) {
    opts = opts || {};
    if (typeof System === "undefined" || !System.rigidNew) return null;
    var id = System.rigidNew(opts.iterations || 10);
    if (id < 0) return null;
    var N = 6;
    var buf = [];   // o array do state(), reaproveitado (2.1)
    function o3(o) { return o || {}; }
    return {
        id: id,
        N: N,
        box: function (x, y, w, h, o) {
            o = o3(o);
            return System.rigidBox(id, x, y, w, h, o.angle || 0,
                                   o.static ? 0 : (o.density === undefined ? 1 : o.density),
                                   o.friction === undefined ? 0.6 : o.friction,
                                   o.bounce === undefined ? 0.1 : o.bounce);
        },
        circle: function (x, y, r, o) {
            o = o3(o);
            return System.rigidCircle(id, x, y, r,
                                      o.static ? 0 : (o.density === undefined ? 1 : o.density),
                                      o.friction === undefined ? 0.6 : o.friction,
                                      o.bounce === undefined ? 0.1 : o.bounce);
        },
        remove: function (i) { return System.rigidRemove(id, i); },
        set: function (i, x, y, a, vx, vy, w) {
            return System.rigidSet(id, i, x, y, a || 0, vx || 0, vy || 0, w || 0);
        },
        impulse: function (i, jx, jy) { return System.rigidImpulse(id, i, jx, jy); },
        // devolve quantos sub-passos rodou (o anti-tunel sobe quando ha
        // corpo rapido; maxSub limita o custo)
        step: function (dt, o) {
            o = o3(o);
            var g = o.gravity || { x: 0, y: 400 };
            return System.rigidStep(id, dt, g.x || 0, g.y || 0, o.maxSub || 12);
        },
        state: function () { return (buf = System.rigidState(id, buf)); },
        count: function () { return System.rigidCount(id); },
        x: function (i, s) { return s[i * N]; },
        y: function (i, s) { return s[i * N + 1]; },
        angle: function (i, s) { return s[i * N + 2]; },
        hit: function (i, s) { return s[i * N + 3]; },
        speed: function (i, s) { return s[i * N + 4]; },
        alive: function (i, s) { return (s[i * N + 5] & 1) !== 0; },
        awake: function (i, s) { return (s[i * N + 5] & 2) !== 0; },
        free: function () {
            if (id > 0) System.rigidFree(id);
            id = -1;
        }
    };
};

module.exports = P;
