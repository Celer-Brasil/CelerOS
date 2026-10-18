#!/usr/bin/env node
'use strict';
// celer.js — CLI do SDK de apps CelerOS.
//
// Fluxo do autor de app:
//   node tools/sdk/celer.js new MeuApp            scaffold (app.json + main.js
//                                                 + icon + types para o editor)
//   node tools/sdk/celer.js emu MeuApp            roda no emulador (tela PNG)
//   python3 tools/celerctl.py dev MeuApp          live no dispositivo
//   node tools/sdk/celer.js publish MeuApp        publica na loja
//
// `lint`/`check` delegam ao tools/app_lint (manifest derivado do firmware);
// `dev`/`publish` delegam ao celerctl/celerctl (Python). Sem dependencias:
// acorn e font8x8 sao vendorados, PNG usa o zlib do Node.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildManifest, runLint, runCheck } = require('../app_lint/lint.js');
const { generate } = require('./lib/dts.js');
const { runAppFolder } = require('./lib/runner.js');
const { encodePng } = require('./lib/png.js');
const { glyph } = require('./lib/font8x8.js');
const { Renderer } = require('./lib/renderer.js');
const { parseInputScript, wireInput } = require('./lib/input.js');
const { encodeGif } = require('./lib/gif.js');

const ROOT = path.resolve(__dirname, '../..');
const TYPES_OUT = path.join(__dirname, 'types', 'celer.d.ts');
const ENGINE_DIR = path.join(__dirname, 'engine');
const HUB_URL = process.env.CELER_HUB_URL || 'https://os.celer.tec.br';

function die(msg, code = 1) {
    console.error('erro: ' + msg);
    process.exit(code);
}

function usage() {
    console.log('uso: node tools/sdk/celer.js <comando> [args]');
    console.log('');
    console.log('  new NOME [--pkg br.autor.nome] [--dir BASE] [--game]     cria app de exemplo');
    console.log('                                               (--game: jogo c/ deps celeros.game)');
    console.log('  deps [PASTA]                                 deps do app.json + versoes no hub/local');
    console.log('  deps set NOME RANGE [PASTA]                  grava dep no app.json (\'-\' remove)');
    console.log('  lint [alvos...] [--strict]                   valida ES5 + API (app_lint)');
    console.log('  types [--out ARQ]                            (re)gera celer.d.ts do manifest');
    console.log('  test PASTA [--ms N] [--events ARQ] [--input ARQ] [--seed N] roda o app no harness (stubs Node)');
    console.log('  emu PASTA [--events ARQ] [--ms N] [--out ARQ] roda + snapshot PNG da tela (240x320; 480x480 no canvas nativo)');
    console.log('      --input ARQ      script de toques (tap/swipe/down/up com tempo em ms)');
    console.log('      --frames 0,600   PNG por marco do relogio + diff de pixels');
    console.log('      --gif ARQ        grava a rodada num GIF animado (com --ms e --fps)');
    console.log('      --seed N         Math.random deterministico (mesma partida)');
    console.log('      --grid [N]       grade de coordenadas no PNG (default 20px)');
    console.log('      --scale N        amplia o PNG por vizinho mais proximo');
    console.log('  emu PASTA --serve [--port P] [--open]      preview AO VIVO no navegador (toque, teclado, hot reload)');
    console.log('  bench PASTA [--ms N] [--events ARQ] [--input ARQ] [--seed N] [--vs B]  ms reais por quadro (A/B com --vs)');
    console.log('  check                                        drift: codigo x docs x stubs x types x emulador');
    console.log('  publish PASTA... [--dry]                     publica na loja (celerhub)');
    console.log('  publish-dep ARQUIVO.js [--hub URL] [--force] publica dependencia no repo do hub');
    console.log('  dev PASTA [--port P] [--shots]               watch + reload no device (celerctl)');
}

// ---------------------------------------------------------------- scaffold

