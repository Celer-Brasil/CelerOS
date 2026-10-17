// ia.js — os bichos do Detona!. Andarilhos de grade + o chefe:
//
//   balao     2.1 cel/s, vagueia (segue reto, dobra no bloqueio)
//   fantasma  1.5 cel/s, ATRAVESSA bloco macio (flow com passable proprio)
//   cacador   3.0 cel/s, desce o campo de fluxo GRID.flow ate o jogador e
//             FOGE das celulas que vao pegar fogo (le o pavio das bombas)
//   blindado  1.3 cel/s, 2 acertos (o 1o arranca a blindagem), esperto
//             como o cacador para fugir de bomba
//   divisor   1.9 cel/s, ao morrer se parte em 2 mini (rapidos, 1 acerto)
//   ladrao    2.6 cel/s, ronda os POWERUPS expostos: pega o mais proximo
//             (flow ate ele), engole e foge de quem tem bomba; ao morrer
//             larga tudo o que carrega na celula (ou vizinha) livre
//   cuspidor  1.0 cel/s, 2 acertos, tanque parado: quando o jogador alinha
//             (linha/coluna limpa, ate 5 celulas) a boca acende por meio
//             tempo e COSPE fogo na celula da frente — labareda ambiente
//             (fere so o jogador, como os respiros do Forno)
//   chefe     2x2 celulas, 8 acertos, anda devagar e JOGA bombas na
//             batida forte (a cada 8 tempos) perto do jogador
//
// Acerto de labareda pela celula que o corpo OCUPA agora (antes era a de
// partida: bicho no meio do passo escapava), com janela de invencivel
// apos o golpe (a labareda dura ~8 quadros: o chefe perdia 8 hp numa
// bomba so). O campo e recomputado ~2x/s: O(celulas), deterministico.

var arena = require("arena");
var NV = require("niveis");
var GRID = require("celeros.grid");
var S = System;

var PERFIS = {
    balao:    { vel: 2.1, pontos: 100, w: 1, hp: 1 },
    fantasma: { vel: 1.5, pontos: 200, w: 1, hp: 1 },
    cacador:  { vel: 3.0, pontos: 300, w: 1, hp: 1, esperto: true },
    blindado: { vel: 1.3, pontos: 400, w: 1, hp: 2, esperto: true },
    divisor:  { vel: 1.9, pontos: 250, w: 1, hp: 1 },
    mini:     { vel: 3.4, pontos: 50, w: 1, hp: 1 },
    ladrao:   { vel: 2.6, pontos: 350, w: 1, hp: 1, esperto: true },
    cuspidor: { vel: 1.0, pontos: 500, w: 1, hp: 2 },
    chefe:    { vel: 0.9, pontos: 1500, w: 2, hp: 8 }
};
var INV_BEATS = 1.2;   // invencivel apos levar golpe (chefe/blindado)

var flow = null, flowGhost = null, flowAte = 0;
var perigoCache = null, perigoAte = 0;
var ultimoBeat = -1;
var R = NV.rng(1);   // rng da fase: decisoes deterministicas (testes/versus)

function ligar() {
    var st = arena.state();
    R = NV.rng(st.mundo * 7717 + st.nivel * 131);
    ultimoBeat = -1;
    flowAte = 0;
    perigoAte = 0;
    st.enemies.length = 0;
    for (var i = 0; i < st.spawns.length; i++) {
        var sp = st.spawns[i];
        colocar(sp.kind, sp.c, sp.r);
    }
    arena.setIA(update);
    st._ferirNa = ferirNa;
    st._ocupadoPorBicho = ocupado;
    recompute(true);
}

function colocar(kind, c, r) {
    var st = arena.state();
    var pf = PERFIS[kind] || PERFIS.balao;
    var e = {
        kind: kind, c: c, r: r, tc: c, tr: r,     // celula atual e alvo
        fx: c + pf.w / 2, fy: r + pf.w / 2,       // centro em celulas (fracao)
        vel: pf.vel, pontos: pf.pontos, w: pf.w,
        hp: pf.hp, hpMax: pf.hp, esperto: !!pf.esperto,
        dir: { dx: 0, dy: 0 },
        invAte: -1, flash: 0,
        bocaAte: 0, cuspeCd: 0, cuspeDir: null,   // cuspidor
        roubos: [],                               // ladrao
        morto: false
    };
    st.enemies.push(e);
    return e;
}

