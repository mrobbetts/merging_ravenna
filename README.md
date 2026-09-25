# merging-ravenna

A small, standalone Node.js client for **Merging Technologies** RAVENNA devices
(Hapi, Horus, Anubis) that speaks their web-UI control protocol — CometD/Bayeux
over WebSocket — directly. No Node-RED, no browser, no extra services.

> **Unofficial.** This library was built by observing the device's own web
> interface traffic. It is **not affiliated with or endorsed by Merging
> Technologies**, and the protocol is undocumented and may change between
> firmware versions. Use at your own risk; always keep a way to restore settings.

## Install

```sh
npm install merging-ravenna
```

## Quick start

```js
const { RavennaEngine } = require('merging-ravenna');

const eng = new RavennaEngine({ host: '192.168.0.146' });

eng.on('online',  () => console.log('device up; catalog:', eng.catalog.length, 'params'));
eng.on('offline', (reason) => console.log('device down:', reason));
eng.on('param',   (p) => console.log('changed', p.moduleId, p.key, '=', p.value));

eng.connect();

// Set D/A (module 60) output gain to -20 dB. Value is dB; clamped to device range.
eng.setParam(60, 'attenuation', -20);
```

## Why it is resilient

A quiet device is not a dead one: after `livenessMs` of silence the engine sends an
update request and only declares the device stale if that goes unanswered for
`probeGraceMs` (a VAD without a PTP clock pushes no status at all, yet answers).


The engine handles two failure modes differently:

- **Socket drop / device powered off** → exponential-backoff reconnect
  (`2s, 5s, 15s, 30s` capped), retrying forever.
- **Device wedged but socket still open** → a **data-liveness watchdog**: the
  device emits `/ravenna/status` about every 2s, so if no frame arrives within
  `livenessMs` (default 7s) the connection is declared stale, torn down, and
  re-established.

