// app.history.js — CelerKit HISTORY (dep "celeros.app.history"): anel
// persistente com dedup consecutivo — o historico de comandos do Terminal
// e o de conversa do Chat IA, que cada app reescreve. Decora o core:
//
//   var A = require("celeros.app");
//   require("celeros.app.history");
//   var h = A.history.new({ file: "cmd.json", max: 30 });
//   h.push("ls /local");       // grava (menos se repetir a anterior)
//   h.all();                   // ["ls /local", ...]
//   h.clear();
//
// Guarda strings (dedup so contra a anterior; repetidos nao-consecutivos
// ficam — e o que o usuario espera de um historico de comandos).

var A = require('celeros.app');
require('celeros.app.data');

A.history = {
    version: '1.0.0',

    // o = { file ("historico.json"), max (50) }
    new: function (o) {
        o = o || {};
        var file = A.data.file(o.file || 'historico.json');
        var max = o.max || 50;
        var arr = A.data.load(file, []);
        if (!arr || typeof arr.length !== 'number') arr = [];
        var h = {
            all: function () { return arr; },
            // true se gravou; false se vazio ou repetiu a anterior
            push: function (s) {
                s = String(s === null || s === undefined ? '' : s);
                if (!s) return false;
                if (arr.length && arr[arr.length - 1] === s) return false;
                arr.push(s);
                if (arr.length > max) arr.shift();
                A.data.save(file, arr);
                return true;
            },
            last: function () { return arr.length ? arr[arr.length - 1] : ''; },
            clear: function () { arr = []; A.data.save(file, arr); }
        };
        return h;
    }
};

A._mods.push('history');

module.exports = A;
