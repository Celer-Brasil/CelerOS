// game.gen.js — CelerGame GEN (dep "celeros.game.gen"): geracao procedural
// de fases — masmorra de salas + corredores, caverna por automato celular,
// labirinto perfeito e espalhar itens. Sai uma grade de CARACTERES que
// vai direto no E.level.parse (gen.lines) ou no E.tilemap. Decora o core:
//
//   var E = require("celeros.game");
//   require("celeros.game.gen");
//   var rnd = E.rng(fase * 7919);                  // mesma semente = mesma fase
//   var d = E.gen.rooms(40, 30, { rnd: rnd, rooms: 9 });
//   E.gen.scatter(d.grid, "o", 12, { rnd: rnd });  // moedas no chao
//   d.grid[d.rooms[0].cy][d.rooms[0].cx] = "@";    // heroi na 1a sala
//   var lv = E.level.parse(E.gen.lines(d.grid), { legend: ..., cell: 16 });
//
// Tudo iterativo (sem recursao: a pilha do Duktape e curta) e deterministico
// dado o rnd. Custo: gere na entrada da fase, nunca por quadro — uma
// caverna 40x30 com 4 passos sao ~5k celulas x 9 leituras.
//
// 1.0.1: rooms com o.min > o.max (opts trocadas) sorteava lado 0/negativo,
// o x passava da borda e o grid saia com linhas mais compridas que cols.

var E = require('celeros.game');

function R(o) { return (o && o.rnd) || Math.random; }
function ri(rnd, a, b) { return a + Math.floor(rnd() * (b - a + 1)); }

