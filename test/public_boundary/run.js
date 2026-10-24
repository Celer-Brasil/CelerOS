#!/usr/bin/env node
// Guarda de fronteira publico/privado do CelerOS.
//
// O repo e publico (GPL-3.0); verticais fechadas (ex.: o CelerPark) vivem em
// repositorios privados e entram na imagem por CELEROS_PRIVATE_DATA. Este
// teste falha se qualquer termo da vertical reaparecer em arquivo versionado.
//
// Uso: node test/public_boundary/run.js
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SELF = path.relative(ROOT, __filename);

// Termos que nunca podem voltar ao repo publico.
const FORBIDDEN = [
    'celerpark',
    'parking-gate',
    'parking_lanes',
    'parking_tickets',
    'parking_gate_commands',
    'celeros.park.',
    'celeros.park',
];

function trackedFiles() {
    const out = execFileSync('git', ['ls-files', '-z'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\0').filter(Boolean);
}

const files = trackedFiles();
let hits = 0;

for (const rel of files) {
    if (rel === SELF) continue;  // a lista de termos mora aqui
    const abs = path.join(ROOT, rel);
    let text;
    try {
        text = fs.readFileSync(abs, 'utf8');
    } catch {
        continue;  // binario/ilegivel
    }
    const lower = text.toLowerCase();
    for (const term of FORBIDDEN) {
        let at = lower.indexOf(term);
        while (at !== -1) {
            const line = text.slice(0, at).split('\n').length;
            console.log(`${rel}:${line}: termo privado "${term}"`);
            hits++;
            at = lower.indexOf(term, at + term.length);
        }
    }
}

if (hits) {
    console.log(`\nFALHAS: ${hits} ocorrencia(s) de conteudo privado no repo publico.`);
    process.exit(1);
}
console.log(`OK: fronteira publica limpa (${files.length} arquivos).`);
