// game.tilemap.js — CelerGame TILEMAP (dep "celeros.game.tilemap"): grade
// de celulas com repintura SUJA sobre a camada E.dirty. Decora o core no
// require (mesmo E de celeros.game):
//
//   var E = require("celeros.game");
//   require("celeros.game.tilemap");
//   var mapa = E.tilemap({ cols: 15, rows: 13, cell: 16, paint: paintCell });
//   E.dirty.enable(function (x, y, w, h) { mapa.markRect(x, y, w, h); });
//   // 1a linha do draw da cena: mapa.flush()

var E = require('celeros.game');

// o cenario (chao, blocos) fica no quadro persistente e so as celulas
// marcadas repintam no flush() — por baixo do que se moveu (E.dirty com
// painter markRect) ou do que mudou (bloco quebrado). paint(c, r, x, y,
// w, h) desenha UMA celula inteira.
E.tilemap = function (o) {
    var cols = o.cols, rows = o.rows;
    var cw = o.cw || o.cell, ch = o.ch || o.cell;
    var ox = o.ox || 0, oy = o.oy || 0;
    var marks = [];
    var list = [];
    for (var i = 0; i < cols * rows; i++) marks.push(0);
    var m = {
        cols: cols, rows: rows, cw: cw, ch: ch, ox: ox, oy: oy,
        paint: o.paint,
        mark: function (c, r) {
            if (c < 0 || r < 0 || c >= cols || r >= rows) return;
            var k = r * cols + c;
            if (marks[k]) return;
            marks[k] = 1;
            list.push(k);
        },
        // caixa em PIXELS de tela: marca as celulas que ela toca
        markRect: function (x, y, w, h) {
            var c0 = Math.floor((x - ox) / cw), c1 = Math.floor((x + w - 1 - ox) / cw);
            var r0 = Math.floor((y - oy) / ch), r1 = Math.floor((y + h - 1 - oy) / ch);
            if (c0 < 0) c0 = 0;
            if (r0 < 0) r0 = 0;
            if (c1 >= cols) c1 = cols - 1;
            if (r1 >= rows) r1 = rows - 1;
            for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) m.mark(c, r);
        },
        all: function () {
            for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) m.mark(c, r);
        },
        dirty: function () { return list.length; },
        // repinta as celulas marcadas (devolve quantas). O que o paint
        // desenha e FUNDO: nao entra na camada suja (senao cada bloco
        // repintado se apagaria no quadro seguinte, em loop)
        flush: function () {
            var n = list.length;
            E.dirty._mute++;
            for (var j = 0; j < n; j++) {
                var k = list[j];
                marks[k] = 0;
                var c = k % cols, r = (k - c) / cols;
                m.paint(c, r, ox + c * cw, oy + r * ch, cw, ch);
            }
            E.dirty._mute--;
            list.length = 0;
            return n;
        },
        cellAt: function (x, y) {
            var c = Math.floor((x - ox) / cw), r = Math.floor((y - oy) / ch);
            if (c < 0 || r < 0 || c >= cols || r >= rows) return null;
            return { c: c, r: r };
        }
    };
    return m;
};
E.tilemap.version = '1.0.0';

E._mods.push('tilemap');

module.exports = E;
