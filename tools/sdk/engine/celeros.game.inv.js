// game.inv.js — CelerGame INV (dep "celeros.game.inv"): inventario de
// itens com pilhas, slots, uso e save — a mochila do RPG, o cinto de
// pocoes, o bau. Decora o core no require:
//
//   var E = require("celeros.game");
//   require("celeros.game.inv");
//   E.inv.items({
//       pocao:  { name: "Poção", max: 9, use: function (it, bag) { heroi.hp += 3; return true; } },
//       espada: { name: "Espada", max: 1 },
//       moeda:  { name: "Moeda", max: 999 }
//   });
//   var mochila = E.inv.bag({ slots: 12 });
//   var sobra = mochila.add("pocao", 12);   // 9 num slot + 3 no proximo -> 0
//   mochila.count("pocao");                  // 12
//   mochila.use(0);                          // chama def.use e gasta 1
//   mochila.save("mochila");                 // E.save (JSON); restore() volta
//
// Slot = {id, n} ou null. Item sem def no registro empilha ate 99. Todas as
// mudancas chamam onChange(bag) uma vez por operacao (o HUD redesenha).
//
// 1.0.1: load nao clampeava a pilha ao max do item (save corrompido/velho
// restaurava 500 pocoes com max 9 e o add() completava por cima) e aceitava
// slot de id nulo; add falho (mochila cheia, qty omitido) chamava onChange
// sem nada ter entrado.

var E = require('celeros.game');

var _defs = {};

function maxOf(id) {
    var d = _defs[id];
    return d && d.max > 0 ? d.max : 99;
}

