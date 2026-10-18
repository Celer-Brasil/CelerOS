// Pong Duplo — um Pong que atravessa DUAS telas pelo Celer Link (API 30+;
// pareamento por codigo). Coloque dois CelerOS lado a lado: a bola sai pelo
// topo de uma tela e entra pelo topo da outra, espelhada. Cada um defende a
// sua base; 5 pontos vencem. Um aparelho hospeda (mostra o codigo de 6
// digitos), o outro entra e digita o codigo.
//
// 2.1.0: vitrine do CelerGame 1.4 — o fluxo menu/host/scan/play/end e uma
// maquina de estados (E.fsm) com a pausa EMPILHADA (push/pop); a raquete e
// os botoes de menu usam o pad multitoque (E.pad.stick/button), com o
// toque/arrasto antigo como fallback; ponto/saque/rebote passam pelo
// E.events (som e particulas ouvem sem a fisica conhecer o desenho); e a
// quadra ganha o fundo gerado por IA (ai_bg.png) via E.spr.sheet/stamp,
// mantendo o fundo liso quando o firmware nao tem slot de sprite.
//
// O protocolo do link continua o mesmo (par-a-par, mensagens pequenas):
//   {t:"b", x, vx, vy}   a bola cruzou para o seu lado (x em milesimos)
//   {t:"p"}              errei: ponto seu
//   {t:"s"}              saque: vou sacar daqui a pouco (so informativo)
// O "Piloto automatico" defende sozinho (bom para demonstracao e treino)
// e fica salvo no NVS do aparelho.

var E = require("celeros.game");       // familia CelerGame: core + modulos
require("celeros.game.fx");
require("celeros.game.ui");
require("celeros.game.pad");
require("celeros.game.fsm");
require("celeros.game.events");
require("celeros.game.spr");

E.init({ dir: "Pong Duplo", fps: 60, save: "pong.",
         bases: ["/local/apps/Pong Duplo/", "/sd/apps/Pong Duplo/"] });

var T = E.theme, W = E.W, H = E.H, U = E.U;
var hasLink = typeof CelerLink !== "undefined";
var SMOOTH = E.caps.smooth;   // anti-alias de circulo quando o firmware tem

// fundo da quadra gerado por IA (pacote flat: o PNG fica na raiz do app).
// Sem slot real (firmware velho) o stamp falha e a camada suja segue com o
// fundo liso de sempre.
E.spr.sheet("aibg", { file: "ai_bg", w: 256, h: 256,
                      regions: { bg: [0, 0, 256, 256] } });
var aiBg = E.spr.backed("bg");

// campo na mesma proporcao do Pong original (240x320 de projeto)
var TOP = E.u(44), BOT = E.u(316);
var PAD_Y = E.u(292), PAD_W = E.u(56), PAD_H = Math.max(4, E.u(8));
var R = Math.max(3, E.u(5));
var SERVE_SPEED = 170, MAX_VY = 420, WIN = 5;

var ROLE_HOST = 1, ROLE_GUEST = 2;

var role = 0;
var mine = 0, theirs = 0;
var padX = W / 2;
var ball = null;            // {x, y, vx, vy} quando a bola esta do nosso lado
var aimErr = 0;             // piloto: desvio da mira sorteado a cada bola
var waitT = 0;              // tempo sem bola (dica na tela)
var paused = false;
var over = false;
var won = false;
var note = "";
var serveTimer = null;

var auto = E.save.get("auto", "");
if (auto === "") {
    // migracao do Storage.get("auto") da versao anterior
    auto = (typeof Storage !== "undefined" && Storage.get("auto", "0") === "1") ? "1" : "0";
}
auto = auto === "1";

var peers = [];
var peerList = null;
var scanning = false;
var sel = null;
var backBtn = null, rescanBtn = null;
var help = null;

// controles do pad (os botoes nascem presos a cena; o stick e global)
var F = { host: null, join: null, quit: null, again: null, exit: null };
var stick = null;

