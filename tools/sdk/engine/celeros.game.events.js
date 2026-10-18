// game.events.js — CelerGame EVENTS (dep "celeros.game.events"): barramento
// de eventos para desacoplar sistemas (a moeda pegou -> placar, som,
// conquista e tutorial ouvem sem um conhecer o outro). Decora o core:
//
//   var E = require("celeros.game");
//   require("celeros.game.events");
//   var sub = E.on("moeda", function (valor) { placar += valor; });
//   E.emit("moeda", 10);
//   E.off(sub);                 // ou sub.off()
//   var bus = E.bus();          // barramento privado (de uma entidade)
//
// Ouvintes por cena: E.on(nome, fn, { scene: true }) cai sozinho quando a
// cena troca — o menu nao continua ouvindo o "morreu" do jogo.
// E.emitLater(nome, arg) entrega no PROXIMO quadro (evento disparado no
// meio de um laco de colisao nao reentra no laco).

var E = require('celeros.game');

// geracao g ainda viva embaixo de um E.push?
function stacked(g) {
    var st = E._stack;
    if (st) for (var i = 0; i < st.length; i++) if (st[i].gen === g) return true;
    return false;
}

E.bus = function () {
    var subs = {};          // nome -> [sub]
    var b = {};
    function list(name) { return subs[name] || (subs[name] = []); }
    b.on = function (name, fn, o) {
        var s = { name: name, fn: fn, once: !!(o && o.once), dead: false,
                  // geracao da cena (core 1.2): sair e voltar a MESMA cena
                  // ja e outra vida — o ouvinte velho nao ressuscita
                  scene: o && o.scene ? E._sceneGen : null,
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
        var oo = { once: true, scene: o && o.scene, prio: o && o.prio };
        return b.on(name, fn, oo);
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
    // entrega sincrona; um ouvinte que devolve false PARA a propagacao
    // (o escudo come o "dano" antes do HUD). Devolve quantos ouviram
    b.emit = function (name, a1, a2, a3) {
        var L = subs[name];
        if (!L) return 0;
        var n = 0;
        // so os inscritos ATE agora (ouvinte que inscreve outro nao o chama)
        for (var i = 0, n0 = L.length; i < n0 && i < L.length; i++) {
            var s = L[i];
            if (s.dead) continue;
            if (s.scene !== null && s.scene !== E._sceneGen) {
                // cena dele coberta por um E.push: dorme; saiu de vez: morre
                if (!stacked(s.scene)) s.dead = true;
                continue;
            }
            if (s.once) s.dead = true;
            n++;
            if (s.fn(a1, a2, a3) === false) break;
        }
        // varre os mortos fora do laco (ouvinte que se desliga no meio)
        for (var k = L.length - 1; k >= 0; k--) if (L[k].dead) L.splice(k, 1);
        if (!L.length) delete subs[name];
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

// barramento global do jogo, pendurado no E
var G = E.bus();
E.events = G;
E.on = G.on;
E.once = G.once;
E.off = G.off;
E.emit = G.emit;

var _later = [];
E.emitLater = function (name, a1, a2, a3) { _later.push([name, a1, a2, a3]); };
E._modTicks.push(function () {
    if (!_later.length) return;
    var q = _later;
    _later = [];
    for (var i = 0; i < q.length; i++) G.emit(q[i][0], q[i][1], q[i][2], q[i][3]);
});

E.events.version = '1.0.0';
E._mods.push('events');

module.exports = E;
