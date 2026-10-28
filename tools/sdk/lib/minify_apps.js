#!/usr/bin/env node
// minify_apps.js — minifica o JS dos apps de um stage de imagem de fabrica
// (tools/flash_data.sh) no MESMO formato que o hub publica: jsstrip --min,
// --top para qualquer arquivo != main.js e --reserved com os nomes que os
// irmaos leem sem declarar. `test.js` (dev-only, o publish tambem exclui)
// sai da imagem. Linhas sao preservadas, entao o "line N" do Duktape
// continua igual ao fonte do repo.
//
//   node tools/sdk/lib/minify_apps.js build/littlefs-stage-XXXX
//
// Nasceu do orcamento de blocos da CYD: a imagem de fabrica (768 KB) passou
// a nao caber quando os apps adotaram o CelerKit 2.0; o LittleFS gasta um
// bloco de 4 KB por arquivo, e minificar o JS devolve ~25% deles.
'use strict';

const fs = require('fs');
const path = require('path');
const jsstrip = require('./jsstrip.js');
const jsmin = require('./jsmin.js');

const stage = process.argv[2];
if (!stage) {
    console.error('uso: node minify_apps.js <stage>');
    process.exit(2);
}

const apps = path.join(stage, 'apps');
let n = 0, removed = 0, before = 0, after = 0;
if (!fs.existsSync(apps)) {
    console.log('minify_apps: sem pasta apps no stage');
    process.exit(0);
}

for (const name of fs.readdirSync(apps).sort()) {
    const dir = path.join(apps, name);
    let st;
    try { st = fs.statSync(dir); } catch (e) { continue; }
    if (!st.isDirectory()) continue;

    const files = [];
    for (const f of fs.readdirSync(dir).sort()) {
        if (!/\.js$/.test(f)) continue;
        if (f === 'test.js') {          // dev-only: nao vai para a imagem
            fs.unlinkSync(path.join(dir, f));
            removed++;
            continue;
        }
        files.push(f);
    }

    // nomes lidos sem declarar por QUALQUER irmao: o topo do main.js e o
    // escopo global do app e nao pode renomea-los (mesma regra do publish)
    const reserved = new Set();
    for (const f of files) {
        try {
            const r = jsmin.freeNames(fs.readFileSync(path.join(dir, f)));
            for (const x of r.names) reserved.add(x);
        } catch (e) {
            console.error('aviso: --free-names ' + name + '/' + f + ': ' + e.message);
        }
    }

    for (const f of files) {
        const p = path.join(dir, f);
        const src = fs.readFileSync(p);
        before += src.length;
        let out;
        try {
            out = Buffer.from(jsmin.minify(src, {
                top: f !== 'main.js',
                reserved: reserved,
            }).code, 'utf8');
        } catch (e) {
            console.error('aviso: jsmin falhou em ' + name + '/' + f + ': ' + e.message +
                          ' (usando jsstrip)');
            out = jsstrip.strip(src);
        }
        fs.writeFileSync(p, out);
        after += out.length;
        n++;
    }
}

console.log('factory js: ' + n + ' arquivo(s) minificado(s), test.js removidos: ' + removed +
            ', ' + (before / 1024).toFixed(1) + 'K -> ' + (after / 1024).toFixed(1) + 'K');
