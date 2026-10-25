# Tactility → CelerOS: o que aproveitar

**Português (BR)** · 2026-10-25 · Tactility `0.8.0-dev` (commit `7ab1c1f2`, `v0.7.0-153`) × CelerOS `1.11.6` (API 50)

Este documento compara o Tactility — um OS para ESP32 com apps nativos em C/C++ e
LVGL 9 — com o CelerOS, e separa o que **vale trazer**, o que **vale adaptar**, o
que **precisa ser medido antes** e o que **não deve ser copiado**. Não é uma
defesa de reescrita: os dois produtos têm modelos opostos, e a maior parte do
valor está em mecanismos pequenos e em disciplina de RAM/flash que o Tactility já
pagou para descobrir.

Referências de código aparecem como `arquivo:linha`, sempre relativas à raiz de
cada repositório.

---

## 1. Sumário executivo

**O que o Tactility é.** Um kernel em C (device/driver/module, devicetree gerado
em build) com uma camada de sistema em C++ sobre LVGL: apps de terceiros são
**ELF nativos** carregados do cartão SD, resolvidos contra tabelas estáticas de
símbolos (~1.350 símbolos somando kernel, libc, libstdc++, FreeRTOS e ESP-IDF).
São 63 perfis de placa, 29 módulos e 81 drivers (`Devices/`, `Modules/`,
`Drivers/`).

**O que o CelerOS é.** Um firmware cooperativo com **apps em JavaScript (ES5,
Duktape)**, UI imediata própria (LovyanGFX + Kui), 8 placas, hub de apps com
dependências e drift gates, e **OTA assinado com ECDSA P-256**. Não há scheduler
de apps, processo, IPC nem ABI nativa; o isolamento é o heap do Duktape
(`main/Kernel/Core/CelerKernel.cpp:212-226`).

**Conclusão.** Copiar a arquitetura do Tactility (LVGL, ELF, devicetree,
module ledger) custaria uma reescrita e destruiria exatamente os diferenciais do
CelerOS (sandbox JS, permissões, hub, OTA assinado). O que **realmente** vale:

| Categoria | Itens | Por que vale |
|---|---|---|
| **Tuning já pago** | 3 opções IRAM efetivas (de 12 candidatas) em placa sem PSRAM; `SPIRAM_MEMTEST=n`; experimento `SPIRAM_FETCH_INSTRUCTIONS/RODATA/XIP` | O CYD tem só **79 KB livres** no slot OTA e a IRAM livre é heap do Duktape — cada KB conta |
| **Mecanismos pequenos e isolados** | worker de I/O de flash + política de vidro; alocação por capacidade; settings atômico/tipado; catálogo compacto; `binfont`; capabilities de display; aviso de RAM baixa; i18n por catálogo; `launchApp` com argumentos/resultado | Tudo cabe no modelo atual, sem tocar no sandbox |
| **Práticas de engenharia** | `device.properties` como fonte única; testes doctest rodando o kernel real no host; simulador com o código real; `ideas.md`; `THIRD-PARTY-NOTICES.md` | Reduzem o custo de evoluir 8 placas e a dependência de bancada manual |

**As cinco coisas que eu levaria primeiro** (detalhe na Onda 1 e 2):

1. As 3 opções IRAM efetivas em placa sem PSRAM (as outras 9 do conjunto do
   Tactility são no-op ou contraindicadas, `device.py:189-196`) — no CYD isso é
   heap direto para apps.
