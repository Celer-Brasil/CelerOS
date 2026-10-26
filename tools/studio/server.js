'use strict';
// Servidor do Celer Studio: GUI web + API HTTP que executa o MESMO barramento
// de ops do CLI. Bind em 127.0.0.1 (sem auth: e uma ferramenta local).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const F = require('./lib/format');
const { Project } = require('./lib/project');
const { applyOps, undo, redo } = require('./lib/ops');
const { validateProject } = require('./lib/validate');
const { buildProject, exportBuild } = require('./lib/build');
const { runProject } = require('./lib/run');
// describeData e carregado sob demanda: `node studio.js serve` entra no
// server por dentro do proprio studio, e um require no topo devolveria o
// exports ainda vazio (circular) -> 'describeData is not a function'.
function describeProject(p) { return require('./studio').describeData(p); }

const UI_DIR = path.join(__dirname, 'ui');
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.qoa': 'application/octet-stream',
    '.wav': 'audio/wav',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
                          'Cache-Control': 'no-store' });
    res.end(body);
}

function sendText(res, code, text, type) {
    res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8',
                          'Cache-Control': 'no-store' });
    res.end(text);
}

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const parts = [];
        req.on('data', (d) => {
            size += d.length;
            if (size > (limit || 8 * 1024 * 1024)) { req.destroy(); reject(new Error('corpo grande demais')); return; }
            parts.push(d);
        });
        req.on('end', () => resolve(Buffer.concat(parts)));
        req.on('error', reject);
    });
}

function readJsonBody(req) {
    return readBody(req).then((buf) => {
        try { return JSON.parse(buf.toString('utf8') || '{}'); }
        catch (e) { throw new Error('json invalido: ' + e.message); }
    });
}

