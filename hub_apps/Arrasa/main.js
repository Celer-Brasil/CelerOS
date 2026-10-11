// Arrasa! — estilingue contra fortalezas de goblins, com fisica de CORPO
// RIGIDO nativa (API 33): tabuas e blocos que giram, empilham, tombam e
// quebram pelo impacto; pedras que rolam e nao atravessam nada.
//
// Modulos: main.js (cenas, input, HUD, eventos -> efeitos), mundo.js
// (fisica de jogo: dano, explosoes, tiros, turnos), arte.js (sprites da
// arte gerada + pecas giradas + elastico), niveis.js (as 8 fases).
//
// Render (engine 1.2): camada suja com o cenario num sprite de tela
// inteira (painter = pushSprite recortado). Por quadro so redesenha o que
// se MEXE (corpo acordado, pedra, elastico, particulas) e o que a borracha
// do quadro anterior TOCOU — pilha dormindo nao custa nada.

var E = require("celeros.game");       // familia CelerGame: adota so o que usa
require("celeros.game.fx");
var M = require("mundo");
var A = require("arte");
var NIV = require("niveis");

E.init({ dir: "Arrasa", fps: 30, native: true, save: "arrasa.", particles: 140 });
var W = E.W, H = E.H, u = E.u, S = System;
var temArte = A.init(W, H, "Arrasa", "celeros.arrasa");
var C = A.C;
var D = E.dirty;

var G = {
    fase: 0,
    retomar: false,
    fimT: -1,
    banner: null,           // { txt, sub, t }
    vib: 0, vibT: 0,        // elastico vibrando depois do lance
    filaSuja: true,
    rastroDesenhado: 0,
    ultForca: 0,
    hudPts: -1,
    estrelasVistas: 0,
    recorde: false
};

if (typeof __harness !== "undefined") __harness.arrasa = { M: M, E: E, A: A, G: G };

// -------------------------------------------------------------- audio ----
// Do maior, 120 bpm: I-V-vi-IV saltitante; nota = [midi, semicolcheias]
var SONG = {
    bpm: 120, loops: 16,
    tracks: [
        { wave: "tri", vol: 56, notes: [
            [48, 2], [55, 2], [48, 2], [55, 2], [43, 2], [50, 2], [43, 2], [50, 2],
            [45, 2], [52, 2], [45, 2], [52, 2], [41, 2], [48, 2], [41, 2], [48, 2]
        ] },
        { wave: "sq25", vol: 26, notes: [
            [72, 2], [76, 2], [79, 2], [76, 2], [74, 2], [71, 2], [67, 4],
            [69, 2], [72, 2], [76, 2], [72, 2], [77, 3], [76, 1], [74, 4]
        ] },
        { drum: true, vol: 44, notes: [
            [36, 2], [42, 2], [38, 2], [42, 2], [36, 2], [36, 2], [38, 2], [42, 2],
            [36, 2], [42, 2], [38, 2], [42, 2], [36, 2], [42, 2], [38, 2], [38, 2]
        ] }
    ]
};

var SND = {
    estica: [[180, 25], [230, 25]],
    estica2: [[260, 25], [320, 25]],
    lanca: [[420, 25], [700, 30], [1100, 45]],
    madeira: [[320, 22], [190, 30]],
    vidro: [[1900, 18], [2600, 18], [1500, 30]],
    pedra: [[150, 28], [95, 40]],
    tnt: [[90, 50], [60, 70], [40, 110]],
    goblin: [[900, 35], [700, 35], [450, 70]],
    rei: [[900, 45], [700, 45], [520, 55], [330, 130]],
    boom: [[110, 50], [70, 70], [45, 130]],
    racha: [[1300, 22], [1700, 30]],
    dispara: [[600, 20], [1200, 25], [2000, 40]],
    volta: [[900, 30], [700, 30], [900, 30], [1200, 40]],
    bota: [[700, 25], [500, 30], [300, 40]],
    pancada: [[170, 18], [110, 24]],
    puf: [[600, 20], [400, 25]],
    vitoria: [[523, 90], [659, 90], [784, 90], [1047, 240]],
    derrota: [[392, 150], [330, 150], [262, 280]],
    estrela: [[1047, 50], [1319, 90]],
    ok: [[660, 25], [880, 30]]
};

// --------------------------------------------------------------- save ----
function estrelasDe(n) { return E.save.num("est" + n, 0); }
function recordeDe(n) { return E.save.num("pts" + n, 0); }
function liberada(n) { return n === 0 || estrelasDe(n - 1) > 0; }
function totalEstrelas() {
    var t = 0;
    for (var n = 0; n < NIV.total; n++) t += estrelasDe(n);
    return t;
}

// ---------------------------------------------------------------- HUD ----
var HUD = {
    pausa: { x: u(6), y: u(6), w: u(26), h: u(24) },
    pts: { x: W - u(110), y: u(4), w: u(106), h: u(30) }
};

function mudo(fn) {
    D._mute++;
    try { fn(); } finally { D._mute--; }
}

