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
// CelerKit UI 2.0: header com ajustes, card-heroi de vigia (interruptor na
// mesma area de sempre), anel de vigias armadas, lista rica de vigias com
// estado/sinal e botoes de panico/desarme; tela de alarme com fundo piscando.
// Roda na CYD (sem BT): o portao explica e nada de malha e chamado.
//
// O protocolo no ar NAO mudou (compativel com Sentinela 1.0..1.3.1 e com o
// service.js do proprio pacote, que segue identico):
//   a^<0|1><sensores>        sinal da vigia (broadcast a cada 5 s, ttl 8)
//   a!<n>.<tipo>[id]         alarme n da origem: m movimento, s som,
//                            p panico, v<id> vigia sumiu (ttl 8, 2 vezes)
//   a-<hash do PIN>          desarmar tudo (ttl 8)

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.widgets");
require("celeros.app.list");
require("celeros.app.caps");
require("celeros.app.mesh");

A.init();
A.style.preset("soft");
A.mesh.family("a");

var T = A.style.T;
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
var base = null;             // aceleracao de repouso da vigia
var micAt = 0;
var alarmN = parseInt(Storage.get("n", "0"), 10) || 0;
var lastLocalAlarm = -99999;
var offBeats = 0;            // sinais de "desarmada" ainda por mandar
var lastPhase = -1;          // pisca do alarme
var frameNow = 0;            // relogio do quadro corrente (os handlers usam)
var caps = A.caps.probe();
var lastSig = {};            // assinaturas do desenho base (sem UI.custom)

var guards = {};             // id -> {name, armed, at, missing}
var seen = {};               // "origem:n" de alarmes ja tratados
var meshWasActive = false;   // malha ligada no frame anterior
var ringing = null;          // {zone, kind, at}
var history = [];            // ["zona: tipo", ...]
var resend = [];             // [{op, payload, at}] segunda via dos alarmes
var sheetOpen = false;
var sheetGuard = "";         // id da vigia aberta no sheet
var sheetJust = false;       // abriu neste quadro: o toque nao fecha

// desenho animado: redesenho parcial nas S3, frame total + assinatura na CYD
function custom(id, x, y, w, h, sig, full, draw) {
    if (A.custom && A.style && A.style.custom) { A.style.custom(id, x, y, w, h, sig, draw); return; }
    if (lastSig[id] !== sig) { lastSig[id] = sig; UI.invalidate(); }
    if (full) draw(x, y, w, h);
}

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
    offBeats = on ? 0 : 3;       // as centrais param de vigiar o sumico
    base = null;
    Storage.set("armed", on ? "1" : "0");
    beatAt = -10000;             // avisa as centrais ja
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
            if (seen["v:" + who]) return;          // outra central ja avisou
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

// ---- portao da malha (2.0) -------------------------------------------------
function gate(full) {
    if (typeof CelerNet === "undefined" || typeof Pack === "undefined") {
        A.style.card(10, 56, 220, 108, { full: full, draw: function (r) {
            UI.text("Esta placa não tem Bluetooth no firmware.", r.x, r.y,
                    { w: r.w, lines: 2, role: "body", color: T.text, bg: r.bg });
            UI.text("A Sentinela fala pela malha CelerNet (app Matilha). O alarme local ainda pode tocar se você armar.",
                    r.x, r.y + 30, { w: r.w, lines: 4, role: "caption", color: T.textDim, bg: r.bg });
        }});
        return false;
    }
    if (CelerNet.status().active) return true;
    A.style.card(10, 56, 220, 96, { full: full, draw: function (r) {
        UI.text("Ligue a malha (app Matilha): a Sentinela fala pela CelerNet.",
                r.x, r.y, { w: r.w, lines: 4, role: "body", color: T.text, bg: r.bg });
    }});
    if (A.widgets.button("Ligar a malha", 10, 168, 220, 36,
                         { icon: "wifi", bg: T.accent, textColor: T.onAccent })) {
        if (!CelerNet.start({})) UI.toast("Sem RAM para o rádio agora");
    }
    return false;
}

