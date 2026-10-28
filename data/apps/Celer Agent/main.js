// Celer Agent - entrada do app (o trabalho vive no service.js, intocado).
//
// Headless: imprime o resumo no logcat a cada 5 s. Com tela: abre o painel
// UI 2.0 (painel.js) - status do heartbeat, caps do aparelho, ultimo comando,
// OTA/atualizacao e diagnostico. Nada aqui desenha no vidro quando UI nao
// existe (devkit/esp32-cam).
//
// 2.0.0: painel em UI kit 2.0 (cabecalho com acoes, cards de status/firmware/
// apps, resumo do aparelho/agente, diagnostico e sheet do otaCheck); o
// service.js segue igual (mesmos exports, mesmas chaves de Storage).

var estado = require("estado");

if (typeof UI === "undefined") {
    while (true) {
        var ls = estado.lines();
        for (var i = 0; i < ls.length; i++) System.print("[agent] " + ls[i]);
        System.delay(5000);
    }
} else {
    require("painel").run();
}
