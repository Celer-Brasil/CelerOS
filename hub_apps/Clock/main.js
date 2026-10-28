// CelerOS Clock — relogio de mesa completo no CelerKit UI 2.0: hora com
// segundos e fuso, relogio mundial, cronometro, timer (espelhado no timer do
// sistema, toca com o app fechado) e alarme do sistema (System.alarms) com
// sheet de ajuste. As abas sao um segmented proprio com glifos vetoriais e
// rotulos em fonte caption MEDIDOS: o UI.tabs nativo cortava "Alarme" para
// "Al.." em 5 abas de 44px. ES5 (Duktape).

var A = require("celeros.app");
require("celeros.app.fmt");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.widgets");
require("celeros.app.list");
A.init();

var T = A.style.T;

// layout na area segura (watch redondo encolhe a largura/rodape)
var LX = A.L.x, LW = A.L.w, BOT = A.L.bottom, CX = A.L.cx;
var TAB_CW = Math.floor(LW / 5);
var B2 = Math.floor((LW - 8) / 2);
var BY2 = BOT - 54;
var WEEK = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

if (typeof System.keepAwake === "function") {
    try { System.keepAwake(1800000); } catch (e0) {}   // relogio de mesa: tela ligada
}
var hasTone = typeof System.playTone === "function";
function tone(notes) {
    if (hasTone) { try { System.playTone(notes); } catch (e1) {} }
}

// ---- abas -------------------------------------------------------------------
// Hora, Mundo, Crono, Timer, Alarme — 5 celulas de 44px; o rotulo usa fonte
// caption (6px/char) e a largura e conferida por UI.text (w) — nada corta.
var TABS = ["Hora", "Mundo", "Crono", "Timer", "Alarme"];
var tab = 0;
// true enquanto a base e redesenhada sob a animacao de saida do sheet:
// desenha tudo, mas nao aceita toque (o sheet ja esta fechando)
var baseDead = false;

function glyph(k, x, y, s, c) {
    var S = System, cx = x + s / 2, cy = y + s / 2, r = s * .42;
    if (k === 0) {                       // relogio
        S.drawCircle(cx, cy, Math.round(r), c);
        S.drawLine(cx, cy, cx, cy - Math.round(r * .62), c);
        S.drawLine(cx, cy, cx + Math.round(r * .48), cy + Math.round(r * .28), c);
    } else if (k === 1) {                // globo
        S.drawCircle(cx, cy, Math.round(r), c);
        S.drawLine(cx - Math.round(r), cy, cx + Math.round(r), cy, c);
        S.drawCircle(cx, cy, Math.round(r * .5), c);
        S.drawLine(cx, cy - Math.round(r), cx, cy + Math.round(r), c);
    } else if (k === 2) {                // cronometro
        S.drawCircle(cx, cy + 1, Math.round(r * .86), c);
        S.drawLine(cx, cy - Math.round(r), cx, cy - Math.round(r * .55), c);
        S.drawLine(cx - Math.round(r * .34), cy - Math.round(r * 1.06),
                   cx + Math.round(r * .34), cy - Math.round(r * 1.06), c);
    } else if (k === 3) {                // ampulheta
        S.drawLine(cx - Math.round(r * .6), cy - Math.round(r),
                   cx + Math.round(r * .6), cy - Math.round(r), c);
        S.drawLine(cx - Math.round(r * .6), cy + Math.round(r),
                   cx + Math.round(r * .6), cy + Math.round(r), c);
        S.fillTriangle(cx - Math.round(r * .55), cy - Math.round(r * .85),
                       cx + Math.round(r * .55), cy - Math.round(r * .85), cx, cy, c);
        S.fillTriangle(cx - Math.round(r * .55), cy + Math.round(r * .85),
                       cx + Math.round(r * .55), cy + Math.round(r * .85), cx, cy, c);
    } else {                             // sino
        S.fillArc(cx, cy + Math.round(r * .2), Math.round(r * .45),
                  Math.round(r * .92), 200, 340, c);
        S.fillRect(cx - Math.round(r * .8), cy + Math.round(r * .18),
                   Math.round(r * 1.6), Math.round(r * .3), c);
        S.fillCircle(cx, cy + Math.round(r * .62), Math.max(1, Math.round(r * .2)), c);
    }
}

