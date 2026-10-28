# Celer Studio — game and program editor for CelerOS

Celer Studio is a Unity-style editor for CelerOS apps. Two runtimes share the
same file format, op bus and GUI:

- **game** (`runtime: "studio"`, the default) — scenes, tilemaps and entities on
  top of CelerGame, the ES5 engine shipped as `celeros.game.*` dependencies;
- **program** (`runtime: "app"`) — each scene is a screen built from the system
  toolkit widgets (`UI.*`), with no engine dependency at all.

It is **file-first**: the project, scenes, prefabs and asset metadata are plain
JSON on disk, and every action is a JSON command on a single bus used by the
GUI, the CLI and the HTTP API. An AI agent — or the built-in copilot — can
build a whole app without opening the browser.

- Location: `tools/studio/` (SDK command `node tools/sdk/celer.js studio ...`)
- GUI: local web app served by Node (no build step, no npm dependencies)
- Output: a flat CelerOS app package (ES5, ready for `celerctl`/hub)

## Quick start

```bash
# 1. create a project (creates a starter scene)
node tools/sdk/celer.js studio init ~/Jogo --name "Meu Jogo"
node tools/sdk/celer.js studio init ~/Painel --app --name "Painel"   # program

# 2. open the editor (hierarquia, inspetor, viewport, play)
node tools/sdk/celer.js studio ~/Jogo serve --open

# 3. or drive it headless
node tools/sdk/celer.js studio ~/Jogo describe --json
node tools/sdk/celer.js studio ~/Jogo validate
node tools/sdk/celer.js studio ~/Jogo build
node tools/sdk/celer.js studio ~/Jogo run --ms 1200 --out tela.png

# 4. or let the copilot write the ops (needs an API key in the environment)
node tools/sdk/celer.js studio ~/Jogo ai "adicione um botao Sobre que abre a cena Sobre"
```

## Project layout

```
MeuJogo/
  celergame.project.json          project settings + engine deps
  Assets/
    Sprites/heroi.png  heroi.png.meta
    Sprites/atlas.png  atlas.png.meta
    Audio/bump.qoa     bump.qoa.meta
    Scripts/heroi.js   heroi.js.meta
    Prefabs/inimigo.prefab.json   inimigo.prefab.json.meta
    Scenes/campo.scene.json       campo.scene.json.meta
  icon.png                        optional package icon
  .studio/                        build/, undo/, redo/, run/ (gitignored)
  .gitignore
```

Every asset, scene and prefab has a `.meta` sidecar with a **stable 32-hex
GUID**. Renaming the file does not change the GUID; references (scenes,
prefabs, components) point at the GUID. This is what makes AI edits and renames
safe.

### `celergame.project.json`

```json
{
  "format": 1,
  "rev": 3,
  "studio": "0.1.0",
  "name": "Meu Jogo",
  "packageName": "br.autor.meujogo",
  "version": "0.1.0",
  "author": "Autor",
  "description": "Jogo feito com a CelerGame",
  "type": "Game",
  "category": "Jogos",
  "api": 50,
  "requires": ["psram"],
  "topbar": false,
  "permissions": [],
  "deps": {
    "celeros.game": "^1.4.5",
    "celeros.game.spr": "^1.5.2",
    "celeros.game.tilemap": "^1.3.0"
  },
  "canvas": { "w": 240, "h": 320, "native": false, "fps": 30 },
  "startScene": "0123456789abcdef0123456789abcdef",
  "build": { "out": ".studio/build", "splitKB": 96 },
  "editor": { "grid": 8, "snap": true }
}
```

- `canvas.native` selects the 480x480 native canvas on S3 boards; otherwise
  the app uses the virtual 240x320 space.
- `deps` are the CelerGame modules the built app declares (max 8). The
  generated runtime requires `celeros.game`, `celeros.game.spr` and
  `celeros.game.tilemap`; additional `celeros.game.*` deps are required in
  `main.js` automatically.
- `rev` is an optimistic revision counter. Commands accept `ifRev` and refuse
  stale writes.

### `.meta`

```json
{
  "format": 1,
  "guid": "8f14e45fceea167a5a36dedd4bea2543",
  "importer": "tileset",
  "settings": {
    "mode": "grid",
    "w": 512, "h": 256,
    "cols": 8, "rows": 4, "tw": 64, "th": 64,
    "pivot": [0.5, 0.5],
    "key": "#000000",
    "prefix": "",
    "tiles": [{ "name": "0", "solid": false }],
    "anims": { "idle": [0, 1], "run": [2, 3, 4, 5] },
    "fps": { "run": 12 },
    "loop": { "idle": true, "run": true },
    "hitbox": [8, 8, 48, 48]
  }
}
```

Importers: `sprite` (single image), `sprite-sheet` (grid or explicit
regions), `tileset` (grid + tile metadata), `audio`, `script`, `scene`,
`prefab`. Colors are `#RRGGBB` in source; the build converts them to RGB565.

