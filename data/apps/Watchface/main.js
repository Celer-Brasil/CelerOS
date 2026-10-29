// CelerOS Watchface — relogio de pulso / relogio de mesa (API 51)
// ES5 puro (Duktape). Tela cheia (topbar:false): o canvas virtual 240x320
// escala para o vidro de cada placa (412x502 do watch, 480x480 da 4", ou a
// faixa da CYD).
//
// 5.0.0 — UI 2.0 do CelerKit (deps celeros.app/style/icons/fmt/data):
// hora grande em DUAS pilulas de vidro (HH | MM), dia da semana + data numa
// pilula de acento, passos com barra de meta, bateria com glifo, trilha de
// segundos em pilula e rodape de estado (timer > musica > clima > link).
// Cada peca e uma area pintada do A.custom (assinatura = so repinta o que
// mudou; na CYD cai no mesmo contrato pelo A.full do A.run). O wallpaper
// /sd/wallpaper.png continua desenhado UMA vez por frame total e as pilulas
// ficam por cima. Layout pelo A.L/A.style.content: o vidro redondo do watch
// encolhe largura/rodape e nada encosta na borda. Com a tela apagada/AOD
// (System.screenState/isScreenOn, API 51) o app nao le estado nem pinta —
// economiza o frame ate acordar.
//
// Tres estilos (toque longo troca; guardado no Storage do app):
//   0 digital  — hora em pilulas, dia/data, passos, bateria, segundos;
//   1 analogico — mostrador com ponteiros, arcos de bateria/passos;
//   2 minimo   — so hora e data, quase nada aceso (AMOLED agradece).
//
// Complicacoes (feature-detect, firmware antigo segue funcionando): bateria
// em % e carregando (batteryInfo), passos x meta (System.setting
// "step_goal"), proximo alarme / timer (System.alarms/getTimer), nao lidas
// (unreadNotifications), clima do celular com temperatura (Phone.weather,
// Gadgetbridge), musica tocando (Phone.musicInfo) e estado do link com o
// celular (Phone.status). O rodape alterna: timer > musica > clima > "sem
// celular". O analogico ganhou arcos de bateria e de progresso de passos.
//
// Plugins de watchface (API 16, contrato preservado): apps instalam um
// widget — um arquivo watchface.js na pasta do app OU no appData dele
// (/local/data/<pkg>/watchface.js; a loja instala so main.js/app.json, entao
// o app escreve o plugin no proprio appData na primeira execucao). O
// watchface reescaneia a cada 30 s, avalia cada arquivo dentro de funcao
// (o plugin termina em "return {...}") e da a ele uma linha na banda de
// widgets (estilos digital e analogico; o minimo fica limpo de proposito).
// Plugin com erro de avaliacao/desenho e dispensado ate o proximo scan —
// nunca derruba o relogio. Toque na linha com "open" abre o app do plugin
// (System.launchApp). Com plugin ativo, o clima do celular sai da rodape.
//
// Gestos: arrastar para cima no meio da tela abre o launcher. No relogio as
// bordas sao do sistema (cima: ajustes rapidos; baixo: notificacoes).

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
A.init();

var T = A.style.T;
var SAFE = A.style.content();          // area segura do vidro (top/bottom com inset)
var L = { x: SAFE.x, w: SAFE.w, bottom: SAFE.y + SAFE.h, cx: A.L.cx };
var INFO = {};
try { INFO = System.getInfo() || {}; } catch (e0) { INFO = {}; }
var INS = INFO.inset || 0;
var CUSTOM = !!(A.custom && A.custom.call);   // hub antigo do kit: sem A.custom

// vidro grande (watch/4"): digitos de 75 px (fonte 8); senao a 24 px (4)
var BIGF = (INFO.screenW || 240) >= 400 ? 8 : 4;

var TOPY = 10 + Math.round(INS / 2);   // faixa de status
var BOTY = L.bottom - 2;               // ultima linha segura
var GLASS = T.card;                    // pilula de vidro (token do tema)
var PILL_OPTS = { bg: GLASS, clear: false };
var CLEAR_OPTS = { bg: T.bg, clear: true };

