// CelerOS LED Controller — LED/fita por GPIO com o CelerKit UI 2.0.
// Controles adaptativos de pino, brilho e modo, com preview ao vivo.
// O valor do pino abre o teclado validado do A.form. ES5 (Duktape).

var A = require("celeros.app");
require("celeros.app.form");      // rows + pedido validado do pino
require("celeros.app.layout");
A.init();

var T = A.T || System.theme();
var area = A.layout.bounds({ top: 40 });
var wide = A.layout.columns(area, 200, 6) >= 2;
var capH = UI.lineHeight("caption"), bodyH = UI.lineHeight("body");
var previewH = Math.max(66, bodyH + 3 * capH + 16);
var controls = { x: area.x, y: area.y + previewH + 5, w: area.w, h: area.h - previewH - 5 };
var cells = [];
for (var n = 0; n < 4; n++) cells.push(A.layout.cell(controls, wide ? 2 : 1, wide ? 2 : 4, n, 4));

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
    var radius = Math.min(24, Math.floor((previewH - 18) / 2)), cx = area.x + radius + 10;
    var cy = area.y + Math.floor(previewH / 2);
    UI.card(area.x, area.y, area.w, previewH, { color: T.card, radius: 12 });
    if (c.full || sig !== pvSig) {
        pvSig = sig;
        var col = lit ? System.mixColor(T.card, T.accent, duty) : T.raised;
        System.fillSmoothCircle(cx, cy, radius, col);
        System.drawCircle(cx, cy, radius, lit ? T.accent : T.stroke);
    }
    var x = cx + radius + 10, w = area.x + area.w - x - 6;
    var detail = "GPIO " + pin + " · " + MODE_LABELS[mode] + " · " + duty + "%";
    var detailH = UI.measureWrap(detail, w, "caption");
    var y = cy - Math.floor((bodyH + detailH + (HAS_LED ? 0 : capH + 2) + 3) / 2);
    UI.text(on ? "Ligado" : "Desligado", x, y, { role: "body", color: on ? T.ok : T.textDim, w: w });
    UI.text(detail, x, y + bodyH + 3,
            { role: "caption", color: T.text, w: w, lines: 2 });
    if (!HAS_LED) UI.text("Use um LED externo", x, y + bodyH + detailH + 5,
                          { role: "caption", color: T.textDim, w: w });
    UI.cardEnd();
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

function control(row, box) {
    var x = box.x + 4, w = box.w - 8;
    var y = box.y + 4, h = box.h - 8;
    UI.card(box.x, box.y, box.w, box.h, { color: T.card, radius: 8 });
    var value = row.get();
    if (wide) {
        UI.text(row.label, x + 3, y, { role: "caption", color: T.textDim, w: w - 6 });
        y += capH + 4;
        h -= capH + 4;
    }
    if (row.k === "stepper") {
        var bw = wide ? Math.floor((w - 34) / 2) : 27;
        if (wide && h > 40) { y += Math.floor((h - 40) / 2); h = 40; }
        if (UI.button("-", x + w - 2 * bw - 34, y, bw, h, { style: "ghost" }))
            row.set(Math.max(row.min, value - row.step));
        if (UI.button("+", x + w - bw, y, bw, h, { style: "ghost" }))
            row.set(Math.min(row.max, value + row.step));
        var shown = row.fmt ? row.fmt(value) : String(value);
        var midX = x + w - bw - 34;
        if (row === rows[0]) {
            // Tocar no valor abre o teclado para digitar o pino diretamente.
            if (UI.button(shown, midX, y, 34, h, { style: "ghost", role: "caption" })) askPin();
        } else {
            UI.text(shown, midX + 17, y + (h - capH) / 2, { align: "center", role: "caption", w: 34 });
        }
        if (!wide) {
            var labelW = midX - bw - x - 4;
            if (row === rows[0]) {
                if (UI.button(row.label, x, y, labelW, h, { style: "ghost", role: "caption" })) askPin();
            } else UI.text(row.label, x + 3, y + (h - capH) / 2, { role: "caption", w: labelW });
        }
    } else if (row.k === "choice") {
        if (UI.button(wide ? MODE_LABELS[value] : "Modo · " + MODE_LABELS[value], x, y, w, h,
                      { style: "ghost" })) row.set((value + 1) % MODE_LABELS.length);
    } else {
        if (!wide) UI.text(row.label, x + 3, y + (h - bodyH) / 2, { role: "body", w: w - 60 });
        var next = UI.toggle(wide ? x + (w - 44) / 2 : x + w - 48, y + (h - 24) / 2, value);
        if (next !== value) row.set(next);
    }
    UI.cardEnd();
}

function askPin() {
    var p = A.form.askNum("Pino GPIO", { min: PIN_MIN, max: PIN_MAX, initial: pin, hint: "pino (2 a 48)", int: 1 });
    if (p !== null) selectPin(p);
}

function tela(c) {
    if (c.entered) { setupPin(); lastBlink = System.millis(); pvSig = ""; }
    if (A.header("LED")) return A.BACK;
    preview(c);
    for (var i = 0; i < rows.length; i++) control(rows[i], cells[i]);

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
