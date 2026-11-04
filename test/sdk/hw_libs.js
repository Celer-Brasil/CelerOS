// Testes das deps celeros.hw.* (servo, motor, LED, botao e PCA9685) no host.
// Carrega cada modulo pelo require do harness (mesma semantica do firmware)
// com um System falso controlavel: millis virtual, GPIO que grava as
// chamadas e o bus I2C em memoria do proprio harness.

'use strict';

var path = require('path');

module.exports = function (check) {
    var ROOT = path.resolve(__dirname, '..', '..');
    var harness = require('../js_harness/run.js');
    var ENGINE_DIR = path.join(ROOT, 'tools', 'sdk', 'engine');

    // System falso + require novo por teste (o cache do require guarda a
    // referencia ao System da primeira carga).
    function setup(extra) {
        var env = harness.makeEnv();
        var rec = {
            clock: 0,
            modes: [],
            writes: [],
            analog: [],
            servo: [],
            servoOff: [],
            led: [],
            neopixel: [],
            read: 1,
            error: null
        };
        env.__hw = rec;
        env.System.millis = function () { return rec.clock; };
        env.System.gpio = {
            INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2, HIGH: 1, LOW: 0,
            pinMode: function (p, m) { rec.modes.push([p, m]); },
            digitalWrite: function (p, v) { rec.writes.push([p, v]); },
            digitalRead: function (p) { return rec.read; },
            analogWrite: function (p, v) { rec.analog.push([p, v]); },
            servo: function (p, a) { rec.servo.push([p, a]); return true; },
            servoOff: function (p) { rec.servoOff.push(p); return true; }
        };
        env.System.led = function (r, g, b) { rec.led.push([r, g, b]); return true; };
        env.System.neopixel = function (i, colors) {
            rec.neopixel.push([i, colors.slice()]);
            return true;
        };
        if (extra) extra(env, rec);
        var req = harness.makeRequire(ENGINE_DIR, env);
        return { env: env, rec: rec, req: req };
    }

    // Converte o angulo fracionario do binding nativo (500..2500 us) em us.
    function usOfAngle(a) { return Math.round(500 + a * 2000 / 180); }

    // ------------------------------------------------------------ servo --
    (function () {
        console.log('SDK hw.servo:');

        var t = setup();
        var S = t.req('celeros.hw.servo');
        check('servo: exporta version e available', S.version === '1.1.1' && S.available() === true);
        var s = S.create({ pin: 12 });
        s.write(90);
        var last = t.rec.servo[t.rec.servo.length - 1];
        check('servo: write(90) vira 1500 us no pino', last[0] === 12 && usOfAngle(last[1]) === 1500,
              JSON.stringify(last));
        s.writeUs(600);
        check('servo: writeUs(600) pede 600 us', s.us() === 600 &&
              usOfAngle(t.rec.servo[t.rec.servo.length - 1][1]) === 600, 'us=' + s.us());

        var cal = S.create({ pin: 13, minUs: 600, maxUs: 2400 });
        cal.write(0);
        check('servo: calibracao 600..2400 aplica 600 us em 0 grau', cal.us() === 600, 'us=' + cal.us());
        cal.write(180);
        check('servo: calibracao aplica 2400 us em 180 graus', cal.us() === 2400, 'us=' + cal.us());
        cal.write(0);
        cal.invert = true;
        cal.write(0);
        check('servo: invert troca as pontas', cal.us() === 2400, 'us=' + cal.us());

        var r = S.create({ pin: 14 });
        r.write(0);
        var n0 = t.rec.servo.length;
        r.to(180, 100);
        S.tick(0);
        S.tick(50);
        S.tick(100);
        var us = [];
        for (var i = n0; i < t.rec.servo.length; i++) us.push(usOfAngle(t.rec.servo[i][1]));
        // o PWM so reescreve quando o angulo muda: a rampa grava 90 e 180
        check('servo: rampa 0->180 em 100 ms passa por 90 graus',
              us.length >= 2 && us[0] === 1500 && us[us.length - 1] === 2500,
              JSON.stringify(us));
        check('servo: fim da rampa para o movimento', r.moving() === false);

        r.detach();
        check('servo: detach solta o canal (servoOff)', t.rec.servoOff.indexOf(14) >= 0);

        var g = S.group([S.create({ pin: 15 }), S.create({ pin: 16 })]);
        g.pose([0, 180], 0);
        check('servo: group.pose aplica nos dois', t.rec.servo.length >= 2 &&
              t.rec.servo[t.rec.servo.length - 2][0] === 15 &&
              t.rec.servo[t.rec.servo.length - 1][0] === 16);

        // NaN nao e pino: NaN | 0 === 0 viraria GPIO 0 sem erro
        var nanThrew = false;
        try { S.create({ pin: NaN }); } catch (e) { nanThrew = true; }
        check('servo: pin NaN rejeitado (nao vira GPIO 0)', nanThrew);
    })();

    // ------------------------------------------------------------ motor --
    (function () {
        console.log('SDK hw.motor:');

        var t = setup();
        var M = t.req('celeros.hw.motor');
        check('motor: exporta version e available', M.version === '1.1.1' && M.available() === true);
        var m = M.create({ pwm: 18, in1: 19, in2: 20 });
        check('motor: create configura as 3 saidas e coast',
              t.rec.modes.length === 3 && t.rec.analog[0][1] === 0 &&
              t.rec.writes[t.rec.writes.length - 2][1] === 0,
              JSON.stringify({ modes: t.rec.modes, analog: t.rec.analog }));

        t.rec.analog = [];
        t.rec.writes = [];
        m.forward(50);
        check('motor: forward(50) = IN1 1, IN2 0, PWM 128',
              t.rec.writes.length === 2 && t.rec.writes[0][1] === 1 &&
              t.rec.writes[1][1] === 0 && t.rec.analog[0][1] === 128,
              JSON.stringify({ w: t.rec.writes, a: t.rec.analog }));

        t.rec.analog = [];
        t.rec.writes = [];
        m.reverse(50);
        M.tick(75);
        check('motor: reversao desce o PWM suavemente (janela reverseMs)',
              t.rec.analog[0][1] > 0 && t.rec.analog[0][1] < 128,
              JSON.stringify(t.rec.analog));
        check('motor: durante a descida o sentido nao troca',
              t.rec.writes.length === 0, JSON.stringify(t.rec.writes));
        M.tick(150);
        // speed() e imediato: ao fim da janela zera, troca IN1/IN2 e aplica
        check('motor: fim da janela zera o PWM e troca IN1/IN2 no mesmo tick',
              t.rec.analog[t.rec.analog.length - 2][1] === 0 &&
              t.rec.analog[t.rec.analog.length - 1][1] === 128 &&
              t.rec.writes[t.rec.writes.length - 2][1] === 0 &&
              t.rec.writes[t.rec.writes.length - 1][1] === 1,
              JSON.stringify({ a: t.rec.analog, w: t.rec.writes }));
        check('motor: reversao termina em -50% (PWM 128)',
              m.speedNow() === -50 &&
              t.rec.analog[t.rec.analog.length - 1][1] === 128,
              JSON.stringify(t.rec.analog));

        // rampTo preserva o ms do chamador na subida pos-reversao (1.1.1);
        // mesmo relogio da lib: rec.clock alimenta o System.millis virtual
        var m2 = M.create({ pwm: 24, in1: 25, in2: 26, reverseMs: 100 });
        m2.forward(40);
        t.rec.analog = [];
        t.rec.clock = 0;
        m2.rampTo(-40, 500);   // descida em reverseMs (100), t0 = 0
        t.rec.clock = 100; M.tick();   // fim da janela: PWM 0, subida armada
        check('motor: rampTo(-40,500) zera no fim da janela',
              t.rec.analog[t.rec.analog.length - 1][1] === 0,
              JSON.stringify(t.rec.analog));
        t.rec.clock = 350; M.tick();   // 250 ms na subida de 500 ms -> -20
        check('motor: subida pos-reversao usa o ms do rampTo (metade em -20)',
              t.rec.analog[t.rec.analog.length - 1][1] === 51,
              JSON.stringify(t.rec.analog));
        t.rec.clock = 600; M.tick();   // fim (500 ms apos a janela): -40
        check('motor: rampTo completa em -40 com os 500 ms respeitados',
              t.rec.analog[t.rec.analog.length - 1][1] === 102 &&
              m2.speedNow() === -40,
              JSON.stringify(t.rec.analog));

        var nanThrew = false;
        try { M.create({ pwm: NaN, in1: 5, in2: 6 }); } catch (e) { nanThrew = true; }
        check('motor: pino NaN rejeitado (nao vira GPIO 0)', nanThrew);

        t.rec.analog = [];
        t.rec.writes = [];
        m.brake();
        check('motor: brake = PWM 0 e IN1/IN2 em 1',
              t.rec.analog[0][1] === 0 && t.rec.writes[0][1] === 1 &&
              t.rec.writes[1][1] === 1, JSON.stringify(t.rec.writes));
        t.rec.writes = [];
        m.coast();
        check('motor: coast = IN1/IN2 em 0',
              t.rec.writes[0][1] === 0 && t.rec.writes[1][1] === 0,
              JSON.stringify(t.rec.writes));

        var d = M.create({ pwm: 21, in1: 22, in2: 23, minDuty: 40 });
        t.rec.analog = [];
        d.forward(1);
        check('motor: minDuty compensa o ponto morto', t.rec.analog[0][1] > 40,
              JSON.stringify(t.rec.analog));

        var p = M.pair(m, d);
        t.rec.analog = [];
        p.tank(60, 40);
        check('motor: pair.tank manda as duas velocidades', t.rec.analog.length >= 1);
    })();

    // -------------------------------------------------------------- led --
    (function () {
        console.log('SDK hw.led:');

        var t = setup();
        var L = t.req('celeros.hw.led');
        check('led: exporta version e available', L.version === '1.0.1' && L.available() === true);
        var led = L.create({ pin: 4 });
        led.on();
        check('led: on liga o pino', t.rec.writes[t.rec.writes.length - 1][1] === 1);
        led.off();
        check('led: off desliga o pino', t.rec.writes[t.rec.writes.length - 1][1] === 0);
        led.toggle();
        check('led: toggle liga', t.rec.writes[t.rec.writes.length - 1][1] === 1);

        var dim = L.create({ pin: 16, pwm: true });
        t.rec.analog = [];
        dim.set(50);
        check('led: pwm set(50) = analogWrite 128', t.rec.analog[0][1] === 128,
              JSON.stringify(t.rec.analog));

        t.rec.writes = [];
        led.blink(100);
        L.tick(0);
        L.tick(100);
        L.tick(200);
        check('led: blink alterna a cada 100 ms', t.rec.writes.length >= 3);

        t.rec.analog = [];
        dim.breathe(2000);
        L.tick(500);
        check('led: breathe em 1/4 do ciclo fica em ~50%', t.rec.analog.length > 0 &&
              t.rec.analog[t.rec.analog.length - 1][1] >= 127 &&
              t.rec.analog[t.rec.analog.length - 1][1] <= 128,
              JSON.stringify(t.rec.analog));

        t.rec.led = [];
        L.status(1, 2, 3);
        check('led: status usa o LED RGB da placa', t.rec.led.length === 1 &&
              t.rec.led[0][0] === 1 && t.rec.led[0][2] === 3, JSON.stringify(t.rec.led));

        var strip = L.strip({ index: 0, count: 4 });
        strip.fill(0x0000FF);
        strip.show();
        var np = t.rec.neopixel[t.rec.neopixel.length - 1];
        check('led: fita envia 4 LEDs no formato 0xRRGGBB',
              np[0] === 0 && np[1].length === 4 && np[1][0] === 0x0000FF,
              JSON.stringify(np));
        check('led: hsv(0,1,1) = vermelho e mix anda ate o destino',
              L.hsv(0, 1, 1) === 0xFF0000 && L.mix(0x000000, 0xFFFFFF, 0.5) === 0x808080,
              'hsv=' + L.hsv(0, 1, 1) + ' mix=' + L.mix(0, 0xFFFFFF, 0.5));

        var nanThrew = false;
        try { L.create({ pin: NaN }); } catch (e) { nanThrew = true; }
        check('led: pin NaN rejeitado (nao vira GPIO 0)', nanThrew);
    })();

    // ----------------------------------------------------------- button --
    (function () {
        console.log('SDK hw.button:');

        var t = setup();
        var B = t.req('celeros.hw.button');
        check('button: exporta version e available', B.version === '1.0.1' && B.available() === true);
        var ev = [];
        var b = B.create({ pin: 0, activeLow: true, debounceMs: 20, longMs: 100, doubleMs: 50 });
        var names = ['press', 'release', 'click', 'double', 'long', 'repeat'];
        for (var i = 0; i < names.length; i++) {
            (function (name) {
                b.on(name, function (ms) { ev.push(name + (ms === undefined ? '' : ':' + ms)); });
            })(names[i]);
        }

        function tick(at) { t.rec.clock = at; b.tick(at); }
        // solta/aperta com uma segunda passada de debounce (20 ms)
        function down(at) { t.rec.read = 0; tick(at); tick(at + 20); }
        function up(at) { t.rec.read = 1; tick(at); tick(at + 20); }

        // press + release curto: click depois da janela de double
        t.rec.read = 1; tick(0);
        down(10);          // press em 30
        tick(60);
        up(100);           // release em 120 -> held 90
        check('button: press e release chegam com a duracao',
              ev.indexOf('press:0') >= 0 && ev.indexOf('release:90') >= 0, JSON.stringify(ev));
        tick(170);
        check('button: click dispara depois de doubleMs', ev.indexOf('click:90') >= 0,
              JSON.stringify(ev));

        // double: dois toques dentro da janela
        ev = [];
        down(200);         // press 220
        up(260);           // release 280 -> held 60
        down(300);         // press 320 (ainda na janela)
        up(340);           // release 360 -> double
        check('button: dois toques viram double', ev.indexOf('double:40') >= 0,
              JSON.stringify(ev));

        // long: segurar >= longMs dispara uma vez, sem click depois
        ev = [];
        down(400);         // press 420
        tick(520);         // held 100 -> long
        up(540);           // release 560 (held 140, sem click)
        tick(620);
        check('button: long dispara no limiar e nao vira click',
              ev.indexOf('long:100') >= 0 && ev.indexOf('click:140') < 0,
              JSON.stringify(ev));

        // debounce: pulso menor que debounceMs nao conta
        ev = [];
        t.rec.read = 0; tick(700);
        t.rec.read = 1; tick(710);
        tick(760);
        check('button: pulso curto (< debounce) nao gera evento',
              ev.length === 0, JSON.stringify(ev));

        var nanThrew = false;
        try { B.create({ pin: NaN }); } catch (e) { nanThrew = true; }
        check('button: pin NaN rejeitado (nao vira GPIO 0)', nanThrew);
    })();

    // ----------------------------------------------------------- pca9685 --
    (function () {
        console.log('SDK hw.pca9685:');

        var t = setup(function (env) { env.__harness.i2cAdd(0x40); });
        var PCA = t.req('celeros.hw.pca9685');
        check('pca9685: exporta version/available/prescale',
              PCA.version === '1.0.1' && PCA.available() === true &&
              PCA.prescale(50) === 121 && PCA.prescale(60) === 101,
              'p50=' + PCA.prescale(50) + ' p60=' + PCA.prescale(60));

        var addrThrew = false;
        try { PCA.create({ addr: 0x78 }); } catch (e) { addrThrew = true; }
        check('pca9685: endereco 0x78+ recusado (faixa reservada do I2C)',
              addrThrew);

        var p = PCA.create({ addr: 0x40, freq: 50 });
        check('pca9685: create adota o bus do perfil', p.bus && p.bus.sda === 22);
        check('pca9685: init escreve MODE2/SLEEP/PRESCALE/wake/RESTART',
              p.init() === true, p.lastError);
        var regs = t.env.__harness.i2cRegs(0x40);
        check('pca9685: registradores do init (MODE1 0xA0, MODE2 0x04, PRE 121)',
              regs[0x01] === 0x04 && regs[0x00] === 0xA0 && regs[0xFE] === 121,
              JSON.stringify({ m1: regs[0x00], m2: regs[0x01], pre: regs[0xFE] }));

        check('pca9685: setServoUs(0,1500) = off 307 (0x0133)',
              p.setServoUs(0, 1500) === true &&
              regs[0x06] === 0 && regs[0x07] === 0 &&
              regs[0x08] === 0x33 && regs[0x09] === 0x01,
              JSON.stringify([regs[0x06], regs[0x07], regs[0x08], regs[0x09]]));

        check('pca9685: setPwm(1,100,2000) escreve 4 bytes',
              p.setPwm(1, 100, 2000) === true &&
              regs[0x0A] === 100 && regs[0x0B] === 0 &&
              regs[0x0C] === 0xD0 && regs[0x0D] === 0x07,
              JSON.stringify([regs[0x0A], regs[0x0B], regs[0x0C], regs[0x0D]]));
        var rp = p.readPwm(1);
        check('pca9685: readPwm volta on/off', rp && rp.on === 100 && rp.off === 2000,
              JSON.stringify(rp));

        check('pca9685: setDuty(15,0.5) = off 2048 (0x0800)',
              p.setDuty(15, 0.5) === true &&
              regs[0x44] === 0x00 && regs[0x45] === 0x08,
              JSON.stringify([regs[0x44], regs[0x45]]));

        // duty 1.0 = saida cheia de verdade: bit LED_FULL (0x10) no OFF_H
        check('pca9685: setDuty(14,1.0) liga o LED_FULL (OFF_H 0x10)',
              p.setDuty(14, 1.0) === true &&
              regs[0x40] === 0x00 && regs[0x41] === 0x10,
              JSON.stringify([regs[0x40], regs[0x41]]));
        var full = p.readPwm(14);
        check('pca9685: readPwm devolve off 4096 do LED_FULL',
              full && full.off === 4096, JSON.stringify(full));

        check('pca9685: sleep/wake mexem no MODE1', p.sleep() === true && regs[0x00] === 0x10 &&
              p.wake() === true && regs[0x00] === 0xA0,
              JSON.stringify([regs[0x00]]));

        check('pca9685: allOff zera os 4 registradores ALL_LED',
              p.allOff() === true && regs[0xFA] === 0 && regs[0xFB] === 0 &&
              regs[0xFC] === 0 && regs[0xFD] === 0);

        var s = p.servo(2);
        s.write(0);
        check('pca9685: servo() devolve um Servo que escreve no canal 2',
              regs[0x0E] === 0 && regs[0x10] === Math.round(500 * 4096 * 50 / 1000000) % 256,
              JSON.stringify([regs[0x0E], regs[0x0F], regs[0x10], regs[0x11]]));

        // pulso que nao cabe em 12 bits na freq: false honesto, nao 4095
        var p2 = PCA.create({ addr: 0x40, freq: 1526 });
        check('pca9685: setServoUs false quando o pulso nao cabe em 12 bits',
              p2.setServoUs(0, 1500) === false && p2.lastError.length > 0,
              p2.lastError);
        check('pca9685: de volta a 50 Hz o mesmo pulso cabe',
              p2.setFreq(50) === true && p2.setServoUs(0, 1500) === true,
              p2.lastError);

        check('pca9685: close marca fechado', p.close() === true && p.closed === true);
    })();

    // -------------------------------------------------------------- kit --
    (function () {
        console.log('SDK hw kit:');

        var t = setup(function (env) { env.__harness.i2cAdd(0x40); });
        var HW = t.req('celeros.hw');
        check('kit: reexporta os 5 modulos e a version',
              HW.version === '1.0.0' && !!HW.servo && !!HW.motor && !!HW.led &&
              !!HW.button && !!HW.pca9685);
        var s = HW.servo.create({ pin: 12 });
        s.to(180, 100);
        HW.tick(0);
        HW.tick(100);
        check('kit: HW.tick alimenta a rampa do servo',
              t.rec.servo.length >= 2 && usOfAngle(t.rec.servo[t.rec.servo.length - 1][1]) === 2500,
              JSON.stringify(t.rec.servo));
    })();

    // -------------------------------------- servoUs / continuo / sequencia --
    (function () {
        console.log('SDK hw.servo (API 55):');

        var t = setup(function (env, rec) {
            rec.servoUs = [];
            env.System.gpio.servoUs = function (p, us) {
                rec.servoUs.push([p, us]);
                return true;
            };
        });
        var S = t.req('celeros.hw.servo');
        var s = S.create({ pin: 17, minUs: 400, maxUs: 2600 });
        s.writeUs(400);
        check('servo: servoUs usa o pulso exato de 400 us',
              t.rec.servoUs.length === 1 && t.rec.servoUs[0][0] === 17 &&
              t.rec.servoUs[0][1] === 400, JSON.stringify(t.rec.servoUs));
        s.writeUs(2600);
        check('servo: servoUs usa o pulso exato de 2600 us',
              t.rec.servoUs[1][1] === 2600, JSON.stringify(t.rec.servoUs));

        var c = S.create({ pin: 18, continuous: true, stopUs: 1500 });
        c.speed(50);
        check('servo: continuous speed(50) = 2000 us', c.us() === 2000, 'us=' + c.us());
        c.speed(0);
        check('servo: continuous speed(0) = stopUs', c.us() === 1500, 'us=' + c.us());
        check('servo: speed em servo de posicao devolve false',
              S.create({ pin: 19 }).speed(50) === false);

        // invert espelha em volta do stopUs (1.1.1): speed(0) TEM que parar
        var ci = S.create({ pin: 21, continuous: true, stopUs: 1600, invert: true });
        ci.speed(0);
        check('servo: continuous invertido para no stopUs com speed(0)',
              ci.us() === 1600, 'us=' + ci.us());
        ci.speed(100);
        check('servo: invert espelha speed(100) em volta do stopUs',
              ci.us() === 700, 'us=' + ci.us());
        ci.speed(-100);
        check('servo: invert espelha speed(-100) (clamp na ponta)',
              ci.us() === 2500, 'us=' + ci.us());

        var q = S.create({ pin: 20 });
        q.play([[0, 50], [180, 50]]);
        S.tick(0);
        S.tick(50);
        S.tick(100);
        check('servo: play encadeia as poses', q.angle() === 180 && q.us() === 2500,
              'angle=' + q.angle() + ' us=' + q.us());
    })();

    // ------------------------------------------------------ motor 2 PWM --
    (function () {
        console.log('SDK hw.motor (2 PWM):');

        var t = setup();
        var M = t.req('celeros.hw.motor');
        var b = M.create({ pwmA: 21, pwmB: 22 });
        check('motor: 2 PWM configura os dois pinos', t.rec.modes.length === 2 &&
              t.rec.modes[0][0] === 21 && t.rec.modes[1][0] === 22,
              JSON.stringify(t.rec.modes));
        t.rec.analog = [];
        b.forward(50);
        check('motor: 2 PWM forward liga A e zera B',
              t.rec.analog.length === 2 && t.rec.analog[0][0] === 21 &&
              t.rec.analog[0][1] === 128 && t.rec.analog[1][1] === 0,
              JSON.stringify(t.rec.analog));
        t.rec.analog = [];
        b.reverse(50);
        M.tick(150);
        M.tick(300);
        check('motor: 2 PWM reverse liga B e zera A',
              t.rec.analog[t.rec.analog.length - 2][1] === 0 &&
              t.rec.analog[t.rec.analog.length - 1][1] === 128,
              JSON.stringify(t.rec.analog));
        t.rec.analog = [];
        b.brake();
        check('motor: 2 PWM brake = os dois em 255',
              t.rec.analog[0][1] === 255 && t.rec.analog[1][1] === 255,
              JSON.stringify(t.rec.analog));
    })();

    // ------------------------------------------------------------ encoder --
    (function () {
        console.log('SDK hw.encoder:');

        var t = setup();
        var E = t.req('celeros.hw.encoder');
        check('encoder: exporta version e available',
              E.version === '1.0.1' && E.available() === true);
        var e = E.create({ pinA: 18, pinB: 19 });
        check('encoder: create devolve o id 0', e.id === 0);
        t.env.__harness.encoderSet(0, 100);
        check('encoder: read le a contagem', e.read() === 100, 'read=' + e.read());
        t.rec.clock = 100;
        check('encoder: speed = 1000 pulsos/s', e.speed(100) === 1000, 'speed=' + e.speed(100));
        t.env.__harness.encoderSet(0, 120);
        t.rec.clock = 200;
        check('encoder: speed seguinte = 200 pulsos/s', e.speed(200) === 200, 'speed=' + e.speed(200));
        t.env.__harness.encoderSet(0, 140);
        t.rec.clock = 300;
        check('encoder: rpm(20) = 600', Math.round(e.rpm(20, 300)) === 600,
              'rpm=' + e.rpm(20, 300));

        var e2 = E.create({ pinA: 20, pinB: 21, invert: true, scale: 2 });
        t.env.__harness.encoderSet(e2.id, 50);
        check('encoder: invert/scale aplicam no read', e2.read() === -100,
              'read=' + e2.read());
        check('encoder: reset zera a contagem', e2.reset() === true &&
              t.env.__harness.encoderGet(e2.id) === 0);
        e2.free();
        check('encoder: free libera o id', e2.id === -1);

        var nanThrew = false;
        try { E.create({ pinA: NaN, pinB: 8 }); } catch (e) { nanThrew = true; }
        check('encoder: pino NaN rejeitado (nao vira GPIO 0)', nanThrew);
    })();

    // --------------------------------------------------------------- dht --
    (function () {
        console.log('SDK hw.dht:');

        var t = setup(function (env) {
            // pino negado pela placa: o binding nativo da RangeError
            var orig = env.System.dht.read;
            env.System.dht.read = function (pin, type) {
                if (pin === 13) throw new RangeError('GPIO 13 invalido para DHT');
                return orig(pin, type);
            };
        });
        var D = t.req('celeros.hw.dht');
        check('dht: exporta version e available',
              D.version === '1.0.1' && D.available() === true);
        t.env.__harness.dhtSet(4, 22, { ok: true, temp: 23.5, humidity: 45.2 });
        var r = D.read({ pin: 4, type: 22 });
        check('dht: read pontual devolve temp/umidade', r.ok === true &&
              r.temp === 23.5 && r.humidity === 45.2, JSON.stringify(r));
        var d = D.create({ pin: 4, type: 22 });
        d.read();
        check('dht: instancia guarda a ultima leitura', d.ok() === true &&
              d.temp() === 23.5 && d.humidity() === 45.2);
        var miss = D.read({ pin: 5, type: 22 });
        check('dht: sem sensor devolve ok=false e erro',
              miss.ok === false && miss.error === 'sem resposta', JSON.stringify(miss));
        t.env.__harness.dhtSet(4, 11, { ok: true, temp: 20, humidity: 60 });
        check('dht: tipo 11 usa a entrada certa', D.read({ pin: 4, type: 11 }).temp === 20);

        // pino negado: {ok:false, error} em vez de quebrar o app (1.0.1)
        var denied = D.read({ pin: 13, type: 22 });
        check('dht: pino negado devolve {ok:false} com o erro do binding',
              denied.ok === false && denied.temp === 0 &&
              denied.error.length > 0, JSON.stringify(denied));
        var di = D.create({ pin: 13, type: 22 });
        var r2 = di.read();
        check('dht: instancia tambem captura o pino negado',
              r2.ok === false && di.ok() === false && di.temp() === null,
              JSON.stringify(r2));
    })();
};