// ---- layout (tudo relativo a A.L; nada de tamanho fixo de tela) -------------
var STW = Math.min(L.w, 190), STX = L.cx - Math.round(STW / 2);
// pilula da hora: duas cabem com os pontos no vidro; a fonte e a maior que
// cabe nos dois digitos (o watch redondo encolhe a largura segura)
var TW2 = System.textWidth("00", BIGF);
var PW = Math.min(96, Math.round((L.w - 12) / 2));
var CLKF = BIGF;
while (CLKF > 2 && System.textWidth("00", CLKF) > PW - 12) CLKF--;
var PH = Math.max(36, Math.round(System.fontHeight(CLKF) * 1.5));   // altura da pilula
var CLKW = PW * 2 + 12, CLKX = L.cx - Math.round(CLKW / 2);
// fonte do estilo minimo: a maior que cabe na largura segura (watch redondo)
var MF = BIGF;
while (MF > 1 && System.textWidth("00:00", MF) > L.w - 12) MF--;
var CTOP = 56, CBOT = BOTY - 112;
var BLOCK = PH + 28;
var CY0 = CTOP + Math.max(0, Math.round((CBOT - CTOP - BLOCK) / 2));
var DW = Math.min(L.w, 150), DX = L.cx - Math.round(DW / 2), DH = 20;
var DY = CY0 + PH + 8;
var SW = Math.min(L.w, 180), SX = L.cx - Math.round(SW / 2);
var SY = BOTY - 112, SH = 40;
var SEW = Math.min(L.w - 40, 150), SEX = L.cx - Math.round(SEW / 2), SEY = BOTY - 72, SEH = 20;
var FW = 160, FX = L.cx - 80, FY = BOTY - 26, FH = 22;
var FACE_Y = TOPY + 24, FACE_BOT = BOTY - 52;   // mostrador analogico (acima dos plugins)
var FACE_H = FACE_BOT - FACE_Y;

var HAS_BATI = typeof System.batteryInfo === "function";
var HAS_ALARMS = typeof System.alarms === "function";
var HAS_TIMER = typeof System.getTimer === "function";
var HAS_UNREAD = typeof System.unreadNotifications === "function";
var HAS_PHONE = typeof Phone !== "undefined" && Phone && typeof Phone.weather === "function";
var HAS_LAUNCH = typeof System.launchApp === "function";
var HAS_SCREEN = typeof System.isScreenOn === "function" && typeof System.screenState === "function";
var hasImu = false;
try { hasImu = (typeof Sensors !== "undefined") && Sensors && Sensors.steps() >= 0; } catch (e1) { hasImu = false; }

var DIA = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
var DIA3 = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];
var WALL = "/sd/wallpaper.png";
var hasWall = false;

// estilo no Storage do app (valores antigos "0"/"1"/"2" continuam validos:
// JSON.parse aceita o numero cru)
var style = 0;
try { style = JSON.parse(Storage.get("style") || "0"); } catch (e2) { style = 0; }
if (!(style >= 0 && style <= 2)) style = 0;

function stepGoal() {
    var g = 0;
    try { g = parseInt(System.setting("step_goal"), 10); } catch (e) { g = 0; }
    return g > 0 ? g : 8000;
}
var goal = stepGoal();

// ---- plugins de watchface (API 16) ------------------------------------------
// Contrato do watchface.js do app (avaliado dentro de funcao):
//   return {
//     id: "celeros.previsao",               // unico; dedup entre as origens
//     sig: function () { return "..."; },   // op.; string barata, muda=redesenha
//     line: function () { return "..."; },  // texto simples (ou draw abaixo)
//     draw: function (x, y, w, h, bg) {},   // desenha a linha; bg=pilula ou null
//     open: "celeros.previsao"              // op.; toque na linha abre o app
//   };

var PLUG_MAX = 2;                 // linhas na banda (258..280, 232..254)
var plugins = [];                 // descritores ativos, na ordem desenhada
var plugVals = [];                // sig() de cada plugin neste frame
var plugDrawers = [];             // painter de cada plugin (criado no scan)
var plugDead = {};                // ids que erraram nesta sessao (ate o proximo scan)
var plugAt = 0;                   // ultimo scan
var plugKey = "";                 // ids carregados; mudou = repaint cheio
var plugDirty = false;            // plugin morto em voo: repaint na proxima volta

function killPlugin(p) {
    if (p.dead) return;
    p.dead = true;
    if (p.id) plugDead[p.id] = 1;
    plugDirty = true;
}

