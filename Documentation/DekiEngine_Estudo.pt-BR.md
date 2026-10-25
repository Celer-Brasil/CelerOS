# deki-engine — estudo e ideias para o CelerGame

**Português (BR)** · 2026-10-25 · Estado do código: API 50 / CelerGame core 1.4.5
Fonte estudada: `/home/maikeu/GitClones/deki-engine` @ `91c7c2e` (0.20.3), 21.574 linhas de C++ no core.

Documento de leitura, não de implementação: descreve o que o deki faz, o que
disso sobrevive à tradução para ES5/Duktape, o que custa em bytes e o que
**não** deve ser trazido. Marcação: *(sem marca)* = o que existe hoje nos dois
lados, **[PROPOSTA]** = ideia a adotar, **[NÃO]** = ideia a recusar.

---

## 1. O que é o deki-engine

Uma engine 2D em C++23 para ESP32-S3 e desktop, do Kirbyrawr. O que está neste
clone é **só o núcleo compartilhado**: o loop, o modelo de objetos/componentes,
o sistema de cena, assets, memória e as *interfaces* de plataforma. Renderização,
conteúdo 2D, input e cada integração de placa vivem em **pacotes** separados
(repositórios próprios), e existe um **editor** (deki-editor) que é quem constrói
o firmware. `README.md:1-11`

Os cinco mecanismos que definem a engine:

| Mecanismo | Como funciona | Onde |
|---|---|---|
| Loop | `Engine::Update(dt_ms)` por iteração; ordem input → power → tempo → ciclo de vida → callbacks → render → present. `dt` variável em ms inteiros, **sem clamp** | `src/Engine.cpp:249-353` |
| Componente | Classe derivada de `Deki::Component`; membros `DEKI_EXPORT` viram campos serializáveis e a metadata do inspetor por **codegen com reflexão estática** (GCC 16) | `tools/reflection_codegen.cpp`, `include/deki/reflection/Property.h` |
| Cena | Árvore de `Object` com transform local + cache world sujo; ids `uint` por cena; *single-root* imposto no load | `src/Object.cpp:486-585`, `src/Scene.cpp:773-785` |
| Formato de cena | **MessagePack** compilado do JSON autorado; tipo de componente = nome qualificado → FNV-1a 32 bits; propriedades por nome | `src/SceneMessagePack.cpp:1187-1395` |
| Assets | GUID de 36 chars como identidade; tabela binária de lookup (`"caminho:type"` → GUID, 44 B/entrada); packs `DPAK` lidos **inteiros** para PSRAM | `src/assets/AssetLookupTable.cpp:102-137`, `src/assets/AssetPackReader.cpp:116-239` |

E o que sustenta a portabilidade: **nada de `#ifdef` de placa no core**.
Memória, filesystem, tempo, display, render, input e power entram por
`IMemoryProvider`, `IFileSystem`, `ITimeProvider`, `IDisplay`, `IRenderSystem`,
`IInputSystem`, `IPower` (`include/deki/providers/`). O preço é um handshake de
ABI (`include/deki/interop/ReflectionAbi.h:40-132`) para as DLLs de pacote.

**O que não está no clone:** `deki-rendering`, `deki-2d`, `deki-input*`, os
providers de placa e o editor. As afirmações sobre o rasterizador e o strip
rendering neste documento vieram do master no GitHub (consultado nesta data),
não de código local — trate-as como indicação, não como fato verificado aqui.

---

## 2. Onde o CelerGame já está à frente

Isto importa para não regredir ao importar ideias: em vários pontos o nosso
desenho é melhor para o nosso alvo.

