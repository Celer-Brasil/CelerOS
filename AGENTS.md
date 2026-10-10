# PROJECT KNOWLEDGE BASE

**Updated:** 2026-10-07
**Commit:** v1.8.0
**Branch:** main

## OVERVIEW
CelerOS: an ESP-IDF (C++) firmware OS for ESP32 devices (7 boards, from the headless 4MB devkit and the camera-node esp32-cam to a 32MB AMOLED smartwatch; most have touch displays). It has a LovyanGFX UI, runs user apps in Duktape JS (ES5) from LittleFS or SD, talks to Android via Gadgetbridge (Phone Link), and updates over the air from the hub `https://os.celer.tec.br`.

## STRUCTURE
```
CelerOS/
├── main/            # firmware core (boot, kernel, UI, launcher, BLE, power, OTA, board HAL)
│   └── Runtime/     # JS API surface: JSBindings core + Js*.cpp modules (own AGENTS.md)
├── components/      # everything here is built (Network, Http, System, Storage/NVS, Utility, ErrorCodes, duktape, LovyanGFX)
├── data/            # LittleFS image contents: system JS apps + icons (flashed separately)
├── hub_apps/        # App Store apps, same layout as data/apps (covered by data/AGENTS.md)
├── boards/<b>/      # per-board sdkconfig.defaults (+ data/ overlay & data-exclude.txt on the watch)
├── tools/           # celerctl, app_lint, sdk, flash_data.sh, ota_server, celerhub, generators
├── test/            # js_harness + meshsim (multi-node mesh) + app_lint fixtures + sdk tests + host C++ + celerctl sim (own AGENTS.md)
├── wiki/            # GitHub wiki sources, published by CI (own AGENTS.md)
├── updates/         # OTA channel dirs: esp32/, smartdisplay_4848S040/, spotpear_zzpet/, waveshare_amoled206/
├── Documentation/   # JS_API_Guide + App_Development_Guide (EN + .pt-BR)
├── include/, lib/   # stale PlatformIO placeholders, unused
└── partitions_{16MB,4MB,32MB}.csv
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Boot flow, kernel, UI, launcher, BLE, power | `main/AGENTS.md` | entry `main/main.cpp` |
| Add or change a JS API call / API level | `main/Runtime/AGENTS.md` | bump `CELEROS_API_LEVEL` (now 34) |
| Component membership, reviving archived code | `components/AGENTS.md` | git tag `archive/esp_components`; `components/README.md` (PT) = patch list |
| WiFi STA/AP, captive portal, credentials | `components/Network/AGENTS.md` | NetworkManager owns the radio; OTA flash is `main/OTA` |
| Boards, adding a board, per-board data image | `boards/AGENTS.md` | 7 boards |
| Test suites and what CI runs | `test/AGENTS.md` | |
| Wiki pages | `wiki/AGENTS.md` | CI publishes; never edit on the web |
| Firmware size / what costs flash | `python3 tools/size_report.py` | CYD OTA slot is the binding constraint |
| System apps, app.json rules | `data/AGENTS.md` | ES5 only |
| Device CLI, data flashing, local OTA server | `tools/AGENTS.md` | |
| JS API docs for app authors | `Documentation/JS_API_Guide*.md` | keep EN and pt-BR in sync |

## CODE MAP
| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `app_main` | fn | `main/main.cpp` | calls `celerSetup()` once, then `celerLoop()` forever |
| `celerLoop` | fn | `main/main.cpp` | `CelerServices::tickLoop()` + `delay(PowerPolicy::loopDelayMs())` |
| `CelerServices` | registry | `main/Kernel/Services.{h,cpp}` | ordered service list (LOOP/PRESENT/ALWAYS) driven by BOTH pumps: `celerLoop` (inApp=false) and `JSBindings::present()` (inApp=true); new services = one line in the table |
| `CelerKernel` | class | `main/Kernel/` | app/runtime kernel (Duktape heap, runs main.js); exec-timeout hook `celer_exec_timeout_check` (loop JS puro vira RangeError, nao reboot) |
| `TimeManager`, `Alarms`, `Notifications` | classes | `main/Kernel/` | NTP/tz; persistent alarms+timer+snooze; notification center (/local/notifications.txt) |
| `PowerPolicy` | class | `main/Hardware/` | DFS + light sleep when screen is off, idle WiFi off |
| `ScreenPower` | class | `main/Display/` | dim/AOD/off state ladder, raise-to-wake, glance on notification |
| `CelerLink`, `PhoneLink` | classes | `main/Bluetooth/` | NimBLE host: device-to-device link; Gadgetbridge (Bangle.js) phone link |
| `WatchPanels`, `AlarmScreen` | classes | `main/Launcher/` | edge-gesture panels (quick settings, notification center); full-screen alarm ring |
| `JSBindings::init` | fn | `main/Runtime/JSBindings.cpp` | registers the JS API from `kFnsN[]` tables |
| `Kui` | class | `main/UI/` | immediate-mode UI: Canvas/Screen/Widget/TouchPump/Navigator |
| `NetworkManager::instance()` | singleton | `components/Network` | sole WiFi radio owner |
| `SystemInfo::instance()` | singleton | `components/System` | device info |
| `Event<Args...>` | template | `components/Utility` | type-erased core; single static mutex; handlers only set flags |
| `ErrorCode` | registry type | `components/ErrorCodes` | fallible return type (not esp_err_t) |

Boot order: Board::init -> ScreenCapture::init -> FileSystem::init -> SerialLink (UART, or log-only hook on USB-native boards) -> USBDevice -> Buttons -> ScreenPower -> PowerPolicy -> TimeManager -> Alarms -> WebManager::startAsync -> CelerKernel::init -> LauncherUI -> Navigator::begin -> WatchPanels::init (+ PhoneLink::init on the watch) -> push launcher (or the board's homeApp).

## WORKFLOW (HOW WE WORK HERE)
- **Human and AI pair on the same tree, often in parallel.** Re-read a file right before editing it and run `git status` before staging. Files that changed under you mid-task are the other side's in-flight work: leave them uncommitted and mention them in your report.
- **Selective staging only**: `git add <explicit paths>`, never `-A`/`-u`/`.`. When one file carries two features, split it by hunks (`git apply --cached` with a crafted patch is the reliable non-interactive way) — see 317c7d3 or the API 15 commits (ed70e10/4a04292).
- **Commit style**: Portuguese without accents, subject `Area: assunto` + a detailed body (what, why, bench evidence). One story per commit; its tests, stubs and lint updates ride along. No AI attribution footers.
- **Push discipline**: fast-forward only, never `--force` (history was filter-repo'd once; old hashes must never come back). On rejection, fetch and rebase your own unpushed commits.
- **Gates before any push** (CI repeats them in `.github/workflows/build.yml`): `node test/js_harness/run.js`, `node test/app_lint/run.js`, `node test/sdk/run.js`, `node test/debug/run.js`, `node test/meshsim/run.js`, `node tools/app_lint/lint.js data/apps hub_apps boards/*/data/apps`, `node tools/sdk/celer.js check`, `g++ -std=c++17 -Wall -Wextra -o celeros_tests test/cpp/run_tests.cpp && ./celeros_tests`. If the JS API moved, regenerate types first: `node tools/sdk/celer.js types` (commit `tools/sdk/types/celer.d.ts` alongside).
- **Releases are cut by tag**: pushing `v*` triggers `release.yml` (per-board factory zips + CelerOS Flasher). Tag deliberately after bench validation, never as a side effect.
- **Release notes are in English** (audience: first-time flashers; the repo's public artifacts — README, wiki EN pages — are English). The annotated tag body becomes the notes' preamble, so write tag bodies in English too; the flash instructions template lives inside `release.yml` and must teach the Flasher workflow (download flasher + board zip, extract together, board -> port -> erase on first flash).
- **Bench**: hardware validation is manual (CI has no device). Ports (the two CH340 boards swap with plug order — `celerctl devices -l` names each): `/dev/ttyUSB0` SmartDisplay, `/dev/ttyUSB1` CYD, `/dev/ttyACM0` dog or watch (flash id disambiguates: 16MB vs 32MB). The watch takes firmware over `celerctl ota push` (retry on timeout); esptool is for first load only.

## CONVENTIONS
- Board selected via CMake cache `-DCELEROS_BOARD=smartdisplay|cyd|cyd-vspi|spotpear-dog|waveshare-watch|devkit` (default smartdisplay; any other value is FATAL_ERROR). See `boards/AGENTS.md` for the differences.
- Version lives in TWO places: root `CMakeLists.txt` `project(CelerOS VERSION x)` and `main/CMakeLists.txt` `CELEROS_VERSION`. Keep them in sync.
- Subsystems compile out per board via Kconfig (the dormant remainder of the old shared `esp_components` lib left the tree in 2026-10; git tag `archive/esp_components` keeps it): `CELEROS_WEB_SERVER`, `CELEROS_SD_CARD`, `CELEROS_JS_GPIO`, `CELEROS_BLUETOOTH`, `CELEROS_PHONE_LINK` (watch), `CELEROS_USB_NATIVE` (watch), `CELEROS_LINK_ON_USJ` (dog), `CELEROS_UI` (off on headless boards — devkit, esp32-cam — the whole display stack leaves the binary).
- Built with `-fno-exceptions` and an ES5-lean Duktape (`components/duktape/celeros_duk_config.yaml`) whose builtins live in ROM (base heap ~8KB); JS bindings are lightfuncs. A `std::string`/`new` that cannot grow **aborts** the device: on the no-PSRAM path use malloc/realloc (see `HttpClient::setBodySink`, `CelerKernel` source loader).
- CYD runs **unicore** with `CONFIG_ESP32_IRAM_AS_8BIT_ACCESSIBLE_MEMORY`: the free IRAM holds the app source during compile, the TLS buffers, and Duktape overflow past a 24KB DRAM reserve. Tasks must not be pinned to core 1 (use `portNUM_PROCESSORS - 1`).
- The littlefs partition has CSV subtype `spiffs` but is mounted as LittleFS at `/local`. The SD card is at `/sd`. Boards may overlay (`boards/<b>/data/`) or exclude (`data-exclude.txt`) apps from the factory image — see `tools/flash_data.sh`.
- JS apps use a 240x320 virtual coordinate space, scaled by `UI::sx/sy` (`System.getInfo().inset/shape/screenW/screenH` describe the glass).
- Comments, logs, and CLI output are in Portuguese (no accents). Headers use Doxygen. Text shown on screen (UI, toasts, app strings) may use accents: the fonts cover Latin-1 (U+0020..U+00FF; no em dash, curly quotes or emoji). `tools/acentuar.py` restores accents inside string literals.
- Generated but committed: `main/Assets/Fonts/CelerFonts.{h,cpp}` (make_fonts.py: LovyanGFX ASCII verbatim + Latin-1 accents), `main/Assets/SplashLogo.h` (make_splash.py, PNG), `data/icons/*.png` (make_icons.py + icons.json), `tools/sdk/types/celer.d.ts` (celer.js types), `components/duktape/duktape.c|h`, `duk_config.h` (Duktape configure.py). Web pages are gzipped at build time from `main/WebManager/*.html`.

## ANTI-PATTERNS (THIS PROJECT)
- NEVER call `Storage::initialize()`: it mounts SPIFFS over `/local`. Use `main/FileSystem`.
- NEVER add board `#ifdef`s outside `main/Boards/<b>/`.
- NEVER enable `CONFIG_CELEROS_USB_NATIVE` on SmartDisplay (GPIO19/20 conflict).
- NEVER use ES6+ syntax in JS apps (Duktape = ES5).
- NEVER `git push --force` or edit the wiki through the GitHub web UI (CI generates it from `wiki/`).
- Do not assume OTA updates apps: OTA ships firmware only.

## COMMANDS
```bash
# SmartDisplay (ESP32-S3)
idf.py -B build -DSDKCONFIG=build/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/smartdisplay/sdkconfig.defaults" \
  -DCELEROS_BOARD=smartdisplay set-target esp32s3
idf.py -B build build flash -p /dev/ttyUSB0 monitor
# Other boards: same shape, build-<b>/ dir, boards/<b>/sdkconfig.defaults, -DCELEROS_BOARD=<b>, set-target esp32|esp32s3

tools/flash_data.sh [smartdisplay|cyd|spotpear-dog|waveshare-watch|devkit] [PORT]  # LittleFS data partition (needs IDF env)
python3 tools/celerctl.py devices|shell|push|pull|logcat|apps install ...   # over UART/CDC
python3 tools/celerctl.py top -w                                             # profiling: CPU% por task, heap, app, fps (KL_STATS)
python3 tools/celerctl.py ota push build/CelerOS.bin                        # OTA without esptool (the watch's path)
python3 tools/celerctl.py debug MyApp                                       # JS debugger REPL (S3 boards: CELEROS_JS_DEBUGGER)

# Validation battery (run before any push; CI runs the same)
node test/js_harness/run.js
node test/app_lint/run.js
node test/sdk/run.js
node test/debug/run.js
node test/meshsim/run.js                 # E2E da malha: apps reais em N nos simulados
node tools/app_lint/lint.js data/apps hub_apps boards/*/data/apps
node tools/sdk/celer.js check            # drift; `celer.js types` regenerates celer.d.ts
g++ -std=c++17 -Wall -Wextra -o celeros_tests test/cpp/run_tests.cpp && ./celeros_tests

