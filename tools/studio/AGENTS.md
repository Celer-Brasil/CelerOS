# tools/studio/ - Celer Studio (editor de jogos da CelerGame)

## OVERVIEW
Editor estilo Unity, file-first: `celergame.project.json` + `Assets/**` +
`*.scene.json` + `*.prefab.json` + sidecars `.meta` sao a fonte da verdade.
GUI web, CLI e API HTTP executam o MESMO barramento (`lib/ops.js`). O build
gera um pacote de app CelerOS plano (ES5) com o runtime embutido, sem dep nova.
Docs: `Documentation/Studio_Guide.md` (EN) e `.pt-BR.md` (manter em sincronia).

## FILE MAP
| Arquivo | Papel |
|---------|-------|
| `studio.js` | CLI (`celer.js studio`) e `describeData` |
| `server.js` | GUI + API HTTP (`/api/command`, `/api/upload`, SSE) em 127.0.0.1 |
| `lib/format.js` | JSON canonico, GUIDs, fids, nomes seguros, cores 565 |
| `lib/schema.js` | validacao estrutural + catalogo de componentes |
| `lib/project.js` | carrega/indexa projeto, cenas, prefabs, metas, assets |
| `lib/assets.js` | import PNG/QOA/WAV/JS, meta, fatiamento, script template |
| `lib/ops.js` | barramento de ops, lote atomico, undo/redo, journal |
| `lib/validate.js` | schema/refs + limites de pacote + lint ES5 |
| `lib/build.js` | codegen determinista: main/data/scripts/assets/app.json/deps.json; tilemap leva `solidValues` |
| `lib/deps.js` | fecho de deps de `tools/sdk/engine` (index.json + literal `version:`) -> lock `{nome: versao}` |
| `lib/zip.js` | ZIP deterministico (deflate 9, CRC32, timestamp fixo) + leitor de verificacao |
| `lib/deploy.js` | compilacao de deploy: build + jsstrip + assets usados -> app.zip/report |
| `lib/run.js` | executa o build no harness do host (PNG/frames/input) |
| `lib/import_game.js` | import-game: app existente -> projeto legado (assets/metas/scripts) |
| `lib/live.js` | filho do Play (emulador ao vivo) |
| `templates/runtime.js` | runtime de cenas ES5 (API de cena/`settings.data`/`ctx.go`), concatenado no main.js |
| `templates/legacy.js` | bridge do modo legado: captura E.run, redireciona goto/push/pop |
| `schema/*.json` | JSON Schemas + catalogo de componentes (fonte de tudo) |
| `ui/` | GUI sem build (index/style/app.js) |

## INVARIANTES
- **Arquivo manda**: nada de estado escondido. `.studio/` e cache (build,
  undo/redo, run, layout) e fica gitignored no projeto.
- **GUID estavel** por asset/cena/prefab; `fid` por entidade; componente por
  `id`. Renomear arquivo nao muda GUID; refs de cena sao por GUID.
- **Serializacao canonica** (ordem do schema, LF, 2 espacos, newline final,
  `rev` incrementado). `studio fmt` normaliza tudo.
- **Um barramento**: toda mutacao e uma op em `applyOps`; GUI/CLI/HTTP nao
  tem caminho paralelo. Lote e atomico (erro restaura o snapshot).
- **Build deterministico**: mesma fonte => mesmos bytes; sem timestamps no
  pacote; assets/cenas ordenados.
- **Device**: JS ES5 (Duktape), pacote flat, 8 deps, 16 extras, 128 KB/asset,
  256 KB de assets, 1 MB JS com PSRAM (48 KB sem), 256 KB/modulo.
- **Prefab e achatado no build**; o runtime nunca resolve prefab.
- **Nada de `#ifdef` de placa** e nada de dep nova no hub para o runtime.
- **Engine atual**: o runtime usa `E.spr.meta`/`animOf`/`box` (spr 1.6+),
  `E.anchor`/`E.ax/ay` e `E.prof` (core 1.5+) quando presentes (feature
  detect); o projeto gerado declara as versoes locais do engine (hoje
  core ^1.6.0, spr ^1.7.0). Pivot do asset vira `ax/ay` do metadado;
  transform sem `ax/ay` herda.

