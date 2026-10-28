













var A = require('celeros.app');





A.path = {
version: '1.0.1',


base: function (p) {
p = String(p);
var i = p.lastIndexOf('/');
return i >= 0 ? p.substring(i + 1) : p;
},



dir: function (p) {
p = String(p);
var i = p.lastIndexOf('/');
if (i > 0) return p.substring(0, i);
return i === 0 ? '/' : p;
},



ext: function (p) {
var b = A.path.base(p);
var i = b.lastIndexOf('.');
return i > 0 ? b.substring(i + 1).toUpperCase() : '';
},


stem: function (p) {
var b = A.path.base(p);
var i = b.lastIndexOf('.');
return i > 0 ? b.substring(0, i) : b;
},



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


safeName: function (s) {
return String(s).replace(/[^A-Za-z0-9 ._()\-]/g, '_');
}
};

A._mods.push('path');

module.exports = A;
