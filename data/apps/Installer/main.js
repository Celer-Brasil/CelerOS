// CelerOS Installer — app de sistema (W8). Porte do InstallerUI.cpp:
// escaneia /sd/apps/, mostra detalhes dos pacotes e instala na flash
// (/local/apps) ou no proprio SD (flag /local/config_install_sd.txt).
// Interface no toolkit UI (API 22). X no canto sup. direito sai.

var T = System.theme();

var SD_FLAG = "/local/config_install_sd.txt";
var SD_APPS = "/sd/apps";
var LCL_APPS = "/local/apps";
var LX = 8, LW = 224, TOP = 48;

// ---- estado ----------------------------------------------------------------
var state = "list"; // list | detail
var apps = [];
var sdOk = false;
var detail = null;
var detailNeed = 0;  // bytes do pacote aberto (medido 1x no openApp)

// ---- logica de instalacao ---------------------------------------------------
function baseName(p) {
    var i = p.lastIndexOf("/");
    return i >= 0 ? p.substring(i + 1) : p;
}
function parentOf(p) {
    var i = p.lastIndexOf("/");
    return i > 0 ? p.substring(0, i) : p;
}
function flagSD() { return FS.exists(SD_FLAG); }
function destBase() {
    if (flagSD() && FS.isDirectory("/sd")) return SD_APPS;
    return LCL_APPS;
}
function destLabel() {
    return destBase() === SD_APPS ? "SD (/sd/apps)" : "Flash (/local/apps)";
}
function toggleDest() {
    if (flagSD()) FS.deleteFile(SD_FLAG);
    else FS.writeTextFile(SD_FLAG, "sd\n");
    refreshInstalled();
    UI.invalidate();
}
function verParts(v) {
    var p = [0, 0, 0];
    var s = String(v).split(".");
    for (var i = 0; i < 3 && i < s.length; i++) {
        var n = parseInt(s[i], 10);
        if (!isNaN(n)) p[i] = n;
    }
    return p;
}
function verGreater(a, b) {
    var x = verParts(a);
    var y = verParts(b);
    for (var i = 0; i < 3; i++) {
        if (x[i] > y[i]) return true;
        if (x[i] < y[i]) return false;
    }
    return false;
}
function validPkg(pkg) {
    if (pkg.length === 0) return false;
    if (pkg.indexOf(" ") !== -1) return false;
    if (pkg.indexOf(".") === -1) return false;
    return pkg === pkg.toLowerCase();
}
function installedMeta(app) {
    var p = destBase() + "/" + app.pkg + "/app.json";
    if (!FS.exists(p)) return null;
    var txt = FS.readTextFile(p);
    if (txt === null || txt.length === 0) return null;
    try { return JSON.parse(txt); } catch (e) { return null; }
}
function refreshInstalled() {
    var base = destBase();
    for (var i = 0; i < apps.length; i++) {
        var app = apps[i];
        app.inst = false;
        app.instVer = "";
        if (app.pkg.length === 0) continue;
        var jp = base + "/" + app.pkg + "/app.json";
        if (!FS.exists(jp)) continue;
        app.inst = true;
        var m = installedMeta(app);
        if (m !== null && m.version) app.instVer = String(m.version);
    }
}
function scanApps() {
    apps = [];
    sdOk = FS.mountSD();
    if (!sdOk) return;
    var entries = FS.listDir(SD_APPS); // retorna caminhos completos
    for (var i = 0; i < entries.length; i++) {
        var base = baseName(entries[i]);
        if (base.length === 0 || base.charAt(0) === ".") continue;
        var dir = SD_APPS + "/" + base;
        if (!FS.isDirectory(dir)) continue;
        var jp = dir + "/app.json";
        if (!FS.exists(jp)) continue;
        var txt = FS.readTextFile(jp);
        if (txt === null || txt.length === 0) continue;
        var m = null;
        try { m = JSON.parse(txt); } catch (e) { m = null; }
        if (m === null || typeof m.name !== "string" || m.name.length === 0) continue;
        apps[apps.length] = {
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
            lockDeps: FS.exists(dir + "/deps.json"),
            inst: false,
            instVer: ""
        };
    }
    apps.sort(function (a, b) {
        var x = a.name.toLowerCase();
        var y = b.name.toLowerCase();
        return x < y ? -1 : (x > y ? 1 : 0);
    });
    System.print("Installer: " + apps.length + " app(s) em " + SD_APPS);
}

// ---- telas ------------------------------------------------------------------
function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB"; }
// tamanho real do pacote (main + extras + assets). Os pacotes sao flat; a
// profundidade 4 e so uma guarda contra pasta malformada.
function pkgBytes(dir, depth) {
    var total = 0;
    if ((depth || 0) > 4) return 0;
    try {
        var list = FS.listDir(dir) || [];
        for (var i = 0; i < list.length; i++) {
            if (FS.isDirectory(list[i])) total += pkgBytes(list[i], (depth || 0) + 1);
            else total += FS.getFileSize(list[i]) || 0;
        }
    } catch (e) { total = 0; }
    return total;
}

