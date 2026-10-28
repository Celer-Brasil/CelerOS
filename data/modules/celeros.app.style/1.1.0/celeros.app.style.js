























var A = require('celeros.app');
var S = System;


function mix(a, b, t) {
if (t <= 0) return a;
if (t >= 1) return b;
var r1 = (a >> 11) & 31, g1 = (a >> 5) & 63, b1 = a & 31;
var r2 = (b >> 11) & 31, g2 = (b >> 5) & 63, b2 = b & 31;
var r = Math.round(r1 + (r2 - r1) * t);
var g = Math.round(g1 + (g2 - g1) * t);
var bl = Math.round(b1 + (b2 - b1) * t);
return (r << 11) | (g << 5) | bl;
}
function col(r, g, b) { return S.color(r, g, b); }
function info() {
try { return S.getInfo() || {}; } catch (e) { return {}; }
}

var _nr = { x: 0, y: 0, w: 0, h: 0 };


var T = {
preset: 'soft',
bg: 0, card: 0, raised: 0, stroke: 0, accent: 0, accentD: 0,
onAccent: 0, text: 0, textDim: 0, ok: 0, warn: 0, err: 0,
radius: 10, gap: 8, pad: 10, shadow: 1, grad: true,
_src: null
};

function apply(name, th, notify) {
th = th || S.theme() || {};
T.preset = name;
T.bg = th.bg === undefined ? 0x0000 : th.bg;
T.card = th.card === undefined ? 0x2104 : th.card;
T.raised = th.raised === undefined ? 0x3186 : th.raised;
T.stroke = th.stroke === undefined ? 0x4208 : th.stroke;
T.accent = th.accent === undefined ? 0x07FF : th.accent;
T.accentD = th.accentD === undefined ? 0x0333 : th.accentD;
T.onAccent = th.onAccent === undefined ? 0x0000 : th.onAccent;
T.text = th.text === undefined ? 0xFFFF : th.text;
T.textDim = th.textDim === undefined ? 0x8410 : th.textDim;
T.ok = th.ok === undefined ? 0x05E0 : th.ok;
T.warn = th.warn === undefined ? 0xFD20 : th.warn;
T.err = th.err === undefined ? 0xF800 : th.err;
if (name === 'flat') {
T.radius = 6; T.shadow = 0; T.grad = false;
} else if (name === 'neon') {
T.radius = 12; T.shadow = 2; T.grad = true;
T.bg = 0x0000;
T.card = 0x0841;
T.raised = 0x10A2;
T.stroke = T.accent;
T.text = 0xFFFF;
T.textDim = 0x8410;
T.accentD = mix(T.accent, 0x0000, 0.45);
} else if (name === 'paper') {
T.radius = 2; T.shadow = 1; T.grad = false;
T.bg = col(242, 238, 228); T.card = col(255, 253, 247);
T.raised = col(232, 226, 212); T.stroke = col(185, 176, 156);
T.text = col(28, 27, 24); T.textDim = col(107, 100, 89);
T.accent = col(47, 111, 237); T.accentD = col(29, 79, 184);
T.onAccent = 0xFFFF; T.ok = col(46, 158, 91);
T.warn = col(217, 138, 0); T.err = col(198, 53, 47);
} else {
T.radius = 10; T.shadow = 2; T.grad = true;
}
T._src = th;
if (notify) UI.invalidate();
}

function ensure() {
if (A.T && T._src !== A.T) apply(T.preset || 'soft', A.T, true);
}


function shadow(x, y, w, h, r, n, bg) {
for (var i = n; i >= 1; i--) {
var e = i * 2;
S.fillSmoothRoundRect(x - e, y - e + 2, w + e * 2, h + e * 2, r + e,
mix(bg, 0x0000, 0.12 * i));
}
}


