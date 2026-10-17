// Physics Drop 4.2 — sandbox de fisica VERLET NATIVO (celeros.physics,
// API 31) com ferramentas de verdade no toque. Porte CelerGame: o loop e
// os gestos vivem no core (cena + E.input), desenho com E.gfx, e a
// ferramenta/gravidade da ultima sessao ficam lembradas no NVS.
// 4.2: telas de titulo/pausa da dep celeros.game.ui, presets de cena,
// juice com celeros.game.fx e sons de tabela (E.audio).
//   Pintar — arraste cria a cadeia de nos/vinculos (como sempre)
//   Pegar  — toque perto de um no o pega; arraste puxa (pano/corda
//            seguem); soltar arremessa com a velocidade do dedo
//   Pino   — toque seco alterna prender/soltar o no no ar
//   Cortar — arraste corta os vinculos que cruzarem o traco (tesoura)
//   Apagar — arraste apaga os nos que tocar (vinculos ligados saem)
// Os nos tem CORPO (colisao ponto-ponto nativa): corda cai sobre pano em
// vez de atravessar. Gravidade cicla no botao de status (ate invertida).

var E = require("celeros.game");       // familia CelerGame: core
require("celeros.game.ui");            // titulo/pausa e lista de cenas
require("celeros.game.fx");            // particulas, aneis, rastro, flash
var P = require("celeros.physics");

E.init({ dir: "Physics Drop", fps: 50, save: "drop." });
var T = E.theme, SW = E.W, SH = E.H;
var BAR_Y = 236;                      // topo da barra de ferramentas

// sons proprios da cena (a tabela do core ganha as entradas do sandbox)
E.audio.sfxTable.cut = [[1600, 18], [900, 30]];
E.audio.sfxTable.pin = [[1200, 25], [1700, 35]];
E.audio.sfxTable.grab = [660, 26];
E.audio.sfxTable.grav = [[440, 35], [660, 45], [440, 35]];

// gravidade em presets (cicla no botao): normal, leve, lua, forte, invertida
var GRAVS = [[0.4, "normal"], [0.2, "leve"], [0.07, "lua"], [0.9, "forte"], [-0.3, "invertida"]];
var gravIdx = E.save.num("grav", 0) % GRAVS.length;

var TOOLS = [
    { label: "Pinta", w: 42 },
    { label: "Pega", w: 42 },
    { label: "Pino", w: 42 },
    { label: "Corta", w: 42 },
    { label: "Apaga", w: 42 }
];
var T_DRAW = 0, T_GRAB = 1, T_PIN = 2, T_CUT = 3, T_ERASE = 4;
var tool = E.save.num("tool", T_DRAW) % TOOLS.length;

var MAX_POINTS = 120;
var GRAB_R = 22;                      // raio de pescar um no com o dedo
var ERASE_R = 16;

var world = P.verletFast({ iterations: 4, radius: 2.5 });   // nos com corpo

// pega de teste (so existe no harness): deixa o test.js dirigir as
// ferramentas e conferir o mundo
if (typeof __harness !== "undefined") {
    __harness.drop = {
        world: function () { return world; },
        tool: function () { return tool; },
        TOOLS: TOOLS,
        BAR_Y: BAR_Y
    };
}

// estados das ferramentas
var isDrawing = false, lastPointIdx = -1;   // Pintar
var grabbed = -1;                            // Pegar
var cutPrev = null;                          // Cortar (traco anterior)
var touchDown = false;

// pausa e overlay de cenas (titulo)
var paused = false;
var cenasOpen = false;
var PAUSE_LB = ["Continuar", "Limpar", "Sair"];

// rastro do no pego: um emissor reaproveitado, alimentado pela posicao do
// dedo (o no e setado nela a cada arrasto) — follow nao chama world.xy()
var trailEm = null;
var _trailP = { x: 0, y: 0 };
var _grabX = 0, _grabY = 0;

