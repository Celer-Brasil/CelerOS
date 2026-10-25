// Celer Agent - service.js (API 50).
//
// O trabalho de frota roda aqui, fora do foreground: heartbeat no plano de
// controle (celeros.cloud), comandos do CelerApp e atualizacao do aparelho.
//
// Comandos aceitos (payload da RPC celer_enqueue_device_command):
//   reboot       -> confirma no plano de controle e reinicia
//   sync         -> forca o proximo heartbeat
//   diagnostics  -> devolve um retrato do aparelho no evento
//   os_update    -> System.otaCheck + System.otaStart (bancada; ver secao 50
//                   do JS_API_Guide: o OTA ainda nao valida assinatura)
//   update_apps  -> {packages:[pkg|{pkg,name,zip}]}; sem lista, todos os apps
//   self_update  -> baixa e instala o proprio celeros.agent; Service.stop()
//
// O app.zip vem do hub (/store/apps/<pkg>/app.json -> zip.md5) e o md5 e
// conferido no FS antes do System.installZip. Um pacote com erro nao aborta
// os demais: cada um vira um evento; o comando so e ackado no fim.
//
// ES5 (Duktape). Nunca chame present()/UI daqui: o svchost nao tem vidro.

var cloud = require("celeros.cloud");

var CONFIG_PATH = "/local/celercloud.json";
var DEFAULT_HUB = "https://os.celer.tec.br";
var OTA_PENDING = "ota_pending";
var LAST_BEAT = "last_beat";
var LAST_RESULT = "last_result";
var LAST_ERROR = "last_error";
var MAX_PACKAGES = 16;
var DEFAULT_POLL_MS = 30000;
var SELF_PKG = "celeros.agent";

var cfg = null;
var busy = false;
var started = false;
var lastConfigLog = 0;

function log(msg) {
    try { System.print("[agent] " + msg); } catch (e) {}
}

function nowMs() {
    try { return System.millis(); } catch (e) { return 0; }
}

function epochSeconds() {
    try {
        if (typeof System.epoch === "function") return Number(System.epoch()) || 0;
    } catch (e) {}
    return Math.floor(Date.now() / 1000);
}

function readText(path) {
    try { return FS.readTextFile(path); } catch (e) { return ""; }
}

function readJson(path) {
    var text = readText(path);
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
}

function readConfig() {
    var doc = readJson(CONFIG_PATH);
    if (!doc) return null;
    return doc;
}

function hubBase() {
    var base = (cfg && cfg.hubUrl) ? String(cfg.hubUrl) : DEFAULT_HUB;
    while (base.length > 1 && base.charAt(base.length - 1) === "/") {
        base = base.slice(0, -1);
    }
    return base;
}

function pollMs() {
    var n = (cfg && typeof cfg.pollMs === "number") ? cfg.pollMs : DEFAULT_POLL_MS;
    if (n < 5000) n = 5000;
    if (n > 300000) n = 300000;
    return n;
}

function appData() {
    var dir = "";
    try { dir = FS.appData(); } catch (e) { dir = ""; }
    if (!dir) dir = "/local/data/" + SELF_PKG + "/";
    if (dir.charAt(dir.length - 1) !== "/") dir += "/";
    return dir;
}

function stagingDir() {
    var dir = appData() + "staging";
    try {
        if (!FS.isDirectory(dir)) FS.mkdir(dir);
    } catch (e) {}
    return dir;
}

function safeFile(pkg) {
    return String(pkg).replace(/[^A-Za-z0-9_.-]/g, "_");
}

function stagingPath(pkg) {
    return stagingDir() + "/" + safeFile(pkg) + ".zip";
}

function baseName(path) {
    var p = String(path);
    while (p.length > 1 && p.charAt(p.length - 1) === "/") p = p.slice(0, -1);
    var i = p.lastIndexOf("/");
    return i >= 0 ? p.slice(i + 1) : p;
}

