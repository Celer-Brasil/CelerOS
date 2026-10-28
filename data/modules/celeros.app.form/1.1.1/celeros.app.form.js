





























var A = require('celeros.app');
require('celeros.app.list');


function flat(rows) {
var out = [], i, j;
for (i = 0; i < rows.length; i++) {
if (rows[i] instanceof Array) {
for (j = 0; j < rows[i].length; j++) out.push(rows[i][j]);
} else out.push(rows[i]);
}
return out;
}

function rowsOf(rows) {
var T = A.T || System.theme();
var out = [];
for (var i = 0; i < rows.length; i++) {
var r = rows[i];
if (!r || !r.k) { out.push(r); continue; }
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
} else if (r.k === 'gauge' || r.k === 'stepper') {
var gv = r.get();
out.push({ label: r.label, right: String(r.fmt ? r.fmt(gv) : gv),
enabled: false });
} else {
out.push({ label: r.label, sub: r.sub });
}
}
return out;
}

A.form = {
version: '1.1.1',


info: function (label, value, color) {
return { k: 'info', label: label, right: String(value), rightColor: color };
},
action: function (label, cb, o) {
return { k: 'action', label: label, cb: cb, sub: o && o.sub };
},
toggle: function (label, get, set) {
return { k: 'toggle', label: label, get: get, set: set };
},

choice: function (label, get, set, opts) {
return { k: 'choice', label: label, get: get, set: set, opts: opts };
},

picker: function (label, get, set, items) {
return { k: 'picker', label: label, get: get, set: set, items: items };
},
secao: function (title) { return { k: 'secao', label: title }; },


gauge: function (label, get, o) {
o = o || {};
return { k: 'gauge', label: label, get: get,
min: o.min === undefined ? 0 : o.min,
max: o.max === undefined ? 100 : o.max,
fmt: o.fmt, color: o.color };
},

stepper: function (label, get, set, o) {
o = o || {};
return { k: 'stepper', label: label, get: get, set: set,
min: o.min === undefined ? 0 : o.min,
max: o.max === undefined ? 100 : o.max,
step: o.step === undefined ? 1 : o.step,
fmt: o.fmt };
},

card: function (title, rows) {
return [A.form.secao(title)].concat(rows || []);
},




run: function (title, build) {
var T = A.T || System.theme();
var rows = null;
UI.resetScroll('kit:form');
for (;;) {
UI.begin(T.bg);
if (UI.header(title, { back: true })) return;
if (!rows) rows = flat(build());
var i;
if (A.list && A.list.view && A.rows && A.rows.formRow) {
i = A.list.view('kit:form', A.L.x, A.L.top, A.L.w,
A.L.bottom - A.L.top, rows,
{ row: 36, paintRow: A.rows.formRow });
} else {
i = UI.list('kit:form', A.L.x, A.L.top, A.L.w,
A.L.bottom - A.L.top, rowsOf(rows));
}
if (i >= 0) {
var r = rows[i];
var refresh = false;
if (r && r.k === 'toggle') { r.set(!r.get()); refresh = true; }
else if (r && r.k === 'stepper') {
var sv = r.get() + r.step;
if (sv > r.max) sv = r.max;
if (sv < r.min) sv = r.min;
r.set(sv);
} else if (r && r.k === 'choice') {
r.set(((r.get() | 0) + 1) % r.opts.length);
refresh = true;
} else if (r && r.k === 'picker') {
var p = A.form.pick(r.label, r.items, r.get() | 0);
if (p >= 0) { r.set(p); refresh = true; }
} else if (r && r.k === 'action' && r.cb) {
refresh = r.cb() !== false;
}
if (refresh) rows = null;
UI.invalidate();
}
UI.end(20);
}
},


pick: function (title, items, selected) {
var T = A.T || System.theme();
var rows = [];
for (var i = 0; i < items.length; i++) rows.push({ label: items[i] });
UI.resetScroll('kit:pick');
for (;;) {
UI.begin(T.bg);
if (UI.header(title, { back: true })) return -1;
var j = UI.list('kit:pick', A.L.x, A.L.top, A.L.w, A.L.bottom - A.L.top,
rows, { selected: selected });
if (j >= 0) return j;
UI.end(20);
}
},






askText: function (title, o) {
o = o || {};
try {
return System.prompt(title, o.initial || '',
{ hint: o.hint, mask: !!o.mask, nullOnCancel: true });
} catch (e) { return null; }
},



askNum: function (title, o) {
o = o || {};
var semente = o.initial === undefined || o.initial === null ? '' : String(o.initial);
for (;;) {
var s = A.form.askText(title, { hint: o.hint, initial: semente });
if (s === null || s === '') return null;
semente = s;
var v = parseFloat(String(s).replace(',', '.'));
var bad = isNaN(v) ||
(o.int && Math.round(v) !== v) ||
(o.min !== undefined && v < o.min) ||
(o.max !== undefined && v > o.max);
if (!bad) return v;
A.error('Valor inválido', 'Digite um número' +
(o.int ? ' inteiro' : '') +
(o.min !== undefined && o.max !== undefined ? ' entre ' + o.min + ' e ' + o.max : ''));
}
}
};

A._mods.push('form');

module.exports = A;
