// game.kit.js — CelerGame KIT (dep "celeros.game.kit"): a caixa de
// ferramentas de jogo complexo NUMA dep so. O app.json aceita no maximo 8
// deps, e uma aventura usa uma dezena de modulos; o kit carrega a
// familia de "cerebro" (sem desenho) e pendura a biblioteca de sons:
//
//   var E = require("celeros.game");
//   require("celeros.game.kit");   // fsm, events, path, steer, stats, inv,
//                                  // script, collide, level + E.sfx
//
// Desenho/entrada continuam deps proprias (fx, spr, tilemap, ui, pad) —
// cada jogo escolhe a apresentacao. Custo: cada modulo compila no heap do
// app (placas com PSRAM; some ~30 KB enxutos).

var E = require('celeros.game');
require('celeros.game.collide');
require('celeros.game.level');
require('celeros.game.fsm');
require('celeros.game.events');
require('celeros.game.path');
require('celeros.game.steer');
require('celeros.game.stats');
require('celeros.game.inv');
require('celeros.game.script');
// biblioteca de sons chiptune (puro dado): E.sfx.via(E.audio, "espada")
E.sfx = require('celeros.sfx');

E.kit = { version: '1.0.0' };
E._mods.push('kit');

module.exports = E;
