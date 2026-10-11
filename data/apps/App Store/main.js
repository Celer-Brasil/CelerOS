// CelerOS App Store v3 — app de sistema com abas. Le o catalogo do CelerOS
// Hub (os.celer.tec.br; 2 HTTPS: indice + "Todos"), instala/atualiza apps em
// /local/apps ou /sd/apps, desinstala e ATUALIZA A SI MESMA (celeros.appstore
// esta no proprio catalogo: gravar os arquivos em disco basta — o main.js e
// relido do disco a cada abertura; ao se atualizar, a loja pede sair/reabrir).
//
// Interface no toolkit UI (API 22):
//   [Loja | Atualizar | Instalados]  abas (UI.tabs) no topo do canvas
//   Loja:        Buscar + seletor de categoria + lista com o estado de cada
//                app a direita (Novo / Instalado / Atualizar / API / PSRAM)
//   Atualizar:   so apps com versao nova (vLocal > vRemota + changelog),
//                rodape "Atualizar tudo" (a propria loja vai por ultimo)
//   Instalados:  instalados, com Desinstalar no detalhe (dupla confirmacao
//                p/ app de sistema)
// Instalacao: main.js em <pkg>/main.js.new via Net.download (streaming, sem
// teto de 32KB), MD5 do catalogo conferido, rename atomico no mesmo FS; a
// pasta alvo e RESOLVIDA por packageName (primeira vista na ordem do
// listDir, mesma regra do launcher) — updates in-place nao criam copias
// sombreadas de apps preinstalados ("App Store" vs celeros.appstore) e as
// duplicatas antigas sao removidas apos o update. X no canto sup. sai.

var INDEX_URL = "https://os.celer.tec.br/store/index.json";
var HUB_BASE = INDEX_URL.substring(0, INDEX_URL.indexOf("/store/"));
// Cache de dependencias compartilhadas (API 30): /local/modules/<nome>/
// <versao>/<nome>.js — escrita permitida a system apps (a loja e uma).
// Compatibilidade de hardware: apps com requires ["psram"] sao bloqueados
// em placa sem PSRAM (badge "Requer PSRAM"). Fallback para catalogo antigo
// sem o campo: teto DINAMICO pela RAM da placa, calibrado na CYD
// (61KB roda, 82KB nao compila -> (appRAM - 60000) * 0,4 = ~66KB).
var HWINFO = System.getInfo ? System.getInfo() : null;
var NO_PSRAM = !!(HWINFO && HWINFO.totalPSRAM === 0);
var PSRAM_MAX_JS = !NO_PSRAM ? Infinity
    : HWINFO.appRAM ? Math.max(4096, Math.floor((HWINFO.appRAM - 60000) * 0.4))
    : Math.max(4096, Math.floor(((HWINFO.freeRAM || 0) - 52000) / 1.7));
// requires psram declarado vence; heuristica cobre catalogo antigo
function needsPsram(it) { return (it.req && it.req.indexOf("psram") >= 0) || (it.size || 0) > PSRAM_MAX_JS; }

// Flag "instalar no SD" no NVS de settings (F3; System.setting). Arquivo
// legado continua valendo para firmware antigo.
var FLAG_SD = "/local/config_install_sd.txt";
function installOnSd() {
    if (System.setting) {
        var v = System.setting("install_sd");
        if (v !== null) return v === "1";
    }
    return FS.exists(FLAG_SD);
}
var CACHE = "/local/appstore_cache.json";
var STORE_PKG = "celeros.appstore";

var T = System.theme();
var API = System.getAPILevel();

// ---- utilitarios -------------------------------------------------------------
function baseName(p) {
    var i = p.lastIndexOf("/");
    return i >= 0 ? p.substring(i + 1) : p;
}

function dirName(p) {
    var i = p.lastIndexOf("/");
    return i > 0 ? p.substring(0, i) : p;
}

function fmtKB(n) {
    if (!n || n <= 0) return "";
    if (n < 1024) return n + " B";
    var kb = Math.round(n / 102.4) / 10;
    return (kb % 1 ? kb : kb.toFixed(0)) + " KB";
}

// ---- rede (Net bloqueante; qualquer erro vira null/false) ------------------
// ---- rede (Net bloqueante; qualquer erro vira null/false) ------------------
function fetchJSON(url) {
    try { return Net.getJSON(url); } catch (e) { return null; }
}

function fetchText(url) {
    try { return Net.get(url); } catch (e) { return null; }
}

// semver numerico parte a parte (herdado do AppStoreUI.cpp)
function cmpV(v1, v2) {
    v1 = v1 || "";
    v2 = v2 || "";
    var p1 = 0, p2 = 0;
    while (p1 < v1.length || p2 < v2.length) {
        var n1 = 0, n2 = 0;
        while (p1 < v1.length && v1.charAt(p1) != ".") {
            n1 = n1 * 10 + (v1.charCodeAt(p1) - 48);
            p1++;
        }
        while (p2 < v2.length && v2.charAt(p2) != ".") {
            n2 = n2 * 10 + (v2.charCodeAt(p2) - 48);
            p2++;
        }
        if (n1 > n2) return 1;
        if (n1 < n2) return -1;
        p1++;
        p2++;
    }
    return 0;
}

