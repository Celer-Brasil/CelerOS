// game.js — CelerGame CORE (dep "celeros.game"): loop de cenas, input,
// desenho, camera, matematica, timers/tweens, entidades, camada suja,
// audio e save (ES5, sobre a API JS; requer api >= 30 para vir como dep).
// A engine POSSUI o loop: o app define cenas e chama E.run().
//
//   var E = require("celeros.game");      // so o core — ou adote modulos:
//   require("celeros.game.fx");           // particulas/flash/estrelas
//   require("celeros.game.spr");          // sprites em slots + flipbook
//   require("celeros.game.tilemap");      // grade de celulas sujas
//   E.init({ dir: "MeuJogo", fps: 30 });  // dir = pasta do app p/ assets
//   E.run({ titulo: { enter, update(dt), draw, exit }, jogo: { ... } },
//         "titulo");
//
// Cada modulo da familia decora ESTE objeto no require (o cache do
// require faz o core ser singleton) e pendura o tick em E._modTicks, que
// o loop chama antes do update da cena. Quem adota pouco paga pouco: as
// deps contam no teto do app MESMO compartilhadas (cada app compila o
// modulo no proprio heap) — core enxuto ~20KB, a familia inteira ~33KB.
// O pacote "celeros.engine" e a familia montada (compatibilidade 1.2.x).
// Fisica (P.hit/verlet/rigid) e a dep "celeros.physics"; grades de IA a
// "celeros.grid"; sons de tabela a "celeros.sfx". Recursos do firmware
// sao detectados em E.caps — roda em toda placa e no harness/emu sem
// mudanca. Veja Documentation/Game_Engine_Guide.
//
// Historico (viveu ate 1.2.4 no modulo unico "celeros.engine"; o core
// 1.0.0 e aquele codigo partido em modulos, sem mudanca de API):
// 1.2: escala e tipografia por PIXEL (E.U/E.u, E.font, text {px}); cenas
// `static`; camada E.dirty; sfx misturado sem bloquear (System.sfx).
// 1.2.3 (performance): opts compartilhado nos wrappers gfx (zero
// alocacao por primitiva); E.font/textWidth memoizados; dirty.add sem
// Math.* para coords inteiras; setTextDatum so quando pede.
// 1.2.4 (performance): fx pula o pool vazio; camera inline no draw das
// particulas; novo E.dirty.erase(x, y, w, h).
// 1.0.0 (CelerGame): modulos fx/spr/tilemap extraidos; tick deles no
// registro E._modTicks (antes colado no corpo do E.run); init tolera
// modulo ausente (E.spr/E.fx/E.tilemap undefined quando nao adotado).

var E = { version: '1.0.1' };
var S = System;

// opts compartilhado (so leitura): os wrappers gfx sem opts nao alocam —
// objeto novo por primitiva era pressao de GC no Duktape a cada quadro
var EMPTY = {};

// registro dos modulos da familia: cada celeros.game.* decora este E no
// require e pendura function(dt, now) aqui — o loop chama antes do
// update da cena (o fx morava colado no corpo do E.run)
E._modTicks = [];
E._mods = [];       // nomes carregados (["fx", "spr", ...]) — diagnostico
E._inited = false;  // modulo carregado DEPOIS do init se auto-inicializa

// ------------------------------------------------------- caps / init ------

E.caps = (function () {
    var info = null;
    try { info = S.getInfo(); } catch (e) {}
    return {
        psram: !!(info && info.totalPSRAM > 0),
        speaker: !!(info && info.hasSpeaker),
        music: typeof S.playMusic === 'function',
        png: typeof S.drawPNG === 'function',
        sprites: typeof S.createSprite === 'function',
        smooth: typeof S.fillSmoothCircle === 'function',
        round: typeof S.fillSmoothRoundRect === 'function',
        gradient: typeof S.fillGradient === 'function',
        arc: typeof S.fillArc === 'function',
        wide: typeof S.drawWideLine === 'function',
        slots: typeof S.spriteSlots === 'function' ? S.spriteSlots() : 4,
        mix: typeof S.sfx === 'function',          // API 32: sfx sem bloquear
        clip: typeof S.setClip === 'function',
        button: typeof S.button === 'function',
        // tela fisica grande (>= 400): o firmware promove as fontes 1/2/4
        big: !!(info && info.screenW >= 400),
        native: false, w: 240, h: 320
    };
})();

E.theme = null;
E.W = 240;
E.H = 320;
E.U = 1;                // escala do projeto: min(W, H) / 240 (2 no 480 nativo)
E.dt = 0;
E.fps = 0;
E.data = {};            // bolsa compartilhada entre cenas
E.sceneName = '';

E.init = function (opts) {
    opts = opts || {};
    E.fpsTarget = opts.fps === undefined ? 30 : opts.fps;
    if (opts.native && typeof S.setNativeCanvas === 'function') {
        E.caps.native = !!S.setNativeCanvas(true);
    } else if (opts.native === false && E.caps.native) {
        S.setNativeCanvas(false);
        E.caps.native = false;
    }
    E.W = E.caps.w = S.screenWidth();
    E.H = E.caps.h = S.screenHeight();
    E.U = Math.min(E.W, E.H) / 240;
    E._fonts = null;    // tabela de fontes medida sob demanda (E.font)
    E._fontMemo = null; // idem: px -> entrada da tabela (busca e O(1))
    try { E.theme = S.theme(); } catch (e) { E.theme = null; }
    if (opts.keepAwake !== false && typeof S.keepAwake === 'function') {
        S.keepAwake(true);
    }
    E.save.prefix = opts.save || '';
    // bases de assets e pool de particulas sao dos MODULOS adotados —
    // o core roda sozinho (um jogo core-only nao paga spr/fx)
    if (E.spr) {
        E.spr.bases = opts.bases ||
                      (opts.dir ? ['/local/apps/' + opts.dir + '/assets/',
                                   '/sd/apps/' + opts.dir + '/assets/'] : []);
    }
    if (E.fx) E.fx._reset(opts.particles || 96);
    E._inited = true;
    return E.caps;
};

// u(v): medida do projeto (240 de largura) em pixels da tela atual —
// layout que vale igual no 240x320 virtual, no 480 nativo e no relogio
E.u = function (v) { return Math.round(v * E.U); };

