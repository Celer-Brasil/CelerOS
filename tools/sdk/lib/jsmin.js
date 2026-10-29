'use strict';
// jsmin.js — minificador ES5 do CelerOS. Faz o que o jsstrip (porte do
// JsStripper do firmware) NAO faz:
//
//   1. renomeia bindings locais (params, var de funcao, catch, nome de
//      funcao interna) para nomes curtos, por frequencia de uso;
//   2. remove TODO espaco que nao separa dois tokens (o jsstrip mantem um
//      espaco onde havia um no fonte: `var x = 0;` -> `var x = 0;` aqui vira
//      `var x=0;`);
//   3. encurta literais numericos quando a forma menor e exata (1000 ->
//      1e3, 0.5 -> .5).
//
// O que NAO faz, de proposito:
//   - nao mexe em nomes de propriedade/membro (`a.b`, `{b:1}`), rotulos,
//     globais nem no escopo de topo por padrao (ver opt.top);
//   - nao remove codigo, nao junta linhas, nao troca `true` por `!0`;
//   - PRESERVA a contagem de linhas (o "line N" do Duktape continua igual ao
//     fonte do repo), inclusive linhas em branco.
//
// Seguranca: a saida tem a MESMA sequencia de tokens da entrada (so os nomes
// mudam); o proprio minificador re-tokeniza a saida e compara antes de
// devolver. Arquivo com `eval`/`with` nao e manglado (so espacamento).
//
// Parser: o acorn vendorado do app_lint (mesmo que valida os apps), ES5.
//
// CLI:
//   node jsmin.js ARQ.js [--no-mangle] [--top] [--stats]

const fs = require('fs');
const path = require('path');
const acorn = require(path.join(__dirname, '..', '..', 'app_lint', 'vendor', 'acorn.js'));

// palavras que nunca podem virar identificador
const RESERVED = new Set([
    'break', 'case', 'catch', 'continue', 'debugger', 'default', 'delete', 'do',
    'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof', 'new',
    'return', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while',
    'with', 'class', 'const', 'enum', 'export', 'extends', 'import', 'super',
    'null', 'true', 'false', 'implements', 'interface', 'let', 'package',
    'private', 'protected', 'public', 'static', 'yield',
    'arguments', 'eval', 'undefined', 'NaN', 'Infinity',
]);

// nomes curtos: a-z A-Z _ $ depois aa.. (base 54)
const FIRST = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
function shortNames() {
    let i = 0;
    return function () {
        let n = i++;
        let s = FIRST[n % 54];
        n = Math.floor(n / 54);
        while (n > 0) {
            n--;
            s += FIRST[n % 54];
            n = Math.floor(n / 54);
        }
        return s;
    };
}

function isIdentChar(c) {
    return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) ||
           c === 0x5f || c === 0x24 || c >= 0x80;
}

function needSpace(prev, next) {
    if (!prev || !next) return false;
    const a = prev.charCodeAt(prev.length - 1);
    const b = next.charCodeAt(0);
    if (isIdentChar(a) && isIdentChar(b)) return true;         // a b / 1 in x
    // numero seguido de '.' (1 .toString()) quebraria com "1.toString"
    if ((a >= 0x30 && a <= 0x39) && b === 0x2e) return true;
    // '+' '+' / '-' '-' viraria ++/--
    if ((a === 0x2b && b === 0x2b) || (a === 0x2d && b === 0x2d)) return true;
    // '/' '/' ou '/' '*' viraria comentario
    if (a === 0x2f && (b === 0x2f || b === 0x2a)) return true;
    return false;
}

// --------------------------------------------------------------- escopos ----

function newScope(parent, isFn, node) {
    return { parent: parent, isFn: !!isFn, node: node || null,
             bindings: new Map(), declared: new Set() };
}

function bind(scope, name, declNode) {
    if (scope.declared) scope.declared.add(name);
    let b = scope.bindings.get(name);
    if (!b) { b = { name: name, scope: scope, uses: 0, decls: [], occ: [] }; scope.bindings.set(name, b); }
    // a DECLARACAO tambem precisa ser renomeada: sem isso o uso vira `a` e
    // a declaracao fica `velocidade` (ReferenceError em todo app)
    if (declNode && declNode.start !== undefined) { b.decls.push(declNode); b.occ.push(declNode); }
    return b;
}

