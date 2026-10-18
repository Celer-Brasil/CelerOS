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

    // drawPNG/decodePng: fixture 3x2 RGBA (vermelho/verde/azul na 1a linha;
    // alfa 0, cinza a=128 e branco na 2a) + o fundo.png REAL do Arrasa (paleta)
    var pngPath = path.join(os.tmpdir(), 'sdk_png_fixture.png');
    fs.writeFileSync(pngPath, Buffer.from(
        'iVBORw0KGgoAAAABJRU5ErkJggg=='.slice(0, 0) +
        'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAGUlEQVR4nGP4z8DwHwwZ/gMxEDQAwX8gAACIngv3FJk/BgAAAABJRU5ErkJggg==', 'base64'));
    var rP = new Renderer();
    var envP = { System: {} };
    rP.wire(envP);
    rP.fb.fill(0x0000);
    var okPng = envP.System.drawPNG(pngPath, 0, 0);
    check('drawPNG renderiza arquivo host (retorna true e pinta RGB565)',
          okPng === true && rP.fb[0] === 0xF800 && rP.fb[1] === 0x07E0 && rP.fb[2] === 0x001F,
          'ok=' + okPng + ' fb0=0x' + rP.fb[0].toString(16));
    check('drawPNG alfa 0 preserva o fundo', rP.fb[W + 0] === 0x0000,
          'fb=0x' + rP.fb[W].toString(16));
    check('drawPNG alfa 128 compoe (cinza sobre preto -> 0x4208)', rP.fb[W + 1] === 0x4208,
          'fb=0x' + rP.fb[W + 1].toString(16));
    check('drawPNG arquivo inexistente devolve false', envP.System.drawPNG('/x/y/z.png', 0, 0) === false);
    var { decodePng } = require('../../tools/sdk/lib/png.js');
    var fundo = decodePng(fs.readFileSync(path.join(ROOT, 'hub_apps/Arrasa/fundo.png')));
    check('decodePng le PNG de PALETA real (fundo 480x480, ceu no px0)',
          fundo.w === 480 && fundo.h === 480 && fundo.rgba[0] === 61 && fundo.rgba[1] === 169,
          fundo.w + 'x' + fundo.h + ' px0=' + fundo.rgba[0] + ',' + fundo.rgba[1]);

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

    // round 4: os jogos da rodada no emulador com render. O placar do
    // Breakout sobrevive ao 1o repaint integral da camada suja (o
    // cabecalho era apagado pelo painter full do 1o quadro antes do clip
    // do HUD); o 2D Runner (Neon Surfer) roda o menu static com sprites
    // PNG renderizados (decodePng) sem primitiva nao renderizada
    var rb = runAppFolder(path.join(ROOT, 'hub_apps', 'Breakout'), {
        render: true, stopAtMs: 2500,
        // o jogo abre no titulo: toca JOGAR para o HUD existir no 1o repaint
        events: function (env) { env.__harness.tap(120, 160); }
    });
    check('Breakout roda limpo no emu', rb.err === null, rb.err);
    var linhasHud = 0;
    for (var ly = 4; ly <= 32; ly += 4) {
        var cores = {};
        for (var lx = 0; lx < 240; lx++) cores[rb.renderer.fb[ly * 240 + lx]] = 1;
        if (Object.keys(cores).length > 1) linhasHud++;
    }
    check('Breakout: o placar sobrevive ao 1o repaint integral (clip do HUD + touches)',
          linhasHud >= 4, 'linhas com glifo=' + linhasHud);
    var rn = runAppFolder(path.join(ROOT, 'hub_apps', '2D Runner'),
                          { render: true, stopAtMs: 2500 });
    check('2D Runner (Neon Surfer) roda limpo no emu com sprites PNG',
          rn.err === null && rn.renderer.unsupported.size === 0,
          rn.err || Array.from(rn.renderer.unsupported).join(','));

    var { execSync } = require('child_process');
    execSync('node tools/sdk/celer.js test hub_apps/Cronometro --ms 600',
             { cwd: ROOT, stdio: 'pipe' });
    check('celer.js test aceita --ms (para no marco)', true);
})();