// Tipografia por PIXEL: as fontes do firmware (1/2/4) medidas no alvo
// (fontHeight ja inclui a promocao de tela grande) x textSize 1..4. font(px)
// devolve {font, size, h} da maior que cabe em px (ou a menor de todas).
// A tabela e os resultados por px sao memoizados: text() consulta por quadro.
E._fontMemo = null;
E.font = function (px) {
    var memo = E._fontMemo;
    if (memo) {
        var hit = memo[px];
        if (hit) return hit;
    }
    var t = E._fonts;
    if (!t) {
        t = [];
        var fs = [1, 2, 4];
        for (var i = 0; i < fs.length; i++) {
            var h = 0;
            try { h = S.fontHeight(fs[i]); } catch (e) { h = 0; }
            if (!(h > 0)) h = fs[i] === 1 ? 8 : (fs[i] === 2 ? 16 : 26);
            for (var sz = 1; sz <= 4; sz++) t.push({ font: fs[i], size: sz, h: h * sz,
                                                      // proto nulo: "toString"/"constructor"
                                                      // como chave de cache nao podem voltar
                                                      // do Object.prototype como largura
                                                      _w: Object.create(null), _wn: 0 });
        }
        // menor altura primeiro; no empate vence a fonte maior (size 1 de
        // uma fonte grande e mais nitido que size 2 de uma pequena)
        t.sort(function (a, b) { return a.h - b.h || a.size - b.size; });
        E._fonts = t;
    }
    var best = t[0], k;
    for (k = 0; k < t.length; k++) {
        if (t[k].h <= px * 1.08) {
            if (t[k].h > best.h || (t[k].h === best.h && t[k].size < best.size)) best = t[k];
        }
    }
    // menos ampliacao vence a ate 15% da altura: DejaVu24 (25 px) e nitida,
    // a DejaVu12 x2 (26 px) serrilhada; DejaVu24 x2 (50) bate DejaVu12 x4
    if (best.size > 1) {
        var pick = best;
        for (k = 0; k < t.length; k++) {
            var c = t[k];
            if (c.h > best.h || c.h < best.h * 0.85) continue;
            if (c.size < pick.size || (c.size === pick.size && c.h > pick.h)) pick = c;
        }
        best = pick;
    }
    if (!memo) memo = E._fontMemo = {};
    memo[px] = best;
    return best;
};

// tamanhos de texto por PAPEL (px no projeto 240; o text escala por E.U)
E.ts = { tiny: 9, small: 11, body: 13, label: 15, big: 20, title: 28, huge: 40 };

// ------------------------------------------------------------- mat -------

E.m = {
    clamp: function (v, a, b) { return v < a ? a : (v > b ? b : v); },
    lerp: function (a, b, t) { return a + (b - a) * t; },
    map: function (v, a, b, c, d) { return c + (v - a) * (d - c) / (b - a); },
    rand: function (a, b) {
        if (a === undefined) { a = 0; b = 1; }
        else if (b === undefined) { b = a; a = 0; }
        return a + Math.random() * (b - a);
    },
    randInt: function (a, b) { return Math.floor(E.m.rand(a, b + 1)); },
    pick: function (arr) { return arr[Math.floor(Math.random() * arr.length)]; },
    dist: function (x0, y0, x1, y1) {
        var dx = x1 - x0, dy = y1 - y0;
        return Math.sqrt(dx * dx + dy * dy);
    },
    dist2: function (x0, y0, x1, y1) {
        var dx = x1 - x0, dy = y1 - y0;
        return dx * dx + dy * dy;
    },
    ang: function (x0, y0, x1, y1) { return Math.atan2(y1 - y0, x1 - x0); },
    approach: function (v, target, delta) {
        if (v < target) return v + delta > target ? target : v + delta;
        return v - delta < target ? target : v - delta;
    },
    wrap: function (v, a, b) {
        if (v < a) return b - (a - v) % (b - a);
        if (v >= b) return a + (v - a) % (b - a);
        return v;
    },
    sign: function (v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); },
    linear: function (t) { return t; },
    inQuad: function (t) { return t * t; },
    outQuad: function (t) { return t * (2 - t); },
    inOutQuad: function (t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; },
    outBack: function (t) {
        var s = 1.70158;
        t = t - 1;
        return t * t * ((s + 1) * t + s) + 1;
    }
};

// PRNG deterministico (xorshift32) — testes e mundo procedural.
E.rng = function (seed) {
    var a = (seed >>> 0) || 0x9E3779B9;
    return function () {
        a ^= a << 13;
        a >>>= 0;
        a ^= a >>> 17;
        a ^= a << 5;
        a >>>= 0;
        return a / 4294967296;
    };
};

// ----------------------------------------------------------- input -------

E.input = {
    x: 0, y: 0,            // toque atual (ou ultimo antes de soltar)
    down: false,
    justDown: false,
    justUp: false,
    moved: false,          // passou do limiar de arrasto desde o press
    dx: 0, dy: 0,          // delta desde o frame anterior
    holdDx: 0, holdDy: 0,  // delta desde o press
    tap: null,             // {x, y} — toque seco (< tapMs, sem arrastar)
    swipe: null,           // {dir, dx, dy, dist}
    longpress: false,      // >= longMs sem arrastar (1 tiro por toque)
    btn: 0,                // botao fisico (devkit): 1 curto, 2 longo
    dragThresh: 12,
    tapMs: 350,
    swipeMin: 30,
    longMs: 600,
    _raw: { down: false, sx: 0, sy: 0, t0: 0, moved: false, longDone: false }
};

