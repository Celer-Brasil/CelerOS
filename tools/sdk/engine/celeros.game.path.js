// game.path.js — CelerGame PATH (dep "celeros.game.path"): caminho em
// grade para IA — A* com custo por celula, linha de visao (Bresenham),
// suavizacao do caminho e um seguidor que anda a entidade pelos pontos.
// Decora o core no require:
//
//   var E = require("celeros.game");
//   require("celeros.game.path");
//   var cam = E.path.find(cols, rows, c0, r0, c1, r1, function (c, r) {
//       return mapa[r][c] === '#' ? -1 : 1;      // custo; < 0 = parede
//   }, { diag: true });                          // [{c, r}, ...] ou null
//   // com o modulo tilemap: E.path.grid(mapa) da cols/rows/custo prontos
//   var g = E.path.grid(tm);
//   cam = E.path.find(g.cols, g.rows, c0, r0, c1, r1, g.cost);
//
// Orcamento: opts.max (default 2000 nos expandidos) — no ESP32 um A* de
// 30x30 sem teto pode comer o quadro inteiro; estourou = null (tente de
// novo no proximo quadro ou caia num passo guloso). Zero recursao; o heap
// binario e as tabelas sao arrays planos reaproveitados entre chamadas.
//
// 1.1.0: alvo BLOQUEADO (sem near) gastava o orcamento inteiro varrendo o
// mapa a cada quadro ate desistir — sai na hora com null; smooth cortava
// quina de parede (o Bresenham passa entre duas paredes em diagonal) e o
// inimigo atravessava o canto — agora usa a linha de visao estrita. Novos:
// E.path.flow (mapa de distancias com custo: N inimigos, 1 busca) e o
// seguidor com {loop} / {pingpong} (patrulha).
// 1.1.1: flow le o custo de cada celula uma vez (antes ate 3x por vizinho)
// e, com custo uniforme sem diagonal, roda BFS em vez do Dijkstra com heap.
// 1.1.2: follower com ponto NaN no caminho envenenava obj.x/y no 1o
// update (d NaN caia no ramo do passo fracionario) — ponto invalido e
// pulado, o corpo segue finito.

var E = require('celeros.game');

// tabelas reaproveitadas (crescem sob demanda; cada busca usa um "selo"
// novo em vez de zerar tudo)
var _g = [], _from = [], _seen = [], _closed = [], _stamp = 0;
var _heap = [], _hf = [];
var _cs = [];          // custos do flow (reaproveitado)
var _q = [];           // fila do BFS do flow uniforme

function heapPush(k, f) {
    var i = _heap.length;
    _heap.push(k);
    _hf.push(f);
    while (i > 0) {
        var p = (i - 1) >> 1;
        if (_hf[p] <= f) break;
        _heap[i] = _heap[p]; _hf[i] = _hf[p];
        i = p;
    }
    _heap[i] = k; _hf[i] = f;
}
function heapPop() {
    var top = _heap[0];
    var k = _heap.pop(), f = _hf.pop();
    var n = _heap.length;
    if (n) {
        var i = 0;
        for (;;) {
            var l = i * 2 + 1, r = l + 1, m = i;
            var mf = f;
            if (l < n && _hf[l] < mf) { m = l; mf = _hf[l]; }
            if (r < n && _hf[r] < mf) { m = r; mf = _hf[r]; }
            if (m === i) break;
            _heap[i] = _heap[m]; _hf[i] = _hf[m];
            i = m;
        }
        _heap[i] = k; _hf[i] = f;
    }
    return top;
}

var DX4 = [1, -1, 0, 0], DY4 = [0, 0, 1, -1];
var DX8 = [1, -1, 0, 0, 1, 1, -1, -1], DY8 = [0, 0, 1, -1, 1, -1, 1, -1];
var SQ2 = Math.SQRT2;

