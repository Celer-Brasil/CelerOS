# Celer Studio — editor de jogos e programas para o CelerOS

O Celer Studio é um editor no estilo Unity para apps do CelerOS. Dois runtimes
compartilham o mesmo formato de arquivo, barramento de ops e GUI:

- **jogo** (`runtime: "studio"`, o padrão) — cenas, tilemaps e entidades sobre a
  CelerGame, a engine ES5 que viaja como dependências `celeros.game.*`;
- **programa** (`runtime: "app"`) — cada cena é uma TELA montada com os widgets
  do toolkit do sistema (`UI.*`), sem dependência de engine nenhuma.

Ele é **file-first**: projeto, cenas, prefabs e metadados de assets são JSON no
disco, e toda ação é um comando JSON num único barramento usado pela GUI, pelo
CLI e pela API HTTP. Uma IA — ou o copiloto embutido — consegue fazer um app
inteiro sem abrir o navegador.

- Local: `tools/studio/` (comando do SDK `node tools/sdk/celer.js studio ...`)
- GUI: app web local servido por Node (sem build, sem dependências npm)
- Saída: pacote de app CelerOS plano (ES5, pronto para `celerctl`/hub)

## Início rápido

```bash
# 1. cria um projeto (com uma cena inicial)
node tools/sdk/celer.js studio init ~/Jogo --name "Meu Jogo"
node tools/sdk/celer.js studio init ~/Painel --app --name "Painel"   # programa

# 2. abre o editor (hierarquia, inspetor, viewport, play)
node tools/sdk/celer.js studio ~/Jogo serve --open

# 3. ou opera headless
node tools/sdk/celer.js studio ~/Jogo describe --json
node tools/sdk/celer.js studio ~/Jogo validate
node tools/sdk/celer.js studio ~/Jogo build
node tools/sdk/celer.js studio ~/Jogo run --ms 1200 --out tela.png

# 4. ou deixa o copiloto escrever as ops (precisa de chave de API no ambiente)
node tools/sdk/celer.js studio ~/Jogo ai "adicione um botao Sobre que abre a cena Sobre"
```

## Estrutura do projeto

```
MeuJogo/
  celergame.project.json          configurações + deps da engine
  Assets/
    Sprites/heroi.png  heroi.png.meta
    Sprites/atlas.png  atlas.png.meta
    Audio/bump.qoa     bump.qoa.meta
    Scripts/heroi.js   heroi.js.meta
    Prefabs/inimigo.prefab.json   inimigo.prefab.json.meta
    Scenes/campo.scene.json       campo.scene.json.meta
  icon.png                        ícone opcional do pacote
  .studio/                        build/, undo/, redo/, run/ (gitignored)
  .gitignore
```

Todo asset, cena e prefab tem um sidecar `.meta` com um **GUID estável de 32
hex**. Renomear o arquivo não muda o GUID; as referências (cenas, prefabs,
componentes) apontam para ele. É isso que torna edições de IA e renomeações
seguras.

### `celergame.project.json`

```json
{
  "format": 1,
  "rev": 3,
  "studio": "0.1.0",
  "name": "Meu Jogo",
  "packageName": "br.autor.meujogo",
  "version": "0.1.0",
  "author": "Autor",
  "description": "Jogo feito com a CelerGame",
  "type": "Game",
  "category": "Jogos",
  "api": 50,
  "requires": ["psram"],
  "topbar": false,
  "permissions": [],
  "deps": {
    "celeros.game": "^1.4.5",
    "celeros.game.spr": "^1.5.2",
    "celeros.game.tilemap": "^1.3.0"
  },
  "canvas": { "w": 240, "h": 320, "native": false, "fps": 30 },
  "startScene": "0123456789abcdef0123456789abcdef",
  "build": { "out": ".studio/build", "splitKB": 96 },
  "editor": { "grid": 8, "snap": true }
}
```

- `canvas.native` escolhe o canvas nativo 480x480 nas placas S3; sem ele o app
  usa o espaço virtual 240x320.
- `deps` são os módulos CelerGame que o app gerado declara (máximo 8). O
  runtime gerado exige `celeros.game`, `celeros.game.spr` e
  `celeros.game.tilemap`; outras deps `celeros.game.*` entram no `main.js`
  automaticamente.
- `rev` é um contador de revisão otimista. Comandos aceitam `ifRev` e recusam
  escrita sobre estado velho.

### `.meta`

```json
{
  "format": 1,
  "guid": "8f14e45fceea167a5a36dedd4bea2543",
  "importer": "tileset",
  "settings": {
    "mode": "grid",
    "w": 512, "h": 256,
    "cols": 8, "rows": 4, "tw": 64, "th": 64,
    "pivot": [0.5, 0.5],
    "key": "#000000",
    "prefix": "",
    "tiles": [{ "name": "0", "solid": false }],
    "anims": { "idle": [0, 1], "run": [2, 3, 4, 5] },
    "fps": { "run": 12 },
    "loop": { "idle": true, "run": true },
    "hitbox": [8, 8, 48, 48]
  }
}
```

Importers: `sprite` (imagem única), `sprite-sheet` (grade ou regiões
explícitas), `tileset` (grade + metadados de tile), `audio`, `script`,
`scene`, `prefab`. Cores são `#RRGGBB` na fonte; o build converte para RGB565.

