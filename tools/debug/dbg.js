#!/usr/bin/env node
// Cliente do Duktape debugger para o CelerOS: conecta no proxy TCP do
// `celerctl debug` e fala o protocolo dmsg (tools/debug/dmsg.js) num REPL.
// Zero dependencias (Node puro, como o resto do repo).
//
//   python3 tools/celerctl.py debug MeuApp   # abre proxy + este REPL juntos
//   python3 tools/celerctl.py debug MeuApp --serve  +  node tools/debug/dbg.js
//
// O app PAUSA na primeira linha ao attachar: ponha os breakpoints e `c`.
// Erro nao capturado tambem pausa (no ponto do throw). `h` lista os comandos.
//
// Opcoes: --port P (proxy, default 9092), --log-port P (logs do device,
// default port+1), --host H, --file /local/apps/X/main.js (arquivo dos
// breakpoints antes da 1a pausa), --src <pasta|arquivo> (fonte local para
// `l`; sem ela procura o app em data/apps, hub_apps e boards/*/data/apps).
'use strict';

var net = require('net');
var fs = require('fs');
var path = require('path');
var readline = require('readline');
var D = require('./dmsg');

// ---- opcoes -----------------------------------------------------------------
var OPT = { host: process.env.DBG_HOST || '127.0.0.1', port: process.env.DBG_PORT || '9092',
            'log-port': '', file: process.env.DBG_FILE || '', src: '' };
(function parseArgs(argv) {
    for (var i = 0; i < argv.length; i++) {
        var m = /^--(host|port|log-port|file|src)(?:=(.*))?$/.exec(argv[i]);
        if (!m) {
            console.error('uso: dbg.js [--host H] [--port P] [--log-port P] [--file /local/apps/X/main.js] [--src pasta]');
            process.exit(2);
        }
        OPT[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
    }
})(process.argv.slice(2));
var PORT = parseInt(OPT.port, 10);
var LOG_PORT = OPT['log-port'] ? parseInt(OPT['log-port'], 10) : PORT + 1;
var REPO = path.resolve(__dirname, '..', '..');
var TTY = !!process.stdin.isTTY;

// ---- saida ------------------------------------------------------------------
var COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
function paint(code, s) { return COLOR ? '\x1b[' + code + 'm' + s + '\x1b[0m' : s; }
var C = {
    pause: function (s) { return paint('1;33', s); },
    err: function (s) { return paint('31', s); },
    dim: function (s) { return paint('2', s); },
    ok: function (s) { return paint('32', s); },
    cur: function (s) { return paint('1', s); }
};
var rl = null;
var rlClosed = false;
function out(s) {
    if (TTY && process.stdout.isTTY) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
    }
    console.log(s);
    prompt();
}
function prompt() { if (rl && !rlClosed && TTY && ready()) rl.prompt(true); }

// ---- renderizacao de valores --------------------------------------------------
// DUK_HOBJECT_CLASS_*
var CLASSES = ['none', 'Object', 'Array', 'Function', 'Arguments', 'Boolean', 'Date', 'Error',
               'JSON', 'Math', 'Number', 'RegExp', 'String', 'global', 'Symbol', 'ObjEnv',
               'DecEnv', 'Pointer', 'Thread', 'ArrayBuffer', 'DataView'];
var PRE = '\u0001';  // prefixo do valor ja formatado no device (ver prettyExpr)
function render(dv) {
    if (!dv) return '?';
    switch (dv.t) {
        case 'int': case 'num': case 'bool': return String(dv.v);
        case 'str': return dv.v.charAt(0) === PRE ? dv.v.slice(1) : JSON.stringify(dv.v);
        case 'obj': return '[object ' + (CLASSES[dv.v] || 'class ' + dv.v) + ']';
        case 'undefined': case 'null': return dv.t;
        case 'unused': return '<unused>';
        default: return '<' + dv.t + (dv.v !== undefined ? ' ' + dv.v : '') + '>';
    }
}
function plain(dv) { return dv && dv.v !== undefined ? dv.v : render(dv); }
// Objetos chegam como ponteiro: reavaliar dentro de uma funcao que serializa
// NO DEVICE (JSON, truncado) devolve o conteudo em uma ida. A expressao vai
// como argumento: avaliada no escopo do frame (eval direto), uma vez so.
// ES5 puro (Duktape).
var PRETTY_MAX = 600;
function prettyExpr(expr) {
    return '(function(v){var t=typeof v;' +
        'if(v===null||(t!=="object"&&t!=="function"))return v;' +
        'if(t==="function")return "' + PRE + '[function "+(v.name||"anonima")+"]";' +
        'var s;try{s=JSON.stringify(v);}catch(e){s=String(v);}' +
        'if(s===undefined)s=String(v);' +
        'if(s.length>' + PRETTY_MAX + ')s=s.slice(0,' + PRETTY_MAX + ')+"...";' +
        'return "' + PRE + '"+s;})((' + expr + '\n))';
}

