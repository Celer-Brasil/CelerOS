#!/usr/bin/env node
// Testes do SDK (tools/sdk): scaffold passa no lint, types sem drift,
// renderer com pixels conferidos, emu gera PNG valido, icon do scaffold e PNG.
// Uso: node test/sdk/run.js

'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');

var ROOT = path.resolve(__dirname, '..', '..');
var failures = 0;

function check(name, ok, detail) {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok || !detail ? '' : ' — ' + detail));
    if (!ok) failures++;
}

// ---------------------------------------------------------------- scaffold --
(function () {
    console.log('SDK scaffold:');
    var { makeIconPng } = require('../../tools/sdk/celer.js');
    var { runLint } = require('../../tools/app_lint/lint.js');
    var { execSync } = require('child_process');

    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'celer-sdk-'));
    var appDir = path.join(tmp, 'AppTeste');
    execSync('node tools/sdk/celer.js new AppTeste --dir ' + JSON.stringify(tmp), { cwd: ROOT });

    for (var i = 0; i < ['app.json', 'main.js', 'icon.png', 'jsconfig.json', 'celer.d.ts', 'README.md'].length; i++);
    var want = ['app.json', 'main.js', 'icon.png', 'jsconfig.json', 'celer.d.ts', 'README.md'];
    var missing = want.filter(function (f) { return !fs.existsSync(path.join(appDir, f)); });
    check('cria os arquivos do app', missing.length === 0, 'faltam: ' + missing.join(', '));

    var icon = fs.readFileSync(path.join(appDir, 'icon.png'));
    check('icon.png e PNG valido (assinatura + IHDR 64x64)',
          icon.length > 33 && icon[0] === 0x89 && icon[1] === 0x50 &&
          icon.readUInt32BE(16) === 64 && icon.readUInt32BE(20) === 64);

    var result = runLint([appDir], {});
    var errs = result.totals.errors;
    check('scaffold passa limpo no lint', errs === 0,
          result.apps[0].diagnostics.map(function (d) { return d.message; }).join('; '));
    check('app.json do scaffold tem api = firmware', JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'))).api === result.manifest.apiLevel);
    fs.rmSync(tmp, { recursive: true, force: true });
})();

// ------------------------------------------------------------------ types --
(function () {
    console.log('SDK types:');
    var { generate } = require('../../tools/sdk/lib/dts.js');
    var typesPath = path.join(ROOT, 'tools', 'sdk', 'types', 'celer.d.ts');
    var committed = fs.existsSync(typesPath) ? fs.readFileSync(typesPath, 'utf8') : '';
    var fresh = generate() + '\n';
    check('celer.d.ts commitado = gerado (rode `celer.js types` se falhar)', committed === fresh);
    check('declara os 5 globals + tema + touch',
          /declare const System/.test(fresh) && /declare const Net/.test(fresh) &&
          /declare const FS/.test(fresh) && /CelerLink/.test(fresh) &&
          /interface CelerTheme/.test(fresh) && /interface TouchPoint/.test(fresh));
})();

// --------------------------------------------------------------- renderer --
(function () {
    console.log('SDK renderer:');
    var { Renderer, W, H } = require('../../tools/sdk/lib/renderer.js');

    var r = new Renderer();
    var T = { bg: 0x0000, fg: 0xFFFF, red: 0xF800, accent: 0x07FF };
    r.fb.fill(T.bg);
    r.rect(10, 10, 50, 30, T.red, true);
    check('fillRect pinta o interior', r.fb[10 * W + 11] === T.red && r.fb[39 * W + 59] === T.red);
    check('fillRect respeita o bound (fora fica bg)', r.fb[10 * W + 9] === T.bg && r.fb[40 * W + 10] === T.bg);

    r.line(0, 0, 10, 0, T.fg);
    check('drawLine horizontal', r.fb[5] === T.fg);

    r.circle(100, 100, 8, T.accent, true);
    check('fillCircle centro e borda', r.fb[100 * W + 100] === T.accent && r.fb[100 * W + 108] === T.accent);

    // sprite: cria, bind, desenha NELE, push para a tela
    var env = { System: { fillRect: function () {}, drawPNG: function () { return true; } } };
    r.wire(env.System ? env : env);  // wire espera env; aqui so exercita S.*
    env.System.createSprite(20, 20);
    check('createSprite nao direciona sem bind', r.target() === r.fb);
    env.System.bindSprite(true);
    env.System.fillRect(0, 0, 20, 20, T.red);
    check('bindSprite(true) direciona ao sprite', r.sprite.fb[0] === T.red && r.fb[0] !== T.red);
    env.System.bindSprite(false);
    env.System.pushSprite(30, 30);
    check('pushSprite copia para o framebuffer', r.fb[30 * W + 30] === T.red && r.fb[30 * W + 49] === T.red);
    env.System.deleteSprite();

    // sprites por id (contrato do firmware): useSprite seleciona o alvo do
    // desenho (fillScreen incluso), pushSprite blita o CORRENTE na tela e
    // honra a cor-chave do 3o arg
    var r2 = new Renderer();
    var env2 = { System: { drawPNG: function () { return true; } } };
    r2.wire(env2);
    var S2 = env2.System;
    r2.fb.fill(T.bg);
    var idA = S2.createSprite(10, 10);
    var idB = S2.createSprite(6, 6);
    check('createSprite devolve ids 1.. (contrato do firmware)', idA === 1 && idB === 2);
    S2.useSprite(idA);
    S2.fillScreen(T.red);
    S2.fillRect(0, 0, 10, 5, T.fg);        // metade de cima branca
    check('useSprite direciona fillScreen e draws ao sprite (tela intacta)',
          r2.sprite.fb[0] === T.fg && r2.sprite.fb[95] === T.red && r2.fb[0] === T.bg);
    S2.useSprite(idB);
    S2.fillScreen(T.accent);
    S2.fillRect(2, 2, 2, 2, T.red);        // centro vermelho sobre fundo ciano
    S2.useSprite(0);
    check('useSprite(0) devolve o desenho a tela', r2.target() === r2.fb);
    S2.pushSprite(100, 100, T.accent);     // blit do B (corrente) com a chave
    check('pushSprite com cor-chave: pixels da chave ficam transparentes, os demais copiam',
          r2.fb[100 * W + 100] === T.bg && r2.fb[102 * W + 102] === T.red,
          'chave=' + r2.fb[100 * W + 100] + ' vivo=' + r2.fb[102 * W + 102]);
    S2.useSprite(idA);
    S2.pushSprite(20, 20);                 // bindado: destino continua sendo a tela
    check('pushSprite bindado blita o sprite selecionado na tela',
          r2.fb[20 * W + 20] === T.fg && r2.fb[29 * W + 29] === T.red);
    S2.deleteSprite(idA);
    S2.deleteSprite(idB);
    check('deleteSprite por id libera o pool (id 1 volta)', S2.createSprite(4, 4) === 1);
    S2.deleteSprite();

    // texto: glifo 'A' (0x41) com fg
    r.fg = T.fg; r.bg = T.bg; r.textSize = 1;
    r.drawString('A', 5, 5, 1);
    var anyOn = false;
    for (var i = 0; i < 8; i++) if (r.fb[5 * W + 5 + i] === T.fg || r.fb[(5 + i) * W + 5] === T.fg) anyOn = true;
    check('drawString pinta pixels do glifo', anyOn);
    check('textWidth acompanha a metrica do draw', env.System.textWidth('ABCD', 1) === 4 * 6);

    var png = r.png();
    check('png() gera PNG 240x320 (IHDR)', png.length > 100 && png[0] === 0x89 &&
          png.readUInt32BE(16) === W && png.readUInt32BE(20) === H);
})();

// -------------------------------------------------------------------- emu --
(function () {
    console.log('SDK emu (dogfood com apps reais):');
    var { runAppFolder } = require('../../tools/sdk/lib/runner.js');

    var r = runAppFolder(path.join(ROOT, 'data', 'apps', 'Snake'), { render: true, stopAtMs: 800 });
    check('Snake roda limpo no emu', r.err === null, r.err);
    check('renderer sem primitivas nao renderizadas', r.renderer.unsupported.size === 0,
          Array.from(r.renderer.unsupported).join(', '));

    // tela nao pode ficar vazia (fillScreen do Snake deixa fundo do tema)
    var nonzero = 0;
    for (var i = 0; i < r.renderer.fb.length; i += 997) if (r.renderer.fb[i] !== 0) nonzero++;
    check('framebuffer do Snake nao esta zerado', nonzero > 0);

    var r2 = runAppFolder(path.join(ROOT, 'hub_apps', 'Cronometro'), { render: true, stopAtMs: 600 });
    check('Cronometro roda limpo no emu', r2.err === null, r2.err);

    // --frames: um PNG por marco do relogio do app + diff entre consecutivos
    // (Watchface redesenha quando o segundo vira — o relogio do harness anda)
    var r3 = runAppFolder(path.join(ROOT, 'data', 'apps', 'Watchface'),
                          { render: true, frames: [0, 1100, 2300] });
    check('Watchface roda limpo com frames', r3.err === null, r3.err);
    check('frames nos marcos pedidos',
          r3.frames.length === 3 && r3.frames[0].ms === 0 && r3.frames[2].ms === 2300,
          JSON.stringify(r3.frames.map(function (f) { return f.ms; })));
    check('cada frame tem PNG 240x320',
          r3.frames.every(function (f) { return f.png.length > 100 && f.fb.length === 240 * 320; }));
    var d01 = 0;
    for (var i = 0; i < r3.frames[0].fb.length; i++)
        if (r3.frames[0].fb[i] !== r3.frames[1].fb[i]) d01++;
    check('diff detecta o relogio andando (frame 0 -> 1100)', d01 > 0, 'pixels=' + d01);

    // Supernova 2.0 (engine do SDK + fisica): roda o smoke completo dele
    // (titulo -> morte -> fim -> de novo -> detonacao -> pausa) headless;
    // o watchdog e do proprio test.js do app
    var r4 = runAppFolder(path.join(ROOT, 'hub_apps', 'Supernova'));
    check('Supernova roda limpo no harness (smoke completo)', r4.err === null, r4.err);

    // Detona! (bomberman de grade): smoke completo no canvas nativo do
    // stub (titulo -> jogar -> bomba no beat -> explosao abre macio ->
    // morte por labareda -> fim) — watchdog do proprio test.js do app
    var r5 = runAppFolder(path.join(ROOT, 'hub_apps', 'Detona'));
    check('Detona roda limpo no harness (smoke completo)', r5.err === null, r5.err);

    // Ferramentas 2026-10-10: 9o timer do pool de 8 agora e VISIVEL, a
    // retomada da musica honra startMs e o runner tem profile de quadros
    // (a base do `celer.js bench`)
    var r6 = runAppFolder(path.join(ROOT, 'data', 'apps', 'Snake'),
                          { stopAtMs: 250, events: (env) => {
        for (var i = 0; i < 9; i++) env.setTimeout(function () {}, 5000);
    } });
    check('harness: 9o setTimeout conta drop no __harness (antes era silencio)',
          r6.env.__harness.timersDropped() >= 1 &&
          r6.env.__harness.log.some((l) => /descartado/.test(l)));
    var r7 = runAppFolder(path.join(ROOT, 'hub_apps', 'Cronometro'),
                          { stopAtMs: 400, events: (env) => {
        env.System.playMusic({ bpm: 120, tracks: [{ notes: [[60, 64]] }] }, { startMs: 1000 });
    } });
    check('harness: playMusic honra startMs (retomada nao zera o beat clock)',
          r7.env.System.musicPos() >= 900, 'musicPos=' + r7.env.System.musicPos());
    var r8 = runAppFolder(path.join(ROOT, 'hub_apps', 'Cronometro'),
                          { stopAtMs: 600, profile: true });
    check('bench: runner.profile coleta quadros com tempos reais',
          r8.profile.frames > 10 && r8.profile.avgMs >= 0 && r8.profile.maxMs >= r8.profile.p50Ms,
          JSON.stringify(r8.profile));
    var { execSync } = require('child_process');
    execSync('node tools/sdk/celer.js test hub_apps/Cronometro --ms 600',
             { cwd: ROOT, stdio: 'pipe' });
    check('celer.js test aceita --ms (para no marco)', true);
})();

