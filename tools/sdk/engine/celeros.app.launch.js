// app.launch.js — CelerKit LAUNCH (dep "celeros.app.launch"): o scan dos
// apps instalados (que a Loja, os Ajustes e o Installer copiavam), o estado
// x catalogo do hub e o abrir app. Regra do launcher: a 1a vista vence —
// /local/apps antes de /sd/apps. Decora o core:
//
//   var A = require("celeros.app");
//   require("celeros.app.launch");
//   require("celeros.app.semver");   // so se for comparar com o hub
//   var apps = A.launch.scan();      // cacheado por execucao
//   var rows = A.launch.rows(apps);  // linhas p/ UI.list
//   var i = UI.list("apps", A.L.x, A.L.top, A.L.w, 220, rows);
//   if (i >= 0) A.launch.open(apps[i]);
//
// Com catalogo do hub ({pkg: versao}): rows(apps, hub) marca versao nova
// em cor de aviso. A.launch.refresh() re-escaneia (apos install/remove).

var A = require('celeros.app');
require('celeros.app.semver');
require('celeros.app.path');

function scanRoot(root, out) {
    try { if (!FS.isDirectory(root)) return; } catch (e) { return; }
    var list = [];
    try { list = FS.listDir(root) || []; } catch (e2) { return; }
    for (var i = 0; i < list.length; i++) {
        var dir = list[i];
        try { if (!FS.isDirectory(dir)) continue; } catch (e3) { continue; }
        var body = null;
        try { body = FS.readTextFile(dir + '/app.json'); } catch (e4) { body = null; }
        if (!body) continue;
        var doc = null;
        try { doc = JSON.parse(body); } catch (e5) { doc = null; }
        if (!doc) continue;
        var pkg = doc.packageName || A.path.base(dir);
        if (out[pkg]) continue;              // 1a vista vence
        out[pkg] = {
            pkg: pkg,
            ver: doc.version || '',
            dir: dir,
            root: root,
            name: doc.name || pkg,
            system: doc.system === true,
            desc: doc.description || '',
            sd: root === '/sd/apps'
        };
    }
}

A.launch = {
    version: '1.0.0',
    _c: null,

    // apps instalados, ordenados por nome (cacheado; refresh() para re-ler)
    scan: function (force) {
        if (A.launch._c && !force) return A.launch._c;
        var out = {};
        scanRoot('/local/apps', out);
        scanRoot('/sd/apps', out);
        var apps = [];
        for (var k in out) if (out.hasOwnProperty(k)) apps.push(out[k]);
        for (var a = 1; a < apps.length; a++) {       // insertion por nome
            var it = apps[a];
            var kn = String(it.name);
            var b = a - 1;
            while (b >= 0 && String(apps[b].name) > kn) { apps[b + 1] = apps[b]; b--; }
            apps[b + 1] = it;
        }
        A.launch._c = apps;
        return apps;
    },

    // re-escaneia na proxima chamada (e pede ao launcher o mesmo)
    refresh: function () {
        A.launch._c = null;
        try { if (System.rescanApps) System.rescanApps(); } catch (e) { /* cedo demais */ }
    },

    // app instalado pelo pkg (ou null)
    installed: function (pkg) {
        var apps = A.launch.scan();
        for (var i = 0; i < apps.length; i++) if (apps[i].pkg === pkg) return apps[i];
        return null;
    },

    // abre pelo pacote (o launcher troca o app)
    open: function (app) {
        try { System.launchApp(app.pkg || app); } catch (e) { /* harness/nao achou */ }
    },

    // linhas p/ UI.list; hub = {pkg: versao} do catalogo marca atualizacao
    rows: function (apps, hub) {
        var T = A.T || System.theme();
        var rows = [];
        for (var i = 0; i < apps.length; i++) {
            var a = apps[i];
            var right = a.ver;
            var col = T.textDim;
            if (hub && hub[a.pkg] && A.semver.gt(hub[a.pkg], a.ver)) {
                right = a.ver + ' \u00B7';
                col = T.warn;
            }
            rows.push({ label: a.name, sub: a.pkg, right: right, rightColor: col });
        }
        return rows;
    }
};

A._mods.push('launch');

module.exports = A;
