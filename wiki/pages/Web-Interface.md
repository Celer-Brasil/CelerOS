# Web interface

**English** | [Português (BR)](/Celer-Brasil/CelerOS/wiki/Interface-Web)

Every device with Wi-Fi connected runs a small web server. Open the IP shown
in the Web Server app (or in `celerctl info`) from any browser on the same
network to manage files, upload firmware and watch the live screen.

## Authentication

All pages are protected by HTTP Basic Auth:

* user: **admin**
* password: generated per device — shown in the Web Server app on the
  device or in `celerctl info` (`web_pass`).

The comparison is constant-time, and after several failed attempts the
server answers `429 Too Many Requests` for 30 seconds. Traffic is plain
HTTP on your LAN — treat the password accordingly.

## Pages

| Route | What it does |
|---|---|
| `/` | File manager: browse/create/upload/download/delete files and edit text on LittleFS (`/local`) and SD (`/sd`) |
| `/update` | Firmware upload page (same flow as Settings → System Updates) |
| `/screen` | Live screen mirror with remote touch (see below) |

## Live screen (`/screen`)

The mirror polls `/api/screen`, which returns one RLE-compressed RGB565
frame. On the device, the frame is read directly by the UI task a few rows
at a time at safe points — the screen keeps running smoothly while
someone watches. Expect ~1–2 fps on the CYD and noticeably more on the
SmartDisplay (bigger bus, PSRAM).

The page has **Pause** and **Zoom 2x** buttons, and clicking-and-dragging
on the canvas sends touches to the device through the same queue as
`celerctl tap` — the browser touch counts exactly like a finger. This is
also a practical way to operate the CYD's small resistive targets.

For custom scripts there is also the raw endpoint:

```bash
# one frame (u16 w + u16 h + u8 fmt + RLE pairs {u16 count, u16 rgb565}, LE)
curl -u admin:<password> http://<device-ip>/api/screen > frame.bin

# inject a touch (requires the X-Celer-Request header)
curl -u admin:<password> -X POST -H "X-Celer-Request: 1" \
  "http://<device-ip>/api/touch?d=1&x=200&y=91"   # d=0 releases
```

## Turning it off

The server can be switched off from the Web Server app on the device
(`System.webState(false)`); it comes back automatically on the next boot
with Wi-Fi. When no credentials are stored, the device starts the
`CelerOS-Setup-XXXX` captive portal instead — see
[Troubleshooting](/Celer-Brasil/CelerOS/wiki/Troubleshooting).
