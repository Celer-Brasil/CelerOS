// celeros.hw — kit unico de hardware: servo, ponte H, LED/fita, botao e
// PCA9685. Existe para o app declarar UMA dep (o limite e 8 por app) e para
// um UNICO setInterval alimentar todas as rampas/efeitos/botoes:
//
//   var HW = require("celeros.hw");
//   var servo = HW.servo.create({ pin: 12 });
//   var botao = HW.button.create({ pin: 0 });
//   botao.on('click', function () { servo.to(180, 300); });
//   HW.start(10);                  // um timer; chame HW.stop() ao sair
//   // ou, sem timer: HW.tick() uma vez por quadro
//
// Cada modulo tambem funciona sozinho (require("celeros.hw.servo") etc.);
// nesse caso use o start()/tick() do proprio modulo. NAO misture o start do
// kit com o start do modulo (dois timers para os mesmos objetos).
//
// Permissao "gpio" no app.json. O kit exige API 54 por causa do PCA9685;
// em firmware antigo requisite os modulos individuais (servo 10, motor 1,
// led 10, botao 12).

var HW = { version: '1.0.0' };

HW.servo = require('celeros.hw.servo');
HW.motor = require('celeros.hw.motor');
HW.led = require('celeros.hw.led');
HW.button = require('celeros.hw.button');
HW.pca9685 = require('celeros.hw.pca9685');

HW._timer = 0;

HW.tick = function (now) {
    if (typeof now !== 'number') {
        now = (typeof System !== 'undefined' && System.millis) ? System.millis() : 0;
    }
    HW.servo.tick(now);
    HW.motor.tick(now);
    HW.led.tick(now);
    HW.button.tick(now);
};

// Um setInterval para tudo (pool de 8 slots do firmware; piso 10 ms).
HW.start = function (ms) {
    if (HW._timer) return HW._timer;
    HW._timer = setInterval(function () { HW.tick(); }, Math.max(10, ms || 10));
    return HW._timer;
};

HW.stop = function () {
    if (HW._timer) {
        clearInterval(HW._timer);
        HW._timer = 0;
    }
};

module.exports = HW;
