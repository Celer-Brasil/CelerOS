// HTTP Demo 2.0 — exercita a rede pelo CelerKit (celeros.app.net) e o probe
// de capacidade (celeros.app.caps). Duas fontes publicas (USD/BRL e BTC/USD)
// em cards do UI kit 2.0 (gradiente/sombra), com latencia medida, retry com
// backoff, auto-refresh (mais lento no modo leve da CYD) e um estado "sem
// Wi-Fi" explicito: o botao vira "Conectar Wi-Fi" e usa o A.wifiWait. O
// A.run e dono do frame; nada de timers extras.

var A = require("celeros.app");
require("celeros.app.net");
require("celeros.app.style");
require("celeros.app.caps");

A.init();
var T = A.T;
var L = A.L;
var CAP = A.caps.probe();
var AUTO = CAP.small ? 90000 : 60000;   // CYD/devkit: menos rede por minuto

var URL_USD = "https://economia.awesomeapi.com.br/json/last/USD-BRL";
var URL_BTC = "https://api.coinbase.com/v2/prices/BTC-USD/spot";

// estado por fonte: {state: idle|loading|ok|fail, ...dados}
var usd = { state: "idle" };
var btc = { state: "idle" };
var ocupado = false;   // entre o toque e o fim das buscas (chamadas bloqueantes)
var nextAt = 0;        // relogio do proximo auto-refresh

// Uma busca: UM frame de ocupado antes de travar, rede conferida e getJSON
// com retry curto (a demo nao pode esperar o default de 1.5/3/6 s).
function busca(st, url, aplica) {
    st.state = "loading";
    if (!A.net.online()) { st.state = "fail"; st.why = "sem internet"; return; }
    var t0 = A.now();
    var data = A.net.retry(function () { return A.net.getJSON(url); }, { n: 1, backoff: 1000 });
    aplica(data, A.now() - t0);
}

function fetchAll() {
    if (A.net.online()) A.busy("Buscando cotações...");
    busca(usd, URL_USD, function (data, ms) {
        if (data && data.USDBRL) {
            var q = data.USDBRL;
            usd = { state: "ok", ms: ms,
                    big: "R$ " + String(q.bid).substring(0, 5),
                    l1: "máx " + String(q.high).substring(0, 5) +
                        "  ·  mín " + String(q.low).substring(0, 5) };
        } else {
            usd = { state: "fail", why: "sem resposta" };
        }
    });
    busca(btc, URL_BTC, function (data, ms) {
        if (data && data.data && data.data.amount) {
            var a = String(data.data.amount);
            var dot = a.indexOf(".");
            btc = { state: "ok", ms: ms, big: "$" + (dot > 0 ? a.substring(0, dot) : a),
                    l1: "spot em USD  ·  1 BTC" };
        } else {
            btc = { state: "fail", why: "sem resposta" };
        }
    });
    nextAt = A.now() + AUTO;
    ocupado = false;
    UI.invalidate();
}

function quoteCard(c, y, titulo, fonte, st) {
    A.style.card(L.x, y, L.w, 92, {
        full: c.full, elev: 2, grad: true,
        draw: function (r) {
            UI.text(titulo + "  ·  " + fonte, r.x, r.y,
                    { role: "caption", color: T.textDim, bg: r.bg, w: r.w - 58, lines: 1 });
            if (st.state === "ok") {
                UI.badge(st.ms + " ms", r.x + r.w - 56, r.y - 4,
                         { color: T.raised, textColor: T.ok });
                UI.text(st.big, L.cx, r.y + 24,
                        { role: "display", align: "center", color: T.ok, bg: r.bg, w: r.w, lines: 1 });
                UI.text(st.l1, L.cx, r.y + 62,
                        { role: "caption", align: "center", color: T.textDim, bg: r.bg, w: r.w, lines: 1 });
            } else if (st.state === "loading") {
                UI.text("buscando...", L.cx, r.y + 34,
                        { role: "title", align: "center", color: T.accent, bg: r.bg, w: r.w, lines: 1 });
            } else if (st.state === "fail") {
                UI.text("sem resposta", L.cx, r.y + 26,
                        { role: "title", align: "center", color: T.err, bg: r.bg, w: r.w, lines: 1 });
                UI.text(st.why || "", L.cx, r.y + 56,
                        { role: "caption", align: "center", color: T.textDim, bg: r.bg, w: r.w, lines: 1 });
            } else {
                UI.text("-", L.cx, r.y + 30,
                        { role: "title", align: "center", color: T.textDim, bg: r.bg, w: r.w, lines: 1 });
            }
        }
    });
}

fetchAll();   // primeira busca na abertura (offline: estado "sem internet")
A.run({
    main: function (c) {
        A.header("HTTP Demo");
        var on = A.net.online();

        // estado da rede: sem Wi-Fi e claro e o botao leva ao A.wifiWait
        A.style.card(L.x, 48, L.w, 30, {
            full: c.full, elev: 1, grad: false,
            draw: function (r) {
                UI.text("Wi-Fi", r.x, r.y - 1,
                        { color: on ? T.ok : T.warn, bg: r.bg, w: 60, lines: 1 });
                UI.text(on ? System.getIPAddress() : "sem rede",
                        r.x + r.w, r.y - 1,
                        { role: "caption", align: "right", color: on ? T.text : T.textDim,
                          bg: r.bg, w: r.w - 60, lines: 1 });
            }
        });

        quoteCard(c, 86, "USD/BRL", "awesomeapi", usd);
        quoteCard(c, 186, "BTC/USD", "coinbase", btc);

        var inS = ocupado ? 0 : Math.max(0, Math.ceil((nextAt - c.now) / 1000));
        var lbl = ocupado ? "Atualizando..."
                : !on ? "Conectar Wi-Fi"
                : "Atualizar (" + inS + " s)";
        // modo leve aparece no rodape do botao (CYD/devkit sem PSRAM)
        if (A.style.button(lbl, L.x, 284, L.w, 28, {
                disabled: ocupado, role: "caption",
                variant: on ? "primary" : "secondary"
            })) {
            if (!on) {
                if (!A.wifiWait("Ligue o Wi-Fi para ver as cotações.")) return;
            }
            ocupado = true;
            fetchAll();
        }
        if (!ocupado && c.now >= nextAt) {
            ocupado = true;
            fetchAll();
        }
    }
}, "main", { fps: 10 });
