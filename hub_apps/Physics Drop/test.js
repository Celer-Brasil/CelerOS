// test.js — smoke do Physics Drop 4.2 no harness: a tela de titulo entra
// no sandbox pelo JOGAR (fade), o caminho NATIVO do P.verletFast
// (System.verlet* do stub), Corda+Pano caem (com a colisao ponto-a-ponto),
// PEGAR arrasta um no do pano, CORTAR remove vinculos na varredura e a
// gravidade INVERTIDA ergue o mundo (fisica de verdade).
// Agendamentos em env.setTimeout (relogio virtual do harness), em CADEIA:
// o pool tem 8 slots no firmware e a bateria agenda ~17 marcos — um timer
// por vez mantem todos vivos (antes o pool cheio descartava os ultimos e a
// checagem da gravidade invertida nunca rodava). Nunca embarca ao device.

module.exports.wire = function (env) {
    var h = env.__harness;
    var fila = [], tAnt = 0, rodando = false;
    function at(fn, ms) {
        fila.push({ fn: fn, ms: ms });
        fila.sort(function (a, b) { return a.ms - b.ms; });
        if (!rodando) { rodando = true; escorrer(); }
    }
    function escorrer() {
        if (!fila.length) return;
        var it = fila.shift();
        env.setTimeout(function () {
            try { it.fn(); } finally { tAnt = it.ms; escorrer(); }
        }, Math.max(1, it.ms - tAnt));
    }

    // watchdog: a rodada inteira cabe em ~12 s de relogio virtual
    var origDelay = env.System.delay;
    var stopAt = 1000 + 12000;
    env.System.delay = function (ms) {
        if (env.System.millis() > stopAt) throw { harnessStop: true };
        return origDelay(ms);
    };

    var drop = null;
    function need() {
        if (!drop) drop = h.drop;
        if (!drop) throw new Error('main.js nao expoe __harness.drop');
    }
    // chip i da linha de ferramentas (larguras acumuladas de TOOLS)
    function chipX(i) {
        var x = 10;
        for (var k = 0; k < i; k++) x += drop.TOOLS[k].w + 2;
        return x + drop.TOOLS[i].w / 2;
    }

    // menor Y dos nos LIVRES (a gravidade invertida so ergue quem nao
    // esta pinado — os pinos seguram os pontos onde estao)
    function minYlivre() {
        var w = drop.world(), xy = w.xy(), pins = w.pins(), best = 1e9;
        for (var i = 0; i < w.count(); i++) {
            if (pins[i]) continue;
            if (xy[i * 2 + 1] < best) best = xy[i * 2 + 1];
        }
        return best;
    }

    // 100ms: titulo -> JOGAR (o fade de 300ms troca a cena ~290ms, antes
    // do primeiro toque da bateria no mundo) e o wrapper ja pegou o caminho
    // NATIVO (System.verlet* do stub), nao o fallback verletFastJS
    at(function () {
        need();
        if (drop.world().native !== true) throw new Error('P.verletFast deve usar o System.verlet* (nativo)');
        h.tap(120, 182);
    }, 100);

    // 400ms: solta uma corda e um pano
    at(function () { need(); h.tap(45, drop.BAR_Y + 70); }, 400);
    at(function () { h.tap(119, drop.BAR_Y + 70); }, 700);
    // 1600ms: os dois caem — muitos nos, muitos vinculos, colisao ativa
    at(function () {
        need();
        if (drop.world().count() < 40) throw new Error('corda+pano nao spawnaram: ' + drop.world().count() + ' nos');
        if (drop.world().sticks().length < 80) throw new Error('vinculos baixos: ' + drop.world().sticks().length / 2);
    }, 1600);

    // 2000ms: PEGAR — seleciona a ferramenta e arrasta o no 1 do pano
    at(function () { need(); h.tap(chipX(1), drop.BAR_Y + 39); }, 2000);
    at(function () {
        var xy = drop.world().xy();
        var y0 = xy[3];
        var x0 = xy[2];
        // sem o "up": o no fica seguro no dedo e a conferencia acontece
        // com ele ainda pego (solto, o elastico do pano puxa de volta)
        var frames = [
            { x: x0, y: y0, touched: 1 },
            { x: x0 + 30, y: y0 + 30, touched: 1 },
            { x: x0 + 55, y: y0 + 45, touched: 1 }
        ];
        // dedo seguro: sem novos eventos o harness soltaria o toque (fila
        // vazia = dedo levantou); 12 frames parado no alvo cobrem a checagem
        for (var hf = 0; hf < 12; hf++) {
            frames.push({ x: x0 + 55, y: y0 + 45, touched: 1 });
        }
        h.pushTouch(frames);
        drop.__alvo = { x: x0 + 55, y: y0 + 45 };
        env.System.print('grab: tool=' + drop.tool() + ' count=' + drop.world().count() + ' pega xy=' + x0.toFixed(0) + ',' + y0.toFixed(0));
    }, 2400);
    at(function () {
        // prova pelo log do proprio app: cada frame de drag registra
        // dedo x no1 — o no acompanhou o dedo em >= 4 frames
        var seguiu = 0, ls = env.__harness.log;
        for (var li = 0; li < ls.length; li++) {
            var m = /\[grab\] drag dedo (\d+),(\d+) \| no1 (\d+),(\d+)/.exec(ls[li]);
            if (m && m[1] === m[3] && m[2] === m[4]) seguiu++;
        }
        if (seguiu < 4) throw new Error('PEGAR nao segurou o no no dedo (' + seguiu + ' frames)');
    }, 3000);

    // 3600ms: CORTAR — varre a faixa do meio; a corda perde pedacos
    at(function () { need(); h.tap(chipX(3), drop.BAR_Y + 39); }, 3600);
    at(function () {
        need();
        drop.__st0 = drop.world().sticks().length / 2;
        h.pushTouch([
            { x: 20, y: 150, touched: 1 },
            { x: 90, y: 150, touched: 1 },
            { x: 160, y: 150, touched: 1 },
            { x: 220, y: 150, touched: 1 },
            { x: 220, y: 151, touched: 0 }
        ]);
    }, 3900);
    at(function () {
        need();
        var st = drop.world().sticks().length / 2;
        if (st >= drop.__st0) throw new Error('CORTAR nao removeu vinculos (' + st + ' vs ' + drop.__st0 + ')');
    }, 4800);

    // 5300..7300ms: 4 toques no status ciclam a gravidade ate a INVERTIDA
    // (5 presets: normal -> leve -> lua -> forte -> invertida); o mundo
    // inteiro flutua para o topo (bounds seguram, pinos ficam)
    at(function () {
        need();
        drop.__topAntes = minYlivre();
        if (drop.__topAntes > 500) throw new Error('mundo vazio antes da gravidade invertida');
    }, 5300);
    [5500, 6000, 6500, 7000].forEach(function (t) {
        at(function () { need(); h.tap(120, drop.BAR_Y + 12); }, t);
    });
    at(function () {
        need();
        var top = minYlivre();
        if (!(top < drop.__topAntes - 15 && top < 25)) {
            throw new Error('gravidade invertida nao ergueu o mundo (topo livre ' +
                            top.toFixed(1) + ' vs ' + drop.__topAntes.toFixed(1) + ')');
        }
    }, 11500);
};