// ------------------------------------------------------- Detona: sim ----
// A simulacao do Detona direto (sem cenas): movimento de grade, bomba
// atravessavel so ate sair dela, quina assistida, deslize ao soltar,
// fuzz do invariante "o corpo nunca entra em parede", i-frames do chefe,
// acerto no meio do passo, respiro do Forno e teleporte do Nucleo.
(function () {
    console.log('Detona (arena.js/ia.js):');
    var harness = require('../../test/js_harness/run.js');
    var DIR = path.join(ROOT, 'hub_apps', 'Detona');
    function nova(mundo, nivel, ajusta) {
        var env = harness.makeEnv();
        var req = harness.makeRequire(DIR, env);
        // os modulos leem System/Storage como globais do app
        global.System = env.System; global.Storage = env.Storage;
        var out = {};
        new Function('System', 'Storage', 'require', '__out',
            'var NV = require("niveis"), A = require("arena"), IA = require("ia");' +
            '__out.NV = NV; __out.A = A; __out.IA = IA;')(env.System, env.Storage, req, out);
        var plano = out.NV.gerar(mundo, nivel);
        if (ajusta) ajusta(plano);
        out.A.iniciar(mundo, nivel, plano);
        out.A.layout(32, 0, 0);
        out.A.state().intro = 0;
        out.env = env;
        return out;
    }
    var dd0 = nova(1, 1);
    var HALF = 0.4;
    function invadiu(A) {
        var st = A.state(), u = st.player.x / 32, v = st.player.y / 32;
        for (var r = Math.floor(v - HALF + 1e-6); r <= Math.floor(v + HALF - 1e-6); r++) {
            for (var c = Math.floor(u - HALF + 1e-6); c <= Math.floor(u + HALF - 1e-6); c++) {
                var ch = A.em(c, r);
                if (ch === '#' || ch === '%') return ch + '@' + c + ',' + r;
                if (ch === 'B' && A.bloqueado(c, r)) return 'B@' + c + ',' + r;
            }
        }
        return null;
    }
    function anda(A, ax, ay, quadros) {
        var ruim = null;
        for (var i = 0; i < quadros && !ruim; i++) { A.mover(ax, ay, 1 / 30); ruim = invadiu(A); }
        return ruim;
    }
    function limpaCanto(plano) {
        // corredor (1..5, 1) livre e (1..1, 1..5) livre: cenario conhecido
        for (var c = 1; c <= 5; c++) plano.grid[1][c] = '.';
        for (var r = 1; r <= 5; r++) plano.grid[r][1] = '.';
        plano.spawns = [];
    }

    // 1) o bug relatado: planta e anda — nunca entra na parede, sai da bomba
    var d = nova(1, 1, limpaCanto), A = d.A, st = A.state();
    check('planta no canto (1,1)', A.plantar() === true && A.em(1, 1) === 'B');
    var ruim = anda(A, 1, 0, 40);
    check('planta e anda pra direita: corpo nunca invade bloco/parede', ruim === null, ruim);
    check('saiu da propria bomba e seguiu o corredor', A.celulaPlayer().c >= 3, 'c=' + A.celulaPlayer().c);
    ruim = anda(A, -1, 0, 60);
    var u = st.player.x / 32;
    check('depois de sair, a bomba vira parede (nao volta pra dentro)', ruim === null && u >= 2.5 - 1e-6,
          'u=' + u.toFixed(3) + ' ' + ruim);
    // plantar e sair pra BAIXO/CIMA tambem (eixo y)
    d = nova(1, 1, limpaCanto); A = d.A; st = A.state();
    A.plantar();
    ruim = anda(A, 0, 1, 40);
    check('planta e desce: corpo nunca invade', ruim === null && A.celulaPlayer().r >= 3, ruim);
    // tentar entrar na parede de cima/esquerda a partir do canto com a bomba no pe
    d = nova(1, 1, limpaCanto); A = d.A; st = A.state();
    A.plantar();
    ruim = anda(A, -1, 0, 20) || anda(A, 0, -1, 20);
    check('com a bomba no pe, empurrar contra a borda nao atravessa', ruim === null &&
          Math.abs(st.player.x - 48) < 1e-6 && Math.abs(st.player.y - 48) < 1e-6, ruim);

    // 2) quina assistida: deslocado 0.3 para a trilha de baixo, empurrando
    // contra o pilar (2,2) a partir de (1,2)... usa (3,1)->(3,2) livres
    d = nova(1, 1, function (pl) {
        limpaCanto(pl);
        for (var rr = 1; rr <= 3; rr++) { pl.grid[rr][3] = '.'; }
        pl.grid[1][4] = '.'; pl.grid[3][4] = '.';   // (4,2) segue pilar
    });
    A = d.A; st = A.state();
    st.player.x = 3.5 * 32; st.player.y = 1.5 * 32;
    anda(A, 1, 0, 1);   // fica em (3,1)
    st.player.x = 3.5 * 32; st.player.y = 1.5 * 32;
    // pilar em (4,2): de (3,1) andando pra baixo deslocado ok; testa ao contrario:
    // no corredor vertical x=3, deslocado +0.3 em x, empurra pra cima ate o topo
    st.player.x = 3.8 * 32; st.player.y = 3.5 * 32;
    ruim = anda(A, 0, -1, 30);
    check('deslocado na trilha, anda alinhando sem invadir o pilar', ruim === null &&
          Math.abs(st.player.x / 32 - 3.5) < 1e-3, 'x=' + (st.player.x / 32).toFixed(3) + ' ' + ruim);

    // 3) soltar o dedo: termina o passo no centro da celula
    d = nova(1, 1, limpaCanto); A = d.A; st = A.state();
    anda(A, 1, 0, 4);
    var antes = st.player.x / 32;
    anda(A, 0, 0, 20);
    var depois = st.player.x / 32;
    check('soltar o dedo: desliza ate o centro da proxima celula', depois > antes &&
          Math.abs(depois - (Math.floor(depois) + 0.5)) < 1e-6, antes.toFixed(3) + ' -> ' + depois.toFixed(3));

    // 4) fuzz: 3000 quadros aleatorios com bombas — o invariante nunca quebra
    var seeds = [[1, 2], [2, 3], [3, 5]], falhou = null, quadros = 0;
    seeds.forEach(function (sd) {
        var dd = nova(sd[0], sd[1], function (pl) { pl.spawns = []; pl.ventos = []; });
        var AA = dd.A, ss = AA.state(), rng = dd.NV.rng(sd[0] * 31 + sd[1]);
        ss.stats.bombs = 3; ss.stats.inv = 1e9;
        var dir = [0, 0];
        for (var i = 0; i < 1000 && !falhou; i++) {
            if (rng() < 0.08) dir = [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]][Math.floor(rng() * 5)];
            AA.mover(dir[0], dir[1], 1 / 30);
            if (rng() < 0.04) AA.plantar();
            dd.env.System.delay(33);
            AA.update(1 / 30);
            if (!AA.state()) break;
            ss.stats.vidas = 9;
            var r2 = invadiu(AA);
            if (r2) falhou = 'mundo ' + sd[0] + '-' + sd[1] + ' quadro ' + i + ': ' + r2;
            quadros++;
        }
    });
    check('fuzz 3000 quadros (andar + plantar + explodir): corpo nunca invade', falhou === null && quadros > 2500,
          falhou || ('quadros=' + quadros));

    // 5) ia: labareda acerta o bicho no MEIO do passo e o chefe tem i-frames
    d = nova(1, 1, limpaCanto); A = d.A; st = A.state();
    d.IA.ligar();
    var e = d.IA.colocar('balao', 3, 3);
    e.tc = 4; e.tr = 3; e.fx = 4.3; e.fy = 3.5;   // 80% dentro da (4,3)
    d.IA.ferirNa(4, 3, 'p');
    check('labareda na celula de destino mata o bicho no meio do passo', e.morto === true);
    var ch = d.IA.colocar('chefe', 6, 5);
    var hp0 = ch.hp;
    for (var k = 0; k < 8; k++) d.IA.ferirNa(6, 5, 'p');   // 8 quadros de labareda
    check('chefe: uma labareda (8 quadros) tira 1 hp so', ch.hp === hp0 - 1, 'hp ' + hp0 + ' -> ' + ch.hp);
    d.IA.ferirNa(6, 5, 'x');
    check('bomba do chefe nao fere o chefe', ch.hp === hp0 - 1);
    var dv = d.IA.colocar('divisor', 9, 9);
    var antesN = st.enemies.length;
    d.IA.ferirNa(9, 9, 'p');
    var minis = st.enemies.filter(function (x) { return x.kind === 'mini' && !x.morto; }).length;
    check('divisor se parte em 2 mini ao morrer', dv.morto && minis === 2, 'minis=' + minis + ' antes=' + antesN);

    // 6) Forno: o respiro entra em erupcao na batida (e fere o jogador)
    d = nova(2, 1, function (pl) { limpaCanto(pl); pl.ventos = [{ c: 1, r: 3, aviso: false }]; });
    A = d.A; st = A.state();
    st.player.x = 1.5 * 32; st.player.y = 2.5 * 32;   // vizinho do respiro
    var vidas0 = st.stats.vidas, viuFogo = false;
    for (var q = 0; q < 200 && st.stats.vidas === vidas0; q++) {
        d.env.System.delay(33);
        A.update(1 / 30);
        if (st.flames.length) viuFogo = true;
    }
    check('Forno: respiro erupciona na batida e fere quem esta do lado', viuFogo && st.stats.vidas === vidas0 - 1,
          'fogo=' + viuFogo + ' vidas ' + vidas0 + '->' + st.stats.vidas);

    // 8) as 24 fases + sobrevivencia rodam 900 quadros de jogo aleatorio
    // (ia, bombas, perigos, chefe) sem excecao e sem o corpo invadir
    var falhaFase = null, fases = 0;
    for (var mu = 1; mu <= 3 && !falhaFase; mu++) {
        for (var nv = 1; nv <= 8 && !falhaFase; nv++) {
            [false, true].forEach(function (sobre) {
                if (falhaFase || (sobre && (mu > 1 || nv > 1))) return;
                try {
                    var dd = nova(mu, nv, sobre ? function (pl) {
                        var g = dd0.NV.gerar(1, 1, { sobrevivencia: true });
                        for (var k in g) pl[k] = g[k];
                    } : null);
                    var AA = dd.A, ss = AA.state(), rr = dd.NV.rng(mu * 97 + nv);
                    dd.IA.ligar();
                    if (sobre) dd.IA.onda();
                    var dir = [0, 0];
                    for (var i = 0; i < 900; i++) {
                        var s2 = AA.state();
                        if (!s2) break;
                        s2.stats.inv = 1e9; s2.stats.vidas = 9; s2.tLeft = 500;
                        if (rr() < 0.08) dir = [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]][Math.floor(rr() * 5)];
                        AA.mover(dir[0], dir[1], 1 / 30);
                        if (rr() < 0.05) AA.plantar();
                        dd.env.System.delay(33);
                        AA.update(1 / 30);
                        var inv2 = invadiu(AA);
                        if (inv2) { falhaFase = mu + '-' + nv + ' quadro ' + i + ': ' + inv2; break; }
                    }
                    fases++;
                } catch (ex) {
                    falhaFase = mu + '-' + nv + (sobre ? ' (sobre)' : '') + ': ' + (ex && ex.stack || ex);
                }
            });
        }
    }
    check('24 fases + sobrevivencia: 900 quadros de jogo cada sem excecao nem invasao',
          falhaFase === null && fases === 25, falhaFase || ('fases=' + fases));

    // 7) Nucleo: o teleporte leva ao par e nao volta em ping-pong
    d = nova(3, 1, function (pl) { limpaCanto(pl); pl.teles = [{ c: 3, r: 1 }, { c: 1, r: 5 }]; });
    A = d.A; st = A.state();
    for (var tq = 0; tq < 25 && A.celulaPlayer().r === 1; tq++) { A.mover(1, 0, 1 / 30); A.update(1 / 30); }
    var cel = A.celulaPlayer();
    check('Nucleo: entrar no portal leva ao par', cel.c === 1 && cel.r === 5, cel.c + ',' + cel.r);
    A.update(1 / 30); A.update(1 / 30);
    cel = A.celulaPlayer();
    check('Nucleo: parado no pad de chegada nao volta (sem ping-pong)', cel.c === 1 && cel.r === 5);
})();