function versionNum(value) {
    var parts = String(value || "").split(".");
    var out = [];
    for (var i = 0; i < 3; i++) {
        var n = parseInt(parts[i], 10);
        out.push(isNaN(n) ? 0 : n);
    }
    return out;
}

function isNewer(a, b) {
    var va = versionNum(a), vb = versionNum(b);
    for (var i = 0; i < 3; i++) {
        if (va[i] !== vb[i]) return va[i] > vb[i];
    }
    return false;
}

function rangeSatisfied(version, range) {
    range = String(range || "").replace(/^[\s]+|[\s]+$/g, "");
    if (!range) return false;
    if (range.charAt(0) === "^") {
        var vb = versionNum(version), vr = versionNum(range.slice(1));
        if (vb[0] !== vr[0]) return false;
        if (vb[1] !== vr[1]) return vb[1] > vr[1];
        return vb[2] >= vr[2];
    }
    return String(version) === range;
}

function pickDepVersion(index, name, ranges) {
    var versions = index && index[name];
    if (!versions) return "";
    var best = "";
    for (var v in versions) {
        if (!versions.hasOwnProperty(v)) continue;
        var ok = true;
        for (var i = 0; i < ranges.length; i++) {
            if (!rangeSatisfied(v, ranges[i])) { ok = false; break; }
        }
        if (!ok) continue;
        if (!best || isNewer(v, best)) best = v;
    }
    return best;
}

var depsIndexCache = null;
var depsIndexAt = 0;

// Indice de deps do hub: /store/deps.json passa do teto de 32 KB do
// Net.request, entao vai por Net.download para o staging.
function depsIndex(force) {
    var now = nowMs();
    if (!force && depsIndexCache && (now - depsIndexAt) < 600000) {
        return depsIndexCache;
    }
    var path = stagingDir() + "/deps_index.json";
    try {
        if (FS.exists(path)) FS.deleteFile(path);
        if (!Net.download(hubUrl("/store/deps.json"), path)) return null;
        var doc = readJson(path);
        if (FS.exists(path)) FS.deleteFile(path);
        if (!doc || !doc.deps) return null;
        depsIndexCache = doc.deps;
        depsIndexAt = now;
        return depsIndexCache;
    } catch (e) {
        try { if (FS.exists(path)) FS.deleteFile(path); } catch (e2) {}
        return null;
    }
}

function modulePath(name, version) {
    return "/local/modules/" + name + "/" + version + "/" + name + ".js";
}

function ensureModule(name, version, entry) {
    if (!entry || !entry.url) return false;
    var path = modulePath(name, version);
    var md5 = String(entry.md5 || "").toLowerCase();
    try {
        if (FS.exists(path) &&
            (!md5 || String(FS.getFileMD5(path) || "").toLowerCase() === md5)) {
            return true;
        }
    } catch (e) {}
    var base = "/local/modules/" + name;
    var dir = base + "/" + version;
    try {
        if (!FS.isDirectory("/local/modules")) FS.mkdir("/local/modules");
        if (!FS.isDirectory(base)) FS.mkdir(base);
        if (!FS.isDirectory(dir)) FS.mkdir(dir);
    } catch (e2) {}
    try {
        if (FS.exists(path)) FS.deleteFile(path);
        if (!Net.download(withHubToken(String(entry.url)), path)) return false;
        if (md5 && String(FS.getFileMD5(path) || "").toLowerCase() !== md5) {
            FS.deleteFile(path);
            return false;
        }
        return true;
    } catch (e3) {
        try { if (FS.exists(path)) FS.deleteFile(path); } catch (e4) {}
        return false;
    }
}

