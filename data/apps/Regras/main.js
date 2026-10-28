/* Regras: reflexos da matilha (API 42). O servico (service.js) roda fora
 * do vidro; aqui o dono ve e edita as regras quando/entao sobre envelopes do
 * Pack. 2.0.0 no CelerKit: lista rica do A.list (linhas com a acao resumida)
 * e icones do A.icons, tudo em tokens do tema — o orcamento de 16 KB nao
 * cabe o celeros.app.style, entao os cartoes usam UI.card com as cores do
 * A.T (o mesmo token que o style usaria).
 *
 * rules.json fica em /local/data/celeros.regras/ (o install.sh semeia o
 * exemplo no formato do sh do CelerOS, if/else/end). O editor acrescenta e
 * apaga regras sem tocar nas outras chaves; o SERVICE le o arquivo na carga
 * e nao fica relendo, entao a regra nova vale quando o svchost reiniciar
 * (o toast avisa). O servico em si segue intocado de proposito: regra tem
 * que disparar com app aberto (os gates do celeros.app.svc dormiriam o
 * servico em foreground) e o notificar repete por envelope, nao e
 * notify-once. */
var A = require("celeros.app");
require("celeros.app.list");
A.init();

var T = A.T;
var L = A.L, LX = L.x, LW = L.w;
var DATA = "/local/data/celeros.regras/rules.json";

var regras = [];      // regras do arquivo (max 16 na tela)
var quebrado = false; // rules.json com JSON invalido
var fileTxt = null;   // ultima leitura (muda = reconstroi a lista)
var carimbo = 0;      // stamp do A.list.make
var selIdx = -1;      // regra aberta na tela detalhe
var sairAt = 0;       // 2 toques para apagar

// nova regra (tela "nova")
var gatilho = "", tipo = "", valor = "", chave = "", destino = "";

function acaoDe(r) {
    if (!r) return "sem ação";
    if (r.notificar) return "notificar: " + r.notificar;
    if (r.enviar) return "enviar para " + (r.enviar.para || "?");
    if (r.guardar) return "guardar " + (r.guardar.chave || "?");
    return "sem ação (ignorada)";
}

function carregar() {
    var txt = null;
    try { txt = FS.readTextFile(DATA); } catch (e) { txt = null; }
    if (txt === fileTxt) return;
    fileTxt = txt;
    carimbo++;
    regras = [];
    quebrado = false;
    if (!txt) return;
    try {
        var list = JSON.parse(txt).regras;
        for (var i = 0; i < (list ? list.length : 0) && i < 16; i++) regras.push(list[i]);
    } catch (e2) {
        quebrado = true;
    }
}

// le o arquivo inteiro, aplica fn na lista e grava (preserva outras chaves)
function mexerNoArquivo(fn) {
    var txt = null;
    try { txt = FS.readTextFile(DATA); } catch (e) {
        UI.toast("Sem acesso ao rules.json");
        return false;
    }
    if (!txt) txt = "{\"regras\":[]}";
    var obj;
    try { obj = JSON.parse(txt); } catch (e2) {
        UI.toast("rules.json quebrado: conserte antes");
        return false;
    }
    if (!obj || typeof obj !== "object") obj = { regras: [] };
    if (!obj.regras || !obj.regras.length) obj.regras = [];
    if (!fn(obj.regras)) return false;
    var ok = false;
    try { ok = FS.writeTextFile(DATA, JSON.stringify(obj)); } catch (e3) { ok = false; }
    if (ok === false) {
        UI.toast("Não deu para salvar");
        return false;
    }
    fileTxt = null;
    carregar();
    return true;
}

var lista = A.list.make(
    function () { return carimbo; },
    function () {
        var rows = [];
        for (var i = 0; i < regras.length; i++) {
            var r = regras[i] || {};
            rows.push({ label: "Quando " + (r.quando || "?"),
                        sub: acaoDe(r), right: "editar" });
        }
        if (!rows.length) {
            rows.push({ label: "Nenhuma regra", sub: "toque em Nova regra",
                        disabled: true });
        }
        return rows;
    }
);

