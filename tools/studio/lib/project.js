'use strict';
// Projeto do Celer Studio: carrega celergame.project.json, indexa Assets/**
// (metas, cenas, prefabs) e grava de forma canonica. Nenhum estado escondido:
// tudo o que o editor sabe esta nos arquivos.

const fs = require('fs');
const path = require('path');
const F = require('./format');
const S = require('./schema');
const { STUDIO_VERSION, FORMAT } = require('../version');

const PROJECT_FILE = 'celergame.project.json';
const DEFAULT_DIRS = ['Sprites', 'Audio', 'Scripts', 'Prefabs', 'Scenes'];

function walk(dir, out) {
    let names;
    try { names = fs.readdirSync(dir).sort(); } catch (e) { return; }
    for (const name of names) {
        if (name === '.git' || name === '.studio' || name === 'node_modules') continue;
        // temporario de gravacao atomica que sobrou de um crash: nao e asset
        if (/\.tmp-\d+-[0-9a-f]+$/.test(name)) continue;
        // lixo do sistema (.DS_Store, ._* do macOS): virava asset sem .meta
        // e a issue meta.missing bloqueava TODA op no barramento
        if (name.startsWith('.')) continue;
        const abs = path.join(dir, name);
        let st;
        try { st = fs.statSync(abs); } catch (e) { continue; }
        if (st.isDirectory()) walk(abs, out);
        else out.push(abs);
    }
}

function isSceneFile(name) { return name.endsWith('.scene.json'); }
function isPrefabFile(name) { return name.endsWith('.prefab.json'); }
function isMetaFile(name) { return name.endsWith('.meta'); }

function sceneNameFromFile(name) { return name.replace(/\.scene\.json$/, ''); }
function prefabNameFromFile(name) { return name.replace(/\.prefab\.json$/, ''); }

class Project {
    constructor(dir) {
        this.dir = path.resolve(dir);
        this.projectFile = path.join(this.dir, PROJECT_FILE);
        this.assetsDir = path.join(this.dir, 'Assets');
        this.studioDir = path.join(this.dir, '.studio');
        this.data = null;
        this.files = new Map();       // relPath -> objeto JSON carregado/gerado
        this.dirty = new Set();
        this.assets = [];             // todos os arquivos com meta
        this.byGuid = new Map();
        this.byName = new Map();
        this.sceneByGuid = new Map();
        this.prefabByGuid = new Map();
        this.issues = [];             // problemas de leitura (meta ausente etc.)
    }

