// mundo.js — a fisica de jogo do Arrasa! sobre o corpo rigido NATIVO
// (celeros.physics P.rigid -> System.rigid*, API 33). Tudo em UNIDADES DO
// MUNDO (320 de largura, chao em y=290): a vista so escala.
//
// 1.3.0: cada corpo do solver ganha um corpo espelho no E.combat (time
// "mundo") e cada lance cria um E.combat.shot que acompanha o projetil
// fisico — o shot e a HITBOX (onWall/onHit) usada pelo knockback e pelos
// efeitos, enquanto o solver continua dono do movimento, do giro e do
// empilhamento. A explosao tambem registra um E.combat.blast. Os goblins e
// o rei vagueiam com E.steer.agent (wander/within) entre os turnos, quando
// a pilha ja assentou: o solver nao muda.
//
//   pecas    — caixas que giram e empilham (madeira, gelo, pedra, TNT) e
//              plataformas de rocha fixas; goblins sao circulos
//   dano     — o solver devolve por corpo o maior impulso de impacto do
//              quadro (hit); dano = (hit/massa - limiar), ou seja, a
//              variacao de velocidade que a pancada impos. Peca leve
//              apanha mais da mesma pancada; queda de altura tambem quebra
//   tiros    — o projetil so entra no mundo no lancamento (no estilingue
//              ele e desenho: nada colide com o garfo). pedra, pedrao
//              (pesado), tripla (toque: racha em 3), bomba (toque, ou
//              1,5 s depois de bater: explode), flecha (toque: dispara
//              em linha reta), bumerangue (toque: volta num arco) e
//              chocadeira (toque: solta um ovo-bomba e sobe)
//   turno    — voando -> assentando (tudo dormindo ou 3 s) -> proximo
//              tiro, vitoria (sem goblins) ou derrota (sem tiros)
//
// O mundo nao desenha nem toca som: step() devolve EVENTOS que o main.js
// traduz em particulas, pontos e efeitos.
//
// Estado do quadro: M.s e o array do P.rigid (6 numeros por indice, o
// MESMO array reaproveitado a cada state()). Os lacos por corpo leem por
// INDICE (s[i * NS + campo]) — w.x(i, s) e cia. sao chamadas de funcao, e
// no Duktape uma chamada custa mais que o resto do corpo do laco.

var P = require("celeros.physics");
var E = require("celeros.game");
require("celeros.game.combat");       // E.combat.shot/blast/knock
require("celeros.game.steer");        // E.steer.agent (goblins)
var NIV = require("niveis");

// campos do estado por corpo (P.rigid: [x, y, ang, hit, rapidez, flags])
var NS = 6, SX = 0, SY = 1, SA = 2, SHIT = 3, SVEL = 4, SFL = 5;

var MW = 320;
var GROUND = NIV.GROUND;
var GRAV = 400;                          // u/s^2
var BERCO = { x: 51.3, y: 239 };         // pedra armada (entre os garfos)
var GARFO = [{ x: 38.0, y: 234.7 }, { x: 64.0, y: 234.7 }];
var PUXAO_MAX = 42;                      // raio maximo do puxao
var K_LANCE = 9.2;                       // v = puxao * K (max ~386 u/s)
var CARENCIA = 1.0;                      // s sem dano: a pilha assenta
var LIMIAR = { bloco: 55, goblin: 32 };  // dv minimo que machuca (u/s)

// mapa do E.combat.shot: o solver ja colide o projetil de verdade; aqui o
// "solido" e o chao (o shot morre ao encostar nele, como o projetil fisico
// perde o voo). As pecas ficam fora para o shot espelho nao morrer antes de
// o solver resolver o impacto.
var MAPA = { solidAt: function (x, y) { return y > GROUND; } };
// area de passeio dos goblins entre os turnos (dentro da fortaleza)
var AREA_GOB = { x: 165, y: GROUND - 150, w: MW - 165, h: 150 };

