// game.pad.js — CelerGame PAD (dep "celeros.game.pad"): controle virtual
// na tela para jogo de acao — direcional analogico (stick) e botoes por
// zona. Decora o core no require:
//
//   var E = require("celeros.game");
//   require("celeros.game.pad");
//   var st = E.pad.stick({ zone: { x: 0, y: 160, w: 120, h: 160 } });
//   var pulo = E.pad.button({ x: 190, y: 270, r: 26, label: "A" });
//   // update: heroi.vx = st.x * 90; if (pulo.pressed) pular();
//   // draw:   E.pad.draw();         (desenha tudo o que foi criado)
//
// TOQUE UNICO: o firmware entrega UM ponto (System.getTouch) — segurar o
// stick E apertar um botao ao mesmo tempo nao existe nessas telas. Por
// isso o modo `tapAction` do stick: o tap seco (sem arrastar) dentro da
// zona do stick vira o "A" (stick.tap), e o botao fisico (E.input.btn)
// pode servir de 2a acao. Desenhe jogos que caibam nisso: arrasta = move,
// solta e toca = age.

var E = require('celeros.game');
var EMPTY = {};

var _sticks = [], _buttons = [];
var _ring = { fill: false, screen: true };
var _knob = { screen: true, smooth: true };
var _lbl = { align: 'center', valign: 'middle', screen: true, color: 0, px: 12 };

