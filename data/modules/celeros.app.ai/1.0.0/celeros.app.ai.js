




















var A = require('celeros.app');
require('celeros.app.data');
require('celeros.app.text');
require('celeros.app.net');

A.ai = {
version: '1.0.0',



client: function (o) {
o = o || {};
var hasAI = (typeof AI !== 'undefined') && (typeof AI.chat === 'function');
var CTX = o.ctx || 12;
var MAX = o.max || 20;
var file = A.data.file(o.file || 'historico.json');
var note = o.note || function () {};
var err = o.err || function () {};
var onmsg = o.onmsg || function () {};
var hist = A.data.load(file, []);
if (!hist || typeof hist.length !== 'number') hist = [];

function persist() { A.data.save(file, hist); }
function pushMsg(role, text) {
var m = { r: role, s: A.text.fit(text) };
hist.push(m);
if (hist.length > MAX) hist.shift();
onmsg(role, m.s);
persist();
return m;
}

var c = {
busy: false,
hist: hist,
ok: hasAI,


send: function (text) {
if (c.busy) { note('(a IA ainda está respondendo)'); return false; }
if (!hasAI) { err('sem AI no firmware (requer API >= 18)'); return false; }
var conf = false;
try { conf = AI.configured(); } catch (e) { conf = false; }
if (!conf) { err('IA sem chave: configure o provedor'); return false; }
if (!A.net.online()) { err('sem WiFi'); return false; }
pushMsg('user', text);
var payload = [];
if (o.system) payload.push({ role: 'system', content: o.system });
var start = Math.max(0, hist.length - CTX);
for (var i = start; i < hist.length; i++) {
payload.push({ role: hist[i].r, content: hist[i].s });
}
return c._ask(payload, false);
},



_ask: function (payload, isRetry) {
if (c.busy) return false;
c.busy = true;
var started = false;
try {
started = AI.chat({ messages: payload, max_tokens: o.maxTokens || 400 },
function (r) {
c.busy = false;
if (!isRetry && r && !r.ok &&
(r.status === 502 || r.status === 504 || r.status === 429)) {
note('repetindo...');
setTimeout(function () { c._ask(payload, true); }, 2000);
return;
}
if (r && r.ok && r.content) {
pushMsg('assistant', r.content);
if (r.usage && r.usage.total_tokens) {
note('(' + r.usage.total_tokens + ' tokens)');
}
} else if (r && r.ok) {
err('IA: resposta vazia');
} else {
err('IA: erro ' + (r && r.error ? r.error : 'HTTP ' + (r ? r.status : 0)));
if (r && r.detail) note('detalhe: ' + A.text.fit(r.detail));
}
UI.invalidate();
});
} catch (e) {


c.busy = false;
err('IA: ' + (e && e.message ? e.message : e));
UI.invalidate();
return false;
}
if (!started) {
c.busy = false;
err('IA: ocupado, tente de novo');
}
UI.invalidate();
return started;
},

cancel: function () {
var ok = false;
try { ok = hasAI && c.busy && AI.cancel(); } catch (e) { ok = false; }
if (ok) c.busy = false;
return ok;
},

clear: function () {
hist.length = 0;
persist();
UI.invalidate();
}
};
return c;
}
};

A._mods.push('ai');

module.exports = A;
