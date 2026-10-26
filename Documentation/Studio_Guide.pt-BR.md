# Celer Studio — editor de jogos para a CelerGame

O Celer Studio é um editor no estilo Unity para a CelerGame, a engine ES5 que
viaja como dependências `celeros.game.*`. Ele é **file-first**: projeto, cenas,
prefabs e metadados de assets são JSON no disco, e toda ação é um comando JSON
num único barramento usado pela GUI, pelo CLI e pela API HTTP. Uma IA consegue
fazer um jogo inteiro sem abrir o navegador.

- Local: `tools/studio/` (comando do SDK `node tools/sdk/celer.js studio ...`)
- GUI: app web local servido por Node (sem build, sem dependências npm)
- Saída: pacote de app CelerOS plano (ES5, pronto para `celerctl`/hub)

## Início rápido

```bash
# 1. cria um projeto (com uma cena inicial)
node tools/sdk/celer.js studio init ~/Jogo --name "Meu Jogo"

# 2. abre o editor (hierarquia, inspetor, viewport, play)
node tools/sdk/celer.js studio ~/Jogo serve --open

# 3. ou opera headless
node tools/sdk/celer.js studio ~/Jogo describe --json
node tools/sdk/celer.js studio ~/Jogo validate
node tools/sdk/celer.js studio ~/Jogo build
node tools/sdk/celer.js studio ~/Jogo run --ms 1200 --out tela.png
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

## Remontando jogos existentes (modo legado)

`studio import-game` cria um projeto editável a partir de um app existente:

```bash
node tools/sdk/celer.js studio import-game hub_apps/Detona studio_games/Detona
node tools/sdk/celer.js studio "studio_games/Detona" serve --open
node tools/sdk/celer.js studio "studio_games/Detona" run --frames 0,1200
```

O importador copia PNG/QOA/WAV da raiz para `Assets/Sprites|Audio` (os atlas
conhecidos já fatiados: `ai_atlas` 4x4x64, `tileset` 8x3x32 e as folhas da
Lenda), copia os `.js` da raiz para `Assets/Scripts` com o nome original e
importa os metadados do app (`packageName`, `version`, `api`, `deps`,
`permissions`, `requires`). Ele grava:

```json
"runtime": "legacy",
"legacy": { "entry": "main.js", "name": "Detona",
            "bases": ["/local/apps/Detona/", "/sd/apps/Detona/"] }
