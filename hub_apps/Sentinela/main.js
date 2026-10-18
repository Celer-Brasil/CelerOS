// Sentinela — alarme da casa feito de aparelhos CelerOS pela malha CelerNet
// (API 27). Qualquer aparelho com o app aberto vira CENTRAL (mostra e toca os
// alarmes); ligue "Vigiar" num deles e ele vira VIGIA: o relogio ou o cachorro
// parados na porta disparam com movimento (IMU), o microfone dispara com
// barulho e o botao Panico dispara de qualquer um. O alarme atravessa a casa
// por ate 8 saltos.
//
// Antissabotagem: a vigia armada da sinal a cada 5 s; se uma vigia armada
// SOME (desligada, sem bateria, levada para longe), as centrais disparam
// "vigia sumiu" — calar uma vigia e motivo de alarme, nao de silencio.
// Desarmar tudo pede o PIN escolhido ao armar (vai como hash: brinquedo de
// casa, nao cofre — a malha e aberta).
//
// Migrado para o CelerKit: o casco do loop e o tema vieram do celeros.app
// (A.run/A.T/A.header) e o protocolo de malha do celeros.app.mesh (A.mesh,
// familia "a", each parsing op/resto). O fundo vermelho do alarme, que ia na
// cor do UI.begin, agora e um fillRect do proprio quadro (o A.run fixa o
// fundo do tema). O protocolo no ar NAO mudou (compativel com Sentinela
// 1.0..1.2.1 e com o service.js do proprio pacote, que vendoriza
// celeros.mesh — servicos nao carregam a tabela de deps do hub):
//   a^<0|1><sensores>        sinal da vigia (broadcast a cada 5 s, ttl 8)
//   a!<n>.<tipo>[id]         alarme n da origem: m movimento, s som,
//                            p panico, v<id> vigia sumiu (ttl 8, 2 vezes)
//   a-<hash do PIN>          desarmar tudo (ttl 8)

var A = require("celeros.app");
require("celeros.app.mesh");

A.init();
A.mesh.family("a");

var hasImu = typeof Sensors !== "undefined" && Sensors.accel() !== null;
var hasMic = System.micLevel() >= 0;
// LED da placa: System.led so existe com a permissao "gpio" (o app nao pede
// consentimento de hardware por causa de um enfeite) — sem ela, nada acende
function led(r, g, b) { if (typeof System.led === "function") System.led(r, g, b); }
var KINDS = { m: "movimento", s: "barulho", p: "pânico", v: "vigia sumiu" };

var me = null;
var armed = Storage.get("armed", "0") === "1";
var pinHash = Storage.get("pin", "");
var useImu = hasImu, useMic = false;
var beatAt = -10000;
var armedAt = System.millis();
var base = null;             // aceleração de repouso da vigia
var micAt = 0;
var alarmN = parseInt(Storage.get("n", "0"), 10) || 0;
var lastLocalAlarm = -99999;
var offBeats = 0;            // sinais de "desarmada" ainda por mandar
var lastPhase = -1;          // pisca do alarme
var frameNow = 0;            // relogio do quadro corrente (os handlers usam)

var guards = {};             // id -> {name, armed, at, missing}
var seen = {};               // "origem:n" de alarmes já tratados
var meshWasActive = false;   // malha ligada no frame anterior
var ringing = null;          // {zone, kind, at}
var history = [];            // ["zona: tipo", ...]
var resend = [];             // [{op, payload, at}] segunda via dos alarmes

function hashPin(p) {
    var h = 0x2F1B;
    p = "" + p;
    for (var i = 0; i < p.length; i++) h = ((h << 5) - h + p.charCodeAt(i) * 131) & 0xFFFF;
    return ("000" + h.toString(16)).slice(-4);
}

function ring(zone, kind, now) {
    ringing = { zone: zone, kind: kind, at: now };
    history.unshift(zone + ": " + (KINDS[kind] || kind));
    if (history.length > 4) history.pop();
    System.keepAwake(60000);
    System.notify("Sentinela", zone + ": " + (KINDS[kind] || kind));
    UI.invalidate();
}

function raise(kind, extra, now) {
    alarmN++;
    Storage.set("n", "" + alarmN);
    var payload = alarmN + "." + kind + (extra || "");
    seen[me.id + ":" + alarmN] = true;
    A.mesh.send(null, "!", payload, { ttl: 8 });
    resend.push({ op: "!", payload: payload, at: now + 1000 });
    ring(kind === "v" ? nameOf(extra) : "Aqui (" + me.name + ")", kind, now);
}

