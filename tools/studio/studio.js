#!/usr/bin/env node
'use strict';
// Celer Studio — CLI do editor de jogos da CelerGame.
//
//   node tools/sdk/celer.js studio init ~/Jogo --name "Meu Jogo"
//   node tools/sdk/celer.js studio ~/Jogo describe --json
//   node tools/sdk/celer.js studio ~/Jogo apply ops.json
//   node tools/sdk/celer.js studio ~/Jogo build
//   node tools/sdk/celer.js studio ~/Jogo run --ms 1500 --out tela.png
//   node tools/sdk/celer.js studio ~/Jogo serve --open
//
// Toda acao e um comando JSON (apply) com --json/--dry-run e ids estaveis:
// a GUI, a IA e o CLI usam o MESMO barramento (lib/ops.js).

const fs = require('fs');
const path = require('path');
const { Project } = require('./lib/project');
const { applyOps, undo, redo } = require('./lib/ops');
const { validateProject } = require('./lib/validate');
const { buildProject, exportBuild } = require('./lib/build');
const { deployProject } = require('./lib/deploy');
const { runProject } = require('./lib/run');
const { componentCatalog, schemaDoc } = require('./lib/schema');
const { STUDIO_VERSION, FORMAT } = require('./version');
const F = require('./lib/format');

const COMMANDS = new Set([
    'init', 'describe', 'schema', 'import', 'import-game', 'apply', 'validate',
    'build', 'run', 'export', 'deploy', 'undo', 'redo', 'fmt', 'serve', 'version', 'help',
]);

const OPS_HELP = [
    { op: 'project.set', args: 'name, packageName, version, api, deps, canvas, build, editor, ...' },
    { op: 'scene.create', args: 'name' },
    { op: 'scene.delete', args: 'scene' },
    { op: 'scene.rename', args: 'scene, name' },
    { op: 'scene.set', args: 'scene, settings{bg,fps,static,data,assets,music,camera}, replace?, name?' },
    { op: 'scene.start', args: 'scene' },
    { op: 'entity.create', args: 'scene|prefab, name, fid?, x?, y?, z?, transform?, prefab?, components?' },
    { op: 'entity.set', args: 'scene|prefab, entity, name?, active?, z?, transform?' },
    { op: 'entity.delete', args: 'scene|prefab, entity' },
    { op: 'entity.duplicate', args: 'scene|prefab, entity, name?' },
    { op: 'component.add', args: 'scene|prefab, entity, type, fields?' },
    { op: 'component.set', args: 'scene|prefab, entity, component, field, value' },
    { op: 'component.remove', args: 'scene|prefab, entity, component' },
    { op: 'prefab.create', args: 'name, scene?, entity?' },
    { op: 'prefab.instance', args: 'scene, prefab, name?, x?, y?, z?' },
    { op: 'prefab.override', args: 'scene, entity, target, transform?, active?, name?, component?, fields?' },
    { op: 'asset.import', args: 'src, importer?, name?, grid?, cols?, rows?, tw?, th?, prefix?, key?, pivot?' },
    { op: 'asset.set', args: 'asset, settings{mode,cols,rows,tw,th,pivot,key,loop,gain}' },
    { op: 'asset.rename', args: 'asset, name' },
    { op: 'asset.delete', args: 'asset, force?' },
    { op: 'script.set', args: 'script (guid) | name, content' },
    { op: 'tilemap.add', args: 'scene, tileset, cols, rows, cell, ox?, oy?, layer?, data?, solids?' },
    { op: 'tilemap.set', args: 'scene, tilemap, ...' },
    { op: 'tilemap.paint', args: 'scene, tilemap, c, r, value?, solid?' },
    { op: 'tilemap.fill', args: 'scene, tilemap, c0, r0, c1, r1, value' },
    { op: 'tilemap.remove', args: 'scene, tilemap' },
];

