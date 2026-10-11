# components/ - ESP-IDF component layer

## OVERVIEW
Everything in `components/` is built and CelerOS-owned: it descends from the old shared `esp_components` lib (satisfaction-hub) with CelerOS-only patches. The unbuilt remainder was removed from the tree (2026-10; git tag `archive/esp_components` keeps it). Adoption map and CelerOS patch list: `README.md` (Portuguese, authoritative).

## BUILD MEMBERSHIP
| Component | Role |
|-----------|------|
| `Network` | Radio owner (`NetworkManager`), STA (`WifiConnection`), AP + captive portal, NVS credential store. Merged from the old `Connection` + `Wifi` (they required each other in a cycle). Own AGENTS.md |
| `Http` | `HttpClient` GET/POST/download with progress; used by OTA and JS `Net.*` |
| `System` | `SystemInfo`; backs JS `System.getInfo` |
| `Storage` | Only the `NVS` class is compiled |
| `Utility`, `ErrorCodes` | `Event<>` (type-erased `EventBase` core), `Timeout`, `ErrorCode` registry |
| `duktape` | Duktape 2.7.0, regenerated from `celeros_duk_config.yaml` (ES5-lean) |
| `LovyanGFX` | Upstream submodule; board config lives in `main/Boards/<board>/` |

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| WiFi connect/roaming/scans | `Network/NetworkManager.*` | Singleton; background task; `NETWORK_MANAGER.md` |
| Saved WiFi credentials | `Network/NetworkCredentialStore.*` | Per-field NVS keys; legacy pipe format read-only |
| Pub/sub | `Utility/Event.h` | Header template; one shared static mutex, fixed 16-handler array |
| Error codes | `ErrorCodes/ErrorCode.*`, `CommonErrorCodes.h` | One `<Category>ErrorCodes.{h,cpp}` pair per domain |
| Change JS engine features | `duktape/celeros_duk_config.yaml` | Regenerate `duktape.c`/`duktape.h`/`duk_config.h` with the recipe in the YAML header (configure.py needs Python 2.7) |
| Revive archived code | tag `archive/esp_components` | `git show archive/esp_components:extras/esp_components/<name>`; copy in, satisfy its `idf_component.yml`, maybe re-enable exceptions |

## CONVENTIONS
- Registry deps only in `idf_component.yml`; sibling deps in CMake `REQUIRES`, never `path:` entries.
- Singletons: hand-rolled `static X& instance()` (the old `Singleton<T>` base was removed — zero users); construction at first `init()`.
- Events: `Event<Args...>` with `addHandler` / `removeHandler` / `trigger`.
- Fallible ops return `ErrorCode`, not raw `esp_err_t`.
- Flat layout: sources and headers in the component root (`INCLUDE_DIRS "."`).
- Built with `-fno-exceptions` (`CONFIG_COMPILER_CXX_EXCEPTIONS` off): no `try`/`catch`/`throw`, no `std::stoi`-style throwing parsers on untrusted input; use `strtol` + end-pointer checks.

## ANTI-PATTERNS
- NEVER do real work inside an `Event` handler: `trigger()` holds the event mutex for the whole handler loop. Handlers set flags; the owner's loop acts.
- NEVER hand-edit `duktape/duktape.c` or `duk_config.h`; they are generated. Change the YAML and regenerate. Board-dependent switches go in `duktape/celeros_fixup.h` (embedded at generation via `--fixup-header-file`); when Python 2.7 is not at hand, mirror the same block into the "Fixups" section of `duk_config.h` (that is byte-for-byte what regeneration produces) — done 2026-10-09 for `DUK_USE_CACHE_ACTIVATION`/`CATCHER` on `CONFIG_SPIRAM` boards (the YAML keeps them off for the CYD's RAM; measured on the SmartDisplay: JS call 16 -> 7 us, native call 23 -> 15 us).
- NEVER add ES6+ builtins back to Duktape "just in case": apps are ES5 and every builtin costs flash on the CYD.
- Do not "sync" `Network/` from upstream `esp_components` blindly: `CaptivePortal`, `WifiAP`, `WifiConnection`, `NetworkCredentialStore` carry CelerOS-only patches (see `README.md`).
- Never reintroduce the old `esp_components` config: its `supabase_config.h` carries a leaked Supabase service_role key (see SECURITY in the root `AGENTS.md`). Secrets never live in source.

## NOTES
- No unit tests in any component. Verify by building both boards and running on hardware.
- Size budget: `python3 tools/size_report.py [--baseline f]` after building; fails when an OTA slot has < 64 KB free.