var MAT = {
    madeira: { dens: 0.6, atrito: 0.75, quique: 0.05, hp: 150, pts: 100 },
    vidro:   { dens: 0.45, atrito: 0.3, quique: 0.05, hp: 70, pts: 80 },
    pedra:   { dens: 1.8, atrito: 0.85, quique: 0.02, hp: 380, pts: 150 },
    tnt:     { dens: 0.6, atrito: 0.7, quique: 0.05, hp: 18, pts: 200 },
    rocha:   { estatico: true, atrito: 0.9, quique: 0 },
    goblin:  { dens: 0.5, atrito: 0.6, quique: 0.25, hp: 45, pts: 500 },
    rei:     { dens: 0.5, atrito: 0.6, quique: 0.25, hp: 120, pts: 1500 }
};

var TIRO = {
    pedra:  { r: 6.5, dens: 2.2, atrito: 0.6, quique: 0.25 },
    pedrao: { r: 9, dens: 3.0, atrito: 0.7, quique: 0.15 },
    tripla: { r: 5.5, dens: 2.2, atrito: 0.5, quique: 0.3 },
    bomba:  { r: 6.5, dens: 2.0, atrito: 0.6, quique: 0.2 },
    flecha: { r: 6, dens: 2.6, atrito: 0.4, quique: 0.2 },
    bumerangue: { r: 6.5, dens: 2.2, atrito: 0.6, quique: 0.25 },
    chocadeira: { r: 7, dens: 1.8, atrito: 0.6, quique: 0.25 },
    ovo:    { r: 5, dens: 4.0, atrito: 0.6, quique: 0 }     // o que a chocadeira solta
};

var M = {
    w: null,                 // mundo rigido (P.rigid)
    s: null,                 // estado do ultimo step (array plano)
    corpos: [],              // indice -> descritor do corpo (ou null)
    fase: 0,
    tiros: [],               // fila dos que faltam (nao inclui o da vez)
    tiro: null,              // { tipo, estado, idx, extras, t, ... }
    pull: { x: 0, y: 0 },    // puxao atual (relativo ao BERCO)
    goblins: 0,
    t: 0,                    // tempo da fase (s)
    pontos: 0,
    calmo: 0,                // s com tudo parado (assentando)
    rastro: [],              // pontos do ultimo voo [x, y, ...]
    rastroNovo: [],
    venceu: false,
    acabou: false,
    sem: false,              // firmware sem corpo rigido (API 33)
    interagiu: false,        // ja houve lance (bateria/telemetria)
    lances: 0,               // lancamentos da fase (passeio so apos o 2o)
    shot: null               // E.combat.shot espelho do projetil da vez
};

function massa(c) {
    var m = MAT[c.mat] || TIRO[c.tipo];
    var d = m && m.dens ? m.dens : 1;
    return c.r ? d * 3.14159265 * c.r * c.r : d * c.w * c.h;
}

// --------------------------------------------------------- E.combat -------
// Corpo espelho: o solver e o dono do movimento; o E.combat so enxerga uma
// caixa (AABB) para as hitboxes/projeteis. hp alto porque quem calcula dano
// e o solver (o blast usa onHit, que so dispara com dano > 0).
function ligaCombat(c) {
    var e = { x: 0, y: 0, w: 12, h: 12, hp: 1e9, _c: c };
    if (c.k === "goblin") { e.w = c.r * 2; e.h = c.r * 2; }
    else { e.w = c.w; e.h = c.h; }
    c.ent = e;
    E.combat.body(e, { team: "mundo", knockRes: 1, iframes: 0 });
}

// estado do solver -> caixas dos espelhos (chamado depois de cada state()).
// O array s e o mesmo do quadro; nada e alocado por corpo.
function atualizaCombat(s) {
    var n = M.w ? M.w.count() : 0;
    for (var i = 0; i < n; i++) {
        var c = M.corpos[i];
        if (!c || !c.ent) continue;
        var o = i * NS;
        if (!(s[o + SFL] & 1)) { c.ent.dead = true; continue; }
        if (c.k === "goblin") {
            c.ent.x = s[o + SX] - c.r;
            c.ent.y = s[o + SY] - c.r;
        } else {
            c.ent.x = s[o + SX] - c.w / 2;
            c.ent.y = s[o + SY] - c.h / 2;
        }
    }
}

