// CelerOS Hardware Lab — bancada de servo, ponte H, LED/fita, botao com
// gestos e PCA9685. Usa o kit celeros.hw (um setInterval alimenta todas as
// rampas/efeitos) e o CelerKit A/A.form para as telas. ES5 (Duktape).
//
// Permissao "gpio". O I2C exige API 54 (System.i2c). Placas com bus de placa
// (SmartDisplay 19/45, watch 15/14, cao 41/42) usam o bus do touch/PMU/OLED
// direto; CYD/devkit abrem pinos na tela I2C. O PCA9685 precisa de V+ externo
// 5 V para os servos e GND comum com a placa.

var A = require("celeros.app");
require("celeros.app.form");
var HW = require("celeros.hw");
A.init();

var T = A.T || System.theme();
var LX = A.L.x, LW = A.L.w, BOTTOM = A.L.bottom;

var G = (typeof System.gpio === "object" && System.gpio) ? System.gpio : null;
var I2C = (typeof System.i2c === "object" && System.i2c) ? System.i2c : null;
var INFO = {};
try { INFO = System.getInfo() || {}; } catch (eInfo) { INFO = {}; }
var API = 0;
try { API = System.getAPILevel(); } catch (eApi) { API = 0; }
var BOARD_I2C = null;
try { BOARD_I2C = I2C ? I2C.pins() : null; } catch (eBus) { BOARD_I2C = null; }

var PIN_MIN = 0, PIN_MAX = 48;

// ---- estado ---------------------------------------------------------------
var servoPin = 12, servoAngle = 90, servoRampIdx = 2;
var RAMP_MS = [0, 200, 500, 1000];
var RAMP_LABELS = ["0 ms", "200 ms", "500 ms", "1000 ms"];
var servo = null;

var motorPwm = 18, motorIn1 = 19, motorIn2 = 20;
var motorMin = 40, motorSpeed = 40, motorRampIdx = 1;
var MOTOR_RAMP_MS = [0, 300, 1000];
var MOTOR_RAMP_LABELS = ["0 ms", "300 ms", "1000 ms"];
var motor = null;

var ledPin = 4, ledPwm = false, ledLevel = 100, ledMode = 0;
var LED_MODES = ["Fixo", "Pisca", "Breathe", "Fita"];
var led = null;
var stripIdx = 0, stripCount = 4, strip = null;

var btnPin = 0, btnPullup = true, btnDebounce = 20, btnLong = 1200, btnDouble = 300;
var button = null, btnGen = 0, btnEvents = [], btnLast = "-";

var i2cSda = BOARD_I2C ? BOARD_I2C.sda : 22;
var i2cScl = BOARD_I2C ? BOARD_I2C.scl : 27;
var i2cHzIdx = 1;
if (BOARD_I2C && BOARD_I2C.hz === 100000) i2cHzIdx = 0;
else if (BOARD_I2C && BOARD_I2C.hz === 1000000) i2cHzIdx = 2;
var I2C_HZ = [100000, 400000, 1000000];
var I2C_HZ_LABELS = ["100 kHz", "400 kHz", "1 MHz"];
var scanFound = [];
var pcaAddr = 0x40, pcaCh = 0, pcaAngle = 90, pcaReady = false;
var pca = null;

function hex(n) {
    var s = (n | 0).toString(16).toUpperCase();
    while (s.length < 2) s = "0" + s;
    return "0x" + s;
}

function hexList(a) {
    var out = [];
    for (var i = 0; i < a.length; i++) out.push(hex(a[i]));
    return out.join(" ");
}

// ---- construtores preguicosos ---------------------------------------------
function ensureServo() {
    if (servo && servo.pin === servoPin) return servo;
    if (servo) { try { servo.detach(); } catch (e0) {} }
    servo = HW.servo.create({ pin: servoPin });
    return servo;
}

