# Tools

**English** | [Português (BR)](/maikramer/CelerOS/wiki/Ferramentas)

Host-side utilities (Python/shell) in [tools/](tools). Install with
`pip install -r tools/requirements.txt` (pyserial; `make_icons` also needs
Pillow, which is not in the list).

| Tool | Role |
|---|---|
| [celerctl.py](tools/celerctl.py) | HostLink client: device control over serial — full reference in [celerctl (USB)](/maikramer/CelerOS/wiki/celerctl-USB) |
| [flash_data.sh](tools/flash_data.sh) | Builds the LittleFS image from `data/` and flashes the `littlefs` partition |
| [ota_server.py](tools/ota_server.py) | Local server of `update.json` + firmware for OTA tests |
| [celerhub.py](tools/celerhub.py) | Publishes/lists/removes apps on the hub (validates app folders; token via args/env; `--hub` or `CELER_HUB`, default `https://os.celer.tec.br`) |
| [sdk/celer.js](tools/sdk/celer.js) | App SDK: scaffold, lint, editor typings, headless emulator and store publishing (Node, zero npm deps) |
| [make_icons.py](tools/make_icons.py) | `icons.json` → `icons_src/*.png` (512 px) → `data/icons/*.png` (64 px, dithered RGB565) |
| [make_splash.py](tools/make_splash.py) | PNG → `main/Assets/SplashLogo.h` (RGB565 over THEME_BG) |

## celerctl — the everyday swiss knife

```bash
python3 tools/celerctl.py devices            # list devices
python3 tools/celerctl.py shell              # interactive shell on the device
python3 tools/celerctl.py push main.js /local/apps/MyApp/main.js
python3 tools/celerctl.py logcat --dump      # log ring buffer (repeatable; --ts/--grep)
python3 tools/celerctl.py top -w             # profiling: per-task CPU%, heap, app, fps
python3 tools/celerctl.py stats --json       # one profiling snapshot (raw JSON)
python3 tools/celerctl.py debug MyApp        # JS debugger: breakpoints/step/eval
python3 tools/celerctl.py ota push build/CelerOS.bin   # firmware over serial
python3 tools/celerctl.py screencap out.png  # framebuffer capture
python3 tools/celerctl.py tap 120 160        # inject a touch
```

It talks over the console UART (CH340, `/dev/ttyUSB0`; `-b` changes the
baud) — over CDC1 on boards with `CELEROS_USB_NATIVE` (watch) and over the
USB-Serial/JTAG itself on `CELEROS_LINK_ON_USJ` boards (dog). With a
proto-2 firmware every frame carries a CRC32 and transfers use a sliding
window (negotiated in the HELLO; old firmware stays on the legacy path —
see `tools/README_USBTOOL.md`). Multiple boards: `-p` accepts the USB
serial prefix shown by `devices`. The opcodes live in
`main/USBDevice/HostLink.h` and the tool parses that file with a regex:
one source of truth for both sides. Do not run `celerctl` while
`idf.py monitor` holds the same port.

### WiFi bridge (Celer Debug Bridge)

Boards on WiFi expose the same HostLink over TCP (port 5555):
`-p 192.168.0.50` (or `IP:5555`) and `celerctl devices` finds them by a
UDP probe — no cable needed for anything, including
`ota push build/CelerOS.bin`. The first connection authenticates with the
device's bridge token (`celerctl pair IP`, or read it over USB with
`celerctl info` / shell `bridge`); it is then cached in
`~/.config/celerctl/tokens.json`. The bridge banner carries a stable
device id (MAC) and the cache keeps tokens by address **and** by
identity: when DHCP hands the board a new IP, the stored identity token
re-authenticates it and the cache heals itself (`devices` marks such
boards as `(paired)`) — USB recovery is only needed for a never-paired
device or after a `bridge reset`.

### The device shell

The same dispatcher answers the interactive console (`celerctl shell`)
and one-shot `celerctl shell "<cmd>"` (the HostLink EXEC opcode). It
carries the everyday Unix vocabulary; paths resolve against a current
directory (`cd`/`pwd`) and stay jailed to `/local` and `/sd`:

```text
files   ls  cat  head  tail  wc  grep [-inv]  find [-name P] [-type f|d]
        cp [-r]  mv  rm [-r]  mkdir  rmdir  touch  echo [-n]
        du  stat  xxd  md5sum  df
system  free  ps  top [ms]  uptime  date  uname  dmesg [n]  clear  info
apps    apps  run  exit  grant  rescan  wifi  lasterror  debug  bridge
```

Commands chain with `;` and output redirects with `>` / `>>`
(`echo nota > /local/x.txt`). There is no quoting: `;`, `>` and `>>` act
on redirection only as standalone words, and arguments never carry
quotes — send compact lines.