// ---- deps compartilhadas (API 30) -------------------------------------------
// "^1.2.0" = mesma major >= base; sem "^" = exata. Mesmo contrato do
// celerhub.py e do servidor (range resolve no install, versao escolhida
// grava em <pasta>/deps.json).
function depRangeOk(rng, ver) {
    rng = String(rng);
    if (rng.charAt(0) !== "^") return rng === ver;
    function parts(s) {
        if (s.charAt(0) === "^") s = s.substring(1);  // so o range traz "^";
        var seg = s.split("."), o = [];               // corta-lo da versao
        for (var i = 0; i < 3; i++) o.push(parseInt(seg[i], 10) || 0); // virava [0,y,z]
        return o;
    }
    var R = parts(rng), V = parts(ver);
    return V[0] === R[0] && (V[1] > R[1] || (V[1] === R[1] && V[2] >= R[2]));
}
// maior versao do nome que satisfaca TODOS os ranges coletados
function depPick(nm, ranges, index) {
    var vers = index[nm], best = null;
    if (!vers) return null;
    for (var v in vers) if (vers.hasOwnProperty(v)) {
        var ok = true;
        for (var i = 0; i < ranges.length; i++) {
            if (!depRangeOk(ranges[i], v)) { ok = false; break; }
        }
        if (ok && (best === null || cmpV(v, best) > 0)) best = v;
    }
    return best;
}
// grafo diretas + transitivas -> {nome: versao}; null se algo nao resolve
function resolveDeps(want, index) {
    var wanted = {}, seen = {}, queue = [], k;
    for (k in want) if (want.hasOwnProperty(k)) queue.push([k, want[k]]);
    while (queue.length) {
        var pair = queue.shift(), nm = pair[0], rng = String(pair[1]);
        var key = nm + "|" + rng;
        if (seen[key]) continue;
        seen[key] = 1;
        if (!wanted[nm]) wanted[nm] = [];
        wanted[nm].push(rng);
        var pick = depPick(nm, wanted[nm], index);
        if (!pick) return null;
        var sub = index[nm][pick].deps || {};
        for (k in sub) if (sub.hasOwnProperty(k)) queue.push([k, sub[k]]);
    }
    var out = {};
    for (k in wanted) if (wanted.hasOwnProperty(k)) {
        var p = depPick(k, wanted[k], index);
        if (!p) return null;
        out[k] = p;
    }
    return out;
}
// alimenta o cache /local/modules/<nome>/<versao>/ com o que falta — mesmo
// contrato dos arquivos do app: download streaming, MD5, .new + rename
function installDeps(it, resolved, index) {
    for (var nm in resolved) if (resolved.hasOwnProperty(nm)) {
        var ver = resolved[nm];
        var d = index[nm][ver];
        var dir = "/local/modules/" + nm + "/" + ver;
        var dst = dir + "/" + nm + ".js";
        if (FS.exists(dst)) continue;  // ja no cache; o GC recolhe orfas
        if (d.minApi && d.minApi > API) return nm + " exige API " + d.minApi;
        if (!FS.isDirectory("/local/modules") && !FS.mkdir("/local/modules")) return "Erro no disco";
        if (!FS.isDirectory("/local/modules/" + nm) && !FS.mkdir("/local/modules/" + nm)) return "Erro no disco";
        if (!FS.isDirectory(dir) && !FS.mkdir(dir)) return "Erro no disco";
        drawDownload(it.name, nm + " " + ver);
        System.delay(30);
        var tmp = dir + "/" + nm + ".js.new";
        var ok = false;
        try {
            ok = Net.download(d.url, tmp, function (got, total) { drawProgress(got, total); });
        } catch (e) { ok = false; }
        if (!ok) { try { FS.deleteFile(tmp); } catch (e9) {} return "Erro ao baixar " + nm; }
        var md = "";
        try { md = FS.getFileMD5(tmp); } catch (e2) { md = ""; }
        if (d.md5 && md !== d.md5) {
            try { FS.deleteFile(tmp); } catch (e3) {}
            return "Verificação falhou (" + nm + ")";
        }
        if (!FS.renameFile(tmp, dst)) return "Erro ao gravar " + nm;
    }
    return "";
}

// ---- estado ----------------------------------------------------------------
var apps = [];        // catalogo
var cats = [];        // ["Todos", "Arcade", ...] (do catalogo)
var curCat = "Todos";
var curTab = 0;       // 0=Loja 1=Atualizar 2=Instalados
var selIt = null;     // item aberto no detalhe
var localMap = {};    // pkg -> {ver, root, dir, name, system, sd}
var updCount = 0;
var errMsg = "", errHint = "", retryMode = "";
var wasUpdate = false, selfUpdated = false;
var batchOk = 0, batchFails = [];

// Versao dos dados que alimentam as listas (apps/localMap/cats): sobe a cada
// refresh(). curList()/curRows() cacheiam por essa chave — a lista e lida a
// cada frame e refiltrar+reordenar o catalogo inteiro por frame custava caro
// (installedItems: sort + catalogByPkg linear por item).
var dataStamp = 0;
var listCache = { key: null, items: null };
var query = "";       // filtro de busca da Loja ("" = desligado)

// ---- disco: instalados -----------------------------------------------------
// ---- disco: instalados -----------------------------------------------------
// mesma regra do launcher (LauncherUI::scanLocalApps): PRIMEIRO visto ganha —
// a ordem do listDir e a mesma nos dois, entao o estado exibido e o que o
// launcher executa de verdade.
function scanLocalApps() {
    localMap = {};
    var roots = ["/local/apps", "/sd/apps"];
    for (var r = 0; r < 2; r++) {
        var root = roots[r];
        if (!FS.isDirectory(root)) continue;
        var list = FS.listDir(root);
        for (var i = 0; i < list.length; i++) {
            var dir = list[i];
            if (!FS.isDirectory(dir)) continue;
            var body = FS.readTextFile(dir + "/app.json");
            if (!body) continue;
            var doc = null;
            try { doc = JSON.parse(body); } catch (e) { doc = null; }
            if (!doc) continue;
            var pkg = doc.packageName || baseName(dir);
            if (localMap[pkg]) continue;  // duplicata: o launcher usa a 1a
            localMap[pkg] = {
                ver: doc.version || "", dir: dir, root: root,
                name: doc.name || pkg, system: doc.system === true,
                sd: root === "/sd/apps"
            };
        }
    }
}

// pasta onde o pkg vive hoje (na ordem do launcher) ou null.
function resolveInstalledDir(pkg) {
    var roots = ["/local/apps", "/sd/apps"];
    for (var r = 0; r < 2; r++) {
        var root = roots[r];
        if (!FS.isDirectory(root)) continue;
        var list = FS.listDir(root);
        for (var i = 0; i < list.length; i++) {
            var dir = list[i];
            if (!FS.isDirectory(dir)) continue;
            var body = FS.readTextFile(dir + "/app.json");
            if (!body) continue;
            var doc = null;
            try { doc = JSON.parse(body); } catch (e2) { doc = null; }
            if (doc && (doc.packageName || baseName(dir)) === pkg) return dir;
        }
    }
    return null;
}

