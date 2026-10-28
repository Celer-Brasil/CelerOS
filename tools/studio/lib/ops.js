'use strict';
// Barramento de comandos do Studio. GUI, CLI e API HTTP executam as MESMAS
// ops, com validacao estrutural e undo. Toda gravacao e canonica; um lote e
// atomico (erro = nada muda).

const fs = require('fs');
const path = require('path');
const F = require('./format');
const SC = require('./schema');
const { Project } = require('./project');
const A = require('./assets');

const MAX_UNDO = 50;

// ---------------------------------------------------------------- snapshot --

function textFiles(project) {
    const out = ['celergame.project.json'];
    const walk = (dir) => {
        let names;
        try { names = fs.readdirSync(dir).sort(); } catch (e) { return; }
        for (const name of names) {
            const abs = path.join(dir, name);
            let st;
            try { st = fs.statSync(abs); } catch (e) { continue; }
            if (st.isDirectory()) { walk(abs); continue; }
            const rel = F.relPosix(project.dir, abs);
            if (/\.(json|meta|js)$/i.test(name)) out.push(rel);
        }
    };
    if (fs.existsSync(project.assetsDir)) walk(project.assetsDir);
    return out;
}

function takeSnapshot(project, kind, id, rels) {
    const dir = path.join(project.studioDir, kind, id);
    const filesDir = path.join(dir, 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    const uniq = Array.from(new Set(rels || [])).sort();
    const entries = [];
    let i = 0;
    for (const rel of uniq) {
        const abs = project.resolveInside(rel);
        const existed = fs.existsSync(abs);
        let snap = null;
        if (existed) {
            snap = String(i++).padStart(4, '0');
            fs.copyFileSync(abs, path.join(filesDir, snap));
        }
        entries.push({ rel, existed, snap });
    }
    const manifest = { format: 1, kind, id, ts: Date.now(), entries };
    F.writeJson(path.join(dir, 'manifest.json'), manifest);
    prune(project, kind);
    return { id, dir, manifest };
}

function prune(project, kind) {
    const root = path.join(project.studioDir, kind);
    let names;
    try { names = fs.readdirSync(root).sort(); } catch (e) { return; }
    while (names.length > MAX_UNDO) {
        const old = names.shift();
        try { fs.rmSync(path.join(root, old), { recursive: true, force: true }); } catch (e) {}
    }
}

function restoreSnapshot(project, snap) {
    const filesDir = path.join(snap.dir, 'files');
    const entriesRel = new Set(snap.manifest.entries.map((e) => e.rel));
    for (const e of snap.manifest.entries) {
        const abs = project.resolveInside(e.rel);
        if (e.existed) {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.copyFileSync(path.join(filesDir, e.snap), abs);
        } else if (fs.existsSync(abs)) {
            fs.rmSync(abs, { force: true });
        }
    }
    // arquivos criados pela op e que nao estavam no snapshot (import/rename)
    for (const rel of snap.manifest.created || []) {
        if (entriesRel.has(rel)) continue;
        const abs = project.resolveInside(rel);
        if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
    }
}

// arquivos tocados por um snapshot: os existentes antes + os criados pelo lote
function snapshotRels(manifest) {
    return manifest.entries.map((e) => e.rel).concat(manifest.created || []);
}

function undo(project) {
    const root = path.join(project.studioDir, 'undo');
    let names;
    try { names = fs.readdirSync(root).sort(); } catch (e) { names = []; }
    // manifest truncado/corrompido (crash antigo) nao pode brickar a pilha:
    // descarta o snapshot ruim e tenta o anterior
    let id = null;
    let dir = null;
    let manifest = null;
    while (names.length) {
        id = names.pop();
        dir = path.join(root, id);
        try { manifest = F.readJson(path.join(dir, 'manifest.json')); break; }
        catch (e) {
            manifest = null;
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) {}
        }
    }
    if (!manifest) F.fail('undo.empty', 'nada para desfazer');
    const snap = { id, dir, manifest };
    // snapshot do estado ATUAL vira o redo (inclui arquivos criados pelo lote)
    const redoId = 'r' + Date.now() + '_' + F.newGuid().slice(0, 6);
    takeSnapshot(project, 'redo', redoId, snapshotRels(manifest));
    restoreSnapshot(project, snap);
    fs.rmSync(dir, { recursive: true, force: true });
    project.load();
    return { ok: true, undo: id, redo: redoId, changed: snapshotRels(manifest) };
}

function redo(project) {
    const root = path.join(project.studioDir, 'redo');
    let names;
    try { names = fs.readdirSync(root).sort(); } catch (e) { names = []; }
    let id = null;
    let dir = null;
    let manifest = null;
    while (names.length) {
        id = names.pop();
        dir = path.join(root, id);
        try { manifest = F.readJson(path.join(dir, 'manifest.json')); break; }
        catch (e) {
            manifest = null;
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) {}
        }
    }
    if (!manifest) F.fail('redo.empty', 'nada para refazer');
    const undoId = 'u' + Date.now() + '_' + F.newGuid().slice(0, 6);
    takeSnapshot(project, 'undo', undoId, snapshotRels(manifest));
    restoreSnapshot(project, { id, dir, manifest });
    fs.rmSync(dir, { recursive: true, force: true });
    project.load();
    return { ok: true, redo: id, undo: undoId, changed: snapshotRels(manifest) };
}

// ------------------------------------------------------------------ helpers --

function container(project, op) {
    if (op.prefab) {
        const pf = project.prefab(op.prefab);
        if (!pf) F.fail('ref.prefab', 'prefab inexistente: ' + op.prefab);
        return { kind: 'prefab', obj: pf };
    }
    const sc = project.scene(op.scene);
    if (!sc) F.fail('ref.scene', 'cena inexistente: ' + (op.scene || '(vazia)'));
    return { kind: 'scene', obj: sc };
}