function ensureMotor() {
    if (motor && motor.pwm === motorPwm && motor.in1 === motorIn1 &&
        motor.in2 === motorIn2 && motor.minDuty === motorMin) return motor;
    if (motor) { try { motor.coast(); } catch (e1) {} }
    motor = HW.motor.create({ pwm: motorPwm, in1: motorIn1, in2: motorIn2,
                              minDuty: motorMin });
    return motor;
}

function ensureLed() {
    if (led && led.pin === ledPin && led.pwm === ledPwm) return led;
    if (led) { try { led.off(); } catch (e2) {} }
    led = HW.led.create({ pin: ledPin, pwm: ledPwm });
    return led;
}

function ensureStrip() {
    if (strip && strip.index === stripIdx && strip.count === stripCount) return strip;
    strip = HW.led.strip({ index: stripIdx, count: stripCount });
    return strip;
}

function ensurePca() {
    if (pca && pca.addr === pcaAddr) return pca;
    pca = HW.pca9685.create({ addr: pcaAddr, freq: 50 });
    return pca;
}

function logEvent(name, ms) {
    var line = name + (ms === undefined ? "" : ":" + ms);
    btnLast = line;
    btnEvents.push(line);
    while (btnEvents.length > 12) btnEvents.shift();
}

// O botao antigo continua no tick do kit (nao ha destroy); a geracao faz os
// handlers velhos ignorarem os eventos.
function newButton() {
    btnGen++;
    var gen = btnGen;
    button = HW.button.create({ pin: btnPin, activeLow: true, pullup: btnPullup,
                                debounceMs: btnDebounce, longMs: btnLong,
                                doubleMs: btnDouble });
    var names = ["press", "release", "click", "double", "long", "repeat"];
    for (var i = 0; i < names.length; i++) {
        (function (name) {
            button.on(name, function (ms) {
                if (gen !== btnGen) return;
                logEvent(name, ms);
            });
        })(names[i]);
    }
    btnEvents = [];
    btnLast = "criado";
}

// ---- formulario generico ---------------------------------------------------
function card(lines) {
    UI.card(LX, 44, LW, 62);
    for (var i = 0; i < lines.length; i++) {
        UI.text(lines[i][0], LX + 8, 52 + i * 19,
                { role: i === 0 ? "body" : "caption",
                  color: lines[i][1] || T.text, w: LW - 16, lines: 1, bg: T.card });
    }
    UI.cardEnd();
}

function paintRow(r, x, y, w, h) {
    var lh = UI.lineHeight("body"), cap = UI.lineHeight("caption");
    if (r.k === "secao") {
        UI.text(String(r.label).toUpperCase(), x, y + 2,
                { role: "caption", color: T.textDim, w: w, lines: 1 });
        return;
    }
    if (r.k === "info") {
        UI.text(r.label, x, y + ((h - lh) >> 1),
                { role: "body", color: T.text, w: w - 96, lines: 1 });
        UI.text(String(r.right), x + w - 6, y + ((h - cap) >> 1),
                { role: "caption", align: "right", color: r.rightColor || T.textDim,
                  w: 92, lines: 1 });
        return;
    }
    if (r.k === "action") {
        UI.text(r.label, x, y + ((h - lh) >> 1),
                { role: "body", color: T.accent, w: w, lines: 1 });
        return;
    }
    // toggle / choice / stepper
    var rw = (r.k === "stepper" || r.k === "choice") ? 92 : 50;
    UI.text(r.label, x, y + ((h - lh) >> 1),
            { role: "body", color: T.text, w: w - rw - 6, lines: 1 });
    if (r.k === "toggle") {
        var tv = UI.toggle(x + w - 44, y + ((h - 24) >> 1), !!r.get());
        if (tv !== r.get()) r.set(tv);
    } else if (r.k === "stepper") {
        var sv = r.get();
        if (UI.button("-", x + w - 92, y + 2, 26, h - 4, { style: "ghost" }))
            r.set(Math.max(r.min, sv - r.step));
        if (UI.button("+", x + w - 30, y + 2, 26, h - 4, { style: "ghost" }))
            r.set(Math.min(r.max, sv + r.step));
        UI.text(r.fmt ? r.fmt(sv) : String(sv), x + w - 66, y + ((h - lh) >> 1),
                { role: "body", align: "center", color: T.text, w: 34, lines: 1 });
    } else if (r.k === "choice") {
        var cv = r.get() | 0, co = r.opts || [];
        var ci = co.length ? ((cv % co.length) + co.length) % co.length : 0;
        UI.text(co[ci] === undefined ? "" : String(co[ci]), x + w - 8,
                y + ((h - cap) >> 1), { role: "caption", align: "right",
                color: T.textDim, w: 84, lines: 1 });
    }
}

