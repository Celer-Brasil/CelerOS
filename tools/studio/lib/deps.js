'use strict';
// Lock de dependencias do Celer Studio. O app gerado faz require() nas
// deps compartilhadas (celeros.game.*); no device o require so cai para
// /local/modules quando existe <pasta do app>/deps.json com o FECHO
// resolvido. O installzip nativo e dep-cego, entao o app.zip precisa levar
// esse arquivo — sem ele o jogo nem abre ("modulo nao encontrado").
//
// A resolucao usa a MESMA arvore que o build: tools/sdk/engine/index.json
// (arestas) + o literal version: de cada modulo. E o fecho local, pinado
// no zip; o install da loja/celerctl pode regravar o deps.json com o indice
// do hub, mas um zip instalado direto ja sai completo.

const fs = require('fs');
const path = require('path');

const ENGINE = path.join(__dirname, '..', '..', 'sdk', 'engine');
const RE_VER = /^(\d+)\.(\d+)\.(\d+)$/;
const RE_RANGE = /^\^?\d+\.\d+\.\d+$/;

function compare(a, b) {
    const pa = String(a).split('.');
    const pb = String(b).split('.');
    for (let i = 0; i < 3; i++) {
        const na = Number(pa[i] || 0);
        const nb = Number(pb[i] || 0);
        if (na !== nb) return na < nb ? -1 : 1;
    }
    return 0;
}

function rangeOk(version, range) {
    const caret = String(range).charAt(0) === '^';
    const r = RE_VER.exec(caret ? String(range).slice(1) : String(range));
    const v = RE_VER.exec(String(version));
    if (!r || !v) return false;
    if (!caret) return String(version) === String(range);
    return v[1] === r[1] &&
        (Number(v[2]) > Number(r[2]) ||
         (Number(v[2]) === Number(r[2]) && Number(v[3]) >= Number(r[3])));
}

function pick(versions, ranges) {
    let best = null;
    for (const v of Object.keys(versions || {})) {
        if (!ranges.every((r) => rangeOk(v, r))) continue;
        if (best === null || compare(v, best) > 0) best = v;
    }
    return best;
}

// indice local no mesmo formato do /store/deps.json:
// { nome: { versao: { deps: { nome: range } } } }
function localIndex() {
    let edges = {};
    try {
        edges = JSON.parse(fs.readFileSync(path.join(ENGINE, 'index.json'), 'utf8'));
    } catch (e) {
        edges = {};
    }
    const out = {};
    for (const file of fs.readdirSync(ENGINE).filter((n) => n.endsWith('.js'))) {
        const name = file.slice(0, -3);
        const src = fs.readFileSync(path.join(ENGINE, file), 'utf8');
        const m = src.match(/version\s*[:=]\s*['"]([^'"]+)['"]/);
        if (!m || !RE_VER.test(m[1])) continue;
        out[name] = out[name] || {};
        out[name][m[1]] = { deps: (edges[name] && edges[name].deps) || {} };
    }
    return out;
}

function addRange(map, name, range) {
    if (!map[name]) map[name] = [];
    if (map[name].indexOf(range) < 0) map[name].push(range);
}

function sameRanges(a, b) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.join('\n') !== kb.join('\n')) return false;
    for (const k of ka) {
        const ra = a[k].slice().sort();
        const rb = b[k].slice().sort();
        if (ra.join('\n') !== rb.join('\n')) return false;
    }
    return true;
}

// Fecho transitivo com ponto fixo (a mesma semantica do hub/celerctl).
// Devolve { nome: versao } com chaves ordenadas; lanca Error com o motivo
// exato quando um range nao resolve na arvore local.
function resolveLocal(deps) {
    const direct = {};
    for (const name of Object.keys(deps || {})) {
        const range = String(deps[name]);
        if (!RE_RANGE.test(range)) {
            throw new Error(name + ': range invalido "' + range + '" (use ^x.y.z ou x.y.z)');
        }
        direct[name] = range;
    }
    const index = localIndex();
    let ranges = {};
    for (const name of Object.keys(direct)) addRange(ranges, name, direct[name]);

    for (let pass = 0; pass < 32; pass++) {
        const picks = {};
        for (const name of Object.keys(ranges)) {
            if (!index[name]) throw new Error('modulo nao existe na arvore: ' + name);
            const v = pick(index[name], ranges[name]);
            if (!v) {
                throw new Error('range sem versao na arvore: ' + name + ' ' + ranges[name].join(' + '));
            }
            picks[name] = v;
        }
        const next = {};
        for (const name of Object.keys(direct)) addRange(next, name, direct[name]);
        for (const name of Object.keys(picks)) {
            const sub = (index[name][picks[name]] || {}).deps || {};
            for (const dn of Object.keys(sub)) addRange(next, dn, String(sub[dn]));
        }
        if (sameRanges(ranges, next)) {
            const out = {};
            for (const name of Object.keys(picks).sort()) out[name] = picks[name];
            return out;
        }
        ranges = next;
    }
    throw new Error('fecho de deps nao convergiu');
}

module.exports = { resolveLocal, localIndex, rangeOk, compare };