| Tema | deki-engine | CelerGame |
|---|---|---|
| Repintura | Present parcial por retângulos que o renderer reporta; `dirtyRect*` virou campo reservado | Camada suja própria com double buffer `_prev/_cur`, painter por caixa, `erase`, `mute`, registro automático por primitiva e cenas `static` (`celeros.game.js:1063-1186`, `1000-1012`) |
| Alocação no quadro | Scratch reutilizado por fase; `unordered_map`/`string` ainda alocam no caminho quente | `EMPTY` compartilhado, scratches de gfx, pools com cursor circular, swap-pop, ordenação por inserção (`celeros.game.js:100,1389-1525`) |
| `dt` no estouro | **Sem clamp**: um light sleep dentro do `Tick()` entrega um delta gigante à física | Clamp em 0,1 s (`celeros.game.js:953-957`) |
| Troca de cena | Diferida + Awake/Start antes do draw; libera a cena velha primeiro para não pagar o pico das duas | Diferida para o topo do quadro + pilha de cenas com save/restore da camada suja (`celeros.game.js:870-947`) |
| Transição | — (o pacote de render cuida) | Véu por `fillRect`, sem `screen → sprite` (`celeros.game.js:752-837`) |
| Toque | `IInputSystem` despacha; sem contrato de multitouch no core | Primário = dedo mais antigo, troca de primário protegida, tap medido até o último quadro com o dedo (`celeros.game.js:459-650`) |
| Pausa/hitstop | — | `pause` desloca timers/tweens, `freeze` (hitstop), `timeScale` (`celeros.game.js:709-742`) |
| Teto de memória | Regiões nomeadas + `Buffer<T>`; falha macia no payload, **aborta** no bookkeeping | Feature-detect por `E.caps` em vez de `#ifdef`; mesmo espírito de providers |
| Conteúdo estático | "conteúdo produzido 1x por quadro" no pacote de render | Sala gravada num sprite de tela cheia e painter = 1 `blitSprite` por caixa (`celeros.game.world.js:273-346`) — medido: 195 tiles a ~240 µs cada vs 1 blit |

---

## 3. O número que manda em tudo

Medido nesta árvore com `tools/sdk/lib/jsstrip.js` (o que o aparelho compila):

| Módulo | cru (B) | enxuto (B) |
|---|---:|---:|
| `celeros.game` (core) | 94.177 | **48.288** |
| `celeros.game.world` | 23.820 | 13.833 |
| `celeros.game.fx` | 25.071 | 12.914 |
| `celeros.game.ui` | 21.986 | 12.181 |
| `celeros.game.spr` | 22.918 | 10.500 |
| `celeros.game.combat` | 16.924 | 9.754 |
| `celeros.physics` | 14.069 | 7.162 |
| closure do `celeros.engine` (core+fx+spr+tilemap) | — | 76.158 |
| soma de todos os `celeros.game.*` | — | **169.392** |

Teto sem PSRAM: **48 KB = 49.152 B** (`tools/celerhub.py:59-65`, espelhado no
servidor). Com `"requires": ["psram"]`: 1 MB.

**Consequência dura:** um jogo só-core tem **864 B** de folga na placa sem PSRAM
(CYD). Qualquer byte novo no core transforma "roda na CYD" em "exige psram" —
ou seja, **crescimento do core hoje é breaking change**. Toda ideia abaixo é
avaliada contra isso: o que é feature vai para módulo; o que é correção entra no
core só se couber ou se tirar bytes de outro lugar.

O guia do autor está defasado nesse ponto e precisa de correção:
`Documentation/Game_Engine_Guide.pt-BR.md:9,18,28,30,816` diz core "~25 KB" e
família "~35 KB" (o real é 48.288 B e 169.392 B enxutos, e a closure do shim
`celeros.engine` são 76.158 B). Quem planeja a CYD por esse número planeja por
2x menos do que existe.

---

## 4. [PROPOSTA] Ideias, em ordem de retorno

### A0. `group.remove()` dentro do update corrompe o laço — core, ~4 linhas

**Hoje:** `g.update` itera para trás com swap-pop e é correto **para o caminho
documentado** (`o.dead = true`: quem entra no fim não é visitado neste quadro e
quem é movido já foi visitado). Mas `g.remove()` usa `indexOf` + `splice`
(`celeros.game.js:1413-1419`) e o comentário diz "fora do update — o dead é o
caminho do meio do tick". Quem despawna com `remove()` de dentro do update
(e o nome convida) cai em dupla/tripla atualização ou índice inválido.
Reproduzido com a lógica exata do core (3 itens A,B,C; C remove o primeiro):

```
cenario1 hits= {"C":3}          // C rodou 3x, B nunca rodou, lista zerada
```

