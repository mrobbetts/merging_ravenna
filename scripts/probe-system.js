'use strict';

/**
 * probe-system.js — confirm WRITE shapes for the system domain (Phase 2).
 *
 * The read model (src/system.js) lists system params but marks them all
 * settable:false because we have not confirmed HOW to set them. This tool finds
 * out empirically: for each writable candidate it tries one or more {path, value}
 * shapes, RE-READS the full tree to see which (if any) actually applied, records
 * the winning shape and where the device echoed it, then RESTORES the original
 * value and verifies the restore. Output: a human table + a JSON report that tells
 * us exactly which keys to flip to settable and with what write descriptor.
 *
 * THIS WRITES TO THE DEVICE. Changing sample rate / frame size / clock source
 * re-clocks the unit and interrupts audio. Run with audio OFF.
 *
 *   # dry run — print the plan, write nothing (safe anytime):
 *   MERGING_HOST=192.168.0.152 node scripts/probe-system.js
 *   # real probe (audio OFF):
 *   MERGING_HOST=192.168.0.152 MERGING_I_UNDERSTAND=1 node scripts/probe-system.js
 *
 * Env:
 *   MERGING_HOST            device IP (required)
 *   MERGING_I_UNDERSTAND=1  perform writes (set->re-read->restore). Absent -> dry run.
 *   MERGING_SKIP_METER_CHECK=1  proceed despite an unconfirmed/active meter reading
 *   MERGING_ONLY=key1,key2  probe only these system keys (default: all candidates)
 *   MERGING_REPORT=<path>   JSON report path (default ./probe-system-<serial|host>.json)
 *   MERGING_TIMEOUT_MS      re-read wait per step (default 3000)
 */

const fs = require('node:fs');
const { RavennaEngine, system } = require('../index');
const PKG = require('../package.json');

