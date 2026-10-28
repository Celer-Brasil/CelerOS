// Tela Ajuda: so volta para a conversa.
exports.event = function (name, value, ctx) {
    if (name === 'voltar') ctx.back();
};
