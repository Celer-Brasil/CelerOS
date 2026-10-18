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
// `swipe X0,Y0 X1,Y1 [PASSOS] [MS]` interpola PASSOS posicoes tocadas em MS
// (default 6/100). Comentarios com '#' e linhas vazias sao ignorados; erro
// de sintaxe aponta linha e coluna.

function parsePair(tok, where) {
    const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(String(tok || '').trim());
    if (!m) throw new Error(where + ': esperava X,Y (recebi "' + tok + '")');
    return { x: +m[1], y: +m[2] };
}

// Devolve [{ t, frame: {x, y, touched} }] ordenado por t.
function parseInputScript(text) {
    const out = [];
    const lines = String(text).split('\n');
    for (let ln = 0; ln < lines.length; ln++) {
        const raw = lines[ln].replace(/#.*$/, '').trim();
        if (!raw) continue;
        const where = 'linha ' + (ln + 1);
        const parts = raw.split(/\s+/);
        const t = Number(parts.shift());
        if (!isFinite(t) || t < 0) throw new Error(where + ': tempo em ms invalido');
        const cmd = (parts.shift() || '').toLowerCase();
        let x, y;
        if (cmd === 'tap') {
            const p = parsePair(parts[0], where);
            out.push({ t: t, frame: { x: p.x, y: p.y, touched: 1 } });
            out.push({ t: t, frame: { x: p.x, y: p.y, touched: 0 } });
        } else if (cmd === 'down' || cmd === 'move' || cmd === 'up') {
            if (parts.length >= 2 && !/,/.test(parts[0])) {
                x = +parts[0]; y = +parts[1];
                if (!isFinite(x) || !isFinite(y)) throw new Error(where + ': coordenadas invalidas');
            } else {
                const p = parsePair(parts[0], where);
                x = p.x; y = p.y;
            }
            out.push({ t: t, frame: { x: x, y: y, touched: cmd === 'up' ? 0 : 1 } });
        } else if (cmd === 'swipe') {
            const a = parsePair(parts[0], where), b = parsePair(parts[1], where);
            const steps = parts[2] != null ? Math.max(1, parseInt(parts[2], 10) || 0) : 6;
            const ms = parts[3] != null ? Math.max(1, parseInt(parts[3], 10) || 0) : 100;
            for (let i = 0; i <= steps; i++) {
                const tt = t + Math.round(ms * i / steps);
                out.push({ t: tt, frame: { x: a.x + (b.x - a.x) * i / steps,
                                           y: a.y + (b.y - a.y) * i / steps, touched: 1 } });
            }
            out.push({ t: t + ms + 16, frame: { x: b.x, y: b.y, touched: 0 } });
        } else {
            throw new Error(where + ': acao desconhecida "' + cmd + '" (tap/down/move/up/swipe)');
        }
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
}

// Wire do harness: entrega cada frame na primeira chamada de delay com o
// relogio virtual >= t (mesmo modelo de amostragem do toque no device).
function wireInput(env, script) {
    const q = script.slice();
    const orig = env.System.delay;
    const base = env.System.millis();
    env.System.delay = function (ms) {
        const now = env.System.millis() - base;
        while (q.length && now >= q[0].t) {
            const f = q.shift().frame;
            env.__harness.pushTouch([{ x: f.x, y: f.y, touched: f.touched }]);
        }
        return orig(ms);
    };
}

module.exports = { parseInputScript, wireInput };
