// arena.js — a simulacao do Detona!: grade, jogador (movimento de GRADE
// estilo bomberman: trilhas, quina assistida, sai da propria bomba),
// bombas com pavio NO BEAT, labaredas em cruz, correntes em dominó de meia
// batida, powerups, saida e os perigos de cada mundo (respiros de fogo do
// Forno, teleportes do Nucleo). Inimigos entram pela ia.js; aqui fica o
// estado e os ganchos que eles usam.
//
// A musica e o relogio: beatNow() devolve a batida FRACIONARIA sincrona
// ao musicPos (com guarda de monotonia no restart do loop) ou, sem
// musica, deriva do millis — o jogo pulsa igual no emulador e no
// alto-falante.
//
// Coordenadas: o jogador vive em PIXELS locais da grade (0,0 = canto da
// celula 0,0; centro da celula i = (i + 0.5) * cell). Bichos em celulas.

var E = require("celeros.game");
require("celeros.game.fx");
require("celeros.game.spr");
require("celeros.game.tilemap");
var NV = require("niveis");
var S = System;

var COLS = 15, ROWS = 13;
var FUSE_BEATS = 4;       // pavio da bomba em batidas
var CHAIN_BEATS = 0.5;    // corrente: a proxima bomba explode meio tempo depois
var FLAME_BEATS = 0.6;    // labareda dura um pouco mais de meio tempo
var VENT_BEATS = 0.9;     // erupcao do respiro do Forno
var INTRO_S = 1.6;        // cartao "FASE x-y" antes de valer
var HALF = 0.4;           // meia largura do corpo do jogador (em celulas)

var st = null;            // estado da fase
var _beatOff = 0, _beatLast = 0;

function beatLen() { return 60 / (st && st.bpm || 128); }

// batida continua (segundos em fracao de beat), sincronizada a trilha
function beatNow() {
    var b = -1;
    try { b = E.audio.beat(); } catch (e) {}
    if (b >= 0) {
        if (b < _beatLast - 1) _beatOff += _beatLast;   // loop voltou
        _beatLast = b;
        return b + _beatOff;
    }
    return (S.millis() - st.t0) / 1000 / beatLen();
}

function cellOf(px) { return Math.floor(px / st.cell); }
function centerOf(i) { return (i + 0.5) * st.cell; }

// ------------------------------------------------------------------ fase --

function iniciar(mundo, nivel, plano) {
    st = {
        mundo: mundo, nivel: nivel, tema: plano.tema, bpm: plano.bpm || 128,
        t0: S.millis(), cell: 0, ox: 0, oy: 0,
        grid: plano.grid,
        exit: { c: plano.exit.c, r: plano.exit.r, achada: false, aberta: false },
        powerups: plano.powerups, spawns: plano.spawns || [],
        ventos: plano.ventos || [], teles: plano.teles || [],
        sobrevivencia: !!plano.sobrevivencia, onda: 0, ondaAte: 4,
        combo: 0, comboAte: 0, mult: 1, alertou30: false,
        variacao: [],
        player: null, bombs: [], flames: [], enemies: [],
        passa: [],            // bombas que o jogador ainda pode atravessar (plantou em cima)
        mudou: [],            // [c, r, c, r, ...] celulas da grade alteradas (o render consome)
        tLeft: plano.tempo, tempo0: plano.tempo, score: 0,
        intro: INTRO_S,
        dir: { dx: 0, dy: 0 }, // ultima direcao andada (desliza ate o centro ao soltar)
        teleAte: 0,           // teleporte: so religa depois de sair do pad de chegada
        ventBeat: -1,
        fim: null,            // 'win' | 'dead' | 'tempo' | 'rwin'
        duelo: plano.duelo || null,   // {id, nome, host} — versus pela malha
        rival: null,          // espelho do outro jogador (posicao por msg)
        onSfx: function () {}, onFx: function () {}, onFim: function () {},
        onPegar: function () {}, onChutar: function () {}
    };
    st.player = { x: 0, y: 0, vx: 0, vy: 0, r: 0 };
    st.stats = { bombs: 1, flame: 2, vel: 1, kick: false, remote: false,
                 shield: false, pierce: false, vidas: 2, inv: 0 };
    if (st.duelo) {
        // uma vida por round: labareda encerra; escudo/i-frames continuam
        st.stats.vidas = 1;
        st.rival = { id: st.duelo.id, nome: st.duelo.nome, x: 0, y: 0,
                     tc: 1, tr: 1, morto: false };
    }
    for (var i = 0; i < COLS * ROWS; i++) st.variacao.push(0);
    var r = NV.rng(mundo * 1000 + nivel * 7);
    for (var v = 0; v < st.variacao.length; v++) st.variacao[v] = r();
    _beatOff = 0; _beatLast = 0;
}

