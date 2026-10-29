# Placas suportadas

[English](/Celer-Brasil/CelerOS/wiki/Supported-Boards) | **Português (BR)**

| SmartDisplay 4" | CYD |
| :---: | :---: |
| <img src="Documentation/assets/imgs/celeros-home.jpg" width="300" alt="SmartDisplay rodando o CelerOS"/> | <img src="Documentation/assets/imgs/CYD2432S028R.jpg" width="300" alt="CYD"/> |

| Placa | SoC | Display | Toque | Observações |
|---|---|---|---|---|
| **SmartDisplay 4"** (Guition ESP32-S3-4848S040) | ESP32-S3-N16R8 | IPS 4" 480x480 RGB (ST7701) | Capacitivo GT911 | 16 MB flash / 8 MB PSRAM, microSD, alto-falante I2S (NS4168); SKUs "Y" com relés; Celer Link BLE (NimBLE) |
| **CYD** (ESP32-2432S028R, "Cheap Yellow Display") | ESP32 | ILI9341 2.8" 320x240 SPI | Resistivo XPT2046 | Sem PSRAM; serial CH340; pede calibração de toque no primeiro boot; UI mais simples ([veja abaixo](#cyd-esp32-clássico)) |
| **CYD-VSPI** (variante não testada) | ESP32 | ILI9341 2.8" 320x240 SPI | Resistivo XPT2046 | Pinout legado (TFT no VSPI 18/23/19, barramento de toque compartilhado, backlight GPIO22) mantido para placas cabladas assim — **nunca testada no hardware**; build com `-DCELEROS_BOARD=cyd-vspi` |
| **Cão robô** (SpotBear/ZZPET `zzpet-s3`) | ESP32-S3R8 (8 MB PSRAM embutida) | OLED SH1106 128x64 de 1,3" (cara) | Pad capacitivo (GPIO10) | 4 servos (pernas portadas das tabelas do ESP-Hi da Espressif, calibração por perna salva em `/local/dogtune.json`), microfone + alto-falante I²S, 2x WS2812, bateria no ADC com watchdog ULP-RISC-V no deep sleep; wake word "Hi Celer" on-device + comandos por voz; abre o app Dog Face no boot (`homeApp` do perfil); controlado pelo app Celer Remote via Celer Link BLE; `celerctl` pela USB-Serial/JTAG (`CELEROS_LINK_ON_USJ`); build com `-DCELEROS_BOARD=spotpear-dog` — veja [Robô cachorro](/Celer-Brasil/CelerOS/wiki/Robo-Cachorro) |
| **Watch Waveshare AMOLED 2.06** (ESP32-S3-Touch-AMOLED-2.06) | ESP32-S3R8 (8 MB PSRAM embutida) | AMOLED redondo 2.06" 410x502 QSPI (CO5300) | Capacitivo FT3168 | 32 MB flash, PMU AXP2101, RTC PCF85063 + IMU QMI8658 (pedômetro) + codec de áudio ES8311 no I²C, microSD no SPI3; abre o app Watchface no boot (`homeApp` do perfil); escada de tela com AOD + deep sleep automático guardado por uma sentinela ULP-RISC-V (o botão PWR acorda em ~100 ms); Celer Link BLE; `celerctl` no USB nativo (CDC dupla — `CELEROS_USB_NATIVE`), logs via `celerctl logcat`; build com `-DCELEROS_BOARD=waveshare-watch` — veja [Watch Waveshare](/Celer-Brasil/CelerOS/wiki/Watch-Waveshare) |
| **Devkit barebone** (qualquer placa ESP32 comum, ex.: DOIT DevKit v1) | ESP32 | nenhum — LED on-board (GPIO2) | Botão BOOT (GPIO0) | 4 MB flash, sem PSRAM, sem SD; o display é um painel stub (launcher invisível), apps rodam headless via `System.button()` + `System.led`; `celerctl` na UART0; WiFi pelo comando `wifi` do shell; canal OTA `updates/devkit`; build com `-DCELEROS_BOARD=devkit` — veja [Devkit barebone](/Celer-Brasil/CelerOS/wiki/Devkit-Barebone) |
| **Devkit ESP32-S3 headless** (ESP32-S3 N16R8) | ESP32-S3 | nenhum — headless | nenhum | 16 MB flash / 8 MB PSRAM; perfil headless (`CELEROS_UI=n`), USB Host com os objetos JS `USB`/`Input` (API 48), `celerctl` no USB nativo; canal OTA `updates/devkit-s3`; placa de referência da frota/agente; build com `-DCELEROS_BOARD=devkit-s3` |
| **ESP32-CAM** (AI-Thinker, módulo ESP32-S) | ESP32 (4 MB flash + 4 MB PSRAM quad) | nenhum — o "vidro" é o sensor OV2640 | nenhum (LED de flash no GPIO4 como lanterna) | Nó de câmera da rede de sensores do CelerNet: `Camera.*` (API 35 — fotos e QR on-device via quirc), apps e módulos moram no microSD (SDSPI CLK14/CMD15/D0-2/CS13), malha NimBLE (`CAPS_CAMERA` na matilha), slots de 1,81 MB com um `/local` enxuto; notas de bancada: fonte de 5 V firme (brownout é a falha nº 1), GPIO0 no GND para gravar, GPIO12 é o strap de MTD; canal OTA `updates/esp32-cam`; build com `-DCELEROS_BOARD=esp32-cam` |