// ---- fonte local ------------------------------------------------------------
var srcCache = {};
function localSource(devFile) {
    if (!devFile) return null;
    if (srcCache[devFile] !== undefined) return srcCache[devFile];
    var base = path.basename(devFile);
    var m = /\/apps\/([^/]+)\//.exec(devFile);
    var cands = [];
    if (OPT.src) {
        var isDir = false;
        try { isDir = fs.statSync(OPT.src).isDirectory(); } catch (e) { /* trata como arquivo */ }
        cands.push(isDir ? path.join(OPT.src, base) : OPT.src);
    }
    if (m) {
        cands.push(path.join(REPO, 'data/apps', m[1], base), path.join(REPO, 'hub_apps', m[1], base));
        try {
            fs.readdirSync(path.join(REPO, 'boards')).forEach(function (b) {
                cands.push(path.join(REPO, 'boards', b, 'data/apps', m[1], base));
            });
        } catch (e) { /* sem boards/ */ }
    }
    var lines = null;
    for (var i = 0; i < cands.length && !lines; i++) {
        try { lines = fs.readFileSync(cands[i], 'utf8').split('\n'); } catch (e) { /* proximo */ }
    }
    srcCache[devFile] = lines;
    return lines;
}
function sourceLines(file, line, ctx) {
    var lines = localSource(file);
    if (!lines || !line) return null;
    var from = Math.max(1, line - ctx), to = Math.min(lines.length, line + ctx), res = [];
    for (var i = from; i <= to; i++) {
        var txt = ('    ' + i).slice(-4) + '  ' + lines[i - 1];
        res.push(i === line ? C.cur('=> ' + txt) : '   ' + txt);
    }
    return res.join('\n');
}
// linha sem codigo executavel: breakpoint ali nunca dispara
function looksEmpty(file, line) {
    var lines = localSource(file);
    if (!lines || line < 1 || line > lines.length) return false;
    var t = lines[line - 1].trim();
    return t === '' || /^\/\//.test(t) || /^\/?\*/.test(t) || /^[{}\])]*;?$/.test(t);
}

// ---- estado -----------------------------------------------------------------
var S = {
    handshaked: false, sessions: 0,
    awaitingFirst: false,  // attach feito, Status da pausa inicial a caminho
    deciding: false,       // pausa chegou e o cliente decide (condicao/temp/exit)
    paused: false,
    file: OPT.file, func: '', line: 0, level: -1,
    lastAction: 'attach', exitPending: false, lastThrow: null
};
var bps = [];       // espelho da lista do Duktape (mesma ordem): {file, line, cond, hits, temp}
var watches = [];   // expressoes avaliadas a cada pausa
var pendingRpc = [];  // um resolver por request (o alvo responde em ordem)
var throwsVisible = true;

function ready() { return S.handshaked && !S.awaitingFirst && !S.deciding; }

// ---- conexao ----------------------------------------------------------------
var stream = new D.Stream();
var sock = net.connect(PORT, OPT.host, function () {
    // handshake UNILATERAL: o alvo manda a linha de versao no attach e o
    // cliente nao escreve nada antes dela (byte extra vira initial byte
    // invalido no Duktape e a sessao cai com Detaching 1)
    out(C.dim('dbg: conectado em ' + OPT.host + ':' + PORT + ' — aguardando o app attachar...'));
});
sock.on('error', function (e) {
    console.error('dbg: conexao falhou (' + e.message + ') — o celerctl debug esta no ar?');
    process.exit(1);
});
sock.on('close', function () {
    out(C.dim('dbg: conexao com o proxy encerrada'));
    process.exit(0);
});
sock.on('data', function (chunk) {
    stream.feed(chunk).forEach(function (ev) {
        if (ev.error) {
            out(C.err('dbg: ' + ev.error + ' — encerrando'));
            sock.destroy();
        } else if (ev.hello) {
            onHello(ev.hello);
        } else {
            onMessage(ev.msg);
        }
    });
});

