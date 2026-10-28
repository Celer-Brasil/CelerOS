'use strict';
// Importacao de assets: copia para Assets/<tipo>/, gera o .meta com GUID e
// settings do importer. O PNG e decodificado aqui (png.js do SDK) para
// descobrir as dimensoes e validar a grade.

const fs = require('fs');
const path = require('path');
const F = require('./format');
const SC = require('./schema');
const P = require('./scripts');
const { decodePng } = require('../../sdk/lib/png.js');

const EXT_KIND = {
    '.png': 'sprite',
    '.qoa': 'audio',
    '.wav': 'audio',
    '.js': 'script',
};

const KIND_DIR = {
    'sprite': 'Assets/Sprites',
    'sprite-sheet': 'Assets/Sprites',
    'tileset': 'Assets/Sprites',
    'audio': 'Assets/Audio',
    'script': 'Assets/Scripts',
};

const KIND_EXT = {
    'sprite': ['.png'],
    'sprite-sheet': ['.png'],
    'tileset': ['.png'],
    'audio': ['.qoa', '.wav'],
    'script': ['.js'],
};

function pngInfo(file) {
    try {
        const p = decodePng(fs.readFileSync(file));
        return { w: p.w, h: p.h };
    } catch (e) {
        F.fail('asset.png', 'nao consegui decodificar ' + file + ': ' + e.message);
    }
}

function parseGrid(text) {
    const m = /^\s*(\d+)\s*[xX]\s*(\d+)\s*$/.exec(String(text || ''));
    if (!m) return null;
    return { cols: +m[1], rows: +m[2] };
}

// settings iniciais do importer grafico
function graphicSettings(kind, info, opts) {
    // cols/rows/tw/th de lixo (NaN do "+op[k]" do HTTP ou "--cols abc") nao
    // podem ser ignorados em silencio: o autor pediu fatiamento
    for (const k of ['cols', 'rows', 'tw', 'th']) {
        if (opts[k] !== undefined && opts[k] !== null &&
            (!isFinite(opts[k]) || Math.floor(opts[k]) !== opts[k] || opts[k] < 1)) {
            F.fail('asset.grid', k + ' deve ser inteiro >= 1, recebi ' + opts[k]);
        }
    }
    const st = {
        mode: 'single',
        w: info.w,
        h: info.h,
        pivot: [0.5, 0.5],
        key: '#000000',
    };
    const grid = opts.grid ? parseGrid(opts.grid) : null;
    // --grid presente mas ilegivel ("2xx2") nao pode cair em modo single
    // em silencio: o autor pediu fatiamento e levaria a imagem inteira
    if (opts.grid && !grid) {
        F.fail('asset.grid', 'grade invalida: ' + opts.grid,
               { hint: 'use o formato CxR (ex.: 4x4)' });
    }
    const cols = opts.cols || (grid && grid.cols);
    const rows = opts.rows || (grid && grid.rows);
    const tw = opts.tw, th = opts.th;
    const wantGrid = kind === 'sprite-sheet' || kind === 'tileset' ||
                     !!grid || !!cols || !!rows || !!tw || !!th;
    if (wantGrid) {
        st.mode = 'grid';
        st.cols = cols || Math.max(1, Math.floor(info.w / (tw || info.w)));
        st.rows = rows || Math.max(1, Math.floor(info.h / (th || info.h)));
        st.tw = tw || Math.max(1, Math.floor(info.w / st.cols));
        st.th = th || Math.max(1, Math.floor(info.h / st.rows));
        if (st.cols * st.tw > info.w || st.rows * st.th > info.h) {
            F.fail('asset.grid', 'grade ' + st.cols + 'x' + st.rows + ' de ' + st.tw + 'x' + st.th +
                   ' nao cabe no PNG ' + info.w + 'x' + info.h,
                   { hint: 'use --cols/--rows/--tw/--th coerentes com a imagem' });
        }
        if (kind !== 'tileset' && opts.prefix === undefined) st.prefix = '';
    }
    if (kind === 'tileset') {
        st.prefix = '';
        st.tiles = [];
        const n = st.mode === 'grid' ? st.cols * st.rows : 1;
        for (let i = 0; i < n; i++) st.tiles.push({ name: String(i), solid: false });
    }
    if (opts.pivot) st.pivot = opts.pivot;
    if (opts.key) st.key = opts.key;
    if (opts.prefix !== undefined) st.prefix = opts.prefix;
    return st;
}

