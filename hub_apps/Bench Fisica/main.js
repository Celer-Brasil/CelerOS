// Bench Fisica 2.0 — mede o verlet nos DOIS caminhos com a MESMA cena: JS
// puro no Duktape (aqui dentro, sem dep) x nativo (System.verletNew/step,
// API 31 — mundo em buffers C++). A execucao e fatiada em blocos por quadro
// (progresso na tela e a janela de 1 s do exec-timeout nunca fecha) e o
// tempo e medido por System.micros em volta SO dos steps, sem o desenho.
//
// Sem o binding nativo (firmware < 31 ou build sem CONFIG_CELEROS_JS_PHYSICS,
// como a CYD lite) o app roda so o lado JS e explica: nao e erro, e a
// comparacao dizendo que o acelerador nao esta nesta placa. "Registrar"
// grava a linha do resultado no espaco privado e tambem no logcat.

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");

A.init();
var HAS_DISP = true;
try { HAS_DISP = System.getInfo().hasDisplay !== false; } catch (e) {}
if (HAS_DISP) A.style.preset("soft");
var T = A.style.T;

var LX = A.L.x, LW = A.L.w, CX = A.L.cx, BOT = A.L.bottom;
var HAS_NAT = typeof System.verletNew === "function" &&
              typeof System.verletStep === "function" &&
              typeof System.verletAddPoint === "function" &&
              typeof System.verletStick === "function" &&
              typeof System.verletPin === "function" &&
              typeof System.verletFree === "function";
var DATA = "/local/";
try { if (FS.appData) DATA = FS.appData() || "/local/"; } catch (e) { DATA = "/local/"; }

// ---- cena (a mesma nos dois lados) ----------------------------------------
// 3 cordas (14 nos, topo pinado), pano 8x6 (3 pinos) e pontos soltos ate 120.
// As posicoes dos soltos sao sorteadas UMA vez: os dois mundos recebem a
// mesma cena (senao o A/B compararia desenhos diferentes).
var NOS = 120, HASTES = 121, ITER = 4;
var SOLTOS = [];
(function sorteia() {
    var n = NOS - 42 - 48;
    for (var i = 0; i < n; i++) SOLTOS.push([10 + Math.random() * 220, 60 + Math.random() * 160]);
})();

function montar(w) {
    var i, j, r, c;
    for (c = 0; c < 3; c++) {
        var x0 = 36 + c * 80, prev = -1;
        for (i = 0; i < 14; i++) {
            var idx = w.add(x0, 20 + i * 13);
            if (i === 0) w.pin(idx);
            if (prev >= 0) w.stick(prev, idx, 13);
            prev = idx;
        }
    }
    var cols = 8, rows = 6, px = (240 - cols * 15) / 2;
    for (r = 0; r < rows; r++) {
        for (j = 0; j < cols; j++) {
            var p = w.add(px + j * 15, 24 + r * 15);
            if (r === 0 && (j === 0 || j === 4 || j === cols - 1)) w.pin(p);
            if (j > 0) w.stick(p - 1, p, 15);
            if (r > 0) w.stick(p - cols, p, 15);
        }
    }
    for (i = 0; i < SOLTOS.length; i++) w.add(SOLTOS[i][0], SOLTOS[i][1]);
    return w;
}

