// CelerOS Cubo 3D — cubo interativo (CelerKit UI 2.0, sem engine).
// Arraste gira, pinca aproxima (System.getTouches, UMA leitura por quadro),
// toque no cubo/chip troca solido <-> arestas e o rodape mostra os FPS.
// O canvas e uma area pintada pelo app: A.custom (UI.custom nativo nas S3,
// caminho base na CYD) redesenha so o retangulo do cubo; o chrome (header,
// chip, FPS) e pintado direto com System.* — um laco de multitoque nao pode
// usar UI.begin (ele consome um quadro de toque por chamada). Sem cor fixa:
// tokens do A.style. ES5 (Duktape).

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
A.init();
A.style.preset("soft");
var T = A.style.T;
var S = System;
// nucleo do hub (1.1.0) pode nao ter A.custom: cai no frame total do canvas
var CUSTOM = !!(A.custom && A.custom.call);
var L = A.L;
// tamanho virtual do vidro (240x320; o canvas nativo muda so nas S3)
var SW = S.screenWidth(), SH = S.screenHeight();

// ---- layout -----------------------------------------------------------------
var CX = L.x;                       // canvas do cubo
var HDR = 40;                       // faixa do header pintada pelo app
var CY = 74;
var CW = L.w;
var FOOT = L.bottom - 8;            // 304 no retangular; sobe no watch redondo
var CH = FOOT - 6 - CY;
// chip de modo e X alinhados a direita do vidro (nada de x fixo: o watch
// redondo e mais estreito na area util)
var CHIP_W = 78, CHIP_H = 24, CHIP_Y = 8;
var CHIP_X = SW - 8 - 24 - 6 - CHIP_W;
var XBTN = SW - 8 - 24;

// ---- geometria --------------------------------------------------------------
var V = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]
];
var FACES = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 5, 1, 0],
             [3, 2, 6, 7], [4, 0, 3, 7], [1, 5, 6, 2]];
var EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4,
             0, 4, 1, 5, 2, 6, 3, 7];
// frente, tras, topo, base, esquerda, direita — todos tokens do tema; a
// esquerda usa textDim (o raised ficava quase invisivel contra o fundo)
var FCOL = [T.accent, T.accentD, T.ok, T.warn, T.textDim, T.accentD];

var angleX = 0.5, angleY = 0.7;
var zoom = 1;
var wire = false;
var fps = 0, frames = 0, fpsAt = System.millis();

// ---- toque (uma leitura por quadro) -----------------------------------------
var nPrev = 0, sx = 0, sy = 0, lx = 0, ly = 0, moved = false, downAt = 0;
var lastDist = 0, lastAct = 0;

function dist2(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}
function toggleMode() {
    wire = !wire;
    UI.invalidate();
}
function tapAt(x, y) {
    if (y < HDR) {                       // header: chip de modo e X
        if (x >= CHIP_X && x <= CHIP_X + CHIP_W &&
            y >= CHIP_Y && y <= CHIP_Y + CHIP_H) { toggleMode(); return; }
        if (x >= XBTN && x <= XBTN + 24 && y >= 8 && y <= 32) { S.exitApp(); return; }
        return;
    }
    if (x >= CX && x <= CX + CW && y >= CY && y <= CY + CH) toggleMode();
}
function poll(now) {
    var ts = S.getTouches();
    var n = ts.length;
    if (n > 0 && nPrev === 0) {          // pousou: ancora o arrasto
        sx = lx = ts[0].x;
        sy = ly = ts[0].y;
        moved = false;
        downAt = now;
        lastDist = 0;
    }
    if (n > 0) {
        if (n >= 2) {                    // pinca: zoom pela distancia entre dedos
            var d = dist2(ts[0], ts[1]);
            if (lastDist > 0) {
                zoom = Math.max(0.7, Math.min(1.3, zoom * d / lastDist));
                moved = true;
            }
            lastDist = d;
            lx = ts[0].x;
            ly = ts[0].y;
        } else if (nPrev === 1) {        // arrasto de um dedo gira
            if (Math.abs(ts[0].x - sx) + Math.abs(ts[0].y - sy) > 8) moved = true;
            angleY += (ts[0].x - lx) * 0.012;
            angleX += (ts[0].y - ly) * 0.012;
            lx = ts[0].x;
            ly = ts[0].y;
        } else {                         // saiu da pinca: reancora
            lx = ts[0].x;
            ly = ts[0].y;
            lastDist = 0;
        }
        lastAct = now;
    } else if (nPrev > 0 && !moved && now - downAt < 450) {
        tapAt(sx, sy);
    }
    nPrev = n;
}

