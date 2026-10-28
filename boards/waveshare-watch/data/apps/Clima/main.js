// Clima — tempo atual vindo do celular (Phone Link/Gadgetbridge) no CelerKit
// UI 2.0. ES5 puro (Duktape). O Gadgetbridge repassa o clima de um provedor
// (ex.: Breezy Weather); o firmware guarda a ultima leitura entre reboots.
// Cartao principal com cidade, glifo do ceu (sol/nuvem/chuva pintado em
// A.custom), temperatura e condicao; cartao de detalhes com umidade e idade
// da leitura. O texto que chega do celular passa por um saneamento Latin-1
// local (fora do Latin-1 some — as fontes nao tem o glifo). Layout no
// A.L/A.style.content: no vidro redondo do watch nada encosta na borda.

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
A.init();
var T = A.style.preset("soft");

var L = A.style.content();
var X = L.x, W = L.w, CX = A.L.cx, BOT = L.y + L.h;
var HY = L.y, HH = 130;                 // cartao do tempo
var DY = HY + HH + 6, DH = BOT - DY - 2; // cartao de detalhes

var HAS = typeof Phone !== "undefined" && Phone && typeof Phone.weather === "function";
var w = HAS ? Phone.weather() : null;
var last = "";
var STALE = 10800;                      // 3 h: leitura velha vira aviso
// A.custom so existe no kit local (1.1.x); no kit antigo do hub pinta no frame total
var CUSTOM = !!(A.custom && A.custom.call);

// fora do Latin-1 some: as fontes do aparelho nao tem o glifo
function fit(s) { return String(s === null || s === undefined ? "" : s).replace(/[^\u0000-\u00ff]/g, ""); }

// "agora", "há 12 min", "há 3 h", "há 2 dias"
function ago(s) {
    if (s < 90) return "agora";
    if (s < 3600) return "há " + Math.round(s / 60) + " min";
    if (s < 172800) return "há " + Math.round(s / 3600) + " h";
    return "há " + Math.round(s / 86400) + " dias";
}
// categoria do glifo pelo texto do provedor (pt/en)
function cat(t) {
    t = String(t || "").toLowerCase();
    if (t.indexOf("chuva") >= 0 || t.indexOf("rain") >= 0 ||
        t.indexOf("garoa") >= 0 || t.indexOf("tempestade") >= 0) return 2;
    if (t.indexOf("nubl") >= 0 || t.indexOf("cloud") >= 0 ||
        t.indexOf("nuvem") >= 0 || t.indexOf("encoberto") >= 0) return 1;
    return 0;
}

// ---- glifo do ceu (sol / nuvem / chuva), repintado so quando muda ----------
function ceu(x, y, s, k, full) {
    var paint = function () {
        var cx = x + Math.round(s / 2), cy = y + Math.round(s / 2);
        var r = Math.round(s * 0.2);
        if (k === 2) {
            System.fillSmoothCircle(cx - 9, cy + 2, r, T.textDim);
            System.fillSmoothCircle(cx + 3, cy - 4, r + 3, T.textDim);
            System.fillSmoothCircle(cx + 13, cy + 3, r - 1, T.textDim);
            System.fillRoundRect(cx - 19, cy + 3, 38, 13, 6, T.textDim);
            for (var i = 0; i < 3; i++) {
                var rx = cx - 10 + i * 10;
                System.drawWideLine(rx, cy + 21, rx - 2, cy + 28, 2, T.accent);
            }
        } else if (k === 1) {
            System.fillSmoothCircle(cx - 10, cy + 3, r, T.textDim);
            System.fillSmoothCircle(cx + 4, cy - 5, r + 5, T.textDim);
            System.fillSmoothCircle(cx + 15, cy + 4, r, T.textDim);
            System.fillRoundRect(cx - 21, cy + 4, 42, 14, 7, T.textDim);
        } else {
            for (var j = 0; j < 8; j++) {
                var a = j * Math.PI / 4;
                System.drawWideLine(Math.round(cx + Math.cos(a) * (r + 5)),
                                    Math.round(cy + Math.sin(a) * (r + 5)),
                                    Math.round(cx + Math.cos(a) * (r + 11)),
                                    Math.round(cy + Math.sin(a) * (r + 11)),
                                    2, T.warn);
            }
            System.fillSmoothCircle(cx, cy, r, T.warn);
        }
    };
    if (CUSTOM) A.custom("ceu", x, y, s, s, k, paint, { bg: T.card });
    else if (full) paint();
}

