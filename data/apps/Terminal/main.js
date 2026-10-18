// CelerOS Terminal — shell simulado sobre o FS real, sobre o CelerKit (deps
// celeros.app.*): o laco de frames e do A.run (celeros.app), o teclado
// dockado e a linha de digitacao com caret sao do celeros.app.input, o
// historico persistente de comandos (anel com dedup consecutivo) e do
// celeros.app.history e a saida passa pelo saneamento Latin-1 do
// celeros.app.text (as fontes so cobrem U+0020..U+00FF). Teclado do OS
// ancorado no rodape; o app ecoa o comando executado e 'help' lista tudo.
// ES5 puro (Duktape).

var A = require("celeros.app");
require("celeros.app.input");
require("celeros.app.history");
require("celeros.app.text");

A.init();
var T = A.T;
var W = 240;
var CHW = 6;                    // fonte 1 (GLCD): 6 px por coluna
var COLS = Math.floor(W / CHW); // 40 colunas
var LINE_H = 10;

var VER = System.getOSVersion();
var cwd = "/local";
var lines = [];                 // historico de saida: {s, c}
var MAXLINES = 120;
var outDirty = true;

// ---- historico de comandos (celeros.app.history) ---------------------------
// Anel de 20 com dedup consecutivo, persistido em JSON na pasta privada do
// app (FS.appData). Na primeira execucao apos a migracao importa o arquivo
// antigo em texto puro (o 1.4.x gravava /local/config_term_hist.txt).
var hist = A.history.new({ file: "cmd.json", max: 20 });
(function () {
    if (hist.all().length) return;
    var raw = null;
    try { raw = FS.readTextFile("/local/config_term_hist.txt"); } catch (e) {}
    if (!raw) return;
    var hs = raw.split("\n");
    for (var i = 0; i < hs.length; i++) if (hs[i]) hist.push(hs[i]);
})();

function syncBar() {
    // faixa mostra usuario@host + diretorio corrente
    if (typeof System.topbarText === "function") System.topbarText("root@celeros " + cwd);
}

// ---------------------------------------------------------------- saida ----
function pushLine(s, col) {
    lines.push({ s: s, c: col || T.text });
    if (lines.length > MAXLINES) lines.shift();
    outDirty = true;
}

function out(s, col) {
    if (s === undefined || s === null) s = "";
    s = A.text.fit(String(s));         // fora do Latin-1 some (a fonte nao tem)
    while (s.length > COLS) {          // quebra em linhas de COLS colunas
        pushLine(s.substring(0, COLS), col);
        s = s.substring(COLS);
    }
    pushLine(s, col);
}

// ------------------------------------------------------------- caminhos ----
function resolve(p) {
    if (!p || p === ".") return cwd;
    var base = (p.charAt(0) === "/") ? "" : cwd;
    var parts = (base + "/" + p).split("/");
    var st = [];
    for (var i = 0; i < parts.length; i++) {
        var s = parts[i];
        if (s === "" || s === ".") continue;
        if (s === "..") { if (st.length) st.pop(); continue; }
        st.push(s);
    }
    return "/" + st.join("/");
}

function baseName(p) {
    var i = p.lastIndexOf("/");
    return i < 0 ? p : p.substring(i + 1);
}

function joinDir(dir, name) {
    return (dir.charAt(dir.length - 1) === "/") ? dir + name : dir + "/" + name;
}

function fmtKB(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "M";
    if (n >= 1024) return (n / 1024).toFixed(1) + "K";
    return n + "B";
}

function tokenize(s) {
    var toks = [], cur = "", inQ = false;
    for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        if (ch === '"') { inQ = !inQ; continue; }
        if (!inQ && ch === " ") {
            if (cur.length) { toks.push(cur); cur = ""; }
        } else cur += ch;
    }
    if (cur.length) toks.push(cur);
    return toks;
}

function promptStr() {
    return "root@celeros:" + cwd + "$ ";
}

// ------------------------------------------------------------- comandos ----
function fsRow(p) {
    var tot = FS.getTotalSpace(p), used = FS.getUsedSpace(p);
    if (!tot) { out(p + ": não montado", T.textDim); return; }
    out(p + "  " + fmtKB(used) + " usados de " + fmtKB(tot));
}

