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
    else msg = nets.length + (nets.length === 1 ? " rede" : " redes") + " · toque para conectar";
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
    // h 72 e linhas EMPILHADAS pela altura devolvida: no vidro grande o corpo
    // mede 19 px e a legenda em +24 fixo encostava nele; a mensagem (1 linha,
    // cortada) em +36 fixo caia dentro da legenda e saia do cartao
    A.style.card(X, TOP, W, 72, { full: c.full, elev: C.small ? 1 : 2, grad: false,
        draw: function (q) {
            var scanning = scanAt > 0;
            dot(q.x + 4, q.y + 9, scanning ? T.accent : (conn ? T.ok : T.warn));
            var sy = q.y + 2;
            sy += UI.text(scanning ? "Buscando redes..." : (conn ? "Conectado" : "Desconectado"),
                          q.x + 14, sy, { color: T.text, bg: T.card, id: "st" }) + 2;
            if (conn && !scanning &&
                A.style.button("Desconectar", q.x + q.w - 92, q.y + 1, 92, 22,
                               { variant: "ghost", role: "caption" })) {
                try { Net.wifiDisconnect(); } catch (e) {}
                msg = "Desconectado. Rede salva.";
                UI.toast("Wi-Fi desconectado");
                refresh();
                UI.invalidate();
            }
            sy += UI.text(scanning ? "a varredura roda no rádio"
               : (conn ? (st.ip || "sem IP")
                       : (st.savedNetworks ? "reconexão automática armada"
                                           : "toque numa rede para conectar")),
               q.x, sy, { role: "caption", color: T.textDim, bg: T.card,
                          id: "sub", w: q.w }) + 2;
            if (msg) UI.text(msg, q.x, sy,
                { role: "caption", color: fail ? T.err : T.textDim, bg: T.card,
                  id: "msg", w: q.w, lines: 1 });
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
                     sub: (n.secure ? "protegida" : "aberta") + " · " + n.rssi + " dBm",
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
            // EMPILHADO pela altura devolvida: no vidro grande o titulo mede
            // 28 px e o divisor em +13 fixo cortava ele (o "Sinal" em +20
            // desenhou por cima do titulo)
            var sy = q.y;
            sy += UI.text(n.ssid, q.x, q.y, { role: "title", color: T.text, bg: q.bg,
                                             w: q.w, lines: 1, id: "nt" }) + 4;
            A.style.divider(q.x, sy, q.w);
            sy += 5;
            sy += UI.text("Sinal: " + n.rssi + " dBm", q.x, sy,
                          { color: T.text, bg: T.card, id: "sig" }) + 5;
            bars(q.x, sy, A.list.bars(n.rssi));
            sy += 18;
            sy += UI.text(n.secure ? "Protegida por senha" : "Rede aberta",
                          q.x, sy, { role: "caption", color: n.secure ? T.warn : T.ok,
                                     bg: T.card, w: q.w, lines: 1, id: "sec" }) + 8;
            if (A.style.button("Conectar", q.x, sy, q.w, 32,
                               { variant: "primary" })) {
                sheet = false;
                connect(n);
                return;
            }
            sy += 38;
            if (A.style.button("Fechar", q.x, sy, q.w, 28,
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
    var i = A.list.view("nets", X, TOP + 78, W, BOT - TOP - 114, rs, { row: 40 });
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
            // EMPILHADO pela altura devolvida: no vidro grande a legenda mede
            // 15 px e o rotulo em +14/+56 fixo encostava nela
            var sy = q.y;
            sy += UI.text("1. Conecte-se à rede", q.x, sy,
                          { role: "caption", color: T.textDim, bg: T.card, id: "p1" }) + 2;
            sy += UI.text(ap || "(abrindo...)", q.x, sy,
                          { color: T.accent, bg: T.card, id: "ap" }) + 6;
            sy += UI.text("2. Abra no navegador", q.x, sy,
                          { role: "caption", color: T.textDim, bg: T.card, id: "p2" }) + 2;
            sy += UI.text("http://192.168.4.1", q.x, sy,
                          { color: T.accent, bg: T.card, id: "url" }) + 6;
            sy += UI.text(pst === 0 ? "Aguardando configuração..."
               : pst === 1 ? "Conectando..."
               : pst === 2 ? "Conectado!"
               : pst === 3 ? "Falhou - tente de novo pela página"
               : "Falha ao iniciar o portal",
               q.x, sy, { role: "caption", color: pst === 2 ? T.ok : pst === 3 ? T.err : T.textDim,
                          bg: T.card, id: "pst" }) + 4;
            if (pdet) UI.text(pdet, q.x, sy,
                              { role: "caption", color: T.textDim, bg: T.card, id: "det" });
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
