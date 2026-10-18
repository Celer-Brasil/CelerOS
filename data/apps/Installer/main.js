// CelerOS Installer — app de sistema (W8). Porte do InstallerUI.cpp:
// escaneia /sd/apps/, mostra detalhes dos pacotes e instala na flash
// (/local/apps) ou no proprio SD (flag /local/config_install_sd.txt).
// Migrado para o CelerKit (deps celeros.app.*): tamanho de arvore no
// celeros.app.fsx (treeSize), caminhos no celeros.app.path, comparacao de
// versao no celeros.app.semver, JSON de arquivo no celeros.app.data e
// ordenacao/linhas com chave pre-computada no celeros.app.list. A copia
// transacional (staging + rename) segue aqui: o A.fsx.stage e para DOWNLOAD
// da rede e o Installer copia do cartao SD offline. A.run e dono do frame;
// X do topbar sai.

var A = require("celeros.app");
require("celeros.app.fsx");      // treeSize/ensureDir/copy (puxa path)
require("celeros.app.semver");
require("celeros.app.data");
require("celeros.app.list");
require("celeros.app.fmt");      // bytes no formato do sistema

A.init();

var SD_FLAG = "/local/config_install_sd.txt";
var SD_APPS = "/sd/apps";
var LCL_APPS = "/local/apps";
var BAD_PKG = "packageName incorreto: use minúsculas, sem espaços e com ponto (a.b.c).";

// ---- estado ----------------------------------------------------------------
var apps = [];
var sdOk = false;
var detail = null;      // app aberto na tela de detalhe
var detailNeed = 0;     // bytes do pacote (medidos 1x na abertura)
var detailInst = null;  // versao instalada no destino (ou null)
var detailLivre = 0;    // espaco livre no destino (medido 1x na abertura)
var stampLista = 0;     // carimbo das linhas: muda a cada scan/refresh

// ---- helpers ----------------------------------------------------------------
// A.fmt.bytes devolve "" em 0/negativo; aqui 0 vira "0 B" (o texto mostra o numero)
function kb(n) { return A.fmt.bytes(n) || "0 B"; }

function flagSD() { return FS.exists(SD_FLAG); }
function destBase() {
    if (flagSD() && FS.isDirectory("/sd")) return SD_APPS;
    return LCL_APPS;
}
function toggleDest() {
    if (flagSD()) FS.deleteFile(SD_FLAG);
    else FS.writeTextFile(SD_FLAG, "sd\n");
    refreshInstalled();
    UI.invalidate();
}
function validPkg(pkg) {
    if (pkg.length === 0) return false;
    if (pkg.indexOf(" ") !== -1) return false;
    if (pkg.indexOf(".") === -1) return false;
    return pkg === pkg.toLowerCase();
}
function installedMeta(app) {
    // A.data.load: null em arquivo ausente ou JSON quebrado (era try/catch a mao)
    return A.data.load(A.path.join(destBase(), app.pkg, "app.json"), null);
}
function refreshInstalled() {
    var base = destBase();
    for (var i = 0; i < apps.length; i++) {
        var app = apps[i];
        app.inst = false;
        app.instVer = "";
        if (app.pkg.length === 0) continue;
        var m = A.data.load(A.path.join(base, app.pkg, "app.json"), null);
        if (m === null) continue;
        app.inst = true;
        if (m.version) app.instVer = String(m.version);
    }
    stampLista++;   // linhas mudaram: o cache do A.list reconstrói
}
function scanApps() {
    apps = [];
    sdOk = FS.mountSD();
    if (!sdOk) return;
    var entries = FS.listDir(SD_APPS); // retorna caminhos completos
    for (var i = 0; i < entries.length; i++) {
        var nome = A.path.base(entries[i]);
        if (nome.length === 0 || nome.charAt(0) === ".") continue;
        var dir = A.path.join(SD_APPS, nome);
        if (!FS.isDirectory(dir)) continue;
        var m = A.data.load(A.path.join(dir, "app.json"), null);
        if (m === null || typeof m.name !== "string" || m.name.length === 0) continue;
        apps.push({
            folder: dir,
            name: m.name,
            pkg: (typeof m.packageName === "string") ? m.packageName : "",
            version: (typeof m.version === "string" && m.version.length > 0) ? m.version : "1.0.0",
            api: (typeof m.api === "number") ? m.api : (parseInt(m.api, 10) || 0),
            desc: (typeof m.description === "string") ? m.description : "",
            author: (typeof m.author === "string") ? m.author : "",
            // deps compartilhadas (API 30): o Installer nao tem rede — so
            // instala app com deps se o pacote trouxer o deps.json ja
            // resolvido (o celerctl gera) E o cache /local/modules tiver
            // as versoes; sem isso o require quebra no primeiro run
            deps: !!(m.deps && typeof m.deps === "object"),
            lockDeps: FS.exists(A.path.join(dir, "deps.json")),
            inst: false,
            instVer: ""
        });
    }
    // sort com chave pre-computada (o sort nativo do Duktape e preventyield)
    A.list.sort(apps, function (a) { return String(a.name).toLowerCase(); });
    stampLista++;
    System.print("Installer: " + apps.length + " app(s) em " + SD_APPS);
}

