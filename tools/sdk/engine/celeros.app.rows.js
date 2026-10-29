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
// 1.0.3: stepper legivel: align:'center' centra NO x (nao na caixa), entao
// o valor era desenhado em cima do botao "-" e lia-se "-100%"; agora o
// centro e o MEIO entre os botoes (x+w-56) com o "-" recuado 16 px.
// 1.0.2: rotulo e legenda EMPILHADOS pela altura real das fontes (as
// fracoes .24/.55 do rowH jogavam a legenda por cima do rotulo nas linhas
// de 36 do A.form).
// 1.0.1: choice a prova de indice negativo/opts vazio (`r.opts[-1]` e
// `x % 0` mostravam "undefined" na linha).
// 1.0.0: primeira versao.

var A = require('celeros.app');
var S = System;

A.rows = {
    version: '1.0.3',

    // pintor de linha do form: (r, x, y, w, h, state)
    formRow: function (r, x, y, w, h, st) {
        if (!r || !r.k) return;
        var T = (A.style && A.style.T) || A.T || S.theme() || {};
        var dis = r.k === 'info' || r.k === 'secao';
        var lh = UI.lineHeight('body');
        var cap = UI.lineHeight('caption');
        var rw = r.k === 'toggle' ? 50
               : r.k === 'gauge' ? 88
               : r.k === 'stepper' ? 112
               : (r.k === 'choice' || r.k === 'picker' || r.k === 'info') ? 120
               : 0;
        var lw = w - 8 - rw;
        if (lw < 8) lw = 8;
        // rotulo e legenda empilhados pela altura real das fontes (com 1 px
        // de respiro): o par fica centrado e a legenda nao encosta no rotulo
        var ty = y + Math.round((h - (r.sub ? lh + 1 + cap : lh)) / 2);
        UI.text(String(r.label === undefined ? '' : r.label), x, ty,
                { role: 'body', color: dis ? T.textDim : T.text, w: lw, lines: 1 });
        if (r.sub) {
            UI.text(String(r.sub), x, ty + lh + 1,
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
            // valor entre os dois botoes: a caixa de 32 do 1.0.2 nao cabia
            // "100%" na fonte body do vidro grande e o texto VAZAVA sobre o
            // "-" e o "+" (a linha lia "-100%" num pill so). 48 de caixa
            // (x+w-80..x+w-32) com o "-" recuado para x+w-108
            if (UI.button('-', x + w - 108, y + 2, 28, h - 4, { style: 'ghost' })) {
                var n1 = sv - r.step;
                if (n1 < r.min) n1 = r.min;
                r.set(n1);
            }
            if (UI.button('+', x + w - 32, y + 2, 28, h - 4, { style: 'ghost' })) {
                var n2 = sv + r.step;
                if (n2 > r.max) n2 = r.max;
                r.set(n2);
            }
            // align:'center' no toolkit centra NO x (o w so limita/ellipsiza):
            // o valor tem que ser centrado no MEIO dos botoes, nao na borda
            // da caixa — x+w-64 (1.0.2) ficava metade sobre o "-"
            UI.text(String(r.fmt ? r.fmt(sv) : sv), x + w - 56,
                    y + Math.round((h - lh) / 2),
                    { role: 'body', align: 'center', color: T.text, w: 44, lines: 1 });
        } else if (r.k === 'choice') {
            // indice negativo (`-1 % 3` = -1) e opts vazio/ausente mostravam
            // "undefined"; modulo tem que dobrar e opts vazio vira texto vazio
            var co = r.opts || [], cv = r.get() | 0;
            var ci = co.length ? ((cv % co.length) + co.length) % co.length : 0;
            UI.text(String(co[ci] === undefined ? '' : co[ci]), x + w - 8,
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
