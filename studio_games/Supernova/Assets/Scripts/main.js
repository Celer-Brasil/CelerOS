// Supernova 2.6 — atirador espacial construido sobre a game engine do SDK,
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
// dentro do recorte da arena; o HUD fica fora do recorte e so repinta
// quando um numero muda. No firmware de caixas sujas (API 32) so essas
// caixas vao ao vidro: o painel RGB nao treme mais.
//
// 2.6: arte dos personagens no atlas de IA (ai_atlas.png, grade 4x4 de
// 64x64, key magenta: ai0 nave, ai1 inimigo/olho, ai2 chefe, ai3 orbe) e o
// fundo no ai_bg.png (nebulosa) servido como celulas de 64 px do
// E.fx.parallax no PAINTER da camada suja — cada celula vira um stamp
// RECORTADO, entao so as caixas sujas vao ao vidro (com E.dirty._mute o
// stamp nao registra caixa). Sem sprite/PNG (harness) ou sem drawSprite
// (firmware velho) os painters procedurais e a nebulosa de circulos
// assumem, como antes. A simulacao (ondas/IA/tiros/fsm do chefe) mora no
// jogo.js; aqui ficam cenas, visao, HUD e o fundo.
//
// Modulos: main.js (cenas/visao/HUD) + jogo.js (simulacao). A engine e DEP
// do hub (app.json "deps"; API 30); os tiros/hitboxes sao do E.combat
// (2.6). Layout em unidades do projeto 240 (E.u): 2x no 480, ~1,7x no
// relogio.

var E = require("celeros.game");       // familia CelerGame: adota so o que usa
require("celeros.game.fx");
require("celeros.game.spr");
require("celeros.game.ui");           // pausa/fim prontos (menu do tema)
var jogo = require("jogo");           // waves/steer/combat/fsm (deps do app)

E.init({ dir: "Supernova", fps: 30, native: true, save: "supernova.", particles: 120,
         bases: ["/local/apps/Supernova/", "/sd/apps/Supernova/"] });
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
// Arte de IA no pacote FLAT: ai_atlas.png (grade 4x4 de 64x64, fundo
// magenta 0xF81F) com ai0 = nave, ai1 = inimigo/olho, ai2 = chefe e
// ai3 = orbe. O grid inteiro ocupa UM slot; o ai_bg.png (nebulosa) ocupa
// o segundo. Os painters procedurais ficam como fallback (harness, placa
// sem sprite/PNG ou firmware sem drawSprite — o stamp de regiao precisa
// de setClip+drawSprite).
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

// tamanho de cada arte no vidro (o stamp escala tamanho/64)
var SZ = { nave: Math.round(72 * K), drone: Math.round(56 * K),
           sentinel: Math.round(64 * K), chefe: Math.round(132 * K),
           orbe: Math.round(44 * K) };

// UM slot para o atlas inteiro (ai0..ai15); as celulas 4..15 do PNG sao
// so o fundo magenta e nunca sao desenhadas
E.spr.grid("ai", { file: "ai_atlas", cols: 4, rows: 4, tw: 64, th: 64, prefix: "ai" });

// ai_bg: a regiao bg (256x256) e o fallback de tela cheia; bg0..bg15 sao
// as celulas de 64 px que o painter da camada suja estampa UMA a UMA —
// cada stamp clipa so a propria celula (nunca a nebulosa inteira por
// caixa), que e o que mantem o painel RGB fora da disputa de banda
var AIGB_REG = { bg: [0, 0, 256, 256] };
(function () {
    for (var r = 0; r < 4; r++) {
        for (var c = 0; c < 4; c++) AIGB_REG["bg" + (r * 4 + c)] = [c, r];
    }
})();
E.spr.sheet("aibg", { file: "ai_bg", w: 256, h: 256, tw: 64, th: 64,
                      regions: AIGB_REG });
