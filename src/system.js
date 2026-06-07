'use strict';

/**
 * system.js
 * ---------
 * Knowledge about the device's SYSTEM domain — everything outside the per-module
 * audio controls in `custom.outs`. These values live at varied JSONPaths across the
 * settings tree (top-level scalars, `network.PTP`, the Sync module, `ios[].configuration`),
 * so each descriptor carries its own reader rather than assuming the outs path.
 *
 * Every descriptor is DESCRIPTIVE and DEFENSIVE: `read(tree)` returns `undefined`
 * when the field is absent, so on unfamiliar firmware we simply surface fewer
 * entries instead of throwing. `readSystem()` skips anything not present.
 *
 * `settable` starts FALSE for every entry. The set shape for system params is not
 * yet confirmed on hardware; scripts/probe-system.js (run audio-off) will verify
 * each one via set -> re-read and flip the confirmed ones to settable with a write
 * descriptor. Until then this module is READ-ONLY telemetry + a labeled inventory.
 *
 * Snapshot entry shape (from readSystem):
 * {
 *   key, label, group,
 *   unit,            // 'Hz'|'samples'|'bool'|'enum'|'int'|'string'|'celsius'|'percent'|'datetime'|'seconds'
 *   raw,             // value as stored on the device
 *   value,           // display-friendly value (e.g. label for an enum, seconds for uptime)
 *   enum,            // { label: rawValue } for enum params, else null
 *   settable,        // false until probe-confirmed
 *   readonly         // true for pure telemetry that can never be set (status/health)
 * }
 */

// ---- small tree helpers (all null-safe) -----------------------------------
function moduleById(tree, id) {
  const mods = tree && tree._modules;
  if (!Array.isArray(mods)) return null;
  return mods.find((m) => m && m.id === id) || null;
}
function firstIoConfig(tree) {
  const ios = tree && tree.ios;
  if (!Array.isArray(ios)) return null;
  const io = ios.find((x) => x && x.configuration && x.configuration.sampleRate != null);
  return io ? io.configuration : null;
}
function ioSampleRateCaps(tree) {
  const ios = tree && tree.ios;
  if (!Array.isArray(ios)) return null;
  const io = ios.find((x) => x && x.capabilities && Array.isArray(x.capabilities.sampleRate));
  return io ? io.capabilities.sampleRate : null;
}

// ---- label formatters ------------------------------------------------------
/** 44100 -> "44.1 kHz", 48000 -> "48 kHz". */
function hzLabel(hz) {
  const k = hz / 1000;
  return (Number.isInteger(k) ? String(k) : k.toFixed(1)) + ' kHz';
}
/** Build { "44.1 kHz": 44100, ... } from a caps array of rates. */
function rateEnum(rates) {
  if (!Array.isArray(rates)) return null;
  const out = {};
  for (const r of rates) out[hzLabel(r)] = r;
  return out;
}
/** Build { "6": 6, ... } from a caps array of integer options. */
function intEnum(opts) {
  if (!Array.isArray(opts)) return null;
  const out = {};
  for (const n of opts) out[String(n)] = n;
  return out;
}
/** Build { signal_name: input_id } from a Sync module's advertised sync_sources. */
function syncSourceEnum(tree) {
  const m = moduleById(tree, 2);
  const list = m && m.state && m.state.sync_sources;
  if (!Array.isArray(list)) return null;
  const out = {};
  for (const s of list) if (s && s.signal_name != null) out[s.signal_name] = s.input_id;
  return out;
}

// ---- write-frame builders --------------------------------------------------
// Every shape below was CONFIRMED on hardware (Hapi MkII, fw 1.9.0b62872) by
// scripts/probe-system.js: set -> re-read -> restore. The device merges `value`
// (a partial object) into the node at `path`.
const moduleRootPath = (id) => `$._modules[?(@.id==${id})][0]`;
const topWrite = (field) => (v) => ({ path: '$', value: { [field]: v } });
const moduleWrite = (id, field) => (v) => ({ path: moduleRootPath(id), value: { [field]: v } });
const ptpWrite = (field) => (v) => ({ path: '$.network.PTP', value: { [field]: v } });
const ptpMasterWrite = (field) => (v) => ({ path: '$.network.PTP.Master', value: { [field]: v } });

