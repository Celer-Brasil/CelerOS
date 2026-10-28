// CelerOS Terminal — shell simulado sobre o FS real. O laco de frames e do
// A.run, o teclado dockado e a linha de digitacao com caret sao do
// celeros.app.input, o historico persistente (anel com dedup consecutivo) do
// celeros.app.history e o saneamento Latin-1 da saida do celeros.app.text.
// UI 2.0: header com acao, cartao da saida, chips de atalho e a paleta de
// comandos (sheet com abas Comandos/Historico) do celeros.app.style/widgets.
// A saida rola com UI.scrollBegin/scrollEnd e gruda no fim (auto-scroll)
// ate o usuario arrastar para cima. Teclado do OS ancorado no rodape; o app
// ecoa o comando executado e 'help' lista tudo. ES5 puro (Duktape).
(function () {
var A = require("celeros.app");
require("celeros.app.input");
require("celeros.app.history");
require("celeros.app.text");
require("celeros.app.style");
require("celeros.app.widgets");
A.init();
var T = A.style.preset("soft");
var CL = 38;                  // largura util do cartao da saida
var LH = 9;
var V = System.getOSVersion();
var cw = "/local";
var ln = [];                 // historico de saida: {s, c}
var MX = 120;
var g = 0;                    // muda no clear (assinatura do A.custom)
var sk = true;               // auto-scroll no fim
var sg = "";
var CU = !!(A.style && A.style.custom);   // API 52 local; hub 1.0.1 nao tem
// ---- historico de comandos (celeros.app.history) ---------------------------
// Anel de 20 com dedup consecutivo, persistido em JSON na pasta privada do
// app (FS.appData). Na primeira execucao apos a migracao importa o arquivo
// antigo em texto puro (o 1.4.x gravava /local/config_term_hist.txt).
var HH = A.history.new({ file: "cmd.json", max: 20 });
(function () {
    if (HH.all().length) return;
    var raw = null;
    try { raw = FS.readTextFile("/local/config_term_hist.txt"); } catch (e) {}
    if (!raw) return;
    var hs = raw.split("\n");
    for (var i = 0; i < hs.length; i++) if (hs[i]) HH.push(hs[i]);
})();
// ---------------------------------------------------------------- saida ----
function pl(s, col) {
    ln.push({ s: s, c: col || T.text });
    if (ln.length > MX) ln.shift();
}
function o(s, col) {
    if (s === undefined || s === null) s = "";
    s = A.text.fit(String(s));         // fora do Latin-1 some (a fonte nao tem)
    while (s.length > CL) {          // quebra em linhas de CL colunas
        pl(s.substring(0, CL), col);
        s = s.substring(CL);
    }
    pl(s, col);
}
// ------------------------------------------------------------- caminhos ----
function rs(p) {
    if (!p || p === ".") return cw;
    var base = (p.charAt(0) === "/") ? "" : cw;
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
function bn(p) {
    var i = p.lastIndexOf("/");
    return i < 0 ? p : p.substring(i + 1);
}
function jd(dir, name) {
    return (dir.charAt(dir.length - 1) === "/") ? dir + name : dir + "/" + name;
}
function fk(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "M";
    if (n >= 1024) return (n / 1024).toFixed(1) + "K";
    return n + "B";
}
function tk(s) {
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
function ps() {
    return "root@celeros:" + cw + "$ ";
}
// ------------------------------------------------------------- comandos ----
function fr(p) {
    var tot = FS.getTotalSpace(p), used = FS.getUsedSpace(p);
    if (!tot) { o(p + ": não montado", T.textDim); return; }
    o(p + "  " + fk(used) + " usados de " + fk(tot));
}
function il() {
    var i = System.getInfo();
    var ip = "";
    try { if (System.wifiStatus().connected) ip = System.getIPAddress(); } catch (e) {}
    return [
        "root@celeros",
        "------------",
        "OS: CelerOS " + V,
        "API " + System.getAPILevel(),
        "CPU: " + i.chipModel + " x" + i.chipCores + " @" + i.cpuFreqMHz + "MHz",
        "RAM: " + fk(i.freeRAM) + "/" + fk(i.totalRAM),
        (i.totalPSRAM ? ("PSRAM: " + fk(i.freePSRAM) + "/" + fk(i.totalPSRAM)) : "PSRAM: -"),
        "Uptime: " + fu(i.uptimeMs),
        "IP: " + (ip || "sem wifi")
    ];
}
function fu(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    s = s % 60;
    return h + "h" + (m < 10 ? "0" : "") + m + "m" + (s < 10 ? "0" : "") + s;
}
// tail de arquivo (logs): ultimas n linhas na tela
function tf(p, n) {
    var txt = FS.readTextFile(p);
    if (txt === null || txt === "") { o(p + ": vazio ou inexistente", T.err); return; }
    var ls = txt.replace(/\n+$/, "").split("\n");
    var skip = ls.length - n;
    if (skip < 0) skip = 0;
    for (var i = skip; i < ls.length; i++) o(ls[i]);
    if (skip > 0) o("... (" + skip + " linhas anteriores em " + p + ")", T.textDim);
}
function tn(a, idx, dflt) {
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
var C = {
    help: function(a) {
        o("Comandos:", T.accent);
        o("  ls cd pwd cat tail echo touch mkdir");
        o("  rmdir rm mv cp df free uname date");
        o("  uptime whoami apps vol tone battery");
        o("  sensors history !! !n clear neofetch");
        o("  js wifi reboot exit dmesg appslog");
        o("  echo txt > arq grava no FS", T.textDim);
    },
    ls: function(a) {
        var p = a.length ? rs(a[0]) : cw;
        if (!FS.isDirectory(p)) { o("ls: " + p + ": não é diretório", T.err); return; }
        var ent = FS.listDir(p);
        if (!ent || ent.length === 0) { o("(vazio)", T.textDim); return; }
        var names = [];
        for (var i = 0; i < ent.length; i++) {
            var n = ent[i];
            if (n.charAt(0) === "/") n = bn(n);
            if (FS.isDirectory(jd(p, n))) n += "/";
            names.push(n);
        }
        names.sort();
        for (var j = 0; j < names.length; j++) o(names[j]);
    },
    cd: function(a) {
        var p = a.length ? rs(a[0]) : "/";
        if (!FS.isDirectory(p)) { o("cd: " + p + ": não é diretório", T.err); return; }
        cw = p;
    },
    pwd: function() { o(cw); },
    cat: function(a) {
        if (!a.length) { o("uso: cat <arquivo>", T.warn); return; }
        var p = rs(a[0]);
        var txt = FS.readTextFile(p);
        if (txt === null) { o("cat: " + p + ": não encontrado", T.err); return; }
        if (txt.length > 600) {
            // arquivo grande abre no leitor rolante do kit (celeros.app.text):
            // rolagem por inercia em vez de cortar em 600 bytes
            A.text.viewer("cat " + bn(p), function () { return txt; });
        } else {
            var ls = txt.split("\n");
            for (var i = 0; i < ls.length; i++) o(ls[i]);
        }
    },
    // ---- logs persistentes (/local/log ou /sd/log, padrao /var/log) ----
    // dmesg = kern.log (firmware/ESP_LOG), appslog = apps.log (System.print
    // dos apps, com o pacote na frente); tail serve qualquer arquivo
    dmesg: function(a) { tf("/local/log/kern.log", tn(a, 0, 24)); },
    appslog: function(a) { tf("/local/log/apps.log", tn(a, 0, 24)); },
    tail: function(a) {
        if (!a.length) { o("uso: tail <arquivo> [linhas]", T.warn); return; }
        tf(rs(a[0]), tn(a, 1, 10));
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
            var p = rs(rp);
            var ok = (redir === 1) ? FS.writeTextFile(p, s + "\n")
                                   : FS.appendTextFile(p, s + "\n");
            o(ok ? "ok: gravado em " + p : "falha ao gravar " + p, ok ? T.ok : T.err);
        } else o(s);
    },
    touch: function(a) {
        if (!a.length) { o("uso: touch <arquivo>", T.warn); return; }
        var p = rs(a[0]);
        if (FS.exists(p)) { o("já existe: " + p, T.textDim); return; }
        var ok = FS.writeTextFile(p, "");
        o(ok ? "ok: " + p : "falha: " + p, ok ? T.ok : T.err);
    },
    mkdir: function(a) {
        if (!a.length) { o("uso: mkdir <dir>", T.warn); return; }
        var p = rs(a[0]);
        var ok = FS.mkdir(p);
        o(ok ? "ok: " + p : "falha: " + p, ok ? T.ok : T.err);
    },
    rmdir: function(a) {
        if (!a.length) { o("uso: rmdir <dir vazio>", T.warn); return; }
        var p = rs(a[0]);
        var ok = FS.rmdir(p);
        o(ok ? "ok: " + p : "falha (vazio?)", ok ? T.ok : T.err);
    },
    rm: function(a) {
        var rec = false, alvo = null;
        for (var i = 0; i < a.length; i++) {
            if (a[i] === "-r" || a[i] === "-rf") rec = true;
            else alvo = a[i];
        }
        if (!alvo) { o("uso: rm [-r] <alvo>", T.warn); return; }
        var p = rs(alvo);
        var ok;
        if (FS.isDirectory(p)) {
            if (!rec) { o("rm: " + p + " é diretório (use -r)", T.warn); return; }
            ok = FS.removeDirectory(p);
        } else {
            ok = FS.deleteFile(p);
        }
        o(ok ? "ok: " + p : "falha: " + p, ok ? T.ok : T.err);
    },
    mv: function(a) {
        if (a.length < 2) { o("uso: mv <de> <para>", T.warn); return; }
        var de = rs(a[0]), para = rs(a[1]);
        var ok = FS.renameFile(de, para);
        o(ok ? "ok" : "falha", ok ? T.ok : T.err);
    },
    cp: function(a) {
        if (a.length < 2) { o("uso: cp <de> <para>", T.warn); return; }
        var de = rs(a[0]), para = rs(a[1]);
        var ok = FS.copyFile(de, para);
        o(ok ? "ok" : "falha", ok ? T.ok : T.err);
    },
    df: function() {
        o("Arquivos:", T.accent);
        fr("/local");
        fr("/sd");
    },
    free: function() {
        var i = System.getInfo();
        o("RAM: " + fk(i.freeRAM) + " livres de " + fk(i.totalRAM));
        o("min: " + fk(i.minFreeRAM) + "  max aloc: " + fk(i.maxAllocRAM));
        if (i.totalPSRAM) o("PSRAM: " + fk(i.freePSRAM) + " de " + fk(i.totalPSRAM));
    },
    uname: function(a) {
        var all = false;
        for (var i = 0; i < a.length; i++) if (a[i].indexOf("a") >= 0) all = true;
        if (all) {
            var inf = System.getInfo();
            o("CelerOS " + V + " " + inf.chipModel + " @" + inf.cpuFreqMHz +
                "MHz IDF " + inf.idfVersion);
        } else o("CelerOS");
    },
    date: function() {
        o(System.getDate() + " " + System.getTime());
    },
    uptime: function() {
        o("ligado há " + fu(System.getInfo().uptimeMs));
    },
    whoami: function() { o("root"); },
    apps: function() {
        o("apps instalados:", T.accent);
        var bases = ["/local/apps", "/sd/apps"];
        for (var b = 0; b < bases.length; b++) {
            if (!FS.isDirectory(bases[b])) continue;
            var ent = FS.listDir(bases[b]) || [];
            o(bases[b] + " (" + ent.length + ")", T.textDim);
            for (var i = 0; i < ent.length; i++) {
                var n = ent[i];
                if (n.charAt(0) === "/") n = bn(n);
                o("  " + n);
            }
        }
    },
    vol: function(a) {
        if (typeof System.getVolume !== "function") { o("vol: firmware sem API 13", T.warn); return; }
        if (a.length) {
            var v = parseInt(a[0], 10);
            if (isNaN(v) || v < 0 || v > 100) { o("uso: vol 0..100", T.warn); return; }
            System.setVolume(v);
        }
        o("volume: " + System.getVolume() + "%");
    },
    tone: function(a) {
        if (typeof System.playTone !== "function") { o("tone: firmware sem API 12", T.warn); return; }
        var hz = a.length ? parseInt(a[0], 10) : 880;
        var ms = a.length > 1 ? parseInt(a[1], 10) : 120;
        if (isNaN(hz) || isNaN(ms) || hz < 20 || hz > 20000) { o("uso: tone [hz 20-20k] [ms]", T.warn); return; }
        System.playTone([[hz, ms]]);
        o("ok " + hz + "Hz por " + ms + "ms");
    },
    battery: function() {
        if (typeof System.battery !== "function") { o("sem API 10 (bateria)", T.warn); return; }
        var mv = System.battery();
        if (mv < 0) { o("sem bateria nesta placa", T.textDim); return; }
        o("bateria: " + (mv / 1000).toFixed(2) + "V (" + mv + " mV)");
    },
    sensors: function() {
        if (typeof Sensors === "undefined" || !Sensors.accel) { o("sem sensores (API 13, watch)", T.warn); return; }
        var a = Sensors.accel();
        if (!a) { o("acelerometro indisponivel", T.warn); return; }
        o("acel x " + a.x.toFixed(2) + "  y " + a.y.toFixed(2) + "  z " + a.z.toFixed(2));
        if (Sensors.steps) o("passos " + Sensors.steps());
        if (Sensors.temp) o("temp " + Sensors.temp().toFixed(1) + "C");
    },
    history: function() {
        var all = HH.all();
        for (var i = 0; i < all.length; i++) o("  " + (i + 1) + "  " + all[i]);
    },
    clear: function() { clr(); },
    neofetch: function() {
        var info = il();
        var i = 0;
        for (; i < LOGO.length && i < info.length; i++) o(LOGO[i] + "  " + info[i], T.accent);
        for (; i < info.length; i++) o("                " + info[i]);
    },
    js: function(a) {
        if (!a.length) { o("uso: js <expressão JS>", T.warn); return; }
        var expr = a.join(" ");
        try {
            // Function em vez de eval direto: roda no escopo global do app
            // (System/FS/Net) e recebe os locais uteis do shell por parametro;
            // o jsmin pode encurtar os nomes (com eval direto nao manga nada)
            var r = Function("System", "FS", "Net", "A", "cw",
                             "return (" + expr + ")")(System, FS, Net, A, cw);
            if (r === undefined) o("undefined", T.textDim);
            else if (typeof r === "object" && r !== null) o(JSON.stringify(r));
            else o(String(r));
        } catch (e) { o("erro: " + e, T.err); }
    },
    wifi: function(a) {
        var sub = a.length ? a[0] : "status";
        if (sub === "scan") {
            o("escaneando redes...", T.textDim);
            System.delay(30);
            var nets = Net.wifiScan();
            if (!nets || !nets.length) { o("nenhuma rede encontrada", T.textDim); return; }
            for (var i = 0; i < nets.length && i < 12; i++) {
                o(nets[i].ssid + " " + nets[i].rssi + "dBm" + (nets[i].secure ? " *" : ""));
            }
        } else {
            var st = System.wifiStatus();
            o(st.connected ? "conectado - IP " + System.getIPAddress() : "desconectado");
        }
    },
    reboot: function() { System.restart(); },
    exit: function() { System.exitApp(); }
};
function x(line) {
    var toks = tk(line);
    if (!toks.length) return;
    var name = toks[0], args = [];
    for (var i = 1; i < toks.length; i++) args.push(toks[i]);
    if (C[name]) {
        try { C[name](args); }
        catch (e) {
            // exit: o firmware lanca um Error MARCADO (celerExit), nao a
            // string "OS_EXIT" — sem relancar o objeto, o catch pintava
            // "exit: erro: Error: app exit" antes da saida grudenta
            if (e === "OS_EXIT" || (e && e.celerExit)) throw e;
            o(name + ": erro: " + e, T.err);
        }
    } else {
        o(name + ": comando não encontrado", T.err);
    }
}
// ------------------------------------------------------------- paleta ----
var P = ["help", "neofetch", "df", "free", "date", "uname -a", "apps",
           "wifi status", "wifi scan", "history", "clear", "ls", "pwd"];
var HK = ["help", "neofetch", "df", "free", "date"];
var pb = false, tb = 0;
var HR = null, HS = "";
function okb() {
    A.input.open({ maxLen: 96, chips: ["Paleta", "Limpar"] });
}
function opal() {
    pb = true;
    tb = 0;
    A.input.close();               // o sheet ocupa o rodape: teclado sai
    UI.invalidate();
}
function cpal() {
    pb = false;
    okb();
    UI.invalidate();
}
function clr() {
    ln.length = 0;
    g++;
    sk = true;
    UI.resetScroll("o");
    UI.invalidate();
}
// historico para a aba: mais novo primeiro, reconstruido so quando muda
function hrow() {
    var all = HH.all();
    var stamp = all.length + ":" + (all.length ? all[all.length - 1] : "");
    if (stamp !== HS) {
        HS = stamp;
        HR = [];
        for (var i = all.length - 1; i >= 0; i--) HR.push(all[i]);
    }
    return HR;
}
// ---------------------------------------------------------------- desenho --
function paint(x, y, w, h, off) {
    System.fillRect(x, y, w, h, T.card);
    var start = Math.ceil(off / LH);     // linha parcial em cima fica fora
    for (var i = start; i < ln.length; i++) {
        var ly = y + i * LH - off;
        if (ly + 8 > y + h) break;        // e a de baixo nao vaza no cartao
        System.setTextColor(ln[i].c, T.card);
        System.drawString(ln[i].s, x, Math.floor(ly), 1);
    }
}
function draw(c) {
    var kbTop = A.input.ativo() ? A.input.top() : 312;
    var top = 34;
    var chipY = kbTop - 58;
    var outH = chipY - 4 - top;
    if (outH < 40) outH = 40;
    if (!pb) {
        var hd = A.widgets.header("Terminal", { h: 32, full: c.full,
            actions: [{ icon: "search", id: "pb" }] });
        if (hd.back) return A.BACK;
        if (hd.action === "pb") opal();
    }

    // saida: cartao + rolagem com auto-scroll no fim
    A.style.card(2, top, 236, outH, { full: c.full, pad: 0, r: 8, bg: T.card });
    var max = ln.length * LH;
    var viewH = outH - 4;
    if (sk) {
        var target = max - viewH;
        UI.scrollTo("o", target > 0 ? target : 0);
    }
    var off = UI.scrollBegin("o", 6, top + 2, 228, viewH, max);
    var t = UI.touch();
    if (t.down && t.moved && t.sy >= top && t.sy <= top + outH) sk = false;
    if (off >= max - viewH - 1) sk = true;
    var sig = ln.length + "|" + off + "|" + g;
    if (CU) {
        A.style.custom("o", 6, top + 2, 228, viewH, sig,
            function (x, y, w, h) { paint(x, y, w, h, off); }, { bg: T.card });
    } else if (c.full || sig !== sg) {
        sg = sig;
        paint(6, top + 2, 228, viewH, off);
    }
    UI.scrollEnd();
    UI.cardEnd();

    if (!pb) {
        // chips de atalho
        var cx = 4;
        for (var i = 0; i < HK.length; i++) {
            var w2 = UI.measure(HK[i], "caption") + 12;
            if (A.style.button(HK[i], cx, chipY, w2, 20,
                               { variant: "ghost", role: "caption" })) {
                sub(HK[i]);
                break;
            }
            cx += w2 + 4;
        }
        A.input.redraw(c.full);         // frame total apaga o teclado por cima
        if (A.input.ativo()) A.input.line(cw);
    } else {
        var sr = A.widgets.sheet("pb", { open: true, full: c.full, h: 236,
                                           title: "Comandos" }, function (q) {
            tb = A.widgets.segmented(q.x, q.y, q.w, 26,
                                       ["Comandos", "Histórico"], tb);
            var ly = q.y + 32;
            var lh = q.h - 32 - 34;
            if (tb === 0) {
                var i2 = UI.list("palcmd", q.x, ly, q.w, lh, P, { rowH: 30 });
                if (i2 >= 0) { var cmd = P[i2]; cpal(); sub(cmd); return; }
            } else {
                var hr = hrow();
                if (!hr.length) {
                    UI.text("Sem histórico ainda.", q.x, ly + 6,
                            { role: "caption", color: T.textDim, bg: q.bg, id: "nohist" });
                } else {
                    var j = UI.list("palhist", q.x, ly, q.w, lh, hr, { rowH: 28 });
                    if (j >= 0) {
                        var all = HH.all();
                        var hc = all[all.length - 1 - j];
                        cpal();
                        sub(hc);
                        return;
                    }
                }
            }
            if (A.style.button("Fechar", q.x, q.y + q.h - 30, q.w, 26,
                               { variant: "ghost" })) cpal();
        });
        if (sr === "close") cpal();
    }
}

// ---------------------------------------------------------------- entrada --
function sub(typed) {
    var line = typed, echo = true;
    if (line === "!!" && HH.all().length) {          // repete o ultimo
        line = HH.last();
        o(ps() + typed + "  -> " + line, T.accent);
        echo = false;
    } else if (line.length > 1 && line.charAt(0) === "!" &&
               /^!\d+$/.test(line)) {                  // roda o n-esimo
        var hn = parseInt(line.substring(1), 10);
        var all = HH.all();
        if (hn >= 1 && hn <= all.length) {
            line = all[hn - 1];
            o(ps() + typed + "  -> " + line, T.accent);
            echo = false;
        } else {
            o("historico: posicao " + hn, T.err);
            line = "";
        }
    }
    if (echo) o(ps() + typed, T.accent);
    HH.push(line);            // dedup consecutivo e persistencia no modulo
    if (line) x(line);
    sk = true;
    UI.invalidate();            // frame cheio: console e entrada redesenham
}

// ------------------------------------------------------------------ main ---
okb();
o("CelerOS " + V + " terminal", T.accent);
if (A.input.ativo()) {
    o("digite 'help' para listar comandos", T.textDim);
} else {
    o("requer firmware com API >= 5", T.err);
}
o("");

A.run({
    sh: function (c) {
        var ev = A.input.poll();
        if (ev && ev.type === "enter" && !pb) sub(ev.text || "");
        var chip = A.input.chip();
        if (chip === "Paleta") opal();
        else if (chip === "Limpar") clr();
        else if (chip) UI.invalidate();
        draw(c);
    }
}, "sh");
})();
