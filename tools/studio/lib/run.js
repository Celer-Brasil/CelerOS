'use strict';
// Roda o build do Studio no harness do repo (Node + stubs do firmware) e
// grava PNG(s). Deterministico com --seed (default 7).

const fs = require('fs');
const path = require('path');
const { Project } = require('./project');
const { buildProject } = require('./build');

function parseFrames(raw) {
    if (!raw) return null;
    const list = String(raw).split(',').map((s) => parseInt(s.trim(), 10));
    if (list.some((n) => isNaN(n) || n < 0)) throw new Error('--frames: lista de ms nao-negativos');
    return list;
}

function runProject(dir, opts) {
    opts = opts || {};
    const project = Project.open(dir);
    const built = opts.noBuild ? { dir: project.buildDir() } : buildProject(dir, opts);
    if (!fs.existsSync(path.join(built.dir, 'app.json'))) {
        throw new Error('build inexistente em ' + built.dir + ' (rode `studio build`)');
    }
    const { runAppFolder } = require('../../sdk/lib/runner.js');
    const frames = parseFrames(opts.frames);
    const outFile = opts.out
        ? path.resolve(opts.out)
        : path.join(project.studioDir, 'run', 'tela.png');
    const seed = opts.seed !== undefined && opts.seed !== null ? (opts.seed >>> 0) : 7;
    let r;
    try {
        r = runAppFolder(built.dir, {
            render: true,
            stopAtMs: opts.ms !== undefined ? +opts.ms : 1200,
            frames: frames,
            framesPng: true,
            seed: seed,
            microsBias: 1,
        });
    } catch (e) {
        return { ok: false, dir: built.dir, error: e.message };
    }
    if (r.err) {
        return { ok: false, dir: built.dir, error: String(r.err), log: r.log };
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const shots = [];
    if (frames && r.frames.length) {
        for (const f of r.frames) {
            const p = path.join(path.dirname(outFile),
                'tela-' + String(f.ms).padStart(4, '0') + '.png');
            fs.writeFileSync(p, f.png);
            shots.push({ ms: f.ms, file: p });
        }
        fs.writeFileSync(outFile, r.frames[r.frames.length - 1].png);
    } else {
        fs.writeFileSync(outFile, r.renderer.png());
    }
    return {
        ok: true,
        dir: built.dir,
        app: built.app,
        out: outFile,
        frames: shots,
        w: r.renderer.w,
        h: r.renderer.h,
        log: r.log,
        seed: seed,
        build: {
            extras: built.extras, jsBytes: built.jsBytes,
            assetBytes: built.assetBytes, files: built.files,
            warnings: built.warnings,
        },
    };
}

module.exports = { runProject, parseFrames };
