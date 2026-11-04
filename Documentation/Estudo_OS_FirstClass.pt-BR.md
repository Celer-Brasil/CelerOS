# CelerOS como OS de primeira classe

**O que falta para o autor de app só precisar escrever JavaScript**

- **Data:** 2026-11-03
- **Base:** CelerOS 1.13.0/API 55 na medição; a árvore passou a 1.14.0/API 56
  com a Onda 0 aplicada (seção 13).
- **Status:** estudo de arquitetura + Onda 0 implementada. As ondas 1 e 3–5
  seguem como proposta; as estimativas de custo estão marcadas e precisam de
  medição com `tools/size_report.py`.
- **Pergunta:** o que transforma o CelerOS de "firmware com runtime JS" em um sistema operacional em que o autor de app não pensa em Wi-Fi, conectividade, atualização, OTA nem instalação?

---

## 0. Como ler

O documento tem três partes. A **parte 1** (seções 2 e 3) define a régua e mede o CelerOS contra ela, com evidência no código. A **parte 2** (seções 4 a 6) propõe a arquitetura-alvo e as ondas de execução. A **parte 3** (seções 7 a 12) fecha com o antes/depois para o autor de app, o orçamento de flash, as métricas de aceitação, o que foi descartado e a sequência recomendada.

Legenda de confiança:

- **[código]** — verificado no fonte desta árvore, com arquivo e símbolo.
- **[estimativa]** — ordem de grandeza deduzida da estrutura, não medida.
- **[bancada]** — só fecha com aparelho na mão; o CI não tem device.

---

## 1. Sumário executivo

**Tese central:** o CelerOS já tem mais maquinário de plataforma do que a média dos firmwares ESP32 — A/B com rollback, OTA de manifesto assinado, níveis de API documentados, deps com semver, jail de filesystem, consentimento de permissões, serviços de app com orçamento. O que falta não é feature: é **propriedade**. A plataforma não é dona do relógio, do quadro, da raiz de confiança nem do caminho de reparo.

Três inversões resumem o problema:

1. **O app bombeia o SO.** Com `CONFIG_CELEROS_APP_TASK` desligado em todas as 8 placas, o app roda síncrono dentro do tick do launcher e é o `present()` dele que chama `CelerServices::tickPresent()`. Sem o app ceder, launcher, painéis, timers, notificações e alarmes não rodam. O SO depende do bom comportamento do hóspede.
2. **A política de plataforma mora em apps.** O *quando* atualizar está em `data/apps/Nucleo/service.js`; a distribuição de apps está na App Store; o provisionamento de Wi-Fi está no app `WiFi`; o gatilho de OTA está em `Settings`. São exatamente as funções que precisam ser de primeira classe — e o OTA de firmware não toca a LittleFS, então um firmware novo não conserta a política quebrada. É o **problema do bootstrap**: o caminho de reparo é entregue pelo mecanismo que ele deveria reparar.
3. **A confiança é nominal.** Permissão é "objeto ausente no global", não verificação por chamada; não há assinatura de app (o `installZip` valida estrutura e tamanho, não autoria); `/local/hub_token.txt` e os logs são legíveis por qualquer app com `fs`; não há secure boot nem flash encryption; a assinatura do OTA protege o manifesto, não a imagem.

Há uma quarta, mais barata de corrigir e mais visível para o desenvolvedor: **o contrato não é verificável no device**. `app.json.api` não é lido no lançamento, `app.main` é ignorado (o runtime sempre executa `main.js`), e os números de API divergem entre CMake (55), `AGENTS.md` (53) e o guia. Um app incompatível não recebe "requer CelerOS N": recebe `TypeError` numa tela de erro.

**A aposta deste estudo** é que o caminho para "só escrever JavaScript" não é esconder complexidade atrás de mais JS, e sim mover para o nativo as **decisões que todo app teria de reimplementar** — e deixar no JS o que é tela, fluxo e política de produto. Em cinco ondas:

| Onda | Entrega | Efeito para o autor de app |
|---|---|---|
| 0 | Contrato verificável: manifest v2 validado no device, gate de API no launch, `App.info`, fonte única de tipos/docs | Para de adivinhar versão, caminho e permissão |
| 1 | SO dono do quadro e do relógio: compositor de overlays, supervisor com restart e safe mode, orçamento por app | Notificação não expulsa mais o app; crash não é tela final |
| 2 | Conectividade como serviço: `netd` com estados, reachability, fila/retry, provisionamento de 1º boot, cofre de segredos | `Net.fetch` espera, repete e tipa erro; ninguém configura Wi-Fi no app |
| 3 | Update como serviço: updater nativo, update de app transacional com rollback e health check, assinatura de app, imagem assinada | Atualização vira invisível e reversível; app quebrado volta sozinho |
| 4 | Package manager e modelo de app: `Pkg.*`, permissões por pedido, intents, jobs com constraints, quota de storage | App declara intenção; não varre `/local/apps` nem implementa semver |
| 5 | Energia e confiança: governor com jobs agendados, `system` dividido em capacidades, secure boot/flash encryption na produção | Aparelho dorme e acorda para trabalhar; `system` deixa de ser superpoder de diálogo |

**Custo [estimativa]:** 35–65 KB de flash somando tudo, contra um piso de 64 KB livres no slot da CYD. Por isso a arquitetura é **Kconfig por placa**: a CYD recebe o núcleo (ondas 0, 1 parcial, 3 sem verificação de assinatura de app, 4 parcial); as S3 com PSRAM recebem o conjunto. Cada onda entra com `size_report --per-object` e atualização do ledger no mesmo commit.

**O que não muda:** Duktape ES5, coordenadas 240x320, `UI.*`/Kui, o hub como catálogo, a doutrina "substrato nativo, política em JS" — só que invertida onde ela está errada: política que **todo app precisa** e que **precisa sobreviver ao app** vira serviço nativo.

---

## 2. A régua: o que é um OS de primeira classe

"Parecido com Android" é uma metáfora útil, mas perigosa. O que se copia do Android é o **contrato**, não o isolamento: o ESP32 não tem MMU por processo, e o Duktape é um interpretador único por heap. Dá para ter as garantias de plataforma sem ter o sandbox de endereço — e é importante dizer isso em voz alta, porque metade das expectativas de "Android no ESP32" morre nessa diferença.

Um sistema é first-class quando o autor de app declara **intenção** e o sistema garante **execução**. Em oito garantias:

| # | Garantia | Teste de aceitação (o que o app deixa de fazer) |
|---|---|---|
| **G1** | **Identidade e instalação.** Todo app tem id, versão, autor verificável e o sistema sabe instalar, atualizar e remover sem perder dados. | O app não lê o próprio `app.json` nem sabe em que pasta está. |
| **G2** | **Ciclo de vida.** O sistema é dono do tempo: suspende, retoma, reinicia; crash de app não derruba o sistema. | O app não tem `try/catch` global nem tela de erro própria; não se auto-relança. |
| **G3** | **Conectividade.** O app pede "preciso de rede" e recebe; não configura rádio, não espera, não repete. | Nenhum `while (!Net.isConnected())`, nenhum backoff escrito no app. |
| **G4** | **Atualização.** Firmware, apps e deps atualizam sem o usuário pensar; falha reverte. | O app não chama `otaCheck`, não baixa `app.zip`, não decide hora de atualizar. |
| **G5** | **Armazenamento.** Espaço lógico por app, quota, dados privados, backup. | O app não conhece `/local`, `/sd`, nem checa `df` antes de gravar. |
| **G6** | **Energia.** O sistema decide quando economizar; o app declara trabalho, não segura o rádio. | O app não chama `wifiWake`, não orça janelas de rádio. |
| **G7** | **Segurança.** Capacidades verificadas no device, segredos fora do alcance de apps, cadeia de confiança do boot ao app. | O app não lê token de hub, não tem `system` por diálogo, não pode trocar firmware. |
| **G8** | **Contrato.** O que o app pode chamar é verificável no device e documentado a partir de uma fonte única; incompatibilidade é erro claro. | O app não compara `getAPILevel()` à mão nem faz `typeof` em dez objetos. |

