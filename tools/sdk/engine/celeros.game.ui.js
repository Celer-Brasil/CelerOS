// game.ui.js — CelerGame UI 1.3 (dep "celeros.game.ui"): o que todo jogo
// reescreve — menus, listas com rolagem, dialogo com texto datilografado,
// as telas de titulo/pausa/fim, e agora o kit visual que faltava:
// tokens/presets, icones vetoriais, layout, widgets, modal/sheet, HUD
// memoizado e animacao de painel. Decora o core no require:
//
//   var E = require("celeros.game");
//   require("celeros.game.ui");
//   E.ui.preset("neon");                       // soft (default), flat, neon, paper
//   var c = E.ui.card(8, 40, 224, 120);        // desenha e devolve o content rect
//   if (E.ui.button("Jogar", c.x, c.y, c.w, 40)) E.goto("jogo");
//
// Filosofia da casa: immediate-mode (o widget desenha e DEVOLVE o estado
// no mesmo quadro) e zero estado escondido — as excecoes roladas
// (list/dialog/scroll/modal/sheet) sao objetos/ids guardados pelo chamador.
// Tudo desenha com screen: true (fora da camera) e respeita o tema do
// firmware (E.theme) por baixo dos tokens.
//
// 1.3.0: tokens + E.ui.preset (soft/flat/neon/paper); E.ui.icon (24 icones
// vetoriais); layout (stack/grid/card/section/divider); widgets (button,
// iconButton, toggle, check, radio, slider, stepper, segmented, tabs,
// chip, badge, progress, ring); lista com secoes/icones/row custom;
// scroll generico; modal/sheet com animacao; dialog com choices/som;
// toast em fila (3); HUD memoizado; telas prontas redesenhadas (mesma
// geometria/retornos). Depende do core 1.7 (E.color/gfx.shadow/dim/star).
// 1.2.2: \r do CRLF sai do texto do dialog/confirm (fala salva no Windows
// desenhava o CR como glifo e contava na revelacao); draw de dialogo ja
// fechado devolve false sem repintar a caixa que o close apagou.
// 1.2.1: \n no texto do dialog/confirm quebra o paragrafo; com a camada
// suja o dialogo so redesenha quando o texto revelado muda ou algo apaga a
// caixa (desenho mudo; a caixa volta ao fundo ao fechar).
// 1.2.0: dialog com paginas (texto = array), d.next() (avanca pelo botao
// do pad, sem tocar a caixa), {realtime} (anda com o jogo pausado) e
// {tap: false}.
// 1.1.0: E.ui.confirm (sim/nao modal), E.ui.toast (aviso que some sozinho,
// desenhado pela engine por cima da cena), lista com inercia (fling) e
// scrollTo, e title/pause/gameOver/dialog sem alocar opts por quadro.

var E = require('celeros.game');
var S = System;
var C = E.color;
var EMPTY = {};

// ------------------------------------------------------------ tokens ------
// E.ui.tokens e o objeto VIVO que os widgets leem. O preset troca cores e
// flags; theme(patch) sobrescreve chaves (aceita '#rrggbb'). A derivacao do
// E.theme e lazy e refeita quando o app chama E.init de novo (o E.theme e
// outro objeto) — preset/custom sobrevivem.
var TK = {
    preset: 'soft',
    bg: 0x0000, surface: 0x2104, surface2: 0x3186, surface3: 0x39E7,
    outline: 0x4208, text: 0xFFFF, textDim: 0x8410,
    accent: 0x07FF, accent2: 0x0333, onAccent: 0x0000,
    ok: 0x05E0, warn: 0xFD20, err: 0xF800, glow: 0x03EF,
    radius: 10, gap: 8, pad: 10,
    shadow: 2, grad: true, bw: 1, glowOn: false,
    _src: null, _custom: null
};

function applyPatch(p) {
    for (var k in p) {
        if (!p.hasOwnProperty(k)) continue;
        var v = p[k];
        if (typeof v === 'string') v = C.hex(v);
        TK[k] = v;
    }
}

function applyPreset(name, theme) {
    var d = C.derive(theme), i;
    for (i in d) if (d.hasOwnProperty(i)) TK[i] = d[i];
    TK.preset = name;
    TK._src = theme;
    if (name === 'flat') {
        TK.radius = 6; TK.shadow = 0; TK.grad = false; TK.bw = 1; TK.glowOn = false;
    } else if (name === 'neon') {
        TK.radius = 12; TK.shadow = 2; TK.grad = true; TK.bw = 2; TK.glowOn = true;
        TK.bg = 0x0000; TK.surface = 0x0841; TK.surface2 = 0x10A2; TK.surface3 = 0x18E3;
        TK.outline = TK.accent; TK.text = 0xFFFF; TK.textDim = 0x8410;
        TK.accent2 = C.mix(TK.accent, 0x0000, 0.45);
        TK.glow = C.mix(TK.accent, TK.bg, 0.55);
    } else if (name === 'paper') {
        TK.radius = 2; TK.shadow = 1; TK.grad = false; TK.bw = 1; TK.glowOn = false;
        TK.bg = C.hex('#f2eee4'); TK.surface = C.hex('#fffdf7');
        TK.surface2 = C.hex('#e8e2d4'); TK.surface3 = C.hex('#ddd5c4');
        TK.outline = C.hex('#b9b09c');
        TK.text = C.hex('#1c1b18'); TK.textDim = C.hex('#6b6459');
        TK.accent = C.hex('#2f6fed'); TK.accent2 = C.hex('#1d4fb8');
        TK.onAccent = 0xFFFF; TK.ok = C.hex('#2e9e5b');
        TK.warn = C.hex('#d98a00'); TK.err = C.hex('#c6352f');
        TK.glow = C.hex('#9db9f5');
    } else {
        TK.radius = 10; TK.shadow = 2; TK.grad = true; TK.bw = 1; TK.glowOn = false;
    }
    if (TK._custom) applyPatch(TK._custom);
}

function ensure() {
    if (TK._src !== E.theme) applyPreset(TK.preset || 'soft', E.theme);
}

function pick(a, b, c) {
    return a !== undefined && a !== null ? a : (b !== undefined && b !== null ? b : c);
}

// ------------------------------------------------------------ scratch -----
// Tudo que desenha por quadro usa scratch (o Duktape paga caro por objeto
// novo). Quem guardar um rect de retorno deve copiar os campos.
var _tx = { ts: 'body', align: 'center', valign: undefined, color: 0, screen: true };
var _txs = { ts: 'body', align: 'center', valign: undefined, color: 0, screen: true, shadow: 0x0000 };
var _bt = { ts: 'body', color: 0, align: 'center', valign: 'middle', fit: 0, screen: true };
var _mn = { y: undefined, x: undefined, w: undefined, row: undefined, primary: undefined };
var _mOp = { variant: 'secondary', icon: undefined, disabled: false };
var _dimO = { screen: true, bg: undefined };
var _arrow = { color: 0, screen: true };
var _wM = { font: 0, size: 0 };
var _mo = { ts: 'body' };
var _toTx = { ts: 'body', align: 'center', valign: 'middle', color: 0, fit: 0, screen: true };
var _toBox = { r: 0, screen: true, fill: true, bw: 0, stroke: undefined,
               grad: undefined, elev: 0, shadow: undefined, bg: undefined };
var _bo = { screen: true, r: 0, fill: true, bw: 0, stroke: undefined,
            grad: undefined, elev: 0, shadow: undefined, bg: undefined };
var _boS = { screen: true, r: 0, fill: false };
var _cg = { a: 0, b: 0, dir: 'y', via: undefined, step: 4 };
var _go = { screen: true, r: 0, dir: 'y', via: undefined, step: 4 };
var _co = { screen: true, r: 0, fill: true, bw: 0, stroke: undefined,
            grad: undefined, elev: 0, shadow: undefined, bg: undefined, pad: 0 };
var _lpo = { screen: true, r: 0, fill: true, bw: 0, stroke: undefined,
             grad: undefined, elev: 0, shadow: undefined, bg: undefined, pad: 0 };
var _hudBg = { screen: true, r: 0, fill: true, bw: 0, stroke: undefined,
               grad: undefined, elev: 0, shadow: undefined, bg: undefined };
var _nr = { x: 0, y: 0, w: 0, h: 0 };
var _cr = { x: 0, y: 0, w: 0, h: 0 };
var _icr = { x: 0, y: 0, w: 0, h: 0 };
var _hr = { x: 0, y: 0, w: 0, h: 0 };
var _lRect = { x: 0, y: 0, w: 0, h: 0 };
var _lTxt = { ts: 'body', valign: 'middle', screen: true, color: 0 };
var _dTxt = { font: 0, size: 0, color: 0, screen: true };
var _dName = { ts: 'small', color: 0, screen: true };
var _dPanel = { screen: true, r: 0, fill: true, bw: 0, stroke: undefined,
                grad: undefined, elev: 0, shadow: undefined, bg: undefined, pad: 8 };
var _PAUSA_LB = ['Continuar', 'Recomecar', 'Sair'];
var _FIM_LB = ['De novo', 'Sair'];
var _SN_LB = ['Sim', 'Nao'];

// toque: o primeiro widget que consome o tap do quadro ganha (evita dois
// botoes sobrepostos dispararem). Sem tap, libera para o proximo.
var _tapUsed = false;
var _sOn = null;
function tapFree() {
    if (!E.input.tap) { _tapUsed = false; return false; }
    return _tapUsed;
}
function tapIn(x, y, w, h, pad) {
    if (tapFree()) return false;
    var t = E.input.tap, p = pad || 0;
    if (!t) return false;
    if (t.x >= x - p && t.x <= x + w + p && t.y >= y - p && t.y <= y + h + p) {
        _tapUsed = true;
        return true;
    }
    return false;
}
function downIn(x, y, w, h, pad) {
    var i = E.input, p = pad || 0;
    return i.down && i.x >= x - p && i.x <= x + w + p &&
           i.y >= y - p && i.y <= y + h + p;
}
function hitRect(x, y, w, h) {
    _hr.x = x; _hr.y = y; _hr.w = w; _hr.h = h;
    return E.hit(_hr);
}
function textW(s, ts) {
    _mo.ts = ts || 'body';
    return E.gfx.measure(String(s), _mo);
}

// ------------------------------------------------------------ icones ------
// Desenho procedural (sem PNG/sprite): 24 nomes. s = lado, c = cor,
// w = espessura. Sempre em coords de TELA (HUD/menu).
var _il = { w: 1, screen: true };
var _ir = { r: 0, screen: true };
var _it = { fill: true, screen: true };
var _ici = { fill: true, smooth: true, screen: true };
var _ia = { screen: true };
function iL(x1, y1, x2, y2, c, w) { _il.w = w; E.gfx.line(x1, y1, x2, y2, c, _il); }
function iR(x, y, w, h, r, c) { _ir.r = r || 0; E.gfx.rect(x, y, w, h, c, _ir); }
function iT(x1, y1, x2, y2, x3, y3, c) { E.gfx.tri(x1, y1, x2, y2, x3, y3, c, _it); }
function iC(cx, cy, r, c, fill) { _ici.fill = fill !== false; E.gfx.circle(cx, cy, r, c, _ici); }
function iA(cx, cy, r0, r1, a0, a1, c) { E.gfx.arc(cx, cy, r0, r1, a0, a1, c, _ia); }