// ---- verlet JS (mesma matematica do celeros.physics, inline) ---------------
function jsWorld() {
    var w = { pts: [], sticks: [] };
    w.add = function (x, y) {
        w.pts.push({ x: x, y: y, px: x, py: y, pin: false });
        return w.pts.length - 1;
    };
    w.stick = function (a, b, len) {
        if (len === undefined) {
            var A0 = w.pts[a], B0 = w.pts[b];
            len = Math.sqrt((A0.x - B0.x) * (A0.x - B0.x) + (A0.y - B0.y) * (A0.y - B0.y));
        }
        w.sticks.push({ a: a, b: b, len: len });
    };
    w.pin = function (i) { w.pts[i].pin = true; };
    w.step = function () {
        var pts = w.pts, sticks = w.sticks, i, k, p;
        for (i = 0; i < pts.length; i++) {
            p = pts[i];
            if (p.pin) { p.px = p.x; p.py = p.y; continue; }
            var vx = (p.x - p.px) * 0.999, vy = (p.y - p.py) * 0.999;
            p.px = p.x; p.py = p.y;
            p.x += vx;
            p.y += vy + 0.4;
        }
        for (k = 0; k < ITER; k++) {
            for (i = 0; i < sticks.length; i++) {
                var s = sticks[i], A0 = pts[s.a], B0 = pts[s.b];
                var dx = B0.x - A0.x, dy = B0.y - A0.y;
                var d = Math.sqrt(dx * dx + dy * dy);
                if (!(d >= 0.000001)) continue;
                var ma = A0.pin ? 0 : 1, mb = B0.pin ? 0 : 1, tot = ma + mb;
                if (!tot) continue;
                var f = (d - s.len) / d / tot;
                A0.x += dx * f * ma; A0.y += dy * f * ma;
                B0.x -= dx * f * mb; B0.y -= dy * f * mb;
            }
        }
        for (i = 0; i < pts.length; i++) {
            p = pts[i];
            if (p.pin) continue;
            if (p.x < 0) { var bx = p.x - p.px; p.x = 0; p.px = p.x + bx * 0.8; }
            if (p.x > 240) { var bx2 = p.x - p.px; p.x = 240; p.px = p.x + bx2 * 0.8; }
            if (p.y < 0) { var by = p.y - p.py; p.y = 0; p.py = p.y + by * 0.8; }
            if (p.y > 248) { var by2 = p.y - p.py; p.y = 248; p.py = p.y + by2 * 0.8; }
        }
    };
    return w;
}

// ---- mundo nativo ---------------------------------------------------------
function natWorld() {
    var id = -1;
    try { id = System.verletNew(ITER); } catch (e) { id = -1; }
    if (!(id > 0)) return null;
    return {
        add: function (x, y) { return System.verletAddPoint(id, x, y); },
        stick: function (a, b, len) { System.verletStick(id, a, b, len); },
        pin: function (i) { System.verletPin(id, i, true); },
        step: function () { System.verletStep(id, 1, 0, 0.4, 0.999, 0, 0, 240, 248, 0.8); },
        free: function () { try { System.verletFree(id); } catch (e) {} }
    };
}

// ---- estado ----------------------------------------------------------------
var PASSOS = [600, 1200, 2400], ROTULO = ["Leve", "Normal", "Pesado"];
var passosSel = 1;
var passos = PASSOS[passosSel];
var NAT = HAS_NAT;
var run = null;          // { fase: 1|2, feitos, mundo }
var res = null;          // { jsUs, natUs, feito }
var ultimoReg = "";

function micros() {
    try {
        if (typeof System.micros === "function") return System.micros();
        return System.millis() * 1000;
    } catch (e) { return System.millis() * 1000; }
}

function novoRes() { return { jsUs: 0, natUs: 0, feito: false }; }

function inicia() {
    res = novoRes();
    ultimoReg = "";
    run = { fase: 1, feitos: 0, mundo: montar(jsWorld()) };
    UI.invalidate();
}

function finaliza() {
    run = null;
    res.feito = true;
    UI.invalidate();
}

// roda um bloco por quadro (progresso + janela do exec-timeout)
function passo() {
    if (!run) return;
    var total = passos;
    var porQuadro = Math.max(1, Math.ceil(total / 20));
    var n = Math.min(porQuadro, total - run.feitos);
    var t0 = micros();
    for (var i = 0; i < n; i++) run.mundo.step();
    var dt = micros() - t0;
    if (dt < 0) dt = 0;
    if (run.fase === 1) res.jsUs += dt; else res.natUs += dt;
    run.feitos += n;
    UI.invalidate();
    if (run.feitos < total) return;
    if (run.fase === 1) {
        if (run.mundo.free) run.mundo.free();
        if (!NAT) { finaliza(); return; }
        var nm = natWorld();
        if (!nm) { NAT = false; finaliza(); return; }
        run = { fase: 2, feitos: 0, mundo: montar(nm) };
    } else {
        if (run.mundo.free) run.mundo.free();
        finaliza();
    }
}

function ganho() {
    if (!res || !NAT || !res.natUs) return 0;
    return res.jsUs / res.natUs;
}
function fmtMs(us) {
    var ms = us / 1000;
    if (ms >= 100) return Math.round(ms) + " ms";
    if (ms >= 10) return (Math.round(ms * 10) / 10) + " ms";
    return (Math.round(ms * 100) / 100) + " ms";
}
function porStep(us) {
    var v = us / 1000 / passos;
    return (v < 1 ? v.toFixed(3) : v.toFixed(1)) + " ms/step";
}

