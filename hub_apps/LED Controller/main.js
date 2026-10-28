// CelerOS LED Controller — LED/fita por GPIO com o CelerKit UI 2.0.
// Formulario do A.form (pino, ligado, brilho PWM, modo) numa lista do
// A.list.view com pintor proprio (o A.rows inteiro custa 1.9K e o teto
// deste app e 14K), com preview ao vivo (circulo que acende no brilho e
// pisca no ritmo do modo). Tocar na linha do pino digita o numero validado
// pelo A.form.askNum (sem caminhar de 2 a 48). Placa sem GPIO ou sem LED
// onboard abre e explica, nunca estoura. ES5 (Duktape).

var A = require("celeros.app");
require("celeros.app.form");      // rows + pedido validado do pino
A.init();

var T = A.T || System.theme();
var LX = A.L.x, LW = A.L.w;

var G = (typeof System.gpio === "object" && System.gpio) ? System.gpio : null;
var HAS_LED = false;
try { HAS_LED = !!System.getInfo().hasLed; } catch (e0) { HAS_LED = false; }

var PIN_MIN = 2, PIN_MAX = 48;
var pin = 2;                    // LED onboard classico do ESP32
var on = false;
var duty = 100;                 // 0..100 (PWM quando < 100)
var mode = 0;                   // 0 fixo | 1 pisca lento | 2 pisca rapido
var MODE_LABELS = ["Fixo", "Pisca", "Rápido"];
var MODE_MS = [0, 700, 220];

function apply(level) {         // level 0..100 no pino
    if (!G) return;
    if (level > 0 && level < 100 && G.analogWrite)
        G.analogWrite(pin, Math.round(level * 255 / 100));
    else G.digitalWrite(pin, level > 0 ? G.HIGH : G.LOW);
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

var blinkOn = true, lastBlink = 0, pvSig = "";

// --- preview ao vivo -------------------------------------------------------
// Circulo que acende com o brilho (mistura com o fundo do card) e apaga no
// ritmo do modo piscar. So repinta quando a assinatura muda (ou frame total).
function preview(c) {
    var lit = on && (mode === 0 || blinkOn);
    var f = (lit ? duty : 0) / 100;
    var sig = Math.round(f * 50) + "|" + (lit ? 1 : 0);
    if (c.full || sig !== pvSig) {
        pvSig = sig;
        var col = lit ? System.mixColor(T.accent, T.card, Math.round((1 - f) * 75)) : T.raised;
        System.fillSmoothCircle(64, 88, 30, col);
        System.drawCircle(64, 88, 30, lit ? T.accent : T.stroke);
    }
    UI.text(on ? "LIGADO" : "DESLIGADO", 108, 54,
            { role: "title", color: on ? T.ok : T.textDim, bg: T.card, id: 11 });
    UI.text("GPIO " + pin, 108, 76, { role: "body", color: T.text, bg: T.card, id: 12 });
    UI.text(MODE_LABELS[mode] + " · " + duty + "%", 108, 94,
            { role: "caption", color: T.textDim, w: 118, bg: T.card, id: 13 });
    if (!HAS_LED) {
        UI.text("sem LED onboard (use um externo)", LX + 10, 116,
                { role: "caption", color: T.textDim, w: LW - 20, lines: 1, id: "noled" });
    }
}

// --- formulario (rows do A.form, pintor local) -----------------------------
function buildRows() {
    return [
        A.form.stepper("Pino GPIO", function () { return pin; }, selectPin,
                       { min: PIN_MIN, max: PIN_MAX, step: 1 }),
        A.form.stepper("Brilho PWM", function () { return duty; },
                       function (v) { duty = v; if (on && mode === 0) apply(duty); },
                       { min: 5, max: 100, step: 5, fmt: function (v) { return v + "%"; } }),
        A.form.choice("Modo", function () { return mode; }, function (v) {
            mode = v;
            blinkOn = true;
            if (mode === 0) apply(on ? duty : 0);
            UI.invalidate();
        }, MODE_LABELS),
        A.form.toggle("Ligado", function () { return on; }, function (v) {
            on = v;
            apply(on ? duty : 0);
            UI.invalidate();
        })
    ];
}
var rows = buildRows();

// pintor das linhas do A.form (so os 4 tipos que a tela usa; o A.rows
// completo custaria 1.9K e este app tem teto de 14K)
function formRow(r, x, y, w, h) {
    var lh = UI.lineHeight("body"), cap = UI.lineHeight("caption");
    var kind = r.k, rw = kind === "stepper" ? 92 : kind === "choice" ? 92 : kind === "toggle" ? 50 : 4;
    UI.text(r.label, x, y + ((h - lh) >> 1),
            { role: "body", color: T.text, w: w - rw - 6, lines: 1 });
    if (kind === "toggle") {
        var v = UI.toggle(x + w - 44, y + ((h - 24) >> 1), !!r.get());
        if (v !== r.get()) r.set(v);
    } else if (kind === "stepper") {
        var sv = r.get();
        if (UI.button("-", x + w - 92, y + 2, 26, h - 4, { style: "ghost" }))
            r.set(Math.max(r.min, sv - r.step));
        if (UI.button("+", x + w - 30, y + 2, 26, h - 4, { style: "ghost" }))
            r.set(Math.min(r.max, sv + r.step));
        // 34 px cabe "100%" (4 glifos de 8) e ainda deixa 2 px ate o "+"
        UI.text(r.fmt ? r.fmt(sv) : sv, x + w - 66, y + ((h - lh) >> 1),
                { role: "body", align: "center", color: T.text, w: 34, lines: 1 });
    } else if (kind === "choice") {
        UI.text(String(r.opts[r.get() % r.opts.length]), x + w - 8,
                y + ((h - cap) >> 1), { role: "caption", align: "right",
                color: T.textDim, w: 84, lines: 1 });
    }
}

function tela(c) {
    if (c.entered) { setupPin(); lastBlink = System.millis(); pvSig = ""; }

    UI.header("LED");
    UI.card(LX, 44, LW, 92);
    preview(c);
    UI.cardEnd();

    // tocar na linha do pino (fora dos botoes) digita o numero validado
    var i = A.list.view("led", LX, 142, LW, 168, rows, { row: 40, paintRow: formRow });
    if (i === 0) {
        var p = A.form.askNum("Pino GPIO", { min: PIN_MIN, max: PIN_MAX,
            initial: pin, hint: "pino (2 a 48)", int: 1 });
        if (p !== null) selectPin(p);
    } else if (i === 2) rows[2].set(((mode | 0) + 1) % MODE_LABELS.length);

    // modo piscar: alterna o nivel no ritmo do modo (o preview acompanha)
    if (on && mode > 0 && System.millis() - lastBlink >= MODE_MS[mode]) {
        lastBlink = System.millis();
        blinkOn = !blinkOn;
        apply(blinkOn ? duty : 0);
    }
}

if (!G) {
    A.error("GPIO indisponível", "Este aparelho não libera GPIO.");
    System.exitApp();
}
A.run({ main: tela }, "main", { fps: 30 });
