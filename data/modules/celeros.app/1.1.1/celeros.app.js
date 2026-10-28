








































var A = { version: '1.1.1' };


A.BACK = '..';
A.EXIT = '\u0001';

A._mods = [];
A._stack = [];
A._marks = {};
A._cs = {};
A._ctx = { full: false, now: 0, entered: false };


var MAX_STACK = 8;




A.T = null;
A.L = null;
A.full = false;
A.init = function () {
A.T = System.theme();

var ins = 0;
try { ins = (System.getInfo() || {}).inset || 0; } catch (e) { ins = 0; }
var m = Math.round(ins / 2);


A.L = { x: 8 + m, y: 48, w: 224 - 2 * m, top: 48,
bottom: 312 - m, cx: 120 };
return A;
};










A.custom = function (id, x, y, w, h, sig, draw, o) {
if (typeof draw !== 'function') return false;
if (UI.extras && typeof UI.custom === 'function') {
return UI.custom(id, x, y, w, h, sig, draw, o);
}
var key = 'c' + id;
if (!A.full && A._cs[key] === sig) return false;
A._cs[key] = sig;
o = o || {};
if (!A.full && o.clear !== false) {
System.fillRect(x, y, w, h,
o.bg === undefined ? (A.T || System.theme()).card : o.bg);
}
draw(x, y, w, h);
return true;
};

A.run = function (screens, first, opts) {
if (!A.T) A.init();
opts = opts || {};
A._stack.length = 0;
var cur = first;
var prev = null;
for (;;) {
var fn = screens[cur];
if (!fn) {
cur = first;
fn = screens[cur];
if (!fn) return;
}
var c = A._ctx;
if (cur !== prev) {
prev = cur;
UI.invalidate();
c.entered = true;
} else {
c.entered = false;
}
c.now = System.millis();
c.full = UI.begin(A.T.bg);
A.full = c.full;
var r = fn(c);
UI.end(typeof opts.fps === 'number' ? opts.fps : (fn.fps || 20));
if (r === A.EXIT) { System.exitApp(); return; }
if (r === A.BACK) {
if (!A._stack.length) { System.exitApp(); return; }
cur = A._stack.pop();
prev = null;
continue;
}
if (typeof r === 'string' && r !== cur && screens[r]) {
if (A._stack.length >= MAX_STACK) A._stack.shift();
A._stack.push(cur);
cur = r;
}

}
};




A.header = function (title, o) {
if (!o) o = {};
return UI.header(title, { sub: o.sub, back: o.back !== false });
};




A.busy = function (msg) {
UI.invalidate();
UI.begin();
UI.header(msg || 'Aguarde...', { back: false });
UI.spinner(120, 170, 18);
UI.end(10);
};


A.progress = function (p, msg) {
UI.invalidate();
UI.begin();
UI.header(msg || 'Baixando...', { back: false });
if (p >= 0) {
UI.progress(40, 150, 160, 12, p);
UI.text((p | 0) + '%', 120, 174, { align: 'center', role: 'caption', color: A.T.textDim });
} else {
UI.spinner(120, 160, 18);
}
UI.end(10);
};



A._result = function (title, lines, color) {
if (typeof lines === 'string') lines = [lines];
var Sys = System;
for (;;) {
UI.invalidate();
UI.begin(A.T.bg);
UI.header('', { back: false });
UI.card(20, 90, 200, 160);
Sys.fillCircle(120, 130, 18, color);
if (color === A.T.err) {
Sys.drawWideLine(112, 122, 128, 138, 3, 0xFFFF);
Sys.drawWideLine(128, 122, 112, 138, 3, 0xFFFF);
} else {
Sys.drawWideLine(110, 130, 117, 140, 3, 0xFFFF);
Sys.drawWideLine(117, 140, 133, 119, 3, 0xFFFF);
}
UI.text(title, 120, 160, { align: 'center', w: 176, lines: 2 });
if (lines && lines.length) {
UI.text(lines.join(' '), 120, 190, { align: 'center', w: 176, lines: 4,
role: 'caption', color: A.T.textDim });
}
UI.cardEnd();
if (UI.button('OK', 70, 264, 100, 34)) return;
UI.end(15);
}
};
A.error = function (title, lines) { A._result(title, lines, A.T.err); };
A.ok = function (title, lines) { A._result(title, lines, A.T.ok); };




A.wifiWait = function (msg) {
for (;;) {
var on = false;
try { on = Net.isConnected(); } catch (e) { return false; }
if (on) return true;
UI.invalidate();
UI.begin(A.T.bg);
UI.header('Wi-Fi', { back: false });
UI.card(20, 90, 200, 120);
UI.spinner(120, 128, 14);
UI.text(msg || 'Esperando a rede voltar...', 120, 154, { align: 'center', w: 176,
lines: 3, role: 'caption', color: A.T.textDim });
UI.cardEnd();
if (UI.button('Cancelar', 70, 264, 100, 34)) return false;
UI.end(8);
}
};





A.now = function () { return System.millis(); };
A.every = function (ms, key) {
var now = System.millis();
var k = key || '_';
var last = A._marks[k];
if (last === undefined || now - last >= ms) { A._marks[k] = now; return true; }
return false;
};


A.toast = function (msg, ms) { UI.toast(msg, ms); };
A.exit = function () { System.exitApp(); };

module.exports = A;
