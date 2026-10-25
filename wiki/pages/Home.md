# CelerOS

**English** | [Português (BR)](/Celer-Brasil/CelerOS/wiki/Home-(Português))

<p align="center">
  <img src="Documentation/assets/celeros_logo.png" alt="CelerOS" width="420"/>
</p>

CelerOS is a lightweight, open-source GUI operating system with a JavaScript
app runtime for ESP32 microcontrollers. It turns cheap display boards into a
small "smartwatch-grade" device: an immediate-mode UI on top of LovyanGFX, a
Duktape JS engine running sandboxed apps from flash or SD, an App Store with
over-the-air updates, and a USB companion tool (`celerctl`) for day-to-day
development.

| Launcher | App Store | Settings |
| :---: | :---: | :---: |
| <img src="Documentation/assets/imgs/celeros-launcher.png" width="240" alt="Launcher"/> | <img src="Documentation/assets/imgs/celeros-appstore.png" width="240" alt="App Store"/> | <img src="Documentation/assets/imgs/celeros-settings.png" width="240" alt="Settings"/> |

*Captured from the real framebuffer of a SmartDisplay 4" (firmware 1.5) via `celerctl screencap`.*

| Watchface on the Waveshare watch | Launcher on the watch |
| :---: | :---: |
| <img src="Documentation/assets/imgs/watch-watchface.png" width="200" alt="Watchface on the Waveshare watch"/> | <img src="Documentation/assets/imgs/watch-launcher.png" width="200" alt="Launcher on the watch"/> |

*Captured from the real framebuffer of the Waveshare watch via `celerctl screencap` (over the native USB).*

## What's new

Firmware 1.11.6 — the fleet round (JS API level 50):

* **Signed OTA** — `update.json` carries an ECDSA P-256 signature over `version`, `api_version`, `firmware_sha256` and `variant`; the firmware verifies it against the embedded public key and the stream SHA-256 before switching slots. HTTPS manifests without a valid signature are refused. The private key stays outside the repository.
* **Fleet agent** — `celeros.agent` (system app) runs a background service with heartbeat and commands for signed OTA, app updates, self-update, reboot, sync and diagnostics; `caps.ota_signed` tells a control plane whether the device verifies signatures ([fleet agent](/Celer-Brasil/CelerOS/wiki/Fleet-Agent)).
* **Background network + OTA** — services use `Net.request`/`Net.download` (`net`) and `System.otaStart`/`restart`/`installZip` (`system`) without pumping the foreground app ([JS API](/Celer-Brasil/CelerOS/wiki/JS-API)).
* **Eight boards** — the headless ESP32-S3 devkit (`devkit-s3`, USB Host) joins SmartDisplay, CYD/CYD-VSPI, robot dog, watch, devkit and ESP32-CAM; each has its own signed OTA channel ([supported boards](/Celer-Brasil/CelerOS/wiki/Supported-Boards)).
* 1.11.0–1.11.5 added the stream SHA-256 check, `System.epoch()`, the app.zip installer, app eviction before OTA and the hard `firmware_sha256` gate for HTTPS.

Firmware 1.8.2, before that — the games round (JS API level 36):

