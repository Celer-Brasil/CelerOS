#!/usr/bin/env node
// Testes do app_lint (tools/app_lint/lint.js): cada fixture deve produzir
// exatamente o conjunto esperado de diagnosticos (severidade + regra).
// Estilo do test/cpp/run_tests.cpp: zero framework, exit 1 em falha.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FIX = path.join(__dirname, 'fixtures');
const linter = require(path.join(ROOT, 'tools', 'app_lint', 'lint.js'));

let failures = 0;

function check(name, cond, detail) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  << ' + detail));
  if (!cond) failures++;
}

function ruleCounts(diags) {
  const counts = {};
  for (const dg of diags) {
    const k = dg.severity + ':' + dg.rule;
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

function fmt(counts) { return JSON.stringify(counts); }

function lintFixture(file, appInfo) {
  return linter.lintSource(linter.buildManifest(), fs.readFileSync(path.join(FIX, file), 'utf8'), appInfo || null);
}

const CASES = [
  { name: 'ok.js limpo', file: 'ok.js', expect: {} },
  { name: 'es6 rejeitado (sintaxe)', file: 'es6.js', expect: { 'erro:sintaxe': 1 } },
  {
    name: 'funcoes/constantes inexistentes', file: 'api_inexistente.js',
    expect: { 'erro:api': 4, 'aviso:var': 2 },  // T e MAGNETA nao declarados no fixture
  },
  {
    name: 'aridades erradas', file: 'aridade.js',
    expect: { 'erro:aridade': 3, 'aviso:aridade': 1, 'erro:api': 1 },
  },
  {
    name: 'globals fora do Duktape lean / Node-isms', file: 'globals.js',
    expect: { 'erro:global': 6 },
  },
  {
    name: 'funcao/variavel nao declarada', file: 'sem_declaracao.js',
    expect: { 'erro:funcao': 1, 'aviso:var': 2 },
  },
  {
    name: 'loop sem ceder + charset', file: 'loop_charset.js',
    expect: { 'aviso:loop': 2, 'aviso:charset': 1 },
  },
  {
    name: 'toolkit UI: UI.end cede, aridade e nivel',
    file: 'ui_toolkit.js',
    appInfo: { api: 21, permissions: [] },
    expect: { 'aviso:aridade': 1, 'aviso:nivel': 4 },  // nivel: 1 por funcao UI.*
  },
  {
    name: 'API gated: permissao/nivel/feature',
    file: 'gated.js',
    appInfo: { api: 2, permissions: ['fs'] },
    expect: { 'aviso:perm': 2, 'aviso:nivel': 1, 'aviso:feature': 1 },
  },
  {
    name: 'permissao opcional por feature-detect (typeof do membro)',
    file: 'perm_typeof.js',
    appInfo: { api: 22, permissions: [] },
    expect: { 'aviso:perm': 1 },  // so o factoryReset; o led tem typeof
  },
  {
    name: 'feature-detect protege raiz opcional e nivel de API (zero avisos)',
    file: 'feature_ok.js',
    appInfo: { api: 2, permissions: [] },
    expect: {},
  },
  {
    name: 'raiz opcional sem typeof e API sem typeof avisam',
    file: 'feature_sem_guarda.js',
    appInfo: { api: 2, permissions: ['system'] },
    expect: { 'aviso:feature': 3, 'aviso:nivel': 1 },
  },
];

console.log('== Testes do app_lint (fixtures) ==');
for (const c of CASES) {
  const got = ruleCounts(lintFixture(c.file, c.appInfo));
  const pass = Object.keys(c.expect).length === Object.keys(got).length &&
    Object.keys(c.expect).every((k) => c.expect[k] === got[k]);
  check(c.name, pass, 'esperado ' + fmt(c.expect) + ', obtido ' + fmt(got));
}

// API 52: UI.extras e' const BOOLEAN do manifest e UI.custom/clip so existem
// com CONFIG_CELEROS_UI_EXTRAS (o d.ts preciso do tipo; apps feature-detectam)
{
  const manifest = linter.buildManifest();
  const ui = manifest.objects.UI;
  const extras = ui.consts.find((c) => c.name === 'extras');
  const custom = ui.fns.find((f) => f.name === 'custom');
  const clip = ui.fns.find((f) => f.name === 'clip');
  const unclip = ui.fns.find((f) => f.name === 'unclip');
  check('API 52: UI.extras booleano e UI.custom/clip gated no manifest',
    !!extras && extras.type === 'boolean' &&
    !!custom && custom.nargs === 8 &&
    !!clip && clip.nargs === 4 && !!unclip && unclip.nargs === 0 &&
    custom.kcfg.indexOf('CONFIG_CELEROS_UI_EXTRAS') >= 0 &&
    clip.kcfg.indexOf('CONFIG_CELEROS_UI_EXTRAS') >= 0,
    JSON.stringify({ extras, custom, clip, unclip }));
}
{
  const src = 'UI.begin();\n' +
    'if (UI.extras) UI.custom("g", 0, 0, 10, 10, 1, function () {});\n' +
    'UI.end();\n';
  const got = ruleCounts(linter.lintSource(linter.buildManifest(), src,
    { api: 52, permissions: [] }));
  check('API 52: app com UI.extras/UI.custom passa no lint',
    fmt(got) === '{}', fmt(got));
}

// Sugestao de nome parecido no erro de API
{
  const diags = lintFixture('api_inexistente.js');
  const d = diags.find((x) => x.message.indexOf('drawPixl') >= 0);
  check('sugestao de typo (drawPixl -> drawPixel)', !!d && d.message.indexOf('drawPixel') >= 0,
    d ? d.message : 'diagnostico ausente');
}

// app.json quebrado (campos, semver, api, size, permissao invalida)
{
  const r = linter.lintApp(linter.buildManifest(), { dir: path.join(FIX, 'badjson') });
  const got = ruleCounts(r.diagnostics);
  check('app.json invalido', got['erro:appjson'] === 7, 'esperado 7 erros appjson, obtido ' + fmt(got));
}

// Teto de main.js em 2 niveis (48KB geral; 128KB com "psram" em requires),
// contado pelo tamanho ENXUTO (jsstrip): o padding dos fixtures e CODIGO
// REAL (repetido), porque comentario gigante enxuga a zero e nao pesa mais.
{
  const os = require('os');
  const tmpApp = (parent, appJson, mainBytes, mainSrc, extraFiles) => {
    fs.mkdirSync(parent, { recursive: true });
    const dir = fs.mkdtempSync(path.join(parent, 'app-'));
    const base = {
      name: 'Teto Teste', packageName: 'celeros.tetoteste', version: '1.0.0',
      author: 'bench', description: 'fixture do teto', api: 6,
      permissions: ['fs'],
    };
    fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify(Object.assign(base, appJson)));
    fs.writeFileSync(path.join(dir, 'main.js'),
      mainSrc !== undefined ? mainSrc : 'System.delay(1);\n'.repeat(Math.ceil(mainBytes / 17)));
    for (const [n, c] of Object.entries(extraFiles || {})) {
      fs.writeFileSync(path.join(dir, n), c);
    }
    return dir;
  };
  const countsOf = (dir) => ruleCounts(linter.lintApp(linter.buildManifest(), { dir }).diagnostics);

  let dir = tmpApp(os.tmpdir(), {}, 50 * 1024);
  let got = countsOf(dir);
  check('teto: 50KB sem requires = erro pedindo psram',
    got['erro:appjson'] === 1 && (got['aviso:appjson'] || 0) === 0, fmt(got));
  fs.rmSync(dir, { recursive: true, force: true });

  dir = tmpApp(os.tmpdir(), { requires: ['psram'] }, 50 * 1024);
  got = countsOf(dir);
  check('teto: 50KB com requires psram = limpo', fmt(got) === '{}', fmt(got));
  fs.rmSync(dir, { recursive: true, force: true });

  dir = tmpApp(os.tmpdir(), { requires: ['psram'] }, 1030 * 1024);
  got = countsOf(dir);
  check('teto: 1030KB com requires psram = erro (teto absoluto 1MB)',
    got['erro:appjson'] === 1 && (got['aviso:appjson'] || 0) === 0, fmt(got));
  fs.rmSync(dir, { recursive: true, force: true });

  // main.js GORDO DE COMENTARIO (~67KB cru) enxuga a ~30B e passa limpo:
  // e o que o publish sobe e o aparelho compila
  dir = tmpApp(os.tmpdir(), {}, 0,
    ('// ' + 'x'.repeat(96) + '\n').repeat(700) + 'System.delay(100);\n');
  got = countsOf(dir);
  check('teto: main.js de comentarios (60KB cru, ~0 enxuto) = limpo',
    fmt(got) === '{}', fmt(got));
  fs.rmSync(dir, { recursive: true, force: true });

  dir = tmpApp(os.tmpdir(), { requires: ['psram', 'bluetooth'] }, 100);
  got = countsOf(dir);
  check('requires: valor desconhecido = erro',
    got['erro:appjson'] === 1 && (got['aviso:appjson'] || 0) === 0, fmt(got));
  fs.rmSync(dir, { recursive: true, force: true });

  // App de overlay de placa (boards/<b>/data/apps): teto vira aviso, nao erro
  const broot = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-boards-'));
  const bdir = tmpApp(path.join(broot, 'boards', 'cyd', 'data', 'apps'), {}, 50 * 1024);
  got = countsOf(bdir);
  check('teto: 50KB sem requires em app de placa = aviso',
    got['aviso:appjson'] === 1 && (got['erro:appjson'] || 0) === 0, fmt(got));
  fs.rmSync(broot, { recursive: true, force: true });

  // ---- modulo + assets (multi-arquivo, API 23) ----
  const MAIN = 'var u = require("util");\nSystem.print("v" + u.dobra(2));\n';
  const UTIL = 'exports.dobra = function (n) { return n * 2; };\n';

  dir = tmpApp(os.tmpdir(), { api: 23 }, 0, MAIN, { 'util.js': UTIL });
  got = countsOf(dir);
  check('modulos: main + util.js com exports = limpo', fmt(got) === '{}', fmt(got));
  fs.rmSync(dir, { recursive: true, force: true });

  dir = tmpApp(os.tmpdir(), { api: 3 }, 0, MAIN, { 'util.js': UTIL });
  got = countsOf(dir);
  check('modulos: require exige api 23 (aviso nivel)',
    got['aviso:nivel'] === 1 && fmt(got) !== '{}' && !got['erro:appjson'], fmt(got));
  fs.rmSync(dir, { recursive: true, force: true });

  dir = tmpApp(os.tmpdir(), { api: 23 }, 40 * 1024, undefined,
    { 'mod.js': 'System.delay(1);\n'.repeat(Math.ceil(20 * 1024 / 17)) });
  got = countsOf(dir);
  check('modulos: soma 40+20KB sem psram = erro pela soma',
    got['erro:appjson'] === 1, fmt(got));
  fs.rmSync(dir, { recursive: true, force: true });

  dir = tmpApp(os.tmpdir(), { api: 23, requires: ['psram'] }, 40 * 1024, undefined,
    { 'mod.js': 'System.delay(1);\n'.repeat(Math.ceil(20 * 1024 / 17)) });
  got = countsOf(dir);
  check('modulos: soma 60KB com psram = limpo', fmt(got) === '{}', fmt(got));
  fs.rmSync(dir, { recursive: true, force: true });

  dir = tmpApp(os.tmpdir(), { api: 23 }, 100, undefined,
    { 'grande.wav': '0'.repeat(150 * 1024) });
  got = countsOf(dir);
  check('assets: 150KB em um arquivo = erro (128KB por arquivo)',
    got['erro:appjson'] === 1, fmt(got));
  fs.rmSync(dir, { recursive: true, force: true });

  dir = tmpApp(os.tmpdir(), { api: 23 }, 100, undefined, { 'meu som.wav': 'RIFF00' });
  got = countsOf(dir);
  check('assets: nome com espaco = erro', got['erro:appjson'] === 1, fmt(got));
  fs.rmSync(dir, { recursive: true, force: true });

  dir = tmpApp(os.tmpdir(), { api: 23 }, 100, undefined,
    Object.fromEntries(Array.from({ length: 17 }, (_, i) =>
      ['m' + String(i).padStart(2, '0') + '.js', '1'])));
  got = countsOf(dir);
  check('assets: 17 arquivos extras = erro (max 16)', got['erro:appjson'] === 1, fmt(got));
  fs.rmSync(dir, { recursive: true, force: true });
}

// Manifest derivado do firmware: sanidade contra o fonte (o numero exato de
// funcoes varia com WIP do firmware — os invariantes abaixo e que importam)
{
  const m = linter.buildManifest();
  check('manifest: API level do firmware', m.apiLevel >= 12, 'apiLevel=' + m.apiLevel);
  check('manifest: >=100 funcoes parseadas', m.counts.functions >= 100, 'functions=' + m.counts.functions);
  check('manifest: todo corpo C++ encontrado', m.counts.bodiesFound === m.counts.functions,
    'bodiesFound=' + m.counts.bodiesFound + ' functions=' + m.counts.functions);
  check('manifest: namespaces', ['System', 'System.gpio', 'Net', 'FS', 'CelerLink'].every((n) => m.objects[n]),
    Object.keys(m.objects).join(','));
  check('manifest: sem warnings do parser', m.warnings.length === 0, fmt(m.warnings));
  const sys = m.objects['System.gpio'];
  check('manifest: gpio com permissoes e gate', sys.perm === 'gpio' && sys.kcfg.indexOf('CONFIG_CELEROS_JS_GPIO') >= 0,
    'perm=' + sys.perm + ' kcfg=' + fmt(sys.kcfg));
}

// Dogfood: os apps do repo tem que passar limpos (e o exit code respeta)
{
  const r = linter.runLint([], {});
  check('dogfood data/apps + hub_apps', r.ok && r.totals.errors === 0, fmt(r.totals));
}

// Guard duk_error variadico: lightfunc + %s/%d corrompe o heap (bancada
// 2026-10). Detecta o padrao (inclusive string na linha seguinte) e nao
// acusa o formato seguro (snprintf pre-formatado).
{
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'duk-'));
  fs.writeFileSync(path.join(tmp, 'JsFake.cpp'), [
    'duk_ret_t js_a(duk_context *ctx) {',
    '    duk_error(ctx, DUK_ERR_ERROR, "pin %d invalido", pin);',  // ruim: %d + arg
    '}',
    'duk_ret_t js_b(duk_context *ctx) {',
    '    duk_error(ctx, DUK_ERR_ERROR,',                                // ruim: multiline
    '              "FS: %s negado", path);',
    '}',
    'duk_ret_t js_c(duk_context *ctx) {',
    '    char msg[64];',
    '    snprintf(msg, sizeof(msg), "pin %d", pin);',                  // seguro
    '    duk_error(ctx, DUK_ERR_ERROR, msg);',
    '}',
    'duk_ret_t js_d(duk_context *ctx) {',
    '    duk_error(ctx, DUK_ERR_RANGE_ERROR, "sem formato aqui");',    // seguro
    '}',
    '',
  ].join('\n'));
  const bad = linter.scanRuntimeDukErrors(tmp);
  check('guard duk_error: 2 violacoes no fixture', bad.length === 2 && bad[0] === 'JsFake.cpp:2' && bad[1] === 'JsFake.cpp:5',
    fmt(bad));
  const real = linter.scanRuntimeDukErrors();
  check('guard duk_error: Runtime do firmware limpo', real.length === 0, fmt(real));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.log('FALHAS: ' + failures);
  process.exit(1);
}
console.log('OK: todos os testes passaram');
