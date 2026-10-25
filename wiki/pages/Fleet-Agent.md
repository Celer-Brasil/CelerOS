# Fleet agent

**English** | [Português (BR)](/Celer-Brasil/CelerOS/wiki/Agente-de-Frota)

`celeros.agent` is the optional system app that turns a CelerOS board into a
managed node: it runs `service.js` in the background (API 50), reports a
heartbeat to a control plane and applies signed OTA, app updates, a reboot or
a diagnostic request. It ships in the factory image of every board and is
disabled until a `/local/celercloud.json` exists.

The agent is public (the [CelerOS repository](https://github.com/Celer-Brasil/CelerOS/blob/main/data/apps/Celer%20Agent));
the control plane is a separate service. The contract is the `celeros.cloud`
dependency and the JSON below — any server that speaks it can manage a fleet.

## What it reports

Every heartbeat carries the firmware version/API (filled by
`celeros.cloud` from `System.getOSVersion()`/`getAPILevel()`), board, uptime,
the installed app inventory and capability flags:

| Cap | Meaning |
|---|---|
| `agent` | this app is running |
| `ota` | the firmware can start an OTA |
| `ota_signed` | the firmware verifies the ECDSA P-256 manifest signature (CelerOS 1.11.6+) |
| `apps` | it can update installed apps from the hub |
| `reboot` | it can reboot the device |
| `private_hub` | a private-store read token is present (`/local/hub_token.txt` or `hubToken` in the config) |

A control plane should use `ota_signed` to warn about older firmware, not to
block the first upgrade: a board on 1.11.5 can still receive the signed 1.11.6
image, and from then on every manifest is authenticated.

## Commands

The control plane enqueues a command; the agent acks only the types it owns
(`open`/`close` belong to the vertical app, not to the agent):

| Type | What it does |
|---|---|
| `os_update` | `System.otaCheck` → `System.otaStart` with the device's channel manifest; a rejected manifest is a failed ack |
| `update_apps` | `{packages:[pkg]}` or all apps: resolve the hub, download `app.zip`, check the MD5, `System.installZip`, rewrite `deps.json` |
| `self_update` | updates `celeros.agent` itself and calls `Service.stop()`; the next boot runs the new code |
| `reboot` | reports and restarts |
| `sync` | forces an immediate heartbeat |
| `diagnostics` | returns firmware/API/board/RAM/Wi-Fi/apps/OTA state in the event |

Commands are persisted in `/local/cloud_commands.json` until ack, so a network
drop or reboot does not lose them. The agent processes one command at a time;
`updateBusy`/`shellActive`/Wi-Fi are gates, while a foreground app does not
block an explicit update.

## Security

* The OTA manifest is ECDSA P-256 signed; the device checks the signature and
  the stream SHA-256 before switching slots. HTTPS manifests without a valid
  signature are refused. The private key is not in the repository.
* App packages are fetched only from the configured hub, with MD5 verified
  before the atomic `installZip`; the private-store token is attached only to
  URLs of that hub.
* The service inherits the app's declared permissions (`net`, `fs`,
  `system`) and the owner's grants; OTA/install/reboot require `system`.
* The device secret is never logged or sent in events; the control plane only
  sees its hash.

## Setup

1. Flash a CelerOS image that includes `Celer Agent` (1.11.0+; API 50).
2. Grant the app: `celerctl shell "grant Celer Agent"`.
3. Write `/local/celercloud.json` from the control plane enrollment:

```json
{
  "url": "https://<project>.supabase.co",
  "key": "<publishable key>",
  "tenantId": "<tenant uuid>",
  "deviceId": "<device id>",
  "secret": "<one-time device secret>",
  "kind": "totem",
  "heartbeatMs": 60000
}
```

4. Optional private store: write the read token to `/local/hub_token.txt`
   (one line, scope `private`, same tenant).
5. Check: `celerctl shell "svc list"` shows `Celer Agent` running; the next
   heartbeat fills `caps`/`apps` in the control plane.

## Bench evidence (2026-10-25)

* 1.11.5 installed a signed 1.11.6 local manifest; the control plane saw
  `agent.os_update.done` on the new boot.
* 1.11.6 refused a 1.11.7 manifest with an invalid signature without fetching
  `firmware.bin`; the command was acked as `agent.command.failed` and the
  board stayed on 1.11.6.
* The same board fetched the hub manifest over HTTPS and logged
  `manifesto assinado: assinatura confere`.
* `self_update` 1.0.0→1.0.3 and a private app 1.0.0→1.0.1 were installed with
  `deps.json` preserved.

See the [JS API](/Celer-Brasil/CelerOS/wiki/JS-API) section 50 for the svchost
surface and [OTA updates](/Celer-Brasil/CelerOS/wiki/OTA-Updates) for the
manifest format.
