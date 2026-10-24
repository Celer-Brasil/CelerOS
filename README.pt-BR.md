<p align="center">
  <img src="Documentation/assets/celeros_logo.png" alt="CelerOS" width="480"/>
</p>

# CelerOS

[English](README.md) | **Português (BR)**

O CelerOS é um sistema operacional com GUI, leve e de código aberto, com
runtime de apps JavaScript, para microcontroladores ESP32. Ele transforma
placas de display baratas em um pequeno dispositivo "tipo smartwatch": UI
immediate-mode sobre LovyanGFX, engine JS (Duktape) rodando apps de forma
isolada a partir da flash ou do SD, App Store com atualização over-the-air e
uma ferramenta companheira via USB (`celerctl`) para o dia a dia de
desenvolvimento.

## Novidades

Firmware 1.8.2 — a rodada dos jogos (API JS nível 36):

* **Supernova 2.4, Detona! 0.8 e Arrasa! 1.1** — três jogos completos agora sobre a **CelerGame, a engine de jogos entregue como família de dependências compartilhadas** (`celeros.game` core + módulos `.fx`/`.spr`/`.tilemap`/`.ui`): um shooter de sprites 480×480 em **canvas nativo** (API 28), um bomberman de grade cujo **duelo 1×1 roda pela malha Bluetooth** — lobby, convite e melhor de 3 na **mesma arena construída a partir de uma semente compartilhada**, com apenas eventos discretos de um quadro cruzando o rádio — e um jogo de física estilingue contra fortalezas de goblins. A `celeros.engine` monolítica segue no hub como shim de compatibilidade 1.2.5 que monta a família.
* **Dependências compartilhadas no hub** (API 30) — a família da engine de jogos, física, malha, SFX e bibliotecas de grade instalam uma vez e todo app reutiliza (`deps.json`): os pacotes ficaram menores e o teto de tamanho dos apps subiu de 128 KB para **1 MB**.
* **Física verlet nativa** (`System.verlet*`, API 31) e **corpos rígidos nativos** (`System.rigid*`, API 33) — integração, relaxamento e colisões em C++ para mundos com milhares de pontos; corpos que giram, empilham e tombam. A dependência de física está na 2.1: os helpers `P.world`/`P.tiles`/`P.flow` saíram (na 2.0) — as grades foram para `celeros.grid`, os caixotes que rolam para `System.rigid*`. Physics Drop 4 e o app Bench Fisica já usam.
* **Jogos que soam e se movem direito** — o `System.sfx` mistura efeitos sonoros na música (API 32 — um único slot de áudio antes travava o jogo), só os retângulos que mudaram vão para o vidro (até 8 dirty boxes por quadro) e a interrupção do painel da SmartDisplay saiu do core JavaScript: a imagem não treme mais e as placas com PSRAM ganham até ~2× mais quadros por segundo.
* A 1.8.1, no meio do caminho, fez a **atualização over-the-air sobreviver à viagem**: uma conexão caída retoma por HTTP Range do último byte gravado, com backoff crescente, e o `celerctl push` confere se a placa bootou mesmo o slot que ele gravou.

Firmware 1.8, antes disso (API JS nível 27) — a matilha:

* **A matilha** — os CelerOS se descobrem e formam uma **malha Bluetooth multi-salto** (CelerNet, API 26–27): cada nó repete sozinho (as placas no meio não precisam de app nenhum), a presença leva o **papel** de cada aparelho (som, mic, tela, patas, LEDs) e as mensagens viajam direto ou em broadcast até 434 bytes por até 8 saltos. O serviço **Pack**, por cima, passa a **música chiptune em curso para o vizinho com alto-falante** — do mesmo ponto da música — e entrega envelopes de app com deduplicação.
* **Seis apps que vivem na malha** (App Store): **Sonar** (radar da vizinhança em anéis de saltos, ping real de RTT e perda, censo), **Batata Quente** (a batata voa por unicast com o pavio correndo), **Mural** (recadinho da casa que alcança quem estava **desligado**, sincronizando pelo algoritmo Trickle), **Sentinela** (vigia por IMU/microfone com alarme em duas vias), **Coral** (coro de 4 vozes com **entrada sincronizada** compensando o atraso de cada salto) e **Pong Duplo** (pong espelhado pelo Celer Link, pareamento por código).
* **Rádio blindado na bancada (3 placas, 2026-10-07)** — o unicast fragmentado agora **chega de verdade**: as cópias redundantes dividem uma identidade só e remendam os fragmentos perdidos umas das outras; os relays saem da frente da rajada e se cancelam quando um vizinho já repetiu; o rádio arbitra entre a malha, o Celer Link e os scans do app; e o roaming do Wi-Fi só escaneia com o sinal realmente fraco (um scan conectado deixava o Bluetooth **surdo por ~9 s a cada 39 s**).
* **RAM para viver na matilha** — stacks pelo pico medido, `.bss` na PSRAM nas placas S3 e o vazamento das re-tentativas do CelerLink consertado: o relógio agora segura malha + phone link + Wi-Fi sem entrar em colapso de RAM interna (o mínimo na bancada era 1,6 KB).
* **meshsim no CI** — os apps da malha agora rodam **de verdade, em N nós simulados**, na suíte de testes do host: relógio virtual em lockstep por nó, um ar que modela TTL/saltos, fragmentos de 14 bytes com perda por enlace, a fila TX de 96 quadros tudo-ou-nada, envelopes do Pack e até o pareamento do Celer Link — os cenários roteiram toques em cada nó e conferem o que cada tela desenhou e o que voou no ar.

O firmware 1.7, antes em outubro: o **cão que fala** — `AI.speak()` TTS tocado ao vivo (API 24), a LLM escrevendo a própria coreografia (`dog_script`), a marcha hop com o giro de barriga, latidos renderizados por IA em QOA, o **celerctl por Wi-Fi** (Debug Bridge + `provision`), o profiling do `celerctl top` e os logs persistentes em `/local/log`, mais uma rodada de robustez pelo runtime.

O firmware 1.6: o **toolkit UI** (`UI.*`, API 22), **apps JS multi-arquivo** com `require()` (API 23) e instalação multi-arquivo na App Store, a **voz 2.0** (a LLM coreografa o cão via `dog_sequence`) e o **Celer Link selado** com quadros AES-GCM (API 21).

