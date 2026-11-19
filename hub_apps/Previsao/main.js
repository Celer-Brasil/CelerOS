// Previsao — previsao do tempo via Open-Meteo no CelerKit UI 2.0.
// Hero card do A.style (gradiente/acento no frame cheio), tiles dos 4 dias
// com glifo do tempo, seletor de cidade num sheet inferior (lista + "Outra"
// com lat/lon digitado) e cache/frescura no celeros.app.data. A rede usa o
// A.net.retry (falha transitiva nao vira "sem conexao"). Sem WiFi cai no
// clima do celular (Gadgetbridge). Instala o plugin do watchface no appData
// na primeira execucao — o relogio mostra a linha e o toque abre este app.
// ES5 puro (Duktape); sem form/list: o sheet e a lista sao pintados aqui.

var A = require("celeros.app");
require("celeros.app.net");       // getJSON que nunca estoura + retry
require("celeros.app.data");      // cache em arquivo + cidade no NVS
require("celeros.app.text");      // saneamento Latin-1 do que vem de fora
require("celeros.app.style");     // hero card + botoes tokenizados

require("celeros.app.layout");

A.init();
var T = A.style.T;
var area = A.layout.bounds({ top: 40 });
var gap = 5, captionH = UI.lineHeight("caption");
var sky = System.mixColor(T.card, T.accent, 12);
var footer = { x: area.x, y: area.y + area.h - 36, w: area.w, h: 36 };
var refreshButton = A.layout.cell(footer, 2, 1, 0, gap);
var cityButton = A.layout.cell(footer, 2, 1, 1, gap);
var statusY = footer.y - captionH - gap;
var body = { x: area.x, y: area.y, w: area.w, h: statusY - gap - area.y };
var wide = A.layout.columns(body, 200, gap) >= 2;
var summary, forecast;
if (wide) {
    summary = A.layout.cell(body, 2, 1, 0, gap);
    forecast = A.layout.cell(body, 2, 1, 1, gap);
} else {
    var summaryH = Math.max(54, UI.lineHeight("body") + captionH * 2 + 16);
    summary = { x: body.x, y: body.y, w: body.w, h: summaryH };
    forecast = { x: body.x, y: body.y + summaryH + gap, w: body.w, h: body.h - summaryH - gap };
}
var dayRects = [];
for (var n = 0; n < 4; n++) dayRects.push(A.layout.cell(forecast, 2, 2, n, gap));
var sheetArea = A.layout.bounds({ top: 60 });

var DATA = FS.appData();              // "/local/data/celeros.previsao/"
var CACHE = DATA + "forecast.json";
var PLUGIN = DATA + "watchface.js";

var HAS_PHONE = typeof Phone !== "undefined" && Phone && typeof Phone.weather === "function";

var CIDADES = [
    { n: "São Paulo", la: -23.55, lo: -46.64 },
    { n: "Rio de Janeiro", la: -22.91, lo: -43.17 },
    { n: "Belo Horizonte", la: -19.92, lo: -43.94 },
    { n: "Curitiba", la: -25.43, lo: -49.27 },
    { n: "Porto Alegre", la: -30.03, lo: -51.23 },
    { n: "Brasília", la: -15.79, lo: -47.88 },
    { n: "Salvador", la: -12.97, lo: -38.5 },
    { n: "Manaus", la: -3.12, lo: -60.02 }
];
var DIA = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];

// ---- cidade escolhida (NVS via celeros.app.data; le o formato antigo) ------
var sel = 0;
var custom = null;
(function leCidade() {
    var st = A.data.loadState("cidade", null);
    if (st) {
        if (typeof st.i === "number" && st.i >= 0 && st.i < CIDADES.length) sel = st.i;
        else if (typeof st.la === "number" && typeof st.lo === "number") {
            custom = { n: st.n || "Custom", la: st.la, lo: st.lo };
            sel = -1;
        }
        return;
    }
    try {
        var sv = Storage.get("city", "");
        if (sv && sv.charAt(0) === "@") {
            var pp = sv.substring(1).split("|");
            var ll = pp[0].split(",");
            var la = parseFloat(ll[0]), lo = parseFloat(ll[1]);
            if (isFinite(la) && isFinite(lo)) {
                custom = { n: pp[1] || "Custom", la: la, lo: lo };
                sel = -1;
            }
        } else if (sv !== "") {
            var i = parseInt(sv, 10) || 0;
            if (i >= 0 && i < CIDADES.length) sel = i;
        }
    } catch (e) { sel = 0; }
})();
function cidade() { return sel >= 0 ? CIDADES[sel] : custom; }
function salvaCidade() {
    if (sel >= 0) A.data.saveState("cidade", { i: sel });
    else A.data.saveState("cidade", { la: custom.la, lo: custom.lo, n: custom.n });
}