// ---- tela 1: lista ---------------------------------------------------------
function telaMain(c) {
    if (A.header("Regras", { sub: "reflexos da matilha" })) return A.BACK;
    if (c.entered || A.every(2000, "regras")) carregar();

    var bad = quebrado;
    UI.card(LX, 44, LW, 58, { color: T.card, radius: 10, stroke: true });
    System.fillCircle(LX + 18, 60, 6,
                      bad ? T.err : (regras.length ? T.ok : T.textDim));
    UI.text(bad ? "rules.json quebrado" : (regras.length ? "Serviço ativo" : "Nenhuma regra ainda"),
            LX + 36, 51, { role: "body", color: bad ? T.err : T.text, bg: T.card,
                           w: LW - 46, lines: 1 });
    UI.text(bad ? "conserte o JSON para o serviço voltar"
                : "quando/então sobre envelopes do Pack · roda em segundo plano",
            LX + 10, 72, { role: "caption", color: T.textDim, bg: T.card,
                           w: LW - 20, lines: 2, id: "sub" });
    UI.cardEnd();

    var rows = lista.rows();
    var i = A.list.view("regras", LX, 108, LW, 144, rows, { row: 32, r: 10 });
    if (i >= 0 && i < regras.length) {
        selIdx = i;
        return "detalhe";
    }

    if (UI.button("Nova regra", LX, 258, LW, 32, { style: "primary" })) {
        gatilho = ""; tipo = ""; valor = ""; chave = ""; destino = "";
        return "nova";
    }
    UI.text("Regra nova vale no próximo boot.",
            LX, L.bottom - 8, { role: "caption", color: T.textDim, w: LW, lines: 1 });
}

// ---- tela 2: detalhe -------------------------------------------------------
function telaDetalhe(c) {
    if (A.header("Regra")) return A.BACK;
    var r = regras[selIdx];
    if (!r) {
        UI.card(LX, 50, LW, 64, { color: T.card, radius: 10 });
        UI.text("Esta regra sumiu do rules.json.", LX + 10, 64,
                { role: "body", color: T.textDim, bg: T.card, w: LW - 20, lines: 2 });
        UI.cardEnd();
        return;
    }
    UI.card(LX, 48, LW, 146, { color: T.card, radius: 10, stroke: true });
    UI.text("QUANDO", LX + 10, 58, { role: "caption", color: T.textDim, bg: T.card, w: LW - 20 });
    UI.text(String(r.quando || "?"), LX + 10, 72,
            { role: "title", color: T.accent, bg: T.card, w: LW - 20, lines: 2 });
    UI.text("ENTÃO", LX + 10, 106, { role: "caption", color: T.textDim, bg: T.card, w: LW - 20 });
    UI.text(acaoDe(r), LX + 10, 122,
            { role: "body", color: T.text, bg: T.card, w: LW - 20, lines: 3 });
    UI.cardEnd();

    var confirma = sairAt > 0 && System.millis() - sairAt < 3000;
    if (UI.button(confirma ? "Toque de novo para apagar" : "Apagar regra",
                  LX, 208, LW, 34, { style: confirma ? "danger" : "ghost" })) {
        if (!confirma) sairAt = System.millis();
        else {
            sairAt = 0;
            if (mexerNoArquivo(function (list) {
                if (selIdx < 0 || selIdx >= list.length) return false;
                list.splice(selIdx, 1);
                return true;
            })) {
                UI.toast("Regra apagada");
                selIdx = -1;
                return A.BACK;
            }
        }
    }
    UI.text("As outras chaves ficam intactas.", LX, L.bottom - 8,
            { role: "caption", color: T.textDim, w: LW, lines: 1 });
}

// ---- tela 3: nova regra ----------------------------------------------------
function escolherValor() {
    if (tipo === "notificar") {
        var m = System.prompt("Mensagem da notificação", "");
        if (m !== "") valor = m;
    } else if (tipo === "guardar") {
        var k = System.prompt("Chave do Storage", "");
        if (k === "") return;
        var v = System.prompt("Valor de " + k, "");
        if (v === "") return;
        chave = k; valor = v;
    } else if (tipo === "enviar") {
        var d = System.prompt("Destino (pc ou nome na malha)", "");
        if (d === "") return;
        var t = System.prompt("Texto para " + d, "");
        if (t === "") return;
        destino = d; valor = t;
    }
}