// Porta lateral do proxy: logs do device (linhas) e o canal de controle do
// `r` (pedido "sync <pasta>"; a resposta vem numa linha com prefixo \x01).
// Opcional: sem ela o REPL funciona, so sem logs e sem sync.
var side = { sock: null, ok: false, waiter: null };
(function connectSide() {
    var ls = net.connect(LOG_PORT, OPT.host, function () { side.ok = true; });
    side.sock = ls;
    var acc = '';
    ls.on('data', function (d) {
        acc += d.toString('utf8');
        var parts = acc.split('\n');
        acc = parts.pop();
        parts.forEach(function (l) {
            l = l.replace(/\r$/, '');
            if (l.charAt(0) === '\x01') {
                var w = side.waiter;
                side.waiter = null;
                if (w) w(l.slice(1));
            } else if (l) {
                out(C.dim('| ' + l));
            }
        });
    });
    ls.on('error', function () { side.ok = false; });
    ls.on('close', function () { side.ok = false; });
})();

// sincroniza o fonte local com o device (o proxy linta e empurra o que mudou)
function syncSource(devDir) {
    return new Promise(function (resolve) {
        if (!side.ok) return resolve('skip proxy sem canal lateral');
        var t = setTimeout(function () { side.waiter = null; resolve('erro sync sem resposta em 60s'); }, 60000);
        side.waiter = function (line) { clearTimeout(t); resolve(line.replace(/^sync /, '')); };
        side.sock.write('sync ' + devDir + '\n');
    });
}

function onHello(line) {
    S.handshaked = true;
    S.sessions++;
    S.awaitingFirst = true;
    S.paused = false;
    S.lastAction = 'attach';
    S.exitPending = false;
    S.level = -1;
    // "2 <DUK_VERSION> <git describe> <target info>"
    var f = line.split(' ');
    var v = parseInt(f[1], 10) || 0;
    out(C.dim('dbg: attachado — Duktape ' + Math.floor(v / 10000) + '.' + Math.floor(v / 100) % 100 + '.' + v % 100 +
              (f.length > 3 ? ' (' + f.slice(3).join(' ') + ')' : '') +
              (S.sessions > 1 ? ' — sessao ' + S.sessions : '')));
    // o attach sempre pausa; se o Status nao vier (alvo estranho), libera
    var sess = S.sessions;
    setTimeout(function () {
        if (S.sessions === sess && S.awaitingFirst) { S.awaitingFirst = false; prompt(); }
    }, 3000);
}

function onMessage(msg) {
    var head = msg.shift();
    if (!head) return;
    if (head.t === 'nfy') return onNotify(msg.length ? msg.shift().v : -1, msg);
    if (head.t === 'rep' || head.t === 'err') {
        var resolve = pendingRpc.shift();
        if (!resolve) return;
        if (head.t === 'rep') return resolve({ ok: true, v: msg });
        return resolve({ ok: false, code: msg.length ? msg[0].v : 0, msg: msg.length > 1 ? plain(msg[1]) : '' });
    }
    // REQ do alvo (AppRequest reverso): nao suportado
    sock.write(D.message(D.IB.ERR, null, [D.int(D.ERR.UNSUPPORTED), D.str('cliente nao atende requests')]));
}

function rpc(cmd, args) {
    return new Promise(function (resolve) {
        if (!S.handshaked) return resolve({ ok: false, detached: true, msg: 'sem app attachado' });
        pendingRpc.push(resolve);
        sock.write(D.request(cmd, args));
    });
}

var ERRS = ['desconhecido', 'nao suportado', 'demais', 'nao encontrado', 'aplicacao'];
function errText(r) {
    return r.detached ? r.msg : 'erro (' + (ERRS[r.code] || r.code) + '): ' + r.msg;
}

