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
 * Acao desconhecida: ignora; JSON quebrado na carga: propaga e PARA o
 * servico (erro do dono visivel, sem mascara). Nas ACOES, um send/Storage
 * que estoure e contido: uma regra ruim nao pode matar o servico. */
var DATA = "/local/data/celeros.regras/rules.json";
// Pack so existe em placa com Bluetooth: sem ele as regras de "enviar" nao
// tem por onde sair (notificar/guardar seguem valendo)
var TEM_PACK = typeof Pack !== "undefined";
var regras = [];
var servidas = 0;

// System.print NAO existe na superficie do svchost (JsSvc.cpp): chama-lo
// dentro de um catch trocava o RangeError contido por TypeError e o
// callback que falhava PARAVA o servico. Log e melhor esforco.
function log(msg) {
    if (typeof System.print === "function") System.print(msg);
}

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
            if (TEM_PACK) Pack.send(alvo, r.enviar.msg !== undefined ? r.enviar.msg : { eco: r.quando });
        } catch (e) {
            log("regras: enviar falhou (" + r.quando + "): " + e);
        }
    }
    if (r.guardar && r.guardar.chave) {
        try {
            Storage.set(r.guardar.chave, r.guardar.valor !== undefined ? String(r.guardar.valor) : String(envelope));
        } catch (e) {
            log("regras: guardar falhou (" + r.guardar.chave + "): " + e);
        }
    }
}

function tick() {
    var env, n = 0;
    // teto por giro: o svchost tem orcamento de 8 ms/tick e a fila do Pack
    // (ringbuffer) pode vir cheia de uma rajada — drena 16 e o resto no
    // proximo segundo, em vez de segurar o pump dos outros servicos
    while (TEM_PACK && n < 16 && (env = Pack.poll()) !== null) {
        n++;
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
