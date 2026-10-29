# Building and flashing

**English** | [Português (BR)](/Celer-Brasil/CelerOS/wiki/Compilando-e-Gravando)

CelerOS 1.2+ is plain **ESP-IDF 6.1** (no Arduino/PlatformIO layer).

## Just flashing a board? (factory release, no toolchain)

Every `v*` tag on GitHub publishes a **factory package**: one zip per board
(firmware + data partition + `flash.json` + `README.txt`) plus the
**CelerOS Flasher** for linux and windows (esptool embedded). This is the
recommended first-install path — no ESP-IDF, no build:

1. Grab the **CelerOS_Flasher** for your system and the **zip for your
   board** from [releases](https://github.com/Celer-Brasil/CelerOS/releases).
2. Extract both into the same folder and run the flasher.
3. Pick **board**, then the **USB port** the board is on.
4. Answer **"erase everything" = yes** (first flash clears stale NVS data),
   press ENTER — images are written and verified, and the board reboots
   into CelerOS.

No port listed? Install the USB-serial driver of your adapter (CP210x or
CH34x) and replug the board. Prefer the manual route? Each zip's
`README.txt` has the exact `esptool write-flash` line with all offsets.

Updates after that arrive over the air (Settings > Update on the device) —
releases are for first flashes.

## Prerequisites

```bash
git clone https://github.com/Celer-Brasil/CelerOS.git && cd CelerOS
git submodule update --init          # LovyanGFX
source ~/esp/v6.1/esp-idf/export.sh  # ESP-IDF v6.1 installed
```

Third-party components (ArduinoJson, esp_littlefs, nlohmann/json) are pulled
in by the ESP-IDF component manager; LovyanGFX is a submodule — clone with
`--recurse-submodules` or run `git submodule update --init`.

## Build and flash per board

The target is chosen with `-DCELEROS_BOARD=` (`smartdisplay` is the
default):

```bash
# SmartDisplay 4" (ESP32-S3)
idf.py -B build -DSDKCONFIG=build/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/smartdisplay/sdkconfig.defaults" \
  -DCELEROS_BOARD=smartdisplay set-target esp32s3
idf.py -B build build flash -p /dev/ttyUSB0 monitor

# CYD (classic ESP32)
idf.py -B build-cyd -DSDKCONFIG=build-cyd/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/cyd/sdkconfig.defaults" \
  -DCELEROS_BOARD=cyd set-target esp32
idf.py -B build-cyd build flash -p /dev/ttyUSB0 monitor

# Waveshare AMOLED 2.06 watch (ESP32-S3, USB-Serial/JTAG)
idf.py -B build-watch -DSDKCONFIG=build-watch/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/waveshare-watch/sdkconfig.defaults" \
  -DCELEROS_BOARD=waveshare-watch set-target esp32s3
idf.py -B build-watch build flash -p /dev/ttyACM0 monitor

# SpotPear robot dog (ESP32-S3, USB-Serial/JTAG)
idf.py -B build-dog -DSDKCONFIG=build-dog/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/spotpear-dog/sdkconfig.defaults" \
  -DCELEROS_BOARD=spotpear-dog set-target esp32s3
idf.py -B build-dog build flash -p /dev/ttyACM0 monitor

# Barebone devkit (headless ESP32)
idf.py -B build-devkit -DSDKCONFIG=build-devkit/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/devkit/sdkconfig.defaults" \
  -DCELEROS_BOARD=devkit set-target esp32
idf.py -B build-devkit build flash -p /dev/ttyUSB0 monitor
```

Each board uses its own build directory (`build/`, `build-cyd/`,
`build-watch/`, `build-dog/`, `build-devkit/`) with its cached `sdkconfig`
— that way you can switch targets without reconfiguring.

The two headless boards follow the same shape (no display stack in the
binary):

```bash
# Headless ESP32-S3 devkit (USB Host)
idf.py -B build-devkit-s3 -DSDKCONFIG=build-devkit-s3/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/devkit-s3/sdkconfig.defaults" \
  -DCELEROS_BOARD=devkit-s3 set-target esp32s3
idf.py -B build-devkit-s3 build flash -p /dev/ttyACM0 monitor

# ESP32-CAM (camera node)
idf.py -B build-cam -DSDKCONFIG=build-cam/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/esp32-cam/sdkconfig.defaults" \
  -DCELEROS_BOARD=esp32-cam set-target esp32
idf.py -B build-cam build flash -p /dev/ttyUSB0 monitor
```

(`cyd-vspi` builds like the CYD with `-DCELEROS_BOARD=cyd-vspi`.)

## The data partition (LittleFS)

`data/` (system apps, icons and demos) becomes the image of the `littlefs`
partition, mounted at `/local`:

```bash
tools/flash_data.sh smartdisplay /dev/ttyUSB0   # or: cyd|cyd-vspi|spotpear-dog|waveshare-watch|devkit|devkit-s3|esp32-cam <port>
```

The script needs the IDF environment exported (`IDF_PATH`) and uses the
`bin/mklittlefs.bin` + `parttool.py` from the IDF. The partition size is
read from `partitions_{4,16,32}MB.csv` — a single source of truth — and a
board's `boards/<board>/data/` overlay is layered on top of `data/` when
it exists (that's how the Dog Face app gets into the dog).

Tip: to push a single app without reflashing the whole partition,

```bash
python3 tools/celerctl.py apps install "data/apps/Settings"
```

## Testing without hardware (desktop harness)

The Node harness covers the pre-installed apps (Terminal, Snake, App Store
and the hub_apps) with the device APIs stubbed:

```bash
node test/js_harness/run.js
```

## Local OTA test server

To test the OTA flow without the hub:

```bash
python3 tools/ota_server.py --board smartdisplay
```

The device discovers it through `/local/ota_url.txt` (or by pointing
`ota_url` to `http://<your-ip>:10234`). Details in
[OTA updates](/Celer-Brasil/CelerOS/wiki/OTA-Updates).

## sdkconfig caveats

* The project requires `CONFIG_COMPILER_CXX_EXCEPTIONS=y` (JsonModels and
  OtaManager use try/catch) — already in the defaults.
* Hub/Google via Cloudflare need
  `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_CROSS_SIGNED_VERIFY=y`.
* `CONFIG_CELEROS_USB_NATIVE` (S3, dual TinyUSB CDC) **never** on the
  SmartDisplay 4848S040 — GPIO conflict. See
  [Supported boards](/Celer-Brasil/CelerOS/wiki/Supported-Boards).
