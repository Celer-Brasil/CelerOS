// app.fsx.js — CelerKit FSX (dep "celeros.app.fsx"): gravacao segura de
// arquivos/pacotes — o staged install da loja (.new + MD5 + rename em lote:
// nada de meia versao no disco) e utilidades de arvore. Decora o core:
//
//   var A = require("celeros.app");
//   require("celeros.app.fsx");
//   A.fsx.ensureDir("/local/x/y");         // mkdir -p
//   A.fsx.free();                          // bytes livres
//
//   // pacote por arquivos (app.json entra no MESMO lote, por ultimo):
//   A.fsx.stage("/local/apps/Meu App",
//               [{ name: "main.js", url: u1, md5: m1 }, ...],
//               jsonAppJson,
//               function (nome, got, total) { A.progress(...); });
//
//   // pacote unico (API 42, quando o hub publica it.zip):
//   A.fsx.zipBlob(zipUrl, "Meu App", zipMd5, onProg);   // false=erro, null=sem suporte

var A = require('celeros.app');
require('celeros.app.path');

A.fsx = {
    version: '1.0.0',

    free: function () {
        try { return FS.getFreeSpace() || 0; } catch (e) { return 0; }
    },
    hasRoom: function (bytes) { return A.fsx.free() > bytes; },

    // mkdir -p: cria a arvore inteira; false no primeiro erro
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

    // bytes de uma arvore (pastas recursivas; arquivos no topo)
    treeSize: function (dir) {
        var total = 0;
        var list = [];
        try { list = FS.listDir(dir) || []; } catch (e) { return 0; }
        for (var i = 0; i < list.length; i++) {
            try {
                if (FS.isDirectory(list[i])) total += A.fsx.treeSize(list[i]);
                else total += FS.getFileSize(list[i]) || 0;
            } catch (e2) { /* pula o arquivo problematico */ }
        }
        return total;
    },

    copy: function (src, dst) {
        try { return !!FS.copyDirectory(src, dst); } catch (e) { return false; }
    },

    // md5 de arquivo ("" se nao deu)
    md5: function (file) {
        try { return FS.getFileMD5(file) || ''; } catch (e) { return ''; }
    },

    /**
     * Instala um pacote por arquivos em dir, com integridade e lote atomico:
     * cada arquivo baixa para "<nome>.new", confere MD5 e so entao TODOS
     * viram de vez (rename em lote). app.json (json) entra no FIM do lote —
     * a versao nova so aparece no disco junto com os arquivos. Qualquer
     * falha apaga os .new e a versao antiga segue ativa. Devolve true/false.
     * files = [{ name, url, md5? }]; onStep(nome, got, total) por progresso.
     */
    stage: function (dir, files, json, onStep) {
        if (!A.fsx.ensureDir(dir)) return false;
        var staged = [];
        var fail = '';
        for (var i = 0; i < files.length && !fail; i++) {
            var fe = files[i];
            var ftmp = dir + '/' + fe.name + '.new';
            var ok = false;
            try {
                ok = !!Net.download(fe.url, ftmp, function (got, total) {
                    if (onStep) onStep(fe.name, got, total);
                });
            } catch (e) { ok = false; }
            if (!ok) { fail = 'Erro ao baixar ' + fe.name; break; }
            if (fe.md5 && A.fsx.md5(ftmp) !== fe.md5) {
                try { FS.deleteFile(ftmp); } catch (e2) { /* nada a apagar */ }
                fail = 'Verificacao falhou (md5)';
                break;
            }
            staged.push({ tmp: ftmp, dst: dir + '/' + fe.name });
        }
        // app.json por ULTIMO no lote (a versao nova aparece inteira)
        if (!fail && json) {
            var jtmp = dir + '/app.json.new';
            if (!FS.writeTextFile(jtmp, json)) fail = 'Erro ao gravar app.json';
            else staged.push({ tmp: jtmp, dst: dir + '/app.json' });
        }
        if (fail) {
            for (var s = 0; s < staged.length; s++) {
                try { FS.deleteFile(staged[s].tmp); } catch (e3) { /* ja foi */ }
            }
            return false;
        }
        for (var r = 0; r < staged.length; r++) {
            if (!FS.renameFile(staged[r].tmp, staged[r].dst)) return false;
        }
        return true;
    },

    /**
     * Pacote unico (API 42): baixa 1 zip + md5 e deixa o firmware trocar a
     * pasta inteira do app (atomico: falha mantem a versao antiga). So
     * /local. Devolve null quando o firmware/hub nao suportam (use stage),
     * false em erro, true se instalou.
     */
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
            try { FS.deleteFile(zpath); } catch (e2) { /* nada a apagar */ }
            return false;
        }
        var res = null;
        try { res = System.installZip(zpath, A.path.safeName(appName)); } catch (e3) { res = null; }
        try { FS.deleteFile(zpath); } catch (e4) { /* ja foi */ }
        return !!(res && res.ok);
    }
};

A._mods.push('fsx');

module.exports = A;
