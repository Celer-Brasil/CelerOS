# boards/ - per-board sdkconfig, data overlay and what makes each board different

## OVERVIEW
One directory per board holding its `sdkconfig.defaults`. Board code itself lives in `main/Boards/<board>/` (Board.cpp, BoardDisplay.h, BoardTraits.h — exactly one is compiled in); this tree is only configuration plus, on the watch, the factory-image overlay. The `-DCELEROS_BOARD=<b>` CMake cache variable selects the board (validated in `main/CMakeLists.txt`; anything else is FATAL_ERROR).

## THE SEVEN BOARDS
| Board | Chip / flash / RAM | Display & touch | Partitions | Notes |
|-------|--------------------|-----------------|------------|-------|
| `smartdisplay` | ESP32-S3 N16R8, 16MB QIO, PSRAM octal | Guition 4848S040 480x480 capacitive GT911 | `partitions_16MB.csv` | Default board. **Never** `CELEROS_USB_NATIVE` here (GPIO19/20 = touch I2C + RGB lane). Optional relay header (`CELEROS_SMARTDISPLAY_RELAYS`) |
| `cyd` | ESP32 classic, 4MB, no PSRAM | CYD 2432S028R 320x240 resistive, landscape | `partitions_4MB.csv` | Unicore + IRAM-as-heap tricks; OTA slot (1.75MB) is THE size constraint of the project. USB via CH340 UART |
| `cyd-vspi` | ESP32 classic, 4MB, no PSRAM | CYD variant, display on VSPI — **UNTESTED** (see `main/Boards/cyd-vspi/BoardDisplay.h`) | `partitions_4MB.csv` | Same budget rules as `cyd`; exists to validate the variant in CI |
| `spotpear-dog` | ESP32-S3R8, 16MB DIO, PSRAM octal | SpotBear/ZZPET robot (no main display use) | `partitions_16MB.csv` | Derived from smartdisplay. Console+celerctl on the USB-Serial/JTAG (`CELEROS_LINK_ON_USJ`, the only USB connector). Home app = Dog Face |
| `waveshare-watch` | ESP32-S3R8, 32MB DIO, PSRAM octal | Waveshare AMOLED 2.06" 410x502 round-ish, FT3168 capacitive | `partitions_32MB.csv` | The smartwatch. Native USB dual CDC (`CELEROS_USB_NATIVE`, CDC_COUNT=2), NimBLE (Celer Link + Phone Link/Gadgetbridge), PM/light-sleep (`PowerPolicy`), RTC PCF85063 + AXP2101 + QMI8658 IMU, `screenInset` for the rounded glass |
| `devkit` | ESP32 classic, 4MB, no PSRAM | **None** — stub panel that discards rendering (`main/Boards/devkit/BoardDisplay.h`); BOOT button (GPIO0) + single-channel LED (GPIO2) | `partitions_4MB.csv` | The barebone profile: `headless` (splash skipped, `getInfo().hasDisplay=false`/`shape:"headless"`) + `buttonToApp` (BOOT is app input via `System.button`, long = exit, launcher short relaunches homeApp). First board on `CELEROS_UI=n` (the whole display stack leaves the binary). Same RAM budget as `cyd`; WiFi provisioned by the `wifi` shell command; factory image drops display apps via `data-exclude.txt` |
| `esp32-cam` | ESP32-S (classic) AI-Thinker, 4MB DIO, PSRAM quad 4MB | **None** — the "glass" is the OV2640 sensor | `partitions_4MB_cam.csv` | Camera node: `headless`, `CELEROS_UI=n`, NimBLE (CelerNet mesh), microSD by SDSPI (CLK14/CMD15/D0-2/CS13 — apps live on the SD, hence the small littlefs/1.81MB slots). Bench: brownout is failure #1 (sturdy 5V supply); flash mode = GPIO0 to GND at reset; GPIO12 is the MTD strap (never an output); GPIO16/17 belong to the PSRAM |

## PER-BOARD FACTORY IMAGE
`tools/flash_data.sh <board>` stages `data/` and then:
1. **overlays** `boards/<board>/data/` on top (the watch adds Timer/Clima/Musica/Alarmes/Celular/Atividade), and
2. **excludes** paths listed in `boards/<board>/data-exclude.txt` (one per line, relative to `data/`; `#` comments) — the watch drops Terminal, HTTP Demo, Touch Test and Web Server (tight littlefs, keyboard-centric apps).

Partition size comes from the CSV picked above (single source of truth). New board with a data overlay: add the case to `flash_data.sh` and the overlay dir; the repo-wide app lint already globs `boards/*/data/apps` automatically.

## ADDING A BOARD (checklist)
1. `main/Boards/<b>/`: `Board.cpp` (BoardProfile), `BoardDisplay.h` (LovyanGFX panel + touch), `BoardTraits.h` — all board `#ifdef`s stay here, nowhere else.
2. `elseif(CELEROS_BOARD STREQUAL "<b>")` in `main/CMakeLists.txt`.
3. `boards/<b>/sdkconfig.defaults` (+ partition CSV if a new size).
4. `updates/<channel>/update.json` OTA channel and, if needed, a case in `tools/flash_data.sh` (port default + partition CSV).
5. Matrix entry in `.github/workflows/build.yml` (`firmware` job) — lint coverage is automatic via the `boards/*/data/apps` glob.
6. Fill `BoardProfile` runtime hooks (`readBatteryPct`, `imuAccel`, `screenSleep`, `watchGestures`, ...) instead of adding ifdefs elsewhere.

