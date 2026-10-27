// CelerOS Clock — relogio de mesa: hora, relogio mundial, alarme, cronometro
// e timer. Migrado para o CelerKit: o core celeros.app fica com o laco
// (A.run) e o tema; celeros.app.fmt empresta o pad2 do sistema; o UI kit 2.0
// (style/widgets) da o anel, o card do alarme e os botoes tokenizados.
// O acesso numerico a hora (o relogio mundial faz aritmetica de fuso) nao
// existe no fmt, entao o parse local de getTime/getTimezone permanece.
// ES5 (Duktape).
var A = require("celeros.app");
require("celeros.app.fmt");
require("celeros.app.style");
require("celeros.app.widgets");
A.init();

var TAB_CLOCK = 0;
var TAB_WORLD = 1;
var TAB_ALARM = 2;
var TAB_STOPWATCH = 3;
var TAB_TIMER = 4;
var TABS = ["Hora", "Mundo", "Alarme", "Cron.", "Timer"];
var currentTab = TAB_CLOCK;

var WEEK = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

if (typeof System.keepAwake === "function") {
    try { System.keepAwake(1800000); } catch (e0) {}   // relogio de mesa: tela ligada
}
var hasTone = (typeof System.playTone === "function");
function tone(notes) {
    if (hasTone) { try { System.playTone(notes); } catch (e1) {} }
}

// --- World Clock Data ---
var cities = [
    { name: "Nova York", offset: -5 },
    { name: "Londres", offset: 0 },
    { name: "Tóquio", offset: 9 },
    { name: "Dubai", offset: 4 }
];

function parseLocalTime() {
    var tStr = System.getTime(); // "14:30" or "02:30 PM"
    var isPM = tStr.indexOf("PM") !== -1;
    var isAM = tStr.indexOf("AM") !== -1;
    var parts = tStr.split(":");
    var h = parseInt(parts[0], 10);
    var mStr = parts[1].split(" ")[0]; // handle "30 PM"
    var m = parseInt(mStr, 10);

    if (isPM && h !== 12) h += 12;
    if (isAM && h === 12) h = 0;
    return { h: h, m: m };
}

function parseTZOffset() {
    var tz = System.getTimezone(); // e.g. "UTC-5" or "UTC+5:30"
    tz = tz.replace("UTC", "");
    if (tz === "" || tz === "0") return 0;
    var sign = 1;
    if (tz.charAt(0) === '-') sign = -1;
    if (tz.charAt(0) === '+' || tz.charAt(0) === '-') tz = tz.substring(1);
    var parts = tz.split(":");
    var h = parseInt(parts[0], 10);
    var m = parts.length > 1 ? parseInt(parts[1], 10) : 0;
    return sign * (h + m / 60.0);
}

function formatCityTime(offset) {
    var local = parseLocalTime();
    var localOffset = parseTZOffset();

    var localDec = local.h + (local.m / 60.0);
    var utcDec = localDec - localOffset;
    var cityDec = utcDec + offset;

    while (cityDec < 0) cityDec += 24;
    while (cityDec >= 24) cityDec -= 24;

    var ch = Math.floor(cityDec);
    var cm = Math.round((cityDec - ch) * 60);
    if (cm === 60) { cm = 0; ch = (ch + 1) % 24; }

    return A.fmt.pad2(ch) + ":" + A.fmt.pad2(cm);
}

// --- Alarm Data ---
var alarmH = 8;
var alarmM = 0;
var alarmOn = false;
var isAlarmRinging = false;

// --- Stopwatch Data ---
var swRunning = false;
var swStart = 0;
var swAccumulated = 0;

// --- Timer Data ---
var timerRunning = false;
var timerStart = 0;
var timerTotalMs = 5 * 60 * 1000; // 5 mins
var timerRemaining = timerTotalMs;

// cronometro/timer com centesimos: "MM:SS.CC" (o fmt do kit nao tem essa
// precisao — monta com o pad2 do sistema)
function formatMillis(ms) {
    var totalSec = Math.floor(ms / 1000);
    var mins = Math.floor(totalSec / 60);
    var secs = totalSec % 60;
    var frac = Math.floor((ms % 1000) / 10);
    return A.fmt.pad2(mins) + ":" + A.fmt.pad2(secs) + "." + A.fmt.pad2(frac);
}

var currentH = 0;
var currentM = 0;
var currentS = 0;

function updateRealtime() {
    var t = parseLocalTime();
    currentH = t.h;
    currentM = t.m;
    currentS = System.getSeconds();
}

// ==========================================
// TELAS
// ==========================================

