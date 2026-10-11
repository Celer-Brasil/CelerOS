// game.ui.js — CelerGame UI (dep "celeros.game.ui"): o que todo jogo
// reescreve — menus, listas com rolagem, dialogo com texto datilografado
// e as telas de titulo/pausa/fim. Decora o core no require:
//
//   var E = require("celeros.game");
//   require("celeros.game.ui");
//   // no draw da cena:
//   var act = E.ui.title({ game: "MEU JOGO", best: E.save.num("hi") });
//   if (act === "start") E.goto("jogo", { transition: "fade" });
//
// Filosofia da casa: immediate-mode (o menu desenha e DEVOLVE o item do
// tap no mesmo quadro, como E.gfx.button) e zero estado escondido — as
// excessoes roladas (list/dialog) sao objetos guardados pelo chamador.
// Tudo desenha com screen: true (fora da camera) e respeita o tema do
// firmware (E.theme).

var E = require('celeros.game');
var S = System;
var EMPTY = {};

// quebra de linha por palavras dentro de maxW (px) — devolve as linhas
function wrap(str, maxW, st) {
    var out = [], word, line = '';
    var words = String(str).split(' ');
    for (var i = 0; i < words.length; i++) {
        word = words[i];
        var probe = line ? line + ' ' + word : word;
        if (line && E.gfx.measure(probe, { font: st.font, size: st.size }) > maxW) {
            out.push(line);
            line = word;
        } else {
            line = probe;
        }
    }
    if (line) out.push(line);
    return out;
}