// Frame avulso (fora do laco): "buscando" e "instalando" antes das chamadas
// bloqueantes de FS
function busyFrame(title, sub) {
    UI.invalidate();
    UI.begin(T.bg);
    UI.header("Installer");
    UI.spinner(120, 132, 18);
    UI.text(title, 120, 166, { role: "title", align: "center", w: LW });
    if (sub) UI.text(sub, 120, 198, { role: "caption", align: "center", color: T.textDim, w: LW });
    UI.end();
}
function rows() {
    var out = [];
    for (var i = 0; i < apps.length; i++) {
        var app = apps[i];
        out.push({ label: app.name, sub: "v" + app.version + " · API " + app.api,
                   right: app.inst ? "instalado" : "", rightColor: T.ok });
    }
    return out;
}
function drawList() {
    UI.header("Installer", { sub: apps.length ? apps.length + " no SD" : "" });
    // destino (toque alterna flash/SD)
    UI.card(LX, TOP, LW, 44);
    UI.text("Instalar no cartão SD", LX + 12, TOP + 14, { w: 150 });
    var sd = destBase() === SD_APPS;
    if (UI.toggle(LX + LW - 56, TOP + 10, sd) !== sd) toggleDest();
    UI.cardEnd();

    if (apps.length === 0) {
        UI.card(LX, TOP + 56, LW, 140);
        UI.text("SD sem apps", 120, TOP + 76, { role: "title", align: "center", color: T.warn });
        UI.text(sdOk ? "Nenhum app em /sd/apps." : "Cartão SD não encontrado.", 120, TOP + 108,
                { align: "center", w: LW - 16 });
        UI.text("Copie apps para o cartão ou use o celerctl / App Store.", 120, TOP + 136,
                { role: "caption", align: "center", color: T.textDim, w: LW - 24, lines: 2 });
        UI.cardEnd();
        if (UI.button("Procurar de novo", LX, 268, LW, 40)) rescan();
        return;
    }
    var i = UI.list("apps", LX, TOP + 52, LW, 312 - TOP - 52, rows(), { rowH: 48 });
    if (i >= 0) openApp(i);
}
function drawDetail() {
    var app = detail;
    var inst = installedMeta(app);
    var isUpd = (inst !== null && inst.version && verGreater(app.version, inst.version));
    if (UI.header(app.name, { back: true })) {
        state = "list";
        UI.invalidate();
        return;
    }
    UI.card(LX, TOP, LW, 150);
    UI.text("v" + app.version + "  ·  API " + app.api, LX + 12, TOP + 10, { role: "caption", color: T.textDim });
    var y = TOP + 30;
    if (app.author.length > 0) {
        UI.text("Autor: " + app.author, LX + 12, y, { role: "caption", color: T.textDim, w: LW - 24 });
        y += 20;
    }
    UI.text(app.desc || "Sem descrição.", LX + 12, y, { role: "caption", w: LW - 24, lines: 5 });
    UI.cardEnd();

    var stTxt, stCol;
    if (inst === null) { stTxt = "Não instalado"; stCol = T.textDim; }
    else if (isUpd) { stTxt = "Nova versão: v" + app.version; stCol = T.warn; }
    else { stTxt = "Instalado v" + (inst.version ? String(inst.version) : "?"); stCol = T.ok; }
    UI.badge(stTxt, LX, TOP + 160, { color: T.raised, textColor: stCol });

    var need = detailNeed;
    UI.text("Destino: " + destBase() + "/" + app.pkg, LX + 2, TOP + 188, { role: "caption", color: T.textDim, w: LW - 4 });
    UI.text("Pacote: " + kb(need) + "  ·  Livre: " + kb(FS.getFreeSpace(destBase())), LX + 2, TOP + 206,
            { role: "caption", color: T.textDim });

    var lbl = "Instalar";
    if (inst !== null) lbl = isUpd ? "Atualizar" : "Reinstalar";
    if (UI.button(lbl, LX, 268, LW, 40)) tryInstall(detail);
}

