// Supernova 2.2 — atirador espacial construido sobre a game engine do SDK,
// tela cheia nos PIXELS NATIVOS do vidro (API 28; 480x480 no SmartDisplay
// 4"). A trilha chiptune segue sendo o metronomo (ondas caem na batida via
// beat clock) e a carga dos orbes detona a SUPERNOVA. SENTINELA-MOR (chefe
// a cada 5 ondas, rajadas radiais na batida, barra de vida), combo x2..x5
// por abates em serie, drones splitter, tiro triplo de premiacao. A saida
// e pelo menu (System.exitApp): sem topbar.
//
// Render (engine 1.2): nada de fillScreen por quadro. Os menus sao cenas
// `static` (desenham 1x e so repintam no press de botao) e a cena de jogo
// usa a camada suja E.dirty — cada quadro apaga so as caixas do anterior
// (fundo preto) dentro do recorte da arena; o HUD fica fora do recorte e
// so repinta quando um numero muda. No firmware de caixas sujas (API 32)
// so essas caixas vao ao vidro: o painel RGB nao treme mais.
//
// Modulos: main.js (cenas/visao/HUD) + jogo.js (simulacao). A engine e DEP
// do hub (app.json "deps"; API 30); os projeteis vivem em pools proprios
// com colisao por distancia (sem fisica desde a 2.3). Layout em unidades do
// projeto 240 (E.u): 2x no 480, ~1,7x no relogio.

var E = require("celeros.game");       // familia CelerGame: adota so o que usa
require("celeros.game.fx");
require("celeros.game.spr");
var jogo = require("jogo");

E.init({ dir: "Supernova", fps: 30, native: true, save: "supernova.", particles: 120 });
var W = E.W, H = E.H, u = E.u, K = E.U / 2;
var T = E.theme;

var C = {
    espaco: 0x0000,
    ciano: 0x07FF, cianoD: 0x03EF, magenta: 0xF81F, laranja: 0xFD20,
    ouro: 0xFFE0, branco: 0xFFFF, verde: 0x07E0, vermelho: 0xF800,
    cinza: System.mixColor(0x0000, 0xFFFF, 45),
    cinzaD: System.mixColor(0x0000, 0xFFFF, 18),
    painel: System.mixColor(0x0000, 0x07FF, 9),
    hud: System.mixColor(0x0000, 0x03EF, 22)
};
var HUD_H = u(32);                    // 64 no 480
var GAUGE = { x: u(30), y: H - u(30), r: u(18) };   // medidor da supernova
var hi = E.save.num("hi", 0);

// Pega de teste (so existe no harness): deixa o test.js dirigir a sim
// deterministicamente.
if (typeof __harness !== "undefined") {
    __harness.supernova = { jogo: jogo, E: E };
}

// ------------------------------------------------------------- sprites ---
// PNGs (arte por IA) masterizados no 480; os painters escalam com K e
// assumem quando o PNG falta (harness, slot esgotado).
var BASES = ["/local/apps/Supernova/assets/", "/sd/apps/Supernova/assets/"];

function paintNave(w, h, x, y) {
    System.fillTriangle(x + w / 2, y + 2, x + 6, y + h - 8, x + w - 6, y + h - 8, C.ciano);
    System.fillTriangle(x + w / 2, y + 10, x + w / 2 - w / 6, y + h - 14, x + w / 2 + w / 6, y + h - 14, C.branco);
    System.fillCircle(x + w / 2, y + h / 2 + 2, Math.max(2, w / 14), C.cianoD);
}
function paintDrone(w, h, x, y) {
    System.fillTriangle(x + w / 2, y + 4, x + 2, y + h - 6, x + w - 2, y + h - 6, C.laranja);
    System.fillCircle(x + w / 2, y + h / 2, Math.max(2, w / 9), C.magenta);
}
function paintOlho(w, h, x, y) {
    System.fillCircle(x + w / 2, y + h / 2, w / 2 - 3, C.magenta);
    System.fillCircle(x + w / 2, y + h / 2, w / 3, C.branco);
    System.fillCircle(x + w / 2, y + h / 2, w / 6, 0x0000);
}
function paintOrbe(w, h, x, y) {
    System.fillCircle(x + w / 2, y + h / 2, w / 2 - 2, C.ouro);
    System.fillCircle(x + w / 2, y + h / 2, w / 4, C.branco);
}