function addCorpo(c) {
    var w = M.w, m = MAT[c.mat], i;
    if (c.k === "box") {
        i = w.box(c.x, c.y, c.w, c.h, { angle: c.a || 0, static: !!m.estatico,
                  density: m.dens, friction: m.atrito, bounce: m.quique });
    } else {
        i = w.circle(c.x, c.y, c.r, { density: m.dens, friction: m.atrito, bounce: m.quique });
    }
    if (i < 0) return -1;
    c.i = i;
    c.hp = m.hp || 0;
    c.hp0 = c.hp;
    c.pts = m.pts || 0;
    c.m = massa(c);
    c.fixo = !!m.estatico;
    c.rachas = null;         // desenho: rachaduras sorteadas no 1o dano
    c.semente = (i * 7919 + M.fase * 104729) % 9973;
    M.corpos[i] = c;
    ligaCombat(c);
    return i;
}

// ------------------------------------------------------------- fase -------
M.carregar = function (n) {
    if (M.w) M.w.free();
    E.combat.clear();        // corpos/hitboxes/tiros da fase anterior
    M.w = P.rigid({ iterations: 10 });
    M.sem = !M.w;
    M.fase = n;
    M.shot = null;
    M.interagiu = false;
    M.lances = 0;
    M.corpos = [];
    M.goblins = 0;
    M.t = 0;
    M.pontos = 0;
    M.calmo = 0;
    M.rastro = [];
    M.rastroNovo = [];
    M.venceu = false;
    M.acabou = false;
    M.tiro = null;
    if (M.sem) return false;
    // chao largo (debris pode sair pelos lados e cair fora do mundo)
    var chao = M.w.box(MW / 2, GROUND + 60, MW * 4, 120, { static: true, friction: 0.9, bounce: 0 });
    M.corpos[chao] = { k: "chao", i: chao, fixo: true };
    var pecas = NIV.montar(n);
    for (var p = 0; p < pecas.length; p++) {
        var c = pecas[p];
        if (c.k === "goblin") { c.mat = c.tipo; M.goblins++; }
        addCorpo(c);
    }
    M.tiros = NIV.fase(n).tiros.slice();
    M.proximoTiro();
    M.s = M.w.state();
    return true;
};

// arma o proximo tiro da fila (estado "carregando": o main anima o pulo)
M.proximoTiro = function () {
    if (!M.tiros.length) { M.tiro = null; return false; }
    M.tiro = { tipo: M.tiros.shift(), estado: "carregando", idx: -1, extras: [],
               t: 0, bateu: -1, usado: false, parado: 0 };
    M.pull.x = 0; M.pull.y = 0;
    return true;
};

// ------------------------------------------------------------- mira -------
M.pedraNoBerco = function () {
    return { x: BERCO.x + M.pull.x, y: BERCO.y + M.pull.y };
};

M.pegar = function (x, y) {
    var t = M.tiro;
    if (!t || t.estado !== "pronto") return false;
    var dx = x - BERCO.x, dy = y - BERCO.y;
    if (dx * dx + dy * dy > 34 * 34) return false;   // dedo folgado: o alvo e pequeno
    t.estado = "mirando";
    M.arrastar(x, y);
    return true;
};

M.arrastar = function (x, y) {
    if (!M.tiro || M.tiro.estado !== "mirando") return;
    var dx = x - BERCO.x, dy = y - BERCO.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d > PUXAO_MAX) { dx *= PUXAO_MAX / d; dy *= PUXAO_MAX / d; }
    // a pedra nao entra no chao
    if (BERCO.y + dy > GROUND - TIRO[M.tiro.tipo].r) dy = GROUND - TIRO[M.tiro.tipo].r - BERCO.y;
    M.pull.x = dx; M.pull.y = dy;
};

