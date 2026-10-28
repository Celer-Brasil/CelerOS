// Nucleo — painel dos servicos de fundo do OS (API 42): check de atualizacao
// (24 h com Wi-Fi) e relogio (SNTP + epoch). A tela so mostra o que o
// service.js faz FORA do vidro; o estado vivo vem de Storage + System.
// UI 2.0: card do A.style com os tokens do tema, secoes com divisores, relogio
// grande com segundos/data, botoes e pontos de estado; sem A.caps (o painel e
// leve por natureza, so um card) para caber no budget de 12 KB da CYD.
// O service.js e o policy.js seguem sem o kit: gates proprios no policy.js e
// estado compartilhado por Storage (o svchost nao carrega deps).
// ES5 puro (Duktape).
(function () {
var A = require("celeros.app");
require("celeros.app.style");
A.init();
var T = A.style.preset("soft");
var X = A.L.x, W = A.L.w, Y = A.L.top, BOT = A.L.bottom;
var cn = false, ok = true, tm = "", dt1 = "";
var la = null;                     // resultado do check manual desta sessao
var WD = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];

function dot(x, y, c) { System.fillCircle(x, y, 4, c); }
// texto dentro do card: bg fixo (o draw do card so roda com o card na pilha)
function tx(s, x, y, c, id, r, al) {
    UI.text(s, x, y, { role: r || "body", color: c === undefined ? T.text : c,
                       bg: T.card, id: id, align: al || "left",
                       w: al === "right" ? 96 : 0, lines: 1 });
}
// linha rotulo + valor: ponto de estado, rotulo a esquerda, valor a direita
function row(q, y, label, val, c, id) {
    dot(q.x + 3, q.y + y + 6, c);
    tx(label, q.x + 13, q.y + y, T.text, id + "l");
    tx(val, q.x + q.w, q.y + y, c, id + "v", "caption", "right");
}
function check() {                 // texto do ultimo check (Storage do servico)
    var v = la ? (la.fetchFailed ? "falha" : (la.available ? la.version : "-"))
               : Storage.get("last_check", "");
    if (v === "falha") return "falha no hub";
    if (v === "-") return "sem novidades";
    if (v) return "nova " + v;
    return "nunca";
}
function up(ms) {                  // uptime curto: 0h35m
    var m = Math.floor(ms / 60000);
    return Math.floor(m / 60) + "h" + ("0" + (m % 60)).slice(-2) + "m";
}
function go() {                    // check manual (o servico faz o de 24 h)
    A.busy("Verificando...");
    var r = null;
    try { r = System.otaCheck(); } catch (e) { r = null; }
    la = r || { fetchFailed: true };
    if (!r || r.fetchFailed) UI.toast("Falha no hub");
    else if (r.available) UI.toast("Nova versão " + r.version);
    else UI.toast("Versão atual");
    UI.invalidate();
}
A.run({
    main: function (c) {
        if (A.header("Núcleo", { sub: "serviços" })) return A.BACK;
        var inf = {};
        try { inf = System.getInfo() || {}; } catch (e) { inf = {}; }
        cn = System.wifiStatus().connected === true;
        ok = System.timeValid() !== false;
        tm = System.getTime() + ":" + ("0" + System.getSeconds()).slice(-2);
        dt1 = System.getDate();
        var wd = System.getWeekday ? WD[System.getWeekday()] : "";
        var tz = "";
        try { if (System.getTimezone) tz = System.getTimezone(); } catch (e) { tz = ""; }

        A.style.card(X, Y, W, BOT - Y, { full: c.full, elev: 1, grad: false,
            draw: function (q) {
                // ---- atualizacao --------------------------------------
                tx("Atualização", q.x, q.y, T.textDim, "a", "caption");
                row(q, 12, "Wi-Fi", cn ? "conectado" : "sem rede",
                    cn ? T.ok : T.warn, "w");
                row(q, 30, "Último check", check(), la && la.available ? T.accent : T.textDim, "chk");
                if (A.style.button("Checar agora", q.x, q.y + 50, q.w, 28,
                                   { disabled: !cn })) go();
                A.style.divider(q.x, q.y + 86, q.w);

                // ---- relogio ------------------------------------------
                tx("Relógio", q.x, q.y + 94, T.textDim, "b", "caption");
                tx(tm, q.x, q.y + 104, T.text, "clk", "display");
                tx((wd ? wd + ", " : "") + dt1, q.x, q.y + 140, T.textDim, "dt", "caption");
                row(q, 154, "SNTP", ok ? "ok" : "aguardando",
                    ok ? T.ok : T.warn, "sn");
                if (tz) tx("Fuso: " + tz, q.x, q.y + 172, T.textDim, "tz", "caption");
                A.style.divider(q.x, q.y + 186, q.w);

                // ---- servico ------------------------------------------
                tx("Serviço", q.x, q.y + 194, T.textDim, "c", "caption");
                row(q, 206, "Núcleo no ar", up(inf.uptimeMs || 0), T.ok, "up");
                tx("Check auto: 24 h · SNTP: 30 s", q.x, q.y + 224,
                   T.textDim, "hint", "caption");
            } });
    }
}, "main", { fps: 10 });
})();
