# Estudo: o que trazer do TactilityOS para o CelerOS

**Data:** 2026-10-26
**Base analisada:** Tactility `0.8.0-dev` @ `7ab1c1f2` (GitClones/Tactility)
**Metodo:** 4 varreduras profundas (kernel/app model, UI/LVGL, drivers/HAL/power, rede/ota/testes) + verificacao do estado atual do CelerOS em cada ponto de sobreposicao.

---

## 1. Sumario executivo

O Tactility e um OS ESP32 maduro e bem-engenheirado (LVGL, apps nativos ELF, 63 placas, devicetree), mas a filosofia e **otra** da nossa: la o app e um binario C/C++ num FreeRTOS POSIX-lite; aqui o app e JS ES5 no Duktape. A maior parte do valor a capturar **nao e arquitetura, e mecanismos pontuais** — varios deles pequenos, testaveis em host e de alto valor para a frota (Varejo/Estacionamento).

**Top 5 por valor/custo:**

1. **Forense de crash** (registro em RTC RAM + backtrace + tela de crash com QR no proximo boot) — hoje o CelerOS so loga o motivo do reset; a frota vende beneficia muito disso.
2. **Criptografia das credenciais WiFi em repouso** (NVS hoje em texto puro).
3. **Colunas de compatibilidade no catalogo compacto** (requiresPsram/targetPlatform) — convergencia natural com o all.txt da Loja.
4. **USB mass-storage boot mode** (reboot expondo flash/SD como pen drive) — recuperacao de frota sem esptool.
5. **Telemetria de saida de app** (stack high-water + heap minimo por sessao em /local/log/apps.log).

**Licenca:** quase tudo que interessa e Apache-2.0 (TactilityKernel, Drivers, Modules, Platforms, DevicetreeCompiler, Devices) — pode copiar com atribuicao. A camada de OS (`Tactility/`, onde moram o panic handler e os apps) e o backend Meshtastic sao **GPL-3** — desses so a IDEIA serve; o codigo tem que ser reescrito.

**Onde NAO vale copiar:** o modelo de apps ELF + simbolos exportados (nos temos Duktape + deps semver, mais flexivel), o window manager (Kui imediato ja resolve com menos RAM), i18n (5 idiomas la, produto nosso e PT-BR), emulador POSIX de OS inteiro (nos ja temos emu 2.0 + harness + meshsim; custo nao paga).

**Onde o CelerOS ja esta a frente (comprovado no estudo):** gerenciamento de energia (DFS + light sleep — o Tactility NAO tem nada de esp_pm/DFS), portal captivo de provisionamento (eles REMOVERAM o web server deles), OTA assinado ECDSA com canais, phone link (Gadgetbridge), malha BLE E2E propria, multi-touch de verdade, deps semver entre apps (la cada app e estatico), editor de jogos.

---

## 2. Retratos lado a lado

| Dimensao | CelerOS | Tactility 0.8.0-dev |
|---|---|---|
| App model | Duktape JS ES5 (LittleFS/SD) + deps semver no hub | ELF nativo C/C++ em task propria, fd table, argv/env, SIGTERM (POSIX-lite) |
| UI | LovyanGFX + Kui (imediato, 240x320 virtual) | LVGL 9.6 + window manager (so a janela do topo tem widgets) |
| Hal de placas | `main/Boards/<b>/` + Kconfig (8 placas) | devicetree compilado (63 placas, 48 sem uma linha de C) |
| Energia | PowerPolicy: DFS + light sleep + escada dim/AOD/off | **Nada automatico** (só screensaver + dim por timeout) |
| OTA | update.json v2, ECDSA P-256, 7 canais, web upload | download de app apenas; sem OTA de firmware no OS (só ops de coprocessador no driver wifi) |
| Rede | NetworkManager dono do radio, portal captivo | wifi-module (servico) + autoconect por scan; AP sem portal |
| Malha | CelerNet BLE proprio (matilha, E2E na bancada) | servico mesh com backends Meshtastic/MeshCore (LoRa/ESP-NOW) |
| Update de apps | Hub (celerhub, all.txt, deps, changelog) | AppHub CDN (tar `.app`, catalogo TSV compacto, sem assinatura) |
| Emulacao | emu 2.0 (JS apps), js_harness, meshsim, test/cpp | OS INTEIRO em POSIX/SDL + 68 suites doctest no host |
| Licenca | propria/fechada | GPL-3 (OS) + Apache-2.0 (kernel/drivers/etc.) |