// ---- notificacoes -----------------------------------------------------------
function onNotify(cmd, a) {
    if (cmd === D.CMD.STATUS) {
        // NFY STATUS <pausado> <arquivo> <funcao> <linha> <pc>
        var paused = a.length > 0 && a[0].v === 1;
        var loc = {
            file: a[1] && a[1].t === 'str' ? a[1].v : '',
            func: a[2] && a[2].t === 'str' ? a[2].v : '',
            line: a[3] ? a[3].v : 0
        };
        if (paused && !S.paused && !S.deciding) {
            onPaused(loc);
        } else if (paused) {
            S.func = loc.func;
            S.line = loc.line;
            if (loc.file) S.file = loc.file;
        } else if (!S.deciding) {
            if (S.paused) out(C.dim('[rodando]'));
            S.paused = false;
        }
    } else if (cmd === D.CMD.THROW) {
        // NFY THROW <fatal> <msg> <arquivo> <linha>
        var fatal = !!(a[0] && a[0].v);
        var text = plain(a[1]);
        var where = a[2] && a[2].t === 'str' ? a[2].v + ':' + plain(a[3]) : '';
        // a saida do app (X da topbar, System.exitApp, celerctl exit) e um
        // throw interno do runtime: sem pausa para inspecao, retoma sozinho
        if (text === 'Error: app exit') {
            S.exitPending = fatal;
            return out(C.dim('[app encerrando]'));
        }
        S.lastThrow = fatal ? { text: text, where: where } : null;
        if (!fatal && !throwsVisible) return;
        out(fatal ? C.err('[erro nao capturado] ' + text + (where ? '  em ' + where : ''))
                  : C.dim('[throw capturado] ' + text + (where ? '  em ' + where : '')));
    } else if (cmd === D.CMD.DETACHING) {
        var reason = a.length ? a[0].v : 0;
        S.handshaked = false;
        S.paused = S.deciding = S.awaitingFirst = false;
        pendingRpc.splice(0).forEach(function (r) { r({ ok: false, detached: true, msg: 'app saiu' }); });
        out(C.dim('[detach] ' + (reason === 0 ? 'app saiu' : 'erro de transporte/protocolo') +
                  (a.length > 1 ? ': ' + plain(a[1]) : '') + ' — aguardando o proximo app'));
    } else if (cmd === D.CMD.APPNOTIFY) {
        out('[app] ' + a.map(render).join(' '));
    } else {
        out(C.dim('[notify 0x' + Number(cmd).toString(16) + '] ' + a.map(render).join(' ')));
    }
}

function findBp(file, line) {
    for (var i = 0; i < bps.length; i++) if (bps[i].file === file && bps[i].line === line) return i;
    return -1;
}

async function onPaused(loc) {
    S.deciding = true;
    var first = S.awaitingFirst;
    S.awaitingFirst = false;
    if (loc.file) S.file = loc.file;
    S.func = loc.func;
    S.line = loc.line;
    S.level = -1;
    try {
        if (S.exitPending) {  // pausa do "app exit": nada a inspecionar
            S.exitPending = false;
            await rpc(D.CMD.RESUME, []);
            return;
        }
        if (first) await restoreBreakpoints();
        var note = '';
        var idx = S.lastAction === 'resume' ? findBp(S.file, S.line) : -1;
        if (S.lastThrow) {
            note = C.err('  (erro nao capturado: `c` deixa o erro seguir)');
            S.lastThrow = null;
        } else if (idx >= 0) {
            var bp = bps[idx];
            if (bp.cond) {
                var r = await evalRaw(bp.cond, -1);
                if (r.ok && !r.err && !truthy(r.val)) {
                    await rpc(D.CMD.RESUME, []);  // condicao falsa: segue sem parar
                    return;
                }
                if (r.ok && r.err) note = C.err('  (condicao deu erro: ' + render(r.val) + ')');
            }
            bp.hits++;
            if (bp.temp) {
                await rpc(D.CMD.DELBREAK, [D.int(idx)]);
                bps.splice(idx, 1);
            } else {
                note = note || C.dim('  (breakpoint #' + idx + ', hit ' + bp.hits + ')');
            }
        }
        S.paused = true;
        var where = S.file ? S.file + ':' + S.line : '(funcao nativa)';
        out(C.pause('[pausado] ' + where + (S.func ? ' em ' + S.func + '()' : '')) + note);
        var src = sourceLines(S.file, S.line, 0);
        if (src) out(src);
        if (first && S.sessions === 1) out(C.dim('  app pausado: `b <linha>` e `c` para seguir (h = ajuda)'));
        for (var w = 0; w < watches.length; w++) {
            out(C.dim('  w' + w + ' ') + watches[w] + ' = ' + watchText(await evalPretty(watches[w], -1)));
        }
    } finally {
        S.deciding = false;
        prompt();
    }
}

// watch de variavel que ainda nao existe neste ponto nao e erro de verdade
function watchText(r) {
    if (!r.ok) return errText(r);
    if (!r.err) return render(r.val);
    var t = render(r.val);
    return /ReferenceError/.test(t) ? C.dim('<indefinida>') : C.err('! ' + t);
}