// Anel de segundos: desenho proprio, so quando o segundo muda (ou frame total)
var ringSec = -1;
function drawRing(cx, cy, r, frac, col, full) {
    var key = Math.floor(frac * 600);
    if (!full && key === ringSec) return;
    ringSec = key;
    A.widgets.ring(cx, cy, r, frac, { th: 6, bg: A.style.T.raised, color: col });
}

function renderClock(full) {
    var T = A.T;
    var cx = A.L.cx, cy = A.L.top + 98;
    drawRing(cx, cy, 92, currentS / 60, T.accent, full);
    UI.text(A.fmt.pad2(currentH) + ":" + A.fmt.pad2(currentM), cx, cy - 30,
            { role: "display", align: "center" });
    UI.text(A.fmt.pad2(currentS), cx, cy + 12, { role: "title", align: "center", color: T.accent });
    var wd = System.getWeekday ? WEEK[System.getWeekday()] : "";
    UI.text((wd ? wd + ", " : "") + System.getDate(), A.L.cx, A.L.top + 206,
            { align: "center" });
    UI.text("fuso " + System.getTimezone(), A.L.cx, A.L.top + 232,
            { role: "caption", align: "center", color: T.textDim });
}

// linhas do relogio mundial: reconstruidas so quando o minuto muda
var worldMin = -1;
var worldRows = null;
function renderWorld() {
    var T = A.T;
    if (!worldRows || currentM !== worldMin) {
        worldMin = currentM;
        worldRows = [{ label: "Aqui", right: A.fmt.pad2(currentH) + ":" + A.fmt.pad2(currentM),
                       rightColor: T.accent }];
        for (var i = 0; i < cities.length; i++) {
            worldRows.push({ label: cities[i].name,
                             sub: "UTC" + (cities[i].offset >= 0 ? "+" : "") + cities[i].offset,
                             right: formatCityTime(cities[i].offset), rightColor: T.warn });
        }
    }
    UI.list("world", A.L.x, A.L.top, A.L.w, A.L.bottom - A.L.top, worldRows, { rowH: 48 });
}

function renderAlarm(full) {
    var T = A.T;
    UI.text("agora " + A.fmt.pad2(currentH) + ":" + A.fmt.pad2(currentM) + ":" + A.fmt.pad2(currentS),
            A.L.cx, A.L.top + 8, { role: "caption", align: "center", color: T.textDim });
    UI.text(A.fmt.pad2(alarmH) + ":" + A.fmt.pad2(alarmM), A.L.cx, A.L.top + 34,
            { role: "display", align: "center", color: alarmOn ? T.accent : T.text });
    var changed = false;
    if (A.style.button("H+", 16, A.L.top + 96, 48, 40, { variant: "ghost" })) { alarmH = (alarmH + 1) % 24; changed = true; }
    if (A.style.button("H-", 70, A.L.top + 96, 48, 40, { variant: "ghost" })) { alarmH = (alarmH + 23) % 24; changed = true; }
    if (A.style.button("M+", 122, A.L.top + 96, 48, 40, { variant: "ghost" })) { alarmM = (alarmM + 1) % 60; changed = true; }
    if (A.style.button("M-", 176, A.L.top + 96, 48, 40, { variant: "ghost" })) { alarmM = (alarmM + 59) % 60; changed = true; }
    // alarme ja ligado: reprograma o do OS com a hora nova
    if (changed && alarmOn && typeof System.setAlarm === "function") {
        try { System.setAlarm(alarmH, alarmM, "Alarme"); } catch (ec) {}
    }
    A.style.card(A.L.x, A.L.top + 152, A.L.w, 48, {
        full: full, elev: 1, grad: true,
        draw: function (r) {
            UI.text("Alarme ligado", r.x, r.y + 6);
            var on = UI.toggle(r.x + r.w - 46, r.y + 4, alarmOn);
            if (on !== alarmOn) {
                alarmOn = on;
                // alarme de verdade no OS (API 12+): dispara mesmo com o app fechado
                if (typeof System.setAlarm === "function") {
                    if (alarmOn) {
                        try { System.setAlarm(alarmH, alarmM, "Alarme"); } catch (ea) {}
                    } else {
                        try { System.clearAlarm(); } catch (eb) {}
                    }
                }
            }
        }
    });
    UI.text("O alarme do sistema toca mesmo com o app fechado.", A.L.cx, A.L.top + 214,
            { role: "caption", align: "center", color: T.textDim, w: A.L.w, lines: 2 });
}

