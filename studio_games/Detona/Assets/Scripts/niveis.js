// niveis.js — geracao de arena por seed, temas por mundo e as trilhas.
//
// Grade CLASSICA de bomberman: borda de bloco duro + pilares nas
// intersecoes pares; macios por densidade; o canto do spawn (1,1) com as
// 3 celulas livres; saida e powerups escondidos SOB macios. seed =
// mundo*100 + nivel — deterministica (testes e, no futuro, o versus
// pela malha gera a mesma arena nos dois aparelhos).

var COLS = 15, ROWS = 13;
var NIVEIS_POR_MUNDO = 8;

// xorshift32 (mesmo esquema do E.rng da engine — modulo independente)
function rng(seed) {
    var s = seed >>> 0;
    if (!s) s = 0x9e3779b9;
    return function () {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}

// paletas do chao procedural (lajota 2 tons + junta) por mundo. macio/duro
// sao os PNGs tematicos de bloco (o main recarrega os slots por fase); o
// painter fallback tinge o bloco com o detalhe do mundo
var TEMAS = [
    {   // 1: Jardim de Pedra
        nome: "Jardim de Pedra",
        a: 0x1820, b: 0x1008, junta: 0x0800,
        hud: 0x0406, hudTxt: 0xC618, detalhe: 0x07E0,
        macio: "bloco_macio_1", duro: "bloco_duro_1"
    },
    {   // 2: Forno
        nome: "Forno",
        a: 0x4000, b: 0x2A00, junta: 0x1000,
        hud: 0x2000, hudTxt: 0xFFE0, detalhe: 0xFD20,
        macio: "bloco_macio_2", duro: "bloco_duro_2"
    },
    {   // 3: Nucleo
        nome: "Nucleo",
        a: 0x1008, b: 0x0804, junta: 0x0000,
        hud: 0x0204, hudTxt: 0xBDF7, detalhe: 0xF81F,
        macio: "bloco_macio_3", duro: "bloco_duro_3"
    }
];

// trilha de batalha (128 BPM, 4 trilhas, 8 loops) — o pavio das bombas
// e quantizado nesta batida: a explosao CAI no tempo. Meio segundo por
// batida: fuse de 4 beats = 2 s classico.
var SONG_BATALHA = {
    bpm: 128, loops: 8,
    tracks: [
        {   // bateria GM: bumbo 36 / caixa 38 / chimbal 42
            drum: true, vol: 70,
            notes: [[36, 2], [42, 2], [38, 2], [42, 2],
                    [36, 2], [42, 2], [38, 2], [42, 2],
                    [36, 2], [42, 2], [38, 2], [42, 2],
                    [36, 2], [36, 2], [38, 2], [42, 2]]
        },
        {   // baixo (lam: A2/A2/C3/D3)
            wave: "tri", vol: 60,
            notes: [[45, 4], [45, 2], [48, 2], [50, 4], [45, 4],
                    [45, 4], [45, 2], [48, 2], [52, 4], [50, 4],
                    [45, 4], [45, 2], [48, 2], [50, 4], [43, 4],
                    [41, 4], [43, 2], [45, 2], [40, 4], [40, 4]]
        },
        {   // melodia (mi menor relativo, frase curta e ritmica)
            wave: "sq", vol: 45,
            notes: [[64, 2], [67, 2], [69, 4], [67, 2], [64, 2],
                    [62, 4], [64, 8],
                    [64, 2], [67, 2], [69, 4], [72, 2], [71, 2],
                    [69, 4], [67, 8],
                    [71, 2], [69, 2], [67, 4], [64, 2], [62, 2],
                    [60, 4], [62, 8]]
        },
        {   // arpejo no contratempo
            wave: "sq25", vol: 30,
            notes: [[52, 2], [55, 2], [59, 2], [55, 2],
                    [52, 2], [55, 2], [59, 2], [55, 2],
                    [50, 2], [53, 2], [57, 2], [53, 2],
                    [50, 2], [53, 2], [57, 2], [53, 2],
                    [48, 2], [52, 2], [55, 2], [52, 2],
                    [48, 2], [52, 2], [55, 2], [52, 2],
                    [50, 2], [53, 2], [57, 2], [53, 2],
                    [43, 2], [47, 2], [50, 2], [47, 2]]
        }
    ]
};

var SONG_MENU = {
    bpm: 96, loops: 8,
    tracks: [
        { drum: true, vol: 40,
          notes: [[36, 4], [42, 4], [38, 4], [42, 4]] },
        { wave: "tri", vol: 55,
          notes: [[45, 8], [52, 8], [50, 8], [48, 8],
                  [45, 8], [52, 8], [55, 8], [52, 8]] }
    ]
};

// grade local (a dep celeros.grid saiu do pacote: o app.json tem teto de 8
// deps e o kit ja traz o E.path da IA). As funcoes mantem a MESMA sequencia
// de rng — a seed do duelo continua gerando a mesma arena nos dois vidros.
function novaGrade(cols, rows, ch) {
    var g = [];
    for (var r = 0; r < rows; r++) {
        var linha = [];
        for (var c = 0; c < cols; c++) linha.push(ch);
        g.push(linha);
    }
    return g;
}

// flood(grid, sc, sr, passavel) -> {ok: matriz, quantos}
function flood(grid, sc, sr, passavel) {
    var rows = grid.length, cols = rows ? grid[0].length : 0;
    var ok = novaGrade(cols, rows, 0);
    if (sr < 0 || sr >= rows || sc < 0 || sc >= cols) return { ok: ok, quantos: 0 };
    var fila = [sr * cols + sc];
    ok[sr][sc] = 1;
    var quantos = 1, head = 0;
    while (head < fila.length) {
        var at = fila[head++];
        var r = Math.floor(at / cols), c = at % cols;
        var viz = [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]];
        for (var v = 0; v < 4; v++) {
            var nc = viz[v][0], nr = viz[v][1];
            if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
            if (passavel(grid[nr][nc]) && !ok[nr][nc]) {
                ok[nr][nc] = 1;
                quantos++;
                fila.push(nr * cols + nc);
            }
        }
    }
    return { ok: ok, quantos: quantos };
}