function truthy(dv) {
    if (!dv) return false;
    if (dv.t === 'bool') return dv.v;
    if (dv.t === 'int' || dv.t === 'num') return dv.v !== 0 && !isNaN(dv.v);
    if (dv.t === 'str') return dv.v.length > 0;
    return !(dv.t === 'undefined' || dv.t === 'null' || dv.t === 'unused');
}

// breakpoints sobrevivem ao relaunch: o heap novo comeca sem nenhum
async function restoreBreakpoints() {
    if (!bps.length) return;
    var kept = [];
    for (var i = 0; i < bps.length; i++) {
        var r = await rpc(D.CMD.ADDBREAK, [D.str(bps[i].file), D.int(bps[i].line)]);
        if (r.ok) { bps[i].hits = 0; kept.push(bps[i]); }
    }
    bps = kept;
    out(C.dim('  ' + kept.length + ' breakpoint(s) restaurado(s)'));
}

// ---- avaliacao ----------------------------------------------------------------
// Eval: pausado = direto no frame (ve locais); rodando = global (indireto)
function evalArgs(expr, level) {
    return [S.paused || S.deciding ? D.int(level) : D.value(null), D.str(expr)];
}
async function evalRaw(expr, level) {
    var r = await rpc(D.CMD.EVAL, evalArgs(expr, level));
    if (!r.ok) return r;
    return { ok: true, err: !!(r.v[0] && r.v[0].v), val: r.v[1] };
}
async function evalPretty(expr, level) {
    var r = await evalRaw(prettyExpr(expr), level);
    // statement (var x = 1, if...) nao cabe como argumento: avalia cru
    if (r.ok && r.err && /^"?SyntaxError/.test(render(r.val))) r = await evalRaw(expr, level);
    return r;
}

// ---- REPL -------------------------------------------------------------------
var HELP = [
    'execucao   c continue | p pause (Ctrl-C) | s/n/o step into/over/out | u <linha> roda ate a linha',
    'breakpts   b <linha> [arquivo] [if <cond>] | tb <linha> (temporario) | B lista | d <idx>|* | cond <idx> [expr]',
    'inspecao   v <var> | e <expr> | set <var> <json> | lc locais | cs pilha | up/down frame | l [n] fonte',
    'watches    w <expr> | W lista | dw <idx>',
    'app        r envia o fonte editado e reinicia (breakpoints ficam) | i info/heap | t on|off throws | q sair',
    'no codigo do app, `debugger;` pausa ali quando o debugger esta attachado'
].join('\n');

var cmdQ = [];
var pumping = false;
rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: TTY });
rl.setPrompt('dbg> ');
rl.on('line', function (line) { cmdQ.push(line); pump(); });

// Ctrl-C: rodando = pausa (como no gdb); pausado = dica; duas vezes = sai
var lastSigint = 0;
rl.on('SIGINT', function () {
    var now = Date.now();
    if (now - lastSigint < 1500) return quit();
    lastSigint = now;
    if (S.handshaked && !S.paused && !S.deciding) {
        S.lastAction = 'pause';
        rpc(D.CMD.PAUSE, []);
        out(C.dim('pausando... (Ctrl-C de novo sai)'));
    } else {
        out(C.dim('Ctrl-C de novo (ou q) sai'));
    }
});

var restartBase = 0;  // sessoes antes do `r` (o roteiro espera a seguinte)

function waitFor(pred, ms) {
    return new Promise(function (resolve) {
        var t0 = Date.now();
        (function tick() {
            if (pred()) return resolve(true);
            if (Date.now() - t0 > ms) return resolve(false);
            setTimeout(tick, 20);
        })();
    });
}

function scriptOver() { return rlClosed && S.sessions > 0 && !S.handshaked; }

async function pump() {
    if (pumping) return;
    pumping = true;
    try {
        while (cmdQ.length) {
            // comandos esperam o app attachar e a pausa inicial assentar
            await waitFor(function () { return ready() || scriptOver(); }, 1e9);
            if (!ready()) break;
            var line = cmdQ.shift();
            if (!TTY) console.log('dbg> ' + line);
            await handleLine(line);
        }
    } finally {
        pumping = false;
    }
    if (rlClosed) finishScript();
    prompt();
}

function needPaused() {
    if (S.paused) return true;
    out('o app esta rodando: `p` (ou Ctrl-C) pausa');
    return false;
}