function semDados(c) {
    A.style.card(X, HY, W, HH, { full: c.full, pad: 10, draw: function (q) {
        A.icons.draw("info", CX - 9, q.y + 10, 18, { color: T.textDim });
        UI.text("Sem dados ainda", CX, q.y + 36,
                { role: "title", align: "center", color: T.text, bg: q.bg, w: q.w, lines: 1 });
        UI.text("Gadgetbridge > clima", CX, q.y + 62,
                { role: "caption", align: "center", color: T.accent, bg: q.bg, w: q.w, lines: 1 });
        UI.text("O celular envia o clima de um provedor, como o Breezy Weather.",
                CX, q.y + 84,
                { role: "caption", align: "center", color: T.textDim, bg: q.bg, w: q.w, lines: 2 });
    }});
    A.style.card(X, DY, W, DH, { full: c.full, pad: 10, draw: function (q) {
        UI.text("Como ativar", q.x, q.y + 4,
                { role: "body", color: T.text, bg: q.bg, w: q.w, lines: 1 });
        UI.text("1. Pareie o celular no app Celular", q.x, q.y + 28,
                { role: "caption", color: T.textDim, bg: q.bg, w: q.w, lines: 1 });
        UI.text("2. Instale um provedor de clima", q.x, q.y + 46,
                { role: "caption", color: T.textDim, bg: q.bg, w: q.w, lines: 1 });
        UI.text("3. Gadgetbridge > Clima", q.x, q.y + 64,
                { role: "caption", color: T.textDim, bg: q.bg, w: q.w, lines: 1 });
    }});
}

var main = function (c) {
    var sub = !HAS ? "sem link" : w ? ago(w.age) : "sem dados";
    if (A.header("Clima", { sub: sub })) return A.BACK;
    if (A.every(500, "cl")) {
        w = HAS ? Phone.weather() : null;
        var sig = w ? [Math.round(w.temp), w.txt, w.hum, w.loc,
                       Math.floor(w.age / 60)].join("|") : "-";
        if (sig !== last) { last = sig; UI.invalidate(); }
    }
    if (!HAS) {
        A.style.card(X, HY, W, 120, { full: c.full, pad: 10, draw: function (q) {
            A.icons.draw("alert", q.x, q.y + 6, 18, { color: T.warn });
            UI.text("Sem Phone Link nesta placa", q.x + 24, q.y + 6,
                    { role: "title", color: T.warn, bg: q.bg, w: q.w - 24, lines: 2 });
            UI.text("O Clima recebe a leitura do celular pelo Gadgetbridge. Sem o Phone Link não há dados.",
                    q.x, q.y + 50,
                    { role: "caption", color: T.textDim, bg: q.bg, w: q.w, lines: 3 });
        }});
        return;
    }
    if (!w) { semDados(c); return; }

    var k = cat(w.txt), old = w.age > STALE;
    // -- cartao do tempo --
    A.style.card(X, HY, W, HH, { full: c.full, pad: 10, draw: function (q) {
        UI.text(fit(w.loc || ""), CX, q.y + 2,
                { role: "caption", align: "center", color: T.textDim, bg: q.bg,
                  id: "loc", w: q.w, lines: 1 });
        UI.text(Math.round(w.temp) + "°C", X + 72, q.y + 18,
                { role: "display", color: w.temp >= 30 ? T.warn : T.text,
                  bg: q.bg, id: "tp", w: W - 82, lines: 1 });
        UI.text(fit(w.txt || ""), X + 72, q.y + 54,
                { role: "body", color: T.accent, bg: q.bg, id: "tx", w: W - 82, lines: 2 });
        UI.text("Atualizado " + ago(w.age), CX, q.y + 92,
                { role: "caption", align: "center", color: old ? T.warn : T.textDim,
                  bg: q.bg, id: "ag", w: q.w, lines: 1 });
    }});
    ceu(X + 4, HY + 26, 64, k, c.full);

    // -- detalhes --
    A.style.card(X, DY, W, DH, { full: c.full, pad: 10, draw: function (q) {
        var y = q.y;
        UI.text("Umidade", q.x, y + 6, { role: "body", color: T.text, bg: q.bg, w: q.w - 60, lines: 1 });
        UI.text(w.hum >= 0 ? w.hum + "%" : "n/d", q.x + q.w, y + 8,
                { role: "caption", align: "right", color: T.textDim, bg: q.bg, w: 60, lines: 1 });
        UI.text("Fonte", q.x, y + 30, { role: "body", color: T.text, bg: q.bg, w: q.w - 70, lines: 1 });
        UI.text("celular", q.x + q.w, y + 32,
                { role: "caption", align: "right", color: T.textDim, bg: q.bg, w: 70, lines: 1 });
        UI.text("Leitura", q.x, y + 54, { role: "body", color: T.text, bg: q.bg, w: q.w - 70, lines: 1 });
        UI.text(ago(w.age), q.x + q.w, y + 56,
                { role: "caption", align: "right", color: old ? T.warn : T.textDim,
                  bg: q.bg, w: 70, lines: 1 });
        A.style.divider(q.x, y + 78, q.w);
        UI.text("Sem Wi-Fi no relógio", CX, y + 84,
                { role: "caption", align: "center", color: T.textDim, bg: q.bg, w: q.w, lines: 1 });
    }});
};
main.fps = 3;

A.run({ main: main }, "main");