// chamado pelo main quando a tela/celula final e conhecida
function layout(cell, ox, oy) {
    st.cell = cell; st.ox = ox; st.oy = oy;
    // duelo: host nasce no canto (1,1), convidado no oposto — a arena e a
    // mesma nos dois aparelhos, cada um ve a si no seu canto
    var host = !(st.duelo && st.duelo.host === false);
    var mc = st.duelo && !host ? COLS - 2 : 1;
    var mr = st.duelo && !host ? ROWS - 2 : 1;
    st.player.x = centerOf(mc); st.player.y = centerOf(mr);
    st.player.r = cell * 0.35;
    if (st.duelo && st.rival) {
        var rc = host ? COLS - 2 : 1, rr = host ? ROWS - 2 : 1;
        st.rival.x = centerOf(rc); st.rival.y = centerOf(rr);
        st.rival.tc = rc; st.rival.tr = rr;
    }
}

function parar() { st = null; }

function state() { return st; }

// toda escrita na grade passa aqui: a celula entra em st.mudou e o render
// repinta so ela (antes o main varria as 195 celulas por quadro: ~7 ms
// de Duktape no SmartDisplay)
function setG(c, r, ch) {
    if (st.grid[r][c] === ch) return;
    st.grid[r][c] = ch;
    st.mudou.push(c, r);
}

function em(c, r) {
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return '#';
    return st.grid[r][c];
}

// ------------------------------------------------------------- jogador ----

// bomba (c,r) ainda atravessavel? (o jogador plantou e nao saiu de cima)
function passaPor(c, r) {
    for (var i = 0; i < st.passa.length; i++) {
        if (st.passa[i].c === c && st.passa[i].r === r) return true;
    }
    return false;
}

// o corpo do jogador (quadrado de meia largura HALF) toca a celula?
function tocaCelula(u, v, c, r) {
    return u + HALF > c && u - HALF < c + 1 && v + HALF > r && v - HALF < r + 1;
}

function bloqueado(c, r) {
    var ch = em(c, r);
    if (ch === '#' || ch === '%') return true;
    if (ch === 'B') return !passaPor(c, r);
    return false;
}

function velocidade() {
    // celulas/s: 3.4 base, +0.55 por patins (teto 4 => 5.05) — antes ia a ~10
    return 3.4 + 0.55 * (st.stats.vel - 1);
}

