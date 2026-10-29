# Detona! - Celer Studio (nativo)

Fonte única (1.2.4): o hub publica o build deste projeto desde a consolidação
de 2026-10-27 — a antiga cópia plana em `hub_apps/` foi removida. cada tela
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

## Modos (1.2.0)

Os tres botoes do titulo abrem o mesmo jogo por caminhos diferentes:

- **JOGAR** — campanha: 3 mundos x 2 fases, estrelas por tempo/vidas, mapa
  com desbloqueio e recorde.
- **SOBREVIVENCIA** — ondas infinitas na arena da Fase 1, sem relogio nem
  saida: a onda 1 e a populacao da fase, as seguintes entram por spawn nos
  corredores abertos (`2 + onda/2`, teto 8), com cacador a partir da 2,
  fantasma da 4 e o chefe a cada 5. Recorde em `sobre.hi`/`sobre.onda`.
- **DUELO** — 1x1 pela malha CelerNet (dep `celeros.mesh`), melhor de 3.

### Duelo (protocolo portado da 0.10.x)

A cena `Duelo` e o lobby: heartbeat `dhl` a cada 3 s anuncia o aparelho,
tocar num nome manda `di`, o outro aceita (`da1`) e vira host. O host sorteia
o seed do round, manda `ds<seed>,<round>` e os dois abrem a MESMA fase
(`1 + seed % 6`); a arena do duelo entra sem monstros. Durante o round:

| mensagem | sentido |
|---|---|
| `dp<seq>,c,r` | celula do rival (enviada quando muda) |
| `db<seq>,c,r,range` | bomba plantada pelo rival |
| `dd<seq>` | detonacao remota |
| `dm<seq>` | o rival morreu no aparelho dele |
| `dq` | desistencia |
| `dy<round>` | ack do `ds` (reenvio sem ACK) |

Cada evento leva numero de sequencia (descarte de repetido) e a presenca do
rival e checada a cada 2,5 s: sumiu da malha = `saiu`. Morrer nos dois lados
na mesma janela de 0,9 s conta empate. Quem chega a 2 vitorias fecha a
partida; o overlay mostra o placar e o host puxa o round seguinte.

O harness injeta mensagens por `__harness.detona.netIn` (o `test/studio`
cobre lobby, convite, aceite, arena pelo seed, posicao/bomba e fim de round).