// remove copias sombreadas do pkg (duplicatas de installs antigos);
// keepDir e a pasta que o launcher executa.
function removeShadowed(pkg, keepDir) {
    var roots = ["/local/apps", "/sd/apps"];
    for (var r = 0; r < 2; r++) {
        var root = roots[r];
        if (!FS.isDirectory(root)) continue;
        var list = FS.listDir(root);
        for (var i = 0; i < list.length; i++) {
            var dir = list[i];
            if (dir === keepDir || !FS.isDirectory(dir)) continue;
            var body = FS.readTextFile(dir + "/app.json");
            if (!body) continue;
            var doc = null;
            try { doc = JSON.parse(body); } catch (e2) { doc = null; }
            if (doc && doc.packageName === pkg) FS.removeDirectory(dir);
        }
    }
}

function catalogByPkg(pkg) {
    for (var i = 0; i < apps.length; i++) {
        if (apps[i].pkg === pkg) return apps[i];
    }
    return null;
}

// estado do app vs instalado: "new" | "upd" | "inst" | "api"
function stateInfo(it) {
    var loc = localMap[it.pkg];
    if ((it.api || 1) > API) return { code: "api", txt: "API " + it.api, col: T.warn };
    if (NO_PSRAM && needsPsram(it)) return { code: "hw", txt: "Requer PSRAM", col: T.warn };
    if (!loc) return { code: "new", txt: "Novo", col: T.ok };
    // so oferece update se o hub for MAIS NOVO: versao local mais nova (dev,
    // imagem da flash a frente do hub) nao pode virar "Atualizar" (downgrade)
    if (cmpV(it.ver, loc.ver) <= 0) {
        return { code: "inst", txt: "Instalado", col: T.textDim };
    }
    return { code: "upd", txt: "Atualizar", col: T.warn };
}

function countUpdates() {
    updCount = 0;
    for (var i = 0; i < apps.length; i++) {
        if (stateInfo(apps[i]).code === "upd") updCount++;
    }
}

// atualizacoes primeiro; empate = ordem alfabetica
function sortByUpdate() {
    // chaves PRE-COMPUTADAS: o sort nativo do Duktape roda em preventyield
    // (a janela do exec-timeout nao renova entre comparacoes) e o stateInfo
    // por comparacao derrubou o app com RangeError no device com a CPU
    // disputada (no 4848 que retransmite a malha). O delay renova a janela
    // para o lote de stateInfo do decorate; as chaves sujam o cache mas o
    // JSON.stringify pula undefined
    System.delay(1);
    for (var i = 0; i < apps.length; i++) {
        apps[i]._u = stateInfo(apps[i]).code === "upd" ? 0 : 1;
        apps[i]._n = (apps[i].name || "?").toLowerCase();
    }
    apps.sort(function (a, b) {
        if (a._u !== b._u) return a._u - b._u;
        return a._n < b._n ? -1 : (a._n > b._n ? 1 : 0);
    });
    for (var j = 0; j < apps.length; j++) { apps[j]._u = undefined; apps[j]._n = undefined; }
}

function refresh() {
    scanLocalApps();
    countUpdates();
    sortByUpdate();
    buildCats();
    dataStamp++;  // invalida os caches de lista/chips (curList/chipsGeom)
}

// itens da aba Meus apps: todo pkg instalado (do catalogo quando existir,
// sintetico quando nao)
function installedItems() {
    var out = [];
    for (var pkg in localMap) {
        if (!localMap.hasOwnProperty(pkg)) continue;
        var it = catalogByPkg(pkg);
        if (!it) {
            it = {
                pkg: pkg, name: localMap[pkg].name, ver: localMap[pkg].ver,
                desc: "", author: "", api: 1, appUrl: "", metaUrl: "",
                icon: "", changelog: "", size: 0, md5: "", cat: "Apps"
            };
        }
        out.push(it);
    }
    out.sort(function (a, b) {
        var x = a.name.toLowerCase(), y = b.name.toLowerCase();
        return x < y ? -1 : (x > y ? 1 : 0);
    });
    return out;
}

// ---- catalogo ---------------------------------------------------------------
// ---- catalogo ---------------------------------------------------------------
function entryToItem(pkg, e) {
    return {
        id: pkg, pkg: pkg,
        metaUrl: e.meta || "",
        appUrl: e.app || "",
        name: e.name || "",
        desc: e.description || "",
        author: e.author || "Desconhecido",
        ver: e.version || "1.0.0",
        api: e.api || 1,
        cat: e.category || "Apps",
        icon: e.icon || "",
        changelog: e.changelog || "",
        size: e.size || 0,
        md5: e.md5 || "",
        published: e.published_at || "",
        req: e.requires || [],
        files: e.files || null,
        deps: e.deps || null
    };
}

function fillItemFromMeta(it) {
    var m = fetchJSON(it.metaUrl);
    if (!m) return null;
    it.pkg = m.packageName || it.pkg;
    it.name = m.name || it.id;
    it.desc = m.description || "";
    it.author = m.author || "Desconhecido";
    it.ver = m.version || "1.0.0";
    it.api = m.api || 1;
    it.cat = m.category || "Apps";
    it.req = m.requires || it.req || [];
    it.files = m.files || it.files || null;
    it.deps = m.deps || it.deps || null;
    return it;
}

function buildCats() {
    var seen = {};
    cats = ["Todos"];
    for (var i = 0; i < apps.length; i++) {
        var c = apps[i].cat || "Apps";
        if (!seen[c]) { seen[c] = 1; cats.push(c); }
    }
}

function filteredApps() {
    var out = [];
    var q = query.toLowerCase();
    for (var i = 0; i < apps.length; i++) {
        if (curCat !== "Todos" && (apps[i].cat || "Apps") !== curCat) continue;
        if (q && ((apps[i].name || "").toLowerCase().indexOf(q) < 0 &&
                  (apps[i].desc || "").toLowerCase().indexOf(q) < 0)) continue;
        out.push(apps[i]);
    }
    return out;
}

function updApps() {
    var out = [];
    for (var i = 0; i < apps.length; i++) {
        if (stateInfo(apps[i]).code === "upd") out.push(apps[i]);
    }
    return out;
}

