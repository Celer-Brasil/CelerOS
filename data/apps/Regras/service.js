/* Regras — reflexos da matilha (API 42). Servico em segundo plano: drena
 * o Pack.poll() e executa regras "quando envelope X -> entao acao".
 *
 * Regras em /local/data/celeros.regras/rules.json (o install.sh semeia o
 * exemplo):
 *   { "regras": [
 *       { "quando": "porta",       // payload {"rule":"porta"} de qualquer membro
 *         "notificar": "Porta aberta!" },
 *       { "quando": "sirene",
 *         "enviar": { "para": "pc", "msg": {"eco": true} } },
 *       { "quando": "presenca",
 *         "guardar": { "chave": "visto", "valor": "sim" } }
 *   ] }
 * Acao desconhecida ou JSON quebrado: loga e ignora (servico nao morre). */
var DATA = "/local/data/celeros.regras/rules.json";
var regras = [];
var servidas = 0;

function carregar() {
    regras = [];
    var txt = FS.readTextFile(DATA);
    if (!txt) return;
    var parsed = JSON.parse(txt);  // erro de parse: propaga e PARA o servico
    var list = parsed && parsed.regras;
    if (!list || !list.length) return;
    for (var i = 0; i < list.length && i < 16; i++) {
        var r = list[i];
        if (r && typeof r.quando === "string") regras.push(r);
    }
}

function executar(r, envelope) {
    if (r.notificar) {
        System.notify("Regra: " + r.quando, String(r.notificar));
    }
    if (r.enviar && r.enviar.para) {
        var alvo = r.enviar.para === "pc" ? "pc" : r.enviar.para;
        // o JSON e do dono e pode passar do teto (RangeError do send) ou
        // vir chave comprida demais para o Storage: um regra ruim nao pode
        // derrubar o servico inteiro (promessa do cabecalho)
        try {
            Pack.send(alvo, r.enviar.msg !== undefined ? r.enviar.msg : { eco: r.quando });
        } catch (e) {
            System.print("regras: enviar falhou (" + r.quando + "): " + e);
        }
    }
    if (r.guardar && r.guardar.chave) {
        try {
            Storage.set(r.guardar.chave, r.guardar.valor !== undefined ? String(r.guardar.valor) : String(envelope));
        } catch (e) {
            System.print("regras: guardar falhou (" + r.guardar.chave + "): " + e);
        }
    }
}

function tick() {
    var env;
    while ((env = Pack.poll()) !== null) {
        servidas++;
        // Pack.poll() entrega {from, fromName, data} — o dado e "data"
        var msg = env && env.data;
        var nome = "";
        if (msg && typeof msg === "object" && msg.rule) nome = String(msg.rule);
        else if (typeof msg === "string") {
            // tolerante: "porta 12" ou JSON cru no texto
            var t = msg.replace(/^\s*\{.*\}\s*$/, function (m) {
                try { return JSON.parse(m).rule || ""; } catch (e) { return ""; }
            });
            nome = String(t).split(" ")[0];
        }
        if (!nome) continue;
        for (var i = 0; i < regras.length; i++) {
            if (regras[i].quando === nome) executar(regras[i], msg);
        }
    }
}

carregar();
setInterval(tick, 1000);
