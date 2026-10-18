// app.fmt.js — CelerKit FMT (dep "celeros.app.fmt"): formatacao de bytes,
// tempo e datas nos mesmos formatos que os apps do sistema ja mostram
// (Loja/Ajustes/Terminal) — trocar um app para o kit nao pode mudar texto
// na tela. Decora o core no require (o cache do require faz celeros.app
// ser singleton — o mesmo A):
//
//   var A = require("celeros.app");
//   require("celeros.app.fmt");
//   A.fmt.bytes(1536);        // "1.5 KB"
//   A.fmt.uptime(9 * 3600000);// "9h 0m"
//   A.fmt.clock(true);        // "10:32:05"
//   A.fmt.when(epoca);        // "27/09 10:32" (epoch em segundos)
//   A.fmt.dur(2300);          // "2.3 s"
//
// bytes(0/negativo) devolve "" (o app decide o que mostrar quando nao ha
// tamanho — a Loja usa isso para esconder a coluna).

var A = require('celeros.app');

A.fmt = {
    version: '1.0.0',

    // bytes: "512 B", "1.5 KB" (1 casa, sem ".0"), "2.3 MB"; vazio se <= 0
    bytes: function (n) {
        if (!n || n <= 0) return '';
        if (n < 1024) return n + ' B';
        var v;
        if (n < 1048576) {
            v = Math.round(n / 102.4) / 10;
            return (v % 1 ? v : v.toFixed(0)) + ' KB';
        }
        v = Math.round(n / 104857.6) / 10;
        return (v % 1 ? v : v.toFixed(0)) + ' MB';
    },

    // tempo ligado: "1d 3h", "2h 5m", "4m"
    uptime: function (ms) {
        if (!ms || ms < 0) ms = 0;
        var s = Math.floor(ms / 1000);
        var d = Math.floor(s / 86400); s -= d * 86400;
        var h = Math.floor(s / 3600); s -= h * 3600;
        var m = Math.floor(s / 60);
        if (d > 0) return d + 'd ' + h + 'h';
        if (h > 0) return h + 'h ' + m + 'm';
        return m + 'm';
    },

    // "07" (padding so para inteiros 0..99)
    pad2: function (n) { return (n < 10 ? '0' : '') + n; },

    // hora do aparelho; com segundos: "10:32:05"
    clock: function (withSecs) {
        var t = System.getTime();
        return withSecs ? t + ':' + A.fmt.pad2(System.getSeconds()) : t;
    },

    // data do aparelho com hora: "27/09 10:32" (epoch em SEGUNDOS, como as
    // notificacoes) — "" se vazio
    when: function (epochSecs) {
        if (!epochSecs) return '';
        var d = new Date(epochSecs * 1000);
        return A.fmt.pad2(d.getDate()) + '/' + A.fmt.pad2(d.getMonth() + 1) + ' ' +
               A.fmt.pad2(d.getHours()) + ':' + A.fmt.pad2(d.getMinutes());
    },

    // duracao curta: "2.3 s" (1 casa), "1m 05s"
    dur: function (ms) {
        if (!ms || ms < 0) ms = 0;
        if (ms < 60000) {
            var s = Math.round(ms / 100) / 10;
            return (s % 1 ? s : s.toFixed(0)) + ' s';
        }
        var m = Math.floor(ms / 60000);
        var rs = Math.round((ms % 60000) / 1000);
        return m + 'm ' + A.fmt.pad2(rs) + 's';
    }
};

A._mods.push('fmt');

module.exports = A;
