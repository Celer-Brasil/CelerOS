// CelerOS Installer 2.0 — app de sistema: instala pacotes do cartao SD na
// flash (/local/apps) ou no proprio cartao (/sd/apps), com destino
// alternavel, espaco livre, consentimento e instalacao transacional. UI kit
// 2.0 (celeros.app.style/icons/list): header com icone de reescanear, card
// de destino com toggle, lista rica (versao/API/tamanho/estado) e detalhe em
// cards. A copia e staged FORA de apps/ (o launcher nao ve meia versao):
// cada arquivo vira <nome>.new, o MD5 da copia confere com a origem e o lote
// troca por rename (app.json por ultimo). A versao antiga e guardada e
// devolvida se a troca falhar. A.fsx mede a arvore/o espaco/o MD5; A.list
// cacheia as linhas por carimbo.

var A = require("celeros.app");
require("celeros.app.fsx");        // treeSize/free/md5/ensureDir (puxa path)
require("celeros.app.list");
require("celeros.app.style");
require("celeros.app.icons");

A.init();
var T = A.T;
var L = A.L;

var SD_FLAG = "/local/config_install_sd.txt";
var SD_APPS = "/sd/apps";
var LCL_APPS = "/local/apps";
var BAD_PKG = "packageName incorreto: use minúsculas, sem espaços e com ponto (a.b.c).";

// ---- estado ----------------------------------------------------------------
var apps = [];
var sdOk = false;
var detail = null;      // pacote aberto na tela de detalhe
var dInst = null;       // versao instalada no destino (ou null)
var dLivre = 0;         // espaco livre no destino (medido na abertura)
var dDeps = null;       // modulos compartilhados faltando (ou null)
var stampLista = 0;     // carimbo das linhas: muda a cada scan/refresh
var espacos = { loc: 0, sd: 0 };   // medidos no scan/troca (nunca por frame)

// ---- helpers ----------------------------------------------------------------
// mesmo formato do A.fmt.bytes ("512 B", "1.5 KB", "2.3 MB")
function kb(n) {
    if (!(n > 0)) return "0 B";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
}

