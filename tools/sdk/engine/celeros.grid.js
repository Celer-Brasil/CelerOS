// celeros.grid — utilidades de jogos de GRADE (bomberman, sokoban, snake,
// roguelike de grid). Dep compartilhada (API 30): "celeros.grid": "^1.0.0"
// no app.json. Mat pura sobre grid de ARRAYS (mute com grid[r][c] = x);
// convencao de caracteres: '#' parede fixa, '%' destrutivel, '.' livre —
// mas quem manda e o seu passavel()/solido().
//
//   var GRID = require("celeros.grid");
//   var arena = GRID.classica(15, 13, GRID.rng(101), { dens: 0.55 });
//   // arena.grid + arena.macios[{c,r}]

// 1.1.1: flood com a origem fora da grade derrubava o app (ok[sr][sc] de
// linha inexistente) — devolve conjunto vazio.

var GRID = { version: '1.1.1' };

// xorshift32 — mesmo esquema do E.rng/celeros.physics; modulo independente
GRID.rng = function (seed) {
    var s = seed >>> 0;
    if (!s) s = 0x9e3779b9;
    return function () {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
};

// grade vazia preenchida com ch
GRID.nova = function (cols, rows, ch) {
    var g = [];
    for (var r = 0; r < rows; r++) {
        var linha = [];
        for (var c = 0; c < cols; c++) linha.push(ch);
        g.push(linha);
    }
    return g;
};

// arena CLASSICA de bomberman: borda '#' + pilares nas intersecoes pares,
// destrutiveis '%' por densidade, canto de spawn respirando. opts:
//   dens     probabilidade de macio na celula livre (default 0.55)
//   protege  [[c,r], ...] celulas que NUNCA recebem macio (spawn + saida
//            de corrida); vizinhos imediatos tambem ficam livres quando
//            opts.respira (default true)
// devolve { grid, macios } — macios e a lista das celulas '%'.
GRID.classica = function (cols, rows, rng, opts) {
    opts = opts || {};
    var dens = opts.dens === undefined ? 0.55 : opts.dens;
    var protege = opts.protege || [[1, 1]];
    var respira = opts.respira !== false;
    var g = GRID.nova(cols, rows, '.');
    var macios = [];
    var protegidas = {};
    for (var p = 0; p < protege.length; p++) {
        var pc = protege[p][0], pr = protege[p][1];
        protegidas[pc + ',' + pr] = 1;
        if (respira) {
            protegidas[(pc + 1) + ',' + pr] = 1;
            protegidas[pc + ',' + (pr + 1)] = 1;
        }
    }
    for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
            if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) g[r][c] = '#';
            else if (r % 2 === 0 && c % 2 === 0) g[r][c] = '#';
            else if (!protegidas[c + ',' + r] && rng() < dens) {
                g[r][c] = '%';
                macios.push({ c: c, r: r });
            }
        }
    }
    return { grid: g, macios: macios };
};

// flood(grid, sc, sr, passavel) — conjunto alcancavel a pe de (sc,sr):
// passavel(ch) decide o que atravessa. Devolve {ok: matriz bool,
// quantos: n} (aloca 1 matriz por chamada — chame quando o labirinto
// muda, nao por frame; para perseguicao por frame use GRID.flow).
GRID.flood = function (grid, sc, sr, passavel) {
    var rows = grid.length, cols = rows ? grid[0].length : 0;
    var livre = function (c, r) {
        if (r < 0 || r >= rows || c < 0 || c >= cols) return false;
        return passavel(grid[r][c]);
    };
    var ok = GRID.nova(cols, rows, 0);
    if (sr < 0 || sr >= rows || sc < 0 || sc >= cols) return { ok: ok, quantos: 0 };
    var fila = [sr * cols + sc];
    ok[sr][sc] = 1;
    var quantos = 1;
    var head = 0;
    while (head < fila.length) {
        var at = fila[head++];
        var r = Math.floor(at / cols), c = at % cols;
        var viz = [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]];
        for (var v = 0; v < 4; v++) {
            var nc = viz[v][0], nr = viz[v][1];
            if (livre(nc, nr) && !ok[nr][nc]) {
                ok[nr][nc] = 1;
                quantos++;
                fila.push(nr * cols + nc);
            }
        }
    }
    return { ok: ok, quantos: quantos };
};