var ICONS = {
    dot: function (x, y, s, c) { iC(x + s / 2, y + s / 2, s * 0.18, c); },
    play: function (x, y, s, c) {
        iT(x + s * 0.30, y + s * 0.16, x + s * 0.30, y + s * 0.84,
           x + s * 0.84, y + s * 0.50, c);
    },
    pause: function (x, y, s, c) {
        iR(x + s * 0.28, y + s * 0.18, s * 0.14, s * 0.64, s * 0.03, c);
        iR(x + s * 0.58, y + s * 0.18, s * 0.14, s * 0.64, s * 0.03, c);
    },
    stop: function (x, y, s, c) {
        iR(x + s * 0.27, y + s * 0.27, s * 0.46, s * 0.46, s * 0.08, c);
    },
    back: function (x, y, s, c, w) {
        iL(x + s * 0.60, y + s * 0.20, x + s * 0.32, y + s * 0.50, c, w);
        iL(x + s * 0.32, y + s * 0.50, x + s * 0.60, y + s * 0.80, c, w);
        iL(x + s * 0.32, y + s * 0.50, x + s * 0.82, y + s * 0.50, c, w);
    },
    close: function (x, y, s, c, w) {
        iL(x + s * 0.28, y + s * 0.28, x + s * 0.72, y + s * 0.72, c, w);
        iL(x + s * 0.72, y + s * 0.28, x + s * 0.28, y + s * 0.72, c, w);
    },
    check: function (x, y, s, c, w) {
        iL(x + s * 0.22, y + s * 0.52, x + s * 0.43, y + s * 0.72, c, w);
        iL(x + s * 0.43, y + s * 0.72, x + s * 0.78, y + s * 0.28, c, w);
    },
    plus: function (x, y, s, c, w) {
        iL(x + s * 0.22, y + s * 0.50, x + s * 0.78, y + s * 0.50, c, w);
        iL(x + s * 0.50, y + s * 0.22, x + s * 0.50, y + s * 0.78, c, w);
    },
    minus: function (x, y, s, c, w) {
        iL(x + s * 0.22, y + s * 0.50, x + s * 0.78, y + s * 0.50, c, w);
    },
    chevronL: function (x, y, s, c, w) {
        iL(x + s * 0.62, y + s * 0.24, x + s * 0.38, y + s * 0.50, c, w);
        iL(x + s * 0.38, y + s * 0.50, x + s * 0.62, y + s * 0.76, c, w);
    },
    chevronR: function (x, y, s, c, w) {
        iL(x + s * 0.38, y + s * 0.24, x + s * 0.62, y + s * 0.50, c, w);
        iL(x + s * 0.62, y + s * 0.50, x + s * 0.38, y + s * 0.76, c, w);
    },
    chevronU: function (x, y, s, c, w) {
        iL(x + s * 0.24, y + s * 0.62, x + s * 0.50, y + s * 0.38, c, w);
        iL(x + s * 0.50, y + s * 0.38, x + s * 0.76, y + s * 0.62, c, w);
    },
    chevronD: function (x, y, s, c, w) {
        iL(x + s * 0.24, y + s * 0.38, x + s * 0.50, y + s * 0.62, c, w);
        iL(x + s * 0.50, y + s * 0.62, x + s * 0.76, y + s * 0.38, c, w);
    },
    gear: function (x, y, s, c, w) {
        var cx = x + s / 2, cy = y + s / 2, r0 = s * 0.20, r1 = s * 0.42, k;
        iC(cx, cy, r0, c, false);
        for (k = 0; k < 8; k++) {
            var a = k * Math.PI / 4;
            iL(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0,
               cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, c, w);
        }
    },
    heart: function (x, y, s, c) {
        E.gfx.hearts(1, 1, x + s * 0.10, y + s * 0.12,
                     { size: s * 0.80, color: c, screen: true });
    },
    star: function (x, y, s, c) {
        E.gfx.star(x + s / 2, y + s / 2, s * 0.46, s * 0.20, 5, c, { screen: true });
    },
    sound: function (x, y, s, c, w) {
        iT(x + s * 0.12, y + s * 0.38, x + s * 0.12, y + s * 0.62,
           x + s * 0.38, y + s * 0.82, c);
        iT(x + s * 0.12, y + s * 0.38, x + s * 0.38, y + s * 0.82,
           x + s * 0.38, y + s * 0.18, c);
        iA(x + s * 0.34, y + s * 0.50, s * 0.22, s * 0.28, -55, 55, c);
        iA(x + s * 0.34, y + s * 0.50, s * 0.34, s * 0.40, -50, 50, c);
    },
    soundOff: function (x, y, s, c, w) {
        iT(x + s * 0.12, y + s * 0.38, x + s * 0.12, y + s * 0.62,
           x + s * 0.38, y + s * 0.82, c);
        iT(x + s * 0.12, y + s * 0.38, x + s * 0.38, y + s * 0.82,
           x + s * 0.38, y + s * 0.18, c);
        iL(x + s * 0.58, y + s * 0.34, x + s * 0.82, y + s * 0.66, c, w);
        iL(x + s * 0.82, y + s * 0.34, x + s * 0.58, y + s * 0.66, c, w);
    },
    music: function (x, y, s, c, w) {
        iC(x + s * 0.32, y + s * 0.74, s * 0.11, c);
        iL(x + s * 0.43, y + s * 0.74, x + s * 0.43, y + s * 0.22, c, w);
        iL(x + s * 0.43, y + s * 0.22, x + s * 0.76, y + s * 0.34, c, w);
        iL(x + s * 0.76, y + s * 0.34, x + s * 0.76, y + s * 0.58, c, w);
        iC(x + s * 0.65, y + s * 0.58, s * 0.11, c);
    },
    home: function (x, y, s, c, w) {
        iT(x + s * 0.14, y + s * 0.48, x + s * 0.50, y + s * 0.16,
           x + s * 0.86, y + s * 0.48, c);
        iL(x + s * 0.22, y + s * 0.48, x + s * 0.22, y + s * 0.84, c, w);
        iL(x + s * 0.78, y + s * 0.48, x + s * 0.78, y + s * 0.84, c, w);
        iL(x + s * 0.22, y + s * 0.84, x + s * 0.78, y + s * 0.84, c, w);
    },
    menu: function (x, y, s, c, w) {
        iL(x + s * 0.22, y + s * 0.32, x + s * 0.78, y + s * 0.32, c, w);
        iL(x + s * 0.22, y + s * 0.50, x + s * 0.78, y + s * 0.50, c, w);
        iL(x + s * 0.22, y + s * 0.68, x + s * 0.78, y + s * 0.68, c, w);
    },
    search: function (x, y, s, c, w) {
        iC(x + s * 0.44, y + s * 0.42, s * 0.22, c, false);
        iL(x + s * 0.60, y + s * 0.60, x + s * 0.82, y + s * 0.82, c, w);
    },
    clock: function (x, y, s, c, w) {
        iC(x + s * 0.50, y + s * 0.50, s * 0.36, c, false);
        iL(x + s * 0.50, y + s * 0.50, x + s * 0.50, y + s * 0.28, c, w);
        iL(x + s * 0.50, y + s * 0.50, x + s * 0.68, y + s * 0.58, c, w);
    },
    lock: function (x, y, s, c, w) {
        iR(x + s * 0.24, y + s * 0.46, s * 0.52, s * 0.38, s * 0.08, c);
        iA(x + s * 0.50, y + s * 0.46, s * 0.16, s * 0.20, 180, 360, c);
    },
    trash: function (x, y, s, c, w) {
        iL(x + s * 0.22, y + s * 0.28, x + s * 0.78, y + s * 0.28, c, w);
        iL(x + s * 0.40, y + s * 0.28, x + s * 0.40, y + s * 0.18, c, w);
        iL(x + s * 0.60, y + s * 0.28, x + s * 0.60, y + s * 0.18, c, w);
        iL(x + s * 0.28, y + s * 0.32, x + s * 0.32, y + s * 0.84, c, w);
        iL(x + s * 0.72, y + s * 0.32, x + s * 0.68, y + s * 0.84, c, w);
        iL(x + s * 0.32, y + s * 0.84, x + s * 0.68, y + s * 0.84, c, w);
    },
    edit: function (x, y, s, c, w) {
        iL(x + s * 0.20, y + s * 0.80, x + s * 0.66, y + s * 0.22, c, w);
        iL(x + s * 0.60, y + s * 0.16, x + s * 0.78, y + s * 0.28, c, w);
        iL(x + s * 0.20, y + s * 0.80, x + s * 0.34, y + s * 0.76, c, w);
    },
    info: function (x, y, s, c, w) {
        iC(x + s * 0.50, y + s * 0.50, s * 0.36, c, false);
        iL(x + s * 0.50, y + s * 0.46, x + s * 0.50, y + s * 0.68, c, w);
        iC(x + s * 0.50, y + s * 0.34, Math.max(1, s * 0.045), c);
    },
    alert: function (x, y, s, c, w) {
        iT(x + s * 0.50, y + s * 0.12, x + s * 0.12, y + s * 0.86,
           x + s * 0.88, y + s * 0.86, c);
        iL(x + s * 0.50, y + s * 0.38, x + s * 0.50, y + s * 0.62, c, w);
        iC(x + s * 0.50, y + s * 0.72, Math.max(1, s * 0.045), c);
    },
    refresh: function (x, y, s, c, w) {
        iA(x + s * 0.50, y + s * 0.50, s * 0.28, s * 0.36, -60, 240, c);
        iT(x + s * 0.62, y + s * 0.10, x + s * 0.86, y + s * 0.22,
           x + s * 0.68, y + s * 0.34, c);
    },
    download: function (x, y, s, c, w) {
        iL(x + s * 0.50, y + s * 0.18, x + s * 0.50, y + s * 0.66, c, w);
        iL(x + s * 0.30, y + s * 0.48, x + s * 0.50, y + s * 0.68, c, w);
        iL(x + s * 0.70, y + s * 0.48, x + s * 0.50, y + s * 0.68, c, w);
        iL(x + s * 0.22, y + s * 0.84, x + s * 0.78, y + s * 0.84, c, w);
    },
    upload: function (x, y, s, c, w) {
        iL(x + s * 0.50, y + s * 0.18, x + s * 0.50, y + s * 0.66, c, w);
        iL(x + s * 0.30, y + s * 0.38, x + s * 0.50, y + s * 0.18, c, w);
        iL(x + s * 0.70, y + s * 0.38, x + s * 0.50, y + s * 0.18, c, w);
        iL(x + s * 0.22, y + s * 0.84, x + s * 0.78, y + s * 0.84, c, w);
    }
};

// ------------------------------------------------------------ layout ------
function contentRect(x, y, w, h, p) {
    _cr.x = x + p; _cr.y = y + p; _cr.w = w - p * 2; _cr.h = h - p * 2;
    return _cr;
}

// ------------------------------------------------------------ lista/scroll --
var _scrolls = {};

function scrollState(id) {
    var s = _scrolls[id];
    if (!s) s = _scrolls[id] = { scroll: 0, dragOn: false, dragY: 0, vel: 0 };
    return s;
}

