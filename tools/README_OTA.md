# CelerOS OTA updates

**English** | [Português (BR)](README_OTA.pt-BR.md)

CelerOS has two firmware update mechanisms, both ported from the
[satisfaction-hub](https://github.com/maikramer) concept and now native to
ESP-IDF:

1. **Updates channel OTA** — the device polls an `update.json`, compares
   versions and flashes the firmware by itself with a progress bar
   (Settings → System Updates → **INSTALL**).
2. **Web upload** — with the web server on, the file manager's `/update`
   page flashes a `firmware.bin` uploaded from the browser.

The partition tables (`partitions_16MB.csv` SmartDisplay and
`partitions_4MB.csv` CYD) already have `ota_0`/`ota_1` slots + `otadata`.
Flashing is done by `OtaManager::performUpdate`: the image is written to the
inactive slot and only activated after `esp_ota_end` validates the whole
image — if anything fails midway, the running system stays up. Since 1.8 the
download is **resumable**: a connection that drops is reopened with
`Range: bytes=N-` and continues from byte N (a server that ignores Range
answers 200 and the device skips the N bytes it already has); up to 6
consecutive failures with growing back-off. The channel OTA also takes the
`OtaGuard`, so it can no longer collide with a `celerctl ota push` or a web
upload on the same slot. Wi-Fi credentials survive updates: they live in NVS
(NetworkCredentialStore).

## update.json scheme (v2)

```json
{
  "version": "1.1.0",
  "api_version": 2,
  "major_update": true,
  "minor_update": false,
  "security_update": false,
  "changelog": "- Feature A\n- Feature B",
  "guide": "Tap INSTALL to update directly.",
  "firmware_url": "https://.../firmware.bin",
  "firmware_sha256": "64 hex chars",
  "firmware_signature": "128 hex chars (ECDSA P-256 r||s)"
}
```

- Without `firmware_url`, the update screen falls back to the legacy flow
  (changelog + manual guide only). With it, the **INSTALL** button appears.
- **HTTPS requires `firmware_signature`** (CelerOS 1.11.6+): ECDSA P-256
  over `version`, `api_version`, `firmware_sha256` and `variant`. The device
  verifies it against the public key embedded in
  `main/OTA/OtaPublicKey.h` and rejects missing/invalid signatures before
  downloading. HTTP local (with `/local/ota_allow_http.txt`) still accepts
  an unsigned manifest for the bench.
- A relative `firmware_url` (e.g. `"firmware.bin"`) resolves against the
  directory of the `update.json` itself — handy for local servers.
- Channel per board: `updates/esp32/update.json` (classic board),
  `updates/smartdisplay_4848S040/update.json` (SmartDisplay 4") and
  `updates/spotpear_zzpet/update.json` (robot dog). The base is
  `CELEROS_UPDATE_BASE` in `main/OTA/OtaManager.cpp`.
- **SKU "Y" (relays) caveat:** the SmartDisplay profiles with and without
  `CONFIG_CELEROS_SMARTDISPLAY_RELAYS` share the same channel
  (`smartdisplay_4848S040`). An OTA delivered to a relay SKU uninstalls
  `System.relay` support (the pins go back to I2S/speaker). Until a separate
  channel or a variant field in `update.json` exists, do NOT push
  speaker-variant firmware to relay devices.

## Publishing a release to the CelerOS Hub (official channel)

The canonical channel is the self-hosted hub: `https://os.celer.tec.br/updates`
(see `CELEROS_UPDATE_BASE` in `main/OTA/OtaManager.cpp`). Server repo:
`~/GitClones/CelerOS-Server` (denv stack `celeros-hub`).

```bash
idf.py -B build-cyd build    # or build-smartdisplay
python3 ~/GitClones/CelerOS-Server/tools/publish_firmware.py esp32 \
  build-cyd/CelerOS.bin --version 1.3.0 --changelog "- new thing X" \
  --token $CELER_HUB_TOKEN
# SmartDisplay 4": channel smartdisplay_4848S040
```

The publisher signs the manifest automatically with the private key in
`~/GitClones/CelerOS-Server/env/ota_signing_private.pem` (gitignored; back
it up — losing it means a new public key embedded by a firmware release).
`--signing-key` points to another key. `tools/ota_sign.py` signs a local
`update.json` (used by the LAN test) with the same canonical format.

Each channel's `update.json` (`esp32`, `smartdisplay_4848S040`) is generated
by the publish script; publishing without the `.bin` path updates the
manifest only (the device shows the news, without the INSTALL button). The
`updates/*/update.json` files in this repo remain as a legacy mirror of the
old GitHub channel.

## Testing on the LAN (without the hub)

```bash
idf.py -B build-cyd build
python3 tools/ota_server.py --board smartdisplay
```

To test the resume, `--drop-at BYTES` (repeatable) cuts the firmware
connection once at that offset and `--no-range` makes the server ignore
`Range` (200 from byte 0). The bench app `test/apps/OtaBench` runs the OTA
headless from a URL in `/local/otabench_url.txt`.

The server prints the URL to write into **`/local/ota_url.txt`** on the
device (via the web file manager or SD card). While that file exists it
overrides the official hub channel — delete it to go back to normal.
The published version comes from `CELEROS_VERSION`
(`main/CMakeLists.txt`); for the device to "see" the update, the published
version must be greater than the installed one.

Since 1.3 the OTA guard refuses plain `http://` URLs unless the opt-in file
**`/local/ota_allow_http.txt`** exists on the device (create an empty file
with that name — `celerctl push`, web file manager or SD card). HTTPS works
with no opt-in, which is why the production channel is unaffected.

## Testing over the USB cable (no network, no esptool)

With the board on the serial cable, `celerctl` flashes the firmware straight
into the inactive OTA partition and reboots:

```bash
python3 tools/celerctl.py -b 921600 ota push build/CelerOS.bin
```

After the reboot `celerctl ota push` checks that the board came up on the
written slot (`app_part` in `celerctl info`) and waits for the image to be
confirmed (30 s of healthy boot, `app_state` `pending` → `valid`); a bootloader
rollback is reported as an error. Since 1.8 it also: opens the serial port
exclusively (a second `celerctl`/monitor on the same port fails fast instead
of corrupting the stream), re-sends the window when the device's frame parser
resyncs on line noise (no more abort on `payload grande demais`), and
re-sends `OTA_END` when its answer is lost (the device confirms an
already-applied END again). A USB `HELLO` no longer steals the session of an
OTA running over Wi-Fi (`OTA em curso em outro canal`).

Details in [README_USBTOOL.md](README_USBTOOL.md).

## W8 migration (new partition table on the CYD) — cable reflash

W8 shrank the core (system screens became JS apps on LittleFS) and the CYD
table changed (`partitions_4MB.csv`): OTA slots 1.875 MB → 1.75 MB each and
LittleFS 128 KB → 384 KB. **OTA over the network does not rewrite the
partition table** — migrating a firmware with the old table is a one-time
cable operation:

```bash
idf.py -B build-cyd build
python3 -m esptool --chip esp32 -p /dev/ttyUSB0 -b 460800 write-flash \
  0x1000 build-cyd/bootloader/bootloader.bin 0x8000 build-cyd/partition_table/partition-table.bin \
  0xe000 build-cyd/ota_data_initial.bin 0x10000 build-cyd/CelerOS.bin
tools/flash_data.sh cyd /dev/ttyUSB0    # LittleFS: icons + system apps
```

After that, normal OTAs (network, web or `celerctl ota push`) work again
without the cable. The SmartDisplay 4" (16 MB) never changed tables.

System apps (Settings, App Store, Installer, Help, Web Server) now live on
LittleFS and are not touched by OTA — update them with
`celerctl apps install data/apps/<Name>` or from the App Store itself.

> Publishing 1.2.0 on the channel: the manifests under `updates/` stay at
> 1.1.0 until the CYD boards in the field have done the cable migration
> above (a new firmware with the old table would still fit the slot, but the
> 128 KB LittleFS cannot hold the system apps). When publishing, update
> `version`/`firmware_url` in the board channel manifest.

## Known limitations

- HTTPS downloads (manifest and firmware) validate the server certificate
  against the ESP-IDF CA bundle; plain HTTP requires the
  `/local/ota_allow_http.txt` opt-in since 1.3. There is no firmware
  signature yet (secure boot / signed images are future work).
- The ESP-IDF bootloader rollback IS enabled
  (`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y`): a new slot boots as
  `PENDING_VERIFY` and the main loop confirms it after 30 s of uptime
  (`confirmPendingOta` in `main/main.cpp`) — a crash-loop inside the first
  30 s rolls back to the previous slot automatically.
- Since 1.3 every web route — `/update` and the whole file manager included —
  requires HTTP Basic Auth (user `admin`, password generated on first boot;
  see it in the Web Server app or `celerctl info`). 5 wrong passwords lock
  the web server for 30 s. Write routes still require the `X-Celer-Request`
  header on top (defense in depth), e.g.
  `curl -u admin:<pass> -H 'X-Celer-Request: 1' -F 'update=@CelerOS.bin' http://<ip>/update`.