function infoLines() {
    var i = System.getInfo();
    var ip = "";
    try { if (System.wifiStatus().connected) ip = System.getIPAddress(); } catch (e) {}
    return [
        "root@celeros",
        "------------",
        "OS: CelerOS " + VER + " (API " + System.getAPILevel() + ")",
        "CPU: " + i.chipModel + " x" + i.chipCores + " @" + i.cpuFreqMHz + "MHz",
        "RAM: " + fmtKB(i.freeRAM) + " livres de " + fmtKB(i.totalRAM),
        (i.totalPSRAM ? ("PSRAM: " + fmtKB(i.freePSRAM) + " de " + fmtKB(i.totalPSRAM)) : "PSRAM: -"),
        "Uptime: " + fmtUptime(i.uptimeMs),
        "IP: " + (ip || "sem wifi")
    ];
}

function fmtUptime(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    s = s % 60;
    return h + "h" + (m < 10 ? "0" : "") + m + "m" + (s < 10 ? "0" : "") + s;
}

// tail de arquivo (logs): ultimas n linhas na tela
function tailFile(p, n) {
    var txt = FS.readTextFile(p);
    if (txt === null || txt === "") { out(p + ": vazio ou inexistente", T.err); return; }
    var ls = txt.replace(/\n+$/, "").split("\n");
    var skip = ls.length - n;
    if (skip < 0) skip = 0;
    for (var i = skip; i < ls.length; i++) out(ls[i]);
    if (skip > 0) out("... (" + skip + " linhas anteriores em " + p + ")", T.textDim);
}
function tailN(a, idx, dflt) {
    var n = a.length > idx ? parseInt(a[idx], 10) : dflt;
    if (!n || n < 1) n = dflt;
    return n > 200 ? 200 : n;
}

var LOGO = [
    " _  ___  ___ ",
    "| |/ _ \\/ __|",
    "| | (_) \\__ \\",
    "|_|\\___/|___/"
];