E.ui = {
    version: '1.0.0',

    // menu vertical immediate-mode: items = ["Jogar", ...] ou
    // [{label, value, danger, disabled}]. Devolve o value (ou label) do
    // item tocado neste quadro, ou null. Poucas opcoes (titulo, pausa);
    // lista longa e o E.ui.list.
    menu: function (items, o) {
        o = o || EMPTY;
        var T = E.theme || EMPTY;
        var n = items.length;
        var rowH = o.row || Math.round(40 * E.U);
        var w = o.w || Math.round(180 * E.U);
        var x = o.x === undefined ? Math.round((E.W - w) / 2) : o.x;
        var y = o.y === undefined ? Math.round(E.H * 0.3) : o.y;
        var pick = null;
        for (var i = 0; i < n; i++) {
            var it = typeof items[i] === 'string' ? { label: items[i] } : items[i];
            var ro = { screen: true };
            if (it.disabled) { ro.primary = false; ro.stroke = false; }
            else if (it.danger) { ro.primary = false; ro.stroke = T.err; }
            var r = E.gfx.button(it.label, x, y + i * rowH, w, rowH - Math.round(4 * E.U), ro);
            if (!it.disabled && E.hit(r)) pick = it.value !== undefined ? it.value : it.label;
        }
        return pick;
    },

    // lista COM ROLAGEM (retida — guarde o retorno): arrastar rola, tap
    // seco devolve/calls onPick com o item. items: string ou
    // {label, value}. o = {items, row, onPick(value, index)}
    list: function (o) {
        var st = { items: o.items || [], row: o.row || Math.round(28 * E.U),
                   scroll: 0, _dragOn: false, _dragY: 0,
                   onPick: o.onPick || null, picked: null };
        st.draw = function (x, y, w, h) {
            var T = E.theme || EMPTY;
            var i = E.input;
            var fired = null;   // pick devolvido SO no quadro do tap
            var content = st.items.length * st.row;
            var maxScroll = content > h ? content - h : 0;
            // dedo dentro: arrasto rola — dedo pra CIMA mostra o conteudo de
            // baixo (scroll cresce), como na rolagem de toque padrao
            if (i.down && i.x >= x && i.x <= x + w && i.y >= y && i.y <= y + h) {
                if (!st._dragOn) {
                    st._dragOn = true;
                    st._dragY = st.scroll + i.y;
                }
                st.scroll = st._dragY - i.y;
            } else {
                st._dragOn = false;
            }
            if (st.scroll < 0) st.scroll = 0;
            if (st.scroll > maxScroll) st.scroll = maxScroll;
            E.gfx.panel(x, y, w, h, { screen: true });
            // tap seco pega a linha (o arrasto que passou do limiar ja
            // consumiu o toque — input.tap so existe sem drag)
            var tap = i.tap;
            var k0 = Math.floor(st.scroll / st.row);
            var k1 = Math.min(st.items.length - 1,
                              Math.ceil((st.scroll + h) / st.row) - 1);
            if (E.caps.clip) S.setClip(x, y, w, h);
            for (var k = k0; k <= k1; k++) {
                var it = typeof st.items[k] === 'string' ? { label: st.items[k] } : st.items[k];
                var ry = y + k * st.row - st.scroll;
                var ro = { screen: true };
                var r = { x: x, y: ry, w: w, h: st.row };
                var noTap = !tap || tap.x < x || tap.x > x + w ||
                            tap.y < ry || tap.y > ry + st.row;
                if (E.press(r) || !noTap) {
                    ro.primary = true;
                    E.gfx.button(it.label, x + Math.round(2 * E.U), ry + 2,
                                 w - Math.round(4 * E.U), st.row - 4, ro);
                    if (!noTap) {
                        st.picked = it.value !== undefined ? it.value : it.label;
                        fired = st.picked;
                        if (st.onPick) st.onPick(st.picked, k);
                    }
                } else {
                    E.gfx.text(it.label, x + Math.round(8 * E.U), ry + st.row / 2,
                               { ts: 'body', valign: 'middle', screen: true,
                                 color: T.text });
                }
            }
            if (E.caps.clip) S.clearClip();
            // trilho de rolagem
            if (maxScroll > 0) {
                var tbH = Math.max(Math.round(12 * E.U), Math.round(h * h / content));
                var tbY = y + (h - tbH) * (st.scroll / maxScroll);
                E.gfx.rect(x + w - Math.round(3 * E.U), y, 2, h, T.stroke, { screen: true });
                E.gfx.rect(x + w - Math.round(3 * E.U), tbY, 2, tbH, T.accent, { screen: true });
            }
            return fired;
        };
        return st;
    },

    // dialogo com texto datilografado (retido): d.draw(x, y, w) desenha o
    // panel e revela `speed` chars/s; tap na caixa completa o texto, tap
    // de novo fecha (draw devolve false). o = {speed (30), name, px, wait}
    dialog: function (text, o) {
        o = o || EMPTY;
        var d = { t: 0, done: false, closed: false,
                  speed: o.speed === undefined ? 30 : o.speed, text: String(text) };
        d.draw = function (x, y, w) {
            var T = E.theme || EMPTY;
            w = w || Math.round(200 * E.U);
            var h = Math.round(58 * E.U);
            var st = E.font(o.px || Math.round(13 * E.U));
            E.gfx.panel(x, y, w, h, { screen: true });
            if (o.name) {
                E.gfx.text(o.name, x + Math.round(10 * E.U), y + Math.round(4 * E.U),
                           { ts: 'small', color: T.accent, screen: true });
            }
            // revela `speed` chars por segundo (avanca no draw: cena comum)
            var n = Math.floor(d.t * d.speed);
            var completo = n >= d.text.length;
            if (completo) {
                n = d.text.length;
                d.done = true;
            }
            var lines = wrap(d.text.substring(0, n), w - Math.round(20 * E.U), st);
            var ty = y + (o.name ? Math.round(20 * E.U) : Math.round(8 * E.U));
            for (var li = 0; li < lines.length; li++) {
                E.gfx.text(lines[li], x + Math.round(10 * E.U),
                           ty + li * Math.round(st.h + 2), { font: st.font, size: st.size,
                                                             color: T.text, screen: true });
            }
            if (completo) {
                E.gfx.text('>', x + w - Math.round(14 * E.U), y + h - Math.round(12 * E.U),
                           { color: T.accent, screen: true });
            }
            var tap = E.input.tap;
            if (tap && tap.x >= x && tap.x <= x + w && tap.y >= y && tap.y <= y + h) {
                if (!completo) d.t = d.text.length / d.speed;   // completa
                else d.closed = true;                            // fecha
            }
            d.t += E.dt;
            return !d.closed;
        };
        d.skip = function () { d.t = d.text.length / d.speed + 1; };
        d.close = function () { d.closed = true; };
        return d;
    },

    // tela de titulo: devolve 'start' (ou o tap do botao extra), ou null.
    // o = {game, subtitle, start ('JOGAR'), extra (label do 2o botao), best}
    title: function (o) {
        o = o || EMPTY;
        var T = E.theme || EMPTY;
        var y = Math.round(E.H * 0.2);
        E.gfx.text(o.game || '', E.W / 2, y, { ts: 'title', align: 'center',
                                               color: T.accent, screen: true });
        if (o.subtitle) {
            E.gfx.text(o.subtitle, E.W / 2, y + Math.round(38 * E.U),
                       { ts: 'body', align: 'center', color: T.text, screen: true });
        }
        if (o.best !== undefined) {
            E.gfx.text('Recorde: ' + o.best, E.W / 2, y + Math.round(62 * E.U),
                       { ts: 'small', align: 'center', color: T.text, screen: true });
        }
        var act = null;
        var w = Math.round(150 * E.U), h = Math.round(44 * E.U);
        var bx = Math.round((E.W - w) / 2);
        var r = E.gfx.button(o.start || 'JOGAR', bx, Math.round(E.H * 0.5), w, h,
                             { screen: true });
        if (E.hit(r)) act = 'start';
        if (o.extra) {
            r = E.gfx.button(o.extra, bx, Math.round(E.H * 0.5) + h + Math.round(10 * E.U),
                             w, Math.round(36 * E.U), { primary: false, screen: true });
            if (E.hit(r)) act = 'extra';
        }
        return act;
    },

    // veu de pausa sobre o jogo congelado: devolve 'resume'|'restart'|
    // 'quit' do tap, ou null. o = {title ('PAUSA'), labels: [3]}
    pause: function (o) {
        o = o || EMPTY;
        var T = E.theme || EMPTY;
        var dim = E.caps.wide ? S.mixColor(T.bg === undefined ? 0x0000 : T.bg, 0x0000, 62)
                              : 0x0000;
        E.gfx.rect(0, 0, E.W, E.H, dim, { screen: true });
        E.gfx.text(o.title || 'PAUSA', E.W / 2, Math.round(E.H * 0.24),
                   { ts: 'big', align: 'center', color: T.text, screen: true });
        var lb = o.labels || ['Continuar', 'Recomecar', 'Sair'];
        var pick = E.ui.menu(lb, {});
        if (pick === lb[0]) return 'resume';
        if (pick === lb[1]) return 'restart';
        if (pick === lb[2]) return 'quit';
        return null;
    },

    // tela de fim: devolve 'again'|'quit' do tap, ou null. o = {title
    // ('FIM DE JOGO'), score, best, isNew, labels: [2]}
    gameOver: function (o) {
        o = o || EMPTY;
        var T = E.theme || EMPTY;
        E.gfx.rect(0, 0, E.W, E.H, T.bg === undefined ? 0x0000 : T.bg, { screen: true });
        E.gfx.text(o.title || 'FIM DE JOGO', E.W / 2, Math.round(E.H * 0.22),
                   { ts: 'big', align: 'center', color: T.err, screen: true });
        var y = Math.round(E.H * 0.36);
        if (o.score !== undefined) {
            E.gfx.text('Pontos: ' + o.score, E.W / 2, y,
                       { ts: 'title', align: 'center', color: T.text, screen: true });
        }
        if (o.best !== undefined) {
            E.gfx.text((o.isNew ? 'NOVO RECORDE! ' : 'Recorde: ') + o.best,
                       E.W / 2, y + Math.round(40 * E.U),
                       { ts: 'label', align: 'center',
                         color: o.isNew ? T.accent : T.text, screen: true });
        }
        var lb = o.labels || ['De novo', 'Sair'];
        var pick = E.ui.menu(lb, { y: Math.round(E.H * 0.52) });
        if (pick === lb[0]) return 'again';
        if (pick === lb[1]) return 'quit';
        return null;
    }
};

E._mods.push('ui');

module.exports = E;
