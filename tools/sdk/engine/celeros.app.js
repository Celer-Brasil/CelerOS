// app.js — CelerKit APP core (dep "celeros.app"): o casco dos apps gerais.
// E para apps o que o core do CelerGame e para os jogos: tema/layout
// cacheados, loop de telas com pilha (A.run), overlays prontos (ocupado,
// progresso, resultado, espera de Wi-Fi) e o ticker de polling. Os demais
// modulos da familia (celeros.app.*) decoram ESTE objeto no require —
// o cache do require faz celeros.app ser singleton (o mesmo A).
//
// Uso tipico:
//   var A = require("celeros.app");
//   require("celeros.app.fmt");               // submodulos sao opcionais
//   A.run({
//       lista: function (c) {
//           if (c.entered) UI.resetScroll("l");          // rolagem nova
//           if (A.header("Meu app")) return A.BACK;      // na raiz encerra
//           if (A.every(1000, "hora")) rows = recarrega(); // 1x por segundo
//           var i = UI.list("l", A.L.x, A.L.top, A.L.w, 220, rows);
//           if (i >= 0) { A._sel = i; return "detalhe"; }  // empilha
//       },
//       detalhe: function (c) {
//           if (A.header("Detalhe")) return A.BACK;      // volta p/ lista
//           UI.text("item " + (A._sel + 1), A.L.x, 56, {});
//       }
//   }, "lista", { fps: 15 });
//
// Contrato de tela: A.run faz UI.begin/UI.end; a tela so desenha e DEVOLVE
//   undefined   fica na tela (proximo frame)
//   "nome"      empilha a atual e abre a tela "nome"
//   A.BACK      volta na pilha; pilha vazia encerra o app
//   A.EXIT      encerra o app na hora
// ctx = { full, now, entered }: entered so vale true no 1o frame da tela
// (lazy load, reset de scroll da tela). Tema em A.T, layout em A.L
// (coordenadas virtuais 240x320). A.init() re-le o tema (Ajustes mudou).
// fps por tela: propriedade .fps na propria funcao da tela.
//
// 1.0.0: primeira versao (core, pilha de telas, overlays, ticker)
// 1.1.0: A.L respeita o inset/shape do vidro (relogio redondo): x/w/bottom
// encolhem pela margem segura; em tela retangular (inset 0) os valores sao
// os de sempre (x=8,w=224,top=48,bottom=312).

var A = { version: '1.1.0' };

// sentinelas de roteamento (strings/chars: nada de Symbol no ES5)
A.BACK = '..';
A.EXIT = '\u0001';

A._mods = [];       // nomes dos modulos da familia adotados (diagnostico)
A._stack = [];      // pilha de telas do A.run
A._marks = {};      // marcas do A.every, por chave
A._ctx = { full: false, now: 0, entered: false };   // ctx reciclado por frame

// pilha com teto: apps reais navegam poco; estourar e bug de roteamento
var MAX_STACK = 8;

// ---- tema/layout -----------------------------------------------------------
// A.init() cacheia o tema (A.T) e o layout virtual (A.L). Chame de novo
// para re-ler o tema (ex.: o app de Ajustes mudou o esquema de cores).
A.T = null;
A.L = null;
A.init = function () {
    A.T = System.theme();
    // margem segura do vidro redondo em coords virtuais (0 no retangular)
    var ins = 0;
    try { ins = (System.getInfo() || {}).inset || 0; } catch (e) { ins = 0; }
    var m = Math.round(ins / 2);
    // espaco virtual fixo (header de 40px + folga); no redondo o conteudo
    // encolhe pela margem segura e nao encosta na borda
    A.L = { x: 8 + m, y: 48, w: 224 - 2 * m, top: 48,
            bottom: 312 - m, cx: 120 };
    return A;
};

// ---- loop de telas ---------------------------------------------------------
A.run = function (screens, first, opts) {
    if (!A.T) A.init();
    opts = opts || {};
    A._stack.length = 0;
    var cur = first;
    var prev = null;
    for (;;) {
        var fn = screens[cur];
        if (!fn) {                       // tela ausente: guard p/ a primeira
            cur = first;
            fn = screens[cur];
            if (!fn) return;
        }
        var c = A._ctx;
        if (cur !== prev) {
            prev = cur;
            UI.invalidate();             // moldura nova para a tela que entra
            c.entered = true;
        } else {
            c.entered = false;
        }
        c.now = System.millis();
        c.full = UI.begin(A.T.bg);
        var r = fn(c);
        UI.end(typeof opts.fps === 'number' ? opts.fps : (fn.fps || 20));
        if (r === A.EXIT) { System.exitApp(); return; }
        if (r === A.BACK) {
            if (!A._stack.length) { System.exitApp(); return; }
            cur = A._stack.pop();
            prev = null;                 // re-entrada da tela que volta
            continue;
        }
        if (typeof r === 'string' && r !== cur && screens[r]) {
            if (A._stack.length >= MAX_STACK) A._stack.shift();
            A._stack.push(cur);
            cur = r;
        }
        // undefined / o proprio nome / nome desconhecido: fica
    }
};