M.forca = function () {
    return Math.sqrt(M.pull.x * M.pull.x + M.pull.y * M.pull.y) / PUXAO_MAX;
};

M.velLance = function () { return { vx: -M.pull.x * K_LANCE, vy: -M.pull.y * K_LANCE }; };

// solta: puxao curto desarma (a pedra volta), senao lanca
M.soltar = function () {
    var t = M.tiro;
    if (!t || t.estado !== "mirando") return null;
    if (M.forca() < 0.2) {
        t.estado = "pronto";
        M.pull.x = 0; M.pull.y = 0;
        return null;
    }
    return M.lancar(M.velLance());
};

M.lancar = function (v) {
    var t = M.tiro, def = TIRO[t.tipo];
    var p = M.pedraNoBerco();
    var i = M.w.circle(p.x, p.y, def.r, { density: def.dens, friction: def.atrito, bounce: def.quique });
    if (i < 0) return null;
    M.w.set(i, p.x, p.y, 0, v.vx, v.vy, 0);
    M.corpos[i] = { k: "tiro", i: i, tipo: t.tipo, r: def.r, tiro: true };
    M.corpos[i].m = massa(M.corpos[i]);
    t.idx = i;
    t.estado = "voando";
    t.t = 0;
    M.pull.x = 0; M.pull.y = 0;
    M.rastroNovo = [p.x, p.y];
    M.interagiu = true;
    M.lances++;
    // hitbox do projetil: acompanha o corpo fisico (sync no step). O solver
    // resolve a colisao/pancada; o shot da o onWall/onHit e o Knockback.
    var sh = E.combat.shot(null, {
        x: p.x, y: p.y, vx: v.vx, vy: v.vy, r: def.r,
        dmg: 0, knock: 0, life: 120000, team: "tiro", pierce: true,
        map: MAPA,
        onWall: function (s) { t.parede = true; },
        onHit: function (ent, s) {
            var dv = Math.sqrt(s.vx * s.vx + s.vy * s.vy) || 1;
            var k = dv > 220 ? 220 : dv;
            E.combat.knock(ent, s.vx / dv * k, s.vy / dv * k, 180);
            var c = ent._c;
            if (!c || c.fixo || c.morto || !c.m) return;
            // o impulso extra e so tempero: o pancadao e o do solver
            if (!M.w.awake(c.i, M.s)) return;
            M.w.impulse(c.i, s.vx / dv * 24 * c.m, s.vy / dv * 24 * c.m);
        }
    });
    sh.tipo = t.tipo;
    sh.ang = 0;
    sh.estado = "voando";
    M.corpos[i].shot = sh;
    t.shot = sh;
    M.shot = sh;
    return { t: "lancou", x: p.x, y: p.y, tipo: t.tipo };
};

// trajetoria prevista (ajuda de mira): n pontos a cada dt
M.previsao = function (n, dt) {
    var p = M.pedraNoBerco(), v = M.velLance(), out = [];
    for (var k = 1; k <= n; k++) {
        var tt = k * dt;
        out.push(p.x + v.vx * tt, p.y + v.vy * tt + GRAV * tt * tt / 2);
    }
    return out;
};

function novoTiro(tipo, x, y, vx, vy) {
    var def = TIRO[tipo];
    var j = M.w.circle(x, y, def.r, { density: def.dens, friction: def.atrito, bounce: def.quique });
    if (j < 0) return -1;
    M.w.set(j, x, y, 0, vx, vy, 0);
    M.corpos[j] = { k: "tiro", i: j, tipo: tipo, r: def.r, tiro: true, nasceu: M.t };
    M.corpos[j].m = massa(M.corpos[j]);
    return j;
}

