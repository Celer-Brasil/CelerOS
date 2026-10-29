// Testes do jsmin (tools/sdk/lib/jsmin.js): minificador ES5 que roda no
// publish/deploy. O que importa nao e "ficou menor", e SIM "faz a mesma
// coisa": cada caso compara a saida do original com a do minificado
// executando os dois, e os apps reais rodam no harness (mesmo log, mesmo
// erro, mesmo ultimo frame). Plugado no test/sdk/run.js:
//   require('./jsmin.js')(check);

'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..', '..');
var jsmin = require(path.join(ROOT, 'tools', 'sdk', 'lib', 'jsmin.js'));
var jsstrip = require(path.join(ROOT, 'tools', 'sdk', 'lib', 'jsstrip.js'));
var runner = require(path.join(ROOT, 'tools', 'sdk', 'lib', 'runner.js'));

// executa um modulo CommonJS e devolve o que ele exportou
function runModule(code) {
    var mod = { exports: {} };
    var req = function () { return {}; };
    // eslint-disable-next-line no-new-func
    (new Function('module', 'exports', 'require', code))(mod, mod.exports, req);
    return mod.exports;
}

function linesOf(s) { return String(s).split('\n').length; }

module.exports = function (check) {
    // ---------------------------------------------------------- semantica --
    // cada snippet e um caso de armadilha do ES5: ASI, `+ +`, regex x divisao,
    // catch, funcao nomeada, label, with/eval (que desligam o mangle)
    var CASES = {
        asi: 'function f() {\n  return\n  1;\n}\nmodule.exports = f();\n',
        unario: 'var a = 1, b = 2;\nmodule.exports = a + +b;\n',
        posfixo: 'var a = 1;\nvar b = a++ + a;\nmodule.exports = [a, b].join(",");\n',
        regex: 'var r = /a\\/b+/g, d = 10 / 2 / 5;\nmodule.exports = [r.test("a/b"), d].join(",");\n',
        forin: 'var o = { a: 1, b: 2 }, n = 0;\nfor (var k in o) { if (o.hasOwnProperty(k)) n += o[k]; }\nmodule.exports = n;\n',
        catchparam: 'var t = 0;\ntry { null.x; } catch (erro) { t = typeof erro; }\nmodule.exports = t;\n',
        funcaonomeada: 'var f = function fato(n) { return n <= 1 ? 1 : n * fato(n - 1); };\nmodule.exports = f(5);\n',
        labels: 'var n = 0;\nfora: for (var i = 0; i < 3; i++) {\n  for (var j = 0; j < 3; j++) { n++; if (j === 1) break fora; }\n}\nmodule.exports = n;\n',
        sombreamento: 'var x = 1;\nfunction f(x) { var y = x * 2; return y + x; }\nmodule.exports = f(2) + x;\n',
        nomeslongos: 'function soma(velocidade, aceleracao) {\n  var resultado = velocidade + aceleracao;\n  return resultado;\n}\nmodule.exports = soma(1, 2);\n',
        propriedade: 'var velocidade = 3;\nvar o = { velocidade: 7 };\nmodule.exports = [velocidade, o.velocidade].join(",");\n',
        numeros: 'module.exports = [0.5, 1000, 0.0001, 1000000, 255].join(",");\n',
        retornobjeto: 'function mk(a) { return { a: a, b: a + 1 }; }\nmodule.exports = JSON.stringify(mk(2));\n',
        typeofguard: 'function t(v) { if (typeof v === "undefined") return "u"; return v; }\nmodule.exports = t();\n',
        withdesliga: 'var o = { alvo: 5 };\nvar alvo = 1;\nwith (o) { module.exports = alvo; }\n',
        evaldesliga: 'var valor = 1;\neval("valor = 2");\nmodule.exports = valor;\n',
        funcaointerna: 'function outer(n) {\n  function dobro(x) { return x * 2; }\n  var passo = dobro(n);\n  return passo + dobro(1);\n}\nmodule.exports = outer(3);\n',
        argumentos: 'function f() { var a = arguments.length; return a + arguments[0]; }\nmodule.exports = f(4, 5);\n',
        recursaocomvar: 'var fib = function (n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); };\nmodule.exports = fib(10);\n',
        kwprop: 'var o = { return: 3, typeof: 4 };\nmodule.exports = [o.return / 2, o.typeof / 2].join(",");\n'
    };
    var bad = [];
    for (var name of Object.keys(CASES)) {
        var src = CASES[name];
        var want, got;
        try { want = JSON.stringify(runModule(src)); } catch (e) { want = 't:' + e.message; }
        var out;
        try { out = jsmin.minify(src, { top: 'yes' }).code; } catch (e) { out = null; got = 't:' + e.message; }
        if (out !== null) {
            try { got = JSON.stringify(runModule(out)); } catch (e2) { got = 't:' + e2.message; }
        }
        if (want !== got) bad.push(name + ': ' + want + ' x ' + got);
    }
    check('jsmin: ' + Object.keys(CASES).length + ' casos de semantica ES5', bad.length === 0, bad.join(' | '));

    // ------------------------------------------------------------ regras ----
    var longa = 'function mover(velocidade, aceleracao) {\n  var resultado = velocidade * aceleracao;\n  return resultado;\n}\nmodule.exports = mover(2, 3);\n';
    var m1 = jsmin.minify(longa, {}).code;
    check('jsmin: renomeia params/var longos',
        !/velocidade|aceleracao|resultado/.test(m1) && /module\.exports=mover\(2,3\)/.test(m1), m1);
    check('jsmin: topo intacto sem top=yes', /function mover\(/.test(m1) && /module\.exports/.test(m1), m1);
    check('jsmin: linhas preservadas', linesOf(m1) === linesOf(longa), linesOf(m1) + ' x ' + linesOf(longa));
    check('jsmin: espaco so quando precisa',
        jsmin.minify('var a = 1;\na = a + 1;\n', {}).code === 'var a=1;\na=a+1;\n',
        JSON.stringify(jsmin.minify('var a = 1;\na = a + 1;\n', {}).code));
    check('jsmin: nao mexe em propriedade',
        jsmin.minify('var o = { velocidade: 1 };\no.velocidade = 2;\n', { top: 'yes' }).code.indexOf('velocidade') >= 0,
        jsmin.minify('var o = { velocidade: 1 };\no.velocidade = 2;\n', { top: 'yes' }).code);
    check('jsmin: top=yes mangla o topo',
        /var a=1/.test(jsmin.minify('var contador = 1;\nmodule.exports = contador;\n', { top: 'yes' }).code),
        jsmin.minify('var contador = 1;\nmodule.exports = contador;\n', { top: 'yes' }).code);
    check('jsmin: reserved protege global lido por irmao',
        /var contador/.test(jsmin.minify('var contador = 1;\nmodule.exports = contador;\n',
            { top: 'yes', reserved: ['contador'] }).code));
    check('jsmin: nome curto nao vira nome longo',
        jsmin.minify('function f(x) { return x + 1; }\nmodule.exports = f(1);\n', { top: 'yes' }).code.indexOf('function f(x)') >= 0,
        jsmin.minify('function f(x) { return x + 1; }\nmodule.exports = f(1);\n', { top: 'yes' }).code);

    var free = jsmin.freeNames('function f(a) { return a + System.millis() + Math.PI; }\nf(1);');
    check('jsmin: freeNames acha os globais', free.names.has('System') && free.names.has('Math') && !free.names.has('a'),
        Array.from(free.names).join(','));
    check('jsmin: freeNames marca eval/with', jsmin.freeNames('eval("1");').hasEvalOrWith === true);

    var threw = null;
    try { jsmin.minify('function ('); } catch (e) { threw = e.code; }
    check('jsmin: fonte invalida -> min.parse (caller cai no strip)', threw === 'min.parse', String(threw));

    // -------------------------------------------------- corpus (tamanho) ----
    var CORPUS = [
        'tools/sdk/engine/celeros.game.js',
        'tools/sdk/engine/celeros.game.spr.js',
        'tools/sdk/engine/celeros.app.js',
        'hub_apps/2D Runner/main.js',
        'hub_apps/Calculator/main.js',
        'data/apps/Settings/main.js',
        'data/apps/Snake/main.js'
    ];
    var grew = [], notIdem = [];
    for (var rel of CORPUS) {
        var file = path.join(ROOT, rel);
        if (!fs.existsSync(file)) continue;
        var src = fs.readFileSync(file);
        var r = jsmin.minify(src, { top: 'yes' });
        if (r.stats.min > jsstrip.strip(src).length) grew.push(rel);
        // o strip do firmware roda de novo no device: idempotente ou perde RAM
        if (!jsstrip.strip(Buffer.from(r.code)).equals(Buffer.from(r.code))) notIdem.push(rel);
    }
    check('jsmin: corpus nao cresce vs jsstrip', grew.length === 0, grew.join(','));
    check('jsmin: strip do device e idempotente na saida', notIdem.length === 0, notIdem.join(','));

    // ------------------------- jsstrip: keyword como propriedade x divisao --
    // `obj.return / 2` e divisao (o token anterior e '.', logo "return" e
    // propriedade, nao keyword) — o strip NAO pode abrir regex e engolir o
    // resto da linha. Mesmos casos do test/cpp/run_tests.cpp (paridade
    // byte a byte host x device).
    var KWPROP = [
        ['obj.return / 2 /* c */ + 1;', 'obj.return / 2 + 1;'],
        ['obj.return / 2 // fim', 'obj.return / 2'],
        ['q = a.case / 4; m = k.new / 8;', 'q = a.case / 4; m = k.new / 8;'],
        ['a.b.return / 2', 'a.b.return / 2'],
        ['obj.return / 2\n// fim\nvar y = 1;', 'obj.return / 2\n\nvar y = 1;'],
        // return de verdade (declaracao, sem '.' antes) segue abrindo regex
        ['return /a\\.b/.test(s); // c', 'return /a\\.b/.test(s);']
    ];
    var kwBad = [];
    for (var kp of KWPROP) {
        var gotKp = jsstrip.strip(Buffer.from(kp[0])).toString('utf8');
        if (gotKp !== kp[1]) kwBad.push(JSON.stringify(kp[0]) + ': ' + JSON.stringify(gotKp) + ' x ' + JSON.stringify(kp[1]));
    }
    check('jsstrip: keyword propriedade nao abre regex (paridade device)', kwBad.length === 0, kwBad.join(' | '));

    // --------------------------------------- equivalencia de app no harness --
    // roda o app original e o minificado (main + extras, com reserved dos
    // irmaos) e compara erro, log e o ultimo frame. Pega quebra semantica que
    // teste unitario nao ve (global de main.js lido por modulo, por exemplo).
    var harness = require('../js_harness/run.js');
    function copyTree(src, dst) {
        fs.mkdirSync(dst, { recursive: true });
        for (var n of fs.readdirSync(src)) {
            if (n === '.studio' || n === '.git' || n === '.dev') continue;
            var a = path.join(src, n), b = path.join(dst, n);
            if (fs.statSync(a).isDirectory()) copyTree(a, b);
            else fs.copyFileSync(a, b);
        }
    }
    function minifyApp(dir, out) {
        copyTree(dir, out);
        var js = [];
        (function walk(d) {
            for (var n of fs.readdirSync(d)) {
                var p = path.join(d, n);
                if (fs.statSync(p).isDirectory()) walk(p);
                else if (/\.js$/.test(n) && n !== 'test.js') js.push(p);
            }
        })(out);
        var reserved = new Set();
        for (var f of js) for (var nm of jsmin.freeNames(fs.readFileSync(f)).names) reserved.add(nm);
        for (var g of js) {
            var r = jsmin.minify(fs.readFileSync(g), { top: true, reserved: reserved });
            fs.writeFileSync(g, r.code);
        }
    }
    function runApp(dir) {
        var r = runner.runAppFolder(dir, {
            render: true, stopAtMs: 1400, microsBias: 1, seed: 7, frames: [0, 1400],
        });
        var h = crypto.createHash('md5');
        for (var fr of r.frames || []) h.update(fr.png);
        return { err: r.err || null, log: (r.log || []).join('\n'), png: h.digest('hex') };
    }
    var APPS = ['data/apps/Snake', 'data/apps/Settings', 'hub_apps/2D Runner', 'hub_apps/Calculator'];
    var diffs = [];
    for (var appRel of APPS) {
        var appDir = path.join(ROOT, appRel);
        if (!fs.existsSync(path.join(appDir, 'app.json'))) continue;
        var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsmin-app-'));
        var orig = path.join(tmp, 'orig'), mini = path.join(tmp, 'min');
        try {
            copyTree(appDir, orig);
            minifyApp(appDir, mini);
            var a = runApp(orig), b = runApp(mini);
            if (a.err !== b.err || a.log !== b.log || a.png !== b.png) {
                diffs.push(appRel + ' (err ' + a.err + ' x ' + b.err + ', png ' + a.png.slice(0, 8) + ' x ' + b.png.slice(0, 8) + ')');
            }
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }
    check('jsmin: apps reais identicos no harness (' + APPS.length + ')', diffs.length === 0, diffs.join(' | '));

    // -------------------------------------------------------- integracao ----
    // o caminho que o publish usa (jsstrip --min) tem que casar com a API
    var cli = path.join(ROOT, 'tools', 'sdk', 'lib', 'jsstrip.js');
    var { spawnSync } = require('child_process');
    var sample = path.join(ROOT, 'data/apps/Snake/main.js');
    var out = spawnSync(process.execPath, [cli, sample, '--min', '--top'], { encoding: 'utf8' });
    check('jsstrip --min --top: CLI minifica', out.status === 0 && out.stdout.length > 0 &&
        out.stdout.length < jsstrip.strip(fs.readFileSync(sample)).length,
        (out.stderr || '').slice(0, 120));
    var freeOut = spawnSync(process.execPath,
        [cli, '--free-names', path.join(ROOT, 'data/apps/Nucleo/policy.js')], { encoding: 'utf8' });
    var parsed = null;
    try { parsed = JSON.parse(freeOut.stdout); } catch (e) { parsed = null; }
    check('jsstrip --free-names: JSON com globais do modulo',
        Array.isArray(parsed) && parsed.indexOf('exports') >= 0 && parsed.indexOf('parseInt') >= 0,
        String(freeOut.stdout).slice(0, 120));
};