// Anda no eixo a (0 = x, 1 = y), sentido d (+1/-1), orcamento m (celulas).
// Trilha classica: primeiro alinha o eixo perpendicular ao centro da
// trilha, depois avanca; nunca passa do centro da celula se a da frente
// esta bloqueada. Quina assistida: empurrando contra o bloqueio com o corpo
// deslocado para uma trilha livre, escorrega para ela.
function anda(pos, a, d, m) {
    var along = a === 0 ? 'u' : 'v', perp = a === 0 ? 'v' : 'u';
    var p = pos[perp];
    var lane = Math.floor(p);
    var off = p - (lane + 0.5);
    var c0 = Math.floor(pos[along]);
    var ahead = c0 + d;
    function blk(alongCell, laneCell) {
        return a === 0 ? bloqueado(alongCell, laneCell) : bloqueado(laneCell, alongCell);
    }
    var livreFrente = !blk(ahead, lane);
    var centro = c0 + 0.5;
    var antesDoCentro = d > 0 ? pos[along] < centro - 1e-6 : pos[along] > centro + 1e-6;
    if (livreFrente || antesDoCentro) {
        // alinha a trilha (consome o passo) e avanca com o resto
        var corr = Math.min(Math.abs(off), m);
        pos[perp] = p - (off > 0 ? corr : -corr);
        var resto = m - corr;
        if (resto <= 0) return true;
        var alvo = pos[along] + d * resto;
        if (!livreFrente) alvo = d > 0 ? Math.min(alvo, centro) : Math.max(alvo, centro);
        pos[along] = alvo;
        return true;
    }
    // frente bloqueada e ja no centro: quina assistida
    if (Math.abs(off) > 0.12) {
        var lado = off > 0 ? 1 : -1;
        if (!blk(ahead, lane + lado) && !blk(c0, lane + lado)) {
            pos[perp] = p + lado * Math.min(m, 0.5 - Math.abs(off) + 0.5);
            return true;
        }
    }
    // encosta alinhado (sem tremer no bloqueio)
    pos[along] = centro;
    return false;
}

// input: eixo dominante [-1|0|1, -1|0|1] (joystick do main). Sem input o
// jogador desliza ate o centro da proxima celula na direcao que vinha —
// para sempre alinhado na grade (a bomba cai onde se mira).
function mover(ax, ay, dt) {
    if (!st || st.fim || st.intro > 0) return;
    atualizaPassa();   // saiu de cima da bomba: ela ja e parede neste passo
    var b = st.player, cell = st.cell;
    var pos = { u: b.x / cell, v: b.y / cell };
    var m = velocidade() * dt;
    if (ax !== 0 || ay !== 0) {
        var a = ax !== 0 ? 0 : 1, d = ax !== 0 ? ax : ay;
        var foi = anda(pos, a, d, m);
        st.dir = { dx: ax, dy: ay };
        // CHUTE: andando contra uma bomba (que ja nao e atravessavel)
        if (!foi && st.stats.kick) {
            var cc = Math.floor(pos.u) + ax, rr = Math.floor(pos.v) + ay;
            if (em(cc, rr) === 'B' && !passaPor(cc, rr)) chutar(cc, rr, ax, ay);
        }
    } else if (st.dir.dx !== 0 || st.dir.dy !== 0) {
        // solto: termina o passo ate o centro da celula da frente (ou a atual)
        var ax2 = st.dir.dx, ay2 = st.dir.dy;
        var a2 = ax2 !== 0 ? 0 : 1, d2 = ax2 !== 0 ? ax2 : ay2;
        var al = a2 === 0 ? pos.u : pos.v;
        var c0 = Math.floor(al), frac = al - c0 - 0.5;
        var alvo;
        if (Math.abs(frac) < 1e-3) alvo = al;
        else if (d2 * frac > 0) {   // ja passou do centro da atual: vai ao da proxima
            var prox = c0 + d2;
            var lane = Math.floor(a2 === 0 ? pos.v : pos.u);
            var livre = a2 === 0 ? !bloqueado(prox, lane) : !bloqueado(lane, prox);
            alvo = livre ? prox + 0.5 : c0 + 0.5;
        } else alvo = c0 + 0.5;
        var dist = alvo - al;
        if (Math.abs(dist) <= m) {
            if (a2 === 0) pos.u = alvo; else pos.v = alvo;
            st.dir = { dx: 0, dy: 0 };
        } else {
            var passo = dist > 0 ? m : -m;
            if (a2 === 0) pos.u += passo; else pos.v += passo;
        }
    }
    b.x = pos.u * cell;
    b.y = pos.v * cell;
}