function scrollStep(s, x, y, w, h, contentH) {
    var i = E.input;
    var maxScroll = contentH > h ? contentH - h : 0;
    if (i.justDown && i.x >= x && i.x <= x + w && i.y >= y && i.y <= y + h) {
        s.dragOn = true;
        s.dragY = s.scroll + i.y;
        s.vel = 0;
    }
    if (!i.down) s.dragOn = false;
    if (s.dragOn) {
        var ns = s.dragY - i.y;
        s.vel = s.vel * 0.5 + (ns - s.scroll) * 0.5;
        s.scroll = ns;
    } else if (s.vel > 0.5 || s.vel < -0.5) {
        s.scroll += s.vel;
        s.vel *= 0.92;
        if (s.scroll < 0 || s.scroll > maxScroll) s.vel = 0;
    } else s.vel = 0;
    if (s.scroll < 0) s.scroll = 0;
    if (s.scroll > maxScroll) s.scroll = maxScroll;
    return maxScroll;
}

function scrollbar(x, y, w, h, content, scroll, maxScroll) {
    if (!(maxScroll > 0)) return;
    var tbH = Math.max(Math.round(12 * E.U), Math.round(h * h / content));
    var tbY = y + (h - tbH) * (scroll / maxScroll);
    _bo.r = 1; _bo.screen = true; _bo.fill = true; _bo.bw = 0;
    _bo.stroke = undefined; _bo.grad = undefined; _bo.elev = 0;
    _bo.shadow = undefined; _bo.bg = undefined;
    E.gfx.rect(x + w - Math.round(3 * E.U), y, 2, h, TK.outline, _bo);
    E.gfx.rect(x + w - Math.round(3 * E.U), tbY, 2, tbH, TK.accent, _bo);
}

// ------------------------------------------------------------ HUD helpers --
function hudItem(icon, text, x, cy, color) {
    var gap = Math.round(4 * E.U);
    var isz = Math.round(14 * E.U);
    var tx = x;
    if (icon) {
        E.ui.icon(icon, x, cy - isz / 2, isz, { color: color });
        tx += isz + gap;
    }
    if (text !== undefined) {
        _bt.ts = 'small'; _bt.color = color === undefined ? TK.text : color;
        _bt.align = 'left'; _bt.valign = 'middle'; _bt.fit = 0; _bt.screen = true;
        var tw = E.gfx.measure(String(text), _bt);
        E.gfx.text(String(text), tx, cy, _bt);
        tx += tw;
    }
    return tx + Math.round(10 * E.U);
}
function hudItemR(icon, text, right, cy, color) {
    var gap = Math.round(4 * E.U);
    var isz = Math.round(14 * E.U);
    var rx = right;
    if (text !== undefined) {
        _bt.ts = 'small'; _bt.color = color === undefined ? TK.text : color;
        _bt.align = 'right'; _bt.valign = 'middle'; _bt.fit = 0; _bt.screen = true;
        var tw = E.gfx.measure(String(text), _bt);
        E.gfx.text(String(text), rx, cy, _bt);
        rx -= tw + gap;
    }
    if (icon) {
        E.ui.icon(icon, rx - isz, cy - isz / 2, isz, { color: color });
        rx -= isz + gap;
    }
    return rx - Math.round(10 * E.U);
}

// texto centrado de tela (ts, cor) pelo scratch
function ctext(str, y, ts, color, shadow) {
    _tx.ts = ts;
    _tx.color = color;
    _tx.valign = undefined;
    _tx.shadow = shadow;
    E.gfx.text(str, E.W / 2, y, _tx);
    _tx.shadow = undefined;
}

// quebra de linha por palavras dentro de maxW (px) — devolve as linhas
// (\n quebra o paragrafo: a fala com linha em branco saia emendada; \r do
// CRLF sai — texto colado do Windows desenhava o CR como glifo)
function wrap(str, maxW, st) {
    var out = [], word, line;
    var paras = String(str).split('\r').join('').split('\n');
    _wM.font = st.font; _wM.size = st.size;
    for (var p = 0; p < paras.length; p++) {
        var words = paras[p].split(' ');
        line = '';
        for (var i = 0; i < words.length; i++) {
            word = words[i];
            var probe = line ? line + ' ' + word : word;
            if (line && E.gfx.measure(probe, _wM) > maxW) {
                out.push(line);
                line = word;
            } else {
                line = probe;
            }
        }
        if (line || p < paras.length - 1) out.push(line);
    }
    return out;
}

// a caixa desenhada fora da camada (muda) e apagada quando o dialogo fecha
function apagaDialogo(d) {
    var bb = d._bb;
    if (!bb || !E.dirty.on) return;
    E.dirty.erase(bb[0], bb[1], bb[2], bb[3]);
    d._bb = null;
}

// toque/tempo do dialogo (corre mesmo quando o desenho mudo foi pulado)
function dialogInput(d, o, x, y, w, h) {
    if (!E.input.tap) _tapUsed = false;
    var tap = (o.tap === false || _tapUsed) ? null : E.input.tap;
    if (tap && tap.x >= x && tap.x <= x + w && tap.y >= y && tap.y <= y + h) {
        _tapUsed = true;
        d.next();
    }
    if (o.realtime) {
        var agora = S.millis();
        d.t += d._rt ? (agora - d._rt) / 1000 : 0;
        d._rt = agora;
    } else d.t += E.dt;
    if (d.closed) apagaDialogo(d);
    return !d.closed;
}

// ------------------------------------------------------------ E.ui ---------