// ---------------------------------------------------------------- physics --
(function () {
    console.log('SDK physics (tools/sdk/engine/celeros.physics.js):');
    var P = require('../../tools/sdk/engine/celeros.physics.js');

    check('exporta version', typeof P.version === 'string' && !!P.version);

    // P.hit: os tres pares de formas
    var box1 = { x: 100, y: 100, w: 20, h: 20 }, box2 = { x: 110, y: 110, w: 20, h: 20 };
    var boxFar = { x: 200, y: 200, w: 20, h: 20 };
    var ball1 = { x: 100, y: 100, r: 10 }, ball2 = { x: 115, y: 100, r: 10 };
    check('hit aabb-aabb detecta', P.hit(box1, box2) === true);
    check('hit aabb-aabb rejeita longe', P.hit(box1, boxFar) === false);
    check('hit circle-circle detecta', P.hit(ball1, ball2) === true);
    check('hit circle-aabb detecta', P.hit(ball1, box2) === true);
    check('hit circle-aabb rejeita longe', P.hit({ x: 50, y: 50, r: 5 }, boxFar) === false);

    // 2.0: o solver arcade interpretado saiu (P.world/P.tiles/P.flow) —
    // ficam so P.hit, verlet (JS), verletFast (nativo/fallback) e P.rigid
    check('2.0 nao exporta mais P.world/P.tiles/P.flow',
          P.world === undefined && P.tiles === undefined && P.flow === undefined);


    // verlet: corda presa conserva o comprimento total
    var pts = [];
    for (var p = 0; p < 6; p++) pts.push({ x: 120, y: 20 + p * 10 });
    var sticksSpec = [];
    for (var q = 1; q < 6; q++) sticksSpec.push({ a: q - 1, b: q });
    var rope = P.verlet({ points: pts, sticks: sticksSpec, iterations: 4 });
    rope.pin(0);
    var len0 = 0;
    for (var s1 = 0; s1 < rope.sticks.length; s1++) len0 += rope.sticks[s1].len;
    for (var n8 = 0; n8 < 120; n8++) rope.step(1 / 60);
    var len1 = 0;
    for (var s2 = 0; s2 < rope.sticks.length; s2++) {
        var A = rope.points[rope.sticks[s2].a], B = rope.points[rope.sticks[s2].b];
        len1 += Math.sqrt((A.x - B.x) * (A.x - B.x) + (A.y - B.y) * (A.y - B.y));
    }
    check('corda de verlet conserva comprimento',
          Math.abs(len1 - len0) / len0 < 0.05, 'len ' + len0.toFixed(1) + ' -> ' + len1.toFixed(1));
    check('corda pendura abaixo do pino', rope.points[5].y > rope.points[0].y + 20);


})();

// ------------------------------------------------------------------- deps --
(function () {
    console.log('SDK deps (celeros.sfx + celeros.grid):');
    var SFX = require('../../tools/sdk/engine/celeros.sfx.js');
    var GRID = require('../../tools/sdk/engine/celeros.grid.js');

    // sfx
    check('sfx exporta version e tabela', typeof SFX.version === 'string' &&
          Array.isArray(SFX.tabela.boomPeq));
    var m = SFX.mel('coin');
    m[0][0] = 1;
    check('sfx.mel devolve copia (mutar nao suja a tabela)',
          SFX.tabela.coin[0][0] === 988, JSON.stringify(SFX.tabela.coin[0]));
    check('sfx.mel de nome unico vira melodia de 1 nota',
          SFX.mel('ui').length === 1 && SFX.mel('ui')[0][0] === 880);
    check('sfx.mel de nome inexistente e null', SFX.mel('nada') === null);
    var tr = SFX.transpor([[440, 100], [0, 50]], 12);
    check('sfx.transpor dobra a frequencia e preserva a pausa',
          tr[0][0] === 880 && tr[1][0] === 0, JSON.stringify(tr));
    check('sfx.tempo escala duracoes com piso de 15 ms',
          SFX.tempo([[440, 100]], 0.5)[0][1] === 50 &&
          SFX.tempo([[440, 10]], 0.5)[0][1] === 15);
    var tocou = null;
    var audioFake = { sfx: function (mel) { tocou = mel; } };
    SFX.via(audioFake, 'boomGra', { oitava: 1 });
    check('sfx.via toca variante (transposta) pelo audio',
          tocou && tocou.length === 3 && tocou[0][0] === 200,
          tocou ? JSON.stringify(tocou[0]) : 'null');
    check('sfx.via sem audio e no-op', SFX.via(null, 'ui') === false);

    // grid
    check('grid exporta version', typeof GRID.version === 'string');
    var ra = GRID.rng(7), rb = GRID.rng(7);
    check('grid.rng deterministico', ra() === rb() && ra() === rb());
    var ar = GRID.classica(15, 13, GRID.rng(101), { dens: 0.55 });
    check('grid.classica: borda e pilares nas pares',
          ar.grid[0][0] === '#' && ar.grid[12][14] === '#' && ar.grid[2][2] === '#');
    check('grid.classica: canto do spawn respira (protege + vizinhos)',
          ar.grid[1][1] === '.' && ar.grid[2][1] === '.' && ar.grid[1][2] === '.');
    check('grid.classica: lista de macios bate com o grid',
          GRID.contar(ar.grid, '%') === ar.macios.length && ar.macios.length > 0);
    var fr = GRID.flood(ar.grid, 1, 1, function (ch) { return ch !== '#'; });
    check('grid.flood: explodindo macios alcansa a maioria da arena',
          fr.quantos > 15 * 13 * 0.5, 'quantos=' + fr.quantos);
    var fl = GRID.flood(ar.grid, 1, 1, function (ch) { return ch === '.'; });
    check('grid.flood: so celulas livres alcanca menos',
          fl.quantos < fr.quantos, 'livres=' + fl.quantos);
    // flow (1.1.0): BFS ate o alvo; next desce um passo; parede = sem caminho
    var gf = GRID.nova(7, 3, '#');
    for (var fc = 1; fc <= 5; fc++) gf[1][fc] = '.';
    var campo = GRID.flow(gf, 1, 1, function (ch) { return ch === '.'; });
    var nx1 = campo.next(5, 1);
    check('grid.flow: distancia e next descem ate o alvo',
          campo.dist(5, 1) === 4 && nx1 && nx1.c === 4 && nx1.r === 1 &&
          campo.next(1, 1) === null && campo.dist(0, 0) === -1 && campo.next(0, 1) === null,
          JSON.stringify([campo.dist(5, 1), nx1]));
    // escolheAlcancavel: bolso cercado por # e rejeitado em favor do livre
    var gsel = GRID.nova(7, 5, '#');
    for (var cc = 1; cc <= 5; cc++) gsel[1][cc] = '.';
    gsel[2][5] = '%';   // vizinho de (5,1): alcancavel
    // (3,3) segue '#': qualquer candidato la dentro e isolado
    var escolhido = GRID.escolheAlcancavel(gsel, [{ c: 3, r: 3 }, { c: 5, r: 2 }], 1, 1);
    check('grid.escolheAlcancavel pula o bolso isolado',
          escolhido && escolhido.c === 5 && escolhido.r === 2,
          escolhido ? escolhido.c + ',' + escolhido.r : 'null');
    check('grid.escolheAlcancavel sem opcao devolve o primeiro',
          GRID.escolheAlcancavel(gsel, [{ c: 3, r: 3 }], 1, 1).c === 3);
    var livre = GRID.celulaLivre(ar.grid, GRID.rng(3), function (c, r, ch) {
        return ch === '.' && c + r > 12;
    });
    check('grid.celulaLivre respeita o filtro',
          livre && ar.grid[livre.r][livre.c] === '.' && livre.c + livre.r > 12,
          livre ? livre.c + ',' + livre.r : 'null');
})();

// tamanho de uma dep como o hub a guarda (enxuta pelo jsstrip, o porte 1:1
// do JsStripper do firmware — publish-dep sobe assim)
var JSSTRIP = require('../../tools/sdk/lib/jsstrip.js');
function depSize(nome) {
    return JSSTRIP.strip(fs.readFileSync(path.join(ROOT, 'tools', 'sdk', 'engine', nome + '.js'))).length;
}
// fecho transitivo de uma dep (arestas do tools/sdk/engine/index.json — a
// familia CelerGame se compoe, celeros.engine require celeros.game*): o
// hub resolve no install e as transitivas contam no teto do app junto
var LOCAL_INDEX = null;
function depEdges(nome) {
    if (!LOCAL_INDEX) {
        try {
            LOCAL_INDEX = JSON.parse(fs.readFileSync(
                path.join(ROOT, 'tools', 'sdk', 'engine', 'index.json'), 'utf8'));
        } catch (e) { LOCAL_INDEX = {}; }
    }
    return (LOCAL_INDEX[nome] || {}).deps || {};
}
function depFiles(nome, into) {
    into = into || {};
    if (into[nome]) return into;
    into[nome] = 1;
    var e = depEdges(nome);
    for (var k in e) if (e.hasOwnProperty(k)) depFiles(k, into);
    return into;
}
function depsSize(nomes) {
    var files = {};
    nomes.forEach(function (n) { depFiles(n, files); });
    var t = 0;
    for (var k in files) if (files.hasOwnProperty(k)) t += depSize(k);
    return t;
}

