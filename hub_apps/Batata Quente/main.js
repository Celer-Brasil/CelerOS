// Batata Quente — jogo de roda pela malha CelerNet (API 27). Cada um abre o
// app no seu aparelho; quem começa pega a batata com um pavio ESCONDIDO
// (12 a 25 s). Quem está com ela toca "Passar!" e a batata voa para outro
// jogador ao acaso (unicast pela malha, quantos saltos precisar). O pavio
// segue queimando com quem estiver segurando — os bipes aceleram — e quem
// estiver com ela quando estourar queima.
//
// CelerKit UI 2.0: header com ajuda, batata desenhada por primitivas com o
// pavio em anel (só quem segura vê o tempo), lista rica da roda com as
// queimadas de cada um e o botão de passe grande. Roda na CYD (sem BT): o
// portão explica e nenhuma chamada de malha acontece.
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

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.widgets");
require("celeros.app.list");
require("celeros.app.caps");
require("celeros.app.mesh");

A.init();
A.style.preset("soft");
A.mesh.family("b");

var T = A.style.T;
// placas sem Bluetooth nao tem CelerNet: a malha e o jogo, entao a partida
// nao comeca — mas nenhuma chamada crua pode derrubar o app aberto na CYD
var TEM_MALHA = A.mesh.available();
var caps = A.caps.probe();
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
var startReady = false;    // botao Comecar habilitado no quadro anterior
var passReady = false;     // botao Passar liberado (800 ms) no quadro anterior
var lastSig = {};          // assinaturas do desenho base (sem UI.custom)

