# Arquitetura

[English](/maikramer/CelerOS/wiki/Architecture) | **Português (BR)**

Como o firmware está organizado, o que roda a partir de quê e onde mexer em
cada tipo de mudança.

## Visão geral em camadas

```
+--------------------------------------------------------------+
| data/  (particao LittleFS em /local)                         |
|   Apps de sistema em JavaScript: Settings, App Store,         |
|   Installer, Terminal, Help, Web Server, Snake, demos        |
+------------------------------^-------------------------------+
                               | Duktape (ES5)
+------------------------------|-------------------------------+
| main/  (componente app do ESP-IDF, C++)                      |
|   Kernel/Core  CelerKernel: heap Duktape, roda o main.js     |
|   Runtime      JSBindings: globals System / Net / FS          |
|   UI           Kui (canvas/screen/widget), teclado acoplado  |
|   Launcher     descobre apps em /local/apps e /sd/apps       |
|   Display      Layout 240x320 virtual -> fisico, tema, icones|
|   FileSystem   LittleFS (/local) + SD (/sd), escrita atomica |
|   WebManager   httpd + file manager + upload OTA + portal    |
|   OTA          OtaManager: update.json v2 + download Range   |
|   USBDevice    CelerShell, HostLink (celerctl), SerialLink  |
|   Bluetooth    CelerLink (pareamento) + CelerNet (malha)   |
|   Pack         PackId, Provision, Resources: a matilha      |
|   Boards/<b>/  HAL por placa (pinos, display, traits)        |
+------------------------------^-------------------------------+
                               | inclui/REQUIRES
+------------------------------|-------------------------------+
| components/  (codigo proprio do CelerOS + terceiros)         |
|   Network (NetworkManager: unico dono do radio), Http,       |
|   System (SystemInfo), Storage (NVS), Utility (Event/        |
|   Singleton), ErrorCodes, LovyanGFX, duktape                 |
+--------------------------------------------------------------+
```

As sobras da antiga lib compartilhada `esp_components` saíram do tree
(out/2026) — tudo em `components/` entra no build. O código antigo segue
acessível no histórico do git pela tag `archive/esp_components` (ou no
repo upstream).

## Boot flow

`app_main` chama `celerSetup()` uma vez e `celerLoop()` para sempre
([main/main.cpp](main/main.cpp)):

1. `Board::init` — HAL da placa compilada (`main/Boards/<placa>/`)
2. `UI::init(w, h)` — display e layout virtual 240x320
3. `FileSystem::init` — LittleFS em `/local`, SD em `/sd`
4. `SerialLink` → `USBDevice` — canal do `celerctl`
5. `Backlight` → `TimeManager` (NTP/fuso) → `WebManager::startAsync`
6. `CelerKernel::init` — heap Duktape
7. `LauncherUI` (ou calibração de toque no primeiro boot da CYD) e
   `kui::Navigator::begin` + push do launcher

O loop principal roda na task main: `Navigator::tick()`,
`WebManager::tick()` (reboot adiado pós-OTA web), `TimeManager::tick()`,
`delay(5)`.

## O runtime JavaScript

* Globais expostas pelos bindings (`main/Runtime/JSBindings.cpp` +
  `Js{System,Net,Fs,Gfx,Gpio,Keypad,Link,SystemApps,Storage,Timers,Sensors,
  Phone,Ai,Mic,Wake}.cpp`): `System`, `Net`, `FS`, `Storage`, `Sensors`,
  `Phone`, `AI`, `Mic` e `WakeWord` (as últimas dependem do
  build/hardware) e `CelerLink` (o link BLE, em builds com Bluetooth).
* Apps são ES5 puro (sem `Promise` — o builtin foi compilado fora do
  Duktape), com loop `while` bloqueante e `System.delay()`.
* Toda geometria é desenhada em coordenadas virtuais 240x320 e escalada por
  `UI::sx()/sy()` — apps nunca veem pixels físicos.
* O **nível de API** (`System.getAPILevel()`, hoje 20) é o contrato de
  feature-detection dos apps. Histórico: 1 base (draw/touch/GPIO/FS/time) ·
  2 `Net` · 3 apps de sistema em JS · 5 teclado acoplado · 6 topbar
  customizada + `Net.download` em streaming · 7 LED RGB, sensor de luz com
  brilho automático, alto-falante e prompts mascarados · 8 relés ·
  9 Celer Link (BLE) · 10 servos + hardware de robô (bateria, microfone,
  pad de toque, NeoPixel) · 11 pareamento por código no Celer Link +
  `{hint:"num"}` no teclado (página numérica) · 12 `setTimeout`/`setInterval`,
  `Storage` (NVS privado), sprites múltiplos, `FS.readFile`/`writeFile`
  binário e `setTextDatum` · 13 `Sensors.*` (IMU do watch: accel/steps,
  raise-to-wake) · 14 pareamento do Celer Link ligado por padrão ·
  15 a experiência de relógio (central de notificações, alarmes/timer
  persistentes, painéis rápidos, `Phone.*` Gadgetbridge, `batteryInfo`) ·
  16 plugins de watchface (`watchface.js` + `System.launchApp`) ·
  17 `System.button()` (devkit sem tela) · 18 `AI` (chat assíncrono,
  DeepSeek/OpenRouter) · 19 `Mic.*` (gravação WAV 16 kHz, permissão
  `mic`) · 20 function calling (`toolCalls`) + `WakeWord.*`
  ("Hi Celer" no próprio aparelho).
