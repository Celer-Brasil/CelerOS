# celerctl — CelerOS USB/serial/WiFi companion tool (adb-style)

**English** | [Português (BR)](README_USBTOOL.pt-BR.md)

`celerctl.py` talks to the firmware over the **HostLink** channel: a light
binary protocol that runs on the console UART — in practice, the CH340 that
the PC sees as `/dev/ttyUSB*` — on CDC1 of native USB (`CONFIG_CELEROS_USB_NATIVE`,
e.g. the Waveshare watch), on the S3 USB-Serial/JTAG itself
(`CONFIG_CELEROS_LINK_ON_USJ`, e.g. the SpotPear dog) or over **TCP/WiFi**
(the Celer Debug Bridge — `-p 192.168.x.y`). One tool, every board, cable or not.

## Wire protocol (proto 1 and 2)

```
proto 1: [0x43 'C'][cmd u8][len u16 LE][payload]
proto 2: [0x43 'C'][cmd u8][len u16 LE][crc32 u32][payload]
```

The session format is negotiated in the HELLO: the tool sends payload
`"CELERCTL2"` and a proto-2 firmware answers `...|proto 2|chunk W|win K`,
activating CRC32 on every frame plus the sliding window for chunks. Old
firmware answers `proto 1` and the session stays exactly as before — new
tool works with old firmware and vice versa (`--proto 1` forces the legacy
path on purpose). CRC32 is the classic 0xEDB88320 (same value as Python's
`zlib.crc32`).

Proto 2 extras on the wire:

- `WRITE_CHUNK`/`OTA_CHUNK` payload is `[seq u16][data]`; the ACK is
  `[next seq u16][total applied u32]` — a re-sent chunk whose ACK was lost
  is **not** written twice, and the final CRC/size check covers the whole
  file/image end-to-end (a corrupted OTA never reaches the boot slot).
- `READ` responses are prefixed with the offset, so pulls are pipelined.
- `LS` accepts a cursor (huge directories paginate), `DELETE` accepts a
  recursive flag, `COREDUMP` accepts a keep flag.

The opcodes live in `main/USBDevice/HostLink.h` (framing itself in
`HostFrame.h`, unit-tested on the host) and the tool parses that file with
a regex: single source of truth for both sides. `test/test_celerctl.py`
exercises the tool against a simulated device (lost chunk, corrupted byte,
legacy mode).

## Install

```bash
pip install -r tools/requirements.txt   # pyserial (screencap needs Pillow)
```

## Commands

```bash
python3 tools/celerctl.py devices            # list connected boards (USB + WiFi)
python3 tools/celerctl.py pair 192.168.0.50  # pair a WiFi bridge once (token)
python3 tools/celerctl.py provision --wifi MyNet secret --grant "Dog Face"   # WiFi + token + permissions, once
python3 tools/celerctl.py info               # version/board/heap/network/FS
python3 tools/celerctl.py shell              # interactive shell (help)
python3 tools/celerctl.py shell "ls /local"  # run and print
python3 tools/celerctl.py ls -l /local/apps
python3 tools/celerctl.py cat /local/wifi.txt
python3 tools/celerctl.py cat /local/log/kern.log   # persistent kernel log (also apps.log)
python3 tools/celerctl.py push app.zip /local/tmp_download/app.zip
python3 tools/celerctl.py pull /local/apps/HTTP\ Demo/app.json .
python3 tools/celerctl.py rm /local/old.txt
python3 tools/celerctl.py rm -r /local/apps/OldApp   # recursive delete
python3 tools/celerctl.py reboot
python3 tools/celerctl.py logcat             # live logs (Ctrl-C to exit)
python3 tools/celerctl.py top                # profiling snapshot: per-task CPU%, stack, heap
python3 tools/celerctl.py top -w --sort cpu  # live like classic top (Ctrl-C to exit)
python3 tools/celerctl.py stats --json       # one raw JSON snapshot (rates since boot)
python3 tools/celerctl.py ota push build/CelerOS.bin   # firmware without esptool
python3 tools/celerctl.py screencap shot.png # display capture -> PNG (RLE: ~10x faster)
python3 tools/celerctl.py coredump            # last crash dump (ELF) -> coredump.elf
python3 tools/celerctl.py coredump --keep     # download without erasing the dump
python3 tools/celerctl.py shell "run Snake"  # open an app (folder, name or package)
python3 tools/celerctl.py tap 120 160        # inject a tap (navigate over USB)
python3 tools/celerctl.py swipe 120 400 120 40  # inject a drag (scroll)
python3 tools/celerctl.py apps list             # installed apps (local + sd)
python3 tools/celerctl.py apps install "data/apps/Web Server"  # install folder
python3 tools/celerctl.py apps install myapp --sd              # to the SD card
python3 tools/celerctl.py apps rm "Touch Test"                 # uninstall
python3 tools/celerctl.py apps run "App Store"  # open an installed app (exit + run)
python3 tools/celerctl.py apps deps             # shared deps cache: usage + orphans
python3 tools/celerctl.py apps deps --gc --yes  # remove orphan dep versions from /local/modules
```