// ---- canvas do cubo ---------------------------------------------------------
function drawCube(x, y, w, h) {
    var cx = x + w / 2, cy = y + h / 2 - 4;
    var fov = 170 * zoom * (w / 224), dist = 5.2;   // encolhe no vidro estreito
    var sinX = Math.sin(angleX), cosX = Math.cos(angleX);
    var sinY = Math.sin(angleY), cosY = Math.cos(angleY);
    var proj = [];

    S.fillRect(x, y, w, h, T.bg);
    S.drawRoundRect(x + 1, y + 1, w - 2, h - 2, 12, T.stroke);

    for (var i = 0; i < 8; i++) {
        var vx = V[i][0], vy = V[i][1], vz = V[i][2];
        var x1 = vx * cosY - vz * sinY;
        var z1 = vx * sinY + vz * cosY;
        var y2 = vy * cosX - z1 * sinX;
        var z2 = vy * sinX + z1 * cosX;
        var zd = z2 + dist;
        if (zd < 0.6) zd = 0.6;
        proj.push({ x: cx + x1 * fov / zd, y: cy + y2 * fov / zd, z: zd });
    }

    if (wire) {
        for (var e = 0; e < EDGES.length; e += 2) {
            var a = proj[EDGES[e]], b = proj[EDGES[e + 1]];
            S.drawWideLine(a.x, a.y, b.x, b.y, 2, T.accent);
        }
        for (var k = 0; k < 8; k++) S.fillCircle(proj[k].x, proj[k].y, 2, T.text);
        return;
    }

    // faces ordenadas por profundidade (algoritmo do pintor); as de tras
    // sao descartadas pelo sentido do poligono na tela (culling)
    var order = [];
    for (var f = 0; f < FACES.length; f++) {
        var p = proj[FACES[f][0]], q = proj[FACES[f][1]];
        var r = proj[FACES[f][2]], s2 = proj[FACES[f][3]];
        var area = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
        if (area <= 0) continue;
        order.push({ p: p, q: q, r: r, s: s2, i: f,
                     z: (p.z + q.z + r.z + s2.z) / 4 });
    }
    order.sort(function (a2, b2) { return b2.z - a2.z; });
    for (var oi = 0; oi < order.length; oi++) {
        var o = order[oi];
        var pct = Math.max(0, Math.min(42, Math.round((o.z - 4.4) * 22)));
        var col = S.mixColor(FCOL[o.i], T.bg, pct);
        S.fillTriangle(o.p.x, o.p.y, o.q.x, o.q.y, o.r.x, o.r.y, col);
        S.fillTriangle(o.p.x, o.p.y, o.r.x, o.r.y, o.s.x, o.s.y, col);
        // cobre a costura entre os dois triangulos (1px na diagonal p-r)
        S.drawWideLine(o.p.x, o.p.y, o.r.x, o.r.y, 2, col);
        S.drawLine(o.p.x, o.p.y, o.q.x, o.q.y, T.bg);
        S.drawLine(o.q.x, o.q.y, o.r.x, o.r.y, T.bg);
        S.drawLine(o.r.x, o.r.y, o.s.x, o.s.y, T.bg);
        S.drawLine(o.s.x, o.s.y, o.p.x, o.p.y, T.bg);
    }
}