// retangulos do layout (o toque/arrasto puro continua valendo como fallback)
var MENU_W = E.u(170), MENU_H = E.u(40);
var MENU_X = Math.round((W - MENU_W) / 2);
var R_HOST = { x: MENU_X, y: E.u(116), w: MENU_W, h: MENU_H };
var R_JOIN = { x: MENU_X, y: E.u(160), w: MENU_W, h: MENU_H };
var R_QUIT = { x: Math.round(W / 2 - E.u(35)), y: H - E.u(30), w: E.u(70), h: E.u(22) };
var END_BW = E.u(180), END_BH = E.u(36);
var END_BX = Math.round((W - END_BW) / 2);
var END_BY = Math.round(H * 0.60);
var END_GAP = E.u(40);
var R_AGAIN = { x: END_BX, y: END_BY, w: END_BW, h: END_BH };
var R_EXIT = { x: END_BX, y: END_BY + END_GAP, w: END_BW, h: END_BH };

var HELP = "Coloque dois CelerOS lado a lado. Um hospeda e mostra um código de 6 dígitos; " +
           "o outro entra e digita esse código. A bola sai pelo topo de uma tela e entra " +
           "pelo topo da outra. Cada um defende a base de baixo: 5 pontos vencem. Arraste " +
           "o dedo para mover a raquete. O piloto automático defende sozinho.";

// sons de tabela (hit no rebote, score no ponto, win na vitoria)
E.audio.sfxTable.hit = [[880, 22]];
E.audio.sfxTable.score = [[200, 120]];
E.audio.sfxTable.win = [[660, 90], [880, 90], [1320, 220]];

// ------------------------------------------------------------ estado ------

function resetMatch() {
    mine = 0;
    theirs = 0;
    ball = null;
    padX = W / 2;
    aimErr = 0;
    waitT = 0;
    over = false;
    paused = false;
    if (serveTimer) { E.cancel(serveTimer); serveTimer = null; }
}

function leaveLink() {
    if (!hasLink) return;
    try {
        CelerLink.disconnect();
        CelerLink.stop();
    } catch (e) {}
}

function scheduleServe(ms) {
    if (serveTimer) E.cancel(serveTimer);
    serveTimer = E.after(ms, serve);
}

function serve() {
    serveTimer = null;
    if (E.sceneName !== "play" || over) return;
    var dir = Math.random() < 0.5 ? -1 : 1;
    ball = {
        x: W / 2,
        y: E.u(200),
        vx: dir * (E.u(40) + Math.random() * E.u(60)),
        vy: -SERVE_SPEED * U
    };
    aimErr = 0;
    waitT = 0;
    E.emit("saque", { x: ball.x, y: ball.y });
}

function pointFx(byMe, x) {
    E.fx.ring(x, BOT, { r0: R, speed: E.u(140), color: byMe ? T.ok : T.err, life: 0.5 });
    E.fx.flash(byMe ? T.ok : T.err, 170);
    E.fx.popText(W / 2 + (byMe ? -E.u(34) : E.u(34)), E.u(30), "+1",
                 { color: byMe ? T.ok : T.warn, px: Math.max(9, E.u(12)),
                   screen: true, life: 0.8 });
    E.audio.sfx("score");
}

function finish(victory) {
    if (over) return;
    over = true;
    paused = false;
    won = victory;
    if (serveTimer) { E.cancel(serveTimer); serveTimer = null; }
    E.audio.sfx(victory ? "win" : "over");
    E.goto("end", { transition: "wipe", ms: 350, dir: "up" });
}

// ------------------------------------------------------------- link -------

function onLinkPlay(raw) {
    var o;
    try { o = JSON.parse(raw); } catch (e) { return; }
    if (!o || !o.t || over) return;
    if (o.t === "b") {
        // entra pelo topo, espelhada: o "x" de la e o (W - x) daqui
        ball = {
            x: W - o.x * W / 1000,
            y: TOP + R,
            vx: -o.vx * U,
            vy: Math.abs(o.vy) * U
        };
        aimErr = (Math.random() - 0.5) * E.u(100);
        waitT = 0;
        E.fx.ring(ball.x, TOP, { r0: R, speed: E.u(70), color: T.textDim, life: 0.3 });
    } else if (o.t === "p") {
        E.emit("ponto", { byMe: true, x: W / 2 });
    }
}

// ------------------------------------------------------------ fisica ------

function missBall() {
    var bx = ball ? ball.x : padX;
    ball = null;
    waitT = 0;
    if (hasLink) CelerLink.send({ t: "p" });
    E.emit("ponto", { byMe: false, x: bx });
    if (over) return;
    scheduleServe(1200);   // quem perdeu o ponto saca
}