var SPR = { nave: Math.round(72 * K), inimigo: Math.round(56 * K), orbe: Math.round(44 * K) };
// PNG so no tamanho de mestre (K = 1); fora disso o painter desenha na escala
var USA_PNG = Math.abs(K - 1) < 0.05;
E.spr.load([
    { name: "nave", file: USA_PNG ? "nave" : null, w: SPR.nave, h: SPR.nave, paint: paintNave },
    { name: "inimigo", file: USA_PNG ? "inimigo" : null, w: SPR.inimigo, h: SPR.inimigo, paint: paintDrone },
    { name: "olho", file: USA_PNG ? "olho" : null, w: SPR.inimigo, h: SPR.inimigo, paint: paintOlho },
    { name: "orbe", file: USA_PNG ? "orbe" : null, w: SPR.orbe, h: SPR.orbe, paint: paintOrbe }
], { bases: BASES });

// Campo de estrelas em 2 tons (guardado no E.data: sobrevive as cenas);
// com a camada suja cada estrela apaga o proprio pixel antigo. stride 4:
// so 1/4 das estrelas se move por quadro (15 em vez de 60 pontos sujos
// espalhados pelo vidro — a uniao deles virava a tela inteira e o vidro
// voltava a vibrar por disputa de banda da PSRAM com o DMA do painel)
E.data.stars = E.fx.stars(Math.round(W / 8), {
    w: W, h: H, vy: 30 * K, stride: 4,
    colors: [0x39E7, 0xC5F9]   // cinza-azulado longe, branco quente perto
});

// fracao alta da batida (1 logo apos o tempo forte, decai ate o proximo)
function beatPulse() {
    var b = E.audio.beat();
    if (b < 0) return 0;
    return Math.max(0, 1 - (b - Math.floor(b)) * 3);
}

// ------------------------------------------------------- menus (comum) ---

// fundo de menu: estrelas fixas + arte do titulo (PNG decodificado so no
// 1o draw da cena; o redraw do press so repinta a faixa dos botoes)
var tituloPath = null, tituloTentou = false;
function drawFundo(comArte) {
    System.fillScreen(C.espaco);
    for (var j = 0; j < 70; j++) {
        System.drawPixel(Math.floor(Math.random() * W), Math.floor(Math.random() * H),
                         j % 3 ? C.cinzaD : C.cinza);
    }
    if (!comArte || !E.caps.png) return 0;
    var ox = Math.round((W - 480) / 2);
    if (!tituloTentou) {
        tituloTentou = true;
        for (var i = 0; i < BASES.length && !tituloPath; i++) {
            try { if (System.drawPNG(BASES[i] + "titulo.png", ox, 0)) tituloPath = BASES[i] + "titulo.png"; } catch (e) {}
        }
    } else if (tituloPath) {
        try { System.drawPNG(tituloPath, ox, 0); } catch (e2) { tituloPath = null; }
    }
    return tituloPath ? 230 : 0;
}

// par de botoes empilhados e centrados: devolve [primario, secundario]
function botoes(y, rotulo1, rotulo2, cor) {
    var bw = Math.min(u(150), W - u(40)), bh = u(27), gap = u(10);
    var x = Math.round((W - bw) / 2);
    // limpa a faixa: os cantos arredondados (AA) nao herdam a cor anterior
    System.fillRect(x - 2, y - 2, bw + 4, bh * 2 + gap + 4, C.espaco);
    var a = E.gfx.button(rotulo1, x, y, bw, bh, { color: cor || C.ciano, screen: true });
    var b = E.gfx.button(rotulo2, x, y + bh + gap, bw, bh, {
        primary: false, bg: C.painel, stroke: System.mixColor(cor || C.ciano, C.espaco, 45),
        textColor: C.branco, screen: true });
    return [a, b];
}

// ------------------------------------------------------------- visao -----

var D = E.dirty;

function drawOrb(o, shx, shy, pulse) {
    var x = Math.round(o.x + shx), y = Math.round(o.y + shy);
    var pulso = 0.5 + 0.5 * Math.sin(o.ph);
    var r = Math.round((26 + pulso * 5 + pulse * 3) * K);
    System.fillSmoothCircle(x, y, r, System.mixColor(C.ouro, C.espaco, 55 - pulso * 25));
    D.add(x - r - 1, y - r - 1, r * 2 + 3, r * 2 + 3);
    E.spr.blit("orbe", x, y, { cx: true, cy: true, key: C.espaco });
}

