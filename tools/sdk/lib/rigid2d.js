// rigid2d.js — espelho JS do solver rigido nativo (main/Utils/Rigid2D.h,
// System.rigid* da API 33). Porta linha a linha, mesma ordem de operacoes:
// o harness e o emulador rodam a fisica dos jogos como o device (em double
// em vez de float — "mesma aritmetica", nao bit a bit). Mexeu no header,
// mexa aqui (test/sdk cobre os dois contratos).
//
// ES5 de proposito: o mesmo arquivo poderia rodar no Duktape.

'use strict';

var K = {
    MAX_BODIES: 96, MAX_ARB: 320, MAX_SUB: 16,
    SLOP: 0.15, BIAS: 0.2, BOUNCE_MIN: 40, MAX_BOUNCE: 8 * 40,
    SLEEP_LIN: 12, SLEEP_DRIFT: 0.8, SLEEP_TURN: 0.04, SLEEP_TIME: 0.5,
    WAKE_VEL: 18, MAX_SUB_DT: 1 / 120,
    LIN_DAMP: 0.05, ANG_DAMP: 0.8, ROLL_DAMP: 5
};
var BOX = 0, CIRCLE = 1;

function clampf(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function absf(v) { return v < 0 ? -v : v; }
// numero util (rejeita NaN e infinito) — espelho do finf do header
function fin(v) { return v === v && v < 1e30 && v > -1e30; }

function newBody() {
    return { alive: 0, shape: 0, awake: 0, touch: 0, x: 0, y: 0, a: 0, vx: 0, vy: 0, w: 0,
             hw: 0, hh: 0, invM: 0, invI: 0, mu: 0, e: 0, sleepT: 0, sx: 0, sy: 0, sa: 0,
             hit: 0, c: 1, s: 0, ca: 0, bvx: 0, bvy: 0, bw: 0, br: 0 };
}

function newContact() {
    return { px: 0, py: 0, sep: 0, r1x: 0, r1y: 0, r2x: 0, r2y: 0, mN: 0, mT: 0,
             vbias: 0, pbias: 0, pn: 0, pt: 0, pb: 0, fid: 0 };
}

function World(iterations) {
    this.bodies = [];
    this.nBodies = 0;
    this.arb = [];
    this.iterations = iterations < 1 ? 1 : (iterations > 30 ? 30 : iterations);
}

function allocSlot(w) {
    for (var i = 0; i < w.nBodies; i++) if (!w.bodies[i].alive) return i;
    if (w.nBodies >= K.MAX_BODIES) return -1;
    w.bodies[w.nBodies] = newBody();
    return w.nBodies++;
}

function setMass(b, density) {
    // !(density > 0) pega NaN tambem; nao-finito vira estatico (espelho do
    // setMass do header)
    if (!(density > 0) || !fin(density)) { b.invM = 0; b.invI = 0; return; }
    var m, I;
    if (b.shape === CIRCLE) {
        var r = b.hw;
        m = density * 3.14159265 * r * r;
        I = 0.5 * m * r * r;
    } else {
        var W = b.hw * 2, H = b.hh * 2;
        m = density * W * H;
        I = m * (W * W + H * H) / 12;
    }
    b.invM = 1 / m;
    b.invI = 1 / I;
    // massa de poeira (densidade denormal) vira estatico — espelho do
    // setMass do header (invM infinito e' NaN no warm start)
    if (b.invM > 1e12 || !fin(b.invM) || !fin(b.invI)) { b.invM = 0; b.invI = 0; }
}

function addBody(w, shape, x, y, hw, hh, a, density, mu, e) {
    // medida/posicao/angulo invalidos (zero, negativo, NaN, infinito) nao
    // entram — espelho do addBody do header
    if (!(hw > 0) || !(hh > 0) || !fin(hw) || !fin(hh) || !fin(x) || !fin(y) || !fin(a)) return -1;
    var i = allocSlot(w);
    if (i < 0) return -1;
    var b = newBody();
    w.bodies[i] = b;
    b.alive = 1; b.shape = shape; b.awake = 1;
    b.x = x; b.y = y; b.a = a;
    b.hw = hw; b.hh = hh;
    b.mu = fin(mu) ? (mu < 0 ? 0 : mu) : 0;   // NaN/inf: sem atrito
    b.e = fin(e) ? clampf(e, 0, 1) : 0;       // ...e sem quique
    // espelho do header: raio envolvente e cos/sin em cache (o subStep so
    // recalcula quem girou)
    b.br = shape === CIRCLE ? hw : Math.sqrt(hw * hw + hh * hh);
    b.c = Math.cos(a); b.s = Math.sin(a); b.ca = a;
    setMass(b, density);
    return i;
}

function wakeAll(w) {
    for (var i = 0; i < w.nBodies; i++) {
        var b = w.bodies[i];
        if (b.alive && b.invM > 0) { b.awake = 1; b.sleepT = 0; }
    }
}

function dropArbOf(w, i) {
    w.arb = w.arb.filter(function (ar) { return ar.a !== i && ar.b !== i; });
}

function removeBody(w, i) {
    if (i < 0 || i >= w.nBodies || !w.bodies[i].alive) return false;
    w.bodies[i].alive = 0;
    w.bodies[i].hit = 0;   // slot morto nao carrega hit velho pro rigidState
    dropArbOf(w, i);
    while (w.nBodies > 0 && !w.bodies[w.nBodies - 1].alive) w.nBodies--;
    wakeAll(w);
    return true;
}

// ------------------------------------------------------------- colisao ----
var NO_EDGE = 0, EDGE1 = 1, EDGE2 = 2, EDGE3 = 3, EDGE4 = 4;

function cv() { return { x: 0, y: 0, e: [0, 0, 0, 0] }; }
function cvCopy(o, s) { o.x = s.x; o.y = s.y; o.e = s.e.slice(); }
function fkey(e) { return (e[0] | (e[1] << 8) | (e[2] << 16) | (e[3] << 24)) >>> 0; }

function incidentEdge(v, hx, hy, px, py, c, s, nx, ny) {
    var lx = -(c * nx + s * ny), ly = -(-s * nx + c * ny);
    v[0] = cv(); v[1] = cv();
    if (absf(lx) > absf(ly)) {
        if (lx > 0) {
            v[0].x = hx;  v[0].y = -hy; v[0].e[2] = EDGE3; v[0].e[3] = EDGE4;
            v[1].x = hx;  v[1].y = hy;  v[1].e[2] = EDGE4; v[1].e[3] = EDGE1;
        } else {
            v[0].x = -hx; v[0].y = hy;  v[0].e[2] = EDGE1; v[0].e[3] = EDGE2;
            v[1].x = -hx; v[1].y = -hy; v[1].e[2] = EDGE2; v[1].e[3] = EDGE3;
        }
    } else {
        if (ly > 0) {
            v[0].x = hx;  v[0].y = hy;  v[0].e[2] = EDGE4; v[0].e[3] = EDGE1;
            v[1].x = -hx; v[1].y = hy;  v[1].e[2] = EDGE1; v[1].e[3] = EDGE2;
        } else {
            v[0].x = -hx; v[0].y = -hy; v[0].e[2] = EDGE2; v[0].e[3] = EDGE3;
            v[1].x = hx;  v[1].y = -hy; v[1].e[2] = EDGE3; v[1].e[3] = EDGE4;
        }
    }
    for (var i = 0; i < 2; i++) {
        var x = v[i].x, y = v[i].y;
        v[i].x = px + c * x - s * y;
        v[i].y = py + s * x + c * y;
    }
}

function clipSegment(out, inp, nx, ny, off, edge) {
    var n = 0;
    var d0 = nx * inp[0].x + ny * inp[0].y - off;
    var d1 = nx * inp[1].x + ny * inp[1].y - off;
    if (d0 <= 0) { out[n] = cv(); cvCopy(out[n++], inp[0]); }
    if (d1 <= 0) { out[n] = cv(); cvCopy(out[n++], inp[1]); }
    if (d0 * d1 < 0) {
        var t = d0 / (d0 - d1);
        out[n] = cv();
        out[n].x = inp[0].x + t * (inp[1].x - inp[0].x);
        out[n].y = inp[0].y + t * (inp[1].y - inp[0].y);
        if (d0 > 0) {
            out[n].e = inp[0].e.slice();
            out[n].e[0] = edge; out[n].e[2] = NO_EDGE;
        } else {
            out[n].e = inp[1].e.slice();
            out[n].e[1] = edge; out[n].e[3] = NO_EDGE;
        }
        n++;
    }
    return n;
}

// devolve {n, nx, ny} e preenche cs[0..n)
function collideBoxes(A, B, cs) {
    var hax = A.hw, hay = A.hh, hbx = B.hw, hby = B.hh;
    var ca = A.c, sa = A.s, cb = B.c, sb = B.s;
    var dpx = B.x - A.x, dpy = B.y - A.y;
    var dAx = ca * dpx + sa * dpy, dAy = -sa * dpx + ca * dpy;
    var dBx = cb * dpx + sb * dpy, dBy = -sb * dpx + cb * dpy;
    var c11 = ca * cb + sa * sb, c21 = -sa * cb + ca * sb;
    var c12 = -ca * sb + sa * cb, c22 = sa * sb + ca * cb;
    var a11 = absf(c11), a21 = absf(c21), a12 = absf(c12), a22 = absf(c22);
    var faX = absf(dAx) - hax - (a11 * hbx + a12 * hby);
    var faY = absf(dAy) - hay - (a21 * hbx + a22 * hby);
    if (faX > 0 || faY > 0) return null;
    var fbX = absf(dBx) - (a11 * hax + a21 * hay) - hbx;
    var fbY = absf(dBy) - (a12 * hax + a22 * hay) - hby;
    if (fbX > 0 || fbY > 0) return null;

    var relTol = 0.95, absTol = 0.01;
    var axis = 0, sep = faX;
    var n_x = dAx > 0 ? ca : -ca, n_y = dAx > 0 ? sa : -sa;
    if (faY > relTol * sep + absTol * hay) {
        axis = 1; sep = faY;
        n_x = dAy > 0 ? -sa : sa; n_y = dAy > 0 ? ca : -ca;
    }
    if (fbX > relTol * sep + absTol * hbx) {
        axis = 2; sep = fbX;
        n_x = dBx > 0 ? cb : -cb; n_y = dBx > 0 ? sb : -sb;
    }
    if (fbY > relTol * sep + absTol * hby) {
        axis = 3; sep = fbY;
        n_x = dBy > 0 ? -sb : sb; n_y = dBy > 0 ? cb : -cb;
    }
    var fnx, fny, front, snx, sny, negSide, posSide, negEdge, posEdge, side;
    var inc = [];
    if (axis === 0) {
        fnx = n_x; fny = n_y;
        front = A.x * fnx + A.y * fny + hax;
        snx = -sa; sny = ca;
        side = A.x * snx + A.y * sny;
        negSide = -side + hay; posSide = side + hay;
        negEdge = EDGE3; posEdge = EDGE1;
        incidentEdge(inc, hbx, hby, B.x, B.y, cb, sb, fnx, fny);
    } else if (axis === 1) {
        fnx = n_x; fny = n_y;
        front = A.x * fnx + A.y * fny + hay;
        snx = ca; sny = sa;
        side = A.x * snx + A.y * sny;
        negSide = -side + hax; posSide = side + hax;
        negEdge = EDGE2; posEdge = EDGE4;
        incidentEdge(inc, hbx, hby, B.x, B.y, cb, sb, fnx, fny);
    } else if (axis === 2) {
        fnx = -n_x; fny = -n_y;
        front = B.x * fnx + B.y * fny + hbx;
        snx = -sb; sny = cb;
        side = B.x * snx + B.y * sny;
        negSide = -side + hby; posSide = side + hby;
        negEdge = EDGE3; posEdge = EDGE1;
        incidentEdge(inc, hax, hay, A.x, A.y, ca, sa, fnx, fny);
    } else {
        fnx = -n_x; fny = -n_y;
        front = B.x * fnx + B.y * fny + hby;
        snx = cb; sny = sb;
        side = B.x * snx + B.y * sny;
        negSide = -side + hbx; posSide = side + hbx;
        negEdge = EDGE2; posEdge = EDGE4;
        incidentEdge(inc, hax, hay, A.x, A.y, ca, sa, fnx, fny);
    }
    var c1 = [], c2 = [];
    if (clipSegment(c1, inc, -snx, -sny, negSide, negEdge) < 2) return null;
    if (clipSegment(c2, c1, snx, sny, posSide, posEdge) < 2) return null;
    var n = 0;
    for (var i = 0; i < 2; i++) {
        var s = fnx * c2[i].x + fny * c2[i].y - front;
        if (s <= 0) {
            var c = cs[n] = newContact();
            c.sep = s;
            c.px = c2[i].x - s * fnx;
            c.py = c2[i].y - s * fny;
            var e = c2[i].e.slice();
            if (axis >= 2) {
                var t = e[0]; e[0] = e[2]; e[2] = t;
                t = e[1]; e[1] = e[3]; e[3] = t;
            }
            c.fid = fkey(e);
            n++;
        }
    }
    return { n: n, nx: n_x, ny: n_y };
}

function collideCircles(A, B, cs) {
    var dx = B.x - A.x, dy = B.y - A.y;
    var rr = A.hw + B.hw;
    var d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr) return null;
    var d = Math.sqrt(d2), nx, ny;
    if (d < 1e-6) { nx = 0; ny = 1; d = 0; }
    else { nx = dx / d; ny = dy / d; }
    var c = cs[0] = newContact();
    c.sep = d - rr;
    c.px = A.x + nx * (A.hw + c.sep * 0.5);
    c.py = A.y + ny * (A.hw + c.sep * 0.5);
    c.fid = 1;
    return { n: 1, nx: nx, ny: ny };
}