function physics(dt) {
    if (over) return;
    if (auto) {
        var target = ball ? ball.x + aimErr : W / 2;
        var step = E.u(150) * dt;   // piloto com limite de velocidade
        padX += Math.max(-step, Math.min(step, target - padX));
    }
    if (padX < PAD_W / 2) padX = PAD_W / 2;
    if (padX > W - PAD_W / 2) padX = W - PAD_W / 2;
    if (!ball) { waitT += dt; return; }
    waitT = 0;

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    if (ball.x < R) {
        ball.x = R;
        ball.vx = Math.abs(ball.vx);
        E.emit("rebote", { x: ball.x, y: ball.y, wall: true });
    } else if (ball.x > W - R) {
        ball.x = W - R;
        ball.vx = -Math.abs(ball.vx);
        E.emit("rebote", { x: ball.x, y: ball.y, wall: true });
    }

    // rebote na raquete (a bola desce e encosta na face de cima)
    if (ball.vy > 0 && ball.y + R >= PAD_Y && ball.y + R <= PAD_Y + PAD_H + E.u(6) &&
        Math.abs(ball.x - padX) <= PAD_W / 2 + R) {
        ball.vy = -Math.min(MAX_VY * U, Math.abs(ball.vy) * 1.07);
        ball.vx += (ball.x - padX) * 3;
        E.emit("rebote", { x: ball.x, y: PAD_Y, wall: false });
    }

    if (ball.y < TOP) {
        if (hasLink) {
            CelerLink.send({
                t: "b",
                x: Math.round(ball.x * 1000 / W),
                vx: Math.round(ball.vx / U),
                vy: Math.round(ball.vy / U)
            });
        }
        ball = null;
        waitT = 0;
    } else if (ball.y > BOT) {
        missBall();
    }
}

// ----------------------------------------------------------- eventos ------
// A fisica so avisa; som e particulas ficam nos ouvintes (E.events).
E.on("rebote", function (o) {
    if (o.wall) {
        E.fx.burst(o.x, o.y, { n: 4, color: T.stroke, speed: E.u(50),
                               life: 0.25, size: 1 });
    } else {
        E.fx.burst(o.x, o.y, { n: 9, color: T.accent, speed: E.u(70),
                               speed2: E.u(30), life: 0.35,
                               size: Math.max(1, E.u(2)) });
        E.audio.sfx("hit");
    }
});

E.on("saque", function (o) {
    if (hasLink) CelerLink.send({ t: "s" });
    E.fx.ring(o.x, o.y, { r0: R, speed: E.u(90), color: T.accent, life: 0.35 });
});

E.on("ponto", function (o) {
    if (o.byMe) mine++; else theirs++;
    waitT = 0;
    pointFx(o.byMe, o.x);
    if ((o.byMe ? mine : theirs) >= WIN) finish(o.byMe);
});

// ------------------------------------------------------------ desenho -----

function drawMatchHud(m) {
    E.gfx.rect(0, 0, W, TOP, T.card, { screen: true });
    E.gfx.text(String(mine), W / 2 - E.u(34), E.u(5),
               { ts: "big", align: "center", color: T.accent, screen: true });
    E.gfx.text("×", W / 2, E.u(9),
               { ts: "body", align: "center", color: T.textDim, screen: true });
    E.gfx.text(String(theirs), W / 2 + E.u(34), E.u(5),
               { ts: "big", align: "center", color: T.text, screen: true });
    E.gfx.text("VOCÊ", W / 2 - E.u(34), E.u(28),
               { ts: "tiny", align: "center", color: T.textDim, screen: true });
    E.gfx.text("OPONENTE", W / 2 + E.u(34), E.u(28),
               { ts: "tiny", align: "center", color: T.textDim, screen: true });
    m.data.btnPause = E.gfx.button("II", W - E.u(40), E.u(8), E.u(30), E.u(28),
                                   { primary: false, screen: true });
}

function drawCourtBg() {
    if (!aiBg) return;   // sem slot: fica o fundo liso da camada suja
    E.spr.stamp("bg", 0, 0, { scale: E.W / 256, key: null });
    E.spr.stamp("bg", 0, E.W, { scale: E.W / 256, key: null });
}

