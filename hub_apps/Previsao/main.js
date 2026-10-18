// Previsao — previsao do tempo via Open-Meteo sobre o CelerKit (deps celeros.app.*).
// Busca o tempo atual + 4 dias, grava o cache no appData (celeros.app.data) e
// instala o plugin do watchface (appData/watchface.js) na primeira execucao —
// o relogio passa a mostrar a linha do tempo e o toque nela abre este app
// (System.launchApp). Sem WiFi, cai para o clima do celular (Gadgetbridge).
// A rede nao estoura (celeros.app.net), o seletor de cidade e o pedido de
// lat/lon validado sao do celeros.app.form. ES5 puro (Duktape).

var A = require("celeros.app");
require("celeros.app.net");       // getJSON que nunca estoura + retry com backoff
require("celeros.app.data");      // cache do clima em arquivo + cidade no NVS
require("celeros.app.form");      // seletor bloqueante + askNum validado
require("celeros.app.list");      // linhas dos dias cacheadas por carimbo
require("celeros.app.text");      // saneamento Latin-1 do que vem de fora

A.init();
var T = A.T;
var LX = A.L.x, LW = A.L.w;

var DATA = FS.appData();              // "/local/data/celeros.previsao/"
var CACHE = DATA + "forecast.json";
var PLUGIN = DATA + "watchface.js";

var HAS_PHONE = typeof Phone !== "undefined" && Phone && typeof Phone.weather === "function";

var CIDADES = [
    { n: "Sao Paulo", la: -23.55, lo: -46.64 },
    { n: "Rio de Janeiro", la: -22.91, lo: -43.17 },
    { n: "Belo Horizonte", la: -19.92, lo: -43.94 },
    { n: "Curitiba", la: -25.43, lo: -49.27 },
    { n: "Porto Alegre", la: -30.03, lo: -51.23 },
    { n: "Brasilia", la: -15.79, lo: -47.88 },
    { n: "Salvador", la: -12.97, lo: -38.5 },
    { n: "Manaus", la: -3.12, lo: -60.02 }
];
var DIA = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];

// ---- cidade escolhida (NVS via celeros.app.data; le o formato antigo) --------
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
    try {                                    // formato antigo (ate a 1.1.0)
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

// ---- codigo WMO -> texto pt -------------------------------------------------
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

// ---- cache e frescura (o firmware nao expoe epoch: data/hora do aparelho) ----
var d = null;
var msg = "";
var ver = 0;                          // carimbo das linhas dos dias

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

// ---- busca (Open-Meteo; fallback Phone.weather) -------------------------------
function baixa() {
    var c = cidade();
    var url = "https://api.open-meteo.com/v1/forecast?latitude=" + c.la + "&longitude=" + c.lo +
        "&current=temperature_2m,relative_humidity_2m,weather_code" +
        "&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=4&timezone=auto";
    // 1 tentativa extra com backoff: falha transitiva do gateway nao vira
    // "Sem conexao" na primeira erro de rede
    var r = A.net.retry(function () { return A.net.getJSON(url); },
                        { n: 1, backoff: 1200,
                          ok: function (v) { return !!(v && v.current && v.daily); } });
    if (r && r.current && r.daily) {
        d = {
            v: 1, city: c.n, t: Math.round(r.current.temperature_2m),
            hum: typeof r.current.relative_humidity_2m === "number" ? r.current.relative_humidity_2m : -1,
            txt: wmo(r.current.weather_code),
            date: System.getDate(), hour: horaAgora(), days: []
        };
        var dl = r.daily;
        for (var i = 0; i < dl.time.length && i < 4; i++) {
            d.days.push({
                dt: dl.time[i], tx: Math.round(dl.temperature_2m_max[i]),
                tn: Math.round(dl.temperature_2m_min[i]), txt: wmo(dl.weather_code[i])
            });
        }
        A.data.save(CACHE, d);
        ver++;
        return true;
    }
    if (HAS_PHONE) {
        try {
            var w = Phone.weather();
            if (w && typeof w.temp === "number") {
                d = {
                    v: 1, city: w.loc || c.n, t: Math.round(w.temp),
                    hum: typeof w.hum === "number" ? w.hum : -1, txt: w.txt || "",
                    date: System.getDate(), hour: horaAgora(), days: []
                };
                A.data.save(CACHE, d);
                ver++;
                return true;
            }
        } catch (e2) { }
    }
    return false;
}

function busca() {
    A.busy("Atualizando...");            // 1 frame antes da chamada bloqueante
    if (!baixa()) msg = "Sem conexão";
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

// ---- plugin do watchface (fonte unica; escrita no appData na 1a execucao) -----
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
    "        return [d.t, d.txt, d.tn, d.tx, velho() ? 1 : 0].join(\"|\");",
    "    },",
    "    line: function () {",
    "        le();",
    "        if (!d) return \"Previsao: abra o app\";",
    "        return Math.round(d.t) + \"C \" + d.txt + \" \" + d.tn + \"/\" + d.tx;",
    "    },",
    "    draw: function (x, y, w, h, bg) {",
    "        le();",
    "        if (!d) {",
    "            System.setTextColor(T.textDim);",
    "            System.drawString(\"Previsao: abra o app\", x + 14, y + 3, 2);",
    "            return;",
    "        }",
    "        var col = velho() ? T.textDim : T.text;",
    "        var s1 = Math.round(d.t) + \"C \" + d.txt;",
    "        var s2 = d.tn + \"/\" + d.tx;",
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
    } catch (e) { }
}

