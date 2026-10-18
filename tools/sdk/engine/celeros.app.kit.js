// app.kit.js — CelerKit KIT (dep "celeros.app.kit"): o pacote das deps
// comuns num unico nome no app.json (o teto do hub e de 8 deps por app;
// o fecho transitivo aguenta 32). Existe pelo mesmo motivo do
// celeros.game.kit: apps que usam metade da familia nao devem gastar as
// 8 vagas listando modulo por modulo.
//
//   "deps": { "celeros.app.kit": "^1.0.0", "celeros.app.ai": "^1.0.0" }
//
// Fecho: core + fmt + path + data + net + text + form + list + caps.
// Nao inclui chat/input/launch/updater/fsx/svc/mesh/ai/history/events/
// semver — os apps que usam, declaram a parte.

var A = require('celeros.app');
require('celeros.app.fmt');
require('celeros.app.path');
require('celeros.app.data');
require('celeros.app.net');
require('celeros.app.text');
require('celeros.app.form');
require('celeros.app.list');
require('celeros.app.caps');

A.kit = { version: '1.0.0' };

A._mods.push('kit');

module.exports = A;
