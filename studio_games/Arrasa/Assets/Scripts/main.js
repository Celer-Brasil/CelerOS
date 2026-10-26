// Arrasa! — estilingue contra fortalezas de goblins, com fisica de CORPO
// RIGIDO nativa (API 33): tabuas e blocos que giram, empilham, tombam e
// quebram pelo impacto; pedras que rolam e nao atravessam nada.
//
// Modulos: main.js (cenas, input, HUD, eventos -> efeitos), mundo.js
// (fisica de jogo: dano, explosoes, tiros, turnos), arte.js (sprites da
// arte gerada + pecas giradas + elastico), niveis.js (as 8 fases) e a
// CelerGame UI (lista de fases, pausa e menu de fim).
//
// Render (engine 1.4): camada suja com o cenario num sprite de tela
// inteira (painter = pushSprite recortado). Por quadro so redesenha o que
// se MEXE (corpo acordado, pedra, elastico, particulas) e o que a borracha
// do quadro anterior TOCOU — pilha dormindo nao custa nada.
//
// 1.3.0: arte de IA (atlas de personagens/pedra + campo de flores), hitbox
// de combate nos projeteis, goblins com steering e progressao via
// E.level.progress (chaves est*/pts* antigas continuam valendo).

var E = require("celeros.game");       // familia CelerGame: adota so o que usa
require("celeros.game.fx");
require("celeros.game.spr");           // atlas ai_atlas + ai_bg
require("celeros.game.ui");            // lista de fases, pausa e fim prontos
require("celeros.game.combat");        // E.combat(shot/blast/knock)
require("celeros.game.level");         // E.level.progress (estrelas/unlock)
require("celeros.game.steer");         // E.steer.agent (passeio dos goblins)
var M = require("mundo");
var A = require("arte");
var NIV = require("niveis");

// assets flat na RAIZ do app: a loja instala em <pacote> e o celerctl dev
// usa a pasta do repo — as duas pastas valem (como no achaBase da arte)
E.init({ dir: "Arrasa", fps: 30, native: true, save: "arrasa.", particles: 140,
         bases: ["/local/apps/celeros.arrasa/", "/sd/apps/celeros.arrasa/",
                 "/local/apps/Arrasa/", "/sd/apps/Arrasa/"] });
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
    recorde: false,
    trilha: null,           // emissor do rastro dos projeteis (unico)
    fumaca: null            // emissor curto do estopim (unico)
};

if (typeof __harness !== "undefined") __harness.arrasa = { M: M, E: E, A: A, G: G, processa: processa };

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

// nomes padrao da familia para os eventos-chave (o resto do jogo usa a
// tabela SND direto). E.audio.sfxTable e a mesma tabela lida por
// E.audio.sfx("nome").
E.audio.sfxTable["throw"] = SND.lanca;
E.audio.sfxTable.hit = SND.pancada;
E.audio.sfxTable.boom = SND.boom;
E.audio.sfxTable.win = SND.vitoria;
E.audio.sfxTable.fail = SND.derrota;

// paletas de fumaca do estopim (arrays fixos: o emitter troca a referencia
// ao acender, sem alocar por evento)
var FUMACA_OVO = [S.color(238, 238, 238), S.color(255, 205, 90), S.color(208, 208, 208)];
var FUMACA_TNT = [S.color(255, 170, 60), S.color(120, 110, 100), S.color(235, 235, 235)];

// rotulos da tela de fim (arrays fixos: E.ui.menu desenha a cada quadro)
var FIM_PROX = ["PRÓXIMA", "DE NOVO", "FASES"];
var FIM_SO = ["DE NOVO", "FASES"];

// --------------------------------------------------------------- save ----
// progressao pela E.level.progress (chave nova "nivel"): estrelas por fase
// e o desbloqueio sequencial. As chaves antigas est<fase> (estrelas) e
// pts<fase> (recorde) continuam sendo escritas/lidas — save de quem ja
// jogou nao se perde e a bateria do app segue conferindo est0/pts0.
var LISTA_FASES = [];
for (var nf = 0; nf < NIV.total; nf++) LISTA_FASES.push({ nome: NIV.fase(nf).nome });
var PROG = E.level.progress(LISTA_FASES, { save: "nivel" });

// migra o progresso antigo (estrelas eram a unica fonte do desbloqueio)
(function migraProgresso() {
    var maxLib = 0;
    for (var i = 0; i < NIV.total; i++) {
        var v = E.save.num("est" + i, 0);
        if (v > 0) {
            if (v > PROG.stars(i)) PROG.stars(i, v);
            if (i + 1 < NIV.total && i + 1 > maxLib) maxLib = i + 1;
        }
    }
    if (PROG.unlocked < maxLib) PROG.unlocked = maxLib;
})();

