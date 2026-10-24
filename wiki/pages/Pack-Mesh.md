# The pack: CelerNet mesh + roaming experiences

**English** | *Português: em breve*

CelerOS devices near each other form **one** system — a pack. The dog, the
SmartDisplay and the watch discover each other over BLE and cooperate with
**no connection at all**: messages cross the area by managed flooding, and
each member announces its **role** (speaker, mic, display, motors, leds,
network) so the others know what it can do for the pack.

## How it works

- **CelerNet (API 26)** — the transport: every node broadcasts
  non-connectable 31-byte advertising frames and repeats new ones it hears
  (TTL budget of hops). Presence every ~3 s, messages up to 434 bytes
  (fragmented), broadcast and unicast (API 27), redundancy in place of
  ACKs. It is infrastructure: survives app switches and reboots, state in
  the `celernet` setting.
- **Pack (API 27)** — the meaning: roles travel in the presence beat
  (derived from the board — no configuration), and the OS speaks typed
  envelopes over the mesh (unicast, deduplicated). The first envelope is
  the **roaming party**: the chiptune playing on one device moves to the
  member with a speaker and **resumes from the same millisecond**
  (`Pack.handoffMusic()`).
- **Matilha app** — the pack panel (system app, replaces the old CelerNet
  app): toggles the mesh, lists members with role/signal/age, sends direct
  or broadcast messages and passes the music along.

Only boards built with Bluetooth join the pack (SmartDisplay, robot dog,
Waveshare watch). The network is open (v1): the filter is the network name
(`celer` by default) — use it for telemetry and toy commands, not secrets.

## Apps that live on the mesh (App Store)

Open the same app on two or more Bluetooth boards — the relays in between
need no app at all (repeating is the OS's job).

| App | What it does with the mesh |
|-----|----------------------------|
| **Sonar** | Radar of the neighbourhood in rings of hops, real ping (RTT and loss, one packet, no copies masking it) and a census of who has the Sonar open (hops, battery, uptime). The tool for placing boards around the house. |
| **Batata Quente** | Hot potato between devices: the potato flies hand to hand by unicast (any number of hops), the fuse is secret and the beeps speed up. The "I've got it" broadcast is the ACK; a lost pass is resent and comes back after 3 tries. |
| **Mural** | House message board that reaches devices that were **off** when you wrote: each board keeps the posts and syncs with its neighbours using the Trickle algorithm (RFC 6206) — quiet when everyone agrees, fast when someone comes back. |
| **Sentinela** | Alarm made of your boards: a watch on the door (motion), the dog (noise) or any panic button rings every open Sentinela with the zone name, up to 8 hops away. Anti-tamper: an armed guard that **vanishes** from the air also rings. PIN to disarm. |
| **Coral** | Orchestra of devices: the conductor splits a song into voices (melody, harmony, bass, drums) across the boards with a speaker and they all come in together, discounting the per-hop latency. |
| **Detona!** | The bomberman goes versus: lobby with the Detona! boards nearby, invite and **best of 3 rounds in the same arena** — both screens build it from one shared seed. Only discrete one-frame events cross the air (cell moves, bombs fused to the owner's beat, kicks, deaths); each player is the authority over its own body. |
| **Pong Duplo** | (Celer Link, not the mesh) Pong across two screens side by side: the ball leaves the top of one and enters the other. Pairing by 6-digit code. |

Protocol design tips (16-byte packets, the `P` prefix the Pack swallows,
the TX queue) are in the JS API guide, section 31.

## Testing mesh apps without hardware

`node test/meshsim/run.js` runs the **real** app code on several simulated
nodes at once (one worker per node, a shared virtual clock): flooding with
TTL/hops and dedup, per-link signal and loss, the TX queue, presence that
expires and returns, Pack envelopes and the music handoff, and Celer Link
pairing. Scenarios script taps and prompts per node and check what each
screen drew and what crossed the air — see `test/meshsim/run.js`.

## Trying it on the bench

```
# on each board (shell via celerctl, or the Matilha app):
celerctl shell --run "..."   # CelerNet.start({}) once; state persists

# the party: play music on the dog (Dog Face music tool or any app),
# then hand it off — it continues on the nearest member with a speaker
Pack.handoffMusic()
```

See the [JS API guide](/Celer-Brasil/CelerOS/wiki/JS-API) sections 31–32 for
the full `CelerNet.*` and `Pack.*` reference.