// Icone 64x64: quadrado arredondado no tom accent do tema com a inicial do
// app em glifo 8x8 escalado — placeholder para o autor trocar depois.
function makeIconPng(letter) {
    const S = 64, R = 14;
    const bg = [0x38, 0xBC, 0xF8];   // accent do tema (RGB888)
    const fg = [0x08, 0x10, 0x20];   // onAccent
    const px = new Uint8Array(S * S * 3);
    const inside = (x, y) => {
        // retangulo com cantos arredondados (anti-alias simples por distancia)
        const cx = Math.min(Math.max(x, R), S - 1 - R), cy = Math.min(Math.max(y, R), S - 1 - R);
        return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= R * R;
    };
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const i = (y * S + x) * 3;
            if (!inside(x, y)) continue;  // transparente (preto; PNG RGB sem alpha)
            px[i] = bg[0]; px[i + 1] = bg[1]; px[i + 2] = bg[2];
        }
    }
    const bm = glyph(letter.toUpperCase().charCodeAt(0));
    if (bm) {
        const scale = 6, gw = 8 * scale, ox = (S - gw) / 2 | 0, oy = (S - gw) / 2 | 0;
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                if (!((bm[row] >> col) & 1)) continue;
                for (let sy = 0; sy < scale; sy++) {
                    for (let sx = 0; sx < scale; sx++) {
                        const x = ox + col * scale + sx, y = oy + row * scale + sy;
                        if (x < 0 || y < 0 || x >= S || y >= S) continue;
                        const i = (y * S + x) * 3;
                        px[i] = fg[0]; px[i + 1] = fg[1]; px[i + 2] = fg[2];
                    }
                }
            }
        }
    }
    return encodePng(S, S, Buffer.from(px), false);
}

