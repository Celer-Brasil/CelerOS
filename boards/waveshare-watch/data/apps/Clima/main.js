// Clima — tempo atual vindo do celular (Phone Link/Gadgetbridge) no CelerKit.
// ES5 puro (Duktape). O Gadgetbridge repassa o clima de um provedor (ex.:
// Breezy Weather); o firmware guarda a ultima leitura entre reboots.
// O loop, o header e o polling vem do core (A.run/A.every); o texto que
// chega do celular passa pelo celeros.app.text (fora do Latin-1 some — as
// fontes nao tem o glifo).

var A = require("celeros.app");
require("celeros.app.text");
A.init();

var HAS = typeof Phone !== "undefined" && Phone && typeof Phone.weather === "function";

// texto centrado no vidro (app de cartao unico: primitiva crua dentro do if full)
function ctext(s, y, f, col) {
    System.setTextColor(col);
    System.drawString(s, Math.round((240 - System.textWidth(s, f)) / 2), y, f);
}
// "agora", "ha 12 min", "ha 3 h", "ha 2 dias"
function ago(s) {
    if (s < 90) return "agora";
    if (s < 3600) return "há " + Math.round(s / 60) + " min";
    if (s < 172800) return "há " + Math.round(s / 3600) + " h";
    return "há " + Math.round(s / 86400) + " dias";
}

var w = HAS ? Phone.weather() : null;
var last = "";

function draw() {
    if (!HAS) { ctext("Sem Phone Link nesta placa", 150, 2, A.T.warn); return; }
    if (!w) {
        ctext("Sem dados ainda", 130, 2, A.T.textDim);
        ctext("Gadgetbridge > clima", 156, 1, A.T.textDim);
        return;
    }
    ctext(A.text.fit(w.loc || ""), 56, 2, A.T.textDim);
    ctext(Math.round(w.temp) + "°C", 100, 4, w.temp >= 30 ? A.T.warn : A.T.text);
    ctext(A.text.fit(w.txt || ""), 160, 2, A.T.accent);
    if (w.hum >= 0) ctext("umidade " + w.hum + "%", 194, 1, A.T.textDim);
    ctext("atualizado " + ago(w.age), 274, 1, w.age > 10800 ? A.T.warn : A.T.stroke);
}

A.run({
    main: function (c) {
        if (A.header("Clima")) return A.BACK;
        // o clima muda quando o celular manda; a idade muda so de minuto em minuto
        if (A.every(500)) {
            w = HAS ? Phone.weather() : null;
            var sig = w ? [Math.round(w.temp), w.txt, w.hum, w.loc, Math.floor(w.age / 60)].join("|") : "-";
            if (sig !== last) { last = sig; UI.invalidate(); }
        }
        if (c.full) draw();
    }
}, "main", { fps: 3 });
