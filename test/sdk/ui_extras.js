// Testes dos extras de UI da API 52 (CONFIG_CELEROS_UI_EXTRAS): UI.extras,
// UI.custom (area pintada pelo app, limpa/recortada e redesenhada so no frame
// total ou na assinatura nova) e UI.clip/unclip (pilha de recorte). O host
// (tools/sdk/lib/ui_host.js) recebe o mesmo flag do firmware; o kit
// (celeros.app.style) precisa cair no caminho base com a MESMA API quando os
// extras nao existem. Plugado no test/sdk/run.js:
//   require('./ui_extras.js')(check);

'use strict';
var path = require('path');

var ROOT = path.resolve(__dirname, '..', '..');
var ENGINE_DIR = path.join(ROOT, 'tools', 'sdk', 'engine');
var uiHost = require(path.join(ROOT, 'tools', 'sdk', 'lib', 'ui_host.js'));

module.exports = function (check) {
    var harness = require('../js_harness/run.js');

    function fresh(extras) {
        var env = harness.makeEnv();
        env.__pkg = 'celeros.teste';
        if (extras) env.UI = uiHost.makeUI(env, { extras: true });
        var req = harness.makeRequire(ENGINE_DIR, env);
        var A = req('celeros.app');
        req('celeros.app.style');
        A.init();
        return { A: A, env: env, U: env.UI, S: env.System };
    }
    function frame(c, fn) {
        var full = c.U.begin();
        var r = fn ? fn(full) : undefined;
        c.U.end(60);
        return r;
    }

    // ---------------------------------------------------------- capacidade
    console.log('SDK UI extras (API 52, S3 x CYD):');
    var base = fresh(false);
    check('extras: base/CYD (UI.extras=false, sem custom/clip)',
          base.U.extras === false && base.A.style.full === false &&
          typeof base.U.custom === 'undefined' &&
          typeof base.U.clip === 'undefined' &&
          typeof base.U.unclip === 'undefined');

    var ext = fresh(true);
    check('extras: S3 (UI.extras=true, A.style.full=true, custom/clip presentes)',
          ext.U.extras === true && ext.A.style.full === true &&
          typeof ext.U.custom === 'function' &&
          typeof ext.U.clip === 'function' &&
          typeof ext.U.unclip === 'function');

    // ------------------------------------------------ UI.custom: assinatura
    var n = 0;
    function custom(c, sig) {
        return frame(c, function () {
            return c.U.custom('g', 10, 40, 100, 60, sig, function () { n++; });
        });
    }
    var d1 = custom(ext, 'a'), d2 = custom(ext, 'a'), d3 = custom(ext, 'b');
    check('custom: desenha 1x por assinatura (total e mudanca)',
          d1 === true && d2 === false && d3 === true && n === 2,
          [d1, d2, d3, n].join(','));
    ext.U.invalidate();
    var d4 = custom(ext, 'b');
    check('custom: frame total redesenha mesmo com a mesma assinatura',
          d4 === true && n === 3, [d4, n].join(','));

    // ------------------------------------------- clear no parcial (bg atual)
    var fills = [];
    ext.S.fillRect = function (x, y, w, h, c) { fills.push([x, y, w, h, c]); };
    custom(ext, 'c');
    check('custom: limpa o retangulo no parcial com o bg corrente',
          fills.length === 1 && fills[0][0] === 10 && fills[0][1] === 40 &&
          fills[0][2] === 100 && fills[0][3] === 60 &&
          fills[0][4] === ext.S.theme().bg, JSON.stringify(fills));

    // --------------------------------------------------- tap nao e consumido
    var seenTap = null;
    ext.env.__harness.pushTouch([{ x: 20, y: 50, touched: true },
                                 { x: 20, y: 50, touched: false }]);
    frame(ext, function () {          // pouso (down, sem tap)
        ext.U.custom('t', 10, 40, 100, 60, 'x', function () {
            seenTap = ext.U.touch().tap;
        });
    });
    var btn = frame(ext, function () {   // solta: tap do frame
        ext.U.custom('t', 10, 40, 100, 60, 'y', function () {
            seenTap = ext.U.touch().tap;
        });
        return ext.U.button('OK', 10, 40, 100, 60);
    });
    check('custom: nao consome o tap (o widget seguinte ainda o ve)',
          btn === true && seenTap === true, btn + ',' + seenTap);

    // ------------------------------------------------------ pilha de recorte
    var clips = [];
    ext.S.setClip = function (x, y, w, h) { clips.push([x, y, w, h]); };
    ext.S.clearClip = function () { clips.push(null); };
    frame(ext, function () {
        ext.U.clip(0, 0, 100, 100);
        ext.U.clip(50, 50, 100, 100);
        ext.U.unclip();
        ext.U.unclip();
    });
    check('clip: aninha a intersecao e restaura a pilha',
          clips.length === 4 &&
          JSON.stringify(clips[0]) === JSON.stringify([0, 0, 100, 100]) &&
          JSON.stringify(clips[1]) === JSON.stringify([50, 50, 50, 50]) &&
          JSON.stringify(clips[2]) === JSON.stringify([0, 0, 100, 100]) &&
          clips[3] === null, JSON.stringify(clips));

    clips = [];
    frame(ext, function () { ext.U.clip(0, 0, 50, 50); });  // sem unclip
    clips = [];
    frame(ext, function () {});
    check('clip: o begin cura um clip deixado aberto',
          clips.length === 1 && clips[0] === null, JSON.stringify(clips));

    clips = [];
    frame(ext, function () {
        ext.U.custom('z', 5, 6, 7, 8, 's', function () {});
    });
    check('custom: recorta a propria area e restaura ao sair',
          clips.length === 2 &&
          JSON.stringify(clips[0]) === JSON.stringify([5, 6, 7, 8]) &&
          clips[1] === null, JSON.stringify(clips));

    // ------------------------------- A.style.custom: base x extras (API igual)
    var b = fresh(false), drawsB = 0, fillB = [];
    b.S.fillRect = function (x, y, w, h, c) { fillB.push(c); };
    function bd(sig, full) {
        b.A.full = full;
        return b.A.style.custom('g', 0, 0, 10, 10, sig, function () { drawsB++; });
    }
    var r1 = bd('a', true), r2 = bd('a', false), r3 = bd('b', false), r4 = bd('b', true);
    check('A.style.custom (CYD): total + assinatura, clear com T.card',
          r1 === true && r2 === false && r3 === true && r4 === true &&
          drawsB === 3 && fillB.length === 1 && fillB[0] === b.A.style.T.card,
          [r1, r2, r3, r4, drawsB, fillB.length].join(','));

    var e2 = fresh(true), callsE = 0, fillE = [];
    e2.S.fillRect = function (x, y, w, h, c) { fillE.push(c); };
    e2.A.style.preset('soft');   // consome o invalidate do ensure (1o frame ja e' total)
    function ed(sig) {
        return frame(e2, function () {
            return e2.A.style.custom('g', 0, 0, 10, 10, sig, function () { callsE++; });
        });
    }
    ed('a'); ed('a'); ed('b');
    check('A.style.custom (S3): delega ao UI.custom e limpa com T.card',
          callsE === 2 && fillE.length === 1 && fillE[0] === e2.A.style.T.card,
          [callsE, fillE.length].join(','));
};
