# Contributing

**English** | [Português (BR)](/Celer-Brasil/CelerOS/wiki/Contribuindo)

PRs go to `main` (PT-BR, descriptive commit messages are the house style).
Before opening one, the checklist below is what CI runs — and what a
reviewer will look at.

## Checklist

```bash
node test/js_harness/run.js          # JS harness (bundled apps, stubbed device APIs)
g++ -std=c++17 test/cpp/run_tests.cpp -o /tmp/celeros_tests && /tmp/celeros_tests  # host C++ tests
python3 tools/size_report.py         # flash cost — the CYD OTA slot is the binding constraint
```

CI ([`.github/workflows/build.yml`](.github/workflows/build.yml)) runs the
JS harness and the host tests on every push/PR and then builds the firmware
for all six boards in the official ESP-IDF container.

## Code conventions

* **ES5 only** in JS apps (`var`, `function`, no arrow functions) — see
  [System apps](/Celer-Brasil/CelerOS/wiki/System-Apps).
* Board `#ifdef`s live **only** in `main/Boards/<board>/`; compile-time
  differences between boards go in each board's `BoardTraits.h`.
* Comments, logs and CLI strings in Portuguese, without accents. Text
  shown on screen may use accents (fonts cover Latin-1: U+0020..U+00FF, no
  em dash, curly quotes or emoji). `tools/acentuar.py` restores accents
  inside string literals.
* Fallible operations return `ErrorCode` (`components/ErrorCodes`), not
  `esp_err_t`; singletons use `Singleton<T>` with a token ctor; `Event`
  handlers only set flags.
* New JS API = bump `CELEROS_API_LEVEL` in `main/CMakeLists.txt`, document
  it in **both** `JS_API_Guide` languages and add a stub to the harness.
* Memory is tight on the CYD (no PSRAM, no exceptions on the hot path): a
  `std::string`/`new` that cannot grow **aborts the device** — on the
  no-PSRAM path use malloc/realloc (see `HttpClient::setBodySink`).

## Documentation

* **This wiki is generated**: edit `wiki/` in the repo (manifest
  `wiki.json` + `wiki/pages/`), run `python3 tools/wiki/generate.py` to
  check, and commit — CI publishes on merge. Edits made on the web are
  overwritten.
* **Bilingual, English-first**: each hand-written page exists in English
  (canonical) and Portuguese (`Placas-Suportadas`, `Arquitetura`, ...).
  New page = write both, add both to `wiki.json` (page + sidebar, PT pages
  under the "Português (BR)" section) and cross-link the pair at the top.
* The reference guides live in `Documentation/` as `*.md` (EN) +
  `*.pt-BR.md` pairs and are reused by the wiki by path.

## Adding a board

Board profiles are small and self-contained — the steps are in
[Supported boards](/Celer-Brasil/CelerOS/wiki/Supported-Boards#adding-a-board).
Bring-up help is welcome (a photo of the board running CelerOS makes the
PR!).

## Reporting bugs

Open an [issue](https://github.com/Celer-Brasil/CelerOS/issues) with the
board, firmware version and API level (Settings → Sobre, or
`celerctl info`) plus a `celerctl logcat` excerpt — or a coredump
(`celerctl coredump`) if it crashed.
