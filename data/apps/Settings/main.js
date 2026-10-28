// CelerOS Settings — app de sistema (W8): PIN, Wi-Fi, apps, hora, seguranca,
// tela, som, relogio, OTA, sobre e reset. UI 2.0 (CelerKit 2.0): formularios
// bloqueantes no A.form.run com as linhas ricas do A.rows (toggle/choice/
// picker/info/secao), menu e listas no A.list.view, cards/botoes do A.style,
// icones vetoriais do A.icons e as capacidades da placa no A.caps (a CYD sem
// BT/mic/audio/PSRAM abre e explica, nao some). ES5 puro (Duktape), canvas
// virtual 240x320 (A.L respeita o inset do vidro redondo).

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.form");
require("celeros.app.list");
require("celeros.app.rows");
require("celeros.app.caps");

A.init();
A.style.preset("soft");
var T = A.style.T;
var LX = A.L.x, LW = A.L.w, TOP = A.L.top, BOT = A.L.bottom;
var CAP = A.caps.probe();          // sonda unica: placa nao muda em execucao

var ISD = "/local/config_install_sd.txt";
var TMO = [[0, "Sempre"], [30000, "30 s"], [60000, "1 min"],
              [300000, "5 min"], [600000, "10 min"]];

// ---- helpers ---------------------------------------------------------------

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
function info() {
    try { return System.getInfo() || {}; } catch (e) { return {}; }
}
// card do A.style com o frame corrente (sombra/gradiente so no frame cheio)
function card(c, x, y, w, h, draw) {
    A.style.card(x, y, w, h, { full: c.full, draw: draw });
}

// Linha "rotulo ........ valor" dentro de um card do A.style
function infoRow(q, label, value, y, col) {
    UI.text(label, q.x, y, { role: "caption", color: T.textDim, bg: q.bg,
                             w: q.w - 110, lines: 1 });
    UI.text(String(value), q.x + q.w, y, { role: "caption", align: "right",
            color: col === undefined ? T.text : col, w: 110, bg: q.bg, lines: 1 });
}

// ---- capacidades (A.caps + feature detect) ---------------------------------

function hasAudio() {
    var i = info();
    if (i.hasAudio === false) return false;      // perfil lite (CYD)
    return typeof System.setVolume === "function";
}
function watchSupported() {
    try {
        return typeof System.batteryInfo === "function" && !!info().hasImu;
    } catch (e) { return false; }
}
function autoBriSupported() {
    return typeof System.getAutoBrightness === "function" &&
           System.getAutoBrightness() !== null;
}
function timeoutSupported() {
    return typeof System.setScreenTimeout === "function";
}
function notifSupported() {
    return typeof System.notifications === "function";
}
function notifList() {
    var l = [];
    try { l = System.notifications() || []; } catch (e) {}
    return l;
}

// ---- estado ----------------------------------------------------------------

var MN = [];          // linhas da tela raiz
var AR = [];      // linhas da tela Aplicativos
var AA = [];       // apps encontrados em /local/apps e /sd/apps
var SA = 0;
var oSt = "idle";  // idle|nowifi|failed|uptodate|avail|installing|done
var oIn = null;
var oEt = "";
var oEr = "";
var oPc = 0;
var oBh = 0;       // altura do changelog (medida no ultimo desenho)
var oI0 = false;
var blLvl = 60, volLvl = 50;
var gt = 0;        // tentativas de PIN na entrada

// pares rotulo/POSIX numa string so (economia de JS na CYD)
var TZS = ("UTC-12 UTC12 UTC-11 UTC11 UTC-10 UTC10 UTC-9 UTC9 " +
           "UTC-8 UTC8 UTC-7 UTC7 UTC-6 UTC6 UTC-5 UTC5 UTC-4 UTC4 " +
           "UTC-3 UTC3 UTC-2 UTC2 UTC-1 UTC1 UTC+0 UTC0 UTC+1 UTC-1 " +
           "UTC+2 UTC-2 UTC+3 UTC-3 UTC+4 UTC-4 UTC+5 UTC-5 " +
           "UTC+5:30 UTC-5:30 UTC+6 UTC-6 UTC+7 UTC-7 UTC+8 UTC-8 " +
           "UTC+9 UTC-9 UTC+10 UTC-10 UTC+11 UTC-11 UTC+12 UTC-12").split(" ");

