# Migração C++ -> JS, rodada 2: o que sobrou de verdade

**Data:** 2026-10-27
**Contexto:** fecha a rodada 1 (setup de WiFi virou app, IA fora da CYD por
Kconfig, orçamento de flash por objeto). Este documento mede o que restou e
propõe a rodada 2.

---

## 1. Correção de medição: o "blob de 92 KB" não existe

A rodada 1 levantou a hipótese de que `esp_stdio` custava ~92 KB e seria o
maior lever isolado do firmware. **É artefato do mapa do linker.**

O mapa atribui ao primeiro objeto de um grupo o vão inteiro até a próxima
seção que ele lista. No build da CYD:

```
.rodata.esp_stdio_register.str1.1
                0x3f400150    0x16568  libesp_stdio.a(stdio_vfs.c.obj)
                                 0x4c   (size before relaxing)
```

`0x16568` = 91.496 B, mas a seção real tem `0x4c` = 76 B. Conferido no objeto:

```
$ xtensa-esp32-elf-size -A .../stdio_vfs.c.obj
.rodata.esp_stdio_register.str1.1    76
.rodata.s_vfs_console                 52
.rodata.s_vfs_console_select          24
.rodata.s_vfs_console_dir             64
```

Somando os símbolos do arquivo, `libesp_stdio.a` inteira tem **~1 KB**, não
94 KB. Onde estão os 91 KB: são seções de outros objetos que o mapa não lista
individualmente (blocos `.rodata.str1.1` fundidos) e que ficam contabilizados
no vão.

**Consequência para o tooling:** tamanho de rodata por objeto **não é
confiável** no mapa. O ledger (`tools/size_ledger.json`) passou a contar só
`.text`/IRAM/DRAM por objeto; dados grandes (fontes, tabelas) ficam cobertos
pelo gate da imagem inteira, que vem do `.bin` e é exato. Sem isso, o gate de
512 B poderia falhar sozinho quando o linker mudasse o agrupamento.

---

## 2. Estado medido (CYD, código + RAM por objeto)

Imagem: **1.550.896 B** de 1.638.400 B → **85,4 KiB livres** (piso do CI: 64 KiB).
`libmain.a` = 278.848 B, dos quais 216.697 de código e 47.449 de rodata.

| objeto | código+RAM | o que é | migrável? |
|---|---:|---|---|
| `CelerShell.cpp` | 21.878 | shell do celerctl (56 comandos) | não (boot/headless) |
| `JSBindings.cpp` | 15.066 | tabelas + helpers da API JS | não (é a ponte) |
| `Kui.cpp` | 14.521 | Canvas/paint/widgets nativos | não (substrato) |
| `JsUi.cpp` | 13.566 | `UI.*` (slots, scroll, list, diálogos) | não (ver §5) |
| `LauncherUI.cpp` | 9.742 | registry/scan/launch/autostart | não (boot/shell/web) |
| `HostLink.cpp` | 9.501 | protocolo do PC (push/pull) | não (bench) |
| `Screens.cpp` | 8.463 | LauncherScreen + AppHostScreen | **parcial** (Onda 3) |
| `FileSystem.cpp` | 8.132 | VFS/LittleFS | não |
| `Keyboard.cpp` | 7.530 | teclado nativo (motor do `System.prompt` e do keypad JS) | não |
| `CelerKernel.cpp` | 6.970 | heap Duktape, lifecycle, OOM | não |
| `WatchPanels.cpp` | 6.805 | painéis de borda (ativos na CYD) | **bloqueado** (§5) |
| `AppServices.cpp` | 6.745 | svchost | não |
| `OtaManager.cpp` | 6.542 | OTA assinado | não |
| `Icon.cpp` | 6.012 | PNG/.bin + tile vetorial | parcial (só o tile) |
| `JsSystemApps.cpp` | 5.824 | bindings de sistema | não |
| `JsNet.cpp` | 5.313 | transporte HTTP | não |

Componente `Network` (31.129 B de código): `NetworkManager` 8.326,
`NetworkCredentialStore` 6.117, `WifiConnection` 5.727, `CaptivePortal` 5.426,
`NetworkSelector` 2.472, `WifiAP` 1.886, `CredCipher` 1.085, `IPAddress` 90.
Radio, credenciais e portal: nada disso é lógica de app.

Leitura: **o que sobrou de massa é substrato (43 KB de UI), ferramenta de
bancada (31 KB de shell+host), boot/segurança (20 KB) e rádio (31 KB)**. A
migração já colheu o que era de app.

---

## 3. O único candidato real de migração que sobrou: a launcher

| parte | CYD | observação |
|---|---:|---|
| `LauncherScreen` (grade, barra de status, paginação, menu de pressão longa, desinstalar) | ~6,5 KB | 550 das 700 linhas de `Screens.cpp` |
| `Icon::drawAppTile` + `appTileColor` + `mix` + `fillGradientRoundRect` + `drawFallback` | ~1,5-2 KB | vira `celeros.app.icons` (já tem 12 ícones vetoriais) |
| classes de widget do Kui sem consumidor restante | ~0-1 KB | `Dialog` fica (consentimento de permissões), `List`/`Button` ficam (teclado, painéis, alarme) |
| **total realista** | **~8-9 KB** | não os 13 KB estimados antes |