function resolve(scope, name) {
    for (let s = scope; s; s = s.parent) {
        const b = s.bindings.get(name);
        if (b) return b;
    }
    return null;
}

// ES5: `var` e function declaration vivem no escopo da FUNCAO (hoisting).
// Coleta antes de resolver referencias, sem entrar em funcoes aninhadas.
function hoist(node, fnScope) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
        case 'FunctionDeclaration':
            if (node.id) bind(fnScope, node.id.name, node.id);
            return;                       // nao desce no corpo
        case 'FunctionExpression':
            return;
        case 'VariableDeclaration':
            for (const d of node.declarations || []) collectPattern(d.id, fnScope);
            break;
        case 'CatchClause':
            // o parametro do catch tem escopo proprio; mas o BODY pode ter
            // `var` que sobe para a funcao
            hoist(node.body, fnScope);
            return;
        default:
            break;
    }
    for (const k of Object.keys(node)) {
        if (k === 'type' || k === 'start' || k === 'end') continue;
        const v = node[k];
        if (Array.isArray(v)) { for (const c of v) if (c && c.type) hoist(c, fnScope); }
        else if (v && v.type) hoist(v, fnScope);
    }
}

// `var {a} = ...` nao existe em ES5, mas destructuring apareceria se o
// parser fosse mais novo; aceita Identifier e ignora o resto
function collectPattern(node, scope) {
    if (!node) return;
    if (node.type === 'Identifier') { bind(scope, node.name, node); return; }
}

// ------------------------------------------------------------------ mangle --

function analyze(ast) {
    const program = newScope(null, true, ast);
    program.isRoot = true;
    const refs = [];                 // {node, binding|null, name}
    const names = new Set();         // nomes de identificador "visiveis" (nao-propriedade)
    const allScopes = [program];
    let hasEvalOrWith = false;

    function visitFunction(fn, parentScope, isDecl) {
        if (isDecl && fn.id) bind(parentScope, fn.id.name, fn.id);
        const scope = newScope(parentScope, true, fn);
        allScopes.push(scope);
        if (!isDecl && fn.id) bind(scope, fn.id.name, fn.id);
        for (const p of fn.params || []) collectPattern(p, scope);
        hoist(fn.body, scope);
        visit(fn.body, scope);
    }

    function visit(node, scope) {
        if (!node || typeof node.type !== 'string') return;
        switch (node.type) {
            case 'FunctionDeclaration':
                visitFunction(node, scope, true);
                return;
            case 'FunctionExpression':
                visitFunction(node, scope, false);
                return;
            case 'CatchClause': {
                const inner = newScope(scope, false, node);
                allScopes.push(inner);
                if (node.param) collectPattern(node.param, inner);
                visit(node.body, inner);
                return;
            }
            case 'Identifier':
                names.add(node.name);
                refs.push({ node: node, scope: scope, name: node.name });
                return;
            case 'MemberExpression':
                visit(node.object, scope);
                if (node.computed) visit(node.property, scope);   // a[0] / a[k]
                return;
            case 'Property':
                if (node.computed) { visit(node.key, scope); }
                visit(node.value, scope);
                return;
            case 'VariableDeclarator':
                // o id ja foi ligado no hoist
                visit(node.init, scope);
                return;
            case 'LabeledStatement':
                visit(node.body, scope);
                return;
            case 'BreakStatement':
            case 'ContinueStatement':
                return;
            case 'WithStatement':
                hasEvalOrWith = true;
                visit(node.object, scope);
                visit(node.body, scope);
                return;
            case 'CallExpression':
                if (node.callee && node.callee.type === 'Identifier' && node.callee.name === 'eval') {
                    hasEvalOrWith = true;
                }
                break;
            default:
                break;
        }
        for (const k of Object.keys(node)) {
            if (k === 'type' || k === 'start' || k === 'end') continue;
            const v = node[k];
            if (Array.isArray(v)) { for (const c of v) if (c && c.type) visit(c, scope); }
            else if (v && v.type) visit(v, scope);
        }
    }

    hoist(ast, program);
    visit(ast, program);

    // resolve cada referencia; conta usos para ordenar os nomes curtos
    const declared = new Set();
    for (const scope of allScopes) for (const n of scope.declared) declared.add(n);
    const used = new Set();
    for (const r of refs) {
        const b = resolve(r.scope, r.name);
        r.binding = b;
        if (b) { b.uses++; b.occ.push(r.node); used.add(b); }
    }
    return { program: program, refs: refs, names: names, declared: declared,
             hasEvalOrWith: hasEvalOrWith, bindings: used };
}

