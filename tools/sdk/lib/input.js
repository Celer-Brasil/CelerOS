'use strict';
// Script de entrada do emulador (`celer.js emu --input ARQ`): uma acao por
// linha, tempo em ms de app. Complementa o test.js (que e codigo) com algo
// que se escreve na hora para reproduzir um toque observado no live:
//
//   # reproduz o "tap em JOGAR e arrasta pro lado"
//   0    tap 120,200
//   600  swipe 120,240 120,80 6
//   900  down 120,160
//   980  move 150,180
//   1100 up 150,180
//
// `swipe X0,Y0 X1,Y1 [PASSOS] [MS] [F]` interpola PASSOS posicoes tocadas em
// MS (default 6/100). Todo comando aceita um DEDO opcional no fim (0..4):
//   0    down 120,160 0
//   0    down 180,160 1
//   200  move 90,160 0
//   200  move 210,160 1
//   400  up 0
//   400  up 1
// Dedo explicito em QUALQUER linha vira o script multi-dedo: cada quadro sai
// como o estado COMPLETO do vidro {touches:[{id,x,y,size}...]} (API 43,
// consumido por System.getTouches). Sem dedo nenhum, o formato legado de
// 1 ponto {x,y,touched} se mantem (saida identica a de antes).
// Comentarios com '#' e linhas vazias sao ignorados; erro de sintaxe aponta
// linha e coluna.

function parsePair(tok, where) {
    const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(String(tok || '').trim());
    if (!m) throw new Error(where + ': esperava X,Y (recebi "' + tok + '")');
    return { x: +m[1], y: +m[2] };
}

function parseXY(parts, where) {
    if (/,/.test(parts[0])) {
        const p = parsePair(parts.shift(), where);
        return { x: p.x, y: p.y };
    }
    const x = +parts.shift(), y = +parts.shift();
    if (!isFinite(x) || !isFinite(y)) throw new Error(where + ': coordenadas invalidas');
    return { x: x, y: y };
}

// Dedo opcional no fim (0..4): token inteiro solto. No swipe so vale na 5a
// posicao (depois de PASSOS e MS), entao `swipe a b 6 1` continua sendo MS=1.
function parseFinger(parts, where) {
    if (!parts.length || !/^\d+$/.test(parts[parts.length - 1])) return undefined;
    const f = parseInt(parts.pop(), 10);
    if (f > 4) throw new Error(where + ': dedo invalido (0..4, recebi ' + f + ')');
    return f;
}

