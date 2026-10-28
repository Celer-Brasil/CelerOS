// WiFi — configurador de WiFi do sistema (API 52).
//
// Veio da WifiSetupScreen nativa (main/Launcher/Screens.cpp): o radio e o
// portal continuam nativos — aqui so ha tela e politica. UI 2.0: header do
// kit, card de estado com varredura animada, lista rica (barras + cadeado),
// sheet de detalhes e botoes do A.style; A.caps deixa a CYD no modo leve.
// Fluxo: animacao da varredura (radar) -> Net.wifiScan bloqueante com
// A.progress -> lista -> sheet -> System.prompt (senha) -> Net.wifiConnect
// com A.progress. Portal cativo: System.wifiPortal* em tela propria.
// Toda chamada bloqueante roda FORA do par UI.begin/UI.end: o frame anterior
// ja esta no vidro (A.progress) e o app congela ali ate a resposta.
// Permissoes: net (scan/conexao) + system (credenciais e portal). ES5 puro.

(function () {
var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.list");
require("celeros.app.caps");
A.init();
var T = A.style.preset("soft");
var C = A.caps.probe();
var X = A.L.x, W = A.L.w, TOP = A.L.top, BOT = A.L.bottom;

var nets = null;                  // null = ainda nao escaneou nesta sessao
var fail = false;
var msg = "";
var scanAt = 0;                   // inicio da animacao que antecede o scan
var sel = -1;
var sheet = false;
var st = { connected: false, ip: "", savedNetworks: false };
var conn = false, wasConn = false;
var portalAvail = typeof System.wifiPortalStart === "function";
var pst = 0, pdet = "", pdone = 0, rescan = false;

// cadeado: 13o icone na tabela compartilhada (os 12 do kit + dot)
A.icons.map.lock = function (x, y, s, c) {
    var w = Math.round(s * .68), h = Math.round(s * .52);
    var bx = x + Math.round((s - w) / 2), by = y + Math.round(s * .38);
    System.drawCircle(bx + (w >> 1), by, Math.round(w * .3), c);
    System.fillRoundRect(bx, by, w, h, 2, c);
};

function tx(s, x, y, col, id, role) {
    UI.text(s, x, y, { role: role || "body", color: col === undefined ? T.text : col,
                       bg: T.card, id: id });
}
function dot(x, y, c) { System.fillCircle(x, y, 4, c); }

function refresh() {
    var p = conn;
    st = System.wifiStatus();
    conn = st.connected === true;
    if (conn && !p && wasConn) UI.toast("Wi-Fi reconectado");
    if (conn) wasConn = true;
}

// ---- varredura --------------------------------------------------------------
function startScan() {
    scanAt = A.now();
    if (scanAt < 1) scanAt = 1;   // 0 = ocioso
    nets = null;
    msg = "";
    UI.invalidate();
}

function doScan() {
    scanAt = 0;
    A.progress(-1, "Buscando redes...");
    var list = null, ok = true;
    try { list = Net.wifiScan(); } catch (e) { ok = false; }
    fail = !ok;
    nets = [];
    if (list && list.length) {
        for (var i = 0; i < list.length; i++) {
            var n = list[i];
            if (!n || !n.ssid) continue;          // SSID oculto entra por "Rede oculta"
            var dup = false;
            for (var j = 0; j < nets.length; j++) {
                if (nets[j].ssid === n.ssid) { dup = true; break; }
            }
            if (!dup) nets.push(n);
        }
        nets.sort(function (a, b) { return b.rssi - a.rssi; });
    }
    if (fail) msg = "Falha ao buscar redes. Toque em Buscar.";
    else if (!nets.length) msg = "Nenhuma rede por perto.";
    else msg = nets.length + (nets.length === 1 ? " rede" : " redes") + " - toque para conectar";
    rows.drop();          // SSIDs/RSSI novos: o cache por carimbo nao adivinha
    UI.invalidate();
}

// ---- conexao ---------------------------------------------------------------
function connect(n) {
    var pass = "";
    if (n.secure) {
        var p = System.prompt("Senha: " + n.ssid, "", { mask: true, nullOnCancel: true });
        if (p === null) return;                   // cancelou: volta a lista
        pass = p;
    }
    A.progress(-1, "Conectando em " + n.ssid);
    var ok = false;
    try { ok = Net.wifiConnect(n.ssid, pass); } catch (e) { ok = false; }
    fail = !ok;
    if (ok) {
        msg = "Conectado a " + n.ssid;
        UI.toast("Conectado");
    } else {
        msg = "Não foi possível conectar em " + n.ssid + ". Confira a senha.";
        UI.toast("Falha ao conectar");
    }
    refresh();
    UI.invalidate();
}

function hidden() {
    var ssid = System.prompt("Nome da rede (SSID)", "", { nullOnCancel: true });
    if (ssid === null) return;
    ssid = String(ssid).replace(/^\s+|\s+$/g, "");
    if (!ssid) return;
    connect({ ssid: ssid, secure: true, rssi: -100 });
}

// ---- portal cativo ---------------------------------------------------------
function startPortal() {
    if (!portalAvail) { UI.toast("Portal indisponível nesta placa"); return; }
    A.progress(-1, "Abrindo o portal...");
    var ok = false;
    try { ok = !!System.wifiPortalStart(); } catch (e) { ok = false; }
    if (!ok) { UI.toast("Falha ao abrir o portal"); return; }
    pst = 0;
    pdet = "";
    pdone = 0;
    return "portal";
}

function stopPortal() {
    if (portalAvail) { try { System.wifiPortalStop(); } catch (e) {} }
    rescan = true;
}

// ---- card de estado (com radar na varredura) --------------------------------
function statusCard(c) {
    A.style.card(X, TOP, W, 64, { full: c.full, elev: C.small ? 1 : 2, grad: false,
        draw: function (q) {
            var scanning = scanAt > 0;
            dot(q.x + 4, q.y + 11, scanning ? T.accent : (conn ? T.ok : T.warn));
            tx(scanning ? "Buscando redes..." : (conn ? "Conectado" : "Desconectado"),
               q.x + 14, q.y + 4, null, "st");
            if (conn && !scanning &&
                A.style.button("Desconectar", q.x + q.w - 92, q.y + 1, 92, 22,
                               { variant: "ghost", role: "caption" })) {
                try { Net.wifiDisconnect(); } catch (e) {}
                msg = "Desconectado. Rede salva.";
                UI.toast("Wi-Fi desconectado");
                refresh();
                UI.invalidate();
            }
            tx(scanning ? "a varredura roda no rádio"
               : (conn ? (st.ip || "sem IP")
                       : (st.savedNetworks ? "reconexão automática armada"
                                           : "toque numa rede para conectar")),
               q.x, q.y + 24, T.textDim, "sub", "caption");
            if (msg) UI.text(msg, q.x, q.y + 36,
                { role: "caption", color: fail ? T.err : T.textDim, bg: T.card,
                  id: "msg", w: q.w, lines: 2 });
            if (scanning) {
                var rx = q.x + q.w - 44, ry = q.y + 10;
                var rd = function (px, py, w, h) {
                    var cx = px + w / 2, cy = py + h / 2, r = w / 2 - 2;
                    System.drawCircle(cx, cy, r, T.stroke);
                    System.drawCircle(cx, cy, Math.round(r * .6), T.stroke);
                    var a = (A.now() % 1000) / 1000 * 6.283 - 1.57;
                    System.drawLine(cx, cy, cx + Math.cos(a) * r, cy + Math.sin(a) * r, T.accent);
                    System.fillCircle(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2, T.accent);
                };
                if (A.style.custom) A.style.custom("radar", rx, ry, 38, 38,
                    Math.floor(A.now() / 80), rd, { bg: T.card });
                else { System.fillRect(rx, ry, 38, 38, T.card); rd(rx, ry, 38, 38); }
            }
        } });
}

// ---- lista de redes --------------------------------------------------------
var rows = A.list.make(function () {
    return nets ? nets.length : "x";
}, function () {
    var r = [];
    if (nets) {
        for (var i = 0; i < nets.length; i++) {
            var n = nets[i];
            r.push({ label: n.ssid,
                     sub: (n.secure ? "protegida" : "aberta") + " - " + n.rssi + " dBm",
                     icon: n.secure ? "lock" : "wifi",
                     bars: A.list.bars(n.rssi), value: i });
        }
    }
    r.push({ label: "Rede oculta...", icon: "search", value: -1 });
    return r;
});

function bars(x, y, lvl) {
    for (var i = 0; i < 4; i++) {
        var bh = 4 + i * 3;
        System.fillRect(x + i * 7, y + 14 - bh, 4, bh, i < lvl ? T.ok : T.stroke);
    }
}

function netSheet(c) {
    var n = nets && nets[sel];
    if (!n) { sheet = false; return; }
    var H = 200, Y = BOT - H;
    A.style.card(X, Y, W, H, { full: c.full, pad: 12, r: T.radius, grad: false,
        draw: function (q) {
            UI.text(n.ssid, q.x, q.y, { role: "title", color: T.text, bg: q.bg,
                                        w: q.w, lines: 1, id: "nt" });
            A.style.divider(q.x, q.y + 13, q.w);
            tx("Sinal: " + n.rssi + " dBm", q.x, q.y + 20, null, "sig");
            bars(q.x, q.y + 40, A.list.bars(n.rssi));
            tx(n.secure ? "Protegida por senha" : "Rede aberta",
               q.x, q.y + 62, n.secure ? T.warn : T.ok, "sec", "caption");
            if (A.style.button("Conectar", q.x, q.y + 88, q.w, 32,
                               { variant: "primary" })) {
                sheet = false;
                connect(n);
                return;
            }
            if (A.style.button("Fechar", q.x, q.y + 128, q.w, 28,
                               { variant: "ghost" })) {
                sheet = false;
                UI.invalidate();
            }
        } });
    var t = UI.touch();
    if (t.tap && t.y < Y) { sheet = false; UI.invalidate(); }
}

// ---- telas -----------------------------------------------------------------
function home(c) {
    if (!sheet && A.header("WiFi")) return A.BACK;
    if (c.entered) refresh();
    else if (A.every(900, "wifi")) refresh();
    if (!sheet && !scanAt && (rescan || (c.entered && nets === null))) {
        rescan = false;
        startScan();
    }
    if (scanAt) {
        if (A.now() - scanAt < 360) { statusCard(c); return; }
        doScan();
    }
    if (sheet) { netSheet(c); return; }
    statusCard(c);

    var rs = rows.rows();
    var i = A.list.view("nets", X, TOP + 70, W, BOT - TOP - 112, rs, { row: 40 });
    if (i >= 0) {
        var v = rs[i].value;
        if (v >= 0) { sel = v; sheet = true; UI.invalidate(); }
        else if (v === -1) hidden();
    }

    var bw = (W - 12) / 2;
    if (A.style.button("Buscar", X, BOT - 32, bw, 30,
                       { variant: "primary" })) startScan();
    if (A.style.button(portalAvail ? "Portal" : "Sem portal",
                       X + bw + 12, BOT - 32, bw, 30,
                       { variant: "ghost", disabled: !portalAvail })) {
        var r = startPortal();
        if (r) return r;
    }
}

function portal(c) {
    if (A.header("Portal WiFi")) {
        stopPortal();
        return A.BACK;
    }
    if (A.every(500, "pp")) {
        var p = null;
        try { p = System.wifiPortalPoll(); } catch (e) { p = null; }
        if (p) {
            var s = p.state | 0;
            if (s !== pst) {
                pst = s;
                pdet = p.detail || "";
                if (s === 2) pdone = A.now();
                UI.invalidate();
            }
        }
    }
    if (pst === 2 && pdone && A.now() - pdone > 1200) {
        UI.toast("WiFi conectado");
        stopPortal();
        return A.BACK;
    }
    var ap = "";
    try { if (System.wifiPortalSsid) ap = System.wifiPortalSsid(); } catch (e) {}

    A.style.card(X, TOP, W, 190, { full: c.full, elev: C.small ? 1 : 2, grad: false,
        draw: function (q) {
            tx("1. Conecte-se à rede", q.x, q.y, T.textDim, "p1", "caption");
            tx(ap || "(abrindo...)", q.x, q.y + 14, T.accent, "ap");
            tx("2. Abra no navegador", q.x, q.y + 42, T.textDim, "p2", "caption");
            tx("http://192.168.4.1", q.x, q.y + 56, T.accent, "url");
            tx(pst === 0 ? "Aguardando configuração..."
               : pst === 1 ? "Conectando..."
               : pst === 2 ? "Conectado!"
               : pst === 3 ? "Falhou - tente de novo pela página"
               : "Falha ao iniciar o portal",
               q.x, q.y + 88, pst === 2 ? T.ok : pst === 3 ? T.err : T.textDim,
               "pst", "caption");
            if (pdet) tx(pdet, q.x, q.y + 106, T.textDim, "det", "caption");
        } });
    UI.text("O portal sobe um AP e espera a configuração.", X, TOP + 198,
            { role: "caption", color: T.textDim, bg: T.bg, w: W, lines: 2, id: "hint" });
    if (A.style.button("Cancelar", X, BOT - 32, W, 30, { variant: "ghost" })) {
        stopPortal();
        return A.BACK;
    }
}

A.run({ home: home, portal: portal }, "home");
})();
