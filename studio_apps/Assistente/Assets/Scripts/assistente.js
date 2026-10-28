// Controlador da tela "Conversa". O componente ai.chat e disparado por uma
// chave do estado (st.pedir) e devolve em st.resposta; aqui so ligamos os
// botoes, montamos a lista e pedimos a fala da resposta.
exports.create = function (ctx) {
    return { n: -1 };
};

exports.start = function (ctx) {
    var st = ctx.st;
    if (!st.mensagens || !st.mensagens.length) {
        st.mensagens = [{ label: 'Diga oi ou segure Falar.', sub: 'assistente' }];
    }
    if (!st.historico) st.historico = [];
    st.estado = 'pronto';
};

exports.update = function (dt, ctx) {
    var st = ctx.st;
    var h = st.historico || [];
    if (h.length !== this.n) {
        this.n = h.length;
        var rows = [];
        for (var i = 0; i < h.length; i++) {
            rows.push({
                label: String(h[i].content),
                sub: h[i].role === 'user' ? 'voce' : 'assistente'
            });
        }
        if (rows.length) st.mensagens = rows;
    }
    st.estado = st.ocupado ? 'pensando...' : 'pronto';
};

exports.event = function (name, value, ctx) {
    var st = ctx.st;
    if (name === 'enviar') {
        if (!st.pergunta) { ctx.toast('Escreva ou fale algo'); return; }
        st.pedir = true;
    } else if (name === 'mic:done') {
        if (st.audio) { st.pergunta = ''; st.pedir = true; }
    } else if (name === 'ai:done') {
        if (!value || !value.ok) {
            ctx.toast('Falha: ' + ((value && value.detail) || 'sem resposta'));
            return;
        }
        st.falar = true;
    }
};
