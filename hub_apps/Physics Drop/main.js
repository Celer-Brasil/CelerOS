// Physics Drop 5.0 — sandbox de fisica VERLET NATIVO (celeros.physics 2.1,
// API 31) com ferramentas de verdade no toque, agora na CelerGame 1.7 +
// UI 1.3 (ES5 puro, Duktape).
//
// Novidades da 5.0:
// - barra de ferramentas reconstruida com a UI 1.3: tokens/preset, botoes e
//   iconButtons com os icones compartilhados, controle segmentado de
//   gravidade e a lista de cenas numa sheet (as mesmas primitivas de mundo).
// - culling: nos e vinculos fora da area do mundo nao custam primitiva;
//   as particulas vivem num E.pool desenhado com {cull:true}.
// - redesenho parcial: o mundo usa a camada suja com o fundo de IA gravado
//   num slot COM DONO (E.slots.create + E.slots.fit + E.slots.gen); a barra
//   fica fora do recorte e so repinta quando o estado dela muda.
// - sono da tela (API 51): E.onSleep pausa o sandbox, E.onWake repinta.
// - cena BLOcos usa o P.rigid (corpos rigidos nativos) quando o firmware
//   tem o binding; sem ele o aviso e claro e o verlet segue valendo.
// - o FX/fsm/events/collide/spr sairam das deps: particulas, maquina de
//   ferramentas, testes de corte/pegada e o fundo viraram codigo local.
//
// As ferramentas e a fisica sao as mesmas da 4.3 (verlet nativo com corpos,
// corda/pano, pinos, corte, borracha e gravidade ate invertida) e a bateria
// do test.js continua dirigindo a barra pelos mesmos rects.

var E = require("celeros.game");       // core 1.7 (loop, input, dirty, slots)
require("celeros.game.ui");            // UI 1.3 (tokens, widgets, sheet)
var P = require("celeros.physics");    // verlet/rigid nativos

E.init({ dir: "Physics Drop", fps: 50, save: "drop.", keepAwake: false,
         bases: ["/local/apps/Physics Drop/", "/sd/apps/Physics Drop/"] });

var T = E.theme, W = E.W, H = E.H, S = System;
var TK = E.ui.preset("soft");
var BAR_Y = 236;

// sons proprios da cena (a tabela do core ganha as entradas do sandbox)
E.audio.sfxTable.cut = [[1600, 18], [900, 30]];
E.audio.sfxTable.pin = [[1200, 25], [1700, 35]];
E.audio.sfxTable.grab = [660, 26];
E.audio.sfxTable.grav = [[440, 35], [660, 45], [440, 35]];

// gravidade em presets (cicla no botao): normal, leve, lua, forte, invertida
var GRAVS = [[0.4, "normal"], [0.2, "leve"], [0.07, "lua"], [0.9, "forte"], [-0.3, "invertida"]];
var gravIdx = E.save.num("grav", 0) % GRAVS.length;
if (gravIdx < 0) gravIdx += GRAVS.length;

// barra: mesmo desenho da 4.0 (o test.js dirige por estes rects)
var TOOLS = [
    { label: "Pinta", w: 42 },
    { label: "Pega", w: 42 },
    { label: "Pino", w: 42 },
    { label: "Corta", w: 42 },
    { label: "Apaga", w: 42 }
];
var tool = E.save.num("tool", 0) % TOOLS.length;
if (tool < 0) tool += TOOLS.length;

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

var MAX_POINTS = 120;
var GRAB_R = 22;
var ERASE_R = 16;
var CUT_PAD = 2;