// ---- fluxo -------------------------------------------------------------------
var BAD_PKG = "packageName incorreto: use minúsculas, sem espaços e com ponto (a.b.c).";
function showAlert(title, lines, isErr) {
    UI.alert(title, lines.join(" "));
    if (!isErr) state = "list";
    refreshInstalled();
    UI.invalidate();
}
function openApp(i) {
    var app = apps[i];
    var lvl = System.getAPILevel();
    if (app.api > lvl) {
        showAlert("Incompatível", ["O app requer API " + app.api + "; este sistema tem API " + lvl + ". Atualize o CelerOS."], true);
        return;
    }
    if (!validPkg(app.pkg)) {
        showAlert("Pacote inválido", [BAD_PKG], true);
        return;
    }
    var inst = installedMeta(app);
    if (inst !== null && inst.author && app.author && inst.author !== app.author) {
        showAlert("Conflito", ["Autor diferente do instalado (" + String(inst.author) + " / " + app.author + ")."], true);
        return;
    }
    if (app.deps && !app.lockDeps) {
        showAlert("Tem dependências", ["Este app usa dependências compartilhadas que só a rede baixa. " +
                  "Instale pela App Store ou com celerctl apps install."], true);
        return;
    }
    detail = app;
    detailNeed = pkgBytes(app.folder);  // 1x por abertura: nao relê o SD por frame
    state = "detail";
    UI.invalidate();
}
// deps.json resolvido embarcado no pacote: confere se o cache /local/modules
// tem cada <nome>/<versao> (onde o require cai). Devolve a lista de faltantes
// (vazia = ok) ou null se o deps.json nao puder ser lido.
function modulosFaltando(destPkg) {
    var txt = null;
    try { txt = FS.readTextFile(destPkg + "/deps.json"); } catch (e) { txt = null; }
    if (txt === null || txt.length === 0) return null;
    var lock = null;
    try { lock = JSON.parse(txt); } catch (e2) { return null; }
    var falta = [];
    for (var nm in lock) if (lock.hasOwnProperty(nm)) {
        if (!FS.exists("/local/modules/" + nm + "/" + lock[nm] + "/" + nm + ".js")) {
            falta[falta.length] = nm + " " + lock[nm];
        }
    }
    return falta;
}
function tryInstall(app) {
    if (!validPkg(app.pkg)) {
        showAlert("Pacote inválido", [BAD_PKG], true);
        return;
    }
    var base = destBase();
    var dest = base + "/" + app.pkg;
    // Espaco ANTES de tocar no disco: a copia nova fica AO LADO da antiga,
    // entao o pico e o tamanho do pacote (update reusa esse espaco livre).
    // Antes, a falta de espaco caia num fallback que APAGAVA a versao
    // instalada e tentava copiar de novo — disco cheio deixava o usuario
    // sem nenhuma das duas. Sem espaco agora: falha limpa, antiga intacta.
    var need = pkgBytes(app.folder);
    var livre = 0;
    try { livre = FS.getFreeSpace(base); } catch (e0) { livre = 0; }
    if (livre > 0 && need > 0 && livre < need) {
        showAlert("Sem espaço", ["O pacote precisa de " + kb(need) +
                  " e o destino tem " + kb(livre) + " livres. A versão instalada foi mantida."], true);
        return;
    }
    busyFrame("Instalando...", app.name + " - não desligue o aparelho");  // copia bloqueante
    FS.mkdir(base);
    // Transacional: copia para um staging FORA de apps/ (o launcher varre
    // /local/apps e /sd/apps: um <pkg>.inst pela metade com app.json
    // aparecia como app duplicado depois de uma queda de energia) e so
    // entao troca pela versao antiga. Mesma particao do destino: rename
    // entre /local e /sd nao funciona.
    var tmp = parentOf(base) + "/.inst-" + app.pkg;
    var legado = dest + ".inst";
    if (FS.isDirectory(legado)) FS.removeDirectory(legado);  // staging da versao antiga
    if (FS.isDirectory(tmp)) FS.removeDirectory(tmp);        // sobra de falha anterior
    var ok = FS.copyDirectory(app.folder, tmp);
    if (ok && FS.isDirectory(dest)) ok = FS.removeDirectory(dest);
    if (ok && !FS.renameFile(tmp, dest)) {
        // rename falhou DEPOIS de remover a antiga: o .inst e a UNICA copia
        // — nao apaga. O dono ve o aviso e reinicia (o launcher reescaneia).
        showAlert("Falhou", ["A troca da pasta falhou depois da cópia. " +
                  "A versão nova ficou em " + tmp + "; reinicie e tente de novo."], true);
        return;
    }
    if (!ok && FS.isDirectory(tmp)) FS.removeDirectory(tmp);  // copia incompleta: descarta
    if (ok) {
        System.rescanApps();
        if (typeof System.playTone === "function") {
            try { System.playTone([[784, 80], [1047, 110]]); } catch (e1) {}
        }
        var falta = app.deps ? modulosFaltando(dest) : null;
        if (falta !== null && falta.length > 0) {
            showAlert("Instalado sem módulos", ["Faltam no cache: " + falta.join(", ") +
                      ". Abra pela App Store para baixar as dependências."], true);
            return;
        }
        showAlert("Instalado!", [app.name + " v" + app.version + " em " + dest + "."], false);
    } else {
        var livreAgora = 0;
        try { livreAgora = Math.round(FS.getFreeSpace(base) / 1024); } catch (e4) { livreAgora = 0; }
        showAlert("Falhou", ["Não foi possível copiar o app. Espaço livre: " + livreAgora + " KB."], true);
    }
}
function rescan() {
    busyFrame("Buscando apps...", "");
    scanApps();
    refreshInstalled();
    UI.resetScroll("apps");
    detail = null;
    state = "list";
    UI.invalidate();
}

// ---- inicializacao + loop -----------------------------------------------------
rescan();
while (true) {
    UI.begin(T.bg);
    if (state === "detail") drawDetail();
    else drawList();
    UI.end();
}