// ----------------------------------------------------------------- engine --
(function () {
    console.log('SDK engine (tools/sdk/engine/celeros.engine.js):');
    var harness = require('../../test/js_harness/run.js');
    var ENGINE_DIR = path.join(ROOT, 'tools', 'sdk', 'engine');

    // roda um snippet com require("celeros.engine") real sobre o harness
    // (relogio virtual, touchQ); setup(env) roda antes do snippet
    function runEngine(code, setup) {
        var env = harness.makeEnv();
        var req = harness.makeRequire(ENGINE_DIR, env);
        var grabbed = {};
        env.__harness.grab = function (k, v) { grabbed[k] = v; };
        if (setup) setup(env);
        var fn = new Function('System', 'Storage', '__harness', 'require', code);
        fn(env.System, env.Storage, env.__harness, req);
        return { env: env, grabbed: grabbed, log: env.__harness.log };
    }

    // caps e init
    var r = runEngine(
        'var E = require("celeros.engine");' +
        '__harness.grab("caps", E.init({ fps: 30, save: "tst." }));' +
        '__harness.grab("wh", [E.W, E.H]);');
    check('init devolve caps com tela 240x320',
          r.grabbed.caps && r.grabbed.caps.w === 240 && r.grabbed.caps.h === 320 &&
          r.grabbed.wh[0] === 240 && r.grabbed.wh[1] === 320,
          JSON.stringify(r.grabbed));
    check('caps detecta sem PSRAM no host (getInfo do harness)',
          r.grabbed.caps.psram === false && r.grabbed.caps.speaker === true);

    // cenas: enter/update/draw/exit na ordem, goto e quit
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'var marks = [];' +
        'E.run({' +
        '  a: { enter: function () { marks.push("a.enter"); },' +
        '       update: function () { marks.push("a.update");' +
        '                             if (marks.length >= 4) E.goto("b"); },' +
        '       draw: function () { marks.push("a.draw"); },' +
        '       exit: function () { marks.push("a.exit"); } },' +
        '  b: { enter: function () { marks.push("b.enter"); E.quit(); } }' +
        '}, "a");' +
        '__harness.grab("marks", marks);');
    check('cenas: ciclo enter/update/draw/exit + goto + quit',
          JSON.stringify(r.grabbed.marks) === JSON.stringify(
              ['a.enter', 'a.update', 'a.draw', 'a.update', 'a.draw', 'a.exit', 'b.enter']),
          JSON.stringify(r.grabbed.marks));

    // a familia ENXUTA (como o hub serve cada modulo) roda igual: o mesmo
    // ciclo de cenas atraves do shim, com o require resolvendo os fontes
    // enxutos dos irmaos (o jsstrip preserva as linhas — "line N" bate)
    (function () {
        var env = harness.makeEnv();
        var linhasIguais = true;
        var cache = {};
        function stripReq(name) {
            var base = name.replace(/\.js$/, '');
            if (cache[base]) return cache[base];
            var mod = { exports: {} };
            cache[base] = mod.exports;   // parcial, como o firmware
            var file = path.join(ENGINE_DIR, base + '.js');
            var code = JSSTRIP.strip(fs.readFileSync(file)).toString('utf8');
            if (code.split('\n').length !== fs.readFileSync(file, 'utf8').split('\n').length) {
                linhasIguais = false;
            }
            new Function('System', 'Storage', 'module', 'exports', 'require',
                         code)(env.System, env.Storage, mod, mod.exports, stripReq);
            cache[base] = mod.exports;   // final: o modulo pode trocar o exports
            return mod.exports;
        }
        var E2 = stripReq('celeros.engine');
        var marks = [];
        E2.init({});
        E2.run({ a: { update: function () { marks.push(1); if (marks.length >= 3) E2.quit(); } } }, 'a');
        check('familia enxuta (jsstrip) preserva as linhas e roda o loop',
              linhasIguais && marks.length === 3 &&
              E2.version === '1.2.5' && E2._mods.length === 3,
              'linhas=' + linhasIguais);
    })();

    // input: tap, swipe e justDown sinteticos via touchQ
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'var ev = [];' +
        'E.run({ jogo: { update: function () {' +
        '  if (E.input.justDown) ev.push("down");' +
        '  if (E.input.tap) ev.push("tap@" + E.input.tap.x + "," + E.input.tap.y);' +
        '  if (E.input.swipe) ev.push("swipe:" + E.input.swipe.dir);' +
        '  if (ev.length >= 4) E.quit();' +
        '} } }, "jogo");' +
        '__harness.grab("ev", ev);',
        function (env) {
            env.__harness.pushTouch([{ x: 30, y: 40, touched: 1 }, { x: 30, y: 40, touched: 0 }]);
            env.__harness.swipe(120, 200, 30, 200);
        });
    check('input: justDown + tap com coords',
          r.grabbed.ev[0] === 'down' && r.grabbed.ev[1] === 'tap@30,40',
          JSON.stringify(r.grabbed.ev));
    check('input: swipe reconhece direcao',
          r.grabbed.ev[3] === 'swipe:left', JSON.stringify(r.grabbed.ev));

    // timers da engine: after e every (tickados pelo loop, sem setTimeout)
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'var got = [];' +
        'E.after(200, function () { got.push("after"); });' +
        'var id = E.every(100, function () { got.push("every"); E.cancel(id); });' +
        'E.run({ s: { update: function () {' +
        '  if (got.length >= 2) E.quit(); } } }, "s");' +
        '__harness.grab("got", got);');
    check('timers: after e every (com cancel) disparam no loop',
          r.grabbed.got.indexOf('after') >= 0 && r.grabbed.got.indexOf('every') >= 0,
          JSON.stringify(r.grabbed.got));

    // callback que limpa a lista no MEIO do tick nao derruba o E.run (o
    // iterador caia em undefined e t.dead explodia fora do loop)
    var erroTimer = null;
    try {
        r = runEngine(
            'var E = require("celeros.engine"); E.init({});' +
            'var rodou = 0; var t0 = System.millis();' +
            'E.after(100, function () { rodou++; });' +          // indice 0: vence o clear
            'E.after(100, function () { E.clearTimers(); });' +  // indice 1: roda PRIMEIRO (reverse)
            'E.run({ s: { update: function () { if (System.millis() > t0 + 250) E.quit(); } } }, "s");' +
            '__harness.grab("rodou", rodou);');
    } catch (e) { erroTimer = String(e); }
    check('timer cujo callback limpa a lista no meio do tick nao derruba o run',
          erroTimer === null && r.grabbed.rodou === 0,
          erroTimer || ('rodou=' + r.grabbed.rodou));

    var erroTween = null;
    try {
        r = runEngine(
            'var E = require("celeros.engine"); E.init({});' +
            'var obj = { x: 0 }, obj2 = { x: 0 }; var t0 = System.millis();' +
            'E.tween(obj, { x: 10 }, 100, {});' +
            'E.tween(obj2, { x: 10 }, 100, { onDone: function () { E.clearTweens(); } });' +
            'E.run({ s: { update: function () { if (System.millis() > t0 + 300) E.quit(); } } }, "s");' +
            '__harness.grab("t2", obj2.x);');
    } catch (e) { erroTween = String(e); }
    check('tween cujo onDone limpa a lista no meio do tick nao derruba o run',
          erroTween === null && r.grabbed.t2 === 10,
          erroTween || ('t2=' + r.grabbed.t2));

    // tween com easing linear chega no alvo e chama onDone
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'var obj = { x: 0, done: false };' +
        'E.tween(obj, { x: 100 }, 500, { ease: E.m.linear,' +
        '          onDone: function () { obj.done = true; } });' +
        'E.run({ s: { update: function () { if (obj.done) E.quit(); } } }, "s");' +
        '__harness.grab("x", obj.x);');
    check('tween chega no alvo com onDone', r.grabbed.x === 100,
          'x=' + r.grabbed.x);

    // grupo: swap-pop remove mortos; pool recicla
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'var g = E.group();' +
        'g.add({ update: function () { this.n = (this.n || 0) + 1; } });' +
        'g.add({ dead: true, update: function () { throw "nao devia rodar"; } });' +
        'g.update(0.016);' +
        '__harness.grab("count", g.count);' +
        'var p = E.pool(2, function () { return { v: 0, update: function () { this.v++; } }; });' +
        'var a = p.spawn(), b = p.spawn();' +
        'p.update(0.016); p.update(0.016);' +
        'var cheio = p.spawn();' +
        'a.dead = true;' +
        'var rec = p.spawn();' +
        '__harness.grab("pool", [a.v, b.v, !cheio, rec === a]);');
    check('grupo remove dead (swap-pop) e updatea vivos',
          r.grabbed.count === 1, 'count=' + r.grabbed.count);
    check('pool: lota, e spawn recicla o corpo morto',
          r.grabbed.pool[0] === 2 && r.grabbed.pool[1] === 2 &&
          r.grabbed.pool[2] === true && r.grabbed.pool[3] === true,
          JSON.stringify(r.grabbed.pool));

    // sprites sem API de sprite (placa pobre): painter e chamado no load e
    // no blit com x/y absolutos
    r = runEngine(
        'var E = require("celeros.engine"); E.init({ dir: "Teste" });' +
        'var painted = [];' +
        'E.spr.load([{ name: "heroi", file: "heroi", w: 8, h: 8,' +
        '  paint: function (w, h, x, y) { painted.push([w, h, x, y]); } }]);' +
        'E.spr.blit("heroi", 10, 20);' +
        'E.spr.blit("fantasma", 0, 0);' +
        '__harness.grab("spr", [E.spr.has("heroi"), painted.length, painted[0][2], painted[0][3]]);',
        function (env) { delete env.System.drawPNG; delete env.System.createSprite; });
    check('sprite sem sprites/PNG: painter fallback recebe (w,h,x,y) no blit',
          r.grabbed.spr[0] === true && r.grabbed.spr[1] === 1 &&
          r.grabbed.spr[2] === 10 && r.grabbed.spr[3] === 20,
          JSON.stringify(r.grabbed.spr));

    // com sprites + PNG disponiveis, o slot aloca id do pool
    r = runEngine(
        'var E = require("celeros.engine"); E.init({ dir: "Teste" });' +
        'E.spr.load([{ name: "a", file: "a", w: 8, h: 8, paint: function () {} },' +
        '            { name: "b", file: "b", w: 8, h: 8, paint: function () {} }]);' +
        '__harness.grab("slots", [!!E.spr._slots.a.id, !!E.spr._slots.b.id, E.spr._used]);' +
        'E.spr.free("a");' +
        '__harness.grab("posfree", E.spr._used);');
    check('sprite com PNG: aloca 2 slots do pool e free devolve',
          r.grabbed.slots[0] === true && r.grabbed.slots[1] === true &&
          r.grabbed.slots[2] === 2 && r.grabbed.posfree === 1,
          JSON.stringify(r.grabbed.slots) + ' free=' + r.grabbed.posfree);

    // fx: burst spawna, tick mata por life, popText registra floater
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'E.fx.burst(120, 160, { n: 5, life: 0.2 });' +
        'var vivas0 = 0;' +
        'for (var i = 0; i < E.fx._parts.length; i++) if (!E.fx._parts[i].dead) vivas0++;' +
        'E.fx.popText(10, 10, "oi");' +
        'E.fx.draw();' +
        'E.run({ s: { update: function () {' +
        '  var vivos = 0;' +
        '  for (var j = 0; j < E.fx._parts.length; j++) if (!E.fx._parts[j].dead) vivos++;' +
        '  if (vivos === 0) E.quit();' +
        '} } }, "s");' +
        '__harness.grab("fx", [vivas0, E.fx._floaters.length]);');
    check('fx: burst spawna 5 e tick mata por life',
          r.grabbed.fx[0] === 5 && r.grabbed.fx[1] === 1, JSON.stringify(r.grabbed.fx));

    // audio: sfx por nome e melodia, beat via musicPos
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'var b0 = E.audio.beat();' +
        'E.audio.sfx("ui");' +
        'E.audio.sfx("inexistente");' +
        'E.audio.sfx([440, 30]);' +
        'E.audio.music({ bpm: 120, loops: 1,' +
        '  tracks: [{ wave: "sq", vol: 80, notes: [[69, 16]] }] });' +
        'var batida = E.audio.beat();' +
        'E.audio.stop();' +
        '__harness.grab("aud", [b0, batida >= 0, !E.audio.playing()]);',
        function (env) { delete env.System.sfx; });   // firmware < API 32
    var tones = r.log.filter(function (l) { return l.indexOf('[tone]') === 0; });
    check('audio: sem System.sfx, sfx por nome e melodia chegam ao playTone (2 tons)',
          tones.length === 2, JSON.stringify(tones));
    check('audio: beat -1 sem musica e >= 0 com musica tocando',
          r.grabbed.aud[0] === -1 && r.grabbed.aud[1] === true && r.grabbed.aud[2] === true,
          JSON.stringify(r.grabbed.aud));

    // slots por sonda: o cap vem do firmware (spriteSlots) — a def que passa
    // do limite vira painter; sem a chamada (firmware velho) fica em 4
    function slotDefs(n) {
        var defs = [];
        for (var i = 0; i < n; i++)
            defs.push({ name: 's' + i, w: 8, h: 8, paint: function () {} });
        return defs;
    }
    r = runEngine(
        'var E = require("celeros.engine"); E.init({ dir: "Teste" });' +
        '__harness.grab("cap", E.caps.slots);' +
        'E.spr.load(__harness.defs);' +
        '__harness.grab("res", [E.spr._used, E.spr.backed("s3"), E.spr.backed("s4")]);',
        function (env) { env.__harness.defs = slotDefs(5); });
    check('slots: cap 4 do stub — 4 slots e a 5a def vira painter',
          r.grabbed.cap === 4 && r.grabbed.res[0] === 4 &&
          r.grabbed.res[1] === true && r.grabbed.res[2] === false,
          JSON.stringify(r.grabbed));
    r = runEngine(
        'var E = require("celeros.engine"); E.init({ dir: "Teste" });' +
        '__harness.grab("cap", E.caps.slots);' +
        'E.spr.load(__harness.defs);' +
        '__harness.grab("res", [E.spr._used, E.spr.backed("s7"), E.spr.backed("s8")]);',
        function (env) {
            env.System.spriteSlots = function () { return 8; };
            env.__harness.defs = slotDefs(9);
        });
    check('slots: cap 8 (API 29) — 8 slots e a 9a def vira painter',
          r.grabbed.cap === 8 && r.grabbed.res[0] === 8 &&
          r.grabbed.res[1] === true && r.grabbed.res[2] === false,
          JSON.stringify(r.grabbed));

    // audio.duck: abafa a trilha (sfx destrava na janela) e retoma sozinho
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'var semMusica = E.audio.duck(300);' +
        'E.audio.music({ bpm: 120, loops: 1,' +
        '  tracks: [{ wave: "sq", vol: 80, notes: [[69, 16]] }] });' +
        'var d1 = E.audio.duck(500);' +
        'var parada = E.audio.playing();' +
        'E.audio.sfx("boom");' +
        'E.audio._tick();' +
        'var aindaParada = E.audio.playing();' +
        'System.delay(600);' +
        'E.audio._tick();' +
        '__harness.grab("duck", [semMusica, d1, parada, aindaParada, E.audio.playing()]);',
        function (env) { delete env.System.sfx; });   // duck so existe sem mistura
    var duckTones = r.log.filter(function (l) { return l.indexOf('[tone]') === 0; });
    check('audio.duck: sfx toca na janela (playing falso destrava o canal)',
          duckTones.length === 1, JSON.stringify(duckTones));
    check('audio.duck: para a trilha e retoma sozinho depois da janela',
          r.grabbed.duck[0] === false && r.grabbed.duck[1] === true &&
          r.grabbed.duck[2] === false && r.grabbed.duck[3] === false &&
          r.grabbed.duck[4] === true,
          JSON.stringify(r.grabbed.duck));

    // API 32: sfx misturado — nao bloqueia, toca COM musica, duck vira no-op
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'E.audio.music({ bpm: 120, loops: 1,' +
        '  tracks: [{ wave: "sq", vol: 80, notes: [[69, 16]] }] });' +
        'var t0 = System.millis();' +
        'E.audio.sfx("boom");' +
        'E.audio.sfx([[440, 30], [0, 10], [660, 30]]);' +
        'var d = E.audio.duck(500);' +
        '__harness.grab("mix", [E.caps.mix, E.audio.playing(), d, System.millis() - t0]);');
    var sfxLog = r.log.filter(function (l) { return l.indexOf('[sfx]') === 0; });
    var toneLog = r.log.filter(function (l) { return l.indexOf('[tone]') === 0; });
    check('audio (API 32): sfx vai ao System.sfx por cima da musica, sem playTone',
          r.grabbed.mix[0] === true && sfxLog.length === 2 && toneLog.length === 0,
          JSON.stringify([r.grabbed.mix, sfxLog, toneLog]));
    check('audio (API 32): duck no-op — a trilha segue tocando',
          r.grabbed.mix[1] === true && r.grabbed.mix[2] === false,
          JSON.stringify(r.grabbed.mix));

    // 1.2: escala por pixel — E.U e E.font escolhem a fonte pela altura
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'var f8 = E.font(8), f16 = E.font(16), f24 = E.font(24), f3 = E.font(3), f99 = E.font(99);' +
        '__harness.grab("ty", [E.U, E.u(10), f8.h, f16.h, f24.h, f3.h, f99.h <= 99 * 1.08]);');
    check('E.U = 1 no 240x320 e E.u escala', r.grabbed.ty[0] === 1 && r.grabbed.ty[1] === 10,
          JSON.stringify(r.grabbed.ty));
    check('E.font: maior fonte que cabe na altura (8/16/24) e piso na menor',
          r.grabbed.ty[2] === 8 && r.grabbed.ty[3] === 16 && r.grabbed.ty[4] === 24 &&
          r.grabbed.ty[5] === 8 && r.grabbed.ty[6] === true,
          JSON.stringify(r.grabbed.ty));
    r = runEngine(
        'var E = require("celeros.engine"); E.init({ native: true });' +
        '__harness.grab("u", [E.W, E.U, E.u(10)]);');
    check('canvas nativo 480: E.U = 2', r.grabbed.u[0] === 480 && r.grabbed.u[1] === 2 &&
          r.grabbed.u[2] === 20, JSON.stringify(r.grabbed.u));

    // texto fit: encolhe ate caber na largura
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'var big = E.gfx.measure("SUPERNOVA", { px: 40 });' +
        'var sizes = []; var ss = System.setTextSize;' +
        'System.setTextSize = function (n) { sizes.push(n); ss(n); };' +
        'E.gfx.text("SUPERNOVA", 120, 10, { px: 40, fit: 100, align: "center" });' +
        'var st = E.font(8);' +
        '__harness.grab("fit", [big, sizes.length, E.gfx.measure("SUPERNOVA", { font: st.font, size: st.size })]);');
    check('text fit: rotulo largo (px 40 = 252 px) encolhe ate caber em 100 (size 1)',
          r.grabbed.fit[0] > 100 && r.grabbed.fit[1] === 0 && r.grabbed.fit[2] <= 100,
          JSON.stringify(r.grabbed.fit));

    // cena static: draw so na entrada, no redraw() e no press de botao
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'var draws = 0, frames = 0;' +
        'E.run({ menu: { static: true,' +
        '  update: function () { frames++; if (frames === 5) E.redraw();' +
        '                       if (frames >= 12) E.quit(); },' +
        '  draw: function () { draws++; E.gfx.button("OK", 20, 20, 100, 40); }' +
        '} }, "menu");' +
        '__harness.grab("st", [draws, frames]);',
        function (env) {
            // dedo desce no botao no frame ~8 e solta no ~10
            env.__harness.pushTouch([{ touched: 0 }, { touched: 0 }, { touched: 0 }, { touched: 0 },
                                     { touched: 0 }, { touched: 0 }, { touched: 0 },
                                     { x: 50, y: 30, touched: 1 }, { x: 50, y: 30, touched: 1 },
                                     { x: 50, y: 30, touched: 0 }]);
        });
    check('cena static: 1 draw na entrada + redraw() + press/solta do botao (4 no total)',
          r.grabbed.st[0] === 4 && r.grabbed.st[1] === 12, JSON.stringify(r.grabbed.st));

    // camada suja: o 2o quadro apaga so as caixas do 1o (sem fillScreen)
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'var fills = [], frames = 0, sc = System.fillScreen;' +
        'var fr = System.fillRect;' +
        'System.fillRect = function (x, y, w, h, c) { fills.push([x, y, w, h]); fr(x, y, w, h, c); };' +
        'E.run({ jogo: {' +
        '  enter: function () { E.dirty.enable(0x0000); },' +
        '  update: function () { frames++; if (frames >= 3) E.quit(); },' +
        '  draw: function () { fills.push("draw"); E.gfx.circle(50 + frames * 10, 60, 6, 0xFFFF); }' +
        '} }, "jogo");' +
        '__harness.grab("dl", fills);');
    var dl = r.grabbed.dl;
    check('E.dirty: 1o quadro repinta o fundo inteiro, o 2o apaga so a caixa do circulo',
          dl[0][2] === 240 && dl[0][3] === 320 && dl[1] === 'draw' &&
          dl[2][2] < 30 && dl[2][3] < 30 && dl[3] === 'draw',
          JSON.stringify(dl));
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'var fulls = [], frames = 0, fr = System.fillRect;' +
        'System.fillRect = function (x, y, w, h, c) { if (w === 240 && h === 320) fulls.push(frames); fr(x, y, w, h, c); };' +
        'E.run({ jogo: {' +
        '  enter: function () { E.dirty.enable(0x0000); },' +
        '  update: function () { frames++; if (frames >= 4) E.quit(); },' +
        '  draw: function () { if (frames === 2) E.fx.flash(0xFFFF, 40, { full: true }); E.fx.draw(); }' +
        '} }, "jogo");' +
        '__harness.grab("fl", fulls);');
    check('E.dirty: full() pedido no draw (flash de tela cheia) repinta o fundo no quadro seguinte',
          r.grabbed.fl.indexOf(1) >= 0 && r.grabbed.fl.indexOf(3) >= 0,
          JSON.stringify(r.grabbed.fl));
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'var pinted = [];' +
        'var m = E.tilemap({ cols: 15, rows: 13, cell: 16, paint: function (c, r) { pinted.push(c + "," + r); } });' +
        'm.markRect(10, 10, 10, 10);' +
        'var n1 = m.dirty(); m.markRect(10, 10, 10, 10); var n2 = m.dirty();' +
        'var f = m.flush();' +
        'm.all(); var tot = m.dirty();' +
        '__harness.grab("tm", [n1, n2, f, pinted.join(" "), tot, m.cellAt(40, 40).c]);');
    check('tilemap: markRect marca as celulas tocadas (sem duplicar) e flush repinta',
          r.grabbed.tm[0] === 4 && r.grabbed.tm[1] === 4 && r.grabbed.tm[2] === 4 &&
          r.grabbed.tm[3] === '0,0 1,0 0,1 1,1' && r.grabbed.tm[4] === 195 &&
          r.grabbed.tm[5] === 2,
          JSON.stringify(r.grabbed.tm));

    // save: prefixo + best (recorde)
    r = runEngine(
        'var E = require("celeros.engine"); E.init({ save: "tst." });' +
        'E.save.set("hi", 42);' +
        'var get = [E.save.get("hi"), E.save.get("nada", "def"), E.save.num("hi")];' +
        'var b1 = E.save.best("hi", 10);' +
        'var b2 = E.save.best("hi", 99);' +
        '__harness.grab("save", [get, b1, b2, E.save.num("hi")]);');
    check('save: get/set/num com prefixo', r.grabbed.save[0][0] === '42' &&
          r.grabbed.save[0][1] === 'def' && r.grabbed.save[0][2] === 42,
          JSON.stringify(r.grabbed.save[0]));
    check('save: best so grava recorde novo',
          r.grabbed.save[1] === false && r.grabbed.save[2] === true &&
          r.grabbed.save[3] === 99);

    // mat/rng: clamp/lerp/wrap e xorshift deterministico
    r = runEngine(
        'var E = require("celeros.engine");' +
        'var r1 = E.rng(42), r2 = E.rng(42);' +
        'var s1 = [r1(), r1(), r1()].join(","), s2 = [r2(), r2(), r2()].join(",");' +
        '__harness.grab("rng", [s1 === s2, s1.length > 0]);' +
        '__harness.grab("math", [E.m.clamp(5, 0, 3), E.m.lerp(0, 10, 0.5), E.m.wrap(250, 0, 240)]);');
    check('rng deterministico por seed', r.grabbed.rng[0] === true);
    check('math: clamp/lerp/wrap',
          r.grabbed.math[0] === 3 && r.grabbed.math[1] === 5 && r.grabbed.math[2] === 10,
          JSON.stringify(r.grabbed.math));

    // fps por cena: cena com fps 10 avanca o relogio ~100 ms por frame
    r = runEngine(
        'var E = require("celeros.engine"); E.init({ fps: 60 });' +
        'var frames = 0;' +
        'E.run({ lento: { fps: 10, update: function () {' +
        '  frames++; if (frames >= 6) E.quit(); } } }, "lento");' +
        '__harness.grab("ms", System.millis());');
    check('scene.fps sobrepoe o alvo global (5 frames a 10 fps ~ +500 ms)',
          r.grabbed.ms >= 1480 && r.grabbed.ms <= 1650, 'ms=' + r.grabbed.ms);

    // E.fx.ring: onda de choque com expansao propria
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'E.fx.ring(100, 100, { speed: 500, color: 0xFFE0, life: 0.5 });' +
        'var p = null;' +
        'for (var i = 0; i < E.fx._parts.length; i++) if (!E.fx._parts[i].dead) p = E.fx._parts[i];' +
        '__harness.grab("ring", [p && p.shape, p && p.grow]);');
    check('fx.ring cria onda com grow configurado',
          r.grabbed.ring[0] === 'ring' && r.grabbed.ring[1] === 500,
          JSON.stringify(r.grabbed.ring));

    // spr.backed: sem createSprite o sprite existe, mas nao tem slot real
    r = runEngine(
        'var E = require("celeros.engine"); E.init({});' +
        'E.spr.load([{ name: "x", file: "x", w: 4, h: 4, paint: function () {} }]);' +
        '__harness.grab("backed", [E.spr.has("x"), E.spr.backed("x")]);',
        function (env) { delete env.System.createSprite; delete env.System.drawPNG; });
    check('spr.backed distingue slot real de painter',
          r.grabbed.backed[0] === true && r.grabbed.backed[1] === false,
          JSON.stringify(r.grabbed.backed));
})();

