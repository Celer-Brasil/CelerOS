// arte.js — folhas de sprite da Lenda de Celer e a escala da tela.
//
// As folhas (PNG na RAIZ do app: o pacote do hub e flat) saem de
// _dev/lenda_sprites.py em grade de celulas de 32 px; cada folha ocupa UM
// slot de sprite e cada quadro vira um nome (heroi0, tile7...). A ordem
// dos quadros e o contrato com aquele script (_dev/src/indices.json).
// Sem PNG (harness, emulador sem assets) cada quadro tem um painter
// procedural: o jogo roda igual, so com blocos coloridos.

var E = require('celeros.game');
var S = System;

var A = {};

// celula da sala: 15x13 celulas cabem na tela com HUD em cima (4848:
// 32 px e HUD de 64). K = escala da arte de 32 px
A.setup = function () {
    var cw = Math.floor(E.W / 15), ch = Math.floor((E.H - 40 * E.U) / 13);
    A.CELL = Math.max(12, Math.min(cw, ch));
    A.K = A.CELL / 32;
    A.HUD = E.H - 13 * A.CELL;
    A.OX = Math.floor((E.W - 15 * A.CELL) / 2);
    A.OY = A.HUD;
};

// indices nas folhas (espelham SHEETS do _dev/lenda_sprites.py)
A.HEROI = { down: [0, 1], up: [2, 3], right: [4, 4], left: [5, 5] };
A.ESPADA = { up: 6, right: 7, down: 8, left: 9 };
A.INI = { polvo: [0, 1], morcego: [2, 3], esqueleto: [4, 5], geleia: [6, 7],
          sabio: [8, 8], chama: [9, 10], pedra: [11, 11] };
A.ITEM = { coracao: 0, cristal: 1, cristal5: 2, chave: 3, bomba: 4, bumerangue: 5,
           mapa: 6, bussola: 7, conteiner: 8, espada: 9 };
A.TILE = { grama: 0, areia: 1, agua: 2, agua2: 3, chao: 4, parede: 5, madeira: 6, arvore: 7,
           rocha: 8, arbusto: 9, flores: 10, lapide: 11, estatua: 12, bloco: 13, bau: 14,
           bau_aberto: 15, porta: 16, porta_chave: 17, porta_grade: 18, rachada: 19,
           escada: 20, caverna: 21, tocha: 22 };

// cores do fallback procedural (por folha/quadro)
var COR_TILE = [0x2D06, 0xA44C, 0x1A7F, 0x1B9F, 0x4208, 0x2124, 0x9B26, 0x0300, 0x7BEF,
                0x2C04, 0x5D0A, 0x8410, 0x6B4D, 0x5ACB, 0xA2C0, 0x7180, 0x0000, 0xB580,
                0x630C, 0x3186, 0x18C3, 0x0841, 0xFC00];
var COR_INI = [0xF800, 0xF800, 0x901F, 0x901F, 0xDEFB, 0xDEFB, 0x07E0, 0x07E0, 0xA285,
               0x05FF, 0x05FF, 0x8410];
var COR_ITEM = [0xF800, 0x07E0, 0x041F, 0xFFE0, 0x2124, 0xC300, 0xEF5B, 0xBDF7, 0xFC10, 0xC618];
function painter(cores, forma) {
    return function (name, x, y, k) {
        var i = +String(name).replace(/^[a-z]+/, '');
        var c = cores[i] === undefined ? 0xFFFF : cores[i];
        var s = Math.round(32 * (k || A.K));
        if (forma === 'cheio') S.fillRect(x, y, s, s, c);
        else S.fillCircle(x + (s >> 1), y + (s >> 1), Math.round(s * 0.36), c);
    };
}

A.load = function () {
    E.spr.grid('tile', { file: 'tileset', cols: 8, rows: 3, tw: 32, th: 32, prefix: 'tile',
                         paint: painter(COR_TILE, 'cheio') });
    E.spr.grid('heroi', { file: 'heroi', cols: 10, rows: 1, tw: 32, th: 32, prefix: 'heroi',
                          paint: function (name, x, y, k) {
                              var s = Math.round(32 * (k || A.K)), i = +name.slice(5);
                              if (i >= 6) { S.fillRect(x + s * 0.4, y + s * 0.1, s * 0.2, s * 0.8, 0xC618); return; }
                              S.fillCircle(x + (s >> 1), y + (s >> 1), Math.round(s * 0.4), 0x0451);
                              S.fillCircle(x + (s >> 1), y + Math.round(s * 0.35), Math.round(s * 0.18), 0xFD20);
                          } });
    E.spr.grid('ini', { file: 'inimigos', cols: 12, rows: 1, tw: 32, th: 32, prefix: 'ini',
                        paint: painter(COR_INI) });
    E.spr.grid('item', { file: 'itens', cols: 10, rows: 1, tw: 32, th: 32, prefix: 'item',
                         paint: painter(COR_ITEM) });
    E.spr.grid('chefe', { file: 'chefe', cols: 2, rows: 1, tw: 96, th: 96, prefix: 'chefe',
                          paint: function (name, x, y, k) {
                              var s = Math.round(96 * (k || A.K));
                              S.fillCircle(x + (s >> 1), y + (s >> 1), Math.round(s * 0.42),
                                           name === 'chefe1' ? 0xF800 : 0x7BEF);
                              S.fillCircle(x + (s >> 1), y + (s >> 1), Math.round(s * 0.12), 0x07FF);
                          } });
};

// desenha o quadro `nome` centrado em (cx, cy) de tela na escala da sala
var _o = { scale: 1, cx: true, cy: true, key: 0 };
A.at = function (nome, cx, cy, k) {
    _o.scale = (k || 1) * A.K;
    E.spr.stamp(nome, cx, cy, _o);
};
// tile opaco no canto (x, y) — o paint do mundo (tambem no sprite gravado)
var _ot = { scale: 1, key: null };
A.tile = function (v, x, y) {
    var i = A.TILE[v];
    if (i === undefined) i = A.TILE.chao;
    _ot.scale = A.K;
    E.spr.stamp('tile' + i, x, y, _ot);
};

module.exports = A;
