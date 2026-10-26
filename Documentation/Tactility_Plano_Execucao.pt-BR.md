# Tactility → CelerOS: plano de execução

**Português (BR)** · 2026-10-25 · Derivado de `Tactility_Analise.pt-BR.md`
Estado: **Fase 0/1 (código e builds) concluídas · Fase 2: itens 1, 3, 4 e 6 ·
Fase 3: item 1 (código) · bench pendente**

Este documento transforma o estudo em trabalho executável. A ordem, o porquê e
as referências de código estão no estudo; aqui ficam os passos, os arquivos, os
commits e os gates.

## Como este plano funciona

- Uma fase por vez. Cada item numerado = **um commit local** (PT sem acento,
  `Area: assunto`, corpo com a medição) + gates + bench quando a mudança é de
  runtime.
- **Sem push** sem pedido explícito. Bench é gate humano: a fase só fecha com o
  número medido na placa.
- Cada item declara **validação** e **rollback**. Config de IRAM/PSRAM é
  reversível com uma linha; código de Fase 2/3 não é — por isso a fase 1 vem
  primeiro e sozinha.
- Alterações de terceiros na árvore (`tools/sdk/celer.js`,
  `tools/sdk/engine/celeros.game.js`, `tools/sdk/lib/icon.js`,
  `tools/studio/`, `Documentation/DekiEngine_Estudo.pt-BR.md`,
  `dependencies.lock`) não entram em nenhum commit deste plano.

---

## Fase 0 — Correções e base documental (concluída)

- [x] **esp32-cam fora do conjunto "sem PSRAM"**: tem PSRAM quad de 4 MB e é
      dual-core (`boards/esp32-cam/sdkconfig.defaults:1-6,55-58`); o conjunto
      correto é **cyd, cyd-vspi, devkit**.
- [x] **`CONFIG_HEAP_PLACE_FUNCTION_INTO_FLASH=y` é proibida no CYD/devkit**:
      o próprio `boards/cyd/sdkconfig.defaults:83-85` registra malloc/free na
      IRAM de propósito (compile do Duktape 1,6 s → 3,1 s com o heap na flash).
- [x] **Reclassificação das 12 candidatas**: 3 aplicáveis, 7 invisíveis sem
      `SPI_FLASH_AUTO_SUSPEND` (linha no-op), 1 sob medição
      (`RINGBUF_PLACE_ISR...`), 1 proibida (`HEAP_PLACE...`).
- [x] Builds canônicos conferidos com `tools/sdkconfig_check.py`
      (`build`, `build-cyd`, `build-devkit`, `build-dog`, `build-watch`,
      `build-devkit-s3`, `build-esp32-cam` ok).
- [x] `build-cyd-vspi` regenerado do zero (estava de 16/out, com stack 32 KB e
      web server ligados) e os 4 bins que precediam o fonte de 23:08 (24/out)
      foram remontados; o baseline agora é de HEAD.

---

## Fase 1 — Onda 1: RAM, flash e boot

### 1.1 Baseline e teto de crescimento — commit `CI: teto de crescimento de flash por release`

Passos:

1. Rebuild das 8 placas no estado atual (bins de 24/out já conferem, exceto
   `cyd-vspi`).
2. `python3 tools/size_report.py --save-baseline tools/size_baseline.json`.
3. `tools/size_report.py`: novo par
   `--check-budget <json> --max-growth-kb <N>` (default 8):
   - compara `image` medido com o baseline por placa;
   - falha se crescer acima de N KB;
   - falha se a placa não existir no baseline (placa nova obriga a atualizar o
     baseline de propósito);
   - mantém `--min-free-kb 64` como está.
4. CI: no step "Orcamento do slot OTA" (`build.yml:119-129`), acrescentar
   `--check-budget tools/size_baseline.json --max-growth-kb 8`.
5. Validar local: `--check-budget` contra o baseline recém-gerado (passa) e um
   teste negativo (baixar o teto para 0 e ver falhar).

Arquivos: `tools/size_report.py`, `tools/size_baseline.json` (novo),
`.github/workflows/build.yml`, `test/` (caso host para a lógica de comparação,
se extraída em função pura).

Rollback: reverter o commit; o gate de 64 KB continua valendo.

### 1.2 IRAM no CYD/cyd-vspi/devkit — commit `CYD: libera IRAM de perfil para o heap do JS`