**deki:** é exatamente o problema que eles documentam — o usuário pode
reconstruir a lista viva no meio da fase, e por isso cada fase copia os
ponteiros antes de chamar código de usuário
(`src/LifecycleManager.cpp:111-118`). A cópia é a solução deles para C++;
para nós custa menos não copiar.

Nenhum app do catálogo faz isso hoje (`grep` em `data/apps`/`hub_apps`: o
`remove(` que aparece é `Storage.remove` e o `M.w.remove` do mundo rígido
nativo) — é armadilha latente, não incêndio. O guia só cita `group.remove(o)`
de passagem (`Game_Engine_Guide.pt-BR.md:923`), sem dizer que é proibido no
tick: o custo de fechar a porta é 4 linhas.

**Tradução:** guarda `_busy` no update; `remove` durante o update marca
`dead = true` (o swap-pop do próprio laço remove) em vez de `splice`. Validado
com o mesmo cenário: cada entidade roda uma vez, a removida não roda mais, e a
que já foi visitada sai no quadro seguinte.

```js
g.update = function (dt) {
    var a = g.items; g._busy = true;
    for (var i = a.length - 1; i >= 0; i--) {
        var o = a[i];
        if (!o.dead && o.update) o.update(dt);
        if (o.dead) { a[i] = a[a.length - 1]; a.pop(); }
    }
    g._busy = false; g.count = a.length;
};
g.remove = function (o) {
    if (g._busy) { if (o.dead) return false; o.dead = true; return true; }
    /* ... splice como hoje ... */
};
```

**Custo:** ~4 linhas, ~120 B. **Risco:** baixo; `remove` passa a ser diferido
só durante o update (o `count` pode incluir um morto por um quadro).

### A1. Pacing com sobra em microssegundos + yield espaçado — core, ~15 linhas

**Hoje:** `frameMin = Math.floor(1000/fps)` e `delay(frameMin - spent)` com
`spent` em ms inteiros (`celeros.game.js:1025-1030`). A 60 fps o quadro fecha em
16 ms → o jogo roda a ~62 fps; no estouro, `delay(1)` em **todo** quadro
atrasado.

**deki:** o orçamento é `1000000/fps` acumulado com o resto em µs
(`frameUs` + carry) exatamente porque 60 fps dava 62–66 (`src/Engine.cpp:424-432`,
commit `eacaea6`); atraso maior que um quadro reinicia o deadline em vez de
correr atrás (`:462-474`); o yield de 1 ms no estouro passou a acontecer só a
cada 100 ms — custava ~1 ms por quadro em cena lenta (commit `b002a51`).

**Tradução:** `System.micros()` já existe e é monotônico
(`main/Runtime/JsSystem.cpp:182`, `esp_timer_get_time()` como double). Guardar
`_dueUs` + `_carry`; dormir `Math.round` do que falta; no estouro, só ceder se
`micros() - _lastYield > 100000`.

**Ganho:** fps honesto (o `E.fps` do overlay passa a bater com o alvo), menos
consumo em jogo parado a 30 fps, ~1 ms por quadro em cena lenta.
**Custo:** ~0,4 KB enxuto. **Risco:** baixo — o `dt` continua variável e clampado.

### A2. Perfilador por trecho — core (ou módulo), ~60 linhas

**Hoje:** `E.frameMs` é um número só, em ms inteiros (`celeros.game.js:1025`), e
o overlay mostra fps/ms/caixas. Não responde "onde vão os 200 ms".

**deki:** `FrameTimings{update, render, present}` **exposto por getter** — nasceu
porque o device compila o log fora, então número que só existe em log não existe
na bancada (commit `0734ad7`, `CHANGELOG.md:97-102`); e o pacote de render tem
`RenderProfiler` em µs por tipo de componente.

**Tradução:** ler `System.micros()` em quatro pontos do `E.run`: início, fim dos
módulos (`E._modTicks`), fim do `update`, fim do `draw`. Janela de 30 quadros,
`E.prof = { update, draw, mods, native, frame }` em µs + `reset()`. Medir cada
módulo exige embrulhar o tick no `require` — dá para usar o nome que já está em
`E._mods`. O valor é legível no overlay, por `celerctl debug --eval` e por
`E.data` sem custo.

**Ganho:** os nossos jogos rodam de 7 a 33 fps; hoje otimizamos por palpite.
**Custo:** ~1,5 KB. **Risco:** baixo; manter desligado por padrão (custo zero).

