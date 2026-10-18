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
//
// 1.1.0: E.ui.confirm (sim/nao modal), E.ui.toast (aviso que some sozinho,
// desenhado pela engine por cima da cena), lista com inercia (fling) e
// scrollTo, e title/pause/gameOver/dialog sem alocar opts por quadro.

var E = require('celeros.game');
var S = System;
var EMPTY = {};

// scratches do draw (mesmo papel do EMPTY do core): menu/lista/dialogo
// redesenham a cada quadro — um opts novo por item era pressao de GC no
// Duktape. Os campos voltam a undefined entre itens (o gfx.button le
// `!== false`/`=== undefined`)
var _mIt = { screen: true, primary: undefined, stroke: undefined };
var _mStr = { label: '' };
var _lRow = { screen: true, primary: true };
var _lRect = { x: 0, y: 0, w: 0, h: 0 };
var _lTxt = { ts: 'body', valign: 'middle', screen: true, color: 0 };
var _lStr = { label: '' };
var _scr = { screen: true };
var _dTxt = { font: 0, size: 0, color: 0, screen: true };
var _dName = { ts: 'small', color: 0, screen: true };
var _wM = { font: 0, size: 0 };
var _PAUSA_LB = ['Continuar', 'Recomecar', 'Sair'];
var _FIM_LB = ['De novo', 'Sair'];
var _SN_LB = ['Sim', 'Nao'];
// scratches das telas prontas (title/pause/gameOver/confirm/toast)
var _tx = { ts: 'body', align: 'center', valign: undefined, color: 0, screen: true };
var _bt = { primary: undefined, screen: true };
var _mn = { y: undefined, x: undefined, w: undefined, row: undefined };
var _dimO = { screen: true };
var _arrow = { color: 0, screen: true };

// texto centrado de tela (ts, cor) pelo scratch
function ctext(str, y, ts, color) {
    _tx.ts = ts;
    _tx.color = color;
    _tx.valign = undefined;
    E.gfx.text(str, E.W / 2, y, _tx);
}