`pivot`, `anims`, `fps`, `loop` and `hitbox` are the engine's
`E.spr.meta` contract (spr 1.6): the build registers them in the generated
data module, so `blit`/`stamp` inherit the anchor and `E.spr.animOf`/`box`
work in scripts. `anims` entries are grid indices (or explicit runtime
region names); `fps` is per clip; `hitbox` is `[x,y,w,h]` inside the frame.

### Scene

```json
{
  "format": 1,
  "rev": 4,
  "guid": "0123456789abcdef0123456789abcdef",
  "name": "campo",
  "settings": {
    "bg": "#101020",
    "fps": 30,
    "static": false,
    "camera": { "bounds": [0, 0, 480, 320], "follow": "e_hero", "deadzone": [40, 30] }
  },
  "entities": [
    {
      "fid": "e_hero",
      "name": "Heroi",
      "active": true,
      "z": 5,
      "transform": { "x": 80, "y": 120, "rot": 0, "sx": 1, "sy": 1 },
      "components": [
        { "id": "c_spr", "type": "sprite", "fields": { "sprite": "GUID#heroi0", "key": "#000000" } },
        { "id": "c_scr", "type": "script", "fields": { "script": "GUID", "fields": { "speed": 60 } } }
      ]
    }
  ],
  "tilemaps": [
    {
      "id": "tm_chao",
      "tileset": "GUID",
      "cols": 15, "rows": 10, "cell": 32, "ox": 0, "oy": 0, "layer": 0,
      "data": [3, 3, 0, -1],
      "solids": [false, false, false, true],
      "autotile": { "0": 1, "1": 2, "2": 3, "3": 4 }
    }
  ]
}
```

- Every entity has an implicit `transform`; `z` is the draw order. `ax`/`ay`
  are optional: when omitted, the sprite's `.meta` pivot is used (spr 1.6);
  an explicit value overrides it.
- `fid` is the stable entity id inside the scene/prefab.
- Sprite refs are `"<asset guid>#<region>"` (single-image assets may omit
  `#region` when the importer mode is `single`).
- Tilemap `data` is a flat `cols*rows` array; `-1` means an empty cell.
  `solids` is consulted by `E.tilemap.solidAt/rectSolid`; `autotile` maps a
  4-bit neighbour mask (1=up, 2=right, 4=down, 8=left) to a tile index.
- A prefab instance is an entity with `prefab` (GUID) and `overrides`; the
  build flattens it into real entities (the runtime never resolves prefabs).

### Prefab

```json
{
  "format": 1,
  "rev": 2,
  "guid": "0123456789abcdef0123456789abcdef",
  "name": "moeda",
  "entities": [
    {
      "fid": "e_base",
      "name": "moeda",
      "z": 0,
      "transform": { "x": 0, "y": 0, "rot": 0, "sx": 1, "sy": 1, "ax": 0.5, "ay": 0.5 },
      "components": [{ "id": "c_a", "type": "anim", "fields": { "clips": {} } }]
    }
  ]
}
```

Prefab transforms are local (0,0 = instance origin). Overrides are keyed by
the prefab entity `fid`:

```json
{
  "overrides": {
    "e_base": {
      "name": "Moeda azul",
      "transform": { "x": 24 },
      "active": true,
      "components": { "c_a": { "current": "idle" } }
    }
  }
}
```

Nesting is flattened recursively at build time (limit 4 levels).

## Native remounts (`studio_games/`)

The four biggest games are **native Studio projects and the single source**:
their screens are scenes, their rooms/levels are tilemaps and their
pieces/spawns are entities. The controllers live in `Assets/Scripts/*.js`. The
hub publishes the **build** of these projects, so the old flat copies that used
to live in `hub_apps/` were removed (2026-10-27) — never edit a game in two
places.

| Project | Version | Scenes | Extras | JS | Assets |
|---------|---------|--------|--------|----|--------|
| `studio_games/Detona` | 1.2.0 | 10 | 9 | 68.3 KB | 131.6 KB |
| `studio_games/Arrasa` | 2.1.0 | 13 | 14 | 81.5 KB | 66.8 KB |
| `studio_games/Lenda de Celer` | 2.2.0 | 23 | 12 | 115.3 KB | 245.7 KB |
| `studio_games/Supernova` | 3.1.0 | 5 | 8 | 32.8 KB | 192.7 KB |

(Sizes measured 2026-10-27 with the minified pipeline — `studio build`.)

Open, edit and play like any project:

```bash
node tools/sdk/celer.js studio "studio_games/Detona" serve --open
node tools/sdk/celer.js studio "studio_games/Detona" build
node tools/sdk/celer.js studio "studio_games/Detona" run --frames 0,1200
# navigate menus (480x480): 300 tap 240,300 -> --input toques.txt
```

What each remount added:

- **Detona 1.0.5** — six campaign levels as editable 15x13 tilemaps with three
  tilesets (garden/forge/core), hidden exit under a crate, powerups (range,
  bomb, speed, remote, shield, life), a 12 HP boss with an HP bar, stars,
  level map, pause and saved progress. Touch is a floating drag joystick
  (hold to walk cell by cell; dry tap plants); the HUD is memoized outside
  the dirty layer, the board is baked into one sprite and each
  frame restores it with one board blit. 1.0.5 adds `text2d`-generated 16-bit
  walk cycles for the soldier and slime.