**A régua secundária** é a do desenvolvedor: quantas linhas e quantas decisões de plataforma um "hello world com rede" exige. Hoje: ~19 linhas de UI, mas com `while (!conectado)`, retry manual, tratamento de truncamento em 32 KB, caminho físico de arquivo e um `app.json` cujo `api` o firmware não confere. O alvo: ~15 linhas, nenhuma decisão de plataforma.

---

## 3. Diagnóstico: o CelerOS medido

### 3.1 O que já é de primeira classe (não regredir)

Vale o crédito, porque o estudo seria desonesto sem ele:

- **A/B real de firmware.** `app0/ota_0` + `app1/ota_1` + `otadata`, sem partição factory, com `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y` e confirmação 30 s após o boot (`main/main.cpp`, `confirmPendingOta`). É mais do que muitos produtos embarcados têm.
- **Manifesto de OTA assinado.** ECDSA P-256 sobre `version/api_version/firmware_sha256/variant`, chave pública embutida, download com `Range` e retomada (`main/OTA/OtaManager.cpp`).
- **Níveis de API com histórico.** 55 níveis documentados, cada um com a razão de existir (`main/Runtime/AGENTS.md`, seção "API LEVEL HISTORY"). Isso é disciplina de plataforma rara.
- **Deps com semver e resolvedor de ponto fixo.** `^x.y.z`, fecho transitivo, paridade travada por `test/semver` em quatro implementações (hub, Loja, Studio, C++).
- **Jail de filesystem.** Canonicalização de caminho, bloqueio de `..`/`//`, pasta privada por app, lista de arquivos de sistema protegidos (`main/Runtime/JsFsJail.h`).
- **Consentimento e grants.** Permissões declaradas ∩ concedidas, persistidas em NVS por pacote (`main/Utils/AppGrants.h`).
- **Serviços de app com orçamento.** svchost com 12 serviços, 8 ms por giro, round-robin, heap compartilhado, superfície curada (`main/Kernel/AppServices.cpp`).
- **Forense de crash.** `CrashRecord` em RAM RTC, coredump, `MemWatch`, `LogPersist`, tela de crash com QR.
- **Ferramentas de desenvolvimento.** `celerctl`, `app_lint` derivando o manifest do firmware, harness com framebuffer, emulador, geração de `celer.d.ts`, Celer Studio com copiloto.

O problema não é falta de peças. É que elas não estão **no lugar de dono**.

### 3.2 Maturidade por garantia

| Garantia | Estado | Evidência |
|---|---|---|
| G1 Identidade/instalação | **Parcial** | `pkg` + versão + `AppPackage` transacional existem; **sem assinatura**; `.old` apagado após sucesso; sem recuperação de `/local/.install` no boot. |
| G2 Ciclo de vida | **Ausente** | App roda síncrono na main task; crash/erro mostra tela e volta ao launcher; nenhum restart; só serviço `system` tem 1 retry com 60 s (`AppServices.cpp`). |
| G3 Conectividade | **Parcial** | Rádio, credenciais cifradas, reconexão e roaming existem; **não há noção de "online"** (só "associado com IP"), nem fila, nem retry de SO, nem provisionamento automático no 1º boot. |
| G4 Atualização | **Parcial-forte (firmware) / fraca (apps)** | A/B + manifesto assinado; **política em JS** (`Nucleo`); apps atualizam sem confirmação e sem rollback; imagem não assinada; sem anti-rollback. |
| G5 Armazenamento | **Parcial** | Pasta por app e `Storage` por pacote; **sem quota**; jail com furos (`draw*` só canônica; `hub_token.txt`/logs fora da lista). |
| G6 Energia | **Parcial** | `PowerPolicy`, `ScreenPower`, deep sleep com janela de 90 s para alarmes; **sem job agendado**, `wifiWake` como hack de app. |
| G7 Segurança | **Fraco** | Gate por objeto; sem assinatura, sem secure boot/flash encryption, sem cofre de segredos; `system` concedido por diálogo único. |
| G8 Contrato | **Parcial** | API levels disciplinados; **não aplicados no launch**; `main` ignorado; drift 53/54/55. |

### 3.3 Números que delimitam o espaço de solução

- **CYD:** 4 MB, sem PSRAM, slot OTA de 1.638.400 B (`partitions_4MB.csv`), LittleFS de 768 KB, gate de CI de **64 KB livres** no slot. É o piso de flash do projeto.
- **svchost:** 12 serviços, `service.js` ≤ 64 KB, piso de 44 KB de heap livre sem PSRAM, orçamento de 8 ms/tick.
- **Runtime:** ~381 bindings no fonte; `System` chega a ~204 funções nas S3 completas e ~101 em headless.
- **Rede:** corpo de `Net.get` truncado em **32 KB em silêncio**; 2 slots assíncronos; duas TLS simultâneas são risco real sem PSRAM.
- **FS:** `readTextFile` 256 KB, `readFile` 64 KB, `writeFile` 64 KB, caminho 192 chars — e **nenhuma quota por app**.
- **Timer:** 8 slots por host. **App:** timeout de execução de 1 s por fatia, destravável por qualquer yield.

---

## 4. As quatro inversões

### 4.1 Inversão 1 — o app bombeia o SO

O caminho real de um lançamento:

```
celerLoop()
  └─ CelerServices::tickLoop()            (inApp=false)
       └─ svcNavigator → Navigator::tick()
            └─ AppHostScreen::onTick()
                 └─ LauncherUI::runApp()
                      └─ CelerKernel::runFile()      ← o app roda AQUI, síncrono
                           └─ (JS) System.getTouch()
                                └─ JSBindings::present()
                                     ├─ timersTick()
                                     ├─ CelerServices::tickPresent()   ← o SO roda AQUI
                                     └─ composição do quadro
```

Consequências diretas, todas visíveis:

- Serviços marcados `LOOP` (launcher, painéis, tela de alarme) **congelam** enquanto o app roda. Por isso alarme e notificação precisam **expulsar** o app (`LauncherUI::requestAppExit()`), em vez de desenhar por cima.
- Um app que só calcula, sem chamar binding, morre no timeout de 1 s. Um app que chama `System.millis()` em loop é imortal, porque cada binding renova a janela.
- O `DeviceStats` do `celerLoop` congela com app aberto.
- O svchost inteiro é **destruído** para o app caber na CYD sem PSRAM (`suspendForApp`).

Nada disso é bug. É a arquitetura: o SO é uma biblioteca chamada pelo loop do app.

### 4.2 Inversão 2 — a política mora em apps (o problema do bootstrap)