2. `CONFIG_SPIRAM_MEMTEST=n` nas placas S3 (o Tactility chama de "boot speed
   optimization", `device.py:232`); o CelerOS roda com `=y`.
3. Uma camada única de I/O de flash com staging em PSRAM e gate de vidro —
   generalizando o que o `LogPersist` já faz e que custou a saga do painel RGB
   embaralhado (`main/USBDevice/LogPersist.cpp:37-39,262-265`).
4. Helper de alocação por capacidade (`requerido`/`desejado`) no lugar dos 89
   usos ad hoc de `heap_caps_malloc` em 31 arquivos — o `MemoryPolicy` do
   Tactility (`TactilityKernel/include/tactility/memory.h:13-41`) é o molde.
5. Catálogo da Loja em texto compacto (`catalog.txt`/TSV), como o App Hub deles
   (`Modules/app-hub-module/source/app_hub_catalog.cpp:137`): o `all.json` de
   ~58 KB é cortado em 32 KB no sem-PSRAM e força 5 requisições por categoria
   (`data/apps/App Store/main.js:597-610`).

---

## 2. Como ler este documento

| Marca | Significado |
|---|---|
| **[ADOTAR]** | Mecanismo que cabe no CelerOS como está; baixo risco |
| **[ADAPTAR]** | A ideia serve, a implementação precisa ser reescrita no estilo CelerOS |
| **[MEDIR]** | Só faz sentido com número antes/depois na bancada; não decidir no papel |
| **[OPÇÃO]** | Trade-off real (flash × RAM × UX); decisão de produto, não de engenharia |
| **[REJEITAR]** | Custo ou consequência incompatível com o CelerOS |
| **[JÁ TEMOS MELHOR]** | O CelerOS já resolve melhor; serve de guarda-corpo |

Esforço: **S** ≤ 1 dia, **M** 2–5 dias, **L** > 1 semana (inclui bancada).

---

## 3. Os dois sistemas lado a lado

| Dimensão | Tactility 0.8.0-dev | CelerOS 1.11.6 (API 50) |
|---|---|---|
| Modelo de app | Pacote `.app` (tar + `manifest.properties`), binário **ELF nativo** por app; símbolos resolvidos no load (`Modules/app-module/source/install.cpp`, `Modules/app-esp32-module/source/app_esp32_loader_service.cpp`) | Pasta com `app.json` + JS ES5 (Duktape); `require()` com deps do hub; permissões de 8 bits com consentimento (`main/Runtime/`, `main/Utils/AppPerms.h`) |
| Isolamento | Nenhum de memória; "processo" = task FreeRTOS com fd table, cwd e env virtuais; `exit()` vira fim de task (`Modules/app-module/source/scheduler.cpp`) | Sandbox Duktape + jail de FS + permissões; sem isolamento de CPU/RAM por app |
| UI | LVGL 9.6 retido + window manager com **só a janela do topo viva** (`Modules/lvgl-window-manager-module/`) | LovyanGFX + **Kui imediato**; frame cheio em PSRAM ou bandas no CYD; dirty rects de 32 caixas no app (`main/Display/FrameSprite.h:44`) |
| Kernel/serviços | device/driver/module em C, devicetree gerado em build, hotplug com probe e debounce (`TactilityKernel/`) | Tabela estática ordenada de ~20 serviços com 3 modos de pump (`main/Kernel/Services.cpp:124`) |
| Placas | 63 perfis `device.properties` + `.dts`; `device.py` gera o `sdkconfig` inteiro | 8 placas; `boards/<b>/sdkconfig.defaults` + `CMakeLists.txt` + Kconfig + CI + `size_report` + `flash_data.sh` |
| Armazenamento | FAT interno ou SD; settings em `.properties` com escrita atômica; apps em `<raiz>/tactility/app/<id>` | LittleFS `/local` + FAT `/sd`; NVS para settings e por app (`main/FileSystem/`, `components/Storage/NVS.h`) |
| Distribuição | App Hub (catálogo JSON → `catalog.txt` TSV) + dev server mTLS; **sem assinatura de pacote** | Hub com deps, drift gates e catálogo; **sem assinatura de app** |
| Atualização de firmware | **Não existe** (`Documentation/ideas.md`, "Nice-to-haves: OTA updates"); flash manual/esptool | **OTA v2 assinado** ECDSA P-256, SHA-256, retomada por `Range`, rollback (`main/OTA/OtaManager.cpp:119-244`) |
| Segurança | Trust no TLS do CDN; dev server com mTLS e fingerprint; Wi-Fi com AES-256-CBC | OTA assinado; hub+TLS; permissões; debug bridge com token de 8 chars em TCP 5555 (`main/USBDevice/DebugBridge.cpp:63-94`) |
| Testes | doctest rodando o **kernel real** num port FreeRTOS POSIX (`TactilityKernel/tests/source/main.cpp:21-30`); simulador SDL com o firmware real | 10 suítes host + emulador Node que **reimplementa** a API; CI compila 8 placas; bancada manual |
| Energia | power supply/sleep controller por device; autorotate; display idle; sem DVFS documentado | DFS + light sleep (watch), AOD, raise-to-wake, ULP, deep sleep por inatividade (`main/Hardware/PowerPolicy.*`, `main/Display/ScreenPower.*`) |
| i18n | enum gerado + linhas `.i18n`, **dormente** (`Tactility/Source/i18n/TextResources.cpp:39-58`) | `i18n::TR(pt,en)` em poucas strings; apps em PT; fontes Latin-1 |

**Consequência prática.** O Tactility é uma referência de *como organizar* um OS
de apps nativos; o CelerOS é um OS de apps em script com entrega e atualização
resolvidas. Quase nada do primeiro é transplantável como arquitetura; muita coisa
é transplantável como **disciplina de recurso** e como **mecanismo isolado**.

---

## 4. Licenças, atribuição e postura de reuso

O Tactility não tem uma licença só:

| Caminho | Licença | O que inclui |
|---|---|---|
| `TactilityKernel/`, `TactilityFreeRtos/`, `Platforms/`, `Translations/` | **Apache-2.0** (arquivos `LICENSE-Apache-2.0.md`; fontes com `SPDX-License-Identifier: Apache-2.0`) | device/driver/module, memória por capacidade, `file_ops`, `properties_file`, `preferences`, `Timer`, wrapper FreeRTOS, compilador DTS |
| `Modules/`, `Drivers/` | **Apache-2.0** por SPDX nos fontes (ex.: `binfont`, `app-module`, `app-hub`, `lvgl-module`, `rgb-display-module`, `install.cpp`) | bibliotecas, loaders, bridges LVGL, drivers |
| `Tactility/` | **GPL-3.0** (`Tactility/LICENSE-GPL-3.0.md`) | camada de sistema: serviços, apps embutidos, settings, i18n, chrome |
| raiz `LICENSE.md` | GPL-3.0 (padrão do projeto) | o que não tiver licença própria |

O CelerOS é **GPL-3.0** (`LICENSE`), então código GPL-3.0 do Tactility também
seria compatível — mas a maior parte do que interessa (kernel, módulos, drivers,
binfont) é **Apache-2.0**, o que simplifica: basta preservar o aviso de copyright
e indicar mudanças.

**Postura recomendada (aprovada):** padrões primeiro, código pontual.

- Reimplementar no estilo CelerOS tudo que toca o modelo de app, UI e serviços.
- Portar código apenas onde for **isolado e verificável**: `binfont` + adapter
  para LovyanGFX, `properties_file` (escrita atômica) se um dia substituir
  arquivos de config, e listas de configuração (IRAM/PSRAM) que são só dados.
- Criar `THIRD-PARTY-NOTICES.md` no CelerOS (não existe hoje) citando Tactility,
  caminho do arquivo original, licença e o que foi modificado — é o que o próprio
  Tactility faz em `THIRD-PARTY-NOTICES.md`.
- Nunca copiar `Tactility/` (GPL-3.0) para dentro de ferramentas que possam virar
  produto separado sem revisar a licença.

---

## 5. Onda 1 — RAM, flash e boot (baixo risco, medível)

Objetivo: ganhar folga onde ela é existencial — o CYD (sem PSRAM, slot OTA de
1.638.400 B com **81.584 B livres** no binário de HEAD, 1.556.816 B) e a RAM
interna das placas S3. Nada aqui muda arquitetura.

### 5.1 Opções IRAM em placas sem PSRAM — **[ADOTAR] [MEDIR]**

O Tactility desliga, em placas sem PSRAM, um conjunto de opções que colocam
código na IRAM (`device.py:270-289`):

```
CONFIG_ESP_PHY_IRAM_OPT=n
CONFIG_LOG_IN_IRAM=n
CONFIG_ESP_TIMER_IN_IRAM=n
CONFIG_ESP_INTR_IN_IRAM=n
CONFIG_ESP_SYSTEM_IN_IRAM=n
CONFIG_LIBC_MISC_IN_IRAM=n
CONFIG_ESP_HW_SUPPORT_FUNC_IN_IRAM=n
CONFIG_SPI_FLASH_PLACE_FUNCTIONS_IN_IRAM=n
```

Além disso, o perfil padrão deles desliga **todas** as variantes de Wi-Fi na IRAM
(`Buildscripts/sdkconfig-default.properties:14-21`), incluindo
`ESP_WIFI_EXTRA_IRAM_OPT`, `ESP_WIFI_SLP_IRAM_OPT`, `WIFI_RMT_IRAM_OPT`,
`WIFI_RMT_RX_IRAM_OPT` e `WIFI_RMT_EXTRA_IRAM_OPT`.

O CelerOS hoje desliga apenas `ESP_WIFI_IRAM_OPT` e `ESP_WIFI_RX_IRAM_OPT`
(`boards/cyd/sdkconfig.defaults`, `boards/devkit/sdkconfig.defaults:62-63`). O
`build-cyd/sdkconfig` gerado ainda tem **ligados**:

| Opção | Linha no `build-cyd/sdkconfig` |
|---|---|
| `CONFIG_ESP_HW_SUPPORT_FUNC_IN_IRAM=y` | 1296 |
| `CONFIG_ESP_INTR_IN_IRAM=y` | 1467 |
| `CONFIG_LIBC_MISC_IN_IRAM=y` | 1487 |
| `CONFIG_ESP_PHY_IRAM_OPT=y` | 1583 |
| `CONFIG_ESP_SYSTEM_IN_IRAM=y` | 1685 |
| `CONFIG_ESP_TIMER_IN_IRAM=y` | 1751 |
| `CONFIG_WIFI_RMT_IRAM_OPT=y` | 1983 |
| `CONFIG_WIFI_RMT_RX_IRAM_OPT=y` | 1987 |
| `CONFIG_LOG_IN_IRAM=y` | 2432 |
| `CONFIG_SPI_FLASH_PLACE_FUNCTIONS_IN_IRAM=y` | 3137 |

Além dessas, duas que o CelerOS tem desligadas — ou seja, com as funções
residentes na IRAM — e que o Tactility manda para a flash no ESP32 clássico.
O conjunto **não é todo equivalente** para o CelerOS:

| Classe | Opções | Por quê |
|---|---|---|
| **Aplicar (3)** | `ESP_PHY_IRAM_OPT`, `WIFI_RMT_IRAM_OPT`, `WIFI_RMT_RX_IRAM_OPT` | São as únicas das 12 com prompt incondicional no Kconfig do IDF 6.1. Aplicadas e medidas no CYD/cyd-vspi (imagem não muda: o código passa de IRAM para flash) |
| **Invisíveis sem `SPI_FLASH_AUTO_SUSPEND` (7)** | `ESP_TIMER_IN_IRAM`, `ESP_SYSTEM_IN_IRAM`, `ESP_INTR_IN_IRAM`, `ESP_HW_SUPPORT_FUNC_IN_IRAM`, `SPI_FLASH_PLACE_FUNCTIONS_IN_IRAM`, `LOG_IN_IRAM`, `LIBC_MISC_IN_IRAM` | No IDF 6.1 são `bool "..." if SPI_FLASH_AUTO_SUSPEND` (ex.: `esp_timer/Kconfig:3-5`, `esp_system/Kconfig:12-14`, `esp_libc/Kconfig:46-48`). Sem auto-suspend ficam no default e a linha em `sdkconfig.defaults` **não faz nada**. O Tactility também não liga auto-suspend (`Buildscripts/` e `device.py` não o citam), então essa parte da lista deles é inócua no ESP32 clássico |
| **Medir isolado (1)** | `RINGBUF_PLACE_ISR_FUNCTIONS_INTO_FLASH` (`build-cyd/sdkconfig:1611`) | Configurável de verdade; põe ISR de ringbuf na flash — só com soak e auditoria de ISR (cache desligada) |
| **Não fazer (1)** | `HEAP_PLACE_FUNCTION_INTO_FLASH=y` (`build-cyd/sdkconfig:2357`) | O próprio CYD documenta que malloc/free na IRAM é deliberado: com o heap na flash o compile do Duktape foi de 1,6 s para 3,1 s (`boards/cyd/sdkconfig.defaults:83-85`) |

O Tactility liga as 12 no ESP32 clássico (`device.py:189-196,270-289`), mas
metade da lista nunca teve efeito lá: `SPI_FLASH_AUTO_SUSPEND` é `default n`
no IDF (`spi_flash/Kconfig:85-91`) e é ele que revela as 7 opções. Ligar
auto-suspend mudaria o comportamento de escrita de flash — no CYD isso
interage com o painel RGB, então fica fora desta rodada.

**Por que isso vale mais no CelerOS do que no Tactility:** o CYD roda unicore com
`CONFIG_ESP32_IRAM_AS_8BIT_ACCESSIBLE_MEMORY=y` — a IRAM livre **é heap** para o
fonte do app, buffers TLS e overflow do Duktape (`boards/cyd/sdkconfig.defaults:49-66`).
Cada KB liberado é KB de app.

**Ganho esperado:** não quantificado pelo Tactility (o comentário deles cita
~27 KB para as duas opções de Wi-Fi no ESP32 clássico, `device.py:189-196`).
Medir as três efetivas; ordem esperada de poucos KB a ~20 KB.

**Risco:** as três funções saem da IRAM e passam a sofrer cache miss da flash —
PHY e Wi-Fi ficam mais lentos (throughput de pico, não latência de app). No CYD,
acesso à flash durante o streaming do painel é sensível (a saga do painel
embaralhado). Validar: boot, Wi-Fi/OTA, log, toque, e o `lcddma` sem embaralhada.

**Validação:** `celerctl top` (heap interno e IRAM), `heap_caps_get_free_size`
antes/depois, `size_report.py`, e um soak de 30 min com Loja + OTA.

### 5.2 `SPIRAM_MEMTEST=n` nas placas com PSRAM — **[ADOTAR]**

O Tactility chama de "boot speed optimization" e desliga o memtest de PSRAM
(`device.py:232`). O CelerOS hoje roda com `CONFIG_SPIRAM_MEMTEST=y`
(`build/sdkconfig:2500`), e o SmartDisplay tem 8 MB octal.

**Ganho:** boot mais rápido (medir; memtest de 8 MB octal não é barato).
**Risco:** perde-se o teste de integridade da PSRAM no boot; o CelerOS já
convive com PSRAM vendida em placas de bancada — decidir por placa.
**Validação:** tempo de boot medido por `uptime`/log; soak.

### 5.3 `SPIRAM_FETCH_INSTRUCTIONS` / `SPIRAM_RODATA` / `SPIRAM_XIP_FROM_PSRAM` — **[MEDIR] [OPÇÃO]**

O Tactility liga as três por padrão em S3 com PSRAM e permite desligar por placa
(`device.py:262-268`; o T-Deck deles usa `spiRamXipDisabled=true`). O CelerOS
deixa as três **desligadas** (`build/sdkconfig:2479-2483`).

**Ganho:** instruções e rodata saem da RAM interna para a PSRAM — dezenas de KB
de RAM interna, potencialmente. **Risco:** execução XIP de PSRAM é mais lenta e
mexe no cache; no SmartDisplay o painel RGB é sensível a cache linha 64 B (o
CelerOS exige 32 B). O próprio Tactility desabilita em placas específicas, o que
mostra que não é ganho universal.

**Regra:** experimento por placa, uma de cada vez, com o painel RGB como gate.
Se o SmartDisplay perder estabilidade, manter desligado só nele.

### 5.4 Partições: o slot de 6,25 MB para um binário de 2,6 MB — **[OPÇÃO] [NÃO OTA]**

Hoje, nas placas de 16 MB (`partitions_16MB.csv`):

| Partição | Tamanho | Uso real |
|---|---|---|
| `app0` | 0x640000 = 6.553.600 B | SmartDisplay: 2.655.264 B |
| `app1` | 6.553.600 B | idem (OTA) |
| `littlefs` | 0x360000 = 3.538.944 B | loja, apps, logs, módulos, ícones — **cronicamente apertado** |

O Tactility dimensiona o slot para a imagem e dá o resto ao `data`
(`partitions-16mb-no-sd.csv`: `factory 6M`, `data 9800k`). Um rebalanceamento
para slots de 4 MB liberaria **~4,5 MB** para o LittleFS (de 3,4 MB para ~7,9 MB).

**Custo:** mudar a tabela de partições **não é OTA-ável** — todo aparelho em
campo precisaria de reflash por USB. Fica como decisão de fábrica, não de
firmware. Antes disso, a via barata é liberar espaço no LittleFS (limpeza de
cache, ícones, rotação de logs) e reduzir o que entra no slot.

### 5.5 Boot e imagem: o que já está no limite

Fatos medidos nesta análise:

- Binários atuais: SmartDisplay 2.659.264 B, watch 2.770.464 B, dog 2.505.088 B,
  CYD **1.556.816 B**.
- Slot do CYD: 1.638.400 B → **81.584 B livres**. O gate do CI exige 64 KB
  livres (65.536 B), ou seja, há **~15,7 KB de margem sobre o próprio gate**.
- `CelerFonts.cpp` tem **467.064 B** de fonte gerada. O CelerOS já poda
  `DejaVu40` no CYD via `if constexpr (BoardTraits::largeUi)`
  (`main/Display/Display.h:75-76`), então o custo restante precisa ser medido
  com `size_report.py` antes de qualquer conclusão sobre binfont.

**Ação de processo [ADOTAR]:** um "orçamento de flash" explícito no CI — além do
gate de 64 KB, um teto de crescimento por release (ex.: não perder mais de X KB
por commit) e o `size_report.py --baseline`. O Tactility dimensiona a partição
para a imagem; o CelerOS tem a ferramenta de medição, falta o teto.

---

## 6. Onda 2 — Robustez e velocidade de evolução

### 6.1 Camada única de I/O de flash com política de vidro — **[ADAPTAR]**

**O que o Tactility faz:** um worker dedicado a I/O de flash/SD, com pilha de
8 KB **em RAM interna**, fila própria e conclusão por `TaskEventGroup`
(`TactilityKernel/source/file_ops.cpp:29`). A regra documentada é forte: **tarefa
com pilha em PSRAM não toca na flash**, porque durante a escrita a flash cache é
desligada e uma pilha em PSRAM fica inacessível.

**O que o CelerOS faz:** o `LogPersist` já implementou exatamente a política
certa para o seu caso — staging em PSRAM, flush **só com o vidro apagado**, e
flush de emergência só em estágio quase cheio (`main/USBDevice/LogPersist.cpp:37-39,262-265`).
Mas isso é local ao log. Downloads da Loja, `FS.writeFile`, `installZip` e
`writeTextFile` continuam escrevendo de qualquer tarefa
(`main/FileSystem/FileSystem.cpp:411-441`).

**O que adotar:** generalizar o `LogPersist` numa camada `FlashIo`:

1. Um worker único (pilha interna) para escritas grandes.
2. Staging em PSRAM quando existir; escrita direta só abaixo de um limiar.
3. Um gate `ScreenPower`/VSYNC: escritas grandes esperam a janela segura
   (tela apagada ou AOD), com prazo máximo para não travar app.
4. Telemetria: contador de bytes, espera média, flushes de emergência — visível
   em `celerctl stats`.

**Ganho:** elimina a classe de bug que já custou dias (painel RGB embaralhado por
escrita de flash concorrente) e protege apps que baixam/gravam com a tela ligada.
**Risco:** latência de escrita para apps (precisa de contrato: `FS.write` pode
retornar "agendado" ou bloquear com timeout).
**Validação:** `lcddma` sob Loja baixando + jogo rodando; teste de escrita
grande com tela ligada; bench no 4848.

### 6.2 Alocação por capacidade — **[ADAPTAR]**

O Tactility define `MemoryPolicy { required, desired, alignment }` e um allocator
que tenta `desired`, cai para `required` e nunca devolve memória sem os caps
obrigatórios (`TactilityKernel/include/tactility/memory.h:13-41`,
`TactilityKernel/source/memory_esp32.cpp`). Do lado C++ deles, `tt::newObject<T>()`
e `tt::std::*` usam alocador externo preferido — o PSRAM preferido é difundido
sem mudar cada call site.

No CelerOS há **89 ocorrências** de `heap_caps_malloc`/`MALLOC_CAP_SPIRAM` em
**31 arquivos** (entre chamadas e menções em comentários), cada uma com sua
política ad hoc. Um helper `mem::alloc(size, req, want)` com fallback e
instrumentação:

- reduz branches repetidos e erros de "PSRAM-first" esquecido;
- permite medir por call site (quem pediu PSRAM e caiu para interna);
- alinha com `-fno-exceptions`: falha retorna `nullptr` e o chamador decide.

**Ganho:** menos OOM silencioso, código mais curto, telemetria de pressão de RAM.
**Risco:** baixo (refactor mecânico); fazer por área, com testes host.

### 6.3 Settings tipado com schema, defaults e debounce — **[ADAPTAR]**

**Tactility:** cada feature tem um `.properties` com `load()`/`loadOrGetDefault()`,
parse tolerante, escrita atômica via `.tmp` + rename
(`TactilityKernel/source/properties_file.cpp:117`) e valores **etiquetados por
tipo** (`b:1`, `i32:42`, `s:...`) em `preferences`
(`TactilityKernel/source/preferences.cpp:53,268-284`). Não há versão de schema —
compatibilidade é por defaults.

**CelerOS:** `CelerSettings` é NVS string pura; cada `set()` abre, grava e faz
`nvs_commit` (`main/Utils/CelerSettings.cpp:39-41`). As chaves são literais
espalhados; não há registro de defaults, validação, versão nem debounce.
Controles contínuos nativos já evitam persistir por passo
(`main/Launcher/WatchPanels.cpp:73-74`), mas apps JS que chamam
`System.setBrightness` em série gravam NVS a cada chamada.

**O que adotar (sem trocar NVS):**

1. Um registro central de chaves com tipo, default, faixa e descrição — gerando
   também a documentação e o `celer.d.ts` quando aplicável.
2. `Settings::setDebounced(key, value, 2s)` para sliders/volume/brilho.
3. Versão de schema em NVS (`settings_ver`) com migração explícita — hoje só
   existe a migração one-shot de `.txt`.
4. Validação na borda: rejeitar valor fora da faixa em vez de aceitar e ler
   default depois (o comentário em `main/Utils/CelerSettings.cpp:20-24` mostra que
   esse modo de falha já mordeu).

**Ganho:** menos desgaste de NVS, menos bugs de "gravou mas não leu", UI de
settings mais segura. **Risco:** migração de chaves existentes (fazer com
fallback de leitura).

### 6.4 Board manifest: uma placa em um lugar — **[ADAPTAR]**

**Tactility:** uma placa é `Devices/<id>/device.properties` (+ `.dts`), e
`device.py` gera o `sdkconfig`; a matriz de CI é gerada por
`Buildscripts/gh-generate-device-matrix.py`. Adicionar placa não toca 8 arquivos.

**CelerOS:** uma placa nova hoje toca, no mínimo:

| Arquivo | Papel |
|---|---|
| `CMakeLists.txt` (raiz) | `-DCELEROS_BOARD` válido |
| `main/CMakeLists.txt:176-210` | seleção do diretório `Boards/<b>` |
| `main/Kconfig.projbuild` | flags de feature por placa |
| `boards/<b>/sdkconfig.defaults` | tuning medido |
| `partitions_*.csv` | tabela de partições |
| `.github/workflows/build.yml:68-84` | matriz do CI |
| `tools/size_report.py` | lista de placas |
| `tools/flash_data.sh` | caso de imagem de dados |
| `updates/<canal>/` | canal de OTA |

E o `cyd-vspi` ficou **fora** do `flash_data.sh` (grep por `cyd-vspi` no
repositório não o encontra em `tools/flash_data.sh`) — exatamente o tipo de
esquecimento que um manifest evita.

**Proposta de baixo risco:** manter os `sdkconfig.defaults` como fonte de verdade
(e seus comentários medidos), mas criar `boards/boards.json` descrevendo cada
placa (target, flash, PSRAM, partições, canal de OTA, overlay de dados, suporte a
flash). Gerar dele: matriz do CI, lista do `size_report`, casos do
`flash_data.sh`, validação do `CELEROS_BOARD` e checagem de partições. Um teste
host garante que todo board do manifest tem defaults e canal.

**Ganho:** placa nova em 1–2 arquivos; `cyd-vspi` e futuras placas cobertas por
construção. **Risco:** baixo se a geração for aditiva (defaults continuam
manuais).

### 6.5 Capabilities de display no `BoardProfile` — **[ADAPTAR]**

**Tactility:** o driver de display declara capacidades
(`TactilityKernel/include/tactility/drivers/display.h:39-53`) e o bridge decide
política por elas — `PREFER_EXTERNAL_RAM`, `REQUIRES_FULL_FRAME`, `SLOW_REFRESH`,
`CAP_SWAP_XY`, `CAP_MIRROR`
(`Modules/lvgl-module/source/devices/display.cpp:438-439`).

**CelerOS:** `BoardProfile` é um struct plano (`main/Boards/Board.h:85`) e o Kui,
`Icon`, `FrameSprite` e `ScreenPower` decidem por `constexpr`/`if` de placa ou
por tamanho de tela. Flags de capacidade (`fullFrame`, `preferExternal`,
`slowRefresh`, `swapXY`, `mirror`, `mono`) reduziriam branches e deixariam a
política explícita — alinhado à regra do projeto de não espalhar `#ifdef` de
placa.

**Ganho:** menos código condicional, mais fácil adicionar placa e painel.
**Risco:** baixo; refactor com testes host de geometria.

### 6.6 Aviso de RAM interna baixa — **[ADOTAR]**

O Tactility tem um serviço de 1 s que acende um ícone na status bar quando a RAM
interna livre cai abaixo de **10.000 B** ou o maior bloco abaixo de **2.000 B**
(`Tactility/Source/service/memorychecker/MemoryCheckerService.cpp:14-16`).

No CelerOS a RAM interna é o recurso escasso (reservas de 72 KB/24 KB/20 KB em
`main/Kernel/Core/CelerKernel.cpp:212-226`), mas não há aviso em tempo real — o
sintoma é OOM de app. Um contador no topbar/AOD e um registro em
`celerctl stats` dariam diagnóstico antes da falha. **Ganho:** menos "app morreu
sem explicação". **Risco:** quase nulo.

### 6.7 Barreira de parada de timer — **[MEDIR]**

O `Timer::stop()` do Tactility espera um barrier na fila de comandos e gira até o
callback corrente terminar (`TactilityFreeRtos/Include/Tactility/Timer.h:116-132`),
evitando "parei o timer, destruí o estado, o callback rodou no estado morto".
Os timers JS do CelerOS são cooperativos (8 slots), então o risco clássico não
existe; mas timers nativos (`esp_timer`) usados por áudio, microfone e OTA
podem ter a mesma corrida. Auditar antes de portar qualquer coisa.

### 6.8 Contrato mínimo de ciclo de vida nos serviços — **[ADAPTAR] [S]**

O Tactility tem um framework de serviço com manifesto, `create/destroy`,
`on_start/on_stop`, estados e diretório de dados por serviço
(`Modules/service-module/include/service/manager.h`,
`Modules/service-module/source/instance.cpp`). No CelerOS, serviço é uma entrada
`{nome, tick, modo}` na tabela (`main/Kernel/Services.cpp:124`), e ligar/desligar
subsistemas (web server, malha, PhoneLink) é feito com flags espalhadas.

Adotar só o contrato mínimo: `start()`/`stop()` opcionais na entrada, estado
"iniciado" e um diretório `<raiz>/service/<id>` (hoje cada serviço escolhe onde
gravar). Sem grafo de dependências nem estados intermediários.

**Ganho:** desligamento limpo antes de deep sleep/OTA, reinício de subsistema sem
reboot, menos flags globais. **Risco:** baixo; migrar 2–3 serviços primeiro (web,
malha) mantendo o tick.

---

## 7. Onda 3 — Velocidade de desenvolvimento e UX

### 7.1 Simulador host com o código real — **[ADAPTAR] [L]**

**Tactility:** o simulador é um build POSIX do **mesmo** kernel/sistema com
painel, ponteiro e teclado SDL; apps são `.so` carregados por `dlopen` contra o
executável linkado com `-rdynamic` (`Platforms/platform-posix/source/`,
`Devices/simulator/`).

**CelerOS:** o emulador do SDK (`tools/sdk/lib/runner.js`, `renderer.js`) é uma
**reimplementação em Node** da API JS — ótima para apps (rápida, CI-friendly),
mas não exercita Kui, LovyanGFX, layout real nem framebuffer.

**Oportunidade concreta:** o LovyanGFX vendorado já tem backend SDL
(`components/LovyanGFX/src/lgfx/v1/platforms/sdl/Panel_sdl.hpp`). Um alvo host
que compile Kui + um `LGFX_Device` com `Panel_sdl` permitiria:

- rodar telas nativas no desktop;
- gerar PNG por frame e fazer **diff visual** no CI (regressão de layout/tema);
- iterar UI sem bancada.

**Escopo mínimo:** um `test/host_ui/` que instancia uma `Screen` do Kui com dados
falsos, renderiza N frames e salva PNGs. Não precisa de NVS, Wi-Fi nem apps.
**Custo:** L (stubs de IDF, fontes, build CMake separado). **Ganho:** alto para
quem mexe em UI e para revisão de PR.

### 7.2 Testes host no modelo doctest com fatias reais — **[ADAPTAR] [M]**

O Tactility roda o kernel de verdade no host (mutexes, event groups, timers,
device/driver) com doctest (`TactilityKernel/tests/source/main.cpp:21-30`).

O CelerOS já tem `test/cpp` (lógica pura) + 9 suítes host. O próximo passo natural
não é portar FreeRTOS POSIX, e sim **testar código de firmware de verdade** onde
ele é puro o bastante:

| Fatia | Por que rende |
|---|---|
| `DirtyRects` + `FrameSprite::push` | já testado; ampliar para casos de merge/cobertura |
| `Kui` (geometria, hit-test, foco, teclado) | hoje só via emulador JS e bancada |
| Parser de catálogo da Loja | casos de truncamento, campos faltando, versão antiga |
| `JsFsJail` | caminhos `..`, barra final, symlink-like |
| Settings (schema/defaults/migração) | após 6.3, testar migração é obrigatório |

**Ganho:** menos dependência de bancada para regressões de lógica. **Risco:** baixo.

### 7.3 Catálogo da Loja em texto compacto — **[ADAPTAR] [M]**

**Problema real, medido no código:** o hub publica `all.json` com ~58 KB; sem
PSRAM o `Net.getJSON` **corta em 32 KB** e o `JSON.parse` quebra; o app cai para
5 requisições por categoria e o cache no PSRAM custa ~2× o catálogo, exigindo
~180 KB livres em `/local` (`data/apps/App Store/main.js:597-610`).

**O que o Tactility faz:** converte o `apps.json` do App Hub uma vez em
`catalog.txt` — uma linha por app, 10 campos separados por tab, linha limitada a
1024 B — e busca lendo o arquivo sob demanda, sem catálogo em RAM
(`Modules/app-hub-module/source/app_hub_catalog.cpp:137`).

**O que adotar:** o hub passa a publicar também `all.txt` (ou `.tsv`) com os
campos mínimos (pkg, nome, versão, api, categoria, tamanho, md5, deps, requires).
O app lê por streaming/linha e monta só o necessário. Benefícios:

- 1 requisição em vez de 5;
- sem corte de 32 KB (o formato é linha a linha);
- cache menor e parse mais barato no Duktape;
- compatibilidade: manter `all.json` para clientes antigos por uma janela.

**Ganho:** Loja funciona igual em CYD e PSRAM, com menos rede e menos `/local`.
**Risco:** mudança coordenada hub + app + lint de deps.

### 7.4 `launchApp` com argumentos e resultado — **[ADAPTAR] [M]**

Hoje `System.launchApp(pkg)` abre outro app e **mata o atual**
(`main/Runtime/JsSystemApps.cpp:169-178`; `main/Runtime/JSBindings.cpp:1315`).
Não há argv, nem resultado, nem retorno ao app chamador.

O Tactility tem `AppStartContext` com `argc/argv`, ambiente herdado, streams,
`parent_id` e `APP_EVENT_RESULT` (0=OK, 1=cancelado, 2=erro) — o padrão clássico
de "abrir para resultado" (`Modules/app-module/include/app/start.h`).

**Proposta:** `System.launchApp(pkg, args)` + `System.onResult(cb)` e um slot de
resultado por app, entregue no `present()`. Sem streams (o FS resolve troca de
dados); só argv/resultado já destrava fluxos como "escolher arquivo", "pedir
confirmação", "abrir Settings e voltar".

**Ganho:** UX de composição entre apps sem mesh/IPC. **Risco:** baixo; precisa de
limite de tamanho e limpeza no exit.

### 7.5 i18n por catálogo gerado — **[ADAPTAR] [M]**

O Tactility gera um `enum class Text` + um `.i18n` por idioma (uma linha por
chave) a partir de um CSV/ODS (`Translations/generate.py`) e carrega por locale
com fallback `en-US` (`Tactility/Source/i18n/TextResources.cpp:39-58`). O
mecanismo está **dormente** (nenhum app usa), mas o desenho é bom e barato.

O CelerOS tem `i18n::TR(pt,en)` em poucas strings nativas; os apps são PT.

**O que adotar:** catálogo gerado (JSON ou linhas) por locale, `T(key)` no C++ e
`L(key)` no JS, fallback PT-BR, e uma tela de idioma. **Limite duro:** as fontes
são Latin-1 (U+0020..U+00FF) — não prometer CJK/emoji. **Ganho:** EN de verdade
para o público do hub. **Risco:** baixo, mas é trabalho de conteúdo.

### 7.6 Debug bridge: de token para pinning — **[ADAPTAR] [M]**

O Tactility substituiu o web server por um **dev server TLS com mTLS**, servidor
na 6667, certificado autoassinado com fingerprint SHA-256 exibido para pinning,
aprovação de cliente desconhecido por prompt no aparelho, no máximo 3 sessões e
1 shell (`Modules/development-module/source/server.cpp:71-346`). Clientes:
`tt shell/push/pull/screenshot`.

O CelerOS tem o `DebugBridge` em **TCP 5555 com token de 8 caracteres** em NVS
(alfabeto de 31 símbolos, ~40 bits; `main/USBDevice/DebugBridge.cpp:63-94`) e o
`WebManager` com Basic Auth. O token resolve o caso de bancada, mas trafega em
claro na LAN.

**Duas opções, em ordem de custo:**

1. **Barato:** handshake com desafio HMAC do token (não manda o token na rede) +
   bind opcional em interface específica.
2. **Modelo Tactility:** TLS com fingerprint pinado e aprovação no aparelho.

**Ganho:** debug remoto sem segredo em claro. **Risco:** baixo na opção 1.

### 7.7 Fontes em runtime (`binfont`) — **[MEDIR] [L]**

O `binfont` do Tactility (Apache-2.0, ~1.800 LOC + `stb_truetype`) lê um formato
compatível com `lv_font_conv`, rasteriza TTF no aparelho, escolhe 1/2/4 bpp
conforme PSRAM, cacheia em arquivo com hash da TTF e carrega inteiro em PSRAM ou
sob demanda (`Modules/binfont-module/`).

**Por que interessa:** o CelerOS tem 9 fontes fixas em Latin-1, 467 KB de fonte
gerada, sem tamanho arbitrário nem Unicode além de Latin-1.

**Por que não decidir agora:** no CYD não há PSRAM, e o texto da Onda 1 mostra que
o slot está quase no gate. Trocar bitmaps compilados por TTF + rasterizador pode
**aumentar** o binário (código do rasterizador + TTF) ou reduzir (subset), e
depende de cobertura de glifos. O ganho real é **flexibilidade** (tamanhos,
peso, Unicode), não flash.

**Regra [MEDIR]:** primeiro medir o custo atual das fontes no binário por placa
(`size_report.py`); só depois um spike de `binfont` + adapter `lgfx::IFont` com
uma fonte, medindo flash, RAM, tempo de rasterização e qualidade em 1/2/4 bpp.
Se o alvo for só "mais um tamanho", gerar mais um GFXfont é mais barato.

### 7.8 Toques finais de UX — **[ADOTAR] [S]**

- **Pistas não-cor no OLED do dog:** o tema mono do Tactility troca cor por
  inversão/borda e desliga opacidade (`Modules/lvgl-module/themes/material_mono.lss`).
  O dog é SH1106 128×64; qualquer tela nativa futura ganha em legibilidade.
- **Screensavers de AOD:** eles têm BouncingBalls/Mystify/MatrixRain/StackChan
  como overlay com backlight separado (`Tactility/Source/service/displayidle/`).
  O CelerOS já tem AOD com anti-burn-in; um screensaver opcional é enfeite de
  baixo custo.
- **Deduplicação de status bar:** eles só escrevem ícone que mudou
  (`Tactility/Source/service/statusbar/Statusbar.cpp:387-400` e
  `Tactility/Source/service/memorychecker/MemoryCheckerService.cpp:81-82`). O
  CelerOS já pinta o topbar no frame do app; a ideia serve para futuros
  indicadores.
- **`ideas.md`:** manter um backlog versionado de ideias/TODOs no repo (eles
  têm `Documentation/ideas.md`). Custa nada e evita rediscutir.
- **Compatibilidade no install:** o Tactility checa `requires.device.id` e
  `requires.ram` antes de instalar
  (`Modules/app-module/source/package_compatibility.cpp`). O CelerOS já tem
  `requires:["psram"]` e heurística no app da Loja; um piso de heap interno por
  placa evitaria instalar app que não abre no CYD.

---

## 8. Não adotar (e por quê)

| Item | Por que não |
|---|---|
| **LVGL 9 + window manager** | Reescrita completa da UI; o Kui é o modelo do produto (imediato, leve no CYD). Só faria sentido como projeto novo, não como melhoria. |
| **Apps ELF/C++ nativos** | Exige loader com relocação, tabelas de ~1.350 símbolos, virtualização de libc, fd/cwd/env por app, reaper de task e tratamento de `exit()`. Custo altíssimo e **destrói o moat**: sandbox JS, permissões, hub com deps, lint/types e emulador. |
| **Module ledger (use ref × code ref)** | Só é necessário se houver código nativo carregável. Sem ELF, é complexidade sem uso. |
| **`TaskEventGroup` / `system_event`** | O CelerOS não bloqueia no loop principal: `Event<Args...>` + flags e a tabela de serviços já cobrem o caso. O ganho deles vem de serviços com thread própria, que a tabela do CelerOS não tem. |
| **Devicetree + compilador DTS** | Compilador Python no build, bindings YAML e descrição de hardware por placa é a resposta deles para 63 perfis. O CelerOS tem 8 e um `BoardProfile` que funciona; o ganho aqui é o **manifest** (6.4), não o DTS. |
| **`properties_file` como backend de settings** | O NVS já é atômico e sobrevive a corrupção; trocar por arquivo piora o CYD (LittleFS apertado). Aproveitar só a ideia de valor etiquetado + defaults + validação (6.3). |
| **Ausência de OTA / distribuição por reflash** | O OTA assinado é um dos maiores ativos do CelerOS. Nem considerar. |
| **`tt.py` baixando SDK do CDN** | O CelerOS tem `tools/sdk/celer.js` + hub; o modelo deles exige CDN versionado e não resolve o problema local. Aproveitar só a ideia de **pin de versão do IDF** num gate (o `get_idf` já regrediu uma vez). |

Nota: os dois projetos compilam com `-fno-exceptions`, então os padrões deles
(alocador que aborta, ausência de RAII de exceção) transferem sem surpresa — isso
é uma garantia, não um item a adotar.

---

## 9. O que já é melhor no CelerOS (não regredir)

| Área | CelerOS | Tactility |
|---|---|---|
| Atualização | OTA assinado, retomável, rollback, manifesto v2 | Não existe |
| Distribuição de apps | Hub com deps, drift, semver, lint, types | App Hub simples, sem assinatura e sem deps |
| Isolamento de app | Duktape + jail de FS + permissões + consentimento | Nenhum (código nativo no mesmo espaço) |
| Ferramentas | `celerctl` (devices, shell, push/pull, logcat, top, ota, debug, tap/screencap, apps), emulador Node, debugger JS, meshsim | `tt` + dev server |
| Rede de dispositivos | CelerLink/CelerNet/Pack/mesh + PhoneLink | BLE/mesh genéricos, sem vínculo com apps |
| Energia | AOD, raise-to-wake, ULP, deep sleep, DFS no watch | Display idle + power supply; sem DVFS documentado |
| Render de app | Dirty rects de 32 caixas, bandas no sem-PSRAM | LVGL dirty rects + tiles |
| Testes de app | js_harness, app_lint, meshsim, SDK | Testes de kernel/módulos (melhor no kernel, pior em apps) |

**Regra de ouro:** nenhuma adoção desta análise pode custar OTA assinado,
permissões, hub com deps ou a folga do CYD.

---

## 10. Protocolo de medição

Toda mudança da Onda 1 e dos itens 6.1–6.3 da Onda 2 entra com número
antes/depois. Baseline por placa (no mínimo SmartDisplay + CYD):

```bash
# ambiente (ESP-IDF 6.1 de verdade)
idf.py --version          # precisa imprimir 6.1

# tamanho e folga do slot
python3 tools/size_report.py --baseline /tmp/base-<placa>.json
python3 tools/size_report.py --min-free-kb 64

# RAM/IRAM em runtime
python3 tools/celerctl.py top -w        # CPU por task, heap, app, fps
python3 tools/celerctl.py stats         # contadores KL_STATS
python3 tools/celerctl.py info          # versao/api/uptime

# display (SmartDisplay)
python3 tools/celerctl.py shell "lcddma"

# soak de escrita de flash com a tela ligada (Loja baixando + jogo)
python3 tools/celerctl.py apps store <pkg>
```

Critérios de aceite sugeridos:

| Item | Antes | Depois | Aceite |
|---|---|---|---|
| Heap interno CYD (tela ligada) | medir | medir | ≥ +8 KB, sem OOM em Loja+Settings |
| IRAM livre CYD | medir | medir | ≥ +8 KB |
| Boot SmartDisplay | medir | medir | ≤ 85% do atual (memtest off) |
| RAM interna SmartDisplay | medir | medir | ≥ +16 KB (XIP on) sem perder fps |
| Slot CYD | 81.584 B livres | ≥ 96 KB | nunca abaixo de 64 KB |
| Escrita de flash com tela ligada | pode embaralhar | 0 eventos | `lcddma` limpo em 30 min |

Se um número não melhorar, reverter a linha de config — cada opção é
independente e o custo de reverter é zero.

---

## 11. Backlog consolidado

| # | Item | Onda | Esforço | Risco | Ganho principal |
|---|---|---|---|---|---|
| 1 | 3 opções IRAM efetivas no CYD/cyd-vspi/devkit | 1 | S | baixo | heap do Duktape |
| 2 | `SPIRAM_MEMTEST=n` nas S3 | 1 | S | baixo | boot |
| 3 | XIP/rodata/fetch na PSRAM (S3) | 1 | S–M | médio | RAM interna |
| 4 | Orçamento de flash no CI | 1 | S | baixo | previsibilidade |
| 5 | Rebalance de partições (fábrica) | 1 | M | alto (não OTA) | `/local` |
| 6 | `FlashIo` central + gate de vidro | 2 | L | médio | estabilidade do painel |
| 7 | `mem::alloc(req, want)` | 2 | M | baixo | menos OOM |
| 8 | Settings tipado + debounce + schema | 2 | M | baixo | robustez |
| 9 | `boards.json` + geração (CI/size/flash) | 2 | M | baixo | placa nova em 1 lugar |
| 10 | Capabilities no `BoardProfile` | 2 | M | baixo | menos branches |
| 11 | Aviso de RAM interna baixa | 2 | S | nulo | diagnóstico |
| 12 | Auditoria de corrida de timer nativo | 2 | S | baixo | evita teardown race |
| 13 | Contrato start/stop nos serviços | 2 | S | baixo | desligamento limpo |
| 14 | Simulador host (Kui + Panel_sdl) | 3 | L | médio | UI sem bancada + diff visual |
| 15 | Fatias de firmware em teste host | 3 | M | baixo | menos regressão |
| 16 | Catálogo TSV da Loja | 3 | M | baixo | CYD sem corte de 32 KB |
| 17 | `launchApp(args)` + resultado | 3 | M | baixo | composição de apps |
| 18 | i18n por catálogo | 3 | M | baixo | EN real |
| 19 | Debug bridge com HMAC/TLS | 3 | M | baixo | segredo não vai em claro |
| 20 | `binfont` + adapter LGFX | 3 | L | alto | fontes flexíveis (medir antes) |
| 21 | Tema mono/pistas do dog | 3 | S | baixo | legibilidade |
| 22 | Piso de RAM no install da Loja | 3 | S | baixo | evita app que não abre |
| 23 | `ideas.md` + `THIRD-PARTY-NOTICES.md` | 3 | S | nulo | processo |

---

## Apêndice A — linhas exatas de `sdkconfig` para a Onda 1

**A.1 Placas sem PSRAM (CYD, cyd-vspi, devkit — unicore com IRAM-as-heap)** —
adicionar ao `boards/<b>/sdkconfig.defaults`:

```
# As tres visiveis sem SPI_FLASH_AUTO_SUSPEND (as outras 7 sao no-op):
# CONFIG_ESP_PHY_IRAM_OPT is not set
# CONFIG_WIFI_RMT_IRAM_OPT is not set
# CONFIG_WIFI_RMT_RX_IRAM_OPT is not set
```

**Não acrescentar** (linha inócua sem `SPI_FLASH_AUTO_SUSPEND=y`):

```
# ESP_TIMER_IN_IRAM, ESP_SYSTEM_IN_IRAM, ESP_INTR_IN_IRAM,
# ESP_HW_SUPPORT_FUNC_IN_IRAM, SPI_FLASH_PLACE_FUNCTIONS_IN_IRAM,
# LOG_IN_IRAM, LIBC_MISC_IN_IRAM
```

**Não aplicar** (justificativa na tabela da seção 5.1):

```
# Medir isolado, com soak e auditoria de ISR:
# CONFIG_RINGBUF_PLACE_ISR_FUNCTIONS_INTO_FLASH=y
# NAO FAZER no CYD/devkit (malloc/free na IRAM e deliberado; compile 1,6s -> 3,1s):
# CONFIG_HEAP_PLACE_FUNCTION_INTO_FLASH=y
```

**A.2 Placas S3 com PSRAM** — boot:

```
CONFIG_SPIRAM_MEMTEST=n
```

**A.3 Experimento XIP (uma placa por vez)**

```
CONFIG_SPIRAM_FETCH_INSTRUCTIONS=y
CONFIG_SPIRAM_RODATA=y
CONFIG_SPIRAM_XIP_FROM_PSRAM=y
```

Gate: `lcddma`, fps, boot e soak. Se o painel RGB perder estabilidade, reverter
só a placa (o Tactility também desabilita em placas específicas).

---

## Apêndice B — mapa de equivalências

| Assunto | Tactility | CelerOS |
|---|---|---|
| Ciclo de vida de serviço | `Modules/service-module/` | `main/Kernel/Services.cpp:124` |
| Memória por capacidade | `TactilityKernel/include/tactility/memory.h:13-41` | `heap_caps_*` em 31 arquivos |
| I/O de flash seguro | `TactilityKernel/source/file_ops.cpp:29` | `main/USBDevice/LogPersist.cpp:37-39` |
| Settings atômicos | `TactilityKernel/source/properties_file.cpp:117` | `main/FileSystem/FileSystem.cpp:411-441` |
| Settings com tipo | `TactilityKernel/source/preferences.cpp:53` | `main/Utils/CelerSettings.cpp` |
| Catálogo compacto | `Modules/app-hub-module/source/app_hub_catalog.cpp:137` | `data/apps/App Store/main.js:597-610` |
| Fontes | `Modules/binfont-module/` | `main/Assets/Fonts/CelerFonts.cpp` |
| Política de display | `TactilityKernel/include/tactility/drivers/display.h:39-53` + `Modules/lvgl-module/source/devices/display.cpp:438-439` | `main/Display/FrameSprite.h`, `main/UI/Kui.*` |
| Anti-tear em RGB | `Drivers/rgb-display-module/source/rgb_display.cpp:42,368-376` | VSYNC ISR + dirty rects (`main/Display/`) |
| App com args/resultado | `Modules/app-module/include/app/start.h` | `main/Runtime/JsSystemApps.cpp:169` |
| Dev server seguro | `Modules/development-module/source/server.cpp:346` | `main/USBDevice/DebugBridge.cpp:63` |
| Perfis de placa | `Devices/*/device.properties` + `device.py` | `boards/<b>/sdkconfig.defaults` + 5 arquivos |
| Testes de kernel no host | `TactilityKernel/tests/source/main.cpp:21-30` | `test/cpp/run_tests.cpp` |
| Simulador | `Platforms/platform-posix/` + SDL | `tools/sdk/lib/runner.js` (reimplementação) |
| i18n | `Translations/generate.py` + `.i18n` | `i18n::TR(pt,en)` |
| Aviso de RAM baixa | `Tactility/Source/service/memorychecker/` | — (não existe) |
| Backlog de ideias | `Documentation/ideas.md` | — (não existe) |

---

## Apêndice C — números citados e origem

| Número | Origem |
|---|---|
| Tactility 0.8.0-dev, `v0.7.0-153-g7ab1c1f2` | `version.txt`, `git describe` |
| 63 perfis de placa; 29 módulos; 81 drivers | `ls Devices`, `ls Modules`, `ls Drivers` |
| 538 símbolos no kernel; ~1.350 somando libc/libstdc++/FreeRTOS/ESP-IDF | `TactilityKernel/source/symbols.c` + tabelas dos módulos de símbolos |
| LVGL 9.6.0, elf_loader 1.3.3 | `Tactility/idf_component.yml` |
| App stack padrão 8192 B; 24 bits de event group | inventário do código (`app-module`, `task_event_group.h`) |
| Hotplug: poll 500 ms, debounce 2 | `TactilityKernel/source/device.cpp` |
| Limiares de RAM baixa 10.000/2.000 B | `Tactility/Source/service/memorychecker/MemoryCheckerService.cpp:14-16` |
| Tactility: partições 16 MB com app 6 M + data 9800 k | `partitions-16mb-no-sd.csv` |
| CelerOS 1.11.6, API 50 | `main/CMakeLists.txt:338-339` |
| Binários: 2.659.264 / 1.556.816 / 2.505.088 / 2.770.464 B | `ls -l build*/CelerOS.bin` (HEAD) |
| Slot CYD 1.638.400 B; livres 81.584 B | `partitions_4MB.csv` + binário |
| Fontes geradas 467.064 B | `wc -c main/Assets/Fonts/CelerFonts.cpp` |
| Reservas de heap 72 KB / 24 KB / 20 KB | `main/Kernel/Core/CelerKernel.cpp:212-226` |
| 89 ocorrências de alocação por capacidade em 31 arquivos | `grep heap_caps_malloc` / `MALLOC_CAP_SPIRAM` |
| `all.json` ~58 KB cortado em 32 KB; 5 categorias; 180 KB livres | `data/apps/App Store/main.js:597-610` |
| 12 candidatas de IRAM/flash (3 aplicáveis + 7 invisíveis sem auto-suspend + 1 sob medição + 1 proibida) | `build-cyd/sdkconfig` + Kconfig do IDF 6.1 |

---

## Apêndice D — leitura recomendada no Tactility

Para quem for implementar as ondas, nesta ordem:

1. `TactilityKernel/include/tactility/memory.h` e
   `TactilityKernel/source/memory_esp32.cpp` — o modelo de alocação que inspira
   6.2.
2. `TactilityKernel/source/file_ops.cpp` — o worker de flash que inspira 6.1.
3. `device.py` (blocos `write_spiram_variables`, `write_iram_reduction`) — a
   disciplina de RAM que inspira 5.1–5.3.
4. `Modules/binfont-module/` — runtime de fontes que inspira 7.7.
5. `Modules/app-hub-module/source/app_hub_catalog.cpp` — catálogo compacto que
   inspira 7.3.
6. `TactilityKernel/tests/source/main.cpp` — o modelo de teste host que inspira
   7.2.
7. `Modules/development-module/source/server.cpp` — o dev server seguro que
   inspira 7.6.
8. `Documentation/ideas.md` — o que eles ainda não fizeram (útil para não
   superestimar o Tactility).

---

## Fecho

O Tactility ganha em **organização de kernel e disciplina de recurso**; o CelerOS
ganha em **modelo de app, distribuição e atualização**. O melhor resultado não é
importar o OS deles, e sim importar o que eles mediram: as dez linhas de IRAM que
o CYD ainda paga, o worker de flash, a alocação por capacidade, o catálogo
compacto e o hábito de medir com o código real no host. Tudo isso cabe no CelerOS
sem tocar no sandbox JS, no OTA assinado ou na folga do CYD — e cada item da
Onda 1 é reversível com uma linha de config.