// ------------------------------------------- emulador: ferramentas novas --
(function () {
    console.log('SDK emulador (BMP, input, gif, seed, erro, live):');
    var cp = require('child_process');
    var { Renderer } = require('../../tools/sdk/lib/renderer.js');
    var { decodeBmp } = require('../../tools/sdk/lib/bmp.js');
    var { parseInputScript, wireInput } = require('../../tools/sdk/lib/input.js');
    var { encodeGif } = require('../../tools/sdk/lib/gif.js');
    var { runAppFolder } = require('../../tools/sdk/lib/runner.js');
    var harness = require('../../test/js_harness/run.js');
    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'celer-emu-'));

    function writeApp(dir, main, name) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({
            name: name || path.basename(dir), packageName: 'br.celer.teste', version: '0.1.0',
            api: 42, type: 'App', category: 'Teste', permissions: [],
        }));
        fs.writeFileSync(path.join(dir, 'main.js'), main);
        return dir;
    }

    // BMP 24 bits bottom-up (o que o firmware e os geradores emitem)
    function bmp24(w, h, rows) {   // rows[0] = topo da imagem
        var stride = Math.ceil(w * 3 / 4) * 4;
        var data = Buffer.alloc(stride * h);
        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                var c = rows[y][x];
                var o = (h - 1 - y) * stride + x * 3;   // bottom-up
                data[o] = c[2]; data[o + 1] = c[1]; data[o + 2] = c[0];
            }
        }
        var head = Buffer.alloc(54);
        head.write('BM', 0);
        head.writeUInt32LE(54 + data.length, 2);
        head.writeUInt32LE(54, 10);
        head.writeUInt32LE(40, 14);
        head.writeInt32LE(w, 18); head.writeInt32LE(h, 22);
        head.writeUInt16LE(1, 26); head.writeUInt16LE(24, 28);
        head.writeUInt32LE(data.length, 34);
        return Buffer.concat([head, data]);
    }
    var bmp = bmp24(2, 2, [[[255, 0, 0], [0, 255, 0]], [[0, 0, 255], [255, 255, 255]]]);
    var bi = decodeBmp(bmp);
    check('decodeBmp 24 bits: dimensoes e linhas bottom-up',
          bi.w === 2 && bi.h === 2 && bi.rgba[0] === 255 && bi.rgba[1] === 0 &&
          bi.rgba[(1 * 2 + 0) * 4] === 0 && bi.rgba[(1 * 2 + 0) * 4 + 2] === 255);
    var bmpPath = path.join(tmp, 'arte.bmp');
    fs.writeFileSync(bmpPath, bmp);
    var envB = harness.makeEnv();
    var rB = new Renderer();
    rB.wire(envB);
    envB.System.fillScreen(0);
    check('drawBMP desenha no framebuffer do preview', envB.System.drawBMP(bmpPath, 3, 4) === true);
    check('drawBMP: pixel vermelho em (3,4)', rB.fb[4 * 240 + 3] === 0xF800);
    check('drawBMP: pixel azul em (3,5)', rB.fb[5 * 240 + 3] === 0x001F);

    // script de entrada: tap = down+up, swipe interpola passos e solta
    var sc = parseInputScript('# exemplo\n0 tap 10,20\n100 swipe 0,0 30,40 3 90\n');
    check('input: tap vira down+up', sc[0].t === 0 && sc[0].frame.touched === 1 &&
          sc[1].frame.touched === 0 && sc[1].frame.y === 20);
    var sw = sc.filter(function (e) { return e.t >= 100; });
    check('input: swipe interpola 3 passos + release', sw.length === 5 &&
          sw[3].frame.x === 30 && sw[3].frame.y === 40 && sw[4].frame.touched === 0 &&
          sw[4].t > 190);
    var threwIn = false;
    try { parseInputScript('0 foo 1,2'); } catch (e) { threwIn = /acao desconhecida/.test(e.message); }
    check('input: acao invalida aponta o erro', threwIn);

    // multi-dedo (API 43): dedo explicito no fim vira o script multi e o
    // quadro sai como o estado COMPLETO do vidro; sem dedo, legado de 1 ponto
    var mt = parseInputScript('0 down 60,100 0\n0 down 180,100 1\n200 move 40,100 0\n300 up 0\n300 up 1\n');
    var mt2 = mt.filter(function (e) { return e.frame.touches.length === 2; })[0];
    check('input multi: dois dedos no mesmo quadro (snapshot por id)',
          mt2 && mt2.frame.touches[0].id === 0 && mt2.frame.touches[0].x === 60 &&
          mt2.frame.touches[1].id === 1 && mt2.frame.touches[1].x === 180);
    var mMove = mt.filter(function (e) { return e.t === 200; })[0];
    check('input multi: move mexe so no dedo dele',
          mMove && mMove.frame.touches.length === 2 &&
          mMove.frame.touches[0].x === 40 && mMove.frame.touches[1].x === 180);
    var mUp = mt[mt.length - 1];
    check('input multi: ups no mesmo t esvaziam o vidro',
          mUp.t === 300 && mUp.frame.touches.length === 0);
    var swMs1 = parseInputScript('0 swipe 0,0 10,0 2 1\n');
    check('input legado: swipe com MS de 1 digito nao vira dedo',
          swMs1[0].frame.touched === 1 && swMs1[0].frame.touches === undefined);
    var mTap = parseInputScript('0 tap 120,160 1\n')[0];
    check('input multi: tap com dedo sai como snapshot',
          mTap.frame.touches.length === 1 && mTap.frame.touches[0].id === 1);

    // GIF: assinatura, dimensoes e quadro repetido fundido
    var red = Buffer.alloc(4 * 3, 0); red.fill(255, 0, 3);
    var blue = Buffer.alloc(4 * 3, 0); blue.fill(255, 2, 3);
    var gif = encodeGif(2, 2, [{ rgb: red, delayMs: 100 }, { rgb: red, delayMs: 100 },
                               { rgb: blue, delayMs: 100 }]);
    check('gif: assinatura e dimensoes', gif.toString('ascii', 0, 6) === 'GIF89a' &&
          gif.readUInt16LE(6) === 2 && gif.readUInt16LE(8) === 2);
    // anda os blocos do GIF para contar imagens sem procurar bytes no LZW
    function gifFrames(buf) {
        var p = 13 + 256 * 3, n = 0;
        while (p < buf.length) {
            var b = buf[p];
            if (b === 0x3B) break;
            if (b === 0x21) {
                p += 2;
                while (p < buf.length && buf[p]) p += buf[p] + 1;
                p++;
            } else if (b === 0x2C) {
                n++;
                p += 10;
                p++;   // min code size
                while (p < buf.length && buf[p]) p += buf[p] + 1;
                p++;
            } else break;
        }
        return n;
    }
    check('gif: quadros iguais fundidos (2 imagens)', gifFrames(gif) === 2, 'frames=' + gifFrames(gif));

    // seed: mesma semente = mesma sequencia; semente nova muda
    var seedApp = writeApp(path.join(tmp, 'Semente'),
        'System.print("r=" + Math.random());');
    var R0 = Math.random;
    var sa = runAppFolder(seedApp, { seed: 42 });
    var sb = runAppFolder(seedApp, { seed: 42 });
    var sc2 = runAppFolder(seedApp, { seed: 7 });
    Math.random = R0;
    check('seed: mesma semente reproduz a partida', sa.log.join('|') === sb.log.join('|') &&
          /r=0\.\d+/.test(sa.log.join('')));
    check('seed: semente diferente muda a sequencia', sa.log.join('|') !== sc2.log.join('|'));

    // --input no wire: o app fica vermelho quando o dedo desce
    var touchApp = writeApp(path.join(tmp, 'Toque'),
        'while (true) { var t = System.getTouch();' +
        ' System.fillScreen(t.touched ? 0xF800 : 0x001F); System.delay(33); }');
    var rt = runAppFolder(touchApp, {
        render: true, frames: [0, 60, 120, 240],
        events: function (env) { wireInput(env, parseInputScript('30 tap 120,160')); },
    });
    var viuVermelho = rt.frames.some(function (f) { return f.fb[(160 * 240) + 120] === 0xF800; });
    var voltouAzul = rt.frames[rt.frames.length - 1].fb[(160 * 240) + 120] === 0x001F;
    check('input no emulador: tap pinta e solta', rt.err === null && viuVermelho && voltouAzul);

    // --input multi no wire: DOIS dedos pintam onde pousam (app le getTouches)
    var mtApp = writeApp(path.join(tmp, 'Multitoque'),
        'while (true) { var ts = System.getTouches();' +
        ' for (var i = 0; i < ts.length; i++) System.fillRect(ts[i].x, ts[i].y, 8, 8, 0xF800);' +
        ' System.delay(33); }');
    var rm = runAppFolder(mtApp, {
        render: true, frames: [0, 250],
        events: function (env) { wireInput(env, parseInputScript(
            '30 down 60,100 0\n30 down 180,260 1\n400 up 0\n400 up 1\n')); },
    });
    var dedo0 = rm.frames.some(function (f) { return f.fb[(100 * 240) + 60] === 0xF800; });
    var dedo1 = rm.frames.some(function (f) { return f.fb[(260 * 240) + 180] === 0xF800; });
    check('input multi no emulador: dois dedos pintam onde pousam',
          rm.err === null && dedo0 && dedo1);

    // erro: --out salva a tela do erro e o processo sai 1
    var errApp = writeApp(path.join(tmp, 'Quebra'),
        'System.fillScreen(0xF800); throw new Error("boom de proposito");');
    var errCode = 0;
    try {
        cp.execSync('node tools/sdk/celer.js emu ' + JSON.stringify(errApp) + ' --ms 100',
                    { cwd: ROOT, stdio: 'pipe' });
    } catch (e) { errCode = e.status; }
    check('emu: erro do app sai com codigo 1', errCode === 1);
    check('emu: erro salva a tela em .dev/erro.png',
          fs.existsSync(path.join(errApp, '.dev', 'erro.png')));

    // --gif pela CLI (Snake: o countdown muda a tela)
    var gifOut = path.join(tmp, 'snake.gif');
    cp.execSync('node tools/sdk/celer.js emu data/apps/Snake --ms 600 --fps 10 --gif ' +
                JSON.stringify(gifOut), { cwd: ROOT, stdio: 'pipe' });
    var gifCli = fs.readFileSync(gifOut);
    check('emu --gif grava GIF animado com mais de um quadro',
          gifCli.toString('ascii', 0, 6) === 'GIF89a' && gifFrames(gifCli) > 1,
          'frames=' + gifFrames(gifCli));

    // live: servidor sobe, serve a pagina, /frame.png e o toque muda a tela
    var liveApp = writeApp(path.join(tmp, 'Live'),
        'while (true) { var ts = System.getTouches(); System.fillScreen(0x001F);' +
        ' for (var i = 0; i < ts.length; i++) System.fillRect(ts[i].x, ts[i].y, 6, 6, 0xF800);' +
        ' System.delay(33); }', 'LiveTeste');
    var client = path.join(tmp, 'cliente.js');
    fs.writeFileSync(client, [
        "const http = require('http');",
        "const { spawn } = require('child_process');",
        "const ROOT = " + JSON.stringify(ROOT) + ";",
        "const APP = " + JSON.stringify(liveApp) + ";",
        "const srv = spawn(process.execPath, ['tools/sdk/celer.js','emu',APP,'--serve','--port','0'],",
        "                  { cwd: ROOT, stdio: ['ignore','pipe','pipe'] });",
        "let out = '', started = false, port = 0;",
        "const sleep = (ms) => new Promise(r => setTimeout(r, ms));",
        "function req(method, path, body) {",
        "  return new Promise((resolve, reject) => {",
        "    const data = body ? Buffer.from(JSON.stringify(body)) : null;",
        "    const r = http.request({ host:'127.0.0.1', port, path, method,",
        "        headers: data ? {'Content-Type':'application/json','Content-Length':data.length} : {} },",
        "      (res) => { const c = []; res.on('data', d => c.push(d));",
        "                  res.on('end', () => resolve({ status:res.statusCode, body:Buffer.concat(c) })); });",
        "    r.on('error', reject); if (data) r.write(data); r.end();",
        "  });",
        "}",
        "const jget = (p) => req('GET', p).then(r => JSON.parse(r.body.toString()));",
        "function centro(buf) {",
        "  const p = require(ROOT + '/tools/sdk/lib/png.js').decodePng(buf);",
        "  const k = ((p.h >> 1) * p.w + (p.w >> 1)) * 4;",
        "  return { w: p.w, h: p.h, px: [p.rgba[k], p.rgba[k+1], p.rgba[k+2]] };",
        "}",
        "async function run() {",
        "  const res = { ok: false };",
        "  try {",
        "    const home = await req('GET', '/');",
        "    res.html = home.body.toString().indexOf('id=\"screen\"') >= 0 &&",
        "               home.body.toString().indexOf('LiveTeste') >= 0;",
        "    const st = await jget('/state');",
        "    res.state = st.app === 'LiveTeste' && st.running === true && st.clients === 0;",
        "    let png = null;",
        "    for (let i = 0; i < 40 && !png; i++) {",
        "      const f = await req('GET', '/frame.png');",
        "      if (f.status === 200 && f.body[0] === 0x89) png = f.body; else await sleep(100);",
        "    }",
        "    res.frame = !!png;",
        "    if (png) { const c = centro(png); res.size = c.w + 'x' + c.h; res.azul = c.px[2] === 255; }",
        "    await req('POST', '/input', { down:1, x:120, y:160 });",
        "    let red = null;",
        "    for (let i = 0; i < 30 && !red; i++) {",
        "      await sleep(120);",
        "      const f = await req('GET', '/frame.png');",
        "      if (f.status === 200 && centro(f.body).px[0] === 255) red = true;",
        "    }",
        "    res.vermelho = !!red;",
        "    await req('POST', '/input', { down:0, x:120, y:160 });",
        "    let blue = null;",
        "    for (let i = 0; i < 30 && !blue; i++) {",
        "      await sleep(150);",
        "      const f = await req('GET', '/frame.png');",
        "      if (f.status === 200 && centro(f.body).px[2] === 255) blue = true;",
        "    }",
        "    res.soltou = !!blue;",
        "    res.pause = (await req('POST', '/control', { paused:true })).status === 200;",
        "    const a = await jget('/state'); await sleep(300); const b = await jget('/state');",
        "    res.pausaParou = a.ms === b.ms;",
        "    await req('POST', '/control', { record:true });",
        "    await req('POST', '/input', { down:1, x:40, y:50 });",
        "    await req('POST', '/input', { down:0, x:40, y:50 });",
        "    await req('POST', '/control', { record:false });",
        "    const recTxt = (await req('GET', '/record')).body.toString();",
        "    res.gravou = /down\\s+40,50/.test(recTxt) && /up\\s+40,50/.test(recTxt);",
        "    // multitoque no ring: dedo 0 e dedo 1 ao mesmo tempo (f no /input)",
        "    await req('POST', '/control', { paused:false });   // o teste de pausa deixou o app parado",
        "    await req('POST', '/input', { down:1, x:40, y:120, f:0 });",
        "    await req('POST', '/input', { down:1, x:200, y:120, f:1 });",
        "    let dois = false;",
        "    for (let i = 0; i < 30 && !dois; i++) {",
        "      await sleep(120);",
        "      const f = await req('GET', '/frame.png');",
        "      if (f.status !== 200) continue;",
        "      const p = require(ROOT + '/tools/sdk/lib/png.js').decodePng(f.body);",
        "      const a = ((120 * p.w) + 40) * 4, b = ((120 * p.w) + 200) * 4;",
        "      if (p.rgba[a] === 255 && p.rgba[b] === 255) dois = true;",
        "    }",
        "    res.doisDedos = !!dois;",
        "    await req('POST', '/input', { down:0, x:40, y:120, f:0 });",
        "    await req('POST', '/input', { down:0, x:200, y:120, f:1 });",
        "    res.ok = res.html && res.state && res.frame && res.azul && res.vermelho &&",
        "             res.soltou && res.pause && res.pausaParou && res.gravou && res.doisDedos;",
        "  } catch (e) { res.err = String(e && e.stack || e); }",
        "  console.log(JSON.stringify(res));",
        "  srv.kill('SIGTERM');",
        "  setTimeout(() => process.exit(0), 100);",
        "}",
        "srv.stdout.on('data', (d) => {",
        "  out += d.toString();",
        "  const m = out.match(/http:\\/\\/127\\.0\\.0\\.1:(\\d+)/);",
        "  if (m && !started) { started = true; port = Number(m[1]); run(); }",
        "});",
        "srv.stderr.on('data', (d) => { /* o app loga no painel, nao aqui */ });",
        "setTimeout(() => { if (!started) { console.log(JSON.stringify({ ok:false, err:'timeout' })); process.exit(1); } }, 15000);",
    ].join('\n'));
    var live = { ok: false, err: 'sem saida' };
    try {
        var raw = cp.execSync(process.execPath + ' ' + JSON.stringify(client),
                              { cwd: ROOT, timeout: 40000, stdio: 'pipe' }).toString();
        live = JSON.parse(raw.trim().split('\n').pop());
    } catch (e) { live = { ok: false, err: String(e.message).slice(0, 300) }; }
    check('emu --serve: pagina + /state + /frame.png + toque + pausa + gravacao',
          live.ok === true, JSON.stringify(live));

    fs.rmSync(tmp, { recursive: true, force: true });
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

