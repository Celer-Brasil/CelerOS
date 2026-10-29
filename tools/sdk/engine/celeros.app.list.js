// app.list.js — CelerKit LIST (dep "celeros.app.list"): as licoes de
// performance da loja de apps em modulo — cache de linhas por carimbo (o
// rebuild por frame caia no exec-timeout: 2.7.1), sort com chave
// pre-computada (o sort nativo e preventyield) e cores de badge.
// Decora o core:
//
//   var A = require("celeros.app");
//   require("celeros.app.list");
//   var lista = A.list.make(
//       function () { return dataStampDosDados; },     // CARO? nao: carimbo
//       function () { return ordenarECriarLinhas(); }  // so roda quando muda
//   );
//   var rows = lista.rows();                        // barato no frame
//   var i = UI.list("cat", A.L.x, A.L.top, A.L.w, 220, rows);
//   ...
//   lista.drop();                                   // forca rebuild
//
// A.list.sort(itens, keyFn) ordena ASC com a chave calculada UMA vez
// (desc = true inverte). A.list.badge('ok'|'warn'|'err'|'dim') devolve a cor.
//
// 1.1.2: linha de duas linhas (rotulo+legenda) medida pelas FONTES: o par
// saia de fracoes do rowH (.24/.55) e a legenda era pintada por cima do
// rotulo nas linhas curtas (Regras pedia 32, o A.form 36); agora o rotulo
// empilha em cima da legenda e o rowH minimo sobe para o par caber.
// 1.1.1: sort(desc) estavel (o reverse quebrava a ordem de chaves iguais).
// 1.1.0: A.list.view(id, x,y,w,h, items, o): lista RICA desenhada em JS
// sobre UI.card + UI.scrollBegin (icone/secao/sub/right/badge/bars, painter
// custom e widget nativo por linha). A UI.list nativa continua para o caso
// simples; a view e para linhas compostas (Ajustes, Alarmes, Celer Remote).

var A = require('celeros.app');

