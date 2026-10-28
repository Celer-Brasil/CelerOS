# Engine + Celer Studio: estudo de melhorias conjuntas

**Português (BR)** · 2026-10-26 · API 51 · CelerGame core 1.6.0, spr 1.7.0,
tilemap 1.3.0, scene 1.1.0 · base analisada: HEAD `5450a16`.

A árvore tem WIP local amplo (Lenda 2.0.6 joystick, `format.js`, `build.js`,
`schema.js`, `ops.js`, `assets.js`, componentes e `main/`) que **não** foi usado
como baseline nem alterado por este estudo. Números de build da Lenda são da
medição 2.0.5; o WIP 2.0.6 aparece separado quando relevante.

Documento de **estudo e priorização**, não de implementação. Nenhum arquivo de
engine, runtime, editor ou jogo foi alterado para produzi-lo.

---

## 1. Resumo executivo

A engine já tem primitivas boas para este hardware: camada suja com recorte,
`E.dirty.touches`, sprites com slot compartilhado, `E.spr.alvo` (bake), câmera,
âncoras, metadados de arte e um perfilador por trecho (`E.prof`). O Studio já
tem o que a maioria dos editores não tem: arquivo como fonte da verdade, GUIDs
estáveis, um único barramento GUI/CLI/HTTP, build determinístico, orçamento de
pacote e testes headless dos quatro jogos.

O que falta não é “mais engine” nem “mais editor” isoladamente. Falta **contrato
entre os dois**: o editor ainda não serializa, valida e mede várias capacidades
que a engine já tem, e a engine ainda não expõe contadores que o editor consiga
usar para provar uma melhoria.

As três melhorias de maior retorno são, nesta ordem:

1. **Observabilidade + orçamento**: o Studio mede e mostra `update/draw`,
   stamps, células de tilemap, caixas sujas, loads de asset e present; o build
   avisa quando uma cena estoura o orçamento e o CI compara com um baseline.
2. **HUD/camadas genéricos**: o padrão que fizemos à mão na Lenda 2.0.5
   (HUD fora da camada suja + recorte do mundo) deve ser uma configuração de
   cena do Studio, não código de cada controlador.
3. **Ciclo de vida de assets**: cache/refcount entre cenas e pré-carga. Hoje
   toda troca de cena faz `freeAll()` e recarrega as mesmas folhas.

Depois vêm bake de cenário estático, spawn/pool de prefab, portais/save
declarativos e, por último, escala de render/atlas/batching — este último só
depois de a instrumentação mostrar que o custo está no desenho, não no present.

Restrição dura: o core enxuto já tem **54.237 B** e passou do teto de 48 KB;
qualquer feature nova de core exige PSRAM ou vira módulo. As melhorias deste
estudo devem morar, preferencialmente, no **runtime do Studio + editor +
módulos**, não no core.

---

## 2. Evidências

### 2.1 O que a Lenda 2.0.5 mostrou

Medição no 4848 com `debug=false`, `prof=true` e log de bancada separado (o
overlay do `E.debug` **não** foi usado — ele desenha no topo, toca a caixa do
HUD e força o HUD a repintar todo quadro):

| Métrica | Valor |
|---|---:|
| fps | 30–31 (alvo 30) |
| frame | 14–17 ms (pico 26 ms) |
| update | 1 ms |
| draw | 11–12 ms |
| caixas sujas | 1 (área 34×34) |
| full repaint | 0 |

O HUD era o maior desperdício: 6 corações = 12 círculos, 6 textos, 4
retângulos/botões A-B e o ícone de pausa **por quadro**, e essas caixas entravam
na camada suja. Depois do memo:

| Chamadas por quadro (harness) | antes | depois |
|---|---:|---:|
| `spr.stamp` | 33,9 | 9,1 |
| `gfx.text` | 6 | 0 |
| `gfx.rect` | 4 | 0 |
| `gfx.circle` | 14 | 2,1 |
| células de tilemap repintadas | 29,3 | 6,5 |
| ms do host por quadro | 1,79 | 0,21 |