// ---- WMO -> texto/glifo ----------------------------------------------------
function wmo(c) {
    if (c === 0 || c === 1) return "Sol";
    if (c === 2) return "Parcial";
    if (c === 3) return "Nublado";
    if (c === 45 || c === 48) return "Nevoeiro";
    if (c >= 51 && c <= 57) return "Garoa";
    if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return "Chuva";
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "Neve";
    if (c >= 95) return "Tempestade";
    return "-";
}
// texto curto dos tiles (o cartao tem 50 px)
function curto(c) {
    if (c >= 95) return "Raio";
    if (c === 45 || c === 48) return "Névoa";
    return wmo(c);
}
// glifo simples do tempo (sol/chuva/neve/storm/nublado/nevoeiro) no centro.
// So pinta no frame cheio: primitivas cruas em frame parcial passariam por
// cima do sheet aberto (ele so redesenha o cartao no frame total).
var FULL = false;
function glifo(c, cx, cy, col) {
    if (!FULL) return;
    var S = System, i, a;
    if (c === 0 || c === 1) {
        S.fillSmoothCircle(cx, cy, 6, col);
        for (i = 0; i < 8; i++) {
            a = i * Math.PI / 4;
            S.drawLine(cx + Math.cos(a) * 8, cy + Math.sin(a) * 8,
                       cx + Math.cos(a) * 11, cy + Math.sin(a) * 11, col);
        }
        return;
    }
    if (c === 45 || c === 48) {
        for (i = 0; i < 3; i++) S.drawFastHLine(cx - 9, cy - 4 + i * 4, 18, col);
        return;
    }
    // nuvem: 3 circulos + base
    S.fillCircle(cx - 5, cy - 2, 5, col);
    S.fillCircle(cx + 1, cy - 5, 6, col);
    S.fillCircle(cx + 7, cy - 1, 4, col);
    S.fillRect(cx - 9, cy - 1, 18, 5, col);
    if (c >= 95) {   // raio
        S.fillTriangle(cx + 1, cy + 4, cx - 3, cy + 11, cx + 3, cy + 11, T.warn);
    } else if ((c >= 71 && c <= 77) || c === 85 || c === 86) {   // neve
        for (i = 0; i < 3; i++) S.fillCircle(cx - 6 + i * 6, cy + 9, 1, col);
    } else if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) {   // chuva
        for (i = 0; i < 3; i++) S.drawLine(cx - 6 + i * 6, cy + 6, cx - 8 + i * 6, cy + 11, col);
    }
}

// ---- cache e frescura (o firmware nao expoe epoch: data/hora do aparelho) --
var d = null;
var msg = "";
function horaAgora() {
    try { return parseInt(System.getTime().split(":")[0], 10) || 0; } catch (e) { return 0; }
}
function velho() {
    if (!d || !d.date) return true;
    try {
        if (System.getDate() !== d.date) return true;
        var hh = (horaAgora() - d.hour + 24) % 24;
        return hh >= 3;
    } catch (e) { return true; }
}

// ---- busca (Open-Meteo; fallback Phone.weather) -----------------------------
function baixa() {
    var c = cidade();
    var url = "https://api.open-meteo.com/v1/forecast?latitude=" + c.la + "&longitude=" + c.lo +
        "&current=temperature_2m,relative_humidity_2m,weather_code" +
        "&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=4&timezone=auto";
    var r = A.net.retry(function () { return A.net.getJSON(url); },
                        { n: 1, backoff: 1200,
                          ok: function (v) { return !!(v && v.current && v.daily); } });
    if (r && r.current && r.daily) {
        d = {
            v: 1, city: A.text.fit(c.n), t: Math.round(r.current.temperature_2m),
            hum: typeof r.current.relative_humidity_2m === "number" ? r.current.relative_humidity_2m : -1,
            wc: r.current.weather_code, txt: wmo(r.current.weather_code),
            date: System.getDate(), hour: horaAgora(), days: []
        };
        var dl = r.daily;
        for (var i = 0; i < dl.time.length && i < 4; i++) {
            d.days.push({
                dt: dl.time[i], tx: Math.round(dl.temperature_2m_max[i]),
                tn: Math.round(dl.temperature_2m_min[i]), txt: wmo(dl.weather_code[i]),
                wc: dl.weather_code[i]
            });
        }
        A.data.save(CACHE, d);
        return true;
    }
    if (HAS_PHONE) {
        try {
            var w = Phone.weather();
            if (w && typeof w.temp === "number") {
                d = {
                    v: 1, src: "phone", city: A.text.fit(w.loc || c.n), t: Math.round(w.temp),
                    hum: typeof w.hum === "number" ? w.hum : -1, txt: w.txt || "",
                    date: System.getDate(), hour: horaAgora(), days: []
                };
                A.data.save(CACHE, d);
                return true;
            }
        } catch (e2) { /* sem clima do celular */ }
    }
    return false;
}