* Um debugger Duktape opcional (`CONFIG_CELEROS_JS_DEBUGGER`, default nos
  alvos ESP32-S3) expõe breakpoints/step/eval pelo canal do celerctl
  (`celerctl debug`).
* Coprocessadores ULP-RISC-V ficam de sentinela enquanto os núcleos
  principais dormem: a sentinela de deep sleep do watch
  (`Boards/waveshare-watch/WatchUlp.cpp`) e o watchdog de bateria do dog
  (`Boards/spotpear-dog/DogUlp.cpp`).
* Ao adicionar/chamar uma API nova: bump de `CELEROS_API_LEVEL`, doc nos
  dois idiomas do `JS_API_Guide` e stub no harness `test/js_harness/run.js`.

## Onde mexer

| Tarefa | Onde |
|---|---|
| Adicionar um arquivo-fonte | `CELEROS_SRCS` em [main/CMakeLists.txt](main/CMakeLists.txt) (não é glob) |
| Bump de versão / nível de API | `main/CMakeLists.txt` (`CELEROS_VERSION`, `CELEROS_API_LEVEL`) **e** `project(VERSION)` da raiz — manter os dois em sincronia |
| Nova placa | `main/Boards/<b>/` + `elseif` no CMake + `boards/<b>/sdkconfig.defaults` + `updates/<canal>/update.json` |
| Gestos/toque | `UI/Kui.cpp` (TouchPump; toques injetados pelo celerctl passam pelo TouchInjector) |
| Lado dispositivo do celerctl | `USBDevice/HostLink.cpp` (opcodes), `SerialLink.cpp` (UART) |
| Celer Link (BLE entre aparelhos) | `Bluetooth/CelerLink.cpp` + `Runtime/JsLink.cpp` (global `CelerLink`) |
| A matilha (malha, recursos, entrar) | `Pack/` (`PackId`, `Provision`, `Resources`) + `Bluetooth/CelerNet.cpp`; design em `Documentation/CelerNet_Design.pt-BR.md` |
| Página web do file manager e do espelho de tela | `WebManager/*.html` (re-embutidas como headers gzipped na build) |
| Radio Wi-Fi / credenciais | `components/Connection` (`NetworkManager` singleton) |

## A matilha: três pilares, um sistema

Os aparelhos formam uma rede privada — a **matilha** — em que cada um publica
o seu hardware (mic, câmera, alto-falante, relés, sensores) como recursos que
os outros usam. Três tecnologias são três pilares dela:

| Pilar | Papel | Código |
|---|---|---|
| **CelerLink** | confiança: pareia por código de 6 dígitos; o bond então leva a chave da matilha (convite selado) | `Bluetooth/CelerLink.cpp`, `Pack/Provision.cpp` |
| **CelerNet** + recursos | a malha: flooding BLE cifrado, presença, leases, plano de dados ESP-NOW | `Bluetooth/CelerNet.cpp`, `Pack/Resources.cpp` |
| **HostLink** | o gateway: o computador entra pelo cabo USB como membro virtual `pc-XXXX` | `USBDevice/HostLink.cpp`, `USBDevice/UsbRes.h` |

Eles dividem uma identidade (`Pack/PackId`: id do nó pela MAC BT, um nome
persistente) e uma chave com três portas: senha (`Pack.join`, `mesh join` no
shell, `celerctl mesh join`), o convite pelo CelerLink (`Pack.invite`, app
Matilha) e o cabo. Os apps usam o `Pack.*` como fachada (guia da API JS,
seção 43).

## Convenções que valem a pena conhecer

* **Nunca** `#ifdef` de placa fora de `main/Boards/<placa>/` — diferenças de
  compilação vivem no `BoardTraits.h` da placa.
* Logging por `celer_log_printf/println` (vai para UART/CDC **e** para o
  buffer do `logcat`), nunca `printf` cru.
* Estado persistente via `FileSystem::writeTextFile` (tmp + rename,
  resistente a perda de energia).
* Operações falíveis retornam `ErrorCode` (registro em `components/ErrorCodes`),
  não `esp_err_t`.
* Singletons: `class X : public Singleton<X>` com ctor recebendo `token`.
* Handlers de `Event<...>` só setam flags — o `trigger()` segura o mutex
  durante todo o disparo.
* Nunca chame `Storage::initialize()` de components: ele montaria SPIFFS
  sobre a partição que o CelerOS formata como LittleFS. O filesystem do OS é
  `main/FileSystem`.
* Comentários, logs e strings de CLI são em português, sem acentos.

## Pontos quentes do código

| Arquivo | ~LOC | Papel |
|---|---|---|
| `main/Runtime/JSBindings.cpp` + `Js*.cpp` | ~2,9 K | toda a superfície JS |
| `main/WebManager/WebManager.cpp` | ~960 | httpd, file manager, upload OTA, espelho de tela |
| `main/Bluetooth/CelerLink.cpp` | ~1070 | Celer Link: GATT NimBLE + advertising + pareamento por codigo (API 11) |
| `main/UI/Kui.cpp` | ~900 | framework de UI immediate-mode |
| `main/Launcher/Screens.cpp` | ~810 | telas de sistema |
| `main/FileSystem/FileSystem.cpp` | ~640 | FS atômico + MD5 |

Mais detalhe por diretório: os `AGENTS.md` de [main/](main/AGENTS.md),
[components/](components/AGENTS.md),
[main/Runtime/](main/Runtime/AGENTS.md) e
[Network/](components/Network/AGENTS.md) no repositório.
