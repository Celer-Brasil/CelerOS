// store.js - motor da App Store SEM UI (API 50).
//
// O main.js (vidro) e o service.js (rodada automatica da madrugada) carregam
// ESTE arquivo com require("store"): nada aqui toca UI, present() ou o kit -
// o svchost nao tem vidro. O que mora aqui e o que os dois caminhos tem que
// ver IGUAL: gramatica de versao/range (a mesma do hub e do celerctl, ver
// test/semver/run.js), fecho de deps compartilhadas, cache /local/modules,
// leitura dos apps instalados, token do hub e a trava de versao do usuario.
//
// A atualizacao automatica instala pelo app.zip do hub (System.installZip,
// API 42): 1 blob conferido por MD5, rescan nativo do launcher e a pasta
// trocada de uma vez. O app no cartao SD fica de fora (installZip escreve so
// em /local/apps) e o main.js segue com o caminho por arquivo, que e o que
// funciona na CYD apertada.
//
// Pins e o liga/desliga da rotina ficam em /local/appstore_auto.json
// ({auto, hour, pins}) - arquivo e nao NVS porque o usuario/aparelho pode
// inspecionar (celerctl pull) e porque o service e o app tem que ler o mesmo.

var HUB = "https://os.celer.tec.br";
var TOKEN_PATH = "/local/hub_token.txt";
var CFG_PATH = "/local/appstore_auto.json";
var SELF_PKG = "celeros.appstore";
var MAX_APPS = 40;

// ---- utilidades ------------------------------------------------------------
function bn(p) { var i = String(p).lastIndexOf("/"); return i >= 0 ? String(p).substring(i + 1) : String(p); }
function fk(n) { if (!n || n <= 0) return ""; if (n < 1024) return n + " B";
    var k = Math.round(n / 102.4) / 10; return (k % 1 ? k : k.toFixed(0)) + " KB"; }
function K(o) { var n = 0, k; for (k in (o || {})) if (o.hasOwnProperty(k)) n++; return n; }
function D(p) { try { FS.deleteFile(p); } catch (e) {} }
function M(p) { var m = ""; try { m = FS.getFileMD5(p); } catch (e) { m = ""; } return m; }
function MK(p) { if (FS.isDirectory(p)) return true; return FS.mkdir(p); }
// cedencia de CPU: no app renova a janela do exec-timeout e pinta o frame;
// no servico System.delay NAO existe (o pump e do svchost).
function pump() { try { if (typeof System.delay === "function") System.delay(1); } catch (e) {} }
function apiLevel() { try { return Number(System.getAPILevel()) || 0; } catch (e) { return 0; } }
function hasPs() { try { var i = System.getInfo(); return !!(i && i.totalPSRAM > 0); } catch (e) { return false; } }
function readText(p) { try { return String(FS.readTextFile(p) || ""); } catch (e) { return ""; } }

// ---- token do hub ----------------------------------------------------------
// So URLs do NOSSO hub (host exato) recebem ?token= - prefixo vazaria para
// os.celer.tec.br.evil.com (2.9.5).
var _T = null;
function hubToken() { if (_T === null) { _T = ""; var t = readText(TOKEN_PATH);
        t = t.replace(/^\s+/, "").replace(/\s+$/, ""); if (t) _T = t; } return _T; }
