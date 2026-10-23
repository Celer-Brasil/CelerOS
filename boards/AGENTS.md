# boards/ - per-board sdkconfig, data overlay and what makes each board different

## OVERVIEW
One directory per board holding its `sdkconfig.defaults`. Board code itself lives in `main/Boards/<board>/` (Board.cpp, BoardDisplay.h, BoardTraits.h — exactly one is compiled in); this tree is only configuration plus, on the watch, the factory-image overlay. The `-DCELEROS_BOARD=<b>` CMake cache variable selects the board (validated in `main/CMakeLists.txt`; anything else is FATAL_ERROR).

## THE EIGHT BOARDS
| Board | Chip / flash / RAM | Display & touch | Partitions | Notes |
|-------|--------------------|-----------------|------------|-------|
| `smartdisplay` | ESP32-S3 N16R8, 16MB QIO, PSRAM octal | Guition 4848S040 480x480 capacitive GT911 | `partitions_16MB.csv` | Default board. **Never** `CELEROS_USB_NATIVE` here (GPIO19 = touch I2C SDA, GPIO20 = RGB G1 lane; both denied to apps). Optional relay header (`CELEROS_SMARTDISPLAY_RELAYS`, Y SKU: L1/L2/L3 = 40/2/1 replace the NS4168 I2S) |
| `cyd` | ESP32 classic, 4MB, no PSRAM | CYD 2432S028R 320x240 resistive, landscape | `partitions_4MB.csv` | Unicore + IRAM-as-heap; OTA slot `0x190000` = **1.638.400 B** is THE size constraint of the project. USB via CH340 UART; microSD shares the TFT HSPI (CS=5) |
| `cyd-vspi` | ESP32 classic, 4MB, no PSRAM | CYD variant, display+touch on VSPI — **UNTESTED** (see `main/Boards/cyd-vspi/BoardDisplay.h`) | `partitions_4MB.csv` | Same budget rules as `cyd`; SD stays off (VSPI shared with display+touch, hardware not validated). Shares the `esp32` OTA channel with `cyd` |
| `spotpear-dog` | ESP32-S3R8, 16MB DIO, PSRAM octal | OLED SH1106 128x64 on I2C0 (SDA41/SCL42) | `partitions_16MB.csv` | Derived from smartdisplay. 4 servos + optional tail, I2S mic (4/5/6) and speaker (7/15/16), 2 WS2812 strips, battery divider (GPIO2). Dual-core. Console+celerctl on the USB-Serial/JTAG (`CELEROS_LINK_ON_USJ`, the only USB connector). Home app = Dog Face |
| `waveshare-watch` | ESP32-S3R8, 32MB DIO, PSRAM octal | Waveshare AMOLED 2.06" 410x502 round-ish, FT3168 capacitive | `partitions_32MB.csv` | The smartwatch. Native USB dual CDC (`CELEROS_USB_NATIVE`, CDC_COUNT=2, OTG on GPIO19/20), NimBLE (Celer Link + Phone Link/Gadgetbridge), PM/light-sleep (`PowerPolicy`), RTC PCF85063 + AXP2101 + QMI8658 IMU on I2C0 (14/15), `screenInset` for the rounded glass |
| `devkit` | ESP32 classic, 4MB, no PSRAM | **None** — stub panel that discards rendering (`main/Boards/devkit/BoardDisplay.h`); BOOT button (GPIO0) + single-channel LED (GPIO2) | `partitions_4MB.csv` | The barebone profile: `headless` (splash skipped, `getInfo().hasDisplay=false`/`shape:"headless"`) + `buttonToApp` (BOOT is app input via `System.button`, long = exit, launcher short relaunches homeApp). `CELEROS_UI=n` (the whole display stack leaves the binary). Same RAM budget as `cyd`; WiFi provisioned by the `wifi` shell command; factory image drops every drawing app via `data-exclude.txt` |
| `devkit-s3` | ESP32-S3 N16R8, 16MB QIO/80M, PSRAM octal 8MB | **None** — same stub panel; BOOT (GPIO0) + WS2812 on GPIO38 (v1.1+) | `partitions_16MB.csv` | The **USB Host** board (API 48): native USB-C (OTG, GPIO19/20) is host, console/celerctl stays on the UART0 USB-C ("UART"). `CELEROS_USB_HOST=y` + `espressif/usb` managed component; `CELEROS_USB_NATIVE`/`CELEROS_LINK_ON_USJ` OFF (the S3 OTG shares the PHY with USJ). Hub support on; `ESP_CONSOLE_SECONDARY_NONE` keeps USJ from stealing the PHY. Headless (`CELEROS_UI=n`), no SD/audio/mic/physics; factory overlay ships the `USB HID` service (keyboard/mouse → `Input.*`), the `Impressora` app (ESC/POS test page via the `celeros.usb.escpos` dep; Epson TM-T20X bench-validated) and the two CelerPark totems (see "CELERPARK TOTEMS" below). VBUS must come from the board (no GPIO switch) |
| `esp32-cam` | ESP32-S (classic) AI-Thinker, 4MB DIO, PSRAM quad 4MB | **None** — the "glass" is the OV2640 sensor | `partitions_4MB_cam.csv` | Camera node: `headless`, `CELEROS_UI=n`, **dual-core** (unicore reset-looped in INT_WDT with WiFi+NimBLE), NimBLE (CelerNet mesh), TLS buffers in PSRAM, microSD by SDSPI (CLK14/CMD15/D0-2/CS13 — apps live on the SD, hence the small littlefs/1.81MB slots). Bench: brownout is failure #1 (sturdy 5V supply); flash mode = GPIO0 to GND at reset; GPIO12 is the MTD strap (never an output); GPIO16/17 belong to the PSRAM |

