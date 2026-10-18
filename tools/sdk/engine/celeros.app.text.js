// app.text.js — CelerKit TEXT (dep "celeros.app.text"): saneamento Latin-1
// (as fontes so cobrem U+0020..U+00FF: emoji e simbolos tipograficos da IA/
// da web viram nada) e o leitor rolante pronto (o viewer do Help/Ajustes).
// Decora o core no require:
//
//   var A = require("celeros.app");
//   require("celeros.app.text");
//   A.text.fit(respostaDaIA);          // fora do Latin-1 some (\n fica)
//   A.text.viewer("Changelog", function () { return textoLongo; });
//
// O viewer e BLOQUEANTE (laco proprio, como os dialogos nativos): so volta
// quando o usuario toca no voltar. Rolagem por inercia; texto medido uma
// unica vez por abertura.

var A = require('celeros.app');

A.text = {
    version: '1.0.1',

    // fora do Latin-1 (e fora do \n) some — as fontes nao tem o glifo
    fit: function (s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/[^\u0000-\u00ff\n]/g, '');
    },

    // quantas linhas o texto ocupa na largura w (papel 'body' por default)
    lines: function (s, w, role) {
        try { return UI.measureWrap(s, w, role || 'body'); } catch (e) { return 1; }
    },

    // Leitor rolante: header com voltar, texto medido na largura do corpo.
    // getText() devolve o texto na hora (o app pode carregar de arquivo).
    viewer: function (title, getText) {
        var T = A.T || System.theme();
        var s = A.text.fit(getText());
        UI.resetScroll('kit:leitor');
        UI.invalidate();   // 1a moldura inteira: aberto apos um overlay, o
        var top = 48;      // spinner dele queimava no framebuffer
        var h = 320 - top - 6;
        for (;;) {
            UI.begin(T.bg);
            if (UI.header(title, { back: true })) return;
            var contentH = UI.measureWrap(s, 216, 'body');
            var off = UI.scrollBegin('kit:leitor', 4, top, 232, h, Math.max(h, contentH + 8));
            // o slot do texto muda com o offset (nova coordenada y): redesenha
            UI.text(s, 12, top + 4 - off, { w: 216, lines: 64 });
            UI.scrollEnd();
            UI.end(30);
        }
    }
};

A._mods.push('text');

module.exports = A;
