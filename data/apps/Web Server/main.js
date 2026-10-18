// CelerOS Web Server — app de sistema (W8). Liga/desliga o servidor web e
// mostra o IP de acesso (porta 80). Migrado para o CelerKit (deps
// celeros.app.*): A.run e dono do frame, o polling do status virou
// A.every(1000) e o armazenamento usa A.fmt.bytes (o mesmo formato de
// bytes do resto do sistema). Toggle ao vivo via System.webSetActive (sem
// reboot). X do topbar sai.

var A = require("celeros.app");
require("celeros.app.fmt");

A.init();

var LX = 8, LW = 224;
var st = System.wifiStatus();

A.run({
    main: function (c) {
        // IP e estado podem chegar async: relidos a cada segundo; UI.text
        // redesenha so o que mudou
        if (A.every(1000, "wifi")) {
            var ns = System.wifiStatus();
            if (ns.connected !== st.connected || ns.webServer !== st.webServer) UI.invalidate();
            st = ns;
        }
        var T = A.T;
        UI.card(LX, 8, LW, 56);
        UI.text("Servidor web", LX + 12, 18);
        var on = !!st.webServer;
        if (UI.toggle(LX + LW - 56, 24, on) !== on) {
            A.busy("Aplicando...");      // UM frame antes da chamada que trava
            System.webSetActive(!on);
            st = System.wifiStatus();
            UI.invalidate();
        }
        UI.text(on ? "rodando na porta 80" : "desligado", LX + 12, 42,
                { role: "caption", color: on ? T.ok : T.textDim });
        UI.cardEnd();

        if (!st.connected) {
            UI.card(LX, 74, LW, 96);
            UI.text("Wi-Fi desconectado", 120, 90, { role: "title", align: "center", color: T.warn });
            UI.text("Conecte o Wi-Fi para usar o gerenciador web.", 120, 124,
                    { role: "caption", align: "center", color: T.textDim, w: LW - 24, lines: 2 });
            UI.cardEnd();
        } else if (!on) {
            UI.card(LX, 74, LW, 96);
            UI.text("Servidor desligado", 120, 90, { role: "title", align: "center", color: T.warn });
            UI.text("Ligue para acessar arquivos e OTA pelo navegador.", 120, 124,
                    { role: "caption", align: "center", color: T.textDim, w: LW - 24, lines: 2 });
            UI.cardEnd();
        } else {
            var auth = System.webAuthInfo();
            UI.card(LX, 74, LW, 112);
            UI.text("Abra no navegador", LX + 12, 84, { role: "caption", color: T.textDim });
            UI.text("http://" + st.ip, LX + 12, 104, { role: "title", color: T.accent, w: LW - 24 });
            UI.text("login", LX + 12, 140, { role: "caption", color: T.textDim });
            UI.text(auth.user, LX + LW - 12, 140, { role: "caption", align: "right" });
            UI.text("senha", LX + 12, 160, { role: "caption", color: T.textDim });
            UI.text(auth.pass, LX + LW - 12, 160, { role: "caption", align: "right" });
            UI.cardEnd();

            // armazenamento (onde os uploads e backups vao parar)
            UI.card(LX, 196, LW, 84);
            UI.text("Armazenamento", LX + 12, 206, { role: "caption", color: T.textDim });
            var loc = FS.getFreeSpace("/local"), tot = FS.getTotalSpace("/local");
            UI.text("Interno", LX + 12, 228, { role: "caption" });
            UI.text((A.fmt.bytes(loc) || "0 B") + " livres de " + A.fmt.bytes(tot), LX + LW - 12, 228,
                    { role: "caption", align: "right" });
            UI.progress(LX + 12, 246, LW - 24, 8, tot ? Math.round((tot - loc) * 100 / tot) : 0);
            var sd = FS.getTotalSpace("/sd");
            UI.text("Cartão SD", LX + 12, 260, { role: "caption" });
            UI.text(sd ? (A.fmt.bytes(FS.getFreeSpace("/sd")) || "0 B") + " livres" : "sem cartão", LX + LW - 12, 260,
                    { role: "caption", align: "right", color: sd ? T.text : T.textDim });
            UI.cardEnd();
            UI.text("Acesso protegido: arquivos e OTA.", 120, 292, { role: "caption", align: "center", color: T.textDim });
        }
    }
}, "main", { fps: 10 });