// arena classica: borda '#' + pilares pares + macios por densidade
function classica(cols, rows, r, opts) {
    opts = opts || {};
    var dens = opts.dens === undefined ? 0.55 : opts.dens;
    var protege = opts.protege || [[1, 1]];
    var respira = opts.respira !== false;
    var g = novaGrade(cols, rows, '.');
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
    for (var rr = 0; rr < rows; rr++) {
        for (var cc = 0; cc < cols; cc++) {
            if (rr === 0 || rr === rows - 1 || cc === 0 || cc === cols - 1) g[rr][cc] = '#';
            else if (rr % 2 === 0 && cc % 2 === 0) g[rr][cc] = '#';
            else if (!protegidas[cc + ',' + rr] && r() < dens) {
                g[rr][cc] = '%';
                macios.push({ c: cc, r: rr });
            }
        }
    }
    return { grid: g, macios: macios };
}

// primeiro candidato alcancavel explodindo macios (qualquer nao-'#')
function escolheAlcancavel(grid, candidatos, sc, sr) {
    var f = flood(grid, sc, sr, function (ch) { return ch !== '#'; });
    for (var i = 0; i < candidatos.length; i++) {
        if (f.ok[candidatos[i].r][candidatos[i].c]) return candidatos[i];
    }
    return candidatos.length ? candidatos[0] : null;
}

// mundo 2 (Forno): 140 BPM, maior e agressiva, em mi
var SONG_FORNO = {
    bpm: 140, loops: 8,
    tracks: [
        { drum: true, vol: 75,
          notes: [[36, 2], [36, 2], [38, 2], [42, 1], [42, 1],
                  [36, 2], [36, 2], [38, 2], [42, 2],
                  [36, 2], [36, 2], [38, 2], [42, 1], [42, 1],
                  [38, 2], [42, 2], [38, 2], [42, 2]] },
        { wave: "tri", vol: 60,
          notes: [[40, 2], [40, 2], [47, 2], [40, 2], [45, 2], [43, 2],
                  [40, 2], [40, 2], [47, 2], [40, 2], [50, 2], [47, 2],
                  [40, 2], [40, 2], [47, 2], [40, 2], [45, 2], [43, 2],
                  [38, 2], [38, 2], [45, 2], [38, 2], [43, 2], [40, 2]] },
        { wave: "sq", vol: 42,
          notes: [[64, 2], [67, 2], [71, 2], [67, 2], [69, 4], [67, 4],
                  [64, 2], [67, 2], [71, 2], [74, 2], [72, 4], [71, 4],
                  [76, 2], [74, 2], [72, 2], [71, 2], [69, 4], [71, 4],
                  [67, 6], [64, 6], [64, 4]] }
    ]
};

