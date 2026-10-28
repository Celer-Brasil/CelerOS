// game.script.js — CelerGame SCRIPT (dep "celeros.game.script"): roteiro
// de passos em sequencia para cutscene, tutorial, chefe com coreografia e
// abertura de fase — sem pendurar callback dentro de callback. Decora o
// core no require:
//
//   var E = require("celeros.game");
//   require("celeros.game.script");
//   E.script([
//       { call: function () { heroi.trava = true; } },
//       { tween: heroi, to: { x: 120 }, ms: 600 },    // espera o tween
//       { wait: 400 },                                 // ms
//       { until: function () { return porta.aberta; } },
//       { tap: true },                                 // espera um toque
//       { par: [ { tween: cam, to: { y: 40 }, ms: 500 }, { wait: 800 } ] },
//       function (s, dt) { return chefe.y < 80 ? false : undefined; },
//       { call: function () { heroi.trava = false; } }
//   ], { onDone: function () { E.goto("jogo"); } });
//
// Passo funcao: chamado a cada quadro ate devolver algo diferente de false
// (devolver nada = passo instantaneo). {label: "x"} + {loop: "x", times: n}
// repetem um trecho (sem times = para sempre). {emit: nome, arg} dispara no
// E.emit (modulo events). {scene: nome, opts} faz E.goto.
//
// O roteiro anda no tick da engine (dt do jogo: congela no E.pause, segue o
// E.timeScale) e e da CENA onde nasceu: dorme sob um E.push e morre quando
// ela sai ({global: true} sobrevive). s.skip() termina na hora: tweens vao
// ao valor final, esperas zeram e os {call} restantes rodam.
//
// 1.0.1: passo que lanca (funcao com erro, label inexistente) nao deixa mais
// roteiro zumbi no _live — o mesmo erro subia de novo em TODO quadro e o app
// nem conseguia cancelar (a propria E.script() subia). O erro sobe 1 vez com
// o roteiro ja cancelado.

var E = require('celeros.game');

var _live = [];

function stacked(g) {
    var st = E._stack;
    if (st) for (var i = 0; i < st.length; i++) if (st[i].gen === g) return true;
    return false;
}

// executor de uma lista de passos (o roteiro e o {par} usam o mesmo)
function runner(steps, owner) {
    var r = { i: 0, started: false, t: 0, tw: null, kids: null, counts: {} };
    function start(st) {
        r.t = 0;
        if (typeof st === 'function') return;
        if (st.call) st.call(owner);
        else if (st.tween) {
            var flag = { done: false };
            r.tw = E.tween(st.tween, st.to, st.ms, { ease: st.ease, delay: st.delay,
                                                     onDone: function () { flag.done = true; } });
            r.tw._flag = flag;
        } else if (st.par) {
            r.kids = [];
            for (var k = 0; k < st.par.length; k++) {
                var p = st.par[k];
                r.kids.push(runner(p && p.length !== undefined && typeof p !== 'function' ? p : [p], owner));
            }
        } else if (st.emit && E.emit) E.emit(st.emit, st.arg);
        else if (st.scene) E.goto(st.scene, st.opts);
    }
    // true quando o passo terminou
    function poll(st, dt) {
        if (typeof st === 'function') {
            if (owner.skipping) return true;
            return st(owner, dt) !== false;
        }
        if (st.wait !== undefined) {
            r.t += dt * 1000;
            return owner.skipping || r.t >= st.wait;
        }
        if (st.tween) {
            if (owner.skipping && !r.tw._flag.done) {
                // valor final na hora (relativo "+=" ja resolvido no tween)
                var to = r.tw.to;
                for (var k in to) {
                    if (typeof to[k] === 'number') st.tween[k] = to[k];
                }
                r.tw.dead = true;
                return true;
            }
            return r.tw._flag.done;
        }
        if (st.until) return owner.skipping || !!st.until(owner);
        if (st.tap) return owner.skipping || !!E.input.tap;
        if (st.par) {
            var all = true;
            for (var q = 0; q < r.kids.length; q++) if (!r.kids[q].update(dt)) all = false;
            return all;
        }
        return true;   // call/emit/scene/label: instantaneos
    }
    function findLabel(name) {
        for (var i = 0; i < steps.length; i++) if (steps[i] && steps[i].label === name) return i;
        throw new Error('script: label inexistente: ' + name);
    }
    r.update = function (dt) {
        for (var guard = 0; guard < 256; guard++) {
            if (r.i >= steps.length) return true;
            var st = steps[r.i];
            if (!r.started) {
                r.started = true;
                if (st && st.loop !== undefined && typeof st !== 'function') {
                    // salto: conta as voltas por indice do passo de loop
                    var n = r.counts[r.i] = (r.counts[r.i] || 0) + 1;
                    if (!owner.skipping && (st.times === undefined || n <= st.times)) {
                        r.i = findLabel(st.loop);
                        r.started = false;
                        continue;
                    }
                    r.counts[r.i] = 0;
                    r.i++;
                    r.started = false;
                    continue;
                }
                start(st);
            }
            if (!poll(st, dt)) return false;
            r.i++;
            r.started = false;
            r.tw = null;
            r.kids = null;
            dt = 0;   // o resto do quadro ja foi gasto pelo passo que acabou
        }
        return false;   // 256 passos instantaneos num quadro: segue no proximo
    };
    r.cancel = function () {
        if (r.tw) r.tw.dead = true;
        if (r.kids) for (var k = 0; k < r.kids.length; k++) r.kids[k].cancel();
    };
    return r;
}