`data/apps/Nucleo/service.js` diz, com todas as letras, que a política de atualização "migrou do firmware". Ele decide janela de 24 h, grace de 60 s pós-conexão, gates de app aberto/shell/OTA, e notifica uma vez por versão. A App Store decide o que instalar e quando; o app `WiFi` decide como provisionar; `Settings` decide o gatilho do OTA.

O CelerOS orgulha-se, com razão, de ter tirado essas telas do firmware para caber no slot. Mas há uma diferença entre **tela** e **política**:

- Tela em JS: ótimo. Economiza flash, itera rápido, o hub atualiza.
- Política em JS: o caminho de reparo depende de um arquivo na LittleFS que o OTA **não toca**. Se o `service.js` quebrar (sintaxe, gate errado, Storage corrompido), o aparelho para de se atualizar — e a correção teria de chegar pelo mesmo canal quebrado.

O sintoma já apareceu no repo: `Nucleo` trata manifesto `rejected` como "atualizado" (`last_check="-"`), e a variante não vai nos manifestos publicados — um aparelho com relés recusa todo update em silêncio. A política é código de aplicação com responsabilidade de plataforma.

### 4.3 Inversão 3 — a confiança é nominal

Quatro furos independentes, que se somam:

1. **Não há assinatura de app.** `AppPackage`/`AppZip` validam estrutura, tamanho, CRC e limites de zip bomb — não autoria. A confiança é "veio do hub por HTTPS" ou "está na pasta".
2. **`system` é um superpoder de diálogo.** "Permitir" concede **todas** as permissões faltantes de uma vez; com `system`, o app chama `installZip`, `otaStart`, `restart`, `factoryReset`, escreve `/local/ota_url.txt` e `/local/ota_allow_http.txt` — e com isso pode instalar firmware HTTP sem assinatura.
3. **Segredos no FS comum.** `/local/hub_token.txt`, `/local/log/*.log` e `/local/lastcrash.txt` não estão na lista protegida do jail. Qualquer app com `fs` lê. As chaves de IA estão protegidas; o token do hub, não.
4. **Sem raiz de confiança no boot.** Sem secure boot, sem flash encryption, sem anti-rollback. A senha do Wi-Fi é cifrada com uma chave guardada **no mesmo NVS** do texto cifrado — sem NVS/flash encryption, isso é ofuscação, não cifra.

### 4.4 Inversão 4 — o contrato não é verificável no device

- `app.json.api` é validado pelo lint, pelo hub, pela Loja e pelo Installer — **não** pelo firmware. App sideloadado com API maior roda e quebra no primeiro símbolo ausente.
- `app.main` é validado na instalação (`AppPackage.cpp`) e **ignorado** no lançamento: `resolveApp` sempre monta `main.js`. Um pacote com `"main":"app.js"` instala e não abre.
- O nível de API aparece como 55 no CMake, 53 no `AGENTS.md` e no `main/Runtime/AGENTS.md`. O guia já está em 54/55 em pontos diferentes.
- `system: true` é documentado como "recebe tudo" em um guia e como "declaradas ∩ concedidas" no outro.

O efeito para o desenvolvedor é o pior possível: o contrato existe, mas ele descobre o contrato **em runtime, por erro**.

---

## 5. Arquitetura-alvo

### 5.1 Princípio

> **Substrato nativo. Política declarativa. App = intenção + tela.**

A doutrina atual do projeto ("lógica de app e driver de protocolo vão para deps JS; fica em C++ o substrato que todo app usa") está certa, mas foi aplicada pela metade: conectividade, atualização, instalação e supervisão **são** substrato que todo app usa — e hoje estão em JS ou não existem.

Regra de decisão para o futuro, em três perguntas:

1. **Todo app precisa?** → nativo (senão cada app reimplementa e divergem).
2. **Precisa sobreviver ao app?** → nativo (senão o app é o dono do relógio).
3. **É tela, fluxo ou política de produto?** → JS (o hub corrige sem OTA).

### 5.2 Camadas

```
┌──────────────────────────────────────────────────────────────────────┐
│  APPS (JS ES5)            UI/fluxo; declaram intenção no manifest v2 │
│                           App.info · Net.fetch · Job.every · Pkg.*   │
├──────────────────────────────────────────────────────────────────────┤
│  RUNTIME (Duktape)        contrato: API gate, eventos, permissões,   │
│                           App.dataDir, erro tipado                   │
├──────────────────────────────────────────────────────────────────────┤
│  SERVIÇOS DE PLATAFORMA (C++, na tabela kServices)                   │
│   AppSupervisor  ConnectivityService  UpdateService  PackageService  │
│   PowerGovernor  OverlayCompositor    SecretVault    JobService      │
├──────────────────────────────────────────────────────────────────────┤
│  SUBSTRATO (C++)          NetworkManager · HttpClient · OTA · FS jail │
│                           Kui/Navigator · ScreenPower · NVS          │
├──────────────────────────────────────────────────────────────────────┤
│  HAL / BOOT               Board · partições A/B · secure boot · eFuse│
└──────────────────────────────────────────────────────────────────────┘
```

### 5.3 Dono de cada preocupação

| Preocupação | Dono hoje | Dono alvo | API para o app |
|---|---|---|---|
| Instalar/atualizar app | App Store (JS) + `installZip` | `PackageService` | `Pkg.install/list/remove` |
| Quando atualizar firmware | `Nucleo` (JS) | `UpdateService` | `Update.check()` (só UI) |
| Política de rede/retry | cada app | `ConnectivityService` | `Net.fetch({waitOnline,retry})` |
| Provisionar Wi-Fi | app `WiFi` | `ConnectivityService` + setup nativo | nenhuma (setup de SO) |
| Segurar rádio acordado | `System.wifiWake` | `PowerGovernor` + `Job` | `Job.every(...,{needs:["net"]})` |
| Notificação sobre app | expulsa o app | `OverlayCompositor` | `Notify.post` |
| Reiniciar app quebrado | ninguém | `AppSupervisor` | nenhuma |
| Quota de dados | ninguém | FS broker | `App.quota` |
| Segredos | arquivos no FS | `SecretVault` | `System.secret` (tier sistema) |
| Gate de API | hub/lint/loja | runtime (`runFile`) | erro nativo "requer N" |

### 5.4 O que continua em JS (e por quê)

- **Toda a UI**: `UI.*`, Kui, telas de Settings, Loja, WiFi. É o que mais muda e o que menos precisa de garantia de plataforma.
- **Catálogo e curadoria do hub**: o firmware não deve carregar a loja. Ele carrega o **instalador** e o **updater**; o catálogo é dado.
- **Deps de protocolo e driver de dispositivo**: `celeros.usb.escpos`, `celeros.hw.*`, engine de jogos. Já é a doutrina e está certa.
- **Fluxos de produto**: onboarding, textos, ordernação, experimentos.

O teste para saber se algo deve virar nativo não é "é importante?", é: **"se este código quebrar, o aparelho consegue se consertar sozinho?"** Se a resposta for não, é plataforma.

---

## 6. Ondas de execução

Cada onda é independente o suficiente para entrar sozinha, com gate próprio. A ordem foi escolhida por relação impacto/risco, não por elevação arquitetural.

### Onda 0 — Verdade única do contrato

**Problema.** O contrato existe em cinco lugares que divergem: CMake, `kFns` tables, guia EN, guia pt-BR, `celer.d.ts`, `app_lint`. O device não valida nada.

**Desenho.**

