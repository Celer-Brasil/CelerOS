// celeros.hw.servo — servo de posicao (SG90/MG996R etc.) com calibracao,
// rampa, poses e sequencias. O PWM e o do firmware: System.gpio.servo
// (API 10, 500..2500 us) ou System.gpio.servoUs (API 55, 400..2600 us
// exatos — calibracao de sail winch/servo de 270 graus). A lib aceita
// angulo FRACIONARIO e converte para us; no backend antigo o proprio
// binding arredonda no fim.
//
// Uso tipico:
//   var S = require("celeros.hw.servo");
//   var s = S.create({ pin: 12, minUs: 600, maxUs: 2400 });  // calibrado
//   s.write(90);                 // posicao imediata
//   s.to(180, 600);              // rampa de 600 ms (chamar S.tick() no laco)
//   s.play([[0, 500], [180, 500], [90, 300]]);  // sequencia, um passo por vez
//   s.detach();                  // servo sem forca
//
//   var c = S.create({ pin: 13, continuous: true });  // rotacao continua
//   c.speed(50);                // -100..100 em volta do stopUs (default 1500)
//
//   var g = S.group([s1, s2]);
//   g.pose([45, 90], 400);       // as duas em 400 ms
//   S.tick();                    // uma vez por quadro (ou HW.tick() do kit)
//
// Backend alternativo (PCA9685): S.create({ write: function(us){...},
// off: function(){...} }) — usado por celeros.hw.pca9685.servo().
//
// A placa precisa da permissao "gpio" (o objeto System.gpio nao existe sem
// ela). ES5 (Duktape).

var S = { version: '1.1.0' };

var _all = [];

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
    if (typeof System === 'undefined' || !System.gpio || !System.gpio.servo)
        throw new Error('celeros.hw.servo: System.gpio.servo indisponivel (API 10, permissao gpio)');
    return System.gpio;
}

// Backend nativo: servoUs (API 55) e o pulso exato 400..2600; no firmware
// antigo (API 10) o servo mapeia angulo 0..180 em 500..2500 us. A conversao
// inversa com fracao devolve o us pedido (o arredondamento e o mesmo dos
// dois lados).
function _native(pin) {
    var G = _gpio();
    return {
        write: function (us) {
            if (typeof G.servoUs === 'function') return G.servoUs(pin, us);
            var angle = (us - 500) * 180 / 2000;
            if (angle < 0) angle = 0;
            if (angle > 180) angle = 180;
            return G.servo(pin, angle);
        },
        off: function () {
            return G.servoOff ? G.servoOff(pin) : false;
        }
    };
}

function Servo(o) {
    o = o || {};
    this.pin = (typeof o.pin === 'number') ? (o.pin | 0) : -1;
    this.minUs = _num(o.minUs, 500);
    this.maxUs = _num(o.maxUs, 2500);
    if (this.maxUs <= this.minUs) this.maxUs = this.minUs + 1;
    this.minAngle = _num(o.minAngle, 0);
    this.maxAngle = _num(o.maxAngle, 180);
    if (this.maxAngle === this.minAngle) this.maxAngle = this.minAngle + 1;
    this.offset = _num(o.offset, 0);
    this.invert = !!o.invert;
    this.continuous = !!o.continuous;
    // Rotacao continua: 1500 us (ou o stopUs calibrado) e o ponto de parada;
    // speed(-100..100) anda em volta dele.
    this.stopUs = _clamp(_num(o.stopUs, (this.minUs + this.maxUs) / 2),
                         this.minUs, this.maxUs);

    if (typeof o.write === 'function') {
        this._write = o.write;
        this._offFn = (typeof o.off === 'function') ? o.off : function () { return false; };
    } else {
        if (this.pin < 0) throw new Error('celeros.hw.servo: informe pin ou write(us)');
        var nat = _native(this.pin);
        this._write = nat.write;
        this._offFn = nat.off;
    }

    this._angle = (this.minAngle + this.maxAngle) / 2;  // posicao logica inicial
    this._us = 0;
    this._written = false;
    this._detached = false;
    this._ramp = false;
    this._from = this._angle;
    this._to = this._angle;
    this._t0 = 0;
    this._ms = 0;
    this._queue = [];
    this._seq = false;
}

// Angulo -> us (com offset/inversao e clamp).
Servo.prototype.usOf = function (angle) {
    var a = _clamp(angle + this.offset, this.minAngle, this.maxAngle);
    var t = (a - this.minAngle) / (this.maxAngle - this.minAngle);
    if (this.invert) t = 1 - t;
    return this.minUs + t * (this.maxUs - this.minUs);
};

// us -> angulo logico (para angle() depois de writeUs).
Servo.prototype.angleOf = function (us) {
    var t = (us - this.minUs) / (this.maxUs - this.minUs);
    if (this.invert) t = 1 - t;
    return this.minAngle + t * (this.maxAngle - this.minAngle);
};

Servo.prototype._applyUs = function (us) {
    us = _clamp(us, this.minUs, this.maxUs);
    var ok = this._write(us);
    this._us = us;
    this._written = true;
    this._detached = false;
    this._angle = this.angleOf(us);
    return !!ok;
};