// ------------------------------------------------------ Arrasa: mundo ----
// A fisica de jogo do Arrasa direto (mundo.js/niveis.js sobre o P.rigid do
// espelho JS): contratos que o app consome por indice — metas de estrela
// alcancaveis, ciclo de mundo entre recargas, indices estaveis depois de
// remocoes (TNT em cadeia) e a massa do app batendo com a do solver
// (impulso J = dv * m tem que mudar a velocidade em dv).
(function () {
    console.log('SDK Arrasa (hub_apps/Arrasa/mundo.js):');
    var harness = require('../../test/js_harness/run.js');
    var DIR = path.join(ROOT, 'hub_apps', 'Arrasa');
    var env = harness.makeEnv();
    var req = harness.makeRequire(DIR, env);
    var out = {};
    new Function('System', 'Storage', 'require', '__out',
        'var M = require("mundo"), NIV = require("niveis");' +
        '__out.M = M; __out.NIV = NIV;')(env.System, env.Storage, req, out);
    var M = out.M, NIV = out.NIV;

    // pontos teoricos da fase (g = goblins, bl = quebraveis) pelo MAT do app
    function pontuacao(n) {
        var pecas = NIV.montar(n), g = 0, bl = 0;
        for (var p = 0; p < pecas.length; p++) {
            var c = pecas[p];
            var m = M.MAT[c.k === 'goblin' ? c.tipo : c.mat];
            if (c.k === 'goblin') g += m.pts;
            else if (!m.estatico) bl += m.pts;
        }
        return { g: g, bl: bl, tiros: NIV.fase(n).tiros.length };
    }

    // 1) metas de estrela: ordenadas e ALCANCAVEIS em todas as fases. O maximo
    // teorico e g + bl + 1000*(tiros-1); a formula antiga pedia +2000 de
    // bonus e a fase 1 (2 tiros, max 2300) tinha meta-3 de 3200 — impossivel
    var pior = null;
    for (var n = 0; n < NIV.total; n++) {
        var pt = pontuacao(n), metas = M.metas(n);
        var max = pt.g + pt.bl + 1000 * (pt.tiros - 1);
        if (!(metas[0] === pt.g && metas[0] < metas[1] && metas[1] < metas[2] &&
              metas[1] <= pt.g + pt.bl && metas[2] <= max)) {
            pior = 'fase ' + (n + 1) + ': metas ' + JSON.stringify(metas) +
                   ' vs g=' + pt.g + ' bl=' + pt.bl + ' max=' + max;
        }
    }
    check('metas de estrela ordenadas e alcancaveis nas 10 fases (3* <= maximo)', pior === null, pior);
    var pt1 = pontuacao(0), m1 = M.metas(0);
    check('fase 1: 3 estrelas cabem no maximo (2300) — regressao da meta impossivel',
          m1[2] <= pt1.g + pt1.bl + 1000 * (pt1.tiros - 1),
          'meta3=' + m1[2] + ' max=' + (pt1.g + pt1.bl + 1000 * (pt1.tiros - 1)));

    // 2) ciclo de mundo: recarregar a fase N vezes nao vaza corpo (o count
    // volta exato) nem mundo (id valido, M.sem false)
    M.carregar(9);
    var base = M.w.count(), ok = true;
    for (var vez = 0; vez < 5; vez++) {
        if (!M.carregar(9) || M.w.id <= 0 || M.w.count() !== base) ok = false;
    }
    check('recarregar a fase 5x: mesmo numero de corpos, mundo novo a cada vez', ok,
          'count=' + M.w.count() + ' esperado=' + base);
    check('estado do quadro: 6 numeros por corpo, todo corpo vivo', 
          M.s.length === M.w.count() * M.NS && (M.s[5] & 1) === 1);

    // 3) indices estaveis depois de remocoes: TNT em cadeia tira pecas e a
    // tripla cria corpos que reaproveitam slot — todo slot VIVO tem
    // descritor com .i === i (slot morto no meio da marca d'agua pode
    // existir: o remove so encolhe a marca pelo fim)
    function invariante() {
        var cnt = M.w.count(), st = M.w.state();
        for (var i = 0; i < cnt; i++) {
            var vivo = (st[i * M.NS + 5] & 1) !== 0;
            var c = M.corpos[i];
            if (vivo !== !!c) return 'slot ' + i + (vivo ? ' vivo sem descritor' : ' morto com descritor');
            if (c && c.i !== i) return 'slot ' + i + ' com descritor de outro indice';
        }
        for (var j = 0; j < M.corpos.length; j++) {
            if (M.corpos[j] && j >= cnt) return 'descritor ' + j + ' alem da marca d\'agua';
        }
        return null;
    }
    M.carregar(9);
    for (var s4 = 0; s4 < 40; s4++) M.step(1 / 30);
    var g0 = M.goblins, tnt = -1;
    for (var i4 = 0; i4 < M.corpos.length; i4++)
        if (M.corpos[i4] && M.corpos[i4].mat === 'tnt') tnt = i4;
    M.corpos[tnt].morto = true;
    for (s4 = 0; s4 < 90; s4++) M.step(1 / 30);
    var inv = invariante();
    check('TNT em cadeia: remocoes mantem M.corpos coerente com os slots', inv === null, inv);
    check('a explosao derrubou goblins (mundo vivo)', M.goblins < g0, 'goblins ' + g0 + ' -> ' + M.goblins);

    // tripla: racha cria corpos REAPROVEITANDO slots livres do castelo quebrado
    M.carregar(2);
    for (s4 = 0; s4 < 40; s4++) M.step(1 / 30);
    M.tiro.tipo = 'tripla'; M.tiro.estado = 'mirando';
    M.pull.x = -36; M.pull.y = 14;
    M.soltar();
    for (s4 = 0; s4 < 8; s4++) M.step(1 / 30);
    var evt = [];
    var partiu = M.habilidade(evt);
    inv = invariante();
    check('tripla racha em 3 e os novos corpos entram em slots coerentes',
          partiu && M.tiro.extras.length === 2 && inv === null,
          'extras=' + (M.tiro && M.tiro.extras.length) + ' ' + inv);

    // 4) massa do app = massa do solver: impulso J = dv*m muda v em ~dv
    // (M.explodir e o dano por hit dependem disso — dv = J/m)
    M.carregar(0);
    for (s4 = 0; s4 < 40; s4++) M.step(1 / 30);
    var alvo = -1;
    for (var i5 = 0; i5 < M.corpos.length; i5++)
        if (M.corpos[i5] && M.corpos[i5].k === 'box') alvo = i5;
    var c5 = M.corpos[alvo];
    M.w.set(alvo, 100, 100, 0, 0, 0, 0);
    var dv = 240;
    M.w.impulse(alvo, dv * c5.m, 0);
    M.w.step(0.001, { gravity: { x: 0, y: 0 } });
    var s5 = M.w.state();
    var medido = (s5[alvo * M.NS] - 100) / 0.001;
    check('massa() do app bate com a do solver (impulso dv*m move dv)',
          Math.abs(medido - dv) < dv * 0.05, 'dv pedido=' + dv + ' medido=' + medido.toFixed(1));

    // 5) o castelo assenta e DORME (a carencia segura o dano de montagem)
    M.carregar(3);
    for (s4 = 0; s4 < 60; s4++) M.step(1 / 30);
    var acordados = 0;
    for (var i6 = 0; i6 < M.corpos.length; i6++)
        if (M.corpos[i6] && !M.corpos[i6].fixo && (M.s[i6 * M.NS + 5] & 2)) acordados++;
    check('torre de pedra dorme parada depois de assentar (sem colapso espontaneo)',
          acordados === 0 && M.goblins === 3 && M.pontos === 0,
          'acordados=' + acordados + ' goblins=' + M.goblins);
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
              E2.version === '1.6.0' && E2._mods.length === 3,
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
            'E.after(100, function () { rodou++; });' +          // indice 0: roda PRIMEIRO (ordem de criacao, core 1.3)
            'E.after(100, function () { E.clearTimers(); });' +  // indice 1: limpa a lista depois
            'E.run({ s: { update: function () { if (System.millis() > t0 + 250) E.quit(); } } }, "s");' +
            '__harness.grab("rodou", rodou);');
    } catch (e) { erroTimer = String(e); }
    check('timer cujo callback limpa a lista no meio do tick nao derruba o run',
          erroTimer === null && r.grabbed.rodou === 1,
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

    // fim do veu de transicao força UM repaint integral: os rects do veu
    // (_drawTrans) pintam FORA da camada suja e os restos do ultimo quadro
    // (cantos do iris, colunas do bands, borda do wipe) ficariam na tela
    // ate algo se mover em cima — os "blocos pretos" do Detona/Arrasa
    r = runEngine(
        'var E = require("celeros.game"); E.init({});' +
        'var cheio = -1;' +
        'E.run({ a: { update: function () { E.goto("b", { transition: "bands", ms: 120 }); } },' +
        '        b: { enter: function () { E.dirty.enable(0); },' +
        '             draw: function () { if (!E._trans) { cheio = E.dirty._wasFull ? 1 : 0; E.quit(); } } } }, "a");' +
        '__harness.grab("cheio", cheio);');
    check('fim do veu de transicao repinta tudo (restos do veu saem da tela)',
          r.grabbed.cheio === 1, 'cheio=' + r.grabbed.cheio);

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
          out.core[3] === undefined && out.core[4] === '1.4.1' && out.core[5] === '',
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
          out.fx[2] === '1.4.1',
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
    check('shim celeros.engine: MESMO objeto do core + fx/spr/tilemap, version 1.4.0',
          Array.isArray(out.shim) && out.shim[0] === true && out.shim[1] === '1.6.0' &&
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

// --------------------------------------------- round 4: veu x estados etc --
// Interacoes que o soak round 4 achou (core 1.0.2 / fx 1.0.2 / spr 1.0.1 /
// ui 1.0.1): goto seco no meio do fadeout descarta o veu (antes ficava
// pendurado pintando a tela inteira para sempre), fim do veu com recorte
// repinta a faixa de FORA do clip (o veu cobre a tela toda; o _full cobre
// so o clip), E.redraw de TIMER acorda cena static, seq.cancel no meio do
// par, dois tweens na mesma prop (o antigo vence), trail com alvo morto
// (getXY null nao explode), blit sem slot E sem painter e no-op seco,
// estrelas com fundo PAINTER curam o pixel antigo na camada e o dialog
// cresce com o texto
(function () {
    console.log('SDK CelerGame round 4 (veu x estados, fx/spr/ui):');
    var harness = require('../../test/js_harness/run.js');

    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'celer-r4-'));
    fs.writeFileSync(path.join(tmp, 'app.json'), JSON.stringify({
        deps: { 'celeros.game': '^1.0.0', 'celeros.game.fx': '^1.0.0',
                'celeros.game.spr': '^1.0.0', 'celeros.game.ui': '^1.0.0' }
    }));

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

    // 1) goto SEM opts no meio do fadeout: o veu nao pode ficar pendurado
    // (antes: fadeout concluido nunca saia de E._trans e o _drawTrans
    // pintava a tela inteira a cada quadro — tela preta para sempre)
    var r = runSnippet(
        'var E = require("celeros.game"); E.init({});' +
        'var cenas = "", veusTardios = 0, t0 = System.millis();' +
        'var fr = System.fillRect;' +
        'System.fillRect = function (x, y, w, h, c) {' +
        '  if (c === 0xF800 && System.millis() > t0 + 700) veusTardios++;' +
        '  fr(x, y, w, h, c); };' +
        'var pediu = false;' +
        'E.run({' +
        '  a: { update: function () {' +
        '        if (!pediu) { pediu = true; E.goto("b", { transition: "fade", ms: 300, color: 0xF800 }); return; }' +
        '        if (E._trans && E._trans.kind === "fadeout") E.goto("c"); },' +
        '       draw: function () {} },' +
        '  b: { enter: function () { cenas += "b"; }, draw: function () {} },' +
        '  c: { enter: function () { cenas += "c"; },' +
        '       update: function () { if (System.millis() > t0 + 1000) {' +
        '         __harness.grab("r", [cenas, E._trans === null, veusTardios]); E.quit(); } },' +
        '       draw: function () { E.gfx.circle(120, 160, 30, 0x07FF); } }' +
        '}, "a");');
    check('goto seco no meio do fadeout: pula pra cena nova, descarta o veu e nada pinta depois',
          r.r[0] === 'c' && r.r[1] === true && r.r[2] === 0,
          JSON.stringify(r.r));

    // 2) fim do veu com RECORTE ativo: o painter tambem cura a faixa de
    // fora do clip (o veu pintou a tela inteira depois do _end)
    r = runSnippet(
        'var E = require("celeros.game"); E.init({});' +
        'var faixa = 0, t0 = System.millis();' +
        'function painter(x, y, w, h) { if (y + h <= 30) faixa++; System.fillRect(x, y, w, h, 0x0000); }' +
        'E.run({' +
        '  a: { update: function () { E.goto("b", { transition: "wipe", ms: 120 }); }, draw: function () {} },' +
        '  b: { enter: function () { E.dirty.enable(painter); E.dirty.clip(0, 30, 240, 290); },' +
        '       update: function () { if (System.millis() > t0 + 600) { __harness.grab("heal", faixa); E.quit(); } },' +
        '       draw: function () {} }' +
        '}, "a");');
    check('fim do veu com clip: painter cura a faixa de fora do recorte (HUD)',
          r.heal >= 1, 'faixa=' + r.heal);

    // 3) cena static + E.redraw() vindo de um TIMER (nao de input): o draw
    // acontece no mesmo quadro do tick
    r = runSnippet(
        'var E = require("celeros.game"); E.init({});' +
        'var draws = 0;' +
        'E.after(300, function () { E.redraw(); });' +
        'E.run({ m: { static: true,' +
        '  update: function () { if (draws >= 2) { __harness.grab("d", draws); E.quit(); } },' +
        '  draw: function () { draws++; } } }, "m");');
    check('cena static: E.redraw() de um timer acorda o draw',
          r.d >= 2, 'draws=' + r.d);

    // 4) seq.cancel no meio de um passo paralelo: pend nao vaza, onDone
    // nao dispara, obj congela e a lista de tweens esvazia
    r = runSnippet(
        'var E = require("celeros.game"); E.init({});' +
        'var obj = { x: 0, y: 0 }, fim = false, t0 = System.millis();' +
        'var h = E.seq(obj, [' +
        '  { par: [{ to: { x: 40 }, ms: 500 }, { to: { y: 80 }, ms: 500 }] }' +
        '], { onDone: function () { fim = true; } });' +
        'E.run({ s: { update: function () {' +
        '  if (System.millis() > t0 + 200 && !h.dead) h.cancel();' +
        '  if (System.millis() > t0 + 900) { __harness.grab("par", [h.dead, fim, obj.x < 40, obj.y < 80, E._tweens.length]); E.quit(); }' +
        '} } }, "s");');
    check('seq.cancel no meio do par: cadeia morta, obj congelado, tweens esvaziam',
          r.par[0] === true && r.par[1] === false && r.par[2] === true &&
          r.par[3] === true && r.par[4] === 0,
          JSON.stringify(r.par));

    // 5) dois tweens na MESMA propriedade: o criado POR ULTIMO vence (core
    // 1.3: o tick anda na ordem de criacao — o mais novo escreve depois;
    // antes, de tras pra frente, o antigo vencia)
    r = runSnippet(
        'var E = require("celeros.game"); E.init({});' +
        'var obj = { x: 0 };' +
        'E.tween(obj, { x: 10 }, 100, { ease: E.m.linear });' +
        'E.tween(obj, { x: 50 }, 100, { ease: E.m.linear });' +
        'var t0 = System.millis();' +
        'E.run({ s: { update: function () { if (System.millis() > t0 + 300) { __harness.grab("tw", obj.x); E.quit(); } } } }, "s");');
    check('dois tweens na mesma prop: o criado por ultimo vence',
          r.tw === 50, 'x=' + r.tw);

    // 6) trail cujo alvo morreu (getXY devolve null): nao explode (antes
    // TypeError no p.x) e o rastro PARA de semear
    r = runSnippet(
        'var E = require("celeros.game.fx");' +
        'E.init({ particles: 64 });' +
        'var alvo = { x: 0, y: 50, morto: false }, erro = null;' +
        'try { E.fx.trail(function () { return alvo.morto ? null : alvo; },' +
        '                 { rate: 30, life: 0.3, size: 2 }); } catch (e) { erro = String(e); }' +
        'var t0 = System.millis();' +
        'E.run({ s: { update: function (dt) {' +
        '  alvo.x += 40 * dt;' +
        '  if (System.millis() > t0 + 300) alvo.morto = true;' +
        '  if (System.millis() > t0 + 800) { var n = 0;' +
        '    for (var i = 0; i < E.fx._parts.length; i++) if (!E.fx._parts[i].dead) n++;' +
        '    __harness.grab("tr", [erro === null, n]); E.quit(); }' +
        '} } }, "s");');
    check('trail com alvo morto (getXY null): sem excecao e para de semear',
          r.tr[0] === true && r.tr[1] === 0, JSON.stringify(r.tr));

    // 7) blit de sprite/regiao SEM slot e SEM painter: no-op seco (nada
    // desenha e nenhuma caixa entra na camada suja — a caixa "fantasma"
    // apagava o que estivesse embaixo no quadro seguinte). setup: o PNG
    // falha (decode sempre false) e a def nao traz paint
    r = runSnippet(
        'var E = require("celeros.game.spr");' +
        'E.init({ dir: "Teste" });' +
        'E.dirty.enable(0);' +
        'E.spr.load([{ name: "fantasma", file: "naoexiste", w: 8, h: 8 }]);' +
        '__harness.grab("sem", [E.spr.has("fantasma"), E.spr.backed("fantasma"), E.spr._used]);' +
        'E.spr.blit("fantasma", 5, 5);' +
        '__harness.grab("caixa", E.dirty._cur.length);' +
        'E.spr.sheet("t", { file: "naoexiste", w: 32, h: 32, tw: 16, regions: { a: [0, 0] } });' +
        'E.spr.blit("a", 5, 5);' +
        '__harness.grab("caixa2", E.dirty._cur.length);' +
        'E.spr.freeSheet("t");' +
        '__harness.grab("pos", [E.spr._used, E.spr.has("a")]);',
        function (env) { env.System.drawPNG = function () { return false; }; });
    check('blit sem slot e sem painter e no-op seco (nem caixa suja)',
          r.sem[0] === true && r.sem[1] === false && r.sem[2] === 0 &&
          r.caixa === 0 && r.caixa2 === 0,
          JSON.stringify([r.sem, r.caixa, r.caixa2]));
    check('freeSheet com sheet sem slot (id 0) nao desce o contador',
          r.pos[0] === 0 && r.pos[1] === false, JSON.stringify(r.pos));

    // 8) estrelas com fundo PAINTER: o pixel antigo da estrela que andou
    // entra na camada (o painter cura no quadro seguinte) — sem isso o
    // rastro ficava para sempre (o desenho cru nao registra caixa)
    r = runSnippet(
        'var E = require("celeros.game.fx");' +
        'E.init({});' +
        'var curas = 0;' +
        'function painter(x, y, w, h) { if (w === 3 && h === 3) curas++; }' +
        'var campo = E.fx.stars(20, { vy: 40 });' +
        'var t0 = System.millis();' +
        'E.run({ s: { enter: function () { E.dirty.enable(painter); },' +
        '  update: function () { campo.update(E.dt); if (System.millis() > t0 + 600) { __harness.grab("cur", curas); E.quit(); } },' +
        '  draw: function () { campo.draw(); } } }, "s");');
    check('estrelas com painter: pixel antigo marcado na camada (painter cura)',
          r.cur >= 5, 'curas=' + r.cur);

    // 9) dialog: quebra 1x e a altura acompanha o texto (a caixa cresce —
    // antes fixa em 58*E.U, texto longo transbordava)
    r = runSnippet(
        'var E = require("celeros.game.ui");' +
        'E.init({});' +
        'var curto = E.ui.dialog("oi", { speed: 30 });' +
        'var longo = E.ui.dialog("uma fala bem comprida que vai precisar de varias linhas dentro da caixa de dialogo", { speed: 30 });' +
        'curto.draw(20, 230, 200);' +
        'longo.draw(20, 60, 200);' +
        '__harness.grab("dlg", [curto._lines.length, longo._lines.length]);');
    check('dialog: quebra calculada 1x e cresce com o texto',
          r.dlg[0] === 1 && r.dlg[1] >= 3, JSON.stringify(r.dlg));

    // 10) lista: dedo que desceu FORA do rect e atravessou nao salta a
    // rolagem (o arrasto pertence a quem estava sob o press)
    r = runSnippet(
        'var E = require("celeros.game.ui");' +
        'E.init({});' +
        'var itens = []; for (var i = 0; i < 20; i++) itens.push("item " + i);' +
        'var lst = E.ui.list({ items: itens, row: 28 });' +
        'var quadros = 0;' +
        'E.run({ s: { update: function () { quadros++;' +
        '    if (quadros > 40) { __harness.grab("sc", lst.scroll); E.quit(); } },' +
        '  draw: function () { lst.draw(20, 80, 200, 140); } } }, "s");',
        function (env) {
            // press ABAIXO da lista (y 260) subindo ate 100 atravessando o
            // rect: a lista nao pode comecar a rolar no meio do caminho
            env.__harness.pushTouch([{ x: 120, y: 260, touched: 1 },
                                     { x: 120, y: 220, touched: 1 },
                                     { x: 120, y: 160, touched: 1 },
                                     { x: 120, y: 100, touched: 1 },
                                     { x: 120, y: 100, touched: 0 }]);
        });
    check('lista: press fora do rect nao salta a rolagem ao atravessar',
          r.sc === 0, 'scroll=' + r.sc);

    fs.rmSync(tmp, { recursive: true, force: true });
})();

