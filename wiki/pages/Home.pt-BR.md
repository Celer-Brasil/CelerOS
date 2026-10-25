# CelerOS

[English](/Celer-Brasil/CelerOS/wiki/Home) | **Português (BR)**

<p align="center">
  <img src="Documentation/assets/celeros_logo.png" alt="CelerOS" width="420"/>
</p>

O CelerOS é um sistema operacional com GUI, leve e de código aberto, com
runtime de apps JavaScript, para microcontroladores ESP32. Ele transforma
placas de display baratas em um pequeno dispositivo "tipo smartwatch": UI
immediate-mode sobre LovyanGFX, engine JS (Duktape) rodando apps de forma
isolada a partir da flash ou do SD, App Store com atualização over-the-air e
uma ferramenta companheira via USB (`celerctl`) para o dia a dia de
desenvolvimento.

| Launcher | App Store | Settings |
| :---: | :---: | :---: |
| <img src="Documentation/assets/imgs/celeros-launcher.png" width="240" alt="Launcher"/> | <img src="Documentation/assets/imgs/celeros-appstore.png" width="240" alt="App Store"/> | <img src="Documentation/assets/imgs/celeros-settings.png" width="240" alt="Settings"/> |

*Capturas do framebuffer real de uma SmartDisplay 4" (firmware 1.5) via `celerctl screencap`.*

| Watchface no watch Waveshare | Launcher no watch |
| :---: | :---: |
| <img src="Documentation/assets/imgs/watch-watchface.png" width="200" alt="Mostrador no watch Waveshare"/> | <img src="Documentation/assets/imgs/watch-launcher.png" width="200" alt="Launcher do watch"/> |

## Novidades

Firmware 1.11.6 — a rodada da frota (API JS nível 50):

* **OTA assinado** — o `update.json` carrega uma assinatura ECDSA P-256 sobre `version`, `api_version`, `firmware_sha256` e `variant`; o firmware confere contra a chave pública embutida e o SHA-256 do stream antes de trocar de slot. Manifesto HTTPS sem assinatura válida é recusado. A chave privada fica fora do repositório.
* **Agente de frota** — o app de sistema `celeros.agent` roda um serviço em background com heartbeat e comandos de OTA assinado, atualização de apps, self-update, reboot, sync e diagnostics; `caps.ota_signed` informa ao plano de controle se o aparelho valida assinatura ([agente de frota](/Celer-Brasil/CelerOS/wiki/Agente-de-Frota)).
* **Rede + OTA no background** — serviços usam `Net.request`/`Net.download` (`net`) e `System.otaStart`/`restart`/`installZip` (`system`) sem bombear o app em foreground ([API JS](/Celer-Brasil/CelerOS/wiki/API-JS)).
* **Oito placas** — o devkit ESP32-S3 headless (`devkit-s3`, USB Host) entra ao lado de SmartDisplay, CYD/CYD-VSPI, cão robô, watch, devkit e ESP32-CAM; cada uma tem seu canal OTA assinado ([placas suportadas](/Celer-Brasil/CelerOS/wiki/Placas-Suportadas)).
* 1.11.0–1.11.5 trouxeram o SHA-256 do stream, `System.epoch()`, o instalador app.zip, a saída do app antes do OTA e o gate duro de `firmware_sha256` em HTTPS.

Firmware 1.8.2, antes disso — a rodada dos jogos (API JS nível 36):