E.path = {
    version: '1.1.2',
    // nos expandidos na ultima busca (diagnostico/orcamento)
    expanded: 0,

    // A*: cost(c, r) -> custo de ENTRAR na celula (>= 1 recomendado; < 0
    // ou nao-numero = bloqueada). opts {diag (8 vizinhos; nunca corta
    // canto de parede), max (orcamento), near (sem caminho: devolve o
    // caminho ate a celula alcancada mais perto do alvo)}
    find: function (cols, rows, c0, r0, c1, r1, cost, opts) {
        opts = opts || {};
        var diag = !!opts.diag, max = opts.max || 2000;
        if (c0 < 0 || r0 < 0 || c0 >= cols || r0 >= rows) return null;
        if (c1 < 0 || r1 < 0 || c1 >= cols || r1 >= rows) return null;
        var start = r0 * cols + c0, goal = r1 * cols + c1;
        if (start === goal) return [{ c: c0, r: r0 }];
        // alvo dentro da parede: sem near nao ha o que buscar
        if (!opts.near && !(cost(c1, r1) >= 0)) { E.path.expanded = 0; return null; }
        _stamp++;
        if (_stamp > 1e9) {             // selo deu a volta: zera as tabelas
            _stamp = 1;
            _seen.length = 0;
            _closed.length = 0;
        }
        _heap.length = 0;
        _hf.length = 0;
        var dxs = diag ? DX8 : DX4, dys = diag ? DY8 : DY4, nd = dxs.length;
        function h(c, r) {
            var dx = c > c1 ? c - c1 : c1 - c, dy = r > r1 ? r - r1 : r1 - r;
            if (!diag) return dx + dy;
            return dx > dy ? dx + (SQ2 - 1) * dy : dy + (SQ2 - 1) * dx;
        }
        _g[start] = 0;
        _from[start] = -1;
        _seen[start] = _stamp;
        heapPush(start, h(c0, r0));
        var best = start, bestH = h(c0, r0), n = 0, found = false;
        while (_heap.length) {
            var k = heapPop();
            if (_closed[k] === _stamp) continue;
            _closed[k] = _stamp;
            if (k === goal) { found = true; break; }
            if (++n > max) break;
            var cc = k % cols, cr = (k - cc) / cols;
            for (var d = 0; d < nd; d++) {
                var nc = cc + dxs[d], nr = cr + dys[d];
                if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
                var nk = nr * cols + nc;
                if (_closed[nk] === _stamp) continue;
                var w = cost(nc, nr);
                if (!(w >= 0)) continue;
                if (d >= 4) {
                    // diagonal so com os dois lados livres (nao corta canto)
                    var wa = cost(nc, cr), wb = cost(cc, nr);
                    if (!(wa >= 0) || !(wb >= 0)) continue;
                    w *= SQ2;
                }
                var ng = _g[k] + w;
                if (_seen[nk] === _stamp && ng >= _g[nk]) continue;
                _seen[nk] = _stamp;
                _g[nk] = ng;
                _from[nk] = k;
                var hh = h(nc, nr);
                if (hh < bestH) { bestH = hh; best = nk; }
                heapPush(nk, ng + hh);
            }
        }
        E.path.expanded = n;
        var end = found ? goal : (opts.near ? best : -1);
        if (end < 0 || end === start) return found ? [{ c: c0, r: r0 }] : null;
        var out = [];
        for (var q = end; q !== -1; q = _from[q]) {
            var qc = q % cols;
            out.push({ c: qc, r: (q - qc) / cols });
        }
        out.reverse();
        return out;
    },

    // linha de visao entre celulas (Bresenham): true se nenhuma celula no
    // meio for bloqueada por blocked(c, r). strict: passo diagonal exige os
    // dois lados livres (o corpo nao espreme entre duas quinas)
    los: function (c0, r0, c1, r1, blocked, strict) {
        var dx = Math.abs(c1 - c0), dy = -Math.abs(r1 - r0);
        var sx = c0 < c1 ? 1 : -1, sy = r0 < r1 ? 1 : -1;
        var err = dx + dy, c = c0, r = r0;
        for (var guard = 0; guard < 4096; guard++) {
            if ((c !== c0 || r !== r0) && (c !== c1 || r !== r1) && blocked(c, r)) return false;
            if (c === c1 && r === r1) return true;
            var e2 = 2 * err;
            var mx = e2 >= dy, my = e2 <= dx;
            if (strict && mx && my && (blocked(c + sx, r) || blocked(c, r + sy))) return false;
            if (mx) { err += dy; c += sx; }
            if (my) { err += dx; r += sy; }
        }
        return true;
    },

    // corta os degraus: mantem so os pontos onde a linha de visao quebra
    // (inimigo anda em diagonal livre em vez de zigue-zague de grade)
    smooth: function (path, blocked) {
        if (!path || path.length < 3) return path;
        var out = [path[0]], a = 0;
        for (var i = 2; i < path.length; i++) {
            if (!E.path.los(path[a].c, path[a].r, path[i].c, path[i].r, blocked, true)) {
                out.push(path[i - 1]);
                a = i - 1;
            }
        }
        out.push(path[path.length - 1]);
        return out;
    },

    // mapa de distancias ate o alvo (Dijkstra com o MESMO cost do find):
    // uma busca serve a horda inteira — cada inimigo pergunta next(c, r).
    // Devolve {dist(c, r) (-1 inalcancavel), next(c, r) -> {c, r} | null}.
    // Recalcule quando o alvo troca de celula, nao por quadro
    flow: function (cols, rows, c1, r1, cost, opts) {
        opts = opts || {};
        var diag = !!opts.diag, n = cols * rows, i;
        var dist = [];
        for (i = 0; i < n; i++) dist.push(-1);
        var dxs = diag ? DX8 : DX4, dys = diag ? DY8 : DY4, nd = dxs.length;
        if (c1 < 0 || r1 < 0 || c1 >= cols || r1 >= rows) {
            return { dist: function () { return -1; }, next: function () { return null; } };
        }
        _heap.length = 0;
        _hf.length = 0;
        // custo de cada celula UMA vez (1.1.1): antes o laco chamava
        // cost() ate 3x por vizinho de cada no — milhares de chamadas JS
        // por busca numa sala 15x13 com diagonal. -1 = parede
        var cs = _cs, um = true;
        cs.length = n;
        for (i = 0; i < n; i++) {
            var cv = cost(i % cols, (i - i % cols) / cols);
            cs[i] = cv >= 0 ? cv : -1;
            if (cv >= 0 && cv !== 1) um = false;
        }
        var g0 = r1 * cols + c1;
        dist[g0] = 0;
        if (um && !diag) {
            // custo uniforme (1 ou parede — o caso de quase todo labirinto):
            // BFS com fila plana da a MESMA distancia que o Dijkstra sem o
            // heap (no 4848 o flow de 15x13 custava ~32 ms; o Detona faz 2
            // a cada 0,5 s e soluçava 100 ms quando caiam no mesmo quadro)
            var Q = _q, qh = 0;
            Q.length = 0;
            Q.push(g0);
            while (qh < Q.length) {
                var kq = Q[qh++], qc = kq % cols, qr = (kq - qc) / cols, dq = dist[kq] + 1;
                for (var dd = 0; dd < 4; dd++) {
                    var xc = qc + dxs[dd], xr = qr + dys[dd];
                    if (xc < 0 || xr < 0 || xc >= cols || xr >= rows) continue;
                    var xk = xr * cols + xc;
                    if (cs[xk] < 0 || dist[xk] >= 0) continue;
                    dist[xk] = dq;
                    Q.push(xk);
                }
            }
        } else heapPush(g0, 0);
        while (_heap.length) {
            var f = _hf[0], k = heapPop();
            if (f > dist[k]) continue;          // entrada velha do heap
            var cc = k % cols, cr = (k - cc) / cols;
            // custo de ENTRAR em k vindo do vizinho = cost(k): a celula do
            // alvo e a origem; anda-se "ao contrario" pagando o destino
            var wk = cs[k];
            if (wk < 0) wk = 1;
            for (var d = 0; d < nd; d++) {
                var nc = cc + dxs[d], nr = cr + dys[d];
                if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
                if (cs[nr * cols + nc] < 0) continue;
                var w = wk;
                if (d >= 4) {
                    if (cs[cr * cols + nc] < 0 || cs[nr * cols + cc] < 0) continue;
                    w *= SQ2;
                }
                var nk = nr * cols + nc, nv = dist[k] + w;
                if (dist[nk] >= 0 && nv >= dist[nk]) continue;
                dist[nk] = nv;
                heapPush(nk, nv);
            }
        }
        var out = { c: 0, r: 0 };
        function at(c, r) {
            if (c < 0 || r < 0 || c >= cols || r >= rows) return -1;
            return dist[r * cols + c];
        }
        return {
            dist: at,
            // vizinho com a menor distancia (objeto reaproveitado)
            next: function (c, r) {
                var d0 = at(c, r);
                if (d0 <= 0) return null;
                var best = -1, bc = 0, br = 0;
                for (var q = 0; q < nd; q++) {
                    var xc = c + dxs[q], xr = r + dys[q];
                    var dv = at(xc, xr);
                    if (dv < 0 || dv >= d0) continue;
                    if (q >= 4 && (at(xc, r) < 0 || at(c, xr) < 0)) continue;
                    if (best < 0 || dv < best) { best = dv; bc = xc; br = xr; }
                }
                if (best < 0) return null;
                out.c = bc; out.r = br;
                return out;
            }
        };
    },

    // adaptador do modulo tilemap: {cols, rows, cost, blocked} a partir do
    // solidAt/get do mapa (opts.cost(v, c, r) sobrepoe o custo 1/parede)
    grid: function (tm, opts) {
        opts = opts || {};
        var cost = function (c, r) {
            var v = tm.get ? tm.get(c, r) : undefined;
            if (opts.cost) return opts.cost(v, c, r);
            var p = tm.cellRect(c, r);
            return tm.solidAt(p.x + p.w / 2, p.y + p.h / 2) ? -1 : 1;
        };
        return {
            cols: tm.cols, rows: tm.rows, cost: cost,
            blocked: function (c, r) { return !(cost(c, r) >= 0); }
        };
    },

    // seguidor: anda obj ({x, y} em PIXELS) pelos pontos do caminho a speed
    // px/s. cell (px por celula) e ox/oy convertem celula -> centro em px.
    // f.update(dt) devolve true ao chegar no fim; f.done, f.i (ponto alvo).
    // Patrulha: {loop: true} volta ao 1o ponto; {pingpong: true} vai e volta
    // (nunca termina — f.laps conta as voltas)
    follower: function (obj, path, speed, o) {
        o = o || {};
        var cell = o.cell || 16, ox = o.ox || 0, oy = o.oy || 0;
        var f = { obj: obj, path: path || [], i: 0, speed: speed || 60, done: false,
                  laps: 0, dir: 1 };
        f.set = function (p) {
            f.path = p || []; f.i = 0; f.dir = 1; f.laps = 0;
            f.done = !f.path.length;
        };
        f.target = function () {
            var p = f.path[f.i];
            return p ? { x: ox + p.c * cell + cell / 2, y: oy + p.r * cell + cell / 2 } : null;
        };
        f.update = function (dt) {
            if (f.done) return true;
            var step = f.speed * dt, L = f.path.length, spins = 0;
            while (step > 0 && f.i >= 0 && f.i < L) {
                var p = f.path[f.i];
                var tx = ox + p.c * cell + cell / 2, ty = oy + p.r * cell + cell / 2;
                var dx = tx - obj.x, dy = ty - obj.y;
                var d = Math.sqrt(dx * dx + dy * dy);
                if (!(d >= 0)) {
                    // ponto com c/r NaN: d NaN entrava no else e
                    // envenenava obj.x/y para sempre — pula o ponto
                    f.i += f.dir;
                    if (++spins > L * 2 + 2) break;
                    continue;
                }
                if (d <= step) {
                    obj.x = tx; obj.y = ty;
                    step -= d;
                    f.i += f.dir;
                    if (o.pingpong && L > 1 && (f.i >= L || f.i < 0)) {
                        f.dir = -f.dir;
                        f.i += 2 * f.dir;
                        f.laps++;
                    } else if (o.loop && f.i >= L) {
                        f.i = 0;
                        f.laps++;
                    }
                    // caminho de 1 ponto em loop: nao gira em falso no quadro
                    if (++spins > L * 2 + 2) break;
                } else {
                    obj.x += dx / d * step;
                    obj.y += dy / d * step;
                    step = 0;
                }
            }
            if (f.i >= f.path.length || f.i < 0) f.done = true;
            return f.done;
        };
        f.set(f.path);
        return f;
    }
};

E._mods.push('path');

module.exports = E;