function entityOf(obj, ref) {
    if (ref === undefined || ref === null) F.fail('ref.entity', 'informe a entidade (fid)');
    const list = obj.entities || [];
    for (const e of list) if (e.fid === ref) return e;
    if (typeof ref === 'string') {
        const byName = list.filter((e) => e.name === ref);
        if (byName.length === 1) return byName[0];
    }
    F.fail('ref.entity', 'entidade inexistente: ' + ref);
}

function componentOf(entity, ref) {
    const list = entity.components || [];
    if (typeof ref === 'number') {
        if (ref < 0 || ref >= list.length) F.fail('ref.component', 'indice fora da lista: ' + ref);
        return list[ref];
    }
    for (const c of list) if (c.id === ref) return c;
    const byType = list.filter((c) => c.type === ref);
    if (byType.length === 1) return byType[0];
    F.fail('ref.component', 'componente inexistente: ' + ref);
}

// nome de campo fora do catalogo: o build ignoraria em silencio, entao a op
// falha (typo em `sprte` nao pode "passar")
function assertFields(type, fields, at) {
    const cat = SC.componentCatalog()[type];
    if (!cat || !fields || typeof fields !== 'object' || Array.isArray(fields)) return;
    for (const k of Object.keys(fields)) {
        if (!cat.fields[k]) {
            F.fail('op.field', 'campo desconhecido em ' + type + ': ' + k,
                   { hint: 'campos: ' + Object.keys(cat.fields).join(', ') });
        }
    }
}

function defaultTransform(op) {
    const t = op && op.transform ? op.transform : {};
    const out = {
        x: F.round(t.x !== undefined ? t.x : (op && op.x !== undefined ? op.x : 0)),
        y: F.round(t.y !== undefined ? t.y : (op && op.y !== undefined ? op.y : 0)),
        rot: F.round(t.rot || 0),
        sx: F.round(t.sx !== undefined ? t.sx : 1),
        sy: F.round(t.sy !== undefined ? t.sy : 1),
    };
    // ax/ay ausentes = herda o pivot do sprite (E.spr.meta)
    if (t.ax !== undefined) out.ax = F.round(t.ax);
    if (t.ay !== undefined) out.ay = F.round(t.ay);
    return out;
}

function mergeTransform(entity, patch) {
    entity.transform = entity.transform || defaultTransform();
    for (const k of ['x', 'y', 'rot', 'sx', 'sy', 'ax', 'ay']) {
        if (patch[k] !== undefined) entity.transform[k] = F.round(patch[k]);
    }
}

// chaves que o [[Set]] de JS trata como prototipo: um op vindo de JSON
// ("__proto__" vira propriedade propria no JSON.parse) nao pode poluir
// Object.prototype do processo inteiro (GUI/CLI/HTTP no mesmo processo)
function unsafeKey(k) {
    return k === '__proto__' || k === 'constructor' || k === 'prototype';
}

function deepMerge(dst, src) {
    // campos de op chegando com tipo errado (string/null) nao podem virar
    // chaves numericas nem sobrescrever o formato
    if (!src || typeof src !== 'object' || Array.isArray(src)) return dst;
    for (const k in src) {
        if (!Object.prototype.hasOwnProperty.call(src, k) || unsafeKey(k)) continue;
        if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
            if (!dst[k] || typeof dst[k] !== 'object' || Array.isArray(dst[k])) dst[k] = {};
            deepMerge(dst[k], src[k]);
        } else dst[k] = src[k];
    }
    return dst;
}

function uniqueEntityName(obj, base) {
    const used = new Set((obj.entities || []).map((e) => (e.name || '').toLowerCase()));
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) { name = base + ' ' + n; n++; }
    return name;
}

// coordenadas de grade: "abc"/undefined viravam 0 pelo |0 e pintavam a
// celula errada em silencio
function intArg(v, name) {
    if (typeof v !== 'number' || !isFinite(v)) F.fail('op.args', name + ' deve ser numero');
    return v | 0;
}

// -------------------------------------------------------------------- ops ----

