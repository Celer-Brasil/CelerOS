# Watch Waveshare AMOLED 2.06

[English](/maikramer/CelerOS/wiki/Waveshare-Watch) | **Português (BR)**

O primeiro wearable do CelerOS: o **Waveshare ESP32-S3-Touch-AMOLED-2.06**
(id de board `waveshare-watch`), um smartwatch de AMOLED 2.06" com vidro retangular de cantos arredondados,
sobre o ESP32-S3R8 — 32 MB de flash, 8 MB de PSRAM embutida, um PMU de
hardware e um bom conjunto de sensores atrás do vidro. O mapa de pinos e as
sequências de init do painel foram portados do firmware Rust
**`waveshare-watch-rs`** (firmware standalone para o mesmo watch), o que
poupou desta placa a arqueologia de registradores por JTAG que o
[robô cachorro](/maikramer/CelerOS/wiki/Robo-Cachorro) precisou.

| Watchface (tela inicial) | Launcher |
| :---: | :---: |
| <img src="Documentation/assets/imgs/watch-watchface.png" width="230" alt="Mostrador no watch"/> | <img src="Documentation/assets/imgs/watch-launcher.png" width="230" alt="Launcher no watch"/> |

*Capturas com `celerctl screencap` pelo USB nativo: o mostrador (papel de
parede, passos, bateria) é a tela inicial; swipe pra cima abre o launcher.*

## Hardware

| Item | Valor |
|---|---|
| SoC | **ESP32-S3R8** — LX7 dual-core, 8 MB PSRAM octal **embutida** |
| Flash | 32 MB, DIO @ 80 MHz — espaço de sobra, firmware compila com `-O2` |
| USB | USB-Serial/JTAG nativo: console, esptool **e** `celerctl` (CDC dupla) no único conector USB |
| Display | AMOLED 2.06" 410x502 (retangular, cantos arredondados), **CO5300 via QSPI** a 80 MHz (vidro visível no offset de coluna 22) |
| Toque | FT3168 capacitivo no I²C |
| PMU | AXP2101 — trilhos do display, medição de bateria e a tecla física de power (PEK) |
| Sensores | IMU QMI8658 (pedômetro, raise-to-wake), RTC PCF85063, codec de áudio ES8311 — todos no mesmo barramento I²C0 |

### Pinout

| Função | GPIO | Observações |
|---|---|---|
| AMOLED — QSPI SDIO0..3 | **4 / 5 / 6 / 7** | pixels via cmd 0x32 (quad), registradores via 0x02 (single) |
| AMOLED — SCLK / CS / RST | **11 / 12 / 8** | RST pede pulso longo: 200 ms em low (pulso curto não levanta o painel) |
| Barramento I²C0 | **SDA 15 / SCL 14** | touch FT3168 (0x38), PMU AXP2101 (0x34), RTC PCF85063, IMU QMI8658, codec ES8311 |
| Touch FT3168 — RST / INT | **9 / 38** | precisa do reg 0xA5 = monitor mode no init |
| Áudio ES8311 — I²S0 | **DOUT 40, BCLK 41, LRC 45, MCLK 16** | 16 kHz, MCLK 4,096 MHz; PA enable no **46** (alto só durante o beep) |
| Microfone — ADC do ES8311 | **ASDOUT 42** | I²S1 RX slave nos clocks do codec |
| microSD — SPI3 | **CS 17, SCK 2, MOSI 1, MISO 3** | montado em `/sd` |
| Botão BOOT | **0** | curto = home/encerra app, segurar = screenshot |
| Tecla de power | via **PEK do AXP2101** | poll pelo ScreenPower (curto = acende, segurar = deep sleep). Latchada, e a sentinela ULP-RISC-V acorda o relógio pelo PWR em <=100 ms |
| INT1 do IMU | **21** | ativo-baixo; acorda do deep sleep com movimento se o ajuste `imu_wake` estiver ligado |

O GPIO10 **não** é botão nesta HW: lê LOW com pull-up (armadilha herdada da
família da placa do cachorro).

## A experiência de watch