- **Arrasa 2.0.2** — the original ten stages as scenes; each box/goblin/king is
  an entity with its texture/rotation synced to a `P.rigid` body. Sling aim,
  seven projectile powers, TNT chains, impact damage, stars, saved progress.
  2.0.2 animates ordinary goblins with a `text2d`-generated cycle; the king
  stays on the old sheet.
- **Lenda de Celer 2.0.7** — all 20 original ASCII rooms as scenes (Campo,
  Gruta and Templo), tile solids per tile, portals for edges/doors/stairs/
  caves/cracked walls, sword/bomb/boomerang, chests, Sage, crystal shop, a
  three-phase Guardian, automatic save, continue, victory and game over. The A/B
  buttons use sword/bomb/boomerang icons, the sword is a separate overlay (the
  body stays visible), and tilemaps anchor each cell at the corner. 2.0.4 also
  ships the resolved `deps.json` inside the package, so a direct install finds
  the shared engine modules. 2.0.5 memoizes the HUD outside the dirty layer,
  clips the world repaint at the HUD band (no more 12 heart circles, button
  icons and texts per frame) and reuses sprite options/frame names. 2.0.7 swaps
  the heroine to a `text2d`-generated cycle (the sword remains an overlay on
  the old sheet).
- **Supernova 3.0.2** — a 10-wave campaign with a boss every five waves plus an
  endless mode, three-phase boss, combo x1..x5, orbs, SUPERNOVA blast, triple
  shot, graze hitbox, pause, record and native title/victory/loss scenes. 3.0.2
  regenerates the scout ship and enemy drone with `text2d`; the enemy pulses in
  flight.

### Scene data and the controller API

A native scene can drive scripts through `settings.data` and load extra assets
with `settings.assets`. The `data` component puts free-form JSON on an entity
(`entity.data`). Scripts receive this context:

```js
ctx = {
  E, scene, entity, assets, arg, save, data,
  asset(name),                 // asset runtime data (sprite metadata etc.)
  go(sceneTitle, arg)          // scene transition; arg becomes ctx.arg
}
```

and the scene exposes:

```js
scene.title, scene.data, scene.arg
scene.entities, scene.tilemaps
scene.find(fidOrName), scene.tm(id)
scene.solidAt(x, y), scene.rectSolid(x, y, w, h)
scene.asset(name)
```

`start()` runs after the whole world (entities + tilemaps) is built. Use this
API for title screens, HUDs and controllers that spawn/pool their own objects
(enemies, bullets, physics bodies) while the editable level data stays in the
scene.

Tilemaps have **per-tile collision** when the tileset `.meta` has
`tiles[i].solid`. The build writes `solidValues` and the runtime's
`map.solidAt()` follows the **current** cell value, so `map.set(c, r, 0)` opens
a destroyed crate/cracked wall immediately. Older tilemaps without tile flags
fall back to the scene `solids` array.

Prefabs are still flattened at build time; there is no runtime "spawn prefab"
call. Dynamic objects are controller-owned pools/entities, as in the four
native games.

### Legacy bridge (optional)

`studio import-game` remains available for a quick editable copy of an app
that has not been ported yet. It creates `runtime: "legacy"` + `legacy.entry`;
`build` embeds `templates/legacy.js`, which captures the original `E.run`
table, redirects `E.goto`/`push`/`pop` and keeps input, modules, timers, tweens,
camera, audio and the dirty layer engine-owned. A legacy scene in the panel is
only a card: entities/tilemaps do not drive that runtime. The four
`studio_games/` projects no longer use this mode; the bridge is tested so the
tool remains safe.

## Components

| Type | Fields |
|------|--------|
| `sprite` | `sprite` (ref), `key` (color-key) |
| `anim` | `meta` (atlas asset for `E.spr.animOf`), `clips` (`{name:{frames:[refs],fps,loop}}`), `current`, `autoplay` |
| `text` | `text`, `color`, `px` or `ts` (`tiny..huge`), `align`, `valign`, `shadow` |
| `shape` | `shape` (`rect`, `circle`, `line`), `w`, `h`, `r`, `x2`, `y2`, `color`, `fill` |
| `collider` | `shape`, `w`, `h`, `r` (editor gizmo + `entity.col` for scripts) |
| `script` | `script` (script asset ref), `fields` (JSON sent to the script) |
| `hud` | `anchor` (0..8 numeric keypad), `mx`, `my` — positions the entity's sprite/text/shape with `E.anchor` (core 1.5), safe-margin aware |
| `data` | `fields` (JSON) — free-form data delivered to scripts as `entity.data` |

When an `anim` has `meta`, the runtime asks `E.spr.animOf(meta, current)` for
the clip declared in the atlas `.meta`; explicit `clips` remain as a fallback.

