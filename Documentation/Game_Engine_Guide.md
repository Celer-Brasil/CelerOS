# CelerGame Guide (the CelerOS game engine)

**English** | [Português (BR)](Game_Engine_Guide.pt-BR.md)

**CelerGame** is the CelerOS 2D game engine, shipped as a **family of shared hub dependencies you adopt one by one** — since API 30, `"deps"` in `app.json`: the store installs them into the public `/local/modules` cache and `require()` resolves from there, one copy per version on the device. No extra permissions; vendoring a copy into the app folder still works (and wins).

| Dep | Stripped | What it gives you |
|---|---|---|
| **`celeros.game`** (core) | ~25 KB | loop with scenes + transitions, touch gestures, camera-aware drawing, math/RNG, tweens/timers/`E.seq`, groups/pools, dirty-rect layer, chiptune audio with beat clock, NVS saves |
| **`celeros.game.fx`** | ~6 KB | particles, bursts/rings, floating text, flash, starfield, **continuous emitters, trails, parallax layers** |
| **`celeros.game.spr`** | ~2 KB | PNG sprites in native slots with painter fallback, flipbooks, **spritesheets (1 PNG, N named regions)** |
| **`celeros.game.tilemap`** | ~2 KB | grid of dirty cells for big procedural scenarios |
| **`celeros.game.ui`** | ~5 KB | menus, scrollable lists, typewriter dialogs, ready title/pause/game-over screens |
| **`celeros.engine`** | shim (0.2 KB) | the **whole family assembled** — the pre-modularity API (1.2.x) in one `require`; existing games keep working unchanged |
| **`celeros.physics`** (optional) | ~7 KB | native Verlet ropes/cloth (`P.verletFast`, API 31) and rigid bodies (`P.rigid`, API 33). **Most games need none of it** — the physics ladder in §15 |
| `celeros.grid`, `celeros.sfx`, `celeros.mesh` | — | bomberman-style arenas + BFS chase flow, sfx melody tables, CelerNet boilerplate (same family, unrelated modules) |

Each module decorates the **same `E`** object (the `require` cache makes the core a singleton): adopting is one line — `require("celeros.game.fx")` and `E.fx` exists. Deps between modules are transitive (fx → core): the store resolves the whole graph at install. You pay for what you adopt — deps count toward the app ceiling EVEN shared, because each game compiles them into its own Duktape heap: a core-only game is ~25 KB stripped (fits the 48 KB no-PSRAM budget), the full family ~35 KB.

Everything is ES5 (Duktape) and feature-detects the firmware at runtime, so the same game runs on every board — and unchanged in the Node test harness and emulator.

## 1. Requirements