// Fecho de deps do app.json contra /store/deps.json (mesma semantica de
// range do hub: ^x.y.z no mesmo major ou versao exata). Devolve
// {versions} ou {error}; os modulos sao baixados/verificados antes do
// app.zip para um erro nao trocar o app por uma versao quebrada.
function resolveDeps(deps) {
    var index = depsIndex(false);
    if (!index) return { error: "indice de deps indisponivel" };
    var wanted = {};
    var queue = [];
    var name;
    for (name in deps) {
        if (!deps.hasOwnProperty(name)) continue;
        wanted[name] = [String(deps[name])];
        queue.push(name);
    }
    var picked = {};
    var guard = 0;
    while (queue.length && guard++ < 64) {
        name = queue.shift();
        var version = pickDepVersion(index, name, wanted[name]);
        if (!version) return { error: "dep sem versao: " + name };
        if (picked[name] !== version) {
            picked[name] = version;
            var entry = index[name][version];
            var sub = (entry && entry.deps) ? entry.deps : {};
            for (var sn in sub) {
                if (!sub.hasOwnProperty(sn)) continue;
                var r = String(sub[sn]);
                if (!wanted[sn]) wanted[sn] = [];
                var known = false;
                for (var wi = 0; wi < wanted[sn].length; wi++) {
                    if (wanted[sn][wi] === r) known = true;
                }
                if (!known) wanted[sn].push(r);
                queue.push(sn);
            }
        }
    }
    if (guard >= 64) return { error: "deps: fecho nao converge" };
    for (name in picked) {
        if (!picked.hasOwnProperty(name)) continue;
        for (var ri = 0; ri < wanted[name].length; ri++) {
            if (!rangeSatisfied(picked[name], wanted[name][ri])) {
                return { error: "dep conflita: " + name };
            }
        }
    }
    for (name in picked) {
        if (!picked.hasOwnProperty(name)) continue;
        if (!ensureModule(name, picked[name], index[name][picked[name]])) {
            return { error: "dep download falhou: " + name + "@" + picked[name] };
        }
    }
    return { versions: picked };
}

function writeDepsFile(folder, versions) {
    var parts = [];
    var name;
    for (name in versions) {
        if (!versions.hasOwnProperty(name)) continue;
        parts.push(JSON.stringify(name) + ":" + JSON.stringify(versions[name]));
    }
    if (!parts.length) return true;
    try {
        return FS.writeTextFile("/local/apps/" + folder + "/deps.json",
            "{" + parts.join(",") + "}");
    } catch (e) {
        return false;
    }
}

function installedApps() {
    var out = [];
    var seen = {};
    var roots = ["/local/apps", "/sd/apps"];
    for (var r = 0; r < roots.length; r++) {
        var root = roots[r];
        if (!FS.isDirectory(root)) continue;
        var list = FS.listDir(root);
        for (var i = 0; i < list.length; i++) {
            var dir = list[i];
            if (!FS.isDirectory(dir)) continue;
            var doc = readJson(dir + "/app.json");
            if (!doc || !doc.packageName || seen[doc.packageName]) continue;
            seen[doc.packageName] = true;
            out.push({
                pkg: String(doc.packageName),
                version: String(doc.version || ""),
                name: String(doc.name || baseName(dir)),
                folder: baseName(dir)
            });
            if (out.length >= 32) return out;
        }
    }
    return out;
}

function findInstalled(pkg, apps) {
    for (var i = 0; i < apps.length; i++) {
        if (apps[i].pkg === pkg) return apps[i];
    }
    return null;
}

function heartbeatExtra() {
    var info = null;
    try { info = System.getInfo(); } catch (e) { info = null; }
    var apps = installedApps();
    var list = [];
    for (var i = 0; i < apps.length && i < 32; i++) {
        list.push({ pkg: apps[i].pkg, version: apps[i].version });
    }
    return {
        kind: (cfg && cfg.kind) ? String(cfg.kind) : "generic",
        label: (cfg && cfg.label) ? String(cfg.label) : "",
        board: (cfg && cfg.board) ? String(cfg.board) : (info && info.board ? String(info.board) : ""),
        uptimeS: info && typeof info.uptimeMs === "number" ? Math.floor(info.uptimeMs / 1000) : 0,
        apps: list,
        caps: {
            agent: true,
            ota: true,
            apps: true,
            reboot: true,
            private_hub: hubToken() ? true : false
        },
        resources: []
    };
}

