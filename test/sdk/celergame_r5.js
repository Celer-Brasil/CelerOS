// Testes da rodada 5 da CelerGame: o que veio do estudo do deki-engine —
// A0 group.remove dentro do update, A1 pacing em microssegundos, A2 E.prof,
// A3 dispose() de cena + E.slots, A4 falha barato/barulhenta do spr,
// A5 E.ax/E.ay/E.anchor, A6 E.spr.meta/animOf/box. Plugado no test/sdk/run.js:
//   require('./celergame_r5.js')(check);

'use strict';
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
    // roda a cena ate n quadros (o quit para o loop no meio do update)
    function frames(c, n, onFrame) {
        var q = 0;
        c.E.run({ s: { update: function (dt) {
            if (onFrame) onFrame(q, dt);
            if (++q >= n) c.E.quit();
        } } }, 's');
    }
    function near(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }

    console.log('SDK CelerGame rodada 5 (A0-A6 do estudo do deki-engine):');

    // ------------------------------------ A0: remove() dentro do update --
    var c = fresh();
    var hits = {};
    var g = c.E.group();
    ['A', 'B', 'C'].forEach(function (n) {
        g.add({ n: n, update: function () {
            hits[n] = (hits[n] || 0) + 1;
            if (n === 'C') g.remove(g.items[0]);   // despawn do 1o, no meio do laco
        } });
    });
    g.update(0.016);
    check('A0: group.remove no update — cada entidade roda 1x e a removida sai',
          hits.A === undefined && hits.B === 1 && hits.C === 1 &&
          g.count === 2 && g.items.length === 2,
          JSON.stringify(hits) + ' count=' + g.count);
    // fora do update continua removendo na hora
    var g2 = c.E.group();
    var o1 = g2.add({}), o2 = g2.add({});
    check('A0: group.remove fora do update remove na hora',
          g2.remove(o1) === true && g2.count === 1 && g2.items[0] === o2 &&
          g2.remove(o1) === false);

    // ------------------------------------------- A1: pacing em micros --
    function dtMedio(fps, n) {
        var cc = fresh([], { fps: fps });
        var soma = 0, q = 0;
        frames(cc, n, function (i, dt) { if (i > 0) soma += dt; });
        return soma / (n - 1);
    }
    var d30 = dtMedio(30, 40), d60 = dtMedio(60, 80);
    check('A1: 30 fps pede 33.3 ms por quadro (nao 33 com piso em ms)',
          near(d30, 1 / 30, 0.0015), d30.toFixed(5));
    check('A1: 60 fps pede 16.7 ms (o piso de 16 ms dava ~62 fps)',
          near(d60, 1 / 60, 0.0008), d60.toFixed(5));

    // ------------------------------------------------ A2: perfilador --
    c = fresh();
    check('A2: profiler desligado por padrao e nao conta nada',
          c.E.prof.on === false && c.E.prof.n === 0 && c.E.prof.frame === 0);
    c.E.prof.on = true;
    frames(c, 40, function () { c.S.delay(2); });
    var snap = c.E.prof.snapshot();
    check('A2: E.prof mede update/draw em us e publica a janela de 30 quadros',
          snap.update >= 1500 && snap.update <= 4000 && snap.draw >= 0 &&
          snap.frame >= snap.update && snap.fps >= 0 && snap.maxFrame >= snap.frame,
          JSON.stringify(snap));
    c.E.prof.reset();
    check('A2: E.prof.reset zera a janela e snapshot continua legivel',
          c.E.prof.n === 0 && c.E.prof.update === 0 && c.E.prof.frame === 0 &&
          typeof c.E.prof.snapshot().draw === 'number');

    // ------------------------------------- A3: dispose + ledger de slots --
    c = fresh();
    var logs = [];
    c.S.print = function (s) { logs.push(String(s)); };
    var disp = { a: 0, b: 0, c: 0 };
    c.E.run({
        a: { update: function () { c.E.goto('b'); }, dispose: function () { disp.a++; } },
        b: { update: function () { c.E.push('c'); }, dispose: function () { disp.b++; } },
        c: { update: function () { c.E.pop(); c.E.quit(); }, dispose: function () { disp.c++; } }
    }, 'a');
    check('A3: dispose() roda ao sair (goto/quit) e NAO roda no push (cena pausada)',
          disp.a === 1 && disp.b === 1 && disp.c === 1, JSON.stringify(disp));

    c = fresh();
    logs = [];
    c.S.print = function (s) { logs.push(String(s)); };
    var ids = [], i;
    for (i = 0; i < c.E.caps.slots + 1; i++) ids.push(c.E.slots.create('teste' + i, 8, 8));
    var rep = c.E.slots.report();
    check('A3: E.slots conta o pool, recusa o excedente e nomeia o dono no log',
          ids[c.E.caps.slots] === 0 && rep.used === c.E.caps.slots &&
          rep.cap === c.E.caps.slots && rep.owners.teste0 === 1 &&
          logs.join('|').indexOf('sem slot de sprite para teste' + c.E.caps.slots) >= 0,
          JSON.stringify(rep) + ' log=' + logs.join('|'));
    for (i = 0; i < 2; i++) c.E.slots.release(ids[i]);
    check('A3: E.slots.release devolve ao pool e sai do relatorio de donos',
          c.E.slots.n() === c.E.caps.slots - 2 && c.E.slots.report().used === c.E.caps.slots - 2);

    // --------------------------------- A4: nova alocacao fala no log -----
    c = fresh(['spr']);
    var logs4 = [];
    c.S.print = function (s) { logs4.push(String(s)); };
    for (i = 0; i < c.E.caps.slots; i++) c.E.slots.create('enche' + i, 4, 4);
    c.E.spr.load([{ name: 'semNada', w: 8, h: 8 }]);          // sem slot e sem paint
    var aviso = logs4.join('|');
    check('A4: sprite sem slot e sem paint avisa no log (era silencio)',
          aviso.indexOf('sem slot de sprite para spr:semNada') >= 0 ||
          aviso.indexOf('sem slot e sem paint') >= 0, aviso);
    // com painter, o mesmo caso nao e' erro: desenha pelo painter
    var logs4b = [];
    c.S.print = function (s) { logs4b.push(String(s)); };
    var out = c.E.spr.load([{ name: 'pintado', w: 8, h: 8, paint: function () {} }]);
    check('A4: def com paint continua funcionando sem slot (fallback silencioso)',
          !!out.pintado && !out.pintado.id && typeof out.pintado.paint === 'function' &&
          logs4b.join('|').indexOf('pintado sem slot e sem paint') < 0, logs4b.join('|'));

    // ------------------------------------------- A5: HUD ancorado --------
    c = fresh([], {}, function (env) {
        var gi = env.System.getInfo;
        env.System.getInfo = function () { var o = gi(); o.inset = 8; return o; };
    });
    var E5 = c.E;
    check('A5: E.inset vem do firmware (8 nas coords de 240, U = 1)',
          E5.inset === 8 && E5.W === 240 && E5.H === 320, 'inset=' + E5.inset);
    check('A5: ax nos 9 pontos (margem segura nas bordas)',
          E5.ax(0, 4, 50) === 12 && E5.ax(1, 0, 100) === 70 && E5.ax(2, 4, 50) === 178,
          [E5.ax(0, 4, 50), E5.ax(1, 0, 100), E5.ax(2, 4, 50)].join(','));
    check('A5: ay nos 9 pontos (topo, meio, base)',
          E5.ay(0, 5, 20) === 5 && E5.ay(4, 0, 20) === 150 && E5.ay(8, 5, 20) === 295,
          [E5.ay(0, 5, 20), E5.ay(4, 0, 20), E5.ay(8, 5, 20)].join(','));
    var out5 = { x: 0, y: 0, w: 0, h: 0 };
    var box5 = E5.anchor(8, 4, 4, 100, 30, out5);
    check('A5: E.anchor devolve a caixa e reaproveita o out (sem alocar por quadro)',
          box5 === out5 && box5.x === 128 && box5.y === 286 &&
          box5.w === 100 && box5.h === 30, JSON.stringify(box5));

    // ------------------------------------------ A6: metadados de arte ----
    c = fresh(['spr']);
    var E6 = c.E;
    var meta = {
        file: 'heroi', cols: 4, rows: 2, tw: 16, th: 16, prefix: 'h',
        anims: { idle: [0, 1], run: [4, 5, 6, 7], atk: ['extra'] },
        fps: { run: 12 }, loop: { atk: false },
        ax: 0.5, ay: 1, hitbox: [2, 4, 12, 10]
    };
    E6.spr.meta('heroi', meta);
    check('A6: E.spr.meta registra o metadado e monta a grade (prefixo+indice)',
          E6.spr.meta('heroi') === meta && !!E6.spr._slots.h0 && !!E6.spr._slots.h7 &&
          E6.spr._slots.h0.w === 16 && E6.spr._slots.h0.h === 16);
    var an1 = E6.spr.animOf('heroi', 'run');
    check('A6: animOf monta o E.anim do clipe (frames, fps e loop do metadado)',
          an1 && an1.frames.join(',') === 'h4,h5,h6,h7' && an1.fps === 12 && an1.loop === true,
          an1 && (an1.frames.join(',') + ' fps=' + an1.fps + ' loop=' + an1.loop));
    var an2 = E6.spr.animOf('heroi', 'atk');
    check('A6: clipe sem loop no metadado para no ultimo quadro',
          an2 && an2.frames.join(',') === 'extra' && an2.loop === false && an2.fps === 6);
    check('A6: ancora do metadado vale como default do slot (blit/stamp)',
          E6.spr._slots.h0.ax === 0.5 && E6.spr._slots.h0.ay === 1);
    var out6 = [0, 0, 0, 0];
    var b1 = E6.spr.box('heroi', 100, 200, 1, out6);
    var b2 = E6.spr.box('heroi', 100, 200, 2);
    check('A6: E.spr.box usa a MESMA origem do blit (ancora) e escala a hitbox',
          b1 === out6 && b1.join(',') === '94,188,12,10' &&
          b2.join(',') === '88,176,24,20',
          (b1 && b1.join(',')) + ' / ' + (b2 && b2.join(',')));
    var muitos = { fada: { cols: 2, rows: 1, tw: 8, th: 8, prefix: 'f',
                           anims: { voa: [0, 1] } } };
    E6.spr.meta(muitos);
    check('A6: E.spr.meta({mapa}) registra varios de uma vez',
          !!E6.spr._slots.f0 && E6.spr.animOf('fada', 'voa').frames.join(',') === 'f0,f1');
};
