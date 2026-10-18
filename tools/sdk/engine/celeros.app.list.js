// app.list.js — CelerKit LIST (dep "celeros.app.list"): as licoes de
// performance da loja de apps em modulo — cache de linhas por carimbo (o
// rebuild por frame caia no exec-timeout: 2.7.1), sort com chave
// pre-computada (o sort nativo e preventyield) e cores de badge.
// Decora o core:
//
//   var A = require("celeros.app");
//   require("celeros.app.list");
//   var lista = A.list.make(
//       function () { return dataStampDosDados; },     // CARO? nao: carimbo
//       function () { return ordenarECriarLinhas(); }  // so roda quando muda
//   );
//   var rows = lista.rows();                        // barato no frame
//   var i = UI.list("cat", A.L.x, A.L.top, A.L.w, 220, rows);
//   ...
//   lista.drop();                                   // forca rebuild
//
// A.list.sort(itens, keyFn) ordena ASC com a chave calculada UMA vez
// (desc = true inverte). A.list.badge('ok'|'warn'|'err'|'dim') devolve a cor.

var A = require('celeros.app');

A.list = {
    version: '1.0.0',

    // cache por carimbo: getStamp() roda TODO frame (tem que ser barato);
    // build() so roda quando o carimbo muda
    make: function (getStamp, build) {
        var cache = null;
        return {
            rows: function () {
                var stamp = getStamp();
                if (cache && cache.stamp === stamp) return cache.rows;
                cache = { stamp: stamp, rows: build() || [] };
                return cache.rows;
            },
            drop: function () { cache = null; }
        };
    },

    // sort com chave pre-computada; NUNCA ordene com fn de comparacao que
    // calcule algo (o sort do Duktape nao renova a janela do exec-timeout)
    sort: function (items, keyFn, desc) {
        var n = items.length;
        var keys = new Array(n);
        for (var i = 0; i < n; i++) keys[i] = String(keyFn(items[i]));
        // insertion sort estavel (listas de apps sao dezenas, nao milhares)
        for (var a = 1; a < n; a++) {
            var it = items[a], k = keys[a];
            var b = a - 1;
            while (b >= 0 && keys[b] > k) {
                keys[b + 1] = keys[b];
                items[b + 1] = items[b];
                b--;
            }
            keys[b + 1] = k;
            items[b + 1] = it;
        }
        if (desc) {
            for (var c = 0, d = n - 1; c < d; c++, d--) {
                var tmp = items[c];
                items[c] = items[d];
                items[d] = tmp;
            }
        }
        return items;
    },

    // cor de badge por estado ('ok'|'warn'|'err'|'dim')
    badge: function (kind) {
        var T = A.T || System.theme();
        return kind === 'ok' ? T.ok :
               kind === 'warn' ? T.warn :
               kind === 'err' ? T.err : T.textDim;
    },

    // barras de sinal Wi-Fi (0..4) a partir do RSSI — a curva do Celer Remote
    bars: function (rssi) {
        if (typeof rssi !== 'number' || rssi >= 0) return -1;
        if (rssi > -55) return 4;
        if (rssi > -67) return 3;
        if (rssi > -78) return 2;
        if (rssi > -88) return 1;
        return 0;
    }
};

A._mods.push('list');

module.exports = A;