function loadCatalog() {
    apps = [];
    curCat = "Todos";
    selIt = null;
    retryMode = "load";

    drawLoading("Baixando catálogo...", "");
    System.delay(30);
    var idx = fetchJSON(INDEX_URL);
    if (!idx || !idx.categories) {
        errMsg = "Falha ao baixar o catálogo";
        errHint = "Verifique a internet.";
        return "err";
    }

    // atalho "Todos" (all.json): todos os apps em 1 request; sem ele (hubs
    // antigos) ou se ele nao couber na RAM (placa sem PSRAM: o JSON inteiro
    // + o parse de uma vez), categoria a categoria — pedacos menores
    var entries = [];
    var catsIdx = idx.categories;
    var gotAll = false;
    if (catsIdx["Todos"]) {
        drawLoading("Baixando catálogo...", "todos os apps");
        System.delay(30);
        var all = fetchJSON(catsIdx["Todos"]);
        // o parse do all.json (~50 KB no Duktape) conta na janela do
        // exec-timeout: cede AQUI, antes do processamento da lista (um
        // trecho so de parse+sort+stringify ja derrubou o app no device)
        System.delay(1);
        if (all && all.apps) {
            gotAll = true;
            for (var pkg in all.apps) {
                if (!all.apps.hasOwnProperty(pkg)) continue;
                if (all.apps[pkg] && all.apps[pkg].app) {
                    entries.push({ pkg: pkg, e: all.apps[pkg] });
                }
            }
        }
        all = null;
    }
    if (!gotAll) {
        var catTotal = 0, catOk = 0;
        for (var cname in catsIdx) {
            if (!catsIdx.hasOwnProperty(cname) || cname === "Todos") continue;
            catTotal++;
            drawLoading("Categoria: " + cname, "");
            System.delay(30);
            var cat = fetchJSON(catsIdx[cname]);
            if (!cat || !cat.apps) continue;
            catOk++;
            for (var id in cat.apps) {
                if (!cat.apps.hasOwnProperty(id)) continue;
                var e = cat.apps[id];
                if (!e || !e.app) continue;
                entries.push({ pkg: id, e: e });
            }
        }
        if (entries.length === 0 && catTotal > 0 && catOk === 0) {
            errMsg = "Falha ao baixar o catálogo";
            errHint = "Verifique a internet.";
            return "err";
        }
    }

    var n = entries.length;
    var seenPkg = {};
    for (var k = 0; k < n; k++) {
        var it = entryToItem(entries[k].pkg, entries[k].e);
        if ((it.api || 1) > API) continue;
        if (!it.name && it.metaUrl) {
            drawLoading("Carregando apps...", (k + 1) + "/" + n);
            System.delay(30);
            it = fillItemFromMeta(it);
            if (!it) continue;
        }
        if (seenPkg[it.pkg]) continue;
        seenPkg[it.pkg] = 1;
        apps.push(it);
    }

    System.delay(1);   // refresh escaneia FS + ordena; cede antes do trecho
    refresh();
    if (apps.length > 0) {
        System.delay(1);   // stringify do catalogo inteiro pro cache
        FS.writeTextFile(CACHE, JSON.stringify(apps));
    }
    return "list";
}

function loadCache() {
    var body = FS.readTextFile(CACHE);
    if (!body) return false;
    var arr = null;
    try { arr = JSON.parse(body); } catch (e) { arr = null; }
    if (!arr || !arr.length) return false;
    apps = arr;
    System.delay(1);   // parse de ~50 KB + refresh sem yield derrubam a janela
    refresh();
    selIt = null;
    return true;
}

// ---- listas -----------------------------------------------------------------
function curList() {
    var key = dataStamp + "|" + curTab + "|" + curCat + "|" + query;
    if (listCache.key === key) return listCache.items;
    var items;
    if (curTab === 0) items = filteredApps();
    else if (curTab === 1) items = updApps();
    else items = installedItems();
    listCache.key = key;
    listCache.items = items;
    return items;
}

// remove o pacote instalado (sem UI de confirmacao — a tela pergunta antes)
function uninstallApp(pkg) {
    var dir = resolveInstalledDir(pkg);
    if (!dir) return false;
    // Storage privado do app (API 12): apaga junto — em firmware antigo o
    // typeof segue undefined e so os arquivos sao removidos
    if (typeof Storage !== "undefined" && Storage.clearFor) { try { Storage.clearFor(pkg); } catch (e) {} }
    if (!FS.removeDirectory(dir)) return false;
    System.rescanApps();
    refresh();
    return true;
}

// ---- UI (toolkit API 22) ------------------------------------------------------
// Barra de abas no topo do canvas (a faixa do sistema fica acima). Frames
// "avulsos" (carregando/baixando) desenham uma tela fora do laco de uma tela:
// o present vem no proximo delay/download.
var LX = 8, LW = 224;
var TABS_Y = 6, TABS_H = 32;
var BODY_Y = 46;

function tabLabels() {
    return ["Loja", updCount > 0 ? "Atualizar " + updCount : "Atualizar", "Instalados"];
}
// abas: devolve true quando a aba mudou (o chamador troca de lista)
function tabsBar() {
    var nt = UI.tabs(LX, TABS_Y, LW, TABS_H, tabLabels(), curTab);
    if (nt !== curTab) {
        curTab = nt;
        selIt = null;
        UI.invalidate();
        return true;
    }
    return false;
}
function frameAlone() {
    UI.invalidate();
    UI.begin(T.bg);
    UI.tabs(LX, TABS_Y, LW, TABS_H, tabLabels(), curTab);
}
function drawLoading(msg, sub) {
    frameAlone();
    UI.spinner(120, 128, 18);
    UI.text(msg, 120, 160, { align: "center", w: LW });
    if (sub) UI.text(sub, 120, 184, { role: "caption", align: "center", color: T.textDim, w: LW });
}

