'use strict';

/**
 * validate-device.js — the canonical, shippable device validator.
 *
 * Connects to a Merging RAVENNA device, discovers every parameter the library
 * models (plus unmodeled leaves), and — when writes are enabled — validates each
 * one by SET -> RE-READ: it sends the change, re-reads the full tree to see if it
 * actually applied (firmware-agnostic ground truth, no dependence on echo paths),
 * records WHERE the device echoed the change (research data), then RESTORES and
 * verifies a clean end-state. Emits a human summary AND a JSON report you can
 * attach to a bug report — ideal for collecting data on unknown firmware.
 *
 *   # read-only discovery (no writes, safe anytime):
 *   MERGING_HOST=192.168.0.150 node scripts/validate-device.js
 *   # full write-validate (audio OFF only):
 *   MERGING_HOST=192.168.0.150 MERGING_I_UNDERSTAND=1 node scripts/validate-device.js
 *
 * Env:
 *   MERGING_HOST                device IP (required; absent -> no-op skip)
 *   MERGING_I_UNDERSTAND=1      perform writes (set->re-read). Absent -> read-only discovery.
 *   MERGING_SKIP_METER_CHECK=1  proceed despite an unconfirmed meter reading
 *   MERGING_REPORT=<path>       JSON report path (default ./validate-report-<serial|host>.json)
 *   MERGING_TIMEOUT_MS          re-read wait per step (default 3000)
 *
 * SAFETY: writes only with MERGING_I_UNDERSTAND=1; meter pre-flight gate aborts if
 * any planned output module is passing audio; every change is restored (and on
 * SIGINT/SIGTERM); a final end-state diff fails loudly on any residue.
 */

const fs = require('node:fs');
const { RavennaEngine, paths, compat } = require('../index');
const PKG = require('../package.json');

const HOST = process.env.MERGING_HOST;
const I_UNDERSTAND = process.env.MERGING_I_UNDERSTAND === '1';
const SKIP_METER = process.env.MERGING_SKIP_METER_CHECK === '1';
const TIMEOUT_MS = parseInt(process.env.MERGING_TIMEOUT_MS || '3000', 10);
const SETTLE_MS = 300;

const C = { reset: '\x1b[0m', red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', cyn: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m' };
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Pure helpers (exported for offline tests; no device/engine dependency).
// ---------------------------------------------------------------------------

function entryId(e) {
  return `m${e.moduleId}.${e.section}.${e.key}${e.channelIndex != null ? '[' + e.channelIndex + ']' : ''}`;
}
function approxEqual(a, b) { return (typeof a === 'number' && typeof b === 'number') ? Math.abs(a - b) < 0.05 : a === b; }
function fmt(v) { return typeof v === 'number' ? String(v) : JSON.stringify(v); }

// A reversible target value for a param, in the entry's display units.
function nudgeTarget(entry) {
  switch (entry.key) {
    case 'attenuation':
    case 'channel_trim': {
      const step = entry.step || 0.1;
      const up = entry.value + step;
      return (entry.max == null || up <= entry.max) ? up : entry.value - step;
    }
    case 'mute': return !entry.value;
    case 'roll_off_filter': {
      const vals = entry.enum ? Object.values(entry.enum) : [];
      const other = vals.find((v) => v !== entry.value);
      return other != null ? other : entry.value;
    }
    case 'out_max_level': return entry.value === 0 ? 1 : 0;
    default: return undefined;
  }
}

// Build the { path, value } the library would send for a narrow `.custom.<section>` set.
function narrowFrame(entry, target) {
  const desc = paths.PARAMS[entry.key];
  let encoded = target;
  if (desc && desc.unit === 'tenths-db') encoded = paths.dbToTenths(target);
  const value = desc ? desc.build(encoded, { channelCount: entry.channelCount || 1, channelIndex: entry.channelIndex || 0 }) : { [entry.key]: encoded };
  return { path: entry.path, value };
}
// Same change, addressed at the MODULE-ROOT path (how the web UI drives most params).
function rootFrame(entry, target) {
  return { path: `$._modules[?(@.id==${entry.moduleId})][0]`, value: { custom: { [entry.section]: narrowFrame(entry, target).value } } };
}