function tabBar(c) {
    A.style.card(LX, 44, LW, 50, { full: c.full, pad: 0, r: 12, draw: function () {
        for (var i = 0; i < 5; i++) {
            var x = LX + i * TAB_CW, on = i === tab;
            if (c.full) {
                if (on) System.fillRoundRect(x + 3, 47, TAB_CW - 6, 44, 10, T.accent);
                glyph(i, x + Math.round((TAB_CW - 16) / 2), 49, 16,
                      on ? T.onAccent : T.textDim);
            }
            UI.text(TABS[i], x + TAB_CW / 2, 72, {
                role: "caption", align: "center", id: "tab" + i, lines: 1, w: TAB_CW - 2,
                color: on ? T.onAccent : T.textDim,
                bg: on ? T.accent : T.card
            });
        }
    }});
    var t = UI.touch();
    if (!baseDead && t.tap && t.y >= 44 && t.y <= 94 &&
        t.x >= LX && t.x < LX + 5 * TAB_CW) {
        var n = Math.floor((t.x - LX) / TAB_CW);
        if (n >= 0 && n < 5 && n !== tab) {
            tab = n;
            UI.invalidate();
        }
    }
}

// ---- hora local -------------------------------------------------------------
var now = { h: 0, m: 0, s: 0, date: "", wd: "", tz: "UTC" };

function parseLocalTime() {
    var tStr = System.getTime();          // "14:30" ou "02:30 PM"
    var isPM = tStr.indexOf("PM") !== -1;
    var isAM = tStr.indexOf("AM") !== -1;
    var parts = tStr.split(":");
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1].split(" ")[0], 10);
    if (isPM && h !== 12) h += 12;
    if (isAM && h === 12) h = 0;
    return { h: h, m: m };
}
function parseTZOffset() {
    var tz = System.getTimezone() || "UTC";
    tz = tz.replace("UTC", "");
    if (tz === "" || tz === "0") return 0;
    var sign = 1;
    if (tz.charAt(0) === "-") sign = -1;
    if (tz.charAt(0) === "+" || tz.charAt(0) === "-") tz = tz.substring(1);
    var parts = tz.split(":");
    var h = parseInt(parts[0], 10) || 0;
    var m = parts.length > 1 ? parseInt(parts[1], 10) || 0 : 0;
    return sign * (h + m / 60.0);
}
function hhmm(h, m) { return A.fmt.pad2(h) + ":" + A.fmt.pad2(m); }
function mmss(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return A.fmt.pad2(Math.floor(s / 60)) + ":" + A.fmt.pad2(s % 60);
}

function clockTick(force) {
    if (!force && !A.every(250, "clk")) return;
    var t = parseLocalTime();
    now.h = t.h; now.m = t.m; now.s = System.getSeconds();
    now.date = System.getDate();
    now.wd = typeof System.getWeekday === "function" ? WEEK[System.getWeekday()] : "";
    now.tz = System.getTimezone() || "UTC";
}

// ---- relogio mundial ---------------------------------------------------------
// fusos fixos (horario padrao — sem DST); a linha "Aqui" usa o fuso do aparelho
var CITIES = [
    { n: "Nova York", off: -5 }, { n: "Londres", off: 0 }, { n: "Paris", off: 1 },
    { n: "Moscou", off: 3 }, { n: "Tóquio", off: 9 }, { n: "Sydney", off: 10 }
];
function cityTime(off) {
    var dec = now.h + now.m / 60.0 - parseTZOffset() + off;
    while (dec < 0) dec += 24;
    while (dec >= 24) dec -= 24;
    var h = Math.floor(dec), m = Math.round((dec - h) * 60);
    if (m === 60) { m = 0; h = (h + 1) % 24; }
    return hhmm(h, m);
}
var worldRows = A.list.make(
    function () { return now.h * 60 + now.m; },
    function () {
        var rows = [{ label: "Aqui", sub: now.tz, right: hhmm(now.h, now.m),
                      rightColor: T.accent }];
        for (var i = 0; i < CITIES.length; i++) {
            rows.push({
                label: CITIES[i].n,
                sub: "UTC" + (CITIES[i].off >= 0 ? "+" : "") + CITIES[i].off,
                right: cityTime(CITIES[i].off), rightColor: T.text
            });
        }
        return rows;
    });

// ---- abas de conteudo -------------------------------------------------------
var ringKey = -999;