// ---- lista (3 abas) -------------------------------------------------------------
function stateColor(code) {
    if (code === "new") return T.ok;
    if (code === "upd" || code === "api" || code === "hw") return T.warn;
    return T.textDim;
}
function rowOf(it) {
    var st = stateInfo(it);
    var lm = localMap[it.pkg];
    var sub;
    if (curTab === 1) {
        sub = (lm ? "v" + lm.ver : "v?") + " > v" + it.ver + (it.changelog ? "  " + it.changelog.split("\n")[0] : "");
    } else if (curTab === 2) {
        sub = "v" + (lm ? lm.ver : it.ver) + (lm && lm.sd ? " · SD" : "") + (lm && lm.system ? " · sistema" : "");
    } else {
        sub = it.desc || ("v" + it.ver);
    }
    return { label: it.name, sub: sub, right: st.txt, rightColor: stateColor(st.code) };
}
var rowsCache = { key: null, rows: null };
function curRows() {
    var items = curList();
    var key = listCache.key;
    if (rowsCache.key === key) return rowsCache.rows;
    var rows = [];
    for (var i = 0; i < items.length; i++) rows.push(rowOf(items[i]));
    rowsCache.key = key;
    rowsCache.rows = rows;
    return rows;
}
function countLine() {
    if (curTab === 1) {
        return updCount === 0 ? "Nenhuma atualização" :
            updCount + (updCount === 1 ? " atualização disponível" : " atualizações disponíveis");
    }
    var n = 0;
    for (var k in localMap) if (localMap.hasOwnProperty(k)) n++;
    return n + (n === 1 ? " app instalado" : " apps instalados");
}
function screenList() {
    UI.invalidate();
    while (true) {
        UI.begin(T.bg);
        tabsBar();
        var listY = BODY_Y, listH = 228;
        if (curTab === 0) {
            // busca + categoria (a categoria abre um seletor em lista)
            if (UI.button(query ? query + "  x" : "Buscar", LX, BODY_Y, 100, 30,
                          { style: query ? "primary" : "ghost" })) {
                if (query) {
                    query = "";
                } else {
                    var q = System.prompt("Buscar app", "", "");
                    query = (q && String(q).length) ? String(q) : "";
                }
                UI.resetScroll("store0");
                UI.invalidate();
            }
            if (UI.button(curCat, LX + 108, BODY_Y, LW - 108, 30, { style: "ghost" })) return "cats";
            listY = BODY_Y + 38;
            listH = 190;
        } else {
            UI.text(countLine(), 120, BODY_Y + 2, { role: "caption", align: "center",
                    color: (curTab === 1 && updCount) ? T.warn : T.textDim });
            listY = BODY_Y + 22;
            listH = 206;
        }

        var items = curList();
        if (items.length === 0) {
            var msg = curTab === 1 ? "Tudo em dia!" : (curTab === 2 ? "Nenhum app instalado" : "Nenhum app");
            UI.text(msg, 120, listY + 50, { role: "title", align: "center" });
            if (curTab === 1) UI.text("Volte depois para conferir novidades.", 120, listY + 84,
                                      { role: "caption", align: "center", color: T.textDim });
        } else {
            var i = UI.list("store" + curTab, LX, listY, LW, listH, curRows(), { rowH: 50 });
            if (i >= 0) {
                selIt = items[i];
                return "detail";
            }
        }

        // rodape
        if (curTab === 0) {
            if (UI.button("Recarregar catálogo", LX, 282, LW, 34, { style: "ghost" })) {
                return Net.isConnected() ? "load" : "wifi";
            }
        } else if (curTab === 1) {
            if (UI.button("Atualizar tudo", LX, 282, LW, 34, { disabled: updCount === 0 })) return "batch";
        }
        UI.end();
    }
}
// seletor de categoria da Loja
function screenCats() {
    UI.invalidate();
    while (true) {
        UI.begin(T.bg);
        if (UI.header("Categoria", { back: true })) return "list";
        var sel = -1;
        for (var k = 0; k < cats.length; k++) if (cats[k] === curCat) sel = k;
        var i = UI.list("cats", LX, BODY_Y, LW, 312 - BODY_Y, cats, { selected: sel });
        if (i >= 0) {
            curCat = cats[i];
            UI.resetScroll("store0");
            return "list";
        }
        UI.end();
    }
}

// ---- detalhe ----------------------------------------------------------------
function infoRow(label, value, y, col) {
    UI.text(label, 84, y, { role: "caption", color: T.textDim });
    UI.text(String(value), LX + LW - 10, y, { role: "caption", color: col || T.text, align: "right", w: 96 });
}
function doUninstallFlow(it) {
    var lm = localMap[it.pkg];
    if (!lm) return;
    var ok = UI.confirm("Desinstalar", "Remover " + it.name + " do aparelho?", { yes: "Remover", danger: true });
    if (ok && lm.system) {
        ok = UI.confirm("App do sistema", "Confirma remover " + it.name + " definitivamente?",
                        { yes: "Remover", danger: true });
    }
    if (ok && uninstallApp(it.pkg)) {
        UI.toast(it.name + " removido");
        selIt = null;
    }
}
function screenDetail() {
    if (!selIt) return "list";
    UI.invalidate();
    while (true) {
        var full = UI.begin(T.bg);
        var it = selIt;
        var lm = localMap[it.pkg];
        var st = stateInfo(it);
        if (UI.header(it.name, { back: true })) return "list";

        UI.card(LX, BODY_Y, LW, 92);
        if (full) {
            // icone do pacote instalado (cache do sistema) ou inicial
            var ip = lm ? (lm.dir + "/icon.png") : "";
            if (ip && FS.exists(ip) && typeof System.drawIcon === "function") {
                System.drawIcon(ip, 14, BODY_Y + 14);
            } else {
                System.fillGradient(14, BODY_Y + 14, 60, 60, T.accent, T.accentD, 14);
            }
        }
        if (!(lm && FS.exists(lm.dir + "/icon.png"))) {
            UI.text((it.name || "?").substring(0, 1).toUpperCase(), 44, BODY_Y + 30,
                    { role: "display", align: "center", color: T.onAccent, bg: T.accent });
        }
        infoRow("Autor", it.author || "-", BODY_Y + 10);
        infoRow("Instalado", lm ? "v" + (lm.ver || "?") : "não", BODY_Y + 30);
        infoRow("No hub", it.appUrl ? ("v" + it.ver + (it.size ? " · " + fmtKB(it.size) : "") +
                                       (it.deps ? " + deps" : "")) : "-", BODY_Y + 50);
        infoRow("Estado", st.txt, BODY_Y + 70, stateColor(st.code));
        UI.cardEnd();

        // descricao + novidades
        var news = it.changelog && st.code !== "new" && st.code !== "api";
        var y = BODY_Y + 102;
        UI.text("Descrição", LX + 2, y, { role: "caption", color: T.accent });
        y += 18 + UI.text(it.desc || "Sem descrição.", LX + 2, y + 18,
                          { role: "caption", w: LW - 4, lines: news ? 3 : 6 });
        if (news) {
            UI.text("Novidades", LX + 2, y + 6, { role: "caption", color: T.accent });
            UI.text(it.changelog.split("\n")[0], LX + 2, y + 24, { role: "caption", color: T.textDim, w: LW - 4, lines: 3 });
        }

        // acoes
        var by = 272;
        if (it.appUrl && (it.api || 1) > API) {
            UI.text("Requer API " + it.api + " (sistema: " + API + ")", 120, by + 10,
                    { role: "caption", align: "center", color: T.warn });
        } else if (it.appUrl && st.code === "hw") {
            UI.text("Incompatível: requer hardware com PSRAM", 120, by + 4, { role: "caption", align: "center", color: T.warn });
            UI.text("(a RAM interna não basta para este app)", 120, by + 22, { role: "caption", align: "center", color: T.textDim });
        } else if (it.appUrl) {
            var lbl = st.code === "upd" ? "Atualizar" : (st.code === "inst" ? "Reinstalar" : "Instalar");
            if (UI.button(lbl, LX, by, lm ? 108 : LW, 40)) return "install";
            if (lm && UI.button("Desinstalar", LX + 116, by, 108, 40, { style: "danger" })) {
                doUninstallFlow(it);
                if (!selIt) return "list";
            }
        } else if (lm) {
            if (UI.button("Desinstalar", LX, by, LW, 40, { style: "danger" })) {
                doUninstallFlow(it);
                if (!selIt) return "list";
            }
        }
        UI.end();
    }
}