// Devolve [{ t, frame }] ordenado por t; frame = {x,y,touched} (legado) ou
// {touches:[{id,x,y,size}...]} (multi).
function parseInputScript(text) {
    const evs = [];
    const lines = String(text).split('\n');
    let multi = false;
    for (let ln = 0; ln < lines.length; ln++) {
        const raw = lines[ln].replace(/#.*$/, '').trim();
        if (!raw) continue;
        const where = 'linha ' + (ln + 1);
        const parts = raw.split(/\s+/);
        const t = Number(parts.shift());
        if (!isFinite(t) || t < 0) throw new Error(where + ': tempo em ms invalido');
        const cmd = (parts.shift() || '').toLowerCase();
        const ev = { t: t, cmd: cmd };
        if (cmd === 'tap') {
            const p = parseXY(parts, where);
            ev.x = p.x; ev.y = p.y;
            ev.f = parseFinger(parts, where);
        } else if (cmd === 'down' || cmd === 'move' || cmd === 'up') {
            if (cmd === 'up' && parts.length === 1 && /^\d$/.test(parts[0])) {
                ev.f = parseFinger(parts, where);   // "up 1": solta o dedo 1
            } else {
                if (parts.length) {
                    const p = parseXY(parts, where);
                    ev.x = p.x; ev.y = p.y;
                }
                ev.f = parseFinger(parts, where);
                if (cmd === 'up' && ev.x === undefined && ev.f === undefined) {
                    throw new Error(where + ': up espera X,Y (ou o dedo: "up 1")');
                }
            }
        } else if (cmd === 'swipe') {
            if (parts.length < 2) throw new Error(where + ': swipe espera X0,Y0 X1,Y1');
            const a = parsePair(parts.shift(), where), b = parsePair(parts.shift(), where);
            ev.x0 = a.x; ev.y0 = a.y; ev.x1 = b.x; ev.y1 = b.y;
            ev.steps = parts.length ? Math.max(1, parseInt(parts.shift(), 10) || 0) : 6;
            ev.ms = parts.length ? Math.max(1, parseInt(parts.shift(), 10) || 0) : 100;
            ev.f = parseFinger(parts, where);
        } else {
            throw new Error(where + ': acao desconhecida "' + cmd + '" (tap/down/move/up/swipe)');
        }
        if (parts.length) throw new Error(where + ': tokens sobrando "' + parts.join(' ') + '"');
        if (ev.f !== undefined) multi = true;
        evs.push(ev);
    }
    const out = [];
    const down = new Map();  // dedo -> ultima posicao (multi)
    function snap(t) {
        const touches = [];
        const fs = Array.from(down.keys()).sort(function (a, b) { return a - b; });
        for (let i = 0; i < fs.length; i++) {
            const p = down.get(fs[i]);
            touches.push({ id: fs[i], x: p.x, y: p.y, size: 0 });
        }
        return { t: t, frame: { touches: touches } };
    }
    for (const ev of evs) {
        if (!multi) {
            // caminho legado: saida identica a de antes (1 ponto por quadro)
            if (ev.cmd === 'tap') {
                out.push({ t: ev.t, frame: { x: ev.x, y: ev.y, touched: 1 } });
                out.push({ t: ev.t, frame: { x: ev.x, y: ev.y, touched: 0 } });
            } else if (ev.cmd === 'swipe') {
                for (let i = 0; i <= ev.steps; i++) {
                    const tt = ev.t + Math.round(ev.ms * i / ev.steps);
                    out.push({ t: tt, frame: { x: ev.x0 + (ev.x1 - ev.x0) * i / ev.steps,
                                               y: ev.y0 + (ev.y1 - ev.y0) * i / ev.steps, touched: 1 } });
                }
                out.push({ t: ev.t + ev.ms + 16, frame: { x: ev.x1, y: ev.y1, touched: 0 } });
            } else {
                out.push({ t: ev.t, frame: { x: ev.x, y: ev.y, touched: ev.cmd === 'up' ? 0 : 1 } });
            }
            continue;
        }
        // multi-dedo: estado por dedo, quadro = snapshot completo do vidro
        const f = ev.f === undefined ? 0 : ev.f;
        if (ev.cmd === 'tap') {
            down.set(f, { x: ev.x, y: ev.y });
            out.push(snap(ev.t));
            down.delete(f);
            out.push(snap(ev.t));
        } else if (ev.cmd === 'up') {
            down.delete(f);
            out.push(snap(ev.t));
        } else if (ev.cmd === 'swipe') {
            for (let i = 0; i <= ev.steps; i++) {
                down.set(f, { x: ev.x0 + (ev.x1 - ev.x0) * i / ev.steps,
                              y: ev.y0 + (ev.y1 - ev.y0) * i / ev.steps });
                out.push(snap(ev.t + Math.round(ev.ms * i / ev.steps)));
            }
            down.delete(f);
            out.push(snap(ev.t + ev.ms + 16));
        } else {  // down/move
            down.set(f, { x: ev.x, y: ev.y });
            out.push(snap(ev.t));
        }
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
}

// Wire do harness: entrega cada frame na primeira chamada de delay com o
// relogio virtual >= t (mesmo modelo de amostragem do toque no device). O
// harness aceita os dois formatos de quadro (normFrame).
function wireInput(env, script) {
    const q = script.slice();
    const orig = env.System.delay;
    const base = env.System.millis();
    env.System.delay = function (ms) {
        const now = env.System.millis() - base;
        while (q.length && now >= q[0].t) {
            env.__harness.pushTouch([q.shift().frame]);
        }
        return orig(ms);
    };
}

module.exports = { parseInputScript, wireInput };