---

## 3. Recomendacoes detalhadas

### A. Alta prioridade (valor alto, custo baixo/medio)

#### A1. Forense de crash: RTC_NOINIT + backtrace + tela de crash com QR
- **La:** `Tactility/Source/PanicHandler.cpp` (GPL — so ideia). Intercepta `__wrap_esp_panic_handler`, grava causa/endereco de fault/mensagem/backtrace de ate 64 PCs em struct `RTC_NOINIT_ATTR` que sobrevive ao reboot; watchdogs NAO contam como crash (para nao apagar um crash real com um kick). No boot seguinte, se `esp_reset_reason()==ESP_RST_PANIC`, o app crashdiagnostics renderiza a causa + callstack, grava `crash.txt` e mostra um **QR com a URL de simbolizacao** (`oops.tactilityproject.org?v=..&board=..&pcs=..`) — o tecnico da loja aponta a camera do celular e tem o relatorio.
- **No CelerOS hoje:** `main/main.cpp:249` apenas loga `esp_reset_reason()`. Nada e capturado no momento do panic (endereco, backtrace, mensagem de abort), nada sobrevive ao reboot, nao existe tela de crash.
- **Implementacao nossa (sem copiar GPL):** struct própria em RTC RAM (`-T` linker section `.rtc.noinit`), backtrace por frame-pointer no Xtensa (tecnica documentada no IDF; exigir `-fno-omit-frame-pointer` no build — conferir custo) ou apenas os 8 PCs do `panic_print` pós-mortem via `esp_panic_handler` hook. Tela de crash reutiliza o Kui do launcher; `crash.txt` em `/local/log/crash.txt` e o **celeros.agent (1.0.3) passa a reporta-lo na frota** — e o fecho perfeito com o vertical Varejo.
- **Custo:** ~2-4 KB de flash; compila out em placas headless sem tela (grava so o arquivo). Kconfig `CELEROS_CRASH_SCREEN` seguindo o padrao do menu de features.
- **Ganho:** diagnostico de campo sem acessar USB; historico de panics persiste entre reboots.

#### A2. Criptografia das credenciais WiFi em repouso
- **La:** `Modules/wifi-module/source/wifi_settings.cpp` (Apache-2.0). Cada rede num `.properties`; senha cifrada AES-256-CBC com chave derivada de MAC + entropia de NVS, IV deterministico = primeiros 16 bytes do SHA-256 do SSID (nao precisa armazenar IV). Header documenta o modelo de ameaca honestamente (depende de flash encryption para valer contra atacante fisico).
- **No CelerOS hoje:** `components/Network/NetworkCredentialStore.h` guarda ate 20 redes em **texto puro** no NVS (`net_creds`).
- **Implementacao:** cifrar so o campo senha na escrita, decifrar na leitura; chave de dispositivo gerada 1a vez e guardada em NVS (idem ideia deles). mbedtls ja esta no tree. Migracao: re-cifrar no init quando detectar entrada antiga em claro.
- **Custo:** ~1-2 KB; zero mudanca de API. Bom para a frota em campo.