function nameOf(id) { return guards[id] ? guards[id].name : id; }

function setArmed(on, now) {
    if (on && !pinHash) {
        var pin = System.prompt("PIN para desarmar (4+ dígitos)", "");
        if (!pin || ("" + pin).length < 4) { UI.toast("Sem PIN, sem vigia"); return; }
        pinHash = hashPin(pin);
        Storage.set("pin", pinHash);
    }
    armed = on;
    armedAt = now;
    offBeats = on ? 0 : 3;       // as centrais param de vigiar o sumiço
    base = null;
    Storage.set("armed", on ? "1" : "0");
    beatAt = -10000;             // avisa as centrais já
    UI.invalidate();
}

function sense(now) {
    if (!armed || now - armedAt < 3000) return;          // tempo de sair de perto
    if (now - lastLocalAlarm < 10000) return;            // um alarme por vez
    if (useImu) {
        var a = Sensors.accel();
        if (a) {
            if (!base) base = a;
            var d = Math.abs(a.x - base.x) + Math.abs(a.y - base.y) + Math.abs(a.z - base.z);
            if (d > 0.35) { lastLocalAlarm = now; base = a; raise("m", "", now); return; }
            // deriva lenta (temperatura) acompanha a base
            base = { x: base.x * 0.98 + a.x * 0.02, y: base.y * 0.98 + a.y * 0.02, z: base.z * 0.98 + a.z * 0.02 };
        }
    }
    if (useMic && now - micAt > 1500) {
        micAt = now;
        if (System.micLevel() > 60) { lastLocalAlarm = now; raise("s", "", now); }
    }
}

// handler do A.mesh.each: (de, op, resto, quadro). op "" = familia alheia.
function onMesh(from, op, rest, m) {
    if (op === "^") {
        var g = guards[from] || (guards[from] = { name: m.fromName || from, missing: false });
        g.armed = rest.charAt(0) === "1";
        g.at = frameNow;
        g.name = m.fromName || g.name;
        g.missing = false;
        UI.invalidate();
    } else if (op === "!") {
        var dot = rest.indexOf(".");
        var key = from + ":" + rest.substring(0, dot);
        if (seen[key]) return;
        seen[key] = true;
        var kind = rest.charAt(dot + 1);
        if (kind === "v") {
            var who = rest.substring(dot + 2);
            if (seen["v:" + who]) return;          // outra central já avisou
            seen["v:" + who] = true;
            if (guards[who]) guards[who].missing = true;
            ring(nameOf(who), "v", frameNow);
        } else {
            ring(m.fromName || from, kind, frameNow);
        }
    } else if (op === "-") {
        // desarme: quem tem PIN conferencia o hash — hash errado nao cala o
        // alarme nem desarma (antes qualquer quadro a- silenciava as
        // centrais, armadas ou nao); quem nunca armou nao tem como conferir
        // e confia, para o desarme continuar funcionando na casa toda
        if (pinHash) {
            if (rest === pinHash) {
                if (armed) {
                    setArmed(false, frameNow);
                    UI.toast("Desarmada por " + (m.fromName || from));
                }
                ringing = null;
                UI.invalidate();
            }
        } else {
            ringing = null;
            UI.invalidate();
        }
    }
}

function watchdog(now) {
    for (var id in guards) {
        if (!guards.hasOwnProperty(id)) continue;
        var g = guards[id];
        if (g.armed && !g.missing && now - g.at > 16000) {
            g.missing = true;
            if (!seen["v:" + id]) { seen["v:" + id] = true; raise("v", id, now); }
        }
    }
}

function disarmAll(now) {
    var pin = System.prompt("PIN das vigias", "");
    if (!pin) return;
    var h = hashPin(pin);
    A.mesh.send(null, "-", h, { ttl: 8 });
    resend.push({ op: "-", payload: h, at: now + 1000 });
    if (armed && h === pinHash) setArmed(false, now);
    ringing = null;
    for (var id in guards) if (guards.hasOwnProperty(id)) guards[id].missing = false;
    UI.invalidate();
}

function guardItems(now) {
    var items = [];
    for (var id in guards) {
        if (!guards.hasOwnProperty(id)) continue;
        var g = guards[id];
        var age = Math.floor((now - g.at) / 1000);
        items.push({ label: g.name, sub: g.missing ? "SUMIU há " + age + " s" : (g.armed ? "armada" : "desarmada") +
                     " · sinal há " + age + " s",
                     right: g.missing ? "!" : g.armed ? "ON" : "off",
                     rightColor: g.missing ? A.T.err : g.armed ? A.T.ok : A.T.textDim });
    }
    if (!items.length) items.push({ label: "Nenhuma vigia ouvida", sub: "ligue Vigiar em outro aparelho", enabled: false });
    return items;
}