function cmdNew(args) {
    const name = args[0];
    if (!name) die('new: informe o NOME do app (ex: new MeuApp)');
    const flags = parseFlags(args.slice(1));
    const base = flags.dir ? path.resolve(flags.dir) : process.cwd();
    const dir = path.join(base, name);
    if (fs.existsSync(dir)) die('new: ' + dir + ' ja existe');
    const game = !!flags.game;
    const appkit = !!flags.appkit;

    // packageName: default br.celer.<slug> (autor troca pelo proprio)
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const pkg = flags.pkg || ('br.celer.' + slug);
    const api = buildManifest().apiLevel;

    const appJson = {
        name: name,
        packageName: pkg,
        version: '0.1.0',
        author: 'Seu Nome',
        description: game ? 'Jogo feito com a engine CelerOS' :
                            'App CelerOS criado com o SDK',
        type: game ? 'Game' : 'App',
        category: game ? 'Jogos' : 'Utilidades',
        api: api,
        permissions: [],
        changelog: '0.1.0: primeira versao',
    };
    if (game) {
        // jogos com a engine rodam nas placas S3 com PSRAM (teto de 1 MB);
        // sem topbar, tela cheia como o Supernova. A familia CelerGame e
        // DEP do hub (API 30): nao e copiada — o install da loja baixa em
        // /local/modules e o require resolve de la. O scaffold adota so o
        // core + fx (cada modulo e uma dep; quem adota pouco paga pouco —
        // sem psram o teto e 48KB e o core enxuto ~20KB cabe). Fisica de
        // arcade de poucos corpos (o padrao do template) e na mao;
        // celeros.physics so entra quando o jogo pedir verlet/rigid (ver
        // Game Engine Guide)
        appJson.requires = ['psram'];
        appJson.topbar = false;
        appJson.deps = {
            'celeros.game': '^' + engineVersion('celeros.game.js'),
            'celeros.game.fx': '^' + engineVersion('celeros.game.fx.js'),
        };
    }
    if (appkit) {
        // app geral sobre o CelerKit: o pacote kit (core + fmt + path + data
        // + net + text + form + list + caps) numa unica dep — o fecho cabe
        // de sobra no teto de 48KB sem psram (~14KB stripped). Modulos fora
        // do kit (chat/input/ai/launch/...) entram a parte no app.json (ver
        // App Kit Guide)
        appJson.permissions = ['fs'];
        appJson.description = 'App CelerOS feito com o CelerKit';
        appJson.deps = {
            'celeros.app.kit': '^' + engineVersion('celeros.app.kit.js'),
        };
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify(appJson, null, 2) + '\n');
    const mainSrc = fs.readFileSync(
        path.join(__dirname, game ? 'template-game' : 'template', 'main.js'), 'utf8');
    fs.writeFileSync(path.join(dir, 'main.js'),
                     mainSrc.replace(/\{\{APP_NAME\}\}/g, name));
    fs.writeFileSync(path.join(dir, 'README.md'),
                     fs.readFileSync(path.join(__dirname, 'template', 'README.md'), 'utf8')
                         .replace(/\{\{APP_NAME\}\}/g, name)
                         .replace(/\{\{APP_DIR\}\}/g, name));
    fs.copyFileSync(TYPES_OUT, path.join(dir, 'celer.d.ts'));
    fs.writeFileSync(path.join(dir, 'jsconfig.json'), JSON.stringify({
        compilerOptions: { checkJs: false },
        include: ['*.js', '*.d.ts'],
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'icon.png'), makeIconPng(name[0]));
    if (game) {
        // so os d.ts dos modulos adotados (autocomplete no editor; dev-only,
        // o publish exclui *.d.ts do zip) — o .js vem da dep do hub
        fs.copyFileSync(path.join(ENGINE_DIR, 'celeros.game.d.ts'),
                        path.join(dir, 'celeros.game.d.ts'));
        fs.copyFileSync(path.join(ENGINE_DIR, 'celeros.game.fx.d.ts'),
                        path.join(dir, 'celeros.game.fx.d.ts'));
    }
    if (appkit) {
        fs.copyFileSync(path.join(ENGINE_DIR, 'celeros.app.d.ts'),
                        path.join(dir, 'celeros.app.d.ts'));
        ['fmt', 'path', 'data', 'net', 'text', 'form', 'list', 'caps', 'kit'].forEach(function (m) {
            fs.copyFileSync(path.join(ENGINE_DIR, 'celeros.app.' + m + '.d.ts'),
                            path.join(dir, 'celeros.app.' + m + '.d.ts'));
        });
    }

    console.log('criado: ' + dir + ' (api ' + api +
                (game ? ', jogo com deps celeros.game + fx' : '') +
                (appkit ? ', app com dep celeros.app.kit' : '') + ')');
    console.log('proximos passos:');
    console.log('  node tools/sdk/celer.js lint ' + dir);
    console.log('  node tools/sdk/celer.js emu ' + dir);
    console.log("  python3 tools/celerctl.py dev " + dir);
}

// ---------------------------------------------------------------- deps ----

// Versao interna de um modulo da engine (var X = { version: 'x.y.z' } ou
// atribuicao E.version = 'x.y.z' no shim de compatibilidade).
function engineVersion(file) {
    const m = fs.readFileSync(path.join(ENGINE_DIR, file), 'utf8')
        .match(/version\s*[:=]\s*['"]([^'"]+)['"]/);
    return m ? m[1] : '0.0.0';
}

// Indice de deps do hub (/store/deps.json) — https do core, timeout curto:
// sem rede cai no so-local sem quebrar o comando.
function fetchHubDeps(cb) {
    const https = require('https');
    const req = https.get(HUB_URL.replace(/\/$/, '') + '/store/deps.json', (res) => {
        if (res.statusCode !== 200) { res.resume(); return cb(null); }
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
            try { cb(JSON.parse(body)); } catch (e) { cb(null); }
        });
    });
    req.on('error', () => cb(null));
    req.setTimeout(5000, () => { req.destroy(); cb(null); });
}