// ------------------------------------------------------- fundo (slot) ------
// cidade de IA (ai_bg.png) gravada 1x num slot de W x BAR_Y. Sem drawPNG ou
// sem slot livre, o painter cai no fundo do tema. O id tem dono no ledger e
// a geracao e conferida: um slot reciclado nao pinta arte nova.
var bgSpr = 0, bgGen = 0;
function montaFundo() {
    bgSpr = 0; bgGen = 0;
    if (typeof S.drawPNG !== "function") return;
    var fit = E.slots.fit(W, BAR_Y);
    if (!fit.ok) E._warn("fundo: " + fit.motivo);
    var id = E.slots.create("drop:fundo", W, BAR_Y);
    if (!id) return;
    var ok = false;
    S.useSprite(id);
    S.fillScreen(T.bg);
    var bases = ["/local/apps/Physics Drop/", "/sd/apps/Physics Drop/"];
    for (var b = 0; b < bases.length && !ok; b++) {
        try { ok = !!S.drawPNG(bases[b] + "ai_bg.png", 0, 0); } catch (e) { ok = false; }
    }
    S.useSprite(0);
    if (!ok) { E.slots.release(id); return; }
    bgSpr = id;
    bgGen = E.slots.gen(id);
}
function desenhaFundo(x, y, w, h) {
    if (!bgSpr) return false;
    if (E.slots.gen(bgSpr) !== bgGen) { bgSpr = 0; return false; }
    if (typeof S.blitSprite !== "function") return false;
    S.blitSprite(bgSpr, x, y, w, h);
    return true;
}
montaFundo();

