// app.widgets.js — CelerKit WIDGETS (dep "celeros.app.widgets"): o chrome
// e os controles que o UI nativo nao tem, desenhados em JS sobre UI.card +
// System.* (sem firmware novo): header com acoes, botao com icone/gradiente,
// iconButton, anel/medidor, sheet inferior e stepper. Requer style+icons.
// Decora o core:
//
//   var A = require("celeros.app");
//   require("celeros.app.style");
//   require("celeros.app.widgets");
//   var h = A.widgets.header("Rede", { full: c.full,
//       actions: [{ icon: "wifi", id: "wifi" }] });
//   if (h.back) return A.BACK;
//   if (h.action === "wifi") ...
//   A.widgets.ring(120, 100, 40, 0.72, { label: "72%" });
//   var s = A.widgets.sheet("cfg", { open: cfgOpen, full: c.full, h: 180,
//       title: "Opcoes" }, function (r) { ... });
//   if (s === "close") cfgOpen = false;
//
// 1.0.2: ring a prova de NaN no frac (o guard `frac < 0` deixava NaN passar
// e o arco morria sem pintar).
// 1.0.0: primeira versao (header/acoes, button/iconButton, ring, sheet,
// stepper, segmented).

var A = require('celeros.app');
require('celeros.app.style');
require('celeros.app.icons');
var S = System;

function mix(a, b, t) {
    if (t <= 0) return a;
    if (t >= 1) return b;
    var r1 = (a >> 11) & 31, g1 = (a >> 5) & 63, b1 = a & 31;
    var r2 = (b >> 11) & 31, g2 = (b >> 5) & 63, b2 = b & 31;
    return (Math.round(r1 + (r2 - r1) * t) << 11) |
           (Math.round(g1 + (g2 - g1) * t) << 5) |
           Math.round(b1 + (b2 - b1) * t);
}

var _tap = false;
var _bOn = false;
var _sh = {};

function touch() {
    var t = UI.touch();
    if (!t.tap) _tap = false;
    return t;
}
function tapIn(x, y, w, h) {
    var t = touch();
    if (!t.tap || _tap) return false;
    if (t.x >= x && t.x <= x + w && t.y >= y && t.y <= y + h) {
        _tap = true;
        return true;
    }
    return false;
}
function pressIn(x, y, w, h) {
    var t = UI.touch();
    return t.down && t.x >= x && t.x <= x + w && t.y >= y && t.y <= y + h;
}