### A3. `dispose()` de cena + dono do recurso nativo — core, ~25 linhas

**Hoje:** `leave()` chama `exit()` e mata timers/tweens; os slots de sprite
nativos (16 com PSRAM, **1 sem**) são contados à mão: `E.spr._used` sobe/desce em
`celeros.game.spr.js:106,160,211,394,414` e o `world` mexe no mesmo contador
privado (`celeros.game.world.js:267-270,541`). Se uma cena esquece o
`deleteSprite`, o slot só volta no reset do app
(`main/Runtime/JsGfx.cpp:49` — `deleteAllSprites` no `JSBindings::init`). Com
1 slot na CYD, "esqueceu" = "o próximo `createSprite` devolve 0".

**deki:** posse explícita — `AssetManager` é dono, e quem assume um asset chama
`ReleaseAssetTracking` para o `UnloadAll` não liberar duas vezes
(`include/deki/assets/AssetManager.h:120-125`). É o inverso do nosso "vaza até
reiniciar".

**Tradução:** (a) hook opcional `dispose()` chamado por `leave()` (e pelos
`pop`/pilha) — o lugar natural para devolver sprite, soltar pool e zerar o
`world`; (b) um ledger `E.slots.alloc(nome, w, h)` / `free(nome)` / `report()`
usado por `spr` e por `world`, com aviso em debug quando a contagem não volta ao
baseline na troca de cena.

**Ganho:** mata a classe de bug "quebra na segunda partida"; hoje o contador é
compartilhado por dois módulos e não tem dono.
**Custo:** ~0,7 KB no core + refactor de `spr`/`world` (bump dos dois).
**Risco:** sprites compartilhados entre cenas (`E.data`) precisam de posse
explícita — o ledger tem que permitir `free` só de quem alocou.

### A4. Falha nativa barulhenta — módulos, ~10 linhas cada

**Hoje:** `createSprite` devolve 0 e o chamador segue; o `world` faz
`try { createSprite } catch { 0 }` e cai no caminho de repintura **sem dizer
nada** (`celeros.game.world.js:265-271`). O sintoma no vidro é "a sala não tem
fundo", não um erro.

**deki:** toda alocação devolve null **e nomeia o pedido** — bytes, região, e o
que falhou; a colocação "resolve uma vez e nunca é substituída"
(`include/deki/providers/Memory.h:216-226`, `src/providers/Memory.cpp:486-494`).

**Tradução:** `E._warn` já existe e deduplica (`celeros.game.js:112-116`). Usar
em **toda** alocação nativa que falhar: `bytes = w*h*2`, `caps.slots`,
`caps.psram`, e o que degradou. Idem para `drawSprite` recusando sprite
inexistente.

**Ganho:** transforma "arte sumiu" em uma linha de logcat.
**Custo:** ~0,2 KB por módulo. **Risco:** ruído se não deduplicar (já deduplica).

### A5. Ancoragem de HUD em 9 pontos, ciente de inset — core gfx, ~30 linhas

**Hoje:** cada jogo calcula `E.W - w` na mão; o relógio redondo e o canvas nativo
de 480 fazem essa conta mudar de placa para placa.

**deki:** `ScreenAnchor` com 9 pontos, offset em metros, `Once`/`Always`, lista
intrusiva sem alocação (`include/deki/ScreenAnchor.h:14-26,83-88`,
`src/ScreenAnchor.cpp:65-113`). Eles **não** têm inset/safe area — nós temos
(`System.getInfo().inset/shape/screenW/screenH`), então a nossa versão sai melhor.

**Tradução:** `E.anchor(pt, x, y, w, h)` → caixa em coordenadas de tela, usando
`E.W/E.H`, `inset` e `shape`; `E.anchor(pt)` → ponto. `pt` = 0..8 (nw..se).

**Ganho:** uma conta em vez de N; HUD que funciona no 240x320, no 480 e no redondo.
**Custo:** ~0,8 KB. **Risco:** baixo (aditivo).

### A6. Metadados de arte num `.json` ao lado da folha — `spr`, ~60 linhas