```

Um build legado copia scripts/assets planos com os nomes originais, renomeia
o entry original para `legacy.main.js` e gera um `main.js` que chama a
**bridge legada** (`tools/studio/templates/legacy.js`). A bridge captura a
tabela de cenas do `E.run` original, roda dentro do `E.run` do Studio e
redireciona `E.goto`/`push`/`pop`; input, módulos, timers, tweens, câmera,
áudio e camada suja continuam sendo da engine. O app original chama `E.init`
normalmente; a bridge coloca os caminhos do pacote na frente dos assets.

Edições de assets e scripts no projeto são as que embarcam. A cena do painel é
um **cartão**: o runtime legado ainda não consome entidades/tilemaps/prefabs do
Studio. Transições visuais (fade/wipe/iris) são puladas nesta primeira versão;
o comportamento de cenas `static` (menus) é preservado.

O repo traz os quatro jogos maiores como projetos legados:

| Projeto | Original | Versão | Extras | JS | Assets |
|---------|----------|--------|--------|----|--------|
| `studio_games/Detona` | `hub_apps/Detona` | 0.10.2 | 6 | 104,7 KB | 130,5 KB |
| `studio_games/Arrasa` | `hub_apps/Arrasa` | 1.3.2 | 15 | 65,2 KB | 176,8 KB |
| `studio_games/Lenda de Celer` | `hub_apps/Lenda de Celer` | 1.0.4 | 13 | 54,4 KB | 205,3 KB |
| `studio_games/Supernova` | `hub_apps/Supernova` | 2.6.2 | 4 | 42,3 KB | 131,9 KB |

Os quatro abrem, compilam e jogam no Studio (títulos e gameplay). Use
`run --input toques.txt` para navegar menus, ex.: `200 tap 240,270`.

Próximo passo da remontagem: importar levels/salas/fases para cenas, tilemaps e
prefabs do Studio, adaptar o script do jogo para lê-los e remover
`runtime: "legacy"` quando a cena nativa estiver completa em comportamento.

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
- teto de JS enxuto: 48 KB sem PSRAM; 1 MB com `requires: ["psram"]`;
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
| `POST /api/command` | `{ops:[...], dryRun, ifRev}` ou `{cmd:"build"\|"validate"\|"run"\|"play"\|"stop"\|"undo"\|"redo"\|"fmt"\|"export"\|"describe"}` |
| `POST /api/upload?name=&importer=&grid=&cols=&rows=&tw=&th=` | bytes crus do arquivo; importa pela mesma op `asset.import` |

Toda resposta de comando inclui `snapshot`, então o cliente re-renderiza sem
uma segunda ida ao servidor. A GUI e o CLI usam o mesmo `lib/ops.js`; a suíte
de testes prova que produzem arquivos equivalentes.

## Tour da GUI

- **Hierarquia**: cena, entidades, instâncias de prefab (com badge) e tilemaps.
- **Viewport**: pan com botão do meio ou Espaço+arrastar, zoom na roda,
  arrastar entidades com snap; grade, bounds da câmera, colisores e filhos de
  prefab são desenhados. `Fit` enquadra a cena.
- **Inspetor**: gerado do schema de componentes. Transform, componentes,
  configurações da cena, câmera, tilemaps e importers de asset são editáveis.
  Campos JSON são validados ao sair.
- **Assets**: arraste arquivos para o painel (ou use Importar), thumbnails,
  duplo clique numa cena abre, num script edita. As configurações do importer
  (fatiamento, pivot, cor-chave, `anims`/`fps`/`loop`, hitbox) ficam no
  inspetor; o preview desenha a hitbox e a âncora do sprite.
- **Pincel de tilemap**: selecione um tilemap, escolha um tile na paleta (ou a
  borracha) e clique/arraste no viewport; botão direito apaga. A paleta grava
  `data`; o checkbox "solido" também grava `solids`; o traço vira um único
  `tilemap.set` no pointer-up. Mudar cols/rows redimensiona preservando o
  canto superior esquerdo.
- **Play**: gera o pacote e abre o emulador ao vivo num iframe
  (pause/passo/reiniciar/gravar/screenshot são os controles do próprio
  emulador).
- **Console**: logs do harness, diagnósticos de build, erros de lint,
  resultados de comando.
- **Barra de comandos**: aceita as mesmas ops JSON ou `build`, `validate`,
  `run`, `play`, `stop`, `undo`, `redo`, `fmt`. É o caminho mais rápido para um
  humano ou uma IA agir sem clicar.

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

## Deploy

```bash
# copia o pacote plano para uma pasta de app do hub (ou staging)
node tools/sdk/celer.js studio ~/Jogo export hub_apps/MeuJogo --force

# bancada: instala + roda no device
python3 tools/celerctl.py apps install hub_apps/MeuJogo --deps-local --run

# publica (suba version + changelog no celergame.project.json antes,
# depois build/export e celerhub)
node tools/sdk/celer.js publish hub_apps/MeuJogo
```

OTA atualiza só o firmware; o pacote do app continua indo pela loja ou pelo
`celerctl`.

## Limitações (v1)

- O preview do host é Node + stubs do firmware, não Duktape no ESP32: ES5 é
  garantido pelo `app_lint`, mas timing/memória/áudio/rede pertencem à bancada.
- O emulador modela o canvas virtual 240x320 e o nativo 480x480; layouts de
  CYD/watch/dog não são emulados.
- Flip de sprite não é recurso da engine; animação direcional usa frames ou
  regiões separadas.
- Fidelidade de runtime: o runner gerado desenha sprites com
  `scale = transform.sx` e **sem rotação**; `rot` e `sy` não uniforme são só
  preview do editor (texto/forma usam os próprios componentes). Colisores
  expostos a scripts são alinhados aos eixos.
- O pacote só leva assets gráficos/áudio referenciados por componente,
  tilemap ou música de cena. Um asset usado só dentro de um script precisa
  também aparecer num componente (mesmo inativo) para o build empacotá-lo.
- Aninhamento de prefab é achatado no build; a hierarquia do editor é
  organizacional (transforms absolutos, sem herança em runtime). O módulo
  `celeros.game.scene` da engine fica disponível para scripts quando o projeto
  o declara, mas o runtime gerado do Studio não o exige (prefabs são
  achatados, o comportamento é do runner do Studio).
- O pincel de tilemap está na GUI; um fatiador visual de atlas (arrastar
  regiões), uma timeline de animação e uma view dedicada de edição de prefab
  ainda são fase 6 (até lá use lotes de `asset.set`/`component.set`/ops).
- Projetos legados rodam o código original: edições de cena/tilemap/prefab
  ainda não afetam o runtime, e transições visuais são puladas. Os quatro
  projetos em `studio_games/` são a primeira remontagem, não um port nativo.
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
equivalência CLI x HTTP, e a bridge legada (import-game, captura do E.run
original, troca de cena via E.goto, bases de asset do pacote). O CI roda antes
da matriz de firmware.