// ---- instalacao / atualizacao ----------------------------------------------
// Progresso INCREMENTAL: drawDownload compoe a tela UMA vez e drawProgress so
// alimenta UI.progress/UI.text — que se redesenham sozinhos quando o valor
// muda (o toolkit compara a assinatura). Um redesenho de tela cheia por KB
// sujava o quadro inteiro e, sem quadro (CYD), piscava o vidro.
function drawDownload(name, sub, withBar) {
    frameAlone();
    UI.text("Baixando " + name + "...", 120, 104, { role: "title", align: "center", w: LW });
    if (sub) UI.text(sub, 120, 136, { role: "caption", align: "center", color: T.textDim });
    if (withBar !== false) UI.progress(LX + 24, 160, LW - 48, 14, 0);
}
// withBar so no download do main.js (unico com callback de progresso)
function drawProgress(got, total) {
    var pct = 0, txt = "";
    if (total > 0) {
        pct = Math.min(100, Math.floor(got * 100 / total));
        txt = pct + "%";
    } else {
        var kb = Math.floor(got / 1024);
        if (kb > 0) {
            pct = Math.min(100, 10 + (kb % 9) * 10);
            txt = kb + " KB";
        }
    }
    UI.progress(LX + 24, 160, LW - 48, 14, pct);
    UI.text(txt, 120, 186, { role: "caption", align: "center", color: T.textDim });
}
function drawBatch(k, n, name) {
    frameAlone();
    UI.text("Atualizando " + k + " de " + n, 120, 104, { role: "title", align: "center" });
    UI.text(name, 120, 136, { align: "center", color: T.textDim, w: LW });
    UI.progress(LX + 24, 166, LW - 48, 14, Math.round((k - 1) * 100 / n));
    UI.text("não feche a loja", 120, 192, { role: "caption", align: "center", color: T.textDim });
}

// Tela de resultado generica: titulo colorido + linhas; botoes Voltar (e
// "Sair agora" quando a propria loja se atualizou)
function screenResult(title, col, lines, selfUpd) {
    UI.invalidate();
    while (true) {
        UI.begin(T.bg);
        UI.text(title, 120, 70, { role: "title", align: "center", color: col, w: LW });
        var y = 108;
        for (var i = 0; i < lines.length; i++) {
            y += UI.text(lines[i].t, 120, y, { role: lines[i].r || "caption", align: "center",
                                               color: lines[i].c || T.textDim, w: LW, lines: 2 }) + 6;
        }
        if (UI.button("Voltar", LX, 272, selfUpd ? 108 : LW, 40, { style: "ghost" })) {
            curTab = 0;
            UI.resetScroll("store0");
            return "list";
        }
        if (selfUpd && UI.button("Sair agora", LX + 116, 272, 108, 40)) System.exitApp();
        UI.end();
    }
}
function screenBatchDone() {
    var lines = [{ t: batchOk + (batchOk === 1 ? " app atualizado" : " apps atualizados") }];
    for (var i = 0; i < batchFails.length && i < 4; i++) lines.push({ t: "falhou: " + batchFails[i], c: T.err });
    if (selfUpdated) lines.push({ t: "A App Store se atualizou: saia e abra de novo", c: T.text, r: "body" });
    return screenResult(batchFails.length === 0 ? "Tudo atualizado!" : "Terminado com falhas",
                        batchFails.length === 0 ? T.ok : T.warn, lines, selfUpdated);
}
function screenDone() {
    var it = selIt;
    if (selfUpdated) {
        return screenResult("App Store atualizada!", T.ok,
                            [{ t: it.name, c: T.text, r: "title" }, { t: "Saia e abra de novo para rodar a v" + it.ver }], true);
    }
    var lm = localMap[it.pkg];
    return screenResult(wasUpdate ? "Atualizado!" : "Instalado!", T.ok,
                        [{ t: it.name, c: T.text, r: "title" },
                         { t: "v" + it.ver + (lm && lm.sd ? " · no cartão SD" : "") },
                         { t: "Pronto no launcher." }], false);
}

// ---- erro / sem WiFi --------------------------------------------------------
function screenErr() {
    UI.invalidate();
    while (true) {
        UI.begin(T.bg);
        UI.text("Erro", 120, 64, { role: "caption", align: "center", color: T.err });
        UI.text(errMsg, 120, 88, { role: "title", align: "center", w: LW, lines: 2 });
        if (errHint) UI.text(errHint, 120, 150, { role: "caption", align: "center", color: T.textDim, w: LW, lines: 3 });
        if (UI.button("Tentar de novo", LX, 220, LW, 40)) return retryMode === "install" ? "install" : "load";
        if (UI.button("Voltar", LX, 270, LW, 40, { style: "ghost" })) return "list";
        UI.end();
    }
}
function screenWifi() {
    UI.invalidate();
    var lastCheck = 0;
    while (true) {
        UI.begin(T.bg);
        UI.text("Wi-Fi desconectado", 120, 104, { role: "title", align: "center", color: T.warn });
        UI.text("Conecte o Wi-Fi para usar a loja de apps. Esta tela segue sozinha quando a rede voltar.",
                120, 140, { role: "caption", align: "center", color: T.textDim, w: LW, lines: 3 });
        UI.spinner(120, 214, 14);
        if (UI.button("Sair", LX, 272, LW, 40, { style: "ghost" })) System.exitApp();
        if (System.millis() - lastCheck > 1500) {
            lastCheck = System.millis();
            if (Net.isConnected()) return "load";
        }
        UI.end();
    }
}