function loadPluginFile(path) {
    try {
        if (!FS.exists(path) || FS.isDirectory(path)) return null;
        var src = FS.readTextFile(path);
        if (!src || src.length > 8192) return null;
        // "return {...}" no topo do arquivo: eval dentro de funcao
        var obj = eval("(function(){\n" + src + "\n})()");
        if (!obj || !obj.id || (typeof obj.draw !== "function" && typeof obj.line !== "function"))
            return null;
        return obj;
    } catch (e) { return null; }
}

function makeDrawer(i) {
    return function (x, y, w, h) { paintPlugin(i, x, y, w, h); };
}

function scanPlugins() {
    plugins = [];
    plugDrawers = [];
    var seen = {};
    var roots = ["/local/apps", "/sd/apps", "/local/data"];
    for (var ri = 0; ri < roots.length && plugins.length < PLUG_MAX; ri++) {
        var dirs = [];
        try { dirs = FS.listDir(roots[ri]); } catch (e) { dirs = []; }
        for (var i = 0; i < dirs.length && plugins.length < PLUG_MAX; i++) {
            var d = loadPluginFile(dirs[i] + "/watchface.js");
            if (d && !seen[d.id] && !plugDead[d.id]) {
                seen[d.id] = 1;
                plugins.push(d);
                plugDrawers.push(makeDrawer(plugins.length - 1));
            }
        }
    }
    var key = "";
    for (var k = 0; k < plugins.length; k++) key += plugins[k].id + "~";
    var changed = key !== plugKey;
    plugKey = key;
    return changed;
}

function pluginRect(i) {
    return { x: L.cx - 84, y: BOTY - 52 - i * 26, w: 168, h: 22 };
}

// pintor de uma linha de plugin: pilula quando ha wallpaper (bg != null, o
// contrato do plugin), texto/desenho do plugin por cima
function paintPlugin(i, x, y, w, h) {
    var p = plugins[i];
    if (!p) return;
    if (hasWall) {
        System.fillRoundRect(x, y, w, h, 8, GLASS);
        System.drawRoundRect(x, y, w, h, 8, T.stroke);
    }
    if (typeof p.draw === "function") {
        try { p.draw(x, y, w, h, hasWall ? GLASS : null); } catch (e) { killPlugin(p); }
        return;
    }
    var s = "";
    try { s = p.line() || ""; } catch (e2) { killPlugin(p); s = ""; }
    if (s) mid(trunc(s, 2, w - 12), x, y, w, h, 2, T.textDim);
}

function tapPlugins(x, y) {
    for (var i = 0; i < plugins.length; i++) {
        var p = plugins[i];
        var r = pluginRect(i);
        if (p.open && HAS_LAUNCH && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
            System.launchApp(p.open);   // sai pelo caminho limpo; launcher abre o alvo
            return true;
        }
    }
    return false;
}

// assinatura dos plugins (cada plugin controla o custo do proprio sig())
function plugSig() {
    plugVals = [];
    for (var i = 0; i < plugins.length; i++) {
        var v = "";
        try {
            if (typeof plugins[i].sig === "function") v = String(plugins[i].sig() || "");
        } catch (e) { killPlugin(plugins[i]); v = "x"; }
        plugVals.push(v);
    }
    return plugVals.join("~");
}

// texto centrado num retangulo (dentro de area pintada: so System.*)
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function mid(s, x, y, w, h, font, color) {
    System.setTextColor(color);
    System.setTextDatum(5);    // MC (coluna centro, linha meio)
    System.drawString(s, x + Math.round(w / 2), y + Math.round(h / 2), font);
    System.setTextDatum(0);
}
function pill(x, y, w, h, r) {
    System.fillRoundRect(x, y, w, h, r, GLASS);
    System.drawRoundRect(x, y, w, h, r, T.stroke);
}
function rightText(s, x, y, w, h, font, color) {
    System.setTextColor(color);
    System.setTextDatum(6);    // MR
    System.drawString(s, x + w, y + Math.round(h / 2), font);
    System.setTextDatum(0);
}

// ---- leitura do estado (uma "assinatura" decide o redesenho) ---------------

