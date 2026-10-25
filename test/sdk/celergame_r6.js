// Testes da rodada 6 da CelerGame: o modulo celeros.game.scene (cena e
// prefab como dado) — tipos, referencias resolvidas em duas fases, save/load
// com remapeamento de id, extras preservados, rename, gate de versao e
// migracao. Plugado no test/sdk/run.js:  require('./celergame_r6.js')(check);

'use strict';
var path = require('path');
var ROOT = path.resolve(__dirname, '..', '..');
var ENGINE_DIR = path.join(ROOT, 'tools', 'sdk', 'engine');

module.exports = function (check) {
    var harness = require('../js_harness/run.js');

    function fresh(setup) {
        var env = harness.makeEnv();
        if (setup) setup(env);
        var req = harness.makeRequire(ENGINE_DIR, env);
        var E = req('celeros.game');
        req('celeros.game.scene');
        E.init({});
        return { E: E, env: env, S: env.System };
    }

    console.log('SDK CelerGame rodada 6 (celeros.game.scene: cena/prefab como dado):');

    // ------------------------------------------------ def + spawn --------
    var c = fresh();
    var E = c.E;
    E.scene.def('goblin', {
        campos: ['hp', 'vel'],
        defaults: { hp: 3, vel: 10 },
        create: function (p) { return { update: function () {} }; }
    });
    var g1 = E.scene.spawn('goblin', 10, 20, { hp: 5 });
    check('scene.def/spawn: tipo, id, x/y, campo do dado e default do def',
          g1 && g1.tipo === 'goblin' && g1.id > 0 && g1.x === 10 && g1.y === 20 &&
          g1.hp === 5 && g1.vel === 10 && typeof g1.update === 'function',
          g1 && JSON.stringify({ tipo: g1.tipo, hp: g1.hp, vel: g1.vel }));
    var logs = [];
    c.S.print = function (s) { logs.push(String(s)); };
    var g2 = E.scene.spawn('fantasma', 0, 0);
    check('scene.spawn de tipo nao registrado: null e aviso no log',
          g2 === null && logs.join('|').indexOf('tipo nao registrado fantasma') >= 0,
          logs.join('|'));

    // ---------------------------------- referencias resolvidas antes ----
    c = fresh();
    E = c.E;
    var vistos = [];
    E.scene.def('bau', {
        campos: ['abre'],
        create: function () { return {}; },
        start: function (e) { vistos.push([e.nome, e.abre && e.abre.nome]); }
    });
    E.scene.def('chefe', { campos: ['hp'], create: function () { return {}; } });
    var grupo = E.group();
    var entes = E.scene.instantiate([
        { tipo: 'bau', x: 5, y: 6, nome: 'bau1', abre: '#chefe1' },
        { tipo: 'chefe', x: 50, y: 60, nome: 'chefe1', hp: 9 }
    ], grupo);
    check('scene.instantiate: referencia "#nome" resolvida ANTES do start',
          entes.length === 2 && entes[0].abre === entes[1] &&
          vistos.length === 1 && vistos[0][0] === 'bau1' && vistos[0][1] === 'chefe1',
          JSON.stringify(vistos));
    check('scene.instantiate: entra no grupo e respeita a ordem da lista',
          grupo.count === 2 && grupo.items[0] === entes[0] && grupo.items[1] === entes[1]);
    var deslocado = E.scene.instantiate([{ tipo: 'chefe', x: 1, y: 2 }], null, { x: 100, y: 200 });
    check('scene.instantiate {x, y}: desloca o prefab sem tocar no dado',
          deslocado[0].x === 101 && deslocado[0].y === 202);

    // ------------------------------------------- prefab nomeado ---------
    E.scene.prefab('dupla', [{ tipo: 'chefe', x: 0, y: 0 }, { tipo: 'chefe', x: 8, y: 0 }]);
    var pre = E.scene.instantiate('dupla');
    check('scene.prefab: lista nomeada instanciada pelo nome',
          pre.length === 2 && pre[1].x === 8 && E.scene.prefab('dupla').length === 2);

    // ------------------------------------------- save -> load -----------
    var dados = E.scene.save(grupo);
    var txt = JSON.stringify(dados);
    check('scene.save: JSON-safe com versao, ref crua ("#nome") e nome',
          dados.version === E.scene.formato && dados.entidades.length === 2 &&
          dados.entidades[0].abre === '#chefe1' && dados.entidades[1].nome === 'chefe1' &&
          JSON.parse(txt).entidades[1].hp === 9,
          txt);
    var grupo2 = E.group();
    var carregados = E.scene.load(JSON.parse(txt), grupo2);
    check('scene.load: cria de novo, remapeia os ids e re-resolve a referencia',
          carregados.length === 2 && carregados[0].id !== entes[0].id &&
          carregados[0].abre === carregados[1] && grupo2.count === 2 &&
          carregados[1].hp === 9,
          'ids ' + carregados[0].id + '/' + carregados[1].id +
          ' (antes ' + entes[0].id + '/' + entes[1].id + ')');

    // ------------------------------- extras, mortos e rename ------------
    c = fresh();
    E = c.E;
    E.scene.def('item', { campos: ['hp'], rename: { hp: 'vida' }, create: function () { return {}; } });
    var gr = E.group();
    var it = E.scene.spawn('item', 1, 1, { vida: 7, raro: true, cor: 0xF800 });
    gr.add(it);
    check('scene.def rename: dado com a chave ANTIGA carrega no campo novo',
          it.hp === 7, 'hp=' + it.hp);
    var d2 = E.scene.save(gr);
    check('scene.save: extras desconhecidos sobrevivem e a chave antiga nao volta',
          d2.entidades[0].raro === true && d2.entidades[0].cor === 0xF800 &&
          d2.entidades[0].hp === 7 && d2.entidades[0].vida === undefined,
          JSON.stringify(d2.entidades[0]));
    var morto = E.scene.spawn('item', 2, 2, {});
    morto.dead = true;
    gr.add(morto);
    gr.add({ x: 0, y: 0 });                 // sem tipo: fora do save
    check('scene.save: pula mortos e objetos sem tipo',
          E.scene.save(gr).entidades.length === 1);

    // ---------------------------------- versao e migracao ---------------
    c = fresh();
    E = c.E;
    logs = [];
    c.S.print = function (s) { logs.push(String(s)); };
    E.scene.def('inimigo', { campos: ['hp'], create: function () { return {}; } });
    var futuro = E.scene.load({ version: E.scene.formato + 1, entidades: [{ tipo: 'inimigo' }] });
    check('scene.load recusa dado de versao MAIOR (null + aviso no log)',
          futuro === null && logs.join('|').indexOf('dado versao') >= 0, logs.join('|'));
    E.scene.migra(0, function (rec) { rec.hp = rec.vida; delete rec.vida; rec.migrado = true; });
    var antigos = E.scene.load({ version: 0, entidades: [{ tipo: 'inimigo', vida: 4 }] });
    check('scene.migra: dado da versao anterior passa pela migracao registrada',
          antigos && antigos[0].hp === 4 && antigos[0].props.migrado === true,
          antigos && ('hp=' + antigos[0].hp + ' migrado=' + antigos[0].props.migrado));

    // ------------------------------- resolve() para spawn tardio --------
    c = fresh();
    E = c.E;
    E.scene.def('botao', { campos: ['porta'], create: function () { return {}; } });
    E.scene.def('porta', { campos: [], create: function () { return {}; } });
    var g3 = E.group();
    var btn = E.scene.instantiate([{ tipo: 'botao', x: 0, y: 0, nome: 'b1', porta: '#p1' }], g3)[0];
    check('scene.instantiate: ref sem alvo no lote fica como string (nao some)',
          btn.porta === '#p1', String(btn.porta));
    var p1 = E.scene.spawn('porta', 9, 9, { nome: 'p1' });
    g3.add(p1);
    var n = E.scene.resolve(btn, g3);
    check('scene.resolve: re-resolve a ref de quem nasceu depois',
          n === 1 && btn.porta === p1);
};