// rects dos botoes (geometria da 4.0 — a bateria do test.js dirige por aqui)
var BTN_STAT = { x: 10, y: BAR_Y + 2, w: 182, h: 20 };
var BTN_PAUSE = { x: 198, y: BAR_Y + 2, w: 34, h: 20 };
var BTN_TOOL = [];
for (var bi = 0, bx = 10; bi < TOOLS.length; bi++) {
    BTN_TOOL.push({ x: bx, y: BAR_Y + 26, w: TOOLS[bi].w, h: 26 });
    bx += TOOLS[bi].w + 2;
}
var BTN_CORDA = { x: 10, y: BAR_Y + 56, w: 70, h: 28 };
var BTN_PANO = { x: 84, y: BAR_Y + 56, w: 70, h: 28 };
var BTN_LIMPAR = { x: 158, y: BAR_Y + 56, w: 72, h: 28 };

function pararRastro() {
    if (trailEm) trailEm.stop();
}

function iniciarRastro() {
    if (!trailEm) {
        trailEm = E.fx.trail(function () {
            if (grabbed < 0) return null;   // solto: o rastro para
            _trailP.x = _grabX;
            _trailP.y = _grabY;
            return _trailP;
        }, { rate: 30, life: 0.35, size: 2, color: T.accent });
    }
    trailEm.start();
}

function novoMundo() {
    world.free();
    world = P.verletFast({ iterations: 4, radius: 2.5 });
    isDrawing = false;
    lastPointIdx = -1;
    grabbed = -1;
    cutPrev = null;
    pararRastro();
}

function spawnRope() {
    var n = 14, step = 13;
    var x0 = 36 + Math.random() * (SW - 72);
    var prev = -1;
    for (var i = 0; i < n; i++) {
        if (world.count() >= MAX_POINTS) break;
        var idx = world.add(x0, 20 + i * step);
        if (idx < 0) break;
        if (i === 0) world.pin(idx);
        if (prev >= 0) world.stick(prev, idx, step);
        prev = idx;
    }
}

function spawnCloth() {
    var cols = 8, rows = 6, step = 15;
    var x0 = (SW - cols * step) / 2;
    for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
            if (world.count() >= MAX_POINTS) return;
            var idx = world.add(x0 + c * step, 24 + r * step);
            if (idx < 0) return;
            if (r === 0 && (c === 0 || c === Math.floor(cols / 2) || c === cols - 1)) {
                world.pin(idx);
            }
            if (c > 0) world.stick(idx - 1, idx, step);
            if (r > 0) world.stick(idx - cols, idx, step);
        }
    }
}

// --------------------------------------------------------- presets de cena ---
// As cenas montam o mundo com as MESMAS primitivas das ferramentas
// (world.add/pin/stick), entao valem nos dois caminhos do P.verletFast.
function addPt(x, y) {
    if (world.count() >= MAX_POINTS) return -1;
    return world.add(x, y);
}

function linkPts(a, b) {
    if (a < 0 || b < 0) return;
    var xy = world.xy();
    var dx = xy[a * 2] - xy[b * 2];
    var dy = xy[a * 2 + 1] - xy[b * 2 + 1];
    world.stick(a, b, Math.sqrt(dx * dx + dy * dy));
}

// torre em trelica: duas colunas que afunilam, travessas e diagonais em X,
// base pinada no chao
function cenaTorre() {
    var baseY = BAR_Y - 8;
    var levels = 6, stepY = 22;
    var left = [], right = [];
    var lv, a, b, half, y;
    for (lv = 0; lv <= levels; lv++) {
        half = 26 - lv * 3;
        y = baseY - lv * stepY;
        a = addPt(120 - half, y);
        b = addPt(120 + half, y);
        if (a < 0 || b < 0) return;
        left.push(a);
        right.push(b);
        if (lv === 0) { world.pin(a); world.pin(b); }
    }
    for (lv = 0; lv < levels; lv++) {
        linkPts(left[lv], left[lv + 1]);
        linkPts(right[lv], right[lv + 1]);
        linkPts(left[lv], right[lv]);
        linkPts(left[lv], right[lv + 1]);
        linkPts(right[lv], left[lv + 1]);
    }
    linkPts(left[levels], right[levels]);
}