function guardRows(now) {
    var items = [];
    for (var id in guards) {
        if (!guards.hasOwnProperty(id)) continue;
        var g = guards[id];
        var age = Math.floor((now - g.at) / 1000);
        items.push({
            label: g.name,
            sub: g.missing ? "SUMIU há " + age + " s" : (g.armed ? "armada" : "desarmada") +
                 " · sinal há " + age + " s",
            icon: g.missing ? "alert" : (g.armed ? "check" : "dot"),
            right: g.missing ? "!" : g.armed ? "ON" : "off",
            rightColor: g.missing ? T.err : g.armed ? T.ok : T.textDim,
            gid: id
        });
    }
    if (!items.length) items.push({ label: "Nenhuma vigia ouvida",
                                    sub: "ligue Vigiar em outro aparelho", icon: "dot",
                                    disabled: true });
    return items;
}
function guardStamp(now) {
    var h = 5381;
    for (var id in guards) {
        if (!guards.hasOwnProperty(id)) continue;
        var g = guards[id];
        for (var i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) | 0;
        h = (h * 7 + (g.armed ? 1 : 0) + (g.missing ? 2 : 0)) | 0;
        h = (h * 7 + Math.floor((now - g.at) / 1000)) | 0;
    }
    return h;
}
function guardCount() {
    var n = 0;
    for (var id in guards) if (guards.hasOwnProperty(id)) n++;
    return n;
}
var guardList = A.list.make(function () { return guardStamp(System.millis()); },
                            function () { return guardRows(System.millis()); });