function recompute(forca) {
    var st = arena.state();
    var agora = S.millis();
    if (!forca && agora < flowAte) return;
    flowAte = agora + 500;
    var cel = arena.celulaPlayer();
    flow = GRID.flow(st.grid, cel.c, cel.r, function (ch) { return ch === '.'; });
    // o fantasma ignora macio e bomba: so o duro bloqueia
    flowGhost = GRID.flow(st.grid, cel.c, cel.r, function (ch) { return ch !== '#'; });
}

function perigo() {
    var agora = S.millis();
    if (!perigoCache || agora >= perigoAte) {
        perigoCache = arena.perigo(2.2);   // bombas a <= 2,2 batidas do fim
        perigoAte = agora + 120;
    }
    return perigoCache;
}

function livre(c, r, ghost) {
    var ch = arena.em(c, r);
    if (ch === '.') return true;
    if (ghost && ch === '%') return true;
    return false;
}

function podeIr(e, c, r) {
    return e.kind === 'chefe' ? chefeCabe(c, r) : livre(c, r, e.kind === 'fantasma');
}

function decide(e) {
    var st = arena.state();
    recompute(false);
    var alvo = null;
    var dz = e.esperto ? perigo() : null;
    var emPerigo = dz && dz[e.c + ',' + e.r];
    if (!emPerigo) {
        if ((e.kind === 'cacador' || e.kind === 'blindado' || e.kind === 'mini') && flow) {
            var n = flow.next(e.c, e.r);
            if (n && arena.em(n.c, n.r) === '.' && !(dz && dz[n.c + ',' + n.r])) alvo = n;
        } else if (e.kind === 'fantasma' && flowGhost && R() < 0.7) {
            var n2 = flowGhost.next(e.c, e.r);
            if (n2) alvo = n2;
        } else if (e.kind === 'ladrao') {
            alvo = alvoLadrao(e, st, dz);
        }
    } else if (e.kind === 'ladrao') {
        // em perigo: so foge (o saquinho nao vale a vida)
        alvo = fugaLadrao(e, dz);
    }
    if (!alvo) {
        // vagueio: segue reto quando da; dobra aleatorio no bloqueio; so re
        // (voltar) em beco sem saida. O esperto prefere celula fora do fogo
        var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        var opcoes = [], seguras = [], tras = null;
        for (var d = 0; d < 4; d++) {
            var nc = e.c + dirs[d][0], nr = e.r + dirs[d][1];
            if (!podeIr(e, nc, nr)) continue;
            var seguro = !(dz && dz[nc + ',' + nr]);
            if (dirs[d][0] === -e.dir.dx && dirs[d][1] === -e.dir.dy) {
                tras = dirs[d];
                if (emPerigo && seguro) seguras.push(dirs[d]);
                continue;
            }
            opcoes.push(dirs[d]);
            if (seguro) seguras.push(dirs[d]);
        }
        if (dz && seguras.length) opcoes = seguras;
        var escolha = null;
        var teimoso = e.kind === 'balao' || e.kind === 'chefe' ||
                      e.kind === 'divisor' || e.kind === 'cuspidor';
        if (opcoes.length) {
            if (teimoso && (e.dir.dx !== 0 || e.dir.dy !== 0) && R() < 0.75) {
                for (var q = 0; q < opcoes.length; q++) {
                    if (opcoes[q][0] === e.dir.dx && opcoes[q][1] === e.dir.dy) {
                        escolha = opcoes[q];
                        break;
                    }
                }
            }
            if (!escolha) escolha = opcoes[Math.floor(R() * opcoes.length)];
        } else if (tras) escolha = tras;
        if (escolha) alvo = { c: e.c + escolha[0], r: e.r + escolha[1] };
    }
    if (alvo) {
        e.tc = alvo.c; e.tr = alvo.r;
        e.dir = { dx: alvo.c - e.c, dy: alvo.r - e.r };
    } else {
        e.dir = { dx: 0, dy: 0 };
    }
}

