// CelerKit layout. Calcule os retangulos ao montar a tela e reutilize-os
// no desenho e no toque. As coordenadas de widgets sao sempre virtuais.
var A = require('celeros.app');
require('celeros.app.caps');

function pixels(value) {
    return isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

// Primeiro pixel da divisao i, sem contar o espaco entre celulas.
// Usar as duas bordas distribui o resto da divisao ate a ultima celula.
function edge(length, count, gap, i) {
    return Math.floor((length - (count - 1) * gap) * i / count) + gap * i;
}

// Mesmo com gap exagerado, preserve um pixel por celula quando couber.
function fitGap(length, count, gap) {
    if (count === 1) return 0;
    return Math.min(gap, Math.max(0, Math.floor((length - count) / (count - 1))));
}

A.layout = {
    version: '1.0.0',

    bounds: function (o) {
        o = o || {};
        var caps = A.caps.probe();
        var w = System.screenWidth(), h = System.screenHeight();
        var pad = o.pad === undefined ? 4 : pixels(o.pad);
        var insetX = Math.ceil(caps.inset * w / 240);
        var insetY = Math.ceil(caps.inset * caps.w / 240 * h / caps.h);
        var x = Math.min(Math.floor(w / 2), Math.max(pad, insetX));
        var y = Math.min(h, Math.max(insetY, pixels(o.top) + pad));
        var bottom = Math.max(insetY, pixels(o.bottom) + pad);
        return { x: x, y: y, w: w - 2 * x, h: Math.max(0, h - y - bottom) };
    },

    // minWidthPx e a largura minima de uma coluna no painel fisico.
    columns: function (rect, minWidthPx, gap) {
        var scale = A.caps.probe().w / System.screenWidth();
        var spacing = pixels(gap);
        var minWidth = Math.max(1, Math.ceil(pixels(minWidthPx) / scale));
        return Math.max(1, Math.floor((rect.w + spacing) / (minWidth + spacing)));
    },

    cell: function (rect, cols, rows, index, gap) {
        if (cols !== pixels(cols) || rows !== pixels(rows) || !cols || !rows ||
            index !== pixels(index) || index >= cols * rows) {
            throw new RangeError('layout.cell: grade ou indice invalido');
        }
        var col = index % cols, row = Math.floor(index / cols);
        var spacing = pixels(gap);
        var gx = fitGap(rect.w, cols, spacing);
        var gy = fitGap(rect.h, rows, spacing);
        var x = edge(rect.w, cols, gx, col), y = edge(rect.h, rows, gy, row);
        return { x: rect.x + x, y: rect.y + y,
                 w: edge(rect.w, cols, gx, col + 1) - gx - x,
                 h: edge(rect.h, rows, gy, row + 1) - gy - y };
    }
};

A._mods.push('layout');
module.exports = A;
