// Lenda de Celer — aventura de acao vista de cima para CelerOS (placas com
// PSRAM; feita para o vidro 480x480 da SmartDisplay 4848, multitoque).
// Explore a campina em telas que deslizam, ganhe a espada do Sabio, ache
// a chave, o mapa e o bumerangue no Templo do Cristal e derrote o Guardiao
// de pedra. Tres arquivos de jogo salvos no aparelho.
//
// Vitrine da CelerGame: world (salas + slide + estado por sala), combat
// (espada, bombas, bumerangue, knockback, hitstop), pad multitoque, kit
// (fsm, steer, path, stats, script, inv, events, sfx), fx, spr, ui.
// Arte gerada por IA local (_dev/lenda_sprites.py); musica original.

var E = require('celeros.game');
require('celeros.game.kit');
require('celeros.game.combat');
require('celeros.game.world');
require('celeros.game.pad');
require('celeros.game.ui');
require('celeros.game.fx');
require('celeros.game.spr');
var A = require('arte');
var J = require('jogo');
var SOM = require('som');
var S = System;

E.init({ native: true, fps: 30, save: 'lenda.', particles: 140 });
// arte na RAIZ do app (pacote flat): pasta da loja (pacote) ou do dev
E.spr.bases = ['/local/apps/celeros.lenda/', '/sd/apps/celeros.lenda/',
               '/local/apps/Lenda de Celer/', '/sd/apps/Lenda de Celer/'];
A.setup();
A.load();
SOM.init();
// gancho do harness (test.js): estado do jogo para o smoke deterministico
if (typeof __harness !== 'undefined') __harness.lenda = { E: E, J: J, A: A };

// ------------------------------------------------------------- titulo --
var _tt = { align: 'center', valign: 'middle', px: 30, color: 0xFFE0, shadow: 0x0000, screen: true };
var _ts = { align: 'center', px: 13, color: 0xC618, screen: true };
var apagando = false;
function desenhaTitulo() {
    S.fillScreen(0x0000);
    var ok = false;
    for (var i = 0; i < E.spr.bases.length && !ok; i++) {
        try { ok = !!S.drawPNG(E.spr.bases[i] + 'titulo.png', Math.round((E.W - 480) / 2), 0); }
        catch (e) { ok = false; }
    }
    _tt.px = Math.round(28 * E.U);
    _tt.fit = Math.round(E.W * 0.92);
    E.gfx.text('LENDA DE CELER', E.W / 2, Math.round(E.H * 0.42), _tt);
    _ts.px = Math.round(11 * E.U);
    E.gfx.text(apagando ? 'Toque no arquivo para APAGAR' : 'Escolha o arquivo', E.W / 2, Math.round(E.H * 0.5), _ts);
}
function rotulo(n) {
    var d = J.resumo(n);
    if (!d) return 'Arquivo ' + n + ' - novo';
    var cor = Math.floor(d.hpMax / 2);
    return 'Arquivo ' + n + ' - ' + cor + ' cor. ' + d.cristais + ' crist.' + (d.chefe ? ' *' : '');
}
var cenas = {};
cenas.titulo = {
    static: true,
    enter: function () { SOM.tocar('casa'); apagando = false; },
    draw: function () {
        desenhaTitulo();
        var w = Math.round(E.W * 0.78), x = Math.round((E.W - w) / 2), row = Math.round(E.H * 0.1);
        var it = [];
        for (var n = 1; n <= 3; n++) it.push({ label: rotulo(n), value: n, danger: apagando });
        var pick = E.ui.menu(it, { x: x, y: Math.round(E.H * 0.55), w: w, row: row });
        var bw = Math.round(E.W * 0.34);
        var rb = E.gfx.button(apagando ? 'Cancelar' : 'Apagar', (E.W - bw) / 2, Math.round(E.H * 0.88), bw,
                              Math.round(row * 0.75), { primary: false, screen: true });
        if (E.hit(rb)) { apagando = !apagando; E.redraw(); return; }
        if (pick) {
            if (apagando) {
                J.apagar(pick);
                apagando = false;
                SOM.fx('back');
                E.redraw();
                return;
            }
            SOM.fx('ok');
            J.carregar(pick);
            E.goto('jogo', { transition: 'fade', ms: 600 });
        }
    }
};

// --------------------------------------------------------------- jogo --
cenas.jogo = {
    enter: function (arg) { J.enter(arg); },
    update: function (dt) { J.update(dt); },
    draw: function () { J.draw(); },
    exit: function () { if (J.h && !J.h.fsm.is('morto')) J.salvar(); }
};

