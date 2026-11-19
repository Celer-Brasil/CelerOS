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
    version: '1.1.0',

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
    viewer: function (title, getText, area) {
        var T = A.T || System.theme();
        var s = A.text.fit(getText());
        UI.resetScroll('kit:leitor');
        UI.invalidate();
        var L = A.L || A.init().L;
        var box = area || { x: L.x, y: L.top, w: L.w, h: L.bottom - L.top };
        var w = box.w - 12;
        var contentH = UI.measureWrap(s, w, 'body') + 12;
        for (;;) {
            UI.begin(T.bg);
            if (UI.header(title, { back: true })) { UI.end(0); UI.invalidate(); return; }
            var off = UI.scrollBegin('kit:leitor', box.x, box.y, box.w, box.h, Math.max(box.h, contentH));
            // o slot do texto muda com o offset (nova coordenada y): redesenha
            UI.text(s, box.x + 6, box.y + 6 - off, { role: 'body', w: w, lines: 64 });
            UI.scrollEnd();
            UI.end(30);
        }
    }
};

A._mods.push('text');

module.exports = A;