function registrar() {
    if (!res || !res.feito) return;
    var b = "desconhecida";
    try { b = System.getInfo().board || b; } catch (e) {}
    var linha = System.getDate() + " " + System.getTime() + " passos=" + passos +
                " js=" + fmtMs(res.jsUs) +
                " nat=" + (NAT ? fmtMs(res.natUs) : "-") +
                " ganho=" + (ganho() ? ganho().toFixed(2) + "x" : "-") +
                " placa=" + b;
    var arq = DATA + "bench-fisica.txt";
    var velho = "";
    try { velho = FS.readTextFile(arq) || ""; } catch (e) {}
    if (velho.length > 6000) velho = "";
    try {
        FS.writeTextFile(arq, velho + linha + "\n");
        ultimoReg = "salvo em bench-fisica.txt";
        A.toast("registro salvo");
    } catch (e) {
        ultimoReg = "sem espaço para o registro";
        A.toast(ultimoReg);
    }
    try { System.print("Bench Fisica: " + linha); } catch (e) {}
    UI.invalidate();
}

// ---- desenho ---------------------------------------------------------------
function previa(x, y, w, h) {
    // miniatura da cena (3 cordas + pano), so no frame total
    var S = System, c, i, j;
    var sc = w / 240, vh = h / 248;
    for (c = 0; c < 3; c++) {
        var x0 = 36 + c * 80;
        for (i = 1; i < 14; i++) {
            S.drawLine(x + x0 * sc, y + (20 + (i - 1) * 13) * vh,
                       x + x0 * sc, y + (20 + i * 13) * vh, T.accentD);
        }
    }
    var px = (240 - 8 * 15) / 2;
    for (i = 0; i < 6; i++) {
        for (j = 0; j < 8; j++) {
            var xx = x + (px + j * 15) * sc, yy = y + (24 + i * 15) * vh;
            if (j > 0) S.drawLine(xx - 15 * sc, yy, xx, yy, T.stroke);
            if (i > 0) S.drawLine(xx, yy - 15 * vh, xx, yy, T.stroke);
        }
    }
    for (i = 0; i < SOLTOS.length; i += 2) {
        S.fillCircle(x + SOLTOS[i][0] * sc, y + SOLTOS[i][1] * vh, 1, T.warn);
    }
}

function cardResultado(y, titulo, us, cor, nota, full) {
    A.style.card(LX, y, LW, 50, { full: full, pad: 0, draw: function (q) {
        UI.text(titulo, q.x, q.y + 2, { role: "caption", color: T.textDim, w: q.w - 96, lines: 1 });
        UI.text(res ? fmtMs(us) : "-", q.x + q.w, q.y - 2,
                { role: "title", align: "right", color: cor, w: 96, lines: 1 });
        UI.text(res ? porStep(us) : (nota || ""), q.x, q.y + 22,
                { role: "caption", color: T.textDim, w: q.w, lines: 1 });
        if (res) {
            var max = Math.max(res.jsUs, res.natUs, 1);
            var wbar = Math.round((q.w - 2) * Math.min(1, us / max));
            Sfill(q.x, q.y + q.h - 8, q.w, 5, T.raised);
            if (wbar > 1) Sfill(q.x, q.y + q.h - 8, wbar, 5, cor);
        }
    }});
}
function Sfill(x, y, w, h, c) {
    if (System.fillRoundRect) System.fillRoundRect(x, y, w, h, Math.min(2, h >> 1), c);
    else System.fillRect(x, y, w, h, c);
}

