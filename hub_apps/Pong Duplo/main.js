// Pong Duplo 3.0 — um Pong que atravessa DUAS telas pelo Celer Link (API 30+;
// pareamento por codigo). Coloque dois CelerOS lado a lado: a bola sai pelo
// topo de uma tela e entra pelo topo da outra, espelhada. Cada um defende a
// sua base; 5 pontos vencem. Um aparelho hospeda (mostra o codigo de 6
// digitos), o outro entra e digita o codigo.
//
// 3.0 (CelerGame 1.7 + UI 1.3, ES5):
// - menu e HUD reconstruidos na UI 1.3 (tokens/preset neon, titulo, botoes
//   com icones compartilhados, chip do piloto automatico); o placar usa o
//   E.ui.hud memoizado.
// - a quadra (arte IA + linha tracejada) e gravada 1x num slot COM DONO
//   (E.slots.fit/create/gen) e a camada suja restaura so a caixa pedida.
// - particulas num E.pool desenhado com {cull:true}; E.onSleep empilha a
//   pausa quando o vidro apaga e E.onWake repinta.
// - o fluxo menu/host/scan/play/end usa as CENAS do core e a pilha
//   push/pop para a pausa (sem dep fsm); fx/pad/events/spr sairam das
//   deps — restam celeros.game e celeros.game.ui.
//
// O PROTOCOLO do Celer Link continua o mesmo (par-a-par, mensagens pequenas):
//   {t:"b", x, vx, vy}   a bola cruzou para o seu lado (x em milesimos)
//   {t:"p"}              errei: ponto seu
//   {t:"s"}              saque: vou sacar daqui a pouco (so informativo)
// O "Piloto automatico" defende sozinho e fica salvo no NVS do aparelho.

var E = require("celeros.game");
require("celeros.game.ui");

E.init({ dir: "Pong Duplo", fps: 60, save: "pong.", keepAwake: false,
         bases: ["/local/apps/Pong Duplo/", "/sd/apps/Pong Duplo/"] });

var T = E.theme, W = E.W, H = E.H, S = System, U = E.U;
var TK = E.ui.preset("neon");
var hasLink = typeof CelerLink !== "undefined";

// campo na mesma proporcao do Pong original (240x320 de projeto)
var TOP = E.u(44), BOT = E.u(316);
var PAD_Y = E.u(292), PAD_W = E.u(56), PAD_H = Math.max(4, E.u(8));
var R = Math.max(3, E.u(5));
var SERVE_SPEED = 170, MAX_VY = 420, WIN = 5;
var ROLE_HOST = 1, ROLE_GUEST = 2;

var role = 0, mine = 0, theirs = 0, padX = W / 2;
var ball = null, aimErr = 0, waitT = 0;
var over = false, won = false, note = "", serveTimer = null;

var auto = E.save.get("auto", "0") === "1";

var peers = [], peerList = null, scanning = false, sel = null, help = null;

var R_HOST = { x: 35, y: 118, w: 170, h: 40 };
var R_JOIN = { x: 35, y: 162, w: 170, h: 40 };
var R_HELP = { x: 45, y: 206, w: 150, h: 28 };
var R_AUTO = { x: 150, y: 238, w: 86, h: 28 };
var R_QUIT = { x: 85, y: 274, w: 70, h: 24 };

var HELP = "Coloque dois CelerOS lado a lado. Um hospeda e mostra um código de 6 dígitos; " +
           "o outro entra e digita esse código. A bola sai pelo topo de uma tela e entra " +
           "pelo topo da outra. Cada um defende a base de baixo: 5 pontos vencem. Arraste " +
           "o dedo para mover a raquete. O piloto automático defende sozinho.";

E.audio.sfxTable.hit = [[880, 22]];
E.audio.sfxTable.score = [[200, 120]];
E.audio.sfxTable.win = [[660, 90], [880, 90], [1320, 220]];

