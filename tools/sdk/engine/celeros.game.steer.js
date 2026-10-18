// game.steer.js — CelerGame STEER (dep "celeros.game.steer"): movimento
// autonomo por forcas (steering behaviors de Reynolds) — perseguir, fugir,
// chegar freando, vagar, desviar dos vizinhos e bando (boids). Para IA em
// espaco ABERTO (nave, peixe, morcego); em labirinto use celeros.game.path
// e passe o proximo ponto do caminho ao seek/arrive. Decora o core:
//
//   var E = require("celeros.game");
//   require("celeros.game.steer");
//   var a = E.steer.agent(morcego, { speed: 70, force: 160 });
//   // update do morcego:
//   a.arrive(heroi.x, heroi.y, 40);          // freia nos ultimos 40 px
//   a.separate(morcegos.items, 18, 1.5);     // nao embola com os outros
//   a.within({ x: 0, y: 0, w: 240, h: 320 }, 20);
//   a.update(dt);                            // integra e move o obj
//
// Cada comportamento SOMA uma forca ponderada (w, default 1) no quadro; o
// update limita a forca a `force` px/s2, a velocidade a `speed` px/s, move
// obj.x/y e zera o acumulador. obj ganha vx/vy (e a.heading em radianos).
// Zero alocacao por quadro.

var E = require('celeros.game');

function len(x, y) { return Math.sqrt(x * x + y * y); }