// ------------------------------------------------------- particulas --------
var _seed = { x: 0, y: 0, vx: 0, vy: 0, life: 0.4, size: 2, color: 0xFFFF, grav: 0, ring: false, grow: 0 };
function _pInit(q) {
    q.x = _seed.x; q.y = _seed.y; q.vx = _seed.vx; q.vy = _seed.vy;
    q.t = 0; q.life = _seed.life; q.size = _seed.size; q.color = _seed.color;
    q.grav = _seed.grav; q.ring = _seed.ring; q.grow = _seed.grow;
    q.w = q.h = 4;
}
var _pO = { fill: true, screen: true };
var _ringP = { fill: false, screen: true };
var parts = E.pool(48, function () {
    return {
        dead: true, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, size: 2, color: 0xFFFF,
        grav: 0, grow: 0, ring: false, w: 4, h: 4,
        update: function (dt) {
            this.t += dt;
            if (this.t >= this.life) { this.dead = true; return; }
            this.vy += this.grav * dt;
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
    _seed.life = (o.life || 0.4) * (0.7 + Math.random() * 0.3);
    _seed.size = o.size || 2;
    _seed.color = o.colors ? o.colors[(Math.random() * o.colors.length) | 0] :
                  (o.color === undefined ? 0xFFFF : o.color);
    _seed.grav = o.grav || 0;
    _seed.ring = !!o.ring;
    _seed.grow = o.grow || 0;
    return !!parts.spawn(_pInit);
}
function pBurst(x, y, o) {
    var n = o.n === undefined ? 8 : o.n;
    var sp = o.speed === undefined ? 50 : o.speed;
    var sp2 = o.speed2 === undefined ? sp : o.speed2;
    for (var i = 0; i < n; i++) {
        var a = o.angle === undefined ? Math.random() * Math.PI * 2 : o.angle;
        var v = sp + Math.random() * (sp2 - sp);
        pPut(x, y, Math.cos(a) * v, Math.sin(a) * v, o);
    }
}
function pRing(x, y, o) {
    pPut(x, y, 0, 0, { ring: true, life: o.life || 0.3, size: o.r0 || 3,
                       color: o.color, grow: o.speed || 100 });
}

// ------------------------------------------------------------ fisica ------
var world = P.verletFast({ iterations: 4, radius: 2.5 });
var rigid = null, rigidOn = false, rigBodies = [], RIGP = [0, 0, 0, 0, 0, 0, 0, 0];

function resetTransientes() {
    isDrawing = false;
    lastPointIdx = -1;
    grabbed = -1;
    cutPrev = null;
    trailAcc = 0;
}
function sairRigid() {
    if (rigid) { rigid.free(); rigid = null; }
    rigidOn = false;
    rigBodies.length = 0;
}
function novoMundo(silent) {
    world.free();
    world = P.verletFast({ iterations: 4, radius: 2.5 });
    sairRigid();
    resetTransientes();
    if (!silent) E.ui.toast("Mundo limpo", { ms: 800, y: 0.5 });
}
function spawnRope() {
    var n = 14, step = 13;
    var x0 = 36 + Math.random() * (W - 72);
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
    var x0 = (W - cols * step) / 2;
    for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
            if (world.count() >= MAX_POINTS) return;
            var idx = world.add(x0 + c * step, 24 + r * step);
            if (idx < 0) return;
            if (r === 0 && (c === 0 || c === Math.floor(cols / 2) || c === cols - 1)) world.pin(idx);
            if (c > 0) world.stick(idx - 1, idx, step);
            if (r > 0) world.stick(idx - cols, idx, step);
        }
    }
}
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

// torre em trelica: duas colunas que afunilam, travessas e diagonais em X
function cenaTorre() {
    var baseY = BAR_Y - 8, levels = 6, stepY = 22;
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
    var n = 12, x0 = 22, x1 = W - 22, yDeck = 156, yRail = 136;
    var deck = [], rail = [], i, x, a, b;
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
    var board = [], i, a, b;
    for (i = 0; i < n; i++) {
        a = addPt(x0 + (x1 - x0) * i / (n - 1), y);
        if (a < 0) return;
        board.push(a);
        if (i > 0) linkPts(board[i - 1], a);
    }
    for (i = 0; i < n - 2; i++) linkPts(board[i], board[i + 2]);
    linkPts(board[0], board[4]);
    linkPts(board[4], board[n - 1]);
    linkPts(board[0], board[n - 1]);
    world.pin(board[4]);
    var prev = board[0];
    for (i = 1; i <= 3; i++) {
        b = addPt(x0, y + i * 18);
        if (b < 0) return;
        linkPts(prev, b);
        prev = b;
    }
}
// blocos: corpos RIGIDOS nativos (P.rigid, API 33) — giram e empilham
function cenaBlocos() {
    novoMundo(true);
    rigid = P.rigid({ iterations: 8 });
    if (!rigid) {
        E.ui.toast("Blocos rigidos so neste firmware (API 33)", { type: "warn" });
        return;
    }
    var g = rigid.box(W / 2, BAR_Y - 8, W - 8, 12, { static: true, friction: 0.9 });
    rigBodies.push({ i: g, w: W - 8, h: 12, color: TK.outline });
    var i, b;
    for (i = 0; i < 7; i++) {
        b = rigid.box(72 + (i % 3) * 44, 38 + ((i / 3) | 0) * 34, 34, 20,
                      { density: 0.8, friction: 0.7, bounce: 0.2 });
        rigBodies.push({ i: b, w: 34, h: 20, color: i % 2 ? TK.accent : TK.warn });
    }
    for (i = 0; i < 3; i++) {
        b = rigid.circle(60 + i * 48, 20, 9, { density: 2, bounce: 0.4 });
        rigBodies.push({ i: b, w: 18, h: 18, r: 9, circle: true, color: TK.ok });
    }
    rigidOn = true;
    barKey = "";
    E.ui.toast("Blocos rigidos (P.rigid)", { type: "ok", ms: 1000, y: 0.5 });
}
function montarCena(nome) {
    if (nome === "blocos") { cenaBlocos(); return; }
    novoMundo();
    if (nome === "torre") cenaTorre();
    else if (nome === "ponte") cenaPonte();
    else if (nome === "gangorra") cenaGangorra();
    else if (nome === "pano") spawnCloth();
}
var CENAS = [
    { label: "Torre", value: "torre" },
    { label: "Ponte", value: "ponte" },
    { label: "Gangorra", value: "gangorra" },
    { label: "Pano", value: "pano" },
    { label: "Blocos", value: "blocos" },
    { label: "Limpar", value: "limpar", danger: true }
];

// ------------------------------------------------------------ estado ------
var isDrawing = false, lastPointIdx = -1, grabbed = -1;
var cutPrev = null, trailAcc = 0;
var paused = false, cenasOpen = false, help = null, touchDown = false;
var barKey = "";
var _fp = { x: 0, y: 0 }, _cutRect = { x: 0, y: 0, w: 0, h: 0 };
var _grabX = 0, _grabY = 0;
var _trailO = { life: 0.3, size: 2, color: T.accent };

if (typeof __harness !== "undefined") {
    __harness.drop = {
        world: function () { return world; },
        tool: function () { return tool; },
        TOOLS: TOOLS,
        BAR_Y: BAR_Y
    };
}

// ------------------------------------------------------------ ferramentas -
// hit-test local (as checagens sao poucas linhas: point/segRect/borracha)
function nearest(x, y, r) {
    var xy = world.xy(), best = -1, bd = 0, r2 = r * r;
    for (var i = 0; i < xy.length; i += 2) {
        var dx = x - xy[i], dy = y - xy[i + 1], d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        if (best < 0 || d2 < bd) { bd = d2; best = i / 2; }
    }
    return best;
}
// segmento x retangulo (Liang-Barsky): fracao 0..1 do toque ou -1
function segRect(x0, y0, x1, y1, b) {
    if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1)) return -1;
    var t0 = 0, t1 = 1, dx = x1 - x0, dy = y1 - y0;
    var p = [-dx, dx, -dy, dy], q = [x0 - b.x, b.x + b.w - x0, y0 - b.y, b.y + b.h - y0];
    for (var i = 0; i < 4; i++) {
        if (p[i] === 0) { if (q[i] < 0) return -1; continue; }
        var t = q[i] / p[i];
        if (p[i] < 0) { if (t > t1) return -1; if (t > t0) t0 = t; }
        else { if (t < t0) return -1; if (t < t1) t1 = t; }
    }
    return t0;
}
function press(x, y) {
    if (y >= BAR_Y - 6) return;
    if (rigidOn) return;
    if (tool === 0) {                                   // Pintar
        isDrawing = true;
        if (world.count() < MAX_POINTS) {
            lastPointIdx = world.add(x, y);
            if (lastPointIdx !== -1) world.pin(lastPointIdx);
        } else lastPointIdx = -1;
    } else if (tool === 1) {                            // Pegar
        grabbed = nearest(x, y, GRAB_R);
        if (grabbed >= 0) {
            var xy = world.xy();
            _grabX = xy[grabbed * 2];
            _grabY = xy[grabbed * 2 + 1];
            E.audio.sfx("grab");
        }
        if (typeof __harness !== "undefined") {
            __harness.log.push("[grab] press em " + x.toFixed(0) + "," + y.toFixed(0) +
                               " -> " + grabbed + " (nos " + world.count() + ")");
        }
    } else if (tool === 2) {                            // Pino
        var pi = nearest(x, y, GRAB_R);
        if (pi >= 0) {
            var pins = world.pins();
            var on = !pins[pi];
            world.pin(pi, on);
            var pxy = world.xy();
            pRing(pxy[pi * 2], pxy[pi * 2 + 1],
                  { color: on ? T.warn : T.accent, r0: 3, speed: 90, life: 0.35 });
            E.audio.sfx("pin");
        }
    } else if (tool === 3) {                            // Cortar
        cutPrev = { x: x, y: y };
    }
}
function drag(x, y) {
    if (y >= BAR_Y - 6) return;
    if (rigidOn) return;
    if (tool === 0) {
        if (!isDrawing || lastPointIdx === -1) return;
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
        } else world.set(lastPointIdx, x, y);
    } else if (tool === 1) {
        if (grabbed < 0) return;
        world.set(grabbed, x, y);
        _grabX = x;
        _grabY = y;
        if (typeof __harness !== "undefined" && __harness.log.length < 4000) {
            var dxy = world.xy();
            __harness.log.push("[grab] drag dedo " + x.toFixed(0) + "," + y.toFixed(0) +
                               " | no1 " + dxy[2].toFixed(0) + "," + dxy[3].toFixed(0));
        }
    } else if (tool === 3) {
        if (!cutPrev) return;
        var st = world.sticks();
        var pts = world.xy();
        var cuts = 0;
        for (var ci = st.length / 2 - 1; ci >= 0; ci--) {
            var a2 = st[ci * 2] * 2, b2 = st[ci * 2 + 1] * 2;
            var ax = pts[a2], ay = pts[a2 + 1];
            var bxx = pts[b2], by = pts[b2 + 1];
            _cutRect.x = (ax < bxx ? ax : bxx) - CUT_PAD;
            _cutRect.y = (ay < by ? ay : by) - CUT_PAD;
            _cutRect.w = (ax > bxx ? ax : bxx) - _cutRect.x + CUT_PAD;
            _cutRect.h = (ay > by ? ay : by) - _cutRect.y + CUT_PAD;
            if (segRect(cutPrev.x, cutPrev.y, x, y, _cutRect) < 0) continue;
            var mx = (ax + bxx) / 2, my = (ay + by) / 2;
            world.delStick(ci);
            if (cuts < 4) {
                pBurst(mx, my, { n: 5, color: T.err, speed: 55, speed2: 120,
                                 life: 0.35, size: 2, grav: 120 });
                pRing(mx, my, { color: T.err, r0: 2, speed: 80, life: 0.3 });
            }
            cuts++;
        }
        if (cuts > 0) E.audio.sfx("cut");
        cutPrev = { x: x, y: y };
    } else if (tool === 4) {                            // Apagar
        var exy = world.xy();
        var r2 = ERASE_R * ERASE_R;
        for (var ei = world.count() - 1; ei >= 0; ei--) {
            var edx = exy[ei * 2] - x, edy = exy[ei * 2 + 1] - y;
            if (edx * edx + edy * edy < r2) world.delPoint(ei);
        }
        grabbed = -1;
    }
}
function release() {
    if (tool === 0) {
        isDrawing = false;
        if (lastPointIdx !== -1) { world.pin(lastPointIdx, false); lastPointIdx = -1; }
    } else if (tool === 1) {
        grabbed = -1;
    } else if (tool === 3) cutPrev = null;
}

