// Pong Duplo — um Pong que atravessa DUAS telas pelo Celer Link (API 30+;
// pareamento por codigo). Coloque dois CelerOS lado a lado: a bola sai pelo
// topo de uma tela e entra pelo topo da outra, espelhada. Cada um defende a
// sua base; 5 pontos vencem. Um aparelho hospeda (mostra o codigo de 6
// digitos), o outro entra e digita o codigo.
//
// Porte para a familia CelerGame (core + fx + ui): cenas menu/host/scan/
// play/end com transicoes, pause, fim de jogo, particulas e sons de tabela.
// O protocolo do link continua o mesmo (par-a-par, mensagens pequenas):
//   {t:"b", x, vx, vy}   a bola cruzou para o seu lado (x em milesimos)
//   {t:"p"}              errei: ponto seu
//   {t:"s"}              saque: vou sacar daqui a pouco (so informativo)
// O "Piloto automatico" defende sozinho (bom para demonstracao e treino)
// e fica salvo no NVS do aparelho.

var E = require("celeros.game");       // familia CelerGame: core + fx + ui
require("celeros.game.fx");
require("celeros.game.ui");

E.init({ dir: "Pong Duplo", fps: 60, save: "pong." });

var T = E.theme, W = E.W, H = E.H, U = E.U;
var hasLink = typeof CelerLink !== "undefined";

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
    if (hasLink) CelerLink.send({ t: "s" });
    E.fx.ring(ball.x, ball.y, { r0: R, speed: E.u(90), color: T.accent, life: 0.35 });
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
        mine++;
        waitT = 0;
        pointFx(true, W / 2);
        if (mine >= WIN) finish(true);
    }
}

// ------------------------------------------------------------ fisica ------

function wallFx() {
    E.fx.burst(ball.x, ball.y, { n: 4, color: T.stroke, speed: E.u(50),
                                 life: 0.25, size: 1 });
}