function importAsset(project, src, opts) {
    opts = opts || {};
    if (opts.name !== undefined && typeof opts.name !== 'string') {
        F.fail('op.args', 'asset.import: name deve ser string');
    }
    if (opts.importer !== undefined && typeof opts.importer !== 'string') {
        F.fail('op.args', 'asset.import: importer deve ser string');
    }
    const absSrc = path.resolve(src);
    if (!fs.existsSync(absSrc)) F.fail('asset.missing', 'arquivo nao existe: ' + absSrc);
    const ext = path.extname(absSrc).toLowerCase();
    const kind = opts.importer || EXT_KIND[ext];
    if (!kind) F.fail('asset.type', 'extensao nao suportada: ' + ext,
                      { hint: 'aceito: .png, .qoa, .wav, .js' });
    if (!KIND_DIR[kind]) F.fail('asset.importer', 'importer desconhecido: ' + kind);
    if (KIND_EXT[kind].indexOf(ext) < 0) {
        F.fail('asset.type', 'importer ' + kind + ' nao aceita ' + ext,
               { hint: 'aceito: ' + KIND_EXT[kind].join(', ') });
    }
    const dirRel = KIND_DIR[kind];
    const base = opts.name || path.basename(absSrc, path.extname(absSrc));
    const rel = project.freeRel(dirRel, base, ext);
    const absDest = project.resolveInside(rel);
    const metaRel = rel + '.meta';
    fs.mkdirSync(path.dirname(absDest), { recursive: true });
    fs.copyFileSync(absSrc, absDest);

    // a copia ja esta no projeto: qualquer falha depois disso tem de remove-la
    // (asset sem .meta polui o scan e o proximo lote falha)
    try {
        let settings = {};
        if (kind === 'sprite' || kind === 'sprite-sheet' || kind === 'tileset') {
            settings = graphicSettings(kind, pngInfo(absDest), opts);
        } else if (kind === 'audio') {
            settings = { loop: !!opts.loop, gain: opts.gain !== undefined ? +opts.gain : 1 };
        } else if (kind === 'script') {
            // props tipados declarados pelo proprio script (exports.props)
            settings = { props: P.propsOfSource(fs.readFileSync(absDest, 'utf8')).props };
        }

        const meta = {
            format: 1,
            guid: F.newGuid(),
            importer: kind,
            settings,
        };
        const bad = [];
        SC.validateMetaData(meta, bad);
        if (bad.length) {
            F.fail('asset.settings', 'meta invalido: ' +
                   bad.map((b) => b.path + ': ' + b.message).join('; '));
        }
        F.writeJson(path.join(project.dir, metaRel), meta);
        const asset = project.registerAsset(rel, meta);
        return { asset, created: [absDest, path.join(project.dir, metaRel)] };
    } catch (e) {
        try { fs.rmSync(absDest, { force: true }); } catch (e2) {}
        try { fs.rmSync(path.join(project.dir, metaRel), { force: true }); } catch (e2) {}
        throw e;
    }
}

// cria um script novo (Assets/Scripts/<nome>.js) com meta
function createScript(project, name, content) {
    const rel = project.freeRel('Assets/Scripts', name, '.js');
    const abs = project.resolveInside(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const src = content === undefined ? scriptTemplate(name) : content;
    fs.writeFileSync(abs, src);
    const meta = { format: 1, guid: F.newGuid(), importer: 'script',
                   settings: { props: P.propsOfSource(src).props } };
    F.writeJson(path.join(project.dir, rel + '.meta'), meta);
    const asset = project.registerAsset(rel, meta);
    return { asset, created: [abs, path.join(project.dir, rel + '.meta')] };
}

// copia um script existente mantendo o NOME ORIGINAL do arquivo (o modo
// legado usa require() com esses nomes)
function importScriptFile(project, src, fileName) {
    const name = String(fileName || path.basename(src));
    if (!/^[A-Za-z0-9_.-]{1,63}\.js$/.test(name)) {
        F.fail('asset.name', 'nome de script invalido para o pacote: ' + name);
    }
    const rel = 'Assets/Scripts/' + name;
    const abs = project.resolveInside(rel);
    if (fs.existsSync(abs)) F.fail('asset.exists', 'script ja existe no projeto: ' + rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(path.resolve(src), abs);
    const meta = { format: 1, guid: F.newGuid(), importer: 'script',
                   settings: { props: P.propsOfSource(fs.readFileSync(abs, 'utf8')).props } };
    F.writeJson(path.join(project.dir, rel + '.meta'), meta);
    return { asset: project.registerAsset(rel, meta), created: [abs, path.join(project.dir, rel + '.meta')] };
}

function scriptTemplate(name) {
    return '// ' + name + ' — componente de script do Celer Studio (ES5).\n' +
           '// O runtime chama start/update/draw com this = entidade e ctx = { E, scene, entity, assets }.\n' +
           '// exports.props declara os campos que o inspetor mostra em `fields`.\n' +
           '\n' +
           'exports.props = { speed: 60 };\n' +
           '\n' +
           'exports.start = function (ctx) {\n' +
           '    this.t = 0;\n' +
           '};\n' +
           '\n' +
           'exports.update = function (dt, ctx) {\n' +
           '    this.t += dt;\n' +
           '};\n';
}

// ajusta settings do meta (fatiamento, pivot, cor-chave, loop...)
function setAssetSettings(project, asset, patch) {
    if (!asset) F.fail('asset.missing', 'asset inexistente');
    const meta = asset.meta;
    if (!meta.settings) meta.settings = {};
    // copia chave a chave: Object.assign deixava "__proto__" do patch virar
    // prototipo de settings (o patch vem de JSON.parse no barramento de ops)
    for (const k of Object.keys(patch || {})) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        meta.settings[k] = patch[k];
    }
    const st = meta.settings;
    if (st.mode === 'grid') {
        if (!st.cols) st.cols = 1;
        if (!st.rows) st.rows = 1;
        if (!st.tw) st.tw = st.w || 1;
        if (!st.th) st.th = st.h || 1;
    }
    if (st.mode === 'regions' && !st.regions) st.regions = {};
    if (meta.importer === 'tileset' && !Array.isArray(st.tiles)) {
        st.tiles = [];
        const n = st.mode === 'grid' ? (st.cols || 1) * (st.rows || 1) : 1;
        for (let i = 0; i < n; i++) st.tiles.push({ name: String(i), solid: false });
    }
    const bad = [];
    SC.validateMetaData(meta, bad);
    if (bad.length) {
        F.fail('asset.settings', 'settings invalidos: ' + bad.map((b) => b.path + ': ' + b.message).join('; '));
    }
    project.writeMeta(asset);
    return asset;
}

module.exports = { importAsset, importScriptFile, createScript, setAssetSettings, scriptTemplate, pngInfo, parseGrid, EXT_KIND };