    // ------------------------------------------------------------- init ----
    static init(dir, opts) {
        opts = opts || {};
        const abs = path.resolve(dir);
        if (fs.existsSync(path.join(abs, PROJECT_FILE))) {
            F.fail('project.exists', 'ja existe um projeto em ' + abs);
        }
        fs.mkdirSync(abs, { recursive: true });
        for (const d of DEFAULT_DIRS) fs.mkdirSync(path.join(abs, 'Assets', d), { recursive: true });

        const name = opts.name || path.basename(abs);
        const slugName = F.slug(name).replace(/_/g, '') || 'jogo';
        const pkg = opts.pkg || ('br.celer.' + slugName);
        const app = !!opts.app;
        let api = 50;
        try { api = require('../../app_lint/lint.js').buildManifest().apiLevel; } catch (e) { api = 50; }

        const project = new Project(abs);
        project.data = {
            format: FORMAT,
            rev: 1,
            studio: STUDIO_VERSION,
            name,
            packageName: pkg,
            version: '0.1.0',
            author: opts.author || 'Celer Studio',
            description: opts.description || (app
                ? 'Programa feito com o Celer Studio'
                : 'Jogo feito com a CelerGame e o Celer Studio'),
            type: app ? 'App' : 'Game',
            category: app ? 'Utility' : 'Jogos',
            api,
            requires: app ? [] : ['psram'],
            topbar: false,
            permissions: [],
            deps: app ? {} : engineDeps(),
            changelog: '0.1.0: primeiro projeto',
            canvas: { w: 240, h: 320, native: false, fps: app ? 20 : 30, inset: 0 },
            runtime: app ? 'app' : 'studio',
            startScene: '',
            build: { out: '.studio/build', splitKB: 96 },
            editor: { grid: 8, snap: true, debug: false, prof: false },
        };

        // tela inicial: no programa e um cabecalho + titulo + botao (o modo
        // app desenha UI.header por cima, entao o conteudo comeca em y=56)
        const starter = app ? [
            {
                fid: F.newFid('e'),
                name: 'Titulo',
                active: true,
                z: 1,
                transform: { x: 12, y: 56, rot: 0, sx: 1, sy: 1, ax: 0, ay: 0 },
                components: [{
                    id: 'c_' + F.newGuid().slice(0, 8),
                    type: 'ui.text',
                    fields: { text: name, role: 'title', color: '#e8eefc', align: 'left' },
                }],
            },
            {
                fid: F.newFid('e'),
                name: 'Acao',
                active: true,
                z: 2,
                transform: { x: 12, y: 96, rot: 0, sx: 1, sy: 1, ax: 0, ay: 0 },
                components: [{
                    id: 'c_' + F.newGuid().slice(0, 8),
                    type: 'ui.button',
                    fields: { label: 'Comecar', w: 216, h: 36, style: 'primary' },
                }],
            },
        ] : [{
            fid: F.newFid('e'),
            name: 'Titulo',
            active: true,
            z: 10,
            transform: { x: 120, y: 80, rot: 0, sx: 1, sy: 1, ax: 0.5, ay: 0.5 },
            components: [{
                id: 'c_' + F.newGuid().slice(0, 8),
                type: 'text',
                fields: { text: name, color: '#e8eefc', px: 20, align: 'center' },
            }],
        }];

        const scene = {
            format: FORMAT,
            rev: 1,
            guid: F.newGuid(),
            name: 'Principal',
            settings: app
                ? { bg: '#0b1020', fps: 20 }
                : { bg: '#0b1020', fps: 30, static: false },
            entities: starter,
            tilemaps: [],
        };
        project.data.startScene = scene.guid;

        project.files.set(PROJECT_FILE, project.data);
        project.markDirty(PROJECT_FILE);
        project.writeNewJson('Assets/Scenes/Principal.scene.json', scene);
        project.writeNewMeta('Assets/Scenes/Principal.scene.json.meta', scene.guid, 'scene', {});
        project.saveDirty();
        project.writeGitignore();
        project.writeReadme(name);
        project.writeIcon(name);
        project.load();
        return project;
    }

    static open(dir) {
        const abs = path.resolve(dir);
        const p = new Project(abs);
        p.load();
        return p;
    }

    // ------------------------------------------------------------- load ----
    load() {
        if (!fs.existsSync(this.projectFile)) {
            F.fail('project.missing', 'nao achei ' + this.projectFile,
                   { hint: 'rode `celer.js studio init <dir>` para criar um projeto' });
        }
        this.data = F.readJson(this.projectFile);
        this.files.clear();
        this.dirty.clear();
        this.assets = [];
        this.byGuid.clear();
        this.byName.clear();
        this.sceneByGuid.clear();
        this.prefabByGuid.clear();
        this.issues = [];
        this.files.set(PROJECT_FILE, this.data);
        this.scan();
        return this;
    }

    scan() {
        const abs = [];
        if (fs.existsSync(this.assetsDir)) walk(this.assetsDir, abs);
        const names = new Set();
        for (const a of abs) {
            const rel = F.relPosix(this.dir, a);
            if (isMetaFile(a)) continue;
            const fileName = path.basename(a);
            const metaPath = a + '.meta';
            const metaRel = rel + '.meta';
            let meta = null;
            if (fs.existsSync(metaPath)) {
                try {
                    meta = F.readJson(metaPath);
                    this.files.set(metaRel, meta);
                } catch (e) {
                    this.issues.push({ code: 'meta.invalid', path: metaRel, message: e.message });
                }
            } else {
                this.issues.push({
                    code: 'meta.missing', path: rel,
                    message: 'arquivo sem .meta (importe com `studio import` ou crie o meta)',
                });
            }
            if (!meta) continue;
            let size = 0;
            try { size = fs.statSync(a).size; } catch (e) { size = 0; }
            const isScene = isSceneFile(fileName);
            const isPrefab = isPrefabFile(fileName);
            const asset = {
                guid: meta.guid,
                relPath: rel,
                absPath: a,
                fileName,
                name: isScene ? sceneNameFromFile(fileName)
                    : (isPrefab ? prefabNameFromFile(fileName)
                        : fileName.replace(/\.[^.]+$/, '')),
                ext: path.extname(fileName).toLowerCase(),
                kind: meta.importer,
                meta,
                metaPath: metaRel,
                size,
            };
            if (!F.isInside(this.assetsDir, a)) continue;
            this.assets.push(asset);
            if (this.byGuid.has(asset.guid)) {
                this.issues.push({ code: 'guid.duplicate', path: rel,
                                   message: 'GUID repetido com ' + this.byGuid.get(asset.guid).relPath });
                continue;
            }
            this.byGuid.set(asset.guid, asset);
            if (!this.byName.has(asset.name)) this.byName.set(asset.name, asset);
            else this.byName.set(asset.name, null);   // nome ambiguo
            names.add(asset.name.toLowerCase());

            if (isScene || asset.kind === 'scene') {
                try {
                    const sc = F.readJson(a);
                    this.files.set(rel, sc);
                    this.sceneByGuid.set(asset.guid, sc);
                    asset.scene = sc;
                } catch (e) {
                    this.issues.push({ code: 'scene.invalid', path: rel, message: e.message });
                }
            } else if (isPrefab || asset.kind === 'prefab') {
                try {
                    const pf = F.readJson(a);
                    this.files.set(rel, pf);
                    this.prefabByGuid.set(asset.guid, pf);
                    asset.prefab = pf;
                } catch (e) {
                    this.issues.push({ code: 'prefab.invalid', path: rel, message: e.message });
                }
            }
        }
        this.assets.sort((a, b) => F.cmpStr(a.relPath, b.relPath));
    }