// garante que o alvo e alcancavel do spawn EXPLODINDO macios — no
// bomberman '%' abre caminho, so um bolso cercado por '#' isola de vero.
// Recebe candidatos [{c,r}, ...] e devolve o primeiro alcancavel (flood
// tratando qualquer nao-'#' como passavel); sem candidato valido, o
// primeiro da lista (ou null).
GRID.escolheAlcancavel = function (grid, candidatos, sc, sr) {
    var f = GRID.flood(grid, sc, sr, function (ch) {
        return ch !== '#';
    });
    for (var i = 0; i < candidatos.length; i++) {
        if (f.ok[candidatos[i].r][candidatos[i].c]) return candidatos[i];
    }
    return candidatos.length ? candidatos[0] : null;
};

// celulaLivre(grid, rng, filtro) — sorteia uma celula que satisfaz
// filtro(c, r, ch) (default: '.' livre). Devolve {c,r} ou null.
GRID.celulaLivre = function (grid, rng, filtro) {
    var rows = grid.length, cols = rows ? grid[0].length : 0;
    var passa = filtro || function (c, r, ch) { return ch === '.'; };
    for (var t = 0; t < 80; t++) {
        var c = Math.floor(rng() * cols), r = Math.floor(rng() * rows);
        if (passa(c, r, grid[r][c])) return { c: c, r: r };
    }
    return null;
};

// flow(grid, tc, tr, passavel) — campo de distancia BFS ate o alvo
// (tc,tr): perseguicao em grade sem a dep de fisica. passavel(ch) decide o
// que se atravessa. Devolve {dist(c,r), next(c,r)}: next e o vizinho um
// passo mais perto do alvo (null na origem, fora do mapa ou sem caminho);
// ordem fixa dir/esq/baixo/cima = deterministico. Recompute quando o
// labirinto ou o alvo mudam (~2x/s), nunca por frame.
GRID.flow = function (grid, tc, tr, passavel) {
    var rows = grid.length, cols = rows ? grid[0].length : 0;
    var n = rows * cols, dist = new Array(n), i;
    for (i = 0; i < n; i++) dist[i] = -1;
    function anda(c, r) {
        return r >= 0 && r < rows && c >= 0 && c < cols && passavel(grid[r][c]);
    }
    var q = [], head = 0;
    if (tc >= 0 && tc < cols && tr >= 0 && tr < rows) {
        dist[tr * cols + tc] = 0;
        q.push(tr * cols + tc);
    }
    while (head < q.length) {
        var at = q[head++], c = at % cols, r = (at - c) / cols, d = dist[at] + 1;
        if (anda(c + 1, r) && dist[at + 1] < 0) { dist[at + 1] = d; q.push(at + 1); }
        if (anda(c - 1, r) && dist[at - 1] < 0) { dist[at - 1] = d; q.push(at - 1); }
        if (anda(c, r + 1) && dist[at + cols] < 0) { dist[at + cols] = d; q.push(at + cols); }
        if (anda(c, r - 1) && dist[at - cols] < 0) { dist[at - cols] = d; q.push(at - cols); }
    }
    function distAt(c, r) {
        if (r < 0 || r >= rows || c < 0 || c >= cols) return -1;
        return dist[r * cols + c];
    }
    return {
        dist: distAt,
        next: function (c, r) {
            var d = distAt(c, r);
            if (d <= 0) return null;
            if (distAt(c + 1, r) === d - 1) return { c: c + 1, r: r };
            if (distAt(c - 1, r) === d - 1) return { c: c - 1, r: r };
            if (distAt(c, r + 1) === d - 1) return { c: c, r: r + 1 };
            if (distAt(c, r - 1) === d - 1) return { c: c, r: r - 1 };
            return null;
        }
    };
};

GRID.contar = function (grid, ch) {
    var n = 0;
    for (var r = 0; r < grid.length; r++)
        for (var c = 0; c < grid[r].length; c++)
            if (grid[r][c] === ch) n++;
    return n;
};

module.exports = GRID;