// mundo 3 (Nucleo): 120 BPM, grave e mecanico, em do menor
var SONG_NUCLEO = {
    bpm: 120, loops: 8,
    tracks: [
        { drum: true, vol: 70,
          notes: [[36, 4], [42, 2], [38, 2],
                  [36, 4], [42, 2], [38, 2],
                  [36, 4], [42, 2], [38, 4],
                  [36, 2], [36, 2], [42, 2], [38, 2]] },
        { wave: "saw", vol: 38,
          notes: [[36, 4], [39, 4], [43, 4], [39, 4],
                  [34, 4], [38, 4], [41, 4], [38, 4],
                  [36, 4], [39, 4], [43, 4], [46, 4],
                  [44, 4], [43, 4], [39, 4], [36, 4]] },
        { wave: "sq25", vol: 30,
          notes: [[60, 2], [63, 2], [67, 2], [63, 2],
                  [58, 2], [62, 2], [65, 2], [62, 2],
                  [60, 2], [63, 2], [67, 2], [70, 2],
                  [68, 2], [67, 2], [63, 2], [60, 2]] }
    ]
};

// chefe: 150 BPM, tensa, bumbo dobrado
var SONG_CHEFE = {
    bpm: 150, loops: 8,
    tracks: [
        { drum: true, vol: 85,
          notes: [[36, 1], [36, 1], [42, 2], [38, 2],
                  [36, 1], [36, 1], [42, 2], [38, 2],
                  [36, 1], [36, 1], [36, 1], [36, 1], [38, 2], [42, 2]] },
        { wave: "saw", vol: 45,
          notes: [[38, 2], [38, 2], [41, 2], [38, 2],
                  [36, 2], [36, 2], [43, 2], [36, 2],
                  [38, 2], [38, 2], [41, 2], [44, 2],
                  [43, 4], [41, 4], [38, 4], [36, 4]] },
        { wave: "sq", vol: 40,
          notes: [[62, 4], [65, 4], [69, 4], [68, 4],
                  [62, 4], [65, 4], [70, 4], [69, 4],
                  [74, 2], [72, 2], [70, 2], [68, 2],
                  [67, 4], [65, 4], [62, 8]] }
    ]
};

var MUNDOS = TEMAS.length;   // a campanha fecha no chefe do ultimo mundo

// trilha da fase: mundo 1 = batalha, 2 = forno, 3 = nucleo; chefe no 8o
function musica(mundo, nivel, sobrevivencia) {
    if (sobrevivencia) return SONG_FORNO;
    if (nivel % NIVEIS_POR_MUNDO === 0) return SONG_CHEFE;
    if (mundo === 2) return SONG_FORNO;
    if (mundo >= 3) return SONG_NUCLEO;
    return SONG_BATALHA;
}

// dificuldade por nivel absoluto (1..24): densidade de macios, bichos e
// mix — os chefes fecham cada mundo (nivel % 8 == 0)
function params(mundo, nivel) {
    var abs = (mundo - 1) * NIVEIS_POR_MUNDO + nivel;
    return {
        abs: abs,
        dens: Math.min(0.50 + abs * 0.008, 0.68),
        inimigos: Math.min(2 + Math.floor(abs / 2), 8),
        tempo: 200 - Math.min(abs * 2, 60),
        chefe: nivel % NIVEIS_POR_MUNDO === 0
    };
}

// celula livre longe do spawn (c + r >= minDist) e fora da lista evita
function sorteiaLivre(grid, r, minDist, evita) {
    for (var t = 0; t < 120; t++) {
        var c = 1 + Math.floor(r() * (COLS - 2));
        var rr = 1 + Math.floor(r() * (ROWS - 2));
        if (grid[rr][c] !== '.' || c + rr < minDist) continue;
        var ruim = false;
        for (var i = 0; i < evita.length; i++) {
            if (Math.abs(evita[i].c - c) + Math.abs(evita[i].r - rr) < 3) { ruim = true; break; }
        }
        if (!ruim) return { c: c, r: rr };
    }
    return null;
}

