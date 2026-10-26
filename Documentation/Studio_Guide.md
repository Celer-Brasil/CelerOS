# Celer Studio — game editor for CelerGame

Celer Studio is a Unity-style editor for CelerGame, the ES5 game engine shipped
as `celeros.game.*` dependencies. It is **file-first**: the project, scenes,
prefabs and asset metadata are plain JSON on disk, and every action is a JSON
command on a single bus used by the GUI, the CLI and the HTTP API. An AI agent
can build a whole game without opening the browser.

- Location: `tools/studio/` (SDK command `node tools/sdk/celer.js studio ...`)
- GUI: local web app served by Node (no build step, no npm dependencies)
- Output: a flat CelerOS app package (ES5, ready for `celerctl`/hub)

## Quick start

```bash
# 1. create a project (creates a starter scene)
node tools/sdk/celer.js studio init ~/Jogo --name "Meu Jogo"

# 2. open the editor (hierarquia, inspetor, viewport, play)
node tools/sdk/celer.js studio ~/Jogo serve --open

# 3. or drive it headless
node tools/sdk/celer.js studio ~/Jogo describe --json
node tools/sdk/celer.js studio ~/Jogo validate
node tools/sdk/celer.js studio ~/Jogo build
node tools/sdk/celer.js studio ~/Jogo run --ms 1200 --out tela.png
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
| `apply [FILE\|-] [--op JSON]` | run an op batch atomically (`--dry-run`, `--if-rev N`) |
| `validate` | schema, refs, package limits, ES5 lint |
| `build` | write the flat app package |
| `run` | build + run on the host harness (`--ms`, `--out`, `--frames 0,600`, `--seed`, `--no-build`) |
| `export DIR` | copy the build to a folder (`--force`) |
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
| `POST /api/command` | `{ops:[...], dryRun, ifRev}` or `{cmd:"build"\|"validate"\|"run"\|"play"\|"stop"\|"undo"\|"redo"\|"fmt"\|"export"\|"describe"}` |
| `POST /api/upload?name=&importer=&grid=&cols=&rows=&tw=&th=` | raw file bytes; imports via the same `asset.import` op |

Every command response includes `snapshot`, so a client can re-render without
a second round-trip. The GUI and the CLI exercise the same `lib/ops.js`; the
test suite proves they produce equivalent files.

## GUI tour

- **Hierarquia**: scene, entities, prefab instances (badge) and tilemaps.
- **Viewport**: pan with middle mouse or Space+drag, zoom with the wheel,
  drag entities with snap; grid, camera bounds, colliders and prefab children
  are drawn. `Fit` frames the scene.
- **Inspetor**: generated from the component schema. Entity transform,
  components, scene settings, camera, tilemaps and asset importers are all
  editable. JSON fields are validated on blur.
- **Assets**: drag files onto the panel (or use Importar), thumbnails,
  double-click a scene to open it, a script to edit it. The importer settings
  (slicing, pivot, color-key, `anims`/`fps`/`loop`, hitbox) are in the
  inspector; the preview draws the hitbox and the sprite anchor.
- **Tilemap painter**: select a tilemap, pick a tile in the palette (or the
  eraser) and click/drag in the viewport; right-click erases. The palette
  paints `data`, the "solido" checkbox also sets `solids`; the stroke commits
  as one `tilemap.set` on pointer-up. Changing cols/rows resizes preserving
  the top-left.
- **Play**: builds the package and starts the live emulator in an iframe
  (pause/step/restart/record/screenshot are the emulator's own controls).
- **Console**: harness logs, build diagnostics, lint errors, command results.
- **Command bar**: accepts the same JSON ops or `build`, `validate`, `run`,
  `play`, `stop`, `undo`, `redo`, `fmt`. This is the fastest way for a human
  or an agent to act without clicking.

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

## Deploy

```bash
# copy the flat package into a hub app folder (or any staging dir)
node tools/sdk/celer.js studio ~/Jogo export hub_apps/MeuJogo --force

# bench: install + run on the device
python3 tools/celerctl.py apps install hub_apps/MeuJogo --deps-local --run

# publish (bump version + changelog in celergame.project.json first,
# then build/export and run celerhub)
node tools/sdk/celer.js publish hub_apps/MeuJogo
```

OTA updates firmware only; the app package still ships through the store or
`celerctl`.

## Limitations (v1)

- The host preview is Node + firmware stubs, not Duktape on ESP32: ES5 is
  enforced by `app_lint`, but timing/memory/audio/network behavior belongs on
  the bench.
- The emulator models the 240x320 virtual canvas and the 480x480 native canvas;
  CYD/watch/dog layouts are not emulated.
- Sprite flip is not an engine feature; directional animation uses separate
  frames/regions.
- Runtime fidelity: the generated scene runner draws sprites with
  `scale = transform.sx` and **no rotation**; `rot` and a non-uniform `sy` are
  editor preview only (text/shape use their own components). Colliders exposed
  to scripts are axis-aligned.
- The package only includes graphic/audio assets referenced by a component,
  tilemap or scene music. An asset used only inside a script must also be
  referenced by a (possibly inactive) component so the build packs it.
- Prefab nesting is flattened at build time; the editor hierarchy is
  organizational (transforms are absolute, not inherited at runtime). The
  engine's `celeros.game.scene` data module is available to scripts when the
  project declares it, but the generated Studio runtime does not require it
  (prefabs are flattened, component behavior is the Studio runner).
- The tilemap painter is in the GUI; a visual atlas slicer (drag regions), an
  animation timeline and a dedicated prefab editing view are still phase 6
  (use `asset.set`/`component.set`/`op` batches until then).
- `music` on a scene is started with `System.playWav` on scene entry (one
  shot); v1 has no runtime mixer/loop control. The audio importer's `loop` and
  `gain` settings are stored in the `.meta` for tooling, not applied yet.
- Tilemap camera movement repaints the cells the camera exposes; huge maps
  should use a static camera or a baked background.

## Tests

```bash
node test/studio/run.js
```

Covers canonical JSON round-trips, GUID uniqueness, asset import/grid, the
spr 1.6 metadata (`anims`/fps/loop/hitbox), `tilemap.set`/resize (the painter
commit), atomic batches/dry-run/undo/redo, deterministic builds, the generated
app on the host harness (`E.spr.meta`/`animOf`/`box`, anchored HUD pixels,
frames differ when a script moves an entity), prefab flattening, and CLI x HTTP
equivalence. CI runs it before the firmware matrix.
