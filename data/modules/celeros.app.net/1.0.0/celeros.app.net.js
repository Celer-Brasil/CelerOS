

















var A = require('celeros.app');

A.net = {
version: '1.0.0',


online: function () {
try { return !!Net.isConnected(); } catch (e) { return false; }
},


getJSON: function (url) {
try { return Net.getJSON(url); } catch (e) { return null; }
},
getText: function (url) {
try { return Net.get(url); } catch (e) { return null; }
},
post: function (url, body, mime) {
try { return Net.post(url, body, mime); } catch (e) { return null; }
},






retry: function (fn, o) {
o = o || {};
var n = typeof o.n === 'number' ? o.n : 2;
var base = typeof o.backoff === 'number' ? o.backoff : 1500;
var isOk = o.ok || function (v) { return v !== null && v !== undefined && v !== false; };
var v = fn();
var tent = 0;
while (!isOk(v) && tent < n) {
tent++;
var e = tent - 1;
if (e > 3) e = 3;
System.delay(base * (1 << e));
v = fn();
}
return v;
},




fetch: function (url, file, md5, onProg) {
var ok = false;
try { ok = !!Net.download(url, file, onProg || null); } catch (e) { ok = false; }
if (!ok) return false;
if (md5) {
var got = '';
try { got = FS.getFileMD5(file) || ''; } catch (e2) { got = ''; }
if (got !== md5) {
try { FS.deleteFile(file); } catch (e3) { }
return false;
}
}
return true;
},



readText: function (file) {
try { return FS.readTextFile(file); } catch (e) { return null; }
}
};

A._mods.push('net');

module.exports = A;
