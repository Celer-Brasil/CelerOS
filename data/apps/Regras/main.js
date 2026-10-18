/* Regras: reflexos da matilha (API 42). O servico (service.js) roda fora
 * do vidro; aqui o dono ve as regras. Migrada para o CelerKit (dep
 * celeros.app): laco no A.run com header de voltar e leitura do rules.json
 * a cada 2 s (era lido e parseado em TODO frame). O servico segue sem o
 * celeros.app.svc de proposito: regra tem que disparar com app aberto (os
 * gates do kit dormiriam o servico em foreground) e o notificar repete por
 * envelope (nao e notify-once). */
var A = require("celeros.app");
var DATA = "/local/data/celeros.regras/rules.json";

var linhas = [];      // "quando" das regras (cache revalidado a cada 2 s)
var quebrado = false; // rules.json com JSON invalido

function carregar() {
    linhas = [];
    quebrado = false;
    var txt = FS.readTextFile(DATA);
    if (!txt) return;
    try {
        var list = JSON.parse(txt).regras;
        for (var i = 0; i < (list ? list.length : 0) && i < 6; i++) linhas.push(list[i].quando);
    } catch (e) {
        quebrado = true;
    }
}

A.run({
    main: function (c) {
        if (A.header("Regras", { sub: "reflexos da matilha" })) return A.BACK;
        if (c.entered || A.every(2000, "regras")) carregar();
        if (quebrado) {
            UI.text("rules.json quebrado", A.L.x, 50, { color: A.T.err });
        } else if (!linhas.length) {
            UI.text("(nenhuma regra; instale o rules.json)", A.L.x, 50, { color: A.T.textDim });
        } else {
            for (var i = 0; i < linhas.length; i++)
                UI.text("- " + linhas[i], A.L.x, 50 + i * 20, { color: A.T.text });
        }
        UI.text("o serviço executa sem esta tela aberta", A.L.x, 210,
                { role: "caption", color: A.T.textDim });
    }
}, "main", { fps: 10 });   // tela estatica: 10 fps
