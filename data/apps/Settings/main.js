// CelerOS Settings — app de sistema (W8): PIN, Wi-Fi, apps, hora, seguranca,
// tela, som, relogio, OTA, sobre e reset. Migrado para o CelerKit (deps
// celeros.app.*): o loop de telas e o cabecalho sao do core (A.run/A.header —
// o app nao chama UI.begin/UI.end), as telas de lista (Seguranca, Relogio,
// Notificacoes) e o seletor de fuso sao do A.form. Telas com widgets
// proprios (sliders, abas, cards, gauges, OTA) continuam no toolkit UI.*,
// desenhadas dentro do frame do A.run. ES5 puro (Duktape), canvas 240x320.

var A = require("celeros.app");
require("celeros.app.form");

A.init();
var T = A.T;
var LX = A.L.x, LW = A.L.w, TOP = A.L.top;   // 8 / 224 / 48

var INSTALL_SD = "/local/config_install_sd.txt";

// ---- helpers ---------------------------------------------------------------

function trimStr(s) {
    return String(s).replace(/^\s+|\s+$/g, "");
}
function basename(p) {
    var i = p.lastIndexOf("/");
    return i >= 0 ? p.substring(i + 1) : p;
}
function fmtBytes(b) {
    if (!b || b < 0) b = 0;
    if (b < 1024) return b + " B";
    if (b < 1048576) return Math.round(b / 1024) + " KB";
    return Math.round((b / 1048576) * 10) / 10 + " MB";
}
function fmtUptime(ms) {
    if (!ms || ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
}
// Linha "rotulo ........ valor" dentro de um card
function infoRow(label, value, y, col) {
    UI.text(label, LX + 12, y, { role: "caption", color: T.textDim });
    UI.text(String(value), LX + LW - 12, y, { role: "caption", color: col || T.text, align: "right", w: 140 });
}
// Linha "rotulo ......... [toggle]" dentro de um card; devolve o novo estado
function toggleRow(label, y, on) {
    UI.text(label, LX + 12, y + 4, { w: 150 });
    return UI.toggle(LX + LW - 56, y, on);
}

// ---- estado ----------------------------------------------------------------

var rows = [];         // linhas da lista da tela atual: {label, right, sub, enabled, a}
var appsArr = [];      // apps encontrados em /local/apps e /sd/apps
var selApp = 0;
var otaState = "idle"; // idle|nowifi|failed|uptodate|avail|installing|done
var otaInfo = null;
var otaErrTitle = "";
var otaErr = "";
var otaPct = 0;
var otaBodyH = 0;      // altura do changelog (medida no ultimo desenho)
var installing0 = false; // primeiro frame do estado "installing" (roda o otaStart)
var blLvl = 60, blSaved = 60;
var volLvl = 50, volSaved = 50;
var gateTry = 0;       // tentativas de PIN na entrada

var TZS = [
    ["UTC-12 Baker Is", "UTC12"], ["UTC-11 Midway", "UTC11"],
    ["UTC-10 Hawaii", "UTC10"], ["UTC-9 Alaska", "UTC9"],
    ["UTC-8 PST", "UTC8"], ["UTC-7 MST", "UTC7"],
    ["UTC-6 CST", "UTC6"], ["UTC-5 EST", "UTC5"],
    ["UTC-4 AST", "UTC4"], ["UTC-3 BRT", "UTC3"],
    ["UTC-2", "UTC2"], ["UTC-1 AZOT", "UTC1"],
    ["UTC+0 GMT", "UTC0"], ["UTC+1 CET", "UTC-1"],
    ["UTC+2 EET", "UTC-2"], ["UTC+3 MSK", "UTC-3"],
    ["UTC+4 GST", "UTC-4"], ["UTC+5 PKT", "UTC-5"],
    ["UTC+5:30 IST", "UTC-5:30"], ["UTC+6 BST", "UTC-6"],
    ["UTC+7 ICT", "UTC-7"], ["UTC+8 CST/AWST", "UTC-8"],
    ["UTC+9 JST", "UTC-9"], ["UTC+10 AEST", "UTC-10"],
    ["UTC+11 AEDT", "UTC-11"], ["UTC+12 NZST", "UTC-12"]
];

// Rotulo legivel do fuso: o valor salvo e POSIX ("UTC3" = UTC-3, sinal
// invertido) e confundia na tela; mostra so a parte "UTC-3" da tabela
function tzLabel(tz) {
    for (var i = 0; i < TZS.length; i++) {
        if (TZS[i][1] === tz) return TZS[i][0].split(" ")[0];
    }
    return tz;
}
function tzIndex() {
    var cur = System.getTimezone();
    for (var i = 0; i < TZS.length; i++) if (TZS[i][1] === cur) return i;
    return -1;
}

// ---- PIN (nativo desde a 1.3: System.setPin/verifyPin — salt SHA-256 no
// firmware, substitui o md5 solto em settings_pin.txt) -----------------------

function validPin(p) {
    return /^[0-9]{4,6}$/.test(p);
}
function flowNewPin() {
    var p1 = System.prompt("Novo PIN (4-6 dígitos)", "", {hint: "num", mask: true});
    if (!validPin(p1)) {
        UI.alert("Segurança", "PIN inválido: use 4 a 6 dígitos");
        return false;
    }
    var p2 = System.prompt("Confirmar PIN", "", {hint: "num", mask: true});
    if (p1 !== p2) {
        UI.alert("Segurança", "Os PINs não conferem");
        return false;
    }
    if (!System.setPin(p1)) {
        UI.alert("Segurança", "Falha ao salvar o PIN");
        return false;
    }
    UI.toast("PIN salvo");
    return true;
}
function askPin(title) {
    var cur = System.prompt(title, "", {hint: "num", mask: true});
    if (cur === null || cur === "") return false;
    if (!System.verifyPin(cur)) {
        UI.alert("Segurança", "PIN incorreto");
        return false;
    }
    return true;
}

// ---- listas ----------------------------------------------------------------

// Lista padrao da tela (ocupa ate `bottom`); devolve a linha tocada ou null
function listRows(id, bottom) {
    var i = UI.list(id, LX, TOP, LW, (bottom || 312) - TOP, rows, { selected: -1 });
    return i >= 0 ? rows[i] : null;
}

// ---- menu principal --------------------------------------------------------

// Relogio (API 15)
function watchSupported() {
    try { return typeof System.batteryInfo === "function" && !!System.getInfo().hasImu; } catch (e) { return false; }
}
// Brilho automatico (API 7): so em placa com sensor de luz
function autoBriSupported() {
    return typeof System.getAutoBrightness === "function" && System.getAutoBrightness() !== null;
}
function notifSupported() {
    return typeof System.notifications === "function";
}
function notifList() {
    var l = [];
    try { l = System.notifications() || []; } catch (e) {}
    return l;
}

function buildMenu() {
    var w = System.wifiStatus();
    var a = [];
    a.push({ label: "Wi-Fi", right: w.connected ? "Conectado" : "Desligado", a: "wifi" });
    a.push({ label: "Aplicativos", a: "apps" });
    a.push({ label: "Hora e fuso", right: System.getTime(), a: "time" });
    a.push({ label: "Segurança", right: System.pinState() > 0 ? "PIN" : "", a: "security" });
    a.push({
        label: "Tela",
        right: System.backlightSupported()
            ? System.getBrightness() + "%" + (autoBriSupported() && System.getAutoBrightness() ? " auto" : "")
            : "",
        a: "display"
    });
    if (typeof System.getVolume === "function") a.push({ label: "Som", right: System.getVolume() + "%", a: "som" });
    if (typeof Sensors !== "undefined" && Sensors && Sensors.accel) a.push({ label: "Sensores", a: "sensors" });
    if (watchSupported()) a.push({ label: "Relógio", a: "watch" });
    a.push({ label: "Atualização", a: "update" });
    a.push({ label: "Sobre", right: "v" + System.getOSVersion(), a: "about" });
    if (notifSupported()) a.push({ label: "Notificações", right: String(notifList().length), a: "notif" });
    a.push({ label: "Reset", a: "reset" });
    return a;
}

// ---- Relogio (watch): choices do A.form — toque cicla a opcao --------------

var WOPT = [
    "raise_wake|1|Levantar p/ acordar|1:Sim,0:Não",
    "raise_sens|1|Sensibilidade|0:Baixa,1:Média,2:Alta",
    "glance_sec|5|Olhadinha|3:3 s,5:5 s,8:8 s",
    "aod|1|Sempre ligada|1:Sim,0:Não",
    "screen_off_min|3|Tela apaga em|1:1 min,2:2 min,3:3 min,5:5 min",
    "deep_sleep_min|15|Sono profundo em|5:5,15:15,30:30,0:Nunca",
    "home_idle_s|30|Voltar ao relógio|15:15 s,30:30 s,60:1 min,0:Nunca",
    "step_goal|8000|Meta de passos|5000:5000,8000:8000,10000:10000,12000:12000",
    "wifi_sleep_min|10|WiFi dorme após|5:5 min,10:10 min,30:30 min,0:Nunca",
    "imu_wake|0|Movimento acorda|0:Não,1:Sim"
];
// Tela de ajustes do relogio (bloqueante; o A.form reconstroi apos cada toque)
function watchFlow() {
    A.form.run("Relógio", function () {
        var a = [];
        for (var i = 0; i < WOPT.length; i++) (function (i) {
            var p = WOPT[i].split("|");
            var o = p[3].split(","), vals = [], labs = [];
            for (var j = 0; j < o.length; j++) {
                var kv = o[j].split(":");
                vals.push(kv[0]);
                labs.push(kv[1]);
            }
            a.push(A.form.choice(p[2], function () {
                var v = System.setting(p[0]) || p[1];
                for (var k = vals.length - 1; k >= 0; k--) if (vals[k] === v) return k;
                return 0;
            }, function (n) {
                System.setting(p[0], vals[n]);
            }, labs));
        })(i);
        return a;
    });
}

// ---- Notificacoes (API 12): linhas cruas + acao no A.form ------------------

// Tela de notificacoes (bloqueante)
function notifFlow() {
    A.form.run("Notificações", function () {
        var a = [];
        var l = notifList();
        for (var i = l.length - 1; i >= 0; i--) {
            a.push({ label: l[i].title, sub: l[i].msg || "", right: notifWhen(l[i].epoch), enabled: false });
        }
        if (l.length === 0) a.push({ label: "Nenhuma notificação", enabled: false });
        a.push(A.form.action("Limpar notificações", function () {
            if (UI.confirm("Limpar notificações?", "O histórico será apagado.", { yes: "Limpar", danger: true })) {
                System.notificationsClear();
                UI.toast("Histórico apagado");
            }
        }));
        return a;
    });
}
// "27/09 10:32" a partir de epoch em segundos
function notifWhen(ep) {
    if (!ep) return "";
    var d = new Date(ep * 1000);
    function p2(v) { return (v < 10 ? "0" : "") + v; }
    return p2(d.getDate()) + "/" + p2(d.getMonth() + 1) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
}

// ---- Wi-Fi -----------------------------------------------------------------

function scrWifi(c) {
    if (A.header("Wi-Fi")) return A.BACK;
    var w = System.wifiStatus();
    UI.card(LX, TOP, LW, 92);
    infoRow("Estado", w.connected ? "Conectado" : "Desconectado", TOP + 12, w.connected ? T.ok : T.warn);
    UI.text("IP", LX + 12, TOP + 36, { color: T.textDim });
    UI.text(w.connected && w.ip ? w.ip : "--", LX + LW - 12, TOP + 36, { color: T.accent, align: "right" });
    infoRow("Redes salvas", w.savedNetworks ? "sim" : "nenhuma", TOP + 66);
    UI.cardEnd();

    if (UI.button("Configurar Wi-Fi", LX, TOP + 104, LW, 44)) {
        // abre a tela NATIVA de Wi-Fi; este app precisa sair na sequencia
        System.openWifiSetup();
        System.exitApp();
    }
    UI.text("Abre o assistente nativo de conexão (redes, senha e portal). O Settings fecha para dar lugar a ele.",
            LX + 4, TOP + 160, { role: "caption", color: T.textDim, w: LW - 8, lines: 4 });
}

// ---- Aplicativos -----------------------------------------------------------

function installSd() {
    return FS.exists(INSTALL_SD);
}
function spaceStr(drive) {
    var tot = FS.getTotalSpace(drive);
    if (!tot || tot <= 0) return "ausente";
    return fmtBytes(FS.getFreeSpace(drive)) + " livres de " + fmtBytes(tot);
}
function collectApps(dir, out, sd) {
    var list = FS.listDir(dir);
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!FS.isDirectory(p)) continue;
        var jp = p + "/app.json";
        if (!FS.exists(jp)) continue;
        var meta = {};
        try {
            meta = JSON.parse(FS.readTextFile(jp)) || {};
        } catch (e) {
            meta = {};
        }
        out.push({
            dir: p,
            sd: sd,
            name: meta.name || basename(p),
            ver: meta.version || "",
            sys: meta.system === true,
            api: meta.api || 0,
            desc: meta.description || ""
        });
    }
}
function scanApps() {
    var out = [];
    collectApps("/local/apps", out, false);
    collectApps("/sd/apps", out, true);
    out.sort(function (a, b) {
        var x = a.name.toLowerCase(), y = b.name.toLowerCase();
        return x < y ? -1 : (x > y ? 1 : 0);
    });
    return out;
}
function buildApps() {
    appsArr = scanApps();
    var a = [];
    a.push({ label: "Instalar em", right: installSd() ? "Cartão SD" : "Interno", a: "dest" });
    for (var i = 0; i < appsArr.length; i++) {
        var ap = appsArr[i];
        a.push({ label: ap.name, right: (ap.sd ? "SD " : "") + (ap.ver ? "v" + ap.ver : ""), a: "app:" + i });
    }
    if (appsArr.length === 0) a.push({ label: "Nenhum app instalado", enabled: false });
    return a;
}
function scrApps(c) {
    if (c.entered) {
        rows = buildApps();
        UI.resetScroll("list:apps");
    }
    if (A.header("Aplicativos")) return A.BACK;
    var r = listRows("list:apps", 270);
    UI.text("Interno: " + spaceStr("/local"), LX + 4, 278, { role: "caption", color: T.textDim });
    UI.text("SD: " + spaceStr("/sd"), LX + 4, 296, { role: "caption", color: T.textDim });
    if (!r) return;
    if (r.a === "dest") {
        if (installSd()) FS.deleteFile(INSTALL_SD);
        else FS.writeTextFile(INSTALL_SD, "1");
        rows = buildApps();
    } else if (r.a && r.a.indexOf("app:") === 0) {
        selApp = parseInt(r.a.substring(4), 10);
        return "appdetail";
    }
}
function scrAppDetail(c) {
    var ap = appsArr[selApp];
    if (!ap) return A.BACK;
    if (A.header(ap.name)) return A.BACK;
    UI.card(LX, TOP, LW, 96);
    infoRow("Versão", ap.ver ? "v" + ap.ver : "--", TOP + 10);
    infoRow("API", ap.api ? ap.api : "--", TOP + 30);
    infoRow("Tipo", ap.sys ? "app do sistema" : "comum", TOP + 50);
    infoRow("Origem", ap.sd ? "cartão SD" : "interno", TOP + 70);
    UI.cardEnd();
    UI.text("Descrição", LX + 4, TOP + 108, { role: "caption", color: T.accent });
    UI.text(ap.desc || "Sem descrição.", LX + 4, TOP + 126,
            { role: "caption", color: T.textDim, w: LW - 8, lines: 6 });
    if (UI.button("Desinstalar", LX, 268, LW, 40, { style: "danger" }) && askUninstall(ap)) return A.BACK;
}
function askUninstall(ap) {
    if (ap.sys && !UI.confirm("App do sistema", "Este app faz parte do sistema. Remover mesmo assim?",
                              { yes: "Continuar" })) return false;
    if (!UI.confirm("Desinstalar?", "Remover " + ap.name + "?", { yes: "Remover", danger: true })) return false;
    if (FS.isDirectory(ap.dir)) FS.removeDirectory(ap.dir);
    else FS.deleteFile(ap.dir);
    System.rescanApps();
    UI.toast(ap.name + " removido");
    return true;
}