// LADRAO: powerup exposto mais proximo (manhattan) vira o alvo — flow
// ATRE ELE (nao ate o jogador). Sem powerup no chao, mantem distancia:
// passo que MAXIMIZA o flow.dist do jogador
function alvoLadrao(e, st, dz) {
    if (!flow) return null;
    var melhor = null, melhorD = 1e9;
    for (var key in st.powerups) {
        var vr = key.split(',');
        var kc = parseInt(vr[0], 10), kr = parseInt(vr[1], 10);
        if (arena.em(kc, kr) !== '.') continue;   // ainda sob macio
        var dd = Math.abs(kc - e.c) + Math.abs(kr - e.r);
        if (dd < melhorD) { melhorD = dd; melhor = { c: kc, r: kr }; }
    }
    if (melhor) {
        var fp = GRID.flow(st.grid, melhor.c, melhor.r, function (ch) { return ch === '.'; });
        var np = fp.next(e.c, e.r);
        if (np && !(dz && dz[np.c + ',' + np.r])) return np;
        return null;   // caminho cortado (bomba no meio): espera
    }
    return fugaLadrao(e, dz);
}

function fugaLadrao(e, dz) {
    if (!flow) return null;
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    var melhorDir = null, melhorDist = -1;
    for (var d = 0; d < 4; d++) {
        var lc = e.c + dirs[d][0], lr = e.r + dirs[d][1];
        if (!podeIr(e, lc, lr)) continue;
        if (dz && dz[lc + ',' + lr]) continue;
        var fd = flow.dist(lc, lr);
        if (fd > melhorDist) { melhorDist = fd; melhorDir = dirs[d]; }
    }
    return melhorDir ? { c: e.c + melhorDir[0], r: e.r + melhorDir[1] } : null;
}

// CUSPIDOR: boca acende 0,7 batida e cospe fogo ambiente na celula da
// frente. Alinhamento = mesma linha/coluna, corredor limpo, ate 5 celulas
function cuspePendente(e, b, cel) {
    var st = arena.state();
    if (e.bocaAte > 0) {
        if (b < e.bocaAte) return;          // ainda anunciando
        e.bocaAte = 0;
        e.cuspeCd = b + 6;                  // um cuspe a cada 6 tempos
        var cc = e.c + e.cuspeDir.dx, cr = e.r + e.cuspeDir.dy;
        if (arena.em(cc, cr) === '.') {
            st.flames.push({ c: cc, r: cr, tipo: 'cuspe', de: b, ate: b + 0.5,
                             dx: e.cuspeDir.dx, dy: e.cuspeDir.dy,
                             ambiente: true, dono: 'x' });
            st.onFx('cuspe', { c: cc, r: cr });
            st.onSfx('vento');
        }
        return;
    }
    if (b < e.cuspeCd) return;
    var dc = cel.c - e.c, dr = cel.r - e.r, dir = null, dist = 0;
    if (dr === 0 && dc !== 0 && Math.abs(dc) <= 5) { dir = { dx: dc > 0 ? 1 : -1, dy: 0 }; dist = Math.abs(dc); }
    else if (dc === 0 && dr !== 0 && Math.abs(dr) <= 5) { dir = { dx: 0, dy: dr > 0 ? 1 : -1 }; dist = Math.abs(dr); }
    if (!dir) return;
    for (var s = 1; s < dist; s++)
        if (arena.em(e.c + dir.dx * s, e.r + dir.dy * s) !== '.') return;
    e.cuspeDir = dir;
    e.bocaAte = b + 0.7;   // telegraph: a boca acende antes do fogo
}

function chefeCabe(c, r) {
    // 2x2: as 4 celulas dentro da arena e nenhuma em duro/macio/bomba
    for (var rr = r; rr < r + 2; rr++) {
        for (var cc = c; cc < c + 2; cc++) {
            if (arena.em(cc, rr) !== '.') return false;
        }
    }
    return true;
}

// celulas que o corpo ocupa agora (1 a 2 por eixo enquanto anda)
function cobre(e, c, r) {
    var m = 0.15;   // tolerancia: rocar a borda nao conta
    return c >= Math.floor(e.fx - e.w / 2 + m) && c <= Math.floor(e.fx + e.w / 2 - m) &&
           r >= Math.floor(e.fy - e.w / 2 + m) && r <= Math.floor(e.fy + e.w / 2 - m);
}