`pivot`, `anims`, `fps`, `loop` e `hitbox` são o contrato do `E.spr.meta`
(spr 1.6): o build registra tudo no módulo de dados gerado, então
`blit`/`stamp` herdam a âncora e `E.spr.animOf`/`box` funcionam nos scripts.
`anims` usa índices da grade (ou nomes de região explícitos); `fps` é por
clipe; `hitbox` é `[x,y,w,h]` dentro do quadro.

### Cena

```json
{
  "format": 1,
  "rev": 4,
  "guid": "0123456789abcdef0123456789abcdef",
  "name": "campo",
  "settings": {
    "bg": "#101020",
    "fps": 30,
    "static": false,
    "camera": { "bounds": [0, 0, 480, 320], "follow": "e_hero", "deadzone": [40, 30] }
  },
  "entities": [
    {
      "fid": "e_hero",
      "name": "Heroi",
      "active": true,
      "z": 5,
      "transform": { "x": 80, "y": 120, "rot": 0, "sx": 1, "sy": 1 },
      "components": [
        { "id": "c_spr", "type": "sprite", "fields": { "sprite": "GUID#heroi0", "key": "#000000" } },
        { "id": "c_scr", "type": "script", "fields": { "script": "GUID", "fields": { "speed": 60 } } }
      ]
    }
  ],
  "tilemaps": [
    {
      "id": "tm_chao",
      "tileset": "GUID",
      "cols": 15, "rows": 10, "cell": 32, "ox": 0, "oy": 0, "layer": 0,
      "data": [3, 3, 0, -1],
      "solids": [false, false, false, true],
      "autotile": { "0": 1, "1": 2, "2": 3, "3": 4 }
    }
  ]
}
```

- Toda entidade tem `transform` implícito; `z` é a ordem de desenho. `ax`/`ay`
  são opcionais: ausentes, usam o pivot do `.meta` do sprite (spr 1.6); um
  valor explícito sobrescreve.
- `fid` é o id estável da entidade dentro da cena/prefab.
- Refs de sprite são `"<guid do asset>#<região>"` (assets de imagem única podem
  omitir `#região` quando o importer é `single`).
- `data` do tilemap é um array plano `cols*rows`; `-1` é célula vazia.
  `solids` é consultado por `E.tilemap.solidAt/rectSolid`; `autotile` mapeia a
  máscara de 4 bits dos vizinhos (1=cima, 2=direita, 4=baixo, 8=esquerda) para
  um índice de tile.
- Uma instância de prefab é uma entidade com `prefab` (GUID) e `overrides`; o
  build achata em entidades reais (o runtime nunca resolve prefab).

### Prefab

```json
{
  "format": 1,
  "rev": 2,
  "guid": "0123456789abcdef0123456789abcdef",
  "name": "moeda",
  "entities": [
    {
      "fid": "e_base",
      "name": "moeda",
      "z": 0,
      "transform": { "x": 0, "y": 0, "rot": 0, "sx": 1, "sy": 1, "ax": 0.5, "ay": 0.5 },
      "components": [{ "id": "c_a", "type": "anim", "fields": { "clips": {} } }]
    }
  ]
}
```

Transforms de prefab são locais (0,0 = origem da instância). Overrides são
chaveados pelo `fid` da entidade do prefab:

```json
{
  "overrides": {
    "e_base": {
      "name": "Moeda azul",
      "transform": { "x": 24 },
      "active": true,
      "components": { "c_a": { "current": "idle" } }
    }
  }
}
```

Aninhamento é achatado recursivamente no build (limite 4 níveis).

## Remontagens nativas (`studio_games/`)

Os quatro jogos maiores são **projetos nativos do Studio e a fonte única**: as
telas são cenas, as fases/salas são tilemaps e as peças/spawns são entidades.
Os controladores ficam em `Assets/Scripts/*.js`. O hub publica o **build**
destes projetos, então as antigas cópias planas em `hub_apps/` foram removidas
(2026-10-27) — nunca edite um jogo em dois lugares.

| Projeto | Versão | Cenas | Extras | JS | Assets |
|---------|--------|-------|--------|----|--------|
| `studio_games/Detona` | 1.2.0 | 10 | 9 | 68.3 KB | 131.6 KB |
| `studio_games/Arrasa` | 2.1.0 | 13 | 14 | 81.5 KB | 66.8 KB |
| `studio_games/Lenda de Celer` | 2.2.0 | 23 | 12 | 115.3 KB | 245.7 KB |
| `studio_games/Supernova` | 3.1.0 | 5 | 8 | 32.8 KB | 192.7 KB |

(Tamanhos medidos em 2026-10-27 com o pipeline minificado — `studio build`.)

Abra, edite e jogue como qualquer projeto:

```bash
node tools/sdk/celer.js studio "studio_games/Detona" serve --open
node tools/sdk/celer.js studio "studio_games/Detona" build
node tools/sdk/celer.js studio "studio_games/Detona" run --frames 0,1200
# navegar menus (480x480): 300 tap 240,300 -> --input toques.txt
```

O que cada remontagem ganhou:

- **Detona 1.0.5** — seis fases de campanha como tilemaps 15x13 editáveis, três
  tilesets (jardim/forno/núcleo), saída escondida sob caixa, powerups (alcance,
  bomba, velocidade, remoto, escudo, vida), chefe de 12 HP com barra,
  estrelas, mapa de fases, pausa e progresso salvo. O toque é joystick
  flutuante de arraste (segurar anda casa a casa; toque seco planta); o HUD é
  memoizado fora da camada suja, o tabuleiro é assado num sprite e cada
  quadro volta com um blit do tabuleiro. A 1.0.5 adiciona ciclos de caminhada
  16-bit gerados por `text2d` para o soldado e o slime.
- **Arrasa 2.0.2** — as dez fases originais como cenas; cada caixa/goblin/rei é
  uma entidade com textura/rotação sincronizada a um corpo `P.rigid`.
  Estilingue, sete poderes de pedra, TNT em cadeia, dano por impacto, estrelas
  e progresso salvo. A 2.0.2 anima os goblins comuns com ciclo gerado por
  `text2d` (o rei permanece na folha antiga).
- **Lenda de Celer 2.0.7** — as 20 salas ASCII originais como cenas (Campo,
  Gruta e Templo), sólidos por tile, portais de borda/porta/escada/caverna/
  rachadura, espada/bomba/bumerangue, baús, Sábio, loja de cristais, Guardião
  em três fases, save automático, continuar, vitória e fim. Os botões A/B usam ícones de espada/bomba/bumerangue; a espada é um overlay separado (o corpo não some) e os tilemaps desenham a célula pelo canto. A 2.0.4 também leva o `deps.json` resolvido dentro do pacote, então a instalação direta acha os módulos compartilhados da engine. A 2.0.5 memoiza o HUD fora da camada suja, recorta a repintura do mundo na faixa do HUD (sem 12 círculos de coração, ícones de botão e textos por quadro) e reutiliza opções de sprite e nomes de frames.
- **Supernova 3.0.2** — campanha de 10 ondas com chefe a cada cinco e modo
  infinito, chefe em três fases, combo x1..x5, orbes, SUPERNOVA, tiro triplo,
  hitbox de graze, pausa, recorde e cenas nativas de título/vitória/derrota.

### Dados de cena e API do controlador

Uma cena nativa entrega dados aos scripts por `settings.data` e carrega
assets extras com `settings.assets`. O componente `data` coloca JSON livre na
entidade (`entity.data`). O script recebe:

```js
ctx = {
  E, scene, entity, assets, arg, save, data,
  asset(name),                 // dados de runtime do asset (metadados etc.)
  go(tituloDaCena, arg)        // troca de cena; arg vira ctx.arg
}
```

e a cena expõe:

```js
scene.title, scene.data, scene.arg
scene.entities, scene.tilemaps
scene.find(fidOuNome), scene.tm(id)
scene.solidAt(x, y), scene.rectSolid(x, y, w, h)
scene.asset(name)
```

`start()` roda depois do mundo inteiro (entidades + tilemaps) montado. Use
essa API para títulos, HUD e controladores que criam pools próprios
(inimigos, tiros, corpos de física), mantendo o nível editável na cena.

Tilemaps têm **colisão por tile** quando o `.meta` do tileset tem
`tiles[i].solid`. O build grava `solidValues` e `map.solidAt()` segue o valor
**atual** da célula, então `map.set(c, r, 0)` abre uma caixa/parede rachada na
hora. Cenas antigas sem flags caem na grade `solids` da cena.

Prefabs continuam achatados no build; não existe "spawnar prefab" em runtime.
Objetos dinâmicos são pools/entidades do controlador, como nos quatro jogos.

### Bridge legada (opcional)

`studio import-game` continua disponível para uma cópia editável rápida de um
app ainda não portado. Ele grava `runtime: "legacy"` + `legacy.entry`; o
`build` embute `templates/legacy.js`, que captura a tabela do `E.run` original,
redireciona `E.goto`/`push`/`pop` e mantém input, módulos, timers, tweens,
câmera, áudio e camada suja na engine. A cena no painel é só um cartão nesse
modo. Os quatro projetos em `studio_games/` não usam mais a bridge; ela segue
testada para a ferramenta não regredir.

## Componentes

| Tipo | Campos |
|------|--------|
| `sprite` | `sprite` (ref), `key` (cor-chave) |
| `anim` | `meta` (asset de atlas para `E.spr.animOf`), `clips` (`{nome:{frames:[refs],fps,loop}}`), `current`, `autoplay` |
| `text` | `text`, `color`, `px` ou `ts` (`tiny..huge`), `align`, `valign`, `shadow` |
| `shape` | `shape` (`rect`, `circle`, `line`), `w`, `h`, `r`, `x2`, `y2`, `color`, `fill` |
| `collider` | `shape`, `w`, `h`, `r` (gizmo do editor + `entity.col` para scripts) |
| `script` | `script` (ref de script), `fields` (JSON entregue ao script) |
| `hud` | `anchor` (0..8, teclado numérico), `mx`, `my` — posiciona sprite/texto/forma com `E.anchor` (core 1.5), ciente da margem segura |
| `data` | `fields` (JSON) — dados livres entregues aos scripts como `entity.data` |