O que já existe a favor: `BoardProfile::homeApp` + `LauncherUI::launchHome()`
+ `idleHomeTick()` — o aparelho **já sabe** bootar num app JS como casa. Falta
expor o registry (`System.apps()`, ~1-2 KB de C++) e um fallback nativo mínimo
(a tela de "Sem memória" do `CelerKernel::showRuntimeError` já existe, mas ela
precisa devolver para uma grade nativa, não para o app que falhou).

Peso do lado JS: um launcher sem deps, com `System.drawIcon`/`System.apps()`,
cabe em ~8-10 KB enxutos — folgado contra o teto de 48 KB da CYD (o app maior
hoje é o Settings, ~44 KB com o kit).

`System.apps()` também mata a duplicação: `celeros.app.launch` (2,1 KB) e o
App Store reimplementam o scan de `/local/apps` + `/sd/apps` e o parse de
`app.json` que o `LauncherUI` já faz.

---

## 4. O que não é migração, mas libera espaço (decisões de feature)

| alavanca | ganho CYD | custo |
|---|---:|---|
| `CELEROS_SHELL_FULL=n` na CYD (mantém `help/ls/cat/rm/mv/df/free/apps/svc/run/wifi/reboot/top/crash`) | ~8-12 KB | perde `sh`, `usb`, `gb`, `mesh`, `res`, `bridge`, `debug`, `installzip`, `grep/find/wc/du/xxd` no aparelho |
| `CELEROS_WIFI_PORTAL=n` na CYD | ~13 KB (`CaptivePortal` 5,4 + `esp_http_server` ~8) | setup de WiFi só pela tela/`celerctl` |
| `CELEROS_HOSTLINK=n` na CYD | 9,5 KB | `celerctl push/pull/apps install` deixa de funcionar |
| `CELEROS_SD_CARD=n` na CYD | ~45 KB | perde o slot microSD |
| **reparticionar** littlefs 768 → 640 KiB | **+64 KB por slot** | imagem de dados usa ~400 KB em blocos; cabe com folga. **Não é OTA-ável**: exige um flash por cabo em cada aparelho, e o OTA antigo não entrega imagem maior que o slot velho |

---

## 5. O que está bloqueado, e por quê (evidência)

**Nada que desenhe por cima de um app em execução pode ser JS na CYD.**
`AppServices::suspendForApp` suspende o svchost quando um app está em primeiro
plano em placa sem PSRAM (`[svc] suspenso (app em foreground, sem PSRAM)`).
Sem heap simultâneo, não há como rodar a central de notificações, o painel de
ajustes rápidos ou a tela de alarme em JS enquanto um app roda. Isso trava
`WatchPanels` (6,8 KB) + `NotificationAlert` (2,7 KB) + `AlarmScreen` (1,7 KB)
= **11,2 KB** na CYD.

**`UI.*`/`JsUi` (13,6 KB) fica.** É substrato que todo app usa: em JS viraria
custo de heap por app. O Settings já está em ~44 KB dos 48 KB da CYD; somar
~9 KB de uma dep de UI estouraria o teto. Além disso, o arrasto da launcher
custou 76 ms/quadro quando ainda era nativo (commit 5450a16) — scroll com
inércia em JS interpretado não fecha o orçamento de quadro.

**Teclado nativo fica:** é o motor de renderização do `celeros.app.input` e do
`System.prompt` (usado por Settings, Matilha e `celeros.app.form`).

---

## 6. Rodada 2 proposta

**Onda A — shell lite + portal (decisão de feature, ~20 KB, risco médio).**
Duas flags novas com default `y` e `n` na CYD. Independentes da migração, mas
é o maior ganho por esforço que sobrou. Fecha com bancada de `celerctl shell`,
`push`/`pull` e setup de WiFi pela tela.

**Onda B — protocolo da IA em dep JS (todas as placas, ~10 KB cada, risco baixo-médio).**
Era a opção escolhida na rodada 1 e ficou pendente. Na CYD já é 0 (gate), mas
nas 5 placas com IA ligada tira 10 KB **e** passa a evoluir sem OTA de
firmware. Exige um transporte nativo com sessão TLS keep-alive (o `AI.warm`
existe porque o handshake custa 1-2 s) e migrar Chat IA, Qwen e Quiz IA.

**Onda C — launcher em JS (~8-9 KB, risco alto).**
`System.apps()` + app `Home` + fallback nativo. Só começa depois de o fallback
de boot estar provado em bancada; é a última migração de peso que resta.

**Onda D — repartição da flash (+64 KB/slot, estrutural).**
Não é migração: é a única forma de sair do teto de 4 MB. Uma vez, por cabo.

---

## 7. Recomendação

Se o objetivo é **espaço na CYD**: Onda A (~20 KB) entrega mais que a Onda C
(~9 KB) com metade do risco, e a Onda D entrega 3× mais que as duas juntas por
um flash por cabo.

Se o objetivo é **cadência de atualização**: Onda B é a que paga, porque tira
do firmware a parte que mais muda (prompt, providers, tool-calls, TTS).

Se o objetivo é **fechar a arquitetura** ("essencial em C++, app em JS"): a
Onda C é o último capítulo, e depois dela o firmware da CYD fica só com
kernel, drivers, substrato de UI, shell de recuperação e segurança — que é
exatamente a fronteira que a doutrina do `AGENTS.md` desenhou.