// ------------------------------------------------------------ barra -------
// fora do recorte da camada suja: repinta so quando o estado muda ou o dedo
// entra/sai de um botao (desenho MUDO, o mundo nunca apaga a barra)
function barKeyNow() {
    var i = E.input, on = -1;
    if (i.down) {
        var all = [BTN_STAT, BTN_PAUSE].concat(BTN_TOOL, [BTN_CORDA, BTN_PANO, BTN_LIMPAR]);
        for (var k = 0; k < all.length; k++) {
            var b = all[k];
            if (i.x >= b.x && i.x <= b.x + b.w && i.y >= b.y && i.y <= b.y + b.h) { on = k; break; }
        }
    }
    return gravIdx + "|" + world.count() + "|" + tool + "|" + on + "|" + (rigidOn ? 1 : 0) + "|" + (paused ? 1 : 0);
}
var _BO = { variant: "secondary", ts: "small" };
var _BT = { variant: "secondary", ts: "tiny" };
function drawBar(force) {
    var k = barKeyNow();
    if (!force && k === barKey) return;
    barKey = k;
    var mute = E.dirty.on;
    if (mute) E.dirty._mute++;
    S.fillRect(0, BAR_Y, W, H - BAR_Y, TK.surface);
    S.drawFastHLine(0, BAR_Y, W, TK.outline);

    _BO.variant = "secondary";
    _BO.ts = "small";
    E.ui.button((rigidOn ? "rigidos" : "g: " + GRAVS[gravIdx][1]) +
                "  ·  " + (rigidOn ? rigBodies.length : world.count() + "/" + MAX_POINTS + " nós"),
                BTN_STAT.x, BTN_STAT.y, BTN_STAT.w, BTN_STAT.h, _BO);
    // icone de pausa centrado no alvo de 34x20 (o hit continua o rect cheio)
    E.ui.iconButton("pause", BTN_PAUSE.x + 7, BTN_PAUSE.y, 20, { variant: "secondary" });

    for (var ti = 0; ti < TOOLS.length; ti++) {
        _BT.variant = ti === tool ? "primary" : "secondary";
        E.ui.button(TOOLS[ti].label, BTN_TOOL[ti].x, BTN_TOOL[ti].y,
                    BTN_TOOL[ti].w, BTN_TOOL[ti].h, _BT);
    }
    _BT.variant = "secondary";
    _BO.variant = "secondary";
    E.ui.button("Corda", BTN_CORDA.x, BTN_CORDA.y, BTN_CORDA.w, BTN_CORDA.h,
                { variant: "secondary", ts: "tiny", icon: "plus" });
    E.ui.button("Pano", BTN_PANO.x, BTN_PANO.y, BTN_PANO.w, BTN_PANO.h,
                { variant: "secondary", ts: "tiny", icon: "menu" });
    E.ui.button("Limpar", BTN_LIMPAR.x, BTN_LIMPAR.y, BTN_LIMPAR.w, BTN_LIMPAR.h,
                { variant: "danger", ts: "tiny", icon: "trash" });
    if (mute) E.dirty._mute--;
}

