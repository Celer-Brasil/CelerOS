


















var A = require('celeros.app');
require('celeros.app.text');

A.chat = {
version: '1.0.0',


new: function (o) {
o = o || {};
var T = A.T || System.theme();
var W = 240;
var PAD = o.pad || 8;
var t = {
view: [],
busy: false,
max: o.max || 60,
bw: o.bw || 180,
top: o.top === undefined ? 4 : o.top,
height: 0
};

function push(k, s, color) {
s = A.text.fit(s);
var it = { k: k, s: s, c: color };
if (k === 'note') {
it.h = UI.measureWrap(s, W - 24, 'caption');
} else {
var oneLine = UI.measure(s, 'body') + 2 * PAD;
it.bw = oneLine < t.bw ? Math.max(oneLine, 40) : t.bw;
it.h = UI.measureWrap(s, it.bw - 2 * PAD, 'body') + 12;
}
t.view.push(it);
if (t.view.length > t.max) t.view.shift();
UI.scrollTo('kit:chat', 1e6);
}

t.push = push;
t.user = function (s) { push('user', s); };
t.bot = function (s) { push('assistant', s); };
t.note = function (s, color) { push('note', s, color === undefined ? T.textDim : color); };
t.err = function (s) { push('note', s, T.err); };
t.clear = function () { t.view = []; UI.invalidate(); };



t.draw = function (full, h) {
var y = t.top + 6;
var i, it;
for (i = 0; i < t.view.length; i++) y += t.view[i].h + 8;
if (t.busy) y += 36;
var contentH = y;
t.height = contentH;
var hh = h || (320 - t.top - 44);
var off = UI.scrollBegin('kit:chat', 0, t.top, W, hh, Math.max(hh, contentH));
y = t.top + 6 - off;
for (i = 0; i < t.view.length; i++) {
it = t.view[i];
var vis = y + it.h >= t.top && y < t.top + hh;
if (it.k === 'note') {
if (full && vis) {
UI.text(it.s, W / 2, y, { role: 'caption', align: 'center',
color: it.c, w: W - 24, lines: 64, id: i });
}
} else {
var mine = it.k === 'user';
var x = mine ? W - 8 - it.bw : 8;
var bg = mine ? T.accentD : T.raised;
if (full && vis) {
System.fillRoundRect(x, y, it.bw, it.h, 12, bg);
UI.text(it.s, x + PAD, y + 6, { w: it.bw - 2 * PAD, lines: 64, bg: bg, id: i });
}
}
y += it.h + 8;
}
if (t.busy) {
if (full) System.fillRoundRect(8, y, 64, 28, 12, T.raised);
UI.spinner(40, y + 14, 9);
} else if (!t.view.length && full) {
UI.text('Sem mensagens', W / 2, t.top + hh / 2 - 8,
{ role: 'caption', align: 'center', color: T.textDim });
}
UI.scrollEnd();
return contentH;
};

return t;
}
};

A._mods.push('chat');

module.exports = A;
