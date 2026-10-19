# main/ - CelerOS firmware core

## OVERVIEW
The single ESP-IDF app component (~50 files, 13 subdirs; score 17). It holds the boot, UI framework, launcher, JS kernel, FS, network/web, OTA and USB/serial link. Sources are listed explicitly in `CMakeLists.txt` (no glob).

## STRUCTURE
```
main/
├── main.cpp          # app_main -> celerSetup() once, then celerLoop() forever
├── Boards/<board>/   # Board.cpp + BoardDisplay.h + BoardTraits.h (one board compiled in)
├── Display/          # Layout.h (240x320 virtual -> physical), Theme.h, Icon (PNG->RGB565+A4 cache), Backlight, ScreenPower (dim/AOD/off ladder)
├── UI/               # Kui.{h,cpp}: kui:: Canvas/Screen/Widget/TouchPump/Navigator; Keyboard
├── Launcher/         # LauncherUI (scans /local/apps/ + /sd/apps/, home app), Screens.cpp (system screens), WatchPanels (edge-gesture panels: quick settings + notification center with header X; top edge in thirds — see WHERE TO LOOK), AlarmScreen (ring UI), PhoneScreens (pairing passkey / incoming call)
├── Kernel/           # Core/CelerKernel (Duktape heap, runs app main.js), TimeManager (NTP/tz/epoch), Alarms (persistent scheduler, API 15), Notifications (system-wide center, /local/notifications.txt)
├── Bluetooth/        # CelerLink (device-to-device NimBLE, API 9+) + PhoneLink (Gadgetbridge/Bangle.js, CONFIG_CELEROS_PHONE_LINK, API 15)
├── Runtime/          # JS API surface: JSBindings.cpp core + Js*.cpp modules (own AGENTS.md)
├── FileSystem/       # static FileSystem:: LittleFS(/local) + SD(/sd), atomic writes, MD5
├── WebManager/       # WiFi boot/reconnect (+async toggle), httpd file manager + /update OTA upload (gzip pages), captive portal host
├── OTA/              # OtaManager: update.json v2 check + resumable HTTP(S) download (Range) straight into the OTA slot; OtaGuard = one writer at a time
├── USBDevice/        # CelerShell, HostLink (celerctl protocol), SerialLink (UART/USJ), USBDevice (dual CDC), LogSink
├── Hardware/         # BoardIO (IO + battery + tone + LEDC map), Buttons, PowerPolicy (DFS/light sleep, idle WiFi)
├── Utils/            # CelerSettings (NVS), AlarmCalc (pure, host-tested), GbProto (Bangle.js protocol, pure, host-tested), AppGrants/AppPerms
├── Compat/           # Arduino.h shim (millis/delay/pinMode...) over IDF - include path root
├── Settings/         # TouchCalibrator
└── Assets/           # SplashLogo.h (GENERATED: 64-color PNG drawn with drawPng), Fonts/CelerFonts (GENERATED)
```