E.inv = {
    version: '1.0.1',
    defs: _defs,

    // registra/atualiza defs: {id: {name, max, use(item, bag) -> true gasta 1, ...}}
    items: function (table) {
        for (var k in table) _defs[k] = table[k];
        return _defs;
    },
    def: function (id) { return _defs[id] || null; },

    bag: function (o) {
        o = o || {};
        var n = o.slots > 0 ? o.slots : 10;
        var slots = [];
        for (var i = 0; i < n; i++) slots.push(null);
        var b = { slots: slots, size: n, onChange: o.onChange || null };
        function changed() { if (b.onChange) b.onChange(b); }

        // coloca n de id: completa pilhas existentes, depois slots vazios.
        // Devolve a SOBRA que nao coube (0 = tudo entrou)
        b.add = function (id, qty) {
            var left = qty === undefined ? 1 : qty;
            if (!(left > 0)) return 0;
            var want = left;
            var mx = maxOf(id), k, s;
            for (k = 0; k < n && left > 0; k++) {
                s = slots[k];
                if (s && s.id === id && s.n < mx) {
                    var put = Math.min(mx - s.n, left);
                    s.n += put;
                    left -= put;
                }
            }
            for (k = 0; k < n && left > 0; k++) {
                if (!slots[k]) {
                    var p = Math.min(mx, left);
                    slots[k] = { id: id, n: p };
                    left -= p;
                }
            }
            // so avisa quando algo ENTROU (mochila cheia com qty omitido nao
            // pode redesenhar o HUD a toa: left===want e nada mudou)
            if (left !== want) changed();
            return left;
        };
        // cabe inteiro? (loja: so cobra se couber)
        b.fits = function (id, qty) {
            var left = qty === undefined ? 1 : qty, mx = maxOf(id);
            for (var k = 0; k < n && left > 0; k++) {
                var s = slots[k];
                if (!s) left -= mx;
                else if (s.id === id) left -= mx - s.n;
            }
            return left <= 0;
        };
        // tira ate qty de id (das ultimas pilhas primeiro); devolve quantos saiu
        b.remove = function (id, qty) {
            var want = qty === undefined ? 1 : qty, got = 0;
            for (var k = n - 1; k >= 0 && got < want; k--) {
                var s = slots[k];
                if (!s || s.id !== id) continue;
                var t = Math.min(s.n, want - got);
                s.n -= t;
                got += t;
                if (s.n <= 0) slots[k] = null;
            }
            if (got) changed();
            return got;
        };
        b.count = function (id) {
            var t = 0;
            for (var k = 0; k < n; k++) if (slots[k] && slots[k].id === id) t += slots[k].n;
            return t;
        };
        b.has = function (id, qty) { return b.count(id) >= (qty === undefined ? 1 : qty); };
        b.slot = function (i) { return i >= 0 && i < n ? slots[i] : null; };
        // escreve o slot direto (n <= 0 ou id null esvazia)
        b.set = function (i, id, qty) {
            if (i < 0 || i >= n) return false;
            slots[i] = id && qty > 0 ? { id: id, n: Math.min(qty, maxOf(id)) } : null;
            changed();
            return true;
        };
        // arrasta do slot i para j: mesmo item junta (ate o max), outro troca
        b.move = function (i, j) {
            if (i === j || i < 0 || j < 0 || i >= n || j >= n || !slots[i]) return false;
            var a = slots[i], c = slots[j];
            if (c && c.id === a.id) {
                var mx = maxOf(a.id), put = Math.min(mx - c.n, a.n);
                c.n += put;
                a.n -= put;
                if (a.n <= 0) slots[i] = null;
            } else {
                slots[i] = c;
                slots[j] = a;
            }
            changed();
            return true;
        };
        // divide a pilha do slot i: qty vai para o 1o slot vazio
        b.split = function (i, qty) {
            var s = b.slot(i);
            if (!s || !(qty > 0) || qty >= s.n) return -1;
            for (var k = 0; k < n; k++) {
                if (!slots[k]) {
                    slots[k] = { id: s.id, n: qty };
                    s.n -= qty;
                    changed();
                    return k;
                }
            }
            return -1;
        };
        // usa o item do slot i: def.use(item, bag) devolvendo true gasta 1
        b.use = function (i) {
            var s = b.slot(i);
            if (!s) return false;
            var d = _defs[s.id];
            if (!d || !d.use) return false;
            if (d.use(s, b) !== true) return false;
            s.n--;
            if (s.n <= 0 && slots[i] === s) slots[i] = null;
            changed();
            return true;
        };
        b.free = function () {
            var f = 0;
            for (var k = 0; k < n; k++) if (!slots[k]) f++;
            return f;
        };
        b.isEmpty = function () { return b.free() === n; };
        b.each = function (fn) {
            for (var k = 0; k < n; k++) if (slots[k]) fn(slots[k], k);
        };
        b.clear = function () {
            for (var k = 0; k < n; k++) slots[k] = null;
            changed();
        };
        // compacta e ordena: pilhas iguais juntam; ordem do registro de defs
        // (depois por id) — o botao "organizar"
        b.sort = function () {
            var tot = {}, ids = [], k;
            for (k = 0; k < n; k++) {
                var s = slots[k];
                if (!s) continue;
                if (tot[s.id] === undefined) { tot[s.id] = 0; ids.push(s.id); }
                tot[s.id] += s.n;
                slots[k] = null;
            }
            var order = [];
            for (var d in _defs) order.push(d);
            ids.sort(function (x, y) {
                var ix = order.indexOf(x), iy = order.indexOf(y);
                if (ix < 0) ix = 1e9;
                if (iy < 0) iy = 1e9;
                return ix - iy || (x < y ? -1 : (x > y ? 1 : 0));
            });
            var on = b.onChange;
            b.onChange = null;          // um aviso so no fim
            for (k = 0; k < ids.length; k++) b.add(ids[k], tot[ids[k]]);
            b.onChange = on;
            changed();
        };
        // [[id, n] | null, ...] — formato do save
        b.toJSON = function () {
            var out = [];
            for (var k = 0; k < n; k++) out.push(slots[k] ? [slots[k].id, slots[k].n] : null);
            return out;
        };
        b.load = function (arr) {
            for (var k = 0; k < n; k++) {
                var e = arr && arr[k];
                // id nulo/vazio e pilha acima do max do item nao voltam (save
                // corrompido ou de versao com regra diferente nao cria uma
                // pilha de 500 pocoes com max 9 — o add() ia completar por cima)
                slots[k] = e && e[0] && e[1] > 0 ?
                           { id: e[0], n: Math.min(e[1], maxOf(e[0])) } : null;
            }
            changed();
            return b;
        };
        b.save = function (key) { E.save.setObj(key, b.toJSON()); };
        // volta do save; false se nao havia nada guardado (mochila intacta)
        b.restore = function (key) {
            var v = E.save.obj(key, null);
            if (!v || v.length === undefined) return false;
            b.load(v);
            return true;
        };
        return b;
    }
};

E._mods.push('inv');

module.exports = E;
