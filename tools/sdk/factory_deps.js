#!/usr/bin/env node
// factory_deps.js — regenera o fecho de deps dos apps de FABRICA na imagem
// LittleFS: `data/modules/<nome>/<versao>/<nome>.js` (stripped, byte-identico
// ao que o hub serve) + `<pasta do app>/deps.json` com as versoes resolvidas.
//
//   node tools/sdk/factory_deps.js            # regenera e poda o que sobrou
//   node tools/sdk/factory_deps.js --check    # so confere, exit 1 se drift
//
// Apps do HUB (hub_apps/) nao participam: la quem resolve e o install da
// loja. As arestas vem de tools/sdk/engine/index.json e as versoes do
// literal `version:` de cada modulo (a mesma fonte do publish-dep).

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ENGINE = path.join(ROOT, 'tools', 'sdk', 'engine');
const MODULES = path.join(ROOT, 'data', 'modules');
const jsstrip = require(path.join(__dirname, 'lib', 'jsstrip.js'));
const check = process.argv.includes('--check');

// versao canonica de cada modulo da arvore (o literal unico gateado pelo sdk)
const versoes = {};
for (const f of fs.readdirSync(ENGINE).filter((n) => n.endsWith('.js'))) {
    const m = fs.readFileSync(path.join(ENGINE, f), 'utf8')
        .match(/version\s*[:=]\s*'([^']+)'/);
    if (!m) throw new Error('sem version: ' + f);
    versoes[f.slice(0, -3)] = m[1];
}
const arestas = JSON.parse(fs.readFileSync(path.join(ENGINE, 'index.json'), 'utf8'));

// ^x.y.z (mesmo major, >= base) ou exata — o contrato do hub
function satisfaz(v, range) {
    if (!range.startsWith('^')) return v === range;
    const [b, r] = [v.split('.'), range.slice(1).split('.')];
    return b[0] === r[0] &&
        (Number(b[1]) > Number(r[1]) ||
         (Number(b[1]) === Number(r[1]) && Number(b[2]) >= Number(r[2])));
}

// fecho transitivo: dep direta -> arestas do modulo, sempre na versao da
// arvore (a fila carrega [nome, range] — arestas entram com o range delas)
function fecho(deps) {
    const out = {};
    const fila = Object.keys(deps).map((n) => [n, deps[n]]);
    while (fila.length) {
        const [nome, range] = fila.shift();
        if (!versoes[nome]) throw new Error('modulo nao existe na arvore: ' + nome);
        if (!satisfaz(versoes[nome], range)) {
            throw new Error('range sem versao na arvore: ' + nome + ' ' + range);
        }
        out[nome] = versoes[nome];
        const ed = arestas[nome] && arestas[nome].deps;
        if (ed) for (const d of Object.keys(ed)) if (!out[d]) fila.push([d, ed[d]]);
    }
    return out;
}

// pastas de app de fabrica (data/apps + overlays de board)
const pastas = [];
for (const raiz of ['data/apps',
    ...fs.readdirSync(path.join(ROOT, 'boards'))
        .map((b) => 'boards/' + b + '/data/apps')]) {
    const abs = path.join(ROOT, raiz);
    if (!fs.existsSync(abs)) continue;
    for (const d of fs.readdirSync(abs).sort()) {
        const dir = path.join(abs, d);
        if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'app.json'))) {
            pastas.push({ dir, rel: raiz + '/' + d });
        }
    }
}

let sujo = 0, acao = [];
const referenciadas = {};   // "nome@versao" que sobrevive na imagem

// 1a passada: resolve todos os apps ANTES de mexer em arquivo nenhum —
// a poda de versoes mortas nao pode correr com resolucao em erro
const planos = [];
for (const app of pastas) {
    const meta = JSON.parse(fs.readFileSync(path.join(app.dir, 'app.json'), 'utf8'));
    if (!meta.deps || !Object.keys(meta.deps).length) continue;
    try { planos.push({ app, resolvido: fecho(meta.deps) }); } catch (e) {
        console.error('ERRO ' + app.rel + ': ' + e.message); sujo++;
    }
}

for (const { app, resolvido } of planos) {
    const alvo = JSON.stringify(resolvido, Object.keys(resolvido).sort(), 2) + '\n';
    const depsPath = path.join(app.dir, 'deps.json');
    const atual = fs.existsSync(depsPath) ? fs.readFileSync(depsPath, 'utf8') : '';
    if (atual !== alvo) {
        acao.push('deps.json ' + app.rel + (atual ? '' : ' (novo)'));
        if (!check) fs.writeFileSync(depsPath, alvo);
    }
    for (const nome of Object.keys(resolvido)) {
        const ver = resolvido[nome];
        referenciadas[nome + '@' + ver] = 1;
        const dst = path.join(MODULES, nome, ver, nome + '.js');
        const corpo = jsstrip.strip(
            fs.readFileSync(path.join(ENGINE, nome + '.js'), 'utf8')).toString('utf8');
        const tem = fs.existsSync(dst) && fs.readFileSync(dst, 'utf8') === corpo;
        if (!tem) {
            acao.push('modulo ' + nome + '@' + ver);
            if (!check) {
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.writeFileSync(dst, corpo);
            }
        }
    }
}

// poda versoes que nenhuma deps.json de fabrica referencia mais
if (fs.existsSync(MODULES)) {
    for (const nome of fs.readdirSync(MODULES)) {
        const base = path.join(MODULES, nome);
        for (const ver of fs.readdirSync(base)) {
            if (!referenciadas[nome + '@' + ver]) {
                acao.push('poda ' + nome + '@' + ver);
                if (!check) fs.rmSync(path.join(base, ver), { recursive: true, force: true });
            }
        }
        if (!check && fs.existsSync(base) && !fs.readdirSync(base).length) fs.rmdirSync(base);
    }
}

if (sujo) {
    // app com dep nao resolvivel: a fabrica sai incompleta (deps.json velho,
    // modulo ausente) — erro no stderr com exit 0 passava despercebido
    process.exit(1);
}
if (acao.length) {
    console.log((check ? 'DRIFT (' : 'regenerado (') + acao.length + '):');
    for (const a of acao) console.log('  ' + a);
    process.exit(check ? 1 : 0);
}
console.log('fabrica em paridade: ' + pastas.length + ' pastas examinadas, ' +
    Object.keys(referenciadas).length + ' modulos referenciados');