    // ------------------------------------------------------------ refs ----
    asset(ref) {
        if (!ref) return null;
        const raw = String(ref).split('#')[0];
        return this.byGuid.get(raw) || this.byName.get(raw) || null;
    }

    scene(ref) {
        if (!ref) return null;
        const a = this.asset(ref);
        if (a && a.scene) return a.scene;
        for (const sc of this.sceneByGuid.values()) if (sc.name === ref) return sc;
        return null;
    }

    prefab(ref) {
        if (!ref) return null;
        const a = this.asset(ref);
        if (a && a.prefab) return a.prefab;
        for (const pf of this.prefabByGuid.values()) if (pf.name === ref) return pf;
        return null;
    }

    sceneAsset(ref) {
        const sc = this.scene(ref);
        if (!sc) return null;
        return this.byGuid.get(sc.guid) || null;
    }

    sceneList() {
        return Array.from(this.sceneByGuid.values()).sort((a, b) => F.cmpStr(a.name, b.name));
    }

    prefabList() {
        return Array.from(this.prefabByGuid.values()).sort((a, b) => F.cmpStr(a.name, b.name));
    }

    assetList(kind) {
        return this.assets.filter((a) => !kind || a.kind === kind);
    }

    // regioes de um asset grafico (nome + rect em px) — fonte unica para o
    // inspetor, o viewport e o build
    regions(asset) {
        const m = asset.meta || {};
        const st = m.settings || {};
        const out = [];
        if (m.importer === 'sprite' && (st.mode || 'single') === 'single') {
            const w = st.w || 0, h = st.h || 0;
            out.push({ name: asset.name, x: 0, y: 0, w, h });
            return out;
        }
        if ((st.mode || 'grid') === 'grid') {
            const cols = st.cols || 1, rows = st.rows || 1;
            const tw = st.tw || 0, th = st.th || 0;
            const prefix = st.prefix !== undefined && st.prefix !== ''
                ? st.prefix : (m.importer === 'tileset' ? '' : asset.name);
            let i = 0;
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    out.push({ name: prefix + i, x: c * tw, y: r * th, w: tw, h: th, c, r });
                    i++;
                }
            }
            return out;
        }
        if (st.mode === 'regions' && st.regions) {
            for (const name of Object.keys(st.regions).sort()) {
                const r = st.regions[name];
                out.push({ name, x: r[0], y: r[1], w: r[2], h: r[3] });
            }
        }
        return out;
    }

    region(asset, name) {
        const rs = this.regions(asset);
        for (const r of rs) if (r.name === String(name)) return r;
        return null;
    }

    // ------------------------------------------------------------- save ----
    markDirty(rel) { this.dirty.add(rel); }

    writeNewJson(rel, obj) {
        this.files.set(rel, obj);
        this.markDirty(rel);
    }

    writeNewMeta(rel, guid, importer, settings) {
        const meta = { format: FORMAT, guid, importer, settings: settings || {} };
        this.files.set(rel, meta);
        this.markDirty(rel);
        return meta;
    }

    saveDirty() {
        const changed = [];
        for (const rel of Array.from(this.dirty).sort()) {
            const obj = this.files.get(rel);
            if (!obj) continue;
            if (rel === PROJECT_FILE || rel.endsWith('.scene.json') || rel.endsWith('.prefab.json')) {
                obj.rev = (obj.rev || 0) + 1;
            }
            if (rel === PROJECT_FILE) obj.studio = STUDIO_VERSION;
            F.writeJson(path.join(this.dir, rel), obj);
            changed.push(rel);
        }
        this.dirty.clear();
        return changed;
    }

    writeProject() {
        this.data.rev = (this.data.rev || 0) + 1;
        this.data.studio = STUDIO_VERSION;
        F.writeJson(this.projectFile, this.data);
        this.files.set(PROJECT_FILE, this.data);
    }

    writeScene(scene) {
        const asset = this.byGuid.get(scene.guid);
        if (!asset) F.fail('scene.missing', 'cena sem arquivo/asset: ' + scene.guid);
        this.files.set(asset.relPath, scene);
        this.markDirty(asset.relPath);
    }

    writePrefab(prefab) {
        const asset = this.byGuid.get(prefab.guid);
        if (!asset) F.fail('prefab.missing', 'prefab sem arquivo/asset: ' + prefab.guid);
        this.files.set(asset.relPath, prefab);
        this.markDirty(asset.relPath);
    }

    writeMeta(asset) {
        this.files.set(asset.metaPath, asset.meta);
        this.markDirty(asset.metaPath);
    }

    // --------------------------------------------------------- new files ----
    // registra um arquivo ja gravado (import de asset) sem varrer o projeto
    // inteiro — preserva mutacoes em memoria que ainda nao foram salvas
    registerAsset(rel, meta) {
        const abs = path.join(this.dir, rel);
        const fileName = path.basename(rel);
        const isScene = isSceneFile(fileName);
        const isPrefab = isPrefabFile(fileName);
        const asset = {
            guid: meta.guid,
            relPath: rel,
            absPath: abs,
            fileName,
            name: isScene ? sceneNameFromFile(fileName)
                : (isPrefab ? prefabNameFromFile(fileName)
                    : fileName.replace(/\.[^.]+$/, '')),
            ext: path.extname(fileName).toLowerCase(),
            kind: meta.importer,
            meta,
            metaPath: rel + '.meta',
            size: 0,
        };
        try { asset.size = fs.statSync(abs).size; } catch (e) { asset.size = 0; }
        this.assets.push(asset);
        this.assets.sort((a, b) => F.cmpStr(a.relPath, b.relPath));
        this.byGuid.set(asset.guid, asset);
        if (!this.byName.has(asset.name)) this.byName.set(asset.name, asset);
        else this.byName.set(asset.name, null);
        this.files.set(asset.metaPath, meta);
        if (isScene) {
            const sc = F.readJson(abs);
            this.files.set(rel, sc);
            this.sceneByGuid.set(asset.guid, sc);
            asset.scene = sc;
        } else if (isPrefab) {
            const pf = F.readJson(abs);
            this.files.set(rel, pf);
            this.prefabByGuid.set(asset.guid, pf);
            asset.prefab = pf;
        }
        return asset;
    }

    freeRel(dirRel, base, ext) {
        let name = F.sanitizeFileName(base + ext);
        let n = 2;
        while (fs.existsSync(path.join(this.dir, dirRel, name)) ||
               this.files.has((dirRel + '/' + name).replace(/\/+/g, '/'))) {
            name = F.sanitizeFileName(base + '_' + n + ext);
            n++;
        }
        return (dirRel + '/' + name).replace(/\/+/g, '/');
    }

    // nome de exibicao unico (case-insensitive): dois modelos com o mesmo
    // nome deixam `scene(ref)`/`prefab(ref)` ambiguos e colidem no mapa
    // `names` do build.
    uniqueSceneName(base) {
        const used = new Set();
        for (const sc of this.sceneByGuid.values()) used.add(String(sc.name).toLowerCase());
        let name = String(base);
        let n = 2;
        while (used.has(name.toLowerCase())) { name = base + ' ' + n; n++; }
        return name;
    }

    sceneNameTaken(base, exceptGuid) {
        for (const sc of this.sceneByGuid.values()) {
            if (sc.guid !== exceptGuid && String(sc.name).toLowerCase() === String(base).toLowerCase()) return true;
        }
        return false;
    }

    prefabNameTaken(base, exceptGuid) {
        for (const pf of this.prefabByGuid.values()) {
            if (pf.guid !== exceptGuid && String(pf.name).toLowerCase() === String(base).toLowerCase()) return true;
        }
        return false;
    }

    createScene(name) {
        name = this.uniqueSceneName(name);
        const rel = this.freeRel('Assets/Scenes', name, '.scene.json');
        const sc = {
            format: FORMAT,
            rev: 1,
            guid: F.newGuid(),
            name,
            settings: { bg: '#0b1020', fps: this.data.canvas.fps || 30, static: false },
            entities: [],
            tilemaps: [],
        };
        this.writeNewJson(rel, sc);
        this.writeNewMeta(rel + '.meta', sc.guid, 'scene', {});
        const asset = {
            guid: sc.guid, relPath: rel, absPath: path.join(this.dir, rel),
            fileName: path.basename(rel), name, ext: '.scene.json', kind: 'scene',
            meta: this.files.get(rel + '.meta'), metaPath: rel + '.meta',
            size: 0, scene: sc,
        };
        this.assets.push(asset);
        this.byGuid.set(sc.guid, asset);
        this.byName.set(name, asset);
        this.sceneByGuid.set(sc.guid, sc);
        if (!this.data.startScene) this.data.startScene = sc.guid;
        this.markDirty(PROJECT_FILE);
        return sc;
    }

    createPrefab(name) {
        name = String(name);
        while (this.prefabNameTaken(name)) name = name + ' copia';
        const rel = this.freeRel('Assets/Prefabs', name, '.prefab.json');
        const pf = {
            format: FORMAT,
            rev: 1,
            guid: F.newGuid(),
            name,
            entities: [],
        };
        this.writeNewJson(rel, pf);
        this.writeNewMeta(rel + '.meta', pf.guid, 'prefab', {});
        const asset = {
            guid: pf.guid, relPath: rel, absPath: path.join(this.dir, rel),
            fileName: path.basename(rel), name, ext: '.prefab.json', kind: 'prefab',
            meta: this.files.get(rel + '.meta'), metaPath: rel + '.meta',
            size: 0, prefab: pf,
        };
        this.assets.push(asset);
        this.byGuid.set(pf.guid, asset);
        this.byName.set(name, asset);
        this.prefabByGuid.set(pf.guid, pf);
        return pf;
    }

    deleteScene(scene) {
        const asset = this.byGuid.get(scene.guid);
        if (!asset) return;
        fs.rmSync(asset.absPath, { force: true });
        fs.rmSync(path.join(this.dir, asset.metaPath), { force: true });
        this.assets = this.assets.filter((a) => a.guid !== scene.guid);
        this.byGuid.delete(scene.guid);
        if (this.byName.get(scene.name) === asset) this.byName.delete(scene.name);
        this.sceneByGuid.delete(scene.guid);
        this.files.delete(asset.relPath);
        this.files.delete(asset.metaPath);
        this.dirty.delete(asset.relPath);
        this.dirty.delete(asset.metaPath);
        if (this.data.startScene === scene.guid) {
            const next = this.sceneList()[0];
            this.data.startScene = next ? next.guid : '';
            this.markDirty(PROJECT_FILE);
        }
    }

    deletePrefab(prefab) {
        const asset = this.byGuid.get(prefab.guid);
        if (!asset) return;
        fs.rmSync(asset.absPath, { force: true });
        fs.rmSync(path.join(this.dir, asset.metaPath), { force: true });
        this.assets = this.assets.filter((a) => a.guid !== prefab.guid);
        this.byGuid.delete(prefab.guid);
        if (this.byName.get(prefab.name) === asset) this.byName.delete(prefab.name);
        this.prefabByGuid.delete(prefab.guid);
        this.files.delete(asset.relPath);
        this.files.delete(asset.metaPath);
        this.dirty.delete(asset.relPath);
        this.dirty.delete(asset.metaPath);
    }

    // ---------------------------------------------------------- helpers ----
    buildDir() {
        const out = (this.data.build && this.data.build.out) || '.studio/build';
        return path.join(this.dir, out, F.slug(this.data.packageName));
    }

    resolveInside(rel) {
        const abs = path.resolve(this.dir, rel);
        if (!F.isInside(this.dir, abs)) F.fail('path.outside', 'caminho fora do projeto: ' + rel);
        return abs;
    }

    writeGitignore() {
        const file = path.join(this.dir, '.gitignore');
        if (fs.existsSync(file)) return;
        fs.writeFileSync(file, '# Celer Studio (build, undo, layout)\n.studio/\n');
    }

    writeReadme(name) {
        const file = path.join(this.dir, 'README.md');
        if (fs.existsSync(file)) return;
        const app = this.data.runtime === 'app';
        fs.writeFileSync(file,
            '# ' + name + '\n\n' +
            (app
                ? 'Programa do Celer Studio (runtime "app": telas com o toolkit UI do sistema).\n\n'
                : 'Projeto do Celer Studio para a CelerGame.\n\n') +
            '```bash\n' +
            'node tools/sdk/celer.js studio . --serve   # abre o editor\n' +
            'node tools/sdk/celer.js studio . build     # gera o app em .studio/build\n' +
            'node tools/sdk/celer.js studio . run       # roda no harness (PNG)\n' +
            '```\n\n' +
            'A fonte da verdade sao `celergame.project.json`, `Assets/**`, `*.scene.json` e `*.prefab.json`.\n');
    }

    writeIcon(name) {
        const file = path.join(this.dir, 'icon.png');
        if (fs.existsSync(file)) return;
        try {
            const { makeIconPng } = require('../../sdk/lib/icon.js');
            fs.writeFileSync(file, makeIconPng(name[0] || 'C'));
        } catch (e) { /* icone e opcional */ }
    }

    // resumo para `describe` / API
    summary() {
        return {
            dir: this.dir,
            project: {
                name: this.data.name,
                packageName: this.data.packageName,
                version: this.data.version,
                api: this.data.api,
                rev: this.data.rev,
                runtime: this.data.runtime || 'studio',
                legacy: this.data.legacy || null,
                canvas: this.data.canvas,
                startScene: this.data.startScene,
                deps: this.data.deps || {},
                build: this.data.build || {},
                // campos de publicacao/editaveis no painel Projeto
                author: this.data.author || '',
                description: this.data.description || '',
                type: this.data.type || (this.data.runtime === 'app' ? 'App' : 'Game'),
                category: this.data.category || (this.data.runtime === 'app' ? 'Utility' : 'Jogos'),
                topbar: this.data.topbar === undefined ? false : !!this.data.topbar,
                permissions: this.data.permissions || [],
                requires: this.data.requires || [],
                changelog: this.data.changelog || '',
            },
            scenes: this.sceneList().map((s) => {
                const a = this.byGuid.get(s.guid);
                return {
                    guid: s.guid, name: s.name, path: a ? a.relPath : '',
                    entities: (s.entities || []).length,
                    tilemaps: (s.tilemaps || []).length,
                    start: s.guid === this.data.startScene,
                };
            }),
            prefabs: this.prefabList().map((p) => {
                const a = this.byGuid.get(p.guid);
                return { guid: p.guid, name: p.name, path: a ? a.relPath : '',
                         entities: (p.entities || []).length };
            }),
            assets: this.assets.map((a) => {
                const graphic = a.meta.importer === 'sprite' || a.meta.importer === 'sprite-sheet' ||
                                a.meta.importer === 'tileset';
                const regions = graphic ? this.regions(a) : [];
                return {
                    guid: a.guid, name: a.name, kind: a.kind, path: a.relPath,
                    size: a.size, importer: a.meta.importer,
                    settings: a.meta.settings || {},
                    regions: regions.length,
                    regionsList: regions,
                };
            }),
            issues: this.issues,
        };
    }
}

// deps iniciais: core + o que o runtime gerado usa
function engineDeps() {
    const dir = path.join(__dirname, '..', '..', 'sdk', 'engine');
    const ver = (file) => {
        try {
            const m = fs.readFileSync(path.join(dir, file), 'utf8').match(/version\s*[:=]\s*['"]([^'"]+)['"]/);
            return m ? m[1] : '1.0.0';
        } catch (e) { return '1.0.0'; }
    };
    return {
        'celeros.game': '^' + ver('celeros.game.js'),
        'celeros.game.spr': '^' + ver('celeros.game.spr.js'),
        'celeros.game.tilemap': '^' + ver('celeros.game.tilemap.js'),
    };
}

module.exports = { Project, PROJECT_FILE, DEFAULT_DIRS, isSceneFile, isPrefabFile, engineDeps };
