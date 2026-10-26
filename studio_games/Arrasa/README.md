# Arrasa! - Celer Studio (modo legado)

App original: `hub_apps/Arrasa`

O Play/build usa o **runtime legado**: o `main.js` original roda dentro do loop do Studio (bridge). Assets e scripts sao editaveis no projeto; a cena `Legado` e so um cartao e nao controla o jogo.

```bash
node tools/sdk/celer.js studio "studio_games/Arrasa" build
node tools/sdk/celer.js studio "studio_games/Arrasa" run --frames 0,1200
node tools/sdk/celer.js studio "studio_games/Arrasa" serve --open
```

Proximo passo de remontagem: extrair levels/prefabs para cenas e trocar o modo legado por componentes nativos, sistema por sistema.
