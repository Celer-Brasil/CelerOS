# CelerOS JavaScript Engine - Comprehensive Reference Manual

**English** | [Português (BR)](JS_API_Guide.pt-BR.md)

Welcome to the **CelerOS JavaScript API Reference**. This document provides deep technical details on the underlying JavaScript engine specifications, performance characteristics, and every native API exposed by the C++ kernel for interacting with the ESP32 hardware.

---
## CelerOS JS Runtime Version
### JS Runtime: v1.0.0
### API Level: 49
---

## 1. Engine Specifications & ECMAScript Compliance

**CelerOS JavaScript Runtime** uses the **Duktape 2.x**

### 1.1 ECMAScript Compliance
- **ES5 / ES5.1 Compliant:** The engine is fully compliant with the ECMAScript 5.1 specification. 
- **Partial ES6 (ES2015) Support:** Supports modern built-ins such as `TypedArrays` (Uint8Array, Int32Array, etc.), `Proxy`, and `Reflect`.
- **Unsupported Modern Syntax:** Because it prioritizes ultra-low memory, modern syntactic sugar is **NOT SUPPORTED**. You cannot use:
  - Arrow functions `() => {}`
  - `let` and `const` (Use `var`)
  - ES6 `class` definitions (Use traditional prototype-based inheritance)
  - Template literals `` `string ${var}` ``
  - `Promise` (the built-in is compiled out to save flash — use the blocking calls instead, e.g. `Net.get`)

### 1.2 Memory & Performance Limits
- **Execution Strategy:** Bytecode compiled natively and executed by a virtual stack machine.
- **Garbage Collection (GC):** Reference counting frees most objects immediately; a full mark-and-sweep (for cycles) runs from `System.delay(ms)` at most once per second, or right away when the heap is tight. The time spent collecting is subtracted from the requested delay.
- **Maximum Heap Size:** ~90KB of usable free RAM per script (when WiFi is disabled). Always minimize dynamic array allocations inside high-speed animation loops.

---

## 2. Global Object: `System`

The `System` object provides low-level hardware-accelerated bindings to the ESP32 OS.

### Display Properties

#### `System.screenWidth()`
- **Returns:** `Integer` — always `240` (CelerOS 1.1+ virtual canvas).
- **Description:** Width of the design canvas apps draw in. On larger panels the runtime scales everything to the physical screen (see the virtual canvas note in section 3).

#### `System.screenHeight()`
- **Returns:** `Integer` — always `320` (CelerOS 1.1+ virtual canvas).
- **Description:** Height of the design canvas apps draw in.

> Hardcoding 240x320 is the intended pattern: the runtime scales drawing,
> sprites and touch to the physical panel, so the same app renders identically
> (and fullscreen) on every board.

### OS Utilities

#### `System.getOSVersion()`
- **Returns:** `String` (e.g., `"1.0.0"`)
- **Description:** Returns the current OS version string.

#### `System.getAPILevel()`
- **Returns:** `Integer` (e.g., `1`)
- **Description:** Returns the OS API Level integer.

#### `System.millis()`
- **Returns:** `Number`
- **Description:** Returns the total uptime of the ESP32 hardware in milliseconds since the device booted. Used for delta-time physics and loop timing. 64-bit clock: never wraps (it used to be a `uint32` that rolled over after ~49 days).

#### `System.micros()`
- **Returns:** `Number`
- **Description:** Returns the total uptime of the ESP32 hardware in microseconds since the device booted. Essential for extreme high-resolution timing (e.g., custom bit-banged protocols). 64-bit clock, exact up to 2^53: `now - t0` never goes negative (the old `uint32` rolled over every ~71 minutes).

#### `System.getTemperature()`
- **Returns:** `Float`
- **Description:** Reads the ESP32's internal core temperature sensor and returns the value in Celsius.

#### `System.hasTemperatureSensor()`
- **Returns:** `Boolean`
- **Description:** Checks if the currently installed ESP32 hardware revision actually supports the internal temperature sensor (some newer chips remove it). Returns `true` if supported.

#### `System.delay(ms)`
- **Parameters:** `ms` (Integer) - The amount of milliseconds to pause execution.
- **Returns:** `undefined`
- **Description:** Pauses JavaScript execution. **CRITICAL:** This function commands the C++ kernel to perform Garbage Collection in the background. If you have an infinite `while(true)` loop, you MUST include a `System.delay(10)` call to prevent the OS from crashing due to heap exhaustion. Capped at 30 s per call (`delay(60000)` waits 30 s; it used to return immediately).

#### `System.delayMicroseconds(us)`
- **Parameters:** `us` (Integer) - The amount of microseconds to pause execution.
- **Returns:** `undefined`
- **Description:** Provides highly accurate sub-millisecond delays natively. This blocks the CPU execution cleanly, without triggering Garbage Collection. Busy wait capped at 1 s (1,000,000 µs) — use `System.delay` for longer waits.

#### `System.print(str)`
- **Parameters:** `str` (String)
- **Returns:** `undefined`
- **Description:** Prints a message to the physical USB Serial Monitor on a connected computer (Baud rate 115200). Useful for debugging variables when the screen is rendering frames.

#### `System.getTouch()`
- **Returns:** `Object` -> `{ x: Integer, y: Integer, touched: Boolean }`
- **Description:** Polls the SPI Touch Controller. 
  - `touched` is `true` if a finger/stylus is pressing the screen.
  - `x` and `y` represent pixel coordinates. If `touched` is `false`, `x` and `y` default to 0.
- **Hidden Exit Trigger:** If a user touches `x >= 200` and `y <= 40` (Top-Right corner), the C++ Kernel will instantly abort the JS Engine and force-close the app to prevent users from getting permanently locked out of the OS.

#### `System.getTouches()` (API 43)
- **Returns:** `Array` -> `[{ id: Integer, x: Integer, y: Integer, size: Integer }, ...]`
- **Description:** Polls ALL fingers on the touch controller (multitouch). Same frame yield as `System.getTouch()` — call ONE of the two per loop, not both.
  - Ordered oldest finger first: index `0` is the primary finger (the one the system UI/chrome tracks).
  - `id` is the controller track id — stable while the finger stays down; use it to tell fingers apart across frames.
  - `size` is the contact area (0 when the controller does not report it).
  - Empty array `[]` when nothing is touching.
  - Glass without multitouch returns at most one point (resistive CYD: 1; the SmartDisplay 4848 and the watch: up to 5).
  - The system chrome (top bar, hidden exit corner, watch edge gestures) consumes the primary finger only — secondary fingers always reach your app untouched.

#### `System.getInfo()`
- **Returns:** `Object` -> `{ totalRAM: Integer, freeRAM: Integer, minFreeRAM: Integer, maxAllocRAM: Integer, cpuFreqMHz: Integer, chipModel: String, chipCores: Integer, chipRevision: Integer, flashSize: Integer, uptimeMs: Integer, appRAM: Integer }`
- **Description:** Returns an object containing the current state of the ESP32 hardware, including memory usage, CPU speed, and hardware specifications. Useful for debugging memory leaks and checking uptime.
  - `minFreeRAM`: The lowest free RAM amount recorded since boot.
  - `maxAllocRAM`: The largest single contiguous block of RAM you can allocate.
  - `appRAM`: Free heap when the current app was launched (before its code was loaded; on boards without PSRAM, internal RAM plus the byte-accessible IRAM the runtime overflows into) — how much RAM this board gives an app. `freeRAM` is measured now, with your app already loaded. Absent on older firmware.
  - `hasDisplay` (API 17, Boolean): `false` on headless boards (barebone
    devkit, no glass). Apps that draw should check this before touching
    the Canvas/screen — on headless boards the panel is a stub that
    discards everything.
  - `shape` (API 15, String): `"rounded"` (glass with dead corners, e.g.
    the watch), `"rect"`, or `"headless"` (API 17, no display).
  - `board`: board id (`"cyd"`, `"devkit"`, ...).
  - `hasSpeaker` (Boolean): a physical speaker exists (analog buzzer or
    I2S amp) — `playTone`/`beep` work.
  - `hasAudio` (API 46, Boolean): the DIGITAL audio pipeline is in the
    firmware (`playWav`, `playMusic`, `sfx`, live TTS). `hasSpeaker` `true`
    with `hasAudio` `false` = tones and beeps only: the speaker is the
    analog buzzer and the digital calls return `false`/`0` (CYD lite
    profile — the feature menu compiles per board).
  - `hasMic` (API 13, Boolean; since API 46 it also requires the build to
    compile the capture channel): `true` exactly when the `Mic` object is
    born — prefer it over `typeof Mic` for one canonical answer.
  - `hasPhysics` (API 46, Boolean): native verlet worlds (`System.verlet*`)
    are compiled in; `false` means the `celeros.physics` dep falls back to
    the interpreted `P.verlet` (slower).

#### `System.button()` (API 17)
- **Returns:** `Integer` — `0` none, `1` short press, `2` held ~1.2 s
- **Description:** Reads the board's physical button 1 as app input (the
  default is the button acting as the OS "home" key). Consumable poll in
  house style: returns the pending event since the last call and resets.
  Always returns `0` on regular boards (no latch there). On `buttonToApp`
  boards (headless devkit) the button no longer exits your app: short
  presses show up here and holding ~1.2 s closes the app. The latch is
  pumped by the same `present()` behind `delay`/`getTouch` — alternate
  `System.button()` with `System.delay(ms)` in your loop. Unread events do
  not leak across apps (reset on app open).

#### `System.getIPAddress()`
- **Returns:** String
- **Description:** Returns the current local IP address of the ESP32 (e.g. "192.168.1.11") if WiFi is connected.

#### `System.isWiFiActive()`
- **Returns:** Boolean
- **Description:** Returns `true` if the ESP32 is currently connected to a WiFi network.

#### `System.restart()`
- **Returns:** None
- **Description:** Instantly reboots the ESP32 hardware.

#### `System.getTime()`
- **Returns:** `String` (e.g., `"14:30"` or `"02:30 PM"`)
- **Description:** Returns the OS-formatted current local time, automatically respecting the user's 12-hour or 24-hour preference setting.

#### `System.getSeconds()`
- **Returns:** Integer (0-59)
- **Description:** Returns the current local second directly from the RTC.

#### `System.epoch()` (API 49)
- **Returns:** Number — seconds since 1970-01-01T00:00:00Z (UTC).
- **Description:** The absolute UTC instant. The other time calls return the user's *local*, formatted time; an app that talks to a cloud service (a ticket's `entered_at` timestamp, a token TTL) needs the absolute clock. Build RFC 3339 strings from it (`new Date(System.epoch() * 1000)` + the `getUTC*` methods — Duktape ships `Date`). Without NTP/RTC sync the value comes from the persisted boot estimate; when the stamp matters, sanity-check it (an implausible value means the clock never synced).

#### `System.getDate()`
- **Returns:** `String` (e.g., `"15/06/2026"`)
- **Description:** Returns the current local date formatted as DD/MM/YYYY.

#### `System.getYear()`
- **Returns:** `Integer` (e.g., `2026`)
- **Description:** Returns the current local 4-digit year.

#### `System.getMonth()`
- **Returns:** `Integer` (1-12)
- **Description:** Returns the current local month.

#### `System.getDay()`
- **Returns:** `Integer` (1-32)
- **Description:** Returns the current local day of the month.

#### `System.getTimezone()`
- **Returns:** `String` (e.g., `"UTC-8"`)
- **Description:** Returns the user's currently configured timezone offset region.

#### `System.prompt(promptMsg, initialText, options)`
- **Parameters:** 
  - `promptMsg` (String) - Header text displayed above the keyboard.
  - `initialText` (String) - Text pre-filled into the keyboard input box.
  - `options` (Object, optional) - `{mask, hint}`:
    - `mask: true` (API level 7) hides the typed text behind bullets with a show/hide button next to the X (passwords, PINs).
    - `hint: "num"` (API level 11) opens the numeric page instead of QWERTY (big 3x3 dial pad). It is a suggestion, not a lock — the mode key ("ABC"/"123") stays available. Unknown values fall back to QWERTY, so older firmware degrades gracefully.
- **Returns:** `String`
- **Description:** Completely suspends JavaScript execution and opens the native C++ full-screen QWERTY touch keyboard (with shift — double-tap toggles caps lock —, two symbol pages and a PT-BR accent page). Once the user taps "OK", execution resumes and the typed string is returned. Returns an empty string `""` if the user taps "X" (cancel).

---

## 3. Display Drawing Pipeline

**Automatic frame buffer (CelerOS 1.2+, boards with PSRAM):** every draw call goes to an off-screen frame the size of the panel, and the frame is shown on the glass only when the app *yields*: `System.delay()`, `System.getTouch()`, `System.prompt()`, and right before blocking calls (`Net.*`, `System.wifiScan/wifiConnect`, `System.otaCheck/otaStart` — also after each OTA progress callback —, `FS.copyFile/copyDirectory/removeDirectory`). Apps that clear and redraw the whole screen on every event no longer flicker, with no code change. `System.present()` forces the frame to the glass (animations or long computations that never yield); `System.isBuffered()` tells whether the board has the frame (`false` on the CYD, where drawing still goes straight to the TFT).

> Rule of thumb: draw the complete screen, then yield. Something drawn right before a long C++ call that is not listed above appears only at the next yield — call `System.present()` first.

### Color Engine
Colors in JS are always **16-bit RGB565** integers (e.g. `0xF800` = red) on every board — use `System.color(r, g, b)` or `System.theme()` to build them. (CelerOS 1.2 fixed a runtime bug where, on 16-bit panels, RGB565 values were passed through as RGB888 and came out with the wrong hue.)