function drawEnemy(e, shx, shy, ms) {
    var x = Math.round(e.x + shx), y = Math.round(e.y + shy), r;
    if (e.kind === 2) {
        // SENTINELA-MOR: olho grande com aura, nucleo pela vida e
        // escudos orbitando; na fase rapida a aura fecha
        var fast = e.hp < e.hpMax / 2;
        r = Math.round((60 + Math.sin(ms / 110) * 5) * K);
        System.fillSmoothCircle(x, y, r, System.mixColor(C.magenta, C.espaco, fast ? 35 : 55));
        D.add(x - r - 1, y - r - 1, r * 2 + 3, r * 2 + 3);
        E.spr.blit("olho", x, y, { cx: true, cy: true, key: C.espaco });
        var hpk = e.hp / e.hpMax;
        System.fillCircle(x, y, Math.round(8 * K), hpk > 0.5 ? C.verde : (hpk > 0.25 ? C.ouro : C.vermelho));
        var a = ms / 300, orb = 52 * K, rr = Math.round(4 * K) + 1;
        var ax = Math.round(x + Math.cos(a) * orb), ay = Math.round(y + Math.sin(a) * orb);
        var bx = Math.round(x - Math.cos(a) * orb), by = Math.round(y - Math.sin(a) * orb);
        System.fillCircle(ax, ay, rr, C.magenta);
        System.fillCircle(bx, by, rr, C.magenta);
        D.add(ax - rr, ay - rr, rr * 2 + 1, rr * 2 + 1);
        D.add(bx - rr, by - rr, rr * 2 + 1, rr * 2 + 1);
    } else if (e.kind === 4) {
        var t = 10 * K, l = 9 * K;
        System.fillTriangle(x, y - t, x - l, y + 8 * K, x + l, y + 8 * K, C.laranja);
        D.add(x - l - 1, y - t - 1, l * 2 + 3, t + 8 * K + 3);
    } else {
        E.spr.blit(e.kind === 1 ? "olho" : "inimigo", x, y, { cx: true, cy: true, key: C.espaco });
        // nucleo pulsante POR CIMA do blit: animacao sem slot extra
        var nk = e.kind === 1 ? [0, 4, 130, C.verde] :
                 (e.kind === 3 ? [8, 4, 70, C.ouro] : [8, 3, 90, C.magenta]);
        System.fillCircle(x, Math.round(y + nk[0] * K),
                          Math.round((nk[1] + Math.sin(ms / nk[2] + e.ph) * 2) * K), nk[3]);
    }
    if (e.flashT > 0) {   // leva tiro: pisca branco
        r = Math.round((e.kind === 2 ? 50 : 26) * K);
        System.fillSmoothCircle(x, y, r, System.mixColor(C.branco, C.espaco, 45));
        D.add(x - r - 1, y - r - 1, r * 2 + 3, r * 2 + 3);
    }
}

function drawPlayer(p, shx, shy, ms) {
    if (p.invuln > 0 && Math.floor(ms / 90) % 2 !== 0) return;
    var px = Math.round(p.x + shx), py = Math.round(p.y + shy);
    var fl = (10 + Math.sin(ms / 40) * 5) * K;
    var mx = Math.round(12 * K), my = Math.round(40 * K), mr = Math.round(5 * K);
    System.fillSmoothCircle(px - mx, py + my, mr, C.cianoD);
    System.fillSmoothCircle(px + mx, py + my, mr, C.cianoD);
    var fy = Math.round(34 * K);
    System.fillTriangle(px - 9 * K, py + fy, px + 9 * K, py + fy, px, py + fy + fl, C.ciano);
    D.add(px - mx - mr - 1, py + fy - 1, (mx + mr) * 2 + 3, Math.max(my + mr, fy + fl) - fy + 3);
    E.spr.blit("nave", px, py, { cx: true, cy: true, key: C.espaco });
}