## HARDWARE NOTES FROM THE BENCH
- **S3 boards with octal PSRAM: GPIO33..37 are DQ4..7/DQS** — always denied in `gpioDeniedMask` (`0x3E00000000ULL`, note the zero count; an earlier off-by-one masked 29..33 instead).
- Serial ports on the bench: the two CH340 boards (SmartDisplay, CYD) swap between `/dev/ttyUSB0` and `/dev/ttyUSB1` depending on plug order (2026-10-09: SmartDisplay on USB1) — `celerctl devices -l` prints the board of each port, check before an OTA. `/dev/ttyACM0` = dog **or** watch (flash id disambiguates: 16MB vs 32MB).
- The watch is flashed over the air (`celerctl ota push`) after first esptool load; a CDC timeout during push is retriable, and an UNKNOWN state heals with a reboot.
- `sdkconfig.defaults` edits only reach an existing build dir after deleting `build*/sdkconfig`.
- `dependencies.lock` records the last-built target; don't commit its build churn.

## SMARTDISPLAY RGB PANEL: "THE SCREEN SHAKES" (read before touching display, cache or ISR settings)
The 4848S040 is an RGB parallel panel (ST7701, 480x480, pclk 12 MHz, ~41 Hz). The LCD_CAM peripheral scans the framebuffer **straight from PSRAM** through GDMA (LovyanGFX `Panel_RGB`/`Bus_RGB`, no bounce buffer), and `Bus_RGB` **restarts the DMA at the start of every frame from the VSYNC-end interrupt**. Everything below cost a full day on the bench (2026-10-09); keep it.

| Symptom on the glass | Cause | Fix / rule |
|---|---|---|
| Whole image shakes a few px back and forth, only while a JS app is open (even a static menu, with or without sound); launcher fine | The VSYNC ISR (level 1, shared) was bound to **core 0** — the core of the main task (Duktape), WiFi and BT. `heap_caps` critical sections (Duktape allocates constantly) delay the restart; at 12 MHz pclk **1 us of latency = ~12 px of shift** | `Board::init()` runs `s_display.init()` from a task **pinned to core 1** (`esp_intr_alloc` binds the ISR to the calling core). Never move the display init back to the main task |
| Everything shakes/scrambles, launcher included | `CONFIG_ESP32S3_DATA_CACHE_LINE_64B` (tried as "Espressif's RGB recommendation" — that advice is for `esp_lcd` with bounce buffers) | Keep the 32 B data cache line. The app (not the bootloader) sets the cache config in `cpu_start.c` |
| Flashes / smear while big areas redraw every frame | Full `fillScreen`+redraw per frame + full push saturate the MSPI bus shared by flash, PSRAM framebuffer and the app frame | Firmware pushes up to 8 dirty boxes (`Display/DirtyRects.h`); engine 1.2 `static` scenes, `E.dirty`, `E.tilemap` |
| Slow JS (13-16 fps in games) | 16 KB instruction cache thrashed by the Duktape executor; Duktape lean config freed/allocated an activation record per call | `CONFIG_ESP32S3_INSTRUCTION_CACHE_32KB=y` (smartdisplay defaults) + `DUK_USE_CACHE_ACTIVATION/CATCHER` on PSRAM boards (`components/duktape/celeros_fixup.h`): Detona 16 -> 28 fps |

**Diagnose before guessing** — the screen capture (`celerctl screencap`) reads the framebuffer through the CPU, so it never shows DMA/timing faults. Use the device shell:
- `lcddma [ms]` — counts GDMA FIFO **underflows** of the LCD channel (non-zero = PSRAM bandwidth starvation; it was 0 in every case above, which ruled bandwidth out) and EOFs (~40/s = panel refresh).
- `lcddma 300 isr` — interrupt table per core; **`LCD_CAM` must appear under `CPU 1`**.
- `celerctl stats --json` → `ui.frames` (presents that actually pushed pixels): a static scene must not move it. If the glass misbehaves while `frames` stands still and `lcddma` shows no underflow, look at **ISR latency/timing**, not at drawing.

Order the hypotheses were eliminated in (so nobody repeats it): app redraw volume → cache line 64B (made it worse) → dirty-rect tracking (all LovyanGFX write paths incl. alpha go through `DirtyPanel`; host fuzz of `DirtyRects` 20k cases, 0 lost pixels) → DFS (off: no `CONFIG_PM_ENABLE` here) → per-frame GC (`getMaxAllocHeap` counts PSRAM, GC is 1/s) → pin conflicts (I2S 40/1/2, touch 19/45, panel init SPI 39/47/48 shared only with the SD) → DMA underflow (0) → **ISR on the Duktape core** (fixed).
