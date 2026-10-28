// CelerOS System Info — painel do aparelho no CelerKit UI 2.0 (deps
// celeros.app.*): aneis ao vivo de RAM, PSRAM/flash e bateria (System.fillArc
// + assinatura, sem repintar o que nao mudou), cards do A.style com tokens
// do tema e as capacidades da placa pela sonda unica do celeros.app.caps.
// Bytes/uptime saem no formato do sistema (celeros.app.fmt). Tudo degrada:
// placa sem PSRAM/bateria/sensores mostra o que tem, nunca estoura.
// ES5 (Duktape). 240x320 virtuais; layout pelo A.L (o watch redondo encolhe).

var A = require("celeros.app");
require("celeros.app.caps");      // sonda unica da placa (board, psram, battery...)
require("celeros.app.fmt");       // bytes/uptime no formato do sistema
require("celeros.app.style");     // tokens + cards (sombra/gradiente no frame cheio)

A.init();
var T = A.style.T;
A.style.preset("soft");
var L = A.L;
var LX = L.x, LW = L.w, CX = L.cx;
var cap = A.caps.probe();         // estatico: a placa nao muda em execucao
var R1 = LX + 36, R2 = LX + Math.round(LW / 2), R3 = LX + LW - 36;   // aneis

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
function anel(id, cx, cy, r, frac, color, txt, cap2, slot) {
    var sig = txt + "|" + color + "|" + Math.round(frac * 200) + "|" + cap2;
    if (!FULL && sigs[id] === sig) return;
    sigs[id] = sig;
    System.fillArc(cx, cy, r - 6, r, 0, 360, T.raised);
    if (frac > 0.01) System.fillArc(cx, cy, r - 6, r, -90, -90 + 360 * frac, color);
    UI.text(String(txt), cx, cy - 9,
            { align: "center", role: "title", color: T.text, id: slot });
    UI.text(String(cap2), cx, cy + r + 2, { align: "center", role: "caption", color: T.textDim });
}

// linha "rotulo ......... valor" dentro de um card (texto slotizado)
function linha(x, y, w, rot, val, col) {
    UI.text(rot, x, y, { role: "caption", color: T.textDim, w: w * 0.5 });
    UI.text(String(val), x + w, y, { align: "right", role: "caption",
            color: col === undefined ? T.text : col, w: w, id: rot });
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

    UI.header("Sistema", { sub: cap.board || "CelerOS" });

    // --- aneis: RAM, PSRAM (ou flash livre) e bateria (ou rede) -----------
    var temPsram = (i.totalPSRAM || 0) > 0;
    var ramF = pct((i.totalRAM || 0) - (i.freeRAM || 0), i.totalRAM);
    anel("ram", R1, 86, 28, ramF, cor(ramF), Math.round(ramF * 100) + "%", "RAM", 1);

    if (temPsram) {
        var psF = pct((i.totalPSRAM || 0) - (i.freePSRAM || 0), i.totalPSRAM);
        anel("ps", R2, 86, 28, psF, cor(psF), Math.round(psF * 100) + "%", "PSRAM", 2);
    } else {
        var flF = pct(livre, i.flashSize);
        anel("fl", R2, 86, 28, flF,
             flF < 0.05 ? T.err : (flF < 0.15 ? T.warn : T.accent),
             Math.round(flF * 100) + "%", "livre", 2);
    }

    if (cap.battery && HAS_BATT) {
        var bi = null;
        try { bi = System.batteryInfo(); } catch (e5) { bi = null; }
        var bF = bi && typeof bi.pct === "number" ? pct(bi.pct, 100) : 0;
        var bTxt = bi && typeof bi.pct === "number" ? bi.pct + "%" : "--";
        anel("bat", R3, 86, 28, bF, bi && bi.pct <= 20 ? T.err : T.ok, bTxt,
             bi && bi.charging ? "carregando" : "bateria", 3);
    } else {
        var w0 = null;
        try { w0 = System.wifiStatus(); } catch (e6) { w0 = null; }
        var on = !!(w0 && w0.connected);
        anel("net", R3, 86, 28, on ? 1 : 0, on ? T.ok : T.textDim, on ? "on" : "off",
             "rede", 3);
    }

    // --- dispositivo ------------------------------------------------------
    A.style.card(LX, 130, LW, 62, { full: c.full, elev: 1,
        draw: function (r) {
            linha(r.x, r.y, r.w, "chip", (i.chipModel || "?") + " r" + (i.chipRevision || 0));
            linha(r.x, r.y + 18, r.w, "CPU", (i.chipCores || 0) + "x " + (i.cpuFreqMHz || 0) + " MHz");
        }
    });
    UI.text("flash " + (A.fmt.bytes(i.flashSize) || "?") + "  ·  /local livre " +
            (A.fmt.bytes(livre) || "0"), LX + 10, 176, { role: "caption", color: T.textDim,
            bg: T.card, w: LW - 20, id: "fs" });

    // --- rede e energia ---------------------------------------------------
    var w = null;
    try { w = System.wifiStatus(); } catch (e7) { w = null; }
    var conn = !!(w && w.connected);
    var mv = (cap.battery && HAS_BATT_MV) ? System.battery() : -1;
    A.style.card(LX, 192, LW, 62, { full: c.full, elev: 1,
        draw: function (r) {
            linha(r.x, r.y, r.w, "Wi-Fi", conn ? (w.ip && w.ip.length ? w.ip :
                 (System.getIPAddress() || "conectado")) : "desligado", conn ? T.ok : T.warn);
            linha(r.x, r.y + 18, r.w, "energia",
                 mv >= 0 ? (mv / 1000).toFixed(2) + " V" : (cap.battery ? "sem leitura" : "sem bateria"),
                 mv >= 0 && mv < 3400 ? T.err : T.text);
        }
    });

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
    A.style.card(LX, 254, LW, 52, { full: c.full, elev: 1,
        draw: function (r) {
            linha(r.x, r.y, r.w, "sensores", sLinha);
            linha(r.x, r.y + 18, r.w, "ligado ha", A.fmt.uptime(i.uptimeMs || 0));
        }
    });
}

A.run({ main: tela }, "main", { fps: 8 });