// ------------------------------------------ fx: emissores + trail + parallax --
(function () {
    console.log('SDK CelerGame fx (emitter/trail/parallax):');
    var harness = require('../../test/js_harness/run.js');

    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'celer-fxe-'));
    fs.writeFileSync(path.join(tmp, 'app.json'),
                     JSON.stringify({ deps: { 'celeros.game.fx': '^1.0.0' } }));

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
    function vivas(E) {
        var n = 0;
        for (var i = 0; i < E.fx._parts.length; i++) if (!E.fx._parts[i].dead) n++;
        return n;
    }

    // emissor: taxa por segundo vira particulas; stop congela; duration para
    var r = runSnippet(
        'var E = require("celeros.game.fx");' +
        'E.init({ particles: 96 });' +
        'var em = E.fx.emitter({ x: 120, y: 100, rate: 50, life: 5, color: 0x07FF });' +
        'var v50 = 0, vDepois = 0, t0 = System.millis();' +
        'E.run({ s: { update: function () {' +
        '  if (System.millis() > t0 + 500 && !v50) { v50 = 1;' +
        '    var n = 0; for (var i = 0; i < E.fx._parts.length; i++) if (!E.fx._parts[i].dead) n++;' +
        '    __harness.grab("n500", n); em.stop(); }' +
        '  if (System.millis() > t0 + 900) E.quit();' +
        '} } }, "s");');
    check('emitter: rate 50/s semeia ~25 em 500 ms (tolerancia do clock)',
          r.n500 >= 15 && r.n500 <= 96, 'n=' + r.n500);
    r = runSnippet(
        'var E = require("celeros.game.fx");' +
        'E.init({ particles: 64 });' +
        'var em = E.fx.emitter({ x: 10, y: 10, rate: 80, life: 2, duration: 300 });' +
        'var t0 = System.millis();' +
        'E.run({ s: { update: function () { if (System.millis() > t0 + 800) E.quit(); } } }, "s");' +
        '__harness.grab("dur", [em.on, em.t >= 300]);');
    check('emitter: duration desliga sozinho',
          r.dur[0] === false && r.dur[1] === true, JSON.stringify(r.dur));

    // trail: segue a fonte movel; parado nao deixa rastro
    r = runSnippet(
        'var E = require("celeros.game.fx");' +
        'E.init({ particles: 96 });' +
        'var pos = { x: 0, y: 50 }, t = 0;' +
        'E.fx.trail(function () { return pos; }, { rate: 30, life: 0.4, color: 0xFFE0 });' +
        'var spawnMov = [], parado = [];' +
        'var sp = E.fx._spawn; E.fx._spawn = function () { spawnMov.push(1); return sp.apply(E.fx, arguments); };' +
        'E.run({ s: { update: function (dt) {' +
        '  t += dt;' +
        '  if (t < 0.5) pos.x += 60 * dt; else if (spawnMov.length && !parado.length) {' +
        '    parado.push(spawnMov.length);' +
        '    var antes = parado[0];' +
        '  }' +
        '  if (t > 1.4) {' +
        '    __harness.grab("trail", [parado[0] > 0, spawnMov.length - parado[0]]);' +
        '    E.quit();' +
        '  }' +
        '} } }, "s");');
    check('trail: semeia enquanto anda e PARA quando a fonte para',
          r.trail[0] === true && r.trail[1] < 3,
          JSON.stringify(r.trail));

    // parallax: celulas deslocam pela camera x speed (com wrap) e o recorte
    // do painter pinta so as celulas que tocam o rect
    r = runSnippet(
        'var E = require("celeros.game.fx");' +
        'E.init({});' +
        'var bg = E.fx.parallax([{ speed: 0.5, gap: 40, paint: function (x, y) { pts.push([x, y]); } }]);' +
        'var pts = [];' +
        'bg.draw();' +
        'var x0 = pts[0][0];' +
        'E.cam.x = 60;' +
        'pts.length = 0; bg.draw();' +
        '__harness.grab("shift", [pts[0][0] - x0]);' +
        'pts.length = 0; bg.draw(100, 0, 20, 320);' +
        'var fora = 0, dentro = 0;' +
        'for (var i = 0; i < pts.length; i++) {' +
        '  if (pts[i][0] >= 78 && pts[i][0] < 124) dentro++; else fora++;' +
        '}' +
        '__harness.grab("clip", [dentro > 0, fora]);');
    check('parallax: cam.x desloca a rede em -30 (mod gap=40)',
          ((r.shift[0] + 30) % 40 + 40) % 40 === 0, 'shift=' + r.shift[0]);
    check('parallax: draw(x, y, w, h) pinta so as celulas do rect (celula anterior entra)',
          r.clip[0] === true && r.clip[1] === 0,
          JSON.stringify(r.clip));

    fs.rmSync(tmp, { recursive: true, force: true });
})();