// toque no ar: a habilidade do tiro (tripla racha, bomba explode, flecha
// dispara, bumerangue volta, chocadeira bota o ovo-bomba)
M.habilidade = function (ev) {
    var t = M.tiro;
    if (!t || t.estado !== "voando" || t.usado) return false;
    var s = M.s, i = t.idx;
    if (t.tipo === "tripla") {
        if (t.bateu >= 0) return false;              // so no ar
        t.usado = true;
        var x = M.w.x(i, s), y = M.w.y(i, s);
        // o estado nao traz a velocidade: o step guarda a do quadro em t.v
        var vx = t.v ? t.v.x : 200, vy = t.v ? t.v.y : 0;
        var sp = Math.sqrt(vx * vx + vy * vy), ang = Math.atan2(vy, vx);
        for (var k = -1; k <= 1; k += 2) {
            var a = ang + k * 0.22;
            var j = novoTiro("tripla", x + Math.cos(a + k * 1.2) * 7, y + Math.sin(a + k * 1.2) * 7,
                             Math.cos(a) * sp * 1.05, Math.sin(a) * sp * 1.05);
            if (j >= 0) t.extras.push(j);
        }
        if (ev) ev.push({ t: "racha", x: x, y: y });
        return true;
    }
    if (t.tipo === "flecha" || t.tipo === "bumerangue" || t.tipo === "chocadeira") {
        if (t.bateu >= 0 || !t.v) return false;      // so no ar
        t.usado = true;
        var fx = M.w.x(i, s), fy = M.w.y(i, s), fa = M.w.angle(i, s);
        var fvx = t.v.x, fvy = t.v.y;
        if (t.tipo === "flecha") {
            // disparo reto: 2,4x na direcao atual (a gravidade volta depois)
            var fsp = Math.sqrt(fvx * fvx + fvy * fvy) || 1;
            var nsp = Math.max(fsp * 2.4, 520);
            M.w.set(i, fx, fy, fa, fvx / fsp * nsp, fvy / fsp * nsp, 0);
            if (ev) ev.push({ t: "dispara", x: fx, y: fy, vx: fvx / fsp, vy: fvy / fsp });
        } else if (t.tipo === "bumerangue") {
            // volta: inverte e acelera o x, joga para cima num arco
            M.w.set(i, fx, fy, fa, -fvx * 1.35 - 60, Math.min(fvy, 0) - 170, -12);
            if (ev) ev.push({ t: "volta", x: fx, y: fy });
        } else {
            // chocadeira: o ovo-bomba cai reto e pesado; ela sobe aliviada
            var o = novoTiro("ovo", fx, fy + 9, fvx * 0.2, 380);
            if (o >= 0) { M.corpos[o].ovo = true; t.extras.push(o); }
            M.w.set(i, fx, fy - 2, fa, fvx * 1.15, -300, 0);
            if (ev) ev.push({ t: "bota", x: fx, y: fy });
        }
        return true;
    }
    if (t.tipo === "bomba") {
        t.usado = true;
        var bx = M.w.x(i, s), by = M.w.y(i, s);
        M.remover(i, ev, true);
        t.idx = -1;
        M.explodir(bx, by, 62, 300, ev);
        return true;
    }
    return false;
};

// ----------------------------------------------------------- explosao -----
M.explodir = function (x, y, R, dvMax, ev) {
    var s = M.s = M.w.state();
    atualizaCombat(s);
    if (ev) ev.push({ t: "boom", x: x, y: y, r: R });
    // hitbox de combate: o dano/impulso de verdade e o laco do solver
    // abaixo; o blast registra a area e devolve o knockback nos espelhos
    E.combat.blast(x, y, R, {
        team: "*", dmg: 0.01, knock: 0, ms: 1, stop: 0,
        onHit: function (ent, hb) {
            var ex = ent.x + (ent.w || 0) / 2 - x;
            var ey = ent.y + (ent.h || 0) / 2 - y;
            var d = Math.sqrt(ex * ex + ey * ey) || 1;
            var f = d < R ? 1 - d / R : 0;
            if (f > 0) E.combat.knock(ent, ex / d * 200 * f, (ey / d - 0.35) * 200 * f, 220);
        }
    });
    for (var i = 0; i < M.corpos.length; i++) {
        var c = M.corpos[i], o = i * NS;
        if (!c || c.fixo || c.k === "chao" || !(s[o + SFL] & 1)) continue;
        var dx = s[o + SX] - x, dy = s[o + SY] - y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d >= R) continue;
        var f = 1 - d / R;
        var nx = d > 0.01 ? dx / d : 0, ny = d > 0.01 ? dy / d : -1;
        var dv = dvMax * f;
        M.w.impulse(i, nx * dv * c.m, (ny - 0.35) * dv * c.m);
        if (c.hp0) M.ferir(c, dv * 1.1, ev);
    }
};