// ---- app -----------------------------------------------------------------
A.run({
    main: function (c) {
        var now = c.now;
        frameNow = now;
        var phase = ringing ? Math.floor((now - ringing.at) / 400) : -1;
        var flash = phase >= 0 && phase % 2 === 0;
        // fundo do alarme: o A.run fixa UI.begin no tema, o vermelho vai por
        // cima (frame cheio; o pisca invalida no cambio de fase, la embaixo)
        if (c.full && ringing && flash) System.fillRect(0, 0, 240, 320, T.err);
        var h = A.widgets.header("Sentinela", { full: c.full,
            actions: ringing ? [] : [{ icon: "gear", id: "cfg" }] });
        if (h.back) { led(0, 0, 0); return A.BACK; }
        if (h.action === "cfg") return "config";
        if (!gate(c.full)) {
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
            A.style.card(8, 48, 224, 128, { full: c.full, elev: 0, draw: function (rc) {
                A.icons.draw("alert", 104, rc.y + 0, 30, { color: T.text });
                UI.text("ALARME", 120, rc.y + 36, { role: "display", align: "center",
                                                    color: T.text, bg: rc.bg, id: "al1" });
                UI.text(ringing.zone, 120, rc.y + 64, { role: "title", align: "center",
                                                       w: 200, color: T.text, bg: rc.bg, id: "al2" });
                UI.text(KINDS[ringing.kind] || ringing.kind, 120, rc.y + 86,
                        { align: "center", color: T.text, bg: rc.bg, id: "al3" });
            }});
            if (A.style.button("Silenciar aqui", 8, 196, 224, 40, { variant: "secondary" })) {
                ringing = null; led(0, 0, 0);
            }
            if (A.style.button("Desarmar tudo (PIN)", 8, 244, 224, 46, { variant: "danger" })) {
                disarmAll(now);
            }
            return;
        }

        // card-heroi: estado da vigia + interruptor (mesma area de toque de
        // sempre: o harness e a bancada tocam 198,68 para armar)
        var gc = guardCount();
        A.style.card(8, 44, 224, 96, { full: c.full, draw: function (rc) {
            A.icons.draw(armed ? "alert" : "dot", rc.x, rc.y + 2, 22,
                         { color: armed ? T.err : T.textDim });
            UI.text(armed ? "Vigiando" : "Desarmada", rc.x + 30, rc.y,
                    { role: "title", color: armed ? T.err : T.text, bg: rc.bg,
                      w: 118, lines: 1, id: "armst" });
            UI.text(armed ? "vigia há " + Math.floor((now - armedAt) / 1000) + " s"
                          : "toque no interruptor para armar",
                    rc.x + 30, rc.y + 22, { role: "caption", color: T.textDim, bg: rc.bg,
                                           w: 118, lines: 1, id: "armsub" });
            var sens = [];
            if (useImu) sens.push("movimento");
            if (useMic) sens.push("barulho");
            sens.push("pânico");
            UI.text("dispara: " + sens.join(", "), rc.x, rc.y + 56,
                    { role: "caption", color: armed ? T.ok : T.textDim, bg: rc.bg,
                      w: rc.w - 40, lines: 1, id: "sens" });
            custom("vig", rc.x + rc.w - 34, rc.y + 44, 30, 30, "g" + gc + (armed ? "A" : "D"),
                   c.full, function (x, y, w2, h2) {
                       A.widgets.ring(x + 15, y + 15, 14, gc ? Math.min(1, gc / 4) : 0,
                                      { th: 4, bg: T.raised, color: armed ? T.ok : T.textDim });
                   });
        }});
        var want = UI.toggle(176, 56, armed);
        if (want !== armed) setArmed(want, now);

        var rows = guardList.rows();
        var li = A.list.view("guards", 8, 146, 224, 106, rows,
                             { row: 34, panel: true, rowR: 6 });
        if (!sheetOpen && li >= 0 && rows[li] && !rows[li].disabled) {
            sheetGuard = rows[li].gid;
            sheetOpen = true;
            sheetJust = true;
            UI.invalidate();
        }
        if (sheetJust) sheetJust = false;
        else {
            // full:false: o veu do sheet cobre os slots do header/lista e o
            // titulo sumia; sem veu o card sobe e o fundo continua legivel
            var sh = A.widgets.sheet("guard", { open: sheetOpen, full: false, h: 150,
                                                title: "Vigia" }, function (r) {
                var gg = guards[sheetGuard];
                if (!gg) {
                    UI.text("Vigia sumiu da lista", r.x, r.y,
                            { role: "caption", color: T.textDim, bg: r.bg, w: r.w });
                    return;
                }
                UI.text(gg.name, r.x, r.y, { role: "title", bg: r.bg, w: r.w, lines: 1 });
                UI.text(gg.missing ? "SUMIU do ar" : (gg.armed ? "armada" : "desarmada"),
                        r.x, r.y + 22, { role: "caption",
                                         color: gg.missing ? T.err : (gg.armed ? T.ok : T.textDim),
                                         bg: r.bg, w: r.w, lines: 1 });
                UI.text("Sinal há " + Math.floor((now - gg.at) / 1000) + " s · ID " + sheetGuard,
                        r.x, r.y + 44, { role: "caption", color: T.textDim, bg: r.bg,
                                         w: r.w, lines: 1 });
                UI.text(gg.missing ? "O watchdog acusou esta vigia para a casa."
                                   : "A vigia manda um sinal a cada 5 s.",
                        r.x, r.y + 66, { role: "caption", color: T.textDim, bg: r.bg,
                                         w: r.w, lines: 2 });
            });
            if (sh === "close") { sheetOpen = false; UI.invalidate(); }
        }

        if (history.length) UI.text("Último: " + history[0], 8, 256,
                                    { role: "caption", w: 224, id: "hist" });
        if (!sheetOpen) {
            if (A.style.button("Pânico", 8, 270, 108, 40,
                               { icon: "alert", bg: T.err, textColor: 0xFFFF })) raise("p", "", now);
            if (A.style.button("Desarmar", 124, 270, 108, 40,
                               { variant: "secondary" })) disarmAll(now);
        }
    },
    config: function (c) {
        var h = A.widgets.header("Ajustes", { full: c.full });
        if (h.back) return A.BACK;
        A.style.card(8, 48, 224, 150, { full: c.full, draw: function (r) {
            UI.text("Sensores da vigia", r.x, r.y, { role: "caption", color: T.textDim, bg: r.bg, w: r.w });
            UI.text("Movimento", r.x, r.y + 24,
                    { w: 150, bg: r.bg, color: hasImu ? T.text : T.textDim, id: "imu" });
            UI.text(hasImu ? "acelerômetro da placa" : "sem acelerômetro nesta placa",
                    r.x, r.y + 40, { role: "caption", color: T.textDim, bg: r.bg, w: 150 });
            if (hasImu) {
                var ni = UI.toggle(r.x + r.w - 44, r.y + 20, useImu);
                if (ni !== useImu) { useImu = ni; UI.invalidate(); }
            }
            UI.text("Barulho", r.x, r.y + 66,
                    { w: 150, bg: r.bg, color: hasMic ? T.text : T.textDim, id: "mic" });
            UI.text(hasMic ? "microfone da placa" : "sem microfone nesta placa",
                    r.x, r.y + 82, { role: "caption", color: T.textDim, bg: r.bg, w: 150 });
            if (hasMic) {
                var nm = UI.toggle(r.x + r.w - 44, r.y + 62, useMic);
                if (nm !== useMic) { useMic = nm; UI.invalidate(); }
            }
            A.style.divider(r.x, r.y + 108, r.w);
            UI.text("PIN: " + (pinHash ? "definido" : "nenhum"), r.x, r.y + 118,
                    { role: "caption", color: T.textDim, bg: r.bg, w: r.w, lines: 1 });
        }});
        A.style.card(8, 206, 224, 84, { full: c.full, draw: function (r) {
            UI.text(caps.bt ? "A malha leva o alarme a até 8 saltos; o watchdog acusa a vigia que sumir."
                            : "Sem Bluetooth nesta placa: a vigia e o alarme locais continuam valendo; o disparo entre aparelhos precisa da CelerNet.",
                    r.x, r.y, { role: "caption", color: caps.bt ? T.textDim : T.warn,
                                bg: r.bg, w: r.w, lines: 4 });
        }});
    }
}, "main");
