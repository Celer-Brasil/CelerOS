// estado.js - leitura do estado do agente de frota para o painel e o logcat.
// Sem UI e sem rede: so FS/Storage/System. O service.js e quem escreve as
// chaves (last_beat, last_result, last_error, ota_pending) e mantem as filas.

var C = "/local/celercloud.json";
var CM = "/local/cloud_commands.json";
var OB = "/local/cloud_outbox.json";
var CR = "/local/log/crash.txt";

function txt(p) {
    try { return FS.readTextFile(p) || ""; } catch (e) { return ""; }
}
function js(p, f) {
    var s = txt(p);
    if (!s) return f;
    try {
        var v = JSON.parse(s);
        return v === null || v === undefined ? f : v;
    } catch (e) { return f; }
}
function len(p) {
    var v = js(p, []);
    return v && typeof v.length === "number" ? v.length : 0;
}
function now() {
    try {
        if (typeof System.epoch === "function") return Number(System.epoch()) || 0;
    } catch (e) { /* sem epoch */ }
    return Math.floor(Date.now() / 1000);
}
function vn(s) {
    var a = String(s || "").split(".");
    var o = [];
    for (var i = 0; i < 3; i++) {
        var n = parseInt(a[i], 10);
        o.push(isNaN(n) ? 0 : n);
    }
    return o;
}
// firmware 1.11.6+ valida a assinatura ECDSA do manifesto
function signed() {
    var a = vn(System.getOSVersion());
    var b = [1, 11, 6];
    for (var i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return true;
}
function apps() {
    var n = 0, roots = ["/local/apps", "/sd/apps"];
    for (var r = 0; r < roots.length; r++) {
        try {
            if (!FS.isDirectory(roots[r])) continue;
            var list = FS.listDir(roots[r]);
            for (var i = 0; i < list.length; i++) {
                if (!FS.isDirectory(list[i])) continue;
                var doc = js(list[i] + "/app.json", null);
                if (doc && doc.packageName) n++;
            }
        } catch (e) { /* sem fs */ }
    }
    return n;
}
function age(sec) {
    if (!sec) return "nunca";
    var n = now();
    if (n < 1000000000) return "relogio sem hora";
    var d = n - sec;
    if (d < 0) d = 0;
    if (d < 5) return "agora";
    if (d < 60) return "há " + d + " s";
    if (d < 3600) return "há " + Math.floor(d / 60) + " min";
    return "há " + Math.floor(d / 3600) + " h";
}
function snap() {
    var cfg = js(C, null);
    var beat = Number(Storage.get("last_beat", "0")) || 0;
    var n = now();
    var info = null;
    try { info = System.getInfo(); } catch (e) { info = null; }
    var wifi = null;
    try { wifi = System.wifiStatus(); } catch (e) { wifi = null; }
    var crash = txt(CR);
    if (crash.length > 300) crash = crash.substring(crash.length - 300);
    var poll = (cfg && typeof cfg.pollMs === "number") ? cfg.pollMs : 30000;
    if (poll < 5000) poll = 5000;
    return {
        cfg: cfg,
        dev: cfg && cfg.deviceId ? String(cfg.deviceId) : "",
        kind: cfg && cfg.kind ? String(cfg.kind) : "generic",
        label: cfg && cfg.label ? String(cfg.label) : "",
        poll: poll,
        beat: beat,
        beatAge: beat ? Math.max(0, n - beat) : -1,
        age: age(beat),
        last: String(Storage.get("last_result", "")) || "",
        err: String(Storage.get("last_error", "")) || "",
        ota: String(Storage.get("ota_pending", "")) || "",
        cmds: len(CM),
        out: len(OB),
        apps: apps(),
        fw: String(System.getOSVersion() || ""),
        api: Number(System.getAPILevel()) || 0,
        board: info && info.board ? String(info.board) : "",
        ram: info && typeof info.freeRAM === "number" ? info.freeRAM : 0,
        up: info && typeof info.uptimeMs === "number" ? Math.floor(info.uptimeMs / 1000) : 0,
        psram: !!(info && info.totalPSRAM > 0),
        mic: !!(info && info.hasMic),
        audio: !!(info && info.hasAudio),
        bat: !!(info && info.hasBattery),
        wifi: !!(wifi && wifi.connected),
        signed: signed(),
        crash: crash
    };
}
// resumo do logcat (placas sem vidro): mesmas chaves da tela, sem acento
function lines() {
    var s = snap();
    var out = [];
    out.push("Plano de controle: " + (s.cfg ? s.dev + " / " + s.kind : "sem config em " + C));
    out.push("Firmware: " + s.fw + " (API " + s.api + ")");
    out.push("Ultimo heartbeat: " + (s.beat ? String(s.beat) : "nunca"));
    out.push("Ultimo comando: " + (s.last || "nenhum"));
    if (s.err) out.push("Ultimo erro: " + s.err);
    out.push("Apps: " + s.apps + "; fila: " + s.cmds + " comandos, " + s.out + " eventos");
    if (s.ota) out.push("OTA pendente: " + s.ota);
    out.push("os_update: bancada (OTA sem assinatura ate a fase 5)");
    return out;
}

module.exports = { snap: snap, lines: lines };
