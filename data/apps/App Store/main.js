// CelerOS App Store 3.1 — loja de apps do CelerOS Hub (os.celer.tec.br).
// Refeita no CelerKit UI 2.0 (celeros.app/style/icons/list/caps): abas e
// categorias segmentadas, linhas ricas (icone, versao, badge de estado,
// barras de tamanho), detalhe em folha com descricao/changelog/permissoes e
// os overlays de busy/progresso/ok/erro do kit. CYD-f0: sem PSRAM o
// catalogo vem por getJSON/categoria (o all.json de ~106 KB so por
// Net.download em placa com PSRAM), o cache gravado e compacto e o indice de
// deps vem por Net.get (o download streaming e so em placa com PSRAM).
//
// Catalogo: /store/index.json (categorias) -> all.json (PSRAM, 1 download)
// -> uma request por categoria (CYD). all.txt (TSV compacto) continua
// aceito pelo parser exposto ao harness, mas o hub de hoje responde 404.
// Instalacao por arquivos com staging .new, MD5 do catalogo por arquivo e
// rename em lote (a versao nova so aparece junto; nada de meia versao) e
// app.json no mesmo lote; pacote unico (System.installZip, API 42) quando o
// hub publica zip. Deps resolvidas por semver no /store/deps.json e
// servidas do cache /local/modules; deps.json gravado por ultimo (commit do
// conjunto). Update de engine baixa so as versoes novas e regrava o
// deps.json sem reinstalar o app. O App Store se atualiza pelo proprio
// catalogo: gravar os arquivos basta, o main.js e relido do disco.
//
// Estados: carregando, Wi-Fi fora, erro de rede, catalogo vazio/parcial,
// progresso, sucesso, conflito de versao (local mais nova que o hub), app
// incompativel (API/PSRAM) e versao travada (badge "Travado"). O app.json do
// pacote e a fonte de files/requires/permissoes no install; permissoes novas
// pedem consentimento.
//
// 3.1: o MOTOR (semver/range, fecho de deps, cache /local/modules, leitura
// dos instalados, token do hub e as travas) mora no store.js - o MESMO
// arquivo que o service.js carrega na rodada automatica da madrugada; este
// main.js e o vidro. Cada app tem a TRAVA DE VERSAO no detalhe ("Atualizar
// automaticamente"): travado, ele nao entra no "Atualizar tudo" nem na rotina
// das 02:00 (o botao manual continua valendo). A rotina e LIGADA por padrao
// (/local/appstore_auto.json: {auto, hour, pins}).

var IU = "https://os.celer.tec.br/store/index.json";
var HB = IU.substring(0, IU.indexOf("/store/")); var CA = "/local/appstore_cache.json"; var SP = "celeros.appstore"; var FL = "/local/config_install_sd.txt";
var U = require("store");
// Apelidos para o store.js: nada de duas gramaticas de versao nem de duas
// tabelas de deps (test/semver/run.js cobra a paridade das copias).
var bn = U.bn, fk = U.fk, K = U.K, D = U.D, M = U.M, N = U.N;
var HT = U.hubToken, HU = U.hubUrl, gt = U.fetchText, gj = U.fetchJson, gd = U.depsIndex;
var cmpV = U.cmpV, depRangeOk = U.depRangeOk, resolveDeps = U.resolveDeps;

// ---- CelerKit UI 2.0 -------------------------------------------------------
var A = require("celeros.app"); require("celeros.app.style"); require("celeros.app.icons"); require("celeros.app.list"); require("celeros.app.caps"); A.init();
var T = A.style.preset("soft"); var L = A.L; var CAP = A.caps.probe(); var PS = !!CAP.psram; var NP = !PS; var SM = !!CAP.small;
var API = System.getAPILevel(); var IS = SM ? 44 : 56;

// requires psram declarado vence; catalogo sem o campo cai na heuristica
// calibrada na CYD (61 KB roda, 82 KB nao compila).
var HI = System.getInfo ? System.getInfo() : null; var PM = !NP ? Infinity
    : HI && HI.appRAM ? Math.max(4096, Math.floor((HI.appRAM - 60000) * 0.4)) : Math.max(4096, Math.floor(((HI && HI.freeRAM || 0) - 52000) / 1.7));
function NPS(j) { return (j.req && j.req.indexOf("psram") >= 0) || (j.size || 0) > PM; }

// ---- utilitarios / rede / semver / deps ------------------------------------
// Tudo isso mora no store.js (apelidado no topo): o servico da madrugada tem
// que ver a MESMA versao, o MESMO fecho de deps e o MESMO token. Aqui fica
// so o que e do vidro.
function idp(j, res, ix) { return U.installModules(j, res, ix, { step: dl, progress: pg }); }

// ---- estado ----------------------------------------------------------------
var ap = [], ct = ["Todos"], cc = "Todos", tb = 0, si = null, lm2 = {}; var uc = 0, em = "", eh = "", rm = ""; var wu = false, su = false, bo = 0, bf = [];
var di = null, du = {}, cw = "", ls = false, q2 = ""; var ds = 0, vs = "", lc = { key: "", items: null }, nc = true, sf = -1;

function BVW() { vs = ds + "|" + tb + "|" + cc + "|" + q2; } function fsl(m) { var f = 0; try { f = FS.getFreeSpace("/local"); } catch (e) { return false; }
    return f > 0 && f < m; } function ios() { if (System.setting) { var v = null; try { v = System.setting("install_sd"); } catch (e) { v = null; } if (v === "1" || v === 1 || v === true) return true; if (v === "0" || v === 0 || v === false) return false; } return FS.exists(FL); }
function SIO(v) { var wrote = false; if (System.setting) { try { wrote = System.setting("install_sd", v ? "1" : "0"); } catch (e) { wrote = false; } }
    if (!wrote) { try { if (v) FS.writeTextFile(FL, "1"); else FS.deleteFile(FL); } catch (e2) {} } }
function PSD() { sf = -1; try { sf = FS.getFreeSpace("/sd"); } catch (e) { sf = -1; } }