**Lição 1:** o maior ganho veio de **parar de redesenhar o que não mudou**, não
de trocar primitiva. A engine já tinha `E.dirty.touches` e `E.dirty.clip`; o
runtime do Studio não os usava. Isso é contrato, não feature nova.

**Lição 2:** `E.prof` separa `update` de `draw`, mas não separa:
- chamadas nativas (copy/push/affine);
- células de tilemap realmente repintadas;
- compose vs push do display;
- carregamento de asset na troca de cena.

Sem esses contadores, a próxima otimização é palpite.

### 2.2 Custo de assets e cenas nos quatro jogos

Dados do build (`.studio/build/*/game.data.js`) e do projeto:

| Projeto | Cenas | Assets únicos | Loads/cena (média) | Máx. | Camadas de tilemap | Células somadas |
|---|---:|---:|---:|---:|---:|---:|
| Detona | 9 | 5 | 1,4 | 2 | 6 | 1.170 |
| Arrasa | 13 | 10 | 7,2 | 10 | 0 | 0 |
| Lenda de Celer | 23 | 6 | 3,4 | 4 | 20 | 3.900 |
| Supernova | 5 | 3 | 1,0 | 2 | 0 | 0 |

O runtime de cena chama `loadAsset()` para cada asset de `scene.load` na entrada
e `E.spr.freeAll()` na saída (`templates/runtime.js:200-201,462`). Na Lenda,
cada sala recarrega as mesmas 3–4 folhas; na Arrasa, até 10 assets por fase. O
slot de sprite é 16 com PSRAM (1 sem), então um cache simples cabe nos quatro
jogos, mas precisa de orçamento visível no editor.

### 2.3 Pacotes atuais

| Projeto | JS enxuto | Assets | Extras | Observação |
|---|---:|---:|---:|---|
| Detona | 59.490 B | 135.364 B | 8 | folga |
| Arrasa | 90.681 B | 80.764 B | 13 | perto do teto de 16 extras |
| Lenda de Celer | 118.138 B | 203.718 B | 9 | WIP 2.0.6 |
| Supernova | 37.979 B | 113.454 B | 6 | folga |

Tetos do Studio/hub: 16 extras, 128 KB/asset, 256 KB de assets, 1 MB de JS com
PSRAM, 48 KB sem PSRAM. O core enxuto de 54.237 B já implica `psram` para
qualquer app com engine; melhorias de core precisam de módulo ou dieta.

### 2.4 O que a engine já tem e o Studio não usa

| Capacidade | Onde existe | Uso atual no Studio |
|---|---|---|
| Camada suja com `clip`, `touches`, `mute`, `erase` | `celeros.game.js` | O runtime liga o painter e `markRect`, mas não oferece HUD/camadas; a Lenda teve de usar `_mute`/`unclip` na mão |
| `E.spr.alvo` + bake de sala | `celeros.game.world.js` | O runtime do Studio não tem bake; cada célula é um stamp |
| `E.prof` por trecho | core 1.5+ | O projeto liga `E.prof.on`, mas o Studio só mostra tempo; não coleta contadores nem budgets |
| `E.slots`/slots de sprite | spr | O Studio não mostra quantos slots a cena usa, nem avisa sobre o teto 16/1 |
| `E.anim.onFrame/onEnd` | core | O runtime/editor não expõem eventos de animação |
| Culling de `group`/`pool` | core 1.6 | O runtime de cena não usa culling; as salas atuais cabem na tela, então é baixo ganho imediato |
| `celeros.game.scene` (prefab como dado) | módulo 1.1 | O Studio achata prefabs e não instancia em runtime |
| `E.anchor`/inset | core 1.5 | O editor já usa no componente `hud`; falta a camada persistente |

### 2.5 O que o Studio já tem e ainda pode render mais

