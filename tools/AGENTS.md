# tools/ - host-side Python/shell/Node tooling

## OVERVIEW
Host utilities: device control over serial (`celerctl`), the JS app linter (`app_lint`), the LAN OTA test server, the hub publisher, data-partition flashing, and asset generators. It is a distinct domain (score ~9; own `requirements.txt`). Docs: `README_USBTOOL.md`, `README_OTA.md` (both also in `.pt-BR`).

## WHERE TO LOOK
| Tool | Role | Key usage |
|------|------|-----------|
| `celerctl.py` (2100+) | HostLink client (device side: `main/USBDevice/`). Two wire formats negotiated in the HELLO: proto 1 (legacy, byte-identical to the old days) and proto 2 (CRC32 on every frame, sliding window on WRITE/OTA chunks, offset-tagged pipelined READ, paginated LS, recursive DELETE); `--proto 1` forces legacy. Third transport: the **Celer Debug Bridge** over TCP/WiFi (`-p IP` — banner+token AUTH in `NetTransport`, discovery by UDP broadcast). Own tests: `python3 test/test_celerctl.py` (FakeDevice + FakeBridge loopback, no hardware; runs in CI) | `devices [-l]` (USB serial + WiFi IPs), `pair IP [--token T]` (stores the bridge token in `~/.config/celerctl/tokens.json`), `-p PORT\|SERIAL-PREFIX\|IP`, `info`, `top [-w] [--sort cpu\|stack\|name]` + `stats [--json]` (profiling KL_STATS 0x20: per-task CPU%/stack watermark via deltas host-side, heap/PSRAM, JS app usage, fps; device shell has `top [ms]` too), `shell [cmd]`, `ls/cat/rm [-r]/mkdir/mv`, `push`, `pull`, `reboot`, `logcat [--dump]`, `ota push FW.bin [--no-reboot]`, `coredump [--keep]`, `debug [App] [--serve]` (Duktape debugger: proxy + REPL `tools/debug/dbg.js`, protocol in `debug/dmsg.js`; host tests `test/debug/run.js`), `screencap out.png`, `tap X Y [ms] [--finger N]`, `swipe X0 Y0 X1 Y1 [ms] [--finger N]`, `mtap X0,Y0 X1,Y1 [ms] [-v] [--glass WxH]` (two fingers at once — multitouch bench; needs the 8-byte KL_TOUCH sample, which the host only sends when a non-zero finger exists, so old firmware is unaffected), `apps list/install <dir> [--deps-local]/rm/run <name>/deps [--gc --yes]` (`--deps-local`: deps also from `tools/sdk/engine`, stripped like `publish-dep`, newest satisfying wins — test engine/physics on a board before publishing; `run`/`dev` accept the folder name too) (install verifies every written file by read-back crc32 — app files, hub deps in `/local/modules` and `deps.json`; `dev` reloads verify too, `--pula-verify` skips; 2+ boards without `-p` refuses to guess) |
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

## DEVICE DIAGNOSTICS (BENCH)
- The debug bridge accepts ONE celerctl session per target; the second gets `bridge ocupado por outra sessao celerctl`. `pgrep -af celerctl` before benching — parallel sessions (human + other agents) are routine here. `logcat` holds the bridge while it runs; to observe without holding it, read the persisted logs afterwards: `celerctl shell "cat /local/log/kern.log"` (uptime-stamped per boot; HttpClient logs EVERY request with status/bytes/ms — first stop for "app nao baixa") and `/local/log/apps.log` (`celerctl crash` summarizes the last app death). Mind the LogPersist flush: the on-disk file only gets lines when the window opens (screen blank, no audio, no SD scan — writing flash with the RGB panel lit scrambles the frame), so with the screen on `kern.log` LAGS by minutes; `logcat --dump` (ring) is the live view and `/local/notifications.txt` is written immediately.
- `celerctl debug --app <Nome> --eval "<expr>"` evaluates ONCE in the live app (pauses at global(), runs in app scope, resumes and exits). Blocking Net calls work inside the eval — use it to measure a real fetch on the device (e.g. `Net.download` of a hub file) instead of guessing from the PC.
- `screencap` takes the output path positionally (`screencap /tmp/t.png`; there is no `-o`). `tap X Y` uses PHYSICAL pixels of the glass (480x480 on the 4848; the footer "Recarregar catalogo" button sits at y≈451).
- Device shell has no flag-style arguments (`ls -la`, `tail -n` fail with "caminho invalido") — use `cat <path>` and filter on the host; `df /local` works; quotes are not parsed.
- LittleFS fills up silently on the bench (3.4 MB partition, dozens of test apps installed): `df /local` before installs/pushes. The App Store reload alone needs ~180 KB free (see data/AGENTS.md "HUB CATALOG").