**Correção de rota (medida no build):** das 12 opções do Tactility, só **3**
têm prompt incondicional no Kconfig do IDF 6.1 e portanto aplicam de verdade.
As outras 7 (`ESP_TIMER/SYSTEM/INTR/HW_SUPPORT_IN_IRAM`,
`SPI_FLASH_PLACE_FUNCTIONS_IN_IRAM`, `LOG_IN_IRAM`, `LIBC_MISC_IN_IRAM`) são
`bool "..." if SPI_FLASH_AUTO_SUSPEND` — sem auto-suspend a linha em
`sdkconfig.defaults` é no-op (e o Tactility também não liga auto-suspend).
Aplicado:

```
# CONFIG_ESP_PHY_IRAM_OPT is not set
# CONFIG_WIFI_RMT_IRAM_OPT is not set
# CONFIG_WIFI_RMT_RX_IRAM_OPT is not set
```

Ficam de fora: `RINGBUF_PLACE_ISR_FUNCTIONS_INTO_FLASH` (medir com soak; ISR) e
`HEAP_PLACE_FUNCTION_INTO_FLASH` (proibida; heap na flash dobra o compile do
Duktape).

Arquivos: `boards/cyd/sdkconfig.defaults`, `boards/cyd-vspi/sdkconfig.defaults`,
`boards/devkit/sdkconfig.defaults`.

Procedimento:
1. Apagar `build-cyd/sdkconfig`, `build-cyd-vspi/sdkconfig`,
   `build-devkit/sdkconfig` (regeneram dos defaults).
2. `python3 tools/sdkconfig_check.py build-cyd build-cyd-vspi build-devkit`.
3. Build local de `cyd` e `devkit` (e `cyd-vspi` se o build anterior fechar).
4. `python3 tools/size_report.py --board cyd --min-free-kb 64` etc.
5. Conferir no `build-*/sdkconfig` que as 3 opções estão `is not set` (as outras
   7 continuarão `=y` por construção — é o esperado).

Validação no bench (gate): heap interno e IRAM livres ≥ +8 KB no CYD, boot,
Wi-Fi/OTA, log, toque e `lcddma` limpo.

Rollback: uma linha por opção; cada uma é independente.

### 1.3 Memtest de PSRAM — commit `S3: desliga memtest de PSRAM no boot`

`CONFIG_SPIRAM_MEMTEST=n` em `boards/smartdisplay`, `boards/spotpear-dog`,
`boards/waveshare-watch`, `boards/devkit-s3`, `boards/esp32-cam`.
Não vai no root: evita símbolo inexistente nas placas sem PSRAM.

Procedimento: apagar o `sdkconfig` desses builds, build do smartdisplay,
`size_report --board smartdisplay`.

Bench: tempo de boot pelo log (`uptime`/primeira linha), soak de 10 min.

Rollback: remover a linha e regenerar o `sdkconfig`.

### 1.4 XIP/rodata/fetch — commit `S3: instrucoes e rodata na PSRAM (experimento smartdisplay)`

Somente `boards/smartdisplay`:

```
CONFIG_SPIRAM_FETCH_INSTRUCTIONS=y
CONFIG_SPIRAM_RODATA=y
CONFIG_SPIRAM_XIP_FROM_PSRAM=y
```

Gate antes de propagar para dog/watch: `lcddma` limpo, fps estável, boot e soak
de 30 min com Loja baixando + jogo. Se o painel RGB perder estabilidade,
**reverter este commit** (o Tactility também desabilita em placas específicas,
`device.py:262-268`).

### Resultado do build (2026-10-25)

- [x] 8 placas compiladas com os novos defaults; `sdkconfig_check` ok nas 8.
- [x] `--check-budget` contra o baseline: rc=0; maior delta +1.872 B
      (smartdisplay); as outras placas encolheram ou ficaram iguais.
- [x] Imagens (bytes): smartdisplay 2.661.136; cyd 1.556.816; cyd-vspi
      1.508.192; dog 2.504.688; watch 2.770.000; devkit 1.323.072;
      devkit-s3 1.849.008; cam 1.762.592. CYD segue com **81.584 B livres**.
- [x] `sdkconfig` gerado confirma as 3 opções IRAM no CYD/cyd-vspi/devkit,
      `SPIRAM_MEMTEST` off nas 5 placas com PSRAM e XIP on no smartdisplay.
- [ ] Bench (heap/IRAM, boot, `lcddma`, soak) — pendente; roteiro abaixo.
- [ ] Atualizar o baseline depois do bench aceito (commit próprio), para a
      Fase 2 começar com o teto zerado.

### 1.5 Fechamento

