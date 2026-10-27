# Supernova - Celer Studio (nativo)

App original: `hub_apps/Supernova` (intocado). Esta é a versão nativa:
`Titulo` -> `Campanha`/`Infinito` -> `Vitoria`/`Fim`, controlador em
`Assets/Scripts/supernova.js`.

```bash
node tools/sdk/celer.js studio "studio_games/Supernova" build
node tools/sdk/celer.js studio "studio_games/Supernova" run --frames 0,1200
node tools/sdk/celer.js studio "studio_games/Supernova" serve --open
```

## Cenas

`Campanha` e `Infinito` têm a nave (`Nave`, 72 px) e o `Fundo` como
entidades; `settings.data` traz `mode` (campaign/endless) e `maxWave`.
Ondas, inimigos, tiros, drops e explosões são pools do controlador.
`settings.assets` declara `naves` e `chefe`, que só o script desenha.

## Arte (text2d, 2026-10-27)

| Asset | Grade | Conteúdo |
|-------|-------|----------|
| `naves.png` | 8x3 de 48 px, `naves#n0..23` | drone, sentinela, divisor, mini (par = normal, ímpar = silhueta do golpe), explosão (8..13), orbe 2 quadros (14..15), tiro triplo (16), vida (17) |
| `chefe.png` | 2x1 de 112 px | Sentinela-mor + silhueta |
| `nave.png` | 72 px | nave do jogador |
| `fundo.png` | 240 px | nebulosa; o jogo assa em 2x num slot e a camada suja restaura por `blitSprite` |
| `titulo.png` | 480x230 | camada de céu do parallax |

Tudo em escala 1 no jogo (caminho rápido do `copySprite`); só a explosão do
chefe usa escala 2. Receita em `Documentation/Arte_text2d_2026-10-27.pt-BR.md`.

## UI

HUD embaixo pelo `E.ui.hud` (memoizado: só repinta quando muda a
assinatura). O campo de estrelas é o `E.fx.stars` com `h` até o HUD, para
nenhuma estrela sujar a caixa memoizada. Pausa e SUPER (anel de carga) ficam
no alto e respondem no press; título, pausa e fim usam `card`, `badge`,
`button` e `modal` do kit 1.3 (preset `neon`, acento ciano).