// mapa token.start -> nome novo
function renameMap(analysis, opts) {
    const top = opts.top === 'yes' || opts.top === true;
    const reserved = opts.reserved instanceof Set ? opts.reserved
        : new Set(opts.reserved || []);
    const map = new Map();
    if (!opts.mangle || analysis.hasEvalOrWith) return map;

    // nomes ja ocupados: todo identificador que nao e propriedade/rotulo,
    // mais as palavras reservadas. Nomes gerados nunca colidem com nada do
    // arquivo — nem com globais referenciados (que sao exatamente os nomes
    // de referencias sem binding).
    const taken = new Set(RESERVED);
    for (const n of analysis.names) taken.add(n);
    // TODA declaracao entra no conjunto, inclusive var nunca lido: `var W=240,
    // H=320` sem uso de H deixava "H" livre e o gerador batizava outra funcao
    // de H -> "H is not a function" (Snake). Tokens nao pegam isso: e semantico.
    for (const n of analysis.declared) taken.add(n);

    const list = [];
    for (const b of analysis.bindings) {
        if (b.scope.isRoot && !top) continue;
        if (RESERVED.has(b.name)) continue;
        if (reserved.has(b.name)) continue;      // outro arquivo le esse global
        if (b.uses === 0) continue;                 // declarado e nao usado: nao gasta nome
        list.push(b);
    }
    // mais usado primeiro -> nome mais curto
    list.sort((a, b) => (b.uses - a.uses) || (a.name < b.name ? -1 : 1));

    const nextName = shortNames();
    for (const b of list) {
        let n = nextName();
        while (taken.has(n)) n = nextName();
        // nome curto ja curto: nao vale renomear (e `aa` e MAIOR que `x`);
        // nao marca como tomado para o proximo binding poder usa-lo
        if (n.length >= b.name.length) continue;
        taken.add(n);
        for (const node of b.occ) map.set(node.start, n);
    }
    return map;
}

// ------------------------------------------------------------- literais -----

function shortNumber(text) {
    const orig = text;
    let best = orig;
    const v = Number(orig);
    if (!isFinite(v)) return best;
    // octal legado (sloppy): Number() le decimal — 010 era 8 e viraria 10
    if (/^0[0-7]+$/.test(orig)) return best;
    // formas candidatas: inteiro curto, expoente, e sem o zero da esquerda
    const cands = [];
    if (Number.isInteger(v) && Math.abs(v) < 1e21) {
        cands.push(String(v));
        // 1000 -> 1e3 ; 1000000 -> 1e6
        for (let e = 3; e <= 20; e++) {
            const m = v / Math.pow(10, e);
            if (Number.isInteger(m) && String(m).length + 2 + String(e).length < best.length) {
                cands.push(m + 'e' + e);
            }
        }
    } else if (/^0\.\d+$/.test(orig)) {
        cands.push(orig.slice(1));                  // 0.5 -> .5
        // 0.0001 -> 1e-4
        const mm = /^0\.(0+)(\d+)$/.exec(orig);
        if (mm) cands.push(mm[2] + 'e-' + (mm[1].length + mm[2].length));
    }
    for (const c of cands) {
        if (c.length < best.length && Number(c) === v && !/[^0-9a-eE+.\-]/.test(c)) best = c;
    }
    return best;
}

// ---------------------------------------------------------------- emissor ---

function emit(src, tokens, rename, opts) {
    let out = '';
    let prev = null;
    let prevEnd = 0;
    for (const t of tokens) {
        let nl = 0;
        for (let i = prevEnd; i < t.start; i++) {
            if (src.charCodeAt(i) === 0x0a) nl++;
        }
        let text;
        if (rename.has(t.start)) text = rename.get(t.start);
        else if (t.type && t.type.label === 'num') text = shortNumber(src.slice(t.start, t.end));
        else text = src.slice(t.start, t.end);

        if (prev !== null) {
            if (opts.keepLines && nl > 0) out += nl === 1 ? '\n' : new Array(nl + 1).join('\n');
            else if (needSpace(prev, text)) out += ' ';
        } else if (opts.keepLines && nl > 0) {
            out += new Array(nl + 1).join('\n');
        }
        out += text;
        prev = text;
        prevEnd = t.end;
    }
    if (opts.keepLines) {
        // linhas em branco no fim: mantem a contagem (o device conta linhas)
        let tail = 0;
        for (let i = prevEnd; i < src.length; i++) if (src.charCodeAt(i) === 0x0a) tail++;
        if (tail) out += new Array(tail + 1).join('\n');
    }
    return out;
}