> **Virtual canvas (CelerOS 1.1+):** apps always run in a **240x320 design canvas**. On boards with larger panels (e.g. the SmartDisplay 4"/480x480), `System.screenWidth()/screenHeight()` report 240/320, all drawing coordinates/sizes are scaled to the physical screen, sprites are allocated at the scaled size, and `System.getTouch()` returns coordinates in the 240x320 space — the same app renders identically (and in fullscreen) on every board. Colors are RGB565 everywhere; the runtime converts to the panel's native format.

#### `System.color(r, g, b)`
- **Parameters:** `r`, `g`, `b` (Integers 0-255)
- **Returns:** `Integer` (16-bit packed color)
- **Description:** Packs 24-bit 8/8/8 RGB color values into the 16-bit 5/6/5 RGB format expected by the hardware.

### Graphics APIs

#### `System.fillScreen(color)`
- **Parameters:** `color` (16-bit Integer)
- **Description:** Floods the entire screen with a single color. Extremely fast as it bypasses the pixel loop and uses hardware SPI DMA directly.

#### `System.drawPixel(x, y, color)`
- **Parameters:** `x` (Int), `y` (Int), `color` (16-bit Int)
- **Description:** Renders a single pixel.

#### `System.drawLine(x1, y1, x2, y2, color)`
- **Parameters:** `x1`, `y1`, `x2`, `y2` (Ints), `color` (16-bit Int)
- **Description:** Uses Bresenham's line algorithm to render a straight line between two points.

#### `System.drawRect(x, y, w, h, color)`
#### `System.fillRect(x, y, w, h, color)`
- **Parameters:** `x`, `y` (Top-Left coords), `w` (Width), `h` (Height), `color` (16-bit Int)
- **Description:** Draws hollow or filled rectangles.

#### `System.drawRoundRect(x, y, w, h, radius, color)`
#### `System.fillRoundRect(x, y, w, h, radius, color)`
- **Parameters:** `x` (Int), `y` (Int), `w` (Int), `h` (Int), `radius` (Int), `color` (Int)
- **Description:** Fills a rectangle with rounded corners using the specified color.

#### `System.drawBMP(path, x, y)`
- **Parameters:** `path` (String), `x` (Int), `y` (Int)
- **Returns:** `Boolean` (`true` if successful, `false` if unsupported or file missing)
- **Description:** Reads a 16-, 24- or 32-bit `.bmp` image from the FileSystem (`/sd/` or `/local/`) and streams it at `x, y` without using JavaScript RAM. The image is scaled with the virtual canvas (a 240-px-wide BMP fills the screen width on every board).
#### `System.drawPNG(path, x, y)`
- **Parameters:** `path` (String), `x` (Int), `y` (Int)
- **Returns:** `Boolean` (`true` if successful, `false` if path/decode failed)
- **Description:** Draws a `.png` image from the FileSystem (`/sd/` or `/local/`) at `x, y`, decoded in streaming line-by-line (no full-framebuffer RAM spike; only the ~44 KB deflate window during decode). PNG alpha is blended over the existing background. Like every other draw call, the image is scaled with the virtual 240x320 canvas (CelerOS 1.2+; before, the PNG kept its native pixel size on large panels). Interlaced PNGs are supported. Ideal for backgrounds and photos; use `System.drawIcon()` for launcher-style 64x64 icons.

#### `System.drawJPG(path, x, y)` (API 36)
- **Parameters:** `path` (String), `x` (Int), `y` (Int)
- **Returns:** `Boolean`
- **Description:** Draws a baseline `.jpg` (the output of `Pack.snap` or `Camera.save`) decoded in 8x8 blocks (no full image in RAM), scaled with the virtual canvas like `drawPNG`.

#### `System.drawCircle(x, y, radius, color)`
#### `System.fillCircle(x, y, radius, color)`
- **Parameters:** `x`, `y` (Center coords), `radius` (Int), `color` (16-bit Int)
- **Description:** Renders perfect hollow or filled circles.

#### `System.drawTriangle(x1, y1, x2, y2, x3, y3, color)`
#### `System.fillTriangle(x1, y1, x2, y2, x3, y3, color)`
- **Parameters:** `x1, y1, x2, y2, x3, y3` (Vertex coords), `color` (16-bit Int)
- **Description:** Renders hollow or filled triangles. Useful for 3D projections or UI indicators.

#### `System.drawFastVLine(x, y, h, color)`
- **Parameters:** `x, y` (Start coords), `h` (Height), `color` (16-bit Int)
- **Description:** Hardware-accelerated vertical line drawing. Substantially faster than `System.fillRect()` for rendering raycaster slices.

#### `System.drawFastHLine(x, y, w, color)`
- **Parameters:** `x, y` (Start coords), `w` (Width), `color` (16-bit Int)
- **Description:** Hardware-accelerated horizontal line drawing.

---

### Hardware Double Buffering (Mini-Sprites)
Double Buffering allows you to draw shapes invisibly to an off-screen RAM buffer (a Sprite) and then "push" the completed frame to the physical screen in a single instant hardware DMA transfer. This **completely eliminates 3D screen flickering**.

> [!CAUTION]
> **Severe RAM Limitations & Heap Fragmentation**
> The ESP32-WROOM has very limited contiguous RAM (~320KB total, but due to fragmentation from WiFi/WebManager, the max allocatable block is often under ~30KB). Allocating a massive buffer (e.g. `240x320` at 16-bit color takes 153.6 KB) will cause the engine to instantly return `false` from `System.createSprite`.
> **Always** keep your buffers as small as possible. The recommended architecture is **Sliced Rendering**: divide the screen into small horizontal slices (e.g. 10 slices of 32px height) or vertical columns.
> `System.createSprite()` now automatically triggers aggressive Garbage Collection to defragment memory before allocation, and will automatically fall back to lower-quality 8-bit color to prevent crashes if RAM is too fragmented for 16-bit color.

#### `System.createSprite(width, height)`
- **Parameters:** `width, height` (Integer)
- **Returns:** `Boolean` (`true` if successfully allocated a 16-bit or 8-bit color buffer in RAM, `false` if RAM exhausted)
- **Description:** Allocates a persistent off-screen Sprite buffer in RAM. Automatically forces GC and falls back to 8-bit color to secure contiguous memory.

#### `System.bindSprite(enabled)`
- **Parameters:** `enabled` (Boolean)
- **Description:** If `true`, **ALL** subsequent `System.draw...` and `System.fill...` API calls are automatically intercepted and drawn *invisibly* to the persistent Sprite instead of the screen. If `false`, resumes drawing directly to the TFT.

#### `System.pushSprite(x, y)`
- **Parameters:** `x, y` (Integer - Top-left coordinates to paste the buffer on the physical screen)
- **Description:** Pushes the entire hidden buffer onto the physical screen instantly via DMA. The buffer remains in RAM and can be modified and pushed again.

#### `System.deleteSprite()`
- **Description:** Instantly destroys the Sprite and frees the RAM. You must call this when you are done to prevent severe memory leaks!

### Text APIs

#### `System.setTextColor(fg_color, bg_color)`
- **Parameters:** `fg_color` (Foreground), `bg_color` (Background)
- **Description:** Sets the active text rendering colors. Providing a `bg_color` enables hardware-level text overwriting, wiping the previous pixels completely without needing to draw a rectangle manually.

#### `System.setTextSize(size)`
- **Parameters:** `size` (Integer 1-5)
- **Description:** Multiplies the default pixel-font scaling.

#### `System.drawString(text, x, y, font)`
- **Parameters:** 
  - `text` (String) - Text to render.
  - `x`, `y` (Ints) - Top-Left coordinate to begin rendering.
  - `font` (Integer 1, 2, or 4) - Hardware font selection. 2 is standard, 4 is bold/large.
- **Description:** Renders high-speed string buffers to the display. Text is UTF-8 and every font covers Latin-1 (U+0020..U+00FF), so Portuguese accents work: `"Configurações"`, `"25°C"`. Characters outside that range (em dash, curly quotes, €, emoji) are not drawn.

---

## 4. Hardware GPIO (General Purpose Input/Output)

CelerOS enables direct hardware control of the ESP32 microcontroller pins via `System.gpio`.

### Constants
- `System.gpio.INPUT`
- `System.gpio.OUTPUT`
- `System.gpio.INPUT_PULLUP`
- `System.gpio.HIGH`
- `System.gpio.LOW`

### Functions

#### `System.gpio.pinMode(pin, mode)`
- **Parameters:** `pin` (Integer hardware pin number), `mode` (GPIO Constant)
- **Description:** Sets the physical electrical state of an ESP32 pin (e.g. setting pin 2 to OUTPUT to drive an LED).
- Every `System.gpio` function throws `RangeError` for a pin that does not exist or is reserved by the system (flash/PSRAM) — touching those crashed the device.
- Reserved also means board-specific pins the firmware denies (`gpioDeniedMask` in the board profile): the PSRAM data lines GPIO 33-37 on octal-PSRAM boards (driving those corrupts the heap), the console UART pins (43/44 on the S3, 1/3 on the ESP32), and the touch I2C on the SmartDisplay (19/45). The message is the same `RangeError`.

#### `System.gpio.digitalWrite(pin, state)`
- **Parameters:** `pin` (Integer), `state` (HIGH or LOW)
- **Description:** Outputs 3.3V (HIGH) or 0V (LOW) to a specific pin.

#### `System.gpio.digitalRead(pin)`
- **Parameters:** `pin` (Integer)
- **Returns:** `Integer` (1 for HIGH, 0 for LOW)
- **Description:** Reads the physical voltage state of a pin.

#### `System.gpio.analogRead(pin)`
- **Parameters:** `pin` (Integer)
- **Returns:** `Integer` (0 to 4095)
- **Description:** Triggers the ESP32 12-bit Analog-to-Digital Converter (ADC) to read a continuous voltage level.

#### `System.gpio.analogWrite(pin, pwmValue)`
- **Parameters:** `pin` (Integer), `pwmValue` (0 to 255)
- **Description:** Initiates an automatic hardware PWM (Pulse Width Modulation) signal on a pin. Useful for motor control or dimming LEDs.

#### `System.gpio.pulseIn(pin, state, [timeout])`
- **Parameters:** `pin` (Integer), `state` (HIGH or LOW), `timeout` (Optional Integer in microseconds, default and cap 1,000,000)
- **Returns:** `Integer` (Length of the pulse in microseconds, or 0 if timeout occurred)
- **Description:** **Native Hardware Pulse Measurement.** Suspends the JS engine and delegates to the C++ Kernel to accurately measure the duration of an incoming hardware pulse. This bypasses the JavaScript execution overhead entirely, giving you absolute microsecond precision (crucial for reading HC-SR04 ultrasonic sensors).

#### `System.gpio.servo(pin, angle)` (API 10)
- **Parameters:** `pin` (Integer), `angle` (Number, 0 to 180; fractions allowed for smooth ramps; values outside are clamped)
- **Returns:** `Boolean` (`false` for an invalid output pin or no free channel — up to **5 servos at once**)
- **Description:** drives a standard hobby servo (SG90 class) with a 50 Hz PWM (500–2500 µs pulse). The LEDC channel is allocated on the first write to a pin. Robots: pair it with the Celer Link — a remote app sends commands, the robot's app maps them to legs (`System.gpio.servo(13, 90)`).
- **Note:** the channels come from the LEDC channels the board leaves free (never the backlight, `System.beep` or `System.led` ones); `analogWrite` channels 0..2 are only used as a last resort, on its own timer. Leaving the app releases every servo (no holding torque).

#### `System.battery()` (API 10)
- **Returns:** `Number` — **cell** voltage in mV (the pin reading already scaled by the board's divider), or `-1` if the board has none.
- **Description:** averaged ADC reading with ~2 s cache. On the SpotPear robot dog it reads the 2:1 Li-ion divider on GPIO2 (~4100 mV on USB, ~3300 mV = empty).

#### `System.micLevel()` (API 10)
- **Returns:** `Number` — sound level `0..100` (short RMS capture on the left I²S slot), or `-1` if the board has no microphone.
- **Description:** briefly blocking (~100 ms); pending drawings are flushed first. The first call initializes the I²S RX channel (~300 ms).

#### `System.touchPad()` (API 10)
- **Returns:** `Number` — `1` touched, `0` released, `-1` if the board has no capacitive pad.
- **Description:** standalone capacitive pad (the robot dog's "head"). The reference level is calibrated on the first call — keep the pad untouched at that moment.

#### `System.neopixel(strip, colors)` (API 10)
- **Parameters:** `strip` — 0-based WS2812 strip index; `colors` — array of `0x00RRGGBB` values (1..8 LEDs).
- **Returns:** `Boolean` — `false` if the board has no strips or arguments are invalid.
- **Description:** updates a whole strip via RMT (non-DMA). Example: `System.neopixel(0, [0xFF0000, 0, 0x00FF00])`. Strips are turned off when the app exits.

#### `System.gpio.servoOff(pin)` (API 10)
- **Parameters:** `pin` (Integer)
- **Returns:** `Boolean**
- **Description:** stops the PWM on the pin and frees the channel — the servo goes limp (no holding torque). Call it when a movement ends to save power.

---

## 5. Unified File System (FS)

The `FS` global object controls the C++ virtual file system layer. It dynamically routes operations to the physical SD Card (prefixed with `/sd/`) or the high-speed Internal Flash (prefixed with `/local/`).

#### `FS.exists(path)`
- **Parameters:** `path` (String)
- **Returns:** `Boolean`
- **Description:** Validates if a file or folder physically exists.

#### `FS.readTextFile(path)`
- **Parameters:** `path` (String)
- **Returns:** `String` (or `null` if the file doesn't exist)
- **Description:** High-speed RAM loader. Reads the entire file into a contiguous String block in RAM. Do not use on files larger than ~20KB!

#### `FS.writeTextFile(path, content)`
- **Parameters:** `path` (String), `content` (String)
- **Returns:** `Boolean`
- **Description:** Erases any existing file and writes the entirety of `content` to disk.

#### `FS.appendTextFile(path, content)`
- **Parameters:** `path` (String), `content` (String)
- **Returns:** `Boolean`
- **Description:** Appends the given string to the end of an existing file.

#### `FS.deleteFile(path)`
- **Parameters:** `path` (String)
- **Returns:** `Boolean`
- **Description:** Permanently deletes a file from the disk partition.

#### `FS.renameFile(pathFrom, pathTo)`
- **Parameters:** `pathFrom` (String), `pathTo` (String)
- **Returns:** `Boolean`
- **Description:** Renames a file or moves it between directories on the same partition.

#### `FS.listDir(path)`
- **Parameters:** `path` (String)
- **Returns:** `Array[String]`
- **Description:** Iterates through a directory and returns an array of absolute file paths (e.g. `["/local/app.js"]`).

#### `FS.mkdir(path)`
- **Parameters:** `path` (String)
- **Returns:** `Boolean`
- **Description:** Creates a new directory.

#### `FS.rmdir(path)`
- **Parameters:** `path` (String)
- **Returns:** `Boolean`
- **Description:** Removes an empty directory.

#### `FS.isDirectory(path)` / `FS.isFile(path)`
- **Parameters:** `path` (String)
- **Returns:** `Boolean`
- **Description:** Evaluates if the target path is a directory or a file.

#### `FS.getFileSize(path)`
- **Parameters:** `path` (String)
- **Returns:** `Integer` (bytes)
- **Description:** Returns the total physical size of a file in bytes.

#### `FS.getTotalSpace(drive)` / `FS.getUsedSpace(drive)` / `FS.getFreeSpace(drive)`
- **Parameters:** `drive` (String - either `"/local"` or `"/sd"`)
- **Returns:** `Integer` (bytes)
- **Description:** Returns exact storage metrics for the specified partition.

#### `FS.getFileMD5(path)`
- **Parameters:** `path` (String)
- **Returns:** `String` (Hex representation of MD5 hash)
- **Description:** Leverages hardware-accelerated `mbedtls` cryptographic engine to stream the file and return its precise MD5 hash.

#### `FS.mountSD()` / `FS.unmountSD()`
- **Parameters:** None
- **Returns:** `Boolean` (mount returns success status)
- **Description:** Triggers an SPI remount/unmount of the physical SD card.

---
**Take Apps and Games from the CelerOS Hub As Example: https://os.celer.tec.br/store (catalog) — see also `data/apps/` in this repository**
---
*Document Version: 1.1 (Built for CelerOS JavaScript Environment)*

## 6. Networking: `Net` (API Level 2)

HTTP client for JS apps. Calls are **blocking** (the script waits for the
response, timeout 10s). HTTP and HTTPS are both supported; responses larger
than 32 KB are truncated.

> Memory note: HTTPS (TLS) takes ~45 KB of heap during the call and shares
> memory with the JS runtime (~90 KB) — keep payloads small, especially on
> boards without PSRAM.

#### `Net.isConnected()`
- **Returns:** Boolean
- **Description:** Returns `true` if WiFi is currently connected.

#### `Net.get(url)`
- **Parameters:** `url` (String, `http://` or `https://`)
- **Returns:** String (response body) or `null` on failure (DNS, timeout, HTTP status outside 2xx).
- **Description:** Performs an HTTP GET. Follows redirects. Throws an error if WiFi is not connected. The body is **capped at 32 KB** (`NET_MAX_BODY`): a larger response is silently truncated to the cap — no error is raised. For big files use `Net.download`, which streams to disk with no cap.

#### `Net.getJSON(url)`
- **Parameters:** `url` (String)
- **Returns:** Parsed JS object/array, or `null` on request failure.
- **Description:** Like `Net.get()`, but parses the body as JSON. Same **32 KB body cap** as `Net.get()`: a JSON bigger than the cap arrives truncated and the parse throws — keep server files you fetch with it under 32 KB (the App Store keeps every catalog file under the cap for exactly this reason). A malformed JSON body throws a visible script error.

#### `Net.post(url, body, contentType)`
- **Parameters:**
  - `url` (String)
  - `body` (String) — request body
  - `contentType` (String, optional — defaults to `"text/plain"`, e.g. `"application/json"`)
- **Returns:** String (response body) or `null` on failure.
- **Description:** Performs an HTTP POST. Throws an error if WiFi is not connected.

#### `Net.request(opts)` (API 49)
- **Parameters:** `opts` (Object):
  - `url` (String, required)
  - `method` (String, optional — `"GET"` (default), `"POST"`, `"PUT"`, `"PATCH"`, `"DELETE"`)
  - `body` (String, optional — up to 64 KB)
  - `contentType` (String, optional — used when a `body` is given)
  - `headers` (Object, optional — up to 6 custom headers, e.g. `{apikey: "...", Authorization: "Bearer ..."}`)
  - `timeoutMs` (Number, optional — clamped to 1000..20000, default 10000)
- **Returns:** `{status: Number, body: String}` on ANY HTTP response, or `null` when the transport itself fails (DNS/TCP/TLS/timeout, or no WiFi).
- **Description:** Request with custom headers and a visible status code. `Net.post` cannot send headers (API gateways such as Supabase require an `apikey` header) and collapses every failure into `null`, leaving the script unable to tell "no network" from a 4xx business refusal — `Net.request` answers both. Header names/values reject CR/LF and other control characters (request-line injection) and are capped at 32/256 chars. The response `body` follows the same 32 KB cap as `Net.get`. This is what the CelerPark totems use to talk to the `parking-gate` edge function.
- **Example:**
```javascript
var r = Net.request({
    url: "https://supabase.example.br/functions/v1/parking-gate",
    method: "POST",
    body: JSON.stringify({action: "heartbeat", device_id: "lane-01"}),
    contentType: "application/json",
    headers: {apikey: key, Authorization: "Bearer " + key}
});
if (r === null) System.print("offline");
else System.print("HTTP " + r.status + ": " + r.body);
```

#### `Net.download(url, filePath, onProgress)` (API 6)
- **Parameters:**
  - `url` (String, `http://` or `https://`)
  - `filePath` (String) — destination VFS path (e.g. `"/local/apps/<pkg>/main.js.new"`)
  - `onProgress` (Function, optional) — called per chunk with `(bytesSoFar, totalBytes)`; `totalBytes` is `-1` when the server sends no `Content-Length`
- **Returns:** Boolean — `true` on success; on failure the partial file is removed and any existing file at `filePath` is left **intact** (the download goes to `filePath + ".part"` and only replaces the destination on success)
- **Permission:** requires `"fs"` in addition to `"net"`; the destination follows the `FS` rules (canonical path under `/local` or `/sd`, no system files).
- **Description:** Downloads straight to a file in **streaming** mode — the body never goes through the JS heap, so there is **no 32 KB cap** (this is how the App Store updates apps; the hub enforces the size limits). Errors inside `onProgress` don't abort the download. This is what the App Store uses to install/updates apps: it writes to a `*.new` staging file, validates `FS.getFileMD5()` against the catalog checksum, then `FS.renameFile()`s it over the old code (atomic within the same filesystem — never rename across `/local` ↔ `/sd`).

### Example

```javascript
var quote = Net.getJSON("http://economia.awesomeapi.com.br/json/last/USD-BRL");
if (quote === null) {
    System.print("request failed");
} else {
    System.print("USD/BRL: " + quote.USDBRL.bid);
}
```

## 12. API Level 3 — System Apps (W8)

Introduced with the W8 rework: the system screens (Settings, App Store,
Installer, Help, Web Server) are now JS apps living in LittleFS. Level 3
adds the bindings they need — theme colors, file copy, OTA control and the
app package format.

### 12.1 Theme & Icons

#### `System.theme()`
- **Returns:** Object `{bg, card, raised, stroke, accent, accentD, onAccent, text, textDim, ok, warn, err}` — the OS theme palette as RGB565 values, ready to pass to any drawing call. System apps use it to inherit the CelerOS look on every board.

#### `System.textWidth(str, font)`
- **Parameters:** `str` (String), `font` (Number, default 2)
- **Returns:** Number — string width in pixels in the virtual 240x320 space. `System.drawString` uses top-left datum; center manually: `x = 120 - (System.textWidth(s, 2) >> 1)`.

#### `System.drawIcon(name, x, y)`
- **Parameters:** `name` (String: `appstore`, `installer`, `settings`, `help`, `web`, `time`, `about`, `update`, `app`, `wifi_on`, `wifi_off`, `terminal`, `calculator`, `snake` — or an absolute `/local`/`/sd` path), position in virtual space
- **Description:** Draws a 64x64 icon from `/local/icons/<name>.png` with alpha blending (legacy `.bin` accepted).

### 12.2 App Lifecycle

#### `System.exitApp()`
Closes the app and returns to the launcher (same as touching the top-right corner). The exit is "sticky": if an app `try/catch` swallows the exit error, the next `System.delay`/`getTouch`/`keypadPoll` rethrows it, so the app still closes.

#### `System.rescanApps()`
Asks the launcher to rescan `/local/apps` and `/sd/apps`. Call after installing/removing apps.

#### `System.launchApp(packageName)` (API 16)
Asks the launcher to open another app by `packageName` (a path or folder name also works) and ends the current app through the same clean exit as `exitApp()` — the launcher consumes the request once the app exits. The target app's permission consent still applies. Main use case: **watchface plugins** — the widget line an app installs on the watch opens the source app when tapped (see the *Watchface-Plugins* wiki page).

#### `System.openWifiSetup()`
Pushes the native WiFi setup screen. Since JS apps run synchronously, call `System.exitApp()` right after — the setup screen takes over when the script yields.

#### `System.present()`
Shows the automatic frame buffer on the glass now (no-op without it). Only needed in loops that never call `delay()`/`getTouch()`.

#### `System.fontHeight(font)`
Height in pixels (virtual canvas) of a numeric font (1/2/4) as rendered on this board — use `y - (System.fontHeight(f) >> 1)` to center text vertically.

#### `System.setClip(x, y, w, h)` / `System.clearClip()`
Restricts drawing to a rectangle of the virtual canvas (anything outside is discarded) — e.g. a scrolling list whose partial rows must not paint over the header. `clearClip()` restores the full screen. The clip is reset when an app starts.

#### `System.isBuffered()`
Returns `true` when the board has the automatic frame buffer (PSRAM boards).

### 12.3 Hardware & System

#### `System.setBrightness(level)` / `System.getBrightness()` / `System.backlightSupported()`
Backlight control (5–100). On boards without PWM backlight `backlightSupported()` returns `false` and the setters are no-ops.

**Brightness, volume, auto-brightness and screen timeout are device settings:** only `"system"` apps (Settings) persist them to NVS. For other apps the change lasts **while the app runs** and the previous value comes back when it closes (a fade effect no longer writes flash every frame).

#### `System.setAutoBrightness(on)` / `System.getAutoBrightness()` (API 7)
Automatic brightness from the board's light sensor: the user's level becomes the maximum and the screen dims down to 30% of it in the dark (smoothed, checked once per second, also while apps run). `getAutoBrightness()` returns `true`/`false`, or `null` on boards without a light sensor. Persisted as the `auto_brightness` setting.

#### `System.wifiStatus()`
- **Returns:** `{connected, ip, webServer, savedNetworks}` (Booleans/String).

#### `System.webActive()` / `System.webSetActive(bool)`
Web server (file manager + web upload) state and toggle — live, no reboot.

#### `System.md5(str)`
- **Returns:** lowercase hex MD5 of the string (same format as `FS.getFileMD5`). Kept for legacy data only — **do not use for passwords** (see `setPin` below).

#### App permissions (`app.json` → runtime, F4)
`"permissions": ["fs","net","gpio","system","mic"]` gates what the runtime registers for the app: without `fs` there is no `FS` object, without `net` no `Net`, without `gpio` no `System.gpio`, without `mic` no `Mic` (recording; API 19), and without `system` the device-affecting calls (`restart`, `factoryReset`, `otaCheck/otaStart`, `openWifiSetup`, `web*`, `wifiConnect`, PIN `setPin/verifyPin/pinClear`, clock `setTimezone/setManualTime/set24hFormat/setNtpEnabled`) are absent. Paths given to `FS` (and to `drawPNG`/`drawBMP`/`playWav`/`Net.download`) must be **canonical** under `/local` or `/sd`: no `//`, `.` or `..` (denied for every app). **Apps without the field keep everything** (compat with the existing store); system apps (`"system": true`) are **not** an exception: they also get only what they declared and the owner granted — `"system": true` itself (grid order, removal protection) only counts with the `"system"` capability declared and granted. `FS.appData()` returns the app's private folder `/local/data/<packageName>/` (created on first call) — use it for scores and state instead of loose files in `/local`.

#### `System.toast(message)` / `System.beep(freq, ms)`
`toast` queues a system notification (shows immediately when the UI is live — `CELEROS_APP_TASK` — or when the app exits). `beep` plays a tone on the board's speaker output (blocking; 20–20000 Hz, up to 5000 ms). The CYD drives its speaker connector (GPIO26, on-board amplifier); the SmartDisplay feeds the on-board Nsiway NS4168 digital amplifier over I2S (a sine wave, softer than the CYD's square wave). Returns `false` on boards without a speaker.

#### `System.led(r, g, b)` (API 7)
Sets the board's RGB status LED, 0–255 per channel (PWM). `System.led()` or `System.led(0, 0, 0)` turns it off; the LED is also switched off when the app exits. Returns `false` on boards without an LED. The CYD has one on the back (R=GPIO4, G=GPIO16, B=GPIO17).

#### `System.lightLevel()` (API 7)
Ambient light from the board's light sensor: `0` (dark) to `100` (lit room); `-1` without a sensor. On the CYD the sensor (LDR next to the screen) only separates "lit" from "getting dark": any normally lit room reads close to 100.

#### `System.relay(n, on)` / `System.relayState(n)` / `System.relayCount()` (API 8)
Relay lines of the board. `n` is 1-based (`1` = hardware line L1); `relay(n, true/false)` switches it and returns `false` without relays or with an out-of-range index, `relayState(n)` returns `1`/`0` (or `-1`), and `relayCount()` returns how many lines exist (`0`..`3`). Relays start **off** at boot. Available on the SmartDisplay 4848S040 "Y" wall-switch SKUs (L1=GPIO40, L2=GPIO2, L3=GPIO1) when the firmware is built with `CONFIG_CELEROS_SMARTDISPLAY_RELAYS` — the same pins drive the I2S speaker on the standard SKU, so a board has one or the other.

`System.getInfo()` also reports `hasLed`, `hasLightSensor` and `hasSpeaker` for feature detection — and, since API 46, the build capabilities `hasAudio` (digital pipeline) and `hasPhysics` (native verlet).

#### `System.setting(key)` / `System.setting(key, value)`
System settings kept in NVS (`web_on`, `nowifi`, `install_sd`, `brightness`, ...). Read (open to all) returns the string or `null`; **write requires `"system"`** and returns `true` (key 1–15 chars, value up to 63). Use `Storage` for the app's own data. System apps use this instead of loose `/local/*.txt` files (legacy files are imported and removed on first boot).

#### `System.setPin(pin)` / `System.verifyPin(pin)` / `System.pinClear()` / `System.pinState()`
Settings PIN, handled natively since 1.3: salted SHA-256 (`settings_pin2.bin`), no hash exposed to JS. `setPin`, `verifyPin` and `pinClear` **require `"system"`** (`pinState` is open). `setPin` accepts 4–6 digits; `verifyPin` transparently upgrades a legacy MD5 PIN on first success and, after 5 failures in a row, refuses attempts for 30 s (the penalty doubles on each failure, up to 15 min). `pinState()` returns `0` (no PIN), `1` (active) or `2` (corrupted — flag set but file missing; the UI should ask for a redefinition).

#### `System.webAuthInfo()` / `System.webAuthSetPass(pass)`
Web server credentials (Basic Auth since 1.3 — every route requires the password). `webAuthInfo()` → `{user, pass}` for display to the device owner; `webAuthSetPass` accepts 6–31 characters.

#### `System.otaCheck()`
- **Returns:** `{fetchFailed, available, hasFirmware, version, url, changelog, guide, type}` — result of the device's update channel manifest.

#### `System.otaStart(url, progressCallback)`
- **Parameters:** `url` from `otaCheck()`, callback receiving `percent` (0–100) during the flash
- **Returns:** `{ok, error?}` — flashes the inactive OTA slot; on success the app should offer `System.restart()`.

#### `System.setTimezone(tz)` / `System.setManualTime(year, month, day, hour, minute)` / `System.set24hFormat(bool)` / `System.get24hFormat()` / `System.setNtpEnabled(bool)` / `System.getNtpEnabled()`
Time configuration (persisted by TimeManager). The setters **require `"system"`**. `setTimezone` returns `false` (changing nothing) for an empty TZ, one longer than 48 chars or one with `|`/control characters; `setManualTime` returns `false` when a field is out of range (year 2020–2099).

#### `System.factoryReset(mode)`
- `"configs"` — clears configuration files in `/local` and saved WiFi networks, **keeps** apps and icons.
- `"total"` — formats the whole LittleFS partition (**apps are erased**; recovery requires `tools/flash_data.sh` or `celerctl apps install`). Always confirm twice in the UI.

#### `Net.beginGet(url)` / `Net.pollGet(handle)` / `Net.cancelGet(handle)` (non-blocking)
`beginGet` starts the GET on a background task and returns a handle (`-1` if no free slot or WiFi down — the firmware logs which).

**One style at a time:** the async task stack plus a blocking `Net.get` running in the same app can exhaust internal RAM on tight boards (the request then fails with a connect error). Use the async API *or* the blocking one within a single app. `pollGet` returns `null` while running, then `{done:true, ok, status, body, error}` (body capped at 32 KB, like the blocking calls). `cancelGet` abandons a request (the slot frees itself when the task times out; tasks never get killed mid-TLS). Two concurrent requests max.

### 12.4 WiFi (Net)

- `Net.wifiScan()` → array `[{ssid, rssi, secure}]` (blocking, ~2s).
- `Net.wifiConnect(ssid, password)` → Boolean (blocking, up to 15s; saves credentials).
- `Net.wifiDisconnect()` — disconnects STA, keeps saved networks.

### 12.5 File copy (FS)

- `FS.copyFile(src, dst)` → Boolean — binary safe.
- `FS.copyDirectory(srcDir, dstDir)` → Boolean — recursive copy.
- `FS.removeDirectory(path)` → Boolean — **recursive** delete (unlike `FS.rmdir`, which requires an empty dir).

### 12.6 App package (app.json)

```json
{
  "name": "My App",
  "packageName": "celeros.myapp",
  "version": "1.0.0",
  "author": "you",
  "description": "...",
  "type": "Utility",
  "category": "Utility",
  "api": 3,
  "topbar": true,
  "system": true,
  "order": 30,
  "icon": "settings"
}
```

- `system: true` — system app: sorted first in the launcher grid (native system screens are apps like this now).
- `order` — position among system apps.
- `icon` — icon name in `/local/icons`. **Preferred:** ship `icon.png` (64x64 with alpha; decoded on load — CelerOS 1.2+) inside the app folder — it overrides the name and travels with the package when installed via SD/celerctl. Legacy `icon.bin` (v2 RGB565+A4) is still accepted.
- `packageName` — identity used by the launcher dedup, installer and App Store.
- `topbar: true` — fixed system topbar (see section 14). Without the field the app runs full screen with the retractable topbar.
- Install paths: `/local/apps/<Name>/` (LittleFS) or `/sd/apps/<Name>/` (SD card). Reinstall/update with `celerctl apps install <folder> [--sd]`.

---

## 13. API Level 5 — Docked Keyboard (W9)

Introduced with the W9 apps (Terminal, Calculator, Snake): a **non-blocking
keyboard session** the app controls from its own loop, so text input can live
side by side with the app's UI (a shell input line, chat fields, forms…).
`System.prompt()` (section 2) stays the right choice for simple one-shot
dialogs.

The keyboard renders on the **same target as the app** (app sprite > PSRAM
frame > display), so it survives `present()` and composes with the automatic
frame buffer on every board. With `field: false` the keyboard is drawn as a
compact block anchored to the bottom of the screen; everything above
`System.keypadRect().y` belongs to the app.

### 13.1 Session API

#### `System.keypadOpen(options)` → Boolean
- **Parameters:** `options` (Object, optional): `{title, initial, maxLen, field, mask, hint}`.
  - `title` (String) — header label (only shown with a field).
  - `initial` (String) — pre-filled text.
  - `maxLen` (Number, default 64, max 256) — buffer limit.
  - `field` (Boolean, default true) — draw the native input field + X button on top. `field: false` draws the bare keyboard docked at the bottom (the app echoes the line itself).
  - `mask` (Boolean, default false, API level 7) — hide the field text behind bullets with a show/hide button next to the X.
  - `hint` (String, API level 11) — `"num"` opens the numeric page (same layout as `prompt`).
- **Returns:** `false` if a session is already open (one at a time) or there is no display.
- **Description:** Opens the keyboard session and draws it immediately. Enter (OK) does **not** close the session: it clears the buffer and keeps the keyboard open — ideal for line-at-a-time UIs. The session ends on `X` (only with `field: true`, reported as a `cancel` event) or `System.keypadClose()`.

#### `System.keypadPoll()` → Object|null
- **Returns:** `null` when nothing happened, or one event object per call:
  - `{type: "change"}` — the buffer changed (key/backspace/space); read it with `System.keypadText()`.
  - `{type: "enter", text: "..."}` — OK pressed; `text` is the line, the buffer is cleared afterwards.
  - `{type: "cancel"}` — X pressed; the session **closed itself** (redraw your screen, the keyboard is gone).
- **Description:** Pumps the touch for the keyboard, redraws its keys when needed (key press feedback, layout pages, cursor blink) and reports at most one event per call. The top-right OS exit corner keeps working while the keyboard is open. Call this every loop iteration while the session is open.

#### `System.keypadText()` → String
Current input buffer (same text the native field would show).

#### `System.keypadRect()` → `{x, y, w, h}`
Area occupied by the keyboard in the 240x320 virtual canvas (`h` is 0 when the session is closed). The app must not draw inside it.

#### `System.keypadDraw()`
Re-blits the keyboard after the app repaints a region that overlaps it (not needed if the app only draws above `keypadRect().y`).

#### `System.keypadClose()`
Closes the session and frees the keyboard. The next `present()` restores the app's frame. Sessions are also closed automatically when an app exits.

### 13.2 Example — input line above a docked keyboard

```javascript
var T = System.theme();
System.keypadOpen({ field: false, maxLen: 96 });
var kbTop = System.keypadRect().y;   // app owns 0..kbTop

while (true) {
    var ev = System.keypadPoll();
    if (ev && ev.type === "enter") {
        handleLine(ev.text);          // ex.: comando, mensagem, busca...
        redrawScreen();
    } else if (ev && ev.type === "change") {
        redrawInputLine(System.keypadText());
    }
    System.delay(20);                 // GC + present (obrigatorio)
}
```

Reference implementation: `data/apps/Terminal/main.js` (preinstalled W9 app).

### 13.3 Global color constants (API 5 fix)

`BLACK, WHITE, RED, GREEN, BLUE, YELLOW, CYAN, MAGENTA, ORANGE, DARKGREY`
are now registered as global RGB565 constants (before W9 the registration
was a no-op — apps had to use `System.color()`). `System.color()` and
`System.theme()` remain the recommended way to get colors.

---

## 14. System Topbar

Every JS app runs under the **system topbar** — a strip drawn by the core with
the app's name and the **X** exit button on the right. The mode comes from the
package, not from code:

- **Fixed** — `"topbar": true` in `app.json`: the strip is always visible and
  the 240x320 virtual canvas maps to the area below it (`getTouch` coordinates
  already account for the strip). Use it for system-style apps with
  menus/lists/forms — Settings, App Store, Terminal.
- **Retractable (default)** — no `topbar` field: the app runs **full screen**
  (the canvas maps 1:1 over the whole panel, exactly like pre-topbar apps).
  Swiping down from the **right third** of the top edge reveals the strip for
  **3 seconds**; the whole reveal gesture is consumed by the system — the app
  never sees its press/release. Ideal for games (Snake, 2048, Breakout).

Notes:

- In fixed mode touches in the strip never reach the app; in retractable mode
  only while the strip is visible (X included — it fires on release, debounced).
- With watch gestures enabled (touch boards) the top edge is split in thirds:
  left pull-down opens **quick settings** and center opens the **notification
  center** (both leave the app by the clean X path); the right third belongs
  to the retractable reveal. Games must not rely on downward swipes that start
  in the left/center thirds of the top strip.
- On PSRAM boards the strip is composed into the frame (no flicker, and hiding
  it restores the area atomically). On the CYD (direct drawing) the strip is
  drawn only when it changes, and the display is clipped below it so the app
  cannot paint over it (`System.setClip` is intersected with that area); when
  it hides, it lingers until the app repaints that region.
- Nothing to code in either mode: the same main.js renders correctly on both —
  the field in `app.json` is the whole contract.

### 14.1 Custom content (API 6)

Apps can put their own text and touchable **chips** in the strip:

#### `System.topbarText(text)`
Replaces the app name shown in the strip (`""` restores the name). Redraws automatically.

#### `System.topbarButtons(labels)` → Number
Replaces the strip content with up to 3 touchable chips, laid out right-to-left before the X (`labels` = array of short strings, e.g. `["+", "Limpar"]`). Returns how many fit. `[]` clears them.

#### `System.topbarPop()` → String|null
Pops the oldest chip tap since the last call (FIFO). The chip highlights while pressed and fires on release (same debounced contract as the X).

```javascript
System.topbarText("Toques: 0");
System.topbarButtons(["+", "Limpar"]);
while (true) {
    var id = System.topbarPop();
    if (id === "+") { n += 10; System.topbarText("Toques: " + n); }
    else if (id === "Limpar") { n = 0; System.topbarText("Toques: 0"); }
    System.delay(20);
}
```

In retractable mode chips are tappable only while the strip is visible. Apps
should feature-detect (`typeof System.topbarText === "function"`) to stay
installable on older firmware.

Reference implementation: `data/apps/Touch Test/main.js`.

---

## 15. Celer Link (API 9)

Bluetooth LE link between nearby CelerOS devices. The classic use case: put a
CelerOS board on a robot, `CelerLink.start()` there, and drive it from another
CelerOS (e.g. the 4848 SmartDisplay) with `scan()`, `connect()` and `send()`
inside a JS app.

**Availability:** only on boards built with Bluetooth (`CONFIG_CELEROS_BLUETOOTH`;
the SmartDisplay has it, the CYD is experimental). Feature-detect with
`typeof CelerLink !== "undefined"` to stay installable everywhere.

**Security:** the link itself still has no over-the-air encryption, but
since **API 11** there is optional **code pairing**: the `start()` side turns
on `{pairing: true}`, every new connection gets a fresh 6-digit code that only
the **local** app can see (`status().code` — draw it on the robot's screen)
and the controller types it back via `verify()`. Until the right code lands,
`send()`/`poll()` stay closed. Approved controllers are remembered by the
firmware (up to 4) and reconnect without a code. The code travels in the
clear: this stops the casual neighbor from connecting and driving the robot,
not someone sniffing the radio. Fine for toys and prototypes; do not use it
for anything sensitive.

Model: one connection at a time, messages up to **240 bytes**, best effort.
Who wants to be controlled calls `start()` (BLE advertising + GATT server,
visible as `Celer-XXXX`). The controller scans, connects and exchanges
messages. Both directions work; the link is symmetric after connecting.

#### `CelerLink.start([name], [options])` → Boolean
Becomes controllable: starts advertising and the GATT server. `name` is the
BLE device name (up to 29 bytes). The default is the device's pack name —
the same one CelerNet announces (`Pack.me().name`, setting `celernet_name`,
`Celer-XXXX` until renamed; API 40). The first call anywhere initializes the
Bluetooth stack (~300 ms). The name reverts to the default when the app
exits.

`options` (object, **API 11**): `{pairing: true}` enables the pairing gate —
every new connection then requires the 6-digit code (see `verify()` and
`status().code`). **Since API 14 pairing is the default**: `start()` /
`start(name)` already require the code (before, any BLE device nearby could
send commands). An open link needs an explicit `{pairing: false}`. Show
`status().code` on the peripheral app's screen while `status().pairing` is
`true`. Applies to connections made after the call.

Paired peers become a keyed *bond* (API 14): the key is derived from the
code + that connection's challenge, and on reconnect the central answers a
fresh challenge — spoofing the MAC of a paired controller no longer opens the
channel. API 11 bonds (MAC only) are discarded: each controller pairs once
more. A central running older firmware asks for the code on every
connection.

#### `CelerLink.stop()` → Boolean
Stops advertising (the device is no longer discoverable).

#### `CelerLink.scan([timeoutMs])` → Array
Blocking scan (default 2500 ms) for nearby CelerOS devices. Returns
`[{id: "AA:BB:CC:DD:EE:FF", name: "Celer-9F2A", rssi: -55, node: 0xEEFF}]`,
strongest signal first (up to 16 devices). `node` (API 40) is the device's
pack node id — the same `id` it has in `Pack.members()`/`CelerNet.nodes()`
(as a number; the mesh shows it as 4 hex digits).

#### `CelerLink.connect(idOrName, [timeoutMs])` → Boolean
Connects to a device from the last `scan()`, by `id` (MAC) or `name`.
Blocking (default 4000 ms, max 8000): the timeout covers the whole setup —
link, MTU exchange, discovery, subscription and reading the peer's pairing
state. Returns `true` only with the link established; if the peer requires a
code, `status().pairing` comes back `true` and the data channel only opens
after `verify()` (until then `connected`/`send()` stay `false`). Replaces any
current connection.

#### `CelerLink.disconnect()` → Boolean
Drops the current connection (including one pending pairing).

#### `CelerLink.verify(code)` → Boolean (API 11)
Controller side: sends the 6-digit `code` to the connected peer that requires
pairing. Blocking (~3 s). `true` = accepted, channel open (`status().verified`
and `connected` become `true`); `false` = rejected, link dropped or invalid
code. Idempotent: on an already-verified (or pairing-free) link it returns
`true` without touching the radio. Rules on the requiring side: **3 wrong
codes** drop the connection; **60 s** without typing drops it and a fresh
code is generated on the next connection.

#### `CelerLink.unpair([id])` → Boolean (API 11)
Robot side: forgets the paired controllers remembered by the firmware. With
no argument it clears **all**; with `"AA:BB:CC:DD:EE:FF"` only that one. The
memory survives reboots and app switches (NVS) — it is what lets paired
controllers reconnect without a code. Returns `false` when `id` was not
paired or is invalid.

#### `CelerLink.send(message)` → Boolean
Sends a message to the connected peer (up to 240 bytes). A **string** goes as
raw bytes; an **object** is serialized as JSON — structured messaging without
any parser on the firmware side (the receiver decides how to read it).
Returns `false` when not connected, when the message does not fit the
negotiated MTU (between CelerOS devices: 253 bytes, so 240 always fits; a
phone without an MTU exchange takes only 20) or, on the `start()` side, when
the peer has not subscribed to notifications yet. A message is never
delivered truncated.

#### `CelerLink.poll()` → String|null
Pops the oldest received message (FIFO of 8). A full queue drops the
**oldest** message (in a remote control the newest command matters; see
`status().dropped`). The queue is cleared on every new connection. `null` when
empty. Call it from your loop, like `keypadPoll` — ideally draining it until
`null` so stale commands do not pile up.

#### `CelerLink.status()` → Object
`{connected, peer, node, listening, role, name, pairing, verified, code, mtu, rssi, pending, dropped}`:

| Field | Meaning |
|-------|---------|
| `connected` | Boolean — link **authorized** for `send()` (false while pairing is pending) |
| `peer` | `"AA:BB:CC:DD:EE:FF"` or `""` |
| `node` | Number (API 40) — the peer's pack node id (`0` when disconnected) |
| `listening` | Boolean — advertising requested via `start()` |
| `role` | `"central"` (we connected), `"peripheral"` (they connected to us) or `""` |
| `name` | our advertising name |
| `pairing` | Boolean (API 11) — handshake pending: show the code (peripheral) or ask the user (central) |
| `verified` | Boolean (API 11) — data channel open (`true` on a pairing-free link) |
| `code` | 6-digit pairing code — **only** on the peripheral while `pairing`; never leaves the device |
| `mtu` | negotiated ATT MTU (0 when disconnected); max payload = `mtu - 3` |
| `rssi` | connection signal in dBm (0 when unavailable) |
| `pending` | messages waiting for `poll()` |
| `dropped` | messages dropped on a full queue since the app started |

Link loss: the supervision timeout is ~2 s. Robots should stop on their own
when commands stop arriving (keepalive) — Celer Remote repeats `move` every
250 ms while an arrow is held and sends `stop` on release; Dog Face stops
after 900 ms without a `move` or when the link drops.

Leaving the app resets the session automatically (disconnects and stops
advertising); call `stop()`/`disconnect()` only for mid-app control.

### Example — code pairing (API 11)

```javascript
// ROBOT side (peripheral): show the code while the handshake pends
CelerLink.start("Celer-Dog", {pairing: true});
while (true) {
    var st = CelerLink.status();
    if (st.pairing) {
        // draw st.code BIG on the screen (Dog Face uses seven-segment
        // digits); it expires after 60 s and a new one is born per connection
        System.fillScreen(0);
        System.setTextColor(0xFFFF);
        System.drawString(st.code, 40, 140, 4);
    }
    var msg = CelerLink.poll();
    if (msg !== null && st.verified) { /* commands: only arrive when open */ }
    System.delay(30);
}

// CONTROLLER side: after connect() returns true
if (CelerLink.status().pairing) {
    var cod = System.prompt("codigo na tela do robo", "");
    if (!cod || !CelerLink.verify(cod)) { System.exitApp(); }  // rejected
}
```

Compatibility: peers on firmware older than API 11 keep working — an old
central connecting to a pairing-enabled robot gets a closed channel and
controls nothing; a new central on an old peer sees no `pairing` and goes
straight to control. Paired controllers are remembered in NVS (up to 4, most
recent first): reconnections come in without a code; `unpair()` forgets.

### Example — robot side (controllable)

```javascript
// "bot": receives commands and acts (beep/LED here; servos on a robot)
// open link only for the demo: in a real app keep pairing (the default)
// and show status().code on screen
CelerLink.start(null, {pairing: false});  // "Celer-XXXX" on the air
System.drawString("esperando controle...", 10, 10);
while (true) {
    var msg = CelerLink.poll();
    if (msg !== null) {
        var cmd = null;
        try { cmd = JSON.parse(msg); } catch (e) {}
        if (cmd && cmd.type === "move") {
            System.beep(50, 10);
            System.led(0, (cmd.speed || 0) > 128 ? 255 : 0, 0);
        }
    }
    System.delay(20);
}
```

### Example — controller side (the 4848)

```javascript
// "remote": scans, connects and sends D-pad taps as JSON
var peers = CelerLink.scan(3000);
if (!peers.length) { System.drawString("nenhum CelerOS por perto", 10, 10); System.delay(2000); System.exitApp(); }
if (!CelerLink.connect(peers[0].id)) { System.drawString("conectou nao", 10, 10); System.delay(2000); System.exitApp(); }

var last = "";
while (true) {
    var t = System.getTouch();
    var dir = "";
    if (t.touched) {
        if (t.y < 100) dir = "up"; else if (t.y > 220) dir = "down";
        else if (t.x < 100) dir = "left"; else if (t.x > 140) dir = "right";
    }
    if (dir !== last) {
        last = dir;
        CelerLink.send(dir ? {type: "move", dir: dir, speed: 200} : {type: "stop"});
    }
    System.delay(20);
}
```

The two examples also work as a pair with the nRF Connect app on a phone
(connect to `Celer-XXXX`, write to the characteristic, enable notifications).

## 16. API Level 12 — Timers, Storage, multi-sprites and binary FS

### 16.1 Timers (`setTimeout` / `setInterval` / `clearTimeout` / `clearInterval`)

Browser-style globals. They fire **where the app yields** — the start of
`System.delay`, `System.getTouch`, `System.keypadPoll` and the blocking
calls (`Net.*`, `FS.getFileMD5`, ...). A tight loop that never yields never
sees timers fire (and trips the watchdog on its own). With no `Promise` in
Duktape, this is the cooperative "event loop" foundation.

```js
var iv = setInterval(function () {
    clock(System.getTime());
}, 1000);            // once per second, as long as the app yields

setTimeout(function () {
    clearInterval(iv);
    System.toast("done");
}, 60000);
```

- **Returns:** id `>= 1`, unique within the app (`0` = failed — 8 live timers max). The id of a timer that already fired or was cleared never cancels the new timer that reused its slot. 10 ms floor.
- **A callback error PROPAGATES**: the app dies with the error screen and
  the callback's stack (same policy as any binding). A late interval fires
  **once** on the next yield (catch-up, no burst).
- Timers die with the app — nothing crosses apps.

### 16.2 `Storage` — private per-app persistence

CelerOS's localStorage: key-value in NVS with a **namespace of its own per
`packageName`** (`System.setting` is global and apps collided). No
`permissions` needed.

```js
Storage.set("hiscore", "3250");
var r = Storage.get("hiscore", "0");   // default when absent
Storage.remove("hiscore");
Storage.clear();                       // wipes EVERYTHING of this app
```

- Key: 1–15 chars (NVS limit). Value: string up to 4 KB (`\0` bytes are
  kept); numbers and booleans are serialized (`get` **always returns a
  string** — `""` when missing and no default is given).
- `set` returns `false` when writing would leave the NVS without the space
  reserved for the system (WiFi credentials, calibration, settings) — the
  partition is small (~20 KB) and shared.
- A `packageName` longer than 11 chars uses a namespace hashed from the full
  name (it used to be truncated, so `celeros.notes`/`celeros.notepad` shared
  data); data in the old namespace is copied on first open.
- Loose `.js` scripts (no app.json) share the `app__anon` namespace.
- `Storage.clearFor(packageName)` wipes ANOTHER app's Storage — requires the
  `"system"` capability (App Store 2.1.3+ uses it on uninstall; `clear()`
  only wipes the CALLING app's own Storage).

### 16.3 Multi-sprites (`System.useSprite`)

`System.createSprite(w, h)` now returns an **id** `1..8` (`0` = failed) and
the new sprite becomes the target of subsequent operations (old apps that
ignore the return keep working). `System.useSprite(id)` switches targets:
`0` = frame/display, `1..8` = an existing sprite. `System.deleteSprite(id)`
deletes a specific sprite (no argument deletes the current one).

```js
var bg = System.createSprite(240, 200);   // id 1
var hero = System.createSprite(24, 24);   // id 2 — becomes current
System.fillRect(0, 0, 24, 24, System.color(255, 0, 0));
System.useSprite(bg);
System.fillRect(0, 0, 240, 200, 0);
System.pushSprite(0, 40);
System.useSprite(hero);
System.pushSprite(10, 50);
System.useSprite(0);                      // back to the frame
```

Up to **8 sprites with PSRAM, 1 without** (API 29 doubled the pool;
`System.spriteSlots()` reports the board's limit — the silent 8-bit fallback
for huge sprites still applies).

### 16.4 Binary FS (`FS.readFile` / `FS.writeFile`)

Byte-level read and write — each file byte becomes one character (0–255) of
the string. `readTextFile` truncated at the first `\0`; these do not.

```js
FS.writeFile("/local/data.bin", String.fromCharCode(1, 0, 2, 255));
var d = FS.readFile("/local/data.bin", 512);  // optional maxLen (default 16KB, cap 64KB)
if (d !== null && d.charCodeAt(1) === 0) { /* ... */ }
```

- `readFile` returns `null` when the file does not exist. `writeFile`
  accepts up to 64 KB per call.
- The security jail rules (system files require `"system"`) apply to both.

### 16.5 `System.setTextDatum(datum)`

Anchor of `drawString` on the current target: `0`=TL (default — previous
behavior), `1`=TC, `2`=TR, `4`=ML, `5`=MC, `6`=MR, `8`=BL, `9`=BC, `10`=BR.
Centering text no longer needs the manual `textWidth` dance. The datum is
reset to `0` for every app.

```js
System.setTextDatum(5);               // middle-center
System.drawString("GAME OVER", 120, 160, 4);
System.setTextDatum(0);               // good practice: restore default
```

## 17. API Level 12 — Power and time

### 17.1 Screen timeout — `System.setScreenTimeout(ms)` / `System.screenTimeout()`

With no touch for `ms` milliseconds the backlight turns off; the **first**
touch after that only wakes the screen (the event is consumed — nothing is
clicked blind). `0` = always on (default). Accepted range: 10 s to 4 h.
Persisted across boots and also configurable in **Settings → Display**
("Tela apaga"). Board without PWM backlight: no-op.

### 17.2 Deep sleep — `System.deepSleep(ms[, wakePin])` *(requires `"system"`)*

Real sleep: the chip powers down and **wakes up into a full reboot** (apps
do not survive — the next boot's `resetReason` is `"deep sleep"`). The `ms`
timer always wakes; an optional `wakePin` also wakes on HIGH level (button,
touch INT...). Typical use: battery robots waking hourly to check the
network.

```js
System.deepSleep(3600000);        // 1 hour
System.deepSleep(0, 4);           // pin 4 only (0 ms = error)
System.deepSleep(600000, 4);      // whichever comes first
```

### 17.3 Daily alarm — `System.setAlarm(h, m[, msg])` / `clearAlarm()` / `getAlarm()`

Fires at the **next** occurrence of `h:m` (today if it has not passed yet,
otherwise tomorrow) with an **ALARME: msg** toast, then disarms. In RAM
(does not survive a reboot); needs a valid time (NTP or manual — changing
the timezone or the time recomputes the next occurrence). Checked by the
launcher: while an app is open the toast shows when the app closes.
`System.getAlarm()` returns `{armed, hour, minute, msg}` or `null` (message
up to 64 chars).

### 17.4 Persistent time

Without an external RTC the time now survives reboots: the system saves the
epoch to NVS every 10 minutes and restores it at boot (minute-level
accuracy — powered-off time is not counted). Before, every boot without
network fell back to 1970.

### 17.5 Watchdog change for legitimate apps

`System.getTouch()` (and every yield point) now feeds the system watchdog:
**game loops that only call `getTouch`/`present` no longer reboot the
device** after 15 s. A pure JS loop with NO API call at all still trips the
WDT — in that case the app is genuinely stuck (and `celerctl shell "exit"`
recovers the device remotely).

## 18. API Level 12 — Melodies, notifications and toolkit widgets

### 18.1 `System.playTone(notes)` — blocking melody

`notes` is an array of pairs `[[freq, ms], ...]` or flat `[freq, ms, freq,
ms, ...]`. Each note plays on the board's audio hardware (same as `beep`;
I2S speaker or LEDC buzzer) with the watchdog fed between notes. Limits:
1-64 notes, 20 Hz-20 kHz for 1-2000 ms each, 15 s total. Returns the number
of notes played. Blocking: draw before calling.

### 18.1b `System.playWav(path)` — WAV file from the FS

Plays a **16-bit PCM WAV** (mono or stereo, 8–48 kHz) straight from the FS
(`/local` or `/sd`), streamed over I2S — the file is never fully loaded
into RAM, the watchdog is fed per chunk and volume follows
`System.setVolume`. Blocking. `true` = played; `false` = board without an
I2S speaker, missing file or invalid header. Jail rules apply (system
files require `"system"`).

```js
System.playWav("/sd/alert.wav");
```

### 18.2 `System.notify(title[, msg])` + notification center

Toast **now** + history entry in `/local/notifications.txt` (cap 20,
protected by the jail — apps only write through this call). **Settings →
Notificações** lists everything with date/time plus a "Limpar notificações"
action. Apps with `"system"` can also read via `System.notifications()`
(array of `{epoch,title,msg}`) and clear via `System.notificationsClear()`.

```js
System.notify("Low battery", "15% left");
```

### 18.3 Per-variant OTA (relay SKUs "Y")

`update.json` may declare `"variant"` (e.g. `"smartdisplay-y3"`). The device
compares against its own variant (relay boards are `smartdisplay-y1`/`-y3`)
and **refuses** updates for another variant — and a device WITH relays also
refuses a manifest WITHOUT a variant (the generic image is what uninstalls
relay support). No `variant` in the manifest: installs only on relay-less
devices (retro-compatible with the current channel).

### 18.4 Native Kui widgets (C++ toolkit)

`Switch` (on/off pill with onChange), `Slider` (0..100 with onLiveChange/
onChange), `ProgressBar` (0..100 fill) and `Spinner` (spinning arc) join the
native toolkit (`main/UI/Kui.h`) for system screens — same patterns as
`Button`/`List` (immediate mode, press feedback, Rect hit-testing).

## 19. API Level 13 — Watch sensors (IMU), weekday, keepAwake

Added for the Waveshare AMOLED 2.06 watch board (QMI8658 IMU); on boards
without the hardware the calls degrade gracefully (feature-detect with
`System.getInfo().hasImu`).

### 19.1 `Sensors.accel()`

- **Returns:** `Object` -> `{ x, y, z }` in **g** (±8 g range), or `null` if
  the board has no IMU.
- **Description:** latest sample from the motion task (cached at ~30 Hz —
  no I²C on the call itself, safe in loops).

### 19.2 `Sensors.steps()`

- **Returns:** `Integer` — steps of the current day (rolls over at
  midnight, persisted across reboots), or `-1` if the board has no IMU.
- **Description:** pedometer ported from the reference watch firmware
  (peak/valley over dynamic acceleration, LPF baseline, 280 ms minimum
  cadence).

### 19.3 `Sensors.temp()`

- **Returns:** `Number` — IMU die temperature in °C, or `-255` if
  unavailable (on-demand I²C read; do not call in tight loops).

### 19.4 `System.getWeekday()`

- **Returns:** `Integer` — `0` (Sunday) .. `6` (Saturday), local time.

### 19.5 `System.keepAwake(bool)`

- **Description:** holds the screen awake (skips the dim/AOD/off ladder of
  the ScreenPower state machine) while `true`, or for `ms` milliseconds
  with `System.keepAwake(ms)` (expires by itself). Games and workout apps
  call it on start. **Released automatically when the app closes.** No-op
  on boards without screen states.

### 19.6 `System.setVolume(pct)` / `System.getVolume()` (API 13)

- **Parameters/Returns:** `pct` 0..100 (default 100; persisted only by
  `"system"` apps — for other apps it lasts while the app runs).
- **Description:** OS-wide audio volume. On I²S boards it scales the
  waveform; on the watch codec (ES8311) it also sets the hardware volume
  register. `System.beep`/`playTone` pick it up automatically. Buzzer
  (LEDC) boards have fixed gain — the value is still stored.
  `System.getInfo().hasMic` tells whether `System.micLevel()` is available
  (robot dog and the watch).

## 20. API Level 14 — Permission consent, default pairing, prompt

### 20.1 Permission consent

The `app.json` `"permissions"` field is now a **request**: the first time the
app opens (or when an update asks for something new) the launcher shows
**"Permitir <app>? Acesso a: arquivos, rede, GPIO, sistema"**. The runtime
gets only what was granted (declared ∩ granted). An app without the field
asks for all four — declare only what you use. Grants live in NVS, keyed by
`packageName` + install folder (a copy in another folder asks again). Apps
already installed the first time a consent-aware firmware boots are granted
automatically. Uninstalling (launcher or the store's `Storage.clearFor`)
forgets the grant.

`packageName` must be `[A-Za-z0-9._-]` (up to 64, no `..`); otherwise it is
ignored (the app is identified by its name).

Matching `FS` rules:
- **Writing** under `/local/apps` and `/sd/apps` (other apps' code) requires
  `"system"` — reading stays open.
- **Another** app's `/local/data/<pkg>/` is invisible (read and write); the
  app's own `FS.appData()` stays open.
- Trees: copying all of `/local` or `/local/data`, or removing / using the
  `/sd` root as a destination, requires `"system"`.

### 20.2 `CelerLink.start` requires pairing by default

See `CelerLink.start` above. Pass `{pairing: false}` for an open link.

### 20.3 `System.prompt(msg, initial, {nullOnCancel: true})`

With `nullOnCancel`, cancelling (X) returns `null`; without it you still get
`""` (indistinguishable from confirming an empty value). The keyboard also
serves the remote `exit` and the physical buttons while open (JS timers pause
until it closes).

### 20.4 Alarm and toasts while an app is open

`System.setAlarm` fires even with an app open: the system bar turns into an
**ALARME: msg** banner for 8 s and the device beeps 3 times.
`System.toast`/`notify` called during the app now show when it closes (the
first one used to "expire" before it was ever drawn).

### 20.5 `FS.listDir` without a cap

Returns every entry (it used to silently stop at 128).

## 21. API Level 15 — Watch experience: battery, screen geometry, step history

Added with the smartwatch work (board `waveshare-watch`); every call
degrades gracefully on other boards.

### 21.1 `System.batteryInfo()` (API 15)

- **Returns:** `Object` -> `{ mv, pct, charging, usb, full }`, or `null` when
  the board has no battery reading.
  - `mv`: cell voltage (same value as `System.battery()`).
  - `pct`: 0..100. From the PMU fuel gauge (watch AXP2101) or estimated
    from a LiPo discharge curve over `mv` on boards with a plain divider.
    `-1` if unknown.
  - `charging` / `usb` / `full`: charge state; always `false` on boards
    without a PMU.
- **Description:** cached for ~2 s by the firmware, cheap to call once per
  frame.

### 21.2 `System.getInfo()` new fields

| Field | Type | Meaning |
|---|---|---|
| `hasBattery` | Boolean | `System.batteryInfo()` returns data |
| `board` | String | board profile id (e.g. `"waveshare-amoled206"`) |
| `inset` | Integer | safe margin in **virtual** px (240-wide space) to keep content off the rounded glass corners; `0` on rectangular screens |
| `shape` | String | `"rounded"` (rounded-corner glass) or `"rect"` |

### 21.3 `Sensors.stepHistory()` (API 15)

- **Returns:** `Array` of `{ date, steps }` for the last closed days (up to 7,
  most recent first). `date` is an integer `yyyymmdd`. Empty array without
  an IMU or before the first midnight.
- **Description:** the pedometer now rolls over at midnight while the watch
  is running (before, only on boot) and archives the finished day.

### 21.4 Home app behavior

On boards with a home app (watch: the watchface) the BOOT button at the
launcher root opens it, and the launcher returns to it after
`home_idle_s` seconds idle (system setting, default 30, `0` disables).

### 21.5 Multiple alarms and timer

#### `System.alarms()` / `System.addAlarm(alarm)` / `System.updateAlarm(id, alarm)` / `System.removeAlarm(id)` (API 15)

#### `System.setTimer(seconds, label)` / `System.getTimer()` / `System.cancelTimer()` (API 15)

Alarms now live in a system scheduler persisted in NVS (survive reboot and
deep sleep — the watch wakes up by timer for the next event). When one
fires, any open app is closed and a full-screen alarm screen rings (works
with the screen off or in AOD) with **Snooze 5 min** / **Stop**; no answer
for 2 minutes snoozes automatically.

| Call | Returns | Notes |
|---|---|---|
| `System.alarms()` | `Array` of `{ id, hour, minute, days, enabled, label, next }` | `days` = bitmask, bit0 Sunday .. bit6 Saturday, `0` = once (disables itself after ringing). `next` = epoch seconds of the next ring, `0` when off |
| `System.addAlarm({hour, minute, days?, enabled?, label?})` | `id` or `-1` | up to 8 alarms; label up to 40 chars |
| `System.updateAlarm(id, {...})` | `Boolean` | replaces the alarm in that slot |
| `System.removeAlarm(id)` | `Boolean` | |
| `System.setTimer(seconds, label?)` | `Boolean` | one countdown (1..86400 s), runs in background, replaces the current one |
| `System.getTimer()` | `{ remaining, label }` or `null` | |
| `System.cancelTimer()` | — | |

`System.setAlarm/getAlarm/clearAlarm` (API 12) keep working: they map to
slot `0` as a one-time alarm, now persistent.

### 21.6 `System.unreadNotifications()` (API 15)

- **Returns:** `Integer` — unread notifications (no permission needed; the
  content itself still requires `"system"` via `System.notifications()`).
  Notifications are marked read when the user opens the notification
  center (watch: swipe up from the bottom edge).

`System.getInfo()` also gains `screenW` / `screenH`: the physical glass size,
for apps drawing geometry (e.g. analog hands) that must compensate the
non-uniform 240x320 scaling.

### 21.7 `Phone` — the paired phone (Gadgetbridge)

Exists only on boards built with `CONFIG_CELEROS_PHONE_LINK` (the watch):
feature-detect with `typeof Phone !== "undefined"`. The watch shows up in
**Gadgetbridge** (Android) as a **Bangle.js**; pairing asks for the 6-digit
code shown on the watch. Phone notifications land in the system
notification center, the clock is set from the phone, and the calls below
expose the rest.

#### `Phone.status()` (API 15)

- **Returns:** `{ enabled, connected, passkey, name }` — `passkey` is the
  pairing code on screen right now (`0` when none); `name` is the Bluetooth
  name the phone sees (`Bangle.js xxxx`).

#### `Phone.forget()` (API 15)

- Erases the pairing (NimBLE bonds) and drops the phone; forget the watch
  on Android too before pairing again. Requires `"system"`.

The system handles the rest without app code: a full-screen pairing code,
an incoming-call screen (Decline/Answer go back to the phone), notifications
dismissed on the watch disappear on the phone, the firmware version shows
in Gadgetbridge, and battery/steps are reported when they change or when
Gadgetbridge asks. Android text is reduced to what the fonts draw (emoji
dropped, typographic quotes/dashes turned into ASCII).

#### `Phone.music(cmd)` / `Phone.musicInfo()` (API 15)

- `cmd`: `"play"`, `"pause"`, `"playpause"`, `"next"`, `"previous"`,
  `"volumeup"`, `"volumedown"`. Returns `false` when not connected.
- `musicInfo()` → `{ artist, track, album, state }` or `null` before the
  phone sends anything.

#### `Phone.weather()` (API 15)

- **Returns:** `{ temp, hum, txt, loc, age }` (temp in °C, `age` in seconds
  since the phone sent it; cached across reboots) or `null`.

#### `Phone.find(on)` (API 15)

- Makes the phone ring (`true`) or stop (`false`). The phone can also make
  the watch beep ("find device" in Gadgetbridge); a touch stops it.

#### `Phone.setEnabled(on)` (API 15)

- Turns the phone link on/off (persisted). Requires `"system"`; the quick
  settings panel has the same toggle.

## 22. API Level 18 — AI: `AI` (DeepSeek / OpenRouter)

Chat with an LLM (OpenAI-compatible API) from a JS app. The whole
`AI` object only exists for apps with the `"net"` permission (HTTPS under
the hood).

Two providers are built in, chosen per call with `opts.provider`
(default `"deepseek"`):

- `"deepseek"` — default model `deepseek-flash`, key in `/local/deepseek_key.txt`;
- `"openrouter"` — default model `qwen/qwen3.8-omni-flash` (multimodal: accepts
  `input_audio` message parts), key in `/local/openrouter_key.txt`.

The API key is **device-level, never in JS**: the owner provisions it once
with `python3 tools/push_ai_key.py deepseek|openrouter` (reads `.env` in the
repo root) or through the web file manager, into `/local/<provider>_key.txt`.
That file is protected by the FS jail — no app can read it — and the
framework reads it at call time (replacing the key does not need a reboot).

#### `AI.configured([provider])` (API 18)
- **Parameters:** `provider` (String, optional) — `"deepseek"` (default) or `"openrouter"`.
- **Returns:** Boolean
- **Description:** `true` when that provider's key is provisioned on the device. Pair with `Net.isConnected()` before chatting.

#### `AI.chat(opts, cb)` (API 18)
- **Parameters:**
  - `opts` (Object) — the request payload itself (OpenAI shape): `messages` (required, Array of `{role, content}` where role is `"system"`, `"user"` or `"assistant"`; `content` may be a String or, for multimodal models, an Array of content parts such as `{type:"input_audio", input_audio:{data:"<base64 wav>", format:"wav"}}`), optional `provider` (`"deepseek"` | `"openrouter"`, consumed by the framework and stripped from the payload), optional `model` (defaults to the provider's model), `max_tokens` (defaults to `1024`), `temperature`, etc. The framework forces `stream: false`.
  - `cb` (Function) — called **exactly once** with the result object when the request finishes.
- **Returns:** Boolean — `true` when the request started (callback will fire); `false` when busy (another request in flight — no callback).
- **Throws:** readable error when WiFi is down, no key is provisioned or the provider name is unknown.
- **Description:** Asynchronous: the HTTPS POST runs on its own task (60 s timeout) while the app keeps drawing. The callback receives `{ok, status, content, usage, raw, error}`:
  - `ok` — `true` on HTTP 2xx;
  - `content` — the reply text (`choices[0].message.content`), `null` when the body could not be parsed;
  - `usage` — `{prompt_tokens, completion_tokens, total_tokens}` when present;
  - `raw` — the raw response body (cap 32 KB; parse it yourself if you need more);
  - `toolCalls` (API 20) — array `[{id, name, args}]` when the model answers with a function call instead of text (`choices[0].message.tool_calls`); `args` is the `function.arguments` string decoded to an Object when it is valid JSON, otherwise the raw string;
  - `finishReason` (API 20) — `choices[0].finish_reason` when present (`"tool_calls"` or `"stop"`);
  - `error` — transport error or `"cancelado"` when `ok` is `false`; `detail` — the API's own error message (`error.message` of the response body, truncated to 120 chars) when present — e.g. invalid key, insufficient balance, rate limit.
- Errors inside the callback propagate like any binding error (the app dies with the error screen).

### Example

```javascript
if (!AI.configured("openrouter") || !Net.isConnected()) {
    System.print("configure a chave e o WiFi");
} else if (AI.chat({ provider: "openrouter",
                     messages: [{ role: "user", content: "piada curta" }] },
                   function (r) {
                       if (r.ok) System.print(r.content);
                       else System.print("erro: " + r.error);
                   })) {
    // keep pumping: the callback fires while the app yields
    while (true) System.delay(20);
}
```

### Example — voice (audio in, text out)

```javascript
// Mic.start/stop live on boards with a microphone (see section 23):
// stop() returns the base64 WAV ready for input_audio.
if (Mic.start({ ms: 8000 })) {
    // ... hold-to-talk UI while Mic.recording(), level via Mic.level()
    var b64 = Mic.stop();  // null when nothing was captured
    if (b64) {
        AI.chat({
            provider: "openrouter",
            messages: [{ role: "user", content: [
                { type: "input_audio", input_audio: { data: b64, format: "wav" } }
            ]}]
        }, function (r) { if (r.ok) System.print(r.content); });
    }
}
```

## 23. API Level 19 — Microphone recording: `Mic`

Capture audio from the board microphone (today the robot dog and the watch,
both 16 kHz mono 16-bit). The `Mic` object only exists when **all** of these
hold: the board has a microphone, the app **declared `"mic"`** in
`app.json` and the user **granted it** in the launcher consent dialog.
Otherwise `typeof Mic === "undefined"` — apps feature-detect and fall back
to the keyboard. Recording runs on its own task: the app keeps drawing
while audio is captured.

#### `Mic.start([opts])` (API 19)
- **Parameters:** `opts` (Object, optional) — `{ms: maxCaptureMs}`, default `6000`, clamped to `200..10000` (10 s = 320 KB of PCM, allocated in PSRAM).
- **Returns:** Boolean — `false` when there is no mic, no RAM, or a recording is already in flight.
- **Description:** Starts capture. The recorder stops by itself at the `ms` ceiling (`Mic.recording()` turns `false`, the buffer waits for `Mic.stop()`).

#### `Mic.stop([opts])` (API 19)
- **Parameters:** `opts` (Object, optional) — `{raw: true}` to get the raw WAV bytes instead of base64.
- **Returns:** String — base64 of the WAV (44-byte PCM16/mono/16 kHz header + samples) ready for `input_audio`; `null` when it was not recording or memory ran out.
- **Description:** Ends the capture and returns the audio. One recording at a time. **Leading/trailing silence is trimmed** (160 ms before the first voice, 240 ms after the last, 100 ms floor): the capture window opens before the speech and closes ~0.5 s after it — without the cut that padding travels in the base64/upload and makes the LLM process more audio than needed.

#### `Mic.recording()` (API 19)
- **Returns:** Boolean — `true` while the capture task is running.

#### `Mic.level()` (API 19)
- **Returns:** Number — sound level 0..100 (RMS of the last 32 ms chunk; quiet room 0-3, speech 15-40), `-1` when not recording.
- **Description:** For the live VU meter while recording. While a recording is in flight, `System.micLevel()` reports the same live level (they share the I2S channel).

## 24. API Level 20 — AI function calling

`tools` and `tool_choice` in the `AI.chat` opts have always travelled to the
POST untouched (the whole opts object is serialized as-is). What API 20 adds
is the **parsing of the answer**: when the model responds with a function
call, the callback now receives `r.toolCalls` and `r.finishReason` (see the
field list in `AI.chat`), so apps can act on structured commands without
JSON-parsing `r.raw` themselves.

```js
AI.chat({
    provider: "openrouter",
    messages: [{ role: "user", content: "please sit" }],
    tools: [{ type: "function", function: {
        name: "dog_command",
        parameters: { type: "object", properties: {
            command: { type: "string", enum: ["sit", "lie", "stand", "walk"] }
        }, required: ["command"] }
    } }],
    tool_choice: "auto",
    max_tokens: 150
}, function (r) {
    if (r.ok && r.toolCalls && r.toolCalls.length) {
        System.print("comando: " + r.toolCalls[0].args.command);
    } else if (r.ok) {
        System.print("resposta: " + r.content);
    }
});
```

Not every model/provider enables tool calling — feature-detect: with no
`toolCalls` in the answer, fall back to reading `r.content` (e.g. keyword
matching). `qwen/qwen3.8-omni-flash` via OpenRouter supports tools.

## 25. API Level 20 — On-device wake word: `WakeWord`

Always-on detection of the **"Hi Celer"** wake word running on the chip
itself (a microWakeWord model trained by CelerOS, executing on TensorFlow
Lite Micro — no network involved). Feeds from the same I2S channel as
`Mic`; while a recording is in flight the detector rests and resumes
afterwards. Exists only when **all** hold: the board enables it (today the
robot dog), the app declared `"mic"` (same consent as the microphone — the
device is listening) and the user granted it. Otherwise
`typeof WakeWord === "undefined"`.

#### `WakeWord.start()` (API 20)
- **Returns:** Boolean — `true` when the model and its task are up; `false` without a mic, without RAM for the model/arena or when the build has no model embedded.

#### `WakeWord.stop()` (API 20)
- **Description:** Stops detection, destroys the model and frees RAM (~35 KB + arena). The runtime also stops it when the app exits.

#### `WakeWord.poll()` (API 20)
- **Returns:** Boolean — `true` when "Hi Celer" was detected since the last poll (consumes the event; detections between polls collapse into one — poll once per loop turn).

#### `WakeWord.level()` (API 20)
- **Returns:** Number — sound level 0..100 of the last chunk read (same scale as `Mic.level()`); `-1` when stopped.

#### `WakeWord.running()` (API 20)
- **Returns:** Boolean — detection task alive?

Typical flow (Dog Face): `WakeWord.start()` at boot; on `poll() === true`
ack with a beep, `Mic.start({ms: 3500})` to capture the command and send it
to `AI.chat` with `tools` — the detector yields by itself during the
recording.

## 26. API Level 21 — Sealed messages on Celer Link

Regular Celer Link messages (`send`/`poll`) are **not encrypted on the air**:
code pairing authenticates who connects, but anyone nearby with a BLE
sniffer can read the content. For short secrets — the WiFi password the
Celer Remote sends to the robot, which has no keyboard — there is a sealed
channel: AES-128-GCM with a key derived from the **code-pairing bond**
(confidential and authenticated). Honest limit: whoever recorded the
pairing itself knows the code and therefore the key; the seal protects the
transfers made afterwards.

#### `CelerLink.sendSealed(message)` (API 21)
- **Parameters:** `message` (String or Object — an object becomes JSON), up to **209 bytes** (the seal takes nonce + tag).
- **Returns:** Boolean — `false` without a verified connection or **without a bond with the peer** (the pair must have been code-paired; a peer without pairing has no key).
- **Description:** Sends the message encrypted and authenticated to the connected peer. A message over the limit throws `RangeError`.

#### `CelerLink.pollSealed()` (API 21)
- **Returns:** String|null — the oldest sealed message **that authenticated** with the connected peer's bond (own queue of 2); `null` when empty.
- **Description:** The regular `poll()` never delivers sealed frames, and a seal that does not verify is dropped by the firmware — so whatever comes out of here came from whoever paired. Use this channel to accept secrets: a `{type:"wifi"}` arriving through the regular `poll()` should be ignored.

```js
// robot: accept the credential only through the sealed channel
var s = CelerLink.pollSealed();
if (s) { var m = JSON.parse(s); if (m.type === "wifi") Net.wifiConnect(m.ssid, m.pass); }
// controller: CelerLink.sendSealed({type: "wifi", ssid: ssid, pass: password});
```

## 27. API Level 22 — UI toolkit: the `UI` object + new primitives

Up to API 21 every app drew its own interface from primitives
(`fillRoundRect` + `drawString` + hand-written hit-tests). The `UI` object
exposes the **system's native widgets** (the same ones the CelerOS screens
use: FreeSans fonts, buttons with a pressed state, lists with inertial
scrolling, dialogs) in an **immediate-mode** model that fits the usual
blocking loop:

```js
var T = System.theme();
var on = false, volume = 40, tab = 0;
var items = [{label: "WiFi", right: "Home", bars: 3}, {label: "Bluetooth", sub: "Off"}, "Display", "Sound"];
while (true) {
    var full = UI.begin(T.bg);                 // reads touch once; true = full redraw
    if (UI.header("Settings", {back: true})) System.exitApp();
    tab = UI.tabs(10, 48, 220, 30, ["General", "Network", "About"], tab);
    UI.card(10, 86, 220, 70);
    UI.text("Dark mode", 22, 96);
    on = UI.toggle(176, 94, on);
    volume = UI.slider(22, 122, 196, volume);
    UI.cardEnd();
    var i = UI.list("menu", 10, 164, 220, 120, items);
    if (i >= 0) System.toast("Open " + i);
    if (UI.button("Save", 10, 290, 220, 28)) save();
    UI.end();                                  // present + pacing (~30 fps)
}
```

**Redraw model.** Widgets **always** hit-test, but they only draw on a full
frame (`UI.begin` returned `true`) or when their **own** visual state
changed (pressed, drag, value, text) — then they clear only their own
rectangle with the current background. On the CYD (no PSRAM frame) this
avoids the flicker of repainting the whole screen on every touch. Rules of
thumb:

- the app's **own** drawing (primitives) goes inside `if (full) { ... }`;
- a tap that fires a widget marks the **next** frame as full (the action
  almost always changes the screen); for other changes call `UI.invalidate()`;
- `UI.text` and `UI.badge` redraw themselves when the text changes — a
  counter in `UI.text` needs no `invalidate`;
- coordinates are the usual 240x320 virtual space; colors are RGB565
  (`System.theme()`); a tap fires **one** widget per frame.

#### `UI.begin([bg])` (API 22)
- **Returns:** Boolean — `true` when this frame is a full redraw (the `bg` background, default `theme().bg`, is already painted).
- **Description:** Opens the frame: pushes the previous frame to the glass, reads touch once (tap/drag/press for every widget of the frame) and handles the topbar (exit X) like `getTouch`.

#### `UI.end([fps])` (API 22)
- **Description:** Closes the frame: present + wait until `1000/fps` ms have passed since the last `end` (default 30, max 60). Replaces the loop's `System.delay`.

#### `UI.invalidate()` (API 22)
- **Description:** Marks the next frame as full (screen change, new data).

#### `UI.toast(msg, [ms])` (API 22)
- **Description:** Short notice (pill at the bottom, default 1800 ms) **inside the app**, drawn by `UI.end` — `System.toast` only shows once the app exits. When it expires the next frame is full.

#### `UI.touch()` (API 22)
- **Returns:** Object `{down, x, y, tap, released, moved, sx, sy}` — the current frame's touch as the widgets saw it (`tap` is already `false` if a widget consumed it; `sx/sy` = where the finger landed). For custom widgets, "save on release" (`released`) and swipes (`released && moved`: direction = `x - sx`, `y - sy`).

#### `UI.text(s, x, y, [opts])` (API 22)
- **Parameters:** `opts`: `role` (`"caption"` | `"body"` (default) | `"title"` | `"display"`), `color`, `align` (`"left"` | `"center"` | `"right"`; `x` is the anchor), `w` (max width: cut with `..`), `lines` (with `w`: word-wrap into up to N lines, max 64), `bg` (background used to clear when the text changes), `id` (two texts at the same spot).
- **Returns:** Number — height used (virtual).
- **Description:** Text in the system's role fonts (FreeSans/DejaVu picked by screen density). Redraws itself when the content changes.

#### `UI.measure(s, [role])` (API 22)
- **Returns:** Number — virtual width of `s` in the role's font.

#### `UI.lineHeight([role])` (API 22)
- **Returns:** Number — virtual line height of the role.

#### `UI.measureWrap(s, w, [role])` (API 22)
- **Returns:** Number — virtual height of `s` word-wrapped at width `w` (up to 64 lines), without drawing. Sizes bubbles/cards before `UI.text`.

#### `UI.header(title, [opts])` (API 22)
- **Parameters:** `opts`: `sub` (caption on the right), `back` (back arrow).
- **Returns:** Boolean — `true` when the arrow is tapped.
- **Description:** App header (40 px band at the top of the canvas, below the system topbar) in the native screens' look.

#### `UI.button(label, x, y, w, h, [opts])` (API 22)
- **Parameters:** `opts`: `style` (`"primary"` (default) | `"ghost"` | `"danger"`), `disabled`, `id`; custom colors with `color` (fill) + `textColor` and the label `role` (calculator keypads, games).
- **Returns:** Boolean — `true` on the tap frame (released inside the button it landed on, without dragging).

#### `UI.toggle(x, y, on, [opts])` (API 22)
- **Returns:** Boolean — the new state (44x24 virtual; the touch target has 6 px of slack). System getters may return `0/1`: compare with `!!value` (`if (UI.toggle(x, y, !!v) !== !!v) ...`).

#### `UI.slider(x, y, w, value, [opts])` (API 22)
- **Parameters:** `opts`: `min` (0), `max` (100), `step` (1).
- **Returns:** Number — the value (live while dragging; 28 px tall).

#### `UI.progress(x, y, w, h, pct)` (API 22)
- **Description:** Progress bar 0..100.

#### `UI.spinner(cx, cy, r, [color])` (API 22)
- **Description:** Spinning arc (redraws every frame) — network/AI waits.

#### `UI.list(id, x, y, w, h, items, [opts])` (API 22)
- **Parameters:** `items`: Strings or `{label, sub, right, rightColor, bars, enabled}` (`sub` = second line; `right` = right-aligned text in `rightColor`; `bars` 0..4 = signal). `opts`: `rowH` (default 36, or 48 with `sub`), `selected` (highlighted index; the list opens scrolled to it).
- **Returns:** Number — index tapped this frame, or `-1`.
- **Description:** Scrollable list with native drag + inertia (scroll state kept by `id`).

#### `UI.tabs(x, y, w, h, labels, sel)` (API 22)
- **Returns:** Number — the active tab (segmented control).

#### `UI.card(x, y, w, h, [opts])` (API 22)
- **Parameters:** `opts`: `color` (`theme().card`), `radius` (10), `stroke`.
- **Description:** Rounded surface; the following widgets use the card color as their background until `UI.cardEnd()`.

#### `UI.cardEnd()` (API 22)
- **Description:** Closes the card (back to the previous background).

#### `UI.scrollBegin(id, x, y, w, h, contentH)` (API 22)
- **Returns:** Number — vertical offset; draw the content at `y - off`.
- **Description:** Generic scroll area (clip + drag + inertia). Scrolling marks the next frame as full, so the content goes inside `if (full)`. Touches outside the area don't reach the widgets inside it.

#### `UI.scrollEnd()` (API 22)
- **Description:** Closes the area (restores the clip and draws the scrollbar).

#### `UI.scrollTo(id, y)` (API 22)
- **Description:** Moves list/area `id` to offset `y` (a large value goes to the end — the next `UI.list`/`UI.scrollBegin` clamps it to the content) and stops the inertia. Chats/logs that "follow the end".

#### `UI.resetScroll(id)` (API 22)
- **Description:** Scrolls list/area `id` back to the top (screen change).

#### `UI.badge(text, x, y, [opts])` (API 22)
- **Parameters:** `opts`: `color`, `textColor`.
- **Returns:** Number — virtual width of the pill.

#### `UI.confirm(title, [body], [opts])` (API 22)
- **Parameters:** `opts`: `yes` ("OK"), `no` ("Cancelar"), `danger` (red confirm button).
- **Returns:** Boolean — `true` = confirmed.
- **Description:** **Blocking** modal dialog (like `System.prompt`) over the dimmed screen. On return the next `UI.begin` is full.

#### `UI.alert(title, [body], [ok])` (API 22)
- **Description:** Blocking modal notice with one button.

### 27.1 New primitives on `System`

#### `System.fillGradient(x, y, w, h, top, bottom, [radius])` (API 22)
- **Description:** Rectangle (rounded with `radius`) with a vertical `top` → `bottom` gradient.

#### `System.fillArc(x, y, r0, r1, a0, a1, color)` (API 22)
- **Description:** Filled arc between radii `r0`..`r1`, angles in degrees (0 = 3 o'clock, clockwise) — progress rings, gauges.

#### `System.fillSmoothCircle(x, y, radius, color)` (API 22)
- **Description:** Circle with an anti-aliased edge.

#### `System.fillSmoothRoundRect(x, y, w, h, radius, color)` (API 22)
- **Description:** Rounded rectangle with anti-aliased corners.

#### `System.drawWideLine(x0, y0, x1, y1, width, color)` (API 22)
- **Description:** Thick anti-aliased line (clock hands, charts).

#### `System.mixColor(a, b, pct)` (API 22)
- **Returns:** Number — RGB565 blend (`pct` 0 = `a`, 100 = `b`): pressed states, shadows, manual gradients.

## 28. API Level 23 — JS modules: `require`

An app can be split into several flat `.js` files in its folder (the hub
publishes them all; see the App_Development_Guide). `require` loads the
module once per run, executes it wrapped as `function(module, exports,
require)` and returns `module.exports`. Modules may require modules (same
folder); cycles receive the partial `exports` (CommonJS behavior). No
permission needed: it is the app's own code.

#### `require(name)` (API 23)
- **Parameters:** module `name`, `[A-Za-z0-9_.-]` (optional `.js` suffix, no path) — resolves to `<app folder>/name.js`; since API 30, if the file is not in the folder and the app's `deps.json` references the name, it falls back to the dependency cache at `/local/modules` (section 35).
- **Returns:** the module's `module.exports` (`{}` when it exports nothing).
- **Errors:** module not found, invalid name, syntax/eval error (propagates as a catchable exception), max nesting depth (8).

```js
// main.js
var notes = require("notes");        // loads notes.js
notes.play("alert");

// notes.js
var audio = require("audio");        // modules require modules
exports.play = function (n) { audio.beep(n); };

// audio.js
module.exports = {                   // replacing module.exports also works
    beep: function (n) { System.playTone([[880, 80]]); }
};
```

- Duktape's `line N` in errors matches line N of the module file.
- The cache lasts for the app run (reopening reloads from disk).
- A bare `.js` run from the shell has no app folder: `require` throws.

## 29. API Level 24 — Speech: `AI.speak` (text to voice)

Text becomes voice on the board speaker. `AI.speak` posts the text to the
OpenRouter `/audio/speech` endpoint (default model
`google/gemini-3.8-flash-lite-tts`, 30 natural voices — speaks Portuguese
out of the box) and plays the audio **live** as it downloads: **nothing goes
through RAM**, download and playback run on their own task while the app
stays free (animating the robot's mouth, say). It shares the serial slot
with `AI.chat`: while a speech is in flight, `AI.chat`/`AI.speak` return
`false`.

Works on any board with an I2S speaker (dog, SmartDisplay, watch). Needs
the OpenRouter key (`AI.configured("openrouter")`) and WiFi. Live speech
touches no storage; a saved `.wav` (`save:true` or `play:false`) takes ~48 KB
of LittleFS per second of speech (24 kHz): 300 chars of text ≈ 20 s ≈
960 KB — hence the 300-char cap on `text`.

#### `AI.speak(opts, cb)` (API 24)
- **Parameters:**
  - `opts` (Object) — `text` (String, required, 1..300 chars; style can be embedded in the text itself, e.g. `"Say it cheerfully: dinner time!"`), `voice` (String, optional; default `"Charon"` — a deep voice that suits the robot dog; Puck, Kore, Fenrir, Aoede... are others), `model` (String, optional; defaults to `google/gemini-3.8-flash-lite-tts`), `path` (String, optional; destination of the `.wav` when one is saved — default is `tts.wav` inside the app's private folder, `FS.appData()`), `play` (Boolean, optional, default `true` — `false` only downloads the file for a later `System.playWav(path)`), `save` (Boolean, optional, default `false` — `true` also keeps the `.wav` in `path` while playing live).
  - `cb` (Function) — called **exactly once** at the end (after playback, when it runs).
- **Returns:** Boolean — `true` when the request started; `false` when busy (no callback).
- **Throws:** readable error when WiFi is down, no key, missing `text`, text above 300 chars or a path denied by the FS jail.
- **Description:** the download plays **live** (sound starts at the first byte of the response, not at the end of the file; an error body never reaches the speaker). The callback receives `{ok, status, path, bytes, played, error?, detail?}`:
  - `ok` — `true` when the audio was downloaded (and, when saved, sealed into `path`);
  - `path` — where the `.wav` lives when saved (`save:true`/`play:false`; valid for `System.playWav` and for the app's cache: the same phrase can play offline afterwards), `""` when it only played live;
  - `bytes` — downloaded PCM (~48 KB per second of speech);
  - `played` — `true` when it played to the end; `false` with `ok` true means `play:false` or cut by `AI.cancel()` (a speaker busy at the first byte falls back to playing the finished file);
  - `error`/`detail` — transport error and the API's own message (invalid voice, balance...).
- `AI.cancel()` cuts the speech mid-flight (sound stops at the next chunk).

#### `AI.warm([provider])` (API 24)
- **Parameters:** `provider` (String, optional; `"deepseek"` default or `"openrouter"`).
- **Returns:** Boolean — `true` when the warm-up was queued; `false` when there is nothing to do (no WiFi, no key, unknown provider, a board without PSRAM, or a request already in flight). Never throws, no callback.
- **Description:** opens the TLS connection to the provider **now**, so the next `AI.chat`/`AI.speak` skips DNS + TCP + handshake (~2 s on the S3). It does not take the serial slot: an `AI.chat` right after it is accepted and runs as soon as the warm-up finishes. Typical use: a voice app calls it at the wake word, while the user is still speaking.

```javascript
if (WakeWord.poll()) {
    AI.warm("openrouter");   // connection opens while the user talks
    Mic.start({ ms: 3500 });
}
```

### Example — the dog answers

```javascript
if (AI.configured("openrouter") && Net.isConnected()) {
    AI.speak({ text: "Hi! Everything alright?" }, function (r) {
        if (!r.ok) System.print("erro: " + r.error);
    });
    while (true) System.delay(20);  // callback fires while yielding
}
```

### Example — download without playing (fixed-phrase cache)

```javascript
// download once on WiFi, play offline whenever
AI.speak({ text: "low battery, time to charge", path: FS.appData() + "aviso.wav", play: false },
         function (r) { if (r.ok) System.playWav(r.path); });
```

## 30. API Level 25 — Music: `System.playMusic` (chiptune mixer)

A few channels of music, mixed live on the board speaker. The app (or the
LLM behind it) orchestrates a small "MIDI" — up to **4 tracks** of
`[midi, 16ths]` note events — and a synth task mixes them as a chiptune:
square 50%/25%, triangle and saw waves for melodies/bass, and a percussion
track using **General MIDI drum notes** (36 kick, 38 snare, 42 hi-hat).
Playback is **non-blocking**: the app stays free to blink LEDs and move
servos in rhythm while it plays.

Works on any board with an I2S speaker (dog, SmartDisplay, watch). Shares
the exclusive speaker slot with `playWav`/`playTone`/`AI.speak`:
`playMusic` returns `false` when the speaker is busy. Everything is
clamped (here and again in the engine — the app is never trusted): bpm
60..200, loops 1..8 with a 120 s total cap, 4 tracks × 48 notes, midi
0..96 (0 = rest), duration 1..64 sixteenths, volume 0..100.

#### `System.playMusic(song, [options])` (API 25; `options` in 27)
`options.startMs` (API 27) starts playback from the middle of the song
(ms since the beginning) — that is how the pack handoff resumes on the
neighbor exactly where the music stopped.
- **Parameters:** `song` (Object) — `{bpm: 60..200 (default 120), loops: 1..8 (default 4), tracks: [...]}`; each track `{wave: "sq"|"sq25"|"tri"|"saw" (default "sq"), drum: Boolean (notes become GM percussion), vol: 0..100 (default 80), notes: [[midi, sixteenths], ...]}` — midi 0 is a rest that still advances time, so tracks line up by the sum of their durations.
- **Returns:** Boolean — `true` when the song started; `false` when the speaker is busy, the board has no I2S audio or the song has no notes.
- **Description:** one song at a time; a new `playMusic` only starts after the previous one ends (or is stopped). While it plays the on-device wake word detector sleeps (same as any playback).

#### `System.musicStop()` (API 25)
Cuts the song at the next mixer block (~15 ms). Returns `true` when
something was playing. Idempotent.

#### `System.musicPlaying()` (API 25)
`true` while the synth task is playing (until the loops run out or a
`musicStop` lands).

#### `System.musicPos()` (API 25)
Milliseconds of audio already written to the speaker since the song
started — for beat-synced lights/choreography — or `-1` when idle.

### Example — party: AI-orchestrated beat + blinking LEDs

```javascript
var song = {
    bpm: 128, loops: 4,
    tracks: [
        { drum: true, vol: 100,
          notes: [[36,2],[42,1],[42,1],[38,2],[42,1],[42,1]] },   // kick/hat/snare
        { wave: "tri", vol: 90,
          notes: [[40,4],[40,2],[47,2],[45,4],[43,4]] },          // bass line
        { wave: "sq", vol: 70,
          notes: [[64,2],[67,2],[72,4],[0,4],[71,2],[67,2]] }     // short lead (0 = rest)
    ]
};
if (System.playMusic(song)) {
    var beatMs = 60000 / song.bpm;
    while (System.musicPos() >= 0) {          // dance while it plays
        var step = Math.floor(System.musicPos() / (beatMs / 2));
        System.neopixel(0, [step % 2 ? 0xFF2000 : 0x20C020, 0, 0, 0]);
        System.delay(30);
    }
    System.neopixel(0, [0, 0, 0, 0]);
}
```

## 31. API Level 26 — CelerNet: BLE mesh between CelerOS devices

A mesh of devices across an area: every CelerOS with Bluetooth announces
**non-connectable** advertising packets and listens to the air; whoever
hears a new packet **repeats it** (with one less hop in the TTL budget) —
the message crosses the area device by device, with no GATT connection at
all. Spread three boards around the house: a message sent at one end
arrives at the other end with `hops: 2`, relayed by the middle one.

`CelerLink` (section 15) remains the high-throughput point-to-point
channel (240 bytes per packet, pairing, sealed messages). The mesh is for
**coverage**: telemetry, presence, short commands and notices — messages
up to **434 bytes**, carried in ~14-byte fragments per radio hop (the
mesh moves a few packets per second per node; it is not for streaming).

**Availability:** only on boards built with Bluetooth
(`CONFIG_CELEROS_BLUETOOTH`). Detect with
`typeof CelerNet !== "undefined"`.

**The mesh is infrastructure, not an app session:** once enabled it
survives app switches and reboots (state lives in the `celernet`
setting; off by default). On the watch (battery) weigh the cost: the
radio keeps listening.

**Security (v3, API 37):** every packet is encrypted and authenticated
(AES-CCM) with the **network key**, and every packet carries a sequence
number that is never reused: a node drops anything that does not
authenticate (another network, a forged packet — not delivered and not
relayed) and anything it has already seen (a replayed capture). The
network is no longer chosen by the app:

- a **pack** (private network) is a name + password set on the device —
  `mesh join <name> <password>` in the shell (the provisioning wizard in
  the Matilha app comes next). The key is derived from both
  (PBKDF2-SHA256), so a second device that types the same name and
  password joins the same pack, and the same name with another password is
  another network;
- a device without a pack sits in the **open network "celer"**: its key
  is public (integrity, no secrecy) and it is meant for devices not yet
  configured. There, `mic` and `camera` refuse every remote session with
  `denied` (see `Pack`); `speaker` and data channels still work.

Nodes on CelerNet v2 firmware and v3 nodes no longer hear each other:
update every device together.

#### `CelerNet.start([options])` → Boolean (API 26)
Turns this node on. `options`: `{name: "Celer-Dog"` (announced name, up
to 14 characters since API 37; default `Celer-XXXX` from the end of the
MAC) and `relay: true` (repeat others' packets; `false` = listen and
announce presence only, for battery). State persists: the node comes
back on the next boot by itself. The first call may bring Bluetooth up
(~300 ms). With internal RAM tight (BLE not up yet and an app open) the
request is **accepted anyway** — the node comes up on its own within
seconds, as soon as RAM allows (`status().active` confirms); `false`
only without memory for the queues. A `net` option (API 26–36) is
**ignored** since API 37: the network is the device's pack.

#### `CelerNet.stop()` → Boolean (API 26)
Turns the node off (and persists the off state).

#### `CelerNet.broadcast(message, [ttl])` → Boolean (API 26)
Sends the message to the **whole** network. Same payload rule as
`CelerLink.send`: raw string or object serialized as JSON, 1–434 bytes
(outside that a `RangeError` is thrown). `ttl` (1–8, default 4) is the
reach in hops. Returns `false` with the mesh off or the queue full —
delivery is asynchronous (the radio transmits over the next few ms).

#### `CelerNet.poll()` → Object|null (API 26)
A message that arrived (FIFO of 8; full drops the oldest):
`{from: "9F2A", fromName: "Celer-Dog", msg: "...", unicast: false,
hops: 2, rssi: -71}` — `from`/`fromName` are the **origin** (not the
relayer), `hops` is how many hops the message took, `rssi` the last heard
hop's signal. `msg` is a string (JSON.parse it if the sender used an
object), `unicast` (API 27) tells whether that message was addressed to
this node. `null` when empty. Drain it in the app loop until it returns
`null`.

#### `CelerNet.send(to, message, [options])` → Boolean (API 27)
**Unicast**: only the destination delivers the message (the flood still
carries it across the area — relays do not open it for others). `to` is
the destination id (`"9F2A"`) **or name** (`"Celer-Dog"`, first
case-insensitive match; presence is sorted by signal, so duplicate names
resolve to the strongest). A destination not in the presence table
returns `false` — presence naturally comes and goes; the app decides.
`options`: `{ttl: 4, urgent: false, copies: 2}` — `urgent` moves the
handoff ahead of presence traffic, and `copies` (1–3) re-sends the
message ~1.5 s later (redundancy in place of ACKs). A **single-packet**
message (up to 16 B): every copy is independent and **delivery may
duplicate** — deduplicate by an `id` in your payload (the OS envelopes
already do). A **fragmented** message (> 16 B): the copies share one
identity and the destination merges fragments from any of them — it is
delivered once, and a fragment lost in one copy comes from the other.

**Designing a mesh protocol (what the firmware does under the hood):**

- **16 bytes fit in one radio packet.** Above that the message goes in
  14-byte fragments (a 100 B message = 8 packets) and is lost if *any*
  fragment is lost on any hop. The hub apps Sonar, Batata Quente,
  Sentinela and Coral fit every message in one packet: a 1-letter app
  prefix + a 1-letter opcode + short fields (`"bp123.4.150"`).
- **Never start a raw message with `P`** when it is 4+ bytes: that is the
  magic of the OS envelopes (`Pack`), and the Pack service swallows it —
  `"Ping 1"` never reaches `CelerNet.poll()` on the other side
  (`"ping 1"` does). Use a lowercase prefix.
- **The TX queue holds 96 packets** (your messages + what the node
  relays) and each packet holds the radio for ~185 ms (~5 packets/s). A
  434 B `send` with the default 2 copies takes 62 packets — about 11 s of
  air; a message only enters the queue whole (all copies) or not at all
  (`false`). Keep big messages rare.
- **No ACK in the radio.** If you need confirmation, make the reply the
  ACK (the Sonar's `s?`/`s!`, the Batata Quente's `bp`/`bk` with resend)
  and deduplicate retries by a sequence number.
- **Only an open app receives.** `CelerNet.poll()` belongs to the app in
  the foreground (relaying is the OS's job and needs no app): protocols
  between apps work while the app is open on both ends.

#### `CelerNet.nodes()` → Array (API 26; `caps` in 27)
Presence: network nodes heard in the last 15 s, strongest signal first:
`[{id: "9F2A", name: "Celer-Dog", caps: 9, rssi: -71, hops: 1,
lastSeen: 2}]` (`lastSeen` in seconds; `hops` counts hops taken — a
direct neighbour is 1; firmware up to 1.7.0 reported 0 — and while the
direct path is fresh a beat relayed by another node does not replace it).
Every node announces presence
every ~3 s; since API 27 the announcement carries the node's **role**
(`caps`, a bitmask — use `Pack.members()` for it decoded).

#### `CelerNet.status()` → Object (API 26)
`{active, relay, node, name, net, secure, provisioned, txQueued,
txDropped, rxDropped, relayed, heard, rxAuthFail, rxReplay}` — `node` is
our id (end of the MAC), `net` the network name (the pack, or `"celer"`),
`secure`/`provisioned` (API 37) whether it is a private pack, `relay`
whether we are repeating, `relayed` how many others' packets we relayed
since `start()`, `heard` how many nodes are in the presence table,
`rxAuthFail` packets heard that did not authenticate (another network
nearby) and `rxReplay` packets already seen (relay duplicates, replays).

### Example — a message crossing the area

```javascript
// on ANY node (the middle one relays on its own)
if (typeof CelerNet !== "undefined" && !CelerNet.status().active) {
    CelerNet.start({name: "Celer-Kitchen"});
}
CelerNet.broadcast({type: "notice", text: "coffee is ready"}, 4);

// in every node's loop:
var m;
while ((m = CelerNet.poll()) !== null) {
    var notice = JSON.parse(m.msg);
    System.drawString(m.fromName + " (" + m.hops + " hops): " +
                      notice.text, 10, 10);
}
var neighbors = CelerNet.nodes();
System.drawString(neighbors.length + " nodes heard", 10, 30);
```


## 32. API Level 27 — The pack (`Pack`): roles, envelopes, roaming music

The **pack** is the mesh with meaning: the same CelerNet radio, read
through the OS. Each member announces its **role** in the presence beat
— what it has to offer: `speaker`, `mic`, `display`, `motors`, `leds`,
`hub` (network reachable) — derived from the board itself, no
configuration. And the OS speaks its own typed envelopes over the mesh
(unicast, deduplicated by message id), which is how the first pack
feature travels: **the roaming party** — the chiptune playing on the dog
moves to the SmartDisplay (or the watch), resuming from the same
millisecond.

`Pack` exists wherever `CelerNet` does (`CONFIG_CELEROS_BLUETOOTH`;
detect with `typeof Pack !== "undefined"`). It is infrastructure: the
service runs with or without an app open.

#### `Pack.me()` → Object
Who we are in the pack: `{id: "9F2A", name: "Celer-Dog",
caps: {speaker: true, mic: true, display: false, motors: true,
leds: true, hub: false}, meshActive: true, net: "casa",
provisioned: true}` — `caps` decoded from the bitmask the firmware derives
from the board (`hub` follows the network state live). `net` and
`provisioned` are API 40 (section 43).

#### `Pack.members()` → Array
The pack heard in the last 15 s, strongest first — same shape as
`me()` plus `{rssi, hops, lastSeen}` per member:
`[{id, name, caps, rssi: -58, hops: 1, lastSeen: 2}]`.

#### `Pack.send(to, message, [options])` → Boolean
A **custom envelope** to one member (unicast, deduplicated by the
firmware — duplicates from the redundant copies never reach you). `to`
is id or name (same rules as `CelerNet.send` — a vanished destination
returns `false`); `message` is a string or object-as-JSON, 1–430 bytes
(`RangeError` outside). `options.urgent` moves it ahead of presence
traffic. The receiver drains it with `Pack.poll()`. Since API 41 every
envelope also travels as an ESP-NOW copy when the data plane is up (the
mesh alone loses many frames when WiFi shares the radio); duplicates are
dropped by message id, so the receiver still sees it once.

#### `Pack.poll()` → Object|null
A custom envelope that arrived: `{from: "9F2A", fromName: "Celer-Dog",
data: "..."}` — `data` is a string (JSON.parse what you sent). `null`
when empty. Messages sent with plain `CelerNet.broadcast` keep arriving
via `CelerNet.poll()` as always — the two channels do not mix.

#### `Pack.handoffMusic([to])` → Boolean
**Passes the party along**: serializes the `System.playMusic` session in
course (song + position) into one mesh message and the member with a
speaker resumes it from the same point. `to` omitted = the strongest
member with `caps.speaker`. `false` when nothing is playing here, the
mesh is off, or no receiver is around. On success the local music stops
(and if the receiver's speaker is busy the envelope is dropped — the
music stays wherever it was).

### Example — the roaming party

```javascript
// the dog's party (Dog Face or any app):
System.playMusic({bpm: 128, loops: 4, tracks: [
    {wave: "sq",  vol: 80, notes: [[64,2],[67,2],[71,2],[74,2]]},
    {drum: true,  vol: 90, notes: [[36,4],[42,2],[42,2]]}
]});
// ...walking away from the dog:
Pack.handoffMusic();            // continues on the SmartDisplay

// any member, watching for envelopes:
var e;
while ((e = Pack.poll()) !== null) {
    System.notify(e.fromName, e.data);
}
```

## 33. API Level 28 — Native canvas: pixels of the glass

Every JS app draws on a virtual 240x320 canvas that the firmware scales
to the physical display — one code base, any board. The **native canvas**
is the opt-out for apps that want the real pixels instead: a fullscreen
game on the 4" SmartDisplay (480x480) draws crisp 1:1 pixels on a square
glass, with no 2.0/1.5 aspect stretch and touch at physical precision.

#### `System.pushSprite(x, y[, transparent])` (3rd argument in API 28)
With the optional `transparent` color (RGB565), sprite pixels matching
that color are **not** transferred — a chroma-key blit, so a sprite with
a solid background (e.g. black) composes over the scene without a square
around it. Keep interior darks away from the key color (master the asset
to a near-black that differs in the lowest bit). Without the argument the
blit is opaque, as always.

#### `System.setNativeCanvas(enable)` → Boolean (API 28)
`true` switches **every** subsequent `System.*` draw/sprite/touch call to
physical pixels: coordinates are used as-is (`System.screenWidth()`/
`screenHeight()` report the glass — 480/480 on the SmartDisplay),
`createSprite` sizes are physical, `drawPNG`/`drawBMP` keep their native
pixel size (no virtual scaling) and `System.getTouch()` returns physical
coordinates. Returns `true` when applied; `false` (and nothing changes)
when the app runs with the **fixed topbar** — the mode requires a
fullscreen app (`"topbar": false` in `app.json`), which then owns its own
exit gesture (`System.exitApp()`).

`false` returns to the virtual 240x320 canvas — the switch is per-draw,
so an app can keep its `UI.*` menus virtual (the toolkit always reasons
in virtual coordinates; do not mix `UI.*` widgets with the native mode in
the same frame) and enter native mode only for gameplay. Toggling marks
the frame for a full repaint: redraw the whole screen right after
switching. The mode is reset when the app exits.

### Example — fullscreen game on the square glass

```javascript
// app.json: "topbar": false
if (System.setNativeCanvas(true)) {
    var W = System.screenWidth(), H = System.screenHeight();  // 480, 480
    System.fillRect(0, 0, W, H, 0x0000);
    var t;
    while (true) {
        t = System.getTouch();
        if (t.touched) System.fillCircle(t.x, t.y, 24, 0x07FF);  // physical px
        System.delay(10);
    }
}
```

## 34. API Level 29 — Sprite pool 8 + `System.spriteSlots()`

The multi-sprite pool (section 16.3) doubled: **8 slots on PSRAM boards**
(still 1 without PSRAM). Allocation stays on demand — a slot only costs
memory once the app creates the sprite — so the larger pool is free for
apps that don't use it.

#### `System.spriteSlots()` → Integer (API 29)
Returns the board's **actual** pool limit (8 with PSRAM, 1 without).
Engines and games budget their slots instead of hardcoding the historical
maximum:

```js
var cap = System.spriteSlots ? System.spriteSlots() : 4;  // degrades on old firmware
if (System.createSprite(32, 32) === 0) { /* pool full: paint procedurally */ }
```

The full-pool `createSprite` compatibility behavior (recycling the current
sprite) still applies — with 8 slots the case became rare; count your live
ids and respect `spriteSlots()` before asking for more.

## 35. API Level 30 — Shared dependencies: `deps` in app.json

The SDK game engine and physics (53 KB combined) are no longer copied into
every game: the app **declares** its dependencies in `app.json` and the
store installs them into a public cache at `/local/modules/<name>/<version>/`
— a single copy per version on the device, shared across apps. `require()`
resolves the fallback.

#### The `"deps"` dependency field (API 30)

```json
"deps": { "celeros.engine": "^1.0.0", "celeros.physics": "^1.0.0" }
```

- **Name** = the module's identity everywhere: `require("celeros.engine")`,
  file `celeros.engine.js`, folder `/local/modules/celeros.engine/`. The
  `require` validator accepts `.` from this API on (format `prefix.name`,
  lowercase).
- **Version** = range `^X.Y.Z` (same major, ≥ base) or exact `"1.0.0"`.
  Resolution happens **at install time**: the store picks the highest
  version from the hub index (`/store/deps.json`) that satisfies the range
  and writes the choice to `<app folder>/deps.json` (the runtime source for
  `require`). Updating the app re-resolves the ranges. The grammar is the
  Dart `pub` model: the **major is the breaking line** — `^1.1.0` runs on
  any 1.x ≥ 1.1.0 (minor/patch reach the app on the next install or
  `celerctl apps deps --upgrade`) and never jumps to 2.0; **majors
  coexist** in the cache, each app pinned by its own `deps.json` (the
  per-app lockfile; the launcher GC keeps every version some app pins).
- `deps.json` holds the **transitive closure** (a dep's own deps come
  along). The runtime reads up to **32** modules per app from API 44; up to
  API 43 it read only 8 and the rest of the closure failed to `require`.
  An app whose closure has more than 8 modules declares `"api": 44`.
- The hub validates at publish: deps exist in the repository, the package's
  `.js` sum **+ resolved deps** counts toward the 48/128 KB ceiling (the dep
  still compiles inside each app's heap) and the app's `api` ≥ the dep's
  `minApi`.
- **Provisioning is automatic on every path**: `celerctl apps install`/
  `apps store`, the store, `celerctl dev` (start + `app.json` changes) and
  `celerctl push PASTA /local/apps` resolve against the hub, download the
  modules to `/local/modules` and write `deps.json` before the app runs.
  `celerctl apps deps --upgrade` refreshes the pins of every installed app
  (highest satisfying — never crosses a major).

#### `require` resolution (precedence)

1. `<app folder>/<name>.js` — local file wins (vendoring still works; handy
   to test a modified copy);
2. `/local/modules/<name>/<version from deps.json>/<name>.js` — the hub
   cache installed by the store;
3. a clear error: "dependency missing — reinstall the app from the store".

The launcher garbage-collects the cache: versions with no app referencing
them in `deps.json` leave the disk on each scan (boot, install, uninstall).
Writing under `/local/modules` requires the `system` permission (reading is
free) — a regular app cannot swap the code other apps load.

The `celer.js new --game` scaffold generates the `app.json` with the engine
deps; in the emulator/harness `require` resolves deps from the
`tools/sdk/engine` tree (see the Game Engine Guide).


## 36. API Level 31 — Native verlet: `System.verlet*`

The heavy verlet step — integration, stick relaxation and bounds with
bounce — runs in **C++ float** (the S3's single-precision FPU; double is
soft-fp and costs 5-10×): points live in a native malloc'ed buffer (PSRAM
when the board has it; ~10 KB of internal RAM otherwise), outside the
Duktape heap, and JS creates, pins and draws by index. Up to 4 concurrent
worlds, 256 points and 640 sticks each; all are torn down when the next
app starts. The recommended entry point is the dep: `P.verletFast`
(celeros.physics 1.2.0) feature-detects and falls back to the interpreted
JS verlet on firmware without API 31 — the raw API:

#### `System.verletNew([iterations, radius])` → Integer (API 31)
Creates a verlet world (relaxation iterations per step, default 4, max 16). `radius` > 0 enables **point-point collision**: unlinked pairs closer than `2×radius` separate (position correction without impulse — piles stay stable). Returns the id (1..4) or -1.

#### `System.verletFree(id)` (API 31)
Releases the world (malloc included). Worlds are also torn down when the app exits.

#### `System.verletAddPoint(id, x, y)` → Integer (API 31)
Adds a point at rest at (x, y); returns the index (0..) or -1 (world full).

#### `System.verletStick(id, a, b[, len])` → Boolean (API 31)
Stick between points a and b; omitted `len` = current distance.

#### `System.verletPin(id, idx[, on])` → Boolean (API 31)
Pins/releases the point (omitted on = pin).

#### `System.verletSet(id, idx, x, y)` → Boolean (API 31)
Moves a point WITHOUT touching its previous position — implicit velocity comes from the difference (the finger dragging).

#### `System.verletStep(id, dt, gx, gy[, damp, minX, minY, maxX, maxY, bounce])` → Boolean (API 31)
One full step: integration (gravity in px/s², `dt²` like `P.verlet`), iteration relaxation and optional bounds (active when `maxX > minX`) with bounce. Pure scalars: zero heap objects.

#### `System.verletXY(id)` → Array (API 31)
`[x0, y0, x1, y1, ...]` — one allocation per frame for the drawing loop.

#### `System.verletSticks(id)` → Array (API 31)
`[a0, b0, a1, b1, ...]` — point indices of each stick.

#### `System.verletCount(id)` → Integer (API 31)
How many points the world has.

#### `System.verletDelStick(id, i)` → Boolean (API 31)
Removes stick `i` (the last one takes its place — for several cuts, delete from the highest index down).

#### `System.verletDelPoint(id, idx)` → Boolean (API 31)
Removes point `idx`: its sticks go with it and the last point inherits the index (delete from the highest index down to keep indices coherent).

#### `System.verletPins(id)` → Array (API 31)
Pin state per point (`[0, 1, ...]`) — for highlighting and toggling.

## 37. API Level 32 — Mixed sound effects: `System.sfx`

`System.playTone` is **blocking**: it holds the JS thread note by note, so
a game loop froze for 50-600 ms on every explosion, and with music playing
the effect could not sound at all (one speaker slot). `System.sfx` hands
the melody to the chiptune synth task instead: the effect is **mixed on
top of the running `playMusic` track** (the track dips to ~55% while the
effect sounds, so it stays readable) and the call returns immediately.
Without a track, the synth opens a short session just for the effect.

Same board support as `playMusic` (I2S speaker: dog, SmartDisplay,
watch). One effect at a time: a new `sfx` replaces the one sounding (the
latest feedback wins, like on a console). It does not push the frame, so
calling it from inside a draw is safe.

#### `System.sfx(melody)` → Integer (API 32)
- **Parameters:** `melody` (Array) — `[freq, ms]`, `[[freq, ms], ...]` or flat `[f, ms, f, ms, ...]`; `freq` 20..20000 Hz or **0 = rest** (advances time), `ms` 1..1000 per tone. Clamped: 24 tones, 3 s total; malformed entries are skipped.
- **Returns:** Integer — how many tones were accepted; `0` when the speaker is busy (`playWav`, `playTone`, `AI.speak`), the board has no I2S audio or nothing was valid.

```javascript
// shot over the soundtrack, without stalling the game loop
if (typeof System.sfx === "function") System.sfx([[1200, 30], [900, 30], [600, 50]]);
else System.playTone([[1200, 30], [900, 30], [600, 50]]);   // older firmware: blocks
```

`celeros.engine` 1.2 routes `E.audio.sfx` through it automatically
(`E.caps.mix`) and turns `E.audio.duck` into a no-op when mixing is
available.

## 38. API Level 33 — Native rigid bodies (`System.rigid*`) and `System.drawSprite`

Boxes that **rotate, stack and topple**, circles that **roll**, a fast
stone that **does not tunnel** through a thin plank: a sequential-impulse
solver (box2d-lite style) in C++ float — box-box SAT with up to 2
contacts, friction and impulses **accumulated with warm starting** (stacks
stay up), penetration fixed through pseudo-velocity (no jitter),
restitution, per-body **sleep** (still for 0.5 s turns static until hit)
and adaptive anti-tunneling **sub-steps** (≥ 120 Hz; no body moves more
than 40% of the world's thinnest half-extent per sub-step). A 30-piece
castle costs ~1-2 ms per frame on the S3 — interpreted, it would not fit
in a frame.

S3 boards only (`CONFIG_CELEROS_JS_GAME_ACCEL`: SmartDisplay, watch, dog);
on the classic ESP32 the functions do not exist — test with `typeof`. The
recommended path is the dep: `P.rigid()` from `celeros.physics` 1.5.0
(returns `null` without the binding). Up to 2 worlds of 96 bodies; they
are freed when the next app starts. Free units (the app's), angle in
**radians**, y grows downwards. Indices are **stable**: removing frees the
slot and the next add reuses it.

#### `System.rigidNew([iterations])` → Integer (API 33)
Creates a world (solver iterations per sub-step, default 10, max 30). Returns the id (1..2) or -1.

#### `System.rigidFree(id)` (API 33)
Releases the world (its malloc, ~60 KB of PSRAM, included).

#### `System.rigidBox(id, x, y, w, h[, angle, density, friction, bounce])` → Integer (API 33)
Box centred at (x, y), sized w × h. `density` 0 = **static** (ground, walls); default 1. `friction` defaults to 0.6; `bounce` (restitution 0..1) to 0.1. Returns the index or -1 (world full).

#### `System.rigidCircle(id, x, y, r[, density, friction, bounce])` → Integer (API 33)
Circle of radius r (same defaults). A circle in contact gets rolling resistance, so a ball comes to rest.

#### `System.rigidRemove(id, idx)` → Boolean (API 33)
Removes the body (with its contacts) and **wakes the world**, so whatever rested on it falls.

#### `System.rigidSet(id, idx, x, y[, angle, vx, vy, w])` → Boolean (API 33)
Teleport + velocity (u/s and rad/s); wakes the body. Launching a projectile is a `rigidSet` with the slingshot velocity.

#### `System.rigidImpulse(id, idx, jx, jy)` → Boolean (API 33)
Impulse at the centre (Δv = j / mass); wakes the body. Explosions: a radial impulse on the neighbours.

#### `System.rigidStep(id, dt[, gx, gy, maxSub])` → Integer (API 33)
Advances `dt` seconds (clamped to 0.1) with gravity in u/s². Returns how many sub-steps ran (`maxSub` default 12, max 16).

#### `System.rigidState(id[, buf])` → Array (API 33)
`[x, y, angle, hit, speed, flags, ...]` — 6 numbers per index. Pass last frame's array as `buf` and it is refilled in place (its `length` follows the world) and returned — no new array per frame; firmware 1.8.0 ignores `buf` and returns a new one, so always use the return value. `hit` = the largest impact impulse of the last step (approach × effective mass: game damage comes from here); `speed` = speed of the body's fastest point; `flags`: 1 alive, 2 awake.

#### `System.rigidCount(id)` → Integer (API 33)
Slots in use (high-water mark): `rigidState` holds `6 × rigidCount` numbers.

#### `System.drawSprite(id, x, y[, angle, zoomX, zoomY, key, smooth])` (API 33)
Draws sprite `id` (from `createSprite`) **rotated and scaled** with its centre at (x, y) on the current target — the frame, or another sprite selected with `useSprite` (a sprite is never drawn onto itself). `angle` in **degrees** (clockwise), `zoomY` defaults to `zoomX`, `key` = transparent colour key (RGB565; `null` = opaque), `smooth` = anti-aliased sampling (scale art at load time without jaggies; the default, nearest neighbour, is faster per frame). For pieces that rotate in the physics, and for a small PNG background scaled to the full screen inside a sprite.

In the same API level the PSRAM sprite pool doubled to **16** (`System.spriteSlots()` reports it): a game with per-character art, material textures and the scenery in a full-screen sprite overflowed the 8 slots.

```javascript
var P = require("celeros.physics");          // dep ^1.5.0
var w = P.rigid({ iterations: 10 });
if (!w) { /* firmware without API 33: tell the user */ }
w.box(160, 270, 400, 20, { static: true });  // ground
var plank = w.box(200, 240, 48, 6, { density: 0.6, friction: 0.7 });
var stone = w.circle(40, 200, 6, { density: 3, bounce: 0.3 });
w.set(stone, 40, 200, 0, 420, -40, 0);       // launch
w.step(dt, { gravity: { x: 0, y: 400 } });
var s = w.state();
if (w.hit(plank, s) > 900) w.remove(plank);  // broke
System.drawSprite(plankSpr, w.x(plank, s), w.y(plank, s),
                  w.angle(plank, s) * 57.2958, 1, 1, 0x0000);
```

## 39. API Level 34 — `System.blitSprite` (background restore in one call)

#### `System.blitSprite(id, x, y, w, h)` (API 34)
Copies the rectangle (x, y, w, h) of sprite `id` to the **same position** on the current target, treating the sprite as covering the canvas from (0, 0) — a full-screen background sprite. The target's clip comes back as it was. It is the dirty-layer painter of a game in one binding call: `setClip` + `useSprite` + `pushSprite` + `useSprite(0)` + `clearClip` were 5 calls per dirty box, and a busy frame repaints dozens of boxes. S3 boards only (`CONFIG_CELEROS_JS_GAME_ACCEL`, like `drawSprite`): feature-detect.

```javascript
E.dirty.enable(function (x, y, w, h) {
    if (System.blitSprite) { System.blitSprite(bgSpr, x, y, w, h); return; }
    System.setClip(x, y, w, h);              // API 33 and older
    System.useSprite(bgSpr);
    System.pushSprite(0, 0);
    System.useSprite(0);
    System.clearClip();
});
```

In the same level `System.rigidState(id, buf)` accepts the previous frame's array and refills it in place (see API 33); `celeros.physics` 2.1 uses it inside `state()`.

## 40. API Level 35 — Camera: `Camera` (photos and QR on the esp32-cam)

The `Camera` object exists only on boards with a camera sensor in the profile
(today the esp32-cam, OV2640) built with `CONFIG_CELEROS_JS_CAMERA`, and only
for apps declaring the **"camera"** permission. Feature-detect with
`typeof Camera !== "undefined"` (or `System.getInfo().board`).

#### `Camera.setup({framesize, pixformat, fbcount, xclkMhz})`
Configures the photo pipeline and turns the sensor on. Returns `true` on
success. Options: `framesize` `"qqvga"|"qvga"|"vga"|"svga"|"hd"|"sxga"|"uxga"`
(default `qvga`; JPEG benefits from PSRAM), `pixformat`
`"jpeg"|"gray"|"rgb565"` (default `jpeg`), `fbcount` 1-2 (default 2 with
PSRAM), `xclkMhz` 10 or 20 (default 20; drop to 10 if the bench shows skew).

#### `Camera.capture()` -> `{id, w, h, len, format}` | `null`
Grabs one frame. The buffer is copied to a retained slot (PSRAM) and the
driver's queue is released immediately — up to 2 frames retained (`id` 1-2);
when both are full the oldest is recycled. `null` = sensor not ready.

#### `Camera.save(id, path)` -> bytes written | `-1`
Streams retained frame `id` to `path` (same write rules as `FS.writeFile`:
atomic on `/local`, direct on the SD card). JPEG frames get the extension
you choose — `/sd/foto.jpg` is the usual.

#### `Camera.free(id)`
Releases a retained frame.

#### `Camera.led(on)`
The camera's white flash LED (GPIO4 on the AI-Thinker), to light a QR code or
a photo in the dark. It is a power LED with no current limiting on the board:
the firmware turns it off by itself after 800 ms lit and, after a long burst
(> 250 ms), ignores the next `led(true)` for 4x the time it stayed lit. Short
pulses (blinks) pass freely. It is not a continuous torch.

#### `Camera.scanQR({timeoutMs, attempts, led})` -> string | `null`
Reads QR codes **on-device** (quirc decoder; the grayscale frame goes straight
to the decoder — no JPEG step). Reconfigures the sensor to grayscale QVGA
while scanning and restores the photo mode afterwards (the switch costs tens
of ms, only when the app mixes photos and scanning). Retries until something
decodes, the `attempts` budget (default: derived from `timeoutMs`, one
attempt ~= 250 ms) or `timeoutMs` (default 6000) runs out. `led:true` lights
the flash for the scan under the same cap as `Camera.led` (up to 800 ms per
scan; prefer `led:false` in ambient light). Returns the decoded text or `null`.

```javascript
var code = Camera.scanQR({ timeoutMs: 5000, led: true });
if (code) {
    // sensor-node pattern: hand it to the gateway over the mesh
    var gw = Pack.members().filter(function (m) { return m.caps.hub; })[0];
    if (gw) Pack.send(gw.id, { t: 'qr', code: code }, { urgent: true });
}
```

Notes for sensor nodes: `scanQR` renews the exec-timeout window on every
attempt, so a scanning loop is safe; the mesh advertises `caps.camera: true`
in `Pack.members()` on camera boards (API 27 payload), and photos/QR results
fit the mesh envelope — full images do not (use WiFi for those).

Headless boards: apps that draw do not run on the esp32-cam profile (see
`CELEROS_UI`); a camera app's UI is LEDs, logs and the mesh.

## 41. API Level 36 — Pack resources: use another device's mic, speaker, camera and data

Every node **exposes** what it has and any pack member can **open** it. The
mesh carries discovery and control; each open is a *session* with a lease:
if the client disappears, the owner gets the resource back by itself after
~20 s (and if the owner forgot the session, the client reopens it by itself
under the same handle). Nothing blocks — `open()` returns a handle right away and
`status(h)` tells when the owner answered (~1 s over one hop).

Built-in resources come from the board profile: `mic`, `speaker` and
`camera` (exclusive: one session at a time). `mic` and `speaker` are ready on boards with I2S audio (see `Pack.listen`/`speak`/`record` below); `camera` is ready on camera boards (see `Pack.snap`/`view` below). Sessions use **ESP-NOW** (WiFi radio, no router, ~65 KB/s each way) when both nodes share a channel — a node on WiFi keeps its internet, the free one moves to the AP's channel — and fall back to the mesh otherwise. **Data channels** created by apps
(`Pack.expose`) work now, carried by the mesh (up to 425 bytes per message,
low rate: sensor readings, states, commands).

Privacy: opening someone else's `mic` or `camera` needs the same permission
the local `Mic`/`Camera` would (`"mic"`/`"camera"` in app.json), and **only
works inside a private pack** (API 37): a node in the open network `"celer"`
refuses them with `denied` (see the security note in `CelerNet`). The owner
can turn sharing off per resource with the settings `res_share_mic`,
`res_share_cam`, `res_share_spk`, `res_share_sens` (all default `"1"`) and
`res_share_gpio` — which defaults to **`"0"`**: firing a relay from another
room is not the same as listening to a mic; the owner turns it on on purpose
(`"0"` = refuse with `denied`). Opening remote `gpio`/`sensor` resources
needs the `"gpio"` permission in app.json.
Over the cable the same regime applies: a computer plugged into the
gateway's USB is just another resource client, with the master switch
`res_share_usb` (default `"0"`, enable with `cfg res_share_usb 1`). ESP-NOW traffic is encrypted with
the pack key too.

#### `Pack.resources([type])` → Array
What the neighbours expose: `[{node, nodeName, name, type, busy, shared, ready}]`,
`type` is `"mic" | "speaker" | "camera" | "gpio" | "sensor" | "data"`. Comes
from a cache; a node not cached yet is asked in the background — call again
~1 s later. Nodes on API 38+ also carry the resource **metadata**: `unit`
(e.g. `"%"`), `min`/`max` (sensor range) and `schema` (JSON of the params
`open` accepts, e.g. `{"off":0|1}` on a relay).

#### `Pack.open(node, name, [opts])` → Number
Opens resource `name` on `node` (id or name). Returns the handle (0..7) or
`-1` (no slot, mesh off, unknown node, missing permission). `opts` travels
to the owner as JSON (up to 48 bytes).

#### `Pack.status(h)` → Object|null
`{state, reason, node, name, via}` (`via`: `"espnow"` — fast, up to 1449 bytes per message — or `"mesh"`). `state`: `"opening"`, `"open"`, `"refused"`,
`"revoked"`, `"lost"` (owner left / no answer) or `"closed"`. `reason` on
refusal/revocation: `"notFound"`, `"busy"`, `"denied"`, `"unsupported"`,
`"full"`, `"local"`, `"gone"`, `"noLink"` (audio/image without a shared ESP-NOW channel) (`"expired"` never shows: the client reopens).

#### `Pack.read(h)` → String|null
Next message published on the session (oldest first; 6 buffered).

#### `Pack.write(h, data)` → Boolean
Sends data to the owner (string or object as JSON; ≤ 1449 bytes over ESP-NOW, ≤ 425 over the mesh).

#### `Pack.close(h)`
Closes the session. Handles close themselves when the app exits.

#### `Pack.expose(name, [opts])` → Boolean
Creates a data channel of this app (name ≤ 15 chars). `opts.shared` (default
`true`) accepts many sessions; `false` = exclusive (a second client gets
`busy`).

#### `Pack.unexpose(name)` → Boolean
Removes the channel and revokes its open sessions (`"gone"`); the app
exiting does the same.

#### `Pack.publish(name, data)` → Number
Sends `data` to every session of the channel; returns how many.

#### `Pack.sessions(name)` → Number
Live sessions on the channel (`-1` = no such channel).

#### `Pack.pollWrite()` → Object|null
Next client write on one of our channels: `{res, from, fromName, data}`.

```javascript
// owner: thermometer
Pack.expose("temp");
setInterval(function () { Pack.publish("temp", { c: Sensors.temp() }); }, 2000);

// client: any pack member
var t = Pack.resources("data").filter(function (r) { return r.name === "temp"; })[0];
var h = t ? Pack.open(t.node, "temp") : -1;
// in the loop:
var d = h >= 0 ? Pack.read(h) : null;
if (d) System.drawString(JSON.parse(d).c + " C", 10, 40);

#### `Pack.listen(node)` → Number
Plays `node`'s microphone live on **this** device's speaker (intercom). Needs
the `"mic"` permission and an ESP-NOW channel shared with the node (refuses
with `"noLink"` otherwise). Returns a handle; `Pack.close(h)` stops. Audio is
PCM 16 kHz mono over ESP-NOW (32 KB/s), ~160 ms of jitter buffer.

#### `Pack.speak(node)` → Number
The reverse: **this** device's microphone plays on `node`'s speaker. Needs a
local microphone and `"mic"`.

#### `Pack.record(node, [opts])` → Number
Records `node`'s microphone here (`opts.ms` cap, 200..10000, default 6000).
Poll `Pack.recording(h)` (false at the cap or when the session drops) and
`Pack.level()` (RMS 0..100), then collect with `Pack.recordStop`.

#### `Pack.recording(h)` → Boolean
True while the remote recording is still running.

#### `Pack.level()` → Number
RMS 0..100 of the last remote audio block being recorded (-1 = none).

#### `Pack.recordStop(h, [opts])` → String|Boolean|null
Ends the recording and returns the WAV as base64 (the `input_audio` format of
`AI.chat`), the raw WAV with `{raw:true}`, or writes it straight to a file
with `{path:"/local/x.wav"}` (needs `"fs"`; returns true/false — use this for
anything above a few seconds: `FS.writeFile` caps at 64 KB).

```javascript
var mic = Pack.resources("mic").filter(function (r) { return r.ready; })[0];
var h = Pack.record(mic.node, { ms: 4000 });
while (Pack.recording(h)) System.delay(100);
if (Pack.recordStop(h, { path: "/local/remote.wav" })) System.playWav("/local/remote.wav");
```

#### `Pack.snap(node, [opts])` → Number
Takes one JPEG photo on `node`'s camera and writes it to `opts.path` (default
`/local/snap.jpg`; needs `"camera"` and `"fs"`). Reliable transfer over ESP-NOW
(1400-byte blocks, bitmap ACK, only the missing blocks are resent). Poll
`Pack.status(h)`: `bytes`/`total` show progress and `state` becomes `"done"`
once the file is written (~3 s for a VGA frame). `opts.quality` 5..63 (lower =
better, default 12). The photo comes from the camera's current mode: a node
scanning QR codes sends a grayscale frame, no sensor reconfiguration.

#### `Pack.view(node, [opts])` → Number
Live video from `node`'s camera: a stream of JPEG frames at `opts.fps` (1..10,
default 3; frames incomplete in the air are dropped, never resent).

#### `Pack.drawFrame(h, x, y)` → Boolean
Draws the newest complete frame of a `Pack.view` session at `x, y` (same decoder
and scaling as `System.drawJPG`); false = no new frame since the last call.

```javascript
var cam = Pack.resources("camera").filter(function (r) { return r.ready; })[0];
var h = Pack.snap(cam.node, { path: "/local/photo.jpg" });
while (Pack.status(h).state === "open" || Pack.status(h).state === "opening") System.delay(100);
if (Pack.status(h).state === "done") System.drawJPG("/local/photo.jpg", 0, 0);
```


## 42. API Level 38 — Generic resources: pack relays, GPIO and sensors

The product idea: **any hardware feature becomes a published resource**.
API 38 adds two types to the pack catalog and the first native providers:

| Resource | Type | Arbitration | What it does |
|---|---|---|---|
| `rele1`..`rele3` | `gpio` | exclusive, **private** pack, `res_share_gpio` (default `"0"`) | drives the board's relay lines (SKUs with L1..L3) |
| `gpio` | `gpio` | same | one free digital output pin (`{"pin":N}` in `open`) |
| `lum` | `sensor` | shared, `res_share_sens` | board light sensor, 0..100 `%` |
| `bat` | `sensor` | shared, `res_share_sens` | battery charge, 0..100 `%` |

`Pack.resources()` shows the sensor unit and range plus the actuator params
schema (`schema`).

#### Opening a relay (auto-off)

Pass `{"off":1}` in `open` to request **auto-off**: when the session ends
(lease expires, `close`, revocation — including the local owner using
`System.relay`, which always wins), the relay **switches off by itself**. The
whole pack can go down and the actuator still returns to rest.

```javascript
// (app declares "gpio" in app.json)
var r = Pack.resources("gpio").filter(function (x) { return x.name === "rele1"; })[0];
var h = Pack.open(r.node, "rele1", { off: 1 });
while (Pack.status(h).state === "opening") System.delay(100);
if (Pack.status(h).state !== "open") throw new Error("rele1: " + Pack.status(h).reason);
Pack.write(h, "\u0001\u0001");   // [1][1] = on
System.delay(30000);               // ...water the plants...
Pack.write(h, "\u0001\u0000");   // [1][0] = off
Pack.close(h);                     // session ends: auto-off guarantees 0
```

The `gpio` data protocol is binary, 1 opcode byte: `[1][0|1]` writes, `[2]`
reads (the owner answers `[2][0|1]`). Future ops (pulse/PWM) answer `[255]`.

#### Sensor: stream or on demand

`Pack.open(node, "lum", { rate: ms })` subscribes to a **stream**: the owner
samples by itself and pushes 8-byte messages `[ts u32][f32 LE]` (the value in
the catalog's `unit`). With `rate` omitted (or 0) the reading is **on
demand**: `Pack.write(h, "\x02")` asks for one sample and it arrives in
`Pack.read`. With a rate the session needs ESP-NOW (like audio); on demand
also works over the plain mesh.

```javascript
var t = Pack.open(node, "bat", { rate: 60000 });   // one sample per minute
while (true) {
  var d = Pack.read(t);
  if (d) show(decode(d));                          // 8 bytes: ts u32 + f32 LE
  System.delay(1000);
}
```

Actuator safety, in short: exclusive (one hand on the pump at a time),
private pack (the open network refuses with `denied`), `res_share_gpio`
defaults `"0"` (the owner turns it on on purpose), a notification on the
owner for every session ("rele1 in use by X") and **local use always wins** —
`System.relay` on the owner itself revokes the remote session instantly.

## 43. API Level 40 — Joining the pack: `Pack.join` and the CelerLink invite

The pack stands on three pillars, and since API 40 they share one identity
(`Pack.me().id`/`name` are the same on all three):

| Pillar | Role | JS |
|---|---|---|
| **CelerLink** | trust: pair by 6-digit code, then hand over the pack key | `CelerLink.*` (low level) |
| **CelerNet** + resources | the mesh: presence, messages, resources | `Pack.*` (facade), `CelerNet.*` (low level) |
| **HostLink** | the gateway: a computer joins over the USB cable | `celerctl` / the Rust crate (no JS) |

A device only shares its mic, camera and relays inside a **private pack**
(see section 41). There are three doors into one, all landing on the same
key: the password (`Pack.join`, shell `mesh join`, `celerctl mesh join`),
the **invite** over a CelerLink pairing (no password typed on the new
device) and the cable. These calls change the device's network key, so
they need the `"system"` permission in `app.json` (the same as
`Net.wifiConnect`); without it they return `false`. The key itself never
reaches JS.

`Pack.me()` gains `net` (pack name; `"celer"` = the open network) and
`provisioned` (Boolean: inside a private pack). `CelerLink.scan()` and
`status()` gain `node`, the peer's pack id (section on CelerLink).

#### `Pack.join(name, password)` → Boolean
Joins (or creates) the private pack `name` (1–15 chars) with `password`
(≥ 8 chars; prefer 12+). Another device typing the same pair lands in the
same pack — nothing to sync. Blocking ~0.3 s (key derivation). `false` on
invalid arguments, missing permission or a storage error.

#### `Pack.leave()` → Boolean
Forgets the pack and returns to the open `"celer"` network.

#### `Pack.acceptInvite([on])` → Boolean
New-device side: opens (default) or closes the **invite window** for 10
minutes. The device starts advertising over CelerLink with the code gate;
show `CelerLink.status().code` while `CelerLink.status().pairing` is true.
The window closes by itself after joining, after 10 minutes or when the app
exits.

#### `Pack.invite()` → Boolean
Member side: sends the pack key, sealed with the CelerLink bond, to the
connected peer that was **verified by code** (`CelerLink.connect` +
`CelerLink.verify`). `false` outside a private pack or without a verified
peer. The answer arrives in `Pack.inviteStatus()`.

#### The computer as a pack member (API 41)

With the USB cable plugged into a gateway (any device talking to
`celerctl`) and `res_share_usb` on (`celerctl shell cfg res_share_usb 1`),
the computer **joins the pack as a virtual member**: every device lists it
in `Pack.members()` as `pc-XXXX` (XXXX = the gateway's id; `caps.hub` true;
its id is in the `FFxx` range). Apps talk to it like to any member —
`Pack.send("pc-1CAE", {...})` reaches `celerctl mesh listen` on the
computer, and what the computer sends (`celerctl mesh send W "hi"`) arrives
in `Pack.poll()` with `fromName: "pc-1CAE"`. On the gateway itself the alias
`"pc"` works too. Unplug the cable and the member leaves with its presence;
sessions the computer held are closed (relays opened with `off:1` switch
off). No new JS calls: it is the same `Pack` contract.

#### `Pack.inviteStatus()` → String
`"idle"`, `"waiting"` (window open), `"joined"` (we joined through an
invite), `"sent"` (invite out, waiting for the answer — up to 10 s), `"ok"`
(the invited device joined) or `"fail"`.

### Example — inviting a new device

```javascript
// on the NEW device (Matilha app -> "Wait for invite"):
Pack.acceptInvite(true);
// each frame: if (CelerLink.status().pairing) show CelerLink.status().code
// when Pack.inviteStatus() === "joined": Pack.me().provisioned === true

// on a device ALREADY in the pack:
var peers = CelerLink.scan(3000);
if (peers.length && CelerLink.connect(peers[0].id) && CelerLink.verify(typedCode)) {
    Pack.invite();                       // later: Pack.inviteStatus() === "ok"
}
```

## 44. API Level 42 — Single-file app package: `System.installZip`

The whole app fits in ONE `.zip` file — the same one the hub already
produces on publish (`app.zip`, DEFLATE, flat layout with `app.json` at
the root). `System.installZip` unpacks and publishes the app under
`/local/apps/<name>` with an atomic swap: extracts into `<name>.new`,
checks that the `app.json` entry file exists, and only then swaps in the
new folder — if anything fails midway (truncated zip, disk full, power
loss), the old app stays intact. The App Store uses it to replace N
downloads with 1 blob; from the bench the counterpart is
`celerctl apps installzip package.zip` (or the shell `installzip`
command).

Package requirements: up to 64 entries, `stored` and `deflate` methods,
single file up to 272 KB and up to 448 KB uncompressed total (the fine
per-category budgets remain in the publish lint). Requires the `system`
permission.

#### `System.installZip(zipPath, name)` → Object (API 42)

`zipPath` is the `.zip` path on the device (typically downloaded with
`Net.download` into `/local`); `name` becomes the folder
`/local/apps/<name>` (no slashes, no `..`, up to 40 chars — the app
display name, same folder convention). Blocking; refreshes the
exec-timeout window at the end. Returns `{ok: true, files, bytes}` or
throws `Error` (`installZip: pacote recusado` for a bad zip/budget/entry,
`installZip: nome de pasta invalido` for a bad folder name). After
publishing, the launcher is rescanned — the app shows up in the grid
without a replug.

### Example — installing a downloaded blob

```javascript
// download the whole package in 1 request (the hub catalog publishes
// it.zip = {url, size, md5} once the server serves the zip)
var ok = Net.download(it.zip.url, "/local/blob.zip", function (got, total) {
    drawProgress(got, total);
});
if (ok && FS.md5("/local/blob.zip") === it.zip.md5) {
    System.installZip("/local/blob.zip", it.name);   // {ok:true, files:N}
    FS.remove("/local/blob.zip");
}
```

## 45. API Level 42 — Background services and policy gates

An app can declare `"service": "service.js"` in its app.json: the JS
runs OUTSIDE the foreground in an OS-owned heap (one thread per
service, no UI), pumped by the services table with an 8 ms/tick budget.
The surface available to a service: timers (`setTimeout`/`setInterval`),
`require()` from the app folder, `Storage` (per-package NVS), `FS`
(same jail), `CelerNet`/`Pack` (poll) and the lean `System` below +
`Service`. Not available to a service: UI/touch, `Net.*` (use
`System.otaCheck` instead), AI, mic, camera. A service inherits the
app's consent (it can only do what the app may); a throwing callback
STOPS that service (`system:true` apps get one restart after 60 s).
Without PSRAM the service heap suspends while an app is in the
foreground; with PSRAM it stays up. The service's companion: `install.sh`
in the app folder runs once per version under the device `sh` in
RESTRICTED mode (filesystem commands only, jailed to the app folder and
`/local/data/<pkg>`, ≤16 KB). The dialect is the CelerOS shell, not
Bourne: blocks are `if COND` / `else` / `end` — there is no `then`/`fi`,
and under `sh -e` an unknown command stops the script right there. The
shell has no quotes; it has `>`/`>>` redirection, `$VAR`/`$?` expansion
and the usual file commands (`test`, `echo`, `cp`, `rm`...). Paths must
be ABSOLUTE (`../data` resolves to `/local/apps/data` and is denied);
`echo` joins its arguments with single spaces, which rebuilds JSON
verbatim. Success records the version marker; failure leaves it unset,
so the script runs — and posts a notification — on EVERY boot until it
passes. Always run it once on the bench (`celerctl shell "svc setup
<pkg>"`) before publishing.

#### `System.appOpen()` → bool (API 42)
true while a JS app is in the foreground. Policy gate: the Nucleo
update check never fires with an app open.

#### `System.updateBusy()` → bool (API 42)
true while a manual check or an OTA is running — never fire a check on
top of a check.

#### `System.shellActive()` → bool (API 42)
true while a `celerctl` session is active (an in-flight debug/ota push
must not be trampled).

#### `System.syncTime()` → bool (API 42)
Attempts SNTP now and returns whether time is ALREADY valid (SNTP
settles asynchronously — repeat next tick while `System.timeValid()` is
false).

#### `System.timeValid()` → bool (API 42)
Time is valid (SNTP/manual/phone since boot).

#### `System.persistTime()` → bool (API 42)
Persists the epoch to NVS (the TimeManager's 10-min saveEpoch became
the Nucleo service's policy; the native side is now a watchdog and
takes over if the service goes silent for 15 min).

## 46. API Level 44 — 32 shared dependencies per app

The runtime and the launcher's module garbage collector read the app's
`deps.json` (the transitive closure resolved at install) up to **32**
modules. Up to API 43 both stopped at 8: the rest of the closure failed
with "module not found" and the collector deleted those modules from
`/local/modules`. When a `deps.json` fills the ceiling (possibly cut) the
collector now skips the run instead of deleting anything. Nothing changes
in the JS API: apps with a closure larger than 8 modules (a CelerGame
adventure uses ~19) declare `"api": 44`.

## 47. API Level 45 — `System.copySprite` (sprite region to the current target)

#### `System.copySprite(id, sx, sy, w, h, dx, dy, key)` (API 45)
Copies the region (sx, sy, w, h) of sprite `id` to (dx, dy) of the CURRENT target: the frame, or a sprite
selected with `useSprite`. There is no scaling. `key` is optional: pixels of that RGB565 colour are not
copied. The target's clip comes back as it was. Copying a sprite onto itself is ignored.

It is the scale-1 sheet stamp in a single call:
- **Onto the frame:** it replaces `setClip` + `useSprite` + `pushSprite` + `useSprite(0)` + `clearClip`.
- **Into another sprite:** `pushSprite` only targets the frame, so baking a background (a 195-tile room)
  had to go through the affine `drawSprite` with a clip (~240 µs per 32x32 tile on the 4848, against
  ~150–200 µs here). Together with `celeros.game.world` 1.1 (`tile` option), a room change in the
  Lenda went from ~250 ms to ~120 ms.

S3 boards only (`CONFIG_CELEROS_JS_GAME_ACCEL`, like `drawSprite`), so feature-detect it. `celeros.game.spr`
1.5.1 uses it inside `E.spr.stamp`/`E.spr.blit` when it exists.

```javascript
// room baked into a sprite, one call per tile (sheet of 32 px cells)
System.useSprite(roomSpr);
for (var k = 0; k < tiles.length; k++) {
    var t = tiles[k];
    if (System.copySprite) System.copySprite(sheet, t.sx, t.sy, 32, 32, t.x, t.y);
    else System.drawSprite(sheet, ...);   // API 44 and older
}
System.useSprite(0);
```

## 48. API Level 47 — Pack sensors and actuators: events, pulse/PWM, reflexes and ACL

API 47 closes the pack's **sensor → decision → actuator** loop: actuators get
pulse and PWM, sensors push **events** on a threshold crossing, the firmware
runs **reflex rules** on its own (NVS; survives a closed app and an offline
PC), and the owner can say **who** may open each resource.

### Actuators: pulse and PWM

`gpio`/`releN` gained the ops that used to answer `[255]` (the catalog
`schema` now announces `{"off":1,"ops":"1234"}`):

| DATA | Effect |
|---|---|
| `[1][0|1]` | on/off (API 38) |
| `[2]` | read (answers `[2][0|1]`) |
| `[3][ms u16 LE]` | **pulse**: turns on now and the owner turns it off on its own when the time is up (1..65535 ms) |
| `[4][0..100]` | **PWM** on the generic `gpio` pin (8-bit LEDC) — a relay refuses it with `[255]` (it switches mains, it is not a dimmer) |

JS apps may send **objects** instead of bytes — the owner understands the
textual form `{"w":1}`, `{"r":1}`, `{"p":3000}` and `{"d":50}` (a string with
a byte >0x7F becomes two bytes on the wire, so objects are the safe path):

```javascript
var h = Pack.open(r.node, "rele1", { off: 1 });
Pack.write(h, { p: 3000 });    // 3 s pulse; the owner turns it off
Pack.write(h, { d: 50 });      // 50% PWM (generic "gpio" only)
```

Over celerctl: `res pulse rele1 3000`, `res pulse -n A1B2 rele1 3000` (another
node, through the gateway) and `res pwm <pin> 50`.

### Sensors: bigger catalog and threshold events

The native catalog grew: `lum` and `bat` (API 38), **`temp`** (IMU die, where
present) and **`adc`** (a free ADC pin via `{"pin":N}` in `open`; the pin goes
through the firmware guards — never flash/PSRAM).

Open a sensor with `{gt: limit}` and/or `{lt: limit}` (+ `{h: hysteresis}`) to
get **events** instead of a stream: the owner evaluates the limit at 1 Hz (or
at `rate`) and pushes a 10-byte message on the **transition** — `[0xE0][ts
u32][f32 LE][dir]`, `dir` 1 = rose (`gt`), 2 = fell (`lt`). Hysteresis re-arms
the event; a 1 s per-session cooldown holds noise back. Events also travel
over the BLE mesh (multi-hop) when there is no ESP-NOW.

```javascript
var h = Pack.open(no, "lum", { lt: 20, h: 2 });   // "it got dark"
// in the loop:
var ev = Pack.onEvent(h);      // {v, dir:"lt", at} | null
if (ev) lightOn();
```

Samples stay available through `Pack.read(h)` (the same 8-byte format as API
38) and on-demand reads with `{"r":1}` (or `"\x02"`) still work.

### Native reflexes: `Pack.ruleAdd` / `ruleDel` / `ruleList`

A rule lives in the node's **NVS** and is evaluated by the firmware: "if my
sensor X crosses Y, apply Z". It survives a closed app, app switches, JS
crashes and an offline PC. The rule lives on the **sensor's** node (whoever
owns the data decides); the target may be local (the node's own `releN`) or
remote (a system session on the other node's resource, with auto-off). When
the condition goes back, the action is **undone** (relay off); `notificar`
only fires on entering.

```javascript
// (perm "system") on the light-sensor node:
Pack.ruleAdd({ sensor: "lum", op: "lt", valor: 20, h: 2, alvo: "rele1", on: 1 });
Pack.ruleAdd({ sensor: "bat", op: "lt", valor: 15, notificar: "Battery low" });

Pack.ruleList();        // [{id, sensor, op, valor, h, alvo, no?, on, notificar?}]
Pack.ruleDel(1);
```

From the shell/celerctl: `svc reflex ls`, `svc reflex add lum lt 20 2 local
rele1 on`, `svc reflex add lum gt 35 0 local rele1 off`, `svc reflex notify
bat lt 15 1 Battery low`, `svc reflex del 1` (`res rule ...` on celerctl). The
`adc` sensor and remote sensors are not evaluated by a rule in this version.

### ACL: who may open each resource

Until API 46 any private-pack member could open whatever was shared (the
`res_share_*` switches are per TYPE). API 47 adds the per-RESOURCE list, in
the **owner's** NVS:

```
res acl                     # catalog with each resource's mode
res acl rele1 list A1B2     # only node A1B2 (hex) may open rele1
res acl lum add C3D4        # append
res acl rele1 open          # back to open (the default)
res acl rele1 del A1B2      # remove
```

Outside the list, OPEN is refused with `denied` (before the exclusivity
arbitration). The PC on the cable counts as a node (`pc-XXXX`): to allow only
it, list the id shown by `celerctl mesh status`. The list is edited locally
(shell/app); signed distribution with the `adminKey` arrives next round,
together with the owner-side consent dialog.

### Discovery: `CAPS_RES`

The BEAT gained bit `0x80` (`CAPS_RES`): "this node publishes resources".
Members show the extra `caps` bit in `Pack.members()` — handy for UI filtering
before `Pack.resources()` (the catalog remains the source of truth).

## 49. API Level 48 — USB Host and OS input: `USB.*` and `Input.*`

**Where it exists.** Only on firmware built with `CELEROS_USB_HOST` (today
the `devkit-s3` board: ESP32-S3 N16R8, with the native USB-C in **host**
mode) and in an app with the `"usb"` permission in `app.json`. Keyboard and
mouse also require `"input"`. Feature-detect with
`System.getInfo().hasUsbHost` and `typeof USB !== "undefined"` — other
boards do not have the object.

**What the firmware does.** It enumerates devices, reads descriptors and
runs transfers. **No device driver lives in C++**: ESC/POS, HID, SCSI,
vendor protocols... are JS on top of this API. The `celeros.usb`,
`celeros.usb.escpos` and `celeros.usb.hid` hub deps carry the first
reference drivers.

**Bytes are arrays of numbers (0..255).** The firmware Duktape is *lean*:
there is no `Uint8Array`/`ArrayBuffer`. The cap is **4096 bytes** per
transfer; for a bigger job, write the binary to a file and use
`USB.sendFile` (2 KB chunks streamed on the C++ side, never through the JS
heap).

**One owner per interface.** `USB.claim` marks the interface for the current
app/service; claims and listeners are released automatically when the app
exits (or on `svc stop`). While it is held, another app gets `false`.

**Hotplug.** `USB.poll()` returns one event per device that attached or
detached; drain until `null` every frame (or on each service tick).

**Console on UART.** On the S3 the USB-OTG shares the PHY with
USB-Serial/JTAG: with the host installed, the console/celerctl lives on
UART0 (the DevKitC-1 "UART" connector). The host VBUS is not
software-switched — the board must supply 5 V (use a powered hub when the
device draws more current).

### `USB.devices()` (API 48)
Lists the enumerated devices:

```javascript
[ { addr: 1, vid: 0x04B8, pid: 0x0202, cls: 0, subcls: 0, proto: 0,
    speed: 2, claimed: [0],
    ifs: [ { n: 0, alt: 0, cls: 7, subcls: 1, proto: 2,
             eps: [ { addr: 0x01, type: 2, mps: 64, ivl: 0 },
                    { addr: 0x82, type: 2, mps: 64, ivl: 0 } ] } ] } ]
```

`addr` is the USB address (1..127) used by every other call. Endpoint
`type`: 0 control, 1 iso, 2 bulk, 3 interrupt; `addr` with bit 7 set means
IN. `claimed` lists interfaces held by some app/service and `speed` is the
negotiated speed (1 low, 2 full, 3 high). Returns `[]` without the host.

### `USB.poll()` (API 48)
Next hotplug event or `null` when the queue is empty:
`{type:"add"|"remove", addr, vid, pid}`. A service that must react to
plug/unplug drains it from a `setInterval`.

### `USB.claim(addr, iface[, alt])` (API 48)
Claims interface `iface` (alternate `alt`, default 0) for the current app.
Required before any endpoint transfer. Returns `true` on success; `false`
when the device is gone or another owner already holds the interface.

### `USB.release(addr, iface)` (API 48)
Releases the interface (only the owner can). App exit already does it.

### `USB.controlIn(addr, bmRequestType, bRequest, wValue, wIndex, len[, timeoutMs])` (API 48)
Control IN transfer (e.g. read the HID report descriptor with
`bmRequestType=0x81, bRequest=6, wValue=0x2200`). Returns
`{ok, status, len, data}` with up to `len` bytes (max 2040). `timeoutMs`
defaults to 250, capped at 5000.

### `USB.controlOut(addr, bmRequestType, bRequest, wValue, wIndex, data[, timeoutMs])` (API 48)
Control OUT transfer (e.g. HID `SET_IDLE`, CDC `SET_LINE_CODING`). `data` is
a byte array. Returns `{ok, status, sent}`.

### `USB.out(addr, ep, data[, timeoutMs])` (API 48)
Bulk/interrupt OUT. `ep` is the OUT endpoint address (bit 7 clear). Send
printer commands, packets for your own driver, etc. Returns
`{ok, status, sent}`. `status`: `"ok"`, `"stall"`, `"timeout"`, `"error"`,
`"gone"`, `"busy"`, `"overflow"`, `"canceled"`.

### `USB.in(addr, ep, len[, timeoutMs])` (API 48)
One-shot bulk/interrupt IN: returns `{ok, status, len, data}`. For a
continuous stream (keyboard/mouse/status) prefer `USB.listen` + `USB.read`:
one `USB.in` per frame loses reports between calls.

### `USB.sendFile(addr, ep, path[, maxBytes[, timeoutMs]])` (API 48)
Sends a device file straight to the OUT endpoint in 2 KB chunks (the payload
never enters the JS heap). Requires the `"fs"` permission and honors the FS
jail. Cap of 512 KB per call. Returns `{ok, status, sent}` — ideal for a
pre-rendered ESC/POS receipt or logo.

### `USB.listen(addr, ep, len[, depth])` (API 48)
Starts continuous reading of an IN endpoint (interrupt or bulk): the core
keeps a ring of `depth` records of up to `len` bytes (1..256) and resubmits
the URB by itself. Returns `true` when the listener was created. Each
app/service gets up to 4 simultaneous listeners; they die with the app.

### `USB.read(addr, ep)` (API 48)
Pops the next listener record: byte array or `null` when empty. Drain it in
a `while` every frame.

### `USB.unlisten(addr, ep)` (API 48)
Stops the listener and releases the ring/URB. Returns `true` if it existed.

### `USB.flush(addr, ep)` (API 48)
Clears a stuck endpoint (after `"stall"`/timeout): the pending URB is
cancelled and the endpoint returns to a clean state. Returns `true` on
success.

### Writing a driver: ESC/POS printer

```javascript
var usb = require("celeros.usb");
var esc = require("celeros.usb.escpos");

if (usb.available()) {
    var p = esc.open(usb.find({ cls: 7 }));   // class 7 interface
    if (p) {
        p.receipt("CELER OS", ["Hello, world!", "driver in JS"], "https://os.celer.tec.br");
        p.close();
    }
}
```

The `celeros.usb.escpos` dep is just a sample driver: `p.raw([...])` sends
raw bytes, `p.file("/local/receipt.bin")` streams a pre-rendered job, and
`p.text/line/align/size/bold/qr/cut` cover the common receipt; `p.status()`
reads the real-time status (DLE EOT 1/2: `{online, erro, esperando, papel,
acabando, raw1, raw2}` — it retries itself the ZLP that Epson printers
answer with on the first IN after open). Accented text: call
`p.codepage(16)` (WPC1252) before writing — text bytes go out as Latin-1.
For a specific model, change the command sequence — the firmware stays the
same. The Epson TM-T20X (vid 04B8, interface 7.1.2, 64-byte bulk OUT/IN) is
bench-validated by the devkit-s3 `Impressora` app.

### Reading a flash drive (MSC)

A flash drive is class 8, subclass 6, protocol 0x50 (Bulk-Only Transport).
The `celeros.usb.msc` dep implements BOT + SCSI + FAT32/exFAT **in JS**; the
firmware only delivers the bulk transfers. The volume may sit at LBA 0
(superfloppy) or inside an MBR/GPT partition — the driver locates it:

```javascript
var msc = require("celeros.usb.msc");
var vol = msc.openVolume(usb.find({ cls: 8 }));
if (vol) {
    var i = vol.info();                 // {type,label,totalBytes,...}
    var list = vol.list("/");           // [{name,dir,size}]
    var bytes = vol.read("/NOTE.TXT", 4096);   // byte array (up to 64KB)
    vol.close();
}
```

Read-only in this version (list, `stat`, read a file); `writeBlocks` already
exists as the primitive for a FAT-allocating driver. The hub `USB Storage`
app is the navigation reference (headless prints the root to logcat).

### `Input.key(usage, mods, down)` (API 48)
Injects a key into the OS input bus (`"input"` permission). `usage` is the
**HID usage ID** (0x04=A ... 0x1D=Z, 0x28=Enter, 0x29=Esc, 0x2C=Space);
`mods` is the HID modifier byte (bit0 LCtrl, bit1 LShift, bit2 LAlt, bit3
LGUI, bit4 RCtrl, ...). Returns `true` when the queue accepted it.

### `Input.poll()` (API 48)
Next injected key: `{key, mods, down}` or `null` when the queue is empty.
Single queue: one consumer at a time (the foreground app, or the service
that bridges it).

### `Input.move(x, y, buttons)` (API 48)
Moves the pointer in the 240x320 virtual space. `buttons`: bit0 left, bit1
right, bit2 middle. On a display board the pointer joins the touch pipeline
as a synthetic finger (reserved id), so the mouse clicks and drags in the UI
like a touch; on a headless board the app reads it with `Input.pointer()`.

### `Input.pointer()` (API 48)
Current pointer state: `{x, y, buttons}`.

### `Input.clear()` (API 48)
Clears the key queue and the pointer (bench, or a driver that disconnected).

### Example: keyboard/mouse driver as a service

The factory `USB HID` app on `devkit-s3` is the full reference: it runs in
the svchost, opens keyboards (HID boot protocol 1) and mice (protocol 2),
diffs the reports and calls `Input.key`/`Input.move`. Any app with the
`"input"` permission reads the result:

```javascript
var ev;
while ((ev = Input.poll()) !== null) {
    System.print("key " + ev.key + (ev.down ? " down" : " up"));
}
var p = Input.pointer();
System.print("mouse " + p.x + "," + p.y + " buttons " + p.buttons);
```

The firmware does not interpret keys: an app decides what to do with them
(shortcuts, games, an editor). On a display board the pointer already drives
the launcher and apps; keyboard navigation of the system UI does not exist
yet in this version.