python3 tools/size_report.py --baseline f.json    # image vs OTA slot, per-library deltas (needs IDF env)
```

## NOTES
- **SECURITY:** the Supabase service_role key was removed from the tree AND purged from the whole git history with `git filter-repo` + force-push (2026-10-01; every commit hash changed). ROTATION in the Supabase dashboard is STILL MANDATORY: the old history remains reachable through old clones, forks and GitHub's PR refs (`refs/pull/1/head`). Its last local copy (`extras/esp_components/config/config/supabase_config.h`, gitignored, never committed) was deleted together with the `extras/` removal (2026-10-05).
- `components/duktape` and LovyanGFX are vendored third-party code. Do not edit or document them.
- **SmartDisplay screen shaking/scrambling**: read `boards/AGENTS.md` "SMARTDISPLAY RGB PANEL" first (display init pinned to core 1, never the 64 B data cache line, `lcddma` shell diagnostic). The fix took a day of bench time.
- CI: `build.yml` (tests above + firmware for all 7 boards with an OTA-slot size gate; hardware validation is manual), `wiki.yml` (publishes the wiki from `wiki/`), `release.yml` (tag `v*` -> factory zips + Flasher).
- TLS validates certificates (bundle: FULL on SmartDisplay, CMN on CYD). Hub/Google TLS needs `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_CROSS_SIGNED_VERIFY=y`.
- `sdkconfig.defaults` changes only reach an existing build dir after deleting `build*/sdkconfig` (it is regenerated). `python3 tools/sdkconfig_check.py` lists every bench build dir whose sdkconfig drifted from its board's defaults (in 2026-10 the watch and dog bench builds still ran a 32 KB main stack the defaults had cut to 24 KB). `dependencies.lock` flip-flops with the last-built target; don't commit build churn of it.
- OTA: device reads update.json v2 (`version`, `api_version`, `firmware_url`, `changelog`) from the hub, or from the URL in `/local/ota_url.txt` when set. The web UI `/update` also accepts uploads.
- `test/README`, `include/`, `lib/` are stale PlatformIO leftovers.