// deps do app.json + o que existe no hub e na arvore local (tools/sdk/engine)
function cmdDeps(args) {
    if (args[0] === 'set') return cmdDepsSet(args.slice(1));
    const folder = args.find((a) => !a.startsWith('--')) || '.';
    const dir = path.resolve(folder);
    const appJsonPath = path.join(dir, 'app.json');
    if (!fs.existsSync(appJsonPath)) die('deps: ' + appJsonPath + ' nao existe');
    const meta = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    const deps = meta.deps || {};

    // versao local (canonica do SDK) de CADA modulo da arvore — nao so
    // engine/physics: grid/sfx/mesh existem e sao deps igualmente
    const local = {};
    for (const f of fs.readdirSync(ENGINE_DIR).filter((n) => n.endsWith('.js'))) {
        local[f.slice(0, -3)] = engineVersion(f);
    }

    fetchHubDeps((hub) => {
        console.log('deps de ' + meta.packageName + ' (' + appJsonPath + '):');
        const names = Object.keys(deps);
        if (!names.length) console.log('  (nenhuma — "deps set celeros.engine ^1.0.0")');
        for (const n of names) {
            console.log('  ' + n + ' ' + deps[n]);
            if (hub && hub.deps && hub.deps[n]) {
                console.log('    hub: ' + Object.keys(hub.deps[n]).sort().join(', '));
            } else if (hub) {
                console.log('    hub: NAO PUBLICADA');
            }
            if (local[n]) console.log('    local (tools/sdk/engine): ' + local[n]);
        }
        if (!hub) console.log('(hub ' + HUB_URL + ' inalcancavel — mostrando so o local)');
    });
}

// deps set NOME RANGE [PASTA]: grava/remove a dep no app.json ('-' remove)
function cmdDepsSet(args) {
    const nome = args[0];
    const range = args[1];
    const folder = args[2] || '.';
    if (!nome || !range) die('deps set NOME RANGE [PASTA]  (range "-" remove)');
    const appJsonPath = path.resolve(folder, 'app.json');
    if (!fs.existsSync(appJsonPath)) die('deps: ' + appJsonPath + ' nao existe');
    const meta = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    meta.deps = meta.deps || {};
    if (range === '-') {
        delete meta.deps[nome];
        if (!Object.keys(meta.deps).length) delete meta.deps;
    } else {
        if (!/^\^?\d+\.\d+\.\d+$/.test(range)) die('range deve ser "^1.2.0" ou "1.2.0"');
        if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(nome)) die('nome deve ser prefixo.nome (ex: celeros.engine)');
        meta.deps[nome] = range;
    }
    fs.writeFileSync(appJsonPath, JSON.stringify(meta, null, 2) + '\n');
    console.log('deps de ' + meta.packageName + ': ' +
                (meta.deps ? JSON.stringify(meta.deps) : '(nenhuma)'));
}

// ---------------------------------------------------------------- lint/types

function cmdLint(args) {
    const strict = args.includes('--strict');
    // alvos relativos ao cwd viram absolutos: collectTargets do app_lint
    // resolve relativo ao ROOT do repo (bom para data/apps, ruim para apps fora)
    const targets = args.filter((a) => !a.startsWith('--'))
        .map((a) => path.isAbsolute(a) ? a : path.resolve(process.cwd(), a));
    const result = runLint(targets, { strict });
    for (const a of result.apps) {
        const errs = a.diagnostics.filter((dg) => dg.severity === 'erro').length;
        const warns = a.diagnostics.length - errs;
        const status = errs ? errs + ' erro(s)' : 'OK';
        console.log(a.relDir + ': ' + status + (warns ? ' (' + warns + ' aviso(s))' : ''));
        for (const dg of a.diagnostics) {
            console.log('  ' + dg.file + ':' + dg.line + ':' + dg.col + ' ' +
                        dg.severity + '[' + dg.rule + ']: ' + dg.message);
        }
    }
    console.log('');
    console.log('apps: ' + result.totals.apps + '  erros: ' + result.totals.errors +
                '  avisos: ' + result.totals.warnings +
                '  (API level ' + result.manifest.apiLevel + ', ' +
                result.manifest.counts.functions + ' funcoes no manifest)');
    process.exit(result.ok ? 0 : 1);
}

