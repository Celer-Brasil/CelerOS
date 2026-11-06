// Controle BT — servico de fundo (API 61).
//
// O gamepad BLE pareado vira input do OS: Input.pad (canal broadcast — o
// launcher navega por foco, o guide sai do app, apps leem Input.padState) e
// Input.move (ponteiro no stick direito, R2 = clique; em placa com tela o
// ponteiro entra no pipeline de toque como dedo sintetico).
//
// Molde USB HID/devkit-s3: NAO desenha, NAO chama present() — so timers e
// BT/Input. Erro em callback PARA o servico: tudo em try/catch defensivo.
// As chaves "on"/"ptr" no Storage sao relidas a cada ~2 s (o painel liga/
// desliga sem reiniciar o servico).

var G = require("celeros.gamepad");
var drv = require("driver");   // modulo local da pasta (padrao policy.js do Nucleo)

var TICK_MS = 25;
var ligado = true;   // Storage "on" (default 1)
var ptrOn = true;    // Storage "ptr" (default 1)

function relerPrefs() {
    try { ligado = Storage.get("on", "1") === "1"; } catch (e) {}
    try { ptrOn = Storage.get("ptr", "1") === "1"; } catch (e) {}
}
relerPrefs();

var gp = null;              // Gamepad da dep (null = sem pad decodificado)
var cur = { x: 120, y: 160 };
var ticks = 0;
var ultTent = -60000;       // ms logico da ultima tentativa de conexao
var backoff = 15000;

setInterval(function () {
    try {
        ticks++;
        if (ticks % 80 === 0) relerPrefs();  // ~2 s: painel liga/desliga

        if (typeof Input === "undefined") return;  // superficie do svc sem a perm
        if (!ligado) {
            if (gp) {
                gp = null;
                try { Input.clear(); } catch (e2) {}   // pad/ponteiro saem do bus
            }
            return;
        }
        if (typeof BT === "undefined") return;         // build sem BLE HID

        var st = BT.state();
        if (!gp || st.phase !== "ready") {
            gp = null;
            var agora = ticks * TICK_MS;
            if (agora - ultTent < backoff) return;
            ultTent = agora;
            // reconecta pelo bond (tipo de endereco resolve no nativo:
            // cache do scan > ultimo pad > bond). Sem bond, ocioso: o
            // pareamento e pelo app (abaixo) e fica gravado pro proximo boot.
            var bon = BT.paired();
            if (!bon.length) return;
            var r = BT.connect(bon[0].addr);   // bloqueia (renova a janela)
            if (r && r.ok) {
                gp = G.setup();
                backoff = 15000;
            } else {
                backoff = backoff < 60000 ? backoff * 2 : 60000;
            }
            return;
        }
        if (!gp) {
            gp = G.setup();
            if (!gp) return;
        }
        var s = gp.poll();
        if (!s) return;
        Input.pad(drv.toBus(s));
        if (ptrOn) {
            cur = drv.toPointer(s, cur, TICK_MS);
            Input.move(cur.x, cur.y, cur.click);
        }
    } catch (e) {
        // erro de callback para o servico: engole e segue no proximo tick
    }
}, TICK_MS);