E.ui = {
    version: '1.3.0',
    tokens: TK,

    // patch de tokens (aceita '#rrggbb'); guarda para reaplicar se o E.theme
    // mudar (E.init de outro app no mesmo processo)
    theme: function (patch) {
        ensure();
        if (patch) {
            if (!TK._custom) TK._custom = {};
            for (var k in patch) {
                if (!patch.hasOwnProperty(k)) continue;
                TK._custom[k] = patch[k];
            }
            applyPatch(patch);
        }
        return TK;
    },
    // soft (default), flat (sem sombra/gradiente), neon (borda/glow accent),
    // paper (claro, cantos retos)
    preset: function (name) {
        applyPreset(name || 'soft', E.theme);
        return TK;
    },
    resetTheme: function () {
        TK._custom = null;
        applyPreset('soft', E.theme);
        return TK;
    },

    // icone vetorial (24 nomes); devolve o rect em scratch (nao guarde)
    icon: function (name, x, y, size, o) {
        ensure();
        o = o || EMPTY;
        var s = size === undefined ? Math.round(16 * E.U) : size;
        var c = o.color === undefined ? TK.text : o.color;
        var w = o.w === undefined ? Math.max(1, Math.round(s * 0.12)) : o.w;
        (ICONS[name] || ICONS.dot)(x, y, s, c, w);
        _icr.x = x; _icr.y = y; _icr.w = s; _icr.h = s;
        return _icr;
    },

    // layout vertical/horizontal: next(h[, w]) devolve o proximo rect
    // (scratch — use na hora); end() = altura total usada
    stack: function (x, y, w, o) {
        ensure();
        o = o || EMPTY;
        var st = {
            x: x, y: y, w: w, dir: o.dir || 'v',
            gap: o.gap === undefined ? Math.round(TK.gap * E.U) : o.gap,
            pad: o.pad === undefined ? 0 : o.pad,
            cursor: 0
        };
        st.next = function (h, ww) {
            _nr.x = st.dir === 'h' ? st.x + st.cursor : st.x;
            _nr.y = st.dir === 'h' ? st.y : st.y + st.cursor;
            _nr.w = ww === undefined ? st.w : ww;
            _nr.h = h;
            st.cursor += (st.dir === 'h' ? _nr.w : h) + st.gap;
            return _nr;
        };
        st.reset = function () { st.cursor = 0; };
        st.end = function () { return st.cursor > 0 ? st.cursor - st.gap : 0; };
        return st;
    },

    // grade: cell(i[, h]) devolve o rect da celula (scratch); height(n) = total
    grid: function (x, y, w, cols, o) {
        ensure();
        o = o || EMPTY;
        cols = cols > 0 ? cols | 0 : 1;
        var gap = o.gap === undefined ? Math.round(TK.gap * E.U) : o.gap;
        var rowH = o.rowH === undefined ? Math.round(34 * E.U) : o.rowH;
        var cw = Math.floor((w - gap * (cols - 1)) / cols);
        return {
            cols: cols, cw: cw, gap: gap, rowH: rowH,
            cell: function (i, h) {
                _nr.x = x + (i % cols) * (cw + gap);
                _nr.y = y + ((i / cols) | 0) * (rowH + gap);
                _nr.w = cw;
                _nr.h = h === undefined ? rowH : h;
                return _nr;
            },
            height: function (n) {
                return Math.ceil(n / cols) * (rowH + gap) - gap;
            }
        };
    },

    // card: painel com elevacao/grad/borda; devolve o CONTENT rect (com pad)
    card: function (x, y, w, h, o) {
        ensure();
        o = o || EMPTY;
        var pad = o.pad === undefined ? Math.round(TK.pad * E.U) : o.pad;
        _co.screen = o.screen === undefined ? true : o.screen;
        _co.r = o.r === undefined ? Math.round(TK.radius * E.U) : o.r;
        _co.fill = true;
        _co.bw = o.bw === undefined ? TK.bw : o.bw;
        _co.stroke = pick(o.stroke, TK.outline, TK.outline);
        _co.bg = pick(o.bg, TK.surface, TK.surface);
        _co.elev = o.elev === undefined ? (o.flat ? 0 : TK.shadow) : o.elev;
        _co.shadow = o.shadow;
        _co.pad = pad;
        _co.grad = o.grad;
        if (_co.grad === undefined && TK.grad && !o.flat) {
            _cg.a = C.mix(_co.bg, 0xFFFF, 0.05);
            _cg.b = _co.bg;
            _cg.dir = 'y';
            _cg.via = undefined;
            _cg.step = 4;
            _co.grad = _cg;
        }
        return E.gfx.panel(x, y, w, h, _co);
    },

    divider: function (x, y, w, o) {
        ensure();
        E.gfx.divider(x, y, w, o);
    },

    // titulo de secao (caixa alta, textDim); devolve a altura usada
    section: function (title, x, y, w, o) {
        ensure();
        o = o || EMPTY;
        _bt.ts = 'tiny';
        _bt.color = o.color === undefined ? TK.textDim : o.color;
        _bt.align = 'left';
        _bt.valign = 'top';
        _bt.fit = w || 0;
        _bt.screen = true;
        E.gfx.text(String(title).toUpperCase(), x, y, _bt);
        if (o.line) E.gfx.divider(x, y + Math.round(14 * E.U), w,
                                  { color: TK.outline, screen: true });
        return Math.round(16 * E.U);
    },

    // botao immediate-mode; devolve true no tap. variant:
    // primary|secondary|ghost|danger|success; icon opcional
    button: function (label, x, y, w, h, o) {
        ensure();
        o = o || EMPTY;
        var variant = o.variant || (o.primary === false ? 'secondary' : 'primary');
        var disabled = !!o.disabled;
        var primary = variant === 'primary';
        var danger = variant === 'danger';
        var success = variant === 'success';
        var ghost = variant === 'ghost';
        var rad = o.r === undefined ? Math.round(Math.min(h * 0.32, TK.radius * E.U)) : o.r;
        var rect = { x: x, y: y, w: w, h: h };
        var on = !disabled && E.press(rect);
        var bg, fg, border, grad, elev;
        if (disabled) {
            bg = TK.surface2; fg = TK.textDim; border = TK.outline;
            grad = undefined; elev = 0;
        } else if (ghost) {
            bg = on ? TK.surface2 : undefined; fg = TK.accent;
            border = undefined; grad = undefined; elev = 0;
        } else if (danger) {
            bg = on ? C.mix(TK.err, 0x0000, 0.18) : TK.err;
            fg = 0xFFFF; border = TK.err; grad = undefined; elev = 0;
        } else if (success) {
            bg = on ? C.mix(TK.ok, 0x0000, 0.18) : TK.ok;
            fg = 0x0000; border = TK.ok; grad = undefined; elev = 0;
        } else if (primary) {
            bg = on ? C.mix(TK.accent, 0x0000, 0.16) : TK.accent;
            fg = TK.onAccent;
            border = TK.glowOn ? TK.accent2 : undefined;
            elev = o.elev === undefined ? (TK.shadow > 0 ? 1 : 0) : o.elev;
            if (TK.grad && !on && o.grad !== false) {
                _cg.a = C.mix(TK.accent, 0xFFFF, 0.10);
                _cg.b = TK.accent2;
                _cg.dir = 'y';
                _cg.via = undefined;
                _cg.step = 4;
                grad = _cg;
            } else grad = undefined;
        } else {
            bg = on ? TK.surface3 : TK.surface2;
            fg = TK.text; border = TK.outline; grad = undefined; elev = 0;
        }
        _bo.screen = true; _bo.r = rad; _bo.fill = true;
        _bo.bw = border === undefined ? 0 : (TK.bw > 1 && !ghost ? TK.bw : 1);
        _bo.stroke = border;
        _bo.grad = grad;
        _bo.elev = elev;
        _bo.shadow = o.shadow;
        _bo.bg = TK.bg;
        if (bg !== undefined) E.gfx.rect(x, y, w, h, bg, _bo);
        else if (border !== undefined) E.gfx.rect(x, y, w, h, border, _boS);
        var pad = Math.round(8 * E.U);
        var isz = Math.round(Math.min(h * 0.50, 18 * E.U));
        var tx = x + w / 2;
        var al = 'center';
        var fit = w - pad * 2;
        if (o.icon) {
            var gap = Math.round(6 * E.U);
            var lw = label ? textW(label, o.ts || 'body') : 0;
            var gw = isz + (lw ? gap + lw : 0);
            var gx = o.align === 'left' ? x + pad : x + Math.round((w - gw) / 2);
            E.ui.icon(o.icon, gx, y + (h - isz) / 2, isz, { color: fg });
            if (label) {
                tx = gx + isz + gap;
                al = 'left';
                fit = w - (tx - x) - pad;
            }
        } else if (o.align === 'left') {
            tx = x + pad;
            al = 'left';
        }
        if (fit < 4) fit = 4;
        if (label) {
            _bt.ts = o.ts || 'body';
            _bt.color = fg;
            _bt.align = al;
            _bt.valign = 'middle';
            _bt.fit = fit;
            _bt.screen = true;
            E.gfx.text(label, tx, y + h / 2, _bt);
        }
        E._btns.push(rect);
        return !disabled && tapIn(x, y, w, h, 0);
    },

    iconButton: function (icon, x, y, size, o) {
        ensure();
        o = o || EMPTY;
        return E.ui.button('', x, y, size, size, {
            variant: o.variant || 'ghost',
            icon: icon,
            r: o.r,
            disabled: o.disabled
        });
    },

    // switch; devolve o NOVO estado. o.label desenha a direita (fora do hit)
    toggle: function (x, y, on, o) {
        ensure();
        o = o || EMPTY;
        var w = o.w === undefined ? Math.round(44 * E.U) : o.w;
        var h = o.h === undefined ? Math.round(24 * E.U) : o.h;
        var r = h / 2;
        _bo.screen = true; _bo.r = r; _bo.fill = true; _bo.bw = 0;
        _bo.stroke = undefined; _bo.grad = undefined; _bo.elev = 0;
        _bo.shadow = undefined; _bo.bg = undefined;
        E.gfx.rect(x, y, w, h, on ? TK.accent : TK.surface3, _bo);
        _boS.r = r; _boS.screen = true;
        E.gfx.rect(x, y, w, h, on ? TK.accent : TK.outline, _boS);
        var kr = r - Math.round(2 * E.U);
        var kx = on ? x + w - r : x + r;
        E.gfx.circle(kx, y + r, kr, on ? TK.onAccent : TK.textDim, _ici);
        if (o.label) {
            _bt.ts = o.ts || 'body'; _bt.color = TK.text;
            _bt.align = 'left'; _bt.valign = 'middle';
            _bt.fit = o.lw === undefined ? 0 : o.lw; _bt.screen = true;
            E.gfx.text(o.label, x + w + Math.round(8 * E.U), y + r, _bt);
        }
        return tapIn(x, y, w, h, Math.round(4 * E.U)) ? !on : on;
    },

    check: function (label, x, y, on, o) {
        ensure();
        o = o || EMPTY;
        var s = o.size === undefined ? Math.round(20 * E.U) : o.size;
        var gap = Math.round(8 * E.U);
        var w = o.w === undefined
              ? s + (label ? gap + textW(label, o.ts || 'body') : 0)
              : o.w;
        var h = Math.max(s, Math.round(22 * E.U));
        var by = y + (h - s) / 2;
        _bo.screen = true; _bo.r = Math.round(5 * E.U); _bo.fill = true; _bo.bw = 0;
        _bo.stroke = undefined; _bo.grad = undefined; _bo.elev = 0;
        _bo.shadow = undefined; _bo.bg = undefined;
        E.gfx.rect(x, by, s, s, on ? TK.accent : TK.surface2, _bo);
        _boS.r = Math.round(5 * E.U); _boS.screen = true;
        E.gfx.rect(x, by, s, s, on ? TK.accent : TK.outline, _boS);
        if (on) E.ui.icon('check', x + s * 0.18, by + s * 0.18, s * 0.64,
                          { color: TK.onAccent, w: Math.max(1, Math.round(s * 0.12)) });
        if (label) {
            _bt.ts = o.ts || 'body'; _bt.color = TK.text;
            _bt.align = 'left'; _bt.valign = 'middle';
            _bt.fit = w - s - gap; _bt.screen = true;
            E.gfx.text(label, x + s + gap, y + h / 2, _bt);
        }
        return tapIn(x, y, w, h) ? !on : on;
    },

    radio: function (label, x, y, on, o) {
        ensure();
        o = o || EMPTY;
        var s = o.size === undefined ? Math.round(20 * E.U) : o.size;
        var gap = Math.round(8 * E.U);
        var w = o.w === undefined
              ? s + (label ? gap + textW(label, o.ts || 'body') : 0)
              : o.w;
        var h = Math.max(s, Math.round(22 * E.U));
        var cx = x + s / 2, cy = y + h / 2, r = s / 2;
        E.gfx.circle(cx, cy, r, TK.outline, _ici);
        E.gfx.circle(cx, cy, r - Math.max(1, Math.round(E.U)), TK.surface2, _ici);
        if (on) E.gfx.circle(cx, cy, r * 0.48, TK.accent, _ici);
        if (label) {
            _bt.ts = o.ts || 'body'; _bt.color = TK.text;
            _bt.align = 'left'; _bt.valign = 'middle';
            _bt.fit = w - s - gap; _bt.screen = true;
            E.gfx.text(label, x + s + gap, cy, _bt);
        }
        return tapIn(x, y, w, h) ? !on : on;
    },

    // slider: arrasto que COMECA na area; devolve o valor (snap por step)
    slider: function (x, y, w, value, o) {
        ensure();
        o = o || EMPTY;
        var min = o.min === undefined ? 0 : o.min;
        var max = o.max === undefined ? 100 : o.max;
        if (max <= min) max = min + 1;
        var step = o.step === undefined ? 1 : o.step;
        if (!(step > 0)) step = 1;
        var h = o.h === undefined ? Math.round(28 * E.U) : o.h;
        var th = o.th === undefined ? Math.round(6 * E.U) : o.th;
        var kr = o.kr === undefined ? Math.round(9 * E.U) : o.kr;
        var id = o.id || 'slider';
        var t = (value - min) / (max - min);
        if (t < 0) t = 0; if (t > 1) t = 1;
        if (!E.input.down) { if (_sOn === id) _sOn = null; }
        if (E.input.justDown && downIn(x, y, w, h, kr)) _sOn = id;
        if (_sOn === id && E.input.down) {
            t = (E.input.x - x) / (w || 1);
            if (t < 0) t = 0; if (t > 1) t = 1;
            value = min + t * (max - min);
            value = Math.round(value / step) * step;
            if (value < min) value = min; if (value > max) value = max;
            t = (value - min) / (max - min);
        }
        var ty = y + h / 2 - th / 2;
        _bo.screen = true; _bo.r = th / 2; _bo.fill = true; _bo.bw = 0;
        _bo.stroke = undefined; _bo.grad = undefined; _bo.elev = 0;
        _bo.shadow = undefined; _bo.bg = undefined;
        E.gfx.rect(x, ty, w, th, TK.surface3, _bo);
        if (t > 0.001) E.gfx.rect(x, ty, Math.max(th, w * t), th, TK.accent, _bo);
        E.gfx.circle(x + w * t, y + h / 2, kr, TK.text, _ici);
        if (o.label) {
            _bt.ts = 'tiny'; _bt.color = TK.textDim;
            _bt.align = 'left'; _bt.valign = 'bottom';
            _bt.fit = w; _bt.screen = true;
            E.gfx.text(o.label, x, y + h / 2 - kr - Math.round(2 * E.U), _bt);
        }
        if (o.fmt) {
            _bt.ts = 'tiny'; _bt.color = TK.textDim;
            _bt.align = 'right'; _bt.valign = 'bottom';
            _bt.fit = w; _bt.screen = true;
            E.gfx.text(String(o.fmt(value)), x + w, y + h / 2 - kr - Math.round(2 * E.U), _bt);
        }
        return value;
    },

    // +/- com valor no meio; devolve o novo valor
    stepper: function (x, y, value, o) {
        ensure();
        o = o || EMPTY;
        var min = o.min === undefined ? 0 : o.min;
        var max = o.max === undefined ? 100 : o.max;
        var step = o.step === undefined ? 1 : o.step;
        if (!(step > 0)) step = 1;
        var h = o.h === undefined ? Math.round(32 * E.U) : o.h;
        var w = o.w === undefined ? Math.round(104 * E.U) : o.w;
        var bw = h;
        if (E.ui.button('', x, y, bw, h,
                        { variant: 'secondary', icon: 'minus', r: Math.round(8 * E.U) }))
            value -= step;
        if (E.ui.button('', x + w - bw, y, bw, h,
                        { variant: 'secondary', icon: 'plus', r: Math.round(8 * E.U) }))
            value += step;
        value = Math.round(value / step) * step;
        if (value < min) value = min;
        if (value > max) value = max;
        _bt.ts = o.ts || 'label';
        _bt.color = TK.text;
        _bt.align = 'center';
        _bt.valign = 'middle';
        _bt.fit = w - bw * 2 - Math.round(8 * E.U);
        _bt.screen = true;
        E.gfx.text(String(o.fmt ? o.fmt(value) : value), x + w / 2, y + h / 2, _bt);
        return value;
    },

    // controle segmentado (pill unico); devolve o selecionado
    segmented: function (x, y, w, labels, sel, o) {
        ensure();
        o = o || EMPTY;
        var n = labels.length;
        if (!(n > 0)) return sel;
        var h = o.h === undefined ? Math.round(32 * E.U) : o.h;
        var gap = o.gap === undefined ? Math.round(3 * E.U) : o.gap;
        var sw = (w - gap * (n - 1)) / n;
        var i, bx, on;
        _bo.screen = true; _bo.r = h / 2; _bo.fill = true; _bo.bw = 0;
        _bo.stroke = undefined; _bo.grad = undefined; _bo.elev = 0;
        _bo.shadow = undefined; _bo.bg = undefined;
        E.gfx.rect(x, y, w, h, TK.surface2, _bo);
        _boS.r = h / 2; _boS.screen = true;
        E.gfx.rect(x, y, w, h, TK.outline, _boS);
        for (i = 0; i < n; i++) {
            bx = x + i * (sw + gap);
            on = i === sel;
            if (on) {
                _bo.r = (h - Math.round(4 * E.U)) / 2;
                E.gfx.rect(bx + gap / 2, y + Math.round(2 * E.U),
                           sw - gap, h - Math.round(4 * E.U), TK.accent, _bo);
            }
            _bt.ts = o.ts || 'body';
            _bt.color = on ? TK.onAccent : TK.textDim;
            _bt.align = 'center'; _bt.valign = 'middle';
            _bt.fit = sw - Math.round(4 * E.U); _bt.screen = true;
            E.gfx.text(labels[i], bx + sw / 2, y + h / 2, _bt);
            if (tapIn(bx, y, sw, h)) sel = i;
        }
        return sel;
    },

    // abas com indicador inferior; devolve a selecionada
    tabs: function (x, y, w, h, labels, sel, o) {
        ensure();
        o = o || EMPTY;
        var n = labels.length;
        if (!(n > 0)) return sel;
        var tw = w / n, i, on;
        for (i = 0; i < n; i++) {
            on = i === sel;
            _bt.ts = o.ts || 'body';
            _bt.color = on ? TK.text : TK.textDim;
            _bt.align = 'center'; _bt.valign = 'middle';
            _bt.fit = tw - Math.round(8 * E.U); _bt.screen = true;
            E.gfx.text(labels[i], x + i * tw + tw / 2, y + h / 2, _bt);
            if (on) {
                _bo.r = 1; _bo.screen = true; _bo.fill = true; _bo.bw = 0;
                _bo.stroke = undefined; _bo.grad = undefined; _bo.elev = 0;
                _bo.shadow = undefined; _bo.bg = undefined;
                E.gfx.rect(x + i * tw + Math.round(8 * E.U),
                           y + h - Math.round(3 * E.U),
                           tw - Math.round(16 * E.U), Math.max(2, Math.round(2 * E.U)),
                           TK.accent, _bo);
            }
            if (tapIn(x + i * tw, y, tw, h)) sel = i;
        }
        E.gfx.divider(x, y + h - Math.max(1, Math.round(E.U)), w,
                      { color: TK.outline, screen: true });
        return sel;
    },

    // chip/pill tocavel; devolve o novo estado (o.on)
    chip: function (label, x, y, o) {
        ensure();
        o = o || EMPTY;
        var h = o.h === undefined ? Math.round(26 * E.U) : o.h;
        var pad = Math.round(10 * E.U);
        var isz = o.icon ? Math.round(h * 0.55) : 0;
        var w = o.w === undefined
              ? pad * 2 + textW(label, o.ts || 'small') + (isz ? isz + Math.round(6 * E.U) : 0)
              : o.w;
        var on = !!o.on;
        _bo.screen = true; _bo.r = h / 2; _bo.fill = true; _bo.bw = 0;
        _bo.stroke = undefined; _bo.grad = undefined; _bo.elev = 0;
        _bo.shadow = undefined; _bo.bg = undefined;
        E.gfx.rect(x, y, w, h, on ? TK.accent : TK.surface2, _bo);
        _boS.r = h / 2; _boS.screen = true;
        E.gfx.rect(x, y, w, h, on ? TK.accent : TK.outline, _boS);
        var tx = x + pad;
        if (o.icon) {
            E.ui.icon(o.icon, x + pad, y + (h - isz) / 2, isz,
                      { color: on ? TK.onAccent : TK.text });
            tx += isz + Math.round(6 * E.U);
        }
        _bt.ts = o.ts || 'small';
        _bt.color = on ? TK.onAccent : TK.text;
        _bt.align = 'left'; _bt.valign = 'middle';
        _bt.fit = w - (tx - x) - pad; _bt.screen = true;
        E.gfx.text(label, tx, y + h / 2, _bt);
        return tapIn(x, y, w, h) ? !on : on;
    },

    badge: function (text, x, y, o) {
        ensure();
        o = o || EMPTY;
        var ts = o.ts || 'tiny';
        var h = o.h === undefined ? Math.round(18 * E.U) : o.h;
        var pad = Math.round(6 * E.U);
        var w = o.w === undefined ? textW(text, ts) + pad * 2 : o.w;
        _bo.screen = true; _bo.r = h / 2; _bo.fill = true; _bo.bw = 0;
        _bo.stroke = undefined; _bo.grad = undefined; _bo.elev = 0;
        _bo.shadow = undefined; _bo.bg = undefined;
        E.gfx.rect(x, y, w, h, o.color === undefined ? TK.accent2 : o.color, _bo);
        _bt.ts = ts;
        _bt.color = o.textColor === undefined ? TK.text : o.textColor;
        _bt.align = 'center'; _bt.valign = 'middle';
        _bt.fit = w - pad; _bt.screen = true;
        E.gfx.text(text, x + w / 2, y + h / 2, _bt);
        return w;
    },

    progress: function (x, y, w, h, frac, o) {
        ensure();
        o = o || EMPTY;
        var f = frac < 0 ? 0 : (frac > 1 ? 1 : frac);
        var r = o.r === undefined ? h / 2 : o.r;
        _bo.screen = true; _bo.r = r; _bo.fill = true; _bo.bw = 0;
        _bo.stroke = undefined; _bo.grad = undefined; _bo.elev = 0;
        _bo.shadow = undefined; _bo.bg = undefined;
        E.gfx.rect(x, y, w, h, o.bg === undefined ? TK.surface3 : o.bg, _bo);
        if (f > 0.005) {
            var fg = o.fg === undefined ? TK.accent : o.fg;
            if (o.grad) {
                _go.screen = true; _go.r = r; _go.dir = 'x';
                _go.via = undefined; _go.step = 3;
                E.gfx.gradient(x, y, Math.max(h, w * f), h, fg,
                               o.fg2 === undefined ? TK.accent2 : o.fg2, _go);
            } else {
                E.gfx.rect(x, y, Math.max(h, w * f), h, fg, _bo);
            }
        }
        return f;
    },

    ring: function (cx, cy, r, frac, o) {
        ensure();
        o = o || EMPTY;
        var th = o.th === undefined ? Math.round(5 * E.U) : o.th;
        var f = frac < 0 ? 0 : (frac > 1 ? 1 : frac);
        E.gfx.arc(cx, cy, Math.max(0, r - th), r, 0, 360,
                  o.bg === undefined ? TK.surface3 : o.bg, _ia);
        if (f > 0.005) {
            E.gfx.arc(cx, cy, Math.max(0, r - th), r, -90, -90 + 360 * f,
                      o.color === undefined ? TK.accent : o.color, _ia);
        }
        if (o.label !== undefined) {
            _bt.ts = o.ts || 'label';
            _bt.color = o.textColor === undefined ? TK.text : o.textColor;
            _bt.align = 'center'; _bt.valign = 'middle';
            _bt.fit = r * 1.4; _bt.screen = true;
            E.gfx.text(String(o.label), cx, cy, _bt);
        }
        return f;
    },

    // scroll generico com clip+inercia+scrollbar; drawFn(offset, x, y, w, h)
    scroll: function (id, x, y, w, h, contentH, drawFn) {
        ensure();
        id = id || 'scroll';
        var s = scrollState(id);
        var maxScroll = scrollStep(s, x, y, w, h, contentH);
        if (E.caps.clip) S.setClip(x, y, w, h);
        if (drawFn) drawFn(s.scroll, x, y, w, h);
        if (E.caps.clip) S.clearClip();
        scrollbar(x, y, w, h, contentH, s.scroll, maxScroll);
        return s.scroll;
    },
    scrollTo: function (id, y) {
        var s = scrollState(id);
        s.scroll = y > 0 ? y : 0;
        s.vel = 0;
    },
    resetScroll: function (id) {
        E.ui.scrollTo(id, 0);
    },

    // menu vertical immediate-mode: items = ["Jogar", ...] ou
    // [{label, value, danger, disabled, icon, variant}]. Devolve o value
    // (ou label) do item tocado neste quadro, ou null.
    menu: function (items, o) {
        ensure();
        o = o || EMPTY;
        var n = items.length;
        var rowH = o.row || Math.round(40 * E.U);
        var w = o.w || Math.round(180 * E.U);
        var x = o.x === undefined ? Math.round((E.W - w) / 2) : o.x;
        var y = o.y === undefined ? Math.round(E.H * 0.3) : o.y;
        var firstPrimary = o.primary !== false;
        var picked = null;
        for (var i = 0; i < n; i++) {
            var it = typeof items[i] === 'string' ? { label: items[i] } : items[i];
            var variant;
            if (it.disabled) variant = 'secondary';
            else if (it.danger) variant = 'danger';
            else if (it.variant) variant = it.variant;
            else variant = (i === 0 && firstPrimary) ? 'primary' : 'secondary';
            _mOp.variant = variant;
            _mOp.icon = it.icon;
            _mOp.disabled = !!it.disabled;
            if (E.ui.button(it.label, x, y + i * rowH, w,
                            rowH - Math.round(4 * E.U), _mOp)) {
                picked = it.value !== undefined ? it.value : it.label;
            }
        }
        return picked;
    },

    // lista COM ROLAGEM (retida — guarde o retorno): arrastar rola, tap
    // seco devolve/calls onPick com o item. items: string ou
    // {label, value, sub, icon, right, badge, disabled, danger, section}.
    // o.row(item, x, y, w, h, state) pinta a linha inteira (custom).
    list: function (o) {
        ensure();
        var st = { items: o.items || [], row: o.row || Math.round(28 * E.U),
                   scroll: 0, _dragOn: false, _dragY: 0, _vel: 0,
                   onPick: o.onPick || null, picked: null, index: -1 };
        st.scrollTo = function (index) {
            st.scroll = index * st.row;
            st._vel = 0;
        };
        st.scrollBy = function (dy) {
            st.scroll += dy;
            st._vel = 0;
        };
        st.draw = function (x, y, w, h) {
            var i = E.input;
            var fired = null;
            var content = st.items.length * st.row;
            var maxScroll = scrollStep(st, x, y, w, h, content);
            var pad = o.pad === undefined ? Math.round(6 * E.U) : o.pad;
            _lpo.screen = true;
            _lpo.r = o.r === undefined ? Math.round(TK.radius * E.U) : o.r;
            _lpo.fill = true;
            _lpo.bw = o.bw === undefined ? TK.bw : o.bw;
            _lpo.stroke = TK.outline;
            _lpo.bg = pick(o.bg, TK.surface, TK.surface);
            _lpo.grad = undefined;
            _lpo.elev = o.elev === undefined ? 0 : o.elev;
            _lpo.shadow = o.shadow;
            _lpo.pad = 0;
            E.gfx.panel(x, y, w, h, _lpo);
            if (!i.tap) _tapUsed = false;
            var tap = _tapUsed ? null : i.tap;
            var k0 = Math.floor(st.scroll / st.row);
            var k1 = Math.min(st.items.length - 1,
                              Math.ceil((st.scroll + h) / st.row) - 1);
            if (E.caps.clip) S.setClip(x, y, w, h);
            for (var k = k0; k <= k1; k++) {
                var it = st.items[k];
                if (it === undefined) continue;
                var isStr = typeof it === 'string';
                var ry = y + k * st.row - st.scroll;
                if (!isStr && (it.section || it.header)) {
                    _bt.ts = 'tiny';
                    _bt.color = it.color === undefined ? TK.textDim : it.color;
                    _bt.align = 'left'; _bt.valign = 'middle';
                    _bt.fit = w - pad * 2; _bt.screen = true;
                    E.gfx.text(String(it.label !== undefined ? it.label : it.section)
                               .toUpperCase(), x + pad, ry + st.row / 2, _bt);
                    continue;
                }
                var dis = !isStr && !!it.disabled;
                var danger = !isStr && !!it.danger;
                var noTap = dis || !tap || tap.x < x || tap.x > x + w ||
                            tap.y < ry || tap.y > ry + st.row;
                _lRect.x = x; _lRect.y = ry; _lRect.w = w; _lRect.h = st.row;
                var pressed = !dis && E.press(_lRect);
                if (pressed || !noTap) {
                    _bo.r = Math.round(6 * E.U); _bo.screen = true; _bo.fill = true;
                    _bo.bw = 0; _bo.stroke = undefined; _bo.grad = undefined;
                    _bo.elev = 0; _bo.shadow = undefined; _bo.bg = undefined;
                    E.gfx.rect(x + 2, ry + 2, w - 4, st.row - 4, TK.surface2, _bo);
                }
                var label = isStr ? it : (it.label !== undefined ? it.label : '');
                var color = dis ? TK.textDim
                          : (danger ? TK.err
                          : (!isStr && it.color !== undefined ? it.color : TK.text));
                if (o.paintRow) {
                    o.paintRow(it, x + pad, ry, w - pad * 2, st.row,
                               { pressed: pressed, disabled: dis, selected: k === st.index });
                } else {
                    var tx = x + pad;
                    if (!isStr && it.icon) {
                        var isz = Math.round(16 * E.U);
                        E.ui.icon(it.icon, tx, ry + (st.row - isz) / 2, isz, { color: color });
                        tx += isz + Math.round(6 * E.U);
                    }
                    var sub = !isStr && it.sub;
                    var right = !isStr && it.right;
                    var rw = right ? textW(String(right), 'small') + Math.round(8 * E.U) : 0;
                    _bt.ts = sub ? 'body' : (o.ts || 'body');
                    _bt.color = color;
                    _bt.align = 'left';
                    _bt.valign = sub ? 'top' : 'middle';
                    _bt.fit = w - (tx - x) - pad - rw;
                    _bt.screen = true;
                    E.gfx.text(label, tx, sub ? ry + st.row * 0.26 : ry + st.row / 2, _bt);
                    if (sub) {
                        _bt.ts = 'tiny';
                        _bt.color = TK.textDim;
                        _bt.valign = 'top';
                        E.gfx.text(String(sub), tx, ry + st.row * 0.58, _bt);
                    }
                    if (right) {
                        _bt.ts = 'small'; _bt.color = TK.textDim;
                        _bt.align = 'right'; _bt.valign = 'middle';
                        _bt.fit = w - pad;
                        E.gfx.text(String(right), x + w - pad, ry + st.row / 2, _bt);
                    } else if (!isStr && it.badge !== undefined) {
                        var bwt = textW(String(it.badge), 'tiny') + Math.round(12 * E.U);
                        _bo.r = Math.round(9 * E.U); _bo.screen = true; _bo.fill = true;
                        _bo.bw = 0; _bo.stroke = undefined; _bo.grad = undefined;
                        _bo.elev = 0; _bo.shadow = undefined; _bo.bg = undefined;
                        E.gfx.rect(x + w - pad - bwt,
                                   ry + (st.row - Math.round(18 * E.U)) / 2,
                                   bwt, Math.round(18 * E.U),
                                   it.badgeColor === undefined ? TK.accent2 : it.badgeColor, _bo);
                        _bt.ts = 'tiny';
                        _bt.color = it.badgeColor === undefined ? TK.text : C.contrast(it.badgeColor);
                        _bt.align = 'center'; _bt.valign = 'middle';
                        _bt.fit = bwt;
                        E.gfx.text(String(it.badge), x + w - pad - bwt / 2,
                                   ry + st.row / 2, _bt);
                    }
                }
                if (!noTap) {
                    tap = null;
                    _tapUsed = true;
                    st.picked = isStr ? it : (it.value !== undefined ? it.value : it.label);
                    st.index = k;
                    fired = st.picked;
                    if (st.onPick) st.onPick(st.picked, k);
                }
            }
            if (E.caps.clip) S.clearClip();
            scrollbar(x, y, w, h, content, st.scroll, maxScroll);
            return fired;
        };
        return st;
    },

    // dialogo com texto datilografado (retido): d.draw(x, y, w) desenha o
    // panel e revela `speed` chars/s; tap na caixa completa, tap de novo
    // fecha (draw devolve false). o.choices = [labels] vira botoes e
    // devolve a escolha em d.choice; o.sound = blip a cada N chars.
    dialog: function (text, o) {
        o = o || EMPTY;
        var pages = text && typeof text === 'object' && text.length !== undefined ? text : [text];
        function limpa(t) { return String(t).split('\r').join(''); }
        var d = { t: 0, done: false, closed: false, page: 0, pages: pages,
                  speed: o.speed === undefined ? 30 : o.speed, text: limpa(pages[0]),
                  choice: -1, _w: 0, _lines: null, _rt: 0, _snd: 0 };
        d.next = function () {
            if (d.closed) return false;
            if (!d.done) { d.t = d.text.length / d.speed; d.done = true; return true; }
            if (d.page < pages.length - 1) {
                d.page++;
                d.text = limpa(pages[d.page]);
                d.t = 0;
                d.done = false;
                d._lines = null;
                d._snd = 0;
                return true;
            }
            d.closed = true;
            apagaDialogo(d);
            return false;
        };
        d.draw = function (x, y, w) {
            if (d.closed) return false;
            var T = E.theme || EMPTY;
            w = w || Math.round(200 * E.U);
            var st = E.font(o.px || Math.round(13 * E.U));
            if (!d._lines || d._w !== w) {
                d._lines = wrap(d.text, w - Math.round(20 * E.U), st);
                d._w = w;
            }
            var ty0 = y + (o.name ? Math.round(20 * E.U) : Math.round(8 * E.U));
            var lh = Math.round(st.h + 2);
            var choices = o.choices && o.choices.length ? o.choices : null;
            var chH = choices ? Math.round(32 * E.U) : 0;
            var h = ty0 - y + d._lines.length * lh + Math.round(10 * E.U) +
                    (choices ? chH * choices.length + Math.round(8 * E.U) : 0);
            var n = Math.floor(d.t * d.speed);
            var completo = n >= d.text.length;
            var antesDone = d.done;
            if (completo) d.done = true;
            var D = E.dirty, mudo = false;
            if (D.on) {
                var key = d.page + '|' + (completo ? -1 : n) + '|' + x + '|' + y + '|' +
                          w + '|' + (choices ? choices.length : 0);
                var bb = d._bb;
                if (key === d._k && bb && !D.touches(bb[0], bb[1], bb[2], bb[3])) {
                    return dialogInput(d, o, x, y, w, h);
                }
                if (bb && (bb[0] !== x || bb[1] !== y || bb[2] !== w || bb[3] !== h)) {
                    D.erase(bb[0], bb[1], bb[2], bb[3]);
                }
                if (!bb) bb = d._bb = [0, 0, 0, 0];
                bb[0] = x; bb[1] = y; bb[2] = w; bb[3] = h;
                d._k = key;
                D._mute++;
                mudo = true;
            }
            _dPanel.r = Math.round(TK.radius * E.U);
            _dPanel.screen = true;
            _dPanel.bg = TK.surface;
            _dPanel.bw = TK.bw;
            _dPanel.stroke = TK.outline;
            _dPanel.elev = TK.shadow > 0 ? 1 : 0;
            _dPanel.pad = 8;
            E.gfx.panel(x, y, w, h, _dPanel);
            if (o.name) {
                _dName.color = TK.accent;
                E.gfx.text(o.name, x + Math.round(10 * E.U), y + Math.round(4 * E.U), _dName);
            }
            for (var li = 0; li < d._lines.length && n > 0; li++) {
                var ln = d._lines[li];
                var corte = ln.length <= n ? ln : ln.substring(0, n);
                n -= ln.length;
                _dTxt.font = st.font; _dTxt.size = st.size; _dTxt.color = TK.text;
                E.gfx.text(corte, x + Math.round(10 * E.U),
                           ty0 + li * lh, _dTxt);
            }
            if (o.sound && E.audio && !antesDone && !completo) {
                var passou = Math.floor(d.t * d.speed / (o.soundEvery || 6));
                if (passou > d._snd) {
                    d._snd = passou;
                    E.audio.sfx('ui');
                }
            }
            if (completo && choices) {
                var by = ty0 + d._lines.length * lh + Math.round(6 * E.U);
                for (var ci = 0; ci < choices.length; ci++) {
                    _mOp.variant = ci === 0 ? 'primary' : 'secondary';
                    _mOp.icon = choices[ci].icon;
                    _mOp.disabled = false;
                    var lbl = typeof choices[ci] === 'string'
                            ? choices[ci]
                            : (choices[ci].label !== undefined ? choices[ci].label : '');
                    if (E.ui.button(lbl, x + Math.round(10 * E.U), by,
                                    w - Math.round(20 * E.U), Math.round(28 * E.U), _mOp)) {
                        d.choice = ci;
                        d.closed = true;
                        apagaDialogo(d);
                    }
                    by += chH;
                }
            } else if (completo) {
                _arrow.color = TK.accent;
                E.gfx.text('>', x + w - Math.round(14 * E.U), y + h - Math.round(12 * E.U),
                           _arrow);
            }
            if (mudo) D._mute--;
            if (d.closed) return false;
            return dialogInput(d, o, x, y, w, h);
        };

        d.skip = function () { d.t = d.text.length / d.speed + 1; };
        d.close = function () { d.closed = true; apagaDialogo(d); };
        return d;
    },

    // modal centrado com veu + card + botoes; devolve o value do botao,
    // 'dismiss' (tap fora, o.dismiss !== false) ou null. id unico por modal
    // (a animacao e keyed). drawFn(contentRect) desenha o miolo custom.
    modal: function (id, o, drawFn) {
        ensure();
        if (!E.input.tap) _tapUsed = false;
        o = o || EMPTY;
        id = id || 'modal';
        var open = o.open === undefined ? true : !!o.open;
        var p = E.ui.anim(id, open ? 1 : 0, o.ms === undefined ? 180 : o.ms,
                          o.ease || 'outCubic');
        if (!open && p <= 0.001) return null;
        var W = E.W, H = E.H;
        _dimO.screen = true;
        _dimO.bg = o.bg === undefined ? TK.bg : o.bg;
        E.gfx.dim(0, 0, W, H, Math.round((o.dim === undefined ? 55 : o.dim) * p), _dimO);
        var w = o.w === undefined
              ? Math.min(W - Math.round(32 * E.U), Math.round(230 * E.U)) : o.w;
        var x = o.x === undefined ? Math.round((W - w) / 2) : o.x;
        var pad = Math.round(TK.pad * E.U);
        var tw = w - pad * 2;
        _mo.ts = 'body';
        var bodyLines = o.body ? E.gfx.wrap(String(o.body), tw, _mo) : null;
        var lh = Math.round(E.ts.body * E.U * 1.25);
        var nb = o.buttons ? o.buttons.length : 0;
        var bh = Math.round(38 * E.U);
        var h = o.h;
        if (h === undefined) {
            h = pad * 2 + (o.title ? Math.round(26 * E.U) : 0) +
                (bodyLines ? bodyLines.length * lh + Math.round(6 * E.U) : 0) +
                (drawFn ? Math.round(o.contentH || 0) : 0) +
                (nb ? bh + Math.round(8 * E.U) : 0);
            if (h < Math.round(90 * E.U)) h = Math.round(90 * E.U);
        }
        var y = o.y === undefined
              ? Math.round((H - h) / 2 + (1 - p) * Math.round(16 * E.U)) : o.y;
        var cardBg = C.mix(o.bg === undefined ? TK.bg : o.bg, TK.surface, p);
        _co.screen = true;
        _co.r = Math.round(TK.radius * E.U);
        _co.fill = true;
        _co.bw = TK.bw;
        _co.stroke = TK.outline;
        _co.bg = cardBg;
        _co.grad = undefined;
        _co.elev = TK.shadow > 0 ? 2 : 0;
        _co.shadow = undefined;
        _co.pad = 0;
        E.gfx.panel(x, y, w, h, _co);
        var cy = y + pad;
        if (o.title) {
            _bt.ts = o.titleTs || 'label'; _bt.color = TK.text;
            _bt.align = 'center'; _bt.valign = 'top';
            _bt.fit = tw; _bt.screen = true;
            E.gfx.text(o.title, x + w / 2, cy, _bt);
            cy += Math.round(26 * E.U);
        }
        if (bodyLines) {
            _bt.ts = 'body'; _bt.color = TK.textDim;
            _bt.align = 'center'; _bt.valign = 'top';
            _bt.fit = tw; _bt.screen = true;
            for (var i = 0; i < bodyLines.length; i++) {
                E.gfx.text(bodyLines[i], x + w / 2, cy + i * lh, _bt);
            }
            cy += bodyLines.length * lh + Math.round(6 * E.U);
        }
        if (drawFn) {
            var cr = contentRect(x + pad, cy, w - pad * 2,
                                 h - (cy - y) - pad - (nb ? bh + 8 * E.U : 0), 0);
            drawFn(cr);
            cy = cr.y + cr.h + Math.round(6 * E.U);
        }
        var act = null;
        if (nb && open) {
            var gap = Math.round(8 * E.U);
            var bw = (w - pad * 2 - gap * (nb - 1)) / nb;
            for (var j = 0; j < nb; j++) {
                var bt = o.buttons[j];
                _mOp.variant = bt.variant || (j === nb - 1 ? 'primary' : 'secondary');
                _mOp.icon = bt.icon;
                _mOp.disabled = !!bt.disabled;
                if (E.ui.button(bt.label, x + pad + j * (bw + gap),
                                y + h - pad - bh, bw, bh, _mOp)) {
                    act = bt.value !== undefined ? bt.value : bt.label;
                }
            }
        }
        if (act === null && open && o.dismiss !== false && !_tapUsed &&
            E.input.tap && !hitRect(x, y, w, h)) {
            _tapUsed = true;
            act = o.dismissValue === undefined ? 'dismiss' : o.dismissValue;
        }
        // o modal esta no TOPO: consome qualquer tap (inclusive dentro do
        // card fora de um botao) para a camada de baixo nao reagir
        if (open && E.input.tap) _tapUsed = true;
        return act;
    },

    // bottom sheet com veu/handle; devolve 'close' (tap fora) ou null
    sheet: function (id, o, drawFn) {
        ensure();
        if (!E.input.tap) _tapUsed = false;
        o = o || EMPTY;
        id = id || 'sheet';
        var open = o.open === undefined ? true : !!o.open;
        var p = E.ui.anim(id, open ? 1 : 0, o.ms === undefined ? 200 : o.ms,
                          o.ease || 'outCubic');
        if (!open && p <= 0.001) return null;
        var W = E.W, H = E.H;
        var h = o.h === undefined ? Math.round(H * 0.5) : o.h;
        var y = H - h * p;
        _dimO.screen = true;
        _dimO.bg = o.bg === undefined ? TK.bg : o.bg;
        E.gfx.dim(0, 0, W, H, Math.round((o.dim === undefined ? 45 : o.dim) * p), _dimO);
        _co.screen = true;
        _co.r = Math.round(TK.radius * E.U);
        _co.fill = true;
        _co.bw = TK.bw;
        _co.stroke = TK.outline;
        _co.bg = pick(o.cardBg, TK.surface, TK.surface);
        _co.grad = undefined;
        _co.elev = TK.shadow > 0 ? 2 : 0;
        _co.shadow = undefined;
        _co.pad = 0;
        E.gfx.panel(0, y, W, h, _co);
        _bo.r = 2; _bo.screen = true; _bo.fill = true; _bo.bw = 0;
        _bo.stroke = undefined; _bo.grad = undefined; _bo.elev = 0;
        _bo.shadow = undefined; _bo.bg = undefined;
        E.gfx.rect(W / 2 - Math.round(20 * E.U), y + Math.round(6 * E.U),
                   Math.round(40 * E.U), Math.max(2, Math.round(3 * E.U)), TK.outline, _bo);
        var cy = y + Math.round(18 * E.U);
        if (o.title) {
            _bt.ts = o.titleTs || 'label'; _bt.color = TK.text;
            _bt.align = 'left'; _bt.valign = 'top';
            _bt.fit = W - Math.round(32 * E.U); _bt.screen = true;
            E.gfx.text(o.title, Math.round(16 * E.U), cy, _bt);
            cy += Math.round(24 * E.U);
            E.gfx.divider(Math.round(16 * E.U), cy - Math.round(6 * E.U),
                          W - Math.round(32 * E.U), { color: TK.outline, screen: true });
        }
        if (drawFn) {
            var cr = contentRect(Math.round(8 * E.U), cy, W - Math.round(16 * E.U),
                                 h - (cy - y) - Math.round(12 * E.U), 0);
            drawFn(cr);
        }
        if (open && o.dismiss !== false && !_tapUsed && E.input.tap &&
            !hitRect(0, y, W, h)) {
            _tapUsed = true;
            return 'close';
        }
        if (open && E.input.tap) _tapUsed = true;
        return null;
    },

    // tela de titulo: devolve 'start' (ou o tap do botao extra), ou null.
    title: function (o) {
        ensure();
        o = o || EMPTY;
        if (o.bg !== undefined && o.bg !== false) {
            if (o.bg === true) {
                _go.screen = true; _go.r = 0; _go.dir = 'y';
                _go.via = undefined; _go.step = 4;
                E.gfx.gradient(0, 0, E.W, E.H, TK.surface3, TK.bg, _go);
            } else {
                _dimO.screen = true; _dimO.bg = o.bg;
                E.gfx.rect(0, 0, E.W, E.H, o.bg, _dimO);
            }
        }
        var y = Math.round(E.H * 0.2);
        ctext(o.game || '', y, 'title', TK.accent, 0x0000);
        if (o.subtitle) ctext(o.subtitle, y + Math.round(38 * E.U), 'body', TK.text, 0x0000);
        if (o.best !== undefined) {
            var bstr = 'Recorde: ' + o.best;
            var bw2 = textW(bstr, 'small');
            var bx = Math.round((E.W - bw2) / 2);
            var by = y + Math.round(62 * E.U);
            E.ui.icon('star', bx - Math.round(16 * E.U), by, Math.round(13 * E.U),
                      { color: TK.warn });
            _bt.ts = 'small'; _bt.color = TK.text; _bt.align = 'left';
            _bt.valign = 'top'; _bt.fit = 0; _bt.screen = true;
            E.gfx.text(bstr, bx, by, _bt);
        }
        var act = null;
        var w = Math.round(150 * E.U), h = Math.round(44 * E.U);
        var bx2 = Math.round((E.W - w) / 2);
        var by2 = Math.round(E.H * 0.5);
        var temStart = o.start !== null && o.start !== false;
        if (temStart) {
            _mOp.variant = 'primary';
            _mOp.icon = o.startIcon === undefined ? 'play' : o.startIcon;
            _mOp.disabled = false;
            if (E.ui.button(o.start || 'JOGAR', bx2, by2, w, h, _mOp)) act = 'start';
            by2 += h + Math.round(10 * E.U);
        }
        if (o.extra) {
            _mOp.variant = 'secondary';
            _mOp.icon = o.extraIcon;
            _mOp.disabled = false;
            if (E.ui.button(o.extra, bx2, by2, w, Math.round(36 * E.U), _mOp)) act = 'extra';
        }
        return act;
    },

    // veu de pausa sobre o jogo congelado: devolve 'resume'|'restart'|'quit'
    // do tap, ou null. o.clear: true nao pinta o fundo; o.veil pinta a cor.
    pause: function (o) {
        ensure();
        o = o || EMPTY;
        if (o.clear !== true) {
            if (o.veil !== undefined) {
                _dimO.screen = true; _dimO.bg = o.veil;
                E.gfx.rect(0, 0, E.W, E.H, o.veil, _dimO);
            } else {
                _dimO.screen = true; _dimO.bg = TK.bg;
                E.gfx.dim(0, 0, E.W, E.H, E.caps.wide ? 62 : 100, _dimO);
            }
        }
        ctext(o.title || 'PAUSA', Math.round(E.H * 0.18), 'big', TK.text, 0x0000);
        var lb = o.labels || _PAUSA_LB;
        _mn.y = undefined;
        _mn.primary = false;
        var picked = E.ui.menu(lb, _mn);
        _mn.primary = undefined;
        if (picked === lb[0]) return 'resume';
        if (picked === lb[1]) return 'restart';
        if (picked === lb[2]) return 'quit';
        return null;
    },

    // tela de fim: devolve 'again'|'quit' do tap, ou null.
    gameOver: function (o) {
        ensure();
        o = o || EMPTY;
        if (o.clear !== true) {
            if (o.veil !== undefined) {
                _dimO.screen = true; _dimO.bg = o.veil;
                E.gfx.rect(0, 0, E.W, E.H, o.veil, _dimO);
            } else {
                _dimO.screen = true; _dimO.bg = TK.bg;
                E.gfx.dim(0, 0, E.W, E.H, E.caps.wide ? 90 : 100, _dimO);
            }
        }
        ctext(o.title || 'FIM DE JOGO', Math.round(E.H * 0.16), 'big', TK.err, 0x0000);
        var y = Math.round(E.H * 0.26);
        if (o.score !== undefined) ctext('Pontos: ' + o.score, y, 'title', TK.text, 0x0000);
        if (o.detail) ctext(o.detail, y + Math.round(34 * E.U), 'label', TK.text, 0x0000);
        if (o.best !== undefined) {
            ctext((o.isNew ? 'NOVO RECORDE! ' : 'Recorde: ') + o.best,
                  y + Math.round(64 * E.U), 'label', o.isNew ? TK.accent : TK.text, 0x0000);
        }
        var lb = o.labels || _FIM_LB;
        _mn.y = Math.round(E.H * 0.60);
        _mn.primary = undefined;
        var picked = E.ui.menu(lb, _mn);
        if (picked === lb[0]) return 'again';
        if (picked === lb[1]) return 'quit';
        return null;
    },

    // pergunta sim/nao sobre a cena (veu + painel): devolve 'yes'|'no'|null
    confirm: function (msg, o) {
        ensure();
        o = o || EMPTY;
        _dimO.screen = true; _dimO.bg = TK.bg;
        E.gfx.dim(0, 0, E.W, E.H, E.caps.wide ? 62 : 100, _dimO);
        var pw = Math.round(Math.min(E.W - 24 * E.U, 210 * E.U));
        var px = Math.round((E.W - pw) / 2);
        var st = E.font((E.ts.body || 13) * E.U);
        var lines = wrap(msg, pw - Math.round(20 * E.U), st);
        var lh = Math.round(st.h + 3);
        var top = o.title ? Math.round(26 * E.U) : Math.round(12 * E.U);
        var bh = Math.round(36 * E.U);
        var ph = top + lines.length * lh + Math.round(14 * E.U) + bh + Math.round(10 * E.U);
        var py = Math.round((E.H - ph) / 2);
        _dPanel.r = Math.round(TK.radius * E.U);
        _dPanel.screen = true;
        _dPanel.bg = TK.surface;
        _dPanel.bw = TK.bw;
        _dPanel.stroke = TK.outline;
        _dPanel.elev = TK.shadow > 0 ? 2 : 0;
        _dPanel.pad = 0;
        E.gfx.panel(px, py, pw, ph, _dPanel);
        if (o.title) ctext(o.title, py + Math.round(8 * E.U), 'label', TK.accent, 0x0000);
        for (var i = 0; i < lines.length; i++) {
            ctext(lines[i], py + top + i * lh, 'body', TK.text, 0x0000);
        }
        var lb = o.labels || _SN_LB;
        var gap = Math.round(8 * E.U), bw = Math.round((pw - gap * 3) / 2);
        var by = py + ph - bh - Math.round(10 * E.U);
        _mOp.variant = o.danger ? 'danger' : 'primary';
        _mOp.icon = undefined;
        _mOp.disabled = false;
        var yes = E.ui.button(lb[0], px + gap, by, bw, bh, _mOp);
        _mOp.variant = 'secondary';
        var no = E.ui.button(lb[1], px + gap * 2 + bw, by, bw, bh, _mOp);
        if (yes) return 'yes';
        if (no) return 'no';
        return null;
    },

    // aviso curto que some sozinho: FILA de 3, com tipo/icone e slide.
    // o = {ms (1600), color, y (0..1), type: info|ok|warn|err, icon}
    toast: function (msg, o) {
        ensure();
        o = o || EMPTY;
        var q = E.ui._toasts;
        if (q.length >= 3) q.shift();
        var now = S.millis();
        q.push({ msg: String(msg), until: now + (o.ms || 1600), color: o.color,
                 type: o.type || 'info', y: o.y === undefined ? 0.84 : o.y,
                 t0: now, icon: o.icon });
        E.ui._toast.msg = String(msg);
        E.ui._toast.until = now + (o.ms || 1600);
        E.redraw();
    },
    _toast: { msg: null, until: 0, color: undefined, y: 0.84 },
    _toasts: [],
    _anims: {},
    _hudSig: '\u0000',
    _hudBB: null,
    _toastBox: [0, 0, 0, 0],

    // anima uma chave 0..1 (modal/sheet/toast); target undefined = le o valor
    anim: function (key, target, ms, ease) {
        var a = E.ui._anims[key];
        if (!a) {
            a = E.ui._anims[key] = { v: 0, from: 0, to: 0, t: 0, d: 0, e: 'outCubic' };
        }
        if (target !== undefined) {
            target = +target;
            if (target !== a.to) {
                a.from = a.v;
                a.to = target;
                a.t = 0;
                a.d = ms === undefined ? 180 : ms;
                a.e = ease || 'outCubic';
            }
        }
        if (a.d > 0 && a.t < a.d) {
            a.t += E.dt * 1000;
            var p = a.t / a.d;
            if (p > 1) p = 1;
            var fn = E.m[a.e] || E.m.outCubic;
            a.v = a.from + (a.to - a.from) * fn(p);
            if (p >= 1) { a.v = a.to; a.d = 0; }
        }
        return a.v;
    },
    animReset: function (key) { delete E.ui._anims[key]; },

    // HUD de topo memoizado (o hudKey que 6 jogos repetiam): score/best,
    // vidas, moedas, tempo, nivel e listas left/right de {icon,text,color}.
    // Redesenha so quando a assinatura muda ou a camada suja toca a caixa.
    hud: function (o) {
        ensure();
        o = o || EMPTY;
        var h = o.h === undefined ? Math.round(30 * E.U) : o.h;
        var y = o.y === undefined ? 0 : o.y;
        var bx = o.x === undefined ? 0 : o.x;
        var bw = o.w === undefined ? E.W : o.w;
        var sig = (o.key === undefined ? '' : o.key) + '|' +
                  (o.score === undefined ? '' : o.score) + '|' +
                  (o.best === undefined ? '' : o.best) + '|' +
                  (o.lives === undefined ? '' : o.lives) + '/' +
                  (o.maxLives === undefined ? '' : o.maxLives) + '|' +
                  (o.coins === undefined ? '' : o.coins) + '|' +
                  (o.time === undefined ? '' : o.time) + '|' +
                  (o.level === undefined ? '' : o.level);
        var i;
        if (o.left) for (i = 0; i < o.left.length; i++) {
            sig += '|L' + (o.left[i].icon || '') + ':' + o.left[i].text +
                   ':' + o.left[i].color;
        }
        if (o.right) for (i = 0; i < o.right.length; i++) {
            sig += '|R' + (o.right[i].icon || '') + ':' + o.right[i].text +
                   ':' + o.right[i].color;
        }
        if (E.dirty.on && E.ui._hudSig === sig &&
            !E.dirty.touches(bx, y, bw, h)) return h;
        E.ui._hudSig = sig;
        // desenho MUDO (como o dialog): o HUD fica no vidro e so repinta
        // quando a assinatura muda ou algo apaga a caixa
        var mudo = false;
        if (E.dirty.on) {
            var ob = E.ui._hudBB;
            if (ob && (ob[0] !== bx || ob[1] !== y || ob[2] !== bw || ob[3] !== h)) {
                E.dirty.erase(ob[0], ob[1], ob[2], ob[3]);
            }
            E.ui._hudBB = [bx, y, bw, h];
            E.dirty._mute++;
            mudo = true;
        }
        _hudBg.r = 0; _hudBg.screen = true; _hudBg.fill = true; _hudBg.bw = 0;
        _hudBg.stroke = undefined; _hudBg.grad = undefined; _hudBg.elev = 0;
        _hudBg.shadow = undefined; _hudBg.bg = undefined;
        E.gfx.rect(bx, y, bw, h, o.bg === undefined ? TK.surface : o.bg, _hudBg);
        E.gfx.divider(bx, y + h - Math.max(1, Math.round(E.U)), bw,
                      { color: TK.outline, screen: true });
        var x0 = bx + Math.round(8 * E.U);
        var x1 = bx + bw - Math.round(8 * E.U);
        var cy = y + h / 2;
        if (o.lives !== undefined) {
            var hs = Math.round(12 * E.U);
            var ml = o.maxLives === undefined ? 3 : o.maxLives;
            x0 += E.gfx.hearts(o.lives, ml, x0, cy - hs / 2,
                               { size: hs, color: o.lifeColor === undefined ? TK.err : o.lifeColor,
                                 empty: TK.surface3, screen: true }) + Math.round(10 * E.U);
        }
        if (o.time !== undefined) x0 = hudItem('clock', String(o.time), x0, cy, o.timeColor);
        if (o.level !== undefined) x0 = hudItem(null, String(o.level), x0, cy, TK.textDim);
        if (o.left) for (i = 0; i < o.left.length; i++) {
            x0 = hudItem(o.left[i].icon, o.left[i].text, x0, cy, o.left[i].color);
        }
        if (o.best !== undefined) {
            x1 = hudItemR('star', String(o.best), x1, cy, TK.textDim);
        }
        if (o.coins !== undefined) {
            x1 = hudItemR('star', String(o.coins), x1, cy,
                          o.coinColor === undefined ? TK.warn : o.coinColor);
        }
        if (o.score !== undefined) {
            x1 = hudItemR(null, String(o.score), x1, cy,
                          o.scoreColor === undefined ? TK.text : o.scoreColor);
        }
        if (o.right) for (i = o.right.length - 1; i >= 0; i--) {
            x1 = hudItemR(o.right[i].icon, o.right[i].text, x1, cy, o.right[i].color);
        }
        if (mudo) E.dirty._mute--;
        return h;
    }
};