E.gen = {
    version: '1.0.1',

    // grade rows x cols cheia de ch (array de arrays de 1 caractere)
    grid: function (cols, rows, ch) {
        var g = [];
        for (var r = 0; r < rows; r++) {
            var line = [];
            for (var c = 0; c < cols; c++) line.push(ch);
            g.push(line);
        }
        return g;
    },

    // grade -> linhas de texto (o formato do E.level.parse)
    lines: function (grid) {
        var out = [];
        for (var r = 0; r < grid.length; r++) out.push(grid[r].join(''));
        return out;
    },

    // masmorra: ate o.rooms salas retangulares sem sobrepor (min..max de
    // lado, 1 celula de parede entre elas) ligadas em corrente por
    // corredores em L (cada sala com a seguinte, em ordem de x — tudo
    // alcancavel). o {rnd, rooms (8), min (4), max (9), wall '#', floor '.',
    // tries (rooms*12)}. Devolve {grid, rooms: [{x, y, w, h, cx, cy}]}
    rooms: function (cols, rows, o) {
        o = o || {};
        var rnd = R(o), wall = o.wall || '#', floor = o.floor || '.';
        var want = o.rooms || 8, mn = o.min || 4, mx = o.max || 9;
        // min > max (opts trocadas) nao pode virar sala de lado 0/negativo:
        // o x sorteado passava da borda e a grade saia com linhas irregulares
        if (mx < mn) mx = mn;
        if (mn < 1) mn = 1;
        var g = E.gen.grid(cols, rows, wall);
        var rooms = [], tries = o.tries || want * 12;
        for (var t = 0; t < tries && rooms.length < want; t++) {
            var w = ri(rnd, mn, mx), h = ri(rnd, mn, mx);
            if (w > cols - 2 || h > rows - 2) continue;
            var x = ri(rnd, 1, cols - w - 1), y = ri(rnd, 1, rows - h - 1);
            var ok = true;
            for (var k = 0; k < rooms.length && ok; k++) {
                var q = rooms[k];
                if (x - 1 < q.x + q.w && x + w + 1 > q.x && y - 1 < q.y + q.h && y + h + 1 > q.y) ok = false;
            }
            if (!ok) continue;
            rooms.push({ x: x, y: y, w: w, h: h,
                         cx: x + Math.floor(w / 2), cy: y + Math.floor(h / 2) });
        }
        rooms.sort(function (a, b) { return a.cx - b.cx || a.cy - b.cy; });
        var i, r, c;
        for (i = 0; i < rooms.length; i++) {
            var rm = rooms[i];
            for (r = rm.y; r < rm.y + rm.h; r++) for (c = rm.x; c < rm.x + rm.w; c++) g[r][c] = floor;
        }
        for (i = 1; i < rooms.length; i++) {
            var a = rooms[i - 1], b = rooms[i];
            // L: horizontal depois vertical (ou o contrario, sorteado)
            if (rnd() < 0.5) { E.gen._hall(g, a.cx, b.cx, a.cy, true, floor); E.gen._hall(g, a.cy, b.cy, b.cx, false, floor); }
            else { E.gen._hall(g, a.cy, b.cy, a.cx, false, floor); E.gen._hall(g, a.cx, b.cx, b.cy, true, floor); }
        }
        return { grid: g, rooms: rooms };
    },
    _hall: function (g, from, to, fixed, horiz, floor) {
        var s = from < to ? 1 : -1, n = Math.abs(to - from);
        for (var k = 0, v = from; k <= n; k++, v += s) {
            if (horiz) g[fixed][v] = floor; else g[v][fixed] = floor;
        }
    },

    // caverna: ruido aleatorio (o.fill = chance de parede, 0.45) suavizado
    // por o.steps (4) passos de automato (parede se >= 5 vizinhos-parede);
    // borda sempre parede; o.keep (default true) enche de parede tudo que
    // nao e a MAIOR regiao livre (sem bolsoes isolados). Devolve {grid, open}
    cave: function (cols, rows, o) {
        o = o || {};
        var rnd = R(o), wall = o.wall || '#', floor = o.floor || '.';
        var fill = o.fill === undefined ? 0.45 : o.fill, steps = o.steps === undefined ? 4 : o.steps;
        var g = E.gen.grid(cols, rows, floor), r, c;
        for (r = 0; r < rows; r++) {
            for (c = 0; c < cols; c++) {
                var edge = r === 0 || c === 0 || r === rows - 1 || c === cols - 1;
                g[r][c] = edge || rnd() < fill ? wall : floor;
            }
        }
        for (var s = 0; s < steps; s++) {
            var nx = E.gen.grid(cols, rows, wall);
            for (r = 1; r < rows - 1; r++) {
                for (c = 1; c < cols - 1; c++) {
                    var n = 0;
                    for (var dr = -1; dr <= 1; dr++) {
                        for (var dc = -1; dc <= 1; dc++) {
                            if ((dr || dc) && g[r + dr][c + dc] === wall) n++;
                        }
                    }
                    nx[r][c] = n >= 5 ? wall : (n <= 3 ? floor : g[r][c]);
                }
            }
            g = nx;
        }
        var open = 0;
        if (o.keep !== false) open = E.gen.keepLargest(g, function (ch) { return ch === floor; }, wall);
        else for (r = 0; r < rows; r++) for (c = 0; c < cols; c++) if (g[r][c] === floor) open++;
        return { grid: g, open: open };
    },

    // so a MAIOR regiao 4-conexa onde pass(ch) fica; o resto vira fillCh.
    // Devolve o tamanho da regiao mantida
    keepLargest: function (g, pass, fillCh) {
        var rows = g.length, cols = rows ? g[0].length : 0;
        var lab = [], i, r, c;
        for (i = 0; i < rows * cols; i++) lab.push(0);
        var best = 0, bestN = 0, cur = 0, q = [];
        for (r = 0; r < rows; r++) {
            for (c = 0; c < cols; c++) {
                var k = r * cols + c;
                if (lab[k] || !pass(g[r][c])) continue;
                cur++;
                var n = 0, head = 0;
                q.length = 0;
                q.push(k);
                lab[k] = cur;
                while (head < q.length) {
                    var at = q[head++], ac = at % cols, ar = (at - ac) / cols;
                    n++;
                    if (ac + 1 < cols && !lab[at + 1] && pass(g[ar][ac + 1])) { lab[at + 1] = cur; q.push(at + 1); }
                    if (ac > 0 && !lab[at - 1] && pass(g[ar][ac - 1])) { lab[at - 1] = cur; q.push(at - 1); }
                    if (ar + 1 < rows && !lab[at + cols] && pass(g[ar + 1][ac])) { lab[at + cols] = cur; q.push(at + cols); }
                    if (ar > 0 && !lab[at - cols] && pass(g[ar - 1][ac])) { lab[at - cols] = cur; q.push(at - cols); }
                }
                if (n > bestN) { bestN = n; best = cur; }
            }
        }
        for (r = 0; r < rows; r++) {
            for (c = 0; c < cols; c++) {
                var kk = r * cols + c;
                if (lab[kk] && lab[kk] !== best) g[r][c] = fillCh;
            }
        }
        return bestN;
    },

    // labirinto perfeito (um caminho so entre 2 celulas) por backtracking
    // ITERATIVO: corredores nas celulas impares — cols/rows pares crescem
    // 1 para fechar a borda. Devolve {grid, cols, rows}
    maze: function (cols, rows, o) {
        o = o || {};
        var rnd = R(o), wall = o.wall || '#', floor = o.floor || '.';
        if (cols % 2 === 0) cols++;
        if (rows % 2 === 0) rows++;
        var g = E.gen.grid(cols, rows, wall);
        var cw = (cols - 1) / 2, ch = (rows - 1) / 2;
        if (cw < 1 || ch < 1) return { grid: g, cols: cols, rows: rows };
        var seen = [], i;
        for (i = 0; i < cw * ch; i++) seen.push(false);
        var stack = [0];
        seen[0] = true;
        g[1][1] = floor;
        var D = [[1, 0], [-1, 0], [0, 1], [0, -1]], opts = [];
        while (stack.length) {
            var top = stack[stack.length - 1], tc = top % cw, tr = (top - tc) / cw;
            opts.length = 0;
            for (var d = 0; d < 4; d++) {
                var nc = tc + D[d][0], nr = tr + D[d][1];
                if (nc < 0 || nr < 0 || nc >= cw || nr >= ch || seen[nr * cw + nc]) continue;
                opts.push(d);
            }
            if (!opts.length) { stack.pop(); continue; }
            var pick = opts[Math.floor(rnd() * opts.length)];
            var xc = tc + D[pick][0], xr = tr + D[pick][1];
            seen[xr * cw + xc] = true;
            g[tr * 2 + 1 + D[pick][1]][tc * 2 + 1 + D[pick][0]] = floor;
            g[xr * 2 + 1][xc * 2 + 1] = floor;
            stack.push(xr * cw + xc);
        }
        // braid: o.loops (0..1) abre paredes extras (labirinto com atalhos)
        if (o.loops > 0) {
            for (var r = 1; r < rows - 1; r++) {
                for (var c = 1; c < cols - 1; c++) {
                    if (g[r][c] !== wall || (r % 2) === (c % 2)) continue;
                    if (rnd() < o.loops) g[r][c] = floor;
                }
            }
        }
        return { grid: g, cols: cols, rows: rows };
    },

    // coloca n vezes ch em celulas sorteadas onde ha o.on (default '.'),
    // com o.minDist (Chebyshev) entre elas. Devolve as [{c, r}] postas
    // (menos que n se nao couber)
    scatter: function (g, ch, n, o) {
        o = o || {};
        var rnd = R(o), on = o.on === undefined ? '.' : o.on, md = o.minDist || 0;
        var rows = g.length, cols = rows ? g[0].length : 0;
        var free = [], r, c;
        for (r = 0; r < rows; r++) for (c = 0; c < cols; c++) if (g[r][c] === on) free.push(r * cols + c);
        E.m.shuffle(free, rnd);
        var out = [];
        for (var i = 0; i < free.length && out.length < n; i++) {
            var fc = free[i] % cols, fr = (free[i] - fc) / cols, ok = true;
            for (var k = 0; k < out.length && md > 0; k++) {
                if (Math.abs(out[k].c - fc) < md && Math.abs(out[k].r - fr) < md) { ok = false; break; }
            }
            if (!ok) continue;
            g[fr][fc] = ch;
            out.push({ c: fc, r: fr });
        }
        return out;
    },

    // celulas de g com o caractere ch: [{c, r}]
    findAll: function (g, ch) {
        var out = [];
        for (var r = 0; r < g.length; r++) {
            for (var c = 0; c < g[r].length; c++) if (g[r][c] === ch) out.push({ c: c, r: r });
        }
        return out;
    }
};

E._mods.push('gen');

module.exports = E;