`transform` is implicit and appears in the inspector. The single source of
truth for fields, types, defaults and GUI forms is
`tools/studio/schema/components.json`.

### Scripts

A script is an ES5 CommonJS module copied into the package as `s.<slug>.js`.
The runtime calls it with `this` = script instance and `ctx` =
`{ E, scene, entity, assets }`:

```js
exports.props = { speed: 60 };

exports.start = function (ctx) { this.t = 0; };

exports.update = function (dt, ctx) {
    this.t += dt;
    ctx.entity.x += Math.sin(this.t * 3) * (this.fields.speed || 20) * dt;
};

exports.draw = function (ctx) { /* optional, after built-in components */ };
exports.destroy = function (ctx) { /* optional */ };
```

`ctx.entity` exposes `x, y, rot, sx, sy, ax, ay, z, active, fields`,
`setClip(name)` for animated entities and `box(scale, out)` — the atlas hitbox
from `E.spr.box`, in world coordinates. `ctx.E` is the engine object, so
scripts can use `E.spr.animOf`, `E.prof`, `E.anchor`, etc. The script is
linted by `app_lint` (ES5 only) during build.

### Typed script props

`exports.props` declares the script's own fields. The Studio extracts **only**
that object literal (never runs the script) and stores the normalized schema in
the asset `.meta` (`settings.props`), so the inspector renders typed inputs
instead of a raw JSON box and the build merges the defaults:

```js
exports.props = {
    velocidade: 60,                                     // number (shorthand)
    modo: { type: 'enum', values: ['normal', 'duro'], default: 'normal', label: 'Modo' },
    cor: { type: 'color', default: '#38bcf8' },
    raio: { type: 'number', default: 8, min: 1, max: 32, hint: 'em pixels' }
};
```

Types: `number`, `int`, `bool`, `string`, `color`, `enum`, `json`. Component
values win over the declared defaults; a field that is not in `exports.props`
produces a `script.field` warning at validate time. Screen scripts
(`settings.scripts`) also receive their props as `this.fields`.

## Programs (`runtime: "app"`)

The Studio is not only a game editor. With `runtime: "app"` each scene becomes
a **screen** of a regular CelerOS program, drawn with the system toolkit
(`UI.*` — the same one Settings/Store use):

- **No engine dependency**: the package has no `celeros.game.*` deps and no
  `requires: ["psram"]`, so a program also fits the CYD (48 KB JS budget).
- `app.data.js` replaces `game.data.js`; `main.js` inlines the screen runtime
  (no `E.init`, no `E.run`).
- `transform.x/y` is the widget's **top-left corner**; `z` is the draw order.
- The header (`UI.header`) occupies `y = 0..40`: start content at `y >= 44`.
- `canvas.native` is rejected (Kui is strictly the 240x320 virtual space).

```bash
node tools/sdk/celer.js studio init ~/Painel --app --name "Painel"
node tools/sdk/celer.js studio ~/Painel run --frames 0,900
```

### Screen state

`settings.data` is the screen's initial state. Widgets with a `key`/`bind` read
and write that flat object; scripts mutate it through `ctx.set`. With
`settings.persist` (a Storage key) the state survives reboots — writes are
debounced (1 s) because NVS must not take one per frame.

### Widgets

| Type | Fields |
|------|--------|
| `ui.text` | `text`, `bind` (state key), `role` (`caption/body/title/display`), `color`, `align`, `w`, `lines`, `bg`, `id` |
| `ui.button` | `label`, `w`, `h`, `style` (`primary/ghost/danger`), `disabled`, `disabledBind`, `event`, `go` (screen), `id` |
| `ui.toggle` | `key`, `event`, `id` (44x24) |
| `ui.slider` | `key`, `w`, `min`, `max`, `step`, `event`, `id` |
| `ui.progress` | `value` or `key` (0..100), `w`, `h` |
| `ui.list` | `items` (JSON) or `itemsBind`, `key` (selected index), `w`, `h`, `rowH`, `event`, `id` |
| `ui.tabs` | `labels` (JSON), `key`, `w`, `h`, `event` |
| `ui.card` | `w`, `h`, `radius`, `color`, `stroke` |
| `ui.image` | `asset` (single-frame PNG), `w`, `h`, `key` — drawn with `System.drawPNG` (natural size) |
| `ui.badge` | `text`/`bind`, `color`, `textColor` |
| `ui.spinner` | `r`, `color` |
| `ui.field` | `key`, `label`, `mask`, `hint` — opens `System.prompt` (blocking) and writes the state |
| `ai.chat` | `provider`, `model`, `system`, `prompt`/`promptKey`, `trigger`, `outKey`, `busyKey`, `errorKey`, `history`/`histKey`, `attach` (`mic` sends the last recording), `maxTokens` |
| `ai.speak` | `text`/`textKey`, `voice`, `trigger`, `busyKey` |
| `ai.vision` | `prompt`, `imageKey` (path), `trigger`, `outKey`, `errorKey` |
| `mic.record` | `key` (base64 WAV), `mode` (`hold`/`toggle`), `label`, `w`, `h`, `maxMs`, `event` |