function cmdTypes(args) {
    const flags = parseFlags(args);
    const out = flags.out ? path.resolve(flags.out) : TYPES_OUT;
    const text = generate() + '\n';
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text);
    console.log(out + ': regenerado (' + text.split('\n').length + ' linhas)');
}

// ---------------------------------------------------------------- test/emu

function printRun(r) {
    for (const line of r.log) console.log('[app] ' + line);
    if (r.err) {
        console.error('erro do app:');
        console.error(String(r.err).split('\n').slice(0, 12).join('\n'));
    } else {
        console.log('ok: app terminou limpo (' + r.log.length + ' linhas de log)');
    }
}

// wire de eventos comum a test/emu/bench: --events ARQ (JS) e/ou --input ARQ
// (script declarativo de toques). O input roda DEPOIS do events, envolvendo
// o delay que o events ja tenha envolvido.
function buildEvents(flags) {
    let events = null;
    if (flags.events) {
        const m = require(path.resolve(flags.events));
        events = typeof m === 'function' ? m : m.events;
        if (typeof events !== 'function') die(flags.events + ': exporte `events(env)`');
    }
    if (flags.input) {
        const script = parseInputScript(fs.readFileSync(path.resolve(flags.input), 'utf8'));
        const base = events;
        events = (env) => { if (base) base(env); wireInput(env, script); };
    }
    return events;
}

function cmdTest(args) {
    const flags = parseFlags(args);
    const folder = flags._[0];
    if (!folder) die('test: informe a PASTA do app');
    try {
        printRun(runAppFolder(path.resolve(folder), {
            stopAtMs: flags.ms ? +flags.ms : undefined,
            seed: flags.seed != null ? (+flags.seed >>> 0) : null,
            events: buildEvents(flags),
        }));
    } catch (e) { die(e.message); }
}

// bench PASTA [--ms N] [--events ARQ] [--vs PASTA2] [--json]: ms reais por
// quadro no harness (perfil do runner). --vs roda a segunda pasta com os
// mesmos parametros e imprime lado a lado — comparar duas versoes do
// mesmo app (A/B de otimizacao) vira um comando.
function fmtProfile(p) {
    return 'media ' + p.avgMs.toFixed(3) + ' ms  p50 ' + p.p50Ms.toFixed(3) +
           '  p95 ' + p.p95Ms.toFixed(3) + '  max ' + p.maxMs.toFixed(1) +
           '  (' + p.frames + ' quadros)';
}

function cmdBench(args) {
    const flags = parseFlags(args);
    const folder = flags._[0];
    if (!folder) die('bench: informe a PASTA do app');
    const ms = flags.ms ? +flags.ms : 5000;
    const seed = flags.seed != null ? (+flags.seed >>> 0) : null;
    const run = (f) => runAppFolder(path.resolve(f), { stopAtMs: ms,
                                                       events: buildEvents(flags), seed,
                                                       profile: true });
    const a = run(folder);
    if (a.err && !/harnessStop/.test(String(a.err))) {
        console.error('erro do app:');
        console.error(String(a.err).split('\n').slice(0, 12).join('\n'));
        process.exit(1);
    }
    if (flags.vs) {
        const b = run(flags.vs);
        if (b.err && !/harnessStop/.test(String(b.err))) {
            console.error('erro do app B (--vs):');
            console.error(String(b.err).split('\n').slice(0, 12).join('\n'));
            process.exit(1);
        }
        if (flags.json) {
            console.log(JSON.stringify({ a: path.resolve(folder), b: path.resolve(flags.vs),
                                         profA: a.profile, profB: b.profile }));
        } else {
            console.log('A) ' + path.resolve(folder));
            console.log('   ' + fmtProfile(a.profile));
            console.log('B) ' + path.resolve(flags.vs));
            console.log('   ' + fmtProfile(b.profile));
            const razao = b.profile.avgMs > 0 ? a.profile.avgMs / b.profile.avgMs : 0;
            console.log('A/B: media ' + razao.toFixed(2) + 'x ' +
                        (razao < 1 ? '(A mais leve)' : '(B mais leve)'));
        }
        return;
    }
    if (flags.json) console.log(JSON.stringify({ app: path.resolve(folder), prof: a.profile }));
    else console.log(path.resolve(folder) + ': ' + fmtProfile(a.profile));
}