function drawField() {
    drawCourtBg();
    var dash = E.u(8), gap = E.u(16), dh = Math.max(1, E.u(2));
    for (var x = E.u(4); x < W; x += gap) {
        E.gfx.rect(x, TOP, Math.min(dash, W - x), dh, T.stroke);
    }
    E.gfx.rect(padX - PAD_W / 2, PAD_Y, PAD_W, PAD_H, T.accent,
               { r: Math.max(2, Math.round(PAD_H / 2)) });
    if (ball) {
        E.gfx.circle(ball.x, ball.y, R, T.text, { smooth: SMOOTH });
        E.gfx.circle(ball.x - R * 0.3, ball.y - R * 0.3,
                     Math.max(1, R * 0.35), T.accent);
    } else if (waitT > 0.7) {
        E.gfx.text("aguardando a bola...", W / 2, H / 2,
                   { ts: "small", align: "center", color: T.textDim });
    }
}

function drawScan() {
    E.gfx.text("Entrar numa partida", W / 2, E.u(14),
               { ts: "label", align: "center", color: T.text, fit: W - 24 });
    if (scanning) {
        E.gfx.text("Procurando...", W / 2, E.u(130),
                   { ts: "body", align: "center", color: T.textDim });
    } else if (!peers.length) {
        E.gfx.text("Ninguém hospedando por perto.", W / 2, E.u(120),
                   { ts: "body", align: "center", color: T.textDim, fit: W - 30 });
    } else if (peerList) {
        sel = peerList.draw(E.u(12), E.u(50), W - E.u(24),
                            H - E.u(50) - E.u(58));
    }
    rescanBtn = E.gfx.button("Procurar", E.u(12), H - E.u(50),
                             E.u(100), E.u(36), { primary: false });
    backBtn = E.gfx.button("Voltar", W - E.u(112), H - E.u(50),
                           E.u(100), E.u(36), { primary: false });
}

// tap do pad OU o toque seco no mesmo rect (fallback de firmware/tela
// sem o pad multitoque)
function padHit(b, r) {
    return !!(b && b.tap) || E.hit(r);
}

// ------------------------------------------------------------- acoes ------

function startHost() {
    if (!hasLink) {
        note = "Sem Bluetooth neste firmware";
        E.audio.sfx("bad");
        return;
    }
    E.audio.sfx("ok");
    note = "";
    role = ROLE_HOST;
    resetMatch();
    E.goto("host", { transition: "fade", ms: 350 });
}

function startScan() {
    if (!hasLink) {
        note = "Sem Bluetooth neste firmware";
        E.audio.sfx("bad");
        return;
    }
    E.audio.sfx("ok");
    note = "";
    E.goto("scan", { transition: "fade", ms: 350 });
}

function doScan() {
    if (!hasLink || E.sceneName !== "scan") return;
    peers = CelerLink.scan(2500) || [];
    scanning = false;
    if (peers.length) {
        var items = [];
        for (var i = 0; i < peers.length; i++) {
            items.push({
                label: peers[i].name + "   " + peers[i].rssi + " dBm",
                value: peers[i].id
            });
        }
        peerList = E.ui.list({ items: items, row: E.u(44) });
    } else {
        peerList = null;
    }
}

function tryConnect(id) {
    if (!hasLink || !id) return;
    if (!CelerLink.connect(id)) {
        System.toast("Não conectou");
        E.audio.sfx("bad");
        return;
    }
    // codigo de 6 digitos da tela do outro (ate 3 tentativas — o anfitriao
    // derruba na 3a errada)
    var tries = 0;
    while (CelerLink.status().pairing && tries < 3) {
        var c = System.prompt("Código na tela do outro", "", { hint: "num" });
        if (!c) break;
        tries++;
        if (!CelerLink.verify(c)) System.toast("Código errado");
    }
    if (CelerLink.status().connected) {
        role = ROLE_GUEST;
        resetMatch();
        E.audio.sfx("ok");
        E.goto("play", { transition: "fade", ms: 350 });
    } else {
        CelerLink.disconnect();
        note = "Pareamento recusado";
        E.audio.sfx("bad");
        E.goto("menu", { transition: "fade", ms: 300 });
    }
}

// ------------------------------------------------------------- fsm --------
// menu -> host -> scan -> play -> end; a pausa e empilhada por cima do play
// (push/pop) e o estado de baixo volta com resume, sem reiniciar o jogo.