// ------------------------------------------------------- quadra (slot) ----
var bgSpr = 0, bgGen = 0;
function dashes(x, y, w, h) {
    var dash = E.u(8), gap = E.u(16), dh = Math.max(1, E.u(2));
    var x0 = x === undefined ? 0 : x, x1 = x === undefined ? W : x + w;
    var y0 = y === undefined ? 0 : y, y1 = y === undefined ? H : y + h;
    if (TOP + dh <= y0 || TOP >= y1) return;
    for (var dx = E.u(4); dx < W; dx += gap) {
        if (dx + dash < x0 || dx > x1) continue;
        S.fillRect(dx, TOP, Math.min(dash, W - dx), dh, T.stroke);
    }
}
function montaQuadra() {
    bgSpr = 0; bgGen = 0;
    if (typeof S.drawPNG !== "function") return;
    var fit = E.slots.fit(W, H);
    if (!fit.ok) E._warn("quadra: " + fit.motivo);
    var id = E.slots.create("pong:quadra", W, H);
    if (!id) return;
    S.useSprite(id);
    S.fillScreen(T.bg);
    var ok = false;
    var bases = ["/local/apps/Pong Duplo/", "/sd/apps/Pong Duplo/"];
    for (var b = 0; b < bases.length && !ok; b++) {
        try { ok = !!S.drawPNG(bases[b] + "ai_bg.png", 0, 0); } catch (e) { ok = false; }
    }
    if (ok) dashes();
    S.useSprite(0);
    if (!ok) { E.slots.release(id); return; }
    bgSpr = id;
    bgGen = E.slots.gen(id);
}
montaQuadra();
function paintCourt(x, y, w, h) {
    if (bgSpr && E.slots.gen(bgSpr) === bgGen &&
        typeof S.blitSprite === "function") {
        S.blitSprite(bgSpr, x, y, w, h);
        return;
    }
    S.fillRect(x, y, w, h, T.bg);
    dashes(x, y, w, h);
}

// ------------------------------------------------------- particulas --------
var _seed = { x: 0, y: 0, vx: 0, vy: 0, life: 0.3, size: 2, color: 0xFFFF, ring: false, grow: 0 };
function _pInit(q) {
    q.x = _seed.x; q.y = _seed.y; q.vx = _seed.vx; q.vy = _seed.vy;
    q.t = 0; q.life = _seed.life; q.size = _seed.size; q.color = _seed.color;
    q.ring = _seed.ring; q.grow = _seed.grow; q.w = q.h = 4;
}
var _pO = { fill: true, screen: true };
var _ringP = { fill: false, screen: true };
var parts = E.pool(40, function () {
    return {
        dead: true, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, size: 2, color: 0xFFFF,
        ring: false, grow: 0, w: 4, h: 4,
        update: function (dt) {
            this.t += dt;
            if (this.t >= this.life) { this.dead = true; return; }
            this.x += this.vx * dt;
            this.y += this.vy * dt;
            this.w = this.h = Math.round((this.ring ? this.size + this.t * this.grow
                                                       : Math.max(1, this.size * (1 - this.t / this.life))) * 2 + 2);
        },
        draw: function () {
            if (this.ring) {
                E.gfx.circle(Math.round(this.x), Math.round(this.y),
                             Math.round(this.size + this.t * this.grow), this.color, _ringP);
            } else {
                var r = Math.max(1, Math.round(this.size * (1 - this.t / this.life)));
                if (r <= 1) E.gfx.rect(Math.round(this.x), Math.round(this.y), 2, 2, this.color, _pO);
                else E.gfx.circle(Math.round(this.x), Math.round(this.y), r, this.color, _pO);
            }
        }
    };
});
function pPut(x, y, vx, vy, o) {
    _seed.x = x; _seed.y = y; _seed.vx = vx; _seed.vy = vy;
    _seed.life = (o.life || 0.3) * (0.7 + Math.random() * 0.3);
    _seed.size = o.size || 2;
    _seed.color = o.color === undefined ? 0xFFFF : o.color;
    _seed.ring = !!o.ring;
    _seed.grow = o.grow || 0;
    return !!parts.spawn(_pInit);
}
function pBurst(x, y, o) {
    var n = o.n === undefined ? 8 : o.n;
    for (var i = 0; i < n; i++) {
        var a = Math.random() * Math.PI * 2;
        var v = o.speed + Math.random() * (o.speed2 - o.speed);
        pPut(x, y, Math.cos(a) * v, Math.sin(a) * v, o);
    }
}
function pRing(x, y, o) {
    pPut(x, y, 0, 0, { ring: true, life: o.life || 0.35, size: o.r0 || R,
                       color: o.color, grow: o.speed || 100 });
}
var FLO = [];
function pText(x, y, str, color) {
    FLO.push({ x: x, y: y, s: String(str), c: color, t: 0, life: 0.8 });
    if (FLO.length > 6) FLO.shift();
}
function fxClear() { parts.clear(); FLO.length = 0; }