A.style = {
version: '1.1.0',
T: T,


full: !!(UI.extras && UI.custom),

preset: function (name) {
apply(name || 'soft', A.T || S.theme(), true);
return T;
},
reset: function () {
apply('soft', A.T || S.theme(), true);
return T;
},


inset: function () { return info().inset || 0; },


content: function (top, bottom) {
ensure();
var L = A.L || { x: 8, w: 224, top: 48, bottom: 312 };
var y = top === undefined ? L.top : top;
var b = bottom === undefined ? L.bottom : bottom;
return { x: L.x, y: y, w: L.w, h: b - y };
},


stack: function (x, y, w, o) {
ensure();
o = o || {};
var st = {
x: x, y: y, w: w, dir: o.dir || 'v',
gap: o.gap === undefined ? T.gap : o.gap,
cursor: 0
};
st.next = function (h, ww) {
_nr.x = st.dir === 'h' ? st.x + st.cursor : st.x;
_nr.y = st.dir === 'h' ? st.y : st.y + st.cursor;
_nr.w = ww === undefined ? st.w : ww;
_nr.h = h;
st.cursor += (st.dir === 'h' ? _nr.w : h) + st.gap;
return _nr;
};
st.reset = function () { st.cursor = 0; };
st.end = function () { return st.cursor > 0 ? st.cursor - st.gap : 0; };
return st;
},


icon: function (name, x, y, size, o) {
ensure();
if (A.icons) return A.icons.draw(name, x, y, size, o);
var s = size === undefined ? 16 : size;
var c = (o && o.color !== undefined) ? o.color : T.text;
S.fillCircle(x + s / 2, y + s / 2, Math.max(1, s / 5), c);
},



card: function (x, y, w, h, o) {
ensure();
o = o || {};
var pad = o.pad === undefined ? T.pad : o.pad;
var r = o.r === undefined ? T.radius : o.r;
var bg = o.bg === undefined ? T.card : o.bg;
var stroke = o.stroke !== false;
if (o.full) {
var el = o.elev === undefined ? T.shadow : o.elev;
if (el > 0) shadow(x, y, w, h, r, el, bg);
}
UI.card(x, y, w, h, { color: bg, radius: r, stroke: stroke });
if (o.full && (o.grad === undefined ? T.grad : o.grad)) {
S.fillGradient(x, y, w, h, mix(bg, 0xFFFF, 0.06), bg, r);
if (stroke) S.drawRoundRect(x, y, w, h, r, T.stroke);
}
var cr = { x: x + pad, y: y + pad, w: w - pad * 2, h: h - pad * 2, bg: bg };
if (typeof o.draw === 'function') {
o.draw(cr);
UI.cardEnd();
}
return cr;
},
cardEnd: function () { UI.cardEnd(); },




custom: function (id, x, y, w, h, sig, draw, o) {
ensure();
o = o || {};
return A.custom(id, x, y, w, h, sig, draw,
{ bg: o.bg === undefined ? T.card : o.bg, clear: o.clear });
},

divider: function (x, y, w, o) {
ensure();
o = o || {};
S.fillRect(x, y, w, o.h === undefined ? 1 : o.h,
o.color === undefined ? T.stroke : o.color);
},




button: function (label, x, y, w, h, o) {
ensure();
o = o || {};
if (o.icon && A.widgets && A.widgets.button) {
return A.widgets.button(label, x, y, w, h, o);
}
var variant = o.variant || (o.primary === false ? 'secondary' : 'primary');
var st = variant === 'ghost' ? 'ghost'
: variant === 'danger' ? 'danger' : 'primary';
var bo = { style: st, disabled: !!o.disabled, role: o.role || 'body' };
if (o.color !== undefined) bo.color = o.color;
else if (variant === 'primary') bo.color = T.accent;
else if (variant === 'danger') bo.color = T.err;
else if (variant === 'success') bo.color = T.ok;
else if (variant === 'secondary') bo.color = T.raised;
if (o.textColor !== undefined) bo.textColor = o.textColor;
else if (variant === 'primary') bo.textColor = T.onAccent;
else if (variant === 'danger') bo.textColor = 0xFFFF;
else if (variant === 'success') bo.textColor = 0x0000;
else if (variant === 'ghost') bo.textColor = T.accent;
else bo.textColor = T.text;
return UI.button(label, x, y, w, h, bo);
}
};

apply('soft', A.T || S.theme(), false);
A._mods.push('style');

module.exports = A;