function collideBoxCircle(Q, C, cs) {
    var dx = C.x - Q.x, dy = C.y - Q.y;
    var lx = Q.c * dx + Q.s * dy, ly = -Q.s * dx + Q.c * dy;
    var r = C.hw;
    var qx = clampf(lx, -Q.hw, Q.hw), qy = clampf(ly, -Q.hh, Q.hh);
    var ex = lx - qx, ey = ly - qy;
    var d2 = ex * ex + ey * ey;
    var lnx, lny, sep;
    if (d2 > 1e-10) {
        if (d2 >= r * r) return null;
        var d = Math.sqrt(d2);
        lnx = ex / d; lny = ey / d;
        sep = d - r;
    } else {
        var ox = Q.hw - absf(lx), oy = Q.hh - absf(ly);
        if (ox < oy) { lnx = lx < 0 ? -1 : 1; lny = 0; qx = lnx * Q.hw; sep = -ox - r; }
        else { lnx = 0; lny = ly < 0 ? -1 : 1; qy = lny * Q.hh; sep = -oy - r; }
    }
    var c = cs[0] = newContact();
    c.sep = sep;
    c.px = Q.x + Q.c * qx - Q.s * qy;
    c.py = Q.y + Q.s * qx + Q.c * qy;
    c.fid = 1;
    return { n: 1, nx: Q.c * lnx - Q.s * lny, ny: Q.s * lnx + Q.c * lny };
}

