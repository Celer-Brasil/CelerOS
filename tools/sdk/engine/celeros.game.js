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
// 1.0.1: fim da transicao repinta o fundo inteiro (restos do veu fora da
// camada suja — os "blocos pretos").
// 1.0.2: goto SEM veu no meio de um fadeout descarta o veu (antes ficava
// pendurado pintando a tela inteira para sempre) e o fim do veu com
// RECORTE ativo (dirty.clip) tambem repinta a faixa de fora do recorte
// (o veu cobre a tela toda; o _full so cobre o clip).
// 1.1.0 (registro E._modDraws: overlays de modulo apos o draw da cena).
// 1.1.0: E.m.wrap no multiplo exato abaixo do intervalo devolvia b (fora
// de [a, b)); randInt(n) de 1 arg dava NaN; tween de prop ausente no obj
// dava NaN e o tween com delay lia o "de" na criacao (agora no inicio).
// Novos: E.pause/E.paused, E.timeScale, every(ms, fn, vezes), tween com
// yoyo/repeat/onUpdate, easings cubic/elastic/bounce, smoothstep/angDiff/
// chance/shuffle, rng com .int/.range/.pick, cam.deadzone + worldX/worldY,
// pool com cursor, group.sort/remove, save.obj/setObj/del, hit/press com
// folga, input.doubleTap, goto valida a cena na hora, E.debug (overlay).

// 1.2.0: pilha de cenas (E.push/E.pop com pause/resume e a camada suja
// da cena de baixo restaurada), cena {cleanup: true} mata os timers/
// tweens que criou ao sair, E.killTweensOf, E.m.lerpAngle/snap/noise,
// input.heldMs, group.find/countIf, pool.spawn(init), cam.inView +
// follow {offset}, gfx.poly/wrap/textBox + text {shadow}, sfx com
// intervalo minimo por som (audio.gap) e save.inc.
// 1.3.0: timers/tweens do MESMO quadro disparam na ordem de criacao (o laco
// de tras para frente invertia: after(100, a); after(100, b) tocava b
// antes); tween sem ms virava NaN e nunca terminava; every(0) era tiro
// unico; E.m.map com a === b dava NaN; button/bar/panel ignoravam a cor
// preta (0x0000 caia no `||`); textBox com max estourava a largura no
// "..."; tick de modulo com fn.always roda tambem na pausa (o botao do
// pad que despausa nao congelava). Novos: goto/push/pop {arg} chegam no
// enter/resume, E.prevScene, E.timeLeft, tween relativo ("+=20"), seq com
// {wait}/{call}, E.m.weighted/lerpColor/fmt/clock/moveToward,
// group.closest, pool.find, cam.panTo, gfx.hearts, save.bool/toggle e o
// overlay do debug com a cena e a pilha.
// 1.4.0: E.freeze(ms) (hitstop: o golpe que acerta congela o jogo uns
// quadros — dt 0 no update, nos modulos e no fx), E.save.slot(n) (arquivos
// de jogo 1..3 sob o mesmo prefixo), multitoque: E.input.touches (dedos
// por id com down/justDown/justUp/heldMs/moved, via System.getTouches da
// API 43; 1 dedo sintetico em firmware antigo) e E.input.finger(id) — o
// primario segue alimentando x/y/tap/swipe como sempre; quando ele levanta
// com outro dedo na tela, o primario vira soltura + toque novo (sem pulo
// de posicao que viraria swipe falso).
// 1.4.1: restart da trilha com backoff quando o canal I2S nao abre.
// 1.4.2: gfx.hearts pinta o coracao cheio 1x (eram 6 primitivas); camera
// com lerp corrigido pelo dt (a 20 fps seguia 1/3 mais devagar); save.set/
// setObj devolvem false e avisam no log (E._warn) quando a NVS recusa chave
// > 15 chars ou valor > 4 KB — antes o save sumia calado; texto com o par
// cru font/size usa estilo memoizado (cache de largura, sem objeto novo);
// o tap mede o toque ate o ULTIMO quadro com o dedo (um quadro pesado entre
// o press e a leitura da soltura nao engole mais o toque) e o duplo-toque
// conta do fim do 1o ao inicio do 2o.
// 1.4.3: System.button (mais um present por quadro) so e lido nas placas sem
// vidro, as unicas que entregam o botao ao app.

var E = { version: '1.4.3' };
var S = System;

// opts compartilhado (so leitura): os wrappers gfx sem opts nao alocam —
// objeto novo por primitiva era pressao de GC no Duktape a cada quadro
var EMPTY = {};