- `run` headless com frames/PNG, `deploy` determinístico com `deps.json`,
  orçamento de extras/JS/assets e lint ES5 no build.
- Editor de tilemap com sólidos por tile, pincel e `tilemap.set` atômico.
- Inspetor de asset com `anims`, hitbox, pivot e preview de clipe.
- GUI com hierarquia, viewport, gizmos, prefabs, abas Build/Jogo e API HTTP.
- O que falta para o ciclo fechar: **medir e aconselhar**, não só compilar.

### 2.6 O caso Kui/quadro parcial

O commit `5450a16` (launcher) mediu no 4848:

- quadro cheio do arrasto: **~76 ms** (compor ~47 ms + push ~30 ms de 460 KB);
- quadro parcial: **1,1–6,0 ms** por evento.

O mesmo raciocínio vale para o jogo: a camada suja da engine deve manter o
present parcial, mas o Studio não mostra compose/push do app nem quantas caixas
foram ao vidro. Sem esse número, `draw=11 ms` pode ser JS, chamada nativa ou
push — e a decisão de otimização muda completamente.

---

## 3. Princípios do desenho conjunto

1. **Engine expõe capacidade; editor expõe autoria e orçamento.** Uma feature só
   entra se o editor conseguir serializar, validar, pré-visualizar e medir.
2. **Nada de `#ifdef` de placa.** Diferença de hardware é `E.caps`/feature
   detect, como hoje.
3. **Core é caro.** 54,2 KB enxutos e teto de 48 KB sem PSRAM. Preferir módulo,
   runtime do Studio e build; medir bytes antes de aceitar core.
4. **Medir antes de otimizar.** Contadores e baseline no CI valem mais que uma
   otimização sem número.
5. **Determinismo e arquivo como fonte.** Build, deploy, undo e ops continuam
   canônicos; feature nova não pode criar estado escondido no editor.
6. **Uma implementação.** Se a engine já tem `clip`/`touches`/`alvo`/`prof`,
   o runtime usa isso; não criar uma segunda camada concorrente.

---

## 4. Propostas ranqueadas

Legenda: **E** = engine/módulo, **R** = runtime do Studio, **Ed** = editor/build.
Impacto e custo são qualitativos; a ordem é a recomendação de execução.

| # | Proposta | Onde | Impacto | Custo | Risco |
|---|---|---|---|---|---|
| P0 | Observabilidade e orçamento de cena | E+R+Ed | alto | baixo-médio | baixo |
| P1 | HUD/camadas genéricos no runtime | R+Ed | alto | médio | baixo |
| P2 | Cache/refcount de assets + pré-carga | R+Ed | alto | médio | médio |
| P3 | Bake de cenário estático | R+Ed | alto (medir) | médio-alto | médio |
| P4 | Spawn/pool de prefab em runtime | E/R+Ed | médio-alto | alto | médio |
| P5 | Portais/links e save declarativos | R+Ed | médio | médio | baixo |
| P6 | Loop de bancada no Studio | Ed | alto no fluxo | médio | baixo |
| P7 | Escala de render/batch/atlas | E+R+Ed | incerto | alto | alto |

### P0 — Observabilidade e orçamento de cena

**Problema:** `E.prof` dá tempos, mas não chamadas; o editor não compara uma
cena com um baseline. A Lenda só foi otimizada porque instrumentamos à mão.

**Desenho:**
- No build com `editor.prof=true`, o runtime envolve (ou conta direto):
  `spr.stamp`/`blit`, `gfx.text/rect/circle/line`, `tilemap.flush` (células),
  caixas sujas/área, `loadAsset` e `enterScene` (ms).
- `E.prof.snapshot()` ganha campos aditivos (ou o runtime publica um
  `E.stats`):
  `{fps, frame, input, mods, update, draw, maxFrame, stamps, copies, pushes,
    affines, texts, shapes, cells, dirty, dirtyArea, loads, sceneMs}`.