// ---- disco: instalados -----------------------------------------------------
// store.js faz o scan (mesma regra do launcher: PRIMEIRO visto ganha, ordem
// do listDir igual) - o servico da madrugada le a MESMA tabela.
function SCA() { lm2 = U.scanInstalled(); } function RID(pkg) { return U.dirOf(pkg); }
function RSH(pkg, keep) { U.removeShadows(pkg, keep); } function CBP(pkg) {
    for (var i = 0; i < ap.length; i++) if (ap[i].pkg === pkg) return ap[i]; return null; }
// ---- trava de versao / rotina automatica -----------------------------------
// /local/appstore_auto.json (o MESMO arquivo que o service.js le): os pins por
// pacote e o liga/desliga da rotina das 02:00. Em memoria ate um toggle.
var AC = null;
function CFG() { if (!AC) AC = U.cfgLoad(); return AC; }
function PIN(pkg) { return U.pinned(CFG(), pkg); }
function SETPIN(pkg, on) { var c = CFG(); U.setPin(c, pkg, on); RFS(); UI.invalidate(); }
function SETAUTO(on) { var c = CFG(); c.auto = !!on; U.cfgSave(c); UI.invalidate(); }
function SI(j) { var lo = lm2[j.pkg];
    if ((j.api || 1) > API) return { code: "api", bd: "API " + j.api, col: T.warn };
    if (NP && NPS(j)) return { code: "hw", bd: "PSRAM", col: T.warn };
    if (!lo) return { code: "new", bd: "Novo", col: T.ok };
    // versao travada: nao entra no lote (nem no manual "Atualizar tudo") nem
    // na rotina da madrugada; o botao do detalhe continua atualizando na mao.
    if (PIN(j.pkg)) { if (cmpV(j.ver, lo.ver) > 0 || du[j.pkg]) return { code: "pin", bd: "Travado", col: T.textDim };
        return { code: "inst", bd: "Instalado", col: T.textDim }; }
    // local a frente do hub nao vira "Atualizar" (downgrade)
    if (cmpV(j.ver, lo.ver) <= 0) { if (du[j.pkg]) return { code: "dep", bd: "Engine", col: T.warn };
        return { code: "inst", bd: "Instalado", col: T.textDim }; }
    return { code: "upd", bd: "Atualizar", col: T.warn }; } function RFS() { CFG(); SCA(); SDU(); PSD(); uc = 0; for (var i = 0; i < ap.length; i++) {
        var c = SI(ap[i]).code; if (c === "upd" || c === "dep") uc++; }
    // pin de app desinstalado nao volta a valer num install futuro
    U.prunePins(CFG(), lm2);
    // chaves pre-computadas: o sort nativo do Duktape e preventyield
    A.list.sort(ap, function (j) { var c = SI(j).code; return (c === "upd" || c === "dep" ? "0" : "1") + String(j.name || "?").toLowerCase(); }); var seen = {}, k;
    ct = ["Todos"]; for (k = 0; k < ap.length; k++) { var ctg = ap[k].cat || "Apps"; if (!seen[ctg]) { seen[ctg] = 1; ct.push(ctg); } } ct = ["Todos"].concat(ct.slice(1).sort()); ds++; BVW(); }
function FDI() { di = null; if (!Net.isConnected()) return; var d = null; try { d = gd(); } catch (e) { d = null; } if (d) di = d; } function IIS() {
    var out = []; for (var pk in lm2) if (lm2.hasOwnProperty(pk)) { out.push(CBP(pk) || { pkg: pk, name: lm2[pk].name, ver: lm2[pk].ver, cat: "Apps", api: 1 });
    } A.list.sort(out, function (a) { return String(a.name).toLowerCase(); }); return out; }

// ---- catalogo --------------------------------------------------------------
function ETI(pk, e) { return { pkg: pk, metaUrl: e.meta || "", appUrl: e.app || "", name: e.name || "", desc: e.description || "",
             author: e.author || "Desconhecido", ver: e.version || "1.0.0", api: e.api || 1, cat: e.category || "Apps", icon: e.icon || "", changelog: e.changelog || "",
             size: e.size || 0, md5: e.md5 || "", req: e.requires || [], files: e.files || null, nfiles: e.nfiles || 0, deps: e.deps || null, zip: e.zip || null }; }
// campos que o catalogo compacto nao traz (descricao/autor/changelog/
// permissoes) vem do app.json no detalhe/install — 1 request por app visto.
function FIM(j) { var m = gj(j.metaUrl); if (!m) return null; j.desc = m.description || j.desc || ""; j.author = m.author || j.author || "Desconhecido";
    j.changelog = m.changelog || j.changelog || ""; j.perms = m.permissions || []; if (!j.files && m.files) j.files = m.files; if (!j.deps && m.deps) j.deps = m.deps;
    if ((!j.req || !j.req.length) && m.requires) j.req = m.requires; j.fetched = 1; return j; } function FAP() { var out = [], s = q2.toLowerCase();
    for (var i = 0; i < ap.length; i++) { if (cc !== "Todos" && (ap[i].cat || "Apps") !== cc) continue; if (s && (String(ap[i].name || "").toLowerCase().indexOf(s) < 0 &&
                  String(ap[i].desc || "").toLowerCase().indexOf(s) < 0)) continue; out.push(ap[i]); } return out; }

// Catalogo compacto: 14 campos TSV e rodape "#end N" (truncamento do
// get/request). O parser mora no store.js (o service usa o mesmo para o
// plano da madrugada); aqui so os apelidos que o harness conhece.
var PDF = U.parseDepsField, PCC = U.parseCompactCatalog;
// cache compacto: a lista/estado nao precisam de changelog/permissoes; o
// detalhe busca o app.json quando abre (1 request por app visto). Na CYD o
// texto encurta e o changelog nem entra (cache pequeno no /local apertado).
function CTI(j) { var o = {}, ks = "pkg name ver api cat desc author icon size md5 metaUrl appUrl req files nfiles deps zip".split(" ");
    for (var i = 0; i < ks.length; i++) o[ks[i]] = j[ks[i]]; o.desc = String(o.desc || "").substring(0, SM ? 80 : 160);
    o.changelog = SM ? "" : String(o.changelog || "").substring(0, 400); return o; }

