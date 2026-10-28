// CelerOS Web Server 2.0 — app de sistema: liga/desliga o servidor web da
// placa (porta 80: file manager, upload e OTA), mostra o IP e a senha e o
// armazenamento. UI kit 2.0 (celeros.app.style) nos cards; o estado e relido
// no A.every (nunca por frame) e o toggle aplica na hora via webSetActive,
// sem reboot. Build sem o servidor web (CELEROS_WEB_SERVER off) degrada com
// uma explicacao em vez de estourar: toda chamada e feature-detectada e
// protegida por try/catch.

var A = require("celeros.app");
require("celeros.app.style");

A.init();
var T = A.T;
var L = A.L;

// recurso presente neste firmware? (webSetActive so existe com o servidor)
var SUP = typeof System.wifiStatus === "function" &&
          typeof System.webSetActive === "function" &&
          typeof System.webActive === "function";

// ---- estado ----------------------------------------------------------------
var st = { connected: false, ip: "", webServer: false };
var auth = { user: "admin", pass: "" };
var loc = 0, locTot = 0, sd = 0, sdTot = 0, temSd = false;

function kb(n) {
    if (!(n > 0)) return "0 B";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
}
function lerStatus() {
    var ns = st;
    try { ns = System.wifiStatus() || st; } catch (e) { ns = st; }
    if (SUP) {
        try { ns.webServer = !!System.webActive(); } catch (e2) {}
    }
    st = ns;
    var ip = st.ip || "";
    if (!ip && st.connected) {
        try { ip = System.getIPAddress() || ""; } catch (e3) {}
    }
    st.ip = ip;
    if (st.webServer) {
        try {
            var a = System.webAuthInfo();
            if (a) auth = a;
        } catch (e4) {}
    }
}
function lerEspaco() {
    try { loc = FS.getFreeSpace("/local") || 0; locTot = FS.getTotalSpace("/local") || 0; } catch (e) {}
    try {
        sdTot = FS.getTotalSpace("/sd") || 0;
        temSd = sdTot > 0;
        sd = temSd ? (FS.getFreeSpace("/sd") || 0) : 0;
    } catch (e2) { temSd = false; sd = 0; sdTot = 0; }
}
function setServer(on) {
    A.busy("Aplicando...");       // UM frame antes da chamada que trava
    try { System.webSetActive(on); } catch (e) {}
    lerStatus();
    UI.invalidate();
}

// ---- cards ------------------------------------------------------------------
function statusCard(c) {
    A.style.card(L.x, 48, L.w, 64, {
        full: c.full, elev: 2, grad: true,
        draw: function (r) {
            UI.text("Servidor web", r.x, r.y, { color: T.text, bg: r.bg, w: r.w - 56, lines: 1 });
            var txt, col;
            if (!SUP) { txt = "indisponível nesta placa"; col = T.warn; }
            else if (st.webServer && st.connected) { txt = "rodando na porta 80"; col = T.ok; }
            else if (st.webServer) { txt = "ligado, sem Wi-Fi"; col = T.warn; }
            else { txt = "desligado"; col = T.textDim; }
            UI.text(txt, r.x, r.y + 22,
                    { role: "caption", color: col, bg: r.bg, w: r.w - 56, lines: 1 });
            if (SUP) {
                var on = !!st.webServer;
                if (UI.toggle(r.x + r.w - 46, r.y + 12, on) !== on) setServer(!on);
            }
        }
    });
}

