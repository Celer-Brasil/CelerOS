// Testes dos modulos CelerGame para jogos complexos (fsm, events, path,
// collide, pad, level) e da rodada core 1.2.0 / fx 1.2.0 / spr 1.2.0 /
// tilemap 1.2.0 / sfx 1.2.0, + gates do SDK (d.ts dos modulos novos,
// arestas de require x index.json). Plugado no test/sdk/run.js:
//   require('./celergame_mods.js')(check);

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
        (mods || []).forEach(function (m) { req('celeros.game.' + m); });
        E.init(initOpts || {});
        return { E: E, env: env, S: env.System, H: env.__harness };
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
    function near(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9); }
    var i;

    console.log('SDK CelerGame modulos (fsm/events/path/collide/pad/level) + core 1.2:');

    // -------------------------------------------------------------- fsm --
    var c = fresh(['fsm']);
    var log = [];
    var dono = { hp: 3 };
    var m = c.E.fsm(dono, {
        idle: { enter: function (mm, a) { log.push('in:idle:' + a); },
                update: function (mm) { if (mm.owner.hp < 3) { mm.go('fuga', 'ai'); log.push('pedido'); } },
                exit: function (mm, nx) { log.push('out:idle>' + nx); } },
        fuga: { enter: function (mm, a) { log.push('in:fuga:' + a); },
                after: [0.5, 'idle'],
                on: { cura: function (mm) { mm.owner.hp = 3; return 'idle'; } } },
        tonto: { after: [0.2, function (mm) { return mm.prev; }] }
    }, 'idle', { arg: 'ini' });
    m.update(0.1);
    dono.hp = 2;
    m.update(0.1);
    check('fsm: enter com arg; go DENTRO do update aplica no fim (exit antes do enter)',
          log.join(',') === 'in:idle:ini,pedido,out:idle>fuga,in:fuga:ai' && m.is('fuga') &&
          m.prev === 'idle' && m.time === 0, log.join(','));
    m.update(0.3); m.update(0.3);
    check('fsm: after [s, proximo] sai sozinho', m.is('idle'), m.state);
    m.go('fuga');
    var tratou = m.send('cura'), naoTratou = m.send('nada');
    check('fsm: send -> handler do estado; string devolvida = transicao',
          tratou && !naoTratou && m.is('idle') && dono.hp === 3);
    m.push('tonto');
    m.update(0.25);
    check('fsm: push/after com fn(m) volta ao estado de baixo', m.is('idle') && m.history.length > 0,
          m.state);
    var errF = null;
    try { m.go('voar'); } catch (e) { errF = String(e.message); }
    check('fsm: estado inexistente lanca com a lista', errF && errF.indexOf('idle, fuga, tonto') >= 0, errF);

    // ----------------------------------------------------------- events --
    c = fresh(['events']);
    var ev = [];
    c.E.on('x', function (v) { ev.push('a' + v); });
    c.E.on('x', function (v) { ev.push('alta' + v); }, { prio: 5 });
    c.E.once('x', function (v) { ev.push('uma' + v); });
    var n1 = c.E.emit('x', 1), n2 = c.E.emit('x', 2);
    check('events: prioridade ouve antes, once dispara 1x, emit conta ouvintes',
          ev.join(',') === 'alta1,a1,uma1,alta2,a2' && n1 === 3 && n2 === 2, ev.join(','));
    var parou = [];
    var bus = c.E.bus();
    bus.on('dano', function () { parou.push('escudo'); return false; }, { prio: 1 });
    bus.on('dano', function () { parou.push('hud'); });
    bus.emit('dano');
    bus.off('dano');
    check('events: false para a propagacao; off(nome) limpa; bus privado isolado',
          parou.join(',') === 'escudo' && bus.count('dano') === 0 && c.E.events.count('x') === 2);
    // escopo de cena: dorme sob push, morre no goto
    c = fresh(['events']);
    var ouviu = [], fr = 0;
    runScenes(c, {
        jogo: { enter: function () { if (!this._ok) { this._ok = 1; c.E.on('pt', function () { ouviu.push(c.E.sceneName); }, { scene: true }); } },
                update: function () {
                    fr++;
                    if (fr === 2) c.E.emit('pt');
                    if (fr === 3) c.E.push('menu');
                    if (fr === 8) c.E.emit('pt');
                    if (fr === 9) c.E.goto('fim');
                } },
        menu: { update: function () { fr++; if (fr === 5) c.E.emit('pt'); if (fr === 6) c.E.pop(); } },
        fim: { update: function () { fr++; if (fr === 11) { c.E.emit('pt'); c.E.quit(); } } }
    }, 'jogo');
    check('events {scene}: ouve na cena, dorme sob E.push, morre quando a cena sai',
          ouviu.join(',') === 'jogo,jogo' && c.E.events.count('pt') === 0, ouviu.join(','));
    c = fresh(['events']);
    var tarde = [], frL = 0;
    runScenes(c, { s: { update: function () {
        frL++;
        if (frL === 1) { c.E.emitLater('z', 7); tarde.push(c.E.events.count('z') + ':' + frL); }
        if (frL === 1) c.E.on('z', function (v) { tarde.push('ouviu' + v + '@' + frL); });
        if (frL >= 3) c.E.quit();
    } } }, 's');
    check('events: emitLater entrega no quadro seguinte', tarde.join(',') === '0:1,ouviu7@1',
          tarde.join(','));

    // ------------------------------------------------------------- path --
    c = fresh(['path', 'tilemap']);
    var P = c.E.path;
    var maze = ['.....',
                '.###.',
                '...#.',
                '.#.#.',
                '.#...'];
    function cost(cc, rr) { return maze[rr].charAt(cc) === '#' ? -1 : 1; }
    function blk(cc, rr) { return maze[rr].charAt(cc) === '#'; }
    var p1 = P.find(5, 5, 0, 4, 4, 4, cost);
    var passaParede = p1 && p1.some(function (q) { return blk(q.c, q.r); });
    var vizinhos = p1 && p1.every(function (q, k) {
        return !k || Math.abs(q.c - p1[k - 1].c) + Math.abs(q.r - p1[k - 1].r) === 1;
    });
    check('path.find (4 viz): caminho minimo, sem parede, passos vizinhos',
          p1 && p1.length === 9 && !passaParede && vizinhos &&
          p1[0].c === 0 && p1[0].r === 4 && p1[8].c === 4 && p1[8].r === 4,
          p1 ? p1.length + ' ' + JSON.stringify(p1) : 'null');
    var dg = P.find(5, 5, 0, 0, 4, 4, cost, { diag: true });
    var cortou = dg && dg.some(function (q, k) {
        if (!k) return false;
        var pr = dg[k - 1];
        return q.c !== pr.c && q.r !== pr.r && (blk(q.c, pr.r) || blk(pr.c, q.r));
    });
    check('path.find diag: nunca corta canto de parede', dg && !cortou, JSON.stringify(dg));
    var fechado = ['..#..', '..#..', '..#..'];
    function costF(cc, rr) { return fechado[rr].charAt(cc) === '#' ? -1 : 1; }
    var nul = P.find(5, 3, 0, 1, 4, 1, costF);
    var perto = P.find(5, 3, 0, 1, 4, 1, costF, { near: true });
    check('path.find: sem caminho = null; near: vai ate a celula mais perto',
          nul === null && perto && perto[perto.length - 1].c === 1, JSON.stringify(perto));
    var big = P.find(60, 60, 0, 0, 59, 59, function () { return 1; }, { max: 50 });
    check('path.find: orcamento estourado devolve null (nao trava o quadro)',
          big === null && P.expanded >= 50);
    check('path.los: parede no meio bloqueia, pontas nao contam',
          !P.los(0, 1, 4, 1, function (cc, rr) { return costF(cc, rr) < 0; }) &&
          P.los(0, 0, 1, 2, function (cc, rr) { return costF(cc, rr) < 0; }));
    var aberto = P.find(8, 8, 0, 0, 7, 3, function () { return 1; });
    var liso = P.smooth(aberto, function () { return false; });
    check('path.smooth: campo aberto vira 2 pontos', liso.length === 2 && aberto.length > 2,
          liso.length + '/' + aberto.length);
    var corpo = { x: 8, y: 8 };
    var seg = P.follower(corpo, [{ c: 0, r: 0 }, { c: 3, r: 0 }], 100, { cell: 16 });
    var passos = 0;
    while (!seg.update(0.05) && passos++ < 100) {}
    check('path.follower anda ate o centro da ultima celula', seg.done && corpo.x === 56 && corpo.y === 8,
          JSON.stringify(corpo));
    var tmP = c.E.tilemap({ cols: 5, rows: 5, cell: 10, data: maze,
                            solid: function (v) { return v === '#'; }, paint: function () {} });
    var gP = P.grid(tmP);
    var p2 = P.find(gP.cols, gP.rows, 0, 4, 4, 4, gP.cost);
    check('path.grid: adaptador do tilemap da o mesmo caminho', p2 && p2.length === 9);

    // ---------------------------------------------------------- collide --
    c = fresh(['collide', 'tilemap']);
    var C = c.E.collide;
    check('collide: rect/circle/circleRect/test/point (borda encostando nao conta)',
          C.rect({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 5, h: 5 }) &&
          !C.rect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 }) &&
          C.circle({ x: 0, y: 0, r: 5 }, { x: 9, y: 0, r: 5 }) &&
          !C.circleRect({ x: 0, y: 0, r: 5 }, { x: 4, y: 4, w: 5, h: 5 }) &&
          C.test({ x: 12, y: 5, r: 3 }, { x: 0, y: 0, w: 10, h: 10 }) &&
          C.point(5, 5, { x: 5, y: 5, r: 1 }) && !C.point(10, 5, { x: 0, y: 0, w: 10, h: 10 }));
    var pu = C.push({ x: 8, y: 2, w: 10, h: 4 }, { x: 0, y: 0, w: 10, h: 10 });
    check('collide.push: menor eixo de penetracao', pu && pu.x === 2 && pu.y === 0, JSON.stringify(pu));
    check('collide.segRect: fracao do 1o toque; erro = -1',
          near(C.segRect(0, 5, 20, 5, { x: 10, y: 0, w: 5, h: 10 }), 0.5) &&
          C.segRect(0, 20, 20, 20, { x: 10, y: 0, w: 5, h: 10 }) === -1);
    var hs = C.hash(16), bichos = [];
    for (i = 0; i < 40; i++) { var b = { x: (i % 10) * 20, y: Math.floor(i / 10) * 20, w: 8, h: 8, id: i }; bichos.push(b); hs.add(b); }
    var achou = [];
    var nq = hs.query({ x: 38, y: 18, w: 10, h: 10 }, function (o) { achou.push(o.id); });
    var bruto = bichos.filter(function (o) { return C.rect(o, { x: 38, y: 18, w: 10, h: 10 }); }).length;
    check('collide.hash.query = forca bruta, cada candidato 1x', nq === bruto && achou.length === bruto &&
          achou.indexOf(12) >= 0, nq + ' vs ' + bruto);
    var pares = 0, lst = [{ x: 0, y: 0, r: 5 }, { x: 6, y: 0, r: 5 }, { x: 100, y: 0, r: 5 }];
    hs.clear(); lst.forEach(function (o) { hs.add(o); });
    hs.pairs(lst, function () { pares++; });
    check('collide.hash.pairs: cada par uma vez', pares === 1 && lst[0]._hi === undefined, 'pares=' + pares);
    var tmS = c.E.tilemap({ cols: 10, rows: 10, cell: 16, outside: false, paint: function () {},
        data: ['..........', '..........', '..........', '..........', '..........',
               '..........', '..........', '.....#....', '..........', '##########'],
        solid: function (v) { return v === '#'; } });
    var heroi = { x: 20, y: 40, w: 10, h: 14, vx: 0, vy: 400 };
    var mr = C.move(heroi, 0, 400, tmS);   // queda de 400 px num quadro (tunel?)
    check('collide.move: queda rapida para NO chao (sem tunel), ground e vy = 0',
          mr.ground && mr.hitY && heroi.vy === 0 && heroi.y + heroi.h === 144,
          JSON.stringify([heroi.y, mr.ground]));
    var hx = { x: 60, y: 112, w: 10, h: 14, vx: 90 };
    var mx = C.move(hx, 40, 0, tmS);        // parede em (5,7) = x 80..96
    check('collide.move: parede para no eixo X e zera vx', mx.hitX && hx.x + hx.w === 80 && hx.vx === 0,
          JSON.stringify([hx.x, mx.hitX]));

    // -------------------------------------------------------------- pad --
    c = fresh(['pad']);
    var st = c.E.pad.stick({ zone: { x: 0, y: 160, w: 120, h: 160 }, r: 40 });
    var bt = c.E.pad.button({ x: 200, y: 280, r: 20, label: 'A' });
    c.H.pushTouch([{ x: 60, y: 240, touched: 1 }, { x: 80, y: 240, touched: 1 },
                   { x: 110, y: 240, touched: 1 }, { x: 0, y: 0, touched: 0 },
                   { x: 60, y: 200, touched: 1 }, { x: 60, y: 200, touched: 0 },
                   { x: 200, y: 280, touched: 1 }, { x: 200, y: 280, touched: 1 },
                   { x: 0, y: 0, touched: 0 }]);
    var reg = [], fp = 0;
    runScenes(c, { s: { update: function () {
        fp++;
        reg.push({ x: +st.x.toFixed(2), dir: st.dir, tap: st.tap, bp: bt.pressed, bd: bt.down });
        if (fp >= 10) c.E.quit();
    }, draw: function () { c.E.pad.draw(); } } }, 's');
    check('pad.stick: centro flutua no press, arrasto vira x 0..1 + dir; solta zera',
          reg[0].x === 0 && reg[1].x > 0.3 && reg[2].x === 1 && reg[2].dir === 'right' &&
          reg[3].x === 0 && reg[3].dir === null, JSON.stringify(reg.slice(0, 4)));
    check('pad: tap seco na zona = stick.tap; botao pressed 1 quadro, down enquanto segura',
          reg[5].tap === true && reg[6].bp === true && reg[7].bp === false && reg[7].bd === true &&
          reg[8].bd === false, JSON.stringify(reg.slice(5, 9)));

    // ------------------------------------------------------------ level --
    c = fresh(['level', 'tilemap'], { save: 'lv.' });
    var lv = c.E.level.parse('\n#####\n#@.o#\n#####\n', {
        legend: { '#': 'parede', '.': null, '@': { spawn: 'heroi' }, 'o': { spawn: 'moeda', tile: 'chao' } },
        cell: 16 });
    var her = lv.find('heroi');
    check('level.parse: dimensoes, cenario, spawns com centro em px, tile sob a entidade',
          lv.cols === 5 && lv.rows === 3 && lv.get(0, 0) === 'parede' && lv.get(1, 1) === null &&
          lv.get(3, 1) === 'chao' && her.x === 24 && her.y === 24 && lv.all('moeda').length === 1 &&
          lv.spawns.length === 2, JSON.stringify(lv.spawns));
    var errL = null;
    try { c.E.level.parse(['##', '#X'], { legend: { '#': 1 } }); } catch (e) { errL = String(e.message); }
    check('level.parse: caractere fora da legenda lanca com linha e coluna',
          errL && errL.indexOf('"X"') >= 0 && errL.indexOf('linha 2, coluna 2') >= 0, errL);
    var criados = lv.spawn({ heroi: function (s) { return { k: 'h', x: s.x }; } });
    var tmL = c.E.tilemap({ cols: lv.cols, rows: lv.rows, cell: 16, data: lv.data,
                            solid: function (v) { return v === 'parede'; }, paint: function () {} });
    check('level.spawn (tipo sem fabrica ignorado) + data direto no tilemap',
          criados.length === 1 && criados[0].x === 24 && tmL.solidAt(2, 2) && !tmL.solidAt(24, 24));
    var pg = c.E.level.progress(['f1', 'f2', 'f3'], { save: 'prog' });
    var trancada = pg.go(2);
    pg.next();
    var pg2 = c.E.level.progress(['f1', 'f2', 'f3'], { save: 'prog' });
    pg2.stars(1, 2);
    check('level.progress: fase trancada recusa, next desbloqueia e SALVA, stars so melhora',
          !trancada && pg.cur === 1 && pg2.unlocked === 1 && pg2.go(1) && pg2.def() === 'f2' &&
          pg2.stars(1, 1) === false && pg2.stars(1) === 2);

    // ----------------------------------------------- core 1.2: pilha ----
    c = fresh();
    var marcas = [], fpp = 0, sujaApos = null;
    runScenes(c, {
        jogo: { enter: function () { marcas.push('enter'); c.E.dirty.enable(0x0000); },
                pause: function () { marcas.push('pause'); },
                resume: function () { marcas.push('resume'); sujaApos = c.E.dirty.on; },
                exit: function () { marcas.push('exit'); },
                update: function () {
                    fpp++;
                    if (fpp === 2) c.E.push('inv');
                    if (fpp === 5) c.E.push('inv');
                    if (fpp === 9) c.E.goto('fim');
                }, draw: function () {} },
        inv: { enter: function () { marcas.push('inv.in:' + c.E.depth()); },
               exit: function () { marcas.push('inv.out'); },
               update: function () { fpp++; if (fpp === 4 || fpp === 7) c.E.pop(); } },
        fim: { enter: function () { marcas.push('fim:' + c.E.depth()); c.E.quit(); } }
    }, 'jogo');
    check('E.push/E.pop: pause/resume sem exit/enter, camada suja de volta, goto esvazia a pilha',
          marcas.join(',') === 'enter,pause,inv.in:1,inv.out,resume,pause,inv.in:1,inv.out,resume,exit,fim:0' &&
          sujaApos === true, marcas.join(','));

    c = fresh();
    var disparos = 0, twObj = { x: 0 }, tc = c.S.millis();
    runScenes(c, {
        a: { cleanup: true,
             enter: function () { c.E.every(30, function () { disparos++; }); c.E.tween(twObj, { x: 100 }, 1000); },
             update: function () { if (c.S.millis() - tc > 100) c.E.goto('b'); } },
        b: { update: function () { if (c.S.millis() - tc > 600) c.E.quit(); } }
    }, 'a');
    var dispSaida = disparos;
    check('cena {cleanup: true}: timers e tweens dela morrem na saida',
          dispSaida > 0 && dispSaida <= 5 && twObj.x < 50 && c.E._timers.every(function (t) { return t.dead; }),
          'disparos=' + disparos + ' x=' + twObj.x);
    var o5 = { x: 0, y: 0 };
    c.E.tween(o5, { x: 1 }, 100); c.E.tween(o5, { y: 1 }, 100); c.E.tween({ z: 0 }, { z: 1 }, 100);
    check('E.killTweensOf mata so os do obj', c.E.killTweensOf(o5) === 2 && c.E.killTweensOf(o5) === 0);

    // ------------------------------------------------ core 1.2: math ----
    var mm = c.E.m;
    var nOk = true, cont = true;
    for (i = 0; i < 200; i++) {
        var nv = mm.noise(i * 0.37, i * 0.11, 9);
        if (!(nv >= 0 && nv <= 1)) nOk = false;
        if (Math.abs(mm.noise(i * 0.01, 0, 3) - mm.noise(i * 0.01 + 0.01, 0, 3)) > 0.1) cont = false;
    }
    check('m.noise: 0..1, deterministico, suave, seed muda',
          nOk && cont && mm.noise(3.3, 1.7, 4) === mm.noise(3.3, 1.7, 4) &&
          mm.noise(3.3, 1.7, 4) !== mm.noise(3.3, 1.7, 5) && mm.noise(2, 5) === mm.noise(2, 5, 0));
    check('m.lerpAngle pelo caminho curto + m.snap',
          near(mm.lerpAngle(0.1, Math.PI * 2 - 0.1, 0.5), 0) && mm.snap(23, 16) === 16 && mm.snap(25, 16) === 32);

    // --------------------------------------- core 1.2: input/grupo/cam ----
    c = fresh();
    c.H.pushTouch([{ x: 5, y: 5, touched: 1 }, { x: 5, y: 5, touched: 1 }, { x: 5, y: 5, touched: 1 },
                   { x: 5, y: 5, touched: 0 }]);
    var helds = [];
    runScenes(c, { s: { update: function () { helds.push(c.E.input.heldMs); if (helds.length >= 4) c.E.quit(); } } }, 's');
    check('input.heldMs cresce com o dedo pousado e zera ao soltar',
          helds[0] === 0 && helds[1] > 0 && helds[2] > helds[1] && helds[3] === 0, helds.join(','));
    var g = c.E.group();
    g.add({ hp: 0 }); g.add({ hp: 5, n: 'x' }); g.add({ hp: 7, dead: true });
    var pl = c.E.pool(3, function () { return { hp: 9 }; });
    var sp = pl.spawn(function (o) { o.hp = 1; });
    check('group.find/countIf (ignora mortos) + pool.spawn(init)',
          g.find(function (o) { return o.hp > 0; }).n === 'x' && g.countIf() === 2 &&
          g.countIf(function (o) { return o.hp > 6; }) === 0 && sp.hp === 1);
    var cam = c.E.cam;
    cam.reset(); cam.x = 100; cam.y = 0;
    check('cam.inView: caixa dentro/fora da tela com folga',
          cam.inView(150, 10, 10, 10) && !cam.inView(0, 10, 10, 10) && cam.inView(80, 10, 10, 10, 15) &&
          !cam.inView(400, 10, 5, 5));
    cam.reset();
    var alvo = { x: 500, y: 500 };
    cam.follow(alvo, 1, { offset: { x: 40, y: 0 } });
    cam._tick(0.03);
    check('cam.follow {offset}: olha a frente do alvo', cam.x === 500 - c.E.W / 2 + 40, String(cam.x));

    // ------------------------------------------------ core 1.2: gfx -----
    c = fresh();
    var linhas = c.E.gfx.wrap('um dois tres quatro cinco seis sete oito nove dez', 60, { font: 1 });
    var multi = c.E.gfx.wrap('a\nb', 200, { font: 1 });
    check('gfx.wrap quebra por largura e por \\n',
          linhas.length > 2 && linhas.every(function (l) { return c.E.gfx.measure(l, { font: 1 }) <= 60 || l.indexOf(' ') < 0; }) &&
          multi.length === 2, JSON.stringify(linhas));
    c.H.log.length = 0;
    var hUsada = c.E.gfx.textBox('um dois tres quatro cinco seis sete oito nove dez', 0, 0, 60,
                                 { font: 1, lh: 10, max: 2 });
    check('gfx.textBox: max linhas com "..." e altura usada',
          hUsada === 20 && c.H.log.length === 2 && /\.\.\.$/.test(c.H.log[1]), JSON.stringify(c.H.log));
    var tris = 0, ft = c.S.fillTriangle;
    c.S.fillTriangle = function () { tris++; return ft.apply(null, arguments); };
    c.E.gfx.poly([0, 0, 10, 0, 12, 8, 5, 12, -2, 8], 0xFFFF);
    check('gfx.poly: pentagono = 3 triangulos', tris === 3, 'tris=' + tris);
    c.H.log.length = 0;
    c.E.gfx.text('SOMBRA', 10, 10, { shadow: 0x0000 });
    check('gfx.text {shadow}: desenha a sombra e o texto', c.H.log.length === 2 && c.H.log[0] === 'SOMBRA');

    // ------------------------------------------- core 1.2: audio/save ----
    var sfxN = 0;
    c = fresh([], { save: 's.' }, function (env) {
        env.System.sfx = function () { sfxN++; return true; };
    });
    c.E.audio.sfx('coin'); c.E.audio.sfx('coin'); c.E.audio.sfx('hit'); c.E.audio.sfx('coin', { gap: 0 });
    c.S.delay(60);
    c.E.audio.sfx('coin');
    check('audio.sfx: intervalo minimo por nome (rajada vira 1), gap 0 libera',
          c.E.caps.mix && sfxN === 4, 'n=' + sfxN);
    check('save.inc: contador persistente', c.E.save.inc('mortes') === 1 && c.E.save.inc('mortes', 4) === 5 &&
          c.E.save.num('mortes', 0) === 5);

    // ---------------------------------------------- fx/spr/tilemap/sfx ----
    c = fresh(['fx']);
    var shk = 0, sh0 = c.E.cam.shake;
    c.E.cam.shake = function () { shk++; return sh0.apply(c.E.cam, arguments); };
    var okP = c.E.fx.play('explosao', 50, 50);
    var vivas = c.E.fx._live;
    check('fx.play: receita semeia burst + anel + shake; nome desconhecido = false',
          okP && vivas === 19 && shk === 1 && c.E.fx.play('nada', 0, 0) === false &&
          c.E.fx.play('faisca', 0, 0, { n: 2 }) && c.E.fx._live === 21, 'vivas=' + vivas);

    c = fresh(['spr']);
    var regs = c.E.spr.grid('heroi', { cols: 4, rows: 2, tw: 8, th: 8, paint: function () {} });
    var fr8 = c.E.spr.frames('heroi', 0, 7);
    check('spr.grid nomeia prefix+indice; spr.frames da a lista (e ao contrario)',
          Object.keys(regs).length === 8 && regs.heroi5.rx === 8 && regs.heroi5.ry === 8 &&
          fr8.length === 8 && fr8[7] === 'heroi7' && c.E.spr.frames('h', 2, 0).join() === 'h2,h1,h0');

    c = fresh(['tilemap']);
    var tmF = c.E.tilemap({ cols: 6, rows: 4, cell: 8, paint: function () {} });
    tmF.fill(1, 1, 3, 2, 'agua');
    check('tilemap.fill marca o retangulo + find por valor e por fn',
          tmF.dirty() === 6 && tmF.find('agua').length === 6 &&
          tmF.find(function (v, cc) { return v === 'agua' && cc === 3; }).length === 2);

    var SFX = require(path.join(ENGINE_DIR, 'celeros.sfx.js'));
    var arp = SFX.arpejo(440, [0, 12, null, 7], 50);
    check('sfx.arpejo: semitons sobre a base, null = pausa',
          arp.length === 4 && arp[0][0] === 440 && arp[1][0] === 880 && arp[2][0] === 0 &&
          arp[3][0] === 659 && arp[3][1] === 50, JSON.stringify(arp));

    // --------------------------------------------------- gates do SDK -----
    // todo membro publico dos modulos novos tem tipo no d.ts dele
    c = fresh(['fsm', 'events', 'path', 'collide', 'pad', 'level', 'tilemap']);
    var E = c.E;
    function dts(n) { return fs.readFileSync(path.join(ENGINE_DIR, n + '.d.ts'), 'utf8'); }
    function faltam(obj, txt, pre) {
        return Object.keys(obj).filter(function (k) {
            return k.charAt(0) !== '_' && !new RegExp('\\b' + k + '\\b').test(txt);
        }).map(function (k) { return pre + k; });
    }
    var fsmObj = E.fsm({}, { a: {} }, 'a');
    var mapa = [
        [fsmObj, 'celeros.game.fsm', 'fsm().'], [E.bus(), 'celeros.game.events', 'bus().'],
        [E.on('q', function () {}), 'celeros.game.events', 'sub.'],
        [E.path, 'celeros.game.path', 'E.path.'],
        [E.path.follower({ x: 0, y: 0 }, [], 1), 'celeros.game.path', 'follower().'],
        [E.collide, 'celeros.game.collide', 'E.collide.'], [E.collide.hash(8), 'celeros.game.collide', 'hash().'],
        [E.pad, 'celeros.game.pad', 'E.pad.'], [E.pad.stick({}), 'celeros.game.pad', 'stick().'],
        [E.pad.button({ x: 0, y: 0, r: 1 }), 'celeros.game.pad', 'button().'],
        [E.level, 'celeros.game.level', 'E.level.'],
        [E.level.parse(['.'], { legend: { '.': 0 } }), 'celeros.game.level', 'level().'],
        [E.level.progress(['a']), 'celeros.game.level', 'progress().']
    ];
    var semTipo = [];
    mapa.forEach(function (row) { semTipo = semTipo.concat(faltam(row[0], dts(row[1]), row[2])); });
    // decoracoes no E: cada uma no d.ts do modulo que a cria
    var decor = { fsm: 'celeros.game.fsm', bus: 'celeros.game.events', events: 'celeros.game.events',
                  on: 'celeros.game.events', once: 'celeros.game.events', off: 'celeros.game.events',
                  emit: 'celeros.game.events', emitLater: 'celeros.game.events' };
    Object.keys(decor).forEach(function (k) {
        if (!new RegExp('\\b' + k + '\\b').test(dts(decor[k]))) semTipo.push('E.' + k);
    });
    check('d.ts dos modulos novos cobrem todo membro publico', semTipo.length === 0, semTipo.join(', '));

    // aresta de require (no FONTE) x index.json: dep usada sem declarar
    // quebra o install do hub (o fecho transitivo nao a traz)
    var idx = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, 'index.json'), 'utf8'));
    var furos = [];
    fs.readdirSync(ENGINE_DIR).filter(function (f) { return /^celeros\..*\.js$/.test(f); }).forEach(function (f) {
        var nome = f.replace(/\.js$/, '');
        var src = fs.readFileSync(path.join(ENGINE_DIR, f), 'utf8').replace(/\/\/.*$/gm, '');
        var re = /require\(\s*['"]([^'"]+)['"]\s*\)/g, mt;
        while ((mt = re.exec(src))) {
            var dep = mt[1].replace(/\.js$/, '');
            if (!idx[nome] || !idx[nome].deps || !idx[nome].deps[dep]) furos.push(nome + ' -> ' + dep);
        }
    });
    check('index.json declara toda aresta de require dos modulos da engine', furos.length === 0,
          furos.join(', '));
    // modulo com d.ts deve ter o tipo valido como TS: interface dentro de
    // literal de objeto (o erro antigo do fx/ui) quebra o arquivo todo no editor
    var ruins = fs.readdirSync(ENGINE_DIR).filter(function (f) { return /\.d\.ts$/.test(f); }).filter(function (f) {
        var lines = fs.readFileSync(path.join(ENGINE_DIR, f), 'utf8').split('\n'), depth = 0, bad = false;
        // conta chaves de literal: "const x: {" abre um literal; interface
        // dentro dele e invalida
        var lit = [];
        lines.forEach(function (ln) {
            var t = ln.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
            if (/^\s*interface\s/.test(t) && lit.length && lit[lit.length - 1]) bad = true;
            for (var q = 0; q < t.length; q++) {
                if (t[q] === '{') lit.push(/(const|let)\s+\w+\s*:\s*\{\s*$/.test(t.slice(0, q + 1)) || (lit.length && lit[lit.length - 1] && !/(interface|namespace)\s/.test(t)));
                else if (t[q] === '}') lit.pop();
            }
            depth = lit.length;
        });
        void depth;
        return bad;
    });
    check('nenhum d.ts da engine declara interface dentro de literal de objeto', ruins.length === 0,
          ruins.join(', '));
};
