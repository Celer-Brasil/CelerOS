



















var A = require('celeros.app');

A.input = {
version: '1.0.0',
_kb: false,
_top: 320,



open: function (o) {
o = o || {};
var ok = false;
try { ok = !!System.keypadOpen({ field: false, maxLen: o.maxLen || 256 }); }
catch (e) { ok = false; }
A.input._kb = ok;
A.input._top = 320;
if (ok) {
try {
var r = System.keypadRect();
if (r && r.y) A.input._top = r.y;
} catch (e2) { }
if (o.chips && typeof System.topbarButtons === 'function') {
System.topbarButtons(o.chips);
}
}
return ok;
},


top: function () { return A.input._top; },
ativo: function () { return A.input._kb; },


text: function () {
try { return System.keypadText() || ''; } catch (e) { return ''; }
},



poll: function () {
if (!A.input._kb) return null;
var ev = null;
try { ev = System.keypadPoll(); } catch (e) { return null; }
if (!ev) return null;
if (ev.type === 'cancel') {
A.input.open({});
UI.invalidate();
}
return ev;
},



redraw: function (full) {
if (full && A.input._kb) {
try { System.keypadDraw(); } catch (e) { }
}
},



line: function (placeholder) {
var T = A.T || System.theme();
var y = A.input._top - 36;
UI.card(6, y, 228, 30, { radius: 15, stroke: true });
var s = System.keypadText() || '';
var cur = (Math.floor(System.millis() / 500) % 2) ? '_' : ' ';
var shown = s;
while (shown.length && UI.measure(shown + '_', 'body') > 200) shown = shown.substring(1);
if (s.length || cur === '_') {
UI.text(shown + cur, 18, y + 7, { color: s.length ? T.text : T.textDim, id: 1 });
} else {
UI.text(placeholder || 'Mensagem', 18, y + 7, { color: T.textDim, id: 1 });
}
UI.cardEnd();
},


chips: function (labels) {
if (typeof System.topbarButtons === 'function') System.topbarButtons(labels);
},
chip: function () {
if (typeof System.topbarPop !== 'function') return null;
try { return System.topbarPop(); } catch (e) { return null; }
},

close: function () {
A.input._kb = false;
try { if (System.keypadClose) System.keypadClose(); } catch (e) { }
}
};

A._mods.push('input');

module.exports = A;
