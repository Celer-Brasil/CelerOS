/* Nucleo: servicos do OS em segundo plano (API 42). O trabalho roda no
 * service.js FORA do vidro; esta tela so mostra o que esta no ar. */
var T = { text: "#ffffff", dim: "#8a8a8a", bg: "#101418" };
var LX = 12;

function start() {
    while (true) {
        if (UI.begin(T.bg)) {
            UI.header("Nucleo", { sub: "servicos do OS" });
            UI.text("atualizacao", LX, 46, { role: "caption", color: T.dim });
            var wifi = System.wifiStatus();
            UI.text(wifi.connected ? "politica ativa (24h)" : "sem wifi",
                    LX, 64, { color: T.text });
            UI.text("ultima notificada: " + (Storage.get("noted_ver", "") || "-"),
                    LX, 82, { role: "caption", color: T.dim });
            UI.text("relogio", LX, 116, { role: "caption", color: T.dim });
            UI.text(System.timeValid() ? "hora valida (SNTP + epoch)"
                                       : "hora invalida (tentando)",
                    LX, 134, { color: T.text });
            UI.text("os servicos rodam sem esta tela aberta (API 42)",
                    LX, 172, { role: "caption", color: T.dim });
            if (UI.button("Fechar", 60, 260, 120, 32, {})) System.exitApp();
        }
        UI.end(10);   // tela estatica: 10 fps (o 120 era clampado a 60)
    }
}
start();