const OPS = {
    'project.set': function (project, op) {
        const data = project.data;
        for (const k of ['name', 'packageName', 'version', 'author', 'description', 'type',
                         'category', 'api', 'requires', 'topbar', 'permissions', 'changelog',
                         'startScene', 'runtime']) {
            if (op[k] !== undefined) data[k] = op[k];
        }
        if (op.legacy !== undefined) {
            // null remove o bloco: sem isso nao ha como voltar runtime studio
            if (op.legacy === null) delete data.legacy;
            else data.legacy = F.deepClone(op.legacy);
        }
        for (const k of ['canvas', 'build', 'editor']) {
            if (op[k] !== undefined) {
                data[k] = data[k] || {};
                deepMerge(data[k], op[k]);
            }
        }
        if (op.deps !== undefined) data.deps = op.deps;
        project.markDirty('celergame.project.json');
    },

    'scene.create': function (project, op) {
        if (!op.name) F.fail('op.args', 'scene.create exige name');
        project.createScene(op.name);
    },

    'scene.delete': function (project, op) {
        const sc = project.scene(op.scene);
        if (!sc) F.fail('ref.scene', 'cena inexistente: ' + op.scene);
        project.deleteScene(sc);
    },

    'scene.rename': function (project, op) {
        const sc = project.scene(op.scene);
        if (!sc) F.fail('ref.scene', 'cena inexistente: ' + op.scene);
        if (!op.name) F.fail('op.args', 'scene.rename exige name');
        if (project.sceneNameTaken(op.name, sc.guid)) {
            F.fail('schema.duplicate', 'ja existe uma cena chamada ' + op.name);
        }
        sc.name = op.name;
        project.writeScene(sc);
        project.markDirty('celergame.project.json');
    },

    'scene.set': function (project, op) {
        const sc = project.scene(op.scene);
        if (!sc) F.fail('ref.scene', 'cena inexistente: ' + op.scene);
        if (op.name !== undefined) {
            if (!op.name || typeof op.name !== 'string') F.fail('op.args', 'scene.set: name deve ser string');
            // mesmo check do scene.rename: sem isso o lote grava duas cenas
            // com o mesmo nome e o build falha depois (E.goto ambiguo)
            if (project.sceneNameTaken(op.name, sc.guid)) {
                F.fail('schema.duplicate', 'ja existe uma cena chamada ' + op.name);
            }
            sc.name = op.name;
        }
        if (op.settings) {
            sc.settings = sc.settings || {};
            // replace: chaves que devem ser SUBSTITUIDAS (JSON de dados da
            // cena/assets), nao mescladas com o valor anterior
            if (Array.isArray(op.replace)) {
                for (const k of op.replace) delete sc.settings[k];
            }
            deepMerge(sc.settings, op.settings);
        }
        project.writeScene(sc);
    },

    'scene.start': function (project, op) {
        const sc = project.scene(op.scene);
        if (!sc) F.fail('ref.scene', 'cena inexistente: ' + op.scene);
        project.data.startScene = sc.guid;
        project.markDirty('celergame.project.json');
    },

    'entity.create': function (project, op) {
        const { obj, kind } = container(project, op);
        const fid = op.fid || F.newFid('e');
        if ((obj.entities || []).some((e) => e.fid === fid)) F.fail('schema.duplicate', 'fid ja existe: ' + fid);
        const e = {
            fid,
            name: op.name || uniqueEntityName(obj, 'Entidade'),
            active: op.active === undefined ? true : !!op.active,
            z: F.round(op.z || 0),
            transform: defaultTransform(op),
            components: [],
        };
        if (op.prefab) {
            const pf = project.prefab(op.prefab);
            if (!pf) F.fail('ref.prefab', 'prefab inexistente: ' + op.prefab);
            e.prefab = pf.guid;
            e.overrides = {};
        } else if (Array.isArray(op.components)) {
            e.components = F.deepClone(op.components);
            for (const c of e.components) {
                if (c && c.type) assertFields(c.type, c.fields, 'entity.create');
            }
        }
        obj.entities = obj.entities || [];
        obj.entities.push(e);
        if (kind === 'scene') project.writeScene(obj); else project.writePrefab(obj);
        return { entity: e };
    },

    'entity.set': function (project, op) {
        const { obj, kind } = container(project, op);
        const e = entityOf(obj, op.entity);
        if (op.name !== undefined) e.name = op.name;
        if (op.active !== undefined) e.active = !!op.active;
        if (op.z !== undefined) e.z = F.round(op.z);
        if (op.transform) mergeTransform(e, op.transform);
        if (op.overrides !== undefined) e.overrides = F.deepClone(op.overrides);
        if (kind === 'scene') project.writeScene(obj); else project.writePrefab(obj);
        return { entity: e };
    },

    'entity.delete': function (project, op) {
        const { obj, kind } = container(project, op);
        const e = entityOf(obj, op.entity);
        obj.entities = obj.entities.filter((x) => x !== e);
        if (kind === 'scene') project.writeScene(obj); else project.writePrefab(obj);
    },

    'entity.duplicate': function (project, op) {
        const { obj, kind } = container(project, op);
        const src = entityOf(obj, op.entity);
        const e = F.deepClone(src);
        e.fid = F.newFid('e');
        e.name = uniqueEntityName(obj, op.name || (src.name + ' copia'));
        obj.entities.push(e);
        if (kind === 'scene') project.writeScene(obj); else project.writePrefab(obj);
        return { entity: e };
    },

    'component.add': function (project, op) {
        const { obj, kind } = container(project, op);
        const e = entityOf(obj, op.entity);
        const base = SC.defaultsFor(op.type);
        if (!base) F.fail('op.type', 'componente desconhecido: ' + op.type,
                         { hint: 'veja `studio describe` para o catalogo' });
        if (op.fields !== undefined && (!op.fields || typeof op.fields !== 'object' ||
                                        Array.isArray(op.fields))) {
            F.fail('op.args', 'component.add: fields deve ser objeto');
        }
        assertFields(op.type, op.fields, 'component.add');
        const comp = { id: op.id || ('c_' + F.newGuid().slice(0, 8)), type: op.type, fields: base.fields };
        if (op.fields) deepMerge(comp.fields, op.fields);
        e.components = e.components || [];
        e.components.push(comp);
        if (kind === 'scene') project.writeScene(obj); else project.writePrefab(obj);
        return { component: comp };
    },

    'component.set': function (project, op) {
        const { obj, kind } = container(project, op);
        const e = entityOf(obj, op.entity);
        const c = componentOf(e, op.component);
        if (op.fields !== undefined && (!op.fields || typeof op.fields !== 'object' ||
                                        Array.isArray(op.fields))) {
            F.fail('op.args', 'component.set: fields deve ser objeto');
        }
        if (op.fields) {
            assertFields(c.type, op.fields, 'component.set');
            c.fields = c.fields || {};
            deepMerge(c.fields, op.fields);
        }
        if (op.field !== undefined) {
            const rawField = String(op.field);
            // "fields.<chave>" num componente com objeto fields (script com
            // exports.props): escreve DENTRO de c.fields.fields (o lugar que
            // o build/validate leiam). Cada op parte do snapshot atual, entao
            // o inspetor pode mandar uma tecla por op sem perder as outras.
            if (rawField.indexOf('fields.') === 0 && rawField.length > 'fields.'.length) {
                const key = rawField.slice('fields.'.length);
                if (unsafeKey(key)) F.fail('op.field', 'campo nao permitido: ' + key);
                const catF = SC.componentCatalog()[c.type];
                if (!catF || !catF.fields.fields) {
                    F.fail('op.field', c.type + ' nao tem objeto fields',
                           { hint: 'campos: ' + (catF ? Object.keys(catF.fields).join(', ') : '?') });
                }
                c.fields = c.fields || {};
                c.fields.fields = c.fields.fields || {};
                if (op.value === null) delete c.fields.fields[key];
                else c.fields.fields[key] = op.value;
            } else {
                const field = rawField;
                if (!field) F.fail('op.args', 'component.set exige field');
                if (unsafeKey(field)) F.fail('op.field', 'campo nao permitido: ' + field);
                const cat = SC.componentCatalog()[c.type];
                if (cat && !cat.fields[field]) {
                    F.fail('op.field', 'campo desconhecido em ' + c.type + ': ' + field,
                           { hint: 'campos: ' + Object.keys(cat.fields).join(', ') });
                }
                c.fields = c.fields || {};
                if (op.value === null) delete c.fields[field];
                else c.fields[field] = op.value;
            }
        }
        if (kind === 'scene') project.writeScene(obj); else project.writePrefab(obj);
        return { component: c };
    },

    'component.remove': function (project, op) {
        const { obj, kind } = container(project, op);
        const e = entityOf(obj, op.entity);
        const c = componentOf(e, op.component);
        e.components = (e.components || []).filter((x) => x !== c);
        if (kind === 'scene') project.writeScene(obj); else project.writePrefab(obj);
    },

    'prefab.create': function (project, op) {
        if (!op.name) F.fail('op.args', 'prefab.create exige name');
        const pf = project.createPrefab(op.name);
        if (op.scene && op.entity) {
            const sc = project.scene(op.scene);
            if (!sc) { project.deletePrefab(pf); F.fail('ref.scene', 'cena inexistente: ' + op.scene); }
            const e = F.deepClone(entityOf(sc, op.entity));
            e.fid = F.newFid('e');
            e.name = pf.name;
            e.z = 0;   // z local: a instancia soma o proprio z
            if (e.transform) { e.transform.x = 0; e.transform.y = 0; }
            delete e.prefab;
            delete e.overrides;
            pf.entities.push(e);
            project.writePrefab(pf);
        }
        return { prefab: pf };
    },

    'prefab.instance': function (project, op) {
        // `prefab` aqui e o prefab a instanciar (nao o container): a
        // instancia nasce SEMPRE numa cena
        const sc = project.scene(op.scene);
        if (!sc) F.fail('ref.scene', 'cena inexistente: ' + (op.scene || '(vazia)'));
        const pf = project.prefab(op.prefab);
        if (!pf) F.fail('ref.prefab', 'prefab inexistente: ' + op.prefab);
        const fid = op.fid || F.newFid('e');
        if ((sc.entities || []).some((e) => e.fid === fid)) {
            F.fail('schema.duplicate', 'fid ja existe: ' + fid);
        }
        const e = {
            fid: fid,
            name: op.name || uniqueEntityName(sc, pf.name),
            active: true,
            z: F.round(op.z || 0),
            transform: defaultTransform(op),
            prefab: pf.guid,
            overrides: {},
        };
        sc.entities = sc.entities || [];
        sc.entities.push(e);
        project.writeScene(sc);
        return { entity: e };
    },

    'prefab.override': function (project, op) {
        const sc = project.scene(op.scene);
        if (!sc) F.fail('ref.scene', 'cena inexistente: ' + op.scene);
        const inst = entityOf(sc, op.entity);
        if (!inst.prefab) F.fail('ref.prefab', 'entidade nao e instancia de prefab: ' + inst.fid);
        const pf = project.prefab(inst.prefab);
        const target = op.target || (pf && pf.entities && pf.entities[0] && pf.entities[0].fid);
        if (!target) F.fail('ref.override', 'prefab sem entidade para receber override');
        if (pf && !(pf.entities || []).some((e) => e.fid === target)) {
            F.fail('ref.override', 'entidade nao existe no prefab: ' + target);
        }
        inst.overrides = inst.overrides || {};
        const ov = inst.overrides[target] || {};
        // Object.assign aqui deixava "__proto__" do op virar prototipo e
        // gravava transform sem round/validacao de chave
        if (op.transform) {
            ov.transform = ov.transform || {};
            mergeTransform({ transform: ov.transform }, op.transform);
        }
        if (op.active !== undefined) ov.active = !!op.active;
        if (op.name !== undefined) ov.name = op.name;
        if (op.component && op.fields) {
            const te = pf ? (pf.entities || []).find((e) => e.fid === target) : null;
            const tc = te ? (te.components || []).find((c) => c.id === op.component) : null;
            if (!tc) F.fail('ref.override', 'componente nao existe no prefab: ' + op.component);
            const cat = SC.componentCatalog()[tc.type];
            for (const k of Object.keys(op.fields)) {
                if (unsafeKey(k)) F.fail('op.field', 'campo nao permitido: ' + k);
                if (cat && !cat.fields[k]) {
                    F.fail('op.field', 'campo desconhecido em ' + tc.type + ': ' + k,
                           { hint: 'campos: ' + Object.keys(cat.fields).join(', ') });
                }
            }
            ov.components = ov.components || {};
            const c = ov.components[op.component] || {};
            deepMerge(c, op.fields);
            ov.components[op.component] = c;
        }
        inst.overrides[target] = ov;
        project.writeScene(sc);
        return { overrides: inst.overrides };
    },

    'asset.import': function (project, op, ctx) {
        if (!op.src) F.fail('op.args', 'asset.import exige src');
        const r = A.importAsset(project, path.resolve(op.src), op);
        for (const abs of r.created) ctx.created.push(abs);
        return { asset: { guid: r.asset.guid, name: r.asset.name, path: r.asset.relPath } };
    },

    'asset.set': function (project, op) {
        const asset = project.asset(op.asset);
        if (!asset) F.fail('ref.asset', 'asset inexistente: ' + op.asset);
        A.setAssetSettings(project, asset, op.settings || {});
        return { asset: { guid: asset.guid, name: asset.name } };
    },

    'asset.delete': function (project, op, ctx) {
        const asset = project.asset(op.asset);
        if (!asset) F.fail('ref.asset', 'asset inexistente: ' + op.asset);
        if (!op.force && referenced(project, asset.guid)) {
            F.fail('asset.inuse', 'asset em uso por cena/prefab: ' + asset.name,
                   { hint: 'remova as referencias ou use force' });
        }
        ctx.snapshotRels.push(asset.relPath);
        ctx.changedFiles.push(asset.relPath);
        if (op.force) {
            const resolve = (ref) => project.asset(ref);
            for (const sc of project.sceneByGuid.values()) {
                if (asset.scene && sc.guid === asset.guid) continue;
                if (stripRefs(sc, asset.guid, resolve)) project.writeScene(sc);
            }
            for (const pf of project.prefabByGuid.values()) {
                if (asset.prefab && pf.guid === asset.guid) continue;
                if (stripRefs(pf, asset.guid, resolve)) project.writePrefab(pf);
            }
        }
        if (asset.scene) {
            project.deleteScene(asset.scene);
        } else if (asset.prefab) {
            project.deletePrefab(asset.prefab);
        } else {
            fs.rmSync(asset.absPath, { force: true });
            fs.rmSync(path.join(project.dir, asset.metaPath), { force: true });
            project.assets = project.assets.filter((a) => a.guid !== asset.guid);
            project.byGuid.delete(asset.guid);
            if (project.byName.get(asset.name) === asset) project.byName.delete(asset.name);
            project.files.delete(asset.relPath);
            project.files.delete(asset.metaPath);
            project.dirty.delete(asset.relPath);
            project.dirty.delete(asset.metaPath);
        }
    },

    'asset.rename': function (project, op, ctx) {
        const asset = project.asset(op.asset);
        if (!asset) F.fail('ref.asset', 'asset inexistente: ' + op.asset);
        if (!op.name) F.fail('op.args', 'asset.rename exige name');
        const dirRel = path.posix.dirname(asset.relPath);
        // cena/prefab carregam o sufixo no nome do arquivo (o scan depende
        // dele); usar so `.json` perdia o tipo do arquivo
        const ext = asset.kind === 'scene' ? '.scene.json'
            : (asset.kind === 'prefab' ? '.prefab.json' : asset.ext);
        for (const other of project.assets) {
            if (other.guid !== asset.guid &&
                String(other.name).toLowerCase() === String(op.name).toLowerCase()) {
                F.fail('schema.duplicate', 'ja existe um asset chamado ' + op.name);
            }
        }
        const base = F.sanitizeFileName(op.name + ext);
        let target = dirRel + '/' + base;
        let n = 2;
        while (project.files.has(target) || project.files.has(target + '.meta') ||
               fs.existsSync(project.resolveInside(target))) {
            target = dirRel + '/' + F.sanitizeFileName(op.name + '_' + n + ext);
            n++;
        }
        ctx.snapshotRels.push(asset.relPath);
        ctx.changedFiles.push(asset.relPath, target);
        ctx.created.push(project.resolveInside(target), project.resolveInside(target + '.meta'));
        fs.renameSync(asset.absPath, project.resolveInside(target));
        fs.renameSync(path.join(project.dir, asset.metaPath), project.resolveInside(target + '.meta'));
        project.files.delete(asset.relPath);
        project.files.delete(asset.metaPath);
        if (asset.scene || asset.prefab) project.files.set(target, asset.scene || asset.prefab);
        project.files.set(target + '.meta', asset.meta);
        project.dirty.delete(asset.relPath);
        project.dirty.delete(asset.metaPath);
        if (asset.scene) project.markDirty(target);
        if (asset.prefab) project.markDirty(target);
        project.markDirty(target + '.meta');
        const oldName = asset.name;
        asset.relPath = target;
        asset.absPath = project.resolveInside(target);
        asset.metaPath = target + '.meta';
        asset.fileName = path.posix.basename(target);
        asset.ext = ext;
        asset.name = path.posix.basename(target, ext);
        if (project.byName.get(oldName) === asset) project.byName.delete(oldName);
        project.byName.set(asset.name, asset);
        return { asset: { guid: asset.guid, name: asset.name, path: asset.relPath } };
    },

    'script.set': function (project, op, ctx) {
        if (op.content !== undefined && typeof op.content !== 'string') {
            F.fail('op.args', 'script.set: content deve ser string');
        }
        if (op.script) {
            const asset = project.asset(op.script);
            if (!asset || asset.kind !== 'script') F.fail('ref.script', 'script inexistente: ' + op.script);
            if (typeof op.content !== 'string') F.fail('op.args', 'script.set exige content');
            // gravacao atomica: um crash no meio do write truncaria o script
            F.writeText(asset.absPath, op.content);
            ctx.changedFiles.push(asset.relPath);
            // props tipados: re-extrai exports.props do conteudo novo (o
            // inspetor le do .meta; um literal quebrado so zera os props)
            const got = require('./scripts').propsOfSource(op.content);
            asset.meta.settings = asset.meta.settings || {};
            asset.meta.settings.props = got.props;
            project.writeMeta(asset);
            const out = { asset: { guid: asset.guid, name: asset.name, path: asset.relPath } };
            if (got.error) out.warning = { code: 'script.props', message: got.error };
            return out;
        }
        if (op.name !== undefined) {
            const r = A.createScript(project, op.name, op.content);
            for (const abs of r.created) ctx.created.push(abs);
            ctx.changedFiles.push(r.asset.relPath);
            return { asset: { guid: r.asset.guid, name: r.asset.name, path: r.asset.relPath } };
        }
        F.fail('op.args', 'script.set exige script (guid) ou name');
    },

    'tilemap.add': function (project, op) {
        const sc = project.scene(op.scene);
        if (!sc) F.fail('ref.scene', 'cena inexistente: ' + op.scene);
        const asset = project.asset(op.tileset);
        if (!asset || !['tileset', 'sprite-sheet'].includes(asset.kind)) {
            F.fail('ref.tileset', 'tileset inexistente (use um asset tileset/sprite-sheet): ' + op.tileset);
        }
        const cols = op.cols | 0, rows = op.rows | 0;
        if (cols < 1 || rows < 1) F.fail('op.args', 'tilemap.add exige cols/rows >= 1');
        const cell = op.cell !== undefined ? +op.cell : 16;
        if (!(cell > 0)) F.fail('op.args', 'cell deve ser > 0');
        const data = Array.isArray(op.data) ? op.data.slice() : new Array(cols * rows).fill(0);
        if (data.length !== cols * rows) F.fail('op.args', 'data deve ter cols*rows valores');
        const solids = Array.isArray(op.solids) ? op.solids.slice() : new Array(cols * rows).fill(false);
        const tm = {
            id: op.id || ('tm_' + F.newGuid().slice(0, 8)),
            tileset: asset.guid,
            cols: cols,
            rows: rows,
            cell: F.round(cell),
            ox: F.round(op.ox || 0),
            oy: F.round(op.oy || 0),
            layer: op.layer | 0,
            data: data,
            solids: solids,
        };
        if (op.autotile) tm.autotile = F.deepClone(op.autotile);
        sc.tilemaps = sc.tilemaps || [];
        sc.tilemaps.push(tm);
        project.writeScene(sc);
        return { tilemap: tm };
    },

    'tilemap.set': function (project, op) {
        const sc = project.scene(op.scene);
        if (!sc) F.fail('ref.scene', 'cena inexistente: ' + op.scene);
        const tm = (sc.tilemaps || []).find((t) => t.id === op.tilemap);
        if (!tm) F.fail('ref.tilemap', 'tilemap inexistente: ' + op.tilemap);
        const oldCols = tm.cols, oldRows = tm.rows;
        const oldData = tm.data, oldSolids = tm.solids;
        for (const k of ['cols', 'rows', 'cell', 'ox', 'oy', 'layer', 'data', 'solids', 'autotile']) {
            if (op[k] !== undefined) tm[k] = F.deepClone(op[k]);
        }
        if (op.tileset) {
            const asset = project.asset(op.tileset);
            if (!asset) F.fail('ref.tileset', 'tileset inexistente: ' + op.tileset);
            tm.tileset = asset.guid;
        }
        // mudar cols/rows pelo inspetor redimensiona preservando o canto
        // superior esquerdo; celulas novas nascem vazias (-1)
        const resized = tm.cols !== oldCols || tm.rows !== oldRows;
        if (resized && op.data === undefined && Array.isArray(oldData)) {
            const nd = [];
            for (let r = 0; r < tm.rows; r++) {
                for (let c = 0; c < tm.cols; c++) {
                    nd.push(r < oldRows && c < oldCols ? oldData[r * oldCols + c] : -1);
                }
            }
            tm.data = nd;
        }
        if (resized && op.solids === undefined && Array.isArray(oldSolids)) {
            const ns = [];
            for (let r = 0; r < tm.rows; r++) {
                for (let c = 0; c < tm.cols; c++) {
                    ns.push(r < oldRows && c < oldCols ? !!oldSolids[r * oldCols + c] : false);
                }
            }
            tm.solids = ns;
        }
        if (tm.data && tm.cols && tm.rows && tm.data.length !== tm.cols * tm.rows) {
            F.fail('schema.range', 'data tem ' + tm.data.length + ', esperava ' + (tm.cols * tm.rows));
        }
        project.writeScene(sc);
        return { tilemap: tm };
    },

    'tilemap.paint': function (project, op) {
        const sc = project.scene(op.scene);
        if (!sc) F.fail('ref.scene', 'cena inexistente: ' + op.scene);
        const tm = (sc.tilemaps || []).find((t) => t.id === op.tilemap);
        if (!tm) F.fail('ref.tilemap', 'tilemap inexistente: ' + op.tilemap);
        const c = intArg(op.c, 'c'), r = intArg(op.r, 'r');
        if (c < 0 || r < 0 || c >= tm.cols || r >= tm.rows) F.fail('schema.range', 'celula fora da grade');
        // value/solid de lixo ("abc" virava 0 pelo |0 e pintava o tile 0)
        if (op.value !== undefined && (typeof op.value !== 'number' || !isFinite(op.value))) {
            F.fail('op.args', 'tilemap.paint: value deve ser numero');
        }
        const i = r * tm.cols + c;
        if (op.value !== undefined) tm.data[i] = op.value | 0;
        if (op.solid !== undefined) {
            tm.solids = tm.solids || new Array(tm.cols * tm.rows).fill(false);
            tm.solids[i] = !!op.solid;
        }
        project.writeScene(sc);
        return { c, r, value: tm.data[i] };
    },

    'tilemap.fill': function (project, op) {
        const sc = project.scene(op.scene);
        if (!sc) F.fail('ref.scene', 'cena inexistente: ' + op.scene);
        const tm = (sc.tilemaps || []).find((t) => t.id === op.tilemap);
        if (!tm) F.fail('ref.tilemap', 'tilemap inexistente: ' + op.tilemap);
        if (typeof op.value !== 'number' || !isFinite(op.value)) {
            F.fail('op.args', 'tilemap.fill: value deve ser numero');
        }
        const c0 = intArg(op.c0, 'c0'), r0 = intArg(op.r0, 'r0'),
              c1 = intArg(op.c1, 'c1'), r1 = intArg(op.r1, 'r1');
        for (let r = Math.max(0, r0); r <= Math.min(tm.rows - 1, r1); r++) {
            for (let c = Math.max(0, c0); c <= Math.min(tm.cols - 1, c1); c++) {
                tm.data[r * tm.cols + c] = op.value | 0;
            }
        }
        project.writeScene(sc);
    },

    'tilemap.remove': function (project, op) {
        const sc = project.scene(op.scene);
        if (!sc) F.fail('ref.scene', 'cena inexistente: ' + op.scene);
        sc.tilemaps = (sc.tilemaps || []).filter((t) => t.id !== op.tilemap);
        project.writeScene(sc);
    },
};

