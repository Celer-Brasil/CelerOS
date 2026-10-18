// Physics Drop 4.3 — sandbox de fisica VERLET NATIVO (celeros.physics,
// API 31) com ferramentas de verdade no toque. Porte CelerGame: o loop e
// os gestos vivem no core (cena + E.input), desenho com E.gfx, e a
// ferramenta/gravidade da ultima sessao ficam lembradas no NVS.
// 4.3: as checagens manuais das ferramentas sairam — celeros.game.collide
// faz os cortes (segRect varre o traco da tesoura), o PINO/PEGAR (point
// acha o no no raio do dedo) e a borracha (test); a ferramenta virou uma
// maquina celeros.game.fsm (pintar/pegar/pino/cortar/apagar) e os eventos
// "tool"/"grav"/"clear" do celeros.game.events alimentam os avisos do
// E.ui.toast. O fundo do sandbox usa a arte ai_bg do pacote por uma folha
// do celeros.game.spr (256x256, sem slot fica o preto do tema). O juice da
// 4.2 (particulas, aneis, rastro e flash) e os sons seguem iguais.
//   Pintar — arraste cria a cadeia de nos/vinculos (como sempre)
//   Pegar  — toque perto de um no o pega; arraste puxa (pano/corda
//            seguem); soltar arremessa com a velocidade do dedo
//   Pino   — toque seco alterna prender/soltar o no no ar
//   Cortar — arraste corta os vinculos que cruzarem o traco (tesoura)
//   Apagar — arraste apaga os nos que tocar (vinculos ligados saem)
// Os nos tem CORPO (colisao ponto-ponto nativa): corda cai sobre pano em
// vez de atravessar. Gravidade cicla no botao de status (ate invertida).

var E = require("celeros.game");       // familia CelerGame: core
require("celeros.game.ui");            // titulo/pausa, lista de cenas, toast
require("celeros.game.fx");            // particulas, aneis, rastro, flash
require("celeros.game.spr");           // folha de sprite do fundo (ai_bg)
require("celeros.game.collide");       // segRect/point/test das ferramentas
require("celeros.game.fsm");           // estado da ferramenta
require("celeros.game.events");        // barramento "tool"/"grav"/"clear"
var P = require("celeros.physics");

E.init({ dir: "Physics Drop", fps: 50, save: "drop.",
         bases: ["/local/apps/Physics Drop/", "/sd/apps/Physics Drop/"] });

// fundo do sandbox: 1 PNG num slot so (regiao unica de 256x256). Sem PNG
// ou sem slot livre o sheet nao tem id e o fundo continua o preto do tema.
var bg = E.spr.sheet("aibg", { file: "ai_bg", w: 256, h: 256,
                               regions: { bg: [0, 0, 256, 256] } });
var bgOn = !!(bg && bg.bg) && E.spr.backed("bg");
var T = E.theme, SW = E.W, SH = E.H;
var BAR_Y = 236;                      // topo da barra de ferramentas
var barSuja = false;                  // fx passou pela barra no quadro anterior
var pauseDrawn = false, pauseOn = -1, pauseBtns = [];

// veu de pausa (1x por mudanca: o draw da cena chama so quando precisa)
function drawPausa() {
    pauseOn = E._btnUnder();
    var pact = E.ui.pause({ labels: PAUSE_LB });
    pauseBtns = E._btns.slice();
    pauseOn = E._btnUnder();
    pauseDrawn = true;
    if (pact === "resume") {
        sairPausa();
        E.audio.sfx("ui");
    } else if (pact === "restart") {
        novoMundo();
        sairPausa();
        E.audio.sfx("back");
    } else if (pact === "quit") {
        sairPausa();
        E.audio.sfx("back");
        E.goto("titulo", { transition: "fade", ms: 300 });
    }
}
function sairPausa() {
    paused = false;
    pauseDrawn = false;
    barKey = "";        // a barra volta inteira (o veu passou por cima)
}

// sons proprios da cena (a tabela do core ganha as entradas do sandbox)
E.audio.sfxTable.cut = [[1600, 18], [900, 30]];
E.audio.sfxTable.pin = [[1200, 25], [1700, 35]];
E.audio.sfxTable.grab = [660, 26];
E.audio.sfxTable.grav = [[440, 35], [660, 45], [440, 35]];

// gravidade em presets (cicla no botao): normal, leve, lua, forte, invertida
var GRAVS = [[0.4, "normal"], [0.2, "leve"], [0.07, "lua"], [0.9, "forte"], [-0.3, "invertida"]];
var gravIdx = E.save.num("grav", 0) % GRAVS.length;
if (gravIdx < 0) gravIdx += GRAVS.length;