// ---- instalacao (logica) ---------------------------------------------------
// Update in-place: cada arquivo do pacote entra como <pkg>/<nome>.new
// (staging dentro do proprio pacote), MD5 do catalogo conferido POR ARQUIVO
// e o rename em LOTE so depois de 100% dos downloads ok — falha no meio
// apaga os .new e a versao ativa continua a antiga. O pacote pode ter
// modulos .js e assets (campo files do catalogo, hub 0.5.0); no fim,
// arquivos que sairam do pacote sao removidos (update sem o asset nao deixa
// orfao). A pasta alvo e a que o launcher executa (resolveInstalledDir) e
// duplicatas sombreadas do mesmo pkg sao removidas no fim.
function pkgFiles(it) {
    // tudo que vem do hub: main.js + extras do files; icon.png tem tratamento
    // proprio (nao-fatal) e fica fora. Sem files (catalogo antigo) = so main.
    var out = [{ name: "main.js", url: it.appUrl, md5: it.md5 }];
    var base = "";
    if (it.appUrl) base = it.appUrl.substring(0, it.appUrl.lastIndexOf("/") + 1);
    for (var n in (it.files || {})) {
        if (n === "icon.png" || n === "main.js" || n === "app.json") continue;
        out.push({ name: n, url: base + n, md5: (it.files[n] || {}).md5 || "" });
    }
    return out;
}
function pkgTotal(it) {
    var t = it.size || 0;
    for (var n in (it.files || {})) t += (it.files[n] || {}).size || 0;
    return t;
}
function installApp() {
    var it = selIt;
    if (it && stateInfo(it).code === "hw") {
        // incompativel com esta placa: mesmo caminho das falhas de install
        errMsg = "Incompatível com esta placa";
        errHint = "Este app exige hardware com PSRAM (a RAM interna não basta para o runtime dele).";
        return "err";
    }
    retryMode = "install";
    var fail = "";
    wasUpdate = stateInfo(it).code === "upd";
    selfUpdated = false;

    var dir = resolveInstalledDir(it.pkg);
    if (!dir) dir = (installOnSd() ? "/sd/apps" : "/local/apps") + "/" + it.pkg;
    var root = dirName(dir);

    if (!Net.isConnected()) {
        fail = "Sem conexão WiFi";
    } else {
        var need = pkgTotal(it) + 16384;
        var free = 0;
        try { free = FS.getFreeSpace(root); } catch (e) { free = 0; }
        if (free > 0 && free < need) fail = "Sem espaço no disco";
    }

    var json = "";
    if (!fail && it.metaUrl) {
        drawDownload(it.name, "app.json", false);
        System.delay(30);
        json = fetchText(it.metaUrl);
        if (!json) fail = "Erro ao baixar app.json";
    }

    // Deps compartilhadas (API 30): resolve os ranges do app.json baixado
    // contra o indice do hub e alimenta o cache /local/modules ANTES dos
    // arquivos do app — falha no meio so deixa modulo orfao no cache (o GC
    // do launcher recolhe no proximo scan). Deps vivem sempre no /local,
    // mesmo com o app indo para o SD.
    var depIndex = null, depResolved = null;
    if (!fail && json) {
        var wantDeps = null;
        try { wantDeps = JSON.parse(json).deps || null; } catch (e5) { wantDeps = null; }
        if (wantDeps) {
            drawDownload(it.name, "dependências", false);
            System.delay(30);
            var idxTxt = fetchText(HUB_BASE + "/store/deps.json");
            if (idxTxt) { try { depIndex = JSON.parse(idxTxt).deps; } catch (e6) { depIndex = null; } }
            if (!depIndex) fail = "Erro ao baixar dependências";
            if (!fail) {
                depResolved = resolveDeps(wantDeps, depIndex);
                if (!depResolved) fail = "Dependência indisponível no hub";
            }
            if (depResolved) {
                var depBytes = 0, dn;
                for (dn in depResolved) if (depResolved.hasOwnProperty(dn)) {
                    depBytes += (depIndex[dn][depResolved[dn]].size) || 0;
                }
                var freeLocal = 0;
                try { freeLocal = FS.getFreeSpace("/local"); } catch (e7) { freeLocal = 0; }
                if (freeLocal > 0 && freeLocal < depBytes + 8192) fail = "Sem espaço p/ dependências";
            }
        }
    }
    if (!fail && depResolved) fail = installDeps(it, depResolved, depIndex);

    if (!fail && !FS.isDirectory(root) && !FS.mkdir(root)) fail = "Erro no disco";
    if (!fail && !FS.isDirectory(dir) && !FS.mkdir(dir)) fail = "Erro no disco";

    var staged = [];
    if (!fail) {
        var files = pkgFiles(it);
        for (var fi = 0; fi < files.length && !fail; fi++) {
            var fe = files[fi];
            var ftmp = dir + "/" + fe.name + ".new";
            drawDownload(it.name, fe.name);  // chrome+barra uma vez por arquivo
            System.delay(30);
            var okDL = false;
            try {
                okDL = Net.download(fe.url, ftmp, function (got, total) {
                    drawProgress(got, total);  // delta interno decide se desenha
                });
            } catch (e) { okDL = false; }
            if (!okDL) { fail = "Erro ao baixar " + fe.name; break; }
            if (fe.md5) {
                var md = "";
                try { md = FS.getFileMD5(ftmp); } catch (e2) { md = ""; }
                if (md !== fe.md5) {
                    try { FS.deleteFile(ftmp); } catch (e9) {}
                    fail = "Verificação falhou (md5)";
                    break;
                }
            }
            staged.push({ tmp: ftmp, dst: dir + "/" + fe.name });
        }
        if (fail) {
            // nada de meia versao: .new fora e a ativa segue sendo a antiga
            for (var si = 0; si < staged.length; si++) {
                try { FS.deleteFile(staged[si].tmp); } catch (e3) {}
            }
            try { FS.deleteFile(dir + "/main.js.new"); } catch (e4) {}
        }
    }

    if (!fail) {
        for (var ri = 0; ri < staged.length && !fail; ri++) {
            if (!FS.renameFile(staged[ri].tmp, staged[ri].dst))
                fail = "Erro ao gravar " + baseName(staged[ri].dst);
        }
    }
    if (!fail && json && !FS.writeTextFile(dir + "/app.json", json)) {
        fail = "Erro ao gravar app.json";
    }
    // deps resolvidas (a fonte do require no device e do GC do launcher):
    // gravado por ULTIMO — app + cache prontos, este e o commit do conjunto.
    // Update sem deps deixa a limpeza de orfaos abaixo remover o antigo.
    if (!fail && depResolved) {
        var dj = [], dn2;
        for (dn2 in depResolved) if (depResolved.hasOwnProperty(dn2)) {
            dj.push('"' + dn2 + '":"' + depResolved[dn2] + '"');
        }
        if (!FS.writeTextFile(dir + "/deps.json", "{" + dj.join(",") + "}")) {
            fail = "Erro ao gravar deps.json";
        }
    }
    if (!fail) {
        if (it.icon) {
            var iconTmp = dir + "/icon.png.new";
            drawDownload(it.name, "icon.png", false);
            System.delay(30);
            var iconOk = false;
            try { iconOk = Net.download(it.icon, iconTmp); } catch (e5) { iconOk = false; }
            if (iconOk && FS.renameFile(iconTmp, dir + "/icon.png")) {
                // icone novo no lugar; o rescan revalida o cache
            } else {
                try { FS.deleteFile(iconTmp); } catch (e6) {}
            }
        } else if (FS.exists(dir + "/icon.png")) {
            FS.deleteFile(dir + "/icon.png");  // versao nova sem icone
        }
        // orfaos: a pasta e espelho do pacote — update que removeu um
        // modulo/asset (ou .new de tentativa antiga) nao deixa lixo. O
        // deps.json e do INSTALLER (versao resolvida das deps): mantido no
        // update com deps, removido no update sem (o GC libera as versoes).
        try {
            var keep = { "app.json": 1, "main.js": 1, "icon.png": 1 };
            for (var fn in (it.files || {})) keep[fn] = 1;
            if (depResolved) keep["deps.json"] = 1;
            var listing = FS.listDir(dir) || [];
            for (var li = 0; li < listing.length; li++) {
                var p = listing[li];
                if (FS.isDirectory(p)) continue;
                if (!keep[baseName(p)]) FS.deleteFile(p);
            }
        } catch (e7) {}
    }

    if (fail) {
        errMsg = fail;
        errHint = it.name;
        return "err";
    }
    try { removeShadowed(it.pkg, dir); } catch (e8) {}
    System.rescanApps();
    refresh();
    if (it.pkg === STORE_PKG) selfUpdated = true;
    return "done";
}

