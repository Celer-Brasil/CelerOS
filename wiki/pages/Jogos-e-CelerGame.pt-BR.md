# Jogos e CelerGame

[English](/Celer-Brasil/CelerOS/wiki/Games-and-CelerGame) | **Português (BR)**

Jogos no CelerOS são **JavaScript** (ES5, Duktape) construídos sobre a
**CelerGame** — a família de engine entregue como **dependências
compartilhadas** no hub (`celeros.game*`). A engine decora um único objeto
`E`: um `require` por módulo, zero código vendorizado, e o hub resolve e
instala tudo na instalação.

## A família

| Dependência | Entrega |
|---|---|
| `celeros.game` (core 1.7) | cenas + loop, entrada (multitoque API 43), gfx, câmera, math, timers/tweens/seq, grupos/pools, camada suja, áudio (música + tabelas de sfx), save (NVS), ganchos de tela apagada (`E.onSleep`/`E.onWake`, API 51), culling e hierarquia de nós (`celeros.game.node`) |
| `celeros.game.fx` | partículas, popText, flash, anéis, estrelas, emissores, trails, parallax |
| `celeros.game.spr` | sprites PNG em slots de hardware, spritesheets (`sheet`/`grid`), `stamp` com escala, flipbooks (`anim`, clipes direcionais) |
| `celeros.game.tilemap` | tilemaps de células sujas, consultas de solidez, sala gravada em sprite |
| `celeros.game.ui` | telas de título/pausa/fim, menus, listas com rolagem, diálogos, `confirm`, `toast` |
| `celeros.game.pad` | joystick flutuante + botões, multitoque (API 43), fallback de toque único |
| `celeros.sfx` | biblioteca de sfx chiptune (transpor/variar/juntar/combos), tocada pelo `E.audio` |
| `celeros.physics` | verlet (nativo na API 31+), corpos rígidos (API 33+) |
| `celeros.game.collide` / `.events` / `.fsm` / `.level` / `.path` / `.steer` / `.gen` / `.inv` / `.script` / `.stats` / `.waves` | os módulos de "cérebro": formas + spatial hash + sweeps, barramento de eventos, máquinas de estado, fases ASCII + progresso de estrelas, A*/fluxo, steering, geração de masmorras/cavernas, inventário, roteiros, atributos/XP, diretor de ondas |
| `celeros.game.combat` / `.world` | hitboxes/projéteis/knockback; salas do tamanho da tela com deslize, minimapa e estado por sala |
| `celeros.game.kit` / `.rpg` | bundles que cabem no **teto de 8 dependências** do `app.json` (`rpg` = stats + inv + script) |

O hub aceita **no máximo 8 dependências por app** — use só os módulos do
jogo (ou `celeros.game.kit` para o cérebro inteiro). Jogos grandes miram as
placas S3 com PSRAM: declare `"requires": ["psram"]`.

## Jogos na bancada (todos na App Store)

2048, 2D Runner (Neon Surfer), Arrasa!, Breakout, Campo Minado, Detona!,
Physics Drop, Pong Duplo (duas telas pelo Celer Link), Supernova e Tic Tac
Toe — todos sobre a CelerGame, vários com arte gerada por IA.

## Arte gerada por IA (text2d / texture2d)

A arte dos jogos é gerada com as CLIs da bancada e sobe **flat na raiz do
app** (o pacote do hub não carrega subpastas):

- `text2d` — texto → imagem (sprites com fundo transparente:
  `--category icon --transparent`).
- `texture2d` — texturas seamless para pisos/paredes/fundos
  (`texture2d batch prompts.txt`).

Empacote os sprites num `ai_atlas.png` (grade de células de 64 px sobre
**fundo magenta**, key `0xF81F`) e um fundo `ai_bg.png`, e no jogo:

```js
E.init({ dir: "MeuJogo", bases: ["/local/apps/MeuJogo/", "/sd/apps/MeuJogo/"] });
E.spr.grid("ai", { file: "ai_atlas", cols: 4, rows: 4, tw: 64, th: 64, prefix: "ai" });
E.spr.sheet("aibg", { file: "ai_bg", w: 256, h: 256, regions: { bg: [0, 0, 256, 256] } });
E.spr.stamp("ai0", x, y, { scale: 0.5, key: 0xF81F, ax: 0.5, ay: 0.5 }); // blit com escala
E.spr.stamp("bg", 0, 0, { scale: E.W / 256, key: null });               // fundo
```

Mantenha um fallback procedural/text2d para placas sem PNG
(`E.spr.backed()` diz o que está no ar).

## Apps no cartão SD

Jogos grandes instalam no **cartão SD** (`/sd/apps`): a partição da flash é
pequena (3,4 MB) e os cartões são de 16 GB+. Da bancada:

```bash
celerctl -p IP apps store --sd celeros.supernova   # instala do hub no cartão
celerctl -p IP shell sd format                     # cartao sem FAT32? formata (APAGA o cartao)
```

O launcher varre `/local/apps` **e** `/sd/apps`; remova uma das cópias para
não duplicar. Cartões formatados em **exFAT** (padrão do Windows em cartões
grandes) não são legíveis pelo firmware — o `sd format` aplica FAT32 (comando
explícito; o mount nunca formata sozinho). Detalhes completos no
`boards/AGENTS.md` do repositório.

## Leia mais

- **[Guia de Desenvolvimento de Apps](/Celer-Brasil/CelerOS/wiki/Guia-de-Apps)** — app.json, SDK, publicação (o Guia da Game Engine vive no repositório: `Documentation/Game_Engine_Guide.pt-BR.md`).