function drawGame(s, pulse) {
    var shx = E.cam.ox, shy = E.cam.oy;   // tremor vem da camera da engine
    var all = s.world.all, ms = System.millis();
    var i, b, bx, by;
    for (i = 0; i < all.length; i++) {
        if (all[i].cat === 'orb') drawOrb(all[i], shx, shy, pulse);
    }
    for (i = 0; i < all.length; i++) {
        if (all[i].cat === 'enemy') drawEnemy(all[i], shx, shy, ms);
    }
    if (!s.over || s.overT < 0.4) drawPlayer(s.player, shx, shy, ms);
    // projeteis direto dos pools do jogo (nada de varrer world.all por cat)
    var bp = jogo.bullets();
    var bl = Math.round(14 * K), er = Math.max(2, Math.round(4 * K));
    for (i = 0; i < bp.pbn; i++) {
        b = bp.pb[i];
        bx = Math.round(b.x + shx);
        by = Math.round(b.y + shy);
        System.drawFastVLine(bx, by, bl, C.ciano);
        System.drawFastVLine(bx + 1, by + 2, bl - 4, C.cianoD);
        System.drawPixel(bx, by + bl + 1, C.branco);
        D.add(bx - 1, by - 1, 4, bl + 4);
    }
    for (i = 0; i < bp.ebn; i++) {
        b = bp.eb[i];
        bx = Math.round(b.x + shx);
        by = Math.round(b.y + shy);
        System.fillCircle(bx, by, er, C.magenta);
        System.drawPixel(bx, by, C.branco);
        D.add(bx - er - 1, by - er - 1, er * 2 + 3, er * 2 + 3);
    }
}

// barra do chefe (dentro da arena, logo abaixo do HUD: cai na camada suja)
function drawBossBar(s) {
    if (!s.boss) return;
    var bw = Math.min(u(120), W - u(60)), x = Math.round((W - bw) / 2), y = HUD_H + u(5);
    E.gfx.bar(x, y, bw, u(4), s.boss.hp / s.boss.hpMax, { fg: C.magenta, bg: C.cinzaD, screen: true });
}

// medidor da supernova (canto inferior esquerdo; toque nele detona)
function drawGauge(s, pulse, ms) {
    var cheio = s.charge >= 100;
    var pulso = cheio ? 0.5 + 0.5 * Math.sin(ms / 110) : 0;
    var r = Math.round(GAUGE.r + pulso * 4 * K + pulse * 2 * K);
    // mixColor(a, b, p): p% de a ate b — vazio quase apagado, cheio pulsa
    E.gfx.circle(GAUGE.x, GAUGE.y, r, System.mixColor(C.ouro, C.espaco, cheio ? 30 + pulso * 25 : 82),
                 { smooth: true, screen: true });
    E.gfx.arc(GAUGE.x, GAUGE.y, GAUGE.r * 0.6, GAUGE.r * 0.82, -90,
              -90 + Math.round(s.charge * 3.6), C.ouro, { screen: true });
    if (cheio) {
        E.gfx.text("TOQUE", GAUGE.x, GAUGE.y, { align: "center", valign: "middle", ts: "tiny",
                   color: C.branco, screen: true });
    }
}