### Multiple boards on the same machine

`-p` accepts a port path **or the prefix of the board's USB serial** (the
`K...` MAC-derived serial that S3 firmwares expose). `devices` lists them:

```bash
python3 tools/celerctl.py devices          # shows serial per board
python3 tools/celerctl.py -p K7B4 screencap dog.png
```

With two or more boards plugged and no `-p`, the tool refuses to guess
(listing the ports) instead of silently picking the first one.

### Shared deps cache (`/local/modules`)

Apps with `deps` in app.json install their dependencies in the public
cache `/local/modules/<name>/<version>/` — shared by every app. Old
versions accumulate forever; `apps deps` cross-references the cache with
each installed app's `deps.json` and marks orphans (and deps an app
expects but that are missing from the cache). Every `apps install` (and
the `dev` reload loop) now verifies each written file — app files, hub
deps and `deps.json` — by reading it back (crc32): a "push ghost" (old
LittleFS inode still being served) fails right there with the recovery
recipe instead of breaking the app at runtime.

### Iterating on the UI without touching the board

`tap`/`swipe` + `screencap` form an adb-like loop: the gesture is queued in
the firmware (opcode `KL_TOUCH`), executed by the UI's TouchPump as if it
were a physical finger — it works for the Navigator and for modals (QWERTY
keyboard) — and `screencap` reads the real framebuffer. Sample session:

```bash
python3 tools/celerctl.py tap 360 88 && python3 tools/celerctl.py screencap s.png
```

### Debugging JS apps (breakpoints, step, eval)

Boards built with `CONFIG_CELEROS_JS_DEBUGGER` (default on the S3 boards;
off on the CYD, where the OTA slot and RAM are tight) speak the Duktape
debugger protocol over the same channel (`KL_DEBUG_CTL`/`KL_DEBUG_DATA`):

```bash
python3 tools/celerctl.py debug Snake          # proxy + REPL in this terminal, app logs included
python3 tools/celerctl.py debug Snake --serve  # proxy only (dmsg on :9092, logs on :9093)
node tools/debug/dbg.js                        #   ...and the REPL in another terminal
```

The app pauses when the debugger attaches (on its first line; without an app
name, the running app attaches on its next yield), and an uncaught error
pauses at the throw. `h` lists the commands: breakpoints (`b 42 if x > 3`,
`tb`, `u <line>`, `B`, `d`, `cond`), `c`/`p` (or Ctrl-C), `s`/`n`/`o`,
inspection with objects rendered as JSON on the device (`v`, `e`, `lc`, `cs`,
`up`/`down`, `set`), watches (`w`), `l` (local source), `i` (heap) and `r`:
lint + push the edited local app folder, then restart it with the breakpoints
restored. Stdin may be a script: every command waits for its reply, and
`c`/`s`/`n`/`o` wait for the next pause.