// registro dos modulos da familia: cada celeros.game.* decora este E no
// require e pendura function(dt, now) aqui — o loop chama antes do
// update da cena (o fx morava colado no corpo do E.run)
E._modTicks = [];
// overlays dos modulos (toast do ui): function() chamada DEPOIS do draw da
// cena, ainda dentro da camada suja — fica por cima e apaga sozinho
E._modDraws = [];
E._mods = [];       // nomes carregados (["fx", "spr", ...]) — diagnostico
// aviso de diagnostico no log do aparelho (logcat), 1x por mensagem
var _warned = {};
E._warn = function (msg) {
    if (_warned[msg]) return;
    _warned[msg] = true;
    try { S.print('[celergame] ' + msg); } catch (e) {}
};
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
        // botao fisico do app (System.button, API 17) so existe nas placas
        // SEM vidro (devkit: buttonToApp); nas outras cada leitura era mais um
        // present por quadro (~1,8 ms no 4848) devolvendo sempre 0
        button: typeof S.button === 'function' && !!(info && info.hasDisplay === false),
        // API 43: varios dedos (System.getTouches) — 4848 e relogio; a CYD
        // (resistivo) entrega 1 ponto pelo mesmo caminho
        multi: typeof S.getTouches === 'function',
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
    // o pool de sprites pode mudar com o canvas (caps foi lido no require)
    if (typeof S.spriteSlots === 'function') E.caps.slots = S.spriteSlots();
    E.W = E.caps.w = S.screenWidth();
    E.H = E.caps.h = S.screenHeight();
    E.U = Math.min(E.W, E.H) / 240;
    E._fonts = null;    // tabela de fontes medida sob demanda (E.font)
    E._fontMemo = null; // idem: px -> entrada da tabela (busca e O(1))
    try { E.theme = S.theme(); } catch (e) { E.theme = null; }
    if (opts.keepAwake !== false && typeof S.keepAwake === 'function') {
        S.keepAwake(true);
    }
    E.save.prefix = E.save._base = opts.save || '';
    E.save._slot = 0;
    if (opts.debug !== undefined) E.debug = !!opts.debug;
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
    // intervalo de origem vazio (a === b) devolve c, nao NaN/Infinity
    map: function (v, a, b, c, d) { return b === a ? c : c + (v - a) * (d - c) / (b - a); },
    rand: function (a, b) {
        if (a === undefined) { a = 0; b = 1; }
        else if (b === undefined) { b = a; a = 0; }
        return a + Math.random() * (b - a);
    },
    // randInt(n) = 0..n; randInt(a, b) = a..b (inclusivos)
    randInt: function (a, b) {
        if (b === undefined) { b = a; a = 0; }
        return Math.floor(E.m.rand(a, b + 1));
    },
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
    // v dentro de [a, b): o multiplo exato abaixo do intervalo cai em a
    // (antes devolvia b — wrap(-10, 0, 10) era 10, fora do intervalo)
    wrap: function (v, a, b) {
        if (v < a) {
            var r = (a - v) % (b - a);
            return r === 0 ? a : b - r;
        }
        if (v >= b) return a + (v - a) % (b - a);
        return v;
    },
    // diferenca angular mais curta de a para b, em (-PI, PI] (mira/rotacao
    // que nao da a volta comprida)
    angDiff: function (a, b) {
        var d = (b - a) % (Math.PI * 2);
        if (d > Math.PI) d -= Math.PI * 2;
        else if (d <= -Math.PI) d += Math.PI * 2;
        return d;
    },
    // interpola angulos pelo caminho curto (torre girando ate a mira)
    lerpAngle: function (a, b, t) { return a + E.m.angDiff(a, b) * t; },
    // arredonda ao multiplo de step (grade de 16 px, angulo de 45 graus)
    snap: function (v, step) { return Math.round(v / step) * step; },
    // ruido de valor suave 0..1 em 1D/2D (terreno, nuvem, tremor organico):
    // mesma entrada = mesma saida; seed muda o mundo
    noise: function (x, y, seed) {
        if (y === undefined) y = 0;
        var s = (seed || 0) | 0;
        var xi = Math.floor(x), yi = Math.floor(y);
        var xf = x - xi, yf = y - yi;
        var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
        var a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s);
        var c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
        return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    },
    // 0 abaixo de e0, 1 acima de e1, curva S no meio
    smoothstep: function (e0, e1, v) {
        var t = E.m.clamp((v - e0) / (e1 - e0), 0, 1);
        return t * t * (3 - 2 * t);
    },
    // true com probabilidade p (0..1); rnd opcional (E.rng) p/ determinismo
    chance: function (p, rnd) { return (rnd ? rnd() : Math.random()) < p; },
    // embaralha NO LUGAR (Fisher-Yates) e devolve o mesmo array
    shuffle: function (arr, rnd) {
        for (var i = arr.length - 1; i > 0; i--) {
            var j = Math.floor((rnd ? rnd() : Math.random()) * (i + 1));
            var t = arr[i];
            arr[i] = arr[j];
            arr[j] = t;
        }
        return arr;
    },
    // sorteio com peso (tabela de loot): [[item, peso], ...] ou {item: peso}
    // — devolve o item; rnd opcional (E.rng) p/ determinismo
    weighted: function (table, rnd) {
        var tot = 0, k, i, isArr = table && table.length !== undefined;
        if (isArr) { for (i = 0; i < table.length; i++) tot += table[i][1] > 0 ? table[i][1] : 0; }
        else for (k in table) tot += table[k] > 0 ? table[k] : 0;
        if (!(tot > 0)) return undefined;
        var x = (rnd ? rnd() : Math.random()) * tot;
        if (isArr) {
            for (i = 0; i < table.length; i++) {
                var w = table[i][1] > 0 ? table[i][1] : 0;
                if (x < w) return table[i][0];
                x -= w;
            }
            return table[table.length - 1][0];
        }
        var last;
        for (k in table) {
            var w2 = table[k] > 0 ? table[k] : 0;
            if (w2 > 0) last = k;
            if (x < w2) return k;
            x -= w2;
        }
        return last;
    },
    // mistura de cores RGB565 por canal (t 0..1) — roda sem o mixColor do
    // firmware (harness/emu) e da a mesma cor em toda placa
    lerpColor: function (c1, c2, t) {
        if (t <= 0) return c1;
        if (t >= 1) return c2;
        var r1 = c1 >> 11, g1 = (c1 >> 5) & 63, b1 = c1 & 31;
        var r = Math.round(r1 + ((c2 >> 11) - r1) * t);
        var g = Math.round(g1 + (((c2 >> 5) & 63) - g1) * t);
        var b = Math.round(b1 + ((c2 & 31) - b1) * t);
        return (r << 11) | (g << 5) | b;
    },
    // 12345 -> "12.345" (placar legivel); sep opcional (default ".")
    fmt: function (n, sep) {
        var s = String(Math.floor(Math.abs(n))), out = '';
        var sp = sep === undefined ? '.' : sep;
        while (s.length > 3) { out = sp + s.slice(-3) + out; s = s.slice(0, -3); }
        return (n < 0 ? '-' : '') + s + out;
    },
    // ms -> "m:ss" (ou "h:mm:ss" a partir de 1 h) — cronometro de fase
    clock: function (ms) {
        var t = Math.max(0, Math.floor(ms / 1000));
        var h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
        var ss = s < 10 ? '0' + s : '' + s;
        if (h > 0) return h + ':' + (m < 10 ? '0' + m : m) + ':' + ss;
        return m + ':' + ss;
    },
    // anda obj ({x, y}) ate (x, y) no maximo step px; true ao chegar
    moveToward: function (obj, x, y, step) {
        var dx = x - obj.x, dy = y - obj.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d <= step || d === 0) { obj.x = x; obj.y = y; return true; }
        obj.x += dx / d * step;
        obj.y += dy / d * step;
        return false;
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
    },
    inCubic: function (t) { return t * t * t; },
    outCubic: function (t) { t = t - 1; return t * t * t + 1; },
    inOutCubic: function (t) {
        return t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1;
    },
    // mola que passa do alvo e assenta (pop de UI)
    outElastic: function (t) {
        if (t <= 0 || t >= 1) return t <= 0 ? 0 : 1;
        return Math.pow(2, -10 * t) * Math.sin((t - 0.075) * (2 * Math.PI) / 0.3) + 1;
    },
    // quica no chao 3 vezes (queda de peca, moeda)
    outBounce: function (t) {
        var n = 7.5625, d = 2.75;
        if (t < 1 / d) return n * t * t;
        if (t < 2 / d) { t -= 1.5 / d; return n * t * t + 0.75; }
        if (t < 2.5 / d) { t -= 2.25 / d; return n * t * t + 0.9375; }
        t -= 2.625 / d;
        return n * t * t + 0.984375;
    }
};

// hash inteiro -> 0..1 (base do E.m.noise; Math.imul nao existe no ES5)
function hash2(x, y, s) {
    var h = (x * 374761393 + y * 668265263 + s * 1442695041) % 2147483647;
    h = (h ^ (h >>> 13)) * 1274126177 % 2147483647;
    h = h ^ (h >>> 16);
    return ((h >>> 0) % 100000) / 100000;
}