1. **Manifest v2 validado no device.** `PackageService`/launcher leem `api`, `main`, `requires`, `deps` (fechado) e `permissions` de forma estrita. Campo desconhecido é aviso; campo inválido recusa a instalação com motivo.
2. **Gate de API no lançamento.** `CelerKernel::runFile` recebe `appApi` e `depsMinApi`; se `appApi > CELEROS_API_LEVEL`, tela nativa "Este app requer CelerOS N — atualize o sistema", com botão que abre `UpdateService`. Nunca `TypeError`.
3. **`main` honrado ou removido do schema.** Recomendo honrar: custo ~zero e elimina uma classe de bug silencioso.
4. **`App.info`** — `{id, name, version, api, dataDir, permissions, caps}`. O app para de ler o próprio `app.json` e de hardcodar `/local/apps/<Nome>/`.
5. **Fonte única.** `tools/sdk/api.json` gerado a partir das tabelas de binding + nível do CMake; o build do firmware consome um header gerado, e `celer.js types`, os dois guias, o lint e o hub leem o mesmo arquivo. `test/api_manifest` falha se divergirem. Mata o drift 53/54/55 de uma vez.
6. **Taxonomia de erro.** `Net.fetch` devolve `{ok, status, body, error:{code,message}}` com `NO_NETWORK`, `TIMEOUT`, `TLS`, `HTTP`, `TRUNCATED`, `QUEUED`. O `Net.get` atual lança sem rede e trunca em 32 KB **em silêncio** — os dois piores comportamentos possíveis para quem está começando.

**Toca em:** `main/Launcher/LauncherUI.cpp` (`resolveApp`, scan), `main/Kernel/Core/CelerKernel.cpp` (`runFile`), `main/Runtime/JSBindings.cpp` (`init`), `main/Utils/AppPackage.cpp`, `tools/sdk/celer.js`, `tools/app_lint/lint.js`, guias.

**Custo [estimativa]:** 2–4 KB de flash. **Risco:** baixo. **Aceite:** app com `api: 56` recusado no device com mensagem; app com `main: "app.js"` abre; `celer.js check` não acha divergência de nível.

---

### Onda 1 — O SO dono do quadro e do relógio

**Problema.** Notificação e alarme expulsam o app; crash é tela final; não há supervisor; o app monopoliza a main task.

**Desenho.**

1. **`OverlayCompositor`.** O `present()` já compõe a topbar num `FrameSprite` com até 8 caixas sujas. Generalizar para uma pilha de camadas:
   - base: quadro do app;
   - camada 1: chrome do sistema (topbar, indicadores);
   - camada 2: overlays transitórios — banner de notificação, chamada, progresso de OTA, toasts.
   Overlays desenham numa região, não na tela toda, e **não** pedem `requestAppExit()`. Alarme em tela cheia continua sendo tela (é o comportamento do Android também: heads-up ≠ full screen).
   Limite honesto na CYD: banner de 240x40 = ~19 KB de buffer; nada de segunda camada full-screen. O compositor deve recusar overlay que não caiba.
2. **`AppSupervisor`.** Política explícita:
   - erro JS → registra, mata o app, volta ao launcher; **não** é tela bloqueante;
   - crash repetido (N em T) → app marcado "instável", notificação com "desativar";
   - **safe mode**: 3 boots consecutivos com crash antes do launcher → sobe só com apps `system` assinados e mostra tela de recuperação (o `CrashRecord` em RAM RTC já guarda o motivo; falta o contador de boots).
3. **Orçamento por app.** Substituir o timeout de fatia "destravável" por um contrato explícito: o runtime injeta `App.frame()` (ou mantém `UI.end`) e conta o tempo **acumulado** de CPU do app por janela; estourou, o supervisor suspende e notifica. Isso não é preempção — é contabilidade, e é o que dá para fazer sem task separada.
4. **Task própria do app (só PSRAM).** Ligar `CELEROS_APP_TASK` primeiro nas S3, com o svchost adaptado (hoje o Kconfig declara a incompatibilidade). Sem PSRAM, a CYD fica no modelo cooperativo com o compositor — que já resolve o sintoma visível.
5. **Recents (barato).** Guardar `{pkg, args}` do último app e permitir relançar com o mesmo estado de navegação. Não é multitarefa; é continuidade percebida.

**Toca em:** `main/Runtime/JSBindings.cpp` (`present`), `main/Display/FrameSprite`/`DirtyRects`, `main/Launcher/NotificationAlert.cpp`, `main/Launcher/AlarmScreen.cpp`, `main/Kernel/AppRunner.cpp`, `main/Kernel/Services.cpp`, `main/Kernel/CrashRecord.cpp`.

**Custo [estimativa]:** 8–14 KB. **Risco:** médio-alto (concorrência de vídeo). **Aceite:** notificação com app aberto aparece por cima sem sair do app; app que lança exceção volta ao launcher em < 1 s sem tela de erro; 3 crashes → safe mode.

---

### Onda 2 — Conectividade como serviço (`netd`)

**Problema.** "Conectado" significa "associado com IP". Não há sonda de internet, fila, retry de SO nem evento. Todo app reimplementa `A.wifiWait()` + `A.net.retry()`. O provisionamento de 1º boot exige abrir um app.

**Desenho.**

1. **Estados explícitos.** `OFF`, `ASSOCIATING`, `ONLINE`, `PORTAL`, `UNREACHABLE`. Reachability com sonda leve (HEAD no hub ou URL de captive portal, timeout 3 s, cache 30 s, só quando associado). `NetworkManager` já tem a máquina de estados e o backoff 5→60 s; falta o estado de camada 7.
2. **`Net.fetch` com política.** Espera online (bounded), retry com backoff+jitter, dedupe de GETs iguais, cache opcional em `App.dataDir`. Implementação bloqueante com `present()` em fatias (como `System.prompt` já faz), então a UI continua desenhando. Para serviços, `Net.requestAsync(opts, cb)`.
3. **Eventos.** `Net.on("change", cb)` e `Net.on("online", cb)` entregues no próximo yield — o `timersTick` do `present()` já é um mini event loop; não é preciso inventar outro.
4. **Provisionamento de 1º boot.** Sem credenciais: sobe o AP e o portal automaticamente (hoje é manual), com timeout e tela de instruções; QR de setup gerado no device (o LovyanGFX já desenha QR no crash). BLE como segunda porta, reaproveitando o canal selado do `CelerLink` — mas consumido **nativamente**, não por um par de apps (`Celer Remote` → `Dog Face`).
5. **Cofre de segredos.** `SecretVault` com política por app: token do hub, chaves de IA, chaves da malha saem do FS comum; `System.secret.get(name)` só para tier sistema; o resto recebe um handle opaco para `Net.fetch` autenticado. Fecha o furo do `hub_token.txt` e dos logs.
6. **Pool TLS.** Uma sessão keep-alive por host, prioridade `OTA > sistema > app`, fila única. Duas TLS simultâneas na CYD hoje são um risco real, e a serialização é feita por acordo entre apps (`System.updateBusy`), não pelo SO.

**Toca em:** `components/Network/*`, `components/Http/HttpClient.*`, `main/Runtime/JsNet.cpp`, `main/WebManager/WifiSetupPortal.cpp`, `main/Runtime/JsFsJail.h`.

