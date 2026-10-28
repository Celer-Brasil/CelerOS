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
//
// 1.1.0: handler de send que chamava m.go("x") E devolvia "y" terminava
// em "x" (o go direto aplicava "y" e o flush aplicava o "x" pendente por
// cima) — a string devolvida agora vence. push/pop guardam a bolsa e o
// tempo do estado de baixo: pop VOLTA a ele (hook resume(m, arg); sem
// resume cai no enter como antes) em vez de recomecar do zero. Estado
// coringa "*": on/update dele valem em TODO estado ("morreu" de qualquer
// lugar, cronometro global) — o do estado corrente tem prioridade no on.

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
        _pend: null, _pendArg: undefined, _pendSaved: null, _busy: false, _stack: []
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
    var ANY = states['*'] || null;
    // descarta a troca pendente (pedido posterior "fica no mesmo estado")
    function limpaPend() { m._pend = null; m._pendArg = undefined; m._pendSaved = null; }
    function apply(name, arg, saved) {
        var to = st(name);
        var from = m.state ? states[m.state] : null;
        m._busy = true;
        try {
            if (from && from.exit) from.exit(m, name);
            m.prev = m.state;
            m.state = name;
            m.time = saved ? saved.time : 0;
            m.data = saved ? saved.data : {};
            if (histMax > 0) {
                m.history.push(name);
                if (m.history.length > histMax) m.history.shift();
            }
            if (m.onChange) m.onChange(m, m.prev, name);
            if (saved && to.resume) to.resume(m, arg);
            else if (to.enter) to.enter(m, arg);
        } finally {
            // exit/enter/onChange que lanca nao pode deixar _busy preso: as
            // trocas seguintes ficavam penduradas ate um update qualquer
            m._busy = false;
        }
    }
    // troca pedida dentro de um callback: aplica quando ele termina (laco
    // com teto: enter que pede outra troca encadeia, ciclo infinito para)
    function flush() {
        var guard = 0;
        while (m._pend !== null && guard++ < 16) {
            var n = m._pend, a = m._pendArg, sv = m._pendSaved;
            m._pend = null;
            m._pendArg = undefined;
            m._pendSaved = null;
            apply(n, a, sv);
        }
    }

    // vai para o estado (arg chega no enter). Mesmo estado: so com force.
    // "Ficar onde esta" tambem cancela uma troca pedida antes no mesmo
    // callback (a ultima pedida vence; antes o pendente era aplicado por cima)
    m.go = function (name, arg, force) {
        if (name === m.state && !force) { limpaPend(); return false; }
        if (name === '*') throw new Error('fsm: "*" e o estado coringa, nao um destino');
        st(name);
        if (m._busy) { m._pend = name; m._pendArg = arg; m._pendSaved = null; return true; }
        apply(name, arg);
        flush();
        return true;
    };
    m.is = function (name) { return m.state === name; };
    // empilha: o estado atual fica guardado e pop() volta a ele (atordoado
    // por cima de qualquer coisa, menu dentro do jogo)
    m.push = function (name, arg) {
        if (m.state) m._stack.push({ state: m.state, data: m.data, time: m.time });
        return m.go(name, arg, true);
    };
    m.pop = function (arg) {
        if (!m._stack.length) return false;
        var sv = m._stack.pop();
        if (m._busy) { m._pend = sv.state; m._pendArg = arg; m._pendSaved = sv; return true; }
        apply(sv.state, arg, sv);
        flush();
        return true;
    };
    m.update = function (dt) {
        if (!m.state) return;
        var s = states[m.state];
        m.time += dt;
        m._busy = true;
        try {
            if (ANY && ANY.update) ANY.update(m, dt);
            if (s.update && m._pend === null) s.update(m, dt);
            // saida automatica: after = [segundos, proximo] (ou fn(m) -> nome)
            if (m._pend === null && s.after && m.time >= s.after[0]) {
                var nx = typeof s.after[1] === 'function' ? s.after[1](m) : s.after[1];
                if (nx) { m._pend = nx; m._pendArg = undefined; }
            }
        } finally {
            // update que lanca nao deixa a fsm travada em _busy
            m._busy = false;
        }
        flush();
    };
    // repassa um evento ao estado: estados[x].on[nome](m, arg) — devolve
    // true se o estado tratou (ex. "dano" so importa fora do "escudo")
    m.send = function (ev, arg) {
        if (!m.state) return false;
        var s = states[m.state];
        var h = (s.on && s.on[ev]) || (ANY && ANY.on && ANY.on[ev]);
        if (!h) return false;
        var was = m._busy;
        m._busy = true;
        var r;
        try {
            r = h(m, arg);
        } finally {
            m._busy = was;
        }
        // string devolvida pelo handler = transicao (vence um go pendente).
        // Devolver o estado CORRENTE e "ficar": cancela o pendente tambem
        if (typeof r === 'string') {
            st(r);
            if (r === m.state) limpaPend();
            else { m._pend = r; m._pendArg = undefined; m._pendSaved = null; }
        }
        if (!was) flush();
        return true;
    };
    m.draw = function () {
        var s = m.state ? states[m.state] : null;
        if (s && s.draw) s.draw(m);
    };

    if (first) m.go(first, opts.arg);
    return m;
};
E.fsm.version = '1.1.1';

E._mods.push('fsm');

module.exports = E;