// Token de leitura do hub privado: a loja privada grava /local/hub_token.txt
// (uma linha, escopo private + tenant) e a App Store 2.9.4+ usa o mesmo
// arquivo. O agente aceita hubToken no celercloud.json e cai para o arquivo
// — assim o setup do totem nao precisa duplicar o segredo.
function hubToken() {
    var token = (cfg && cfg.hubToken) ? String(cfg.hubToken) : "";
    if (!token) {
        var raw = readText("/local/hub_token.txt");
        if (raw) token = String(raw).replace(/[\r\n\t ]/g, "");
    }
    return token;
}

// So o NOSSO hub recebe o token: prefixo "https://host.evil" ou
// "https://host@evil" nao pode levar a credencial para terceiros.
function withHubToken(url) {
    var token = hubToken();
    if (!token || !url) return url;
    var base = hubBase();
    if (String(url).indexOf(base + "/") !== 0) return url;
    return url + (String(url).indexOf("?") >= 0 ? "&" : "?") +
        "token=" + encodeURIComponent(token);
}

function hubUrl(path) {
    return withHubToken(hubBase() + path);
}

function hubJson(path) {
    try {
        var token = hubToken();
        var opts = {
            url: hubUrl(path),
            method: "GET",
            timeoutMs: 8000
        };
        if (token) {
            opts.headers = {
                apikey: token,
                Authorization: "Bearer " + token
            };
        }
        var res = Net.request(opts);
        if (!res || res.status !== 200 || !res.body) return null;
        return JSON.parse(res.body);
    } catch (e) {
        return null;
    }
}

function updateGate() {
    try {
        // appOpen NAO bloqueia: o totem roda o app da vertical em autostart
        // e ficaria sem update para sempre. O comando e explicito do admin
        // (o CelerApp avisa); o installZip troca a pasta e o OTA reinicia.
        if (System.updateBusy()) return "atualizacao em curso";
        if (System.shellActive()) return "shell ativo";
        var wifi = System.wifiStatus();
        if (!wifi || !wifi.connected) return "sem wifi";
    } catch (e) {
        return "estado do aparelho indisponivel";
    }
    return "";
}

function hubMeta(pkg) {
    return hubJson("/store/apps/" + encodeURIComponent(pkg) + "/app.json");
}

