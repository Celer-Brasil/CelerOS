// celeros.hw.pca9685 — driver do PCA9685 (16 canais PWM 12 bits, I2C) sobre
// o System.i2c do firmware (API 54). E o caminho para passar de 5 servos ou
// desafogar os canais LEDC: o chip gera os 16 PWM por conta propria e o
// firmware so escreve registradores.
//
// Uso tipico:
//   var PCA = require("celeros.hw.pca9685");
//   var p = PCA.create({ addr: 0x40, freq: 50 });   // bus da placa (begin)
//   if (!p.init()) { /* NACK: confira fiacao/endereco */ }
//   var s = p.servo(0, { minUs: 500, maxUs: 2500 });  // servo no canal 0
//   s.write(90);
//   p.setDuty(15, 0.5);          // canal 15 como dimmer de LED (50%)
//   p.sleep(); p.wake();
//
// Placa sem bus de placa (CYD/devkit): PCA.create({ sda: 22, scl: 27 }).
// V+ dos servos vai em fonte externa 5 V com GND comum; o VCC logico pode
// ser 3,3 V. O barramento e o mesmo do touch/PMU/OLED quando a placa tem um:
// nao chame System.i2c.end() com o app vivo sem antes fechar os devices.
//
// Registradores: MODE1 0x00, MODE2 0x01, LEDn_ON_L 0x06+4n, ALL_LED 0xFA,
// PRE_SCALE 0xFE. ES5 (Duktape; permissoes "gpio" + API 54).
//
// 1.0.1: endereco 0x40..0x77 (o binding do firmware recusa 0x78+ — faixa
// reservada do I2C; o create agora rejeita cedo com mensagem propria) e
// duty 100% de verdade: off 4096 liga o bit LED_FULL do LED_OFF_H (o chip
// so da saida cheia com esse bit; 4095 fica em 99.98%). setServoUs devolve
// false quando o pulso nao cabe em 12 bits na freq atual (antes virava
// 4095 silencioso).

var Servo = require('celeros.hw.servo');

var PCA = { version: '1.0.1' };

var REG_MODE1 = 0x00;
var REG_MODE2 = 0x01;
var REG_LED0 = 0x06;
var REG_ALL = 0xFA;
var REG_PRESCALE = 0xFE;

var MODE1_AI = 0x20;       // auto-incremento (writeReg de 4 bytes)
var MODE1_SLEEP = 0x10;    // oscilador parado (necessario p/ PRE_SCALE)
var MODE1_RESTART = 0x80;  // reinicia o PWM depois do sleep
var MODE2_OUTDRV = 0x04;   // saida totem-pole

function _num(v, d) {
    return (typeof v === 'number' && v === v) ? v : d;
}

function _clamp(v, a, b) {
    if (v < a) return a;
    if (v > b) return b;
    return v;
}

function _hex8(v) {
    var s = (v & 255).toString(16);
    while (s.length < 2) s = '0' + s;
    return '0x' + s;
}

// 25 MHz interno / (4096 * freq) - 1, clamp 3..255 (24..1526 Hz).
PCA.prescale = function (freq) {
    freq = _clamp(_num(freq, 50), 24, 1526);
    var p = Math.round(25000000 / (4096 * freq)) - 1;
    return _clamp(p, 3, 255);
};

PCA.available = function () {
    return typeof System !== 'undefined' && !!System.i2c &&
           typeof System.i2c.begin === 'function' &&
           typeof System.i2c.beginAt === 'function';
};

function Pca(o) {
    o = o || {};
    this.addr = (typeof o.addr === 'number') ? (o.addr | 0) : 0x40;
    // 0x40..0x77: a faixa do chip vai a 0x7F, mas 0x78+ e reservada do I2C
    // e o binding do firmware (System.i2c) recusa — falhar aqui e mais
    // claro que um RangeError na primeira escrita.
    if (this.addr < 0x40 || this.addr > 0x77)
        throw new Error('celeros.hw.pca9685: endereco deve ser 0x40..0x77');
    this.freq = _clamp(_num(o.freq, 50), 24, 1526);
    this.lastError = '';
    this.ready = false;
    this.closed = false;

    this._i2c = System.i2c;
    var bus;
    if (o.sda !== undefined || o.scl !== undefined) {
        if (o.sda === undefined || o.scl === undefined)
            throw new Error('celeros.hw.pca9685: informe sda E scl (ou nenhum, p/ o bus da placa)');
        bus = this._i2c.beginAt(o.sda | 0, o.scl | 0, _num(o.hz, 400000));
    } else {
        bus = this._i2c.begin();
    }
    if (!bus)
        throw new Error('celeros.hw.pca9685: nao consegui abrir o bus I2C (use sda/scl numa placa sem bus)');
    this.bus = bus;
}

Pca.prototype._writeReg = function (reg, data) {
    if (this.closed) return false;
    var ok = this._i2c.writeReg(this.addr, reg, data);
    if (!ok) this.lastError = 'NACK no registrador ' + _hex8(reg);
    return ok;
};

Pca.prototype._readReg = function (reg, len) {
    if (this.closed) return null;
    var d = this._i2c.readReg(this.addr, reg, len);
    if (!d) this.lastError = 'NACK na leitura do registrador ' + _hex8(reg);
    return d;
};

Pca.prototype._fail = function (what) {
    this.lastError = 'NACK em ' + what + ' (endereco ' + _hex8(this.addr) + ')';
    this.ready = false;
    return false;
};

