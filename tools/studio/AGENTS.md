# tools/studio/ - Celer Studio (editor de jogos E programas do CelerOS)

## OVERVIEW
Editor estilo Unity, file-first: `celergame.project.json` + `Assets/**` +
`*.scene.json` + `*.prefab.json` + sidecars `.meta` sao a fonte da verdade.
GUI web, CLI, API HTTP e copiloto de IA executam o MESMO barramento
(`lib/ops.js`). O build gera um pacote de app CelerOS plano (ES5) com o
runtime embutido, sem dep nova.

Dois runtimes, mesmo formato de arquivo:
- `runtime: "studio"` (jogo): cenas/tilemaps/entidades sobre a CelerGame;
  runtime `templates/runtime.js`, data `game.data.js`, 3 deps de engine.
- `runtime: "app"` (programa): cada cena e uma TELA com widgets `UI.*` (Kui);
  runtime `templates/app_runtime.js`, data `app.data.js`, ZERO deps de engine
  (roda na CYD, sem psram).
- `runtime: "legacy"`: bridge para app nao portado (modo historico).

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
| `lib/deploy.js` | compilacao de deploy: build + jsstrip/jsmin + assets usados -> app.zip/report |
| `lib/run.js` | executa o build no harness do host (PNG/frames/input) |
| `lib/import_game.js` | import-game: app existente -> projeto legado (assets/metas/scripts) |
| `lib/scripts.js` | props tipados: extrai `exports.props` (so o literal), defaults e merge |
| `lib/ai.js` | copiloto: contexto do projeto, prompt, parser do plano, guardrails, plan/fix/explain |
| `lib/live.js` | filho do Play (emulador ao vivo) |
| `templates/runtime.js` | runtime de cenas ES5 (API de cena/`settings.data`/`ctx.go`), concatenado no main.js |
| `templates/app_runtime.js` | runtime de TELAS ES5 (Kui, estado, eventos, IA), concatenado no main.js do modo app |
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
- **Um barramento**: toda mutacao e uma op em `applyOps`; GUI/CLI/HTTP/copiloto
  nao tem caminho paralelo. Lote e atomico (erro restaura o snapshot).
- **Build deterministico**: mesma fonte => mesmos bytes; sem timestamps no
  pacote; assets/cenas ordenados.
- **Device**: JS ES5 (Duktape), pacote flat, 8 deps, 16 extras, 128 KB/asset,
  256 KB de assets, 1 MB JS com PSRAM (48 KB sem), 256 KB/modulo.
- **Prefab e achatado no build**; o runtime nunca resolve prefab.
- **Nada de `#ifdef` de placa** e nada de dep nova no hub para o runtime.
- **Componente pertence a um modo** (`runtime` no catalogo: game/app/any):
  `ui.*`/`ai.*`/`mic.record` so em `runtime:"app"`; `sprite`/`anim`/`text`/
  `shape`/`collider`/`hud` so em `runtime:"studio"`. `transform`/`script`/`data`
  valem nos dois. A validacao recusa o componente do modo errado.
- **Modo app nao toca na engine**: `main.js` nao tem `require`, `app.json` sem
  `deps`/`psram` forcados, `canvas.native` proibido (Kui e 240x320 virtual).