// overlay do toast (fila): relogio REAL (a pausa congela os ticks, nao o
// aviso); cada draw com aviso vivo agenda o proximo e o que expira agenda
// 1 a mais — a camada suja / o redraw da cena apaga o resto
if (E._modDraws) E._modDraws.push(function () {
    var q = E.ui._toasts;
    if (!q.length) return;
    var now = S.millis(), i;
    for (i = q.length - 1; i >= 0; i--) {
        if (now >= q[i].until) q.splice(i, 1);
    }
    if (!q.length) { E.ui._toast.msg = null; return; }
    E.redraw();
    for (i = 0; i < q.length; i++) {
        var t = q[i];
        var th = Math.round(30 * E.U);
        var p = (now - t.t0) / 180;
        if (p > 1) p = 1;
        var hasIcon = true;
        var tw = E.gfx.measure(t.msg, _toTx) + th + Math.round(20 * E.U);
        if (tw > E.W - 16) tw = E.W - 16;
        var x = Math.round((E.W - tw) / 2);
        var y = Math.round(E.H * t.y - th / 2 - i * (th + Math.round(6 * E.U)) +
                           (1 - p) * Math.round(12 * E.U));
        var col = t.color !== undefined ? t.color
                : (t.type === 'err' ? TK.err : t.type === 'warn' ? TK.warn
                : t.type === 'ok' ? TK.ok : TK.surface2);
        _toBox.r = Math.round(th / 2);
        _toBox.screen = true;
        _toBox.fill = true;
        _toBox.bw = 0;
        _toBox.stroke = undefined;
        _toBox.grad = undefined;
        _toBox.elev = 1;
        _toBox.shadow = undefined;
        _toBox.bg = TK.bg;
        E.gfx.rect(x, y, tw, th, col, _toBox);
        var iconName = t.icon || (t.type === 'ok' ? 'check'
                     : t.type === 'warn' ? 'alert'
                     : t.type === 'err' ? 'alert' : 'info');
        E.ui.icon(iconName, x + Math.round(10 * E.U), y + (th - Math.round(16 * E.U)) / 2,
                  Math.round(16 * E.U),
                  { color: t.type === 'info' ? TK.text : C.contrast(col) });
        _toTx.ts = 'body';
        _toTx.color = t.color !== undefined ? t.color
                    : (t.type === 'info' ? TK.text : C.contrast(col));
        _toTx.align = 'left';
        _toTx.valign = 'middle';
        _toTx.fit = tw - th - Math.round(8 * E.U);
        E.gfx.text(t.msg, x + th + Math.round(4 * E.U), y + th / 2, _toTx);
    }
});

E._mods.push('ui');

module.exports = E;