// Sequencia de init: MODE2 totem-pole, SLEEP, PRE_SCALE, wake com AI,
// espera 500 us e RESTART. Devolve false em NACK (lastError diz o passo).
Pca.prototype.init = function () {
    this.ready = false;
    this.lastError = '';
    if (!this._writeReg(REG_MODE2, [MODE2_OUTDRV])) return this._fail('MODE2');
    if (!this._writeReg(REG_MODE1, [MODE1_SLEEP])) return this._fail('SLEEP');
    if (!this._writeReg(REG_PRESCALE, [PCA.prescale(this.freq)])) return this._fail('PRE_SCALE');
    if (!this._writeReg(REG_MODE1, [MODE1_AI])) return this._fail('WAKE');
    if (typeof System.delayMicroseconds === 'function') System.delayMicroseconds(500);
    else if (typeof System.delay === 'function') System.delay(1);
    if (!this._writeReg(REG_MODE1, [MODE1_AI | MODE1_RESTART])) return this._fail('RESTART');
    this.ready = true;
    return true;
};

Pca.prototype.setFreq = function (freq) {
    this.freq = _clamp(_num(freq, this.freq), 24, 1526);
    return this.init();
};

// on/off em contagens de 12 bits (0..4095; off 4096 = LED_FULL, saida
// cheia de verdade), auto-incremento do chip. O bit 4 do LED_OFF_H (0x10)
// e o LED_FULL: com ele setado o chip ignora a contagem e segura a saida.
Pca.prototype.setPwm = function (ch, on, off) {
    ch = ch | 0;
    if (ch < 0 || ch > 15) return false;
    on = _clamp(_num(on, 0) | 0, 0, 4095);
    off = _clamp(_num(off, 0) | 0, 0, 4096);
    return this._writeReg(REG_LED0 + 4 * ch,
                          [on & 0xFF, (on >> 8) & 0x0F,
                           off & 0xFF, (off >> 8) & 0x1F]);
};

// Duty 0..1 (4096 passos; 1.0 = saida cheia via LED_FULL).
Pca.prototype.setDuty = function (ch, duty) {
    duty = _clamp(_num(duty, 0), 0, 1);
    var off = Math.round(duty * 4096);
    return this.setPwm(ch, 0, off);
};

// Pulso de servo em us (400..2600), na frequencia atual do chip. False
// quando o pulso nao cabe em 12 bits nessa freq (us * freq > ~1e6: no
// maximo da faixa de 2600 us, frequencias acima de ~380 Hz). Servo roda
// em 50..333 Hz; acima disso e PWM de LED, nao de servo.
Pca.prototype.setServoUs = function (ch, us) {
    us = _clamp(_num(us, 1500), 400, 2600);
    var off = Math.round(us * 4096 * this.freq / 1000000);
    if (off > 4095) {
        this.lastError = 'pulso ' + us + ' us nao cabe em 12 bits a ' + this.freq + ' Hz';
        return false;
    }
    return this.setPwm(ch, 0, off);
};

// Angulo 0..180 (ou minAngle..maxAngle) -> us -> canal.
Pca.prototype.setServo = function (ch, angle, opts) {
    opts = opts || {};
    var minUs = _num(opts.minUs, 500);
    var maxUs = _num(opts.maxUs, 2500);
    var minAngle = _num(opts.minAngle, 0);
    var maxAngle = _num(opts.maxAngle, 180);
    if (maxAngle === minAngle) maxAngle = minAngle + 1;
    var a = _clamp(_num(angle, (minAngle + maxAngle) / 2) + _num(opts.offset, 0),
                   minAngle, maxAngle);
    var t = (a - minAngle) / (maxAngle - minAngle);
    if (opts.invert) t = 1 - t;
    return this.setServoUs(ch, minUs + t * (maxUs - minUs));
};

// Servo compativel com celeros.hw.servo (rampa/pose/detach no mesmo objeto).
Pca.prototype.servo = function (ch, opts) {
    var self = this;
    opts = opts || {};
    return Servo.create({
        write: function (us) { return self.setServoUs(ch, us); },
        off: function () { return self.setPwm(ch, 0, 0); },
        minUs: opts.minUs,
        maxUs: opts.maxUs,
        minAngle: opts.minAngle,
        maxAngle: opts.maxAngle,
        offset: opts.offset,
        invert: opts.invert
    });
};

// Todos os 16 canais em off (ALL_LED_ON_L, auto-incremento).
Pca.prototype.allOff = function () {
    return this._writeReg(REG_ALL, [0, 0, 0, 0]);
};

Pca.prototype.sleep = function () {
    return this._writeReg(REG_MODE1, [MODE1_SLEEP]);
};

Pca.prototype.wake = function () {
    if (!this._writeReg(REG_MODE1, [MODE1_AI])) return false;
    if (typeof System.delayMicroseconds === 'function') System.delayMicroseconds(500);
    else if (typeof System.delay === 'function') System.delay(1);
    return this._writeReg(REG_MODE1, [MODE1_AI | MODE1_RESTART]);
};

// Le on/off de um canal (12 bits + LED_FULL no bit 4 do byte alto de off;
// o chip tem auto-incremento na leitura).
Pca.prototype.readPwm = function (ch) {
    ch = ch | 0;
    if (ch < 0 || ch > 15) return null;
    var d = this._readReg(REG_LED0 + 4 * ch, 4);
    if (!d) return null;
    return {
        on: d[0] | ((d[1] & 0x0F) << 8),
        off: d[2] | ((d[3] & 0x1F) << 8)
    };
};

// Marca a instancia como fechada. NAO chama System.i2c.end(): outros devices
// do app (e o touch/OLED da placa) podem estar no mesmo bus — o app decide
// quando fechar o barramento.
Pca.prototype.close = function () {
    this.closed = true;
    this.ready = false;
    return true;
};

PCA.create = function (o) {
    if (!PCA.available())
        throw new Error('celeros.hw.pca9685: System.i2c indisponivel (API 54, permissao gpio)');
    return new Pca(o);
};

module.exports = PCA;