// ---- Hora e fuso -----------------------------------------------------------

function buildTimeNav() {
    return [
        { label: "Fuso horário", right: tzLabel(System.getTimezone()), a: "tz" },
        { label: "Ajuste manual", enabled: !System.getNtpEnabled(), a: "manual" }
    ];
}
function scrTime(c) {
    if (c.entered) {
        rows = buildTimeNav();
        UI.resetScroll("list:time");
    }
    if (A.header("Hora e fuso")) return A.BACK;

    UI.card(LX, TOP, LW, 64);
    UI.text(System.getTime(), LX + 12, TOP + 8, { role: "title" });
    UI.text(System.getDate(), LX + 12, TOP + 38, { role: "caption", color: T.textDim });
    UI.cardEnd();

    UI.card(LX, TOP + 72, LW, 84);
    var ntp = !!System.getNtpEnabled();
    var nNtp = toggleRow("Hora pela internet", TOP + 84, ntp);
    if (nNtp !== ntp) {
        System.setNtpEnabled(nNtp);
        rows = buildTimeNav();
    }
    var h24 = !!System.get24hFormat();
    var n24 = toggleRow("Formato 24 horas", TOP + 122, h24);
    if (n24 !== h24) System.set24hFormat(n24);
    UI.cardEnd();

    var r = UI.list("list:time", LX, TOP + 164, LW, 76, rows, { selected: -1 });
    if (r < 0) return;
    if (rows[r].a === "tz") tzPick();
    else if (rows[r].a === "manual") manualFlow();
}
// Seletor de fuso (A.form.pick): devolve o indice escolhido ou -1 se voltou
function tzPick() {
    var labels = [];
    for (var i = 0; i < TZS.length; i++) labels.push(TZS[i][0]);
    var p = A.form.pick("Fuso horário", labels, tzIndex());
    if (p >= 0) {
        System.setTimezone(TZS[p][1]);
        UI.toast("Fuso: " + tzLabel(TZS[p][1]));
        rows = buildTimeNav();
    }
}
function nowHM() {
    var s = System.getTime();
    var m = s.match(/(\d{1,2}):(\d{2})/);
    var h = m ? parseInt(m[1], 10) : 12;
    var mi = m ? parseInt(m[2], 10) : 0;
    if (s.indexOf("PM") >= 0 && h < 12) h += 12;
    if (s.indexOf("AM") >= 0 && h === 12) h = 0;
    return [h, mi];
}
// Numero validado na faixa; null se cancelou (prompt nativo, teclado numerico)
function askNum(label, cur, lo, hi) {
    while (true) {
        var init = (cur < 10 ? "0" : "") + cur;
        var s = System.prompt(label + " (" + lo + " a " + hi + ")", init, {hint: "num"});
        if (s === null || s === "") return null;
        s = trimStr(s);
        if (/^[0-9]+$/.test(s)) {
            var n = parseInt(s, 10);
            if (n >= lo && n <= hi) return n;
        }
        UI.alert(label, "Valor inválido: use " + lo + " a " + hi);
    }
}
// Ajuste manual: 5 passos; o A.progress mostra onde esta entre os prompts
function manualFlow() {
    var hm = nowHM();
    var vals = [System.getYear(), System.getMonth(), System.getDay(), hm[0], hm[1]];
    var labels = ["Ano", "Mês", "Dia", "Hora", "Minuto"];
    var lo = [2000, 1, 1, 0, 0];
    var hi = [2100, 12, 31, 23, 59];
    for (var i = 0; i < 5; i++) {
        A.progress(Math.round(((i + 0.5) / 5) * 100), "Ajuste manual: " + labels[i] + " (" + (i + 1) + "/5)");
        var n = askNum(labels[i], vals[i], lo[i], hi[i]);
        if (n === null) return;
        vals[i] = n;
    }
    System.setManualTime(vals[0], vals[1], vals[2], vals[3], vals[4]);
    UI.toast("Hora ajustada");
}