// ---- descriptor table ------------------------------------------------------
// NOTE on enums: `enum(tree)` returns a { label: rawValue } map. For read-only status
// fields whose integer meanings we have NOT confirmed (e.g. PTP LockStatus), we expose
// the raw int with no guessed labels rather than inventing a mapping.
const SYSTEM = [
  // ----- Clock -----
  {
    key: 'sample_rate', label: 'Sample rate', group: 'Clock', unit: 'Hz',
    read: (t) => { const c = firstIoConfig(t); return c ? c.sampleRate : undefined; },
    enum: (t) => rateEnum(ioSampleRateCaps(t)),
    settable: true,
    write: (v) => ({ path: '$.ios[?(@.id=="1")][0].configuration', value: { sampleRate: v } })
  },
  {
    key: 'auto_sample_rate', label: 'Auto sample rate', group: 'Clock', unit: 'bool',
    read: (t) => t._auto_sample_rate,
    settable: true, write: topWrite('_auto_sample_rate')
  },
  {
    key: 'frame_size', label: 'Frame size (latency)', group: 'Clock', unit: 'samples',
    read: (t) => t._frame_size_at_1FS,
    enum: (t) => intEnum(t && t.capabilities && t.capabilities._frame_size_at_1FS),
    settable: true, write: topWrite('_frame_size_at_1FS')
  },
  {
    key: 'asio_clock', label: 'ASIO clock', group: 'Clock', unit: 'int',
    read: (t) => t._ASIO_clock,
    settable: true, write: topWrite('_ASIO_clock')
  },

  // ----- Sync / clock source (Sync module, id 2) -----
  {
    key: 'sync_source', label: 'Clock source', group: 'Sync', unit: 'enum',
    read: (t) => { const m = moduleById(t, 2); return m && m.sync_source ? m.sync_source.input_id : undefined; },
    enum: (t) => syncSourceEnum(t),
    settable: true,
    write: (v) => ({ path: moduleRootPath(2), value: { sync_source: { module_id: 2, input_id: v } } })
  },
  {
    key: 'wordclock_termination', label: 'Word clock termination (75Ω)', group: 'Sync', unit: 'bool',
    read: (t) => { const m = moduleById(t, 2); return m ? m.wordclock_termination : undefined; },
    settable: true, write: moduleWrite(2, 'wordclock_termination')
  },
  {
    key: 'wordclock_out_follow_samplingrate', label: 'Word clock out follows sample rate', group: 'Sync', unit: 'bool',
    read: (t) => { const m = moduleById(t, 2); return m ? m.wordclock_out_follow_samplingrate : undefined; },
    settable: true, write: moduleWrite(2, 'wordclock_out_follow_samplingrate')
  },
  {
    key: 'video_termination', label: 'Video ref termination (75Ω)', group: 'Sync', unit: 'bool',
    read: (t) => { const m = moduleById(t, 2); return m ? m.video_termination : undefined; },
    settable: true, write: moduleWrite(2, 'video_termination')
  },

  // ----- PTP policy (network.PTP.Master) -----
  {
    key: 'ptp_domain', label: 'PTP domain', group: 'PTP', unit: 'int',
    read: (t) => t.network && t.network.PTP ? t.network.PTP.Domain : undefined,
    settable: true, write: ptpWrite('Domain')
  },
  {
    key: 'ptp_manual_master', label: 'PTP manual grandmaster', group: 'PTP', unit: 'bool',
    read: (t) => t.network && t.network.PTP && t.network.PTP.Master ? t.network.PTP.Master.Manual : undefined,
    settable: true, write: ptpMasterWrite('Manual')
  },
  // Priorities are settable ONLY while ptp_manual_master is true (confirmed by
  // scripts/probe-ptp-priority.js: they no-op under auto-GM, apply under manual).
  // Marked settable with the confirmed shape; the note flags the dependency so a
  // write while Manual=false is understood to be ignored by the device.
  {
    key: 'ptp_priority1', label: 'PTP priority 1', group: 'PTP', unit: 'int',
    read: (t) => t.network && t.network.PTP && t.network.PTP.Master ? t.network.PTP.Master.Prio1 : undefined,
    settable: true, write: ptpMasterWrite('Prio1'),
    note: 'only applied when ptp_manual_master is true (auto-GM ignores it)'
  },
  {
    key: 'ptp_priority2', label: 'PTP priority 2', group: 'PTP', unit: 'int',
    read: (t) => t.network && t.network.PTP && t.network.PTP.Master ? t.network.PTP.Master.Prio2 : undefined,
    settable: true, write: ptpMasterWrite('Prio2'),
    note: 'only applied when ptp_manual_master is true (auto-GM ignores it)'
  },

  // ----- PTP status (read-only telemetry) -----
  {
    key: 'ptp_lock_status', label: 'PTP lock status', group: 'PTP', unit: 'int', readonly: true,
    read: (t) => t.network && t.network.PTP && t.network.PTP.Status ? t.network.PTP.Status.LockStatus : undefined
  },
  {
    key: 'ptp_grandmaster_id', label: 'PTP grandmaster (GMID)', group: 'PTP', unit: 'string', readonly: true,
    read: (t) => t.network && t.network.PTP && t.network.PTP.Status ? t.network.PTP.Status.GMID : undefined
  },
  {
    key: 'ptp_is_master', label: 'PTP is grandmaster', group: 'PTP', unit: 'bool', readonly: true,
    read: (t) => t.network && t.network.PTP && t.network.PTP.Status ? t.network.PTP.Status.Master : undefined
  },
  {
    key: 'ptp_clock_jitter', label: 'PTP clock jitter', group: 'PTP', unit: 'int', readonly: true,
    read: (t) => t.network && t.network.PTP && t.network.PTP.Status ? t.network.PTP.Status.ClockJitter : undefined
  },
  {
    key: 'ptp_network_jitter', label: 'PTP network jitter', group: 'PTP', unit: 'int', readonly: true,
    read: (t) => t.network && t.network.PTP && t.network.PTP.Status ? t.network.PTP.Status.NetworkJitter : undefined
  },

  // ----- Device identity / firmware (read-only) -----
  {
    key: 'product', label: 'Product', group: 'Device', unit: 'string', readonly: true,
    read: (t) => t.identity ? t.identity.product : undefined
  },
  {
    key: 'serial', label: 'Serial', group: 'Device', unit: 'string', readonly: true,
    read: (t) => t.identity ? t.identity.serial : undefined
  },
  {
    key: 'device_name', label: 'Device name', group: 'Device', unit: 'string', readonly: true,
    read: (t) => t.identity ? t.identity.name : undefined
  },
  {
    key: 'firmware_version', label: 'Firmware version', group: 'Device', unit: 'string', readonly: true,
    read: (t) => t._firmware_version
  },
  {
    key: 'firmware_generation', label: 'Firmware generation', group: 'Device', unit: 'int', readonly: true,
    read: (t) => t._firmware_generation
  },
  {
    key: 'boot_time', label: 'Boot time', group: 'Device', unit: 'datetime', readonly: true,
    read: (t) => t._boot_time
  },
  {
    key: 'uptime', label: 'Uptime', group: 'Device', unit: 'seconds', readonly: true, derived: true,
    // derived from boot_time at read time; `now` injectable for deterministic tests
    read: (t) => t._boot_time // raw is the boot timestamp; value (seconds) computed in readSystem
  },

  // ----- Health (ZMAN module, id 0; read-only) -----
  {
    key: 'temperature', label: 'Temperature', group: 'Health', unit: 'celsius', readonly: true,
    read: (t) => { const m = moduleById(t, 0); return m && m.state ? m.state.temperature : undefined; }
  },
  {
    key: 'cpu_load', label: 'CPU load', group: 'Health', unit: 'percent', readonly: true,
    read: (t) => { const m = moduleById(t, 0); return m && m.state ? m.state.cpu_load : undefined; }
  },
  {
    key: 'memory_load', label: 'Memory load', group: 'Health', unit: 'percent', readonly: true,
    read: (t) => { const m = moduleById(t, 0); return m && m.state ? m.state.memory_load : undefined; }
  },
  {
    key: 'panic', label: 'Panic', group: 'Health', unit: 'bool', readonly: true,
    read: (t) => { const m = moduleById(t, 0); return m && m.state ? m.state.panic : undefined; }
  },

  // ----- Advanced device flags (top-level) -----
  // consumer_mode did NOT apply via the standard set in the probe (may require a
  // reboot or a dedicated command); left non-settable until confirmed.
  { key: 'consumer_mode', label: 'Consumer mode', group: 'Advanced', unit: 'bool', read: (t) => t._consumer_mode, note: 'did not apply via standard set (probe); may need reboot/dedicated command' },
  { key: 'big_jitter_buffer', label: 'Big jitter buffer', group: 'Advanced', unit: 'bool', read: (t) => t._big_jitter_buffer, settable: true, write: topWrite('_big_jitter_buffer') },
  { key: 'fixed_playout_delay', label: 'Fixed playout delay', group: 'Advanced', unit: 'bool', read: (t) => t._fixed_playout_delay, settable: true, write: topWrite('_fixed_playout_delay') },
  { key: 'auto_connect_from_source', label: 'Auto-connect from source', group: 'Advanced', unit: 'bool', read: (t) => t._auto_connect_from_source, settable: true, write: topWrite('_auto_connect_from_source') },
  { key: 'auto_save', label: 'Auto-save', group: 'Advanced', unit: 'bool', read: (t) => t._auto_save, settable: true, write: topWrite('_auto_save') },
  { key: 'peer_filtering', label: 'Peer filtering', group: 'Advanced', unit: 'bool', read: (t) => t._peer_filtering, settable: true, write: topWrite('_peer_filtering') },
  {
    key: 'spdif_physical_mode', label: 'S/PDIF physical mode', group: 'Advanced', unit: 'int',
    read: (t) => { const m = moduleById(t, 100); return m ? m.physical_mode : undefined; },
    settable: true, write: moduleWrite(100, 'physical_mode')
  }
];