## FEATURE MENU (what each board compiles in)
Hardware-coupled subsystems are Kconfig flags in `main/Kconfig.projbuild`; a board picks its set in `boards/<b>/sdkconfig.defaults`. Defaults: `y` for `CELEROS_AUDIO` (digital I2S audio: `playWav`/QOA, `playMusic` chiptune, `sfx`, the TTS `PcmFeed`), `CELEROS_JS_GPIO`, `CELEROS_WEB_SERVER`, `CELEROS_SD_CARD`, `CELEROS_JS_PHYSICS` (native verlet worlds — PSRAM money); `n` opt-in for `CELEROS_MIC` (capture I2S1 + `Mic` object: dog, watch), `CELEROS_JS_CAMERA` (esp32-cam), `CELEROS_WAKE_WORD` (dog; depends on MIC).

An off-flag keeps every JS contract: the implementation leaves the binary but inline stubs in `AudioPlayer.h` / `MusicSynth.h` / `BoardIO.h` answer with the documented no-hardware values (`playWav`/`playMusic` false, `sfx` 0, `musicPos` -1, `micLevel` -1, `speakerChannel` null), and whole JS objects disappear the documented way (`typeof Mic === "undefined"`; `System.verlet*` entries not registered — the physics dep feature-detects and falls back to interpreted `P.verlet`). `System.playTone` is NOT behind `CELEROS_AUDIO`: the analog LEDC tone (CYD speaker on GPIO26) and `toneAsync` beeps work on every board.

| Flag | smartdisplay | cyd | cyd-vspi | spotpear-dog | waveshare-watch | devkit | devkit-s3 | esp32-cam |
|------|----|-----|----------|----|-----|----|----|-----|
| `CELEROS_AUDIO` | y | — | — | y | y | — | — | — |
| `CELEROS_MIC` | — | — | — | y | y | — | — | — |
| `CELEROS_JS_PHYSICS` | y | — | — | y | y | — | — | — |
| `CELEROS_WEB_SERVER` | y | — | — | y | y | y | y | y |
| `CELEROS_SD_CARD` | y | y | — | y | y | — | — | y |
| `CELEROS_USB_HOST` | — | — | — | — | — | — | y | — |

(— = off in that board's defaults.) The **CYD lite profile** (audio + mic + physics + web server off) took the esp32 OTA slot from **38 KB to 90 KB free** (image 1.599.024 → 1.545.344 B; libmain -47,5 KB, esp_http_server out) and bought the uniform 64KB CI gate back — the 12 KB CYD exception in `build.yml` is gone. CYD and cyd-vspi share the `esp32` OTA channel, so both carry the same lite set. esp32-cam also drops all three even though it has PSRAM: no glass means no game, and its slot sits at 108 KB free with the camera driver (its `Pack`/mesh code compiles fine against the audio stubs — a mesh node never lends what it doesn't have). smartdisplay keeps audio but drops `CELEROS_MIC` (no mic hardware; -6,5 KB).