function tzLabel(tz) {
    for (var i = 1; i < TZS.length; i += 2) if (TZS[i] === tz) return TZS[i - 1];
    return tz || "UTC";
}
function tzIndex() {
    var cur = System.getTimezone();
    for (var i = 1; i < TZS.length; i += 2) if (TZS[i] === cur) return (i - 1) / 2;
    return -1;
}
function tzItems() {
    var a = [];
    for (var i = 0; i < TZS.length; i += 2) a.push(TZS[i]);
    return a;
}

// ---- PIN (nativo desde a 1.3: salt SHA-256 no firmware) --------------------

function validPin(p) {
    return /^[0-9]{4,6}$/.test(String(p));
}
function flowNewPin() {
    var p1 = A.form.askText("Novo PIN (4-6 dígitos)", { hint: "num", mask: true });
    if (!validPin(p1)) {
        UI.alert("Segurança", "PIN inválido: use 4 a 6 dígitos");
        return false;
    }
    var p2 = A.form.askText("Confirmar PIN", { hint: "num", mask: true });
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
    var cur = A.form.askText(title, { hint: "num", mask: true });
    if (cur === null || cur === "") return false;
    if (!System.verifyPin(cur)) {
        UI.alert("Segurança", "PIN incorreto");
        return false;
    }
    return true;
}

// ---- menu principal --------------------------------------------------------

function buildMenu() {
    var w = System.wifiStatus();
    var ligado = false;
    try { ligado = typeof System.isWiFiActive === "function" && System.isWiFiActive(); } catch (e) {}
    var a = [];
    a.push({ label: "Wi-Fi", icon: "wifi", a: "wifi",
             right: w.connected ? "Conectado" : (ligado ? "Ligado" : "Desligado"),
             rightColor: w.connected ? T.ok : T.textDim });
    a.push({ label: "Aplicativos", icon: "menu", a: "apps" });
    a.push({ label: "Hora e fuso", icon: "info", right: System.getTime(), a: "time" });
    a.push({ label: "Segurança", icon: "gear", right: System.pinState() > 0 ? "PIN" : "",
             rightColor: T.ok, a: "security" });
    a.push({ label: "Tela", icon: "star", a: "display",
             right: System.backlightSupported()
                 ? System.getBrightness() + "%" +
                   (autoBriSupported() && System.getAutoBrightness() ? " auto" : "")
                 : "" });
    if (typeof System.getVolume === "function")
        a.push({ label: "Som", icon: "play", right: System.getVolume() + "%", a: "som" });
    if (typeof Sensors !== "undefined" && Sensors && Sensors.accel)
        a.push({ label: "Sensores", icon: "heart", a: "sensors" });
    if (watchSupported()) a.push({ label: "Relógio", icon: "info", a: "watch" });
    a.push({ label: "Atualização", icon: "search", a: "update" });
    a.push({ label: "Sobre", icon: "info", right: "v" + System.getOSVersion(), a: "about" });
    if (notifSupported())
        a.push({ label: "Notificações", icon: "alert", right: String(notifList().length), a: "notif" });
    return a;
}

function scrMenu(c) {
    if (c.entered || A.every(1000, "menu")) MN = buildMenu();
    if (A.header("Ajustes")) return A.BACK;
    var i = A.list.view("menu", LX, TOP, LW, BOT - TOP, MN, { row: 36 });
    if (i < 0) return;
    var r = MN[i];
    if (r && r.a) return r.a;
}

// ---- Wi-Fi -----------------------------------------------------------------

function scrWifi(c) {
    UI.invalidate();   // o form abre em frame TOTAL (A.run ja consumiu o begin)
    A.form.run("Wi-Fi", function () {
        var w = System.wifiStatus();
        return [
            A.form.info("Estado", w.connected ? "Conectado" : "Desconectado",
                        w.connected ? T.ok : T.warn),
            A.form.info("IP", (w.connected && w.ip) ? w.ip : "--", T.accent),
            A.form.info("Redes", w.savedNetworks ? "sim" : "nenhuma"),
            A.form.action("Configurar Wi-Fi", function () {
                System.openWifiSetup();     // abre o app Wi-Fi e sai do Ajustes
            }, { sub: "escaneia e conecta redes" })
        ];
    });
    return A.BACK;
}

// ---- Aplicativos -----------------------------------------------------------