/**
 * Parse the device's "YYYY-MM-DD HH:MM:SS" boot time to epoch ms, or null.
 * The device reports this in UTC (confirmed on hardware: interpreting it as local
 * placed boot in the future relative to wall-clock now). Parsed as UTC accordingly.
 */
function bootTimeMs(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m.map(Number);
  const t = Date.UTC(Y, Mo - 1, D, H, Mi, S);
  return Number.isFinite(t) ? t : null;
}

/**
 * Read every present system descriptor out of a full settings tree.
 * @param tree the value of a path:"$" settings update
 * @param opts.now epoch ms used to derive uptime (defaults to Date.now())
 * @returns array of snapshot entries (only for fields actually present)
 */
function readSystem(tree, opts = {}) {
  if (!tree || typeof tree !== 'object') return [];
  const now = opts.now != null ? opts.now : Date.now();
  const out = [];
  for (const d of SYSTEM) {
    let raw;
    try { raw = d.read(tree); } catch (e) { raw = undefined; }
    if (raw === undefined) continue; // not present on this firmware

    const enumMap = d.enum ? d.enum(tree) : null;
    let value = raw;
    if (d.key === 'uptime') {
      const ms = bootTimeMs(raw);
      value = ms != null ? Math.max(0, Math.round((now - ms) / 1000)) : null;
    } else if (enumMap) {
      // value = the label whose rawValue matches (fall back to raw if unmatched)
      const hit = Object.keys(enumMap).find((k) => enumMap[k] === raw);
      value = hit != null ? hit : raw;
    }

    out.push({
      key: d.key, label: d.label, group: d.group, unit: d.unit,
      raw, value, enum: enumMap || null,
      settable: !!d.settable && typeof d.write === 'function', // probe-confirmed write shapes only
      readonly: !!d.readonly,
      note: d.note || null
    });
  }
  return out;
}

