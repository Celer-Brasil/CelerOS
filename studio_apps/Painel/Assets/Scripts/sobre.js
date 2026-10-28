// Controlador da tela "Sobre": so o botao de voltar (a pilha de telas e do
// runtime; ctx.back() desempilha).
exports.event = function (name, value, ctx) {
    if (name === 'voltar') ctx.back();
};