function readState() {
    var n = {};
    n.time = System.getTime();
    n.sec = System.getSeconds();
    n.date = System.getDate();
    n.wd = System.getWeekday ? System.getWeekday() : -1;
    n.pct = -1;
    n.chg = false;
    if (HAS_BATI) {
        var b = System.batteryInfo();
        if (b) { n.pct = b.pct; n.chg = b.charging; }
    } else {
        var mv = System.battery ? System.battery() : -1;
        if (mv > 3000) n.pct = Math.max(0, Math.min(100, Math.round((mv - 3300) / 9)));
    }
    n.steps = hasImu ? Sensors.steps() : -1;
    n.unread = HAS_UNREAD ? System.unreadNotifications() : 0;
    n.alarm = "";
    if (HAS_ALARMS) {
        // servico de alarmes pode vir vazio (boot sem Alarms): sem guard o
        // laco do proximo alarme derrubava o relogio com TypeError
        var l = System.alarms();
        if (!l || !l.length) l = [];
        var best = 0;
        for (var i = 0; i < l.length; i++) {
            if (l[i] && l[i].next > 0 && (best === 0 || l[i].next < best)) {
                best = l[i].next;
                n.alarm = pad2(l[i].hour) + ":" + pad2(l[i].minute);
            }
        }
    }
    n.timer = "";
    if (HAS_TIMER) {
        var t = System.getTimer();
        if (t && t.remaining > 0) n.timer = Math.floor(t.remaining / 60) + ":" + pad2(t.remaining % 60);
    }
    n.wx = "";
    n.music = "";
    n.link = "";
    if (HAS_PHONE) {
        try {
            var w = Phone.weather();
            if (w && typeof w.temp === "number") n.wx = Math.round(w.temp) + "°C " + (w.txt || "");
        } catch (e) { n.wx = ""; }
        try {
            if (typeof Phone.musicInfo === "function") {
                var mi = Phone.musicInfo();
                if (mi && mi.state === "play" && mi.track) n.music = mi.track;
            }
            if (typeof Phone.status === "function") {
                var st = Phone.status();
                if (st && st.enabled && !st.connected) n.link = "sem celular";
            }
        } catch (e3) { n.music = ""; n.link = ""; }
    }
    n.plug = plugSig();
    return n;
}

// Hora em numeros (getTime pode vir "07:05" ou "7:05 PM")
function hm(s) {
    var p = s.split(":");
    var h = parseInt(p[0], 10), m = parseInt(p[1], 10);
    if (s.indexOf("PM") >= 0 && h < 12) h += 12;
    if (s.indexOf("AM") >= 0 && h === 12) h = 0;
    return [h, m];
}
function splitHM(s) {
    var sp = s.indexOf(" ");
    var suf = "";
    if (sp > 0) { suf = s.substring(sp + 1); s = s.substring(0, sp); }
    var p = s.split(":");
    var hh = p[0] || "", mm = p[1] || "";
    if (hh.length < 2) hh = "0" + hh;
    if (mm.length < 2) mm = "0" + mm;
    return [hh, mm, suf];
}

// ---- pecas comuns -----------------------------------------------------------

function batteryText(n) {
    if (n.pct < 0) return "";
    return (n.chg ? "+" : "") + n.pct + "%";
}
function batteryColor(n) {
    if (n.chg) return T.ok;
    return n.pct <= 15 ? T.err : T.text;
}

// glifo de bateria: contorno + carga interna + polo
function batteryGlyph(x, cy, pct, chg) {
    var w = 18, h = 9, y = cy - Math.round(h / 2);
    var col = chg ? T.ok : (pct <= 15 ? T.err : T.text);
    System.drawRoundRect(x, y, w, h, 2, col);
    System.fillRect(x + w, y + 3, 2, 3, col);
    var inner = Math.round((w - 4) * (pct < 0 ? 0 : pct) / 100);
    if (inner > 1) System.fillRect(x + 2, y + 2, inner, h - 4, col);
}

// Corta com ".." para caber em maxW (rodape com faixa/musica longas)
function trunc(s, font, maxW) {
    if (System.textWidth(s, font) <= maxW) return s;
    while (s.length > 1 && System.textWidth(s + "..", font) > maxW) s = s.substring(0, s.length - 1);
    return s + "..";
}

// ---- pintores (chamados dentro do A.custom: so System.*) --------------------
var cur = null;    // estado deste frame para os pintores