* **Supernova 2.4, Detona! 0.8 and Arrasa! 1.1** — three full games now riding **CelerGame, the game engine delivered as a shared dependency family** (`celeros.game` core + `.fx`/`.spr`/`.tilemap`/`.ui` modules): a 480×480 sprite shooter on a **native canvas** (API 28), a grid bomberman whose **1×1 duel plays over the Bluetooth mesh** — lobby, invite and best of 3 rounds in the **same arena built from a shared seed**, with only discrete one-frame events crossing the radio — and a slingshot-vs-goblin-fortresses physics game. The monolithic `celeros.engine` stays on the hub as a 1.2.5 compatibility shim that assembles the family.
* **Shared dependencies on the hub** (API 30) — the game engine family, physics, mesh, SFX and grid libraries install once and every app reuses them (`deps.json`): app packages got smaller and the app size ceiling rose from 128 KB to **1 MB**.
* **Native verlet physics** (`System.verlet*`, API 31) — integration, relaxation and collisions in C++ for worlds with thousands of points; Physics Drop 4 and the Bench Fisica app already ride it. The physics dependency is at 2.1: the old `P.world`/`P.tiles`/`P.flow` helpers are gone (2.0) — grids moved to `celeros.grid`, tumbling crates to `System.rigid*`.
* **Native rigid bodies** (`System.rigid*` + `System.drawSprite`, API 33, S3 boards) — boxes that rotate, stack and topple, circles that roll, impacts that break pieces and fast projectiles that never tunnel through a thin plank; **Arrasa!** (slingshot vs. goblin fortresses, 10 levels with stars) is built on it.
* **Games that sound and move right** — `System.sfx` mixes sound effects into the music (API 32 — a single audio slot used to freeze the game), only the rectangles that changed go to the glass (up to 8 dirty boxes per frame), and the SmartDisplay panel interrupt left the JavaScript core: the image no longer shakes and PSRAM boards gain up to ~2× more frames per second.
* 1.8.1, in between, made **over-the-air updates survive the trip**: a dropped connection resumes by HTTP Range from the last written byte with growing back-off, and `celerctl push` verifies the board actually booted the slot it wrote.

Firmware 1.8, before that (JS API level 27) — the pack:

* **The pack ("matilha")** — devices discover each other and form a **multi-hop Bluetooth mesh** (CelerNet, API 26–27): every node relays by itself, presence carries each device's role, messages travel direct or broadcast up to 434 B across up to 8 hops, and the **Pack** hands the **playing chiptune to the neighbour with a speaker** — from the exact same beat ([mesh page](/Celer-Brasil/CelerOS/wiki/Pack-Mesh)).
* **Six apps that live on the mesh** (App Store): **Sonar** (radar by rings of hops, real RTT ping/loss, census), **Batata Quente** (hot potato by unicast), **Mural** (message board that reaches devices that were **off**, via Trickle), **Sentinela** (IMU/mic watchdog with two-way alarm), **Coral** (4-voice choir with synchronised entry) and **Pong Duplo** (mirrored pong over the Celer Link) ([mesh page](/Celer-Brasil/CelerOS/wiki/Pack-Mesh)).
* **Bench-hardened radio (3 boards)** — fragmented unicast now actually arrives (copies patch each other's lost fragments), relays step out of the burst's way and self-cancel, the radio arbitrates mesh × Celer Link × app scans, and Wi-Fi roaming only scans when the signal is weak (a connected scan deafened Bluetooth ~9 s every 39 s).
* **RAM to live with the pack** — measured stacks, `.bss` off to PSRAM on the S3 boards, CelerLink retry leak fixed: the watch holds mesh + phone link + Wi-Fi without starving internal RAM.
* **meshsim in CI** — the mesh apps run **for real on N simulated nodes** in the host suite: lockstep virtual clock, an air that models TTL/hops, fragments with per-link loss, the 96-packet all-or-nothing TX queue, Pack envelopes and Celer Link pairing.

Firmware 1.7, earlier in October: the **talking dog** — `AI.speak()` TTS played live (API 24), the LLM writing its own choreography (`dog_script`), the hop gait with the belly spin, AI barks in QOA, **celerctl over Wi-Fi** (Debug Bridge + `provision`), `celerctl top` profiling, persistent `/local/log` logs and a robustness round through the runtime.

Firmware 1.6: the **UI toolkit** (`UI.*`, API 22), **multi-file apps** with `require()` (API 23), **voice 2.0** and **Celer Link sealed** with AES-GCM frames (API 21).

Earlier in the 1.5 cycle: on-device AI (`AI.chat`, API 18–20), voice and the **wake word "Hi Celer"** on-device (API 19–20), the JavaScript debugger over USB, watch deep sleep with a ULP-RISC-V sentinel, **Phone Link** over Gadgetbridge (`Phone.*`, API 15), **watchface plugins** (API 16), runtime APIs 12–17, the barebone devkit board, the **CelerOS Flasher** and the **App SDK**.

## Wiki map

| Page | What it covers |
|---|---|
| [Supported boards](/Celer-Brasil/CelerOS/wiki/Supported-Boards) | The SmartDisplay 4", the CYD family, the robot dog, the Waveshare watch and the barebone devkit — and how to add a new board |
| [Building and flashing](/Celer-Brasil/CelerOS/wiki/Building-and-Flashing) | ESP-IDF 6.1, per-board builds, the LittleFS data partition and the test harness |
| [Troubleshooting](/Celer-Brasil/CelerOS/wiki/Troubleshooting) | Common build, flash, touch, Wi-Fi and web problems — and their fixes |
| [Architecture](/Celer-Brasil/CelerOS/wiki/Architecture) | Boot flow, firmware layers, the JS runtime and code conventions |
| [Robot dog](/Celer-Brasil/CelerOS/wiki/Robot-Dog) | The SpotPear/ZZPET robot dog: full reverse-engineered pinout, bring-up firmware, the CelerOS board, the BLE "Celer Link" remote and voice commands ("hi celer, senta") |
| [Waveshare watch](/Celer-Brasil/CelerOS/wiki/Waveshare-Watch) | The AMOLED 2.06 smartwatch board: pinout ported from the Rust firmware, the Watchface home app, the AOD/deep-sleep screen ladder (with the ULP sentinel) and the `Sensors` API |
| [Barebone devkit](/Celer-Brasil/CelerOS/wiki/Barebone-Devkit) | The headless 4 MB ESP32 devkit: `System.button()` + LED, headless apps and the OTA channel |
| [System apps](/Celer-Brasil/CelerOS/wiki/System-Apps) | What lives in `data/`, the `app.json` rules and how apps reach the device |
| [Web interface](/Celer-Brasil/CelerOS/wiki/Web-Interface) | File manager, firmware upload and the live screen mirror in the browser |
| [Tools](/Celer-Brasil/CelerOS/wiki/Tools) | `celerctl`, the JS debugger, `celerhub`, the local OTA server and asset generators |
| [celerctl (USB)](/Celer-Brasil/CelerOS/wiki/celerctl-USB) | Command reference and the HostLink wire protocol |
| [OTA updates](/Celer-Brasil/CelerOS/wiki/OTA-Updates) | The `update.json` manifest, channels and web upload |
| [Fleet agent](/Celer-Brasil/CelerOS/wiki/Fleet-Agent) | `celeros.agent`: heartbeat, commands, signed OTA, app updates and the svchost contract |
| [App development guide](/Celer-Brasil/CelerOS/wiki/App-Development-Guide) | How to package a JS app: `app.json`, folders, icons |
| [Watchface plugins](/Celer-Brasil/CelerOS/wiki/Watchface-Plugins) | How installed apps add widget lines to the watch face (`watchface.js`, API 16) |
| [JS API](/Celer-Brasil/CelerOS/wiki/JS-API) | Full reference of the runtime (`System`, `Net`, `FS`, `AI`, `Mic`, `WakeWord` globals) |
| [Contributing](/Celer-Brasil/CelerOS/wiki/Contributing) | Conventions, tests, CI and how to send a PR |

The pages above are the English originals; the **Português (BR)** section in
the sidebar has the Portuguese translations.

## Feature summary

* **JavaScript app runtime** — interactive ES5 apps run natively on Duktape
  (API level 50): canvas-style drawing, touch and the coupled on-screen
  keyboard, file system, HTTP/JSON networking.
* **On-device AI & voice** — `AI.chat()` talks to DeepSeek or OpenRouter
  from any app (async, TLS, function calling; keys stay outside the JS
  sandbox), `Mic.*` records 16 kHz WAV behind a `mic` permission, and the
  bundled **Chat IA** and **Qwen** apps are a chat client and a push-to-talk
  voice assistant. On the robot dog the wake word **"Hi Celer"** runs
  on-device and voice commands ("hi celer, senta") drive the legs
  (`WakeWord.*`, API 20 — [robot dog](/Celer-Brasil/CelerOS/wiki/Robot-Dog)).
* **JavaScript debugger** — `celerctl debug MyApp`: Duktape debugger over
  USB with breakpoints, stepping, eval, watches and an automatic pause on
  uncaught errors ([tools](/Celer-Brasil/CelerOS/wiki/Tools)).
* **Immediate-mode UI** — the same apps scale from 240x320 up to 480x480.
* **System apps in JS** — Settings, App Store, Installer, Help, Web Server,
  Terminal, Snake, Chat IA, Qwen and the demos live in the LittleFS
  partition; boards overlay their home apps (Watchface, Dog Face, Barebone).
* **App Store & Installer** — install apps from the
  [CelerOS Hub](https://os.celer.tec.br) over Wi-Fi or from the SD card.
* **Over-the-air updates** — from the device itself, from the browser or via
  `celerctl ota push`.
* **Live screen from the browser** — `/screen` mirrors the display over
  Wi-Fi and forwards your clicks as touches.
* **Board hardware in JS** — RGB LED, light sensor with auto-brightness,
  speaker (`System.beep`), relay lines and servos (`System.gpio.servo`) on
  supported boards; robot boards add battery, microphone, capacitive touch
  pad and NeoPixel (`System.battery`/`micLevel`/`touchPad`/`neopixel`);
  the watch adds an IMU with pedometer and raise-to-wake
  (`Sensors.accel/steps/temp`), a battery, an RTC that keeps time without
  network and audio volume (`System.setVolume`); the headless devkit
  exposes the BOOT button (`System.button()`, API 17).
* **Watch-grade power management** — the screen ladder dims after a few
  seconds, falls back to an always-on face with anti burn-in, then goes to
  automatic deep sleep guarded by a ULP-RISC-V sentinel that watches the
  buttons, the battery and the cable (PWR wakes it in ~100 ms); the watch
  boots straight into its watch face.
* **Celer Link (BLE)** — a Bluetooth LE link between nearby CelerOS devices
  (API 9): a board on a robot runs `CelerLink.start()`, another one drives it
  with `scan()`/`connect()`/`send()` — see the
  [robot dog](/Celer-Brasil/CelerOS/wiki/Robot-Dog) page and the Celer Remote
  app in the hub. Since API 11 it pairs with a 6-digit code and a
  challenge-response key per bond. Runs on the SmartDisplay, the watch and
  the robot dog.
* **Phone Link (Gadgetbridge)** — the watch pairs with Android over BLE
  posing as a Bangle.js: notifications with a full-screen alert, music
  control, weather, incoming calls and find-my-phone (`Phone.*`, API 15 —
  [watch page](/Celer-Brasil/CelerOS/wiki/Waveshare-Watch)).
* **Notifications & alarms** — a system notification center (`System.notify`;
  on the watch an incoming notification wakes the screen) and persistent
  alarms with their own ringing screen (API 15).
* **Watchface plugins** — installed apps extend the watch face with widget
  lines (`watchface.js` + `System.launchApp`, API 16 —
  [plugins page](/Celer-Brasil/CelerOS/wiki/Watchface-Plugins)).
* **CelerOS Flasher & App SDK** — no-toolchain GUI flashing from
  [GitHub releases](https://github.com/Celer-Brasil/CelerOS/releases), and
  `tools/sdk/celer.js` for scaffolding, linting, emulating (one PNG per
  clock milestone with pixel diffs) and publishing apps
  ([tools](/Celer-Brasil/CelerOS/wiki/Tools)).
* **Wi-Fi via captive portal** — a `CelerOS-Setup-XXXX` access point to
  configure it from your phone.
* **`celerctl`** — an adb-style USB companion: shell, push/pull, logcat
  (timestamps, filters, non-destructive dump), the JS debugger, screencap
  and in-place firmware updates. The last app error persists to
  `/local/lastcrash.txt` (`lasterror` in the shell).

## Links

* [Repository](https://github.com/Celer-Brasil/CelerOS) ·
  [README in English](https://github.com/Celer-Brasil/CelerOS/blob/main/README.md) ·
  [README em português](https://github.com/Celer-Brasil/CelerOS/blob/main/README.pt-BR.md)
* [Issues](https://github.com/Celer-Brasil/CelerOS/issues) — bugs and ideas
* History: CelerOS started as a fork of
  [KryonOS](https://github.com/Haris16-code/KryonOS), by Haris.

---

This wiki is generated automatically by CI from
[`wiki/`](https://github.com/Celer-Brasil/CelerOS/tree/main/wiki) in the
repository — edit there, not on the web.
