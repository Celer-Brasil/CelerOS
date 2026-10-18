// game.waves.js — CelerGame WAVES (dep "celeros.game.waves"): diretor de
// ondas para shooter, tower defense e arena — quem nasce, quando, quantos,
// e quando a onda acabou. Decora o core no require:
//
//   var E = require("celeros.game");
//   require("celeros.game.waves");
//   var w = E.waves([
//       { type: "zumbi", n: 6, every: 700 },                     // onda 1
//       { groups: [ { type: "zumbi", n: 8, every: 500 },          // onda 2
//                   { type: "cao", n: 3, every: 1200, delay: 2000 } ],
//         rest: 4000 }                                           // pausa depois
//   ], {
//       spawn: function (type, w, i) { inimigos.add(criar(type)); },
//       alive: function () { return inimigos.count; },           // onda so fecha com 0
//       onWave: function (w, n) { E.ui.toast("Onda " + n); },
//       onDone: function (w) { E.goto("vitoria"); },
//       endless: { grow: 1.25 }      // depois da ultima: repete crescendo 25%
//   });
//
// Estados (w.state): 'wait' (antes do start / no rest), 'spawn' (nascendo),
// 'clear' (tudo nasceu, esperando alive() zerar), 'done'. Anda no tick da
// engine (dt do jogo; congela no E.pause) e e da CENA onde nasceu (dorme sob
// E.push, morre quando ela sai). Sem auto:false comeca sozinho apos o.delay.

var E = require('celeros.game');

var _live = [];

function stacked(g) {
    var st = E._stack;
    if (st) for (var i = 0; i < st.length; i++) if (st[i].gen === g) return true;
    return false;
}

E.waves = function (list, o) {
    o = o || {};
    var w = {
        list: list, wave: 0,          // numero da onda corrente (1..; 0 antes)
        state: 'wait', dead: false,
        spawned: 0, total: 0,         // nascidos / a nascer nesta onda
        t: 0,                         // ms no estado
        gen: o.global || !E._sceneGen ? null : E._sceneGen,
        _groups: null, _wait: o.delay || 0, _auto: o.auto !== false
    };
    // definicao da onda n (1..), com o modo sem fim escalando a ultima
    w.def = function (n) {
        if (n <= list.length) return list[n - 1];
        if (!o.endless || !list.length) return null;
        var last = list[list.length - 1], k = Math.pow(o.endless.grow || 1.2, n - list.length);
        var gs = last.groups || [last], out = [];
        for (var i = 0; i < gs.length; i++) {
            var g = gs[i], c = {};
            for (var p in g) c[p] = g[p];
            c.n = Math.max(1, Math.round((g.n || 1) * k));
            out.push(c);
        }
        return { groups: out, rest: last.rest };
    };
    function begin(n) {
        var d = w.def(n);
        if (!d) {
            w.state = 'done';
            if (o.onDone) o.onDone(w);
            return;
        }
        w.wave = n;
        w.state = 'spawn';
        w.t = 0;
        w.spawned = 0;
        w.total = 0;
        var gs = d.groups || [d];
        w._groups = [];
        for (var i = 0; i < gs.length; i++) {
            var g = gs[i];
            w._groups.push({ type: g.type, n: g.n || 1, every: g.every || 0,
                             wait: g.delay || 0, left: g.n || 1, i: 0 });
            w.total += g.n || 1;
        }
        w._rest = d.rest === undefined ? (o.rest === undefined ? 2000 : o.rest) : d.rest;
        if (o.onWave) o.onWave(w, n);
    }
    w.start = function () { if (w.state === 'wait' && !w.wave) { w._wait = 0; w._auto = true; } };
    // pula a espera/encerra a onda atual e comeca a proxima ja
    w.next = function () { begin(w.wave + 1); };
    w.stop = function () { w.dead = true; };
    // 0..1 dos nascimentos da onda corrente
    w.progress = function () { return w.total ? w.spawned / w.total : 0; };
    // quantos ainda vao nascer nesta onda
    w.left = function () { return w.total - w.spawned; };
    w._tick = function (dt) {
        if (w.dead || w.state === 'done') return;
        var ms = dt * 1000;
        w.t += ms;
        if (w.state === 'wait') {
            if (!w._auto) return;
            w._wait -= ms;
            if (w._wait <= 0) begin(w.wave + 1);
            return;
        }
        if (w.state === 'spawn') {
            var pend = false;
            for (var i = 0; i < w._groups.length; i++) {
                var g = w._groups[i];
                if (!g.left) continue;
                pend = true;
                g.wait -= ms;
                // every 0 = o grupo inteiro de uma vez; teto de 32 por quadro
                for (var guard = 0; g.left && g.wait <= 0 && guard < 32; guard++) {
                    g.left--;
                    w.spawned++;
                    if (o.spawn) o.spawn(g.type, w, g.i++);
                    g.wait += g.every;
                }
            }
            if (!pend) { w.state = 'clear'; w.t = 0; }
            else {
                var any = false;
                for (var j = 0; j < w._groups.length; j++) if (w._groups[j].left) any = true;
                if (!any) { w.state = 'clear'; w.t = 0; }
            }
            return;
        }
        if (w.state === 'clear') {
            if (o.alive && o.alive() > 0) return;
            if (o.onClear) o.onClear(w, w.wave);
            if (!w.def(w.wave + 1)) { begin(w.wave + 1); return; }
            w.state = 'wait';
            w.t = 0;
            w._wait = w._rest;
        }
    };
    _live.push(w);
    return w;
};
E.waves.version = '1.0.0';

E._modTicks.push(function (dt) {
    var n0 = _live.length, i;
    for (i = 0; i < n0 && i < _live.length; i++) {
        var w = _live[i];
        if (!w.dead && w.gen !== null && w.gen !== E._sceneGen) {
            if (stacked(w.gen)) continue;
            w.dead = true;
        }
        w._tick(dt);
    }
    var k = 0;
    for (i = 0; i < _live.length; i++) {
        if (!_live[i].dead && _live[i].state !== 'done') _live[k++] = _live[i];
    }
    _live.length = k;
});
E._mods.push('waves');

module.exports = E;
