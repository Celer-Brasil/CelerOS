/* Sentinela em segundo plano (API 42): o serviço é a CENTRAL com o app
 * fechado — ouve o sinal das vigias, alarme vira notificação, vigia
 * armada que some é denunciada (com retransmissão deduplicada) e o
 * contador de alarmes compartilha o Storage do app. A VIGIA (sensores de
 * movimento/barulho) continua sendo o app em primeiro plano: o serviço
 * não toca IMU nem microfone. Dorme com app aberto — quem drena a malha
 * é o app da vez; ao acordar, o sinal das vigias leva um ciclo para
 * renovar (sem "sumiu" fantasma). Requer firmware API 42. */
var mesh = require("celeros.mesh");
var KINDS = { m: "movimento", s: "barulho", p: "pânico", v: "vigia sumiu" };

var guards = {};             // id -> {name, armed, at, missing}
var seen = {};               // "origem:n" e "v:id" já tratados
var alarmN = parseInt(Storage.get("n", "0"), 10) || 0;
var wasOpen = true;

function nameOf(id) { return guards[id] ? guards[id].name : id; }

function ring(zone, kind) {
    System.notify("Sentinela", zone + ": " + (KINDS[kind] || kind));
}

// Vigia sumida DETECTADA aqui: notifica e retransmite para as outras
// centrais (mesmo formato do app; o dedup "v:id" evita eco duplo)
function raiseMissing(id, now) {
    alarmN++;
    Storage.set("n", "" + alarmN);
    CelerNet.broadcast("a!" + alarmN + ".v" + id, 8);
    ring(nameOf(id), "v");
}

function onMsg(m, now) {
    var s = "" + m.msg;
    if (s.length < 3 || s.charAt(0) !== "a") return;
    var op = s.charAt(1), a = s.substring(2);
    if (op === "^") {
        var g = guards[m.from] || (guards[m.from] = { name: m.fromName || m.from, missing: false });
        g.armed = a.charAt(0) === "1";
        g.at = now;
        g.name = m.fromName || g.name;
        g.missing = false;
    } else if (op === "!") {
        var dot = a.indexOf(".");
        var key = m.from + ":" + a.substring(0, dot);
        if (seen[key]) return;
        seen[key] = true;
        var kind = a.charAt(dot + 1);
        if (kind === "v") {
            var who = a.substring(dot + 2);
            if (seen["v:" + who]) return;          // outra central já avisou
            seen["v:" + who] = true;
            if (guards[who]) guards[who].missing = true;
            ring(nameOf(who), "v");
        } else {
            ring(m.fromName || m.from, kind);
        }
    }
    // "a-" (desarme): as vigias desarmam sozinhas com o PIN; a central
    // só silencia — nada a fazer sem vidro.
}

function watchdog(now) {
    for (var id in guards) {
        if (!guards.hasOwnProperty(id)) continue;
        var g = guards[id];
        if (g.armed && !g.missing && now - g.at > 16000) {
            g.missing = true;
            if (!seen["v:" + id]) { seen["v:" + id] = true; raiseMissing(id, now); }
        }
    }
}

function tick() {
    var now = System.millis();
    if (System.appOpen() === true) { wasOpen = true; return; }  // o app da vez drena
    if (wasOpen) {
        wasOpen = false;
        // sinal estava congelado enquanto dormimos: um ciclo de graça para
        // as vigias renovarem (senão a primeira volta era "sumiu" fantasma)
        for (var id in guards) {
            if (guards.hasOwnProperty(id)) { guards[id].at = now; guards[id].missing = false; }
        }
    }
    if (!mesh.available() || !CelerNet.status().active) return;
    mesh.each(onMsg, now);
    watchdog(now);
}
setInterval(tick, 500);
