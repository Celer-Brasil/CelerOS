// test.js — smoke da Lenda de Celer no harness (celer.js test / js_harness):
// titulo -> arquivo novo -> fecha a voz com o botao A -> anda e aperta A
// JUNTOS (multitoque, dois dedos) -> Sabio da a espada -> slide de sala
// pela borda -> espada mata uma geleia -> bomba abre a parede rachada (os
// dois lados) -> chave abre a porta trancada -> o Guardiao cai -> o
// cristal leva a cena de vitoria. Ganchos: __harness.lenda {E, J, A}.
//
// Um timer SO, em cadeia: o harness tem pool de 8 timers (como o
// firmware) e descarta o excedente — cada passo agenda o proximo. O
// relogio e virtual (anda no delay/getTouch); a rodada e sincrona.

module.exports.wire = function (env) {
    var h = env.__harness;
    var passos = [];
    function at(fn, t) { passos.push({ t: t, fn: fn }); }
    var origDelay = env.System.delay;
    var stopAt = 1000 + 14500;
    env.System.delay = function (ms) {
        if (env.System.millis() > stopAt) throw { harnessStop: true };
        return origDelay(ms);
    };
    function L() { return h.lenda; }
    function falha(msg) { throw new Error('Lenda: ' + msg); }
    function T(ts) { return { touches: ts }; }
    // botoes do pad (mesma conta do jogo.js, 480x480 nativo: CELL 32)
    var C = 32;
    var BA = { x: 480 - 1.5 * C, y: 480 - 2.1 * C }, BB = { x: 480 - 3.5 * C, y: 480 - 1.0 * C };
    function aperta(b, id) {
        var f = { id: id || 6, x: Math.round(b.x), y: Math.round(b.y) };
        h.pushTouch([T([f]), T([f]), T([])]);
    }
    function blindar() {
        var J = L().J;
        J.h.st.base.hp = 40;
        J.h.st.hp = 40;
    }

    // titulo: Arquivo 1 (menu em y 0.55*H, linhas de 0.1*H)
    at(function () { h.pushTouch([{ x: 240, y: 286, touched: 1 }, { x: 240, y: 286, touched: 0 }]); }, 400);

    // a voz da intro: A completa e fecha
    at(function () {
        var J = L().J;
        if (L().E.sceneName !== 'jogo') falha('esperava a cena jogo, esta em ' + L().E.sceneName);
        if (!J.dlg) falha('a voz da intro nao abriu');
        aperta(BA);
    }, 1600);
    at(function () { aperta(BA); }, 1800);
    var x0 = 0;
    at(function () {
        var J = L().J;
        if (J.dlg) falha('o dialogo nao fechou com o botao A');
        x0 = J.h.x;
        // stick para a direita (dedo 3) E o A apertado junto (dedo 7)
        var fr = [];
        for (var i = 0; i < 30; i++) {
            var ts = [{ id: 3, x: 100 + Math.min(i, 4) * 15, y: 330 }];
            // A apertado JUNTO com o stick: golpeia (para 0,2 s) e segue andando
            if (i >= 4 && i < 7) ts.push({ id: 7, x: Math.round(BA.x), y: Math.round(BA.y) });
            fr.push(T(ts));
        }
        fr.push(T([]));
        h.pushTouch(fr);
    }, 2200);
    at(function () {
        var J = L().J;
        if (!(J.h.x > x0 + 20)) falha('a heroina nao andou com o stick (x ' + x0 + ' -> ' + J.h.x + ')');
        if (!J.h.golpe) falha('o A junto com o stick nao golpeou');
    }, 2900);

    // gruta do Sabio: a espada
    at(function () { L().J.teleporte('casa', 0, 0, [7, 5]); }, 3000);
    at(function () {
        var J = L().J;
        J.h.dir = 'up';
        aperta(BA);
    }, 3200);
    [3400, 3600, 3800, 4000].forEach(function (t) { at(function () { aperta(BA); }, t); });
    at(function () {
        var J = L().J;
        if (J.d.forca !== 2) falha('o Sabio nao deu a Espada de Celer');
    }, 4500);

    // slide para a sala do leste pela borda
    at(function () { L().J.teleporte('campo', 1, 1, [13, 6]); }, 4600);
    at(function () {
        blindar();
        var fr = [];
        for (var i = 0; i < 40; i++) fr.push(T([{ id: 2, x: 100 + Math.min(i, 4) * 15, y: 330 }]));
        fr.push(T([]));
        h.pushTouch(fr);
    }, 4800);
    at(function () {
        var J = L().J;
        if (J.W.room.id !== 'campo:2,1') falha('o slide nao levou ao Campo Aberto: ' + J.W.room.id);
        if (J.W.sliding) falha('o slide nao terminou');
    }, 6400);

    // espada mata uma geleia a frente
    var geleia = null;
    at(function () {
        var J = L().J;
        blindar();
        var c = J.W.toCell(J.h.x + J.h.w / 2, J.h.y + J.h.h / 2);
        J.h.dir = 'right';
        geleia = J.spawnar('geleia', c.c + 1, c.r);
        geleia.salto = 99;
        aperta(BA);
    }, 6500);
    at(function () { if (!geleia.dead) falha('a espada nao matou a geleia'); }, 7000);

    // bomba na parede rachada do Salao (abre deste lado e na Camara Oculta)
    at(function () { L().J.teleporte('masm', 1, 1, [1, 6]); }, 7100);
    at(function () {
        var J = L().J;
        blindar();
        J.d.bombaItem = true; J.d.bombas = 3; J.d.itemB = 'bomba';
        J.h.dir = 'left';
        aperta(BB);
    }, 7300);
    at(function () {
        var J = L().J;
        if (J.W.get(0, 6) !== 'porta') falha('a bomba nao abriu a parede rachada');
        if (J.W.flagIn('masm:0,1', '_mods')[6 * 15 + 14] !== 'porta') falha('o outro lado da parede nao abriu');
        if (J.d.bombas !== 2) falha('a bomba nao foi gasta');
    }, 9100);

    // chave abre a porta trancada do norte
    at(function () { var J = L().J; J.d.chaves = 1; J.teleporte('masm', 1, 1, [7, 1]); }, 9200);
    at(function () { var J = L().J; blindar(); J.h.dir = 'up'; aperta(BA); }, 9400);
    at(function () {
        var J = L().J;
        if (J.W.get(7, 0) !== 'porta' || J.d.chaves !== 0) falha('a chave nao abriu a porta');
    }, 9800);

    // o Guardiao
    var chefe = null;
    at(function () { L().J.teleporte('masm', 1, 0, [7, 9]); }, 9900);
    at(function () {
        var J = L().J;
        blindar();
        chefe = J.ents.find(function (e) { return e.tipo === 'chefe'; });
        if (!chefe) falha('o Guardiao nao apareceu');
        if (J.W.get(7, 12) !== 'porta_grade') falha('a grade nao fechou atras da heroina');
        chefe.st.hp = 1;
        chefe.st.lastHit = -1e9;
        chefe.fsm.go('tonto', null, true);
        chefe.x = J.h.x + J.h.w / 2 - chefe.w / 2;
        chefe.y = J.h.y - chefe.h - 2;
        J.h.dir = 'up';
        aperta(BA);
    }, 10100);
    at(function () {
        var J = L().J;
        if (!J.d.chefe) falha('o Guardiao nao caiu');
        if (J.W.get(7, 12) !== 'porta') falha('a grade nao abriu com o chefe morto');
        var rel = J.ents.find(function (e) { return e.item === 'relicario'; });
        if (!rel) falha('o cristal do fim nao caiu');
        J.h.x = rel.x; J.h.y = rel.y;
    }, 10600);
    at(function () {
        if (L().E.sceneName !== 'vitoria') falha('esperava a vitoria, esta em ' + L().E.sceneName);
        throw { harnessStop: true };
    }, 13500);

    // cadeia: um timer por vez, na ordem dos tempos
    passos.sort(function (a, b) { return a.t - b.t; });
    var ant = 0;
    function proximo(i) {
        if (i >= passos.length) return;
        var p = passos[i];
        env.setTimeout(function () { p.fn(); proximo(i + 1); }, p.t - ant);
        ant = p.t;
    }
    proximo(0);
};