function usage() {
    console.log('uso: node tools/sdk/celer.js studio [PASTA] <comando> [flags]');
    console.log('');
    console.log('  init [PASTA] [--name N] [--pkg P] [--author A]  cria projeto + cena inicial');
    console.log('  describe [--json]                              estado, componentes, ops e limites');
    console.log('  schema [project|scene|prefab|meta|components]  JSON Schema do formato');
    console.log('  import ARQUIVO [--importer K] [--grid CxR] [--tw N --th N] [--name N]');
    console.log('  import-game APP [DEST]                         importa um app existente em modo legado');
    console.log('  apply [ARQ|-] [--op JSON] [--dry-run] [--if-rev N]  executa um lote de ops');
    console.log('  validate [--json]                              schema, refs, limites, ES5');
    console.log('  build [--json]                                 gera o app flat em .studio/build');
    console.log('  run [--ms N] [--out PNG] [--frames 0,600] [--seed N] [--input TOQUES] [--no-build]');
    console.log('  export DESTINO [--force]                       copia o build para uma pasta');
    console.log('  deploy [--out app.zip] [--no-build] [--json]   compila JS/assets e gera o app.zip');
    console.log('  undo | redo                                    desfaz/refaz o ultimo lote');
    console.log('  fmt                                            reescreve tudo canonico');
    console.log('  serve [--port P] [--open]                      abre a GUI web (Unity-style)');
    console.log('');
    console.log('flags globais: --dir PASTA  --json  --dry-run');
}

function parseFlags(args) {
    const out = { _: [], op: [] };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!a.startsWith('--')) { out._.push(a); continue; }
        const key = a.slice(2);
        const next = args[i + 1];
        let value = true;
        if (next !== undefined && !next.startsWith('--')) { value = next; i++; }
        if (key === 'op') out.op.push(value);
        else out[key] = value;
    }
    return out;
}

function num(v) { return v === undefined || v === true ? undefined : Number(v); }

function readOps(flags) {
    const ops = [];
    for (const raw of flags.op) {
        if (raw === true) F.fail('ops.invalid', '--op exige um JSON');
        ops.push(JSON.parse(String(raw)));
    }
    if (ops.length) return ops;
    const file = flags._.find((a) => a !== '.' && a !== '-');
    let text = null;
    if (file && fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
    else if (file && file !== '-') F.fail('ops.missing', 'arquivo de ops nao existe: ' + file);
    else if (process.stdin.isTTY) F.fail('ops.empty', 'nenhuma op: passe um arquivo, --op JSON ou um pipe');
    else {
        try { text = fs.readFileSync(0, 'utf8'); } catch (e) { text = ''; }
    }
    if (!text || !text.trim()) F.fail('ops.empty', 'nenhuma op: passe um arquivo, --op JSON ou stdin');
    let data;
    try { data = JSON.parse(text); }
    catch (e) { F.fail('json.invalid', 'ops invalidas: ' + e.message); }
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.ops)) return data.ops;
    if (data && data.op) return [data];
    F.fail('ops.invalid', 'esperava [ops], {ops:[...]} ou {op:...}');
}

function describeData(project) {
    const deps = Object.keys(project.data.deps || {}).length;
    const psram = (project.data.requires || []).indexOf('psram') >= 0;
    return Object.assign({
        ok: true,
        studio: STUDIO_VERSION,
        format: FORMAT,
        ops: OPS_HELP,
        components: componentCatalog(),
        schemas: ['project', 'scene', 'prefab', 'meta', 'components'],
        limits: {
            deps: 8, depsUsed: deps,
            extras: 16, assetKB: 128, assetsKB: 256,
            jsKB: psram ? 1024 : 48, requiresPsram: psram,
        },
        rules: {
            es5: true,
            flat: true,
            colors: '#RRGGBB na fonte; RGB565 no build',
            scene: 'entidades com transform implicito; prefab achatado no build',
        },
    }, project.summary());
}

