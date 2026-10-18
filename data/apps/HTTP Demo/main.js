// HTTP Demo — exercita a rede pelo CelerKit (deps celeros.app.*). Duas
// fontes publicas (USD/BRL e BTC/USD) com latencia medida de cada
// requisicao e atualizacao automatica a cada 60 s. O que mudou na migracao:
// A.run e dono do frame (o app so desenha), A.net.getJSON nunca estoura e
// traz retry com backoff, A.busy substituiu o frame avulso de "buscando" e
// A.wifiWait espera a rede voltar. O loop de Net cru com try/catch foi
// embora; o valor didatico das chamadas ficou (URLs e latencia visiveis).

var A = require("celeros.app");
require("celeros.app.net");

A.init();

var URL_USD = "https://economia.awesomeapi.com.br/json/last/USD-BRL";
var URL_BTC = "https://api.coinbase.com/v2/prices/BTC-USD/spot";
var AUTO_MS = 60000;

// estado por fonte: {state: idle|loading|ok|fail, ...dados}
var usd = { state: "idle" };
var btc = { state: "idle" };
var ocupado = false;   // entre o toque e o fim das buscas (chamadas bloqueantes)
var nextAt = 0;        // relogio do proximo auto-refresh

function card(y, titulo, st, linhas) {
    var T = A.T;
    UI.card(A.L.x, y, A.L.w, 92);
    UI.text(titulo, A.L.x + 12, y + 9, { role: "caption", color: T.textDim });
    if (st.state === "ok") UI.badge(st.ms + " ms", A.L.x + A.L.w - 64, y + 7);
    if (st.state === "loading") {
        UI.spinner(120, y + 46, 14);
    } else if (st.state === "fail") {
        UI.text("falhou", 120, y + 30, { role: "title", align: "center", color: T.err });
        if (st.why) UI.text(st.why, 120, y + 60, { role: "caption", align: "center", color: T.textDim });
    } else if (st.state === "ok") {
        UI.text(st.big, 120, y + 26, { role: "display", align: "center", color: T.ok });
        for (var i = 0; i < linhas.length; i++) {
            UI.text(linhas[i], 120, y + 60 + i * 14, { role: "caption", align: "center", color: T.textDim, id: i });
        }
    } else {
        UI.text("-", 120, y + 36, { align: "center", color: T.textDim });
    }
    UI.cardEnd();
}

// Uma busca: UM frame de ocupado antes de travar, rede conferida e
// getJSON com retry (1 tentativa extra, backoff curto: a demo nao pode
// esperar o default de 1.5/3/6 s). O A.net.getJSON devolve null em
// qualquer erro — nada de try/catch espalhado.
function busca(st, url, aplica) {
    st.state = "loading";
    A.busy("Buscando...");
    if (!A.net.online()) { st.state = "fail"; st.why = "sem internet"; return; }
    var t0 = A.now();
    var data = A.net.retry(function () { return A.net.getJSON(url); }, { n: 1, backoff: 1000 });
    aplica(data, A.now() - t0);
}

function fetchAll() {
    busca(usd, URL_USD, function (data, ms) {
        if (data && data.USDBRL) {
            var q = data.USDBRL;
            usd = { state: "ok", ms: ms,
                    big: "R$ " + String(q.bid).substring(0, 5),
                    high: String(q.high).substring(0, 5), low: String(q.low).substring(0, 5) };
        } else {
            usd = { state: "fail", ms: ms, why: "sem resposta" };
        }
    });
    busca(btc, URL_BTC, function (data, ms) {
        if (data && data.data && data.data.amount) {
            var a = String(data.data.amount);
            var dot = a.indexOf(".");
            btc = { state: "ok", ms: ms, big: "$" + (dot > 0 ? a.substring(0, dot) : a), usd: a };
        } else {
            btc = { state: "fail", ms: ms, why: "sem resposta" };
        }
    });
    nextAt = A.now() + AUTO_MS;
    ocupado = false;
    UI.invalidate();
}

fetchAll();   // primeira busca na abertura
A.run({
    main: function (c) {
        if (A.header("HTTP Demo")) return A.BACK;
        var T = A.T, on = A.net.online();
        UI.card(A.L.x, 48, A.L.w, 26);
        UI.text("Wi-Fi", A.L.x + 12, 55, { role: "caption", color: T.textDim });
        UI.text(on ? "conectado  " + System.getIPAddress() : "desligado", A.L.x + A.L.w - 12, 55,
                { role: "caption", align: "right", color: on ? T.ok : T.warn });
        UI.cardEnd();
        card(80, "USD/BRL  (awesomeapi)", usd,
             usd.state === "ok" ? ["max " + usd.high + "  min " + usd.low] : []);
        card(178, "BTC/USD  (coinbase)", btc,
             btc.state === "ok" ? ["spot " + btc.usd + " USD"] : []);
        var inS = ocupado ? "-" : Math.max(0, Math.ceil((nextAt - c.now) / 1000));
        var go = UI.button(ocupado ? "Atualizando..." : "Atualizar (auto em " + inS + " s)",
                           A.L.x, 276, A.L.w, 36, { disabled: ocupado });
        if (!ocupado && (go || c.now >= nextAt)) {
            // rede caiu antes da busca: espera voltar (ou cancela)
            if (!A.net.online() && !A.wifiWait("Ligue o Wi-Fi para atualizar.")) return;
            ocupado = true;
            fetchAll();
        }
    }
}, "main", { fps: 10 });