function flagSD() { return FS.exists(SD_FLAG); }
function destBase() {
    if (flagSD() && FS.isDirectory("/sd")) return SD_APPS;
    return LCL_APPS;
}
function readJson(p) {
    try {
        var s = FS.readTextFile(p);
        return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
}
function validPkg(pkg) {
    if (pkg.length === 0) return false;
    if (pkg.indexOf(" ") !== -1) return false;
    if (pkg.indexOf(".") === -1) return false;
    return pkg === pkg.toLowerCase();
}
// comparacao numerica parte a parte ("1.10.0" > "1.9.0"); sem o semver do
// kit para o app caber no orcamento de 30 KB
function vcmp(a, b) {
    var x = String(a).split("."), y = String(b).split(".");
    for (var i = 0; i < 3; i++) {
        var p = parseInt(x[i], 10) || 0, q = parseInt(y[i], 10) || 0;
        if (p !== q) return p < q ? -1 : 1;
    }
    return 0;
}
function installedMeta(app) {
    return readJson(A.path.join(destBase(), app.pkg, "app.json"));
}
function refreshInstalled() {
    var base = destBase();
    for (var i = 0; i < apps.length; i++) {
        var app = apps[i];
        app.inst = false;
        app.instVer = "";
        if (app.pkg.length === 0) continue;
        var m = readJson(A.path.join(base, app.pkg, "app.json"));
        if (m === null) continue;
        app.inst = true;
        if (m.version) app.instVer = String(m.version);
    }
    stampLista++;
}
function freeOf(drive) {
    try { return FS.getFreeSpace(drive) || 0; } catch (e) { return 0; }
}
function lerEspacos() {
    espacos = { loc: freeOf("/local"), sd: sdOk ? freeOf("/sd") : 0 };
}
function toggleDest() {
    try {
        if (flagSD()) FS.deleteFile(SD_FLAG);
        else FS.writeTextFile(SD_FLAG, "sd\n");
    } catch (e) { A.error("Destino", "Não foi possível trocar o destino."); return; }
    refreshInstalled();
    lerEspacos();
    UI.invalidate();
}
// deps.json resolvido embarcado no pacote: confere o cache /local/modules
// (onde o require cai). O Installer nao tem rede: sem deps.json o app e
// barrado; com ele, o detalhe avisa o que falta antes e depois de instalar.
function depsMissing(app) {
    if (!app.deps) return null;
    if (!app.lock) return ["sem deps.json no pacote"];
    var lock = readJson(A.path.join(app.folder, "deps.json"));
    if (lock === null) return ["deps.json inválido"];
    var falta = [], n, v;
    for (n in lock) if (lock.hasOwnProperty(n)) {
        v = String(lock[n]);
        if (!FS.exists(A.path.join("/local/modules", n, v, n + ".js"))) falta.push(n + " " + v);
    }
    return falta.length ? falta : null;
}

// ---- scan ------------------------------------------------------------------
function scanApps() {
    apps = [];
    sdOk = false;
    try { sdOk = !!FS.mountSD() && FS.isDirectory("/sd"); } catch (e0) { sdOk = false; }
    if (sdOk) {
        var entries = [];
        try { entries = FS.listDir(SD_APPS) || []; } catch (e1) { entries = []; }
        for (var i = 0; i < entries.length; i++) {
            var nome = A.path.base(entries[i]);
            if (nome.length === 0 || nome.charAt(0) === ".") continue;
            var dir = A.path.join(SD_APPS, nome);
            if (!FS.isDirectory(dir)) continue;
            var m = readJson(A.path.join(dir, "app.json"));
            if (m === null || typeof m.name !== "string" || m.name.length === 0) continue;
            apps.push({
                folder: dir,
                name: m.name,
                pkg: (typeof m.packageName === "string") ? m.packageName : "",
                version: (typeof m.version === "string" && m.version.length > 0) ? m.version : "1.0.0",
                api: (typeof m.api === "number") ? m.api : (parseInt(m.api, 10) || 0),
                desc: (typeof m.description === "string") ? m.description : "",
                author: (typeof m.author === "string") ? m.author : "",
                deps: !!(m.deps && typeof m.deps === "object"),
                lock: FS.exists(A.path.join(dir, "deps.json")),
                size: A.fsx.treeSize(dir),
                inst: false,
                instVer: ""
            });
        }
    }
    A.list.sort(apps, function (a) { return String(a.name).toLowerCase(); });
    stampLista++;
    System.print("Installer: " + apps.length + " app(s) em " + SD_APPS);
}

// ---- linhas ricas (cache por carimbo do celeros.app.list) -------------------
var linhas = A.list.make(function () { return stampLista; }, function () {
    var out = [];
    for (var i = 0; i < apps.length; i++) {
        var app = apps[i];
        var right = "", col = T.textDim;
        if (app.inst) {
            if (vcmp(app.instVer, app.version) < 0) { right = "atualizar"; col = T.warn; }
            else { right = "v" + app.instVer; col = T.ok; }
        }
        out.push({
            label: app.name,
            sub: "v" + app.version + "  ·  " + kb(app.size),
            icon: "star",
            right: right,
            rightColor: col
        });
    }
    return out;
});

// ---- abertura e instalacao --------------------------------------------------
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
    if (app.deps && !app.lock) {
        A.error("Tem dependências", "Este app usa dependências compartilhadas que só a rede baixa. " +
                "Instale pela App Store ou com celerctl apps install.");
        return null;
    }
    dInst = (inst !== null && inst.version) ? String(inst.version) : null;
    dDeps = depsMissing(app);
    if (!app.size) app.size = A.fsx.treeSize(app.folder);
    dLivre = freeOf(destBase() === SD_APPS ? "/sd" : "/local");
    return app;
}