`online` / `offline` are **edge-triggered** (emitted once per transition), and
every successful (re)connect re-runs the handshake and full state fetch — so
after a power-cycle (which rotates the device's `clientId`), state is always
re-read from the device rather than assumed.

## Discovery

On every full state update the engine builds a flat **catalog** of settable
parameters by reading the device's own capability metadata — so it enumerates
whatever modules/cards a given Hapi/Horus/Anubis actually has:

```js
eng.on('catalog', (cat) => {
  // [{ moduleId, moduleName, section, key, value, unit, min, max, step, enum, settable, confidence }, ...]
});
```

`confidence` is `confirmed` (set-frame verified on a real device), `inferred`
(derived from the state shape; very likely correct), or `unknown`.

Enum parameters (e.g. `roll_off_filter`, `out_max_level`) accept **either a label
string or the raw integer** — `setParam(60, 'out_max_level', '+24 dBu')` and
`setParam(60, 'out_max_level', 1)` are equivalent (label match is case-insensitive).

## System domain (clock, PTP, sync, health)

Beyond the per-module audio controls, the engine also models the device-wide
**system** domain — sample rate, frame size, clock source, PTP, temperature,
uptime, and assorted device flags — read from the parts of the state tree the
audio catalog doesn't cover:

```js
eng.on('system', (snap) => {
  // [{ key, label, group, unit, value, raw, enum, settable, readonly, note }, ...]
  // e.g. { key:'sample_rate', value:'44.1 kHz', raw:44100, enum:{'48 kHz':48000,...}, settable:true }
});

eng.getSystem();                       // current snapshot (groups: Clock/Sync/PTP/Device/Health/Advanced)
eng.getSystemValue('sample_rate');     // one entry by key

// Set a system param by label or raw value. Clock/rate changes RE-CLOCK the device,
// so do these with audio off:
eng.setSystem('sample_rate', '48 kHz');    // or 48000
eng.setSystem('sync_source', 'Internal');  // or the raw input id
eng.setSystem('frame_size', 32);

// Generic raw access to any part of the tree:
eng.getTree();                         // last full settings tree
eng.getSubtree('network.PTP.Status');  // any subtree by dotted / $ path
```

Settable system params are **hardware-confirmed** by `scripts/probe-system.js`
(set → re-read → restore, behind a meter-silence gate). Pure telemetry (PTP lock,
temperature, uptime) is marked `readonly` and never settable. Some params carry a
`note` describing a dependency (e.g. PTP priorities apply only in manual-grandmaster
mode). Use `scripts/discover-system.js` (read-only) to dump the system tree on
unfamiliar firmware.

Between full settings trees the device speaks in patches, and the engine folds every
shape seen on hardware into its tree, re-emitting `system` when a reading changed: pathed
pushes on either channel (`$.network.PTP.Status` every couple of seconds, `$.ios`,
`$.network.PTP`, a module by id `$._modules[?(@.id==2)][0]` — merged, never replaced),
a one-key settings echo at `$` (`{ _auto_sample_rate: false }` — merged, not taken for a
tree), and the periodic reduced status `$` (only per-module health `state` is folded;
its stripped modules never touch capabilities). Only a settings `$` carrying `_modules`
is ingested as the authoritative tree.

## API (summary)

- `new RavennaEngine({ host, path?, livenessMs?, backoff?, meters? })` — `host` accepts `ip` or
  `ip:port`. Hardware serves on port 80; the Merging Virtual Audio Device (macOS/Windows)
  speaks the same protocol on `<machine-ip>:9090` (LAN IP only, system domain + subtrees
  but no audio modules). `meters: true` subscribes `/ravenna/meter` on every (re)connect
  and emits each frame (~10/s) as a `'meter'` event — for continuous metering consumers
  (decode with `RavennaEngine.meterLevelsFor` / `dbFromLevel`)
- `.connect()`, `.close()`
- `.setParam(moduleId, key, value, { channelIndex? })` — high-level, unit-aware, clamped; enums accept a label or int
- `.setModuleOuts(moduleId, valueObj)` — mid-level
- `.publishSettings(path, value)` — raw escape hatch
- `.setSystem(key, value)` — set a system-domain param (clock/PTP/sync/flags) by label or raw value
- `.getSystem()`, `.getSystemValue(key)` — modeled system snapshot
- `.getTree()`, `.getSubtree(path)` — raw last tree / any subtree by dotted-or-`$` path
- `.catalog`, `.tree`, `.capabilities`, `.online`
- events: `online, offline, status, settings, statusmsg, errors, tree, catalog, param, system, meter, error`

## Testing

```sh
npm test            # hermetic: catalog + watchdog + meter + feedback logic, no device needed
MERGING_HOST=192.168.0.150 npm run validate                       # read-only: discover catalog + write a JSON report
MERGING_HOST=192.168.0.150 MERGING_I_UNDERSTAND=1 npm run validate # write-validate (audio OFF): set->re-read every param, restore
```

The hermetic suite includes a fake-clock watchdog test that simulates a power
cycle and asserts the backoff schedule and the single online/offline transitions.
`npm run validate` (`scripts/validate-device.js`) discovers every settable parameter,
and — with `MERGING_I_UNDERSTAND=1`, audio off — validates each by SET→RE-READ: it
sets the value, re-reads the device to confirm it applied, restores the original, and
writes a JSON report (device fingerprint, per-param verdicts, unmodeled leaves) you can
share. A meter pre-flight gate aborts if any output is passing audio.

## Extending to new parameters / devices

Confirmed and inferred set-frame shapes for the **audio** params live in `src/paths.js`.
To add one (or support an Anubis monitor control), capture a set frame from the device
web UI and add a descriptor there — no engine changes needed. **System**-domain
descriptors (their read path, unit, enum source, and confirmed write shape) live in
`src/system.js`; use `scripts/discover-system.js` to dump an unfamiliar device's tree
and `scripts/probe-system.js` to confirm new write shapes.

## License

MIT