// HUD fora do recorte da arena: so repinta quando o que mostra muda
var hudKey = "";
function drawHUD(s, force) {
    var key = s.score + "|" + s.wave + "|" + s.mult + "|" + s.lives + "|" +
              (s.triple > 0 ? Math.ceil(s.triple) : 0) + "|" + hi + "|" + (s.boss ? 1 : 0);
    if (!force && key === hudKey) return;
    hudKey = key;
    E.gfx.gradient(0, 0, W, HUD_H, C.hud, C.espaco, { screen: true });
    System.drawFastHLine(0, HUD_H, W, C.cianoD);
    var pad = u(8);
    E.gfx.text(String(s.score), pad, HUD_H / 2 - u(3), { valign: "middle", px: u(18),
               color: C.branco, screen: true });
    E.gfx.text("REC " + Math.max(hi, s.score), pad, HUD_H - u(3), { valign: "bottom", ts: "tiny",
               color: C.cinza, screen: true });
    // centro: chefe, combo ou tiro triplo
    if (s.boss) {
        E.gfx.text("SENTINELA-MOR", W / 2, HUD_H / 2, { align: "center", valign: "middle",
                   ts: "small", color: C.magenta, screen: true });
    } else if (s.mult > 1) {
        E.gfx.text("x" + s.mult, W / 2, HUD_H / 2, { align: "center", valign: "middle",
                   px: u(16), color: C.ouro, screen: true });
    } else if (s.triple > 0) {
        E.gfx.text("TRIPLO " + Math.ceil(s.triple), W / 2, HUD_H / 2, { align: "center",
                   valign: "middle", ts: "small", color: C.verde, screen: true });
    }
    // direita: pausa (II) + onda + vidas
    var pw = u(26), px = W - pw - u(4), py = u(4), ph = HUD_H - u(8);
    E.gfx.rect(px, py, pw, ph, C.painel, { r: u(6), screen: true });
    var bw = Math.max(3, u(3)), bh = Math.round(ph * 0.42);
    System.fillRect(px + pw / 2 - bw - u(1), py + (ph - bh) / 2, bw, bh, C.branco);
    System.fillRect(px + pw / 2 + u(1), py + (ph - bh) / 2, bw, bh, C.branco);
    var rx = px - u(8);
    E.gfx.text("ONDA " + s.wave, rx, u(6), { align: "right", ts: "small", color: C.cinza, screen: true });
    var ls = u(9);
    for (var l = 0; l < Math.min(5, s.lives); l++) {
        var lx = rx - l * (ls + u(3)) - ls, ly = HUD_H - u(6);
        System.fillTriangle(lx + ls / 2, ly - ls, lx, ly, lx + ls, ly, C.ciano);
    }
}

// ------------------------------------------------------------- cenas -----