function startStudio(opts) {
    const projectDir = path.resolve(opts.dir);
    const port0 = opts.port !== undefined ? (opts.port | 0) : 8421;
    const clients = new Set();
    let project = Project.open(projectDir);   // falha cedo se nao for projeto
    let play = null;
    let watchTimer = null;
    let watcher = null;

    function snapshot() {
        project = Project.open(projectDir);
        const d = describeProject(project);
        const scenes = {};
        for (const sc of project.sceneByGuid.values()) scenes[sc.guid] = sc;
        const prefabs = {};
        for (const pf of project.prefabByGuid.values()) prefabs[pf.guid] = pf;
        return {
            ok: true, describe: d, scenes, prefabs, rev: project.data.rev,
            build: buildReport(),
            play: play ? { url: play.url, port: play.port, running: true } : { running: false },
        };
    }

    function buildReport() {
        try {
            return F.readJson(path.join(projectDir, '.studio', 'report.json'));
        } catch (e) { return null; }
    }

    function state() {
        project = Project.open(projectDir);
        return {
            ok: true,
            describe: describeProject(project),
            build: buildReport(),
            play: play ? { url: play.url, port: play.port, running: true } : { running: false },
        };
    }

    function broadcast(msg) {
        if (!clients.size) return;
        const data = 'data: ' + JSON.stringify(msg) + '\n\n';
        for (const c of clients) {
            if (c.writableLength > 3 * 1024 * 1024) continue;
            try { c.write(data); } catch (e) { clients.delete(c); }
        }
    }

    function stopPlay() {
        if (!play) return;
        const child = play.child;
        play = null;
        try { child.kill('SIGINT'); } catch (e) {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 1200);
        broadcast({ type: 'play', url: null, running: false });
    }

    function startPlay(body) {
        stopPlay();
        const built = buildProject(projectDir, {});
        const port = (body && body.port) || (port0 + 100);
        const child = spawn(process.execPath,
            [path.join(__dirname, 'lib', 'live.js'), built.dir, String(port)],
            { env: Object.assign({}, process.env, { CELER_MICROS_BIAS: '1' }),
              stdio: ['ignore', 'pipe', 'pipe'] });
        play = { child: child, port: port, url: null, log: [] };
        const onOut = (d) => {
            const text = d.toString();
            if (!play || play.child !== child) return;
            play.log.push(text);
            if (play.log.length > 100) play.log.shift();
            const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(text);
            if (m) {
                play.port = +m[1];
                play.url = m[0];
                broadcast({ type: 'play', url: play.url, port: play.port, running: true });
            }
            broadcast({ type: 'playlog', lines: text.split('\n').filter(Boolean) });
        };
        child.stdout.on('data', onOut);
        child.stderr.on('data', onOut);
        child.on('exit', () => {
            if (play && play.child === child) {
                play = null;
                broadcast({ type: 'play', url: null, running: false });
            }
        });
        return new Promise((resolve) => {
            const t = setTimeout(() => resolve({
                ok: true, url: play ? play.url : null, port: play ? play.port : port,
                build: { dir: built.dir, extras: built.extras, jsBytes: built.jsBytes },
            }), 1600);
            child.stdout.on('data', () => {
                if (play && play.url) { clearTimeout(t); resolve({ ok: true, url: play.url, port: play.port }); }
            });
        });
    }

    function serveAsset(res, rel) {
        const abs = path.resolve(projectDir, rel);
        const allowed = F.isInside(path.join(projectDir, 'Assets'), abs) || abs === path.join(projectDir, 'icon.png');
        if (!allowed) { sendText(res, 403, 'fora do projeto'); return; }
        fs.readFile(abs, (err, buf) => {
            if (err) { sendText(res, 404, 'nao encontrado'); return; }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
                                 'Cache-Control': 'no-store' });
            res.end(buf);
        });
    }

    async function handle(req, res) {
        const u = new URL(req.url, 'http://127.0.0.1');
        const url = u.pathname;

        if (req.method === 'GET' && url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

        if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
            fs.readFile(path.join(UI_DIR, 'index.html'), (err, buf) => {
                if (err) { sendText(res, 500, 'ui/index.html ausente'); return; }
                sendText(res, 200, buf, MIME['.html']);
            });
            return;
        }

        if (req.method === 'GET' && /^\/(style|app|ui)\.(css|js)$/.test(url)) {
            const file = path.join(UI_DIR, path.basename(url));
            fs.readFile(file, (err, buf) => {
                if (err) { sendText(res, 404, 'nao encontrado'); return; }
                sendText(res, 200, buf, MIME[path.extname(file)] || 'text/plain');
            });
            return;
        }

        if (req.method === 'GET' && url === '/api/snapshot') { sendJson(res, 200, snapshot()); return; }
        if (req.method === 'GET' && url === '/api/state') { sendJson(res, 200, state()); return; }

        if (req.method === 'GET' && url === '/api/assets') {
            serveAsset(res, u.searchParams.get('path') || '');
            return;
        }

        if (req.method === 'GET' && url === '/api/run.png') {
            const p = path.join(projectDir, '.studio', 'run', 'tela.png');
            fs.readFile(p, (err, buf) => {
                if (err) { sendText(res, 404, 'sem screenshot'); return; }
                res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
                res.end(buf);
            });
            return;
        }

        if (req.method === 'GET' && url === '/api/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
                                 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
            res.write(': ola\n\n');
            res.write('data: ' + JSON.stringify({ type: 'hello', play: play ? { url: play.url, running: true } : { running: false } }) + '\n\n');
            clients.add(res);
            req.on('close', () => clients.delete(res));
            return;
        }

        if (req.method === 'POST' && url === '/api/command') {
            const body = await readJsonBody(req);
            let out;
            if (Array.isArray(body.ops) || body.op) {
                const ops = Array.isArray(body.ops) ? body.ops : [body.op || body];
                out = applyOps(projectDir, ops, { dryRun: !!body.dryRun, ifRev: body.ifRev });
            } else if (body.cmd === 'build') {
                const b = buildProject(projectDir, {});
                if (play) { stopPlay(); }
                out = { ok: true, build: b };
            } else if (body.cmd === 'validate') {
                out = validateProject(Project.open(projectDir), {});
            } else if (body.cmd === 'undo' || body.cmd === 'redo') {
                const p = Project.open(projectDir);
                out = body.cmd === 'undo' ? undo(p) : redo(p);
            } else if (body.cmd === 'fmt') {
                const p = Project.open(projectDir);
                for (const rel of p.files.keys()) if (/\.(json|meta)$/.test(rel)) p.markDirty(rel);
                out = { ok: true, changed: p.saveDirty() };
            } else if (body.cmd === 'run') {
                const r = runProject(projectDir, { ms: body.ms, out: body.out, frames: body.frames, seed: body.seed });
                out = Object.assign({}, r, { url: r.ok ? '/api/run.png?t=' + Date.now() : null });
            } else if (body.cmd === 'play') {
                out = await startPlay(body);
            } else if (body.cmd === 'stop') {
                stopPlay();
                out = { ok: true, play: { running: false } };
            } else if (body.cmd === 'export') {
                out = exportBuild(projectDir, body.target, { force: !!body.force });
            } else if (body.cmd === 'describe') {
                out = describeData(Project.open(projectDir));
            } else {
                sendJson(res, 400, { ok: false, error: { code: 'cmd.unknown', message: 'comando desconhecido' } });
                return;
            }
            const snap = snapshot();
            out.snapshot = snap;
            broadcast({ type: 'changed', source: 'command' });
            sendJson(res, 200, out);
            return;
        }

        if (req.method === 'POST' && url === '/api/upload') {
            const buf = await readBody(req, 16 * 1024 * 1024);
            const name = F.sanitizeFileName(u.searchParams.get('name') || 'asset.png');
            const tmpDir = path.join(projectDir, '.studio', 'upload');
            fs.mkdirSync(tmpDir, { recursive: true });
            const tmp = path.join(tmpDir, Date.now() + '_' + name);
            fs.writeFileSync(tmp, buf);
            const op = {
                op: 'asset.import', src: tmp, name: name.replace(/\.[^.]+$/, ''),
                importer: u.searchParams.get('importer') || undefined,
                grid: u.searchParams.get('grid') || undefined,
                cols: u.searchParams.get('cols') || undefined,
                rows: u.searchParams.get('rows') || undefined,
                tw: u.searchParams.get('tw') || undefined,
                th: u.searchParams.get('th') || undefined,
            };
            for (const k of ['cols', 'rows', 'tw', 'th']) if (op[k] !== undefined) op[k] = +op[k];
            const r = applyOps(projectDir, [op], {});
            try { fs.rmSync(tmp, { force: true }); } catch (e) {}
            r.snapshot = snapshot();
            broadcast({ type: 'changed', source: 'upload' });
            sendJson(res, 200, r);
            return;
        }

        sendText(res, 404, 'nao encontrado');
    }

    const server = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
            sendJson(res, 500, { ok: false, error: { code: e.code || 'server', message: e.message,
                                                      hint: e.hint, diagnostics: e.diagnostics || null } });
        });
    });

    function startWatch() {
        try {
            watcher = fs.watch(projectDir, { recursive: true }, (ev, file) => {
                const f = String(file || '');
                if (/(^|[\\/])\.(studio|git)([\\/]|$)/.test(f) || /(^|[\\/])node_modules([\\/]|$)/.test(f)) return;
                if (!/\.(json|meta|js|png|qoa|wav)$/i.test(f)) return;
                clearTimeout(watchTimer);
                watchTimer = setTimeout(() => broadcast({ type: 'fs', path: f }), 180);
            });
        } catch (e) { /* FS sem watch */ }
    }

    let tries = 0;
    function listen(port) {
        const onErr = (e) => {
            if (e && e.code === 'EADDRINUSE' && tries < 20) { tries++; listen(port + 1); }
            else { console.error('erro: nao consegui abrir a porta: ' + (e && e.message)); process.exit(1); }
        };
        server.once('error', onErr);
        server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', onErr);
            const p = server.address().port;
            const url = 'http://127.0.0.1:' + p;
            console.log('Celer Studio: ' + url + '  (projeto ' + projectDir + ')');
            startWatch();
            if (opts.open) execFile('xdg-open', [url], () => {});
        });
    }
    listen(port0);

    const ping = setInterval(() => {
        for (const c of clients) { try { c.write(': ping\n\n'); } catch (e) {} }
    }, 15000);
    ping.unref();

    process.on('SIGINT', () => {
        stopPlay();
        console.log('\nstudio encerrado');
        process.exit(0);
    });

    function close(cb) {
        stopPlay();
        clearInterval(ping);
        if (watcher) { try { watcher.close(); } catch (e) {} }
        server.close(cb || (() => {}));
    }

    return { server: server, get play() { return play; }, stopPlay: stopPlay, close: close };
}

module.exports = { startStudio };
