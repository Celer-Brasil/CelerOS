'use strict';
// Importacao de assets: copia para Assets/<tipo>/, gera o .meta com GUID e
// settings do importer. O PNG e decodificado aqui (png.js do SDK) para
// descobrir as dimensoes e validar a grade.

const fs = require('fs');
const path = require('path');
const F = require('./format');
const SC = require('./schema');
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
    const st = {
        mode: 'single',
        w: info.w,
        h: info.h,
        pivot: [0.5, 0.5],
        key: '#000000',
    };
    const grid = opts.grid ? parseGrid(opts.grid) : null;
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
    const absSrc = path.resolve(src);
    if (!fs.existsSync(absSrc)) F.fail('asset.missing', 'arquivo nao existe: ' + absSrc);
    const ext = path.extname(absSrc).toLowerCase();
    const kind = opts.importer || EXT_KIND[ext];
    if (!kind) F.fail('asset.type', 'extensao nao suportada: ' + ext,
                      { hint: 'aceito: .png, .qoa, .wav, .js' });
    if (!KIND_DIR[kind]) F.fail('asset.importer', 'importer desconhecido: ' + kind);
    const dirRel = KIND_DIR[kind];
    const base = opts.name || path.basename(absSrc, path.extname(absSrc));
    const rel = project.freeRel(dirRel, base, ext);
    const absDest = project.resolveInside(rel);
    fs.mkdirSync(path.dirname(absDest), { recursive: true });
    fs.copyFileSync(absSrc, absDest);

    let settings = {};
    if (kind === 'sprite' || kind === 'sprite-sheet' || kind === 'tileset') {
        settings = graphicSettings(kind, pngInfo(absDest), opts);
    } else if (kind === 'audio') {
        settings = { loop: !!opts.loop, gain: opts.gain !== undefined ? +opts.gain : 1 };
    } else if (kind === 'script') {
        settings = { props: {} };
    }

    const meta = {
        format: 1,
        guid: F.newGuid(),
        importer: kind,
        settings,
    };
    const metaRel = rel + '.meta';
    F.writeJson(path.join(project.dir, metaRel), meta);
    const asset = project.registerAsset(rel, meta);
    return { asset, created: [absDest, path.join(project.dir, metaRel)] };
}

// cria um script novo (Assets/Scripts/<nome>.js) com meta
function createScript(project, name, content) {
    const rel = project.freeRel('Assets/Scripts', name, '.js');
    const abs = project.resolveInside(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content === undefined ? scriptTemplate(name) : content);
    const meta = { format: 1, guid: F.newGuid(), importer: 'script', settings: { props: {} } };
    F.writeJson(path.join(project.dir, rel + '.meta'), meta);
    const asset = project.registerAsset(rel, meta);
    return { asset, created: [abs, path.join(project.dir, rel + '.meta')] };
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
    Object.assign(meta.settings, patch || {});
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

module.exports = { importAsset, createScript, setAssetSettings, scriptTemplate, pngInfo, parseGrid, EXT_KIND };