function LCA() { ap = []; cc = "Todos"; si = null; rm = "load"; cw = ""; ls = false; A.busy("Baixando catálogo..."); var ix = gj(IU); if (!ix || !ix.categories) {
        em = "Falha no catálogo"; eh = "Verifique a internet."; return "err"; } nc = true; FDI(); var en = [], ci = ix.categories, all = false;

    // all.json so com PSRAM (~106 KB; Net.get corta em 32 KB). O cache velho
    // sai antes do download (o caminho custa ~2x o catalogo em /local).
    if (ci["Todos"] && PS) { ls = fsl(200 * 1024); if (ls) { D(CA); ls = fsl(128 * 1024); } A.busy("Baixando catálogo...");
        var apath = "/local/appstore_all.json", aj = null, ok = false; ok = N(ci["Todos"], apath); if (ok) {
            var b = FS.readTextFile(apath); D(apath); System.delay(1); if (b) { try { aj = JSON.parse(b); } catch (e3) { aj = null; } }
        } else { D(apath); } if (aj && aj.apps) { all = true;
            for (var pk in aj.apps) if (aj.apps.hasOwnProperty(pk) && aj.apps[pk] && aj.apps[pk].app) en.push({ pkg: pk, e: aj.apps[pk] }); } aj = null; }
    // CYD: uma request por categoria; category >32 KB volta truncada e ganha
    // o aviso "Catalogo incompleto" em vez de sumir em silencio.
    if (!all) { var tot = 0, okc = 0, fail = []; for (var cn in ci) { if (!ci.hasOwnProperty(cn) || cn === "Todos") continue; tot++; A.busy("Categoria: " + cn);
            var c = gj(ci[cn]); if (!c || !c.apps) { fail.push(cn); continue; } okc++;
            for (var id in c.apps) if (c.apps.hasOwnProperty(id) && c.apps[id] && c.apps[id].app) en.push({ pkg: id, e: c.apps[id] }); }
        if (en.length === 0 && tot > 0 && okc === 0) { em = "Falha no catálogo"; eh = ls ? "Pouco espaço em /local ou sem internet." : "Verifique a internet.";
            return "err"; } if (fail.length) cw = "Catálogo incompleto: " + fail.join(", ") + (ls ? " (/local baixo)" : "") + "."; }

    var seen = {}; for (var k = 0; k < en.length; k++) { var j = ETI(en[k].pkg, en[k].e); if (!j.name) continue; if (seen[j.pkg]) continue; seen[j.pkg] = 1;
        ap.push(j); } System.delay(1); RFS(); if (ap.length) { System.delay(1); var arr = [], z; for (z = 0; z < ap.length; z++) arr.push(CTI(ap[z]));
        var blob = JSON.stringify(arr), f = 0; arr = null; try { f = FS.getFreeSpace("/local"); } catch (e5) { f = 0; }
        if ((f <= 0 || f > blob.length + 16384) && (!SM || blob.length < 32768)) FS.writeTextFile(CA, blob); blob = null; } return "list"; }
function LCC() { var b = FS.readTextFile(CA); if (!b) return false; var a = null; try { a = JSON.parse(b); } catch (e) { a = null; }
    if (!a || !a.length) return false; ap = a; System.delay(1); nc = Net.isConnected(); if (nc) { A.busy("Atualizações..."); FDI(); }
    RFS(); si = null; return true; }

// ---- listas ----------------------------------------------------------------
function CLS() { if (lc.key === vs) return lc.items; var it; if (tb === 0) it = FAP(); else if (tb === 1) { it = []; for (var i = 0; i < ap.length; i++) {
            var c = SI(ap[i]).code; if (c === "upd" || c === "dep") it.push(ap[i]); } } else it = IIS(); lc.key = vs; lc.items = it; return it; }
var IC = { Arcade: "play", Jogos: "play", System: "gear", Utilidades: "star", Audio: "play", Apps: "menu" };
function SZB(n) { if (!n || n <= 0) return 0; return n <= 8192 ? 1 : n <= 16384 ? 2 : n <= 32768 ? 3 : 4; }
function ROF(j) { var st = SI(j), lo = lm2[j.pkg], sub; if (tb === 1) { var d = du[j.pkg]; if (d) sub = "engine " + d.names[0] + " " + (d.have[d.names[0]] || "?") + " > " +
                      d.resolved[d.names[0]] + (d.names.length > 1 ? "  (+" + (d.names.length - 1) + ")" : ""); else sub = "v" + (lo ? lo.ver : "?") + " > v" + j.ver;
    } else if (tb === 2) { sub = "v" + (lo ? lo.ver : j.ver) + (lo && lo.sd ? " · SD" : "") + (lo && lo.system ? " · sistema" : "") +
                      (PIN(j.pkg) ? " · travado" : ""); } else {
        sub = "v" + j.ver + (j.size ? " · " + fk(j.size) : "") + (j.deps ? " · deps" : ""); }
    return { label: j.name, sub: sub, icon: IC[j.cat] || "dot", j: j, bars: SZB(j.size), st: st }; }
// linhas ricas: icone + nome/versao + badge de estado + barras de tamanho.
function PRW(it, x, y, w, h, s) { var j = it.j, st = it.st, t = String(st.bd), bw = UI.measure(t, "caption") + 14;
    if (bw > w - 84) bw = w - 84; var lw = w - 24 - bw - 6;
    A.icons.draw(it.icon, x, y + Math.round((h - 16) / 2), 16, { color: st.col === T.textDim ? T.text : st.col });
    UI.text(j.name, x + 22, y + 7, { role: "body", color: T.text, w: lw, lines: 1, bg: T.raised });
    UI.text(it.sub, x + 22, y + 25, { role: "caption", color: T.textDim, w: it.bars > 0 ? w - 52 : w - 8, lines: 1, bg: T.raised });
    UI.badge(t, x + w - bw, y + 7, { color: st.col, textColor: T.bg });
    if (it.bars > 0) { var bx = x + w - 22, by = y + h - 8, bi; for (bi = 0; bi < 4; bi++) { var bh = 3 + bi * 3;
            System.fillRect(bx + bi * 5, by - bh + 9, 3, bh, bi < it.bars ? T.accent : T.stroke); } } }