function hudPausa() {
    var b = HUD.pausa;
    mudo(function () {
        A.painter(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
        S.fillSmoothRoundRect(b.x, b.y, b.w, b.h, u(6), C.painel);
        S.drawRoundRect(b.x, b.y, b.w, b.h, u(6), C.painelClaro);
        var bw = Math.max(2, u(3)), bh = Math.round(b.h * 0.46);
        S.fillRect(b.x + b.w / 2 - bw - u(2), b.y + (b.h - bh) / 2, bw, bh, C.texto);
        S.fillRect(b.x + b.w / 2 + u(2), b.y + (b.h - bh) / 2, bw, bh, C.texto);
    });
}

function hudPontos() {
    var b = HUD.pts;
    mudo(function () {
        A.painter(b.x, b.y, b.w, b.h);
        var x = b.x + b.w - u(4);
        E.gfx.text(String(M.pontos), x + u(1), b.y + u(1) + u(12), { align: "right", valign: "middle",
                   px: u(17), color: C.sombra, screen: true });
        E.gfx.text(String(M.pontos), x, b.y + u(12), { align: "right", valign: "middle",
                   px: u(17), color: C.texto, screen: true });
        E.gfx.text("fase " + (G.fase + 1), x, b.y + u(26), { align: "right", valign: "middle",
                   ts: "tiny", color: C.sombra, screen: true });
    });
    G.hudPts = M.pontos;
}

function desenhaHUD() {
    var p = HUD.pausa, q = HUD.pts;
    if (D.touches(p.x - 2, p.y - 2, p.w + 4, p.h + 4)) hudPausa();
    if (G.hudPts !== M.pontos || D.touches(q.x, q.y, q.w, q.h)) hudPontos();
}

// ------------------------------------------------------------ eventos ----
function boxDe(c, x, y, a) {
    var b = A.caixa(c, x, y, a);
    D.add(b.x, b.y, b.w, b.h);
}

// apaga os pontinhos do rastro (a borracha do proximo quadro repinta o fundo)
function apagaRastro() {
    var L = M.rastro.length ? M.rastro : M.rastroNovo;
    for (var k = 0; k + 1 < L.length; k += 2) {
        var R = 1.7 * A.ESC + 3;
        D.add(A.sx(L[k]) - R, A.sy(L[k + 1]) - R, R * 2, R * 2);
    }
    M.rastro = [];
    M.rastroNovo = [];
    G.rastroDesenhado = 0;
}

function poeira(x, y, n, cor) {
    E.fx.burst(A.sx(x), A.sy(y), { n: n, colors: [cor, C.texto], speed: 40 * A.ESC,
               life: 0.45, size: Math.max(1, A.ESC * 1.2), grav: 60 * A.ESC });
}

function processa(evs) {
    var somQuebra = false;
    for (var i = 0; i < evs.length; i++) {
        var ev = evs[i];
        if (ev.t === "lancou") {
            E.audio.sfx(SND.lanca);
            G.vib = 7; G.vibT = 0;
            G.filaSuja = true;
        } else if (ev.t === "impacto") {
            E.audio.sfx(SND.pancada);
            poeira(ev.x, ev.y, 7, S.color(170, 150, 120));
        } else if (ev.t === "quebra") {
            boxDe(ev.c, ev.x, ev.y, ev.a);
            var cor = A.corMat(ev.mat);
            E.fx.burst(A.sx(ev.x), A.sy(ev.y), { n: ev.mat === "vidro" ? 12 : 9,
                       colors: [cor, S.mixColor(cor, 0x0000, 40), C.texto],
                       speed: 55 * A.ESC, life: 0.6, size: Math.max(2, A.ESC * 1.8),
                       grav: 140 * A.ESC });
            if (ev.pts > 0) E.fx.popText(A.sx(ev.x), A.sy(ev.y) - u(6), String(ev.pts),
                                         { color: C.texto, ts: "small" });
            if (!somQuebra) {
                somQuebra = true;
                E.audio.sfx(ev.mat === "vidro" ? SND.vidro : ev.mat === "pedra" ? SND.pedra :
                            ev.mat === "tnt" ? SND.tnt : SND.madeira);
            }
        } else if (ev.t === "goblin") {
            boxDe(ev.c, ev.x, ev.y, 0);
            E.fx.burst(A.sx(ev.x), A.sy(ev.y), { n: 14, colors: [C.goblin, S.color(200, 240, 140), C.texto],
                       speed: 60 * A.ESC, life: 0.7, size: Math.max(2, A.ESC * 2), grav: 40 * A.ESC });
            E.fx.ring(A.sx(ev.x), A.sy(ev.y), { r0: 4 * A.ESC, speed: 90 * A.ESC, color: C.texto, life: 0.35 });
            if (ev.pts > 0) E.fx.popText(A.sx(ev.x), A.sy(ev.y) - u(10), String(ev.pts),
                                         { color: ev.rei ? C.ouro : S.color(190, 255, 120), ts: "label", life: 1.1 });
            E.audio.sfx(ev.rei ? SND.rei : SND.goblin);
        } else if (ev.t === "poof") {
            boxDe(ev.c, ev.x, ev.y, 0);
            E.fx.burst(A.sx(ev.x), A.sy(ev.y), { n: 8, colors: [C.texto, S.color(200, 200, 200)],
                       speed: 30 * A.ESC, life: 0.5, size: Math.max(2, A.ESC * 2.2), grav: -20 * A.ESC });
            E.audio.sfx(SND.puf);
        } else if (ev.t === "boom") {
            E.fx.burst(A.sx(ev.x), A.sy(ev.y), { n: 26, colors: [C.amarelo, S.color(255, 120, 30), C.tnt, C.texto],
                       speed: 120 * A.ESC, life: 0.6, size: Math.max(2, A.ESC * 2.4), grav: 80 * A.ESC });
            E.fx.ring(A.sx(ev.x), A.sy(ev.y), { r0: 6 * A.ESC, speed: ev.r * 3 * A.ESC, color: C.amarelo, life: 0.3 });
            E.fx.flash(S.color(255, 170, 60), 160);
            E.audio.sfx(SND.boom);
        } else if (ev.t === "fimvoo") {
            // o rastro some quando o voo acaba (nao fica preso na tela)
            apagaRastro();
        } else if (ev.t === "dispara") {
            E.audio.sfx(SND.dispara);
            E.fx.burst(A.sx(ev.x), A.sy(ev.y), { n: 10, colors: [C.amarelo, C.texto],
                       speed: 70 * A.ESC, angle: Math.atan2(-ev.vy, -ev.vx), spread: 0.5,
                       life: 0.35, size: Math.max(1, A.ESC * 1.4), shape: "spark" });
        } else if (ev.t === "volta") {
            E.audio.sfx(SND.volta);
            E.fx.ring(A.sx(ev.x), A.sy(ev.y), { r0: 3 * A.ESC, speed: 60 * A.ESC, color: S.color(150, 230, 90), life: 0.3 });
        } else if (ev.t === "bota") {
            E.audio.sfx(SND.bota);
            E.fx.burst(A.sx(ev.x), A.sy(ev.y), { n: 8, colors: [C.texto, S.color(255, 200, 120)],
                       speed: 45 * A.ESC, life: 0.4, size: Math.max(1, A.ESC * 1.6) });
        } else if (ev.t === "racha") {
            E.audio.sfx(SND.racha);
            E.fx.ring(A.sx(ev.x), A.sy(ev.y), { r0: 3 * A.ESC, speed: 70 * A.ESC, color: S.color(90, 200, 255), life: 0.25 });
        } else if (ev.t === "pancada") {
            if (ev.dv > 160) poeira(ev.x, ev.y, 3, A.corMat(ev.mat));
        } else if (ev.t === "arma") {
            G.filaSuja = true;
        } else if (ev.t === "vitoria") {
            G.fimT = 0;
            E.audio.sfx(SND.vitoria);
            if (ev.bonus > 0) {
                E.fx.popText(A.sx(30), A.sy(M.GROUND - 30), "+" + ev.bonus, { color: C.ouro, ts: "label", life: 1.4 });
            }
            G.filaSuja = true;
        } else if (ev.t === "derrota") {
            G.fimT = 0;
            E.audio.sfx(SND.derrota);
        }
    }
}

// ------------------------------------------------------------- desenho ---
// corpos: os que se mexem registram a caixa (a borracha do proximo quadro
// apaga); os parados so redesenham se a borracha deste quadro os tocou.
// O estado e lido por indice (s[i * NS + campo]): w.x(i, s) e cia. sao
// chamadas de funcao, caras no Duktape para 2 lacos por corpo por quadro.
var NS = M.NS;
var mov = [], quietos = [];

// corpos que acordaram neste quadro (pancada, explosao): o desenho PARADO
// nao tem caixa na camada suja (a borracha so conhece as do quadro
// anterior) e ficaria na tela. D.erase apaga JA, no inicio do draw — o que
// estiver por baixo (rastro, fila, pecas paradas) ve o toque e se
// redesenha neste mesmo quadro; o resto e o desenhaMundo
function preparaMundo() {
    var s = M.s, n = M.w.count();
    for (var i = 0; i < n; i++) {
        var c = M.corpos[i];
        if (!c || !c._qw || c.k === "chao" || c.k === "tiro") continue;
        var fl = s[i * NS + 5];
        if (!(fl & 1) || (fl & 2)) {
            D.erase(c._qx, c._qy, c._qw, c._qh);
            c._qw = 0;
        }
    }
}

function desenhaMundo() {
    var s = M.s, n = M.w.count(), i, c, b, o, k;
    mov.length = 0;
    quietos.length = 0;
    for (i = 0; i < n; i++) {
        c = M.corpos[i];
        if (!c || c.k === "chao" || c.k === "tiro") continue;
        o = i * NS;
        var fl = s[o + 5];
        if (!(fl & 1)) continue;
        b = A.caixa(c, s[o], s[o + 1], s[o + 2]);
        if ((fl & 2) || c.hpVisto !== c.hp) {
            D.add(b.x, b.y, b.w, b.h);
            mov.push(i);
            c._qw = 0;
        } else {
            quietos.push(i);
            // caixa do desenho parado (o preparaMundo apaga quando acordar)
            c._qx = b.x; c._qy = b.y; c._qw = b.w; c._qh = b.h;
        }
    }
    for (k = 0; k < quietos.length; k++) {
        i = quietos[k];
        c = M.corpos[i];
        if (!D.touches(c._qx, c._qy, c._qw, c._qh)) continue;
        o = i * NS;
        if (c.k === "goblin") A.goblin(c, s[o], s[o + 1], s[o + 2]);
        else A.peca(c, s[o], s[o + 1], s[o + 2]);
    }
    for (k = 0; k < mov.length; k++) {
        i = mov[k];
        c = M.corpos[i];
        o = i * NS;
        if (c.k === "goblin") A.goblin(c, s[o], s[o + 1], s[o + 2]);
        else A.peca(c, s[o], s[o + 1], s[o + 2]);
        c.hpVisto = c.hp;
    }
    // projeteis em voo (e os rachados da tripla)
    var t = M.tiro;
    if (t && (t.estado === "voando" || t.estado === "assentando")) {
        for (k = -1; k < t.extras.length; k++) {
            i = k < 0 ? t.idx : t.extras[k];
            if (i < 0) continue;
            c = M.corpos[i];
            o = i * NS;
            if (!c || !(s[o + 5] & 1)) continue;
            b = A.tiro(c.tipo, s[o], s[o + 1], s[o + 2], M.t);
            D.add(b.x, b.y, b.w, b.h);
        }
    }
}

function desenhaRastro() {
    var L = M.rastro.length ? M.rastro : M.rastroNovo;
    for (var k = 0; k + 1 < L.length; k += 2) {
        var x = L[k], y = L[k + 1], r = (k / 2) % 3 === 0 ? 1.7 : 1.1;
        var R = r * A.ESC + 3;
        if (k / 2 >= G.rastroDesenhado || D.touches(A.sx(x) - R, A.sy(y) - R, R * 2, R * 2)) A.ponto(x, y, r);
    }
    G.rastroDesenhado = L.length / 2;
}

// fila: os tiros que faltam esperando no chao, a esquerda do estilingue
var FILA = { x: 0, y: 0, w: 0, h: 0 };
function desenhaFila() {
    FILA.x = 0; FILA.y = A.sy(M.GROUND - 22); FILA.w = A.sx(40); FILA.h = A.sy(M.GROUND) - FILA.y + 2;
    if (G.filaSuja) {
        D.add(FILA.x, FILA.y, FILA.w, FILA.h);
        G.filaSuja = false;
        return;
    }
    if (!D.touches(FILA.x, FILA.y, FILA.w, FILA.h)) return;
    var fila = M.tiros, x = 33;
    for (var k = 0; k < fila.length; k++) {
        var r = M.TIRO[fila[k]].r;
        if (x - r < 1) break;
        A.tiro(fila[k], x, M.GROUND - r, 0, 0);
        x -= r * 2 + 1;
    }
}

// estilingue (elastico de tras, pedra, elastico da frente, mira) como UMA
// peca: a caixa uniao fica em ESTI. Na mesma pose do quadro anterior ele
// fica fora da camada suja — so redesenha se a borracha tocar — e a pedra
// armada esperando o dedo deixa de custar apaga+desenha+push por quadro.
// Pose = estado do tiro, tipo, puxao, vibracao e o pisca do estopim.
var ESTI = { estado: "", tipo: "", px: 0, py: 0, pisca: false, parado: false,
             x: 0, y: 0, w: 0, h: 0, x1: 0, y1: 0 };

function estilingueMexe() {
    var t = M.tiro;
    var est = t ? t.estado : "", tipo = t ? t.tipo : "";
    var pisca = tipo === "bomba" && ((M.t * 12) % 2 < 1);
    var mexe = G.vib > 0 || est === "carregando" || est !== ESTI.estado || tipo !== ESTI.tipo ||
               M.pull.x !== ESTI.px || M.pull.y !== ESTI.py || pisca !== ESTI.pisca;
    ESTI.estado = est; ESTI.tipo = tipo; ESTI.pisca = pisca;
    ESTI.px = M.pull.x; ESTI.py = M.pull.y;
    return mexe;
}

// soma a caixa na uniao do estilingue; mexendo, entra na camada suja
var _estiMexe = true;
function regEsti(b) {
    if (!b) return;
    if (b.x < ESTI.x) ESTI.x = b.x;
    if (b.y < ESTI.y) ESTI.y = b.y;
    if (b.x + b.w > ESTI.x1) ESTI.x1 = b.x + b.w;
    if (b.y + b.h > ESTI.y1) ESTI.y1 = b.y + b.h;
    if (_estiMexe) D.add(b.x, b.y, b.w, b.h);
}

function desenhaEstilingue(mexe) {
    if (!mexe && !D.touches(ESTI.x, ESTI.y, ESTI.w, ESTI.h)) {
        ESTI.parado = true;
        return;
    }
    _estiMexe = mexe;
    ESTI.parado = !mexe;
    ESTI.x = ESTI.y = 1e9;
    ESTI.x1 = ESTI.y1 = -1e9;
    desenhaEstilingue0();
    ESTI.w = ESTI.x1 > ESTI.x ? ESTI.x1 - ESTI.x : 0;
    ESTI.h = ESTI.y1 > ESTI.y ? ESTI.y1 - ESTI.y : 0;
}

function desenhaEstilingue0() {
    var t = M.tiro, p = null, forca = 0;
    if (t && (t.estado === "pronto" || t.estado === "mirando")) {
        var q = M.pedraNoBerco();
        p = { x: q.x, y: q.y, tipo: t.tipo };
        forca = t.estado === "mirando" ? M.forca() : 0;
    } else if (t && t.estado === "carregando") {
        // pulo da fila para o berco
        var f = Math.min(1, t.t / 0.35), r = M.TIRO[t.tipo].r;
        var x0 = 32, y0 = M.GROUND - r;
        var hx = x0 + (M.BERCO.x - x0) * f, hy = y0 + (M.BERCO.y - y0) * f - Math.sin(f * Math.PI) * 26;
        regEsti(A.tiro(t.tipo, hx, hy, f * 6, M.t));
    }
    var vib = 0;
    if (G.vib > 0) {
        vib = G.vib * Math.sin(G.vibT * 38) * Math.exp(-G.vibT * 7);
        if (G.vibT > 0.6) { G.vib = 0; vib = 0; }
    }
    regEsti(A.elastico("tras", p, forca, vib));
    if (p) {
        regEsti(A.tiro(p.tipo, p.x, p.y, 0, M.t));
        regEsti(A.elastico("frente", p, forca, 0));
    }
    // mira: pontinhos do inicio da trajetoria
    if (t && t.estado === "mirando" && M.forca() >= 0.2) {
        var pv = M.previsao(9, 0.055);
        for (var k = 0; k + 1 < pv.length; k += 2) {
            regEsti(A.ponto(pv[k], pv[k + 1], k < 8 ? 1.5 : 1.1, S.mixColor(C.branco, C.ouro, 30)));
        }
    }
}

// banner do nome da fase: texto PARADO (fora da camada suja) na faixa
// BAN — so redesenha se a borracha tocar, e sai com D.erase no inicio do
// draw quando vence (antes: apagado e redesenhado a cada quadro por 2,2 s)
var BAN = { x: 0, y: 0, w: 0, h: 0 };
function faixaBanner() {
    var y = Math.round(H * 0.3);
    BAN.x = 0; BAN.w = W;
    BAN.y = y - u(16); BAN.h = u(48);
    return y;
}

function venceBanner() {
    if (!G.banner || G.banner.t <= 2.2) return;
    G.banner = null;
    faixaBanner();
    D.erase(BAN.x, BAN.y, BAN.w, BAN.h);
}

function desenhaBanner() {
    var bn = G.banner;
    if (!bn) return;
    var y = faixaBanner();
    if (!D.touches(BAN.x, BAN.y, BAN.w, BAN.h)) return;
    mudo(function () {
        E.gfx.text(bn.txt, W / 2 + u(1), y + u(1), { align: "center", valign: "middle", px: u(22),
                   color: C.sombra, screen: true });
        E.gfx.text(bn.txt, W / 2, y, { align: "center", valign: "middle", px: u(22),
                   color: bn.cor || C.texto, screen: true });
        if (bn.sub) {
            E.gfx.text(bn.sub, W / 2, y + u(20), { align: "center", valign: "middle", ts: "small",
                       color: C.texto, screen: true });
        }
    });
}

function semFirmware() {
    S.fillScreen(C.painel);
    E.gfx.text("Arrasa! precisa do CelerOS", W / 2, H * 0.4, { align: "center", ts: "label",
               color: C.texto, screen: true });
    E.gfx.text("com fisica nativa (API 33)", W / 2, H * 0.4 + u(18), { align: "center", ts: "label",
               color: C.texto, screen: true });
    E.gfx.text("Atualize o sistema pela tela de updates.", W / 2, H * 0.4 + u(40),
               { align: "center", ts: "small", fit: W - u(20), color: C.ouro, screen: true });
}

// ----------------------------------------------------------- cenas -------
function botao(rotulo, x, y, w, h, prim) {
    return E.gfx.button(rotulo, x, y, w, h, prim ? { color: C.ouro, textColor: C.painel, screen: true } :
                        { primary: false, bg: C.painel, stroke: C.ouro, textColor: C.texto, screen: true });
}

function painel(x, y, w, h) {
    S.fillSmoothRoundRect(x + u(3), y + u(4), w, h, u(12), C.sombra);
    S.fillSmoothRoundRect(x, y, w, h, u(12), C.painel);
    S.drawRoundRect(x + u(3), y + u(3), w - u(6), h - u(6), u(10), C.painelClaro);
}

E.run({
    titulo: {
        static: true,
        enter: function () {
            E.cam.reset();
            // o rei grande do titulo: PNG cru no slot livre, ampliado com AA
            // a cada desenho (cena static: so na entrada e no hover)
            this.rei = 0;
            if (temArte && typeof S.drawSprite === "function") {
                var id = S.createSprite(64, 64);
                if (id) {
                    S.useSprite(id);
                    S.fillScreen(A.KEY);
                    var ok = false;
                    try { ok = !!S.drawPNG(A.base + "rei.png", 0, 0); } catch (e) { ok = false; }
                    S.useSprite(0);
                    if (ok) this.rei = id;
                    else S.deleteSprite(id);
                }
            }
        },
        exit: function () {
            if (this.rei) S.deleteSprite(this.rei);
            this.rei = 0;
        },
        update: function () {
            if (!this.btn) return;
            if (this.btn.length > 1 && E.hit(this.btn[0])) {
                E.audio.sfx(SND.ok);
                E.goto("mapa");
            } else if (E.hit(this.btn[this.btn.length - 1])) {
                S.exitApp();
            }
        },
        draw: function () {
            if (!temArte || !S.rigidNew) {
                semFirmware();
                var bw0 = Math.min(u(150), W - u(40));
                this.btn = [botao("SAIR", (W - bw0) / 2, H - u(50), bw0, u(28), false)];
                return;
            }
            A.fundoInteiro();
            // guarda da fortaleza: rei grande e goblins; a pedra no estilingue
            var fake = { k: "goblin", r: 7, tipo: "goblin", hp: 1, hp0: 1 };
            A.goblin(fake, 222, M.GROUND - 7, 0.15);
            A.goblin(fake, 298, M.GROUND - 7, -0.2);
            if (this.rei) {
                var zr = 46 * A.ESC / 64;
                S.drawSprite(this.rei, A.sx(262), A.sy(M.GROUND - 20), -6, zr, zr, A.KEY, true);
            } else {
                A.goblin({ k: "goblin", r: 10, tipo: "rei", hp: 1, hp0: 1 }, 262, M.GROUND - 10, -0.1);
            }
            var pp = { x: M.BERCO.x - 16, y: M.BERCO.y + 8, tipo: "pedra" };
            A.elastico("tras", pp, 0.55, 0);
            A.tiro("pedra", pp.x, pp.y, 0, 0);
            A.elastico("frente", pp, 0.55, 0);
            var ty = Math.round(H * 0.14);
            E.gfx.text("ARRASA!", W / 2 + u(3), ty + u(3), { align: "center", valign: "middle",
                       px: u(40), fit: W - u(30), color: C.sombra, screen: true });
            E.gfx.text("ARRASA!", W / 2, ty, { align: "center", valign: "middle",
                       px: u(40), fit: W - u(30), color: C.ouro, screen: true });
            E.gfx.text("estilingue contra a fortaleza dos goblins", W / 2, ty + u(28),
                       { align: "center", valign: "middle", ts: "small", fit: W - u(16), color: C.sombra, screen: true });
            var est = totalEstrelas();
            var by = ty + u(48);
            if (est > 0) {
                A.estrela(W / 2 - u(20), ty + u(46), u(6), C.ouro, C.sombra);
                E.gfx.text(est + "/" + (NIV.total * 3), W / 2 - u(10), ty + u(46), { valign: "middle",
                           ts: "label", color: C.texto, screen: true });
                by += u(14);
            }
            var bw = Math.min(u(130), W - u(40)), bh = u(28);
            var bx = Math.round((W - bw) / 2);
            this.btn = [botao("JOGAR", bx, by, bw, bh, true),
                        botao("SAIR", bx, by + bh + u(8), bw, bh, false)];
        }
    },

    mapa: {
        static: true,
        enter: function () { this.btn = null; },
        update: function () {
            if (!this.btn) return;
            for (var n = 0; n < NIV.total; n++) {
                if (E.hit(this.btn[n]) && liberada(n)) {
                    E.audio.sfx(SND.ok);
                    G.fase = n;
                    G.retomar = false;
                    E.goto("jogando");
                    return;
                }
            }
            if (E.hit(this.voltar)) { E.audio.sfx(SND.ok); E.goto("titulo"); }
        },
        draw: function () {
            A.fundoInteiro();
            var cols = 5, gap = u(8), rows = Math.ceil(NIV.total / cols);
            var pw = Math.min(W - u(16), u(224));
            var bs = Math.min(Math.floor((pw - u(24) - gap * (cols - 1)) / cols), u(46));
            var ph = u(36) + rows * bs + (rows - 1) * gap + u(12);
            var px = Math.round((W - pw) / 2), py = Math.round(Math.max(u(8), (H - ph - u(40)) / 2));
            painel(px, py, pw, ph);
            E.gfx.text("ESCOLHA A FASE", W / 2, py + u(17), { align: "center", valign: "middle",
                       ts: "label", color: C.ouro, screen: true });
            var gx0 = px + Math.round((pw - cols * bs - (cols - 1) * gap) / 2);
            this.btn = [];
            for (var n = 0; n < NIV.total; n++) {
                var cx = gx0 + (n % cols) * (bs + gap);
                var cy = py + u(34) + Math.floor(n / cols) * (bs + gap);
                var ok = liberada(n);
                S.fillSmoothRoundRect(cx, cy, bs, bs, u(8), ok ? C.painelClaro : S.mixColor(C.painel, 0x0000, 30));
                S.drawRoundRect(cx, cy, bs, bs, u(8), ok ? C.ouro : C.painelClaro);
                if (ok) {
                    E.gfx.text(String(n + 1), cx + bs / 2, cy + bs * 0.42, { align: "center", valign: "middle",
                               px: Math.round(bs * 0.45), color: C.texto, screen: true });
                    var st = estrelasDe(n);
                    for (var k = 0; k < 3; k++) {
                        A.estrela(cx + bs / 2 + (k - 1) * bs * 0.29, cy + bs * 0.78, bs * 0.13,
                                  k < st ? C.ouro : S.mixColor(C.painel, C.texto, 25));
                    }
                } else {
                    // cadeado
                    var lx = cx + bs / 2, ly = cy + bs / 2;
                    S.drawWideLine(lx - u(5), ly - u(2), lx - u(5), ly - u(8), Math.max(2, u(2.5)), C.painelClaro);
                    S.drawWideLine(lx + u(5), ly - u(2), lx + u(5), ly - u(8), Math.max(2, u(2.5)), C.painelClaro);
                    S.drawWideLine(lx - u(5), ly - u(8), lx + u(5), ly - u(8), Math.max(2, u(2.5)), C.painelClaro);
                    S.fillSmoothRoundRect(lx - u(8), ly - u(3), u(16), u(12), u(2), C.painelClaro);
                }
                this.btn.push({ x: cx, y: cy, w: bs, h: bs });
            }
            var bw = Math.min(u(120), W - u(40));
            this.voltar = botao("VOLTAR", Math.round((W - bw) / 2), py + ph + u(10), bw, u(26), false);
        }
    },

    jogando: {
        fps: 30,
        enter: function () {
            if (!G.retomar) {
                M.carregar(G.fase);
                G.fimT = -1;
                G.vib = 0;
                G.filaSuja = true;
                G.rastroDesenhado = 0;
                G.banner = { txt: NIV.fase(G.fase).nome, sub: "fase " + (G.fase + 1) + " de " + NIV.total, t: 0 };
                for (var i = 0; i < M.corpos.length; i++) if (M.corpos[i]) M.corpos[i].hpVisto = -1;
            } else {
                G.rastroDesenhado = 0;
            }
            G.retomar = false;
            G.hudPts = -1;
            D.enable(A.painter);
            E.cam.reset();
            if (E.data.musicPos !== undefined) {
                E.audio.music(SONG, { startMs: E.data.musicPos });
                E.data.musicPos = undefined;
            } else {
                E.audio.music(SONG);
            }
        },
        update: function (dt) {
            if (M.sem) { E.goto("titulo"); return; }
            var inp = E.input, t = M.tiro;
            var hp = HUD.pausa;
            var naPausa = inp.x >= hp.x - u(4) && inp.x <= hp.x + hp.w + u(4) && inp.y <= hp.y + hp.h + u(4);
            if (E.hit(HUD.pausa)) {
                E.audio.sfx(SND.ok);
                var pos = typeof S.musicPos === "function" ? S.musicPos() : -1;
                E.data.musicPos = pos > 0 ? pos : undefined;
                G.retomar = true;
                E.goto("pausa");
                return;
            }
            var wx = A.wx(inp.x), wy = A.wy(inp.y);
            if (inp.justDown && t) {
                if (t.estado === "pronto" && M.pegar(wx, wy)) {
                    E.audio.sfx(SND.estica);
                    G.ultForca = 0;
                } else if (t.estado === "voando" && !naPausa) {
                    var ev = [];
                    if (M.habilidade(ev)) processa(ev);
                }
            }
            if (inp.down && t && t.estado === "mirando") {
                M.arrastar(wx, wy);
                var f = M.forca();
                if ((f > 0.5 && G.ultForca <= 0.5) || (f > 0.9 && G.ultForca <= 0.9)) E.audio.sfx(SND.estica2);
                G.ultForca = f;
            }
            if (!inp.down && t && t.estado === "mirando") {
                var e = M.soltar();
                if (e) processa([e]);
            }
            processa(M.step(dt));
            if (G.vib > 0) G.vibT += dt;
            if (G.banner) G.banner.t += dt;
            if (G.fimT >= 0) {
                G.fimT += dt;
                if (G.fimT > 1.4) { E.goto("fim"); return; }
            }
        },
        draw: function () {
            // o que estava parado e vai se mexer sai da tela ANTES de tudo
            var mexe = estilingueMexe();
            if (mexe && ESTI.parado && ESTI.w > 0) D.erase(ESTI.x, ESTI.y, ESTI.w, ESTI.h);
            preparaMundo();
            venceBanner();
            desenhaRastro();
            desenhaFila();
            desenhaMundo();
            desenhaEstilingue(mexe);
            desenhaBanner();
            E.fx.draw();
            desenhaHUD();
        }
    },

    pausa: {
        static: true,
        enter: function () { E.audio.stop(); this.btn = null; },
        update: function () {
            if (!this.btn) return;
            if (E.hit(this.btn[0])) { E.audio.sfx(SND.ok); G.retomar = true; E.goto("jogando"); }
            else if (E.hit(this.btn[1])) { E.audio.sfx(SND.ok); G.retomar = false; E.data.musicPos = undefined; E.goto("jogando"); }
            else if (E.hit(this.btn[2])) { E.audio.sfx(SND.ok); G.retomar = false; E.goto("mapa"); }
        },
        draw: function () {
            var pw = Math.min(u(180), W - u(30)), ph = u(150);
            var px = Math.round((W - pw) / 2), py = Math.round((H - ph) / 2);
            painel(px, py, pw, ph);
            E.gfx.text("PAUSA", W / 2, py + u(20), { align: "center", valign: "middle",
                       px: u(20), color: C.ouro, screen: true });
            var bw = pw - u(30), bh = u(26), bx = Math.round((W - bw) / 2), by = py + u(40);
            this.btn = [botao("CONTINUAR", bx, by, bw, bh, true),
                        botao("REINICIAR", bx, by + bh + u(8), bw, bh, false),
                        botao("FASES", bx, by + (bh + u(8)) * 2, bw, bh, false)];
        }
    },

    fim: {
        static: true,
        enter: function () {
            E.audio.stop();
            this.t = 0;
            this.btn = null;
            G.estrelasVistas = 0;
            var est = M.estrelas();
            G.recorde = false;
            if (M.venceu) {
                if (est > estrelasDe(G.fase)) E.save.set("est" + G.fase, est);
                G.recorde = E.save.best("pts" + G.fase, M.pontos);
                for (var k = 0; k < est; k++) {
                    E.after(450 + k * 380, function () {
                        G.estrelasVistas++;
                        E.audio.sfx(SND.estrela);
                        E.redraw();
                    });
                }
            }
        },
        exit: function () {
            E.clearTimers();   // timers das estrelas nao vazam pra proxima cena
        },
        update: function (dt) {
            this.t += dt;
            if (this.t < 0.6 || !this.btn) return;   // engole o toque do lance
            var prox = M.venceu && G.fase + 1 < NIV.total;
            if (E.hit(this.btn[0])) {
                E.audio.sfx(SND.ok);
                G.retomar = false;
                if (prox) G.fase++;
                E.goto("jogando");
            } else if (this.btn[1] && E.hit(this.btn[1])) {
                E.audio.sfx(SND.ok);
                if (prox) { G.retomar = false; E.goto("jogando"); }
                else E.goto("mapa");
            } else if (this.btn[2] && E.hit(this.btn[2])) {
                E.audio.sfx(SND.ok);
                E.goto("mapa");
            }
        },
        draw: function () {
            var pw = Math.min(u(200), W - u(24)), ph = u(196);
            var px = Math.round((W - pw) / 2), py = Math.round((H - ph) / 2);
            painel(px, py, pw, ph);
            var ok = M.venceu;
            E.gfx.text(ok ? "FASE LIMPA!" : "OS GOBLINS VENCERAM", W / 2, py + u(20), { align: "center",
                       valign: "middle", px: u(18), fit: pw - u(16), color: ok ? C.ouro : S.color(255, 120, 90), screen: true });
            var est = M.estrelas();
            for (var k = 0; k < 3; k++) {
                var cor = ok && k < G.estrelasVistas ? C.ouro : S.mixColor(C.painel, C.texto, 22);
                A.estrela(W / 2 + (k - 1) * u(34), py + u(56) - (k === 1 ? u(6) : 0), u(k === 1 ? 15 : 12), cor, C.sombra);
            }
            E.gfx.text(String(M.pontos), W / 2, py + u(92), { align: "center", valign: "middle",
                       px: u(24), color: C.texto, screen: true });
            E.gfx.text(G.recorde ? "NOVO RECORDE!" : "recorde " + recordeDe(G.fase), W / 2, py + u(110),
                       { align: "center", valign: "middle", ts: "small",
                         color: G.recorde ? C.ouro : S.mixColor(C.painel, C.texto, 60), screen: true });
            var bw = pw - u(30), bh = u(24), bx = Math.round((W - bw) / 2), by = py + u(124);
            var prox = ok && G.fase + 1 < NIV.total;
            if (prox) {
                this.btn = [botao("PRÓXIMA", bx, by, bw, bh, true),
                            botao("DE NOVO", bx, by + bh + u(6), (bw - u(6)) / 2, bh, false),
                            botao("FASES", bx + (bw + u(6)) / 2, by + bh + u(6), (bw - u(6)) / 2, bh, false)];
            } else {
                this.btn = [botao("DE NOVO", bx, by, bw, bh, true),
                            botao("FASES", bx, by + bh + u(6), bw, bh, false)];
            }
            if (est === 0 && !ok) this.btn.length = 2;
        }
    }
}, "titulo");
