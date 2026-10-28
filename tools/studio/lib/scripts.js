'use strict';
// Props de script: o script declara `exports.props = { ... }` e o Studio usa
// isso como formulario tipado (inspetor) e como default dos campos do
// componente. NUNCA executamos o script do projeto: extraimos apenas o
// literal apos `exports.props =` (varredura de chaves balanceadas, ciente de
// strings/comentarios) e avaliamos so ele com new Function.
//
// Formato aceito (o campo do catalogo, com atalhos):
//   exports.props = {
//       velocidade: 60,                                  // number (atalho)
//       modo: { type: 'enum', values: ['a','b'], default: 'a' },
//       cor:  { type: 'color', default: '#38bcf8', label: 'Cor' },
//       dica: { type: 'string', default: '', hint: 'texto livre' }
//   };

const TYPES = ['number', 'int', 'bool', 'string', 'color', 'enum', 'json'];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// acha o texto do objeto literal de `exports.props = { ... }`
function extractLiteral(src) {
    const text = String(src || '');
    const m = /exports\s*\.\s*props\s*=\s*/.exec(text);
    if (!m) return null;
    let i = m.index + m[0].length;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '{') return null;
    const start = i;
    let depth = 0;
    let quote = null;
    for (; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i++;
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return null;
}

function inferType(v) {
    if (typeof v === 'number') return Math.floor(v) === v ? 'int' : 'number';
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'string') return COLOR_RE.test(v) ? 'color' : 'string';
    return 'json';
}

function normalizeField(name, def, out) {
    const field = { type: 'string', label: name };
    if (def === null || def === undefined) {
        field.type = 'string';
        field.default = '';
        out.push(field);
        return;
    }
    if (typeof def !== 'object' || Array.isArray(def)) {
        // atalho: o proprio valor e o default
        field.type = inferType(def);
        field.default = def;
        out.push(field);
        return;
    }
    const type = def.type || inferType(def.default);
    if (TYPES.indexOf(type) < 0) {
        field.type = 'string';
        field.default = '';
        field.hint = 'tipo desconhecido: ' + type;
        out.push(field);
        return;
    }
    field.type = type;
    if (def.label !== undefined) field.label = String(def.label);
    if (def.hint !== undefined) field.hint = String(def.hint);
    if (type === 'enum') {
        const values = Array.isArray(def.values) ? def.values.map(String) : [];
        field.values = values;
        field.default = def.default !== undefined ? String(def.default) : (values[0] || '');
        out.push(field);
        return;
    }
    if (type === 'number' || type === 'int') {
        const d = typeof def.default === 'number' && isFinite(def.default) ? def.default : 0;
        field.default = type === 'int' ? Math.round(d) : d;
        if (typeof def.min === 'number') field.min = def.min;
        if (typeof def.max === 'number') field.max = def.max;
        out.push(field);
        return;
    }
    if (type === 'bool') {
        field.default = !!def.default;
        out.push(field);
        return;
    }
    if (type === 'color') {
        field.default = typeof def.default === 'string' && COLOR_RE.test(def.default) ? def.default : '#38bcf8';
        out.push(field);
        return;
    }
    if (type === 'json') {
        field.default = def.default === undefined ? {} : def.default;
        out.push(field);
        return;
    }
    field.default = def.default === undefined ? '' : String(def.default);
    out.push(field);
}

// devolve {props, error, found}; props no formato do catalogo (name -> field)
function propsOfSource(src) {
    const literal = extractLiteral(src);
    if (!literal) return { props: {}, found: false, error: null };
    let obj;
    try {
        // avalia SO o literal: sem acesso ao script, ao FS ou ao projeto
        obj = new Function('"use strict"; return (' + literal + ');')();
    } catch (e) {
        return { props: {}, found: true, error: 'exports.props invalido: ' + e.message };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return { props: {}, found: true, error: 'exports.props deve ser um objeto' };
    }
    const props = {};
    for (const name of Object.keys(obj)) {
        if (name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
        const fields = [];
        normalizeField(name, obj[name], fields);
        props[name] = fields[0];
        if (!props[name].label) props[name].label = name;
    }
    return { props, found: true, error: null };
}

// defaults declarados pelo script (para o build e para o inspetor)
function propsDefaults(props) {
    const out = {};
    for (const k of Object.keys(props || {})) {
        const f = props[k];
        out[k] = f.default === undefined ? '' : JSON.parse(JSON.stringify(f.default));
    }
    return out;
}

// mescla defaults + campos do componente (campos vencem)
function mergeFields(props, fields) {
    const out = propsDefaults(props);
    for (const k of Object.keys(fields || {})) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        out[k] = fields[k];
    }
    return out;
}

module.exports = { extractLiteral, propsOfSource, propsDefaults, mergeFields, normalizeField, TYPES };
