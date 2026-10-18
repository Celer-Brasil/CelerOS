// game.rpg.js — CelerGame RPG (dep "celeros.game.rpg"): o trio de
// "cerebro de personagem" numa dep so — stats (vida/bonus/XP), inv
// (mochila) e script (roteiros). Existe para o celeros.game.kit caber no
// teto de 8 deps do hub: o kit depende DESTE bundle (que puxa os tres) em
// vez de declarar stats+inv+script soltos e estourar o limite.
//
//   var E = require("celeros.game");
//   require("celeros.game.rpg");   // E.stats, E.inv, E.script

var E = require('celeros.game');
require('celeros.game.stats');
require('celeros.game.inv');
require('celeros.game.script');

E.rpg = { version: '1.0.0' };
E._mods.push('rpg');

module.exports = E;
