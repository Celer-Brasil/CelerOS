// Batata Quente — jogo de roda pela malha CelerNet (API 27). Cada um abre o
// app no seu aparelho; quem começa pega a batata com um pavio ESCONDIDO
// (12 a 25 s). Quem está com ela toca "Passar!" e a batata voa para outro
// jogador ao acaso (unicast pela malha, quantos saltos precisar). O pavio
// segue queimando com quem estiver segurando — os bipes aceleram — e quem
// estiver com ela quando estourar queima.
//
// Protocolo (cada mensagem cabe num quadro de 16 B; prefixo "b"):
//   bh<estado>             oi do jogador (broadcast a cada 3 s; l=sala g=jogo)
//   bs<rodada>,<ds>        começou (broadcast): quem manda segura a batata
//   bp<rodada>.<n>.<ds>    passe n (unicast, 2 cópias) com o pavio restante
//   bk<rodada>.<n>         peguei o passe n (broadcast): todos sabem quem tem
//   bx<rodada>             estourou na mão de quem manda (broadcast)
// Sem ACK no rádio, o próprio "bk" é o ACK do passe: sem ele em 3,5 s o
// passe é reenviado; 3 tentativas sem resposta e a batata volta.

// Som: System.sfx (API 32) mistura o efeito por cima da trilha e NAO trava
// o loop do jogo; firmware antigo cai no playTone (bloqueante)
var somFn = typeof System.sfx === "function" ? System.sfx :
            (typeof System.playTone === "function" ? System.playTone : null);

var mesh = require("celeros.mesh");
// placas sem Bluetooth nao tem CelerNet: a malha e o jogo, entao a partida
// nao comeca — mas nenhuma chamada crua pode derrubar o app aberto na CYD
var TEM_MALHA = typeof CelerNet !== "undefined";
var T = System.theme();
// LED da placa: System.led so existe com a permissao "gpio" (o app nao pede
// consentimento de hardware por causa de um enfeite) — sem ela, nada acende
function led(r, g, b) { if (typeof System.led === "function") System.led(r, g, b); }

var LOBBY = 0, GAME = 1, OVER = 2;
var state = LOBBY;
var players = {};          // id -> {name, at, burns}
var me = null;
var helloAt = -10000;
var round = 0;
var holder = "";           // id de quem tem a batata ("" = em trânsito/ninguém)
var holding = false;
var fuse = 0;              // ms restantes (só quem segura sabe)
var passN = 0;             // último passe visto nesta rodada
var lastFrom = "";         // quem passou para mim (evita devolver em roda de 3+)
var transit = null;        // {to, n, ds, at, tries}
var heldAt = 0;
var beepAt = 0;
var loser = "";
var overAt = 0;
var lastFrame = 0;

function nameOf(id) {
    if (me && id === me.id) return "Você";
    return players[id] ? players[id].name : id;
}
function others() {
    var out = [], now = System.millis();
    for (var id in players) {
        if (players.hasOwnProperty(id) && id !== me.id && now - players[id].at < 10000) out.push(id);
    }
    return out;
}
function touchPlayer(id, name) {
    if (!players[id]) { players[id] = { name: name || id, at: 0, burns: 0 }; UI.invalidate(); }
    players[id].at = System.millis();
    if (name) players[id].name = name;
}
function burn(id) {
    if (!players[id]) players[id] = { name: id, at: System.millis(), burns: 0 };
    players[id].burns++;
}

