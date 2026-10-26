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
const { strip } = require('../../sdk/lib/jsstrip.js');
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

    for (const name of names) {
        const abs = path.join(buildDir, name);
        let data = fs.readFileSync(abs);
        if (name.endsWith('.js')) {
            const before = data.length;
            const min = strip(data);
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

    const zip = createZip(entries);
    // releitura: garante CRC, central directory e layout instalavel
    const back = readZip(zip);
    const backNames = new Set(back.map((e) => e.name));
    for (const required of ['app.json', 'main.js', 'icon.png']) {
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