## PER-BOARD FACTORY IMAGE
`tools/flash_data.sh <board>` stages `data/` and then:
1. **overlays** `boards/<board>/data/` on top — the watch adds Timer/Clima/Musica/Alarmes/Celular/Atividade; the dog adds Dog Face (its `homeApp`), and
2. **excludes** paths listed in `boards/<board>/data-exclude.txt` (one per line, relative to `data/`; `#` comments) — the watch drops Terminal, HTTP Demo, Touch Test and Web Server (tight littlefs, keyboard-centric apps); the headless boards (`devkit`, `devkit-s3`, `esp32-cam`) drop every app that draws plus `icons/`, because `CELEROS_UI=n` removes `System.draw*`/`UI`/`Keypad`/`prompt` from the firmware — the image keeps only Barebone, the headless reference (plus, on devkit-s3, the board overlay with the `USB HID` service, `Impressora` and the CelerPark totems).

Partition size comes from the CSV picked above (single source of truth). New board with a data overlay: add the case to `flash_data.sh` and the overlay dir; the repo-wide app lint already globs `boards/*/data/apps` automatically. `flash_data.sh` currently accepts seven names (`smartdisplay cyd spotpear-dog waveshare-watch devkit devkit-s3 esp32-cam`) — `cyd-vspi` still has no case even though it shares the `cyd` 4MB image; add the case when that variant goes to the bench.

## CELERPARK TOTEMS (devkit-s3 overlay)
`boards/devkit-s3/data/apps/CelerPark Entrada` (celeros.park.entrada) and
`CelerPark Saida` (celeros.park.saida) are the CelerPark parking migration
(the Rust agent lives in `GitClones/CelerPark`): one board per totem, both
flashed with the same factory image — `autostart.txt` picks which program
runs. Both are headless (logcat is the UI), share the vendored `celerpark.js`
core (Supabase edge function `parking-gate`, CP1-ULID tickets, JSON outbox,
relay pulse) and vendor their `celeros.usb.*` deps in the app folder (no hub
catalog entry; flash_data.sh ships them). **Source of truth lives in the
CelerPark repo** (`GitClones/CelerPark`, apps/ + README): the folders here
are the factory copies — update both on every change.

- **Entrada**: BOOT press → new CP1 ticket → `create_ticket` (offline → local
  outbox, flushed on reconnect) → ESC/POS ticket on the TM-T20X (exact bytes
  of the Rust `build_ticket`: WPC1252, native QR model 2/module 6/EC M, cut)
  → relay pulse. Cloud error that is not offline, or a dead printer, keeps
  the gate CLOSED (same order as the Rust `Session::entry`).
- **Saida**: the QR reader is a USB HID boot keyboard (`celeros.usb.hid`,
  claimed directly by the app — the `USB HID` service must stay OFF or they
  fight for the claim). Enter terminates the scan; `lookup_ticket` decides:
  paid → `mark_exited` + relay, issued/exited/void/unknown/offline → refusal
  in the log, gate closed.
- Config: `/local/celerpark.json` (model in `boards/devkit-s3/celerpark.example.json`,
  never committed with secrets; keys come from ProjetoCursor `env/secrets.env`
  + `GlobalSettings`). Relay default GPIO4 (open) — free pins on the DevKitC-1
  are 1..18/21..23/38..42/47/48 (19/20 USB, 26..37 flash/PSRAM, 43/44 UART0).
- Bench bring-up per totem: `wifi` shell command, `celerctl push celerpark.json
  /local/celerpark.json`, `grant <app>` (headless consent), autostart.txt with
  the packageName. The whole flow (ticket bytes, outbox, refusals, portal
  commands, apikey/Bearer headers) is exercised in `test/js_harness/run.js`
  against the fake cloud.

## USB HOST (devkit-s3)
`CELEROS_USB_HOST=y` instala a pilha **USB Host** do IDF (componente gerenciado `espressif/usb` ^1.6.0 — no IDF 6.x ela saiu do tree) e liga o core `main/USBHost/` + as bindings `USB.*`/`Input.*` (API 48). Regras que a bancada custa caro:

- **Um controlador OTG, um papel.** No S3 o USB-OTG e a USB-Serial/JTAG compartilham o PHY interno (GPIO19/20). Com o host instalado a USJ deixa de existir: o console/celerctl TEM de ficar na UART0 (conector "UART") e `CELEROS_USB_NATIVE`/`CELEROS_LINK_ON_USJ` ficam desligados. O Kconfig já impede a combinação.
- **VBUS nao e chaveado por software.** O DevKitC-1 energiza o conector, mas nao ha GPIO de load switch no perfil; dispositivos que puxam mais que a placa oferece pedem hub alimentado. **Pegadinha da bancada (2026-10-22):** no DevKitC-1 (e clones de 2 USB-C com bridge CH34x) a porta "USB" NAO recebe 5 V quando a placa e alimentada pela porta "COM" — ha um jumper/solda **USB-OTG** no verso da placa que liga o trilho 5V ao VBUS da porta USB. Sem esse jumper o host instala, fica `devices=0` e nenhum device enumera. Diagnostico no shell: `usb` (host/devices/clients/suspended + registry), `usb power` (power-cycle do root port) e `usb resume`.
- **Hub externo:** `CONFIG_USB_HOST_HUBS_SUPPORTED` + `USB_HOST_HUB_MULTI_LEVEL` (custa ~10 KB de flash). Sem hub so da um dispositivo por vez.
- **Report descriptor HID inteiro:** `CONFIG_USB_HOST_CONTROL_TRANSFER_MAX_SIZE=2048` (o default 256 cortaria descritores > 248 B). O teto de uma transferencia JS e 4 KB; `USB.sendFile` faz streaming de arquivos.
- **Buffers de URB sao DMA interno.** No S3 `USB_HOST_DWC_DMA_CAP_MEMORY_IN_PSRAM` nao existe: cada transfer aloca via `usb_host_transfer_alloc` (RAM interna). Nao passe PSRAM para o host lib.
- **Sem driver de dispositivo no C++.** Impressora (ESC/POS), HID, MSC/FAT e qualquer protocolo proprietario sao deps JS (`celeros.usb.*`) sobre as transfers cruas. O core so enumera, abre descritores e executa control/bulk/interrupt.

## SDKCONFIG / STACK RECIPE (why each defaults file looks like it does)
Root `sdkconfig.defaults` holds the common recipe; `boards/<b>/sdkconfig.defaults` overrides per board (`sdkconfig_check.py` merges both). Main numbers today:

| Knob | Value | Where / why |
|------|-------|-------------|
| `CONFIG_ESP_MAIN_TASK_STACK_SIZE` | 24576 (S3), 20480 (CYD/cyd-vspi/devkit/esp32-cam) | Main task runs UI + Duktape; peak measured ~7,2 KB (watch) / ~8,5 KB (CYD compiling the App Store). The old 32 KB was the biggest internal-RAM item on S3. |
| `celerapp` task | 32768 | Hardcoded in `Kernel/AppRunner.cpp`; only exists with `CONFIG_CELEROS_APP_TASK` (experimental F3, **off on every board**). |
| `CONFIG_ESP_SYSTEM_EVENT_TASK_STACK_SIZE` | 4096 | WifiConnection/NetworkManager handlers; peak ~2,2 KB (watch) / ~1,1 KB (CYD). |
| `CONFIG_ESP_TIMER_TASK_STACK_SIZE` | 2560 | esp_timer peak ~0,55 KB. |
| HTTPD | 10240 | Own httpd task (`WebManager`), not the main stack. |
| `CONFIG_CELEROS_APP_SERVICES` | `y` | API 42 svchost (background app services). Explicit in every board defaults; `CELEROS_APP_TASK` is its Kconfig-exclusive counterpart and stays `n`. On no-PSRAM boards the svchost heap only starts with >=44 KB free. |

Per-board RAM recipes: CYD/cyd-vspi/devkit are **unicore + IRAM-as-heap** (`ESP_SYSTEM_SINGLE_CORE_MODE`, `FREERTOS_UNICORE`, `ESP32_IRAM_AS_8BIT_ACCESSIBLE_MEMORY`, `MBEDTLS_IRAM_8BIT_MEM_ALLOC`, WiFi with 4 static RX + AMPDU off). The **esp32-cam is dual-core on purpose** (unicore + WiFi + NimBLE reset-looped in INT_WDT, 2026-10-10): that makes the IRAM-as-heap options nonexistent, so its TLS buffers go to PSRAM (`MBEDTLS_EXTERNAL_MEM_ALLOC`). S3 PSRAM boards put the NimBLE host pools in PSRAM (`BT_NIMBLE_MEM_ALLOC_MODE_EXTERNAL`), static WiFi RX at 8 with `RX_BA_WIN=8`, WiFi code out of IRAM, and (smartdisplay) the 32 KB instruction cache for Duktape.