var HAS_ATLAS = !!(E.spr.backed("ai0") && E.spr.backed("ai1") && E.spr.backed("ai2") &&
                   E.spr.backed("ai3") && E.caps.clip &&
                   typeof System.drawSprite === "function");
var SYS = System;   // blitSprite (API 34) so com typeof
var HAS_BG = !!(E.spr.backed("bg") && E.caps.clip &&
                typeof System.drawSprite === "function");

// arte do atlas JA no tamanho do vidro (spr 1.5 prescale, 1 slot): o stamp
// em escala size/64 por quadro era drawSprite afim por nave/inimigo/orbe
// (~1,25 ms cada no 4848). "@" + nome + tamanho desenha em escala 1 pelo
// pushSprite; sem slot vira apelido do original (mesmo desenho)
var ART = {};
if (HAS_ATLAS) {
    var _ps = [["ai0", SZ.nave], ["ai1", SZ.drone], ["ai1", SZ.sentinel],
               ["ai2", SZ.chefe], ["ai3", SZ.orbe]], _pl = [];
    for (var pi = 0; pi < _ps.length; pi++) {
        var an = "@" + _ps[pi][0] + "_" + _ps[pi][1];
        ART[_ps[pi][0] + "_" + _ps[pi][1]] = an;
        _pl.push([_ps[pi][0], _ps[pi][1] / 64, an]);
    }
    E.spr.prescale(_pl, { key: 0xF81F, name: "supernova_ps" });
}

// opts compartilhados do stamp (nunca um literal por quadro)
var _artO = { scale: 1, key: 0xF81F, ax: 0.5, ay: 0.5 };
var _bgO = { scale: 1, key: null, ax: 0, ay: 0 };

// stamp de um personagem centrado em (x, y). O stamp de regiao de folha
// fecha o recorte do sistema ao terminar — devolve o recorte da arena.
function drawArt(name, x, y, size) {
    if (!HAS_ATLAS) return false;
    var pre = ART[name + "_" + size];
    _artO.scale = pre ? 1 : size / 64;
    E.spr.stamp(pre || name, x, y, _artO);
    if (E.caps.clip) System.setClip(0, HUD_H + 1, W, H - HUD_H - 1);
    return true;
}

// ------------------------------------------------------------- fundo ----
// Profundidade em camadas atras da arena: a nebulosa ai_bg.png fica
// ANCORADA e e servida como PAINTER da camada suja — cada caixa apagada
// repinta so as celulas de 64 px que toca (bg0..bg15 da folha). Ela nao
// rola: com recorte sujo, uma imagem de tela inteira que anda so seria
// repintada dentro das caixas e o resto do vidro ficaria na fase antiga
// (retangulos de nebulosa costurados). O parallax de profundidade fica
// com a poeira fina (E.fx.parallax) e as duas levas de E.fx.stars.
// Cada stamp clipa so a propria celula e o _mute impede que ele registre
// caixa na camada — o custo acompanha a caixa suja, nunca a tela inteira.
// O painter roda no _begin antes do draw; o draw da cena zera a camera
// para o mundo/particulas nao deslocarem. Sem sprite/PNG cai na nebulosa
// de circulos procedural.
var bgY = 0;              // rolagem acumulada do voo (unidades de camera)
var BG_SPEED = 0;         // nebulosa ancorada (ver comentario acima)

function bgHash(x, y) {
    var n = ((x | 0) * 374761393 + (y | 0) * 668265263) | 0;
    n = (n ^ (n >>> 13)) | 0;
    n = (n * 48271) | 0;
    return (n ^ (n >>> 16)) >>> 0;
}

function mod(a, n) { return ((a % n) + n) % n; }

var NEB = [
    System.mixColor(0x0000, 0x07FF, 5),    // azul
    System.mixColor(0x0000, 0xF81F, 4),    // magenta
    System.mixColor(0x0000, 0xFD20, 4)     // ambar
];
var POEIRA = [
    System.mixColor(0x0000, 0xFFFF, 18),
    System.mixColor(0x0000, 0x07FF, 14)
];