// CHUTE: andando contra uma bomba ela desliza. remoto=true quando veio
// por mensagem do rival (nao re-dispara o gancho de envio)
function chutar(c, r, dx, dy, remoto) {
    for (var i = 0; i < st.bombs.length; i++) {
        var bo = st.bombs[i];
        if (Math.round(bo.fx) === c && Math.round(bo.fy) === r && !bo.desliza) {
            bo.desliza = { dx: dx, dy: dy };
            st.onSfx('chute');
            if (!remoto) st.onChutar(c, r, dx, dy);
        }
    }
}

// mantem a lista de bombas atravessaveis: sai assim que o corpo deixa a
// celula (dai em diante a bomba e parede, inclusive pra voltar)
function atualizaPassa() {
    var u = st.player.x / st.cell, v = st.player.y / st.cell;
    for (var i = st.passa.length - 1; i >= 0; i--) {
        var p = st.passa[i];
        if (em(p.c, p.r) !== 'B' || !tocaCelula(u, v, p.c, p.r)) st.passa.splice(i, 1);
    }
}

function celulaPlayer() {
    return { c: cellOf(st.player.x), r: cellOf(st.player.y) };
}

function plantar() {
    if (!st || st.fim || st.intro > 0) return false;
    var cel = celulaPlayer();
    if (vivas('p') >= st.stats.bombs) return false;
    if (st.grid[cel.r][cel.c] !== '.') return false;
    var ok = addBomba(cel.c, cel.r, FUSE_BEATS, st.stats.flame, true, 'p');
    if (ok) {
        st.passa.push({ c: cel.c, r: cel.r });
        // a bomba e "sua" tambem para o pierce do momento do plantio
        st.bombs[st.bombs.length - 1].pierce = st.stats.pierce;
    }
    return ok;
}

// bomba estrangeira (chefe joga / rival pela malha; plantar do player passa
// sfx). dono: 'p' (jogador: conta combo/pontos), 'x' (o chefe) ou 'r'
// (rival do duelo). vaiAbs: beat ABSOLUTO de explosao dado pelo dono — o
// pavio bate no relogio DELE (o do duelo diverge <1 beat entre aparelhos)
function addBomba(c, r, fuseBeats, range, tocaSom, dono, vaiAbs, pierce) {
    if (!st || em(c, r) !== '.') return false;
    setG(c, r, 'B');
    var de = beatNow(), vai = de + fuseBeats;
    if (vaiAbs !== undefined) { vai = vaiAbs; de = vai - fuseBeats; }
    st.bombs.push({ fx: c, fy: r, de: de, vai: vai,
                    range: range, desliza: null, dono: dono || 'x',
                    pierce: !!pierce });
    // bomba alheia caindo em cima do jogador: ele pode sair dela
    if (st.player && tocaCelula(st.player.x / st.cell, st.player.y / st.cell, c, r) &&
        !passaPor(c, r)) st.passa.push({ c: c, r: r });
    if (tocaSom) st.onSfx('planta');
    return true;
}

// detonador remoto: a bomba mais antiga DO DONO explode quase agora
// ('p' = o meu chip BOOM; 'r' = pedido do rival pela malha)
function detonar(dono) {
    if (!st || st.fim) return false;
    dono = dono || 'p';
    if (dono === 'p' && !st.stats.remote) return false;
    for (var i = 0; i < st.bombs.length; i++) {
        if (st.bombs[i].dono === dono) {
            st.bombs[i].vai = Math.min(st.bombs[i].vai, beatNow() + 0.25);
            return true;
        }
    }
    return false;
}

function vivas(dono) {
    if (!dono) return st.bombs.length;
    var n = 0;
    for (var i = 0; i < st.bombs.length; i++) if (st.bombs[i].dono === dono) n++;
    return n;
}

// ---------------------------------------------------------------- ciclo ---

