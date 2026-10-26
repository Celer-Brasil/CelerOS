// Testes da rodada 7 da CelerGame — a rodada 2 do estudo do deki-engine:
// rotação e escala por eixo no spr, culling no group/pool, geração de slot,
// E.slots.fit, hierarquia (celeros.game.node), pai na cena e os ganchos de
// sono (E.onSleep/onWake sobre System.isScreenOn).
// Plugado no test/sdk/run.js:  require('./celergame_r7.js')(check);

'use strict';
var path = require('path');
var ROOT = path.resolve(__dirname, '..', '..');
var ENGINE_DIR = path.join(ROOT, 'tools', 'sdk', 'engine');

module.exports = function (check) {
    var harness = require('../js_harness/run.js');

    function fresh(mods, initOpts) {
        var env = harness.makeEnv();
        var req = harness.makeRequire(ENGINE_DIR, env);
        var E = req('celeros.game');
        (mods || []).forEach(function (m) { req('celeros.game.' + m); });
        E.init(initOpts || {});
        return { E: E, env: env, S: env.System };
    }
    function spyDraw(c) {
        var calls = [];
        c.S.drawSprite = function (id, x, y, a, zx, zy, key) {
            calls.push([id, x, y, a, zx, zy, key]);
            return 1;
        };
        return calls;
    }
    // sprite "real" num slot fingido (o harness devolve sempre o id 1)
    function sprite(c, nome, w, h, ax, ay) {
        c.E.spr.load([{ name: nome, w: w, h: h, paint: function () {} }]);
        var s = c.E.spr._slots[nome];
        s.id = 1;
        s.gen = c.E.slots.gen(1);
        s.paint = null;
        if (ax !== undefined) { s.ax = ax; s.ay = ay; }
        return s;
    }

    console.log('SDK CelerGame rodada 7 (rotacao/escala, culling, no, sono):');

    // ------------------------------------------- rotação no spr ----------
    var c = fresh(['spr']);
    var calls = spyDraw(c);
    sprite(c, 'h', 16, 16, 0.5, 1);
    c.E.spr.stamp('h', 100, 200, { angle: 90 });
    check('spr: giro 90 com ancora pe no chao poe o CENTRO em (x+8, y)',
          calls.length === 1 && calls[0][1] === 108 && calls[0][2] === 200 && calls[0][3] === 90,
          JSON.stringify(calls[0]));
    // ancora no centro: o centro e' o proprio ponto
    c.E.spr.stamp('h', 40, 40, { ax: 0.5, ay: 0.5, angle: 45 });
    check('spr: giro com ancora central nao desloca o centro',
          calls[1][1] === 40 && calls[1][2] === 40, JSON.stringify(calls[1]));
    // blit com angulo sai do copySprite e vai pelo afim
    var copies = 0;
    c.S.copySprite = function () { copies++; };
    c.E.spr.blit('h', 10, 10, { angle: 30 });
    check('spr: blit com {angle} delega ao stamp (copySprite nao gira)',
          copies === 0 && calls.length === 3 && calls[2][3] === 30,
          'copies=' + copies + ' calls=' + calls.length);
    // caixa suja girada: AABB de 16x16 a 45 graus (~22.6 de lado)
    c.E.dirty.on = true;
    c.E.dirty._cur.length = 0;
    c.E.spr.stamp('h', 50, 50, { ax: 0.5, ay: 0.5, angle: 45 });
    var box = c.E.dirty._cur.slice(-4);
    check('spr: caixa suja do giro e o AABB dos cantos (16x16 a 45 -> ~23)',
          box[2] >= 22 && box[2] <= 26 && box[3] >= 22 && box[3] <= 26,
          JSON.stringify(box));
    // escala por eixo
    calls.length = 0;
    c.E.spr.stamp('h', 60, 60, { ax: 0.5, ay: 0.5, scaleX: 2, scaleY: 1 });
    check('spr: escala por eixo vai ao drawSprite como zoomX/zoomY',
          calls.length === 1 && calls[0][4] === 2 && calls[0][5] === 1,
          JSON.stringify(calls[0]));
    c.E.dirty._cur.length = 0;
    c.E.spr.stamp('h', 60, 60, { ax: 0.5, ay: 0.5, scaleX: 2, scaleY: 1 });
    var box2 = c.E.dirty._cur.slice(-4);
    check('spr: caixa suja acompanha a escala por eixo (32x16 + folga)',
          box2[2] === 34 && box2[3] === 18, JSON.stringify(box2));

    // box com giro: hitbox [2,6,12,4] do quadro 16x16, ancora .5/.5, 90 graus
    c.E.spr.meta('m', { ax: 0.5, ay: 0.5, hitbox: [2, 6, 12, 4] });
    c.E.spr.load([{ name: 'm', w: 16, h: 16, paint: function () {} }]);
    c.E.spr._slots.m.id = 1; c.E.spr._slots.m.paint = null;
    c.E.spr._slots.m.ax = 0.5; c.E.spr._slots.m.ay = 0.5;
    var hb = c.E.spr.box('m', 100, 100, { angle: 90 });
    check('spr.box: hitbox girada devolve o AABB (12x4 a 90 -> 4x12)',
          hb && hb[0] === 98 && hb[1] === 94 && hb[2] === 4 && hb[3] === 12,
          hb && hb.join(','));

    // região de folha nao gira (o drawSprite nao recorta a origem): aviso
    var logs = [];
    c.S.print = function (s) { logs.push(String(s)); };
    c.E.spr.sheet('sh', { w: 64, h: 64, tw: 16, th: 16, regions: { r0: [0, 0] },
                          paint: function () {} });
    c.E.spr._sheets.sh.id = 1; c.E.spr._sheets.sh.gen = c.E.slots.gen(1);
    calls.length = 0; copies = 0;
    c.E.spr.stamp('r0', 20, 20, { angle: 30 });
    check('spr: regiao de folha com {angle} avisa e desenha SEM giro',
          calls.length === 0 && copies === 1 &&
          logs.join('|').indexOf('regiao de folha nao gira') >= 0,
          'calls=' + calls.length + ' copies=' + copies);

    // --------------------------------------------- culling --------------
    c = fresh(['spr']);
    var desenhados = [];
    var g = c.E.group();
    function ent(x, y, w, h, nome, screen) {
        var e = { x: x, y: y, nome: nome, draw: function () { desenhados.push(nome); } };
        if (w !== undefined) { e.w = w; e.h = h; }
        if (screen) e.screen = true;
        return e;
    }
    g.add(ent(10, 10, 20, 20, 'vis'));
    g.add(ent(900, 900, 20, 20, 'fora'));
    g.add(ent(900, 900, undefined, undefined, 'sem-extents'));
    g.add(ent(900, 900, 10, 10, 'hud', true));
    g.draw({ cull: true });
    check('group.draw({cull}): pula fora, desenha sem-extents e HUD',
          desenhados.join(',') === 'vis,sem-extents,hud', desenhados.join(','));
    desenhados.length = 0;
    g.draw();
    check('group.draw() sem opcoes desenha tudo (default de sempre)',
          desenhados.length === 4);
    // pad traz o objeto que esta logo fora da borda
    desenhados.length = 0;
    g.clear();
    g.add(ent(250, 100, 20, 20, 'logo-fora'));   // comeca em 250 > 240
    g.draw({ cull: true });
    var semPad = desenhados.length;
    g.draw({ cull: true, pad: 10 });
    check('group.draw({cull, pad}): pad inclui o que esta logo fora da borda',
          semPad === 0 && desenhados.length === 1, 'semPad=' + semPad);
    // pool
    desenhados.length = 0;
    var pl = c.E.pool(2, function (i) {
        return { x: i ? 900 : 10, y: 10, w: 10, h: 10, dead: true,
                 draw: function () { desenhados.push('p' + i); } };
    });
    pl.spawn(); pl.spawn();
    pl.draw({ cull: true });
    check('pool.draw({cull}): mesmo criterio do grupo', desenhados.join(',') === 'p0');

    // ---------------------------------------- geração de slot -----------
    c = fresh(['spr']);
    logs = [];
    c.S.print = function (s) { logs.push(String(s)); };
    var id1 = c.E.slots.create('t', 8, 8);
    var g1 = c.E.slots.gen(id1);
    var sOld = { id: id1, w: 8, h: 8, gen: g1, paint: null };
    c.E.slots.release(id1);
    var id2 = c.E.slots.create('t', 8, 8);
    var g2 = c.E.slots.gen(id2);
    c.E.spr._slots.velho = sOld;
    c.E.dirty.on = true;
    c.E.spr.blit('velho', 10, 10);
    check('E.slots.gen muda na realocacao e o spr recusa o slot reciclado',
          g2 !== g1 && logs.join('|').indexOf('slot reciclado') >= 0,
          'gen ' + g1 + '->' + g2 + ' log=' + logs.join('|'));
    var copies2 = 0;
    c.S.copySprite = function () { copies2++; };
    c.E.spr._slots.novo = { id: id2, w: 8, h: 8, gen: g2, paint: null };
    c.E.spr.blit('novo', 10, 10);
    check('slot com a geracao ATUAL desenha (a recusa e so do id velho)',
          copies2 === 1, 'copies=' + copies2);

    // --------------------------------------------- E.slots.fit ----------
    c = fresh(['spr']);
    var fPequeno = c.E.slots.fit(16, 16);
    var fGrande = c.E.slots.fit(2000, 2000);
    check('E.slots.fit: sprite pequeno cabe (16 bits) e o enorme nao, com motivo',
          fPequeno.ok === true && fPequeno.depth === 16 && fGrande.ok === false &&
          /bloco livre/.test(fGrande.motivo),
          JSON.stringify(fPequeno) + ' | ' + JSON.stringify(fGrande));
    c.E.slots.fit;   // sem efeito colateral
    check('E.slots.fit: estimativa escala com o tamanho fisico (bytes cresce)',
          c.E.slots.fit(100, 100).bytes > fPequeno.bytes * 20);

    // ------------------------------------------------ hierarquia --------
    c = fresh(['node']);
    var pai = { x: 100, y: 200 }, filho = { x: 0, y: 0 };
    c.E.node.attach(filho, pai, { ox: 10, oy: -20 });
    check('node: filho segue o pai com o offset local',
          filho.x === 110 && filho.y === 180, filho.x + ',' + filho.y);
    pai.x = 200;
    c.E.node.tick();
    check('node: mover o pai (escrevendo x) e tickar reposiciona o filho',
          filho.x === 210 && filho.y === 180, filho.x + ',' + filho.y);
    pai._no.rot = 90;
    c.E.node.tick();
    check('node: pai girado 90 gira o offset (10,-20) -> (20,10) e propaga a rotacao',
          Math.round(filho.x) === 220 && Math.round(filho.y) === 210 &&
          c.E.node.rotOf(filho) === 90,
          Math.round(filho.x) + ',' + Math.round(filho.y) + ' rot=' + c.E.node.rotOf(filho));
    check('node: ciclo barrado em attach (pai dentro do filho)',
          c.E.node.attach(pai, filho) === false);
    check('node: setPos muda o offset combinado e o tick aplica',
          c.E.node.setPos(filho, 0, 0) && (c.E.node.tick(), Math.round(filho.x) === 200));
    c.E.node.detach(filho);
    check('node: detach mantem a posicao e solta o pai',
          c.E.node.parentOf(filho) === null && Math.round(filho.x) === 200 &&
          Math.round(filho.y) === 200, filho.x + ',' + filho.y);
    check('node: leituras fora de um no devolvem o proprio x/y',
          c.E.node.wx({ x: 7, y: 9 }) === 7 && c.E.node.rotOf({ x: 0, y: 0 }) === 0);

    // --------------------------------------------- pai na cena ----------
    c = fresh(['node', 'scene']);
    c.E.scene.def('torre', { campos: [], create: function () { return {}; } });
    c.E.scene.def('cano', { campos: [], create: function () { return {}; } });
    var gr = c.E.group();
    var ents = c.E.scene.instantiate([
        { tipo: 'torre', x: 50, y: 60, nome: 't1' },
        { tipo: 'cano', x: 0, y: 0, nome: 'c1', pai: '#t1', ox: 5, oy: -8 }
    ], gr);
    check('scene: campo pai liga o filho pelo node antes do start',
          ents.length === 2 && c.E.node.parentOf(ents[1]) === ents[0] &&
          ents[1].x === 55 && ents[1].y === 52,
          ents[1].x + ',' + ents[1].y);
    c.E.node.setPos(ents[1], 7, -9);
    c.E.node.tick();
    var dados = c.E.scene.save(gr);
    check('scene.save: filho sai com pai e os offsets VIVOS (nao os do dado)',
          dados.entidades[1].pai === '#t1' && dados.entidades[1].ox === 7 &&
          dados.entidades[1].oy === -9, JSON.stringify(dados.entidades[1]));

    // ------------------------------------------------- sono ------------
    c = fresh();
    var ev = [], n = 0, offSleeps = 0, dts = [];
    var d0 = c.S.delay;
    // a volta e' contada em cima do ESTADO DA ENGINE (E.screenOn), nao do
    // System: o poll de 200 ms precisa ver o vidro apagado antes
    c.S.delay = function (ms) {
        if (c.E.screenOn === false) {
            if (++offSleeps === 3) c.env.__harness.setScreenOn(true);
        }
        return d0(ms);
    };
    c.E.onSleep = function () { ev.push('sleep'); };
    c.E.onWake = function () { ev.push('wake'); };
    c.E.run({ s: { update: function (dt) {
        dts.push(dt);
        if (n === 0) c.env.__harness.setScreenOn(false);
        if (++n >= 12) c.E.quit();   // o poll da tela e de 200 ms (~7 quadros)
    } } }, 's');
    // offSleeps > 0 prova o caminho de tela apagada (o delay(50) so roda ali)
    check('sono: onSleep/onWake na borda e o loop PARA de atualizar apagado',
          ev.join(',') === 'sleep,wake' && offSleeps >= 1 && c.E.screenOn === true,
          ev.join(',') + ' offSleeps=' + offSleeps);
    check('sono: no wake repinta tudo e o dt e reancorado (sem salto de minutos)',
          c.E.dirty._full === true && dts[dts.length - 1] < 0.2,
          'full=' + c.E.dirty._full + ' dt=' + dts[dts.length - 1]);

    // ------------------------------------- emulador: pixel girado -------
    (function () {
        var Rn = require(path.join(ROOT, 'tools', 'sdk', 'lib', 'renderer.js')).Renderer;
        var rr = new Rn();
        var S0 = {};
        rr.wire({ System: S0 });
        S0.setNativeCanvas && S0.setNativeCanvas(false);
        var id = S0.createSprite(2, 8);
        S0.useSprite(id);
        S0.fillScreen(0xF800);   // barra vertical vermelha
        S0.useSprite(0);
        S0.fillScreen(0x0000);
        S0.drawSprite(id, 100, 100, 90, 1, 1);
        var fb = rr.fb, w = rr.w;
        check('emulador: sprite 2x8 girado 90 fica HORIZONTAL (pixel)',
              fb[100 * w + 104] === 0xF800 && fb[104 * w + 100] === 0x0000,
              [fb[100 * w + 104], fb[104 * w + 100]].join());
    })();
};
