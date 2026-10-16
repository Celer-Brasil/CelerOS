# Architecture

**English** | [Português (BR)](/maikramer/CelerOS/wiki/Arquitetura)

How the firmware is organized, what runs on top of what, and where to touch
for each kind of change.

## Layered overview

```
+--------------------------------------------------------------+
| data/  (LittleFS partition at /local)                        |
|   System apps in JavaScript: Settings, App Store,             |
|   Installer, Terminal, Help, Web Server, Snake, demos        |
+------------------------------^-------------------------------+
                               | Duktape (ES5)
+------------------------------|-------------------------------+
| main/  (ESP-IDF app component, C++)                          |
|   Kernel/Core  CelerKernel: Duktape heap, runs main.js       |
|   Runtime      JSBindings + Js*.cpp: System / Net / FS       |
|   UI           Kui (canvas/screen/widget), docked keyboard   |
|   Launcher     discovers apps in /local/apps and /sd/apps    |
|   Display      virtual 240x320 -> physical, theme, icons     |
|   FileSystem   LittleFS (/local) + SD (/sd), atomic writes  |
|   WebManager   httpd + file manager + OTA upload + portal    |
|   OTA          OtaManager: update.json v2 + download Range   |
|   USBDevice    CelerShell, HostLink (celerctl), SerialLink  |
|   Bluetooth    CelerLink (pairing) + CelerNet (mesh)        |
|   Pack         PackId, Provision, Resources: the pack       |
|   Boards/<b>/  per-board HAL (pins, display, traits)         |
+------------------------------^-------------------------------+
                               | includes/REQUIRES
+------------------------------|-------------------------------+
| components/  (CelerOS-owned + vendored third parties)        |
|   Network (NetworkManager: sole radio owner), Http, System   |
|   (SystemInfo), Storage (NVS), Utility (Event/Singleton),    |
|   ErrorCodes, LovyanGFX, duktape                             |
+--------------------------------------------------------------+
```

The unused remainder of the old shared `esp_components` lib was removed
from the tree (Oct 2026) — everything in `components/` is built. The old
code remains reachable in git history through the `archive/esp_components`
tag (or the upstream repo).

## Boot flow

`app_main` calls `celerSetup()` once and `celerLoop()` forever
([main/main.cpp](main/main.cpp)):

