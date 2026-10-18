



















var A = require('celeros.app');

A.data = {
version: '1.0.0',



load: function (file, fallback) {
try {
var s = FS.readTextFile(file);
if (s) {
var v = JSON.parse(s);
if (v !== undefined && v !== null) return v;
}
} catch (e) { }
return fallback;
},

save: function (file, v) {
try { return FS.writeTextFile(file, JSON.stringify(v)); } catch (e) { return false; }
},



loadState: function (key, fallback) {
try {
var s = Storage.get(key);
if (s) return JSON.parse(s);
} catch (e) { }
return fallback;
},

saveState: function (key, v) {
try { return Storage.set(key, JSON.stringify(v)); } catch (e) { return false; }
},


stale: function (cache, maxAgeMs) {
if (!cache || !cache.at) return true;
return (System.millis() - cache.at) >= maxAgeMs;
},




file: function (name) {
var d = '';
try { d = FS.appData() || ''; } catch (e) { d = ''; }
return d ? d + name : String(name);
}
};

A._mods.push('data');

module.exports = A;