// ---- Seguranca: tela de ajustes do A.form ----------------------------------

// Tela de seguranca (bloqueante; o A.form reconstroi apos cada acao)
function secFlow() {
    A.form.run("Segurança", function () {
        var st = System.pinState();  // 0 sem, 1 ativo, 2 corrompido
        var a = [];
        a.push(A.form.info("PIN do Ajustes", st === 1 ? "ativo" : (st === 2 ? "corrompido" : "desativado")));
        if (st === 1) {
            a.push(A.form.action("Trocar PIN", function () {
                if (askPin("PIN atual")) flowNewPin();
            }));
            a.push(A.form.action("Remover PIN", function () {
                if (askPin("PIN atual")) {
                    System.pinClear();
                    UI.toast("PIN removido");
                }
            }));
        } else {
            a.push(A.form.action("Definir PIN", function () {
                flowNewPin();
            }));
        }
        a.push(A.form.info("Senha web", System.webAuthInfo().pass));
        a.push(A.form.action("Trocar senha web", function () {
            var np = System.prompt("Nova senha web (6+ chars)", "");
            if (np === null || np === "") return;
            if (!System.webAuthSetPass(np)) {
                UI.alert("Segurança", "Use de 6 a 31 caracteres");
                return;
            }
            UI.toast("Senha web alterada");
        }));
        return a;
    });
}

