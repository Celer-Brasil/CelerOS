'use strict';
// Worker do emulador ao vivo (`celer.js emu --serve`): roda o app no harness
// com o renderer e conversa com o processo principal (HTTP) por postMessage
// + SharedArrayBuffer:
//   - a cada `frameMs` de relogio VIRTUAL publica um PNG do framebuffer;
//   - o pacing segura o app no tempo de parede (velocidade ajustavel) com
//     Atomics.wait — o worker dorme de verdade e acorda no input;
//   - o toque do navegador entra por um ring buffer no SAB e e amostrado no
//     getTouch, como um painel tocado de verdade (down/move/up).
// O app roda ate o processo principal encerrar o worker (restart/hot reload)
// ou ate o proprio app sair/estourar.

const { parentPort, workerData } = require('worker_threads');
const { Renderer } = require('./renderer.js');
const { runAppFolder } = require('./runner.js');

const appDir = workerData.appDir;
const frameMs = Math.max(1, workerData.frameMs || 33);
const seed = workerData.seed;
const ctl = new Int32Array(workerData.ctl);   // [wake, paused, step, speed, clients, quit, pubMs, clock]
const ptr = new Int32Array(workerData.ptr);   // [head, ...] eventos [down,x,y] no ring
const RING = 256, PTR_BASE = 8;

const renderer = new Renderer();
renderer.appDir = appDir;

function post(msg, transfer) {
    try { parentPort.postMessage(msg, transfer || undefined); } catch (e) { /* encerrando */ }
}

let lastLog = 0;
let lastPub = -Infinity;
let lastIdlePub = -Infinity;
function publish(env, ms, force) {
    if (!force && ms - lastPub < frameMs) return;
    lastPub = ms;
    Atomics.store(ctl, 6, ms);
    const log = env.__harness.log;
    if (log.length > lastLog) {
        const lines = log.slice(lastLog, lastLog + 200);
        lastLog = log.length;
        post({ type: 'log', lines: lines, ms: ms });
    }
    const clients = Atomics.load(ctl, 4);
    // sem aba aberta ainda vale atualizar o /frame.png (screenshot/estado) —
    // 1 encode por segundo, nao por quadro
    if (clients > 0 || force || ms - lastIdlePub >= 1000) {
        if (clients <= 0) lastIdlePub = ms;
        const png = renderer.png();
        if (png.length < 4 * 1024 * 1024) {
            const u8 = new Uint8Array(png);   // copia com ArrayBuffer proprio (transferivel)
            post({ type: 'frame', ms: ms, w: renderer.w, h: renderer.h, png: u8.buffer }, [u8.buffer]);
        }
    }
}

// ------------------------------------------------------------ entrada -----
let tail = 0, sawDown = false, needRelease = false;
let last = { x: 0, y: 0 };

function readPtr() {
    const head = Atomics.load(ptr, 0);
    if (tail >= head) return null;
    if (head - tail > RING) tail = head - RING;   // cliente mandou rapido demais: descarta velhos
    const i = PTR_BASE + (tail % RING) * 3;
    const down = Atomics.load(ptr, i);
    const x = Atomics.load(ptr, i + 1);
    const y = Atomics.load(ptr, i + 2);
    tail++;
    return { x: x, y: y, down: down ? 1 : 0 };
}

// Amostra o toque como o painel: um evento por getTouch; arrasto usa a
// posicao MAIS NOVA da fila (move intermediario nao engasga o app).
function nextTouch() {
    if (needRelease) {
        needRelease = false;
        sawDown = false;
        return { x: last.x, y: last.y, touched: 0 };
    }
    let ev = readPtr();
    if (!ev) return sawDown ? { x: last.x, y: last.y, touched: 1 } : null;
    let latest = ev;
    for (;;) {
        const n = readPtr();
        if (!n) break;
        latest = n;
    }
    last = { x: latest.x, y: latest.y };
    if (latest.down) {
        sawDown = true;
        return { x: last.x, y: last.y, touched: 1 };
    }
    // ultimo evento e o release: entrega a posicao final como "tocada" e
    // solta no proximo getTouch (o app precisa ver o ponto final do swipe)
    needRelease = true;
    return { x: last.x, y: last.y, touched: 1 };
}

// ------------------------------------------------------------- pacing -----
let lastClock = null, lastWall = 0, stepUntil = 0;

function pace(clock) {
    let blocking = false;
    for (;;) {
        if (Atomics.load(ctl, 5)) throw { harnessStop: true };
        const paused = !!Atomics.load(ctl, 1);
        if (paused) {
            const step = Atomics.load(ctl, 2);
            if (step > 0) {
                Atomics.store(ctl, 2, 0);
                stepUntil = clock + step;
            }
            if (!(stepUntil && clock < stepUntil)) {
                stepUntil = 0;
                if (!blocking) { blocking = true; lastClock = clock; lastWall = performance.now(); }
                Atomics.wait(ctl, 0, Atomics.load(ctl, 0), 50);
                continue;
            }
        } else stepUntil = 0;
        if (blocking) { blocking = false; lastClock = clock; lastWall = performance.now(); }
        if (lastClock === null) { lastClock = clock; lastWall = performance.now(); }
        const speed = (Atomics.load(ctl, 3) || 100) / 100;
        const due = lastWall + (clock - lastClock) / speed;
        const remain = due - performance.now();
        if (remain <= 0) { lastClock = clock; lastWall = performance.now(); return; }
        Atomics.wait(ctl, 0, Atomics.load(ctl, 0), Math.min(remain, 50));
    }
}

// --------------------------------------------------------------- wire -----
let envRef = null;
function liveWire(env) {
    envRef = env;
    const S = env.System;
    const origGetTouch = S.getTouch;
    S.getTouch = function () {
        origGetTouch();   // dispara timers (o live nao usa a fila do harness)
        const t = nextTouch();
        return t || { x: last.x, y: last.y, touched: 0 };
    };
    const origDelay = S.delay;
    S.delay = function (ms) {
        Atomics.store(ctl, 7, S.millis());   // relogio corrente p/ /state
        publish(env, S.millis(), false);
        pace(S.millis());
        return origDelay(ms);
    };
}

let result = null;
try {
    result = runAppFolder(appDir, {
        render: true,
        renderer: renderer,
        stopAtMs: 1e9,      // app de jogo roda "para sempre"; quem para e o servidor
        noAppWire: true,    // test.js de smoke nao entra no live (brigaria com o usuario)
        seed: seed,
        events: liveWire,
    });
} catch (e) {
    result = { err: e && (e.stack || String(e)), env: envRef, log: envRef ? envRef.__harness.log : [] };
}

if (result && result.env) {
    try { publish(result.env, result.env.System.millis(), true); } catch (e) {}
    post({ type: 'end', err: result.err || null, ms: result.env.System.millis(),
           log: (result.env.__harness.log || []).slice(lastLog) });
} else {
    post({ type: 'end', err: (result && result.err) || 'app sem env', ms: 0, log: [] });
}