// conectividade: tudo que nao e '#' tem de ser alcancavel de (1,1) abrindo
// macios (mesma nocao do escolheAlcancavel local) — valida cada peca nova
function tudoAlcancavel(grid) {
    var f = flood(grid, 1, 1, function (ch) { return ch !== '#'; });
    for (var r = 0; r < ROWS; r++)
        for (var c = 0; c < COLS; c++)
            if (grid[r][c] !== '#' && !f.ok[r][c]) return false;
    return true;
}

// ressync da lista de macios com a grade (os padroes promovem/depõem blocos)
function remacula(grid) {
    var macios = [];
    for (var r = 0; r < ROWS; r++)
        for (var c = 0; c < COLS; c++)
            if (grid[r][c] === '%') macios.push({ c: c, r: r });
    return macios;
}

// PADRAO DE MAPA por mundo (a partir do 2o nivel; a 1a fase de cada mundo
// apresenta o tema na grade classica):
//   1 Jardim "canteiros": moitas de macio em fileiras organizadas nas
//     linhas 3/6/9 (leitura de canteiro) no lugar do salpicado aleatorio
//   2 Forno "veios": placas de obsidiana ('#') em diagonal com macios
//     aglomerados em volta — cada peca nova so fica se a arena inteira
//     continua alcancavel
//   3 Nucleo "camaras": duas paredes atravessadas com portas de 1 celula
//     sorteadas pela seed — tres bandas de arena, tocaia de portal
function padronizar(mundo, nivel, grid, r) {
    if (nivel <= 1) return;
    var c, rr;
    if (mundo === 1) {
        // limpa macios das linhas de canteiro e replanta em moitas
        for (rr = 3; rr <= 9; rr += 3) {
            var livres = [];
            for (c = 1; c < COLS - 1; c++) {
                if (grid[rr][c] === '%' && c + rr >= 6) { grid[rr][c] = '.'; livres.push(c); }
                else if (grid[rr][c] === '.' && c + rr >= 6) livres.push(c);
            }
            var n = Math.max(2, Math.floor(livres.length / 3));
            for (var m = 0; m < n; m++) {
                var ini = Math.floor(r() * livres.length);
                var comp = 2 + Math.floor(r() * 2);   // moita de 2-3
                for (var k = 0; k < comp; k++) {
                    var cc = livres[(ini + k * 2) % livres.length];
                    if (grid[rr][cc] === '.') grid[rr][cc] = '%';
                }
            }
        }
    } else if (mundo === 2) {
        var passo = 8 + Math.floor(r() * 2);   // 8-9: 2 diagonais na arena
        var o1 = 3 + Math.floor(r() * 4), o2 = o1 + 4 + Math.floor(r() * 2);
        for (rr = 1; rr < ROWS - 1; rr++) {
            for (c = 1; c < COLS - 1; c++) {
                if (grid[rr][c] !== '.') continue;
                var diag = (c + rr) % passo === o1 % passo ||
                           (c + rr) % passo === o2 % passo;
                if (!diag || (c % 2 === 0 && rr % 2 === 0)) continue;
                if (c + rr < 6) continue;
                grid[rr][c] = '#';
                if (!tudoAlcancavel(grid)) { grid[rr][c] = '.'; continue; }
                // aglomerado de macio encostado na placa nova
                var dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
                for (var d = 0; d < 4; d++) {
                    var nc = c + dirs[d][0], nr = rr + dirs[d][1];
                    if (grid[nr] && grid[nr][nc] === '.' && r() < 0.5 &&
                        nc + nr >= 6) grid[nr][nc] = '%';
                }
            }
        }
    } else if (mundo >= 3) {
        for (rr = 4; rr <= 8; rr += 4) {
            for (c = 1; c < COLS - 1; c++) {
                if (grid[rr][c] !== '#') grid[rr][c] = '#';
            }
            var portas = 0, tenta = 0;
            while (portas < 2 && tenta < 24) {
                tenta++;
                var pc = 3 + Math.floor(r() * (COLS - 6));
                if (grid[rr][pc] !== '#') continue;
                grid[rr][pc] = '.';
                portas++;
            }
            // garantia extrema: nenhuma porta coube, abre a do meio
            if (!tudoAlcancavel(grid)) {
                grid[rr][COLS >> 1] = '.';
                if (!tudoAlcancavel(grid)) grid[rr][COLS >> 1] = '#';
            }
        }
    }
}