// ------------------------------------------------ spr: spritesheet/regioes --
(function () {
    console.log('SDK CelerGame spr (spritesheet):');
    var harness = require('../../test/js_harness/run.js');

    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'celer-sh-'));
    fs.writeFileSync(path.join(tmp, 'app.json'),
                     JSON.stringify({ deps: { 'celeros.game.spr': '^1.0.0' } }));

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

    // 1 PNG num slot so; regioes por celula e rect livre; blit recorta
    var r = runSnippet(
        'var E = require("celeros.game.spr");' +
        'E.init({ dir: "Teste" });' +
        'var calls = [];' +
        'var sc = System.setClip, ps = System.pushSprite;' +
        'System.setClip = function (x, y, w, h) { calls.push([x, y, w, h]); sc(x, y, w, h); };' +
        'System.pushSprite = function (x, y, k) { calls.push([x, y, k]); ps(x, y, k); };' +
        'var regs = E.spr.sheet("tiles", { file: "tiles", w: 64, h: 32, tw: 16, th: 16,' +
        '  regions: { chao: [0, 0], bola: [2, 1], logo: [32, 0, 24, 12] } });' +
        '__harness.grab("sheet", [E.spr._used, !!regs.chao.id, regs.logo.w, regs.logo.h,' +
        '  E.spr.backed("chao"), regs.chao.id === regs.bola.id]);' +
        'E.spr.blit("bola", 10, 20);' +
        '__harness.grab("blit", calls);' +
        'E.spr.free("chao");' +
        '__harness.grab("free1", [E.spr.has("chao"), E.spr._used]);' +
        'E.spr.freeSheet("tiles");' +
        '__harness.grab("free2", [E.spr.has("bola"), E.spr.has("logo"), E.spr._used]);' +
        'var an = E.spr.anim ? null : null; __harness.grab("animOk", 1);');
    check('sheet: 1 slot para o PNG inteiro, regioes compartilham o id',
          r.sheet[0] === 1 && r.sheet[1] === true && r.sheet[4] === true &&
          r.sheet[5] === true,
          JSON.stringify(r.sheet));
    check('sheet: rect livre [32,0,24,12] vira regiao de 24x12',
          r.sheet[2] === 24 && r.sheet[3] === 12, JSON.stringify(r.sheet));
    check('blit de regiao: clip no destino + sheet empurrado deslocado (-22, 4)',
          r.blit.length === 2 && r.blit[0].join() === '10,20,16,16' &&
          r.blit[1].join() === '-22,4,0',
          JSON.stringify(r.blit));
    check('free de regiao nao derruba o slot do sheet; freeSheet sim',
          r.free1[0] === false && r.free1[1] === 1 &&
          r.free2[0] === false && r.free2[1] === false && r.free2[2] === 0,
          JSON.stringify([r.free1, r.free2]));

    // sem setClip (firmware velho): regiao cai no paint(nome, x, y)
    r = runSnippet(
        'var E = require("celeros.game.spr");' +
        'E.init({});' +
        'var pintados = [];' +
        'E.spr.sheet("t", { w: 32, h: 32, tw: 16, regions: { a: [0, 0] },' +
        '  paint: function (n, x, y) { pintados.push([n, x, y]); } });' +
        'E.spr.blit("a", 5, 6);' +
        '__harness.grab("fb", pintados);',
        function (env) { delete env.System.setClip; });
    check('sem setClip: regiao cai no paint(nome, x, y)',
          r.fb.length === 1 && r.fb[0].join() === 'a,5,6', JSON.stringify(r.fb));

    // anim por regiao: flipbook com nomes de regiao
    r = runSnippet(
        'var E = require("celeros.game.spr");' +
        'E.init({ dir: "Teste" });' +
        'var pushes = [];' +
        'var ps = System.pushSprite;' +
        'System.pushSprite = function (x, y, k) { pushes.push(x); ps(x, y, k); };' +
        'E.spr.sheet("t", { file: "t", w: 32, h: 16, tw: 16, regions: { p1: [0, 0], p2: [1, 0] } });' +
        'var a = E.anim(["p1", "p2"], 2);' +
        'a.tick(0.6);' +
        'a.draw(40, 50);' +
        '__harness.grab("anim", [a.i, pushes[0]]);');
    check('anim: flipbook por nomes de regiao (i avanca, blit da regiao)',
          r.anim[0] === 1 && typeof r.anim[1] === 'number', JSON.stringify(r.anim));

    fs.rmSync(tmp, { recursive: true, force: true });
})();

