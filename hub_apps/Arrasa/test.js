// test.js — bateria do Arrasa! no harness (o System.rigid* e o espelho JS
// do solver nativo: tools/sdk/lib/rigid2d.js). Dirige o jogo por toques
// REAIS no canvas nativo 480x480 e confere pelo __harness.arrasa:
//   1. titulo -> JOGAR -> mapa -> fase 1
//   2. a fase assenta parada: nada quebra, ninguem morre, tudo dorme
//   3. mira de verdade: arrasto do berco para tras e solta — o elastico
//      lanca a pedra (evento lancou, corpo no mundo com velocidade)
//   4. o tiro certo (puxao conhecido) limpa a fase: vitoria, estrelas e
//      recorde salvos, cena de fim
//   5. TNT em cadeia, bomba e tripla pela API do mundo; teto de corpos

module.exports.wire = function (env) {
    var h = env.__harness;
    var fila = [];
    function at(fn, ms) {
        fila.push({ t: env.System.millis() + ms, fn: fn });
        fila.sort(function (a, b) { return a.t - b.t; });
    }
    var origDelay = env.System.delay;
    var stopAt = 1000 + 40000;
    env.System.delay = function (ms) {
        while (fila.length && env.System.millis() >= fila[0].t) fila.shift().fn();
        if (env.System.millis() > stopAt) throw { harnessStop: true };
        return origDelay(ms);
    };
    function assert(cond, msg) { if (!cond) throw new Error('arrasa: ' + msg); }
    function X() { return h.arrasa; }
    function cena(nome) {
        var E = X() && X().E;
        assert(E && E.sceneName === nome, 'esperava a cena ' + nome + ', esta em ' + (E && E.sceneName));
    }
    function toque(x, y) { h.pushTouch([{ x: x, y: y, touched: 1 }, { x: x, y: y, touched: 0 }]); }
    function arrasto(x0, y0, x1, y1, n) {
        var fr = [];
        for (var k = 0; k <= n; k++) fr.push({ x: x0 + (x1 - x0) * k / n, y: y0 + (y1 - y0) * k / n, touched: 1 });
        for (var j = 0; j < 4; j++) fr.push({ x: x1, y: y1, touched: 1 });
        fr.push({ x: x1, y: y1, touched: 0 });
        h.pushTouch(fr);
    }
    var lancou = false, pontos0 = 0;

    // 1. titulo -> mapa -> fase 1 (canvas nativo 480: JOGAR ~ (240, 190))
    at(function () { cena('titulo'); toque(240, 190); }, 400);
    at(function () { cena('mapa'); toque(80, 160); }, 900);
    at(function () {
        cena('jogando');
        var M = X().M;
        assert(M.w && !M.sem, 'mundo rigido criado (API 33 no stub)');
        assert(M.goblins === 2, 'fase 1 tem 2 goblins (' + M.goblins + ')');
        assert(M.tiros.length === 1 && M.tiro, 'fase 1: 2 tiros (1 armando + 1 na fila)');
    }, 1500);

    // pausa no meio da fase e volta sem recarregar (o tempo da fase segue)
    var tPausa = 0;
    at(function () { tPausa = X().M.t; toque(36, 34); }, 2000);
    at(function () { cena('pausa'); toque(240, 196); }, 2500);
    at(function () {
        cena('jogando');
        assert(X().M.t >= tPausa && X().M.goblins === 2, 'CONTINUAR retoma a mesma fase');
    }, 3000);

    // 2. assenta parada
    at(function () {
        var M = X().M;
        assert(M.pontos === 0 && M.goblins === 2, 'fase desmontou sozinha (pontos ' + M.pontos + ')');
        assert(M.tiro.estado === 'pronto', 'pedra armada no estilingue (' + M.tiro.estado + ')');
        var acordados = 0;
        for (var i = 0; i < M.corpos.length; i++) {
            if (M.corpos[i] && !M.corpos[i].fixo && M.w.awake(i, M.s)) acordados++;
        }
        assert(acordados === 0, 'a fortaleza dorme parada (' + acordados + ' acordados)');
        // 3. mira por toque: do berco (51,239 -> 77,358 na tela) para tras
        arrasto(77, 358, 22, 380, 8);
    }, 4000);
    at(function () {
        var M = X().M;
        assert(M.tiro.estado === 'voando' || M.tiro.estado === 'assentando' || M.tiro.estado === 'fim',
               'o toque lancou a pedra (' + M.tiro.estado + ')');
        lancou = true;
    }, 4900);

    // 4. recarrega a fase e da o tiro conhecido (puxao 160 graus, 85%)
    at(function () {
        var M = X().M;
        assert(lancou, 'lance por toque');
        if (!M.acabou) M.carregar(0);
    }, 11500);
    at(function () {
        var M = X().M;
        if (M.acabou) return;
        assert(M.tiro.estado === 'pronto', 'recarga armou');
        M.tiro.estado = 'mirando';
        var a = 160 * Math.PI / 180;
        M.pull.x = Math.cos(a) * 42 * 0.85;
        M.pull.y = Math.sin(a) * 42 * 0.85;
        assert(M.soltar() !== null, 'soltar lanca');
        // resolve o voo no passo de PROJETO (1/30), como o resto da bateria:
        // o pacing do core 1.5 anda em quadros de 33/34 ms (o alvo de 30 fps
        // e' 33,33 ms) e a trajetoria da pedra depende do dt — o que se
        // garante aqui e' a fisica no passo de 1/30, nao o relogio do harness.
        // Os eventos do passo vao pelo processa do jogo (rastro, sfx, placar)
        for (var k = 0; k < 180 && !M.acabou; k++) {
            var ev = M.step(1 / 30);
            if (ev && ev.length) X().processa(ev);
        }
    }, 14000);
    at(function () {
        var M = X().M;
        assert(M.rastro.length === 0 && M.rastroNovo.length === 0, 'rastro limpo ao fim do voo');
        assert(M.venceu, 'o tiro certo limpa a fase 1 (goblins ' + M.goblins + ')');
        assert(M.estrelas() >= 1, 'vitoria vale estrela');
    }, 19000);
    at(function () {
        cena('fim');
        var E = X().E;
        assert(E.save.num('est0', 0) >= 1, 'estrelas salvas no NVS');
        assert(E.save.num('pts0', 0) > 0, 'recorde salvo');
    }, 21000);

    // 5. explosoes e habilidades pela API do mundo
    at(function () {
        var M = X().M;
        M.carregar(9);
        for (var k = 0; k < 40; k++) M.step(1 / 30);
        var g0 = M.goblins, tnt = -1;
        for (var i = 0; i < M.corpos.length; i++) if (M.corpos[i] && M.corpos[i].mat === 'tnt') tnt = i;
        assert(tnt >= 0, 'o Castelo do Rei tem TNT');
        M.corpos[tnt].morto = true;
        var boom = false;
        for (k = 0; k < 90; k++) {
            var ev = M.step(1 / 30);
            for (var e = 0; e < ev.length; e++) if (ev[e].t === 'boom') boom = true;
        }
        assert(boom, 'TNT destruida explode');
        assert(M.goblins < g0, 'a explosao derrubou goblins (' + g0 + ' -> ' + M.goblins + ')');
        assert(M.w.count() <= 96, 'teto de corpos do mundo (' + M.w.count() + ')');

        // bomba: lanca e explode no toque
        M.carregar(4);
        for (k = 0; k < 40; k++) M.step(1 / 30);
        M.tiro.tipo = 'bomba';
        M.tiro.estado = 'mirando';
        M.pull.x = -36; M.pull.y = 12;
        M.soltar();
        for (k = 0; k < 12; k++) M.step(1 / 30);
        var evb = [];
        assert(M.habilidade(evb) === true, 'bomba explode no toque');
        assert(evb.length && evb[evb.length - 1].t === 'boom', 'evento boom da bomba');

        // tripla: racha em 3 no ar
        M.carregar(2);
        for (k = 0; k < 40; k++) M.step(1 / 30);
        M.tiro.tipo = 'tripla';
        M.tiro.estado = 'mirando';
        M.pull.x = -36; M.pull.y = 14;
        M.soltar();
        for (k = 0; k < 8; k++) M.step(1 / 30);
        var evt = [];
        assert(M.habilidade(evt) === true && M.tiro.extras.length === 2, 'tripla racha em 3 pedras');

        // flecha, bumerangue e chocadeira: velocidade medida no ar muda
        function lancaTipo(tipo) {
            M.carregar(0);
            for (var q = 0; q < 40; q++) M.step(1 / 30);
            M.tiro.tipo = tipo;
            M.tiro.estado = 'mirando';
            M.pull.x = -30; M.pull.y = 22;
            M.soltar();
            for (q = 0; q < 8; q++) M.step(1 / 30);
            return M.tiro;
        }
        var tf = lancaTipo('flecha'), v0 = Math.abs(tf.v.x), evf = [];
        assert(M.habilidade(evf) && evf[0].t === 'dispara', 'flecha dispara no toque');
        M.step(1 / 30);
        assert(Math.abs(M.tiro.v.x) > v0 * 1.8, 'flecha acelera (' + v0.toFixed(0) + ' -> ' + Math.abs(M.tiro.v.x).toFixed(0) + ')');
        var tb = lancaTipo('bumerangue'), evv = [];
        assert(tb.v.x > 0 && M.habilidade(evv) && evv[0].t === 'volta', 'bumerangue volta no toque');
        M.step(1 / 30);
        assert(M.tiro.v.x < 0, 'bumerangue anda para tras (vx ' + M.tiro.v.x.toFixed(0) + ')');
        lancaTipo('chocadeira');
        var evc = [];
        assert(M.habilidade(evc) && evc[0].t === 'bota' && M.tiro.extras.length === 1, 'chocadeira bota o ovo');
        var boomOvo = false;
        for (k = 0; k < 60 && !boomOvo; k++) {
            var e2 = M.step(1 / 30);
            for (var z = 0; z < e2.length; z++) if (e2[z].t === 'boom') boomOvo = true;
        }
        assert(boomOvo, 'o ovo explode ao bater');
    }, 22000);

    at(function () {
        env.System.print('[arrasa] bateria completa');
        throw { harnessStop: true };
    }, 23000);
};