## ANTI-PATTERNS
- Replacing icon art by editing `data/icons/` directly. Delete `icons_src/<id>.png` and/or edit `icons.json`, then rerun `make_icons.py`. A hand-made 512px PNG in `icons_src/` is respected.
- Committing `__pycache__/`.
- Running `celerctl` while `idf.py monitor` holds the same port.

## STORE PACKAGE + DEPLOY LIMITS (hub gate e bancada, 2026-10-18)
- O pacote do hub e **FLAT**: extras = arquivos na raiz do app apenas (≤16 arquivos, ≤256 KB no total, ≤128 KB cada; .js/.png/.wav/.qoa/.json/.bin/.sh). Subpastas (`assets/`) NUNCA sobem — arte de jogo vai na raiz (padrao `ai_atlas.png`/`ai_bg.png` gerado por text2d/texture2d, key magenta 0xF81F) e o `E.init({bases:[...]})` aponta para a raiz.
- Teto de tamanho: .js enxuto do app **+ modulos das deps** > 48 KB exige `requires: ["psram"]` (teto absoluto 1 MB); `app.json` aceita **no maximo 8 deps** — agrupe cerebro com `celeros.game.kit` (puxa `celeros.game.rpg` = stats+inv+script).
- Apps NAO-jogo tem a familia **CelerKit** (`celeros.app.*`) no mesmo dir: core com loop de telas/overlays + fmt/path/semver/data/history/net/caps/events/text/input/form/list/launch/ai/chat/updater/fsx/svc/mesh/kit. `celer.js new Nome --appkit` scafolta com o pacote `celeros.app.kit` (8 deps numa). Doc: `Documentation/App_Kit_Guide.md` (+pt-BR); gates em `test/sdk/celerosapp_r1.js`.
- `celerhub publish` so sobe arquivos COMMITADOS (arvore suja recusa) e o hub recusa downgrade de versao — suba `version` + changelog.
- A loja serve URLs **absolutas** (meta/app/icon) e o app.json publicado leva campos computados (`size`, `md5`, `published_at`, `publisher`, `zip`); `celerctl apps store` aceita os dois formatos e tira os campos antes do lint (`_hub_url`).
- `celerhub publish-dep` aceita no maximo **8 --dep** por dependencia (o kit virou world+combat+rpg+fsm+events+path+steer+sfx).
- Deploy em 4848 API 44+: o HostLink USB derruba push grande (`sem ACK`, `payload grande demais`) — prefira **WiFi** (`-p IP:5555`) e `--win 1`; segunda sessao celerctl no mesmo aparelho devolve `sessao ativa em outro canal` (pgrep antes; USB0=.160 e USB1=.134 sao OS MESMOS dois aparelhos — nunca rode os dois canais de um deles em paralelo).
- App grande demais para a flash: `apps store --sd` instala em `/sd/apps` (cartao FAT32; exFAT → `sd format`, ver boards/AGENTS.md). `apps deps --gc --yes` libera versoes orfas de /local/modules; `shell df /local` antes de instalacao grande (LittleFS 3.4 MB).