// PRNG deterministico (xorshift32) — testes e mundo procedural. A funcao
// devolvida carrega .range(a, b), .int(a, b) (inclusivo) e .pick(arr) —
// a mesma semente da a mesma fase inteira sem passar o rnd a mao
E.rng = function (seed) {
    var a = (seed >>> 0) || 0x9E3779B9;
    var r = function () {
        a ^= a << 13;
        a >>>= 0;
        a ^= a >>> 17;
        a ^= a << 5;
        a >>>= 0;
        return a / 4294967296;
    };
    r.range = function (x, y) { return x + r() * (y - x); };
    r.int = function (x, y) {
        if (y === undefined) { y = x; x = 0; }
        return x + Math.floor(r() * (y - x + 1));
    };
    r.pick = function (arr) { return arr[Math.floor(r() * arr.length)]; };
    return r;
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
    doubleTap: null,       // {x, y} — 2o tap seco perto do 1o (< dblMs)
    swipe: null,           // {dir, dx, dy, dist}
    longpress: false,      // >= longMs sem arrastar (1 tiro por toque)
    btn: 0,                // botao fisico (devkit): 1 curto, 2 longo
    dragThresh: 12,
    tapMs: 350,
    swipeMin: 30,
    longMs: 600,
    dblMs: 300,
    heldMs: 0,             // ms com o dedo pousado (0 solto) — carga de tiro
    // dedos (core 1.4): [{id, x, y, sx, sy, dx, dy, t0, heldMs, down,
    // justDown, justUp, moved, primary}] — o dedo que levantou fica 1 quadro
    // com down false / justUp true
    touches: [],
    finger: function (id) {
        var L = E.input.touches;
        for (var k = 0; k < L.length; k++) if (L[k].id === id) return L[k];
        return null;
    },
    _raw: { down: false, sx: 0, sy: 0, t0: 0, t1: 0, moved: false, longDone: false,
            lastTapT: -1e9, lastTapX: 0, lastTapY: 0, pid: -1, swap: false }
};

// dedos por id: objetos reaproveitados (cada dedo vive do toque ao quadro
// seguinte ao que levantou — justUp fica visivel 1 quadro)
var _pt = { touched: false, x: 0, y: 0 };
var _pt1 = { id: 0, x: 0, y: 0 };
var _one = [];
E._fingers = function (arr, now) {
    var L = E.input.touches, k, f, j;
    // quem levantou no quadro passado sai agora
    for (k = L.length - 1; k >= 0; k--) if (!L[k].down) L.splice(k, 1);
    for (k = 0; k < L.length; k++) { L[k].justDown = false; L[k]._seen = false; }
    for (j = 0; j < arr.length; j++) {
        var p = arr[j];
        f = null;
        for (k = 0; k < L.length; k++) if (L[k].id === p.id) { f = L[k]; break; }
        if (!f) {
            f = { id: p.id, x: p.x, y: p.y, sx: p.x, sy: p.y, dx: 0, dy: 0, t0: now,
                  heldMs: 0, down: true, justDown: true, justUp: false, moved: false,
                  primary: false, _seen: false };
            L.push(f);
        } else {
            f.dx = p.x - f.x;
            f.dy = p.y - f.y;
            f.x = p.x;
            f.y = p.y;
            f.heldMs = now - f.t0;
        }
        f.justUp = false;
        f._seen = true;
        f.primary = j === 0;
        if (!f.moved && (Math.abs(f.x - f.sx) > E.input.dragThresh ||
                         Math.abs(f.y - f.sy) > E.input.dragThresh)) f.moved = true;
    }
    for (k = 0; k < L.length; k++) {
        f = L[k];
        if (!f._seen && f.down) { f.down = false; f.justUp = true; f.dx = 0; f.dy = 0; f.primary = false; }
    }
};

