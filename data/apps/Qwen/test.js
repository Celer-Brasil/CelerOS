// Wire de teste do Qwen (nunca vai ao aparelho): conecta o WiFi ficticio,
// scripta a resposta da IA, abre o teclado (o aparelho tem mic: o teclado so
// abre pelo botao "Teclado" da fileira) e digita uma mensagem. Usado por
// `node tools/sdk/celer.js test|emu data/apps/Qwen`.
module.exports.wire = function (env) {
    env.Net.isConnected = function () { return true; };
    env.__harness.setAiResponse({
        ok: true,
        status: 200,
        content: 'Ola! Sou o Qwen, seu assistente de voz.',
        usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 },
        raw: '{"choices":[{"message":{"content":"Ola!"}}]}'
    });
    env.__harness.tap(47, 17);        // botao "Teclado" da fileira de cima
    env.__harness.typeLine('quem e voce?');
};