// ---- Tela (brilho, automatico, tempo de tela) ---------------------------------

// Tempo de tela (API 12): 0 = sempre ligada
var TMOPTS = [[0, "Sempre"], [30000, "30 s"], [60000, "1 min"], [300000, "5 min"], [600000, "10 min"]];
function screenTimeoutSupported() {
    return typeof System.setScreenTimeout === "function";
}
function tmoIndex() {
    var v = System.screenTimeout();
    for (var i = 0; i < TMOPTS.length; i++) if (TMOPTS[i][0] === v) return i;
    return 0;
}
function scrDisplay(c) {
    if (c.entered) {
        blLvl = blSaved = Math.max(5, System.getBrightness());
    }
    if (A.header("Tela")) return A.BACK;
    var y = TOP;
    if (!System.backlightSupported()) {
        UI.card(LX, y, LW, 70);
        UI.text("Brilho fixo nesta placa", 120, y + 14, { align: "center", color: T.warn });
        UI.text("O hardware não controla o backlight.", 120, y + 42, { role: "caption", align: "center", color: T.textDim });
        UI.cardEnd();
        y += 82;
    } else {
        UI.card(LX, y, LW, 84);
        UI.text("Brilho", LX + 12, y + 10);
        UI.text(blLvl + "%", LX + LW - 12, y + 10, { color: T.accent, align: "right" });
        blLvl = UI.slider(LX + 20, y + 44, LW - 40, blLvl, { min: 5, max: 100 });
        UI.cardEnd();
        // persiste ao soltar o dedo (setBrightness grava na NVS)
        if (blLvl !== blSaved && !UI.touch().down) {
            System.setBrightness(blLvl);
            blSaved = blLvl;
        }
        y += 92;
        if (autoBriSupported()) {
            UI.card(LX, y, LW, 44);
            var on = !!System.getAutoBrightness();
            var nv = toggleRow("Brilho automático", y + 10, on);
            if (nv !== on) System.setAutoBrightness(nv);
            UI.cardEnd();
            y += 52;
        }
    }
    if (screenTimeoutSupported()) {
        UI.text("Tela apaga após", LX + 4, y + 4, { role: "caption", color: T.textDim });
        var labels = [];
        for (var i = 0; i < TMOPTS.length; i++) labels.push(TMOPTS[i][1]);
        var cur = tmoIndex();
        var sel = UI.tabs(LX, y + 24, LW, 34, labels, cur);
        if (sel !== cur) System.setScreenTimeout(TMOPTS[sel][0]);
    }
}