A.widgets = {
    version: '1.0.2',

    // botao com icone (o A.style.button delega para ca quando ha icone).
    // Sem icone o caminho nativo do style (UI.button) e melhor: ele tem
    // press/disabled/fit de texto prontos.
    // variant (primary/danger/success/secondary/ghost) resolve as cores
    // AQUI: o A.style.button delega com o `o` cru quando ha icone, e sem
    // isto icone+variant caia no primario (o d.ts ja promete a variante).
    button: function (label, x, y, w, h, o) {
        o = o || {};
        var T = A.style.T;
        var dis = !!o.disabled;
        var v = o.variant;
        var bg = dis ? T.card
               : o.bg !== undefined ? o.bg
               : v === 'danger' ? T.err
               : v === 'success' ? T.ok
               : v === 'secondary' ? T.raised
               : v === 'ghost' ? T.card : T.accent;
        var fg = dis ? T.textDim
               : o.textColor !== undefined ? o.textColor
               : v === 'danger' ? 0xFFFF
               : v === 'success' ? 0x0000
               : v === 'ghost' ? T.accent
               : v === 'secondary' ? T.text : T.onAccent;
        var on = !dis && pressIn(x, y, w, h);
        if (on !== _bOn) { _bOn = on; UI.invalidate(); }
        UI.card(x, y, w, h, {
            color: on ? mix(bg, 0x0000, 0.15) : bg,
            radius: o.r === undefined ? T.radius : o.r,
            stroke: o.stroke === true
        });
        var isz = Math.round(Math.min(h * .5, 18));
        var lh = UI.lineHeight(o.role || 'body');
        if (o.icon && label) {
            A.icons.draw(o.icon, x + 8, Math.round(y + (h - isz) / 2), isz, { color: fg });
            UI.text(label, x + 8 + isz + 6, Math.round(y + (h - lh) / 2),
                    { role: o.role || 'body', color: fg, bg: bg,
                      w: w - 8 - isz - 14, lines: 1 });
        } else if (o.icon) {
            A.icons.draw(o.icon, x + Math.round((w - isz) / 2),
                         Math.round(y + (h - isz) / 2), isz, { color: fg });
        } else {
            UI.text(label, x + w / 2, Math.round(y + (h - lh) / 2),
                    { role: o.role || 'body', align: 'center', color: fg,
                      bg: bg, w: w - 16, lines: 1 });
        }
        UI.cardEnd();
        return !dis && tapIn(x, y, w, h);
    },

    iconButton: function (icon, x, y, size, o) {
        o = o || {};
        var T = A.style.T;
        var bg = o.bg === undefined ? T.raised : o.bg;
        var fg = o.color === undefined ? T.text : o.color;
        var on = !o.disabled && pressIn(x, y, size, size);
        if (on !== _bOn) { _bOn = on; UI.invalidate(); }
        UI.card(x, y, size, size, {
            color: on ? mix(bg, 0x0000, 0.15) : bg,
            radius: o.r === undefined ? Math.round(size / 2) : o.r,
            stroke: false
        });
        A.icons.draw(icon, x + Math.round((size - 16) / 2),
                     y + Math.round((size - 16) / 2), 16, { color: fg });
        UI.cardEnd();
        return !o.disabled && tapIn(x, y, size, size);
    },

    // header custom com voltar + acoes; devolve {back, action}
    header: function (title, o) {
        o = o || {};
        var T = A.style.T;
        var h = o.h === undefined ? 40 : o.h;
        var bg = o.bg === undefined ? T.card : o.bg;
        var back = o.back !== false;
        var acts = o.actions || [];
        var n = acts.length;
        var asz = h - 12;
        var agap = 4;
        var aw = n ? n * (asz + agap) + 8 : 0;
        UI.card(0, 0, 240, h, { color: bg, radius: 0, stroke: false });
        if (o.full) {
            if (T.grad) S.fillGradient(0, 0, 240, h, mix(bg, 0xFFFF, 0.05), bg, 0);
            S.fillRect(0, h - 1, 240, 1, T.stroke);
        }
        if (back) A.icons.draw('back', 6, Math.round((h - 18) / 2), 18, { color: T.accent });
        var tx = back ? 30 : 8;
        UI.text(title, tx, Math.round((h - UI.lineHeight('title')) / 2),
                { role: 'title', color: T.text, bg: bg, w: 240 - tx - aw - 8, lines: 1 });
        if (o.sub && !n) {
            UI.text(o.sub, 232, Math.round((h - UI.lineHeight('caption')) / 2),
                    { role: 'caption', align: 'right', color: T.textDim, bg: bg,
                      w: 120, lines: 1 });
        }
        var action = null;
        for (var i = 0; i < n; i++) {
            var ax = 240 - 8 - asz - (n - 1 - i) * (asz + agap);
            if (A.widgets.iconButton(acts[i].icon, ax, Math.round((h - asz) / 2),
                                     asz, { bg: bg, color: T.text })) {
                action = acts[i].id;
            }
        }
        var isBack = back && tapIn(0, 0, 44, h);
        UI.cardEnd();
        return { back: isBack, action: action };
    },

    // anel/medidor (frac 0..1); label opcional no centro
    ring: function (cx, cy, r, frac, o) {
        o = o || {};
        var T = A.style.T;
        var th = o.th === undefined ? 5 : o.th;
        // guard a prova de NaN: `frac < 0` deixava NaN passar e o arco
        // sumia sem pintar (mesmo padrao consertado no game.ui/world/grid)
        var f = !(frac >= 0) ? 0 : (frac > 1 ? 1 : frac);
        S.fillArc(cx, cy, Math.max(0, r - th), r, 0, 360,
                  o.bg === undefined ? T.raised : o.bg);
        if (f > 0.005) {
            S.fillArc(cx, cy, Math.max(0, r - th), r, -90, -90 + 360 * f,
                      o.color === undefined ? T.accent : o.color);
        }
        if (o.label !== undefined) {
            S.setTextColor(o.textColor === undefined ? T.text : o.textColor);
            S.setTextDatum(5);
            S.drawString(String(o.label), cx, cy, o.font || 2);
            S.setTextDatum(0);
            S.setTextSize(1);
        }
        return f;
    },

    // sheet inferior NAO bloqueante: devolve 'close' no toque fora, ou null.
    // Enquanto aberto, o app deve pular os widgets de tras (o veu nao consome).
    sheet: function (id, o, draw) {
        o = o || {};
        var T = A.style.T;
        id = id || 'sheet';
        var open = o.open === undefined ? true : !!o.open;
        var s = _sh[id];
        if (!s) s = _sh[id] = { p: 0, t: 0 };
        var now = S.millis();
        var dt = s.t ? now - s.t : 0;
        s.t = now;
        var target = open ? 1 : 0;
        if (s.p !== target) {
            var k = Math.min(1, dt / 160 * 4);
            s.p += (target - s.p) * k;
            if (Math.abs(target - s.p) < 0.02) s.p = target;
            UI.invalidate();
        }
        if (!open && s.p <= 0.001) return null;
        var W = 240, H = 320;
        var h = o.h === undefined ? 180 : o.h;
        var y = H - h * s.p;
        if (o.full) {
            S.fillRect(0, 0, W, H,
                       mix(T.bg, 0x0000, (o.dim === undefined ? 55 : o.dim) * s.p / 100));
        }
        A.style.card(0, y, W, h, {
            full: o.full, r: T.radius, grad: true,
            pad: o.pad === undefined ? 12 : o.pad,
            draw: function (c) {
                S.fillRoundRect(W / 2 - 20, y + 6, 40, 3, 2, T.stroke);
                var cy = c.y;
                if (o.title) {
                    UI.text(o.title, c.x, cy, { role: 'title', color: T.text,
                                                bg: c.bg, w: c.w, lines: 1 });
                    cy += UI.lineHeight('title') + 4;
                    A.style.divider(c.x, cy - 2, c.w);
                    cy += 4;
                }
                if (draw) draw({ x: c.x, y: cy, w: c.w, h: c.y + c.h - cy, bg: c.bg });
            }
        });
        if (open && !_tap) {
            var t = UI.touch();
            if (t.tap && t.y < y) { _tap = true; return 'close'; }
        }
        return null;
    },

    // controle segmentado (alias do tabs nativo)
    segmented: function (x, y, w, h, labels, sel) {
        return UI.tabs(x, y, w, h, labels, sel);
    }
};

A._mods.push('widgets');

module.exports = A;
