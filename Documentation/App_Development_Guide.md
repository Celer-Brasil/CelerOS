# CelerOS App Development Guide

**English** | [Português (BR)](App_Development_Guide.pt-BR.md)

Welcome to the CelerOS App Development Guide! Developing apps for CelerOS is simple. Apps are written in JavaScript and use a standard folder structure containing metadata and code.

## 1. App Folder Structure

In CelerOS, an app is not just a single `.js` file. Instead, every app is a **folder** containing all its necessary files. When you install your app with `celerctl apps install <folder>`, from the SD card (Installer) or through the App Store, the whole folder is what gets deployed.

A standard app folder looks like this:
```text
MyAwesomeApp/
├── app.json
├── icon.png
├── main.js
├── notas.js          # optional JS module (require("notas"), API 23)
└── alerta.wav        # optional asset (playWav/drawPNG/FS.readFile)
```

**Modules (API 23):** split your code into as many flat `.js` files as you like and load them with `require("name")` — CommonJS-style (`module.exports`/`exports`), cached per run, modules may require modules:

```js
// main.js
var notas = require("notas");   // loads notas.js from the app folder
notas.tocar("alerta");

// notas.js
var audio = require("audio");
exports.tocar = function (n) { audio.beep(n); };
```

**Assets:** any extra files in the folder (flat, no subfolders) ship with the package through the hub: `.js .png .wav .json .bin`, up to 16 extras, 128 KB each, 256 KB of assets in total. Reference them by path (`System.playWav("/local/apps/MyAwesomeApp/alerta.wav")`) or read with `FS.readFile`. The hub computes a `files` manifest automatically — never set it by hand.

## 2. The `app.json` File (App Metadata)

The `app.json` file is the heart of your app's identity. The CelerOS Installer reads this file to securely install, update, and categorize your application.

### Example Format:
```json
{
  "name": "My App",
  "packageName": "com.developer.myapp",
  "version": "1.0.0",
  "metaUrl": "https://raw.githubusercontent.com/.../myapp/app.json",
  "author": "John Doe",
  "description": "A cool app that does awesome things.",
  "type": "App",
  "category": "Utility",
  "api": 6,
  "changelog": "Initial release."
}
```

### Field Details:
- **`name`**: The display name of your app. This is what the user sees in the Home.
- **`packageName`**: A globally unique identifier for your app. **Rules: lowercase, dot-separated style, no spaces** (e.g., `com.yourname.appname`). The OS uses this to detect if your app is already installed.
- **`version`**: Semantic versioning (e.g. `1.0.0`, `1.2.1`). If a user installs an app with the same `packageName` but a higher version number, the OS will smartly prompt them to "Update" rather than "Install".
- **`metaUrl`** *(optional)*: The raw URL to the `app.json` on the internet (e.g. your GitHub repository). Apps published on the **CelerOS Hub don't need it** — the store catalog itself carries name, version, changelog, size and the MD5 checksum of your `main.js`; `metaUrl` is only for self-hosted update checks outside the hub.
- **`author`**: Your name or studio. If someone else tries to install an app with your `packageName` but a different `author` name, the OS will throw a conflict warning to protect your app from being overwritten by malicious developers.
- **`description`**: A short summary of your app, displayed to the user when they install your app for the first time. Accented Latin-1 characters (ç, ã, é...) render fine since API 7; avoid em dashes, curly quotes and emoji (outside the font).
- **`type`**: The broad classification (e.g., `App` or `Game`). You can type any value here without restriction.
- **`category`**: The specific category (e.g., `Utilities`, `Games`, `Tools`). You can type any value here without restriction.
- **Boards without PSRAM** (e.g. the classic CYD): the whole `main.js` — plus the JS heap and the compile temporaries — must fit in internal RAM; a source past ~60KB doesn't compile there (comments and indentation are stripped before compiling, so they cost nothing). Apps bigger than 48 KB must declare `"requires": ["psram"]`; the store badges them "Requer PSRAM" and blocks the install on boards without PSRAM.
- **`permissions`** (optional, F4): array of capabilities — `"fs"`, `"net"`, `"gpio"`, `"system"`. Without the field the app keeps everything (compat with the existing store); with it, only what is declared is registered: `FS` / `Net` / `System.gpio` **plus the external-hardware calls** (`System.led`, `System.relay*`, `System.neopixel`) and the device-affecting calls such as `restart`/`otaStart`. System files under `/local` (WiFi credentials, PIN, OTA/boot config) additionally require `"system"` even for apps with `"fs"`. System apps (`"system": true`) always get everything.
- **`api`**: The CelerOS API level your app targets (see the [JS API Guide](JS_API_Guide.md) — currently `36`). This is verified by the system at install time.
- **`deps`** *(optional, API 30)* — shared libraries from the hub instead of vendored copies: `"deps": { "celeros.game": "^1.0.0", "celeros.physics": "^2.1.0" }`. The version is a `^X.Y.Z` range (same major, ≥ base) or an exact `X.Y.Z`; the store resolves it **at install time** into `/local/modules/<name>/<version>/` (one copy per version on the device, shared across apps) and writes the choice to `<app folder>/deps.json`, which is what `require()` reads. A local `<name>.js` in the app folder still wins over the cache (vendoring keeps working). Deps count toward the 48/128 KB compile ceiling. Resolution order and details: [JS API Guide, section 35](JS_API_Guide.md).

