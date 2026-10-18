













var A = require('celeros.app');

A.text = {
version: '1.0.1',


fit: function (s) {
return String(s === null || s === undefined ? '' : s)
.replace(/[^\u0000-\u00ff\n]/g, '');
},


lines: function (s, w, role) {
try { return UI.measureWrap(s, w, role || 'body'); } catch (e) { return 1; }
},



viewer: function (title, getText) {
var T = A.T || System.theme();
var s = A.text.fit(getText());
UI.resetScroll('kit:leitor');
UI.invalidate();
var top = 48;
var h = 320 - top - 6;
for (;;) {
UI.begin(T.bg);
if (UI.header(title, { back: true })) return;
var contentH = UI.measureWrap(s, 216, 'body');
var off = UI.scrollBegin('kit:leitor', 4, top, 232, h, Math.max(h, contentH + 8));

UI.text(s, 12, top + 4 - off, { w: 216, lines: 64 });
UI.scrollEnd();
UI.end(30);
}
}
};

A._mods.push('text');

module.exports = A;