function resolveFile(f) {
    var file = f || S.file;
    if (file && file.indexOf('/') < 0 && S.file) file = path.posix.join(path.posix.dirname(S.file), file);
    return file;
}

// solta a execucao; no modo roteiro espera a proxima pausa (ou o detach)
async function release(cmd, action) {
    S.lastAction = action;
    S.paused = false;
    var r = await rpc(cmd, []);
    if (!r.ok) return out(C.err(errText(r)));
    if (!TTY) await waitFor(function () { return (S.paused && !S.deciding) || !S.handshaked; }, 10000);
}

async function addBreak(spec, temp) {
    // O caminho pode ter espaco ("App Store"): o `if <cond>` e sempre o
    // sufixo e a linha e o ULTIMO ":digitos" do spec. Corta o " if " de tras
    // pra frente e so aceita o corte em que o que sobra ainda tem linha no
    // comeco (N ...) sem arquivo comecando em "if", ou no fim (arq:N) —
    // " if " dentro do caminho ou da propria condicao nao engana.
    var cond = '';
    var cut = spec.lastIndexOf(' if ');
    while (cut >= 0) {
        var tail = spec.slice(cut + 1);
        var head = spec.slice(0, cut);
        var okHead = /^if\s+\S/.test(tail) &&
            ((/^\d+/.test(head) && !/^if\s/.test(head.replace(/^\d+\s*/, ''))) ||
             /:\d+$/.test(head));
        if (okHead) { cond = tail.replace(/^if\s+/, ''); spec = head; break; }
        cut = head.lastIndexOf(' if ');
    }
    var file, line;
    var mp = /^(.+):(\d+)$/.exec(spec);          // arq:linha (arq com espaco)
    var ml = !mp ? /^(\d+)(?:\s+(.+))?$/.exec(spec) : null;  // linha [arq]
    if ((!mp || !mp[1]) && !ml) {
        out('uso: b <linha> [arquivo] [if <condicao>]  (ou b arquivo:linha; caminho pode ter espaco)');
        return null;
    }
    if (mp && mp[1]) { file = mp[1]; line = parseInt(mp[2], 10); }
    else {
        line = parseInt(ml[1], 10);
        file = (ml[2] || '').trim();
        if (/^if(\s|$)/.test(file)) file = '';   // "b 14 if " sem condicao
    }
    file = resolveFile(file);
    if (!file) { out('arquivo desconhecido: use `b <linha> /local/apps/X/main.js`'); return null; }
    var r = await rpc(D.CMD.ADDBREAK, [D.str(file), D.int(line)]);
    if (!r.ok) { out(C.err(errText(r))); return null; }
    var bp = { file: file, line: line, cond: cond, hits: 0, temp: temp };
    bps.push(bp);
    var warn = looksEmpty(file, line) ? C.err('  (linha sem codigo: nunca vai disparar)') : '';
    if (!temp) {
        out(C.ok('breakpoint #' + (bps.length - 1)) + ' ' + file + ':' + line +
            (bp.cond ? ' if ' + bp.cond : '') + warn);
    } else if (warn) {
        out(warn.trim());
    }
    return bp;
}