**Custo [estimativa]:** 10–16 KB. **Risco:** médio. **Aceite:** app que só chama `Net.fetch({waitOnline:30000})` funciona em aparelho que liga sem Wi-Fi e recebe credenciais no meio; dois apps + OTA não estouram a RAM.

---

### Onda 3 — Update como serviço (`updater` + `pkgd`)

**Problema.** A política está em JS; apps atualizam sem rollback; não há assinatura de app; a imagem não é assinada; queda de energia entre dois `rename` deixa app sumido.

**Desenho.**

1. **`UpdateService` nativo.** Cadência com jitter, grace pós-conexão, gates de tela/bateria/app aberto, download em background para o slot inativo, aplicação no próximo idle com reboot agendado. O JS de `Nucleo` fica só com o painel ("última verificação", "instalar agora").
2. **Update de app transacional com saúde.** `pkgd` mantém a versão anterior em `.old` até a nova provar que sobe: marcador "trial"; N lançamentos ou T segundos sem crash → commit; crash antes → revert automático e notificação. Fecha o risco de a atualização das 02:00 quebrar Settings/Loja/Nucleo.
3. **Journal de instalação.** Estado em NVS (`install/<pkg>` = `staging|swapping|committed`) + recuperação no boot. Queda de energia entre os dois renames hoje deixa a pasta fora de `/local/apps` e ninguém conserta.
4. **Assinatura de app.** ECDSA P-256 sobre o canônico (id, versão, hashes dos arquivos, deps) — a **mesma curva** já ligada para o OTA, então o custo de cripto é quase zero. Raiz de confiança única: o hub assina todo app; mais tarde, chaves de publisher delegadas. Verificação na instalação e no boot scan; app sem assinatura só em modo dev.
5. **Imagem assinada em todos os escritores.** Hoje só o caminho do hub exige assinatura; `celerctl push`, `/update` web e HTTP local gravam qualquer binário. A verificação deve estar no `OtaGuard`, não no chamador.
6. **Produção: secure boot + flash encryption + anti-rollback.** Em build de fábrica, opt-in por placa. Como é irreversível (eFuse), a migração é: primeiro assinar imagem e apps; secure boot na próxima leva de fábrica; documentar recuperação.
7. **Retomada entre boots e delta.** Persistir progresso/hash por slot para o download sobreviver a reboot; depois, delta assinado (imagem CYD ~1,38 MB; ganho esperado alto, complexidade também).
8. **CI publica.** Tag → firmware + apps + deps publicados, com canal/variante derivados do build. Hoje `publish` é passo humano com árvore limpa e token, e o skew repo (1.13/API 55) × hub (1.11.6/API 50) mostra que o estado do canal não é derivado de CI.

**Toca em:** `main/OTA/*`, `main/Utils/AppPackage.*`, `main/Runtime/JsSystemApps.cpp`, `data/apps/Nucleo`, `data/apps/App Store`, `.github/workflows/release.yml`, `tools/celerhub.py`.

**Custo [estimativa]:** 6–12 KB no app (o bootloader de secure boot cresce à parte). **Risco:** médio para updater; alto/irreversível para secure boot. **Aceite:** corte de energia no meio de um update de app → boot recupera a versão anterior; app atualizado que crasha 2× → revert sozinho; zip adulterado recusado com motivo.

---

### Onda 4 — Package manager e modelo de app de verdade

**Problema.** Não há API de catálogo local; permissão é tudo-ou-nada num diálogo; não há IPC; não há trabalho em background agendável; storage não tem quota.

**Desenho.**

1. **`Pkg.*`** — `list`, `info`, `install`, `remove`, `versions`, `granted`. O app para de varrer `/local/apps` e ler `app.json` alheio.
2. **Permissões por pedido.** `App.permissions` (consulta) + `System.requestPermission(name)` (diálogo nativo bloqueante, como o `prompt`). Concessão por permissão, revogação em Configurações, e `system` deixa de ser concedível por diálogo: vira **tier de instalação** para app assinado.
3. **Intents.** `System.startApp({action, uri, data})`, `System.onIntent(cb)`, `System.broadcast(action, data)`. Hoje o único acoplamento é `launchApp` + o app atual morrendo, sem parâmetro nem retorno.
4. **Jobs.** `Job.every(period, constraints, fn)` e `Job.once(at, ...)`, com constraints `needs:["net"]`, `charging`, `screenOff`, `idle`. Implementação: `JobService` agenda no RTC, acorda o SoC, roda o serviço em janela limitada (ex. 20 s) e volta a dormir — o boot com `bootReason=job` é o equivalente ao `BOOT_COMPLETED`. Isso substitui `System.wifiWake` e a política de 6×5 min escrita à mão na App Store.
5. **Quota de storage.** Bytes por `pkg`, aplicada no broker de FS, com erro `QUOTA` e `App.quota`. Protege o LittleFS global (a Loja já sofre com 44–108 KB livres na bancada; um app pode encher o disco e derrubar todo mundo).
6. **Canais de notificação.** `Notify.post({channel, title, body, actions})`; a central nativa já existe, falta o contrato.

**Toca em:** `main/Utils/AppPerms.h`, `main/Launcher/LauncherUI.cpp`, `main/Runtime/JSBindings.cpp`, `main/Runtime/JsSvc.cpp`, `main/Kernel/Alarms.cpp` (jobs), `main/Kernel/AppServices.cpp`.

**Custo [estimativa]:** 8–14 KB. **Risco:** médio. **Aceite:** app de exemplo agenda job diário, o aparelho dorme, acorda, roda e dorme; app que enche a quota recebe erro e o sistema segue saudável.

---

### Onda 5 — Energia e confiança

**Problema.** `system` é superpoder; credenciais vivem em NVS sem cifra de repouso; não há wake lock contratual nem divisão de capacidades.

**Desenho.**

1. **`PowerGovernor`.** Wake locks com TTL e motivo (`System.wakeLock(ms, reason)`, gated), política Doze-like (tela apagada → jobs coalescidos, rádio em janelas) e contabilidade de energia por app visível em Configurações.
2. **Divisão de `system`.** `power`, `net.admin`, `pkg.install`, `ota`, `factory`. Cada uma com gate próprio nas tabelas de binding. `system` passa a significar "app de sistema assinado" e não "pode tudo".
3. **NVS/flash encryption + cofre.** Credenciais e chaves de malha cifradas com chave fora do alcance do FS; `SecretVault` usa a mesma raiz.
4. **Auditoria de capabilities.** Log persistente de "app X usou `ota`/`install`/`gpio`" para o usuário e para o suporte.

**Toca em:** `main/Hardware/PowerPolicy.*`, `main/Display/ScreenPower.*`, `main/Utils/AppPerms.h`, `main/Runtime/JSBindings.cpp`, `components/Network/CredCipher.*`.

**Custo [estimativa]:** 3–6 KB. **Risco:** baixo (exceto eFuse). **Aceite:** nenhum app de catálogo consegue `ota`/`install` sem tier; credenciais não são legíveis nem com dump do FS.

---

## 7. O antes e o depois para o autor de app

### 7.1 Buscar dados na rede

**Hoje** — o app precisa saber que "conectado" ≠ "internet", que `Net.get` lança sem rede, que o corpo trunca em 32 KB e que o retry é dele:

```js
while (!Net.isConnected()) {
  UI.text(10, 100, "Sem rede...");
  if (UI.button(10, 140, 100, 28, "Tentar")) break;
  UI.end();
}
var r = null;
for (var i = 0; i < 3 && !r; i++) {
  r = Net.request({ url: URL, timeoutMs: 8000 });
  if (!r) System.delay(1500 * (i + 1));
}
if (!r) { UI.text(10, 120, "Falhou"); UI.end(); System.delay(2000); System.exitApp(); }
else if (r.body.length >= 32768) { /* truncado — precisa de Net.download + FS */ }
```

**Alvo** — o app declara a intenção; o SO espera, repete, tipa e cacheia:

```js
var r = Net.fetch({ url: URL, waitOnline: 30000, retry: 3, cache: "app" });
if (!r.ok) {
  UI.text(10, 120, r.error.message);   // NO_NETWORK | TIMEOUT | TLS | HTTP | QUOTA
} else {
  UI.text(10, 120, r.body);
}
```

### 7.2 Trabalho de fundo

**Hoje** — o app precisa saber que `setInterval` só roda no `present()`, que há 8 timers, que precisa de `wifiWake`, e reimplementar a política:

```js
// service.js — política de quando atualizar, escrita à mão
var GRACE = 60, DAY = 24 * 3600;
var ticks = 0, connectedAt = 0, checked = false;
setInterval(function () {
  ticks++;
  var conn = System.wifiStatus().connected === true;
  if (conn && !connectedAt) connectedAt = ticks;
  if (conn && ticks - connectedAt > GRACE && (!checked || ticks % DAY === 0)) {
    checked = true;
    System.wifiWake(5);
    var r = System.otaCheck();
    /* ...notifica, grava Storage, trata rejected... */
  }
}, 1000);
```

**Alvo** — o SO agenda, acorda, roda e dorme:

```js
Job.every(24 * 3600, { needs: ["net"], idle: true, grace: 60 }, function () {
  var m = Update.check();          // assinado, variante, canal — tudo no SO
  if (m.available) Update.download();   // aplica no próximo idle
});
```

### 7.3 O que o autor deixa de precisar saber

| Hoje ele precisa saber | Dono alvo |
|---|---|
| `/local`, `/sd`, `/local/apps`, `/local/data/<pkg>` | `App.dataDir` / `app://` |
| `Net.isConnected` e o loop de espera | `Net.fetch({waitOnline})` |
| retry/backoff por app | política do `ConnectivityService` |
| truncamento de 32 KB | `Net.fetch` streaming + `TRUNCATED` tipado |
| 8 timers, `present()` como bomba | runtime + `Job` |
| permissões como objeto ausente | `App.permissions` + `requestPermission` |
| `system: true` e o que ele concede | tiers de instalação |
| deps/semver/`deps.json` | `Pkg.*` |
| quando e como atualizar | `UpdateService` |
| como pôr o aparelho no Wi-Fi | setup de SO |
| tela de erro e auto-relançamento | `AppSupervisor` |
| quota e limpeza de disco | FS broker |

### 7.4 O "hello world com rede" alvo

```js
// app.json: {"name":"Clima","packageName":"br.exemplo.clima","version":"1.0.0",
//            "api":56,"permissions":["net"]}
var T = System.theme();
while (true) {
  UI.begin(T.bg);
  UI.header("Clima");
  var r = Net.fetch({ url: "https://api.exemplo/tempo", waitOnline: 15000, retry: 2 });
  UI.text(12, 60, r.ok ? r.body : r.error.message);
  if (UI.button(12, 280, 100, 30, "Atualizar")) { /* proximo laco busca de novo */ }
  UI.end();
}
```

Nada de Wi-Fi, nada de retry, nada de caminho, nada de versão de API — e o app continua sendo ES5, rodando na CYD.

---

## 8. Orçamento de flash/RAM e como pagar

O slot da CYD é o piso: 1.638.400 B, com gate de CI de 64 KB livres e ledger por objeto (crescimento > 512 B exige atualização no mesmo commit).

| Onda | Flash [estimativa] | RAM [estimativa] | Onde entra |
|---|---:|---:|---|
| 0 Contrato | 2–4 KB | ~1 KB | todas |
| 1 Compositor + supervisor | 8–14 KB | 0,5–2 KB + banner (~19 KB só durante o overlay) | todas; task própria só S3 |
| 2 `netd` + cofre | 10–16 KB | 2–6 KB (fila) | todas; pool TLS só PSRAM |
| 3 Updater + pkgd + assinatura | 6–12 KB | 1–2 KB | todas; verificação de app só tier completo |
| 4 Pkg/Jobs/quota | 8–14 KB | 1–3 KB | todas |
| 5 Governor + auditoria | 3–6 KB | ~1 KB | todas |
| **Total** | **37–66 KB** | **~10–15 KB** | |

Isso **não cabe** na CYD ao mesmo tempo. Formas de pagar, em ordem de preferência:

1. **Kconfig por placa.** A CYD recebe ondas 0, 1 (sem task própria), 3 (updater e rollback, sem assinatura de app) e 4 parcial. As S3 recebem tudo. O padrão já existe (menu de features, perfil lite).
2. **Reuso, não reimplementação.** Compositor estende `FrameSprite`/`DirtyRects`; jobs estendem `Alarms`; assinatura reusa o PSA/mbedTLS já ligado pelo OTA; cofre reusa `CredCipher`. O que é novo é orquestração, não cripto.
3. **Aposentadoria de legado.** Aliases de binding antigos, caminhos duplicados de WiFi e o que o `app_lint` já marca como morto podem pagar parte da conta. Medir antes de cortar.
4. **CI como árbitro.** Cada onda entra com `size_report --per-object` e `--save-ledger`; nenhuma onda entra "no escuro".

**Regra de ouro:** nenhuma onda pode aumentar o piso de RAM sem PSRAM. A CYD não ganha buffer novo de tela cheia; ganha contabilidade e overlays pequenos.

---

## 9. Métricas de aceitação ("first-class" mensurável)

O estudo só vale se der para provar. Dez testes, a maioria automatizável no harness/CI:

| # | Métrica | Como medir | Alvo |
|---|---|---|---|
| 1 | Apps que fazem polling de rede | `grep -r "isConnected" data/apps hub_apps` | 0 após migração |
| 2 | Apps com retry próprio | `grep -rE "retry" apps` e `grep -rE "backoff" apps` | 0 fora de deps de plataforma |
| 3 | Apps que conhecem caminho físico | `grep -r "/local" apps` | 0 fora de tier sistema |
| 4 | Gate de API | app fixture com `api+1` | recusa nativa com mensagem |
| 5 | Supervisor | matar loop de app via `celerctl` | volta ao launcher < 1 s; 3× → safe mode |
| 6 | Update de app | corte de energia entre renames | boot recupera versão anterior |
| 7 | Assinatura | zip adulterado | recusa com motivo; original instala |
| 8 | Quota | app grava 10 MB | erro `QUOTA`; sistema saudável |
| 9 | Job | agendar +2 min, dormir | acorda, roda, volta a dormir; consumo medido [bancada] |
| 10 | Update sem toque | aparelho em 1.13 overnight | 1.14 aplicado, Settings/Loja intactos |

Complemento de produto: **"o app de exemplo do guia tem 0 linhas de plataforma"** — nenhum `isConnected`, nenhum retry, nenhum caminho, nenhum `getAPILevel`.

---

## 10. Alternativas descartadas (e por quê)

Registrar o que **não** vamos fazer evita a próxima rodada de debate.

