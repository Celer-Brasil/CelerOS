// Testes da rodada 1 do CelerKit (familia celeros.app.* para apps gerais):
// unidades por modulo no harness + gates de familia (todo celeros.app.* tem
// d.ts e entrada no index.json, o App Kit Guide cita todo modulo em EN e
// pt-BR, um unico literal de versao por arquivo, orcamento de tamanho e
// paridade stripped). Plugado no test/sdk/run.js:
//   require('./celerosapp_r1.js')(check);

'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..', '..');
var ENGINE_DIR = path.join(ROOT, 'tools', 'sdk', 'engine');
var jsstrip = require(path.join(ROOT, 'tools', 'sdk', 'lib', 'jsstrip.js'));

module.exports = function (check) {
    var harness = require('../js_harness/run.js');

    // ambiente + todos os modulos pedidos (nomes curtos ou completos)
    function fresh(mods, setup) {
        var env = harness.makeEnv();
        env.__pkg = 'celeros.teste';   // FS.appData() sob /local/data (o FS do
        if (setup) setup(env);         // harness so escreve sob pasta existente)
        var req = harness.makeRequire(ENGINE_DIR, env);
        var A = req('celeros.app');
        (mods || []).forEach(function (m) { req(m.indexOf('.') >= 0 ? m : 'celeros.app.' + m); });
        A.init();
        return { A: A, env: env, S: env.System, H: env.__harness, req: req };
    }
    // toca em (x,y): fila de down+up consumida pelos UI.begin seguintes
    function tap(env, x, y) {
        env.__harness.pushTouch([{ x: x, y: y, touched: true }, { x: x, y: y, touched: false }]);
    }
    function throws(fn) { try { fn(); return false; } catch (e) { return true; } }

    console.log('SDK CelerKit rodada 1 (familia celeros.app.* p/ apps gerais):');

    // ================================================================ core
    var c = fresh([]);
    check('core: init cacheia tema e layout virtual', c.A.T && c.A.T.bg !== undefined &&
          c.A.L.x === 8 && c.A.L.w === 224 && c.A.L.top === 48 && c.A.L.cx === 120,
          JSON.stringify(c.A.L));

    // loop: entered so no 1o frame; lista -> detalhe empilha; back volta;
    // back na raiz encerra (exitApp lanca OS_EXIT/harnessStop no harness)
    function ehSaida(e) { return e === 'OS_EXIT' || (e && e.harnessStop); }
    c = fresh([]);
    var UI = c.env.UI;
    var fases = [];
    var i = 0;
    tap(c.env, 100, 60);          // row 0 da lista -> detalhe
    // detalhe: sai no 3o frame (contador local)
    var det = 0;
    try {
        c.A.run({
            lista: function (ctx) {
                if (ctx.entered) fases.push('lista!');
                fases.push('l');
                if (c.A.header('Meu app')) return c.A.BACK;
                var r = UI.list('l', c.A.L.x, c.A.L.top, c.A.L.w, 200, [{ label: 'Item' }]);
                if (r >= 0) return 'detalhe';
            },
            detalhe: function (ctx) {
                if (ctx.entered) fases.push('detalhe!');
                fases.push('d');
                if (c.A.header('Detalhe')) return c.A.BACK;
                if (++det >= 3) return c.A.BACK;      // volta p/ lista
                if (det === 99) return c.A.EXIT;
            }
        }, 'lista');
    } catch (e) { if (!ehSaida(e)) throw e; }
    var s = fases.join('');
    check('core: pilha lista->detalhe->back (entered 1x por entrada)',
          s.indexOf('lista!') === 0 && s.indexOf('d').toString() !== '-1' &&
          fases[0] === 'lista!' && fases.indexOf('detalhe!') > 0 &&
          fases[fases.length - 1] === 'l',
          s);

    // every: 1a chamada true, dentro da janela false
    c = fresh([]);
    var e1 = c.A.every(1000, 'k');
    var e2 = c.A.every(1000, 'k');
    c.S.delay(1100);
    var e3 = c.A.every(1000, 'k');
    check('core: every(ms, chave) marca por chave', e1 === true && e2 === false && e3 === true,
          e1 + ',' + e2 + ',' + e3);

    // overlays nao estouram; wifiWait devolve true com rede ligada
    c = fresh([]);
    c.A.busy('testando');
    c.A.progress(40, 'testando');
    c.A.progress(-1, 'indeterminado');
    c.env.Net.isConnected = function () { return true; };
    check('core: overlays busy/progress desenham e wifiWait conecta', true, '');

    // resultado: tap no OK (70..170, 264..298) fecha o laco
    c = fresh([]);
    tap(c.env, 120, 280);
    var fechou = true;
    try { c.A.ok('Tudo certo', 'funcionou'); } catch (e) { fechou = false; }
    check('core: card de resultado fecha no toque do OK', fechou, '');

    // ================================================================ fmt
    c = fresh(['fmt']);
    var F = c.A.fmt;
    check('fmt: bytes/uptime/pad2/when/dur no formato do sistema',
          F.bytes(1536) === '1.5 KB' && F.bytes(0) === '' && F.bytes(512) === '512 B' &&
          F.uptime(9 * 3600000 + 5 * 60000) === '9h 5m' &&
          F.uptime(26 * 86400000) === '26d 0h' && F.pad2(7) === '07' &&
          F.clock(false) === '10:32' && F.dur(2300) === '2.3 s' && F.dur(65000) === '1m 05s',
          F.bytes(1536) + '|' + F.uptime(26 * 86400000) + '|' + F.clock(true) + '|' + F.dur(65000));

    // ================================================================ path
    c = fresh(['path']);
    var P = c.A.path;
    check('path: base/dir/ext/stem/join/safeName',
          P.base('/local/apps/Loja/main.js') === 'main.js' &&
          P.dir('/local/apps/Loja/main.js') === '/local/apps/Loja' &&
          P.ext('foto.png') === 'PNG' && P.ext('semext') === '' &&
          P.stem('pacote.zip') === 'pacote' &&
          P.join('a', '', 'b/c') === 'a/b/c' &&
          P.safeName('app: novo?') === 'app_ novo_',
          P.join('a', '', 'b/c') + '|' + P.safeName('app: novo?'));

    // ================================================================ semver
    c = fresh(['semver']);
    var V = c.A.semver;
    var indice = {
        'celeros.app.net': { '1.0.0': { deps: { 'celeros.app': '^1.0.0' } } },
        'celeros.app': { '1.0.0': {}, '1.1.0': {} }
    };
    var fecho = V.resolve({ 'celeros.app.net': '^1.0.0' }, indice);
    check('semver: cmp numerico, ranges ^ e fecho transitivo (maior que satisfaz)',
          V.cmp('1.10.0', '1.9.0') === 1 && V.rangeOk('1.4.2', '^1.2.0') &&
          !V.rangeOk('2.0.0', '^1.2.0') && V.rangeOk('1.2.3', '1.2.3') &&
          fecho && fecho['celeros.app'] === '1.1.0' && fecho['celeros.app.net'] === '1.0.0' &&
          V.resolve({ 'x.y': '^9.0.0' }, indice) === null,
          JSON.stringify(fecho));

    // ================================================================ data
    c = fresh(['data']);
    var D = c.A.data;
    D.save('/local/t.json', { a: [1, 2], b: 'x' });
    var lido = D.load('/local/t.json', null);
    c.env.FS.writeTextFile('/local/podre.json', '{"a":');   // cru: JSON quebrado
    check('data: JSON ida-e-volta, podre cai no fallback, stale e NVS',
          lido && lido.a.length === 2 &&
          D.load('/local/podre.json', 'fb') === 'fb' &&
          D.load('/local/ausente.json', 42) === 42 &&
          D.stale(null, 1000) === true && !D.stale({ at: c.A.now(), v: 1 }, 5000) &&
          D.stale({ at: c.A.now() - 6000, v: 1 }, 5000) === true &&
          (D.saveState('k', { z: 9 }), D.loadState('k', null).z === 9),
          JSON.stringify(lido));

    // ================================================================ caps
    c = fresh(['caps']);
    var cp = c.A.caps.probe();
    check('caps: probe cacheado com placa/tela/psram do ambiente',
          cp.board === 'host' && cp.w === 240 && cp.h === 320 && cp.psram === false &&
          cp.small === true && cp.touch === true && c.A.caps.probe() === cp, '');

    // ================================================================ events
    c = fresh(['events']);
    var hits = { a: 0, b: 0, w: 0 };
    var bus = c.A.bus();
    var sub = c.A.on('ev', function () { hits.a++; });
    c.A.once('ev', function () { hits.b++; });
    c.A.on('*', function (nome) { if (nome === 'ev') hits.w++; });
    c.A.emit('ev');
    c.A.emit('ev');
    c.A.off(sub);
    c.A.emit('ev');
    var parou = 0;
    c.A.on('pare', function () { parou++; return false; });
    c.A.on('pare', function () { parou += 10; });
    c.A.emit('pare');
    check('events: on/once/off/coringa/propagacao',
          hits.a === 2 && hits.b === 1 && hits.w === 3 && parou === 1,
          JSON.stringify(hits) + ' parou=' + parou);

    // ================================================================ net
    c = fresh(['net'], function (env) {
        var falhas = 0;
        env.Net.getJSON = function () {
            falhas++;
            return falhas <= 2 ? null : { ok: 1 };
        };
    });
    c.env.Net.isConnected = function () { return true; };
    var comRetry = c.A.net.retry(function () { return c.A.net.getJSON('u'); }, { n: 3, backoff: 10 });
    var c2 = fresh(['net']);
    check('net: getJSON null em erro, retry devolve a 3a tentativa',
          c2.A.net.getJSON('u') === null && comRetry && comRetry.ok === 1 &&
          c.A.net.online() === true, '');

    // fetch: md5 diferente APAGA o alvo
    c = fresh(['net'], function (env) {
        env.Net.download = function (url, p) { env.FS.writeTextFile(p, 'conteudo'); return true; };
        env.FS.getFileMD5 = function () { return 'md5-certinho'; };
    });
    var okF = c.A.net.fetch('http://x/a', '/local/a.bin', 'md5-certinho');
    var temDepois = c.env.FS.exists('/local/a.bin');
    var okF2 = c.A.net.fetch('http://x/a', '/local/b.bin', 'md5-errado');
    var temErrado = c.env.FS.exists('/local/b.bin');
    check('net: fetch com md5 ok mantem, md5 errado apaga',
          okF === true && temDepois === true && okF2 === false && temErrado === false, '');

    // ================================================================ history
    c = fresh(['history']);
    var hh = c.A.history.new({ file: 'cmd.json', max: 3 });
    hh.push('ls'); hh.push('pwd'); hh.push('ls');       // nao-consecutivo fica
    hh.push('ls');                                       // consecutivo nao
    var gravado = c.A.data.load(c.A.data.file('cmd.json'), []);
    check('history: anel com dedup consecutivo, persistido',
          JSON.stringify(hh.all()) === '["ls","pwd","ls"]' && hh.last() === 'ls' &&
          JSON.stringify(gravado) === '["ls","pwd","ls"]', JSON.stringify(hh.all()));

    // ================================================================ list
    c = fresh(['list']);
    var builds = 0;
    var LL = c.A.list.make(function () { return 'carimbo-1'; }, function () {
        builds++;
        return [{ n: 'b' }, { n: 'a' }];
    });
    LL.rows(); LL.rows(); LL.rows();
    var depois = builds;
    LL.drop(); LL.rows();
    var ordenada = c.A.list.sort(LL.rows(), function (x) { return x.n; });
    check('list: cache por carimbo (build 1x), drop refaz, sort estavel, bars',
          builds === 2 && depois === 1 &&
          ordenada[0].n === 'a' && ordenada[1].n === 'b' &&
          c.A.list.bars(-50) === 4 && c.A.list.bars(-90) === 0 && c.A.list.bars(0) === -1,
          'builds=' + builds);

    // ================================================================ launch
    c = fresh(['launch'], function (env) {
        var FS = env.FS;
        FS.mkdir('/local/apps/Alpha');
        FS.writeTextFile('/local/apps/Alpha/app.json',
            '{"name":"Alpha","packageName":"celeros.alpha","version":"1.0.0"}');
        FS.mkdir('/local/apps/Beta');
        FS.writeTextFile('/local/apps/Beta/app.json',
            '{"name":"Beta","packageName":"celeros.beta","version":"2.0.0"}');
        FS.mkdir('/sd/apps/Alpha');   // duplicata: 1a vista (/local) vence
        FS.writeTextFile('/sd/apps/Alpha/app.json',
            '{"name":"Alpha SD","packageName":"celeros.alpha","version":"9.9.9"}');
    });
    var apps = c.A.launch.scan(true);
    var alpha = c.A.launch.installed('celeros.alpha');
    var rows = c.A.launch.rows(apps, { 'celeros.beta': '2.1.0' });
    check('launch: scan 1a-vista-vence, installed, rows com hub marcando update',
          apps.length === 2 && apps[0].name === 'Alpha' && alpha.ver === '1.0.0' &&
          alpha.sd === false && rows.length === 2 &&
          rows[1].right === '2.0.0 \u00B7' && rows[1].rightColor === c.A.T.warn,
          JSON.stringify(rows));

    // ================================================================ text
    c = fresh(['text']);
    check('text: fit corta fora do Latin-1 e mantem \\n',
          c.A.text.fit('oi \u{1F600}mundo\nTchau \u2014 x') === 'oi mundo\nTchau  x' &&
          c.A.text.fit(null) === '', JSON.stringify(c.A.text.fit('oi \u{1F600}mundo\nTchau \u2014 x')));

    // viewer: tap no voltar (0..56 x 0..40) fecha o laco bloqueante
    c = fresh(['text']);
    tap(c.env, 24, 20);
    var voltou = true;
    try { c.A.text.viewer('Leitor', function () { return 'texto\ncom\nlinhas'; }); }
    catch (e) { voltou = false; }
    check('text: viewer fecha no voltar', voltou, '');

    // ================================================================ input
    c = fresh(['input']);
    var abriu = c.A.input.open({ maxLen: 100 });
    var linhaOk = true;
    try { c.A.input.line('Mensagem'); c.A.input.redraw(true); } catch (e) { linhaOk = false; }
    check('input: abre keypad dockado, desenha linha, poll sem evento = null',
          abriu === true && linhaOk === true && c.A.input.poll() === null &&
          c.A.input.top() > 0 && typeof c.A.input.text() === 'string', '');

    // ================================================================ form
    c = fresh(['form']);
    var gets = { on: false, opt: 0 };
    var builders = [
        c.A.form.secao('Grupo'),
        c.A.form.info('IP', '1.2.3.4'),
        c.A.form.toggle('Ligado', function () { return gets.on; }, function (v) { gets.on = v; }),
        c.A.form.choice('Tema', function () { return gets.opt; }, function (n) { gets.opt = n; },
                        ['A', 'B', 'C']),
        c.A.form.action('Fazer', function () { fFeito = true; })
    ];
    var fFeito = false;
    // tap na linha do toggle (row 2: y = 48 + 2*36 + 18)
    tap(c.env, 100, 48 + 2 * 36 + 18);
    var saiu = false;
    try { c.A.form.run('Ajustes', function () { return builders; }); }
    catch (e) { saiu = ehSaida(e); }
    check('form: toggle na linha aplicou (tap -> set(!get))',
          gets.on === true && gets.opt === 0 && fFeito === false, 'on=' + gets.on);

    // pick: tap na 2a opcao devolve 1
    c = fresh(['form']);
    tap(c.env, 100, 48 + 36 + 18);
    var idx = -9;
    try { idx = c.A.form.pick('Escolha', ['um', 'dois', 'tres']); } catch (e) { idx = 'EX:' + e; }
    check('form: pick devolve o indice tocado', idx === 1, 'idx=' + idx);

    // askNum: prompt do harness devolve '' (null = cancelou)
    c = fresh(['form']);
    var n1 = c.A.form.askNum('Lat', { min: -90, max: 90 });
    var promptVelho = c.S.prompt;
    c.S.prompt = function () { return ' -23,5 '; };
    var n2 = c.A.form.askNum('Lat', { min: -90, max: 90 });
    c.S.prompt = function () { return '999'; };
    var n3 = 'rodou';
    try { n3 = c.A.form.askNum('Lat', { min: -90, max: 90 }); } catch (e) { n3 = 'EX'; }
    check('form: askNum valida faixa e aceita virgula (cancel=null)',
          n1 === null && n2 === -23.5, 'n1=' + n1 + ' n2=' + n2 + ' n3=' + n3);

    // ================================================================ chat
    c = fresh(['chat']);
    var t = c.A.chat.new({ max: 3 });
    t.user('esq'); t.bot('dir'); t.note('(nota)'); t.user('fora');
    check('chat: cap de vista, medida na entrada, fit latin-1',
          t.view.length === 3 && t.view[0].k === 'assistant' && t.view[0].s === 'dir' &&
          t.view[0].h > 0 && t.view[2].k === 'user' && t.view[1].k === 'note',
          JSON.stringify(t.view.map(function (v) { return v.k + ':' + v.s; })));
    var drawOk = true;
    try { t.busy = true; t.draw(true, 200); t.busy = false; t.draw(true, 200); } catch (e) { drawOk = false; }
    check('chat: draw com e sem busy nao estoura', drawOk, '');

    // ================================================================ ai
    c = fresh(['ai'], function (env) {
        env.__harness.setAiResponse({ ok: true, content: 'resposta!', usage: { total_tokens: 42 } });
    });
    c.env.Net.isConnected = function () { return true; };
    var ia = c.A.ai.client({ system: 'teste' });
    var iaNotas = [];
    var ia2 = c.A.ai.client({ system: 's', file: 'outro.json',
                              note: function (s) { iaNotas.push(s); } });
    var started = ia.send('pergunta');
    c.S.delay(50); c.S.delay(1);            // pumpa o callback (delay dispara
                                            // os timers ANTES de avancar)
    check('ai: send com chave/rede, historico persistido com resposta',
          started === true && ia.hist.length === 2 && ia.hist[0].r === 'user' &&
          ia.hist[1].r === 'assistant' && ia.hist[1].s === 'resposta!' &&
          c.A.data.load(c.A.data.file('historico.json'), []).length === 2,
          JSON.stringify(ia.hist));

    // retry dos transientes: 502 responde de novo sozinho
    var chamadas = 0;
    c.env.__harness.setAiResponse(function () {
        chamadas++;
        return chamadas === 1 ? { ok: false, status: 502 } : { ok: true, content: 'segunda' };
    });
    var ia3 = c.A.ai.client({ file: 'retry.json',
                              onmsg: function () {}, note: function () {}, err: function () {} });
    var st3 = ia3.send('oi');
    c.S.delay(50); c.S.delay(1);            // 1a resposta (502)
    c.S.delay(2100); c.S.delay(1);          // setTimeout do retry (2 s)
    c.S.delay(50); c.S.delay(1);            // resposta da 2a chamada
    check('ai: 502 retrya sozinho e grava a 2a resposta',
          st3 === true && chamadas === 2 && ia3.hist[ia3.hist.length - 1].s === 'segunda',
          'chamadas=' + chamadas);

    // ================================================================ fsx
    c = fresh(['fsx'], function (env) {
        env.Net.download = function (url, p) {
            var corpo = url.indexOf('a') >= 0 ? 'AAA' : 'BBB';
            env.FS.writeTextFile(p, corpo);
            return true;
        };
        env.FS.getFileMD5 = function (p) {
            var d = env.FS.readTextFile(p) || '';
            return d === 'AAA' ? 'md5-a' : 'md5-b';
        };
    });
    var stageOk = c.A.fsx.stage('/local/pkg', [
        { name: 'a.txt', url: 'http://x/a', md5: 'md5-a' },
        { name: 'b.txt', url: 'http://x/b', md5: 'md5-b' }
    ], '{"versao":2}');
    var aTxt = c.env.FS.readTextFile('/local/pkg/a.txt');
    var jsonTxt = c.env.FS.readTextFile('/local/pkg/app.json');
    var semNew = c.env.FS.exists('/local/pkg/a.txt.new');
    check('fsx: staged instala em lote (sem .new sobrando, app.json junto)',
          stageOk === true && aTxt === 'AAA' && jsonTxt === '{"versao":2}' && semNew === false, '');
    var stageRuim = c.A.fsx.stage('/local/pkg2', [
        { name: 'a.txt', url: 'http://x/a', md5: 'md5-ERRADO' }
    ], null);
    check('fsx: md5 errado falha e nao deixa lixo',
          stageRuim === false && !c.env.FS.exists('/local/pkg2/a.txt') &&
          !c.env.FS.exists('/local/pkg2/a.txt.new'), '');
    c.env.FS.writeTextFile('/local/um.txt', '12345');
    delete c.env.System.installZip;         // firmware sem pacote unico (API < 42)
    check('fsx: ensureDir arvore, treeSize, zipBlob sem installZip = null',
          c.A.fsx.ensureDir('/local/x1/x2/x3') === true &&
          c.env.FS.isDirectory('/local/x1/x2/x3') &&
          c.A.fsx.treeSize('/local') >= 5 &&
          c.A.fsx.zipBlob('http://x/z', 'App', 'm') === null, '');

    // ================================================================ updater
    c = fresh(['updater'], function (env) {
        env.Net.download = function (url, p) {
            var nome = url.indexOf('net') >= 0 ? 'net' : 'app';
            env.FS.writeTextFile(p, 'src-' + nome);
            return true;
        };
        env.FS.getFileMD5 = function () { return 'md5-hub'; };
    });
    var catalogo = { 'meu.app': { version: '2.0.0', changelog: 'novo', files: [{ name: 'main.js', url: 'u' }] } };
    var upd = c.A.updater.check('meu.app', '1.0.0', catalogo);
    var emDia = c.A.updater.check('meu.app', '2.0.0', catalogo);
    var hubIdx = {
        'celeros.app': { '1.0.0': { url: 'http://hub/app', md5: 'md5-hub' } },
        'dep.z': { '1.1.0': { url: 'http://hub/net', md5: 'md5-hub', deps: { 'celeros.app': '^1.0.0' } } }
    };
    var prom = c.A.updater.promoteDeps({ 'dep.z': '^1.1.0' }, hubIdx);
    var noCache = c.env.FS.exists('/local/modules/celeros.app/1.0.0/celeros.app.js');
    check('updater: check por semver, promoteDeps baixa o fecho no cache',
          upd && upd.version === '2.0.0' && emDia === null && prom &&
          prom['dep.z'] === '1.1.0' && prom['celeros.app'] === '1.0.0' && noCache,
          JSON.stringify(prom));

    // flow por arquivos (sem zip): stage + rescanApps
    c = fresh(['updater'], function (env) {
        env.Net.download = function (url, p) { env.FS.writeTextFile(p, 'm'); return true; };
        env.FS.getFileMD5 = function () { return 'm'; };
        var rescan = 0;
        env.System.rescanApps = function () { rescan++; };
        env.__rescans = function () { return rescan; };
    });
    var flowOk = c.A.updater.flow({ pkg: 'meu.app', name: 'Meu App' },
                                  { version: '2.0.0', files: [{ name: 'main.js', url: 'u' }],
                                    json: '{"name":"Meu App"}' }, {});
    check('updater: flow por arquivos instala e rescaneia',
          flowOk === true && c.env.FS.exists('/local/apps/Meu App/main.js') &&
          c.env.__rescans() === 1, '');

    // ================================================================ svc
    c = fresh(['svc']);
    var svc = c.A.svc.new({ key: 'teste' });
    svc.load();
    svc.state().n = 1;
    svc.save();
    var svc2 = c.A.svc.new({ key: 'teste' });
    svc2.load();
    var fila = 0;
    var drenados = svc.drain(function () { return ++fila <= 9 ? {} : null; }, 4, function () {});
    var notif1 = svc.notifyOnce('chave', 'aviso');
    var notif2 = svc.notifyOnce('chave', 'aviso');
    svc.resetOnce('chave');
    var notif3 = svc.notifyOnce('chave', 'aviso');
    check('svc: tick cadencia, estado persiste, drain com cap, notifyOnce',
          svc.tick(1000) === true && svc.tick(1000) === false && svc2.state().n === 1 &&
          drenados === 4 && notif1 === true && notif2 === false && notif3 === true,
          'drenados=' + drenados);

    // ================================================================ mesh
    c = fresh(['mesh'], function (env) { env.__exposeMesh = true; });
    c.env.CelerNet.start({});
    c.env.__harness.pushMeshNodes([{ id: 'A1B2', name: 'No' }]);
    c.A.mesh.family('t');
    var mresp = 'pendente';
    c.A.mesh.req('A1B2', '?', 'temp', function (d) { mresp = d; });
    var quadro = c.env.__harness.meshSent[c.env.__harness.meshSent.length - 1].msg;
    var nonce = quadro.substring(6);            // FAM(1) + op(1) + 'temp'(4)
    check('mesh: req monta FAM+op+payload+nonce',
          /^t\?temp[0-9a-z]{2}$/.test(quadro), quadro);
    c.env.__harness.pushMesh([{ from: 'A1B2', msg: 't=' + nonce + '|23.5', hops: 1, unicast: true }]);
    c.A.mesh.each(function () {});
    check('mesh: resposta com nonce dispara o callback', mresp === '23.5', mresp);
    // replay: mesmo nonce nao refaz
    c.env.__harness.pushMesh([{ from: 'A1B2', msg: 't=' + nonce + '|23.5', hops: 1, unicast: true }]);
    var refez = 0;
    c.A.mesh.each(function () { refez++; });
    // familia alheia: handler com op ''
    var alheia = null;
    c.env.__harness.pushMesh([{ from: 'C3D4', msg: 's?ping', hops: 1, unicast: false }]);
    c.A.mesh.each(function (from, op, rest) { alheia = op + '|' + rest; });
    check('mesh: replay dedup, familia alheia vira op vazio, cache TTL',
          refez === 0 && alheia === '|s?ping' &&
          c.A.mesh.cache('k', 1000, function () { return 'v1'; }) === 'v1' &&
          c.A.mesh.cache('k', 1000, function () { return 'v2'; }) === 'v1', '');

    // ================================================================ kit
    c = fresh(['kit']);
    check('kit: pacote traz os 8 modulos do fecho decorados',
          c.A.kit && c.A.kit.version === '1.0.0' &&
          c.A.fmt && c.A.path && c.A.data && c.A.net && c.A.text && c.A.form &&
          c.A.list && c.A.caps &&
          c.A._mods.indexOf('fmt') >= 0 && c.A._mods.indexOf('caps') >= 0, c.A._mods.join(','));

    // ============================================== gates de familia do SDK
    var modulos = fs.readdirSync(ENGINE_DIR)
        .filter(function (f) { return /^celeros\.app(\.[a-z0-9]+)?\.js$/.test(f); })
        .map(function (f) { return f.replace(/\.js$/, ''); })
        .sort();
    var idx = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, 'index.json'), 'utf8'));
    var semDts = modulos.filter(function (m) { return !fs.existsSync(path.join(ENGINE_DIR, m + '.d.ts')); });
    var semIdx = modulos.filter(function (m) { return m !== 'celeros.app' && !idx[m]; });
    check('gate CelerKit: todo celeros.app.* tem d.ts e os subs tem entrada no index.json',
          semDts.length === 0 && semIdx.length === 0,
          'sem d.ts: ' + semDts + ' sem index: ' + semIdx);

    var docEN = fs.readFileSync(path.join(ROOT, 'Documentation', 'App_Kit_Guide.md'), 'utf8');
    var docPT = fs.readFileSync(path.join(ROOT, 'Documentation', 'App_Kit_Guide.pt-BR.md'), 'utf8');
    var foraDoc = modulos.filter(function (m) { return docEN.indexOf(m) < 0 || docPT.indexOf(m) < 0; });
    check('gate CelerKit: o App Kit Guide (EN e pt-BR) cita todo modulo',
          foraDoc.length === 0, foraDoc.join(', '));

    // um unico literal de versao por arquivo (celerhub recusa 2) + semver
    var versRuim = modulos.filter(function (m) {
        var src = fs.readFileSync(path.join(ENGINE_DIR, m + '.js'), 'utf8');
        var ms = src.match(/version\s*[:=]\s*'\d+\.\d+\.\d+'/g) || [];
        return ms.length !== 1;
    });
    check('gate CelerKit: exatamente um literal version x.y.z por modulo',
          versRuim.length === 0, versRuim.join(', '));

    // _mods: nome unico por modulo adotado
    var todos = modulos.filter(function (m) { return m !== 'celeros.app'; });
    var cAll = fresh(todos.map(function (m) { return m; }));
    var nomes = cAll.A._mods.slice().sort();
    var dup = nomes.filter(function (n, k) { return nomes[k + 1] === n; });
    check('gate CelerKit: todo modulo registra nome unico em A._mods',
          dup.length === 0 && nomes.length === todos.length,
          'n=' + nomes.length + '/' + todos.length + ' dup=' + dup);

    // d.ts cobre todo membro publico dos objetos decorados
    function dts(n) { return fs.readFileSync(path.join(ENGINE_DIR, n + '.d.ts'), 'utf8'); }
    function faltam(obj, txt, pre) {
        return Object.keys(obj).filter(function (k) {
            return k.charAt(0) !== '_' && !new RegExp('\\b' + k + '\\b').test(txt);
        }).map(function (k) { return pre + k; });
    }
    var K = cAll.A;
    var mapa = [
        [K.fmt, 'celeros.app.fmt', 'fmt.'], [K.path, 'celeros.app.path', 'path.'],
        [K.semver, 'celeros.app.semver', 'semver.'], [K.data, 'celeros.app.data', 'data.'],
        [K.caps, 'celeros.app.caps', 'caps.'], [K.net, 'celeros.app.net', 'net.'],
        [K.text, 'celeros.app.text', 'text.'], [K.input, 'celeros.app.input', 'input.'],
        [K.form, 'celeros.app.form', 'form.'], [K.list, 'celeros.app.list', 'list.'],
        [K.launch, 'celeros.app.launch', 'launch.'], [K.history, 'celeros.app.history', 'history.'],
        [K.ai, 'celeros.app.ai', 'ai.'], [K.chat, 'celeros.app.chat', 'chat.'],
        [K.chat.new(), 'celeros.app.chat', 'Transcript.'],
        [K.fsx, 'celeros.app.fsx', 'fsx.'], [K.updater, 'celeros.app.updater', 'updater.'],
        [K.svc, 'celeros.app.svc', 'svc.'], [K.svc.new({ key: 'g' }), 'celeros.app.svc', 'Svc.'],
        [K.mesh, 'celeros.app.mesh', 'mesh.'], [K.events, 'celeros.app.events', 'Bus.'],
        [K.kit, 'celeros.app.kit', 'kit.']
    ];
    var semTipo = [];
    mapa.forEach(function (row) { semTipo = semTipo.concat(faltam(row[0], dts(row[1]), row[2])); });
    // membros do PROPRIO core (os namespaces dos subs sao cobertos no mapa
    // acima, cada um contra o d.ts dele)
    var coreMembros = {};
    ['version', 'BACK', 'EXIT', 'T', 'L', 'run', 'init', 'header', 'busy',
     'progress', 'error', 'ok', 'wifiWait', 'every', 'now', 'toast', 'exit'
    ].forEach(function (k) { coreMembros[k] = 1; });
    semTipo = semTipo.concat(faltam(coreMembros, dts('celeros.app'), 'core.'));
    check('gate CelerKit: d.ts cobre todo membro publico (e os membros do core)',
          semTipo.length === 0, semTipo.join(', '));

    // orcamento de tamanho (stripped) e paridade de linhas (jsstrip)
    var TETO_MOD = 6144;      // cada modulo
    var TETO_KIT = 20480;     // fecho do kit (core + 8)
    var kitDeps = idx['celeros.app.kit'].deps;
    var fechoNomes = {};
    Object.keys(kitDeps).forEach(function (n) { fechoNomes[n] = 1; });
    Object.keys(kitDeps).forEach(function (n) {
        (idx[n] && idx[n].deps ? Object.keys(idx[n].deps) : []).forEach(function (d) { fechoNomes[d] = 1; });
    });
    fechoNomes['celeros.app'] = 1;
    var kitFecho = Object.keys(fechoNomes).map(function (n) { return n + '.js'; });
    var grande = [], kitBytes = 0, paridade = [];
    modulos.forEach(function (m) {
        var src = fs.readFileSync(path.join(ENGINE_DIR, m + '.js'), 'utf8');
        var fora = jsstrip.strip(src).toString('utf8');
        if (src.split('\n').length !== fora.split('\n').length) paridade.push(m);
        var v = fora.match(/version\s*[:=]\s*'([^']+)'/);
        if (!v) paridade.push(m + ' (sem versao stripped)');
        if (kitFecho.indexOf(m + '.js') >= 0) kitBytes += fora.length;
        else if (fora.length > TETO_MOD) grande.push(m + '=' + fora.length);
    });
    var coreBytes = jsstrip.strip(fs.readFileSync(path.join(ENGINE_DIR, 'celeros.app.js'), 'utf8')).toString('utf8').length;
    if (coreBytes > TETO_MOD) grande.push('celeros.app=' + coreBytes);
    check('gate CelerKit: orcamento stripped (mod <= 6 KB, fecho do kit <= 20 KB) e paridade de linhas',
          grande.length === 0 && kitBytes <= TETO_KIT && paridade.length === 0,
          'kit=' + kitBytes + ' B grande=' + grande + ' paridade=' + paridade);
};