The widget catalog (`studio describe`) is the source of truth for defaults.

### Events and screen scripts

`settings.scripts` is a list of script GUIDs. The screen runtime calls
`create/start/update(dt)/draw/event(name, value)/destroy` with a **screen ctx**
(no entity):

```js
{ scene, app, st, get(k), set(k, v), go(screen, arg), back(), exit(),
  asset(slot), store{get,set,remove}, toast(msg), full, arg }
```

Interactive widgets dispatch `event(name, value)` to the screen scripts (and to
the scripts of the entity that fired). `ui.button.go` navigates without any
script. A widget without `event` still updates the state.

### Navigation

`ctx.go('Sobre')` pushes the current screen; `ctx.back()` pops; back at the
root **ends the app** by unwinding the loop (no `system` permission needed).
The header draws the back arrow whenever the stack is not empty.

### Cards bracket the background

`ui.card` is not a loose rectangle: it **pushes the background color** used by
the widgets drawn after it, so a partial redraw clears its own rectangle with
the card color. A card is closed by the next `ui.card` (or by the end of the
screen). Place cards before their content (lower `z`).

### AI components are dataflow

No callbacks in JSON: the script sets a state key (`st.pedir = true`) and the
component fires; the answer lands in `outKey` and `event("ai:done")` tells the
script. `ai.*` needs the `net` permission, `ai.vision` also `fs`, and
`mic.record` needs `mic` — validate enforces that. Without the object on the
device (or the permission) the widget hides itself and the state gets an error.

Try it: `studio_apps/Painel` (device dashboard) and `studio_apps/Assistente`
(text + voice chat).

## AI copilot

The Studio ships a copilot that turns a prompt into a batch of ops. It never
writes files directly: the batch is validated by `applyOps` in **dry-run**, and
only then applied through the same bus (so undo works).

```bash
export OPENROUTER_API_KEY=...          # or CELER_STUDIO_AI_KEY / DEEPSEEK_API_KEY
node tools/sdk/celer.js studio ~/Painel ai "adicione um cartao de temperatura na tela Painel"
node tools/sdk/celer.js studio ~/Painel ai "crie uma tela de ajustes" --dry-run
node tools/sdk/celer.js studio ~/Painel ai fix          # fix validation/build errors
node tools/sdk/celer.js studio ~/Painel ai explain "o que faz a tela Sobre"
node tools/sdk/celer.js studio ~/Painel ai "transforme este esboco em tela" --image esboco.png
```

Environment: `CELER_STUDIO_AI_PROVIDER` (`openrouter` default, `deepseek`,
`openai`), `CELER_STUDIO_AI_MODEL`, `CELER_STUDIO_AI_KEY`
(fallback `OPENROUTER_API_KEY`/`DEEPSEEK_API_KEY`/`OPENAI_API_KEY`) and
`CELER_STUDIO_AI_URL` for any OpenAI-compatible endpoint. Nothing is stored in
the repository.

If the batch fails validation the error is sent back to the model and it tries
again (`--max-steps`, default 2). Guardrails: destructive ops
(`asset/scene/entity.delete`, `tilemap.remove`) and `asset.import` are blocked
(`--allow-delete`/`--allow-import` to override), at most 40 ops per batch, and
the current `rev` is sent so a concurrent edit is detected.

The GUI has an **IA** tab: type the request, the reply shows the proposed ops
and the previewed change count; **Aplicar** sends exactly that batch,
**Descartar** throws it away. It also accepts an attached image (sketch/print)
and a 4 s voice recording (WAV, sent as `input_audio`). HTTP equivalent:
`POST /api/command {"cmd":"ai","prompt":"...","images":[],"audio":[],"apply":false}`
— dry-run by default; use the same batch in `/api/command` to apply.

## Assets and limits

Importers are chosen from the file extension by default:

```bash
node tools/sdk/celer.js studio ~/Jogo import heroi.png
node tools/sdk/celer.js studio ~/Jogo import atlas.png --importer tileset --grid 4x4 --tw 64 --th 64
node tools/sdk/celer.js studio ~/Jogo import bump.qoa --loop
node tools/sdk/celer.js studio ~/Jogo import heroi.js
```

PNG assets are decoded on import to record `w/h`; a grid must fit the image.
The GUI can import by drag/select and edit slicing (mode, cols/rows, tile
size, pivot, color-key) in the asset inspector.

Package limits enforced by the build/validate (same as the hub):

- 8 direct deps; max 16 package extras (data file(s) + scripts + non-script
  assets; `app.json`, `main.js` and `icon.png` are free);
- 128 KB per non-JS asset, 256 KB total non-JS assets;
- stripped JS ceiling: 48 KB without PSRAM; 1 MB with `requires: ["psram"]`;
  256 KB per module; a module over 30 KB requires `api >= 6`;
- flat names `[A-Za-z0-9._-]{1,64}`; no subdirectories in the package.

The build copies only graphic/audio assets referenced by some scene; all
script assets are copied so local `require` between them works.