## INTEGRACAO COM A ENGINE (o que ja e usado)
| Recurso | Onde o Studio usa |
|---------|-------------------|
| `E.spr.meta` / `animOf` / `box` | build grava `anims/fps/loop/hitbox/pivot`; runtime registra sheet+meta; componente `anim.meta` usa `animOf`; `entity.box()` usa `box` |
| `E.ax/ay/anchor`, `E.inset` | componente `hud` (ancora 0..8) no runtime e no viewport; preview de `canvas.inset` |
| `E.prof`, `E.debug` | `editor.prof`/`editor.debug` viram `E.prof.on`/`E.debug` no main gerado |
| `E.slots` | automatico no spr; nenhum codigo do Studio mexe em `_used` |
| `celeros.game.scene` | opcional para scripts (o projeto pode declarar); o runner do Studio ainda achata prefabs e nao o exige |

## PROJETOS NATIVOS (`studio_games`)
- Os 4 jogos maiores sao projetos **nativos**: `Detona` (1.0.0, 9 cenas),
  `Arrasa` (2.0.0, 13), `Lenda de Celer` (2.0.0, 23) e `Supernova` (3.0.0, 5);
  ver `studio_games/README.md`. As cenas/tilemaps/entidades sao a fonte do
  runtime; os controladores vivem em `Assets/Scripts/*.js`.
- **API de cena**: `settings.data` (JSON da cena), `settings.assets` (assets
  carregados para scripts), componente `data` (`entity.data`). O `ctx` do
  script tem `E/scene/entity/assets/arg/save/data`, `ctx.asset(n)` e
  `ctx.go(titulo, arg)`; a cena tem `find/tm/solidAt/rectSolid/asset`,
  `entities/tilemaps/title/data/arg`. `start()` roda depois de entidades e
  tilemaps.
- **Colisao de tilemap**: `tiles[i].solid` no `.meta` do tileset -> build grava
  `solidValues`; `map.solidAt()` segue o valor ATUAL da celula, entao
  `map.set(c,r,0)` abre caixa/parede na hora. Sem flags, cai na grade `solids`
  da cena.
- **Dinamico fica no controlador**: spawnar inimigo/tiro/corpo de fisica nao e
  uma op/prefab do runtime; e pool/entidade do script. O runtime achata
  prefabs e nao tem spawn em runtime.
- **Teste**: `test/studio/run.js` builda e roda os 4 projetos (frames 0/220)
  alem da suite generica.

## MODO LEGADO (bridge opcional)
- `studio import-game <app> <projeto>` copia assets/metas/scripts com os nomes
  originais, importa o app.json e grava `runtime: "legacy"` + `legacy.entry`.
- `build` legado: copia tudo flat, renomeia o entry para `legacy.main.js`,
  gera `main.js` com `templates/legacy.js` embutido. Sem `game.data.js`.
- A bridge captura o `E.run` original, roda a tabela de cenas dentro do
  `E.run` do Studio e redireciona `E.goto/push/pop/depth`; input, modulos,
  timers, tweens, camera, audio e dirty layer seguem do loop externo.
  Transicoes visuais sao ignoradas; `static` e preservado via
  `wrapper.static`.
- `E.init` e `E.spr.bases` sao interceptados para os caminhos do pacote
  (`/local/apps/<pkg>/`, `/sd/...`) entrarem antes dos bases do app.
- A cena do Studio e um CARTAO: edicoes de entidade/tilemap/prefab NAO afetam
  o runtime legado. Assets/scripts sim. Use a bridge so para um app ainda nao
  portado; os quatro `studio_games/` ja sao nativos.

## COMO ESTENDER
### Componente novo
1. `schema/components.json`: `label` + `fields` (tipo/default/required).
2. `lib/build.js` `convertComponent`: converte a fonte para o formato de
   runtime.