**How ranges behave** (the Dart `pub` model): `^1.1.0` runs on any 1.x ≥ 1.1.0 — resolution always picks the newest satisfying version, so minor/patch releases of a dep reach your app without touching it. The **major is the breaking line**: `^1.x` never jumps to 2.0, and different majors coexist on the device (`/local/modules/<name>/1.9.0/` and `/2.0.0/` side by side; each app's `deps.json` pins its own). If an app really needs a new major, bump the range in `app.json` and publish. `deps.json` is the per-app lockfile: it freezes what was resolved so the app boots reproducibly; refresh it with `celerctl apps deps --upgrade` (or the store's "Atualizar engine"). **Every install path syncs deps for you** — `celerctl apps install`, the store, `celerctl dev` (on start and whenever `app.json` changes, `--deps-local` to test repo versions before publishing) and `celerctl push PASTA /local/apps` all resolve against the hub, fill `/local/modules` and write `deps.json` before the app runs. `node tools/sdk/celer.js deps <Pasta> --verify` fails when a range has no satisfying version on the hub (the `celer.js check` gate enforces it for `hub_apps`).
- **`requires`** (optional): hardware requirements — `"psram"` is the only value today. It raises the hub ceiling for `main.js` from 48 KB to 128 KB (boards with PSRAM compile without a runtime limit); the store badges the app "Requer PSRAM" and blocks the install on boards without PSRAM (CYD, devkit). An SD card does **not** raise the ceiling: the limit is compile RAM, not storage.
- **`changelog`**: A brief string detailing what changed (one line per version works well, e.g. `"1.1.0 - fixed crash\n1.0.0 - first release"`). The hub publishes it with the catalog and the device store shows it under a **"Novidades" / What's New** header on the update screen.

### Fields managed by the CelerOS Hub

When you publish through the hub (`tools/celerhub.py`), four
fields of `app.json` are computed and written by the server — **don't set them
by hand** (a manual publish overwrites them again):

- **`size`** — byte size of `main.js` (the store checks free disk space before downloading).
- **`md5`** — checksum of `main.js`; the device validates it after downloading and aborts the update on mismatch, leaving the installed version untouched.
- **`published_at`** — UTC timestamp of the publish.
- **`publisher`** — token name that published the package.

### App update rules (CelerOS Hub)

- **The catalog is the update channel.** The device store compares each catalog version against the installed one; newer versions show an **"Atualizar"** badge in the list, the **Atualizações** tab and the **"Atualizar tudo"** button.
- **Bump `version` on every publish.** The hub rejects versions ≤ the published one (`--force` to override, e.g. to republish a fixed package).
- **You own your `packageName`.** The first publisher becomes the owner; only the same token (or the hub root) can update or remove the package afterwards.
- **Size limits:** the **sum of all `.js` files** (`main.js` + modules) must be ≤ **48 KB**; declaring `"requires": ["psram"]` raises the ceiling to **128 KB** — it's the sum that occupies compile RAM, so modules count against the same budget. Any single `.js` above **30 KB** must declare `api: 6` (old firmware downloaded via `Net.get`, which truncates at 32 KB; the API 6 streaming downloader has no cap). Assets (non-`.js`): 16 extras max, 128 KB each, 256 KB total. `icon.png` ≤ 16 KB.
- **The icon ships with the update:** keep an `icon.png` (64×64 PNG, ≤ 16 KB) in the package — the store downloads it on install/update and the launcher refreshes its icon cache automatically.
- **Updates land in the folder the launcher runs** (resolved by `packageName`): updating a preinstalled app updates it in place instead of creating a shadow copy.
- **The App Store updates itself:** the store is a regular hub package (`celeros.appstore`). When the catalog has a newer store, it shows up like any update — after installing, the store asks to exit and reopen (the new `main.js` is read from disk on the next launch).