* **Casa:** o `homeApp` do perfil é o **Watchface** (`celeros.watchface`).
  O BOOT na raiz do launcher abre o mostrador e o launcher volta para ele
  após `home_idle_s` segundos ocioso (padrão 30). O mostrador tem três
  estilos — digital, analógico, mínimo — trocados com toque longo, e mostra
  bateria em %, passos x meta, próximo alarme, timer rodando, não lidas e o
  clima do celular.
* **Gestos de borda** (`BoardProfile::watchGestures`): a borda de cima é
  dividida em terços — esquerda, puxe para baixo os **ajustes rápidos**
  (brilho, volume, WiFi, Não perturbe, levantar o pulso, sempre ligada,
  lanterna, ajustes, celular, achar celular); centro, a **central de
  notificações**; o terço direito revela a topbar retrátil do app (jogos).
  Da borda de baixo, puxe para cima também abre a **central de notificações**
  (toque expande, deslize de lado apaga, limpar tudo, X no topo fecha); da
  borda esquerda,
  deslize para a direita para sair do app. Painel aberto a partir do
  mostrador volta para ele.
* **Launcher** em lista vertical (`launcherList`), com bateria em % e
  carregando na barra de status.
* **Escada de tela** (ScreenPower): pleno → **dim** em 8 s → **AOD** em
  15 s no mostrador (face 1x por minuto com deslocamento anti burn-in,
  data, bateria em % e a última notificação não lida; o painel segue
  acordado em brilho baixo) → off (painel em SLPIN) → **deep sleep
  automático**: depois do off o relógio dorme sozinho — não precisa
  segurar a tecla de power. Levantar o pulso acende a tela no brilho
  normal; notificação nova **acorda o relógio com o alerta em tela cheia**
  (origem, título, corpo e hora; sem toque volta a dormir em ~8 s, toque
  abre a central) e dá dois bipes.
* **Sentinela do deep sleep** (ULP-RISC-V, `WatchUlp.cpp`): carregada na
  RTC slow a cada deep sleep; vigia o IMU (gesto de levantar o pulso =
  2 AnyMotion em ~2 s), a VBAT a cada ~5 min (aviso 3,30 V; crítico
  3,15 V desliga o IMU) e o cabo/USB (~1 s). A tecla PWR (PEK do
  AXP2101, latchada) acorda em <=100 ms; ciclo ~100 ms com o IMU
  mexendo, ~250 ms após 60 s calmo.
* **Energia** (`Hardware/PowerPolicy`): `CONFIG_PM_ENABLE` + tickless idle
  — 240 MHz com a tela acesa, DFS até 40 MHz e light sleep automático com
  ela dim/apagada (não com o USB plugado, para o `celerctl` seguir vivo). O
  WiFi ocioso desliga após `wifi_sleep_min` minutos de tela apagada
  (padrão 10) e volta quando ela acende.
* **Alarmes e timer** vivem no agendador do sistema (`Kernel/Alarms`, NVS):
  até 8 alarmes com dias da semana e um timer. Tocam em tela cheia mesmo
  com a tela apagada ou em AOD, soneca de 5 min, e o relógio acorda do deep
  sleep por timer para o próximo evento.
* **Celular** (`CONFIG_CELEROS_PHONE_LINK`): adicione o relógio no
  **Gadgetbridge** (Android) como **Bangle.js** e digite o código de 6
  dígitos que aparece no relógio. As notificações do celular acordam o
  relógio com o alerta em tela cheia (título, corpo e origem; sem toque
  volta a dormir) e caem na central — em Não perturbe, só o histórico, sem
  som. Chamada tem tela própria (Recusar/Atender voltam ao celular), hora e
  fuso vêm do celular, e controle de música, clima e "encontrar dispositivo"
  funcionam nos dois sentidos. O relógio informa bateria e passos.
  **"Achar celular"**: o relógio manda `{"t":"findPhone"}` e o Gadgetbridge
  decide se toca — configure o **tom de ping** (GB → Ajustes de
  notificação) e, no Android 10+, o som só toca de forma confiável com o
  pareamento via **Companion Device** (e MIUI pede permissões extras). Sem
  confirmação do Android, o relógio mostra "Pedido enviado ao celular".