Com `meta`, o runtime pede `E.spr.animOf(meta, current)` do clipe declarado no
`.meta` do atlas; `clips` explícitos continuam como fallback.

`transform` é implícito e aparece no inspetor. A fonte única de campos, tipos,
defaults e formulários da GUI é `tools/studio/schema/components.json`.

### Scripts

Um script é um módulo CommonJS ES5 copiado para o pacote como `s.<slug>.js`.
O runtime chama com `this` = instância do script e `ctx` =
`{ E, scene, entity, assets }`:

```js
exports.props = { speed: 60 };

exports.start = function (ctx) { this.t = 0; };

exports.update = function (dt, ctx) {
    this.t += dt;
    ctx.entity.x += Math.sin(this.t * 3) * (this.fields.speed || 20) * dt;
};

exports.draw = function (ctx) { /* opcional, depois dos componentes nativos */ };
exports.destroy = function (ctx) { /* opcional */ };
```

`ctx.entity` expõe `x, y, rot, sx, sy, ax, ay, z, active, fields`,
`setClip(nome)` para entidades animadas e `box(scale, out)` — a hitbox do atlas
via `E.spr.box`, em coordenadas de mundo. `ctx.E` é o objeto da engine, então
os scripts podem usar `E.spr.animOf`, `E.prof`, `E.anchor` etc. O script passa
pelo `app_lint` (apenas ES5) durante o build.

### Props tipados de script

`exports.props` declara os campos do próprio script. O Studio extrai **só** o
literal desse objeto (nunca executa o script) e grava o schema normalizado no
`.meta` do asset (`settings.props`), então o inspetor mostra campos tipados em
vez de um JSON cru e o build mescla os defaults:

```js
exports.props = {
    velocidade: 60,                                     // number (atalho)
    modo: { type: 'enum', values: ['normal', 'duro'], default: 'normal', label: 'Modo' },
    cor: { type: 'color', default: '#38bcf8' },
    raio: { type: 'number', default: 8, min: 1, max: 32, hint: 'em pixels' }
};
```

Tipos: `number`, `int`, `bool`, `string`, `color`, `enum`, `json`. O valor do
componente vence o default declarado; um campo que não existe em
`exports.props` gera aviso `script.field` na validação. Scripts de TELA
(`settings.scripts`) também recebem os props em `this.fields`.

## Programas (`runtime: "app"`)

O Studio não é só editor de jogos. Com `runtime: "app"` cada cena vira uma
**tela** de um programa CelerOS comum, desenhada com o toolkit do sistema
(`UI.*` — o mesmo que Ajustes/Loja usam):

- **Sem dependência de engine**: o pacote não tem deps `celeros.game.*` nem
  `requires: ["psram"]`, então um programa também cabe na CYD (teto de 64 KB de
  JS).
- `app.data.js` no lugar de `game.data.js`; o `main.js` embute o runtime de
  telas (sem `E.init`, sem `E.run`).
- `transform.x/y` é o **canto superior esquerdo** do widget; `z` é a ordem de
  desenho.
- O cabeçalho (`UI.header`) ocupa `y = 0..40`: comece o conteúdo em `y >= 44`.
- `canvas.native` é recusado (o Kui é estritamente o espaço virtual 240x320).

```bash
node tools/sdk/celer.js studio init ~/Painel --app --name "Painel"
node tools/sdk/celer.js studio ~/Painel run --frames 0,900
```

### Estado da tela

`settings.data` é o estado inicial da tela. Widgets com `key`/`bind` leem e
escrevem nesse objeto plano; scripts mudam por `ctx.set`. Com
`settings.persist` (uma chave de Storage) o estado sobrevive a reboots — a
gravação é debounced (1 s) porque a NVS não pode levar escrita por quadro.

### Widgets

| Tipo | Campos |
|------|--------|
| `ui.text` | `text`, `bind` (chave do estado), `role` (`caption/body/title/display`), `color`, `align`, `w`, `lines`, `bg`, `id` |
| `ui.button` | `label`, `w`, `h`, `style` (`primary/ghost/danger`), `disabled`, `disabledBind`, `event`, `go` (tela), `id` |
| `ui.toggle` | `key`, `event`, `id` (44x24) |
| `ui.slider` | `key`, `w`, `min`, `max`, `step`, `event`, `id` |
| `ui.progress` | `value` ou `key` (0..100), `w`, `h` |
| `ui.list` | `items` (JSON) ou `itemsBind`, `key` (índice selecionado), `w`, `h`, `rowH`, `event`, `id` |
| `ui.tabs` | `labels` (JSON), `key`, `w`, `h`, `event` |
| `ui.card` | `w`, `h`, `radius`, `color`, `stroke` |
| `ui.image` | `asset` (PNG de quadro único), `w`, `h`, `key` — desenha com `System.drawPNG` (tamanho natural) |
| `ui.badge` | `text`/`bind`, `color`, `textColor` |
| `ui.spinner` | `r`, `color` |
| `ui.field` | `key`, `label`, `mask`, `hint` — abre `System.prompt` (bloqueante) e grava no estado |
| `ai.chat` | `provider`, `model`, `system`, `prompt`/`promptKey`, `trigger`, `outKey`, `busyKey`, `errorKey`, `history`/`histKey`, `attach` (`mic` manda a última gravação), `maxTokens` |
| `ai.speak` | `text`/`textKey`, `voice`, `trigger`, `busyKey` |
| `ai.vision` | `prompt`, `imageKey` (caminho), `trigger`, `outKey`, `errorKey` |
| `mic.record` | `key` (WAV em base64), `mode` (`hold`/`toggle`), `label`, `w`, `h`, `maxMs`, `event` |