#### A3. Colunas de compatibilidade no catalogo compacto (all.txt)
- **La:** `Modules/app-hub-module/source/app_hub_catalog.cpp` (Apache-2.0): JSON do servidor vira indice local TSV compacto (10 campos/linha, linha max 1024) com `targetPlatforms`, `requiresDeviceId` e `requiresRam`; o device filtra pela propria capacidade antes de listar.
- **No CelerOS hoje:** all.txt da Loja (commit 12490ae) ja e o mesmo conceito de indice compacto com fallback — mas sem colunas de compatibilidade. Isso dói AGORA: com a engine 1.5/spr 1.6, app com engine **exige PSRAM** (memoria de 2026-10-25), e a CYD 4MB nao tem.
- **Implementacao:** acrescentar `minApi` (se ainda nao tiver) + `psram:1` no all.txt e no celerhub; a Loja esconde/marca apps incompativeis. Pequeno e fecha um buraco real do catalogo.
- **Bonus do estudo deles:** `requiresRam` como coluna de primeira classe evita a classe de bug "instalou e nao abriu".

#### A4. USB mass-storage boot mode (recuperacao sem esptool)
- **La:** `Tactility/Source/hal/usb/` (Apache-2.0): reboot em modo MSC expondo a flash interna (ou o SD via SDMMC) como pen drive TinyUSB; telas de erro dedicadas no boot app.
- **No CelerOS:** watch e devkit-s3 tem USB nativo (S3); hoje recuperacao = esptool aCabos + porta certa (as duas CH340 trocam de ordem — atrito conhecido de bancada) ou OTA pela WiFi (que exige device sao).
- **Implementacao:** modo "recovery" segurando botao no boot (ou via shell) que monta TinyUSB MSC sobre a particao de dados (mais seguro que a de firmware). S3 apenas, Kconfig. Valor de frota: tecnico arruma device "morto" plugando num PC.
- **Cuidado:** LittleFS em cima de block device MSC requer acesso exclusivo (o OS nao pode escrever enquanto montado) — o padrao deles (reboot DENTRO do modo) resolve.

#### A5. Telemetria de saida de app (stack high-water + heap)
- **La:** ao sair, cada app loga `uxTaskGetStackHighWaterMark` e o minimo de heap da sessao; apps com flag CLEANUP tem leaks reclaims (aqui irrelevante — JS).
- **No CelerOS:** `CelerKernel.cpp:710` destroi o heap do app em silencio; nao ha relatorio por sessao.
- **Implementacao:** no teardown do app, logar em `/local/log/apps.log` (LogPersist): `stackHWM`, `heapMinFree` da sessao, duracao, exit code. Uma linha por sessao. Vira insumo direto para o drama do teto de 48 KB (ver memoria: apps com engine passaram do teto) e para o `celerctl top`.
- **Custo:** trivial (~30 linhas no kernel). Alto valor diagnostico.

#### A6. Autoconect WiFi dirigido por scan com pausas nomeadas
- **La:** `Modules/wifi-module/source/wifi_autoconnect.cpp` (Apache-2.0): reconexao e EFEITO COLATERAL de `SCAN_FINISHED` (cada scan casa contra credenciais salvas), re-scan a cada 10 s enquanto desconectado, e duas flags independentes de pausa (`pause_until_connected`, `auto_scan_set_paused`) usadas p.ex. durante OTA de coprocessador.
- **No CelerOS:** `NetworkManager.cpp:249` ja reconecta na melhor rede conhecida; vale conferir/adotar: (a) cadencia de re-scan com backoff em vez de retry cego, (b) primitiva `pauseUntilConnected` para svchost/OTA/não-competir com o PowerPolicy (que derruba WiFi ocioso).
- **Custo:** pequeno ajuste no NetworkManager; testavel no meshsim/harness? (nao — mas o padrao e simples o bastante para teste por contrato).

### B. Prioridade media (valioso; projeto maior ou dependente de decisao de produto)

#### B1. Devicetree declarativo para placas (referencia de longo prazo)
- **La:** `Buildscripts/DevicetreeCompiler/` (Apache-2.0, Python+lark) compila `.dts` + bindings YAML por driver em structs C estaticos; 48/63 placas nao tem UMA linha de C. PMIC entra declarativo (`dcdc1-voltage = <3300>`), probe() + polling de hotplug com debounce para perifericos que chegam tarde.
- **Nos:** 8 placas com `main/Boards/<b>/` e a regra "nunca ifdef fora de Boards" — hoje aguenta. O ganho aparece a partir de ~12+ placas ou quando a frota pedir variantes de hardware (CYD com PMIC, watch v2...). Nao migrar agora; guardar como padrao. Se um dia for feito, o compilador deles e Apache e pode ser aproveitado.

