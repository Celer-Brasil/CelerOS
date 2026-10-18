// Wire de teste do Help (nunca vai ao aparelho): scripta a central online do
// hub (indice -> categoria -> artigo) e navega menu -> Ajuda Online ->
// categoria -> topico -> leitor. Os toques sao agendados pelo RELOGIO do app
// (frames de busy consomem mais clock que frames normais). Usado por
// `node tools/sdk/celer.js test|emu data/apps/Help`.
module.exports.wire = function (env) {
    env.Net.isConnected = function () { return true; };
    env.Net.getJSON = function (url) {
        if (url.indexOf("index.json") >= 0) {
            return { categories: [{ name: "Cat A", url: "https://hub/cat-a.json" }] };
        }
        if (url.indexOf("cat-a") >= 0) {
            return { articles: [{ title: "Artigo 1", url: "https://hub/artigo-1.json" }] };
        }
        return { content: "Corpo do artigo de teste com acentuacao: acao, coracao." };
    };
    // toques por marco do relogio (o clock comeca em 1000): Ajuda Online,
    // categoria, artigo (abre o leitor), volta do leitor, volta ao indice
    var passos = [
        [1550, 120, 204],
        [2400, 120, 70],
        [3200, 120, 70],
        [4400, 14, 20],
        [5200, 14, 20]
    ];
    var feitos = 0;
    var orig = env.System.delay;
    env.System.delay = function (ms) {
        var agora = env.System.millis();
        while (feitos < passos.length && agora >= passos[feitos][0]) {
            env.__harness.tap(passos[feitos][1], passos[feitos][2]);
            feitos++;
        }
        return orig(ms);
    };
};