E.steer = {
    version: '1.0.0',

    agent: function (obj, o) {
        o = o || {};
        if (obj.vx === undefined) obj.vx = 0;
        if (obj.vy === undefined) obj.vy = 0;
        var a = {
            obj: obj,
            speed: o.speed || 60,       // px/s maximo
            force: o.force || (o.speed || 60) * 3,   // px/s2 maximo (default 3x speed)
            // resposta: aceleracao = (velocidade desejada - atual) x agility
            // (4 = corrige ~63% da diferenca em 0,25 s), limitada a force
            agility: o.agility || 4,
            fx: 0, fy: 0,               // acumulador do quadro
            heading: 0,
            _wa: Math.random() * Math.PI * 2   // angulo do wander
        };
        // forca para atingir a velocidade desejada (dx, dy) normalizada
        function want(dx, dy, sp, w) {
            var d = len(dx, dy);
            if (d === 0) return;
            a.fx += (dx / d * sp - obj.vx) * w;
            a.fy += (dy / d * sp - obj.vy) * w;
        }
        a.seek = function (x, y, w) {
            want(x - obj.x, y - obj.y, a.speed, w === undefined ? 1 : w);
            return a;
        };
        // foge de (x, y); com radius so reage dentro do raio
        a.flee = function (x, y, w, radius) {
            var dx = obj.x - x, dy = obj.y - y;
            if (radius > 0 && dx * dx + dy * dy > radius * radius) return a;
            want(dx, dy, a.speed, w === undefined ? 1 : w);
            return a;
        };
        // chega freando dentro de slow px (para em cima do alvo)
        a.arrive = function (x, y, slow, w) {
            var dx = x - obj.x, dy = y - obj.y, d = len(dx, dy);
            var ww = w === undefined ? 1 : w;
            var sr = slow > 0 ? slow : 32;
            if (d < 0.5) {
                a.fx -= obj.vx * ww;
                a.fy -= obj.vy * ww;
                return a;
            }
            want(dx, dy, d < sr ? a.speed * d / sr : a.speed, ww);
            return a;
        };
        // mira onde o alvo VAI estar (t = {x, y, vx, vy})
        a.pursue = function (t, w) {
            var d = len(t.x - obj.x, t.y - obj.y);
            var k = a.speed > 0 ? Math.min(d / a.speed, 2) : 0;
            return a.seek(t.x + (t.vx || 0) * k, t.y + (t.vy || 0) * k, w);
        };
        a.evade = function (t, w, radius) {
            var d = len(t.x - obj.x, t.y - obj.y);
            var k = a.speed > 0 ? Math.min(d / a.speed, 2) : 0;
            return a.flee(t.x + (t.vx || 0) * k, t.y + (t.vy || 0) * k, w, radius);
        };
        // vaga sem rumo, suave: circulo a frente com um ponto que treme
        // (o = {dist, r, jitter rad/quadro}); rnd opcional (E.rng)
        a.wander = function (w, wo) {
            wo = wo || {};
            var rnd = wo.rnd || Math.random;
            a._wa += (rnd() * 2 - 1) * (wo.jitter === undefined ? 0.5 : wo.jitter);
            var h = len(obj.vx, obj.vy) > 0.01 ? Math.atan2(obj.vy, obj.vx) : a.heading;
            var dist = wo.dist === undefined ? 24 : wo.dist, r = wo.r === undefined ? 12 : wo.r;
            var tx = obj.x + Math.cos(h) * dist + Math.cos(a._wa) * r;
            var ty = obj.y + Math.sin(h) * dist + Math.sin(a._wa) * r;
            return a.seek(tx, ty, w === undefined ? 0.5 : w);
        };
        // afasta dos vizinhos ({x, y}) mais perto que radius (mais forte
        // quanto mais perto); list pode conter o proprio obj
        a.separate = function (list, radius, w) {
            var sx = 0, sy = 0, n = 0, rr = radius * radius;
            for (var i = 0; i < list.length; i++) {
                var q = list[i];
                if (q === obj || q.dead) continue;
                var dx = obj.x - q.x, dy = obj.y - q.y, d2 = dx * dx + dy * dy;
                if (d2 >= rr) continue;
                if (d2 < 1e-6) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.01; }
                sx += dx / d2;
                sy += dy / d2;
                n++;
            }
            if (n) want(sx, sy, a.speed, w === undefined ? 1 : w);
            return a;
        };
        // alinha a velocidade com os vizinhos (bando)
        a.align = function (list, radius, w) {
            var vx = 0, vy = 0, n = 0, rr = radius * radius;
            for (var i = 0; i < list.length; i++) {
                var q = list[i];
                if (q === obj || q.dead) continue;
                var dx = obj.x - q.x, dy = obj.y - q.y;
                if (dx * dx + dy * dy >= rr) continue;
                vx += q.vx || 0;
                vy += q.vy || 0;
                n++;
            }
            if (n) want(vx, vy, a.speed, w === undefined ? 1 : w);
            return a;
        };
        // vai para o centro dos vizinhos (bando)
        a.cohere = function (list, radius, w) {
            var cx = 0, cy = 0, n = 0, rr = radius * radius;
            for (var i = 0; i < list.length; i++) {
                var q = list[i];
                if (q === obj || q.dead) continue;
                var dx = obj.x - q.x, dy = obj.y - q.y;
                if (dx * dx + dy * dy >= rr) continue;
                cx += q.x;
                cy += q.y;
                n++;
            }
            if (n) a.seek(cx / n, cy / n, w);
            return a;
        };
        // volta para dentro do rect quando chega a margin px da borda
        a.within = function (rect, margin, w) {
            var m = margin === undefined ? 16 : margin, dx = 0, dy = 0;
            if (obj.x < rect.x + m) dx = 1;
            else if (obj.x > rect.x + rect.w - m) dx = -1;
            if (obj.y < rect.y + m) dy = 1;
            else if (obj.y > rect.y + rect.h - m) dy = -1;
            if (dx || dy) want(dx, dy, a.speed, w === undefined ? 2 : w);
            return a;
        };
        // integra: forca limitada -> velocidade limitada -> posicao
        a.update = function (dt) {
            var ax = a.fx * a.agility, ay = a.fy * a.agility;
            var f = len(ax, ay), fmax = a.force;
            if (f > fmax) { ax = ax / f * fmax; ay = ay / f * fmax; }
            obj.vx += ax * dt;
            obj.vy += ay * dt;
            var v = len(obj.vx, obj.vy);
            if (v > a.speed) { obj.vx = obj.vx / v * a.speed; obj.vy = obj.vy / v * a.speed; v = a.speed; }
            obj.x += obj.vx * dt;
            obj.y += obj.vy * dt;
            if (v > 0.5) a.heading = Math.atan2(obj.vy, obj.vx);
            a.fx = 0;
            a.fy = 0;
            return a;
        };
        // freia ate parar (sem forcas): vx/vy zeram e o acumulador limpa
        a.stop = function () {
            obj.vx = 0;
            obj.vy = 0;
            a.fx = 0;
            a.fy = 0;
            return a;
        };
        return a;
    }
};

E._mods.push('steer');

module.exports = E;