// ------------------------------------------------------------ estado ------
function resetMatch() {
    mine = 0;
    theirs = 0;
    ball = null;
    padX = W / 2;
    aimErr = 0;
    waitT = 0;
    over = false;
    if (serveTimer) { E.cancel(serveTimer); serveTimer = null; }
}
function leaveLink() {
    if (!hasLink) return;
    try { CelerLink.disconnect(); CelerLink.stop(); } catch (e) {}
}
function scheduleServe(ms) {
    if (serveTimer) E.cancel(serveTimer);
    serveTimer = E.after(ms, serve);
}
function serve() {
    serveTimer = null;
    if (E.sceneName !== "play" || over) return;
    var dir = Math.random() < 0.5 ? -1 : 1;
    ball = { x: W / 2, y: E.u(200),
             vx: dir * (E.u(40) + Math.random() * E.u(60)),
             vy: -SERVE_SPEED * U };
    aimErr = 0;
    waitT = 0;
    if (hasLink) CelerLink.send({ t: "s" });
    pRing(ball.x, ball.y, { color: TK.accent, speed: E.u(90), life: 0.35 });
}
function addPoint(byMe, x) {
    if (byMe) mine++; else theirs++;
    waitT = 0;
    pRing(x, BOT, { r0: R, speed: E.u(140), color: byMe ? TK.ok : TK.err, life: 0.5 });
    pBurst(W / 2, BOT, { n: 14, color: byMe ? TK.ok : TK.err, speed: E.u(80),
                         speed2: E.u(150), life: 0.5, size: Math.max(2, E.u(2)) });
    pText(W / 2 + (byMe ? -E.u(34) : E.u(34)), E.u(54), "+1", byMe ? TK.ok : TK.warn);
    E.audio.sfx("score");
    if ((byMe ? mine : theirs) >= WIN) finish(byMe);
}
function finish(victory) {
    if (over) return;
    over = true;
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
        ball = { x: W - o.x * W / 1000, y: TOP + R,
                 vx: -o.vx * U, vy: Math.abs(o.vy) * U };
        aimErr = (Math.random() - 0.5) * E.u(100);
        waitT = 0;
        pRing(ball.x, TOP, { r0: R, speed: E.u(70), color: TK.textDim, life: 0.3 });
    } else if (o.t === "p") {
        addPoint(true, W / 2);
    }
}
function pollLink() {
    if (!hasLink) return;
    var raw, guard = 0;
    while ((raw = CelerLink.poll()) !== null && guard++ < 8) onLinkPlay(raw);
}