// ---- header ----------------------------------------------------------------
// Header com botao voltar; o toque devolve true e a tela decide (o padrao
// e devolver A.BACK: pop na pilha, encerra na raiz). o = { back:false, sub }.
A.header = function (title, o) {
    if (!o) o = {};
    return UI.header(title, { sub: o.sub, back: o.back !== false });
};

// ---- overlays --------------------------------------------------------------
// A.busy desenha UM frame de "ocupado" e VOLTA: chame antes da chamada
// bloqueante (Net, FS, AI) — a tela congela nesse desenho enquanto trava.
A.busy = function (msg) {
    UI.invalidate();
    UI.begin();
    UI.header(msg || 'Aguarde...', { back: false });
    UI.spinner(120, 170, 18);
    UI.end(10);
};

// Idem com barra de progresso (p 0..100). p < 0 = indeterminado (spinner).
A.progress = function (p, msg) {
    UI.invalidate();
    UI.begin();
    UI.header(msg || 'Baixando...', { back: false });
    if (p >= 0) {
        UI.progress(40, 150, 160, 12, p);
        UI.text((p | 0) + '%', 120, 174, { align: 'center', role: 'caption', color: A.T.textDim });
    } else {
        UI.spinner(120, 160, 18);
    }
    UI.end(10);
};

// Telas de resultado: desenham o card e ESPERAM o toque em OK (laco proprio,
// como os dialogos nativos). lines = texto ou array de linhas.
A._result = function (title, lines, color) {
    if (typeof lines === 'string') lines = [lines];
    var Sys = System;
    for (;;) {
        UI.invalidate();
        UI.begin(A.T.bg);
        UI.header('', { back: false });
        UI.card(20, 90, 200, 160);
        Sys.fillCircle(120, 130, 18, color);
        if (color === A.T.err) {
            Sys.drawWideLine(112, 122, 128, 138, 3, 0xFFFF);
            Sys.drawWideLine(128, 122, 112, 138, 3, 0xFFFF);
        } else {
            Sys.drawWideLine(110, 130, 117, 140, 3, 0xFFFF);
            Sys.drawWideLine(117, 140, 133, 119, 3, 0xFFFF);
        }
        UI.text(title, 120, 160, { align: 'center', w: 176, lines: 2 });
        if (lines && lines.length) {
            UI.text(lines.join(' '), 120, 190, { align: 'center', w: 176, lines: 4,
                                                 role: 'caption', color: A.T.textDim });
        }
        UI.cardEnd();
        if (UI.button('OK', 70, 264, 100, 34)) return;
        UI.end(15);
    }
};
A.error = function (title, lines) { A._result(title, lines, A.T.err); };
A.ok = function (title, lines) { A._result(title, lines, A.T.ok); };

// Espera o Wi-Fi voltar: card com spinner + botao Cancelar. Devolve true
// quando conectou, false se o usuario cancelou. Chame antes de usar Net;
// a tela do app volta no frame seguinte.
A.wifiWait = function (msg) {
    for (;;) {
        var on = false;
        try { on = Net.isConnected(); } catch (e) { return false; }
        if (on) return true;
        UI.invalidate();
        UI.begin(A.T.bg);
        UI.header('Wi-Fi', { back: false });
        UI.card(20, 90, 200, 120);
        UI.spinner(120, 128, 14);
        UI.text(msg || 'Esperando a rede voltar...', 120, 154, { align: 'center', w: 176,
                                                                 lines: 3, role: 'caption', color: A.T.textDim });
        UI.cardEnd();
        if (UI.button('Cancelar', 70, 264, 100, 34)) return false;
        UI.end(8);
    }
};

// ---- ticker ----------------------------------------------------------------
// Devolve true quando passou "ms" desde a ultima marca da chave — o padrao
// de polling dos apps (os timers so disparam no present; o delta de millis
// dentro do frame e mais simples e nao gasta o pool de 8 timers).
A.now = function () { return System.millis(); };
A.every = function (ms, key) {
    var now = System.millis();
    var k = key || '_';
    var last = A._marks[k];
    if (last === undefined || now - last >= ms) { A._marks[k] = now; return true; }
    return false;
};

// ---- atalhos ---------------------------------------------------------------
A.toast = function (msg, ms) { UI.toast(msg, ms); };
A.exit = function () { System.exitApp(); };

module.exports = A;