// ------------------------------------------------------------- dano -------
M.ferir = function (c, dano, ev) {
    if (!c.hp0 || c.morto) return;
    c.hp -= dano;
    if (c.hp > 0) return;
    c.morto = true;   // a remocao acontece no fim do step (TNT encadeia)
};

M.remover = function (i, ev, semPontos) {
    var c = M.corpos[i];
    if (!c) return;
    if (c.ent) c.ent.dead = true;               // espelho do E.combat
    if (c.shot && !c.shot.dead) c.shot.dead = true;
    var s = M.s;
    var x = M.w.x(i, s), y = M.w.y(i, s), a = M.w.angle(i, s);
    M.w.remove(i);
    M.corpos[i] = null;
    if (!ev) return;
    var pts = semPontos ? 0 : (c.pts || 0);
    M.pontos += pts;
    if (c.k === "goblin") {
        M.goblins--;
        ev.push({ t: "goblin", x: x, y: y, pts: pts, rei: c.tipo === "rei", c: c });
    } else if (c.k === "tiro") {
        ev.push({ t: "poof", x: x, y: y, c: c });
    } else {
        ev.push({ t: "quebra", x: x, y: y, a: a, mat: c.mat, pts: pts, c: c });
    }
};

function fora(x, y) { return x < -50 || x > MW + 50 || y > GROUND + 70; }

// -------------------------------------------------------------- passeio ---
// Goblins/rei vagam entre os turnos (E.steer wander + within): o agente
// so decide a direcao; o impulso horizontal entra no solver, que continua
// dono da posicao. So roda com a pilha assentada e um tiro ja armado —
// durante o voo/quebra nada se mexe (a mira e a queda continuam previsiveis).
function vagueia(dt, s) {
    var t = M.tiro;
    // so depois do 2o lance: o primeiro tiro nao poe a fortaleza em
    // movimento (a queda/mira do primeiro turno continua previsivel e a
    // bateria do app nao ve goblin passeando antes da hora)
    if (M.lances < 2 || !t || (t.estado !== "pronto" && t.estado !== "carregando")) return;
    if (M.calmo < 0.5) return;
    var n = M.w ? M.w.count() : 0;
    for (var i = 0; i < n; i++) {
        var c = M.corpos[i];
        if (!c || c.k !== "goblin" || c.morto) continue;
        var o = i * NS;
        if (!(s[o + SFL] & 1)) continue;
        if (!c.ag) c.ag = E.steer.agent(c, { speed: 14, force: 36, agility: 5 });
        // o agente integra x/y no descritor; a posicao real vem do solver
        c.x = s[o + SX];
        c.y = s[o + SY];
        c.ag.wander(1, { dist: 7, r: 9, jitter: 1.2 });
        c.ag.within(AREA_GOB, 12, 2);
        c.ag.update(dt);
        if (c.ag.obj.vx) M.w.impulse(i, c.m * c.ag.obj.vx * dt * 4, 0);
    }
}