## Build output

```bash
node tools/sdk/celer.js studio ~/Jogo build
# .studio/build/br_autor_meujogo/
#   app.json          derived from the project
#   main.js           E.init + inlined studio runtime + boot
#   game.data.js      flattened scenes/prefabs + asset table (split at splitKB)
#   s.heroi.js        user scripts (local modules, no dep slot)
#   atlas.png         flat assets used by the scenes
#   icon.png
```

The runtime (`tools/studio/templates/runtime.js`, ES5) is **inlined** into
`main.js`; it is not a hub dependency, so a project does not spend one of its
8 dep slots. It loads each scene's sheets on entry and frees them on exit,
uses `E.dirty` with a painter that repaints tilemap cells, draws tilemaps by
layer, entities by `z`, runs scripts, and follows the scene camera.

It is built on the current engine line:

- sheets are registered with **`E.spr.meta`** (grid, prefix, anchor, anims,
  fps, loop, hitbox); single images use `E.spr.load` + `E.spr.meta`;
- `anim` components with `meta` use **`E.spr.animOf`**; scripts get
  **`entity.box()`** via `E.spr.box`;
- `hud` components use **`E.anchor`** (`E.ax/ay`, `E.inset`), so HUD entities
  sit at the 9 anchor points without camera math;
- `editor.debug` sets `E.debug`, `editor.prof` sets `E.prof.on` (the overlay
  then shows `u`/`d` section times); the sprite pool is automatically tracked
  by **`E.slots`**;
- scene music is started with `System.playWav` on entry.

Builds are deterministic: sorted assets/scenes, no timestamps in the package,
stable generated names. `.studio/report.json` records sizes and warnings.

## CLI reference

`studio [DIR] <command>`; `DIR` defaults to the current directory and may also
be passed as `--dir`. `--json` makes every command machine-readable; errors
carry `{code, message, hint, diagnostics}` and exit code 1.

| Command | Meaning |
|---------|---------|
| `init [DIR]` | create project + starter scene (`--name`, `--pkg`, `--author`, `--description`) |
| `describe` | project summary, component catalog, ops, limits, assets/scenes |
| `schema [project\|scene\|prefab\|meta\|components]` | JSON Schema |
| `import FILE` | import PNG/QOA/WAV/JS (`--importer`, `--grid CxR`, `--tw/--th`, `--prefix`, `--key`, `--pivot x,y`, `--loop`, `--gain`) |
| `import-game APP [DEST]` | scaffold an editable **legacy** project from an existing app (assets, scripts, metadata, original main) |
| `apply [FILE\|-] [--op JSON]` | run an op batch atomically (`--dry-run`, `--if-rev N`) |
| `validate` | schema, refs, package limits, ES5 lint |
| `build` | write the flat app package |
| `run` | build + run on the host harness (`--ms`, `--out`, `--frames 0,600`, `--seed`, `--input toques.txt`, `--no-build`) |
| `export DIR` | copy the build to a folder (`--force`) |
| `deploy [--out app.zip] [--no-build]` | validate/build, strip JS, pack used assets into a deterministic `app.zip` |
| `undo` / `redo` | restore the previous batch / reapply |
| `fmt` | rewrite all JSON/metas canonically |
| `serve` | open the GUI (`--port`, default 8421; `--open`) |

### Ops

`apply` takes an array, `{ops:[...]}` or a single `{op:...}`:

```
project.set
scene.create/delete/rename/set/start
entity.create/set/delete/duplicate
component.add/set/remove
prefab.create/instance/override
asset.import/set/rename/delete
script.set
tilemap.add/set/paint/fill/remove
```

Entity and component ops accept `scene` **or** `prefab` as the container.
`entity.create` and `prefab.instance` accept an explicit `fid`, so an agent can
build a graph in one batch and reference the ids it chose. `asset.import`
accepts a source path; the GUI's upload endpoint writes a temporary file and
uses the same op.

Example (create a scene, a hero and a tilemap):

```json
[
  { "op": "scene.create", "name": "Fase 1" },
  { "op": "scene.start", "scene": "Fase 1" },
  { "op": "entity.create", "scene": "Fase 1", "fid": "e_hero", "name": "Heroi", "x": 80, "y": 120, "z": 5 },
  { "op": "component.add", "scene": "Fase 1", "entity": "e_hero", "type": "sprite",
    "fields": { "sprite": "GUID#0" } },
  { "op": "tilemap.add", "scene": "Fase 1", "tileset": "GUID",
    "cols": 15, "rows": 10, "cell": 32, "data": [0] }
]
```

Every batch is atomic: a validation error restores the tree to the state
before the batch. The bus snapshots the touched files under `.studio/undo/`
and appends an audit line to `.studio/journal.jsonl`.

## HTTP API

The GUI server binds to `127.0.0.1` (no authentication; it is a local tool).