// ------------------------------------------------------------ fisica ------
function missBall() {
    var bx = ball ? ball.x : padX;
    ball = null;
    waitT = 0;
    if (hasLink) CelerLink.send({ t: "p" });
    addPoint(false, bx);
    if (over) return;
    scheduleServe(1200);   // quem perdeu o ponto saca
}
function physics(dt) {
    if (over) return;
    if (auto) {
        var target = ball ? ball.x + aimErr : W / 2;
        var step = E.u(150) * dt;
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
        pBurst(ball.x, ball.y, { n: 4, color: TK.outline, speed: E.u(50),
                                 speed2: E.u(50), life: 0.25, size: 1 });
    } else if (ball.x > W - R) {
        ball.x = W - R;
        ball.vx = -Math.abs(ball.vx);
        pBurst(ball.x, ball.y, { n: 4, color: TK.outline, speed: E.u(50),
                                 speed2: E.u(50), life: 0.25, size: 1 });
    }
    // rebote na raquete (a bola desce e encosta na face de cima)
    if (ball.vy > 0 && ball.y + R >= PAD_Y && ball.y + R <= PAD_Y + PAD_H + E.u(6) &&
        Math.abs(ball.x - padX) <= PAD_W / 2 + R) {
        ball.vy = -Math.min(MAX_VY * U, Math.abs(ball.vy) * 1.07);
        ball.vx += (ball.x - padX) * 3;
        pBurst(ball.x, PAD_Y, { n: 9, color: TK.accent, speed: E.u(70),
                                speed2: E.u(30), life: 0.35, size: Math.max(1, E.u(2)) });
        E.audio.sfx("hit");
    }
    if (ball.y < TOP) {
        if (hasLink) {
            CelerLink.send({ t: "b", x: Math.round(ball.x * 1000 / W),
                             vx: Math.round(ball.vx / U), vy: Math.round(ball.vy / U) });
        }
        ball = null;
        waitT = 0;
    } else if (ball.y > BOT) {
        missBall();
    }
}

// ------------------------------------------------------------ desenho -----
var _padO = { r: Math.max(2, Math.round(PAD_H / 2)) };
var _ballO = { smooth: E.caps.smooth };
var _waitO = { ts: "small", align: "center", color: TK.textDim, screen: true };
function drawField() {
    E.gfx.rect(padX - PAD_W / 2, PAD_Y, PAD_W, PAD_H, TK.accent, _padO);
    if (ball) {
        E.gfx.circle(ball.x, ball.y, R, TK.text, _ballO);
        E.gfx.circle(ball.x - R * 0.3, ball.y - R * 0.3,
                     Math.max(1, R * 0.35), TK.accent);
    } else if (waitT > 0.7) {
        E.gfx.text("aguardando a bola...", W / 2, H / 2, _waitO);
    }
    parts.draw({ cull: true, pad: 8 });
    for (var i = 0; i < FLO.length; i++) {
        E.gfx.text(FLO[i].s, Math.round(FLO[i].x), Math.round(FLO[i].y),
                   { ts: "big", align: "center", color: FLO[i].c, screen: true });
    }
}

// HUD da UI 1.3: "VOCÊ n × m OPONENTE" + botao de pausa. O E.ui.hud memoiza
// por assinatura (a camada suja repinta so quando o placar muda ou a quadra
// passa por cima)
var HUD_L = [{ icon: null, text: "", color: 0 },
             { icon: null, text: "×", color: 0 },
             { icon: null, text: "", color: 0 }];
var HUD_O = { x: 0, y: 0, w: W - 40, h: TOP, bg: TK.surface, key: "pong", left: HUD_L };
function drawHud() {
    HUD_L[0].text = "VOCÊ " + mine;
    HUD_L[0].color = TK.accent;
    HUD_L[1].color = TK.textDim;
    HUD_L[2].text = theirs + " OPONENTE";
    HUD_L[2].color = TK.text;
    E.ui.hud(HUD_O);
    return E.ui.iconButton("pause", W - 36, 8, 28, { variant: "primary" });
}