function paintStatus(x, y, w, h, n) {
    // sem bateria, sem notificacao e sem alarme nao ha o que mostrar: a
    // pilula saia VAZIA no 4848 (placa sem bateria) e virava uma caixa solta
    // no topo do mostrador
    if (!batteryText(n) && !(n.unread > 0) && !n.alarm) return;
    pill(x, y, w, h, 10);
    var px = x + 9, cy = y + Math.round(h / 2);
    var bt = batteryText(n);
    if (bt) {
        if (n.pct >= 0) { batteryGlyph(px, cy, n.pct, n.chg); px += 24; }
        System.setTextColor(batteryColor(n));
        System.setTextDatum(4);   // ML
        System.drawString(bt, px, cy, 1);
        System.setTextDatum(0);
        px += System.textWidth(bt, 1) + 8;
    }
    if (n.unread > 0) {
        mid(n.unread + (n.unread === 1 ? " nova" : " novas"),
            x + Math.round(w / 2) - 44, y, 88, h, 1, T.accent);
    }
    if (n.alarm) {
        var at = "AL " + n.alarm;
        var tw = System.textWidth(at, 1);
        A.icons.draw("alert", x + w - 8 - tw - 14, cy - 6, 12, { color: T.textDim });
        rightText(at, x + 8, y, w - 16, h, 1, T.textDim);
    }
}

// HH e MM em duas pilulas de vidro com os dois pontos entre elas
function paintClock(x, y, w, h, n) {
    var t = splitHM(n.time);
    pill(x, y, PW, h, 12);
    pill(x + PW + 12, y, PW, h, 12);
    mid(t[0], x, y, PW, h, CLKF, T.text);
    mid(t[1], x + PW + 12, y, PW, h, CLKF, T.text);
    var mx = x + PW + 6, my = y + Math.round(h / 2), r = Math.max(2, Math.round(h / 14));
    System.fillCircle(mx, my - r * 3, r, T.textDim);
    System.fillCircle(mx, my + r * 3, r, T.textDim);
}

function paintDate(x, y, w, h, n) {
    pill(x, y, w, h, 9);
    var t = splitHM(n.time);
    var ds = (n.wd >= 0 ? DIA[n.wd] + "  " : "") + n.date.substring(0, 5) +
             (t[2] ? "  " + t[2] : "");
    mid(trunc(ds, 2, w - 12), x, y, w, h, 2, T.accent);
}

function paintSteps(x, y, w, h, n) {
    pill(x, y, w, h, 12);
    var sy = y + 4;
    if (n.steps < 0) {
        mid("sem sensor de passos", x, y, w, h, 1, T.textDim);
        return;
    }
    mid(String(n.steps), x, sy, w, 15, 2, T.text);
    mid("/ " + goal + " passos", x, sy + 16, w, 11, 1, T.textDim);
    var bw = w - 20, by = y + h - 7;
    System.fillRoundRect(x + 10, by, bw, 4, 2, T.raised);
    var fw = Math.round(bw * Math.min(1, n.steps / goal));
    if (fw > 3) System.fillRoundRect(x + 10, by, fw, 4, 2, n.steps >= goal ? T.ok : T.accent);
}

function paintSecs(x, y, w, h, n) {
    pill(x, y, w, h, 9);
    var bw = w - 50, bx = x + 8, by = y + Math.round(h / 2) - 3;
    System.fillRoundRect(bx, by, bw, 6, 3, T.raised);
    var fw = Math.round(bw * n.sec / 60);
    if (fw > 3) System.fillRoundRect(bx, by, fw, 6, 3, T.accent);
    mid(pad2(n.sec), x + w - 42, y, 34, h, 2, T.textDim);
}

function paintFooter(x, y, w, h, n) {
    var s = "", col = T.textDim, icon = "";
    if (n.timer) { s = "Timer " + n.timer; col = T.warn; icon = "alert"; }
    else if (n.music) { s = n.music; col = T.accent; icon = "play"; }
    else if (!plugins.length && n.wx) s = n.wx;
    else if (n.link) { s = n.link; icon = "alert"; }
    if (!s) return;
    pill(x, y, w, h, 9);
    var tx = x;
    if (icon) {
        A.icons.draw(icon, x + 6, y + Math.round((h - 12) / 2), 12, { color: col });
        tx += 20;
    }
    mid(trunc(s, 2, w - (tx - x) - 8), tx, y, w - (tx - x) - 4, h, 2, col);
}

// ---- estilo 1: analogico ----------------------------------------------------
var KX = (INFO.screenW || 240) / 240, KY = (INFO.screenH || 320) / 320;
var KM = Math.min(KX, KY);
var FXS = KM / KX, FYS = KM / KY;   // fatores para o circulo "redondo"
var AN_CX = 120, AN_CY = 160;