// ------------------------------------------------------------- step -------
M.step = function (dt) {
    var ev = [];
    if (!M.w) return ev;
    if (dt > 0.05) dt = 0.05;
    M.t += dt;
    var t = M.tiro;
    if (t && t.estado === "carregando") {
        t.t += dt;
        if (t.t >= 0.35) { t.estado = "pronto"; t.t = 0; }
    }
    M.w.step(dt, { gravity: { x: 0, y: GRAV }, maxSub: 12 });
    var s = M.s = M.w.state();
    atualizaCombat(s);
    var n = M.w.count(), i, c, o;

    // dano por impacto (fora da carencia de montagem)
    for (i = 0; i < n; i++) {
        c = M.corpos[i];
        o = i * NS;
        if (!c || !(s[o + SFL] & 1)) continue;
        var x = s[o + SX], y = s[o + SY];
        if (fora(x, y)) {
            c.morto = c.k !== "chao";
            c.caiu = true;
            continue;
        }
        if (!c.hp0 || M.t < CARENCIA) continue;
        var hit = s[o + SHIT];
        if (hit <= 0) continue;
        var dv = hit / c.m;
        var lim = c.k === "goblin" ? LIMIAR.goblin : LIMIAR.bloco;
        if (dv > lim) {
            M.ferir(c, dv - lim, ev);
            if (dv > lim * 2.2) ev.push({ t: "pancada", x: x, y: y, dv: dv, mat: c.mat });
        }
    }

    // projetil: primeiro impacto, velocidade (p/ a tripla) e fim do voo
    if (t && t.estado === "voando") {
        t.t += dt;
        var vivos = 0, ativos = 0;
        // o tiro (k = -1) e os extras (tripla/ovo), sem montar lista por quadro
        for (var k = -1; k < t.extras.length; k++) {
            var j = k < 0 ? t.idx : t.extras[k];
            if (j < 0) continue;
            var oj = j * NS;
            if (!M.corpos[j] || !(s[oj + SFL] & 1)) continue;
            vivos++;
            var tx = s[oj + SX], ty = s[oj + SY];
            if (j === t.idx) {
                if (t.px !== undefined && dt > 0) {
                    if (!t.v) t.v = { x: 0, y: 0 };
                    t.v.x = (tx - t.px) / dt; t.v.y = (ty - t.py) / dt;
                }
                t.px = tx; t.py = ty;
                // o shot espelho acompanha o corpo fisico (o combate roda
                // antes do update da cena: este sync vale para o proximo)
                if (t.shot && !t.shot.dead) {
                    t.shot.x = tx; t.shot.y = ty;
                    t.shot.vx = t.v ? t.v.x : 0;
                    t.shot.vy = t.v ? t.v.y : 0;
                    t.shot.ang = s[oj + SA];
                }
                if (t.bateu < 0 && s[oj + SHIT] > 0 && t.t > 0.05) {
                    t.bateu = t.t;
                    ev.push({ t: "impacto", x: tx, y: ty, forca: s[oj + SHIT] / M.corpos[j].m });
                }
                // rastro do voo (ate o primeiro impacto)
                if (t.bateu < 0) {
                    var L = M.rastroNovo.length;
                    var lx = M.rastroNovo[L - 2], ly = M.rastroNovo[L - 1];
                    if ((tx - lx) * (tx - lx) + (ty - ly) * (ty - ly) > 81) M.rastroNovo.push(tx, ty);
                }
            }
            if (fora(tx, ty)) { M.corpos[j].morto = true; continue; }
            // ovo da chocadeira explode na primeira pancada
            var cj = M.corpos[j];
            if (cj.ovo && M.t - cj.nasceu > 0.05 && s[oj + SHIT] > 0) {
                M.remover(j, ev, true);
                M.explodir(tx, ty, 46, 300, ev);
                continue;
            }
            if (s[oj + SVEL] > 9) ativos++;
        }
        // bomba sem toque explode sozinha 1,5 s depois da primeira pancada
        if (t.tipo === "bomba" && !t.usado && t.bateu >= 0 && t.t - t.bateu > 1.5) M.habilidade(ev);
        if (vivos === 0 || ativos === 0) t.parado += dt;
        else t.parado = 0;
        if (vivos === 0 || t.parado > 0.8 || t.t > 9) {
            t.estado = "assentando";
            t.t = 0;
            ev.push({ t: "fimvoo" });
            M.calmo = 0;
            M.rastro = M.rastroNovo;
            M.rastroNovo = [];
            // projetil gasto sai com um "puf" (como no classico)
            for (k = -1; k < t.extras.length; k++) {
                j = k < 0 ? t.idx : t.extras[k];
                if (j >= 0 && M.corpos[j]) M.corpos[j].morto = true;
            }
        }
    }

    // mortos saem (TNT explode e pode matar mais: ate estabilizar)
    for (var volta = 0; volta < 4; volta++) {
        var algum = false;
        for (i = 0; i < M.corpos.length; i++) {
            c = M.corpos[i];
            if (!c || !c.morto) continue;
            algum = true;
            var ex = s[i * NS + SX], ey = s[i * NS + SY];
            M.remover(i, ev, c.caiu && c.k !== "goblin");
            if (c.mat === "tnt" && !c.caiu) M.explodir(ex, ey, 58, 320, ev);
        }
        if (!algum) break;
        s = M.s = M.w.state();
        atualizaCombat(s);
    }

    // turno: assentar e decidir
    if (t && t.estado === "assentando") {
        t.t += dt;
        var acordado = false;
        for (i = 0; i < M.corpos.length; i++) {
            c = M.corpos[i];
            o = i * NS;
            if (c && !c.fixo && c.k !== "chao" && (s[o + SFL] & 1) && s[o + SVEL] > 6) {
                acordado = true;
                break;
            }
        }
        M.calmo = acordado ? 0 : M.calmo + dt;
        if (M.calmo > 0.5 || t.t > 3) {
            t.estado = "fim";
            if (M.goblins <= 0) M.vitoria(ev);
            else if (M.tiros.length) { M.proximoTiro(); ev.push({ t: "arma" }); }
            else { M.acabou = true; ev.push({ t: "derrota" }); }
        }
    } else if (!M.acabou && M.goblins <= 0 && (!t || t.estado !== "voando")) {
        // goblins zerados com o tiro ainda pronto (TNT em cadeia): vitoria
        if (!t || t.estado === "pronto" || t.estado === "carregando") M.vitoria(ev);
    }
    vagueia(dt, s);
    return ev;
};