var cmds = {
    help: function(a) {
        out("Comandos:", T.accent);
        out("  ls cd pwd cat tail echo touch mkdir rmdir rm");
        out("  dmesg appslog  (logs: kern.log / apps.log)");
        out("  mv cp df free uname date uptime whoami");
        out("  apps vol tone battery sensors");
        out("  history !! !n clear neofetch js wifi reboot exit");
        out("Dica: echo txt > arquivo grava no FS;", T.textDim);
        out("js 2+2 avalia expressões JavaScript.", T.textDim);
        out("!! repete o ultimo comando, !n o n-esimo.", T.textDim);
    },
    ls: function(a) {
        var p = a.length ? resolve(a[0]) : cwd;
        if (!FS.isDirectory(p)) { out("ls: " + p + ": não é diretório", T.err); return; }
        var ent = FS.listDir(p);
        if (!ent || ent.length === 0) { out("(vazio)", T.textDim); return; }
        var names = [];
        for (var i = 0; i < ent.length; i++) {
            var n = ent[i];
            if (n.charAt(0) === "/") n = baseName(n);
            if (FS.isDirectory(joinDir(p, n))) n += "/";
            names.push(n);
        }
        names.sort();
        for (var j = 0; j < names.length; j++) out(names[j]);
    },
    cd: function(a) {
        var p = a.length ? resolve(a[0]) : "/";
        if (!FS.isDirectory(p)) { out("cd: " + p + ": não é diretório", T.err); return; }
        cwd = p;
        syncBar();
    },
    pwd: function() { out(cwd); },
    cat: function(a) {
        if (!a.length) { out("uso: cat <arquivo>", T.warn); return; }
        var p = resolve(a[0]);
        var txt = FS.readTextFile(p);
        if (txt === null) { out("cat: " + p + ": não encontrado", T.err); return; }
        if (txt.length > 600) {
            // arquivo grande abre no leitor rolante do kit (celeros.app.text):
            // rolagem por inercia em vez de cortar em 600 bytes
            A.text.viewer("cat " + baseName(p), function () { return txt; });
        } else {
            var ls = txt.split("\n");
            for (var i = 0; i < ls.length; i++) out(ls[i]);
        }
    },
    // ---- logs persistentes (/local/log ou /sd/log, padrao /var/log) ----
    // dmesg = kern.log (firmware/ESP_LOG), appslog = apps.log (System.print
    // dos apps, com o pacote na frente); tail serve qualquer arquivo
    dmesg: function(a) { tailFile("/local/log/kern.log", tailN(a, 0, 24)); },
    appslog: function(a) { tailFile("/local/log/apps.log", tailN(a, 0, 24)); },
    tail: function(a) {
        if (!a.length) { out("uso: tail <arquivo> [linhas]", T.warn); return; }
        tailFile(resolve(a[0]), tailN(a, 1, 10));
    },
    echo: function(a) {
        var txt = [], redir = 0, rp = null;
        for (var i = 0; i < a.length; i++) {
            if (a[i] === ">") redir = 1;
            else if (a[i] === ">>") redir = 2;
            else if (redir && rp === null) rp = a[i];
            else if (!redir) txt.push(a[i]);
        }
        var s = txt.join(" ");
        if (redir && rp) {
            var p = resolve(rp);
            var ok = (redir === 1) ? FS.writeTextFile(p, s + "\n")
                                   : FS.appendTextFile(p, s + "\n");
            out(ok ? "ok: gravado em " + p : "falha ao gravar " + p, ok ? T.ok : T.err);
        } else out(s);
    },
    touch: function(a) {
        if (!a.length) { out("uso: touch <arquivo>", T.warn); return; }
        var p = resolve(a[0]);
        if (FS.exists(p)) { out("já existe: " + p, T.textDim); return; }
        var ok = FS.writeTextFile(p, "");
        out(ok ? "ok: " + p : "falha: " + p, ok ? T.ok : T.err);
    },
    mkdir: function(a) {
        if (!a.length) { out("uso: mkdir <dir>", T.warn); return; }
        var p = resolve(a[0]);
        var ok = FS.mkdir(p);
        out(ok ? "ok: " + p : "falha: " + p, ok ? T.ok : T.err);
    },
    rmdir: function(a) {
        if (!a.length) { out("uso: rmdir <dir vazio>", T.warn); return; }
        var p = resolve(a[0]);
        var ok = FS.rmdir(p);
        out(ok ? "ok: " + p : "falha (vazio?)", ok ? T.ok : T.err);
    },
    rm: function(a) {
        var rec = false, alvo = null;
        for (var i = 0; i < a.length; i++) {
            if (a[i] === "-r" || a[i] === "-rf") rec = true;
            else alvo = a[i];
        }
        if (!alvo) { out("uso: rm [-r] <alvo>", T.warn); return; }
        var p = resolve(alvo);
        var ok;
        if (FS.isDirectory(p)) {
            if (!rec) { out("rm: " + p + " é diretório (use -r)", T.warn); return; }
            ok = FS.removeDirectory(p);
        } else {
            ok = FS.deleteFile(p);
        }
        out(ok ? "ok: " + p : "falha: " + p, ok ? T.ok : T.err);
    },
    mv: function(a) {
        if (a.length < 2) { out("uso: mv <de> <para>", T.warn); return; }
        var de = resolve(a[0]), para = resolve(a[1]);
        var ok = FS.renameFile(de, para);
        out(ok ? "ok" : "falha", ok ? T.ok : T.err);
    },
    cp: function(a) {
        if (a.length < 2) { out("uso: cp <de> <para>", T.warn); return; }
        var de = resolve(a[0]), para = resolve(a[1]);
        var ok = FS.copyFile(de, para);
        out(ok ? "ok" : "falha", ok ? T.ok : T.err);
    },
    df: function() {
        out("Sistemas de arquivos:", T.accent);
        fsRow("/local");
        fsRow("/sd");
    },
    free: function() {
        var i = System.getInfo();
        out("RAM: " + fmtKB(i.freeRAM) + " livres de " + fmtKB(i.totalRAM));
        out("menor livre: " + fmtKB(i.minFreeRAM) + "  max aloc: " + fmtKB(i.maxAllocRAM));
        if (i.totalPSRAM) out("PSRAM: " + fmtKB(i.freePSRAM) + " de " + fmtKB(i.totalPSRAM));
    },
    uname: function(a) {
        var all = false;
        for (var i = 0; i < a.length; i++) if (a[i].indexOf("a") >= 0) all = true;
        if (all) {
            var inf = System.getInfo();
            out("CelerOS " + VER + " " + inf.chipModel + " @" + inf.cpuFreqMHz +
                "MHz IDF " + inf.idfVersion);
        } else out("CelerOS");
    },
    date: function() {
        out(System.getDate() + " " + System.getTime());
    },
    uptime: function() {
        out("ligado há " + fmtUptime(System.getInfo().uptimeMs));
    },
    whoami: function() { out("root"); },
    apps: function() {
        out("apps instalados:", T.accent);
        var bases = ["/local/apps", "/sd/apps"];
        for (var b = 0; b < bases.length; b++) {
            if (!FS.isDirectory(bases[b])) continue;
            var ent = FS.listDir(bases[b]) || [];
            out(bases[b] + " (" + ent.length + ")", T.textDim);
            for (var i = 0; i < ent.length; i++) {
                var n = ent[i];
                if (n.charAt(0) === "/") n = baseName(n);
                out("  " + n);
            }
        }
    },
    vol: function(a) {
        if (typeof System.getVolume !== "function") { out("vol: firmware sem API 13", T.warn); return; }
        if (a.length) {
            var v = parseInt(a[0], 10);
            if (isNaN(v) || v < 0 || v > 100) { out("uso: vol 0..100", T.warn); return; }
            System.setVolume(v);
        }
        out("volume: " + System.getVolume() + "%");
    },
    tone: function(a) {
        if (typeof System.playTone !== "function") { out("tone: firmware sem API 12", T.warn); return; }
        var hz = a.length ? parseInt(a[0], 10) : 880;
        var ms = a.length > 1 ? parseInt(a[1], 10) : 120;
        if (isNaN(hz) || isNaN(ms) || hz < 20 || hz > 20000) { out("uso: tone [hz 20-20k] [ms]", T.warn); return; }
        System.playTone([[hz, ms]]);
        out("ok " + hz + "Hz por " + ms + "ms");
    },
    battery: function() {
        if (typeof System.battery !== "function") { out("sem API 10 (bateria)", T.warn); return; }
        var mv = System.battery();
        if (mv < 0) { out("sem divisor de bateria nesta placa", T.textDim); return; }
        out("bateria: " + (mv / 1000).toFixed(2) + "V (" + mv + " mV)");
    },
    sensors: function() {
        if (typeof Sensors === "undefined" || !Sensors.accel) { out("sem sensores (API 13, watch)", T.warn); return; }
        var a = Sensors.accel();
        if (!a) { out("acelerometro indisponivel", T.warn); return; }
        out("acel x " + a.x.toFixed(2) + "  y " + a.y.toFixed(2) + "  z " + a.z.toFixed(2));
        if (Sensors.steps) out("passos " + Sensors.steps());
        if (Sensors.temp) out("temp " + Sensors.temp().toFixed(1) + "C");
    },
    history: function() {
        var all = hist.all();
        for (var i = 0; i < all.length; i++) out("  " + (i + 1) + "  " + all[i]);
    },
    clear: function() { lines.length = 0; outDirty = true; },
    neofetch: function() {
        var info = infoLines();
        var i = 0;
        for (; i < LOGO.length && i < info.length; i++) out(LOGO[i] + "  " + info[i], T.accent);
        for (; i < info.length; i++) out("             " + info[i]);
    },
    js: function(a) {
        if (!a.length) { out("uso: js <expressão JS>", T.warn); return; }
        var expr = a.join(" ");
        try {
            var r = eval(expr);
            if (r === undefined) out("undefined", T.textDim);
            else if (typeof r === "object" && r !== null) out(JSON.stringify(r));
            else out(String(r));
        } catch (e) { out("erro: " + e, T.err); }
    },
    wifi: function(a) {
        var sub = a.length ? a[0] : "status";
        if (sub === "scan") {
            out("escaneando redes...", T.textDim);
            System.delay(30);
            var nets = Net.wifiScan();
            if (!nets || !nets.length) { out("nenhuma rede encontrada", T.textDim); return; }
            for (var i = 0; i < nets.length && i < 12; i++) {
                out(nets[i].ssid + " " + nets[i].rssi + "dBm" + (nets[i].secure ? " *" : ""));
            }
        } else {
            var st = System.wifiStatus();
            out(st.connected ? "conectado - IP " + System.getIPAddress() : "desconectado");
        }
    },
    reboot: function() { System.restart(); },
    exit: function() { System.exitApp(); }
};