function polar(a, r) {
    var rad = a * Math.PI / 180;
    return [AN_CX + Math.sin(rad) * r * FXS, AN_CY - Math.cos(rad) * r * FYS];
}
function hand(a, len, tail, wid, col) {
    var tip = polar(a, len), back = polar(a + 180, tail);
    var l = polar(a - 90, wid), r = polar(a + 90, wid);
    var dl = [l[0] - AN_CX, l[1] - AN_CY], dr = [r[0] - AN_CX, r[1] - AN_CY];
    System.fillTriangle(Math.round(back[0] + dl[0]), Math.round(back[1] + dl[1]),
        Math.round(back[0] + dr[0]), Math.round(back[1] + dr[1]),
        Math.round(tip[0]), Math.round(tip[1]), col);
}
// Arco de pontos (0..1 a partir das 12h): bateria e passos ao redor do mostrador
function ringArc(frac, r, col) {
    var total = 72, dots = Math.round(total * frac);
    for (var i = 0; i <= dots; i++) {
        var p = polar(-90 + (i / total) * 360, r);
        System.fillCircle(Math.round(p[0]), Math.round(p[1]), 2, col);
    }
}
function paintAnalog(x, y, w, h, n) {
    System.fillRect(x, y, w, h, T.bg);
    var cx = x + Math.round(w / 2), cy = y + Math.round(h / 2);
    var R = Math.min(92, Math.floor(h / 2) - 18, Math.floor(w / 2) - 18);
    if (R < 30) R = 30;
    AN_CX = cx; AN_CY = cy;
    if (!plugins.length) {   // com plugin a banda fica limpa de arcos
        if (n.steps >= 0) ringArc(Math.min(1, n.steps / goal), R + 9, T.accent);
        if (n.pct >= 0) ringArc(n.pct / 100, R + 15, batteryColor(n));
    }
    System.fillCircle(cx, cy, R + 6, T.card);
    System.drawCircle(cx, cy, R + 6, T.stroke);
    for (var i = 0; i < 12; i++) {
        var o = polar(i * 30, R), p = polar(i * 30, i % 3 === 0 ? R - 14 : R - 7);
        System.drawLine(Math.round(o[0]), Math.round(o[1]), Math.round(p[0]), Math.round(p[1]),
            i % 3 === 0 ? T.text : T.textDim);
    }
    var d = (n.wd >= 0 ? DIA3[n.wd] + " " : "") + n.date.substring(0, 2);
    mid(d, cx - 40, cy + Math.round(R * 0.42), 80, 12, 1, T.accent);
    if (n.steps >= 0) mid(String(n.steps) + " passos", cx - 50, cy + Math.round(R * 0.60),
                          100, 12, 1, T.textDim);
    if (n.unread > 0) mid(n.unread + (n.unread === 1 ? " nova" : " novas"),
                          cx - 50, cy + Math.round(R * 0.76), 100, 12, 1, T.accent);
    var xm = hm(n.time);
    hand((xm[0] % 12) * 30 + xm[1] * 0.5, R * 0.55, 10, 5, T.text);
    hand(xm[1] * 6 + n.sec * 0.1, R * 0.82, 12, 3, T.text);
    hand(n.sec * 6, R * 0.88, 16, 1, T.accent);
    System.fillCircle(cx, cy, 5, T.accent);
}

// ---- estilo 2: minimo -------------------------------------------------------
function paintMinimal(x, y, w, h, n) {
    System.fillRect(x, y, w, h, T.bg);
    var t = splitHM(n.time);
    var fh = System.fontHeight(MF);
    mid(t[0] + ":" + t[1], 0, 104, 240, fh + 8, MF, T.textDim);
    var ds = (n.wd >= 0 ? DIA3[n.wd] + "  " : "") + n.date.substring(0, 5);
    mid(ds, 0, 156, 240, 16, 2, T.stroke);
    if (t[2]) mid(t[2], 0, 176, 240, 12, 1, T.stroke);
    if (n.unread > 0) mid(n.unread + (n.unread === 1 ? " nova" : " novas"),
                          0, 192, 240, 12, 1, T.accent);
    var bt = batteryText(n);
    if (bt && (n.pct <= 20 || n.chg)) mid(bt, 0, BOTY - 21, 240, 12, 1, batteryColor(n));
}