E._pollInput = function (now) {
    var i = E.input, r = i._raw;
    i.justDown = false;
    i.justUp = false;
    i.dx = 0;
    i.dy = 0;
    i.tap = null;
    i.doubleTap = null;
    i.swipe = null;
    i.longpress = false;
    var t;
    if (E.caps.multi) {
        // UMA leitura por quadro (getTouch e getTouches cedem o quadro)
        var arr = S.getTouches();
        E._fingers(arr, now);
        _pt.touched = arr.length > 0;
        if (_pt.touched) { _pt.x = arr[0].x; _pt.y = arr[0].y; }
        // primario trocou de dedo sem soltar o vidro: solta este quadro e
        // o novo primario entra como toque fresco no proximo
        if (_pt.touched && r.down && r.pid !== arr[0].id) {
            _pt.touched = false;
            r.swap = true;
        } else if (_pt.touched) r.pid = arr[0].id;
        t = _pt;
    } else {
        t = S.getTouch();
        _one.length = 0;
        if (t.touched) { _pt1.x = t.x; _pt1.y = t.y; _one.push(_pt1); }
        E._fingers(_one, now);
    }
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
        r.t1 = now;          // ultimo quadro com o dedo no vidro
        i.heldMs = now - r.t0;
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
        i.heldMs = 0;
        i.justUp = true;
        // duracao do toque = press ate o ULTIMO quadro com o dedo no vidro
        // (r.t1), nao ate o quadro que leu a soltura: um quadro pesado no
        // meio (o press redesenha a tela, decodifica PNG) empurrava o
        // release para depois da janela e o tap sumia — o botao so piscava
        if (!r.moved && r.t1 - r.t0 < i.tapMs) {
            i.tap = { x: r.sx, y: r.sy };
            // duplo: 2o tap seco a < dblMs e < 2x o limiar do 1o (o 3o tap
            // recomeca a contagem — triplo nao vira dois duplos)
            if (r.t0 - r.lastTapT < i.dblMs &&
                Math.abs(r.sx - r.lastTapX) <= i.dragThresh * 2 &&
                Math.abs(r.sy - r.lastTapY) <= i.dragThresh * 2) {
                i.doubleTap = i.tap;
                r.lastTapT = -1e9;
            } else {
                r.lastTapT = r.t1;
                r.lastTapX = r.sx;
                r.lastTapY = r.sy;
            }
        } else if (r.moved) {
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

// toque seco dentro do rect {x,y,w,h}; pad = folga em px em volta (alvo
// pequeno — moeda, peca de 12 px — fica tocavel sem crescer no desenho)
E.hit = function (b, pad) {
    var t = E.input.tap;
    var p = pad || 0;
    return !!t && t.x >= b.x - p && t.x <= b.x + b.w + p &&
           t.y >= b.y - p && t.y <= b.y + b.h + p;
};

// dedo pressionado dentro do rect (feedback de botao apertado); pad idem
E.press = function (b, pad) {
    var i = E.input;
    var p = pad || 0;
    return i.down && i.x >= b.x - p && i.x <= b.x + b.w + p &&
           i.y >= b.y - p && i.y <= b.y + b.h + p;
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

// cena inexistente falha AQUI (com a lista das que existem), nao no
// quadro seguinte dentro do loop — o stack trace aponta quem chamou
E.goto = function (name, opts) {
    if (E._scenes && !E._scenes[name]) {
        var nomes = [];
        for (var k in E._scenes) nomes.push(k);
        throw new Error('cena inexistente: ' + name + ' (cenas: ' + nomes.join(', ') + ')');
    }
    E._next = name;
    E._nextKind = 'goto';
    E._nextArg = opts ? opts.arg : undefined;
    E._transReq = transOf(opts);
};
// opts so com {arg} nao e pedido de veu (qualquer outra chave e, como
// antes: {ms} sozinho abre o iris)
function transOf(o) {
    if (!o) return null;
    for (var k in o) if (k !== 'arg') return o;
    return null;
}
// cena anterior (nome) — o "voltar" de um menu de opcoes aberto de dois
// lugares
E.prevScene = '';
E._nextArg = undefined;

// PILHA de cenas: push abre a cena por cima SEM sair da atual (que recebe
// pause() e fica parada — nem update nem draw; o quadro dela segue no
// vidro), pop volta a ela (resume(), camada suja restaurada e repaint
// integral). Inventario, mapa, dialogo de loja sobre o jogo. goto com a
// pilha cheia sai de TODAS. Timers/tweens da cena de baixo seguem andando:
// para congelar o jogo tambem, combine com E.pause()
E._stack = [];
E._nextKind = null;
E.push = function (name, opts) {
    E.goto(name, opts);
    E._nextKind = 'push';
};
E.pop = function (opts) {
    if (!E._stack.length) return false;
    E._next = E._stack[E._stack.length - 1].name;
    E._nextKind = 'pop';
    E._nextArg = opts ? opts.arg : undefined;
    E._transReq = transOf(opts);
    return true;
};
// profundidade da pilha (0 = cena base)
E.depth = function () { return E._stack.length; };

// geracao da cena corrente: cresce a cada entrada — timers/tweens/ouvintes
// marcam onde nasceram (cleanup e eventos {scene: true})
E._sceneGen = 0;
E._genSeq = 0;          // contador monotono (o pop devolve a geracao de baixo)

// pausa do JOGO: com E.paused o update da cena recebe dt = 0 (e E.dt = 0),
// fx/camera/timers/tweens congelam e o draw segue (o veu de pausa desenha
// por cima — E.ui.pause). Timers e tweens contam no relogio do sistema: no
// resume a engine empurra os prazos pelo tempo parado
E.paused = false;
E._pauseAt = 0;
E.pause = function (on) {
    on = on === undefined ? !E.paused : !!on;
    if (on === E.paused) return E.paused;
    var now = S.millis();
    if (on) E._pauseAt = now;
    else {
        var gap = now - E._pauseAt, k;
        for (k = 0; k < E._timers.length; k++) E._timers[k].at += gap;
        for (k = 0; k < E._tweens.length; k++) E._tweens[k].t0 += gap;
    }
    E.paused = on;
    E._redraw = true;
    return on;
};

// hitstop: congela o jogo por ms (dt 0 no update, nos modulos e no fx; o
// veu, os timers e os tweens seguem o relogio). Pedidos sobrepostos ficam
// com o prazo mais longo
E._frozenUntil = 0;
E.freeze = function (ms) {
    var ate = S.millis() + (ms > 0 ? ms : 0);
    if (ate > E._frozenUntil) E._frozenUntil = ate;
};
E.frozen = function () { return S.millis() < E._frozenUntil; };

// camera lenta/rapida: escala o dt do update, do fx e da camera (0.3 =
// camera lenta no golpe final). Timers e tweens seguem o relogio
E.timeScale = 1;

// overlay de diagnostico (E.debug = true ou init {debug}): fps, ms do
// quadro e caixas da camada suja no canto superior esquerdo
E.debug = false;
E.frameMs = 0;          // ms gastos no ultimo quadro (update + draw)
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
// publico (1.1.0): true enquanto um veu de E.goto esta ativo — cenas static
// usam para nao pintar a tela inteira a cada quadro da transicao
E.transitioning = false;
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

// fim/descarte de veu: pinta o fundo nas faixas DE FORA do recorte da
// camada suja (o veu cobre a tela INTEIRA, mas o repaint integral do
// _begin cobre so o clip — o HUD la fora ficaria com restos do veu) e
// pede o repaint integral + redraw da cena static. O conteudo da faixa
// (o HUD em si) e do jogo: o memo dele repinta consultando
// E.dirty.touches(caixa do HUD), que esta true no quadro do _full
function veilClean() {
    E.dirty._full = true;
    E._redraw = true;
    var dc = E.dirty.on ? E.dirty._clip : null;
    if (!dc) return;
    if (dc.y > 0) E.dirty._fill(0, 0, E.W, dc.y);
    var db = dc.y + dc.h;
    if (db < E.H) E.dirty._fill(0, db, E.W, E.H - db);
    if (dc.x > 0) E.dirty._fill(0, dc.y, dc.x, dc.h);
    var dr = dc.x + dc.w;
    if (dr < E.W) E.dirty._fill(dr, dc.y, E.W - dr, dc.h);
}

// roda cenas {enter, update(dt), draw, exit, fps, static} ate E.quit();
// ticka input, audio, camera, MODULOS (E._modTicks), timers e tweens
// antes do update da cena. static: true = a cena so desenha na entrada,
// no E.redraw() e quando o dedo entra/sai de um E.gfx.button — menu
// parado nao repinta (nem empurra) nada por quadro.
E.run = function (scenes, first, firstArg) {
    E._scenes = scenes;
    E.sceneName = '';
    E.prevScene = '';
    E._quit = false;
    E._next = null;
    var cur = null;

    // arg (goto/push {arg}) chega no enter(arg): a fase escolhida no menu
    // vai direto para a cena do jogo sem passar pelo E.data
    function enter(name, arg) {
        cur = scenes[name];
        if (!cur) throw new Error('cena inexistente: ' + name);
        E._scene = cur;
        if (E.sceneName) E.prevScene = E.sceneName;
        E.sceneName = name;
        E._sceneGen = ++E._genSeq;
        cur._gen = E._sceneGen;
        E._redraw = true;
        E._btns.length = 0;
        E._btnOn = -1;
        // a camada suja e da cena que a liga: a proxima recomeca do zero
        E.dirty.off();
        if (cur && cur.enter) cur.enter(arg);
    }
    // sai de uma cena: exit() + cleanup dos timers/tweens nascidos nela
    function leave(sc) {
        if (!sc) return;
        if (sc.exit) sc.exit();
        if (sc.cleanup) E._killGen(sc._gen);
    }
    function dirtySave() {
        var d = E.dirty;
        return { on: d.on, bg: d._bg, paint: d._paint, clip: d._clip };
    }
    function dirtyLoad(v) {
        var d = E.dirty;
        d.on = v.on; d._bg = v.bg; d._paint = v.paint; d._clip = v.clip;
        d._prev.length = 0;
        d._cur.length = 0;
        d._full = true;
    }
    enter(first, firstArg);
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
                var kind = E._nextKind || 'goto';
                var narg = E._nextArg;
                E._nextKind = null;
                E._nextArg = undefined;
                if (kind === 'push') {
                    E._stack.push({ name: E.sceneName, scene: cur, gen: E._sceneGen,
                                    dirty: dirtySave() });
                    if (cur && cur.pause) cur.pause();
                    enter(n, narg);
                } else if (kind === 'pop' && E._stack.length) {
                    leave(cur);
                    var top = E._stack.pop();
                    cur = top.scene;
                    E._scene = cur;
                    E.prevScene = E.sceneName;
                    E.sceneName = top.name;
                    E._sceneGen = top.gen;
                    E._redraw = true;
                    E._btns.length = 0;
                    E._btnOn = -1;
                    dirtyLoad(top.dirty);
                    if (cur.resume) cur.resume(narg);
                } else {
                    leave(cur);
                    while (E._stack.length) leave(E._stack.pop().scene);
                    enter(n, narg);
                }
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
                } else if (E._trans && E._trans.kind === 'fadeout') {
                    // goto SEM veu no meio do fadeout: o veu que fechava
                    // sobre a cena ANTIGA perdeu o sentido (troca seca), mas
                    // ficava pendurado para sempre — fadeout concluido nunca
                    // sai de E._trans e o _drawTrans pintava a tela inteira
                    // a cada quadro. Descarta e repinta (veilClean)
                    E._trans = null;
                    veilClean();
                }
            }
        }
        var now = S.millis();
        var dt = (now - E._last) / 1000;
        E._last = now;
        if (dt > 0.1) dt = 0.1;
        if (dt < 0) dt = 0;
        // o veu de transicao anda no tempo REAL (a pausa nao trava um fade)
        var rdt = dt;
        if (E.paused || now < E._frozenUntil) dt = 0;
        else if (E.timeScale !== 1) dt *= E.timeScale > 0 ? E.timeScale : 0;
        E.dt = dt;
        if (E._trans) {
            E._trans.t += rdt * 1000;
            if (E._trans.t >= E._trans.ms) {
                if (E._trans.kind === 'fadeout') E._trans.done = true;
                else {
                    E._trans = null;   // terminou: cena limpa
                    // o ultimo quadro do veu pintou rects FORA da camada suja
                    // (_drawTrans e System.fillRect puro): sem este repaint
                    // integral os restos do veu (cantos/colunas/borda) ficam
                    // na tela ate algo se mover em cima — "blocos pretos".
                    // Com recorte ativo o _full cobre so o clip: veilClean
                    // devolve tambem a faixa de fora ao fundo
                    veilClean();
                }
            }
        }
        E.transitioning = !!E._trans;
        E._fpsN++;
        if (now - E._fpsT >= 1000) {
            E.fps = E._fpsN;
            E._fpsN = 0;
            E._fpsT = now;
        }
        E._pollInput(now);
        E.audio._tick();
        var mt = E._modTicks;
        if (!E.paused) {
            E.cam._tick(dt);
            for (var mi = 0; mi < mt.length; mi++) mt[mi](dt, now);
            E._tickTimers(now);
            E._tickTweens(now);
        } else {
            // tick com fn.always (input de modulo: o pad) roda na pausa —
            // sem isto o botao "continuar" do pad nunca via o toque
            for (var mj = 0; mj < mt.length; mj++) if (mt[mj].always) mt[mj](0, now);
        }
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
                var md = E._modDraws;
                for (var di = 0; di < md.length; di++) md[di]();
                if (E.debug) E._drawDebug();
                if (E.dirty.on) E.dirty._end();
                if (E._trans) E._drawTrans();
            }
        }
        E.frameMs = S.millis() - now;
        // pacing: fps global, ou o da cena (cur.fps; 0 = sem teto)
        var fps = cur && cur.fps !== undefined ? cur.fps : E.fpsTarget;
        var frameMin = fps > 0 ? Math.floor(1000 / fps) : 0;
        var spent = S.millis() - now;
        S.delay(spent < frameMin ? frameMin - spent : 1);
    }
    leave(cur);
    while (E._stack.length) leave(E._stack.pop().scene);
    E._scene = null;
};

