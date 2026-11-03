// celeros.hw.motor — ponte H em dois modos:
//   EN + IN1/IN2 (L298N, TB6612, DRV8871): 1 PWM + 2 GPIOs de direcao.
//   2 PWM (BTS7960/IBT-2, DRV8871 com duas entradas): 2 canais PWM.
// O PWM e o analogWrite do firmware (API 1): 8 bits, 5 kHz FIXOS e apenas
// 3 canais LEDC, entao no modo EN cabem 2 motores + 1 dimmer; no modo 2 PWM
// cabe 1 motor (ou 1 motor + 1 dimmer). Frequencia configuravel/mais canais
// ficam para uma proxima rodada do firmware.
//
// Uso tipico:
//   var M = require("celeros.hw.motor");
//   var m = M.create({ pwm: 18, in1: 19, in2: 20 });   // EN + 2 IN
//   var b = M.create({ pwmA: 18, pwmB: 19 });           // BTS7960
//   m.forward(70);          // 70% (liga na hora)
//   m.rampTo(-40, 500);     // reversao suave: zera, troca o sentido, sobe
//   m.brake();              // freio curto (IN1=IN2=1 / dois PWM em 255)
//   m.coast();              // roda livre (IN1=IN2=0 / dois PWM em 0)
//   M.tick();               // uma vez por quadro (ou HW.tick() do kit)
//
//   var p = M.pair(esq, dir);
//   p.tank(60, 40);         // diferencial
//   p.arcade(70, -30);      // velocidade + curva
//
// minDuty compensa o ponto morto do motor (ex.: 35 => 1% ja sai do lugar).
// Na saida do app o firmware zera o analogWrite e as direcoes (ver
// jsGpioReleaseOutputs), mas chame m.stop() no fluxo normal.
//
// ES5 (Duktape; permissao "gpio").

var M = { version: '1.1.0' };

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
    if (typeof System === 'undefined' || !System.gpio || !System.gpio.analogWrite)
        throw new Error('celeros.hw.motor: System.gpio.analogWrite indisponivel (permissao gpio)');
    return System.gpio;
}

function Motor(o) {
    o = o || {};
    this.pwm = (typeof o.pwm === 'number') ? (o.pwm | 0) : -1;
    this.in1 = (typeof o.in1 === 'number') ? (o.in1 | 0) : -1;
    this.in2 = (typeof o.in2 === 'number') ? (o.in2 | 0) : -1;
    this.pwmA = (typeof o.pwmA === 'number') ? (o.pwmA | 0) : -1;
    this.pwmB = (typeof o.pwmB === 'number') ? (o.pwmB | 0) : -1;
    this._twoPwm = this.pwmA >= 0 || this.pwmB >= 0;
    if (this._twoPwm) {
        if (this.pwmA < 0 || this.pwmB < 0 || this.pwmA === this.pwmB)
            throw new Error('celeros.hw.motor: informe pwmA e pwmB (dois pinos diferentes)');
        this.pwm = -1;
        this.in1 = -1;
        this.in2 = -1;
    } else if (this.pwm < 0 || this.in1 < 0 || this.in2 < 0) {
        throw new Error('celeros.hw.motor: informe pwm, in1 e in2 (ou pwmA/pwmB)');
    }
    this.invert = !!o.invert;
    this.minDuty = _clamp(_num(o.minDuty, 0), 0, 255);
    this.reverseMs = Math.max(0, _num(o.reverseMs, 150));

    this._g = _gpio();
    if (this._twoPwm) {
        this._g.pinMode(this.pwmA, this._g.OUTPUT);
        this._g.pinMode(this.pwmB, this._g.OUTPUT);
    } else {
        this._g.pinMode(this.pwm, this._g.OUTPUT);
        this._g.pinMode(this.in1, this._g.OUTPUT);
        this._g.pinMode(this.in2, this._g.OUTPUT);
    }

    this._speed = 0;      // ultimo valor comandado (-100..100)
    this._target = 0;
    this._pinsDir = 2;    // 2 = desconhecido (forca o primeiro write); -1/0/1
    this._phase = 0;      // 0 parado, 1 rampa
    this._from = 0;
    this._to = 0;
    this._t0 = 0;
    this._ms = 0;
    this._after = 0;      // alvo pendente depois de zerar (reversao)
    this._brake = false;
    this._coast = true;
    this.coast();  // nasce em roda livre (PWM 0, IN1/IN2 0)
}

Motor.prototype._applyPins = function (dir) {
    if (this._twoPwm) return;  // no modo 2 PWM a direcao sai nos dois duties
    if (this._pinsDir === dir) return;
    this._g.digitalWrite(this.in1, dir > 0 ? 1 : 0);
    this._g.digitalWrite(this.in2, dir < 0 ? 1 : 0);
    this._pinsDir = dir;
};

Motor.prototype._apply = function (speed) {
    var sp = _clamp(speed, -100, 100);
    var dir = sp > 0 ? 1 : (sp < 0 ? -1 : 0);
    if (this.invert) { dir = -dir; sp = -sp; }
    var duty = 0;
    if (dir !== 0) {
        duty = Math.round(this.minDuty + Math.abs(sp) * (255 - this.minDuty) / 100);
        if (duty > 255) duty = 255;
    }
    if (this._twoPwm) {
        this._g.analogWrite(this.pwmA, dir > 0 ? duty : 0);
        this._g.analogWrite(this.pwmB, dir < 0 ? duty : 0);
        this._pinsDir = dir;
    } else {
        this._applyPins(dir);
        this._g.analogWrite(this.pwm, duty);
    }
    this._brake = false;
    this._coast = (dir === 0);
};

