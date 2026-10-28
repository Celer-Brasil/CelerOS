'use strict';
// Formato do Celer Studio: JSON canonico, ids estaveis e helpers de caminho.
//
// A fonte da verdade sao os arquivos do projeto (celergame.project.json,
// Assets/**, *.scene.json, *.prefab.json, *.meta). A serializacao e
// DETERMINISTICA (chaves conhecidas na ordem do schema, o resto em ordem
// alfabetica, LF, 2 espacos, newline final) para que edicoes de IA e da GUI
// gerem diffs limpos e builds reproduziveis.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ordem preferida das chaves (o que nao esta aqui vai em ordem alfabetica
// depois). Cobre projeto, cena, prefab, meta, ops e data de runtime.
const KEY_ORDER = [
    'format', 'rev', 'studio',
    'name', 'packageName', 'version', 'author', 'description', 'type', 'category',
    'api', 'requires', 'topbar', 'permissions', 'deps', 'changelog', 'icon',
    'canvas', 'w', 'h', 'native', 'fps', 'startScene', 'build', 'out', 'splitKB',
    'editor', 'grid', 'snap',
    'guid', 'importer', 'settings',
    'file', 'src', 'kind', 'mode', 'cols', 'rows', 'tw', 'th', 'pivot', 'key',
    'prefix', 'regions', 'tiles', 'solid', 'loop', 'gain', 'props',
    'entities', 'tilemaps', 'scene', 'entity', 'component', 'prefab', 'overrides',
    'fid', 'active', 'z', 'transform', 'x', 'y', 'rot', 'sx', 'sy', 'ax', 'ay',
    'id', 'fields', 'clips', 'current', 'autoplay', 'text', 'color', 'px', 'ts',
    'align', 'valign', 'shadow', 'shape', 'r', 'fill', 'script', 'target',
    'layer', 'data', 'solids', 'autotile', 'music', 'camera', 'bounds', 'follow',
    'deadzone', 'bg', 'static',
    'ok', 'changed', 'created', 'warnings', 'errors', 'code', 'message', 'hint',
];

const KEY_INDEX = new Map(KEY_ORDER.map((k, i) => [k, i]));

function sortValue(value) {
    if (Array.isArray(value)) return value.map(sortValue);
    if (!value || typeof value !== 'object') return value;
    const keys = Object.keys(value).sort((a, b) => {
        const ia = KEY_INDEX.has(a) ? KEY_INDEX.get(a) : 1e6;
        const ib = KEY_INDEX.has(b) ? KEY_INDEX.get(b) : 1e6;
        return ia - ib || cmpStr(a, b);
    });
    const out = {};
    for (const k of keys) out[k] = sortValue(value[k]);
    return out;
}

function canonicalJson(obj) {
    return JSON.stringify(sortValue(obj), null, 2) + '\n';
}

class StudioError extends Error {
    constructor(code, message, extra) {
        super(message);
        this.name = 'StudioError';
        this.code = code;
        if (extra) Object.assign(this, extra);
    }
}

function fail(code, message, extra) {
    throw new StudioError(code, message, extra);
}

function readJson(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) { fail('file.read', 'nao consegui ler ' + file + ': ' + e.message); }
    // editor externo pode salvar com BOM; JSON.parse nao aceita U+FEFF
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    try { return JSON.parse(text); }
    catch (e) {
        fail('json.invalid', file + ': JSON invalido: ' + e.message,
             { path: file });
    }
}

// gravacao atomica: um leitor concorrente (GUI/HTTP) nunca ve o arquivo
// truncado no meio do write; o temporario fica na mesma pasta para o rename
// ser atomico.
function writeFileAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    try {
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch (e2) {}
        throw e;
    }
}

function writeJson(file, obj) {
    writeFileAtomic(file, canonicalJson(obj));
}

function writeText(file, text) {
    writeFileAtomic(file, text);
}

function newGuid() {
    return crypto.randomBytes(16).toString('hex');
}

function newFid(prefix) {
    return (prefix || 'e') + '_' + crypto.randomBytes(4).toString('hex');
}

// nome de modulo/arquivo seguro: [A-Za-z0-9._-], sem acento, <= max
function sanitizeFileName(name, max) {
    const limit = max || 60;
    let s = String(name || '');
    const dot = s.lastIndexOf('.');
    let ext = '';
    if (dot > 0) { ext = s.slice(dot); s = s.slice(0, dot); }
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
         .replace(/[^A-Za-z0-9._-]+/g, '_')
         .replace(/^[._-]+|[._-]+$/g, '') || 'asset';
    ext = ext.replace(/[^A-Za-z0-9.]/g, '');
    const room = Math.max(8, limit - ext.length);
    if (s.length > room) s = s.slice(0, room).replace(/[._-]+$/, '');
    return s + ext;
}

// slug de modulo local (s.<slug>.js): minusculo, sem acento
function slug(name, max) {
    const limit = max || 40;
    let s = String(name || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!s) s = 'item';
    if (s.length > limit) s = s.slice(0, limit).replace(/_+$/, '');
    return s;
}

function normalizeRel(p) {
    return String(p).split(path.sep).join('/');
}

// comparacao deterministica por code unit: localeCompare depende do locale do
// host (ICU) e mudaria a ordem de assets/cenas entre maquinas, quebrando o
// "mesma fonte => mesmos bytes" do build.
function cmpStr(a, b) {
    const s = String(a), t = String(b);
    return s < t ? -1 : (s > t ? 1 : 0);
}

function relPosix(from, to) {
    return normalizeRel(path.relative(from, to));
}

function isInside(base, target) {
    const b = path.resolve(base);
    const t = path.resolve(target);
    return t === b || t.startsWith(b + path.sep);
}

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

// numeros de cena: evita 12.000000000001 no JSON
function round(n, digits) {
    const d = digits === undefined ? 3 : digits;
    const k = Math.pow(10, d);
    return Math.round(Number(n) * k) / k;
}

function parseColor(value, fallback) {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return fallback === undefined ? 0x0000 : fallback;
    const s = value.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(s) && !/^[0-9a-fA-F]{3}$/.test(s)) {
        return fallback === undefined ? 0x0000 : fallback;
    }
    const hex = s.length === 3 ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2] : s;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

function colorHex(value) {
    if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
    if (typeof value !== 'number') return '#000000';
    const r = (value >> 11) & 0x1F, g = (value >> 5) & 0x3F, b = value & 0x1F;
    const c = (n) => ('0' + n.toString(16)).slice(-2);
    return '#' + c(Math.round(r * 255 / 31)) + c(Math.round(g * 255 / 63)) + c(Math.round(b * 255 / 31));
}

function uniqueName(base, used) {
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) {
        const dot = base.lastIndexOf('.');
        name = dot > 0 ? base.slice(0, dot) + '_' + n + base.slice(dot) : base + '_' + n;
        n++;
    }
    used.add(name.toLowerCase());
    return name;
}

function firstKey(obj) {
    for (const k in obj) return k;
    return null;
}

module.exports = {
    KEY_ORDER, StudioError, fail, sortValue, canonicalJson, readJson, writeJson, writeText,
    writeFileAtomic, newGuid, newFid, sanitizeFileName, slug, normalizeRel, relPosix, isInside,
    deepClone, round, parseColor, colorHex, uniqueName, firstKey, cmpStr,
};
