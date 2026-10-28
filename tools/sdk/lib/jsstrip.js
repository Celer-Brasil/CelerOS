'use strict';
// jsstrip.js — porte 1:1 do JsStripper do firmware (main/Utils/JsStrip.h):
// remove comentarios, indentacao e espacos repetidos/finais, PRESERVANDO
// todas as quebras de linha (o "line N" do Duktape continua batendo com o
// fonte). Opera em bytes (Buffer) para dar exatamente a saida do C++.
//
// Uso: o `celerhub publish-dep` sobe a dep ja enxuta (o hub mede o .js
// recebido no teto de compile; o aparelho enxuga do mesmo jeito antes de
// compilar, entao o tamanho medido passa a ser o custo REAL em RAM) e o
// test/sdk confere o teto das deps com ele.
//
//   node tools/sdk/lib/jsstrip.js ARQ.js > ARQ.min.js

const KW = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'new', 'void',
                    'delete', 'throw', 'instanceof']);
const S_CODE = 0, S_STR = 1, S_LINE = 2, S_BLOCK = 3, S_REGEX = 4;

function isIdent(c) {
    return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) ||
           c === 0x5f || c === 0x24 || c >= 0x80;
}

function strip(input) {
    const src = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
    const out = Buffer.alloc(src.length + 1);
    let n = 0;
    let s = S_CODE, quote = 0, esc = false, star = false, blockNl = false, reClass = false;
    let slash = false, lineStart = true, space = false, last = 0;
    let word = '', wlen = 0;   // wlen -1: palavra longa demais (nao e keyword)

    function emit(c) { out[n++] = c; }
    function endWord() {
        if (wlen === 0) return;
        last = 0x61;   // 'a'
        if (wlen > 0 && KW.has(word)) last = 0x6b;   // 'k'
        wlen = 0;
        word = '';
    }
    function regexAllowed() {
        if (last === 0 || last === 0x6b) return true;
        if (last === 0x61 || last === 0x29 || last === 0x5d) return false;
        return true;
    }
    function code(c) {
        if (space && !lineStart) emit(0x20);
        space = false;
        lineStart = false;
        emit(c);
    }
    function newline() {
        space = false;
        lineStart = true;
        emit(0x0a);
    }
    function step(c) {
        switch (s) {
            case S_STR:
                emit(c);
                if (esc) esc = false;
                else if (c === 0x5c) esc = true;
                else if (c === quote) { s = S_CODE; last = 0x61; }
                else if (c === 0x0a) { s = S_CODE; lineStart = true; }
                return;
            case S_LINE:
                if (c === 0x0a) { s = S_CODE; newline(); }
                return;
            case S_BLOCK:
                if (c === 0x0a) { newline(); blockNl = true; }
                else if (star && c === 0x2f) {
                    s = S_CODE;
                    if (!blockNl) space = true;
                    return;
                }
                star = c === 0x2a;
                return;
            case S_REGEX:
                emit(c);
                if (esc) esc = false;
                else if (c === 0x5c) esc = true;
                else if (c === 0x5b) reClass = true;
                else if (c === 0x5d) reClass = false;
                else if (c === 0x2f && !reClass) { s = S_CODE; last = 0x61; }
                else if (c === 0x0a) { s = S_CODE; lineStart = true; }
                return;
        }
        if (slash) {
            slash = false;
            if (c === 0x2f) { endWord(); s = S_LINE; return; }
            if (c === 0x2a) { endWord(); s = S_BLOCK; star = false; blockNl = false; return; }
            endWord();
            const re = regexAllowed();
            code(0x2f);
            if (re) {
                s = S_REGEX;
                esc = false;
                reClass = false;
                step(c);
                return;
            }
            last = 0x2f;
        }
        if (isIdent(c)) {
            if (wlen >= 0) {
                if (wlen < 11) { word += String.fromCharCode(c); wlen++; }
                else { wlen = -1; word = ''; }
            }
            code(c);
            return;
        }
        if (wlen !== 0) {
            if (wlen < 0) { wlen = 0; last = 0x61; }
            else endWord();
        }
        switch (c) {
            case 0x20: case 0x09: case 0x0d:
                if (!lineStart) space = true;
                return;
            case 0x0a:
                newline();
                return;
            case 0x2f:
                slash = true;
                return;
            case 0x22: case 0x27:
                code(c);
                s = S_STR;
                quote = c;
                esc = false;
                return;
            default:
                code(c);
                last = c;
        }
    }
    for (let i = 0; i < src.length; i++) step(src[i]);
    endWord();
    if (slash) { slash = false; code(0x2f); }
    return out.subarray(0, n);
}

module.exports = { strip };

// CLI. O modo historico (sem flags) e o porte 1:1 do firmware; `--min` usa o
// jsmin (mangle de locais + espacamento minimo, linhas preservadas):
//
//   node jsstrip.js ARQ.js                     # so comentarios/indentacao
//   node jsstrip.js ARQ.js --min               # minificado (topo intacto)
//   node jsstrip.js mod.js --min --top         # modulo (o loader envolve em
//                                              # function(module,exports,require):
//                                              # o topo e local, pode manglar)
//   node jsstrip.js main.js --min --reserved a,b   # nao renomeia a/b no topo
//   node jsstrip.js --free-names a.js b.js     # JSON: nomes lidos sem declarar
if (require.main === module) {
    const args = process.argv.slice(2);
    const flags = {};
    const files = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!a.startsWith('--')) { files.push(a); continue; }
        const k = a.slice(2);
        if (k === 'min' || k === 'top' || k === 'stats' || k === 'free-names') { flags[k] = true; continue; }
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) { flags[k] = next; i++; }
        else flags[k] = true;
    }
    const fs = require('fs');
    const J = require('./jsmin');

    if (flags['free-names']) {
        if (!files.length) {
            console.error('uso: node jsstrip.js --free-names ARQ.js [...]');
            process.exit(2);
        }
        const all = new Set();
        for (const f of files) {
            try {
                const fn = J.freeNames(fs.readFileSync(f));
                for (const n of fn.names) all.add(n);
            } catch (e) {
                // arquivo ilegivel/sintaxe quebrada: o app_lint acusa depois;
                // aqui nao bloqueia o publish por causa de um irmao invalido
                console.error('aviso: --free-names ' + f + ': ' + e.message);
            }
        }
        process.stdout.write(JSON.stringify(Array.from(all).sort()));
        process.exit(0);
    }

    const file = files[0];
    if (!file) {
        console.error('uso: node jsstrip.js ARQ.js [--min] [--top] [--reserved a,b] [--stats]');
        process.exit(2);
    }
    const src = fs.readFileSync(file);
    if (!flags.min) {
        const out = strip(src);
        if (flags.stats) console.error(JSON.stringify({ orig: src.length, min: out.length }));
        process.stdout.write(out);
        process.exit(0);
    }
    const reserved = typeof flags.reserved === 'string'
        ? flags.reserved.split(',').map((s) => s.trim()).filter(Boolean) : [];
    let r;
    try {
        r = J.minify(src, { top: !!flags.top, reserved: reserved });
    } catch (e) {
        // minificador recusou (sintaxe exotica): cai no strip, que e o que o
        // aparelho faria de qualquer forma — avisa no stderr para o log
        console.error('aviso: jsmin falhou em ' + file + ': ' + e.message + ' (usando jsstrip)');
        const out = strip(src);
        if (flags.stats) console.error(JSON.stringify({ orig: src.length, min: out.length, fallback: true }));
        process.stdout.write(out);
        process.exit(0);
    }
    if (flags.stats) console.error(JSON.stringify(r.stats));
    process.stdout.write(r.code);
}
