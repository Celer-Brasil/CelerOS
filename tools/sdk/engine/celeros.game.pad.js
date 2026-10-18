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
// MULTITOQUE (API 43, core 1.4): na 4848 e no relogio o vidro entrega
// varios dedos e cada controle segue o seu — anda e golpeia junto. No
// vidro de TOQUE UNICO (CYD) segurar o stick E apertar um botao nao
// existe: o tap seco (sem arrastar) dentro da zona do stick vira o "A"
// (stick.tap) e o botao fisico (E.input.btn) pode ser a 2a acao — jogos
// que rodam nas duas desenham para isso (arrasta = move, solta e toca =
// age) e ganham o combo no multitoque de graca.
//
// 1.1.0: o tick roda tambem com E.paused (o botao "continuar" do pad nao
// via o toque na pausa); dedo que DESCE num botao nao pega o stick por
// baixo (zona padrao e botao sobrepostos andavam e pulavam juntos);
// controles nascem presos a CENA (somem quando ela sai e dormem sob um
// E.push — {global: true} mantem) e o botao ganha heldMs + tap.
// 1.2.0: MULTITOQUE (core 1.4 / API 43): cada controle pega o dedo que
// desce nele e o segue ate levantar — andar com o stick e apertar A/B ao
// mesmo tempo no vidro da 4848 e do relogio. stick.finger/button.finger
// dizem o dono; stick {follow} arrasta o centro com o dedo. No vidro de
// toque unico (CYD) o comportamento e o de sempre.
// 1.2.1: com a camada suja, cada controle so redesenha quando muda ou
// quando algo apaga a area dele (parado nao custa nada por quadro).

var E = require('celeros.game');
var EMPTY = {};

// redesenho sob demanda (camada suja): estado igual e area intacta = nada
// a fazer. Mudou: apaga a caixa velha (fundo) e redesenha mudo (o desenho
// fica no quadro ate algo apagar a area — touches avisa)
function precisa(c, key, x, y, w, h) {
    if (!E.dirty.on) { c._mudo = false; return true; }
    var mudou = c._k !== key;
    var bb = c._bb;
    if (!mudou && bb && !E.dirty.touches(bb[0], bb[1], bb[2], bb[3])) return false;
    if (mudou && bb) E.dirty.erase(bb[0], bb[1], bb[2], bb[3]);
    if (!bb) bb = c._bb = [0, 0, 0, 0];
    bb[0] = Math.floor(x); bb[1] = Math.floor(y); bb[2] = Math.ceil(w); bb[3] = Math.ceil(h);
    c._k = key;
    c._mudo = true;
    E.dirty._mute++;
    return true;
}
function feito(c) { if (c._mudo) { E.dirty._mute--; c._mudo = false; } }
var EMPTY_L = [];
var _own = {};      // id do dedo -> ja tem dono neste quadro

// controle vivo na cena corrente? (global = sempre); morto = saiu de vez
function stacked(g) {
    var st = E._stack;
    if (st) for (var i = 0; i < st.length; i++) if (st[i].gen === g) return true;
    return false;
}
// criado fora de cena (topo do main.js, antes do E.run) = global
function genOf(o) { return o.global || !E._sceneGen ? null : E._sceneGen; }
function live(c) { return c.gen === null || c.gen === E._sceneGen; }
function purge(L) {
    for (var i = L.length - 1; i >= 0; i--) {
        var c = L[i];
        if (c.gen !== null && c.gen !== E._sceneGen && !stacked(c.gen)) L.splice(i, 1);
    }
}

var _sticks = [], _buttons = [];
var _ring = { fill: false, screen: true };
var _knob = { screen: true, smooth: true };
var _lbl = { align: 'center', valign: 'middle', screen: true, color: 0, px: 12 };