function update(dt) {
    if (!st || st.fim) return;
    if (st.intro > 0) {               // cartao da fase: o mundo espera
        st.intro -= dt;
        return;
    }
    atualizaPassa();
    if (st.stats.inv > 0) st.stats.inv -= dt;
    if (!st.sobrevivencia && !st.duelo) {
        st.tLeft -= dt;
        if (st.tLeft <= 0) { matar('tempo'); return; }
        if (st.tLeft < 30 && !st.alertou30) {
            st.alertou30 = true;
            st.onSfx('alerta');
        }
    } else if (st.sobrevivencia && st.ondaAte > 0) {
        st.ondaAte -= dt;   // relogio da proxima onda (main cria os bichos)
    }

    var b = beatNow();
    // janela do combo fechou: multiplicador volta a 1
    if (st.combo > 0 && b >= st.comboAte) { st.combo = 0; st.mult = 1; }
    // bombas: pavio no beat + deslizamento do chute
    for (var i = st.bombs.length - 1; i >= 0; i--) {
        var bo = st.bombs[i];
        if (!bo) continue;   // a corrente pode ter tirado varias da lista
        if (bo.desliza) desliza(bo, dt);
        if (b >= bo.vai) explodir(bo);
    }
    perigosDoMundo(b);
    // labaredas: expiram e mordem
    var cel = celulaPlayer();
    for (var f = st.flames.length - 1; f >= 0; f--) {
        var fl = st.flames[f];
        if (b >= fl.ate) { st.flames.splice(f, 1); continue; }
        if (fl.c === cel.c && fl.r === cel.r) ferir();
        if (!fl.ambiente) ferirInimigosNa(fl.c, fl.r, fl.dono);
    }
    if (st.fim) return;
    // inimigos (ia.js instala e roda o proprio update por aqui)
    if (st._ia) st._ia(dt, beatNow());
    if (st.fim) return;
    // rival do duelo: caminha para a ultima celula recebida (interpolado;
    // o dono e a autoridade da propria posicao)
    if (st.duelo) andaRival(dt);
    // porta abre com a arena limpa (a achada + sem bichos vivos)
    var abriu = !st.duelo && st.exit.achada && st.enemies.length === 0;
    if (abriu && !st.exit.aberta) {
        st.exit.aberta = true;
        st.onSfx('ok');
        st.onFx('saida', { c: st.exit.c, r: st.exit.r });
    } else {
        st.exit.aberta = abriu;
    }

    var cel2 = celulaPlayer();
    // powerup na celula
    var key = cel2.c + ',' + cel2.r;
    if (st.powerups[key] && em(cel2.c, cel2.r) === '.') {
        var kind = st.powerups[key];
        pegar(kind);
        delete st.powerups[key];
        st.mudou.push(cel2.c, cel2.r);
        st.onPegar(kind, cel2);   // duelo: avisa a malha
    }
    teleporte(cel2);
    // saida (o centro do jogador dentro da celula da porta)
    if (!st.duelo && cel2.c === st.exit.c && cel2.r === st.exit.r && st.exit.aberta) {
        vencer();
    }
}

// Forno: respiros que avisam no tempo 3 e entram em erupcao no 0 de cada
// compasso (4 batidas) — fogo na celula e nas 4 vizinhas livres. Fere o
// jogador, nao os bichos (eles conhecem a casa).
function perigosDoMundo(b) {
    if (!st.ventos.length) return;
    var bi = Math.floor(b);
    if (bi === st.ventBeat) return;
    st.ventBeat = bi;
    var fase = bi % 4;
    for (var i = 0; i < st.ventos.length; i++) {
        var vt = st.ventos[i];
        vt.aviso = fase === 3;
        if (fase !== 0 || bi === 0) continue;
        var cells = [{ c: vt.c, r: vt.r, tipo: 'nucleo', dx: 0, dy: 0 }];
        var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (var d = 0; d < 4; d++) {
            var c = vt.c + dirs[d][0], r = vt.r + dirs[d][1];
            var ch = em(c, r);
            if (ch === '#' || ch === '%') continue;
            cells.push({ c: c, r: r, tipo: 'ponta', dx: dirs[d][0], dy: dirs[d][1] });
        }
        for (var j = 0; j < cells.length; j++) {
            st.flames.push({ c: cells[j].c, r: cells[j].r, tipo: cells[j].tipo,
                             de: b, ate: b + VENT_BEATS, dx: cells[j].dx, dy: cells[j].dy,
                             ambiente: true, dono: 'x' });
        }
        st.onFx('vento', vt);
    }
    if (fase === 0 && bi > 0) st.onSfx('vento');
}