function resetToken() { _T = null; }
function hubUrl(u) { var t = hubToken(); if (!t || !u || String(u).indexOf(HUB + "/") !== 0) return u;
    return u + (String(u).indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(t); }

// ---- transporte ------------------------------------------------------------
// App: Net.get/Net.getJSON (API 3). Servico: Net.request (API 50, unico que o
// svchost expoe). Os DOIS passam pelo token e devolvem null em erro.
function fetchText(u) {
    var x = hubUrl(u);
    try { if (typeof Net.get === "function") return Net.get(x); } catch (e) { return null; }
    try { if (typeof Net.request === "function") { var r = Net.request({ url: x, method: "GET", timeoutMs: 8000 });
        if (r && r.status === 200 && r.body) return r.body; } } catch (e2) {}
    return null;
}
function fetchJson(u) {
    var x = hubUrl(u);
    try { if (typeof Net.getJSON === "function") { var j = Net.getJSON(x); if (j) return j; } } catch (e) {}
    try { if (typeof Net.request === "function") { var r = Net.request({ url: x, method: "GET", timeoutMs: 8000 });
        if (r && r.status === 200 && r.body) return JSON.parse(String(r.body)); } } catch (e2) {}
    return null;
}
function N(u, p, cb) { var ok = false; try { ok = Net.download(hubUrl(u), p, cb); } catch (e) { ok = false; } return ok; }

// ---- indice de deps (/store/deps.json) -------------------------------------
// 16 KB e crescendo: vem por get/request, nunca por download streaming (o
// JSON quebrado em 32 KB fazia todo install com deps falhar - 2.9.2).
function depsIndex() { var b = fetchText(HUB + "/store/deps.json"); if (!b) return null;
    var t = String(b).replace(/\s+$/, ""); if (t.charAt(t.length - 1) !== "}") return null; var d = null;
    try { d = JSON.parse(t); } catch (e) { d = null; } return (d && d.deps) ? d.deps : null; }

// ---- catalogo compacto (/store/all.txt) ------------------------------------
// TSV: 14 campos e rodape "#end N". A contagem no rodape e o detector de
// truncamento (get/request cortam em 32 KB): N diferente de linhas = null e o
// chamador cai no caminho por app.
function parseDepsField(s) { if (!s) return null; var o = {}, p = String(s).split(";"), i, k; for (i = 0; i < p.length; i++) { k = p[i].split("=");
        if (k[1]) o[k[0]] = k[1]; } return o; }
function parseCompactCatalog(b) { if (!b) return null; var l = String(b).split("\n"), i, f, e, o = [];
    if (l.length < 3 || l[0].indexOf("#pkg\tname\tversion\tapi\tcategory") !== 0) return null; var z = l[l.length - 1];
    if (z.indexOf("#end\t") !== 0) return null; var n = parseInt(z.substring(5), 10); if (!(n >= 0)) return null;
    for (i = 1; i < l.length - 1; i++) { f = l[i].split("\t"); if (f.length < 14 || !f[0] || f[0].charAt(0) === "#") continue;
        e = { meta: HUB + "/store/apps/" + f[0] + "/app.json", app: HUB + "/store/apps/" + f[0] + "/main.js", name: f[1], version: f[2],
              api: +f[3] || 1, category: f[4] || "Apps", size: +f[5] || 0, md5: f[6], requires: f[7] ? f[7].split(",") : [], deps: parseDepsField(f[8]), changelog: f[13] || "" };
        if (f[9]) e.zip = { url: HUB + "/store/apps/" + f[0] + "/app.zip", md5: f[9], size: +f[10] || 0 };
        if (f[11] === "1") e.icon = HUB + "/store/apps/" + f[0] + "/icon.png"; if (+f[12] > 0) e.nfiles = +f[12]; o.push({ pkg: f[0], e: e }); }
    return o.length === n ? o : null; }

// ---- semver (gramatica normativa; test/semver/run.js extrai daqui) ---------
// "^X.Y.Z" = mesma major e >= base (major = breaking; minor/patch sobem
// sozinhos) ou "X.Y.Z" exata. Malformada ("1.2", "v1.0.0", "") nao satisfaz.
var RE_VER_DEP = /^(\d+)\.(\d+)\.(\d+)$/; function cmpV(v1, v2) { v1 = v1 || ""; v2 = v2 || ""; var p1 = 0, p2 = 0; while (p1 < v1.length || p2 < v2.length) {
        var n1 = 0, n2 = 0; while (p1 < v1.length && v1.charAt(p1) !== ".") { n1 = n1 * 10 + (v1.charCodeAt(p1) - 48); p1++; }
        while (p2 < v2.length && v2.charAt(p2) !== ".") { n2 = n2 * 10 + (v2.charCodeAt(p2) - 48); p2++; } if (n1 > n2) return 1; if (n1 < n2) return -1; p1++; p2++; }
    return 0; } function depRangeOk(rng, ver) { rng = String(rng); var c = rng.charAt(0) === "^"; var R = RE_VER_DEP.exec(c ? rng.substring(1) : rng);
    var V = RE_VER_DEP.exec(String(ver)); if (!R || !V) return false; if (!c) return rng === String(ver);
    return +V[1] === +R[1] && (+V[2] > +R[2] || (+V[2] === +R[2] && +V[3] >= +R[3])); } function depPick(nm, ranges, index) { var vs = index[nm], best = null;
    if (!vs) return null; for (var v in vs) if (vs.hasOwnProperty(v)) { var ok = true;
        for (var i = 0; i < ranges.length; i++) if (!depRangeOk(ranges[i], v)) { ok = false; break; } if (ok && (best === null || cmpV(v, best) > 0)) best = v; }
    return best; } function _passadaDeps(sementes, index) { var want = {}, seen = {}, q = [], k, i; for (k in sementes) if (sementes.hasOwnProperty(k))
        for (i = 0; i < sementes[k].length; i++) q.push([k, sementes[k][i]]); while (q.length) {
        var pr = q.shift(), nm = pr[0], rng = String(pr[1]), key = nm + "|" + rng; if (seen[key]) continue; seen[key] = 1; if (!want[nm]) want[nm] = [];
        want[nm].push(rng); var es = depPick(nm, want[nm], index); if (!es) return null; var sub = (index[nm][es] && index[nm][es].deps) || {};
        for (k in sub) if (sub.hasOwnProperty(k)) q.push([k, String(sub[k])]); } var picks = {}; for (k in want) if (want.hasOwnProperty(k)) {
        var p = depPick(k, want[k], index); if (!p) return null; picks[k] = p; } return { wanted: want, picks: picks }; }
// fecho de ponto fixo: uma passada pode SUBIR o pick no meio e as arestas
// do pick velho vazavam (sobrava pino e faltava modulo do pick novo).
function resolveDeps(want, index) { var dir = {}, k, n2; if (!index) return null; for (k in want) if (want.hasOwnProperty(k)) dir[k] = String(want[k]); var sem = {};
    for (k in dir) if (dir.hasOwnProperty(k)) sem[k] = [dir[k]]; for (var pa = 0; pa < 32; pa++) { var r = _passadaDeps(sem, index); if (!r) return null;
        var ex = {}, prox = {}, exato = true; for (k in r.picks) if (r.picks.hasOwnProperty(k)) { var v = r.picks[k];
            var sub = (index[k] && index[k][v] && index[k][v].deps) || {}; for (var d in sub) if (sub.hasOwnProperty(d)) { d = String(d); if (!ex[d]) ex[d] = [];
                if (!prox[d]) prox[d] = []; if (ex[d].indexOf(String(sub[d])) < 0) ex[d].push(String(sub[d]));
                if (prox[d].indexOf(String(sub[d])) < 0) prox[d].push(String(sub[d])); } } var nomes = {};
        for (n2 in r.wanted) if (r.wanted.hasOwnProperty(n2)) nomes[n2] = 1; for (n2 in ex) if (ex.hasOwnProperty(n2)) nomes[n2] = 1;
        for (n2 in nomes) if (nomes.hasOwnProperty(n2)) { var base = (ex[n2] || []).slice(); if (dir[n2] && base.indexOf(dir[n2]) < 0) base.push(dir[n2]);
            if (base.sort().join("|") !== (r.wanted[n2] || []).slice().sort().join("|")) { exato = false; break; } } if (exato) return r.picks; sem = prox;
        for (k in dir) if (dir.hasOwnProperty(k)) { if (!sem[k]) sem[k] = []; if (sem[k].indexOf(dir[k]) < 0) sem[k].push(dir[k]); } } return null; }

// ---- cache de deps compartilhadas: /local/modules/<nome>/<versao> ----------
// ui = {step(nomeApp, sub), progress(g,t)} opcional (o app passa o frame de
// download; o servico nao tem vidro). Devolve "" ou a mensagem de erro.
function installModules(item, resolved, index, ui) {
    var appName = (item && item.name) || "";
    for (var nm in resolved) if (resolved.hasOwnProperty(nm)) { var ver = resolved[nm], d = (index[nm] || {})[ver];
        if (!d || !d.url) return "Dep indisponível (" + nm + ")";
        var d2 = "/local/modules/" + nm + "/" + ver, dst = d2 + "/" + nm + ".js"; if (FS.exists(dst)) { var sz = -1;
            try { sz = FS.getFileSize(dst); } catch (e0) { sz = -1; } if (!d.size || sz === d.size) continue; }   // modulo sao
        if (d.minApi && d.minApi > apiLevel()) return nm + " exige API " + d.minApi;
        if (!MK("/local/modules") || !MK("/local/modules/" + nm) || !MK(d2)) return "Erro no disco";
        if (ui && ui.step) ui.step(appName, nm + " " + ver);
        if (typeof System.delay === "function") System.delay(30);
        var tmp = dst + ".new", ok = false;
        ok = N(d.url, tmp, ui && ui.progress ? ui.progress : undefined);
        if (!ok) { D(tmp); return "Erro ao baixar " + nm; } var md = M(tmp);
        if (d.md5 && md !== d.md5) { D(tmp); return "Verificação falhou (" + nm + ")"; }
        if (!FS.renameFile(tmp, dst)) { D(tmp); return "Erro ao gravar " + nm; } } return ""; }

// ---- instalados ------------------------------------------------------------
// Mesma regra do launcher: PRIMEIRO visto ganha (ordem do listDir igual).
function scanInstalled() { var out = {}, roots = ["/local/apps", "/sd/apps"];
    for (var r = 0; r < 2; r++) { var ro = roots[r]; if (!FS.isDirectory(ro)) continue; var l2 = FS.listDir(ro);
        for (var i = 0; i < l2.length; i++) { var d = l2[i]; if (!FS.isDirectory(d)) continue;
            var b = readText(d + "/app.json"); if (!b) continue; var j = null;
            try { j = JSON.parse(b); } catch (e) { j = null; } if (!j) continue;
            var pk = j.packageName || bn(d); if (out[pk]) continue;
            out[pk] = { ver: j.version || "", dir: d, RT: ro, name: j.name || pk, system: j.system === true,
                        sd: ro === "/sd/apps", api: j.api || 1, deps: j.deps || null, service: j.service || "" }; } } return out; }
function dirOf(pkg) { var inst = scanInstalled(); return inst[pkg] ? inst[pkg].dir : null; }
// copias sombreadas do mesmo packageName (Terminal x celeros.terminal): a
// pasta que ficou com o update e a unica que vale.
function removeShadows(pkg, keep) { var roots = ["/local/apps", "/sd/apps"];
    for (var r = 0; r < 2; r++) { var ro = roots[r]; if (!FS.isDirectory(ro)) continue; var l2 = FS.listDir(ro);
        for (var i = 0; i < l2.length; i++) { var d = l2[i]; if (d === keep || !FS.isDirectory(d)) continue;
            var b = readText(d + "/app.json"); if (!b) continue; var j = null;
            try { j = JSON.parse(b); } catch (e) { j = null; }
            if (j && j.packageName === pkg) { try { FS.removeDirectory(d); } catch (e2) {} } } } }

// tamanho do pacote descompactado (main.js + extras), proxy do que o
// installZip grava no staging (que convive com a copia instalada).
function pktSize(j) { var n = (j && j.size) || 0, fn; for (fn in ((j && j.files) || {})) if (j.files.hasOwnProperty(fn)) n += (j.files[fn] || {}).size || 0;
    return n; }
function nps(j) { return !!((j && j.req) && j.req.indexOf && j.req.indexOf("psram") >= 0) ||
                        !!((j && j.requires) && j.requires.indexOf && j.requires.indexOf("psram") >= 0); }

// ---- config: auto/hora/pins ------------------------------------------------
function cfgLoad() { var c = { auto: true, hour: 2, pins: {} };
    var b = readText(CFG_PATH); if (b) { var j = null; try { j = JSON.parse(b); } catch (e) { j = null; }
        if (j && typeof j === "object") { if (j.auto === false) c.auto = false; else if (j.auto === true) c.auto = true;
            var h = parseInt(j.hour, 10); if (!isNaN(h) && h >= 0 && h <= 23) c.hour = h;
            if (j.pins && typeof j.pins === "object") c.pins = j.pins; } } return c; }
function cfgSave(c) { if (!c) return false; var pins = {}, k; for (k in (c.pins || {})) if (c.pins.hasOwnProperty(k)) pins[k] = 1;
    try { return FS.writeTextFile(CFG_PATH, JSON.stringify({ auto: c.auto !== false, hour: c.hour || 0, pins: pins })); } catch (e) { return false; } }
function pinned(c, pkg) { return !!(c && c.pins && c.pins[pkg]); }
function setPin(c, pkg, on) { if (!c) return false; if (!c.pins) c.pins = {}; if (on) c.pins[pkg] = 1; else delete c.pins[pkg]; return cfgSave(c); }
function prunePins(c, inst) { if (!c || !c.pins) return false; var k, mudou = false;
    for (k in c.pins) if (c.pins.hasOwnProperty(k) && !inst[k]) { delete c.pins[k]; mudou = true; }
    return mudou ? cfgSave(c) : false; }

// ---- agenda ----------------------------------------------------------------
// System.getTime() segue o formato de 12/24 h do aparelho ("02:00" ou
// "02:00 AM"); a hora local tem que sair igual nos dois.
function hourOf(s) { s = String(s || ""); var h = parseInt(s.substring(0, 2), 10); if (isNaN(h)) return -1;
    if (s.indexOf("PM") >= 0 && h < 12) h += 12; if (s.indexOf("AM") >= 0 && h === 12) h = 0; return h; }
// true quando a rodada do dia ainda nao aconteceu e ja passou da hora
// configurada (02:00 por padrao). A janela e ABERTA para tras de proposito:
// aparelho desligado/sem rede as 02:00 atualiza na primeira oportunidade do
// dia, em vez de ficar uma noite sem update.
function dueNow(c, lastDay, timeStr, dateStr) { if (!c || c.auto === false) return false;
    var h = hourOf(timeStr), base = (c.hour === undefined || c.hour === null) ? 2 : c.hour;
    if (h < 0 || h < base) return false; if (!dateStr) return false; return String(lastDay || "") !== String(dateStr); }

// ---- plano da rodada -------------------------------------------------------
// Uma request (/store/all.txt) da versao de TODOS os apps do catalogo; sem ela
// (404/truncado) cai para o app.json de cada instalado. Devolve null quando
// NAO deu para falar com o hub (o chamador nao marca o dia).
function hubVersions() { var rows = parseCompactCatalog(fetchText(HUB + "/store/all.txt")); if (!rows) return null;
    var out = {}, i; for (i = 0; i < rows.length; i++) { var e = rows[i].e;
        out[rows[i].pkg] = { ver: String(e.version || ""), api: e.api || 1, req: e.requires || [], deps: e.deps || null,
                             size: e.size || 0, zip: e.zip || null, changelog: e.changelog || "" }; }
    return out; }

// [{pkg,name,from,to,dir,api,deps,size,zip,req,meta}] dos apps instalados que
// tem versao nova e podem ser trocados por zip nesta placa. Pins, apps no SD
// e apps fora do catalogo (de fabrica) ficam de fora.
function planUpdates(inst, c, maxApps) { inst = inst || {}; var lim = maxApps || MAX_APPS, out = [], keys = [], k, i;
    for (k in inst) if (inst.hasOwnProperty(k)) keys.push(k); keys.sort();
    var vers = hubVersions(), reachable = !!vers, tried = 0, ps = hasPs(), api = apiLevel();
    for (i = 0; i < keys.length && out.length < lim; i++) { var pkg = keys[i], lo = inst[pkg];
        if (!lo || lo.sd) continue;                       // installZip escreve so em /local/apps
        if (pinned(c, pkg)) continue;                     // versao travada pelo usuario
        var e = vers ? vers[pkg] : null;
        if (vers && !e) continue;                         // fora do catalogo: app de fabrica
        if (!e) { var m = fetchJson(HUB + "/store/apps/" + pkg + "/app.json"); tried++;
            if (!m) continue; reachable = true;
            e = { ver: String(m.version || ""), api: m.api || 1, req: m.requires || [], deps: m.deps || null,
                  size: m.size || 0, zip: m.zip || null, meta: m }; }
        if (!e.ver || cmpV(e.ver, lo.ver) <= 0) continue;
        if ((e.api || 1) > api) continue;                 // nao roda nesta placa
        if (!ps && nps(e)) continue;                      // exige PSRAM e a placa nao tem
        out.push({ pkg: pkg, name: lo.name, from: lo.ver, to: e.ver, dir: lo.dir, api: e.api || 1,
                   deps: e.deps || null, size: e.size || 0, zip: e.zip || null, req: e.req || [],
                   meta: e.meta || null }); }
    if (!reachable && tried > 0) return null;
    return out; }

// ---- troca de UM app pelo app.zip do hub -----------------------------------
// Ordem: deps (o erro aqui nao troca o app) -> zip com MD5 -> installZip ->
// deps.json (o zip nao carrega o fecho; sem ele o require cai em modulo
// errado) -> sombras. Devolve {ok, version, skipped} ou {ok:false, err}.
function updateOne(cand, ui) {
    var pkg = cand.pkg, dir = cand.dir || dirOf(pkg);
    if (!dir) return { ok: false, err: "nao instalado" };
    if (dir.indexOf("/sd/") === 0) return { ok: false, err: "app no cartao SD" };
    if (typeof System.installZip !== "function") return { ok: false, err: "firmware sem installZip" };
    var meta = cand.meta || fetchJson(HUB + "/store/apps/" + pkg + "/app.json");
    if (!meta) return { ok: false, err: "app.json do hub indisponivel" };
    var ver = String(meta.version || "");
    if (!ver || cmpV(ver, cand.from) <= 0) return { ok: true, skipped: true, version: ver };
    if ((meta.api || 1) > apiLevel()) return { ok: false, err: "exige API " + (meta.api || 1) };
    if (!hasPs() && nps(meta)) return { ok: false, err: "exige PSRAM" };
    var zip = meta.zip || null;
    if ((!zip || !zip.md5) && cand.zip && cand.zip.md5)
        zip = { url: HUB + "/store/apps/" + pkg + "/app.zip", md5: cand.zip.md5, size: cand.zip.size || 0 };
    if (!zip || !zip.md5 || !zip.url) return { ok: false, err: "hub sem app.zip" };
    // espaco: zip + pacote novo + copia ativa (o staging .install convive com
    // as duas) + folga do app.json/icone.
    var need = (zip.size || 0) + pktSize(meta) * 2 + 16384, free = 0;
    try { free = FS.getFreeSpace("/local"); } catch (e) { free = 0; }
    if (free > 0 && free < need) return { ok: false, err: "sem espaço em /local" };
    var dep = null;
    if (meta.deps && K(meta.deps)) { var ix = depsIndex(); if (!ix) return { ok: false, err: "índice de deps indisponível" };
        dep = resolveDeps(meta.deps, ix); if (!dep) return { ok: false, err: "dep indisponível" };
        var de = installModules(meta, dep, ix, ui); if (de) return { ok: false, err: de }; }
    var tmp = "/local/appstore_update.zip"; D(tmp);
    if (ui && ui.step) ui.step(cand.name || pkg, "pacote");
    var ok = N(zip.url, tmp, ui && ui.progress ? ui.progress : undefined);
    if (!ok) { D(tmp); return { ok: false, err: "download falhou" }; }
    if (String(M(tmp)).toLowerCase() !== String(zip.md5).toLowerCase()) { D(tmp); return { ok: false, err: "MD5 divergente" }; }
    var folder = bn(dir), r = null;
    try { r = System.installZip(tmp, folder); } catch (e2) { r = null; }
    D(tmp);
    if (!r || r.ok !== true) return { ok: false, err: "pacote recusado" };
    if (dep && !FS.writeTextFile(dir + "/deps.json", JSON.stringify(dep))) return { ok: false, err: "deps.json não gravou" };
    removeShadows(pkg, dir);
    return { ok: true, version: ver }; }

// ---- lote ------------------------------------------------------------------
// A loja vai por ULTIMO: se algo interromper a rodada no meio, a loja (quem
// aplica o lote da proxima vez) continua inteira. Devolve os nomes que
// mudaram e os que falharam (com motivo).
function runBatch(list, ui) {
    var ord = [], done = [], fail = [], i;
    for (i = 0; i < list.length; i++) if (list[i].pkg !== SELF_PKG) ord.push(list[i]);
    for (i = 0; i < list.length; i++) if (list[i].pkg === SELF_PKG) ord.push(list[i]);
    for (i = 0; i < ord.length; i++) { var item = ord[i], res = null;
        if (ui && ui.step) ui.step(item.name || item.pkg, "");
        try { res = updateOne(item, ui); } catch (e) { res = { ok: false, err: String(e) }; }
        if (res && res.ok) { if (!res.skipped) done.push(String(item.name || item.pkg) + " " + String(res.version || item.to)); }
        else fail.push(String(item.name || item.pkg) + (res && res.err ? " (" + res.err + ")" : "")); }
    return { done: done, fail: fail }; }

module.exports = {
    version: "1.0.0",
    HUB: HUB, CFG_PATH: CFG_PATH, SELF_PKG: SELF_PKG,
    bn: bn, fk: fk, K: K, D: D, M: M, MK: MK, N: N, pump: pump,
    hubToken: hubToken, resetToken: resetToken, hubUrl: hubUrl,
    fetchText: fetchText, fetchJson: fetchJson, depsIndex: depsIndex,
    parseDepsField: parseDepsField, parseCompactCatalog: parseCompactCatalog,
    cmpV: cmpV, depRangeOk: depRangeOk, depPick: depPick, resolveDeps: resolveDeps,
    installModules: installModules,
    scanInstalled: scanInstalled, dirOf: dirOf, removeShadows: removeShadows, pktSize: pktSize,
    cfgLoad: cfgLoad, cfgSave: cfgSave, pinned: pinned, setPin: setPin, prunePins: prunePins,
    hourOf: hourOf, dueNow: dueNow,
    hubVersions: hubVersions, planUpdates: planUpdates, updateOne: updateOne, runBatch: runBatch
};