// Read a single param's current value from a full tree, in the entry's display units.
function readEntryValue(tree, entry) {
  const m = tree && Array.isArray(tree._modules) && tree._modules.find((x) => x && x.id === entry.moduleId);
  const sec = m && m.custom && m.custom[entry.section];
  if (!sec) return undefined;
  if (entry.key === 'channel_trim') {
    const ch = Array.isArray(sec.channels) ? sec.channels[entry.channelIndex] : undefined;
    return ch && typeof ch.trim === 'number' ? paths.tenthsToDb(ch.trim) : undefined;
  }
  const v = sec[entry.key];
  if (v === undefined) return undefined;
  return (paths.PARAMS[entry.key] && paths.PARAMS[entry.key].unit === 'tenths-db') ? paths.tenthsToDb(v) : v;
}

// Pull a param value out of an echoed value object (narrow OR module-root shape).
function extractEchoValue(key, valueObj, channelIndex) {
  if (!valueObj || typeof valueObj !== 'object') return undefined;
  const outs = valueObj.custom ? (valueObj.custom.outs || valueObj.custom.ins) : valueObj; // module-root vs narrow
  if (!outs) return undefined;
  switch (key) {
    case 'attenuation': return typeof outs.attenuation === 'number' ? paths.tenthsToDb(outs.attenuation) : undefined;
    case 'mute': return typeof outs.mute === 'boolean' ? outs.mute : undefined;
    case 'roll_off_filter': return typeof outs.roll_off_filter === 'number' ? outs.roll_off_filter : undefined;
    case 'out_max_level': return typeof outs.out_max_level === 'number' ? outs.out_max_level : undefined;
    case 'channel_trim': {
      const ch = Array.isArray(outs.channels) ? outs.channels[channelIndex] : undefined;
      return ch && typeof ch.trim === 'number' ? paths.tenthsToDb(ch.trim) : undefined;
    }
    default: return undefined;
  }
}

// Given the settings frames seen during a set, classify WHERE the change echoed.
function classifyEcho(frames, entry, target) {
  const narrow = new RegExp(`_modules\\[\\?\\(@\\.id==${entry.moduleId}\\)\\]\\[0\\]\\.custom\\.(outs|ins)`);
  const root = new RegExp(`_modules\\[\\?\\(@\\.id==${entry.moduleId}\\)\\]\\[0\\]\\s*$`);
  for (const f of frames) {
    if (!f || !f.path) continue;
    if (narrow.test(f.path) && approxEqual(extractEchoValue(entry.key, f.value, entry.channelIndex || 0), target)) return { granularity: 'narrow', path: f.path };
    if (root.test(f.path) && !narrow.test(f.path) && approxEqual(extractEchoValue(entry.key, f.value, entry.channelIndex || 0), target)) return { granularity: 'module-root', path: f.path };
  }
  return { granularity: 'none', path: null };
}

// Unmodeled custom.{outs,ins} leaves — discoverable params we don't yet have a setter for.
function inventoryUnmodeled(tree) {
  const KNOWN = new Set(['attenuation', 'mute', 'roll_off_filter', 'out_max_level', 'channel_trim']);
  const found = [];
  for (const m of ((tree && tree._modules) || [])) {
    const custom = m && m.custom; if (!custom) continue;
    for (const section of ['outs', 'ins']) {
      const sec = custom[section]; if (!sec) continue;
      for (const k of Object.keys(sec)) {
        if (k === 'capabilities' || k === 'channels' || KNOWN.has(k)) continue;
        found.push({ moduleId: m.id, moduleName: m.name, section, key: k, type: typeof sec[k], sample: sec[k] });
      }
      if (Array.isArray(sec.channels) && sec.channels[0]) {
        for (const k of Object.keys(sec.channels[0])) {
          if (k === 'trim') continue;
          found.push({ moduleId: m.id, moduleName: m.name, section, key: `channels[].${k}`, type: typeof sec.channels[0][k], sample: sec.channels[0][k] });
        }
      }
    }
  }
  return found;
}