function installSd() {
    return FS.exists(ISD);
}
function spaceStr(drive) {
    var tot = FS.getTotalSpace(drive);
    if (!tot || tot <= 0) return "ausente";
    return fmtBytes(FS.getFreeSpace(drive)) + " livres de " + fmtBytes(tot);
}
function dirBytes(p, lvl) {
    var tot = 0, l = null, i;
    try { l = FS.listDir(p); } catch (e) { return 0; }
    if (!l) return 0;
    for (i = 0; i < l.length; i++) {
        var f = l[i];
        try {
            if (FS.isDirectory(f)) {
                if (lvl < 3) tot += dirBytes(f, lvl + 1);
            } else {
                tot += FS.getFileSize(f) || 0;
            }
        } catch (e2) {}
    }
    return tot;
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
        try { meta = JSON.parse(FS.readTextFile(jp)) || {}; } catch (e) { meta = {}; }
        out.push({
            dir: p, sd: sd,
            name: meta.name || basename(p),
            pkg: meta.packageName || "",
            ver: meta.version || "",
            sys: meta.system === true,
            api: meta.api || 0,
            desc: meta.description || "",
            size: dirBytes(p, 0)
        });
    }
}
function scanApps() {
    var out = [];
    collectApps("/local/apps", out, false);
    collectApps("/sd/apps", out, true);
    A.list.sort(out, function (a) { return a.name.toLowerCase(); });
    return out;
}
function buildAppsRows() {
    var a = [];
    a.push({ label: "Instalar em", icon: "gear", a: "dest",
             sub: "apps novos",
             right: installSd() ? "Cartão SD" : "Interno" });
    for (var i = 0; i < AA.length; i++) {
        var ap = AA[i];
        a.push({ label: ap.name, icon: "menu", a: "app:" + i,
                 sub: (ap.sd ? "SD" : "interno") + " · " + fmtBytes(ap.size),
                 right: ap.ver ? "v" + ap.ver : "",
                 rightColor: ap.sys ? T.accent : T.textDim });
    }
    if (AA.length === 0)
        a.push({ label: "Nenhum app instalado", icon: "info", enabled: false,
                 sub: "instale pela Loja ou SD" });
    return a;
}
function scrApps(c) {
    if (c.entered) {
        A.busy("Lendo aplicativos...");
        AA = scanApps();
        AR = buildAppsRows();
    }
    if (A.header("Aplicativos")) return A.BACK;
    A.style.card(LX, TOP, LW, 52, {
        full: c.full,
        draw: function (q) {
            UI.text("Interno: " + spaceStr("/local"), q.x, q.y,
                    { role: "caption", color: T.textDim, bg: q.bg, w: q.w, id: "spint" });
            UI.text("SD: " + spaceStr("/sd"), q.x, q.y + 16,
                    { role: "caption", color: T.textDim, bg: q.bg, w: q.w, id: "spsd" });
        }
    });
    var y = TOP + 60;
    var i = A.list.view("apps", LX, y, LW, BOT - y, AR, { row: 36 });
    if (i < 0) return;
    var r = AR[i];
    if (!r || !r.a) return;
    if (r.a === "dest") {
        if (installSd()) FS.deleteFile(ISD);
        else FS.writeTextFile(ISD, "1");
        AR = buildAppsRows();
    } else if (r.a.indexOf("app:") === 0) {
        SA = parseInt(r.a.substring(4), 10);
        return "appdetail";
    }
}
function scrAppDetail(c) {
    var ap = AA[SA];
    if (!ap) return A.BACK;
    if (A.header(ap.name)) return A.BACK;
    A.style.card(LX, TOP, LW, 126, {
        full: c.full,
        draw: function (q) {
            infoRow(q, "Versão", ap.ver ? "v" + ap.ver : "--", q.y);
            infoRow(q, "API", ap.api ? ap.api : "--", q.y + 18);
            infoRow(q, "Tipo", ap.sys ? "app do sistema" : "comum", q.y + 36);
            infoRow(q, "Origem", ap.sd ? "cartão SD" : "interno", q.y + 54);
            infoRow(q, "Tamanho", fmtBytes(ap.size), q.y + 72);
            infoRow(q, "Pacote", ap.pkg || "--", q.y + 90, T.textDim);
        }
    });
    UI.text("Descrição", LX + 4, TOP + 136, { role: "caption", color: T.accent, id: "adesc" });
    UI.text(ap.desc || "Sem descrição.", LX + 4, TOP + 154,
            { role: "caption", color: T.textDim, w: LW - 8, lines: 5, id: "adesct" });
    if (A.style.button("Abrir", LX, 266, 106, 40,
                       { variant: "primary", disabled: !ap.pkg })) {
        if (ap.pkg) System.launchApp(ap.pkg);
    }
    if (A.style.button("Desinstalar", LX + 118, 266, 106, 40, { variant: "danger" }) &&
        askUninstall(ap)) return A.BACK;
}
function askUninstall(ap) {
    if (ap.sys && !UI.confirm("App do sistema", "Este app faz parte do sistema. Remover mesmo assim?",
                              { yes: "Continuar" })) return false;
    if (!UI.confirm("Desinstalar?", "Remover " + ap.name + "?", { yes: "Remover", danger: true })) return false;
    A.busy("Removendo " + ap.name + "...");
    if (FS.isDirectory(ap.dir)) FS.removeDirectory(ap.dir);
    else FS.deleteFile(ap.dir);
    System.rescanApps();
    UI.toast(ap.name + " removido");
    AA = scanApps();
    AR = buildAppsRows();
    return true;
}