// ------------------------------------------------------------- acoes ------
function startHost() {
    if (!hasLink) {
        note = "Sem Bluetooth neste firmware";
        E.ui.toast("Esta placa nao tem Bluetooth", { type: "warn" });
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
        E.ui.toast("Esta placa nao tem Bluetooth", { type: "warn" });
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
            items.push({ label: peers[i].name + "   " + peers[i].rssi + " dBm",
                         value: peers[i].id, icon: "wifi" });
        }
        peerList = E.ui.list({ items: items, row: E.u(44) });
    } else peerList = null;
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
E.onSleep = function () {
    if (E.sceneName === "play" && !E.paused) E.push("pausa");
};
E.onWake = function () { E.redraw(); };

E.run({
    menu: {
        static: true,
        enter: function () {
            help = null;
            E.dirty.off();
            fxClear();
        },
        update: function () {
            if (help && !help.closed) { E.redraw(); return; }
            if (help) { help = null; this.static = true; E.redraw(); }
            // taps por rect: a cena static nao redesenha no quadro do toque
            if (E.hit(R_HOST)) { startHost(); return; }
            if (E.hit(R_JOIN)) { startScan(); return; }
            if (E.hit(R_AUTO)) {
                auto = !auto;
                E.save.set("auto", auto ? "1" : "0");
                E.audio.sfx("ui");
                E.redraw();
                return;
            }
            if (E.hit(R_HELP)) {
                help = E.ui.dialog(HELP, { name: "COMO JOGAR", speed: 45 });
                this.static = false;
                E.audio.sfx("ui");
                E.redraw();
                return;
            }
            if (E.hit(R_QUIT)) System.exitApp();
        },
        draw: function () {
            E.gfx.gradient(0, 0, W, H, TK.surface, TK.bg, { screen: true });
            if (help) {
                if (!help.draw(18, 92, 204)) { help = null; this.static = true; E.redraw(); }
                return;
            }
            E.ui.title({ game: "PONG DUPLO", subtitle: "duas telas, um jogo",
                         start: null, bg: false });
            E.ui.button("Hospedar", R_HOST.x, R_HOST.y, R_HOST.w, R_HOST.h,
                        { variant: "primary", icon: "wifi" });
            E.ui.button("Entrar", R_JOIN.x, R_JOIN.y, R_JOIN.w, R_JOIN.h,
                        { variant: "secondary", icon: "search" });
            E.ui.button("Como jogar", R_HELP.x, R_HELP.y, R_HELP.w, R_HELP.h,
                        { variant: "secondary" });
            E.ui.chip(auto ? "AUTO ON" : "AUTO OFF", R_AUTO.x, R_AUTO.y,
                      { on: auto, w: R_AUTO.w, h: R_AUTO.h, icon: "play" });
            E.gfx.text(hasLink ? "5 pontos vencem" : (note || "Sem Bluetooth"),
                       10, 252, { ts: "small", color: hasLink ? TK.textDim : TK.warn,
                                  fit: 130, screen: true });
            E.ui.button("Sair", R_QUIT.x, R_QUIT.y, R_QUIT.w, R_QUIT.h,
                        { variant: "ghost" });
        }
    },

    host: {
        static: true,
        cleanup: true,
        enter: function () {
            role = ROLE_HOST;
            resetMatch();
            E.dirty.off();
            this.data = { key: "", btn: null };
            if (hasLink) CelerLink.start(null, { pairing: true });
        },
        update: function () {
            if (!hasLink) { E.goto("menu", { transition: "fade", ms: 300 }); return; }
            var st = CelerLink.status();
            var key = (st.name || "") + "|" + (st.pairing ? (st.code || "?") : "") +
                      "|" + (st.connected ? "1" : "0");
            if (key !== this.data.key) { this.data.key = key; E.redraw(); }
            if (st.connected) {
                E.goto("play", { transition: "fade", ms: 300 });
                return;
            }
            if (this.data.btn && E.hit(this.data.btn)) {
                leaveLink();
                note = "";
                E.audio.sfx("back");
                E.goto("menu", { transition: "fade", ms: 300 });
            }
        },
        draw: function () {
            var st = hasLink ? CelerLink.status() :
                     { name: "", pairing: false, code: "", connected: false };
            E.gfx.gradient(0, 0, W, H, TK.surface, TK.bg, { screen: true });
            E.gfx.text("Esperando o adversário...", W / 2, E.u(52),
                       { ts: "title", align: "center", color: TK.text, fit: W - 24, screen: true });
            E.gfx.text("Visível como " + (st.name || "CelerOS"), W / 2, E.u(90),
                       { ts: "small", align: "center", color: TK.textDim, fit: W - 24, screen: true });
            if (st.pairing && st.code) {
                var c = E.ui.card(W / 2 - E.u(80), E.u(122), E.u(160), E.u(96), { pad: 10 });
                E.gfx.text("CÓDIGO", W / 2, c.y,
                           { ts: "small", align: "center", color: TK.accent, screen: true });
                E.gfx.text(st.code, W / 2, c.y + E.u(18),
                           { ts: "huge", align: "center", color: TK.text, fit: c.w,
                             screen: true });
                E.gfx.text("digite no outro aparelho", W / 2, c.y + E.u(62),
                           { ts: "tiny", align: "center", color: TK.textDim, screen: true });
            } else {
                E.gfx.text("Aguardando o outro lado...", W / 2, E.u(160),
                           { ts: "body", align: "center", color: TK.textDim, screen: true });
            }
            this.data.btn = E.ui.button("Cancelar", W / 2 - E.u(85), H - E.u(64),
                                        E.u(170), E.u(40), { variant: "secondary" });
        }
    },

    scan: {
        cleanup: true,
        enter: function () {
            peers = [];
            peerList = null;
            sel = null;
            scanning = true;
            E.dirty.off();
            if (!hasLink) { E.goto("menu", { transition: "fade", ms: 300 }); return; }
            // deixa "Procurando..." aparecer antes do scan bloqueante
            E.after(250, doScan);
        },
        update: function () {
            if (sel) {
                var id = sel;
                sel = null;
                tryConnect(id);
            }
        },
        draw: function () {
            E.gfx.gradient(0, 0, W, H, TK.surface, TK.bg, { screen: true });
            E.gfx.text("Entrar numa partida", W / 2, E.u(14),
                       { ts: "label", align: "center", color: TK.text, fit: W - 24, screen: true });
            if (scanning) {
                E.gfx.text("Procurando...", W / 2, E.u(130),
                           { ts: "body", align: "center", color: TK.textDim, screen: true });
            } else if (!peers.length) {
                E.gfx.text("Ninguém hospedando por perto.", W / 2, E.u(120),
                           { ts: "body", align: "center", color: TK.textDim, fit: W - 30, screen: true });
            } else if (peerList) {
                var picked = peerList.draw(E.u(12), E.u(50), W - E.u(24),
                                           H - E.u(50) - E.u(58));
                if (picked !== null) sel = picked;
            }
            if (E.ui.button("Procurar", E.u(12), H - E.u(50), E.u(100), E.u(36),
                            { variant: "secondary", icon: "refresh" })) {
                peers = [];
                peerList = null;
                scanning = true;
                E.after(250, doScan);
            }
            if (E.ui.button("Voltar", W - E.u(112), H - E.u(50), E.u(100), E.u(36),
                            { variant: "secondary", icon: "back" })) {
                leaveLink();
                E.audio.sfx("back");
                E.goto("menu", { transition: "fade", ms: 300 });
            }
        }
    },

    play: {
        cleanup: true,
        enter: function () {
            E.dirty.enable(paintCourt);
            resetMatch();
            fxClear();
            waitT = 0;
            if (role === ROLE_HOST) scheduleServe(1500);
        },
        exit: function () {
            E.dirty.off();
            if (serveTimer) { E.cancel(serveTimer); serveTimer = null; }
            fxClear();
        },
        update: function (dt) {
            pollLink();
            if (hasLink && !CelerLink.status().connected) {
                note = "Conexão perdida";
                leaveLink();
                E.goto("menu", { transition: "wipe", ms: 300, dir: "left" });
                return;
            }
            // raquete: o dedo abaixo do HUD manda (multitoque pega qualquer)
            var ts = E.input.touches || [], f = null, i;
            for (i = 0; i < ts.length; i++) {
                if (ts[i].down && ts[i].y > TOP) { f = ts[i]; break; }
            }
            if (f) padX = f.x;
            else if (E.input.down && E.input.y > TOP) padX = E.input.x;
            physics(dt);
            for (i = FLO.length - 1; i >= 0; i--) {
                FLO[i].t += dt;
                FLO[i].y -= 24 * dt;
                if (FLO[i].t >= FLO[i].life) FLO.splice(i, 1);
            }
            parts.update(dt);
        },
        draw: function () {
            drawField();
            if (drawHud()) {
                E.audio.sfx("ui");
                E.push("pausa");
            }
        }
    },

    pausa: {
        enter: function () {
            E.pause(true);
            E.dirty.off();
            E.redraw();
        },
        exit: function () {
            E.pause(false);
            E.dirty.full();
            E.redraw();
        },
        draw: function () {
            var act = E.ui.pause({ clear: true, labels: ["Continuar", "Recomecar", "Sair"] });
            if (act === "resume") { E.pop(); E.audio.sfx("ui"); }
            else if (act === "restart") {
                resetMatch();
                E.pop();
                if (role === ROLE_HOST) scheduleServe(1200);
                E.audio.sfx("ui");
            } else if (act === "quit") {
                leaveLink();
                E.audio.sfx("back");
                E.goto("menu", { transition: "fade", ms: 300 });
            }
        }
    },

    end: {
        static: true,
        cleanup: true,
        enter: function () {
            E.dirty.off();
            fxClear();
            E.redraw();
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
                        ball = { x: W - o.x * W / 1000, y: TOP + R,
                                 vx: -o.vx * U, vy: Math.abs(o.vy) * U };
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
            }
        },
        draw: function () {
            E.gfx.gradient(0, 0, W, H, TK.surface, TK.bg, { screen: true });
            E.gfx.text(won ? "Você venceu!" : "Você perdeu", W / 2, Math.round(H * 0.16),
                       { ts: "big", align: "center", color: won ? TK.ok : TK.err, screen: true });
            E.gfx.text("Pontos: " + mine, W / 2, Math.round(H * 0.26),
                       { ts: "title", align: "center", color: TK.text, screen: true });
            E.gfx.text("Adversário: " + theirs, W / 2, E.u(150),
                       { ts: "small", align: "center", color: TK.textDim, screen: true });
            if (E.ui.button("Revanche", W / 2 - E.u(90), Math.round(H * 0.58),
                            E.u(180), E.u(36), { variant: "primary", icon: "refresh" })) {
                resetMatch();
                E.audio.sfx("ok");
                E.goto("play", { transition: "fade", ms: 350 });
            }
            if (E.ui.button("Sair", W / 2 - E.u(90), Math.round(H * 0.58) + E.u(44),
                            E.u(180), E.u(36), { variant: "secondary" })) {
                leaveLink();
                E.audio.sfx("back");
                E.goto("menu", { transition: "fade", ms: 300 });
            }
        }
    }
}, "menu");

// expoe o estado para testes/CI; no aparelho __harness nao existe
if (typeof __harness !== "undefined") {
    __harness.pong = {
        state: function () {
            return { scene: E.sceneName, role: role, mine: mine, theirs: theirs,
                     auto: auto, paused: E.paused, over: over, hasLink: hasLink,
                     padX: padX, ball: ball ? { x: ball.x, y: ball.y } : null };
        }
    };
}