E.script = function (steps, opts) {
    opts = opts || {};
    var s = {
        steps: steps, done: false, dead: false, paused: false, skipping: false,
        gen: opts.global || !E._sceneGen ? null : E._sceneGen,
        data: {},           // bolsa livre dos passos
        onDone: opts.onDone || null
    };
    var run = runner(steps, s);
    s._run = run;
    // indice do passo corrente (diagnostico)
    s.step = function () { return run.i; };
    s.pause = function (on) { s.paused = on === undefined ? !s.paused : !!on; return s.paused; };
    s.cancel = function () {
        if (s.dead) return;
        s.dead = true;
        run.cancel();
    };
    s.skip = function () {
        if (s.dead || s.done) return;
        s.skipping = true;
        s._tick(0);
    };
    s._tick = function (dt) {
        if (s.dead || s.done || (s.paused && !s.skipping)) return;
        if (run.update(dt)) {
            s.done = true;
            s.dead = true;
            if (s.onDone) s.onDone(s);
        }
    };
    _live.push(s);
    // 1o passo roda ja (um {call} inicial nao espera o proximo quadro). Um
    // passo que lanca na criacao nao pode deixar o roteiro no _live: o erro
    // voltaria a subir EM TODOS os quadros, sem o app conseguir cancelar
    try {
        s._tick(0);
    } catch (e) {
        s.cancel();
        s.dead = true;
        var ix = _live.indexOf(s);
        if (ix >= 0) _live.splice(ix, 1);
        throw e;
    }
    return s;
};
E.script.version = '1.0.2';
// roteiros vivos (diagnostico); clear() mata todos (troca de fase)
E.script.live = function () { return _live.length; };
E.script.clear = function () {
    for (var i = 0; i < _live.length; i++) _live[i].cancel();
    _live.length = 0;
};

// ordem de criacao; o roteiro criado no meio do tick anda no proximo
E._modTicks.push(function (dt) {
    var n0 = _live.length, i;
    for (i = 0; i < n0 && i < _live.length; i++) {
        var s = _live[i];
        if (!s.dead && s.gen !== null && s.gen !== E._sceneGen) {
            if (stacked(s.gen)) continue;      // cena dele coberta: dorme
            s.cancel();                        // cena saiu: morre
        }
        // passo que lanca no meio do roteiro: cancela antes de subir (o
        // erro e visto 1 vez; sem isto o mesmo passo relancava a cada
        // quadro e o jogo inteiro congelava nesse erro)
        try {
            if (!s.dead) s._tick(dt);
        } catch (e) {
            s.cancel();
            throw e;
        }
    }
    var w = 0;
    for (i = 0; i < _live.length; i++) if (!_live[i].dead) _live[w++] = _live[i];
    _live.length = w;
});
E._mods.push('script');

module.exports = E;