// ---------------------------------------------------- familia CelerGame --
(function () {
    console.log('SDK CelerGame (familia modular celeros.game*):');
    var harness = require('../../test/js_harness/run.js');

    // app core-only: deps declara so o core — fx/spr/tilemap NAO existem
    // no E (quem adota pouco paga pouco: ~20KB enxuto contra ~33KB da
    // familia inteira, e deps contam no teto MESMO compartilhadas)
    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'celer-cg-'));
    fs.writeFileSync(path.join(tmp, 'app.json'),
                     JSON.stringify({ deps: { 'celeros.game': '^1.0.0' } }));
    var env = harness.makeEnv();
    var req = harness.makeRequire(tmp, env);
    var out = {};
    try {
        var fn = new Function('System', 'Storage', '__harness', 'require',
            'var E = require("celeros.game");' +
            'E.init({});' +
            'var marks = [];' +
            'E.run({ s: { update: function () { marks.push(1); if (marks.length >= 3) E.quit(); } } }, "s");' +
            '__harness.grab("core", [marks.length, E.fx, E.spr, E.tilemap, E.version, E._mods.join(",")]);');
        env.__harness.grab = function (k, v) { out[k] = v; };
        fn(env.System, env.Storage, env.__harness, req);
    } catch (e) { out.core = 'erro: ' + e; }
    check('core-only: loop roda e fx/spr/tilemap ficam de FORA (nao adotados)',
          Array.isArray(out.core) && out.core[0] === 3 &&
          out.core[1] === undefined && out.core[2] === undefined &&
          out.core[3] === undefined && out.core[4] === '1.0.0' && out.core[5] === '',
          JSON.stringify(out.core));

    // adocao por modulo: app.json declara SO o fx — o core chega pela
    // transitiva do index.json e o require devolve o MESMO E decorado
    fs.writeFileSync(path.join(tmp, 'app.json'),
                     JSON.stringify({ deps: { 'celeros.game.fx': '^1.0.0' } }));
    env = harness.makeEnv();
    req = harness.makeRequire(tmp, env);
    out = {};
    try {
        var fn2 = new Function('System', 'Storage', '__harness', 'require',
            'var FX = require("celeros.game.fx");' +
            'FX.init({});' +
            'FX.fx.burst(120, 160, { n: 4, life: 0.2 });' +
            'FX.fx.popText(10, 10, "oi");' +
            'var vivas = 0;' +
            'for (var i = 0; i < FX.fx._parts.length; i++) if (!FX.fx._parts[i].dead) vivas++;' +
            '__harness.grab("fx", [vivas, FX._mods.join(","), FX.version]);');
        env.__harness.grab = function (k, v) { out[k] = v; };
        fn2(env.System, env.Storage, env.__harness, req);
    } catch (e) { out.fx = 'erro: ' + e; }
    check('fx adotado sem declarar o core: transitiva resolve e decora o MESMO E',
          Array.isArray(out.fx) && out.fx[0] === 4 && out.fx[1] === 'fx' &&
          out.fx[2] === '1.0.0',
          JSON.stringify(out.fx));

    // require de modulo que o app nao adotou (nem transitivo): erro claro
    var erro = null;
    try {
        var fn3 = new Function('require', 'require("celeros.game.spr");');
        fn3(req);
    } catch (e) { erro = String(e); }
    check('require de modulo NAO adotado falha com erro claro',
          erro !== null && erro.indexOf('celeros.game.spr') >= 0, erro);

    // shim de compatibilidade: celeros.engine monta a familia no MESMO
    // objeto do core — a superficie 1.2.x inteira de volta
    fs.writeFileSync(path.join(tmp, 'app.json'),
                     JSON.stringify({ deps: { 'celeros.engine': '^1.2.0' } }));
    env = harness.makeEnv();
    req = harness.makeRequire(tmp, env);
    out = {};
    try {
        var fn4 = new Function('System', 'Storage', '__harness', 'require',
            'var ENG = require("celeros.engine");' +
            'var CORE = require("celeros.game");' +
            '__harness.grab("shim", [ENG === CORE, ENG.version, ENG._mods.join(","),' +
            '  typeof ENG.fx.burst, typeof ENG.spr.load, typeof ENG.tilemap]);');
        env.__harness.grab = function (k, v) { out[k] = v; };
        fn4(env.System, env.Storage, env.__harness, req);
    } catch (e) { out.shim = 'erro: ' + e; }
    check('shim celeros.engine: MESMO objeto do core + fx/spr/tilemap, version 1.2.5',
          Array.isArray(out.shim) && out.shim[0] === true && out.shim[1] === '1.2.5' &&
          out.shim[2] === 'fx,spr,tilemap' && out.shim[3] === 'function' &&
          out.shim[4] === 'function' && out.shim[5] === 'function',
          JSON.stringify(out.shim));
    fs.rmSync(tmp, { recursive: true, force: true });
})();