function tabHora(c) {
    A.style.card(LX, 100, LW, BOT - 120, { full: c.full, r: 14, pad: 0, draw: function () {
        var cx = CX, cy = 192, r = 80;
        var key = now.s;
        if (c.full || key !== ringKey) {
            ringKey = key;
            A.widgets.ring(cx, cy, r, now.s / 60, { th: 8 });
        }
        UI.text(hhmm(now.h, now.m), cx, 168,
                { role: "display", align: "center", id: "hora" });
        UI.text(A.fmt.pad2(now.s), cx, 190,
                { role: "title", align: "center", color: T.accent, id: "seg" });
        UI.text((now.wd ? now.wd + ", " : "") + now.date, cx, 218,
                { role: "caption", align: "center", color: T.textDim,
                  w: LW - 52, lines: 1, id: "data" });
    }});
    UI.text("fuso " + now.tz, CX, BOT - 14,
            { role: "caption", align: "center", color: T.textDim, w: LW, id: "tz" });
}

function tabMundo(c) {
    var rows = worldRows.rows();
    var i = A.list.view("clk-world", LX, 100, LW, BOT - 104, rows, { row: 44, r: 14 });
    if (!baseDead && i >= 0 && rows[i]) {   // toque na linha: confirma a hora
        A.toast(rows[i].label + "  " + rows[i].right, 1200);
    }
}

// ---- cronometro --------------------------------------------------------------
var swRun = false, swStart = 0, swAcc = 0;
var swKey = -999;
function swElapsed() { return swAcc + (swRun ? System.millis() - swStart : 0); }

function tabCrono(c) {
    A.style.card(LX, 100, LW, BY2 - 116, { full: c.full, r: 14, pad: 0, draw: function () {
        var ms = swElapsed(), key = Math.floor(ms / 50) + (swRun ? 100000 : 0);
        if (c.full || key !== swKey) {
            swKey = key;
            A.widgets.ring(CX, 168, 60, (ms % 60000) / 60000,
                           { th: 6, color: swRun ? T.ok : T.raised });
        }
        UI.text(mmss(ms), CX, 146,
                { role: "display", align: "center", id: "sw" });
        UI.text("." + A.fmt.pad2(Math.floor(ms / 10) % 100), CX, 168,
                { role: "title", align: "center", color: T.accent, id: "swcs" });
        UI.text(swRun ? "correndo" : "parado", CX, 188,
                { role: "caption", align: "center", color: T.textDim, id: "swst" });
    }});
    var b1 = A.style.button(swRun ? "Pausar" : "Iniciar", LX, BY2, B2, 44,
                            { color: swRun ? T.warn : T.ok, textColor: T.onAccent });
    if (!baseDead && b1) {
        if (swRun) { swAcc = swElapsed(); swRun = false; }
        else { swStart = System.millis(); swRun = true; }
        UI.invalidate();
    }
    var b2 = A.style.button("Zerar", LX + B2 + 8, BY2, B2, 44, { variant: "ghost" });
    if (!baseDead && b2) {
        swRun = false;
        swAcc = 0;
        UI.invalidate();
    }
}

// ---- timer (espelha o timer do sistema) --------------------------------------
var tTotal = 5 * 60 * 1000, tAcc = 0, tStart = 0, tRun = false;
var tKey = -999, tDone = false;
function tRemain() { return Math.max(0, tTotal - tAcc - (tRun ? System.millis() - tStart : 0)); }

(function adoptaTimer() {
    if (typeof System.getTimer !== "function") return;
    try {
        var st = System.getTimer();
        if (st && st.remaining > 0) {       // timer do sistema vivo: retoma no app
            tTotal = st.remaining * 1000;
            tAcc = 0;
            tStart = System.millis();
            tRun = true;
        }
    } catch (e) {}
})();

function timerStop(sec, label) {
    if (typeof System.setTimer === "function") {
        try { System.setTimer(sec, label); } catch (e) {}
    }
}
function timerCancel() {
    if (typeof System.cancelTimer === "function") {
        try { System.cancelTimer(); } catch (e) {}
    }
}
function timerPause() {
    tAcc = tTotal - tRemain();
    tRun = false;
    timerCancel();
    UI.invalidate();
}
function timerStart() {
    var rem = tRemain();
    if (rem <= 0) { tTotal = 5 * 60 * 1000; tAcc = 0; rem = tTotal; }
    tStart = System.millis();
    tRun = true;
    tDone = false;
    timerStop(Math.max(1, Math.ceil(rem / 1000)), "Timer");
    UI.invalidate();
}
function timerSet(ms) {
    tRun = false;
    tTotal = ms;
    tAcc = 0;
    tDone = false;
    timerCancel();
    UI.invalidate();
}

