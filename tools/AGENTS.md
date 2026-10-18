# tools/ - host-side Python/shell/Node tooling

## OVERVIEW
Host utilities: device control over serial (`celerctl`), the JS app linter (`app_lint`), the LAN OTA test server, the hub publisher, data-partition flashing, and asset generators. It is a distinct domain (score ~9; own `requirements.txt`). Docs: `README_USBTOOL.md`, `README_OTA.md` (both also in `.pt-BR`).

## WHERE TO LOOK
| Tool | Role | Key usage |
|------|------|-----------|
| `celerctl.py` (2100+) | HostLink client (device side: `main/USBDevice/`). Two wire formats negotiated in the HELLO: proto 1 (legacy, byte-identical to the old days) and proto 2 (CRC32 on every frame, sliding window on WRITE/OTA chunks, offset-tagged pipelined READ, paginated LS, recursive DELETE); `--proto 1` forces legacy. Third transport: the **Celer Debug Bridge** over TCP/WiFi (`-p IP` — banner+token AUTH in `NetTransport`, discovery by UDP broadcast). Own tests: `python3 test/test_celerctl.py` (FakeDevice + FakeBridge loopback, no hardware; runs in CI) | `devices [-l]` (USB serial + WiFi IPs), `pair IP [--token T]` (stores the bridge token in `~/.config/celerctl/tokens.json`), `-p PORT\|SERIAL-PREFIX\|IP`, `info`, `top [-w] [--sort cpu\|stack\|name]` + `stats [--json]` (profiling KL_STATS 0x20: per-task CPU%/stack watermark via deltas host-side, heap/PSRAM, JS app usage, fps; device shell has `top [ms]` too), `shell [cmd]`, `ls/cat/rm [-r]/mkdir/mv`, `push`, `pull`, `reboot`, `logcat [--dump]`, `ota push FW.bin [--no-reboot]`, `coredump [--keep]`, `debug [App] [--serve]` (Duktape debugger: proxy + REPL `tools/debug/dbg.js`, protocol in `debug/dmsg.js`; host tests `test/debug/run.js`), `screencap out.png`, `tap X Y [ms]`, `swipe X0 Y0 X1 Y1 [ms]`, `apps list/install <dir> [--deps-local]/rm/run <name>/deps [--gc --yes]` (`--deps-local`: deps also from `tools/sdk/engine`, stripped like `publish-dep`, newest satisfying wins — test engine/physics on a board before publishing; `run`/`dev` accept the folder name too) (install verifies every written file by read-back crc32 — app files, hub deps in `/local/modules` and `deps.json`; `dev` reloads verify too, `--pula-verify` skips; 2+ boards without `-p` refuses to guess) |
| `app_lint/` | static "compiler" for JS apps: acorn (ES5, same profile as the device Duktape) + checks against the firmware API. The manifest is DERIVED from source on every run (`JSBindings.cpp` tables, `Js*.cpp` bodies for min arity, `main/CMakeLists.txt` for API level, pt-BR guide for per-fn levels) — never hand-maintained | `node tools/app_lint/lint.js [paths]` (default `data/apps hub_apps`; `--json`, `--strict`, `--dump-manifest`), `... check` = drift code/docs/harness-stubs; wired into CI, `celerhub publish` (errors block) and `celerctl apps install` (`--pula-lint` to force); own tests: `node test/app_lint/run.js` |
| `flash_data.sh` | build the LittleFS image of `data/` (plus the board's `data/` overlay minus its `data-exclude.txt`) and write the `littlefs` partition | `tools/flash_data.sh [smartdisplay\|cyd\|spotpear-dog\|waveshare-watch] [PORT]` (PORT default: `/dev/ttyACM0` on dog/watch, `/dev/ttyUSB0` elsewhere; needs `IDF_PATH` exported; uses `bin/mklittlefs.bin` + IDF `parttool.py`; partition CSV per board: 16MB/4MB/32MB) |
| `ota_server.py` | local update.json + firmware server | `--board smartdisplay\|cyd`, `--bin`, `--port` (default 10234), `--version`; the device picks it up through `/local/ota_url.txt` |
| `celerhub.py` | publish/list/delete apps on the hub | validates app folders (runs `app_lint`; errors block publish); `MAX_API_LEVEL` is read from `main/CMakeLists.txt`; token via args/env; hub via `--hub` or `CELER_HUB` (default `https://os.celer.tec.br`). Deps: `publish-dep <file.js> [--dry]` (version from the module, syntax-gated by `node --check`, same-version pre-flight needs `--force`) and `deps-status` (drift `tools/sdk/engine` x hub index, exit 1 when behind — `celer.js check` surfaces it as a warning). The js ceiling counts STRIPPED sizes everywhere (validate + app_lint), matching what ships. Own tests: `python3 test/test_celerhub.py` (runs in CI) |
| `sdk/` | app-dev SDK, single entry `node tools/sdk/celer.js` (`new/lint/types/test/emu/check/publish/dev` + `bench`) : scaffold, generated editor types, emulator (headless PNG/GIF/frame diffs + `--input` scripts, or `--serve` live browser preview with pointer/keyboard/hot reload/pause-step) and drift checks. `dev`/`publish` delegate to `celerctl`/`celerhub`; `lint`/`check` delegate to `app_lint`. Types `sdk/types/celer.d.ts` are GENERATED (commit alongside API changes, like CelerFonts); font8x8 is vendored public-domain data. Own tests: `node test/sdk/run.js` | `celer.js new MyApp` → `celer.js emu MyApp --serve` → `celerctl.py dev MyApp` → `celer.js publish MyApp` |
| `matilha/` | the PC's CelerLink (trust pillar) client over bleak: scan, 6-digit code pairing, bond v2 (`~/.config/matilha/bonds.json`, 0600), chat/send with the open app. The old `mesh` (raw-HCI BLE node speaking NetFrame v2 in clear) left in API 41: the PC joins the mesh through the GATEWAY instead (`celerctl mesh ...`, virtual member `pc-XXXX`). Own tests: `python3 test/test_matilha.py` (no radio/bleak; runs in CI) | `link scan/pair/chat/send/bonds` |
| `make_icons.py` | `icons.json` prompts -> `icons_src/*.png` (512px, local FLUX via text2d) -> `data/icons/*.png` 64px RGB565-dithered | `--regen` forces art regeneration; also writes `docs/assets/icons_preview.png` |
| `make_splash.py` | PNG -> `main/Assets/SplashLogo.h` (64-color PNG composed over THEME_BG, drawn with `drawPng`) | default source is `Documentation/assets/celeros_logo.png`; `--colors N` |
| `size_report.py` | image size vs OTA slot per board, top libraries, deltas | `--baseline f.json`, `--save-baseline f.json`, `--min-free-kb 64` (exit 1 when a slot is tighter); run in the IDF env after building `build/` + `build-cyd/` |
| `sdkconfig_check.py` | drift of each `build*/sdkconfig` against `sdkconfig.defaults` + `boards/<b>/sdkconfig.defaults` (IDF never applies a changed default to an existing sdkconfig); keys the IDF no longer knows are warnings | `python3 tools/sdkconfig_check.py [build-dog ...]` (exit 1 on drift; fix by deleting the build's sdkconfig) |

## CONVENTIONS
- The generators are manual steps, not part of `idf.py build`. Commit their outputs (`data/icons/`, `SplashLogo.h`).
- `celerctl` defaults to the UART (CH340, `/dev/ttyUSB0`) through SerialLink. On boards built with `CELEROS_USB_NATIVE` (watch) it talks to CDC1 instead; on `CELEROS_LINK_ON_USJ` boards (dog) it shares the USB-Serial/JTAG with the console. With WiFi up it also speaks HostLink over TCP (`CELEROS_DEBUG_BRIDGE`, port 5555; token AUTH + UDP discovery — see README_USBTOOL "Celer Debug Bridge"). `-b` sets the baud (warning-only on USB-native ports, no-op on TCP).
- Bridge tokens (`~/.config/celerctl/tokens.json`) are cached by address AND by device identity: the banner/probe carry the board MAC (`DebugBridge.cpp` `macId`, pre-AUTH) as `id:<mac>` keys, so DHCP IP changes self-heal (auth retries the identity token and re-keys; `devices` marks `(pareado)` and heals the cache during listing). Firmware without the id field just skips the matching. `pair` also accepts `-p`. Serial probes run under a watchdog: a UART stuck in `open()` (board replugged mid-scan) is reported and skipped, never hangs `devices`.
- The littlefs size is read from `partitions_{16MB,4MB,32MB}.csv`, which is the single source of truth. Never duplicate it in scripts.
- CLI help and output text are Portuguese.

## COMMON FLOWS
```bash
pip install -r tools/requirements.txt                        # pyserial only; make_icons also needs Pillow (not listed)
python3 tools/celerctl.py apps install "data/apps/Settings"  # push one app without reflashing littlefs (linta antes)
python3 tools/celerctl.py apps install hub_apps/Arrasa --deps-local  # deps do repo antes do publish-dep
python3 tools/celerctl.py ota push build/CelerOS.bin         # firmware over serial, no esptool
python3 tools/celerctl.py pair 192.168.0.50                  # WiFi bridge: token uma vez (device shell: bridge)
python3 tools/celerctl.py -p 192.168.0.50 ota push build-x/CelerOS.bin  # OTA over the air
python3 tools/celerctl.py logcat --dump                      # device log ring buffer
python3 tools/celerctl.py dev hub_apps/Breakout              # dev loop: watch + lint + push + exit/run + logs ao vivo
python3 tools/celerctl.py apps pull Breakout                 # backup de um app instalado
python3 tools/celerhub.py list                               # local vs hub versions
python3 tools/celerhub.py deps-status                         # drift tools/sdk/engine x hub (exit 1)
node tools/sdk/celer.js new MeuApp                           # scaffold (app.json + main.js + icon + celer.d.ts p/ IDE)
node tools/sdk/celer.js emu hub_apps/Snake                   # emulador headless: roda e salva tela PNG 240x320
node tools/sdk/celer.js emu hub_apps/Snake --serve --open     # preview ao vivo no navegador (toque/teclado/hot reload)
node tools/sdk/celer.js emu hub_apps/Snake --gif jogo.gif --ms 3000 --seed 7  # GIF animado determinista
node tools/sdk/celer.js types                                # regenera celer.d.ts (apos mudar a API do firmware)
node tools/sdk/celer.js check                                # drift: docs x stubs x types x renderer
node tools/app_lint/lint.js "data/apps/Settings"             # linta um app (parse ES5 + API do firmware)
```

## ANTI-PATTERNS
- Replacing icon art by editing `data/icons/` directly. Delete `icons_src/<id>.png` and/or edit `icons.json`, then rerun `make_icons.py`. A hand-made 512px PNG in `icons_src/` is respected.
- Committing `__pycache__/`.
- Running `celerctl` while `idf.py monitor` holds the same port.