Motor.prototype._rampTo = function (target, ms) {
    if (ms <= 0) {
        this._phase = 0;
        this._speed = target;
        this._apply(target);
        return;
    }
    this._from = this._speed;
    this._to = target;
    this._t0 = _now();
    this._ms = ms;
    this._phase = 1;
};

// Reversao suave: zera o PWM, troca IN1/IN2 e sobe. Sem isso o motor leva
// tranco de corrente (e a fonte pode cair) quando o sinal inverte andando.
Motor.prototype._request = function (target, ms) {
    target = _clamp(target, -100, 100);
    var cur = this._speed;
    if (target !== 0 && cur !== 0 && ((target > 0) !== (cur > 0))) {
        if (this.reverseMs <= 0) {
            // sem janela de reversao: zera e ja aplica o sentido novo
            this._speed = 0;
            this._apply(0);
            this._after = 0;
            this._rampTo(target, 0);
            return;
        }
        this._after = target;
        this._rampTo(0, this.reverseMs);
        return;
    }
    this._after = 0;
    this._rampTo(target, ms);
};

Motor.prototype._tick = function (now) {
    if (this._phase !== 1) return;
    var t = (now - this._t0) / this._ms;
    if (t >= 1) t = 1;
    if (t < 0) t = 0;
    var s = this._from + (this._to - this._from) * t;
    this._speed = s;
    this._apply(s);
    if (t >= 1) {
        this._phase = 0;
        this._speed = this._to;
        if (this._after !== 0) {
            var a = this._after;
            this._after = 0;
            this._request(a, this.reverseMs);
        }
    }
};

Motor.prototype.speed = function (pct) {
    this._target = _clamp(_num(pct, 0), -100, 100);
    this._request(this._target, 0);
    return this;
};

Motor.prototype.forward = function (pct) {
    return this.speed(Math.abs(_num(pct, 0)));
};

Motor.prototype.reverse = function (pct) {
    return this.speed(-Math.abs(_num(pct, 0)));
};

Motor.prototype.rampTo = function (pct, ms) {
    this._target = _clamp(_num(pct, 0), -100, 100);
    this._request(this._target, Math.max(0, _num(ms, 0)));
    return this;
};

Motor.prototype.brake = function () {
    this._phase = 0;
    this._after = 0;
    this._speed = 0;
    this._target = 0;
    if (this._twoPwm) {
        this._g.analogWrite(this.pwmA, 255);
        this._g.analogWrite(this.pwmB, 255);
    } else {
        this._g.analogWrite(this.pwm, 0);
        this._g.digitalWrite(this.in1, 1);
        this._g.digitalWrite(this.in2, 1);
    }
    this._pinsDir = 2;   // brake/coast tambem usam os pinos: proximo
                         // _applyPins precisa reescrever, nao confiar no cache
    this._brake = true;
    this._coast = false;
    return this;
};

Motor.prototype.coast = function () {
    this._phase = 0;
    this._after = 0;
    this._speed = 0;
    this._target = 0;
    if (this._twoPwm) {
        this._g.analogWrite(this.pwmA, 0);
        this._g.analogWrite(this.pwmB, 0);
    } else {
        this._g.analogWrite(this.pwm, 0);
        this._g.digitalWrite(this.in1, 0);
        this._g.digitalWrite(this.in2, 0);
    }
    this._pinsDir = 2;
    this._brake = false;
    this._coast = true;
    return this;
};

Motor.prototype.stop = function () { return this.coast(); };
Motor.prototype.isMoving = function () { return this._phase !== 0 || this._speed !== 0; };
Motor.prototype.speedNow = function () { return this._speed; };
Motor.prototype.target = function () { return this._target; };

M.create = function (o) {
    var m = new Motor(o);
    _all.push(m);
    return m;
};

// Dois motores (diferencial). tank(l, r) e arcade(velocidade, curva).
M.pair = function (left, right) {
    var p = {
        left: left,
        right: right,
        tank: function (l, r) {
            left.speed(l);
            right.speed(r);
            return p;
        },
        arcade: function (speed, turn) {
            speed = _clamp(_num(speed, 0), -100, 100);
            turn = _clamp(_num(turn, 0), -100, 100);
            left.speed(_clamp(speed + turn, -100, 100));
            right.speed(_clamp(speed - turn, -100, 100));
            return p;
        },
        stop: function () {
            left.stop();
            right.stop();
            return p;
        },
        tick: function (now) {
            left._tick(now);
            right._tick(now);
        }
    };
    return p;
};

M.tick = function (now) {
    if (typeof now !== 'number') now = _now();
    for (var i = 0; i < _all.length; i++) _all[i]._tick(now);
};

M.available = function () {
    return typeof System !== 'undefined' && !!System.gpio &&
           typeof System.gpio.analogWrite === 'function';
};

module.exports = M;