// "Atualizar tudo": sequencial; a propria loja (self-update) vai por ultimo.
// Guarda ITENS (nao indices): installApp -> refresh() reordena apps[] a cada
// update, e indice guardado viraria ponteiro pro app errado.
function updateAll() {
    var order = [];
    for (var i = 0; i < apps.length; i++) {
        if (stateInfo(apps[i]).code === "upd") order.push(apps[i]);
    }
    order.sort(function (a, b) {
        return (a.pkg === STORE_PKG ? 1 : 0) - (b.pkg === STORE_PKG ? 1 : 0);
    });
    batchOk = 0;
    batchFails = [];
    selfUpdated = false;
    for (var k = 0; k < order.length; k++) {
        selIt = order[k];
        drawBatch(k + 1, order.length, selIt.name);
        System.delay(30);
        errMsg = "";  // installApp so grava no fail: a linha do lote mostra o
        if (installApp() === "done") batchOk++;   // motivo de QUEM falhou
        else batchFails.push(selIt.name +
                             (errMsg ? " (" + errMsg + ")" : ""));
    }
    return "batchDone";
}

function screenBatch() {
    updateAll();
    return "batchDone";
}

// ---- fluxo principal --------------------------------------------------------
// No harness (test/js_harness) nao entra no loop de telas: expoe as funcoes
// puras e de instalacao para os checks de update/self-update.
if (typeof __harness !== "undefined" && __harness.storeTest) {
    __harness.storeTest({
        cmpV: cmpV,
        depRangeOk: depRangeOk,
        resolveDeps: resolveDeps,
        stateInfo: stateInfo,
        scanLocalApps: scanLocalApps,
        resolveInstalledDir: resolveInstalledDir,
        uninstallApp: uninstallApp,
        updateAll: updateAll,
        updCount: function () { return updCount; },
        refresh: refresh,
        setCatalog: function (arr) {
            apps = arr;
            selIt = arr.length ? arr[0] : null;
            refresh();
        },
        catalog: function () { return apps; },
        installApp: installApp,
        fmtKB: fmtKB,
        cats: function () { return cats; },
        setCat: function (c) { curCat = c; },
        filtered: filteredApps,
        installed: installedItems,
        selfUpdatedFlag: function () { return selfUpdated; },
        batchStats: function () { return { ok: batchOk, fails: batchFails }; },
        select: function (pkg) {
            var it = catalogByPkg(pkg);
            if (it) selIt = it;
            return it;
        }
    });
} else {
    var mode = loadCache() ? "list" : (Net.isConnected() ? "load" : "wifi");
    while (true) {
        if (mode === "wifi") mode = screenWifi();
        else if (mode === "load") mode = loadCatalog();
        else if (mode === "err") mode = screenErr();
        else if (mode === "list") mode = screenList();
        else if (mode === "cats") mode = screenCats();
        else if (mode === "detail") mode = screenDetail();
        else if (mode === "install") mode = installApp();
        else if (mode === "done") mode = screenDone();
        else if (mode === "batch") mode = screenBatch();
        else if (mode === "batchDone") mode = screenBatchDone();
        else System.exitApp();  // "exit"
    }
}
