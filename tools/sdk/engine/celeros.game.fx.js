// game.fx.js — CelerGame FX (dep "celeros.game.fx"): particulas, ondas de
// choque, textos flutuantes, flash e campo de estrelas. Decora o core no
// require (o cache do require faz celeros.game ser singleton — o mesmo E):
//
//   var E = require("celeros.game");
//   require("celeros.game.fx");      // agora E.fx existe
//   E.fx.burst(120, 160, { n: 12 });
//
// O tick entra no registro E._modTicks do core (chamado pelo E.run antes
// do update da cena); o DRAW continua com a cena — ela chama E.fx.draw()
// na ultima linha do proprio draw para ficar por cima do mundo.
//
// 1.1.0: burst {n: 0} semeava 12 (o `||` engolia o zero); E.fx.clear()
// zera particulas/floaters/emissores/flash (exit de cena); popText com
// vy (subida em px/s) e grow (escala no fim da vida).
// 1.2.0: E.fx.presets + E.fx.play(nome, x, y, opts) — explosao, faisca,
// fumaca, confete, poeira, sangue/gosma e cura prontos (o app so ajusta).
// 1.3.0: E.fx.beam (laser/raio que some: linha grossa com nucleo claro) e
// E.fx.count() (particulas vivas + textos — orcamento por quadro).
// 1.4.0: presets de aventura — corte (faisca do golpe de espada), poof
// (monstro que some), brilho (item/coracao), pedrinha (pedra que quebra);
// play(..., {dir: rad}) aponta a receita (o corte sai para onde o golpe foi).

var E = require('celeros.game');
var S = System;

// opts compartilhado (so leitura) — mesmo papel do EMPTY do core
var EMPTY = {};

// scratch do popText no draw: floater por quadro nao aloca opts
var _flo = { color: 0, align: 'center', font: null, px: 0, screen: false };
var _bmO = { w: 1 };