1. `Board::init` — HAL of the compiled board (`main/Boards/<board>/`)
2. `UI::init(w, h)` — display and the virtual 240x320 layout
3. `FileSystem::init` — LittleFS at `/local`, SD at `/sd`
4. `SerialLink` → `USBDevice` — the `celerctl` channel
5. `Backlight` → `TimeManager` (NTP/timezone) → `WebManager::startAsync`
6. `CelerKernel::init` — the Duktape heap
7. `LauncherUI` (or touch calibration on the CYD's first boot) and
   `kui::Navigator::begin` + push of the launcher

The main loop runs on the main task: `Navigator::tick()`,
`WebManager::tick()` (deferred reboot after a web OTA), `TimeManager::tick()`,
`delay(5)`.

## The JavaScript runtime

* Globals exposed by the bindings (`main/Runtime/JSBindings.cpp` +
  `Js{System,Net,Fs,Gfx,Gpio,Keypad,Link,SystemApps,Storage,Timers,Sensors,
  Phone,Ai,Mic,Wake}.cpp`): `System`, `Net`, `FS`, `Storage`, `Sensors`,
  `Phone`, `AI`, `Mic` and `WakeWord` (the last ones depend on the
  build/hardware) plus `CelerLink` (the BLE link, on Bluetooth builds).
* Apps are pure ES5 (no `Promise` — the builtin was compiled out of
  Duktape), with a blocking `while` loop and `System.delay()`.
* All geometry is drawn in virtual 240x320 coordinates and scaled by
  `UI::sx()/sy()` — apps never see physical pixels.
* The **API level** (`System.getAPILevel()`, currently 20) is the
  feature-detection contract for apps. History: 1 base
  (draw/touch/GPIO/FS/time) · 2 `Net` · 3 system apps in JS · 5 docked
  keyboard · 6 custom topbar + streaming `Net.download` · 7 RGB LED, light
  sensor/auto-brightness, speaker, masked prompts · 8 relays · 9 Celer Link
  (BLE) · 10 servos + robot hardware (battery, mic, touch pad, NeoPixel) ·
  11 Celer Link code pairing + keyboard `{hint:"num"}` (numeric page) ·
  12 `setTimeout`/`setInterval`, `Storage` (private NVS), multi-sprites,
  binary `FS.readFile`/`writeFile`, `setTextDatum` · 13 `Sensors.*`
  (watch IMU: accel/steps, raise-to-wake) · 14 Celer Link pairing on by
  default · 15 the watch experience (notification center, persistent
  alarms/timer, quick panels, `Phone.*` Gadgetbridge, `batteryInfo`) ·
  16 watchface plugins (`watchface.js` + `System.launchApp`) ·
  17 `System.button()` (headless devkit) · 18 `AI` (async chat,
  DeepSeek/OpenRouter) · 19 `Mic.*` (16 kHz WAV recording, `mic`
  permission) · 20 function calling (`toolCalls`) + `WakeWord.*`
  (on-device "Hi Celer").
* An optional Duktape debugger (`CONFIG_CELEROS_JS_DEBUGGER`, default on
  the ESP32-S3 targets) exposes breakpoints/step/eval over the celerctl
  channel (`celerctl debug`).
* ULP-RISC-V coprocessors stand guard while the main cores sleep: the
  deep-sleep sentinel on the watch (`Boards/waveshare-watch/WatchUlp.cpp`)
  and the battery watchdog on the dog (`Boards/spotpear-dog/DogUlp.cpp`).
* When adding/calling a new API: bump `CELEROS_API_LEVEL`, document it in
  both languages of `JS_API_Guide` and add a stub to the
  `test/js_harness/run.js` harness.

## Where to touch

| Task | Where |
|---|---|
| Add a source file | `CELEROS_SRCS` in [main/CMakeLists.txt](main/CMakeLists.txt) (it is not a glob) |
| Version / API level bump | `main/CMakeLists.txt` (`CELEROS_VERSION`, `CELEROS_API_LEVEL`) **and** the root `project(VERSION)` — keep both in sync |
| New board | `main/Boards/<b>/` + `elseif` in CMake + `boards/<b>/sdkconfig.defaults` + `updates/<channel>/update.json` |
| Gestures/touch | `UI/Kui.cpp` (TouchPump; touches injected by celerctl go through the TouchInjector) |
| Device side of celerctl | `USBDevice/HostLink.cpp` (opcodes), `SerialLink.cpp` (UART) |
| Celer Link (BLE between devices) | `Bluetooth/CelerLink.cpp` + `Runtime/JsLink.cpp` (`CelerLink` global) |
| The pack (mesh, resources, joining) | `Pack/` (`PackId`, `Provision`, `Resources`) + `Bluetooth/CelerNet.cpp`; design in `Documentation/CelerNet_Design.pt-BR.md` |
| Web pages | `WebManager/*.html` (re-embedded as gzipped headers at build time) |
| Wi-Fi radio / credentials | `components/Connection` (`NetworkManager` singleton) |

## The pack: three pillars, one system

Devices form a private network — the **pack** — where each one publishes its
hardware (mic, camera, speaker, relays, sensors) as resources the others use.
Three technologies are three pillars of it:

| Pillar | Role | Code |
|---|---|---|
| **CelerLink** | trust: pair by a 6-digit code; the bond then carries the pack key (sealed invite) | `Bluetooth/CelerLink.cpp`, `Pack/Provision.cpp` |
| **CelerNet** + resources | the mesh: encrypted BLE flooding, presence, leases, ESP-NOW data plane | `Bluetooth/CelerNet.cpp`, `Pack/Resources.cpp` |
| **HostLink** | the gateway: the computer joins over the USB cable as a virtual member `pc-XXXX` | `USBDevice/HostLink.cpp`, `USBDevice/UsbRes.h` |

They share one identity (`Pack/PackId`: node id from the BT MAC, one
persistent name) and one key with three doors: password (`Pack.join`, shell
`mesh join`, `celerctl mesh join`), the CelerLink invite (`Pack.invite`, the
Matilha app) and the cable. Apps use `Pack.*` as the facade (JS API guide,
section 43).

## Conventions worth knowing

* **Never** board `#ifdef`s outside `main/Boards/<board>/` — compile-time
  differences live in the board's `BoardTraits.h`.
* Logging via `celer_log_printf/println` (goes to UART/CDC **and** the
  `logcat` buffer), never raw `printf`.
* Persistent state via `FileSystem::writeTextFile` (tmp + rename,
  power-loss resistant).
* Fallible operations return `ErrorCode` (registry in
  `components/ErrorCodes`), not `esp_err_t`.
* Singletons: `class X : public Singleton<X>` with a token-taking ctor.
* `Event<...>` handlers only set flags — `trigger()` holds the mutex for
  the whole dispatch.
* Never call `Storage::initialize()` from components: it would mount
  SPIFFS over the partition CelerOS formats as LittleFS. The OS filesystem
  is `main/FileSystem`.
* Comments, logs and CLI strings are written in Portuguese, without
  accents. Text shown on screen (UI, toasts, app strings) may use accents:
  the fonts cover Latin-1.

## Code hotspots

| File | ~LOC | Role |
|---|---|---|
| `main/Runtime/JSBindings.cpp` + `Js*.cpp` | ~2.9 K | the whole JS surface |
| `main/WebManager/WebManager.cpp` | ~960 | httpd, file manager, OTA upload, screen mirror |
| `main/Bluetooth/CelerLink.cpp` | ~1070 | Celer Link: NimBLE GATT + advertising + code pairing (API 11) |
| `main/UI/Kui.cpp` | ~900 | immediate-mode UI framework |
| `main/Launcher/Screens.cpp` | ~810 | system screens |
| `main/FileSystem/FileSystem.cpp` | ~640 | atomic FS + MD5 |

More detail per directory: the `AGENTS.md` files of [main/](main/AGENTS.md),
[components/](components/AGENTS.md), [main/Runtime/](main/Runtime/AGENTS.md)
and [Network/](components/Network/AGENTS.md) in the repository.
