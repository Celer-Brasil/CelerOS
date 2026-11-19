// CelerOS System Info — painel do aparelho no CelerKit UI 2.0 (deps
// celeros.app.*): aneis ao vivo de RAM, PSRAM/flash e bateria (System.fillArc
// + assinatura, sem repintar o que nao mudou), cards adaptativos com tokens
// do tema e as capacidades da placa pela sonda unica do celeros.app.caps.
// Bytes/uptime saem no formato do sistema (celeros.app.fmt). Tudo degrada:
// placa sem PSRAM/bateria/sensores mostra o que tem, nunca estoura.
// ES5 (Duktape). 240x320 virtuais; layout pelo A.layout (o watch redondo encolhe).

var A = require("celeros.app");
require("celeros.app.caps");      // sonda unica da placa (board, psram, battery...)
require("celeros.app.fmt");       // bytes/uptime no formato do sistema
require("celeros.app.style");     // tokens + cards (sombra/gradiente no frame cheio)

require("celeros.app.layout");
A.init();
var T = A.style.T;
A.style.preset("soft");
var cap = A.caps.probe();
var area = A.layout.bounds({ top: 40 });
var captionH = UI.lineHeight("caption");
var gauges = [], panels = [];
var gaugeH = Math.min(90, Math.floor(area.h / 3));
var gaugeArea = { x: area.x, y: area.y, w: area.w, h: gaugeH };
var detail = { x: area.x, y: area.y + gaugeH + 4, w: area.w, h: area.h - gaugeH - 4 };
var wide = A.layout.columns(detail, 200, 4) >= 2;
for (var n = 0; n < 3; n++) gauges.push(A.layout.cell(gaugeArea, 3, 1, n, 3));
// Quatro grupos: hardware, armazenamento, rede/energia e sensores.
for (var k = 0; k < 4; k++) panels.push(A.layout.cell(detail, wide ? 2 : 1, wide ? 2 : 4, k, 3));

var i = System.getInfo() || {};
var livre = 0;
try { livre = FS.getFreeSpace("/local") || 0; } catch (e) { livre = 0; }
var luz = -1, tempC = null, accel = null;

var HAS_TEMP = typeof System.getTemperature === "function";
var HAS_LIGHT = typeof System.lightLevel === "function";
var HAS_ACCEL = typeof Sensors !== "undefined" && Sensors && typeof Sensors.accel === "function";
var HAS_BATT = typeof System.batteryInfo === "function";
var HAS_BATT_MV = typeof System.battery === "function";

var sigs = {};                    // assinatura de cada area pintada (anel)
var FULL = false;                 // frame total desta tela (c.full)

function pct(a, b) {
    if (!b || b <= 0) return 0;
    var f = a / b;
    return f < 0 ? 0 : (f > 1 ? 1 : f);
}
function cor(f) {
    if (f >= 0.95) return T.err;
    if (f >= 0.8) return T.warn;
    return T.accent;
}

// anel: repinta so quando a assinatura muda (ou frame total). O texto do
// centro muda junto com a fracao, entao o slot nao fica por baixo do arco.
function anel(id, box, frac, color, txt, cap2, slot) {
    var r = Math.floor(Math.min(box.w - 8, box.h - captionH - 10) / 2);
    var cx = box.x + Math.floor(box.w / 2), cy = box.y + Math.floor((box.h - captionH - 3) / 2);
    var sig = txt + "|" + color + "|" + Math.round(frac * 200) + "|" + cap2;
    if (!FULL && sigs[id] === sig) return;
    sigs[id] = sig;
    System.fillArc(cx, cy, r - 6, r, 0, 360, T.raised);
    if (frac > 0.01) System.fillArc(cx, cy, r - 6, r, -90, -90 + 360 * frac, color);
    UI.text(String(txt), cx, cy - UI.lineHeight("caption") / 2,
            { align: "center", role: "caption", color: T.text, w: 2 * r - 12, id: slot });
    UI.text(String(cap2), cx, cy + r + 2, { align: "center", role: "caption", w: box.w, color: T.textDim });
}

function panel(box, title, value, sub, color, subColor) {
    UI.card(box.x, box.y, box.w, box.h, { color: T.card, radius: 8 });
    var x = box.x + 7, w = box.w - 14;
    if (wide) {
        var role = UI.measure(value, "body") <= w ? "body" : "caption";
        var vh = UI.measureWrap(value, w, role);
        var sh = UI.measureWrap(sub, w, "caption");
        var y = box.y + (box.h - captionH - sh - vh - 6) / 2;
        UI.text(title, x, y, { role: "caption", color: T.textDim, w: w });
        UI.text(value, x, y + captionH + 3, { role: role, color: color, w: w, lines: 2 });
        UI.text(sub, x, y + captionH + vh + 6, { role: "caption", color: subColor || T.textDim, w: w, lines: 2 });
    } else {
        var top = box.y + (box.h - 2 * captionH - 2) / 2;
        var tw = UI.measure(title, "caption") + 4;
        UI.text(title, x, top, { role: "caption", color: T.textDim, w: tw });
        UI.text(value, x + w, top, { role: "caption", align: "right", color: color, w: w - tw });
        UI.text(sub, x, top + captionH + 2, { role: "caption", color: subColor || T.text, w: w });
    }
    UI.cardEnd();
}