module.exports = { entryId, approxEqual, nudgeTarget, narrowFrame, rootFrame, readEntryValue, extractEchoValue, classifyEcho, inventoryUnmodeled };

// ---------------------------------------------------------------------------
// Live driver (only when run directly).
// ---------------------------------------------------------------------------

if (require.main === module) {
  if (!HOST) { console.error('SKIP: set MERGING_HOST=<device-ip> (e.g. 192.168.0.150).'); process.exit(0); }

  const eng = new RavennaEngine({ host: HOST });
  let lastErrors = [];
  eng.on('errors', (d) => { if (d) lastErrors.push(d); });
  eng.on('error', (e) => console.error('engine error:', e.message));

  const waitOnce = (event, pred, ms) => new Promise((resolve) => {
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; eng.off(event, h); resolve(null); } }, ms);
    function h(a) { if (done) return; if (!pred || pred(a)) { done = true; clearTimeout(to); eng.off(event, h); resolve(a === undefined ? true : a); } }
    eng.on(event, h);
  });
  const reread = async (entry) => { eng.requestUpdate(); await waitOnce('tree', null, TIMEOUT_MS); return readEntryValue(eng.tree, entry); };

  // crash-safe restore registry
  const pending = new Map();
  const restoreAll = () => { for (const r of Array.from(pending.values()).reverse()) { try { r(); } catch (_) { /* ignore */ } } };
  process.on('SIGINT', () => { console.error('\nInterrupted — restoring...'); restoreAll(); setTimeout(() => process.exit(130), 800); });
  process.on('SIGTERM', () => { restoreAll(); setTimeout(() => process.exit(143), 800); });

  async function meterGate(moduleIds) {
    const s = await eng.sampleMeters(1500);
    const peak = {};
    for (const fr of (s.raw || [])) {
      const mods = fr.data && fr.data.value && fr.data.value.state && fr.data.value.state._modules;
      if (!Array.isArray(mods)) continue;
      for (const mod of mods) {
        const lv = mod.meters && mod.meters.outs && mod.meters.outs.levels;
        if (Array.isArray(lv)) { const p = lv.reduce((a, b) => (b > a ? b : a), 0); if (p > (peak[mod.id] || 0)) peak[mod.id] = p; }
      }
    }
    return { confirmed: !!(s.raw && s.raw.length), peak, hot: moduleIds.filter((id) => (peak[id] || 0) > 0), maxAnywhere: s.maxRawAnywhere };
  }

  async function validateOne(entry) {
    const id = entryId(entry);
    const baseline = await reread(entry);
    const target = nudgeTarget(entry);
    if (target === undefined || approxEqual(target, baseline)) {
      return { id, ...meta(entry), baseline, target, status: 'SKIPPED', detail: 'no reversible nudge', appliedVia: null, echo: { granularity: 'n/a' }, restored: true };
    }

    const echoes = [];
    const moduleRe = new RegExp(`_modules\\[\\?\\(@\\.id==${entry.moduleId}\\)\\]`);
    const onS = (d) => { if (d && d.path && moduleRe.test(d.path)) echoes.push({ path: d.path, value: d.value }); };
    eng.on('settings', onS);
    lastErrors = [];

    const restore = () => { try { eng.setParam(entry.moduleId, entry.key, baseline, { channelIndex: entry.channelIndex || 0 }); } catch (_) {} try { const rf = rootFrame(entry, baseline); eng.publishSettings(rf.path, rf.value); } catch (_) {} };
    pending.set(id, restore);

    // Attempt 1: the library's real narrow set.
    eng.setParam(entry.moduleId, entry.key, target, { channelIndex: entry.channelIndex || 0 });
    await sleep(SETTLE_MS);
    let after = await reread(entry);
    let appliedVia = approxEqual(after, target) ? '.custom.outs' : null;

    // Attempt 2: module-root (web-UI style) if the narrow set didn't take.
    if (!appliedVia) {
      const rf = rootFrame(entry, target);
      eng.publishSettings(rf.path, rf.value);
      await sleep(SETTLE_MS);
      after = await reread(entry);
      if (approxEqual(after, target)) appliedVia = 'module-root';
    }

    const echo = classifyEcho(echoes, entry, target);
    eng.off('settings', onS);

    // Restore + verify.
    restore();
    await sleep(SETTLE_MS);
    const back = await reread(entry);
    pending.delete(id);
    const restored = approxEqual(back, baseline);

    const status = lastErrors.length ? 'REJECTED' : appliedVia ? 'APPLIED' : 'NOT_APPLIED';
    return { id, ...meta(entry), baseline, target, status, appliedVia, echo, restored, errors: lastErrors.slice() };
  }
  const meta = (e) => ({ moduleId: e.moduleId, moduleName: e.moduleName, section: e.section, key: e.key, channelIndex: e.channelIndex != null ? e.channelIndex : null, unit: e.unit, confidence: e.confidence });

  function writeReport(report) {
    const fname = process.env.MERGING_REPORT || `validate-report-${(report.device.serial || HOST).toString().replace(/[^\w.-]/g, '_')}.json`;
    fs.writeFileSync(fname, JSON.stringify(report, null, 2));
    return fname;
  }

  (async () => {
    log(`${C.bold}merging-ravenna device validation${C.reset} (v${PKG.version})`);
    log(`Connecting to ${HOST} ...`);
    eng.connect();
    if (await waitOnce('online', null, 15000) === null) { console.error(`${C.red}FAILED: device did not come online within 15 s${C.reset}`); process.exit(1); }

    const ident = eng.tree.identity || {};
    const fw = eng.tree._firmware_version || '?';
    const gen = eng.tree._firmware_generation != null ? eng.tree._firmware_generation : '?';
    const catalog = eng.catalog.slice();
    const unmodeled = inventoryUnmodeled(eng.tree);

    log(`${C.bold}Device:${C.reset} ${ident.product || '?'}  serial ${ident.serial || '?'}  ${ident.name ? '"' + ident.name + '"' : ''}`);
    log(`${C.bold}Firmware:${C.reset} ${fw} (gen ${gen}) — ${compat.describeCompat(eng.compat)}`);
    log(`${C.bold}Catalog:${C.reset} ${catalog.filter((e) => e.settable).length} settable param(s); ${unmodeled.length} unmodeled leaf/leaves.`);

    const report = {
      tool: 'merging-ravenna validate-device', toolVersion: PKG.version, timestamp: new Date().toISOString(),
      host: HOST,
      device: { product: ident.product || null, serial: ident.serial || null, name: ident.name || null, firmware: fw, generation: gen },
      compat: { level: eng.compat.level, confirmedShapes: (eng.compat.entry && eng.compat.entry.confirmedShapes) || [], inferredShapes: (eng.compat.entry && eng.compat.entry.inferredShapes) || [] },
      catalog, unmodeledLeaves: unmodeled,
      mode: I_UNDERSTAND ? 'write-validate' : 'read-only',
      meterPreflight: null, validations: [], endState: null
    };

    if (!I_UNDERSTAND) {
      log(`\n${C.yel}Read-only mode${C.reset} — no writes. Set ${C.bold}MERGING_I_UNDERSTAND=1${C.reset} to validate set-shapes (audio OFF only).`);
      const fname = writeReport(report);
      log(`${C.cyn}JSON report:${C.reset} ${fname}`);
      eng.close(); process.exit(0);
    }

    // ---- write-validate ----
    log(`\n${C.red}${C.bold}WRITE-VALIDATE: this writes to the device. Audio must be OFF.${C.reset}`);
    if (eng.compat.level !== 'known-good') log(`${C.yel}Note: firmware is '${eng.compat.level}'. set->re-read with restore makes this safe to run for data collection; results will tell us which shapes this firmware honors.${C.reset}`);

    const plan = catalog.filter((e) => e.settable && paths.PARAMS[e.key]);
    const planModules = Array.from(new Set(plan.map((e) => e.moduleId)));

    if (!SKIP_METER) {
      const g = await meterGate(planModules);
      report.meterPreflight = { confirmed: g.confirmed, perModulePeak: g.peak, hotModules: g.hot, maxAnywhere: g.maxAnywhere };
      if (!g.confirmed) { console.error(`${C.red}ABORT: could not confirm silence (no meter frames). Set MERGING_SKIP_METER_CHECK=1 to override.${C.reset}`); writeReport(report); eng.close(); process.exit(1); }
      if (g.hot.length) { console.error(`${C.red}${C.bold}ABORT: output meters show signal on module(s) ${g.hot.join(', ')}. Nothing written.${C.reset}`); writeReport(report); eng.close(); process.exit(1); }
      log(`${C.grn}Meter pre-flight: silent on planned output module(s) [${planModules.join(', ')}] — proceeding.${C.reset}${g.maxAnywhere > 0 ? `  ${C.dim}(other meters active, peak ${g.maxAnywhere} — inputs)` + C.reset : ''}`);
    }

    const before = new Map(catalog.map((e) => [entryId(e), e.value]));
    log(`\n${C.bold}Validating ${plan.length} param(s) by set->re-read (full coverage):${C.reset}\n`);
    log(`  ${'param'.padEnd(26)} ${'base'.padEnd(7)} ${'target'.padEnd(7)} ${'result'.padEnd(14)} echo`);

    for (const entry of plan) {
      const r = await validateOne(entry);
      report.validations.push(r);
      const col = r.status === 'APPLIED' ? C.grn : r.status === 'SKIPPED' ? C.dim : C.yel;
      const via = r.appliedVia ? ` ${C.dim}(${r.appliedVia})${C.reset}` : '';
      const restoreWarn = r.restored ? '' : ` ${C.red}RESTORE-FAILED${C.reset}`;
      log(`  ${r.id.padEnd(26)} ${fmt(r.baseline).padEnd(7)} ${fmt(r.target).padEnd(7)} ${col}${r.status.padEnd(14)}${C.reset}${via} ${r.echo.granularity}${restoreWarn}`);
    }

    // ---- end-state ----
    eng.requestUpdate(); await waitOnce('tree', null, TIMEOUT_MS);
    const after = new Map(eng.catalog.map((e) => [entryId(e), e.value]));
    const residue = [];
    for (const [k, v] of before) { if (!after.has(k)) residue.push({ id: k, before: v, after: '(missing)' }); else if (!approxEqual(v, after.get(k))) residue.push({ id: k, before: v, after: after.get(k) }); }
    report.endState = { clean: residue.length === 0, residue };

    const counts = report.validations.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
    const viaNarrow = report.validations.filter((r) => r.appliedVia === '.custom.outs').length;
    const viaRoot = report.validations.filter((r) => r.appliedVia === 'module-root').length;

    log(`\n${C.bold}===== SUMMARY =====${C.reset}`);
    log(`  APPLIED ${counts.APPLIED || 0} (via .custom.outs ${viaNarrow}, via module-root ${viaRoot})  REJECTED ${counts.REJECTED || 0}  NOT_APPLIED ${counts.NOT_APPLIED || 0}  SKIPPED ${counts.SKIPPED || 0}`);
    if (viaRoot > 0) log(`  ${C.yel}${viaRoot} param(s) only applied via the module-root path — the library's .custom.outs set may need updating for this firmware.${C.reset}`);

    const fname = writeReport(report);
    log(`\n${C.bold}===== END-STATE =====${C.reset}`);
    if (residue.length) { console.error(`${C.red}${C.bold}RESIDUE — device NOT clean:${C.reset} ${residue.map((d) => `${d.id} ${fmt(d.before)}->${fmt(d.after)}`).join(' | ')}`); log(`${C.cyn}JSON report:${C.reset} ${fname}`); eng.close(); process.exit(1); }
    log(`${C.grn}CLEAN: all changes restored to the pre-run snapshot.${C.reset}`);
    log(`${C.cyn}JSON report:${C.reset} ${fname}  ${C.dim}(attach this when reporting unknown-firmware results)${C.reset}`);
    eng.close();
    process.exit(0);
  })().catch((e) => { console.error('FATAL:', e && e.message); restoreAll(); setTimeout(() => process.exit(1), 800); });
}
