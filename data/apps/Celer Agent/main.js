// Celer Agent - status (o trabalho vive no service.js).
//
// Headless: imprime no logcat. Com tela: painel de leitura com o estado do
// plano de controle, ultimo heartbeat e ultimo comando. Nada aqui desenha
// no vidro quando UI nao existe (devkit/esp32-cam).

var CONFIG_PATH = "/local/celercloud.json";

function readText(path) {
    try { return FS.readTextFile(path); } catch (e) { return ""; }
}

function readJson(path) {
    var text = readText(path);
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
}

function configSummary() {
    var cfg = readJson(CONFIG_PATH);
    if (!cfg) return "sem config em " + CONFIG_PATH;
    var id = cfg.deviceId ? String(cfg.deviceId) : "?";
    var kind = cfg.kind ? String(cfg.kind) : "generic";
    return id + " / " + kind;
}

function lines() {
    var out = [];
    out.push("Plano de controle: " + configSummary());
    out.push("Firmware: " + String(System.getOSVersion()) + " (API " + System.getAPILevel() + ")");
    out.push("Ultimo heartbeat: " + (Storage.get("last_beat", "") || "nunca"));
    out.push("Ultimo comando: " + (Storage.get("last_result", "") || "nenhum"));
    var err = Storage.get("last_error", "");
    if (err) out.push("Ultimo erro: " + err);
    out.push("os_update: bancada (OTA sem assinatura ate a fase 5)");
    return out;
}

if (typeof UI === "undefined") {
    while (true) {
        var ls = lines();
        for (var i = 0; i < ls.length; i++) System.print("[agent] " + ls[i]);
        System.delay(5000);
    }
} else {
    var theme = null;
    try { theme = System.theme(); } catch (e) { theme = null; }
    var bg = theme && theme.bg !== undefined ? theme.bg : 0;
    var dim = theme ? { role: "caption", color: theme.textDim } : { role: "caption" };
    while (true) {
        UI.begin(bg);
        if (UI.header("Celer Agent", { back: true })) System.exitApp();
        var ls = lines();
        var y = 48;
        for (var j = 0; j < ls.length; j++) {
            UI.text(ls[j], 12, y, dim);
            y += 20;
        }
        UI.end();
    }
}