* **Supernova 2.4, Detona! 0.8 e Arrasa! 1.1** — três jogos completos agora sobre o **CelerGame, a engine de jogos entregue como família de dependências compartilhadas** (núcleo `celeros.game` + módulos `.fx`/`.spr`/`.tilemap`/`.ui`): um shooter de sprites 480×480 em **canvas nativo** (API 28), um bomberman de grade cujo **duelo 1×1 joga pela malha Bluetooth** — lobby, convite e melhor de 3 rounds na **mesma arena construída de uma seed compartilhada**, com só eventos discretos de um quadro cruzando o rádio — e um jogo de física de estilingue contra fortalezas de goblins. A `celeros.engine` monolítica segue no hub como shim de compatibilidade 1.2.5 que monta a família.
* **Dependências compartilhadas no hub** (API 30) — a família da engine de jogos, física, malha, SFX e grid instalam uma vez e todo app reusa (`deps.json`): pacotes de app menores e o teto de tamanho do app subiu de 128 KB para **1 MB**.
* **Física verlet nativa** (`System.verlet*`, API 31) — integração, relaxamento e colisões em C++ para mundos com milhares de pontos; o Physics Drop 4 e o app Bench Fisica já usam. A dependência de física está na 2.1: os auxiliares `P.world`/`P.tiles`/`P.flow` saíram (2.0) — grades foram para o `celeros.grid`, caixas que rolam para o `System.rigid*`.
* **Corpo rígido nativo** (`System.rigid*` + `System.drawSprite`, API 33, placas S3) — caixas que giram, empilham e tombam, círculos que rolam, impactos que quebram peças e projéteis rápidos que nunca atravessam uma tábua fina; o **Arrasa!** (estilingue contra fortalezas de goblins, 10 fases com estrelas) roda sobre ele.
* **Jogos com som e movimento certos** — o `System.sfx` mistura efeitos sonoros na música (API 32 — um único slot de áudio costumava travar o jogo), só os retângulos que mudaram vão ao vidro (até 8 caixas sujas por quadro) e a interrupção do painel do SmartDisplay saiu do núcleo do JavaScript: a imagem não treme mais e as placas com PSRAM ganham até ~2× mais quadros por segundo.
* A 1.8.1, no meio do caminho, fez o **OTA sobreviver à viagem**: conexão que cai retoma por HTTP Range do último byte gravado, com back-off crescente, e o `celerctl push` confere que a placa bootou mesmo no slot gravado.

Firmware 1.8, antes disso (API JS nível 27) — a matilha:

* **A matilha** — os CelerOS se descobrem e formam uma **malha Bluetooth multi-salto** (CelerNet, API 26–27): cada nó repete sozinho, a presença leva o papel de cada aparelho, mensagens diretas ou em broadcast até 434 B por até 8 saltos, e o **Pack** passa a **música em curso para o vizinho com alto-falante** — do mesmo ponto da música ([página da malha](/Celer-Brasil/CelerOS/wiki/Pack-Mesh)).
* **Seis apps que vivem na malha** (App Store): **Sonar** (radar em anéis de saltos, ping real de RTT/perda, censo), **Batata Quente** (batata quente por unicast), **Mural** (recadinho que alcança quem estava **desligado**, via Trickle), **Sentinela** (vigia por IMU/mic com alarme em duas vias), **Coral** (coro de 4 vozes com entrada sincronizada) e **Pong Duplo** (pong espelhado pelo Celer Link) ([página da malha](/Celer-Brasil/CelerOS/wiki/Pack-Mesh)).
* **Rádio blindado na bancada (3 placas)** — o unicast fragmentado agora chega (as cópias remendam os fragmentos perdidas umas das outras), os relays saem da frente da rajada e se cancelam, o rádio arbitra malha × Celer Link × scans do app, e o roaming do Wi-Fi só escaneia com o sinal fraco (um scan conectado deixava o Bluetooth surdo ~9 s a cada 39 s).
* **RAM para viver na matilha** — stacks pelo pico medido, `.bss` na PSRAM nas placas S3 e o vazamento do CelerLink consertado: o relógio segura malha + phone link + Wi-Fi sem colapso de RAM interna.
* **meshsim no CI** — os apps da malha rodam **de verdade em N nós simulados** na suíte do host: relógio virtual em lockstep, ar que modela TTL/saltos, fragmentos com perda por enlace, fila TX de 96 quadros tudo-ou-nada, envelopes do Pack e pareamento do Celer Link.

O firmware 1.7, antes em outubro: o **cão que fala** — `AI.speak()` TTS ao vivo (API 24), a LLM escrevendo a própria coreografia (`dog_script`), a marcha hop com o giro de barriga, latidos IA em QOA, o **celerctl por Wi-Fi** (Debug Bridge + `provision`), o profiling do `top` e os logs persistentes em `/local/log`.

O firmware 1.6: o **toolkit UI** (`UI.*`, API 22), **apps multi-arquivo** com `require()` (API 23), a **voz 2.0** e o **Celer Link selado** com quadros AES-GCM (API 21).

Antes disso, no ciclo da 1.5: IA no aparelho (`AI.chat`, API 18–20), voz e a **wake word "Hi Celer"** no chip (API 19–20), o debugger JavaScript por USB, o deep sleep do watch com sentinela ULP-RISC-V, o **Phone Link** pelo Gadgetbridge (`Phone.*`, API 15), **plugins de watchface** (API 16), APIs de runtime 12–17, a placa devkit barebone, o **CelerOS Flasher** e o **SDK de apps**.

## Mapa da wiki