// -------------------------------------------------------------- pausa --
var _pp = { screen: true };
var _pt = { align: 'center', px: 16, color: 0xFFFF, screen: true };
cenas.pausa = {
    static: true,
    draw: function () {
        var C = A.CELL, d = J.d;
        var w = Math.round(E.W * 0.86), h = Math.round(E.H * 0.8);
        var x = (E.W - w) / 2, y = (E.H - h) / 2;
        E.gfx.panel(x, y, w, h, _pp);
        _pt.px = Math.round(C * 0.55);
        E.gfx.text('PAUSA', E.W / 2, y + C * 0.5, _pt);
        _pt.px = Math.round(C * 0.4);
        E.gfx.text('Item B (toque para equipar)', E.W / 2, y + C * 1.6, _pt);
        // inventario: itens B
        var itens = [];
        if (d.bombaItem) itens.push('bomba');
        if (d.bumerangue) itens.push('bumerangue');
        var sz = Math.round(C * 1.5), gx = E.W / 2 - (itens.length * (sz + C * 0.3)) / 2;
        for (var i = 0; i < itens.length; i++) {
            var bx = gx + i * (sz + C * 0.3), by = y + C * 2.3;
            var sel = d.itemB === itens[i];
            var r = { x: bx, y: by, w: sz, h: sz };
            E.gfx.rect(bx, by, sz, sz, sel ? 0xFD20 : 0x4208, { screen: true, fill: false });
            A.at('item' + A.ITEM[itens[i]], bx + sz / 2, by + sz / 2, 1.1);
            if (E.hit(r)) { d.itemB = itens[i]; J.hudKey = ''; SOM.fx('ui'); E.redraw(); }
        }
        if (!itens.length) E.gfx.text('(nenhum ainda)', E.W / 2, y + C * 2.8, _pt);
        // tesouros
        var tx = x + C * 0.8, ty = y + C * 4.3;
        var tes = [['espada', d.espada], ['mapa', d.mapa], ['chave', d.chaves > 0]];
        for (var k = 0; k < tes.length; k++) {
            if (tes[k][1]) A.at('item' + A.ITEM[tes[k][0]], tx + k * C * 1.2 + C * 0.5, ty + C * 0.5, 0.9);
        }
        _pt.align = 'left';
        E.gfx.text(Math.floor(d.tempo / 60) + ' min de jornada', tx, ty + C * 1.4, _pt);
        _pt.align = 'center';
        // mapa da area
        if (J.W.room && J.W.room.area === 'masm') {
            J.W.minimap(x + w - C * 4.2, ty, { size: Math.round(C * 0.9), gap: 3, reveal: d.mapa });
        }
        var bw = Math.round(w * 0.42), bh = Math.round(C * 1.3);
        var b1 = E.gfx.button('Continuar', x + w * 0.05, y + h - bh - C * 0.5, bw, bh, { screen: true });
        var b2 = E.gfx.button('Salvar e sair', x + w * 0.53, y + h - bh - C * 0.5, bw, bh,
                              { screen: true, primary: false });
        if (E.hit(b1)) { SOM.fx('ok'); E.pop(); }
        if (E.hit(b2)) { J.salvar(); SOM.fx('back'); E.goto('titulo', { transition: 'fade', ms: 500 }); }
    }
};

// ---------------------------------------------------------------- fim --
cenas.fim = {
    static: true,
    enter: function () { SOM.parar(); },
    draw: function () {
        var act = E.ui.gameOver({ title: 'VOCE CAIU', detail: 'Cristais: ' + J.d.cristais,
                                  labels: ['Continuar', 'Titulo'] });
        if (act === 'again') {
            // volta com 3 coracoes na entrada da area (o templo recomeca na porta)
            J.d.hp = Math.min(6, J.d.hpMax);
            var naMasm = J.d.onde.area === 'masm';
            var dst = naMasm ? { area: 'masm', c: 1, r: 2, at: [7, 10] } : { area: 'campo', c: 1, r: 1, at: [7, 6] };
            J.d.onde = dst;
            E.save.setObj('heroi', J.d);
            E.goto('jogo', { transition: 'fade', ms: 600, arg: { porta: dst } });
        } else if (act === 'quit') {
            E.goto('titulo', { transition: 'fade', ms: 500 });
        }
    }
};

// ------------------------------------------------------------ vitoria --
var _vt = { align: 'center', px: 14, color: 0xFFFF, screen: true };
cenas.vitoria = {
    enter: function () { SOM.tocar('casa'); E.dirty.enable(0x0000); this.t = 0; },
    update: function (dt) {
        this.t += dt;
        if (this.t > 3 && E.input.tap) E.goto('titulo', { transition: 'fade', ms: 800 });
    },
    draw: function () {
        var C = A.CELL, t = this.t, d = J.d;
        var linhas = ['O Cristal voltou a brilhar.', '', 'As terras de Celer estao em paz.', '',
                      'Jornada: ' + Math.floor(d.tempo / 60) + ' min  -  Quedas: ' + d.mortes,
                      'Cristais: ' + d.cristais, '', 'LENDA DE CELER', 'feito com a CelerGame',
                      '', 'toque para voltar'];
        _vt.px = Math.round(C * 0.45);
        for (var i = 0; i < linhas.length; i++) {
            // sobe do rodape e assenta a partir de 25% da tela
            var y = Math.max(E.H * 0.25 + i * C * 0.8, E.H - t * C * 1.4 + i * C * 0.8);
            _vt.color = i === 7 ? 0xFFE0 : 0xFFFF;
            E.gfx.text(linhas[i], E.W / 2, y, _vt);
        }
        var f = Math.floor(t * 4) % 2;
        A.at('heroi' + A.HEROI.down[f], E.W / 2 - C, E.H * 0.12, 1.4);
        A.at('item' + A.ITEM.cristal5, E.W / 2 + C, E.H * 0.1 + Math.sin(t * 3) * C * 0.2, 1.3);
    }
};

E.run(cenas, 'titulo');
