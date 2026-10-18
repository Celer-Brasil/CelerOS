#!/usr/bin/env node
// Conformidade semver entre as implementacoes do sistema de dependencias.
//
// O bug 2.7.2 da Loja (caret cortado da VERSAO) e a gramatica frouxa do
// parseInt nasceram de 4 copias independentes da mesma semantica. Este
// vetor e o contrato normativo: o MESMO (range, versao) e o MESMO fecho
// tem que dar o MESMO resultado em todas as implementacoes —
//
//   python3 tools/celerhub.py    range_satisfies / resolve_dep_ranges
//                                (o celerctl e o hub importam daqui)
//   data/apps/App Store/main.js  depRangeOk / resolveDeps (device)
//   test/js_harness/run.js       satisfiesRange (host)
//   tools/sdk/engine/celeros.app.semver.js  rangeOk / resolve (CelerKit)
//
// Gramatica normativa: "^X.Y.Z" = mesma major E >= base (major = breaking;
// minor/patch sao upgrades automaticos — mesmo modelo do ^ do Dart pub) ou
// "X.Y.Z" exata. Qualquer outra coisa NAO satisfaz.
//
//     node test/semver/run.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
let falhas = 0;

// ---- vetores ----------------------------------------------------------------
// [range, versao, esperado] — bordas de major/minor/patch, 0.x (regra da
// casa: mesma major vale, nao a do npm) e malformados que NAO satisfazem.
const RANGES = [
    ['^1.1.0', '1.1.0', true],
    ['^1.1.0', '1.3.0', true],
    ['^1.1.0', '1.0.9', false],
    ['^1.1.0', '2.0.0', false],
    ['^2.1.1', '2.10.0', true],      // numerico parte a parte, nao string
    ['^1.1.0', '1.1.10', true],
    ['^1.1.0', '1.2.0', true],
    ['1.2.3', '1.2.3', true],
    ['1.2.3', '1.2.4', false],
    ['1.2.3', '2.2.3', false],
    ['^0.1.0', '0.1.5', true],
    ['^0.1.0', '0.2.0', true],       // 0.x: mesma major vale (contrato da casa)
    ['^10.0.0', '10.1.0', true],
    ['^10.0.0', '9.9.9', false],
    ['^01.0.0', '1.0.0', true],      // zero a esquerda: numerico vale
    ['01.0.0', '1.0.0', false],      // ...mas exata e por string
    // malformados: nada satisfaz (o parseInt(||0) antigo aceitava "1.2")
    ['1.2', '1.2.0', false],
    ['^1.2', '1.2.0', false],
    ['^1.2.3.4', '1.2.3', false],
    ['abc', '1.0.0', false],
    ['^1.0.0', '', false],
    ['^1.0.0', '1.0', false],
    ['^1.0.0', 'v1.0.0', false],
    ['^ 1.0.0', '1.0.0', false],
    ['', '1.0.0', false],
];

// fechos: {nome, want, index, esperado (null = nao resolve)} — S3 e o caso
// que o BFS unico errava: aresta de pick vencido vazava (pino de "e"
// sobrando) e a aresta do pick novo ("f") nao era coletada.
const CLOSURES = [
    {
        // pino exato que chega DEPOIS rebaixa o pick: a aresta do pick
        // vencido (a 1.1.0 -> d) nao pode sobrar no fecho
        nome: 'S0 pino tardio rebaixa e a aresta vencida sai',
        want: { a: '^1.0.0', b: '^1.0.0' },
        index: {
            a: { '1.0.0': { deps: {} }, '1.1.0': { deps: { d: '^1.0.0' } } },
            b: { '1.0.0': { deps: { a: '1.0.0' } } },
            d: { '1.0.0': {} },
        },
        esperado: { a: '1.0.0', b: '1.0.0' },
    },
    {
        nome: 'S1 cadeia simples',
        want: { a: '^1.0.0' },
        index: {
            a: { '1.0.0': { deps: { b: '^1.0.0' } }, '1.2.0': { deps: { b: '^1.0.0' } } },
            b: { '1.0.0': {}, '1.5.0': {} },
        },
        esperado: { a: '1.2.0', b: '1.5.0' },
    },
    {
        nome: 'S2 transitiva nao pula major',
        want: { a: '^1.0.0', b: '^1.0.0' },
        index: {
            a: { '1.0.0': {}, '1.2.0': { deps: { b: '^1.0.0' } } },
            b: { '1.0.0': {}, '2.0.0': {} },
        },
        esperado: { a: '1.2.0', b: '1.0.0' },
    },
    {
        nome: 'S3 aresta de pick vencido (ponto fixo)',
        want: { a: '^1.0.0', b: '^1.4.0' },
        index: {
            a: {
                '1.0.0': { deps: {} },
                '1.2.0': { deps: { e: '^1.0.0' } },
                '1.4.0': { deps: { f: '^1.0.0' } },
            },
            b: { '1.4.0': { deps: { a: '^1.3.0' } } },
            e: { '1.0.0': {} },
            f: { '1.0.0': {} },
        },
        esperado: { a: '1.4.0', b: '1.4.0', f: '1.0.0' },  // e NAO vem
    },
    {
        nome: 'S4 major incompativel nao resolve',
        want: { x: '^1.0.0' },
        index: { x: { '2.0.0': {} } },
        esperado: null,
    },
    {
        nome: 'S5 nome fora do indice nao resolve',
        want: { ghost: '^1.0.0' },
        index: {},
        esperado: null,
    },
    {
        nome: 'S6 majors coexistem por app',
        want: { p: '^1.0.0', q: '^2.0.0' },
        index: {
            p: { '1.0.0': {}, '1.9.0': {} },
            q: { '2.0.0': {}, '2.3.0': {} },
        },
        esperado: { p: '1.9.0', q: '2.3.0' },
    },
    {
        nome: 'S7 want vazio resolve vazio',
        want: {},
        index: { a: { '1.0.0': {} } },
        esperado: {},
    },
];