function ocupado(c, r) {
    var st = arena.state();
    for (var i = 0; i < st.enemies.length; i++) {
        if (!st.enemies[i].morto && cobre(st.enemies[i], c, r)) return true;
    }
    return false;
}

function update(dt, beat) {
    var st = arena.state();
    if (!st || st.fim) return;

    // chefe joga bomba na batida forte (a cada 8 tempos)
    if (Math.floor(beat) !== ultimoBeat) {
        ultimoBeat = Math.floor(beat);
        if (ultimoBeat > 0 && ultimoBeat % 8 === 0) {
            for (var b = 0; b < st.enemies.length; b++) {
                if (st.enemies[b].kind === 'chefe' && !st.enemies[b].morto) chefeJoga(st.enemies[b]);
            }
        }
    }

    var px = st.player.x / st.cell, py = st.player.y / st.cell;   // centro em celulas
    var celJog = arena.celulaPlayer();
    var b = arena.beatNow();
    for (var i = 0; i < st.enemies.length; i++) {
        var e = st.enemies[i];
        if (e.morto) continue;
        if (e.flash > 0) e.flash -= dt;

        // cuspidor: boca acesa -> cuspe; procura alinhamento quando em paz
        if (e.kind === 'cuspidor') cuspePendente(e, b, celJog);

        // alvo virou bomba/bloco no meio do passo: volta para a celula de
        // origem (antes atravessava a bomba recem-plantada)
        if ((e.tc !== e.c || e.tr !== e.r) && !podeIr(e, e.tc, e.tr)) {
            e.tc = e.c; e.tr = e.r;
            e.dir = { dx: -e.dir.dx, dy: -e.dir.dy };
        }
        // caminhada: avanca ao alvo em celulas/s
        var passo = e.vel * dt;
        var dx = (e.tc + e.w / 2) - e.fx, dy = (e.tr + e.w / 2) - e.fy;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= passo) {
            e.fx = e.tc + e.w / 2; e.fy = e.tr + e.w / 2;
            e.c = e.tc; e.r = e.tr;
            decide(e);
        } else {
            e.fx += dx / dist * passo;
            e.fy += dy / dist * passo;
        }

        // LADRAO chegou numa celula com powerup exposto: engole (devolve
        // se morrer — a arena repinta a celula pelo st.mudou)
        if (e.kind === 'ladrao') {
            var pk = e.c + ',' + e.r;
            if (st.powerups[pk] && arena.em(e.c, e.r) === '.') {
                e.roubos.push(st.powerups[pk]);
                delete st.powerups[pk];
                st.mudou.push(e.c, e.r);
                st.onSfx('hit');
            }
        }

        // contato com o jogador pelo tamanho do bicho (o chefe 2x2 tem
        // alcance maior; antes so raspava com raio de 1 celula)
        var alcance = e.w / 2 + 0.3;
        var ddx = e.fx - px, ddy = e.fy - py;
        if (Math.abs(ddx) < alcance && Math.abs(ddy) < alcance) arena.tocarPlayer();
        if (st.fim) return;
    }

    // varre mortos
    for (var m = st.enemies.length - 1; m >= 0; m--) {
        if (st.enemies[m].morto) st.enemies.splice(m, 1);
    }
}

function chefeJoga(e) {
    var st = arena.state();
    var cel = arena.celulaPlayer();
    // joga perto do jogador: 1-2 celulas em direcao aleatoria
    for (var t = 0; t < 12; t++) {
        var ang = Math.floor(R() * 4);
        var dist = 1 + Math.floor(R() * 2);
        var c = cel.c + [1, -1, 0, 0][ang] * dist;
        var r = cel.r + [0, 0, 1, -1][ang] * dist;
        if (arena.addBomba(c, r, 2, 2, false, 'x')) {
            st.onSfx('planta');
            st.onFx('joga', e, { c: c, r: r });
            return;
        }
    }
}

