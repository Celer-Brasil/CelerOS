/* Nucleo: servicos do OS em segundo plano (API 42). O trabalho roda no
 * service.js FORA do vidro; esta tela so mostra o que esta no ar.
 * Migrada para o CelerKit (dep celeros.app): laco no A.run, header com
 * voltar no lugar do botao Fechar, layout e cores do tema do kit. O
 * service.js segue SEM o celeros.app.svc de proposito: os gates dele
 * (wifi/grace/24h) sao proprios (policy.js) e a versao notificada e chave
 * COMPARTILHADA entre esta tela e o servico (estado compartilhado nao
 * migra para as chaves svc.* do kit). */
var A = require("celeros.app");

A.run({
    main: function () {
        if (A.header("Nucleo", { sub: "servicos do OS" })) return A.BACK;
        UI.text("atualização", A.L.x, 46, { role: "caption", color: A.T.textDim });
        var wifi = System.wifiStatus();
        UI.text(wifi.connected ? "política ativa (24h)" : "sem wifi",
                A.L.x, 64, { color: A.T.text });
        UI.text("última notificada: " + (Storage.get("noted_ver", "") || "-"),
                A.L.x, 82, { role: "caption", color: A.T.textDim });
        UI.text("relógio", A.L.x, 116, { role: "caption", color: A.T.textDim });
        UI.text(System.timeValid() ? "hora válida (SNTP + epoch)"
                                   : "hora inválida (tentando)",
                A.L.x, 134, { color: A.T.text });
        UI.text("os serviços rodam sem esta tela aberta (API 42)",
                A.L.x, 172, { role: "caption", color: A.T.textDim });
    }
}, "main", { fps: 10 });   // tela estatica: 10 fps (le Storage e wifiStatus)