function acessoCard(c) {
    A.style.card(L.x, 120, L.w, 104, {
        full: c.full, elev: 1, grad: true,
        draw: function (r) {
            UI.text("Abra no navegador", r.x, r.y,
                    { role: "caption", color: T.textDim, bg: r.bg, w: r.w, lines: 1 });
            UI.text("http://" + (st.ip || "aguardando IP"), r.x, r.y + 18,
                    { role: "title", color: T.accent, bg: r.bg, w: r.w, lines: 1 });
            A.style.divider(r.x, r.y + 46, r.w);
            UI.text("login", r.x, r.y + 54,
                    { role: "caption", color: T.textDim, bg: r.bg, w: 60, lines: 1 });
            UI.text(String(auth.user || ""), r.x + r.w, r.y + 54,
                    { role: "caption", align: "right", color: T.text, bg: r.bg, w: r.w - 60, lines: 1 });
            UI.text("senha", r.x, r.y + 72,
                    { role: "caption", color: T.textDim, bg: r.bg, w: 60, lines: 1 });
            UI.text(String(auth.pass || ""), r.x + r.w, r.y + 72,
                    { role: "caption", align: "right", color: T.text, bg: r.bg, w: r.w - 60, lines: 1 });
        }
    });
}

function avisoCard(c, titulo, msg, cor) {
    A.style.card(L.x, 120, L.w, 88, {
        full: c.full, elev: 1, grad: true,
        draw: function (r) {
            UI.text(titulo, L.cx, r.y + 4,
                    { role: "title", align: "center", color: cor, bg: r.bg, w: r.w, lines: 1 });
            UI.text(msg, L.cx, r.y + 36,
                    { role: "caption", align: "center", color: T.textDim, bg: r.bg, w: r.w, lines: 3 });
        }
    });
}

function storageCard(c, y, h) {
    A.style.card(L.x, y, L.w, h, {
        full: c.full, elev: 1, grad: true,
        draw: function (r) {
            UI.text("Armazenamento", r.x, r.y,
                    { role: "caption", color: T.textDim, bg: r.bg, w: r.w, lines: 1 });
            UI.text("Interno", r.x, r.y + 18, { color: T.text, bg: r.bg, w: 80, lines: 1 });
            UI.text((locTot ? kb(loc) + " livres" : "sem dados"),
                    r.x + r.w, r.y + 18,
                    { role: "caption", align: "right", color: T.textDim, bg: r.bg,
                      w: r.w - 70, lines: 1 });
            UI.progress(r.x, r.y + 34, r.w, 5, locTot ? Math.round((locTot - loc) * 100 / locTot) : 0);
            UI.text("Cartão SD", r.x, r.y + 44, { color: T.text, bg: r.bg, w: 90, lines: 1 });
            UI.text(temSd ? kb(sd) + " livres" : "sem cartão",
                    r.x + r.w, r.y + 44,
                    { role: "caption", align: "right", color: T.textDim,
                      bg: r.bg, w: r.w - 80, lines: 1 });
        }
    });
}

// ---- leitura inicial --------------------------------------------------------
lerStatus();
lerEspaco();

A.run({
    main: function (c) {
        // estado e espaco relidos no ticker (nunca por frame)
        if (A.every(1000, "ws")) {
            var antes = st.connected + "|" + st.webServer + "|" + st.ip;
            lerStatus();
            if (antes !== st.connected + "|" + st.webServer + "|" + st.ip) UI.invalidate();
        }
        if (A.every(2000, "ds")) lerEspaco();

        A.header("Servidor web");
        statusCard(c);

        var on = SUP && st.webServer && st.connected;
        if (!SUP) {
            avisoCard(c, "Recurso indisponível",
                      "Firmware sem servidor web. Use o cartão SD ou o celerctl para transferir arquivos.", T.warn);
        } else if (!st.connected) {
            avisoCard(c, "Wi-Fi desconectado",
                      "Conecte o aparelho a uma rede para abrir o gerenciador web no navegador.", T.warn);
        } else if (!st.webServer) {
            avisoCard(c, "Servidor desligado",
                      "Ligue para acessar arquivos e enviar uploads pelo navegador.", T.warn);
        } else {
            acessoCard(c);
        }
        storageCard(c, on ? 232 : 216, 76);
    }
}, "main", { fps: 10 });