// labareda tocou a celula (c,r): bicho comum morre; quem tem hp perde 1
// (com janela de invencivel). As bombas do chefe nao ferem o chefe.
function ferirNa(c, r, dono) {
    var st = arena.state();
    if (!st || st.fim) return;
    var b = arena.beatNow();
    for (var i = 0; i < st.enemies.length; i++) {
        var e = st.enemies[i];
        if (e.morto || !cobre(e, c, r)) continue;
        if (e.kind === 'chefe' && dono === 'x') continue;
        if (b < e.invAte) continue;
        e.hp--;
        if (e.hp > 0) {
            e.invAte = b + INV_BEATS;
            e.flash = 0.4;
            st.onSfx('hit');
            st.onFx('golpe', e);
            continue;
        }
        matar(e, dono);
    }
}

function matar(e, dono) {
    var st = arena.state();
    e.morto = true;
    var pts = dono === 'x' ? 0 : e.pontos * st.mult;   // bicho morto pela bomba do chefe: sem pontos
    st.score += pts;
    st.onFx('bicho', { x: e.fx * st.cell, y: e.fy * st.cell, kind: e.kind, pontos: pts });
    st.onSfx(e.kind === 'chefe' ? 'boomBoss' : 'bicho');
    if (e.kind === 'divisor') {
        // parte em 2 mini nas celulas livres vizinhas (ou na propria)
        var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]], n = 0;
        for (var d = 0; d < 4 && n < 2; d++) {
            var nc = e.c + dirs[d][0], nr = e.r + dirs[d][1];
            if (arena.em(nc, nr) !== '.') continue;
            var mi = colocar('mini', nc, nr);
            mi.invAte = arena.beatNow() + 1;   // nao morre na mesma labareda
            n++;
        }
        if (n === 0) colocar('mini', e.c, e.r).invAte = arena.beatNow() + 1;
    }
    if (e.kind === 'ladrao' && e.roubos.length) {
        // caiu: o saquinho abre — cada powerup roubado volta numa celula
        // livre (a da morte primeiro, vizinhas depois, sem empilhar)
        var tent = [{ c: e.c, r: e.r }, { c: e.c + 1, r: e.r }, { c: e.c - 1, r: e.r },
                    { c: e.c, r: e.r + 1 }, { c: e.c, r: e.r - 1 }];
        for (var rb = 0; rb < e.roubos.length; rb++) {
            for (var tt = 0; tt < tent.length; tt++) {
                var tc2 = tent[tt].c, tr2 = tent[tt].r;
                var tk = tc2 + ',' + tr2;
                if (arena.em(tc2, tr2) === '.' && !st.powerups[tk]) {
                    st.powerups[tk] = e.roubos[rb];
                    st.mudou.push(tc2, tr2);
                    break;
                }
            }
        }
        e.roubos.length = 0;
    }
}

// SOBREVIVENCIA: onda nova (chamada pelo main na batida ou quando a arena
// esvazia): +2..5 bichos, mix piorando com o tempo, nunca perto do player
function onda() {
    var st = arena.state();
    if (!st || !st.sobrevivencia || st.fim) return st ? st.onda : 0;
    if (st.enemies.length > 5) return st.onda;
    st.onda++;
    st.ondaAte = 6;
    var n = Math.min(2 + Math.floor(st.onda / 3), 5);
    var mix = st.onda < 2 ? ['balao']
            : st.onda < 4 ? ['balao', 'fantasma', 'ladrao']
            : st.onda < 7 ? ['balao', 'fantasma', 'cacador', 'divisor', 'ladrao']
            : ['fantasma', 'cacador', 'divisor', 'blindado', 'cuspidor'];
    var cel = arena.celulaPlayer();
    for (var i = 0; i < n; i++) {
        var celula = GRID.celulaLivre(st.grid, R, function (c, r, ch) {
            return ch === '.' && Math.abs(c - cel.c) + Math.abs(r - cel.r) >= 6;
        });
        if (celula) colocar(mix[Math.floor(R() * mix.length)], celula.c, celula.r);
    }
    st.onFx('onda', st.onda);
    return st.onda;
}

module.exports = { ligar: ligar, colocar: colocar, update: update,
                   ferirNa: ferirNa, onda: onda, PERFIS: PERFIS };