Robustness rules: the handshake is one-way (the device sends the version
line; the client must not write before it); `q`, closing the client, killing
the proxy (even `kill -9`: the device drops the client when the host session
idles out after 8s) or pulling the cable all detach and the app keeps
running. Protocol and client are covered on the host by
`node test/debug/run.js` (fake Duktape target).

## WiFi: the Celer Debug Bridge (`-p IP`)

Every board on WiFi speaks the **same HostLink protocol over TCP** — the
Celer Debug Bridge (`main/USBDevice/DebugBridge.cpp`, Kconfig
`CELEROS_DEBUG_BRIDGE`, default on; port 5555 for TCP and UDP, configurable).
It comes up with the WiFi STA connection (and re-listens by itself after a
reconnect), accepts **one client at a time** and hands the connection to a
new HELLO exactly like a USB channel would. The watch keeps the radio on
while a bridge session is active (PowerPolicy defers the idle WiFi-off).

The connection is authenticated: after TCP connect the device sends
`CELERBRIDGE 1 <board> <ip> <port>` and expects `AUTH <token>` (15 s window,
3 wrong attempts close the socket); from the `OK` on, the socket is a pure
HostLink pipe. The token lives in NVS (generated once) — read it on the
device with the shell `bridge` command (or `celerctl info`, field
`bridge.token`) and pair once:

```bash
python3 tools/celerctl.py pair 192.168.0.50        # asks for the token, saves it
python3 tools/celerctl.py -p 192.168.0.50 info     # from now on: no cable
python3 tools/celerctl.py -p 192.168.0.50 logcat
python3 tools/celerctl.py -p 192.168.0.50 ota push build-x/CelerOS.bin  # OTA over the air
python3 tools/celerctl.py -p 192.168.0.50 dev hub_apps/Celer Remote
```

Token resolution order: `--token`, env `CELEROS_BRIDGE_TOKEN`, the
`celerctl pair` cache (`~/.config/celerctl/tokens.json`), then a prompt.
`bridge reset` (device shell) rotates the token; `bridge set <token>`
writes a token of your choosing (the automation path — see `provision`).
Everything works over the
bridge — shell, push/pull, logcat, `debug` (the local proxy select()s the
socket directly), screencap/tap/swipe, `apps` and `dev`. Throughput is WiFi
bound (no baud to negotiate: `-b` is a no-op).

### `provision` — first boot in one command

```bash
# over USB, on a fresh board: WiFi credentials + bridge token + app permissions
python3 tools/celerctl.py provision --wifi MyNet mysecret --grant "Dog Face"
# prints the address and leaves the token cached: from then on, no cable
python3 tools/celerctl.py -p 192.168.0.50 ota push build-x/CelerOS.bin
```

It runs on the open channel (USB on a fresh board): saves the Wi-Fi
credentials, writes a freshly generated bridge token (`bridge set`), grants
the listed app permissions (`grant <pkg|name>`), waits for the IP and saves
`ip:port -> token` in the `pair` cache — the `-p IP` form works immediately
after. On a board that already has Wi-Fi, drop `--wifi` and it provisions
just the token.

## Persistent logs (`/local/log`)

The log ring that `logcat` drains is RAM-only; since 1.7 the firmware also
keeps Linux-style persistent logs, rotated like logrotate
(`<name>.log.1` holds the previous generation):

* `/local/log/kern.log` — firmware (`ESP_LOG` I/W/E + internal prints)
* `/local/log/apps.log` — `System.print` from JS apps, prefixed by package
  (`[app:dogface]` — `logcat --grep app` keeps working)

With an SD card mounted the house moves to `/sd/log/` and the caps grow
(the LittleFS of SD-less boards is small: 8 KB per file). Read them from
the Terminal app (`dmesg`, `appslog`, `tail <file> [n]`) or from the host
(`celerctl cat /local/log/kern.log`) — they survive reboots, which is the
point: the trace of "what did it say before it died" is there after the
fact.

