# Jogos nativos no Celer Studio

Estes quatro projetos são remontagens **nativas** dos jogos maiores no editor
(`celer.js studio`). Nada de bridge legada: cada tela/fase/sala é uma cena do
Studio, os cenários são tilemaps editáveis e as peças/spawns são entidades.
Os controladores ficam em `Assets/Scripts/` e são ES5 como qualquer app.

| Projeto | Original | Versão | Cenas | Destaques |
|---------|----------|--------|-------|-----------|
| `Detona` | `hub_apps/Detona` | 1.1.0 | 9 | 6 fases 15x13, 3 tilesets, soldado 4 direções, slime/fantasma/caçador + Rei Slime, itens e explosão text2d, menus UI 1.3 sobre parallax, joystick de arraste |
| `Arrasa` | `hub_apps/Arrasa` | 2.1.0 | 13 | 10 fases com peças/entidades + `P.rigid`, estilingue, 7 pedras com arte própria, TNT, rei animado, explosão/fumaça vfx, fila de tiros no HUD, menus UI 1.3 |
| `Lenda de Celer` | `hub_apps/Lenda de Celer` | 2.1.0 | 23 | 20 salas ASCII + tilemap, heroína 4 direções (`animate-set`), golpe/fumaça/explosão/cura vfx, espada/bomba/bumerangue, baús, Sábio com retrato, loja, Guardião, save, menus UI 1.3 |
| `Supernova` | `hub_apps/Supernova` | 3.1.0 | 5 | campanha de 10 ondas + infinito, chefe 3 fases, 4 inimigos com arte própria, explosão vfx, drops, nebulosa assada, HUD `E.ui.hud`, menus UI 1.3 |

Build/run/deploy headless:

```bash
node tools/sdk/celer.js studio "studio_games/Detona" build
node tools/sdk/celer.js studio "studio_games/Detona" run --frames 0,1200
# navegar menus (coordenadas 480x480): 300 tap 240,300 -> --input toques.txt
node tools/sdk/celer.js studio "studio_games/Detona" deploy  # .studio/deploy/app.zip
```

## O que é editável

- **Cenas**: `Assets/Scenes/*.scene.json`, com entidades, tilemaps e
  `settings.data` (fase, ondas, área, portais, textos de menu).
- **Assets**: `Assets/Sprites/**` com `.meta` (GUID, grade, pivot, cor-chave,
  `anims`, hitbox, tiles sólidos).
- **Scripts**: `Assets/Scripts/*.js`; o controlador lê `ctx.scene.data`,
  `ctx.scene.find/tm/solidAt/rectSolid`, `ctx.asset(n)` e usa `ctx.go(cena, arg)`
  para trocar de cena.
- **Peças/spawns**: no Detona são tilemaps; no Arrasa são entidades com
  textura/rotação; na Lenda são entidades de spawn/baú/item/NPC; no Supernova
  são a nave e o fundo, com ondas no `settings.data`.

## O que fica no controlador

Inimigos que nascem, tiros, partículas, corpos de física e HUD são pools do
controlador (o runtime não tem "spawnar prefab"). Os apps originais em
`hub_apps/` **não** foram alterados. `.studio/` (build/undo/run) fica no
`.gitignore` de cada projeto.

Para criar um projeto legado a partir de um app ainda não portado existe
`celer.js studio import-game <app> <projeto>`; ele usa a bridge
`templates/legacy.js` e não é o modo destes quatro.