E._pollInput = function (now) {
    var i = E.input, r = i._raw;
    i.justDown = false;
    i.justUp = false;
    i.dx = 0;
    i.dy = 0;
    i.tap = null;
    i.swipe = null;
    i.longpress = false;
    var t = S.getTouch();
    if (t.touched) {
        if (!r.down) {
            r.down = true;
            r.sx = t.x;
            r.sy = t.y;
            r.t0 = now;
            r.moved = false;
            r.longDone = false;
            i.justDown = true;
            i.holdDx = 0;
            i.holdDy = 0;
        } else {
            i.dx = t.x - i.x;
            i.dy = t.y - i.y;
        }
        i.x = t.x;
        i.y = t.y;
        i.down = true;
        i.holdDx = t.x - r.sx;
        i.holdDy = t.y - r.sy;
        if (!r.moved && (Math.abs(i.holdDx) > i.dragThresh ||
                         Math.abs(i.holdDy) > i.dragThresh)) r.moved = true;
        i.moved = r.moved;
        if (!r.moved && !r.longDone && now - r.t0 >= i.longMs) {
            r.longDone = true;
            i.longpress = true;
        }
    } else if (r.down) {
        r.down = false;
        i.down = false;
        i.justUp = true;
        if (!r.moved && now - r.t0 < i.tapMs) i.tap = { x: r.sx, y: r.sy };
        else if (r.moved) {
            var dx = i.x - r.sx, dy = i.y - r.sy;
            if (dx * dx + dy * dy >= i.swipeMin * i.swipeMin) {
                i.swipe = {
                    dx: dx, dy: dy, dist: Math.sqrt(dx * dx + dy * dy),
                    dir: Math.abs(dx) >= Math.abs(dy) ?
                         (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')
                };
            }
        }
    }
    i.btn = E.caps.button ? S.button() : 0;
    return t;
};

// toque seco dentro do rect {x,y,w,h}
E.hit = function (b) {
    var t = E.input.tap;
    return !!t && t.x >= b.x && t.x <= b.x + b.w && t.y >= b.y && t.y <= b.y + b.h;
};

// dedo pressionado dentro do rect (feedback de botao apertado)
E.press = function (b) {
    var i = E.input;
    return i.down && i.x >= b.x && i.x <= b.x + b.w && i.y >= b.y && i.y <= b.y + b.h;
};

// ------------------------------------------------- cenas e loop ----------

E._scenes = null;
E._scene = null;
E._next = null;
E._quit = false;
E._last = 0;
E._fpsT = 0;
E._fpsN = 0;
E._redraw = true;       // cena static: pede 1 draw
E._btns = [];           // botoes desenhados no ultimo draw (E.gfx.button)
E._btnOn = -1;          // indice do botao sob o dedo (feedback de press)

E.goto = function (name, opts) {
    E._next = name;
    E._transReq = opts || null;
};
E.quit = function () { E._quit = true; };
// cena static: agenda um draw (estado mudou). Em cena comum e no-op.
E.redraw = function () { E._redraw = true; };

// ------------------------------------------- transicao de cena (veu) ------

// E.goto(nome, {transition, ms, color, dir}) — veu por cima da tela em
// vez de captura de quadro (nao ha binding de screen->sprite): 'fade'
// fecha um veu sobre a cena atual (metade do ms) e abre na nova (outra
// metade); 'iris' abre um buraco quadrado crescente na nova cena; 'wipe'
// retrai o veu numa direcao (dir: left|right|up|down, default left);
// 'bands' retrai 8 colunas em stagger. Custo: <= 9 fillRect/quadro, e a
// camada suja repinta o fundo inteiro enquanto o veu vive (E.dirty.full
// por quadro — transicao e curta).
E._trans = null;
E._transReq = null;
E._drawTrans = function () {
    var t = E._trans;
    var p = t.t / t.ms;
    if (p > 1) p = 1;
    var c = t.color, W = E.W, H = E.H;
    if (t.kind === 'wipe') {
        if (t.dir === 'right') S.fillRect(0, 0, Math.round(W * p), H, c);
        else if (t.dir === 'up') S.fillRect(0, Math.round(H * p), W, H - Math.round(H * p), c);
        else if (t.dir === 'down') S.fillRect(0, 0, W, Math.round(H * p), c);
        else S.fillRect(Math.round(W * p), 0, W - Math.round(W * p), H, c);
        return;
    }
    if (t.kind === 'bands') {
        var n = 8, bw = W / n;
        for (var i = 0; i < n; i++) {
            var q = p * 1.7 - i * 0.0875;   // stagger: coluna i comeca depois
            var bx = Math.round(i * bw), bw2 = Math.round(bw);
            if (q <= 0) { S.fillRect(bx, 0, bw2, H, c); continue; }
            if (q >= 1) continue;
            var by = Math.round(q * H);
            S.fillRect(bx, by, bw2, H - by, c);
        }
        return;
    }
    // 'fadeout' (buraco fechando) e 'in'/'iris' (abrindo): 4 retangulos
    // em volta do buraco quadrado centrado
    var half = Math.max(W, H) / 2;
    var r = (t.kind === 'fadeout' ? 1 - p : p) * half;
    var x0 = Math.round(W / 2 - r), x1 = Math.round(W / 2 + r);
    var y0 = Math.round(H / 2 - r), y1 = Math.round(H / 2 + r);
    if (y0 > 0) S.fillRect(0, 0, W, y0, c);
    if (y1 < H) S.fillRect(0, y1, W, H - y1, c);
    if (x0 > 0 && y1 > y0) S.fillRect(0, y0, x0, y1 - y0, c);
    if (x1 < W && y1 > y0) S.fillRect(x1, y0, W - x1, y1 - y0, c);
};

// botao sob o dedo entre os do ultimo draw (-1 = nenhum)
E._btnUnder = function () {
    var i = E.input;
    if (!i.down) return -1;
    for (var k = 0; k < E._btns.length; k++) {
        var b = E._btns[k];
        if (i.x >= b.x && i.x <= b.x + b.w && i.y >= b.y && i.y <= b.y + b.h) return k;
    }
    return -1;
};

// roda cenas {enter, update(dt), draw, exit, fps, static} ate E.quit();
// ticka input, audio, camera, MODULOS (E._modTicks), timers e tweens
// antes do update da cena. static: true = a cena so desenha na entrada,
// no E.redraw() e quando o dedo entra/sai de um E.gfx.button — menu
// parado nao repinta (nem empurra) nada por quadro.
E.run = function (scenes, first) {
    E._scenes = scenes;
    E._quit = false;
    E._next = null;
    var cur = null;

    function enter(name) {
        cur = scenes[name];
        if (!cur) throw new Error('cena inexistente: ' + name);
        E._scene = cur;
        E.sceneName = name;
        E._redraw = true;
        E._btns.length = 0;
        E._btnOn = -1;
        // a camada suja e da cena que a liga: a proxima recomeca do zero
        E.dirty.off();
        if (cur && cur.enter) cur.enter();
    }
    enter(first);
    E._last = S.millis();
    E._fpsT = E._last;
    E._fpsN = 0;

    while (!E._quit) {
        if (E._next !== null) {
            var n = E._next;
            var troca = true;
            if (E._transReq) {
                if (!E._trans && E._transReq.transition === 'fade') {
                    // fase OUT: veu fecha sobre a cena atual ANTES da troca
                    E._trans = { kind: 'fadeout', t: 0, done: false,
                                 ms: Math.max(1, (E._transReq.ms || 500) / 2),
                                 color: E._transReq.color === undefined ? 0x0000 : E._transReq.color };
                    troca = false;
                } else if (E._trans && E._trans.kind === 'fadeout' && !E._trans.done) {
                    troca = false;   // espera o veu fechar
                }
            }
            if (troca) {
                E._next = null;
                if (cur && cur.exit) cur.exit();
                enter(n);
                E._last = S.millis();
                if (E._transReq) {
                    var rq = E._transReq, k = rq.transition;
                    E._trans = {
                        kind: k === 'bands' ? 'bands' : (k === 'wipe' ? 'wipe' : 'in'),
                        t: 0, done: false,
                        ms: Math.max(1, k === 'fade' ? (rq.ms || 500) / 2 : (rq.ms || 400)),
                        color: rq.color === undefined ? 0x0000 : rq.color,
                        dir: rq.dir || 'left'
                    };
                    E._transReq = null;
                }
            }
        }
        var now = S.millis();
        var dt = (now - E._last) / 1000;
        E._last = now;
        if (dt > 0.1) dt = 0.1;
        if (dt < 0) dt = 0;
        E.dt = dt;
        if (E._trans) {
            E._trans.t += dt * 1000;
            if (E._trans.t >= E._trans.ms) {
                if (E._trans.kind === 'fadeout') E._trans.done = true;
                else {
                    E._trans = null;   // terminou: cena limpa
                    // o ultimo quadro do veu pintou rects FORA da camada suja
                    // (_drawTrans e System.fillRect puro): sem este repaint
                    // integral os restos do veu (cantos/colunas/borda) ficam
                    // na tela ate algo se mover em cima — "blocos pretos"
                    E.dirty._full = true;
                    E._redraw = true;  // cena static repinta junto
                }
            }
        }
        E._fpsN++;
        if (now - E._fpsT >= 1000) {
            E.fps = E._fpsN;
            E._fpsN = 0;
            E._fpsT = now;
        }
        E._pollInput(now);
        E.audio._tick();
        E.cam._tick(dt);
        var mt = E._modTicks;
        for (var mi = 0; mi < mt.length; mi++) mt[mi](dt, now);
        E._tickTimers(now);
        E._tickTweens(now);
        if (cur && cur.update) cur.update(dt);
        if (E._quit) break;
        if (cur && cur.draw) {
            var draw = true;
            if (cur.static) {
                var on = E._btnUnder();
                if (on !== E._btnOn) {
                    E._btnOn = on;
                    E._redraw = true;
                }
                draw = E._redraw || !!E._trans;   // transicao repinta sempre
            }
            if (draw) {
                E._redraw = false;
                E._btns.length = 0;
                if (E.dirty.on) {
                    // o veu cobre a tela: repinta o fundo inteiro por quadro
                    if (E._trans) E.dirty._full = true;
                    E.dirty._begin();
                }
                cur.draw();
                if (E.dirty.on) E.dirty._end();
                if (E._trans) E._drawTrans();
            }
        }
        // pacing: fps global, ou o da cena (cur.fps; 0 = sem teto)
        var fps = cur && cur.fps !== undefined ? cur.fps : E.fpsTarget;
        var frameMin = fps > 0 ? Math.floor(1000 / fps) : 0;
        var spent = S.millis() - now;
        S.delay(spent < frameMin ? frameMin - spent : 1);
    }
    if (cur && cur.exit) cur.exit();
    E._scene = null;
};

// ----------------------------------------------------- camada suja -------

// Apaga-e-redesenha SO o que mudou: cada desenho da engine (gfx, blit, fx,
// texto) registra sua caixa de tela; no quadro seguinte essas caixas voltam
// ao fundo (cor lisa ou painter) antes do draw. Substitui o fillScreen por
// quadro — no painel RGB de 480x480 o redesenho integral saturava a PSRAM
// e o vidro tremia; com o firmware de caixas sujas (API 32) so as caixas
// vao ao vidro. Desenho direto via System.* registra com E.dirty.add().
//
//   enter: function () { E.dirty.enable(0x0000); }   // fundo preto
//   E.dirty.enable(function (x, y, w, h) { mapa.markRect(x, y, w, h); })
//   (a cena chama mapa.flush() na 1a linha do draw)
E.dirty = {
    on: false,
    _bg: 0,
    _paint: null,
    _prev: [],          // [x,y,w,h, x,y,w,h, ...] do quadro anterior
    _cur: [],
    _full: true,
    _wasFull: false,
    _clip: null,
    _mute: 0,           // >0: repintura de fundo (tilemap.flush) nao registra

    // liga a camada (bg: cor RGB565 ou painter(x, y, w, h)); o 1o quadro
    // repinta o fundo inteiro
    enable: function (bg) {
        var d = E.dirty;
        d.on = true;
        if (typeof bg === 'function') { d._paint = bg; d._bg = 0; }
        else { d._paint = null; d._bg = bg === undefined ? 0 : bg; }
        d._prev.length = 0;
        d._cur.length = 0;
        d._full = true;
        return d;
    },
    off: function () {
        var d = E.dirty;
        d.on = false;
        d._prev.length = 0;
        d._cur.length = 0;
        d._clip = null;
    },
    // proximo quadro repinta o fundo inteiro (flash, troca de tela, shake
    // de cenario)
    full: function () { E.dirty._full = true; },
    // recorte da area de jogo: o apagar e o desenho do mundo nao invadem o
    // HUD (o HUD so repinta quando muda)
    clip: function (x, y, w, h) {
        E.dirty._clip = w === undefined ? null : { x: x, y: y, w: w, h: h };
    },
    // solta o recorte no meio do draw (o HUD desenha por cima da area de
    // jogo depois do mundo); o _end fecha de qualquer jeito
    unclip: function () {
        if (E.dirty._clip && E.caps.clip) S.clearClip();
    },
    // registra uma caixa de TELA desenhada neste quadro
    add: function (x, y, w, h) {
        var d = E.dirty;
        if (!d.on || d._mute || !(w > 0) || !(h > 0)) return;
        // coords inteiras (o caso de todo gfx/blit, que ja arredonda) nao
        // pagam as 4 chamadas Math.*: ToInt32 resolve no proprio comparador
        if (x !== (x | 0)) x = Math.floor(x);
        if (y !== (y | 0)) y = Math.floor(y);
        if (w !== (w | 0)) w = Math.ceil(w);
        if (h !== (h | 0)) h = Math.ceil(h);
        d._cur.push(x - 1, y - 1, w + 2, h + 2);
    },
    // apaga JA o rect (fundo/painter) e registra: algo desenhado PARADO
    // (fora da camada, redesenhado so quando tocado) que vai se mexer — a
    // borracha so conhece as caixas do quadro anterior e o desenho velho
    // ficaria. Chame no inicio do draw: o que vem depois ve o toque
    erase: function (x, y, w, h) {
        var d = E.dirty;
        if (!d.on || !(w > 0) || !(h > 0)) return;
        // pixels inteiros com a mesma folga de 1 px do add (o desenho velho
        // pode ter borda AA fora da caixa fracionaria)
        var x0 = Math.floor(x), y0 = Math.floor(y);
        w = Math.ceil(x + w) - x0;
        h = Math.ceil(y + h) - y0;
        d._fill(x0 - 1, y0 - 1, w + 2, h + 2);
        d.add(x0, y0, w, h);
    },
    // alguma caixa (apagada agora ou desenhada neste quadro) toca o rect?
    // o HUD usa para saber se precisa repintar
    touches: function (x, y, w, h) {
        var d = E.dirty;
        if (d._wasFull || d._full) return true;
        return d._hit(d._prev, x, y, w, h) || d._hit(d._cur, x, y, w, h);
    },
    // (bordas do rect e o length fora do laco: o Duktape nao iça nada —
    // a pilha parada pergunta isto por peca, por quadro)
    _hit: function (a, x, y, w, h) {
        var x1 = x + w, y1 = y + h, bx, by;
        for (var i = 0, n = a.length; i < n; i += 4) {
            bx = a[i];
            if (bx >= x1 || bx + a[i + 2] <= x) continue;
            by = a[i + 1];
            if (by < y1 && by + a[i + 3] > y) return true;
        }
        return false;
    },
    _fill: function (x, y, w, h) {
        var d = E.dirty;
        if (x < 0) { w += x; x = 0; }
        if (y < 0) { h += y; y = 0; }
        if (x + w > E.W) w = E.W - x;
        if (y + h > E.H) h = E.H - y;
        if (w <= 0 || h <= 0) return;
        if (d._paint) d._paint(x, y, w, h);
        else S.fillRect(x, y, w, h, d._bg);
    },
    _begin: function () {
        var d = E.dirty, c = d._clip;
        if (c && E.caps.clip) S.setClip(c.x, c.y, c.w, c.h);
        // consome o pedido AQUI: um full() pedido durante o draw (flash de
        // tela cheia) vale para o quadro seguinte
        d._wasFull = d._full;
        d._full = false;
        if (d._wasFull) {
            if (c) d._fill(c.x, c.y, c.w, c.h);
            else d._fill(0, 0, E.W, E.H);
        } else {
            var a = d._prev;
            for (var i = 0; i < a.length; i += 4) d._fill(a[i], a[i + 1], a[i + 2], a[i + 3]);
        }
    },
    // fim do draw: o que foi desenhado agora e o que se apaga no proximo
    _end: function () {
        var d = E.dirty;
        if (d._clip && E.caps.clip) S.clearClip();
        var t = d._prev;
        d._prev = d._cur;
        t.length = 0;
        d._cur = t;
    }
};

// -------------------------------------------------- timers e tweens ------

E._timers = [];
E.after = function (ms, fn) {
    var t = { at: S.millis() + ms, fn: fn, dead: false };
    E._timers.push(t);
    return t;
};
E.every = function (ms, fn) {
    var t = { at: S.millis() + ms, every: ms, fn: fn, dead: false };
    E._timers.push(t);
    return t;
};
E.cancel = function (t) { if (t) t.dead = true; };
// limpa tudo de uma vez (chame no exit da cena que criou timers/tweens)
E.clearTimers = function () { E._timers.length = 0; };
E.clearTweens = function () { E._tweens.length = 0; };
E._tickTimers = function (now) {
    for (var k = E._timers.length - 1; k >= 0; k--) {
        var t = E._timers[k];
        if (!t) { continue; }   // fn de outro timer limpou a lista no meio do tick
        if (t.dead) { E._timers.splice(k, 1); continue; }
        if (now < t.at) continue;
        if (t.every) {
            t.at += t.every;
            if (t.at < now) t.at = now + t.every;
        } else {
            t.dead = true;
        }
        t.fn();
    }
};

// tween de props numericas: E.tween(obj, {x: 100}, 500, {ease, delay, onDone})
E._tweens = [];
E.tween = function (obj, to, ms, opts) {
    opts = opts || {};
    var from = {};
    for (var k in to) if (k in obj) from[k] = obj[k];
    var tw = {
        obj: obj, from: from, to: to, ms: ms < 1 ? 1 : ms,
        t0: S.millis() + (opts.delay || 0),
        ease: opts.ease || E.m.inOutQuad,
        onDone: opts.onDone || null,
        dead: false
    };
    E._tweens.push(tw);
    return tw;
};
E._tickTweens = function (now) {
    for (var k = E._tweens.length - 1; k >= 0; k--) {
        var tw = E._tweens[k];
        if (!tw) { continue; }  // onDone de outro tween limpou a lista no meio do tick
        if (tw.dead) { E._tweens.splice(k, 1); continue; }
        if (now < tw.t0) continue;
        var p = (now - tw.t0) / tw.ms;
        var done = p >= 1;
        if (done) p = 1;
        var e = tw.ease(p);
        for (var kk in tw.to) {
            tw.obj[kk] = tw.from[kk] + (tw.to[kk] - tw.from[kk]) * e;
        }
        if (done) {
            tw.dead = true;
            if (tw.onDone) tw.onDone();
        }
    }
};

// timeline de tweens NO MESMO obj: E.seq(obj, [passos], {onDone}) — cada
// passo {to, ms, ease, delay} roda depois do anterior; {par: [passos]}
// roda os filhos JUNTOS e espera o mais longo. Devolve {dead, done, step,
// cancel()} — cancel corta a cadeia no passo atual (o tween em voo morre
// junto). clearTweens da cena derruba a cadeia do mesmo jeito.
E.seq = function (obj, steps, opts) {
    opts = opts || {};
    var h = { dead: false, done: false, step: -1, _tw: null,
              cancel: function () {
                  h.dead = true;
                  if (h._tw) {
                      if (h._tw.length) {
                          for (var i = 0; i < h._tw.length; i++) E.cancel(h._tw[i]);
                      } else E.cancel(h._tw);
                  }
              } };
    function next() {
        if (h.dead) return;
        h.step++;
        if (h.step >= steps.length) {
            h.done = true;
            if (opts.onDone) opts.onDone();
            return;
        }
        var st = steps[h.step];
        if (st.par) {
            var pend = st.par.length;
            h._tw = [];
            for (var i = 0; i < st.par.length; i++) {
                h._tw.push(E.tween(obj, st.par[i].to, st.par[i].ms,
                                   { ease: st.par[i].ease, delay: st.par[i].delay,
                                     onDone: function () {
                                         if (--pend === 0) next();
                                     } }));
            }
            if (!pend) next();   // par vazio: passa direto
        } else {
            h._tw = E.tween(obj, st.to, st.ms,
                            { ease: st.ease, delay: st.delay, onDone: next });
        }
    }
    next();
    return h;
};

// ----------------------------------------------- grupos e pools ----------

// lista de entidades com update/draw em lote; dead = swap-pop
E.group = function () {
    var g = { items: [], count: 0 };
    g.add = function (o) { g.items.push(o); g.count = g.items.length; return o; };
    g.update = function (dt) {
        var a = g.items;
        for (var i = a.length - 1; i >= 0; i--) {
            var o = a[i];
            if (!o.dead && o.update) o.update(dt);
            if (o.dead) {
                a[i] = a[a.length - 1];
                a.pop();
            }
        }
        g.count = a.length;
    };
    g.draw = function () {
        var a = g.items;
        for (var i = 0; i < a.length; i++) {
            if (!a[i].dead && a[i].draw) a[i].draw();
        }
    };
    g.each = function (fn) {
        var a = g.items;
        for (var i = 0; i < a.length; i++) fn(a[i]);
    };
    g.clear = function () { g.items.length = 0; g.count = 0; };
    return g;
};

// pool pre-alocado: spawn() recicla objetos mortos (zero alloc por frame)
E.pool = function (n, factory) {
    var items = [];
    for (var i = 0; i < n; i++) {
        var o = factory(i);
        o.dead = true;
        items.push(o);
    }
    var p = {
        items: items, count: n, alive: 0,
        spawn: function () {
            for (var j = 0; j < items.length; j++) {
                if (items[j].dead) {
                    items[j].dead = false;
                    p.alive++;
                    return items[j];
                }
            }
            return null;
        },
        update: function (dt) {
            var n2 = 0;
            for (var j = 0; j < items.length; j++) {
                var o = items[j];
                if (o.dead) continue;
                if (o.update) o.update(dt);
                if (!o.dead) n2++;
            }
            p.alive = n2;
        },
        draw: function () {
            for (var j = 0; j < items.length; j++) {
                if (!items[j].dead && items[j].draw) items[j].draw();
            }
        },
        each: function (fn) {
            for (var j = 0; j < items.length; j++) {
                if (!items[j].dead) fn(items[j]);
            }
        },
        clear: function () {
            for (var j = 0; j < items.length; j++) items[j].dead = true;
            p.alive = 0;
        }
    };
    return p;
};

// ---------------------------------------------------------- camera -------

E.cam = {
    x: 0, y: 0,          // canto sup. esq. da camera no mundo
    ox: 0, oy: 0,        // offset do shake
    bounds: null,        // {x,y,w,h} do mundo
    _target: null,
    _lerp: 1,
    _shT: 0, _shDur: 0, _shPow: 0,

    follow: function (t, lerp) {
        this._target = t;
        this._lerp = lerp === undefined ? 1 : lerp;
    },
    shake: function (pow, dur) {
        this._shPow = pow;
        this._shDur = dur;
        this._shT = dur;
    },
    center: function (x, y) {
        this.x = x - E.W / 2;
        this.y = y - E.H / 2;
        this._clamp();
    },
    _clamp: function () {
        var b = this.bounds;
        if (!b) return;
        if (b.w <= E.W) this.x = (b.x + b.w / 2) - E.W / 2;
        else this.x = E.m.clamp(this.x, b.x, b.x + b.w - E.W);
        if (b.h <= E.H) this.y = (b.y + b.h / 2) - E.H / 2;
        else this.y = E.m.clamp(this.y, b.y, b.y + b.h - E.H);
    },
    _tick: function (dt) {
        if (this._target) {
            var k = E.m.clamp(this._lerp, 0, 1);
            this.x += (this._target.x - E.W / 2 - this.x) * k;
            this.y += (this._target.y - E.H / 2 - this.y) * k;
            this._clamp();
        }
        if (this._shT > 0) {
            this._shT -= dt;
            var p = this._shPow * (this._shT / this._shDur);
            this.ox = (Math.random() * 2 - 1) * p;
            this.oy = (Math.random() * 2 - 1) * p;
        } else {
            this.ox = 0;
            this.oy = 0;
        }
    },
    reset: function () {
        this.x = 0;
        this.y = 0;
        this.ox = 0;
        this.oy = 0;
        this._target = null;
        this._shT = 0;
    },
    wx: function (x) { return x - this.x + this.ox; },
    wy: function (y) { return y - this.y + this.oy; }
};

// ------------------------------------------------------------ gfx --------

// wrappers com camera: opts.screen = true desenha fora da camera (HUD).
// Com E.dirty ligado cada primitiva registra a caixa que pintou.
E.gfx = (function () {
    var D = E.dirty;
    function px(x, screen) { return Math.round(screen ? x : E.cam.wx(x)); }
    function py(y, screen) { return Math.round(screen ? y : E.cam.wy(y)); }

    // resolve {font, size} do texto: px (pixels), ts (papel em E.ts,
    // escalado por E.U) ou o par cru font/size de antes. Estilos vindos de
    // E.font sao COMPARTILHADOS (tabela memoizada): o cache de largura do
    // measure pende neles — sem chave string, sem alocar
    function textStyle(o) {
        var want = o.px !== undefined ? o.px :
                   (o.ts !== undefined ? (E.ts[o.ts] || 13) * E.U : -1);
        if (want > 0) return E.font(want);
        return { font: o.font || 2, size: o.size || 1, h: 0 };
    }
    // firmware ate a API 31 devolvia o textWidth no espaco virtual 240 mesmo
    // no canvas nativo (metade no 480): corrige pela escala do vidro
    var api = 0;
    try { api = S.getAPILevel(); } catch (e) { api = 0; }
    var _WCAP = 200;      // teto por estilo: textos dinamicos (score) nao crescem sem fim
    function measure(str, st) {
        var c = st._w;
        if (c) {
            var w = c[str];
            if (w !== undefined) return w;
        }
        var w2 = 0;
        try { w2 = S.textWidth(str, st.font) * st.size; } catch (e) { w2 = str.length * 8 * st.size; }
        if (E.caps.native && api > 0 && api < 32) w2 = Math.round(w2 * E.W / 240);
        if (c && st._wn < _WCAP) { c[str] = w2; st._wn++; }
        return w2;
    }

    // opts de rect em scratch (button/bar/panel redesenham a cada quadro;
    // g.rect so le) — mesmo papel do EMPTY para os literais internos
    var _ro = { r: 0, screen: false };
    var _roS = { r: 0, fill: false, screen: false };
    var _btnLo = { color: 0, align: 'center', valign: 'middle', screen: false,
                   fit: 0, font: undefined, px: 12 };

    var g = {
        // rect(x,y,w,h,cor,{fill=true, r (cantos), screen})
        rect: function (x, y, w, h, color, o) {
            o = o || EMPTY;
            var X = px(x, o.screen), Y = py(y, o.screen);
            var W2 = Math.round(w), H2 = Math.round(h);
            if (o.r && E.caps.round) {
                if (o.fill === false && typeof S.drawRoundRect === 'function') {
                    S.drawRoundRect(X, Y, W2, H2, Math.round(o.r), color);
                } else {
                    S.fillSmoothRoundRect(X, Y, W2, H2, Math.round(o.r), color);
                }
            } else if (o.fill === false) {
                S.drawRect(X, Y, W2, H2, color);
            } else {
                S.fillRect(X, Y, W2, H2, color);
            }
            if (D.on) D.add(X, Y, W2, H2);
        },
        // circle(x,y,r,cor,{fill=true, smooth, screen})
        circle: function (x, y, r, color, o) {
            o = o || EMPTY;
            var X = px(x, o.screen), Y = py(y, o.screen), R = Math.round(r);
            if (R < 1) R = 1;
            if (o.fill === false) S.drawCircle(X, Y, R, color);
            else if (o.smooth && E.caps.smooth) S.fillSmoothCircle(X, Y, R, color);
            else S.fillCircle(X, Y, R, color);
            if (D.on) D.add(X - R - 1, Y - R - 1, R * 2 + 3, R * 2 + 3);
        },
        // line(x0,y0,x1,y1,cor,{w (espessura), screen})
        line: function (x0, y0, x1, y1, color, o) {
            o = o || EMPTY;
            var ax = px(x0, o.screen), ay = py(y0, o.screen);
            var bx = px(x1, o.screen), by = py(y1, o.screen);
            var lw = o.w > 1 ? Math.round(o.w) : 1;
            if (lw > 1 && E.caps.wide) S.drawWideLine(ax, ay, bx, by, lw, color);
            else S.drawLine(ax, ay, bx, by, color);
            if (D.on) {
                D.add(Math.min(ax, bx) - lw, Math.min(ay, by) - lw,
                      Math.abs(bx - ax) + lw * 2 + 1, Math.abs(by - ay) + lw * 2 + 1);
            }
        },
        tri: function (x0, y0, x1, y1, x2, y2, color, o) {
            o = o || EMPTY;
            var ax = px(x0, o.screen), ay = py(y0, o.screen);
            var bx = px(x1, o.screen), by = py(y1, o.screen);
            var cx = px(x2, o.screen), cy = py(y2, o.screen);
            if (o.fill === false) S.drawTriangle(ax, ay, bx, by, cx, cy, color);
            else S.fillTriangle(ax, ay, bx, by, cx, cy, color);
            if (D.on) {
                var l = Math.min(ax, bx, cx), t = Math.min(ay, by, cy);
                D.add(l, t, Math.max(ax, bx, cx) - l + 1, Math.max(ay, by, cy) - t + 1);
            }
        },
        gradient: function (x, y, w, h, c1, c2, o) {
            if (!E.caps.gradient) {
                g.rect(x, y, w, h, c1, o);
                return;
            }
            o = o || EMPTY;
            var X = px(x, o.screen), Y = py(y, o.screen);
            S.fillGradient(X, Y, Math.round(w), Math.round(h), c1, c2, o.dir === 'x' ? 1 : 0);
            if (D.on) D.add(X, Y, w, h);
        },
        arc: function (x, y, r0, r1, a0, a1, color, o) {
            if (!E.caps.arc) {
                g.circle(x, y, r1, color, o);
                return;
            }
            o = o || EMPTY;
            var X = px(x, o.screen), Y = py(y, o.screen), R = Math.round(r1);
            S.fillArc(X, Y, Math.round(r0), R, Math.round(a0), Math.round(a1), color);
            if (D.on) D.add(X - R - 1, Y - R - 1, R * 2 + 3, R * 2 + 3);
        },
        // texto: opts {color, bg, px (altura em pixels) | ts (papel: tiny,
        // small, body, label, big, title, huge — escala com E.U) | size+font
        // (cru, como antes), fit (largura maxima: encolhe ate caber), align
        // left|center|right, valign top|middle|bottom, screen}
        text: function (str, x, y, o) {
            o = o || EMPTY;
            str = String(str);
            var st = textStyle(o);
            if (o.fit > 0 && st.h > 0) {
                var guard = 0;
                while (measure(str, st) > o.fit && guard++ < 12) {
                    var smaller = E.font((st.h - 1) / 1.08);   // estritamente menor
                    if (smaller.h >= st.h) break;
                    st = smaller;
                }
            }
            var X = px(x, o.screen), Y = py(y, o.screen);
            // bg ausente = chamada de 1 arg = fundo transparente (firmware)
            if (o.bg === undefined) {
                S.setTextColor(o.color === undefined ? 0xFFFF : o.color);
            } else {
                S.setTextColor(o.color === undefined ? 0xFFFF : o.color, o.bg);
            }
            // datum no LAYOUT DO LOVYANGFX (nao TFT_eSPI): linha vale 4 —
            // 4=middle-left, 5=middle-center, 8=bottom-left (9=BC, 10=BR).
            // Datum 0 e o default do firmware: o estado so e tocado quando
            // o texto pede outra origem (app que mexeu no System.setTextDatum
            // direto deve devolve-lo a 0, como os apps do repo fazem)
            var col = o.align === 'center' ? 1 : (o.align === 'right' ? 2 : 0);
            var row = o.valign === 'middle' ? 4 : (o.valign === 'bottom' ? 8 : 0);
            var datum = row + col;
            if (datum) S.setTextDatum(datum);
            if (st.size !== 1) S.setTextSize(st.size);
            S.drawString(str, X, Y, st.font);
            if (st.size !== 1) S.setTextSize(1);
            if (datum) S.setTextDatum(0);
            if (D.on) {
                var tw = measure(str, st);
                var th = st.h || (S.fontHeight(st.font) * st.size);
                var lx = col === 1 ? X - tw / 2 : (col === 2 ? X - tw : X);
                var ly = row === 4 ? Y - th / 2 : (row === 8 ? Y - th : Y);
                D.add(lx - 1, ly - 1, tw + 3, th + 3);
            }
        },
        // largura em pixels do texto com as mesmas opts do text()
        measure: function (str, o) { return measure(String(str), textStyle(o || EMPTY)); },
        // botao immediate-mode: desenha e devolve o rect p/ E.hit(). O
        // rotulo escala com a altura do botao (px = 50% de h, encolhe ate
        // caber na largura). Registra o rect: cena static repinta sozinha
        // quando o dedo entra/sai dele (feedback de press sem draw/quadro)
        button: function (label, x, y, w, h, o) {
            o = o || EMPTY;
            var T = E.theme || EMPTY;
            var r = { x: x, y: y, w: w, h: h };
            var accent = o.color || T.accent || 0x07FF;
            var on = E.press(r);
            var primary = o.primary !== false;
            var fill = primary ?
                (on ? accent : (E.caps.wide ? S.mixColor(accent, 0x0000, 25) : accent)) :
                (on ? (E.caps.wide ? S.mixColor(o.bg !== undefined ? o.bg : (T.card || 0x1082), 0xFFFF, 18) : accent)
                    : (o.bg !== undefined ? o.bg : (T.card || 0x1082)));
            var rad = o.r === undefined ? Math.round(Math.min(h * 0.28, 12 * E.U)) : o.r;
            _ro.r = rad; _ro.screen = o.screen;
            g.rect(x, y, w, h, fill, _ro);
            if (!primary && o.stroke !== false) {
                _roS.r = rad; _roS.screen = o.screen;
                g.rect(x, y, w, h, o.stroke || accent, _roS);
            }
            // scratch dos labels (g.text so le): label de botao a cada quadro
            // nao aloca
            var lo = _btnLo;
            lo.color = o.textColor !== undefined ? o.textColor :
                       (primary ? (T.onAccent || 0x0000) : (T.text || 0xFFFF));
            lo.align = 'center'; lo.valign = 'middle'; lo.screen = o.screen;
            lo.fit = w - Math.round(12 * E.U);
            if (o.font) { lo.font = o.font; lo.px = undefined; }
            else { lo.px = o.px || Math.round(h * 0.5); lo.font = undefined; }
            g.text(label, x + w / 2, y + h / 2, lo);
            E._btns.push(r);
            return r;
        },
        // medidor de fracao: opts {fg, bg, r, screen}
        bar: function (x, y, w, h, frac, o) {
            o = o || EMPTY;
            var T = E.theme || EMPTY;
            var f = E.m.clamp(frac, 0, 1);
            _ro.r = o.r; _ro.screen = o.screen;
            g.rect(x, y, w, h, o.bg || (T.stroke || 0x3186), _ro);
            if (f > 0.01) {
                g.rect(x + 1, y + 1, Math.max(1, (w - 2) * f), h - 2,
                       o.fg || (T.accent || 0x07FF), _ro);
            }
        },
        // painel/card com borda
        panel: function (x, y, w, h, o) {
            o = o || EMPTY;
            var T = E.theme || EMPTY;
            var rad = o.r === undefined ? Math.round(10 * E.U) : o.r;
            _ro.r = rad; _ro.screen = o.screen;
            g.rect(x, y, w, h, o.bg || (T.card || 0x1082), _ro);
            _roS.r = rad; _roS.screen = o.screen;
            g.rect(x, y, w, h, o.stroke || (T.stroke || 0x3186), _roS);
        }
    };
    return g;
})();

// ----------------------------------------------------------- audio -------

E.audio = {
    muted: false,
    sfxOverMusic: false,   // true: toca sfx mesmo com musica (rouba o canal)
    sfxTable: {
        ui: [880, 40],
        ok: [[660, 60], [880, 70]],
        back: [330, 60],
        bad: [160, 120],
        hit: [220, 50],
        coin: [[988, 50], [1319, 80]],
        boom: [[120, 80], [70, 160]],
        shot: [[1400, 18], [1000, 22]],
        power: [[784, 40], [988, 40], [1319, 90]],
        over: [[300, 90], [220, 90], [140, 220]],
        record: [[659, 70], [784, 70], [988, 70], [1319, 200]],
        win: [[523, 90], [659, 90], [784, 160]]
    },
    _song: null,
    _bpm: 120,
    _duckSong: null,       // trilha guardada durante um duck
    _duckFrom: 0,          // ms de retomada (ponto onde parou)
    _duckUntil: 0,
    _retryAt: 0,           // teto de retry do restart: playMusic falhando nao martela por quadro

    // song = {bpm, loops, tracks:[...]} (API 25); opts {startMs} retoma
    music: function (song, opts) {
        if (!E.caps.music || E.audio.muted || !song) return false;
        E.audio._song = song;
        E.audio._bpm = song.bpm || 120;
        try {
            return !!S.playMusic(song, opts && opts.startMs !== undefined ?
                                 { startMs: opts.startMs } : undefined);
        } catch (e) {
            return false;
        }
    },
    stop: function () {
        E.audio._song = null;
        E.audio._duckSong = null;   // stop explicito vence um duck em curso
        if (typeof S.musicStop === 'function') {
            try { S.musicStop(); } catch (e) {}
        }
    },
    playing: function () {
        if (!E.audio._song || typeof S.musicPlaying !== 'function') return false;
        try { return !!S.musicPlaying(); } catch (e) { return false; }
    },
    // fracao de batida (x.0 = tempo); -1 sem musica
    beat: function () {
        if (!E.audio._song || typeof S.musicPos !== 'function') return -1;
        var pos;
        try { pos = S.musicPos(); } catch (e) { return -1; }
        if (pos < 0) return -1;
        return pos / (60000 / E.audio._bpm);
    },
    // o que: nome da tabela, [f, ms] ou melodia [[f,ms],...]. Firmware
    // com API 32: misturado por cima da trilha, NAO bloqueia. Antes disso
    // cai no playTone (bloqueante, e calado com musica tocando)
    sfx: function (what) {
        if (E.audio.muted || !E.caps.speaker) return;
        var mel = typeof what === 'string' ? E.audio.sfxTable[what] : what;
        if (!mel) return;
        if (typeof mel[0] === 'number') mel = [mel];
        if (E.caps.mix) {
            try { S.sfx(mel); } catch (e) {}
            return;
        }
        if (E.audio.playing() && !E.audio.sfxOverMusic) return;
        try { S.playTone(mel); } catch (e) {}
    },
    // abafa a trilha por ms (um sfx alto, ex. explosao, rouba o canal):
    // para a musica e o _tick retoma do ponto onde parou quando a janela
    // fecha — sfx toca normal na janela (playing() esta falso). Com mistura
    // (API 32) o efeito ja soa por cima: no-op, a trilha segue
    duck: function (ms) {
        var song = E.audio._song;
        if (!song || E.audio.muted || E.caps.mix) return false;
        var pos = -1;
        if (typeof S.musicPos === 'function') {
            try { pos = S.musicPos(); } catch (e) {}
        }
        // para sem passar pelo stop() (que cancelaria o proprio duck)
        E.audio._song = null;
        if (typeof S.musicStop === 'function') {
            try { S.musicStop(); } catch (e) {}
        }
        E.audio._duckSong = song;
        E.audio._duckFrom = pos > 0 ? pos : 0;
        E.audio._duckUntil = S.millis() + ms;
        return true;
    },
    mute: function (on) {
        E.audio.muted = !!on;
        if (E.audio.muted) E.audio.stop();
    },
    volume: function (v) {
        if (typeof S.setVolume === 'function') {
            try { S.setVolume(E.m.clamp(Math.round(v), 0, 100)); } catch (e) {}
        }
    },
    _tick: function () {
        // janela do duck aberta: musica parada, nada a fazer
        if (E.audio._duckSong) {
            if (S.millis() < E.audio._duckUntil) return;
            var song = E.audio._duckSong;
            E.audio._duckSong = null;
            // outra musica comecou durante a janela? ela fica
            if (!E.audio._song) E.audio.music(song, { startMs: E.audio._duckFrom });
            return;
        }
        // reinicia a trilha quando os loops acabam (falha de playMusic so
        // tenta de novo a cada 2 s — sem isso um falha persistente martelava
        // o canal a cada quadro)
        if (E.audio._song && !E.audio.playing()) {
            if (S.millis() >= E.audio._retryAt) {
                var ok = false;
                try { ok = S.playMusic(E.audio._song); } catch (e) {}
                E.audio._retryAt = ok ? 0 : S.millis() + 2000;
            }
        }
    }
};

// ------------------------------------------------------------ save -------

E.save = {
    prefix: '',
    get: function (key, def) {
        try {
            var v = Storage.get(E.save.prefix + key, null);
            if (v === null || v === undefined || v === '') return def;
            return v;
        } catch (e) { return def; }
    },
    set: function (key, val) {
        try { Storage.set(E.save.prefix + key, String(val)); } catch (e) {}
    },
    num: function (key, def) {
        var v = parseFloat(E.save.get(key, def));
        return isNaN(v) ? def : v;
    },
    // true se virou novo recorde
    best: function (key, score) {
        var cur = E.save.num(key, 0);
        if (score > cur) {
            E.save.set(key, score);
            return true;
        }
        return false;
    }
};

module.exports = E;