// ---- linhas da lista (cache por carimbo do celeros.app.list) -----------------
var linhas = A.list.make(function () { return stampLista; }, function () {
    var out = [];
    for (var i = 0; i < apps.length; i++) {
        var app = apps[i];
        out.push({ label: app.name, sub: "v" + app.version + " · API " + app.api,
                   right: app.inst ? "instalado" : "", rightColor: A.T.ok });
    }
    return out;
});

// ---- abertura e instalacao ----------------------------------------------------
// Confere os prerequisitos; devolve o app para o detalhe ou null (aviso ja
// mostrado no A.error).
function abrirApp(i) {
    var app = apps[i];
    var lvl = System.getAPILevel();
    if (app.api > lvl) {
        A.error("Incompatível", "O app requer API " + app.api + "; este sistema tem API " + lvl +
                ". Atualize o CelerOS.");
        return null;
    }
    if (!validPkg(app.pkg)) {
        A.error("Pacote inválido", BAD_PKG);
        return null;
    }
    var inst = installedMeta(app);
    if (inst !== null && inst.author && app.author && inst.author !== app.author) {
        A.error("Conflito", "Autor diferente do instalado (" + String(inst.author) + " / " +
                app.author + ").");
        return null;
    }
    if (app.deps && !app.lockDeps) {
        A.error("Tem dependências", "Este app usa dependências compartilhadas que só a rede baixa. " +
                "Instale pela App Store ou com celerctl apps install.");
        return null;
    }
    // medidas 1x por abertura: o detalhe nao rele o SD por frame (o app.json
    // do destino e o espaco livre eram relidos a cada frame — rebuild que
    // roca o exec-timeout)
    detailNeed = A.fsx.treeSize(app.folder);
    detailInst = (inst !== null && inst.version) ? String(inst.version) : null;
    var livre = 0;
    try { livre = FS.getFreeSpace(destBase()); } catch (e0) { livre = 0; }
    detailLivre = livre;
    return app;
}

// deps.json resolvido embarcado no pacote: confere se o cache /local/modules
// tem cada <nome>/<versao> (onde o require cai). Devolve a lista de faltantes
// (vazia = ok) ou null se o deps.json nao puder ser lido.
function modulosFaltando(destPkg) {
    var lock = A.data.load(A.path.join(destPkg, "deps.json"), null);
    if (lock === null) return null;
    var falta = [];
    for (var nm in lock) if (lock.hasOwnProperty(nm)) {
        if (!FS.exists(A.path.join("/local/modules", nm, String(lock[nm]), nm + ".js"))) {
            falta.push(nm + " " + lock[nm]);
        }
    }
    return falta;
}

// Instala (copia bloqueante). Devolve true quando o detalhe deve fechar
// (sucesso); falhas mostram o A.error e mantem o detalhe aberto.
function tryInstall(app) {
    if (!validPkg(app.pkg)) {
        A.error("Pacote inválido", BAD_PKG);
        return false;
    }
    var base = destBase();
    var dest = A.path.join(base, app.pkg);
    // Espaco ANTES de tocar no disco: a copia nova fica AO LADO da antiga,
    // entao o pico e o tamanho do pacote (update reusa esse espaco livre).
    // Medido no drive do destino com FS.getFreeSpace (o binding exige o drive).
    var need = A.fsx.treeSize(app.folder);
    var livre = detailLivre;
    if (livre > 0 && need > 0 && livre < need) {
        A.error("Sem espaço", "O pacote precisa de " + kb(need) + " e o destino tem " + kb(livre) +
                " livres. A versão instalada foi mantida.");
        return false;
    }
    A.busy("Instalando " + app.name + "...");   // UM frame antes da copia bloqueante
    A.fsx.ensureDir(base);
    // Transacional: copia para um staging FORA de apps/ (o launcher varre
    // /local/apps e /sd/apps: um <pkg>.inst pela metade com app.json
    // aparecia como app duplicado depois de uma queda de energia) e so
    // entao troca pela versao antiga. Mesma particao do destino: rename
    // entre /local e /sd nao funciona.
    var tmp = A.path.join(A.path.dir(base), ".inst-" + app.pkg);
    var legado = dest + ".inst";
    if (FS.isDirectory(legado)) FS.removeDirectory(legado);  // staging da versao antiga
    if (FS.isDirectory(tmp)) FS.removeDirectory(tmp);        // sobra de falha anterior
    var ok = A.fsx.copy(app.folder, tmp);
    if (ok && FS.isDirectory(dest)) ok = FS.removeDirectory(dest);
    if (ok && !FS.renameFile(tmp, dest)) {
        // rename falhou DEPOIS de remover a antiga: o .inst e a UNICA copia
        // — nao apaga. O dono ve o aviso e reinicia (o launcher reescaneia).
        A.error("Falhou", "A troca da pasta falhou depois da cópia. A versão nova ficou em " + tmp +
                "; reinicie e tente de novo.");
        return false;
    }
    if (!ok && FS.isDirectory(tmp)) FS.removeDirectory(tmp);  // copia incompleta: descarta
    if (ok) {
        System.rescanApps();
        if (typeof System.playTone === "function") {
            try { System.playTone([[784, 80], [1047, 110]]); } catch (e1) {}
        }
        var falta = app.deps ? modulosFaltando(dest) : null;
        if (falta !== null && falta.length > 0) {
            A.error("Instalado sem módulos", "Faltam no cache: " + falta.join(", ") +
                    ". Abra pela App Store para baixar as dependências.");
            refreshInstalled();
            UI.invalidate();
            return false;   // instalado, mas o dono precisa ver o aviso
        }
        A.ok("Instalado!", app.name + " v" + app.version + " em " + dest + ".");
        refreshInstalled();
        UI.invalidate();
        return true;
    }
    var livreAgora = 0;
    try { livreAgora = Math.round(FS.getFreeSpace(base) / 1024); } catch (e4) { livreAgora = 0; }
    A.error("Falhou", "Não foi possível copiar o app. Espaço livre: " + livreAgora + " KB.");
    return false;
}

