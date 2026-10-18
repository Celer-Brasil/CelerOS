















var A = require('celeros.app');




var RE_VER = /^(\d+)\.(\d+)\.(\d+)$/;



function passadaFecho(sementes, index) {
var wanted = {}, seen = {}, queue = [], k, i;
for (k in sementes) if (sementes.hasOwnProperty(k)) {
for (i = 0; i < sementes[k].length; i++) queue.push([k, sementes[k][i]]);
}
while (queue.length) {
var pair = queue.shift(), nm = pair[0], rng = String(pair[1]);
var key = nm + '|' + rng;
if (seen[key]) continue;
seen[key] = 1;
if (!wanted[nm]) wanted[nm] = [];
wanted[nm].push(rng);
var esc = A.semver.pick(index[nm] || null, wanted[nm]);
if (!esc) return null;
var sub = index[nm][esc].deps || {};
for (k in sub) if (sub.hasOwnProperty(k)) queue.push([k, String(sub[k])]);
}
var picks = {};
for (k in wanted) if (wanted.hasOwnProperty(k)) {
var p = A.semver.pick(index[k] || null, wanted[k]);
if (!p) return null;
picks[k] = p;
}
return { wanted: wanted, picks: picks };
}


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
version: '1.0.1',

cmp: cmpV,
gt: function (a, b) { return cmpV(a, b) > 0; },
eq: function (a, b) { return cmpV(a, b) === 0; },





rangeOk: function (ver, rng) {
rng = String(rng === undefined || rng === null ? '' : rng);
ver = String(ver === undefined || ver === null ? '' : ver);
var caret = rng.charAt(0) === '^';
var R = RE_VER.exec(caret ? rng.substring(1) : rng);
var V = RE_VER.exec(ver);
if (!R || !V) return false;
if (!caret) return rng === ver;
return +V[1] === +R[1] && (+V[2] > +R[2] || (+V[2] === +R[2] && +V[3] >= +R[3]));
},


pick: function (vers, ranges) {
var best = null;
if (!vers) return null;
for (var v in vers) if (vers.hasOwnProperty(v)) {
var ok = true;
for (var i = 0; i < ranges.length; i++) {
if (!A.semver.rangeOk(v, ranges[i])) { ok = false; break; }
}
if (ok && (best === null || cmpV(v, best) > 0)) best = v;
}
return best;
},







resolve: function (want, index) {
var diretas = {}, sementes = {}, k, n;
for (k in want) if (want.hasOwnProperty(k)) {
diretas[k] = String(want[k]);
sementes[k] = [diretas[k]];
}
for (var passada = 0; passada < 32; passada++) {
var r = passadaFecho(sementes, index);
if (!r) return null;
var exigidos = {}, exato = true;
for (k in r.picks) if (r.picks.hasOwnProperty(k)) {
var sub = (index[k] && index[k][r.picks[k]] && index[k][r.picks[k]].deps) || {};
for (var d in sub) if (sub.hasOwnProperty(d)) {
if (!exigidos[d]) exigidos[d] = [];
if (exigidos[d].indexOf(String(sub[d])) < 0) exigidos[d].push(String(sub[d]));
}
}
var nomes = {};
for (n in r.wanted) if (r.wanted.hasOwnProperty(n)) nomes[n] = 1;
for (n in exigidos) if (exigidos.hasOwnProperty(n)) nomes[n] = 1;
for (n in nomes) if (nomes.hasOwnProperty(n)) {
var base = (exigidos[n] || []).slice();
if (diretas[n] && base.indexOf(diretas[n]) < 0) base.push(diretas[n]);
var tem = (r.wanted[n] || []).slice();
if (base.sort().join('|') !== tem.sort().join('|')) { exato = false; break; }
}
if (exato) return r.picks;
sementes = {};
for (n in exigidos) if (exigidos.hasOwnProperty(n)) sementes[n] = exigidos[n].slice();
for (k in diretas) if (diretas.hasOwnProperty(k)) {
if (!sementes[k]) sementes[k] = [];
if (sementes[k].indexOf(diretas[k]) < 0) sementes[k].push(diretas[k]);
}
}
return null;
}
};

A._mods.push('semver');

module.exports = A;
