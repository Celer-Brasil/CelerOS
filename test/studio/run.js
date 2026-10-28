#!/usr/bin/env node
// Testes do Celer Studio: formato canonico, import de asset, barramento de
// ops (dry-run/atomicidade/undo), build determinista, runtime no harness,
// prefab achatado e equivalencia CLI x API HTTP.
//
// Uso: node test/studio/run.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const { Project } = require('../../tools/studio/lib/project');
const { applyOps, undo, redo } = require('../../tools/studio/lib/ops');
const { validateProject } = require('../../tools/studio/lib/validate');
const { buildProject } = require('../../tools/studio/lib/build');
const { deployProject } = require('../../tools/studio/lib/deploy');
const { readZip } = require('../../tools/studio/lib/zip');
const { runProject } = require('../../tools/studio/lib/run');
const { runAppFolder } = require('../../tools/sdk/lib/runner.js');
const { startStudio } = require('../../tools/studio/server');
const { importGame } = require('../../tools/studio/lib/import_game');
const { encodePng, decodePng } = require('../../tools/sdk/lib/png.js');
const F = require('../../tools/studio/lib/format');

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok || !detail ? '' : ' — ' + detail));
    if (!ok) failures++;
}

function tmpDir(tag) {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'celer-studio-' + (tag || '') + '-'));
}

function makeAtlas(file) {
    const S = 64;
    const px = Buffer.alloc(S * S * 3);
    const cols = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const q = (y >= 32 ? 2 : 0) + (x >= 32 ? 1 : 0);
            const i = (y * S + x) * 3;
            px[i] = cols[q][0]; px[i + 1] = cols[q][1]; px[i + 2] = cols[q][2];
        }
    }
    fs.writeFileSync(file, encodePng(S, S, px, false));
}

function pngSize(file) {
    const b = fs.readFileSync(file);
    return b.length > 24 && b[0] === 0x89 && b[1] === 0x50;
}

function jsonNoMeta(obj) {
    const o = JSON.parse(JSON.stringify(obj));
    delete o.guid;
    delete o.rev;
    return o;
}

// require cache por caminho: o build regrava game.data.js e o require
// devolveria a versao antiga
function loadData(dir) {
    const file = path.join(dir, 'game.data.js');
    delete require.cache[require.resolve(file)];
    return require(file);
}