var rl = A.list.make(function () { return vs; }, function () {
    var it = CLS(), out = []; for (var i = 0; i < it.length; i++) out.push(ROF(it[i])); return out; }); function UN(pkg) {
    var d = RID(pkg); if (!d) return false; if (typeof Storage !== "undefined" && Storage.clearFor) { try { Storage.clearFor(pkg); } catch (e) {} }
    if (!FS.removeDirectory(d)) return false; if (PIN(pkg)) SETPIN(pkg, false);
    System.rescanApps(); RFS(); return true; } function uf(j) { var lo = lm2[j.pkg]; if (!lo) return false;
    var ok = UI.confirm("Desinstalar", "Remover " + j.name + "?", { yes: "Remover", danger: true });
    if (ok && lo.system) ok = UI.confirm("App do sistema", "Confirma remover " + j.name + " definitivamente?", { yes: "Remover", danger: true });
    if (ok && UN(j.pkg)) { UI.toast(j.name + " removido"); si = null; return true; } return false; }

// ---- permissoes ------------------------------------------------------------
var PT = { fs: "Arquivos", net: "Internet", system: "Sistema", bluetooth: "Bluetooth", mic: "Microfone", camera: "Câmera", usb: "USB", input: "Teclado" };
function pmt(ps) { if (!ps || !ps.length) return "nenhuma"; var out = []; for (var i = 0; i < ps.length; i++) out.push(PT[ps[i]] || String(ps[i])); return out.join(", ");
} function CNS(j) { var ps = j.perms || []; if (!ps.length) return true; var ok = UI.confirm("Permissões", j.name + " pede: " + pmt(ps) + ".", { yes: "Continuar" }); if (ok) j.consented = 1; return ok; }

// ---- UI: chrome ------------------------------------------------------------
function FTY() { return L.bottom - 34; }
// texto curto: tx(texto, x, y, cor, papel, largura, linhas, bg, alinhamento)
function tx(s, x, y, c, r, w, n, b, a) { UI.text(s, x, y, { color: c, role: r, w: w || 0, lines: n || 1, bg: b === undefined ? T.bg : b, align: a }); }
// header nativo + acoes (icone) a direita, com contador opcional. Devolve
// "" | "back" | id da acao.
function hd(t, back, acts) { if (UI.header(t, { back: !!back })) return "back"; if (!acts) return ""; for (var i = 0; i < acts.length; i++) {
        var ax = 240 - 8 - (acts.length - i) * 32; var hit = UI.button("", ax, 6, 28, 28, { color: T.raised, id: "h" + acts[i].id });
        A.icons.draw(acts[i].icon, ax + 6, 12, 16, { color: T.text });
        if (acts[i].count > 0) UI.badge(acts[i].count > 9 ? "9+" : String(acts[i].count), ax + 18, 2, { color: T.err, textColor: T.bg });
        if (hit) return acts[i].id; } return ""; } function TSB() {
    var nt = UI.tabs(L.x, 44, L.w, 26, ["Loja", "Atualiz.", "Meus"], tb); if (nt !== tb) { tb = nt; si = null; PSD(); BVW();
        for (var i = 0; i < 3; i++) UI.resetScroll("store" + i); UI.invalidate(); } }
// categorias: segmentado com a atual (ou a proxima) + "..." para a lista.
function PKC() { for (;;) { UI.invalidate(); UI.begin(T.bg); if (UI.header("Categorias", { back: true })) { UI.end(15); return ""; } var sel = -1;
        for (var i = 0; i < ct.length; i++) if (ct[i] === cc) sel = i; var k = UI.list("cats", L.x, 46, L.w, FTY() - 50, ct, { selected: sel }); UI.end(15);
        if (k >= 0) return ct[k]; } } function CTB(y) { var mid = cc === "Todos" ? (ct[1] || "Todos") : cc;
    var i = UI.tabs(L.x, y, L.w, 22, ["Todos", mid, "..."], cc === "Todos" ? 0 : 1); if (i === 2) { var c = PKC(); UI.invalidate();
        if (c && c !== cc) { cc = c; BVW(); UI.resetScroll("store0"); } return 1; } var w = i === 0 ? "Todos" : mid;
    if (w !== cc) { cc = w; BVW(); UI.resetScroll("store0"); UI.invalidate(); } return 0; }
// frame de download: COMPOE uma vez; pg() so atualiza barra/texto (o toolkit
// compara assinatura e redesenha so esses slots — sem piscar no vidro).
function dl(name, sub, bar) { UI.invalidate(); UI.begin(T.bg); UI.header("Baixando " + name, { back: false });
    A.style.card(24, 84, L.w - 32, 112, { full: true, draw: function (q) {
        UI.text(sub || "", q.x + (q.w >> 1), q.y + 8, { align: "center", role: "caption", color: T.textDim, w: q.w, lines: 1, bg: T.card });
        if (bar !== false) UI.progress(L.x + 24, 136, L.w - 48, 10, 0);
        UI.text("", 120, 154, { align: "center", role: "caption", color: T.textDim, id: "dlpct", bg: T.card });
    }}); }
function pg(g, t) { var p = 0, s = ""; if (t > 0) { p = Math.min(100, Math.floor(g * 100 / t)); s = p + "%"; } else { var k = Math.floor(g / 1024);
        if (k > 0) { p = Math.min(100, 10 + (k % 9) * 10); s = k + " KB"; } } UI.progress(L.x + 24, 136, L.w - 48, 10, p);
    UI.text(s, 120, 154, { align: "center", role: "caption", color: T.textDim, id: "dlpct", bg: T.card }); } function RT(n) { A._stack.length = 0; return n; }

