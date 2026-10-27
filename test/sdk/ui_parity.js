// Teste de paridade dos ATOMS de UI entre CelerGame (jogos) e CelerKit
// (apps): os presets soft/flat/neon/paper precisam ser os MESMOS e os
// ícones comuns precisam sair da mesma tabela (celeros.ui.icons). Sem
// isso as duas copias divergem com o tempo (ja divergiram: shadow do soft
// 2 x 1, raio do paper 2 x 3, neon com cores diferentes). Plugado no
// test/sdk/run.js:
//   require('./ui_parity.js')(check);

'use strict';
var path = require('path');

var ROOT = path.resolve(__dirname, '..', '..');
var ENGINE_DIR = path.join(ROOT, 'tools', 'sdk', 'engine');

module.exports = function (check) {
    var harness = require('../js_harness/run.js');
    var env = harness.makeEnv();
    var req = harness.makeRequire(ENGINE_DIR, env);
    var E = req('celeros.game');
    req('celeros.game.ui');
    var A = req('celeros.app');
    req('celeros.app.style');
    req('celeros.app.icons');
    var I = req('celeros.ui.icons');
    E.init({});
    A.init();

    // TK do game -> T do app
    var fields = [
        ['bg', 'bg'], ['surface', 'card'], ['surface2', 'raised'],
        ['outline', 'stroke'], ['accent', 'accent'], ['accent2', 'accentD'],
        ['onAccent', 'onAccent'], ['text', 'text'], ['textDim', 'textDim'],
        ['ok', 'ok'], ['warn', 'warn'], ['err', 'err'],
        ['radius', 'radius'], ['gap', 'gap'], ['pad', 'pad'], ['shadow', 'shadow']
    ];
    var names = ['soft', 'flat', 'neon', 'paper'];
    var bad = [];
    for (var n = 0; n < names.length; n++) {
        var name = names[n];
        E.ui.preset(name);
        A.style.preset(name);
        var g = E.ui.tokens, a = A.style.T;
        for (var i = 0; i < fields.length; i++) {
            var gv = g[fields[i][0]], av = a[fields[i][1]];
            if (gv !== av) {
                bad.push(name + ':' + fields[i][0] + '/' + fields[i][1] +
                         ' ' + gv + '!=' + av);
            }
        }
        if (g.grad !== a.grad) bad.push(name + ':grad ' + g.grad + '!=' + a.grad);
    }
    check('ui parity: presets soft/flat/neon/paper iguais entre app e game',
          bad.length === 0, bad.join(', '));

    check('ui parity: celeros.app.icons usa a tabela compartilhada',
          !!(A.icons && A.icons.map === I.map && A.icons.draw === I.draw));
    check('ui parity: celeros.ui.icons tem os 12 comuns + dot',
          Object.keys(I.map).length === 13 && !!I.map.wifi && !!I.map.dot,
          Object.keys(I.map).join(','));
    var okIcon = true;
    try { E.ui.icon('wifi', 0, 0, 16); } catch (e) { okIcon = 'erro: ' + e; }
    check('ui parity: CelerGame UI desenha o wifi compartilhado', okIcon === true,
          String(okIcon));
};