`sh [-e] [-x] script.sh` runs a reduced script interpreter: one command
per line, `#` full-line comments, `-e` stops at the first failing
command, `-x` traces each line. Scripts have blocks and variables:

```text
set I=0
while [ $I -lt 3 ]
  echo volta $I
  set I=$I + 1        # integer arithmetic in the value: N + 1
end
if [ -f /local/x.txt ]
  cat /local/x.txt
else
  echo ausente
end
```

Conditions are commands run silently (exit code 0 = true), usually the
`[` / `test` builtin: `a = b`, `a != b`, `-eq -ne -lt -le -gt -ge`
(integers), `-e/-f/-d` (paths, jailed to `/local`+`/sd`), `-z/-n`.
`if COND / else / end`, `while COND / end` (capped at 65535 iterations),
`break`/`continue`. `set VAR=val` stores, `set` lists, `unset VAR`
removes; `$VAR`, `${VAR}` and `$?` (last exit code) expand anywhere —
including in a `while` condition, re-evaluated each round.

`logcat --dump` copies the ring buffer without draining it (repeatable);
`--ts` prefixes host-side timestamps and `--grep` filters lines on the
host. Every app error is persisted to `/local/lastcrash.txt` (OS version,
date, uptime, app + full stack) and survives a reboot — the serial shell's
`lasterror` reports its size and write time; the web file manager reads the
file.

`top` is the profiling view: per-task CPU% measured over a sampling window
(two snapshots; `--sort cpu|stack|name`, `-n` limits rows, `-w` refreshes
like the classic `top`), heap internals/PSRAM (free/min/largest block),
watermark of free stack per task, live Duktape allocation count, the JS
app's heap usage since launch, OS-loop busy% and the app's real fps/present
cost. Rates are computed host-side from cumulative counters (the device
stays stateless); on a dual-core chip per-task CPU sums to ~200%. `stats`
prints a single snapshot with since-boot rates (`--json` for the raw
payload). The serial shell has the same view as `top [ms]` for
hardware-only sessions. Requires firmware with the `KL_STATS` opcode —
older firmware answers with an upgrade hint.

`celerctl debug MyApp` (boards with `CONFIG_CELEROS_JS_DEBUGGER`, default
on the ESP32-S3 targets) brings up a TCP proxy and the Duktape debugger
REPL: the app pauses on attach (first line) and at the throw of an
uncaught error, with breakpoints, stepping, eval, watches and `r`
(restart, rereading `main.js` and keeping breakpoints). Full reference in
[`tools/README_USBTOOL.md`](tools/README_USBTOOL.md).

## celerhub — publishing to the hub

```bash
python3 tools/celerhub.py list               # local versions vs hub
python3 tools/celerhub.py publish hub_apps/2048
```

## celer.js — the app SDK

```bash
node tools/sdk/celer.js new MeuApp      # scaffold: app.json + main.js + icon + editor typings
node tools/sdk/celer.js lint MeuApp     # ES5 + API check against the real firmware manifest (app_lint)
node tools/sdk/celer.js test MeuApp     # runs the app in the Node harness (stubbed device APIs)
node tools/sdk/celer.js emu MeuApp --frames "0,600,1500"   # emulator: PNG per clock mark + pixel diff
python3 tools/celerctl.py dev MeuApp    # live on the device (push + relaunch)
node tools/sdk/celer.js publish MeuApp  # publishes to the hub store
```

`lint`/`check` delegate to `tools/app_lint` (the manifest is derived from the
firmware source, so the linter knows the real API surface); `dev`/`publish`
delegate to `celerctl`/`celerhub`. `emu` runs the app headlessly and
snapshots the screen to PNG; with `--frames "0,600,1500"` it renders one
PNG per clock mark (`tela-0000.png`, ..., in the app's `.dev/` folder) and
prints the pixel diff between consecutive frames. Zero npm dependencies —
acorn is vendored and the PNG encoder uses Node's zlib.

## Flashing without a toolchain — CelerOS Flasher

Every `v*` tag publishes, on
[GitHub Releases](https://github.com/maikramer/CelerOS/releases):

* one zip per board — firmware + LittleFS image + `flash.json` (the flash
  plan), plus a `README.txt` with the equivalent `esptool` command line if
  you'd rather flash manually;
* the **CelerOS Flasher**, a GUI flasher for Linux and Windows with esptool
  embedded — download it plus your board's zip into the same folder, pick the
  board, plug the device, flash. No ESP-IDF install needed.

## Asset generators

`make_icons.py` and `make_splash.py` are manual steps (not part of
`idf.py build`); their outputs are committed (`data/icons/`,
`SplashLogo.h`).

To change an icon's art: edit `tools/icons.json` and/or delete
`icons_src/<id>.png` and run `make_icons.py --regen` — never edit
`data/icons/*.png` by hand (a hand-made 512 px PNG in `icons_src/` is
respected as is).