const HOST = process.env.MERGING_HOST;
const I_UNDERSTAND = process.env.MERGING_I_UNDERSTAND === '1';
const SKIP_METER = process.env.MERGING_SKIP_METER_CHECK === '1';
const ONLY = (process.env.MERGING_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const TIMEOUT_MS = parseInt(process.env.MERGING_TIMEOUT_MS || '3000', 10);
const SETTLE_MS = 350;

if (!HOST) { console.error('SKIP: set MERGING_HOST=<device ip>.'); process.exit(2); }

const C = { red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// JSONPath helpers for module-rooted / network / ios writes.
const moduleRoot = (id) => `$._modules[?(@.id==${id})][0]`;

// ---- candidate write table -------------------------------------------------
// Each candidate: a system.js key (for reading current value + enum), a risk tag,
// a nudge() to pick a reversible test value, and shapes() returning ORDERED
// {path, value} hypotheses to try. Writes here are EXPERIMENTAL — kept out of the
// clean read model until confirmed.
const boolNudge = (cur) => !cur;
const enumNudge = (cur, map) => {
  if (!map) return undefined;
  const vals = Object.values(map).filter((v) => v !== cur);
  return vals.length ? vals[0] : undefined;
};
const clampedIntNudge = (cur, lo, hi) => (cur + 1 <= hi ? cur + 1 : cur - 1 >= lo ? cur - 1 : undefined);

// top-level scalar `_field` lives directly under "$"
const topScalar = (field) => ({
  shapes: (v) => [
    { path: '$', value: { [field]: v } },
    { path: `$.${field}`, value: v }
  ]
});
// a scalar field on a module node
const moduleScalar = (id, field) => ({
  shapes: (v) => [{ path: moduleRoot(id), value: { [field]: v } }]
});

const CANDIDATES = [
  // --- Clock ---
  {
    key: 'sample_rate', risk: 'high',
    nudge: (cur, map) => {
      // prefer 48000 (or the lowest different standard rate) to avoid extreme rates
      if (map && map['48 kHz'] != null && map['48 kHz'] !== cur) return map['48 kHz'];
      return enumNudge(cur, map);
    },
    shapes: (v) => [
      // sample rate is global but addressed per-io configuration; try io id "1" first
      { path: `$.ios[?(@.id=="1")][0].configuration`, value: { sampleRate: v } },
      { path: '$', value: { _sample_rate: v } }
    ]
  },
  { key: 'frame_size', risk: 'high', nudge: (cur, map) => enumNudge(cur, map), ...topScalar('_frame_size_at_1FS') },
  { key: 'auto_sample_rate', risk: 'med', nudge: boolNudge, ...topScalar('_auto_sample_rate') },
  { key: 'asio_clock', risk: 'med', nudge: (cur) => clampedIntNudge(cur, 0, 3), ...topScalar('_ASIO_clock') },

  // --- Sync / clock source (module 2) ---
  {
    key: 'sync_source', risk: 'high',
    nudge: (cur, map) => enumNudge(cur, map),
    shapes: (v) => [
      { path: moduleRoot(2), value: { sync_source: { module_id: 2, input_id: v } } },
      { path: `${moduleRoot(2)}.sync_source`, value: { input_id: v } }
    ]
  },
  { key: 'wordclock_termination', risk: 'low', nudge: boolNudge, ...moduleScalar(2, 'wordclock_termination') },
  { key: 'wordclock_out_follow_samplingrate', risk: 'low', nudge: boolNudge, ...moduleScalar(2, 'wordclock_out_follow_samplingrate') },
  { key: 'video_termination', risk: 'low', nudge: boolNudge, ...moduleScalar(2, 'video_termination') },

  // --- PTP policy ---
  { key: 'ptp_domain', risk: 'med', nudge: (cur) => clampedIntNudge(cur, 0, 127),
    shapes: (v) => [{ path: '$.network.PTP', value: { Domain: v } }] },
  { key: 'ptp_manual_master', risk: 'med', nudge: boolNudge,
    shapes: (v) => [{ path: '$.network.PTP.Master', value: { Manual: v } }] },
  { key: 'ptp_priority1', risk: 'low', nudge: (cur) => clampedIntNudge(cur, 0, 255),
    shapes: (v) => [{ path: '$.network.PTP.Master', value: { Prio1: v } }] },
  { key: 'ptp_priority2', risk: 'low', nudge: (cur) => clampedIntNudge(cur, 0, 255),
    shapes: (v) => [{ path: '$.network.PTP.Master', value: { Prio2: v } }] },

  // --- Advanced device flags ---
  { key: 'consumer_mode', risk: 'med', nudge: boolNudge, ...topScalar('_consumer_mode') },
  { key: 'big_jitter_buffer', risk: 'low', nudge: boolNudge, ...topScalar('_big_jitter_buffer') },
  { key: 'fixed_playout_delay', risk: 'low', nudge: boolNudge, ...topScalar('_fixed_playout_delay') },
  { key: 'auto_connect_from_source', risk: 'low', nudge: boolNudge, ...topScalar('_auto_connect_from_source') },
  { key: 'auto_save', risk: 'low', nudge: boolNudge, ...topScalar('_auto_save') },
  { key: 'peer_filtering', risk: 'low', nudge: boolNudge, ...topScalar('_peer_filtering') },
  { key: 'spdif_physical_mode', risk: 'low', nudge: (cur) => clampedIntNudge(cur, 0, 1), ...moduleScalar(100, 'physical_mode') }
];

(async () => {
  const eng = new RavennaEngine({ host: HOST });
  let lastErrors = [];
  eng.on('errors', (d) => { if (d) lastErrors.push(d); });
  eng.on('error', (e) => console.error('engine error:', e && e.message));

  const waitOnce = (event, ms) => new Promise((resolve) => {
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; eng.off(event, h); resolve(null); } }, ms);
    function h(a) { if (done) return; done = true; clearTimeout(to); eng.off(event, h); resolve(a); }
    eng.on(event, h);
  });
  const reread = async (key) => { eng.requestUpdate(); await waitOnce('tree', TIMEOUT_MS); const e = eng.getSystemValue(key); return e ? e.raw : undefined; };

  // crash-safe restore registry
  const pending = new Map();
  const restoreAll = () => { for (const r of Array.from(pending.values()).reverse()) { try { r(); } catch (_) { /* ignore */ } } };
  process.on('SIGINT', () => { console.error('\nInterrupted — restoring...'); restoreAll(); setTimeout(() => process.exit(130), 1000); });
  process.on('SIGTERM', () => { restoreAll(); setTimeout(() => process.exit(143), 1000); });

  console.log(`probe-system v${PKG.version} → ${HOST}  (${I_UNDERSTAND ? C.red + 'WRITE' + C.reset : C.yel + 'DRY RUN' + C.reset})`);
  eng.connect();
  const got = await waitOnce('system', 8000);
  if (!got) { console.error(`${C.red}ABORT: no system snapshot from ${HOST} (reachable / powered on?)${C.reset}`); eng.close(); process.exit(1); }

  const present = CANDIDATES.filter((c) => eng.getSystemValue(c.key) && (!ONLY.length || ONLY.includes(c.key)));
  console.log(`${present.length} candidate(s) present${ONLY.length ? ' (filtered)' : ''}.\n`);

  // Plan / dry-run print.
  for (const c of present) {
    const ent = eng.getSystemValue(c.key);
    const target = c.nudge(ent.raw, ent.enum);
    const shapes = target === undefined ? [] : c.shapes(target);
    const riskCol = c.risk === 'high' ? C.red : c.risk === 'med' ? C.yel : C.dim;
    console.log(`${riskCol}[${c.risk}]${C.reset} ${c.key.padEnd(34)} now=${JSON.stringify(ent.raw)}  → try=${JSON.stringify(target)}`);
    if (shapes.length) console.log(`${C.dim}      shapes: ${shapes.map((s) => s.path + ' ⇐ ' + JSON.stringify(s.value)).join('  |  ')}${C.reset}`);
    else console.log(`${C.dim}      (no reversible nudge — will skip)${C.reset}`);
  }

  const report = {
    tool: 'probe-system', toolVersion: PKG.version, host: HOST,
    device: eng.getSubtree('identity') || null, mode: I_UNDERSTAND ? 'write-probe' : 'dry-run',
    timeoutMs: TIMEOUT_MS, meterPreflight: null, results: []
  };

  if (!I_UNDERSTAND) {
    console.log(`\n${C.yel}Dry run — nothing written.${C.reset} Re-run with ${C.bold}MERGING_I_UNDERSTAND=1${C.reset} (audio OFF) to confirm shapes.`);
    fs.writeFileSync(reportPath(report), JSON.stringify(report, null, 2));
    eng.close(); process.exit(0);
  }

  // --- meter pre-flight: refuse to write if an OUTPUT is actually passing audio ---
  // We gate on OUTPUT meter levels, not inputs (which idle at a dither LSB ~1), and
  // allow a small noise-floor threshold so a stray LSB doesn't block a silent device.
  // THRESHOLD default 64 ≈ -60 dBFS; real audio reads in the thousands. Overridable.
  if (!SKIP_METER) {
    const THRESHOLD = parseInt(process.env.MERGING_METER_THRESHOLD || '64', 10);
    const s = await eng.sampleMeters(1500);
    let maxOut = 0;       // peak across all output meters
    const maxAnywhere = s.maxRawAnywhere || 0;
    for (const fr of (s.raw || [])) {
      const mods = fr.data && fr.data.value && fr.data.value.state && fr.data.value.state._modules;
      if (!Array.isArray(mods)) continue;
      for (const mod of mods) {
        const lv = mod.meters && mod.meters.outs && mod.meters.outs.levels;
        if (Array.isArray(lv)) for (const x of lv) if (x > maxOut) maxOut = x;
      }
    }
    report.meterPreflight = { confirmed: !!(s.raw && s.raw.length), maxOut, maxAnywhere, threshold: THRESHOLD };
    if (!s.raw || !s.raw.length) { console.error(`${C.red}ABORT: no meter frames — cannot confirm silence. Set MERGING_SKIP_METER_CHECK=1 to override.${C.reset}`); fs.writeFileSync(reportPath(report), JSON.stringify(report, null, 2)); eng.close(); process.exit(1); }
    if (maxOut > THRESHOLD) { console.error(`${C.red}${C.bold}ABORT: output meters show signal (peak ${maxOut} > ${THRESHOLD}). Probing re-clocks the device — stop audio first.${C.reset}`); fs.writeFileSync(reportPath(report), JSON.stringify(report, null, 2)); eng.close(); process.exit(1); }
    console.log(`\n${C.grn}Meter pre-flight: outputs silent (peak ${maxOut} ≤ ${THRESHOLD}${maxAnywhere > maxOut ? `, inputs idle at ${maxAnywhere}` : ''}) — proceeding with writes.${C.reset}\n`);
  } else {
    console.log(`\n${C.yel}Meter check skipped by request.${C.reset}\n`);
  }

  for (const c of present) {
    const baseline = await reread(c.key);
    const ent = eng.getSystemValue(c.key);
    const target = c.nudge(baseline, ent.enum);
    if (target === undefined || JSON.stringify(target) === JSON.stringify(baseline)) {
      report.results.push({ key: c.key, risk: c.risk, baseline, target: null, status: 'SKIPPED', appliedVia: null, echo: [], restored: true });
      console.log(`  ${c.key.padEnd(34)} ${C.dim}SKIPPED (no reversible nudge)${C.reset}`);
      continue;
    }

    // capture echoes (settings frames) during the write
    const echoes = [];
    const onS = (d) => { if (d && d.path) echoes.push({ path: d.path, value: d.value }); };
    eng.on('settings', onS);
    lastErrors = [];

    const shapes = c.shapes(target);
    // restore uses the FIRST shape with the baseline value (and re-applies winner below if found)
    let winner = null;
    const restore = () => { try { const sh = (winner ? c.shapes(baseline)[winner.idx] : c.shapes(baseline)[0]); eng.publishSettings(sh.path, sh.value); } catch (_) { /* ignore */ } };
    pending.set(c.key, restore);

    let after = baseline;
    for (let i = 0; i < shapes.length; i++) {
      eng.publishSettings(shapes[i].path, shapes[i].value);
      await sleep(SETTLE_MS);
      after = await reread(c.key);
      if (JSON.stringify(after) === JSON.stringify(target)) { winner = { idx: i, shape: shapes[i] }; break; }
    }

    eng.off('settings', onS);

    // restore + verify
    restore();
    await sleep(SETTLE_MS);
    const back = await reread(c.key);
    pending.delete(c.key);
    const restored = JSON.stringify(back) === JSON.stringify(baseline);

    const status = lastErrors.length ? 'REJECTED' : winner ? 'APPLIED' : 'NOT_APPLIED';
    report.results.push({
      key: c.key, risk: c.risk, baseline, target,
      status, appliedVia: winner ? winner.shape.path : null,
      appliedValueShape: winner ? winner.shape.value : null,
      echo: echoes.slice(0, 6), restored, errors: lastErrors.slice()
    });

    const col = status === 'APPLIED' ? C.grn : status === 'REJECTED' ? C.red : C.yel;
    const via = winner ? ` via ${winner.shape.path}` : '';
    const warn = restored ? '' : ` ${C.red}RESTORE-FAILED${C.reset}`;
    console.log(`  ${c.key.padEnd(34)} ${JSON.stringify(baseline)}→${JSON.stringify(target)}  ${col}${status}${C.reset}${C.dim}${via}${C.reset}${warn}`);
  }

  // final full re-read so we leave clean
  eng.requestUpdate(); await waitOnce('tree', TIMEOUT_MS);

  const applied = report.results.filter((r) => r.status === 'APPLIED');
  const badRestore = report.results.filter((r) => r.restored === false);
  console.log(`\n${C.bold}Summary:${C.reset} ${applied.length} APPLIED, ${report.results.length - applied.length} other.`);
  if (badRestore.length) console.log(`${C.red}${C.bold}WARNING: ${badRestore.length} key(s) did not restore: ${badRestore.map((r) => r.key).join(', ')}${C.reset}`);
  console.log('Confirmed write shapes:');
  for (const r of applied) console.log(`  ${C.grn}${r.key}${C.reset}: ${r.appliedVia} ⇐ ${JSON.stringify(r.appliedValueShape)}`);

  const rp = reportPath(report);
  fs.writeFileSync(rp, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${rp}`);
  eng.close();
  process.exit(0);

  function reportPath(rep) {
    const serial = (rep.device && rep.device.serial) || HOST;
    return process.env.MERGING_REPORT || `./probe-system-${String(serial).replace(/[^\w.-]/g, '_')}.json`;
  }
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