function httpJson(port, method, url, body) {
    return new Promise((resolve, reject) => {
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = http.request({ host: '127.0.0.1', port, method, path: url,
                                   headers: data ? { 'Content-Type': 'application/json',
                                                     'Content-Length': data.length } : {} },
            (res) => {
                const parts = [];
                res.on('data', (d) => parts.push(d));
                res.on('end', () => {
                    try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
                    catch (e) { reject(e); }
                });
            });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

// ---------------------------------------------------------------- init -----
const base = tmpDir('base');
(function () {
    console.log('Studio init:');
    const p = Project.init(base, { name: 'Teste Studio' });
    check('cria projeto + cena inicial',
        fs.existsSync(path.join(base, 'celergame.project.json')) &&
        fs.existsSync(path.join(base, 'Assets/Scenes/Principal.scene.json')));
    check('packageName valido', /^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(p.data.packageName), p.data.packageName);
    check('cena inicial aponta para a cena', p.data.startScene === p.sceneList()[0].guid);
    const d = require('../../tools/studio/studio.js').describe(base);
    check('describe lista cena e componentes', d.scenes.length === 1 && !!d.components.sprite && d.ops.length > 10);
})();

// --------------------------------------------------------------- import ----
const atlas = path.join(base, 'atlas.png');
makeAtlas(atlas);
let atlasGuid = null;
(function () {
    console.log('Studio import:');
    const r = applyOps(base, [{ op: 'asset.import', src: atlas, importer: 'tileset',
                                name: 'atlas', grid: '2x2', tw: 32, th: 32 }]);
    const a = r.results[0].asset;
    atlasGuid = a.guid;
    const p = Project.open(base);
    const asset = p.asset(a.guid);
    check('meta gerado com 4 regioes', p.regions(asset).length === 4,
          JSON.stringify(p.regions(asset).map((x) => x.name)));
    check('guid estavel de 32 hex', /^[0-9a-f]{32}$/.test(a.guid));
    check('validacao limpa', validateProject(p, {}).errors.length === 0);

    applyOps(base, [{ op: 'asset.set', asset: a.guid, settings: {
        pivot: [0.5, 1], key: '#ff00ff',
        anims: { idle: [1, 2] }, fps: { idle: 4 }, loop: { idle: true }, hitbox: [8, 8, 16, 16],
    } }]);
    const aa = Project.open(base).asset(a.guid);
    check('asset.set atualiza pivot/key/anims/hitbox', aa.meta.settings.key === '#ff00ff' &&
        aa.meta.settings.pivot[1] === 1 && aa.meta.settings.anims.idle.length === 2 &&
        aa.meta.settings.hitbox[2] === 16);
})();

(function () {
    console.log('Studio formato canonico:');
    const sc = F.readJson(path.join(base, 'Assets/Scenes/Principal.scene.json'));
    const once = F.canonicalJson(sc);
    check('canonicalJson e idempotente', once === F.canonicalJson(JSON.parse(once)));
    check('arquivo em disco ja e canonico', fs.readFileSync(
        path.join(base, 'Assets/Scenes/Principal.scene.json'), 'utf8') === once);
})();

// ------------------------------------------------------- ops / undo --------
(function () {
    console.log('Studio ops:');
    const sceneOps = [
        { op: 'scene.create', name: 'Fase 1' },
        { op: 'scene.start', scene: 'Fase 1' },
        { op: 'project.set', editor: { debug: true, prof: true }, canvas: { inset: 8 } },
        { op: 'entity.create', scene: 'Fase 1', fid: 'e_hero', name: 'Heroi', x: 80, y: 120 },
        { op: 'component.add', scene: 'Fase 1', entity: 'e_hero', type: 'sprite',
          fields: { sprite: atlasGuid + '#0' } },
        { op: 'script.set', name: 'mover',
          content: 'exports.update = function (dt, ctx) { ctx.entity.x += 30 * dt; };\n' },
        { op: 'component.add', scene: 'Fase 1', entity: 'e_hero', type: 'script',
          fields: { script: 'mover' } },
        // spr 1.6: animacao pelos metadados do atlas (E.spr.animOf)
        { op: 'component.add', scene: 'Fase 1', entity: 'e_hero', type: 'anim',
          fields: { meta: atlasGuid, current: 'idle' } },
        // core 1.5: HUD ancorado (E.anchor) + hitbox de metadado (E.spr.box)
        { op: 'entity.create', scene: 'Fase 1', fid: 'e_hud', name: 'HUD', x: 0, y: 0 },
        { op: 'component.add', scene: 'Fase 1', entity: 'e_hud', type: 'text',
          fields: { text: 'HUD', color: '#ffffff', px: 12 } },
        { op: 'component.add', scene: 'Fase 1', entity: 'e_hud', type: 'hud',
          fields: { anchor: 2, mx: 4, my: 4 } },
        { op: 'script.set', name: 'probe',
          content: 'exports.start = function (ctx) { var E = ctx.E, e = ctx.entity;' +
            ' System.print("HAS " + E.spr.has("atlas#1"));' +
            ' System.print("BOX " + JSON.stringify(e.box())); };\n' },
        { op: 'component.add', scene: 'Fase 1', entity: 'e_hero', type: 'script',
          fields: { script: 'probe' } },
        { op: 'entity.create', scene: 'Fase 1', fid: 'e_rotulo', name: 'Rotulo', x: 112, y: 20 },
        { op: 'component.add', scene: 'Fase 1', entity: 'e_rotulo', type: 'text',
          fields: { text: 'FASE 1', color: '#ffffff', px: 16, align: 'center' } },
        { op: 'tilemap.add', scene: 'Fase 1', tileset: atlasGuid, cols: 7, rows: 5, cell: 32,
          data: [3, 3, 3, 3, 3, 3, 3, 3, 1, 0, 0, 0, 1, 3, 3, 0, 2, 0, 0, 3, 3,
                 3, 3, 0, 0, 0, 3, 3, 3, 3, 3, 3, 3, 3, 3] },
    ];
    const before = fs.readdirSync(path.join(base, 'Assets/Scenes')).sort().join(',');
    const dry = applyOps(base, sceneOps, { dryRun: true });
    check('dry-run nao escreve', dry.dryRun === true &&
        fs.readdirSync(path.join(base, 'Assets/Scenes')).sort().join(',') === before);

    const bad = [
        { op: 'scene.create', name: 'Fase Ruim' },
        { op: 'entity.create', scene: 'Fase Ruim', fid: 'e_x', name: 'X' },
        { op: 'component.add', scene: 'Fase Ruim', entity: 'e_x', type: 'sprite',
          fields: { sprite: 'deadbeef' + '0'.repeat(24) + '#0' } },
    ];
    let failed = false;
    try { applyOps(base, bad, {}); } catch (e) { failed = e.code === 'validate.failed'; }
    check('lote invalido e atomico', failed &&
        !fs.existsSync(path.join(base, 'Assets/Scenes/Fase_Ruim.scene.json')));

    const r = applyOps(base, sceneOps, {});
    check('lote valido grava cena/projeto', r.changed.length >= 3, r.changed.join(','));
    const p = Project.open(base);
    const sc = p.scene('Fase 1');
    check('entidades e tilemap criados', sc.entities.length === 3 && sc.tilemaps.length === 1);
    check('startScene atualizado', p.data.startScene === sc.guid);

    const u = undo(p);
    check('undo remove a cena nova', !fs.existsSync(path.join(base, 'Assets/Scenes/Fase_1.scene.json')),
          u.changed.join(','));
    const p2 = Project.open(base);
    check('undo restaura o startScene', p2.sceneList().length === 1);
    redo(p2);
    const p3 = Project.open(base);
    check('redo recria a cena', !!p3.scene('Fase 1') && p3.sceneList().length === 2);

    // pincel do tilemap: o commit e um tilemap.set com data+solids
    const tm = p3.scene('Fase 1').tilemaps[0];
    const td = tm.data.slice();
    const ts = tm.solids.slice();
    td[0] = 2;
    ts[0] = true;
    applyOps(base, [{ op: 'tilemap.set', scene: 'Fase 1', tilemap: tm.id, data: td, solids: ts }], {});
    check('tilemap.set grava data+solids (commit do pincel)',
        Project.open(base).scene('Fase 1').tilemaps[0].data[0] === 2 &&
        Project.open(base).scene('Fase 1').tilemaps[0].solids[0] === true);

    applyOps(base, [{ op: 'tilemap.set', scene: 'Fase 1', tilemap: tm.id, cols: 8 }], {});
    const t3 = Project.open(base).scene('Fase 1').tilemaps[0];
    check('tilemap.set redimensiona preservando o canto e nasce vazio',
        t3.cols === 8 && t3.data.length === 40 && t3.data[0] === 2 && t3.data[39] === -1);
    applyOps(base, [
        { op: 'scene.set', scene: 'Fase 1', settings: { data: { a: 1, b: 2 } }, replace: ['data'] },
        { op: 'scene.set', scene: 'Fase 1', settings: { data: { a: 9 } }, replace: ['data'] },
    ], {});
    const sd = Project.open(base).scene('Fase 1').settings.data;
    check('scene.set replace troca data (nao mescla chaves antigas)', sd.a === 9 && sd.b === undefined,
        JSON.stringify(sd));
})();

// --------------------------------------------------------------- build -----
let built = null;
(function () {
    console.log('Studio build:');
    built = buildProject(base, {});
    check('app.json + main.js + data', ['app.json', 'main.js', 'game.data.js'].every(
        (f) => fs.existsSync(path.join(built.dir, f))));
    check('extras <= 16', built.extras <= 16, String(built.extras));
    const data = loadData(built.dir);
    check('build so leva o asset usado', Object.keys(data.assets).length === 1);
    check('cena inicial no data', data.start === 'fase_1', data.start);
    const assetData = data.assets[atlasGuid];
    check('asset leva metadados do spr 1.6 (pivot/anims/hitbox)',
        assetData && assetData.ax === 0.5 && assetData.ay === 1 &&
        assetData.cols === 2 && assetData.rows === 2 &&
        assetData.anims.idle.length === 2 && assetData.hitbox[2] === 16,
        JSON.stringify(assetData));
    const hero = data.scenes.fase_1.entities.find((e) => e.fid === 'e_hero');
    check('sprite resolvido para regiao', hero && hero.comps[0].s === 'atlas#0',
          hero && JSON.stringify(hero.comps[0]));
    const anim = hero && hero.comps.find((c) => c.t === 'anim');
    check('anim usa metadados (E.spr.animOf)', anim && anim.meta === 'atlas' && anim.current === 'idle');
    const hud = data.scenes.fase_1.entities.find((e) => e.fid === 'e_hud');
    check('HUD no data (E.anchor)', hud && hud.comps.some((c) => c.t === 'hud' && c.a === 2));
    const mainSrc = fs.readFileSync(path.join(built.dir, 'main.js'), 'utf8');
    check('debug/prof ligados no app gerado',
        mainSrc.indexOf('E.debug = true') >= 0 && mainSrc.indexOf('E.prof.on = true') >= 0);
    check('bases incluem a pasta slug do celerctl', mainSrc.indexOf('/sd/apps/' + F.slug(Project.open(base).data.packageName) + '/') >= 0);

    // deploy: JS enxuto, assets usados e zip deterministico/instalavel
    const depFile = path.join(base, '.studio/deploy/test-app.zip');
    const dep = deployProject(base, { noBuild: true, out: depFile });
    const entries = readZip(fs.readFileSync(depFile));
    const byName = new Map(entries.map((e) => [e.name, e.data.toString('utf8')]));
    check('deploy gera app.zip + report', fs.existsSync(depFile) &&
        fs.existsSync(path.join(base, '.studio/deploy/report.json')) && dep.bytes === fs.statSync(depFile).size);
    check('deploy tem app.json/main.js/icon na raiz', byName.has('app.json') &&
        byName.has('main.js') && entries.some((e) => e.name === 'icon.png'));
    check('deploy enxuga JS (jsstrip)', byName.get('main.js').indexOf('// GERADO') < 0 &&
        byName.get('main.js').indexOf('/*') < 0 && dep.js.after < dep.js.before);
    check('deploy inclui os assets referenciados e manifesto compacto',
        entries.some((e) => e.name === 'atlas.png') &&
        !byName.get('app.json').includes('\n'));
    const lock = JSON.parse(byName.get('deps.json') || '{}');
    const shared = [];
    let mr;
    const reReq = /require\(\s*["']([^"']+)["']\s*\)/g;
    while ((mr = reReq.exec(mainSrc)) !== null) {
        if (!byName.has(mr[1] + '.js')) shared.push(mr[1]);
    }
    check('deploy leva deps.json com todo require compartilhado',
        shared.length > 0 && shared.every((m) => !!lock[m]) &&
        lock['celeros.game'] && lock['celeros.game.spr'],
        JSON.stringify({ shared, lock }));
    const dep2 = deployProject(base, { noBuild: true, out: depFile });
    check('deploy deterministico (mesmo sha256)', dep2.sha256 === dep.sha256);
})();

// --------------------------------------------------------- runtime/run -----
(function () {
    console.log('Studio run:');
    const out = path.join(base, '.studio/run/tela.png');
    const r = runProject(base, { ms: 300, frames: '0,600', out: out });
    check('roda no harness sem erro', r.ok === true && !r.error, r.error || '');
    check('PNG valido 240x320', r.ok && pngSize(out) && r.w === 240 && r.h === 320);
    check('dois frames capturados', r.frames.length === 2, String(r.frames.length));
    check('probe viu os metadados do atlas e a hitbox',
        r.log.some((l) => l.indexOf('HAS true') >= 0) &&
        r.log.some((l) => l.indexOf('BOX [72,96,16,16]') >= 0),
        r.log.join(' | '));
    const shot = decodePng(fs.readFileSync(out));
    let hudPix = false;
    for (let y = 0; y < 22 && !hudPix; y++) {
        for (let x = 180; x < 240; x++) {
            const i = (y * shot.w + x) * 4;
            if (shot.rgba[i] > 200 && shot.rgba[i + 1] > 200 && shot.rgba[i + 2] > 200) { hudPix = true; break; }
        }
    }
    check('HUD ancorado no topo-direito (E.anchor)', hudPix);
    const ti = (20 * shot.w + 20) * 4;
    check('tilemap desenha a celula pelo canto (anchor 0)',
        shot.rgba[ti + 2] > 180 && shot.rgba[ti] < 80,
        JSON.stringify([shot.rgba[ti], shot.rgba[ti + 1], shot.rgba[ti + 2]]));
    let firstFrame = null;
    if (r.frames.length === 2) {
        const a = fs.readFileSync(r.frames[0].file);
        const b = fs.readFileSync(r.frames[1].file);
        firstFrame = b;
        check('script moveu a entidade (frames diferem)', !a.equals(b));
    }
    const r2 = runProject(base, { ms: 300, frames: '0,600', out: out });
    check('deterministico com a mesma seed',
        !!firstFrame && r2.ok && fs.readFileSync(r2.frames[1].file).equals(firstFrame));
    // paridade studio x harness: o MESMO build rodado pelo caminho do Studio
    // (runProject) e pelo caminho do harness/emu (runAppFolder direto, o que
    // `celer.js test`/emu usa) com a mesma seed captura os MESMOS quadros
    if (r2.ok && firstFrame) {
        const builtDir = Project.open(base).buildDir();
        const r3 = runAppFolder(builtDir, {
            render: true, stopAtMs: 300, frames: [0, 600], framesPng: true, seed: 7,
        });
        check('paridade studio x harness: mesmos quadros nos dois caminhos',
            r3.err === null && r3.frames.length === 2 &&
            r3.frames[1].png.equals(firstFrame),
            r3.err ? String(r3.err) : 'frames=' + r3.frames.length);
    }
})();

// -------------------------------------------------------------- prefab -----
(function () {
    console.log('Studio prefab:');
    const coin = {
        op: 'entity.create', scene: 'Fase 1', fid: 'e_moeda', name: 'Moeda', x: 150, y: 60, z: 6,
    };
    applyOps(base, [coin,
        { op: 'component.add', scene: 'Fase 1', entity: 'e_moeda', type: 'anim',
          fields: { clips: { idle: { frames: [atlasGuid + '#1', atlasGuid + '#2'], fps: 4, loop: true } },
                    current: 'idle' } },
        { op: 'prefab.create', name: 'moeda', scene: 'Fase 1', entity: 'e_moeda' },
        { op: 'prefab.instance', scene: 'Fase 1', prefab: 'moeda', fid: 'e_moeda2', x: 180, y: 180, z: 6 },
    ], {});
    let b = buildProject(base, {});
    let data = loadData(b.dir);
    let inst = data.scenes.fase_1.entities.filter((e) => e.fid.indexOf('e_moeda2/') === 0);
    check('instancia achatada em entidade de runtime', inst.length === 1, String(inst.length));
    check('z do prefab e local (instancia 6 + 0)', inst[0] && inst[0].z === 6, inst[0] && String(inst[0].z));
    check('overrides vazio nao vaza prefab', inst[0] && inst[0].comps[0].t === 'anim');

    const target = Project.open(base).prefab('moeda').entities[0].fid;
    applyOps(base, [{ op: 'prefab.override', scene: 'Fase 1', entity: 'e_moeda2',
                      target: target, transform: { x: 24 } }]);
    b = buildProject(base, {});
    data = loadData(b.dir);
    inst = data.scenes.fase_1.entities.filter((e) => e.fid.indexOf('e_moeda2/') === 0);
    check('override de transform soma na instancia', inst[0] && inst[0].x === 204,
          inst[0] && String(inst[0].x));
})();


// ------------------------------------------------------- native scenes ----
(function () {
    console.log('Studio cenas nativas:');
    const dir = tmpDir('native');
    Project.init(dir, { name: 'Nativa' });
    const atlasFile = path.join(dir, 'atlas.png');
    makeAtlas(atlasFile);
    let r = applyOps(dir, [
        { op: 'asset.import', src: atlasFile, importer: 'tileset', name: 'atlas',
          cols: 2, rows: 2, tw: 32, th: 32 },
    ]);
    const atlasId = r.results[0].asset.guid;
    r = applyOps(dir, [
        { op: 'asset.set', asset: atlasId,
          settings: { tiles: [{ name: '0', solid: false }, { name: '1', solid: true },
                              { name: '2', solid: true }, { name: '3', solid: false }] } },
        { op: 'script.set', name: 'ctrl', content:
            "exports.create = function (ctx) { return {}; };\n" +
            "exports.start = function (ctx) {\n" +
            "  var s = this, sc = ctx.scene;\n" +
            "  if (sc.data && sc.data.n === 7) {\n" +
            "    var map = sc.tm('mapa');\n" +
            "    var rect = sc.rectSolid(8, 8, 32, 32);\n" +
            "    var before = sc.solidAt(16, 16);\n" +
            "    if (map) map.set(0, 0, 0);\n" +
            "    var after = sc.solidAt(16, 16);\n" +
            "    if (typeof __harness !== 'undefined') __harness.native = {\n" +
            "      scene: sc.title, found: !!sc.find('hero'), map: !!map,\n" +
            "      asset: !!ctx.asset('atlas'), data: sc.data.n,\n" +
            "      before: before, after: after, rect: rect\n" +
            "    };\n" +
            "  } else if (typeof __harness !== 'undefined') {\n" +
            "    __harness.native = __harness.native || {};\n" +
            "    __harness.native.b = true;\n" +
            "    __harness.native.arg = ctx.arg && ctx.arg.hello;\n" +
            "  }\n" +
            "};\n" +
            "exports.update = function (dt, ctx) {\n" +
            "  if (this.went) return;\n" +
            "  this.went = true;\n" +
            "  if (ctx.scene.data && ctx.scene.data.next) ctx.go(ctx.scene.data.next, { hello: 42 });\n" +
            "};\n" },
    ]);
    const scriptId = r.results[1].asset.guid;
    check('script de cena criado', !!scriptId);
    r = applyOps(dir, [
        { op: 'scene.create', name: 'A' },
        { op: 'scene.create', name: 'B' },
        { op: 'scene.set', scene: 'A', settings: { data: { n: 7, next: 'B' }, assets: [atlasId] } },
        { op: 'scene.start', scene: 'A' },
        { op: 'entity.create', scene: 'A', fid: 'e_hero', name: 'hero', x: 48, y: 16 },
        { op: 'entity.create', scene: 'A', fid: 'e_ctrl', name: 'ctrl', x: 0, y: 0, z: 100 },
        { op: 'component.add', scene: 'A', entity: 'e_hero', type: 'data',
          fields: { fields: { kind: 'hero' } } },
        { op: 'component.add', scene: 'A', entity: 'e_ctrl', type: 'script',
          fields: { script: scriptId } },
        { op: 'tilemap.add', scene: 'A', tileset: atlasId, id: 'mapa', cols: 4, rows: 3,
          cell: 32, ox: 0, oy: 0,
          data: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          solids: [true, false, false, false, false, false, false, false, false, false, false, false] },
        { op: 'entity.create', scene: 'B', fid: 'e_ctrl2', name: 'ctrl', x: 0, y: 0, z: 100 },
        { op: 'component.add', scene: 'B', entity: 'e_ctrl2', type: 'script',
          fields: { script: scriptId } },
    ]);
    const built = buildProject(dir, {});
    const d = loadData(built.dir);
    const tmA = d.scenes.a.tilemaps[0];
    check('build leva solidValues do tileset (1/2 solidos)',
        JSON.stringify(tmA.solidValues) === '[false,true,true,false]',
        JSON.stringify(tmA.solidValues));
    const rr = require('../../tools/sdk/lib/runner.js').runAppFolder(built.dir,
        { stopAtMs: 300, microsBias: 1 });
    const nat = rr.env && rr.env.__harness && rr.env.__harness.native;
    check('ctx.scene.data + find + tm + asset', nat && nat.found && nat.map && nat.asset &&
        nat.data === 7, JSON.stringify(nat));
    check('tile solido por tile e map.set atualiza colisao', nat && nat.before === true &&
        nat.after === false, JSON.stringify(nat));
    check('rectSolid consulta o mapa', nat && nat.rect === true, JSON.stringify(nat));
    check('ctx.go troca de cena e leva ctx.arg', nat && nat.b === true && nat.arg === 42,
        JSON.stringify(nat));
    fs.rmSync(dir, { recursive: true, force: true });
})();


// ------------------------------------------------------- native games ----
(function () {
    console.log('Studio jogos nativos:');
    const games = ['Detona', 'Arrasa', 'Lenda de Celer', 'Supernova'];
    for (const name of games) {
        const dir = path.join(ROOT, 'studio_games', name);
        let built = null;
        try { built = buildProject(dir, {}); }
        catch (e) { check(name + ': build', false, e.message); continue; }
        const r = runAppFolder(built.dir, {
            render: true, frames: [0, 220], framesPng: true, microsBias: 1,
        });
        check(name + ': ' + built.version + ' build+run',
            !r.err && r.frames && r.frames.length === 2 && !!r.frames[1].png,
            r.err || 'frames=' + (r.frames ? r.frames.length : 0));
        const proj = Project.open(dir);
        check(name + ': runtime nativo', proj.data.runtime === 'studio');
        const dep = deployProject(dir, {
            noBuild: true, out: path.join(dir, '.studio/deploy/test-app.zip'),
        });
        const zipEntries = readZip(fs.readFileSync(dep.zip));
        const zipByName = new Map(zipEntries.map((e) => [e.name, e.data.toString('utf8')]));
        const zipLock = JSON.parse(zipByName.get('deps.json') || '{}');
        const localJs = new Set(zipEntries.filter((e) => e.name.endsWith('.js'))
            .map((e) => e.name.slice(0, -3)));
        const missing = [];
        let zr;
        const zre = /require\(\s*["']([^"']+)["']\s*\)/g;
        while ((zr = zre.exec(zipByName.get('main.js') || '')) !== null) {
            if (!localJs.has(zr[1]) && !zipLock[zr[1]]) missing.push(zr[1]);
        }
        check(name + ': app.zip leva deps.json p/ o require', dep.ok && dep.bytes > 0 &&
            dep.js.after > 0 && fs.existsSync(dep.zip) && missing.length === 0,
            missing.join(',') || 'sem deps.json');
    }

    // Lenda: HUD memoizado fora da camada suja + pausa pelo botao do HUD.
    // Sem o memo, hearts() rodava todo quadro (~60x na janela abaixo).
    const lendaDir = path.join(ROOT, 'studio_games', 'Lenda de Celer');
    const lenda = buildProject(lendaDir, {});
    let hearts = 0, wrapped = false, pausedOk = false, resumedOk = false, stage = 0;
    runAppFolder(lenda.dir, {
        render: true, stopAtMs: 2600, microsBias: 1,
        events: (env) => {
            const origDelay = env.System.delay;
            env.System.delay = function (ms) {
                const s = env.__harness.lenda;
                const now = env.System.millis();
                if (stage === 0 && s && s.ctx && s.E) {
                    stage = 1;
                    s.ctx.go('Campo 1,1');
                    const origHearts = s.E.gfx.hearts;
                    s.E.gfx.hearts = function () {
                        hearts++;
                        return origHearts.apply(this, arguments);
                    };
                    wrapped = true;
                } else if (stage === 1 && now > 1600) {
                    stage = 2;
                    env.__harness.tap(458, 18);   // pausa
                } else if (stage === 2 && now > 1900) {
                    pausedOk = !!s.paused;
                    stage = 3;
                    env.__harness.tap(337, 296);  // continuar (botao direito do modal)
                } else if (stage === 3 && now > 2300) {
                    resumedOk = !s.paused;
                    stage = 4;
                }
                return origDelay.call(env.System, ms);
            };
        },
    });
    check('Lenda: pausa pelo botao do HUD', wrapped && pausedOk && resumedOk,
        'wrapped=' + wrapped + ' paused=' + pausedOk + ' resumed=' + resumedOk);
    check('Lenda: HUD memoizado (coracoes nao redesenham por quadro)', hearts <= 4,
        'hearts=' + hearts);

    // Detona: HUD memoizado e joystick de arraste. Antes, 10 textos/quadro
    // eram so o HUD e o d-pad de 20 px so reagia a tap.
    const detonaDir = path.join(ROOT, 'studio_games', 'Detona');
    const detona = buildProject(detonaDir, {});
    let texts = 0, dWrapped = false, dStage = 0, dGoMs = 0, gx0 = 1, gx1 = 1;
    runAppFolder(detona.dir, {
        render: false, stopAtMs: 2600, microsBias: 1,
        events: (env) => {
            const origDelay = env.System.delay;
            env.System.delay = function (ms) {
                const s = env.__harness.detona;
                const now = env.System.millis();
                if (dStage === 0 && s && s.ctx && s.E) {
                    dStage = 1;
                    dGoMs = now;
                    s.ctx.go('Fase 1');
                } else if (dStage === 1 && now - dGoMs > 400 && s && s.E) {
                    dStage = 2;
                    const origText = s.E.gfx.text;
                    s.E.gfx.text = function () {
                        texts++;
                        return origText.apply(this, arguments);
                    };
                    dWrapped = true;
                } else if (dStage === 2 && now - dGoMs > 900 && s && s.player) {
                    dStage = 3;
                    gx0 = s.gx;
                    const x = Math.round(s.player.x), y = Math.round(s.player.y);
                    const q = [{ x: x, y: y, touched: 1 }];
                    for (let i = 1; i <= 50; i++) {
                        q.push({ x: x + Math.min(40, i * 4), y: y, touched: 1 });
                    }
                    for (let i = 0; i < 10; i++) q.push({ x: x + 40, y: y, touched: 1 });
                    env.__harness.pushTouch(q);
                } else if (dStage === 3 && now - dGoMs > 2200 && s) {
                    dStage = 4;
                    gx1 = s.gx;
                }
                return origDelay.call(env.System, ms);
            };
        },
    });
    check('Detona: HUD memoizado (textos nao redesenham por quadro)',
        dWrapped && texts <= 24, 'wrapped=' + dWrapped + ' texts=' + texts);
    check('Detona: joystick de arraste anda', dWrapped && gx1 > gx0,
        'gx=' + gx0 + '->' + gx1);

    // Modos novos do Detona 1.2: sobrevivencia (ondas) e duelo pela malha.
    // O duelo usa o protocolo do 0.10.x portado: lobby (heartbeat), convite,
    // aceite, arena pelo seed do host, posicao/bomba sincronizadas e melhor
    // de 3. O harness injeta as mensagens por __harness.detona.netIn.
    let mStage = 0;
    const modes = {};
    runAppFolder(detona.dir, {
        render: false, stopAtMs: 3400, microsBias: 1, seed: 7,
        events: (env) => {
            const orig = env.System.delay;
            env.System.delay = function (ms) {
                const s = env.__harness.detona, now = env.System.millis();
                if (mStage === 0 && s && s.ctx) { mStage = 1; env.__harness.tap(240, 330); }
                else if (mStage === 1 && s && s.mode === 'survive' && now > 1200) {
                    mStage = 2;
                    modes.survive = { onda: s.onda, inimigos: s.enemies.length,
                                      time0: s.time0, exit: s.exit[0] };
                }
                return orig.call(env.System, ms);
            };
        },
    });
    check('Detona: sobrevivencia entra em ondas sem relogio/saida',
        modes.survive && modes.survive.onda === 1 && modes.survive.inimigos > 0 &&
        modes.survive.time0 === 0 && modes.survive.exit === -1,
        JSON.stringify(modes.survive));

    let qStage = 0;
    const duel = {};
    runAppFolder(detona.dir, {
        render: false, stopAtMs: 5600, microsBias: 1, seed: 7,
        events: (env) => {
            const orig = env.System.delay;
            const H = env.__harness;
            env.System.delay = function (ms) {
                const s = H.detona, now = env.System.millis();
                if (qStage === 0 && s && s.ctx) { qStage = 1; H.tap(240, 380); }
                else if (qStage === 1 && s && s.screen === 'duel') {
                    qStage = 2;
                    duel.lobby = true;
                    s.netIn({ from: 'A001', fromName: 'Celer-A', msg: 'dhl' });
                } else if (qStage === 2 && s && s.screen === 'duel' &&
                           Object.keys(s.net.vistos).length) {
                    qStage = 3;
                    H.tap(240, 166);                       // convida o Celer-A
                } else if (qStage === 3 && s && s.net.fase === 'convidei') {
                    qStage = 4;
                    duel.di = s.net.tx.indexOf('di') >= 0;
                    s.netIn({ from: 'A001', fromName: 'Celer-A', msg: 'da1' });
                } else if (qStage === 4 && s && s.mode === 'duel') {
                    qStage = 5;
                    duel.host = s.net.host;
                    duel.round = s.net.round;
                    duel.level = s.level;
                    duel.esperado = 1 + (s.net.seed % 6);
                    const px = Math.round(s.player.x), py = Math.round(s.player.y);
                    const q = [{ x: px, y: py, touched: 1 }];
                    for (let i = 1; i <= 14; i++) q.push({ x: px + i * 4, y: py, touched: 1 });
                    for (let i = 0; i < 6; i++) q.push({ x: px + 56, y: py, touched: 1 });
                    q.push({ x: 0, y: 0, touched: 0 });
                    H.pushTouch(q);
                } else if (qStage === 5 && now > 4600 && s && s.mode === 'duel') {
                    qStage = 6;
                    H.tap(240, 200);                       // bomba
                } else if (qStage === 6 && now > 5100 && s && s.mode === 'duel') {
                    qStage = 7;
                    duel.dp = s.net.tx.some((m) => m.indexOf('dp') === 0);
                    duel.db = s.net.tx.some((m) => m.indexOf('db') === 0);
                    duel.gx = s.gx;
                    s.netIn({ from: 'A001', fromName: 'Celer-A', msg: 'dm1' });
                } else if (qStage === 7 && s && s.net.fase === 'round') {
                    qStage = 8;
                    duel.res = s.net.res;
                    duel.ganhos = s.net.ganhos;
                }
                return orig.call(env.System, ms);
            };
        },
    });
    check('Detona duelo: lobby lista a malha e o convite sai',
        duel.lobby === true && duel.di === true, JSON.stringify(duel));
    check('Detona duelo: aceite vira host e abre o round na fase do seed',
        duel.host === true && duel.round === 1 && duel.level === duel.esperado,
        JSON.stringify(duel));
    check('Detona duelo: posicao e bomba vao para o rival',
        duel.dp === true && duel.db === true && duel.gx > 1, JSON.stringify(duel));
    check('Detona duelo: morte do rival fecha o round (melhor de 3)',
        duel.res === 'venci' && duel.ganhos === 1, JSON.stringify(duel));

    // Lenda 2.2: 3 slots de save com estatisticas (o 0.x tinha um save so).
    const lendaSave = path.join(ROOT, 'studio_games', 'Lenda de Celer');
    const lendaB = buildProject(lendaSave, {});
    let lStage = 0;
    const slots = {};
    runAppFolder(lendaB.dir, {
        render: false, stopAtMs: 3600, microsBias: 1, seed: 7,
        events: (env) => {
            const orig = env.System.delay;
            const H = env.__harness;
            env.System.delay = function (ms) {
                const s = H.lenda, now = env.System.millis();
                if (lStage === 0 && s && s.ctx) { lStage = 1; H.tap(240, 341); }
                else if (lStage === 1 && s && s.pick) { lStage = 2; slots.pick = true; H.tap(240, 336); }
                else if (lStage === 2 && s && s.screen !== 'title') {
                    lStage = 3;
                    slots.slot = s.E.save.num('lenda.slot', 0);
                    slots.saved = !!s.E.save.obj('lenda.2', null);
                } else if (lStage === 3 && now > 2500 && s && s.st) {
                    lStage = 4;
                    slots.ms = s.st.ms;
                    slots.falls = s.st.falls;
                }
                return orig.call(env.System, ms);
            };
        },
    });
    check('Lenda: seletor de 3 saves grava no slot escolhido',
        slots.pick === true && slots.slot === 2 && slots.saved === true,
        JSON.stringify(slots));
    check('Lenda: jornada conta tempo e quedas', slots.ms > 0 && slots.falls === 0,
        JSON.stringify([slots.ms, slots.falls]));
})();

// --------------------------------------------------------- CLI x HTTP ------
(async function () {
    console.log('Studio CLI x HTTP:');
    const a = tmpDir('cli');
    const b = tmpDir('http');
    Project.init(a, { name: 'Equivalencia' });
    Project.init(b, { name: 'Equivalencia' });
    const list = [
        { op: 'scene.create', name: 'Igual' },
        { op: 'entity.create', scene: 'Igual', fid: 'e_t', name: 'Texto', x: 40, y: 40 },
        { op: 'component.add', scene: 'Igual', entity: 'e_t', type: 'text',
          id: 'c_text', fields: { text: 'oi', color: '#ffffff', px: 12 } },
    ];
    applyOps(a, list, {});
    const srv = startStudio({ dir: b, port: 0, open: false });
    await new Promise((resolve) => {
        if (srv.server.listening) return resolve();
        srv.server.once('listening', resolve);
    });
    const port = srv.server.address().port;
    const r = await httpJson(port, 'POST', '/api/command', { ops: list });
    check('API executa o mesmo lote', r.ok === true, JSON.stringify(r.error || {}));
    const sa = Project.open(a).scene('Igual');
    const sb = Project.open(b).scene('Igual');
    check('arquivos equivalentes (fora guid/rev)',
        JSON.stringify(jsonNoMeta(sa)) === JSON.stringify(jsonNoMeta(sb)));
    const st = await httpJson(port, 'GET', '/api/state');
    check('state responde describe + build', st.ok === true && !!st.describe && !!st.describe.project);
    await new Promise((resolve) => srv.close(resolve));

    // ------------------------------------------------------ legado -----
    console.log('Studio modo legado:');
    const legApp = tmpDir('legacy-app');
    const legProj = tmpDir('legacy-proj');
    const legPngPath = path.join(legApp, 'px.png');
    const px = Buffer.alloc(4 * 4 * 3);
    for (let i = 0; i < 16; i++) { px[i * 3 + 2] = 255; }   // azul
    fs.writeFileSync(legPngPath, encodePng(4, 4, px, false));
    fs.writeFileSync(path.join(legApp, 'app.json'), JSON.stringify({
        name: 'Legado Teste', packageName: 'br.test.legado', version: '0.1.0',
        author: 'Teste', description: 'fixture do modo legado', type: 'Game',
        category: 'Jogos', api: 50, requires: ['psram'], permissions: [],
        deps: { 'celeros.game': '^1.5.0', 'celeros.game.spr': '^1.6.0' },
    }, null, 2));
    fs.writeFileSync(path.join(legApp, 'main.js'),
        "var E = require('celeros.game');\n" +
        "require('celeros.game.spr');\n" +
        "E.init({ dir: 'Legado Teste', fps: 30, save: 'legado.' });\n" +
        "E.spr.load([{ name: 'px', file: 'px', w: 4, h: 4 }]);\n" +
        "E.run({\n" +
        "  vermelho: { update: function (dt) { this.t = (this.t || 0) + dt; if (this.t > 0.2) E.goto('verde'); },\n" +
        "              draw: function () { System.fillScreen(0xF800); E.spr.blit('px', 0, 0, { key: null }); } },\n" +
        "  verde: { update: function (dt) { this.t = (this.t || 0) + dt; if (this.t > 1.2) E.quit(); },\n" +
        "           draw: function () { System.fillScreen(0x07E0); E.spr.blit('px', 0, 0, { key: null }); } }\n" +
        "}, 'vermelho');\n");
    const imp = importGame(legApp, legProj, {});
    check('import-game cria projeto legado valido', imp.ok === true &&
        Project.open(legProj).data.runtime === 'legacy', JSON.stringify(imp.validation));
    const legBuild = buildProject(legProj, {});
    check('build legado copia entry/bridge/assets',
        fs.existsSync(path.join(legBuild.dir, 'legacy.main.js')) &&
        fs.existsSync(path.join(legBuild.dir, 'px.png')) &&
        fs.readFileSync(path.join(legBuild.dir, 'main.js'), 'utf8').indexOf('legacyBoot') >= 0);
    const legRun = runProject(legProj, { ms: 900, frames: '0,300,800',
                                          out: path.join(legProj, '.studio/run/leg.png') });
    check('bridge roda o main original e troca de cena', legRun.ok === true &&
        legRun.frames.length === 3, legRun.error || '');
    if (legRun.ok && legRun.frames.length === 3) {
        const f0 = decodePng(fs.readFileSync(legRun.frames[0].file));
        const f1 = decodePng(fs.readFileSync(legRun.frames[1].file));
        const p0 = (10 * f0.w + 10) * 4;
        const p1 = (10 * f1.w + 10) * 4;
        const s0 = (1 * f0.w + 1) * 4;
        check('legado: cena 1 vermelha e cena 2 verde', f0.rgba[p0] > 200 && f0.rgba[p0 + 1] < 40 &&
            f1.rgba[p1 + 1] > 200 && f1.rgba[p1] < 40,
            JSON.stringify([f0.rgba[p0], f0.rgba[p0 + 1], f1.rgba[p1], f1.rgba[p1 + 1]]));
        check('legado: sprite carregado pelos bases do pacote', f0.rgba[s0 + 2] > 200 &&
            f0.rgba[s0] < 40);
    }

    // ---------------------------------------------------- modo programa ----
    {
        const app = tmpDir('app');
        const { describeData } = require('../../tools/studio/studio.js');
        Project.init(app, { app: true, name: 'App Teste', pkg: 'br.celer.appteste' });
        let p = Project.open(app);
        check('init --app: runtime app, tipo App, zero deps/psram',
            p.data.runtime === 'app' && p.data.type === 'App' &&
            Object.keys(p.data.deps || {}).length === 0 &&
            (p.data.requires || []).length === 0 && p.data.canvas.native === false,
            JSON.stringify([p.data.runtime, p.data.type, p.data.deps, p.data.requires]));
        check('init --app: valida limpo', validateProject(p, {}).errors.length === 0,
            JSON.stringify(validateProject(p, {}).errors));
        const desc = describeData(p);
        check('describe: componentes de programa no catalogo',
            desc.components['ui.button'] && desc.components['ui.button'].runtime === 'app' &&
            desc.runtime === 'app' && desc.limits.depsRequired === 0);

        const SCRIPT = [
            'exports.start = function (ctx) { ctx.set("msg", "inicio"); System.print("START " + ctx.get("on")); };',
            'exports.destroy = function (ctx) { System.print("DESTROY"); };',
            'exports.event = function (name, value, ctx) {',
            '    System.print("EVT " + name + " " + String(value));',
            '};',
        ].join('\n');
        const scriptOp = applyOps(app, [
            { op: 'scene.create', name: 'B' },
            { op: 'script.set', name: 'tela', content: SCRIPT },
        ]);
        const telaGuid = scriptOp.results[1].asset.guid;
        const wid = (name, x, y, z, type, fields) => ({
            op: 'entity.create', scene: 'A', name: name, x: x, y: y, z: z,
            components: [{ id: 'c_' + F.newGuid().slice(0, 8), type: type, fields: fields }],
        });
        applyOps(app, [
            { op: 'scene.rename', scene: 'Principal', name: 'A' },
            { op: 'entity.delete', scene: 'A', entity: 'Titulo' },
            { op: 'entity.delete', scene: 'A', entity: 'Acao' },
            { op: 'scene.set', scene: 'A', settings: {
                scripts: [telaGuid], persist: 't',
                data: { msg: '', on: false, vol: 10, lista: -1 } } },
            wid('Texto', 10, 48, 1, 'ui.text', { bind: 'msg' }),
            wid('Acao', 10, 80, 2, 'ui.button', { label: 'Ir', w: 100, h: 30, event: 'clicar', id: 'ir' }),
            wid('IrB', 120, 80, 3, 'ui.button', { label: 'B', w: 100, h: 30, go: 'B', id: 'irb' }),
            wid('Chave', 10, 120, 4, 'ui.toggle', { key: 'on', event: 'on', id: 'on' }),
            wid('Volume', 10, 160, 5, 'ui.slider', { key: 'vol', w: 150, event: 'vol', id: 'vol' }),
            wid('Lista', 10, 200, 6, 'ui.list', {
                id: 'lista', items: ['um', 'dois', 'tres'], key: 'lista',
                w: 200, h: 100, rowH: 32, event: 'lista' }),
        ]);
        const appBuild = buildProject(app, {});
        const builtApp = JSON.parse(fs.readFileSync(path.join(appBuild.dir, 'app.json'), 'utf8'));
        const mainSrc = fs.readFileSync(path.join(appBuild.dir, 'main.js'), 'utf8');
        check('build app: app.json sem deps/psram, type App',
            builtApp.type === 'App' && !builtApp.deps &&
            (builtApp.requires || []).length === 0, JSON.stringify(builtApp));
        check('build app: main.js sem engine e data proprio',
            mainSrc.indexOf('celeros.game') < 0 && mainSrc.indexOf('studioAppBoot') >= 0 &&
            fs.existsSync(path.join(appBuild.dir, 'app.data.js')) &&
            !fs.existsSync(path.join(appBuild.dir, 'game.data.js')));

        let stage = 0;
        const run1 = runAppFolder(appBuild.dir, {
            render: true, stopAtMs: 1800, microsBias: 1, seed: 7, frames: [0, 1800],
            events: (env) => {
                const orig = env.System.delay;
                env.System.delay = function (ms) {
                    const now = env.System.millis();
                    if (stage === 0 && now > 200) { stage = 1; env.__harness.tap(60, 95); }
                    else if (stage === 1 && now > 450) { stage = 2; env.__harness.tap(32, 132); }
                    else if (stage === 2 && now > 700) { stage = 3; env.__harness.tap(110, 174); }
                    else if (stage === 3 && now > 950) { stage = 4; env.__harness.tap(100, 248); }
                    else if (stage === 4 && now > 1200) { stage = 5; env.__harness.tap(170, 95); }
                    else if (stage === 5 && now > 1500) { stage = 6; env.__harness.tap(20, 20); }
                    return orig.call(env.System, ms);
                };
            },
        });
        const log = (run1.log || []).join('\n');
        check('app runtime: script de tela start', /START false/.test(log), log);
        check('app runtime: evento do botao', /EVT clicar/.test(log), log);
        check('app runtime: toggle grava estado e emite valor', /EVT on true/.test(log), log);
        check('app runtime: slider devolve valor', /EVT vol ([1-9]\d*)/.test(log), log);
        check('app runtime: lista devolve indice', /EVT lista 1/.test(log), log);
        check('app runtime: go troca de tela (destroy da anterior)', /DESTROY/.test(log), log);
        check('app runtime: header voltar reentra na tela',
            (log.match(/START/g) || []).length >= 2, log);
        check('app runtime: estado persiste no Storage',
            /"on":true/.test(String(run1.env.Storage.get('studio.a.t', '') || '')),
            String(run1.env.Storage.get('studio.a.t', '')));
        const shot = '/tmp/celer-app-shot.png';
        fs.writeFileSync(shot, run1.frames[run1.frames.length - 1].png);
        const png = decodePng(fs.readFileSync(shot));
        check('app runtime: frame 240x320', png.w === 240 && png.h === 320, png.w + 'x' + png.h);

        // ---- validacao cruzada de modos ----
        const badScene = path.join(app, 'Assets', 'Scenes', 'Principal.scene.json');
        const original = JSON.parse(fs.readFileSync(badScene, 'utf8'));
        const withSprite = F.deepClone(original);
        withSprite.entities[0].components.push({ id: 'c_x1', type: 'sprite', fields: { sprite: '' } });
        fs.writeFileSync(badScene, JSON.stringify(withSprite, null, 2) + '\n');
        let errs = validateProject(Project.open(app), {}).errors;
        check('validacao: componente de jogo em projeto app', errs.some((e) => e.code === 'component.runtime'),
            JSON.stringify(errs.map((e) => e.code)));
        const withTile = F.deepClone(original);
        withTile.tilemaps = [{ id: 'tm_1', tileset: 'x', cols: 1, rows: 1, cell: 16, data: [0] }];
        fs.writeFileSync(badScene, JSON.stringify(withTile, null, 2) + '\n');
        errs = validateProject(Project.open(app), {}).errors;
        check('validacao: tilemap em projeto app', errs.some((e) => e.code === 'scene.tilemap'),
            JSON.stringify(errs.map((e) => e.code)));
        const withAi = F.deepClone(original);
        withAi.entities.push({
            fid: 'e_ia', name: 'IA', active: true, z: 9,
            transform: { x: 0, y: 0 },
            components: [{ id: 'c_ia', type: 'ai.chat', fields: { trigger: 'pedir' } }],
        });
        fs.writeFileSync(badScene, JSON.stringify(withAi, null, 2) + '\n');
        errs = validateProject(Project.open(app), {}).errors;
        check('validacao: ai.chat sem permissao net', errs.some((e) => e.code === 'perm.missing'),
            JSON.stringify(errs.map((e) => e.code)));
        fs.writeFileSync(badScene, JSON.stringify(original, null, 2) + '\n');

        // ---- jogos continuam recusando componente de programa ----
        const game = tmpDir('game');
        Project.init(game, { name: 'Jogo Teste', pkg: 'br.celer.jogoteste' });
        const gs = path.join(game, 'Assets', 'Scenes', 'Principal.scene.json');
        const gj = JSON.parse(fs.readFileSync(gs, 'utf8'));
        gj.entities[0].components.push({ id: 'c_ui', type: 'ui.button', fields: { label: 'x' } });
        fs.writeFileSync(gs, JSON.stringify(gj, null, 2) + '\n');
        errs = validateProject(Project.open(game), {}).errors;
        check('validacao: componente de programa em jogo', errs.some((e) => e.code === 'component.runtime'),
            JSON.stringify(errs.map((e) => e.code)));

        // ---- exemplos que ficam no repo ----
        const painelDir = path.join(ROOT, 'studio_apps', 'Painel');
        const painel = buildProject(painelDir, {});
        const painelApp = JSON.parse(fs.readFileSync(path.join(painel.dir, 'app.json'), 'utf8'));
        check('exemplo Painel: build sem deps', painelApp.type === 'App' && !painelApp.deps,
            JSON.stringify(painelApp.deps));
        let navStage = 0;
        const pr = runAppFolder(painel.dir, {
            render: true, stopAtMs: 900, microsBias: 1, frames: [0, 900],
            events: (env) => {
                const orig = env.System.delay;
                env.System.delay = function (ms) {
                    const now = env.System.millis();
                    if (navStage === 0 && now > 300) { navStage = 1; env.__harness.tap(60, 292); }
                    return orig.call(env.System, ms);
                };
            },
        });
        const pf = pr.frames.map((f) => decodePng(f.png));
        const diff = pf[0].rgba.some((v, i) => v !== pf[1].rgba[i]);
        check('exemplo Painel: build+run e navega para Sobre', !pr.err && pf.length === 2 && diff,
            String(pr.err || 'sem diferenca'));

        const assDir = path.join(ROOT, 'studio_apps', 'Assistente');
        const ass = buildProject(assDir, {});
        const WAV = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
        let aStage = 0;
        const ar = runAppFolder(ass.dir, {
            render: false, stopAtMs: 1600, microsBias: 1,
            events: (env) => {
                env.__harness.setAiResponse({ ok: true, status: 200, content: 'Ola!', raw: '' });
                env.__harness.setAiSpeakResult({ ok: true, status: 200, played: true, bytes: 0 });
                env.__harness.setMicB64(WAV);
                env.__harness.pushPrompt(['e o ceu?']);
                const orig = env.System.delay;
                env.System.delay = function (ms) {
                    const now = env.System.millis();
                    if (aStage === 0 && now > 200) { aStage = 1; env.__harness.tap(60, 226); }
                    else if (aStage === 1 && now > 500) { aStage = 2; env.__harness.tap(62, 289); }
                    else if (aStage === 2 && now > 900) { aStage = 3; env.__harness.tap(176, 289); }
                    else if (aStage === 3 && now > 1200) { aStage = 4; env.__harness.tap(62, 289); }
                    return orig.call(env.System, ms);
                };
            },
        });
        const chats = (ar.env.__harness.aiChats || []).map((s) => JSON.parse(s));
        const hasAudio = chats.some((c) => JSON.stringify(c.messages).indexOf('input_audio') >= 0);
        check('exemplo Assistente: ai.chat com input_audio (multimodal)', !ar.err && chats.length >= 1 && hasAudio,
            ar.err || ('chats=' + chats.length + ' audio=' + hasAudio));
        check('exemplo Assistente: ai.speak disparado', (ar.env.__harness.aiSpeaks || []).length >= 1,
            JSON.stringify(ar.env.__harness.aiSpeaks || []));

        for (const d of [app, game]) fs.rmSync(d, { recursive: true, force: true });
    }

    // ---------------------------------------------------------- copiloto ----
    {
        const { spawnSync } = require('child_process');
        const A = require('../../tools/studio/lib/ai');
        console.log('Studio copiloto:');
        check('ia: parser aceita objeto puro', A.parsePlan('{"say":"a","ops":[{"op":"x"}]}').ops.length === 1);
        check('ia: parser aceita cerca ```json',
            A.parsePlan('```json\n{"say":"b","ops":[{"op":"x"}]}\n```').say === 'b');
        check('ia: parser aceita texto em volta',
            A.parsePlan('claro! {"say":"c","ops":[]} ok').say === 'c');
        let gcode = null;
        try { A.guard([{ op: 'entity.delete', scene: 'x', entity: 'y' }], {}); } catch (e) { gcode = e.code; }
        check('ia: op destrutiva bloqueada', gcode === 'ai.guard');
        check('ia: destrutiva libera com allowDelete',
            A.guard([{ op: 'entity.delete' }], { allowDelete: true }).length === 1);
        gcode = null;
        try { A.guard([{ op: 'asset.import', src: '/etc/passwd' }], {}); } catch (e) { gcode = e.code; }
        check('ia: asset.import bloqueado no copiloto', gcode === 'ai.guard');

        const aiDir = tmpDir('ai');
        Project.init(aiDir, { app: true, name: 'IA T', pkg: 'br.celer.iat' });
        const cfg = { provider: 'openrouter', model: 'm', key: 'k', url: 'http://127.0.0.1:1/v1' };
        let calls = 0;
        const fakeAsk = async () => {
            calls++;
            return { content: calls === 1
                ? '{"say":"tentando","ops":[{"op":"nao.existe"}]}'
                : '{"say":"criei","ops":[{"op":"scene.create","name":"Ajustes"}]}' };
        };
        const planned = await A.plan(aiDir, 'crie uma tela', { ask: fakeAsk, dryRun: true, config: cfg });
        check('ia: refaz o lote apos erro de validacao', planned.steps === 2, 'steps=' + planned.steps);
        check('ia: previa dry-run nao escreve',
            !fs.existsSync(path.join(aiDir, 'Assets', 'Scenes', 'Ajustes.scene.json')));
        const applied = await A.plan(aiDir, 'crie uma tela', { ask: fakeAsk, config: cfg });
        check('ia: aplica quando nao e dry-run',
            !!applied.result && fs.existsSync(path.join(aiDir, 'Assets', 'Scenes', 'Ajustes.scene.json')),
            JSON.stringify(applied.result && applied.result.changed));

        // HTTP: provedor falso local -> /api/command {cmd:"ai"}
        const provider = http.createServer((req, res) => {
            req.on('data', () => {});
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { content:
                    '{"say":"ok","ops":[{"op":"scene.create","name":"PelaIA"}]}' } }],
                    usage: { total_tokens: 10 } }));
            });
        });
        await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
        const pport = provider.address().port;
        process.env.CELER_STUDIO_AI_URL = 'http://127.0.0.1:' + pport + '/v1/chat/completions';
        process.env.CELER_STUDIO_AI_KEY = 'teste';
        const aiSrv = startStudio({ dir: aiDir, port: 0, open: false });
        await new Promise((resolve) => {
            if (aiSrv.server.listening) return resolve();
            aiSrv.server.once('listening', resolve);
        });
        const aport = aiSrv.server.address().port;
        const aiRes = await httpJson(aport, 'POST', '/api/command',
            { cmd: 'ai', prompt: 'crie uma tela pela IA' });
        check('ia HTTP: devolve plano em previa',
            aiRes.ok === true && aiRes.ops.length === 1 && aiRes.dryRun === true,
            JSON.stringify(aiRes.error || {}));
        check('ia HTTP: previa nao escreve',
            !fs.existsSync(path.join(aiDir, 'Assets', 'Scenes', 'PelaIA.scene.json')));
        const aiApply = await httpJson(aport, 'POST', '/api/command',
            { cmd: 'ai', prompt: 'crie', apply: true });
        check('ia HTTP: apply escreve',
            aiApply.ok === true && fs.existsSync(path.join(aiDir, 'Assets', 'Scenes', 'PelaIA.scene.json')));
        // sem chave a resposta e ok:false com code estavel (400, nao 500)
        delete process.env.CELER_STUDIO_AI_URL;
        delete process.env.CELER_STUDIO_AI_KEY;
        const aiNoKey = await httpJson(aport, 'POST', '/api/command', { cmd: 'ai', prompt: 'x' });
        check('ia HTTP: sem chave -> erro ai.key',
            aiNoKey.ok === false && aiNoKey.error && aiNoKey.error.code === 'ai.key',
            JSON.stringify(aiNoKey.error || {}));
        await new Promise((resolve) => aiSrv.close(resolve));
        await new Promise((resolve) => provider.close(resolve));

        // CLI: sem chave o erro e estavel (nao faz rede)
        const noKey = Object.assign({}, process.env);
        for (const k of ['CELER_STUDIO_AI_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY',
                         'CELER_STUDIO_AI_URL']) delete noKey[k];
        const cli = spawnSync(process.execPath, [path.join(ROOT, 'tools/sdk/celer.js'), 'studio', aiDir,
            'ai', 'x', '--json'], { env: noKey, encoding: 'utf8' });
        check('ia CLI: sem chave -> ai.key com exit 1',
            cli.status === 1 && /ai\.key/.test(cli.stdout + cli.stderr),
            (cli.stdout + cli.stderr).slice(0, 160));

        fs.rmSync(aiDir, { recursive: true, force: true });
    }

    // limpeza
    for (const d of [base, a, b, legApp, legProj]) fs.rmSync(d, { recursive: true, force: true });
    console.log('');
    console.log(failures ? failures + ' falha(s)' : 'todos os testes do Studio passaram');
    process.exit(failures ? 1 : 0);
})().catch((e) => {
    console.error(e && e.stack || e);
    process.exit(1);
});
