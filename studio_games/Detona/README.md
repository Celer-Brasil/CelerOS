# Detona! - Celer Studio (nativo)

App original: `hub_apps/Detona` (intocado). Esta é a versão nativa: cada tela
e fase é uma cena do Studio e o controlador é `Assets/Scripts/detona.js`.

```bash
node tools/sdk/celer.js studio "studio_games/Detona" build
node tools/sdk/celer.js studio "studio_games/Detona" run --frames 0,1200
node tools/sdk/celer.js studio "studio_games/Detona" serve --open
```

## Cenas

`Titulo` -> `Mapa` -> `Fase 1..6` -> `Vitoria`. As fases são tilemaps 15x13
(`mapa`: 0 chão, 1 parede, 2 caixa, 3 saída) com o jogador e os inimigos como
entidades. `settings.data` da fase traz `level`, `name`, `theme`
(garden/forge/core), `time` e `exit`. `settings.assets` declara o atlas que o
script desenha sozinho (bombas, chamas, itens, HUD): o runtime só carrega o
que a cena declara ou referencia.

## Arte (text2d, 2026-10-27)

| Asset | Grade | Conteúdo |
|-------|-------|----------|
| `arte.png` | 8x6 de 32 px, `arte#a0..47` | jogador sul/norte/oeste/leste (0..15), slime (16..19), fantasma (20..23), caçador (24..27), bomba (28..29), itens alcance/bomba/velocidade/detonador/escudo/vida (32..37), explosão (40..45) |
| `chefe.png` | 2x1 de 64 px | Rei Slime respirando |
| `fundo.png` | 480x240 | parallax da fábrica (Título/Mapa/Vitória) |
| `tiles_*.png` | 4 tiles de 32 | Jardim, Forno, Núcleo |

Receita e seeds em `Documentation/Arte_text2d_2026-10-27.pt-BR.md`. A arte é
masterizada em 32 px nativos: entidade em escala 1 fica no caminho rápido do
`copySprite` (escala 0.5 caía no afim).

## Inimigos (`data.type` da entidade)

- `slime`: persegue devagar.
- `hunter`: persegue rápido.
- `ghost`: atravessa caixas; só o fogo da caixa quebrando o pega lá dentro.
- `boss`: 12 HP, planta bombas próprias.

## UI

Menus, pausa e fim de fase usam o kit `celeros.game.ui` 1.3 (preset `neon`
com acento laranja): `card`, `button` com ícone, `badge`, `ring`, `modal`,
`toast`. O HUD da faixa de baixo é memoizado à mão (fica fora do recorte do
tabuleiro) e desenha os ícones do atlas.