// ------------------------------- transicoes de cena + timeline (core 1.0) --
(function () {
    console.log('SDK CelerGame transicoes + E.seq:');
    var harness = require('../../test/js_harness/run.js');

    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'celer-tr-'));
    fs.writeFileSync(path.join(tmp, 'app.json'),
                     JSON.stringify({ deps: { 'celeros.game': '^1.0.0' } }));

    function runSnippet(code, setup) {
        var env = harness.makeEnv();
        var req = harness.makeRequire(tmp, env);
        var out = {};
        env.__harness.grab = function (k, v) { out[k] = v; };
        if (setup) setup(env);
        var fn = new Function('System', 'Storage', '__harness', 'require', code);
        fn(env.System, env.Storage, env.__harness, req);
        return out;
    }

    // fade: a troca so acontece DEPOIS da fase OUT (veu fechando sobre a)
    var r = runSnippet(
        'var E = require("celeros.game"); E.init({});' +
        'var trocou = -1, frames = 0, t0 = System.millis(), veus = 0;' +
        'var fr = System.fillRect;' +
        'System.fillRect = function (x, y, w, h, c) { if (c === 0xF800) veus++; fr(x, y, w, h, c); };' +
        'E.run({' +
        '  a: { update: function () { frames++;' +
        '        if (frames === 2) E.goto("b", { transition: "fade", ms: 300, color: 0xF800 }); },' +
        '        draw: function () {} },' +
        '  b: { enter: function () { trocou = System.millis() - t0; E.quit(); } }' +
        '}, "a");' +
        '__harness.grab("fade", [trocou, veus]);');
    check('fade: troca espera a fase OUT fechar (~150 ms) e o veu pintou',
          r.fade[0] >= 145 && r.fade[1] >= 4,
          'trocou=' + r.fade[0] + ' veus=' + r.fade[1]);

    // wipe: troca IMEDIATA e veu retraindo (larguras decrescentes)
    r = runSnippet(
        'var E = require("celeros.game"); E.init({});' +
        'var trocou = -1, frames = 0, veus = [];' +
        'var fr = System.fillRect;' +
        'System.fillRect = function (x, y, w, h, c) { if (c === 0xF800) veus.push(w); fr(x, y, w, h, c); };' +
        'E.run({' +
        '  a: { update: function () { if (++frames === 2) { E.goto("b", { transition: "wipe", ms: 120, color: 0xF800 }); trocou = frames; } },' +
        '       draw: function () {} },' +
        '  b: { update: function () { if (!E._trans && veus.length > 0) E.quit();' +
        '                             if (System.millis() > 4000) E.quit(); },' +
        '       draw: function () {} }' +
        '}, "a");' +
        '__harness.grab("wipe", [E.sceneName, veus[0], veus[veus.length - 1], veus.length]);');
    check('wipe: troca no quadro seguinte e o veu recai (240 -> menor)',
          r.wipe[0] === 'b' && r.wipe[1] === 240 && r.wipe[2] < r.wipe[1] &&
          r.wipe[3] >= 2,
          JSON.stringify(r.wipe));

    // cena static repinta sob o veu (sem input, sem redraw manual)
    r = runSnippet(
        'var E = require("celeros.game"); E.init({});' +
        'var draws = 0, frames = 0;' +
        'E.run({' +
        '  a: { update: function () { if (++frames === 2) E.goto("m", { transition: "iris", ms: 150, color: 0x0000 }); },' +
        '       draw: function () {} },' +
        '  m: { static: true, update: function () { if (draws >= 4) E.quit();' +
        '                                            if (System.millis() > 4000) E.quit(); },' +
        '       draw: function () { draws++; } }' +
        '}, "a");' +
        '__harness.grab("st", draws);');
    check('cena static repinta a cada quadro enquanto o veu vive',
          r.st >= 4, 'draws=' + r.st);

    // E.seq: passos em ordem, grupo paralelo, onDone e step final
    r = runSnippet(
        'var E = require("celeros.game"); E.init({});' +
        'var obj = { x: 0, y: 0 }, fase = [];' +
        'var h = E.seq(obj, [' +
        '  { to: { x: 10 }, ms: 100 },' +
        '  { to: { y: 20 }, ms: 100 },' +
        '  { par: [{ to: { x: 40 }, ms: 60 }, { to: { y: 80 }, ms: 120 }] }' +
        '], { onDone: function () { fase.push("done"); } });' +
        'var t0 = System.millis();' +
        'E.run({ s: { update: function () {' +
        '  if (obj.x === 10 && fase.indexOf("x10") < 0) fase.push("x10");' +
        '  if (obj.y === 20 && obj.x === 10 && fase.indexOf("y20") < 0) fase.push("y20");' +
        '  if (fase.indexOf("done") >= 0 || System.millis() > t0 + 3000) E.quit();' +
        '} } }, "s");' +
        '__harness.grab("seq", [obj.x, obj.y, fase.join(","), h.done, h.step]);');
    check('E.seq: sequencia respeita a ordem, par roda junto, onDone no fim',
          r.seq[0] === 40 && r.seq[1] === 80 &&
          r.seq[2] === 'x10,y20,done' && r.seq[3] === true && r.seq[4] === 3,
          JSON.stringify(r.seq));

    // seq.cancel corta a cadeia: tween em voo morre e onDone nunca dispara
    r = runSnippet(
        'var E = require("celeros.game"); E.init({});' +
        'var obj = { x: 0 }, fim = false, xNoCancel = -1;' +
        'var h = E.seq(obj, [{ to: { x: 10 }, ms: 100 }, { to: { x: 50 }, ms: 100 }],' +
        '              { onDone: function () { fim = true; } });' +
        'var t0 = System.millis();' +
        'E.run({ s: { update: function () {' +
        '  if (System.millis() > t0 + 150 && xNoCancel < 0) { xNoCancel = obj.x; h.cancel(); }' +
        '  if (System.millis() > t0 + 900) E.quit();' +
        '} } }, "s");' +
        '__harness.grab("cut", [xNoCancel >= 10, obj.x < 50, fim, h.done]);');
    check('seq.cancel: congela o obj no meio e onDone nao dispara',
          r.cut[0] === true && r.cut[1] === true && r.cut[2] === false &&
          r.cut[3] === false,
          JSON.stringify(r.cut));

    fs.rmSync(tmp, { recursive: true, force: true });
})();

