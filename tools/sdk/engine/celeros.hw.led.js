// celeros.hw.led — LED comum (liga/desliga ou PWM), LED RGB de status da
// placa e fita WS2812. Tudo nao bloqueante: blink/breathe/pattern/rainbow
// andam no tick (o kit celeros.hw.start() cria UM setInterval para todos).
//
// Uso tipico:
//   var L = require("celeros.hw.led");
//   var led = L.create({ pin: 4 });          // LED externo simples
//   led.on(); led.blink(500);                // pisca a cada 500 ms
//
//   var dim = L.create({ pin: 16, pwm: true });  // 1 dos 3 canais analogWrite
//   dim.breathe(2000);                       // 0..100% em 2 s
//
//   L.status(0, 40, 0);                      // LED RGB da placa (System.led)
//   var fita = L.strip({ index: 0, count: 4 });  // WS2812 (System.neopixel)
//   fita.fill(0x0000FF); fita.show();
//   L.tick();                                // uma vez por quadro
//
// Cores de fita em 0x00RRGGBB (o formato REAL do System.neopixel; o comentario
// antigo do dts.js dizia RGB565). O analogWrite tem 3 canais, 8 bits e 5 kHz
// fixos. ES5 (Duktape; permissao "gpio").

var L = { version: '1.0.0' };

var _leds = [];
var _strips = [];

function _num(v, d) {
    return (typeof v === 'number' && v === v) ? v : d;
}

function _clamp(v, a, b) {
    if (v < a) return a;
    if (v > b) return b;
    return v;
}

function _now() {
    return (typeof System !== 'undefined' && System.millis) ? System.millis() : 0;
}

function _gpio() {
    if (typeof System === 'undefined' || !System.gpio || !System.gpio.digitalWrite)
        throw new Error('celeros.hw.led: System.gpio indisponivel (permissao gpio)');
    return System.gpio;
}

function _neopixel() {
    return (typeof System !== 'undefined' && typeof System.neopixel === 'function')
        ? System.neopixel : null;
}

// ---- LED simples / PWM ----------------------------------------------------
function Led(o) {
    o = o || {};
    this.pin = (typeof o.pin === 'number') ? (o.pin | 0) : -1;
    if (this.pin < 0) throw new Error('celeros.hw.led: informe pin');
    this.activeLow = !!o.activeLow;
    this.pwm = !!o.pwm;
    this._g = _gpio();
    this._g.pinMode(this.pin, this._g.OUTPUT);
    this._level = 0;
    this._on = false;
    this._effect = null;
    this.off();
}

Led.prototype._raw = function (on) {
    return this.activeLow ? (on ? 0 : 1) : (on ? 1 : 0);
};

Led.prototype.set = function (level) {
    level = _clamp(_num(level, 0), 0, 100);
    this._level = level;
    if (this.pwm && level > 0 && level < 100) {
        var duty = Math.round(level * 255 / 100);
        if (this.activeLow) duty = 255 - duty;
        this._g.analogWrite(this.pin, duty);
    } else {
        this._g.digitalWrite(this.pin, this._raw(level > 0));
    }
    return this;
};

Led.prototype.level = function () { return this._level; };

Led.prototype.on = function () {
    this._effect = null;
    this._on = true;
    return this.set(100);
};

Led.prototype.off = function () {
    this._effect = null;
    this._on = false;
    return this.set(0);
};

Led.prototype.toggle = function () {
    return this._level > 0 ? this.off() : this.on();
};

// Pisca: ms = periodo de cada fase; opts {on: ms, off: ms}.
Led.prototype.blink = function (ms, opts) {
    ms = Math.max(20, _num(ms, 500));
    opts = opts || {};
    var onMs = Math.max(10, _num(opts.on, ms));
    var offMs = Math.max(10, _num(opts.off, ms));
    this._effect = { type: 'blink', on: onMs, off: offMs, phase: 1, at: _now() };
    this.set(100);
    return this;
};

// Sobe/desce 0..100% (so faz sentido no PWM; sem PWM vira blink).
Led.prototype.breathe = function (ms) {
    ms = Math.max(200, _num(ms, 2000));
    if (!this.pwm) return this.blink(ms / 2);
    this._effect = { type: 'breathe', ms: ms, t0: _now() };
    return this;
};

// Padrao: [{level: 0..100, ms: duracao}, ...] repetido.
Led.prototype.pattern = function (frames) {
    if (!frames || !frames.length) throw new Error('celeros.hw.led.pattern: lista vazia');
    var f = [];
    for (var i = 0; i < frames.length; i++) {
        f.push({ level: _clamp(_num(frames[i].level, 0), 0, 100),
                 ms: Math.max(10, _num(frames[i].ms, 200)) });
    }
    this._effect = { type: 'pattern', frames: f, idx: 0, at: _now() };
    this.set(f[0].level);
    return this;
};