M.vitoria = function (ev) {
    if (M.acabou) return;
    M.acabou = true;
    M.venceu = true;
    var resto = M.tiros.length + (M.tiro && M.tiro.estado !== "fim" && M.tiro.estado !== "assentando" ? 1 : 0);
    var bonus = resto * 1000;
    M.pontos += bonus;
    ev.push({ t: "vitoria", bonus: bonus, resto: resto });
};

// estrelas pelos pontos: 1 = venceu; 2 = metade do estrago; 3 = 60% do
// estrago E uma pedra sobrando (bonus de 1000/tiro). O teto teorico e
// g + bl + 1000*(tiros - 1): as metas tem que caber nele em TODAS as fases
// (a formula antiga pedia 2000 de bonus e a fase 1, com 2 tiros, tinha
// maximo 2300 para meta-3 de 3200 — 3 estrelas impossivel).
M.metas = function (n) {
    var pecas = NIV.montar(n), g = 0, bl = 0;
    for (var p = 0; p < pecas.length; p++) {
        var c = pecas[p];
        var m = MAT[c.k === "goblin" ? c.tipo : c.mat];
        if (c.k === "goblin") g += m.pts;
        else if (!m.estatico) bl += m.pts;
    }
    return [g, Math.round((g + bl * 0.5) / 100) * 100,
            Math.round((g + bl * 0.6 + 1000) / 100) * 100];
};

M.estrelas = function () {
    if (!M.venceu) return 0;
    var m = M.metas(M.fase);
    return M.pontos >= m[2] ? 3 : (M.pontos >= m[1] ? 2 : 1);
};

M.NS = NS;
M.MW = MW;
M.GROUND = GROUND;
M.GRAV = GRAV;
M.BERCO = BERCO;
M.GARFO = GARFO;
M.PUXAO_MAX = PUXAO_MAX;
M.MAT = MAT;
M.TIRO = TIRO;

module.exports = M;