## Onde a placa é definida

* `boards/<placa>/sdkconfig.defaults` — defaults de sdkconfig por alvo.
* `main/Boards/<placa>/` — mapa de pinos, driver de display e `BoardTraits.h`
  (diferenças de compilação, ex.: `largeUi`, `hasPsram`).
* A seleção acontece na build com `-DCELEROS_BOARD=<placa>` (um dos ids
  acima; qualquer outro valor é erro fatal no CMake). Veja
  [Compilando e gravando](/Celer-Brasil/CelerOS/wiki/Compilando-e-Gravando).

A UI é adaptativa à resolução — tudo é desenhado num canvas virtual 240x320
e escalado — então adicionar um painel novo é, na maior parte, criar um
perfil de placa novo.

## Adicionando uma placa

1. `main/Boards/<placa>/` com os três arquivos (`Board.cpp`,
   `BoardDisplay.h`, `BoardTraits.h`).
2. Um `elseif` em [main/CMakeLists.txt](main/CMakeLists.txt) apontando o
   diretório da placa no include path privado.
3. `boards/<placa>/sdkconfig.defaults`.
4. Um canal `updates/<canal>/update.json` para OTA.

## Notas por placa

### SmartDisplay 4" (ESP32-S3)

* Não ligue `CONFIG_CELEROS_USB_NATIVE` nesta placa: GPIO19/20 são o I2C do
  GT911 e uma linha de dados RGB — habilitar o USB nativo conflita com o
  toque e o vídeo. O `celerctl` fala com ela pela UART (conector USB é o
  CH340 em cima da UART0, pinos 43/44).
* RGB + PSRAM permitem sprite de frame inteiro; a CYD não tem esse luxo.

**Periféricos da placa usados pelo sistema** (mapa do material do fabricante
"4.0inch_ESP32-4848S040"): microSD em SPI compartilhado com o init do painel
(CS=42, SCK=48, MISO=41, MOSI=47, montado em `/sd`), alto-falante via
amplificador digital Nsiway NS4168 em I2S (DOUT=GPIO40, BCLK=GPIO1,
LRC=GPIO2, sem MCLK — `System.beep` toca uma senoide) e as SKUs "Y" (caixa
de parede 86 switch com 1 ou 3 relés): L1=GPIO40, L2=GPIO2, L3=GPIO1, os
mesmos pinos do alto-falante. Firmware compilado com
`CONFIG_CELEROS_SMARTDISPLAY_RELAYS=N` troca o alto-falante por N relés
controláveis com `System.relay` (partem desligados no boot). O Celer Link
BLE (NimBLE) também roda nesta placa agora que os pools do host passaram a
viver na PSRAM (~22 KB de RAM interna livres após o init).

**GPIOs livres para apps** (`System.gpio`): IO35, IO36 e IO37 do header
(o IO0 é o BOOT e linha R4 do display; IO43/44 são a serial do console).

### CYD (ESP32 clássico)

**O que esperar:**
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
  mais lenta); o teto aplicado é um pacote de **64 KB minificados** (main +
  módulos + deps), e apps grandes levam alguns segundos para abrir. Apps
  maiores declaram `"requires": ["psram"]` e aparecem como "Requer PSRAM"
  na loja.
* **Toque resistivo.** Pede um toque mais firme e calibração no primeiro
  boot; os alvos são pequenos (ícones de 48 px, barra superior de 20 px).
  Também dá para operar a tela pelo navegador com o
  [espelho de tela ao vivo](/Celer-Brasil/CelerOS/wiki/Interface-Web).
* **microSD no barramento compartilhado.** O slot funciona (`/sd`, CS=5),
  mas divide o HSPI do TFT — tráfego de SD e de display arbitram; a
  variante CYD-VSPI vem com SD desligado (hardware não validado).