- O Studio grava isso em `run --profile` (JSON + tabela) e mostra uma aba
  **Performance** com médias/p95/max e barras contra orçamento.
- `build` já tem barras de extras/JS/assets; acrescentar **orçamento de cena**:
  stamps/células/entidades/asset loads e um aviso quando passar do baseline.
- CI (`test/studio/run.js`) roda os quatro jogos com baseline determinístico
  (contadores, não tempo de host) e falha em regressão grosseira.

**Aceite:** cada jogo tem um relatório por cena com `draw/update` e contadores;
a Lenda mostra o HUD memoizado (corações = 1–2, não 60); uma regressão de 20%
em stamps/células falha no CI.

**Custo/risco:** quase tudo no runtime/build do Studio; nenhum byte no core se
os contadores forem condicionais ao `editor.prof`. O risco é medir com
`E.debug` ligado e concluir errado — o relatório deve marcar isso.

### P1 — HUD e camadas genéricos

**Problema:** cada controlador reinventa HUD, recorte e memoização. A Lenda
2.0.5 precisou mexer em `E.dirty._mute`/`unclip` e `System.setClip` privados.

**Desenho de cena (schema + build):**
```json
"settings": {
  "hud": { "h": 64, "clip": true, "persistent": true },
  "layers": [
    { "id": "fundo", "static": true, "bake": true },
    { "id": "entidades", "clip": [0, 64, 480, 416] }
  ]
}
```
- O runtime:
  - aplica `E.dirty.clip` na área de jogo;
  - desenha `hud`/overlays com `_mute` e `unclip`, redesenha só quando
    `hudKey` muda ou `E.dirty.touches` toca a faixa/botões;
  - devolve o recorte depois do HUD.
- A engine ganha, se necessário, uma API pública pequena para não espalhar
  `_mute`/`_unclip` pelos jogos (`E.layer.begin/end` ou `E.dirty.mute(fn)`).
  Idealmente no módulo/runtime, não no core.
- O editor mostra `hud`/`layers` no inspetor de cena, desenha a faixa no
  viewport e avisa se uma entidade `hud` cai fora do inset.

**Aceite:** o HUD da Lenda vira configuração (o controlador só desenha textos
específicos); o jogo mantém 30–31 fps; um teste de frames garante que o HUD não
some quando o mundo repinta.

**Custo/risco:** médio; o risco é a ordem de desenho (HUD antes/depois de
overlays) e o recorte nativo em placas sem `caps.clip`. Testar nos modos
Direct/Bands do display.

### P2 — Cache/refcount de assets e pré-carga

**Problema:** `exitScene` faz `freeAll()` e cada cena recarrega as mesmas folhas.
Na Lenda são 3,4 loads/cena; na Arrasa 7,2. Isso custa decodificação e slots na
troca de sala/fase.

**Desenho:**
- O runtime mantém `loaded[guid]` com refcount/LRU; `loadAsset` vira
  “garanta carregado”; `exitScene` não libera o que o próximo grupo usa.
- O build conhece o grafo cena→assets e pode emitir `loadGroups` +
  `preload` (próxima cena) no `game.data`.
- O editor mostra “assets únicos / slots usados / pico” e permite marcar um
  grupo como persistente ou pré-carregado.
- Liberação no fim do app ou por LRU; o teto de 16 slots (1 sem PSRAM) vira
  erro de build, não surpresa no device.
- Feature detect: se `E.spr.free`/slots não existirem na versão antiga, cai no
  `freeAll` atual.

**Aceite:** entrar/sair da mesma sala não faz load; transição de cena reduz o
pico; relatório mostra `loads` por transição; nenhum vazamento de slot nos
testes de ida/volta.

**Custo/risco:** médio. O risco é segurar sprite grande demais ou usar slot de
uma cena antiga; refcount + LRU + relatório resolvem. Na Arrasa, 10 assets
únicos ainda cabem, mas o editor precisa avisar perto de 16.

