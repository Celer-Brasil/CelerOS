// app.icons.js — CelerKit ICONS (dep "celeros.app.icons"): shim do modulo
// compartilhado celeros.ui.icons (os 12 icones comuns de apps e jogos +
// dot). A API A.icons nao muda; a tabela agora e uma so com o CelerGame.
// Decora o core:
//
//   var A = require("celeros.app");
//   require("celeros.app.icons");
//   A.icons.draw("wifi", 12, 60, 16, { color: A.T.accent });
//
// 1.1.0: delega ao celeros.ui.icons (fonte unica); antes era uma copia
// dos 12 icones do CelerGame UI.
// 1.0.0: primeira versao.

var A = require('celeros.app');
var I = require('celeros.ui.icons');

A.icons = {
    version: '1.1.0',
    map: I.map,
    draw: I.draw
};

A._mods.push('icons');

module.exports = A;
