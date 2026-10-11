// engine.js — COMPATIBILIDADE (1.2.5): a engine monolitica virou a familia
// CelerGame de deps modulares. Este pacote monta a API de sempre — core +
// fx + spr + tilemap no MESMO objeto E — para os apps que fazem
// require("celeros.engine"). Apps novos adotam os modulos um a um:
//
//   var E = require("celeros.game");        // so o core (~20KB enxuto)
//   require("celeros.game.fx");             // + particulas/flash/estrelas
//   require("celeros.game.spr");            // + sprites/flipbook
//   require("celeros.game.tilemap");        // + grade de celulas sujas
//
// A superficie E e identica a da 1.2.4 (os testes do SDK rodam contra
// este shim como gate de paridade). Veja Documentation/Game_Engine_Guide.

var E = require('celeros.game');
require('celeros.game.fx');
require('celeros.game.spr');
require('celeros.game.tilemap');

// versao da COMPATIBILIDADE (o core carrega '1.0.0' em E.version; apps
// que leem E.version continuam vendo a linha 1.2.x)
E.version = '1.2.5';

module.exports = E;