// ---- tela principal --------------------------------------------------------
function HM(c) { var act = hd("App Store", false, [{ icon: q2 ? "close" : "search", id: "q" }, { icon: "check", id: "go", count: uc }]);
    if (act === "q") { if (q2) { q2 = ""; BVW(); UI.resetScroll("store0"); UI.toast("Busca limpa"); UI.invalidate(); } else if (System.prompt) {
            var s = System.prompt("Buscar app", "", {}); q2 = s ? String(s) : ""; BVW(); UI.resetScroll("store0"); UI.invalidate(); } } else if (act === "go") {
        if (!nc) { UI.toast("Sem internet"); } else if (uc > 0) { UI.toast(uc + " atualizações: aplicando"); return "batch"; }
        else { UI.toast("Recarregando catálogo"); return "load"; } } TSB();
    var fy = FTY(), top = 74, items = CLS(), lb = L.bottom - 6;
    if (tb === 0) { if (cw) { tx(cw, L.x, top, T.warn, "caption", L.w, 2); top += 24; }
        else if (!nc) { tx("Sem internet: catálogo em cache", L.x, top, T.warn, "caption", L.w, 1); top += 16; }
        else if (q2) { tx("Busca: " + q2, L.x, top, T.textDim, "caption", L.w, 1); top += 16; }
        if (CTB(top)) return; top += 26; } else if (tb === 2) { var n = K(lm2);
        tx(n + (n === 1 ? " app instalado" : " apps instalados"), L.x, top, T.textDim, "caption", L.w, 1); top += 16; lb = fy - 4; }
    else { // Atualiz.: a rotina automatica mora aqui (padrao ligada, 02:00)
        var au = CFG(), hh = (au.hour === undefined || au.hour === null) ? 2 : au.hour;
        tx("Automático às " + (hh < 10 ? "0" : "") + hh + ":00", L.x, top + 6, T.textDim, "caption", L.w - 56, 1);
        if (UI.toggle(L.x + L.w - 44, top, au.auto !== false, { id: "auto" }) !== (au.auto !== false)) SETAUTO(au.auto === false);
        top += 30; if (uc > 0) lb = fy - 4; }
    var ly = top + 2, lh = lb - ly;
    if (items.length && lh > 24) { var i = A.list.view("store" + tb, L.x, ly, L.w, lh, rl.rows(), { row: 46, paintRow: PRW });
        if (i >= 0) { si = items[i]; return "detail"; }
    } else if (!items.length) { var cy = (L.top + L.bottom) / 2, autoOn = CFG().auto !== false;
        tx(tb === 1 ? (autoOn ? "Tudo em dia!" : "Automático desligado") : tb === 2 ? "Nenhum app instalado" : (q2 ? "Nenhum resultado" : "Catálogo vazio"),
           120, cy, T.text, "title", L.w, 1, T.bg, "center"); tx(tb === 1 ? (autoOn ? "A rotina confere todo dia às 02:00." : "Ligue o automático acima.")
           : tb === 2 ? "Instale um app na aba Loja."
           : (cw ? "Catálogo parcial." : "Toque no check para recarregar."), 120, cy + 22, T.textDim, "caption", L.w, 2, T.bg, "center"); }
    if (tb === 1 && uc > 0) { if (A.style.button("Atualizar tudo", L.x, fy, L.w, 30, { variant: "primary" })) return "batch"; }
    else if (tb === 2) { var sd = ios(), noSd = sd && sf === 0;
        if (A.style.button("Instalar em: " + (sd ? "SD" : "interno") + (noSd ? " (sem cartão!)" : ""), L.x, fy, L.w, 30, { variant: "ghost" })) {
            SIO(!sd); UI.toast(sd ? "Instalar na memória interna" : "Instalar no cartão SD"); UI.invalidate(); } } }

// ---- detalhe (folha) -------------------------------------------------------
function DT(c) { var j = si; if (!j) return RT("home");
    // descricao/changelog/permissoes frescos (o cache compacto nao traz);
    // 1 request por app visto, com frame de busy antes
    if (c.entered && j.metaUrl && !j.fetched && Net.isConnected()) { A.busy("Abrindo " + j.name); FIM(j); UI.invalidate(); return; }
    if (UI.header(j.name, { back: true })) return A.BACK;
    var lo = lm2[j.pkg], st = SI(j), conf = !!(lo && cmpV(j.ver, lo.ver) < 0), fy = FTY();
    var sx = L.x, sw = L.w, top = 48, bh = fy - 6 - top;
    A.style.card(sx, top, sw, bh, { full: c.full, r: 14, pad: 12, draw: function (q) {
        System.fillRoundRect(sx + (sw >> 1) - 16, top + 5, 32, 4, 2, T.stroke);
        var yy = q.y + 8;
        if (c.full) System.fillGradient(q.x, yy, IS, IS, T.accent, T.accentD, 12);
        UI.text(String(j.name || "?").charAt(0).toUpperCase(), q.x + (IS >> 1), yy + ((IS - UI.lineHeight("title")) >> 1), { align: "center", role: "title", color: T.onAccent, bg: T.accentD });
        var tw = q.w - IS - 8, bw = UI.measure(st.bd, "caption") + 14;
        UI.text(j.name, q.x + IS + 8, yy + 1, { role: "title", color: T.text, w: tw - bw - 4, lines: 1, bg: T.card });
        UI.text((j.author || "Desconhecido") + (j.size ? " · " + fk(j.size) : "") + (j.deps ? " · deps" : ""), q.x + IS + 8, yy + 21, { role: "caption", color: T.textDim, w: tw, lines: 1, bg: T.card });
        UI.text("v" + j.ver + (lo ? " · v" + lo.ver : ""), q.x + IS + 8, yy + 36, { role: "caption", color: T.text, w: tw, lines: 1, bg: T.card });
        UI.badge(st.bd, q.x + q.w - bw, yy + 2, { color: st.col, textColor: T.bg });
        var sy = yy + IS + 8, sh = top + bh - 16 - sy;
        var off = UI.scrollBegin("det:" + j.pkg, q.x, sy, q.w, sh, 420), x = q.x, w = q.w, y = sy - off + 2;
        // trava de versao (so faz sentido com o app instalado): desligada, o
        // app nao entra na rotina das 02:00 nem no "Atualizar tudo"; o botao
        // Atualizar abaixo continua valendo.
        if (lo) { var pn = PIN(j.pkg);
            UI.text("Atualizar automaticamente", x, y + 6, { role: "caption", color: pn ? T.textDim : T.text, w: w - 56, lines: 1, bg: T.card });
            if (UI.toggle(x + w - 44, y, pn, { id: "pin" }) !== pn) { SETPIN(j.pkg, !pn); pn = !pn; }
            y += 28;
            if (!pn) { y += UI.text("Versão travada em v" + lo.ver + " (o lote e a madrugada não trocam sozinhos).",
                                    x, y, { role: "caption", color: T.textDim, w: w, lines: 2, bg: T.card }) + 4; } }
        tx("Permissões", x, y, T.textDim, "caption", 100, 1, T.card); tx(pmt(j.perms), x + w - 10, y, T.text, "caption", w - 110, 1, T.card, "right"); y += 27;
        tx("Descrição", x, y, T.accent, "caption", 0, 1, T.card); y += 15;
        y += UI.text(String(j.desc || "Sem descrição.").replace(/\n/g, " "), x, y, { role: "caption", color: T.textDim, w: w, lines: 4, bg: T.card }) + 6;
        tx("Novidades", x, y, T.accent, "caption", 0, 1, T.card); y += 15;
        y += UI.text(String(j.changelog || "Sem notas.").replace(/\n/g, " "), x, y, { role: "caption", color: T.textDim, w: w, lines: 8, bg: T.card });
        if (conf) { y += 8; tx("Instalado v" + lo.ver + " é mais novo que o hub (v" + j.ver + ").", x, y, T.warn, "caption", w, 2, T.card); }
        else if ((j.api || 1) > API) { y += 8; tx("Requer API " + j.api + " (aqui: " + API + ").", x, y, T.warn, "caption", w, 2, T.card); }
        else if (st.code === "hw") { y += 8; tx("Exige PSRAM: a RAM interna não basta.", x, y, T.warn, "caption", w, 2, T.card); }
        UI.scrollEnd(); } });

    var can = !!j.appUrl && st.code !== "api" && st.code !== "hw";
    if (can) { var lbl = (st.code === "upd" || st.code === "pin") ? "Atualizar" : st.code === "dep" ? "Atualizar engine" : st.code === "inst" ? "Reinstalar" : "Instalar";
        if (A.style.button(lbl, L.x, fy, lo ? 108 : L.w, 30, { variant: "primary" })) {
            if (conf && st.code === "inst" && !UI.confirm("Versão", "Local v" + lo.ver + " > hub v" + j.ver + ". Reinstalar a do hub?", { yes: "Reinstalar" })) return;
            if (!lo && !CNS(j)) return; return st.code === "dep" ? "deps" : "install"; }
        if (lo && A.style.button("Desinstalar", L.x + 116, fy, 108, 30, { variant: "danger" })) { if (uf(j)) return A.BACK; }
    } else if (lo && A.style.button("Desinstalar", L.x, fy, L.w, 30, { variant: "danger" })) { if (uf(j)) return A.BACK; }
    else if (!lo) A.style.button("Indisponível", L.x, fy, L.w, 30, { variant: "ghost", disabled: true }); }