function tela(c) {
    FULL = c.full;
    if (c.entered) { sigs = {}; UI.invalidate(); }
    if (A.every(1000, "info")) {
        i = System.getInfo() || i;
        if (HAS_LIGHT) { try { luz = System.lightLevel(); } catch (e1) { luz = -1; } }
        if (HAS_TEMP) { try { tempC = System.getTemperature(); } catch (e2) { tempC = null; } }
        if (HAS_ACCEL) { try { accel = Sensors.accel(); } catch (e3) { accel = null; } }
    }
    if (A.every(5000, "fs")) {
        try { livre = FS.getFreeSpace("/local") || 0; } catch (e4) { /* mantem */ }
    }

    if (A.header("Sistema", { sub: cap.board || "CelerOS" })) return A.BACK;

    // --- aneis: RAM, PSRAM (ou flash livre) e bateria (ou rede) -----------
    var temPsram = (i.totalPSRAM || 0) > 0;
    var ramF = pct((i.totalRAM || 0) - (i.freeRAM || 0), i.totalRAM);
    anel("ram", gauges[0], ramF, cor(ramF), Math.round(ramF * 100) + "%", "RAM", 1);

    if (temPsram) {
        var psF = pct((i.totalPSRAM || 0) - (i.freePSRAM || 0), i.totalPSRAM);
        anel("ps", gauges[1], psF, cor(psF), Math.round(psF * 100) + "%", "PSRAM", 2);
    } else {
        var flF = pct(livre, i.flashSize);
        anel("fl", gauges[1], flF,
             flF < 0.05 ? T.err : (flF < 0.15 ? T.warn : T.accent),
             Math.round(flF * 100) + "%", "livre", 2);
    }

    if (cap.battery && HAS_BATT) {
        var bi = null;
        try { bi = System.batteryInfo(); } catch (e5) { bi = null; }
        var bF = bi && typeof bi.pct === "number" ? pct(bi.pct, 100) : 0;
        var bTxt = bi && typeof bi.pct === "number" ? bi.pct + "%" : "--";
        anel("bat", gauges[2], bF, bi && bi.pct <= 20 ? T.err : T.ok, bTxt,
             bi && bi.charging ? "carregando" : "bateria", 3);
    } else {
        var w0 = null;
        try { w0 = System.wifiStatus(); } catch (e6) { w0 = null; }
        var on = !!(w0 && w0.connected);
        anel("net", gauges[2], on ? 1 : 0, on ? T.ok : T.textDim, on ? "on" : "off",
             "rede", 3);
    }

    panel(panels[0], "Processador", (i.chipModel || "?") + " r" + (i.chipRevision || 0),
          (i.chipCores || 0) + "x " + (i.cpuFreqMHz || 0) + " MHz", T.text);
    panel(panels[1], "Flash", A.fmt.bytes(i.flashSize) || "?", "/local livre " + A.fmt.bytes(livre), T.text);
    var w = null;
    try { w = System.wifiStatus(); } catch (e7) { w = null; }
    var conn = !!(w && w.connected);
    var mv = (cap.battery && HAS_BATT_MV) ? System.battery() : -1;
    panel(panels[2], "Wi-Fi", conn ? (w.ip || System.getIPAddress() || "conectado") : "desligado",
          mv >= 0 ? (mv / 1000).toFixed(2) + " V" : (cap.battery ? "sem leitura" : "sem bateria"),
          conn ? T.ok : T.warn, mv >= 0 && mv < 3400 ? T.err : null);

    // --- sensores (mostra o que a placa tem) -------------------------------
    var sLinha = "";
    if (HAS_ACCEL && accel) {
        sLinha = "acel " + accel.x.toFixed(1) + ", " + accel.y.toFixed(1) + ", " + accel.z.toFixed(1);
    } else if (luz >= 0) {
        sLinha = "luz " + luz + "%";
    } else if (tempC !== null && (!System.hasTemperatureSensor || System.hasTemperatureSensor())) {
        sLinha = "chip " + tempC.toFixed(1) + " C";
    } else {
        sLinha = "sem sensores";
    }
    panel(panels[3], "Sensores", sLinha, "Ligado há " + A.fmt.uptime(i.uptimeMs || 0), T.text);
}

A.run({ main: tela }, "main", { fps: 8 });
