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
const { resolveLocal } = require('./deps');
const { strip } = require('../../sdk/lib/jsstrip.js');
const jsmin = require('../../sdk/lib/jsmin.js');

const RUNTIME = fs.readFileSync(path.join(__dirname, '..', 'templates', 'runtime.js'), 'utf8');
const APP_RUNTIME = fs.readFileSync(path.join(__dirname, '..', 'templates', 'app_runtime.js'), 'utf8');
const LEGACY = fs.readFileSync(path.join(__dirname, '..', 'templates', 'legacy.js'), 'utf8');
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
    const app = project.data.runtime === 'app';
    const dataFile = app ? 'app.data.js' : 'game.data.js';
    const usedNames = new Set(['main.js', 'app.json', 'icon.png', dataFile]);
    for (let i = 0; i < 16; i++) usedNames.add(dataFile.replace(/\.js$/, '.' + i + '.js'));
    const byGuid = new Map();
    const copies = [];
    const scripts = [];
    const assets = project.assets.slice().sort((a, b) => F.cmpStr(a.relPath, b.relPath));
    // nome de SLOT no runtime (A[an].n / E.spr): dois assets com o mesmo
    // basename (hero.png + hero.wav, ou .png em pastas distintas colidindo
    // antes do rename de arquivo) se sobrescreviam no byName do runtime
    const usedSlots = new Set();

    for (const a of assets) {
        if (!isShipped(a.kind)) continue;
        let srcName = F.sanitizeFileName(a.fileName);
        // o engine appenda ".png" em load/sheet: no device (LittleFS
        // case-sensitive) um arquivo `Foo.PNG` nunca seria encontrado
        if (/\.png$/i.test(srcName)) srcName = srcName.replace(/\.png$/i, '.png');
        const outName = F.uniqueName(srcName, usedNames);
        const slot = F.uniqueName(outName.replace(/\.[^.]+$/, ''), usedSlots);
        if (a.kind === 'script') {
            const base = 's.' + F.slug(a.name) + '.js';
            const modFile = F.uniqueName(base, usedNames);
            scripts.push({ asset: a, file: modFile, module: modFile.slice(0, -3) });
            continue;
        }
        const n = slot;
        // o engine anexa ".png" em load/sheet: o asset guarda o nome SEM ext
        const graphicFile = outName.replace(/\.png$/i, '');
        const st = a.meta.settings || {};
        if (a.kind === 'audio') {
            byGuid.set(a.guid, { t: 'a', n: n, f: outName });
        } else if (app) {
            // modo programa: imagem unica desenhada por drawPNG (nao ha E.spr)
            if ((st.mode || 'single') !== 'single') {
                failBuild('modo app aceita so imagem de quadro unico: ' + a.name +
                          ' (mode ' + (st.mode || 'single') + ')');
            }
            byGuid.set(a.guid, { t: 'img', n: n, f: outName, w: st.w || 0, h: st.h || 0 });
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

// cores de widget viram numero 565; vazio/ausente = default do tema no runtime
const WIDGET_COLORS = {
    text: ['color', 'bg'],
    card: ['color', 'stroke'],
    badge: ['color', 'textColor'],
    image: ['key'],
};

function convertWidget(project, plan, c, at, load) {
    const kind = c.type.slice(3);
    const f = Object.assign({}, c.fields || {});
    for (const k of (WIDGET_COLORS[kind] || [])) {
        if (typeof f[k] === 'string' && f[k]) f[k] = F.parseColor(f[k]);
        else delete f[k];
    }
    if (kind === 'image') {
        const asset = project.asset(f.asset);
        if (!asset) failBuild('imagem inexistente em ' + at + ': ' + f.asset);
        const ra = plan.byGuid.get(asset.guid);
        if (!ra || ra.t !== 'img') failBuild('asset grafico nao entrou no build: ' + asset.name);
        load.add(asset.guid);
        f.asset = ra;
    }
    return { t: 'ui', k: kind, id: c.id || '', f: f };
}

function convertAi(c) {
    const f = Object.assign({}, c.fields || {});
    if (!f.provider) f.provider = 'openrouter';
    // strings vazias opcionais: o runtime testa truthiness, mas o data fica menor
    for (const k of ['model', 'busyKey', 'errorKey', 'histKey', 'system', 'attach',
                     'prompt', 'promptKey', 'text', 'textKey', 'label', 'event']) {
        if (f[k] === '') delete f[k];
    }
    if (c.type === 'mic.record') return { t: 'ui', k: 'mic.record', id: c.id || '', f: f };
    return { t: 'ai', k: c.type.slice(3), id: c.id || '', f: f };
}

function convertComponent(project, plan, c, at, load) {
    const f = c.fields || {};
    if (c.type.indexOf('ui.') === 0) return convertWidget(project, plan, c, at, load);
    if (c.type.indexOf('ai.') === 0 || c.type === 'mic.record') return convertAi(c);
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
    if (c.type === 'data') {
        return { t: 'data', fields: f.fields || {} };
    }
    if (c.type === 'script') {
        const asset = project.asset(f.script);
        if (!asset) failBuild('script inexistente em ' + at + ': ' + f.script);
        const sc = plan.scripts.find((x) => x.asset.guid === asset.guid);
        if (!sc) failBuild('script nao entrou no build: ' + asset.name);
        // defaults de exports.props <- campos do componente (campos vencem)
        const props = (asset.meta.settings || {}).props || {};
        const fields = require('./scripts').mergeFields(props, f.fields || {});
        return { t: 'script', m: sc.module, id: c.id || '', fields: fields };
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

function screenScripts(project, plan, refs, sceneName) {
    const out = [];
    for (const ref of refs || []) {
        const a = project.asset(ref);
        if (!a) failBuild('script de tela inexistente em "' + sceneName + '": ' + ref);
        if (a.kind !== 'script') failBuild('settings.scripts aceita so script: ' + a.name);
        const sc = plan.scripts.find((x) => x.asset.guid === a.guid);
        if (!sc) failBuild('script de tela nao entrou no build: ' + a.name);
        // props declarados viram o `fields` do script de tela
        const fields = require('./scripts').propsDefaults((a.meta.settings || {}).props || {});
        out.push(Object.keys(fields).length ? { m: sc.module, f: fields } : sc.module);
    }
    return out;
}

function buildScenes(project, plan, warnings, opts) {
    const app = !!(opts && opts.app);
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
        if (app) {
            // programa: nao ha tilemap/camera; a tela e so widgets
            if ((sc.tilemaps || []).length) {
                failBuild('modo app nao aceita tilemap (cena "' + sc.name + '")');
            }
        } else {
        for (const tm of sc.tilemaps || []) {
            const asset = project.asset(tm.tileset);
            const ra = asset ? plan.byGuid.get(asset.guid) : null;
            if (!asset || !ra) failBuild('tileset do build nao resolvido: ' + tm.tileset);
            // load usa GUID: a referencia pode vir como "guid#regiao"
            load.add(asset.guid);
            const tileDefs = (asset.meta.settings && Array.isArray(asset.meta.settings.tiles))
                ? asset.meta.settings.tiles : null;
            const solidValues = tileDefs && tileDefs.some((t) => t && t.solid)
                ? tileDefs.map((t) => !!(t && t.solid)) : null;
            tilemaps.push({
                id: tm.id, tileset: asset.guid, cols: tm.cols, rows: tm.rows,
                cell: tm.cell, ox: tm.ox || 0, oy: tm.oy || 0, layer: tm.layer || 0,
                data: tm.data, solids: tm.solids || null, solidValues: solidValues,
                autotile: tm.autotile || null,
            });
        }
        }
        // musica aceita GUID ou nome no settings; o runtime indexa por GUID
        let music = null;
        if (st.music) {
            const ma = project.asset(st.music);
            if (ma) { music = ma.guid; load.add(ma.guid); }
        }
        for (const ref of st.assets || []) {
            const a = project.asset(ref);
            if (a) load.add(a.guid);
            else warnings.push({ code: 'scene.asset', path: 'cena ' + sc.name,
                                 message: 'asset da cena nao encontrado: ' + ref });
        }

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
            title: sc.name,
            data: st.data || {},
            fps: st.fps !== undefined ? st.fps : (project.data.canvas.fps || 30),
            static: st.static ? true : false,
            bg: F.parseColor(st.bg, 0x0000),
            camera: st.camera ? {
                bounds: st.camera.bounds || null,
                follow: follow,
                deadzone: st.camera.deadzone || null,
            } : null,
            music: music,
            load: Array.from(load).sort(),
            entities: ctx.entities,
            tilemaps: tilemaps,
        };
        if (app) {
            // tela de programa: sem camera/tilemaps e com estado+scripts de tela
            const def = out[key];
            delete def.camera;
            delete def.tilemaps;
            delete def.static;
            if (st.bg) def.bg = F.parseColor(st.bg);
            else delete def.bg;      // ausente = tema do sistema no runtime
            def.header = st.header === undefined ? true : !!st.header;
            if (st.sub) def.sub = st.sub;
            if (st.persist) def.persist = st.persist;
            const scripts = screenScripts(project, plan, st.scripts, sc.name);
            if (scripts.length) def.scripts = scripts;
        }
    }
    const names = {};
    for (const key of Object.keys(out)) {
        const title = out[key].title;
        if (Object.prototype.hasOwnProperty.call(names, title) && names[title] !== key) {
            // E.goto(title) ficaria ambiguo e o mapa `names` perderia uma cena
            failBuild('duas cenas com o mesmo nome: ' + title);
        }
        names[title] = key;
    }
    return { scenes: out, keyByGuid, names };
}

// bases de asset: o celerctl instala a pasta com F.slug(packageName)
// (ex.: celeros.detona -> /sd/apps/celeros_detona), enquanto o app original
// usa o packageName e o nome. Inclui as quatro variantes para o mesmo app
// rodar no Studio, no cartao e no /local.
function assetBases(p) {
    const names = [];
    for (const n of [p.packageName, String(p.name), F.slug(p.packageName), F.slug(String(p.name))]) {
        if (n && names.indexOf(n) < 0) names.push(n);
    }
    const bases = [];
    for (const d of ['/local/apps/', '/sd/apps/']) for (const n of names) bases.push(d + n + '/');
    return bases;
}

function generateMain(project, opts) {
    const deps = Object.keys(project.data.deps || {}).sort();
    const req = new Set(['celeros.game', 'celeros.game.spr', 'celeros.game.tilemap']);
    for (const d of deps) if (d.indexOf('celeros.game.') === 0) req.add(d);
    let src = HEADER;
    const ordered = Array.from(req).sort((a, b) => (a === 'celeros.game' ? -1 : (b === 'celeros.game' ? 1 : F.cmpStr(a, b))));
    for (const d of ordered) {
        src += (d === 'celeros.game' ? 'var E = ' : '') + 'require("' + d + '");\n';
    }
    const p = project.data;
    // nome do projeto e dado livre: JSON.stringify escapa aspas, barra
    // invertida e quebra de linha (o replace de `"` sozinho gerava JS invalido)
    const name = String(p.name);
    src += '\nE.init({ dir: ' + JSON.stringify(name) + ', fps: ' + (p.canvas.fps !== undefined ? p.canvas.fps : 30) +
           ', native: ' + (p.canvas.native ? 'true' : 'false') +
           ', save: "' + F.slug(p.name, 6) + '."' +
           (p.deps && p.deps['celeros.game.fx'] ? ', particles: 96' : '') +
           ',\n         bases: ' + JSON.stringify(assetBases(p)) + ' });\n';
    if (p.editor && p.editor.debug) src += 'E.debug = true;\n';
    if (p.editor && p.editor.prof) src += 'if (E.prof) E.prof.on = true;\n';
    src += '\n';
    src += RUNTIME;
    src += '\nstudioBoot(E, require("game.data"));\n';
    return src;
}

// Runtime de programa: sem engine, sem E.init. O Kui e o proprio OS; o app
// so precisa das bases de asset (drawPNG) e do data. Nenhum require de dep.
function generateAppMain(project) {
    const p = project.data;
    let src = HEADER;
    src += APP_RUNTIME;
    src += '\nstudioAppBoot(require("app.data"), ' + JSON.stringify(assetBases(p)) + ');\n';
    return src;
}

// tamanho que o deploy vai empacotar: minificado (jsmin) com o mesmo
// criterio por arquivo — modulo (qualquer != main.js) tem o topo manglado.
// Sem o `reserved` dos irmaos aqui: medir MAIOR que o pacote real e o lado
// seguro do teto (o deploy recalcula com o reserved de verdade).
function stripSize(src, name) {
    try {
        return Buffer.byteLength(jsmin.minify(src, { top: name && name !== 'main.js' }).code, 'utf8');
    } catch (e) {
        try { return Buffer.byteLength(strip(src), 'utf8'); }
        catch (e2) { return Buffer.byteLength(src, 'utf8'); }
    }
}

// Lock das deps compartilhadas no proprio pacote. O require do device le
// <pasta>/deps.json para achar /local/modules; sem ele um app instalado pelo
// zip (installzip/App Store) nao abre. Grava depois do lint para nao contar
// como extra.
function writeDepsLock(project, buildDir) {
    const direct = project.data.deps || {};
    const file = path.join(buildDir, 'deps.json');
    if (!Object.keys(direct).length) {
        try { fs.rmSync(file, { force: true }); } catch (e) { /* sem lock */ }
        return {};
    }
    let lock;
    try { lock = resolveLocal(direct); }
    catch (e) { failBuild('deps do app nao resolvem na arvore local: ' + e.message); }
    F.writeJson(file, lock);
    return lock;
}

function generateLegacyMain(project) {
    const p = project.data;
    const deps = Object.keys(p.deps || {}).sort();
    const req = new Set(['celeros.game']);
    for (const d of deps) if (d.indexOf('celeros.game.') === 0) req.add(d);
    let src = HEADER;
    const ordered = Array.from(req).sort((a, b) => (a === 'celeros.game' ? -1 : (b === 'celeros.game' ? 1 : F.cmpStr(a, b))));
    for (const d of ordered) src += (d === 'celeros.game' ? 'var E = ' : '') + 'require("' + d + '");\n';
    src += '\n' + LEGACY + '\n';
    const bases = (p.legacy && p.legacy.bases) || [];
    src += 'legacyBoot(E, { entry: "legacy.main", pkg: ' + JSON.stringify(p.packageName) +
           ', bases: ' + JSON.stringify(bases) + ' });\n';
    return src;
}

function buildLegacy(project, check, warnings, buildDir) {
    const p = project.data;
    const legacy = p.legacy || {};
    const entry = legacy.entry;
    const scripts = project.assets.filter((a) => a.kind === 'script')
        .sort((a, b) => F.cmpStr(a.relPath, b.relPath));
    const entryAsset = scripts.find((a) => a.fileName === entry || a.name === String(entry).replace(/\.js$/, ''));
    if (!entryAsset) failBuild('script de entrada do modo legado nao encontrado: ' + entry);

    const used = new Set(['main.js', 'app.json', 'icon.png']);
    const scriptFiles = [];
    for (const a of scripts) {
        if (a.fileName === 'test.js') continue;   // dev-only no app original
        const out = a.fileName === entryAsset.fileName ? 'legacy.main.js' : a.fileName;
        if (!/^[A-Za-z0-9_.-]{1,63}\.js$/.test(out)) {
            failBuild('script com nome invalido para o pacote: ' + out);
        }
        if (used.has(out.toLowerCase())) failBuild('dois arquivos com o mesmo nome: ' + out);
        used.add(out.toLowerCase());
        fs.copyFileSync(a.absPath, path.join(buildDir, out));
        scriptFiles.push(out);
    }

    const copies = [];
    const assets = project.assets.filter((a) => isShipped(a.kind) && a.kind !== 'script')
        .sort((a, b) => F.cmpStr(a.relPath, b.relPath));
    let assetBytes = 0;
    for (const a of assets) {
        if (a.fileName === 'icon.png') continue;   // icone do projeto
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(a.fileName)) {
            failBuild('asset com nome invalido para o pacote: ' + a.fileName);
        }
        if (used.has(a.fileName.toLowerCase())) failBuild('dois arquivos com o mesmo nome: ' + a.fileName);
        used.add(a.fileName.toLowerCase());
        fs.copyFileSync(a.absPath, path.join(buildDir, a.fileName));
        copies.push(a.fileName);
        assetBytes += a.size;
    }
    if (assetBytes > 256 * 1024) {
        failBuild('assets somam ' + (assetBytes / 1024).toFixed(1) + 'KB (maximo 256KB)');
    }

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
        changelog: p.changelog || (p.version + ': build do Celer Studio (legado)'),
    };
    F.writeJson(path.join(buildDir, 'app.json'), app);

    const icon = path.join(project.dir, 'icon.png');
    if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(buildDir, 'icon.png'));
    else {
        try {
            const { makeIconPng } = require('../../sdk/lib/icon.js');
            fs.writeFileSync(path.join(buildDir, 'icon.png'), makeIconPng(p.name[0] || 'C'));
        } catch (e) { /* opcional */ }
    }

    F.writeText(path.join(buildDir, 'main.js'), generateLegacyMain(project));

    const extras = scriptFiles.length + copies.length +
        (Object.keys(p.deps || {}).length ? 1 : 0);   // deps.json conta extra
    if (extras > 16) failBuild('pacote com ' + extras + ' extras (maximo 16): reduza scripts/assets');
    if (extras >= 14) warnings.push({ code: 'package.extras', path: 'pacote', message: extras + ' extras (limite 16)' });

    const jsFiles = ['main.js'].concat(scriptFiles);
    let jsTotal = 0;
    const jsSizes = {};
    for (const f of jsFiles) {
        const src = fs.readFileSync(path.join(buildDir, f), 'utf8');
        const n = stripSize(src, f);
        jsSizes[f] = n;
        jsTotal += n;
        if (n > 256 * 1024) failBuild(f + ' tem ' + (n / 1024).toFixed(1) + 'KB (limite do require 256KB)');
        if (n > 30 * 1024 && (p.api || 0) < 6) failBuild(f + ' > 30KB exige api >= 6');
    }
    const psram = (p.requires || []).indexOf('psram') >= 0;
    const ceiling = psram ? 1024 * 1024 : 64 * 1024;
    if (jsTotal > ceiling) {
        failBuild('JS enxuto soma ' + (jsTotal / 1024).toFixed(1) + 'KB (teto ' +
                  (psram ? '1MB' : '64KB sem psram'));
    }

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
        throw new F.StudioError('build.lint', 'app_lint reprovou o build legado (' + lintErrors.length + ' erro(s))',
            { diagnostics: lintErrors });
    }

    const depsLock = writeDepsLock(project, buildDir);
    const report = {
        ts: Date.now(), dir: buildDir, app: app.packageName, version: app.version,
        runtime: 'legacy', entry: entry, extras: extras, jsBytes: jsTotal, jsSizes: jsSizes,
        assetBytes: assetBytes, deps: depsLock,
        files: fs.readdirSync(buildDir).sort(), warnings: warnings,
    };
    F.writeJson(path.join(project.studioDir, 'report.json'), report);

    return {
        ok: true, dir: buildDir, app: app.packageName, version: app.version,
        runtime: 'legacy', entry: entry, files: report.files, extras: extras,
        jsBytes: jsTotal, assetBytes: assetBytes, deps: depsLock, warnings: warnings,
        dataFiles: [], scripts: scriptFiles,
    };
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
    if (project.data.runtime === 'legacy') return buildLegacy(project, check, warnings, buildDir);
    const isApp = project.data.runtime === 'app';
    const dataFile = isApp ? 'app.data.js' : 'game.data.js';

    const plan = planAssets(project);
    if (!plan.scripts.length) warnings.push({ code: 'build.scripts', path: 'Assets/Scripts', message: 'nenhum script de componente' });

    // dados das cenas
    const built = buildScenes(project, plan, warnings, { app: isApp });
    const startKey = project.data.startScene ? built.keyByGuid.get(project.data.startScene) : null;
    if (!startKey) failBuild('cena inicial nao resolvida');

    // so entra no pacote o asset que alguma cena carrega
    const used = new Set();
    for (const sc of Object.values(built.scenes)) for (const g of sc.load) used.add(g);
    const assetsObj = {};
    for (const [guid, a] of plan.byGuid) if (used.has(guid)) assetsObj[guid] = a;
    const copies = plan.copies.filter((c) => used.has(c.guid));
    const data = { format: 1, assets: assetsObj, start: startKey,
                   names: built.names, scenes: built.scenes };

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
        type: p.type || (isApp ? 'App' : 'Game'),
        category: p.category || (isApp ? 'Utility' : 'Jogos'),
        api: p.api,
        requires: p.requires || [],
        topbar: p.topbar === undefined ? false : !!p.topbar,
        permissions: p.permissions || [],
        deps: p.deps || {},
        changelog: p.changelog || (p.version + ': build do Celer Studio'),
    };
    // o app_lint recusa `deps: {}` (campo vazio e ruido no manifesto); o
    // runtime app normalmente nao tem dep nenhuma
    if (app.deps && !Object.keys(app.deps).length) delete app.deps;
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

    // dados (game.data.js ou app.data.js; divide cenas se passar do splitKB)
    const splitKB = p.build && p.build.splitKB ? p.build.splitKB : 96;
    const dataBase = dataFile.replace(/\.js$/, '');
    const dataJson = JSON.stringify(data);
    const dataFiles = [];
    if (dataJson.length <= splitKB * 1024) {
        F.writeText(path.join(buildDir, dataFile), 'module.exports = ' + dataJson + ';\n');
        dataFiles.push(dataFile);
    } else {
        const head = JSON.stringify({ format: 1, assets: assetsObj, start: startKey,
                                      names: built.names });
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
            const file = dataBase + '.' + i + '.js';
            F.writeText(path.join(buildDir, file), 'module.exports = ' + JSON.stringify(part) + ';\n');
            dataFiles.push(file);
            index += 'p = require("' + dataBase + '.' + i + '");\nfor (var k' + i + ' in p) out.scenes[k' + i + '] = p[k' + i + '];\n';
        });
        index += 'module.exports = out;\n';
        F.writeText(path.join(buildDir, dataFile), index);
        dataFiles.unshift(dataFile);
    }

    // main.js com o runtime embutido (cenas de jogo ou telas de programa)
    F.writeText(path.join(buildDir, 'main.js'), isApp ? generateAppMain(project) : generateMain(project));

    // limites de pacote (extras = tudo menos app.json/main.js/icon.png;
    // deps.json conta como extra porque o hub o inclui no teto)
    const extras = dataFiles.length + plan.scripts.length + copies.length +
        (Object.keys(p.deps || {}).length ? 1 : 0);
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
        const n = stripSize(src, f);
        jsSizes[f] = n;
        jsTotal += n;
        if (n > 256 * 1024) failBuild(f + ' tem ' + (n / 1024).toFixed(1) + 'KB (limite do require 256KB)');
        if (n > 30 * 1024 && (p.api || 0) < 6) failBuild(f + ' > 30KB exige api >= 6');
    }
    const psram = (p.requires || []).indexOf('psram') >= 0;
    const ceiling = psram ? 1024 * 1024 : 64 * 1024;
    if (jsTotal > ceiling) {
        failBuild('JS enxuto soma ' + (jsTotal / 1024).toFixed(1) + 'KB (teto ' +
                  (psram ? '1MB' : '64KB sem psram'));
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

    const depsLock = writeDepsLock(project, buildDir);
    // relatorio (cache)
    const report = {
        ts: Date.now(), dir: buildDir, app: app.packageName, version: app.version,
        extras: extras, jsBytes: jsTotal, jsSizes: jsSizes, assetBytes: assetBytes,
        deps: depsLock,
        files: fs.readdirSync(buildDir).sort(), warnings: warnings,
    };
    F.writeJson(path.join(project.studioDir, 'report.json'), report);

    return {
        ok: true, dir: buildDir, app: app.packageName, version: app.version,
        files: report.files, extras: extras, jsBytes: jsTotal, assetBytes: assetBytes,
        deps: depsLock, warnings: warnings, dataFiles: dataFiles,
        scripts: plan.scripts.map((s) => s.file),
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
    // copiar para DENTRO do projeto injetava o build como "assets sem .meta"
    // (Assets/) ou sobrescrevia a raiz: o scan bricava o barramento de ops
    if (abs === project.dir || F.isInside(path.join(project.dir, 'Assets'), abs) ||
        F.isInside(path.join(project.dir, '.studio'), abs)) {
        F.fail('export.inside', 'destino nao pode ser dentro do projeto/Assets/.studio: ' + abs,
               { path: abs });
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