1. **Preempção real / multitarefa de apps com UI.** Sem MMU por processo e com 4 MB sem PSRAM na CYD, o custo é uma task por app + stack + framebuffer + todo binding thread-safe. Não paga. O que paga é o compositor + serviços nativos donos do relógio — 80% do comportamento percebido.
2. **Mover a UI para outra task na CYD.** O `CELEROS_APP_TASK` existe e está desligado em todas as placas. Ligar na CYD troca um problema de arquitetura por um problema de RAM e de concorrência de vídeo (o histórico de "embaralhada" do 4848 mostra o terreno).
3. **Levar a Loja para o firmware.** O catálogo é dado e muda toda semana; o firmware deve ter o **instalador** e o **updater**, não a vitrine. A vitrine pode continuar em JS — ela não é caminho de reparo.
4. **Trocar Duktape por QuickJS-NG.** Já avaliado: não cabe na CYD e o ganho (ES6+) não é o gargalo do produto. O gargalo é contrato e plataforma.
5. **Sandbox de memória "de verdade".** Sem MMU, o máximo é capability + assinatura + revisão. Prometer sandbox seria mentir para o usuário.
6. **Um "serviço de nuvem" obrigatório.** O aparelho precisa funcionar offline e sem conta. O hub é canal de distribuição, não dependência de runtime.
7. **Duplicar política em C++ e JS "para garantir".** Já aconteceu (o comentário do `updcheck` ficou obsoleto no `Services.cpp`). Uma política, um dono.

---

## 11. Riscos, armadilhas e não-objetivos

**Riscos de execução**

- **Concorrência de vídeo.** Compositor e overlays mexem no caminho mais sensível do projeto (o 4848 já teve embaralhada por fome de PSRAM). Qualquer mudança aqui exige soak na bancada, não só harness.
- **Flash.** 35–65 KB é mais do que o piso da CYD; sem Kconfig e ledger, a onda 1+2 já estoura.
- **Secure boot é irreversível.** Um erro de chave em eFuse inutiliza a placa. Só em lote de fábrica, com plano de recuperação documentado.
- **Migração de apps.** Mexer em contrato exige bump de API, docs EN+pt-BR, stub do harness, `celer.js types`, e bump+publish de todo app tocado. O custo de coordenação é real.
- **O svchost é o ponto frágil.** Heap compartilhado, 12 serviços, piso de 44 KB; um fatal derruba o aparelho. A onda 4 mexe exatamente ali.

**Armadilhas do projeto que qualquer implementação deve respeitar**

- `-fno-exceptions`: `std::string`/`new` que não cresce **aborta**. Caminho de OOM usa `malloc`/`realloc` e buffers fixos.
- Ledger por objeto: crescimento > 512 B em `main/libmain.a` exige atualização no mesmo commit.
- CYD é unicore com IRAM 8-bit: nada pinado no core 1; o fonte do app, os buffers TLS e o overflow do Duktape vivem ali.
- `present()` é contrato de vida: sem ele não há timer, AI, serviço ALWAYS, WDT nem GC. Qualquer refatoração de ciclo de vida precisa preservar (ou substituir explicitamente) esse ponto.
- App mudou = bump + changelog + commit + `publish`; dep mudou = bump + `publish-dep` + regenerar `data/modules`; `deps-status` limpo.
- Feature de device só fecha na bancada: `install.sh` já quebrou todo boot por nunca ter rodado verde.

**Não-objetivos**

- Não rodar binário Android nem APK.
- Não ter Play Services, conta obrigatória ou nuvem obrigatória.
- Não ter dois apps de UI em foreground ao mesmo tempo.
- Não substituir o hub por uma loja embutida no firmware.
- Não prometer isolamento de memória entre apps.

---

## 12. Sequência recomendada

**Curto prazo (2–3 semanas) — o que dá para fazer sem tocar em vídeo nem em eFuse**

1. Onda 0 inteira: manifest v2 no device, gate de API, `App.info`, fonte única de tipos/docs, taxonomia de erro. É barato, mata o drift e muda a vida de quem escreve app imediatamente.
2. `AppSupervisor` mínimo: erro não bloqueia, crash conta, safe mode com 3 boots. Reusa `CrashRecord`.
3. Journal de instalação + recuperação de `/local/.install` no boot. Corrige um buraco real de queda de energia.

**Médio prazo (1–2 meses) — o que muda o modelo**

4. `ConnectivityService` + `Net.fetch` com política + eventos + provisionamento automático de 1º boot.
5. `UpdateService` nativo com download em background e aplicação no idle; `Nucleo` reduzido a painel.
6. `OverlayCompositor` com banner de notificação sobre o app (sem full-screen na CYD).

**Longo prazo (3–6 meses) — o que fecha a plataforma**

7. Assinatura de app (ECDSA P-256, raiz no hub) + update de app com health check e revert.
8. `Pkg.*`, permissões por pedido, intents.
9. `Job` com constraints e acordar por RTC.
10. Produção: imagem assinada, secure boot + flash encryption + anti-rollback, CI publicando.

**O primeiro commit sugerido** é pequeno e de alto retorno: `Api: nivel unico gerado do codigo e gate no lancamento` — um `tools/sdk/api.json` gerado, o header consumido pelo firmware, o gate em `runFile` e `test/api_manifest`. Ele sozinho resolve G8 e prepara todas as outras ondas (sem contrato verificável, nenhuma migração é segura).

---

## 13. O que já foi implementado (2026-11-03)

O **núcleo da Onda 0**, a superfície de plataforma da Onda 2 e a primeira
fatia de supervisor/journal das Ondas 1/3 entraram nesta árvore em
**1.14.0 / API 56**:

| Mudança | Onde | Efeito |
|---|---|---|
| `AppManifest` (api/main/version/requires) | `main/Utils/AppManifest.h` (novo, host-testado) | O device lê o mesmo manifesto que o hub valida; 29 casos no `test/cpp` |
| Gate de API no lançamento | `LauncherUI::gateEntry` + `CelerKernel::showNotice` | `api` ilegível ou maior que o firmware → tela nativa "Atualização necessária", antes do heap |
| `main` honrado | `LauncherUI::resolveApp` | Pacote com `"main":"app.js"` abre o entry certo (antes sempre `main.js`) |
| `App.info()` | `JSBindings::js_appInfo` | `{id,name,version,dataDir,api,runtimeApi,system,permissions}` sem ler arquivo |
| `Net.fetch(opts)` | `JsNet.cpp` | `waitOnline` (fatias de 50 ms), `retry` só em GET (400..3200 ms), erro tipado e `TRUNCATED` visível |
| Truncamento explícito | `JsBodySink::overflow` | O teto de 32 KB deixa de ser silencioso |
| Journal + recuperação | `Utils/AppPackage.*` | Queda entre os dois renames deixa de sumir com o app: o boot devolve a última versão que rodou (`.old`), nunca promove um `.new` não confirmado |
| Modo seguro | `Kernel/BootGuard.*` + serviço `bootguard` | 3 boots sem 15 s de uptime → não reabre casa/autostart e avisa na tela; contador em RAM RTC, sem desgaste de NVS |
| Tela de erro com prazo | `CelerKernel::showRuntimeError` | 12 s ou toque; um app que quebra no boot não prende mais o aparelho na tela de erro |
| Update de app com saúde | `AppPackage` trial + `CelerKernel::runFile` + `recover` | Apps do caminho de reparo (Loja, Configurações, Instalador, WiFi) guardam o `.old`; o primeiro lançamento limpo confirma, erro reverte na hora e boot instável reverte no boot seguinte |
| Política de update nativa | `Kernel/UpdateService.*` + `Utils/UpdatePolicy.h` + serviço `updatesvc` | O "quando" (grace 60 s, 24 h, gates de app/shell/OTA) saiu do `Nucleo/service.js` — o OTA conserta a política. Cache de 5 min no `OtaManager` e mesmas chaves de Storage (`last_check`/`noted_ver`) mantêm o painel do Nucleo e evitam check/notificação duplicados |
| Contrato único | CMake + guias EN/pt-BR + `celer.d.ts` + harness | API 56 nos quatro lugares; `celer.js check` sem erro (ainda sem um `api.json` gerado como fonte única) |

