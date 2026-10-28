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

A.init();
var T = A.style.T;
var L = A.L, LX = L.x, LW = L.w;

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
            txt: wmo(r.current.weather_code),
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
    "        if (!d) return \"Previsão: abra o app\";",
    "        return Math.round(d.t) + \"C \" + d.txt + \" \" + d.tn + \"/\" + d.tx;",
    "    },",
    "    draw: function (x, y, w, h, bg) {",
    "        le();",
    "        if (!d) {",
    "            System.setTextColor(T.textDim);",
    "            System.drawString(\"Previsão: abra o app\", x + 14, y + 3, 2);",
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
    } catch (e) { /* sem fs: o app segue sem o plugin */ }
}

function tile(c, f, i, tx, tw) {
    A.style.card(tx, 184, tw, 72, { full: c.full, elev: 0, pad: 4, r: 8,
        draw: function (q) {
            UI.text(diaLabel(f.dt, i), q.x + q.w / 2, q.y,
                    { role: "caption", align: "center", color: T.textDim, w: q.w, lines: 1 });
            glifo(f.wc, q.x + q.w / 2, q.y + 20, T.accent);
            UI.text(f.tx + "°/" + f.tn + "°", q.x + q.w / 2, q.y + 34,
                    { role: "caption", align: "center", color: T.text, w: q.w, lines: 1 });
            UI.text(curto(f.wc), q.x + q.w / 2, q.y + 48,
                    { role: "caption", align: "center", color: T.textDim, w: q.w, lines: 1 });
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
    var H = 320, h = 250, y = H - h * shP;
    var ins = A.style.inset();
    if (c.full) System.fillRect(0, 0, 240, H, System.mixColor(T.bg, 0, Math.round(55 * shP)));
    var r = A.style.card(Math.round(ins / 2), y, 240 - ins, h,
                         { full: c.full, r: T.radius, grad: true, pad: 12,
        draw: function (q) {
            System.fillRoundRect(120 - 20, y + 6, 40, 3, 2, T.stroke);
            UI.text("Cidade", q.x, q.y, { role: "title", color: T.text, w: q.w, lines: 1 });
            var rows = [];
            for (var i = 0; i < CIDADES.length; i++) rows.push({ label: CIDADES[i].n });
            rows.push({ label: "Outra (lat,lon)", sub: "digitar coordenadas" });
            var k = UI.list("cidades", q.x, q.y + 18, q.w, q.h - 42, rows, { rowH: 34, selected: sel });
            UI.text("toque fora para fechar", q.x + q.w / 2, q.y + q.h - 10,
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
var BOTAO_Y = 280;
function telaMain(c) {
    FULL = c.full;
    UI.header("Previsão", { sub: d ? A.text.fit(d.city || "") : A.text.fit((cidade() || {}).n || "") });
    var cid = cidade();

    if (!d) {
        A.style.card(LX, 44, LW, 130, { full: c.full, elev: 2, grad: true,
            draw: function (r) {
                UI.text("Sem dados ainda", LX + LW / 2, r.y + 18,
                        { role: "title", align: "center", color: T.textDim, w: r.w });
                UI.text(msg || "Toque em Atualizar", LX + LW / 2, r.y + 56,
                        { role: "caption", align: "center", color: msg ? T.err : T.textDim,
                          w: r.w, lines: 2 });
                glifo(1, 120, 148, T.stroke);
            }
        });
    } else {
        // hero: gradiente accentD->card no frame cheio, temperatura grande
        A.style.card(LX, 44, LW, 132, { full: c.full, elev: 2, grad: false, stroke: false, r: 14,
            draw: function (r) {
                if (c.full) System.fillGradient(LX, 44, LW, 132, T.accentD, T.card, 14);
                UI.text(d.t + "°C", LX + LW / 2, r.y + 2,
                        { role: "display", align: "center", color: d.t >= 30 ? T.warn : T.text });
                UI.text(d.txt, LX + LW / 2, r.y + 40,
                        { role: "title", align: "center", color: T.accent, w: r.w });
                if (d.hum >= 0) UI.text("umidade " + d.hum + "%", LX + LW / 2, r.y + 62,
                        { role: "caption", align: "center", color: T.textDim, w: r.w });
                if (d.days.length) {
                    A.style.divider(r.x, r.y + 78, r.w);
                    var f0 = d.days[0];
                    UI.text("máx " + f0.tx + "° · mín " + f0.tn + "°", LX + LW / 2, r.y + 82,
                            { role: "caption", align: "center", color: T.text, w: r.w });
                }
            }
        });

        // tiles dos 4 dias com glifo do tempo (largura vem do A.L)
        var gap = 6, tw = Math.floor((LW - 3 * gap) / 4);
        for (var i = 0; i < d.days.length && i < 4; i++)
            tile(c, d.days[i], i, LX + i * (tw + gap), tw);

        // sem dias (clima do celular): explica o vazio em vez de deixar buraco
        if (!d.days.length) {
            A.style.card(LX, 184, LW, 72, { full: c.full, elev: 1,
                draw: function (r) {
                    UI.text("sem previsão por dia", r.x + r.w / 2, r.y + 8,
                            { role: "body", align: "center", color: T.text, w: r.w, lines: 1 });
                    UI.text(d.src === "phone" ? "clima do celular (Gadgetbridge)"
                                              : "servidor não mandou os dias",
                            r.x + r.w / 2, r.y + 30, { role: "caption", align: "center",
                            color: T.textDim, w: r.w, lines: 2 });
                }
            });
        }
    }

    // estado do cache/erro (sem dados o card acima ja mostra o motivo)
    var info = d ? (msg || (velho() ? "cache de " + d.date : "de hoje, " + d.hour + "h")) : "";
    UI.text(info, 120, 264, { role: "caption", align: "center",
            color: msg ? T.err : T.textDim, w: LW });

    if (!shOpen) {
        if (A.style.button("Atualizar", LX, BOTAO_Y, 108, 32)) busca();
        if (A.style.button("Cidade", LX + 116, BOTAO_Y, LW - 116, 32,
                           { variant: "ghost" })) {
            shOpen = true;
            shT = 0;
            UI.invalidate();
        }
    }
    if (shP > 0.001 || shOpen) sheetCidade(c);
}

// ---- laco ------------------------------------------------------------------
instalaPlugin();
d = A.data.load(CACHE, null);
if (!d || velho()) busca();          // cache frio: ja atualiza ao abrir
A.run({ main: telaMain }, "main", { fps: 10 });