function busca() {
    A.busy("Atualizando...");            // 1 frame antes da chamada bloqueante
    if (!baixa()) msg = A.net.online() ? "Sem resposta do servidor" : "Sem Wi-Fi";
    else msg = "";
    UI.invalidate();
    return msg === "";
}

function diaLabel(iso, i) {
    if (i === 0) return "Hoje";
    if (i === 1) return "Amanhã";
    try {
        var y = parseInt(iso.substring(0, 4), 10), m = parseInt(iso.substring(5, 7), 10),
            dd = parseInt(iso.substring(8, 10), 10);
        return DIA[new Date(y, m - 1, dd).getDay()];
    } catch (e) { return "DIA"; }
}

// ---- plugin do watchface (fonte unica; escrito no appData na 1a execucao) ---
var PLUGIN_SRC = [
    "// Plugin Previsao do watchface - instalado pelo app celeros.previsao.",
    "// Le o cache do app e ocupa uma linha na banda de widgets do relogio.",
    "var T = System.theme();",
    "var CACHE = \"/local/data/celeros.previsao/forecast.json\";",
    "var d = null, lido = -60000;",
    "function wmo(c) {",
    "    if (c === 0 || c === 1) return \"Sol\";",
    "    if (c === 2) return \"Parcial\";",
    "    if (c === 3) return \"Nublado\";",
    "    if (c === 45 || c === 48) return \"Nevoeiro\";",
    "    if (c >= 51 && c <= 57) return \"Garoa\";",
    "    if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return \"Chuva\";",
    "    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return \"Neve\";",
    "    if (c >= 95) return \"Tempestade\";",
    "    return \"-\";",
    "}",
    "function le() {",
    "    if (d && System.millis() - lido < 60000) return;",
    "    lido = System.millis();",
    "    try {",
    "        var s = FS.readTextFile(CACHE);",
    "        d = s ? JSON.parse(s) : null;",
    "    } catch (e) { d = null; }",
    "}",
    "function faixa() {",
    "    var hoje = (d.days && d.days[0]) || d;",
    '    return typeof hoje.tn === "number" && typeof hoje.tx === "number" ? hoje.tn + "°/" + hoje.tx + "°" : "";',
    "}",
    "function velho() {",
    "    if (!d || !d.date) return true;",
    "    try {",
    "        if (System.getDate() !== d.date) return true;",
    "        var h = parseInt(System.getTime().split(\":\")[0], 10) || 0;",
    "        return ((h - d.hour + 24) % 24) >= 3;",
    "    } catch (e) { return true; }",
    "}",
    "return {",
    "    id: \"celeros.previsao\",",
    "    sig: function () {",
    "        le();",
    "        if (!d) return \"no\";",
    "        return [d.t, d.txt, faixa(), velho() ? 1 : 0].join(\"|\");",
    "    },",
    "    line: function () {",
    "        le();",
    "        if (!d) return \"Previsão: abra o app\";",
    '        var range = faixa();',
    '        return Math.round(d.t) + "°C " + d.txt + (range ? " " + range : "");',
    "    },",
    "    draw: function (x, y, w, h, bg) {",
    "        le();",
    "        if (!d) {",
    "            System.setTextColor(T.textDim);",
    "            System.drawString(\"Previsão: abra o app\", x + 14, y + 3, 2);",
    "            return;",
    "        }",
    "        var col = velho() ? T.textDim : T.text;",
    '        var s1 = Math.round(d.t) + "°C " + d.txt;',
    '        var s2 = faixa();',
    "        System.setTextColor(col);",
    "        System.drawString(s1, x + 14, y + 3, 2);",
    "        System.setTextColor(T.textDim);",
    "        System.drawString(s2, x + 14 + System.textWidth(s1, 2) + 10, y + 3, 2);",
    "    },",
    "    open: \"celeros.previsao\"",
    "};"
].join("\n");