// ---- Som (API 13) ------------------------------------------------------------

function scrSom(c) {
    if (c.entered) {
        volLvl = volSaved = System.getVolume ? System.getVolume() : 50;
    }
    if (A.header("Som")) return A.BACK;
    UI.card(LX, TOP, LW, 84);
    UI.text("Volume", LX + 12, TOP + 10);
    UI.text(volLvl + "%", LX + LW - 12, TOP + 10, { color: T.accent, align: "right" });
    volLvl = UI.slider(LX + 20, TOP + 44, LW - 40, volLvl);
    UI.cardEnd();
    if (volLvl !== volSaved && !UI.touch().down && typeof System.setVolume === "function") {
        System.setVolume(volLvl);  // aplica e persiste
        volSaved = volLvl;
    }
    if (typeof System.playTone === "function" &&
        UI.button("Testar som", LX, TOP + 96, LW, 40, { style: "ghost" })) {
        System.playTone([[784, 90], [988, 90], [1319, 140]]);
    }
}

// ---- Sensores (API 13, watch) ---------------------------------------------------

function scrSensors(c) {
    if (A.header("Sensores")) return A.BACK;
    var a = Sensors.accel();
    UI.card(LX, TOP, LW, 96);
    UI.text("Acelerômetro (g)", LX + 12, TOP + 8, { role: "caption", color: T.textDim });
    if (a) {
        var vals = [a.x, a.y, a.z], names = ["x", "y", "z"], cols = [T.err, T.ok, T.accent];
        for (var i = 0; i < 3; i++) {
            var yy = TOP + 28 + i * 22;
            UI.text(names[i] + " " + vals[i].toFixed(2), LX + 12, yy);
            // barra horizontal por eixo: -2g..+2g (desenho proprio, so no frame total)
            if (c.full) {
                var v = Math.max(-2, Math.min(2, vals[i]));
                System.fillRoundRect(140, yy + 4, 72, 8, 4, T.raised);
                var cx = Math.max(141, Math.min(211, 176 + Math.round(v * 17)));
                System.fillRoundRect(cx - 3, yy + 1, 6, 14, 3, cols[i]);
            }
        }
    } else {
        UI.text("indisponível", LX + 12, TOP + 34, { color: T.warn });
    }
    UI.cardEnd();

    UI.card(LX, TOP + 104, LW, 76);
    infoRow("Passos hoje", String(Sensors.steps ? Sensors.steps() : "-"), TOP + 116);
    infoRow("Temperatura", Sensors.temp ? Sensors.temp().toFixed(1) + " °C" : "-", TOP + 146);
    UI.cardEnd();
    UI.text("atualiza ao vivo", 120, TOP + 192, { role: "caption", align: "center", color: T.textDim });
    if (A.every(1000, "sens")) UI.invalidate();  // barras desenhadas a mao
}

