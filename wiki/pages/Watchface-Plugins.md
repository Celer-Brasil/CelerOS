# Watchface plugins

[English](/Celer-Brasil/CelerOS/wiki/Watchface-Plugins) | **Português (BR)**

Since **API 16**, installed apps can place a widget on the CelerOS
watchface. The first store app to do it is **Previsao** (weather forecast):
once downloaded, it installs a plugin that shows the temperature, condition
and today's min/max right on the watch — and tapping the line opens the full
app.

## How it works

The watchface is a JS app (`celeros.watchface`). Every 30 seconds it
rescans two sources and loads up to **2 plugins**:

1. `<app folder>/watchface.js` — for full-folder installs (system image,
   `celerctl push`, SD installer);
2. `/local/data/<packageName>/watchface.js` — the app's private appData.
   This is the path the **store** uses: it installs only
   `main.js`/`app.json`/icon, and writing into another app's folder would
   require the system capability. The plugin travels **inside `main.js`** as
   a string and the app writes it into its own appData on first run —
   installing the app *is* installing the plugin; uninstalling removes both
   (appData is wiped with the app).

A plugin that fails to evaluate or to draw is evicted (and quarantined until
the next scan) — it **never takes the watch down**. Plugins run **inside the
watchface** and inherit its permissions (it is a system app): only install
plugins from authors you trust — the same rule as any app.

## Plugin contract

The `watchface.js` file is evaluated inside a function and ends with a
`return`:

```js
// inside a plugin you get the same environment as an app: System, FS, Storage...
var T = System.theme();
var data = null;
return {
    id: "my.plugin",                     // unique; deduped across sources
    sig: function () { return "..."; },  // opt.: cheap string; change = redraw
    line: function () { return "text"; },          // plain text, or...
    draw: function (x, y, w, h, bg) { /* ... */ },  // ...custom drawing
    open: "my.app"                       // opt.: tap the line to open the app
};
```

- The widget band sits above the footer (**digital** and **analog** styles;
  the **minimal** style stays clean on purpose). Each line is 168x22 px in
  the 240x320 virtual space; with 2 plugins the seconds track steps aside.
- `draw(x, y, w, h, bg)` receives the line rectangle; with a wallpaper, `bg`
  is the pill color (draw it before your text); without, it is `null`.
- `sig()` runs every tick (~150 ms): keep it cheap. Read files at most once
  a minute (the Previsao plugin throttles like that).
- Tapping a line with `open` calls `System.launchApp` (API 16): the watch
  exits through the clean path and the launcher opens the target app.

## Writing an app with a plugin

The app-side skeleton (full version in `hub_apps/Previsao/main.js`):

```js
var DATA = FS.appData();                       // /local/data/<pkg>/
var PLUGIN_SRC = [ "/* the same JS as above */" ].join("\n");
function instalaPlugin() {
    if (FS.readTextFile(DATA + "watchface.js") === PLUGIN_SRC) return;
    FS.writeTextFile(DATA + "watchface.js", PLUGIN_SRC);   // idempotent
}
instalaPlugin();
```

Rewrite the file when the plugin changes (the string comparison handles it:
it only writes when different). The app keeps the widget data in its appData
(e.g. `forecast.json`) and the plugin reads it — the watchface is a system
app and can see every app's appData.

## References

- `data/apps/Watchface/main.js` — loader and widget band
- `hub_apps/Previsao/` — the first plugin, end to end
- [JS API](/Celer-Brasil/CelerOS/wiki/JS-API) — `System.launchApp` (API 16)