// Baixa, confere o md5 e troca a pasta. Devolve {ok,version,folder,skipped,error}.
function installPackage(pkg, item, apps) {
    if (typeof System.installZip !== "function") {
        return { ok: false, error: "firmware sem System.installZip" };
    }
    var installed = findInstalled(pkg, apps);
    var meta = hubMeta(pkg);
    if (!meta) return { ok: false, error: "app nao publicado no hub" };

    var hubVersion = String(meta.version || "");
    if (!hubVersion) return { ok: false, error: "hub sem versao" };
    if (installed && installed.version && !isNewer(hubVersion, installed.version)) {
        return { ok: true, skipped: true, version: installed.version };
    }
    var api = parseInt(meta.api, 10);
    if (!isNaN(api) && api > (Number(System.getAPILevel()) || 0)) {
        return { ok: false, error: "app exige API " + api };
    }
    var depVersions = null;
    if (meta.deps && typeof meta.deps === "object") {
        var hasDep = false;
        for (var dn in meta.deps) if (meta.deps.hasOwnProperty(dn)) hasDep = true;
        if (hasDep) {
            var depResult = resolveDeps(meta.deps);
            if (!depResult || depResult.error) {
                return { ok: false, error: depResult ? depResult.error : "deps indisponiveis" };
            }
            depVersions = depResult.versions;
        }
    }
    var zip = meta.zip || (item && item.zip) || null;
    if (!zip || !zip.md5) return { ok: false, error: "hub sem app.zip/md5" };

    var url = (item && item.zip && item.zip.url)
        ? withHubToken(String(item.zip.url))
        : hubUrl("/store/apps/" + encodeURIComponent(pkg) + "/app.zip");
    var md5 = String((item && item.zip && item.zip.md5) || zip.md5).toLowerCase();
    var folder = installed && installed.folder
        ? installed.folder
        : ((item && item.name) ? String(item.name) : (meta.name ? String(meta.name) : pkg));
    if (!folder || folder.length > 40 || folder.indexOf("/") >= 0 ||
        folder.indexOf("\\") >= 0 || folder.indexOf("..") >= 0) {
        return { ok: false, error: "nome de pasta invalido" };
    }

    var path = stagingPath(pkg);
    try {
        if (FS.exists(path)) FS.deleteFile(path);
        log("baixando " + pkg + " " + hubVersion);
        if (!Net.download(url, path)) {
            if (FS.exists(path)) FS.deleteFile(path);
            return { ok: false, error: "download falhou" };
        }
        var got = String(FS.getFileMD5(path) || "").toLowerCase();
        if (got !== md5) {
            FS.deleteFile(path);
            return { ok: false, error: "md5 divergente" };
        }
        var res = System.installZip(path, folder);
        if (FS.exists(path)) FS.deleteFile(path);
        if (!res || res.ok !== true) return { ok: false, error: "installZip recusou" };
        // O app.zip nao carrega deps.json: installZip trocou a pasta e o
        // require cairia no modulo errado/ausente. Grava o fecho resolvido
        // (modulos ja estao em /local/modules) antes de dar o update por bom.
        if (depVersions && !writeDepsFile(folder, depVersions)) {
            return { ok: false, error: "deps.json nao gravou" };
        }
        return { ok: true, version: hubVersion, folder: folder };
    } catch (e) {
        try { if (FS.exists(path)) FS.deleteFile(path); } catch (e2) {}
        return { ok: false, error: String(e) };
    }
}

function packageSpecs(payload, apps) {
    var raw = payload ? payload.packages : null;
    var out = [];
    if (raw && raw.length) {
        for (var i = 0; i < raw.length && out.length < MAX_PACKAGES; i++) {
            var item = raw[i];
            var pkg = typeof item === "string"
                ? item
                : (item && (item.pkg || item.packageName));
            if (!pkg) continue;
            pkg = String(pkg);
            if (pkg === SELF_PKG) continue;
            out.push({
                pkg: pkg,
                name: (item && item.name) ? String(item.name) : "",
                zip: (item && item.zip) ? item.zip : null
            });
        }
        return out;
    }
    for (var j = 0; j < apps.length && out.length < MAX_PACKAGES; j++) {
        if (apps[j].pkg === SELF_PKG) continue;
        out.push({ pkg: apps[j].pkg, name: apps[j].folder, zip: null });
    }
    return out;
}

function updateApps(payload) {
    var apps = installedApps();
    var specs = packageSpecs(payload, apps);
    if (!specs.length) {
        return { ok: false, error: "nenhum app para atualizar (use self_update para o agente)" };
    }
    var allOk = true;
    for (var i = 0; i < specs.length; i++) {
        var spec = specs[i];
        var res = installPackage(spec.pkg, spec, apps);
        cloud.report({
            type: res.ok ? "agent.app_update.done" : "agent.app_update.failed",
            severity: res.ok ? "info" : "warning",
            payload: {
                pkg: spec.pkg,
                version: res.version ? String(res.version) : "",
                skipped: res.skipped === true,
                error: res.error ? String(res.error) : ""
            }
        });
        if (!res.ok) allOk = false;
    }
    return { ok: allOk, error: allOk ? "" : "um ou mais apps falharam" };
}