## BOOT FLOW (main.cpp)
Board::init -> ScreenCapture::init -> FileSystem::init -> SerialLink (UART; log-only hook when `CELEROS_USB_NATIVE`) -> USBDevice -> Buttons -> ScreenPower -> PowerPolicy -> TimeManager -> Alarms -> WebManager::startAsync -> CelerKernel::init -> LauncherUI/TouchCalibrator -> kui::Navigator::begin + WatchPanels::init (+ PhoneLink::init on the watch) -> push launcher (or the board's homeApp / `/local/autostart.txt`).
Loop (`celerLoop`, main task, 32KB stack): `Navigator::tick()`, `WebManager::tick()`, `TimeManager::tick()`, `Backlight::tick()`, `Buttons::tick(false)`, `ScreenPower::tick(false)`, `LauncherUI::idleHomeTick()`, `AlarmScreen::service()`, `WatchPanels::service()`, `PowerPolicy::tick()` (+ `PhoneLink::tick()`/`PhoneScreens::service()` on the watch), `confirmPendingOta()` (also called from the apps' `present()` — a home-app boot never reaches celerLoop), `delay(PowerPolicy::loopDelayMs())`. JS apps pump the same ticks inside `present()`.

## WHERE TO LOOK
| Task | Location |
|------|----------|
| Add a source file | append to `CELEROS_SRCS` in `main/CMakeLists.txt` (it is not globbed) |
| Bump firmware version / API level | `main/CMakeLists.txt` `CELEROS_VERSION`, `CELEROS_API_LEVEL`, plus root `project(VERSION)` |
| New board | `Boards/<b>/` (3 files) + `elseif` in `main/CMakeLists.txt` + `boards/<b>/sdkconfig.defaults` + `updates/<channel>/update.json` |
| Touch gestures / tap vs swipe | `UI/Kui.cpp` TouchPump; injected touches (celerctl tap) go through TouchInjector; multitouch (API 43) = "TOUCH PIPELINE" below |
| System edge panels / watch edge gestures | `Launcher/WatchPanels.*` (native screens) + `Runtime/JSBindings.cpp` `pollWatchEdges` (JS apps) — one map, two homes; top edge in thirds (left = quick settings, center = notification center, right = retractable topbar reveal), bottom edge up = notifications, left edge = exit/back; keep both in sync |
| celerctl device side | `USBDevice/HostLink.cpp` (opcodes + handlers; framing in `HostFrame.h`, pure C++, unit-tested in `test/cpp/run_tests.cpp`), `SerialLink.cpp` (UART/USJ transport + console mux + LogSink), `USBDevice.cpp` (dual CDC, `CELEROS_USB_NATIVE`) |
| App discovery / launch | `Launcher/LauncherUI.cpp` (appDirs, `main.js`) |
| Alarms / timer / snooze scheduling | `Kernel/Alarms.*` + `Launcher/AlarmScreen.*` (pure date math in `Utils/AlarmCalc.h`, host-tested; API 12 `TimeManager::setAlarm` = slot 0) |
| Notifications (history, dnd, toast, AOD dot) | `Kernel/Notifications.*` — consumed by System.notify JS, the notification center panel and PhoneLink |
| Phone Link (Gadgetbridge) | `Bluetooth/PhoneLink.*` + `Launcher/PhoneScreens.*` + `Runtime/JsPhone.cpp`; protocol pure part in `Utils/GbProto.h`; Kconfig `CELEROS_PHONE_LINK` (watch) |
| Screen states (dim/AOD/off), raise-to-wake | `Display/ScreenPower.*`; deep sleep wakes on the next alarm event |
| Power (DFS, light sleep, idle WiFi) | `Hardware/PowerPolicy.*`; needs `CONFIG_PM_ENABLE` (watch sdkconfig) |
| Web file-manager / firmware-upload page | edit `WebManager/filemanager.html` / `ota_upload.html`; the build gzips and embeds them (`main/CMakeLists.txt`), served with `Content-Encoding: gzip` |
| Turn a subsystem off for a board | `Kconfig.projbuild`: `CELEROS_WEB_SERVER`, `CELEROS_SD_CARD`, `CELEROS_JS_GPIO`, `CELEROS_AUDIO` (all default y), `CELEROS_MIC`, `CELEROS_JS_PHYSICS`, `CELEROS_JS_CAMERA`, `CELEROS_WAKE_WORD` (hardware opt-in); set `# CONFIG_... is not set` in `boards/<b>/sdkconfig.defaults`. Off-flags keep the JS contracts via inline stubs in the headers (`AudioPlayer.h`/`MusicSynth.h`/`BoardIO.h`) — callers never need `#if`; the CYD lite profile turns the whole set off (see `boards/cyd/sdkconfig.defaults`) |

## TOUCH PIPELINE (API 43 MULTITOUCH — read before touching any touch code)
One read path, one primary, additive everywhere. Designed so that single-finger behavior is byte-identical to the pre-43 firmware:

- **`kui::readTouches(TouchPoint* out, size_t max)` (`UI/Kui.cpp`) is the ONLY touch read.** Physical: `Board::display().getTouch(tp, kTouchMax=5)` — the LovyanGFX panel path converts affine/rotation PER point (never call the 1-point `getTouch(x,y)` directly: it asks the chip for count=1 and discards the rest). Injection: per-finger synthetic state from `TouchInjector`. `TouchPoint = {x, y, id (track id), size}`.
- **`readTouch(x, y)` is a wrapper of index 0.** TouchPump, `pollAppChrome`, keyboard, launcher and `System.getTouch()` all sit on it — do not add a second hardware read anywhere.
- **Primary = the OLDEST finger still on the glass**, tracked by controller track id in a small age table (`s_slots`). The chip's point 0 is arbitrary and jumps to another finger when someone lifts — never key UI state off raw index. Lifting a second finger never releases the UI touch.
- **System chrome consumes the PRIMARY only** (`pollAppChrome`: topbar X, reveal swipe, watch edges). Secondary fingers always reach the app untouched.
- **JS**: `System.getTouches()` returns `[{id,x,y,size}]` in the 240x320 virtual space, primary first, `[]` when idle. `getTouch()` and `getTouches()` share the SAME frame yield (`present()`) — call ONE of the two per loop. Glass without multitouch returns at most 1 point (XPT2046 resistive).
- **Injection/wire**: `TouchInjector::Sample` carries `finger`; `KL_TOUCH` samples are 7 bytes (legacy, finger 0) or 8 bytes (with `finger`) — the host only sends 8 when a non-zero finger exists, so old firmware never sees the new format. Bench commands: `celerctl tap/swipe --finger N`, `celerctl mtap X0,Y0 X1,Y1 [ms]` (two fingers at once).
- Capability lives in the DRIVER (it returns however many points it has — no BoardProfile flag): GT911 5 (track id per point), FT3168 5 (blocks of 6 B @0x03, id = YH>>4), XPT2046 1, headless 0. Driver details in `main/Display/Touch_*_IDF.h` headers.
- Bench status (2026-10-18): validated in the emulator/harness only (`test/sdk/run.js` two-finger e2e; `celer.js emu --input` finger tokens; live `/input {f}`). Two REAL fingers still pending on the bench: 4848 (Touch Test app: per-finger trails + pinch) and watch (FT3168 multi path never touched real glass).

## CONVENTIONS
- SmartDisplay RGB panel: `Boards/smartdisplay/Board.cpp` initializes the display from a task pinned to **core 1** so the LovyanGFX VSYNC ISR (which restarts the panel DMA every frame) does not share the Duktape/WiFi/BT core — on core 0 the whole image shook. Details and the `lcddma` shell diagnostic in `boards/AGENTS.md`.
- Board HAL: `#include "Boards/Board.h"` / `"BoardDisplay.h"` resolve through the board dir on the PRIVATE include path. **Never add a board `#ifdef`** anywhere else. Put compile-time differences in `BoardTraits.h` (e.g. `largeUi`).
- All UI geometry is designed at 240x320: scale it with `UI::sx()/sy()` and pick fonts with `UI::font(n)`. Don't hardcode physical pixels.
- Modules are static classes/namespaces (`FileSystem::`, `OtaManager::`, `kui::Navigator::`). The only global instance is `Board::display()`.
- Logging goes through `celer_log_printf/println` (LogSink -> UART/CDC and the logcat buffer), not bare `printf`.
- Use `FileSystem::writeTextFile` for persistent state (tmp + rename; power-loss safe).
- SD card (smartdisplay): `FileSystem::mountSD` resets/pulls up the 4 pins (the CS wakes in the UART1 IOMUX), tries the profile clock then 400 kHz, and honors a format request persisted in NVS — `FileSystem::formatSD` only SCHEDULES it, the **boot mount** formats FAT32 (the card answers reliably only on the boot mount; exFAT is unreadable to FatFs). Shell `sd [format]` exposes both; `Board::init` deselects the CS before the panel init (the ST7701 3-wire shares SCK/MOSI with the card). Details in `boards/AGENTS.md`.
- Comments and log strings are Portuguese without accents. Match that style.
- Feature code behind a Kconfig flag uses `#if CONFIG_CELEROS_<X>` with a no-op `#else` stub for the public entry point, so callers never need `#if`.
- `CONFIG_CELEROS_USB_NATIVE` (Kconfig.projbuild, S3 only, default n) swaps SerialLink for TinyUSB dual CDC. **Keep it off on SmartDisplay 4848S040**: GPIO19/20 are the GT911 touch SDA and an RGB data line. Enabling it also needs `CONFIG_TINYUSB_CDC_COUNT=2`. `CONFIG_CELEROS_LINK_ON_USJ` instead multiplexes console+link on the USB-Serial/JTAG itself (dog) — the two flags are mutually exclusive (OTG owns GPIO19/20).
- HostLink protocol: each transport owns a `HostLink` instance (parser per channel); the session is unique and follows the last HELLO. Proto 2 (CRC32 + window) is negotiated per session in the HELLO — proto 1 stays byte-identical for old tools. Opcode values are the single source parsed by `tools/celerctl.py`: edit `HostLink.h`, never the tool.

## ANTI-PATTERNS
- Hand-editing `Assets/SplashLogo.h`: regenerate it with `tools/make_splash.py`.
- Blocking WiFi or network calls in the UI tick. WebManager is async by design, and `scanNetworks`/`connect` block for seconds.
- Hot-path heap churn on the no-PSRAM board (CYD/ESP32): the frame sprite exists only when `Board::profile().hasPsram` is set. There the Kui canvas renders in two ping-pong bands (async DMA: never draw into a band still being pushed); screens skip off-band work with `Canvas::visible()`. The band buffer and icon caches are released while a JS app runs (`CelerKernel::runFile`).
- The `DEBUG:` heap prints in `celerSetup` are always on. They are known noise; don't copy the pattern.

## HOTSPOTS
`Bluetooth/CelerLink.cpp` 1334, `Runtime/JSBindings.cpp` 1232, `UI/Kui.cpp` 1068, `WebManager/WebManager.cpp` 982, `Launcher/Screens.cpp` 938, `FileSystem/FileSystem.cpp` 674, `Bluetooth/PhoneLink.cpp` 578.
