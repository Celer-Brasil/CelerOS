// celeros.hw.dht — DHT11/DHT22 nativo (temperatura e umidade, API 55).
// O protocolo de microssegundos fica no firmware; a lib so chama e guarda a
// ultima leitura. O driver cacheia 1 s (DHT11) / 2 s (DHT22) por (pino,
// tipo), entao chamar em loop nao martela o sensor.
//
// Uso tipico:
//   var D = require("celeros.hw.dht");
//   var d = D.create({ pin: 4, type: 22 });
//   var r = d.read();          // {ok, temp, humidity, error}
//   if (r.ok) UI.text(r.temp + " C / " + r.humidity + "%", ...);
//
//   // ou pontual, sem instancia:
//   var r2 = D.read({ pin: 4, type: 11 });
//
// Alimente o modulo em 3,3 V: o data do DHT alimentado em 5 V nao e
// tolerante no ESP32. O pino precisa da permissao "gpio".
//
// ES5 (Duktape).

var D = { version: '1.0.0' };

function _num(v, d) {
    return (typeof v === 'number' && v === v) ? v : d;
}

function _bad(error) {
    return { ok: false, temp: 0, humidity: 0, error: error };
}

function Dht(o) {
    o = o || {};
    this.pin = (typeof o.pin === 'number') ? (o.pin | 0) : -1;
    if (this.pin < 0) throw new Error('celeros.hw.dht: informe pin');
    this.type = (o.type === 11) ? 11 : 22;
    if (!D.available())
        throw new Error('celeros.hw.dht: System.dht indisponivel (API 55, permissao gpio)');
    this.last = _bad('sem leitura');
}

Dht.prototype.read = function () {
    if (this.pin < 0) return _bad('sem pino');
    var r = System.dht.read(this.pin, this.type);
    if (!r || typeof r !== 'object') r = _bad('sem resposta');
    this.last = r;
    return r;
};

Dht.prototype.temp = function () { return this.last.ok ? this.last.temp : null; };
Dht.prototype.humidity = function () { return this.last.ok ? this.last.humidity : null; };
Dht.prototype.ok = function () { return !!this.last.ok; };
Dht.prototype.error = function () { return this.last.error || ''; };

D.create = function (o) { return new Dht(o); };

// Leitura pontual: D.read({pin, type}) -> {ok, temp, humidity, error}
D.read = function (o) {
    o = o || {};
    var pin = (typeof o.pin === 'number') ? (o.pin | 0) : -1;
    if (pin < 0) return _bad('sem pino');
    if (!D.available()) return _bad('System.dht indisponivel (API 55)');
    var type = (o.type === 11) ? 11 : 22;
    var r = System.dht.read(pin, type);
    return (r && typeof r === 'object') ? r : _bad('sem resposta');
};

D.available = function () {
    return typeof System !== 'undefined' && !!System.dht &&
           typeof System.dht.read === 'function';
};

module.exports = D;
