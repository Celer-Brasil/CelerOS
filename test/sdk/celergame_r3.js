// Testes da rodada 3 da CelerGame: modulos script/inv/steer/gen/stats/waves,
// os bugs corrigidos (core 1.3.0, events/pad/level/collide/path/fsm 1.1.0,
// tilemap/spr/fx/sfx 1.3.0, grid 1.1.1, physics 2.1.1) e as melhorias, +
// gates do SDK (docs EN/pt-BR citam todo modulo, todo celeros.game.* tem
// d.ts e entrada no index.json). Plugado no test/sdk/run.js:
//   require('./celergame_r3.js')(check);

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
    // roda as cenas ate quit ou maxMs (relogio do harness e compartilhado:
    // sempre relativo ao t0 da chamada)
    function runScenes(c, scenes, first, maxMs, arg) {
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
        c.E.run(scenes, first, arg);
    }
    // roda so o tick (n quadros de dt s) sem cenas: modTicks + timers/tweens
    function frames(c, n, dt) {
        var q = 0;
        runScenes(c, { s: { update: function () { if (++q >= n) c.E.quit(); } } }, 's',
                  n * (dt || 0.033) * 1000 + 2000);
    }
    function near(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }
    function throws(fn) { try { fn(); return false; } catch (e) { return true; } }

    console.log('SDK CelerGame rodada 3 (script/inv/steer/gen/stats/waves + 23 bugs + 30 melhorias):');

    // ================================================================ BUGS
    // B1 events: emit reentrante nao pula ouvintes
    var c = fresh(['events']);
    var bus = c.E.bus(), hits = { b: 0, c: 0 };
    bus.once('x', function () { bus.emit('x'); });
    bus.on('x', function () { hits.b++; });
    bus.on('x', function () { hits.c++; });
    bus.emit('x');
    check('bug events: emit reentrante (ouvinte que emite o mesmo) nao pula ouvintes',
          hits.b === 2 && hits.c === 2 && bus.count('x') === 2, JSON.stringify(hits));

    // B2 pad: botao funciona com E.paused (tick always)
    c = fresh(['pad']);
    var bP = c.E.pad.button({ x: 100, y: 100, r: 20 });
    var viuP = false, fq = 0;
    c.H.pushTouch([{ x: 0, y: 0, touched: 0 }, { x: 100, y: 100, touched: 1 }, { x: 100, y: 100, touched: 1 }]);
    runScenes(c, { s: { enter: function () { c.E.pause(true); },
                        update: function () { if (bP.pressed) viuP = true; if (++fq > 4) c.E.quit(); } } }, 's');
    check('bug pad: botao ve o toque com o jogo PAUSADO (o "continuar" funciona)', viuP);

    // B3/B4 level: CRLF e progress vazio
    c = fresh(['level']);
    var lvCr = null, erCr = null;
    try { lvCr = c.E.level.parse('#.#\r\n#@#\r\n', { legend: { '#': 1, '.': 0, '@': { spawn: 'h' } } }); }
    catch (e) { erCr = String(e); }
    check('bug level: texto CRLF parseia (o \\r nao vira caractere fora da legenda)',
          lvCr && lvCr.cols === 3 && lvCr.rows === 2 && lvCr.find('h').c === 1, erCr);
    check('bug level: progress de lista vazia tem unlocked 0 (era -1)',
          c.E.level.progress([]).unlocked === 0);

    // B5 collide: hash recicla o dicionario e segue correto
    c = fresh(['collide']);
    var hs = c.E.collide.hash(8);
    for (var i = 0; i < 5000; i++) hs.add({ x: i * 16, y: 0, w: 4, h: 4 });
    hs.clear();
    hs.add({ x: 3, y: 3, w: 4, h: 4 });
    check('bug collide: hash de mundo que rola recicla as celulas (> 4096) e consulta certo',
          hs.count === 1 && hs.query({ x: 0, y: 0, w: 8, h: 8 }) === 1 &&
          hs.query({ x: 16 * 10, y: 0, w: 8, h: 8 }) === 0);

    // B57 collide.move com NaN nao trava
    var tmMv = { cw: 8, ch: 8, rectSolid: function () { return false; } };
    var bod = { x: 10, y: 10, w: 4, h: 4 };
    var r = c.E.collide.move(bod, NaN, Infinity, tmMv);
    check('bug collide: move com dx/dy NaN/Infinity nao entra em laco eterno',
          bod.x === 10 && bod.y === 10 && r.dx === 0);

    // B6/B7 path
    c = fresh(['path']);
    c.E.path.find(20, 20, 0, 0, 19, 19, function (cc, rr) { return cc === 19 && rr === 19 ? -1 : 1; });
    check('bug path: alvo bloqueado sai na hora (nao gasta o orcamento)',
          c.E.path.expanded === 0);
    var canto = function (cc, rr) { return cc === 0 && rr === 0; };
    var sm = c.E.path.smooth([{ c: 0, r: 1 }, { c: 1, r: 1 }, { c: 1, r: 0 }], canto);
    check('bug path: smooth nao corta quina de parede (linha de visao estrita)',
          sm.length === 3 && c.E.path.los(0, 1, 1, 0, canto) === true &&
          c.E.path.los(0, 1, 1, 0, canto, true) === false);

    // B9/B10/B11/B12 timers e tweens
    c = fresh([]);
    var ord = [], tw0 = { x: 0 }, cnt0 = 0;
    c.E.after(50, function () { ord.push('a'); });
    c.E.after(50, function () { ord.push('b'); });
    c.E.tween({ v: 0 }, { v: 1 }, 60, { onDone: function () { ord.push('t1'); } });
    c.E.tween({ v: 0 }, { v: 1 }, 60, { onDone: function () { ord.push('t2'); } });
    var semMs = c.E.tween(tw0, { x: 5 });
    var ev0 = c.E.every(0, function () { cnt0++; }, 3);
    frames(c, 8);
    check('bug core: timers do mesmo quadro disparam na ordem de criacao (a antes de b)',
          ord.indexOf('a') >= 0 && ord.indexOf('a') < ord.indexOf('b'), ord.join());
    check('bug core: onDone de tweens do mesmo quadro na ordem de criacao',
          ord.indexOf('t1') >= 0 && ord.indexOf('t1') < ord.indexOf('t2'), ord.join());
    check('bug core: tween sem ms termina (era NaN e nunca acabava)',
          semMs.dead && tw0.x === 5, 'x=' + tw0.x);
    check('bug core: every(0, fn, 3) repete 3 vezes (era tiro unico)', cnt0 === 3 && ev0.dead,
          'n=' + cnt0);
    check('bug core: E.m.map com intervalo vazio devolve c (era NaN)',
          c.E.m.map(5, 2, 2, 7, 9) === 7);

    // B14 cores pretas
    c = fresh([]);
    var cores = [];
    c.S.fillRect = function (x, y, w, h, col) { cores.push(col); };
    c.S.fillSmoothRoundRect = function (x, y, w, h, rr, col) { cores.push(col); };
    c.S.drawRoundRect = function (x, y, w, h, rr, col) { cores.push(col); };
    c.S.drawRect = function (x, y, w, h, col) { cores.push(col); };
    c.E.gfx.panel(0, 0, 50, 50, { bg: 0x0000, stroke: 0x0000 });
    c.E.gfx.bar(0, 0, 50, 8, 0.5, { bg: 0x0000, fg: 0x0000 });
    check('bug gfx: panel/bar aceitam a cor preta 0x0000 (o || trocava pelo tema)',
          cores.length >= 4 && cores.every(function (v) { return v === 0; }), JSON.stringify(cores));

    // B15 textBox com max cabe na largura
    c = fresh([]);
    var ditos = [];
    c.S.drawString = function (s) { ditos.push(String(s)); };
    c.E.gfx.textBox('palavra palavra palavra palavra palavra palavra', 0, 0, 70, { px: 8, max: 2 });
    var ult = ditos[ditos.length - 1] || '';
    check('bug gfx: textBox {max} poe o "..." DENTRO da largura',
          ditos.length === 2 && /\.\.\.$/.test(ult) && c.E.gfx.measure(ult, { px: 8 }) <= 70,
          JSON.stringify(ditos));

    // B16/B17 spr: recarregar nao vaza slot
    c = fresh(['spr']);
    var defH = [{ name: 'h', w: 8, h: 8, paint: function () {} }];
    c.E.spr.load(defH); c.E.spr.load(defH); c.E.spr.load(defH);
    var u1 = c.E.spr._used;
    c.E.spr.sheet('fol', { w: 16, h: 16, regions: { a: [0, 0] }, file: 'x' });
    var sheetOk = c.E.spr._used;
    c.E.spr.sheet('fol', { w: 16, h: 16, regions: { a: [0, 0] }, file: 'x' });
    check('bug spr: load/sheet do mesmo nome libera o slot antigo (nao esgota o pool)',
          u1 === 1 && c.E.spr._used === sheetOk, 'used=' + u1 + '/' + c.E.spr._used);

    // B27/B52 anim
    var an = c.E.anim(['a', 'b', 'c'], 10);
    an.tick(0.35);
    var tSobra = an.t;
    an.play(an.frames, 20);
    check('bug anim: a volta do loop guarda a sobra do quadro (ciclo nao atrasa)',
          near(tSobra, 0.05, 1e-9) && an.i === 0, 't=' + tSobra);
    check('bug anim: play do MESMO clipe aplica o fps novo (sem recomecar)',
          an.fps === 20 && near(an.t, tSobra, 1e-9));

    // B18 sfx nota unica
    var SFX = require(path.join(ENGINE_DIR, 'celeros.sfx.js'));
    var tr = SFX.transpor([440, 50], 12), tp = SFX.tempo([440, 50], 2), vr = SFX.varia([440, 50], 0);
    check('bug sfx: transpor/tempo/varia aceitam nota unica [f, ms]',
          tr[0][0] === 880 && tp[0][1] === 100 && vr[0][0] === 440, JSON.stringify([tr, tp, vr]));

    // B19 grid flood fora da grade
    var GRID = require(path.join(ENGINE_DIR, 'celeros.grid.js'));
    var fl = null;
    try { fl = GRID.flood([['.', '.'], ['.', '.']], 5, 5, function () { return true; }); } catch (e) { fl = String(e); }
    check('bug grid: flood com origem fora da grade devolve vazio (era TypeError)',
          fl && fl.quantos === 0, JSON.stringify(fl));

    // B20 physics: mundos nativos esgotados caem no JS
    c = fresh([], {}, function (env) { env.System.verletNew = function () { return -1; }; });
    var P = c.req('celeros.physics');
    var vf = P.verletFast({});
    var pa = vf.add(10, 10);
    check('bug physics: verletFast sem mundo nativo livre cai no fallback JS (era objeto morto)',
          vf.native === false && vf.count() === 1 && pa === 0);

    // B21 fsm: string devolvida pelo send vence um go pendente
    c = fresh(['fsm']);
    var fm = c.E.fsm({}, { a: { on: { ev: function (m) { m.go('x'); return 'y'; } } }, x: {}, y: {} }, 'a');
    fm.send('ev');
    check('bug fsm: handler que chama go("x") e devolve "y" termina em "y"', fm.state === 'y', fm.state);

    // B26 pad: dedo no botao nao arma o stick embaixo
    c = fresh(['pad']);
    var stO = c.E.pad.stick({ zone: { x: 0, y: 0, w: 240, h: 320 } });
    var btO = c.E.pad.button({ x: 120, y: 160, r: 30 });
    var vO = [];
    c.H.pushTouch([{ x: 120, y: 160, touched: 1 }, { x: 150, y: 160, touched: 1 }, { x: 0, y: 0, touched: 0 }]);
    fq = 0;
    runScenes(c, { s: { update: function () { vO.push([stO.active, btO.down]); if (++fq > 3) c.E.quit(); } } }, 's');
    check('bug pad: toque que desce num botao nao pega o stick sobreposto',
          vO[0][0] === false && vO[0][1] === true && vO[1][0] === false, JSON.stringify(vO));

    // goto so com {arg} nao abre veu
    c = fresh([]);
    var semVeu = null;
    runScenes(c, { a: { update: function () { c.E.goto('b', { arg: 1 }); } },
                   b: { enter: function () { semVeu = c.E._trans; c.E.quit(); } } }, 'a');
    check('core: goto(nome, {arg}) nao abre veu (so {arg} nao e transicao)', semVeu === null);

    // ========================================================= MELHORIAS
    // cenas com arg + prevScene + resume(arg)
    c = fresh([]);
    var got = {};
    runScenes(c, {
        menu: { update: function () { if (!got.go) { got.go = 1; c.E.goto('jogo', { arg: { fase: 3 } }); } } },
        jogo: { enter: function (a) { got.fase = a && a.fase; got.prev = c.E.prevScene; c.E.push('loja', { arg: 'x' }); },
                resume: function (a) { got.res = a; c.E.quit(); } },
        loja: { enter: function (a) { got.loja = a; c.E.pop({ arg: 'comprou' }); } }
    }, 'menu');
    check('melhoria core: goto/push {arg} chega no enter, pop {arg} no resume; E.prevScene',
          got.fase === 3 && got.prev === 'menu' && got.loja === 'x' && got.res === 'comprou',
          JSON.stringify(got));

    // timeLeft + tween relativo + seq wait/call
    c = fresh([]);
    var tl = c.E.after(1000, function () {});
    var tlv = c.E.timeLeft(tl);
    var rel = { x: 10 };
    c.E.tween(rel, { x: '+=20' }, 50, { ease: c.E.m.linear });
    var sq = { x: 0 }, sqLog = [];
    c.E.seq(sq, [{ call: function () { sqLog.push('c1'); } }, { wait: 60 },
                 { call: function () { sqLog.push('c2'); } }, { to: { x: 4 }, ms: 30 }],
            { onDone: function () { sqLog.push('fim'); } });
    var sqImediato = sqLog.join();
    frames(c, 10);
    check('melhoria core: E.timeLeft(timer) em ms', tlv > 900 && tlv <= 1000 && c.E.timeLeft(null) === 0);
    check('melhoria core: tween relativo "+=20" soma ao valor do inicio', near(rel.x, 30, 1e-9), 'x=' + rel.x);
    check('melhoria core: seq com {call} imediato e {wait} ms',
          sqImediato === 'c1' && sqLog.join() === 'c1,c2,fim' && sq.x === 4, sqLog.join());

    // math
    c = fresh([]);
    var rg = c.E.rng(42), cont = { a: 0, b: 0 };
    for (i = 0; i < 400; i++) cont[c.E.m.weighted([['a', 3], ['b', 1]], rg)]++;
    var wObj = c.E.m.weighted({ so: 1, zero: 0 });
    check('melhoria math: weighted respeita os pesos (3:1) e ignora peso 0',
          cont.a > 240 && cont.b > 60 && cont.a + cont.b === 400 && wObj === 'so', JSON.stringify(cont));
    check('melhoria math: lerpColor RGB565 nas pontas e no meio',
          c.E.m.lerpColor(0x0000, 0xFFFF, 0) === 0 && c.E.m.lerpColor(0x0000, 0xFFFF, 1) === 0xFFFF &&
          c.E.m.lerpColor(0xF800, 0x0000, 0.5) === (16 << 11));
    check('melhoria math: fmt 12345 -> "12.345" e clock ms -> "m:ss"',
          c.E.m.fmt(12345) === '12.345' && c.E.m.fmt(-1234567, ',') === '-1,234,567' && c.E.m.fmt(7) === '7' &&
          c.E.m.clock(65000) === '1:05' && c.E.m.clock(3725000) === '1:02:05');
    var mt = { x: 0, y: 0 };
    var ch1 = c.E.m.moveToward(mt, 10, 0, 4), ch2 = c.E.m.moveToward(mt, 10, 0, 100);
    check('melhoria math: moveToward anda step e chega', ch1 === false && ch2 === true && mt.x === 10);

    // group.closest + pool.find
    var gr = c.E.group();
    gr.add({ x: 0, y: 0, k: 'a' }); gr.add({ x: 50, y: 0, k: 'b' }); gr.add({ x: 10, y: 0, k: 'c', dead: true });
    var pl = c.E.pool(3, function (n) { return { n: n }; });
    pl.spawn(); pl.spawn();
    check('melhoria group: closest pula mortos e respeita filtro/maxD; pool.find',
          gr.closest(12, 0).k === 'a' && gr.closest(12, 0, function (o) { return o.k === 'b'; }).k === 'b' &&
          gr.closest(100, 0, null, 10) === null && pl.find(function (o) { return o.n === 1; }).n === 1 &&
          pl.find(function (o) { return o.n === 2; }) === null);

    // cam.panTo
    c = fresh([]);
    c.E.cam.panTo(500, 400, 60);
    frames(c, 8);
    check('melhoria cam: panTo centra o ponto em ms', near(c.E.cam.x, 500 - c.E.W / 2, 1e-6) &&
          near(c.E.cam.y, 400 - c.E.H / 2, 1e-6), c.E.cam.x + ',' + c.E.cam.y);

    // gfx.hearts
    c = fresh([]);
    var circ = 0;
    var fc0 = c.S.fillCircle;
    c.S.fillCircle = function () { circ++; return fc0 && fc0.apply(null, arguments); };
    var hw = c.E.gfx.hearts(2.5, 3, 0, 0, { size: 12, gap: 4 });
    check('melhoria gfx: hearts desenha cheio/meio/vazio e devolve a largura',
          hw === 3 * 12 + 2 * 4 && circ === 6 + 4 + 1, 'w=' + hw + ' circ=' + circ);

    // save.bool/toggle
    c = fresh([], { save: 'r3.' });
    var b0 = c.E.save.bool('som', true), tg = c.E.save.toggle('som', true);
    check('melhoria save: bool com default e toggle persistente',
          b0 === true && tg === false && c.E.save.bool('som', true) === false);

    // debug com a cena
    c = fresh([]);
    c.E.debug = true;
    var dbg = [];
    c.S.drawString = function (s) { dbg.push(String(s)); };
    var qd = 0;
    runScenes(c, { fase1: { update: function () { if (++qd > 2) c.E.quit(); }, draw: function () {} } }, 'fase1');
    check('melhoria debug: overlay mostra a cena corrente',
          dbg.some(function (s) { return /fase1/.test(s); }), JSON.stringify(dbg));

    // fsm push/pop com bolsa + coringa
    c = fresh(['fsm']);
    var resumos = 0, mortes = 0;
    var fs2 = c.E.fsm({}, {
        '*': { on: { morreu: function () { mortes++; return 'fim'; } } },
        anda: { enter: function (m) { m.data.passos = 0; }, update: function (m) { m.data.passos++; },
                resume: function () { resumos++; } },
        tonto: {}, fim: {}
    }, 'anda');
    fs2.update(0.1); fs2.update(0.1);
    fs2.push('tonto');
    fs2.pop();
    var passos = fs2.data.passos, tempo = fs2.time;
    fs2.send('morreu');
    check('melhoria fsm: pop volta com a bolsa e o tempo do estado (hook resume)',
          passos === 2 && near(tempo, 0.2, 1e-9) && resumos === 1, passos + '/' + tempo);
    check('melhoria fsm: estado coringa "*" trata evento de qualquer estado',
          fs2.state === 'fim' && mortes === 1 && throws(function () { fs2.go('*'); }));

    // events coringa
    c = fresh(['events']);
    var visto = [];
    c.E.on('*', function (nome, a) { visto.push(nome + ':' + a); });
    c.E.on('dano', function () { return false; });
    c.E.emit('dano', 3); c.E.emit('moeda', 1);
    check('melhoria events: ouvinte coringa "*" recebe (nome, arg) de todo evento',
          visto.join() === 'dano:3,moeda:1', visto.join());

    // path.flow + follower loop/pingpong
    c = fresh(['path']);
    var parede = function (cc, rr) { return cc === 2 && rr < 4 ? -1 : 1; };
    var fw = c.E.path.flow(5, 5, 4, 0, parede);
    var passo = [];
    var pc = 0, pr = 0;
    for (i = 0; i < 20; i++) {
        var nx = fw.next(pc, pr);
        if (!nx) break;
        pc = nx.c; pr = nx.r;
        passo.push(pc + ',' + pr);
    }
    check('melhoria path: flow da o passo de qualquer celula ate o alvo contornando a parede',
          pc === 4 && pr === 0 && fw.dist(4, 0) === 0 && fw.dist(2, 0) === -1 &&
          passo.indexOf('2,4') >= 0, passo.join(' '));
    var ob = { x: 8, y: 8 };
    var fol = c.E.path.follower(ob, [{ c: 0, r: 0 }, { c: 2, r: 0 }], 160, { cell: 16, pingpong: true });
    for (i = 0; i < 20; i++) fol.update(0.1);
    var ob2 = { x: 8, y: 8 };
    var fl2 = c.E.path.follower(ob2, [{ c: 0, r: 0 }, { c: 1, r: 0 }], 160, { cell: 16, loop: true });
    for (i = 0; i < 10; i++) fl2.update(0.1);
    check('melhoria path: follower pingpong/loop patrulham sem terminar (laps conta)',
          !fol.done && fol.laps >= 3 && !fl2.done && fl2.laps >= 3, fol.laps + '/' + fl2.laps);

    // collide.ray + sweep
    c = fresh(['collide', 'tilemap']);
    var tmR = c.E.tilemap({ cols: 10, rows: 10, cell: 10, paint: function () {}, data: (function () {
        var d = []; for (var q = 0; q < 100; q++) d.push(q % 10 === 6 ? 1 : 0); return d; })() });
    // resultado reaproveitado: copie antes do proximo ray
    var ry = JSON.parse(JSON.stringify(c.E.collide.ray(5, 5, 95, 5, tmR)));
    var ry2 = c.E.collide.ray(5, 5, 5, 95, tmR);
    check('melhoria collide: ray para na 1a celula solida (DDA) e passa no vao',
          ry.hit && ry.c === 6 && near(ry.x, 60, 1e-6) && near(ry.dist, 55, 1e-6) && !ry2.hit,
          JSON.stringify(ry));
    var tSw = c.E.collide.sweep({ x: 0, y: 0, w: 10, h: 10 }, 100, 0, { x: 50, y: 0, w: 10, h: 10 });
    var nX = c.E.collide.normal.x;
    var tSw2 = c.E.collide.sweep({ x: 0, y: 0, w: 10, h: 10 }, 0, 100, { x: 50, y: 0, w: 10, h: 10 });
    check('melhoria collide: sweep da a fracao do 1o contato e a normal',
          near(tSw, 0.4, 1e-9) && nX === -1 && tSw2 === -1, tSw + '/' + tSw2);

    // pad: heldMs/tap e controle preso a cena
    c = fresh(['pad']);
    var regP = [], bA = null, stA = null, depoisB = [];
    c.H.pushTouch([{ x: 0, y: 0, touched: 0 }, { x: 100, y: 100, touched: 1 }, { x: 100, y: 100, touched: 1 },
                   { x: 100, y: 100, touched: 1 }, { x: 0, y: 0, touched: 0 }]);
    fq = 0;
    runScenes(c, {
        a: { enter: function () { bA = c.E.pad.button({ x: 100, y: 100, r: 20 }); stA = c.E.pad.stick({}); },
             update: function () { regP.push([bA.heldMs, bA.tap]); if (++fq === 6) c.E.goto('b'); } },
        b: { enter: function () {
                 c.H.pushTouch([{ x: 100, y: 100, touched: 1 }, { x: 100, y: 100, touched: 1 }, { x: 60, y: 250, touched: 1 }]);
             },
             update: function () { depoisB.push(bA.down || bA.pressed || stA.active); if (++fq > 10) c.E.quit(); } }
    }, 'a');
    var anyTap = regP.some(function (v) { return v[1]; });
    var maxHeld = Math.max.apply(null, regP.map(function (v) { return v[0]; }));
    check('melhoria pad: botao com heldMs e tap (soltou rapido)', anyTap && maxHeld > 0, JSON.stringify(regP));
    check('melhoria pad: controles criados numa cena somem quando ela sai',
          depoisB.length >= 3 && depoisB.every(function (v) { return v === false; }), JSON.stringify(depoisB));

    // level.tilemap + progress.complete/totalStars
    c = fresh(['level', 'tilemap'], { save: 'r3lv.' });
    var lvT = c.E.level.parse(['#.#', '...'], { legend: { '#': 1, '.': 0 }, cell: 8 });
    var tmL = lvT.tilemap({ paint: function () {} });
    var prg = c.E.level.progress(['a', 'b', 'c'], { save: 'pg' });
    var temProx = prg.complete(0, 2);
    prg.complete(1, 3);
    check('melhoria level: lv.tilemap monta o mapa da fase; complete desbloqueia e soma estrelas',
          tmL.solidAt(1, 1) && !tmL.solidAt(9, 1) && temProx && prg.unlocked === 2 &&
          prg.totalStars() === 5 && prg.complete(2) === false);

    // tilemap autotile + neighbors
    c = fresh(['tilemap']);
    var tmA = c.E.tilemap({ cols: 3, rows: 3, cell: 8, paint: function () {}, outside: false,
                            data: [0, 1, 0, 1, 1, 1, 0, 0, 0] });
    var viz = 0;
    tmA.neighbors(0, 0, function () { viz++; }, true);
    check('melhoria tilemap: autotile (mascara 1/2/4/8) e neighbors dentro da grade',
          tmA.autotile(1, 1) === (1 | 2 | 8) && tmA.autotile(1, 0) === 4 && viz === 3);

    // anim speed + onFrame
    c = fresh(['spr']);
    var an2 = c.E.anim(['a', 'b', 'c', 'd'], 10), fr = [];
    an2.speed = 2;
    an2.onFrame = function (a, k) { fr.push(k); };
    an2.tick(0.05); an2.tick(0.05);
    check('melhoria anim: speed multiplica o tempo e onFrame avisa a troca', an2.i === 2 && fr.join() === '1,2',
          an2.i + ' ' + fr.join());

    // fx.beam + count
    c = fresh(['fx']);
    var lin = 0;
    c.S.drawWideLine = function () { lin++; };
    c.S.drawLine = function () { lin++; };
    c.E.fx.beam(0, 0, 100, 0, { w: 6, life: 0.1 });
    var n1 = c.E.fx.count();
    c.E.fx.draw();
    var lin1 = lin;
    c.E.fx._tick(0.2);
    check('melhoria fx: beam desenha raio + nucleo e some na vida; count conta',
          n1 === 1 && lin1 === 2 && c.E.fx.count() === 0);

    // sfx.combo
    var cb = SFX.combo('ui', 3), cbTeto = SFX.combo([440, 50], 40, 12);
    check('melhoria sfx: combo sobe k semitons com teto',
          cb[0][0] === Math.round(880 * Math.pow(2, 3 / 12)) && cbTeto[0][0] === 880 && SFX.combo('nada', 1) === null);

    // ====================================================== MODULO script
    c = fresh(['script', 'events']);
    var sl = [], heroi = { x: 0 }, porta = { aberta: false };
    c.E.on('cena', function (a) { sl.push('emit:' + a); });
    var sc = c.E.script([
        { call: function () { sl.push('ini'); } },
        { tween: heroi, to: { x: 40 }, ms: 60 },
        { label: 'volta' },
        { call: function (s) { s.data.n = (s.data.n || 0) + 1; } },
        { loop: 'volta', times: 2 },
        { par: [{ wait: 40 }, [{ wait: 10 }, { call: function () { porta.aberta = true; } }]] },
        { until: function () { return porta.aberta; } },
        function (s, dt) { s.data.f = (s.data.f || 0) + 1; return s.data.f >= 3 ? undefined : false; },
        { emit: 'cena', arg: 'fim' }
    ], { onDone: function () { sl.push('done'); } });
    var iniJa = sl.join();
    frames(c, 20);
    check('script: call imediato, tween/wait/par/until/fn em ordem, loop {times}, emit e onDone',
          iniJa === 'ini' && heroi.x === 40 && sc.data.n === 3 && sc.data.f === 3 &&
          sl.join() === 'ini,emit:fim,done' && sc.done && c.E.script.live() === 0,
          sl.join() + ' n=' + sc.data.n);
    c = fresh(['script']);
    var obS = { x: 0 }, pulou = [];
    var sk = c.E.script([{ tween: obS, to: { x: 99 }, ms: 5000 }, { wait: 9000 },
                         { tap: true }, { call: function () { pulou.push('c'); } }]);
    sk.skip();
    check('script: skip leva o tween ao fim, zera esperas e roda os calls', obS.x === 99 &&
          pulou.join() === 'c' && sk.done);
    c = fresh(['script']);
    var vivoA = null, scP = null, cont = 0, fA = 0, congelou = null;
    fq = 0;
    runScenes(c, {
        a: { enter: function () {
                 vivoA = c.E.script([{ wait: 99999 }]);
                 scP = c.E.script([function () { cont++; return false; }], { global: true });
             },
             update: function () {
                 fA++;
                 if (fA === 3) c.E.pause(true);
                 if (fA === 3) congelou = cont;
                 if (fA === 6) { congelou = congelou === cont; c.E.pause(false); c.E.goto('b'); }
             } },
        b: { update: function () { if (++fq > 3) c.E.quit(); } }
    }, 'a');
    check('script: preso a cena (morre quando ela sai); {global} sobrevive; congela na pausa',
          vivoA.dead && !vivoA.done && !scP.dead && congelou === true && cont > 3, 'cont=' + cont);
    scP.cancel();

    // ========================================================= MODULO inv
    c = fresh(['inv'], { save: 'r3inv.' });
    var usou = 0;
    c.E.inv.items({ pocao: { max: 9, use: function () { usou++; return true; } }, espada: { max: 1 },
                    pedra: { max: 5, use: function () { return false; } } });
    var mo = c.E.inv.bag({ slots: 4 });
    var muds = 0;
    mo.onChange = function () { muds++; };
    var sobra = mo.add('pocao', 12);
    var sobra2 = mo.add('espada', 3);
    check('inv: add empilha ate o max, abre slots e devolve a sobra',
          sobra === 0 && mo.slot(0).n === 9 && mo.slot(1).n === 3 && sobra2 === 1 && mo.free() === 0 &&
          mo.count('pocao') === 12 && !mo.fits('pedra', 1), JSON.stringify(mo.toJSON()));
    var rem = mo.remove('pocao', 4);
    mo.use(0);
    var usarPedra = (mo.set(3, 'pedra', 2), mo.use(3));
    check('inv: remove tira das ultimas pilhas; use gasta 1 so quando def.use devolve true',
          rem === 4 && mo.count('pocao') === 7 && usou === 1 && usarPedra === false && mo.count('pedra') === 2);
    mo.move(0, 1);
    var sp = mo.split(1, 3);
    mo.save('mochila');
    var mo2 = c.E.inv.bag({ slots: 4 });
    var ok2 = mo2.restore('mochila');
    mo2.sort();
    check('inv: move junta pilhas iguais, split divide, save/restore e sort compactam',
          mo.slot(1).n === 4 && sp >= 0 && ok2 && mo2.count('pocao') === 7 && mo2.slot(0).id === 'pocao' &&
          mo2.slot(0).n === 7 && mo2.slot(1).id === 'espada' && muds > 4, JSON.stringify(mo2.toJSON()));

    // ======================================================= MODULO steer
    c = fresh(['steer']);
    var bat = { x: 0, y: 0 };
    var ag = c.E.steer.agent(bat, { speed: 50 });
    for (i = 0; i < 120; i++) ag.arrive(100, 0, 30).update(1 / 30);
    var foge = { x: 10, y: 0 };
    var ag2 = c.E.steer.agent(foge, { speed: 50 });
    for (i = 0; i < 30; i++) ag2.flee(0, 0).update(1 / 30);
    var bando = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
    var ga = c.E.steer.agent(bando[0], { speed: 40 }), gb = c.E.steer.agent(bando[1], { speed: 40 });
    for (i = 0; i < 30; i++) { ga.separate(bando, 20).update(1 / 30); gb.separate(bando, 20).update(1 / 30); }
    var caixa = { x: 200, y: 100 };
    var gc = c.E.steer.agent(caixa, { speed: 60 });
    for (i = 0; i < 200; i++) gc.wander(1, { rnd: c.E.rng(i + 1) }).within({ x: 0, y: 0, w: 240, h: 320 }, 30).update(1 / 30);
    check('steer: arrive chega e para, flee afasta, separate desembola, within segura no rect',
          Math.abs(bat.x - 100) < 2 && Math.abs(bat.vx) < 3 && foge.x > 30 &&
          Math.abs(bando[1].x - bando[0].x) > 15 && caixa.x > -20 && caixa.x < 260 && caixa.y > -20 && caixa.y < 340,
          [bat.x, bat.vx, foge.x, bando[1].x - bando[0].x, caixa.x, caixa.y].map(function (v) { return v.toFixed(1); }).join(' '));

    // ========================================================= MODULO gen
    c = fresh(['gen', 'level']);
    function alcance(g, c0, r0) {
        return GRID.flood(g, c0, r0, function (chh) { return chh !== '#'; });
    }
    var dg = c.E.gen.rooms(48, 32, { rnd: c.E.rng(7), rooms: 8 });
    var al = alcance(dg.grid, dg.rooms[0].cx, dg.rooms[0].cy);
    var todas = dg.rooms.every(function (rm) { return al.ok[rm.cy][rm.cx]; });
    var dg2 = c.E.gen.rooms(48, 32, { rnd: c.E.rng(7), rooms: 8 });
    check('gen: rooms cria salas sem sobrepor, todas alcancaveis; mesma semente = mesma fase',
          dg.rooms.length >= 4 && todas && c.E.gen.lines(dg.grid).join() === c.E.gen.lines(dg2.grid).join(),
          'salas=' + dg.rooms.length);
    var cv = c.E.gen.cave(40, 30, { rnd: c.E.rng(3) });
    var livres = c.E.gen.findAll(cv.grid, '.');
    var alC = alcance(cv.grid, livres[0].c, livres[0].r);
    var bordaOk = cv.grid[0].every(function (chh) { return chh === '#'; });
    check('gen: cave fica so com a maior regiao (tudo conectado) e borda fechada',
          livres.length === cv.open && alC.quantos === cv.open && cv.open > 100 && bordaOk, 'open=' + cv.open);
    var mz = c.E.gen.maze(20, 14, { rnd: c.E.rng(9) });
    var celulas = 0, corredores = 0;
    for (var rr2 = 0; rr2 < mz.rows; rr2++) {
        for (var cc2 = 0; cc2 < mz.cols; cc2++) {
            if (mz.grid[rr2][cc2] !== '.') continue;
            if (rr2 % 2 && cc2 % 2) celulas++; else corredores++;
        }
    }
    var alM = alcance(mz.grid, 1, 1);
    check('gen: maze perfeito (arvore: corredores = celulas - 1, tudo alcancavel; par vira impar)',
          mz.cols === 21 && mz.rows === 15 && celulas === 70 && corredores === 69 && alM.quantos === celulas + corredores,
          celulas + '/' + corredores);
    var sct = c.E.gen.scatter(dg.grid, 'o', 10, { rnd: c.E.rng(1), minDist: 3 });
    var longe = true;
    for (i = 0; i < sct.length; i++) for (var j2 = i + 1; j2 < sct.length; j2++) {
        if (Math.abs(sct[i].c - sct[j2].c) < 3 && Math.abs(sct[i].r - sct[j2].r) < 3) longe = false;
    }
    var lvG = c.E.level.parse(c.E.gen.lines(dg.grid), { legend: { '#': 1, '.': 0, 'o': { spawn: 'moeda' } } });
    check('gen: scatter respeita minDist e a grade vai direto no level.parse',
          sct.length === 10 && longe && lvG.all('moeda').length === 10);

    // ======================================================= MODULO stats
    c = fresh(['stats']);
    var mortesS = 0, niveis = [];
    var stt = c.E.stats({ hp: 10, atk: 3, def: 1 }, { iframes: 100,
        onDeath: function () { mortesS++; }, onLevel: function (s, n) { niveis.push(n); },
        xp: { base: 10, grow: 2 } });
    stt.mod('atk', { add: 2 });
    var furia = stt.mod('atk', { mul: 2, ms: 50, id: 'furia' });
    stt.mod('atk', { mul: 3, ms: 50, id: 'furia' });
    var atkBuff = stt.get('atk');
    var d1 = stt.damage(4), d2 = stt.damage(4);
    var prontoA = stt.cool('dash', 80), prontoB = stt.cool('dash', 80);
    frames(c, 8);
    var atkDepois = stt.get('atk');
    var d3 = stt.damage(4), cura = stt.heal(99);
    var d4 = stt.damage(50, { pierce: true, force: true });
    var subiu = stt.addXp(35);
    check('stats: get soma add e multiplica mul; mesmo id substitui; buff expira no relogio do jogo',
          atkBuff === 15 && atkDepois === 5 && !stt.hasMod('furia') && furia.remove, atkBuff + '/' + atkDepois);
    check('stats: damage tira def com minimo, iframes bloqueiam, heal ate o teto, morte avisa 1x',
          d1 === 3 && d2 === 0 && d3 === 3 && cura === 6 && d4 === 10 && stt.dead && mortesS === 1 &&
          stt.heal(5) === 0, [d1, d2, d3, cura, d4].join());
    check('stats: cool recarrega no relogio; addXp sobe niveis pela curva',
          prontoA && !prontoB && stt.ready('dash') && stt.coolFrac('dash') === 1 && subiu === 2 &&
          stt.level === 3 && stt.xp === 5 && niveis.join() === '2,3', stt.level + '/' + stt.xp);

    // ======================================================= MODULO waves
    c = fresh(['waves']);
    var nasc = [], vivosW = 0, ondas = [], fimW = 0;
    var wv = c.E.waves([
        { type: 'z', n: 3, every: 10 },
        { groups: [{ type: 'z', n: 2 }, { type: 'c', n: 1, delay: 30 }], rest: 20 }
    ], { delay: 0, rest: 20,
         spawn: function (t) { nasc.push(t); vivosW++; },
         alive: function () { return vivosW; },
         onWave: function (w, n) { ondas.push(n); },
         onDone: function () { fimW++; } });
    var faseW = [];
    fq = 0;
    runScenes(c, { s: { update: function () {
        fq++;
        faseW.push(wv.state);
        if (wv.state === 'clear' && fq % 3 === 0) vivosW = 0;   // a horda morre
        if (wv.state === 'done' || fq > 300) c.E.quit();
    } } }, 's');
    check('waves: nasce no ritmo, espera alive() zerar, descansa e passa a proxima; onDone no fim',
          nasc.join() === 'z,z,z,z,z,c' && ondas.join() === '1,2' && fimW === 1 && wv.state === 'done' &&
          faseW.indexOf('clear') >= 0, nasc.join() + ' ' + ondas.join());
    var wE = c.E.waves([{ type: 'a', n: 4 }], { endless: { grow: 1.5 }, auto: false });
    check('waves: endless escala a ultima onda; auto false espera o start()',
          wE.def(2).groups[0].n === 6 && wE.def(3).groups[0].n === 9 && wE.state === 'wait' && wE.wave === 0);

    // ====================================================== gates do SDK
    var mods = fs.readdirSync(ENGINE_DIR).filter(function (f) { return /^celeros\.game\.[a-z]+\.js$/.test(f); })
        .map(function (f) { return f.replace(/\.js$/, ''); });
    var idx = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, 'index.json'), 'utf8'));
    var semDts = mods.filter(function (m) { return !fs.existsSync(path.join(ENGINE_DIR, m + '.d.ts')); });
    var semIdx = mods.filter(function (m) { return !idx[m]; });
    check('gate SDK: todo celeros.game.* tem d.ts e entrada no index.json',
          semDts.length === 0 && semIdx.length === 0, 'sem d.ts: ' + semDts + ' sem index: ' + semIdx);
    var docEN = fs.readFileSync(path.join(ROOT, 'Documentation', 'Game_Engine_Guide.md'), 'utf8');
    var docPT = fs.readFileSync(path.join(ROOT, 'Documentation', 'Game_Engine_Guide.pt-BR.md'), 'utf8');
    var foraDoc = mods.filter(function (m) { return docEN.indexOf(m) < 0 || docPT.indexOf(m) < 0; });
    check('gate SDK: o Game Engine Guide (EN e pt-BR) cita todo modulo da familia',
          foraDoc.length === 0, foraDoc.join(', '));
    // versao semver declarada e nome do _mods unico por modulo
    c = fresh(mods);
    var nomes = c.E._mods.slice().sort(), dup = nomes.filter(function (n, k) { return nomes[k + 1] === n; });
    var semVer = mods.filter(function (m) {
        var src = fs.readFileSync(path.join(ENGINE_DIR, m + '.js'), 'utf8');
        return !/version[:\s=]+'\d+\.\d+\.\d+'/.test(src);
    });
    check('gate SDK: todo modulo declara version x.y.z e registra um nome unico em E._mods',
          semVer.length === 0 && dup.length === 0 && nomes.length === mods.length,
          'semVer=' + semVer + ' dup=' + dup + ' n=' + nomes.length + '/' + mods.length);
    // d.ts dos modulos novos cobrem todo membro publico
    function dts(n) { return fs.readFileSync(path.join(ENGINE_DIR, n + '.d.ts'), 'utf8'); }
    function faltam(obj, txt, pre) {
        return Object.keys(obj).filter(function (k) {
            return k.charAt(0) !== '_' && !new RegExp('\\b' + k + '\\b').test(txt);
        }).map(function (k) { return pre + k; });
    }
    var E = c.E;
    var mapa = [
        [E.script, 'celeros.game.script', 'E.script.'],
        [E.script([{ wait: 1 }], { global: true }), 'celeros.game.script', 'script().'],
        [E.inv, 'celeros.game.inv', 'E.inv.'], [E.inv.bag({}), 'celeros.game.inv', 'bag().'],
        [E.steer, 'celeros.game.steer', 'E.steer.'], [E.steer.agent({ x: 0, y: 0 }), 'celeros.game.steer', 'agent().'],
        [E.gen, 'celeros.game.gen', 'E.gen.'],
        [E.stats, 'celeros.game.stats', 'E.stats.'], [E.stats({ hp: 1 }), 'celeros.game.stats', 'stats().'],
        [E.stats({ hp: 1 }).mod('hp', {}), 'celeros.game.stats', 'mod().'],
        [E.waves, 'celeros.game.waves', 'E.waves.'], [E.waves([]), 'celeros.game.waves', 'waves().']
    ];
    var semTipo = [];
    mapa.forEach(function (row) { semTipo = semTipo.concat(faltam(row[0], dts(row[1]), row[2])); });
    check('gate SDK: d.ts de script/inv/steer/gen/stats/waves cobrem todo membro publico',
          semTipo.length === 0, semTipo.join(', '));
};
