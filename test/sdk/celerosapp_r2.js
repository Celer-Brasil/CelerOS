// Testes da rodada 2 do CelerKit (UI kit 2.0): style/icons/widgets/rows,
// lista rica (A.list.view), gauge/stepper/card do form e safe area. Os
// gates de descoberta/tamanho/d.ts/versao/docs continuam no celerosapp_r1.
// Plugado no test/sdk/run.js:
//   require('./celerosapp_r2.js')(check);

'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..', '..');
var ENGINE_DIR = path.join(ROOT, 'tools', 'sdk', 'engine');
var jsstrip = require(path.join(ROOT, 'tools', 'sdk', 'lib', 'jsstrip.js'));

module.exports = function (check) {
    var harness = require('../js_harness/run.js');

    function fresh(mods, setup) {
        var env = harness.makeEnv();
        env.__pkg = 'celeros.teste';
        if (setup) setup(env);
        var req = harness.makeRequire(ENGINE_DIR, env);
        var A = req('celeros.app');
        (mods || []).forEach(function (m) {
            req(m.indexOf('.') >= 0 ? m : 'celeros.app.' + m);
        });
        A.init();
        return { A: A, env: env, S: env.System, H: env.__harness, U: env.UI, req: req };
    }
    function tap(env, x, y) {
        env.__harness.pushTouch([{ x: x, y: y, touched: true },
                                 { x: x, y: y, touched: false }]);
    }
    function frames(c, n, fn) {
        for (var i = 0; i < n; i++) {
            var full = c.U.begin(c.A.T.bg);
            fn(full, i);
            c.U.end(60);
        }
    }
    function size(m) {
        return jsstrip.strip(fs.readFileSync(path.join(ENGINE_DIR, m + '.js'))).length;
    }
    function faltam(obj, txt, pre) {
        var out = [];
        Object.keys(obj).forEach(function (k) {
            if (k.charAt(0) === '_') return;
            if (!new RegExp('\\b' + k + '\\b').test(txt)) out.push(pre + k);
        });
        return out;
    }

    console.log('SDK CelerKit rodada 2 (UI kit 2.0: style/icons/widgets/rows):');

    // ================================================================ style
    var c = fresh(['style']);
    check('style: version e tokens vivos', c.A.style.version === '1.1.1' &&
          c.A.style.T.radius === 10 && c.A.style.T.card !== undefined);
    c.A.style.preset('flat');
    check('style: preset flat (raio 6, sem sombra/gradiente)',
          c.A.style.T.radius === 6 && c.A.style.T.shadow === 0 &&
          c.A.style.T.grad === false);
    c.A.style.preset('paper');
    check('style: preset paper (fundo claro)',
          c.A.style.T.bg === c.S.color(242, 238, 228));
    c.A.style.preset('soft');
    check('style: preset soft volta ao tema', c.A.style.T.radius === 10 &&
          c.A.style.T.grad === true);

    c = fresh(['style'], function (env) {
        env.System.getInfo = function () { return { inset: 24, shape: 'rounded' }; };
    });
    var L = c.A.L;
    check('style: A.L respeita o inset do vidro redondo',
          L.x === 20 && L.w === 200 && L.top === 48 && L.bottom === 300,
          JSON.stringify(L));
    var ct = c.A.style.content();
    check('style: content() usa a safe area', ct.x === 20 && ct.w === 200 && ct.h === 252,
          JSON.stringify(ct));

    c = fresh(['style']);
    var fg = 0;
    c.S.fillGradient = function () { fg++; };
    var cr = c.A.style.card(10, 50, 100, 60, {
        full: true, grad: true,
        draw: function (r) { r._seen = 1; }
    });
    check('style: card devolve content rect (pad 10) e fecha sozinho',
          cr.x === 20 && cr.y === 60 && cr.w === 80 && cr.h === 40 &&
          cr.bg === c.A.style.T.card, JSON.stringify(cr));
    check('style: card gradiente so no frame cheio (1 chamada)', fg === 1, String(fg));
    cr = c.A.style.card(10, 50, 100, 60, { full: false, grad: true });
    check('style: card sem full nao redesenha o gradiente', fg === 1, String(fg));

    var st = c.A.style.stack(10, 20, 100, { gap: 4 });
    var y1 = st.next(20).y, y2 = st.next(10).y;
    check('style: stack encadeia com gap', y1 === 20 && y2 === 44 &&
          st.end() === 34, JSON.stringify([y1, y2, st.end()]));

    // ================================================================ icons
    c = fresh(['icons']);
    var arcs = 0;
    c.S.fillArc = function () { arcs++; };
    c.A.icons.draw('wifi', 0, 0, 16);
    check('icons: wifi desenha 2 arcos', arcs === 2, String(arcs));
    check('icons: mapa cobre os 12 nomes',
          Object.keys(c.A.icons.map).length >= 12,
          Object.keys(c.A.icons.map).join(','));
    var si = fresh(['style', 'icons']);
    check('style.icon: delega ao celeros.app.icons quando adotado',
          !!si.A.style.icon('star', 0, 0, 16));

    // ================================================================ widgets
    c = fresh(['style', 'icons', 'widgets']);
    tap(c.env, 20, 20);       // voltar
    tap(c.env, 218, 20);      // acao wifi (asz=28 -> x 204..232)
    var acts = [];
    frames(c, 14, function (full) {
        var h = c.A.widgets.header('Rede', {
            full: full, back: true,
            actions: [{ icon: 'wifi', id: 'wifi' }]
        });
        if (h.back) acts.push('back');
        if (h.action) acts.push(h.action);
    });
    check('widgets: header devolve back e action', acts[0] === 'back' &&
          acts[1] === 'wifi', JSON.stringify(acts));

    c = fresh(['style', 'icons', 'widgets']);
    tap(c.env, 60, 60);
    var hit = false;
    frames(c, 8, function () {
        if (c.A.widgets.button('OK', 20, 40, 80, 40, { icon: 'check' })) hit = true;
    });
    check('widgets: botao com icone responde ao tap', hit === true);

    c = fresh(['style', 'icons', 'widgets']);
    var rb = 0;
    c.S.fillArc = function () { rb++; };
    var rf = c.A.widgets.ring(120, 100, 40, 0.5, { label: '50%' });
    check('widgets: ring pinta trilho+arco e devolve a fracao',
          rb === 2 && rf === 0.5, JSON.stringify([rb, rf]));

    c = fresh(['style', 'icons', 'widgets']);
    tap(c.env, 120, 40);      // acima do sheet
    var fechou = false;
    frames(c, 10, function (full) {
        if (c.A.widgets.sheet('s', { open: true, full: full, h: 160, title: 'T' },
                              function () {}) === 'close') fechou = true;
    });
    check('widgets: sheet fecha no toque fora', fechou === true);

    // ================================================================ list.view
    c = fresh(['style', 'icons', 'list']);
    tap(c.env, 120, 80 + 2 + 2 * 36 + 18);   // linha 2 (B), depois da secao
    var picked = -1;
    var itens = [{ section: 'S' }, { label: 'A', value: 'a' },
                 { label: 'B', value: 'b', icon: 'star' }];
    frames(c, 8, function () {
        var p = c.A.list.view('l', 20, 80, 200, 120, itens, { row: 36 });
        if (p >= 0) picked = p;
    });
    check('list.view: secao nao conta e o tap pega a linha certa',
          picked === 2, String(picked));

    // widget nativo dentro da linha consome o tap (a linha nao dispara)
    c = fresh(['style', 'icons', 'list']);
    tap(c.env, 200, 80 + 2 + 18);   // toggle da linha 0 (x 168..212)
    var rowHit = -1, tog = false;
    frames(c, 8, function () {
        var p = c.A.list.view('w', 20, 80, 200, 120,
            [{ label: 'A' }, { label: 'B' }], {
                row: 36,
                widget: function (it, x, y, w, h) {
                    if (it.label === 'A') {
                        tog = c.U.toggle(x + w - 50, y + 6, tog, { id: 3 });
                    }
                }
            });
        if (p >= 0) rowHit = p;
    });
    check('list.view: widget nativo consome o tap (linha nao dispara)',
          rowHit === -1 && tog === true, JSON.stringify([rowHit, tog]));

    // ================================================================ form/rows
    c = fresh(['style', 'icons', 'list', 'form', 'rows']);
    var n = 3;
    var rows = c.A.form.card('Grupo', [
        c.A.form.gauge('Barra', function () { return 50; },
                       { min: 0, max: 100 }),
        c.A.form.stepper('Nivel', function () { return n; },
                         function (v) { n = v; }, { min: 0, max: 10, step: 1 })
    ]);
    check('form: card achata secao + rows', rows.length === 3 &&
          rows[0].k === 'secao' && rows[1].k === 'gauge' && rows[2].k === 'stepper',
          JSON.stringify(rows.map(function (r) { return r.k; })));
    var painted = -1;
    frames(c, 4, function () {
        painted = c.A.list.view('f', 20, 60, 200, 120, rows,
                               { row: 36, paintRow: c.A.rows.formRow });
    });
    check('rows: gauge/stepper desenham no list.view sem erro', painted === -1,
          String(painted));

    // ---- regressao: linha de DUAS linhas (rotulo + legenda) empilhada
    // As fracoes .24/.55 do rowH punham a legenda em cima do rotulo nas
    // linhas curtas (Regras 32, A.form 36) — no 4848 o corpo mede 19 e a
    // legenda 14 no espaco virtual. O shim padrao mede 8/8 e nao reproduz
    // o bug, entao aqui as metricas do 4848 entram na mao.
    function doisTextos(mods, rowH, formRow) {
        var cx = fresh(mods, function (env) {
            env.System.fontHeight = function (font) { return font === 1 ? 14 : 19; };
            env.__txt = [];
            var ot = env.UI.text;
            env.UI.text = function (s, x, y, o) {
                env.__txt.push({ s: String(s), y: y });
                return ot.apply(env.UI, arguments);
            };
        });
        frames(cx, 4, function () {
            var o = { row: rowH };
            if (formRow) o.paintRow = cx.A.rows.formRow;
            cx.A.list.view('d2', 20, 60, 200, 120,
                           formRow ? [{ k: 'action', label: 'R', sub: 'S' }]
                                   : [{ label: 'R', sub: 'S' }], o);
        });
        var achar = function (s) {
            for (var i = 0; i < cx.env.__txt.length; i++) {
                if (cx.env.__txt[i].s === s) return cx.env.__txt[i].y;
            }
            return null;
        };
        return { lab: achar('R'), sub: achar('S') };
    }
    [32, 36, undefined].forEach(function (rh) {
        var r = doisTextos(['style', 'icons', 'list'], rh);
        check('list.view: legenda ABAIXO do rotulo (row ' + (rh || 'auto') + ')',
              r.lab !== null && r.sub !== null && r.sub - r.lab >= 19,
              JSON.stringify([r.lab, r.sub]));
    });
    var fr = doisTextos(['style', 'icons', 'list', 'form', 'rows'], 36, true);
    check('rows.formRow: legenda ABAIXO do rotulo (row 36)',
          fr.lab !== null && fr.sub !== null && fr.sub - fr.lab >= 19,
          JSON.stringify([fr.lab, fr.sub]));

    // ================================================================ d.ts + size
    var dts = {};
    ['celeros.app.style', 'celeros.app.icons', 'celeros.app.widgets',
     'celeros.app.rows'].forEach(function (m) {
        dts[m] = fs.readFileSync(path.join(ENGINE_DIR, m + '.d.ts'), 'utf8');
    });
    var d = fresh(['style', 'icons', 'widgets', 'rows']);
    var miss = faltam(d.A.style, dts['celeros.app.style'], 'A.style.')
        .concat(faltam(d.A.icons, dts['celeros.app.icons'], 'A.icons.'))
        .concat(faltam(d.A.widgets, dts['celeros.app.widgets'], 'A.widgets.'))
        .concat(faltam(d.A.rows, dts['celeros.app.rows'], 'A.rows.'));
    check('ui 2.0: d.ts cobre todo membro publico de style/icons/widgets/rows',
          miss.length === 0, miss.join(', '));

    var big = [];
    ['celeros.app.style', 'celeros.app.icons', 'celeros.app.widgets',
     'celeros.app.rows', 'celeros.app.list', 'celeros.app.form'].forEach(function (m) {
        var n2 = size(m);
        if (n2 > 6144) big.push(m + '=' + n2);
    });
    check('ui 2.0: cada modulo novo <= 6 KB stripped', big.length === 0,
          big.join(', '));

    var kit = ['celeros.app', 'celeros.app.fmt', 'celeros.app.path',
               'celeros.app.data', 'celeros.app.net', 'celeros.app.text',
               'celeros.app.form', 'celeros.app.list'];
    var total = 0;
    kit.forEach(function (m) { total += size(m); });
    check('ui 2.0: fecho do kit continua <= 20 KB stripped', total <= 20480,
          String(total));
};
