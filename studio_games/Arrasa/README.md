# Arrasa! - Celer Studio (nativo)

App original: `hub_apps/Arrasa` (intocado). Esta é a versão nativa:
`Titulo` -> `Mapa` -> `Fase 1..10` -> `Fim`, controlador em
`Assets/Scripts/arrasa.js` (física `P.rigid` do `celeros.physics`).

```bash
node tools/sdk/celer.js studio "studio_games/Arrasa" build
node tools/sdk/celer.js studio "studio_games/Arrasa" run --frames 0,1200
node tools/sdk/celer.js studio "studio_games/Arrasa" serve --open
```

## Cenas

Cada fase tem as peças como entidades com `data`: `kind` box (`mat`
madeira/vidro/pedra/tnt/rocha, `w`, `h`, `angle`) ou goblin (`type`
goblin/rei, `r`), em coordenadas de 480 px (mundo de 320 x 1.5).
`settings.data.shots` é a fila de pedras. `settings.assets` declara o atlas,
a explosão e os projéteis que giram, que só o script desenha.

## Arte (text2d, 2026-10-27)

| Asset | Grade | Conteúdo |
|-------|-------|----------|
| `arte.png` | 8x3 de 32 px, `arte#a0..23` | goblin (0..3), rei (4..7), pedra/pedrão/tripla/bomba/flecha/bumerangue/galinha/ovo (8..15), fumaça (16..21), estrela (22) |
| `bomba/flecha/bumerangue/chocadeira.png` | 28 px | projéteis que giram (região de folha não gira) |
| `boom.png` | 6x1 de 64 px | explosão de TNT/bomba |
| `tex_tnt.png`, `tex_*.png` | | texturas das peças |
| `fundo.png` | 480 px | cenário; no device a camada suja restaura por `blitSprite` |

Receita em `Documentation/Arte_text2d_2026-10-27.pt-BR.md`.

## UI

HUD de topo pelo `E.ui.hud` (fase, goblins, pontos). A fila das próximas
pedras e a pausa ficam na faixa do chão, longe da mira. Título, mapa, fim e
pausa usam `card`, `badge`, `button`, `modal` e `toast` do kit 1.3.