function startRound() {
    round = 100 + Math.floor(Math.random() * 899);
    var ms = 12000 + Math.floor(Math.random() * 13000);
    if (!TEM_MALHA || !CelerNet.broadcast("bs" + round + "," + Math.round(ms / 100), 6)) {
        UI.toast(TEM_MALHA ? "Malha ocupada, tente de novo" : "Placa sem malha (Bluetooth)");
        return;
    }
    passN = 0;
    grab(me.id, ms);
    state = GAME;
    UI.invalidate();
}
function grab(from, ms) {
    holding = true;
    holder = me.id;
    fuse = ms;
    heldAt = System.millis();
    lastFrom = from;
    led(255, 120, 0);
    UI.invalidate();
}
function pass() {
    var opts = others();
    if (!opts.length) { UI.toast("Ninguém para receber"); return; }
    if (opts.length > 1 && lastFrom) {
        var f = [];
        for (var i = 0; i < opts.length; i++) if (opts[i] !== lastFrom) f.push(opts[i]);
        if (f.length) opts = f;
    }
    var to = opts[Math.floor(Math.random() * opts.length)];
    passN++;
    transit = { to: to, n: passN, ds: Math.max(1, Math.round(fuse / 100)), at: System.millis(), tries: 1 };
    holding = false;
    holder = "";
    sendPass();
    led(0, 0, 0);
    UI.invalidate();
}
function sendPass() {
    var ok = TEM_MALHA &&
             CelerNet.send(transit.to, "bp" + round + "." + transit.n + "." + transit.ds, { urgent: true });
    transit.at = System.millis();
    if (!ok) transit.at -= 2500;   // destino sumiu da presença: tenta logo de novo
}
function boom() {
    holding = false;
    if (TEM_MALHA) CelerNet.broadcast("bx" + round, 6);
    burn(me.id);
    loser = me.id;
    state = OVER;
    overAt = System.millis();
    led(255, 0, 0);
    UI.invalidate();
    somFn && somFn([[220, 120], [180, 120], [140, 160], [90, 400]]);
}

function onMsg(m, now) {
    var s = "" + m.msg;
    if (s.length < 2 || s.charAt(0) !== "b") return;
    var op = s.charAt(1), a = s.substring(2);
    touchPlayer(m.from, m.fromName);
    if (op === "s") {
        // dois começaram juntos: fica a rodada de quem tem o menor id
        if (state === GAME && holding && passN === 0 && m.from > me.id) return;
        var p = a.split(",");
        round = parseInt(p[0], 10);
        passN = 0;
        holding = false;
        transit = null;
        holder = m.from;
        state = GAME;
        UI.invalidate();
    } else if (op === "p") {
        var q = a.split(".");
        var r = parseInt(q[0], 10), n = parseInt(q[1], 10), ds = parseInt(q[2], 10);
        if (state === OVER && r === round) return;
        if (r !== round) { round = r; state = GAME; passN = 0; }
        if (n > passN || (n === passN && holding)) {
            if (n > passN) {
                passN = n;
                transit = null;
                grab(m.from, ds * 100);
                System.beep(1200, 40);
            }
            if (TEM_MALHA) CelerNet.broadcast("bk" + round + "." + n, 6);   // o "peguei" é o ACK
        } else if (n < passN) {
            // passe velho reenviado (o "bk" dele se perdeu e a batata já
            // seguiu): confirma assim mesmo para o remetente parar de insistir
            if (TEM_MALHA) CelerNet.broadcast("bk" + round + "." + n, 6);
        }
    } else if (op === "k") {
        var k = a.split(".");
        var kr = parseInt(k[0], 10), kn = parseInt(k[1], 10);
        if (kr !== round) return;
        if (transit && kn >= transit.n) transit = null;
        if (kn >= passN) {
            if (holding && m.from !== me.id) {   // a batata voltou por engano: quem confirmou fica
                holding = false;
                led(0, 0, 0);
            }
            passN = kn;
            holder = m.from;
            UI.invalidate();
        }
    } else if (op === "x") {
        if (parseInt(a, 10) !== round || state === OVER) return;
        burn(m.from);
        loser = m.from;
        holding = false;
        transit = null;
        state = OVER;
        overAt = now;
        UI.invalidate();
        System.beep(300, 200);
    }
}