function rescan() {
    A.busy("Buscando apps...");
    scanApps();
    refreshInstalled();
    UI.resetScroll("apps");
    detail = null;
    UI.invalidate();
}

// ---- telas --------------------------------------------------------------------
rescan();   // scan na abertura (busy + lista pronta antes do 1o frame)
A.run({
    lista: function (c) {
        if (A.header("Installer", { sub: apps.length ? apps.length + " no SD" : "" })) return A.BACK;
        // destino (toque alterna flash/SD)
        UI.card(A.L.x, A.L.top, A.L.w, 44);
        UI.text("Instalar no cartão SD", A.L.x + 12, A.L.top + 14, { w: 150 });
        var sd = destBase() === SD_APPS;
        if (UI.toggle(A.L.x + A.L.w - 56, A.L.top + 10, sd) !== sd) toggleDest();
        UI.cardEnd();

        if (apps.length === 0) {
            var T = A.T;
            UI.card(A.L.x, A.L.top + 56, A.L.w, 140);
            UI.text("SD sem apps", 120, A.L.top + 76, { role: "title", align: "center", color: T.warn });
            UI.text(sdOk ? "Nenhum app em /sd/apps." : "Cartão SD não encontrado.", 120, A.L.top + 108,
                    { align: "center", w: A.L.w - 16 });
            UI.text("Copie apps para o cartão ou use o celerctl / App Store.", 120, A.L.top + 136,
                    { role: "caption", align: "center", color: T.textDim, w: A.L.w - 24, lines: 2 });
            UI.cardEnd();
            if (UI.button("Procurar de novo", A.L.x, 268, A.L.w, 40)) rescan();
            return;
        }
        var i = UI.list("apps", A.L.x, A.L.top + 52, A.L.w, A.L.bottom - A.L.top - 52,
                        linhas.rows(), { rowH: 48 });
        if (i >= 0) {
            var app = abrirApp(i);
            if (app !== null) { detail = app; return "detalhe"; }
        }
    },
    detalhe: function (c) {
        var app = detail;
        if (A.header(app.name)) { detail = null; return A.BACK; }
        var T = A.T;
        UI.card(A.L.x, A.L.top, A.L.w, 150);
        UI.text("v" + app.version + "  ·  API " + app.api, A.L.x + 12, A.L.top + 10,
                { role: "caption", color: T.textDim });
        var y = A.L.top + 30;
        if (app.author.length > 0) {
            UI.text("Autor: " + app.author, A.L.x + 12, y, { role: "caption", color: T.textDim, w: A.L.w - 24 });
            y += 20;
        }
        UI.text(app.desc || "Sem descrição.", A.L.x + 12, y, { role: "caption", w: A.L.w - 24, lines: 5 });
        UI.cardEnd();

        var stTxt, stCol;
        if (detailInst === null) { stTxt = "Não instalado"; stCol = T.textDim; }
        else if (A.semver.gt(String(app.version), detailInst)) { stTxt = "Nova versão: v" + app.version; stCol = T.warn; }
        else { stTxt = "Instalado v" + detailInst; stCol = T.ok; }
        UI.badge(stTxt, A.L.x, A.L.top + 160, { color: T.raised, textColor: stCol });

        UI.text("Destino: " + A.path.join(destBase(), app.pkg), A.L.x + 2, A.L.top + 188,
                { role: "caption", color: T.textDim, w: A.L.w - 4 });
        UI.text("Pacote: " + kb(detailNeed) + "  ·  Livre: " + kb(detailLivre), A.L.x + 2, A.L.top + 206,
                { role: "caption", color: T.textDim });

        var lbl = "Instalar";
        if (detailInst !== null) lbl = A.semver.gt(String(app.version), detailInst) ? "Atualizar" : "Reinstalar";
        if (UI.button(lbl, A.L.x, 268, A.L.w, 40) && tryInstall(app)) {
            detail = null;
            return A.BACK;   // sucesso: volta para a lista (ja marca "instalado")
        }
    }
}, "lista", { fps: 15 });