function missBall() {
    var bx = ball ? ball.x : padX;
    ball = null;
    theirs++;
    waitT = 0;
    if (hasLink) CelerLink.send({ t: "p" });
    pointFx(false, bx);
    if (theirs >= WIN) { finish(false); return; }
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
        wallFx();
    } else if (ball.x > W - R) {
        ball.x = W - R;
        ball.vx = -Math.abs(ball.vx);
        wallFx();
    }

    // rebote na raquete (a bola desce e encosta na face de cima)
    if (ball.vy > 0 && ball.y + R >= PAD_Y && ball.y + R <= PAD_Y + PAD_H + E.u(6) &&
        Math.abs(ball.x - padX) <= PAD_W / 2 + R) {
        ball.vy = -Math.min(MAX_VY * U, Math.abs(ball.vy) * 1.07);
        ball.vx += (ball.x - padX) * 3;
        E.fx.burst(ball.x, PAD_Y, { n: 9, color: T.accent, speed: E.u(70),
                                    speed2: E.u(30), life: 0.35,
                                    size: Math.max(1, E.u(2)) });
        E.audio.sfx("hit");
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

// ------------------------------------------------------------ desenho -----

function drawMatchHud(scene) {
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
    scene.btnPause = E.gfx.button("II", W - E.u(40), E.u(8), E.u(30), E.u(28),
                                  { primary: false, screen: true });
}

function drawField() {
    var dash = E.u(8), gap = E.u(16), dh = Math.max(1, E.u(2));
    for (var x = E.u(4); x < W; x += gap) {
        E.gfx.rect(x, TOP, Math.min(dash, W - x), dh, T.stroke);
    }
    E.gfx.rect(padX - PAD_W / 2, PAD_Y, PAD_W, PAD_H, T.accent,
               { r: Math.max(2, Math.round(PAD_H / 2)) });
    if (ball) {
        E.gfx.circle(ball.x, ball.y, R, T.text, { smooth: true });
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
    rescanBtn = E.gfx.button("Procurar de novo", E.u(12), H - E.u(50),
                             E.u(116), E.u(36), { primary: false });
    backBtn = E.gfx.button("Voltar", W - E.u(128), H - E.u(50),
                           E.u(116), E.u(36), { primary: false });
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

// ------------------------------------------------------------- cenas ------

var scenes = {
    menu: {
        enter: function () {
            E.dirty.enable(T.bg);
            E.clearTimers();
            help = null;
        },
        exit: function () {
            E.dirty.off();
            help = null;
        },
        draw: function () {
            // dialogo "Como jogar": texto datilografado (cena nao-static)
            if (help) {
                if (!help.draw(E.u(20), E.u(84), E.u(200))) help = null;
                return;
            }

            var act = E.ui.title({
                game: "PONG DUPLO",
                subtitle: "duas telas, um jogo",
                start: "Hospedar",
                extra: "Como jogar"
            });
            // o titulo sempre desenha o botao "start": aqui o menu ocupa o
            // lugar dele (primeira opcao em cima, "Entrar" logo abaixo)
            E.gfx.rect(E.u(30), E.u(156), E.u(180), E.u(50), T.bg);
            var pick = E.ui.menu(["Hospedar", "Entrar"],
                                 { y: E.u(116), row: E.u(44), w: E.u(170) });

            var ab = E.gfx.button("AUTO", E.u(196), E.u(228), E.u(40), E.u(28),
                                  { primary: auto });
            if (E.hit(ab)) {
                auto = !auto;
                E.save.set("auto", auto ? "1" : "0");
                E.audio.sfx("ui");
            }
            E.gfx.text(auto ? "ligado" : "desligado", W - E.u(4), E.u(258),
                       { ts: "tiny", align: "right", color: T.textDim });

            if (!hasLink) {
                E.gfx.text("Sem Bluetooth neste firmware", W / 2, E.u(276),
                           { ts: "small", align: "center", color: T.warn, fit: W - 20 });
            } else if (note) {
                E.gfx.text(note, W / 2, E.u(276),
                           { ts: "small", align: "center", color: T.warn, fit: W - 20 });
            } else {
                E.gfx.text("5 pontos vencem", W / 2, E.u(276),
                           { ts: "small", align: "center", color: T.textDim });
            }

            var sb = E.gfx.button("Sair", W / 2 - E.u(35), H - E.u(30),
                                  E.u(70), E.u(22), { primary: false });
            if (E.hit(sb)) System.exitApp();

            // prioridade do menu: o start do titulo fica por baixo dos itens
            if (pick === "Hospedar") { startHost(); return; }
            if (pick === "Entrar") { startScan(); return; }
            if (act === "start") { startHost(); return; }   // faixa de 4 px
            if (act === "extra") {
                help = E.ui.dialog(HELP, { name: "Como jogar", speed: 45 });
            }
        }
    },

    host: {
        static: true,
        enter: function () {
            role = ROLE_HOST;
            resetMatch();
            E.clearTimers();
            this._key = "";
            this.btnCancel = null;
            if (hasLink) CelerLink.start(null, { pairing: true });
        },
        update: function () {
            if (!hasLink) {
                E.goto("menu", { transition: "fade", ms: 300 });
                return;
            }
            var st = CelerLink.status();
            var key = (st.name || "") + "|" +
                      (st.pairing ? (st.code || "?") : "") + "|" +
                      (st.connected ? "1" : "0");
            if (key !== this._key) {
                this._key = key;
                E.redraw();
            }
            if (st.connected) {
                E.goto("play", { transition: "fade", ms: 300 });
                return;
            }
            if (this.btnCancel && E.hit(this.btnCancel)) {
                leaveLink();
                note = "";
                E.audio.sfx("back");
                E.goto("menu", { transition: "fade", ms: 300 });
            }
        },
        draw: function () {
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
            this.btnCancel = E.gfx.button("Cancelar", W / 2 - E.u(85), H - E.u(64),
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
        enter: function () {
            E.dirty.enable(T.bg);
            this.static = false;
            this.btnPause = null;
            paused = false;
            waitT = 0;
            E.clearTimers();
            serveTimer = null;
            if (role === ROLE_HOST) scheduleServe(1500);
        },
        exit: function () {
            E.clearTimers();
            serveTimer = null;
            E.dirty.off();
            paused = false;
            this.static = false;
        },
        update: function (dt) {
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

            if (paused) {
                if (!this.static) {
                    this.static = true;
                    E.redraw();
                }
                return;
            }
            this.static = false;

            if (this.btnPause && E.hit(this.btnPause)) {
                paused = true;
                this.static = true;
                E.redraw();
                return;
            }
            if (E.input.down && E.input.y > TOP) padX = E.input.x;
            physics(dt);
        },
        draw: function () {
            drawMatchHud(this);
            drawField();
            E.fx.draw();

            if (paused) {
                var act = E.ui.pause({ labels: ["Continuar", "Recomecar", "Sair"] });
                if (act === "resume") {
                    paused = false;
                    this.static = false;
                    E.dirty.full();
                    E.redraw();
                } else if (act === "restart") {
                    resetMatch();
                    E.dirty.full();
                    E.redraw();
                    if (role === ROLE_HOST) scheduleServe(1200);
                } else if (act === "quit") {
                    leaveLink();
                    E.audio.sfx("back");
                    E.goto("menu", { transition: "fade", ms: 300 });
                }
            }
        }
    },

    end: {
        static: true,
        enter: function () {
            E.clearTimers();
            serveTimer = null;
        },
        update: function () {
            if (!hasLink) return;
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
            }
        },
        draw: function () {
            var act = E.ui.gameOver({
                title: won ? "Você venceu!" : "Você perdeu",
                score: mine,
                labels: ["Revanche", "Sair"]
            });
            E.gfx.text("Adversário: " + theirs, W / 2, E.u(150),
                       { ts: "small", align: "center", color: T.textDim, screen: true });
            if (act === "again") {
                resetMatch();
                E.audio.sfx("ok");
                E.goto("play", { transition: "fade", ms: 350 });
            } else if (act === "quit") {
                leaveLink();
                E.audio.sfx("back");
                E.goto("menu", { transition: "fade", ms: 300 });
            }
        }
    }
};

// expoe o estado para testes/CI; no aparelho __harness nao existe
if (typeof __harness !== "undefined") {
    __harness.pong = {
        E: E,
        state: function () {
            return { scene: E.sceneName, role: role, mine: mine, theirs: theirs,
                     auto: auto, paused: paused, over: over, hasLink: hasLink };
        }
    };
}

E.run(scenes, "menu");