// particulas/floaters/flash tickados pelo loop; draw() por cima da cena
E.fx = {
    version: '1.4.0',
    _parts: [],
    _live: 0,           // particulas vivas: 0 = _tick/draw nem olham o pool
    _cursor: 0,
    _floaters: [],
    _beams: [],         // raios (beam)
    _emitters: [],      // emissores continuos (emitter/trail)
    _flashColor: 0,
    _flashT: 0,
    _flashDur: 1,
    _flashFull: false,

    _reset: function (max) {
        this._parts = [];
        for (var i = 0; i < max; i++) {
            this._parts.push({ dead: true, x: 0, y: 0, vx: 0, vy: 0, t: 0,
                               life: 1, size: 2, color: 0xFFFF, grav: 0,
                               drag: 0, shape: 'dot', grow: 30 });
        }
        this._live = 0;
        this._floaters = [];
        this._emitters = [];
        this._beams = [];
        this._flashT = 0;
    },

    // semeia UMA particula do pool com as opts do burst (caminho zero-alloc
    // compartilhado: burst e emissor caem aqui sem montar objeto por chamada)
    _put: function (x, y, o, a, v) {
        var p = this._spawn();
        if (!p) return false;
        p.x = x;
        p.y = y;
        p.vx = Math.cos(a) * v;
        p.vy = Math.sin(a) * v;
        p.t = 0;
        p.life = (o.life || 0.6) * (0.6 + Math.random() * 0.4);
        p.size = o.size || 2;
        p.color = o.colors ? E.m.pick(o.colors) :
                  (o.color === undefined ? 0xFFFF : o.color);
        p.grav = o.grav || 0;
        p.drag = o.drag || 0;
        p.shape = o.shape || 'dot';
        return true;
    },

    // burst(x, y, {n, color|colors[], speed, speed2, angle, spread, life,
    //               size, grav, drag, shape dot|spark|ring})
    burst: function (x, y, o) {
        o = o || EMPTY;
        var n = o.n === undefined ? 12 : o.n;
        var sp = o.speed === undefined ? 60 : o.speed;
        var sp2 = o.speed2 === undefined ? sp : o.speed2;
        var a0 = o.angle === undefined ? 0 : o.angle;
        var spread = o.spread === undefined ? Math.PI * 2 : o.spread;
        for (var i = 0; i < n; i++) {
            var a = a0 + (spread >= Math.PI * 2 ?
                          Math.random() * spread : (Math.random() - 0.5) * spread);
            var v = E.m.lerp(sp, sp2, Math.random());
            if (!this._put(x, y, o, a, v)) break;
        }
    },

    // onda de choque: anel que expande (speed px/s) e some
    ring: function (x, y, o) {
        o = o || EMPTY;
        var p = this._spawn();
        if (!p) return;
        p.x = x;
        p.y = y;
        p.vx = 0;
        p.vy = 0;
        p.t = 0;
        p.life = o.life || 0.55;
        p.size = o.r0 === undefined ? 6 : o.r0;
        p.grav = 0;
        p.drag = 0;
        p.color = o.color === undefined ? 0xFFFF : o.color;
        p.shape = 'ring';
        p.grow = o.speed === undefined ? 300 : o.speed;
    },

    // texto flutuante (score, dano) que sobe e some; opts {color, life,
    // px | ts (default 'label'), font (cru), screen, vy (subida px/s,
    // default 18; negativo desce), grow (escala extra no fim: 0.5 = +50%)}
    popText: function (x, y, str, o) {
        o = o || EMPTY;
        this._floaters.push({
            x: x, y: y, str: String(str),
            color: o.color === undefined ? 0xFFE0 : o.color,
            t: 0, life: o.life || 0.9, screen: !!o.screen,
            vy: o.vy === undefined ? 18 : o.vy, grow: o.grow || 0,
            font: o.font, px: o.px !== undefined ? o.px :
                (o.font ? undefined : (E.ts[o.ts || 'label'] || 15) * E.U)
        });
        if (this._floaters.length > 12) this._floaters.shift();
    },

    // flash(cor, ms, {full}): por padrao um BRILHO NA BORDA (moldura que
    // some) — o flash de tela cheia branca a cada impacto era o "pisca
    // aleatorio" e custava 2 pushes integrais; full: true = tela cheia
    flash: function (color, ms, o) {
        this._flashColor = color;
        this._flashDur = (ms || 180) / 1000;
        this._flashT = this._flashDur;
        this._flashFull = !!(o && o.full);
    },

    // campo de estrelas parallax (2 camadas): guardado pelo chamador;
    // opts {w, h, vy, color} ou {colors: [perto, longe]}. stride > 1 move
    // cada estrela 1 vez a cada N quadros, escalonado por indice (n/N
    // estrelas por quadro): 60 pontos de 1 px espalhados pelo vidro por
    // quadro faziam a uniao das caixas sujas virar a tela inteira e o push
    // integral voltava — e a disputa de banda com o DMA do painel RGB que
    // faz o vidro vibrar. Velocidade media preservada (dt x stride).
    stars: function (n, o) {
        o = o || EMPTY;
        var w = o.w || E.W, h = o.h || E.H;
        var stride = o.stride || 1;
        var pts = [];
        for (var i = 0; i < n; i++) {
            pts.push({
                x: Math.random() * w, y: Math.random() * h,
                layer: i % 2 ? 1 : 0.45,
                color: o.colors ? o.colors[i % 2] :
                       (o.color === undefined ? 0x7BEF : o.color)
            });
        }
        return {
            update: function (dt) {
                var c = (this._c = (this._c || 0) + 1);
                var vy = (o.vy === undefined ? 14 : o.vy) * (stride > 1 ? dt * stride : dt);
                for (var i = 0; i < pts.length; i++) {
                    if (stride > 1 && (c + i) % stride) continue;
                    var p = pts[i];
                    p.y += vy * p.layer;
                    if (p.y >= h) {
                        p.y -= h;
                        p.x = Math.random() * w;
                    }
                }
            },
            // com E.dirty ligado cada estrela apaga o proprio pixel antigo
            // (1 chamada em vez de uma caixa na camada); estrela parada com
            // o fundo intacto nao pinta nada — o que passou por cima dela
            // cura no proximo tick (ou no quadro de fundo cheio). Com fundo
            // PAINTER o apagar de 1 px nao vale (a cor lisa cobriria a arte
            // do painter): a estrela que andou marca o pixel antigo na
            // camada e o painter o cura no quadro seguinte — sem isso o
            // rastro ficava para sempre (o desenho cru nao registra caixa)
            draw: function () {
                var d = E.dirty;
                var full = !d.on || d._wasFull;
                var erase = d.on && !d._paint && !full;
                var heal = d.on && d._paint && !full;
                var bg = d._bg;
                for (var i = 0; i < pts.length; i++) {
                    var p = pts[i];
                    var x = Math.round(p.x), y = Math.round(p.y);
                    var moved = p.dx !== x || p.dy !== y;
                    if (!moved && !full) continue;
                    if (erase && p.dx !== undefined) S.drawPixel(p.dx, p.dy, bg);
                    else if (heal && p.dx !== undefined) d.add(p.dx, p.dy, 1, 1);
                    S.drawPixel(x, y, p.color);
                    p.dx = x;
                    p.dy = y;
                }
            }
        };
    },

    // emissor continuo: {x, y, rate (part/s), duration (ms; sem = ate stop),
    // follow (() -> {x, y}) p/ fonte movel — devolver null pula o quadro —
    // e as opts de particula do burst (color/colors, speed, speed2, angle,
    // spread, life, size, grav, drag, shape)}. Devolve {on, stop(), start(),
    // set(x, y), dead} — set move a fonte fixa. Semeia sem alocar por quadro
    // (cai no _put direto), e lotar o pool so pula as que nao couberem.
    emitter: function (o) {
        var em = { on: true, acc: 0, t: 0, dead: false, opts: o || {},
                   start: function () { em.on = true; },
                   stop: function () { em.on = false; },
                   set: function (x, y) { em.opts.x = x; em.opts.y = y; } };
        this._emitters.push(em);
        return em;
    },

    // rastro que segue uma entidade: getXY () -> {x, y} em coords de MUNDO
    // (null quando a entidade morreu — o rastro para em vez de semear no
    // cadaver); parado nao deixa rastro (emissor com follow que gela). opts
    // {rate (default 24/s), life (0.5), size (3), color|colors, grav}
    trail: function (getXY, o) {
        o = o || EMPTY;
        var lx = 1e9, ly = 1e9;
        return this.emitter({
            rate: o.rate === undefined ? 24 : o.rate,
            life: o.life === undefined ? 0.5 : o.life,
            size: o.size === undefined ? 3 : o.size,
            color: o.color, colors: o.colors, grav: o.grav,
            speed: 0, speed2: 0, spread: 0, shape: 'dot',
            follow: function () {
                var p = getXY();
                if (!p) return null;          // alvo sumiu: pula o quadro
                if (p.x === lx && p.y === ly) return null;   // parado
                lx = p.x;
                ly = p.y;
                return p;
            }
        });
    },

    // camadas de fundo com rolagem pela camera: [{speed (0..1 da cam),
    // gap (colunas px), rowH (linhas px, default gap), paint(x, y)}]. O
    // paint desenha UM item em coords de TELA (procedural — a casa nao
    // paga decode por tile). Sem rect desenha a tela inteira (1a linha do
    // draw da cena); com rect so as celulas que tocam — sirva o MESMO
    // draw como painter da camada suja:
    //   var bg = E.fx.parallax([...]);
    //   E.dirty.enable(function (x, y, w, h) { bg.draw(x, y, w, h); });
    parallax: function (layers) {
        var L = [];
        for (var i = 0; i < layers.length; i++) {
            var o = layers[i];
            L.push({ speed: o.speed === undefined ? 0.5 : o.speed,
                     gap: o.gap || 32, rowH: o.rowH || o.gap || 32,
                     paint: o.paint, ox: (i * 7 % 13) * 2.5, oy: (i * 11 % 17) * 1.7 });
        }
        return {
            draw: function (x, y, w, h) {
                var full = w === undefined;
                var x0 = full ? 0 : x, y0 = full ? 0 : y;
                var x1 = full ? E.W : x + w, y1 = full ? E.H : y + h;
                var camx = E.cam.x, camy = E.cam.y;
                for (var k = 0; k < L.length; k++) {
                    var l = L[k];
                    var offX = ((camx * l.speed + l.ox) % l.gap + l.gap) % l.gap;
                    var offY = ((camy * l.speed + l.oy) % l.rowH + l.rowH) % l.rowH;
                    var ix = Math.ceil((x0 + offX) / l.gap) * l.gap - offX;
                    var iy = Math.ceil((y0 + offY) / l.rowH) * l.rowH - offY;
                    for (var px = ix - l.gap; px < x1; px += l.gap) {
                        for (var py = iy - l.rowH; py < y1; py += l.rowH) {
                            l.paint(px, py);
                        }
                    }
                }
            }
        };
    },

    // receitas por intencao: opts do burst (+ ring/flash/shake opcionais).
    // Mude ou acrescente: E.fx.presets.meu = { n: 8, ... }
    presets: {
        explosao: { n: 18, colors: [0xFFE0, 0xFD20, 0xF800], speed: 50, speed2: 140,
                    life: 0.6, size: 3, drag: 1.5, ring: { speed: 220, life: 0.35 },
                    shake: [4, 0.25] },
        faisca: { n: 8, colors: [0xFFFF, 0xFFE0], speed: 90, speed2: 160, life: 0.25,
                  shape: 'spark' },
        fumaca: { n: 6, colors: [0x7BEF, 0x528A], speed: 10, speed2: 30, life: 1.1,
                  size: 5, grav: -20, drag: 0.8 },
        confete: { n: 24, colors: [0xF800, 0x07E0, 0x001F, 0xFFE0, 0xF81F], speed: 60,
                   speed2: 150, angle: -Math.PI / 2, spread: 2.2, life: 1.2, size: 2,
                   grav: 160 },
        poeira: { n: 5, colors: [0xC618, 0x8410], speed: 15, speed2: 40, angle: -Math.PI / 2,
                  spread: 2.6, life: 0.4, size: 2, drag: 2 },
        gosma: { n: 10, colors: [0x07E0, 0x0400], speed: 40, speed2: 100, life: 0.5,
                 size: 3, grav: 240 },
        cura: { n: 10, colors: [0x07E0, 0xAFE5], speed: 15, speed2: 35, angle: -Math.PI / 2,
                spread: 1.2, life: 0.8, size: 2, grav: -40 },
        corte: { n: 7, colors: [0xFFFF, 0xC7FF, 0xFFE0], speed: 80, speed2: 170, spread: 1.1,
                 life: 0.22, shape: 'spark', drag: 3 },
        poof: { n: 12, colors: [0xFFFF, 0xC618, 0x8410], speed: 25, speed2: 70, life: 0.45,
                size: 4, drag: 2.5, ring: { speed: 120, life: 0.25, color: 0xFFFF } },
        brilho: { n: 6, colors: [0xFFE0, 0xFFFF], speed: 20, speed2: 45, angle: -Math.PI / 2,
                  spread: 2.4, life: 0.5, size: 2, shape: 'spark', grav: -30 },
        pedrinha: { n: 6, colors: [0x8410, 0xC618], speed: 40, speed2: 90, life: 0.35, size: 2,
                    grav: 300 }
    },
    // toca uma receita em (x, y) de mundo: opts sobrepoem os campos (cor,
    // n...). Devolve false se o nome nao existe
    play: function (name, x, y, opts) {
        var pr = this.presets[name];
        if (!pr) return false;
        var o = pr;
        if (opts) {
            o = {};
            var k;
            for (k in pr) o[k] = pr[k];
            for (k in opts) o[k] = opts[k];
        }
        // dir: a receita aponta para o angulo dado (o corte segue o golpe)
        if (opts && opts.dir !== undefined) {
            if (o === pr) { o = {}; for (var k2 in pr) o[k2] = pr[k2]; }
            o.angle = opts.dir;
        }
        this.burst(x, y, o);
        if (o.ring) this.ring(x, y, { speed: o.ring.speed, life: o.ring.life,
                                      color: o.ring.color === undefined ? o.colors && o.colors[0] : o.ring.color });
        if (o.flash) this.flash(o.flash[0], o.flash[1]);
        if (o.shake && E.cam) E.cam.shake(o.shake[0], o.shake[1]);
        return true;
    },

    // raio/laser de (x0,y0) a (x1,y1) em coords de mundo que afina e some:
    // {color, core (cor do nucleo, default branco), w (px, default 4*U),
    // life (s, default 0.18)}. Ate 8 vivos (o mais velho cede a vaga)
    beam: function (x0, y0, x1, y1, o) {
        o = o || EMPTY;
        this._beams.push({ x0: x0, y0: y0, x1: x1, y1: y1, t: 0,
                           life: o.life || 0.18,
                           w: o.w || Math.max(2, Math.round(4 * E.U)),
                           color: o.color === undefined ? 0x07FF : o.color,
                           core: o.core === undefined ? 0xFFFF : o.core });
        if (this._beams.length > 8) this._beams.shift();
    },
    // vivos agora: particulas + textos + raios
    count: function () { return this._live + this._floaters.length + this._beams.length; },

    // zera TUDO (particulas, textos, emissores, flash) — exit de cena: o
    // fx e do E (singleton), e sem isto a explosao do jogo terminava em
    // cima do menu
    clear: function () {
        var ps = this._parts;
        for (var i = 0; i < ps.length; i++) ps[i].dead = true;
        this._live = 0;
        this._floaters.length = 0;
        this._beams.length = 0;
        for (var e = 0; e < this._emitters.length; e++) this._emitters[e].dead = true;
        this._emitters.length = 0;
        this._flashT = 0;
    },

    _spawn: function () {
        for (var i = 0; i < this._parts.length; i++) {
            var k = (this._cursor + i) % this._parts.length;
            if (this._parts[k].dead) {
                this._cursor = (k + 1) % this._parts.length;
                this._parts[k].dead = false;
                this._live++;
                return this._parts[k];
            }
        }
        return null;
    },

    _tick: function (dt) {
        var ps = this._parts;
        for (var i = 0, n = this._live > 0 ? ps.length : 0; i < n; i++) {
            var p = ps[i];
            if (p.dead) continue;
            p.t += dt;
            if (p.t >= p.life) { p.dead = true; this._live--; continue; }
            p.vy += p.grav * dt;
            if (p.drag > 0) {
                var d = 1 - p.drag * dt;
                if (d < 0) d = 0;
                p.vx *= d;
                p.vy *= d;
            }
            p.x += p.vx * dt;
            p.y += p.vy * dt;
        }
        var ems = this._emitters;
        for (var e = ems.length - 1; e >= 0; e--) {
            var em = ems[e];
            if (em.dead) { ems.splice(e, 1); continue; }
            if (!em.on) continue;
            var o = em.opts;
            if (o.duration) {
                em.t += dt * 1000;
                if (em.t >= o.duration) {
                    em.on = false;
                    // once: emissor de UMA vez libera a vaga (sem isso o
                    // app tinha que marcar dead e reciclar por conta)
                    if (o.once) em.dead = true;
                    continue;
                }
            }
            var src = o.follow ? o.follow() : o;
            if (!src) continue;   // fonte movel indisponivel neste quadro
            em.acc += (o.rate === undefined ? 10 : o.rate) * dt;
            var sp = o.speed === undefined ? 60 : o.speed;
            var sp2 = o.speed2 === undefined ? sp : o.speed2;
            var a0 = o.angle === undefined ? 0 : o.angle;
            var spread = o.spread === undefined ? Math.PI * 2 : o.spread;
            while (em.acc >= 1) {
                em.acc -= 1;
                var a = a0 + (spread >= Math.PI * 2 ?
                              Math.random() * spread : (Math.random() - 0.5) * spread);
                if (!this._put(src.x, src.y, o, a, E.m.lerp(sp, sp2, Math.random()))) {
                    em.acc = 0;   // pool cheio: nao acumula divida
                    break;
                }
            }
        }
        var fs = this._floaters;
        for (var j = fs.length - 1; j >= 0; j--) {
            fs[j].t += dt;
            fs[j].y -= fs[j].vy * dt;
            if (fs[j].t >= fs[j].life) fs.splice(j, 1);
        }
        var bs = this._beams;
        for (var bi = bs.length - 1; bi >= 0; bi--) {
            bs[bi].t += dt;
            if (bs[bi].t >= bs[bi].life) bs.splice(bi, 1);
        }
        if (this._flashT > 0) this._flashT -= dt;
    },

    draw: function () {
        var ps = this._parts, D = E.dirty, mix = E.caps.wide;
        // camera do quadro (E.cam.wx/wy inline: 2 chamadas a menos por particula)
        var cox = E.cam.ox - E.cam.x, coy = E.cam.oy - E.cam.y;
        for (var i = 0, n = this._live > 0 ? ps.length : 0; i < n; i++) {
            var p = ps[i];
            if (p.dead) continue;
            var k = 1 - p.t / p.life;
            var col = p.color;
            if (k < 0.5 && mix) col = S.mixColor(p.color, 0x0000, Math.round(100 - k * 200));
            var x = Math.round(p.x + cox), y = Math.round(p.y + coy);
            if (p.shape === 'spark') {
                var x2 = Math.round(x - p.vx * 0.05), y2 = Math.round(y - p.vy * 0.05);
                S.drawLine(x, y, x2, y2, col);
                if (D.on) D.add(Math.min(x, x2), Math.min(y, y2), Math.abs(x2 - x) + 1, Math.abs(y2 - y) + 1);
            } else if (p.shape === 'ring') {
                var rr = Math.round(p.size + p.t * p.grow);
                S.drawCircle(x, y, rr, col);
                if (D.on) D.add(x - rr, y - rr, rr * 2 + 1, rr * 2 + 1);
            } else {
                var r = Math.max(1, Math.round(p.size * k));
                if (r <= 1) S.fillRect(x, y, 2, 2, col);
                else S.fillCircle(x, y, r, col);
                if (D.on) D.add(x - r, y - r, r * 2 + 1, r * 2 + 1);
            }
        }
        var bs = this._beams;
        for (var b = 0; b < bs.length; b++) {
            var be = bs[b], kb = 1 - be.t / be.life;
            var bw = Math.max(1, Math.round(be.w * kb));
            _bmO.w = bw;
            E.gfx.line(be.x0, be.y0, be.x1, be.y1, be.color, _bmO);
            if (bw > 2) {
                _bmO.w = Math.max(1, Math.round(bw / 3));
                E.gfx.line(be.x0, be.y0, be.x1, be.y1, be.core, _bmO);
            }
        }
        var fs = this._floaters;
        for (var j = 0; j < fs.length; j++) {
            var f = fs[j];
            var al = 1 - f.t / f.life;
            var fc = f.color;
            if (al < 0.4 && mix) fc = S.mixColor(f.color, 0x0000, Math.round(100 - al * 250));
            _flo.color = fc;
            _flo.font = f.font;
            _flo.px = f.grow && f.px ? f.px * (1 + f.grow * (1 - al)) : f.px;
            _flo.screen = f.screen;
            E.gfx.text(f.str, f.x, f.y, _flo);
        }
        if (this._flashT > 0) {
            var q = Math.round(100 * (1 - this._flashT / this._flashDur));
            if (q < 70) {   // some antes de virar veu cinza: flash e curto
                var c = mix ? S.mixColor(this._flashColor, 0x0000, q) : this._flashColor;
                if (this._flashFull) {
                    S.fillRect(0, 0, E.W, E.H, c);
                    if (D.on) D.full();
                } else {
                    // moldura que afina conforme some
                    var bw = Math.max(2, Math.round(10 * E.U * (1 - q / 70)));
                    S.fillRect(0, 0, E.W, bw, c);
                    S.fillRect(0, E.H - bw, E.W, bw, c);
                    S.fillRect(0, bw, bw, E.H - bw * 2, c);
                    S.fillRect(E.W - bw, bw, bw, E.H - bw * 2, c);
                    if (D.on) {
                        D.add(0, 0, E.W, bw);
                        D.add(0, E.H - bw, E.W, bw);
                        D.add(0, bw, bw, E.H - bw * 2);
                        D.add(E.W - bw, bw, bw, E.H - bw * 2);
                    }
                }
            }
        }
    }
};

// o core chama antes do update da cena (wrapper: E._modTicks guarda funcao
// solta — o this do metodo se perderia)
E._modTicks.push(function (dt, now) { E.fx._tick(dt, now); });
// modulo carregado DEPOIS do E.init (ordem incomum): pool default do core
if (E._inited) E.fx._reset(96);
E._mods.push('fx');

module.exports = E;