// gera {grid, exit, powerups, spawns} para mundo/nivel (1-based).
// opts.sobrevivencia: arena fixa (seed proprio), mais vazia, sem saida,
// sem tempo — as ondas quem comandam sao o main/ia.
// opts.duelo: arena do versus pela malha — os DOIS cantos respiram
// (spawn do rival), sem saida, sem bichos, sem perigos de mundo; a seed
// vem por mensagem (opts.seed) para os dois aparelhos gerarem igual.
function gerar(mundo, nivel, opts) {
    opts = opts || {};
    var p = params(mundo, nivel);
    var r = rng(opts.seed !== undefined ? opts.seed
              : opts.sobrevivencia ? 9090 : mundo * 100 + nivel);
    var dens = opts.duelo ? 0.46 : opts.sobrevivencia ? 0.45 : p.dens;
    // arena classica local: borda + pilares pares + macios por densidade,
    // canto do spawn (1,1) respirando (no duelo os dois)
    var arena_ = classica(COLS, ROWS, r, {
        dens: dens,
        protege: opts.duelo ? [[1, 1], [COLS - 2, ROWS - 2]] : [[1, 1]]
    });
    var grid = arena_.grid;
    var macios = arena_.macios;
    // garante macios minimos p/ saida + powerups
    while (macios.length < 8) {
        var cc2 = 1 + Math.floor(r() * (COLS - 2));
        var rr2 = 1 + Math.floor(r() * (ROWS - 2));
        if (grid[rr2][cc2] === '.') {
            grid[rr2][cc2] = '%';
            macios.push({ c: cc2, r: rr2 });
        }
    }
    // padrao de mapa do mundo (campanha e duelo — tudo por seed, os dois
    // aparelhos do versus geram a mesma arena; fase de chefe nao: o 2x2
    // nao atravessa porta de 1 celula das camaras)
    if (!opts.sobrevivencia && !p.chefe) padronizar(mundo, nivel, grid, r);
    macios = remacula(grid);
    // chefe no fim do mundo: a area 2x2 de spawn dele respira (e sai da
    // lista de macios — saida/powerup nunca escondem la)
    if (p.chefe) {
        for (var br = 1; br <= 2; br++)
            for (var bc = (COLS >> 1) - 1; bc <= (COLS >> 1); bc++)
                grid[br][bc] = '.';
        var vivos = [];
        for (var mf = 0; mf < macios.length; mf++)
            if (grid[macios[mf].r][macios[mf].c] === '%') vivos.push(macios[mf]);
        macios = vivos;
    }
    // saida sob um macio longe do spawn (sobrevivencia/duelo nao tem saida);
    // escolheAlcancavel (flood tratando macio como passavel) garante que
    // da pra chegar explodindo — nunca nasce em bolso cercado por parede
    var exit = { c: -1, r: -1 };
    if (!opts.sobrevivencia && !opts.duelo) {
        var longe = [];
        for (var lf = 0; lf < macios.length; lf++)
            if (macios[lf].c + macios[lf].r > 12) longe.push(macios[lf]);
        var escolhido = escolheAlcancavel(grid, longe.length ? longe : macios, 1, 1);
        if (escolhido) exit = { c: escolhido.c, r: escolhido.r };
    }
    // powerups sob macios distintos da saida (kinds basicos aqui; o
    // restante do catalogo entra conforme o mundo avanca)
    var catalogo = ['B', 'C', 'V'];
    if (p.abs >= 4) catalogo.push('T');            // relogio (+30 s)
    if (p.abs >= 5) catalogo.push('B', 'C');
    if (p.abs >= 7) catalogo.push('K');            // chute
    if (p.abs >= 10) catalogo.push('R', 'P');      // detonador, perfurante
    if (p.abs >= 13) catalogo.push('E', 'X');      // escudo, vida
    var powerups = {};
    var nPow = 2 + Math.floor(p.abs / 6);
    for (var i = 0; i < nPow && macios.length; i++) {
        for (var t2 = 0; t2 < 40; t2++) {
            var m2 = macios[Math.floor(r() * macios.length)];
            var key = m2.c + ',' + m2.r;
            if (grid[m2.r][m2.c] !== '%') continue;
            if (m2.c === exit.c && m2.r === exit.r) continue;
            if (powerups[key]) continue;
            powerups[key] = catalogo[Math.floor(r() * catalogo.length)];
            break;
        }
    }
    // spawns de inimigos: celulas livres longe do canto do spawn. O ladrao
    // (rouba powerup do chao e foge) entra no Jardim, o cuspidor (cospe
    // fogo de 1 celula quando o jogador alinha) e do Forno pra frente
    var spawns = [];
    var kinds = opts.sobrevivencia ? ['balao', 'fantasma', 'cacador', 'ladrao']
              : p.abs < 3 ? ['balao']
              : p.abs < 6 ? ['balao', 'fantasma', 'ladrao']
              : p.abs < 11 ? ['balao', 'fantasma', 'divisor', 'cacador', 'ladrao']
              : ['fantasma', 'cacador', 'divisor', 'blindado', 'balao', 'cuspidor'];
    var ninim = opts.sobrevivencia ? 3 : p.inimigos;
    if (opts.duelo) ninim = 0;   // duelo: so os dois jogadores
    for (var e = 0; e < ninim; e++) {
        for (var t3 = 0; t3 < 80; t3++) {
            var c3 = 1 + Math.floor(r() * (COLS - 2));
            var r3 = 1 + Math.floor(r() * (ROWS - 2));
            if (grid[r3][c3] !== '.') continue;
            if (c3 + r3 < 10) continue;            // longe do player
            spawns.push({ kind: kinds[Math.floor(r() * kinds.length)], c: c3, r: r3 });
            break;
        }
    }
    if (p.chefe && !opts.sobrevivencia && !opts.duelo)
        spawns.push({ kind: 'chefe', c: (COLS >> 1) - 1, r: 1 });
    // perigos do mundo (fora das fases de chefe): Forno = respiros de fogo
    // que explodem na batida; Nucleo = pares de teleporte
    var ventos = [], teles = [];
    if (!opts.sobrevivencia && !opts.duelo && !p.chefe && mundo === 2) {
        var nv = 2 + Math.floor(nivel / 3);
        for (var v = 0; v < nv; v++) {
            var cv = sorteiaLivre(grid, r, 7, ventos.concat(spawns));
            if (cv) ventos.push({ c: cv.c, r: cv.r, aviso: false });
        }
    }
    if (!opts.sobrevivencia && !opts.duelo && !p.chefe && mundo >= 3) {
        var pares = nivel >= 4 ? 2 : 1;
        for (var tp = 0; tp < pares * 2; tp++) {
            var ct = sorteiaLivre(grid, r, 4, teles);
            if (ct) teles.push({ c: ct.c, r: ct.r });
        }
        if (teles.length % 2) teles.pop();
    }
    var song = musica(mundo, nivel, opts.sobrevivencia);
    return { grid: grid, exit: exit, powerups: powerups, spawns: spawns,
             ventos: ventos, teles: teles, bpm: song.bpm,
             sobrevivencia: !!opts.sobrevivencia,
             tempo: (opts.sobrevivencia || opts.duelo) ? 99999 : p.tempo,
             tema: TEMAS[Math.min(mundo - 1, TEMAS.length - 1)] };
}

module.exports = {
    COLS: COLS, ROWS: ROWS, NIVEIS_POR_MUNDO: NIVEIS_POR_MUNDO, MUNDOS: MUNDOS,
    TEMAS: TEMAS, SONG_BATALHA: SONG_BATALHA, SONG_MENU: SONG_MENU,
    SONG_FORNO: SONG_FORNO, SONG_NUCLEO: SONG_NUCLEO, SONG_CHEFE: SONG_CHEFE,
    musica: musica, params: params, gerar: gerar, rng: rng,
    // utilitarios de grade puros (o harness/detona.GRID usa o flood)
    flood: flood, classica: classica, escolheAlcancavel: escolheAlcancavel
};