## 3. The `icon.png` File (App Icon)

A 64x64 (or larger, square) PNG shown in the Launcher. On install it is
decoded into the system icon cache (RGB565 + 4-bit alpha), so transparency
and rounded corners work. Apps without an `icon.png` get a generic icon.

## 4. The `main.js` File (App Logic)

The `main.js` file is the entry point of your application. When a user taps your app in the Launcher, the OS loads and executes this JavaScript file.

Because CelerOS handles the underlying C++ translation, you can write simple, high-level JavaScript to draw graphics, read files, and trigger UI components.

### The app model

* **ES5 only**: no arrow functions, `let`/`const`, `class` or template literals — the engine is Duktape. Use `var` + `function`.
* Your app is a **blocking `while` loop** paced by `UI.end()` (or `System.delay()`) — there are no events or callbacks. Everything is polling: `System.getTouch()`, `System.keypadPoll()`, `CelerLink.poll()`.
* **Multitouch** (API 43): `System.getTouches()` returns ALL fingers as `[{id, x, y, size}]` (primary/oldest first, `[]` when idle). It shares the frame yield with `System.getTouch()` — call **one of the two per loop**, never both. Glass without multitouch (resistive CYD) returns at most one point; the SmartDisplay 4848 and the watch return up to 5. The system chrome (exit corner, top bar, watch edges) consumes the primary finger only.
* All coordinates live in the **virtual 240x320 canvas** (`System.screenWidth()` is 240 everywhere); the OS scales to the physical glass. Pick colors from `System.theme()` instead of hardcoding.
* Exit with `System.exitApp()`. State you want to keep goes in `FS.appData()` (a private folder per app).

### Your First App (`main.js`)

Since API 22 the interface comes from the `UI` toolkit — the same widgets
the system screens use (fonts, buttons with a pressed state, inertial
lists, dialogs), with no hand-written hit-tests:

```javascript
var T = System.theme();
var taps = 0;

while (true) {
    UI.begin(T.bg);                          // reads touch; paints the background on a full frame
    UI.header("My App");
    UI.text("Hello CelerOS!", 120, 90, { role: "title", align: "center" });
    UI.text("taps: " + taps, 120, 130, { align: "center", color: T.accent });
    if (UI.button("Tap", 20, 200, 200, 44)) taps++;
    if (UI.button("Exit", 20, 254, 200, 44, { style: "ghost" })) System.exitApp();
    UI.end();                                // shows the frame and holds ~30 fps
}
```

Custom drawing (games, charts, clock faces) still uses the `System.*`
primitives, inside `if (full)` — `full` is what `UI.begin()` returned. See
section 27 of the [JS API Guide](JS_API_Guide.md) for the redraw model and
the widget list.

### Feature detection across boards

The same app runs on very different boards (a 4" PSRAM SmartDisplay, a
128 KB-RAM CYD, a robot dog). Feature-detect instead of assuming:

```javascript
if (System.getAPILevel() >= 9 && typeof CelerLink !== "undefined") {
    // Bluetooth LE link between CelerOS devices (API 9)
    var peers = CelerLink.scan();
    if (peers.length) CelerLink.connect(peers[0].id);
}

if (System.relayCount() > 0) System.relay(1, true);  // "Y" SKUs (API 8)
if (typeof System.gpio.servo === "function") System.gpio.servo(13, 90);  // API 10

var battery = System.battery();   // -1 on boards without a divider
var level = System.micLevel();    // -1 without a microphone
```

Board flags in `System.getInfo()` (`hasLed`, `hasLightSensor`, `hasSpeaker`)
and the `-1`/`false`/count returns of the hardware calls are the contract —
never assume a peripheral exists.

### Reference apps to read

* Bundled (`data/apps/`): **Snake** (game loop, persisted record), **Terminal**
  (docked keyboard `System.keypad*`), **Touch Test**, **HTTP Demo** (network).
* Hub (`hub_apps/`): **Celer Remote** (API 11) — a full robotics example:
  scans and connects over Celer Link, drives a D-pad that repeats
  `{type:"move",dir}` messages and shows the robot's telemetry.

