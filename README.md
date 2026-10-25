<p align="center">
  <img src="Documentation/assets/celeros_logo.png" alt="CelerOS" width="480"/>
</p>

# CelerOS

**English** | [Português (BR)](README.pt-BR.md)

CelerOS is an open-source, lightweight GUI operating system and JavaScript
app runtime for ESP32 microcontrollers. It turns cheap display boards into a
small "smartwatch-grade" device: an immediate-mode UI on top of LovyanGFX, a
Duktape JS engine running sandboxed apps from flash or SD, an App Store with
over-the-air updates, and a USB companion tool (`celerctl`) for day-to-day
development.

## What's new

Firmware 1.11.6 — the fleet round (JS API level 50):

* **Signed OTA** — the `update.json` manifest now carries an ECDSA P-256 signature over `version`, `api_version`, `firmware_sha256` and `variant`; the device verifies it against the public key embedded in the firmware and still checks the stream SHA-256 before switching the boot partition. HTTPS manifests without a valid signature are refused, and the private key never enters the repository. On the bench a 1.11.5 board accepted a signed 1.11.6 manifest; 1.11.6 refused a newer manifest with a bad signature without downloading the firmware and stayed on the running version.
* **Fleet agent** — the new `celeros.agent` system app runs a background service (svchost, API 50): heartbeat with firmware/API/apps/capabilities, and commands for signed OTA, app updates, self-update, reboot, sync and diagnostics. App packages come from the hub with MD5 checked before `System.installZip`, the command queue survives reboots, and a manifest the firmware rejects is reported as a failed command instead of "no update". The heartbeat declares `caps.ota_signed`, so a control plane knows whether the device verifies ECDSA manifest signatures.
* **Network and OTA in the background** — services can now use `Net.request`/`Net.download` with the `net` permission and `System.otaStart`/`restart`/`installZip` with `system`, without pumping the foreground app (`present()` is skipped inside the svchost). The agent inherits only the permissions the app declared and the owner granted.
* **Eight boards** — the headless ESP32-S3 devkit (`devkit-s3`, USB Host + the JS `USB`/`Input` objects) joins the family, alongside the ESP32-CAM camera node, the classic devkit, CYD/CYD-VSPI, SmartDisplay, robot dog and Waveshare watch. Every board has its own signed OTA channel.
* 1.11.0–1.11.5, in between, added the stream SHA-256 check, `System.epoch()`, the single app.zip installer, app eviction before OTA, the hard `firmware_sha256` gate for HTTPS and the resumable download hardened on the bench.

Firmware 1.8.2, before that — the games round (JS API level 36):

* **Supernova 2.4, Detona! 0.8 and Arrasa! 1.1** — three full games now riding **CelerGame, the game engine delivered as a shared dependency family** (`celeros.game` core + `.fx`/`.spr`/`.tilemap`/`.ui` modules): a 480×480 sprite shooter on a **native canvas** (API 28), a grid bomberman whose **1×1 duel plays over the Bluetooth mesh** — lobby, invite and best of 3 rounds in the **same arena built from a shared seed**, with only discrete one-frame events crossing the radio — and a slingshot-vs-goblin-fortresses physics game. The monolithic `celeros.engine` stays on the hub as a 1.2.5 compatibility shim that assembles the family.
* **Shared dependencies on the hub** (API 30) — the game engine family, physics, mesh, SFX and grid libraries install once and every app reuses them (`deps.json`): app packages got smaller and the app size ceiling rose from 128 KB to **1 MB**.
* **Native verlet physics** (`System.verlet*`, API 31) and **native rigid bodies** (`System.rigid*`, API 33) — integration, relaxation and collisions in C++ for worlds with thousands of points; bodies that rotate, stack and topple. The physics dependency is at 2.1: the old `P.world`/`P.tiles`/`P.flow` helpers are gone (2.0) — grids moved to `celeros.grid`, tumbling crates to `System.rigid*`. Physics Drop 4 and the Bench Fisica app already ride it.
* **Games that sound and move right** — `System.sfx` mixes sound effects into the music (API 32 — a single audio slot used to freeze the game), only the rectangles that changed go to the glass (up to 8 dirty boxes per frame), and the SmartDisplay panel interrupt left the JavaScript core: the image no longer shakes and PSRAM boards gain up to ~2× more frames per second.
* 1.8.1, in between, made **over-the-air updates survive the trip**: a dropped connection resumes by HTTP Range from the last written byte with growing back-off, and `celerctl push` verifies the board actually booted the slot it wrote.