// mesma sequencia de tokens = nao fundiu/separou nada
function sameTokens(src, out) {
    const a = [];
    const b = [];
    try {
        acorn.parse(src, { ecmaVersion: 5, onToken: a });
        acorn.parse(out, { ecmaVersion: 5, onToken: b });
    } catch (e) {
        return { ok: false, why: 'parse da saida falhou: ' + e.message };
    }
    if (a.length !== b.length) return { ok: false, why: 'tokens ' + a.length + ' -> ' + b.length };
    for (let i = 0; i < a.length; i++) {
        const la = a[i].type && a[i].type.label;
        const lb = b[i].type && b[i].type.label;
        if (la !== lb) return { ok: false, why: 'token ' + i + ': ' + la + ' -> ' + lb };
    }
    return { ok: true };
}

// nomes que o arquivo usa SEM declarar (resolvem no escopo global). Serve
// para o main.js de um app saber quais globais os irmaos (modulos do pacote)
// leem: esses nao podem ser renomeados no topo do programa.
function freeNames(src) {
    const code = Buffer.isBuffer(src) ? src.toString('utf8') : String(src);
    const tokens = [];
    let ast;
    try { ast = acorn.parse(code, { ecmaVersion: 5, onToken: tokens }); }
    catch (e) {
        const err = new Error('jsmin: fonte invalida: ' + e.message);
        err.code = 'min.parse';
        throw err;
    }
    const analysis = analyze(ast);
    const names = new Set();
    for (const r of analysis.refs) if (!r.binding) names.add(r.name);
    return { names: names, hasEvalOrWith: analysis.hasEvalOrWith };
}

function minify(src, opts) {
    opts = Object.assign({ keepLines: true, mangle: true, top: 'no', verify: true }, opts || {});
    if (!opts.keepLines) {
        // sem as quebras nao da para preservar ASI (`return\n x`): juntar
        // linhas mudaria semantica e a verificacao de tokens NAO pegaria
        const err = new Error('jsmin: keepLines=false nao e suportado (ASI)');
        err.code = 'min.lines';
        throw err;
    }
    const code = Buffer.isBuffer(src) ? src.toString('utf8') : String(src);
    const tokens = [];
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: 5, onToken: tokens });
    } catch (e) {
        const err = new Error('jsmin: fonte invalida: ' + e.message);
        err.code = 'min.parse';
        throw err;
    }
    const analysis = analyze(ast);
    const rename = renameMap(analysis, opts);
    const out = emit(code, tokens, rename, opts);
    if (opts.verify) {
        const v = sameTokens(code, out);
        if (!v.ok) {
            const err = new Error('jsmin: verificacao falhou (' + v.why + ')');
            err.code = 'min.verify';
            throw err;
        }
    }
    return {
        code: out,
        stats: {
            orig: Buffer.byteLength(code, 'utf8'),
            min: Buffer.byteLength(out, 'utf8'),
            renamed: rename.size,
            evalOrWith: analysis.hasEvalOrWith,
        },
    };
}

module.exports = { minify, freeNames, shortNumber, needSpace, analyze, renameMap, sameTokens, RESERVED };

if (require.main === module) {
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith('--'));
    if (!file) {
        console.error('uso: node jsmin.js ARQ.js [--no-mangle] [--top] [--stats]');
        process.exit(2);
    }
    const opts = {
        mangle: args.indexOf('--no-mangle') < 0,
        top: args.indexOf('--top') >= 0 ? 'yes' : 'no',
    };
    const r = minify(fs.readFileSync(file), opts);
    if (args.indexOf('--stats') >= 0) {
        console.error(JSON.stringify(r.stats));
    }
    process.stdout.write(r.code);
}
