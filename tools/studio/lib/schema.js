'use strict';
// Schemas do Studio: carrega o catalogo de componentes e valida a ESTRUTURA
// dos arquivos (projeto, cena, prefab, meta). Validacao de referencias,
// limites de pacote, lint ES5 e tamanho fica em validate.js.

const fs = require('fs');
const path = require('path');

const SCHEMA_DIR = path.join(__dirname, '..', 'schema');
const COMPONENTS = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'components.json'), 'utf8'));

const PROJECT_SCHEMA = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'project.schema.json'), 'utf8'));
const SCENE_SCHEMA = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'scene.schema.json'), 'utf8'));
const PREFAB_SCHEMA = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'prefab.schema.json'), 'utf8'));
const META_SCHEMA = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'meta.schema.json'), 'utf8'));

const PKG_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const RANGE_RE = /^\^?\d+\.\d+\.\d+$/;
const GUID_RE = /^[0-9a-f]{32}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Teto de `api` do app.json: lido do firmware, NAO duplicado aqui (o mesmo
// numero estava escrito a mao e o Studio recusou a API 52 quando so o
// CMakeLists subiu).
const MAIN_CMAKE = path.join(__dirname, '..', '..', '..', 'main', 'CMakeLists.txt');
const API_CEILING = (() => {
    const m = /CELEROS_API_LEVEL=(\d+)/.exec(fs.readFileSync(MAIN_CMAKE, 'utf8'));
    if (!m) throw new Error('CELEROS_API_LEVEL nao encontrado em main/CMakeLists.txt');
    return parseInt(m[1], 10);
})();

function err(code, at, message, hint) {
    const out = { code, path: at, message };
    if (hint) out.hint = hint;
    return out;
}

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function isInt(v) { return isNum(v) && Math.floor(v) === v; }

function checkField(value, def, at, out) {
    if (value === undefined) {
        if (def.required) out.push(err('schema.required', at, 'campo obrigatorio ausente', def.hint));
        return;
    }
    const t = def.type;
    if (t === 'number' || t === 'int') {
        if (!isNum(value) || (t === 'int' && !isInt(value))) {
            out.push(err('schema.type', at, 'esperava ' + (t === 'int' ? 'inteiro' : 'numero')));
            return;
        }
        if (def.min !== undefined && value < def.min) out.push(err('schema.range', at, 'minimo ' + def.min));
        if (def.max !== undefined && value > def.max) out.push(err('schema.range', at, 'maximo ' + def.max));
    } else if (t === 'bool') {
        if (typeof value !== 'boolean') out.push(err('schema.type', at, 'esperava booleano'));
    } else if (t === 'string' || t === 'sprite' || t === 'script' || t === 'tilemap-tileset' || t === 'asset' || t === 'entity') {
        if (typeof value !== 'string') out.push(err('schema.type', at, 'esperava string'));
    } else if (t === 'color') {
        if (typeof value !== 'string' || (value !== '' && !COLOR_RE.test(value))) {
            out.push(err('schema.type', at, 'cor deve ser #RRGGBB (ou vazio)'));
        }
    } else if (t === 'enum') {
        if ((def.values || []).indexOf(value) < 0) {
            out.push(err('schema.enum', at, 'valor fora de ' + JSON.stringify(def.values)));
        }
    } else if (t === 'json') {
        if (value === null || typeof value !== 'object') out.push(err('schema.type', at, 'esperava objeto/array'));
    } else if (t === 'vec2') {
        if (!Array.isArray(value) || value.length !== 2 || !isNum(value[0]) || !isNum(value[1])) {
            out.push(err('schema.type', at, 'esperava [x, y]'));
        }
    }
}

function validateComponent(comp, at, out) {
    if (!isObj(comp)) { out.push(err('schema.type', at, 'componente deve ser objeto')); return; }
    const type = comp.type;
    if (!type || !COMPONENTS.components[type] || COMPONENTS.components[type].implicit) {
        out.push(err('schema.enum', at + '.type', 'componente desconhecido: ' + type,
                     'use um de: ' + Object.keys(COMPONENTS.components).filter((k) => !COMPONENTS.components[k].implicit).join(', ')));
        return;
    }
    if (comp.id !== undefined && (typeof comp.id !== 'string' || !comp.id)) {
        out.push(err('schema.type', at + '.id', 'id do componente deve ser string'));
    }
    const fields = COMPONENTS.components[type].fields;
    const values = isObj(comp.fields) ? comp.fields : {};
    for (const name in fields) checkField(values[name], fields[name], at + '.fields.' + name, out);
    if (comp.fields !== undefined && !isObj(comp.fields)) {
        out.push(err('schema.type', at + '.fields', 'fields deve ser objeto'));
    }
}

function validateTransform(tr, at, out) {
    if (!isObj(tr)) { out.push(err('schema.type', at, 'transform deve ser objeto')); return; }
    if (!isNum(tr.x) || !isNum(tr.y)) out.push(err('schema.type', at, 'transform exige x/y numericos'));
    for (const k of ['rot', 'sx', 'sy', 'ax', 'ay']) {
        if (tr[k] !== undefined && !isNum(tr[k])) out.push(err('schema.type', at + '.' + k, 'esperava numero'));
    }
}

function validateEntity(entity, at, out) {
    if (!isObj(entity)) { out.push(err('schema.type', at, 'entidade deve ser objeto')); return; }
    if (!entity.fid || typeof entity.fid !== 'string' || !/^[A-Za-z0-9_./-]{1,80}$/.test(entity.fid)) {
        out.push(err('schema.format', at + '.fid', 'fid invalido'));
    }
    if (typeof entity.name !== 'string' || !entity.name) out.push(err('schema.required', at + '.name', 'nome obrigatorio'));
    validateTransform(entity.transform, at + '.transform', out);
    if (entity.active !== undefined && typeof entity.active !== 'boolean') {
        out.push(err('schema.type', at + '.active', 'esperava booleano'));
    }
    if (entity.z !== undefined && !isNum(entity.z)) out.push(err('schema.type', at + '.z', 'esperava numero'));
    if (entity.prefab !== undefined && (typeof entity.prefab !== 'string' || !GUID_RE.test(entity.prefab))) {
        out.push(err('schema.format', at + '.prefab', 'prefab deve ser GUID de 32 hex'));
    }
    if (entity.overrides !== undefined && !isObj(entity.overrides)) {
        out.push(err('schema.type', at + '.overrides', 'overrides deve ser objeto'));
    }
    if (entity.components !== undefined) {
        if (!Array.isArray(entity.components)) out.push(err('schema.type', at + '.components', 'esperava array'));
        else entity.components.forEach((c, i) => validateComponent(c, at + '.components[' + i + ']', out));
    }
}

function validateProjectData(p, out) {
    if (!isObj(p)) { out.push(err('schema.type', 'projeto', 'projeto deve ser objeto')); return; }
    if (p.format !== 1) out.push(err('schema.format', 'format', 'formato desconhecido: ' + p.format));
    if (p.rev !== undefined && !isInt(p.rev)) out.push(err('schema.type', 'rev', 'rev deve ser inteiro'));
    for (const k of ['name', 'packageName', 'version', 'api']) {
        if (p[k] === undefined) out.push(err('schema.required', k, 'campo obrigatorio'));
    }
    for (const k of ['name', 'version', 'author', 'description', 'type', 'category', 'changelog']) {
        if (p[k] !== undefined && typeof p[k] !== 'string') {
            out.push(err('schema.type', k, 'esperava string'));
        }
    }
    if (p.topbar !== undefined && typeof p.topbar !== 'boolean') {
        out.push(err('schema.type', 'topbar', 'esperava booleano'));
    }
    if (p.permissions !== undefined &&
        (!Array.isArray(p.permissions) || p.permissions.some((x) => typeof x !== 'string'))) {
        out.push(err('schema.type', 'permissions', 'permissions deve ser array de strings'));
    }
    if (typeof p.packageName === 'string' && !PKG_RE.test(p.packageName)) {
        out.push(err('schema.format', 'packageName', 'use minusculas com ponto (ex: br.autor.jogo)'));
    }
    if (typeof p.version === 'string' && !SEMVER_RE.test(p.version)) {
        out.push(err('schema.format', 'version', 'versao deve ser x.y.z'));
    }
    if (p.api !== undefined && (!isInt(p.api) || p.api < 1 || p.api > API_CEILING)) {
        out.push(err('schema.range', 'api', 'api deve ser 1..' + API_CEILING));
    }
    if (p.requires !== undefined) {
        if (!Array.isArray(p.requires) || p.requires.some((r) => r !== 'psram')) {
            out.push(err('schema.enum', 'requires', 'unico valor aceito: "psram"'));
        }
    }
    if (p.deps !== undefined) {
        if (!isObj(p.deps)) out.push(err('schema.type', 'deps', 'deps deve ser objeto'));
        else {
            const names = Object.keys(p.deps);
            if (names.length > 8) out.push(err('schema.range', 'deps', 'maximo de 8 deps diretas (' + names.length + ')'));
            for (const n of names) {
                if (!PKG_RE.test(n)) out.push(err('schema.format', 'deps.' + n, 'nome de dep invalido'));
                if (typeof p.deps[n] !== 'string' || !RANGE_RE.test(p.deps[n])) {
                    out.push(err('schema.format', 'deps.' + n, 'range deve ser ^x.y.z ou x.y.z'));
                }
            }
        }
    }
    if (!isObj(p.canvas)) out.push(err('schema.required', 'canvas', 'canvas obrigatorio'));
    else {
        if (!isInt(p.canvas.w) || !isInt(p.canvas.h)) out.push(err('schema.type', 'canvas', 'w/h inteiros'));
        else {
            for (const k of ['w', 'h']) {
                if (p.canvas[k] < 64 || p.canvas[k] > 1024) {
                    out.push(err('schema.range', 'canvas.' + k, 'canvas deve ter 64..1024'));
                }
            }
        }
        if (p.canvas.native !== undefined && typeof p.canvas.native !== 'boolean') {
            out.push(err('schema.type', 'canvas.native', 'esperava booleano'));
        }
        if (p.canvas.fps !== undefined && (!isInt(p.canvas.fps) || p.canvas.fps < 0 || p.canvas.fps > 60)) {
            out.push(err('schema.range', 'canvas.fps', 'fps deve ser 0..60'));
        }
        if (p.canvas.inset !== undefined && (!isInt(p.canvas.inset) || p.canvas.inset < 0 || p.canvas.inset > 64)) {
            out.push(err('schema.range', 'canvas.inset', 'inset deve ser 0..64'));
        }
    }
    if (p.build !== undefined) {
        if (!isObj(p.build)) out.push(err('schema.type', 'build', 'build deve ser objeto'));
        else {
            if (p.build.out !== undefined && typeof p.build.out !== 'string') {
                out.push(err('schema.type', 'build.out', 'esperava string'));
            }
            if (p.build.splitKB !== undefined &&
                (!isInt(p.build.splitKB) || p.build.splitKB < 32 || p.build.splitKB > 255)) {
                out.push(err('schema.range', 'build.splitKB', 'splitKB deve ser 32..255'));
            }
        }
    }
    if (p.editor !== undefined) {
        if (!isObj(p.editor)) out.push(err('schema.type', 'editor', 'editor deve ser objeto'));
        else {
            for (const k of ['debug', 'prof', 'snap']) {
                if (p.editor[k] !== undefined && typeof p.editor[k] !== 'boolean') {
                    out.push(err('schema.type', 'editor.' + k, 'booleano'));
                }
            }
            if (p.editor.grid !== undefined && (!isInt(p.editor.grid) || p.editor.grid < 1)) {
                out.push(err('schema.range', 'editor.grid', 'grid deve ser inteiro >= 1'));
            }
        }
    }
    if (p.startScene !== undefined && typeof p.startScene !== 'string') {
        out.push(err('schema.type', 'startScene', 'startScene deve ser GUID ou vazio'));
    }
    if (p.runtime !== undefined && p.runtime !== 'studio' && p.runtime !== 'app' && p.runtime !== 'legacy') {
        out.push(err('schema.enum', 'runtime', 'runtime deve ser studio, app ou legacy'));
    }
    if (p.runtime === 'legacy') {
        if (!isObj(p.legacy)) out.push(err('schema.required', 'legacy', 'modo legado exige legacy.entry'));
        else {
            if (typeof p.legacy.entry !== 'string' || !p.legacy.entry) {
                out.push(err('schema.required', 'legacy.entry', 'script de entrada obrigatorio'));
            }
            if (p.legacy.bases !== undefined &&
                (!Array.isArray(p.legacy.bases) || p.legacy.bases.some((b) => typeof b !== 'string'))) {
                out.push(err('schema.type', 'legacy.bases', 'bases deve ser array de strings'));
            }
        }
    } else if (p.legacy !== undefined) {
        out.push(err('schema.enum', 'legacy', 'legacy so vale com runtime: "legacy"'));
    }
}

function validateSceneData(s, out) {
    if (!isObj(s)) { out.push(err('schema.type', 'cena', 'cena deve ser objeto')); return; }
    if (s.format !== 1) out.push(err('schema.format', 'format', 'formato desconhecido: ' + s.format));
    if (typeof s.guid !== 'string' || !GUID_RE.test(s.guid)) out.push(err('schema.format', 'guid', 'guid de 32 hex'));
    if (typeof s.name !== 'string' || !s.name) out.push(err('schema.required', 'name', 'nome obrigatorio'));
    if (s.settings !== undefined) {
        const st = s.settings;
        if (!isObj(st)) out.push(err('schema.type', 'settings', 'settings deve ser objeto'));
        else {
            if (st.bg !== undefined && (typeof st.bg !== 'string' || !COLOR_RE.test(st.bg))) {
                out.push(err('schema.type', 'settings.bg', 'cor #RRGGBB'));
            }
            if (st.fps !== undefined && (!isInt(st.fps) || st.fps < 0 || st.fps > 60)) {
                out.push(err('schema.range', 'settings.fps', 'fps deve ser 0..60'));
            }
            if (st.assets !== undefined &&
                (!Array.isArray(st.assets) || st.assets.some((x) => typeof x !== 'string'))) {
                out.push(err('schema.type', 'settings.assets', 'assets deve ser array de GUIDs/nomes'));
            }
            if (st.data !== undefined && !isObj(st.data)) {
                out.push(err('schema.type', 'settings.data', 'data deve ser objeto'));
            }
            if (st.scripts !== undefined &&
                (!Array.isArray(st.scripts) || st.scripts.some((x) => typeof x !== 'string'))) {
                out.push(err('schema.type', 'settings.scripts', 'scripts deve ser array de GUIDs'));
            }
            if (st.header !== undefined && typeof st.header !== 'boolean') {
                out.push(err('schema.type', 'settings.header', 'esperava booleano'));
            }
            if (st.sub !== undefined && typeof st.sub !== 'string') {
                out.push(err('schema.type', 'settings.sub', 'esperava string'));
            }
            if (st.persist !== undefined && typeof st.persist !== 'string') {
                out.push(err('schema.type', 'settings.persist', 'esperava string (chave de Storage)'));
            }
            if (st.camera !== undefined) {
                if (!isObj(st.camera)) out.push(err('schema.type', 'settings.camera', 'camera deve ser objeto'));
                else if (st.camera.bounds !== undefined &&
                         (!Array.isArray(st.camera.bounds) || st.camera.bounds.length !== 4 ||
                          st.camera.bounds.some((v) => !isNum(v)))) {
                    out.push(err('schema.type', 'settings.camera.bounds', 'bounds = [x,y,w,h]'));
                } else if (st.camera.deadzone !== undefined &&
                           (!Array.isArray(st.camera.deadzone) || st.camera.deadzone.length !== 2 ||
                            st.camera.deadzone.some((v) => !isNum(v)))) {
                    out.push(err('schema.type', 'settings.camera.deadzone', 'deadzone = [w,h]'));
                }
            }
        }
    }
    if (!Array.isArray(s.entities)) { out.push(err('schema.required', 'entities', 'entities deve ser array')); return; }
    const fids = new Set();
    s.entities.forEach((e, i) => {
        validateEntity(e, 'entities[' + i + ']', out);
        if (e && e.fid) {
            if (fids.has(e.fid)) out.push(err('schema.duplicate', 'entities[' + i + '].fid', 'fid repetido: ' + e.fid));
            fids.add(e.fid);
        }
    });
    if (s.tilemaps !== undefined) {
        if (!Array.isArray(s.tilemaps)) out.push(err('schema.type', 'tilemaps', 'esperava array'));
        else {
            const ids = new Set();
            s.tilemaps.forEach((tm, i) => {
                const at = 'tilemaps[' + i + ']';
                if (!isObj(tm)) { out.push(err('schema.type', at, 'tilemap deve ser objeto')); return; }
                if (!tm.id || typeof tm.id !== 'string') out.push(err('schema.required', at + '.id', 'id obrigatorio'));
                else if (ids.has(tm.id)) out.push(err('schema.duplicate', at + '.id', 'id repetido: ' + tm.id));
                else ids.add(tm.id);
                if (typeof tm.tileset !== 'string' || !tm.tileset) out.push(err('schema.required', at + '.tileset', 'tileset obrigatorio'));
                for (const k of ['cols', 'rows']) if (!isInt(tm[k]) || tm[k] < 1) out.push(err('schema.range', at + '.' + k, 'inteiro >= 1'));
                if (!isNum(tm.cell) || tm.cell < 1) out.push(err('schema.range', at + '.cell', 'cell >= 1'));
                if (!Array.isArray(tm.data)) out.push(err('schema.required', at + '.data', 'data deve ser array'));
                else if (isInt(tm.cols) && isInt(tm.rows) && tm.data.length !== tm.cols * tm.rows) {
                    out.push(err('schema.range', at + '.data', 'data tem ' + tm.data.length + ', esperava ' + (tm.cols * tm.rows)));
                }
                if (tm.solids !== undefined && !Array.isArray(tm.solids)) {
                    out.push(err('schema.type', at + '.solids', 'solids deve ser array'));
                } else if (Array.isArray(tm.solids) && isInt(tm.cols) && isInt(tm.rows) &&
                           tm.solids.length !== tm.cols * tm.rows) {
                    out.push(err('schema.range', at + '.solids',
                                 'solids tem ' + tm.solids.length + ', esperava ' + (tm.cols * tm.rows)));
                }
            });
        }
    }
}

function validatePrefabData(pf, out) {
    if (!isObj(pf)) { out.push(err('schema.type', 'prefab', 'prefab deve ser objeto')); return; }
    if (pf.format !== 1) out.push(err('schema.format', 'format', 'formato desconhecido: ' + pf.format));
    if (typeof pf.guid !== 'string' || !GUID_RE.test(pf.guid)) out.push(err('schema.format', 'guid', 'guid de 32 hex'));
    if (typeof pf.name !== 'string' || !pf.name) out.push(err('schema.required', 'name', 'nome obrigatorio'));
    if (!Array.isArray(pf.entities)) { out.push(err('schema.required', 'entities', 'entities deve ser array')); return; }
    const fids = new Set();
    pf.entities.forEach((e, i) => {
        validateEntity(e, 'entities[' + i + ']', out);
        if (e && e.fid) {
            if (fids.has(e.fid)) out.push(err('schema.duplicate', 'entities[' + i + '].fid', 'fid repetido: ' + e.fid));
            fids.add(e.fid);
        }
    });
}

function validateMetaData(m, out) {
    if (!isObj(m)) { out.push(err('schema.type', 'meta', 'meta deve ser objeto')); return; }
    if (m.format !== 1) out.push(err('schema.format', 'format', 'formato desconhecido: ' + m.format));
    if (typeof m.guid !== 'string' || !GUID_RE.test(m.guid)) out.push(err('schema.format', 'guid', 'guid de 32 hex'));
    const importers = ['sprite', 'sprite-sheet', 'tileset', 'audio', 'script', 'scene', 'prefab'];
    if (importers.indexOf(m.importer) < 0) {
        out.push(err('schema.enum', 'importer', 'importer invalido: ' + m.importer));
        return;
    }
    if (!isObj(m.settings)) { out.push(err('schema.required', 'settings', 'settings obrigatorio')); return; }
    const s = m.settings;
    if (m.importer === 'sprite' || m.importer === 'sprite-sheet' || m.importer === 'tileset') {
        const mode = s.mode || 'single';
        if (['single', 'grid', 'regions'].indexOf(mode) < 0) {
            out.push(err('schema.enum', 'settings.mode', 'mode invalido: ' + mode));
        }
        if (mode === 'grid') {
            for (const k of ['cols', 'rows', 'tw', 'th']) {
                if (!isInt(s[k]) || s[k] < 1) out.push(err('schema.range', 'settings.' + k, 'grid exige ' + k + ' >= 1'));
            }
        }
        if (mode === 'regions' && !isObj(s.regions)) {
            out.push(err('schema.type', 'settings.regions', 'regions deve ser objeto nome -> [x,y,w,h]'));
        }
        if (mode === 'regions' && isObj(s.regions)) {
            for (const name of Object.keys(s.regions)) {
                const r = s.regions[name];
                if (!Array.isArray(r) || r.length !== 4 || r.some((v) => !isNum(v)) || r[2] < 0 || r[3] < 0) {
                    out.push(err('schema.type', 'settings.regions.' + name,
                                 'regiao deve ser [x,y,w,h] com w/h >= 0'));
                }
            }
        }
        if (s.prefix !== undefined && typeof s.prefix !== 'string') {
            out.push(err('schema.type', 'settings.prefix', 'prefix deve ser string'));
        }
        if (s.pivot !== undefined && (!Array.isArray(s.pivot) || s.pivot.length !== 2 ||
                                      s.pivot.some((v) => !isNum(v)))) {
            out.push(err('schema.type', 'settings.pivot', 'pivot = [x, y]'));
        }
        if (s.key !== undefined && (typeof s.key !== 'string' || !COLOR_RE.test(s.key))) {
            out.push(err('schema.type', 'settings.key', 'key = #RRGGBB'));
        }
        // solidez por tile: um tile de lixo ({name: 5} / solid: "yes") virava
        // colisao no build (`!!t.solid`) sem acusar nada
        if (s.tiles !== undefined) {
            if (!Array.isArray(s.tiles)) {
                out.push(err('schema.type', 'settings.tiles', 'tiles deve ser array'));
            } else {
                s.tiles.forEach((t, i) => {
                    if (!isObj(t) || typeof t.name !== 'string' ||
                        (t.solid !== undefined && typeof t.solid !== 'boolean')) {
                        out.push(err('schema.type', 'settings.tiles[' + i + ']',
                                     'tile deve ser {name: string, solid?: booleano}'));
                    }
                });
            }
        }
        if (s.anims !== undefined) {
            if (!isObj(s.anims)) out.push(err('schema.type', 'settings.anims', 'anims deve ser objeto clipe -> lista'));
            else {
                for (const clip of Object.keys(s.anims)) {
                    const list = s.anims[clip];
                    if (!Array.isArray(list)) {
                        out.push(err('schema.type', 'settings.anims.' + clip, 'lista de indices/nomes'));
                    } else {
                        for (let i = 0; i < list.length; i++) {
                            const it = list[i];
                            if (!isInt(it) && typeof it !== 'string') {
                                out.push(err('schema.type', 'settings.anims.' + clip + '[' + i + ']',
                                             'indice inteiro ou nome de regiao'));
                            }
                        }
                    }
                }
            }
        }
        if (s.fps !== undefined) {
            if (!isObj(s.fps)) out.push(err('schema.type', 'settings.fps', 'fps deve ser objeto clipe -> numero'));
            else for (const clip of Object.keys(s.fps)) {
                if (!isNum(s.fps[clip]) || s.fps[clip] <= 0) {
                    out.push(err('schema.range', 'settings.fps.' + clip, 'fps > 0'));
                }
            }
        }
        if (s.loop !== undefined) {
            if (!isObj(s.loop)) out.push(err('schema.type', 'settings.loop', 'loop deve ser objeto clipe -> booleano'));
            else for (const clip of Object.keys(s.loop)) {
                if (typeof s.loop[clip] !== 'boolean') {
                    out.push(err('schema.type', 'settings.loop.' + clip, 'booleano'));
                }
            }
        }
        if (s.hitbox !== undefined) {
            if (!Array.isArray(s.hitbox) || s.hitbox.length !== 4 ||
                s.hitbox.some((v) => !isNum(v)) || s.hitbox[2] <= 0 || s.hitbox[3] <= 0) {
                out.push(err('schema.type', 'settings.hitbox', 'hitbox = [x, y, w, h] com w/h > 0'));
            }
        }
    }
    if (m.importer === 'audio') {
        if (s.loop !== undefined && typeof s.loop !== 'boolean') out.push(err('schema.type', 'settings.loop', 'loop booleano'));
        if (s.gain !== undefined && !isNum(s.gain)) out.push(err('schema.type', 'settings.gain', 'gain numerico'));
    }
    if (m.importer === 'script' && s.props !== undefined && !isObj(s.props)) {
        out.push(err('schema.type', 'settings.props', 'props deve ser objeto'));
    }
}

function defaultsFor(type) {
    const cat = COMPONENTS.components[type];
    if (!cat) return null;
    const fields = {};
    for (const name in cat.fields) {
        const def = cat.fields[name];
        if (def.default !== undefined) fields[name] = JSON.parse(JSON.stringify(def.default));
    }
    return { type, fields };
}

function componentCatalog() {
    return COMPONENTS.components;
}

function schemaDoc(name) {
    return {
        project: PROJECT_SCHEMA,
        scene: SCENE_SCHEMA,
        prefab: PREFAB_SCHEMA,
        meta: META_SCHEMA,
        components: COMPONENTS,
    }[name] || null;
}

module.exports = {
    SCHEMA_DIR, COMPONENTS, PROJECT_SCHEMA, SCENE_SCHEMA, PREFAB_SCHEMA, META_SCHEMA,
    PKG_RE, SEMVER_RE, RANGE_RE, GUID_RE, COLOR_RE,
    validateProjectData, validateSceneData, validatePrefabData, validateMetaData,
    validateComponent, validateEntity, validateTransform,
    defaultsFor, componentCatalog, schemaDoc, isObj, isNum, isInt, err,
};