#### B2. Canal de dev remoto mTLS (shell/sync/install por TCP)
- **La:** `Modules/development-module/` (Apache-2.0): servidor mTLS na porta 6667, cert self-signed com SHA-256 mostrado na tela (TOFU), frames length-prefixed; modos shell, sync de arquivos e install de app. E por ai que o `tt push` deles chega no hardware sem cabo.
- **Nos:** celerctl e UART/CDC; a cam admin 0.2 do esp32-cam ja e um embriao disso; o WebManager cobre parte. Um canal unico (TCP+mTLS) padronizaria o deploy na frota e acabaria com a dependencia de porta fisica (duas CH340 trocando de ordem...). Medio: protocolo novo + tool no celerctl. Cabe depois do agente de frota estabilizar.

#### B3. i18n de UI (so se produto pedir)
- **La:** planilha ODS -> CSV -> codegen (enum + `.i18n` carregado por linha); 5 locales, fallback en-US, custo de lookup zero (indice inteiro).
- **Nos:** UI em PT (fontes cobrem Latin-1). So adotar o MECANISMO (codegen a partir de planilha, fallback) se houver demanda real de internacionalizacao. Nao e tech-debt hoje.

#### B4. Gerenciamento de bateria com capability discovery
- **La:** classe `power_supply` (Apache) com bits de capacidade (charge control, quick charge, power off); o app Power funciona igual com AXP, carregador standalone ou divisor ADC (`battery_sense` do kernel com curva LiPo 3200-4200 mV).
- **Nos:** `js_battery`/`batteryInfo` (API 15) existem para leitura. O que falta e a camada de CONTROLE (limitar corrente de carga, power off por software no watch via AXP2101) e o padrao de capability bits para nao espalhar ifdefs. Medio; util para o watch e o dog.

#### B5. Interop de malha (Meshtastic/MeshCore) como backend plugavel
- **La:** `Modules/mesh-module/` (Apache) define `MeshBackendApi` (presets de radio, on_receive/send, canais, contato por QR) com store append-only de segmentos, duty-cycle regulatorio + listen-before-talk, estados de entrega, mensagens BLOCKED retomadas ao trocar de backend. Backends: meshtastic (GPL — reescrever se for usar) e meshcore (com fallback ESP-NOW para placas sem LoRa).
- **Nos:** CelerNet/matilha e protocolo proprio fechado. A ARQUITETURA de backend plugavel + duty-cycle e o que vale guardar; interop Meshtastic seria diferencial de mercado, projeto grande, decidir como produto. Licenca: o core Apache, o backend Meshtastic GPL (nao copiar codigo).

### C. Ideias pontuais aproveitaveis (pequenas, sem dono de sprint)

| Ideia | De onde | Onde encaixa no CelerOS |
|---|---|---|
| Contador de drops no log queue | `TactilityKernel/source/log_queue.cpp` (Apache; fila estatica 24x256B + task escritora) | LogPersist: logar "N logs descartados" quando a fila estourar — diagnostico barato |
| Alocador com politica required/desired | `TactilityKernel/include/tactility/memory.h` (Apache) | helper em `main/Utils/` formalizando o padrao PSRAM-first que ja usamos ad-hoc (fisica, LogPersist, buffers TLS); detalhe util: `INTERNAL` precisa `|8BIT` |
| USB HID host com key repeat + media keys | `Tactility/Source/lvgl/UsbHidInput.cpp` (GPL — ideia; o devkit-s3 e nosso USB host) | `USB` JS object ja existe (API 48); teclado USB com repeat = feature de produto barata |
| Multi-instancia de pointer (5 slots p/ multitouch) | `Modules/lvgl-module/source/devices/pointer.cpp` (Apache) | nosso pipeline multitouch (API 43) ja resolve; so conferir o nearest-neighbor slot matching deles por ideias |
| Fake-CDN para testar tooling do hub | `Tests/Python/tt_test.py` (Apache; ThreadingHTTPServer local) | testar celerhub/celer.js publish contra servidor local — padrao de teste a incorporar no `test/sdk` |
| Migracao tolerante de settings (DeprecatedPaths) | `Tactility/Source/DeprecatedPaths.cpp` (GPL — padrao) | o registro tipado novo (84d1a45) pode ter o mesmo hábito: chave ausente/invalida = default, nunca crash |
| Deep sleep com evento de preparacao | `sleep_controller` + `KERNEL_EVENT_DEEP_SLEEP_PREPARE` (Apache) | o watch ja acorda por EXT1; formalizar evento para services desligarem coisas antes (o dog em pernoite?) |