- [ ] Preencher a tabela Antes/Depois do estudo com os números do bench.
- [ ] Entregar o roteiro de bench abaixo, com os valores medidos.
- [ ] **Parada obrigatória**: sem os números do CYD e do SmartDisplay não se
      decide a Fase 2.

---

## Fase 2 — Onda 2: robustez e velocidade de evolução

Só começa com "go" depois do bench da Fase 1. Um commit por item (ou por área,
quando o item é uma migração mecânica).

**Status (2026-10-25):** feitos os itens 1 (Mem.h), 3 (Settings), 4 (boards.json)
e 6 (RAM baixa); pendentes 2 (FlashIo), 5 (capabilities), 7 (start/stop) e 8
(auditoria de timers). O FlashIo fica para depois do bench: é o item que o
`lcddma` valida. O bench da Fase 1 segue aberto e é o gate do XIP/IRAM, não
destes itens.

Build da Onda 2 (cyd/smartdisplay/devkit): 1.557.808 / 2.662.464 / 1.324.256 B,
ou +992 / +3.200 / +1.184 B sobre a Fase 1 — dentro do teto de 8 KB. CYD segue
com **80.592 B livres** no slot.

1. **`Utils/Mem.h`** — feito: `mem::alloc(size, desired, required = Any)`
   header-only (precedente `TaskCaps.h`); `Psram` prefere PSRAM e cai para 8-bit,
   `required` é o piso, OOM devolve `nullptr`. Migrados os 7 pares claros em
   `JsPack`, `JsModules`, `JsPhysics`, `JsRigid`, `CelerKernel` (só o caminho
   PSRAM→8-bit), `Icon` e `OtaManager`. O caminho `PSRAM→IRAM_8BIT→8BIT` do
   fonte do `CelerKernel` **não** foi tocado (a IRAM-as-heap do CYD é
   deliberada). Sem contadores nesta rodada.
2. **`FileSystem/FlashIo`** — worker único com pilha interna, fila, staging em
   PSRAM e `screenSafeWindow()` por `ScreenPower::state()` (0 off/1 AOD).
   Escrita ≤4 KB continua síncrona; acima disso delega e espera janela com
   timeout, registrando flush de emergência. `LogPersist` migra para a camada.
   Validação: `lcddma` com Loja baixando + jogo, teste host da fila, telemetria.
3. **Settings tipado** — feito: `Settings::{h,cpp}` com tabela de 15 chaves
   (default + faixa), `getBool/getInt/getStr`, `setIntDebounced` (2 s, tick no
   serviço `settings`, flush no deep sleep) e `migrate()` central no boot
   (import dos `.txt` + `settings_ver=1`). Migrados Backlight, BoardIO,
   ScreenPower, LauncherUI, Notifications, PhoneLink, CelerNet e
   WebManager/JsSystemApps. Chave desconhecida segue string (compat com
   `System.setting`). Correção preservada: `web_on` sem chave continua false.
4. **`boards/boards.json` + `tools/gen_boards.py`** — feito: fonte única
   validada (`--check`) contra defaults/`Board.cpp`/CSV/canal de OTA, matrix do
   CI, `flash_data.sh` e `CELEROS_BOARD` do CMake (não do Kconfig — o Kconfig
   guarda as flags de feature). `size_report.BOARDS` vem do manifest; o
   `cyd-vspi` entrou no `flash_data.sh`. YAML/shell seguem estáticos: a
   validação é o gate, não geração.
5. **Capabilities no `BoardProfile`** — `fullFrame`, `preferExternal`,
   `slowRefresh`, `swapXY`, `mirror`, `mono`; remover branches de placa de
   `Kui`/`Icon`/`FrameSprite`/`ScreenPower`; teste host de geometria.
6. **Aviso de RAM interna baixa** — feito: `MemWatch::classify` puro (10 KB
   livres / 2 KB maior bloco, re-arme em 14 KB), serviço ALWAYS 1 Hz e
   `heap.low` no KL_STATS (o `celerctl stats/top` mostra "RAM INTERNA BAIXA").
   **Sem toast**: `Navigator::toast` recebe `std::string` e pode abortar
   justamente sob RAM baixa; o aviso fica no log + stats. Indicador no topbar
   fica para a rodada de capabilities.
7. **Contrato start/stop nos serviços** — hooks opcionais em `struct Service` e
   `startAll/stopAll` no boot/sleep; migrar web, malha e PhoneLink primeiro.
