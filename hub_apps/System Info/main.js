// CelerOS System Info — painel do aparelho no tema do OS, sobre o CelerKit
// (deps celeros.app.*): as capacidades da placa vem de uma sonda unica
// cacheada (celeros.app.caps) e a formatacao de bytes/uptime segue o mesmo
// formato dos apps do sistema (celeros.app.fmt). Cards de dispositivo,
// memoria, flash/armazenamento, rede e energia; uptime e RAM ao vivo (A.every,
// 1 s). ES5 (Duktape), toolkit UI: UI.text redesenha so o valor que mudou.

var A = require("celeros.app");
require("celeros.app.caps");      // sonda unica da placa (board, api, psram...)
require("celeros.app.fmt");       // bytes/uptime no formato do sistema

A.init();
var T = A.T;
var LX = A.L.x, LW = A.L.w;
var cap = A.caps.probe();         // estatico: placa nao muda em execucao

function card(y, h, titulo) {
    UI.card(LX, y, LW, h);
    UI.text(titulo, LX + 10, y + 6, { role: "caption", color: T.accent });
    return y + 24;              // y da primeira linha de dados
}
function row(y, label, value, col) {
    UI.text(label, LX + 10, y, { role: "caption", color: T.textDim });
    UI.text(String(value), LX + LW - 10, y, { role: "caption", color: col || T.text, align: "right", w: 140 });
}

var i = System.getInfo();
var hasSensors = typeof Sensors !== "undefined" && !!Sensors.accel;
var livreLocal = 0;             // /local livre: consulta barata de mais para
try { livreLocal = FS.getFreeSpace("/local"); } catch (e) { livreLocal = 0; }

function telaPainel(c) {
    if (A.every(1000)) i = System.getInfo();          // valores ao vivo
    if (A.every(5000, "fs")) {
        try { livreLocal = FS.getFreeSpace("/local"); } catch (e) { /* mantem */ }
    }

    // dispositivo
    var y = card(6, 84, "Dispositivo");
    row(y, "placa", cap.board || "?");
    row(y + 14, "chip", i.chipModel + " r" + i.chipRevision);
    row(y + 28, "CPU", i.chipCores + "x " + i.cpuFreqMHz + " MHz");
    row(y + 42, "firmware", "CelerOS " + System.getOSVersion() + " · API " + cap.api);
    UI.cardEnd();

    // memoria: barra de uso da RAM interna
    y = card(96, 80, "Memória");
    var used = i.totalRAM ? Math.round((i.totalRAM - i.freeRAM) * 100 / i.totalRAM) : 0;
    row(y, "RAM livre", A.fmt.bytes(i.freeRAM) + " de " + A.fmt.bytes(i.totalRAM), i.freeRAM < 20000 ? T.warn : T.text);
    UI.progress(LX + 10, y + 16, LW - 20, 8, used);
    row(y + 28, "maior bloco", A.fmt.bytes(i.maxAllocRAM));
    row(y + 42, "PSRAM", i.totalPSRAM ? A.fmt.bytes(i.freePSRAM) + " de " + A.fmt.bytes(i.totalPSRAM) : "não");
    UI.cardEnd();

    // armazenamento
    y = card(182, 52, "Armazenamento");
    row(y, "flash", A.fmt.bytes(i.flashSize));
    row(y + 14, "/local livre", A.fmt.bytes(livreLocal));
    UI.cardEnd();

    // rede + energia
    y = card(240, 52, "Rede e energia");
    var w = System.wifiStatus();
    row(y, "Wi-Fi", w.connected ? System.getIPAddress() : "desligado", w.connected ? T.ok : T.warn);
    var energia = "--";
    if (typeof System.battery === "function") {
        var mv = System.battery();
        energia = mv >= 0 ? (mv / 1000).toFixed(2) + " V" : "sem sensor";
    }
    row(y + 14, "bateria", energia);
    UI.cardEnd();

    // rodape: sensores (watch, API 13) ou uptime ao vivo
    if (hasSensors) {
        var a = Sensors.accel();
        UI.text("acel " + (a ? a.x.toFixed(1) + ", " + a.y.toFixed(1) + ", " + a.z.toFixed(1) : "--") +
                "  ·  passos " + (Sensors.steps ? Sensors.steps() : "--"), 120, 296,
                { role: "caption", align: "center", color: T.textDim });
    } else {
        UI.text("ligado há " + A.fmt.uptime(i.uptimeMs), 120, 296, { role: "caption", align: "center", color: T.textDim });
    }
}

A.run({ painel: telaPainel }, "painel", { fps: 10 });