// bolha pequena e apagada em ~1/4 das celulas (480/64 = 8x8)
function paintNebulosa(x, y) {
    x = Math.round(x);
    y = Math.round(y);
    var n = bgHash(x, y);
    if ((n & 3) !== 0) return;
    System.fillCircle(x + (n >>> 8) % 7 - 3, y + (n >>> 11) % 7 - 3,
                      3 + (n >>> 4) % 5, NEB[(n >>> 14) % NEB.length]);
}

// poeira fina: 1 px em ~1/3 das celulas (480/32 = 15x15)
function paintPoeira(x, y) {
    x = Math.round(x);
    y = Math.round(y);
    var n = bgHash(x, y);
    if ((n & 2) === 0) return;
    System.drawPixel(x + (n >>> 5) % 9 - 4, y + (n >>> 9) % 9 - 4,
                     POEIRA[(n >>> 13) & 1]);
}

// celula da nebulosa: a origem (x, y) vem do grid de 64 px do parallax; a
// celula da folha (bg0..bg15) e o modulo de 256 px do scroll na origem.
// O stamp de regiao fecha o recorte do sistema; nao ha o que restaurar
// aqui (o painter restaura a arena depois da camada inteira).
function paintBgCell(x, y) {
    var ix = Math.floor(mod(x + E.cam.x * BG_SPEED, 256) / 64);
    var iy = Math.floor(mod(y + E.cam.y * BG_SPEED, 256) / 64);
    _bgO.scale = 1;
    // fora da camada suja: o stamp nao pode registrar a caixa da celula
    // (a celula e so fundo; quem manda no que apagar e o indice do jogo)
    E.dirty._mute++;
    E.spr.stamp("bg" + (iy * 4 + ix), x, y, _bgO);
    E.dirty._mute--;
}

var bgImgLayer = E.fx.parallax([
    { speed: BG_SPEED, gap: 64, rowH: 64, paint: paintBgCell }
]);
var bgProcLayer = E.fx.parallax([
    { speed: 0.05, gap: 64, rowH: 64, paint: paintNebulosa }
]);
var dustLayer = E.fx.parallax([
    { speed: 0.12, gap: 32, rowH: 32, paint: paintPoeira }
]);

// painter da camada suja: PRIMEIRO o preto (o contrato do painter e
// repintar a caixa inteira; so as celulas do parallax deixariam o desenho
// velho aparecendo — a nave virava fantasma), depois a nebulosa e a
// poeira. A caixa e recortada antes da arte; o stamp de celula fecha o
// recorte, entao ele e reposto (arena) ou limpo (faixa do HUD no fim de
// um veu) antes da poeira.
// nebulosa ancorada GRAVADA uma vez num sprite do vidro inteiro: o painter
// copia so a caixa (blitSprite, API 34) — antes cada caixa estampava as
// celulas de 64 px que tocava (~60 pushSprite por quadro). Sem slot ou
// firmware velho segue o caminho por celula
var NEB_S = 0;
function bakeNebulosa() {
    if (NEB_S || !HAS_BG || typeof SYS.blitSprite !== "function") return;
    var id = System.createSprite(W, H);
    if (!id) return;
    System.useSprite(id);
    System.fillScreen(C.espaco);
    E.spr.alvo = id;
    for (var by = 0; by < H; by += 64) {
        for (var bx = 0; bx < W; bx += 64) {
            _bgO.scale = 1;
            E.spr.stamp("bg" + ((by / 64 % 4) * 4 + (bx / 64 % 4)), bx, by, _bgO);
        }
    }
    // a poeira entra GRAVADA junto (camera parada): no painter ela rodava
    // o parallax por celula de 32 px DENTRO de cada caixa suja — JS puro
    // (~15 us por chamada de funcao no Duktape) em ~28 caixas por quadro, e
    // so "andava" onde havia caixa (emendas no vidro)
    var cx0 = E.cam.x, cy0 = E.cam.y;
    E.cam.x = 0; E.cam.y = 0;
    dustLayer.draw(0, 0, W, H);
    E.cam.x = cx0; E.cam.y = cy0;
    E.spr.alvo = 0;
    System.useSprite(0);
    NEB_S = id;
}
bakeNebulosa();