function tela(c) {
    var h = A.header("Bench Física", { sub: NAT ? "JS × nativo" : "só JS" });
    if (h) return A.BACK;

    if (run) passo();

    // cena
    A.style.card(LX, 44, LW, 56, { full: c.full, pad: 10, draw: function (q) {
        UI.text("Cena do verlet", q.x, q.y, { role: "caption", color: T.textDim, w: q.w - 64, lines: 1 });
        UI.text(NOS + " nós", q.x, q.y + 14, { role: "body", w: q.w - 64, lines: 1, id: "b-nos" });
        UI.text(HASTES + " hastes · " + passos + " steps", q.x, q.y + 32,
                { role: "caption", color: T.textDim, w: q.w - 64, lines: 1, id: "b-cfg" });
        if (c.full) previa(q.x + q.w - 56, q.y + 2, 54, 44);
    }});

    // carga
    var sel = UI.tabs(LX, 106, LW, 28, ROTULO, passosSel);
    if (!run && sel !== passosSel) {
        passosSel = sel;
        passos = PASSOS[sel] || 1200;
        res = null;
        UI.invalidate();
    }

    // rodar / progresso
    if (run) {
        var total = passos * (NAT ? 2 : 1);
        var feitos = (run.fase === 1 ? 0 : passos) + run.feitos;
        var pct = Math.round(feitos * 100 / total);
        A.style.card(LX, 140, LW, 42, { full: c.full, pad: 8, draw: function (q) {
            UI.text(run.fase === 1 ? "Rodando JS · " + pct + "%" : "Rodando nativo · " + pct + "%",
                    q.x, q.y + 1, { role: "caption", color: T.text, w: q.w, lines: 1, id: "b-run" });
            Sfill(q.x, q.y + 18, q.w, 8, T.raised);
            var wb = Math.round(q.w * pct / 100);
            if (wb > 1) Sfill(q.x, q.y + 18, wb, 8, T.accent);
        }});
    } else if (res && res.feito) {
        var bw = LW - 92;
        if (A.style.button("Rodar de novo", LX, 140, bw, 42)) inicia();
        var b2 = A.style.button("Registrar", LX + bw + 8, 140, 84, 42, { variant: "ghost" });
        if (b2) registrar();
    } else {
        if (A.style.button(NAT ? "Rodar A/B" : "Rodar", LX, 140, LW, 42)) inicia();
    }

    // resultados
    cardResultado(190, "JS (Duktape)", res ? res.jsUs : 0, T.accent, "toque em Rodar para medir", c.full);
    if (NAT) {
        cardResultado(244, "Nativo (C++)", res ? res.natUs : 0, T.ok,
                      "System.verletStep (API 31)", c.full);
    } else {
        A.style.card(LX, 244, LW, 50, { full: c.full, pad: 0, draw: function (q) {
            A.icons.draw("alert", q.x, q.y + 2, 16, { color: T.warn });
            UI.text("Sem acelerador nativo", q.x + 22, q.y,
                    { role: "body", color: T.warn, w: q.w - 22, lines: 1, id: "b-nonat" });
            UI.text("Firmware < API 31 ou CYD lite (sem física). O lado JS continua valendo.",
                    q.x, q.y + 22, { role: "caption", color: T.textDim, w: q.w, lines: 3, id: "b-nonat2" });
        }});
    }

    // rodape: ganho / estado
    var rod = "";
    var cor = T.textDim;
    if (run) rod = "medindo sem desenhar no meio do bloco";
    else if (res && res.feito) {
        if (NAT && res.natUs > 0) {
            var g = ganho();
            rod = g >= 1 ? "nativo " + g.toFixed(1) + "x mais rápido" : "nativo no par do JS";
            cor = g >= 1 ? T.ok : T.warn;
        } else if (!NAT) {
            rod = "sem o binding nativo nesta placa";
            cor = T.warn;
        } else {
            rod = "tempo abaixo da resolução do relógio";
        }
    } else if (!res) {
        rod = "a mesma cena nos dois caminhos";
    }
    if (ultimoReg && res && res.feito) rod = ultimoReg;
    UI.text(rod, CX, BOT - 16,
            { role: "caption", align: "center", color: cor, w: LW, lines: 1, id: "b-foot" });
}
tela.fps = 20;

// ---- headless: roda uma vez e imprime no logcat ----------------------------
if (!HAS_DISP) {
    var wj = montar(jsWorld());
    var t0 = micros();
    for (var i = 0; i < passos; i++) {
        wj.step();
        if ((i & 63) === 0) System.delay(0);   // cede a janela do exec-timeout
    }
    var jsUs = micros() - t0;
    var natUs = 0;
    if (HAS_NAT) {
        var wn = natWorld();
        if (wn) {
            montar(wn);
            var t1 = micros();
            for (var k = 0; k < passos; k++) {
                wn.step();
                if ((k & 63) === 0) System.delay(0);
            }
            natUs = micros() - t1;
            wn.free();
        }
    }
    System.print("Bench Fisica: " + NOS + " nos, " + passos + " steps: JS " +
                 fmtMs(jsUs) + (natUs ? " x nativo " + fmtMs(natUs) +
                 " (" + (jsUs / natUs).toFixed(1) + "x)" : " (sem nativo)"));
    System.exitApp();
} else {
    A.run({ main: tela }, "main", { fps: 20 });
}
