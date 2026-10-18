'use strict';
// Runner do SDK: executa uma PASTA de app no harness do repo (makeEnv/runApp,
// test/js_harness) com opcional renderer headless (snapshot PNG) e wire de
// teste proprio do app (PASTA/test.js exportando wire(env)).

const fs = require('fs');
const path = require('path');
const harness = require('../../../test/js_harness/run.js');
const { Renderer } = require('./renderer.js');

const ROOT = path.resolve(__dirname, '../../..');

// Carrega o wire de teste do app: PASTA/test.js (module.exports.wire(env) ou
// module.exports = function(env)). Opcional e nao obrigatorio.
function loadAppWire(appDir) {
    const p = path.join(appDir, 'test.js');
    if (!fs.existsSync(p)) return null;
    const m = require(p);
    const fn = typeof m === 'function' ? m : m.wire;
    if (typeof fn !== 'function') throw new Error(p + ': exporte `wire(env)`');
    return fn;
}

// Roda o app: opts { render, renderer, stopAtMs, frames, events, seed, noAppWire }.
//   render    -> instala o renderer e devolve `renderer` no resultado
//   renderer  -> usa um Renderer ja criado (o modo --serve precisa da
//                referencia viva para publicar quadros)
//   stopAtMs  -> para o app quando o relogio virtual passa disso (apps sao
//                loops infinitos; default 1200ms quando render, senao o
//                LIMIT do harness manda)
//   frames    -> [ms...]: snapshot do framebuffer ao cruzar cada marco do
//                RELOGIO DO APP (0 = estado inicial); o app para apos o
//                ultimo. Resultado ganha r.frames = [{ms, fb, png}]
//   events    -> wire extra (CLI --events), roda apos o renderer
//   seed      -> Math.random deterministico (mesma rodada = mesma partida)
//   noAppWire -> nao carrega o test.js do app (modo live: o smoke brigaria
//                com o toque do usuario)
function runAppFolder(appDir, opts = {}) {
    const dir = path.resolve(appDir);
    let entry = 'main.js';
    const manifest = path.join(dir, 'app.json');
    if (fs.existsSync(manifest)) {
        try {
            const j = JSON.parse(fs.readFileSync(manifest, 'utf8'));
            if (j.main) entry = j.main;
        } catch (e) { /* app.json invalido: o lint acusa; aqui segue default */ }
    }
    const mainAbs = path.join(dir, entry);
    if (!fs.existsSync(mainAbs)) throw new Error('entrypoint nao encontrado: ' + mainAbs);

    const renderer = opts.renderer || (opts.render ? new Renderer() : null);
    if (renderer) renderer.appDir = dir;   // drawPNG resolve /local|/sd/apps a partir daqui
    const frames = Array.isArray(opts.frames) && opts.frames.length
        ? opts.frames.map(Number).sort((a, b) => a - b) : null;
    // clock do harness comeca em 1000: marcos do app = base + ms pedido.
    // stopAtMs entra como RELATIVO (ms de app rodado): era tratado como
    // absoluto e qualquer --ms <= 1000 derrubava o app no primeiro quadro —
    // o teste "passava limpo" sem ter rodado nada (mascarando regressao)
    const FR_BASE = 1000;
    const stopAtMs = frames ? FR_BASE + frames[frames.length - 1]
        : (opts.stopAtMs != null ? FR_BASE + opts.stopAtMs : (opts.render ? 1200 : null));

    const wires = [];
    if (opts.seed != null) {
        // mulberry32: Math.random deterministico para reproduzir partidas
        // (apps de jogo usam Math.random para nascer inimigos/pista)
        wires.push(() => {
            let a = (opts.seed >>> 0) || 1;
            Math.random = function () {
                a = (a + 0x6D2B79F5) >>> 0;
                let t = a;
                t = Math.imul(t ^ (t >>> 15), t | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        });
    }
    if (renderer) wires.push((env) => renderer.wire(env));
    if (stopAtMs != null) {
        wires.push((env) => {
            const orig = env.System.delay;
            let idx = frames ? 0 : -1;
            env.System.delay = function (ms) {
                // snapshot dos marcos vencidos ANTES de avancar o relogio
                if (frames && renderer && env.__framesOut) {
                    while (idx < frames.length && env.System.millis() >= FR_BASE + frames[idx]) {
                        env.__framesOut.push({ ms: frames[idx], fb: renderer.fb.slice(),
                                               png: opts.framesPng === false ? null : renderer.png() });
                        idx++;
                    }
                }
                if (env.System.millis() > stopAtMs) throw { harnessStop: true };
                return orig(ms);
            };
        });
    }
    if (opts.events) wires.push(opts.events);
    if (opts.profile) {
        // bench: ms REAIS por quadro — o delta entre entradas de
        // System.delay engloba update+draw do app (o harness nao dorme, o
        // relogio e virtual; sobra so o trabalho de verdade). Nasceu do
        // comparativo do Supernova 2.3 feito em script avulso: virou flag.
        wires.push((env) => {
            const samples = [];
            let last = null;
            const orig = env.System.delay;
            env.System.delay = function (ms) {
                const now = process.hrtime.bigint();
                if (last !== null) samples.push(Number(now - last) / 1e6);
                last = now;
                return orig(ms);
            };
            env.__profileSamples = samples;
        });
    }
    const appWire = opts.noAppWire ? null : loadAppWire(dir);
    if (appWire) wires.push(appWire);

    // runApp espera caminho relativo ao ROOT do repo; path.relative resolve
    // pastas fora do repo com "../.." — mesma coisa para ele.
    const r = harness.runApp(path.relative(ROOT, mainAbs), (env) => {
        env.__framesOut = frames ? [] : null;
        for (const w of wires) w(env);
    });
    r.renderer = renderer;
    r.frames = (r.env && r.env.__framesOut) || [];
    if (opts.profile) {
        const s = (r.env && r.env.__profileSamples || []).slice().sort((a, b) => a - b);
        const pick = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
        r.profile = {
            frames: s.length,
            avgMs: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0,
            p50Ms: pick(0.50), p95Ms: pick(0.95), maxMs: s.length ? s[s.length - 1] : 0
        };
    }
    return r;
}

module.exports = { runAppFolder, loadAppWire };