### D. Nao adotar (com motivo)

- **Modelo de apps ELF + tabela de simbolos exportados:** engenharia admiravel (ABI por simbolos, ELF loader, fd table, libc shims), mas nos JA TEMOS um modelo de app melhor para o nosso publico: JS com deps semver, hot catalogo, lint, studio. Custo de manutENCAO de um ABI ELF nativo e imenso e travaria o Celer Studio.
- **Window manager topmost-only / rebuild de widgets:** LVGL-centric; Kui imediato redesenha por frame e o launcher ja gerencia ciclos. RAM deles economizada la, nos ja economizamos de outro jeito.
- **Emulador POSIX do OS inteiro:** eles rodam o OS todo (kernel+LVGL+apps) em SDL — o sonho. Nos temos emu 2.0 + js_harness + test/cpp + meshsim; o custo de portar o Kui/Services para POSIX nao paga agora. Direcao de longo prazo apenas.
- **i18n, screensavers, autorotate por IMU, e-paper caps, fonts TTF em runtime:** sem hardware/demanda correspondente hoje.
- **BLE "SPP"/MIDI/HID device:** sobreposicao nula com nossos casos (CelerLink, Gadgetbridge, matilha).
- **Remover o web server (como eles fizeram):** DECISAO DELES, nao nossa — portal captivo + /update web sao diferenciais nossos; o estudo deles so confirma que abrir mao custa (eles ficaram sem provisionamento por portal).

---

## 4. Riscos e restricoes para qualquer adocao

1. **Licenca:** copiar codigo literal SO de diretorios Apache-2.0 (`TactilityKernel/`, `Drivers/`, `Modules/` exceto `mesh-meshtastic-module`, `Platforms/`, `Buildscripts/DevicetreeCompiler/`, `Devices/`), com atribuicao no THIRD-PARTY-NOTICES. Tudo dentro de `Tactility/` (panic handler, apps, UsbHidInput, settings) e GPL-3: implementar do zero usando so a ideia.
2. **Slot OTA da CYD:** lite profile esta com ~64 KB livres — toda feature nova entra com Kconfig `CELEROS_*` seguindo o menu de features (padrao AUDIO/MIC/JS_PHYSICS) e compila out na CYD quando necessario.
3. **Unicore/IRAM da CYD:** nada de task nova presa em core 1; padrao `portNUM_PROCESSORS - 1`.
4. **ES5/Duktape:** nada disso muda — as adocoes sao todas nativas/C++ ou de tooling.
5. **Paralelo:** o tree e compartilhado com o user — reler antes de editar, staging seletivo.

## 5. Onda sugerida (se aprovado)

1. **Onda 1 (quick wins, ~1 dia cada):** A5 telemetria de saida, A2 cripto de creds, A3 colunas de compatibilidade no all.txt, drop counter do log (C1).
2. **Onda 2 (1-2 dias):** A1 forense de crash + integracao com celeros.agent; A6 pausas do autoconnect.
3. **Onda 3 (projeto):** A4 USB MSC recovery (S3), B2 dev channel mTLS.
4. **Arquivados como referencia:** B1 devicetree, B5 mesh backends, emulador POSIX.
