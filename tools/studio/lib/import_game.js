'use strict';
// Importa um app CelerOS existente para um projeto do Celer Studio em MODO
// LEGADO: o app original continua rodando (via bridge no Play), mas os
// assets e scripts ficam no projeto para edicao. A cena inicial e um cartao
// informativo; o runtime legado nao a usa.
//
//   node tools/sdk/celer.js studio import-game hub_apps/Sentinela /tmp/Sentinela-legado

const fs = require('fs');
const path = require('path');
const F = require('./format');
const { Project, PROJECT_FILE } = require('./project');
const A = require('./assets');
const { validateProject } = require('./validate');

// grades conhecidas dos 4 jogos maiores (ai_atlas e 4x4 de 64 px; as folhas
// da Lenda sao as do _dev/lenda_sprites.py)
const PROFILES = {
    'sprite-sheet': [
        { file: 'ai_atlas.png', cols: 4, rows: 4, tw: 64, th: 64 },
        { file: 'heroi.png', cols: 10, rows: 1, tw: 32, th: 32 },
        { file: 'inimigos.png', cols: 12, rows: 1, tw: 32, th: 32 },
        { file: 'itens.png', cols: 10, rows: 1, tw: 32, th: 32 },
        { file: 'chefe.png', cols: 2, rows: 1, tw: 96, th: 96 },
    ],
    'tileset': [
        { file: 'tileset.png', cols: 8, rows: 3, tw: 32, th: 32 },
    ],
};

function profileFor(fileName) {
    for (const importer of Object.keys(PROFILES)) {
        for (const p of PROFILES[importer]) {
            if (p.file.toLowerCase() === fileName.toLowerCase()) {
                return { importer: importer, cols: p.cols, rows: p.rows, tw: p.tw, th: p.th };
            }
        }
    }
    return null;
}

function importGame(appDir, destDir, opts) {
    opts = opts || {};
    const src = path.resolve(appDir);
    const manifest = path.join(src, 'app.json');
    if (!fs.existsSync(manifest)) F.fail('import.app', 'app.json nao existe: ' + manifest);
    const app = F.readJson(manifest);
    const dest = path.resolve(destDir ||
        path.join('studio_games', F.sanitizeFileName(app.name || 'jogo', 60)));
    if (fs.existsSync(path.join(dest, PROJECT_FILE))) {
        F.fail('project.exists', 'ja existe um projeto em ' + dest);
    }

    const folder = path.basename(src);
    const project = Project.init(dest, {
        name: opts.name || app.name || folder,
        pkg: app.packageName,
        author: app.author,
        description: app.description,
    });
    const p = project.data;
    p.name = opts.name || app.name || folder;
    p.packageName = app.packageName;
    p.version = app.version || '0.1.0';
    p.api = app.api || p.api;
    p.author = app.author || p.author;
    p.description = app.description || p.description;
    p.type = app.type || 'Game';
    p.category = app.category || 'Jogos';
    p.requires = app.requires || ['psram'];
    p.topbar = app.topbar === undefined ? false : !!app.topbar;
    p.permissions = app.permissions || [];
    p.deps = app.deps || {};
    p.changelog = app.changelog || (p.version + ': projeto do Celer Studio (legado)');
    p.runtime = 'legacy';
    p.legacy = {
        entry: app.main || 'main.js',
        name: folder,
        bases: ['/local/apps/' + folder + '/', '/sd/apps/' + folder + '/'],
    };
    p.canvas = { w: 480, h: 480, native: true, fps: 30, inset: 0 };
    p.startScene = p.startScene || '';
    project.markDirty(PROJECT_FILE);
    project.saveDirty();

    // icone do pacote
    const icon = path.join(src, 'icon.png');
    if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(project.dir, 'icon.png'));

    const imported = { assets: [], scripts: [], skipped: [] };
    const files = fs.readdirSync(src, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name)
        .sort();
    for (const name of files) {
        if (name === 'app.json' || name === 'icon.png' || name === 'test.js') continue;
        if (name === 'README.md' || name.endsWith('.d.ts') || name === 'jsconfig.json') continue;
        const abs = path.join(src, name);
        const ext = path.extname(name).toLowerCase();
        if (ext === '.js') {
            const r = A.importScriptFile(project, abs, name);
            imported.scripts.push(r.asset.relPath);
        } else if (ext === '.png' || ext === '.qoa' || ext === '.wav') {
            const base = path.basename(name, ext);
            const prof = ext === '.png' ? profileFor(name) : null;
            const optsAsset = prof
                ? { name: base, importer: prof.importer, cols: prof.cols, rows: prof.rows,
                    tw: prof.tw, th: prof.th }
                : { name: base, importer: ext === '.png' ? 'sprite' : 'audio' };
            const r = A.importAsset(project, abs, optsAsset);
            imported.assets.push(r.asset.relPath);
        } else {
            imported.skipped.push(name);
        }
    }

    // cartao informativo na cena inicial (o modo legado ignora cenas)
    const sc = project.scene('Principal');
    if (sc) {
        sc.name = 'Legado';
        const e = (sc.entities || []).find((x) =>
            (x.components || []).some((c) => c.type === 'text'));
        if (e) {
            const c = (e.components || []).find((x) => x.type === 'text');
            c.fields.text = p.name + ' - runtime legado';
            c.fields.px = 20;
            c.fields.align = 'center';
            e.transform.x = 240;
            e.transform.y = 220;
        }
        project.writeScene(sc);
        project.markDirty(PROJECT_FILE);
    }
    project.saveDirty();
    project.load();

    const project2 = Project.open(dest);
    const validation = validateProject(project2, {});
    const srcLabel = (path.relative(process.cwd(), src) || '.').split(path.sep).join('/');
    const destLabel = (path.relative(process.cwd(), dest) || '.').split(path.sep).join('/');
    const readme = path.join(dest, 'README.md');
    fs.writeFileSync(readme,
        '# ' + p.name + ' - Celer Studio (modo legado)\n\n' +
        'App original: `' + srcLabel + '`\n\n' +
        'O Play/build usa o **runtime legado**: o `' + p.legacy.entry +
        '` original roda dentro do loop do Studio (bridge). Assets e scripts sao editaveis ' +
        'no projeto; a cena `Legado` e so um cartao e nao controla o jogo.\n\n' +
        '```bash\n' +
        'node tools/sdk/celer.js studio "' + destLabel + '" build\n' +
        'node tools/sdk/celer.js studio "' + destLabel + '" run --frames 0,1200\n' +
        'node tools/sdk/celer.js studio "' + destLabel + '" serve --open\n' +
        '```\n\n' +
        'Proximo passo de remontagem: extrair levels/prefabs para cenas e trocar o modo legado ' +
        'por componentes nativos, sistema por sistema.\n');

    return {
        ok: validation.errors.length === 0,
        dir: dest,
        runtime: 'legacy',
        legacy: p.legacy,
        imported: imported,
        validation: { errors: validation.errors, warnings: validation.warnings },
    };
}

module.exports = { importGame, PROFILES, profileFor };
