















var A = require('celeros.app');


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
