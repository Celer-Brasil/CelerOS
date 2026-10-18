// CelerOS LED Controller — controla um LED/fita por GPIO direto.
// Migrado para o CelerKit: o core celeros.app fica com o laco (A.run) e o
// tema; celeros.app.form traz o pedido validado do numero do pino (digitado
// no teclado do OS, sem caminhar de 2 a 48 no toque). Pino escolhivel,
// liga/desliga, brilho PWM (analogWrite) e modo piscar. Requer permissao
// gpio no app.json. ES5 (Duktape).

var A = require("celeros.app");
require("celeros.app.form");
A.init();

var G = (typeof System.gpio === "object" && System.gpio) ? System.gpio : null;

var PIN_MIN = 2, PIN_MAX = 48;
var pin = 2;                    // LED onboard classico do ESP32
var on = false;
var duty = 100;                 // 0..100 (PWM quando < 100)
var mode = 0;                   // 0 fixo | 1 pisca lento | 2 pisca rapido
var MODES = [["Fixo", 0], ["Pisca", 700], ["Rápido", 220]];
var MODE_LABELS = ["Fixo", "Pisca", "Rápido"];

function apply(level) {         // level 0..100 no pino
    if (level <= 0) {
        G.digitalWrite(pin, G.LOW);
    } else if (level >= 100) {
        G.digitalWrite(pin, G.HIGH);
    } else if (G.analogWrite) {
        G.analogWrite(pin, Math.round(level * 255 / 100));
    } else {
        G.digitalWrite(pin, G.HIGH);
    }
}

function setupPin() {
    G.pinMode(pin, G.OUTPUT);
    apply(on ? duty : 0);
}

// troca de pino: o anterior nao pode ficar preso no ultimo nivel aplicado
function selectPin(p) {
    p = p | 0;
    if (p === pin || p < PIN_MIN || p > PIN_MAX) return;
    try { G.digitalWrite(pin, G.LOW); } catch (eold) {}
    pin = p;
    setupPin();
}

var blinkOn = true;
var lastBlink = 0;

A.run({
    main: function (c) {
        var T = A.T;
        if (c.entered && !G) {
            // sem gpio (permissao negada ou binding ausente): avisa e sai
            A.error("GPIO indisponível", "O aparelho não liberou o uso de GPIO para este app.");
            return A.EXIT;
        }
        if (c.entered) { setupPin(); lastBlink = System.millis(); }

        // seletor de pino (- / digitar / +)
        UI.card(A.L.x, 8, A.L.w, 48);
        if (UI.button("-", A.L.x + 8, 16, 40, 32,
                      { style: "ghost", role: "title", disabled: pin <= PIN_MIN })) selectPin(pin - 1);
        if (UI.button("GPIO " + pin, A.L.x + 48, 16, A.L.w - 96, 32,
                      { style: "ghost", role: "title", color: T.card })) {
            var p = A.form.askNum("Pino GPIO", { min: PIN_MIN, max: PIN_MAX, hint: "número do pino (2 a 48)" });
            if (p !== null) selectPin(p);
        }
        if (UI.button("+", A.L.x + A.L.w - 48, 16, 40, 32,
                      { style: "ghost", role: "title", disabled: pin >= PIN_MAX })) selectPin(pin + 1);
        UI.cardEnd();

        // botao grande liga/desliga
        if (UI.button(on ? "LIGADO" : "DESLIGADO", A.L.x + 16, 68, A.L.w - 32, 92,
                      { color: on ? T.ok : T.raised, textColor: on ? T.onAccent : T.textDim, role: "title" })) {
            on = !on;
            apply(on ? duty : 0);
        }

        // brilho (PWM): aplica ao vivo no modo fixo
        UI.card(A.L.x, 172, A.L.w, 74);
        UI.text("Brilho", A.L.x + 12, 182);
        UI.text(duty + "%", A.L.x + A.L.w - 12, 182, { align: "right", color: T.accent });
        var d = UI.slider(A.L.x + 16, 208, A.L.w - 32, duty);
        if (d !== duty) {
            duty = d;
            if (on && mode === 0) apply(duty);
        }
        UI.cardEnd();

        // modo
        var m = UI.tabs(A.L.x, 256, A.L.w, 32, MODE_LABELS, mode);
        if (m !== mode) {
            mode = m;
            if (mode === 0) apply(on ? duty : 0);
        }
        UI.text("confira o pino antes de ligar", A.L.cx, 300, { role: "caption", align: "center", color: T.textDim });

        // modo piscar: alterna o nivel no ritmo do modo
        if (on && mode > 0 && System.millis() - lastBlink >= MODES[mode][1]) {
            lastBlink = System.millis();
            blinkOn = !blinkOn;
            apply(blinkOn ? duty : 0);
        }
    }
}, "main", { fps: 30 });