function renderStopwatch(full) {
    var T = A.T;
    var currentMs = swAccumulated + (swRunning ? System.millis() - swStart : 0);
    drawRing(A.L.cx, A.L.top + 92, 84, (currentMs % 60000) / 60000, swRunning ? T.ok : T.textDim, full);
    UI.text(formatMillis(currentMs), A.L.cx, A.L.top + 80, { role: "title", align: "center" });
    if (A.style.button(swRunning ? "Parar" : "Iniciar", A.L.x, A.L.top + 200, 108, 44,
                       { color: swRunning ? T.warn : T.ok, textColor: T.onAccent })) {
        if (swRunning) {
            swAccumulated += (System.millis() - swStart);
            swRunning = false;
        } else {
            swStart = System.millis();
            swRunning = true;
        }
    }
    if (A.style.button("Zerar", A.L.x + 116, A.L.top + 200, 108, 44, { variant: "ghost" })) {
        swRunning = false;
        swAccumulated = 0;
    }
}

function renderTimer(full) {
    var T = A.T;
    var currentMs = timerTotalMs;
    if (timerRunning) {
        currentMs = timerTotalMs - (System.millis() - timerStart);
        if (currentMs <= 0) {
            currentMs = 0;
            timerRunning = false;
            timerRemaining = 0;
            isAlarmRinging = true; // tela de alarme
            UI.invalidate();
            tone([[880, 150], [660, 150], [880, 200]]);
        }
    }
    // anel esvazia conforme o tempo corre (zerado fica vazio, nao cheio)
    var base = timerRemaining > 0 ? timerRemaining : 0;
    drawRing(A.L.cx, A.L.top + 80, 72, base > 0 && currentMs <= base ? currentMs / base : 0, T.accent, full);
    UI.text(formatMillis(currentMs), A.L.cx, A.L.top + 68, { role: "title", align: "center" });
    if (!timerRunning) {
        if (A.style.button("+1 min", A.L.x, A.L.top + 164, 108, 32, { variant: "ghost" })) { timerTotalMs += 60000; timerRemaining = timerTotalMs; }
        if (A.style.button("-1 min", A.L.x + 116, A.L.top + 164, 108, 32, { variant: "ghost" }) && timerTotalMs >= 60000) {
            timerTotalMs -= 60000;
            timerRemaining = timerTotalMs;
        }
    }
    if (A.style.button(timerRunning ? "Pausar" : "Iniciar", A.L.x, A.L.top + 208, 108, 44,
                       { color: timerRunning ? T.warn : T.ok, textColor: T.onAccent })) {
        if (timerRunning) {
            timerTotalMs = timerTotalMs - (System.millis() - timerStart);
            timerRemaining = timerTotalMs;
            timerRunning = false;
        } else if (timerTotalMs > 0) {
            timerRemaining = timerTotalMs;
            timerStart = System.millis();
            timerRunning = true;
        }
        UI.invalidate();
    }
    if (A.style.button("Zerar", A.L.x + 116, A.L.top + 208, 108, 44, { variant: "ghost" })) {
        timerRunning = false;
        timerTotalMs = 5 * 60 * 1000;
        timerRemaining = timerTotalMs;
        UI.invalidate();
    }
}

function renderRinging(full) {
    var T = A.T;
    var W = System.screenWidth(), H = System.screenHeight();
    if (full) System.fillGradient(0, 0, W, H, T.err, System.mixColor(T.err, 0, 60));
    UI.text("ACORDAR!", A.L.cx, 96, { role: "display", align: "center", color: 0xFFFF });
    if (A.style.button("Parar", 40, 200, 160, 60, { color: 0xFFFF, textColor: T.err, role: "title" })) {
        isAlarmRinging = false;
        UI.invalidate();
    }
}

// ==========================================
// LACO (o A.run fica com o frame)
// ==========================================
var lastTab = currentTab;
A.run({
    main: function (c) {
        var T = A.T;
        updateRealtime();
        // Alarme interno (o do OS tambem toca com o app fechado)
        if (alarmOn && !isAlarmRinging && currentH === alarmH && currentM === alarmM) {
            isAlarmRinging = true;
            alarmOn = false; // dispara uma vez
            UI.invalidate();
        }

        if (c.full) ringSec = -1;
        if (isAlarmRinging) {
            // bip repetido enquanto toca (o alarme do OS cobre o aparelho mudo)
            if (A.every(2500, "ring")) tone([[880, 150], [660, 150], [880, 200]]);
            renderRinging(c.full);
            return;
        }
        currentTab = UI.tabs(A.L.x, 6, A.L.w, 32, TABS, currentTab);
        if (currentTab !== lastTab) {
            lastTab = currentTab;
            UI.invalidate();
        } else if (currentTab === TAB_CLOCK) renderClock(c.full);
        else if (currentTab === TAB_WORLD) renderWorld();
        else if (currentTab === TAB_ALARM) renderAlarm(c.full);
        else if (currentTab === TAB_STOPWATCH) renderStopwatch(c.full);
        else if (currentTab === TAB_TIMER) renderTimer(c.full);
    }
}, "main", { fps: 20 });