Firmware 1.8, before that (JS API level 27) — the pack:

* **The pack ("matilha")** — CelerOS devices discover each other and form a **multi-hop Bluetooth mesh** (CelerNet, API 26–27): every node relays by itself (boards in the middle need no app), presence carries each device's **role** (speaker, mic, display, legs, LEDs), and messages travel direct or broadcast up to 434 bytes across up to 8 hops. The **Pack** service on top hands the **playing chiptune over to the neighbour with a speaker** — from the exact same beat — and delivers app envelopes with de-duplication.
* **Six apps that live on the mesh** (App Store): **Sonar** (radar of the neighbourhood by rings of hops, real RTT ping and loss, census), **Batata Quente** (hot potato by unicast with the fuse ticking), **Mural** (a house message board that reaches devices that were **off**, syncing with the Trickle algorithm), **Sentinela** (watchdog by IMU/mic with a two-way alarm), **Coral** (4-voice choir with **synchronised entry** compensating each hop's delay) and **Pong Duplo** (mirrored pong over the Celer Link, pairing by code).
* **Bench-hardened radio (3 boards, 2026-10-07)** — fragmented unicast now **actually arrives**: the redundant copies share one identity and patch each other's lost fragments; relays step out of the burst's way and cancel themselves when a neighbour already repeated; the radio arbitrates between the mesh, the Celer Link and the app's scans; and Wi-Fi roaming only scans when the signal is actually weak (a connected scan deafened the Bluetooth for ~9 s every 39 s).
* **RAM to live with the pack** — measured stacks, `.bss` off to PSRAM on the S3 boards and the CelerLink retry leak fixed: the watch now runs mesh + phone link + Wi-Fi without starving internal RAM (min was 1.6 KB during the bench).
* **meshsim in CI** — the mesh apps now run **for real, on N simulated nodes**, in the host test suite: a lockstep virtual clock per node, an air that models TTL/hops, 14-byte fragments with per-link loss, the 96-packet all-or-nothing TX queue, Pack envelopes and even Celer Link pairing — scenarios script taps on every node and assert what each screen drew and what flew on the air.

Firmware 1.7, earlier in October: the **talking dog** — `AI.speak()` TTS played live (API 24), the LLM writing its own choreography (`dog_script`), the hop gait with the belly spin, AI-rendered barks in QOA, **celerctl over Wi-Fi** (Debug Bridge + `provision`), `celerctl top` profiling and persistent `/local/log` logs, plus a robustness round through the runtime.

Firmware 1.6: the **UI toolkit** (`UI.*`, API 22), **multi-file JS apps** with `require()` (API 23) and multi-file App Store installs, **voice 2.0** (the LLM choreographs the dog via `dog_sequence`) and **Celer Link sealed** with AES-GCM frames (API 21).

Earlier in the 1.5 cycle: on-device AI (`AI.chat` with function calling, API 18–20), voice and the **wake word "Hi Celer"** running on-device (API 19–20), the JavaScript debugger over USB, watch deep sleep with a ULP-RISC-V sentinel, **Phone Link** over [Gadgetbridge](https://gadgetbridge.org) (`Phone.*`, API 15), **watchface plugins** (API 16), runtime APIs 12–17 (timers, per-app `Storage`, async HTTP, `playTone`/`playWav`, permissions), the sixth board (barebone devkit), the **CelerOS Flasher** and the **App SDK**.

## Screenshots

| Launcher | App Store | Settings |
| :---: | :---: | :---: |
| <img src="Documentation/assets/imgs/celeros-launcher.png" width="260" alt="Launcher"/> | <img src="Documentation/assets/imgs/celeros-appstore.png" width="260" alt="App Store"/> | <img src="Documentation/assets/imgs/celeros-settings.png" width="260" alt="Settings"/> |
| **Terminal (docked keyboard)** | **Snake** | |
| <img src="Documentation/assets/imgs/celeros-terminal.png" width="260" alt="Terminal"/> | <img src="Documentation/assets/imgs/celeros-snake.png" width="260" alt="Snake"/> | |

*Screenshots captured from the real framebuffer of a SmartDisplay 4" (firmware 1.5) via `celerctl screencap`.*

### Waveshare AMOLED 2.06 watch

| Watchface (home screen) | Launcher |
| :---: | :---: |
| <img src="Documentation/assets/imgs/watch-watchface.png" width="220" alt="Watchface"/> | <img src="Documentation/assets/imgs/watch-launcher.png" width="220" alt="Watch launcher"/> |

*The watch boots into its watch face (wallpaper, steps, battery); swipe up opens the launcher. Since 1.5 the face also carries phone notifications, weather, music and plugin widgets. Same `celerctl screencap`, over the native USB.*

### CYD (2.8" 320x240, no PSRAM)

The CYD runs the same firmware and the same apps, but it is a much smaller
machine than the SmartDisplay (an ESP32 running on one core, ~320 KB of RAM
and no PSRAM, a 2.8" SPI panel and a resistive touch), so the experience is
noticeably simpler:

* **Stretched apps.** JS apps are designed for a 240x320 portrait canvas; on
  the 320x240 landscape glass they are scaled 1.33x wide and 0.75x tall, so
  text and shapes look squashed.
* **Apps can flicker.** There is no RAM for an off-screen frame, so JS apps
  draw straight to the panel (`System.isBuffered()` is `false`). The system
  UI (launcher, dialogs, app top bar) is composed in two small bands and does
  not flicker, but an app that clears and redraws the whole screen on every
  event will.
* **Slower.** A full-screen redraw is bound by the 40 MHz SPI bus (~31 ms);
  big apps take 1–2 s to compile when they open (Settings, App Store).
* **Tight memory.** An app gets ~220 KB of internal RAM (part of it slower
  IRAM); the practical ceiling is a `main.js` of ~60 KB, and big apps take a
  few seconds to open. Bigger apps are marked "Requer PSRAM" in the store.
* **Resistive touch.** It needs a firmer press and a calibration on first
  boot; targets are small (48 px icons, 20 px top bar). You can also drive
  the screen from the browser with the live mirror.
* **Board hardware still in JS.** The RGB LED on the back, the light sensor
  (auto-brightness) and the speaker connector all work through `System.led`
  / `lightLevel` / `beep`.
* **No SD card** for now (the slot shares the display bus).

## Features

* **JavaScript app runtime** — interactive apps written in ES5 run natively via Duktape (API level 50): canvas-style drawing, touch and coupled on-screen keyboard (`System.keypad*`), file system with per-app storage, timers, HTTP/JSON networking (blocking and async), and multi-file packages with `require()` (API 23).
* **On-device AI & voice** — `AI.chat()` talks to DeepSeek or OpenRouter from any app (async, TLS, function calling; keys stay outside the JS sandbox) and `AI.speak()` (API 24) turns text into **voice on the speaker**, streamed live from the TTS with nothing going through RAM. `Mic.*` records 16 kHz WAV behind a `mic` permission (leading/trailing silence trimmed on `stop`), and the bundled **Chat IA** and **Qwen** apps are a chat client and a push-to-talk voice assistant. On the robot dog, the wake word **"Hi Celer"** runs on-device (own microWakeWord detector, TFLite Micro) and voice commands ("hi celer, senta") drive the legs — which the LLM can also choreograph directly, down to writing its own script (`WakeWord.*`, API 20; `dog_script`, Dog Face 1.10).
* **JavaScript debugger** — `celerctl debug MyApp` attaches a Duktape debugger over USB: breakpoints (incl. conditional), step into/over/out, eval, watches, call stack, restart with source sync, and an automatic pause on uncaught errors (ESP32-S3 targets).
* **Immediate-mode UI** — adaptive layout (`main/Display/Layout.h`): the same apps scale from 240x320 up to 480x480, with PNG icons decoded to an RGB565+A4 cache.
* **Pre-installed apps in JS** — Settings, App Store, Installer, Help, Web Server, Terminal, Snake, Chat IA, Qwen and the demos (HTTP Demo, Touch Test) live in the LittleFS partition; the firmware carries only the core (that shaved ~330 KB off the CYD image). Boards overlay their own home apps (Watchface on the watch, Dog Face on the dog, Barebone on the devkit).
* **App Store & Installer** — browse and install apps from the [CelerOS Hub](https://os.celer.tec.br) over Wi-Fi, or sideload from the SD card.
* **Games & shared libraries** — a real game stack in the JS runtime: **CelerGame as a family of shared deps** (`celeros.game` + `.fx`/`.spr`/`.tilemap`/`.ui`; the old monolithic engine remains as a compat shim), native canvas with a sprite pool (`System.setNativeCanvas`, API 28), verlet physics in C++ (`System.verlet*`, API 31), native rigid bodies that rotate, stack and topple (`System.rigid*` + rotated sprites, API 33), sound effects mixed into the music (`System.sfx`, API 32) and shared dependencies on the hub (`deps.json`, API 30 — game family/physics/mesh/SFX/grid install once per device; app ceiling 1 MB). Supernova, Detona! (whose 1×1 duel plays over the mesh) and Arrasa! (slingshot vs. goblin fortresses) are built on it.
* **Over-the-air updates** — firmware updates from the device (Settings → System Updates), from the browser (`/update` upload page), or via `celerctl ota push`. Manifests are ECDSA P-256 signed and the device checks the signature plus the stream SHA-256 before switching slots; see [tools/README_OTA.md](tools/README_OTA.md).
* **Fleet control in the background** — the `celeros.agent` app runs as a service: heartbeat with firmware/API/apps/capabilities and commands for signed OTA, app updates, self-update, reboot, sync and diagnostics. The queue survives reboots and `caps.ota_signed` tells the control plane whether the firmware verifies manifest signatures.
* **Captive portal Wi-Fi setup** — no credentials stored? The device opens a `CelerOS-Setup-XXXX` access point; you configure Wi-Fi from your phone. Wi-Fi auto-reconnects on router drops.
* **Live screen from the browser** — `/screen` mirrors the display over Wi-Fi (RLE frames served row-block by row-block, so the device keeps running smoothly) and forwards your clicks as touches.
* **Board hardware in JS** — RGB LED (`System.led`), light sensor with auto-brightness (`System.lightLevel`), speaker (`System.beep`), relay lines on the SmartDisplay "Y" SKUs (`System.relay`), servos (`System.gpio.servo`) and robot-board hardware — battery, microphone, capacitive touch pad, NeoPixel (`System.battery`/`micLevel`/`touchPad`/`neopixel`). The watch adds an IMU with pedometer and raise-to-wake (`Sensors.*`), battery, an RTC that keeps time without network and audio volume (`System.setVolume`). The headless devkit exposes the BOOT button (`System.button()`, API 17).
* **Watch-grade power management** — on the Waveshare watch the screen ladder dims after a few seconds, falls back to an always-on face with anti burn-in, then goes to automatic deep sleep guarded by a ULP-RISC-V sentinel that watches the buttons, the battery and the cable (PWR wakes it in ~100 ms, so does raising your wrist); the device boots straight into its watch face. The robot dog keeps a ULP battery watchdog running while it sleeps.
* **Celer Link (BLE)** — Bluetooth LE link between nearby CelerOS devices (API 9): put a board on a robot, drive it from another CelerOS app (`CelerLink.scan/connect/send` — the Celer Remote hub app does exactly that). Since API 11 it pairs with a 6-digit code and a challenge-response key per bond. Runs on the SmartDisplay, the watch and the robot dog.
* **The pack — BLE mesh (API 26–27)** — devices form a **multi-hop mesh** with zero configuration (`CelerNet.*`): every node relays on its own, presence carries each device's role (`caps`), messages go direct or broadcast up to 434 B / 8 hops, and fragmented unicast arrives (redundant copies patch each other's lost fragments). The **Pack** service on top (`Pack.*`) hands the playing chiptune to the neighbour with a speaker and delivers app envelopes with de-duplication. The mesh apps (Sonar, Batata Quente, Mural, Sentinela, Coral) live on it — see the [wiki](https://github.com/Celer-Brasil/CelerOS/wiki/Pack-Mesh); a multi-node simulator (`test/meshsim`) keeps the whole thing honest in CI.
* **Phone Link (Gadgetbridge)** — the watch pairs with Android over BLE posing as a Bangle.js ([Gadgetbridge](https://gadgetbridge.org) app): notifications with a full-screen alert, music control, weather, incoming calls and find-my-phone (`Phone.*`, API 15).
* **Notifications & alarms** — a system notification center (apps raise toasts/history via `System.notify`; on the watch an incoming notification wakes the screen with a full-screen alert) and persistent alarms with their own ringing screen (API 15).
* **Watchface plugins** — installed apps can extend the watch face with widget lines (`watchface.js` + `System.launchApp`, API 16); see the [wiki](https://github.com/Celer-Brasil/CelerOS/wiki/Watchface-Plugins).
* **Flash without a toolchain** — every [GitHub release](https://github.com/Celer-Brasil/CelerOS/releases) carries per-board packages (firmware + LittleFS image) and the **CelerOS Flasher**, a GUI flasher for Linux/Windows with esptool embedded.
* **App SDK** — `tools/sdk/celer.js`: scaffold, lint against the firmware's real API, editor typings, headless emulator (PNG snapshots, one PNG per clock milestone with pixel diffs), on-device dev loop and publishing, with zero npm dependencies.
* **`celerctl` companion, USB or Wi-Fi** — adb-style tool over the serial link **or over TCP/Wi-Fi** (the Celer Debug Bridge; `provision` sets a board up in one command): interactive shell, file push/pull, live logcat (timestamps, filters, non-destructive dump), the JS debugger, in-place firmware update, screencap and per-task profiling (`top`). Logs persist on the device (`/local/log/kern.log` + `apps.log`; `dmesg`/`appslog` in the Terminal), and the last app error persists to `/local/lastcrash.txt` (`lasterror` in the shell). See [tools/README_USBTOOL.md](tools/README_USBTOOL.md).
* **Settings PIN lock** — optional numeric PIN (salted SHA-256, handled natively) protects Settings, with a 60 s unlock session.
* **Web file manager with authentication** — files, text editor and firmware upload over the browser, guarded by HTTP Basic Auth (password shown in the Web Server app or `celerctl info`).
* **File management** — file explorer and text editor over LittleFS and SD card.

## Supported Boards

| SmartDisplay 4" | CYD |
| :---: | :---: |
| <img src="Documentation/assets/imgs/celeros-home.jpg" width="300" alt="SmartDisplay running CelerOS"/> | <img src="Documentation/assets/imgs/CYD2432S028R.jpg" width="300" alt="CYD"/> |

| Board | SoC | Display | Touch | Notes |
|---|---|---|---|---|
| **SmartDisplay 4"** (Guition ESP32-S3-4848S040) | ESP32-S3-N16R8 | 4" IPS 480x480 RGB (ST7701) | Capacitive GT911 | 16 MB flash / 8 MB PSRAM, microSD (`/sd`), I2S speaker (NS4168 — `System.beep`); "Y" wall-switch SKUs with 1 or 3 relays (`System.relay`) |
| **CYD** (ESP32-2432S028R, "Cheap Yellow Display") | ESP32 | 2.8" ILI9341 240x320 SPI | Resistive XPT2046 | Classic witnessmenow variant (TFT on HSPI 14/13/12, touch on dedicated pins, backlight GPIO21); RGB LED, light sensor and speaker (GPIO26) in JS; SD slot off for now; touch calibration on first boot |
| **CYD-VSPI** (untested variant) | ESP32 | 2.8" ILI9341 240x320 SPI | Resistive XPT2046 | Legacy pinout (TFT on VSPI 18/23/19, shared touch bus, backlight GPIO22) kept for boards wired that way — **never tested on hardware**; build with `-DCELEROS_BOARD=cyd-vspi` |
| **Robot dog** (SpotPear ESP32-S3 AI Robot Dog, ZZPET `zzpet-s3`) | ESP32-S3R8 | 1.3" OLED SH1106 128x64 (face) | Capacitive pad (GPIO10) | 16 MB flash / 8 MB PSRAM (embedded), 4 leg servos, I²S mic + speaker, 2x WS2812, battery ADC; boots into the **Dog Face** app (expressive eyes, ramped gaits with a dead-man keepalive); driven from another CelerOS board over Celer Link BLE ([wiki](https://github.com/Celer-Brasil/CelerOS/wiki/Robot-Dog)) |
| **Waveshare AMOLED 2.06 watch** (ESP32-S3-Touch-AMOLED-2.06) | ESP32-S3R8 | 2.06" round AMOLED 410x502 QSPI (CO5300) | Capacitive FT3168 | 32 MB flash / 8 MB PSRAM (embedded), AXP2101 PMU, PCF85063 RTC + QMI8658 IMU (pedometer) + ES8311 audio codec on I²C, microSD; boots into the **Watchface** app; screen ladder with always-on display and automatic deep sleep under a ULP-RISC-V sentinel (PWR wakes in ~100 ms); `celerctl` over native USB ([wiki](https://github.com/Celer-Brasil/CelerOS/wiki/Waveshare-Watch)) |
| **Barebone devkit** (any plain ESP32 board, e.g. DOIT DevKit v1) | ESP32 | none — on-board LED (GPIO2) | BOOT button (GPIO0) | 4 MB flash, headless: apps run without a screen via `System.button()` + `System.led`; Wi-Fi from the serial shell; OTA channel `updates/devkit`; boots into the **Barebone** app ([wiki](https://github.com/Celer-Brasil/CelerOS/wiki/Barebone-Devkit)) |
| **Headless ESP32-S3 devkit** (ESP32-S3 N16R8) | ESP32-S3 | none — headless | none | 16 MB flash / 8 MB PSRAM, `CELEROS_UI=n`; USB Host with the JS `USB`/`Input` objects (API 48), OTA channel `updates/devkit-s3`; fleet/agent reference board; build with `-DCELEROS_BOARD=devkit-s3` |
| **ESP32-CAM** (AI-Thinker, ESP32-S module) | ESP32 | none — the "glass" is the OV2640 sensor | none (flash LED on GPIO4 as torch) | 4 MB flash / 4 MB PSRAM; camera node of the CelerNet sensor network: `Camera.*` (API 35 — photos + on-device QR), apps and modules on the microSD, NimBLE mesh (`CAPS_CAMERA`), 1.81 MB OTA slots; sturdy 5 V supply (brownout is failure #1), GPIO0 to GND to flash; OTA channel `updates/esp32-cam` |

Board definitions live in `boards/<board>/` (sdkconfig defaults) and
`main/Boards/<board>/` (pin map and display driver). Select the target with
`-DCELEROS_BOARD=<board>` (the ids in the table). The UI is
resolution-adaptive, so adding a panel is mostly a new board profile.

## Building & Flashing

CelerOS 1.2+ is plain **ESP-IDF 6.1** (no Arduino/PlatformIO layer).

```bash
git clone https://github.com/Celer-Brasil/CelerOS.git && cd CelerOS
git submodule update --init          # LovyanGFX
source ~/esp/v6.1/esp-idf/export.sh  # ESP-IDF v6.1

# SmartDisplay 4" (ESP32-S3)
idf.py -B build -DSDKCONFIG=build/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/smartdisplay/sdkconfig.defaults" \
  -DCELEROS_BOARD=smartdisplay set-target esp32s3
idf.py -B build build flash -p /dev/ttyUSB0 monitor

# CYD (classic ESP32)
idf.py -B build-cyd -DSDKCONFIG=build-cyd/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/cyd/sdkconfig.defaults" \
  -DCELEROS_BOARD=cyd set-target esp32
idf.py -B build-cyd build flash -p /dev/ttyUSB0 monitor

# Waveshare AMOLED 2.06 watch (ESP32-S3, native USB-Serial/JTAG)
idf.py -B build-watch -DSDKCONFIG=build-watch/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/waveshare-watch/sdkconfig.defaults" \
  -DCELEROS_BOARD=waveshare-watch set-target esp32s3
idf.py -B build-watch build flash -p /dev/ttyACM0 monitor

# SpotPear robot dog (ESP32-S3, native USB-Serial/JTAG)
idf.py -B build-dog -DSDKCONFIG=build-dog/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/spotpear-dog/sdkconfig.defaults" \
  -DCELEROS_BOARD=spotpear-dog set-target esp32s3
idf.py -B build-dog build flash -p /dev/ttyACM0 monitor

# Barebone devkit (headless classic ESP32)
idf.py -B build-devkit -DSDKCONFIG=build-devkit/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/devkit/sdkconfig.defaults" \
  -DCELEROS_BOARD=devkit set-target esp32
idf.py -B build-devkit build flash -p /dev/ttyUSB0 monitor

# LittleFS image from data/ (system apps + icons + demos)
tools/flash_data.sh smartdisplay /dev/ttyUSB0    # or: cyd|spotpear-dog|waveshare-watch|devkit <port>

# Local OTA test server
python3 tools/ota_server.py --board smartdisplay
```

Third-party components (ArduinoJson, esp_littlefs, nlohmann/json) are pulled
in by the ESP-IDF component manager; LovyanGFX is a git submodule — clone with
`--recurse-submodules` or run `git submodule update --init`.

### Reproducibility & CI

* **Toolchain pinned**: ESP-IDF **v6.1** (see `.tool-versions`); LovyanGFX is
  pinned to an exact commit by the submodule.
* **CI** ([`.github/workflows/build.yml`](.github/workflows/build.yml)): the
  JS harness and the host C++ tests run on every push/PR, then both board
  firmwares build in the official ESP-IDF container and are uploaded as
  artifacts. Host tests cover the pure logic extracted to `main/Utils`
  (`g++ -std=c++17 test/cpp/run_tests.cpp`).

## JS Apps & Documentation

* [Wiki](https://github.com/Celer-Brasil/CelerOS/wiki) — architecture, build, boards, tools and guides (CI-generated from [`wiki/`](wiki/) in the repo).
* [App Development Guide](Documentation/App_Development_Guide.md) ([em português](Documentation/App_Development_Guide.pt-BR.md)) — how to package a JS app (`app.json`, folder layout, icons).
* [JavaScript API Guide](Documentation/JS_API_Guide.md) ([em português](Documentation/JS_API_Guide.pt-BR.md)) — full reference of the JS runtime and native bindings (AI, Mic, WakeWord included).
* [tools/README_USBTOOL.md](tools/README_USBTOOL.md) ([em português](tools/README_USBTOOL.pt-BR.md)) — `celerctl` command reference and the wire protocol.
* [tools/README_OTA.md](tools/README_OTA.md) ([em português](tools/README_OTA.pt-BR.md)) — OTA manifest scheme (`update.json`) and update channels.
* [components/README.md](components/README.md) — vendored helper components and local patches.

Desktop JS harness for the bundled apps (no hardware needed):

```bash
node test/js_harness/run.js
```

## Roadmap

* More boards (help with a bring-up is welcome — board profiles are small and self-contained; the [barebone devkit](https://github.com/Celer-Brasil/CelerOS/wiki/Barebone-Devkit), the [SpotPear robot dog](https://github.com/Celer-Brasil/CelerOS/wiki/Robot-Dog), the [Waveshare AMOLED 2.06 watch](https://github.com/Celer-Brasil/CelerOS/wiki/Waveshare-Watch) and the [ESP32-CAM camera node](https://github.com/Celer-Brasil/CelerOS/wiki/Supported-Boards) are the latest four to land).
* More hardware APIs in the JS runtime (I2C/SPI sensors), and voice/wake word on more boards.

## History & Credits

CelerOS started as a fork of [KryonOS](https://github.com/Haris16-code/KryonOS)
by Haris and has since diverged heavily: the Arduino/PlatformIO base was
replaced by ESP-IDF 6.1, the graphics stack moved to LovyanGFX, system apps
moved to JavaScript, and the tooling was rebuilt around `celerctl` and the
CelerOS Hub. Thanks, Haris, for the great starting point!

## License

CelerOS is licensed under the [GNU General Public License v3.0](./LICENSE).