O catálogo de componentes (`studio describe`) é a fonte da verdade dos defaults.

### Eventos e scripts de tela

`settings.scripts` é uma lista de GUIDs de script. O runtime de tela chama
`create/start/update(dt)/draw/event(nome, valor)/destroy` com um **ctx de tela**
(sem entidade):

```js
{ scene, app, st, get(k), set(k, v), go(tela, arg), back(), exit(),
  asset(slot), store{get,set,remove}, toast(msg), full, arg }
```

Widgets interativos despacham `event(nome, valor)` para os scripts de tela (e
para os scripts da entidade que disparou). `ui.button.go` navega sem script.
Widget sem `event` ainda atualiza o estado.

### Navegação

`ctx.go('Sobre')` empilha a tela atual; `ctx.back()` desempilha; voltar na raiz
**encerra o app** desenrolando o laço (não precisa de permissão `system`). O
cabeçalho desenha a seta de voltar sempre que a pilha não está vazia.

### Cards abrem um intervalo de fundo

`ui.card` não é um retângulo solto: ele **empilha a cor de fundo** usada pelos
widgets desenhados depois, então o redesenho parcial limpa o próprio retângulo
com a cor do card. O card fecha no próximo `ui.card` (ou no fim da tela).
Coloque os cards antes do conteúdo (z menor).

### Componentes de IA são dataflow

Sem callback em JSON: o script seta uma chave do estado (`st.pedir = true`) e o
componente dispara; a resposta cai em `outKey` e `event("ai:done")` avisa o
script. `ai.*` exige permissão `net`, `ai.vision` também `fs`, e `mic.record`
exige `mic` — a validação cobra isso. Sem o objeto no aparelho (ou sem a
permissão) o widget se esconde e o estado recebe o erro.

Para ver: `studio_apps/Painel` (painel do dispositivo) e
`studio_apps/Assistente` (chat por texto e voz).

## Copiloto de IA

O Studio traz um copiloto que transforma um pedido em um lote de ops. Ele
nunca escreve arquivo direto: o lote é validado por `applyOps` em **dry-run** e
só depois aplicado pelo mesmo barramento (então o undo funciona).

```bash
export OPENROUTER_API_KEY=...          # ou CELER_STUDIO_AI_KEY / DEEPSEEK_API_KEY
node tools/sdk/celer.js studio ~/Painel ai "adicione um cartao de temperatura na tela Painel"
node tools/sdk/celer.js studio ~/Painel ai "crie uma tela de ajustes" --dry-run
node tools/sdk/celer.js studio ~/Painel ai fix          # corrige validacao/build
node tools/sdk/celer.js studio ~/Painel ai explain "o que faz a tela Sobre"
node tools/sdk/celer.js studio ~/Painel ai "transforme este esboco em tela" --image esboco.png
```

Ambiente: `CELER_STUDIO_AI_PROVIDER` (`openrouter` padrão, `deepseek`,
`openai`), `CELER_STUDIO_AI_MODEL`, `CELER_STUDIO_AI_KEY` (fallback
`OPENROUTER_API_KEY`/`DEEPSEEK_API_KEY`/`OPENAI_API_KEY`) e
`CELER_STUDIO_AI_URL` para qualquer endpoint compatível com OpenAI. Nada fica
no repositório.

Se o lote não validar, o erro volta para o modelo e ele tenta de novo
(`--max-steps`, padrão 2). Guardrails: ops destrutivas
(`asset/scene/entity.delete`, `tilemap.remove`) e `asset.import` são bloqueadas
(`--allow-delete`/`--allow-import` para liberar), no máximo 40 ops por lote, e
a `rev` atual é enviada para detectar edição concorrente.

A GUI tem a aba **IA**: escreva o pedido, a resposta mostra as ops propostas e
a contagem de arquivos da prévia; **Aplicar** manda exatamente aquele lote,
**Descartar** joga fora. Também aceita imagem anexada (esboço/print) e 4 s de
voz (WAV, enviado como `input_audio`). Equivalente HTTP:
`POST /api/command {"cmd":"ai","prompt":"...","images":[],"audio":[],"apply":false}`
— dry-run por padrão; para aplicar, mande o mesmo lote em `/api/command`.

## Assets e limites

O importer é escolhido pela extensão por padrão:

```bash
node tools/sdk/celer.js studio ~/Jogo import heroi.png
node tools/sdk/celer.js studio ~/Jogo import atlas.png --importer tileset --grid 4x4 --tw 64 --th 64
node tools/sdk/celer.js studio ~/Jogo import bump.qoa --loop
node tools/sdk/celer.js studio ~/Jogo import heroi.js
```

PNGs são decodificados na importação para gravar `w/h`; a grade precisa caber
na imagem. A GUI importa por seleção/arrastar e edita o fatiamento (modo,
cols/rows, tamanho do tile, pivot, cor-chave) no inspetor do asset.

