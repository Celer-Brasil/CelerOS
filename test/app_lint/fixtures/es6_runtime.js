// Fixture: metodos ES6+ que o parser ES5 aceita e o Duktape lean do device
// NAO tem (probe travado pelo test/duk/run.py). Chamados, viram TypeError
// em runtime — o harness Node tem todos, entao so o lint pega.
var a = Array.from([1, 2]);
var o = Object.values({ a: 1 });
var e = Object.entries({ a: 1 });
var b = Array.of(1, 2);
var m = Math.sinh(1);
var s = "ab".padStart(4, "0");
var p = "ab".padEnd(4);
var r = "a-b".replaceAll("-", "+");
var f = [1, 2].find(function (x) { return x > 1; });
var i = [1, 2].includes(2);
var w = new WeakSet();
// o que o device TEM nao acusa (probe: present no build real)
var asg = Object.assign({}, { a: 1 });
var ini = Number.isInteger(1);
var st = "ab".startsWith("a");
var rp = "ab".repeat(2);
// polifill com guard no proprio arquivo isenta a chamada
if (!Array.from) { Array.from = function (x) { return []; }; }
var g = Array.from([3]);