// Nucleo: pares de teleporte. Entrar no pad leva ao par; religa so depois
// de sair do pad de chegada (sem ping-pong)
function teleporte(cel) {
    if (!st.teles.length) return;
    var noPad = -1;
    for (var i = 0; i < st.teles.length; i++) {
        if (st.teles[i].c === cel.c && st.teles[i].r === cel.r) { noPad = i; break; }
    }
    if (st.teleAte) {
        if (noPad < 0) st.teleAte = 0;
        return;
    }
    if (noPad < 0) return;
    var dest = st.teles[noPad ^ 1];
    if (!dest || bloqueado(dest.c, dest.r)) return;
    st.onFx('tele', st.teles[noPad], dest);
    st.player.x = centerOf(dest.c);
    st.player.y = centerOf(dest.r);
    st.dir = { dx: 0, dy: 0 };
    st.teleAte = 1;
    st.onSfx('tele');
}

// bomba chutada: desliza celula a celula ate a proxima ocupada (bloco,
// bomba, bicho ou o jogador)
function desliza(bo, dt) {
    var passos = 8 * dt;   // 8 celulas/s
    var nx = bo.fx + bo.desliza.dx * passos;
    var ny = bo.fy + bo.desliza.dy * passos;
    var ac = Math.floor(nx + 0.5 + bo.desliza.dx * 0.51);
    var ar = Math.floor(ny + 0.5 + bo.desliza.dy * 0.51);
    // a marca 'B' da PROPRIA bomba (o centro ja arredondou p/ a celula da
    // frente) nao e obstaculo — antes todo chute parava na 1a celula
    var proprio = ac === Math.round(bo.fx) && ar === Math.round(bo.fy);
    var ocupada = (em(ac, ar) !== '.' && !proprio) ||
                  (!proprio && st._ocupadoPorBicho && st._ocupadoPorBicho(ac, ar));
    if (ocupada) {
        // bateu: assenta na celula atual do centro
        setG(Math.round(bo.fx), Math.round(bo.fy), '.');
        bo.fx = Math.round(bo.fx); bo.fy = Math.round(bo.fy);
        bo.desliza = null;
        setG(bo.fx, bo.fy, 'B');
        return;
    }
    // arrasta a marca 'B' junto (corrente/visual miram a celula do centro)
    setG(Math.round(bo.fx), Math.round(bo.fy), '.');
    bo.fx = nx; bo.fy = ny;
    setG(Math.round(bo.fx), Math.round(bo.fy), 'B');
}

