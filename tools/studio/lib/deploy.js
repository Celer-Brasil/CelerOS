'use strict';
// "Compilacao" de deploy do Studio: validate/build -> JS enxuto (jsstrip) ->
// assets usados pelo build -> app.zip deterministico -> relatorio/hash.
// O zip tem app.json na raiz, o mesmo layout do `celerctl apps installzip`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const F = require('./format');
const { Project } = require('./project');
const { buildProject } = require('./build');
const { resolveLocal } = require('./deps');
const { strip } = require('../../sdk/lib/jsstrip.js');
const jsmin = require('../../sdk/lib/jsmin.js');
const { createZip, readZip } = require('./zip');

const DEPLOY_DIR = '.studio/deploy';

function defaultOut(project) {
    return path.join(project.dir, DEPLOY_DIR, 'app.zip');
}

function readDeployReport(dir) {
    const project = Project.open(dir);
    try {
        return F.readJson(path.join(project.dir, DEPLOY_DIR, 'report.json'));
    } catch (e) {
        return null;
    }
}

function deployProject(dir, opts) {
    opts = opts || {};
    const project = Project.open(dir);
    if (!opts.noBuild) buildProject(dir, {});
    const buildDir = project.buildDir();
    if (!fs.existsSync(buildDir)) {
        F.fail('deploy.nobuild', 'build inexistente: rode `studio build` antes de --no-build');
    }

    let out = opts.out ? path.resolve(opts.out) : defaultOut(project);
    let isDir = false;
    try { isDir = fs.statSync(out).isDirectory(); } catch (e) {}
    if (isDir || /[\\/]$/.test(String(opts.out || ''))) out = path.join(out, 'app.zip');
    if (path.extname(out).toLowerCase() !== '.zip') {
        F.fail('deploy.out', 'destino do deploy deve terminar em .zip: ' + out);
    }

    const entries = [];
    const jsFiles = [];
    let jsBefore = 0, jsAfter = 0;
    let assetBytes = 0, assetFiles = 0;
    const names = fs.readdirSync(buildDir).filter((n) => {
        try { return fs.statSync(path.join(buildDir, n)).isFile(); } catch (e) { return false; }
    }).sort();

    // globais que os modulos do pacote leem: o main.js nao pode renomear
    // esses no topo (o topo de um programa E o escopo global do app)
    const reserved = new Set();
    for (const name of names) {
        if (!name.endsWith('.js') || name === 'main.js') continue;
        try {
            for (const n of jsmin.freeNames(fs.readFileSync(path.join(buildDir, name))).names) reserved.add(n);
        } catch (e) { /* lint acusa sintaxe quebrada */ }
    }
    for (const name of names) {
        if (name === 'deps.json') continue;  // gerado abaixo a partir do build
        const abs = path.join(buildDir, name);
        let data = fs.readFileSync(abs);
        if (name.endsWith('.js')) {
            const before = data.length;
            let min;
            try {
                // modulo (s.*.js etc.) e embrulhado pelo loader: topo e local
                min = Buffer.from(jsmin.minify(data, {
                    top: name !== 'main.js', reserved: reserved,
                }).code);
            } catch (e) {
                min = strip(data);   // sintaxe exotica: cai no strip de sempre
            }
            jsBefore += before;
            jsAfter += min.length;
            jsFiles.push({ name, before, after: min.length });
            data = min;
        } else if (name === 'app.json') {
            // manifesto compacto; o parse valida antes
            data = Buffer.from(JSON.stringify(JSON.parse(data.toString('utf8'))));
        } else {
            assetBytes += data.length;
            assetFiles++;
        }
        entries.push({ name, data });
    }
    if (!names.length || !entries.some((e) => e.name === 'app.json') ||
        !entries.some((e) => e.name === 'main.js')) {
        F.fail('deploy.layout', 'build nao tem app.json/main.js');
    }

    // Lock de deps compartilhadas: o require do device so acha
    // /local/modules quando a pasta do app tem este arquivo. O installzip
    // nativo nao resolve deps, entao ele precisa viajar DENTRO do zip.
    const directDeps = project.data.deps || {};
    let depLock = {};
    if (Object.keys(directDeps).length) {
        try { depLock = resolveLocal(directDeps); }
        catch (e) {
            F.fail('deploy.deps', 'deps do app nao resolvem na arvore local: ' + e.message);
        }
        entries.push({
            name: 'deps.json',
            data: Buffer.from(JSON.stringify(depLock, Object.keys(depLock).sort(), 2) + '\n'),
        });
    }

    // Todo require de modulo compartilhado em QUALQUER .js do pacote tem que
    // estar na pasta ou no lock; um build com deps faltando falha aqui em vez
    // de crashar no device. Antes so o main.js era varrido: um s.<slug>.js
    // com require("celeros.game.fx") passava e o app morria no primeiro boot.
    const localModules = new Set(names.filter((n) => n.endsWith('.js'))
        .map((n) => n.slice(0, -3)));
    // varre o js ja enxuto: comentario nao vira falso require
    const requireRe = /require\(\s*["']([^"']+)["']\s*\)/g;
    for (const e of entries) {
        if (!/\.js$/.test(e.name)) continue;
        const src = e.data.toString('utf8');
        let rm;
        requireRe.lastIndex = 0;
        while ((rm = requireRe.exec(src)) !== null) {
            const mod = rm[1];
            if (localModules.has(mod) || depLock[mod]) continue;
            F.fail('deploy.deps',
                e.name + ' requer "' + mod + '", que nao esta na pasta nem no deps.json');
        }
    }

    const zip = createZip(entries);
    // releitura: garante CRC, central directory e layout instalavel
    const back = readZip(zip);
    const backNames = new Set(back.map((e) => e.name));
    const mustHave = ['app.json', 'main.js', 'icon.png'];
    if (Object.keys(depLock).length) mustHave.push('deps.json');
    for (const required of mustHave) {
        if (!backNames.has(required)) F.fail('deploy.layout', 'zip sem ' + required);
    }
    const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = out + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, zip);
    fs.renameSync(tmp, out);

    let buildReport = null;
    try { buildReport = F.readJson(path.join(project.studioDir, 'report.json')); } catch (e) { buildReport = null; }
    const report = {
        ok: true,
        app: project.data.packageName,
        name: project.data.name,
        version: project.data.version,
        zip: out,
        bytes: zip.length,
        sha256,
        entries: back.map((e) => ({ name: e.name, bytes: e.data.length, method: e.method })),
        deps: depLock,
        js: {
            before: jsBefore,
            after: jsAfter,
            saved: jsBefore - jsAfter,
            files: jsFiles,
        },
        assets: { bytes: assetBytes, files: assetFiles },
        build: {
            dir: buildDir,
            extras: buildReport ? buildReport.extras : null,
            warnings: buildReport ? (buildReport.warnings || []) : [],
        },
    };
    const reportDir = path.join(project.dir, DEPLOY_DIR);
    fs.mkdirSync(reportDir, { recursive: true });
    F.writeJson(path.join(reportDir, 'report.json'), report);
    return report;
}

module.exports = { deployProject, readDeployReport, defaultOut, DEPLOY_DIR };
