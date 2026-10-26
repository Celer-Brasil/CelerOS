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
        check(name + ': app.zip', dep.ok && dep.bytes > 0 && dep.js.after > 0 &&
            fs.existsSync(dep.zip));
    }
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

    // limpeza
    for (const d of [base, a, b, legApp, legProj]) fs.rmSync(d, { recursive: true, force: true });
    console.log('');
    console.log(failures ? failures + ' falha(s)' : 'todos os testes do Studio passaram');
    process.exit(failures ? 1 : 0);
})().catch((e) => {
    console.error(e && e.stack || e);
    process.exit(1);
});