A.list = {
    version: '1.1.2',

    // cache por carimbo: getStamp() roda TODO frame (tem que ser barato);
    // build() so roda quando o carimbo muda
    make: function (getStamp, build) {
        var cache = null;
        return {
            rows: function () {
                var stamp = getStamp();
                if (cache && cache.stamp === stamp) return cache.rows;
                cache = { stamp: stamp, rows: build() || [] };
                return cache.rows;
            },
            drop: function () { cache = null; }
        };
    },

    // sort com chave pre-computada; NUNCA ordene com fn de comparacao que
    // calcule algo (o sort do Duktape nao renova a janela do exec-timeout)
    sort: function (items, keyFn, desc) {
        var n = items.length;
        var keys = new Array(n);
        for (var i = 0; i < n; i++) keys[i] = String(keyFn(items[i]));
        // insertion sort estavel (listas de apps sao dezenas, nao milhares);
        // desc = comparador invertido — o reverse depois do sort perdia a
        // estabilidade (chaves iguais saiam na ordem contraria da original)
        for (var a = 1; a < n; a++) {
            var it = items[a], k = keys[a];
            var b = a - 1;
            while (b >= 0 && (desc ? keys[b] < k : keys[b] > k)) {
                keys[b + 1] = keys[b];
                items[b + 1] = items[b];
                b--;
            }
            keys[b + 1] = k;
            items[b + 1] = it;
        }
        return items;
    },

    // cor de badge por estado ('ok'|'warn'|'err'|'dim')
    badge: function (kind) {
        var T = A.T || System.theme();
        return kind === 'ok' ? T.ok :
               kind === 'warn' ? T.warn :
               kind === 'err' ? T.err : T.textDim;
    },

    // barras de sinal Wi-Fi (0..4) a partir do RSSI — a curva do Celer Remote
    bars: function (rssi) {
        if (typeof rssi !== 'number' || rssi >= 0) return -1;
        if (rssi > -55) return 4;
        if (rssi > -67) return 3;
        if (rssi > -78) return 2;
        if (rssi > -88) return 1;
        return 0;
    },

    // ---------------------------------------------------------- view -----
    // lista RICA (immediate-mode, com estado de scroll retido pelo id).
    // items: string | {label, sub, icon, right, rightColor, badge,
    //   badgeColor, bars, disabled, color, section, header, k:'secao'}
    // o: {row, panel, panelBg, rowBg, pad, r, selected,
    //     paintRow(item,x,y,w,h,state), widget(item,x,y,w,h)}
    // Devolve o indice tocado (ou -1). O widget nativo dentro da linha
    // consome o tap (o row so dispara se o toque nao foi consumido).
    view: function (id, x, y, w, h, items, o) {
        o = o || {};
        var S = System;
        var T = (A.style && A.style.T) || A.T || S.theme() || {};
        var rowH = o.row === undefined ? 36 : o.row;
        if (rowH < 1) rowH = 1;
        var lh = UI.lineHeight('body');
        var cap = UI.lineHeight('caption');
        var two = lh + 1 + cap;   // rotulo + 1 px de respiro + legenda
        // duas linhas precisam de `two`: as fracoes fixas do rowH pintavam
        // a legenda em cima do rotulo quando a linha era curta (Regras 32,
        // A.form 36). Varre so quando a linha pedida nao cabe — lista sem
        // legenda nao paga nada.
        if (rowH < two + 2) {
            for (var z = 0; z < items.length; z++) {
                if (items[z] && typeof items[z] === 'object' && items[z].sub) {
                    rowH = two + 2;
                    break;
                }
            }
        }
        var pad = o.pad === undefined ? 6 : o.pad;
        var panel = o.panel !== false;
        var panelBg = o.panelBg === undefined ? T.card : o.panelBg;
        var rowBg = o.rowBg === undefined ? T.raised : o.rowBg;
        var contentH = items.length * rowH;
        var fired = -1;
        if (panel) {
            UI.card(x, y, w, h, {
                color: panelBg,
                radius: o.r === undefined ? (T.radius === undefined ? 10 : T.radius) : o.r,
                stroke: o.stroke !== false
            });
        }
        var sx = x + pad, sy = y + 2;
        var sw = w - pad * 2, sh = h - 4;
        var off = UI.scrollBegin(id || 'kit:list', sx, sy, sw, sh, contentH);
        var k0 = Math.floor(off / rowH);
        var k1 = Math.min(items.length - 1, Math.ceil((off + sh) / rowH) - 1);
        for (var k = k0; k <= k1; k++) {
            var it = items[k];
            if (it === undefined) continue;
            var isStr = typeof it === 'string';
            var ry = sy + k * rowH - off;
            if (!isStr && (it.section || it.header || it.k === 'secao')) {
                UI.text(String(it.label === undefined ? it.section : it.label).toUpperCase(),
                        sx + 8, ry + Math.round((rowH - UI.lineHeight('caption')) / 2),
                        { role: 'caption', color: T.textDim, w: sw - 16, lines: 1 });
                continue;
            }
            var dis = !isStr && !!it.disabled;
            var t0 = UI.touch();
            var pressed = !dis && t0.down && t0.x >= sx && t0.x <= sx + sw &&
                          t0.y >= ry && t0.y <= ry + rowH;
            UI.card(sx, ry + 1, sw, rowH - 2, {
                color: dis ? T.card : rowBg,
                radius: o.rowR === undefined ? 8 : o.rowR,
                stroke: false
            });
            if (isStr) it = { label: it };
            if (o.paintRow) {
                o.paintRow(it, sx + 8, ry, sw - 16, rowH,
                           { pressed: pressed, disabled: dis, selected: k === o.selected });
            } else {
                var color = dis ? T.textDim
                          : (it.color === undefined ? T.text : it.color);
                var tx = sx + 8;
                if (it.icon && A.icons) {
                    A.icons.draw(it.icon, tx, ry + Math.round((rowH - 16) / 2), 16,
                                 { color: color });
                    tx += 22;
                }
                var rw = 0;
                if (it.right !== undefined) rw = UI.measure(String(it.right), 'caption') + 10;
                else if (it.badge !== undefined)
                    rw = UI.measure(String(it.badge), 'caption') + 22;
                else if (it.bars >= 0) rw = 26;
                var lw = sw - (tx - sx) - 8 - rw;
                var sub = it.sub !== undefined && it.sub !== '';
                // rotulo e legenda EMPILHADOS pela altura real das fontes e
                // centrados no par (a legenda nunca encosta no rotulo)
                var ty = ry + Math.round((rowH - (sub ? two : lh)) / 2);
                UI.text(String(it.label === undefined ? '' : it.label), tx, ty,
                        { role: 'body', color: color, w: lw, lines: 1 });
                if (sub) {
                    UI.text(String(it.sub), tx, ty + lh + 1,
                            { role: 'caption', color: T.textDim, w: lw, lines: 1 });
                }
                if (it.right !== undefined) {
                    UI.text(String(it.right), sx + sw - 8,
                            ry + Math.round((rowH - UI.lineHeight('caption')) / 2),
                            { role: 'caption', align: 'right',
                              color: it.rightColor === undefined ? T.textDim : it.rightColor,
                              w: rw, lines: 1 });
                } else if (it.badge !== undefined) {
                    UI.badge(String(it.badge),
                             sx + sw - 8 - Math.round(UI.measure(String(it.badge), 'caption') + 14),
                             ry + Math.round((rowH - (UI.lineHeight('caption') + 6)) / 2),
                             { color: it.badgeColor });
                } else if (it.bars >= 0) {
                    var bx = sx + sw - 8 - 23, by = ry + Math.round((rowH - 14) / 2);
                    for (var bi = 0; bi < 4; bi++) {
                        var bh = 4 + bi * 3;
                        S.fillRect(bx + bi * 5, by + 14 - bh, 3, bh,
                                   bi < it.bars ? (it.rightColor === undefined ? T.ok : it.rightColor)
                                                : T.stroke);
                    }
                }
            }
            if (o.widget) o.widget(it, sx, ry, sw, rowH);
            UI.cardEnd();
            var t = UI.touch();
            if (t.tap && fired < 0 && t.x >= sx && t.x <= sx + sw &&
                t.y >= ry && t.y <= ry + rowH && !dis) fired = k;
        }
        UI.scrollEnd();
        if (panel) UI.cardEnd();
        return fired;
    }
};

A._mods.push('list');

module.exports = A;