// ponte: deck e corrimao presos nas duas margens, montantes verticais
function cenaPonte() {
    var n = 12, x0 = 22, x1 = SW - 22, yDeck = 156, yRail = 136;
    var deck = [], rail = [];
    var i, x, a, b;
    for (i = 0; i < n; i++) {
        x = x0 + (x1 - x0) * i / (n - 1);
        a = addPt(x, yDeck);
        b = addPt(x, yRail);
        if (a < 0 || b < 0) return;
        deck.push(a);
        rail.push(b);
        if (i === 0 || i === n - 1) { world.pin(a); world.pin(b); }
    }
    for (i = 0; i < n; i++) {
        linkPts(deck[i], rail[i]);
        if (i > 0) {
            linkPts(deck[i - 1], deck[i]);
            linkPts(rail[i - 1], rail[i]);
        }
    }
}

// gangorra: tabua pinada no pivo central e um peso pendurado numa ponta
function cenaGangorra() {
    var n = 9, x0 = 66, x1 = 174, y = 176;
    var board = [];
    var i, a, b;
    for (i = 0; i < n; i++) {
        a = addPt(x0 + (x1 - x0) * i / (n - 1), y);
        if (a < 0) return;
        board.push(a);
        if (i > 0) linkPts(board[i - 1], a);
    }
    // hastes de 2 em 2 e os vaos inteiros dao rigidez a tabua (sem elas a
    // gangorra dobra em V em vez de girar no pivo)
    for (i = 0; i < n - 2; i++) linkPts(board[i], board[i + 2]);
    linkPts(board[0], board[4]);
    linkPts(board[4], board[n - 1]);
    linkPts(board[0], board[n - 1]);
    world.pin(board[4]);                 // pivo no centro
    var prev = board[0];
    for (i = 1; i <= 3; i++) {           // peso na ponta esquerda
        b = addPt(x0, y + i * 18);
        if (b < 0) return;
        linkPts(prev, b);
        prev = b;
    }
}

function montarCena(nome) {
    novoMundo();
    if (nome === "torre") cenaTorre();
    else if (nome === "ponte") cenaPonte();
    else if (nome === "gangorra") cenaGangorra();
    else if (nome === "pano") spawnCloth();
    // "limpar": deixa o mundo vazio
}

var CENAS = [
    { label: "Torre", value: "torre" },
    { label: "Ponte", value: "ponte" },
    { label: "Gangorra", value: "gangorra" },
    { label: "Pano", value: "pano" },
    { label: "Limpar", value: "limpar", danger: true }
];

function abrirCena(nome) {
    cenasOpen = false;
    montarCena(nome);
    E.goto("jogo", { transition: "fade", ms: 300 });
}

// lista retida do overlay "Cenas" (rola se a fonte/tela crescer)
var listaCenas = E.ui.list({
    items: CENAS,
    row: 28,
    onPick: function (v) { abrirCena(v); }
});

// no mais proximo de (x, y) dentro do raio (ou -1)
function nearest(x, y, r) {
    var xy = world.xy(), best = -1, bd = r * r;
    for (var i = 0; i < xy.length; i += 2) {
        var dx = x - xy[i], dy = y - xy[i + 1];
        var d2 = dx * dx + dy * dy;
        if (d2 <= bd) { bd = d2; best = i / 2; }
    }
    return best;
}