function osUpdate() {
    var gate = updateGate();
    if (gate) return { retry: true, error: gate };
    if (typeof System.otaStart !== "function") {
        return { ok: false, error: "firmware sem System.otaStart (API 50)" };
    }
    var info = null;
    try { info = System.otaCheck(); } catch (e) {
        return { ok: false, error: "otaCheck: " + String(e) };
    }
    if (!info) return { ok: false, error: "otaCheck sem resposta" };
    if (info.fetchFailed) return { ok: false, error: "falha ao consultar o hub" };
    var version = String(info.version || "");
    if (info.rejected) {
        return { ok: false, error: String(info.type || "manifesto recusado") };
    }
    if (!info.available || info.hasFirmware === false) {
        return { ok: true, skipped: true, version: version };
    }
    if (!info.url) return { ok: false, error: "update.json sem firmware_url" };
    if (!version) return { ok: false, error: "update.json sem version" };
    var res = null;
    try {
        // Sem callback: o callback de progresso do svchost reentra no Duktape
        // durante o flash e firmware antigo (1.11.0) quebrava no trampoline.
        // O OtaManager alimenta o TWDT sozinho; o agente nao precisa de %.
        res = System.otaStart(info.url);
    } catch (e) {
        return { ok: false, error: "otaStart: " + String(e) };
    }
    if (!res || res.ok !== true) {
        return { ok: false, error: (res && res.error) ? String(res.error) : "otaStart falhou" };
    }
    Storage.set(OTA_PENDING, version);
    return { ok: true, version: version, reboot: true };
}

function selfUpdate() {
    var gate = updateGate();
    if (gate) return { retry: true, error: gate };
    var res = installPackage(SELF_PKG, { pkg: SELF_PKG }, installedApps());
    if (!res.ok) return res;
    if (res.skipped) return { ok: true, skipped: true, version: res.version || "" };
    return { ok: true, version: res.version || "", stop: true };
}

function diagnostics() {
    var info = null;
    try { info = System.getInfo(); } catch (e) { info = null; }
    var wifi = null;
    try { wifi = System.wifiStatus(); } catch (e) { wifi = null; }
    return {
        firmware: String(System.getOSVersion() || ""),
        apiLevel: Number(System.getAPILevel()) || 0,
        board: info && info.board ? String(info.board) : "",
        freeRam: info && typeof info.freeRAM === "number" ? info.freeRAM : 0,
        uptimeMs: info && typeof info.uptimeMs === "number" ? info.uptimeMs : 0,
        wifi: !!(wifi && wifi.connected),
        apps: installedApps().length,
        otaPending: String(Storage.get(OTA_PENDING, ""))
    };
}

function checkOtaResult() {
    var pending = String(Storage.get(OTA_PENDING, ""));
    if (!pending) return;
    var current = String(System.getOSVersion() || "");
    if (pending === current) {
        cloud.report({
            type: "agent.os_update.done",
            severity: "info",
            payload: { version: current }
        });
    } else {
        cloud.report({
            type: "agent.os_update.failed",
            severity: "warning",
            payload: { expected: pending, current: current }
        });
    }
    Storage.remove(OTA_PENDING);
}

// Tipos que este agente possui. open/close (e qualquer comando de outra
// vertical) ficam na fila para o app/servico dono: se o agente ackasse um
// comando alheio, o consumidor certo nunca o veria. Cada dono acka so o seu.
var AGENT_COMMANDS = {
    os_update: true,
    update_apps: true,
    self_update: true,
    reboot: true,
    sync: true,
    diagnostics: true
};

function ownsCommand(type) {
    return AGENT_COMMANDS[String(type)] === true;
}

function handleCommand(cmd) {
    var type = String(cmd.type || "");
    if (type === "reboot") {
        if (typeof System.restart !== "function") {
            return { ok: false, error: "firmware sem System.restart (API 50)" };
        }
        return { ok: true, reboot: true };
    }
    if (type === "sync") return { ok: true };
    if (type === "diagnostics") return { ok: true, diagnostics: diagnostics() };
    if (type === "os_update") return osUpdate();
    if (type === "update_apps") return updateApps(cmd.payload || {});
    if (type === "self_update") return selfUpdate();
    return { ok: false, error: "comando nao suportado: " + type };
}