// ---- Atualizacao (OTA) -----------------------------------------------------

function otaText() {
    var s = "";
    if (otaInfo.changelog) s += "Novidades: " + otaInfo.changelog;
    if (otaInfo.guide) s += (s ? "  " : "") + "Como instalar: " + otaInfo.guide;
    return s;
}
function scrUpdate(c) {
    if (c.entered) {
        otaState = "idle";
        otaInfo = null;
        otaErr = "";
        otaErrTitle = "";
        installing0 = false;
        UI.resetScroll("ota");
    }
    if (A.header("Atualização")) return A.BACK;
    drawUpdate(c.full);
}
function drawUpdate(full) {
    var ver = "CelerOS v" + System.getOSVersion();
    if (otaState === "idle") {
        UI.card(LX, TOP, LW, 70);
        UI.text("Versão atual", 120, TOP + 10, { role: "caption", align: "center", color: T.textDim });
        UI.text(ver, 120, TOP + 32, { role: "title", align: "center" });
        UI.cardEnd();
        if (UI.button("Procurar atualização", LX, TOP + 84, LW, 44)) doCheck();
        UI.text("Requer Wi-Fi conectado", 120, TOP + 140, { role: "caption", align: "center", color: T.textDim });
    } else if (otaState === "installing") {
        UI.text("Atualizando o sistema", 120, TOP + 30, { role: "title", align: "center" });
        UI.text("Não desligue a alimentação!", 120, TOP + 62, { role: "caption", align: "center", color: T.err });
        UI.text(otaPct + "%", 120, TOP + 96, { align: "center", color: T.accent });
        UI.progress(LX + 16, TOP + 124, LW - 32, 14, otaPct);
        if (!installing0) {
            installing0 = true;
            // o callback roda dentro do otaStart: atualiza so os widgets acima
            var res = System.otaStart(otaInfo.url, function (p) {
                otaPct = p;
                UI.text(p + "%", 120, TOP + 96, { align: "center", color: T.accent });
                UI.progress(LX + 16, TOP + 124, LW - 32, 14, p);
            });
            if (res && res.ok) {
                otaState = "done";
            } else {
                otaState = "failed";
                otaErrTitle = "Falha na instalação";
                otaErr = (res && res.error) ? res.error : "erro desconhecido";
            }
            UI.invalidate();
        }
    } else if (otaState === "done") {
        UI.text("Atualização concluída!", 120, TOP + 40, { role: "title", align: "center", color: T.ok });
        UI.text("Reinicie para concluir.", 120, TOP + 74, { role: "caption", align: "center", color: T.textDim });
        if (UI.button("Reiniciar agora", LX, TOP + 110, LW, 44)) System.restart();
    } else if (otaState === "avail") {
        UI.badge(otaInfo.type || "Atualização disponível", LX + 4, TOP);
        UI.text("v" + System.getOSVersion() + "  >  v" + otaInfo.version, LX + 4, TOP + 24, { role: "title", w: LW - 8 });
        // bloco rolavel (changelog + guia)
        var top = TOP + 56, h = 140;
        var off = UI.scrollBegin("ota", LX, top, LW, h, Math.max(h, otaBodyH));
        if (full) {
            otaBodyH = UI.text(otaText(), LX + 4, top - off,
                               { role: "caption", color: T.textDim, w: LW - 12, lines: 40, id: off }) + 8;
        }
        UI.scrollEnd();
        if (otaInfo.hasFirmware) {
            if (UI.button("Instalar", LX, 252, 108, 40, { style: "primary" })) installFlow();
        } else {
            UI.text("Canal sem firmware: siga o guia.", LX + 4, 262, { role: "caption", color: T.textDim, w: 108, lines: 2 });
        }
        if (UI.button("Verificar", LX + 116, 252, 108, 40, { style: "ghost" })) doCheck();
    } else {
        // nowifi | failed | uptodate
        var title = otaState === "nowifi" ? "Sem conexão Wi-Fi" : (otaState === "uptodate" ? "Sistema atualizado!" : otaErrTitle);
        var col = otaState === "uptodate" ? T.ok : T.err;
        var msg = otaState === "nowifi" ? "Conecte-se a uma rede Wi-Fi e tente de novo."
            : (otaState === "uptodate" ? ver : otaErr);
        UI.text(title, 120, TOP + 30, { role: "title", align: "center", color: col, w: LW });
        UI.text(msg, 120, TOP + 66, { role: "caption", align: "center", color: T.textDim, w: LW - 16, lines: 5 });
        if (UI.button("Verificar de novo", LX, 252, LW, 40, { style: "ghost" })) doCheck();
    }
}
// Confirma e entra no estado "installing"; a propia tela roda o otaStart no
// primeiro frame do estado (o app nao abre frame proprio)
function installFlow() {
    if (!UI.confirm("Instalar atualização?", "O aparelho não pode desligar durante a gravação.", { yes: "Instalar" })) return;
    otaState = "installing";
    otaPct = 0;
    installing0 = false;
    UI.invalidate();
}
// Verificacao OTA: UM frame de "verificando" (A.busy) antes do otaCheck bloqueante
function doCheck() {
    A.busy("Verificando atualização...");
    if (!Net.isConnected()) {
        otaState = "nowifi";
    } else {
        var info = System.otaCheck();
        otaInfo = info;
        if (info.fetchFailed) {
            otaState = "failed";
            otaErrTitle = "Falha na verificação";
            otaErr = "Confira a conexão e tente de novo.";
        } else if (!info.available) {
            otaState = "uptodate";
        } else {
            otaState = "avail";
            otaBodyH = 0;
            UI.resetScroll("ota");
        }
    }
    UI.invalidate();
}