// --grid/--mark/--scale no PNG: aplica sobre uma COPIA do framebuffer (o
// fb vivo do renderer nao pode ser sujo entre quadros do app)
function decoratePng(fb, w, h, opts) {
    const tmp = Object.create(Renderer.prototype);
    tmp.w = w; tmp.h = h; tmp.fb = fb.slice();
    if (opts.grid) tmp.gridOverlay(opts.grid);
    if (opts.marks) for (const m of opts.marks) tmp.marker(m[0], m[1]);
    return tmp.pngScaled(opts.scale || 1);
}

function parseMarks(flags) {
    const raw = flags.marks != null ? flags.marks : flags.mark;
    if (!raw || raw === true) return null;
    const out = [];
    for (const part of String(raw).split(';')) {
        const m = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec(part);
        if (!m) die('--mark: esperava X,Y (ex. --mark 120,200;80,160)');
        out.push([+m[1], +m[2]]);
    }
    return out.length ? out : null;
}

function fbToRgb(fb) {
    const out = Buffer.alloc(fb.length * 3);
    for (let i = 0, k = 0; i < fb.length; i++, k += 3) {
        const p = fb[i];
        out[k] = ((p >> 11) & 0x1F) * 255 / 31 | 0;
        out[k + 1] = ((p >> 5) & 0x3F) * 255 / 63 | 0;
        out[k + 2] = (p & 0x1F) * 255 / 31 | 0;
    }
    return out;
}

