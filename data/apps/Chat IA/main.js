// CelerOS Chat IA — assistente DeepSeek sobre o CelerKit (deps celeros.app.*).
// O app era o molde do par transcript+cliente de IA que o Qwen copiava:
// bolhas/rolagem viraram celeros.app.chat, o tratamento do AI.chat (retry dos
// transientes, busy, historico) virou celeros.app.ai, a linha de digitacao
// com teclado dockado virou celeros.app.input. Aqui so fica a cola do app.
// ES5 puro (Duktape). A chave fica no aparelho — o app nunca a ve.

var A = require("celeros.app");
require("celeros.app.text");
require("celeros.app.input");
require("celeros.app.chat");
require("celeros.app.ai");

var VER = System.getOSVersion();
A.init();

// Personalidade curta: resposta curta gasta menos token, latencia e tela
var ia = A.ai.client({
    system: "Você é o assistente do CelerOS, um sistema para " +
            "dispositivos ESP32 com tela pequena. Responda em português, de forma " +
            "curta e direta, sem usar emojis.",
    onmsg: function (papel, s) {
        if (papel === "user") t.user(s);
        else t.bot(s);
        UI.invalidate();
    },
    note: function (s) { t.note(s); UI.invalidate(); },
    err: function (s) { t.err(s); UI.invalidate(); }
});

// transcript (celeros.app.chat): bolhas medidas, rolagem que segue o fim
var t = A.chat.new();

// cabecalho + conversa anterior (o historico mora no cliente de IA)
t.note("Chat IA " + VER, A.T.accent);
if (!ia.ok) t.err("requer firmware com API >= 18");
else t.note("DeepSeek; histórico local; arraste para rever");
for (var i = 0; i < ia.hist.length; i++) {
    var m = ia.hist[i];
    if (m.r === "user") t.user(m.s);
    else t.bot(m.s);
}

// teclado dockado + chips da faixa (Limpar zera; Cancelar esquece a requisicao)
var kb = A.input.open({ maxLen: 256, chips: ["Limpar", "Cancelar"] });
var busyAntes = false;

A.run({
    chat: function (c) {
        // eventos do teclado chegam antes do frame (o firmware entrega no present)
        var ev = A.input.poll();
        if (ev) {
            if (ev.type === "enter" && ev.text) ia.send(ev.text);
            UI.invalidate();
        }
        var chip = A.input.chip();
        if (chip === "Limpar") {
            ia.clear();
            t.clear();
            t.note("conversa apagada");
            UI.invalidate();
        } else if (chip === "Cancelar") {
            if (ia.cancel()) t.note("cancelado");
            UI.invalidate();
        }

        // a resposta chegou: bip curto (a IA entregou no yield do frame passado)
        if (busyAntes && !ia.busy) {
            try { if (typeof System.beep === "function") System.beep(1320, 60); } catch (e) {}
        }
        busyAntes = ia.busy;

        t.busy = ia.busy;                       // balao "pensando" com spinner
        var h = kb ? A.input.top() - 44 : 320 - 48 - 4;
        A.input.redraw(c.full);                 // frame total apaga o teclado
        t.draw(c.full, h);
        if (kb) A.input.line("Mensagem");
    }
}, "chat", { fps: 20 });