// ------------------------------------------------------------- solver -----
function boundR(b) { return b.br; }
function moving(b) { return b.invM > 0 && b.awake; }
function speedOf(b) { return Math.sqrt(b.vx * b.vx + b.vy * b.vy) + absf(b.w) * boundR(b); }

// espelho do header: busca binaria no array de arbitros ORDENADO por
// (a, b) — a fase larga so chama o narrow com i < j. Devolve o indice, ou
// ~(ponto de insercao) quando nao existe
function findArb(w, a, b) {
    var lo = 0, hi = w.arb.length;
    while (lo < hi) {
        var mid = (lo + hi) >> 1;
        var ar = w.arb[mid];
        if (ar.a < a || (ar.a === a && ar.b < b)) lo = mid + 1;
        else hi = mid;
    }
    if (lo < w.arb.length && w.arb[lo].a === a && w.arb[lo].b === b) return lo;
    return ~lo;
}

// invariante do array de arbitros (espelho do arbOk do header, usado pelo
// martelo do sdk): estritamente ordenado por (a, b), sem duplicata, todo
// par em corpo vivo com indice valido
function arbOk(w) {
    if (w.arb.length > K.MAX_ARB) return false;
    for (var k = 0; k < w.arb.length; k++) {
        var ar = w.arb[k];
        if (ar.a < 0 || ar.b < 0 || ar.a >= ar.b || ar.a >= w.nBodies || ar.b >= w.nBodies) return false;
        if (!w.bodies[ar.a].alive || !w.bodies[ar.b].alive) return false;
        if (ar.n < 1 || ar.n > 2) return false;
        if (k > 0) {
            var pv = w.arb[k - 1];
            if (pv.a > ar.a || (pv.a === ar.a && pv.b >= ar.b)) return false;
        }
    }
    return true;
}