var TOOLS = [
    { label: "Pinta", w: 42 },
    { label: "Pega", w: 42 },
    { label: "Pino", w: 42 },
    { label: "Corta", w: 42 },
    { label: "Apaga", w: 42 }
];
var T_DRAW = 0;                       // indice do Pintar (default do save)
// nomes dos estados do E.fsm na MESMA ordem dos chips da barra
var TOOL_STATES = ["pintar", "pegar", "pino", "cortar", "apagar"];
var tool = E.save.num("tool", T_DRAW) % TOOLS.length;
if (tool < 0) tool += TOOLS.length;

var MAX_POINTS = 120;
var GRAB_R = 22;                      // raio de pescar um no com o dedo
var ERASE_R = 16;
var CUT_PAD = 2;                      // folga do AABB do vinculo no segRect

// eventos do jogo: a barra so emite; o FSM e os avisos reagem aqui. O
// toast do E.ui e desenhado pela engine por cima da cena.
E.on("tool", function (ti, label) {
    toolFsm.go(TOOL_STATES[ti], null, true);
    E.ui.toast("Ferramenta: " + label, { ms: 900, y: 0.5 });
});
E.on("grav", function (gi, label) {
    E.ui.toast("Gravidade: " + label, { ms: 1000, y: 0.5,
                                        color: gi === GRAVS.length - 1 ? T.err : undefined });
});
E.on("clear", function () {
    E.ui.toast("Mundo limpo", { ms: 800, y: 0.5 });
});

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

// fundo do mundo JA na escala da tela (1 sprite 240 x BAR_Y, gravado 1x):
// o stamp em escala 240/256 por quadro era drawSprite afim do mundo inteiro
// a 50 fps; o pushSprite 1:1 e uma copia de linhas. Sem slot fica o stamp
var BGW = 0;
(function () {
    if (!bgOn || typeof System.createSprite !== "function") return;
    var id = System.createSprite(SW, BAR_Y);
    if (!id) return;
    System.useSprite(id);
    System.fillScreen(T.bg);
    E.spr.alvo = id;
    var ok = E.spr.stamp("bg", 0, 0, { scale: E.W / 256, key: null });
    E.spr.alvo = 0;
    System.useSprite(0);
    if (ok) BGW = id; else System.deleteSprite(id);
})();

// opts por quadro em scratch (um literal por bastao/no eram ~150 objetos
// por quadro com o pano solto: GC constante no Duktape)
var _lnO = { w: 2 };
var _ndO = { smooth: true };
var _cutO = { w: 2 };
var _sO = { primary: false, px: 11 };
var _tO = { primary: false, px: 12 };
var _lO = { primary: false, stroke: 0 };
var _hintBig = { ts: "big", align: "center", color: 0 };
var _hintSm = { ts: "small", align: "center", color: 0 };

// barra de ferramentas: so redesenha quando o estado dela muda (gravidade,
// contagem, ferramenta, dedo sobre um botao) ou quando particulas/flash
// podem ter passado por cima — o mundo limpa so ate BAR_Y
var barKey = "";
var BAR_BTNS = null;
function barKeyNow() {
    var i = E.input, on = -1;
    if (i.down) {
        for (var k = 0; k < BAR_BTNS.length; k++) {
            var b = BAR_BTNS[k];
            if (i.x >= b.x && i.x <= b.x + b.w && i.y >= b.y && i.y <= b.y + b.h) { on = k; break; }
        }
    }
    return gravIdx + "|" + world.count() + "|" + tool + "|" + on;
}

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
    resetTransientes();
    E.emit("clear");
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

// no mais proximo de (x, y) dentro do raio (ou -1): o collide.point trata
// o dedo como circulo e o no como ponto (mesmo hit-test das ferramentas)
var _grabBrush = { x: 0, y: 0, r: GRAB_R };
function nearest(x, y, r) {
    var xy = world.xy(), best = -1, bd = 0;
    _grabBrush.x = x;
    _grabBrush.y = y;
    _grabBrush.r = r;
    for (var i = 0; i < xy.length; i += 2) {
        if (!E.collide.point(xy[i], xy[i + 1], _grabBrush)) continue;
        var dx = x - xy[i], dy = y - xy[i + 1];
        var d2 = dx * dx + dy * dy;
        if (best < 0 || d2 < bd) { bd = d2; best = i / 2; }
    }
    return best;
}