function cmdEmu(args) {
    const flags = parseFlags(args);
    const folder = flags._[0];
    if (!folder) die('emu: informe a PASTA do app');
    const dir = path.resolve(folder);

    // --serve: emulador ao vivo. Nao retorna: o servidor HTTP segura o
    // processo (Ctrl+C encerra). O app roda num Worker com o harness.
    if (flags.serve) {
        const { startLive } = require('./lib/live_server.js');
        startLive({
            appDir: dir,
            port: flags.port != null ? +flags.port : 8420,
            fps: flags.fps ? +flags.fps : 30,
            open: !!flags.open,
            seed: flags.seed != null ? (+flags.seed >>> 0) : null,
        });
        return;
    }

    const out = flags.out ? path.resolve(flags.out) : path.join(dir, '.dev', 'tela.png');
    const decor = { grid: flags.grid ? (isNaN(+flags.grid) ? 20 : +flags.grid) : 0,
                    marks: parseMarks(flags),
                    scale: flags.scale ? Math.max(1, Math.min(8, +flags.scale | 0)) : 1 };

    let events = null;
    if (flags.events) {
        const m = require(path.resolve(flags.events));
        events = typeof m === 'function' ? m : m.events;
        if (typeof events !== 'function') die(flags.events + ': exporte `events(env)` (use env.__harness.tap/pushTouch)');
    }
    if (flags.input) {
        const script = parseInputScript(fs.readFileSync(path.resolve(flags.input), 'utf8'));
        const base = events;
        events = (env) => { if (base) base(env); wireInput(env, script); };
    }

    // --gif: quadros na grade do relogio (--ms de app, --fps de captura) e
    // encode GIF no fim; sem PNG intermediario (framesPng: false)
    let frames = null, gifPath = null, gifFps = 20;
    if (flags.gif) {
        gifPath = path.resolve(flags.gif);
        const ms = flags.ms ? Math.max(100, +flags.ms) : 3000;
        gifFps = Math.max(1, Math.min(30, flags.fps ? +flags.fps : 20));
        frames = [];
        for (let t = 0; t <= ms + 0.5; t += 1000 / gifFps) frames.push(Math.round(t));
    } else if (flags.frames != null) {
        frames = String(flags.frames).split(',').map((s) => parseInt(s.trim(), 10));
        if (frames.some((n) => isNaN(n) || n < 0)) die('--frames: lista de ms nao-negativos, ex. "0,600,1500"');
    }

    try {
        const r = runAppFolder(dir, { render: true,
                                      stopAtMs: flags.ms ? +flags.ms : undefined,
                                      frames, events,
                                      seed: flags.seed != null ? (+flags.seed >>> 0) : null,
                                      framesPng: !gifPath });
        fs.mkdirSync(path.dirname(out), { recursive: true });
        if (gifPath) {
            const g = [];
            for (let i = 0; i < r.frames.length; i++) {
                const f = r.frames[i];
                const next = i + 1 < r.frames.length ? r.frames[i + 1].ms : f.ms + 1000 / gifFps;
                g.push({ rgb: fbToRgb(f.fb), delayMs: Math.max(20, next - f.ms) });
            }
            fs.writeFileSync(gifPath, encodeGif(r.renderer.w, r.renderer.h, g));
            console.log('gif: ' + gifPath + ' (' + g.length + ' quadros, ' + gifFps + ' fps, ' +
                        r.renderer.w + 'x' + r.renderer.h + ')');
        } else if (frames) {
            let prev = null;
            for (const f of r.frames) {
                const fout = path.join(path.dirname(out),
                                       'tela-' + String(f.ms).padStart(4, '0') + '.png');
                fs.writeFileSync(fout, decoratePng(f.fb, r.renderer.w, r.renderer.h, decor));
                if (prev) {
                    let diff = 0;
                    for (let i = 0; i < prev.fb.length; i++) if (prev.fb[i] !== f.fb[i]) diff++;
                    const pct = diff * 100 / prev.fb.length;
                    const label = pct >= 0.1 ? pct.toFixed(1) : (diff > 0 ? '<0.1' : '0.0');
                    console.log('frame ' + f.ms + 'ms: ' + fout + ' (' + label + '% dos pixels mudaram)');
                } else {
                    console.log('frame ' + f.ms + 'ms: ' + fout + ' (estado inicial)');
                }
                prev = f;
            }
        } else {
            fs.writeFileSync(out, decoratePng(r.renderer.fb, r.renderer.w, r.renderer.h, decor));
        }
        printRun(r);
        if (r.err && r.renderer) {
            const errOut = path.join(path.dirname(out), 'erro.png');
            fs.writeFileSync(errOut, decoratePng(r.renderer.fb, r.renderer.w, r.renderer.h, decor));
            console.log('erro: tela do erro salva em ' + errOut);
        }
        if (!frames) {
            const extra = r.renderer.unsupported.size
                ? '; nao renderizado: ' + Array.from(r.renderer.unsupported).join(', ') : '';
            console.log('tela: ' + out + ' (' + r.renderer.w + 'x' + r.renderer.h +
                        (decor.scale > 1 ? ' x' + decor.scale : '') +
                        (decor.grid ? '; grade ' + decor.grid + 'px' : '') + extra + ')');
        }
        process.exit(r.err ? 1 : 0);
    } catch (e) { die(e.message); }
}

// ---------------------------------------------------------------- check