3. `templates/runtime.js`: carregar no `enter`, atualizar em `update` e
   desenhar em `draw` (se necessario).
4. A GUI pega o inspetor do schema automaticamente; ajuste `ui/app.js` so se
   precisar de um widget novo (ex.: sprite ref).
5. `test/studio/run.js`: crie/edite um caso cobrindo o componente.
6. Docs EN + pt-BR (tabela de componentes e API de cena).

### Op nova
1. `lib/ops.js` (tabela `OPS`) + `OPS_HELP` em `studio.js`.
2. Valide referencias/limites em `lib/validate.js` quando aplicavel.
3. Teste de lote (incluindo falha atomica quando fizer sentido).
4. Documente no `Studio_Guide` (EN + pt-BR).
5. Se a GUI precisa expor, adicione em `ui/app.js`.

### Importer/asset novo
1. `lib/assets.js` (`EXT_KIND`, `KIND_DIR`, settings iniciais).
2. `schema/meta.schema.json` + `lib/schema.js` (validacao).
3. `lib/build.js` (tabela de assets do runtime) e `lib/validate.js` (limites).
4. Docs e testes.

## GUI (ui/app.js)
- Hierarquia (cena/entidades/prefabs/tilemaps) com filtro; `+ cena` no topo,
  `+` entidade no painel; inspetor dirigido pelo schema; viewport
  (pan/zoom/grid/snap/arraste/coordenadas); assets com filtro; console; abas
  Cena/Jogo/Build; barra de comandos; Play em iframe.
- Painel **Projeto** (`Projeto`/nome): identidade, canvas/API/runtime, cena
  inicial, descricao/changelog, permissoes, deps, psram, build.splitKB e
  resumo do pacote. E o mesmo `project.set` do CLI/API.
- Cena: `settings.data`, `settings.assets` e `settings.music` editaveis (JSON
  validado); `scene.set` aceita `replace` para trocar `data`/`assets` sem
  mesclar chaves antigas.
- Gizmos 2D no viewport: Mover/Girar/Escalar (`W`/`E`/`R`), handles X/Y, anel e
  cantos; setas movem, Shift amplia, Ctrl+D duplica, F enquadra, Delete apaga.
  Drag-and-drop de sprite/atlas/tileset/prefab/script para a cena.
- Pincel de tilemap: paleta de regioes, borracha, checkbox solido; commit
  unico em `tilemap.set`; cols/rows preservam o canto. O asset tileset tem
  solido por tile (`tiles[i].solid`) e o runtime usa `solidValues`.
- Inspetor de asset: modo/grade/pivot/cor-chave, `anims`/`fps`/`loop`, hitbox,
  uso em cenas/prefabs, preview de clipe com play/fps; viewport desenha hitbox
  e ancora; entidades `hud` aparecem ancoradas com `canvas.inset`.
- Build: relatorio + barras extras/JS/assets/deps contra os tetos;
  `Compilar app.zip` gera/baixa o pacote enxuto; diagnostico `E.debug`/`E.prof`
  no painel do projeto/cena.

## CONTRATO DE IA
- `studio describe --json` descobre projeto, componentes, ops, limites e
  assets; `studio schema components` da os campos.
- `apply` aceita `[ops]`, `{ops:[...]}` ou `{op:...}`; aceita `--dry-run` e
  `--if-rev`. `entity.create`/`prefab.instance` aceitam `fid` explicito.
- Erros tem `code` estavel (`schema.*`, `ref.*`, `asset.*`, `build.invalid`,
  `build.lint`, `rev.stale`, `undo.empty`) + `hint` + `diagnostics`.
- HTTP: `POST /api/command` (mesmas ops), `GET /api/snapshot`, SSE
  `/api/events`; toda resposta de comando traz `snapshot`.
- A GUI tem barra de comandos que aceita as mesmas ops JSON.

