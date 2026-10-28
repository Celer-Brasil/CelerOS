
















var A = require('celeros.app');

A.fmt = {
version: '1.0.2',


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


pad2: function (n) { return (n < 10 ? '0' : '') + n; },




clock: function (withSecs) {
var t = System.getTime();
if (!withSecs || !/^\d\d:\d\d$/.test(t)) return t;
return t + ':' + A.fmt.pad2(System.getSeconds());
},



when: function (epochSecs) {
if (!epochSecs) return '';
var d = new Date(epochSecs * 1000);
return A.fmt.pad2(d.getDate()) + '/' + A.fmt.pad2(d.getMonth() + 1) + ' ' +
A.fmt.pad2(d.getHours()) + ':' + A.fmt.pad2(d.getMinutes());
},


dur: function (ms) {
if (!ms || ms < 0) ms = 0;
if (ms < 60000) {
var s = Math.round(ms / 100) / 10;
return (s % 1 ? s : s.toFixed(0)) + ' s';
}
var m = Math.floor(ms / 60000);

var rs = Math.round((ms % 60000) / 1000);
if (rs >= 60) { rs = 0; m++; }
return m + 'm ' + A.fmt.pad2(rs) + 's';
},



sw: function (ms) {
if (!ms || ms < 0) ms = 0;
var cs = Math.floor(ms / 10) % 100;
var s = Math.floor(ms / 1000) % 60;
var m = Math.floor(ms / 60000);
var fim = A.fmt.pad2(s) + '.' + A.fmt.pad2(cs);
if (m < 60) return A.fmt.pad2(m) + ':' + fim;
var h = Math.floor(m / 60);
return h + ':' + A.fmt.pad2(m % 60) + ':' + fim;
}
};

A._mods.push('fmt');

module.exports = A;