// ---- pintores de peca (sem alocacao por frame) ------------------------------
function drawStatusP(x, y, w, h) { paintStatus(x, y, w, h, cur); }
function drawClockP(x, y, w, h) { paintClock(x, y, w, h, cur); }
function drawDateP(x, y, w, h) { paintDate(x, y, w, h, cur); }
function drawStepsP(x, y, w, h) { paintSteps(x, y, w, h, cur); }
function drawSecsP(x, y, w, h) { paintSecs(x, y, w, h, cur); }
function drawFooterP(x, y, w, h) { paintFooter(x, y, w, h, cur); }
function drawAnalogP(x, y, w, h) { paintAnalog(x, y, w, h, cur); }
function drawMinimalP(x, y, w, h) { paintMinimal(x, y, w, h, cur); }

// ---- assinaturas ------------------------------------------------------------
function statusSig(n) {
    return [n.pct, n.chg ? 1 : 0, n.unread, n.alarm].join("|");
}
function clockSig(n) { return n.time; }
function dateSig(n) { return n.wd + "|" + n.date + "|" + n.time; }
function stepsSig(n) { return n.steps + "|" + goal; }
function footerSig(n) { return [n.timer, n.music, n.wx, n.link, plugins.length].join("|"); }
function faceSig(n) {
    return [n.time, n.sec, n.date, n.wd, n.pct, n.chg ? 1 : 0, n.steps, n.unread,
            goal, plugins.length].join("|");
}
function minSig(n) { return [n.time, n.date, n.wd, n.unread, n.pct, n.chg ? 1 : 0].join("|"); }
function sigOf(n) {
    return [n.time, style === 2 ? "" : n.sec, n.date, n.pct, n.chg, n.steps, n.unread,
            n.alarm, n.timer, style === 2 ? "" : n.wx, n.music, n.link, n.plug].join("|");
}

// ---- desenho digital --------------------------------------------------------
function redrawWall() {
    hasWall = false;
    if (style === 0) {
        try { hasWall = FS.exists(WALL) && System.drawPNG(WALL, 0, 0); } catch (e) { hasWall = false; }
    }
    if (!hasWall) System.fillRect(0, 0, 240, 320, T.bg);
}

function digitalPieces(n) {
    if (CUSTOM) {
        A.custom("status", STX, TOPY, STW, 22, statusSig(n), drawStatusP, PILL_OPTS);
        A.custom("clock", CLKX, CY0, CLKW, PH, clockSig(n), drawClockP, PILL_OPTS);
        A.custom("date", DX, DY, DW, DH, dateSig(n), drawDateP, PILL_OPTS);
        A.custom("steps", SX, SY, SW, SH, stepsSig(n), drawStepsP, PILL_OPTS);
        if (plugins.length < 2)
            A.custom("secs", SEX, SEY, SEW, SEH, String(n.sec), drawSecsP, PILL_OPTS);
        drawPluginPieces();
        A.custom("footer", FX, FY, FW, FH, footerSig(n), drawFooterP, PILL_OPTS);
    } else {
        paintStatus(STX, TOPY, STW, 22, n);
        paintClock(CLKX, CY0, CLKW, PH, n);
        paintDate(DX, DY, DW, DH, n);
        paintSteps(SX, SY, SW, SH, n);
        if (plugins.length < 2) paintSecs(SEX, SEY, SEW, SEH, n);
        digitalPluginPaint();
        paintFooter(FX, FY, FW, FH, n);
    }
}

function drawPluginPieces() {
    for (var i = 0; i < plugins.length; i++) {
        var r = pluginRect(i);
        var sig = (plugins[i].id || "") + "|" + (plugVals[i] || "");
        A.custom("pl" + i, r.x, r.y, r.w, r.h, sig, plugDrawers[i],
                 hasWall ? PILL_OPTS : CLEAR_OPTS);
    }
}
function digitalPluginPaint() {
    for (var i = 0; i < plugins.length; i++) {
        var r = pluginRect(i);
        paintPlugin(i, r.x, r.y, r.w, r.h);
    }
}

function digitalAll(n, c) {
    if (CUSTOM) {
        if (c.full) redrawWall();
        digitalPieces(n);
        return;
    }
    if (c.full) {
        redrawWall();
        digitalPieces(n);
        lastSig = sigOf(n);
    } else {
        var s = sigOf(n);
        if (s !== lastSig) { lastSig = s; digitalPieces(n); }
    }
}