| Página | O que cobre |
|---|---|
| [Placas suportadas](/Celer-Brasil/CelerOS/wiki/Placas-Suportadas) | SmartDisplay 4", família CYD, cão robô, watch Waveshare e o devkit barebone — e como adicionar uma placa nova |
| [Compilando e gravando](/Celer-Brasil/CelerOS/wiki/Compilando-e-Gravando) | ESP-IDF 6.1, build por placa, partição LittleFS e o harness de testes |
| [Solução de problemas](/Celer-Brasil/CelerOS/wiki/Solução-de-Problemas) | Problemas comuns de build, flash, toque, Wi-Fi e web — e os consertos |
| [Arquitetura](/Celer-Brasil/CelerOS/wiki/Arquitetura) | Boot flow, camadas do firmware, runtime JS e convenções do código |
| [Cão robô](/Celer-Brasil/CelerOS/wiki/Robo-Cachorro) | O cachorro robô SpotPear/ZZPET: pinout completo de engenharia reversa, firmware de bring-up, o board CelerOS, o controle "Celer Link" BLE e os comandos por voz ("hi celer, senta") |
| [Watch Waveshare](/Celer-Brasil/CelerOS/wiki/Watch-Waveshare) | A placa de smartwatch AMOLED 2.06: pinout portado do firmware Rust, app Watchface como casa, escada de tela AOD/deep sleep (com a sentinela ULP) e a API `Sensors` |
| [Devkit barebone](/Celer-Brasil/CelerOS/wiki/Devkit-Barebone) | O devkit ESP32 de 4 MB sem tela: `System.button()` + LED, apps headless e o canal OTA |
| [Apps de sistema](/Celer-Brasil/CelerOS/wiki/Apps-de-Sistema) | O que mora em `data/`, regras do `app.json` e como apps chegam ao dispositivo |
| [Interface web](/Celer-Brasil/CelerOS/wiki/Interface-Web) | File manager, upload de firmware e o espelho de tela ao vivo no navegador |
| [Ferramentas](/Celer-Brasil/CelerOS/wiki/Ferramentas) | `celerctl`, o debugger JS, `celerhub`, servidor OTA local e geradores de assets |
| [celerctl (USB)](/Celer-Brasil/CelerOS/wiki/celerctl-USB-(Português)) | Referência de comandos e protocolo HostLink |
| [Atualização OTA](/Celer-Brasil/CelerOS/wiki/Atualizacao-OTA) | Manifest `update.json`, canais e upload web |
| [Agente de frota](/Celer-Brasil/CelerOS/wiki/Agente-de-Frota) | `celeros.agent`: heartbeat, comandos, OTA assinado, update de apps e contrato do svchost |
| [Guia de apps](/Celer-Brasil/CelerOS/wiki/Guia-de-Apps) | Como empacotar um app JS: `app.json`, pastas, ícones |
| [Plugins de watchface](/Celer-Brasil/CelerOS/wiki/Plugins-de-Watchface) | Como apps instalados acrescentam widgets ao mostrador do relógio (`watchface.js`, API 16) |
| [API JS](/Celer-Brasil/CelerOS/wiki/API-JS) | Referência completa do runtime (globals `System`, `Net`, `FS`, `AI`, `Mic`, `WakeWord`) |
| [Contribuindo](/Celer-Brasil/CelerOS/wiki/Contribuindo) | Convenções, testes, CI e como enviar um PR |

As páginas em inglês (originais) ficam nas seções acima da sidebar; as
traduções ficam na seção **Português (BR)**.

## Funcionalidades em resumo

* **Runtime de apps JavaScript** — apps interativos em ES5 rodam nativamente
  via Duktape (API nível 50): desenho estilo canvas, toque e teclado na tela
  acoplado, sistema de arquivos e rede HTTP/JSON.
* **IA e voz no aparelho** — `AI.chat()` conversa com a DeepSeek ou a
  OpenRouter de qualquer app (assíncrono, TLS, function calling; as chaves
  ficam fora da sandbox JS), `Mic.*` grava WAV de 16 kHz atrás de uma
  permissão `mic`, e os apps **Chat IA** e **Qwen** são um cliente de chat e
  um assistente de voz push-to-talk. No cão robô a wake word **"Hi Celer"**
  roda no próprio aparelho e comandos por voz ("hi celer, senta") dirigem as
  pernas (`WakeWord.*`, API 20 — [cão robô](/Celer-Brasil/CelerOS/wiki/Robo-Cachorro)).
* **Debugger JavaScript** — `celerctl debug MeuApp`: debugger Duktape pelo
  USB com breakpoints, stepping, eval, watches e pausa automática em erros
  não capturados ([ferramentas](/Celer-Brasil/CelerOS/wiki/Ferramentas)).