function explodir(bo) {
    // tira da lista antes (a corrente pode reentrar)
    for (var i = 0; i < st.bombs.length; i++) {
        if (st.bombs[i] === bo) { st.bombs.splice(i, 1); break; }
    }
    var bc = Math.round(bo.fx), br = Math.round(bo.fy);
    if (st.grid[br] && st.grid[br][bc] === 'B') setG(bc, br, '.');
    var b = beatNow();
    var ate = b + FLAME_BEATS;
    var doJogador = bo.dono === 'p';
    var cells = [{ c: bc, r: br, tipo: 'nucleo' }];
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var d = 0; d < 4; d++) {
        for (var passos = 1; passos <= bo.range; passos++) {
            var c = bc + dirs[d][0] * passos;
            var r = br + dirs[d][1] * passos;
            var ch = em(c, r);
            if (ch === '#') break;
            if (ch === '%') {
                destruirMacio(c, r, doJogador);
                if (!bo.pierce) break;   // perfurante: a chama segue
                cells.push({ c: c, r: r, tipo: passos === bo.range ? 'ponta' : 'braco',
                             dx: dirs[d][0], dy: dirs[d][1] });
                continue;
            }
            // bomba no caminho: dominó de meia batida
            if (ch === 'B') {
                for (var k = 0; k < st.bombs.length; k++) {
                    var outra = st.bombs[k];
                    if (Math.round(outra.fx) === c && Math.round(outra.fy) === r) {
                        outra.vai = Math.min(outra.vai, b + CHAIN_BEATS);
                    }
                }
                break;
            }
            cells.push({ c: c, r: r, tipo: passos === bo.range ? 'ponta' : 'braco',
                         dx: dirs[d][0], dy: dirs[d][1] });
        }
    }
    for (var j = 0; j < cells.length; j++) {
        st.flames.push({ c: cells[j].c, r: cells[j].r, tipo: cells[j].tipo,
                         de: b, ate: ate, dx: cells[j].dx || 0, dy: cells[j].dy || 0,
                         dono: bo.dono });
    }
    // COMBO: explosao do JOGADOR que cai NO TEMPO FORTE (batida inteira)
    // encadeia o multiplicador — plantar no compasso vale pontos (as bombas
    // do chefe nao contam)
    if (doJogador) {
        var frac = b - Math.floor(b);
        if (frac < 0.2 || frac > 0.85) {
            st.combo++;
            st.comboAte = b + 16;
            st.mult = Math.min(5, 1 + st.combo);
            if (st.combo >= 2) st.onFx('combo', { c: bc, r: br, mult: st.mult });
        }
    }
    st.onFx('bum', { c: bc, r: br }, cells);
    st.onSfx('bum', cells.length);
}

function destruirMacio(c, r, doJogador) {
    setG(c, r, '.');
    if (doJogador !== false) st.score += 10 * st.mult;
    var key = c + ',' + r;
    if (c === st.exit.c && r === st.exit.r) st.exit.achada = true;
    st.onFx('macio', { c: c, r: r }, st.powerups[key] || null);
}

function ferir() {
    if (st.stats.inv > 0 || st.fim || st.intro > 0) return;
    st.combo = 0; st.mult = 1;   // levou dano: combo vai por agua abaixo
    if (st.stats.shield) {
        st.stats.shield = false;
        st.stats.inv = 2;
        st.onSfx('escudo');
        st.onFx('escudo', st.player);
        return;
    }
    matar('dead');
}

function matar(motivo) {
    if (st.fim) return;
    st.stats.vidas--;
    st.onSfx('morte');
    st.onFx('morte', st.player);
    // duelo: uma vida so — a labareda encerra o round (o rival decide a
    // dele com o proprio relogio e avisa; empate = os dois avisam)
    if (st.duelo || st.stats.vidas < 0) {
        st.fim = motivo;
        st.onFim(st.fim);
    } else {
        // respawn no canto com folga (perde o patins extra, como no classico)
        st.stats.inv = 2.5;
        st.stats.vel = Math.max(1, st.stats.vel - 1);
        st.player.x = centerOf(1); st.player.y = centerOf(1);
        st.player.vx = 0; st.player.vy = 0;
        st.dir = { dx: 0, dy: 0 };
        if (em(1, 1) === 'B' && !passaPor(1, 1)) st.passa.push({ c: 1, r: 1 });
        if (motivo === 'tempo') st.tLeft = 60;
        else st.tLeft = Math.max(st.tLeft, 30);
        st.onFx('respawn', st.player);
    }
}

function vencer() {
    if (st.fim) return;
    st.fim = 'win';
    st.bonusTempo = Math.floor(st.tLeft) * 10 * st.mult;
    st.score += st.bonusTempo + 100;
    st.onSfx('vitoria');
    st.onFim('win');
}