function paintFundo(x, y, w, h) {
    if (NEB_S) {
        SYS.blitSprite(NEB_S, x, y, w, h);
        return;
    }
    System.fillRect(x, y, w, h, C.espaco);
    if (HAS_BG) {
        if (E.caps.clip) System.setClip(x, y, w, h);
        bgImgLayer.draw(x, y, w, h);
        if (E.caps.clip) {
            if (y < HUD_H) System.clearClip();
            else System.setClip(0, HUD_H + 1, W, H - HUD_H - 1);
        }
    } else {
        bgProcLayer.draw(x, y, w, h);
    }
    dustLayer.draw(x, y, w, h);
}

// Estrelas em 2 planos, cada campo guardado no E.data (sobrevive as
// cenas). stride espalha os pontos sujos no tempo: a uniao das caixas de
// 60 estrelas por quadro virava a tela inteira e o painel RGB vibrava por
// disputa de banda com o DMA.
E.data.stars = E.fx.stars(Math.round(W / 8), {
    w: W, h: H, vy: 34 * K, stride: 4,
    colors: [0x39E7, 0xC5F9]   // cinza-azulado longe, branco quente perto
});
E.data.starsFar = E.fx.stars(Math.round(W / 12), {
    w: W, h: H, vy: 13 * K, stride: 6,
    colors: [0x18E3, 0x4A69]   // quase apagadas: plano de tras
});

// -------------------------------------------------- emissores (fx) ------
// Fontes REUTILIZADAS: o follow devolve sempre o mesmo objeto (atualizado
// no update), entao o tick dos emissores nao aloca por quadro. O rastro
// so semeia quando a nave anda; o escapamento dos dois propulsores e
// continuo; a carga da supernova acende a aura dourada.
var _ship = { x: 0, y: 0 };
var _nzE = { x: 0, y: 0 };
var _nzD = { x: 0, y: 0 };

var trail = E.fx.trail(function () { return _ship; }, {
    rate: 16, life: 0.35, size: Math.max(2, Math.round(3 * K)),
    colors: [C.cianoD, C.ciano, C.hud]
});
var exE = E.fx.emitter({
    rate: 12, life: 0.22, size: Math.max(1, Math.round(2 * K)),
    speed: 40 * K, speed2: 95 * K, angle: Math.PI / 2, spread: 0.45,
    colors: [C.ciano, C.cianoD, C.branco],
    follow: function () { return _nzE; }
});
var exD = E.fx.emitter({
    rate: 12, life: 0.22, size: Math.max(1, Math.round(2 * K)),
    speed: 40 * K, speed2: 95 * K, angle: Math.PI / 2, spread: 0.45,
    colors: [C.ciano, C.cianoD, C.branco],
    follow: function () { return _nzD; }
});
var carga = E.fx.emitter({
    rate: 9, life: 0.45, size: Math.max(1, Math.round(2 * K)),
    speed: 14 * K, speed2: 48 * K, spread: Math.PI * 2,
    colors: [C.ouro, C.laranja, C.branco],
    follow: function () { return _ship; }
});
trail.on = false;
exE.on = false;
exD.on = false;
carga.on = false;
var cargaT = 0;
var RING_CHEIO = { color: C.ouro, speed: 250 * K, life: 0.45, r0: 10 * K };

// itens do fim (immediate-mode: desenhados e devolvidos no mesmo quadro)
var FIM_ITENS = [{ label: "DE NOVO", value: "again" },
                 { label: "MENU", value: "menu" }];