`celerctl devices` also discovers boards on the LAN: a `CELERPROBE1` UDP
broadcast on port 5555, answered unicast with the same version line the
HELLO carries (no token needed — it's the same public info). On networks
with AP/client isolation the broadcast won't pass: use `-p IP` directly.

## Speeding up transfers (-b)

The UART channel starts at 115200 baud. With `-b 921600` the tool negotiates the
switch with the firmware and reopens the port faster:

```bash
python3 tools/celerctl.py -b 921600 push firmware.bin /sd/fw.bin
```

Measured with proto 2 (sliding window + CRC32; firmware 1.4.1, 1 MB file
with an md5 check on the way back): push ~78 KB/s on the S3 UART at
921600 baud (`-b 921600` — without it the push stays at ~11 KB/s on the
default 115200), ~113 KB/s on the dog's USJ and ~110 KB/s on the watch's
CDC; pull verified intact on all three. Proto 1 (stop-and-wait, for
comparison): push ~57 KB/s, pull ~190 KB/s. Window announced by the
firmware: 4 chunks on the S3 UARTs/USJ (48 KB RX ring), 1 on the CYD (no
PSRAM to hold a window), 8 on CDC. USB-native ports (CDC/USJ) have no
baud: `-b` prints a warning and continues at USB speed.

The window the firmware announces is the one its own channel can hold.
To OTA-update an OLDER firmware whose announced window overflows its RX
buffer (e.g. a watch from before the CDC buffer fix, announcing 8), cap
it by hand:

```bash
python3 tools/celerctl.py --win 2 -p <port> ota push CelerOS.bin
```

## How the channel coexists with the console

The console UART multiplexes two modes (`main/USBDevice/SerialLink.cpp`) —
the same scheme runs on the USB-Serial/JTAG when `CELEROS_LINK_ON_USJ` is
on:

- **console** — human interactive shell (echo, `celer> ` prompt) and
  visible ESP_LOG/Serial logs. Open minicom/monitor and use it.
- **link** — triggered by the arrival of a HELLO frame (`0x43 0x01 ...`);
  human typing never produces that sequence. Logs are suspended on the UART
  (keystrokes go into a ring) and the session returns to console mode
  after ~8 s without frames, restoring the baud rate. Opening a session in
  another channel (e.g. CDC1) takes over as the active one.

With `logcat`, the ring is drained (history since boot) and logs keep
flowing as live frames inside the tool itself — on the active channel
(UART or CDC).

## Note on native USB / Mass Storage

The ESP32-S3 has USB-OTG (GPIO19/20), but **on the SmartDisplay 4848S040
those pins are used by the board** (GPIO19 = GT911 touch SDA, GPIO20 = RGB
display G1 line) and the USB connector is CH340 only. That is why HostLink
runs on the UART and USB Mass Storage is not possible on these boards.

The native USB code (dual CDC via TinyUSB, `main/USBDevice/USBDevice.cpp`)
is live on the Waveshare watch (`CONFIG_CELEROS_USB_NATIVE`: CDC0 shell +
CDC1 celerctl) and dormant for boards whose GPIO19/20 become free. The
SpotPear dog takes the third road: its only USB is the USB-Serial/JTAG, so
`CONFIG_CELEROS_LINK_ON_USJ` multiplexes console+link on that same port —
no console/OpenOCD/esptool sacrifice.

## Recursos da matilha pelo cabo (Onda B, API 39)

O computador fala o MESMO protocolo de recursos da matilha pelo canal
celerctl (qualquer transporte: UART, CDC nativo, USJ ou bridge TCP) — é o
gateway USB do design (Documentation/CelerNet_Design.pt-BR.md §8). O PC é
um cliente com node id sintético; a policy é a de sempre por tipo, com o
master `res_share_usb` (default "0": ligue com `celerctl shell "cfg
res_share_usb 1"`). A sessão vive enquanto o celerctl estiver de pé: caiu
o cabo (ou 8 s de idle na UART), os leases morrem e o auto-off do relé
age como para qualquer cliente.

```
celerctl res ls                       # identidade + locais + catálogo da malha
celerctl res relay rele1 on|off|state # aciona um relé local (--segura N segura a sessão)
celerctl res sensor lum 1000 20       # assina amostras (rate ms, duração s)
celerctl res open "rele1" '{"off":1}' # abre cru (opts = o schema do catálogo)
celerctl res write <sid> '\x01\x01'  # DATA cru (ops do gpio)
celerctl res read <sid>               # espera um RES_DATA da sessão
celerctl res close <sid>              # fecha (auto-off se o OPEN pediu)
```

### Entrar na matilha pelo cabo (API 40)

O cabo é a terceira porta da matilha (as outras: `Pack.join` no app e o
convite selado pelo CelerLink). Mesma derivação de chave do `mesh join` do
shell; é ato de dono (cabo na mão), não depende do `res_share_usb`. A chave
nunca volta ao PC. Serve para as placas sem tela (devkit, esp32-cam).

```
celerctl mesh join bancada            # pergunta a senha (8 a 64 bytes)
celerctl mesh join bancada 'senha'    # ou na linha
celerctl mesh status                  # matilha, id do gateway e o id do PC (FFxx)
celerctl mesh --json status
celerctl mesh leave                   # volta à rede aberta "celer"
```

Convite pelo cabo (o aparelho novo pode não ter tela; o código de 6 dígitos
só nasce quando o membro conecta, então o celerctl o lê pelo cabo do novo):

```
celerctl -p NOVO mesh accept                        # novo: abre a janela (10 min)
celerctl -p MEMBRO mesh invite Celer-AB3E --de NOVO # membro: conecta, le o codigo, manda a chave
celerctl -p MEMBRO mesh invite Celer-AB3E --codigo 123456   # ou o codigo da tela do novo
```

Peer já pareado antes (bond) entra sem código. Placas cujo adaptador USB
segura o EN/IO0 (esp32-cam no CH340 clone) falam com `--linhas-baixas` (ou
`CELEROS_LOW_LINES=1`).

### O PC como membro da matilha (API 41)

Com a sessão viva, `res_share_usb=1` e um comando que use a matilha
(`mesh send`, `mesh listen`, `res relay|snap|rec|play -n`), o gateway anuncia
o PC na malha como `pc-XXXX` (id `0xFF00 | byte baixo do gateway`). Os apps o veem em
`Pack.members()` e mandam `Pack.send("pc-XXXX", ...)`; o PC recebe e fala
pelo cabo. Recursos de OUTROS nós abrem por procuração: o gateway é o
cliente (retry, KEEP e reabertura de sempre) e o DATA do dono volta como
evento. Eventos chegam como `KL_RES_DATA` de sid 0 (`UsbRes.h`: `EV_MSG`,
`EV_STATE`, `EV_DATA`).

```
celerctl mesh listen 120              # o que a matilha manda ao PC
celerctl mesh send W '{"oi":1}'       # envelope do PC para o membro W (ou id, ou "gw")
celerctl res relay -n W rele1 on      # relé de OUTRO nó (procuração do gateway)
celerctl res relay -n BB02 rele1 state
```

Mídia de outros nós, por arquivo no gateway (o celerctl baixa/envia sozinho):

```
celerctl res snap -n qrnode foto.jpg [-q 12]   # foto da camera de outro no
celerctl res rec -n relogio 5 mic.wav          # 5 s do mic de outro no (WAV 16 kHz)
celerctl res play -n AB3E alerta.wav           # toca um WAV (ate 30 s) no speaker dele
```

O WAV de entrada pode ter qualquer taxa (8/16 bits, mono/estéreo): o
celerctl converte para PCM 16 kHz mono antes de mandar.