// ---- chrome (pintado direto, sempre) ----------------------------------------
function chrome(now) {
    // laco manual: nao ha UI.begin/fillScreen. Pinta as faixas que o canvas
    // nao cobre (entre o header e o cubo, margens e rodape) para nao sobrar
    // pixel do app anterior no vidro.
    S.fillRect(0, HDR, SW, CY - HDR, T.bg);
    S.fillRect(0, CY, CX, CH, T.bg);
    S.fillRect(CX + CW, CY, SW - CX - CW, CH, T.bg);
    S.fillRect(0, CY + CH, SW, SH - (CY + CH), T.bg);

    S.fillRect(0, 0, SW, HDR, T.card);
    S.fillGradient(0, 0, SW, HDR, S.mixColor(T.card, 0xFFFFFF, 6), T.card, 0);
    S.setTextDatum(0);
    S.setTextColor(T.text, T.card);
    S.drawString("Cubo 3D", 12, 10, 2);
    S.setTextColor(T.textDim, T.card);
    S.drawString(fps + " fps", 12, 27, 1);

    // chip solido/arestas
    S.fillRoundRect(CHIP_X, CHIP_Y, CHIP_W, CHIP_H, 12, wire ? T.raised : T.accent);
    S.drawRoundRect(CHIP_X, CHIP_Y, CHIP_W, CHIP_H, 12, wire ? T.accent : T.stroke);
    S.setTextDatum(5);                   // MC
    S.setTextColor(wire ? T.accent : T.onAccent);
    S.drawString(wire ? "Arestas" : "Sólido", CHIP_X + CHIP_W / 2, CHIP_Y + CHIP_H / 2, 1);
    S.setTextDatum(0);

    // X: sai do app
    S.fillRoundRect(XBTN, 8, 24, 24, 12, T.raised);
    A.icons.draw("close", XBTN + 4, 12, 16, { color: T.text });

    S.fillRect(0, HDR - 1, SW, 1, T.stroke);
    S.setTextColor(T.textDim, T.bg);
    S.setTextDatum(1);                   // TC
    S.drawString("arraste gira · pinça aproxima", SW / 2, FOOT, 1);
    S.setTextDatum(0);
}

// ---- laco -------------------------------------------------------------------
// Laco manual (sem A.run): no caminho base do A.custom o canvas e sempre
// frame total (a CYD repinta o retangulo do cubo inteiro; nas S3 o UI.custom
// nativo ignora este flag e redesenha so quando a assinatura muda).
A.full = true;
var last = System.millis();
for (;;) {
    var now = System.millis();
    var dt = now - last;
    if (dt > 60) dt = 60;
    last = now;

    poll(now);
    if (!nPrev && now - lastAct > 2500) {    // gira sozinho parado
        angleX += dt * 0.0006;
        angleY += dt * 0.0009;
    }
    var PI2 = Math.PI * 2;
    angleX = ((angleX % PI2) + PI2) % PI2;
    angleY = ((angleY % PI2) + PI2) % PI2;

    chrome(now);

    // assinatura: so repinta o canvas quando o cubo mudou de verdade
    // (escala 1/2000: o giro automatico tambem anda em quadro cheio)
    var sig = (wire ? "w" : "s") + Math.round(angleX * 2000) + ":" +
              Math.round(angleY * 2000) + ":" + Math.round(zoom * 100);
    if (CUSTOM) A.custom("cube", CX, CY, CW, CH, sig, drawCube, { bg: T.bg });
    else drawCube(CX, CY, CW, CH);        // sem A.custom: pinta o canvas todo quadro

    frames++;
    if (now - fpsAt >= 500) {
        fps = Math.round(frames * 1000 / (now - fpsAt));
        frames = 0;
        fpsAt = now;
    }
    S.delay(30);
}
