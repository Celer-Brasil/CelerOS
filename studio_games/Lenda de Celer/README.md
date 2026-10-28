# Lenda de Celer - Celer Studio (nativo)

Fonte única (2.2.2): o hub publica o build deste projeto desde a consolidação
de 2026-10-27 — a antiga cópia plana em `hub_apps/` foi removida.
`Titulo` -> 20 salas (`Campo x,y`, `Casa 0,0`, `Templo x,y`) -> `Vitoria`/`Fim`,
controlador em `Assets/Scripts/lenda.js`.

```bash
node tools/sdk/celer.js studio "studio_games/Lenda de Celer" build
node tools/sdk/celer.js studio "studio_games/Lenda de Celer" run --frames 0,1200
node tools/sdk/celer.js studio "studio_games/Lenda de Celer" serve --open
```

## Cenas

Cada sala tem o tilemap 15x13 (células de 32 px abaixo do HUD de 64 px) e os
spawns como entidades (`Heroi`, inimigos, baús, itens, Sábio, loja).
`settings.data` traz `name`, `area`, `start` e `portals`. `settings.assets`
declara as folhas que só o script desenha (lâmina, retrato, efeitos).

## Arte

| Asset | Grade | Conteúdo |
|-------|-------|----------|
| `heroina.png` | 4x4 de 40 px, `heroina#h0..15` | caminhada baixo/cima/esquerda/direita (text2d `animate-set`) |
| `efeitos.png` | 6x6 de 48 px, `efeitos#e0..35` | arco do golpe nas 4 direções (0..23), fumaça (24..29), cura (30..35) |
| `boom.png` | 6x1 de 96 px | explosão da bomba (3x3 células) |
| `heroi.png` | 10 de 32 px | folha antiga: lâmina da espada (6..9) |
| `inimigos.png`, `chefe.png`, `itens.png`, `tileset.png`, `titulo.png` | | arte da remontagem |

Receita em `Documentation/Arte_text2d_2026-10-27.pt-BR.md`.

## UI

HUD memoizado à mão (fora do recorte do mundo) com corações e ícones do
inventário; fala do Sábio/loja num card com retrato e nome; título, pausa,
vitória e queda com `card`, `button` e `modal` do kit 1.3.