// ---- Hora e fuso (A.form bloqueante) ---------------------------------------

function nowHM() {
    var s = System.getTime();
    var m = s.match(/(\d{1,2}):(\d{2})/);
    var h = m ? parseInt(m[1], 10) : 12;
    var mi = m ? parseInt(m[2], 10) : 0;
    if (s.indexOf("PM") >= 0 && h < 12) h += 12;
    if (s.indexOf("AM") >= 0 && h === 12) h = 0;
    return [h, mi];
}
function manualFlow() {
    var hm = nowHM();
    var vals = [System.getYear(), System.getMonth(), System.getDay(), hm[0], hm[1]];
    var labels = ["Ano", "Mês", "Dia", "Hora", "Minuto"];
    var lo = [2000, 1, 1, 0, 0];
    var hi = [2100, 12, 31, 23, 59];
    for (var i = 0; i < 5; i++) {
        A.progress(Math.round(((i + 0.5) / 5) * 100),
                   "Ajuste manual: " + labels[i] + " (" + (i + 1) + "/5)");
        var n = A.form.askNum(labels[i], { min: lo[i], max: hi[i], int: true,
                                           hint: "num", initial: vals[i] });
        if (n === null) return;
        vals[i] = n;
    }
    System.setManualTime(vals[0], vals[1], vals[2], vals[3], vals[4]);
    UI.toast("Hora ajustada");
}
function scrTime(c) {
    UI.invalidate();   // o form abre em frame TOTAL (A.run ja consumiu o begin)
    A.form.run("Hora e fuso", function () {
        var ntp = !!System.getNtpEnabled();
        var a = [];
        a.push(A.form.info("Hora", System.getTime()));
        a.push(A.form.info("Data", System.getDate()));
        // acao (nao toggle): o rotulo inteiro cabe na linha e o estado vai
        // no sub; o toggle de 44px deixava "Hora pela intern.." na CYD
        a.push(A.form.action("Hora pela internet", function () {
            System.setNtpEnabled(!System.getNtpEnabled());
        }, { sub: System.getNtpEnabled() ? "ligada" : "desligada" }));
        a.push(A.form.toggle("Formato 24 horas", function () {
            return !!System.get24hFormat();
        }, function (v) {
            System.set24hFormat(v);
        }));
        var fz = A.form.picker("Fuso", function () {
            return tzIndex();
        }, function (n) {
            System.setTimezone(TZS[n * 2 + 1]);
            UI.toast("Fuso: " + TZS[n * 2]);
        }, tzItems());
        fz.sub = tzLabel(System.getTimezone());   // mostra mesmo fora da tabela
        a.push(fz);
        if (ntp) a.push(A.form.info("Manual", "desligue o NTP"));
        else a.push(A.form.action("Ajuste manual", function () {
            manualFlow();
        }));
        return a;
    });
    return A.BACK;      // o form e modal: voltar dele volta ao menu
}

// ---- Seguranca (A.form bloqueante) -----------------------------------------

function webAuth() {
    try {
        if (typeof System.webAuthInfo === "function") return System.webAuthInfo();
    } catch (e) {}
    return null;
}
function scrSecurity(c) {
    UI.invalidate();   // o form abre em frame TOTAL (A.run ja consumiu o begin)
    A.form.run("Segurança", function () {
        var st = System.pinState();   // 0 sem, 1 ativo, 2 corrompido
        var a = [];
        a.push(A.form.secao("PIN do Ajustes"));
        a.push(A.form.info("Estado", st === 1 ? "ativo" :
                           (st === 2 ? "corrompido" : "desativado"),
                           st === 1 ? T.ok : (st === 2 ? T.warn : T.textDim)));
        a.push(A.form.info("Bloqueio", st === 1 ? "ativo" : "desativado"));
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
        var auth = webAuth();
        a.push(A.form.secao("Servidor web"));
        if (auth) {
            a.push(A.form.info("Senha", auth.pass));
            a.push(A.form.action("Trocar senha web", function () {
                var np = A.form.askText("Nova senha web (6+ chars)");
                if (np === null || np === "") return;
                if (!System.webAuthSetPass(np)) {
                    A.error("Senha web", "Use de 6 a 31 caracteres");
                    return;
                }
                UI.toast("Senha web alterada");
            }));
        } else {
            a.push(A.form.info("Senha", "indisponível"));
        }
        return a;
    });
    return A.BACK;
}

