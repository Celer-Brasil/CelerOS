// test.js — smoke do Supernova 2.5 no harness: titulo -> jogando -> arrasto
// -> MORTE (hit deterministico via __harness.supernova.jogo) -> fim ->
// de novo -> rajada do chefe no POOL de ebullets -> SUPERNOVA (detonacao
// com carga furada) -> pausa -> continuar, parando no watchdog. No harness
// roda a via procedural (sem createSprite/drawPNG) no canvas nativo do stub
// (480x480), provando a degradacao graciosa sem assets/sprites — e os
// acertos sao por distancia nos pools (sem fisica desde a 2.3).
//
// ATENCAO: os agendamentos usam env.setTimeout (relogio virtual do harness,
// disparado no delay/getTouch) — o setTimeout do Node nunca rodaria: a
// rodada inteira e sincrona.

module.exports.wire = function (env) {
    var h = env.__harness;
    var at = env.setTimeout;

    // watchdog do proprio teste (o runner so instala um com --frames/render)
    var origDelay = env.System.delay;
    var stopAt = 1000 + 9000;   // clock do harness comeca em 1000
    var marcos = [];   // [ms, cena esperada] (preenchido no fim do wire)
    env.System.delay = function (ms) {
        var now = env.System.millis() - 1000;
        var m = h.supernova;
        while (marcos.length && now >= marcos[0][0]) {
            var mk = marcos.shift();
            if (m && m.E.sceneName !== mk[1]) {
                throw new Error('Supernova: em ' + mk[0] + ' ms esperava a cena ' + mk[1] +
                                ', esta em ' + m.E.sceneName);
            }
        }
        if (env.System.millis() > stopAt) throw { harnessStop: true };
        return origDelay(ms);
    };

    // botoes no rodape (E.u: 2x no 480): JOGAR em y 328..382, x 90..390
    at(function () {
        h.pushTouch([{ x: 240, y: 355, touched: 1 }, { x: 240, y: 355, touched: 0 }]);
    }, 400);

    // arrasto na jogatina (a nave desvia e esquenta o motor)
    at(function () {
        h.pushTouch([
            { x: 180, y: 400, touched: 1 },
            { x: 220, y: 400, touched: 1 },
            { x: 260, y: 400, touched: 1 },
            { x: 300, y: 402, touched: 1 },
            { x: 300, y: 402, touched: 0 }
        ]);
    }, 800);

    // morte deterministica: 1 vida + tiro inimigo em cima da nave
    at(function () {
        var m = h.supernova;
        if (!m) return;
        var s = m.jogo.state();
        s.lives = 1;
        s.player.invuln = 0;
        m.jogo.debugHit();
    }, 2200);

    // fim de jogo (t > 0,5): DE NOVO no primeiro item do menu da dep ui
    // (menu em y = H*0.60 = 288, linha de 80: 288..360), x 60..420
    at(function () {
        h.pushTouch([{ x: 240, y: 320, touched: 1 }, { x: 240, y: 320, touched: 0 }]);
    }, 3600);

    // carrega, solta o anel do chefe no POOL e detona a supernova (toque no
    // medidor do canto inferior esquerdo). Tudo num timer so: o harness so
    // tem 8 timers e o smoke ja usa todos.
    at(function () {
        var m = h.supernova;
        if (!m) return;
        m.jogo.state().charge = 100;
        m.jogo.debugRing(240, 200);
        if (m.jogo.bullets().ebn < 10) {
            throw new Error('Supernova: anel nao povoou o pool de ebullets');
        }
    }, 4600);
    at(function () {
        h.pushTouch([{ x: 60, y: 420, touched: 1 }, { x: 60, y: 420, touched: 0 }]);
    }, 5200);

    // pausa (canto superior direito) e continua — E.ui.pause desenha
    // Continuar/Recomecar/Sair no menu padrao da engine: a 1a linha fica
    // em y = H*0.3 = 144 com 80 de passo (144..216)
    at(function () {
        h.pushTouch([{ x: 460, y: 30, touched: 1 }, { x: 460, y: 30, touched: 0 }]);
    }, 6400);
    at(function () {
        h.pushTouch([{ x: 240, y: 180, touched: 1 }, { x: 240, y: 180, touched: 0 }]);
    }, 7200);

    // o fluxo de cenas tem que ter andado (coordenadas erradas = tap no
    // vazio). Conferido no delay: o harness tem so 8 timers (os taps acima)
    marcos = [[300, 'titulo'], [1500, 'jogando'], [3500, 'fim'], [4500, 'jogando'],
              [7000, 'pausa'], [8000, 'jogando']];
};
