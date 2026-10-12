// pista.js — regras de nascimento da pista do Neon Surfer (API 30: modulo
// do app, require("pista")). Funcoes puras sobre a lista de entidades:
// nada de estado do jogo aqui — o fuzz do test/sdk prova os invariantes
// de justica e o main.js so executa o que sai daqui.
//
// Todos os obstaculos andam juntos (mesma velocidade do mundo), entao
// distancia relativa nunca muda: o que e justo no nascimento e justo na
// passada inteira. Invariantes:
//   I1 mesma faixa: trem fica a >= gMesmo de qualquer entidade da faixa
//      (o jogador entra, pega a moeda e sai antes do proximo trem)
//   I2 faixas vizinhas: trens com janelas em Y sobrepostas ficam a >=
//      gTeia (sempre ha corredor pra passar ENTRE eles — a teia)
//   I3 moeda alcancavel: nasce so em faixa cujo trem mais proximo clareia
//      antes dela ou chega depois com espaco de saida
//   I4 saturacao: quando nenhuma posicao justa resta, nasce NADA (null) —
//      segundo quieto tambem e jogo; pista impossivel nao

var PROF_TREM = 80;      // altura do trem
var PROF_MOEDA = 20;     // altura da moeda
var TETO_ATRASO = 460;   // pushes somam nisso e desiste (hudH - 460)

function janela(e) {
    return { a: e.y, b: e.y + (e.h || PROF_MOEDA) };
}

module.exports = {
    version: '1.0.0',

    // Resolve o nascimento de um trem em `lane`: comeca no topo e, a cada
    // entidade que fere I1/I2, empurra o nascimento pra CIMA (chega mais
    // tarde = atraso). Empurrar pra cima so afasta de quem esta abaixo e
    // pode no maximo chegar em quem esta acima — o laco reconverge e o
    // teto encerra. cfg: {speed, hudH, rnd?}
    trem: function (ents, lane, cfg) {
        var gMesmo = cfg.speed * 0.55 + 70;   // entra-e-sai na propria faixa
        var gTeia = cfg.speed * 0.45 + 50;    // corredor entre faixas vizinhas
        var y = cfg.hudH - PROF_TREM;
        for (var pass = 0; pass < 10; pass++) {
            var pior = null;
            for (var i = 0; i < ents.length; i++) {
                var e = ents[i];
                var mesma = e.lane === lane;
                var vizinha = !mesma && e.type === "train" &&
                              (e.lane === lane - 1 || e.lane === lane + 1);
                if (!mesma && !vizinha) continue;
                var g = mesma ? gMesmo : gTeia;
                var w = janela(e);
                if (y < w.b + g && y + PROF_TREM > w.a - g) {
                    var alvo = w.a - g - PROF_TREM;
                    if (pior === null || alvo < pior) pior = alvo;
                }
            }
            if (pior === null) break;
            y = pior;
            if (y < cfg.hudH - TETO_ATRASO) return null;
        }
        return { type: "train", lane: lane, y: y, h: PROF_TREM };
    },

    // I3: a faixa esta segura pra receber moeda no intervalo [yTopo, yBase]
    // (gap >= minimo ja e corredor; o limite nao-estrito e o mesmo do trem)
    seguraPraMoeda: function (ents, lane, yTopo, yBase, cfg) {
        var g = cfg.speed * 0.55 + 70;
        for (var i = 0; i < ents.length; i++) {
            var e = ents[i];
            if (e.type !== "train" || e.lane !== lane) continue;
            var w = janela(e);
            if (!(w.a >= yBase + g || w.b <= yTopo - g)) return false;
        }
        return true;
    },

    // Politica do nascimento (uma decisao por chamada, rnd injetavel p/ o
    // teste): r<0.16 fileira de 3 moedas, r<0.24 moeda unica, senao trem.
    // Moeda so em faixa segura; sem faixa segura, o segundo e quieto. Sem
    // posicao justa pro trem, tenta moeda; nada justo, null. Devolve
    // {type: "fileira"|"coin"|"train", lane, y} ou null.
    nascer: function (ents, cfg) {
        var rnd = cfg.rnd || Math.random;
        var r = rnd();
        var querFileira = r < 0.16;
        var querMoeda = r < 0.24;
        var yFileira = cfg.hudH + 26;
        if (querFileira || querMoeda) {
            var ordem = [0, 1, 2];
            for (var i = 2; i > 0; i--) {
                var k = Math.floor(rnd() * (i + 1));
                var t = ordem[i]; ordem[i] = ordem[k]; ordem[k] = t;
            }
            for (var s = 0; s < 3; s++) {
                var ln = ordem[s];
                var yTopo = querFileira ? yFileira - 60 : yFileira - PROF_MOEDA;
                if (!this.seguraPraMoeda(ents, ln, yTopo, yFileira + PROF_MOEDA, cfg)) continue;
                if (querFileira) return { type: "fileira", lane: ln, y: yFileira };
                return { type: "coin", lane: ln, y: yFileira };
            }
            if (querFileira || querMoeda) return null;
        }
        var lane = Math.floor(rnd() * 3);
        var trem = this.trem(ents, lane, cfg);
        if (trem) return trem;
        // sem espaco pro trem: moeda numa faixa segura salva o segundo
        for (var s2 = 0; s2 < 3; s2++) {
            var ln2 = (lane + s2) % 3;
            if (this.seguraPraMoeda(ents, ln2, yFileira, yFileira + PROF_MOEDA, cfg))
                return { type: "coin", lane: ln2, y: yFileira };
        }
        return null;
    }
};
