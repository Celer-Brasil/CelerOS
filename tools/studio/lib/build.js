'use strict';
// Build do Studio: valida o projeto, achata prefabs, resolve referencias,
// copia assets para um pacote FLAT e gera main.js (com o runtime embutido),
// game.data.js e os modulos de script locais. Deterministico e ES5.

const fs = require('fs');
const path = require('path');
const F = require('./format');
const SC = require('./schema');
const { Project } = require('./project');
const { validateProject, isShipped } = require('./validate');
const { strip } = require('../../sdk/lib/jsstrip.js');

const RUNTIME = fs.readFileSync(path.join(__dirname, '..', 'templates', 'runtime.js'), 'utf8');
const HEADER = '// GERADO POR CELER STUDIO ' + require('../version').STUDIO_VERSION +
    ' - NAO EDITE. Fonte: celergame.project.json + Assets/**.\n';

function failBuild(message, extra) {
    const e = new F.StudioError('build.failed', message, extra);
    throw e;
}

function refsOfEntity(e, out) {
    for (const c of e.components || []) {
        const f = c.fields || {};
        if (typeof f.sprite === 'string' && f.sprite) out.add(f.sprite.split('#')[0]);
        if (typeof f.script === 'string' && f.script) out.add(f.script.split('#')[0]);
        if (f.clips) refsWalk(f.clips, out);
    }
    if (e.prefab) out.add(e.prefab);
    return out;
}