// ------------------------------------------------------------ interacao ---
// a ferramenta e o estado corrente da maquina: cada estado trata o
// press/drag/release do toque. As checagens sao do celeros.game.collide
// (point no PEGAR/PINO, segRect no CORTAR, test na borracha).
var _fp = { x: 0, y: 0 };             // ponto do toque (sem alocar por quadro)
var _cutRect = { x: 0, y: 0, w: 0, h: 0 };
var _eraseBrush = { x: 0, y: 0, r: ERASE_R };
var _erasePt = { x: 0, y: 0, r: 0 };

function resetTransientes() {
    isDrawing = false;
    lastPointIdx = -1;
    grabbed = -1;
    cutPrev = null;
    pararRastro();
}

function toolIndex(nome) {
    for (var i = 0; i < TOOL_STATES.length; i++) {
        if (TOOL_STATES[i] === nome) return i;
    }
    return T_DRAW;
}

var toolFsm = E.fsm(null, {
    pintar: {
        enter: resetTransientes,
        on: {
            press: function (m, p) {
                isDrawing = true;
                if (world.count() < MAX_POINTS) {
                    lastPointIdx = world.add(p.x, p.y);
                    if (lastPointIdx !== -1) world.pin(lastPointIdx);
                } else lastPointIdx = -1;
            },
            drag: function (m, p) {
                if (!isDrawing || lastPointIdx === -1) return;
                var xy = world.xy();
                var lp = lastPointIdx * 2;
                var dx = p.x - xy[lp], dy = p.y - xy[lp + 1];
                var dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > 15) {
                    if (world.count() < MAX_POINTS) {
                        var nIdx = world.add(p.x, p.y);
                        if (nIdx !== -1) {
                            world.stick(lastPointIdx, nIdx, dist);
                            world.pin(nIdx);
                            world.pin(lastPointIdx, false);
                            lastPointIdx = nIdx;
                        }
                    }
                } else {
                    world.set(lastPointIdx, p.x, p.y);
                }
            },
            release: function (m) {
                isDrawing = false;
                if (lastPointIdx !== -1) {
                    world.pin(lastPointIdx, false);
                    lastPointIdx = -1;
                }
            }
        }
    },

    pegar: {
        enter: resetTransientes,
        exit: function (m) { grabbed = -1; pararRastro(); },
        on: {
            press: function (m, p) {
                grabbed = nearest(p.x, p.y, GRAB_R);
                if (grabbed >= 0) {
                    var gxy = world.xy();
                    _grabX = gxy[grabbed * 2];
                    _grabY = gxy[grabbed * 2 + 1];
                    iniciarRastro();
                    E.audio.sfx("grab");
                }
                if (typeof __harness !== "undefined") {
                    __harness.log.push('[grab] press em ' + p.x.toFixed(0) + ',' + p.y.toFixed(0) +
                                       ' -> ' + grabbed + ' (nos ' + world.count() + ')');
                }
            },
            drag: function (m, p) {
                if (grabbed < 0) return;
                world.set(grabbed, p.x, p.y);
                _grabX = p.x;
                _grabY = p.y;
                // teto de log alto: com a engine os botoes da barra desenham
                // todo frame (o toolkit so logava na mudanca) e o limite
                // antigo de 400 caia antes do arrasto comecar
                if (typeof __harness !== "undefined" && __harness.log.length < 4000) {
                    var dxy = world.xy();
                    __harness.log.push('[grab] drag dedo ' + p.x.toFixed(0) + ',' + p.y.toFixed(0) +
                                       ' | no1 ' + dxy[2].toFixed(0) + ',' + dxy[3].toFixed(0));
                }
            },
            release: function (m) {
                grabbed = -1;   // soltou: a velocidade do dedo vira arremesso
                pararRastro();
            }
        }
    },

    pino: {
        enter: resetTransientes,
        on: {
            press: function (m, p) {
                var pi = nearest(p.x, p.y, GRAB_R);
                if (pi >= 0) {
                    var pinsNow = world.pins();
                    var pinOn = !pinsNow[pi];
                    world.pin(pi, pinOn);
                    var pxy = world.xy();
                    E.fx.ring(pxy[pi * 2], pxy[pi * 2 + 1],
                              { color: pinOn ? T.warn : T.accent, r0: 3, speed: 90, life: 0.35 });
                    E.audio.sfx("pin");
                }
            }
        }
    },

    cortar: {
        enter: resetTransientes,
        exit: function (m) { cutPrev = null; },
        on: {
            press: function (m, p) {
                cutPrev = { x: p.x, y: p.y };
            },
            drag: function (m, p) {
                if (!cutPrev) return;
                var st = world.sticks();
                var pts = world.xy();
                var cuts = 0;
                for (var ci = st.length / 2 - 1; ci >= 0; ci--) {   // do fim pro comeco (delStick faz swap)
                    var a2 = st[ci * 2] * 2, b2 = st[ci * 2 + 1] * 2;
                    var ax = pts[a2], ay = pts[a2 + 1];
                    var bx = pts[b2], by = pts[b2 + 1];
                    // AABB do vinculo com folga: o segRect varre o traco do
                    // dedo e devolve a fracao (0 = ja dentro, -1 = nao cruzou)
                    _cutRect.x = (ax < bx ? ax : bx) - CUT_PAD;
                    _cutRect.y = (ay < by ? ay : by) - CUT_PAD;
                    _cutRect.w = (ax > bx ? ax : bx) - _cutRect.x + CUT_PAD;
                    _cutRect.h = (ay > by ? ay : by) - _cutRect.y + CUT_PAD;
                    if (E.collide.segRect(cutPrev.x, cutPrev.y, p.x, p.y, _cutRect) < 0) continue;
                    var mx = (ax + bx) / 2;
                    var my = (ay + by) / 2;
                    world.delStick(ci);
                    if (cuts < 4) {          // juice vermelho no ponto do corte
                        E.fx.burst(mx, my, { n: 5, color: T.err, speed: 55, speed2: 120,
                                             life: 0.35, size: 2, grav: 120 });
                        E.fx.ring(mx, my, { color: T.err, r0: 2, speed: 80, life: 0.3 });
                    }
                    cuts++;
                }
                if (cuts > 0) E.audio.sfx("cut");
                cutPrev = { x: p.x, y: p.y };
            },
            release: function (m) { cutPrev = null; }
        }
    },

    apagar: {
        enter: resetTransientes,
        on: {
            drag: function (m, p) {
                var exy = world.xy();          // uma leitura por frame
                _eraseBrush.x = p.x;
                _eraseBrush.y = p.y;
                for (var ei = world.count() - 1; ei >= 0; ei--) {   // do fim pro comeco (delPoint faz swap)
                    _erasePt.x = exy[ei * 2];
                    _erasePt.y = exy[ei * 2 + 1];
                    if (E.collide.test(_eraseBrush, _erasePt)) world.delPoint(ei);
                }
                grabbed = -1;
                pararRastro();
            }
        }
    }
}, TOOL_STATES[tool], {
    onChange: function (m, de, para) {
        tool = toolIndex(para);
        E.save.set("tool", tool);
    }
});