E.pad = {
    version: '1.0.0',

    // stick analogico. o = {zone {x,y,w,h} (onde o dedo PRESSIONA para
    // pegar o stick; default metade esquerda), r (raio em px, default
    // 36*U), float (default true: o centro nasce onde o dedo desceu; false
    // = centro fixo em o.x/o.y), dead (zona morta 0..1, default 0.15),
    // dirs (4|8: direcao discreta em st.dir), visible (default true)}
    stick: function (o) {
        o = o || EMPTY;
        var s = {
            x: 0, y: 0,          // -1..1 por eixo (zona morta aplicada)
            mag: 0, angle: 0,    // 0..1 / radianos
            active: false,       // dedo no stick agora
            dir: null,           // 'left'|'right'|'up'|'down' (+ 'up-left'... com dirs 8)
            tap: false,          // tap seco na zona (tapAction)
            cx: o.x || 0, cy: o.y || 0,
            r: o.r || Math.round(36 * E.U),
            zone: o.zone || null,
            float: o.float !== false,
            dead: o.dead === undefined ? 0.15 : o.dead,
            dirs: o.dirs || 4,
            visible: o.visible !== false,
            _home: { x: o.x || 0, y: o.y || 0 }
        };
        if (!s.zone) s.zone = { x: 0, y: Math.round(E.H * 0.4), w: Math.round(E.W / 2), h: E.H - Math.round(E.H * 0.4) };
        if (!o.x && !o.y) { s._home.x = s.cx = s.zone.x + s.zone.w / 2; s._home.y = s.cy = s.zone.y + s.zone.h / 2; }
        _sticks.push(s);
        return s;
    },

    // botao circular {x, y, r, label, color} ou retangular {x, y, w, h}:
    // b.down (segurando), b.pressed (desceu neste quadro), b.released
    button: function (o) {
        var b = { x: o.x, y: o.y, r: o.r, w: o.w, h: o.h, label: o.label || '',
                  color: o.color, down: false, pressed: false, released: false,
                  visible: o.visible !== false };
        _buttons.push(b);
        return b;
    },

    // remove tudo (troca de cena)
    clear: function () { _sticks.length = 0; _buttons.length = 0; },

    _in: function (b, x, y) {
        if (b.r !== undefined) {
            var dx = x - b.x, dy = y - b.y;
            return dx * dx + dy * dy <= b.r * b.r;
        }
        return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    },

    _tick: function () {
        var i = E.input;
        for (var k = 0; k < _sticks.length; k++) {
            var s = _sticks[k], z = s.zone;
            s.tap = false;
            var inZone = i.x >= z.x && i.x <= z.x + z.w && i.y >= z.y && i.y <= z.y + z.h;
            if (i.justDown && inZone) {
                s.active = true;
                if (s.float) { s.cx = i.x; s.cy = i.y; }
            }
            if (i.tap && i.tap.x >= z.x && i.tap.x <= z.x + z.w &&
                i.tap.y >= z.y && i.tap.y <= z.y + z.h) s.tap = true;
            if (!i.down) {
                s.active = false;
                s.cx = s._home.x; s.cy = s._home.y;
            }
            if (s.active && i.down) {
                var dx = (i.x - s.cx) / s.r, dy = (i.y - s.cy) / s.r;
                var m = Math.sqrt(dx * dx + dy * dy);
                if (m > 1) { dx /= m; dy /= m; m = 1; }
                if (m < s.dead) { s.x = 0; s.y = 0; s.mag = 0; s.dir = null; continue; }
                // reescala para 0..1 depois da zona morta
                var k2 = (m - s.dead) / (1 - s.dead) / m;
                s.x = dx * k2; s.y = dy * k2;
                s.mag = m === 0 ? 0 : (m - s.dead) / (1 - s.dead);
                s.angle = Math.atan2(dy, dx);
                s.dir = E.pad._dir(s.angle, s.dirs);
            } else {
                s.x = 0; s.y = 0; s.mag = 0; s.dir = null;
            }
        }
        for (var b = 0; b < _buttons.length; b++) {
            var bt = _buttons[b];
            var on = i.down && E.pad._in(bt, i.x, i.y);
            bt.pressed = on && !bt.down;
            bt.released = !on && bt.down;
            bt.down = on;
        }
    },

    // angulo -> nome da direcao (4 ou 8 setores)
    _dir: function (a, n) {
        var names8 = ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right'];
        if (n === 8) {
            var s8 = Math.round(a / (Math.PI / 4));
            return names8[(s8 % 8 + 8) % 8];
        }
        var s4 = Math.round(a / (Math.PI / 2));
        return ['right', 'down', 'left', 'up'][(s4 % 4 + 4) % 4];
    },

    // desenha sticks/botoes (screen; camada suja registra sozinha)
    draw: function () {
        var T = E.theme || EMPTY;
        var ac = T.accent === undefined ? 0x07FF : T.accent;
        var dim = T.stroke === undefined ? 0x3186 : T.stroke;
        for (var k = 0; k < _sticks.length; k++) {
            var s = _sticks[k];
            if (!s.visible) continue;
            E.gfx.circle(s.cx, s.cy, s.r, s.active ? ac : dim, _ring);
            E.gfx.circle(s.cx + s.x * s.r * 0.7, s.cy + s.y * s.r * 0.7,
                         Math.round(s.r * 0.38), s.active ? ac : dim, _knob);
        }
        for (var b = 0; b < _buttons.length; b++) {
            var bt = _buttons[b];
            if (!bt.visible) continue;
            var c = bt.color === undefined ? ac : bt.color;
            if (bt.r !== undefined) {
                if (bt.down) E.gfx.circle(bt.x, bt.y, bt.r, c, _knob);
                else E.gfx.circle(bt.x, bt.y, bt.r, c, _ring);
                _lbl.color = bt.down ? (T.onAccent === undefined ? 0x0000 : T.onAccent) : c;
                _lbl.px = Math.round(bt.r * 0.8);
                if (bt.label) E.gfx.text(bt.label, bt.x, bt.y, _lbl);
            } else {
                E.gfx.rect(bt.x, bt.y, bt.w, bt.h, c, bt.down ? _knob : _ring);
                _lbl.color = bt.down ? (T.onAccent === undefined ? 0x0000 : T.onAccent) : c;
                _lbl.px = Math.round(bt.h * 0.5);
                if (bt.label) E.gfx.text(bt.label, bt.x + bt.w / 2, bt.y + bt.h / 2, _lbl);
            }
        }
    }
};

E._modTicks.push(function () { E.pad._tick(); });
E._mods.push('pad');

module.exports = E;
