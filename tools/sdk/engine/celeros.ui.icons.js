// ui.icons.js — CelerOS UI ATOMS: os 12 icones vetoriais comuns a apps e
// jogos (back close check gear wifi star play search menu heart info alert)
// + dot. Depende SO de System (nenhum core de app/jogo), para que
// celeros.app.icons e celeros.game.ui possam compartilhar a MESMA tabela
// sem pagar o core um do outro.
//
//   var I = require("celeros.ui.icons");
//   I.draw("wifi", 12, 60, 16, { color: 0x07FF });
//
// 1.0.0: primeira versao (extraido do CelerGame UI 1.3 e do CelerKit 2.0).

var S = System;
var _r = { x: 0, y: 0, w: 0, h: 0 };

function ln(x1, y1, x2, y2, c, w) {
    if (w > 1 && S.drawWideLine) S.drawWideLine(x1, y1, x2, y2, w, c);
    else S.drawLine(x1, y1, x2, y2, c);
}
function ci(cx, cy, r, c) {
    if (S.fillSmoothCircle) S.fillSmoothCircle(cx, cy, r, c);
    else S.fillCircle(cx, cy, r, c);
}
function tr(x1, y1, x2, y2, x3, y3, c) {
    S.fillTriangle(x1, y1, x2, y2, x3, y3, c);
}
function star(cx, cy, r0, r1, c) {
    for (var i = 0; i < 10; i++) {
        var a0 = -Math.PI / 2 + i * Math.PI / 5;
        var a1 = a0 + Math.PI / 5;
        var r0i = (i & 1) ? r1 : r0;
        var r1i = (i & 1) ? r0 : r1;
        tr(cx, cy,
           cx + Math.cos(a0) * r0i, cy + Math.sin(a0) * r0i,
           cx + Math.cos(a1) * r1i, cy + Math.sin(a1) * r1i, c);
    }
}

var MAP = {
    dot: function (x, y, s, c) { ci(x + s / 2, y + s / 2, s * .18, c); },
    play: function (x, y, s, c) {
        tr(x + s * .28, y + s * .16, x + s * .28, y + s * .84,
           x + s * .84, y + s * .50, c);
    },
    back: function (x, y, s, c, w) {
        ln(x + s * .60, y + s * .20, x + s * .32, y + s * .50, c, w);
        ln(x + s * .32, y + s * .50, x + s * .60, y + s * .80, c, w);
        ln(x + s * .32, y + s * .50, x + s * .82, y + s * .50, c, w);
    },
    close: function (x, y, s, c, w) {
        ln(x + s * .28, y + s * .28, x + s * .72, y + s * .72, c, w);
        ln(x + s * .72, y + s * .28, x + s * .28, y + s * .72, c, w);
    },
    check: function (x, y, s, c, w) {
        ln(x + s * .22, y + s * .52, x + s * .43, y + s * .72, c, w);
        ln(x + s * .43, y + s * .72, x + s * .78, y + s * .28, c, w);
    },
    gear: function (x, y, s, c, w) {
        var cx = x + s / 2, cy = y + s / 2, r0 = s * .20, r1 = s * .42;
        S.drawCircle(cx, cy, Math.round(r0), c);
        for (var k = 0; k < 8; k++) {
            var a = k * Math.PI / 4;
            ln(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0,
               cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, c, w);
        }
    },
    wifi: function (x, y, s, c) {
        var cx = x + s / 2, cy = y + s * .78;
        S.fillArc(cx, cy, s * .38, s * .46, 225, 315, c);
        S.fillArc(cx, cy, s * .24, s * .32, 225, 315, c);
        ci(cx, cy, Math.max(1, s * .07), c);
    },
    star: function (x, y, s, c) { star(x + s / 2, y + s / 2, s * .46, s * .20, c); },
    search: function (x, y, s, c, w) {
        S.drawCircle(x + s * .44, y + s * .42, Math.round(s * .22), c);
        ln(x + s * .60, y + s * .60, x + s * .82, y + s * .82, c, w);
    },
    menu: function (x, y, s, c, w) {
        ln(x + s * .22, y + s * .32, x + s * .78, y + s * .32, c, w);
        ln(x + s * .22, y + s * .50, x + s * .78, y + s * .50, c, w);
        ln(x + s * .22, y + s * .68, x + s * .78, y + s * .68, c, w);
    },
    heart: function (x, y, s, c) {
        var r = s * .22;
        ci(x + s * .30, y + s * .32, r, c);
        ci(x + s * .70, y + s * .32, r, c);
        tr(x + s * .08, y + s * .34, x + s * .92, y + s * .34,
           x + s * .50, y + s * .86, c);
    },
    info: function (x, y, s, c, w) {
        S.drawCircle(x + s / 2, y + s / 2, Math.round(s * .36), c);
        ln(x + s * .50, y + s * .46, x + s * .50, y + s * .68, c, w);
        ci(x + s * .50, y + s * .32, Math.max(1, s * .05), c);
    },
    alert: function (x, y, s, c, w) {
        S.drawTriangle(x + s * .50, y + s * .12, x + s * .12, y + s * .86,
                       x + s * .88, y + s * .86, c);
        ln(x + s * .50, y + s * .38, x + s * .50, y + s * .62, c, w);
        ci(x + s * .50, y + s * .72, Math.max(1, s * .05), c);
    }
};

module.exports = {
    version: '1.0.0',
    map: MAP,
    draw: function (name, x, y, size, o) {
        o = o || {};
        var s = size === undefined ? 16 : size;
        var th = S.theme() || {};
        var c = o.color === undefined ? (th.text === undefined ? 0xFFFF : th.text) : o.color;
        var w = o.w === undefined ? Math.max(1, Math.round(s * .12)) : o.w;
        (MAP[name] || MAP.dot)(x, y, s, c, w);
        _r.x = x; _r.y = y; _r.w = s; _r.h = s;
        return _r;
    }
};