Limites de pacote impostos pelo build/validate (os mesmos do hub):

- 8 deps diretas; no máximo 16 extras no pacote (arquivo(s) de dados + scripts
  + assets não-JS; `app.json`, `main.js` e `icon.png` são livres);
- 128 KB por asset não-JS, 256 KB no total de assets não-JS;
- teto de JS enxuto: 64 KB sem PSRAM; 1 MB com `requires: ["psram"]`;
  256 KB por módulo; módulo acima de 30 KB exige `api >= 6`;
- nomes planos `[A-Za-z0-9._-]{1,64}`; sem subpastas no pacote.

O build copia só assets gráficos/áudio referenciados por alguma cena; todos os
scripts são copiados para que o `require` local entre eles funcione.

## Saída do build

```bash
node tools/sdk/celer.js studio ~/Jogo build
# .studio/build/br_autor_meujogo/
#   app.json          derivado do projeto
#   main.js           E.init + runtime do Studio embutido + boot
#   game.data.js      cenas/prefabs achatados + tabela de assets (divide em splitKB)
#   s.heroi.js        scripts do usuário (módulos locais, sem gastar dep)
#   atlas.png         assets planos usados pelas cenas
#   icon.png
```

O runtime (`tools/studio/templates/runtime.js`, ES5) é **embutido** no
`main.js`; ele não é uma dependência do hub, então o projeto não gasta um dos
8 slots de deps. Ele carrega os sheets de cada cena na entrada e libera na
saída, usa `E.dirty` com um painter que repinta as células de tilemap, desenha
tilemaps por camada, entidades por `z`, roda os scripts e segue a câmera da
cena.

Ele usa a linha atual da engine:

- sheets são registrados com **`E.spr.meta`** (grade, prefixo, âncora, anims,
  fps, loop, hitbox); imagens únicas usam `E.spr.load` + `E.spr.meta`;
- componentes `anim` com `meta` usam **`E.spr.animOf`**; scripts ganham
  **`entity.box()`** via `E.spr.box`;
- componentes `hud` usam **`E.anchor`** (`E.ax/ay`, `E.inset`), então entidades
  de HUD ficam nos 9 pontos sem conta de câmera;
- `editor.debug` liga `E.debug` e `editor.prof` liga `E.prof.on` (o overlay
  passa a mostrar os tempos `u`/`d`); o pool de sprites é contado pelo
  **`E.slots`**;
- música de cena começa com `System.playWav` na entrada.

Builds são determinísticos: assets/cenas ordenados, sem timestamp no pacote,
nomes gerados estáveis. `.studio/report.json` guarda tamanhos e avisos.

## Referência do CLI

`studio [DIR] <comando>`; `DIR` é o diretório atual por padrão e também pode
vir em `--dir`. `--json` torna todo comando legível por máquina; erros trazem
`{code, message, hint, diagnostics}` e saída 1.

| Comando | Significado |
|---------|-------------|
| `init [DIR]` | cria projeto + cena inicial (`--name`, `--pkg`, `--author`, `--description`) |
| `describe` | resumo do projeto, catálogo de componentes, ops, limites, assets/cenas |
| `schema [project\|scene\|prefab\|meta\|components]` | JSON Schema |
| `import ARQUIVO` | importa PNG/QOA/WAV/JS (`--importer`, `--grid CxR`, `--tw/--th`, `--prefix`, `--key`, `--pivot x,y`, `--loop`, `--gain`) |
| `import-game APP [DEST]` | cria um projeto **legado** editável a partir de um app existente (assets, scripts, metadados, main original) |
| `apply [ARQ\|-] [--op JSON]` | executa um lote de ops atomicamente (`--dry-run`, `--if-rev N`) |
| `validate` | schema, refs, limites de pacote, lint ES5 |
| `build` | grava o pacote plano do app |
| `run` | build + execução no harness do host (`--ms`, `--out`, `--frames 0,600`, `--seed`, `--input toques.txt`, `--no-build`) |
| `export DIR` | copia o build para uma pasta (`--force`) |
| `deploy [--out app.zip] [--no-build]` | valida/builda, enxuga JS e empacota os assets usados num `app.zip` determinístico |
| `undo` / `redo` | restaura o lote anterior / reaplica |
| `fmt` | reescreve todo JSON/meta de forma canônica |
| `serve` | abre a GUI (`--port`, 8421 por padrão; `--open`) |

### Ops

`apply` aceita um array, `{ops:[...]}` ou um único `{op:...}`:

```
project.set
scene.create/delete/rename/set/start
entity.create/set/delete/duplicate
component.add/set/remove
prefab.create/instance/override
asset.import/set/rename/delete
script.set
tilemap.add/set/paint/fill/remove
```

Ops de entidade/componente aceitam `scene` **ou** `prefab` como contêiner.
`entity.create` e `prefab.instance` aceitam `fid` explícito, então uma IA pode
montar um grafo num lote e referenciar os ids que escolheu. `asset.import`
aceita um caminho de origem; o upload da GUI grava um arquivo temporário e usa
a mesma op.

Exemplo (cria cena, herói e tilemap):