E.run({
    titulo: {
        static: true,
        enter: function () {
            E.cam.reset();
            this.first = true;
            hi = E.save.num("hi", 0);
        },
        update: function () {
            if (!this.btn) return;
            if (E.hit(this.btn[0])) {
                E.audio.sfx("ok");
                jogo.reset();
                E.goto("jogando", { transition: "fade", ms: 350 });
            } else if (E.hit(this.btn[1])) {
                System.exitApp();
            }
        },
        draw: function () {
            if (this.first) {
                this.first = false;
                var arte = drawFundo(true);
                var y = Math.max(Math.round(H * 0.47), arte + u(4));
                E.gfx.text("SUPERNOVA", W / 2, y, { align: "center", px: u(21), fit: W - u(24),
                           color: C.ciano, screen: true });
                y += u(25);
                E.gfx.text("arraste para voar - as ondas caem na batida", W / 2, y,
                           { align: "center", ts: "small", fit: W - u(16), color: C.cinza, screen: true });
                y += u(10);
                E.gfx.text("junte orbes e detone a supernova", W / 2, y,
                           { align: "center", ts: "small", fit: W - u(16), color: C.cinza, screen: true });
                if (hi > 0) {
                    E.gfx.text("RECORDE " + hi, W - u(8), u(8), { align: "right", ts: "small",
                               color: C.ouro, screen: true });
                }
            }
            // botoes ancorados no rodape (sempre cabem)
            this.btn = botoes(H - u(27) * 2 - u(10) - u(12), "JOGAR", "SAIR", C.ciano);
        }
    },

    jogando: {
        fps: 30,   // teto de quadros: sem ele o push corre solto e cintila
        enter: function () {
            E.cam.reset();
            // camada suja: fundo preto; o HUD fica fora do recorte da arena
            E.dirty.enable(C.espaco);
            E.dirty.clip(0, HUD_H + 1, W, H - HUD_H - 1);
            hudKey = "";
            var s = jogo.state();
            if (E.data.musicPos !== undefined) {
                E.audio.music(jogo.SONG, { startMs: E.data.musicPos });   // volta da pausa
                E.data.musicPos = undefined;
            } else if (!E.audio.playing() && !s.resumeAt) {
                E.audio.music(jogo.SONG);
            }
        },
        update: function (dt) {
            var s = jogo.state();
            if (E.input.down) jogo.movePlayer(E.input.dx);
            E.data.stars.update(dt * (1 + s.intensity * 0.12));
            jogo.update(dt);
            var tap = E.input.tap;
            // detonar: toque no medidor cheio
            if (tap && s.charge >= 100 &&
                Math.abs(tap.x - GAUGE.x) < GAUGE.r * 2 &&
                Math.abs(tap.y - GAUGE.y) < GAUGE.r * 2) {
                jogo.detonate();
            }
            // pausa: botao II no canto superior direito do HUD
            if (tap && tap.x > W - u(40) && tap.y < HUD_H + u(6)) {
                E.audio.sfx("ui");
                var pos = typeof System.musicPos === "function" ? System.musicPos() : -1;
                E.data.musicPos = pos > 0 ? pos : undefined;
                E.goto("pausa");
                return;
            }
            if (s.over && s.overT > 0.6) E.goto("fim", { transition: "iris", ms: 450 });
        },
        draw: function () {
            var s = jogo.state();
            var pulse = beatPulse(), ms = System.millis();
            // (a engine ja apagou as caixas do quadro anterior)
            E.data.stars.draw();
            drawGame(s, pulse);
            drawBossBar(s);
            drawGauge(s, pulse, ms);
            E.fx.draw();
            E.dirty.unclip();
            drawHUD(s, false);
        }
    },

    pausa: {
        static: true,
        enter: function () {
            E.audio.stop();
            this.first = true;
        },
        update: function () {
            if (!this.btn) return;
            if (E.hit(this.btn[0])) {
                E.audio.sfx("ui");
                E.goto("jogando");
            } else if (E.hit(this.btn[1])) {
                System.exitApp();
            }
        },
        draw: function () {
            var pw = Math.min(u(180), W - u(30)), ph = u(150);
            var px = Math.round((W - pw) / 2), py = Math.round((H - ph) / 2);
            if (this.first) {
                this.first = false;
                // painel por cima da arena congelada (sem limpar a tela)
                E.gfx.panel(px, py, pw, ph, { bg: C.painel, stroke: C.cianoD, screen: true });
                E.gfx.text("PAUSA", W / 2, py + u(26), { align: "center", valign: "middle",
                           px: u(21), color: C.branco, screen: true });
            }
            var bw = pw - u(30), bh = u(27), bx = Math.round((W - bw) / 2);
            var by = py + u(52);
            System.fillRect(bx - 2, by - 2, bw + 4, bh * 2 + u(10) + 4, C.painel);
            this.btn = [
                E.gfx.button("CONTINUAR", bx, by, bw, bh, { color: C.ciano, screen: true }),
                E.gfx.button("SAIR", bx, by + bh + u(10), bw, bh, {
                    primary: false, bg: C.espaco, stroke: C.cianoD, textColor: C.branco, screen: true })
            ];
        }
    },

    fim: {
        static: true,
        enter: function () {
            this.t = 0;
            this.first = true;
            this.newBest = E.save.best("hi", jogo.state().score);
            if (this.newBest) {
                hi = jogo.state().score;
                E.audio.sfx("record");
            }
        },
        update: function (dt) {
            this.t += dt;
            if (this.t < 0.5 || !this.btn) return;   // engole o tap do momento da morte
            if (E.hit(this.btn[0])) {
                E.audio.sfx("ok");
                jogo.reset();
                E.goto("jogando", { transition: "wipe", ms: 300 });
            } else if (E.hit(this.btn[1])) {
                E.audio.sfx("ui");
                E.goto("titulo", { transition: "fade", ms: 300 });
            }
        },
        draw: function () {
            var s = jogo.state();
            if (this.first) {
                this.first = false;
                drawFundo(false);
                var y = Math.round(H * 0.16);
                E.gfx.text("NAVE PERDIDA", W / 2, y, { align: "center", px: u(21), fit: W - u(24),
                           color: C.magenta, screen: true });
                y += u(34);
                E.gfx.text(String(s.score), W / 2, y, { align: "center", px: u(30),
                           color: C.branco, screen: true });
                y += u(36);
                E.gfx.text("onda " + s.wave + "   " + s.kills + " abates", W / 2, y,
                           { align: "center", ts: "label", color: C.cinza, screen: true });
                y += u(18);
                E.gfx.text(this.newBest ? "NOVO RECORDE!" : "recorde " + hi, W / 2, y,
                           { align: "center", ts: "label",
                             color: this.newBest ? C.ouro : C.cinza, screen: true });
            }
            this.btn = botoes(H - u(27) * 2 - u(10) - u(18), "DE NOVO", "MENU", C.ciano);
        }
    }
}, "titulo");
