// niveis.js — as fases do Arrasa! (mundo 320 de largura, chao em y=290).
// Cada fase e uma funcao que monta as pecas com o construtor `b`: alturas
// contadas a partir do CHAO (base 0 = apoiado na grama) e x pelo centro.
// Cada metodo devolve a altura do TOPO da peca — empilhar e encadear:
//
//   var t = b.moldura(230, 0, 44, 30, "madeira");   // 2 pilares + tabua
//   b.goblin(230, t);                                // goblin em cima
//
// As pecas nascem ENCOSTADAS (sem folga): o solver assenta a pilha no
// primeiro meio segundo sem dano (carencia do mundo.js).

var GROUND = 290;
var PILAR = 6;     // espessura padrao de pilar e tabua

function construtor() {
    var pecas = [];
    var b = {
        pecas: pecas,
        // caixa com centro x, base apoiada em `base`
        caixa: function (x, base, w, h, mat, ang) {
            pecas.push({ k: "box", x: x, y: GROUND - base - h / 2, w: w, h: h,
                         mat: mat, a: ang || 0 });
            return base + h;
        },
        pilar: function (x, base, h, mat) { return b.caixa(x, base, PILAR, h, mat); },
        tabua: function (x, base, w, mat) { return b.caixa(x, base, w, PILAR, mat); },
        // dois pilares nas pontas + tabua por cima
        moldura: function (x, base, w, h, mat, matTopo) {
            b.pilar(x - w / 2 + PILAR / 2, base, h, mat);
            b.pilar(x + w / 2 - PILAR / 2, base, h, mat);
            return b.tabua(x, base + h, w, matTopo || mat);
        },
        bloco: function (x, base, s, mat) { return b.caixa(x, base, s, s, mat); },
        tnt: function (x, base) { return b.caixa(x, base, 14, 14, "tnt"); },
        // plataforma de rocha FIXA (nao cai, nao quebra)
        rocha: function (x, base, w, h) { return b.caixa(x, base, w, h, "rocha"); },
        goblin: function (x, base) {
            pecas.push({ k: "goblin", x: x, y: GROUND - base - 7, r: 7, tipo: "goblin" });
            return base + 14;
        },
        rei: function (x, base) {
            pecas.push({ k: "goblin", x: x, y: GROUND - base - 10, r: 10, tipo: "rei" });
            return base + 20;
        }
    };
    return b;
}