8. **Auditoria de timers nativos** — mapear callbacks `esp_timer` (áudio, mic,
   OTA) e corrigir corrida de teardown se existir.

---

## Fase 3 — Onda 3: velocidade de desenvolvimento e UX

Só começa com "go" e prioridade escolhida.

**Status (2026-10-25):** item 1 (catálogo compacto) implementado no servidor
(`7ade402`) e no app (`12490ae`); deploy do hub e publish da Loja pendentes, na
ordem do item. Demais itens não iniciados.

1. **Catálogo compacto da Loja** — **feito no código, deploy/publicação
   pendentes.** `CelerOS-Server`: rota `/store/all.txt` (TSV, 14 campos/app,
   cabeçalho + `#end N`, `vary: Authorization`, HUB_VERSION 0.15.2) e casos em
   `tools/test_api.py`. CelerOS: a Loja tenta o TSV antes do `all.json`/
   categorias, valida o `#end` e cai no caminho antigo em qualquer falha;
   descrição/autor vêm do `app.json` no primeiro toque; multi-arquivo busca o
   `files` no install. Versão 2.9.6 + 7 checks no `js_harness`.
   **Ordem manual: deploy do hub (tag 0.15.2) → `celer.js publish` da Loja.**
   Publicar antes do deploy é seguro (o app cai no fallback), mas consome a
   versão sem o ganho.
2. **Simulador host** — `test/host_ui/` com CMake próprio, `lgfx::Panel_sdl` e
   uma `Screen` do Kui; PNG por frame para diff visual; job de CI opcional.
3. **Fatias de firmware em teste host** — Kui (geometria/hit-test/foco), parser
   do catálogo, `JsFsJail`, migração de settings.
4. **`launchApp(pkg, args)` + resultado** (API 51) — slot de resultado por app
   no `present()`, doc EN/pt-BR, `celer.js types`, harness e lint.
5. **i18n por catálogo** — gerador, `T(key)`/`L(key)`, tela de idioma; limite
   Latin-1 documentado.
6. **Debug bridge** — desafio HMAC do token (segredo não trafega), cliente no
   `celerctl`, `test/test_celerctl.py`.
7. **`binfont`** — medir o custo real das fontes por placa antes; spike com uma
   fonte e adapter `lgfx::IFont`; go/no-go explícito.
8. **Acabamento** — tema mono/pistas do dog, `Documentation/ideas.md`,
   `THIRD-PARTY-NOTICES.md` (Tactility Apache-2.0/GPL-3.0).

---

## Gates (todo commit)

```bash
node test/js_harness/run.js
node test/app_lint/run.js
node test/sdk/run.js
node test/debug/run.js
node test/semver/run.js
node test/meshsim/run.js
node tools/app_lint/lint.js data/apps hub_apps boards/*/data/apps
node test/public_boundary/run.js
node tools/sdk/celer.js check
python3 tools/celerhub.py deps-status
g++ -std=c++17 -Wall -Wextra -DCELER_HOST_TEST -o celeros_tests \
  test/cpp/run_tests.cpp main/Utils/AppZip.cpp main/Utils/AppPackage.cpp \
  main/USBHost/UsbDesc.cpp && ./celeros_tests
python3 test/duk/run.py
python3 tools/size_report.py --board <b> --min-free-kb 64 \
  --check-budget tools/size_baseline.json --max-growth-kb 8
```

Se a API JS mudar: `node tools/sdk/celer.js types` no mesmo commit.
Se `sdkconfig.defaults` mudar: apagar o `sdkconfig` do build e rodar
`python3 tools/sdkconfig_check.py`.

## Bench (roteiro)

Antes e depois, por placa (mínimo CYD + SmartDisplay):

```bash
python3 tools/celerctl.py info
python3 tools/celerctl.py top -w
python3 tools/celerctl.py stats
python3 tools/celerctl.py shell "lcddma"      # SmartDisplay
python3 tools/celerctl.py apps store <pkg>    # soak: escrita de flash + rede
```

Registrar: heap interno, IRAM livre, fps, tempo de boot, eventos de embaralhada.
Critérios: +8 KB heap e +8 KB IRAM no CYD; boot ≤85% do atual; 0 embaralhadas
em 30 min; OTA assinado no fim.

## Regras

- Commits locais, seletivos (`git add <paths>`), sem `-A`, sem push sem pedido.
- Nada de mudar tabela de partições nesta rodada (não é OTA-ável).
- Se um número não melhorar, reverter a linha no mesmo dia.
- Fase 2/3 não começam por arrasto: precisam de "go" explícito.