// ---- Sobre -----------------------------------------------------------------

function buildAbout() {
    var inf = System.getInfo();
    var sdTot = FS.getTotalSpace("/sd");
    var a = [];
    a.push({ label: "Versão", right: "v" + System.getOSVersion() });
    a.push({ label: "API", right: "" + System.getAPILevel() });
    a.push({ label: "Chip", right: inf.chipModel || "--" });
    a.push({ label: "CPU", right: inf.cpuFreqMHz + " MHz x" + inf.chipCores });
    a.push({ label: "RAM livre", right: fmtBytes(inf.freeRAM) });
    a.push({ label: "Flash", right: fmtBytes(inf.flashSize) });
    a.push({ label: "IP", right: System.getIPAddress() || "--" });
    a.push({ label: "Interno", right: fmtBytes(FS.getFreeSpace("/local")) + " / " + fmtBytes(FS.getTotalSpace("/local")) });
    a.push({ label: "SD", right: (sdTot > 0) ? (fmtBytes(FS.getFreeSpace("/sd")) + " / " + fmtBytes(sdTot)) : "ausente" });
    a.push({ label: "Ligado há", right: fmtUptime(inf.uptimeMs) });
    return a;
}
function scrAbout(c) {
    if (c.entered || A.every(1000, "about")) rows = buildAbout();
    if (A.header("Sobre")) return A.BACK;
    listRows("list:about");
}

// ---- Reset -----------------------------------------------------------------