// erro de rede/instalacao: overlay padrao do kit (OK) e tenta de novo; o X
// da topbar do sistema continua saindo do app.
function ERS() { A.error(em || "Erro", eh || ""); return rm === "install" ? "install" : "load"; }
// sem Wi-Fi: A.wifiWait consulta Net.isConnected e tem Cancelar (sai).
function WFS() { return A.wifiWait("Conecte o Wi-Fi para usar a loja.") ? "load" : A.BACK; }

// ---- instalacao ------------------------------------------------------------
function PKF(j) { var out = [{ name: "main.js", url: j.appUrl, md5: j.md5 }], base = ""; if (j.appUrl) base = j.appUrl.substring(0, j.appUrl.lastIndexOf("/") + 1);
    for (var n in (j.files || {})) { if (n === "icon.png" || n === "main.js" || n === "app.json") continue;
        out.push({ name: n, url: base + n, md5: (j.files[n] || {}).md5 || "" }); } return out; }
function PKT(j) { var n = j.size || 0, fn; for (fn in (j.files || {})) if (j.files.hasOwnProperty(fn)) n += (j.files[fn] || {}).size || 0; return n; }
// Pacote unico (API 42): it.zip = {url,size,md5} do hub + System.installZip.
// Qualquer ausencia cai no caminho por arquivo (firmware antigo ou zip ruim).
function ZIPI(j) { if (!j || !j.zip || !j.zip.url || !j.zip.md5) return null; if (typeof System.installZip !== "function") return null; return j.zip; }
function ZIPN(n) { n = String(n || ""); return n.length > 0 && n.length <= 40 && n.indexOf("/") < 0 && n.indexOf("..") < 0; }

// ---- atualizacao de engine -------------------------------------------------
function SDU() { du = {}; if (!di) return; System.delay(1); for (var pk in lm2) if (lm2.hasOwnProperty(pk)) { var j = CBP(pk);
        if (!j || !j.deps) continue; var have = null; try { have = JSON.parse(FS.readTextFile(lm2[pk].dir + "/deps.json")); } catch (e) { have = null; }
        if (!have) continue; var fresh = resolveDeps(j.deps, di); if (!fresh) continue; var names = [], nm;
        for (nm in fresh) if (fresh.hasOwnProperty(nm)) if (String(have[nm] || "") !== fresh[nm]) names.push(nm);
        if (names.length) { names.sort(); du[pk] = { names: names, resolved: fresh, have: have }; } } }
function DBO(res, ix) { var n = 0, nm; for (nm in res) if (res.hasOwnProperty(nm)) n += (ix[nm] && ix[nm][res[nm]] && ix[nm][res[nm]].size) || 0; return n; }
function UD() { var j = si; if (!j) return "err"; em = ""; eh = ""; rm = "install"; wu = true; su = false;
    if (!Net.isConnected()) { em = "Sem conexão WiFi"; return "err"; } dl(j.name, "dependências", false); System.delay(30);
    // resolucao FRESCA: o snapshot do SDU pode ter ficado para tras
    var ix = gd() || di; if (!ix) { em = "Índice de deps indisponível"; eh = j.name; return "err"; }
    var res = resolveDeps(j.deps || {}, ix); if (!res) { em = "Dep indisponível"; eh = j.name; return "err"; }
    var fl = 0; try { fl = FS.getFreeSpace("/local"); } catch (e) { fl = 0; } if (fl > 0 && fl < DBO(res, ix) + 8192) { em = "Sem espaço p/ deps"; eh = j.name; return "err"; }
    var fail = idp(j, res, ix); if (fail) { em = fail; eh = j.name; return "err"; }
    var d = lm2[j.pkg] ? lm2[j.pkg].dir : RID(j.pkg); if (!d || !FS.writeTextFile(d + "/deps.json", JSON.stringify(res))) {
        em = "Erro no deps.json"; eh = j.name; return "err"; } System.rescanApps(); RFS(); return "done"; }