// intersecao de segmentos (traco do dedo x vinculo)
function segCross(ax, ay, bx, by, cx, cy, dx, dy) {
    var d1x = bx - ax, d1y = by - ay, d2x = dx - cx, d2y = dy - cy;
    var den = d1x * d2y - d1y * d2x;
    if (den === 0) return false;
    var t = ((cx - ax) * d2y - (cy - ay) * d2x) / den;
    var u = ((cx - ax) * d1y - (cy - ay) * d1x) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// ------------------------------------------------------------ interacao ---
// press/release/arrasto por ferramenta (o mesmo estado da 4.0, agora
// alimentado pelo E.input)
function press(x, y) {
    if (y >= BAR_Y - 6) return;
    if (tool === T_DRAW) {
        isDrawing = true;
        if (world.count() < MAX_POINTS) {
            lastPointIdx = world.add(x, y);
            if (lastPointIdx !== -1) world.pin(lastPointIdx);
        } else lastPointIdx = -1;
    } else if (tool === T_GRAB) {
        grabbed = nearest(x, y, GRAB_R);
        if (grabbed >= 0) {
            var gxy = world.xy();
            _grabX = gxy[grabbed * 2];
            _grabY = gxy[grabbed * 2 + 1];
            iniciarRastro();
            E.audio.sfx("grab");
        }
        if (typeof __harness !== "undefined") {
            __harness.log.push('[grab] press em ' + x.toFixed(0) + ',' + y.toFixed(0) +
                               ' -> ' + grabbed + ' (nos ' + world.count() + ')');
        }
    } else if (tool === T_PIN) {
        var pi = nearest(x, y, GRAB_R);
        if (pi >= 0) {
            var pinsNow = world.pins();
            var pinOn = !pinsNow[pi];
            world.pin(pi, pinOn);
            var pxy = world.xy();
            E.fx.ring(pxy[pi * 2], pxy[pi * 2 + 1],
                      { color: pinOn ? T.warn : T.accent, r0: 3, speed: 90, life: 0.35 });
            E.audio.sfx("pin");
        }
    } else if (tool === T_CUT) {
        cutPrev = { x: x, y: y };
    }
}

function release() {
    if (tool === T_DRAW) {
        isDrawing = false;
        if (lastPointIdx !== -1) {
            world.pin(lastPointIdx, false);
            lastPointIdx = -1;
        }
    } else if (tool === T_GRAB) {
        grabbed = -1;   // soltou: a velocidade do dedo vira arremesso
        pararRastro();
    } else if (tool === T_CUT) {
        cutPrev = null;
    }
}

function drag(x, y) {
    if (y >= BAR_Y - 6) return;
    if (tool === T_DRAW && isDrawing && lastPointIdx !== -1) {
        var xy = world.xy();
        var lp = lastPointIdx * 2;
        var dx = x - xy[lp], dy = y - xy[lp + 1];
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 15) {
            if (world.count() < MAX_POINTS) {
                var nIdx = world.add(x, y);
                if (nIdx !== -1) {
                    world.stick(lastPointIdx, nIdx, dist);
                    world.pin(nIdx);
                    world.pin(lastPointIdx, false);
                    lastPointIdx = nIdx;
                }
            }
        } else {
            world.set(lastPointIdx, x, y);
        }
    } else if (tool === T_GRAB && grabbed >= 0) {
        world.set(grabbed, x, y);
        _grabX = x;
        _grabY = y;
        // teto de log alto: com a engine os botoes da barra desenham todo
        // frame (o toolkit so logava na mudanca) e o limite antigo de 400
        // caia antes do arrasto comecar
        if (typeof __harness !== "undefined" && __harness.log.length < 4000) {
            var dxy = world.xy();
            __harness.log.push('[grab] drag dedo ' + x.toFixed(0) + ',' + y.toFixed(0) +
                               ' | no1 ' + dxy[2].toFixed(0) + ',' + dxy[3].toFixed(0));
        }
    } else if (tool === T_CUT && cutPrev) {
        var st = world.sticks();
        var pts = world.xy();
        var cuts = 0;
        for (var ci = st.length / 2 - 1; ci >= 0; ci--) {   // do fim pro comeco (delStick faz swap)
            var a2 = st[ci * 2] * 2, b2 = st[ci * 2 + 1] * 2;
            if (segCross(cutPrev.x, cutPrev.y, x, y,
                         pts[a2], pts[a2 + 1], pts[b2], pts[b2 + 1])) {
                var mx = (pts[a2] + pts[b2]) / 2;
                var my = (pts[a2 + 1] + pts[b2 + 1]) / 2;
                world.delStick(ci);
                if (cuts < 4) {          // juice vermelho no ponto do corte
                    E.fx.burst(mx, my, { n: 5, color: T.err, speed: 55, speed2: 120,
                                         life: 0.35, size: 2, grav: 120 });
                    E.fx.ring(mx, my, { color: T.err, r0: 2, speed: 80, life: 0.3 });
                }
                cuts++;
            }
        }
        if (cuts > 0) E.audio.sfx("cut");
        cutPrev = { x: x, y: y };
    } else if (tool === T_ERASE) {
        var exy = world.xy();          // uma leitura por frame
        for (var ei = world.count() - 1; ei >= 0; ei--) {   // do fim pro comeco (delPoint faz swap)
            var edx = x - exy[ei * 2], edy = y - exy[ei * 2 + 1];
            if (edx * edx + edy * edy <= ERASE_R * ERASE_R) world.delPoint(ei);
        }
        grabbed = -1;
        pararRastro();
    }
}