function tapRow(i, rows) {
    var r = rows[i];
    if (!r) return;
    if (r.k === "action" && r.cb) {
        r.cb();
        UI.invalidate();
    } else if (r.k === "choice") {
        r.set(((r.get() | 0) + 1) % r.opts.length);
        UI.invalidate();
    } else if (r.k === "toggle") {
        r.set(!r.get());
        UI.invalidate();
    } else if (r.k === "stepper") {
        var v = A.form.askNum(r.label, { min: r.min, max: r.max, initial: r.get(),
            hint: r.min + " a " + r.max, int: r.step >= 1 });
        if (v !== null) { r.set(v); UI.invalidate(); }
    }
}

// ---- telas ----------------------------------------------------------------
function telaMain(c) {
    if (A.header("Hardware Lab", { back: false })) return A.BACK;
    card([
        [INFO.board || "CelerOS", T.text],
        ["API " + API + " · GPIO " + (G ? "ok" : "off") + " · I2C " + (I2C ? "ok" : "off"), T.textDim],
        [BOARD_I2C ? ("bus " + BOARD_I2C.port + " · SDA " + BOARD_I2C.sda + " · SCL " + BOARD_I2C.scl)
                   : "sem bus I2C de placa", T.textDim]
    ]);
    var i = UI.list("hw:main", LX, 116, LW, BOTTOM - 116,
                    ["Servo", "Ponte H", "LED / fita", "Botao", "I2C / PCA9685"],
                    { row: 40 });
    if (i === 0) return "servo";
    if (i === 1) return "motor";
    if (i === 2) return "led";
    if (i === 3) return "button";
    if (i === 4) return "i2c";
    return undefined;
}

var servoRows = [
    A.form.stepper("Pino do servo", function () { return servoPin; },
                    function (v) { servoPin = v; },
                    { min: PIN_MIN, max: PIN_MAX, step: 1 }),
    A.form.stepper("Angulo", function () { return servoAngle; },
                    function (v) { servoAngle = v; },
                    { min: 0, max: 180, step: 5, fmt: function (v) { return v + "°"; } }),
    A.form.choice("Rampa", function () { return servoRampIdx; },
                   function (v) { servoRampIdx = v; }, RAMP_LABELS),
    A.form.action("Aplicar", function () {
        var s = ensureServo();
        s.to(servoAngle, RAMP_MS[servoRampIdx]);
    }),
    A.form.action("Soltar (detach)", function () {
        if (servo) servo.detach();
    }),
    A.form.action("Varrer 0-180", function () {
        var s = ensureServo();
        s.write(0);
        s.to(180, 800);
    })
];

function telaServo(c) {
    if (A.header("Servo")) return A.BACK;
    var state = "nao criado";
    if (servo) {
        state = (servo.attached() ? "anexado" : "solto") +
                " · " + Math.round(servo.angle()) + "° · " + Math.round(servo.us()) + " us";
    }
    card([["GPIO " + servoPin, T.text], [state, T.textDim],
          ["500..2500 us · 5 canais nativos", T.textDim]]);
    var i = A.list.view("hw:servo", LX, 116, LW, BOTTOM - 116, servoRows,
                        { row: 40, paintRow: paintRow });
    if (i >= 0) tapRow(i, servoRows);
    return undefined;
}