/** Find a system descriptor by key, or null. */
function descFor(key) { return SYSTEM.find((d) => d.key === key) || null; }

/**
 * Build the device { path, value } write frame for a SETTABLE system param.
 * Resolves an enum LABEL string to its raw value (case-insensitive, using the live
 * tree's enum maps for sample rate / clock source) and coerces by unit. Throws for
 * unknown or not-(probe-)confirmed-settable keys, or a non-numeric numeric value.
 */
function systemWriteFrame(key, value, tree) {
  const d = descFor(key);
  if (!d) throw new Error(`Unknown system parameter '${key}'`);
  if (!d.settable || typeof d.write !== 'function') throw new Error(`System parameter '${key}' is not settable`);

  let v = value;
  if (d.enum) {                              // accept a label string OR the raw value
    const map = d.enum(tree || {});
    if (typeof v === 'string' && map) {
      const hit = Object.keys(map).find((k) => k.toLowerCase() === v.toLowerCase());
      if (hit != null) v = map[hit];
    }
  }
  if (d.unit === 'bool') {
    v = (v === true || v === 1 || v === 'true' || v === '1');
  } else if (d.unit === 'Hz' || d.unit === 'samples' || d.unit === 'int') {
    if (typeof v === 'string') v = parseInt(v, 10);
    if (!Number.isFinite(v)) throw new Error(`Invalid numeric value for system parameter '${key}': ${JSON.stringify(value)}`);
  }
  return d.write(v);
}

/** Group a system snapshot by its `group` field, preserving descriptor order. */
function groupSystem(snapshot) {
  const order = [];
  const map = new Map();
  for (const e of snapshot) {
    if (!map.has(e.group)) { map.set(e.group, { group: e.group, params: [] }); order.push(e.group); }
    map.get(e.group).params.push(e);
  }
  return order.map((g) => map.get(g));
}

module.exports = { SYSTEM, readSystem, groupSystem, bootTimeMs, systemWriteFrame, descFor };