* **Ajustes → Relógio** expõe levantar o pulso, sensibilidade, duração do
  glance, sempre ligada, tempo de tela, volta ao mostrador, meta de passos,
  WiFi ocioso e acordar por movimento.
* **Apps do relógio** (`boards/waveshare-watch/data/apps`): Alarmes, Timer,
  Atividade (passos, meta, últimos 7 dias), Música e Clima.
  `boards/waveshare-watch/data-exclude.txt` tira Terminal, HTTP Demo, Touch
  Test e Web Server do relógio. O assistente de voz **Qwen** (segure para
  falar; `Mic.*` + qwen omni via OpenRouter) e o **Chat IA** também rodam
  no relógio.
* A hora sobrevive a reboot sem rede (PCF85063 — gravado após NTP,
  celular ou ajuste manual). O pedômetro vira o dia à meia-noite e guarda 7
  dias fechados.
* Superfície JS do relógio: API 13 `Sensors.*`,
  `System.setVolume()/getVolume()`, `System.micLevel()`; API 15
  `System.batteryInfo()`, `getInfo().inset/shape/board/screenW/screenH`,
  `Sensors.stepHistory()`, alarmes/timer, `System.unreadNotifications()` e o
  objeto `Phone`; hoje na API 20 — `System.button` (17), `AI.chat` (18),
  `Mic.*` (19) e function calling + `WakeWord` (20).

## Armadilhas conhecidas

1. O **AXP2101 precisa ser configurado primeiro**: sem DCDC1 + ALDO1 em
   3,3 V o AMOLED fica preto mesmo inicializado (o `Board::init()` faz isso
   antes do init do painel).
2. O CO5300 quer **reset longo** (200 ms em low) e um patch pós-init
   (`0x58=0x00` contrast off, `0x36=0x00` MADCTL portrait) que a lista de
   init do LovyanGFX de fábrica (do T-Watch-Ultra) não tem.
3. O painel só aceita **janelas de escrita alinhadas a par** e não tem
   readback — o display roda num framebuffer do LovyanGFX na PSRAM
   (~402 KB), que em troca devolve o `readRect` (screenshots, espelho web).
4. A camada I²C do próprio LovyanGFX falha no IDF 6.1: o FT3168 é dirigido
   pelo driver `i2c_master` do IDF em `main/Display/Touch_FT3168_IDF.h`
   (mesmo padrão do GT911).
5. Brilho é o WRDISBV do AMOLED (DCS 0x51) — não há backlight PWM; o
   Configurações → Tela fala com o driver do painel.
6. Arquivos de `sdkconfig.defaults` **não aceitam comentário inline** — o
   USB nativo precisa de `CONFIG_TINYUSB_CDC_COUNT=2` (shell +
   `celerctl`), e um comentário nessa linha quebra o init do USB em
   silêncio.
7. Os frames de log (`celerctl logcat`) saem pelo **canal ativo da
   sessão** — antes do rework do HostLink eles iam fixos para a UART0
   (sem conector nesta placa) e o logcat ficava morto em silêncio. No
   proto 2 os frames de log ao vivo também carregam o CRC32 como
   qualquer outro frame.

## Situação no CelerOS

* **[feito]** Porte da placa `main/Boards/waveshare-watch/`, validado no
  hardware: display + toque, RTC, bateria, IMU (pedômetro +
  raise-to-wake), escada de tela com AOD e deep sleep, beep + microfone
  pelo ES8311, volume, Celer Link BLE e `celerctl` pelo USB nativo.
* **[feito, falta validar no hardware]** Experiência de relógio da API 15:
  fuel gauge, gestos de borda + ajustes rápidos + central de notificações,
  launcher em lista, alarmes/timer persistentes, PM + light sleep, celular
  via Gadgetbridge, apps do relógio e a página Relógio nos Ajustes.
* **[feito]** Sentinela ULP-RISC-V durante o deep sleep (`WatchUlp.cpp`):
  raise-to-wake, bateria e cabo vigiados sem os núcleos principais.
* **[a fazer]** Medir o consumo em AOD / tela apagada com o PM ligado.

Restaurar o firmware original da Waveshare é uma gravação comum do esptool
pela mesma USB — o flash do CelerOS nunca toca no bootloader.