| Endpoint | Meaning |
|----------|---------|
| `GET /api/snapshot` | describe + full scenes/prefabs + build/play state |
| `GET /api/state` | lighter state (describe, build report, play) |
| `GET /api/events` | SSE: file changes and play state |
| `GET /api/assets?path=Assets/...` | serve a project asset (path jailed) |
| `GET /api/run.png` | last headless screenshot |
| `POST /api/command` | `{ops:[...], dryRun, ifRev}` or `{cmd:"build"\|"validate"\|"run"\|"play"\|"stop"\|"deploy"\|"undo"\|"redo"\|"fmt"\|"export"\|"describe"}` |
| `POST /api/upload?name=&importer=&grid=&cols=&rows=&tw=&th=` | raw file bytes; imports via the same `asset.import` op |

Every command response includes `snapshot`, so a client can re-render without
a second round-trip. The GUI and the CLI exercise the same `lib/ops.js`; the
test suite proves they produce equivalent files.

## GUI tour

- **Hierarquia**: cena, entidades, instâncias de prefab e tilemaps; filtro por
  nome/fid; `+` cria entidade; o topo tem `+ cena`.
- **Projeto**: botão `Projeto` (ou clique no nome) abre identidade, canvas,
  API, runtime, cena inicial, descrição/changelog, permissões, deps, psram e
  orçamento do pacote. `build`/`validar` ficam no próprio painel.
- **Viewport**: pan com botão do meio ou Espaço+arrastar, zoom na roda;
  grade/snap; coordenadas no canto; `Fit`. A entidade selecionada ganha
  gizmos **Mover/Girar/Escalar** (`W`/`E`/`R`), com handles de X/Y, anel de
  rotação e cantos de escala. Setas movem a entidade; `Shift` amplia o passo;
  `Ctrl+D` duplica; `F` enquadra; `Delete` apaga.
- **Drag-and-drop**: arraste um sprite/atlas/tileset para a cena e nasce uma
  entidade com componente sprite; arraste um prefab para instanciá-lo; solte
  um script numa entidade selecionada para anexá-lo.
- **Inspetor**: painel do projeto, cena (incluindo `settings.data`,
  `settings.assets`, música e câmera), entidade, tilemap e assets, gerado do
  schema. Também cria/instancia prefabs, mostra uso do asset e edita sólidos
  por tile do tileset. Clipes de animação do `.meta` têm preview com play/fps.
- **Assets**: filtro por nome/caminho, importar, thumbnails, duplo clique em
  cena/script; configurações de fatiamento, pivot, cor-chave, anims/hitbox;
  o preview desenha hitbox e âncora.
- **Tilemap painter**: selecione um tilemap, escolha um tile na paleta (ou a
  borracha) e clique/arraste no viewport; botão direito apaga. A paleta grava
  `data`, o checkbox "solido" também grava `solids`; o traço vira um único
  `tilemap.set` no pointer-up. Mudar cols/rows redimensiona preservando o
  canto superior esquerdo.
- **Build**: relatório do pacote + barras de extras/JS/assets/deps contra os
  tetos do ESP32; avisos de lint, arquivos gerados e screenshot do `run`.
- **Play**: gera o pacote e abre o emulador ao vivo num iframe.
- **Console/barra de comandos**: logs, diagnósticos e as mesmas ops JSON do
  CLI/API; atalhos `build`, `validate`, `run`, `play`, `stop`, `undo`, `redo`.

## AI operation

1. `studio describe --json` — discover the project, components, limits, assets
   and ops.
2. `studio schema components` — read the field catalog.
3. `studio apply --json -` — send a batch with explicit `fid`/`id` values and
   `ifRev` for optimistic concurrency.
4. `studio validate --json` / `studio build --json` / `studio run --json`.
5. On errors, use the stable `code` (`schema.*`, `ref.*`, `asset.*`,
   `build.invalid`, `build.lint`, `rev.stale`, `undo.empty`) and `hint`.

The same contract is available over HTTP (`POST /api/command`), so an agent
can drive a live editor session while a human watches the viewport.

The built-in copilot (`studio ai`, the **IA** GUI tab, `{"cmd":"ai"}` over HTTP)
is a ready-made client of this contract: see **AI copilot** above.

## Deploy / app.zip

`deploy` is the Studio "compile" step: it validates and builds, runs every JS
file through the same `jsstrip` + `jsmin` used by the hub (comments/indentation
out, local names shortened, line breaks kept), keeps only the assets the
build selected, compacts `app.json`, and writes a deterministic ZIP with
`app.json` at the root (the layout accepted by `celerctl apps installzip`).
The ZIP also carries `deps.json` with the resolved `celeros.game.*` closure:
the device `require` only falls back to `/local/modules` when that file is in
the app folder, and the native `installzip` installs exactly what the package
contains. The store may rewrite the lock from the hub index, but a directly
installed package is already self-consistent.

```bash
# default: <project>/.studio/deploy/app.zip + report.json
node tools/sdk/celer.js studio ~/Jogo deploy

# custom destination and the GUI: Build tab -> "Compilar app.zip"
node tools/sdk/celer.js studio ~/Jogo deploy --out dist/MeuJogo.zip

# bench: install the zip and run on the device
python3 tools/celerctl.py apps installzip ~/Jogo/.studio/deploy/app.zip --run
```