// Escrita manual cancela a rampa (o alvo novo manda).
Servo.prototype.writeUs = function (us) {
    this._ramp = false;
    return this._applyUs(us);
};

Servo.prototype.write = function (angle) {
    this._ramp = false;
    var a = _clamp(_num(angle, this._angle), this.minAngle, this.maxAngle);
    return this._applyUs(this.usOf(a));
};

// Rampa nao bloqueante: S.tick()/HW.tick() aplica os passos.
Servo.prototype.to = function (angle, ms) {
    var a = _clamp(_num(angle, this._angle), this.minAngle, this.maxAngle);
    ms = Math.max(0, _num(ms, 0));
    // Ja esta na posicao (e ja escreveu): nao inicia rampa nem repete PWM.
    if (a === this._angle && this._written) {
        this._ramp = false;
        return true;
    }
    if (ms === 0) {
        this._ramp = false;
        return this.write(a);
    }
    this._from = this._angle;
    this._to = a;
    this._t0 = _now();
    this._ms = ms;
    this._ramp = true;
    return true;
};

// Rotacao continua: -100 (minUs) .. 0 (stopUs) .. +100 (maxUs).
Servo.prototype.speed = function (pct) {
    if (!this.continuous) return false;
    var p = _clamp(_num(pct, 0), -100, 100);
    var span = p >= 0 ? (this.maxUs - this.stopUs) : (this.stopUs - this.minUs);
    var us = this.stopUs + (p / 100) * span;
    if (this.invert) us = this.minUs + this.maxUs - us;
    return this.writeUs(us);
};

// Sequencia: [[angulo, ms], ...] (ou {angle, ms}); um passo por vez no tick.
Servo.prototype.play = function (frames) {
    if (!frames || !frames.length) {
        this.stop();
        return false;
    }
    this._queue = frames.slice();
    this._seq = true;
    this._nextSeqFrame(_now());
    return true;
};

Servo.prototype._nextSeqFrame = function (now) {
    while (this._seq && this._queue.length) {
        var f = this._queue.shift();
        var a = (f instanceof Array) ? f[0] : f.angle;
        var ms = (f instanceof Array) ? f[1] : f.ms;
        this.to(a, ms);
        if (this._ramp) return;
    }
    this._seq = false;
};

Servo.prototype._tick = function (now) {
    if (this._ramp) {
        var t = (now - this._t0) / this._ms;
        if (t >= 1) t = 1;
        if (t < 0) t = 0;
        var e = t * t * (3 - 2 * t);  // ease-in-out
        var next = this._from + (this._to - this._from) * e;
        // O PWM ja segura a posicao: so reescreve quando o angulo muda (ou no
        // primeiro passo, que e o attach).
        if (!this._written || Math.abs(next - this._angle) > 0.01)
            this._applyUs(this.usOf(next));
        if (t >= 1) {
            this._ramp = false;
            if (this._seq) this._nextSeqFrame(now);
        }
    } else if (this._seq) {
        this._nextSeqFrame(now);
    }
};

Servo.prototype.stop = function () {
    this._ramp = false;
    this._seq = false;
    this._queue = [];
    return this;
};

Servo.prototype.detach = function () {
    this._ramp = false;
    this._seq = false;
    this._queue = [];
    this._detached = true;
    var ok = this._offFn();
    this._written = false;
    return !!ok;
};

Servo.prototype.angle = function () { return this._angle; };
Servo.prototype.us = function () { return this._us; };
Servo.prototype.attached = function () { return this._written && !this._detached; };
Servo.prototype.moving = function () { return this._ramp; };

// Grupo: pose([angulos], ms) na ordem do array.
function Group(list) {
    this.list = list || [];
}

Group.prototype.pose = function (angles, ms) {
    var n = Math.min(this.list.length, angles.length);
    for (var i = 0; i < n; i++) this.list[i].to(angles[i], ms);
    return n;
};

Group.prototype.write = function (angles) {
    var n = Math.min(this.list.length, angles.length);
    for (var i = 0; i < n; i++) this.list[i].write(angles[i]);
    return n;
};

Group.prototype.home = function (ms) {
    var out = [];
    for (var i = 0; i < this.list.length; i++) {
        var s = this.list[i];
        out.push((s.minAngle + s.maxAngle) / 2);
    }
    return this.pose(out, ms);
};

Group.prototype.detach = function () {
    for (var i = 0; i < this.list.length; i++) this.list[i].detach();
};

S.create = function (o) {
    var s = new Servo(o);
    _all.push(s);
    return s;
};

S.group = function (list) { return new Group(list); };

// Tick global: uma chamada por quadro (o kit celeros.hw ja faz).
S.tick = function (now) {
    if (typeof now !== 'number') now = _now();
    for (var i = 0; i < _all.length; i++) {
        if (!_all[i]._detached) _all[i]._tick(now);
    }
};

S.available = function () {
    return typeof System !== 'undefined' && !!System.gpio && typeof System.gpio.servo === 'function';
};

module.exports = S;