**Hoje:** `spr.grid(nome, {cols, rows, fw, fh, ...})` e `E.anim(frames, fps)` em
código — cada jogo repete a grade e o timing; hitbox vive no `combat` em código.

**deki:** os metadados moram **dentro do arquivo** de textura
(`DTEX_FLAG_IS_SPRITE`, `metadataSize`, `include/deki/assets/Texture2D.h:35-46`)
e o tipo de asset é registrado por pacote com loader próprio.

**Tradução:** `.json` já é asset permitido (≤128 KB/arquivo, 16 arquivos). Um
schema mínimo:

```json
{ "sheet": { "cols": 8, "rows": 4, "fw": 16, "fh": 16 },
  "frames": { "idle": [0,1], "run": [8,9,10,11] },
  "anims": { "run": { "fps": 10, "loop": true } },
  "pivot": [8,15], "hitbox": [2,4,12,10] }
```

com `spr.sheetFrom(nome, json)` e `E.animFrom(nome, anim)`. Fica em `spr`
(módulo), nunca no core.

**Ganho:** arte iterável sem tocar JS (nossos apps vivem no teto), hitbox
canônica para `combat`/`collide`, menos código por jogo.
**Custo:** ~1,5 KB em `spr`. **Risco:** parse de JSON no load — manter o arquivo
pequeno (um `all.json` de 48 KB já falhou no device; ver memória do projeto).

### B1. `celeros.game.scene` — cena e prefab como dado — módulo novo, ~250 linhas

É a **maior lacuna funcional** nossa e a parte do deki que sobrevive inteira à
tradução, se jogarmos fora a reflexão.

**O que eles têm:** `Object`/`Component` com ids estáveis; `Scene::Instantiate`
que copia uma subárvore, **remapeia todos os ids** e re-resolve as referências
(`src/Scene.cpp:443-549`); ids determinísticos para filhos de instância
(`(instanceRootId, oldId)` com salt) para referências externas sobreviverem
(`src/Scene.cpp:1916-1934`); referência serializada como **id numérico**
(`include/deki/reflection/ObjectRef.h:11-36`); `version` no arquivo e
`MissingComponent` preservando os bytes de um componente desconhecido
(`src/MissingComponent.h:12-48`); rename de propriedade lido pela chave antiga
(`DEKI_RENAMED_FROM`, `include/deki/reflection/Property.h:137-149`);
**criação diferida** no parser — pula o mapa de dados e só constrói o componente
depois (`src/SceneMessagePack.cpp:614-623,806-884`), o que evita materializar
tudo antes.

**Tradução ES5 (sem reflexão, sem MessagePack):**

1. `E.scene.def(tipo, { campos: ['hp','speed'], create: fn, apply: fn(e,props), start: fn })`.
2. `E.scene.instantiate(lista, grupo)`: fase 1 cria todas as entidades e
   atribui ids; fase 2 resolve `refs` (`{id}` → entidade) — **antes** de chamar
   `start`, que é o `InternalAwake` deles (`include/deki/Component.h:63-68`); com
   re-resolução preguiçosa, porque no deki o `ObjectRef` resolve **uma vez só** e
   isso é um bug documentado deles (`src/LifecycleManager.cpp:123,136`).
3. `E.scene.save(grupo)` / `load`: JSON com `version` na **primeira** chave
   (o gate deles só vale se `version` vier antes de `objects`,
   `src/SceneMessagePack.cpp:538-577` — bug deles que não copiamos), chaves
   desconhecidas preservadas, migração por tipo com `renamedFrom`.
4. Prefab = uma lista salva; spawner = `instantiate`.
5. `level.parse` continua sendo o caminho para tilemap ASCII; `scene` cuida de
   **entidades** (inimigos, baús, gatilhos, spawn points).

**Ganho:** layout de fase fora do código; prefab (hoje cada jogo reescreve o
spawn por tipo); save de mundo; formato que o emulador/uma tool podem editar.
**Custo:** ~5–6 KB (módulo novo, opt-in). **Risco:** médio — parse é pico de
memória, então um arquivo por sala/prefab e um teto de entidades por arquivo.

### B2. [OPÇÃO] `seq` monotônico para ordem de desenho