// ---- extracao das implementacoes JS (sem copiar codigo: colar aqui ia
// virar uma 5a copia — o teste extrai o fonte REAL que roda em producao)
function stripComentarios(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
function grabFn(src, name) {
    const limpo = stripComentarios(src);
    const i = limpo.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('funcao ' + name + ' nao achada');
    let depth = 0;
    for (let k = limpo.indexOf('{', i); k < limpo.length; k++) {
        if (limpo[k] === '{') depth++;
        else if (limpo[k] === '}') {
            depth--;
            if (!depth) return limpo.slice(i, k + 1);
        }
    }
    throw new Error('chaves desbalanceadas em ' + name);
}

const lojaSrc = fs.readFileSync(path.join(ROOT, 'data', 'apps', 'App Store', 'main.js'), 'utf8');
const reDep = lojaSrc.match(/var RE_VER_DEP = [^;]+;/);
if (!reDep) throw new Error('RE_VER_DEP nao achada na Loja');
const loja = new Function(
    reDep[0] + '\n' +
    ['cmpV', 'depRangeOk', 'depPick', '_passadaDeps', 'resolveDeps']
        .map(n => grabFn(lojaSrc, n)).join('\n') +
    '\nreturn { depRangeOk: depRangeOk, resolveDeps: resolveDeps };')();

const harnessSrc = fs.readFileSync(path.join(ROOT, 'test', 'js_harness', 'run.js'), 'utf8');
const satisfiesRange = new Function(
    grabFn(harnessSrc, 'satisfiesRange') + '\nreturn satisfiesRange;')();

// CelerKit: o modulo inteiro, com um core falso no require
const kitSrc = fs.readFileSync(path.join(ROOT, 'tools', 'sdk', 'engine', 'celeros.app.semver.js'), 'utf8');
const kitMod = { exports: {} };
new Function('require', 'module', 'System', kitSrc)(function () { return { _mods: [] }; }, kitMod, {});
const kit = kitMod.exports.semver;

function pythonCheck(payload) {
    const script = [
        "import sys, json",
        "sys.path.insert(0, 'tools')",
        "import celerhub",
        "req = json.load(sys.stdin)",
        "out = {'ranges': [], 'closures': []}",
        "for rng, ver in req['ranges']:",
        "    out['ranges'].append(bool(celerhub.range_satisfies(rng, ver)))",
        "for sc in req['closures']:",
        "    try:",
        "        out['closures'].append(celerhub.resolve_dep_ranges(sc['want'], sc['index']))",
        "    except SystemExit:",
        "        out['closures'].append(None)",
        "print(json.dumps(out, sort_keys=True))",
    ].join('\n');
    return JSON.parse(execFileSync('python3', ['-c', script], {
        cwd: ROOT, input: JSON.stringify(payload), encoding: 'utf8',
        // S4/S5 morrem de proposito no resolve (die do celerhub): o stderr
        // e o motivo legivel, nao falha do teste
        stdio: ['pipe', 'pipe', 'ignore'],
    }));
}

function sortDeep(o) {
    if (o === null || o === undefined) return null;
    if (typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(sortDeep);
    const r = {};
    for (const k of Object.keys(o).sort()) r[k] = sortDeep(o[k]);
    return r;
}
const canon = o => JSON.stringify(sortDeep(o));

// ---- roda o vetor nas tres ---------------------------------------------------
const py = pythonCheck({
    ranges: RANGES.map(r => [r[0], r[1]]),
    closures: CLOSURES.map(c => ({ want: c.want, index: c.index })),
});

function falha(impl, tipo, caso, got, want) {
    falhas++;
    console.log(`ERRO [${impl}] ${tipo}: ${caso} — deu ${got}, esperado ${want}`);
}

RANGES.forEach((r, i) => {
    const [rng, ver, esperado] = r;
    const caso = `range ${JSON.stringify(rng)} vs ${JSON.stringify(ver)}`;
    if (loja.depRangeOk(rng, ver) !== esperado) falha('Loja', 'range', caso, loja.depRangeOk(rng, ver), esperado);
    if (satisfiesRange(rng, ver) !== esperado) falha('harness', 'range', caso, satisfiesRange(rng, ver), esperado);
    if (py.ranges[i] !== esperado) falha('celerhub.py', 'range', caso, py.ranges[i], esperado);
    if (kit.rangeOk(ver, rng) !== esperado) falha('CelerKit', 'range', caso, kit.rangeOk(ver, rng), esperado);
});

CLOSURES.forEach((c, i) => {
    const gotLoja = canon(loja.resolveDeps(c.want, c.index));
    const gotPy = canon(py.closures[i]);
    const want = canon(c.esperado);
    if (gotLoja !== want) falha('Loja', 'fecho', c.nome, gotLoja, want);
    if (gotPy !== want) falha('celerhub.py', 'fecho', c.nome, gotPy, want);
    const gotKit = canon(kit.resolve(c.want, c.index));
    if (gotKit !== want) falha('CelerKit', 'fecho', c.nome, gotKit, want);
});

const total = RANGES.length * 4 + CLOSURES.length * 3;
if (falhas) {
    console.log(`FALHOU: ${falhas} divergencia(s) de ${total} casos`);
    process.exit(1);
}
console.log(`OK: ${total} casos (${RANGES.length} ranges x 4, ${CLOSURES.length} fechos x 3) ` +
            `concordam entre celerhub.py, Loja, harness e CelerKit`);
