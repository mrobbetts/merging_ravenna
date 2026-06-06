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

## API (summary)

- `new RavennaEngine({ host, path?, livenessMs?, backoff? })`
- `.connect()`, `.close()`
- `.setParam(moduleId, key, value, { channelIndex? })` — high-level, unit-aware, clamped
- `.setModuleOuts(moduleId, valueObj)` — mid-level
- `.publishSettings(path, value)` — raw escape hatch
- `.catalog`, `.tree`, `.capabilities`, `.online`
- events: `online, offline, status, settings, statusmsg, errors, tree, catalog, param, error`

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

Confirmed and inferred set-frame shapes live in `src/paths.js`. To add a parameter
(or support an Anubis monitor control), capture one set frame from the device web UI
and add a descriptor there — no engine changes needed.

## License

MIT