function narrow(w, ia, ib) {
    var A = w.bodies[ia], B = w.bodies[ib];
    var cs = [], r;
    if (A.shape === BOX && B.shape === BOX) r = collideBoxes(A, B, cs);
    else if (A.shape === CIRCLE && B.shape === CIRCLE) r = collideCircles(A, B, cs);
    else if (A.shape === BOX) r = collideBoxCircle(A, B, cs);
    else {
        r = collideBoxCircle(B, A, cs);
        if (r) { r.nx = -r.nx; r.ny = -r.ny; }
    }
    if (!r || r.n === 0) return;
    var k = findArb(w, ia, ib);  // so pares com contato pagam a busca
    if (k < 0) {
        if (w.arb.length >= K.MAX_ARB) return;
        k = ~k;  // entra ja na posicao ordenada (invariante da busca binaria)
        w.arb.splice(k, 0, { a: ia, b: ib, n: 0, live: 0, nx: 0, ny: 0, mu: 0, e: 0, c: [] });
    }
    var ar = w.arb[k];
    for (var i = 0; i < r.n; i++) {
        cs[i].pn = 0; cs[i].pt = 0;
        for (var j = 0; j < ar.n; j++) {
            if (ar.c[j].fid === cs[i].fid) { cs[i].pn = ar.c[j].pn; cs[i].pt = ar.c[j].pt; break; }
        }
    }
    ar.n = r.n;
    ar.c = cs.slice(0, r.n);
    ar.nx = r.nx; ar.ny = r.ny;
    ar.mu = Math.sqrt(A.mu * B.mu);
    ar.e = A.e > B.e ? A.e : B.e;
    ar.live = 1;
}