// Copia recursiva arquivo a arquivo: cada um vira <nome>.new no staging, o
// MD5 da copia confere com a origem e o progresso acompanha os bytes.
function stageTree(srcDir, dstDir, total, st) {
    var ents = [];
    try { ents = FS.listDir(srcDir) || []; } catch (e0) { return false; }
    for (var i = 0; i < ents.length; i++) {
        var sp = ents[i];
        var nm = A.path.base(sp);
        if (nm.length === 0 || nm.charAt(0) === ".") continue;   // .dev etc
        var dp = A.path.join(dstDir, nm);
        if (FS.isDirectory(sp)) {
            if (!FS.isDirectory(dp) && !FS.mkdir(dp)) return false;
            if (!stageTree(sp, dp, total, st)) return false;
        } else {
            var tmp = dp + ".new";
            if (!FS.copyFile(sp, tmp)) return false;
            var a = A.fsx.md5(sp), b = A.fsx.md5(tmp);
            if (a && b && a !== b) return false;
            st.files.push({ tmp: tmp, dst: dp });
            var sz = 0;
            try { sz = FS.getFileSize(sp) || 0; } catch (e1) {}
            st.done += sz;
            if (st.onStep) st.onStep(st.done, total);
        }
    }
    return true;
}

// Troca o staging pela pasta final. A versao antiga vai para .old antes do
// rename: se a troca falhar, ela volta. true/false (aviso ja no A.error).
function swapIn(stage, dest, old) {
    if (FS.isDirectory(dest) && !FS.renameFile(dest, old)) {
        A.error("Falhou", "Não foi possível guardar a versão antiga. Nada foi alterado.");
        return false;
    }
    if (!FS.renameFile(stage, dest)) {
        if (FS.isDirectory(old)) FS.renameFile(old, dest);   // devolve a antiga
        A.error("Falhou", "A troca da pasta falhou. A versão antiga foi mantida.");
        return false;
    }
    if (FS.isDirectory(old)) {
        try { FS.removeDirectory(old); } catch (e0) {}
    }
    return true;
}

