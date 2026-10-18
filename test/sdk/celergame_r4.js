// Testes da rodada 4 da CelerGame (a do clone de aventura "Lenda de
// Celer"): modulos combat e world, core 1.4 (freeze, save.slot), spr 1.4
// (stamp, anim.dir), ui 1.2 (dialog com paginas/next/realtime), fx 1.4
// (presets de aventura + dir), stats 1.1 (dir/blink), sfx 1.4. Plugado no
// test/sdk/run.js:  require('./celergame_r4.js')(check);

'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..', '..');
var ENGINE_DIR = path.join(ROOT, 'tools', 'sdk', 'engine');

module.exports = function (check) {
    var harness = require('../js_harness/run.js');

    function fresh(mods, initOpts, setup) {
        var env = harness.makeEnv();
        if (setup) setup(env);
        var req = harness.makeRequire(ENGINE_DIR, env);
        var E = req('celeros.game');
        (mods || []).forEach(function (m) { req(m.indexOf('.') >= 0 ? m : 'celeros.game.' + m); });
        E.init(initOpts || {});
        return { E: E, env: env, S: env.System, H: env.__harness, req: req };
    }
    function runScenes(c, scenes, first, maxMs) {
        var t0 = c.S.millis();
        for (var k in scenes) {
            (function (sc) {
                var up = sc.update;
                sc.update = function (dt) {
                    if (up) up.call(sc, dt);
                    if (c.S.millis() - t0 > (maxMs || 5000)) c.E.quit();
                };
            })(scenes[k]);
        }
        c.E.run(scenes, first);
    }
    function frames(c, n, onFrame) {
        var q = 0;
        runScenes(c, { s: { update: function (dt) { if (onFrame) onFrame(q, dt); if (++q >= n) c.E.quit(); } } }, 's',
                  n * 60 + 2000);
    }
    function near(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }

    console.log('SDK CelerGame rodada 4 (combat/world + core 1.4 + spr/ui/fx/stats/sfx):');

    // ------------------------------------------------------- core 1.4 --
    var c = fresh([]);
    var dts = [];
    var t0 = c.S.millis();
    frames(c, 12, function (q, dt) {
        if (q === 2) c.E.freeze(120);
        dts.push([c.S.millis() - t0, dt]);
    });
    var zerados = dts.filter(function (d) { return d[1] === 0; }).length;
    check('core: E.freeze(ms) zera o dt por ~ms e volta sozinho',
          zerados >= 2 && dts[dts.length - 1][1] > 0 && !c.E.frozen(), JSON.stringify(dts.slice(0, 8)));
    // tap com quadro LENTO no meio: press amostrado em t0, dedo ainda no
    // vidro 10 ms depois, e o quadro seguinte (que le a soltura) so chega
    // 600 ms mais tarde — o toque foi curto, e tap (antes sumia)
    (function () {
        var ct = fresh([]);
        var seq = [[{ id: 1, x: 50, y: 60 }], [{ id: 1, x: 50, y: 60 }], []], q = 0;
        ct.S.getTouches = function () { return seq[q++] || []; };
        ct.E.caps.multi = true;
        ct.E._pollInput(1000);
        ct.E._pollInput(1010);
        ct.E._pollInput(1610);
        check('core 1.4.2: tap curto sobrevive a um quadro lento antes da soltura',
              !!ct.E.input.tap && ct.E.input.tap.x === 50, JSON.stringify(ct.E.input.tap));
        // segurar de verdade (dedo no vidro 600 ms) continua NAO sendo tap
        seq = [[{ id: 2, x: 5, y: 6 }], [{ id: 2, x: 5, y: 6 }], []]; q = 0;
        ct.E._pollInput(3000);
        ct.E._pollInput(3600);
        ct.E._pollInput(3610);
        check('core 1.4.2: dedo parado 600 ms nao vira tap', !ct.E.input.tap);
    })();

    // path.flow: o BFS do custo uniforme e o heap do custo variado dao a
    // MESMA distancia que um Dijkstra de referencia (O(n^2), sem heap)
    (function () {
        var cp = fresh(['path']);
        function refDist(cols, rows, c1, r1, cost) {
            var n = cols * rows, d = [], done = [], i;
            for (i = 0; i < n; i++) { d.push(-1); done.push(false); }
            d[r1 * cols + c1] = 0;
            for (;;) {
                var k = -1;
                for (i = 0; i < n; i++) if (!done[i] && d[i] >= 0 && (k < 0 || d[i] < d[k])) k = i;
                if (k < 0) break;
                done[k] = true;
                var c = k % cols, r = (k - c) / cols, wk = cost(c, r);
                if (!(wk >= 0)) wk = 1;
                var nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
                for (var q = 0; q < 4; q++) {
                    var nc = c + nb[q][0], nr = r + nb[q][1];
                    if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || !(cost(nc, nr) >= 0)) continue;
                    var nk = nr * cols + nc, nv = d[k] + wk;
                    if (d[nk] < 0 || nv < d[nk]) d[nk] = nv;
                }
            }
            return d;
        }
        var R = cp.E.rng(7), ruins = 0;
        for (var t = 0; t < 12; t++) {
            var cols = 15, rows = 13, grid = [];
            for (var i = 0; i < cols * rows; i++) grid.push(R() < 0.3 ? -1 : (t % 2 ? 1 + R.int(0, 3) : 1));
            var cost = function (c, r) { return grid[r * cols + c]; };
            var c1 = R.int(0, cols - 1), r1 = R.int(0, rows - 1);
            var f = cp.E.path.flow(cols, rows, c1, r1, cost), ref = refDist(cols, rows, c1, r1, cost);
            for (var k = 0; k < cols * rows; k++) {
                if (Math.abs(f.dist(k % cols, (k - k % cols) / cols) - ref[k]) > 1e-9) { ruins++; break; }
            }
        }
        check('path.flow: BFS (custo uniforme) e heap (custo variado) = Dijkstra de referencia', ruins === 0,
              ruins + ' grades divergiram');
    })();

    // audio: firmware aceita o playMusic mas o canal I2S nao abre (RAM
    // interna sem DMA) — o restart nao pode virar um playMusic por quadro
    var pedidos = 0;
    c = fresh([], {}, function (env) {
        env.System.playMusic = function () { pedidos++; return true; };
        env.System.musicPlaying = function () { return false; };
    });
    c.E.caps.music = true;
    c.E.audio.music({ bpm: 120, tracks: [{ notes: [[60, 16]] }] });
    frames(c, 60, function () { c.E.audio._tick(); });
    check('audio: trilha que morre logo apos o playMusic entra no backoff (sem restart por quadro)',
          pedidos >= 1 && pedidos <= 3, 'playMusic x' + pedidos);
    c = fresh([], { save: 'r4.' });
    c.E.save.set('opcao', 'global');
    c.E.save.slot(2);
    c.E.save.set('vida', 7);
    var noSlot2 = c.E.save.num('vida', 0);
    c.E.save.slot(1);
    var noSlot1 = c.E.save.num('vida', 0);
    c.E.save.slot(0);
    check('core: save.slot separa arquivos de jogo e slot(0) volta ao base',
          noSlot2 === 7 && noSlot1 === 0 && c.E.save.get('opcao') === 'global' && c.E.save.slot() === 0);

    // ------------------------------------------------- multitoque 1.4 --
    c = fresh(['pad']);
    function T() { return { touches: Array.prototype.slice.call(arguments) }; }
    function d(id, x, y) { return { id: id, x: x, y: y }; }
    c.H.pushTouch([
        T(),
        T(d(3, 60, 250)),                         // stick pega o dedo 3
        T(d(3, 90, 250), d(7, 200, 280)),         // segura o stick e aperta A
        T(d(3, 100, 250), d(7, 200, 280)),
        T(d(7, 200, 280)),                        // solta o stick, A segue
        T(d(7, 200, 280)),                        // primario trocou: solto+novo
        T(),
        T(d(1, 50, 250)), T()                     // tap seco no stick
    ]);
    var stM = c.E.pad.stick({ zone: { x: 0, y: 160, w: 120, h: 160 }, r: 40 });
    var aM = c.E.pad.button({ x: 200, y: 280, r: 24, label: 'A' });
    var regM = [], fm = 0;
    runScenes(c, { s: { update: function () {
        regM.push({ n: c.E.input.touches.length, sx: +stM.x.toFixed(2), sf: stM.finger, a: aM.down,
                    ap: aM.pressed, af: aM.finger, tap: stM.tap, j: c.E.input.justDown, u: c.E.input.justUp,
                    sw: !!c.E.input.swipe });
        if (++fm >= 10) c.E.quit();
    } } }, 's');
    check('core multi: E.input.touches rastreia dedos por id (justDown/justUp/down)',
          c.E.caps.multi && regM[2].n === 2 && regM[4].n === 2 && regM[6].n === 1 && regM[9].n === 0,
          JSON.stringify(regM.map(function (r) { return r.n; })));
    check('pad multi: stick e botao A juntos, cada um no seu dedo',
          regM[2].sx > 0.3 && regM[2].sf === 3 && regM[2].a === true && regM[2].ap === true &&
          regM[2].af === 7 && regM[3].a === true && regM[3].ap === false,
          JSON.stringify(regM.slice(1, 5)));
    check('pad multi: soltar o stick nao solta o A; levantar o A solta',
          regM[4].sf === null && regM[4].sx === 0 && regM[4].a === true && regM[6].a === false);
    check('core multi: primario que troca de dedo vira soltura + toque novo (sem swipe falso)',
          // o dedo 3 arrastou de verdade (swipe legitimo no 4); o A nao
          // vira swipe quando assume como primario (pulo de 100 -> 200)
          regM[4].u === true && regM[5].j === true && regM[4].sw === true && regM[6].sw === false,
          JSON.stringify(regM.map(function (r) { return [r.j, r.u]; })));
    check('pad multi: tap seco no stick segue sendo a acao', regM.some(function (r) { return r.tap; }),
          JSON.stringify(regM.map(function (r) { return r.tap; })));

    // -------------------------------------------------------- stats 1.1
    c = fresh(['stats']);
    var dirVisto = null;
    var st = c.E.stats({ hp: 5 }, { iframes: 200, onHit: function (s, n, src, d) { dirVisto = d; } });
    st.damage(1, { dir: { x: 1, y: 0 } });
    var piscou = false;
    frames(c, 6, function () { if (st.blink(30)) piscou = true; });
    check('stats: damage {dir} chega no onHit; blink pisca nos iframes; hpMax/full',
          dirVisto && dirVisto.x === 1 && st.lastDir.x === 1 && piscou && st.hpMax() === 5 && !st.full());

    // ---------------------------------------------------------- combat --
    c = fresh(['combat', 'stats', 'events']);
    c.E.combat.hitstop = 0;
    var heroi = { x: 100, y: 100, w: 16, h: 16, vx: 0, vy: 0 };
    var polvo = { x: 120, y: 100, w: 16, h: 16, vx: 0, vy: 0 };
    var amigo = { x: 100, y: 120, w: 16, h: 16 };
    heroi.st = c.E.stats({ hp: 3 }, { iframes: 500 });
    polvo.st = c.E.stats({ hp: 2 });
    var mortos = [], hitsEv = 0;
    c.E.on('hit', function () { hitsEv++; });
    c.E.combat.body(heroi, { team: 'heroi', stats: heroi.st });
    c.E.combat.body(amigo, { team: 'heroi', iframes: 0 });
    amigo.hp = 3;
    c.E.combat.body(polvo, { team: 'monstro', stats: polvo.st,
                             onKill: function (e) { mortos.push(e); e.dead = true; } });
    c.E.combat.sword(heroi, 'right', { reach: 20, width: 16, dmg: 1, knock: 200 });
    frames(c, 3);
    var hpDepoisGolpe = polvo.st.hp, empurrado = polvo._kx > 0;
    check('combat: espada fere o outro time 1x por golpe (once) com knockback na direcao',
          hpDepoisGolpe === 1 && empurrado && amigo.hp === 3 && hitsEv === 1,
          'hp=' + hpDepoisGolpe + ' kx=' + polvo._kx);
    var px0 = polvo.x;
    c.E.combat.move(polvo, 0.05, null);
    check('combat.move aplica o knockback (decai sozinho)', polvo.x > px0 && c.E.combat.knocked(polvo));
    c.E.combat.sword(heroi, 'right', { reach: 60, width: 30, dmg: 5 });
    frames(c, 2);
    check('combat: golpe que mata chama onKill uma vez e o corpo sai',
          mortos.length === 1 && c.E.combat.team('monstro').length === 0);
    // projetil inimigo: iframes do heroi seguram o 2o tiro; parede some com o tiro
    var mapa = { solidAt: function (x) { return x > 200; } };
    var paredes = 0;
    c.E.combat.shot(null, { x: 60, y: 108, vx: 400, vy: 0, r: 4, team: 'monstro', dmg: 1 });
    c.E.combat.shot(null, { x: 40, y: 108, vx: 400, vy: 0, r: 4, team: 'monstro', dmg: 1 });
    c.E.combat.shot(null, { x: 150, y: 40, vx: 400, vy: 0, r: 4, team: 'monstro', map: mapa,
                            onWall: function () { paredes++; } });
    frames(c, 12);
    check('combat: tiros ferem o heroi respeitando os iframes; parede apaga o tiro',
          heroi.st.hp === 2 && paredes === 1 && c.E.combat.count().shots === 0, 'hp=' + heroi.st.hp);
    // bumerangue: vai ate range e volta ao dono atravessando alvos
    var b1 = { x: 200, y: 300, w: 16, h: 16 }, b2 = { x: 260, y: 300, w: 16, h: 16 };
    b1.hp = 9; b2.hp = 9;
    c.E.combat.body(b1, { team: 'monstro', iframes: 0 });
    c.E.combat.body(b2, { team: 'monstro', iframes: 0 });
    var dono = { x: 150, y: 300, w: 16, h: 16 };
    var voltou = 0, maxDist = 0;
    var bm = c.E.combat.shot(dono, { x: 158, y: 308, vx: 1, vy: 0, r: 6, team: 'heroi', dmg: 1,
                                     boomerang: { range: 140, speed: 300 }, stun: 300,
                                     onBack: function () { voltou++; } });
    frames(c, 40, function () { if (bm.dist > maxDist) maxDist = bm.dist; });
    check('combat: bumerangue atravessa alvos, atordoa, volta ao dono e some',
          voltou === 1 && b1.hp <= 8 && b2.hp <= 8 && bm.dead, 'voltou=' + voltou + ' hp=' + b1.hp + '/' + b2.hp);
    // explosao fere todos os times, inclusive o heroi (iframes vencidos)
    heroi.st.lastHit = -1e9;
    var hp0 = heroi.st.hp;
    c.E.combat.blast(108, 108, 30, { dmg: 1 });
    frames(c, 2);
    check('combat.blast: fere todo time no raio (heroi inclusive)', heroi.st.hp === hp0 - 1);
    // hitstop: golpe que acerta congela o jogo
    c = fresh(['combat']);
    var alvo = { x: 30, y: 0, w: 10, h: 10, hp: 3 };
    c.E.combat.body(alvo, { team: 'b' });
    c.E.combat.hit({ x: 0, y: 0 }, { x: 25, y: 0, w: 20, h: 10 }, { team: 'a' });
    var congelou = false;
    frames(c, 4, function () { if (c.E.frozen()) congelou = true; });
    check('combat: acerto dispara o hitstop (E.freeze)', congelou && alvo.hp === 2);

    // ----------------------------------------------------------- world --
    function sala(fill, extra) {
        var L = [];
        for (var r = 0; r < 5; r++) {
            var row = '';
            for (var cc = 0; cc < 7; cc++) {
                var borda = r === 0 || r === 4 || cc === 0 || cc === 6;
                var porta = (r === 2 && (cc === 0 || cc === 6)) || (cc === 3 && (r === 0 || r === 4));
                row += borda && !porta ? '#' : fill;
            }
            L.push(row);
        }
        if (extra) L[2] = extra;
        return L;
    }
    c = fresh(['world', 'spr'], { save: 'r4w.' });
    var pintadas = 0, entrou = [];
    var areas = { campo: { w: 2, h: 1, rooms: {
        '0,0': { lines: sala('.', '..~.@..'), meta: { nome: 'inicio' } },
        '1,0': sala('.', '...B...')
    } } };
    var W = c.E.world({
        cols: 7, rows: 5, cell: 16, ox: 0, oy: 32, areas: areas,
        legend: { '#': 'parede', '.': 'chao', '~': 'agua', '@': { spawn: 'heroi', tile: 'chao' },
                  'B': { spawn: 'bau', tile: 'chao' } },
        paint: function () { pintadas++; },
        solid: function (v) { return v === 'parede' || v === 'agua'; },
        anim: { ms: 100, frames: { agua: ['agua', 'agua2'] } },
        save: 'mundo', onEnter: function (r) { entrou.push(r.id); }
    });
    W.go('campo', 0, 0);
    check('world.go: sala parseada, gravada no sprite (bake) e onEnter',
          W.room.id === 'campo:0,0' && W.baked && pintadas === 35 && entrou.join() === 'campo:0,0' &&
          W.room.meta.nome === 'inicio' && W.visited['campo:0,0'], 'pintadas=' + pintadas);
    check('world: colisao em pixels de tela (parede, agua, porta aberta, fora)',
          W.solidAt(1, 33) && W.solidAt(16 * 2 + 1, 32 + 16 * 2 + 1) && !W.solidAt(1, 32 + 16 * 2 + 4) &&
          W.rectSolid(16, 48, 8, 8) === false && W.solidAt(-5, 40) && W.cost(2, 2) === -1);
    var ent = { x: 16 * 7 - 2, y: 32 + 16 * 2, w: 8, h: 8 };   // centro ja fora pela direita
    var lado = W.edge(ent);
    var foi = W.move(lado);
    var sl = W.sliding, sh = W.slideShift().x;
    var quadros = 0;
    frames(c, 60, function () { quadros++; if (!W.sliding && quadros > 2) c.E.quit(); });
    W.wrapEnt(ent, lado);
    check('world.move: desliza para a vizinha (sliding, shift > 0) e entra no fim',
          lado === 'right' && foi && sl && sh > 0 && !W.sliding && W.room.id === 'campo:1,0' &&
          entrou.join() === 'campo:0,0,campo:1,0' && ent.x < 16 && W.move('up') === false,
          lado + ' ' + entrou.join());
    var sp = W.spawns();
    W.take(sp[0]);
    W.set(3, 2, 'bau_aberto', true);
    W.go('campo', 0, 0);
    W.go('campo', 1, 0);
    check('world: take e set persistente sobrevivem a sair e voltar da sala',
          sp.length === 1 && sp[0].type === 'bau' && W.spawns().length === 0 && W.get(3, 2) === 'bau_aberto');
    var W2 = c.E.world({ cols: 7, rows: 5, cell: 16, areas: areas, legend: { '#': 1, '.': 0, '~': 2,
                         '@': { spawn: 'h', tile: 0 }, 'B': { spawn: 'b', tile: 0 } },
                         paint: function () {}, save: 'mundo' });
    var tinha = W2.restore();
    W2.go('campo', 1, 0);
    check('world: flags/visitas no E.save (restore em outro mundo ve a mesma sala mexida)',
          tinha && W2.visited['campo:1,0'] && W2.get(3, 2) === 'bau_aberto' && W2.spawns().length === 0);
    // 1.0.1: mundo sem sala corrente (criado, ainda sem go/restore — o app
    // recria o mundo no meio da cena) responde "fora" na colisao em vez de
    // ler data de null e derrubar o app no primeiro update
    var W3 = c.E.world({ cols: 7, rows: 5, cell: 16, areas: areas,
                         legend: { '#': 1, '.': 0, '~': 2 }, paint: function () {} });
    c.req('celeros.game.collide');
    var semSala = true;
    try {
        semSala = W3.room === null && W3.solidAt(10, 40) === true &&
                  W3.rectSolid(0, 32, 8, 8) === true && W3.cost(1, 1) === -1 &&
                  c.E.collide.move({ x: 10, y: 40, w: 8, h: 8, vx: 0, vy: 0 }, 4, 0, W3) !== null;
    } catch (e) { semSala = false; }
    check('world 1.0.1: solidAt/rectSolid/move sem sala (mundo trocado em voo) nao quebram', semSala);
    W3.free();
    // agua animada: o tick troca o quadro e a celula repinta no draw
    W.go('campo', 0, 0);
    var antes = pintadas;
    var vistos = [];
    W.paint = null;
    runScenes(c, { s: { draw: function () { W.draw(); }, update: function () { if (c.S.millis() > 0) vistos.push(pintadas); } } },
              's', 350);
    check('world: celula animada (agua) repinta sozinha no draw', pintadas > antes);
    // W.fechado: a borda da sala e parede (monstro nao sai pela abertura)
    W.outside = false;   // como a Lenda: o heroi atravessa a borda
    var livreW = !W.rectSolid(-4, 32 + 16 * 2 + 2, 8, 8);
    W.outside = true;
    check('world.fechado: a abertura da borda e livre no W (outside false) e solida no fechado',
          livreW && W.fechado.rectSolid(-4, 32 + 16 * 2 + 2, 8, 8) &&
          W.fechado.solidAt(-1, 40) && !W.fechado.solidAt(16 * 3 + 2, 32 + 16 * 2 + 2));
    var mm = W.minimap(0, 0, { size: 6 });
    check('world.minimap mede a area (2 salas) e W.find acha valores', mm.w === 13 && mm.h === 6 &&
          W.find('agua').length === 1);
    var erroSala = null;
    try {
        c.E.world({ cols: 7, rows: 5, areas: { x: { w: 1, h: 1, rooms: { '0,0': ['###'] } } },
                    legend: { '#': 1 }, paint: function () {} }).go('x', 0, 0);
    } catch (e) { erroSala = String(e); }
    check('world: sala do tamanho errado falha com o id e o tamanho', /x:0,0 tem 3x1/.test(erroSala || ''), erroSala);

    // ------------------------------------------------------- spr 1.4 ---
    c = fresh(['spr']);
    var chamadas = [];
    c.S.drawSprite = function (id, x, y, a, zx, zy, key) { chamadas.push([id, x, y, zx, key]); };
    c.S.setClip = function (x, y, w, h) { chamadas.push(['clip', x, y, w, h]); };
    c.S.drawPNG = function () { return true; };   // folha "carregou" no slot
    c.E.spr.bases = ['/local/apps/x/'];
    c.E.spr.grid('folha', { file: 'x', cols: 4, rows: 2, tw: 32, th: 32, paint: function () {} });
    var ok = c.E.spr.stamp('folha5', 100, 50, { scale: 0.5, key: null });
    var clip = chamadas[0], ds = chamadas[1];
    check('spr.stamp: regiao da folha recortada no alvo, com escala e opaco (key null)',
          ok && clip[0] === 'clip' && clip[1] === 100 && clip[3] === 16 &&
          near(ds[1], 100 + (64 - 32) * 0.5) && near(ds[2], 50 + (32 - 32) * 0.5) && ds[3] === 0.5 &&
          ds[4] === undefined, JSON.stringify(chamadas));
    var ad = c.E.anim.dir({ down: ['d0', 'd1'], up: ['u0', 'u1'], right: ['r0', 'r1'] }, 10);
    ad.tick(0.15);
    ad.face('up');
    var iUp = ad.i, fUp = ad.frames[0];
    ad.walk(false);
    ad.tick(0.5);
    check('anim.dir: face troca o clipe sem zerar o passo; walk(false) para no quadro 0',
          fUp === 'u0' && iUp === 1 && ad.i === 0 && ad.facing === 'up' && ad.face('left').frames[0] === 'd0');

    // -------------------------------------------------------- ui 1.2 ---
    c = fresh(['ui']);
    var dl = c.E.ui.dialog(['Primeira pagina', 'Segunda'], { tap: false });
    dl.next();                 // completa
    var p0 = dl.page;
    dl.next();                 // avanca
    var p1 = dl.page, txt = dl.text;
    dl.next(); dl.next();      // completa e fecha
    check('ui.dialog: paginas e next() (completa, avanca, fecha)',
          p0 === 0 && p1 === 1 && txt === 'Segunda' && dl.closed);
    var dr = c.E.ui.dialog('abc', { realtime: true, speed: 10 });
    c.E.pause(true);
    var fechou = false;
    runScenes(c, { s: { draw: function () { dr.draw(0, 0, 200); }, update: function () { if (dr.done) { fechou = true; c.E.quit(); } } } },
              's', 1200);
    check('ui.dialog {realtime}: o texto anda com o jogo pausado', fechou);

    // ----------------------------------------------------- fx/sfx 1.4 --
    c = fresh(['fx']);
    var ang = [];
    var b0 = c.E.fx.burst;
    c.E.fx.burst = function (x, y, o) { ang.push(o.angle); return b0.call(c.E.fx, x, y, o); };
    var okc = c.E.fx.play('corte', 10, 10, { dir: 1.5 });
    check('fx: presets corte/poof/brilho/pedrinha; play {dir} aponta a receita',
          okc && ang[0] === 1.5 && ['poof', 'brilho', 'pedrinha'].every(function (n) { return !!c.E.fx.presets[n]; }));
    var SFX = require(path.join(ENGINE_DIR, 'celeros.sfx.js'));
    check('sfx 1.4: sons de aventura na tabela',
          ['espada', 'porta', 'segredo', 'item', 'chave', 'bumerangue', 'queda', 'escada', 'cristal']
              .every(function (n) { return !!SFX.mel(n); }));

    // ---------------------------------------------------- gates d.ts ---
    c = fresh(['combat', 'world', 'stats']);
    function dtsOf(n) { return fs.readFileSync(path.join(ENGINE_DIR, n + '.d.ts'), 'utf8'); }
    function faltam(obj, txt, pre) {
        return Object.keys(obj).filter(function (k) {
            return k.charAt(0) !== '_' && !new RegExp('\\b' + k + '\\b').test(txt);
        }).map(function (k) { return pre + k; });
    }
    var Wg = c.E.world({ cols: 1, rows: 1, areas: {}, paint: function () {} });
    var semTipo = []
        .concat(faltam(c.E.combat, dtsOf('celeros.game.combat'), 'E.combat.'))
        .concat(faltam(c.E.combat.body({ x: 0, y: 0 }), dtsOf('celeros.game.combat'), 'body().'))
        .concat(faltam(c.E.combat.shot(null, { x: 0, y: 0 }), dtsOf('celeros.game.combat'), 'shot().'))
        .concat(faltam(Wg, dtsOf('celeros.game.world'), 'world().'));
    check('gate SDK: d.ts de combat/world cobrem todo membro publico', semTipo.length === 0, semTipo.join(', '));
};