| | |
|---|---|
| Firmware API | 23+ for modules; **30+** for the shared deps (newer features — smooth primitives, `playMusic`, native canvas — are auto-detected) |
| Intended boards | The ESP32-S3 boards with PSRAM: SmartDisplay, Waveshare watch, SpotPear dog |
| Size budget | Deps count toward the app ceiling EVEN shared (they compile inside each game's heap): core ~25 KB + ~23 KB for your code fits the plain 48 KB budget; bigger games declare `"requires": ["psram"]` to lift the budget to 1 MB (the store then blocks installing on non-PSRAM boards). The hub measures deps **stripped**, as the device compiles them |
| App flavor | `"topbar": false` for fullscreen games (like Supernova) is recommended; the exit button lives in your title menu (`System.exitApp()`) |
| CYD (no PSRAM) | **Core-only games now fit**: `celeros.game` (~25 KB) + ~20 KB of your code under the 48 KB ceiling, no vendoring. Adopt fx/spr/tilemap only if your budget allows; the full family + code needs `"psram"` |

## 2. Getting started

```bash
# a ready-to-run game scaffold (app.json with deps core+fx + Quica sample;
# the modules are NOT copied — they come from the hub at install time):
node tools/sdk/celer.js new MyGame --game

# app.json deps vs versions on the hub (and the local tree):
node tools/sdk/celer.js deps MyGame
node tools/sdk/celer.js deps set celeros.game.spr ^1.0.0 MyGame   # adopt a module

# publish the engine deps to the hub repository (publishes the canonical
# tools/sdk/engine/ tree; needs a token with the deps scope; --dep declares
# the family edges — mirror tools/sdk/engine/index.json):
python3 tools/celerhub.py publish-dep tools/sdk/engine/celeros.game.js --min-api 30
python3 tools/celerhub.py publish-dep tools/sdk/engine/celeros.game.fx.js --min-api 30 --dep celeros.game=^1.0.0
python3 tools/celerhub.py publish-dep tools/sdk/engine/celeros.physics.js --min-api 31

# iterate (lint runs on save; emulator renders a PNG; device does live
# reload — on the PC require resolves deps from the tools/sdk/engine tree):
node tools/sdk/celer.js lint MyGame
node tools/sdk/celer.js emu MyGame
python3 tools/celerctl.py dev MyGame
```

`new --game` scaffolds **Quica**, a complete keep-up game (title/game/over scenes, drag paddle, bouncing balls, particles, sfx, high score) — read its `main.js`; it is the canonical example. Its ball physics is hand-rolled on purpose: the physics ladder starts at zero (§15).

## 3. Quickstart: a complete game in ~30 lines

```js
// main.js
var E = require("celeros.game");       // core — adopt more with require():
require("celeros.game.fx");            // + particles (E.fx), one line each

E.init({ dir: "Bolas", fps: 30, save: "bolas." });
var W = E.W, H = E.H;

var balls = [];                    // pool: no allocation inside the frame

E.run({
  jogo: {
    update: function (dt) {
      if (E.input.tap) {
        balls.push({ x: E.input.tap.x, y: E.input.tap.y, r: 8,
                     vx: E.m.rand(-120, 120), vy: 0 });   // bounce: 0.85 below
        if (balls.length > 40) balls.shift();             // pool cap
        E.audio.sfx("ui");
      }
      for (var i = 0; i < balls.length; i++) {
        var b = balls[i];
        b.vy += 900 * dt;                                 // gravity
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx) * 0.85; }
        if (b.x + b.r > W) { b.x = W - b.r; b.vx = -Math.abs(b.vx) * 0.85; }
        if (b.y + b.r > H) { b.y = H - b.r; b.vy = -Math.abs(b.vy) * 0.85; }
      }
    },
    draw: function () {
      System.fillScreen(E.theme.bg);
      for (var i = 0; i < balls.length; i++) {
        E.gfx.circle(balls[i].x, balls[i].y, balls[i].r, E.theme.accent);
      }
      E.gfx.text(balls.length + " bolas", W / 2, 8,
                 { align: "center", color: E.theme.textDim, font: 1 });
      E.fx.draw();
    }
  }
}, "jogo");
```

That is the whole physics this game needs: integrate, move, reflect on the
walls (§15, rung 0 of the ladder — a few bodies and planes is always cheaper
by hand than any engine).

The engine **owns the loop**: you describe scenes and the engine calls `update(dt)`/`draw()` at your target fps, polling touch, ticking effects/timers/tweens/audio for you. That loop is exec-timeout safe (it yields every frame).

## 4. Scenes and the game loop

```js
E.init({ dir: "MyGame",   // app folder name → asset base (/local/apps/MyGame/assets/)
         fps: 30,          // frame target (default 30, 0 = uncapped)
         native: false,    // true = native canvas (physical pixels, API 28)
         save: "mygame.",  // NVS key prefix for E.save
         particles: 96 }); // fx pool size
E.run(scenes, "titulo");
```

A scene is `{ enter, update(dt), draw, exit }` — all optional. `E.goto("fim")` switches at the start of the next frame (running the old scene's `exit` first); `E.quit()` ends `E.run()`. Use `E.data` for state that must survive scene changes (it lives for the whole app), and `E.sceneName`/`E.dt`/`E.fps` for introspection. A scene may override the global frame target with `fps` (menus at 30, the action uncapped with `fps: 0`):

**Scene transitions (core 1.0):** `E.goto(name, {transition, ms, color, dir})` draws a cheap veil (≤ 9 fillRects/frame, no screen capture — the firmware has no screen→sprite copy) instead of a hard cut:

```js
E.goto("jogo", { transition: "fade", ms: 500 });          // veil closes on the old scene, opens on the new
E.goto("menu", { transition: "wipe", ms: 300, dir: "left" });  // left|right|up|down
E.goto("jogo", { transition: "iris", ms: 400, color: 0x0000 }); // square hole opening
E.goto("jogo", { transition: "bands", ms: 450 });          // 8 staggered columns
```

While the veil lives the dirty layer repaints the full background each frame and `static` scenes redraw every frame — transitions are short (≤ 0.5 s), keep them that way.

```js
E.run({
  menu:    { fps: 30, update, draw },
  jogando: { fps: 0,  update, draw },   // runs as fast as the board allows
}, "menu");
```

**Static scenes (menus, pause, game over):** `static: true` makes the scene draw only on entry, on `E.redraw()` and when the finger enters/leaves an `E.gfx.button` — a still menu repaints (and pushes) nothing per frame. On the SmartDisplay's RGB panel the full redraw of a menu at 30 fps was what made the glass "shake with flashes":

```js
menu: { static: true,
        update: function () { if (E.hit(this.btn)) E.goto("jogo"); },
        draw: function () { /* everything once */ this.btn = E.gfx.button("JOGAR", ...); } }
```

Per frame the engine runs, in order: pending scene switch → dt/fps → input poll → audio keep-alive → camera → fx → timers → tweens → `update(dt)` → `draw()` → frame pacing.

**Leaving scenes cleanly:** timers and tweens created in a scene outlive it. Call `E.clearTimers()`/`E.clearTweens()` in `exit()` (or cancel individual handles with `E.cancel(t)`).

## 5. Input

`E.input` is refreshed once per frame:

| Field | Meaning |
|---|---|
| `x, y, down` | current touch point/state |
| `justDown` / `justUp` | pressed / released this frame |
| `dx, dy` | movement since last frame |
| `holdDx, holdDy` | movement since press (relative drag, e.g. paddle control) |
| `moved` | drag passed the threshold (`dragThresh`, default 12 px) |
| `tap` | `{x, y}` on release, if short and (almost) still (`tapMs` 350 ms) |
| `swipe` | `{dir, dx, dy, dist}` on release, if dragged ≥ `swipeMin` (30 px) |
| `longpress` | held ≥ `longMs` (600 ms) without dragging; fires once per touch |
| `btn` | physical button (devkit): 1 short, 2 long |

Thresholds are fields on `E.input` — tune them per game. Hit-testing:

```js
if (E.input.tap) { ... }                    // raw tap anywhere
if (E.hit(rect)) { ... }                    // tap inside {x,y,w,h}
if (E.press(rect)) { ... }                  // finger currently down inside (button highlight)
```

## 6. Drawing (E.gfx)

All functions take **world coordinates** and apply the camera; pass `{screen: true}` to draw HUD on top of it. Colors are RGB565 ints — use `E.theme` (`bg, card, raised, stroke, accent, accentD, onAccent, text, textDim, ok, warn, err`) or constants (`BLACK`, `WHITE`, ...). Everything falls back to plain primitives on old firmware:

```js
E.gfx.rect(x, y, w, h, color, { fill: true, r: 8 });       // r = rounded corners (API 22)
E.gfx.circle(x, y, r, color, { smooth: true });             // anti-aliased fill (API 22)
E.gfx.line(x0, y0, x1, y1, color, { w: 3 });                // wide line (API 22)
E.gfx.tri(x0, y0, x1, y1, x2, y2, color);
E.gfx.gradient(x, y, w, h, c1, c2, { dir: "y" });
E.gfx.arc(x, y, r0, r1, a0, a1, color);                     // degrees, -90 = up
E.gfx.text("SCORE 42", x, y, { ts: "big", align: "center",       // role (scales with E.U)
                               valign: "middle", color: 0xFFFF, bg: 0x0000 });
E.gfx.text("SUPERNOVA", x, y, { px: E.u(21), fit: W - 20 });      // pixel height, shrink to fit
E.gfx.measure("SCORE 42", { ts: "big" });                         // width in pixels
E.gfx.button("JOGAR", x, y, w, h, { primary: true });        // returns the rect for E.hit()
E.gfx.bar(x, y, w, h, 0.75);                                 // meter (health/charge)
E.gfx.panel(x, y, w, h);                                     // card with border
```

`bg` omitted in `text` = transparent background (single-arg `setTextColor`). Mixing colors: `System.mixColor(c1, c2, pct)` (API 22) — `pct`% of the way from `c1` to `c2`.

**Scale and type (1.2):** lay out in project units — `E.u(v)` turns a measure of the 240-wide design into pixels of the current screen (`E.U` = min(W, H)/240: 1 on the virtual canvas, 2 on the 480 native canvas, ~1.7 on the watch). Text goes by **pixel height**: `px`, or a role in `E.ts` (`tiny 9, small 11, body 13, label 15, big 20, title 28, huge 40`, scaled by `E.U`). `E.font(px)` picks among the firmware fonts (already promoted on big screens: 13/25/42 px line on the 480) and prefers the crisp native glyph over a blocky `textSize` blow-up. Avoid raw `size`: on a big screen the firmware has already doubled the font and `size: 3` on top gives 75-120 px titles.

## 7. Camera

```js
E.cam.follow(player, 0.15);   // lerp toward a {x, y} target (screen-centered)
E.cam.bounds = { x: 0, y: 0, w: 960, h: 320 };   // clamp within the world
E.cam.shake(5, 0.3);          // power (px), duration (s) — decays automatically
E.cam.center(x, y);           // snap
E.cam.reset();                // identity (call on scene enter)
```

`wx()/wy()` convert world→screen if you draw with raw `System.*` calls.

## 8. Entities: groups and pools

```js
var enemies = E.group();
enemies.add({ x: 10, y: 10, update: function (dt) { this.x += 20 * dt; },
              draw: function () { E.gfx.circle(this.x, this.y, 6, 0xF800); } });
enemies.update(E.dt);   // sets o.dead = true → auto-removed (swap-pop)
enemies.draw();

var bullets = E.pool(32, function () { return { x: 0, y: 0, vx: 0, vy: 0 }; });
var b = bullets.spawn();        // recycled object, or null when full
b.x = 100; b.y = 200; b.dead = false;
bullets.update(E.dt); bullets.draw();
```

Pools pre-allocate everything: no per-frame allocation means no GC hiccups. Both containers have `each(fn)` for bulk iteration (the pool's skips the dead — no scavenging loop in your frame).

## 9. Sprites and animation

The firmware sprite pool has **16 slots** on PSRAM boards since API 33 (8 before that, since API 29; 1 without PSRAM — sprites eat internal RAM there) (`System.spriteSlots()` reports the board's limit; the engine queries it automatically). `E.spr.load` decodes each PNG **once** into a slot and keeps a procedural `paint` fallback, so the game runs even with missing assets or on boards without sprites:

```js
E.spr.load([
  { name: "nave", file: "nave", w: 72, h: 72,
    paint: function (w, h, x, y) {           // fallback: draw with primitives
      E.gfx.tri(x + w / 2, y, x, y + h, x + w, y + h, E.theme.accent);
    } },
  { name: "inimigo", file: "inimigo", w: 56, h: 56, paint: ... },
]);
E.spr.blit("nave", x, y, { cx: true, cy: true, key: 0x0000 });  // key = chroma color
```

- Assets are probed in `E.spr.bases` (set by `init({dir})` to `/local/apps/<dir>/assets/` and `/sd/apps/<dir>/assets/`).
- **Transparency convention:** masterize PNGs with a *pure black* background (the chroma key) and turn interior blacks into near-black `(0,0,8)` — same trick as Supernova. Only slot-backed sprites support the key; painter fallbacks draw whatever you draw.
- More defs than slots → extras become painter-only automatically. `E.spr.backed(name)` tells you whether a sprite got a real slot (fast chroma-key blit) or will draw through its painter. `E.caps.slots` holds the probed limit (16 on PSRAM boards with API 33+, 8 on API 29–32, 1 without PSRAM; 4 is the engine's fallback when `spriteSlots` doesn't exist) — budget your defs against it.

**Spritesheets (spr 1.0):** one whole-image PNG decodes into a **single slot** and each named region becomes a first-class sprite name — `blit`, `anim` and `backed` work with regions, no new code in the game. Regions are `[cx, cy]` cells of `tw x th`, or a free `[x, y, w, h]` rect in pixels. Saves slots (16 max) and decode passes (`drawPNG` costs ~9 ms per call on the SmartDisplay — a 16-tile sheet pays it once):

```js
E.spr.sheet("tiles", { file: "tiles", w: 128, h: 64, tw: 16, th: 16,
                       regions: { chao: [0, 0], parede: [1, 0], bau: [2, 0],
                                  logo: [64, 0, 24, 12] } });  // free rect
E.spr.blit("chao", x, y);
var brilho = E.anim(["bau", "chao"], 4);   // flipbook over regions
// region blit = setClip on the destination + sheet pushed shifted; without
// setClip (old firmware) it falls to paint(nome, x, y)
E.spr.free("chao");       // removes the name only (the slot is the sheet's)
E.spr.freeSheet("tiles"); // gives the slot back and drops every region
```

Flipbook animation without extra slots: frames are painter functions (or loaded sprite names):

```js
var boom = E.anim([function (x, y) { ... }, function (x, y) { ... }], 12, false);
// per frame: boom.tick(E.dt); if (!boom.done) boom.draw(x, y);
```

## 10. FX

```js
E.fx.burst(x, y, { n: 14, colors: [0xFFE0, 0xFD20], speed: 120, life: 0.6,
                   grav: 200, shape: "dot" });   // dot | spark | ring
E.fx.ring(x, y, { speed: 700, color: 0xFFE0 });  // shockwave (expanding circle)
E.fx.popText(x, y, "+10", { color: 0xFFE0 });    // floating score
E.fx.flash(0xF800, 150);                         // edge glow (frame that fades)
E.fx.flash(0xFFFF, 400, { full: true });         // fullscreen flash (save it for the big moment)
// stride: N > 1 moves each star once every N frames (spread by index), so only
// n/N stars dirty a box per frame - a full-sky field otherwise makes the dirty
// union cover the whole screen again. Average speed is preserved.
var stars = E.fx.stars(60, { colors: [0x39E7, 0xC5F9], stride: 4 });  // parallax
stars.update(E.dt); stars.draw();
E.fx.draw();                                     // call at the END of your scene draw
```

Particles/floaters/flash are ticked by the loop; only `draw()` is yours. On top of bursts, fx 1.0 has **continuous sources** (zero allocation per frame — the emitter path seeds the pool directly):

```js
// continuous emitter: rate/s, optional duration (ms) and follow () => {x, y}
// for a moving source (return null to skip the frame); particle opts like burst
var fogo = E.fx.emitter({ x: 120, y: 200, rate: 40, life: 0.5, size: 3,
                          grav: -60, colors: [0xFD20, 0xF800] });
fogo.stop(); fogo.start(); fogo.set(140, 200);   // handle

// trail that follows an entity — stationary sources leave nothing
var rastro = E.fx.trail(function () { return nave; }, { rate: 24, life: 0.4 });

// procedural parallax layers scrolling with the camera (speed = fraction)
var fundo = E.fx.parallax([
  { speed: 0.2, gap: 44, paint: function (x, y) { E.gfx.circle(x, y, 1, 0x39E7); } },
  { speed: 0.5, gap: 30, paint: function (x, y) { E.gfx.circle(x, y, 1, 0xC5F9); } },
]);
fundo.draw();                                  // first line of your scene draw
E.dirty.enable(function (x, y, w, h) { fundo.draw(x, y, w, h); });  // or as the dirty painter
```

## 11. Tweens and timers

Engine-ticked (not `setTimeout` — no 8-timer limit, deterministic under the harness):

```js
E.tween(btn, { y: 160 }, 500, { ease: E.m.outBack, onDone: function () {} });
E.after(1200, function () { E.goto("fim"); });
var id = E.every(2.5 * 1000, spawnWave);
E.cancel(id); E.clearTimers(); E.clearTweens();

// timeline (core 1.0): steps in order on the SAME object; {par: [...]} runs
// its children together and waits for the longest; cancel() kills the chain
var tl = E.seq(nave, [
  { to: { x: 200 }, ms: 400, ease: E.m.outQuad },
  { to: { y: 100 }, ms: 300 },
  { par: [{ to: { x: 0 }, ms: 300 }, { to: { alpha: 1 }, ms: 500 }] },
], { onDone: function () { E.goto("fim"); } });
tl.cancel();
```

Easings: `E.m.linear/inQuad/outQuad/inOutQuad/outBack`.

## 12. Audio

Since API 32 sound effects are **mixed on top of the track** by the synth (`System.sfx`): `E.audio.sfx` does not block the loop and plays with music on (`E.caps.mix`). On older firmware there is one speaker slot — `playMusic` OR `playWav`/`playTone` — and `E.audio` falls back to the blocking `playTone`, polite with the music:

```js
E.audio.music({ bpm: 132, loops: 0, tracks: [
  { wave: "sq",  vol: 70, notes: [[69,4],[71,4],[72,4],[69,4]] },   // [midi, 16ths]
  { wave: "tri", vol: 60, drum: true, notes: [[36,2],[0,2],[38,2],[0,2]] },
]});
E.audio.beat();        // beat position (1.0 = downbeat); -1 when not playing
E.audio.sfx("coin");   // named sfx (API 32: mixed over the track; older: skipped while music plays)
E.audio.sfx([880, 60]);        // or a raw [freq, ms]
E.audio.sfx([[660,60],[0,20],[880,80]]); // or a short melody (freq 0 = rest; one effect at a time: the newest wins)
E.audio.stop(); E.audio.mute(true); E.audio.volume(80);
E.audio.duck(600);  // older firmware: mutes the track for ms (a loud sfx takes
                    // the channel) and resumes from where it stopped; no-op
                    // with E.caps.mix (the effect already sounds on top)
```

Music auto-restarts when its loops end (keep-alive). Spawn-on-the-beat: `if (Math.floor(E.audio.beat()) !== lastBeat) spawn()`. Resume after a pause: save `System.musicPos()` and call `E.audio.music(song, { startMs: pos })`. Default sfx table: `ui, ok, back, bad, hit, coin, boom, shot, power, over, record, win` — replace entries in `E.audio.sfxTable`. Boards without a speaker (CYD) no-op everything.

## 13. Save (high scores, settings)

NVS-backed (no permission needed), namespaced by the `save` prefix from `init`:

```js
E.save.set("skin", "azul");
var skin = E.save.get("skin", "verde");
var best = E.save.num("recorde", 0);
if (E.save.best("recorde", score)) { /* new record! */ }
```

## 14. Math and RNG

`E.m`: `clamp, lerp, map, rand(a,b), randInt, pick, dist, dist2, ang, approach, wrap, sign` + easings. `E.rng(seed)` returns a deterministic PRNG function — seed your level generation and your tests become reproducible.

## 14b. Game UI (`celeros.game.ui`, optional)

What every game used to rewrite: menus, scrollable lists, typewriter dialogs and the ready-made title/pause/game-over screens. Immediate-mode like `E.gfx.button` (draw and return the tap **in the same frame**), everything with `screen: true` (outside the camera) and in the firmware theme:

```js
require("celeros.game.ui");

// in draw(): vertical menu — returns the tapped value (or label), or null
var pick = E.ui.menu([{ label: "Jogar", value: "j" },
                      { label: "Opcoes", value: "o" },
                      { label: "Apagar", value: "z", danger: true }]);

// scrollable list (retained): drag scrolls, a still tap picks the row under
// the scroll; draw returns the pick only on the tap frame (st.picked keeps
// the last one for polling)
var lst = E.ui.list({ items: fases, row: 28, onPick: function (v, i) { ... } });
var pegou = lst.draw(20, 80, 200, 140);   // screen coords

// typewriter dialog: reveal advances in draw (regular scene, not static);
// tap completes the text, tap again closes (draw returns false)
var dlg = E.ui.dialog("A princesa esta em outro castelo...", { name: "NPC" });
if (!dlg.draw(20, 230, 200)) dlg = null;  // false = closed

// ready screens, drawn over your scene:
if (E.ui.title({ game: "MEU JOGO", best: E.save.num("hi") }) === "start")
  E.goto("jogo", { transition: "fade" });
var a = E.ui.pause({});            // 'resume' | 'restart' | 'quit'
var b = E.ui.gameOver({ score: s, best: hi, isNew: novo });  // 'again' | 'quit'
```

## 14c. Modules for complex games (optional)

Six small modules, each its own dep (`app.json` "deps") decorating the same
`E`: adopt only what the game needs. All are ES5, allocation-free in the hot
path, and tested in `test/sdk/celergame_mods.js`.

| Dep | Gives | Typical use |
|---|---|---|
| `celeros.game.fsm` | `E.fsm(owner, states, first)` | enemy AI, hero states, boss phases |
| `celeros.game.events` | `E.on/once/off/emit/emitLater`, `E.bus()` | decoupled systems (score, sound, achievements) |
| `celeros.game.path` | `E.path.find/los/smooth/grid/follower` | A* chasers, line of sight, patrol routes |
| `celeros.game.collide` | `E.collide.rect/circle/test/push/segRect/hash/move` | many bodies (spatial hash), platformer move-and-slide |
| `celeros.game.pad` | `E.pad.stick/button/draw` | on-screen controls for action games |
| `celeros.game.level` | `E.level.parse/progress` | ASCII levels with spawns, unlock progression |

**FSM.** States are `{enter(m, arg), update(m, dt), exit(m, next), draw(m),
after: [seconds, next], on: {event: fn}}`. A `m.go()` requested *inside* a
callback applies when the callback returns (no state entering mid-update of
another). `m.time` is seconds in the state, `m.data` a bag reset on every
entry, `m.push/pop` stack a state (stunned over anything), `m.send(ev)` routes
an event to the current state (a returned string is a transition).

```js
var ia = E.fsm(inimigo, {
  patrulha: { update: function (m, dt) { if (vê(m.owner)) m.go("caca"); } },
  caca:     { update: function (m, dt) { perseguir(m.owner, dt); if (m.time > 4) m.go("patrulha"); },
              on: { dano: function (m) { return "atordoado"; } } },
  atordoado:{ after: [0.8, "caca"] }
}, "patrulha");
```

**Events.** Synchronous; a listener returning `false` stops propagation;
`{prio}` orders; `{scene: true}` sleeps under an `E.push` and dies when its
scene leaves. `E.emitLater` delivers next frame (safe from inside a collision
loop).

**Path.** `E.path.find(cols, rows, c0, r0, c1, r1, cost, {diag, max, near})`
— `cost(c, r)` < 0 is a wall; diagonals never cut wall corners; `max` is a
node budget (default 2000) so a big search returns `null` instead of eating
the frame (`near: true` returns the path to the closest reachable cell).
`E.path.grid(tilemap)` adapts the tilemap module; `smooth` removes grid
zig-zags by line of sight; `follower(obj, path, speed, {cell})` walks an
entity along it.

**Collide.** Shapes are the engine's: rect `{x, y, w, h}` (corner) and circle
`{x, y, r}` (center). `hash(cell)` is rebuilt per frame (`clear` + `add`) and
`query(shape, fn)` calls `fn` once per real hit — bullets x enemies without
O(n²). `move(body, dx, dy, tilemap)` moves X then Y in half-cell steps (a
400 px fall does not tunnel through a 16 px floor), stops at walls, zeroes
`vx/vy` on the axis that hit and returns `{hitX, hitY, ground, ceil}`.

```js
var r = E.collide.move(heroi, heroi.vx * dt, heroi.vy * dt, mapa);
if (r.ground && pulo.pressed) heroi.vy = -260;
```

**Pad.** `stick({zone, r, float, dead, dirs})` gives `x/y` in -1..1, `mag`,
`angle`, `dir`; `button({x, y, r, label})` gives `down/pressed/released`.
**The touch panels are single-touch**: holding the stick and a button at
the same time does not exist — `stick.tap` (a dry tap inside the stick zone)
is the "A" action, and the physical button (`E.input.btn`) can be a second.

**Level.** `E.level.parse(lines, {legend, cell})`: a plain legend value is a
tile, `{spawn: type, tile}` is an entity (with what stays on the floor). A
character missing from the legend throws with line and column. `lv.data`
goes straight into `E.tilemap({data})`; `lv.spawn({type: factory})` builds
entities. `E.level.progress(list, {save})` tracks the current level, saved
unlocks (`next()`), and best-only stars per level.

## 14d. More modules: scripts, inventory, steering, generation, stats, waves

Six more deps on the same `E` (tested in `test/sdk/celergame_r3.js`):

| Dep | Gives | Typical use |
|---|---|---|
| `celeros.game.script` | `E.script(steps, {onDone})` | cutscenes, tutorials, boss choreography |
| `celeros.game.inv` | `E.inv.items(defs)`, `E.inv.bag({slots})` | RPG backpack, potion belt, chest, shop |
| `celeros.game.steer` | `E.steer.agent(obj, {speed, force})` | bats, fish, ships, flocks in open space |
| `celeros.game.gen` | `E.gen.rooms/cave/maze/scatter/lines` | roguelike dungeons, caves, mazes from a seed |
| `celeros.game.stats` | `E.stats(base, {iframes, xp})` | hp with invulnerability, buffs, cooldowns, XP/levels |
| `celeros.game.waves` | `E.waves(list, {spawn, alive})` | shooter / tower-defense / arena wave director |

**Script.** A list of steps run in order on the engine tick (game time:
freezes on `E.pause`, follows `E.timeScale`): `{call: fn}` (instant),
`{wait: ms}`, `{tween: obj, to, ms}` (waits for it), `{until: fn}`, `{tap: true}`,
`{par: [...]}` (children together, waits for all), `{label}` + `{loop: label,
times}`, `{emit: name, arg}`, `{scene: name}`, or a function called every frame
until it returns something other than `false`. A script belongs to the scene
where it was created (sleeps under `E.push`, dies when the scene leaves;
`{global: true}` survives). `s.skip()` ends it now: tweens jump to their final
value, waits end and the remaining `{call}`s run.

```js
E.script([
  { call: function () { heroi.trava = true; } },
  { tween: E.cam, to: { y: 200 }, ms: 800 },   // show the door
  { wait: 500 },
  { call: function () { porta.abre(); } },
  { until: function () { return porta.aberta; } },
  { tween: E.cam, to: { y: 0 }, ms: 600 },
  { call: function () { heroi.trava = false; } }
]);
```

**Inv.** `E.inv.items({pocao: {max: 9, use: fn}})` registers definitions
(`use(item, bag)` returning `true` consumes one). `bag.add(id, n)` fills
existing stacks first and returns what did not fit; `remove`, `count`, `has`,
`fits`, `move(i, j)` (same item merges, else swaps), `split`, `use(i)`, `sort()`
(merges and orders by registry), `save(key)` / `restore(key)` through `E.save`.

**Steer.** Reynolds steering: each call adds a weighted force for this frame —
`seek`, `flee(x, y, w, radius)`, `arrive(x, y, slow)`, `pursue/evade(target)`,
`wander`, `separate/align/cohere(list, radius)` (boids), `within(rect, margin)`
— and `update(dt)` limits force and speed, moves `obj` and clears. For mazes
use `celeros.game.path` and feed the next waypoint to `arrive`.

**Gen.** Character grids (`grid[r][c]`) that go straight into
`E.level.parse(E.gen.lines(grid), ...)`: `rooms(cols, rows, {rnd, rooms})`
(non-overlapping rooms chained by L corridors — every room reachable),
`cave(cols, rows, {fill, steps})` (cellular automaton; keeps only the largest
open region), `maze(cols, rows, {loops})` (perfect maze, iterative backtracker),
`scatter(grid, ch, n, {minDist})`. Pass `rnd: E.rng(seed)`: same seed, same
level. Generate on level entry, never per frame.

**Stats.** `E.stats({hp: 10, atk: 3, def: 1}, {iframes: 600, onDeath, xp})`:
`get(name)` = (base + adds) x muls; `mod(name, {add, mul, ms, id})` (same `id`
replaces — a potion drunk twice renews instead of stacking); `damage(n,
{pierce, force})` subtracts `def` with a minimum of 1 and returns 0 during the
invulnerability window; `heal`, `revive`, `frac()`; `cool(name, ms)` returns
`true` and starts the cooldown when ready (`coolFrac` for the ability icon);
`addXp(n)` levels up along `base * grow^(level-1)`. Everything runs on the game
clock (`E.stats.now()`), frozen by `E.pause`.

**Waves.** `E.waves([{type, n, every}, {groups: [...], rest}], {spawn(type, w, i),
alive(), onWave, onClear, onDone, endless: {grow}})`: spawns on schedule, waits
for `alive()` to reach 0, rests, starts the next; `endless` repeats the last
wave growing by `grow`. States: `wait`, `spawn`, `clear`, `done`.

## 15. Physics (`celeros.physics`, optional)

**Most games need no physics module at all.** On a Duktape device an
object-per-body world pays GC pressure that grows with body count — the
store's own games learned it in production (Supernova dropped the module
when ~85 sensor bodies per frame brought GC stalls) and converged on the
same ladder. Climb it only as far as the game demands:

| Rung | Game style | Tool | Reference |
|---|---|---|---|
| **0 — none** | Arcade with a few dozen bodies or fewer: pong, breakout, runners, shooters | Pre-allocated pools + distance/AABB tests + reflection, by hand | Quica template, Supernova |
| **1 — Verlet** | Ropes, cloth, soft bodies, point sandboxes | `P.verletFast` → native `System.verlet*` (API 31, **every board**; falls back to the JS verlet on old firmware by itself) | Physics Drop |
| **2 — Rigid** | Stacks that topple, destruction, slingshots | `P.rigid` → native `System.rigid*` (API 33, S3 boards with PSRAM) | Arrasa! |

Pursuit/chase fields are **not** physics: `celeros.grid` (BFS) is the module
for that (Detona's chasers use it).

Coordinates everywhere: y grows **down** (screen); body `x, y` is the
**center**; circle bodies have `r`, boxes `w/h`. No `System` calls in the
math, so everything unit-tests anywhere.

### Rung 0: pools + reflection (the default)

Keep bodies in a pre-allocated array (`{x, y, vx, vy, r}` — plain fields,
nothing created per frame), integrate by hand, reflect on walls, and test
paddle/platform hits by **crossing**: the body crossed the surface when
`prevY + r <= top && newY + r > top` and it is horizontally within reach —
that is bulletproof against tunneling and needs no sub-steps. The Quica
template is the complete worked example; Supernova runs bullets/enemies in
pools with distance checks the same way. This rung is also the GC-friendliest:
zero allocations inside the frame.

### Rung 1: ropes / cloth / soft bodies (`P.verletFast`)

```js
var P = require("celeros.physics");
var w = P.verletFast({ iterations: 4, radius: 2.5 });   // radius > 0 = point bodies collide
var a = w.add(120, 30), b = w.add(120, 60);
w.stick(a, b);                    // len defaults to the current distance
w.pin(a);                         // nail a point in the air
w.step(dt, { gravity: { x: 0, y: 900 }, damp: 0.999,
             bounds: { x: 0, y: 0, w: 240, h: 320 }, bounce: 0.8 });
var xy = w.xy();                  // flat [x0, y0, x1, y1, ...]
```

On API 31+ the world lives in C++ floats outside the Duktape heap
(`w.native === true`); old firmware transparently runs the JS verlet with
the same interface (without point-point collision). Index-based access,
`delPoint`/`delStick` for surgery, `pins()` to read the nails. Full example:
Physics Drop (paint, grab-and-throw, pin, scissors, eraser).

### Rung 2: rigid bodies (`P.rigid`, API 33)

For castles of planks that tip over, wheels and "throw a rock at the tower"
games, `P.rigid()` drives the firmware's native rigid-body solver (API 33,
S3 boards; `System.rigid*`): rotating boxes and circles, friction,
restitution, sleeping stacks and anti-tunnel sub-steps. Index-based like
`verletFast`; `state()` returns 6 numbers per body (`x, y, angle, hit, speed,
flags`) and `hit` (the impact impulse of the last step) is what you turn into
damage. **No JS fallback**: it returns `null` on firmware without the
binding — tell the player to update.

```js
var w = P.rigid({ iterations: 10 });
w.box(160, 300, 400, 20, { static: true });                  // ground
var plank = w.box(200, 260, 48, 6, { density: 0.6, friction: 0.7 });
var rock = w.circle(40, 200, 6, { density: 3, bounce: 0.3 });
w.set(rock, 40, 200, 0, 420, -40, 0);                        // launch
w.step(dt, { gravity: { x: 0, y: 400 } });
var s = w.state();
if (w.hit(plank, s) / plankMass > 55) w.remove(plank);       // it broke
System.drawSprite(sprPlank, w.x(plank, s), w.y(plank, s), w.angle(plank, s) * 57.2958, 1, 1, 0);
```

`state()` returns the **same array** every call, refilled in place (physics
2.1: no 6 x n new numbers per frame for the GC); `slice()` it if you need
last frame's snapshot. In per-body loops read it by index —
`s[i * w.N + 5] & 1` (alive), `& 2` (awake), `s[i * w.N]` (x) — because
`w.x(i, s)` and friends are function calls, and in Duktape a call costs
more than the rest of the loop body.

`System.drawSprite` (also API 33) draws a sprite rotated and scaled around
its centre — the natural pair for rotating bodies; with `smooth` it also
resizes art once at load time to the board's screen. Full example:
`hub_apps/Arrasa` (slingshot vs. goblin fortresses).

### Static overlap: `P.hit`

`P.hit(a, b)` answers "do these two circles/boxes overlap right now" (all
combinations) — handy for pickups and UI-ish tests, no world involved.

### Legacy: `P.world`, `P.tiles`, `P.flow` (removed in 2.0)

The 1.x module shipped an interpreted arcade world (`P.world` + `P.tiles`
tilemaps) and a BFS flow field (`P.flow`). They left in **2.0.0**: zero
consumers in the store, and the interpreted world was exactly the GC trap
rung 0 avoids (its users had already migrated — Supernova to pools, Detona
to `celeros.grid`; pursuit fields live in `celeros.grid`). Apps still on
`^1.x` keep resolving 1.5.0 from the hub unchanged.

### Recipes

- **Platformer:** rung 0 — hero AABB vs. the tilemap, move X then Y, land
  and jump when the Y pass finds floor; `grounded` is "the Y pass collided
  this frame". Camera `follow`s the hero.
- **Breakout:** rung 0 — the Quica pattern with bricks as a grid of alive
  flags; the ball's crossing test per brick edge is the same as the paddle.
- **Top-down shooter:** rung 0 — `vx/vy` from input with a drag factor;
  bullets/enemies in pools, distance checks for hits.
- **Bomberman:** grid state, not bodies — `celeros.grid` for solid/oneway
  queries and chaser paths; explosions walk the grid outward from the blast
  center, one soft block deep (this is Detona today).

## 16. Native canvas (fullscreen, API 28)

`E.init({ native: true })` switches drawing/touch to **physical glass pixels** (e.g. 480×480 on the SmartDisplay instead of the scaled 240×320) — crisper and faster for fullscreen games, but shapes are not uniform-scaled anymore. Requires `"topbar": false` in `app.json` (the request fails gracefully otherwise and `E.caps.native` stays false — always branch on it). `E.W/E.H` reflect the active mode.

## 16b. Rendering without flicker (engine 1.2)

The frame is **persistent** and the firmware pushes to the glass only the boxes you drew (up to 8 dirty boxes per frame since API 32 — before, the union of everything). So the cheapest frame is the one that touches the fewest pixels:

- **Menus:** `static: true` scenes (§4).
- **Action on a plain background:** `E.dirty.enable(bgColor)` in `enter`. Every engine draw (`E.gfx.*`, `E.spr.blit`, `E.fx`, text) records its screen box; next frame the engine repaints just those boxes with the background before calling your `draw`. No `fillScreen`. Direct `System.*` draws register with `E.dirty.add(x, y, w, h)`. `E.fx.stars` erases its own old pixels and only touches stars that moved (a star covered by something drawn over it heals on its next stride tick).
- **HUD:** `E.dirty.clip(x, y, w, h)` keeps erase and world drawing inside the arena; call `E.dirty.unclip()` and redraw the HUD only when its values change (keep a key string).
- **Tile worlds:** `E.tilemap({ cols, rows, cell, ox, oy, paint(c, r, x, y, w, h) })` keeps the scenery in the frame; `E.dirty.enable(function (x, y, w, h) { map.markRect(x, y, w, h); })` marks the cells under whatever moved, `map.mark(c, r)` the ones that changed (block broken), and `map.flush()` at the top of `draw` repaints only those. What `paint` draws is background — it never enters the dirty layer.
- **Still things stay out of the layer:** a body that did not move (asleep in the physics, same pose as last frame) is drawn only when `E.dirty.touches(box)` says the eraser hit it, and records nothing — a sleeping castle costs no erase, no redraw and no push. When it starts moving again its old picture has no box to be erased by, so call `E.dirty.erase(x, y, w, h)` (1.2.4) on its last box at the **top** of `draw`: it repaints the background now and records the box, so whatever is drawn after sees the touch and redraws itself. `hub_apps/Arrasa` does this for the castle, the slingshot and the level banner.
- **Sprite background:** with a full-screen background sprite, the painter is `System.blitSprite(bg, x, y, w, h)` (API 34, S3 boards: one call instead of `setClip` + `useSprite` + `pushSprite` + `useSprite(0)` + `clearClip` per box); feature-detect and keep the 5-call path for older firmware.
- `E.dirty.full()` repaints the whole background next frame (scene change, fullscreen flash do it for you); the layer turns itself off on every scene switch.

```js
jogo: {
  enter: function () { E.dirty.enable(0x0000); E.dirty.clip(0, HUD_H, W, H - HUD_H); },
  draw: function () {
    drawWorld();                 // E.gfx / E.spr — boxes recorded automatically
    E.fx.draw();
    E.dirty.unclip();
    if (hudKey() !== lastKey) drawHud();
  }
}
```

## 17. Testing your game

The harness runs your game headless with a virtual clock — physics, engine and all:

```js
// MyApp/test.js (dev-only, never published)
module.exports.wire = function (env) {
  env.__harness.tap(120, 178);                       // press JOGAR
  env.setTimeout(function () {
    if (typeof __harness !== "undefined") { /* app exposed hooks on __harness */ }
  }, 2000);
};
```

```bash
node tools/sdk/celer.js test MyGame       # headless run
node tools/sdk/celer.js emu MyGame --serve --open        # live preview: play the game
node tools/sdk/celer.js emu MyGame --ms 2000 --out tela.png
node tools/sdk/celer.js emu MyGame --frames 0,600,1500   # PNG per milestone + pixel diff
node tools/sdk/celer.js emu MyGame --gif run.gif --ms 4000 --fps 20 --seed 7
node tools/sdk/celer.js emu MyGame --input toques.txt --frames 0,600,1500
```

In the live preview the pointer/drag on the screen is a real touch, arrow
keys/WASD synthesize a swipe from the center (Snake/2048/menus), space taps
at the pointer, `P` pauses and `R` restarts the app (hot reload on save is
automatic). The **Gravar** button records your session and downloads a
`toques.txt` in exactly the `--input` format: play once by hand, then replay
it headless. A scripted input file skips writing a `test.js`:

```
# toques.txt — time in ms of app, then the gesture
0    tap 120,200          # JOGAR
600  swipe 120,240 120,80 6
900  down 120,160
980  move 150,180
1100 up 150,180
```

`--seed` pins `Math.random` (same seed = same run), `--grid` draws a
coordinate grid on the PNG and `--mark 120,200` marks a point — the quickest
way to find the touch coordinates of a button.

In-app, expose an introspection hook like `if (typeof __harness !== "undefined") __harness.myGame = { state: ... };` and drive everything deterministically (see Quica's `test.js` pattern in Supernova).

## 18. Size and performance

- Deps count toward the app ceiling (each game compiles them in its own heap) — **adopt only what you use**: core ~25 KB stripped, fx ~6, ui ~5, spr ~2, tilemap ~2 (full family ~35 KB ≈ the old monolith). Over 48 KB total → `"requires": ["psram"]` lifts the budget to 1 MB. The hub measures deps **as published**: `celerhub publish-dep` uploads them through `tools/sdk/lib/jsstrip.js` (1:1 port of the firmware's JsStripper — comments/indentation out, line breaks kept, so error lines still match the source), which is exactly what the device compiles.
- **No allocations per frame**: use `E.pool`, `swap-pop` removal, and reuse objects. A `new`/`[...]` per frame per entity is what triggers GC pauses. Since engine 1.2.3 the wrappers themselves don't allocate: opts-less `E.gfx.*` calls share one read-only object, `E.font` lookups are memoized and each string's `textWidth` is measured once per style — repeated HUD/score/button text costs no extra firmware calls.
- If you call `System.setTextDatum` directly, restore `0` when done: engine 1.2.3 only touches the datum when a text asks for a non-default origin, so `E.gfx.text` relies on apps leaving it at `0` (every app in this repo already does).
- Avoid full-screen `fillScreen` + redraw everything per frame: on the SmartDisplay's RGB panel (framebuffer scanned from PSRAM) it starves the LCD DMA and the image jitters. Use `static` scenes, `E.dirty` and `E.tilemap` (§16b).
- `world.step` is O(n²) on body count in the worst case, but a **sweep-and-prune** (bodies sorted by x each substep, early break on x distance) keeps it near-linear for spread-out scenes — shooters with ~40 bodies run comfortably.
- `E.audio.sfx` is non-blocking on API 32 (`System.sfx`); on older firmware it is **blocking** (`playTone`): keep melodies under ~300 ms.
- Pure-JS bursts longer than ~1 s trip the firmware exec-timeout — the `E.run` loop yields every frame, so stay inside it.

## 18b. CelerGame 1.1 (core 1.1.0, fx/spr/tilemap/ui/sfx 1.1.0)

Additive release: every 1.0 call keeps working. Declare `^1.1.0` in `app.json`
to use what is below (the scaffold already does — it reads the module versions).

**Pause and slow motion.** `E.pause(true|false)` (no arg toggles; `E.paused`
reads it): the scene `update` keeps running with `dt = 0` so it can drive a
pause menu, while fx, camera, timers and tweens freeze — on resume every
deadline is pushed by the paused time. `E.timeScale = 0.3` scales the `dt` of
update/fx/camera (timers and tweens stay on the wall clock).

```js
update: function (dt) {
    if (E.input.doubleTap) E.pause();
    if (E.paused) { var a = E.ui.pause(); if (a === "resume") E.pause(false); return; }
    // ... game ...
}
```

**Input.** `E.input.doubleTap` (second dry tap near the first within
`E.input.dblMs`, default 300). `E.hit(rect, pad)` / `E.press(rect, pad)` take a
touch slop in px — a 12 px coin stays tappable without growing on screen.

**Time.** `E.every(ms, fn, times)` stops after `times` shots (`t.left`).
`E.tween(obj, to, ms, {yoyo, repeat, onUpdate})`: `repeat` = extra laps
(`-1` forever), `yoyo` flips each lap. Fixes: the tween reads its *from* value
when it starts (after `delay`), and a prop missing on `obj` starts at 0 (it
was `NaN`).

**Math.** `E.m.angDiff(a, b)` (shortest turn), `smoothstep`, `chance(p, rnd)`,
`shuffle(arr, rnd)`; easings `inCubic/outCubic/inOutCubic/outElastic/outBounce`.
`E.rng(seed)` now carries `.int(a, b)`, `.range(a, b)` and `.pick(arr)`.
Fixes: `E.m.wrap(-10, 0, 10)` is `0` (was `10`), `E.m.randInt(n)` is `0..n`
(was `NaN`).

**Camera.** `E.cam.follow(target, lerp, {deadzone: {w, h}})` — the target
walks inside the central box without moving the camera.
`E.cam.worldX(sx)` / `worldY(sy)` turn a touch into map coordinates.

**Entities and save.** `pool.spawn()` resumes from the last slot (no rescan of
the live prefix); `group.sort("y")` (stable draw order) and `group.remove(o)`.
`E.save.obj(key, def)` / `setObj(key, val)` (JSON; corrupt JSON returns `def`)
and `E.save.del(key)`.

**Scenes and diagnostics.** `E.goto("typo")` throws right away, listing the
scenes that exist. `E.debug = true` (or `E.init({debug: true})`) draws fps,
frame ms (`E.frameMs`), dirty boxes and live particles in the corner.

**Modules.**
- fx: `E.fx.clear()` (call it in the scene `exit` — particles no longer leak
  into the menu); `popText(..., {vy, grow})`; fix: `burst({n: 0})` spawned 12.
- spr: `blit(name, x, y, {ax, ay})` anchor (`ax: 0.5, ay: 1` = feet on the
  ground); `E.spr.size(name)`; `E.anim` gains `reset()`, `play(frames, fps)`
  (same clip does not restart — safe to call per frame), `onEnd`, loop mode
  `'pingpong'`, and no `NaN` with an empty frame list.
- tilemap: optional data layer — `E.tilemap({..., data: ['#..#', ...],
  solid: function (v) { return v === '#'; }})`; `get/set` (`set` marks the cell
  for the next `flush`), `each`, `cellRect`, and collision queries
  `solidAt(x, y)` / `rectSolid(x, y, w, h)` (outside the grid is solid unless
  `outside: false`).
- ui: `E.ui.confirm(msg, {title})` -> `'yes'|'no'|null`; `E.ui.toast(msg, {ms})`
  is drawn by the engine on top of the scene (no draw call, works on static
  scenes); `list` scrolls with inertia and has `scrollTo(i)`; the ready-made
  screens no longer allocate option objects per frame. Needs core `^1.1.0`.
- sfx: `SFX.varia(mel, semi, rnd)` (random pitch per play) and
  `SFX.junta(a, b, {pausa})`; `SFX.via(..., {varia: 2})`.

**Core 1.2 / fx, spr, tilemap, sfx 1.2.** Scene stack: `E.push(name)` opens a
scene over the current one (which gets `pause()` and freezes — no update, no
draw), `E.pop()` returns to it (`resume()`, its dirty layer restored);
`E.goto` with a full stack leaves them all; `E.depth()`. A scene with
`cleanup: true` kills the timers and tweens it created when it leaves;
`E.killTweensOf(obj)`. Math: `E.m.noise(x, y, seed)` (smooth 0..1 value
noise), `lerpAngle`, `snap`. `E.input.heldMs` (charge shots). `group.find/
countIf`, `pool.spawn(init)`. `E.cam.inView(x, y, w, h, pad)` (cull what is
off screen) and `follow(t, lerp, {offset})` (look ahead). `E.gfx.wrap`,
`E.gfx.textBox(str, x, y, w, {max})`, `E.gfx.poly(pts, color)` and text
`{shadow: color}`. `E.audio.gap` (default 40 ms): the same named sfx twice
inside the gap plays once. `E.save.inc(key)`. fx: `E.fx.play("explosao", x, y)`
with `E.fx.presets` (explosao, faisca, fumaca, confete, poeira, gosma, cura).
spr: `E.spr.grid(name, {file, cols, rows, tw, th})` + `E.spr.frames(prefix, a, b)`.
tilemap: `fill(c, r, w, h, v)`, `find(v)`. sfx: `SFX.arpejo(base, semitones, ms)`.

**Core 1.3 / module fixes.** Timers and tweens due in the same frame now run
in creation order (two tweens on the same property: the newest wins — use
`E.killTweensOf` before retweening); `E.tween` without `ms` ends instead of
running `NaN` forever; `every(0, fn, n)` repeats; `E.m.map` with an empty
range returns `c`; `button/bar/panel` accept black (`0x0000`); `textBox
{max}` keeps the `...` inside the width; module ticks flagged `always` run
while paused (the pad's "continue" button works). New: `goto/push(name,
{arg})` reaches `enter(arg)` and `pop({arg})` reaches `resume(arg)` (`{arg}`
alone opens no veil), `E.prevScene`, `E.run(scenes, first, arg)`,
`E.timeLeft(timer)`, relative tweens (`{x: "+=20"}`), `seq` steps `{wait}` and
`{call}`, `E.m.weighted/lerpColor/fmt/clock/moveToward`, `group.closest`,
`pool.find`, `E.cam.panTo(x, y, ms)`, `E.gfx.hearts(hp, max, x, y)`,
`E.save.bool/toggle`, and the debug overlay shows the scene and stack depth.
Modules: events 1.1 (reentrant emit no longer skips listeners; `"*"` wildcard
listener), pad 1.1 (works while paused; a touch landing on a button does not
grab the stick; controls belong to their scene; `heldMs`/`tap`), level 1.1
(CRLF text; `lv.tilemap()`, `progress.complete/totalStars`), collide 1.1
(`move` with `NaN` no longer hangs; the hash recycles cells in scrolling
worlds; `ray` and `sweep`), path 1.1 (a blocked goal returns at once; `smooth`
no longer cuts wall corners; `flow` distance maps; `follower {loop|pingpong}`),
fsm 1.1 (a returned string wins over a pending `go`; `pop` resumes with the
state's bag and time via `resume`; `"*"` wildcard state), tilemap 1.3
(`autotile`, `neighbors`), spr 1.3 (reloading a name frees its old slot;
`anim.play` of the same clip applies the new fps; loops keep the leftover
time; `anim.speed`, `onFrame`), fx 1.3 (`beam`, `count`), sfx 1.3 (single
notes in `transpor/tempo/varia`; `combo`), grid 1.1.1 (`flood` from outside
the grid), physics 2.1.1 (`verletFast` falls back to JS when native worlds
run out).

## 19. API cheat sheet

| Call | Does |
|---|---|
| `E.init(opts)` / `E.run(scenes, first)` | detect caps / own the loop |
| `E.goto(name, {transition})` / `E.quit()` | switch scene (veil: fade/iris/wipe/bands) / leave the loop |
| `E.input`, `E.hit(r, pad)`, `E.press(r, pad)` | touch state (+ `doubleTap`), tap in rect, held in rect |
| `E.pause()`, `E.paused`, `E.timeScale`, `E.debug` | game pause, slow motion, fps overlay (§18b) |
| `E.gfx.*`, `E.cam` | camera-aware drawing, scroll/shake/follow |
| `E.u(v)`, `E.U`, `E.font(px)`, `E.ts` | project-unit scale, pixel-height typography |
| `scene.static`, `E.redraw()` | menus that draw only when something changes |
| `E.dirty.enable/clip/unclip/add/full/erase`, `E.tilemap` | erase-and-redraw only what changed (tilemap: optional module) |
| `E.group()` (+ `sort/remove`), `E.pool(n, f)` | entity lists, pre-allocated recycling |
| `E.spr.load/blit`, `E.spr.sheet`, `E.anim(frames, fps)` | PNG sprites, spritesheet regions, flipbooks (optional module) |
| `E.fx.burst/ring/popText/flash/stars/draw` | juice |
| `E.fx.emitter/trail/parallax` | continuous sources, entity trails, camera parallax (fx module) |
| `E.tween/seq/after/every/cancel/clear*` | engine-ticked time, tween timelines |
| `E.ui.menu/list/dialog/title/pause/gameOver/confirm/toast` | ready game UI (optional module — §14b) |
| `E.audio.music/beat/sfx/stop/mute/volume` | chiptune + polite sfx |
| `E.save.get/set/num/best/obj/setObj/del` | NVS persistence (objects as JSON) |
| `E.m.*`, `E.rng(seed)` | math (+ `noise`), deterministic RNG |
| `E.push/pop/depth`, scene `cleanup` | scene stack (inventory over the game), auto-kill of scene timers |
| `E.fsm`, `E.on/emit`, `E.path`, `E.collide`, `E.pad`, `E.level` | modules for complex games (§14c) |
| `E.script`, `E.inv`, `E.steer`, `E.gen`, `E.stats`, `E.waves` | cutscenes, inventory, steering, procedural levels, combat stats, wave director (§14d) |
| `goto/push/pop {arg}`, `E.prevScene`, `E.timeLeft`, `E.cam.panTo`, `E.gfx.hearts` | scene parameters, cooldown display, camera pans, hp hearts (core 1.3) |
| `P.verletFast`, `P.rigid`, `P.hit` | the physics ladder: native Verlet, native rigid bodies, static overlap (optional module — §15) |

Editor autocomplete ships in the scaffold: the `.d.ts` of each adopted module (`celeros.game.d.ts`, `celeros.game.fx.d.ts`, ...) alongside `celer.d.ts` (firmware API); `require("celeros.engine")` games keep the all-in-one `celeros.engine.d.ts`, GENERATED from the module `.d.ts` files by `node tools/sdk/lib/engine_dts.js` (edit the module's file, then rerun; `test/sdk` fails on drift and on any public engine member without a type).