### P3 — Bake de cenário estático

**Problema:** cada célula de tilemap e cada entidade estática é um stamp; a
engine já sabe gravar uma sala inteira num sprite (`world.js` `bake` com
`E.spr.alvo`), mas o Studio não expõe isso.

**Desenho:**
- `settings.bake`/camada `static` no editor; o runtime, no `enter`, grava
  tilemap + entidades estáticas num sprite de cena (ou numa região) e desenha
  um `blitSprite` por caixa suja; `map.set`/entidade alterada rebakeia a célula.
- O editor estima memória (W×H×2), slots e mostra o custo do bake; decide se
  cabe (`E.slots.fit`/PSRAM) antes de gerar.
- Cenas com câmera ou tilemap animado continuam no caminho atual; bake é opt-in.
- O preview headless desenha o mesmo caminho (bake + blit), para o editor não
  mentir.

**Aceite (a medir):** numa sala de 480×416, o custo de desenho cai de N stamps
para 1 blit + entidades dinâmicas; a memória do sprite cabe no orçamento; um
`map.set` repinta só a célula. Se o ganho no 4848 não compensar o custo de
PSRAM, a feature fica documentada como opt-in para mapas grandes.

**Custo/risco:** médio-alto. Full-screen em PSRAM disputa banda com o DMA do
painel (o mesmo problema do launcher); medir compose/push antes de promover.

### P4 — Spawn/pool de prefab em runtime

**Problema:** a engine tem `celeros.game.scene` (prefab como dado), mas o
runtime do Studio achata prefabs e não tem spawn; todos os quatro jogos
escrevem pools de inimigo/tiro à mão.

**Desenho:**
- O build emite `prefabs` (template achatado) no `game.data`; o runtime ganha
  `ctx.spawn(prefab, x, y, fields)` e `ctx.pool(prefab, n)`, com limites e
  reciclagem sem alocar por tiro.
- O editor ganha uma view de prefab (editar como cena pequena) e um op
  `prefab.instance`/`spawn` no schema; o inspetor mostra o pool e o custo.
- O controlador continua dono da lógica; o runtime só materializa componentes
  e chama `start/update/draw` como já faz com scripts.
- Não obriga `celeros.game.scene` no app; é um caminho do runtime do Studio.

**Aceite:** um jogo (Detona ou Lenda) usa spawn/pool em vez de código manual
sem regressão de fps; prefab editado no editor aparece no Play headless sem
recompilar o controlador.

**Custo/risco:** alto, porque mexe no contrato de script e no build. Fazer
depois de P0–P2, quando há baseline para provar que não piorou.

### P5 — Portais/links e save declarativos

**Problema:** a Lenda codifica 13 portais por sala em `settings.data` e o
controlador interpreta; o save é um blob no script. É correto, mas repetitivo e
difícil de validar no editor.

**Desenho:**
- `settings.links`/`portals` com cena destino, célula de destino, condição
  (`key`/`bomb`/flag), custo e animação; o runtime trata a colisão/entrada.
- `state` declarativo por projeto (chaves tipadas, defaults, migração) que o
  editor inspeciona e o runtime salva com schema/versão.
- O editor mostra um grafo de cenas/portais e valida destinos/células no build.
- A Lenda migra como piloto; o controlador fica só com a lógica especial.

**Aceite:** menos código no controlador; build falha em portal para cena
inexistente; save antigo continua legível (migração).

**Custo/risco:** médio; o risco é criar um segundo sistema de save. O runtime
deve usar o `E.save` existente e um schema único.

### P6 — Loop de bancada no Studio

**Problema:** hoje medimos a Lenda com scripts Python/celerctl avulsos; o
editor não instala, não mede A/B, não grava um roteiro de toque e não compara
duas builds no device.

**Desenho:**
- `studio bench --device -p PORT` (ou GUI): build → instalar/rodar → aplicar
  input gravado → coletar `E.prof`/contadores → PNG/frames → JSON de baseline.