Antes disso, no ciclo da 1.5: IA no aparelho (`AI.chat` com function calling, API 18–20), voz e a **wake word "Hi Celer"** rodando no chip (API 19–20), o debugger JavaScript por USB, o deep sleep do watch com sentinela ULP-RISC-V, o **Phone Link** pelo [Gadgetbridge](https://gadgetbridge.org) (`Phone.*`, API 15), **plugins de watchface** (API 16), APIs de runtime 12–17 (timers, `Storage` por app, HTTP assíncrono, `playTone`/`playWav`, permissões), a sexta placa (devkit barebone), o **CelerOS Flasher** e o **SDK de apps**.

## Screenshots

| Launcher | App Store | Settings |
| :---: | :---: | :---: |
| <img src="Documentation/assets/imgs/celeros-launcher.png" width="260" alt="Launcher"/> | <img src="Documentation/assets/imgs/celeros-appstore.png" width="260" alt="App Store"/> | <img src="Documentation/assets/imgs/celeros-settings.png" width="260" alt="Settings"/> |
| **Terminal (teclado acoplado)** | **Snake** | |
| <img src="Documentation/assets/imgs/celeros-terminal.png" width="260" alt="Terminal"/> | <img src="Documentation/assets/imgs/celeros-snake.png" width="260" alt="Snake"/> | |

*Capturas do framebuffer real de uma SmartDisplay 4" (firmware 1.5) via `celerctl screencap`.*

### Watch Waveshare AMOLED 2.06

| Watchface (tela inicial) | Launcher |
| :---: | :---: |
| <img src="Documentation/assets/imgs/watch-watchface.png" width="220" alt="Mostrador do relógio"/> | <img src="Documentation/assets/imgs/watch-launcher.png" width="220" alt="Launcher do watch"/> |

*O watch boota direto no mostrador (papel de parede, passos, bateria); swipe pra cima abre o launcher. Desde a 1.5 o mostrador também carrega notificações do celular, clima, música e widgets de plugins. Mesmo `celerctl screencap`, pelo USB nativo.*

### CYD (2.8" 320x240, sem PSRAM)

A CYD roda o mesmo firmware e os mesmos apps, mas é uma máquina bem menor que
a SmartDisplay (ESP32 com ~320 KB de RAM e sem PSRAM, painel SPI de 2.8" e
toque resistivo), então a experiência é visivelmente mais simples:

* **Apps esticados.** Os apps JS são desenhados para um canvas 240x320 em
  retrato; no vidro 320x240 em paisagem eles são escalados 1,33x na largura e
  0,75x na altura — texto e formas ficam achatados.
* **Apps podem piscar.** Não há RAM para um quadro fora da tela, então os
  apps JS desenham direto no painel (`System.isBuffered()` é `false`). A UI
  do sistema (launcher, diálogos, barra superior dos apps) é composta em duas
  faixas pequenas e não pisca, mas um app que limpa e redesenha a tela
  inteira a cada evento vai piscar.
* **Mais lenta.** Um redesenho de tela cheia é limitado pelo SPI de 40 MHz
  (~31 ms); apps grandes levam 1–2 s compilando ao abrir (Settings, App Store).
* **Memória apertada.** Um app recebe ~220 KB de RAM interna (parte em IRAM,
  mais lenta); o teto prático é um `main.js` de ~60 KB, e apps grandes levam
  alguns segundos para abrir. Apps maiores aparecem como "Requer PSRAM" na
  loja.
* **Toque resistivo.** Pede um toque mais firme e calibração no primeiro
  boot; os alvos são pequenos (ícones de 48 px, barra superior de 20 px).
  Também dá para operar a tela pelo navegador com o espelho ao vivo.
* **Hardware da placa também em JS.** O LED RGB do verso, o sensor de luz
  (brilho automático) e o conector de alto-falante funcionam via
  `System.led` / `lightLevel` / `beep`.
* **Sem cartão SD** por enquanto (o slot divide o barramento do display).

## Funcionalidades

* **Runtime de apps JavaScript** — apps interativos em ES5 rodam nativamente via Duktape (API nível 36): desenho estilo canvas, toque e teclado na tela acoplado (`System.keypad*`), sistema de arquivos com storage privado por app, timers, rede HTTP/JSON (bloqueante e assíncrona) e pacotes multi-arquivo com `require()` (API 23).
* **IA e voz no aparelho** — `AI.chat()` conversa com a DeepSeek ou a OpenRouter de qualquer app (assíncrono, TLS, function calling; as chaves ficam fora da sandbox JS) e o `AI.speak()` (API 24) transforma texto em **voz no alto-falante**, tocada ao vivo direto do TTS sem nada passar pela RAM. O `Mic.*` grava WAV de 16 kHz atrás de uma permissão `mic` (com corte do silêncio das pontas no `stop`), e os apps **Chat IA** e **Qwen** são um cliente de chat e um assistente de voz push-to-talk. No cão robô, a wake word **"Hi Celer"** roda no próprio aparelho (detector microWakeWord próprio, TFLite Micro) e comandos de voz ("hi celer, senta") dirigem as pernas — que a LLM também coreografa diretamente, chegando a escrever o próprio script (`WakeWord.*`, API 20; `dog_script`, Dog Face 1.10).
* **Debugger JavaScript** — `celerctl debug MeuApp` anexa um debugger Duktape pelo USB: breakpoints (inclusive condicionais), step into/over/out, eval, watches, call stack, reinício com sync do fonte e pausa automática em erros não capturados (alvos ESP32-S3).
* **UI immediate-mode** — layout adaptativo (`main/Display/Layout.h`): os mesmos apps escalam de 240x320 até 480x480, com ícones PNG decodificados para um cache RGB565+A4.
* **Apps de sistema em JS** — Settings, App Store, Installer, Help, Web Server, Terminal, Snake, Chat IA, Qwen e as demos (HTTP Demo, Touch Test) moram na partição LittleFS; o firmware carrega só o core (isso cortou ~330 KB da imagem da CYD). As placas sobrepõem seus apps de casa (Watchface no watch, Dog Face no cão, Barebone no devkit).
* **App Store e Installer** — navegue e instale apps do [CelerOS Hub](https://os.celer.tec.br) via Wi-Fi, ou instale manualmente a partir do cartão SD.
* **Jogos e bibliotecas compartilhadas** — um stack de jogos de verdade no runtime JS: a **CelerGame como família de deps compartilhadas** (`celeros.game` + `.fx`/`.spr`/`.tilemap`/`.ui`; a engine monolítica antiga segue como shim de compatibilidade), canvas nativo com pool de sprites (`System.setNativeCanvas`, API 28), física verlet em C++ (`System.verlet*`, API 31), corpos rígidos nativos que giram, empilham e tombam (`System.rigid*` + sprites rotacionados, API 33), efeitos sonoros misturados na música (`System.sfx`, API 32) e dependências compartilhadas no hub (`deps.json`, API 30 — família de jogos/física/malha/SFX/grade instalam uma vez por aparelho; teto de app de 1 MB). Supernova, Detona! (cujo duelo 1×1 roda pela malha) e Arrasa! (estilingue contra fortalezas de goblins) são construídos nela.
* **Atualização over-the-air** — firmware direto do aparelho (Settings → System Updates), pelo navegador (página de upload `/update`) ou via `celerctl ota push`. Veja [tools/README_OTA.md](tools/README_OTA.md).
* **Configuração de Wi-Fi por portal cativo** — sem credenciais salvas? O aparelho abre o access point `CelerOS-Setup-XXXX` e você configura o Wi-Fi pelo celular. O Wi-Fi reconecta sozinho se o roteador cair.
* **Tela ao vivo no navegador** — `/screen` espelha o display via Wi-Fi (quadros RLE servidos bloco de linhas por bloco, então o aparelho segue fluido) e repassa seus cliques como toques.
* **Hardware da placa em JS** — LED RGB (`System.led`), sensor de luz com brilho automático (`System.lightLevel`), alto-falante (`System.beep`), linhas de relé nas SKUs "Y" da SmartDisplay (`System.relay`), servos (`System.gpio.servo`) e hardware de placa de robô — bateria, microfone, pad capacitivo, NeoPixel (`System.battery`/`micLevel`/`touchPad`/`neopixel`). O watch acrescenta IMU com pedômetro e raise-to-wake (`Sensors.*`), bateria, RTC que segura a hora sem rede e volume de áudio (`System.setVolume`). O devkit sem tela expõe o botão BOOT (`System.button()`, API 17).
* **Energia de smartwatch** — no watch Waveshare a escada de tela dim depois de alguns segundos, cai para um mostrador always-on com anti burn-in e então entra em deep sleep automático, guardado por uma sentinela ULP-RISC-V que vigia os botões, a bateria e o cabo (o PWR acorda em ~100 ms, e levantar o pulso também); o aparelho boota direto no mostrador. O cão robô mantém um watchdog de bateria por ULP enquanto dorme.
* **Celer Link (BLE)** — link Bluetooth LE entre CelerOS próximos (API 9): ponha uma placa num robô e dirija pelo app de outra placa (`CelerLink.scan/connect/send` — o app Celer Remote do hub faz exatamente isso). Desde a API 11 o link pareia com código de 6 dígitos e desafio-resposta com chave por bond. Roda na SmartDisplay, no watch e no cão robô.
* **A matilha — malha BLE (API 26–27)** — os aparelhos formam uma **malha multi-salto** com configuração zero (`CelerNet.*`): cada nó repete sozinho, a presença leva o papel de cada aparelho (`caps`), mensagens diretas ou em broadcast até 434 B / 8 saltos, e o unicast fragmentado chega (as cópias redundantes remendam os fragmentos perdidas umas das outras). O serviço **Pack** (`Pack.*`), por cima, passa a música chiptune em curso para o vizinho com alto-falante e entrega envelopes de app com deduplicação. Os apps da malha (Sonar, Batata Quente, Mural, Sentinela, Coral) vivem nela — veja a [wiki](https://github.com/Celer-Brasil/CelerOS/wiki/Pack-Mesh); um simulador multi-nó (`test/meshsim`) cuida da honestidade disso tudo no CI.
* **Phone Link (Gadgetbridge)** — o relógio pareia com o Android via BLE se passando por um Bangle.js (app [Gadgetbridge](https://gadgetbridge.org)): notificações com alerta em tela cheia, controle de música, clima, chamadas recebidas e achar celular (`Phone.*`, API 15).
* **Notificações e alarmes** — central de notificações do sistema (apps disparam toasts/histórico via `System.notify`; no watch uma notificação nova acorda a tela com alerta em tela cheia) e alarmes persistentes com tela de disparo própria (API 15).
* **Plugins de watchface** — apps instalados estendem o mostrador do relógio com linhas de widget (`watchface.js` + `System.launchApp`, API 16); veja a [wiki](https://github.com/Celer-Brasil/CelerOS/wiki/Plugins-de-Watchface).
* **Flash sem toolchain** — todo [release no GitHub](https://github.com/Celer-Brasil/CelerOS/releases) traz pacotes por placa (firmware + imagem LittleFS) e o **CelerOS Flasher**, um flasher gráfico para Linux/Windows com esptool embutido.
* **SDK de apps** — `tools/sdk/celer.js`: scaffold, lint contra a API real do firmware, types para o editor, emulador headless (snapshots PNG, um PNG por marco do relógio com diff de pixels), dev loop no aparelho e publicação, com zero dependências npm.
* **Companheiro `celerctl`, USB ou Wi-Fi** — ferramenta estilo adb pelo link serial **ou por TCP/Wi-Fi** (a Celer Debug Bridge; o `provision` deixa uma placa pronta num comando): shell interativo, push/pull de arquivos, logcat ao vivo (timestamps, filtros e dump não-destrutivo), o debugger JS, atualização de firmware in-place, screencap e profiling por task (`top`). Os logs persistem no aparelho (`/local/log/kern.log` + `apps.log`; `dmesg`/`appslog` no Terminal), e o último erro de app persiste em `/local/lastcrash.txt` (`lasterror` no shell). Veja [tools/README_USBTOOL.md](tools/README_USBTOOL.md).
* **PIN nas Settings** — PIN numérico opcional (SHA-256 com salt, tratado nativamente) protege as Settings, com sessão de desbloqueio de 60 s.
* **Gerenciador web com autenticação** — arquivos, editor de texto e upload de firmware pelo navegador, protegidos por HTTP Basic Auth (senha exibida no app Web Server ou no `celerctl info`).
* **Gerenciador de arquivos** — explorador e editor de texto no LittleFS e no cartão SD.

## Placas Suportadas

| SmartDisplay 4" | CYD |
| :---: | :---: |
| <img src="Documentation/assets/imgs/celeros-home.jpg" width="300" alt="SmartDisplay rodando o CelerOS"/> | <img src="Documentation/assets/imgs/CYD2432S028R.jpg" width="300" alt="CYD"/> |

| Placa | SoC | Display | Toque | Observações |
|---|---|---|---|---|
| **SmartDisplay 4"** (Guition ESP32-S3-4848S040) | ESP32-S3-N16R8 | IPS 4" 480x480 RGB (ST7701) | Capacitivo GT911 | 16 MB flash / 8 MB PSRAM, microSD (`/sd`), alto-falante I2S (NS4168 — `System.beep`); SKUs "Y" de parede com 1 ou 3 relés (`System.relay`) |
| **CYD** (ESP32-2432S028R, "Cheap Yellow Display") | ESP32 | ILI9341 2.8" 240x320 SPI | Resistivo XPT2046 | Variante clássica witnessmenow (TFT no HSPI 14/13/12, toque em pinos dedicados, backlight GPIO21); LED RGB, sensor de luz e alto-falante (GPIO26) em JS; slot SD desligado por enquanto; calibração de toque no primeiro boot |
| **CYD-VSPI** (variante não testada) | ESP32 | ILI9341 2.8" 240x320 SPI | Resistivo XPT2046 | Pinout legado (TFT no VSPI 18/23/19, barramento de toque compartilhado, backlight GPIO22) mantido para placas cabladas assim — **nunca testada no hardware**; build com `-DCELEROS_BOARD=cyd-vspi` |
| **Cão robô** (SpotPear ESP32-S3 AI Robot Dog, ZZPET `zzpet-s3`) | ESP32-S3R8 | OLED SH1106 128x64 de 1,3" (cara) | Pad capacitivo (GPIO10) | 16 MB flash / 8 MB PSRAM embutida, 4 servos de perna, microfone + alto-falante I²S, 2x WS2812, bateria no ADC; boota no app **Dog Face** (olhos expressivos, gaits com rampas e keepalive dead-man); controlado por outra placa CelerOS via Celer Link BLE ([wiki](https://github.com/Celer-Brasil/CelerOS/wiki/Robo-Cachorro)) |
| **Watch Waveshare AMOLED 2.06** (ESP32-S3-Touch-AMOLED-2.06) | ESP32-S3R8 | AMOLED redondo 2.06" 410x502 QSPI (CO5300) | Capacitivo FT3168 | 32 MB flash / 8 MB PSRAM embutida, PMU AXP2101, RTC PCF85063 + IMU QMI8658 (pedômetro) + codec ES8311 no I²C, microSD; boota no app **Watchface**; escada de tela com always-on display e deep sleep automático sob uma sentinela ULP-RISC-V (o PWR acorda em ~100 ms); `celerctl` pelo USB nativo ([wiki](https://github.com/Celer-Brasil/CelerOS/wiki/Watch-Waveshare)) |
| **Devkit barebone** (qualquer placa ESP32 comum, ex. DOIT DevKit v1) | ESP32 | nenhuma — LED na placa (GPIO2) | Botão BOOT (GPIO0) | 4 MB flash, sem tela: apps rodam headless via `System.button()` + `System.led`; Wi-Fi pelo shell serial; canal OTA `updates/devkit`; boota no app **Barebone** ([wiki](https://github.com/Celer-Brasil/CelerOS/wiki/Devkit-Barebone)) |
| **ESP32-CAM** (AI-Thinker, módulo ESP32-S) | ESP32 | nenhuma — o "vidro" é o sensor OV2640 | nenhum (LED de flash no GPIO4 como lanterna) | 4 MB flash / 4 MB PSRAM; nó de câmera da rede de sensores do CelerNet: `Camera.*` (API 35 — fotos e QR on-device), apps e módulos no microSD, malha NimBLE (`CAPS_CAMERA`), slots OTA de 1,81 MB; fonte de 5 V firme (brownout é a falha nº 1), GPIO0 no GND para gravar; canal OTA `updates/esp32-cam` |

As definições de placa ficam em `boards/<placa>/` (defaults de sdkconfig) e
`main/Boards/<placa>/` (mapa de pinos e driver de display). Selecione o alvo
com `-DCELEROS_BOARD=<placa>` (os ids da tabela). A UI é adaptativa à resolução, então
adicionar um painel é, na maior parte, um novo perfil de placa.

## Compilando e Gravando

O CelerOS 1.2+ usa **ESP-IDF 6.1 puro** (sem camada Arduino/PlatformIO).

```bash
git clone https://github.com/Celer-Brasil/CelerOS.git && cd CelerOS
git submodule update --init          # LovyanGFX
source ~/esp/v6.1/esp-idf/export.sh  # ESP-IDF v6.1 instalado

# SmartDisplay 4" (ESP32-S3)
idf.py -B build -DSDKCONFIG=build/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/smartdisplay/sdkconfig.defaults" \
  -DCELEROS_BOARD=smartdisplay set-target esp32s3
idf.py -B build build flash -p /dev/ttyUSB0 monitor

# CYD (ESP32 clássico)
idf.py -B build-cyd -DSDKCONFIG=build-cyd/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/cyd/sdkconfig.defaults" \
  -DCELEROS_BOARD=cyd set-target esp32
idf.py -B build-cyd build flash -p /dev/ttyUSB0 monitor

# Watch Waveshare AMOLED 2.06 (ESP32-S3, USB-Serial/JTAG nativo)
idf.py -B build-watch -DSDKCONFIG=build-watch/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/waveshare-watch/sdkconfig.defaults" \
  -DCELEROS_BOARD=waveshare-watch set-target esp32s3
idf.py -B build-watch build flash -p /dev/ttyACM0 monitor

# Cão robô SpotPear (ESP32-S3, USB-Serial/JTAG nativo)
idf.py -B build-dog -DSDKCONFIG=build-dog/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/spotpear-dog/sdkconfig.defaults" \
  -DCELEROS_BOARD=spotpear-dog set-target esp32s3
idf.py -B build-dog build flash -p /dev/ttyACM0 monitor

# Devkit barebone (ESP32 clássico, sem tela)
idf.py -B build-devkit -DSDKCONFIG=build-devkit/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/devkit/sdkconfig.defaults" \
  -DCELEROS_BOARD=devkit set-target esp32
idf.py -B build-devkit build flash -p /dev/ttyUSB0 monitor

# Imagem LittleFS de data/ (apps de sistema + ícones + demos)
tools/flash_data.sh smartdisplay /dev/ttyUSB0    # ou: cyd|spotpear-dog|waveshare-watch|devkit <porta>

# Servidor OTA local de testes
python3 tools/ota_server.py --board smartdisplay
```

Os componentes de terceiros (ArduinoJson, esp_littlefs, nlohmann/json) são
baixados pelo component manager do ESP-IDF; o LovyanGFX é um submodule —
clonar com `--recurse-submodules` ou rodar `git submodule update --init`.

## Apps JS e Documentação

* [Wiki](https://github.com/Celer-Brasil/CelerOS/wiki) — arquitetura, build, placas, ferramentas e guias (gerada por CI a partir de [`wiki/`](wiki/) no repo).
* [Guia de Desenvolvimento de Apps](Documentation/App_Development_Guide.pt-BR.md) ([in English](Documentation/App_Development_Guide.md)) — como empacotar um app JS (`app.json`, estrutura de pastas, ícones).
* [Guia da API JavaScript](Documentation/JS_API_Guide.pt-BR.md) ([in English](Documentation/JS_API_Guide.md)) — referência completa do runtime JS e dos bindings nativos (inclui AI, Mic e WakeWord).
* [tools/README_USBTOOL.pt-BR.md](tools/README_USBTOOL.pt-BR.md) ([in English](tools/README_USBTOOL.md)) — referência de comandos do `celerctl` e o protocolo do link.
* [tools/README_OTA.pt-BR.md](tools/README_OTA.pt-BR.md) ([in English](tools/README_OTA.md)) — esquema de manifest OTA (`update.json`) e canais de atualização.
* [components/README.md](components/README.md) — componentes auxiliares vendados e patches locais.

Harness desktop para os apps pré-instalados (sem hardware):

```bash
node test/js_harness/run.js
```

## Roadmap

* Mais placas (ajuda com bring-up é bem-vinda — perfis de placa são pequenos e autocontidos; o [devkit barebone](https://github.com/Celer-Brasil/CelerOS/wiki/Devkit-Barebone), o [cachorro robô SpotPear](https://github.com/Celer-Brasil/CelerOS/wiki/Robo-Cachorro), o [watch Waveshare AMOLED 2.06](https://github.com/Celer-Brasil/CelerOS/wiki/Watch-Waveshare) e o [nó de câmera ESP32-CAM](https://github.com/Celer-Brasil/CelerOS/wiki/Placas-Suportadas) foram os quatro últimos a pousar).
* Mais APIs de hardware no runtime JS (sensores I2C/SPI), e voz/wake word em mais placas.

## História e Créditos

O CelerOS começou como um fork do
[KryonOS](https://github.com/Haris16-code/KryonOS), do Haris, e desde então
divergiu bastante: a base Arduino/PlatformIO foi trocada por ESP-IDF 6.1, o
stack gráfico migrou para o LovyanGFX, os apps de sistema foram para
JavaScript e as ferramentas foram reconstruídas em torno do `celerctl` e do
CelerOS Hub. Obrigado, Haris, pelo excelente ponto de partida!

## Licença

O CelerOS é licenciado sob a [GNU General Public License v3.0](./LICENSE).