function subStep(w, dt, gx, gy) {
    var invDt = 1 / dt, i, j, k, it, b, A, B, ar, c;
    for (i = 0; i < w.nBodies; i++) {
        b = w.bodies[i];
        if (!b.alive) continue;
        if (b.a !== b.ca) { b.c = Math.cos(b.a); b.s = Math.sin(b.a); b.ca = b.a; }
        if (!moving(b)) continue;
        if (b.shape === CIRCLE && b.touch) b.w *= 1 / (1 + dt * K.ROLL_DAMP);
        b.touch = 0;
        b.vx += gx * dt;
        b.vy += gy * dt;
        var ld = 1 / (1 + dt * K.LIN_DAMP), ad = 1 / (1 + dt * K.ANG_DAMP);
        b.vx *= ld; b.vy *= ld; b.w *= ad;
    }
    for (k = 0; k < w.arb.length; k++) w.arb[k].live = 0;
    for (i = 0; i < w.nBodies; i++) {
        A = w.bodies[i];
        if (!A.alive) continue;
        var ra = boundR(A);
        for (j = i + 1; j < w.nBodies; j++) {
            B = w.bodies[j];
            if (!B.alive) continue;
            if (!moving(A) && !moving(B)) continue;
            var rb = boundR(B) + ra;
            var dx = B.x - A.x, dy = B.y - A.y;
            if (absf(dx) > rb || absf(dy) > rb) continue;
            if (dx * dx + dy * dy > rb * rb) continue;
            narrow(w, i, j);
        }
    }
    w.arb = w.arb.filter(function (x) { return x.live; });

    for (k = 0; k < w.arb.length; k++) {
        ar = w.arb[k];
        A = w.bodies[ar.a]; B = w.bodies[ar.b];
        A.touch = 1; B.touch = 1;
        if (A.invM > 0 && !A.awake && moving(B) && speedOf(B) > K.WAKE_VEL) { A.awake = 1; A.sleepT = 0; }
        if (B.invM > 0 && !B.awake && moving(A) && speedOf(A) > K.WAKE_VEL) { B.awake = 1; B.sleepT = 0; }
        var imA = moving(A) ? A.invM : 0, iiA = moving(A) ? A.invI : 0;
        var imB = moving(B) ? B.invM : 0, iiB = moving(B) ? B.invI : 0;
        var nx = ar.nx, ny = ar.ny, tx = ny, ty = -nx;
        for (i = 0; i < ar.n; i++) {
            c = ar.c[i];
            c.r1x = c.px - A.x; c.r1y = c.py - A.y;
            c.r2x = c.px - B.x; c.r2y = c.py - B.y;
            var rn1 = c.r1x * nx + c.r1y * ny, rn2 = c.r2x * nx + c.r2y * ny;
            var kN = imA + imB + iiA * (c.r1x * c.r1x + c.r1y * c.r1y - rn1 * rn1) +
                     iiB * (c.r2x * c.r2x + c.r2y * c.r2y - rn2 * rn2);
            c.mN = kN > 0 ? 1 / kN : 0;
            var rt1 = c.r1x * tx + c.r1y * ty, rt2 = c.r2x * tx + c.r2y * ty;
            var kT = imA + imB + iiA * (c.r1x * c.r1x + c.r1y * c.r1y - rt1 * rt1) +
                     iiB * (c.r2x * c.r2x + c.r2y * c.r2y - rt2 * rt2);
            c.mT = kT > 0 ? 1 / kT : 0;
            var dvx = B.vx - B.w * c.r2y - A.vx + A.w * c.r1y;
            var dvy = B.vy + B.w * c.r2x - A.vy - A.w * c.r1x;
            var vn = dvx * nx + dvy * ny;
            var pen = c.sep + K.SLOP;
            c.pbias = pen < 0 ? -K.BIAS * invDt * pen : 0;
            c.pb = 0;
            // restituicao so em contato fresco e com o alvo no teto —
            // espelho do header (corpo leve preso entre pesado e estatico
            // ganhava (1+e) por ciclo e atravessava o chao)
            c.vbias = (vn < -K.BOUNCE_MIN && ar.e > 0 && c.pn === 0) ?
                      clampf(-ar.e * vn, 0, K.MAX_BOUNCE) : 0;
            if (vn < -K.BOUNCE_MIN) {
                var kf = A.invM + B.invM + A.invI * (c.r1x * c.r1x + c.r1y * c.r1y - rn1 * rn1) +
                         B.invI * (c.r2x * c.r2x + c.r2y * c.r2y - rn2 * rn2);
                var imp = kf > 0 ? -vn / kf : 0;
                if (imp > A.hit) A.hit = imp;
                if (imp > B.hit) B.hit = imp;
            }
            var Px = c.pn * nx + c.pt * tx, Py = c.pn * ny + c.pt * ty;
            A.vx -= imA * Px; A.vy -= imA * Py;
            A.w -= iiA * (c.r1x * Py - c.r1y * Px);
            B.vx += imB * Px; B.vy += imB * Py;
            B.w += iiB * (c.r2x * Py - c.r2y * Px);
        }
    }

    for (it = 0; it < w.iterations; it++) {
        for (k = 0; k < w.arb.length; k++) {
            ar = w.arb[k];
            A = w.bodies[ar.a]; B = w.bodies[ar.b];
            var imA2 = moving(A) ? A.invM : 0, iiA2 = moving(A) ? A.invI : 0;
            var imB2 = moving(B) ? B.invM : 0, iiB2 = moving(B) ? B.invI : 0;
            if (imA2 === 0 && imB2 === 0) continue;
            var nx2 = ar.nx, ny2 = ar.ny, tx2 = ny2, ty2 = -nx2;
            for (i = 0; i < ar.n; i++) {
                c = ar.c[i];
                var dvx2 = B.vx - B.w * c.r2y - A.vx + A.w * c.r1y;
                var dvy2 = B.vy + B.w * c.r2x - A.vy - A.w * c.r1x;
                var vn2 = dvx2 * nx2 + dvy2 * ny2;
                var dPn = c.mN * (-vn2 + c.vbias);
                var pn0 = c.pn;
                c.pn = pn0 + dPn > 0 ? pn0 + dPn : 0;
                dPn = c.pn - pn0;
                var Px2 = dPn * nx2, Py2 = dPn * ny2;
                A.vx -= imA2 * Px2; A.vy -= imA2 * Py2;
                A.w -= iiA2 * (c.r1x * Py2 - c.r1y * Px2);
                B.vx += imB2 * Px2; B.vy += imB2 * Py2;
                B.w += iiB2 * (c.r2x * Py2 - c.r2y * Px2);

                dvx2 = B.vx - B.w * c.r2y - A.vx + A.w * c.r1y;
                dvy2 = B.vy + B.w * c.r2x - A.vy - A.w * c.r1x;
                var vt = dvx2 * tx2 + dvy2 * ty2;
                var dPt = c.mT * (-vt);
                var maxPt = ar.mu * c.pn;
                var pt0 = c.pt;
                c.pt = clampf(pt0 + dPt, -maxPt, maxPt);
                dPt = c.pt - pt0;
                Px2 = dPt * tx2; Py2 = dPt * ty2;
                A.vx -= imA2 * Px2; A.vy -= imA2 * Py2;
                A.w -= iiA2 * (c.r1x * Py2 - c.r1y * Px2);
                B.vx += imB2 * Px2; B.vy += imB2 * Py2;
                B.w += iiB2 * (c.r2x * Py2 - c.r2y * Px2);
            }
        }
    }

    for (it = 0; it < w.iterations; it++) {
        for (k = 0; k < w.arb.length; k++) {
            ar = w.arb[k];
            A = w.bodies[ar.a]; B = w.bodies[ar.b];
            var imA3 = moving(A) ? A.invM : 0, iiA3 = moving(A) ? A.invI : 0;
            var imB3 = moving(B) ? B.invM : 0, iiB3 = moving(B) ? B.invI : 0;
            if (imA3 === 0 && imB3 === 0) continue;
            var nx3 = ar.nx, ny3 = ar.ny;
            for (i = 0; i < ar.n; i++) {
                c = ar.c[i];
                if (c.pbias <= 0 && c.pb <= 0) continue;
                var dvx3 = B.bvx - B.bw * c.r2y - A.bvx + A.bw * c.r1y;
                var dvy3 = B.bvy + B.bw * c.r2x - A.bvy - A.bw * c.r1x;
                var vn3 = dvx3 * nx3 + dvy3 * ny3;
                var d = c.mN * (-vn3 + c.pbias);
                var p0 = c.pb;
                c.pb = p0 + d > 0 ? p0 + d : 0;
                d = c.pb - p0;
                var Px3 = d * nx3, Py3 = d * ny3;
                A.bvx -= imA3 * Px3; A.bvy -= imA3 * Py3;
                A.bw -= iiA3 * (c.r1x * Py3 - c.r1y * Px3);
                B.bvx += imB3 * Px3; B.bvy += imB3 * Py3;
                B.bw += iiB3 * (c.r2x * Py3 - c.r2y * Px3);
            }
        }
    }

    for (i = 0; i < w.nBodies; i++) {
        b = w.bodies[i];
        if (!b.alive) continue;
        var bvx = b.bvx, bvy = b.bvy, bw = b.bw;
        b.bvx = b.bvy = b.bw = 0;
        if (!moving(b)) continue;
        b.x += (b.vx + bvx) * dt;
        b.y += (b.vy + bvy) * dt;
        b.a += (b.w + bw) * dt;
        if (speedOf(b) < K.SLEEP_LIN && absf(b.x - b.sx) < K.SLEEP_DRIFT &&
            absf(b.y - b.sy) < K.SLEEP_DRIFT && absf(b.a - b.sa) < K.SLEEP_TURN) {
            b.sleepT += dt;
            if (b.sleepT >= K.SLEEP_TIME) {
                b.awake = 0;
                b.vx = b.vy = b.w = 0;
            }
        } else {
            b.sleepT = 0;
            b.sx = b.x; b.sy = b.y; b.sa = b.a;
        }
    }
}