- **Engine atual**: o runtime de jogo usa `E.spr.meta`/`animOf`/`box` (spr
  1.6+), `E.anchor`/`E.ax/ay` e `E.prof` (core 1.5+) quando presentes (feature
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

## MODO PROGRAMA (`runtime: "app"`)
- Cada `*.scene.json` e uma TELA; cada entidade e um widget com `transform.x/y`
  = canto superior esquerdo e `z` = ordem de desenho. `UI.header` ocupa y=0..40.
- **Estado**: `settings.data` e o estado inicial; widgets com `key`/`bind`
  leem/escrevem nele; script de tela muda por `ctx.set`. `settings.persist`
  (chave de Storage) grava debounced (1 s) e no `exit`.
- **Eventos**: widget com `event` despacha `event(nome, valor, ctx)` para
  `settings.scripts` (scripts de TELA) e para os scripts da entidade que
  disparou. `ui.button.go` navega sem script.
- **Pilha de telas**: `ctx.go/back`; voltar na raiz desenrola o laco e encerra
  o app (sem permissao `system`).
- **Card = intervalo de fundo**: `ui.card` empilha a cor de fundo (fecha no
  proximo card ou no fim da tela) para o redesenho parcial dos widgets
  limpar o proprio retangulo com a cor certa. Card antes do conteudo.
- **Widgets customizados** (`ui.field`, `mic.record`) rodam na SEGUNDA passada
  porque dependem de `UI.touch()` saber se um widget nativo ja consumiu o toque.
- **IA e dataflow**: o script seta `st[trigger] = true`; o componente
  `ai.chat/speak/vision` dispara, grava em `outKey` e emite `event("ai:done")`.
  `mic.record` grava WAV base64 em `key` (hold ou toggle).
- **Permissoes cobradas pela validacao**: `ai.*` -> `net`, `ai.vision` -> `fs`,
  `mic.record` -> `mic`, `ui.image`/musica de tela -> `fs`.
- Exemplos versionados: `studio_apps/Painel` e `studio_apps/Assistente`
  (ver `studio_apps/README.md`). Viram teste no `test/studio`.

## COMO ESTENDER
### Componente novo
1. `schema/components.json`: `label` + `runtime` (game/app/any) + `fields`
   (tipo/default/required).
2. `lib/build.js` `convertComponent`: converte a fonte para o formato de
   runtime (`{t:'ui',k:'...'}` no modo app; `{t:'ai',k:'...'}` para IA).
3. `templates/runtime.js` (jogo) ou `templates/app_runtime.js` (programa):
   carregar no `enter`, atualizar em `update` e desenhar em `draw`.
4. A GUI pega o inspetor do schema automaticamente; `ui/app.js` precisa de um
   pintor em `drawWidgetBox` (preview no viewport) e `widgetSize`.
5. `test/studio/run.js`: crie/edite um caso cobrindo o componente.
6. Docs EN + pt-BR (tabela de componentes e API de cena/tela).

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
- `studio describe --json` descobre projeto, runtime, componentes, ops, limites
  e assets (com `settings.props` dos scripts); `studio schema components` da os
  campos.
- `apply` aceita `[ops]`, `{ops:[...]}` ou `{op:...}`; aceita `--dry-run` e
  `--if-rev`. `entity.create`/`prefab.instance` aceitam `fid` explicito.
- Erros tem `code` estavel (`schema.*`, `ref.*`, `asset.*`, `build.invalid`,
  `build.lint`, `rev.stale`, `undo.empty`, `perm.missing`, `component.runtime`)
  + `hint` + `diagnostics`.
- HTTP: `POST /api/command` (mesmas ops), `GET /api/snapshot`, SSE
  `/api/events`; toda resposta de comando traz `snapshot`.
- A GUI tem barra de comando que aceita as mesmas ops JSON.

## COPILOTO (`lib/ai.js`)
- `studio ai "pedido"`, `studio ai fix`, `studio ai explain "..."`; HTTP
  `{"cmd":"ai"}` (dry-run por padrao; `apply:true` escreve); GUI aba **IA**
  (previa -> Aplicar/Descartar, anexar imagem, gravar voz 4 s).
- Chaves por ambiente: `CELER_STUDIO_AI_KEY` (fallback
  `OPENROUTER_API_KEY`/`DEEPSEEK_API_KEY`/`OPENAI_API_KEY`),
  `CELER_STUDIO_AI_PROVIDER/MODEL/URL`. Nada no repo.
- O modelo responde `{"say","ops"}`; o lote passa por `applyOps` em dry-run e,
  se falhar, o erro volta ao modelo (`--max-steps`, padrao 2).
- Guardrails: `asset/scene/entity.delete` e `tilemap.remove` bloqueados sem
  `allowDelete`; `asset.import` bloqueado sem `allowImport`; teto de 40 ops;
  `rev` atual para concorrencia. NUNCA escreve arquivo direto.
- Testes: `ask` injetavel (CI sem rede) + provedor HTTP falso no
  `test/studio/run.js`.

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
  `.js` com jsstrip + jsmin (modulos tem o topo manglado; main.js so com
  `reserved`), compactar `app.json`, incluir so assets do build e
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
  **modo programa** (init --app, app.json sem deps/psram, app.data.js, script
  de tela com eventos, toggle/slider/lista, persistencia em Storage, `go`/
  voltar do header, validacao cruzada de modos, props tipados), os dois
  `studio_apps/` (Painel navega; Assistente manda `input_audio` e chama
  `AI.speak`), **copiloto** (parser/guardrails/retry, HTTP com provedor falso,
  CLI sem chave), build+run dos 4 jogos de `studio_games/`, deploy/app.zip
  deterministico (com deps.json cobrindo todo require compartilhado) e a
  bridge legada.
- `node tools/sdk/celer.js check` cobre drift de types/renderer/deps.
- Preview: `serve --open`; headless: `run --frames 0,600`.

## ANTI-PATTERNS
- Editar `.studio/build/**` ou `game.data.js`/`app.data.js`/`main.js` gerados
  a mao.
- Misturar componentes dos dois modos (a validacao recusa; nao "conserte"
  afrouxando a regra).
- Usar `fillRect`/`drawPNG` por quadro no runtime de programa (card e
  `ui.image` ja sao especiais: card usa `UI.card` e imagem so em quadro
  total).
- Deixar o copiloto escrever arquivo fora do `applyOps` (perde undo, validacao
  e a garantia de lote atomico).
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
