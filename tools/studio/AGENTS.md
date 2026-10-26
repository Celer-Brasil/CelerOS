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
| `lib/build.js` | codegen determinista: main/data/scripts/assets/app.json |
| `lib/run.js` | executa o build no harness do host (PNG/frames/input) |
| `lib/import_game.js` | import-game: app existente -> projeto legado (assets/metas/scripts) |
| `lib/live.js` | filho do Play (emulador ao vivo) |
| `templates/runtime.js` | runtime de cenas ES5, concatenado no main.js |
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
- **Engine atual**: o runtime usa `E.spr.meta`/`animOf`/`box` (spr 1.6),
  `E.anchor`/`E.ax/ay` e `E.prof` (core 1.5) quando presentes (feature
  detect); o projeto gerado declara `celeros.game ^1.5.0`, `spr ^1.6.0`.
  Pivot do asset vira `ax/ay` do metadado; transform sem `ax/ay` herda.

## INTEGRACAO COM A ENGINE (o que ja e usado)
| Recurso | Onde o Studio usa |
|---------|-------------------|
| `E.spr.meta` / `animOf` / `box` | build grava `anims/fps/loop/hitbox/pivot`; runtime registra sheet+meta; componente `anim.meta` usa `animOf`; `entity.box()` usa `box` |
| `E.ax/ay/anchor`, `E.inset` | componente `hud` (ancora 0..8) no runtime e no viewport; preview de `canvas.inset` |
| `E.prof`, `E.debug` | `editor.prof`/`editor.debug` viram `E.prof.on`/`E.debug` no main gerado |
| `E.slots` | automatico no spr; nenhum codigo do Studio mexe em `_used` |
| `celeros.game.scene` | opcional para scripts (o projeto pode declarar); o runner do Studio ainda achata prefabs e nao o exige |

## MODO LEGADO (jogos remontados)
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
  o runtime legado. Assets/scripts sim.
- Os 4 jogos estao em `studio_games/` (Detona, Arrasa, Lenda de Celer,
  Supernova); ver `studio_games/README.md`. Proximo passo: extrair levels para
  cenas e trocar o legado por componentes nativos, sistema por sistema.

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
6. Docs EN + pt-BR (tabela de componentes).

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
- Hierarquia (cena/entidades/prefabs/tilemaps), inspetor dirigido pelo schema,
  viewport (pan/zoom/grid/snap/arraste), assets, console, abas Cena/Jogo/Build,
  barra de comandos e Play em iframe.
- Pincel de tilemap: paleta de regioes do tileset, borracha, checkbox solido;
  clique/arraste no viewport, botao direito apaga; commit unico em
  `tilemap.set` no pointer-up; cols/rows redimensionam preservando o canto.
- Inspetor de asset: modo/grade/pivot/cor-chave, `anims`/`fps`/`loop`, hitbox;
  o viewport desenha hitbox e ancora do sprite selecionado; entidades `hud`
  aparecem na posicao ancorada e com a margem `canvas.inset`.
- Diagnostico: toggles de `E.debug`/`E.prof` (rebuild/play) e `canvas.inset`.

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
  `game.data.js`/partes, `s.<slug>.js`, assets planos, `app.json`, `icon.png`).
- Extras = partes de data + scripts + assets (main/app.json/icon sao livres).
- So assets referenciados por cenas entram; todos os scripts entram.
- Metadados de arte vao no `game.data` (nao em .json lido em runtime): o app
  nao precisa de permissao `fs` para `E.spr.meta`/`E.scene`.
- `app_lint` roda no pacote final e bloqueia o build em erro.
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
  harness (spr.meta/animOf/box + HUD ancorado), prefab achatado, CLI x HTTP e
  a bridge legada (import-game, goto entre cenas, bases do pacote).
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
  runtime legado usa o main/scripts originais, nao a cena. Migre o sistema
  para componentes nativos antes de remover `runtime: "legacy"`.