function describe(dir) {
    return describeData(Project.open(dir));
}

function printDiags(list, label) {
    if (!list || !list.length) return 0;
    for (const d of list) {
        console.log('  ' + (label || 'erro') +
                    '[' + d.code + '] ' + (d.path || '') + ': ' + d.message +
                    (d.hint ? ' (' + d.hint + ')' : ''));
    }
    return list.length;
}

function main(argv) {
    const args = (argv || process.argv.slice(2)).slice();
    let dir = null;
    if (args[0] && !args[0].startsWith('-') && !COMMANDS.has(args[0])) {
        dir = args.shift();
    }
    const cmd = args[0] || 'help';
    const flags = parseFlags(args.slice(1));
    if (!dir && flags.dir) dir = flags.dir;
    const json = !!flags.json;
    const projectDir = path.resolve(dir || '.');

    try {
        if (cmd === 'help' || cmd === 'version') {
            if (cmd === 'version') { console.log(STUDIO_VERSION); return; }
            usage();
            return;
        }
        if (cmd === 'init') {
            const target = path.resolve(flags._[0] || projectDir);
            const p = Project.init(target, {
                name: flags.name, pkg: flags.pkg, author: flags.author,
                description: flags.description,
            });
            const s = p.summary();
            if (json) console.log(JSON.stringify({ ok: true, dir: target, project: s.project,
                                                    scenes: s.scenes, warnings: [] }, null, 2));
            else {
                console.log('projeto criado: ' + target);
                console.log('  cena inicial: ' + (s.scenes[0] ? s.scenes[0].path : '(nenhuma)'));
                console.log('proximos passos:');
                console.log('  node tools/sdk/celer.js studio "' + target + '" describe');
                console.log('  node tools/sdk/celer.js studio "' + target + '" build');
                console.log('  node tools/sdk/celer.js studio "' + target + '" serve --open');
            }
            return;
        }
        if (cmd === 'describe') {
            const d = describe(projectDir);
            if (json) console.log(JSON.stringify(d, null, 2));
            else {
                console.log(d.project.name + '  ' + d.project.packageName + ' ' + d.project.version +
                            '  (api ' + d.project.api + ', rev ' + d.project.rev + ')');
                console.log('canvas: ' + d.project.canvas.w + 'x' + d.project.canvas.h +
                            (d.project.canvas.native ? ' nativo' : ' virtual') +
                            '  deps: ' + d.limits.depsUsed + '/8');
                console.log('cenas: ' + d.scenes.length + '  prefabs: ' + d.prefabs.length +
                            '  assets: ' + d.assets.length);
                for (const s of d.scenes) console.log('  cena ' + s.name + ' (' + s.guid + ')' +
                    (s.start ? ' [inicial]' : '') + ' — ' + s.entities + ' entidades, ' + s.tilemaps + ' tilemaps');
                if (d.issues.length) for (const i of d.issues) console.log('  aviso[' + i.code + '] ' + i.path + ': ' + i.message);
            }
            return;
        }
        if (cmd === 'schema') {
            const name = flags._[0] || 'components';
            const doc = schemaDoc(name);
            if (!doc) F.fail('schema.missing', 'schema desconhecido: ' + name);
            console.log(JSON.stringify(doc, null, 2));
            return;
        }
        if (cmd === 'import') {
            const src = flags._[0] || flags.src;
            if (!src) F.fail('op.args', 'import exige ARQUIVO');
            const pivot = flags.pivot && flags.pivot !== true
                ? String(flags.pivot).split(',').map(Number) : undefined;
            const op = {
                op: 'asset.import',
                src: path.resolve(src),
                importer: flags.importer,
                name: flags.name,
                grid: flags.grid,
                cols: num(flags.cols), rows: num(flags.rows),
                tw: num(flags.tw), th: num(flags.th),
                prefix: flags.prefix,
                key: flags.key,
                pivot: pivot,
                loop: flags.loop ? true : undefined,
                gain: num(flags.gain),
            };
            const r = applyOps(projectDir, [op], { dryRun: !!flags.dryRun });
            if (json) console.log(JSON.stringify(r, null, 2));
            else {
                const a = r.results && r.results[0] && r.results[0].asset;
                console.log('importado: ' + (a ? a.name + ' (' + a.guid + ')' : 'ok') +
                            (r.dryRun ? ' [dry-run]' : ''));
            }
            return;
        }
        if (cmd === 'import-game') {
            const appDir = flags._[0] || flags.app;
            if (!appDir) F.fail('op.args', 'import-game exige a pasta do app');
            const dest = flags._[1] || flags.dest;
            const { importGame } = require('./lib/import_game');
            const r = importGame(appDir, dest, { name: flags.name });
            if (json) console.log(JSON.stringify(r, null, 2));
            else {
                console.log('projeto legado: ' + r.dir);
                console.log('  app: ' + r.legacy.entry + '  assets: ' + r.imported.assets.length +
                            '  scripts: ' + r.imported.scripts.length);
                console.log('  validacao: ' + (r.ok ? 'OK' : r.validation.errors.length + ' erro(s)') +
                            ', ' + r.validation.warnings.length + ' aviso(s)');
                for (const d of r.validation.errors) console.log('  erro[' + d.code + '] ' + (d.path || '') + ': ' + d.message);
                for (const d of r.validation.warnings) console.log('  aviso[' + d.code + '] ' + (d.path || '') + ': ' + d.message);
            }
            process.exit(r.ok ? 0 : 1);
        }
        if (cmd === 'apply') {
            const ops = readOps(flags);
            const r = applyOps(projectDir, ops, {
                dryRun: !!flags['dry-run'],
                ifRev: flags['if-rev'] !== undefined && flags['if-rev'] !== true ? +flags['if-rev'] : undefined,
            });
            if (json) console.log(JSON.stringify(r, null, 2));
            else {
                console.log((r.dryRun ? '[dry-run] ' : '') + 'ops: ' + ops.length +
                            '  arquivos: ' + r.changed.length + '  rev: ' + r.rev);
                for (const f of r.changed) console.log('  ' + f);
                for (const w of r.warnings || []) console.log('  aviso[' + w.code + '] ' + w.message);
                for (const res of r.results || []) {
                    if (!res) continue;
                    if (res.entity) console.log('  entidade ' + res.entity.fid + ' "' + res.entity.name + '"');
                    if (res.component) console.log('  componente ' + res.component.id + ' (' + res.component.type + ')');
                    if (res.asset) console.log('  asset ' + res.asset.name + ' (' + res.asset.guid + ')');
                }
            }
            return;
        }
        if (cmd === 'validate') {
            const project = Project.open(projectDir);
            const r = validateProject(project, {});
            if (json) {
                console.log(JSON.stringify({ ok: r.ok, errors: r.errors, warnings: r.warnings,
                                             summary: project.summary() }, null, 2));
            } else {
                console.log(project.data.name + ': ' + r.errors.length + ' erro(s), ' +
                            r.warnings.length + ' aviso(s)');
                printDiags(r.errors, 'erro');
                printDiags(r.warnings, 'aviso');
            }
            process.exit(r.ok ? 0 : 1);
        }
        if (cmd === 'build') {
            const r = buildProject(projectDir);
            if (json) console.log(JSON.stringify(r, null, 2));
            else {
                console.log('build: ' + r.dir);
                console.log('  app: ' + r.app + ' ' + r.version + '  extras: ' + r.extras +
                            '  JS: ' + (r.jsBytes / 1024).toFixed(1) + 'KB' +
                            '  assets: ' + (r.assetBytes / 1024).toFixed(1) + 'KB');
                for (const w of r.warnings) console.log('  aviso[' + w.code + '] ' + w.message);
            }
            return;
        }
        if (cmd === 'run') {
            const r = runProject(projectDir, {
                ms: flags.ms !== undefined ? +flags.ms : undefined,
                out: flags.out,
                frames: flags.frames,
                seed: flags.seed !== undefined ? +flags.seed : undefined,
                input: flags.input,
                noBuild: !!flags['no-build'],
            });
            if (json) console.log(JSON.stringify(r, null, 2));
            else {
                for (const line of r.log || []) console.log('[app] ' + line);
                if (!r.ok) { console.error('erro do app: ' + r.error); process.exit(1); }
                console.log('tela: ' + r.out + ' (' + r.w + 'x' + r.h + ', seed ' + r.seed + ')');
                for (const f of r.frames) console.log('  frame ' + f.ms + 'ms: ' + f.file);
            }
            process.exit(r.ok ? 0 : 1);
        }
        if (cmd === 'export') {
            const target = flags._[0] || flags.out;
            if (!target) F.fail('op.args', 'export exige DESTINO');
            const r = exportBuild(projectDir, target, { force: !!flags.force });
            if (json) console.log(JSON.stringify(r, null, 2));
            else console.log('exportado: ' + r.dir + ' (' + r.files.length + ' arquivos)');
            return;
        }
        if (cmd === 'deploy') {
            const r = deployProject(projectDir, {
                out: flags.out || flags._[0],
                noBuild: !!flags['no-build'],
            });
            if (json) console.log(JSON.stringify(r, null, 2));
            else {
                console.log('deploy: ' + r.zip);
                console.log('  app: ' + r.app + ' ' + r.version +
                            '  zip: ' + (r.bytes / 1024).toFixed(1) + 'KB' +
                            '  sha256: ' + r.sha256.slice(0, 12));
                console.log('  JS: ' + (r.js.before / 1024).toFixed(1) + ' -> ' +
                            (r.js.after / 1024).toFixed(1) + 'KB (enxuto)' +
                            '  assets: ' + (r.assets.bytes / 1024).toFixed(1) + 'KB' +
                            '  extras: ' + (r.build.extras === null ? '?' : r.build.extras));
            }
            return;
        }
        if (cmd === 'undo' || cmd === 'redo') {
            const project = Project.open(projectDir);
            const r = cmd === 'undo' ? undo(project) : redo(project);
            if (json) console.log(JSON.stringify(r, null, 2));
            else console.log((cmd === 'undo' ? 'desfeito' : 'refeito') + ': ' +
                             r.changed.length + ' arquivo(s)');
            return;
        }
        if (cmd === 'fmt') {
            const project = Project.open(projectDir);
            for (const rel of project.files.keys()) {
                if (/\.(json|meta)$/.test(rel)) project.markDirty(rel);
            }
            const changed = project.saveDirty();
            if (json) console.log(JSON.stringify({ ok: true, changed }, null, 2));
            else console.log('canonico: ' + changed.length + ' arquivo(s)');
            return;
        }
        if (cmd === 'serve') {
            const { startStudio } = require('./server.js');
            startStudio({
                dir: projectDir,
                port: flags.port !== undefined && flags.port !== true ? +flags.port : 8421,
                open: !!flags.open,
            });
            return;
        }
        usage();
        process.exit(2);
    } catch (e) {
        const err = {
            code: e.code || 'error',
            message: e.message || String(e),
            hint: e.hint,
            diagnostics: e.diagnostics || null,
        };
        if (json) console.log(JSON.stringify({ ok: false, error: err }, null, 2));
        else {
            console.error('erro[' + err.code + ']: ' + err.message);
            if (err.hint) console.error('  dica: ' + err.hint);
            if (err.diagnostics) printDiags(err.diagnostics, 'erro');
        }
        process.exit(1);
    }
}

if (require.main === module) main();

module.exports = {
    main, describe, describeData, parseFlags, readOps, OPS_HELP, COMMANDS,
};