function execute(line) {
    var toks = tokenize(line);
    if (!toks.length) return;
    var name = toks[0], args = [];
    for (var i = 1; i < toks.length; i++) args.push(toks[i]);
    if (cmds[name]) {
        try { cmds[name](args); }
        catch (e) {
            // exit: o firmware lanca um Error MARCADO (celerExit), nao a
            // string "OS_EXIT" — sem relancar o objeto, o catch pintava
            // "exit: erro: Error: app exit" antes da saida grudenta
            if (e === "OS_EXIT" || (e && e.celerExit)) throw e;
            out(name + ": erro: " + e, T.err);
        }
    } else {
        out(name + ": comando não encontrado", T.err);
    }
}

// ---------------------------------------------------------------- desenho ----
// A barra de titulo (nome + X) e a topbar padrao do sistema e o frame e do
// A.run: a tela so pinta a saida (fonte GLCD) — a linha de digitacao com
// caret e o teclado acoplado sao do celeros.app.input.
function drawOut() {
    var bottom = A.input.ativo() ? A.input.top() - 40 : 312;
    if (bottom <= 0) return;
    System.fillRect(0, 0, W, bottom, T.bg);
    var n = Math.floor(bottom / LINE_H);
    var start = lines.length - n;
    if (start < 0) start = 0;
    var y = 0;
    for (var i = start; i < lines.length; i++) {
        System.setTextColor(lines[i].c, T.bg);
        System.drawString(lines[i].s, 4, y, 1);
        y += LINE_H;
    }
    outDirty = false;
}