Led.prototype.stop = function () {
    this._effect = null;
    return this;
};

Led.prototype._tick = function (now) {
    var e = this._effect;
    if (!e) return;
    if (e.type === 'blink') {
        if (e.phase === 1) {
            if (now - e.at >= e.on) { this.set(0); e.phase = 0; e.at = now; }
        } else {
            if (now - e.at >= e.off) { this.set(100); e.phase = 1; e.at = now; }
        }
    } else if (e.type === 'breathe') {
        var t = ((now - e.t0) % e.ms) / e.ms;
        this.set((1 - Math.cos(t * 2 * Math.PI)) / 2 * 100);
    } else if (e.type === 'pattern') {
        if (now - e.at >= e.frames[e.idx].ms) {
            e.idx = (e.idx + 1) % e.frames.length;
            e.at = now;
            this.set(e.frames[e.idx].level);
        }
    }
};

// ---- LED RGB de status da placa ------------------------------------------
L.hasStatus = function () {
    return typeof System !== 'undefined' && typeof System.led === 'function';
};

L.status = function (r, g, b) {
    if (!L.hasStatus()) return false;
    return !!System.led(r | 0, g | 0, b | 0);
};

L.statusOff = function () { return L.status(0, 0, 0); };

// ---- fita WS2812 ----------------------------------------------------------
function Strip(o) {
    o = o || {};
    this.index = (typeof o.index === 'number') ? (o.index | 0) : 0;
    this.count = _clamp(_num(o.count, 8) | 0, 1, 8);
    this.buf = [];
    for (var i = 0; i < this.count; i++) this.buf.push(0);
    this._effect = null;
}

Strip.prototype.set = function (i, color) {
    i = i | 0;
    if (i >= 0 && i < this.count) this.buf[i] = color & 0xFFFFFF;
    return this;
};

Strip.prototype.fill = function (color) {
    color = color & 0xFFFFFF;
    for (var i = 0; i < this.count; i++) this.buf[i] = color;
    return this;
};

Strip.prototype.clear = function () { return this.fill(0); };

Strip.prototype.show = function () {
    var neon = _neopixel();
    if (!neon) return false;
    return !!neon(this.index, this.buf);
};

Strip.prototype.rainbow = function (ms) {
    ms = Math.max(200, _num(ms, 2000));
    this._effect = { type: 'rainbow', ms: ms, t0: _now() };
    return this;
};

Strip.prototype.stop = function () {
    this._effect = null;
    return this;
};

Strip.prototype._tick = function (now) {
    var e = this._effect;
    if (!e) return;
    var base = ((now - e.t0) / e.ms) * 360;
    for (var i = 0; i < this.count; i++) {
        var hue = base + i * 360 / this.count;
        this.buf[i] = L.hsv(hue, 1, 1);
    }
    this.show();
};

// ---- cores ----------------------------------------------------------------
L.rgb = function (r, g, b) {
    return (((r | 0) & 255) << 16) | (((g | 0) & 255) << 8) | ((b | 0) & 255);
};

L.hex = function (n) { return n & 0xFFFFFF; };

// h 0..360, s/v 0..1 -> 0x00RRGGBB
L.hsv = function (h, s, v) {
    h = ((_num(h, 0) % 360) + 360) % 360 / 60;
    s = _clamp(_num(s, 1), 0, 1);
    v = _clamp(_num(v, 1), 0, 1);
    var i = Math.floor(h);
    var f = h - i;
    var p = v * (1 - s);
    var q = v * (1 - s * f);
    var t = v * (1 - s * (1 - f));
    var r, g, b;
    switch (i % 6) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        default: r = v; g = p; b = q; break;
    }
    return L.rgb(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
};

L.mix = function (a, b, t) {
    t = _clamp(_num(t, 0.5), 0, 1);
    var ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    var br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    return L.rgb(Math.round(ar + (br - ar) * t),
                 Math.round(ag + (bg - ag) * t),
                 Math.round(ab + (bb - ab) * t));
};

// Corrige o brilho percebido de um canal 0..255 (gamma 2.2).
L.gamma = function (v) {
    v = _clamp(_num(v, 0), 0, 255);
    return Math.round(Math.pow(v / 255, 2.2) * 255);
};

// ---- fabricas e tick ------------------------------------------------------
L.create = function (o) {
    var led = new Led(o);
    _leds.push(led);
    return led;
};

L.strip = function (o) {
    var s = new Strip(o);
    _strips.push(s);
    return s;
};

L.tick = function (now) {
    if (typeof now !== 'number') now = _now();
    for (var i = 0; i < _leds.length; i++) _leds[i]._tick(now);
    for (var j = 0; j < _strips.length; j++) _strips[j]._tick(now);
};

L.available = function () {
    return (typeof System !== 'undefined') &&
           (!!System.gpio || typeof System.led === 'function' ||
            typeof System.neopixel === 'function');
};

module.exports = L;