var FASES = [
    {
        nome: "Primeiro estrago",
        tiros: ["pedra", "pedra"],
        monta: function (b) {
            b.goblin(232, 0);
            var t = b.moldura(232, 0, 44, 30, "madeira");
            b.goblin(232, t);
        }
    },
    {
        nome: "Casinha",
        tiros: ["pedra", "flecha", "pedra"],
        monta: function (b) {
            var t = b.moldura(224, 0, 46, 28, "madeira");
            b.goblin(224, 0);
            var t2 = b.moldura(224, t, 46, 28, "madeira");
            b.goblin(224, t);
            b.goblin(224, t2);
            var v = b.bloco(282, 0, 16, "vidro");
            b.goblin(282, v);
        }
    },
    {
        nome: "Vidraçaria",
        tiros: ["tripla", "pedra", "tripla"],
        monta: function (b) {
            var t1 = b.moldura(196, 0, 34, 30, "vidro", "madeira");
            var t2 = b.moldura(236, 0, 34, 30, "vidro", "madeira");
            var t3 = b.moldura(276, 0, 34, 30, "vidro", "madeira");
            b.goblin(196, 0);
            b.goblin(276, 0);
            b.tabua(216, t1, 34, "vidro");
            b.tabua(256, t2, 34, "vidro");
            b.goblin(236, t2 + PILAR);
            b.goblin(276, t3);
        }
    },
    {
        nome: "Torre de pedra",
        tiros: ["pedra", "pedrao", "flecha"],
        monta: function (b) {
            var t1 = b.moldura(250, 0, 36, 32, "pedra", "madeira");
            b.goblin(250, 0);
            var t2 = b.moldura(250, t1, 36, 32, "pedra", "madeira");
            b.goblin(250, t1);
            var t3 = b.moldura(250, t2, 36, 28, "madeira");
            b.rei(250, t3);
            b.bloco(204, 0, 16, "pedra");
            b.bloco(296, 0, 16, "pedra");
        }
    },
    {
        nome: "Pólvora",
        tiros: ["pedra", "bomba", "chocadeira"],
        monta: function (b) {
            var t = b.moldura(214, 0, 40, 30, "madeira");
            b.tnt(214, 0);
            b.goblin(214, t);
            var t2 = b.moldura(268, 0, 44, 30, "vidro", "madeira");
            b.goblin(260, 0);
            b.tnt(276, 0);
            var t3 = b.moldura(268, t2, 44, 26, "madeira");
            b.goblin(268, t3);
        }
    },
    {
        nome: "Fortaleza",
        tiros: ["pedrao", "bomba", "tripla", "flecha"],
        monta: function (b) {
            // base de pedra larga
            var t = b.moldura(206, 0, 36, 30, "pedra");
            var t2 = b.moldura(254, 0, 36, 30, "pedra");
            b.moldura(296, 0, 28, 30, "madeira");
            b.goblin(206, 0);
            b.goblin(254, 0);
            b.goblin(296, 0);
            // andar de madeira e vidro
            t = b.moldura(230, t, 84, 26, "madeira");
            b.goblin(214, t2);
            b.tnt(248, t2);
            // torreao de vidro com o rei
            t = b.moldura(230, t, 30, 22, "vidro", "madeira");
            b.rei(230, t);
        }
    },
    {
        nome: "Penhasco",
        tiros: ["chocadeira", "tripla", "bomba", "pedrao"],
        monta: function (b) {
            var r = b.rocha(282, 0, 76, 46);
            b.goblin(200, 0);
            b.caixa(200, 14, 34, PILAR, "madeira");
            b.pilar(185, 0, 14, "madeira");
            b.pilar(215, 0, 14, "madeira");
            var t1 = b.moldura(268, r, 36, 30, "madeira");
            b.goblin(268, r);
            var t2 = b.moldura(268, t1, 36, 24, "vidro", "madeira");
            b.goblin(268, t1);
            b.rei(268, t2);
            b.tnt(304, r);
        }
    },
    {
        nome: "Linha de frente",
        tiros: ["flecha", "flecha", "tripla"],
        monta: function (b) {
            // fileira longa e baixa: a flecha rasga de ponta a ponta
            for (var i = 0; i < 6; i++) {
                var x = 172 + i * 24;
                b.pilar(x, 0, 24, i % 2 ? "madeira" : "vidro");
                if (i < 5) {
                    b.goblin(x + 12, 0);
                    b.caixa(x + 12, 24, 24, PILAR, "madeira");
                }
            }
            b.goblin(196, 30);
            b.goblin(268, 30);
        }
    },
    {
        nome: "Atrás do muro",
        tiros: ["bumerangue", "chocadeira", "bumerangue", "pedra"],
        monta: function (b) {
            // muralha de rocha: de frente nao passa; o bumerangue volta
            // por tras e a chocadeira bombardeia de cima
            b.rocha(196, 0, 14, 66);
            var t = b.moldura(248, 0, 40, 30, "madeira");
            b.goblin(248, 0);
            b.goblin(248, t);
            var t2 = b.moldura(292, 0, 30, 24, "vidro", "madeira");
            b.goblin(292, 0);
            b.bloco(292, t2, 14, "pedra");
        }
    },
    {
        nome: "Castelo do Rei",
        tiros: ["pedrao", "bomba", "chocadeira", "flecha", "bumerangue"],
        monta: function (b) {
            // muralha da frente
            b.bloco(178, 0, 14, "pedra");
            b.bloco(178, 14, 14, "pedra");
            b.goblin(196, 0);
            // corpo do castelo: tres vaos de pedra
            var t = b.moldura(222, 0, 36, 32, "pedra");
            b.moldura(262, 0, 36, 32, "pedra");
            b.moldura(300, 0, 30, 32, "madeira");
            b.goblin(222, 0);
            b.tnt(262, 0);
            b.goblin(300, 0);
            // segundo andar
            var t2 = b.moldura(242, t, 76, 28, "madeira");
            b.goblin(228, t);
            b.goblin(258, t);
            // torre do rei
            var t3 = b.moldura(242, t2, 32, 26, "pedra", "vidro");
            b.goblin(242, t2);
            b.rei(242, t3);
        }
    }
];

exports.GROUND = GROUND;
exports.total = FASES.length;
exports.fase = function (n) { return FASES[n]; };
// pecas da fase n (lista nova a cada chamada: o mundo consome)
exports.montar = function (n) {
    var b = construtor();
    FASES[n].monta(b);
    return b.pecas;
};