var states = {
    menu: {
        enter: function () {
            E.dirty.enable(T.bg);
            E.clearTimers();
            help = null;
            F.host = E.pad.button({ x: R_HOST.x, y: R_HOST.y, w: R_HOST.w, h: R_HOST.h,
                                    label: "Hospedar" });
            F.join = E.pad.button({ x: R_JOIN.x, y: R_JOIN.y, w: R_JOIN.w, h: R_JOIN.h,
                                    label: "Entrar" });
            F.quit = E.pad.button({ x: R_QUIT.x, y: R_QUIT.y, w: R_QUIT.w, h: R_QUIT.h,
                                    label: "Sair" });
        },
        exit: function () {
            E.dirty.off();
            help = null;
        },
        update: function () {
            if (help) return;   // o dialogo trata os proprios toques no draw
            if (padHit(F.host, R_HOST)) { startHost(); return; }
            if (padHit(F.join, R_JOIN)) { startScan(); return; }
            if (padHit(F.quit, R_QUIT)) { System.exitApp(); return; }
        },
        draw: function () {
            // dialogo "Como jogar": texto datilografado (cena nao-static)
            if (help) {
                if (!help.draw(E.u(20), E.u(84), E.u(200))) help = null;
                return;
            }

            E.ui.title({ game: "PONG DUPLO", subtitle: "duas telas, um jogo", start: null });

            // "Como jogar" no lugar de sempre (o titulo nao desenha botoes)
            var eb = E.gfx.button("Como jogar", E.u(45), E.u(214), E.u(150), E.u(36),
                                  { primary: false, screen: true });

            // Hospedar/Entrar/Sair vem do pad (multitoque, desenhados aqui)
            E.pad.draw();

            var ab = E.gfx.button(auto ? "AUTO: ON" : "AUTO: OFF",
                                  E.u(30), E.u(258), E.u(90), E.u(24),
                                  { primary: auto });
            if (E.hit(ab)) {
                auto = !auto;
                E.save.set("auto", auto ? "1" : "0");
                E.audio.sfx("ui");
            }

            if (!hasLink) {
                E.gfx.text("Sem Bluetooth neste firmware", W - E.u(4), E.u(268),
                           { ts: "small", align: "right", color: T.warn, fit: W - E.u(130) });
            } else if (note) {
                E.gfx.text(note, W - E.u(4), E.u(268),
                           { ts: "small", align: "right", color: T.warn, fit: W - E.u(130) });
            } else {
                E.gfx.text("5 pontos vencem", W - E.u(4), E.u(268),
                           { ts: "small", align: "right", color: T.textDim });
            }

            if (E.hit(eb)) help = E.ui.dialog(HELP, { name: "Como jogar", speed: 45 });
        }
    },

    host: {
        enter: function (m) {
            role = ROLE_HOST;
            resetMatch();
            E.clearTimers();
            m.data.key = "";
            m.data.btnCancel = null;
            if (hasLink) CelerLink.start(null, { pairing: true });
        },
        update: function (m) {
            if (!hasLink) {
                E.goto("menu", { transition: "fade", ms: 300 });
                return;
            }
            var st = CelerLink.status();
            var key = (st.name || "") + "|" +
                      (st.pairing ? (st.code || "?") : "") + "|" +
                      (st.connected ? "1" : "0");
            if (key !== m.data.key) {
                m.data.key = key;
                E.redraw();
            }
            if (st.connected) {
                E.goto("play", { transition: "fade", ms: 300 });
                return;
            }
            if (m.data.btnCancel && E.hit(m.data.btnCancel)) {
                leaveLink();
                note = "";
                E.audio.sfx("back");
                E.goto("menu", { transition: "fade", ms: 300 });
            }
        },
        draw: function (m) {
            var st = hasLink ? CelerLink.status() :
                     { name: "", pairing: false, code: "", connected: false };
            System.fillScreen(T.bg);
            E.gfx.text("Esperando o adversário...", W / 2, E.u(52),
                       { ts: "title", align: "center", color: T.text, fit: W - 24 });
            E.gfx.text("Visível como " + (st.name || "CelerOS"), W / 2, E.u(90),
                       { ts: "small", align: "center", color: T.textDim, fit: W - 24 });
            if (st.pairing && st.code) {
                E.gfx.panel(W / 2 - E.u(80), E.u(122), E.u(160), E.u(96));
                E.gfx.text("CÓDIGO", W / 2, E.u(130),
                           { ts: "small", align: "center", color: T.accent });
                E.gfx.text(st.code, W / 2, E.u(150),
                           { ts: "huge", align: "center", color: T.text });
                E.gfx.text("digite no outro aparelho", W / 2, E.u(196),
                           { ts: "tiny", align: "center", color: T.textDim });
            } else {
                E.gfx.text("Aguardando o outro lado...", W / 2, E.u(160),
                           { ts: "body", align: "center", color: T.textDim });
            }
            m.data.btnCancel = E.gfx.button("Cancelar", W / 2 - E.u(85), H - E.u(64),
                                            E.u(170), E.u(40), { primary: false });
        }
    },

    scan: {
        enter: function () {
            E.dirty.enable(T.bg);
            peers = [];
            peerList = null;
            sel = null;
            scanning = true;
            backBtn = null;
            rescanBtn = null;
            E.clearTimers();
            if (!hasLink) {
                E.goto("menu", { transition: "fade", ms: 300 });
                return;
            }
            // deixa "Procurando..." aparecer antes do scan bloqueante
            E.after(250, doScan);
        },
        exit: function () {
            E.clearTimers();
            E.dirty.off();
            scanning = false;
            peerList = null;
            sel = null;
        },
        update: function () {
            if (sel) {
                var id = sel;
                sel = null;
                tryConnect(id);
                return;
            }
            if (backBtn && E.hit(backBtn)) {
                leaveLink();
                E.audio.sfx("back");
                E.goto("menu", { transition: "fade", ms: 300 });
                return;
            }
            if (rescanBtn && E.hit(rescanBtn)) {
                peers = [];
                peerList = null;
                scanning = true;
                E.clearTimers();
                E.after(250, doScan);
            }
        },
        draw: function () {
            drawScan();
        }
    },

    play: {
        enter: function (m) {
            E.dirty.enable(T.bg);
            m.data.btnPause = null;
            paused = false;
            waitT = 0;
            E.clearTimers();
            serveTimer = null;
            if (role === ROLE_HOST) scheduleServe(1500);
        },
        exit: function (m, next) {
            // empilhado pela pausa: o jogo congela (E.pause) e volta com
            // resume; so uma saida de verdade desliga a camada suja
            if (next === "pausa") return;
            E.clearTimers();
            serveTimer = null;
            E.dirty.off();
            paused = false;
        },
        resume: function () {
            // volta da pausa: o estado (bola, placar, timers) continua igual
        },
        update: function (m, dt) {
            if (hasLink) {
                var raw, guard = 0;
                while ((raw = CelerLink.poll()) !== null && guard++ < 8) {
                    onLinkPlay(raw);
                }
                if (!CelerLink.status().connected) {
                    note = "Conexão perdida";
                    leaveLink();
                    E.goto("menu", { transition: "wipe", ms: 300, dir: "left" });
                    return;
                }
            }

            if (m.data.btnPause && E.hit(m.data.btnPause)) {
                flow.push("pausa");
                return;
            }

            // raquete: o dedo dono do stick manda (multitoque); arrastar em
            // qualquer ponto da quadra continua valendo como fallback
            var f = stick && stick.finger !== null ? E.input.finger(stick.finger) : null;
            if (f && f.down) padX = f.x;
            else if (E.input.down && E.input.y > TOP) padX = E.input.x;

            physics(dt);
        },
        draw: function (m) {
            drawField();
            drawMatchHud(m);
            E.fx.draw();
            E.pad.draw();
        }
    },

    pausa: {
        enter: function () {
            paused = true;
            E.pause(true);
            E.dirty.full();
            E.redraw();
        },
        exit: function () {
            E.pause(false);
            paused = false;
            E.dirty.full();
            E.redraw();
        },
        draw: function (m) {
            // o play continua congelado embaixo (fx e timers parados)
            drawField();
            drawMatchHud(m);
            E.fx.draw();
            E.pad.draw();

            var act = E.ui.pause({ labels: ["Continuar", "Recomecar", "Sair"] });
            if (act === "resume") {
                flow.pop();
            } else if (act === "restart") {
                resetMatch();
                if (role === ROLE_HOST) scheduleServe(1200);
                flow.pop();
            } else if (act === "quit") {
                leaveLink();
                E.audio.sfx("back");
                flow.pop();
                E.goto("menu", { transition: "fade", ms: 300 });
            }
        }
    },

    end: {
        enter: function () {
            E.clearTimers();
            serveTimer = null;
            F.again = E.pad.button({ x: R_AGAIN.x, y: R_AGAIN.y,
                                     w: R_AGAIN.w, h: R_AGAIN.h, label: "Revanche" });
            F.exit = E.pad.button({ x: R_EXIT.x, y: R_EXIT.y,
                                    w: R_EXIT.w, h: R_EXIT.h, label: "Sair" });
        },
        update: function () {
            if (hasLink) {
                var raw, guard = 0;
                while ((raw = CelerLink.poll()) !== null && guard++ < 8) {
                    var o;
                    try { o = JSON.parse(raw); } catch (e) { continue; }
                    // o anfitriao apertou "Revanche" e sacou: o convidado entra
                    // na partida na hora em que a bola aparece
                    if (o && o.t === "b" && role === ROLE_GUEST) {
                        resetMatch();
                        ball = {
                            x: W - o.x * W / 1000,
                            y: TOP + R,
                            vx: -o.vx * U,
                            vy: Math.abs(o.vy) * U
                        };
                        aimErr = (Math.random() - 0.5) * E.u(100);
                        E.goto("play", { transition: "fade", ms: 350 });
                        return;
                    }
                }
                if (!CelerLink.status().connected) {
                    note = "Conexão perdida";
                    leaveLink();
                    E.goto("menu", { transition: "fade", ms: 300 });
                    return;
                }
            }
            if (padHit(F.again, R_AGAIN)) {
                resetMatch();
                E.audio.sfx("ok");
                E.goto("play", { transition: "fade", ms: 350 });
            } else if (padHit(F.exit, R_EXIT)) {
                leaveLink();
                E.audio.sfx("back");
                E.goto("menu", { transition: "fade", ms: 300 });
            }
        },
        draw: function () {
            E.gfx.rect(0, 0, W, H, T.bg, { screen: true });
            E.gfx.text(won ? "Você venceu!" : "Você perdeu", W / 2, Math.round(H * 0.16),
                       { ts: "big", align: "center", color: T.err, screen: true });
            E.gfx.text("Pontos: " + mine, W / 2, Math.round(H * 0.26),
                       { ts: "title", align: "center", color: T.text, screen: true });
            E.gfx.text("Adversário: " + theirs, W / 2, E.u(150),
                       { ts: "small", align: "center", color: T.textDim, screen: true });
            E.pad.draw();
        }
    }
};