function tick(now) {
    var dt = lastFrame ? now - lastFrame : 0;
    lastFrame = now;
    // quadro longo (malha caiu e o gate segurou o loop, dialogo do sistema):
    // o pavio nao queima o tempo parado de uma vez so
    if (dt > 250) dt = 250;
    if (now - helloAt > 3000) {
        helloAt = now;
        if (TEM_MALHA) CelerNet.broadcast("bh" + (state === LOBBY ? "l" : "g"), 6);
        touchPlayer(me.id, me.name);
    }
    if (state === GAME && holding) {
        fuse -= dt;
        if (fuse <= 0) { boom(); return; }
        // bipes aceleram com o pavio (o único aviso de quanto falta)
        var gap = Math.max(120, Math.min(900, fuse / 14));
        if (now - beepAt > gap) { beepAt = now; System.beep(900 + (fuse < 4000 ? 600 : 0), 25); }
    }
    if (state === GAME && transit && now - transit.at > 3500) {
        if (transit.tries >= 3) {
            // ninguém confirmou: a batata volta (com o pavio de antes)
            // passN fica: um "bk" atrasado do mesmo passe ainda tira a batata daqui
            var back = transit.ds * 100;
            transit = null;
            grab(me.id, back);
            UI.toast("Ninguém pegou: a batata voltou!");
        } else {
            transit.tries++;
            sendPass();
        }
    }
    if (state === OVER && now - overAt > 5000) {
        state = LOBBY;
        led(0, 0, 0);
        UI.invalidate();
    }
}

function scoreItems() {
    var items = [], now = System.millis();
    for (var id in players) {
        if (!players.hasOwnProperty(id)) continue;
        var p = players[id];
        var on = id === me.id || now - p.at < 10000;
        items.push({ label: nameOf(id), sub: on ? "na roda" : "saiu", right: p.burns + " queimadas",
                     enabled: on });
    }
    return items;
}

while (true) {
    var full = UI.begin(state === GAME && holding ? T.raised : T.bg);
    if (UI.header("Batata Quente", { back: true })) { led(0, 0, 0); System.exitApp(); }
    if (!mesh.gate("Ligue a malha (app Matilha) para jogar com os aparelhos ao redor.")) {
        UI.end();
        continue;
    }
    me = mesh.me();
    var now = System.millis();
    mesh.each(onMsg, now);
    tick(now);

    if (state === LOBBY) {
        UI.text("Roda de " + (others().length + 1) + " · abram o app nos aparelhos", 10, 52,
                { role: "caption", w: 220, color: T.textDim, id: "sala" });
        UI.list("roda", 10, 72, 220, 180, scoreItems(), { rowH: 44 });
        if (UI.button("Começar", 10, 262, 220, 44, { disabled: others().length < 1 })) startRound();
    } else if (state === GAME) {
        if (holding) {
            if (full) {
                System.fillSmoothCircle(120, 140, 70, 0xC340);
                System.fillSmoothCircle(98, 118, 14, 0xE4A0);
                System.fillSmoothCircle(146, 166, 8, 0x8200);
            }
            UI.text("A BATATA ESTÁ COM VOCÊ!", 120, 222, { role: "title", align: "center", color: T.warn, id: "st" });
            if (UI.button("Passar!", 10, 248, 220, 60, { style: "danger",
                                                         disabled: now - heldAt < 800 })) pass();
        } else {
            UI.text(transit ? "Voando para " + nameOf(transit.to) + "..." :
                    holder ? "Batata com " + nameOf(holder) : "Batata no ar...",
                    120, 90, { role: "title", align: "center", w: 220, id: "st" });
            UI.list("roda", 10, 120, 220, 190, scoreItems(), { rowH: 44 });
        }
    } else {
        var euQueimei = loser === me.id;
        UI.text(euQueimei ? "BUM! Você queimou" : nameOf(loser) + " queimou!", 120, 90,
                { role: "title", align: "center", color: euQueimei ? T.err : T.ok, w: 220, id: "st" });
        UI.list("roda", 10, 120, 220, 190, scoreItems(), { rowH: 44 });
    }
    UI.end();
}
