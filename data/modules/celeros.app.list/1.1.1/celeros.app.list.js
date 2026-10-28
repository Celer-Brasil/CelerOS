

























var A = require('celeros.app');

A.list = {
version: '1.1.1',



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



sort: function (items, keyFn, desc) {
var n = items.length;
var keys = new Array(n);
for (var i = 0; i < n; i++) keys[i] = String(keyFn(items[i]));



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


badge: function (kind) {
var T = A.T || System.theme();
return kind === 'ok' ? T.ok :
kind === 'warn' ? T.warn :
kind === 'err' ? T.err : T.textDim;
},


bars: function (rssi) {
if (typeof rssi !== 'number' || rssi >= 0) return -1;
if (rssi > -55) return 4;
if (rssi > -67) return 3;
if (rssi > -78) return 2;
if (rssi > -88) return 1;
return 0;
},









view: function (id, x, y, w, h, items, o) {
o = o || {};
var S = System;
var T = (A.style && A.style.T) || A.T || S.theme() || {};
var rowH = o.row === undefined ? 36 : o.row;
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
var lh = UI.lineHeight('body');
var sub = it.sub !== undefined && it.sub !== '';
UI.text(String(it.label === undefined ? '' : it.label), tx,
ry + Math.round(sub ? rowH * .24 : (rowH - lh) / 2),
{ role: 'body', color: color, w: lw, lines: 1 });
if (sub) {
UI.text(String(it.sub), tx, ry + Math.round(rowH * .55),
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