function salvarNova() {
    if (!gatilho || !tipo) { UI.toast("Escolha o gatilho e a ação"); return false; }
    if (tipo === "guardar" && !chave) { UI.toast("Falta a chave"); return false; }
    if (tipo === "enviar" && !destino) { UI.toast("Falta o destino"); return false; }
    var r = { quando: gatilho };
    if (tipo === "notificar") r.notificar = valor;
    else if (tipo === "guardar") r.guardar = { chave: chave, valor: valor };
    else r.enviar = { para: destino, msg: { texto: valor } };
    var ok = mexerNoArquivo(function (list) {
        if (list.length >= 16) { UI.toast("Máximo de 16 regras"); return false; }
        list.push(r);
        return true;
    });
    if (ok) {
        UI.toast("Regra salva; vale no boot");
        return true;
    }
    return false;
}

function telaNova(c) {
    if (A.header("Nova regra")) return A.BACK;

    UI.card(LX, 46, LW, 184, { color: T.card, radius: 10, stroke: true });
    UI.text("1. GATILHO", LX + 10, 54, { role: "caption", color: T.textDim, bg: T.card, w: 110 });
    UI.text(gatilho ? gatilho : "(o campo rule)", LX + 10, 66,
            { role: "body", color: gatilho ? T.text : T.textDim, bg: T.card,
              w: LW - 90, lines: 1, id: "gat" });
    if (UI.button("Escolher", LX + LW - 82, 56, 70, 26, { style: "ghost", role: "caption" })) {
        var s = System.prompt("Gatilho (ex.: porta)", "");
        if (s !== "") gatilho = s;
    }

    UI.text("2. AÇÃO", LX + 10, 98, { role: "caption", color: T.textDim, bg: T.card, w: 110 });
    var bw = Math.floor((LW - 28) / 3);
    if (UI.button("Notificar", LX + 10, 112, bw, 30, { role: "caption", style: tipo === "notificar" ? "primary" : "ghost" })) {
        tipo = "notificar"; valor = ""; escolherValor();
    }
    if (UI.button("Guardar", LX + 14 + bw, 112, bw, 30, { role: "caption", style: tipo === "guardar" ? "primary" : "ghost" })) {
        tipo = "guardar"; chave = ""; valor = ""; escolherValor();
    }
    if (UI.button("Enviar", LX + 18 + bw * 2, 112, bw, 30, { role: "caption", style: tipo === "enviar" ? "primary" : "ghost" })) {
        tipo = "enviar"; destino = ""; valor = ""; escolherValor();
    }

    UI.text("3. VALOR", LX + 10, 156, { role: "caption", color: T.textDim, bg: T.card, w: 110 });
    var resumo = tipo === "guardar" ? (chave ? chave + " = " + valor : "(chave e valor)")
               : tipo === "enviar" ? (destino ? destino + ": " + valor : "(destino e texto)")
               : tipo ? (valor || "(mensagem)") : "(escolha a ação)";
    UI.text(resumo, LX + 10, 168, { role: "caption", color: T.text, bg: T.card,
                                    w: LW - 96, lines: 2, id: "val" });
    if (tipo && UI.button("Definir", LX + LW - 82, 160, 70, 26, { style: "ghost", role: "caption" })) escolherValor();
    UI.cardEnd();

    if (UI.button("Salvar regra", LX, 240, LW, 34,
                  { style: "primary", disabled: !(gatilho && tipo) })) {
        if (salvarNova()) return A.BACK;
    }
    UI.text("Vale quando o serviço reiniciar.", LX, L.bottom - 8,
            { role: "caption", color: T.textDim, w: LW, lines: 1 });
}

A.run({
    main: telaMain,
    detalhe: telaDetalhe,
    nova: telaNova
}, "main", { fps: 10 });   // tela estatica: 10 fps