- `studio deploy --install` usa o `app.zip`/`deps.json` já gerado.
- A GUI mostra o mesmo relatório de P0 e um botão “A/B” (build anterior vs
  atual), com aviso se o app/dep não estiver publicado.
- O CI continua só com o host; a bancada é manual e registrada.

**Aceite:** um comando reproduz a medição da Lenda e imprime fps/frame/draw/
update/células; um A/B mostra a diferença; nenhum segredo/token no relatório.

**Custo/risco:** médio; não muda runtime. O risco é instalar no device errado;
reusar a resolução de porta/package do celerctl e exigir confirmação explícita.

### P7 — Escala de render, batch e atlas (depois)

Só considerar depois de P0 e de medir compose/push no 4848:

- **Escala virtual** (renderizar 240×240/320×320 e ampliar no push): pode cortar
  4× os pixels, mas texto/escala fracionária e nitidez de pixel art precisam de
  desenho próprio; a câmera/afim já custa ~1,25 ms por chamada.
- **Batch/display list**: reduzir chamadas JS→nativo; a engine não tem batch e
  o firmware não expõe um; medir antes.
- **Atlas/quantização**: o build hoje copia PNG lossless; atlas por cena e
  paleta podem reduzir flash/I/O, mas não necessariamente o draw. O editor
  precisa de fatiador visual (limitação já documentada).
- **Eventos de animação/estado**: `E.anim` já tem `onFrame/onEnd`; expor no
  editor é barato e melhora gameplay, mas não é o gargalo atual.

---

## 5. Rodadas sugeridas

### Rodada 1 — medir e colher o que já existe (P0 + P1)

1. P0 no runtime/build: contadores condicionais + `run --profile` + aba
   Performance + baseline no CI.
2. P1 no schema/runtime: `hud`/`layers`; migrar a Lenda 2.0.5 como piloto;
   manter o HUD específico só no controlador.
3. Medir os quatro jogos no 4848 com `debug=false`, mesma cena e 3 amostras;
   registrar fps/frame/draw/update/present/células/loads.
4. Critério de saída: Lenda mantém 30–31 fps e o HUD não redesenha; o Studio
   mostra o relatório; CI pega regressão de contadores.

### Rodada 2 — assets e cenário (P2 + P3)

1. Cache/refcount + load groups; medir load por transição.
2. Bake opt-in; A/B de draw/push/memória numa sala da Lenda e numa fase da
   Arrasa; decidir por evidência.
3. Editor: orçamento de slots/memória, aviso de 16 slots, estimativa de bake.
4. Critério: transição sem recarregar asset repetido; bake só entra se ganhar
   no 4848 sem estourar PSRAM/banda.

### Rodada 3 — autoria de gameplay (P4 + P5)

1. Spawn/pool de prefab e view de prefab.
2. Portais/links e save declarativo; migrar a Lenda.
3. Critério: menos código de controlador, mesma performance e save compatível.

### Rodada 4 — device loop e render avançado (P6 + P7)

1. `bench`/`deploy --install`/A/B no Studio.
2. Só então avaliar escala de render/batch/atlas com números de compose/push.

---

## 6. Métricas e gates

Para cada jogo/cena, registrar no relatório:

| Métrica | Como medir | Gate inicial |
|---|---|---|
| fps | `E.fps` no device, 3 amostras | alvo 30 (Lenda já em 30–31) |
| frame p95 | `E.prof.frame`/`E.frameMs` | < 33 ms na cena de jogo |
| update/draw | `E.prof` | sem regressão > 20% |
| compose/push | contador do display (novo) | separar do draw |
| stamps/copies/pushes/affines | contadores P0 | baseline por cena |
| células de tilemap | `map.flush` retorno | baseline por cena |
| caixas/área suja | `E.dirty._prev`/present | baseline por cena |
| asset loads/transição | `loadAsset` | 0 para asset já visto |
| slots/PSRAM/heap | `E.slots`/`System.getInfo` | abaixo do teto |
| pacote | `report.json` | 16 extras/256 KB/1 MB |

