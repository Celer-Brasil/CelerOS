# Troubleshooting

**English** | [Português (BR)](/maikramer/CelerOS/wiki/Solução-de-Problemas)

Common problems, in rough order of "you will hit this".

## Build and flash

* **A `sdkconfig.defaults` change had no effect.** An existing build dir
  keeps its cached `sdkconfig`; delete `build*/sdkconfig` (or the whole
  dir) and reconfigure with the full `-DSDKCONFIG_DEFAULTS=...` +
  `-DCELEROS_BOARD=...` line from
  [Building and flashing](/maikramer/CelerOS/wiki/Building-and-Flashing).
* **LovyanGFX missing / weird include errors.** It is a git submodule:
  `git submodule update --init`.
* **`flash_data.sh` fails.** It needs the IDF environment exported
  (`IDF_PATH`) because it uses `mklittlefs` and `parttool` from the IDF.
* **Port busy (`could not open port`).** Only one program per port: close
  `idf.py monitor` (and any serial console) before running `celerctl` or
  flashing. On this desk the SmartDisplay is usually `/dev/ttyUSB0` and
  the CYD `/dev/ttyUSB1`, but check with `python3 tools/celerctl.py
  devices`.

## First boot and touch

* **The device asks to touch crosshair targets.** That is the resistive
  touch calibration (CYD family) — it runs when there is no saved
  calibration and stores it in `/local/touch_cal_p.bin`.
* **Touch is off target / I want to recalibrate.** Delete the calibration
  and reboot:

  ```bash
  python3 tools/celerctl.py rm /local/touch_cal_p.bin
  python3 tools/celerctl.py reboot
  ```
* **Touch needs a firm press.** Resistive panels work that way; press a
  little harder than on a phone, or operate the device from the browser
  ([live screen](/maikramer/CelerOS/wiki/Web-Interface)).

## SmartDisplay screen

* **The whole image shakes a few pixels (only inside games/JS apps).**
  Fixed in the firmware with API level 32: the RGB panel restarts its scan
  every frame from an interrupt, and that interrupt shared a CPU core with
  the JavaScript engine — any delay shifted the picture (~12 px per
  microsecond). Update the firmware (OTA or flash). To check a unit, run
  `lcddma 300 isr` in the serial shell (`celerctl shell "lcddma 300 isr"`):
  `LCD_CAM` must be listed under `CPU 1`, and the underflow count should be
  0 (non-zero means the panel is starving for memory bandwidth).
* **The whole UI scrambles after a custom build.** Don't set
  `CONFIG_ESP32S3_DATA_CACHE_LINE_64B` on the SmartDisplay: the panel reads
  its framebuffer straight from PSRAM and the 64-byte cache line starves it.

## Wi-Fi and clock

* **No credentials stored.** The device opens the `CelerOS-Setup-XXXX`
  access point with a captive portal — configure it from your phone. Wi-Fi
  auto-reconnects if the router drops.
* **Clock shows the wrong time.** Time comes from NTP (`pool.ntp.org`) and
  needs internet access; the timezone is set in Settings → Hora e fuso
  (the launcher clock defaults to UTC on a fresh flash). The setting is
  stored in `/local/config_time.txt` in the form `UTC3|1|1` (POSIX sign
  inverted: `UTC3` = UTC-3).
* **Hub/OTA fails with a TLS error.** Hub and Google sit behind Cloudflare
  and need `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_CROSS_SIGNED_VERIFY=y`
  (already in the defaults — check if your `sdkconfig` is stale, see above).

## Apps

* **An app from the store won't install/open on the CYD.** Bigger apps are
  marked "Requer PSRAM": the CYD has no PSRAM and ~220 KB for the JS heap,
  with a practical ceiling of a ~60 KB `main.js`.
* **App crashes or exits to the launcher.** Watch it live with
  `python3 tools/celerctl.py logcat` and, after a crash, pull the coredump
  with `celerctl coredump` (ELF for GDB/xtensa tools). The last app error
  is also persisted to `/local/lastcrash.txt` (OS version, date, uptime,
  app + full stack; it survives a reboot) — `lasterror` in the serial
  shell reports its size and write time, and the web file manager can read
  it. On debugger builds, `celerctl debug MyApp` pauses at the throw so
  you can inspect the state.
* **`SyntaxError` on device but works in Node.** The engine is Duktape:
  **ES5 only** — no arrow functions, `let`/`const`, `class` or template
  literals. Test the bundled apps on the host with
  `node test/js_harness/run.js`.
* **"install.sh falhou" notification on every boot.** An app ships an
  `install.sh` (background-service setup, API level 42) that failed —
  failure leaves its version marker unset, so the script is retried and
  re-notified at EVERY boot until it passes. It runs in the device `sh`
  restricted mode: dialect `if COND` / `else` / `end` (not Bourne — no
  `then`/`fi`), no quotes, absolute paths inside the app folder and
  `/local/data/<pkg>` only. The notification body names the app; the
  shell's error line is in the `[setup]` entries of
  `celerctl shell "cat /local/log/kern.log"` (note: the on-disk log
  flushes only with the screen off — prefer `celerctl logcat --dump`).
  After fixing, rerun with `celerctl shell "svc setup <pkg>"`; silence
  means the marker closed.
* **`CelerLink is not defined`.** The board was built without Bluetooth
  (`CONFIG_CELEROS_BLUETOOTH`; solid on the SmartDisplay, experimental on
  the CYD). Apps feature-detect with `typeof CelerLink !== "undefined"`.
* **Celer Link doesn't find/connect to the peer.** `scan()` blocks ~2.5 s
  and only sees devices running `CelerLink.start()` (they advertise as
  `Celer-XXXX`); one connection at a time, messages up to 240 bytes.

## Web interface

* **`401 Unauthorized`.** Basic Auth: user `admin`, password shown in the
  Web Server app or `celerctl info` (field `web_pass`).
* **`429 Too Many Requests`.** Several failed logins lock the server for
  30 s — wait and retry with the right password.
* **Mirror is slow.** ~1–2 fps is normal on the CYD (RLE frames over HTTP
  on a 40 MHz SPI panel); the SmartDisplay is faster. Reading the screen
  never freezes the device — frames are grabbed row-block by row-block.
* **The IP changed.** It is shown on the device (Web Server app) and in
  `celerctl info`; prefer a DHCP reservation on your router.

## celerctl

* **`devices` lists nothing.** Check the cable and the port
  (`/dev/ttyUSB*`); make sure no monitor holds it. The tool only speaks
  HostLink — a board running raw ESP-IDF firmware won't answer.
* **Push/pull is slow.** Negotiate a higher baud: `celerctl -b 921600
  push ...` (no-op on USB-native ports, which run at USB speed). With a
  proto-2 firmware the sliding window already removes the per-chunk round
  trip; `--proto 1` forces the legacy path when comparing.
* **Weird/garbled frames after a disconnect.** The parser resynchronizes
  after a cut frame; with proto 2 the CRC32 also discards corrupted
  frames and the transfer retries on its own. A session left at a high
  baud (< 8 s ago) is found automatically on the next open — no more
  unplug/replug for that.