### Games: CelerGame as shared dependencies

For 2D games the engine comes from the hub as the **CelerGame dependency family** (1.4): `celeros.game` (the core — scenes, loop, multitouch input, gfx, camera, entities, dirty layer, audio, save) plus the optional modules that decorate the same `E` object: `celeros.game.fx` (particles), `.spr` (sprites/sheets/flipbooks), `.tilemap`, `.ui` (title/pause/game-over screens, menus, lists, `toast`), `.pad` (joystick and buttons with multitouch) and the "brain" modules: `.collide`, `.events`, `.fsm`, `.level`, `.path`, `.steer`, `.gen`, `.inv`, `.script`, `.stats`, `.waves` and the aggregators `.combat` (hitboxes/projectiles) and `.world` (rooms). The `celeros.game.kit` bundle carries the whole brain in one dep, to fit the **8-dependency ceiling** of `app.json`. Physics is the `celeros.physics` dep (2.1 — `P.hit`, `P.verlet`/`P.verletFast`, `P.rigid`) and table-driven sounds are `celeros.sfx`. Big games target the PSRAM S3 boards — declare `"requires": ["psram"]` and `"topbar": false` (the `new --game` scaffold does it for you):

```bash
node tools/sdk/celer.js new MyGame --game     # scaffold + celeros.game(+fx) in app.json deps
node tools/sdk/celer.js deps MyApp            # deps of app.json + versions on hub/local
node tools/sdk/celer.js deps set celeros.game.spr ^1.0.0 MyApp
```

> [!NOTE]
> **Migrating off physics 2.0:** `P.world`, `P.tiles` and `P.flow` were removed in celeros.physics 2.0 — use the `celeros.grid` dep for tile/AI grids and `System.rigid*` (API 33) for tumbling rigid bodies. `P.verlet`/`P.verletFast` (and the native `System.verlet*` path) are unchanged.

### AI-generated sprite art (text2d / texture2d)

Store-game sprites and backdrops are generated with the bench AI CLIs and
ship **flat in the app root** (the hub package carries no subdirectories):

```bash
text2d generate "game goblin, cartoon, transparent background" \
  -o MyGame/ai_goblin.png -W 512 -H 512 --category icon --transparent
texture2d generate "seamless grass texture, top-down" \
  -o MyGame/ai_bg.png -W 256 -H 256 -s 20
```

Pack the sprites into an atlas (`ai_atlas.png`, 64 px cells over
**magenta** — the key color is 0xF81F) and load it through the spr module;
keep a procedural fallback for boards without PNG (`E.spr.backed()` tells
you what is live):

```js
E.init({ dir: "MyGame", bases: ["/local/apps/MyGame/", "/sd/apps/MyGame/"] });
E.spr.grid("ai", { file: "ai_atlas", cols: 4, rows: 4, tw: 64, th: 64, prefix: "ai" });
E.spr.stamp("ai0", x, y, { scale: 0.5, key: 0xF81F, ax: 0.5, ay: 0.5 });
E.spr.sheet("aibg", { file: "ai_bg", w: 256, h: 256, regions: { bg: [0, 0, 256, 256] } });
```

### Big apps on the SD card (`apps store --sd`)

The flash partition is small (3.4 MB): games with assets install into the SD
card — `celerctl apps store --sd celeros.mygame` (the launcher scans
`/local/apps` **and** `/sd/apps`; keep the app in exactly one of them). The
card must be **FAT32**: exFAT is unreadable by FatFs, and the device shell
has `sd format` (schedules the format for the next boot and **WIPES the
card**). Pin/limit details in `boards/AGENTS.md`.

Full documentation: **[Game Engine Guide](Game_Engine_Guide.md)**.

> [!IMPORTANT]
> To see everything you can do in `main.js`, please check out the full **[JS API Guide](JS_API_Guide.md)**! It contains all the documentation you need for drawing, GPIO pins, file systems, UI components, and more.

## 5. SDK: from scaffold to publish

The development tools live in `tools/` in the repo, behind a single entry
point (`tools/sdk/celer.js`), with no dependencies to install. Recommended
flow:

```bash
# 1) create the skeleton (app.json at the current API level, sample main.js,
#    icon.png and celer.d.ts for VS Code autocomplete)
node tools/sdk/celer.js new MyApp

# 2) iterate locally: lint on every save, live preview in the browser
node tools/sdk/celer.js lint MyApp
node tools/sdk/celer.js emu MyApp --serve --open   # live: mouse/touch, keys, hot reload
node tools/sdk/celer.js emu MyApp                  # saves MyApp/.dev/tela.png

# 3) dev loop on the device: watches files, reinstalls what changed,
#    terminates the running app (shell `exit`) and reopens it, with live logs
python3 tools/celerctl.py dev MyApp [--shots]

# 4) publish
node tools/sdk/celer.js publish MyApp --dry  # offline validation
node tools/sdk/celer.js publish MyApp
```

### CelerKit: shared modules for general apps

For non-game apps, the `celeros.app.*` dependency family (CelerKit) gives
you a ready screen loop, overlays, forms, lists, chat transcript, AI client
and more — see `Documentation/App_Kit_Guide.md`. Scaffold with the kit:

```bash
node tools/sdk/celer.js new MyApp --appkit   # deps: celeros.app.kit
```


### Debugging on the device

Boards with the debugger (the ESP32-S3 ones by default:
`CONFIG_CELEROS_JS_DEBUGGER`) give you breakpoints, stepping and live
inspection of the running app:

```bash
python3 tools/celerctl.py debug MyApp     # opens the app paused on line 1 + REPL
```

```
dbg> b 42 if score > 100     # conditional breakpoint (line of the paused file)
dbg> w player                # watch: printed on every pause
dbg> c                       # continue until a breakpoint
dbg> v player                # objects show their content: {"x":12,"y":40}
dbg> lc                      # locals of the frame;  cs = call stack, up/down
dbg> e score * 2             # eval in the frame;  set lives 9 changes a var
dbg> n                       # step over (s = into, o = out, u 50 = run to line 50)
dbg> r                       # push your edited files + restart, keeping breakpoints
```

* An **uncaught error pauses at the throw**, with the stack and locals
  intact; `c` lets it proceed to the usual error screen.
* `debugger;` in your code pauses there while a debugger is attached (it is a
  no-op otherwise, but remove it before publishing).
* Ctrl-C pauses a running app; Ctrl-C twice (or `q`) detaches and the app
  keeps running. Device logs show up in the same terminal.
* Edit-and-retry loop: save in your editor, `r` in the REPL — the local app
  folder (found in `data/apps`/`hub_apps`, or `--src DIR`) is linted and the
  changed files are pushed before the restart; lint errors keep the old app.
  (`celerctl debug --serve` keeps only the proxy for a separate client.)

Worth knowing:

* **`celer.d.ts`** (generated by `tools/sdk/celer.js types`): API types for
  the editor — the scaffold copies it into the app folder along with a
  `jsconfig.json`. It is an artifact generated from the firmware source;
  after changing the API, regenerate and commit it (`celer.js check` flags
  drift in CI).
* **Emulator** (`emu`): runs the app in the Node harness with real drawing
  onto a 240x320 framebuffer (480x480 when the app uses the native canvas).
  `--serve` opens a **live preview** in the browser: pointer = real touch,
  arrows/WASD = swipe, space = tap, plus pause/step/speed and hot reload when
  you save a file; the game loop runs at the app's own clock. Headless modes:
  a PNG (`--out`), a PNG per milestone with a pixel diff (`--frames`), or an
  animated GIF (`--gif out.gif --ms 3000 --fps 20`). `--input FILE` scripts
  taps/swipes by time, `--seed N` makes `Math.random` reproducible,
  `--grid`/`--mark x,y` find coordinates and `--scale N` enlarges the PNG.
  The live preview's **Gravar** button records your touches and downloads a
  file you can replay with `--input`.
  It is an approximation (8x8 font; `drawPNG`/`drawBMP`/`drawIcon` render
  the real art, `drawJPG` is not rendered yet) — the final screen is always
  the device's.
* **`test`/`emu` accept an event script**: create a `test.js` in the app
  folder exporting `wire(env)` (taps via `env.__harness.tap/pushTouch`,
  network responses, CelerLink state) and the runner injects it before
  running. For reproducible input without code, use `--input FILE`:

```
# toques.txt — time in ms of app, then the gesture
0    tap 120,200
600  swipe 120,240 120,80 6
900  down 120,160
980  move 150,180
1100 up 150,180
```
* **`celerctl dev`** negotiates 921600 baud by itself and keeps a keepalive
  with the device (the channel falls back to console after 8s without host
  traffic). The device shell's `exit` command cleanly terminates the running
  app — that is what enables reloading without a reboot.