var motorRows = [
    A.form.stepper("PWM (EN)", function () { return motorPwm; },
                    function (v) { motorPwm = v; },
                    { min: PIN_MIN, max: PIN_MAX, step: 1 }),
    A.form.stepper("IN1", function () { return motorIn1; },
                    function (v) { motorIn1 = v; },
                    { min: PIN_MIN, max: PIN_MAX, step: 1 }),
    A.form.stepper("IN2", function () { return motorIn2; },
                    function (v) { motorIn2 = v; },
                    { min: PIN_MIN, max: PIN_MAX, step: 1 }),
    A.form.stepper("Ponto morto", function () { return motorMin; },
                    function (v) { motorMin = v; },
                    { min: 0, max: 200, step: 5 }),
    A.form.stepper("Velocidade", function () { return motorSpeed; },
                    function (v) { motorSpeed = v; },
                    { min: -100, max: 100, step: 10, fmt: function (v) { return v + "%"; } }),
    A.form.choice("Rampa", function () { return motorRampIdx; },
                   function (v) { motorRampIdx = v; }, MOTOR_RAMP_LABELS),
    A.form.action("Aplicar", function () {
        var m = ensureMotor();
        m.rampTo(motorSpeed, MOTOR_RAMP_MS[motorRampIdx]);
    }),
    A.form.action("Freio", function () { if (motor) motor.brake(); }),
    A.form.action("Roda livre", function () { if (motor) motor.coast(); })
];

function telaMotor(c) {
    if (A.header("Ponte H")) return A.BACK;
    var state = "nao criado";
    if (motor) {
        state = Math.round(motor.speedNow()) + "%" +
                (motor.isMoving() ? " (rampa)" : "") + " · " + (motor.isMoving() ? "andando" : "parado");
    }
    card([["EN " + motorPwm + " · IN " + motorIn1 + "/" + motorIn2, T.text],
          [state, T.textDim],
          ["1 PWM = 8 bits · 3 canais no total", T.textDim]]);
    var i = A.list.view("hw:motor", LX, 116, LW, BOTTOM - 116, motorRows,
                        { row: 40, paintRow: paintRow });
    if (i >= 0) tapRow(i, motorRows);
    return undefined;
}

var ledRows = [
    A.form.stepper("Pino", function () { return ledPin; },
                    function (v) { ledPin = v; },
                    { min: PIN_MIN, max: PIN_MAX, step: 1 }),
    A.form.toggle("PWM (brilho)", function () { return ledPwm; },
                   function (v) { ledPwm = v; }),
    A.form.stepper("Nivel", function () { return ledLevel; },
                    function (v) { ledLevel = v; },
                    { min: 0, max: 100, step: 10, fmt: function (v) { return v + "%"; } }),
    A.form.choice("Modo", function () { return ledMode; },
                   function (v) { ledMode = v; }, LED_MODES),
    A.form.action("Aplicar", function () {
        var l = ensureLed();
        if (ledMode === 0) l.set(ledLevel);
        else if (ledMode === 1) l.blink(500);
        else if (ledMode === 2) l.breathe(2000);
        else { var s0 = ensureStrip(); s0.fill(HW.led.rgb(255, 0, 0)); s0.show(); }
    }),
    A.form.action("Apagar", function () { if (led) led.off(); }),
    A.form.action("Status RGB (verde)", function () { HW.led.status(0, 40, 0); }),
    A.form.action("Status off", function () { HW.led.statusOff(); }),
    A.form.secao("Fita WS2812"),
    A.form.stepper("Indice da fita", function () { return stripIdx; },
                    function (v) { stripIdx = v; },
                    { min: 0, max: 1, step: 1 }),
    A.form.stepper("LEDs", function () { return stripCount; },
                    function (v) { stripCount = v; },
                    { min: 1, max: 8, step: 1 }),
    A.form.action("Fita vermelha", function () {
        var s = ensureStrip();
        s.fill(HW.led.rgb(255, 0, 0));
        s.show();
    }),
    A.form.action("Fita rainbow", function () { ensureStrip().rainbow(2000); }),
    A.form.action("Fita apagada", function () { ensureStrip().clear().show(); })
];