E.pad = {
    version: '1.2.1',

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
            follow: !!o.follow,  // centro persegue o dedo alem da borda
            finger: null,        // id do dedo dono (multitoque)
            gen: genOf(o),
            _home: { x: o.x || 0, y: o.y || 0 }
        };
        if (!s.zone) s.zone = { x: 0, y: Math.round(E.H * 0.4), w: Math.round(E.W / 2), h: E.H - Math.round(E.H * 0.4) };
        if (!o.x && !o.y) { s._home.x = s.cx = s.zone.x + s.zone.w / 2; s._home.y = s.cy = s.zone.y + s.zone.h / 2; }
        _sticks.push(s);
        return s;
    },

    // botao circular {x, y, r, label, color} ou retangular {x, y, w, h}:
    // b.down (segurando), b.pressed (desceu neste quadro), b.released,
    // b.heldMs (ms segurando — tiro carregado), b.tap (soltou em < 250 ms)
    button: function (o) {
        var b = { x: o.x, y: o.y, r: o.r, w: o.w, h: o.h, label: o.label || '',
                  color: o.color, down: false, pressed: false, released: false,
                  heldMs: 0, tap: false, _t0: 0, finger: null,
                  gen: genOf(o),
                  visible: o.visible !== false };
        _buttons.push(b);
        return b;
    },

    // remove tudo (troca de cena)
    clear: function () { _sticks.length = 0; _buttons.length = 0; },

    // dentro do botao (slack > 1 alarga: dedo que escorrega da borda segue)
    _in: function (b, x, y, slack) {
        var k = slack || 1;
        if (b.r !== undefined) {
            var dx = x - b.x, dy = y - b.y, rr = b.r * k;
            return dx * dx + dy * dy <= rr * rr;
        }
        var mx = b.w * (k - 1) / 2, my = b.h * (k - 1) / 2;
        return x >= b.x - mx && x <= b.x + b.w + mx && y >= b.y - my && y <= b.y + b.h + my;
    },

    // um dedo por controle (core 1.4, E.input.touches): o controle pega o
    // dedo que DESCE nele e o segue ate levantar — stick + A + B juntos no
    // vidro multitoque. No toque unico e o mesmo codigo com 1 dedo
    _tick: function (dt, now) {
        var i = E.input, L = i.touches || EMPTY_L, q, k, f, g;
        purge(_sticks);
        purge(_buttons);
        var t = now === undefined ? 0 : now;
        // dedos ja donos de um controle (vivos) — nao trocam de dono
        for (k in _own) delete _own[k];
        for (q = 0; q < _buttons.length; q++) if (_buttons[q].finger !== null) _own[_buttons[q].finger] = 1;
        for (q = 0; q < _sticks.length; q++) if (_sticks[q].finger !== null) _own[_sticks[q].finger] = 1;
        // botoes primeiro: dedo que desce num botao e do botao, nao do stick
        for (var b = 0; b < _buttons.length; b++) {
            var bt = _buttons[b];
            f = bt.finger !== null ? i.finger(bt.finger) : null;
            if (!live(bt) || (f && !f.down) || (bt.finger !== null && !f)) {
                if (bt.finger !== null) delete _own[bt.finger];
                bt.finger = null;
                f = null;
            }
            if (!f && live(bt)) {
                for (k = 0; k < L.length; k++) {
                    g = L[k];
                    // dedo novo no botao, ou dedo sem dono que ENTROU nele
                    if (g.down && !_own[g.id] && E.pad._in(bt, g.x, g.y)) {
                        f = g; bt.finger = g.id; _own[g.id] = 1;
                        break;
                    }
                }
            }
            var on = !!f && E.pad._in(bt, f.x, f.y, 1.3);
            bt.pressed = on && !bt.down;
            bt.released = !on && bt.down;
            bt.tap = bt.released && t - bt._t0 < 250;
            if (bt.pressed) bt._t0 = t;
            bt.heldMs = on ? t - bt._t0 : 0;
            bt.down = on;
        }
        for (var n = 0; n < _sticks.length; n++) {
            var s = _sticks[n], z = s.zone;
            s.tap = false;
            f = s.finger !== null ? i.finger(s.finger) : null;
            if (!live(s) || (f && !f.down) || (s.finger !== null && !f)) {
                // levantou: toque seco (sem arrastar, rapido) e o "A" do stick
                if (f && !f.down && !f.moved && f.heldMs < i.tapMs) s.tap = true;
                if (s.finger !== null) delete _own[s.finger];
                s.finger = null;
                s.active = false;
                s.cx = s._home.x; s.cy = s._home.y;
                f = null;
            }
            if (!f && live(s)) {
                for (k = 0; k < L.length; k++) {
                    g = L[k];
                    if (g.justDown && g.down && !_own[g.id] &&
                        g.x >= z.x && g.x <= z.x + z.w && g.y >= z.y && g.y <= z.y + z.h) {
                        f = g; s.finger = g.id; _own[g.id] = 1;
                        s.active = true;
                        if (s.float) { s.cx = g.x; s.cy = g.y; }
                        break;
                    }
                }
            }
            if (f) {
                var dx = (f.x - s.cx) / s.r, dy = (f.y - s.cy) / s.r;
                var m = Math.sqrt(dx * dx + dy * dy);
                if (m > 1) {
                    dx /= m; dy /= m; m = 1;
                    // follow: o centro persegue o dedo que passou da borda
                    if (s.follow) {
                        s.cx = f.x - dx * s.r;
                        s.cy = f.y - dy * s.r;
                    }
                }
                if (m < s.dead) { s.x = 0; s.y = 0; s.mag = 0; s.dir = null; continue; }
                var k2 = (m - s.dead) / (1 - s.dead) / m;
                s.x = dx * k2; s.y = dy * k2;
                s.mag = (m - s.dead) / (1 - s.dead);
                s.angle = Math.atan2(dy, dx);
                s.dir = E.pad._dir(s.angle, s.dirs);
            } else {
                s.x = 0; s.y = 0; s.mag = 0; s.dir = null;
            }
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
    // desenha tudo (screen). Com a camada suja ligada cada controle so
    // redesenha quando o estado muda ou quando algo apagou a area dele
    // (E.dirty.touches) — desenhado fora da camada (mudo): parado, o pad
    // nao custa nada por quadro (os circulos com AA eram ~5 ms/quadro no
    // 4848). Sem camada suja desenha sempre, como antes
    draw: function () {
        var T = E.theme || EMPTY;
        var ac = T.accent === undefined ? 0x07FF : T.accent;
        var dim = T.stroke === undefined ? 0x3186 : T.stroke;
        for (var k = 0; k < _sticks.length; k++) {
            var s = _sticks[k];
            if (!s.visible || !live(s)) continue;
            var R = Math.ceil(s.r * 1.1) + 3;
            var ks = Math.round(s.cx) + ',' + Math.round(s.cy) + ',' + Math.round(s.x * 20) + ',' +
                     Math.round(s.y * 20) + (s.active ? 'a' : '');
            if (!precisa(s, ks, s.cx - R, s.cy - R, R * 2, R * 2)) continue;
            E.gfx.circle(s.cx, s.cy, s.r, s.active ? ac : dim, _ring);
            E.gfx.circle(s.cx + s.x * s.r * 0.7, s.cy + s.y * s.r * 0.7,
                         Math.round(s.r * 0.38), s.active ? ac : dim, _knob);
            feito(s);
        }
        for (var b = 0; b < _buttons.length; b++) {
            var bt = _buttons[b];
            if (!bt.visible || !live(bt)) continue;
            var c = bt.color === undefined ? ac : bt.color;
            if (bt.r !== undefined) {
                var rr = bt.r + 3;
                if (!precisa(bt, bt.down ? 'd' : 'u', bt.x - rr, bt.y - rr, rr * 2, rr * 2)) continue;
                if (bt.down) E.gfx.circle(bt.x, bt.y, bt.r, c, _knob);
                else E.gfx.circle(bt.x, bt.y, bt.r, c, _ring);
                _lbl.color = bt.down ? (T.onAccent === undefined ? 0x0000 : T.onAccent) : c;
                _lbl.px = Math.round(bt.r * 0.8);
                if (bt.label) E.gfx.text(bt.label, bt.x, bt.y, _lbl);
            } else {
                if (!precisa(bt, bt.down ? 'd' : 'u', bt.x - 2, bt.y - 2, bt.w + 4, bt.h + 4)) continue;
                E.gfx.rect(bt.x, bt.y, bt.w, bt.h, c, bt.down ? _knob : _ring);
                _lbl.color = bt.down ? (T.onAccent === undefined ? 0x0000 : T.onAccent) : c;
                _lbl.px = Math.round(bt.h * 0.5);
                if (bt.label) E.gfx.text(bt.label, bt.x + bt.w / 2, bt.y + bt.h / 2, _lbl);
            }
            feito(bt);
        }
    }
};

// always: o pad e input — roda com E.paused (o core passa dt 0)
var _pt = function (dt, now) { E.pad._tick(dt, now); };
_pt.always = true;
E._modTicks.push(_pt);
E._mods.push('pad');

module.exports = E;
