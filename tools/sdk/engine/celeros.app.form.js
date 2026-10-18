// app.form.js — CelerKit FORM (dep "celeros.app.form"): tela de ajustes
// pronta (o par rebuildRows/UI.list dos Ajustes, que todo app de
// configuracao reescreve) + seletor e pedidos validados via prompt.
// Decora o core:
//
//   var A = require("celeros.app");
//   require("celeros.app.form");
//   A.form.run("Ajustes", function () {
//       return [
//           A.form.secao("Rede"),
//           A.form.info("IP", System.getIPAddress()),
//           A.form.toggle("Auto-brilho", getAB, setAB),
//           A.form.choice("Tema", getTema, ["Escuro", "Claro"]),
//           A.form.action("Checar atualizacao", function () { checar(); }),
//           A.form.action("Lat/lon", function () {
//               return A.form.askNum("Latitude", { min: -90, max: 90 }) !== null;
//           })
//       ];
//   });
//
// A.form.run e BLOQUEANTE (volta quando o usuario toca o voltar). As rows
// sao RECONSTRUIDAS depois de cada acao (o cb pode mudar tudo); toggle e
// choice aplicam sozinhos. Linhas cruas do UI.list passam direto.

var A = require('celeros.app');

function rowsOf(rows) {
    var T = A.T || System.theme();
    var out = [];
    for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!r || !r.k) { out.push(r); continue; }   // linha crua passa
        if (r.k === 'secao') out.push({ label: r.label, enabled: false });
        else if (r.k === 'info') out.push({ label: r.label, right: r.right,
                                            rightColor: r.rightColor || null, enabled: false });
        else if (r.k === 'toggle') {
            var on = !!r.get();
            out.push({ label: r.label, right: on ? 'Sim' : 'Não',
                       rightColor: on ? T.ok : T.textDim });
        } else if (r.k === 'choice') {
            var v = r.get() | 0;
            out.push({ label: r.label, right: r.opts[v % r.opts.length] });
        } else if (r.k === 'picker') {
            out.push({ label: r.label, right: r.items[r.get()] || '', sub: r.sub });
        } else {   // action
            out.push({ label: r.label, sub: r.sub });
        }
    }
    return out;
}

A.form = {
    version: '1.0.0',

    // ---- construtores de linha ---------------------------------------------
    info: function (label, value, color) {
        return { k: 'info', label: label, right: String(value), rightColor: color };
    },
    action: function (label, cb, o) {
        return { k: 'action', label: label, cb: cb, sub: o && o.sub };
    },
    toggle: function (label, get, set) {
        return { k: 'toggle', label: label, get: get, set: set };
    },
    /** opcoes ciclicas: get() devolve o indice; set(n) grava */
    choice: function (label, get, set, opts) {
        return { k: 'choice', label: label, get: get, set: set, opts: opts };
    },
    /** abre o seletor (A.form.pick) ao tocar; get() = indice corrente */
    picker: function (label, get, set, items) {
        return { k: 'picker', label: label, get: get, set: set, items: items };
    },
    secao: function (title) { return { k: 'secao', label: title }; },

    // ---- tela de ajustes (bloqueante) --------------------------------------
    // build() devolve as linhas; reconstruido na entrada e apos cada acao.
    // Um action cujo cb devolve false NAO reconstrói (raro: so desenho).
    run: function (title, build) {
        var T = A.T || System.theme();
        var rows = null;
        UI.resetScroll('kit:form');
        for (;;) {
            UI.begin(T.bg);
            if (UI.header(title, { back: true })) return;
            if (!rows) rows = build();
            var i = UI.list('kit:form', A.L.x, A.L.top, A.L.w, 320 - A.L.top - 4, rowsOf(rows));
            if (i >= 0) {
                var r = rows[i];
                var refresh = false;
                if (r && r.k === 'toggle') { r.set(!r.get()); refresh = true; }
                else if (r && r.k === 'choice') {
                    r.set(((r.get() | 0) + 1) % r.opts.length);
                    refresh = true;
                } else if (r && r.k === 'picker') {
                    var p = A.form.pick(r.label, r.items, r.get() | 0);
                    if (p >= 0) { r.set(p); refresh = true; }
                } else if (r && r.k === 'action' && r.cb) {
                    refresh = r.cb() !== false;
                }
                if (refresh) rows = null;    // reconstrói no proximo frame
                UI.invalidate();
            }
            UI.end(20);
        }
    },

    // ---- seletor (bloqueante): indice escolhido ou -1 se voltou ------------
    pick: function (title, items, selected) {
        var T = A.T || System.theme();
        var rows = [];
        for (var i = 0; i < items.length; i++) rows.push({ label: items[i] });
        UI.resetScroll('kit:pick');
        for (;;) {
            UI.begin(T.bg);
            if (UI.header(title, { back: true })) return -1;
            var j = UI.list('kit:pick', A.L.x, A.L.top, A.L.w, 320 - A.L.top - 4,
                            rows, { selected: selected });
            if (j >= 0) return j;
            UI.end(20);
        }
    },

    // ---- pedidos via prompt -------------------------------------------------
    askText: function (title, o) {
        o = o || {};
        try {
            return System.prompt(title, { hint: o.hint, mask: !!o.mask });
        } catch (e) { return null; }
    },

    // numero validado: cancelou = null; fora da faixa = erro e pergunta de novo
    askNum: function (title, o) {
        o = o || {};
        for (;;) {
            var s = A.form.askText(title, o);
            if (s === null || s === '') return null;
            var v = parseFloat(String(s).replace(',', '.'));
            var bad = isNaN(v) ||
                (o.min !== undefined && v < o.min) ||
                (o.max !== undefined && v > o.max);
            if (!bad) return v;
            A.error('Valor invalido', 'Digite um numero' +
                (o.min !== undefined && o.max !== undefined ? ' entre ' + o.min + ' e ' + o.max : ''));
        }
    }
};

A._mods.push('form');

module.exports = A;
