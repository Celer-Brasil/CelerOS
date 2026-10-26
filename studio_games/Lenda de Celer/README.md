# Lenda de Celer - Celer Studio (modo legado)

App original: `hub_apps/Lenda de Celer`

O Play/build usa o **runtime legado**: o `main.js` original roda dentro do loop do Studio (bridge). Assets e scripts sao editaveis no projeto; a cena `Legado` e so um cartao e nao controla o jogo.

```bash
node tools/sdk/celer.js studio "studio_games/Lenda de Celer" build
node tools/sdk/celer.js studio "studio_games/Lenda de Celer" run --frames 0,1200
node tools/sdk/celer.js studio "studio_games/Lenda de Celer" serve --open
```

Proximo passo de remontagem: extrair levels/prefabs para cenas e trocar o modo legado por componentes nativos, sistema por sistema.
