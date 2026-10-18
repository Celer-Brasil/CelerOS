// game.fsm.js — CelerGame FSM (dep "celeros.game.fsm"): maquina de
// estados para IA de inimigo, chefe com fases, heroi (parado/andando/
// pulando/atingido) e fluxo de jogo. Decora o core no require:
//
//   var E = require("celeros.game");
//   require("celeros.game.fsm");
//   var ia = E.fsm(inimigo, {
//       patrulha: { enter: function (m) { ... },
//                   update: function (m, dt) { if (veHeroi()) m.go("caca"); } },
//       caca:     { update: function (m, dt) { ...; if (m.time > 3) m.go("patrulha"); } },
//       atordoado:{ enter: function (m, arg) { m.data.ate = arg; },
//                   after: [0.8, "caca"] }          // sai sozinho depois de 0.8 s
//   }, "patrulha");
//   // no update da entidade: ia.update(dt)
//
// Callbacks recebem (m, ...) — m.owner e o dono (entidade), m.data e a
// bolsa do estado corrente (zerada a cada entrada), m.time os segundos no
// estado. A troca pedida DENTRO de um callback vale no fim dele (nada de
// enter de um estado rodando no meio do update de outro).

var E = require('celeros.game');

E.fsm = function (owner, states, first, opts) {
    opts = opts || {};
    var m = {
        owner: owner,
        states: states,
        state: null,        // nome do estado corrente
        prev: null,         // nome do anterior
        time: 0,            // segundos no estado corrente
        data: {},           // bolsa do estado (nova a cada entrada)
        history: [],        // ultimos nomes (opts.history, default 8)
        onChange: opts.onChange || null,   // (m, de, para)
        _pend: null, _pendArg: undefined, _busy: false, _stack: []
    };
    var histMax = opts.history === undefined ? 8 : opts.history;

    function st(name) {
        var s = states[name];
        if (!s) {
            var nomes = [];
            for (var k in states) nomes.push(k);
            throw new Error('fsm: estado inexistente: ' + name + ' (estados: ' + nomes.join(', ') + ')');
        }
        return s;
    }
    function apply(name, arg) {
        var to = st(name);
        var from = m.state ? states[m.state] : null;
        m._busy = true;
        if (from && from.exit) from.exit(m, name);
        m.prev = m.state;
        m.state = name;
        m.time = 0;
        m.data = {};
        if (histMax > 0) {
            m.history.push(name);
            if (m.history.length > histMax) m.history.shift();
        }
        if (m.onChange) m.onChange(m, m.prev, name);
        if (to.enter) to.enter(m, arg);
        m._busy = false;
    }
    // troca pedida dentro de um callback: aplica quando ele termina (laco
    // com teto: enter que pede outra troca encadeia, ciclo infinito para)
    function flush() {
        var guard = 0;
        while (m._pend !== null && guard++ < 16) {
            var n = m._pend, a = m._pendArg;
            m._pend = null;
            m._pendArg = undefined;
            apply(n, a);
        }
    }

    // vai para o estado (arg chega no enter). Mesmo estado: so com force
    m.go = function (name, arg, force) {
        if (name === m.state && !force) return false;
        st(name);
        if (m._busy) { m._pend = name; m._pendArg = arg; return true; }
        apply(name, arg);
        flush();
        return true;
    };
    m.is = function (name) { return m.state === name; };
    // empilha: o estado atual fica guardado e pop() volta a ele (atordoado
    // por cima de qualquer coisa, menu dentro do jogo)
    m.push = function (name, arg) {
        if (m.state) m._stack.push(m.state);
        return m.go(name, arg, true);
    };
    m.pop = function (arg) {
        if (!m._stack.length) return false;
        return m.go(m._stack.pop(), arg, true);
    };
    m.update = function (dt) {
        if (!m.state) return;
        var s = states[m.state];
        m.time += dt;
        m._busy = true;
        if (s.update) s.update(m, dt);
        // saida automatica: after = [segundos, proximo] (ou fn(m) -> nome)
        if (m._pend === null && s.after && m.time >= s.after[0]) {
            var nx = typeof s.after[1] === 'function' ? s.after[1](m) : s.after[1];
            if (nx) { m._pend = nx; m._pendArg = undefined; }
        }
        m._busy = false;
        flush();
    };
    // repassa um evento ao estado: estados[x].on[nome](m, arg) — devolve
    // true se o estado tratou (ex. "dano" so importa fora do "escudo")
    m.send = function (ev, arg) {
        if (!m.state) return false;
        var s = states[m.state];
        var h = s.on && s.on[ev];
        if (!h) return false;
        m._busy = true;
        var r = h(m, arg);
        m._busy = false;
        // string devolvida pelo handler = transicao
        if (typeof r === 'string') m.go(r);
        else flush();
        return true;
    };
    m.draw = function () {
        var s = m.state ? states[m.state] : null;
        if (s && s.draw) s.draw(m);
    };

    if (first) m.go(first, opts.arg);
    return m;
};
E.fsm.version = '1.0.0';

E._mods.push('fsm');

module.exports = E;