## BUILD/LIMITES (resumo)
- Saida: `.studio/build/<slug(packageName)>/` (`main.js` com runtime inline,
  `game.data.js`/partes, `s.<slug>.js`, assets planos, `app.json`, `icon.png`,
  `deps.json` quando o projeto declara deps).
- Extras = partes de data + scripts + assets + `deps.json` quando ha deps
  (main/app.json/icon sao livres; o lock e escrito depois do lint, mas conta
  no teto porque o hub tambem o conta).
- `deps.json` e o FECHO resolvido na arvore local (`tilemap` -> `celeros.game`,
  etc.), nao so as deps diretas: o require do device le esse mapa ate 32
  modulos e sem ele so procura o `.js` dentro da pasta do app.
- Todo `require("x")` do main gerado precisa estar na pasta ou no lock; o
  deploy falha com `deploy.deps` em vez de gerar um zip que crasha no device.
- So assets referenciados por cenas entram; todos os scripts entram.
- Metadados de arte vao no `game.data` (nao em .json lido em runtime): o app
  nao precisa de permissao `fs` para `E.spr.meta`/`E.scene`.
- `app_lint` roda no pacote final e bloqueia o build em erro.
- `deploy` gera `.studio/deploy/app.zip` (ou `--out`) depois de enxugar todo
  `.js` com jsstrip, compactar `app.json`, incluir so assets do build e
  regravar o `deps.json`; `report.json` tem bytes antes/depois, assets, lock,
  SHA-256 e entradas. ZIP deterministico (timestamp fixo, ordenado, deflate 9)
  e compativel com `celerctl apps installzip` (app.json na raiz). O
  `installzip` nativo e dep-cego: o lock DENTRO do zip e o que evita o
  `require: modulo nao encontrado` no primeiro boot.
- `run` usa `microsBias:1` no runner do host (ver "QUIRK" abaixo).

## QUIRK DO HOST (pacing da engine)
O pacing atual da engine compara `left` com `frameUs` em microssegundos; no
harness o relogio e virtual e a comparacao exata pode cair 1 ulp acima em TODO
quadro, entao `System.delay` nunca e chamado (loop a 100% CPU, sem frames).
`tools/sdk/lib/runner.js` aceita `microsBias` (ou env `CELER_MICROS_BIAS`):
avanca `micros()` 1 us por chamada, o que faz o delay acontecer. O Studio
sempre liga (run e preview). Nao edite `celeros.game.js` para "consertar" isso
sem alinhar com o dono do arquivo: e trabalho em voo.

## TESTES
- `node test/studio/run.js` (CI): formato canonico, import, metadata do spr
  1.6, tilemap.set/resize, ops/dry-run/undo, build determinista, app gerado no
  harness (spr.meta/animOf/box + HUD ancorado), cena nativa (`settings.data`,
  `data`, `ctx.go` com arg, solidos por tile), prefab achatado, CLI x HTTP,
  build+run dos 4 jogos de `studio_games/`, deploy/app.zip deterministico
  (com deps.json cobrindo todo require compartilhado) e a bridge legada.
- `node tools/sdk/celer.js check` cobre drift de types/renderer/deps.
- Preview: `serve --open`; headless: `run --frames 0,600`.

## ANTI-PATTERNS
- Editar `.studio/build/**` ou `game.data.js`/`main.js` gerados a mao.
- Referenciar asset por nome em arquivos de cena (use GUID; nome so e atalho
  no CLI).
- Colocar subpasta em `Assets/` esperando que ela va para o pacote (o build e
  flat; subpastas sao so organizacao de fonte).
- Usar ES6 nos scripts (Duktape).
- Esquecer `studio fmt` depois de editar JSON a mao (o build tolera, mas o
  diff fica sujo).
- Editar a cena de um projeto `runtime: "legacy"` esperando mudar o jogo: o
  runtime legado usa o main/scripts originais, nao a cena. Os 4 jogos de
  `studio_games/` ja sao nativos; a bridge so serve para um app nao portado.