async function handleLine(raw) {
    var line = raw.trim();
    if (!line) return;
    var sp = line.indexOf(' ');
    var verb = sp < 0 ? line : line.slice(0, sp);
    var arg = sp < 0 ? '' : line.slice(sp + 1).trim();
    var r, i, s;
    switch (verb) {
        case 'b': await addBreak(arg, false); return;
        case 'tb': await addBreak(arg, true); return;
        case 'u':
            if (!(await addBreak(arg, true))) return;
            return release(D.CMD.RESUME, 'resume');
        case 'B':
            if (!bps.length) return out('(sem breakpoints)');
            return out(bps.map(function (bp, k) {
                return '#' + k + '  ' + bp.file + ':' + bp.line + (bp.cond ? '  if ' + bp.cond : '') +
                    (bp.temp ? '  (temporario)' : '') + C.dim('  hits ' + bp.hits);
            }).join('\n'));
        case 'd':
            if (arg === '*') {
                while (bps.length) {
                    r = await rpc(D.CMD.DELBREAK, [D.int(bps.length - 1)]);
                    if (!r.ok) return out(C.err(errText(r)));
                    bps.pop();
                }
                return out('breakpoints removidos');
            }
            if (!/^\d+$/.test(arg) || +arg >= bps.length) return out('uso: d <indice do B> | d *');
            r = await rpc(D.CMD.DELBREAK, [D.int(+arg)]);
            if (!r.ok) return out(C.err(errText(r)));
            bps.splice(+arg, 1);
            return out('removido' + (+arg < bps.length ? ' (os indices seguintes andaram uma casa)' : ''));
        case 'cond': {
            var mc = /^(\d+)(?:\s+(.+))?$/.exec(arg);
            if (!mc || +mc[1] >= bps.length) return out('uso: cond <idx> [expressao]  (sem expressao limpa)');
            bps[+mc[1]].cond = mc[2] || '';
            return out('#' + mc[1] + (mc[2] ? ' if ' + mc[2] : ' sem condicao'));
        }
        case 'c': return release(D.CMD.RESUME, 'resume');
        case 'p':
            S.lastAction = 'pause';
            r = await rpc(D.CMD.PAUSE, []);
            if (!r.ok) return out(C.err(errText(r)));
            if (!TTY) await waitFor(function () { return S.paused && !S.deciding; }, 10000);
            return;
        case 's': if (!needPaused()) return; return release(D.CMD.STEPINTO, 'step');
        case 'n': if (!needPaused()) return; return release(D.CMD.STEPOVER, 'step');
        case 'o': if (!needPaused()) return; return release(D.CMD.STEPOUT, 'step');
        case 'l':
            if (!S.file) return out('sem pausa ainda');
            s = sourceLines(S.file, S.line, parseInt(arg || '5', 10));
            return out(s || 'fonte local de ' + S.file + ' nao encontrado (use --src)');
        case 'e':
            if (!arg) return out('uso: e <expressao JS>');
            r = await evalPretty(arg, S.level);
            if (!r.ok) return out(C.err(errText(r)));
            return out(r.err ? C.err('! ' + render(r.val)) : '= ' + render(r.val));
        case 'v':
            if (!arg) return out('uso: v <nome>');
            if (!needPaused()) return;
            r = await rpc(D.CMD.GETVAR, [D.int(S.level), D.str(arg)]);
            if (!r.ok) return out(C.err(errText(r)));
            if (!(r.v[0] && r.v[0].v)) return out(arg + ': nao definida neste escopo');
            if (r.v[1] && r.v[1].t === 'obj') {
                var rp = await evalPretty(arg, S.level);
                if (rp.ok && !rp.err) return out(arg + ' = ' + render(rp.val));
            }
            return out(arg + ' = ' + render(r.v[1]));
        case 'set': {
            var ms = /^(\S+)\s+(.+)$/.exec(arg);
            if (!ms) return out('uso: set <nome> <valor JSON>');
            if (!needPaused()) return;
            var val;
            try { val = D.value(JSON.parse(ms[2])); } catch (e) { return out('valor invalido: ' + e.message); }
            r = await rpc(D.CMD.PUTVAR, [D.int(S.level), D.str(ms[1]), val]);
            return out(r.ok ? ms[1] + ' = ' + ms[2] : C.err(errText(r)));
        }
        case 'cs':
            r = await rpc(D.CMD.GETCALLSTACK, []);
            if (!r.ok) return out(C.err(errText(r)));
            s = [];
            for (i = 0; i + 3 < r.v.length; i += 4) {
                var lvl = -1 - i / 4;
                s.push((lvl === S.level ? '* ' : '  ') + lvl + '  ' + (plain(r.v[i + 1]) || '<anonima>') + '()  ' +
                       (r.v[i].t === 'str' ? r.v[i].v + ':' + plain(r.v[i + 2]) : '(nativa)'));
            }
            return out(s.length ? s.join('\n') : '(pilha vazia)');
        case 'lc':
            if (!needPaused()) return;
            r = await rpc(D.CMD.GETLOCALS, [D.int(S.level)]);
            if (!r.ok) return out(C.err(errText(r)));
            s = [];
            for (i = 0; i + 1 < r.v.length; i += 2) {
                var shown = render(r.v[i + 1]);
                if (r.v[i + 1].t === 'obj') {
                    var rv = await evalPretty(plain(r.v[i]), S.level);
                    if (rv.ok && !rv.err) shown = render(rv.val);
                }
                s.push(plain(r.v[i]) + ' = ' + shown);
            }
            return out(s.length ? s.join('\n') : '(sem locais: no frame global use `v`/`e`)');
        case 'up': case 'down': {
            if (!needPaused()) return;
            r = await rpc(D.CMD.GETCALLSTACK, []);
            if (!r.ok) return out(C.err(errText(r)));
            var depth = Math.floor(r.v.length / 4);
            var next = S.level + (verb === 'up' ? -1 : 1);
            if (next > -1 || -next > depth) return out('ja no frame ' + (verb === 'up' ? 'mais externo' : 'do topo'));
            S.level = next;
            var k = (-1 - next) * 4;
            var f = r.v[k].t === 'str' ? r.v[k].v : '';
            out('frame ' + next + ': ' + (plain(r.v[k + 1]) || '<anonima>') + '()  ' +
                (f ? f + ':' + plain(r.v[k + 2]) : '(nativa)'));
            s = sourceLines(f, plain(r.v[k + 2]), 0);
            if (s) out(s);
            return;
        }
        case 'w':
            if (!arg) return out('uso: w <expressao>');
            watches.push(arg);
            if (S.paused) {
                return out('w' + (watches.length - 1) + ' ' + arg + ' = ' + watchText(await evalPretty(arg, S.level)));
            }
            return out('w' + (watches.length - 1) + ' ' + arg);
        case 'W':
            return out(watches.length ? watches.map(function (w, k) { return 'w' + k + ' ' + w; }).join('\n')
                                      : '(sem watches)');
        case 'dw':
            if (!/^\d+$/.test(arg) || +arg >= watches.length) return out('uso: dw <idx>');
            watches.splice(+arg, 1);
            return out('removido');
        case 't':
            throwsVisible = arg !== 'off';
            return out('throws capturados: ' + (throwsVisible ? 'visiveis' : 'ocultos'));
        case 'i': {
            r = await rpc(D.CMD.BASICINFO, []);
            if (!r.ok) return out(C.err(errText(r)));
            var info = 'duktape ' + plain(r.v[0]) + ' | ponteiro ' + plain(r.v[4]) + ' B';
            var ri = await rpc(D.CMD.APPREQUEST, [D.str('info')]);
            if (ri.ok && ri.v.length >= 3) {
                info += '\napp ' + plain(ri.v[0]) + ' | heap livre ' + Math.round(plain(ri.v[1]) / 1024) +
                        ' KB (maior bloco ' + Math.round(plain(ri.v[2]) / 1024) + ' KB)';
            }
            return out(info);
        }
        case 'r':
            // reinicia o app (le o main.js de novo: push + r = ciclo de edicao)
            // com breakpoints e watches mantidos para a proxima sessao
            if (S.file) {
                var sync = await syncSource(path.posix.dirname(S.file));
                if (/^erro/.test(sync)) return out(C.err('sync: ' + sync.replace(/^erro /, '') + ' — app NAO reiniciado'));
                var ms2 = /^ok (\d+)\s*(.*)$/.exec(sync);
                if (ms2) out(C.dim(ms2[1] === '0' ? 'fonte sem mudancas' : 'enviado: ' + (ms2[2] || ms2[1] + ' arquivo(s)')));
                else out(C.dim('sync: ' + sync.replace(/^skip /, '') + ' (relancando o que esta no device)'));
            }
            restartBase = S.sessions;
            r = await rpc(D.CMD.APPREQUEST, [D.str('restart')]);
            if (!r.ok) return out(C.err(errText(r)));
            out(C.dim('reiniciando ' + plain(r.v[0]) + '...'));
            S.lastAction = 'resume';
            S.paused = false;
            await rpc(D.CMD.RESUME, []);
            if (!TTY) await waitFor(function () { return S.sessions > restartBase && ready(); }, 20000);
            return;
        case 'q': return quit();
        case 'h': case 'help': case '?': return out(HELP);
        default: return out('comando desconhecido: ' + verb + ' (h = ajuda)');
    }
}

function quit() {
    // Detach limpo: o app segue rodando. Sem resposta em 1.5s sai assim mesmo
    // (o proxy derruba o cliente no device e o app tambem e solto)
    setTimeout(function () { process.exit(0); }, 1500);
    if (!S.handshaked) return process.exit(0);
    rpc(D.CMD.DETACH, []).then(function () { sock.end(); process.exit(0); });
}

var finishing = false;
function finishScript() {
    if (finishing || cmdQ.length || pumping) return;
    finishing = true;
    quit();  // roteiro (stdin nao-TTY) acabou: detach limpo e sai
}

rl.on('close', function () {
    rlClosed = true;
    if (TTY) return quit();
    finishScript();
});
