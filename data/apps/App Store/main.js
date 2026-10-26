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
// Instalacao: quando o hub publica it.zip = {url, size, md5} e o firmware
// tem System.installZip (API 42), o pacote inteiro vem em 1 download e a
// pasta e trocada de uma vez; senao, arquivo a arquivo: main.js em
// <pkg>/main.js.new via Net.download (streaming, sem teto de 32KB), MD5 do
// catalogo conferido e rename em lote (app.json incluido) no mesmo FS. A
// pasta alvo e RESOLVIDA por packageName (primeira vista na ordem do
// listDir, mesma regra do launcher) — updates in-place nao criam copias
// sombreadas de apps preinstalados ("App Store" vs celeros.appstore) e as
// duplicatas antigas sao removidas apos o update. X no canto sup. sai.

var INDEX_URL = "https://os.celer.tec.br/store/index.json";
var HUB_BASE = INDEX_URL.substring(0, INDEX_URL.indexOf("/store/"));
// Catalogo compacto (hub >= 0.16): 1 request, 14 campos por linha, sem
// JSON. Resolve o corte de 32 KB do Net.get que forcava 5 categorias na CYD.
var ALL_TXT = HUB_BASE + "/store/all.txt";
// Cache de dependencias compartilhadas (API 30): /local/modules/<nome>/
// <versao>/<nome>.js — escrita permitida a system apps (a loja e uma).
// Compatibilidade de hardware: apps com requires ["psram"] sao bloqueados
// em placa sem PSRAM (badge "Requer PSRAM"). Fallback para catalogo antigo
// sem o campo: teto DINAMICO pela RAM da placa, calibrado na CYD
// (61KB roda, 82KB nao compila -> (appRAM - 60000) * 0,4 = ~66KB).
var HWINFO = System.getInfo ? System.getInfo() : null;
var NO_PSRAM = !!(HWINFO && HWINFO.totalPSRAM === 0);
// so tenta o all.json inteiro (dezenas de KB no heap) quando o PSRAM existe
// de fato; totalPSRAM ausente (firmware antigo) = caminho conservador
var HAS_PSRAM = !!(HWINFO && HWINFO.totalPSRAM > 0);
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
// Token de leitura do hub (apps/deps privados): /local/hub_token.txt, uma
// linha, gravado no provisionamento do device. Sem o arquivo o comportamento
// e o de sempre (so catalogo publico). Net.download nao manda header, entao o
// token vai em ?token= — o hub aceita header ou query. So URLs do NOSSO hub
// recebem o token (nada de vazar credencial para terceiros).
var TOKEN_PATH = "/local/hub_token.txt";
var _hubTok = null;
function hubToken() {
    if (_hubTok === null) {
        _hubTok = "";
        try {
            if (FS.exists(TOKEN_PATH)) {
                var t = FS.readTextFile(TOKEN_PATH) || "";
                t = t.replace(/^\s+/, "").replace(/\s+$/, "");
                if (t) _hubTok = t;
            }
        } catch (e) { _hubTok = ""; }
    }
    return _hubTok;
}
function hubUrl(url) {
    var t = hubToken();
    // So URLs do NOSSO hub (host exato): "https://os.celer.tec.br" como
    // PREFIXO aceitaria "os.celer.tec.br.evil.com" e "os.celer.tec.br@evil"
    // e mandaria o token para terceiros; a barra fecha o host.
    if (!t || !url || String(url).indexOf(HUB_BASE + "/") !== 0) return url;
    return url + (String(url).indexOf("?") >= 0 ? "&" : "?") +
        "token=" + encodeURIComponent(t);
}

function fetchJSON(url) {
    try { return Net.getJSON(hubUrl(url)); } catch (e) { return null; }
}

function fetchText(url) {
    try { return Net.get(hubUrl(url)); } catch (e) { return null; }
}

// texto SEM o teto de 32 KB do Net.get (o deps.json ja passou de 16 KB e
// cresce com a familia; o all.json caiu nesse corte na 2.8.0): baixa em
// arquivo (Net.download streaming, sem teto) e le. null se falhar.
function fetchTextBig(url) {
    if (typeof Net.download !== "function") return fetchText(url);  // API velha
    var tmp = "/local/appstore_fetch.json";
    var ok = false;
    try { ok = Net.download(hubUrl(url), tmp); } catch (e0) { ok = false; }
    if (!ok) { try { FS.deleteFile(tmp); } catch (e1) {} return null; }
    var body = FS.readTextFile(tmp);
    try { FS.deleteFile(tmp); } catch (e2) {}
    return body || null;
}