function IA() { var j = si; if (!j) return "err"; if (SI(j).code === "hw") { em = "Incompatível com esta placa"; eh = "Este app exige PSRAM."; return "err"; }
    rm = "install"; wu = SI(j).code === "upd"; su = false; var d = RID(j.pkg); if (!d) d = (ios() ? "/sd/apps" : "/local/apps") + "/" + j.pkg;
    var RT = d.substring(0, d.lastIndexOf("/")), zip = ZIPI(j), fail = "", json = "", meta = null; if (!Net.isConnected()) fail = "Sem conexão WiFi";
    if (!fail && ios() && sf === 0) fail = "Sem cartão SD";
    // espaco antes do download: novo + copia ativa (staging .new convive) + zip
    var need = PKT(j) + 16384 + (zip ? (zip.size || 0) + 8192 : 0); if (FS.isDirectory(d)) need += PKT(j);
    var free = 0; try { free = FS.getFreeSpace(RT); } catch (e) { free = 0; } if (!fail && free > 0 && free < need) fail = "Sem espaço no disco";
    // app.json primeiro: fonte de files/requires/permissoes no install (o
    // catalogo compacto nao traz). Multi-arquivo sem meta = falha clara.
    if (!fail && j.metaUrl) { dl(j.name, "app.json", false); System.delay(30); json = gt(j.metaUrl); if (!json) fail = "Erro no app.json";
        else { try { meta = JSON.parse(json); } catch (e) { meta = null; } } }
    var hadFiles = !!j.files; if (!fail && meta) { if (!j.files && meta.files) j.files = meta.files; if ((!j.req || !j.req.length) && meta.requires) j.req = meta.requires;
        if (meta.permissions) j.perms = meta.permissions; if (j.nfiles > 0 && !j.files) fail = "app.json inválido";
        if (!lm2[j.pkg] && !j.consented && !CNS(j)) fail = "Instalação cancelada";
        if (!hadFiles && j.files && free > 0) { var extra = 0, en; for (en in j.files) if (j.files.hasOwnProperty(en)) extra += (j.files[en] || {}).size || 0;
            if (free < need + extra) fail = "Sem espaço no disco"; } }
    // deps primeiro: falha no meio so deixa modulo orfao no cache (o GC do
    // launcher recolhe); deps vivem no /local, mesmo com app no SD.
    var ix = null, dep = null; if (!fail && meta && meta.deps) { dl(j.name, "dependências", false); System.delay(30); ix = gd() || di;
        if (!ix) fail = "Índice de deps indisponível"; else if (!(dep = resolveDeps(meta.deps, ix))) fail = "Dep indisponível";
        if (dep) { var fl = 0; try { fl = FS.getFreeSpace("/local"); } catch (e) { fl = 0; }
            if (fl > 0 && fl < DBO(dep, ix) + 8192) fail = "Sem espaço p/ deps"; } }
    if (!fail && dep) fail = idp(j, dep, ix); if (!fail && !FS.isDirectory(RT) && !FS.mkdir(RT)) fail = "Erro no disco";
    // pacote unico: so no /local (o installZip nao escreve no SD), nome valido
    // e livre; falha do zip cai no caminho por arquivo.
    if (!fail && PS && zip && !ios() && d.indexOf("/local/apps/") === 0 && ZIPN(j.name)) { var zdir = "/local/apps/" + j.name, zBusy = false;
        if (FS.isDirectory(zdir)) { var zj = null; try { zj = JSON.parse(FS.readTextFile(zdir + "/app.json")); } catch (e0) { zj = null; }
            zBusy = !!(zj && zj.packageName && zj.packageName !== j.pkg); }
        if (!zBusy) { var zpath = "/local/appstore_install.zip"; dl(j.name, "pacote", true); System.delay(30); var zok = false;
            try { zok = Net.download(HU(zip.url), zpath, function (g, t) { pg(g, t); }); } catch (e1) { zok = false; }
            var zmd = zok ? M(zpath) : "";
            if (zok && zmd === zip.md5) { var zr = null; try { zr = System.installZip(zpath, j.name); } catch (e3) { zr = null; } D(zpath);
                if (zr && zr.ok) { if (dep && !FS.writeTextFile(zdir + "/deps.json", JSON.stringify(dep))) { em = "Erro no deps.json"; eh = j.name; return "err"; }
                    try { RSH(j.pkg, zdir); } catch (e5) {} System.rescanApps(); RFS(); if (j.pkg === SP) su = true; return "done"; }
                try { FS.removeDirectory(zdir + ".new"); } catch (e6) {} } else { D(zpath); } } }
    if (!fail && !FS.isDirectory(d) && !FS.mkdir(d)) fail = "Erro no disco"; var st = [];
    if (!fail) { var fs2 = PKF(j), fi, fe, tm, ok, md; for (fi = 0; fi < fs2.length && !fail; fi++) { fe = fs2[fi]; tm = d + "/" + fe.name + ".new";
            dl(j.name, fe.name); System.delay(30); ok = false;
            ok = N(fe.url, tm, function (g, t) { pg(g, t); });
            if (!ok) { D(tm); fail = "Erro ao baixar " + fe.name; break; } /* .new parcial sai (igual ao md5) */ if (fe.md5) { md = M(tm);
                if (md !== fe.md5) { D(tm); fail = "MD5 falhou"; break; } } st.push([tm, d + "/" + fe.name]); }
        // app.json entra no MESMO lote: a versao nova so aparece com os arquivos
        if (!fail && json) { var jt = d + "/app.json.new"; if (!FS.writeTextFile(jt, json)) fail = "Erro ao gravar app.json"; else st.push([jt, d + "/app.json"]); }
        if (fail) { for (var x = 0; x < st.length; x++) { D(st[x][0]); } D(d + "/main.js.new"); } }
    if (!fail) for (var r2 = 0; r2 < st.length && !fail; r2++) if (!FS.renameFile(st[r2][0], st[r2][1])) fail = "Erro ao gravar " + bn(st[r2][1]);
    // deps por ULTIMO: app + cache prontos, este e o commit do conjunto
    if (!fail && dep && !FS.writeTextFile(d + "/deps.json", JSON.stringify(dep))) fail = "Erro no deps.json"; if (!fail) { if (j.icon) {
            var it2 = d + "/icon.png.new"; dl(j.name, "icon.png", false); System.delay(30); var iok = false;
            try { iok = Net.download(HU(j.icon), it2); } catch (e) { iok = false; }
            if (!(iok && FS.renameFile(it2, d + "/icon.png"))) { D(it2); }
        } else if (FS.exists(d + "/icon.png")) FS.deleteFile(d + "/icon.png");
        // orfaos: a pasta e espelho do pacote; update que removeu modulo/asset
        // (ou .new de tentativa antiga) nao deixa lixo. deps.json e do installer.
        try { var keep = { "app.json": 1, "main.js": 1, "icon.png": 1 }, fn2; for (fn2 in (j.files || {})) keep[fn2] = 1; if (dep) keep["deps.json"] = 1;
            var l3 = FS.listDir(d) || []; for (var li = 0; li < l3.length; li++) if (!FS.isDirectory(l3[li]) && !keep[bn(l3[li])]) FS.deleteFile(l3[li]); } catch (e) {} }
    if (fail) { em = fail; eh = j.name; return "err"; } try { RSH(j.pkg, d); } catch (e) {} System.rescanApps(); RFS(); if (j.pkg === SP) su = true;
    return "done"; }