function cmdCheck() {
    // 1) drift base do app_lint: codigo x docs x stubs do harness
    const lintCheck = runCheck();
    if (lintCheck.text) console.log(lintCheck.text);
    let errors = lintCheck.errors;

    // 2) celer.d.ts commitado vs manifest atual
    const typesText = fs.existsSync(TYPES_OUT) ? fs.readFileSync(TYPES_OUT, 'utf8') : '';
    const fresh = generate() + '\n';
    if (typesText !== fresh) {
        errors++;
        console.log('ERRO types: tools/sdk/types/celer.d.ts esta com drift do manifest —');
        console.log('      rode `node tools/sdk/celer.js types` e commit junto com a mudanca da API');
    } else {
        console.log('types: celer.d.ts em sincronia com o manifest');
    }

    // 3) emulador: primitivas de desenho do manifest sem render
    const { RENDERED } = require('./lib/renderer.js');
    const manifest = buildManifest();
    const KNOWN_UNRENDERED = new Set(['drawJPG']);  // TJpgDec nao tem decoder no host (runtime avisa)
    const isDraw = (name) => /^(fill|draw|push|create|bind|use)[A-Z]/.test(name) ||
                          ['setTextColor', 'setTextSize', 'setTextDatum', 'textWidth', 'fontHeight', 'deleteSprite'].includes(name);
    const missing = [];
    for (const [objPath, obj] of Object.entries(manifest.objects)) {
        if (objPath !== 'System' && objPath !== 'System.gpio') continue;
        for (const f of obj.fns) {
            if (isDraw(f.name) && !RENDERED.includes(f.name) && !KNOWN_UNRENDERED.has(f.name)) {
                missing.push(objPath + '.' + f.name);
            }
        }
    }
    for (const n of missing) {
        console.log('aviso: ' + n + ' nao renderiza no emulador (wire do renderer sem a primitiva)');
    }

    // 4) drift das deps compartilhadas repo x hub (aviso — nao trava o
    // gate; `celerhub.py deps-status` sai 1 quando quiser travar)
    const dep = spawnSync('python3', [path.join(ROOT, 'tools', 'celerhub.py'), 'deps-status'],
                          { encoding: 'utf8', timeout: 90000 });
    if (dep.status === 1) {
        console.log('aviso: deps compartilhadas com drift repo x hub (publish-dep resolve):');
        for (const l of String(dep.stdout || '').trim().split('\n')) console.log('      ' + l);
    } else if (dep.status !== 0 || dep.error) {
        console.log('deps: hub inalcancavel — drift repo x hub nao checado '
                    + '(rode `python3 tools/celerhub.py deps-status`)');
    } else {
        console.log('deps: tools/sdk/engine em paridade com o hub');
    }

    process.exit(errors ? 1 : 0);
}

// ---------------------------------------------------------------- externos

function cmdPublish(args) {
    const r = spawnSync('python3', [path.join(ROOT, 'tools', 'celerhub.py'), 'publish', ...args],
                        { stdio: 'inherit' });
    process.exit(r.status == null ? 1 : r.status);
}

function cmdPublishDep(args) {
    const r = spawnSync('python3', [path.join(ROOT, 'tools', 'celerhub.py'), 'publish-dep', ...args],
                        { stdio: 'inherit' });
    process.exit(r.status == null ? 1 : r.status);
}

function cmdDev(args) {
    const r = spawnSync('python3', [path.join(ROOT, 'tools', 'celerctl.py'), 'dev', ...args],
                        { stdio: 'inherit' });
    process.exit(r.status == null ? 1 : r.status);
}

// ---------------------------------------------------------------- cli

function parseFlags(args) {
    const out = { _: [] };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = args[i + 1];
            if (next && !next.startsWith('--')) { out[key] = next; i++; }
            else out[key] = true;
        } else out._.push(a);
    }
    return out;
}

function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    switch (cmd) {
        case 'new': return cmdNew(rest);
        case 'deps': return cmdDeps(rest);
        case 'lint': return cmdLint(rest);
        case 'types': return cmdTypes(rest);
        case 'test': return cmdTest(rest);
        case 'emu': return cmdEmu(rest);
        case 'bench': return cmdBench(rest);
        case 'check': return cmdCheck();
        case 'publish': return cmdPublish(rest);
        case 'publish-dep': return cmdPublishDep(rest);
        case 'dev': return cmdDev(rest);
        default:
            usage();
            process.exit(cmd ? 2 : 0);
    }
}

if (require.main === module) main();
module.exports = { makeIconPng, main };