function tabTimer(c) {
    var ms = tRemain();
    if (tRun && ms <= 0) {                 // acabou: o timer do sistema toca junto
        tRun = false;
        tAcc = tTotal;
        tDone = true;
        tone([[880, 150], [660, 150], [880, 200]]);
        UI.invalidate();
    }
    var presets = [60000, 300000, 600000], plabel = ["1 min", "5 min", "10 min"];
    var pw = Math.floor((LW - 26) / 3);
    for (var i = 0; i < 3; i++) {
        var pb = A.style.button(plabel[i], LX + i * (pw + 8), 98, pw, 28, { variant: "ghost" });
        if (!baseDead && pb) timerSet(presets[i]);
    }
    A.style.card(LX, 132, LW, BY2 - 140, { full: c.full, r: 14, pad: 0, draw: function () {
        var key = Math.floor(ms / 50) + (tRun ? 100000 : 0) + (tDone ? 50000 : 0);
        if (c.full || key !== tKey) {
            tKey = key;
            A.widgets.ring(CX, 192, 48, tTotal > 0 ? ms / tTotal : 0,
                           { th: 6, color: tDone ? T.warn : T.accent });
        }
        UI.text(mmss(ms), CX, 184,
                { role: "display", align: "center", id: "timer" });
        UI.text(tDone ? "tempo!" : (tRun ? "correndo" : "parado"), CX, 206,
                { role: "caption", align: "center",
                  color: tDone ? T.warn : T.textDim, id: "tst" });
    }});
    var tb1 = A.style.button(tRun ? "Pausar" : "Iniciar", LX, BY2, B2, 44,
                             { color: tRun ? T.warn : T.ok, textColor: T.onAccent });
    if (!baseDead && tb1) {
        if (tRun) timerPause();
        else timerStart();
    }
    var tb2 = A.style.button("Zerar", LX + B2 + 8, BY2, B2, 44, { variant: "ghost" });
    if (!baseDead && tb2) timerSet(5 * 60 * 1000);
    UI.text("Toca mesmo com o app fechado.", CX, BOT - 8,
            { role: "caption", align: "center", color: T.textDim, w: LW - 4, lines: 1, id: "thint" });
}

// ---- alarme do sistema ------------------------------------------------------
var al = null, alAt = 0;
var alOpen = false, alUntil = 0;
var edH = 7, edM = 0;

function alarmRefresh(force) {
    var ms = System.millis();
    if (!force && alAt && ms - alAt < 1000) return;
    alAt = ms;
    var arr = [];
    try { arr = System.alarms() || []; } catch (e) { arr = []; }
    al = null;
    for (var i = 0; i < arr.length; i++) if (arr[i]) { al = arr[i]; break; }
}
function alarmSave(h, m, on) {
    if (al) {
        try {
            System.updateAlarm(al.id, { hour: h, minute: m, days: al.days || 0,
                                       enabled: on, label: al.label || "Alarme" });
        } catch (e) {}
    } else if (on) {
        try { System.addAlarm({ hour: h, minute: m, days: 0, enabled: true, label: "Alarme" }); } catch (e) {}
    }
    alarmRefresh(true);
    UI.invalidate();
}
function alarmOpenEdit() {
    edH = al ? al.hour : 7;
    edM = al ? al.minute : 0;
    alOpen = true;
    UI.invalidate();
}
function alarmClose() { alOpen = false; alUntil = System.millis() + 260; UI.invalidate(); }