function scrReset(c) {
    if (A.header("Reset")) return A.BACK;
    UI.card(LX, TOP, LW, 116);
    UI.text("Limpar configurações", LX + 12, TOP + 10);
    UI.text("Apaga Wi-Fi, PIN, brilho e outras configurações. Apps são mantidos.", LX + 12, TOP + 34,
            { role: "caption", color: T.textDim, w: LW - 24, lines: 2 });
    var a = UI.button("Limpar", LX + 12, TOP + 70, LW - 24, 36, { style: "danger" });
    UI.cardEnd();

    UI.card(LX, TOP + 126, LW, 116);
    UI.text("Reset total", LX + 12, TOP + 136);
    UI.text("APAGA TUDO: apps, ícones e configurações. A recuperação exige cabo USB.", LX + 12, TOP + 160,
            { role: "caption", color: T.warn, w: LW - 24, lines: 2 });
    var b = UI.button("Reset total", LX + 12, TOP + 196, LW - 24, 36, { style: "danger" });
    UI.cardEnd();

    if (a && UI.confirm("Limpar configurações?",
                        "Redes Wi-Fi, PIN e brilho serão apagados. Apps e ícones ficam.", { yes: "Continuar" }) &&
        UI.confirm("Confirmar limpeza", "Limpar todas as configurações agora?", { yes: "Apagar", danger: true })) {
        doReset("configs");
    }
    if (b && UI.confirm("Reset total?", "APAGA TUDO: apps, ícones e configurações.", { yes: "Continuar" }) &&
        UI.confirm("Apagar tudo?", "O armazenamento interno será formatado. Os apps somem!",
                   { yes: "Formatar", danger: true })) {
        doReset("total");
    }
}
function doReset(mode) {
    // frame unico de "ocupado" (A.busy) antes das chamadas que reiniciam
    A.busy(mode === "total" ? "Formatando o aparelho..." : "Limpando configurações...");
    System.delay(400);
    System.factoryReset(mode);
    System.delay(600);
    System.restart();
}

// ---- gate de PIN na entrada ------------------------------------------------
// Fluxo BLOQUEANTE antes do A.run: como tela, o "gate" ficava na pilha e o
// voltar do menu desempilhava o pedido de PIN em vez de sair.

function gatePin() {
    gateTry = 0;
    for (;;) {
        UI.begin(T.bg);
        A.header("Ajustes", { back: false });
        UI.text("App protegido por PIN", 120, 110, { role: "title", align: "center" });
        UI.text("Digite o PIN para continuar", 120, 146, { role: "caption", align: "center", color: T.textDim, w: LW });
        UI.text("Tentativas: " + (3 - gateTry), 120, 168, { role: "caption", align: "center", color: T.accent });
        UI.end(20);
        var pin = System.prompt("PIN do Ajustes", "", {hint: "num", mask: true});
        if (pin === null || pin === "") return false;  // cancelou: fora
        if (System.verifyPin(pin)) return true;
        UI.alert("PIN", "PIN incorreto");
        gateTry++;
        if (gateTry >= 3) {
            UI.alert("PIN", "Acesso negado");
            return false;
        }
    }
}
// Flag NVS diz que ha PIN mas o arquivo nao existe (apagaram por fora):
// exigir redefinicao em vez de abrir destravado.
function gateCorrupt() {
    UI.begin(T.bg);
    A.header("Ajustes", { back: false });
    UI.text("PIN corrompido", 120, 110, { role: "title", align: "center", color: T.warn });
    UI.text("O arquivo do PIN foi apagado. Defina um novo PIN.", 120, 146,
            { role: "caption", align: "center", color: T.textDim, w: LW });
    UI.end(20);
    return !!flowNewPin();
}

// ---- menu (tela raiz) --------------------------------------------------------

function scrMenu(c) {
    // atualizacao periodica: valores vivos (Wi-Fi, hora, brilho, notificacoes)
    if (c.entered || A.every(1000, "menu")) rows = buildMenu();
    if (A.header("Ajustes")) return A.BACK;
    var r = listRows("list:menu");
    if (!r) return;
    // telas de lista do A.form sao modais bloqueantes: rodam dentro do frame;
    // ao voltar, o menu se redesenha na hora (valores podem ter mudado)
    if (r.a === "security") { secFlow(); rows = buildMenu(); return; }
    if (r.a === "watch") { watchFlow(); rows = buildMenu(); return; }
    if (r.a === "notif") { notifFlow(); rows = buildMenu(); return; }
    return r.a;
}

// ---- laco principal (A.run e dono do UI.begin/UI.end) -----------------------

var pinSt0 = System.pinState();
var liberado = pinSt0 === 1 ? gatePin() : (pinSt0 === 2 ? gateCorrupt() : true);
if (liberado) A.run({
    menu: scrMenu,
    wifi: scrWifi,
    apps: scrApps,
    appdetail: scrAppDetail,
    time: scrTime,
    display: scrDisplay,
    som: scrSom,
    sensors: scrSensors,
    update: scrUpdate,
    about: scrAbout,
    reset: scrReset
}, "menu");