**Fora deste passo, dentro da Onda 0:** o `api.json` gerado (hoje a
consistência é verificada, não derivada), o `depsMinApi` no device (o
`deps.json` não carrega `minApi`; a checagem continua no install) e a
depreciação do `Net.get` (que segue lançando/null e truncando em silêncio —
`Net.fetch` é o caminho novo).

**Medido (CYD, sem PSRAM):** imagem **1.562.800 B / 1.638.400 B**, **73 KB
livres** (gate de CI: 64 KB). `Net.fetch` custou **+2.731 B** em
`JsNet.cpp.obj`, o journal/trial **+2.359 B** em `AppPackage.cpp.obj` e o
supervisor **+1.667 B** em `CelerKernel.cpp.obj`; o `UpdateService` é um
objeto novo de **893 B**. O ledger por objeto foi atualizado em cada passo.
Os builds CYD e devkit headless fecharam sem erro.

**Bancada 4848 (2026-11-03, `smartdisplay_4in`, 1.14.0/API 56):**

- `App.info()` no device: `id=bench.info name=InfoTest ver=1.0.0 api=56/56
  sys=false dir=/local/data/bench.info/ perms=` — identidade e contrato certos.
- `Net.fetch`: 200 com corpo (servidor HTTP local), 401 do próprio web server
  classificado como `HTTP/401` (o `HttpClient` marca `success=false` em 401
  com corpo; a bancada pegou a classificação errada como `TRANSPORT/status 0`
  e o código passou a usar `statusCode > 0` como "houve resposta").
- `main: "app.js"` honrado no device (`[bench] main=app.js honrado`).
- Gate de API: app `api: 57` **não** chega a `runFile` (sem `[TB] init`);
  a tela nativa de aviso bloqueia a main task (o `screencap` não roda com ela
  aberta) e um toque a dispensa.
- `UpdateService` de ponta a ponta: 60 s após conectar, buscou
  `update.json` do servidor local (200, 270 ms) e gravou
  `last_check=9.9.9`/`noted_ver=9.9.9` na Storage de `celeros.nucleo`; um app
  probe no mesmo namespace leu os dois valores.
- O gate final bloqueia só app em foreground **com o vidro aceso** (dim
  conta; AOD/off não). A casa/watchface dormindo deixa de bloquear o check;
  aparelho com a tela sempre acesa (`screen_timeout` 0, como este 4848)
  continua checando no launcher. O fetch HTTPS segue síncrono na main task:
  o congelamento possível é o do launcher, 1×/24h — um worker dedicado fica
  para quando houver demanda de tela sempre acesa com app aberto (e soak de
  concorrência de TLS).

**Ainda não implementado:** compositor de overlays (Onda 1), `ConnectivityService`
com reachability (Onda 2 além da API), download/aplicação automática de
firmware e assinatura de app (Onda 3), `Pkg`/jobs/quota (Onda 4) e secure
boot/flash encryption (Onda 5). O supervisor desta fatia é o mínimo para
boot-loop; restart automático de app e bloqueio de app instável ainda não
existem. O trial cobre os apps de interface do caminho de reparo; serviços
(`Nucleo`, `Agente`) não passam pelo `runFile` e ficam de fora. A política de
update já é nativa, mas o `service.js` do Nucleo ainda existe na LittleFS de
aparelhos atualizados por OTA — o cache e as chaves compartilhadas o tornam
inofensivo; a limpeza do fonte depende de uma janela de publicação (o repo
está sujo e o hub recusa publish nessa condição).

---

## Apêndice A — Evidências no código

| Afirmação | Onde verificar |
|---|---|
| App roda síncrono e bombeia o SO | `main/Launcher/LauncherUI.cpp` `runApp` → `main/Kernel/Core/CelerKernel.cpp` `runFile` → `main/Runtime/JSBindings.cpp` `present` → `main/Kernel/Services.cpp` `tickPresent` |
| Tabela única de serviços e `updcheck` removido | `main/Kernel/Services.cpp`, `kServices[]` |
| Política de update em JS | `data/apps/Nucleo/service.js` (24 h, grace 60 s, gates) |
| A/B sem factory + rollback | `partitions_4MB.csv`, `sdkconfig.defaults:59` |
| Manifesto assinado e piso de API | `main/OTA/OtaManager.cpp` (`runCheck`, validação de `api_version`, ECDSA) |
| Sem assinatura de app | `main/Utils/AppPackage.cpp`, `main/Utils/AppZip.cpp` (só estrutura/CRC) |
| `main` ignorado no launch | era assim na medição (1.13); **consertado na Onda 0 (API 56)**: `LauncherUI::resolveApp` honra o `app.main` |
| `hub_token.txt` fora do jail | `main/Runtime/JsFsJail.h` (lista protegida não inclui o token) |
| Limites por app inexistentes | `main/Runtime/JsFs.cpp` (caps por operação, sem quota) |
| svchost: 12 serviços, 44 KB, 64 KB | `main/Kernel/AppServices.cpp` |
| Notificação expulsa o app | `main/Launcher/NotificationAlert.cpp` `service(bool inApp)` |
| CYD lite e feature menu | `boards/cyd/sdkconfig.defaults` |
| Sem secure boot/flash encryption | `sdkconfig.defaults` e `boards/*/sdkconfig.defaults` (só rollback) |
| API 55 no CMake | era 55 na medição; hoje `CELEROS_API_LEVEL=56` em `main/CMakeLists.txt` (a Onda 0 uniformizou os quatro lugares) |

## Apêndice B — Glossário e paralelo com Android

| CelerOS (alvo) | Android equivalente | O que **não** teremos |
|---|---|---|
| `AppSupervisor` | ActivityManager / ANR + restart | isolamento de processo |
| `OverlayCompositor` | WindowManager (heads-up) | janelas livres / multi-window |
| `ConnectivityService` | ConnectivityManager | VPN, telephony |
| `Net.fetch` | OkHttp + WorkManager | thread pool livre |
| `UpdateService` | Play Store + A/B OTA | Play Services |
| `PackageService` | PackageManager | split APK, assinatura v4 |
| `JobService` | JobScheduler / Doze | preempção real |
| `SecretVault` | Keystore | StrongBox/TEE |
| `Pkg` + hub | `pm` + Play | sideload irrestrito |
| API level | `targetSdkVersion` | compatibilidade retroativa infinita |

---

*Estudo escrito sobre a árvore em 2026-11-03 (1.13.0 / API 55). A árvore tinha trabalho em andamento de outro lado; nenhum arquivo existente foi alterado por este documento.*