// press/release/arrasto do E.input chegam ao estado corrente da ferramenta
function press(x, y) {
    if (y >= BAR_Y - 6) return;
    _fp.x = x;
    _fp.y = y;
    toolFsm.send("press", _fp);
}

function release() {
    toolFsm.send("release");
}

function drag(x, y) {
    if (y >= BAR_Y - 6) return;
    _fp.x = x;
    _fp.y = y;
    toolFsm.send("drag", _fp);
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
            sairPausa();          // barra e pausa recomecam do zero
            touchDown = false;
            resetTransientes();
        },
        update: function (dt) {
            var i = E.input;

            // pausa: botao proprio na barra; o overlay vive no draw
            if (!paused && E.hit(BTN_PAUSE)) {
                paused = true;
                pauseDrawn = false;
                touchDown = false;
                resetTransientes();
                E.audio.sfx("ui");
            }
            if (paused) return;
            toolFsm.update(dt);   // relogio do estado da ferramenta

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
                E.emit("grav", gravIdx, GRAVS[gravIdx][1]);
            }
            for (var ti = 0; ti < TOOLS.length; ti++) {
                if (E.hit(BTN_TOOL[ti])) {
                    // o listener de "tool" troca o estado do FSM e avisa
                    E.emit("tool", ti, TOOLS[ti].label);
                    E.audio.sfx("ui");
                }
            }
            if (E.hit(BTN_CORDA)) { spawnRope(); E.audio.sfx("ui"); }
            if (E.hit(BTN_PANO)) { spawnCloth(); E.audio.sfx("ui"); }
            if (E.hit(BTN_LIMPAR)) { novoMundo(); E.audio.sfx("back"); }
        },
        draw: function () {
            // mundo (fundo da arte ai_bg quando o slot carregou; sem slot
            // fica o preto do tema — stamp devolve false e nada e desenhado)
            // pausa: o mundo congelado ja esta no vidro — o veu desenha 1x
            // e repinta so quando o dedo entra/sai de uma opcao (ou tap)
            if (paused && pauseDrawn) {
                for (var pq = 0; pq < pauseBtns.length; pq++) E._btns.push(pauseBtns[pq]);
                var pon = E._btnUnder();
                if (pon === pauseOn && !E.input.tap) return;
                E._btns.length = 0;
                drawPausa();
                return;
            }
            if (BGW) {
                System.useSprite(BGW);
                System.pushSprite(0, 0);
                System.useSprite(0);
            } else {
                E.gfx.rect(0, 0, SW, BAR_Y, T.bg, { screen: true });
                if (bgOn) {
                    if (!E.spr.stamp("bg", 0, 0, { scale: E.W / 256, key: null })) {
                        E.spr.blit("bg", 0, 0);   // firmware sem drawSprite: 1:1
                    }
                }
            }
            System.drawFastHLine(0, BAR_Y - 1, SW, T.stroke);

            var xy = world.xy();
            if (!xy.length) {
                _hintBig.color = _hintSm.color = T.textDim;
                E.gfx.text("Pinte, ou solte Corda/Pano", SW / 2, 108, _hintBig);
                E.gfx.text("Pegar arrasta e arremessa;", SW / 2, 132, _hintSm);
                E.gfx.text("Cortar fatia; Pino fixa no ar", SW / 2, 146, _hintSm);
            }

            var pins = world.pins();
            var st = world.sticks();
            for (var i = 0; i < st.length; i += 2) {
                var ia = st[i] * 2, ib = st[i + 1] * 2;
                E.gfx.line(Math.floor(xy[ia]), Math.floor(xy[ia + 1]),
                           Math.floor(xy[ib]), Math.floor(xy[ib + 1]),
                           T.text, _lnO);
            }
            for (var j = 0; j < xy.length; j += 2) {
                var idx = j / 2;
                var col = pins[idx] ? T.warn : T.accent;
                var r = (toolFsm.is("pegar") && idx === grabbed) ? 4 : 2;
                // AA so no no agarrado (r 4): no de 2 px o suavizado nao
                // aparece e custava varias vezes o circulo cheio (~60/quadro)
                _ndO.smooth = r > 2;
                E.gfx.circle(Math.floor(xy[j]), Math.floor(xy[j + 1]), r, col, _ndO);
            }
            // traco da tesoura em vermelho enquanto corta
            if (toolFsm.is("cortar") && cutPrev && E.input.down) {
                E.gfx.line(Math.floor(cutPrev.x), Math.floor(cutPrev.y),
                           Math.floor(E.input.x), Math.floor(E.input.y), T.err, _cutO);
            }

            // barra: status / ferramentas / acoes (memoizada — ver barKeyNow)
            if (!BAR_BTNS) BAR_BTNS = [BTN_STAT, BTN_PAUSE].concat(BTN_TOOL, [BTN_CORDA, BTN_PANO, BTN_LIMPAR]);
            var bk = barKeyNow();
            var sujo = E.fx.count() > 0 || E.fx._flashT > 0 || barSuja;
            barSuja = E.fx.count() > 0 || E.fx._flashT > 0;   // o quadro seguinte limpa o resto
            if (bk !== barKey || sujo) {
                barKey = bk;
                System.fillRect(0, BAR_Y, SW, SH - BAR_Y, T.bg);
                E.gfx.button("g: " + GRAVS[gravIdx][1] + "  ·  " + world.count() + "/" +
                             MAX_POINTS + " nós", BTN_STAT.x, BTN_STAT.y, BTN_STAT.w,
                             BTN_STAT.h, _sO);
                E.gfx.button("Pausa", BTN_PAUSE.x, BTN_PAUSE.y, BTN_PAUSE.w, BTN_PAUSE.h, _sO);
                for (var ti = 0; ti < TOOLS.length; ti++) {
                    _tO.primary = ti === tool;
                    E.gfx.button(TOOLS[ti].label, BTN_TOOL[ti].x, BTN_TOOL[ti].y,
                                 BTN_TOOL[ti].w, BTN_TOOL[ti].h, _tO);
                }
                E.gfx.button("Corda", BTN_CORDA.x, BTN_CORDA.y, BTN_CORDA.w, BTN_CORDA.h);
                E.gfx.button("Pano", BTN_PANO.x, BTN_PANO.y, BTN_PANO.w, BTN_PANO.h);
                _lO.stroke = T.err;
                E.gfx.button("Limpar", BTN_LIMPAR.x, BTN_LIMPAR.y, BTN_LIMPAR.w, BTN_LIMPAR.h, _lO);
            }
            System.drawFastHLine(0, BAR_Y - 1, SW, T.stroke);

            // particulas/aneis/rastro por cima do mundo e da barra
            E.fx.draw();

            // pausa por cima de tudo; Continuar/Limpar/Sair
            if (paused) drawPausa();
        }
    }
}, "titulo");