// overlay do E.debug: fps / ms do quadro / caixas sujas (+ particulas
// vivas com o fx). Fundo opaco: com a camada suja ligada a caixa registra
// e apaga sozinha quando o debug desliga
var _dbgO = { color: 0x07E0, bg: 0x0000, px: 9, screen: true };
E._drawDebug = function () {
    var s = E.fps + 'fps ' + E.frameMs + 'ms ' + E.sceneName;
    if (E._stack.length) s += '+' + E._stack.length;
    if (E.dirty.on) s += ' d' + (E.dirty._cur.length / 4);
    if (E.fx) s += ' p' + E.fx._live;
    if (E.paused) s += ' II';
    _dbgO.px = Math.round(9 * E.U);
    E.gfx.text(s, 2, 2, _dbgO);
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
// relogio dos prazos: criado DURANTE a pausa conta do instante da pausa
// (o resume empurra todos pelo tempo parado — sem isto o novo pagava 2x)
function clockNow() { return E.paused ? E._pauseAt : S.millis(); }
E.after = function (ms, fn) {
    var t = { at: clockNow() + ms, fn: fn, dead: false, gen: E._sceneGen };
    E._timers.push(t);
    return t;
};
// every(ms, fn, vezes): repete ate vezes disparos (sem = para sempre);
// t.left conta os que faltam
E.every = function (ms, fn, times) {
    var t = { at: clockNow() + ms, every: ms, fn: fn, dead: false, gen: E._sceneGen,
              left: times > 0 ? times : -1 };
    E._timers.push(t);
    return t;
};
E.cancel = function (t) { if (t) t.dead = true; };
// limpa tudo de uma vez (chame no exit da cena que criou timers/tweens)
E.clearTimers = function () { E._timers.length = 0; };
// mata timers e tweens nascidos na geracao de cena g (cena {cleanup: true})
E._killGen = function (g) {
    var k;
    for (k = 0; k < E._timers.length; k++) if (E._timers[k].gen === g) E._timers[k].dead = true;
    for (k = 0; k < E._tweens.length; k++) if (E._tweens[k].gen === g) E._tweens[k].dead = true;
};
// cancela todo tween que mexe em obj (o inimigo morreu no meio do pulo);
// devolve quantos
E.killTweensOf = function (obj) {
    var n = 0;
    for (var k = 0; k < E._tweens.length; k++) {
        var tw = E._tweens[k];
        if (tw.obj === obj && !tw.dead) { tw.dead = true; n++; }
    }
    return n;
};
E.clearTweens = function () { E._tweens.length = 0; };
// ordem de CRIACAO (o laco antigo andava de tras para frente e dois
// prazos no mesmo quadro disparavam invertidos). Os criados durante o tick
// esperam o proximo quadro; mortos saem numa compactacao no fim
E._tickTimers = function (now) {
    var L = E._timers, n0 = L.length, k;
    for (k = 0; k < n0 && k < L.length; k++) {
        var t = L[k];
        if (t.dead || now < t.at) continue;
        if (t.every !== undefined) {
            t.at += t.every;
            if (t.at < now) t.at = now + t.every;
            if (t.left > 0 && --t.left === 0) t.dead = true;
        } else {
            t.dead = true;
        }
        t.fn();
    }
    // clearTimers no meio troca o conteudo: compacta o que sobrou
    L = E._timers;
    var w = 0;
    for (k = 0; k < L.length; k++) if (!L[k].dead) L[w++] = L[k];
    L.length = w;
};
// ms que faltam para o timer disparar (0 morto/vencido) — barra de recarga
E.timeLeft = function (t) {
    if (!t || t.dead) return 0;
    var d = t.at - clockNow();
    return d > 0 ? d : 0;
};

// tween de props numericas: E.tween(obj, {x: 100}, 500, {ease, delay,
// onDone, onUpdate(obj, p), yoyo, repeat}). O "de" e lido quando o tween
// COMECA (depois do delay — antes era na criacao e o obj que mudou no meio
// saltava); prop ausente no obj parte de 0 (antes virava NaN). repeat = N
// voltas extras (-1 = para sempre); yoyo = cada volta inverte o sentido
E._tweens = [];
E.tween = function (obj, to, ms, opts) {
    opts = opts || {};
    var tw = {
        // ms ausente/NaN vira 1 (antes NaN: o tween nunca terminava)
        obj: obj, from: null, to: to, ms: ms >= 1 ? ms : 1,
        t0: clockNow() + (opts.delay || 0),
        ease: opts.ease || E.m.inOutQuad,
        onDone: opts.onDone || null,
        onUpdate: opts.onUpdate || null,
        yoyo: !!opts.yoyo,
        repeat: opts.repeat || 0,
        gen: E._sceneGen,
        _rev: false,
        dead: false
    };
    E._tweens.push(tw);
    return tw;
};
// alvo relativo: "+=20" / "-=20" soma ao valor no INICIO do tween
function tweenTo(v, from) {
    if (typeof v !== 'string') return v;
    var d = parseFloat(v.slice(2));
    if (isNaN(d)) return from;
    return v.charAt(0) === '-' ? from - d : from + d;
}
E._tickTweens = function (now) {
    var L = E._tweens, n0 = L.length;
    for (var k = 0; k < n0 && k < L.length; k++) {
        var tw = L[k];
        if (tw.dead || now < tw.t0) continue;
        if (!tw.from) {
            tw.from = {};
            var rel = null;
            for (var fk in tw.to) {
                var fv = tw.obj[fk];
                tw.from[fk] = typeof fv === 'number' ? fv : 0;
                if (typeof tw.to[fk] === 'string') {
                    if (!rel) rel = {};
                    rel[fk] = tweenTo(tw.to[fk], tw.from[fk]);
                }
            }
            if (rel) {
                // copia: o literal do chamador (reusado num repeat) fica intacto
                var nt = {};
                for (var tk in tw.to) nt[tk] = rel[tk] !== undefined ? rel[tk] : tw.to[tk];
                tw.to = nt;
            }
        }
        var p = (now - tw.t0) / tw.ms;
        var done = p >= 1;
        if (done) p = 1;
        var e = tw.ease(tw._rev ? 1 - p : p);
        for (var kk in tw.to) {
            tw.obj[kk] = tw.from[kk] + (tw.to[kk] - tw.from[kk]) * e;
        }
        if (tw.onUpdate) tw.onUpdate(tw.obj, p);
        if (done) {
            if (tw.repeat !== 0) {
                if (tw.repeat > 0) tw.repeat--;
                tw.t0 += tw.ms;
                if (tw.t0 + tw.ms < now) tw.t0 = now;   // quadro longo: nao acumula voltas
                if (tw.yoyo) tw._rev = !tw._rev;
                continue;
            }
            tw.dead = true;
            if (tw.onDone) tw.onDone();
        }
    }
    L = E._tweens;
    var w = 0;
    for (var q = 0; q < L.length; q++) if (!L[q].dead) L[w++] = L[q];
    L.length = w;
};

// timeline de tweens NO MESMO obj: E.seq(obj, [passos], {onDone}) — cada
// passo {to, ms, ease, delay} roda depois do anterior; {wait: ms} pausa,
// {call: fn(obj)} chama (som, fx) e segue; {par: [passos]}
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
        // {call: fn} roda e segue no mesmo quadro; {wait: ms} so espera
        if (st.call) { st.call(obj); next(); return; }
        if (st.wait !== undefined) { h._tw = E.after(st.wait, next); return; }
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
    // 1o vivo que passa em fn (null) / quantos vivos passam
    g.find = function (fn) {
        var a = g.items;
        for (var i = 0; i < a.length; i++) if (!a[i].dead && fn(a[i])) return a[i];
        return null;
    };
    g.countIf = function (fn) {
        var a = g.items, n = 0;
        for (var i = 0; i < a.length; i++) if (!a[i].dead && (!fn || fn(a[i]))) n++;
        return n;
    };
    // vivo mais perto de (x, y) que passa em fn (opcional), dentro de maxD
    // px (opcional): mira automatica, inimigo que persegue o mais proximo
    g.closest = function (x, y, fn, maxD) {
        var a = g.items, best = null;
        var bd = maxD > 0 ? maxD * maxD : Infinity;
        for (var i = 0; i < a.length; i++) {
            var o = a[i];
            if (o.dead || (fn && !fn(o))) continue;
            var dx = o.x - x, dy = o.y - y, d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = o; }
        }
        return best;
    };
    // tira o objeto ja (fora do update — o dead e o caminho do meio do tick)
    g.remove = function (o) {
        var a = g.items, i = a.indexOf(o);
        if (i < 0) return false;
        a.splice(i, 1);
        g.count = a.length;
        return true;
    };
    // ordem de desenho: key = nome de prop (ex. 'y' — quem esta mais embaixo
    // desenha por cima) ou comparador; estavel (empate mantem a ordem)
    g.sort = function (key) {
        var a = g.items;
        var cmp = typeof key === 'function' ? key :
                  function (p, q) { return p[key] - q[key]; };
        // insercao: estavel, sem alocar, e quase ordenada quadro a quadro e O(n)
        for (var i = 1; i < a.length; i++) {
            var o = a[i], j = i - 1;
            while (j >= 0 && cmp(a[j], o) > 0) { a[j + 1] = a[j]; j--; }
            a[j + 1] = o;
        }
    };
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
    var cursor = 0;
    var p = {
        items: items, count: n, alive: 0,
        // procura a partir do ultimo spawn (cursor circular): pool cheio de
        // vivos no comeco nao re-varre o prefixo a cada tiro
        // init(o) opcional prepara o reciclado (zera vida, posicao...)
        spawn: function (init) {
            var L = items.length;
            for (var j = 0; j < L; j++) {
                var k = cursor + j;
                if (k >= L) k -= L;
                if (items[k].dead) {
                    items[k].dead = false;
                    cursor = k + 1 >= L ? 0 : k + 1;
                    p.alive++;
                    if (init) init(items[k]);
                    return items[k];
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
        // 1o vivo que passa em fn (null)
        find: function (fn) {
            for (var j = 0; j < items.length; j++) {
                if (!items[j].dead && fn(items[j])) return items[j];
            }
            return null;
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
    _dz: null,           // zona morta {w, h} centrada na tela
    _shT: 0, _shDur: 0, _shPow: 0,

    // segue t ({x, y} de mundo); lerp 0..1 por quadro; opts.deadzone {w, h}
    // = caixa no centro da tela onde o alvo anda SEM mover a camera
    // (plataforma: pulo curto nao sacode o cenario)
    follow: function (t, lerp, opts) {
        this._target = t;
        this._lerp = lerp === undefined ? 1 : lerp;
        this._dz = opts && opts.deadzone ? opts.deadzone : null;
        // offset {x, y}: olha a frente do alvo (mude por quadro com a
        // direcao — o lerp suaviza a virada)
        this.offset = opts && opts.offset ? opts.offset : null;
    },
    offset: null,
    // a caixa de MUNDO aparece na tela? (pad = folga em px) — pule o draw
    // do que esta fora (mapa grande, 200 entidades)
    inView: function (x, y, w, h, pad) {
        var p = pad || 0;
        var sx = x - this.x + this.ox, sy = y - this.y + this.oy;
        return sx + (w || 0) >= -p && sy + (h || 0) >= -p &&
               sx <= E.W + p && sy <= E.H + p;
    },
    // passeio da camera ate CENTRAR (x, y) em ms (cutscene: mostra a porta
    // que abriu). Larga o follow; opts {ease, onDone}. Devolve o tween
    panTo: function (x, y, ms, opts) {
        var o = opts || EMPTY;
        this._target = null;
        var tx = x - E.W / 2, ty = y - E.H / 2;
        var b = this.bounds;
        if (b) {
            tx = b.w <= E.W ? b.x + b.w / 2 - E.W / 2 : E.m.clamp(tx, b.x, b.x + b.w - E.W);
            ty = b.h <= E.H ? b.y + b.h / 2 - E.H / 2 : E.m.clamp(ty, b.y, b.y + b.h - E.H);
        }
        return E.tween(this, { x: tx, y: ty }, ms, { ease: o.ease, onDone: o.onDone });
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
            // lerp calibrado a 30 quadros/s e corrigido pelo dt: a 20 fps (4848
            // com jogo pesado) a camera seguia o alvo 1/3 mais devagar
            var k = E.m.clamp(this._lerp, 0, 1);
            if (k < 1 && dt > 0) k = 1 - Math.pow(1 - k, dt * 30);
            else if (k < 1) k = 0;
            var tx = this._target.x - E.W / 2, ty = this._target.y - E.H / 2;
            if (this.offset) { tx += this.offset.x || 0; ty += this.offset.y || 0; }
            var dz = this._dz;
            if (dz) {
                // alvo dentro da zona morta = camera parada; fora, a camera
                // anda so o que passou da borda
                var hw = (dz.w || 0) / 2, hh = (dz.h || 0) / 2;
                var ex = tx - this.x, ey = ty - this.y;
                tx = ex > hw ? tx - hw : (ex < -hw ? tx + hw : this.x);
                ty = ey > hh ? ty - hh : (ey < -hh ? ty + hh : this.y);
            }
            this.x += (tx - this.x) * k;
            this.y += (ty - this.y) * k;
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
        this._dz = null;
        this.offset = null;
        this._shT = 0;
    },
    // mundo -> tela
    wx: function (x) { return x - this.x + this.ox; },
    wy: function (y) { return y - this.y + this.oy; },
    // tela -> mundo (o toque em E.input.x/y vira coordenada do mapa)
    worldX: function (sx) { return sx + this.x - this.ox; },
    worldY: function (sy) { return sy + this.y - this.oy; }
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
        // par cru font/size: estilo memoizado por par (antes um objeto novo
        // por chamada, sem cache de largura — com a camada suja cada texto
        // pagava um textWidth nativo por quadro)
        var f = o.font || 2, z = o.size || 1, kk = f * 16 + z;
        var rs = _raw[kk];
        if (!rs) rs = _raw[kk] = { font: f, size: z, h: 0, _w: Object.create(null), _wn: 0 };
        return rs;
    }
    var _raw = {};
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

    // 1o definido entre a cor pedida, a do tema e o default (0 vale)
    function pick(a, b, c) { return a !== undefined && a !== null ? a : (b !== undefined && b !== null ? b : c); }
    var _hO = { screen: false };
    function heart(x, y, sz, r, c, scr) {
        _hO.screen = scr;
        g.circle(x + r, y + r, r, c, _hO);
        g.circle(x + sz - r, y + r, r, c, _hO);
        g.tri(x, y + r * 1.3, x + sz, y + r * 1.3, x + sz / 2, y + sz, c, _hO);
    }
    function halfHeart(x, y, sz, r, c, scr) {
        _hO.screen = scr;
        g.circle(x + r, y + r, r, c, _hO);
        g.tri(x, y + r * 1.3, x + sz / 2, y + r * 1.3, x + sz / 2, y + sz, c, _hO);
    }

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
            // sombra: o mesmo texto 1 px (x U) abaixo-direita na cor dada,
            // ANTES do principal (legivel sobre cenario colorido)
            if (o.shadow !== undefined) {
                var sh = Math.max(1, Math.round(E.U));
                S.setTextColor(o.shadow);
                S.drawString(str, X + sh, Y + sh, st.font);
                S.setTextColor(o.color === undefined ? 0xFFFF : o.color);
            }
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
        // quebra por palavras dentro de maxW px (mesmas opts do text);
        // palavra maior que a linha vai sozinha. Devolve as linhas
        wrap: function (str, maxW, o) {
            var st = textStyle(o || EMPTY);
            var out = [], paras = String(str).split('\n');
            for (var p = 0; p < paras.length; p++) {
                var words = paras[p].split(' '), line = '';
                for (var i = 0; i < words.length; i++) {
                    var probe = line ? line + ' ' + words[i] : words[i];
                    if (line && measure(probe, st) > maxW) { out.push(line); line = words[i]; }
                    else line = probe;
                }
                out.push(line);
            }
            return out;
        },
        // texto em varias linhas (wrap + text) dentro de w; o.lh = altura
        // da linha (default altura da fonte + 2), o.max = teto de linhas
        // (a ultima ganha "..."). Devolve a altura usada em px
        textBox: function (str, x, y, w, o) {
            o = o || EMPTY;
            var lines = g.wrap(str, w, o);
            var st = textStyle(o);
            var lh = o.lh || ((st.h || (S.fontHeight(st.font) * st.size)) + 2);
            var n = lines.length;
            if (o.max > 0 && n > o.max) {
                n = o.max;
                // o "..." cabe na largura: corta letras ate caber (antes
                // estourava a caixa na ultima linha)
                var last = lines[n - 1];
                while (last.length && measure(last + '...', st) > w) last = last.slice(0, -1);
                lines[n - 1] = last.replace(/\s+$/, '') + '...';
            }
            var ax = o.align === 'center' ? x + w / 2 : (o.align === 'right' ? x + w : x);
            for (var i = 0; i < n; i++) g.text(lines[i], ax, y + i * lh, o);
            return n * lh;
        },
        // poligono convexo cheio (leque de triangulos) ou contorno:
        // pts = [x0, y0, x1, y1, ...] em coords de mundo (o.screen p/ HUD)
        poly: function (pts, color, o) {
            o = o || EMPTY;
            var n = pts.length >> 1;
            if (n < 2) return;
            if (o.fill === false || n === 2) {
                for (var i = 0; i < n; i++) {
                    var j = (i + 1) % n;
                    if (n === 2 && i === 1) break;
                    g.line(pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1], color, o);
                }
                return;
            }
            for (var k = 1; k < n - 1; k++) {
                g.tri(pts[0], pts[1], pts[k * 2], pts[k * 2 + 1],
                      pts[k * 2 + 2], pts[k * 2 + 3], color, o);
            }
        },
        // botao immediate-mode: desenha e devolve o rect p/ E.hit(). O
        // rotulo escala com a altura do botao (px = 50% de h, encolhe ate
        // caber na largura). Registra o rect: cena static repinta sozinha
        // quando o dedo entra/sai dele (feedback de press sem draw/quadro)
        button: function (label, x, y, w, h, o) {
            o = o || EMPTY;
            var T = E.theme || EMPTY;
            var r = { x: x, y: y, w: w, h: h };
            // cor 0x0000 (preto) e cor valida: `||` a trocava pelo tema
            var accent = pick(o.color, T.accent, 0x07FF);
            var on = E.press(r);
            var primary = o.primary !== false;
            var fill = primary ?
                (on ? accent : (E.caps.wide ? S.mixColor(accent, 0x0000, 25) : accent)) :
                (on ? (E.caps.wide ? S.mixColor(pick(o.bg, T.card, 0x1082), 0xFFFF, 18) : accent)
                    : pick(o.bg, T.card, 0x1082));
            var rad = o.r === undefined ? Math.round(Math.min(h * 0.28, 12 * E.U)) : o.r;
            _ro.r = rad; _ro.screen = o.screen;
            g.rect(x, y, w, h, fill, _ro);
            if (!primary && o.stroke !== false) {
                _roS.r = rad; _roS.screen = o.screen;
                g.rect(x, y, w, h, pick(o.stroke, accent, accent), _roS);
            }
            // scratch dos labels (g.text so le): label de botao a cada quadro
            // nao aloca
            var lo = _btnLo;
            lo.color = o.textColor !== undefined ? o.textColor :
                       (primary ? pick(T.onAccent, 0x0000, 0) : pick(T.text, 0xFFFF, 0xFFFF));
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
            g.rect(x, y, w, h, pick(o.bg, T.stroke, 0x3186), _ro);
            if (f > 0.01) {
                g.rect(x + 1, y + 1, Math.max(1, (w - 2) * f), h - 2,
                       pick(o.fg, T.accent, 0x07FF), _ro);
            }
        },
        // painel/card com borda
        panel: function (x, y, w, h, o) {
            o = o || EMPTY;
            var T = E.theme || EMPTY;
            var rad = o.r === undefined ? Math.round(10 * E.U) : o.r;
            _ro.r = rad; _ro.screen = o.screen;
            g.rect(x, y, w, h, pick(o.bg, T.card, 0x1082), _ro);
            _roS.r = rad; _roS.screen = o.screen;
            g.rect(x, y, w, h, pick(o.stroke, T.stroke, 0x3186), _roS);
        },
        // vida em coracoes: hp de max (meio coracao = hp fracionario .5),
        // o {size (px, default 12*U), gap, color, empty, screen}. Desenho
        // procedural (2 circulos + triangulo) — sem sprite. Devolve a largura
        hearts: function (hp, max, x, y, o) {
            o = o || EMPTY;
            var sz = o.size || Math.round(12 * E.U);
            var gap = o.gap === undefined ? Math.round(sz * 0.25) : o.gap;
            var full = o.color === undefined ? 0xF800 : o.color;
            var vazio = o.empty === undefined ? 0x4208 : o.empty;
            var r = sz / 4;
            for (var i = 0; i < max; i++) {
                var hx = x + i * (sz + gap);
                var v = hp - i;   // >= 1 cheio, 0.5 metade, <= 0 vazio
                // cheio pinta so a cor cheia (antes o vazio ia por baixo:
                // 6 primitivas por coracao em vez de 3)
                if (v >= 1) { heart(hx, y, sz, r, full, o.screen); continue; }
                heart(hx, y, sz, r, vazio, o.screen);
                if (v >= 0.5) halfHeart(hx, y, sz, r, full, o.screen);
            }
            return max > 0 ? max * sz + (max - 1) * gap : 0;
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
    _startAt: 0,           // ms do ultimo playMusic aceito (morte rapida = falha)

    // song = {bpm, loops, tracks:[...]} (API 25); opts {startMs} retoma
    music: function (song, opts) {
        if (!E.caps.music || E.audio.muted || !song) return false;
        E.audio._song = song;
        E.audio._bpm = song.bpm || 120;
        try {
            var ok = !!S.playMusic(song, opts && opts.startMs !== undefined ?
                                   { startMs: opts.startMs } : undefined);
            if (ok) E.audio._startAt = S.millis();
            return ok;
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
    // intervalo minimo (ms) entre dois toques do MESMO som por nome: 10
    // moedas no mesmo quadro viram um "coin", nao uma rajada que entope o
    // canal. 0 desliga; opts.gap sobrepoe por chamada
    gap: 40,
    _lastAt: {},
    sfx: function (what, opts) {
        if (E.audio.muted || !E.caps.speaker) return;
        if (typeof what === 'string') {
            var g = opts && opts.gap !== undefined ? opts.gap : E.audio.gap;
            if (g > 0) {
                var now = S.millis(), la = E.audio._lastAt[what];
                if (la !== undefined && now - la < g) return;
                E.audio._lastAt[what] = now;
            }
        }
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
        // o canal a cada quadro). O playMusic aceita o pedido e o firmware
        // abre o canal depois: trilha que morre em < 1,5 s tambem e falha
        // (sem canal I2S o restart por quadro recriava canal+DMA sem parar)
        if (E.audio._song && !E.audio.playing()) {
            var now = S.millis();
            if (E.audio._startAt && now - E.audio._startAt < 1500 && E.audio._retryAt < now) {
                E.audio._retryAt = now + 2000;
            }
            if (now >= E.audio._retryAt) {
                var ok = false;
                try { ok = S.playMusic(E.audio._song); } catch (e) {}
                if (ok) E.audio._startAt = now;
                E.audio._retryAt = ok ? 0 : now + 2000;
            }
        }
    }
};

// ------------------------------------------------------------ save -------

E.save = {
    prefix: '',
    _base: '',
    _slot: 0,
    get: function (key, def) {
        try {
            var v = Storage.get(E.save.prefix + key, null);
            if (v === null || v === undefined || v === '') return def;
            return v;
        } catch (e) { return def; }
    },
    // true se gravou. A NVS recusa chave > 15 chars (prefixo + slot +
    // nome) e valor > 4 KB: antes o erro sumia e o save "salvava" calado
    set: function (key, val) {
        try {
            Storage.set(E.save.prefix + key, String(val));
            return true;
        } catch (e) {
            E._warn('save.set(' + E.save.prefix + key + '): ' + (e && e.message ? e.message : e));
            return false;
        }
    },
    num: function (key, def) {
        var v = parseFloat(E.save.get(key, def));
        return isNaN(v) ? def : v;
    },
    // objeto/array em JSON (opcoes, desbloqueios, fase salva); JSON podre
    // ou ausente devolve def
    obj: function (key, def) {
        var v = E.save.get(key, null);
        if (v === null) return def;
        try { return JSON.parse(v); } catch (e) { return def; }
    },
    setObj: function (key, val) {
        var txt;
        try { txt = JSON.stringify(val); } catch (e) { return false; }
        return E.save.set(key, txt);
    },
    // contador persistente (mortes, partidas, moedas totais): devolve o novo
    inc: function (key, n) {
        var v = E.save.num(key, 0) + (n === undefined ? 1 : n);
        E.save.set(key, v);
        return v;
    },
    del: function (key) {
        try {
            if (typeof Storage.remove === 'function') Storage.remove(E.save.prefix + key);
            else Storage.set(E.save.prefix + key, '');
        } catch (e) {}
    },
    // arquivo de jogo n (1..): as chaves passam a viver sob "<prefixo>sN.";
    // slot(0) volta ao prefixo base (opcoes globais). Devolve o slot
    slot: function (n) {
        if (n === undefined) return E.save._slot;
        E.save._slot = n > 0 ? n : 0;
        E.save.prefix = (E.save._base || '') + (n > 0 ? 's' + n + '.' : '');
        return E.save._slot;
    },
    // liga/desliga persistente (som, vibracao, tutorial visto)
    bool: function (key, def) {
        var v = E.save.get(key, null);
        if (v === null) return !!def;
        return v === 'true' || v === '1';
    },
    toggle: function (key, def) {
        var v = !E.save.bool(key, def);
        E.save.set(key, v);
        return v;
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