function analogAll(n, c) {
    if (CUSTOM) {
        A.custom("analog", L.x, FACE_Y, L.w, FACE_H, faceSig(n), drawAnalogP,
                 { bg: T.bg, clear: true });
        A.custom("status", STX, TOPY, STW, 22, statusSig(n), drawStatusP, PILL_OPTS);
        drawPluginPieces();
        A.custom("footer", FX, FY, FW, FH, footerSig(n), drawFooterP, PILL_OPTS);
        return;
    }
    if (c.full) { System.fillRect(0, 0, 240, 320, T.bg); lastSig = sigOf(n); }
    else {
        var s = sigOf(n);
        if (s === lastSig) return;
        lastSig = s;
    }
    paintAnalog(L.x, FACE_Y, L.w, FACE_H, n);
    paintStatus(STX, TOPY, STW, 22, n);
    digitalPluginPaint();
    paintFooter(FX, FY, FW, FH, n);
}

function minimalAll(n, c) {
    if (CUSTOM) {
        A.custom("min", 0, 0, 240, 320, minSig(n), drawMinimalP, { bg: T.bg, clear: true });
        return;
    }
    if (c.full) { lastSig = sigOf(n); paintMinimal(0, 0, 240, 320, n); return; }
    var s = sigOf(n);
    if (s === lastSig) return;
    lastSig = s;
    paintMinimal(0, 0, 240, 320, n);
}

function drawAll(n, c) {
    if (style === 1) analogAll(n, c);
    else if (style === 2) minimalAll(n, c);
    else digitalAll(n, c);
}

// ---- laco (A.run do kit: dono do frame; a tela so desenha) ------------------

scanPlugins();
var lastSig = "";
var goalAt = System.millis();
var touchOn = false, downAt = 0, longDone = false;
var wasOff = false;

// troca de estilo: so estado + invalidar — o desenho acontece no proximo
// frame (o UI.begin do A.run e quem limpa a tela no frame total)
function setStyle(s) {
    style = s;
    try { Storage.set("style", JSON.stringify(s)); } catch (e3) { /* sem NVS: so a sessao */ }
    hasWall = false;
    UI.invalidate();
}

// repaint cheio (papel de parede incluido): plugins entraram/sairam ou
// algum morreu em voo
function plugRepaint() {
    for (var di = plugins.length - 1; di >= 0; di--)
        if (plugins[di].dead) plugins.splice(di, 1);
    plugKey = "";
    plugDrawers = [];
    for (var dk = 0; dk < plugins.length; dk++) {
        plugKey += plugins[dk].id + "~";
        plugDrawers.push(makeDrawer(dk));
    }
    UI.invalidate();
}

A.run({
    relogio: function (c) {
        if (HAS_SCREEN) {
            var scr = System.screenState();
            if (scr === "off" || scr === "aod") { wasOff = true; return; }
        }
        if (wasOff) { wasOff = false; UI.invalidate(); }

        if (plugDirty) {
            plugDirty = false;
            plugRepaint();
        }
        if (System.millis() - plugAt > 30000) {  // apps instalam/desinstalam: reescaneia
            plugAt = System.millis();
            if (scanPlugins()) plugRepaint();
        }

        var n = readState();
        cur = n;
        if (System.millis() - goalAt > 30000) {  // meta mudada no Settings
            goalAt = System.millis();
            goal = stepGoal();
        }

        drawAll(n, c);

        // gestos: o toque do frame foi consumido pelo UI.begin do A.run
        var t = UI.touch();
        var now = System.millis();
        if (t.down) {
            if (!touchOn) { touchOn = true; downAt = now; longDone = false; }
            // toque longo parado: proximo estilo
            if (!t.moved && !longDone && now - downAt > 700) {
                longDone = true;
                setStyle((style + 1) % 3);
                if (System.beep) System.beep(1600, 30);
            }
        } else if (touchOn) {
            if (!longDone && t.sy - t.y > 25) System.exitApp();
            else if (!longDone && t.tap) tapPlugins(t.x, t.y);
            touchOn = false;
        }
    }
}, "relogio", { fps: 7 });   // era System.delay(150): ~6.7 fps; 7 = 143 ms