// ------------------------------------------------------------------ mesh --
(function () {
    console.log('SDK mesh (tools/sdk/engine/celeros.mesh.js):');
    var harness = require('../../test/js_harness/run.js');

    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'celer-mesh-'));
    fs.writeFileSync(path.join(tmp, 'app.json'),
                     JSON.stringify({ deps: { 'celeros.mesh': '^1.0.0' } }));

    // placa sem BT: os globais CelerNet/Pack nem existem — o modulo tem que
    // nascer nesse mundo (o typeof do escopo e fixo por execucao, como no
    // heap do device)
    var env = harness.makeEnv();
    var mesh = harness.makeRequire(tmp, env)('celeros.mesh');
    check('exporta version', typeof mesh.version === 'string');
    check('available/active false sem CelerNet (placa sem BT)',
          mesh.available() === false && mesh.active() === false);

    // com a malha exposta (meshsim): gate desenha o portao quando desligada
    // e libera o frame quando ativa; me() e o drain da fila
    var env2 = harness.makeEnv();
    env2.__exposeMesh = true;
    var req2 = harness.makeRequire(tmp, env2);
    var mesh2 = req2('celeros.mesh');
    check('available true com CelerNet+Pack', mesh2.available() === true);
    var out = { closed: -1 };
    try {
        var fn = new Function('UI', 'System', '__harness', 'require',
            'var mesh = require("celeros.mesh");' +
            'var closed = 0;' +
            'UI.begin();' +
            'if (!mesh.gate("ligue a malha")) closed = 1;' +
            'UI.end();' +
            '__harness.grab("closed", closed);');
        env2.__harness.grab = function (k, v) { out[k] = v; };
        fn(env2.UI, env2.System, env2.__harness, req2);
    } catch (e) { out.closed = 'erro: ' + e; }
    check('gate devolve false com a malha desligada (portao desenhado)',
          out.closed === 1, String(out.closed));
    env2.CelerNet.start({});
    check('active true apos CelerNet.start', mesh2.active() === true);
    var gateOk = false;
    try { gateOk = mesh2.gate('x') === true; } catch (e) { gateOk = false; }
    check('gate devolve true com a malha ativa', gateOk);
    var me = mesh2.me();
    check('me() devolve o papel do Pack', !!(me && (me.name || me.caps)));
    var got = [];
    env2.__harness.pushMesh([{ from: 'a1', msg: 'm1' }, { from: 'b2', msg: 'm2' }]);
    var n = mesh2.each(function (m) { got.push(m.msg); }, 0);
    check('each drena a fila (2 quadros) e esvazia',
          n === 2 && got[0] === 'm1' && got[1] === 'm2' &&
          mesh2.each(function () {}, 0) === 0);
    fs.rmSync(tmp, { recursive: true, force: true });
})();

// ------------------------------------------------------- verlet nativo --
(function () {
    console.log('SDK verletFast (celeros.physics x System.verlet*, API 31):');
    var harness = require('../../test/js_harness/run.js');

    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'celer-vf-'));
    fs.writeFileSync(path.join(tmp, 'app.json'),
                     JSON.stringify({ deps: { 'celeros.physics': '^2.0.0' } }));

    // caminho nativo: o stub do harness espelha o binding C++ (JsPhysics.cpp)
    var env = harness.makeEnv();
    var P = harness.makeRequire(tmp, env)('celeros.physics');
    check('physics 1.2.0 exporta verletFast', typeof P.verletFast === 'function');
    var v = P.verletFast({ iterations: 4 });
    check('verletFast usa o nativo quando existe (stub do harness)', v.native === true);
    var a = v.add(120, 10), b = v.add(120, 40);
    check('add devolve indices crescentes', a === 0 && b === 1);
    v.stick(a, b);                    // len = distancia atual (30)
    v.pin(a);
    check('count conta os pontos', v.count() === 2);
    var st = v.sticks();
    check('sticks() devolve pares planos', st.length === 2 && st[0] === a && st[1] === b);
    for (var i = 0; i < 240; i++) v.step(1 / 60, { gravity: { x: 0, y: 900 } });
    var xy = v.xy();
    var len = Math.sqrt((xy[2] - xy[0]) * (xy[2] - xy[0]) + (xy[3] - xy[1]) * (xy[3] - xy[1]));
    check('corda pende no nativo: b desceu e o vinculo sobrevive',
          xy[3] > 35 && Math.abs(len - 30) < 1,
          'b.y=' + xy[3].toFixed(1) + ' len=' + len.toFixed(2));
    var v2 = P.verletFast({});
    var c = v2.add(120, 20);
    for (var k = 0; k < 400; k++) v2.step(1 / 60, { gravity: { x: 0, y: 900 },
                                                    bounds: { x: 0, y: 0, w: 240, h: 50 } });
    check('bounds do nativo seguram no chao', v2.xy()[1] <= 50.01,
          'y=' + v2.xy()[1].toFixed(2));
    v2.set(c, 30, 10);
    check('set reposiciona o ponto', v2.xy()[0] === 30 && v2.xy()[1] === 10);
    v2.free();
    v.free();
    check('free devolve o mundo (count 0)', v2.count() === 0);

    // fallback: firmware sem o binding — verletFast cai para o verlet JS
    var env2 = harness.makeEnv();
    delete env2.System.verletNew;
    var P2 = harness.makeRequire(tmp, env2)('celeros.physics');
    var v3 = P2.verletFast({ iterations: 4 });
    check('sem System.verletNew: cai para o verlet JS (mesma interface)',
          v3.native === false && typeof v3.xy === 'function' &&
          typeof v3.delStick === 'function' && typeof v3.step === 'function');
    var x0 = v3.add(120, 10);
    v3.pin(x0);
    for (var n = 0; n < 120; n++) v3.step(1 / 60, { gravity: { x: 0, y: 900 } });
    check('fallback pende igual (no preso no lugar)', Math.abs(v3.xy()[0] - 120) < 0.01);
    fs.rmSync(tmp, { recursive: true, force: true });
})();

// --------------------------------------------- corpo rigido (API 33) --
(function () {
    console.log('SDK P.rigid (celeros.physics x System.rigid*, API 33):');
    var harness = require('../../test/js_harness/run.js');
    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'celer-rg-'));
    fs.writeFileSync(path.join(tmp, 'app.json'),
                     JSON.stringify({ deps: { 'celeros.physics': '^2.0.0' } }));
    var env = harness.makeEnv();
    var P = harness.makeRequire(tmp, env)('celeros.physics');
    check('physics 2.1.0 exporta rigid', typeof P.rigid === 'function' && P.version === '2.1.0');
    var w = P.rigid({ iterations: 10 });
    check('rigid usa o binding (stub do harness = espelho do Rigid2D.h)', w !== null && w.id > 0);
    var chao = w.box(160, 270, 400, 20, { static: true });
    // torre: 3 andares de pilar-pilar-tabua + bola no topo
    var y = 260, ids = [];
    for (var f = 0; f < 3; f++) {
        ids.push(w.box(200, y - 15, 6, 30, { density: 1, friction: 0.7 }));
        ids.push(w.box(236, y - 15, 6, 30, { density: 1, friction: 0.7 }));
        ids.push(w.box(218, y - 33, 48, 6, { density: 1, friction: 0.7 }));
        y -= 36;
    }
    var bola = w.circle(218, y - 7, 7, { density: 0.6 });
    check('indices estaveis e crescentes', chao === 0 && ids[0] === 1 && bola === 10);
    for (var t = 0; t < 120; t++) w.step(1 / 30, { gravity: { x: 0, y: 400 } });
    var s = w.state();
    var maxDy = 0, acordados = 0;
    y = 260;
    for (f = 0; f < 3; f++) {
        maxDy = Math.max(maxDy, Math.abs(w.y(ids[f * 3], s) - (y - 15)), Math.abs(w.y(ids[f * 3 + 2], s) - (y - 33)));
        y -= 36;
    }
    for (var i = 1; i <= 10; i++) if (w.awake(i, s)) acordados++;
    check('torre fica em pe e DORME (pilha estavel)', maxDy < 1 && acordados === 0,
          'maxDy=' + maxDy.toFixed(2) + ' acordados=' + acordados);
    // tiro: pedra rapida derruba (sem atravessar)
    var pedra = w.circle(40, 200, 6, { density: 3, bounce: 0.3 });
    w.set(pedra, 40, 200, 0, 420, -40, 0);
    var hitMax = 0;
    for (t = 0; t < 30; t++) {
        w.step(1 / 30, { gravity: { x: 0, y: 400 } });
        s = w.state();
        for (i = 1; i <= 10; i++) hitMax = Math.max(hitMax, w.hit(i, s));
    }
    check('o impacto vira hit (impulso) nos corpos atingidos', hitMax > 1000, 'hit=' + hitMax.toFixed(0));
    check('pedra parou no castelo (nao atravessou)', w.x(pedra, s) < 330, 'x=' + w.x(pedra, s).toFixed(1));
    // anti-tunel: tabua fina estatica x pedra a 900 u/s
    var w2 = P.rigid();
    w2.box(160, 270, 400, 20, { static: true });
    w2.box(150, 230, 5, 60, { static: true });
    var q = w2.circle(40, 230, 5, { density: 3 });
    w2.set(q, 40, 230, 0, 900, 0, 0);
    for (t = 0; t < 30; t++) w2.step(1 / 30, { gravity: { x: 0, y: 400 } });
    check('pedra a 900 u/s nao atravessa tabua de 5', w2.x(q, w2.state()) < 150);
    check('remove libera o indice e o add reaproveita', w.remove(ids[4]) === true &&
          w.box(100, 100, 10, 10) === ids[4]);
    check('rigidState: 6 numeros por slot', w.state().length === w.count() * 6);
    // 2.1: state() reaproveita o array e encolhe com o mundo (slot alem da
    // marca d'agua nao fica "vivo" no buffer)
    var sA = w.state(), last = w.count() - 1;
    w.remove(last);
    var sB = w.state();
    check('state() devolve o MESMO array, preenchido no lugar', sA === sB);
    check('state() encolhe junto com a marca d\'agua', sB.length === w.count() * 6 && !w.alive(last, sB));
    w.free(); w2.free();
    var env2 = harness.makeEnv();
    delete env2.System.rigidNew;
    var P2 = harness.makeRequire(tmp, env2)('celeros.physics');
    check('sem System.rigidNew: P.rigid devolve null (o app avisa)', P2.rigid() === null);
    fs.rmSync(tmp, { recursive: true, force: true });
})();

