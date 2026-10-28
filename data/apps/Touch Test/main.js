// CelerOS Touch Test — valida display (barras RGB + rampa de cinza), touch
// (rastro continuo, coords vivas, min/max), MULTITOUQUE (API 43: um rastro
// por dedo, dedos simultaneos, distancia de pinch e pressao) e a topbar
// custom da API 6. Card de informacoes do aparelho e faixa de sistema com
// chips (+ e Limpar). Toque no X (canto sup. direito) para sair.
//
// 2.0.0 — visual do CelerKit: tokens do A.style (cards/divisores/icone),
// areas estaticas no A.custom com assinatura (barras, rampa, card do
// aparelho e instrucao) e o rastro dos dedos desenhado direto no vidro a
// cada quadro. UMA leitura de toque por frame: System.getTouches (indice 0 =
// primario) e, em firmware sem multitoque, System.getTouch. A cor de cada
// dedo vem do tema (nada de RGB fixo fora das barras de teste, que sao o
// proprio alvo do teste).
//
// O app NAO usa A.run/UI.begin: o UI.begin consome um quadro de toque pelo
// System.getTouch e o multitoque precisa do getTouches — duas leituras por
// frame comeriam o pouso dos dedos. O frame e este laco com System.delay.

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
A.init();

var T = A.style.T;
var L = A.style.content();          // margem segura do vidro (redondo encolhe)
var LX = L.x, LW = L.w;
var W = System.screenWidth();
var H = System.screenHeight();

if (typeof System.keepAwake === "function") {
    try { System.keepAwake(300000); } catch (e0) {}
}

var multi = typeof System.getTouches === "function";   // API 43
var CUSTOM = !!(A.custom && A.custom.call);            // kit antigo: desenha direto

var touches = 0;
var samples = 0;
var minX = 9999, maxX = -1, minY = 9999, maxY = -1;
var rate = 0;
var lastPt = { x: 0, y: 0 };
var trail = {};       // id do dedo -> ultima posicao
var ativo = {};       // ids pressionados agora (deteccao de pousada nova)
var dedos = 0;        // dedos simultaneos agora
var maxDedos = 0;     // recorde da sessao
var pinchD = 0;       // distancia entre os 2 primeiros dedos (px)
var pressao = 0;      // tamanho/pressao do dedo primario (0 = sem dado)

// cor por dedo: o rastro de cada um numa cor do TEMA (5 dedos)
var CORES = [T.accent, T.ok, T.warn, T.err, T.text];
var BLANCO = System.color(255, 255, 255);

function fmtBar() {
    return "Toques: " + touches + "  amostras/s: " + rate;
}

function info() {
    var i = System.getInfo();
    var kb = function (n) { return n >= 1024 ? Math.round(n / 1024) + "KB" : n + "B"; };
    return [
        "CelerOS " + System.getOSVersion() + "  API " + System.getAPILevel(),
        i.chipModel + " x" + i.chipCores + " @" + i.cpuFreqMHz + "MHz",
        "RAM " + kb(i.freeRAM) + "/" + kb(i.totalRAM) +
            (i.totalPSRAM ? "  PSRAM " + kb(i.freePSRAM) : ""),
        i.idfVersion
    ];
}

function dist2(a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
}

// ---- areas estaticas (A.custom com assinatura; desenham 1x) ----------------
function drawBars() {
    // Barras verticais no topo: R | G | B | branco (confere ordem e niveis).
    // Cor fixa e o alvo do teste de display — nao e tema.
    System.fillRect(0, 26, W / 4, 54, System.color(255, 0, 0));
    System.fillRect(W / 4, 26, W / 4, 54, System.color(0, 255, 0));
    System.fillRect((2 * W) / 4, 26, W / 4, 54, System.color(0, 0, 255));
    System.fillRect((3 * W) / 4, 26, W - (3 * W) / 4, 54, BLANCO);
    // Rampa de cinza em 16 niveis (2 linhas de 8): confere banding/quantizacao
    for (var g = 0; g < 16; g++) {
        var v = Math.round((g * 255) / 15);
        System.fillRect((g % 8) * (W / 8), 84 + Math.floor(g / 8) * 12,
                        W / 8, 12, System.color(v, v, v));
    }
    A.style.divider(0, 110, W, { color: T.stroke });
}

function drawInstr() {
    System.setTextColor(T.text);
    System.drawString("arraste na área abaixo", LX, 184, 2);
    System.setTextColor(T.textDim);
    System.drawString(multi ? "cada dedo numa cor · pressão e dist." :
                      "um dedo por vez (firmware antigo)", LX, 204, 1);
}

function drawInfo() {
    System.fillRoundRect(LX, 114, LW, 62, 10, T.card);
    System.drawRoundRect(LX, 114, LW, 62, 10, T.stroke);
    A.style.icon("info", LX + 8, 122, 16, { color: T.accent });
    System.setTextColor(T.textDim);
    System.drawString("dispositivo", LX + 30, 124, 1);
    var inf = info();
    System.setTextColor(T.text);
    for (var i = 0; i < inf.length && i < 4; i++) {
        System.drawString(inf[i], LX + 8, 138 + i * 10, 1);
    }
}

