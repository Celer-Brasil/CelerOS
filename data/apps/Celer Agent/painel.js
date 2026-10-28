// painel.js - a tela do Celer Agent (o trabalho continua no service.js).
// UI kit 2.0: cabecalho com acoes (Sair e OTA) e status do heartbeat, e uma
// lista rica rolavel com sistema, agente e diagnostico (firmware, placa,
// memoria/caps, rede, ultimo comando, fila, OTA pendente, uptime, crash).
// A checagem de OTA usa System.otaCheck e mostra o resultado no dialogo do
// kit. Headless nao entra aqui: main.js imprime estado.lines() no logcat.

var A = require("celeros.app");
var E = require("estado");

var T = null;
var LX = 8, LW = 224, TOP = 48, BOTTOM = 312;
var S = null;

function kb(n) { return Math.round((n || 0) / 1024) + " KB"; }
function up(sec) {
    sec = sec || 0;
    if (sec < 60) return sec + " s";
    if (sec < 3600) return Math.floor(sec / 60) + " min";
    return Math.floor(sec / 3600) + " h " + Math.floor((sec % 3600) / 60) + " min";
}
function clip(s, n) {
    s = String(s === null || s === undefined ? "" : s);
    return s.length > n ? s.substring(0, n - 3) + "..." : s;
}
function caps(s) {
    var o = [];
    if (s.psram) o.push("PSRAM");
    if (s.mic) o.push("mic");
    if (s.audio) o.push("audio");
    if (s.bat) o.push("bateria");
    return o.length ? o.slice(0, 3).join(", ") : "basico";
}
function status(s) {
    if (!s.cfg) return { t: "Sem configuração", c: T.err };
    if (!s.beat) return { t: s.err ? "Heartbeat falhou" : "Aguardando heartbeat", c: T.warn };
    if (s.beatAge > Math.max(90, Math.floor(s.poll / 1000) * 3)) {
        return { t: "Heartbeat atrasado", c: T.warn };
    }
    if (s.err) return { t: "Agente com erro", c: T.warn };
    return { t: "Agente ativo", c: T.ok };
}
function refresh() { S = E.snap(); }

function bar(c) {
    var nav = null;
    UI.card(0, 0, 240, 40, { color: T.card, radius: 0, stroke: false });
    if (c.full) {
        System.fillGradient(0, 0, 240, 40, System.mixColor(T.card, 0xFFFF, 6),
                            T.card, 0);
        System.fillRect(0, 39, 240, 1, T.stroke);
    }
    if (UI.button("Sair", 4, 6, 44, 28, { style: "ghost", role: "caption" })) nav = "exit";
    UI.text("Celer Agent", 52, 4, { role: "title", color: T.text,
                                    bg: T.card, w: 138, lines: 1, id: 1 });
    var st = status(S);
    UI.text(st.t + (S.beat ? " - " + S.age : ""), 52, 23,
            { role: "caption", color: st.c, bg: T.card, w: 138, lines: 1, id: 2 });
    if (UI.button("OTA", 194, 6, 42, 28, { style: "ghost", role: "caption" })) nav = "ota";
    UI.cardEnd();
    return nav;
}

function otaTxt(s) {
    if (s.ota) return "v" + s.ota + " pend.";
    return s.signed ? "assinado" : "sem OTA";
}

function rows(s) {
    var st = status(s);
    return [
        { label: "SISTEMA", enabled: false },
        { label: "Status", right: st.t, rightColor: st.c },
        { label: "Heartbeat", right: s.age },
        { label: "Device", right: clip((s.dev || "?") + " / " + s.kind, 20) },
        { label: "Firmware", right: s.fw + " / API " + s.api },
        { label: "Placa", right: s.board || "?" },
        { label: "Memória", right: kb(s.ram) + (s.psram ? " +PSRAM" : "") },
        { label: "Caps", right: caps(s) },
        { label: "Rede", right: s.wifi ? "conectado" : "sem conexão",
          rightColor: s.wifi ? T.ok : T.err },
        { label: "AGENTE", enabled: false },
        { label: "Comando", right: clip(s.last || "nenhum", 20),
          rightColor: s.last && s.last.indexOf("falhou") >= 0 ? T.err : undefined },
        { label: "Fila", right: s.cmds + " cmd / " + s.out + " ev" },
        { label: "OTA", right: otaTxt(s), rightColor: s.ota ? T.warn : undefined },
        { label: "Atualização", right: "pelo CelerApp" },
        { label: "DIAGNÓSTICO", enabled: false },
        { label: "Uptime", right: up(s.up) },
        { label: "OTA assinado", right: s.signed ? "sim" : "não" },
        { label: "Erro", right: clip(s.err || "nenhum", 22),
          rightColor: s.err ? T.err : undefined },
        { label: "Crash", right: s.crash ? "registrado" : "nenhum",
          rightColor: s.crash ? T.warn : undefined }
    ];
}

function checkOta() {
    A.busy("Consultando o hub...");
    var r = null;
    try { r = System.otaCheck(); } catch (e) { r = { fetchFailed: true, type: String(e) }; }
    var ls = [];
    if (r.fetchFailed) {
        ls.push("Falha ao consultar o hub");
        if (r.type) ls.push(clip(r.type, 30));
    } else if (r.rejected) {
        ls.push("Manifesto recusado");
        ls.push(clip(r.type || "assinatura/hash/api", 30));
    } else if (r.available && r.hasFirmware !== false) {
        ls.push("Firmware v" + (r.version || "?") + " disponível");
        ls.push("Assinatura: " + (r.signed ? "sim" : "não"));
        if (r.changelog) ls.push(clip(r.changelog, 32));
    } else {
        ls.push("Firmware em dia" + (r.version ? " (v" + r.version + ")" : ""));
    }
    ls.push("Apps: " + S.apps + " instalados");
    ls.push("update_apps de apps: pelo CelerApp");
    if (r.fetchFailed || r.rejected) A.error("Atualização", ls);
    else A.ok("Atualização", ls);
}

function painel(c) {
    if (A.every(1000, "agente") || !S) refresh();
    var nav = bar(c);
    if (nav === "exit") return A.EXIT;
    if (nav === "ota") { checkOta(); return; }
    UI.list("agente", LX, TOP, LW, BOTTOM - TOP, rows(S));
}

function run() {
    A.init();
    T = A.T;
    LX = A.L.x;
    LW = A.L.w;
    TOP = A.L.top;
    BOTTOM = A.L.bottom;
    refresh();
    A.run({ painel: painel }, "painel", { fps: 8 });
}

module.exports = { run: run };
