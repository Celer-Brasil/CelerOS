// engine_dts.js — monta o celeros.engine.d.ts (a uniao "tudo-em-um" dos
// apps que fazem require("celeros.engine")) a partir dos d.ts de cada
// modulo da familia: uma fonte de verdade so. Antes o arquivo era uma
// copia mantida a mao e ficava para tras (seq, emissores, sheet...).
//
//   node tools/sdk/lib/engine_dts.js          # regrava o arquivo
//   node tools/sdk/lib/engine_dts.js --check  # exit 1 se o commitado divergiu
//
// O test/sdk confere commitado == gerado (mesmo papel do celer.d.ts).

'use strict';
const fs = require('fs');
const path = require('path');

const ENGINE_DIR = path.join(__dirname, '..', 'engine');
const OUT = path.join(ENGINE_DIR, 'celeros.engine.d.ts');
// ordem = ordem do shim (core, fx, spr, tilemap) + a fisica
const PARTS = ['celeros.game.d.ts', 'celeros.game.fx.d.ts', 'celeros.game.spr.d.ts',
               'celeros.game.tilemap.d.ts', 'celeros.physics.d.ts'];

const HEADER = [
    '// engine.d.ts — tipos do pacote celeros.engine: a familia CelerGame',
    '// MONTADA (core + fx + spr + tilemap) + physics. Apps novos adotam os',
    '// modulos um a um (celeros.game.d.ts + os d.ts dos modulos usados);',
    '// este arquivo e a uniao completa, para quem require("celeros.engine").',
    '//',
    '// GERADO por tools/sdk/lib/engine_dts.js a partir dos d.ts dos modulos —',
    '// nao edite aqui: mude o d.ts do modulo e rode o gerador.',
    ''
];

// corpo do d.ts sem o cabecalho de comentario do topo (cada parte tem o seu)
function body(file) {
    const lines = fs.readFileSync(path.join(ENGINE_DIR, file), 'utf8').split('\n');
    let i = 0;
    while (i < lines.length && (lines[i].startsWith('//') || lines[i].trim() === '')) i++;
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.slice(i);
}

function generate() {
    let out = HEADER.slice();
    PARTS.forEach((f, k) => {
        if (k) out.push('');
        out.push('// ---- ' + f + ' ' + '-'.repeat(Math.max(4, 66 - f.length)));
        out = out.concat(body(f));
    });
    return out.join('\n') + '\n';
}

module.exports = { generate, OUT, PARTS };

if (require.main === module) {
    const fresh = generate();
    if (process.argv.includes('--check')) {
        const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
        if (cur !== fresh) {
            console.log('ERRO: celeros.engine.d.ts com drift — rode node tools/sdk/lib/engine_dts.js');
            process.exit(1);
        }
        console.log('celeros.engine.d.ts em sincronia com os modulos');
    } else {
        fs.writeFileSync(OUT, fresh);
        console.log('gravado ' + path.relative(process.cwd(), OUT));
    }
}
