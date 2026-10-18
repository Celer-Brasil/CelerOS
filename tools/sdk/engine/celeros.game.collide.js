// game.collide.js — CelerGame COLLIDE (dep "celeros.game.collide"):
// colisao de ARCADE sem fisica — testes de forma, hash espacial para
// muitos corpos (tiros x inimigos sem O(n^2)) e o move-and-slide de
// plataforma contra o tilemap. Decora o core no require:
//
//   var E = require("celeros.game");
//   require("celeros.game.collide");
//   var C = E.collide;
//   if (C.rect(a, b)) ...                    // {x, y, w, h} canto sup. esq.
//   var hs = C.hash(32);                     // celula de 32 px
//   hs.clear(); inimigos.each(function (e) { hs.add(e); });
//   hs.query(tiro, function (e) { e.dead = true; });
//   // heroi {x, y, w, h, vx, vy} contra o tilemap (modulo tilemap):
//   var r = C.move(heroi, heroi.vx * dt, heroi.vy * dt, mapa);
//   if (r.ground) podePular = true;
//
// Formas: retangulo {x, y, w, h} (x,y = canto) e circulo {x, y, r} (x,y =
// centro) — o mesmo do resto da engine (E.hit usa rect de canto). Para
// corpo rigido/cordas use a dep celeros.physics.
//
// 1.1.0: move() com dx/dy NaN/Infinity (velocidade envenenada por divisao
// por zero) travava o quadro num laco eterno — vira 0; o hash de mundo que
// ROLA crescia sem fim (uma chave por celula ja visitada) e agora recicla
// as celulas quando passam de 4096. Novos: C.ray (raio contra o tilemap,
// DDA — tiro instantaneo, laser, visao em pixels) e C.sweep (AABB em
// movimento: fracao do 1o contato).
// 1.2.0: hash em baldes numericos fixos (sem chave string nem array por
// caixa) e pairs sem closure por corpo — mesma API e mesmo resultado.

var E = require('celeros.game');

var _res = { hitX: false, hitY: false, ground: false, ceil: false, dx: 0, dy: 0 };
var _ray = { hit: false, x: 0, y: 0, c: 0, r: 0, dist: 0 };