function pegar(kind) {
    var s = st.stats;
    if (kind === 'B') s.bombs = Math.min(s.bombs + 1, 6);
    else if (kind === 'C') s.flame = Math.min(s.flame + 1, 8);
    else if (kind === 'V') s.vel = Math.min(s.vel + 1, 4);
    else if (kind === 'K') s.kick = true;
    else if (kind === 'R') s.remote = true;
    else if (kind === 'E') s.shield = true;
    else if (kind === 'X') s.vidas = Math.min(s.vidas + 1, 5);
    else if (kind === 'P') s.pierce = true;
    else if (kind === 'T') { if (!st.sobrevivencia) st.tLeft += 30; else st.score += 200; }
    st.score += 50 * st.mult;
    st.onSfx(kind === 'X' ? 'vida' : 'power');
    st.onFx('power', kind);
}

// gancho dos inimigos (ia.js instala; chamado por update)
function setIA(fn) { st._ia = fn; }

function ferirInimigosNa(c, r, dono) {
    if (!st._ferirNa) return;
    st._ferirNa(c, r, dono);
}

// contato com inimigo (ia chama)
function tocarPlayer() { ferir(); }

// celulas que vao pegar fogo em breve (bombas com pavio < janela, em
// batidas) + as labaredas vivas: a IA esperta foge delas
function perigo(janela) {
    var b = beatNow(), out = {};
    for (var i = 0; i < st.flames.length; i++) out[st.flames[i].c + ',' + st.flames[i].r] = 1;
    for (var k = 0; k < st.bombs.length; k++) {
        var bo = st.bombs[k];
        if (bo.vai - b > janela) continue;
        var bc = Math.round(bo.fx), br = Math.round(bo.fy);
        out[bc + ',' + br] = 1;
        var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (var d = 0; d < 4; d++) {
            for (var p = 1; p <= bo.range; p++) {
                var c = bc + dirs[d][0] * p, r = br + dirs[d][1] * p;
                var ch = em(c, r);
                if (ch === '#') break;
                out[c + ',' + r] = 1;
                if (ch === '%' || ch === 'B') break;
            }
        }
    }
    return out;
}

// ------------------------------------------------------------- duelo ------

// o rival caminha para a ultima celula recebida ('dp'): interpolado a ~5
// celulas/s; longe demais (msgs perdidas) teleporta — posicao e do dono
function andaRival(dt) {
    var rv = st.rival;
    if (!rv || rv.morto) return;
    var tx = (rv.tc + 0.5) * st.cell, ty = (rv.tr + 0.5) * st.cell;
    var dx = tx - rv.x, dy = ty - rv.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > st.cell * 2.3) { rv.x = tx; rv.y = ty; return; }
    var passo = 5.0 * st.cell * dt;
    if (dist <= passo) { rv.x = tx; rv.y = ty; }
    else { rv.x += dx / dist * passo; rv.y += dy / dist * passo; }
}

// 'dp': o rival informou estar na celula (c,r)
function rivalAlvo(c, r) {
    if (!st || !st.rival) return;
    st.rival.tc = c;
    st.rival.tr = r;
}

// 'dm': o rival morreu no aparelho DELE (autoridade do proprio corpo) —
// round nosso. Empate: o nosso 'dead' ja fechou st.fim antes
function rivalMorreu() {
    if (!st || !st.duelo || st.fim) return false;
    if (st.rival) st.rival.morto = true;
    st.fim = 'rwin';
    st.onSfx('vitoria');
    st.onFim('rwin');
    return true;
}

// 'dg': o rival pegou o powerup da celula — some no meu mundo tambem
function pegarRival(c, r) {
    if (!st) return;
    var key = c + ',' + r;
    if (st.powerups[key]) {
        delete st.powerups[key];
        st.mudou.push(c, r);
    }
}

module.exports = {
    COLS: COLS, ROWS: ROWS,
    iniciar: iniciar, layout: layout, parar: parar, state: state,
    update: update, mover: mover, plantar: plantar, detonar: detonar,
    addBomba: addBomba, chutar: chutar, tocarPlayer: tocarPlayer,
    rivalAlvo: rivalAlvo, rivalMorreu: rivalMorreu, pegarRival: pegarRival,
    beatNow: beatNow, beatLen: beatLen, celulaPlayer: celulaPlayer,
    em: em, setIA: setIA, perigo: perigo, bloqueado: bloqueado
};