function instalaPlugin() {
    try {
        if (FS.readTextFile(PLUGIN) === PLUGIN_SRC) return;
        FS.writeTextFile(PLUGIN, PLUGIN_SRC);
    } catch (e) { /* sem fs: o app segue sem o plugin */ }
}

function tile(c, f, i) {
    var box = dayRects[i];
    A.style.card(box.x, box.y, box.w, box.h, { full: c.full, elev: 0, pad: 4, r: 8,
        draw: function (q) {
            var cx = q.x + q.w / 2, cy = q.y + q.h / 2;
            var temps = f.tx + "°/" + f.tn + "°";
            var role = UI.measure(temps, "body") <= q.w ? "body" : "caption";
            var lineH = UI.lineHeight(role);
            var labelY = wide ? q.y + 2 : cy - (2 * captionH + lineH + 4) / 2;
            var tempY = wide ? cy + 3 : labelY + captionH + 2;
            var textX = wide ? cx : q.x;
            var align = wide ? "center" : "left";
            UI.text(diaLabel(f.dt, i), textX, labelY,
                    { role: "caption", align: align, color: T.textDim, w: wide ? q.w : q.w - 24 });
            if (typeof f.wc === "number") glifo(f.wc, wide ? cx : q.x + q.w - 11,
                                               wide ? (labelY + captionH + tempY) / 2 : labelY + 8, T.accent);
            UI.text(temps, textX, tempY, { role: role, align: align, color: T.text, w: q.w });
            UI.text(typeof f.wc === "number" ? curto(f.wc) : f.txt, textX, tempY + lineH + 2,
                    { role: "caption", align: align, color: T.textDim, w: q.w });
        }
    });
}

// ---- sheet de cidades (painel inferior animado, sem dep extra) --------------
var shOpen = false, shP = 0, shT = 0;
function sheetCidade(c) {
    var now = System.millis();
    var dt = shT ? now - shT : 0;
    shT = now;
    var target = shOpen ? 1 : 0;
    if (shP !== target) {
        var k = Math.min(1, dt / 160 * 4);
        shP += (target - shP) * k;
        if (Math.abs(target - shP) < 0.02) shP = target;
        UI.invalidate();
    }
    if (shP <= 0.001) return;
    var H = System.screenHeight(), h = sheetArea.h;
    var y = Math.round(H + (sheetArea.y - H) * shP);
    if (c.full) System.fillRect(0, 0, 240, H, System.mixColor(T.bg, 0, Math.round(55 * shP)));
    A.style.card(sheetArea.x, y, sheetArea.w, h,
                         { full: c.full, r: T.radius, grad: true, pad: 12,
        draw: function (q) {
            System.fillRoundRect(120 - 20, y + 6, 40, 3, 2, T.stroke);
            UI.text("Cidade", q.x, q.y, { role: "title", color: T.text, w: q.w, lines: 1 });
            var rows = [];
            for (var i = 0; i < CIDADES.length; i++) rows.push({ label: CIDADES[i].n });
            rows.push({ label: "Outra (lat,lon)", sub: "digitar coordenadas" });
            var titleH = UI.lineHeight("title") + 4;
            var k = UI.list("cidades", q.x, q.y + titleH, q.w, q.h - titleH - captionH - 6, rows, { rowH: 36, selected: sel });
            UI.text("toque fora para fechar", q.x + q.w / 2, q.y + q.h - captionH,
                    { role: "caption", align: "center", color: T.textDim, w: q.w });
            if (k >= 0) uiPick = k;
        }
    });
    var k = uiPick;
    uiPick = -1;
    if (k >= 0) {
        shOpen = false;
        if (k === CIDADES.length) {
            var la = askCoord("Latitude", -90, 90);
            if (la === null) { UI.invalidate(); return; }
            var lo = askCoord("Longitude", -180, 180);
            if (lo === null) { UI.invalidate(); return; }
            custom = { n: "Custom", la: la, lo: lo };
            sel = -1;
        } else sel = k;
        salvaCidade();
        d = null;                        // cidade nova: cache antigo nao engana
        msg = "";
        busca();
        return;
    }
    if (shOpen && uiPick < 0 && UI.touch().tap && UI.touch().y < y) {
        shOpen = false;
        UI.invalidate();
    }
}
var uiPick = -1;   // linha tocada no sheet (o draw do A.style.card nao devolve)