function step(w, dt, gx, gy, maxSub) {
    // dt denormal/NaN/<=0 descarta, maxSub NaN-safe e gravidade nao-finita
    // zera — espelho do header
    if (!(dt >= 1e-6)) return 0;
    if (!(maxSub >= 1)) maxSub = 1;
    if (maxSub > K.MAX_SUB) maxSub = K.MAX_SUB;
    if (!fin(gx)) gx = 0;
    if (!fin(gy)) gy = 0;
    var minHalf = 1e9, maxDisp = 0;
    for (var i = 0; i < w.nBodies; i++) {
        var b = w.bodies[i];
        if (!b.alive) continue;
        b.hit = 0;
        var h = b.hw < b.hh ? b.hw : b.hh;
        if (h < minHalf) minHalf = h;
        if (!moving(b)) continue;
        var sp = speedOf(b);
        if (sp * dt > maxDisp) maxDisp = sp * dt;
    }
    if (minHalf > 1e8) return 0;
    var sub = Math.ceil(dt / K.MAX_SUB_DT - 0.001);
    if (sub < 1) sub = 1;
    var lim = minHalf * 0.4;
    if (maxDisp > lim * sub) sub = Math.ceil(maxDisp / lim);
    if (sub > maxSub) sub = maxSub;
    var sdt = dt / sub;
    for (var s = 0; s < sub; s++) subStep(w, sdt, gx, gy);
    return sub;
}