function telaLed(c) {
    if (A.header("LED / fita")) return A.BACK;
    var state = "nao criado";
    if (led) state = led.level() + "%" + (ledPwm ? " (PWM)" : " (digital)");
    card([["GPIO " + ledPin + " · " + LED_MODES[ledMode], T.text],
          [state, T.textDim],
          [HW.led.hasStatus() ? "LED RGB de status disponivel" : "sem LED RGB de status",
           T.textDim]]);
    var i = A.list.view("hw:led", LX, 116, LW, BOTTOM - 116, ledRows,
                        { row: 38, paintRow: paintRow });
    if (i >= 0) tapRow(i, ledRows);
    return undefined;
}

var buttonRows = [
    A.form.stepper("Pino", function () { return btnPin; },
                    function (v) { btnPin = v; },
                    { min: PIN_MIN, max: PIN_MAX, step: 1 }),
    A.form.toggle("Pull-up interno", function () { return btnPullup; },
                   function (v) { btnPullup = v; }),
    A.form.stepper("Debounce", function () { return btnDebounce; },
                    function (v) { btnDebounce = v; },
                    { min: 5, max: 100, step: 5, fmt: function (v) { return v + " ms"; } }),
    A.form.stepper("Longo", function () { return btnLong; },
                    function (v) { btnLong = v; },
                    { min: 300, max: 3000, step: 100, fmt: function (v) { return v + " ms"; } }),
    A.form.stepper("Duplo", function () { return btnDouble; },
                    function (v) { btnDouble = v; },
                    { min: 100, max: 1000, step: 50, fmt: function (v) { return v + " ms"; } }),
    A.form.action("Criar / reiniciar botao", function () { newButton(); }),
    A.form.action("Limpar log", function () { btnEvents = []; btnLast = "-"; })
];

function telaButton(c) {
    if (A.header("Botao")) return A.BACK;
    var state = "nao criado";
    if (button) state = (button.pressed() ? "apertado" : "solto") +
                        " · " + Math.round(button.heldMs()) + " ms";
    var log = btnEvents.length ? btnEvents.slice(-2).join(" · ") : "sem eventos";
    card([["GPIO " + btnPin + " -> GND", T.text], [state, T.textDim], [log, T.textDim]]);
    var i = A.list.view("hw:button", LX, 116, LW, BOTTOM - 116, buttonRows,
                        { row: 40, paintRow: paintRow });
    if (i >= 0) tapRow(i, buttonRows);
    return undefined;
}

