// celeros.hw.encoder — encoder incremental de quadratura A/B, contado no
// hardware (PCNT do ESP32/S3, API 55). O app le o acumulado e calcula a
// velocidade; nao ha polling de GPIO nem ISR em JS.
//
// Uso tipico:
//   var E = require("celeros.hw.encoder");
//   var e = E.create({ pinA: 18, pinB: 19 });   // pull-up interno default
//   e.read();            // contagem (com invert/scale)
//   e.speed();           // pulsos/s desde a ultima chamada
//   e.rpm(20);           // RPM com 20 pulsos por volta do eixo
//   e.reset(); e.free(); // zera / devolve a unidade PCNT
//
// invert troca o sinal (ou troque A/B); scale multiplica a contagem (ex.:
// reducao 1:20 => scale 20). O encoder precisa da permissao "gpio"; a
// contagem acumula alem de 32767 (o driver usa flags.accum_count).
//
// ES5 (Duktape).

var E = { version: '1.0.0' };

function _num(v, d) {
    return (typeof v === 'number' && v === v) ? v : d;
}

function _now() {
    return (typeof System !== 'undefined' && System.millis) ? System.millis() : 0;
}

function Encoder(o) {
    o = o || {};
    this.pinA = (typeof o.pinA === 'number') ? (o.pinA | 0)
             : (typeof o.a === 'number') ? (o.a | 0) : -1;
    this.pinB = (typeof o.pinB === 'number') ? (o.pinB | 0)
             : (typeof o.b === 'number') ? (o.b | 0) : -1;
    if (this.pinA < 0 || this.pinB < 0)
        throw new Error('celeros.hw.encoder: informe pinA e pinB');
    if (!E.available())
        throw new Error('celeros.hw.encoder: System.encoder indisponivel (API 55, permissao gpio)');

    this.invert = !!o.invert;
    this.scale = _num(o.scale, 1);
    this.id = System.encoder.create(this.pinA, this.pinB, o.pullup !== false);
    if (this.id < 0)
        throw new Error('celeros.hw.encoder: sem unidade PCNT livre (max 4)');

    this._lastCount = 0;
    this._lastMs = _now();
    this._speed = 0;      // pulsos/s (ja com invert/scale)
    var c = System.encoder.read(this.id);
    if (c !== null) this._lastCount = c;
}

// Contagem acumulada (com invert/scale).
Encoder.prototype.read = function () {
    if (this.id < 0) return null;
    var c = System.encoder.read(this.id);
    if (c === null) return null;
    var v = c * this.scale;
    return this.invert ? -v : v;
};

Encoder.prototype.counts = function () { return this.read(); };

Encoder.prototype.reset = function () {
    if (this.id < 0) return false;
    this._lastCount = 0;
    this._lastMs = _now();
    this._speed = 0;
    return !!System.encoder.reset(this.id);
};

// Pulsos/s desde a ultima chamada (dt real em ms).
Encoder.prototype.speed = function (now) {
    if (this.id < 0) return 0;
    if (typeof now !== 'number') now = _now();
    var c = System.encoder.read(this.id);
    if (c === null) return this._speed;
    var dt = now - this._lastMs;
    if (dt <= 0) return this._speed;
    var d = (c - this._lastCount) * this.scale;
    if (this.invert) d = -d;
    this._lastCount = c;
    this._lastMs = now;
    this._speed = d * 1000 / dt;
    return this._speed;
};

// RPM a partir dos pulsos por volta (efetivos, ja com o scale).
Encoder.prototype.rpm = function (countsPerRev, now) {
    countsPerRev = _num(countsPerRev, 0);
    if (countsPerRev === 0) return 0;
    return (this.speed(now) * 60) / countsPerRev;
};

Encoder.prototype.free = function () {
    if (this.id >= 0) {
        System.encoder.free(this.id);
        this.id = -1;
    }
};

E.create = function (o) { return new Encoder(o); };

E.available = function () {
    return typeof System !== 'undefined' && !!System.encoder &&
           typeof System.encoder.create === 'function';
};

module.exports = E;