Watch-only: `CELEROS_PHONE_LINK` + `BT_NIMBLE_NVS_PERSIST` (bond), `CELEROS_USB_NATIVE` + TinyUSB CDC_COUNT=2, `PM_ENABLE`/tickless + BT modem sleep, ULP sentinel (`ULP_COPROC_RESERVE_MEM=4096`). Dog-only: `CELEROS_LINK_ON_USJ`, `CELEROS_WAKE_WORD`, ULP battery watchdog. Smartdisplay-only: `ESP32S3_INSTRUCTION_CACHE_32KB`, panel ISR on core 1 (see below).

**`sdkconfig.defaults` edits do NOT reach an existing build dir.** Delete `build*/sdkconfig` (it is regenerated from the defaults on the next `idf.py` run) and re-check with `python3 tools/sdkconfig_check.py`. This is how 2026-10 bench builds still ran a 32 KB main stack after the defaults moved to 24 KB.

## HARDWARE NOTES FROM THE BENCH
- **S3 boards with octal PSRAM: GPIO33..37 are DQ4..7/DQS** — always denied in `gpioDeniedMask` (`0x3E00000000ULL`, note the zero count; an earlier off-by-one masked 29..33 instead).
- **Board-owned pins are denied per profile, not globally**: smartdisplay adds 19/45 (GT911 I2C), 20 (RGB G1 + USB D+, the OTG that must never exist there) and 43/44 (UART0 console/celerctl); watch adds 14/15 (I2C0: touch/PMU/RTC/IMU), 19/20 (USB OTG) and 43/44 (UART0 fallback); dog adds 4/5/6 (mic I2S — GPIO4 is the clock, never an ADC), 19/20 (USJ) and 41/42 (OLED I2C). Classic ESP32 boards deny 1/3 (UART0) plus 6..11 (SPI flash). Servo/strip pins stay allowed on the dog because `System.gpio.servo()` uses the same `requirePin` guard (denying them would break Dog Face).
- **Touch point capability (API 43 multitouch) lives in the touch driver, not in a BoardProfile flag** — `kui::readTouches` asks for 5 and gets whatever the driver returns: smartdisplay GT911 = 5 points WITH track id (`Touch_GT911_IDF`, layout `[track][x][y][sz]` x 8 B @0x814F); watch FT3168 = 5 (família FT5x06, blocos de 6 B @0x03, id no nibble alto do YH — o firmware Rust do vendor lia só o ponto 1); cyd/cyd-vspi XPT2046 resistivo = 1 por natureza; dog/devkit/esp32-cam = sem vidro (stub devolve 0).
- **CYD folds profile constants: beware `-Werror=int-in-bool-context` inside IDF config macros.** BoardProfile values that are compile-time known on a board (CYD: `.i2s` todo -1) propagate into macro arguments, and macros with internal ternaries over those args (`I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG` compares `bits <= 16BIT`) become constant `?:` — GCC errors. Pattern fix: local `#pragma GCC diagnostic ignored` around the call (`BoardIO.cpp`, from the 32-bit mic slot change).
- Serial ports on the bench: the two CH340 boards (SmartDisplay, CYD) swap between `/dev/ttyUSB0` and `/dev/ttyUSB1` depending on plug order (2026-10-09: SmartDisplay on USB1) — `celerctl devices -l` prints the board of each port, check before an OTA. `/dev/ttyACM0` = dog **or** watch (flash id disambiguates: 16MB vs 32MB).
- The watch is flashed over the air (`celerctl ota push`) after first esptool load; a CDC timeout during push is retriable, and an UNKNOWN state heals with a reboot.
- `dependencies.lock` records the last-built target; don't commit its build churn.