// ---- Tela (brilho, auto, tempo de tela, AOD) -------------------------------

function tmoIndex() {
    var v = System.screenTimeout();
    for (var i = 0; i < TMO.length; i++) if (TMO[i][0] === v) return i;
    return 0;
}
function aodGet() {
    return (System.setting("aod") || "1") !== "0";
}
function scrDisplay(c) {
    if (c.entered && System.backlightSupported())
        blLvl = Math.min(100, Math.max(5, System.getBrightness()));
    UI.invalidate();   // o form abre em frame TOTAL (A.run ja consumiu o begin)
    A.form.run("Tela", function () {
        var a = [];
        if (System.backlightSupported()) {
            a.push(A.form.stepper("Brilho", function () { return blLvl; },
                function (n) { blLvl = n; System.setBrightness(n); },
                { min: 5, max: 100, step: 5, fmt: function (v) { return v + "%"; } }));
            if (autoBriSupported())
                a.push(A.form.toggle("Brilho automático", function () {
                    return !!System.getAutoBrightness();
                }, function (v) { System.setAutoBrightness(v); }));
        } else {
            a.push(A.form.info("Brilho", "fixo nesta placa"));
        }
        // acao cicla o tempo: "Tela apaga após" nao cabe no rotulo de um
        // choice (68px) e o texto do CI precisa sair inteiro
        if (timeoutSupported())
            a.push(A.form.action("Tela apaga após", function () {
                var n = (tmoIndex() + 1) % TMO.length;
                System.setScreenTimeout(TMO[n][0]);
            }, { sub: TMO[tmoIndex()][1] }));
        if (watchSupported())
            a.push(A.form.toggle("AOD", aodGet, function (v) {
                System.setting("aod", v ? "1" : "0");
            }));
        else
            a.push(A.form.info("AOD", "só no relógio"));
        return a;
    });
    return A.BACK;
}

// ---- Som -------------------------------------------------------------------

function testTone() {
    if (typeof System.playTone === "function")
        System.playTone([[784, 90], [988, 90], [1319, 140]]);
    else if (typeof System.beep === "function") System.beep(880, 120);
}
function scrSom(c) {
    if (typeof System.getVolume === "function") volLvl = System.getVolume();
    UI.invalidate();   // o form abre em frame TOTAL (A.run ja consumiu o begin)
    A.form.run("Som", function () {
        if (!hasAudio()) {
            var na = [A.form.info("Áudio", "indisponível")];
            if (CAP.speaker) {
                na.push(A.form.info("Falante", "sim"));
                na.push(A.form.action("Testar bipe", testTone));
            } else {
                na.push(A.form.info("Falante", "não tem"));
            }
            return na;
        }
        return [
            A.form.stepper("Volume", function () { return volLvl; },
                function (n) { volLvl = n; System.setVolume(n); },
                { min: 0, max: 100, step: 10, fmt: function (v) { return v + "%"; } }),
            A.form.action("Testar som", testTone)
        ];
    });
    return A.BACK;
}

// ---- Sensores (watch) ------------------------------------------------------

function scrSensors(c) {
    if (A.header("Sensores")) return A.BACK;
    var a = Sensors.accel();
    card(c, LX, TOP, LW, 96, function (q) {
        UI.text("Acelerômetro (g)", q.x, q.y,
                { role: "caption", color: T.textDim, bg: q.bg, id: "acc1" });
        if (!a) {
            UI.text("indisponível", q.x, q.y + 26,
                    { color: T.warn, bg: q.bg, id: "accno" });
            return;
        }
        var vals = [a.x, a.y, a.z], names = ["x", "y", "z"];
        for (var i = 0; i < 3; i++) {
            var yy = q.y + 20 + i * 22;
            UI.text(names[i] + " " + vals[i].toFixed(2), q.x, yy,
                    { bg: q.bg, id: "accv" + i });
            // barra -2g..+2g (progress nativo: sem area pintada a mao)
            UI.progress(148, yy + 4, 64, 8,
                        Math.round((Math.max(-2, Math.min(2, vals[i])) + 2) * 25));
        }
    });
    card(c, LX, TOP + 104, LW, 76, function (q) {
        infoRow(q, "Passos hoje", String(Sensors.steps ? Sensors.steps() : "-"), q.y + 6);
        infoRow(q, "Temperatura",
                Sensors.temp ? Sensors.temp().toFixed(1) + " °C" : "-", q.y + 30);
    });
    UI.text("atualiza ao vivo", 120, TOP + 192,
            { role: "caption", align: "center", color: T.textDim, id: "senslive" });
    if (A.every(1000, "sens")) UI.invalidate();
}

