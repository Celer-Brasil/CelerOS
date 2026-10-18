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

var E = require('celeros.game');

var _res = { hitX: false, hitY: false, ground: false, ceil: false, dx: 0, dy: 0 };

E.collide = {
    version: '1.0.0',

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

    // hash espacial: celulas de `cell` px; add(o) indexa pela caixa (rect ou
    // circulo). Recrie por quadro (clear + add) — barato e sem estado velho.
    // query(caixa, fn) chama fn(o) UMA vez por candidato que de fato colide
    // (test) — fn devolvendo true para a busca
    hash: function (cell) {
        cell = cell || 32;
        var cells = {}, used = [], mark = 0;
        var h = { count: 0 };
        function box(o) {
            if (o.r !== undefined) return [o.x - o.r, o.y - o.r, o.r * 2, o.r * 2];
            return [o.x, o.y, o.w || 0, o.h || 0];
        }
        h.add = function (o) {
            var b = box(o);
            var c0 = Math.floor(b[0] / cell), c1 = Math.floor((b[0] + b[2]) / cell);
            var r0 = Math.floor(b[1] / cell), r1 = Math.floor((b[1] + b[3]) / cell);
            for (var r = r0; r <= r1; r++) {
                for (var c = c0; c <= c1; c++) {
                    var k = c + ',' + r;
                    var L = cells[k];
                    if (!L) { L = cells[k] = []; used.push(k); }
                    L.push(o);
                }
            }
            h.count++;
        };
        h.clear = function () {
            for (var i = 0; i < used.length; i++) cells[used[i]].length = 0;
            h.count = 0;
        };
        h.query = function (q, fn) {
            var b = box(q);
            mark++;
            var c0 = Math.floor(b[0] / cell), c1 = Math.floor((b[0] + b[2]) / cell);
            var r0 = Math.floor(b[1] / cell), r1 = Math.floor((b[1] + b[3]) / cell);
            var n = 0;
            for (var r = r0; r <= r1; r++) {
                for (var c = c0; c <= c1; c++) {
                    var L = cells[c + ',' + r];
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
        h.pairs = function (list, fn) {
            for (var i = 0; i < list.length; i++) {
                var a = list[i];
                a._hi = i;
            }
            for (var j = 0; j < list.length; j++) {
                var aa = list[j];
                h.query(aa, function (b) {
                    if (b._hi !== undefined && b._hi > aa._hi) fn(aa, b);
                });
            }
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