The command prints and records in `report.json`: ZIP bytes, SHA-256,
before/after JS bytes, asset bytes, dependency lock, entry list, extras and
build warnings.
Timestamps are fixed (1980-01-01) and entries are sorted, so the same sources
and build produce the same ZIP bytes. `--no-build` reuses an existing build.
Assets are filtered by the build; they are copied losslessly and compressed
inside the ZIP (no image re-encoding). OTA updates firmware only, not apps.

## Limitations (v1)

- The host preview is Node + firmware stubs, not Duktape on ESP32: ES5 is
  enforced by `app_lint`, but timing/memory/audio/network behavior belongs on
  the bench.
- The emulator models the 240x320 virtual canvas and the 480x480 native canvas;
  CYD/watch/dog layouts are not emulated.
- Sprite flip is not an engine feature; directional animation uses separate
  frames/regions.
- Runtime fidelity: the generated scene runner draws sprites with `sx/sy`
  (per-axis scale) and `rot` (degrees, around the anchor) — since
  `celeros.game.spr` 1.7, which exposes `{angle, scaleX, scaleY}`. A sheet
  region still does not rotate (native `drawSprite` has no source rect);
  text/shape use their own components. Colliders exposed to scripts are
  axis-aligned.
- The package only includes graphic/audio assets referenced by a component,
  tilemap or scene music. An asset used only inside a script must also be
  referenced by a (possibly inactive) component so the build packs it.
- Prefab nesting is flattened at build time; the editor hierarchy is
  organizational (transforms are absolute, not inherited at runtime). The
  engine's `celeros.game.scene` data module is available to scripts when the
  project declares it, but the generated Studio runtime does not require it
  (prefabs are flattened, component behavior is the Studio runner).
- The GUI has tilemap painting, per-tile solids, animation clip preview, prefab
  create/instance and project settings. A visual atlas slicer (dragging
  arbitrary regions) and a dedicated prefab editing view are still the next
  editor steps; use `asset.set`/`component.set`/`op` batches until then.
- The four `studio_games/` projects are native: scenes, tilemaps and entities
  drive the runtime. The legacy bridge is optional and only applies to
  projects still created with `import-game`. Visual transitions are still not
  emitted by the native runner (controllers can draw their own fade).
- Dynamic gameplay (bullets, spawned enemies, physics bodies) stays in a
  controller script/pool; the runtime has no prefab-spawn call.
- `music` on a scene is started with `System.playWav` on scene entry (one
  shot); v1 has no runtime mixer/loop control. The audio importer's `loop` and
  `gain` settings are stored in the `.meta` for tooling, not applied yet.
- Tilemap camera movement repaints the cells the camera exposes; huge maps
  should use a static camera or a baked background.
- Program mode has **no layout engine**: widgets are absolutely positioned
  (exactly like `UI.*`). `ui.list` covers scrolling lists/forms; a flow/column
  container is a future addition. Kui keeps 48 widget slots, so screens above
  ~40 widgets start re-drawing every frame.
- `ui.image` draws a PNG at its natural size (`System.drawPNG` has no scale) and
  only on full frames, so do not overlap an image with a widget that changes
  every frame.
- `ui.field` uses the blocking `System.prompt`; inside the frame it is the same
  UX as the system apps (the loop pauses while the keyboard is open).
- `ai.*` components need the `net` permission; `ai.vision` also `fs` (it reads
  the image file) and `mic.record` needs `mic`. The firmware allows one AI
  request at a time (chat and TTS share the slot) — the component shows the
  error in `errorKey` when it is busy.
- The copilot needs network access and an environment key on the machine
  running the Studio; it proposes ops only (never raw file writes) and CI tests
  it with a stub provider.

## Tests

```bash
node test/studio/run.js
```

Covers canonical JSON round-trips, GUID uniqueness, asset import/grid, the
spr 1.6 metadata (`anims`/fps/loop/hitbox), `tilemap.set`/resize (the painter
commit), atomic batches/dry-run/undo/redo, deterministic builds, the generated
app on the host harness (`E.spr.meta`/`animOf`/`box`, anchored HUD pixels,
frames differ when a script moves an entity), prefab flattening, and CLI x HTTP
equivalence, the native scene API (`settings.data`/`settings.assets`, `data`
component, `ctx.go` arg, `find`/`tm`/`solidAt`/`rectSolid`, per-tile solids and
`map.set` collision), build+headless run of all four `studio_games/` projects,
program mode (init --app, `app.json` without deps/psram, `app.data.js`, screen
scripts with events, toggle/slider/list state, Storage persistence, screen
navigation and header back, cross-runtime component validation, typed props
merge), the two `studio_apps/` examples (including `ai.chat` with
`input_audio`), the copilot (parser/guardrails/retry, hermetic HTTP with a stub
provider, CLI error path), and the legacy bridge (import-game, original E.run capture, `E.goto` scene
switch, package asset bases). CI runs it before the firmware matrix.