// "Atualizar tudo": sequencial; a propria loja (self-update) vai por ultimo.
// Guarda ITENS (nao indices): IA -> RFS() reordena ap[].
function UA() { var ord = []; for (var i = 0; i < ap.length; i++) { var c = SI(ap[i]).code; if (c === "upd" || c === "dep") ord.push(ap[i]); }
    ord.sort(function (a, b) { return (a.pkg === SP ? 1 : 0) - (b.pkg === SP ? 1 : 0); }); bo = 0; bf = []; su = false; for (var k = 0; k < ord.length; k++) {
        si = ord[k]; A.progress(Math.round(k * 100 / ord.length), "Atualizando " + (k + 1) + "/" + ord.length + ": " + si.name);
        System.delay(20); em = "";
        var r = SI(si).code === "dep" ? UD() : IA(); if (r === "done") bo++; else bf.push(si.name + (em ? " (" + em + ")" : "")); }
    return "batchDone"; }

// ---- telas de fluxo --------------------------------------------------------
function LDS(c) { return LCA() === "err" ? "err" : "home"; } function INS(c) { if (IA() !== "done") return "err"; if (su) {
        A.ok("App Store atualizada!", [si.name, "Reabra para rodar a v" + si.ver]); return A.EXIT; } var lo = lm2[si.pkg];
    A.ok(wu ? "Atualizado!" : "Instalado!", [si.name, "v" + si.ver + (lo && lo.sd ? " · no cartão SD" : ""), "Pronto no launcher."]); return RT("home"); }
function DPS(c) { if (UD() !== "done") return "err"; A.ok("Engine atualizada", [si.name, "deps.json regravado."]);
    return RT("home"); } function BTS(c) { UA(); var lines = [bo + (bo === 1 ? " app atualizado" : " apps atualizados")];
    for (var i = 0; i < bf.length && i < 3; i++) lines.push("falhou: " + bf[i]); if (bf.length) A.error("Terminado com falhas", lines);
    else A.ok("Tudo atualizado!", lines); if (su) { A.ok("App Store atualizada!", ["Saia e abra de novo."]); return A.EXIT; } return RT("home"); }

// ---- fluxo principal -------------------------------------------------------
// No harness nao entra no A.run: expoe as funcoes puras e de instalacao para
// os checks de update/self-update/deps (test/js_harness/run.js).
if (typeof __harness !== "undefined" && __harness.storeTest) { __harness.storeTest({ cmpV: cmpV, depRangeOk: depRangeOk, resolveDeps: resolveDeps,
        hubUrl: HU, hubToken: HT, resetToken: U.resetToken, fetchText: gt, stateInfo: SI, scanLocalApps: SCA,
        resolveInstalledDir: RID, uninstallApp: UN, updateAll: UA, setDepIndex: function (x) { di = x; },
        depUpdates: function () { return du; }, updateDepsFlow: UD, updCount: function () { return uc; }, refresh: RFS,
        setCatalog: function (a) { ap = a; si = a.length ? a[0] : null; RFS(); }, catalog: function () { return ap; }, installApp: IA, fmtKB: fk,
        parseCompactCatalog: PCC, parseDepsField: PDF, cats: function () { return ct; }, setCat: function (c) { cc = c; BVW(); },
        filtered: FAP, installed: IIS, selfUpdatedFlag: function () { return su; }, batchStats: function () { return { ok: bo, fails: bf }; },
        // rotina automatica e trava de versao (o mesmo motor do service.js)
        cfg: function () { return CFG(); }, pinned: PIN, setPin: SETPIN, setAuto: SETAUTO, auto: function () { return CFG().auto !== false; },
        planUpdates: function (c, n) { return U.planUpdates(lm2, c, n); }, dueNow: U.dueNow, hourOf: U.hourOf,
        updateOne: function (c) { return U.updateOne(c, null); }, engine: U,
        select: function (pkg) { var j = CBP(pkg); if (j) si = j; return j; } }); } else { var f0; if (FS.exists(CA)) { A.busy("Abrindo catálogo...");
        f0 = LCC() ? "home" : (Net.isConnected() ? "load" : "wifi"); } else f0 = Net.isConnected() ? "load" : "wifi";
    A.run({ home: HM, load: LDS, wifi: WFS, err: ERS, detail: DT, install: INS, deps: DPS, batch: BTS },
          f0, { fps: 20 }); }
