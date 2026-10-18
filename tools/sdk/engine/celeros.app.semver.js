// app.semver.js — CelerKit SEMVER (dep "celeros.app.semver"): comparacao de
// versao e resolucao de ranges de deps — a MESMA semantica do hub
// (celerhub.py), da loja e do celerctl, que hoje existia copiada em 3 apps:
//
//   var A = require("celeros.app");
//   require("celeros.app.semver");
//   A.semver.cmp("1.10.0", "1.9.0");          // 1
//   A.semver.rangeOk("1.4.2", "^1.2.0");      // true  (mesma major, >= base)
//   A.semver.rangeOk("2.0.0", "^1.2.0");      // false (major diferente)
//   A.semver.pick(vers, ["^1.0.0"]);          // maior versao que satisfaz
//   var fecho = A.semver.resolve(diretas, indice);  // {"nome":"1.2.3"}|null
//
// resolve() e o fecho transitivo sobre o indice do hub (GET /store/deps.json:
// { nome: { "1.2.3": { deps: {...} } } }); devolve null se algo nao
// satisfaz. E o mesmo algoritmo do install da loja — nao invente variacao.

var A = require('celeros.app');

// numerico parte a parte (herdado do AppStoreUI.cpp via loja): "1.10" > "1.9"
function cmpV(v1, v2) {
    v1 = v1 || '';
    v2 = v2 || '';
    var p1 = 0, p2 = 0;
    while (p1 < v1.length || p2 < v2.length) {
        var n1 = 0, n2 = 0;
        while (p1 < v1.length && v1.charAt(p1) !== '.') {
            n1 = n1 * 10 + (v1.charCodeAt(p1) - 48);
            p1++;
        }
        while (p2 < v2.length && v2.charAt(p2) !== '.') {
            n2 = n2 * 10 + (v2.charCodeAt(p2) - 48);
            p2++;
        }
        if (n1 > n2) return 1;
        if (n1 < n2) return -1;
        p1++;
        p2++;
    }
    return 0;
}

A.semver = {
    version: '1.0.0',

    cmp: cmpV,
    gt: function (a, b) { return cmpV(a, b) > 0; },
    eq: function (a, b) { return cmpV(a, b) === 0; },

    // range "^1.2.3" = mesma major e >= base; sem "^" = versao exata
    rangeOk: function (ver, rng) {
        ver = String(ver || '');
        rng = String(rng || '');
        if (!ver || !rng) return false;
        var caret = rng.charAt(0) === '^';
        if (caret) rng = rng.substring(1);
        var seg = rng.split('.');
        var R = [parseInt(seg[0], 10) || 0, parseInt(seg[1], 10) || 0, parseInt(seg[2], 10) || 0];
        var vseg = ver.split('.');
        var V = [parseInt(vseg[0], 10) || 0, parseInt(vseg[1], 10) || 0, parseInt(vseg[2], 10) || 0];
        if (caret) return V[0] === R[0] && (V[1] > R[1] || (V[1] === R[1] && V[2] >= R[2]));
        return V[0] === R[0] && V[1] === R[1] && V[2] === R[2];
    },

    // maior versao do nome que satisfaca TODOS os ranges; null se nenhuma
    pick: function (vers, ranges) {
        var best = null;
        for (var v in vers) if (vers.hasOwnProperty(v)) {
            var ok = true;
            for (var i = 0; i < ranges.length; i++) {
                if (!A.semver.rangeOk(v, ranges[i])) { ok = false; break; }
            }
            if (ok && (best === null || cmpV(v, best) > 0)) best = v;
        }
        return best;
    },

    // fecho transitivo: want = {"nome": "range"}, index = /store/deps.json.
    // Devolve {"nome": "versao"} (maior que satisfaz todos os caminhos) ou
    // null se alguma dep nao resolve. Mesmo BFS da loja/celerhub.
    resolve: function (want, index) {
        var wanted = {}, seen = {}, queue = [], k;
        for (k in want) if (want.hasOwnProperty(k)) queue.push([k, want[k]]);
        while (queue.length) {
            var pair = queue.shift();
            var nm = pair[0], rng = String(pair[1]);
            var key = nm + '|' + rng;
            if (seen[key]) continue;
            seen[key] = 1;
            if (!wanted[nm]) wanted[nm] = [];
            wanted[nm].push(rng);
            var escolhida = A.semver.pick(index[nm] || null, wanted[nm]);
            if (!escolhida) return null;
            var sub = index[nm][escolhida].deps || {};
            for (k in sub) if (sub.hasOwnProperty(k)) queue.push([k, sub[k]]);
        }
        var out = {};
        for (k in wanted) if (wanted.hasOwnProperty(k)) {
            var p = A.semver.pick(index[k] || null, wanted[k]);
            if (!p) return null;
            out[k] = p;
        }
        return out;
    }
};

A._mods.push('semver');

module.exports = A;