// quebra de linha por palavras dentro de maxW (px) — devolve as linhas
function wrap(str, maxW, st) {
    var out = [], word, line = '';
    var words = String(str).split(' ');
    _wM.font = st.font; _wM.size = st.size;
    for (var i = 0; i < words.length; i++) {
        word = words[i];
        var probe = line ? line + ' ' + word : word;
        if (line && E.gfx.measure(probe, _wM) > maxW) {
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
    version: '1.1.0',

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
            var it;
            if (typeof items[i] === 'string') { _mStr.label = items[i]; it = _mStr; }
            else it = items[i];
            if (it.disabled) { _mIt.primary = false; _mIt.stroke = false; }
            else if (it.danger) { _mIt.primary = false; _mIt.stroke = T.err; }
            else { _mIt.primary = undefined; _mIt.stroke = undefined; }
            var r = E.gfx.button(it.label, x, y + i * rowH, w, rowH - Math.round(4 * E.U), _mIt);
            if (!it.disabled && E.hit(r)) pick = it.value !== undefined ? it.value : it.label;
        }
        return pick;
    },

    // lista COM ROLAGEM (retida — guarde o retorno): arrastar rola, tap
    // seco devolve/calls onPick com o item. items: string ou
    // {label, value, disabled}. o = {items, row, onPick(value, index)}
    list: function (o) {
        var st = { items: o.items || [], row: o.row || Math.round(28 * E.U),
                   scroll: 0, _dragOn: false, _dragY: 0, _vel: 0,
                   onPick: o.onPick || null, picked: null };
        // rola ate a linha index ficar no topo (o draw clampa no fim)
        st.scrollTo = function (index) {
            st.scroll = index * st.row;
            st._vel = 0;
        };
        st.draw = function (x, y, w, h) {
            var T = E.theme || EMPTY;
            var i = E.input;
            var fired = null;   // pick devolvido SO no quadro do tap
            var content = st.items.length * st.row;
            var maxScroll = content > h ? content - h : 0;
            // o arrasto da lista comeca no PRESSIONAR dentro dela: um dedo
            // que desceu FORA e atravessou o rect nao salta a rolagem (o
            // arrasto pertence a quem estava sob o dedo no press)
            if (i.justDown && i.x >= x && i.x <= x + w && i.y >= y && i.y <= y + h) {
                st._dragOn = true;
                st._dragY = st.scroll + i.y;
                st._vel = 0;          // dedo na lista segura o fling
            }
            if (!i.down) st._dragOn = false;
            if (st._dragOn) {
                var ns = st._dragY - i.y;
                // velocidade suavizada (px/quadro) para o fling do soltar
                st._vel = st._vel * 0.5 + (ns - st.scroll) * 0.5;
                st.scroll = ns;
            } else if (st._vel > 0.5 || st._vel < -0.5) {
                // inercia: segue rolando e freia (8%/quadro); parede zera
                st.scroll += st._vel;
                st._vel *= 0.92;
                if (st.scroll < 0 || st.scroll > maxScroll) st._vel = 0;
            } else st._vel = 0;
            // dedo pra CIMA mostra o conteudo de baixo (scroll cresce),
            // como na rolagem de toque padrao
            if (st.scroll < 0) st.scroll = 0;
            if (st.scroll > maxScroll) st.scroll = maxScroll;
            E.gfx.panel(x, y, w, h, _scr);
            // tap seco pega a linha (o arrasto que passou do limiar ja
            // consumiu o toque — input.tap so existe sem drag)
            var tap = i.tap;
            var k0 = Math.floor(st.scroll / st.row);
            var k1 = Math.min(st.items.length - 1,
                              Math.ceil((st.scroll + h) / st.row) - 1);
            if (E.caps.clip) S.setClip(x, y, w, h);
            for (var k = k0; k <= k1; k++) {
                var it;
                if (typeof st.items[k] === 'string') { _lStr.label = st.items[k]; it = _lStr; }
                else it = st.items[k];
                var ry = y + k * st.row - st.scroll;
                var dis = !!it.disabled;   // item travado: desenha apagado, nao pega
                var noTap = dis || !tap || tap.x < x || tap.x > x + w ||
                            tap.y < ry || tap.y > ry + st.row;
                _lRect.x = x; _lRect.y = ry; _lRect.w = w; _lRect.h = st.row;
                if (!dis && (E.press(_lRect) || !noTap)) {
                    E.gfx.button(it.label, x + Math.round(2 * E.U), ry + 2,
                                 w - Math.round(4 * E.U), st.row - 4, _lRow);
                    if (!noTap) {
                        st.picked = it.value !== undefined ? it.value : it.label;
                        fired = st.picked;
                        if (st.onPick) st.onPick(st.picked, k);
                    }
                } else {
                    _lTxt.color = dis ? (T.textDim === undefined ? T.text : T.textDim)
                                      : T.text;
                    E.gfx.text(it.label, x + Math.round(8 * E.U), ry + st.row / 2, _lTxt);
                }
            }
            if (E.caps.clip) S.clearClip();
            // trilho de rolagem
            if (maxScroll > 0) {
                var tbH = Math.max(Math.round(12 * E.U), Math.round(h * h / content));
                var tbY = y + (h - tbH) * (st.scroll / maxScroll);
                E.gfx.rect(x + w - Math.round(3 * E.U), y, 2, h, T.stroke, _scr);
                E.gfx.rect(x + w - Math.round(3 * E.U), tbY, 2, tbH, T.accent, _scr);
            }
            return fired;
        };
        return st;
    },

    // dialogo com texto datilografado (retido): d.draw(x, y, w) desenha o
    // panel e revela `speed` chars/s; tap na caixa completa o texto, tap
    // de novo fecha (draw devolve false). o = {speed (30), name, px}.
    // A quebra de linhas e feita UMA vez (1a draw — a revelacao nao
    // requebra por quadro) e a altura do panel cresce com o texto: antes
    // era fixa em 58*E.U e a fala longa transbordava por baixo da borda
    dialog: function (text, o) {
        o = o || EMPTY;
        var d = { t: 0, done: false, closed: false,
                  speed: o.speed === undefined ? 30 : o.speed, text: String(text),
                  _w: 0, _lines: null };
        d.draw = function (x, y, w) {
            var T = E.theme || EMPTY;
            w = w || Math.round(200 * E.U);
            var st = E.font(o.px || Math.round(13 * E.U));
            if (!d._lines || d._w !== w) {
                d._lines = wrap(d.text, w - Math.round(20 * E.U), st);
                d._w = w;
            }
            var ty0 = y + (o.name ? Math.round(20 * E.U) : Math.round(8 * E.U));
            var h = ty0 - y + d._lines.length * Math.round(st.h + 2) +
                    Math.round(10 * E.U);
            E.gfx.panel(x, y, w, h, _scr);
            if (o.name) {
                _dName.color = T.accent;
                E.gfx.text(o.name, x + Math.round(10 * E.U), y + Math.round(4 * E.U), _dName);
            }
            // revela `speed` chars por segundo pelas linhas ja quebradas
            // (avanca no draw: cena comum, nao static)
            var n = Math.floor(d.t * d.speed);
            var completo = n >= d.text.length;
            if (completo) d.done = true;
            for (var li = 0; li < d._lines.length && n > 0; li++) {
                var ln = d._lines[li];
                var corte = ln.length <= n ? ln : ln.substring(0, n);
                n -= ln.length;
                _dTxt.font = st.font; _dTxt.size = st.size; _dTxt.color = T.text;
                E.gfx.text(corte, x + Math.round(10 * E.U),
                           ty0 + li * Math.round(st.h + 2), _dTxt);
            }
            if (completo) {
                _arrow.color = T.accent;
                E.gfx.text('>', x + w - Math.round(14 * E.U), y + h - Math.round(12 * E.U),
                           _arrow);
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
    // start: null/false esconde o botao (a cena poe o proprio menu no lugar);
    // o extra sobe para o centro quando o start nao existe.
    title: function (o) {
        o = o || EMPTY;
        var T = E.theme || EMPTY;
        var y = Math.round(E.H * 0.2);
        ctext(o.game || '', y, 'title', T.accent);
        if (o.subtitle) ctext(o.subtitle, y + Math.round(38 * E.U), 'body', T.text);
        if (o.best !== undefined) {
            ctext('Recorde: ' + o.best, y + Math.round(62 * E.U), 'small', T.text);
        }
        var act = null;
        var w = Math.round(150 * E.U), h = Math.round(44 * E.U);
        var bx = Math.round((E.W - w) / 2);
        var by = Math.round(E.H * 0.5);
        var temStart = o.start !== null && o.start !== false;
        if (temStart) {
            _bt.primary = undefined;
            var r = E.gfx.button(o.start || 'JOGAR', bx, by, w, h, _bt);
            if (E.hit(r)) act = 'start';
            by += h + Math.round(10 * E.U);
        }
        if (o.extra) {
            _bt.primary = false;
            r = E.gfx.button(o.extra, bx, by, w, Math.round(36 * E.U), _bt);
            if (E.hit(r)) act = 'extra';
        }
        return act;
    },

    // veu de pausa sobre o jogo congelado: devolve 'resume'|'restart'|
    // 'quit' do tap, ou null. o = {title ('PAUSA'), labels: [3], clear,
    // veil}. clear: true nao pinta o fundo (a cena congelada ja esta no
    // vidro); veil pinta a cor dada em vez do veu padrao.
    pause: function (o) {
        o = o || EMPTY;
        var T = E.theme || EMPTY;
        if (o.clear !== true) {
            var dim = o.veil !== undefined ? o.veil :
                      (E.caps.wide ? S.mixColor(T.bg === undefined ? 0x0000 : T.bg, 0x0000, 62)
                                   : 0x0000);
            E.gfx.rect(0, 0, E.W, E.H, dim, _dimO);
        }
        ctext(o.title || 'PAUSA', Math.round(E.H * 0.18), 'big', T.text);
        var lb = o.labels || _PAUSA_LB;
        // menu abaixo do titulo (o titulo sobe para 0.18H e o menu fica no
        // default 0.30H: no 480 o 0.24H encostava na 1a opcao)
        _mn.y = undefined;
        var pick = E.ui.menu(lb, _mn);
        if (pick === lb[0]) return 'resume';
        if (pick === lb[1]) return 'restart';
        if (pick === lb[2]) return 'quit';
        return null;
    },

    // tela de fim: devolve 'again'|'quit' do tap, ou null. o = {title
    // ('FIM DE JOGO'), score, detail (linha extra, ex. "Adversario: 3"),
    // best, isNew, labels: [2], clear, veil}. O layout e responsivo: no 480
    // o recorde ficava embaixo do primeiro botao (H*0.36 + 40U x H*0.52).
    gameOver: function (o) {
        o = o || EMPTY;
        var T = E.theme || EMPTY;
        if (o.clear !== true) {
            var bg = o.veil !== undefined ? o.veil :
                     (E.caps.wide ? S.mixColor(T.bg === undefined ? 0x0000 : T.bg, 0x0000, 90)
                                  : (T.bg === undefined ? 0x0000 : T.bg));
            E.gfx.rect(0, 0, E.W, E.H, bg, _dimO);
        }
        ctext(o.title || 'FIM DE JOGO', Math.round(E.H * 0.16), 'big', T.err);
        var y = Math.round(E.H * 0.26);
        if (o.score !== undefined) ctext('Pontos: ' + o.score, y, 'title', T.text);
        if (o.detail) ctext(o.detail, y + Math.round(34 * E.U), 'label', T.text);
        if (o.best !== undefined) {
            ctext((o.isNew ? 'NOVO RECORDE! ' : 'Recorde: ') + o.best,
                  y + Math.round(64 * E.U), 'label', o.isNew ? T.accent : T.text);
        }
        var lb = o.labels || _FIM_LB;
        _mn.y = Math.round(E.H * 0.60);
        var pick = E.ui.menu(lb, _mn);
        if (pick === lb[0]) return 'again';
        if (pick === lb[1]) return 'quit';
        return null;
    },

    // pergunta sim/nao sobre a cena (veu + painel): devolve 'yes'|'no' do
    // tap, ou null. o = {title, labels: [2]} — "Sair sem salvar?"
    confirm: function (msg, o) {
        o = o || EMPTY;
        var T = E.theme || EMPTY;
        var dim = E.caps.wide ? S.mixColor(T.bg === undefined ? 0x0000 : T.bg, 0x0000, 62)
                              : 0x0000;
        E.gfx.rect(0, 0, E.W, E.H, dim, _dimO);
        var pw = Math.round(Math.min(E.W - 24 * E.U, 210 * E.U));
        var px = Math.round((E.W - pw) / 2);
        var st = E.font((E.ts.body || 13) * E.U);
        var lines = wrap(msg, pw - Math.round(20 * E.U), st);
        var lh = Math.round(st.h + 3);
        var top = o.title ? Math.round(26 * E.U) : Math.round(12 * E.U);
        var bh = Math.round(36 * E.U);
        var ph = top + lines.length * lh + Math.round(14 * E.U) + bh + Math.round(10 * E.U);
        var py = Math.round((E.H - ph) / 2);
        E.gfx.panel(px, py, pw, ph, _dimO);
        if (o.title) ctext(o.title, py + Math.round(8 * E.U), 'label', T.accent);
        for (var i = 0; i < lines.length; i++) {
            ctext(lines[i], py + top + i * lh, 'body', T.text);
        }
        var lb = o.labels || _SN_LB;
        var gap = Math.round(8 * E.U), bw = Math.round((pw - gap * 3) / 2);
        var by = py + ph - bh - Math.round(10 * E.U);
        _bt.primary = undefined;
        var ry = E.gfx.button(lb[0], px + gap, by, bw, bh, _bt);
        _bt.primary = false;
        var rn = E.gfx.button(lb[1], px + gap * 2 + bw, by, bw, bh, _bt);
        if (E.hit(ry)) return 'yes';
        if (E.hit(rn)) return 'no';
        return null;
    },

    // aviso curto que some sozinho ("Salvo!", "+1 vida"): a ENGINE desenha
    // por cima da cena (E._modDraws) — chame uma vez, sem draw a mao. Um
    // toast novo substitui o anterior. o = {ms (1500), color, y (0..1 da
    // altura, default 0.82)}
    toast: function (msg, o) {
        o = o || EMPTY;
        var t = E.ui._toast;
        t.msg = String(msg);
        t.until = S.millis() + (o.ms || 1500);
        t.color = o.color;
        t.y = o.y === undefined ? 0.82 : o.y;
        E.redraw();
    },
    _toast: { msg: null, until: 0, color: undefined, y: 0.82 }
};

var _toTx = { ts: 'body', align: 'center', valign: 'middle', color: 0, fit: 0, screen: true };
var _toBox = { r: 0, screen: true };
// relogio REAL (a pausa congela os ticks, nao o aviso); cada draw com o
// aviso vivo agenda o proximo (cena static) e o que expira agenda 1 a mais
// — a camada suja / o redraw da cena apaga o resto
// core < 1.1.0 nao tem o registro de overlays: o toast fica mudo (o
// index.json pede ^1.1.0; a guarda cobre o --deps-local antigo)
if (E._modDraws) E._modDraws.push(function () {
    var t = E.ui._toast;
    if (!t.msg) return;
    E.redraw();
    if (S.millis() >= t.until) { t.msg = null; return; }
    var T = E.theme || EMPTY;
    var tw = E.gfx.measure(t.msg, _toTx) + Math.round(24 * E.U);
    var th = Math.round(28 * E.U);
    if (tw > E.W - 16) tw = E.W - 16;
    var x = Math.round((E.W - tw) / 2), y = Math.round(E.H * t.y - th / 2);
    _toBox.r = Math.round(th / 2);
    E.gfx.rect(x, y, tw, th, T.card === undefined ? 0x2104 : T.card, _toBox);
    _toTx.color = t.color !== undefined ? t.color : (T.text === undefined ? 0xFFFF : T.text);
    _toTx.fit = tw - Math.round(12 * E.U);
    E.gfx.text(t.msg, E.W / 2, y + th / 2, _toTx);
});

E._mods.push('ui');

module.exports = E;
