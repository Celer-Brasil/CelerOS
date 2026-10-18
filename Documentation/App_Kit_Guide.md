# CelerKit — shared modules for general apps (the `celeros.app.*` family)

CelerKit is to general (non-game) apps what CelerGame is to games: an
opinionated core plus small optional modules, distributed as **shared
dependencies** (API 30+). One `require` decorates a single `A` object —
the require cache makes `celeros.app` a singleton, and every module of the
family attaches to the same object:

```js
var A = require("celeros.app");
require("celeros.app.fmt");          // optional module, decorates A.fmt
A.run({ main: function (c) { /* ... */ } }, "main");
```

| dep | stripped | what it gives the app |
|-----|---------:|-----------------------|
| `celeros.app` (core) | 3.5 KB | theme/layout cache, screen loop with a stack (`A.run`), overlays (busy/progress/result/wifi-wait), polling ticker |
| `celeros.app.fmt` | 1.4 KB | bytes/uptime/duration/date formatting in the system's exact formats |
| `celeros.app.path` | 0.9 KB | base/dir/ext/stem/join/safeName |
| `celeros.app.semver` | 2.2 KB | version compare, `^` ranges, transitive dep resolution (same algorithm as the store) |
| `celeros.app.data` | 0.9 KB | JSON files and NVS blobs with try/catch, staleness-stamped caches |
| `celeros.app.history` | 0.8 KB | persistent ring with consecutive-dedup (command/chat history) |
| `celeros.app.net` | 1.4 KB | getJSON/getText that never throw, blocking retry with backoff, download + MD5 |
| `celeros.app.caps` | 1.0 KB | one cached probe: board, screen, PSRAM, mic/camera/BT/phone presence |
| `celeros.app.events` | 1.9 KB | event bus (on/once/off/emit, wildcard, priorities) |
| `celeros.app.text` | 0.8 KB | Latin-1 sanitizer and a ready scrollable text reader |
| `celeros.app.input` | 2.0 KB | docked keyboard session + the input line (caret, tail, placeholder, topbar chips) |
| `celeros.app.form` | 3.3 KB | settings screen from row builders (info/toggle/choice/picker/action), picker, validated askNum |
| `celeros.app.list` | 1.2 KB | stamp-cached lists, pre-keyed stable sort, badge colors, RSSI bars |
| `celeros.app.launch` | 2.1 KB | installed-app scan (first seen wins), state rows against a hub catalog, open app |
| `celeros.app.ai` | 2.8 KB | AI.chat client: transient retry (502/504/429), busy flag, persisted history, Latin-1 output |
| `celeros.app.chat` | 2.2 KB | chat transcript: measured bubbles, inertial scroll following the tail, thinking bubble |
| `celeros.app.updater` | 2.8 KB | update check against a hub catalog, deps promotion into `/local/modules`, install flow |
| `celeros.app.fsx` | 2.8 KB | staged package install (.new + MD5 + batch rename), single-zip blob (API 42), ensureDir/treeSize |
| `celeros.app.svc` | 1.4 KB | background service kit (API 42): policy gates, drain cap, persisted state, notify-once |
| `celeros.app.mesh` | 2.2 KB | app protocol over CelerNet: family prefix, req/resp with nonce, replay dedup, TTL cache |
| `celeros.app.kit` | 0.3 KB | bundle of the 8 common modules (sidesteps the hub's 8-dep ceiling) |

The whole family is ~38 KB stripped; the `kit` closure is ~14 KB. Every
module declares its own `version` and registers a unique name in `A._mods`.

## The core contract (`celeros.app`)

`A.init()` caches the theme (`A.T`) and the fixed virtual layout (`A.L`:
x=8, w=224, top=48, bottom=312, cx=120). `A.run(screens, first, opts)` owns
`UI.begin/UI.end`; a screen only draws and **returns**:

- `undefined` — stay on this screen;
- `"name"` — push the current screen and open `name`;
- `A.BACK` — pop the stack (empty stack exits the app);
- `A.EXIT` — exit immediately.

The ctx passed to each screen is `{ full, now, entered }`; `entered` is
true only on the screen's first frame (lazy load, scroll reset). Per-screen
fps: attach `.fps` to the screen function. Overlays (`A.busy`, `A.progress`,
`A.error`, `A.ok`, `A.wifiWait`) draw the chrome so the app doesn't have to;
`A.every(ms, key)` is the polling idiom (timers are scarce — the harness
caps the pool at 8, the firmware too).

## Services (API 42) and vendoring

Background services are compiled outside the app loader and do **not** load
the shared-deps table. To use kit modules in a `service.js`, vendor the
files into the app folder (`celeros.app.js` + `celeros.app.svc.js`): the
require precedence (app-local first) makes both `main.js` and `service.js`
load the same vendored copy. `app_lint` warns about vendoring — that is
expected for services.

## Publishing a kit module

```bash
node tools/sdk/celer.js publish-dep tools/sdk/engine/celeros.app.js --min-api 30
# per module; celeros.app.svc uses --min-api 42 (policy gates are API 42)
python3 tools/celerhub.py deps-status     # must come back clean
```

Edges live in `tools/sdk/engine/index.json` (publish-dep inherits them for
files in that directory; the harness and `celerctl --deps-local` resolve the
same closure). Ranges are `^x.y.z` (same major, >= base) or exact.

## App scaffolding

`node tools/sdk/celer.js new --appkit Nome` scaffolds an app with the kit
deps in `app.json` and copies the family `.d.ts` files (dev-only; publish
excludes them). With TypeScript-style editors, drop the `.d.ts` of the
modules you adopt next to your project — they augment `declare namespace A`.

## Conventions every module follows

- ES5 only (Duktape); no allocation in draw paths; preallocated scratch.
- Comments in Portuguese (no accents); UI strings may use accents.
- Exactly one `version: 'x.y.z'` literal per file (the hub rejects two).
- `test/sdk/celerosapp_r1.js` gates the family: d.ts + index entry per
  module, both guide languages cite every module, size budget, stripped
  line-number parity, and d.ts member coverage.
