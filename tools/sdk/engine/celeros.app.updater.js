// app.updater.js — CelerKit UPDATER (dep "celeros.app.updater"): checagem de
// atualizacao contra o catalogo do hub, promocao de deps compartilhadas
// (versao nova dentro do range cai no cache sem reinstalar o app) e o fluxo
// de instalacao com os overlays do core. Decora o core:
//
//   var A = require("celeros.app");
//   require("celeros.app.updater");
//   var upd = A.updater.check(pkg, verLocal, catalogo);   // null = em dia
//   if (upd && A.confirm? -> A.updater.flow({ name: nomePasta, pkg: pkg }, upd, {
//        deps: appJsonLocal.deps,          // se o app tem deps
//        hubIndex: indiceStoreDeps         // GET /store/deps.json .deps
//   })) A.ok("Atualizado", "agora em " + upd.version);
//
// catalogo = MAPA {pkg: entrada} que o app monta do all.json/categorias do
// hub; entrada = { version, changelog?, zip?: {url, size, md5}, files?: [...],
//                  json?: app.json } (mesmo contrato da loja).

var A = require('celeros.app');
require('celeros.app.semver');
require('celeros.app.net');
require('celeros.app.fsx');
require('celeros.app.path');

function writeDepsJson(dir, fecho) {
    try { return !!FS.writeTextFile(dir + '/deps.json', JSON.stringify(fecho)); }
    catch (e) { return false; }
}

A.updater = {
    version: '1.0.0',

    // entrada do catalogo se pkg esta desatualizado; null = em dia/ausente
    check: function (pkg, localVer, catalog) {
        if (!catalog || !catalog[pkg]) return null;
        var it = catalog[pkg];
        if (!it || !it.version) return null;
        if (!A.semver.gt(String(it.version), String(localVer || ''))) return null;
        return it;
    },

    /**
     * Resolve as deps diretas no indice do hub e BAIXA para o cache
     * /local/modules as versoes que faltam (MD5 conferido, .new + rename).
     * Devolve o fecho {"dep": "ver"} — o app grava no deps.json dele —
     * ou null se insatisfazivel/erro de rede.
     */
    promoteDeps: function (directDeps, hubIndex, onProg) {
        var fecho = A.semver.resolve(directDeps, hubIndex);
        if (!fecho) return null;
        for (var nome in fecho) if (fecho.hasOwnProperty(nome)) {
            var ver = fecho[nome];
            var alvo = '/local/modules/' + nome + '/' + ver + '/' + nome + '.js';
            var tem = false;
            try { tem = FS.exists(alvo); } catch (e) { tem = false; }
            if (tem) continue;                      // ja esta no cache
            var verInfo = hubIndex[nome] ? hubIndex[nome][ver] : null;
            if (!verInfo || !verInfo.url) return null;
            if (!A.fsx.ensureDir('/local/modules/' + nome + '/' + ver)) return null;
            if (!A.net.fetch(verInfo.url, alvo + '.new', verInfo.md5, onProg)) return null;
            if (!FS.renameFile(alvo + '.new', alvo)) return null;
        }
        return fecho;
    },

    /**
     * Fluxo completo (BLOQUEANTE, com overlays): deps -> pacote unico
     * (quando ha zip e o firmware tem installZip) -> fallback por arquivos.
     * app = { pkg, name (nome da pasta) }; upd = saida do check.
     * o = { deps?: {dep:range}, hubIndex?: indice, depsResolved?: fecho
     *       (passe se ja promoveu antes) }.
     * Devolve true/false; o erro ja foi mostrado (A.error).
     */
    flow: function (app, upd, o) {
        o = o || {};
        if (!upd) return false;
        var dir = '/local/apps/' + A.path.safeName(app.name);
        var fecho = o.depsResolved || null;

        if (!fecho && o.deps && o.hubIndex) {
            A.busy('Dependencias...');
            fecho = A.updater.promoteDeps(o.deps, o.hubIndex, function (g, t) {
                A.progress(t ? (g * 100 / t) : -1, 'dependencias');
            });
            if (!fecho) {
                A.error('Falha nas dependencias', 'verifique a conexao e tente de novo');
                return false;
            }
        }

        // pacote unico: 1 download atomico (so /local)
        var zip = (upd.zip && upd.zip.url && upd.zip.md5) ? upd.zip : null;
        if (zip && dir.indexOf('/local/apps/') === 0) {
            A.progress(0, 'pacote');
            var okz = A.fsx.zipBlob(zip.url, app.name, zip.md5, function (g, t) {
                A.progress(t ? (g * 100 / t) : -1, 'pacote');
            });
            if (okz) {
                if (fecho && !writeDepsJson(dir, fecho)) {
                    A.error('Instalado com aviso', 'deps.json nao gravou');
                    return true;
                }
                try { System.rescanApps(); } catch (e) { /* cedo demais */ }
                return true;
            }
            // erro de rede/zip recusado: cai no fallback por arquivos
        }

        if (!upd.files || !upd.files.length) {
            A.error('Pacote indisponivel', 'o hub nao publica files nem zip para ' + app.name);
            return false;
        }
        A.progress(0, app.name);
        var ok = A.fsx.stage(dir, upd.files, upd.json || null, function (nome, g, t) {
            A.progress(t ? (g * 100 / t) : -1, nome);
        });
        if (!ok) {
            A.error('Falha ao instalar', app.name + ' — a versao antiga segue ativa');
            return false;
        }
        if (fecho && !writeDepsJson(dir, fecho)) {
            A.error('Instalado com aviso', 'deps.json nao gravou');
            return true;
        }
        try { System.rescanApps(); } catch (e2) { /* cedo demais */ }
        return true;
    }
};

A._mods.push('updater');

module.exports = A;
