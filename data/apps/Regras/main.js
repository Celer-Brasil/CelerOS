/* Regras: reflexos da matilha (API 42). O servico (service.js) roda fora
 * do vidro; aqui o dono ve as regras e o contador. */
var DATA = "/local/data/celeros.regras/rules.json";

function start() {
    while (true) {
        if (UI.begin("#101418")) {
            UI.header("Regras", { sub: "reflexos da matilha" });
            var txt = FS.readTextFile(DATA);
            var n = 0;
            if (txt) {
                try {
                    var list = JSON.parse(txt).regras;
                    for (var i = 0; i < (list ? list.length : 0) && i < 6; i++) {
                        UI.text("- " + list[i].quando, 12, 50 + i * 20, { color: "#ffffff" });
                        n++;
                    }
                } catch (e) {
                    UI.text("rules.json quebrado", 12, 50, { color: "#ff8888" });
                }
            }
            if (n === 0) UI.text("(nenhuma regra; instale o rules.json)", 12, 50, { color: "#8a8a8a" });
            UI.text("o servico executa sem esta tela aberta", 12, 210, { role: "caption", color: "#8a8a8a" });
            if (UI.button("Fechar", 60, 260, 120, 32, {})) System.exitApp();
        }
        UI.end(120);
    }
}
start();
