'use strict';
// Worker do emulador ao vivo (`celer.js emu --serve`): roda o app no harness
// com o renderer e conversa com o processo principal (HTTP) por postMessage
// + SharedArrayBuffer:
//   - a cada `frameMs` de relogio VIRTUAL publica um PNG do framebuffer;
//   - o pacing segura o app no tempo de parede (velocidade ajustavel) com
//     Atomics.wait — o worker dorme de verdade e acorda no input;
//   - o toque do navegador entra por um ring buffer no SAB e e amostrado no
//     getTouch/getTouches, como um painel MULTITOUCH de verdade (estado por
//     dedo; down/move/up).
// O app roda ate o processo principal encerrar o worker (restart/hot reload)
// ou ate o proprio app sair/estourar.

const { parentPort, workerData } = require('worker_threads');
const { Renderer } = require('./renderer.js');
const { runAppFolder } = require('./runner.js');

const appDir = workerData.appDir;
const frameMs = Math.max(1, workerData.frameMs || 33);
const seed = workerData.seed;
const ctl = new Int32Array(workerData.ctl);   // [wake, paused, step, speed, clients, quit, pubMs, clock]
const ptr = new Int32Array(workerData.ptr);   // [head, ...] eventos [down,x,y,finger] no ring
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
// Estado POR dedo: o ring traz [down,x,y,finger]; cada dedo reporta a
// posicao MAIS NOVA da fila e, no up, o ponto final uma vez antes de sumir
// (mesma semantica de release do single-pointer de antes). O PRIMARIO
// (getTouch) e o menor slot ativo — a pagina atribui slots em ordem de
// pouso, entao "menor slot" aproxima "mais antigo".
let tail = 0;
const fingers = [];
for (let i = 0; i < 5; i++) fingers.push({ active: false, release: false, x: 0, y: 0 });

function readPtr() {
    const head = Atomics.load(ptr, 0);
    if (tail >= head) return null;
    if (head - tail > RING) tail = head - RING;   // cliente mandou rapido demais: descarta velhos
    const i = PTR_BASE + (tail % RING) * 4;
    const ev = { down: Atomics.load(ptr, i) ? 1 : 0,
                 x: Atomics.load(ptr, i + 1), y: Atomics.load(ptr, i + 2),
                 f: Atomics.load(ptr, i + 3) };
    tail++;
    return ev;
}

function drainPtr() {
    for (;;) {
        const ev = readPtr();
        if (!ev) return;
        const f = fingers[(ev.f >= 0 && ev.f < 5) ? ev.f : 0];
        if (ev.down) {
            f.active = true;
            f.release = false;
            f.x = ev.x;
            f.y = ev.y;
        } else if (f.active) {
            f.x = ev.x;   // posicao final: o app precisa ver onde o swipe parou
            f.y = ev.y;
            f.release = true;
        }
    }
}

// Estado inteiro do vidro por getTouches (primario primeiro); um up sai do
// estado no quadro seguinte ao ponto final.
function nextTouches() {
    drainPtr();
    const out = [];
    for (let i = 0; i < 5; i++) {
        if (!fingers[i].active) continue;
        out.push({ id: i, x: fingers[i].x, y: fingers[i].y, size: 0 });
        if (fingers[i].release) {
            fingers[i].active = false;
            fingers[i].release = false;
        }
    }
    return out;
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
    const origGetTouches = S.getTouches;
    // multitoque (API 43): o vidro inteiro por getTouches; getTouch segue o
    // primario (menor slot ativo). UM dos dois por loop — mesma regra do
    // device (cada chamada consome o quadro).
    S.getTouches = function () {
        origGetTouches();   // dispara timers (o live nao usa a fila do harness)
        return nextTouches();
    };
    S.getTouch = function () {
        origGetTouch();
        const ts = nextTouches();
        return ts.length ? { x: ts[0].x, y: ts[0].y, touched: 1 } : { x: 0, y: 0, touched: 0 };
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