var FIM_Y = Math.round(H * 0.60);   // abaixo da linha do recorde (sem cobrir)
var FIM_OPTS = { y: FIM_Y };
// no 480 nativo o titulo padrao do E.ui.pause (H*0.24, ts big) encosta no
// primeiro botao (H*0.3): o modulo desenha um espaco e o nosso vai acima
var PAUSA_OPTS = { title: " " };
var _pausaTitulo = { ts: "big", align: "center", color: C.branco, screen: true };

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

// opts compartilhados dos desenhos que rodam TODO quadro (a engine so
// le): um literal por primitiva era lixo para o GC do Duktape
var _barOpt = { fg: C.magenta, bg: C.cinzaD, screen: true };
var _circOpt = { smooth: true, screen: true };
var _screenOpt = { screen: true };
var _toqueOpt = { align: "center", valign: "middle", ts: "tiny", color: C.branco,
                  screen: true };

function drawOrb(o, shx, shy, pulse) {
    var x = Math.round(o.x + shx), y = Math.round(o.y + shy);
    var pulso = 0.5 + 0.5 * Math.sin(o.ph);
    var r = Math.round((26 + pulso * 5 + pulse * 3) * K);
    System.fillSmoothCircle(x, y, r, System.mixColor(C.ouro, C.espaco, 55 - pulso * 25));
    D.add(x - r - 1, y - r - 1, r * 2 + 3, r * 2 + 3);
    if (!drawArt("ai3", x, y, SZ.orbe)) {
        paintOrbe(SZ.orbe, SZ.orbe, x - SZ.orbe / 2, y - SZ.orbe / 2);
    }
}

