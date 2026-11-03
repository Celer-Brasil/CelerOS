// celeros.hw.button — botao fisico com debounce e gestos, por polling de
// GPIO (nao ha attachInterrupt no runtime JS). Eventos:
//   press    ao afundar (depois do debounce)
//   release  ao soltar (com a duracao em ms)
//   click    toque curto; dispara depois de doubleMs sem um segundo toque
//   double   segundo toque dentro de doubleMs
//   long     segurar >= longMs (dispara UMA vez, no limiar)
//   repeat   depois do long, a cada repeatMs (opcional; 0 = desligado)
//
// Uso tipico:
//   var B = require("celeros.hw.button");
//   var b = B.create({ pin: 0, activeLow: true, pullup: true });
//   b.on('click', function () { ... });
//   b.on('long', function (ms) { ... });
//   B.start(10);              // UM setInterval para todos os botoes
//   // ou chame B.tick()/HW.tick() no proprio laco (sem timer)
//
// O firmware tem 20 ms de debounce e 1200 ms de longo no botao da placa
// (Buttons.cpp); estes sao os defaults da lib para botao externo. System.button()
// NAO e usado (so existe nas placas buttonToApp). ES5 (Duktape).

var B = { version: '1.0.0' };

var _all = [];
var _timer = 0;

function _num(v, d) {
    return (typeof v === 'number' && v === v) ? v : d;
}

function _now() {
    return (typeof System !== 'undefined' && System.millis) ? System.millis() : 0;
}

function _gpio() {
    if (typeof System === 'undefined' || !System.gpio || !System.gpio.digitalRead)
        throw new Error('celeros.hw.button: System.gpio.digitalRead indisponivel (permissao gpio)');
    return System.gpio;
}

function Button(o) {
    o = o || {};
    this.pin = (typeof o.pin === 'number') ? (o.pin | 0) : -1;
    if (this.pin < 0) throw new Error('celeros.hw.button: informe pin');
    this.activeLow = o.activeLow !== false;   // padrao: botao para GND
    this.pullup = o.pullup !== false;
    this.debounceMs = Math.max(0, _num(o.debounceMs, 20));
    this.longMs = Math.max(1, _num(o.longMs, 1200));
    this.doubleMs = Math.max(0, _num(o.doubleMs, 300));
    this.repeatMs = Math.max(0, _num(o.repeatMs, 0));

    this._g = _gpio();
    this._g.pinMode(this.pin, this.pullup ? this._g.INPUT_PULLUP : this._g.INPUT);

    var now = _now();
    var pressed = this._read();
    this._raw = pressed;
    this._stable = pressed;
    this._changedAt = now;
    this._pressed = pressed;
    this._pressedAt = now;
    this._heldMs = 0;
    this._longFired = false;
    this._repeatAt = 0;
    this._clickPending = false;
    this._releaseAt = 0;
    this._lastHeld = 0;
    this._handlers = {};
}

Button.prototype._read = function () {
    var raw = this._g.digitalRead(this.pin);
    return this.activeLow ? (raw === 0) : (raw !== 0);
};

Button.prototype.on = function (event, fn) {
    if (typeof fn !== 'function') throw new Error('celeros.hw.button.on: handler deve ser funcao');
    var list = this._handlers[event];
    if (!list) { list = []; this._handlers[event] = list; }
    list.push(fn);
    var self = this;
    return function () { self.off(event, fn); };
};

Button.prototype.off = function (event, fn) {
    var list = this._handlers[event];
    if (!list) return;
    if (!fn) { this._handlers[event] = []; return; }
    for (var i = 0; i < list.length; i++) {
        if (list[i] === fn) { list.splice(i, 1); return; }
    }
};

Button.prototype._emit = function (event, arg) {
    var list = this._handlers[event];
    if (!list || !list.length) return;
    var copy = list.slice();
    for (var i = 0; i < copy.length; i++) copy[i](arg);
};

Button.prototype._onPress = function (now) {
    this._pressed = true;
    this._pressedAt = now;
    this._heldMs = 0;
    this._longFired = false;
    this._emit('press', 0);
};

Button.prototype._onRelease = function (now) {
    this._pressed = false;
    this._heldMs = now - this._pressedAt;
    this._emit('release', this._heldMs);
    // Toque curto: espera a janela de double antes de confirmar o click.
    // Depois de um long NAO ha click.
    if (!this._longFired && this._heldMs >= 40) {
        if (this._clickPending) {
            this._clickPending = false;
            this._emit('double', this._heldMs);
        } else {
            this._clickPending = true;
            this._releaseAt = now;
            this._lastHeld = this._heldMs;
        }
    }
    this._longFired = false;
};

Button.prototype.tick = function (now) {
    if (typeof now !== 'number') now = _now();
    var pressed = this._read();
    if (pressed !== this._raw) {
        this._raw = pressed;
        this._changedAt = now;
    }
    if (this._raw !== this._stable && now - this._changedAt >= this.debounceMs) {
        this._stable = this._raw;
        if (this._stable) this._onPress(now); else this._onRelease(now);
    }
    if (this._pressed) {
        this._heldMs = now - this._pressedAt;
        if (!this._longFired && this._heldMs >= this.longMs) {
            this._longFired = true;
            this._emit('long', this._heldMs);
            this._repeatAt = now;
        }
        if (this._longFired && this.repeatMs > 0 && now - this._repeatAt >= this.repeatMs) {
            this._repeatAt = now;
            this._emit('repeat', this._heldMs);
        }
    }
    // Click so com o botao SOLTO e estavel: um segundo toque em andamento
    // cancela o click (a janela dele e a pausa entre os dois toques).
    if (this._clickPending && !this._pressed && this._raw === this._stable &&
        now - this._releaseAt >= this.doubleMs) {
        this._clickPending = false;
        this._emit('click', this._lastHeld);
    }
};

Button.prototype.pressed = function () { return this._pressed; };
Button.prototype.heldMs = function () { return this._heldMs; };

// Grupo so de referencias (pose/on/off em varios botoes). O tick e o mesmo
// B.tick/B.start — nao crie um segundo timer.
function Group(list) {
    this.list = list || [];
}

Group.prototype.tick = function (now) {
    for (var i = 0; i < this.list.length; i++) this.list[i].tick(now);
};

Group.prototype.on = function (event, fn) {
    for (var i = 0; i < this.list.length; i++) this.list[i].on(event, fn);
    return this;
};

Group.prototype.off = function (event, fn) {
    for (var i = 0; i < this.list.length; i++) this.list[i].off(event, fn);
    return this;
};

B.create = function (o) {
    var b = new Button(o);
    _all.push(b);
    return b;
};

B.group = function (list) { return new Group(list); };

B.tick = function (now) {
    if (typeof now !== 'number') now = _now();
    for (var i = 0; i < _all.length; i++) _all[i].tick(now);
};

// UM timer para todos os botoes (pool de 8 slots do firmware; piso 10 ms).
B.start = function (ms) {
    if (_timer) return _timer;
    _timer = setInterval(function () { B.tick(); }, Math.max(10, _num(ms, 10)));
    return _timer;
};

B.stop = function () {
    if (_timer) { clearInterval(_timer); _timer = 0; }
};

B.available = function () {
    return typeof System !== 'undefined' && !!System.gpio &&
           typeof System.gpio.digitalRead === 'function';
};

module.exports = B;