Só vale se entrar z-order de verdade. Hoje `group.sort(key)` por inserção já é
estável e quase O(n) quadro a quadro (`celeros.game.js:1446-1458`). O truque do
deki (order + `seq` + sort comum, sem `stable_sort` e sem buffer temporário,
`deki-rendering/Standard2DRenderer.cpp:427-431`) é a resposta para quando não se
pode assumir quase-ordenação — anotar para o futuro, não implementar agora.

---

## 5. [NÃO] O que não trazer, e por quê

| Item do deki | Por que não |
|---|---|
| **Modelo de componentes + codegen de reflexão** | Nosso "compilador" é o launch do Duktape: não há passo de build por app onde rodar codegen, e o ganho num heap de ~90 KB é pequeno. `E.group` + objetos literais + módulos que decoram `E` cobrem o caso de uso a 10% do custo. O único pedaço portável é "só ticka quem declara update" — em JS é um `if (o.update)` que já existe. |
| **MessagePack** | `JSON.parse` está na **ROM** do Duktape (0 byte de engine). O formato binário deles existe porque é *build output* de um editor e porque o parse é mais barato num 240 MHz; com cenas pequenas, JSON ganha. Copiamos do desenho: `version` primeiro, chaves desconhecidas puladas, profundidade limitada, criação diferida. |
| **Strip rendering** | Não somos donos do framebuffer: o LovyanGFX escreve no painel e a camada suja já manda só o que mudou, num grão mais fino. O próprio deki mede strips **perdendo** em placa pequena (T-Deck Plus: 61 fps em quadro inteiro vs 59 em strips) e por isso tem `frameMode: Auto`. A lição transferível — "a estratégia é escolhida por medição e uma feature pode declarar que precisa do quadro inteiro" — nós já praticamos (`world` cai para repintura quando o bake não cabe). |
| **Providers + ABI de DLL** | Resolvem hot reload e pacotes de terceiros num binário C++ compartilhado. Nosso equivalente é o binding JS + `E.caps`; adotar ABI aqui só adicionaria cerimônia. A lição de política vale: **não substituir em silêncio** (vira A4). |
| **Packs `DPAK` + GUID de 36 chars** | O asset deles é global (editor, várias cenas); o nosso é por app, 16 arquivos, 128 KB cada. Um pack precisaria de suporte no firmware para valer, e o orçamento atual cabe. Se um dia houver referência de arte dentro de cena, usar **nome estável**, não GUID. |
| **Duas contagens de FPS, `Profiler.h` no-op, `m_IsDirty` morto, `0 = sem limite` virando 30** | Armadilhas que eles mesmos deixaram: `Time::GetFPS` (janela de 1 s) e `FPSCounter` (30 quadros) medem coisas diferentes e um deles não tem chamador; os macros do profiler expandem para nada; o dirty flag do engine é escrito e nunca consultado; `SetTargetFPS(0)` vira 30 enquanto `ProjectSettings` documenta 0 = sem limite. Não importar ambiguidade. |

---

## 6. Armadilhas do deki que valem como aviso

Se algum dia copiarmos o modelo de cena/refs, estes são os erros que eles
cometeram e documentaram — cada um é uma linha de teste a mais no nosso lado:

1. **`dt` sem clamp**: light sleep dentro do `Tick()` entrega um delta enorme à
   física (`src/Engine.cpp:272-283,449-458`). Nós clampamos em 0,1 s; manter.
2. **Referência que resolve uma vez**: alvo criado depois (spawn) fica nulo para
   sempre (`src/LifecycleManager.cpp:123,136`). Nosso `ref` tem que re-resolver.
3. **Cache de componentes não invalidado** em `AddComponent`/`SetActive`: o
   componente novo pode nunca rodar (`include/deki/Object.h:324-347`). Se
   fizermos registry de tipos, registrar/invalidar é obrigatório.
4. **Mutação durante a iteração**: eles copiam ponteiros por fase porque o
   usuário pode reconstruir a lista viva (`src/LifecycleManager.cpp:111-118`);
   mas o snapshot não protege contra *destruir* — use-after-free. Nosso
   `group.update` itera ao contrário com swap-pop e está correto para o `dead`,
   mas `remove()` de dentro do update corrompe (ver A0).