var needStatic = true;
var gen = 0;          // limpar incrementa: forca repintar as areas estaticas
function paintStatic() {
    if (CUSTOM) {
        A.custom("bars", 0, 26, W, 86, "bars" + gen, drawBars, { bg: T.bg, clear: true });
        A.custom("instr", 0, 180, W, 36, "instr" + gen, drawInstr, { bg: T.bg, clear: true });
        A.custom("info", LX, 114, LW, 62, "dev" + gen, drawInfo, { bg: T.bg, clear: true });
    } else {
        drawBars(); drawInstr(); drawInfo();
    }
}

// ---- painel de estatisticas vivas (redesenhado quando algo muda) ------------
function drawStats() {
    System.fillRect(0, H - 44, W, 44, T.bg);
    System.setTextColor(T.accent);
    System.drawString("x " + lastPt.x + "  y " + lastPt.y, LX, H - 42, 2);
    if (pinchD > 0) {
        System.setTextColor(T.text);
        System.drawString("dist " + Math.round(pinchD) + "px", W - 88, H - 40, 1);
    }
    System.setTextColor(T.textDim);
    var range = "x " + (minX === 9999 ? "-" : minX + "-" + maxX) +
                "  y " + (minY === 9999 ? "-" : minY + "-" + maxY);
    System.drawString(range, LX, H - 24, 1);
    System.drawString("pressão " + (pressao > 0 ? pressao : "-"), W - 78, H - 24, 1);
    System.setTextColor(T.textDim);
    System.drawString("dedos " + dedos + " · rec " + maxDedos, LX, H - 12, 1);
    System.drawString(rate + " amostras/s", W - 86, H - 12, 1);
}

function marcar(p) {
    samples++;
    if (!ativo[p.id]) {
        ativo[p.id] = true;
        touches++;
        if (p.id === 0) {
            System.print("TouchTest: x=" + p.x + " y=" + p.y);
            redraw = true;
        }
    }
    var c = CORES[p.id % CORES.length];
    var ant = trail[p.id];
    if (ant) System.drawLine(ant.x, ant.y, p.x, p.y, c);
    var rad = 2 + Math.min(6, Math.floor((p.size || 0) / 32));
    System.fillCircle(p.x, p.y, rad, c);
    trail[p.id] = { x: p.x, y: p.y };
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
}

// faixa do sistema: texto custom + chips (API 6)
System.topbarButtons(["+", "Limpar"]);
System.fillScreen(T.bg);
System.topbarText(fmtBar());

var rateWin = System.millis();
var redraw = false;
var prevDedos = 0;

while (true) {
    var ts = null;
    var prim = null;
    if (multi) {
        ts = System.getTouches();          // UNICA leitura do frame (id 0 = primario)
        if (ts.length) prim = ts[0];
    } else {
        var t1 = System.getTouch();
        if (t1.touched) prim = { id: 0, x: t1.x, y: t1.y, size: 0 };
    }
    dedos = prim ? (multi ? ts.length : 1) : 0;
    if (dedos > maxDedos) maxDedos = dedos;
    pinchD = (multi && ts.length >= 2) ? dist2(ts[0], ts[1]) : 0;

    if (multi) {
        var vivos = {};
        for (var i = 0; i < ts.length; i++) {
            vivos[ts[i].id] = true;
            marcar(ts[i]);
        }
        for (var k in trail) if (!vivos[k]) delete trail[k];
        for (var k2 in ativo) if (!vivos[k2]) delete ativo[k2];
        pressao = prim ? (prim.size || 0) : 0;
    } else if (prim) {
        marcar(prim);
        pressao = 0;
    } else {
        delete ativo[0];
        pressao = 0;
    }
    if (prim) { lastPt.x = prim.x; lastPt.y = prim.y; redraw = true; }
    if (dedos !== prevDedos) { prevDedos = dedos; redraw = true; }
    if (redraw) {
        System.topbarText(fmtBar());
        drawStats();
        redraw = false;
    }

    var now = System.millis();
    if (now - rateWin >= 1000) {
        rate = samples;          // amostras no ultimo segundo
        samples = 0;
        rateWin = now;
        System.topbarText(fmtBar());
        drawStats();
    }

    // chips da faixa: "+" soma 10, "Limpar" zera tudo e redesenha o fundo
    var id = System.topbarPop();
    if (id === "+") {
        touches += 10;
        System.topbarText(fmtBar());
        redraw = true;
    } else if (id === "Limpar") {
        touches = 0;
        minX = minY = 9999; maxX = maxY = -1;
        trail = {};
        ativo = {};
        maxDedos = 0;
        pinchD = 0;
        pressao = 0;
        System.fillScreen(T.bg);
        gen++;
        needStatic = true;
        System.topbarText(fmtBar());
        redraw = true;
    }

    if (needStatic) {
        needStatic = false;
        paintStatic();
        drawStats();
    }

    System.delay(10);
}