// {nome: {versao: {url,size,md5,minApi,deps}}} do indice de deps do hub;
// null se falhar (sem rede, corpo truncado, JSON quebrado)
function fetchDepsMap() {
    var body = fetchTextBig(HUB_BASE + "/store/deps.json");
    if (!body) return null;
    var dj = null;
    try { dj = JSON.parse(body); } catch (e) { dj = null; }
    return (dj && dj.deps) ? dj.deps : null;
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
// Gramatica normativa (a MESMA do celerhub.py/servidor/harness; vetor de
// conformidade em test/semver/run.js): "^X.Y.Z" = mesma major e >= base
// (major = breaking; minor/patch sobem sozinhos) ou "X.Y.Z" exata.
// Malformada ("1.2", "v1.0.0", "") NAO satisfaz — o parseInt(||0) antigo
// aceitava "1.2" como "1.2.0" e divergia do PC (familia do bug 2.7.2).
var RE_VER_DEP = /^(\d+)\.(\d+)\.(\d+)$/;
function depRangeOk(rng, ver) {
    rng = String(rng);
    var caret = rng.charAt(0) === "^";
    var R = RE_VER_DEP.exec(caret ? rng.substring(1) : rng);
    var V = RE_VER_DEP.exec(String(ver));
    if (!R || !V) return false;
    if (!caret) return rng === String(ver);
    return +V[1] === +R[1] &&
           (+V[2] > +R[2] || (+V[2] === +R[2] && +V[3] >= +R[3]));
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
// uma passada do fecho: BFS semeando {nome: [ranges]}, re-pick a cada
// visita e arestas do pick corrente na fila; {wanted, picks} ou null
function _passadaDeps(sementes, index) {
    var wanted = {}, seen = {}, queue = [], k, i;
    for (k in sementes) if (sementes.hasOwnProperty(k)) {
        for (i = 0; i < sementes[k].length; i++) queue.push([k, sementes[k][i]]);
    }
    while (queue.length) {
        var pair = queue.shift(), nm = pair[0], rng = String(pair[1]);
        var key = nm + "|" + rng;
        if (seen[key]) continue;
        seen[key] = 1;
        if (!wanted[nm]) wanted[nm] = [];
        wanted[nm].push(rng);
        var escolhida = depPick(nm, wanted[nm], index);
        if (!escolhida) return null;
        var sub = (index[nm][escolhida] && index[nm][escolhida].deps) || {};
        for (k in sub) if (sub.hasOwnProperty(k)) queue.push([k, String(sub[k])]);
    }
    var picks = {};
    for (k in wanted) if (wanted.hasOwnProperty(k)) {
        var p = depPick(k, wanted[k], index);
        if (!p) return null;
        picks[k] = p;
    }
    return { wanted: wanted, picks: picks };
}
// fecho de ponto fixo (mesma receita do celerhub.resolve_dep_ranges): uma
// passada pode SUBIR o pick de um nome no meio do caminho e as arestas do
// pick velho vazavam — sobrava pino de versao que o pick final nem usa e
// FALTAVA modulo que so o pick novo traz (require quebrava em runtime).
// Converge com diretas + arestas dos picks finais ate os ranges que cada
// pick exige serem exatamente os que o limitaram; null se nao converge.
function resolveDeps(want, index) {
    var diretas = {}, k, n2;
    for (k in want) if (want.hasOwnProperty(k)) diretas[k] = String(want[k]);
    var sementes = {};
    for (k in diretas) if (diretas.hasOwnProperty(k)) sementes[k] = [diretas[k]];
    for (var passada = 0; passada < 32; passada++) {
        var r = _passadaDeps(sementes, index);
        if (!r) return null;
        var exigidos = {}, prox = {}, exato = true;
        for (k in r.picks) if (r.picks.hasOwnProperty(k)) {
            var v = r.picks[k];
            var sub = (index[k] && index[k][v] && index[k][v].deps) || {};
            for (var d in sub) if (sub.hasOwnProperty(d)) {
                d = String(d);
                if (!exigidos[d]) exigidos[d] = [];
                if (!prox[d]) prox[d] = [];
                if (exigidos[d].indexOf(String(sub[d])) < 0) exigidos[d].push(String(sub[d]));
                if (prox[d].indexOf(String(sub[d])) < 0) prox[d].push(String(sub[d]));
            }
        }
        var nomes = {};
        for (n2 in r.wanted) if (r.wanted.hasOwnProperty(n2)) nomes[n2] = 1;
        for (n2 in exigidos) if (exigidos.hasOwnProperty(n2)) nomes[n2] = 1;
        for (n2 in nomes) if (nomes.hasOwnProperty(n2)) {
            var base = (exigidos[n2] || []).slice();
            if (diretas[n2] && base.indexOf(diretas[n2]) < 0) base.push(diretas[n2]);
            var tem = (r.wanted[n2] || []).slice();
            if (base.sort().join("|") !== tem.sort().join("|")) { exato = false; break; }
        }
        if (exato) return r.picks;
        sementes = prox;
        for (k in diretas) if (diretas.hasOwnProperty(k)) {
            if (!sementes[k]) sementes[k] = [];
            if (sementes[k].indexOf(diretas[k]) < 0) sementes[k].push(diretas[k]);
        }
    }
    return null;
}
// alimenta o cache /local/modules/<nome>/<versao>/ com o que falta — mesmo
// contrato dos arquivos do app: download streaming, MD5, .new + rename
function installDeps(it, resolved, index) {
    for (var nm in resolved) if (resolved.hasOwnProperty(nm)) {
        var ver = resolved[nm];
        var d = index[nm][ver];
        var dir = "/local/modules/" + nm + "/" + ver;
        var dst = dir + "/" + nm + ".js";
        if (FS.exists(dst)) {
            // ja no cache — mas confere o TAMANHO contra o indice antes de
            // pular: um modulo trunco/lixo no cache (push antigo, disco cheio
            // no meio da escrita) persistia calado e quebrava todo app que o
            // require. Tamanho divergente = baixa de novo.
            var cacheSz = -1;
            try { cacheSz = FS.getFileSize(dst); } catch (eSz) { cacheSz = -1; }
            if (!d.size || cacheSz === d.size) continue;
        }
        if (d.minApi && d.minApi > API) return nm + " exige API " + d.minApi;
        if (!FS.isDirectory("/local/modules") && !FS.mkdir("/local/modules")) return "Erro no disco";
        if (!FS.isDirectory("/local/modules/" + nm) && !FS.mkdir("/local/modules/" + nm)) return "Erro no disco";
        if (!FS.isDirectory(dir) && !FS.mkdir(dir)) return "Erro no disco";
        drawDownload(it.name, nm + " " + ver);
        System.delay(30);
        var tmp = dir + "/" + nm + ".js.new";
        var ok = false;
        try {
            ok = Net.download(hubUrl(d.url), tmp, function (got, total) { drawProgress(got, total); });
        } catch (e) { ok = false; }
        if (!ok) { try { FS.deleteFile(tmp); } catch (e9) {} return "Erro ao baixar " + nm; }
        var md = "";
        try { md = FS.getFileMD5(tmp); } catch (e2) { md = ""; }
        if (d.md5 && md !== d.md5) {
            try { FS.deleteFile(tmp); } catch (e3) {}
            return "Verificação falhou (" + nm + ")";
        }
        if (!FS.renameFile(tmp, dst)) {
            try { FS.deleteFile(tmp); } catch (e8) {}  // nao deixa .new orfao
            return "Erro ao gravar " + nm;
        }
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
var depIndex = null;   // indice /store/deps.json do load (deteccao de engine)
var depUpd = {};       // pkg -> {names, resolved, have}: deps do hub mais novas
var catWarn = "";      // catalogo parcial: categoria(s) que nao carregaram no load
var lowSpace = false;  // /local apertado durante o load (muda a dica do erro)

// livre em /local abaixo do piso? firmware sem FS.getFreeSpace (ou SD) segue
// o comportamento de sempre (false) — o cheque e otimizacao, nao dependencia
function freeSpaceLow(min) {
    var f = 0;
    try { f = FS.getFreeSpace("/local"); } catch (e) { return false; }
    return f > 0 && f < min;
}

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

// estado do app vs instalado: "new" | "upd" | "inst" | "api" | "dep" | "hw"
function stateInfo(it) {
    var loc = localMap[it.pkg];
    if ((it.api || 1) > API) return { code: "api", txt: "API " + it.api, col: T.warn };
    if (NO_PSRAM && needsPsram(it)) return { code: "hw", txt: "Requer PSRAM", col: T.warn };
    if (!loc) return { code: "new", txt: "Novo", col: T.ok };
    // so oferece update se o hub for MAIS NOVO: versao local mais nova (dev,
    // imagem da flash a frente do hub) nao pode virar "Atualizar" (downgrade)
    if (cmpV(it.ver, loc.ver) <= 0) {
        // engine desatualizada (2.9.0): versao do app em dia, mas o range das
        // deps resolve mais novo no hub do que o deps.json congelou no install
        if (depUpd[it.pkg]) return { code: "dep", txt: "Engine", col: T.warn };
        return { code: "inst", txt: "Instalado", col: T.textDim };
    }
    return { code: "upd", txt: "Atualizar", col: T.warn };
}

function countUpdates() {
    updCount = 0;
    for (var i = 0; i < apps.length; i++) {
        var c = stateInfo(apps[i]).code;
        if (c === "upd" || c === "dep") updCount++;
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
        apps[i]._u = (stateInfo(apps[i]).code === "upd" ||
                      stateInfo(apps[i]).code === "dep") ? 0 : 1;
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
    scanDepUpdates();
    countUpdates();
    sortByUpdate();
    buildCats();
    dataStamp++;  // invalida os caches de lista/chips (curList/chipsGeom)
}

// indice de deps do hub (deteccao de update de engine, 2.9.0): best-effort —
// sem ele a loja funciona, so nao promove "Engine" na aba Atualizar.
function fetchDepIndex() {
    depIndex = null;
    if (!Net.isConnected()) return;
    var d = null;
    try { d = fetchDepsMap(); } catch (eD) { d = null; }
    if (d) depIndex = d;
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
        nfiles: e.nfiles || 0,   // multi-arquivo no catalogo compacto
        deps: e.deps || null,
        zip: e.zip || null      // {url, size, md5} quando o hub serve o pacote
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
    it.changelog = m.changelog || it.changelog || "";
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
        var c = stateInfo(apps[i]).code;
        if (c === "upd" || c === "dep") out.push(apps[i]);
    }
    return out;
}

// Catalogo compacto: /store/all.txt, 14 campos por linha (pkg, nome,
// versao, api, categoria, size, md5, requires, deps, zip_md5, zip_size,
// icon, nfiles, changelog). O rodape "#end N" detecta truncamento do
// Net.get (32 KB sem PSRAM); qualquer falha cai no caminho JSON de sempre.
function parseDepsField(s) {
    if (!s) return null;
    var out = {}, parts = String(s).split(";");
    for (var i = 0; i < parts.length; i++) {
        var kv = parts[i].split("=");
        if (kv.length === 2 && kv[0] && kv[1]) out[kv[0]] = kv[1];
    }
    return out;
}

function parseCompactCatalog(body) {
    if (!body) return null;
    var lines = String(body).split("\n");
    if (lines.length < 3) return null;
    if (lines[0].indexOf("#pkg\tname\tversion\tapi\tcategory") !== 0) return null;
    var last = lines[lines.length - 1];
    if (last.indexOf("#end\t") !== 0) return null;
    var expect = parseInt(last.substring(5), 10);
    if (!(expect >= 0)) return null;
    var out = [];
    for (var i = 1; i < lines.length - 1; i++) {
        var ln = lines[i];
        if (!ln || ln.charAt(0) === "#") continue;
        var f = ln.split("\t");
        if (f.length < 14 || !f[0]) continue;
        var pkg = f[0];
        var e = {
            meta: HUB_BASE + "/store/apps/" + pkg + "/app.json",
            app: HUB_BASE + "/store/apps/" + pkg + "/main.js",
            name: f[1],
            version: f[2],
            api: parseInt(f[3], 10) || 1,
            category: f[4] || "Apps",
            size: parseInt(f[5], 10) || 0,
            md5: f[6],
            requires: f[7] ? f[7].split(",") : [],
            deps: parseDepsField(f[8]),
            changelog: f[13] || ""
        };
        if (f[9]) {
            e.zip = { url: HUB_BASE + "/store/apps/" + pkg + "/app.zip",
                      md5: f[9], size: parseInt(f[10], 10) || 0 };
        }
        if (f[11] === "1") e.icon = HUB_BASE + "/store/apps/" + pkg + "/icon.png";
        var nfiles = parseInt(f[12], 10) || 0;
        if (nfiles > 0) e.nfiles = nfiles;  // multi-arquivo: files vem do meta
        out.push({ pkg: pkg, e: e });
    }
    if (out.length !== expect) return null;  // truncou no meio
    return out;
}

function loadCatalog() {
    apps = [];
    curCat = "Todos";
    selIt = null;
    retryMode = "load";
    catWarn = "";
    lowSpace = false;

    drawLoading("Baixando catálogo...", "");
    System.delay(30);
    var idx = fetchJSON(INDEX_URL);
    if (!idx || !idx.categories) {
        errMsg = "Falha ao baixar o catálogo";
        errHint = "Verifique a internet.";
        return "err";
    }
    fetchDepIndex();

    // atalho "Todos" (all.json): todos os apps em 1 request. O hub de hoje
    // publica ~58 KB e o Net.getJSON CORTA em 32 KB (JSON.parse quebrado ->
    // fetch nulo): o atalho nunca funcionava e o download truncado era pago
    // em todo load. No PSRAM ele vai por Net.download + leitura do FS (sem
    // teto, 1 request em vez de 5 categorias); sem PSRAM (ou total
    // desconhecido) vai direto nas categorias, pedacos menores.
    var entries = [];
    var catsIdx = idx.categories;
    var gotAll = false;

    // Compacto primeiro: 1 request, ~10-20 KB (cabe no teto de 32 KB do
    // Net.get) e sem JSON.parse. Hub antigo (404) ou truncamento cai no
    // caminho all.json/categorias abaixo, sem regressao.
    drawLoading("Baixando catálogo...", "todos os apps");
    System.delay(30);
    var compact = parseCompactCatalog(fetchText(ALL_TXT));
    if (compact) { entries = compact; gotAll = true; }
    compact = null;

    if (!gotAll && catsIdx["Todos"] && HAS_PSRAM) {
        // 2.9.1: o caminho do all.json custa ~2x o catalogo de /local (o
        // download e o cache reescrito no fim). /local apertado (a bancada
        // vive com <200 KB) derruba a escrita no meio, o load murcha para as
        // categorias sem dizer por que e o arcade (>32 KB) some da lista: o
        // cache velho (~1x catalogo) sai na frente — ele e reescrito no fim.
        lowSpace = freeSpaceLow(200 * 1024);
        if (lowSpace) {
            try { FS.deleteFile(CACHE); } catch (eS0) {}
            lowSpace = freeSpaceLow(128 * 1024);   // ainda apertado sem o cache
        }
        drawLoading("Baixando catálogo...", "todos os apps");
        System.delay(30);
        var allPath = "/local/appstore_all.json";
        var all = null;
        var allOk = false;
        try { allOk = Net.download(hubUrl(catsIdx["Todos"]), allPath); } catch (eA) { allOk = false; }
        if (allOk) {
            var body = FS.readTextFile(allPath);
            try { FS.deleteFile(allPath); } catch (eB) {}
            // o parse do all.json (~58 KB no Duktape) conta na janela do
            // exec-timeout: cede AQUI, antes do processamento da lista (um
            // trecho so de parse+sort+stringify ja derrubou o app no device)
            System.delay(1);
            if (body) { try { all = JSON.parse(body); } catch (eC) { all = null; } }
        } else {
            try { FS.deleteFile(allPath); } catch (eD) {}
        }
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
        var catTotal = 0, catOk = 0, catFail = [];
        for (var cname in catsIdx) {
            if (!catsIdx.hasOwnProperty(cname) || cname === "Todos") continue;
            catTotal++;
            drawLoading("Categoria: " + cname, "");
            System.delay(30);
            var cat = fetchJSON(catsIdx[cname]);
            if (!cat || !cat.apps) { catFail.push(cname); continue; }
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
            errHint = lowSpace
                ? "Pouco espaço livre em /local (desinstale apps) ou sem internet."
                : "Verifique a internet.";
            return "err";
        }
        if (catFail.length > 0) {
            // Net.get/getJSON truncam em 32 KB (NET_MAX_BODY): categoria que
            // cresceu demais (arcade ja passou) volta quebrada e sumiria da
            // lista sem erro nenhum. Aviso na lista > app desaparecido.
            catWarn = "Catálogo incompleto, não carregou: " + catFail.join(", ") +
                      (lowSpace ? " (espaço em /local baixo)" : "") + ".";
        }
    }

    var n = entries.length;
    var seenPkg = {};
    for (var k = 0; k < n; k++) {
        var it = entryToItem(entries[k].pkg, entries[k].e);
        // app que exige API futura ENTRA na lista com o estado "API": o
        // detalhe explica que o firmware precisa atualizar. Filtrar aqui
        // escondia o app e o dono nunca sabia por que ele nao aparecia.
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
        // 2.9.1: o writeTextFile atomico so falha sem espaco (o cache velho
        // fica), mas o .tmp abortado comeria o poco que resta — so escreve
        // com folga conhecida; sem o cheque do firmware, escreve como sempre
        var blob = JSON.stringify(apps);
        var fCache = 0;
        try { fCache = FS.getFreeSpace("/local"); } catch (eS1) { fCache = 0; }
        if (fCache <= 0 || fCache > blob.length + 16384) {
            FS.writeTextFile(CACHE, blob);
        }
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
    fetchDepIndex();     // engine: o cache do catalogo nao traz o indice
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
    if (code === "upd" || code === "dep" || code === "api" || code === "hw") return T.warn;
    return T.textDim;
}
function rowOf(it) {
    var st = stateInfo(it);
    var lm = localMap[it.pkg];
    var sub;
    if (curTab === 1) {
        var du = depUpd[it.pkg];
        if (du) {
            sub = "engine " + du.names[0] + " " + (du.have[du.names[0]] || "?") +
                  " > " + du.resolved[du.names[0]] +
                  (du.names.length > 1 ? "  (+" + (du.names.length - 1) + ")" : "");
        } else {
            sub = (lm ? "v" + lm.ver : "v?") + " > v" + it.ver + (it.changelog ? "  " + it.changelog.split("\n")[0] : "");
        }
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
            if (catWarn) {
                UI.text(catWarn, 120, BODY_Y + 40, { role: "caption", align: "center", color: T.warn });
                listY = BODY_Y + 62;
                listH = 166;
            }
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
                // catalogo compacto nao traz descricao/autor: busca o
                // app.json no primeiro toque (1 request por app visto)
                if (!selIt.desc && selIt.metaUrl) fillItemFromMeta(selIt);
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
        } else {
            // 2.9.3: escolha do destino de instalacao. A mesma preferencia do
            // Settings (install_sd no NVS); installOnSd() roda no ato do
            // install, entao virar a chave aqui basta. Firmware sem escrita
            // de setting cai no arquivo legado. Sem cartao, o rotulo avisa.
            var sdOn = installOnSd();
            var noSd = null;   // null = firmware sem o cheque de espaco
            try { noSd = FS.getFreeSpace("/sd") <= 0; } catch (eSD) { noSd = null; }
            if (UI.button("Instalar no: " + (sdOn ? "cartao SD" : "memoria interna") +
                          (sdOn && noSd ? " (sem cartao!)" : ""),
                          LX, 282, LW, 34, { style: "ghost" })) {
                var want = sdOn ? "0" : "1";
                var wrote = false;
                if (System.setting) {
                    try { wrote = System.setting("install_sd", want); } catch (eS2) { wrote = false; }
                }
                if (!wrote) {   // firmware antigo: o arquivo legado cobre
                    if (want === "1") FS.writeTextFile(FLAG_SD, "1");
                    else { try { FS.deleteFile(FLAG_SD); } catch (eS3) {} }
                }
                UI.invalidate();
            }
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
            var lbl = st.code === "upd" ? "Atualizar"
                    : (st.code === "dep" ? "Atualizar engine"
                    : (st.code === "inst" ? "Reinstalar" : "Instalar"));
            if (UI.button(lbl, LX, by, lm ? 108 : LW, 40)) {
                return st.code === "dep" ? "deps" : "install";
            }
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
// bytes da copia instalada: o update mantem a antiga no disco enquanto
// baixa a nova (.new) — o pico e a soma das duas
function installedBytes(dir) {
    var total = 0;
    try {
        var list = FS.listDir(dir) || [];
        for (var i = 0; i < list.length; i++) {
            if (FS.isDirectory(list[i])) continue;  // pacotes sao flat
            total += FS.getFileSize(list[i]) || 0;
        }
    } catch (e) { total = 0; }
    return total;
}
// Pacote unico (API 42): o hub publica it.zip = {url, size, md5} quando o
// servidor ja serve o app.zip. Exige checksum E o System.installZip do
// firmware: qualquer ausencia cai no caminho por arquivo.
function zipInfo(it) {
    if (!it || !it.zip || !it.zip.url || !it.zip.md5) return null;
    if (typeof System.installZip !== "function") return null;
    return it.zip;
}
function zipNameOk(n) {
    n = String(n || "");
    return n.length > 0 && n.length <= 40 && n.indexOf("/") < 0 && n.indexOf("..") < 0;
}
function writeDepsFile(dir, resolved) {
    var dj = [], dn;
    for (dn in resolved) if (resolved.hasOwnProperty(dn)) {
        dj.push('"' + dn + '":"' + resolved[dn] + '"');
    }
    return FS.writeTextFile(dir + "/deps.json", "{" + dj.join(",") + "}");
}

// ---- atualizacao de engine (2.9.0) -----------------------------------------
// O deps.json gravado no install CONGELA as versoes resolvidas: quando o hub
// publica minor/patch novo dentro do range, o app instalado nao ficava
// sabendo. scanDepUpdates compara o congelado contra o indice do load e o
// stateInfo expoe "dep" (a versao do app em si esta em dia). O update baixa
// so as versoes novas pro cache /local/modules (o GC do launcher recolhe as
// orfas) e regrava o deps.json — o app nem e reinstalado.
function installedDeps(dir) {
    var body = "";
    try { body = FS.readTextFile(dir + "/deps.json"); } catch (e1) { return null; }
    if (!body) return null;
    try { return JSON.parse(body); } catch (e2) { return null; }
}
function scanDepUpdates() {
    depUpd = {};
    if (!depIndex) return;
    System.delay(1);  // leituras de FS + resolve: cede a janela do exec-timeout
    for (var pkg in localMap) {
        if (!localMap.hasOwnProperty(pkg)) continue;
        var it = catalogByPkg(pkg);
        if (!it || !it.deps) continue;  // sem deps declaradas = nada a promover
        var have = installedDeps(localMap[pkg].dir);
        if (!have) continue;  // vendoring/install pre-deps: o update do app resolve
        var fresh = resolveDeps(it.deps, depIndex);
        if (!fresh) continue;  // hub sem versao que satisfaca: estado "inst"
        var names = [], nm;
        for (nm in fresh) if (fresh.hasOwnProperty(nm)) {
            if (String(have[nm] || "") !== fresh[nm]) names.push(nm);
        }
        if (names.length) {
            names.sort();
            depUpd[pkg] = { names: names, resolved: fresh, have: have };
        }
    }
}
function updateDepsFlow() {
    var it = selIt;
    errMsg = ""; errHint = "";
    retryMode = "install";
    wasUpdate = true;   // tela de resultado: "Atualizado!"
    selfUpdated = false;
    if (!Net.isConnected()) { errMsg = "Sem conexão WiFi"; return "err"; }
    drawDownload(it.name, "dependências", false);
    System.delay(30);
    // resolucao FRESCA contra o indice do hub: o snapshot do scanDepUpdates
    // pode ter ficado para tras enquanto a loja ficou aberta
    var index = fetchDepsMap();
    if (!index) { errMsg = "Erro ao baixar dependências"; errHint = it.name; return "err"; }
    var resolved = resolveDeps(it.deps || {}, index);
    if (!resolved) { errMsg = "Dependência indisponível no hub"; errHint = it.name; return "err"; }
    var depBytes = 0, nm;
    for (nm in resolved) if (resolved.hasOwnProperty(nm)) {
        depBytes += (index[nm][resolved[nm]].size) || 0;
    }
    var freeLocal = 0;
    try { freeLocal = FS.getFreeSpace("/local"); } catch (e2) { freeLocal = 0; }
    if (freeLocal > 0 && freeLocal < depBytes + 8192) { errMsg = "Sem espaço p/ dependências"; return "err"; }
    var fail = installDeps(it, resolved, index);  // pula o que ja esta no cache
    if (fail) { errMsg = fail; errHint = it.name; return "err"; }
    var dir = localMap[it.pkg] ? localMap[it.pkg].dir : resolveInstalledDir(it.pkg);
    if (!dir || !writeDepsFile(dir, resolved)) {
        errMsg = "Erro ao gravar deps.json"; errHint = it.name; return "err";
    }
    System.rescanApps();
    refresh();
    return "done";
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
    var zip = zipInfo(it);

    if (!Net.isConnected()) {
        fail = "Sem conexão WiFi";
    } else {
        // update: a copia ativa continua no disco enquanto a nova e baixada
        var need = pkgTotal(it) + 16384;
        if (zip) need += (zip.size || 0) + 8192;
        if (FS.isDirectory(dir)) need += installedBytes(dir);
        var free = 0;
        try { free = FS.getFreeSpace(root); } catch (e) { free = 0; }
        if (free > 0 && free < need) fail = "Sem espaço no disco";
    }

    var json = "", meta = null;
    if (!fail && it.metaUrl) {
        drawDownload(it.name, "app.json", false);
        System.delay(30);
        json = fetchText(it.metaUrl);
        if (!json) fail = "Erro ao baixar app.json";
        else { try { meta = JSON.parse(json); } catch (e5) { meta = null; } }
    }

    // Catalogo compacto nao traz files/requires: o app.json e a fonte deles
    // no install. Multi-arquivo sem o meta = falha clara (nunca instalar so
    // o main.js e deixar o app quebrado). O espaco e rechecado com os extras.
    if (!fail && meta) {
        var hadFiles = !!it.files;
        if (!hadFiles && meta.files) it.files = meta.files;
        if ((!it.req || !it.req.length) && meta.requires) it.req = meta.requires;
        if (!hadFiles && it.files && free > 0) {
            var extraBytes = 0, en;
            for (en in it.files) if (it.files.hasOwnProperty(en)) {
                extraBytes += (it.files[en] || {}).size || 0;
            }
            if (free < need + extraBytes) fail = "Sem espaço no disco";
        }
        if (it.nfiles > 0 && !it.files) fail = "Erro ao ler app.json";
    }

    // Deps compartilhadas (API 30): resolve os ranges do app.json baixado
    // contra o indice do hub e alimenta o cache /local/modules ANTES dos
    // arquivos do app — falha no meio so deixa modulo orfao no cache (o GC
    // do launcher recolhe no proximo scan). Deps vivem sempre no /local,
    // mesmo com o app indo para o SD.
    var depIndex = null, depResolved = null;
    if (!fail && meta) {
        var wantDeps = meta.deps || null;
        if (wantDeps) {
            drawDownload(it.name, "dependências", false);
            System.delay(30);
            depIndex = fetchDepsMap();
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

    // Pacote unico (API 42): 1 download + System.installZip troca
    // /local/apps/<nome> inteiro (atomico: falha mantem a versao antiga).
    // So no /local (o installZip nao escreve no SD), com nome valido e
    // livre; o caminho por arquivo segue como fallback (firmware antigo,
    // zip corrompido ou nome ocupado por outro pacote).
    if (!fail && zip && !installOnSd() && dir.indexOf("/local/apps/") === 0 &&
        zipNameOk(it.name)) {
        var zdir = "/local/apps/" + it.name;
        var zBusy = false;
        if (FS.isDirectory(zdir)) {
            var zj = null;
            try { zj = JSON.parse(FS.readTextFile(zdir + "/app.json")); } catch (e0) { zj = null; }
            zBusy = !!(zj && zj.packageName && zj.packageName !== it.pkg);
        }
        if (!zBusy) {
            var zpath = "/local/appstore_install.zip";
            drawDownload(it.name, "pacote", true);
            System.delay(30);
            var zok = false;
            try {
                zok = Net.download(hubUrl(zip.url), zpath, function (got, total) {
                    drawProgress(got, total);
                });
            } catch (e1) { zok = false; }
            var zmd = "";
            if (zok) { try { zmd = FS.getFileMD5(zpath); } catch (e2) { zmd = ""; } }
            if (zok && zmd === zip.md5) {
                var zres = null;
                try { zres = System.installZip(zpath, it.name); } catch (e3) { zres = null; }
                try { FS.deleteFile(zpath); } catch (e4) {}
                if (zres && zres.ok) {
                    if (depResolved && !writeDepsFile(zdir, depResolved)) {
                        errMsg = "Erro ao gravar deps.json";
                        errHint = it.name;
                        return "err";
                    }
                    try { removeShadowed(it.pkg, zdir); } catch (e5) {}
                    System.rescanApps();
                    refresh();
                    if (it.pkg === STORE_PKG) selfUpdated = true;
                    return "done";
                }
                // installZip recusou: limpa o staging que ele possa ter deixado
                try { FS.removeDirectory(zdir + ".new"); } catch (e6) {}
            } else {
                try { FS.deleteFile(zpath); } catch (e7) {}
            }
        }
    }

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
                okDL = Net.download(hubUrl(fe.url), ftmp, function (got, total) {
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
        // app.json entra no MESMO lote: a versao nova so aparece no disco
        // junto com os arquivos (o rename dele vem por ultimo)
        if (!fail && json) {
            var jtmp = dir + "/app.json.new";
            if (!FS.writeTextFile(jtmp, json)) fail = "Erro ao gravar app.json";
            else staged.push({ tmp: jtmp, dst: dir + "/app.json" });
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
    // deps resolvidas (a fonte do require no device e do GC do launcher):
    // gravado por ULTIMO — app + cache prontos, este e o commit do conjunto.
    // Update sem deps deixa a limpeza de orfaos abaixo remover o antigo.
    if (!fail && depResolved && !writeDepsFile(dir, depResolved)) {
        fail = "Erro ao gravar deps.json";
    }
    if (!fail) {
        if (it.icon) {
            var iconTmp = dir + "/icon.png.new";
            drawDownload(it.name, "icon.png", false);
            System.delay(30);
            var iconOk = false;
            try { iconOk = Net.download(hubUrl(it.icon), iconTmp); } catch (e5) { iconOk = false; }
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
        var c = stateInfo(apps[i]).code;
        if (c === "upd" || c === "dep") order.push(apps[i]);
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
        var r = stateInfo(selIt).code === "dep" ? updateDepsFlow() : installApp();
        if (r === "done") batchOk++;   // motivo de QUEM falhou
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
        hubUrl: hubUrl,
        hubToken: hubToken,
        resetToken: function () { _hubTok = null; },
        fetchText: fetchText,
        stateInfo: stateInfo,
        scanLocalApps: scanLocalApps,
        resolveInstalledDir: resolveInstalledDir,
        uninstallApp: uninstallApp,
        updateAll: updateAll,
        setDepIndex: function (idx) { depIndex = idx; },
        depUpdates: function () { return depUpd; },
        updateDepsFlow: updateDepsFlow,
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
        parseCompactCatalog: parseCompactCatalog,
        parseDepsField: parseDepsField,
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
        else if (mode === "deps") mode = updateDepsFlow();
        else if (mode === "done") mode = screenDone();
        else if (mode === "batch") mode = screenBatch();
        else if (mode === "batchDone") mode = screenBatchDone();
        else System.exitApp();  // "exit"
    }
}