// ---------------------------------------------- ui: menus/listas/dialogos --
(function () {
    console.log('SDK CelerGame ui (menu/list/dialog/title/pause):');
    var harness = require('../../test/js_harness/run.js');

    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'celer-ui-'));
    fs.writeFileSync(path.join(tmp, 'app.json'),
                     JSON.stringify({ deps: { 'celeros.game': '^1.0.0',
                                              'celeros.game.fx': '^1.0.0',
                                              'celeros.game.ui': '^1.0.0' } }));

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

    // menu: tap no 2o item devolve o value; disabled nao pega
    var r = runSnippet(
        'var E = require("celeros.game.ui");' +
        'E.init({});' +
        'var pegou = null, quadros = 0;' +
        'E.run({ m: { update: function () { quadros++; if (quadros > 30) E.quit(); },' +
        '  draw: function () {' +
        '    var v = E.ui.menu([{ label: "Jogar", value: "j" },' +
        '                        { label: "Opcoes", value: "o" },' +
        '                        { label: "Nao", value: "n", disabled: true }]);' +
        '    if (v) pegou = v;' +
        '    if (pegou) E.quit();' +
        '  } } }, "m");' +
        '__harness.grab("menu", pegou);',
        function (env) {
            // menu default: x=30, y=96, w=180, row=40 — item 2 no y=136..172
            env.__harness.pushTouch([{ x: 120, y: 150, touched: 1 },
                                     { x: 120, y: 150, touched: 0 }]);
        });
    check('menu: tap no 2o item devolve o value', r.menu === 'o', JSON.stringify(r.menu));
    r = runSnippet(
        'var E = require("celeros.game.ui");' +
        'E.init({});' +
        'var pegou = null, quadros = 0;' +
        'E.run({ m: { update: function () { quadros++; if (quadros > 30) E.quit(); },' +
        '  draw: function () {' +
        '    var v = E.ui.menu([{ label: "Um" }, { label: "Dois", disabled: true }]);' +
        '    if (v) pegou = v;' +
        '  } } }, "m");' +
        '__harness.grab("dis", pegou);',
        function (env) {
            env.__harness.pushTouch([{ x: 120, y: 140, touched: 1 },
                                     { x: 120, y: 140, touched: 0 }]);
        });
    check('menu: item disabled nao pega o tap', r.dis === null, JSON.stringify(r.dis));

    // list: arrasto rola e o tap pega a linha CERTA com o scroll
    r = runSnippet(
        'var E = require("celeros.game.ui");' +
        'E.init({});' +
        'var itens = [];' +
        'for (var i = 0; i < 20; i++) itens.push({ label: "item " + i, value: "i" + i });' +
        'var lst = E.ui.list({ items: itens, row: 28 });' +
        'var fase = 0, tapRow = -1, voltas = 0;' +
        'E.run({ s: { update: function () {' +
        '  if (lst.scroll > 50 && fase === 0) { fase = 1; __harness.tap(120, 150); }' +
        '  if (fase === 1 && lst.picked) { fase = 2;' +
        '    tapRow = Math.floor((150 - 80 + lst.scroll) / 28);' +
        '    E.quit(); }' +
        '  if (++voltas > 200) E.quit();' +
        '}, draw: function () { lst.draw(20, 80, 200, 140); } } }, "s");' +
        '__harness.grab("list", [lst.scroll > 50, lst.picked, tapRow]);',
        function (env) {
            // arrasto de 200 -> 100 DENTRO do rect da lista (sobe ~100 px)
            env.__harness.swipe(120, 200, 120, 100);
        });
    check('list: arrasto rola e o tap pega a linha certa sob o scroll',
          r.list[0] === true && r.list[1] === 'i' + r.list[2],
          JSON.stringify(r.list));

    // dialog: revelacao progressiva, tap 1 completa, tap 2 fecha
    r = runSnippet(
        'var E = require("celeros.game.ui");' +
        'E.init({});' +
        'var d = E.ui.dialog("uma fala bem longa de teste", { speed: 30 });' +
        'var ds = System.drawString, visto = [];' +
        'System.drawString = function (s, x, y, f) { visto.push(String(s)); ds(s, x, y, f); };' +
        'var fase = 0, parcial = -1, cheio = -1, fechou = null, quadros = 0;' +
        'E.run({ s: { update: function () {' +
        '  quadros++;' +
        '  var junto = visto.join("").replace(/ /g, "").length;' +
        '  if (fase === 0 && junto > 0 && junto < 26) { parcial = junto; fase = 1; __harness.tap(120, 250); }' +
        '  else if (fase === 1 && junto >= 26) { cheio = junto; fase = 2;' +
        '    E.after(150, function () { __harness.tap(120, 250); }); }' +
        '  if (quadros > 300) E.quit();' +
        '}, draw: function () { if (d.draw(20, 230, 200) === false) { fechou = true; E.quit(); } } } }, "s");' +
        '__harness.grab("dlg", [parcial > 0 && parcial < 26, cheio >= 26, fechou, d.closed]);');
    check('dialog: revela progressivo, tap completa, tap fecha',
          r.dlg[0] === true && r.dlg[1] === true && r.dlg[2] === true &&
          r.dlg[3] === true,
          JSON.stringify(r.dlg));

    // title/pause/gameOver: telas prontas devolvem a acao do tap
    r = runSnippet(
        'var E = require("celeros.game.ui");' +
        'E.init({});' +
        'var acts = [], tela = "title", quadros = 0;' +
        'E.run({ s: { update: function () { quadros++; if (quadros > 90) E.quit(); },' +
        '  draw: function () {' +
        '    if (tela === "title") { var a = E.ui.title({ game: "X", best: 10 });' +
        '      if (a) { acts.push(a); tela = "pause"; } }' +
        '    else if (tela === "pause") { var p = E.ui.pause({});' +
        '      if (p) { acts.push(p); tela = "over"; } }' +
        '    else { var g = E.ui.gameOver({ score: 42, best: 42, isNew: true });' +
        '      if (g) { acts.push(g); E.quit(); } }' +
        '  } } }, "s");' +
        '__harness.grab("telas", acts);',
        function (env) {
            // title: JOGAR em ~H*0.5 (y 160, h 44); pause: 1a opcao y ~96
            // (menu default 0.30H); gameOver: 'De novo' em y ~192 (menu 0.60H)
            env.__harness.pushTouch([{ x: 120, y: 180, touched: 1 }, { x: 120, y: 180, touched: 0 },
                                     { x: 120, y: 108, touched: 1 }, { x: 120, y: 108, touched: 0 },
                                     { x: 120, y: 210, touched: 1 }, { x: 120, y: 210, touched: 0 }]);
        });
    check('title/pause/gameOver: acoes dos taps na sequencia',
          JSON.stringify(r.telas) === JSON.stringify(['start', 'resume', 'again']),
          JSON.stringify(r.telas));

    // list: item disabled nao pega (o menu ja tinha; a lista ficou de fora)
    r = runSnippet(
        'var E = require("celeros.game.ui");' +
        'E.init({});' +
        'var lst = E.ui.list({ items: [{ label: "A", value: "a" },' +
        '  { label: "B", value: "b", disabled: true }], row: 28 });' +
        'var q = 0, pego = null;' +
        'E.run({ s: { update: function () {' +
        '  q++;' +
        '  if (q === 5) __harness.tap(120, 122);' +          // linha disabled
        '  if (q === 12) { if (lst.picked) pego = "dis:" + lst.picked; __harness.tap(120, 94); }' +
        '  if (q === 20) { if (lst.picked) pego = lst.picked; E.quit(); }' +
        '}, draw: function () { lst.draw(20, 80, 200, 100); } } }, "s");' +
        '__harness.grab("ldis", [pego, lst.picked]);');
    check('list: item disabled nao pega o tap',
          r.ldis[0] === 'a', JSON.stringify(r.ldis));

    // title com start:null esconde o botao e o extra sobe para o centro
    r = runSnippet(
        'var E = require("celeros.game.ui"); E.init({});' +
        'var act = null, q = 0;' +
        'E.run({ s: { update: function () { q++; if (q === 5) __harness.tap(120, 170);' +
        '  if (q > 20) E.quit(); },' +
        '  draw: function () { var a = E.ui.title({ game: "X", start: null, extra: "Opcoes" });' +
        '    if (a) act = a; } } }, "s");' +
        '__harness.grab("tsn", act);');
    check('title: start null esconde o botao (tap cai no extra)',
          r.tsn === 'extra', JSON.stringify(r.tsn));

    // gameOver: detail desenha a linha extra (placar do adversario etc.)
    r = runSnippet(
        'var E = require("celeros.game.ui"); E.init({});' +
        'var v = [], ds = System.drawString;' +
        'System.drawString = function (s, x, y, f) { v.push(String(s)); ds(s, x, y, f); };' +
        'var q = 0;' +
        'E.run({ s: { update: function () { if (++q > 3) E.quit(); },' +
        '  draw: function () { E.ui.gameOver({ score: 1, best: 2, detail: "Adversario: 3" }); } } }, "s");' +
        '__harness.grab("det", v.join("|"));');
    check('gameOver: detail desenha a linha extra',
          r.det.indexOf('Adversario: 3') >= 0, r.det);

    // pause(clear): nao pinta o fundo da tela (a cena congelada fica)
    r = runSnippet(
        'var E = require("celeros.game.ui"); E.init({});' +
        'var cheios = 0, fr = System.fillRect;' +
        'System.fillRect = function (x, y, w, h, c) {' +
        '  if (w === E.W && h === E.H) cheios++; fr(x, y, w, h, c); };' +
        'var q = 0;' +
        'E.run({ s: { update: function () { if (++q > 2) E.quit(); },' +
        '  draw: function () { E.ui.pause({ clear: true }); } } }, "s");' +
        '__harness.grab("clr", cheios);');
    check('pause(clear): nao pinta o fundo da tela',
          r.clr === 0, String(r.clr));

    // emitter once: duracao vencida libera a vaga sozinha
    r = runSnippet(
        'var E = require("celeros.game.fx"); E.init({ particles: 16 });' +
        'E.fx.emitter({ x: 10, y: 10, rate: 10, duration: 50, once: true });' +
        'var n = -1, q = 0;' +
        'E.run({ s: { update: function () {' +
        '  if (++q === 40) { n = E.fx._emitters.length; E.quit(); }' +
        '} } }, "s");' +
        '__harness.grab("once", n);');
    check('fx.emitter once: sai da lista ao fim da duracao',
          r.once === 0, String(r.once));

    // E.transitioning publico (antes os apps liam o E._trans privado)
    r = runSnippet(
        'var E = require("celeros.game"); E.init({});' +
        'var viu = false, fim = false, q = 0;' +
        'E.run({ a: { update: function () {' +
        '  if (++q === 2) E.goto("b", { transition: "fade", ms: 200 });' +
        '  if (E.transitioning) viu = true; } },' +
        '  b: { enter: function () { E.after(400, function () {' +
        '    fim = !E.transitioning; E.quit(); }); } } }, "a");' +
        '__harness.grab("tr", [viu, fim]);');
    check('E.transitioning: true durante o veu e false depois',
          r.tr[0] === true && r.tr[1] === true, JSON.stringify(r.tr));

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
    check('physics 2.1.1 exporta rigid', typeof P.rigid === 'function' && P.version === '2.1.1');
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