// desenho animado: redesenho parcial nas S3, frame total + assinatura na CYD
function custom(id, x, y, w, h, sig, full, draw) {
    if (A.custom && A.style && A.style.custom) { A.style.custom(id, x, y, w, h, sig, draw); return; }
    if (lastSig[id] !== sig) { lastSig[id] = sig; UI.invalidate(); }
    if (full) draw(x, y, w, h);
}

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
function othersCount() {
    var n = 0, now = System.millis();
    for (var id in players) {
        if (players.hasOwnProperty(id) && id !== me.id && now - players[id].at < 10000) n++;
    }
    return n;
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
    if (!TEM_MALHA || !A.mesh.send(null, "s", round + "," + Math.round(ms / 100), { ttl: 6 })) {
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
             A.mesh.send(transit.to, "p", round + "." + transit.n + "." + transit.ds, { urgent: true });
    transit.at = System.millis();
    if (!ok) transit.at -= 2500;   // destino sumiu da presença: tenta logo de novo
}
function boom() {
    holding = false;
    if (TEM_MALHA) A.mesh.send(null, "x", "" + round, { ttl: 6 });
    burn(me.id);
    loser = me.id;
    state = OVER;
    overAt = System.millis();
    led(255, 0, 0);
    UI.invalidate();
    somFn && somFn([[220, 120], [180, 120], [140, 160], [90, 400]]);
}

// handler do A.mesh.each: (de, op, resto, quadro). op "" = familia alheia.
function onMesh(from, op, rest, m) {
    if (!op) return;
    touchPlayer(from, m.fromName);
    if (op === "s") {
        // dois começaram juntos: fica a rodada de quem tem o menor id
        if (state === GAME && holding && passN === 0 && from > me.id) return;
        var p = rest.split(",");
        round = parseInt(p[0], 10);
        passN = 0;
        holding = false;
        transit = null;
        holder = from;
        state = GAME;
        UI.invalidate();
    } else if (op === "p") {
        var q = rest.split(".");
        var r = parseInt(q[0], 10), n = parseInt(q[1], 10), ds = parseInt(q[2], 10);
        if (state === OVER && r === round) return;
        if (r !== round) { round = r; state = GAME; passN = 0; }
        if (n > passN || (n === passN && holding)) {
            if (n > passN) {
                passN = n;
                transit = null;
                grab(from, ds * 100);
                System.beep(1200, 40);
            }
            if (TEM_MALHA) A.mesh.send(null, "k", round + "." + n, { ttl: 6 });   // o "peguei" é o ACK
        } else if (n < passN) {
            // passe velho reenviado (o "bk" dele se perdeu e a batata já
            // seguiu): confirma assim mesmo para o remetente parar de insistir
            if (TEM_MALHA) A.mesh.send(null, "k", round + "." + n, { ttl: 6 });
        }
    } else if (op === "k") {
        var k = rest.split(".");
        var kr = parseInt(k[0], 10), kn = parseInt(k[1], 10);
        if (kr !== round) return;
        if (transit && kn >= transit.n) transit = null;
        if (kn >= passN) {
            if (holding && from !== me.id) {   // a batata voltou por engano: quem confirmou fica
                holding = false;
                led(0, 0, 0);
            }
            passN = kn;
            holder = from;
            UI.invalidate();
        }
    } else if (op === "x") {
        if (parseInt(rest, 10) !== round || state === OVER) return;
        burn(from);
        loser = from;
        holding = false;
        transit = null;
        state = OVER;
        overAt = System.millis();
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
        if (TEM_MALHA) A.mesh.send(null, "h", state === LOBBY ? "l" : "g", { ttl: 6 });
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

// ---- linhas da roda --------------------------------------------------------
function scoreItems() {
    var items = [], now = System.millis();
    function push(id) {
        var p = players[id];
        if (!p) return;
        var on = id === me.id || now - p.at < 10000;
        var isHolder = state === GAME && (holding ? id === me.id : id === holder);
        items.push({ label: nameOf(id), sub: isHolder ? "com a batata" : (on ? "na roda" : "saiu"),
                     icon: isHolder ? "heart" : "dot",
                     right: p.burns + (p.burns === 1 ? " queimada" : " queimadas"),
                     rightColor: isHolder ? T.err : T.textDim,
                     disabled: !on });
    }
    if (me) push(me.id);                       // voce primeiro
    for (var id in players) {
        if (players.hasOwnProperty(id) && (!me || id !== me.id)) push(id);
    }
    if (!items.length) items.push({ label: "Roda vazia", sub: "abra o app nos aparelhos",
                                    icon: "dot", disabled: true });
    return items;
}
function scoreStamp() {
    var h = (state + 1) * 7 + (holding ? 1 : 0), now = System.millis();
    for (var i = 0; i < holder.length; i++) h = (h * 33 + holder.charCodeAt(i)) | 0;
    for (var id in players) {
        if (!players.hasOwnProperty(id)) continue;
        var p = players[id];
        for (var k = 0; k < id.length; k++) h = (h * 33 + id.charCodeAt(k)) | 0;
        for (var n = 0; n < p.name.length; n++) h = (h * 33 + p.name.charCodeAt(n)) | 0;
        h = (h * 7 + p.burns) | 0;
        h = (h * 7 + (id === me.id || now - p.at < 10000 ? 1 : 0)) | 0;
    }
    return h;
}
var roundList = A.list.make(function () { return scoreStamp(); }, scoreItems);

// ---- portao da malha (2.0) -------------------------------------------------
function gate(full) {
    if (!caps.bt || !TEM_MALHA) {
        A.style.card(10, 56, 220, 108, { full: full, draw: function (r) {
            UI.text("Esta placa não tem Bluetooth no firmware.", r.x, r.y,
                    { w: r.w, lines: 2, role: "body", color: T.text, bg: r.bg });
            UI.text("A batata voa pela malha CelerNet (app Matilha): abra em 2 ou mais aparelhos com rádio.",
                    r.x, r.y + 30, { w: r.w, lines: 3, role: "caption", color: T.textDim, bg: r.bg });
        }});
        return false;
    }
    if (A.mesh.active()) return true;
    A.style.card(10, 56, 220, 96, { full: full, draw: function (r) {
        UI.text("Ligue a malha (app Matilha) para jogar com os aparelhos ao redor.",
                r.x, r.y, { w: r.w, lines: 4, role: "body", color: T.text, bg: r.bg });
    }});
    if (A.widgets.button("Ligar a malha", 10, 168, 220, 36,
                         { icon: "wifi", bg: T.accent, textColor: T.onAccent })) {
        if (typeof CelerNet !== "undefined" && !CelerNet.start({})) UI.toast("Sem RAM para o rádio agora");
    }
    return false;
}

// batata desenhada por primitivas (sem cor fixa: tudo do tema)
function drawPotato(cx, cy, r, queimada) {
    var base = queimada ? System.mixColor(T.warn, T.err, 70) : T.warn;
    System.fillSmoothCircle(cx, cy, r, base);
    System.fillSmoothCircle(cx - Math.round(r * .34), cy - Math.round(r * .28), Math.round(r * .10),
                            System.mixColor(base, T.card, 45));
    System.fillSmoothCircle(cx + Math.round(r * .30), cy + Math.round(r * .22), Math.round(r * .08),
                            System.mixColor(base, T.card, 55));
    System.fillCircle(cx - Math.round(r * .22), cy - Math.round(r * .10), Math.max(2, Math.round(r * .07)), T.card);
    System.fillCircle(cx + Math.round(r * .22), cy - Math.round(r * .10), Math.max(2, Math.round(r * .07)), T.card);
    if (queimada) {
        System.drawWideLine(cx - Math.round(r * .3), cy - Math.round(r * .35),
                            cx + Math.round(r * .2), cy + Math.round(r * .3), 3, T.card);
        System.drawWideLine(cx + Math.round(r * .12), cy - Math.round(r * .4),
                            cx - Math.round(r * .18), cy + Math.round(r * .35), 3, T.card);
    }
}

// ---- app -----------------------------------------------------------------
A.run({
    main: function (c) {
        var h = A.widgets.header("Batata Quente", { full: c.full,
            actions: [{ icon: "info", id: "ajuda" }] });
        if (h.back) { led(0, 0, 0); return A.BACK; }
        if (h.action === "ajuda") return "ajuda";
        if (!gate(c.full)) return;

        me = A.mesh.me();
        var now = c.now;
        A.mesh.each(onMesh);
        tick(now);

        if (state === LOBBY) {
            var nOut = othersCount();
            var canStart = nOut >= 1;
            // o disabled do botao so repinta no quadro total: invalida na troca
            if (canStart !== startReady) { startReady = canStart; UI.invalidate(); }
            // bloco de texto EMPILHADO pela altura que o UI.text devolve: os
            // offsets fixos (r.y, +22, +44) eram do vidro pequeno e no 4848 —
            // onde a fonte title tem 28 px virtuais — o paragrafo caia em cima
            // do titulo e a segunda legenda em cima da primeira
            A.style.card(8, 40, 224, 124, { full: c.full, draw: function (r) {
                custom("pot", r.x, r.y - 2, 64, 70, "l" + (nOut + 1), c.full,
                       function (x, y, w2, h2) { drawPotato(x + 30, y + 32, 26, false); });
                var ty = r.y;
                ty += UI.text("Roda de " + (nOut + 1), r.x + 66, ty,
                              { role: "body", bg: r.bg, w: r.w - 66, lines: 1, id: "sala" }) + 3;
                ty += UI.text("Abram o app nos aparelhos com rádio", r.x + 66, ty,
                              { role: "caption", color: T.textDim, bg: r.bg, w: r.w - 66,
                                lines: 2, id: "sala2" }) + 3;
                UI.text("O pavio é secreto: só quem segura sabe quanto falta.",
                        r.x + 66, ty, { role: "caption", color: T.textDim,
                                        bg: r.bg, w: r.w - 66, lines: 3, id: "sala3" });
            }});
            A.list.view("roda", 8, 170, 224, 96, roundList.rows(),
                        { row: 38, panel: true, rowR: 7 });
            if (A.style.button("Começar", 8, 272, 224, 40,
                               { icon: "play", disabled: !canStart })) startRound();
        } else if (state === GAME && holding) {
            var frac = fuse / 25000;
            if (frac > 1) frac = 1;
            if (frac < 0) frac = 0;
            var ready = now - heldAt >= 800;
            if (ready !== passReady) { passReady = ready; UI.invalidate(); }
            A.style.card(8, 44, 224, 190, { full: c.full, draw: function (r) {
                custom("meupot", r.x, r.y + 4, r.w, 120, "h" + Math.floor(fuse / 200), c.full,
                       function (x, y, w2, h2) {
                           drawPotato(120, y + 56, 44, false);
                           // o pavio: mecha saindo do topo com a faísca
                           System.drawWideLine(120, y + 12, 132, y + 2, 2, T.textDim);
                           System.fillSmoothCircle(136, y + 1, 3, T.warn);
                           System.fillSmoothCircle(136, y + 1, 1, System.mixColor(T.warn, T.text, 60));
                       });
                A.widgets.ring(120, r.y + 64, 60, frac, { th: 6, bg: T.raised,
                    color: frac < 0.25 ? T.err : T.accent });
                UI.text("A BATATA ESTÁ COM VOCÊ!", 120, r.y + 138,
                        { role: "title", align: "center", color: T.warn, w: r.w, lines: 1, id: "st" });
                UI.text("pavio: " + Math.ceil(fuse / 1000) + " s · passe rápido",
                        120, r.y + 160, { role: "caption", align: "center", color: T.textDim,
                                          w: r.w, lines: 1, id: "fuse" });
            }});
            if (A.style.button("Passar!", 8, 248, 224, 60,
                               { icon: "play", bg: T.err, textColor: 0xFFFF,
                                 disabled: !ready })) pass();
        } else if (state === GAME) {
            A.style.card(8, 44, 224, 60, { full: c.full, draw: function (r) {
                A.icons.draw("heart", r.x, r.y + 2, 20, { color: T.err });
                UI.text(transit ? "Voando para " + nameOf(transit.to) + "..."
                                : holder ? "Batata com " + nameOf(holder) : "Batata no ar...",
                        120, r.y + 4, { role: "title", align: "center", w: r.w, bg: r.bg, id: "st" });
                UI.text("toque Passar quando ela chegar", 120, r.y + 26,
                        { role: "caption", align: "center", color: T.textDim, bg: r.bg,
                          w: r.w, lines: 1, id: "st2" });
            }});
            A.list.view("roda", 8, 112, 224, 152, roundList.rows(),
                        { row: 38, panel: true, rowR: 7 });
        } else {
            var eu = loser === me.id;
            A.style.card(8, 44, 224, 96, { full: c.full, draw: function (r) {
                drawPotato(r.x + 34, r.y + 34, 26, true);
                UI.text(eu ? "BUM! Você queimou" : nameOf(loser) + " queimou!",
                        120, r.y + 8, { role: "title", align: "center",
                                       color: eu ? T.err : T.ok, w: r.w, bg: r.bg, id: "st" });
                UI.text(eu ? "O pavio acabou na sua mão" : "A batata estourou na mão de " + nameOf(loser),
                        120, r.y + 30, { role: "caption", align: "center", color: T.textDim,
                                        bg: r.bg, w: r.w, lines: 1, id: "st2" });
                UI.text("nova rodada em " + Math.max(0, 5 - Math.floor((now - overAt) / 1000)) + " s",
                        120, r.y + 62, { role: "caption", align: "center", color: T.textDim,
                                        bg: r.bg, w: r.w, lines: 1, id: "st3" });
            }});
            A.list.view("roda", 8, 148, 224, 164, roundList.rows(),
                        { row: 38, panel: true, rowR: 7 });
        }
    },
    ajuda: function (c) {
        var h = A.widgets.header("Como jogar", { full: c.full });
        if (h.back) return A.BACK;
        A.style.card(8, 48, 224, 252, { full: c.full, draw: function (r) {
            UI.text("Abra a Batata Quente em 2 ou mais aparelhos com a malha ligada.",
                    r.x, r.y, { w: r.w, lines: 3, bg: r.bg });
            UI.text("Um toca Começar: a batata nasce na mão dele com um pavio secreto de 12 a 25 s.",
                    r.x, r.y + 48, { w: r.w, lines: 3, bg: r.bg });
            UI.text("Quem está com ela toca Passar!: o pavio viaja junto e os bipes aceleram.",
                    r.x, r.y + 96, { w: r.w, lines: 3, role: "caption", color: T.textDim, bg: r.bg });
            UI.text("Sem confirmação em 3,5 s o passe é reenviado; após 3 tentativas a batata volta.",
                    r.x, r.y + 144, { w: r.w, lines: 4, role: "caption", color: T.textDim, bg: r.bg });
            UI.text("Quem estiver segurando quando estourar queima. O placar fica na roda.",
                    r.x, r.y + 204, { w: r.w, lines: 3, role: "caption", color: T.accent, bg: r.bg });
        }});
    }
}, "main");