function i2cRows() {
    var rows = [
        A.form.info("Placa", INFO.board || "?"),
        A.form.info("Bus de placa", BOARD_I2C ? (BOARD_I2C.sda + "/" + BOARD_I2C.scl) : "nenhum"),
        A.form.stepper("SDA", function () { return i2cSda; },
                        function (v) { i2cSda = v; },
                        { min: PIN_MIN, max: PIN_MAX, step: 1 }),
        A.form.stepper("SCL", function () { return i2cScl; },
                        function (v) { i2cScl = v; },
                        { min: PIN_MIN, max: PIN_MAX, step: 1 }),
        A.form.choice("Frequencia", function () { return i2cHzIdx; },
                       function (v) { i2cHzIdx = v; }, I2C_HZ_LABELS),
        A.form.action("Abrir bus", function () {
            try {
                var bus = I2C.beginAt(i2cSda, i2cScl, I2C_HZ[i2cHzIdx]);
                if (!bus) A.error("I2C", "Nao consegui abrir o bus (pinos ocupados?)");
            } catch (e4) { A.error("I2C", String(e4 && e4.message ? e4.message : e4)); }
        }),
        A.form.action("Escanear 0x08..0x77", function () {
            var bus = I2C.begin();
            if (!bus) bus = I2C.beginAt(i2cSda, i2cScl, I2C_HZ[i2cHzIdx]);
            if (!bus) { A.error("I2C", "Abra o bus primeiro"); return; }
            A.busy("Escaneando I2C...");
            try { scanFound = I2C.scan() || []; }
            catch (e5) { scanFound = []; A.error("I2C", String(e5 && e5.message ? e5.message : e5)); }
        }),
        A.form.info("Achados", scanFound.length ? hexList(scanFound) : "-"),
        A.form.secao("PCA9685"),
        A.form.stepper("Endereco", function () { return pcaAddr; },
                        function (v) { pcaAddr = v; },
                        { min: 0x40, max: 0x7F, step: 1, fmt: function (v) { return hex(v); } }),
        A.form.action("Iniciar PCA", function () {
            var bus = I2C.begin();
            if (!bus) bus = I2C.beginAt(i2cSda, i2cScl, I2C_HZ[i2cHzIdx]);
            if (!bus) { A.error("I2C", "Abra o bus primeiro"); return; }
            try {
                var p = ensurePca();
                pcaReady = p.init();
                if (!pcaReady) A.error("PCA9685", p.lastError || "sem resposta");
            } catch (e6) { A.error("PCA9685", String(e6 && e6.message ? e6.message : e6)); }
        }),
        A.form.info("Estado", pcaReady ? "pronto" : (pca ? (pca.lastError || "parado") : "nao iniciado")),
        A.form.stepper("Canal", function () { return pcaCh; },
                        function (v) { pcaCh = v; },
                        { min: 0, max: 15, step: 1 }),
        A.form.stepper("Angulo", function () { return pcaAngle; },
                        function (v) { pcaAngle = v; },
                        { min: 0, max: 180, step: 5, fmt: function (v) { return v + "°"; } }),
        A.form.action("Servo no canal", function () {
            if (!pcaReady) { A.error("PCA9685", "Inicie o PCA primeiro"); return; }
            if (!pca.setServo(pcaCh, pcaAngle)) A.error("PCA9685", pca.lastError || "NACK");
        }),
        A.form.action("Sleep", function () { if (pca) pca.sleep(); pcaReady = false; }),
        A.form.action("Wake", function () { if (pca && pca.wake()) pcaReady = true; }),
        A.form.action("Tudo off", function () { if (pca) pca.allOff(); })
    ];
    return rows;
}

function telaI2c(c) {
    if (A.header("I2C / PCA9685")) return A.BACK;
    if (!I2C) {
        card([["System.i2c indisponivel", T.err],
              ["precisa de API 54 e CELEROS_JS_I2C", T.textDim],
              ["recompile o firmware ou use outra placa", T.textDim]]);
        return undefined;
    }
    var bus = "fechado";
    if (pcaReady) bus = "PCA pronto";
    else if (pca) bus = "PCA parado";
    card([["SDA " + i2cSda + " · SCL " + i2cScl, T.text],
          [I2C_HZ_LABELS[i2cHzIdx] + " · " + bus, T.textDim],
          ["V+ dos servos em 5 V externo, GND comum", T.textDim]]);
    var rows = i2cRows();
    var i = A.list.view("hw:i2c", LX, 116, LW, BOTTOM - 116, rows,
                        { row: 38, paintRow: paintRow });
    if (i >= 0) tapRow(i, rows);
    return undefined;
}

// ---- boot -----------------------------------------------------------------
if (!G) {
    A.error("GPIO indisponivel", "Este aparelho nao libera GPIO (permissao gpio).");
    System.exitApp();
}

HW.start(10);   // UM timer para servos/motores/LEDs/botoes

A.run({
    main: telaMain,
    servo: telaServo,
    motor: telaMotor,
    led: telaLed,
    button: telaButton,
    i2c: telaI2c
}, "main", { fps: 30 });