// Instala (copia bloqueante com UM frame de progresso por arquivo). Devolve
// true quando o detalhe deve fechar (sucesso).
function tryInstall(app) {
    if (!validPkg(app.pkg)) {
        A.error("Pacote inválido", BAD_PKG);
        return false;
    }
    var base = destBase();
    var dest = A.path.join(base, app.pkg);
    var need = app.size || A.fsx.treeSize(app.folder);
    // Atualizacao sobre uma versao instalada: consentimento explicito.
    if (dInst !== null) {
        if (!UI.confirm("Substituir " + app.name + "?",
                        "Instalada: v" + dInst + ". Pacote: v" + app.version +
                        ". Destino: " + dest + ".",
                        { yes: "Instalar", no: "Cancelar" })) return false;
        UI.invalidate();
    }
    // Espaco ANTES de tocar no disco: a copia nova fica ao lado da antiga.
    var livre = freeOf(base === SD_APPS ? "/sd" : "/local");
    dLivre = livre;
    if (livre > 0 && need > 0 && livre < need) {
        A.error("Sem espaço", "O pacote precisa de " + kb(need) + " e o destino tem " + kb(livre) +
                " livres. A versão instalada foi mantida.");
        return false;
    }
    A.progress(-1, "Instalando " + app.name + "...");
    A.fsx.ensureDir(base);
    // staging FORA de apps/: o launcher varre /local/apps e /sd/apps e um
    // staging pela metade com app.json aparecia como app duplicado.
    var root = A.path.dir(base);
    var stage = A.path.join(root, ".inst-" + app.pkg);
    var old = A.path.join(root, ".old-" + app.pkg);
    if (FS.isDirectory(stage)) { try { FS.removeDirectory(stage); } catch (e0) {} }
    if (FS.isDirectory(old)) { try { FS.removeDirectory(old); } catch (e1) {} }
    if (!A.fsx.ensureDir(stage)) {
        A.error("Falhou", "Não foi possível criar a pasta temporária em " + root + ".");
        return false;
    }
    var st = {
        files: [], done: 0,
        onStep: function (done, total) {
            A.progress(total > 0 ? Math.floor(done * 100 / total) : -1,
                       "Instalando " + app.name + "...");
        }
    };
    var ok = stageTree(app.folder, stage, need, st);
    // lote final: .new -> nome de verdade (app.json por ULTIMO, entao a
    // versao nova so aparece inteira)
    if (ok) {
        var i, e;
        for (i = 0; i < st.files.length && ok; i++) {
            e = st.files[i];
            if (A.path.base(e.dst) === "app.json") continue;
            if (!FS.renameFile(e.tmp, e.dst)) ok = false;
        }
        for (i = 0; i < st.files.length && ok; i++) {
            e = st.files[i];
            if (A.path.base(e.dst) !== "app.json") continue;
            if (!FS.renameFile(e.tmp, e.dst)) ok = false;
        }
    }
    if (!ok) {
        try { FS.removeDirectory(stage); } catch (e2) {}
        A.error("Falhou", "A cópia não passou na verificação (MD5/espaço). A versão antiga foi mantida.");
        return false;
    }
    if (!swapIn(stage, dest, old)) return false;
    System.rescanApps();
    if (typeof System.playTone === "function") {
        try { System.playTone([[784, 80], [1047, 110]]); } catch (e3) {}
    }
    var falta = depsMissing(app);
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

function rescan() {
    A.busy("Buscando apps...");
    scanApps();
    refreshInstalled();
    lerEspacos();
    UI.resetScroll("apps");
    detail = null;
    UI.invalidate();
}

// ---- tela de detalhe --------------------------------------------------------
function desenhaDetalhe(c, app) {
    if (A.header(app.name)) { detail = null; return A.BACK; }
    var y = L.top;
    A.style.card(L.x, y, L.w, 112, {
        full: c.full, elev: 2, grad: true,
        draw: function (r) {
            A.icons.draw("star", r.x, r.y + 1, 20, { color: T.accent });
            UI.text("v" + app.version, r.x + 28, r.y,
                    { role: "title", color: T.text, bg: r.bg, lines: 1 });
            UI.text("API " + app.api + (app.author.length ? "  ·  " + app.author : ""),
                    r.x, r.y + 26, { role: "caption", color: T.textDim, bg: r.bg, w: r.w, lines: 1 });
            UI.text(app.desc || "Sem descrição.", r.x, r.y + 48,
                    { role: "caption", color: T.text, bg: r.bg, w: r.w, lines: 3 });
        }
    });

    var stTxt, stCol;
    if (dInst === null) { stTxt = "Não instalado"; stCol = T.textDim; }
    else if (vcmp(app.version, dInst) > 0) { stTxt = "Atualização: v" + dInst + " para v" + app.version; stCol = T.warn; }
    else { stTxt = "Instalado v" + dInst; stCol = T.ok; }
    A.style.card(L.x, y + 120, L.w, 96, {
        full: c.full, elev: 1, grad: true,
        draw: function (r) {
            UI.badge(stTxt, r.x, r.y, { color: T.raised, textColor: stCol });
            UI.text("Destino: " + A.path.join(destBase(), app.pkg), r.x, r.y + 26,
                    { role: "caption", color: T.textDim, bg: r.bg, w: r.w, lines: 1 });
            UI.text("Pacote: " + kb(app.size) + "  ·  Livre: " + kb(dLivre), r.x, r.y + 44,
                    { role: "caption", color: T.textDim, bg: r.bg, w: r.w, lines: 1 });
            if (app.deps) {
                UI.text(dDeps && dDeps.length ? "Faltam módulos: " + dDeps.length
                                              : "Dependências no cache",
                        r.x, r.y + 62,
                        { role: "caption", color: (dDeps && dDeps.length) ? T.err : T.ok,
                          bg: r.bg, w: r.w, lines: 1 });
            }
        }
    });

    var lbl = "Instalar";
    if (dInst !== null) lbl = vcmp(app.version, dInst) > 0 ? "Atualizar" : "Reinstalar";
    if (A.style.button(lbl, L.x, 268, L.w, 40) && tryInstall(app)) {
        detail = null;
        return A.BACK;
    }
}

// ---- telas ------------------------------------------------------------------
rescan();   // scan na abertura (busy + lista pronta antes do 1o frame)
A.run({
    lista: function (c) {
        // header nativo + icone de reescanear a mao (sem o widgets, que nao
        // cabe no orcamento deste app)
        A.header("Installer", { back: false });
        UI.card(204, 6, 28, 28, { color: T.raised, radius: 14, stroke: false });
        A.icons.draw("search", 210, 12, 16, { color: T.text });
        var tt = UI.touch();
        if (tt.tap && tt.x >= 204 && tt.x <= 232 && tt.y >= 6 && tt.y <= 34) { rescan(); return; }

        // destino (toque no toggle alterna flash/SD)
        A.style.card(L.x, L.top, L.w, 44, {
            full: c.full, elev: 1, grad: true,
            draw: function (r) {
                var sd = destBase() === SD_APPS;
                UI.text("Instalar no SD", r.x, r.y + 1,
                        { color: T.text, bg: r.bg, w: r.w - 56, lines: 1 });
                UI.text(apps.length + " app(s)  ·  " + (sd ? "/sd/apps" : "/local/apps"),
                        r.x, r.y + 21,
                        { role: "caption", color: T.textDim, bg: r.bg, w: r.w - 56, lines: 1 });
                if (UI.toggle(r.x + r.w - 46, r.y + 10, sd) !== sd) toggleDest();
            }
        });

        if (apps.length === 0) {
            A.style.card(L.x, L.top + 56, L.w, 136, {
                full: c.full, elev: 1, grad: true,
                draw: function (r) {
                    A.icons.draw("info", L.cx - 11, r.y + 4, 22, { color: T.warn });
                    UI.text("SD sem apps", L.cx, r.y + 36,
                            { role: "title", align: "center", color: T.warn, bg: r.bg, w: r.w, lines: 1 });
                    UI.text(sdOk ? "Nenhum pacote em /sd/apps."
                                 : "Cartão SD não encontrado ou sem a pasta apps.",
                            L.cx, r.y + 68,
                            { role: "caption", align: "center", color: T.textDim, bg: r.bg, w: r.w, lines: 2 });
                    UI.text("Copie apps para o cartão ou use o celerctl / App Store.",
                            L.cx, r.y + 96,
                            { role: "caption", align: "center", color: T.textDim, bg: r.bg, w: r.w, lines: 2 });
                }
            });
            if (A.style.button("Procurar de novo", L.x, 268, L.w, 40)) rescan();
            return;
        }

        var rows = linhas.rows();
        var lh = Math.min(180, rows.length * 44 + 4);
        var i = A.list.view("apps", L.x, L.top + 52, L.w, lh, rows, { row: 44 });
        if (i >= 0) {
            var app = abrirApp(i);
            if (app !== null) { detail = app; return "detalhe"; }
        }
        // espaco livre medido no scan/troca: nunca bloqueia o desenho do frame
        UI.text("Livre: " + kb(espacos.loc) + (sdOk ? "  ·  SD: " + kb(espacos.sd) : ""),
                L.cx, L.top + 60 + lh, { role: "caption", align: "center", color: T.textDim, w: L.w, lines: 1 });
        if (L.top + 80 + lh < 300) {
            UI.text("Toque num pacote para instalar.", L.cx, L.top + 80 + lh,
                    { role: "caption", align: "center", color: T.textDim, w: L.w, lines: 1 });
        }
    },
    detalhe: function (c) {
        if (!detail) return A.BACK;
        return desenhaDetalhe(c, detail);
    }
}, "lista", { fps: 15 });
