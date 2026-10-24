# Barebone devkit (no display)

**English** | [Português (BR)](/Celer-Brasil/CelerOS/wiki/Devkit-Barebone)

CelerOS runs on a plain ESP32 devkit with **no display at all**: the
"screen" is the on-board LED, the "touch" is the BOOT button, and the
console/celerctl runs on the UART. The whole OS boots exactly like on the
other boards — the launcher is just *invisible* (the display is a stub
panel that discards rendering) — and JS apps run headless: timers,
Storage, Net, FS, GPIO and notifications all work without drawing
anything.

Build with:

```bash
idf.py -B build-devkit \
  -DSDKCONFIG=build-devkit/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/devkit/sdkconfig.defaults" \
  -DCELEROS_BOARD=devkit set-target esp32
idf.py -B build-devkit build flash -p /dev/ttyUSB0 monitor
```

## Hardware assumptions

| Signal | GPIO | Notes |
|---|---|---|
| Status LED | **GPIO2** | Single-channel LED (DOIT DevKit v1 blue LED), active-high, PWM via `System.led`. Boards with the LED elsewhere: edit `main/Boards/devkit/Board.cpp` |
| BOOT button | **GPIO0** | Active-low with pull-up. Input to apps via `System.button()` (API 17) — see below |
| UART0 console | GPIO1/3 | `celerctl` + logs (CH340 or USB-UART bridge). Denied to the JS GPIO API (`gpioDeniedMask`) |
| SD / speaker / battery | — | None on the profile; free GPIOs are available to `System.gpio` |

No touch, no calibration, no backlight: the profile sets
`capacitiveTouch = true` and has no screen hooks, so `ScreenPower` and
`Backlight` are no-ops. Flash budget matches the CYD (4MB, 1.56MB OTA
slots); OTA updates come from the `updates/devkit/` channel.

## The headless interaction model

* **Button as app input** — the profile sets `buttonToApp`, so BOOT no
  longer acts as "home" inside an app: short presses surface through
  `System.button()` (`0` none, `1` short, `2` held ~1.2 s — and holding
  **does** exit the app). On the launcher, a short press relaunches the
  `homeApp`, so the device never gets stuck in the invisible launcher.
* **The app IS the device** — set `/local/autostart.txt` (e.g.
  `celeros.barebone`, via `celerctl push` or the web file manager) or
  build a `homeApp` into the profile. The stock **Barebone** app
  (`data/apps/Barebone`) is the reference: LED patterns switched by BOOT,
  pattern persisted in `Storage`.
* **Runtime errors are dismissible without touch** — the error screen
  waits for a touch *or* a button press.
* **Feature-detect the glass** — `System.getInfo().hasDisplay` is `false`
  and `shape` is `"headless"`; apps that draw should check before
  touching the Canvas.

## WiFi provisioning (no screen!)

The native setup screen and captive portal need a display, so the path is
the shell over UART:

```
celerctl shell
wifi                      # list saved networks
wifi MyNetwork myPass123  # save to NVS and connect (background)
info                      # shows the IP once connected
```

With WiFi up, the [web interface](/Celer-Brasil/CelerOS/wiki/Web-Interface)
works as usual (file manager, `/update` OTA upload, app installs).

## What is intentionally different

* `/screen` and screenshots serve an **empty image** — the stub panel
  keeps no framebuffer (a 240x320x2 buffer does not fit the ~70 KB of
  boot heap on a PSRAM-less ESP32).
* Display-centric apps are excluded from the factory image
  (`boards/devkit/data-exclude.txt`); anything that only draws is dead
  weight here.
* Apps must still yield (`System.delay`/`System.button` in the loop) —
  same watchdog rules as every board.