function flush() {
    try { cloud.heartbeat(heartbeatExtra(), true); } catch (e) {}
}

function expired(cmd) {
    if (!cmd || !cmd.expires_at) return false;
    // Sem hora valida o epoch do aparelho pode ser 1970: nao expire nada
    // por conta propria (o servidor ja filtra expires_at no heartbeat).
    try {
        if (typeof System.timeValid === "function" && !System.timeValid()) return false;
    } catch (e) {
        return false;
    }
    var t = Date.parse(String(cmd.expires_at));
    if (isNaN(t)) return false;
    var now = epochSeconds();
    if (!now) return false;
    return t < (now * 1000);
}

function processCommands(cmds) {
    for (var i = 0; i < cmds.length; i++) {
        var cmd = cmds[i];
        if (!cmd || !cmd.id) continue;
        if (!ownsCommand(cmd.type)) continue;  // deixa para o dono (ex.: open/close)
        if (expired(cmd)) {
            cloud.report({
                type: "agent.command.expired",
                severity: "warning",
                payload: { id: String(cmd.id), command: String(cmd.type || "") }
            });
            cloud.ack(cmd.id);
            continue;
        }
        var res = null;
        try {
            res = handleCommand(cmd);
        } catch (e) {
            res = { ok: false, error: String(e) };
        }
        if (res && res.retry) {
            Storage.set(LAST_ERROR, String(res.error || "ocupado"));
            continue;
        }
        var payload = {
            id: String(cmd.id),
            command: String(cmd.type || ""),
            ok: res.ok === true,
            skipped: res.skipped === true,
            version: res.version ? String(res.version) : "",
            error: res.error ? String(res.error) : ""
        };
        if (res.diagnostics) payload.diagnostics = res.diagnostics;
        cloud.report({
            type: res.ok ? "agent.command.done" : "agent.command.failed",
            severity: res.ok ? "info" : "warning",
            payload: payload
        });
        cloud.ack(cmd.id);
        Storage.set(LAST_RESULT, String(cmd.type || "") + (res.ok ? " ok" : " falhou") +
            (res.error ? ": " + res.error : ""));
        if (res.reboot) {
            flush();
            System.restart();
            return;
        }
        if (res.stop) {
            flush();
            if (typeof Service !== "undefined" && Service.stop) Service.stop();
            return;
        }
    }
}

function tick() {
    if (busy) return;
    busy = true;
    try {
        if (!cloud.configured()) {
            if (!cloud.init()) {
                var why = cloud.lastError();
                Storage.set(LAST_ERROR, why);
                if (nowMs() - lastConfigLog > 60000) {
                    lastConfigLog = nowMs();
                    log("sem config: " + why);
                }
                return;
            }
            cfg = readConfig();
            log("configurado device=" + (cfg && cfg.deviceId ? cfg.deviceId : "?"));
            checkOtaResult();
        }
        var desired = cloud.heartbeat(heartbeatExtra(), true);
        if (desired === null) {
            Storage.set(LAST_ERROR, cloud.lastError());
            log("heartbeat falhou: " + cloud.lastError());
            return;
        }
        Storage.remove(LAST_ERROR);
        Storage.set(LAST_BEAT, String(epochSeconds()));
        var cmds = cloud.commands();
        if (cmds.length) processCommands(cmds);
    } catch (e) {
        Storage.set(LAST_ERROR, String(e));
        log("erro: " + String(e));
    } finally {
        busy = false;
    }
}

function start() {
    if (started) return;
    started = true;
    if (cloud.init()) {
        cfg = readConfig();
        log("iniciado device=" + (cfg && cfg.deviceId ? cfg.deviceId : "?"));
        checkOtaResult();
    } else {
        log("aguardando config: " + cloud.lastError());
    }
    tick();
    setInterval(tick, pollMs());
}

start();