function refsWalk(v, out) {
    if (typeof v === 'string') {
        if (/^[0-9a-f]{32}(#.*)?$/.test(v)) out.add(v.split('#')[0]);
        return;
    }
    if (Array.isArray(v)) { for (const x of v) refsWalk(x, out); return; }
    if (v && typeof v === 'object') { for (const k in v) refsWalk(v[k], out); }
}

function collectUsed(project) {
    const used = new Set();
    const walkPrefab = (pf, depth) => {
        if (!pf || depth > 6) return;
        for (const e of pf.entities || []) {
            refsOfEntity(e, used);
            if (e.prefab) {
                const nested = project.prefab(e.prefab);
                if (nested) walkPrefab(nested, depth + 1);
            }
        }
    };
    for (const sc of project.sceneByGuid.values()) {
        if (sc.settings && sc.settings.music) used.add(sc.settings.music.split('#')[0]);
        for (const e of sc.entities || []) {
            refsOfEntity(e, used);
            if (e.prefab) {
                const pf = project.prefab(e.prefab);
                walkPrefab(pf, 0);
            }
        }
        for (const tm of sc.tilemaps || []) if (tm.tileset) used.add(tm.tileset.split('#')[0]);
    }
    return used;
}

// nomes flat unicos e o mapa guid -> asset de runtime. Aloca nome para TODOS
// os assets (a resolucao de sprite precisa disso); a copia e filtrada depois
// pelas cenas que realmente usam (o teto de 16 extras e apertado).
function planAssets(project) {
    const usedNames = new Set(['main.js', 'app.json', 'icon.png', 'game.data.js']);
    for (let i = 0; i < 16; i++) usedNames.add('game.data.' + i + '.js');
    const byGuid = new Map();
    const copies = [];
    const scripts = [];
    const assets = project.assets.slice().sort((a, b) => a.relPath.localeCompare(b.relPath));

    for (const a of assets) {
        if (!isShipped(a.kind)) continue;
        const outName = F.uniqueName(F.sanitizeFileName(a.fileName), usedNames);
        if (a.kind === 'script') {
            const base = 's.' + F.slug(a.name) + '.js';
            const modFile = F.uniqueName(base, usedNames);
            scripts.push({ asset: a, file: modFile, module: modFile.slice(0, -3) });
            continue;
        }
        const n = outName.replace(/\.[^.]+$/, '');
        // o engine anexa ".png" em load/sheet: o asset guarda o nome SEM ext
        const graphicFile = outName.replace(/\.png$/i, '');
        const st = a.meta.settings || {};
        if (a.kind === 'audio') {
            byGuid.set(a.guid, { t: 'a', n: n, f: outName });
        } else {
            const regions = project.regions(a);
            const mode = st.mode || (a.kind === 'sprite' ? 'single' : 'grid');
            const single = mode === 'single';
            // E.spr.meta: o prefixo tem de reproduzir os nomes das regioes
            // do build (n#<prefixo><indice>). O tileset usa indice puro.
            const prefixBase = st.prefix !== undefined && st.prefix !== ''
                ? st.prefix
                : (a.meta.importer === 'tileset' ? '' : a.name);
            const pivot = st.pivot || [0.5, 0.5];
            const extra = {
                mode: mode,
                ax: pivot[0] === undefined ? 0.5 : pivot[0],
                ay: pivot[1] === undefined ? 0.5 : pivot[1],
            };
            for (const k of ['anims', 'fps', 'loop', 'hitbox']) if (st[k] !== undefined) extra[k] = st[k];
            if (single) {
                byGuid.set(a.guid, Object.assign({
                    t: 's', n: n, f: graphicFile, w: st.w || 0, h: st.h || 0,
                }, extra));
            } else {
                const map = {};
                for (const r of regions) map[n + '#' + r.name] = [r.x, r.y, r.w, r.h];
                byGuid.set(a.guid, Object.assign({
                    t: 'g', n: n, f: graphicFile, w: st.w || 0, h: st.h || 0,
                    cols: st.cols || 1, rows: st.rows || 1,
                    tw: st.tw || 16, th: st.th || 16, regions: map,
                    prefix: n + '#' + prefixBase,
                }, extra));
            }
        }
        copies.push({ from: a.absPath, to: outName, guid: a.guid });
    }
    return { byGuid, copies, scripts };
}

function spriteName(project, plan, ref, at, load) {
    const parts = String(ref).split('#');
    const asset = project.asset(parts[0]);
    if (!asset) failBuild('sprite inexistente em ' + at + ': ' + ref);
    const ra = plan.byGuid.get(asset.guid);
    if (!ra) failBuild('asset grafico nao entrou no build: ' + asset.name);
    if (load) load.add(asset.guid);
    if (ra.t === 's') return ra.n;
    if (parts.length < 2 || !parts[1]) failBuild('referencia sem regiao em ' + at + ': ' + ref);
    const key = ra.n + '#' + parts[1];
    if (!(key in ra.regions)) failBuild('regiao "' + parts[1] + '" nao existe em ' + asset.name);
    return key;
}

function convertComponent(project, plan, c, at, load) {
    const f = c.fields || {};
    if (c.type === 'sprite') {
        return { t: 'spr', s: spriteName(project, plan, f.sprite, at, load), key: F.parseColor(f.key, 0x0000) };
    }
    if (c.type === 'anim') {
        const clips = f.clips || {};
        const out = {};
        for (const name of Object.keys(clips)) {
            const cl = clips[name] || {};
            out[name] = {
                frames: (cl.frames || []).map((fr, i) =>
                    spriteName(project, plan, fr, at + '.clips.' + name + '[' + i + ']', load)),
                fps: cl.fps !== undefined ? cl.fps : 6,
                loop: cl.loop === undefined ? true : cl.loop,
            };
        }
        let metaName = null;
        if (f.meta) {
            const ma = project.asset(f.meta);
            if (!ma) failBuild('asset de metadados inexistente em ' + at + ': ' + f.meta);
            const ra = plan.byGuid.get(ma.guid);
            if (!ra) failBuild('asset de metadados nao entrou no build: ' + ma.name);
            metaName = ra.n;
            load.add(ma.guid);
        }
        const anims = metaName && project.asset(f.meta)
            ? (project.asset(f.meta).meta.settings || {}).anims || {} : {};
        const cur = f.current || Object.keys(out)[0] || Object.keys(anims)[0] || '';
        return {
            t: 'anim', clips: out, current: cur, autoplay: f.autoplay !== false,
            meta: metaName,
        };
    }
    if (c.type === 'text') {
        const out = {
            t: 'txt', text: f.text || '', color: F.parseColor(f.color, 0xFFFF),
            px: f.px !== undefined ? f.px : 13,
            align: f.align || 'left', valign: f.valign || 'top',
        };
        if (f.ts) out.ts = f.ts;
        if (f.shadow) out.shadow = F.parseColor(f.shadow, 0x0000);
        return out;
    }
    if (c.type === 'shape') {
        return {
            t: 'shape', shape: f.shape || 'rect', w: f.w || 0, h: f.h || 0, r: f.r || 0,
            x2: f.x2 || 0, y2: f.y2 || 0, color: F.parseColor(f.color, 0x38BCF8),
            fill: f.fill !== false,
        };
    }
    if (c.type === 'collider') {
        return { t: 'col', shape: f.shape || 'rect', w: f.w || 0, h: f.h || 0, r: f.r || 0 };
    }
    if (c.type === 'hud') {
        return { t: 'hud', a: f.anchor | 0, mx: f.mx || 0, my: f.my || 0 };
    }
    if (c.type === 'script') {
        const asset = project.asset(f.script);
        if (!asset) failBuild('script inexistente em ' + at + ': ' + f.script);
        const sc = plan.scripts.find((x) => x.asset.guid === asset.guid);
        if (!sc) failBuild('script nao entrou no build: ' + asset.name);
        return { t: 'script', m: sc.module, id: c.id || '', fields: f.fields || {} };
    }
    failBuild('componente desconhecido no build: ' + c.type);
}

function convertEntity(project, plan, e, ctx, opts) {
    const t = e.transform || {};
    const out = {
        fid: opts.fid || e.fid,
        name: opts.name || e.name,
        active: e.active === undefined ? true : !!e.active,
        z: F.round(opts.z !== undefined ? opts.z : (e.z || 0)),
        x: F.round(opts.x !== undefined ? opts.x : (t.x || 0)),
        y: F.round(opts.y !== undefined ? opts.y : (t.y || 0)),
        rot: F.round(t.rot || 0),
        sx: t.sx !== undefined ? t.sx : 1,
        sy: t.sy !== undefined ? t.sy : 1,
        comps: [],
    };
    // ax/ay so entram quando o autor fixou: ausente = pivot do E.spr.meta
    if (t.ax !== undefined) out.ax = t.ax;
    if (t.ay !== undefined) out.ay = t.ay;
    const at = 'entidade ' + e.fid;
    for (const c of e.components || []) {
        out.comps.push(convertComponent(project, plan, c, at, ctx.load));
    }
    if (!out.comps.length && e.prefab) {
        // instancia sem componentes diretos: o conteudo vem do prefab
    }
    return out;
}

// achata uma instancia de prefab em entidades de runtime
function expandInstance(project, plan, inst, ctx, depth) {
    if (depth > 4) failBuild('prefab aninhado demais (limite 4): ' + inst.fid);
    const pf = project.prefab(inst.prefab);
    if (!pf) failBuild('prefab inexistente: ' + inst.prefab);
    const it = inst.transform || {};
    const baseX = it.x || 0, baseY = it.y || 0;
    const baseSX = it.sx !== undefined ? it.sx : 1;
    const baseSY = it.sy !== undefined ? it.sy : 1;
    const baseRot = it.rot || 0;
    const baseZ = inst.z || 0;
    const act = inst.active === undefined ? true : !!inst.active;
    const ovs = inst.overrides || {};
    let first = null;

    for (const child of pf.entities || []) {
        const ov = ovs[child.fid] || {};
        const local = F.deepClone(child);
        local.fid = inst.fid + '/' + child.fid;
        local.name = ov.name || child.name;
        local.active = act && (ov.active !== undefined ? !!ov.active : (child.active === undefined ? true : !!child.active));
        local.z = baseZ + (child.z || 0);
        local.transform = F.deepClone(child.transform || { x: 0, y: 0 });
        if (ov.transform) {
            for (const k of ['x', 'y', 'rot', 'sx', 'sy', 'ax', 'ay']) {
                if (ov.transform[k] !== undefined) local.transform[k] = ov.transform[k];
            }
        }
        if (ov.components) {
            for (const c of local.components || []) {
                const patch = ov.components[c.id];
                if (patch) {
                    c.fields = c.fields || {};
                    for (const k in patch) c.fields[k] = patch[k];
                }
            }
        }
        // transform local -> mundo (offset/escala da instancia)
        const lt = local.transform;
        const rx = baseX + (lt.x || 0) * baseSX;
        const ry = baseY + (lt.y || 0) * baseSY;
        const out = {
            x: F.round(rx), y: F.round(ry),
            z: local.z, name: local.name,
        };
        let list;
        local.transform.rot = F.round((lt.rot || 0) + baseRot);
        local.transform.sx = (lt.sx !== undefined ? lt.sx : 1) * baseSX;
        local.transform.sy = (lt.sy !== undefined ? lt.sy : 1) * baseSY;
        if (local.prefab) {
            local.transform.x = out.x;
            local.transform.y = out.y;
            list = expandInstance(project, plan, local, ctx, depth + 1);
        } else {
            list = [convertEntity(project, plan, local, ctx, {
                fid: local.fid, name: local.name, x: out.x, y: out.y, z: out.z,
            })];
        }
        for (const x of list) {
            if (!first) first = x.fid;
            ctx.entities.push(x);
        }
    }
    if (first) ctx.instanceMap[inst.fid] = first;
    return ctx.entities;
}

function buildScenes(project, plan, warnings) {
    const usedNames = new Set();
    const byGuid = new Map();
    const out = {};
    const scenes = project.sceneList();
    const keyByGuid = new Map();
    for (const sc of scenes) {
        const key = F.uniqueName(F.slug(sc.name, 40), usedNames);
        keyByGuid.set(sc.guid, key);
    }
    for (const sc of scenes) {
        const key = keyByGuid.get(sc.guid);
        byGuid.set(sc.guid, key);
        const st = sc.settings || {};
        const ctx = { entities: [], instanceMap: {}, load: new Set() };
        for (const e of sc.entities || []) {
            if (e.prefab) expandInstance(project, plan, e, ctx, 0);
            else ctx.entities.push(convertEntity(project, plan, e, ctx, {}));
        }
        // fids unicos
        const seen = new Set();
        for (const e of ctx.entities) {
            let fid = e.fid;
            let n = 2;
            while (seen.has(fid)) { fid = e.fid + '_' + n; n++; }
            e.fid = fid;
            seen.add(fid);
        }
        const load = ctx.load;
        const tilemaps = [];
        for (const tm of sc.tilemaps || []) {
            load.add(tm.tileset);
            const asset = project.asset(tm.tileset);
            const ra = asset ? plan.byGuid.get(asset.guid) : null;
            if (!asset || !ra) failBuild('tileset do build nao resolvido: ' + tm.tileset);
            tilemaps.push({
                id: tm.id, tileset: asset.guid, cols: tm.cols, rows: tm.rows,
                cell: tm.cell, ox: tm.ox || 0, oy: tm.oy || 0, layer: tm.layer || 0,
                data: tm.data, solids: tm.solids || null, autotile: tm.autotile || null,
            });
        }
        if (st.music) load.add(st.music);

        let follow = null;
        if (st.camera && st.camera.follow) {
            follow = ctx.instanceMap[st.camera.follow] || st.camera.follow;
            if (!ctx.entities.some((e) => e.fid === follow)) {
                warnings.push({ code: 'scene.camera', path: 'cena ' + sc.name,
                                message: 'camera.follow nao resolvido: ' + st.camera.follow });
                follow = null;
            }
        }
        out[key] = {
            name: key,
            fps: st.fps !== undefined ? st.fps : (project.data.canvas.fps || 30),
            static: st.static ? true : false,
            bg: F.parseColor(st.bg, 0x0000),
            camera: st.camera ? {
                bounds: st.camera.bounds || null,
                follow: follow,
                deadzone: st.camera.deadzone || null,
            } : null,
            music: st.music ? st.music : null,
            load: Array.from(load).sort(),
            entities: ctx.entities,
            tilemaps: tilemaps,
        };
    }
    return { scenes: out, keyByGuid };
}

function generateMain(project, opts) {
    const deps = Object.keys(project.data.deps || {}).sort();
    const req = new Set(['celeros.game', 'celeros.game.spr', 'celeros.game.tilemap']);
    for (const d of deps) if (d.indexOf('celeros.game.') === 0) req.add(d);
    let src = HEADER;
    const ordered = Array.from(req).sort((a, b) => a === 'celeros.game' ? -1 : (b === 'celeros.game' ? 1 : a.localeCompare(b)));
    for (const d of ordered) {
        src += (d === 'celeros.game' ? 'var E = ' : '') + 'require("' + d + '");\n';
    }
    const p = project.data;
    const pkg = p.packageName;
    const name = p.name.replace(/"/g, '\\"');
    const bases = [
        '/local/apps/' + pkg + '/', '/sd/apps/' + pkg + '/',
        '/local/apps/' + name + '/', '/sd/apps/' + name + '/',
    ];
    src += '\nE.init({ dir: "' + name + '", fps: ' + (p.canvas.fps !== undefined ? p.canvas.fps : 30) +
           ', native: ' + (p.canvas.native ? 'true' : 'false') +
           ', save: "' + F.slug(p.name, 6) + '."' +
           (p.deps && p.deps['celeros.game.fx'] ? ', particles: 96' : '') +
           ',\n         bases: ' + JSON.stringify(bases) + ' });\n';
    if (p.editor && p.editor.debug) src += 'E.debug = true;\n';
    if (p.editor && p.editor.prof) src += 'if (E.prof) E.prof.on = true;\n';
    src += '\n';
    src += RUNTIME;
    src += '\nstudioBoot(E, require("game.data"));\n';
    return src;
}

function stripSize(src) {
    try { return strip(src).length; } catch (e) { return Buffer.byteLength(src, 'utf8'); }
}

function buildProject(dir, opts) {
    opts = opts || {};
    const project = Project.open(dir);
    const check = validateProject(project, {});
    if (check.errors.length) {
        throw new F.StudioError('build.invalid', 'projeto invalido: ' + check.errors.length + ' erro(s)',
            { diagnostics: check.errors });
    }
    const warnings = (check.warnings || []).slice();
    const buildDir = project.buildDir();
    const assetsAbs = path.join(project.dir, 'Assets');
    if (buildDir === project.dir || buildDir === assetsAbs ||
        buildDir === path.join(project.dir, '.studio') ||
        F.isInside(assetsAbs, buildDir)) {
        failBuild('build.out nao pode ser o projeto/Assets/.studio: ' + buildDir);
    }
    if (!F.isInside(path.join(project.dir, '.studio'), buildDir) && !F.isInside(project.dir, buildDir)) {
        failBuild('build.out fora do projeto: ' + buildDir);
    }
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.mkdirSync(buildDir, { recursive: true });

    const plan = planAssets(project);
    if (!plan.scripts.length) warnings.push({ code: 'build.scripts', path: 'Assets/Scripts', message: 'nenhum script de componente' });

    // dados das cenas
    const built = buildScenes(project, plan, warnings);
    const startKey = project.data.startScene ? built.keyByGuid.get(project.data.startScene) : null;
    if (!startKey) failBuild('cena inicial nao resolvida');

    // so entra no pacote o asset que alguma cena carrega
    const used = new Set();
    for (const sc of Object.values(built.scenes)) for (const g of sc.load) used.add(g);
    const assetsObj = {};
    for (const [guid, a] of plan.byGuid) if (used.has(guid)) assetsObj[guid] = a;
    const copies = plan.copies.filter((c) => used.has(c.guid));
    const data = { format: 1, assets: assetsObj, start: startKey, scenes: built.scenes };

    // copia assets e scripts
    for (const c of copies) {
        fs.copyFileSync(c.from, path.join(buildDir, c.to));
    }
    for (const s of plan.scripts) {
        fs.copyFileSync(s.asset.absPath, path.join(buildDir, s.file));
    }

    // app.json (antes do lint; o manifesto vem do projeto)
    const p = project.data;
    const app = {
        name: p.name,
        packageName: p.packageName,
        version: p.version,
        author: p.author || 'Celer Studio',
        description: p.description || '',
        type: p.type || 'Game',
        category: p.category || 'Jogos',
        api: p.api,
        requires: p.requires || [],
        topbar: p.topbar === undefined ? false : !!p.topbar,
        permissions: p.permissions || [],
        deps: p.deps || {},
        changelog: p.changelog || (p.version + ': build do Celer Studio'),
    };
    F.writeJson(path.join(buildDir, 'app.json'), app);

    // icone
    const icon = path.join(project.dir, 'icon.png');
    if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(buildDir, 'icon.png'));
    else {
        try {
            const { makeIconPng } = require('../../sdk/lib/icon.js');
            fs.writeFileSync(path.join(buildDir, 'icon.png'), makeIconPng(p.name[0] || 'C'));
        } catch (e) { /* opcional */ }
    }

    // game.data.js (divide cenas se passar do splitKB)
    const splitKB = p.build && p.build.splitKB ? p.build.splitKB : 96;
    const dataJson = JSON.stringify(data);
    const dataFiles = [];
    if (dataJson.length <= splitKB * 1024) {
        F.writeText(path.join(buildDir, 'game.data.js'), 'module.exports = ' + dataJson + ';\n');
        dataFiles.push('game.data.js');
    } else {
        const head = JSON.stringify({ format: 1, assets: assetsObj, start: startKey });
        const parts = [];
        let cur = {}, curSize = 2;
        const names = Object.keys(built.scenes).sort();
        for (const name of names) {
            const json = JSON.stringify(built.scenes[name]);
            if (json.length > 240 * 1024) {
                failBuild('cena "' + name + '" tem ' + (json.length / 1024).toFixed(0) +
                          'KB (limite do require 256KB): reduza tilemaps/entidades');
            }
            if (curSize + json.length > splitKB * 1024 && Object.keys(cur).length) {
                parts.push(cur);
                cur = {};
                curSize = 2;
            }
            cur[name] = built.scenes[name];
            curSize += json.length + name.length + 8;
        }
        if (Object.keys(cur).length) parts.push(cur);
        let index = '// GERADO POR CELER STUDIO — partes de cenas\nvar out = ' + head + ';\nout.scenes = {};\nvar p;\n';
        parts.forEach((part, i) => {
            const file = 'game.data.' + i + '.js';
            F.writeText(path.join(buildDir, file), 'module.exports = ' + JSON.stringify(part) + ';\n');
            dataFiles.push(file);
            index += 'p = require("game.data.' + i + '");\nfor (var k' + i + ' in p) out.scenes[k' + i + '] = p[k' + i + '];\n';
        });
        index += 'module.exports = out;\n';
        F.writeText(path.join(buildDir, 'game.data.js'), index);
        dataFiles.unshift('game.data.js');
    }

    // main.js com o runtime embutido
    F.writeText(path.join(buildDir, 'main.js'), generateMain(project));

    // limites de pacote (extras = tudo menos app.json/main.js/icon.png)
    const extras = dataFiles.length + plan.scripts.length + copies.length;
    if (extras > 16) {
        failBuild('pacote com ' + extras + ' extras (maximo 16): reduza assets/scripts');
    }
    if (extras >= 14) warnings.push({ code: 'package.extras', path: 'pacote',
                                      message: extras + ' extras (limite 16)' });

    let assetBytes = 0;
    for (const c of copies) assetBytes += fs.statSync(path.join(buildDir, c.to)).size;
    if (assetBytes > 256 * 1024) failBuild('assets somam ' + (assetBytes / 1024).toFixed(1) + 'KB (maximo 256KB)');

    // JS enxuto (mesmo criterio do hub)
    const jsFiles = ['main.js'].concat(dataFiles).concat(plan.scripts.map((s) => s.file));
    let jsTotal = 0;
    const jsSizes = {};
    for (const f of jsFiles) {
        const src = fs.readFileSync(path.join(buildDir, f), 'utf8');
        const n = stripSize(src);
        jsSizes[f] = n;
        jsTotal += n;
        if (n > 256 * 1024) failBuild(f + ' tem ' + (n / 1024).toFixed(1) + 'KB (limite do require 256KB)');
        if (n > 30 * 1024 && (p.api || 0) < 6) failBuild(f + ' > 30KB exige api >= 6');
    }
    const psram = (p.requires || []).indexOf('psram') >= 0;
    const ceiling = psram ? 1024 * 1024 : 48 * 1024;
    if (jsTotal > ceiling) {
        failBuild('JS enxuto soma ' + (jsTotal / 1024).toFixed(1) + 'KB (teto ' +
                  (psram ? '1MB' : '48KB sem psram'));
    }
    if (psram && jsTotal > 900 * 1024) {
        warnings.push({ code: 'build.size', path: 'pacote',
                        message: 'JS perto do teto de 1MB: ' + (jsTotal / 1024).toFixed(0) + 'KB' });
    }

    // app_lint no pacote final (ES5, API, limites, deps)
    const { runLint } = require('../../app_lint/lint.js');
    const lint = runLint([buildDir], {});
    const lintErrors = [];
    for (const a of lint.apps) {
        for (const d of a.diagnostics) {
            if (d.severity === 'erro') lintErrors.push(d);
            else warnings.push({ code: 'lint.' + d.rule, path: d.file + ':' + d.line, message: d.message });
        }
    }
    if (lintErrors.length) {
        throw new F.StudioError('build.lint', 'app_lint reprovou o build (' + lintErrors.length + ' erro(s))',
            { diagnostics: lintErrors });
    }

    // relatorio (cache)
    const report = {
        ts: Date.now(), dir: buildDir, app: app.packageName, version: app.version,
        extras: extras, jsBytes: jsTotal, jsSizes: jsSizes, assetBytes: assetBytes,
        files: fs.readdirSync(buildDir).sort(), warnings: warnings,
    };
    F.writeJson(path.join(project.studioDir, 'report.json'), report);

    return {
        ok: true, dir: buildDir, app: app.packageName, version: app.version,
        files: report.files, extras: extras, jsBytes: jsTotal, assetBytes: assetBytes,
        warnings: warnings, dataFiles: dataFiles, scripts: plan.scripts.map((s) => s.file),
    };
}

function exportBuild(dir, target, opts) {
    opts = opts || {};
    const project = Project.open(dir);
    const buildDir = project.buildDir();
    if (!fs.existsSync(buildDir)) failBuild('build ainda nao existe: rode `studio build`');
    const abs = path.resolve(target);
    if (F.isInside(buildDir, abs)) {
        F.fail('export.inside', 'destino contem o build: ' + abs, { path: abs });
    }
    let exists = false;
    try { exists = fs.readdirSync(abs).length > 0; } catch (e) { exists = false; }
    if (exists && !opts.force) {
        F.fail('export.exists', 'destino nao vazio: ' + abs + ' (use --force)', { path: abs });
    }
    fs.mkdirSync(abs, { recursive: true });
    fs.cpSync(buildDir, abs, { recursive: true });
    return { ok: true, dir: abs, files: fs.readdirSync(abs).sort() };
}

module.exports = { buildProject, exportBuild, collectUsed, planAssets, buildScenes, generateMain };
