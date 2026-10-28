// app.path.js — CelerKit PATH (dep "celeros.app.path"): pedacinhos de camino
// de arquivo que metade dos app reescreve (baseName sozinho existia em 5
// apps). Decora o core no require:
//
//   var A = require("celeros.app");
//   require("celeros.app.path");
//   A.path.base("/local/apps/Loja/main.js"); // "main.js"
//   A.path.dir("/local/apps/Loja/main.js");  // "/local/apps/Loja"
//   A.path.join("a", "", "b/c");             // "a/b/c"
//   A.path.ext("x.PNG");                     // "PNG" (maiusculo)
//   A.path.stem("pacote.zip");               // "pacote"
//
// Caminhos do CelerOS sao POSIX-like e sempre com "/"; nada de Windows aqui.

var A = require('celeros.app');

// 1.0.1: join preserva a RAIZ do primeiro pedaco absoluto (join("/local",
// "apps") devolvia "local/apps" e o FS.exists do Installer nunca achava o
// cache) e dir("/x") devolve "/" (devolvia "/x").

A.path = {
    version: '1.0.1',

    // ultimo componente: "main.js" de "/local/apps/Loja/main.js"
    base: function (p) {
        p = String(p);
        var i = p.lastIndexOf('/');
        return i >= 0 ? p.substring(i + 1) : p;
    },

    // tudo antes do ultimo "/" (sem cortar a barra final de pastas); na raiz
    // ("/main.js") devolve "/", nao o proprio caminho
    dir: function (p) {
        p = String(p);
        var i = p.lastIndexOf('/');
        if (i > 0) return p.substring(0, i);
        return i === 0 ? '/' : p;
    },

    // extensao em MAIUSCULO (o farejador de tipo dos apps compara assim):
    // "PNG" de "foto.png", "" se nao tem
    ext: function (p) {
        var b = A.path.base(p);
        var i = b.lastIndexOf('.');
        return i > 0 ? b.substring(i + 1).toUpperCase() : '';
    },

    // nome sem a extensao: "pacote" de "pacote.zip"
    stem: function (p) {
        var b = A.path.base(p);
        var i = b.lastIndexOf('.');
        return i > 0 ? b.substring(0, i) : b;
    },

    // junta e ignora pedacos vazios: join("a", "", "b") = "a/b". Um primeiro
    // pedaco ABSOLUTO mantem a raiz: join("/local", "apps") = "/local/apps"
    join: function () {
        var out = '', abs = false;
        for (var i = 0; i < arguments.length; i++) {
            var p = String(arguments[i] || '');
            if (!p) continue;
            var lead = p.charAt(0) === '/';
            while (p.charAt(0) === '/') p = p.substring(1);
            if (out && out.charAt(out.length - 1) !== '/') out += '/';
            if (!out && lead) abs = true;
            out += p;
        }
        return (abs ? '/' : '') + out;
    },

    // nome seguro p/ arquivo: tudo fora de [A-Za-z0-9 ._()-] vira "_"
    safeName: function (s) {
        return String(s).replace(/[^A-Za-z0-9 ._()\-]/g, '_');
    }
};

A._mods.push('path');

module.exports = A;