function estrelasDe(n) { return PROG.stars(n); }
function recordeDe(n) { return E.save.num("pts" + n, 0); }
function liberada(n) { return n === 0 || n <= PROG.unlocked; }
function totalEstrelas() { return PROG.totalStars(); }

// texto da lista: nome da fase + estrelas do NVS em ASCII (as fontes cobrem
// Latin-1; nada de emoji). Bloqueada leva "[x]" — o rotulo curto cabe na
// largura da lista (a fonte body da UI nao encolhe sozinha)
function rotuloFase(n) {
    var st = estrelasDe(n), s = "";
    for (var k = 0; k < 3; k++) s += k < st ? "*" : "-";
    return (n + 1) + " " + NIV.fase(n).nome + " " + s;
}
function itensFases() {
    var itens = [], n;
    // desbloqueadas na frente (o progresso e sequencial: e um prefixo)
    for (n = 0; n < NIV.total; n++) {
        if (liberada(n)) itens.push({ label: rotuloFase(n), value: n });
    }
    for (n = 0; n < NIV.total; n++) {
        if (!liberada(n)) {
            itens.push({ label: (n + 1) + " " + NIV.fase(n).nome + " [x]",
                         value: n, disabled: true });
        }
    }
    return itens;
}

// pick da lista de fases: comeca a fase (a trava e re-checada aqui — a
// versao 1.0.1 da lista nao filtra item disabled sozinha)
function iniciaFase(n) {
    if (!liberada(n)) { E.audio.sfx("bad"); return; }
    E.audio.sfx("ok");
    G.fase = n;
    G.retomar = false;
    G.fimT = -1;
    G.rastroDesenhado = 0;
    E.goto("jogando", { transition: "wipe", ms: 300 });
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

// rastro dos projeteis: UM emissor para a partida inteira (o follow le o
// corpo do M.tiro) — nada de emitter novo por lance, e o pool de 140 so
// recebe ~7 particulas vivas por vez (rate 20 x life 0,3). O ponto devolvido
// e reaproveitado (o follow le na hora; alocar por quadro e GC no Duktape).
var POS_TIRO = { x: 0, y: 0 };
function posTrilha() {
    var t = M.tiro;
    if (!t || t.estado !== "voando" || t.idx < 0 || !M.s) return null;
    var tipo = t.tipo;
    if (tipo !== "bumerangue" && tipo !== "bomba" && tipo !== "pedra" && tipo !== "pedrao") return null;
    var c = M.corpos[t.idx];
    if (!c) return null;
    var em = G.trilha;
    if (em) {
        em.opts.color = tipo === "bomba" ? S.color(255, 160, 70) :
                        tipo === "bumerangue" ? S.color(150, 230, 90) : S.color(214, 202, 178);
    }
    var o = t.idx * M.NS;
    POS_TIRO.x = A.sx(M.s[o]);
    POS_TIRO.y = A.sy(M.s[o + 1]);
    return POS_TIRO;
}

// fumaca curta da chocadeira/TNT: outro emissor UNICO, desligado em
// repouso; acender so reposiciona e zera o acumulador (duration 260 ms)
function criaEfeitos() {
    if (!G.trilha) {
        G.trilha = E.fx.trail(posTrilha, { rate: 20, life: 0.3,
                           size: Math.max(1, A.ESC * 1.3) });
    }
    if (!G.fumaca) {
        G.fumaca = E.fx.emitter({ x: 0, y: 0, rate: 30, duration: 260, life: 0.42,
                     size: Math.max(1, A.ESC * 1.2), colors: FUMACA_OVO,
                     speed: 8 * A.ESC, speed2: 34 * A.ESC, grav: -26 * A.ESC,
                     spread: Math.PI * 2 });
        G.fumaca.on = false;
    }
}
function acende(x, y, paleta) {
    var em = G.fumaca;
    if (!em) return;
    em.opts.x = A.sx(x);
    em.opts.y = A.sy(y);
    em.opts.colors = paleta || FUMACA_OVO;
    em.t = 0;
    em.acc = 0;
    em.on = true;
}

function processa(evs) {
    var somQuebra = false;
    for (var i = 0; i < evs.length; i++) {
        var ev = evs[i];
        if (ev.t === "lancou") {
            E.audio.sfx("throw");
            G.vib = 7; G.vibT = 0;
            G.filaSuja = true;
        } else if (ev.t === "impacto") {
            E.audio.sfx("hit");
            poeira(ev.x, ev.y, 7, S.color(170, 150, 120));
            E.fx.ring(A.sx(ev.x), A.sy(ev.y), { r0: 3 * A.ESC, speed: 80 * A.ESC,
                       color: C.texto, life: 0.28 });
            // a bomba acende o estopim no primeiro toque (a TNT tem o dela)
            if (M.tiro && M.tiro.tipo === "bomba") acende(ev.x, ev.y, FUMACA_TNT);
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
            E.audio.sfx("boom");
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
            acende(ev.x, ev.y, FUMACA_OVO);
        } else if (ev.t === "racha") {
            E.audio.sfx(SND.racha);
            E.fx.ring(A.sx(ev.x), A.sy(ev.y), { r0: 3 * A.ESC, speed: 70 * A.ESC, color: S.color(90, 200, 255), life: 0.25 });
        } else if (ev.t === "pancada") {
            if (ev.dv > 160) poeira(ev.x, ev.y, 3, A.corMat(ev.mat));
            // TNT levando pancada: estopim aceso (fumaca curta no ponto)
            if (ev.mat === "tnt" && ev.dv > 200) acende(ev.x, ev.y, FUMACA_TNT);
        } else if (ev.t === "arma") {
            G.filaSuja = true;
        } else if (ev.t === "vitoria") {
            G.fimT = 0;
            E.audio.sfx("win");
            if (ev.bonus > 0) {
                E.fx.popText(A.sx(30), A.sy(M.GROUND - 30), "+" + ev.bonus, { color: C.ouro, ts: "label", life: 1.4 });
            }
            G.filaSuja = true;
        } else if (ev.t === "derrota") {
            G.fimT = 0;
            E.audio.sfx("fail");
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
    // projeteis em voo (e os rachados da tripla): o tiro principal com
    // E.combat.shot e desenhado pelo drawShots (o espelho segue o corpo)
    var t = M.tiro;
    if (t && (t.estado === "voando" || t.estado === "assentando")) {
        for (k = -1; k < t.extras.length; k++) {
            i = k < 0 ? t.idx : t.extras[k];
            if (i < 0) continue;
            if (k < 0 && t.shot && !t.shot.dead) continue;
            c = M.corpos[i];
            o = i * NS;
            if (!c || !(s[o + 5] & 1)) continue;
            b = A.tiro(c.tipo, s[o], s[o + 1], s[o + 2], M.t);
            D.add(b.x, b.y, b.w, b.h);
        }
    }
}

// projeteis do E.combat: o shot da vez desenha o mesmo sprite do corpo
// fisico (a pose vem do solver, sincronizada no step do mundo)
function desenhaShots() {
    if (!E.combat.shots().length) return;
    E.combat.drawShots(function (s) {
        if (s.dead || !s.tipo) return;
        var b = A.tiro(s.tipo, s.x, s.y, s.ang || 0, M.t);
        D.add(b.x, b.y, b.w, b.h);
    });
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
        },
        update: function () {
            if (!this.btn) return;
            if (this.btn.length > 1 && E.hit(this.btn[0])) {
                E.audio.sfx(SND.ok);
                E.goto("mapa", { transition: "fade", ms: 300 });
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
            // o rei do titulo usa o quadro grande do atlas (ai1); sem atlas,
            // cai no goblin procedural do tamanho do corpo
            var rr = A.temAtlas ? 20 : 10;
            A.goblin({ k: "goblin", r: rr, tipo: "rei", hp: 1, hp0: 1 }, 262, M.GROUND - rr, -0.1);
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
        enter: function () {
            this.voltar = null;
            // itens montados na entrada (estrelas frescas do NVS); a lista e
            // retida e o draw devolve o tap no mesmo quadro
            this.lst = E.ui.list({ items: itensFases(), row: u(28),
                                   onPick: function (v) { iniciaFase(v); } });
        },
        update: function () {
            // lista retida e cena static: sem pedir redraw no toque ela nao
            // recebe o justDown/justUp (o arrasto precisa do down todo)
            if (E.input.down || E.input.justUp) E.redraw();
            if (this.voltar && E.hit(this.voltar)) {
                E.audio.sfx("ok");
                E.goto("titulo", { transition: "fade", ms: 250 });
            }
        },
        draw: function () {
            A.fundoInteiro();
            E.gfx.text("ESCOLHA A FASE", W / 2, u(26), { align: "center", valign: "middle",
                       ts: "label", color: C.ouro, screen: true });
            E.gfx.text(totalEstrelas() + "/" + (NIV.total * 3) + " estrelas", W / 2, u(43),
                       { align: "center", valign: "middle", ts: "tiny", color: C.texto, screen: true });
            var y0 = u(56), lh = H - y0 - u(54);
            this.lst.draw(u(10), y0, W - u(20), lh);
            var bw = Math.min(u(120), W - u(40));
            this.voltar = botao("VOLTAR", Math.round((W - bw) / 2), H - u(42), bw, u(26), false);
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
            criaEfeitos();
            if (G.fumaca) G.fumaca.on = false;
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
                if (G.fimT > 1.4) { E.goto("fim", { transition: "iris", ms: 450 }); return; }
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
            desenhaShots();
            desenhaEstilingue(mexe);
            desenhaBanner();
            E.fx.draw();
            desenhaHUD();
        }
    },

    pausa: {
        static: true,
        enter: function () { E.audio.stop(); this.act = null; },
        update: function () {
            // o veu/menu e desenhado no draw (immediate): a cena static
            // precisa do redraw enquanto o dedo esta na tela
            if (E.input.down || E.input.justUp) E.redraw();
            var act = this.act;
            if (!act) return;
            this.act = null;
            E.audio.sfx("ok");
            if (act === "resume") {
                G.retomar = true;
                E.goto("jogando");
            } else if (act === "restart") {
                G.retomar = false;
                E.data.musicPos = undefined;
                E.goto("jogando");
            } else if (act === "quit") {
                G.retomar = false;
                E.data.musicPos = undefined;
                E.goto("mapa", { transition: "fade", ms: 250 });
            }
        },
        draw: function () {
            // E.ui.pause: veu escuro sobre o jogo congelado + Continuar/
            // Recomecar/Sair; devolve a acao no quadro do tap
            this.act = E.ui.pause();
        }
    },

    fim: {
        static: true,
        enter: function () {
            E.audio.stop();
            this.t = 0;
            this.act = null;
            G.estrelasVistas = 0;
            var est = M.estrelas();
            G.recorde = false;
            if (M.venceu) {
                // E.level.progress guarda a nota e desbloqueia a seguinte;
                // o espelho est<fase> mantem o formato antigo do save
                var antes = PROG.stars(G.fase);
                PROG.complete(G.fase, est);
                if (est > antes) E.save.set("est" + G.fase, est);
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
            if (this.t < 0.6 || !this.act) return;   // engole o toque do lance
            var act = this.act;
            this.act = null;
            E.audio.sfx("ok");
            var prox = M.venceu && G.fase + 1 < NIV.total;
            if (act === FIM_PROX[0]) {               // PROXIMA
                G.retomar = false;
                G.fase++;
                E.goto("jogando", { transition: "wipe", ms: 300 });
            } else if (act === FIM_SO[0]) {          // DE NOVO
                G.retomar = false;
                if (prox) E.goto("jogando", { transition: "wipe", ms: 300 });
                else E.goto("mapa", { transition: "fade", ms: 300 });
            } else if (act === FIM_SO[1]) {          // FASES
                E.goto("mapa", { transition: "fade", ms: 300 });
            }
        },
        draw: function () {
            var pw = Math.min(u(200), W - u(24)), ph = u(210);
            var px = Math.round((W - pw) / 2), py = Math.round((H - ph) / 2);
            painel(px, py, pw, ph);
            var ok = M.venceu;
            E.gfx.text(ok ? "FASE LIMPA!" : "OS GOBLINS VENCERAM", W / 2, py + u(18), { align: "center",
                       valign: "middle", px: u(18), fit: pw - u(16), color: ok ? C.ouro : S.color(255, 120, 90), screen: true });
            for (var k = 0; k < 3; k++) {
                var cor = ok && k < G.estrelasVistas ? C.ouro : S.mixColor(C.painel, C.texto, 22);
                A.estrela(W / 2 + (k - 1) * u(34), py + u(52) - (k === 1 ? u(6) : 0), u(k === 1 ? 15 : 12), cor, C.sombra);
            }
            E.gfx.text(String(M.pontos), W / 2, py + u(90), { align: "center", valign: "middle",
                       px: u(24), color: C.texto, screen: true });
            E.gfx.text(G.recorde ? "NOVO RECORDE!" : "recorde " + recordeDe(G.fase), W / 2, py + u(108),
                       { align: "center", valign: "middle", ts: "small",
                         color: G.recorde ? C.ouro : S.mixColor(C.painel, C.texto, 60), screen: true });
            // botoes pela E.ui.menu: mesmo item da lista/pausa e o tap volta
            // no proprio quadro do draw (o update da cena aplica no seguinte)
            var bw = pw - u(30), bx = Math.round((W - bw) / 2), by = py + u(126);
            this.act = E.ui.menu(ok && G.fase + 1 < NIV.total ? FIM_PROX : FIM_SO,
                                 { x: bx, y: by, w: bw, row: u(28) });
        }
    }
}, "titulo");