5. **Troca de cena com pico de memória**: eles passaram a liberar a cena velha
   antes de iniciar a nova porque as duas juntas estouravam a RAM interna
   (commit `3e2ac3c`, `src/Engine.cpp:572-585`). Em JS o GC decide, mas o
   `dispose()` (A3) é o nosso jeito de não segurar as duas.

---

## 7. Ordem sugerida

| Ordem | Item | Custo enxuto (est.) | Por que agora |
|---|---|---:|---|
| 1 | A0 `group.remove` no update | ~120 B | Bug reproduzível: despawn com `remove` duplica/triplica update |
| 2 | A2 perfilador | ~1,5 KB | Toda otimização futura depende de saber onde o tempo vai |
| 3 | A1 pacing | ~0,4 KB | Barato e corrige um número que o overlay mostra errado |
| 4 | A3 `dispose` + ledger de slots | ~0,7 KB | Bug de campo com 1 slot na CYD |
| 5 | A4 falha barulhenta | ~0,2 KB/módulo | Custo quase zero, melhora todo diagnóstico |
| 6 | A5 âncoras | ~0,8 KB | Portabilidade entre vidros |
| 7 | A6 metadados de arte | ~1,5 KB (`spr`) | Desbloqueia iteração de arte |
| 8 | B1 `celeros.game.scene` | ~5–6 KB (módulo) | Maior ganho funcional; precisa de desenho próprio antes de código |

A0–A5 somam ~3,7 KB no core — que hoje **não cabem** num jogo só-core sem PSRAM
(864 B de folga). Ou entram como módulo (`celeros.game.prof`, `celeros.game.hud`),
ou entram junto com uma dieta do core. Candidatos naturais a sair do core, se a
dieta for necessária: `E.audio` (~145 linhas), `E.save` (~85) e os véus de
transição (~90) — todos com API própria e baixo acoplamento, e todos com o custo
de virar dep (teto de 8 deps diretas, `tools/app_lint/lint.js:864`).

**Estado em 2026-10-25:** A0–A6 **implementados** (core 1.5.0, spr 1.6.0,
world 1.1.1, shim 1.7.0). O custo medido foi 3.699 B no core — o core foi de
48.288 B para **51.987 B enxutos** e passou do teto de 48 KB: app com a engine
agora declara `"requires": ["psram"]`. Na prática nada quebrou (as 11 apps do
catálogo que usam a engine já declaravam psram e nenhuma roda na CYD), mas o
"jogo só-core sem PSRAM" deixou de existir; a dieta do core (mover `E.audio`/
`E.save`/véus para módulos) fica como o caminho para reabrir esse espaço.

**B1 também implementado** (na sequência direta deste estudo):
`celeros.game.scene` 1.0.0 — cena e prefab como dado, num módulo novo (o core
não mudou). Traduziu o desenho do deki sem reflexão nem MessagePack: `def()`
com campos/defaults/rename, `instantiate` em três fases (cria → resolve as
refs → `start`), save/load JSON com `version` + migração registrada e extras
preservados. O que **não** veio: ids determinísticos por instância (aqui a
referência é por nome, que é o que um arquivo escrito a mão aguenta) e a
resolução de ref *one-shot* deles (aqui `resolve()` re-resolve o que nasceu
depois). O guia (§14f, EN e pt-BR) documenta o formato.

---

## 8. Referências

**deki-engine** (clone local, verificado): `README.md`, `src/Engine.cpp`,
`src/LifecycleManager.{h,cpp}`, `src/Scene.cpp`, `src/SceneMessagePack.cpp`,
`src/Object.cpp`, `src/assets/*`, `src/providers/*`, `include/deki/**`,
`CHANGELOG.md` (histórico das decisões), commits `eacaea6`, `b002a51`, `3e2ac3c`,
`c265141`, `0734ad7`.

**deki-rendering / deki-2d / deki-editor**: consultados no GitHub master
(`04a1d11`), não clonados — strip rendering, blitter, sorting e clip.

**CelerOS**: `tools/sdk/engine/*.js`, `main/Runtime/JsGfx.cpp`,
`main/Runtime/JsSystem.cpp`, `tools/celerhub.py`, `tools/app_lint/lint.js`,
`Documentation/Game_Engine_Guide.pt-BR.md`, `Documentation/ENGINE_NOTES.md`.