// ---- escolha de cidade (seletor do celeros.app.form, bloqueante) --------------
function escolheCidade() {
    var nomes = [];
    for (var i = 0; i < CIDADES.length; i++) nomes.push(CIDADES[i].n);
    nomes.push("Outra (lat,lon)");
    var i = A.form.pick("Cidade", nomes, sel >= 0 ? sel : nomes.length - 1);
    if (i < 0) return false;             // voltou sem escolher
    if (i === nomes.length - 1) {
        var la = A.form.askNum("Latitude", { min: -90, max: 90 });
        if (la === null) return false;
        var lo = A.form.askNum("Longitude", { min: -180, max: 180 });
        if (lo === null) return false;
        custom = { n: "Custom", la: la, lo: lo };
        sel = -1;
    } else {
        sel = i;
    }
    salvaCidade();
    return true;
}

// ---- UI -----------------------------------------------------------------------
// linhas dos dias: so reconstruem quando o carimbo muda (ver)
var listaDias = A.list.make(
    function () { return d ? ver : -1; },
    function () {
        var rows = [];
        if (d) {
            for (var i = 1; i < d.days.length && i < 4; i++) {
                var f = d.days[i];
                rows.push({ label: diaLabel(f.dt, i), sub: f.txt, right: f.tn + "° / " + f.tx + "°" });
            }
        }
        return rows;
    });

function telaMain(c) {
    var cid = cidade();
    UI.text(cid ? A.text.fit(cid.n) : "?", 120, 12, { align: "center", color: T.textDim, id: 1 });
    if (!d) {
        UI.card(LX, 44, LW, 120);
        UI.text("Sem dados ainda", 120, 76, { role: "title", align: "center", color: T.textDim });
        UI.text(msg || "Toque em Atualizar", 120, 112, { role: "caption", align: "center", color: T.textDim });
        UI.cardEnd();
    } else {
        // cartao principal: gradiente + temperatura grande (so no frame total)
        if (c.full) System.fillGradient(LX, 40, LW, 124, T.accentD, T.card, 14);
        UI.text(d.t + "°C", 120, 54, { role: "display", align: "center", color: d.t >= 30 ? T.warn : T.text });
        UI.text(A.text.fit(d.txt), 120, 104, { role: "title", align: "center", color: T.accent });
        if (d.hum >= 0) UI.text("umidade " + d.hum + "%", 120, 136, { role: "caption", align: "center", color: T.textDim });
        var rows = listaDias.rows();
        if (rows.length) UI.list("dias", LX, 172, LW, 3 * 30 + 4, rows, { rowH: 30 });
    }
    var info = msg || (d ? (velho() ? "dados de " + d.date : "de hoje, " + d.hour + "h") : "");
    UI.text(info, 120, 268, { role: "caption", align: "center", color: msg === "Sem conexão" ? T.err : T.textDim, id: 2 });
    if (UI.button("Atualizar", LX, 282, 132, 32)) busca();
    if (UI.button("Cidade", LX + 140, 282, LW - 140, 32, { style: "ghost" })) {
        if (escolheCidade()) {
            d = null;                    // cidade nova: cache antigo nao engana
            msg = "";
            busca();
        }
    }
}

// ---- laco -----------------------------------------------------------------------
instalaPlugin();
d = A.data.load(CACHE, null);
if (!d || velho()) busca();          // cache frio: ja atualiza ao abrir
A.run({ main: telaMain }, "main", { fps: 10 });
