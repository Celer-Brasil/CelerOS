// app.events.js — CelerKit EVENTS (dep "celeros.app.events"): barramento de
// eventos para desacoplar partes do app (a lista baixou -> tela, badge e
// cache ouvem sem um conhecer o outro). Irmao do celeros.game.events, sem
// cenas nem fila de frame — apps rodam no proprio laco:
//
//   var A = require("celeros.app");
//   require("celeros.app.events");
//   var sub = A.on("catalogo", function (itens) { desenhar(itens); });
//   A.emit("catalogo", linhas);
//   A.off(sub);                    // ou sub.off(), ou A.off("catalogo")
//   var bus = A.bus();             // barramento privado (ex.: por tela)
//
// Ouvinte coringa "*" recebe (nome, a1, a2) de todo evento. Um ouvinte que
// devolve false PARA a propagacao. A entrega e sincrona; um emit de dentro
// de um emit nao desloca a varredura do de fora (a mesma maquina do jogo).

var A = require('celeros.app');

A.bus = function () {
    var subs = {};          // nome -> [sub]
    var depth = 0;          // emits em voo (a varredura espera o de fora)
    var b = {};
    function list(name) { return subs[name] || (subs[name] = []); }
    b.on = function (name, fn, o) {
        var s = { name: name, fn: fn, once: !!(o && o.once), dead: false,
                  prio: (o && o.prio) || 0 };
        s.off = function () { s.dead = true; };
        var L = list(name);
        // prioridade maior ouve antes (estavel no empate)
        var i = L.length;
        while (i > 0 && L[i - 1].prio < s.prio) i--;
        L.splice(i, 0, s);
        return s;
    };
    b.once = function (name, fn, o) {
        return b.on(name, fn, { once: true, prio: o && o.prio });
    };
    b.off = function (s) {
        if (!s) return;
        if (typeof s === 'string') {      // off("nome") = todos do nome
            var L = subs[s];
            if (L) for (var i = 0; i < L.length; i++) L[i].dead = true;
            delete subs[s];
            return;
        }
        s.dead = true;
    };
    // entrega sincrona; devolve false PARA a propagacao; devolve quantos ouviram
    function deliver(L, coringa, name, a1, a2, a3) {
        var n = 0;
        // so os inscritos ATE agora (ouvinte que inscreve outro nao o chama)
        for (var i = 0, n0 = L.length; i < n0 && i < L.length; i++) {
            var s = L[i];
            if (s.dead) continue;
            if (s.once) s.dead = true;
            n++;
            var r = coringa ? s.fn(name, a1, a2) : s.fn(a1, a2, a3);
            if (r === false && !coringa) return -n;   // parou a propagacao
        }
        return n;
    }
    function sweep(name) {
        var L = subs[name];
        if (!L) return;
        for (var k = L.length - 1; k >= 0; k--) if (L[k].dead) L.splice(k, 1);
        if (!L.length) delete subs[name];
    }
    b.emit = function (name, a1, a2, a3) {
        var L = subs[name], W = name !== '*' ? subs['*'] : null;
        if (!L && !W) return 0;
        var n = 0;
        depth++;
        if (L) {
            n = deliver(L, false, name, a1, a2, a3);
            if (n < 0) n = -n;
        }
        // o coringa ouve depois dos ouvintes do nome (e observador, nao
        // participante: ouve mesmo quando um deles parou a propagacao)
        if (W) deliver(W, true, name, a1, a2, a3);
        depth--;
        // varre os mortos so no emit mais externo (splice deslocaria indice)
        if (!depth) { sweep(name); if (W) sweep('*'); }
        return n;
    };
    b.count = function (name) {
        var L = subs[name], n = 0;
        if (L) for (var i = 0; i < L.length; i++) if (!L[i].dead) n++;
        return n;
    };
    b.clear = function () { subs = {}; };
    return b;
};

// barramento global do app, pendurado no A (mesma ergonomia do jogo)
var G = A.bus();
A.events = G;
A.on = G.on;
A.once = G.once;
A.off = G.off;
A.emit = G.emit;
A.events.version = '1.0.0';

A._mods.push('events');

module.exports = A;