// refs de assets em uma cena/prefab (para asset.delete)
function collectRefs(obj, refs) {
    for (const e of obj.entities || []) {
        if (e.prefab) refs.add(e.prefab);
        for (const c of e.components || []) {
            const f = c.fields || {};
            for (const k of ['sprite', 'script']) {
                if (typeof f[k] === 'string' && f[k]) refs.add(f[k].split('#')[0]);
            }
            if (f.clips) walkRefs(f.clips, refs);
        }
    }
    for (const tm of obj.tilemaps || []) if (tm.tileset) refs.add(tm.tileset.split('#')[0]);
    return refs;
}

function walkRefs(v, refs) {
    if (typeof v === 'string') {
        if (/^[0-9a-f]{32}(#.*)?$/.test(v)) refs.add(v.split('#')[0]);
        return;
    }
    if (Array.isArray(v)) { for (const x of v) walkRefs(x, refs); return; }
    if (v && typeof v === 'object') { for (const k in v) walkRefs(v[k], refs); }
}

function referenced(project, guid) {
    const refs = new Set();
    for (const sc of project.sceneByGuid.values()) collectRefs(sc, refs);
    for (const pf of project.prefabByGuid.values()) collectRefs(pf, refs);
    // settings.assets/music guardam GUID ou nome; collectRefs so ve GUID
    for (const sc of project.sceneByGuid.values()) {
        const st = sc.settings || {};
        for (const ref of st.assets || []) {
            const a = project.asset(ref);
            if (a) refs.add(a.guid);
        }
        if (st.music) {
            const a = project.asset(st.music);
            if (a) refs.add(a.guid);
        }
    }
    return refs.has(guid);
}

function refGuid(value) {
    if (typeof value !== 'string' || !value) return null;
    const head = value.split('#')[0];
    return /^[0-9a-f]{32}$/.test(head) ? head : null;
}

// remove de uma cena/prefab toda referencia ao asset (asset.delete --force).
// Sem isso o lote falhava na validacao de ref orfa e o `force` nunca
// funcionava para um asset realmente usado.
function stripRefs(obj, guid, resolve) {
    let changed = false;
    if (obj.settings) {
        const st = obj.settings;
        if (Array.isArray(st.assets)) {
            const keep = st.assets.filter((ref) => {
                const a = resolve(ref);
                return !(a && a.guid === guid);
            });
            if (keep.length !== st.assets.length) { st.assets = keep; changed = true; }
        }
        if (st.music) {
            const a = resolve(st.music);
            if (a && a.guid === guid) { delete st.music; changed = true; }
        }
    }
    if (Array.isArray(obj.tilemaps)) {
        const keep = obj.tilemaps.filter((tm) => {
            const a = tm && resolve(tm.tileset);
            return !(a && a.guid === guid);
        });
        if (keep.length !== obj.tilemaps.length) { obj.tilemaps = keep; changed = true; }
    }
    if (Array.isArray(obj.entities)) {
        const keep = obj.entities.filter((e) => {
            if (e && e.prefab === guid) { changed = true; return false; }
            return true;
        });
        obj.entities = keep;
        for (const e of keep) {
            if (!Array.isArray(e.components)) continue;
            const comps = [];
            for (const c of e.components) {
                const f = c.fields || {};
                if (c.type === 'sprite' && refGuid(f.sprite) === guid) { changed = true; continue; }
                if (c.type === 'script' && refGuid(f.script) === guid) { changed = true; continue; }
                if (c.type === 'anim') {
                    if (f.meta && refGuid(f.meta) === guid) { delete f.meta; changed = true; }
                    if (f.clips && typeof f.clips === 'object') {
                        for (const name of Object.keys(f.clips)) {
                            const clip = f.clips[name] || {};
                            if (!Array.isArray(clip.frames)) continue;
                            const frames = clip.frames.filter((fr) => refGuid(fr) !== guid);
                            if (frames.length !== clip.frames.length) {
                                clip.frames = frames;
                                changed = true;
                            }
                            if (!frames.length) { delete f.clips[name]; changed = true; }
                        }
                    }
                    if (!f.meta && (!f.clips || !Object.keys(f.clips).length)) {
                        changed = true;
                        continue;
                    }
                }
                comps.push(c);
            }
            e.components = comps;
        }
    }
    return changed;
}

// ------------------------------------------------------------------ apply ----

function applyOps(dir, ops, opts) {
    opts = opts || {};
    const project = Project.open(dir);
    if (opts.ifRev !== undefined && opts.ifRev !== null && project.data.rev !== opts.ifRev) {
        F.fail('rev.stale', 'projeto mudou (rev ' + project.data.rev + ', esperado ' + opts.ifRev + ')',
               { hint: 'recarregue com `studio describe`' });
    }
    if (!Array.isArray(ops) || !ops.length) F.fail('ops.empty', 'nenhuma op informada');

    const id = Date.now() + '_' + F.newGuid().slice(0, 6);
    const rels = textFiles(project);
    // binarios que serao apagados/renomeados entram no snapshot
    for (const op of ops) {
        if (!op || !op.op) F.fail('ops.invalid', 'op sem campo "op"');
        if ((op.op === 'asset.delete' || op.op === 'asset.rename') && op.asset) {
            const a = project.asset(op.asset);
            if (a) rels.push(a.relPath);
        }
    }
    const snap = takeSnapshot(project, 'undo', id, rels);
    const ctx = { created: [], snapshotRels: [], changedFiles: [] };
    const warnings = [];
    const results = [];

    try {
        for (const op of ops) {
            // lookup proprio: OPS["__proto__"]/["constructor"] herdaria do
            // Object.prototype e viraria um TypeError sem codigo estavel
            const fn = Object.prototype.hasOwnProperty.call(OPS, op.op) ? OPS[op.op] : null;
            if (!fn) F.fail('op.unknown', 'op desconhecida: ' + op.op,
                            { hint: 'veja `studio describe` para a lista' });
            results.push(fn(project, op, ctx) || null);
        }

        const { validateProject } = require('./validate');
        const check = validateProject(project, { structural: true });
        for (const w of check.warnings || []) warnings.push(w);
        if (check.errors.length) {
            const e = new F.StudioError('validate.failed',
                'validacao falhou: ' + check.errors.length + ' erro(s)',
                { diagnostics: check.errors });
            throw e;
        }

        // rev do projeto e o token do `--if-rev`: um lote que so mexe em
        // cena/meta precisa bumpa-lo, senao dois editores com o mesmo rev
        // sobrescrevem um ao outro sem stale
        if (!opts.dryRun) {
            const touched = project.dirty.size > 0 || ctx.changedFiles.length > 0 || ctx.created.length > 0;
            if (touched) project.markDirty('celergame.project.json');
        }

        const changed = Array.from(new Set(
            Array.from(project.dirty).concat(ctx.changedFiles,
                ctx.created.map((p) => path.isAbsolute(p) ? path.relative(project.dir, p) : p))
        )).sort();

        // o undo precisa remover arquivos que NAO existiam no snapshot: os
        // criados por import/script e os modelos novos (cena/prefab/meta)
        const entriesRel = new Set(snap.manifest.entries.map((e) => e.rel));
        const createdRels = new Set();
        for (const rel of project.dirty) if (!entriesRel.has(rel)) createdRels.add(rel);
        for (const p of ctx.created) {
            const rel = path.isAbsolute(p) ? F.relPosix(project.dir, p) : p;
            if (!entriesRel.has(rel)) createdRels.add(rel);
        }
        snap.manifest.created = Array.from(createdRels).sort();

        if (opts.dryRun) {
            // devolve o preview sem tocar no disco: restaura o snapshot
            restoreSnapshot(project, snap);
            fs.rmSync(snap.dir, { recursive: true, force: true });
            return { ok: true, dryRun: true, id, changed, created: ctx.created, warnings,
                     results, rev: project.data.rev };
        }

        F.writeJson(path.join(snap.dir, 'manifest.json'), snap.manifest);

        const written = project.saveDirty();
        for (const rel of written) if (changed.indexOf(rel) < 0) changed.push(rel);
        changed.sort();

        // journal (auditoria de IA)
        try {
            fs.mkdirSync(project.studioDir, { recursive: true });
            fs.appendFileSync(path.join(project.studioDir, 'journal.jsonl'),
                JSON.stringify({ ts: Date.now(), id, ops, changed }) + '\n');
        } catch (e) { /* journal e opcional */ }

        // um lote novo invalida o redo: refazer por cima dele reintroduziria
        // o estado anterior e apagaria o trabalho recem-gravado
        try { fs.rmSync(path.join(project.studioDir, 'redo'), { recursive: true, force: true }); }
        catch (e) { /* sem redo */ }

        return { ok: true, id, changed, created: ctx.created, warnings, results, rev: project.data.rev };
    } catch (e) {
        // rollback: nada muda se o lote falhar
        const entriesRel = new Set(snap.manifest.entries.map((x) => x.rel));
        const createdRels = new Set();
        for (const rel of project.dirty) if (!entriesRel.has(rel)) createdRels.add(rel);
        for (const p of ctx.created) {
            const rel = path.isAbsolute(p) ? F.relPosix(project.dir, p) : p;
            if (!entriesRel.has(rel)) createdRels.add(rel);
        }
        snap.manifest.created = Array.from(createdRels);
        let rollbackError = null;
        try { restoreSnapshot(project, snap); } catch (e2) { rollbackError = e2; }
        try { fs.rmSync(snap.dir, { recursive: true, force: true }); } catch (e2) {}
        // rollback quebrado nao pode sumir: o projeto ficou meio gravado
        if (rollbackError && e && typeof e === 'object') {
            e.rollback = rollbackError.message || String(rollbackError);
            e.message = String(e.message || e) + ' (rollback falhou: ' + e.rollback + ')';
        }
        throw e;
    }
}

module.exports = {
    OPS, applyOps, undo, redo, takeSnapshot, restoreSnapshot, textFiles, referenced,
};
