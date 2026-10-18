// game.tilemap.js — CelerGame TILEMAP (dep "celeros.game.tilemap"): grade
// de celulas com repintura SUJA sobre a camada E.dirty. Decora o core no
// require (mesmo E de celeros.game):
//
//   var E = require("celeros.game");
//   require("celeros.game.tilemap");
//   var mapa = E.tilemap({ cols: 15, rows: 13, cell: 16, paint: paintCell });
//   E.dirty.enable(function (x, y, w, h) { mapa.markRect(x, y, w, h); });
//   // 1a linha do draw da cena: mapa.flush()
//
// 1.1.0: camada de DADOS opcional (o.data: array cols*rows ou de linhas;
// get/set — set marca a celula sozinho), consulta de colisao (o.solid(v)
// + solidAt/rectSolid), cellRect e each.
// 1.2.0: fill(c, r, w, h, v) (sala, buraco, ponte numa linha) e find(v)
// (onde estao as chaves/portas).

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
    // dados: plano (cols*rows) ou linhas ([r][c] / strings) — sempre
    // guardado plano; sem data a grade e so de repintura (como na 1.0)
    var data = null;
    if (o.data) {
        data = [];
        var src = o.data;
        var rowsArr = src.length === rows && typeof src[0] !== 'number' &&
                      src[0] !== undefined && src[0].length !== undefined;
        for (var k0 = 0; k0 < cols * rows; k0++) {
            if (rowsArr) {
                var cc = k0 % cols, rr = (k0 - cc) / cols;
                data.push(src[rr][cc]);
            } else data.push(src[k0]);
        }
    }
    var solid = o.solid || null;
    var _rc = { x: 0, y: 0, w: 0, h: 0 };
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
        },
        // rect em PIXELS da celula (scratch reaproveitado: copie se guardar)
        cellRect: function (c, r) {
            _rc.x = ox + c * cw; _rc.y = oy + r * ch; _rc.w = cw; _rc.h = ch;
            return _rc;
        },
        // valor da celula (undefined fora da grade ou sem data)
        get: function (c, r) {
            if (!data || c < 0 || r < 0 || c >= cols || r >= rows) return undefined;
            return data[r * cols + c];
        },
        // muda o valor e MARCA a celula (o proximo flush repinta): bloco
        // quebrado e uma linha so. Devolve false fora da grade
        set: function (c, r, v) {
            if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
            if (!data) { data = []; for (var q = 0; q < cols * rows; q++) data.push(undefined); }
            var k = r * cols + c;
            if (data[k] === v) return true;
            data[k] = v;
            m.mark(c, r);
            return true;
        },
        // preenche o retangulo de celulas com v (set: marca o que mudou)
        fill: function (c, r, w, h, v) {
            for (var rr = r; rr < r + h; rr++) for (var cc = c; cc < c + w; cc++) m.set(cc, rr, v);
        },
        // celulas com valor v (ou fn(v, c, r) true): [{c, r}]
        find: function (v) {
            var out = [];
            if (!data) return out;
            var fn = typeof v === 'function' ? v : null;
            for (var k = 0; k < data.length; k++) {
                if (fn ? fn(data[k], k % cols, (k - k % cols) / cols) : data[k] === v) {
                    out.push({ c: k % cols, r: (k - k % cols) / cols });
                }
            }
            return out;
        },
        // fn(c, r, v) por celula, em linhas
        each: function (fn) {
            for (var r = 0; r < rows; r++) {
                for (var c = 0; c < cols; c++) fn(c, r, data ? data[r * cols + c] : undefined);
            }
        },
        // ponto em PIXELS cai numa celula solida? (o.solid(v) decide; sem
        // solid, solido = valor truthy). Fora da grade = solido quando
        // o.outside (default true — o mundo e fechado)
        solidAt: function (x, y) {
            var c = Math.floor((x - ox) / cw), r = Math.floor((y - oy) / ch);
            if (c < 0 || r < 0 || c >= cols || r >= rows) return o.outside !== false;
            var v = data ? data[r * cols + c] : undefined;
            return solid ? !!solid(v, c, r) : !!v;
        },
        // algum pixel do rect toca celula solida? (caixa de colisao do
        // heroi contra o mapa — testa as celulas cobertas, nao so os cantos)
        rectSolid: function (x, y, w, h) {
            var c0 = Math.floor((x - ox) / cw), c1 = Math.floor((x + w - 1 - ox) / cw);
            var r0 = Math.floor((y - oy) / ch), r1 = Math.floor((y + h - 1 - oy) / ch);
            for (var r = r0; r <= r1; r++) {
                for (var c = c0; c <= c1; c++) {
                    if (c < 0 || r < 0 || c >= cols || r >= rows) {
                        if (o.outside !== false) return true;
                        continue;
                    }
                    var v = data ? data[r * cols + c] : undefined;
                    if (solid ? solid(v, c, r) : v) return true;
                }
            }
            return false;
        }
    };
    return m;
};
E.tilemap.version = '1.2.0';

E._mods.push('tilemap');

module.exports = E;