E.collide = {
    version: '1.2.0',
    normal: { x: 0, y: 0 },   // normal do ultimo sweep com contato

    // retangulo x retangulo (bordas encostando NAO contam)
    rect: function (a, b) {
        return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    },
    circle: function (a, b) {
        var dx = a.x - b.x, dy = a.y - b.y, rr = a.r + b.r;
        return dx * dx + dy * dy < rr * rr;
    },
    // circulo c x retangulo b
    circleRect: function (c, b) {
        var nx = c.x < b.x ? b.x : (c.x > b.x + b.w ? b.x + b.w : c.x);
        var ny = c.y < b.y ? b.y : (c.y > b.y + b.h ? b.y + b.h : c.y);
        var dx = c.x - nx, dy = c.y - ny;
        return dx * dx + dy * dy < c.r * c.r;
    },
    point: function (x, y, b) {
        return b.r !== undefined ? (x - b.x) * (x - b.x) + (y - b.y) * (y - b.y) < b.r * b.r
                                 : x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
    },
    // qualquer combinacao (r = circulo, w/h = retangulo)
    test: function (a, b) {
        var ca = a.r !== undefined, cb = b.r !== undefined;
        if (ca && cb) return E.collide.circle(a, b);
        if (ca) return E.collide.circleRect(a, b);
        if (cb) return E.collide.circleRect(b, a);
        return E.collide.rect(a, b);
    },
    // vetor minimo para TIRAR a de dentro de b (retangulos): {x, y} ou null
    // (empurra pelo eixo de menor penetracao)
    push: function (a, b) {
        if (!E.collide.rect(a, b)) return null;
        var ox1 = b.x + b.w - a.x, ox2 = a.x + a.w - b.x;
        var oy1 = b.y + b.h - a.y, oy2 = a.y + a.h - b.y;
        var px = ox1 < ox2 ? ox1 : -ox2, py = oy1 < oy2 ? oy1 : -oy2;
        if (Math.abs(px) < Math.abs(py)) return { x: px, y: 0 };
        return { x: 0, y: py };
    },
    // segmento (x0,y0)-(x1,y1) contra retangulo: fracao 0..1 do primeiro
    // toque ou -1 (tiro rapido que atravessaria o alvo num quadro)
    segRect: function (x0, y0, x1, y1, b) {
        var t0 = 0, t1 = 1, dx = x1 - x0, dy = y1 - y0;
        var p = [-dx, dx, -dy, dy], q = [x0 - b.x, b.x + b.w - x0, y0 - b.y, b.y + b.h - y0];
        for (var i = 0; i < 4; i++) {
            if (p[i] === 0) { if (q[i] < 0) return -1; continue; }
            var t = q[i] / p[i];
            if (p[i] < 0) { if (t > t1) return -1; if (t > t0) t0 = t; }
            else { if (t < t0) return -1; if (t < t1) t1 = t; }
        }
        return t0;
    },

    // AABB a andando (vx, vy) neste quadro contra b parado: fracao 0..1 do
    // 1o contato (-1 sem contato) + normal em C.normal {x, y} — bala rapida e
    // dash que atravessariam o alvo entre dois quadros
    sweep: function (a, vx, vy, b) {
        var S2 = E.collide.normal;
        S2.x = 0; S2.y = 0;
        var ix0, ix1, iy0, iy1;
        if (vx > 0) { ix0 = b.x - (a.x + a.w); ix1 = b.x + b.w - a.x; }
        else { ix0 = b.x + b.w - a.x; ix1 = b.x - (a.x + a.w); }
        if (vy > 0) { iy0 = b.y - (a.y + a.h); iy1 = b.y + b.h - a.y; }
        else { iy0 = b.y + b.h - a.y; iy1 = b.y - (a.y + a.h); }
        var tx0, tx1, ty0, ty1;
        if (vx === 0) {
            if (a.x + a.w <= b.x || a.x >= b.x + b.w) return -1;
            tx0 = -Infinity; tx1 = Infinity;
        } else { tx0 = ix0 / vx; tx1 = ix1 / vx; }
        if (vy === 0) {
            if (a.y + a.h <= b.y || a.y >= b.y + b.h) return -1;
            ty0 = -Infinity; ty1 = Infinity;
        } else { ty0 = iy0 / vy; ty1 = iy1 / vy; }
        var t0 = Math.max(tx0, ty0), t1 = Math.min(tx1, ty1);
        if (t0 > t1 || t1 < 0 || t0 > 1) return -1;
        if (t0 < 0) return 0;          // ja encostado/dentro
        if (tx0 > ty0) S2.x = vx > 0 ? -1 : 1;
        else S2.y = vy > 0 ? -1 : 1;
        return t0;
    },

    // raio (x0,y0) -> (x1,y1) em PIXELS contra o tilemap (solidAt ou
    // qualquer {cw, ch, ox, oy, solidAt}) por DDA de celula: devolve o
    // resultado reaproveitado {hit, x, y, c, r, dist} — x,y = onde entrou
    // na 1a celula solida (ou o fim do raio sem hit)
    ray: function (x0, y0, x1, y1, map) {
        var R = _ray;
        var cw = map.cw || 8, ch = map.ch || 8, ox = map.ox || 0, oy = map.oy || 0;
        var dx = x1 - x0, dy = y1 - y0;
        var len = Math.sqrt(dx * dx + dy * dy);
        R.hit = false; R.x = x1; R.y = y1; R.dist = len;
        var c = Math.floor((x0 - ox) / cw), r = Math.floor((y0 - oy) / ch);
        R.c = c; R.r = r;
        if (map.solidAt(x0, y0)) { R.hit = true; R.x = x0; R.y = y0; R.dist = 0; return R; }
        if (len === 0) return R;
        var ux = dx / len, uy = dy / len;
        var sc = ux > 0 ? 1 : -1, sr = uy > 0 ? 1 : -1;
        var tdx = ux !== 0 ? Math.abs(cw / ux) : Infinity;
        var tdy = uy !== 0 ? Math.abs(ch / uy) : Infinity;
        var nbx = ox + (c + (sc > 0 ? 1 : 0)) * cw, nby = oy + (r + (sr > 0 ? 1 : 0)) * ch;
        var tmx = ux !== 0 ? (nbx - x0) / ux : Infinity;
        var tmy = uy !== 0 ? (nby - y0) / uy : Infinity;
        for (var guard = 0; guard < 4096; guard++) {
            var t;
            if (tmx < tmy) { t = tmx; tmx += tdx; c += sc; }
            else { t = tmy; tmy += tdy; r += sr; }
            if (t > len) return R;
            var px = x0 + ux * t, py = y0 + uy * t;
            // ponto na borda da celula nova: amostra meio passo para dentro
            if (map.solidAt(ox + (c + 0.5) * cw, oy + (r + 0.5) * ch)) {
                R.hit = true; R.x = px; R.y = py; R.c = c; R.r = r; R.dist = t;
                return R;
            }
        }
        return R;
    },

    // hash espacial: celulas de `cell` px; add(o) indexa pela caixa (rect ou
    // circulo). Recrie por quadro (clear + add) — barato e sem estado velho.
    // query(caixa, fn) chama fn(o) UMA vez por candidato que de fato colide
    // (test) — fn devolvendo true para a busca
    hash: function (cell) {
        cell = cell || 32;
        // 1.2.0: baldes NUMERICOS fixos (hash da celula -> 0..NB-1) no lugar
        // do dicionario por chave "c,r": sem string por celula nem array por
        // caixa (no 4848 o hash de 4 corpos custava ~9 ms/quadro). Celulas
        // diferentes podem cair no mesmo balde — o test() e o carimbo _hm
        // filtram, e o resultado e o mesmo
        var NB = 512, MASK = NB - 1;
        var buckets = [], used = [], mark = 0;
        for (var bi = 0; bi < NB; bi++) buckets.push(null);
        var h = { count: 0 };
        function bk(c, r) { return ((c * 73856093) ^ (r * 19349663)) & MASK; }
        // caixa do corpo em celulas: _b0.._b3 = c0, r0, c1, r1
        var _c0 = 0, _r0 = 0, _c1 = 0, _r1 = 0;
        function span(o) {
            var x, y, w, hh;
            if (o.r !== undefined) { x = o.x - o.r; y = o.y - o.r; w = hh = o.r * 2; }
            else { x = o.x; y = o.y; w = o.w || 0; hh = o.h || 0; }
            _c0 = Math.floor(x / cell); _c1 = Math.floor((x + w) / cell);
            _r0 = Math.floor(y / cell); _r1 = Math.floor((y + hh) / cell);
        }
        h.add = function (o) {
            span(o);
            for (var r = _r0; r <= _r1; r++) {
                for (var c = _c0; c <= _c1; c++) {
                    var k = bk(c, r);
                    var L = buckets[k];
                    if (!L) L = buckets[k] = [];
                    if (!L.length) used.push(k);
                    // corpo grande que cobre 2 celulas do mesmo balde entra 1x
                    if (L[L.length - 1] !== o) L.push(o);
                }
            }
            h.count++;
        };
        h.clear = function () {
            for (var i = 0; i < used.length; i++) buckets[used[i]].length = 0;
            used.length = 0;
            h.count = 0;
        };
        h.query = function (q, fn) {
            span(q);
            mark++;
            var c0 = _c0, c1 = _c1, r0 = _r0, r1 = _r1;
            var n = 0;
            for (var r = r0; r <= r1; r++) {
                for (var c = c0; c <= c1; c++) {
                    var L = buckets[bk(c, r)];
                    if (!L) continue;
                    for (var i = 0; i < L.length; i++) {
                        var o = L[i];
                        if (o === q || o._hm === mark) continue;
                        o._hm = mark;             // ja visto nesta busca
                        if (!E.collide.test(q, o)) continue;
                        n++;
                        if (fn && fn(o) === true) return n;
                    }
                }
            }
            return n;
        };
        // cada par que colide uma vez so: fn(a, b)
        var _pa = null, _pf = null;
        function _par(b) { if (b._hi !== undefined && b._hi > _pa._hi) _pf(_pa, b); }
        h.pairs = function (list, fn) {
            for (var i = 0; i < list.length; i++) list[i]._hi = i;
            _pf = fn;
            for (var j = 0; j < list.length; j++) {
                _pa = list[j];
                h.query(_pa, _par);
            }
            _pa = _pf = null;
            // indice da lista nao vaza para a proxima chamada
            for (var k = 0; k < list.length; k++) list[k]._hi = undefined;
        };
        return h;
    },

    // move-and-slide de retangulo contra um tilemap (rectSolid do modulo
    // tilemap, ou qualquer {rectSolid(x, y, w, h)}): anda X e depois Y em
    // passos de no maximo meia celula (nao atravessa parede fina em queda
    // rapida), encosta na parede e zera vx/vy do eixo que bateu. Devolve
    // {hitX, hitY, ground, ceil, dx, dy} (objeto reaproveitado)
    move: function (b, dx, dy, map) {
        var R = _res;
        // NaN/Infinity: o laco de passos nunca zerava o resto (quadro preso)
        if (!isFinite(dx)) dx = 0;
        if (!isFinite(dy)) dy = 0;
        R.hitX = R.hitY = R.ground = R.ceil = false;
        R.dx = R.dy = 0;
        var cw = map.cw || 8, ch = map.ch || 8;
        var stepX = cw / 2, stepY = ch / 2;
        // eixo X
        var left = dx;
        while (left !== 0) {
            var sx = left > 0 ? Math.min(left, stepX) : Math.max(left, -stepX);
            if (map.rectSolid(b.x + sx, b.y, b.w, b.h)) {
                // encosta: aproxima pixel a pixel ate a parede
                var u = sx > 0 ? 1 : -1, k = 0;
                while (k < Math.abs(sx) && !map.rectSolid(b.x + u, b.y, b.w, b.h)) {
                    b.x += u; R.dx += u; k++;
                }
                R.hitX = true;
                if (b.vx !== undefined) b.vx = 0;
                break;
            }
            b.x += sx; R.dx += sx; left -= sx;
        }
        left = dy;
        while (left !== 0) {
            var sy = left > 0 ? Math.min(left, stepY) : Math.max(left, -stepY);
            if (map.rectSolid(b.x, b.y + sy, b.w, b.h)) {
                var v = sy > 0 ? 1 : -1, j = 0;
                while (j < Math.abs(sy) && !map.rectSolid(b.x, b.y + v, b.w, b.h)) {
                    b.y += v; R.dy += v; j++;
                }
                R.hitY = true;
                if (sy > 0) R.ground = true; else R.ceil = true;
                if (b.vy !== undefined) b.vy = 0;
                break;
            }
            b.y += sy; R.dy += sy; left -= sy;
        }
        // parado em cima do chao conta como ground (pulo no quadro seguinte)
        if (!R.ground && dy >= 0 && map.rectSolid(b.x, b.y + 1, b.w, b.h)) R.ground = true;
        return R;
    }
};

E._mods.push('collide');

module.exports = E;