// ------------------------------------------------------------ desenho -----
function paintWorld(x, y, w, h) {
    if (!desenhaFundo(x, y, w, h)) S.fillRect(x, y, w, h, T.bg);
}
var _lnO = { w: 2 }, _ndO = { smooth: true }, _cutO = { w: 2 };
var _hintBig = { ts: "big", align: "center", color: 0, fit: W - 24 };
var _hintSm = { ts: "small", align: "center", color: 0 };

function drawRigid() {
    var st = rigid.state();
    var i, b, x, y, a, co, si, hw, hh;
    for (i = 0; i < rigBodies.length; i++) {
        b = rigBodies[i];
        if (!rigid.alive(b.i, st)) continue;
        x = rigid.x(b.i, st);
        y = rigid.y(b.i, st);
        if (x < -40 || x > W + 40 || y < -40 || y > BAR_Y + 40) continue;   // cull
        a = rigid.angle(b.i, st);
        if (b.circle) {
            E.gfx.circle(Math.round(x), Math.round(y), b.r, b.color,
                         { smooth: true, screen: true });
            continue;
        }
        co = Math.cos(a); si = Math.sin(a);
        hw = b.w / 2; hh = b.h / 2;
        RIGP[0] = x + co * hw - si * hh; RIGP[1] = y + si * hw + co * hh;
        RIGP[2] = x - co * hw - si * hh; RIGP[3] = y - si * hw + co * hh;
        RIGP[4] = x - co * hw + si * hh; RIGP[5] = y - si * hw - co * hh;
        RIGP[6] = x + co * hw + si * hh; RIGP[7] = y + si * hw - co * hh;
        E.gfx.poly(RIGP, b.color, { screen: true, fill: true, center: true });
    }
}
function drawWorld() {
    var xy = world.xy();
    if (!rigidOn && !xy.length) {
        _hintBig.color = _hintSm.color = T.textDim;
        E.gfx.text("Pinte, ou solte Corda/Pano", W / 2, 108, _hintBig);
        E.gfx.text("Pegar arrasta e arremessa;", W / 2, 132, _hintSm);
        E.gfx.text("Cortar fatia; Pino fixa no ar", W / 2, 146, _hintSm);
    }
    if (rigidOn) {
        drawRigid();
    } else {
        var pins = world.pins();
        var st = world.sticks();
        for (var i = 0; i < st.length; i += 2) {
            var ia = st[i] * 2, ib = st[i + 1] * 2;
            var ax = xy[ia], ay = xy[ia + 1], bx = xy[ib], by = xy[ib + 1];
            // culling: vinculo fora da area do mundo nao chama a primitiva
            if ((ax < 0 && bx < 0) || (ax > W && bx > W) ||
                (ay < 0 && by < 0) || (ay > BAR_Y && by > BAR_Y)) continue;
            E.gfx.line(Math.floor(ax), Math.floor(ay), Math.floor(bx), Math.floor(by),
                       T.text, _lnO);
        }
        for (var j = 0; j < xy.length; j += 2) {
            var idx = j / 2;
            var px = xy[j], py = xy[j + 1];
            if (px < -8 || px > W + 8 || py < -8 || py > BAR_Y + 8) continue;  // cull
            var col = pins[idx] ? T.warn : T.accent;
            var r = (tool === 1 && idx === grabbed) ? 4 : 2;
            _ndO.smooth = r > 2;
            E.gfx.circle(Math.floor(px), Math.floor(py), r, col, _ndO);
        }
        if (tool === 3 && cutPrev && E.input.down && !paused) {
            E.gfx.line(Math.floor(cutPrev.x), Math.floor(cutPrev.y),
                       Math.floor(E.input.x), Math.floor(E.input.y), T.err, _cutO);
        }
    }
    parts.draw({ cull: true, pad: 8 });
    S.drawFastHLine(0, BAR_Y - 1, W, T.stroke);
}

