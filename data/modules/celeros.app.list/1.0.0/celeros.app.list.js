



















var A = require('celeros.app');

A.list = {
version: '1.0.0',



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



sort: function (items, keyFn, desc) {
var n = items.length;
var keys = new Array(n);
for (var i = 0; i < n; i++) keys[i] = String(keyFn(items[i]));

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


badge: function (kind) {
var T = A.T || System.theme();
return kind === 'ok' ? T.ok :
kind === 'warn' ? T.warn :
kind === 'err' ? T.err : T.textDim;
},


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