// ------------------------------------------------------------------ main ---
var kb = A.input.open({ maxLen: 96, chips: ["Limpar"] });

out("CelerOS " + VER + " terminal", T.accent);
if (kb) {
    out("digite 'help' para listar comandos", T.textDim);
} else {
    out("requer firmware com API >= 5", T.err);
}
out("");
syncBar();

// Um comando por frame: o enter chega pelo poll do celeros.app.input; o
// chip "Limpar" da faixa zera a saida (o historico de comandos fica); o
// !! / !n resolvem do anel do celeros.app.history.
A.run({
    sh: function (c) {
        var ev = A.input.poll();
        if (ev && ev.type === "enter") {
            var typed = ev.text || "";
            var line = typed, echo = true;
            if (line === "!!" && hist.all().length) {          // repete o ultimo
                line = hist.last();
                out(promptStr() + typed + "  -> " + line, T.accent);
                echo = false;
            } else if (line.length > 1 && line.charAt(0) === "!" &&
                       /^!\d+$/.test(line)) {                  // roda o n-esimo
                var hn = parseInt(line.substring(1), 10);
                var all = hist.all();
                if (hn >= 1 && hn <= all.length) {
                    line = all[hn - 1];
                    out(promptStr() + typed + "  -> " + line, T.accent);
                    echo = false;
                } else {
                    out("historico vazio na posicao " + hn, T.err);
                    line = "";
                }
            }
            if (echo) out(promptStr() + typed, T.accent);
            hist.push(line);            // dedup consecutivo e persistencia no modulo
            if (line) execute(line);
            UI.invalidate();            // frame cheio: console e card redesenham
        }

        var chip = A.input.chip();
        if (chip === "Limpar") {
            lines.length = 0;
            outDirty = true;
            UI.invalidate();
        } else if (chip) {
            UI.invalidate();
        }

        A.input.redraw(c.full);         // frame total apaga o teclado por cima
        if (c.full || outDirty) drawOut();
        if (A.input.ativo()) A.input.line(cwd);   // placeholder = diretorio corrente
    }
}, "sh");