function askCoord(titulo, min, max) {
    var s = System.prompt(titulo, "", { hint: "ex.: " + (min < 0 ? "-23.55" : "0") });
    if (s === null || s === "") return null;
    var v = parseFloat(String(s).replace(",", "."));
    if (!isFinite(v) || v < min || v > max) {
        A.error("Valor inválido", "Digite um número entre " + min + " e " + max);
        return null;
    }
    return v;
}

// ---- UI --------------------------------------------------------------------
function current(c, box, stacked) {
    A.style.card(box.x, box.y, box.w, box.h, { full: c.full, elev: 0, pad: 8, bg: sky,
        draw: function (q) {
            var cx = q.x + q.w / 2, cy = q.y + q.h / 2;
            if (!d) {
                UI.text("Sem dados ainda", cx, cy - UI.lineHeight("title"), {
                    role: "title", align: "center", color: T.text, w: q.w });
                UI.text(msg || "Toque em Atualizar", cx, cy + 4, {
                    role: "caption", align: "center", color: msg ? T.warn : T.textDim, w: q.w });
                return;
            }
            var temp = d.t + "°C", tempW = stacked ? q.w : Math.floor(q.w * 0.43);
            var role = UI.measure(temp, "display") <= tempW ? "display" : "title";
            var tempH = UI.lineHeight(role), conditionH = UI.lineHeight("body");
            var onlyCurrent = !d.days || !d.days.length;
            var extra = (d.hum >= 0 ? captionH + 2 : 0) + (onlyCurrent ? captionH + 2 : 0);
            var y = cy - (conditionH + extra + (stacked ? tempH + gap : 0)) / 2;
            if (stacked && typeof d.wc === "number") glifo(d.wc, cx, y - 19, T.accent);
            UI.text(temp, stacked ? cx : q.x + tempW / 2, stacked ? y : cy - tempH / 2,
                    { role: role, align: "center", color: d.t >= 30 ? T.warn : T.accent, w: tempW });
            var x = stacked ? cx : q.x + tempW + gap;
            var room = stacked ? q.w : q.w - tempW - gap;
            var align = stacked ? "center" : "left";
            if (stacked) y += tempH + gap;
            UI.text(d.txt, x, y, { role: "body", color: T.text, align: align, w: room });
            y += conditionH + 2;
            if (d.hum >= 0) {
                UI.text("Umidade " + d.hum + "%", x, y,
                        { role: "caption", color: T.textDim, align: align, w: room });
                y += captionH + 2;
            }
            if (onlyCurrent) {
                var detail = d.src === "phone" ? "Clima do celular" : "Sem previsão por dia";
                UI.text(detail, x, y, { role: "caption", color: T.textDim, align: align, w: room });
            }
        }
    });
}

function telaMain(c) {
    FULL = c.full;
    if (shOpen || shP > 0.001) {
        sheetCidade(c);
        return;
    }
    UI.header("Previsão", { sub: d ? A.text.fit(d.city || "") : cidade().n });
    var count = d && d.days ? Math.min(4, d.days.length) : 0;
    current(c, count ? summary : body, wide || !count);
    for (var i = 0; i < count; i++) tile(c, d.days[i], i);
    var info = d ? (msg || (velho() ? "cache de " + d.date : "de hoje, " + d.hour + "h")) : "";
    UI.text(info, area.x + area.w / 2, statusY, {
        role: "caption", align: "center", color: msg ? T.warn : T.textDim, w: area.w });
    if (A.style.button("Atualizar", refreshButton.x, refreshButton.y, refreshButton.w, refreshButton.h)) busca();
    if (A.style.button("Cidade", cityButton.x, cityButton.y, cityButton.w, cityButton.h, { variant: "ghost" })) {
        shOpen = true;
        shT = 0;
        UI.invalidate();
    }
}

// ---- laco ------------------------------------------------------------------
instalaPlugin();
d = A.data.load(CACHE, null);
if (!d || velho()) busca();          // cache frio: ja atualiza ao abrir
A.run({ main: telaMain }, "main", { fps: 10 });
