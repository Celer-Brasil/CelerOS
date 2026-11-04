// Fixture: receptor de metodo ES6 que NAO e literal — o tipo vem do AST
// (Array(n)/new Array(n), Object.keys(...), "a,b".split(...) devolvem array)
// e o Duktape lean do device nao tem esses metodos: TypeError em runtime.
// Tambem cobre o polyfill de PROTOTYPE (isenta) e os limites conhecidos
// (receptor em variavel / chave dinamica nao sao provados pelo AST).
var a = new Array(3).fill(0);
var b = Array(2).includes(1);
var c = Object.keys({ a: 1 }).find(function (k) { return k; });
var d = "a,b".split(",").includes("a");
// metodos provados AUSENTES no device alem dos classicos (probe do test/duk):
// aliases trimLeft/trimRight, ES2019+ (flatMap/findLastIndex/toSorted) e
// Object.hasOwn — o parser ES5 aceita e o device explode TypeError
var m1 = Object.hasOwn({}, "a");
var m2 = Math.asinh(1);
var m3 = " x ".trimLeft();
var m4 = [[1]].flatMap(function (x) { return x; });
var m5 = [1].findLastIndex(function (x) { return x; });
var m6 = "ab".matchAll(/a/g);
// polyfill do prototype no proprio arquivo isenta o receptor literal/derivado
Array.prototype.includes = Array.prototype.includes || function () { return false; };
var e = [1, 2].includes(2);
// o que o device TEM segue sem acusar
var f = [1, 2].indexOf(2);
var g = Object.keys({ a: 1 }).length;
var j = [1, 2].reduceRight(function (x, y) { return x + y; }, 0);
// LIMITES (nao acusam, e documentado): variavel e chave dinamica
var arr = [1, 2];
var h = arr.includes(2);
var k = "find";
var i = [1, 2][k](function (x) { return x > 1; });