**Periféricos da placa usados pelo sistema:** LED RGB no verso
(`System.led`), sensor de luz ao lado da tela (`System.lightLevel` e brilho
automático em Configurações → Tela) e saída de alto-falante no GPIO26
(`System.beep`).

**Por dentro (para quem mexe no firmware):**

* 4 MB de flash: a imagem é mais apertada, os apps de sistema em JS na
  LittleFS (~330 KB economizados) foram decisivos para caber.
* Toque resistivo XPT2046: a calibração roda no primeiro boot.
* Sem PSRAM: evite churn de heap no hot path — o sprite de frame só existe
  quando o perfil da placa tem PSRAM. A UI do sistema é composta em duas
  faixas ping-pong; cache de ícones e faixas são liberados quando um app abre.
* Unicore com a IRAM livre acessível a byte (fonte do compile, buffers TLS e
  transbordo do heap JS). Detalhes e números em
  [Documentation/ENGINE_NOTES.md](Documentation/ENGINE_NOTES.md).

### Watch Waveshare AMOLED 2.06 (ESP32-S3)

Placa de smartwatch (ESP32-S3R8: 32 MB flash, 8 MB PSRAM octal) com AMOLED
redondo de 2.06" 410x502 comandado por um **CO5300 via QSPI** (SDIO0..3 =
GPIO4..7, SCLK=11, CS=12, RST=8; o vidro visível mora no offset de coluna
22). O PMU AXP2101 alimenta os trilhos do display (DCDC1 + ALDO1 em 3,3 V)
e precisa ser configurado antes do init do painel — o HAL da placa faz isso
no `Board::init()`.

* Build: `idf.py -B build-watch -DSDKCONFIG=build-watch/sdkconfig -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/waveshare-watch/sdkconfig.defaults" -DCELEROS_BOARD=waveshare-watch set-target esp32s3`.
* Dados com `tools/flash_data.sh waveshare-watch` (default `/dev/ttyACM0` —
  o USB nativo em modo OTG: flash pela ROM, shell na CDC0 e `celerctl` na
  CDC1; o console do IDF fica na UART0 sem conector, então os logs ao vivo
  vêm pelo `celerctl logcat`).
* Toque FT3168 no I²C (SDA=15, SCL=14, addr 0x38, RST=9, INT=38), pelo
  driver `i2c_master` do IDF em `main/Display/Touch_FT3168_IDF.h` (mesmo
  padrão do GT911 — a camada I²C do LovyanGFX falha no IDF 6.1, e o chip
  precisa do registrador 0xA5 = monitor mode no init).
* Brilho é o WRDISBV do AMOLED (DCS 0x51) — sem `Light_PWM`; o controle de
  brilho das Configurações funciona pelo driver do painel.
* O painel só aceita janelas de escrita alinhadas a par, então o display
  roda num framebuffer do LovyanGFX na PSRAM (que também devolve o
  `readRect` para screenshots/espelho de tela).
* O vidro tem cantos arredondados: os cantos do grid do launcher ficam
  levemente cortados e o canvas virtual 240x320 escala ~1,71x/1,57x (leve
  achatamento vertical). O app **Watchface** (`celeros.watchface`, o
  `homeApp` de boot) é desenhado para o vidro; swipe pra cima abre o
  launcher.
* Pinout e sequências de init portados do firmware Rust `waveshare-watch-rs`
  (o mesmo watch, firmware standalone).

**Periféricos da placa usados pelo sistema:** microSD no SPI3 (CS=17,
SCK=2, MOSI=1, MISO=3, montado em `/sd`), Celer Link BLE (NimBLE), codec
ES8311 + PA (GPIO46) para o `System.beep` e o `System.micLevel()` (16 kHz,
MCLK 4,096 MHz no GPIO16), IMU QMI8658 (pedômetro + raise-to-wake,
`Sensors.*` da API 13), RTC PCF85063 (a hora sobrevive a reboot), bateria
do AXP2101 no `System.battery()`, botões BOOT/PWR (curto = home, segurar =
screenshot / deep sleep) e a escada do ScreenPower (dim 8 s → AOD 15 s com
anti burn-in → off → deep sleep automático guardado por uma sentinela
ULP-RISC-V que acorda no botão PWR em ~100 ms, num gesto de levantar o
pulso, na bateria fraca ou no cabo USB). O pinout completo e a experiência
de watch moram na página do
[Watch Waveshare](/Celer-Brasil/CelerOS/wiki/Watch-Waveshare).
