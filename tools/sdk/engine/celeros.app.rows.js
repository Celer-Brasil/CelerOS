// app.rows.js — CelerKit ROWS (dep "celeros.app.rows"): o pintor de linha
// rico do A.form quando ele usa A.list.view (toggle/gauge/stepper/choice/
// picker/info). Fica FORA do celeros.app.kit (o fecho do kit nao paga);
// apps que querem o form rico adotam este modulo + celeros.app.style.
//
//   var A = require("celeros.app");
//   require("celeros.app.form");
//   require("celeros.app.rows");
//   A.form.run("Ajustes", function () { return [ ... ]; });
//
// 1.0.0: primeira versao.

var A = require('celeros.app');
var S = System;

A.rows = {
    version: '1.0.0',

    // pintor de linha do form: (r, x, y, w, h, state)
    formRow: function (r, x, y, w, h, st) {
        if (!r || !r.k) return;
        var T = (A.style && A.style.T) || A.T || S.theme() || {};
        var dis = r.k === 'info' || r.k === 'secao';
        var lh = UI.lineHeight('body');
        var cap = UI.lineHeight('caption');
        var rw = r.k === 'toggle' ? 50
               : r.k === 'gauge' ? 88
               : r.k === 'stepper' ? 96
               : (r.k === 'choice' || r.k === 'picker' || r.k === 'info') ? 120
               : 0;
        var lw = w - 8 - rw;
        if (lw < 8) lw = 8;
        UI.text(String(r.label === undefined ? '' : r.label), x,
                y + Math.round(r.sub ? h * .24 : (h - lh) / 2),
                { role: 'body', color: dis ? T.textDim : T.text, w: lw, lines: 1 });
        if (r.sub) {
            UI.text(String(r.sub), x, y + Math.round(h * .55),
                    { role: 'caption', color: T.textDim, w: lw, lines: 1 });
        }
        if (r.k === 'toggle') {
            var on = !!r.get();
            var nv = UI.toggle(x + w - 44, y + Math.round((h - 24) / 2), on);
            if (nv !== on) r.set(nv);
        } else if (r.k === 'gauge') {
            var gv = r.get();
            var f = (gv - r.min) / (r.max - r.min);
            if (!(f >= 0)) f = 0;
            if (f > 1) f = 1;
            var bx = x + w - 84, by = y + Math.round(h / 2) - 4;
            S.fillRoundRect(bx, by, 76, 8, 4, T.card);
            if (f > 0.01) {
                S.fillRoundRect(bx, by, Math.max(2, Math.round(76 * f)), 8, 4,
                                r.color === undefined ? T.accent : r.color);
            }
        } else if (r.k === 'stepper') {
            var sv = r.get();
            if (UI.button('-', x + w - 92, y + 2, 28, h - 4, { style: 'ghost' })) {
                var n1 = sv - r.step;
                if (n1 < r.min) n1 = r.min;
                r.set(n1);
            }
            if (UI.button('+', x + w - 32, y + 2, 28, h - 4, { style: 'ghost' })) {
                var n2 = sv + r.step;
                if (n2 > r.max) n2 = r.max;
                r.set(n2);
            }
            UI.text(String(r.fmt ? r.fmt(sv) : sv), x + w - 64,
                    y + Math.round((h - lh) / 2),
                    { role: 'body', align: 'center', color: T.text, w: 32, lines: 1 });
        } else if (r.k === 'choice') {
            UI.text(String(r.opts[r.get() % r.opts.length]), x + w - 8,
                    y + Math.round((h - cap) / 2),
                    { role: 'caption', align: 'right', color: T.textDim,
                      w: 112, lines: 1 });
        } else if (r.k === 'picker') {
            UI.text(String(r.items[r.get()] || ''), x + w - 8,
                    y + Math.round((h - cap) / 2),
                    { role: 'caption', align: 'right', color: T.textDim,
                      w: 112, lines: 1 });
        } else if (r.k === 'info') {
            UI.text(String(r.right), x + w - 8, y + Math.round((h - cap) / 2),
                    { role: 'caption', align: 'right',
                      color: r.rightColor === undefined ? T.textDim : r.rightColor,
                      w: 112, lines: 1 });
        }
    }
};

A._mods.push('rows');

module.exports = A;
