













var A = require('celeros.app');
require('celeros.app.data');

A.history = {
version: '1.0.0',


new: function (o) {
o = o || {};
var file = A.data.file(o.file || 'historico.json');
var max = o.max || 50;
var arr = A.data.load(file, []);
if (!arr || typeof arr.length !== 'number') arr = [];
var h = {
all: function () { return arr; },

push: function (s) {
s = String(s === null || s === undefined ? '' : s);
if (!s) return false;
if (arr.length && arr[arr.length - 1] === s) return false;
arr.push(s);
if (arr.length > max) arr.shift();
A.data.save(file, arr);
return true;
},
last: function () { return arr.length ? arr[arr.length - 1] : ''; },
clear: function () { arr = []; A.data.save(file, arr); }
};
return h;
}
};

A._mods.push('history');

module.exports = A;