// ---- Relogio (watch): toque cicla a opcao --------------------------------

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
function scrWatch(c) {
    UI.invalidate();   // o form abre em frame TOTAL (A.run ja consumiu o begin)
    A.form.run("Relógio", function () {
        var a = [];
        for (var i = 0; i < WOPT.length; i++) (function (i) {
            var p = WOPT[i].split("|");
            var o = p[3].split(","), vals = [], labs = [], j, cur = 0;
            for (j = 0; j < o.length; j++) {
                var kv = o[j].split(":");
                vals.push(kv[0]);
                labs.push(kv[1]);
            }
            var v = System.setting(p[0]) || p[1];
            for (j = vals.length - 1; j >= 0; j--) if (vals[j] === v) cur = j;
            // acao cicla (rotulo inteiro cabe; choice reservava 120px e cortava)
            a.push(A.form.action(p[2], (function (vals, cur) {
                return function () {
                    System.setting(p[0], vals[(cur + 1) % vals.length]);
                };
            })(vals, cur), { sub: labs[cur] }));
        })(i);
        return a;
    });
    return A.BACK;
}

// ---- Notificacoes (A.form) -------------------------------------------------

function notifWhen(ep) {
    if (!ep) return "";
    var d = new Date(ep * 1000);
    function p2(v) { return (v < 10 ? "0" : "") + v; }
    return p2(d.getDate()) + "/" + p2(d.getMonth() + 1) + " " +
           p2(d.getHours()) + ":" + p2(d.getMinutes());
}
function scrNotif(c) {
    if (A.header("Notificações")) return A.BACK;
    var l = notifList(), a = [], i;
    for (i = l.length - 1; i >= 0; i--)
        a.push({ label: l[i].title, sub: l[i].msg || "",
                 right: notifWhen(l[i].epoch), enabled: false, icon: "alert" });
    if (!l.length)
        a.push({ label: "Nenhuma notificação", sub: "o histórico está vazio",
                 enabled: false, icon: "info" });
    // A.list.view (nao A.form): a linha crua do form nao e pintada pelo A.rows
    A.list.view("notif", LX, TOP, LW, BOT - TOP - 52, a, { row: 40 });
    if (A.style.button("Limpar notificações", LX, BOT - 44, LW, 40,
                       { variant: "danger", disabled: !l.length }) &&
        UI.confirm("Limpar notificações?", "O histórico será apagado.",
                   { yes: "Limpar", danger: true })) {
        System.notificationsClear();
        UI.toast("Histórico apagado");
    }
}

// ---- Atualizacao (OTA) -----------------------------------------------------

