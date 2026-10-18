


























var A = require('celeros.app');
var mesh = require('celeros.mesh');

A.mesh = {
version: '1.0.1',
_fam: 'a',
_seq: 0,
_pend: {},
_seen: [],
_cache: {},


family: function (ch) { A.mesh._fam = String(ch).charAt(0) || 'a'; },


available: function () { return mesh.available(); },
active: function () { return mesh.active(); },
gate: function (msg, o) { return mesh.gate(msg, o); },
me: function () { return mesh.me(); },
nodes: function () {
try { return CelerNet.nodes(); } catch (e) { return []; }
},



send: function (to, op, payload, o) {
var s = A.mesh._fam + op + (payload || '');
try {
if (o && o.ttl !== undefined) return !!CelerNet.broadcast(s, o.ttl);
return !!CelerNet.send(to, s, o || { copies: 1 });
} catch (e) { return false; }
},






req: function (to, op, payload, cb, timeoutMs) {
var ms = timeoutMs || 4000;

var seq = (A.mesh._seq = (A.mesh._seq + 1) % 1296);
var b36 = '0123456789abcdefghijklmnopqrstuvwxyz';
var nonce = b36.charAt(Math.floor(seq / 36)) + b36.charAt(seq % 36);
A.mesh._pend[nonce] = { fn: cb };
setTimeout(function () {
var p = A.mesh._pend[nonce];
if (p && p.fn) {
p.fn = null;
delete A.mesh._pend[nonce];
cb(null, null);
}
}, ms);
return A.mesh.send(to, op, (payload || '') + nonce, { copies: 1 });
},


_fresh: function (n) {
var s = A.mesh._seen;
if (s.indexOf(n) >= 0) return false;
s.push(n);
if (s.length > 32) s.shift();
return true;
},










each: function (handler) {
var n = 0, m;
while ((m = CelerNet.poll()) !== null) {
n++;
var msg = String(m.msg === undefined || m.msg === null ? '' : m.msg);
if (msg.charAt(0) !== A.mesh._fam) {
handler(m.from, '', msg, m);
continue;
}
var op = msg.charAt(1);
var rest = msg.substring(2);
if (op === '=') {
var nonce = rest.substring(0, 2);
var p = A.mesh._pend[nonce];
if (p && p.fn && A.mesh._fresh(nonce)) {
var fn = p.fn;
p.fn = null;
delete A.mesh._pend[nonce];
fn(rest.length > 3 ? rest.substring(3) : '', m.from);
} else if (!p && A.mesh._fresh(nonce)) {
handler(m.from, '=', rest, m);
}
continue;
}
handler(m.from, op, rest, m);
}
return n;
},



cache: function (k, ms, fill) {
var c = A.mesh._cache[k];
var now = System.millis();
if (c && (now - c.at) < ms) return c.v;
var v = fill();
A.mesh._cache[k] = { at: now, v: v };
return v;
}
};

A._mods.push('mesh');

module.exports = A;