## ADDING A BOARD (checklist)
1. `main/Boards/<b>/`: `Board.cpp` (BoardProfile), `BoardDisplay.h` (LovyanGFX panel + touch), `BoardTraits.h` — all board `#ifdef`s stay here, nowhere else.
2. `elseif(CELEROS_BOARD STREQUAL "<b>")` in `main/CMakeLists.txt`.
3. `boards/<b>/sdkconfig.defaults` (+ partition CSV if a new size).
4. `updates/<channel>/update.json` OTA channel and, if needed, a case in `tools/flash_data.sh` (port default + partition CSV).
5. Matrix entry in `.github/workflows/build.yml` (`firmware` job) — lint coverage is automatic via the `boards/*/data/apps` glob.
6. Fill `BoardProfile` runtime hooks (`readBatteryPct`, `imuAccel`, `screenSleep`, `watchGestures`, ...) instead of adding ifdefs elsewhere.

## SMARTDISPLAY RGB PANEL: "THE SCREEN SHAKES" (read before touching display, cache or ISR settings)
The 4848S040 is an RGB parallel panel (ST7701, 480x480, pclk 12 MHz, ~41 Hz). The LCD_CAM peripheral scans the framebuffer **straight from PSRAM** through GDMA (LovyanGFX `Panel_RGB`/`Bus_RGB`, no bounce buffer), and `Bus_RGB` **restarts the DMA at the start of every frame from the VSYNC-end interrupt**. Everything below cost a full day on the bench (2026-10-09); keep it.