// ---- app -----------------------------------------------------------------
A.run({
    main: function (c) {
        var now = c.now;
        frameNow = now;
        var phase = ringing ? Math.floor((now - ringing.at) / 400) : -1;
        var flash = phase >= 0 && phase % 2 === 0;
        // fundo do alarme: o A.run fixa UI.begin no tema, o vermelho vai por
        // cima (frame cheio; o pisca invalida no cambio de fase, la embaixo)
        if (c.full && ringing && flash) System.fillRect(0, 0, 240, 320, A.T.err);
        if (A.header("Sentinela")) { led(0, 0, 0); return A.BACK; }
        if (!A.mesh.gate("Ligue a malha (app Matilha): a Sentinela fala pela CelerNet.")) {
            meshWasActive = false;   // desligou: ao religar, ciclo de graca
            return;
        }
        me = A.mesh.me();
        if (!meshWasActive) {
            // malha (re)ligada: os "at" das vigias pararam no passado e o
            // watchdog dispararia "sumiu" para todas as armadas de uma vez
            meshWasActive = true;
            for (var gid in guards) {
                if (guards.hasOwnProperty(gid)) { guards[gid].at = now; guards[gid].missing = false; }
            }
        }
        A.mesh.each(onMesh);
        for (var r = 0; r < resend.length; r++) {
            if (now >= resend[r].at) {
                A.mesh.send(null, resend[r].op, resend[r].payload, { ttl: 8 });
                resend.splice(r--, 1);
            }
        }
        if (now - beatAt > 5000) {
            beatAt = now;
            if (armed || offBeats > 0) {
                if (!armed) offBeats--;
                A.mesh.send(null, "^", (armed ? "1" : "0") + (useImu ? "m" : "") + (useMic ? "s" : ""), { ttl: 8 });
            }
        }
        sense(now);
        watchdog(now);

        if (ringing) {
            if (phase !== lastPhase) {
                lastPhase = phase;
                UI.invalidate();
                led(flash ? 255 : 0, 0, 0);
                System.beep(flash ? 1400 : 900, 60);
            }
            UI.text("ALARME", 120, 70, { role: "display", align: "center", color: A.T.text, id: "al1" });
            UI.text(ringing.zone, 120, 120, { role: "title", align: "center", w: 220, id: "al2" });
            UI.text(KINDS[ringing.kind] || ringing.kind, 120, 150, { align: "center", id: "al3" });
            if (UI.button("Silenciar aqui", 10, 196, 220, 44)) { ringing = null; led(0, 0, 0); }
            if (UI.button("Desarmar tudo (PIN)", 10, 250, 220, 44, { style: "danger" })) disarmAll(now);
            return;
        }

        UI.card(10, 50, 220, 100);
        UI.text("Vigiar com este aparelho", 20, 60, { w: 150 });
        var want = UI.toggle(176, 56, armed);
        if (want !== armed) setArmed(want, now);
        UI.text(hasMic ? "Disparar com barulho" : "Sem microfone nesta placa", 20, 94,
                { w: 150, color: hasMic ? A.T.text : A.T.textDim });
        if (hasMic) {
            var mic = UI.toggle(176, 90, useMic);
            if (mic !== useMic) { useMic = mic; UI.invalidate(); }
        }
        var sens = [];
        if (useImu) sens.push("movimento");
        if (useMic) sens.push("barulho");
        sens.push("pânico");
        // "dispara:" (nao "dispara com:") para a lista de sensores nao truncar
        // em 200 px quando a vigia esta ARMADA
        UI.text((armed ? "ARMADA · " : "") + "dispara: " + sens.join(", "), 20, 126,
                { role: "caption", color: armed ? A.T.ok : A.T.textDim, w: 200, id: "sens" });
        UI.cardEnd();
        UI.list("guards", 10, 158, 220, 90, guardItems(now), { rowH: 44 });
        if (history.length) UI.text("Último: " + history[0], 10, 252, { role: "caption", w: 220, id: "hist" });
        if (UI.button("Pânico", 10, 268, 106, 44, { style: "danger" })) raise("p", "", now);
        if (UI.button("Desarmar tudo", 124, 268, 106, 44, { style: "ghost" })) disarmAll(now);
    }
}, "main");