function drawEnemy(e, shx, shy, ms) {
    var x = Math.round(e.x + shx), y = Math.round(e.y + shy), r;
    if (e.kind === 2) {
        // SENTINELA-MOR: aura, arte do atlas e nucleo pela vida; os
        // escudos orbitando continuam procedurais
        var fast = e.hp < e.hpMax / 2;
        r = Math.round((60 + Math.sin(ms / 110) * 5) * K);
        System.fillSmoothCircle(x, y, r, System.mixColor(C.magenta, C.espaco, fast ? 35 : 55));
        D.add(x - r - 1, y - r - 1, r * 2 + 3, r * 2 + 3);
        if (!drawArt("ai2", x, y, SZ.chefe)) {
            paintOlho(SZ.chefe, SZ.chefe, x - SZ.chefe / 2, y - SZ.chefe / 2);
        }
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
        var sz = e.kind === 1 ? SZ.sentinel : SZ.drone;
        if (!drawArt("ai1", x, y, sz)) {
            if (e.kind === 1) paintOlho(sz, sz, x - sz / 2, y - sz / 2);
            else paintDrone(sz, sz, x - sz / 2, y - sz / 2);
        }
        // nucleo pulsante POR CIMA da arte: animacao sem slot extra
        var nkY = 0, nkR = 3, nkP = 90, nkC = C.magenta;
        if (e.kind === 1) { nkY = 0; nkR = 4; nkP = 130; nkC = C.verde; }
        else if (e.kind === 3) { nkY = 8; nkR = 4; nkP = 70; nkC = C.ouro; }
        System.fillCircle(x, Math.round(y + nkY * K),
                          Math.round((nkR + Math.sin(ms / nkP + e.ph) * 2) * K), nkC);
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
    if (!drawArt("ai0", px, py, SZ.nave)) {
        paintNave(SZ.nave, SZ.nave, px - SZ.nave / 2, py - SZ.nave / 2);
    }
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
    // projeteis do E.combat: o array e o MESMO do modulo (sem copia por
    // quadro); o team separa o traco ciano do inimigo magenta
    var sh = jogo.shots();
    var bl = Math.round(14 * K);
    for (i = 0; i < sh.length; i++) {
        b = sh[i];
        if (b.dead) continue;
        bx = Math.round(b.x + shx);
        by = Math.round(b.y + shy);
        if (b.team === "player") {
            var y0 = by - (bl >> 1);
            System.drawFastVLine(bx, y0, bl, C.ciano);
            System.drawFastVLine(bx + 1, y0 + 2, bl - 4, C.cianoD);
            System.drawPixel(bx, y0 + bl + 1, C.branco);
            D.add(bx - 1, y0 - 1, 4, bl + 4);
        } else {
            var er = Math.max(2, Math.round(b.r));
            System.fillCircle(bx, by, er, C.magenta);
            System.drawPixel(bx, by, C.branco);
            D.add(bx - er - 1, by - er - 1, er * 2 + 3, er * 2 + 3);
        }
    }
}

// barra do chefe (dentro da arena, logo abaixo do HUD: cai na camada suja)
function drawBossBar(s) {
    if (!s.boss) return;
    var bw = Math.min(u(120), W - u(60)), x = Math.round((W - bw) / 2), y = HUD_H + u(5);
    E.gfx.bar(x, y, bw, u(4), s.boss.hp / s.boss.hpMax, _barOpt);
}

// medidor da supernova (canto inferior esquerdo; toque nele detona)
function drawGauge(s, pulse, ms) {
    var cheio = s.charge >= 100;
    var pulso = cheio ? 0.5 + 0.5 * Math.sin(ms / 110) : 0;
    var r = Math.round(GAUGE.r + pulso * 4 * K + pulse * 2 * K);
    // mixColor(a, b, p): p% de a ate b — vazio quase apagado, cheio pulsa
    E.gfx.circle(GAUGE.x, GAUGE.y, r, System.mixColor(C.ouro, C.espaco, cheio ? 30 + pulso * 25 : 82),
                 _circOpt);
    E.gfx.arc(GAUGE.x, GAUGE.y, GAUGE.r * 0.6, GAUGE.r * 0.82, -90,
              -90 + Math.round(s.charge * 3.6), C.ouro, _screenOpt);
    if (cheio) {
        E.gfx.text("TOQUE", GAUGE.x, GAUGE.y, _toqueOpt);
    }
}

// HUD fora do recorte da arena: so repinta quando o que mostra muda
var hudKey = "";
function drawHUD(s, force) {
    var key = s.score + "|" + s.wave + "|" + s.mult + "|" + s.lives + "|" +
              (s.triple > 0 ? Math.ceil(s.triple) : 0) + "|" + hi + "|" + (s.boss ? 1 : 0);
    // o repaint integral (1o quadro, fim de veu) cobre a faixa do HUD com
    // o fundo: a memo tambem cede quando algo tocou o retangulo dela
    if (!force && key === hudKey && !E.dirty.touches(0, 0, W, HUD_H)) return;
    hudKey = key;
    // o HUD fica FORA do recorte: os desenhos dele nao entram na camada
    // suja (as caixas nunca seriam apagadas e o touches acima passaria a
    // ser true todo quadro, matando a memo)
    var don = D.on;
    D.on = false;
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
    D.on = don;
}

// ------------------------------------------------------------- cenas -----

E.run({
    titulo: {
        static: true,
        enter: function () {
            E.cam.reset();
            this.paint = true;   // 1o draw (ou volta do fim) pinta tudo
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
            // durante o veu de entrada o engine redesenha a cena todo
            // quadro; pinta-la seria fillScreen por quadro (o vidro vibra).
            // O veu cobre tudo, entao so marcamos o repaint para o fim.
            if (E._trans) { this.paint = true; return; }
            if (this.paint) {
                this.paint = false;
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
            // botoes ancorados no rodape (sempre cabem) — repintados sozinhos
            // no press quando o fundo ja esta na tela
            this.btn = botoes(H - u(27) * 2 - u(10) - u(12), "JOGAR", "SAIR", C.ciano);
        }
    },

    jogando: {
        fps: 30,   // teto de quadros: sem ele o push corre solto e cintila
        enter: function () {
            E.pause(false);   // a pausa congela os modulos; voltar sempre solta
            E.cam.reset();
            // camada suja com o parallax de fundo: cada caixa apagada
            // repinta so as celulas de nebulosa/poeira que toca (painter),
            // e o HUD fica fora do recorte da arena
            E.dirty.enable(paintFundo);
            E.dirty.clip(0, HUD_H + 1, W, H - HUD_H - 1);
            hudKey = "";
            var s = jogo.state();
            var p = s.player;
            if (p) {   // fontes dos emissores ja na posicao (1o tick do fx
                       // roda antes do update da cena)
                _ship.x = p.x; _ship.y = p.y + 30 * K;
                _nzE.x = p.x - 12 * K; _nzE.y = p.y + 34 * K;
                _nzD.x = p.x + 12 * K; _nzD.y = p.y + 34 * K;
            }
            trail.on = true;
            exE.on = true;
            exD.on = true;
            carga.on = false;
            cargaT = 0;
            if (E.data.musicPos !== undefined) {
                E.audio.music(jogo.SONG, { startMs: E.data.musicPos });   // volta da pausa
                E.data.musicPos = undefined;
            } else if (!E.audio.playing()) {
                E.audio.music(jogo.SONG);
            }
        },
        update: function (dt) {
            var s = jogo.state();
            var p = s.player;
            if (!p) return;
            if (E.input.down) jogo.movePlayer(E.input.dx);
            var spd = dt * (1 + s.intensity * 0.12);
            E.data.stars.update(spd);
            E.data.starsFar.update(spd * 0.6);   // plano de tras mais lento
            jogo.update(dt);

            // fontes dos emissores (objetos fixos: zero alocacao): rastro
            // e aura na nave, escapamento nos dois propulsores
            _ship.x = p.x;
            _ship.y = p.y + 30 * K;
            _nzE.x = p.x - 12 * K;
            _nzE.y = p.y + 34 * K;
            _nzD.x = p.x + 12 * K;
            _nzD.y = p.y + 34 * K;
            // mesma regra do pisca da invulnerabilidade: nave invisivel
            // nao deixa escapamento/rastro no ar
            var vis = p.invuln <= 0 || Math.floor(System.millis() / 90) % 2 === 0;
            trail.on = !s.over && vis;
            exE.on = !s.over && vis;
            exD.on = !s.over && vis;
            carga.on = !s.over && vis && s.charge > 0;
            // medidor cheio: anel de aviso no mestre (pulsa na batida do
            // desenho, sem custo de pool — 1 anel a cada 0,5 s)
            if (s.charge >= 100 && !s.over) {
                cargaT -= dt;
                if (cargaT <= 0) {
                    cargaT = 0.5;
                    E.fx.ring(_ship.x, _ship.y - 18 * K, RING_CHEIO);
                }
            } else {
                cargaT = 0;
            }

            // parallax: o painter roda no _begin (antes do draw) e le a
            // camera; a rolagem vertical vem do voo, a horizontal da nave
            bgY += dt * 90;
            E.cam.y = -bgY;
            E.cam.x = -(p.x - W / 2) * 0.22;

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
        exit: function () {
            // emissores nao semeiam na cena seguinte (o tick do fx roda
            // mesmo com a pausa static por cima da arena congelada)
            trail.on = false;
            exE.on = false;
            exD.on = false;
            carga.on = false;
        },
        draw: function () {
            var s = jogo.state();
            var pulse = beatPulse(), ms = System.millis();
            // zera a camera virtual do parallax: o mundo, as particulas e
            // os textos flutuantes seguem nas mesmas coords de sempre
            E.cam.x = 0;
            E.cam.y = 0;
            // (a engine ja apagou as caixas do quadro anterior)
            E.data.stars.draw();
            E.data.starsFar.draw();
            drawGame(s, pulse);
            drawBossBar(s);
            drawGauge(s, pulse, ms);
            E.fx.draw();
            E.dirty.unclip();
            drawHUD(s, false);
        }
    },

    pausa: {
        // E.ui.pause (dep celeros.game.ui) desenha o veu + Continuar/
        // Recomecar/Sair sobre a arena congelada; a cena continue static
        // (1 draw + repintura no press). A trilha para e volta do ponto.
        // E.pause(true) congela o tick dos MODULOS: sem isso o E.combat
        // seguia movendo os tiros e o E.waves nascendo inimigo atras do veu.
        static: true,
        enter: function () {
            E.pause(true);
            E.audio.stop();
            this.act = null;
        },
        exit: function () {
            E.pause(false);
        },
        update: function () {
            var a = this.act;
            if (!a) return;
            this.act = null;
            if (a === "resume") {
                E.audio.sfx("ui");
                E.goto("jogando");
            } else if (a === "restart") {
                E.audio.sfx("ok");
                E.data.musicPos = undefined;   // recomeca a trilha do zero
                jogo.reset();
                E.goto("jogando");
            } else {
                E.audio.sfx("ui");
                System.exitApp();
            }
        },
        draw: function () {
            var a = E.ui.pause(PAUSA_OPTS);
            if (a) this.act = a;   // a acao chega no proximo update
            // titulo proprio acima do primeiro botao (o padrao do modulo
            // fica coberto no 480 nativo)
            E.gfx.text("PAUSA", W / 2, Math.round(H * 0.13), _pausaTitulo);
        }
    },

    fim: {
        static: true,
        enter: function () {
            this.t = 0;
            this.paint = true;
            this.act = null;
            this.newBest = E.save.best("hi", jogo.state().score);
            if (this.newBest) {
                hi = jogo.state().score;
                E.audio.sfx("record");
            }
        },
        update: function (dt) {
            this.t += dt;
            if (this.t < 0.5 || !this.act) return;   // engole o tap do momento da morte
            var a = this.act;
            this.act = null;
            if (a === "again") {
                E.audio.sfx("ok");
                jogo.reset();
                E.goto("jogando", { transition: "wipe", ms: 300 });
            } else {
                E.audio.sfx("ui");
                E.goto("titulo", { transition: "fade", ms: 300 });
            }
        },
        draw: function () {
            var s = jogo.state();
            // o veu do iris cobre a tela: durante ele nao pinta (o engine
            // redesenha a cena todo quadro) e marca o repaint integral para
            // quando o veu sair — sem isso o fundo/textos ficavam pretos
            if (E._trans) { this.paint = true; return; }
            if (this.paint) {
                this.paint = false;
                drawFundo(false);
                var y = Math.round(H * 0.16);
                E.gfx.text("NAVE PERDIDA", W / 2, y, { align: "center", px: u(21), fit: W - u(24),
                           color: C.magenta, screen: true });
                y += u(34);
                E.gfx.text(String(s.score), W / 2, y, { align: "center", px: u(30),
                           color: C.branco, screen: true });
                y += u(36);
                E.gfx.text("onda " + s.wave + "   " + s.kills + " abates", W / 2, y,
                           { align: "center", ts: "label", fit: W - u(16),
                             color: C.cinza, screen: true });
                y += u(18);
                E.gfx.text(this.newBest ? "NOVO RECORDE!" : "recorde " + hi, W / 2, y,
                           { align: "center", ts: "label",
                             color: this.newBest ? C.ouro : C.cinza, screen: true });
            }
            // menu immediate-mode da dep ui: mesma linguagem do pause, com
            // o recorde/NVS decidido UMA vez no enter (nada de reavaliar)
            var a = E.ui.menu(FIM_ITENS, FIM_OPTS);
            if (this.t >= 0.5 && a) this.act = a;
        }
    }
}, "titulo");
