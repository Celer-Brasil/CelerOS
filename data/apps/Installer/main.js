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

require("celeros.app.layout");
A.init();
var T = A.T;
var L = A.layout.bounds({ top: 40 });
var bottom = L.y + L.h, cx = L.x + L.w / 2;

var capH = UI.lineHeight("caption"), bodyH = UI.lineHeight("body");
var footerY = bottom - 40, summaryH = Math.max(44, bodyH + capH + 18);
var listY = L.y + summaryH + 5;
var infoY = bottom - capH - 3;
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
    // o pkg vira pasta (dest/stage/old): barra ou ".." escaparia de apps/
    if (pkg.indexOf("/") !== -1 || pkg.indexOf("\\") !== -1) return false;
    if (pkg.indexOf("..") !== -1) return false;
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
        // cede a janela do executor a cada 8 apps: readJson + tamanho de arvore
        // de dezenas de pacotes no cartao passava do slice de 1 s e o app
        // morria com "execution timeout" (mesmo sintoma que a varredura do
        // Ajustes tinha)
        if ((i & 7) === 7) System.delay(1);
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
            // a varredura inteira num quadro estourava o slice de 1 s com o
            // cartao cheio de apps (execution timeout na abertura): cede de 4
            // em 4 pastas (A.fsx.treeSize anda a arvore do pacote)
            if ((i & 3) === 3) System.delay(1);
            var m = readJson(A.path.join(dir, "app.json"));
            if (m === null || typeof m.name !== "string" || m.name.length === 0) continue;
            apps.push({
                folder: dir,
                name: m.name,
                pkg: (typeof m.packageName === "string") ? m.packageName : "",
                version: (typeof m.version === "string" && m.version.length > 0) ? m.version : "1.0.0",
                api: (typeof m.api === "number") ? m.api : (parseInt(m.api, 10) || 0),
                req: Array.isArray(m.requires) ? m.requires : [],
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
    // requires que esta placa nao atende: o app quebraria na primeira chamada
    // (psram) ou nem carregaria o blob nativo (native, API 57). O mesmo
    // vocabulario que a App Store usa; sem o gate o SD vendia dardo.
    var req = app.req || [];
    if (req.indexOf("native") >= 0) {
        var gi = null; try { gi = System.getInfo(); } catch (e0) { gi = null; }
        if (!gi || gi.hasNative !== true) {
            A.error("Requer S3", "Este app carrega código nativo e só roda em " +
                    "ESP32-S3 com PSRAM. Instale pela App Store em uma placa " +
                    "compatível.");
            return null;
        }
    }
    if (req.indexOf("psram") >= 0) {
        var gi2 = null; try { gi2 = System.getInfo(); } catch (e1) { gi2 = null; }
        if (!gi2 || !(gi2.totalPSRAM > 0)) {
            A.error("Requer PSRAM", "Este app precisa de PSRAM; esta placa não " +
                    "tem. Instale pela App Store em uma placa compatível.");
            return null;
        }
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
    UI.resetScroll("installer-empty");
    detail = null;
    UI.invalidate();
}

// ---- tela de detalhe --------------------------------------------------------
function desenhaDetalhe(c, app) {
    if (A.header(app.name)) { detail = null; return A.BACK; }
    var y = L.y;
    var dest = "Destino: " + A.path.join(destBase(), app.pkg);
    var destH = Math.min(UI.measureWrap(dest, L.w - 16, "caption"), 2 * capH + 3);
    var statusH = 37 + destH + (app.deps ? 3 : 2) * (capH + 4);
    var statusY = footerY - 5 - statusH;
    A.style.card(L.x, y, L.w, statusY - y - 5, {
        full: c.full, elev: 2, grad: true,
        draw: function (r) {
            A.icons.draw("star", r.x, r.y + 1, 20, { color: T.accent });
            // EMPILHADO pela altura devolvida: no vidro grande o titulo mede
            // 28 px e a legenda em +26 fixo caia dentro dele
            var ty = r.y;
            UI.text("v" + app.version, r.x + 28, r.y,
                          { role: "title", color: T.text, bg: r.bg, w: r.w - 28, lines: 1 });
            ty += Math.max(22, UI.lineHeight("title")) + 3;
            ty += UI.text("API " + app.api + (app.author.length ? "  ·  " + app.author : ""),
                          r.x, ty, { role: "caption", color: T.textDim, bg: r.bg, w: r.w, lines: 1 }) + 4;
            var desc = app.desc || "Sem descrição.";
            var height = Math.max(1, r.y + r.h - ty);
            var off = UI.scrollBegin("pacote-desc", r.x, ty, r.w, height, Math.max(height, UI.measureWrap(desc, r.w, "caption")));
            UI.text(desc, r.x, ty - off, { role: "caption", color: T.text, bg: r.bg, w: r.w, lines: 64 });
            UI.scrollEnd();
        }
    });

    var stTxt, stCol;
    if (dInst === null) { stTxt = "Não instalado"; stCol = T.textDim; }
    else if (vcmp(app.version, dInst) > 0) { stTxt = "Atualização: v" + dInst + " para v" + app.version; stCol = T.warn; }
    else { stTxt = "Instalado v" + dInst; stCol = T.ok; }
    A.style.card(L.x, statusY, L.w, statusH, { pad: 8,
        full: c.full, elev: 1, grad: true,
        draw: function (r) {
            UI.badge(stTxt, r.x, r.y, { color: T.raised, textColor: stCol });
            var ty = r.y + capH + 11;
            ty += UI.text(dest, r.x, ty,
                          { role: "caption", color: T.textDim, bg: r.bg, w: r.w, lines: 2 }) + 4;
            ty += UI.text("Pacote: " + kb(app.size), r.x, ty,
                          { role: "caption", bg: r.bg, w: r.w, lines: 1 }) + 4;
            ty += UI.text("Livre: " + kb(dLivre), r.x, ty,
                          { role: "caption", bg: r.bg, w: r.w, lines: 1 }) + 4;
            if (app.deps) {
                UI.text(dDeps && dDeps.length ? "Faltam módulos: " + dDeps.length
                                              : "Dependências no cache",
                        r.x, ty,
                        { role: "caption", color: (dDeps && dDeps.length) ? T.err : T.ok,
                          bg: r.bg, w: r.w, lines: 1 });
            }
        }
    });

    var lbl = "Instalar";
    if (dInst !== null) lbl = vcmp(app.version, dInst) > 0 ? "Atualizar" : "Reinstalar";
    if (A.style.button(lbl, L.x, footerY, L.w, 40) && tryInstall(app)) {
        detail = null;
        return A.BACK;
    }
}

// ---- telas ------------------------------------------------------------------
rescan();   // scan na abertura (busy + lista pronta antes do 1o frame)
A.run({
    lista: function (c) {
        if (A.header("Installer")) return A.BACK;
        var refreshX = L.x + L.w - 30;
        var scan = UI.button("", refreshX, 5, 30, 30, { style: "ghost", id: "rescan" });
        A.icons.draw("search", refreshX + 7, 12, 16, { color: T.text });
        if (scan) { rescan(); return; }

        // destino (toque no toggle alterna flash/SD)
        A.style.card(L.x, L.y, L.w, summaryH, {
            pad: 6,
            full: c.full, elev: 1, grad: true,
            draw: function (r) {
                var sd = destBase() === SD_APPS;
                UI.text("Instalar no SD", r.x, r.y + 1,
                        { color: T.text, bg: r.bg, w: r.w - 56, lines: 1 });
                UI.text(apps.length + " app(s)  ·  " + (sd ? "/sd/apps" : "/local/apps"),
                        r.x, r.y + bodyH + 3,
                        { role: "caption", color: T.textDim, bg: r.bg, w: r.w - 56, lines: 1 });
                if (UI.toggle(r.x + r.w - 46, r.y + (r.h - 24) / 2, sd) !== sd) toggleDest();
            }
        });

        if (apps.length === 0) {
            // altura DERIVADA do texto medido: no vidro grande as legendas de
            // 2 linhas passavam dos offsets fixos 68/96 e a segunda saida do
            // cartao de 136 px
            var e1 = sdOk ? "Nenhum pacote em /sd/apps."
                          : "Cartão SD não encontrado ou sem a pasta apps.";
            var e2 = "Copie apps para o cartão ou use o celerctl / App Store.";
            A.style.card(L.x, listY, L.w, footerY - listY - 5, {
                full: c.full, elev: 1, pad: 8,
                draw: function (r) {
                    var contentH = 37 + UI.lineHeight("title") + UI.measureWrap(e1, r.w, "caption") +
                                   UI.measureWrap(e2, r.w, "caption") + 9;
                    var off = UI.scrollBegin("installer-empty", r.x, r.y, r.w, r.h, Math.max(r.h, contentH));
                    var ty = r.y + Math.max(0, Math.floor((r.h - contentH) / 2)) - off;
                    A.icons.draw("info", cx - 11, ty + 2, 22, { color: T.warn });
                    ty += 32;
                    ty += UI.text("SD sem apps", cx, ty, { role: "title", align: "center",
                                  color: T.warn, bg: r.bg, w: r.w }) + 4;
                    ty += UI.text(e1, cx, ty, { role: "caption", align: "center",
                                  color: T.textDim, bg: r.bg, w: r.w, lines: 4 }) + 4;
                    UI.text(e2, cx, ty, { role: "caption", align: "center",
                            color: T.textDim, bg: r.bg, w: r.w, lines: 4 });
                    UI.scrollEnd();
                }
            });
            if (A.style.button("Procurar de novo", L.x, footerY, L.w, 40)) rescan();
            return;
        }

        var rows = linhas.rows();
        var lh = infoY - listY - 5;
        var i = A.list.view("apps", L.x, listY, L.w, lh, rows, { row: 44 });
        if (i >= 0) {
            var app = abrirApp(i);
            if (app !== null) { detail = app; UI.resetScroll("pacote-desc"); return "detalhe"; }
        }
        // espaco livre medido no scan/troca: nunca bloqueia o desenho do frame
        UI.text("Livre: " + kb(espacos.loc) + (sdOk ? "  ·  SD: " + kb(espacos.sd) : ""),
                cx, infoY, { role: "caption", align: "center", color: T.textDim, w: L.w, lines: 1 });

    },
    detalhe: function (c) {
        if (!detail) return A.BACK;
        return desenhaDetalhe(c, detail);
    }
}, "lista", { fps: 15 });