| Symptom on the glass | Cause | Fix / rule |
|---|---|---|
| Whole image shakes a few px back and forth, only while a JS app is open (even a static menu, with or without sound); launcher fine | The VSYNC ISR (level 1, shared) was bound to **core 0** — the core of the main task (Duktape), WiFi and BT. `heap_caps` critical sections (Duktape allocates constantly) delay the restart; at 12 MHz pclk **1 us of latency = ~12 px of shift** | `Board::init()` runs `s_display.init()` from a task **pinned to core 1** (`esp_intr_alloc` binds the ISR to the calling core). Never move the display init back to the main task |
| Everything shakes/scrambles, launcher included | `CONFIG_ESP32S3_DATA_CACHE_LINE_64B` (tried as "Espressif's RGB recommendation" — that advice is for `esp_lcd` with bounce buffers) | Keep the 32 B data cache line. The app (not the bootloader) sets the cache config in `cpu_start.c` |
| Flashes / smear while big areas redraw every frame | Full `fillScreen`+redraw per frame + full push saturate the MSPI bus shared by flash, PSRAM framebuffer and the app frame | Firmware pushes up to 8 dirty boxes (`Display/DirtyRects.h`); engine 1.2 `static` scenes, `E.dirty`, `E.tilemap` |
| Image scrambles in bursts during a heavy game (worse with the app installed on the SD); logcat floods `i2s_alloc_dma_desc: allocate DMA buffer failed` | The persistent speaker channel (`BoardIO::speakerChannel`) was born on the FIRST sound. With the app on the SD (FATFS + SPI) internal RAM had no DMA block left, so every sfx and every music block recreated and deleted I2S + GDMA + interrupt, from the unpinned `celermusic` task that ran on core 1 (heap/intr critical sections mask level 3 = the VSYNC ISR) | `BoardIO::speakerWarmup()` opens the channel at boot on PSRAM boards; a failed open backs off 3 s; `celermusic`/`celerbeep`/`pcmfeed` pinned to core 0; engine 1.4.1 backs off a track that dies right after `playMusic` (2026-10-18) |
| A heavy game crawls (Supernova at 4-6 fps on the 4848) and `getTouch` costs ~30 ms per frame | Three firmware costs that only show up in big games. (1) The GT911 driver treated a read more than 128 ms after the previous one as stale: flush + wait for a fresh sample (up to 24 x `delay(1)`), so every read of a < 8 fps game blocked ~30 ms (a vicious circle). (2) `FrameSprite` kept only 8 dirty boxes: scattered 1 px draws (stars, dust) merged into unions of 44%+ of the glass, and the present pushed ~200k px per frame. (3) The 1 s periodic `duk_gc` cost ~40 ms on a big heap = one lost frame per second | GT911 read by a background task (`gt911`, core 0, the chip's own cadence); `getTouchRaw` only copies the last sample. `kMaxDirty` = 32. Periodic full GC every 10 s on PSRAM boards (voluntary GC keeps running). Measure from the firmware side (time inside `appWait`/`readAppTouches`) before guessing: JS-side timers attribute the stall to whichever call runs next (2026-10-18) |
| Slow JS (13-16 fps in games) | 16 KB instruction cache thrashed by the Duktape executor; Duktape lean config freed/allocated an activation record per call | `CONFIG_ESP32S3_INSTRUCTION_CACHE_32KB=y` (smartdisplay defaults) + `DUK_USE_CACHE_ACTIVATION/CATCHER` on PSRAM boards (`components/duktape/celeros_fixup.h`): Detona 16 -> 28 fps |

**Diagnose before guessing** — the screen capture (`celerctl screencap`) reads the framebuffer through the CPU, so it never shows DMA/timing faults. Use the device shell:
- `lcddma [ms]` — counts GDMA FIFO **underflows** of the LCD channel (non-zero = PSRAM bandwidth starvation; it was 0 in every case above, which ruled bandwidth out) and EOFs (~40/s = panel refresh).
- `lcddma 300 isr` — interrupt table per core; **`LCD_CAM` must appear under `CPU 1`**.
- `celerctl stats --json` → `ui.frames` (presents that actually pushed pixels): a static scene must not move it. If the glass misbehaves while `frames` stands still and `lcddma` shows no underflow, look at **ISR latency/timing**, not at drawing.

Order the hypotheses were eliminated in (so nobody repeats it): app redraw volume → cache line 64B (made it worse) → dirty-rect tracking (all LovyanGFX write paths incl. alpha go through `DirtyPanel`; host fuzz of `DirtyRects` 20k cases, 0 lost pixels) → DFS (off: no `CONFIG_PM_ENABLE` here) → per-frame GC (`getMaxAllocHeap` counts PSRAM, GC is 1/s) → pin conflicts (I2S 40/1/2, touch 19/45, panel init SPI 39/47/48 shared only with the SD) → DMA underflow (0) → **ISR on the Duktape core** (fixed).

## SMARTDISPLAY SD CARD: pins, boot deselect and the exFAT trap (2026-10-18)
The microSD shares **SCK=48/MOSI=47** with the panel's 3-wire init (CS 39); the card sits on **CS=42, MISO=41** at `freqKhz=4000` (`main/Boards/smartdisplay/Board.cpp`; vendor pin map confirmed by the HomeDing 4848S040 page). 2026-10-18: both bench 4848s came back with `/sd` absent after the API 44 flash, and the UART boot log (raw serial on the CH340 at **115200** — `celerctl logcat` misses the FS lines because SerialLink installs the `esp_log` hook only after `FileSystem::init`) told the whole story:
- `failed to mount card (13)` — FatFs **FR_NO_FILESYSTEM**: the cards were **exFAT/virgin** and IDF's FatFs cannot read exFAT. The card answered at 4 MHz, so the pin map was right all along.
- After ONE failed mount, `sdspi` cannot bring the card back (`send_if_cond` → 0x108) — **the card only answers on the boot mount**. Anything that must touch the card (format included) happens inside `FileSystem::mountSD` at boot.
- `W gpio: conflict found for GPIO[42]` — the CS wakes in the UART1 IOMUX function. `gpio_reset_pin` + pull-up on all four lines clears it (now in `mountSD`; `Board::init` also deselects the CS **before** the panel init so the card never latches the shared SCK/MOSI noise).

Fixes that shipped (15faac2): `mountSD` resets/pulls up the 4 pins, tries the profile clock then 400 kHz, and honors a **format request persisted in NVS** (namespace `fs`, key `sd_fmt`): `FileSystem::formatSD` only schedules it — the **boot mount** runs with `format_if_mount_failed` and formats FAT32 (APAGA TUDO; never automatic — exFAT data stays readable on the PC). Shell: `sd` (state) and `sd format` (schedules + reboots). Bench proof: both 4848s mount 16 GB cards (14.6 G free) with the games living in `/sd/apps` (`celerctl apps store --sd`; the launcher scans both roots — remove the local copy to avoid duplicates). On the bench, flash the SD-mount firmware via **WiFi** OTA (`-p IP:5555`): the API 44 USB HostLink drops big writes (`sem ACK` / `payload grande demais`; `--win 1` helps).