```json
[
  { "op": "scene.create", "name": "Fase 1" },
  { "op": "scene.start", "scene": "Fase 1" },
  { "op": "entity.create", "scene": "Fase 1", "fid": "e_hero", "name": "Heroi", "x": 80, "y": 120, "z": 5 },
  { "op": "component.add", "scene": "Fase 1", "entity": "e_hero", "type": "sprite",
    "fields": { "sprite": "GUID#0" } },
  { "op": "tilemap.add", "scene": "Fase 1", "tileset": "GUID",
    "cols": 15, "rows": 10, "cell": 32, "data": [0] }
]
```

Todo lote é atômico: um erro de validação restaura a árvore ao estado anterior
ao lote. O barramento faz snapshot dos arquivos tocados em `.studio/undo/` e
grava uma linha de auditoria em `.studio/journal.jsonl`.

## API HTTP

O servidor da GUI escuta em `127.0.0.1` (sem autenticação; é ferramenta local).

| Endpoint | Significado |
|----------|-------------|
| `GET /api/snapshot` | describe + cenas/prefabs completos + estado de build/play |
| `GET /api/state` | estado leve (describe, relatório de build, play) |
| `GET /api/events` | SSE: mudanças de arquivo e estado do play |
| `GET /api/assets?path=Assets/...` | serve um asset do projeto (path com jail) |
| `GET /api/run.png` | último screenshot headless |
| `POST /api/command` | `{ops:[...], dryRun, ifRev}` ou `{cmd:"build"\|"validate"\|"run"\|"play"\|"stop"\|"deploy"\|"undo"\|"redo"\|"fmt"\|"export"\|"describe"}` |
| `POST /api/upload?name=&importer=&grid=&cols=&rows=&tw=&th=` | bytes crus do arquivo; importa pela mesma op `asset.import` |

Toda resposta de comando inclui `snapshot`, então o cliente re-renderiza sem
uma segunda ida ao servidor. A GUI e o CLI usam o mesmo `lib/ops.js`; a suíte
de testes prova que produzem arquivos equivalentes.

## Tour da GUI

- **Hierarquia**: cena, entidades, instâncias de prefab e tilemaps; filtro por
  nome/fid; `+` cria entidade; o topo tem `+ cena`.
- **Projeto**: o botão `Projeto` (ou o nome) abre identidade, canvas, API,
  runtime, cena inicial, descrição/changelog, permissões, deps, psram e
  orçamento do pacote. `build`/`validar` ficam no próprio painel.
- **Viewport**: pan com botão do meio ou Espaço+arrastar, zoom na roda;
  grade/snap; coordenadas no canto; `Fit`. A entidade selecionada ganha
  gizmos **Mover/Girar/Escalar** (`W`/`E`/`R`), com handles X/Y, anel de
  rotação e cantos de escala. Setas movem; `Shift` amplia o passo; `Ctrl+D`
  duplica; `F` enquadra; `Delete` apaga.
- **Drag-and-drop**: arraste sprite/atlas/tileset para a cena e nasce uma
  entidade com componente sprite; arraste um prefab para instanciá-lo; solte
  um script numa entidade selecionada para anexá-lo.
- **Inspetor**: painel do projeto, cena (incluindo `settings.data`,
  `settings.assets`, música e câmera), entidade, tilemap e assets, gerado do
  schema. Também cria/instancia prefabs, mostra uso do asset e edita sólidos
  por tile do tileset. Clipes de animação do `.meta` têm preview com play/fps.
- **Assets**: filtro por nome/caminho, importar, thumbnails, duplo clique em
  cena/script; configurações de fatiamento, pivot, cor-chave, anims/hitbox;
  o preview desenha hitbox e âncora.
- **Pincel de tilemap**: selecione um tilemap, escolha um tile na paleta (ou a
  borracha) e clique/arraste no viewport; botão direito apaga. A paleta grava
  `data`; o checkbox "solido" também grava `solids`; o traço vira um único
  `tilemap.set` no pointer-up. Mudar cols/rows redimensiona preservando o
  canto superior esquerdo.
- **Build**: relatório do pacote + barras de extras/JS/assets/deps contra os
  tetos do ESP32; avisos de lint, arquivos gerados e screenshot do `run`.
- **Play**: gera o pacote e abre o emulador ao vivo num iframe.
- **Console/barra de comandos**: logs, diagnósticos e as mesmas ops JSON do
  CLI/API; atalhos `build`, `validate`, `run`, `play`, `stop`, `undo`, `redo`.

## Operação por IA

1. `studio describe --json` — descobre projeto, componentes, limites, assets e
   ops.
2. `studio schema components` — lê o catálogo de campos.
3. `studio apply --json -` — envia um lote com `fid`/`id` explícitos e `ifRev`
   para concorrência otimista.
4. `studio validate --json` / `studio build --json` / `studio run --json`.
5. Em erro, use o `code` estável (`schema.*`, `ref.*`, `asset.*`,
   `build.invalid`, `build.lint`, `rev.stale`, `undo.empty`) e o `hint`.

O mesmo contrato existe via HTTP (`POST /api/command`), então uma IA pode
dirigir uma sessão viva do editor enquanto um humano acompanha o viewport.

## Deploy / app.zip