function setBody(w, i, x, y, a, vx, vy, av) {
    if (i < 0 || i >= w.nBodies || !w.bodies[i].alive) return false;
    var b = w.bodies[i];
    // acordar quem encostava no ANTIGO lugar (espelho do header): pilha
    // dormida nao tem arbitro — a fase larga pula par todo dormindo —
    // entao o vizinho e achado por proximidade
    var ra = boundR(b);
    for (var k = 0; k < w.nBodies; k++) {
        var o = w.bodies[k];
        if (k === i || !o.alive || o.invM <= 0) continue;
        var rb = ra + boundR(o);
        var dx = o.x - b.x, dy = o.y - b.y;
        if (dx * dx + dy * dy <= rb * rb) { o.awake = 1; o.sleepT = 0; }
    }
    b.x = x; b.y = y; b.a = a;
    b.vx = vx; b.vy = vy; b.w = av;
    b.awake = 1; b.sleepT = 0;
    dropArbOf(w, i);
    return true;
}

function impulse(w, i, jx, jy) {
    if (i < 0 || i >= w.nBodies || !w.bodies[i].alive) return false;
    var b = w.bodies[i];
    if (b.invM <= 0) return false;
    b.vx += jx * b.invM;
    b.vy += jy * b.invM;
    b.awake = 1; b.sleepT = 0;
    return true;
}