// ------------------------------------------- verlet: manuseio + colisao --
(function () {
    console.log('SDK verletFast manuseio (del/pins/colisao, physics 1.3.0):');
    var harness = require('../../test/js_harness/run.js');

    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'celer-vf2-'));
    fs.writeFileSync(path.join(tmp, 'app.json'),
                     JSON.stringify({ deps: { 'celeros.physics': '^2.0.0' } }));
    var env = harness.makeEnv();
    var P = harness.makeRequire(tmp, env)('celeros.physics');

    // delStick/delPoint mantem os indices coerentes (delecoes do fim pro comeco)
    var v = P.verletFast({ iterations: 2 });
    var a = v.add(50, 50), b = v.add(80, 50), c = v.add(110, 50), d = v.add(140, 50);
    v.stick(a, b); v.stick(b, c); v.stick(c, d);
    check('3 vinculos criados', v.sticks().length === 6);
    check('delStick remove (swap do fim)', v.delStick(1) === true && v.sticks().length === 4);
    check('delStick de indice morto devolve false', v.delStick(9) === false);
    v.free();
    // delPoint no meio: vinculos ligados saem e o ultimo ponto herda o indice
    v = P.verletFast({ iterations: 2 });
    a = v.add(50, 50); b = v.add(80, 50); c = v.add(110, 50); d = v.add(140, 50);
    v.stick(a, b); v.stick(b, c); v.stick(c, d);
    check('delPoint(b) derruba o ponto', v.delPoint(b) === true && v.count() === 3);
    var st = v.sticks();
    check('delPoint remove vinculos ligados e reindexa (c-d vira 1-2)',
          st.length === 2 && st[0] === 1 && st[1] === 2,
          JSON.stringify(st));
    check('delPoint de indice morto devolve false', v.delPoint(7) === false);
    v.free();

    // pins: alterna e le
    v = P.verletFast({});
    var p0 = v.add(30, 30), p1 = v.add(60, 30);
    v.pin(p0);
    check('pins le o estado (1 fixado, 1 livre)',
          JSON.stringify(v.pins()) === '[1,0]', JSON.stringify(v.pins()));
    v.pin(p0, false);
    check('pin(idx,false) solta', v.pins()[0] === 0);
    v.free();

    // colisao ponto-ponto: dois nos soltos sobrepostos se separam; um par
    // VINCULADO nao se afasta alem do comprimento do vinculo
    var vc = P.verletFast({ iterations: 2, radius: 4 });
    var s0 = vc.add(100, 100), s1 = vc.add(101, 101);       // sobrepostos (d~1.4 < 8)
    for (var i = 0; i < 30; i++) vc.step(1, { gravity: { x: 0, y: 0 } });
    var xy = vc.xy();
    var dd = Math.sqrt((xy[0] - xy[2]) * (xy[0] - xy[2]) + (xy[1] - xy[3]) * (xy[1] - xy[3]));
    check('colisao separa nos sobrepostos e PARA (d ~ 2r, sem ejetar)',
          dd >= 7.2 && dd <= 9, 'd=' + dd.toFixed(2));
    vc.free();
    var vr = P.verletFast({ iterations: 2, radius: 4 });
    var r0 = vr.add(100, 100), r1 = vr.add(104, 100);
    vr.stick(r0, r1, 4);                                      // vinculados a 4px
    for (var k = 0; k < 30; k++) vr.step(1, { gravity: { x: 0, y: 0 } });
    var xy2 = vr.xy();
    var dr = Math.sqrt((xy2[0] - xy2[2]) * (xy2[0] - xy2[2]) + (xy2[1] - xy2[3]) * (xy2[1] - xy2[3]));
    check('par vinculado nao e separado pela colisao (fica no len)', dr < 5,
          'd=' + dr.toFixed(2));
    v.free(); vc.free(); vr.free();
    fs.rmSync(tmp, { recursive: true, force: true });
})();

// -------------------------------------------------------- scaffold --game --
(function () {
    console.log('SDK scaffold --game (engine + physics):');
    var { runLint } = require('../../tools/app_lint/lint.js');
    var { execSync } = require('child_process');
    var { runAppFolder } = require('../../tools/sdk/lib/runner.js');

    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'celer-game-'));
    var appDir = path.join(tmp, 'Quica');
    execSync('node tools/sdk/celer.js new Quica --game --dir ' + JSON.stringify(tmp),
             { cwd: ROOT });

    var want = ['app.json', 'main.js', 'icon.png', 'jsconfig.json', 'celer.d.ts',
                'README.md', 'celeros.game.d.ts', 'celeros.game.fx.d.ts'];
    var missing = want.filter(function (f) { return !fs.existsSync(path.join(appDir, f)); });
    check('scaffold de jogo cria app + tipos dos modulos adotados (dev-only)',
          missing.length === 0, 'faltam: ' + missing.join(', '));
    check('familia/physics NAO sao copiadas (deps do hub, API 30)',
          !fs.existsSync(path.join(appDir, 'celeros.game.js')) &&
          !fs.existsSync(path.join(appDir, 'celeros.game.fx.js')) &&
          !fs.existsSync(path.join(appDir, 'celeros.engine.js')) &&
          !fs.existsSync(path.join(appDir, 'celeros.physics.js')));

    var mf = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json')));
    check('app.json do jogo: type Game, psram, sem topbar',
          mf.type === 'Game' && mf.category === 'Jogos' &&
          Array.isArray(mf.requires) && mf.requires.indexOf('psram') >= 0 &&
          mf.topbar === false);
    check('app.json adota core + fx (fisica de arcade e na mao)',
          mf.deps && /^(\^)?\d+\.\d+\.\d+$/.test(mf.deps['celeros.game']) &&
          /^(\^)?\d+\.\d+\.\d+$/.test(mf.deps['celeros.game.fx']) &&
          !mf.deps['celeros.physics'],
          JSON.stringify(mf.deps));

    var result = runLint([appDir], {});
    check('jogo scaffoldado passa limpo no lint',
          result.totals.errors === 0,
          result.apps[0].diagnostics.map(function (d) { return d.message; }).join('; '));

    // soma dos .js como o hub mede: pacote E deps ENXUTOS (publish e
    // publish-dep sobem pelo jsstrip, como o aparelho compila). Teto = o do
    // SERVIDOR (hub 0.9.0: 1 MB com psram; o celerhub.py espelha — ver
    // MAX_MAIN_JS_PSRAM)
    var TETO = 1024 * 1024;
    var size = JSSTRIP.strip(fs.readFileSync(path.join(appDir, 'main.js'))).length +
               depsSize(Object.keys(mf.deps));
    check('soma dos .js (pacote + deps, transitivas incluidas) cabe no teto psram (1 MB)', size < TETO,
          (size / 1024).toFixed(1) + ' KB');
    // os dois jogos grandes da loja tambem (pacote + deps do app.json)
    ['Supernova', 'Detona'].forEach(function (nome) {
        var dir = path.join(ROOT, 'hub_apps', nome);
        var total = 0;
        fs.readdirSync(dir).forEach(function (f) {
            if (/\.js$/.test(f) && f !== 'test.js') total += JSSTRIP.strip(fs.readFileSync(path.join(dir, f))).length;
        });
        var deps = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8')).deps || {};
        total += depsSize(Object.keys(deps));
        check(nome + ': pacote + deps enxutos cabem no teto do hub (1 MB)', total < TETO,
              (total / 1024).toFixed(1) + ' KB');
    });

    var r = runAppFolder(appDir, { render: true, stopAtMs: 2000 });
    check('jogo roda limpo no emu (cena titulo)', r.err === null, r.err);
    var nonzero = 0;
    for (var i = 0; i < r.renderer.fb.length; i += 997) {
        if (r.renderer.fb[i] !== 0) nonzero++;
    }
    check('framebuffer do titulo nao esta zerado', nonzero > 0);

    // tap no JOGAR entra na cena de jogo (bola + raquete + HUD)
    var r2 = runAppFolder(appDir, {
        render: true, stopAtMs: 8000,
        events: function (env) { env.__harness.tap(120, 178); },
    });
    check('tap no JOGAR entra na cena de jogo sem erro', r2.err === null, r2.err);

    // gameplay de verdade: a raquete persegue a bola (fisica na mao do
    // template) e as rebatidas pontuam — prova que pools + reflexao no
    // lugar da dep celeros.physics sustentam o jogo-exemplo
    var viu = 0;
    var r3 = runAppFolder(appDir, {
        render: true, stopAtMs: 15000,
        events: function (env) {
            env.__harness.tap(120, 178);
            var origDelay = env.System.delay;
            var fim = env.System.millis() + 13000;
            env.System.delay = function (ms) {
                var q = env.__harness.quica && env.__harness.quica.g;
                if (q && q.balls.length && env.System.millis() < fim) {
                    var b = q.balls[q.balls.length - 1];
                    env.__harness.pushTouch([{ x: b.x, y: 200, touched: 1 }]);
                    if (q.score > viu) viu = q.score;
                }
                return origDelay(ms);
            };
        },
    });
    check('quica joga: raquete segue a bola e pontua (sem dep de fisica)',
          r3.err === null && viu > 0,
          r3.err || ('score maximo visto: ' + viu));
    fs.rmSync(tmp, { recursive: true, force: true });
})();

// resumo
console.log('');
if (failures) {
    console.log('FALHAS: ' + failures);
    process.exit(1);
}
console.log('OK: todos os testes do SDK passaram');