function alarmSheet(c) {
    return A.widgets.sheet("clk-alarme", { open: alOpen, full: c.full && alOpen, h: 236, title: "Alarme" },
        function (r) {
            // os controles so agem com o sheet aberto: na animacao de saida
            // o cartao desliza e um toque nao pode reabrir/salvar nada
            // hora
            var hm = A.style.button("-", r.x, r.y, 44, 44, { variant: "secondary", role: "title" });
            if (alOpen && hm) edH = (edH + 23) % 24;
            UI.text(hhmm(edH, edM), r.x + r.w / 2, r.y + 12,
                    { role: "display", align: "center", id: "edhm" });
            var hp = A.style.button("+", r.x + r.w - 44, r.y, 44, 44, { variant: "secondary", role: "title" });
            if (alOpen && hp) edH = (edH + 1) % 24;
            UI.text("Hora", r.x + r.w / 2, r.y + 30,
                    { role: "caption", align: "center", color: T.textDim, id: "edhl" });
            // minuto
            var y2 = r.y + 50;
            var mm = A.style.button("-5", r.x, y2, 56, 40, { variant: "secondary", role: "body" });
            if (alOpen && mm) edM = (edM + 55) % 60;
            var mp = A.style.button("+5", r.x + r.w - 56, y2, 56, 40, { variant: "secondary", role: "body" });
            if (alOpen && mp) edM = (edM + 5) % 60;
            UI.text("minuto: " + A.fmt.pad2(edM), r.x + r.w / 2, y2 + 14,
                    { role: "body", align: "center", id: "edm" });
            // atalhos
            var pre = [["06:00", 6, 0], ["07:00", 7, 0], ["08:00", 8, 0], ["12:00", 12, 0]];
            for (var i = 0; i < 4; i++) {
                var pb = A.style.button(pre[i][0], r.x + i * 52, r.y + 100, 48, 28, { variant: "ghost" });
                if (alOpen && pb) {
                    edH = pre[i][1];
                    edM = pre[i][2];
                    UI.invalidate();
                }
            }
            // salvar / desligar
            var sv = A.style.button("Salvar", r.x, r.y + 138, 104, 38);
            if (alOpen && sv) {
                alarmSave(edH, edM, true);
                alarmClose();
            }
            var off = A.style.button("Desligar", r.x + 112, r.y + 138, 92, 38, { variant: "ghost" });
            if (alOpen && off) {
                alarmSave(edH, edM, false);
                alarmClose();
            }
        });
}

function tabAlarme(c) {
    alarmRefresh(false);
    var on = !!(al && al.enabled);
    A.style.card(LX, 100, LW, 124, { full: c.full, r: 14, draw: function (r) {
        UI.text(al ? hhmm(al.hour, al.minute) : "--:--", r.x, r.y,
                { role: "display", color: on ? T.accent : T.textDim, id: "alh" });
        UI.text(al ? (al.label || "Alarme") : "nenhum alarme", r.x, r.y + 26,
                { role: "caption", color: T.textDim, id: "all" });
        var st = UI.toggle(r.x + r.w - 44, r.y + 2, on, { id: "altg" });
        if (!baseDead && st !== on) alarmSave(al ? al.hour : edH, al ? al.minute : edM, st);
        UI.text(al ? (al.days ? "repetido" : "uma vez") : "toque em criar",
                r.x, r.y + 44, { role: "caption", color: T.textDim, id: "alrep" });
        UI.text(on ? "ligado" : "desligado", r.x, r.y + 86,
                { role: "body", color: on ? T.ok : T.textDim, id: "als" });
    }});
    var ab = A.style.button(al ? "Ajustar" : "Criar alarme", LX, 236, LW, 44);
    if (!baseDead && ab) alarmOpenEdit();
    UI.text("O alarme do sistema toca mesmo com o app fechado.", CX, BOT - 20,
            { role: "caption", align: "center", color: T.textDim, w: LW, lines: 2, id: "alhint" });
}

// ---- tela -------------------------------------------------------------------
function tela(c) {
    var h = A.widgets.header("Relógio", { full: c.full, sub: now.tz });
    if (!baseDead && h.back) return A.BACK;
    tabBar(c);
    if (tab === 0) tabHora(c);
    else if (tab === 1) tabMundo(c);
    else if (tab === 2) tabCrono(c);
    else if (tab === 3) tabTimer(c);
    else tabAlarme(c);
}

var sheetWas = false;

A.run({
    main: function (c) {
        clockTick(false);
        var closing = !alOpen && System.millis() < alUntil;
        var inSheet = alOpen || closing;
        if (sheetWas && !inSheet) UI.invalidate();   // volta do sheet: repinta a base
        sheetWas = inSheet;
        if (inSheet) {
            // na saida o cartao desliza sobre a base redesenhada (sem toque)
            if (closing) {
                baseDead = true;
                tela(c);
                baseDead = false;
            }
            var r = alarmSheet(c);
            if (r === "close") alarmClose();
            return;
        }
        return tela(c);
    }
}, "main", { fps: 20 });