// ------------------------------- espelho rigid2d.js: martelo do espelho --
// O mesmo adversario do teste host (test/cpp/run_tests.cpp,
// testRigid2DHammer) contra o espelho JS: sequencia deterministica de
// remove/setBody-teleporte/impulse/step num mundo denso conferindo o
// invariante dos arbitros (o splice de insercao do narrow mantem a ordem
// que o findArb binario espera) — mais as valvulas do header (restituicao
// so em contato fresco + teto do alvo, portao kBounceMin do hit)
(function () {
    console.log('SDK rigid2d.js (espelho do Rigid2D.h):');
    var M = require('../../tools/sdk/lib/rigid2d.js');

    // LCG igual ao do teste host (uint32)
    var rng = 0xC0FFEE42;
    function next() { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng; }

    var w = new M.World(10);
    function addRandom() {
        var r = next(), r2 = next(), r3 = next();
        var circ = (r & 1) !== 0;
        var hw = 2 + (r % 900) / 100;
        var hh = circ ? hw : 2 + ((r >>> 8) % 900) / 100;
        var x = 4 + (r2 % 22000) / 100;
        var y = 4 + ((r2 >>> 8) % 28000) / 100;
        var dens = (r3 % 7) === 0 ? 0 : 0.2 + (r3 % 500) / 100;
        return M.addBody(w, circ ? M.CIRCLE : M.BOX, x, y, hw, hh,
                         ((r >>> 12) % 628) / 100, dens, (r3 % 11) / 10, (r3 % 6) / 10);
    }
    // arena densa: chao, teto e paredes estaticas (como no teste host)
    M.addBody(w, M.BOX, 120, 310, 240, 10, 0, 0, 0.7, 0);
    M.addBody(w, M.BOX, 120, -10, 240, 10, 0, 0, 0.7, 0);
    M.addBody(w, M.BOX, -10, 150, 10, 320, 0, 0, 0.7, 0);
    M.addBody(w, M.BOX, 250, 150, 10, 320, 0, 0, 0.7, 0);
    var vivos = 0, i;
    for (i = 0; i < 56; i++) if (addRandom() >= 0) vivos++;
    check('espelho: mundo denso criado', vivos > 50);
    check('espelho: arbitros ordenados no repouso', M.arbOk(w));
    var telep = 0, remov = 0, ok = true, finite = true;
    for (var it = 0; it < 1500; it++) {
        var op = next();
        if ((op % 100) < 10 && w.nBodies > 6) {
            if (M.removeBody(w, (op >>> 8) % w.nBodies)) remov++;
        }
        op = next();
        if ((op % 100) < 14) {
            if (M.setBody(w, (op >>> 8) % w.nBodies,
                          4 + (op % 21000) / 100, 4 + ((op >>> 12) % 27000) / 100,
                          ((op >>> 4) % 628) / 100,
                          ((op % 4000) - 2000) / 10, (((op >>> 6) % 4000) - 2000) / 10, 0)) telep++;
        }
        op = next();
        if ((op % 100) < 8 && w.nBodies < M.K.MAX_BODIES - 1) addRandom();
        op = next();
        if ((op % 100) < 10) {
            M.impulse(w, (op >>> 8) % w.nBodies,
                      ((op % 2000) - 1000) / 2, (((op >>> 5) % 2000) - 1000) / 2);
        }
        M.step(w, 1 / (25 + (op % 75)), (op & 0x100) ? 60 : 0, (op & 0x200) ? 0 : 400, 8);
        if (!M.arbOk(w)) ok = false;
        for (i = 0; i < w.nBodies; i++) {
            var b = w.bodies[i];
            if (b.alive && !(b.x === b.x && Math.abs(b.x) < 1e30 && Math.abs(b.y) < 1e30)) finite = false;
        }
    }
    check('espelho: martelo mantem arbitros ordenados/validos (1500 ciclos)', ok);
    check('espelho: martelo nao cria NaN/infinito', finite);
    check('espelho: teleporte e remove exercitados', telep > 100 && remov > 100);

    // valvulas do round 3b no espelho: leve preso entre pesado e chao
    // (razao 75x) assenta em vez de ser ejetado pelo mapa
    var W2 = new M.World(10);
    M.addBody(W2, M.BOX, 160, 270, 200, 10, 0, 0, 0.7, 0);
    M.addBody(W2, M.BOX, 160, 200, 20, 8, 0, 0.05, 0.6, 0.5);
    M.addBody(W2, M.BOX, 160, 100, 30, 30, 0, 1, 0.6, 0.5);
    for (var t = 0; t < 300; t++) M.step(W2, 1 / 30, 0, 400, 12);
    check('espelho: leve espremido assenta no chao (valvula de restituicao)',
          W2.bodies[1].y > 240 && W2.bodies[1].y < 266, 'y=' + W2.bodies[1].y.toFixed(1));
    // ...e o hit nao abre em repouso (portao kBounceMin)
    for (t = 0; t < 30; t++) M.step(W2, 1 / 30, 0, 400, 12);
    check('espelho: hit zero em repouso',
          W2.bodies[1].hit === 0 && W2.bodies[2].hit === 0);
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

// ------------------------------------------- Neon Surfer: pista justa ----
// Invariantes de justica do nascimento (hub_apps/2D Runner/pista.js),
// fuzzados com rnd semeado em varias velocidades: I1 espaco na mesma
// faixa (trem x qualquer entidade), I2 teia entre trens de faixas
// vizinhas (sempre ha corredor em Y), I3 moeda so em faixa alcancavel e
// I4 saturacao desiste (null) em vez de fechar a pista. As entidades
// andam juntas, entao o que vale no nascimento vale na passada toda.
(function () {
    console.log('Neon Surfer (pista.js):');
    var P = require(path.join(ROOT, 'hub_apps', '2D Runner', 'pista.js'));
    check('pista.js: module.exports versionado', P.version === '1.0.0', P.version);

    function mulberry32(a) {
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            var t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    function janela(e) { return { a: e.y, b: e.y + (e.h || 20) }; }

    // violacao dos invariantes na pista inteira (null = tudo justo)
    function violacao(ents, speed) {
        var gT = speed * 0.45 + 50, gS = speed * 0.55 + 70;
        for (var i = 0; i < ents.length; i++) {
            var a = ents[i];
            for (var j = i + 1; j < ents.length; j++) {
                var b = ents[j];
                var mesma = a.lane === b.lane;
                var viz = Math.abs(a.lane - b.lane) === 1;
                if (mesma) {
                    // I1: so quando um dos dois e trem (moedas em fileira
                    // colam de proposito — sao coletadas juntas)
                    if (a.type !== 'train' && b.type !== 'train') continue;
                } else if (viz) {
                    // I2: corredor vale entre trens
                    if (a.type !== 'train' || b.type !== 'train') continue;
                } else continue;
                var g = mesma ? gS : gT;
                var wa = janela(a), wb = janela(b);
                if (wa.a < wb.b + g && wa.b > wb.a - g)
                    return a.type + '@' + a.lane + ',' + a.y.toFixed(0) +
                           ' x ' + b.type + '@' + b.lane + ',' + b.y.toFixed(0) +
                           ' (speed ' + speed + ')';
            }
        }
        return null;
    }

    // I3: moeda alcancavel — na faixa dela, todo trem clareia antes ou
    // chega depois com espaco de saida
    function moedaInalcancavel(ents, speed) {
        var g = speed * 0.55 + 70;
        for (var i = 0; i < ents.length; i++) {
            var c = ents[i];
            if (c.type !== 'coin') continue;
            var w = janela(c);
            for (var j = 0; j < ents.length; j++) {
                var t = ents[j];
                if (t.type !== 'train' || t.lane !== c.lane) continue;
                var wt = janela(t);
                if (!(wt.a >= w.b + g || wt.b <= w.a - g))
                    return 'moeda@' + c.lane + ',' + c.y.toFixed(0) +
                           ' presa no trem@' + t.y.toFixed(0);
            }
        }
        return null;
    }

    function fuzz(speed, n, seed) {
        var rnd = mulberry32(seed);
        var ents = [];
        var cfg = { speed: speed, hudH: 34, rnd: rnd };
        for (var i = 0; i < n; i++) {
            var x = P.nascer(ents, cfg);
            if (x) {
                if (x.type === 'fileira') {
                    for (var c = 0; c < 3; c++)
                        ents.push({ type: 'coin', lane: x.lane, y: x.y - c * 30 });
                } else ents.push(x);
            }
            // o mundo anda: os que passaram saem (como no jogo, y > H+20)
            for (var k = ents.length - 1; k >= 0; k--)
                if (ents[k].y > 340) ents.splice(k, 1);
            var ruim = violacao(ents, speed) || moedaInalcancavel(ents, speed);
            if (ruim) return { i: i, ruim: ruim };
        }
        return null;
    }

    var casos = [[150, 400, 11], [300, 400, 23], [450, 400, 37], [600, 400, 51]];
    for (var ci = 0; ci < casos.length; ci++) {
        var ruim = fuzz(casos[ci][0], casos[ci][1], casos[ci][2]);
        check('fuzz speed ' + casos[ci][0] + ': ' + casos[ci][1] +
              ' nascimentos sem fechar a pista', ruim === null, ruim && ruim.ruim);
    }

    // determinismo: mesma semente, mesma pista (o fuzz e reprodutivel)
    function pistaTxt(speed, seed) {
        var rnd = mulberry32(seed);
        var ents = [], cfg = { speed: speed, hudH: 34, rnd: rnd };
        for (var i = 0; i < 60; i++) {
            var x = P.nascer(ents, cfg);
            if (x) ents.push(x);
            for (var k = ents.length - 1; k >= 0; k--)
                if (ents[k].y > 340) ents.splice(k, 1);
        }
        return JSON.stringify(ents);
    }
    check('pista deterministica com a mesma semente',
          pistaTxt(300, 99) === pistaTxt(300, 99));

    // I4 na mao: pista saturada (3 trens colados no topo) — o resolver
    // desiste ou empurra pra longe, nunca sobrepoem
    var cheia = [
        { type: 'train', lane: 0, y: 40, h: 80 },
        { type: 'train', lane: 1, y: 40, h: 80 },
        { type: 'train', lane: 2, y: 40, h: 80 }
    ];
    var t = P.trem(cheia, 1, { speed: 300, hudH: 34 });
    var tOk = t === null || (t.y <= 40 - (300 * 0.55 + 70) - 80);
    check('pista saturada: resolver desiste ou empurra acima do gap',
          tOk, JSON.stringify(t));
    var f = P.nascer(cheia, { speed: 300, hudH: 34, rnd: mulberry32(7) });
    var fOk = f === null || f.type === 'coin' || f.type === 'fileira' ||
              f.y <= 40 - (300 * 0.55 + 70) - 80;
    check('pista saturada: nascer devolve saida justa (moeda ou trem afastado)',
          fOk, JSON.stringify(f));

    // trem nasce sempre com altura (o bug do NaN na colisao)
    var nt = P.trem([], 1, { speed: 150, hudH: 34 });
    check('trem novo sempre carrega h', !!nt && nt.h === 80, JSON.stringify(nt));
})();

// CelerGame 1.1 (core/fx/spr/tilemap/ui/sfx) + drift dos d.ts da engine
require('./celergame_next.js')(check);
// modulos p/ jogos complexos (fsm/events/path/collide/pad/level) + core 1.2
require('./celergame_mods.js')(check);
require('./celergame_r3.js')(check);
require('./celergame_r4.js')(check);

// resumo
console.log('');
if (failures) {
    console.log('FALHAS: ' + failures);
    process.exit(1);
}
console.log('OK: todos os testes do SDK passaram');
