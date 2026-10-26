// Testes da rodada CelerGame core 1.1.0 / fx 1.1.0 / spr 1.1.0 /
// tilemap 1.1.0 / ui 1.1.0 / sfx 1.1.0 (+ o gate de drift dos d.ts).
// Plugado no test/sdk/run.js (mesmo check/contador de falhas):
//   require('./celergame_next.js')(check);
// Cada caso monta um env NOVO do harness (relogio virtual, touchQ) e o
// require real de tools/sdk/engine — o E de um caso nao vaza no outro.

'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..', '..');
var ENGINE_DIR = path.join(ROOT, 'tools', 'sdk', 'engine');

module.exports = function (check) {
    var harness = require('../js_harness/run.js');

    // E fresco (core + modulos pedidos) sobre um env novo
    function fresh(mods, initOpts) {
        var env = harness.makeEnv();
        var req = harness.makeRequire(ENGINE_DIR, env);
        var E = req('celeros.game');
        (mods || []).forEach(function (m) { req('celeros.game.' + m); });
        E.init(initOpts || {});
        return { E: E, env: env, S: env.System, H: env.__harness, req: req };
    }
    // roda o loop ate fn() devolver true (ou o teto de ms virtuais)
    function runUntil(c, scene, maxMs) {
        var t0 = c.S.millis();
        var up = scene.update;
        scene.update = function (dt) {
            if (up) up(dt);
            if (scene.until && scene.until()) c.E.quit();
            if (c.S.millis() - t0 > (maxMs || 5000)) c.E.quit();
        };
        c.E.run({ s: scene }, 's');
    }
    function near(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9); }

    console.log('SDK CelerGame 1.1 (core/fx/spr/tilemap/ui/sfx):');

    // ------------------------------------------------------------ math --
    var c = fresh();
    var m = c.E.m;
    check('m.wrap: multiplo exato abaixo cai em a (antes devolvia b)',
          m.wrap(-10, 0, 10) === 0 && m.wrap(-3, 0, 10) === 7 &&
          m.wrap(10, 0, 10) === 0 && m.wrap(23, 0, 10) === 3 && m.wrap(5, 0, 10) === 5,
          [m.wrap(-10, 0, 10), m.wrap(-3, 0, 10), m.wrap(10, 0, 10)].join(','));
    var ri = [], riOk = true;
    for (var i = 0; i < 300; i++) {
        var v = m.randInt(5);
        if (!(v >= 0 && v <= 5 && v === Math.floor(v))) riOk = false;
        ri[v] = 1;
    }
    check('m.randInt(n) de 1 arg: inteiros 0..n (antes NaN)',
          riOk && ri[0] && ri[5], JSON.stringify(ri));
    check('m.angDiff: caminho curto atravessando o zero',
          near(m.angDiff(0.1, Math.PI * 2 - 0.1), -0.2, 1e-9) &&
          near(m.angDiff(-3, 3), 6 - Math.PI * 2, 1e-9) && m.angDiff(1, 1) === 0);
    check('m.smoothstep: 0 / 0.5 / 1 nas bordas e no meio',
          m.smoothstep(0, 10, -1) === 0 && m.smoothstep(0, 10, 5) === 0.5 &&
          m.smoothstep(0, 10, 99) === 1);
    var eas = ['linear', 'inQuad', 'outQuad', 'inOutQuad', 'outBack', 'inCubic',
               'outCubic', 'inOutCubic', 'outElastic', 'outBounce'];
    var easBad = eas.filter(function (k) {
        return !(near(m[k](0), 0, 1e-6) && near(m[k](1), 1, 1e-6));
    });
    check('easings novos (cubic/elastic/bounce) vao de 0 a 1', easBad.length === 0,
          easBad.join(','));
    var r1 = c.E.rng(42), r2 = c.E.rng(42);
    var arrA = c.E.m.shuffle([1, 2, 3, 4, 5, 6], r1);
    var arrB = c.E.m.shuffle([1, 2, 3, 4, 5, 6], r2);
    check('m.shuffle com rng: deterministico e preserva os elementos',
          arrA.join() === arrB.join() && arrA.slice().sort().join() === '1,2,3,4,5,6',
          arrA.join());
    check('m.chance(p, rnd): 0 nunca, 1 sempre',
          !m.chance(0, r1) && m.chance(1, r1));
    var rr = c.E.rng(7), ints = {}, rngOk = true;
    for (i = 0; i < 400; i++) {
        var n = rr.int(1, 3);
        if (n < 1 || n > 3 || n !== Math.floor(n)) rngOk = false;
        ints[n] = 1;
        var f = rr.range(10, 20);
        if (f < 10 || f >= 20) rngOk = false;
    }
    check('rng.int (inclusivo) / rng.range / rng.pick',
          rngOk && ints[1] && ints[3] && ['a'].indexOf(rr.pick(['a'])) === 0 &&
          c.E.rng(9).int(4) <= 4, JSON.stringify(ints));

    // ----------------------------------------------------------- tweens --
    c = fresh();
    var o1 = {};
    c.E.tween(o1, { a: 10 }, 100);
    runUntil(c, { until: function () { return o1.a === 10; } }, 1000);
    check('tween de prop AUSENTE parte de 0 (antes NaN)', o1.a === 10, String(o1.a));

    c = fresh();
    var o2 = { x: 0 }, primeiro = null;
    c.E.tween(o2, { x: 100 }, 100, { delay: 200,
        onUpdate: function (ob) { if (primeiro === null) primeiro = ob.x; } });
    var t0 = c.S.millis();
    runUntil(c, {
        update: function () { if (c.S.millis() - t0 >= 100 && o2.x === 0) o2.x = 50; },
        until: function () { return o2.x === 100; }
    }, 2000);
    check('tween com delay le o "de" no INICIO (obj mudou durante o delay)',
          primeiro !== null && primeiro >= 50 && o2.x === 100, 'primeiro=' + primeiro);

    c = fresh();
    var o3 = { x: 0 }, upd = 0, fimYo = false;
    c.E.tween(o3, { x: 10 }, 100, { yoyo: true, repeat: 1,
        onUpdate: function () { upd++; }, onDone: function () { fimYo = true; } });
    var maxX = 0;
    runUntil(c, { update: function () { if (o3.x > maxX) maxX = o3.x; },
                  until: function () { return fimYo; } }, 2000);
    check('tween yoyo + repeat: vai ao alvo e VOLTA ao inicio, onUpdate por quadro',
          fimYo && maxX === 10 && o3.x === 0 && upd >= 4,
          'x=' + o3.x + ' max=' + maxX + ' upd=' + upd);

    // ----------------------------------------------- timers / pausa -----
    c = fresh();
    var nEvery = 0;
    c.E.every(50, function () { nEvery++; }, 3);
    runUntil(c, {}, 600);
    check('every(ms, fn, 3) dispara exatamente 3 vezes', nEvery === 3, 'n=' + nEvery);

    c = fresh();
    var disparou = -1, dts = [], tP = c.S.millis(), pausou = false;
    c.E.after(200, function () { disparou = c.S.millis() - tP; });
    runUntil(c, {
        update: function (dt) {
            var el = c.S.millis() - tP;
            if (el >= 50 && el < 600 && !c.E.paused && disparou < 0 && !pausou) {
                pausou = true;
                c.E.pause(true);
            }
            if (c.E.paused) dts.push(dt);
            if (el >= 600 && c.E.paused) c.E.pause(false);
        },
        until: function () { return disparou >= 0; }
    }, 3000);
    check('E.pause: update recebe dt 0 e o timer anda SO fora da pausa',
          disparou >= 700 && dts.length > 1 &&
          dts.slice(1).every(function (d) { return d === 0; }),
          'disparou=' + disparou + ' dts=' + dts.length);

    c = fresh();
    c.E.timeScale = 0.5;
    var dtsS = [];
    runUntil(c, { update: function (dt) { dtsS.push(dt); },
                  until: function () { return dtsS.length >= 5; } });
    var dtReal = Math.floor(1000 / 30) / 1000;
    check('E.timeScale escala o dt da cena',
          dtsS.slice(1).every(function (d) { return d > 0 && d <= dtReal * 0.5 + 0.002; }),
          JSON.stringify(dtsS));

    // ------------------------------------------------------------- goto --
    c = fresh();
    var errGoto = null;
    try {
        c.E.run({ a: { update: function () { c.E.goto('nada'); } }, b: {} }, 'a');
    } catch (e) { errGoto = String(e.message || e); }
    check('goto de cena inexistente falha NA HORA com a lista de cenas',
          errGoto && errGoto.indexOf('nada') >= 0 && errGoto.indexOf('a, b') >= 0, errGoto);

    // ----------------------------------------------------------- camera --
    c = fresh();
    var cam = c.E.cam, alvo = { x: 120, y: 160 };
    cam.follow(alvo, 1, { deadzone: { w: 40, h: 40 } });
    cam._tick(0.033);
    var x0 = cam.x;
    alvo.x = 135;                 // dentro da zona (meia largura 20)
    cam._tick(0.033);
    var dentro = cam.x;
    alvo.x = 170;                 // 50 do centro: camera anda 30
    cam._tick(0.033);
    check('cam deadzone: parada dentro da zona, anda so o excesso fora',
          dentro === x0 && near(cam.x - x0, 30, 1e-9), [x0, dentro, cam.x].join(','));
    cam.reset();
    cam.x = 37; cam.y = -12; cam.ox = 3;
    check('cam.worldX/worldY desfazem wx/wy (toque -> mundo)',
          cam.worldX(cam.wx(81)) === 81 && cam.worldY(cam.wy(44)) === 44);

    // ---------------------------------------------------- group / pool --
    c = fresh();
    var g = c.E.group();
    var ga = g.add({ y: 30, n: 'a' }), gb = g.add({ y: 10, n: 'b' }), gc = g.add({ y: 30, n: 'c' });
    g.add({ y: 20, n: 'd' });
    g.sort('y');
    var ord = g.items.map(function (q) { return q.n; }).join('');
    var rem = g.remove(gb);
    check('group.sort(prop) estavel + group.remove',
          ord === 'bdac' && rem && g.count === 3 && g.items.indexOf(gb) < 0 &&
          !g.remove(gb) && ga && gc, ord);
    var pl = c.E.pool(4, function (k) { return { k: k }; });
    var s1 = pl.spawn(), s2 = pl.spawn();
    s1.dead = true;
    var s3 = pl.spawn();
    check('pool.spawn com cursor: continua depois do ultimo (nao re-varre o comeco)',
          s1.k === 0 && s2.k === 1 && s3.k === 2, [s1.k, s2.k, s3.k].join(','));
    pl.spawn();               // k=3
    var s5 = pl.spawn();      // volta e acha o 0 morto
    check('pool.spawn da a volta e recicla o morto', s5 && s5.k === 0 && pl.spawn() === null);

    // ------------------------------------------------------------- save --
    c = fresh([], { save: 'tst.' });
    c.E.save.setObj('cfg', { som: false, nivel: 3, lista: [1, 2] });
    var cfg = c.E.save.obj('cfg', null);
    c.env.Storage.set('tst.podre', '{nao e json');
    c.E.save.del('cfg');
    check('save.obj/setObj (JSON) + del + JSON podre devolve def',
          cfg && cfg.som === false && cfg.nivel === 3 && cfg.lista[1] === 2 &&
          c.E.save.obj('podre', 'def') === 'def' && c.E.save.obj('cfg', 'x') === 'x',
          JSON.stringify(cfg));

    // ------------------------------------------------------------ input --
    c = fresh();
    var box = { x: 100, y: 100, w: 10, h: 10 };
    c.E.input.tap = { x: 113, y: 105 };
    check('hit(rect, pad): folga em volta do alvo pequeno',
          !c.E.hit(box) && c.E.hit(box, 4) && !c.E.hit(box, 2));
    c = fresh();
    c.H.pushTouch([{ x: 50, y: 50, touched: 1 }, { x: 50, y: 50, touched: 0 },
                   { x: 0, y: 0, touched: 0 },
                   { x: 54, y: 52, touched: 1 }, { x: 54, y: 52, touched: 0 },
                   { x: 0, y: 0, touched: 0 }, { x: 0, y: 0, touched: 0 }]);
    var taps = 0, dbl = null, fr = 0;
    runUntil(c, { update: function () {
        fr++;
        if (c.E.input.tap) taps++;
        if (c.E.input.doubleTap) dbl = c.E.input.doubleTap;
    }, until: function () { return fr >= 10; } });
    check('input.doubleTap: 2o tap seco perto e rapido', taps === 2 && dbl && dbl.x === 54,
          'taps=' + taps + ' dbl=' + JSON.stringify(dbl));

    // ------------------------------------------------------------ debug --
    c = fresh([], { debug: true });
    var fd = 0;
    runUntil(c, { draw: function () {}, update: function () { fd++; },
                  until: function () { return fd >= 3; } });
    check('E.debug (init {debug}) desenha o overlay de fps/ms',
          c.H.log.some(function (s) { return /fps \d+ms/.test(s); }),
          c.H.log.slice(-2).join('|'));

    // --------------------------------------------------------------- fx --
    c = fresh(['fx']);
    c.E.fx.burst(10, 10, { n: 0 });
    var vivas0 = c.E.fx._live;
    c.E.fx.burst(10, 10, { n: 5 });
    c.E.fx.popText(10, 100, '+1', { vy: 100 });
    c.E.fx.emitter({ x: 1, y: 1, rate: 50 });
    c.E.fx._tick(0.1);
    var yPop = c.E.fx._floaters[0].y;
    c.E.fx.flash(0xFFFF, 200);
    c.E.fx.clear();
    check('fx: burst {n: 0} nao semeia (antes 12); popText vy; fx.clear zera tudo',
          vivas0 === 0 && near(yPop, 90, 1e-9) && c.E.fx._live === 0 &&
          c.E.fx._floaters.length === 0 && c.E.fx._emitters.length === 0 &&
          c.E.fx._flashT === 0, 'vivas0=' + vivas0 + ' y=' + yPop);

    // -------------------------------------------------------------- spr --
    c = fresh(['spr']);
    var pintou = null;
    c.E.spr.load([{ name: 'h', w: 16, h: 24, paint: function (w, h, x, y) { pintou = [x, y]; } }]);
    // sem sprites nativos o painter recebe as coords — forca o caminho dele
    c.E.spr._slots.h.id = 0;
    c.E.spr.blit('h', 100, 200, { ax: 0.5, ay: 1 });
    var anc = pintou;
    c.E.spr.blit('h', 100, 200, { cx: true, cy: true });
    check('spr.blit ancora {ax, ay} (pe no chao) e cx/cy de antes; spr.size',
          anc && anc[0] === 92 && anc[1] === 176 && pintou[0] === 92 && pintou[1] === 188 &&
          c.E.spr.size('h').h === 24 && c.E.spr.size('x') === null,
          JSON.stringify([anc, pintou]));
    var an = c.E.anim(['a', 'b', 'c'], 10, 'pingpong'), seqI = [], voltas = 0;
    an.onEnd = function () { voltas++; };
    for (i = 0; i < 9; i++) { seqI.push(an.i); an.tick(0.1); }
    check('anim pingpong (0 1 2 1 0 ...) + onEnd por volta',
          seqI.join('') === '012101210' && voltas === 2, seqI.join('') + ' v=' + voltas);
    var one = c.E.anim(['a', 'b'], 10, false), fins = 0;
    one.onEnd = function () { fins++; };
    for (i = 0; i < 6; i++) one.tick(0.1);
    var antes = one.i;
    one.play(one.frames);         // mesmo clipe: nao recomeca
    var mesmo = one.i;
    one.play(['x', 'y', 'z']);    // clipe novo: recomeca
    var vazio = c.E.anim([], 10);
    vazio.tick(0.5);
    check('anim sem loop: onEnd 1 vez; play() do mesmo clipe nao reinicia; frames [] sem NaN',
          fins === 1 && one.done === false && antes === 1 && mesmo === 1 && one.i === 0 &&
          vazio.i === 0, [fins, antes, mesmo, one.i, vazio.i].join(','));

    // ---------------------------------------------------------- tilemap --
    c = fresh(['tilemap']);
    var pintadas = [];
    var mp = c.E.tilemap({ cols: 4, rows: 3, cell: 10,
                           data: ['#..#', '#..#', '####'],
                           solid: function (v) { return v === '#'; },
                           paint: function (cc, r) { pintadas.push(cc + ',' + r); } });
    var antesSet = mp.dirty();
    mp.set(1, 1, '#');
    mp.set(1, 1, '#');            // mesmo valor: nao remarca
    check('tilemap data (linhas string) + get/set marca a celula 1 vez',
          mp.get(0, 0) === '#' && mp.get(1, 0) === '.' && mp.get(9, 9) === undefined &&
          antesSet === 0 && mp.dirty() === 1 && mp.flush() === 1 && pintadas[0] === '1,1');
    check('tilemap solidAt / rectSolid / fora da grade = solido',
          mp.solidAt(5, 5) && !mp.solidAt(25, 5) && mp.solidAt(-1, 5) &&
          !mp.rectSolid(21, 1, 8, 8) && mp.rectSolid(21, 1, 8, 25) &&
          mp.cellRect(2, 1).x === 20 && mp.cellRect(2, 1).y === 10);

    // --------------------------------------------------------------- ui --
    c = fresh(['ui']);
    var resp = null, frC = 0;
    runUntil(c, {
        draw: function () { var a = c.E.ui.confirm('Sair sem salvar?', { title: 'Sair' }); if (a) resp = a; },
        update: function () {
            frC++;
            if (frC === 2) {
                // acha o botao "Sim" no ultimo draw e toca nele
                var b = c.E._btns[0];
                c.H.tap(b.x + b.w / 2, b.y + b.h / 2);
            }
        },
        until: function () { return resp !== null; }
    }, 2000);
    check('ui.confirm: tap no 1o botao devolve "yes"', resp === 'yes', String(resp));

    c = fresh(['ui']);
    var drawsT = 0, fimT = 0, vivo = [];
    c.E.ui.toast('Salvo!', { ms: 200 });
    runUntil(c, {
        static: true,
        draw: function () { drawsT++; },
        update: function () { vivo.push(!!c.E.ui._toast.msg); },
        until: function () { if (!c.E.ui._toast.msg) fimT++; return fimT > 5; }
    }, 3000);
    check('ui.toast: engine desenha por cima (cena static repinta) e some sozinho',
          c.H.log.indexOf('Salvo!') >= 0 && drawsT >= 4 && vivo[0] === true &&
          vivo[vivo.length - 1] === false, 'draws=' + drawsT);

    c = fresh(['ui']);
    var itens = [];
    for (i = 0; i < 40; i++) itens.push('Item ' + i);
    var lst = c.E.ui.list({ items: itens });
    var frL = 0, scrollSolta = -1;
    // arrasto de 60 px pra cima em 4 quadros e solta
    c.H.pushTouch([{ x: 100, y: 200, touched: 1 }, { x: 100, y: 180, touched: 1 },
                   { x: 100, y: 160, touched: 1 }, { x: 100, y: 140, touched: 1 },
                   { x: 0, y: 0, touched: 0 }]);
    runUntil(c, {
        draw: function () { lst.draw(10, 40, 200, 240); },
        update: function () {
            frL++;
            if (frL === 6) scrollSolta = lst.scroll;
        },
        until: function () { return frL >= 30; }
    });
    check('ui.list: fling segue rolando depois de soltar e freia',
          scrollSolta >= 50 && lst.scroll > scrollSolta + 20 && Math.abs(lst._vel) < 5,
          'solta=' + scrollSolta + ' fim=' + lst.scroll + ' vel=' + lst._vel);
    lst.scrollTo(5);
    check('ui.list.scrollTo(i) poe a linha no topo', lst.scroll === 5 * lst.row && lst._vel === 0);

    // -------------------------------------------------------------- sfx --
    var SFX = require(path.join(ENGINE_DIR, 'celeros.sfx.js'));
    var faixa = true;
    for (i = 0; i < 50; i++) {
        var vv = SFX.varia([[440, 50]], 2)[0][0];
        if (vv < 392 || vv > 494) faixa = false;
    }
    var rA = (function () { var s = 3; return function () { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
    var rB = (function () { var s = 3; return function () { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
    check('sfx.varia: sorteio em +-semi, deterministico com rnd',
          faixa && SFX.varia([[440, 50]], 3, rA)[0][0] === SFX.varia([[440, 50]], 3, rB)[0][0]);
    var jn = SFX.junta('ui', [[100, 10], [200, 10]], { pausa: 30 });
    check('sfx.junta: nomes + melodias em fila com pausa entre elas',
          jn.length === 4 && jn[0][0] === 880 && jn[1][0] === 0 && jn[1][1] === 30 &&
          jn[3][0] === 200, JSON.stringify(jn));

    // ------------------------------------------------- d.ts sem drift --
    // todo membro PUBLICO (sem _) de cada modulo tem que aparecer no d.ts
    // dele E no celeros.engine.d.ts (a uniao) — API nova sem tipo nao passa
    c = fresh(['fx', 'spr', 'tilemap', 'ui', 'scene', 'node']);
    var E = c.E;
    var dts = {};
    ['celeros.game', 'celeros.game.fx', 'celeros.game.spr', 'celeros.game.tilemap',
     'celeros.game.ui', 'celeros.game.scene', 'celeros.game.node', 'celeros.engine', 'celeros.sfx'].forEach(function (n) {
        dts[n] = fs.readFileSync(path.join(ENGINE_DIR, n + '.d.ts'), 'utf8');
    });
    function faltam(obj, txt, prefixo) {
        var out = [];
        Object.keys(obj).forEach(function (k) {
            if (k.charAt(0) === '_') return;
            if (!new RegExp('\\b' + k + '\\b').test(txt)) out.push(prefixo + k);
        });
        return out;
    }
    var mapa = [
        [E, 'celeros.game', 'E.'], [E.m, 'celeros.game', 'E.m.'], [E.cam, 'celeros.game', 'E.cam.'],
        [E.input, 'celeros.game', 'E.input.'], [E.gfx, 'celeros.game', 'E.gfx.'],
        [E.dirty, 'celeros.game', 'E.dirty.'], [E.audio, 'celeros.game', 'E.audio.'],
        [E.save, 'celeros.game', 'E.save.'], [E.group(), 'celeros.game', 'group().'],
        [E.pool(1, function () { return {}; }), 'celeros.game', 'pool().'],
        [E.rng(1), 'celeros.game', 'rng().'],
        [E.fx, 'celeros.game.fx', 'E.fx.'], [E.spr, 'celeros.game.spr', 'E.spr.'],
        [E.anim([], 1), 'celeros.game.spr', 'anim().'],
        [E.tilemap({ cols: 1, rows: 1, cell: 1, paint: function () {} }), 'celeros.game.tilemap', 'tilemap().'],
        [E.ui, 'celeros.game.ui', 'E.ui.'],
        [E.ui.list({ items: [] }), 'celeros.game.ui', 'list().'],
        [E.scene, 'celeros.game.scene', 'E.scene.'],
        [E.node, 'celeros.game.node', 'E.node.'],
        [SFX, 'celeros.sfx', 'SFX.']
    ];
    var semTipo = [], semUniao = [];
    // decoracoes dos modulos no E (cada uma checada no d.ts do proprio modulo)
    var ignora = { exports: 1, fx: 1, spr: 1, tilemap: 1, ui: 1, anim: 1, scene: 1, node: 1 };
    mapa.forEach(function (row) {
        semTipo = semTipo.concat(faltam(row[0], dts[row[1]], row[2]).filter(function (k) {
            return !ignora[k.split('.').pop()];
        }));
        // o ui e o scene sao modulos opt-in: nao entram no pacote montado
        if (row[1] !== 'celeros.sfx' && row[1] !== 'celeros.game.ui' &&
            row[1] !== 'celeros.game.scene' && row[1] !== 'celeros.game.node') {
            semUniao = semUniao.concat(faltam(row[0], dts['celeros.engine'], row[2]).filter(function (k) {
                return k !== 'E.ui' && k !== 'E.scene' && k !== 'E.node';   // opt-in: fora do pacote montado
            }));
        }
    });
    check('d.ts sem drift: todo membro publico dos modulos tem tipo', semTipo.length === 0,
          semTipo.join(', '));
    check('celeros.engine.d.ts (a uniao) cobre core/fx/spr/tilemap', semUniao.length === 0,
          semUniao.join(', '));
    var gen = require('../../tools/sdk/lib/engine_dts.js');
    check('celeros.engine.d.ts commitado = gerado (rode node tools/sdk/lib/engine_dts.js)',
          fs.readFileSync(gen.OUT, 'utf8') === gen.generate());
};