O `deploy` é a "compilação" do Studio: valida e builda, passa todo `.js` pelo
mesmo `jsstrip` + `jsmin` do hub (sem comentários/indentação, nomes locais
encurtados, quebras mantidas), mantém só os assets escolhidos pelo build, compacta o
`app.json` e grava um ZIP determinístico com `app.json` na raiz (o layout
aceito pelo `celerctl apps installzip`). O ZIP também leva o `deps.json` com
o fecho resolvido de `celeros.game.*`: o `require` do device só cai para
`/local/modules` com esse arquivo na pasta do app, e o `installzip` nativo
instala exatamente o que está no pacote. A Loja pode regravar o lock com o
índice do hub, mas um pacote instalado direto já sai completo.

```bash
# padrão: <projeto>/.studio/deploy/app.zip + report.json
node tools/sdk/celer.js studio ~/Jogo deploy

# destino customizado e GUI: aba Build -> "Compilar app.zip"
node tools/sdk/celer.js studio ~/Jogo deploy --out dist/MeuJogo.zip

# bancada: instala o zip e roda no device
python3 tools/celerctl.py apps installzip ~/Jogo/.studio/deploy/app.zip --run
```

O comando imprime e grava em `report.json`: bytes do ZIP, SHA-256, JS
antes/depois, bytes de assets, fecho das deps, lista de entradas, extras e
avisos do build.
O timestamp é fixo (1980-01-01) e as entradas são ordenadas, então as mesmas
fontes/build geram os mesmos bytes. `--no-build` reutiliza um build existente.
Os assets são filtrados pelo build, copiados sem perda e comprimidos no ZIP
(sem recodificar imagem). OTA atualiza firmware, não apps.

## Limitações (v1)

- O preview do host é Node + stubs do firmware, não Duktape no ESP32: ES5 é
  garantido pelo `app_lint`, mas timing/memória/áudio/rede pertencem à bancada.
- O emulador modela o canvas virtual 240x320 e o nativo 480x480; layouts de
  CYD/watch/dog não são emulados.
- Flip de sprite não é recurso da engine; animação direcional usa frames ou
  regiões separadas.
- Fidelidade de runtime: o runner gerado desenha sprites com `sx/sy`
  (escala por eixo) e `rot` (giro em graus, em volta da âncora) — desde o
  `celeros.game.spr` 1.7, que expõe `{angle, scaleX, scaleY}`. Região de
  folha ainda não gira (limite do `drawSprite` nativo: sem recorte de origem);
  texto/forma usam os próprios componentes. Colisores expostos a scripts são
  alinhados aos eixos.
- O pacote só leva assets gráficos/áudio referenciados por componente,
  tilemap ou música de cena. Um asset usado só dentro de um script precisa
  também aparecer num componente (mesmo inativo) para o build empacotá-lo.
- Aninhamento de prefab é achatado no build; a hierarquia do editor é
  organizacional (transforms absolutos, sem herança em runtime). O módulo
  `celeros.game.scene` da engine fica disponível para scripts quando o projeto
  o declara, mas o runtime gerado do Studio não o exige (prefabs são
  achatados, o comportamento é do runner do Studio).
- A GUI tem pincel de tilemap, sólidos por tile, preview de clipe de animação,
  criação/instância de prefab e configurações do projeto. Um fatiador visual de
  atlas (arrastar regiões arbitrárias) e uma view dedicada de edição de prefab
  ainda são os próximos passos; até lá use lotes de
  `asset.set`/`component.set`/ops.
- Os quatro projetos em `studio_games/` são nativos: cenas, tilemaps e
  entidades alimentam o runtime. A bridge legada é opcional e só vale para
  projetos criados com `import-game`. Transições visuais ainda não são
  emitidas pelo runner nativo (o controlador pode desenhar o próprio fade).
- Gameplay dinâmico (tiros, inimigos nascem, corpos de física) fica no script
  controlador/pool; o runtime não tem chamada de spawn de prefab.
- `music` de uma cena começa com `System.playWav` na entrada (uma vez); a v1
  não tem mixer/loop de runtime. `loop` e `gain` do importer de áudio ficam
  gravados no `.meta` para ferramentas, mas ainda não são aplicados.
- Movimento de câmera em tilemap repinta as células expostas; mapas enormes
  devem usar câmera estática ou fundo assado (baked).

## Testes

```bash
node test/studio/run.js
```

Cobre round-trip de JSON canônico, unicidade de GUIDs, import/grade de assets,
os metadados do spr 1.6 (`anims`/fps/loop/hitbox), `tilemap.set`/resize (commit
do pincel), lotes atômicos/dry-run/undo/redo, builds determinísticos, o app
gerado no harness do host (`E.spr.meta`/`animOf`/`box`, pixels do HUD ancorado,
frames diferentes quando um script move uma entidade), achatamento de prefab e
equivalência CLI x HTTP, a API de cena nativa (`settings.data`/`settings.assets`,
componente `data`, arg do `ctx.go`, `find`/`tm`/`solidAt`/`rectSolid`, sólidos
por tile e colisão após `map.set`), build+execução headless dos quatro jogos
de `studio_games/`, e a bridge legada (import-game, captura do E.run original,
troca de cena via E.goto, bases de asset do pacote). O CI roda antes da matriz
de firmware.