**Regras de medição:** `E.debug=false`; tela ligada; mesma cena, seed e input;
3 amostras; não medir durante OTA/bench concorrente; separar compose de push.

---

## 7. Riscos e anti-metas

- **Medir com `E.debug` ligado invalida o HUD memoizado** (o overlay toca a
  faixa do HUD). Isso já aconteceu na rodada da Lenda.
- **Core não é o lugar padrão.** 54,2 KB enxutos e teto de 48 KB; P0–P3 devem
  ser runtime/editor/módulo. Toda feature de core precisa de justificativa de
  bytes.
- **Bake full-screen em PSRAM** disputa banda com o DMA do painel; o launcher
  mostrou que quadro cheio é caro. Medir compose/push e manter opt-in.
- **Cache de asset sem refcount** vira sprite velho/ slot vazado; LRU, release
  no fim do app e relatório de slots.
- **Spawn/pool sem limite** vira pressão de GC/PSRAM; teto e erro claro.
- **Duas implementações**: se o runtime já tem `E.dirty`/`E.spr.alvo`/`E.prof`,
  não criar camada paralela.
- **Editor não pode virar dono do runtime**: arquivo/ops/build continuam a
  fonte; GUI/CLI/HTTP no mesmo barramento.
- **Não promover escala de render/atlas** antes de P0 mostrar que o custo está
  no draw; pode ser present/PSRAM.

---

## 8. O que fazer primeiro (recomendação)

Se for para escolher **uma** entrega de maior retorno por esforço:

**P0 (observabilidade + orçamento)**. Ela não muda o jogo por si, mas transforma
“está lento” em “gastamos X em stamps, Y em células, Z em push”, e permite que
P1/P2/P3 sejam decididos por A/B no 4848. Em seguida, **P1** colhe o ganho que a
Lenda já provou (30–31 fps) para todos os projetos do Studio.

Ordem curta recomendada:

1. P0: contadores + `run --profile` + painel + baseline CI.
2. P1: HUD/camadas no schema/runtime; migrar Lenda.
3. P2: cache/refcount; medir transição.
4. P3: bake opt-in; A/B e decidir.
5. P4/P5: spawn/links/save; P6: bench; P7 só com números.

---

## 9. Referências

- `tools/sdk/engine/celeros.game.js` — loop, `E.prof`, `E.dirty`, `E.anchor`,
  câmera, anim, grupos.
- `tools/sdk/engine/celeros.game.spr.js` — slots, `stamp`/`copySprite`/
  `pushSprite`/afim, `alvo`, `meta`, `prescale`.
- `tools/sdk/engine/celeros.game.tilemap.js` — `markRect`/`flush`/`set`.
- `tools/sdk/engine/celeros.game.world.js` — bake de sala e repintura de célula.
- `tools/studio/templates/runtime.js` — `loadAsset`, `enterScene`, `drawScene`,
  `exitScene` (`freeAll`), HUD/`data`/`ctx.go`.
- `tools/studio/lib/build.js`, `deploy.js`, `deps.js`, `validate.js` — build
  flat, deps, limites, app.zip.
- `Documentation/DekiEngine_Estudo.pt-BR.md` — primitivas e custos de bench que
  este estudo não repete.
- `Documentation/Studio_Guide*.md` — limitações atuais (prefab spawn, transições
  visuais, atlas slicer, áudio loop).
- Commit `da8b5a8` — HUD memoizado/recorte da Lenda 2.0.5.
- Commit `5450a16` — quadro parcial do Kui (compose/push no 4848).
- WIP local (não alterado por este estudo): Lenda 2.0.6 joystick flutuante e
  `tools/studio/lib/format.js` (escrita atômica/BOM/`cmpStr`).