var flow = E.fsm({}, states);

// ------------------------------------------------------------- cenas ------
// Uma cena CelerGame por estado do fsm: mantem as transicoes (fade/wipe) e
// a cena static do host (o fsm avisa com E.redraw quando o codigo muda).

function makeScene(name, isStatic) {
    return {
        static: !!isStatic,
        enter: function (arg) { flow.go(name, arg); },
        update: function (dt) { flow.update(dt); },
        draw: function () { flow.draw(); }
    };
}

var scenes = {
    menu: makeScene("menu", false),
    host: makeScene("host", true),
    scan: makeScene("scan", false),
    play: makeScene("play", false),
    end: makeScene("end", false)
};

// stick global: a zona cobre a quadra e cada dedo que desce nela vira dono
// da raquete ate levantar (o mesmo dedo pode segurar o botao de pausa)
stick = E.pad.stick({ zone: { x: 0, y: TOP, w: W, h: H - TOP },
                      r: E.u(36), float: true, follow: true,
                      visible: false, global: true });

// expoe o estado para testes/CI; no aparelho __harness nao existe
if (typeof __harness !== "undefined") {
    __harness.pong = {
        E: E,
        flow: flow,
        state: function () {
            return { scene: E.sceneName, state: flow.state, role: role,
                     mine: mine, theirs: theirs, auto: auto, paused: paused,
                     over: over, hasLink: hasLink, padX: padX,
                     ball: ball ? { x: ball.x, y: ball.y } : null };
        }
    };
}

E.run(scenes, "menu");
