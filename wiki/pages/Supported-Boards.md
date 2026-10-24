# Supported boards

**English** | [Português (BR)](/Celer-Brasil/CelerOS/wiki/Placas-Suportadas)

| SmartDisplay 4" | CYD |
| :---: | :---: |
| <img src="Documentation/assets/imgs/celeros-home.jpg" width="300" alt="SmartDisplay running CelerOS"/> | <img src="Documentation/assets/imgs/CYD2432S028R.jpg" width="300" alt="CYD"/> |

| Board | SoC | Display | Touch | Notes |
|---|---|---|---|---|
| **SmartDisplay 4"** (Guition ESP32-S3-4848S040) | ESP32-S3-N16R8 | 4" IPS 480x480 RGB (ST7701) | Capacitive GT911 | 16 MB flash / 8 MB PSRAM, microSD, I2S speaker (NS4168); "Y" SKUs with relays; Celer Link BLE (NimBLE) |
| **CYD** (ESP32-2432S028R, "Cheap Yellow Display") | ESP32 | 2.8" ILI9341 320x240 SPI | Resistive XPT2046 | No PSRAM; CH340 serial; asks for touch calibration on first boot; simpler UI ([see below](#cyd-classic-esp32)) |
| **CYD-VSPI** (untested variant) | ESP32 | 2.8" ILI9341 320x240 SPI | Resistive XPT2046 | Legacy pinout (TFT on VSPI 18/23/19, shared touch bus, backlight GPIO22) kept for boards wired that way — **never tested on hardware**; build with `-DCELEROS_BOARD=cyd-vspi` |
| **Robot dog** (SpotBear/ZZPET `zzpet-s3`) | ESP32-S3R8 (8 MB embedded PSRAM) | 1.3" OLED SH1106 128x64 (face) | Capacitive pad (GPIO10) | 4 servos (legs ported from Espressif's ESP-Hi tables, per-leg calibration saved to `/local/dogtune.json`), mic + speaker I²S, 2x WS2812, battery ADC with a ULP-RISC-V watchdog during deep sleep; on-device wake word "Hi Celer" + voice commands; boots into the Dog Face app (profile `homeApp`); driven by the Celer Remote app over Celer Link BLE; `celerctl` on the USB-Serial/JTAG (`CELEROS_LINK_ON_USJ`); build with `-DCELEROS_BOARD=spotpear-dog` — see [Robot dog](/Celer-Brasil/CelerOS/wiki/Robot-Dog) |
| **Waveshare AMOLED 2.06 watch** (ESP32-S3-Touch-AMOLED-2.06) | ESP32-S3R8 (8 MB embedded PSRAM) | 2.06" round AMOLED 410x502 QSPI (CO5300) | Capacitive FT3168 | 32 MB flash, AXP2101 PMU, RTC PCF85063 + IMU QMI8658 (pedometer) + audio ES8311 codec on I²C, microSD on SPI3; boots into the Watchface app (profile `homeApp`); screen ladder with AOD + automatic deep sleep guarded by a ULP-RISC-V sentinel (the PWR button wakes it in ~100 ms); Celer Link BLE; `celerctl` on the native USB (dual CDC — `CELEROS_USB_NATIVE`), logs via `celerctl logcat`; build with `-DCELEROS_BOARD=waveshare-watch` — see [Waveshare watch](/Celer-Brasil/CelerOS/wiki/Waveshare-Watch) |
| **Barebone devkit** (any plain ESP32 board, e.g. DOIT DevKit v1) | ESP32 | none — on-board LED (GPIO2) | BOOT button (GPIO0) | 4 MB flash, no PSRAM, no SD; headless profile (`CELEROS_UI=n`): the whole display stack leaves the binary and apps run headless via `System.button()` + `System.led`; `celerctl` on UART0; WiFi via the `wifi` shell command; OTA channel `updates/devkit`; build with `-DCELEROS_BOARD=devkit` — see [Barebone devkit](/Celer-Brasil/CelerOS/wiki/Barebone-Devkit) |
| **ESP32-CAM** (AI-Thinker, ESP32-S module) | ESP32 (4 MB flash + 4 MB PSRAM quad) | none — the "glass" is the OV2640 sensor | none (flash LED on GPIO4 as torch) | Camera node of the CelerNet sensor network: `Camera.*` (API 35 — photos + on-device QR via quirc), apps and modules live on the microSD (SDSPI CLK14/CMD15/D0-2/CS13), NimBLE mesh (`CAPS_CAMERA` in the pack), slots of 1.81 MB with a small `/local`; bench notes: sturdy 5 V supply (brownout is failure #1), GPIO0 to GND to flash, GPIO12 is the MTD strap; OTA channel `updates/esp32-cam`; build with `-DCELEROS_BOARD=esp32-cam` |

## Where a board is defined

* `boards/<board>/sdkconfig.defaults` — per-target sdkconfig defaults.
* `main/Boards/<board>/` — pin map, display driver and `BoardTraits.h`
  (compile-time differences, e.g. `largeUi`, `hasPsram`).
* Selection happens at build time with `-DCELEROS_BOARD=<board>` (one of
  the ids above; any other value is a fatal CMake error). See
  [Building and flashing](/Celer-Brasil/CelerOS/wiki/Building-and-Flashing).

The UI is resolution-adaptive — everything is drawn on a virtual 240x320
canvas and scaled — so adding a new panel is mostly creating a new board
profile.

## Adding a board

1. `main/Boards/<board>/` with the three files (`Board.cpp`,
   `BoardDisplay.h`, `BoardTraits.h`).
2. An `elseif` in [main/CMakeLists.txt](main/CMakeLists.txt) adding the
   board directory to the private include path.
3. `boards/<board>/sdkconfig.defaults`.
4. An `updates/<channel>/update.json` OTA channel.

## Per-board notes

### SmartDisplay 4" (ESP32-S3)

* Do not enable `CONFIG_CELEROS_USB_NATIVE` on this board: GPIO19/20 are
  the GT911's I2C and an RGB data line — enabling native USB conflicts with
  touch and video. `celerctl` talks to it over the UART (the USB connector
  is a CH340 on top of UART0, pins 43/44).
* RGB + PSRAM allow a full-frame sprite; the CYD doesn't have that luxury.

**Board peripherals used by the system** (from the manufacturer's material
for the "4.0inch_ESP32-4848S040"): microSD on SPI shared with the panel init
(CS=42, SCK=48, MISO=41, MOSI=47, mounted at `/sd`), speaker through a
Nsiway NS4168 digital amplifier over I2S (DOUT=GPIO40, BCLK=GPIO1,
LRC=GPIO2, no MCLK — `System.beep` plays a sine wave), and the "Y" SKUs
(86 wall-switch box with 1 or 3 relays): L1=GPIO40, L2=GPIO2, L3=GPIO1 —
the same pins as the speaker. Firmware built with
`CONFIG_CELEROS_SMARTDISPLAY_RELAYS=N` trades the speaker for N relays
controllable with `System.relay` (they start off at boot). Celer Link BLE
(NimBLE) also runs on this board now that the host pools moved to PSRAM
(~22 KB of internal RAM free after init).

**Free GPIOs for apps** (`System.gpio`): IO35, IO36 and IO37 on the header
(IO0 is BOOT and the display's R4 line; IO43/44 are the console serial).

### CYD (classic ESP32)

**What to expect:**

The CYD runs the same firmware and the same apps, but it is a much smaller
machine than the SmartDisplay (an ESP32 with ~320 KB of RAM and no PSRAM, a
2.8" SPI panel and a resistive touch), so the experience is noticeably
simpler:

* **Stretched apps.** JS apps are designed for a 240x320 portrait canvas; on
  the 320x240 landscape glass they are scaled 1.33x wide and 0.75x tall —
  text and shapes look squashed.
* **Apps can flicker.** There is no RAM for an off-screen frame, so JS apps
  draw straight to the panel (`System.isBuffered()` is `false`). The system
  UI (launcher, dialogs, app top bar) is composed in two small bands and
  does not flicker, but an app that clears and redraws the whole screen on
  every event will.
* **Slower.** A full-screen redraw is bound by the 40 MHz SPI bus (~31 ms);
  big apps take 1–2 s to compile when they open (Settings, App Store).
* **Tight memory.** An app gets ~220 KB of internal RAM (part of it slower
  IRAM); the practical ceiling is a `main.js` of ~60 KB, and big apps take a
  few seconds to open. Bigger apps are marked "Requer PSRAM" in the store.
* **Resistive touch.** It needs a firmer press and a calibration on first
  boot; targets are small (48 px icons, 20 px top bar). You can also drive
  the screen from the browser with the
  [live screen mirror](/Celer-Brasil/CelerOS/wiki/Web-Interface).
* **No SD card** for now (the slot shares the display bus).

**Board peripherals used by the system:** RGB LED on the back
(`System.led`), light sensor next to the screen (`System.lightLevel` and
auto-brightness in Settings → Screen) and the speaker output on GPIO26
(`System.beep`).

**Under the hood (for firmware hackers):**

* 4 MB of flash: the image is tight — moving the system apps to JS on
  LittleFS (which saved ~330 KB) was decisive to make it fit.
* Resistive XPT2046 touch: calibration runs on the first boot.
* No PSRAM: avoid heap churn in hot paths — the full-frame sprite only
  exists when the board profile has PSRAM. The system UI is composed in two
  ping-pong bands; the icon cache and the bands are released when an app
  opens.
* Unicore with the free IRAM byte-accessible (compile source, TLS buffers
  and JS heap overflow area). Details and numbers in
  [Documentation/ENGINE_NOTES.md](Documentation/ENGINE_NOTES.md).

### Waveshare AMOLED 2.06 watch (ESP32-S3)

Smartwatch board (ESP32-S3R8: 32 MB flash, 8 MB octal PSRAM) with a round
2.06" AMOLED 410x502 driven by a **CO5300 over QSPI** (SDIO0..3 = GPIO4..7,
SCLK=11, CS=12, RST=8; the visible glass sits at column offset 22). The
AXP2101 PMU powers the display rails (DCDC1 + ALDO1 at 3.3 V) and must be
configured before the panel init — the board HAL does it in `Board::init()`.

* Build: `idf.py -B build-watch -DSDKCONFIG=build-watch/sdkconfig -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/waveshare-watch/sdkconfig.defaults" -DCELEROS_BOARD=waveshare-watch set-target esp32s3`.
* Flash data with `tools/flash_data.sh waveshare-watch` (defaults to
  `/dev/ttyACM0` — the native USB in OTG mode: ROM flashing, CDC0 shell and
  `celerctl` on CDC1; the IDF console itself sits on the connector-less
  UART0, so live logs come through `celerctl logcat`).
* Touch is an FT3168 on I²C (SDA=15, SCL=14, addr 0x38, RST=9, INT=38),
  driven by the IDF `i2c_master` driver in `main/Display/Touch_FT3168_IDF.h`
  (same pattern as the GT911 — LovyanGFX's own I²C layer is broken on
  IDF 6.1, and the chip needs register 0xA5 = monitor mode at init).
* Brightness is the AMOLED's WRDISBV (DCS 0x51) — no `Light_PWM`; the
  backlight control in Settings works through the panel driver.
* The panel only accepts even-aligned write windows, so the display runs
  on a LovyanGFX framebuffer in PSRAM (also gives `readRect` back for
  screenshots/screen mirror).
* The glass is round-cornered: launcher grid corners are slightly clipped
  and the virtual 240x320 canvas is scaled ~1.71x/1.57x (mild vertical
  squash). The bundled **Watchface** app (`celeros.watchface`, the boot
  `homeApp`) is designed for the glass; swipe up opens the launcher.
* Pin map and init sequences were ported from the Rust firmware
  `waveshare-watch-rs` (same watch, standalone firmware).

**Board peripherals used by the system:** microSD on SPI3 (CS=17, SCK=2,
MOSI=1, MISO=3, mounted at `/sd`), Celer Link BLE (NimBLE), ES8311 codec +
PA (GPIO46) for `System.beep` and `System.micLevel()` (16 kHz, MCLK 4,096 MHz
on GPIO16), QMI8658 IMU (pedometer + raise-to-wake, `Sensors.*` API 13),
PCF85063 RTC (time survives reboots), AXP2101 battery in `System.battery()`,
BOOT/PWR buttons (short = home, hold = screenshot / deep sleep) and the
ScreenPower ladder (dim 8 s → AOD 15 s with anti burn-in → off → automatic
deep sleep guarded by a ULP-RISC-V sentinel that wakes on the PWR button in
~100 ms, on a raise gesture, on low battery or on the USB cable). The full
pinout and the watch experience live in the
[Waveshare watch](/Celer-Brasil/CelerOS/wiki/Waveshare-Watch) page.