// ------------------------------------------------------------ pause ------
function pausar() {
    if (paused) return;
    paused = true;
    resetTransientes();
    E.audio.sfx("ui");
    barKey = "";
}
function retomar() {
    paused = false;
    barKey = "";
}

// ------------------------------------------------------------- cenas ------
function entrarJogo() {
    paused = false;
    barKey = "";
}
function abrirCena(nome) {
    cenasOpen = false;
    montarCena(nome);
    E.goto("jogo", { transition: "fade", ms: 300 });
}

E.onSleep = function () {
    if (E.sceneName === "jogo" && !paused) pausar();
};
E.onWake = function () { barKey = ""; E.redraw(); };

var HELP = "Pinte um traco para criar a corda; solte Corda ou Pano para nascer pronto. " +
           "Pegar arrasta o no com o dedo (e arremessa ao soltar), Pino prende no ar, " +
           "Cortar fatia os vinculos e Apagar borra os nos. O botao de gravidade no " +
           "topo da barra cicla ate a invertida. A cena Blocos usa corpos rigidos.";

E.run({
    titulo: {
        static: true,
        enter: function () {
            cenasOpen = false;
            help = null;
            E.dirty.off();
        },
        update: function () {
            if (cenasOpen || (help && !help.closed)) E.redraw();
        },
        draw: function () {
            E.gfx.gradient(0, 0, W, H, TK.surface, TK.bg, { screen: true });
            if (cenasOpen) {
                var close = E.ui.sheet("cenas", { open: true, title: "CENAS", h: 214 },
                    function (c) {
                        var g = E.ui.segmented(c.x, c.y, c.w,
                                               ["normal", "leve", "lua", "forte", "inv"],
                                               gravIdx, { h: 30, ts: "tiny" });
                        if (g !== gravIdx) {
                            gravIdx = g;
                            E.save.set("grav", g);
                            E.audio.sfx("grav");
                        }
                        var grid = E.ui.grid(c.x, c.y + 44, c.w, 3, { rowH: 34, gap: 6 });
                        for (var i = 0; i < CENAS.length; i++) {
                            var cell = grid.cell(i);
                            var it = CENAS[i];
                            if (E.ui.button(it.label, cell.x, cell.y, cell.w, cell.h,
                                            { variant: it.danger ? "danger" : "secondary",
                                              ts: "small" })) {
                                E.audio.sfx("ui");
                                abrirCena(it.value);
                            }
                        }
                    });
                if (close === "close") {
                    cenasOpen = false;
                    this.static = true;
                    E.redraw();
                    E.audio.sfx("back");
                }
                return;
            }
            if (help) {
                if (!help.draw(18, 96, 204)) { help = null; this.static = true; E.redraw(); }
                return;
            }
            var act = E.ui.title({ game: "PHYSICS DROP",
                                   subtitle: "areia, corda e pano em verlet",
                                   extra: "Cenas", bg: false });
            if (act === "start") {
                E.audio.sfx("ok");
                entrarJogo();
                E.goto("jogo", { transition: "fade", ms: 300 });
                return;
            }
            if (act === "extra") {
                E.audio.sfx("ui");
                cenasOpen = true;
                this.static = false;
                return;
            }
            if (E.ui.button("Como jogar", W / 2 - 75, 258, 150, 30, { variant: "secondary" })) {
                help = E.ui.dialog(HELP, { name: "COMO JOGAR", speed: 45 });
                this.static = false;
                E.audio.sfx("ui");
            }
        }
    },

    jogo: {
        enter: function () {
            entrarJogo();
            E.dirty.enable(paintWorld);
            E.dirty.clip(0, 0, W, BAR_Y);
            drawBar(true);
        },
        exit: function () {
            E.dirty.off();
            sairRigid();
            paused = false;
        },
        update: function (dt) {
            // o fim do veu de transicao repinta a faixa FORA do recorte com o
            // painter do mundo: a barra (memoizada) precisa voltar
            if (E.transitioning) barKey = "";
            if (paused) return;
            var i = E.input;

            if (E.hit(BTN_PAUSE)) { pausar(); return; }
            if (E.hit(BTN_STAT)) {
                gravIdx = (gravIdx + 1) % GRAVS.length;
                E.save.set("grav", gravIdx);
                E.audio.sfx("grav");
                E.ui.toast("Gravidade: " + GRAVS[gravIdx][1], { ms: 1000, y: 0.5,
                           type: gravIdx === GRAVS.length - 1 ? "err" : "info" });
            }
            for (var ti = 0; ti < TOOLS.length; ti++) {
                if (E.hit(BTN_TOOL[ti])) {
                    if (rigidOn) { sairRigid(); novoMundo(); }
                    tool = ti;
                    E.save.set("tool", tool);
                    E.audio.sfx("ui");
                    E.ui.toast("Ferramenta: " + TOOLS[ti].label, { ms: 900, y: 0.5 });
                }
            }
            if (E.hit(BTN_CORDA)) { sairRigid(); spawnRope(); E.audio.sfx("ui"); }
            if (E.hit(BTN_PANO)) { sairRigid(); spawnCloth(); E.audio.sfx("ui"); }
            if (E.hit(BTN_LIMPAR)) { novoMundo(); E.audio.sfx("back"); }

            var inWorld = i.down && i.y < BAR_Y - 6;
            if (rigidOn && i.justUp && !i.moved && i.y < BAR_Y - 6) {
                var nb = rigid.box(i.x, i.y, 30, 18, { density: 1, friction: 0.6, bounce: 0.25 });
                rigBodies.push({ i: nb, w: 30, h: 18, color: TK.accent });
            }
            if (i.down && !touchDown) { touchDown = true; if (inWorld) press(i.x, i.y); }
            else if (!i.down && touchDown) { touchDown = false; release(); }
            if (inWorld) drag(i.x, i.y);

            if (rigidOn && rigid) {
                rigid.step(1 / 25, { gravity: { x: 0, y: GRAVS[gravIdx][0] * 900 }, maxSub: 8 });
            } else {
                // fisica: 2 steps por frame, dt=1 mantem os presets em px/step
                for (var stp = 0; stp < 2; stp++) {
                    world.step(1, { gravity: { x: 0, y: GRAVS[gravIdx][0] },
                                    damp: 0.999,
                                    bounds: { x: 0, y: 0, w: W, h: BAR_Y - 4 },
                                    bounce: 0.8 });
                }
            }
            // rastro do no pego (pool, sem objeto por quadro)
            if (tool === 1 && grabbed >= 0) {
                trailAcc += dt * 30;
                while (trailAcc >= 1) {
                    trailAcc--;
                    pPut(_grabX, _grabY, 0, 8, _trailO);
                }
            }
            parts.update(dt);
            drawBar(false);
        },
        draw: function () {
            drawWorld();
            if (paused) {
                var act = E.ui.pause({ title: "PAUSA", clear: true,
                                       labels: ["Continuar", "Limpar", "Sair"] });
                if (act === "resume") { retomar(); E.audio.sfx("ui"); }
                else if (act === "restart") { novoMundo(); retomar(); E.audio.sfx("back"); }
                else if (act === "quit") {
                    paused = false;
                    E.audio.sfx("back");
                    E.goto("titulo", { transition: "fade", ms: 300 });
                }
            }
        }
    }
}, "titulo");