function otaText() {
    var s = "";
    if (oIn.changelog) s += "Novidades: " + oIn.changelog;
    if (oIn.guide) s += (s ? "  " : "") + "Como instalar: " + oIn.guide;
    return s;
}
function scrUpdate(c) {
    if (c.entered) {
        oSt = "idle";
        oIn = null;
        oEr = "";
        oEt = "";
        oI0 = false;
        UI.resetScroll("ota");
    }
    if (A.header("Atualização")) return A.BACK;
    drawUpdate(c.full);
}
function drawUpdate(full) {
    var ver = "CelerOS v" + System.getOSVersion();
    var i = oIn;
    if (oSt === "avail") {
        A.style.card(LX, TOP, LW, 192, {
            full: full,
            draw: function (q) {
                UI.badge(i.type || "Atualização", q.x, q.y);
                UI.text("v" + System.getOSVersion() + "  >  v" + i.version,
                        q.x, q.y + 24, { role: "title", bg: q.bg, w: q.w, id: "otav" });
                UI.text("Canal: " + (i.type || "estável") +
                        (i.signed ? " · assinatura ok" : ""),
                        q.x, q.y + 46, { role: "caption", color: T.textDim,
                                        bg: q.bg, w: q.w, id: "otach" });
                // bloco rolavel (changelog + guia)
                var off = UI.scrollBegin("ota", q.x, q.y + 64, q.w, 112,
                                         Math.max(112, oBh));
                if (full)
                    oBh = UI.text(otaText(), q.x, q.y + 64 - off,
                                       { role: "caption", color: T.textDim,
                                         bg: q.bg, w: q.w - 4, lines: 40,
                                         id: "otab" }) + 8;
                UI.scrollEnd();
            }
        });
        if (i.hasFirmware) {
            if (A.style.button("Instalar", LX, 252, 108, 40)) installFlow();
        } else {
            UI.text("Canal sem firmware: siga o guia.", LX + 4, 258,
                    { role: "caption", color: T.textDim, w: 108, lines: 2, id: "otag" });
        }
        if (A.style.button("Verificar", LX + 116, 252, 108, 40, { variant: "ghost" }))
            doCheck();
        return;
    }
    if (oSt === "installing") {
        UI.text("Atualizando o sistema", 120, TOP + 30,
                { role: "title", align: "center", id: "oti" });
        UI.text("Não desligue a alimentação!", 120, TOP + 62,
                { role: "caption", align: "center", color: T.err, id: "otw" });
        UI.text(oPc + "%", 120, TOP + 96,
                { align: "center", color: T.accent, id: "otp" });
        UI.progress(LX + 16, TOP + 124, LW - 32, 14, oPc);
        if (!oI0) {
            oI0 = true;
            // o callback roda dentro do otaStart: atualiza so os widgets acima
            var res = System.otaStart(i.url, function (p) {
                oPc = p;
                UI.text(p + "%", 120, TOP + 96,
                        { align: "center", color: T.accent, id: "otp" });
                UI.progress(LX + 16, TOP + 124, LW - 32, 14, p);
            });
            if (res && res.ok) oSt = "done";
            else {
                oSt = "failed";
                oEt = "Falha na instalação";
                oEr = (res && res.error) ? res.error : "erro desconhecido";
            }
            UI.invalidate();
        }
        return;
    }
    var title = "Versão atual", msg = ver + " · requer Wi-Fi", col = T.text, act = "chk";
    if (oSt === "done") {
        title = "Atualização concluída!";
        msg = "Reinicie para concluir."; col = T.ok; act = "rst";
    } else if (oSt === "nowifi") {
        title = "Sem conexão Wi-Fi";
        msg = "Conecte-se a uma rede Wi-Fi e tente de novo."; col = T.err;
    } else if (oSt === "uptodate") {
        title = "Sistema atualizado!"; msg = ver; col = T.ok;
    } else if (oSt === "failed") {
        title = oEt; msg = oEr; col = T.err;
    }
    A.style.card(LX, TOP, LW, 96, {
        full: full,
        draw: function (q) {
            UI.text(title, 120, q.y,
                    { role: "title", align: "center", color: col,
                      bg: q.bg, w: q.w, id: "otst" });
            UI.text(msg, 120, q.y + 30,
                    { role: "caption", align: "center", color: T.textDim,
                      bg: q.bg, w: q.w, lines: 3, id: "otsm" });
        }
    });
    if (A.style.button(act === "rst" ? "Reiniciar agora" :
                       (oSt === "idle" ? "Procurar atualização" : "Verificar de novo"),
                       LX, TOP + 108, LW, 44)) {
        if (act === "rst") System.restart();
        else doCheck();
    }
}
function installFlow() {
    if (!UI.confirm("Instalar atualização?",
                    "O aparelho não pode desligar durante a gravação.",
                    { yes: "Instalar" })) return;
    oSt = "installing";
    oPc = 0;
    oI0 = false;
    UI.invalidate();
}
function doCheck() {
    A.busy("Verificando atualização...");
    if (!Net.isConnected()) {
        oSt = "nowifi";
    } else {
        var info2 = System.otaCheck();
        oIn = info2;
        if (info2.fetchFailed || info2.rejected) {
            oSt = "failed";
            oEt = "Falha na verificação";
            oEr = info2.rejected ? "O canal recusou a atualização." :
                     "Confira a conexão e tente de novo.";
        } else if (!info2.available) {
            oSt = "uptodate";
        } else {
            oSt = "avail";
            oBh = 0;
            UI.resetScroll("ota");
        }
    }
    UI.invalidate();
}

// ---- Sobre (com reset de fabrica) ------------------------------------------

