// game.node.js — CelerGame NODE (dep "celeros.game.node"): transform
// HIERARQUICO leve (pai/filho) com cache world, no molde do Object do
// deki-engine — sem componente, sem matriz, so rotacao/escala/posicao 2D.
// Decora o core no require:
//
//   var E = require("celeros.game");
//   require("celeros.game.node");
//   E.node.attach(canhao, torre, { ox: 0, oy: -6 });     // canhao segue a torre
//   // no update, depois de mover a torre:  E.node.tick();
//   E.spr.stamp("canhao", canhao.x, canhao.y, { angle: E.node.rotOf(canhao) });
//
// O FILHO TEM x/y DE MUNDO: cada tick escreve e.x/e.y (e _wx/_wy) a partir
// do offset local (ox/oy), rotacao e escala — o desenho, a colisao e a
// camada suja continuam lendo e.x/e.y como sempre. Posicao de filho se muda
// por E.node.setPos, nao escrevendo e.x a mao (o tick sobrescreve).
//
// Desvio consciente do deki: o tick RECALCULA todos os nos (sem flag de
// sujo). O deki depende de setters para marcar sujo e tem bugs conhecidos de
// propagacao (RemoveChild que nao suja a subarvore); aqui o jogo move o pai
// como quiser (inclusive escrevendo e.x) e o proximo tick acerta. O custo e'
// uma cadeia de multiplicacoes por no — com o caminho rapido sem sin/cos
// quando a rotacao world do pai e' exatamente 0 (a mesma ideia do
// Object.cpp:536-542 deles). Nao use no para milhares de particulas.
//
// Escala NAO uniforme em pai rotacionado nao e' representavel por
// (rotacao, escala) — o resultado combina como no deki e pode cisalhar.

var E = require('celeros.game');
var D2R = 0.017453292519943295;

var _nos = [];    // entidades com no (ordem de anexacao)

function novo(e) {
    var no = e._no;
    if (!no) {
        no = e._no = { p: null, ox: 0, oy: 0, rot: 0, sx: 1, sy: 1, ch: [] };
        _nos.push(e);
    }
    return no;
}

// pai e' o proprio filho ou descendente dele? (ciclo) — checado em TODO
// attach, nao so no "setParent" (o deki deixa AddChild passar)
function ciclo(pai, filho) {
    for (var p = pai; p; p = p._no ? p._no.p : null) {
        if (p === filho) return true;
    }
    return false;
}

function calc(e) {
    var no = e._no, p = no.p, ox = no.ox, oy = no.oy;
    var psx = 1, psy = 1, pr = 0;
    if (p) {
        if (p._wx === undefined) p._wx = p.x;
        if (p._wy === undefined) p._wy = p.y;
        psx = p._wsx === undefined ? 1 : p._wsx;
        psy = p._wsy === undefined ? 1 : p._wsy;
        pr = p._wr || 0;
        if (pr === 0) {
            e._wx = p._wx + ox * psx;
            e._wy = p._wy + oy * psy;
        } else {
            var r = pr * D2R, c = Math.cos(r), s = Math.sin(r);
            var lx = ox * psx, ly = oy * psy;
            e._wx = p._wx + (c * lx - s * ly);
            e._wy = p._wy + (s * lx + c * ly);
        }
        e.x = e._wx;
        e.y = e._wy;
    } else {
        e._wx = e.x;
        e._wy = e.y;
    }
    e._wr = (no.rot || 0) + pr;
    e._wsx = (no.sx === undefined ? 1 : no.sx) * psx;
    e._wsy = (no.sy === undefined ? 1 : no.sy) * psy;
    var ch = no.ch;
    for (var i = 0; i < ch.length; i++) calc(ch[i]);
}

E.node = {
    version: '1.0.0',

    // filho passa a seguir pai; o = {ox, oy, rot (graus), sx, sy}. Devolve
    // false em ciclo (avisa 1x) ou entidade invalida
    attach: function (filho, pai, o) {
        if (!filho || !pai || filho === pai) return false;
        if (ciclo(pai, filho)) {
            E._warn('node: ciclo — ' + (pai.nome || pai.tipo || 'pai') + ' ja e descendente do filho');
            return false;
        }
        var no = novo(filho);
        if (no.p) {
            var irmaos = novo(no.p).ch;
            var k = irmaos.indexOf(filho);
            if (k >= 0) irmaos.splice(k, 1);
        }
        no.p = pai;
        novo(pai).ch.push(filho);
        if (o) {
            if (o.ox !== undefined) no.ox = o.ox;
            if (o.oy !== undefined) no.oy = o.oy;
            if (o.rot !== undefined) no.rot = o.rot;
            if (o.sx !== undefined) no.sx = o.sx;
            if (o.sy !== undefined) no.sy = o.sy;
        }
        E.node.tick();   // aplica ja: o primeiro draw nao sai na posicao velha
        return true;
    },

    // solta o filho; ele fica onde esta (x/y ja sao de mundo)
    detach: function (filho) {
        var no = filho && filho._no;
        if (!no || !no.p) return false;
        var ch = no.p._no ? no.p._no.ch : null;
        if (ch) {
            var k = ch.indexOf(filho);
            if (k >= 0) ch.splice(k, 1);
        }
        no.p = null;
        no.ox = 0; no.oy = 0; no.rot = 0; no.sx = 1; no.sy = 1;
        E.node.tick();
        return true;
    },

    // offset local (e rotacao, opcional) do filho — setter COMBINADO, para
    // nao calcular duas vezes; o pai se move escrevendo e.x/e.y
    setPos: function (e, ox, oy, rot) {
        var no = e && e._no;
        if (!no) return false;
        if (ox !== undefined) no.ox = ox;
        if (oy !== undefined) no.oy = oy;
        if (rot !== undefined) no.rot = rot;
        return true;
    },

    // recalcula o mundo (pai antes de filho). E._modTicks ja chama isto
    // antes do update da cena; quem depende de zero atraso chama depois de
    // mover o pai (no fim do update)
    tick: function () {
        for (var i = 0; i < _nos.length; i++) {
            var e = _nos[i];
            if (e._no && !e._no.p) calc(e);
        }
    },

    // leituras de mundo (fora de um no, devolvem o proprio e.x/e.y)
    wx: function (e) { return e._wx !== undefined ? e._wx : e.x; },
    wy: function (e) { return e._wy !== undefined ? e._wy : e.y; },
    rotOf: function (e) { return e._wr || 0; },
    scaleXOf: function (e) { return e._wsx === undefined ? 1 : e._wsx; },
    scaleYOf: function (e) { return e._wsy === undefined ? 1 : e._wsy; },
    parentOf: function (e) { return e && e._no ? e._no.p : null; },
    childrenOf: function (e) { return e && e._no ? e._no.ch : null; },
    // quantos nos estao registrados (diagnostico)
    count: function () { return _nos.length; }
};

E._modTicks.push(function () { E.node.tick(); });

E._mods.push('node');

module.exports = E;