// ------------------------------------------------------------------ cenas ---
E.run({
    titulo: {
        static: true,   // desenha 1x; a lista de cenas pede redraw enquanto aberta
        enter: function () {
            cenasOpen = false;
        },
        update: function () {
            if (cenasOpen) E.redraw();   // lista rola/repinta por quadro
        },
        draw: function () {
            System.fillScreen(T.bg);
            if (!cenasOpen) {
                var act = E.ui.title({
                    game: "PHYSICS DROP",
                    subtitle: "areia, corda e pano em verlet",
                    extra: "Cenas"
                });
                if (act === "start") {
                    E.audio.sfx("ok");
                    E.goto("jogo", { transition: "fade", ms: 300 });
                } else if (act === "extra") {
                    E.audio.sfx("ui");
                    cenasOpen = true;
                }
                return;
            }
            // overlay de presets: o titulo fica de fundo e a lista rola
            E.gfx.text("CENAS", SW / 2, 72,
                       { ts: "big", align: "center", color: T.accent, screen: true });
            listaCenas.draw(20, 92, 200, 152);
            var back = E.gfx.button("Voltar", 70, 258, 100, 30,
                                    { primary: false, screen: true });
            if (E.hit(back)) {
                cenasOpen = false;
                E.audio.sfx("back");
            }
        }
    },

    jogo: {
        enter: function () {
            paused = false;
            touchDown = false;
            isDrawing = false;
            grabbed = -1;
            cutPrev = null;
            pararRastro();
        },
        update: function (dt) {
            var i = E.input;

            // pausa: botao proprio na barra; o overlay vive no draw
            if (!paused && E.hit(BTN_PAUSE)) {
                paused = true;
                touchDown = false;
                isDrawing = false;
                grabbed = -1;
                cutPrev = null;
                pararRastro();
                E.audio.sfx("ui");
            }
            if (paused) return;

            var inWorld = i.down && i.y < BAR_Y - 6;

            if (i.down && !touchDown) {
                touchDown = true;
                if (inWorld) press(i.x, i.y);
            } else if (!i.down && touchDown) {
                touchDown = false;
                release();
            }
            if (inWorld) drag(i.x, i.y);

            // fisica: 2 steps por frame, dt=1 mantem os presets em px por step
            for (var stp = 0; stp < 2; stp++) {
                world.step(1, { gravity: { x: 0, y: GRAVS[gravIdx][0] },
                                damp: 0.999,
                                bounds: { x: 0, y: 0, w: SW, h: BAR_Y - 4 },
                                bounce: 0.8 });
            }

            // barra: status / ferramentas / acoes
            if (E.hit(BTN_STAT)) {
                gravIdx = (gravIdx + 1) % GRAVS.length;
                E.save.set("grav", gravIdx);
                E.fx.flash(gravIdx === GRAVS.length - 1 ? T.err : T.accent, 140);
                E.audio.sfx("grav");
            }
            for (var ti = 0; ti < TOOLS.length; ti++) {
                if (E.hit(BTN_TOOL[ti])) {
                    tool = ti;
                    E.save.set("tool", ti);
                    grabbed = -1;
                    cutPrev = null;
                    isDrawing = false;
                    pararRastro();
                    E.audio.sfx("ui");
                }
            }
            if (E.hit(BTN_CORDA)) { spawnRope(); E.audio.sfx("ui"); }
            if (E.hit(BTN_PANO)) { spawnCloth(); E.audio.sfx("ui"); }
            if (E.hit(BTN_LIMPAR)) { novoMundo(); E.audio.sfx("back"); }
        },
        draw: function () {
            // mundo
            E.gfx.rect(0, 0, SW, BAR_Y, T.bg, { screen: true });
            System.drawFastHLine(0, BAR_Y - 1, SW, T.stroke);

            var xy = world.xy();
            if (!xy.length) {
                E.gfx.text("Pinte, ou solte Corda/Pano", SW / 2, 108,
                           { ts: "big", align: "center", color: T.textDim });
                E.gfx.text("Pegar arrasta e arremessa;", SW / 2, 132,
                           { ts: "small", align: "center", color: T.textDim });
                E.gfx.text("Cortar fatia; Pino fixa no ar", SW / 2, 146,
                           { ts: "small", align: "center", color: T.textDim });
            }

            var pins = world.pins();
            var st = world.sticks();
            for (var i = 0; i < st.length; i += 2) {
                var ia = st[i] * 2, ib = st[i + 1] * 2;
                E.gfx.line(Math.floor(xy[ia]), Math.floor(xy[ia + 1]),
                           Math.floor(xy[ib]), Math.floor(xy[ib + 1]),
                           T.text, { w: 2 });
            }
            for (var j = 0; j < xy.length; j += 2) {
                var idx = j / 2;
                var col = pins[idx] ? T.warn : T.accent;
                var r = idx === grabbed ? 4 : 2;
                E.gfx.circle(Math.floor(xy[j]), Math.floor(xy[j + 1]), r, col,
                             { smooth: true });
            }
            // traco da tesoura em vermelho enquanto corta
            if (tool === T_CUT && cutPrev && E.input.down) {
                E.gfx.line(Math.floor(cutPrev.x), Math.floor(cutPrev.y),
                           Math.floor(E.input.x), Math.floor(E.input.y), T.err, { w: 2 });
            }

            // barra: status / ferramentas / acoes
            E.gfx.button("g: " + GRAVS[gravIdx][1] + "  ·  " + world.count() + "/" +
                         MAX_POINTS + " nós", BTN_STAT.x, BTN_STAT.y, BTN_STAT.w,
                         BTN_STAT.h, { primary: false, px: 11 });
            E.gfx.button("Pausa", BTN_PAUSE.x, BTN_PAUSE.y, BTN_PAUSE.w, BTN_PAUSE.h,
                         { primary: false, px: 11 });
            for (var ti = 0; ti < TOOLS.length; ti++) {
                E.gfx.button(TOOLS[ti].label, BTN_TOOL[ti].x, BTN_TOOL[ti].y,
                             BTN_TOOL[ti].w, BTN_TOOL[ti].h,
                             { primary: ti === tool, px: 12 });
            }
            E.gfx.button("Corda", BTN_CORDA.x, BTN_CORDA.y, BTN_CORDA.w, BTN_CORDA.h);
            E.gfx.button("Pano", BTN_PANO.x, BTN_PANO.y, BTN_PANO.w, BTN_PANO.h);
            E.gfx.button("Limpar", BTN_LIMPAR.x, BTN_LIMPAR.y, BTN_LIMPAR.w, BTN_LIMPAR.h,
                         { primary: false, stroke: T.err });

            // particulas/aneis/rastro por cima do mundo e da barra
            E.fx.draw();

            // pausa por cima de tudo; Continuar/Limpar/Sair
            if (paused) {
                var pact = E.ui.pause({ labels: PAUSE_LB });
                if (pact === "resume") {
                    paused = false;
                    E.audio.sfx("ui");
                } else if (pact === "restart") {
                    novoMundo();
                    paused = false;
                    E.audio.sfx("back");
                } else if (pact === "quit") {
                    paused = false;
                    E.audio.sfx("back");
                    E.goto("titulo", { transition: "fade", ms: 300 });
                }
            }
        }
    }
}, "titulo");