function scrAbout(c) {
    UI.invalidate();   // o form abre em frame TOTAL (A.run ja consumiu o begin)
    A.form.run("Sobre", function () {
        var i = info();
        var sdTot = FS.getTotalSpace("/sd");
        var a = [];
        a.push(A.form.secao("Aparelho"));
        a.push(A.form.info("Versão", "v" + System.getOSVersion()));
        a.push(A.form.info("API", System.getAPILevel()));
        a.push(A.form.info("Placa", i.board || "--"));
        a.push(A.form.info("Chip", i.chipModel || "--"));
        a.push(A.form.info("CPU", i.cpuFreqMHz + " MHz x" + i.chipCores));
        a.push(A.form.secao("Memória e armazenamento"));
        a.push(A.form.info("RAM", fmtBytes(i.freeRAM) + " de " + fmtBytes(i.totalRAM)));
        a.push(A.form.info("PSRAM", i.totalPSRAM
            ? fmtBytes(i.freePSRAM) + " de " + fmtBytes(i.totalPSRAM) : "não"));
        a.push(A.form.info("Flash", fmtBytes(i.flashSize)));
        a.push(A.form.info("Interno",
            fmtBytes(FS.getFreeSpace("/local")) + " / " + fmtBytes(FS.getTotalSpace("/local"))));
        a.push(A.form.info("SD", sdTot > 0
            ? fmtBytes(FS.getFreeSpace("/sd")) + " / " + fmtBytes(sdTot) : "ausente"));
        a.push(A.form.info("IP", System.getIPAddress() || "--", T.accent));
        a.push(A.form.secao("Capacidades"));
        a.push(A.form.info("BT", CAP.bt ? "sim" : "não (sem rádio)"));
        a.push(A.form.info("Mic", CAP.mic ? "sim" : "não (sem mic)"));
        a.push(A.form.info("Áudio", hasAudio() ? "sim" : "não (só bipes)"));
        a.push(A.form.info("Uptime", fmtUptime(i.uptimeMs)));
        a.push(A.form.secao("Zona de perigo"));
        a.push(A.form.action("Limpar configurações", function () {
            if (UI.confirm("Limpar configurações?",
                           "Redes Wi-Fi, PIN e brilho serão apagados. Apps e ícones ficam.",
                           { yes: "Continuar" }) &&
                UI.confirm("Confirmar limpeza", "Limpar todas as configurações agora?",
                           { yes: "Apagar", danger: true })) doReset("configs");
        }, { sub: "mantém apps e ícones" }));
        a.push(A.form.action("Reset total", function () {
            if (UI.confirm("Reset total?", "APAGA TUDO: apps, ícones e configurações.",
                           { yes: "Continuar" }) &&
                UI.confirm("Apagar tudo?", "O armazenamento interno será formatado. Os apps somem!",
                           { yes: "Formatar", danger: true })) doReset("total");
        }, { sub: "apaga apps, ícones e configurações" }));
        return a;
    });
    return A.BACK;
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
    gt = 0;
    for (;;) {
        UI.begin(T.bg);
        A.header("Ajustes", { back: false });
        UI.text("App protegido por PIN", 120, 110,
                { role: "title", align: "center", w: LW, id: "gate1" });
        UI.text("Digite o PIN para continuar", 120, 146,
                { role: "caption", align: "center", color: T.textDim,
                  w: LW, id: "gate2" });
        UI.text("Tentativas: " + (3 - gt), 120, 168,
                { role: "caption", align: "center", color: T.accent,
                  w: LW, id: "gate3" });
        UI.end(20);
        var pin = A.form.askText("PIN do Ajustes", { hint: "num", mask: true });
        if (pin === null || pin === "") return false;   // cancelou: fora
        if (System.verifyPin(pin)) return true;
        UI.alert("PIN", "PIN incorreto");
        gt++;
        if (gt >= 3) {
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
    UI.text("PIN corrompido", 120, 110,
            { role: "title", align: "center", color: T.warn, w: LW, id: "gcor1" });
    UI.text("O arquivo do PIN foi apagado. Defina um novo PIN.", 120, 146,
            { role: "caption", align: "center", color: T.textDim, w: LW,
              lines: 3, id: "gcor2" });
    UI.end(20);
    return !!flowNewPin();
}

// ---- laco principal (A.run e dono do UI.begin/UI.end) ----------------------

var pinSt0 = System.pinState();
var liberado = pinSt0 === 1 ? gatePin() : (pinSt0 === 2 ? gateCorrupt() : true);
if (liberado) A.run({
    menu: scrMenu,
    wifi: scrWifi,
    apps: scrApps,
    appdetail: scrAppDetail,
    time: scrTime,
    security: scrSecurity,
    display: scrDisplay,
    som: scrSom,
    sensors: scrSensors,
    watch: scrWatch,
    update: scrUpdate,
    about: scrAbout,
    notif: scrNotif
}, "menu");