* **UI immediate-mode** — os mesmos apps escalam de 240x320 até 480x480.
* **Apps de sistema em JS** — Settings, App Store, Installer, Help, Web
  Server, Terminal, Snake, Chat IA, Qwen e as demos moram na partição
  LittleFS; as placas sobrepõem seus apps de casa (Watchface, Dog Face,
  Barebone).
* **App Store e Installer** — instale apps do
  [CelerOS Hub](https://os.celer.tec.br) via Wi-Fi ou a partir do SD.
* **Atualização over-the-air** — do próprio aparelho, pelo navegador ou via
  `celerctl ota push`.
* **Tela ao vivo no navegador** — `/screen` espelha o display via Wi-Fi e
  repassa seus cliques como toques.
* **Hardware da placa em JS** — LED RGB, sensor de luz com brilho
  automático, alto-falante (`System.beep`), linhas de relé e servos
  (`System.gpio.servo`) nas placas que têm; placas de robô acrescentam
  bateria, microfone, pad capacitivo e NeoPixel
  (`System.battery`/`micLevel`/`touchPad`/`neopixel`); o watch acrescenta
  IMU com pedômetro e raise-to-wake (`Sensors.accel/steps/temp`), bateria,
  RTC que segura a hora sem rede e volume de áudio (`System.setVolume`); o
  devkit sem tela expõe o botão BOOT (`System.button()`, API 17).
* **Energia de smartwatch** — a escada de tela dim depois de alguns
  segundos, cai para um mostrador always-on com anti burn-in e então entra
  em deep sleep automático, guardado por uma sentinela ULP-RISC-V que vigia
  os botões, a bateria e o cabo (o PWR acorda em ~100 ms); o watch boota
  direto no mostrador.
* **Celer Link (BLE)** — link Bluetooth LE entre CelerOS próximos (API 9):
  a placa do robô roda `CelerLink.start()`, a outra dirige com
  `scan()`/`connect()`/`send()` — veja a página do
  [cão robô](/Celer-Brasil/CelerOS/wiki/Robo-Cachorro) e o app Celer
  Remote no hub. Desde a API 11 o link pareia com código de 6 dígitos e
  desafio-resposta com chave por bond. Roda na SmartDisplay, no watch e no
  cão robô.
* **Phone Link (Gadgetbridge)** — o relógio pareia com o Android via BLE se
  passando por um Bangle.js: notificações com alerta em tela cheia, controle
  de música, clima, chamadas recebidas e achar celular (`Phone.*`, API 15 —
  [página do watch](/Celer-Brasil/CelerOS/wiki/Watch-Waveshare)).
* **Notificações e alarmes** — central de notificações do sistema
  (`System.notify`; no watch uma notificação nova acorda a tela) e alarmes
  persistentes com tela de disparo própria (API 15).
* **Plugins de watchface** — apps instalados estendem o mostrador do relógio
  com linhas de widget (`watchface.js` + `System.launchApp`, API 16 —
  [página de plugins](/Celer-Brasil/CelerOS/wiki/Plugins-de-Watchface)).
* **CelerOS Flasher e SDK de apps** — flash gráfico sem toolchain pelos
  [releases do GitHub](https://github.com/Celer-Brasil/CelerOS/releases), e o
  `tools/sdk/celer.js` para criar, lintar, emular (um PNG por marco do
  relógio com diff de pixels) e publicar apps
  ([ferramentas](/Celer-Brasil/CelerOS/wiki/Ferramentas)).
* **Wi-Fi por portal cativo** — access point `CelerOS-Setup-XXXX` para
  configurar pelo celular.
* **`celerctl`** — companheiro USB estilo adb: shell, push/pull, logcat
  (timestamps, filtros e dump não-destrutivo), o debugger JS, screencap e
  atualização de firmware in-place. O último erro de app persiste em
  `/local/lastcrash.txt` (`lasterror` no shell).

## Links

* [Repositório](https://github.com/Celer-Brasil/CelerOS) ·
  [README em português](https://github.com/Celer-Brasil/CelerOS/blob/main/README.pt-BR.md) ·
  [README in English](https://github.com/Celer-Brasil/CelerOS/blob/main/README.md)
* [Issues](https://github.com/Celer-Brasil/CelerOS/issues) — bugs e ideias
* História: o CelerOS começou como fork do
  [KryonOS](https://github.com/Haris16-code/KryonOS), do Haris.

---

Esta wiki é gerada automaticamente por CI a partir de
[`wiki/`](https://github.com/Celer-Brasil/CelerOS/tree/main/wiki) no
repositório — edite lá, não pela web.