// System.rigid* sobre o espelho: mesma assinatura e defaults do binding
// (JsRigid.cpp). Dois mundos, como no firmware.
function makeStub() {
    var worlds = [null, null];
    function at(id) { return id >= 1 && id <= 2 ? worlds[id - 1] : null; }
    function num(v, d) { return typeof v === 'number' ? v : d; }
    return {
        rigidNew: function (iterations) {
            for (var i = 0; i < 2; i++) {
                if (!worlds[i]) { worlds[i] = new World(num(iterations, 10) | 0); return i + 1; }
            }
            return -1;
        },
        rigidFree: function (id) { if (at(id)) worlds[id - 1] = null; },
        rigidBox: function (id, x, y, bw, bh, a, density, mu, e) {
            var w = at(id);
            if (!w) return -1;
            return addBody(w, BOX, x, y, bw * 0.5, bh * 0.5, num(a, 0), num(density, 1),
                           num(mu, 0.6), num(e, 0.1));
        },
        rigidCircle: function (id, x, y, r, density, mu, e) {
            var w = at(id);
            if (!w) return -1;
            return addBody(w, CIRCLE, x, y, r, r, 0, num(density, 1), num(mu, 0.6), num(e, 0.1));
        },
        rigidRemove: function (id, i) { var w = at(id); return !!(w && removeBody(w, i)); },
        rigidSet: function (id, i, x, y, a, vx, vy, av) {
            var w = at(id);
            return !!(w && setBody(w, i, x, y, num(a, 0), num(vx, 0), num(vy, 0), num(av, 0)));
        },
        rigidImpulse: function (id, i, jx, jy) { var w = at(id); return !!(w && impulse(w, i, jx, jy)); },
        rigidStep: function (id, dt, gx, gy, maxSub) {
            var w = at(id);
            if (!w) return 0;
            if (dt > 0.1) dt = 0.1;
            return step(w, dt, num(gx, 0), num(gy, 0), num(maxSub, 12) | 0);
        },
        // buf opcional (espelho do JsRigid.cpp): preenche no lugar, ajusta o
        // length e devolve o mesmo array
        rigidState: function (id, buf) {
            var w = at(id), out = Object.prototype.toString.call(buf) === '[object Array]' ? buf : [];
            var k = 0;
            for (var i = 0; w && i < w.nBodies; i++) {
                var b = w.bodies[i];
                out[k++] = b.x; out[k++] = b.y; out[k++] = b.a; out[k++] = b.hit;
                out[k++] = b.alive ? speedOf(b) : 0;
                out[k++] = (b.alive ? 1 : 0) | (b.alive && b.awake && b.invM > 0 ? 2 : 0);
            }
            out.length = k;
            return out;
        },
        rigidCount: function (id) { var w = at(id); return w ? w.nBodies : 0; }
    };
}

module.exports = { K: K, World: World, addBody: addBody, removeBody: removeBody,
                   step: step, setBody: setBody, impulse: impulse, makeStub: makeStub,
                   arbOk: arbOk, subStep: subStep, BOX: BOX, CIRCLE: CIRCLE };
