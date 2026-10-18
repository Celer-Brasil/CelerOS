// CelerOS Touch Test — valida display (barras RGB + rampa de cinza), touch
// (rastro continuo, coords vivas, min/max), MULTITOUCH (API 43: um rastro
// por dedo, dedos simultaneos e distancia de pinch) e a topbar custom da
// API 6. Card de informacoes do aparelho ao vivo. Toque no X (canto sup.
// direito) para sair.

var T = System.theme();
var W = System.screenWidth();
var H = System.screenHeight();

if (typeof System.keepAwake === "function") {
    try { System.keepAwake(300000); } catch (e) {}
}

var touches = 0;
var samples = 0;
var minX = 9999, maxX = -1, minY = 9999, maxY = -1;
var last = null;      // ultimo ponto do rastro do primario (legado)
var rate = 0;
var lastPt = { x: 0, y: 0 };
var multi = typeof System.getTouches === "function";  // API 43
var trail = {};       // id do dedo -> ultima posicao (rastro por dedo)
var ativo = {};       // ids pressionados agora (deteccao de pousada nova)
var dedos = 0;        // dedos simultaneos agora
var maxDedos = 0;     // recorde da sessao
var pinchD = 0;       // distancia entre os 2 primeiros dedos (px)
var YELLOW = System.color(255, 255, 0);
var BLACK = System.color(0, 0, 0);
var WHITE = System.color(255, 255, 255);
// cor por dedo: o rastro de cada um numa cor
var CORES = [YELLOW,
             System.color(255, 0, 255),
             System.color(0, 255, 255),
             System.color(0, 255, 0),
             System.color(255, 120, 0)];

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

function draw() {
    System.fillScreen(BLACK);

    // Barras verticais no topo: R | G | B | branco (confere ordem e niveis)
    System.fillRect(0, 26, W / 4, 54, System.color(255, 0, 0));
    System.fillRect(W / 4, 26, W / 4, 54, System.color(0, 255, 0));
    System.fillRect((2 * W) / 4, 26, W / 4, 54, System.color(0, 0, 255));
    System.fillRect((3 * W) / 4, 26, W - (3 * W) / 4, 54, WHITE);

    // Rampa de cinza em 16 niveis (2 linhas de 8): confere banding/quantizacao
    for (var g = 0; g < 16; g++) {
        var v = Math.round((g * 255) / 15);
        System.fillRect((g % 8) * (W / 8), 84 + Math.floor(g / 8) * 12,
                        W / 8, 12, System.color(v, v, v));
    }

    // card de informacoes
    System.fillRoundRect(6, 118, W - 12, 62, 8, T.card);
    System.setTextColor(T.textDim, T.card);
    System.drawString("dispositivo", 16, 124, 1);
    var inf = info();
    System.setTextColor(T.text, T.card);
    for (var i = 0; i < inf.length && i < 4; i++) {
        System.drawString(inf[i], 16, 136 + i * 11, 1);
    }

    System.setTextColor(WHITE, BLACK);
    System.drawString("arraste na area abaixo", 8, 192, 2);
    System.setTextColor(T.textDim, BLACK);
    System.drawString(multi ? "multitoque: cada dedo numa cor" :
                      "chips na faixa de cima testam a API", 8, 214, 1);
    System.print("TouchTest: tela " + W + "x" + H);
}

// painel de estatisticas vivas (redesenhado a cada toque novo / dedo a mais
// ou a menos)
function drawStats() {
    System.fillRect(0, H - 44, W, 44, BLACK);
    System.setTextColor(T.accent, BLACK);
    System.drawString("x " + lastPt.x + "  y " + lastPt.y, 10, H - 40, 2);
    if (pinchD > 0) {
        System.setTextColor(WHITE, BLACK);
        System.drawString("pinch " + Math.round(pinchD) + "px", W - 74, H - 38, 1);
    }
    System.setTextColor(T.textDim, BLACK);
    var range = "faixa x " + (minX === 9999 ? "-" : minX + "-" + maxX) +
                "  y " + (minY === 9999 ? "-" : minY + "-" + maxY);
    if (multi) range += "  dedos " + dedos + " max " + maxDedos;
    System.drawString(range, 10, H - 22, 1);
}

// faixa do sistema: texto custom + chips (API 6)
System.topbarButtons(["+", "Limpar"]);
draw();
System.topbarText(fmtBar());
drawStats();

var rateWin = System.millis();
var redraw = false;
var prevDedos = 0;
while (true) {
    var ts = multi ? System.getTouches() : null;
    var prim = null;
    if (multi) {
        if (ts.length) prim = ts[0];
    } else {
        var t1 = System.getTouch();
        if (t1.touched) prim = { id: 0, x: t1.x, y: t1.y, size: 0 };
    }
    dedos = prim ? (multi ? ts.length : 1) : 0;
    if (dedos > maxDedos) maxDedos = dedos;
    pinchD = (multi && ts.length >= 2) ? dist2(ts[0], ts[1]) : 0;

    if (multi) {
        // rastro POR dedo: cada id numa cor; pousada nova conta toque
        var vivos = {};
        for (var i = 0; i < ts.length; i++) {
            var p = ts[i];
            vivos[p.id] = true;
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
            System.fillCircle(p.x, p.y, 3, c);
            trail[p.id] = { x: p.x, y: p.y };
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
        for (var k in trail) if (!vivos[k]) delete trail[k];
        for (var k2 in ativo) if (!vivos[k2]) delete ativo[k2];
    } else if (prim) {
        // legado (API < 43): rastro amarelo de 1 ponto, como sempre
        samples++;
        if (!ativo[0]) {
            ativo[0] = true;
            touches++;
            System.print("TouchTest: x=" + prim.x + " y=" + prim.y);
            redraw = true;
        }
        if (last) System.drawLine(last.x, last.y, prim.x, prim.y, YELLOW);
        System.fillCircle(prim.x, prim.y, 3, YELLOW);
        last = { x: prim.x, y: prim.y };
        if (prim.x < minX) minX = prim.x;
        if (prim.x > maxX) maxX = prim.x;
        if (prim.y < minY) minY = prim.y;
        if (prim.y > maxY) maxY = prim.y;
    } else {
        last = null;
        delete ativo[0];
    }
    if (prim) { lastPt.x = prim.x; lastPt.y = prim.y; }
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
    }

    // chips da faixa: "+" soma 10, "Limpar" zera tudo e redesenha o fundo
    var id = System.topbarPop();
    if (id === "+") {
        touches += 10;
        System.topbarText(fmtBar());
    } else if (id === "Limpar") {
        touches = 0;
        minX = minY = 9999; maxX = maxY = -1;
        trail = {};
        ativo = {};
        maxDedos = 0;
        pinchD = 0;
        draw();
        System.topbarText(fmtBar());
        drawStats();
    }

    System.delay(10);
}
