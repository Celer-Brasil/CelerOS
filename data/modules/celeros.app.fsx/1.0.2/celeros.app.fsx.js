

















var A = require('celeros.app');
require('celeros.app.path');




function nomeSeguro(n) {
var s = String(n === undefined || n === null ? '' : n);
return s.length > 0 && s !== '.' && s !== '..' && s.indexOf('/') < 0 &&
s.indexOf('\\') < 0 && s.indexOf('..') < 0;
}

A.fsx = {
version: '1.0.2',




free: function (drive) {
try { return FS.getFreeSpace(drive || '/local') || 0; } catch (e) { return 0; }
},
hasRoom: function (bytes, drive) { return A.fsx.free(drive) > bytes; },


ensureDir: function (p) {
var parts = String(p).split('/');
var cur = '';
for (var i = 0; i < parts.length; i++) {
if (!parts[i]) { cur = '/'; continue; }
cur = (cur === '/' ? '' : cur) + '/' + parts[i];
try {
if (!FS.isDirectory(cur) && !FS.mkdir(cur)) return false;
} catch (e) { return false; }
}
return true;
},


treeSize: function (dir) {
var total = 0;
var list = [];
try { list = FS.listDir(dir) || []; } catch (e) { return 0; }
for (var i = 0; i < list.length; i++) {
try {
if (FS.isDirectory(list[i])) total += A.fsx.treeSize(list[i]);
else total += FS.getFileSize(list[i]) || 0;
} catch (e2) { }
}
return total;
},

copy: function (src, dst) {
try { return !!FS.copyDirectory(src, dst); } catch (e) { return false; }
},


md5: function (file) {
try { return FS.getFileMD5(file) || ''; } catch (e) { return ''; }
},









stage: function (dir, files, json, onStep) {
if (!A.fsx.ensureDir(dir)) return false;
var staged = [];
var fail = '';
for (var i = 0; i < files.length && !fail; i++) {
var fe = files[i];
if (!fe || !nomeSeguro(fe.name)) { fail = 'Nome de arquivo invalido no pacote'; break; }
var ftmp = dir + '/' + fe.name + '.new';
var ok = false;
try {
ok = !!Net.download(fe.url, ftmp, function (got, total) {
if (onStep) onStep(fe.name, got, total);
});
} catch (e) { ok = false; }
if (!ok) { fail = 'Erro ao baixar ' + fe.name; break; }
if (fe.md5 && A.fsx.md5(ftmp) !== fe.md5) {
try { FS.deleteFile(ftmp); } catch (e2) { }
fail = 'Verificacao falhou (md5)';
break;
}
staged.push({ tmp: ftmp, dst: dir + '/' + fe.name });
}

if (!fail && json) {
var jtmp = dir + '/app.json.new';
if (!FS.writeTextFile(jtmp, json)) fail = 'Erro ao gravar app.json';
else staged.push({ tmp: jtmp, dst: dir + '/app.json' });
}
if (fail) {
for (var s = 0; s < staged.length; s++) {
try { FS.deleteFile(staged[s].tmp); } catch (e3) { }
}
return false;
}
for (var r = 0; r < staged.length; r++) {
if (!FS.renameFile(staged[r].tmp, staged[r].dst)) return false;
}
return true;
},







zipBlob: function (url, appName, md5, onProg) {
if (typeof System.installZip !== 'function') return null;
var zpath = '/local/kit_install.zip';
var ok = false;
try {
ok = !!Net.download(url, zpath, function (got, total) {
if (onProg) onProg(got, total);
});
} catch (e) { ok = false; }
if (!ok || A.fsx.md5(zpath) !== md5) {
try { FS.deleteFile(zpath); } catch (e2) { }
return false;
}
var res = null;
try { res = System.installZip(zpath, A.path.safeName(appName)); } catch (e3) { res = null; }
try { FS.deleteFile(zpath); } catch (e4) { }
return !!(res && res.ok);
}
};

A._mods.push('fsx');

module.exports = A;
