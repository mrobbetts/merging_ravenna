'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');
const { buildCatalog } = require('./catalog');
const { checkCompat } = require('./compat');
const { moduleOutsPath, PARAMS, dbToTenths } = require('./paths');

/**
 * RavennaEngine
 * -------------
 * One resilient CometD (Bayeux) session to a Merging RAVENNA device over WebSocket.
 *
 * Resilience model (two distinct failure modes, handled differently):
 *  - socket drop / device power-off  -> exponential backoff reconnect, forever
 *  - device wedged but socket "open" -> data-liveness watchdog: if no frame
 *    arrives within `livenessMs`, declare stale, tear down, fall into backoff.
 *
 * The device emits /ravenna/status roughly every 2 s, so silence beyond ~7 s
 * is a reliable "gone" signal.
 *
 * online/offline are emitted ONCE PER TRANSITION (edge-triggered), so consumers
 * (e.g. a Stream Deck display) can react without being spammed.
 *
 * Events:
 *   'online'   ()          device reachable AND full state received
 *   'offline'  (reason)    device unreachable/stale; reason: 'timeout'|'closed'|'connect-failed'
 *   'status'   (str)       fine-grained: 'starting'|'open'|'handshaking'|'connected'|'stale'|'reconnecting'
 *   'settings' (data)      a /ravenna/settings broadcast { path, value }
 *   'statusmsg'(data)      a /ravenna/status broadcast { path, value }
 *   'errors'   (data)      a /ravenna/errors broadcast
 *   'tree'     (tree)      full state tree (path:"$")
 *   'catalog'  (array)     flattened parameter catalog (rebuilt on every tree)
 *   'param'    (entry)     a single changed parameter we could resolve from a settings echo
 *   'error'    (Error)
 */
class RavennaEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    const host = opts.host || '127.0.0.1';
    const path = opts.path || '/cometd/handshake';
    this.url = opts.url || `ws://${host}${path}`;
    this.origin = opts.origin || `http://${host}`;
    this.host = host;

    this.livenessMs = opts.livenessMs || 7000;          // staleness window
    this.backoff = opts.backoff || [2000, 5000, 15000, 30000]; // capped schedule
    this._backoffIdx = 0;

    // Meter calibration. The level integers are CONFIRMED linear amplitude
    // (see meterLevelsFor / dbFromLevel). `meterFullScale` is the integer that
    // maps to 0 dBFS: CONFIRMED 65535 (2^16-1, 16-bit unsigned) by feeding a 0 dBFS
    // tone to a RAVENNA input (meter read 65534). Overridable for other hardware.
    this.meterFullScale = opts.meterFullScale || 65535;

    // injectable for tests
    this._WebSocket = opts.WebSocket || WebSocket;
    this._setTimeout = opts.setTimeout || setTimeout;
    this._clearTimeout = opts.clearTimeout || clearTimeout;

    this.ws = null;
    this.clientId = null;
    this.msgId = 0;
    this.online = false;          // public: device reachable + state known
    this._closing = false;
    this._reconnectTimer = null;
    this._livenessTimer = null;

    this.tree = null;
    this.catalog = [];
    this.capabilities = {};
    this.compat = null;
  }

  // ---- lifecycle ----------------------------------------------------------

  connect() {
    this._closing = false;
    this._backoffIdx = 0;
    this.emit('status', 'starting');
    this._open();
  }

  close() {
    this._closing = true;
    this._clearReconnect();
    this._clearLiveness();
    try { if (this.ws) this.ws.close(); } catch (e) { /* ignore */ }
    this._goOffline('closed');
  }

  // ---- low-level send -----------------------------------------------------

  _nextId() { return String(++this.msgId); }

  _send(arr) {
    try {
      if (this.ws && this.ws.readyState === this._WebSocket.OPEN) {
        this.ws.send(JSON.stringify(arr));
      }
    } catch (e) { this.emit('error', e); }
  }

  // ---- CometD steps -------------------------------------------------------

  _handshake() {
    this.emit('status', 'handshaking');
    this._send([{
      version: '1.0', minimumVersion: '0.9', channel: '/meta/handshake',
      supportedConnectionTypes: ['websocket', 'long-polling', 'callback-polling'],
      advice: { timeout: 60000, interval: 0 }, id: this._nextId()
    }]);
  }

  _connectLoop() {
    if (!this.clientId) return;
    this._send([{ channel: '/meta/connect', connectionType: 'websocket', id: this._nextId(), clientId: this.clientId }]);
  }

  _subscribeAndSync() {
    this._send([
      { channel: '/meta/subscribe', subscription: '/ravenna/settings', id: this._nextId(), clientId: this.clientId },
      { channel: '/meta/subscribe', subscription: '/ravenna/status', id: this._nextId(), clientId: this.clientId },
      { channel: '/meta/subscribe', subscription: '/ravenna/errors', id: this._nextId(), clientId: this.clientId },
      { channel: '/service/ravenna/commands', data: { command: 'update' }, id: this._nextId(), clientId: this.clientId }
    ]);
  }

  // ---- public control -----------------------------------------------------

  /** Publish a raw { path, value } settings change. */
  publishSettings(path, value) {
    if (!this.clientId) return false;
    this._send([{ channel: '/service/ravenna/settings', data: { path, value }, id: this._nextId(), clientId: this.clientId }]);
    return true;
  }

  /** Publish a value object to a module's outs. */
  setModuleOuts(moduleId, valueObj) {
    return this.publishSettings(moduleOutsPath(moduleId), valueObj);
  }

  /** Ask the device to re-send the full state tree (fires a 'tree' event when it arrives). */
  requestUpdate() {
    if (!this.clientId) return false;
    this._send([{ channel: '/service/ravenna/commands', data: { command: 'update' }, id: this._nextId(), clientId: this.clientId }]);
    return true;
  }

  /**
   * Pull the per-channel level array for one module out of a /ravenna/meter frame.
   * Frame shape (confirmed from capture): data.value.state._modules is an array of
   * { id, type, meters: { ins?: {levels,levels_hold}, outs?: {levels,levels_hold} } }.
   * `levels` are non-negative integers; 0 == digital black.
   *
   * The integers are CONFIRMED to be LINEAR amplitude (not dB, not power). This was
   * proven from a live capture: the D/A (id 60, attenuation -40.0 dB) output meter
   * reads exactly floor(StreamInput * 0.01) channel-by-channel and frame-by-frame
   * (e.g. holds [19538,7074,18158,7086] -> [195,70,181,70]). The -40 dB attenuation
   * is a built-in known reference that fixes the slope: dB = 20*log10(level/fullScale).
   *
   * @param field 'levels' (instantaneous, default) or 'levels_hold' (latched peak).
   */
  static meterLevelsFor(frame, moduleId, section = 'outs', field = 'levels') {
    const mods = frame && frame.data && frame.data.value && frame.data.value.state
      && frame.data.value.state._modules;
    if (!Array.isArray(mods)) return null;
    const mod = mods.find((m) => m && m.id === moduleId);
    const sec = mod && mod.meters && mod.meters[section];
    return (sec && Array.isArray(sec[field])) ? sec[field] : null;
  }

  /**
   * Convert a linear meter level integer to dBFS.
   * Slope/linearity and the 0 dBFS reference are both CONFIRMED: a 0 dBFS tone read
   * 65534, so `fullScale` defaults to 65535 (2^16-1, 16-bit unsigned). Override for
   * other hardware. Returns -Infinity for level <= 0 (digital black).
   */
  static dbFromLevel(level, fullScale = 65535) {
    if (!(level > 0)) return -Infinity;
    return 20 * Math.log10(level / fullScale);
  }

  /**
   * Best-effort metering sample, used as a pre-write safety gate.
   *
   * Subscribes to the confirmed /ravenna/meter channel (auto-publishes ~every 100ms)
   * and watches instantaneous `levels` for the gated module across the window. The
   * go/no-go is based on instantaneous levels (currently-flowing audio), NOT
   * `levels_hold`, which is a latched peak that can reflect audio from before the
   * sample and would cause false aborts. The latched hold IS surfaced as `maxRawHold`
   * for operator context ("a peak was here recently").
   *
   * Resolves: { confirmed, silent, maxRaw, maxRawHold, maxRawAnywhere, maxDb, fullScale, raw }
   *   confirmed false -> no meter frame arrived; silent is null (callers MUST fail-safe)
   *   confirmed true  -> silent === (maxRaw === 0); maxDb is the gated module peak in dBFS
   */

  sampleMeters(windowMs = 1500, { moduleId = 60, section = 'outs' } = {}) {
    return new Promise((resolve) => {
      const raw = [];
      let maxForModule = 0;          // peak instantaneous integer for the gated module
      let maxHoldForModule = 0;      // peak latched-hold integer for the gated module
      let maxAnywhere = 0;           // peak instantaneous integer across ALL meters (informational)
      let sawFrame = false;
      const peakOf = (arr) => (Array.isArray(arr) ? arr.reduce((a, b) => (b > a ? b : a), 0) : 0);
      const onRaw = (m) => {
        if (!m || m.channel !== '/ravenna/meter') return;
        sawFrame = true;
        raw.push(m);
        const mods = m.data && m.data.value && m.data.value.state && m.data.value.state._modules;
        if (Array.isArray(mods)) {
          for (const mod of mods) {
            for (const sec of ['ins', 'outs']) {
              const meters = mod && mod.meters && mod.meters[sec];
              if (!meters) continue;
              const peak = peakOf(meters.levels);
              if (peak > maxAnywhere) maxAnywhere = peak;
              if (mod.id === moduleId && sec === section) {
                if (peak > maxForModule) maxForModule = peak;
                const hold = peakOf(meters.levels_hold);
                if (hold > maxHoldForModule) maxHoldForModule = hold;
              }
            }
          }
        }
      };
      this.on('raw', onRaw);

      // Subscribe to the confirmed meter channel. auto_publish_vumeter is on by
      // default, so frames should already be flowing once subscribed.
      try {
        if (this.clientId) {
          this._send([{ channel: '/meta/subscribe', subscription: '/ravenna/meter', id: this._nextId(), clientId: this.clientId }]);
        }
      } catch (e) { /* ignore */ }

      this._setTimeout(() => {
        this.off('raw', onRaw);
        if (!sawFrame) {
          // No meter frames arrived -> cannot confirm silence. Fail safe.
          resolve({ confirmed: false, silent: null, maxRaw: null, maxRawHold: null, maxRawAnywhere: null, maxDb: null, fullScale: this.meterFullScale, raw });
          return;
        }
        resolve({
          confirmed: true,
          silent: maxForModule === 0,        // 0 == digital black; instantaneous decides go/no-go
          maxRaw: maxForModule,              // peak instantaneous linear level for the gated module
          maxRawHold: maxHoldForModule,      // latched peak-hold (may predate the sample; context only)
          maxRawAnywhere: maxAnywhere,       // any other hot meter (e.g. live stream inputs)
          maxDb: maxForModule > 0 ? RavennaEngine.dbFromLevel(maxForModule, this.meterFullScale) : null,
          fullScale: this.meterFullScale,    // 0 dBFS reference (assumed 2^15; see dbFromLevel)
          raw
        });
      }, windowMs);
    });
  }

  /**
   * High-level set by parameter name, using PARAMS descriptors.
   * For 'tenths-db' params, pass dB; the library converts and clamps to caps.
   * ctx may carry { channelIndex } for per-channel params.
   */
  setParam(moduleId, key, value, ctx = {}) {
    const desc = PARAMS[key];
    if (!desc) throw new Error(`Unknown parameter '${key}'`);

    let v = value;
    if (desc.unit === 'tenths-db') {
      v = dbToTenths(value);
      const cap = this._capFor(moduleId, key);
      if (cap) v = Math.min(cap.max, Math.max(cap.min, v));   // clamp in tenths
    }
    const channelCount = this._channelCountFor(moduleId, desc.section);
    const valueObj = desc.build(v, { channelCount, channelIndex: ctx.channelIndex || 0 });
    const path = desc.section === 'ins'
      ? require('./paths').moduleInsPath(moduleId)
      : moduleOutsPath(moduleId);
    return this.publishSettings(path, valueObj);
  }

  _capFor(moduleId, key) {
    const c = this.capabilities[moduleId];
    if (!c) return null;
    if (key === 'attenuation') return c.attenuation || null;
    if (key === 'channel_trim') return c.trim || null;
    return null;
  }

  _channelCountFor(moduleId, section) {
    if (!this.tree || !Array.isArray(this.tree._modules)) return 1;
    const m = this.tree._modules.find((x) => x.id === moduleId);
    const sec = m && m.custom && m.custom[section];
    return (sec && Array.isArray(sec.channels)) ? sec.channels.length : 1;
  }

  // ---- inbound ------------------------------------------------------------

  _ingestTree(tree) {
    this.tree = tree;
    this.capabilities = {};
    this._outsCache = {};   // per-module last-known outs scalars, for change-detection in feedback echoes
    if (Array.isArray(tree._modules)) {
      for (const m of tree._modules) {
        const outs = m && m.custom && m.custom.outs;
        if (outs) this._outsCache[m.id] = this._snapshotOuts(outs);
        const caps = outs && outs.capabilities;
        if (caps) {
          this.capabilities[m.id] = {
            attenuation: caps.attenuation_info || null,
            trim: (caps.channel && caps.channel.trim_info) || null,
            mute: !!caps.mute,
            rollOff: caps.roll_off_filters || null,
            name: m.name || null
          };
        }
      }
    }
    this.catalog = buildCatalog(tree);
    this.compat = checkCompat(tree);
    this.emit('tree', tree);
    this.emit('catalog', this.catalog);
    this.emit('compat', this.compat);
  }

  _handleMessage(m) {
    this._kickLiveness(); // any frame = device alive
    this.emit('raw', m);  // expose every frame (used by meter sampling / debugging)

    const ch = m.channel;
    if (ch === '/meta/handshake') {
      if (m.successful && m.clientId) {
        this.clientId = m.clientId;
        this.emit('status', 'connected');
        this._backoffIdx = 0;
        this._subscribeAndSync();
        this._connectLoop();
      } else {
        this._teardownAndReconnect('connect-failed');
      }
      return;
    }
    if (ch === '/meta/connect') {
      if (m.successful) this._connectLoop();
      else this._teardownAndReconnect('connect-failed');
      return;
    }
    if (ch === '/meta/subscribe') return;

    if (ch === '/ravenna/settings' || ch === '/ravenna/status') {
      const d = m.data;
      if (d && d.path === '$' && d.value) {
        // Only /ravenna/settings carries the AUTHORITATIVE full tree (modules with
        // custom/capabilities). The periodic /ravenna/status '$' is a REDUCED tree
        // (modules carry only {state,id,type}); ingesting it would wipe capabilities
        // and the catalog every ~2 s. So ingest from settings only — but either '$'
        // is sufficient to declare the device reachable.
        if (ch === '/ravenna/settings') this._ingestTree(d.value);
        if (!this.online) { this.online = true; this.emit('online'); }
      }
      if (ch === '/ravenna/settings') {
        this.emit('settings', d);
        this._maybeEmitParam(d);
      } else {
        this.emit('statusmsg', d);
      }
      return;
    }
    if (ch === '/ravenna/errors') { this.emit('errors', m.data); }
  }

  /** Compact snapshot of an outs node's settable scalars, for change-detection. */
  _snapshotOuts(o) {
    return {
      attenuation: typeof o.attenuation === 'number' ? o.attenuation : undefined,
      mute: typeof o.mute === 'boolean' ? o.mute : undefined,
      roll_off_filter: typeof o.roll_off_filter === 'number' ? o.roll_off_filter : undefined,
      out_max_level: typeof o.out_max_level === 'number' ? o.out_max_level : undefined,
      trims: Array.isArray(o.channels) ? o.channels.map((c) => (c && typeof c.trim === 'number' ? c.trim : undefined)) : undefined
    };
  }

  // Resolve a /ravenna/settings echo into catalog-style param change event(s).
  // The device echoes at TWO observed granularities (confirmed from a live capture):
  //   - narrow:      $._modules[?(@.id==N)][0].custom.outs   value = { attenuation: -399 }
  //                  (attenuation drives this path; value IS the outs delta)
  //   - module-root: $._modules[?(@.id==N)][0]               value = { ...whole module..., custom:{outs:{...}} }
  //                  (mute / roll_off_filter / out_max_level / trim from web UI or front panel)
  // Either way we resolve the outs object and emit only keys that actually CHANGED
  // vs the last-known value (so a full-module echo doesn't spam unchanged channels).
  _maybeEmitParam(d) {
    if (!d || !d.path || typeof d.value !== 'object' || d.value === null) return;
    const m = /_modules\[\?\(@\.id==(\d+)\)\]\[0\](?:\.custom\.(outs|ins))?\s*$/.exec(d.path);
    if (!m) return;
    const moduleId = parseInt(m[1], 10);
    let outs;
    if (m[2] === 'outs') outs = d.value;                 // narrow outs echo: value is the delta
    else if (m[2] === 'ins') return;                     // ins feedback not modeled yet
    else { const c = d.value.custom; outs = c && c.outs; } // module-root echo: dig into custom.outs
    if (!outs || typeof outs !== 'object') return;

    if (!this._outsCache) this._outsCache = {};
    const prev = this._outsCache[moduleId] || (this._outsCache[moduleId] = {});

    if (typeof outs.attenuation === 'number' && outs.attenuation !== prev.attenuation) {
      prev.attenuation = outs.attenuation;
      this.emit('param', { moduleId, key: 'attenuation', raw: outs.attenuation, value: outs.attenuation / 10, unit: 'dB' });
    }
    if (typeof outs.mute === 'boolean' && outs.mute !== prev.mute) {
      prev.mute = outs.mute;
      this.emit('param', { moduleId, key: 'mute', raw: outs.mute, value: outs.mute, unit: 'bool' });
    }
    if (typeof outs.roll_off_filter === 'number' && outs.roll_off_filter !== prev.roll_off_filter) {
      prev.roll_off_filter = outs.roll_off_filter;
      this.emit('param', { moduleId, key: 'roll_off_filter', raw: outs.roll_off_filter, value: outs.roll_off_filter, unit: 'enum' });
    }
    if (typeof outs.out_max_level === 'number' && outs.out_max_level !== prev.out_max_level) {
      prev.out_max_level = outs.out_max_level;
      this.emit('param', { moduleId, key: 'out_max_level', raw: outs.out_max_level, value: outs.out_max_level, unit: 'int' });
    }
    if (Array.isArray(outs.channels)) {
      if (!Array.isArray(prev.trims)) prev.trims = [];
      outs.channels.forEach((c, i) => {
        if (c && typeof c.trim === 'number' && c.trim !== prev.trims[i]) {
          prev.trims[i] = c.trim;
          this.emit('param', { moduleId, key: 'channel_trim', channelIndex: i, raw: c.trim, value: c.trim / 10, unit: 'dB' });
        }
      });
    }
  }

  _onFrame(raw) {
    let arr;
    try { arr = JSON.parse(raw); } catch (e) { return; }
    if (!Array.isArray(arr)) arr = [arr];
    for (const m of arr) this._handleMessage(m);
  }

  // ---- watchdog & reconnect ----------------------------------------------

  _kickLiveness() {
    this._clearLiveness();
    this._livenessTimer = this._setTimeout(() => {
      this.emit('status', 'stale');
      this._teardownAndReconnect('timeout');
    }, this.livenessMs);
  }

  _clearLiveness() {
    if (this._livenessTimer) { this._clearTimeout(this._livenessTimer); this._livenessTimer = null; }
  }

  _clearReconnect() {
    if (this._reconnectTimer) { this._clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
  }

  _goOffline(reason) {
    const was = this.online;
    this.online = false;
    this.clientId = null;
    if (was) this.emit('offline', reason);
  }

  _teardownAndReconnect(reason) {
    this._clearLiveness();
    try { if (this.ws) { this.ws.removeAllListeners(); this.ws.close(); } } catch (e) { /* ignore */ }
    this.ws = null;
    this._goOffline(reason);
    if (this._closing) return;
    if (this._reconnectTimer) return;
    const delay = this.backoff[Math.min(this._backoffIdx, this.backoff.length - 1)];
    this._backoffIdx++;
    this.emit('status', 'reconnecting');
    this._reconnectTimer = this._setTimeout(() => { this._reconnectTimer = null; this._open(); }, delay);
  }

  _open() {
    let ws;
    try {
      ws = new this._WebSocket(this.url, { perMessageDeflate: true, origin: this.origin });
    } catch (e) {
      this.emit('error', e);
      this._teardownAndReconnect('connect-failed');
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.emit('status', 'open');
      this.msgId = 0; this.clientId = null;
      this._kickLiveness();
      this._handshake();
    });
    ws.on('message', (data) => this._onFrame(data.toString()));
    ws.on('close', () => { if (!this._closing) this._teardownAndReconnect('closed'); });
    ws.on('error', (e) => { this.emit('error', e); });
  }
}

module.exports = { RavennaEngine };
