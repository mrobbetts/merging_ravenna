'use strict';

/**
 * sample-fullscale.js — READ-ONLY meter calibration helper. Subscribes to
 * /ravenna/meter and reports per-channel levels for one module/section, so you can
 * read the full-scale integer from a known 0 dBFS tone and pin `meterFullScale`.
 * NEVER writes to the device — safe to run with the tone playing.
 *
 *   # tone arriving on RAVENNA stream inputs (module 1) -> read ch5/6:
 *   MERGING_HOST=192.168.0.150 node scripts/sample-fullscale.js
 *
 * Env: MERGING_METER_MODULE (default 1, the Stream meter), MERGING_METER_SECTION
 * (default 'ins'), MERGING_WINDOW_MS (default 4000).
 */

const { RavennaEngine } = require('../index');

const HOST = process.env.MERGING_HOST;
const MODULE = parseInt(process.env.MERGING_METER_MODULE || '1', 10);
const SECTION = process.env.MERGING_METER_SECTION || 'ins';
const WINDOW = parseInt(process.env.MERGING_WINDOW_MS || '4000', 10);
if (!HOST) { console.error('SKIP: set MERGING_HOST=<device-ip>.'); process.exit(0); }

const eng = new RavennaEngine({ host: HOST });
eng.on('error', (e) => console.error('engine error:', e.message));
const waitOnce = (ev, ms) => new Promise((r) => { const to = setTimeout(() => { eng.off(ev, h); r(null); }, ms); function h(a) { clearTimeout(to); eng.off(ev, h); r(a === undefined ? true : a); } eng.on(ev, h); });

(async () => {
  console.log(`Sampling meters on ${HOST} — module ${MODULE} '${SECTION}' for ${WINDOW} ms (read-only)...`);
  eng.connect();
  if (await waitOnce('online', 15000) === null) { console.error('FAILED: device did not come online within 15 s'); process.exit(1); }

  const s = await eng.sampleMeters(WINDOW, { moduleId: MODULE, section: SECTION });
  const lv = {}, hold = {};
  for (const fr of (s.raw || [])) {
    const mods = fr.data && fr.data.value && fr.data.value.state && fr.data.value.state._modules;
    if (!Array.isArray(mods)) continue;
    const mod = mods.find((m) => m && m.id === MODULE);
    const sec = mod && mod.meters && mod.meters[SECTION];
    if (!sec) continue;
    (sec.levels || []).forEach((v, i) => { if (v > (lv[i] || 0)) lv[i] = v; });
    (sec.levels_hold || []).forEach((v, i) => { if (v > (hold[i] || 0)) hold[i] = v; });
  }

  const hot = Object.keys(hold).map(Number).filter((i) => hold[i] > 0).sort((a, b) => a - b);
  console.log(`frames seen: ${(s.raw || []).length}`);
  console.log(`hot channels: ${hot.length ? hot.map((i) => 'ch' + (i + 1)).join(', ') : '(none)'}`);
  for (const i of hot) console.log(`  ch${i + 1} (idx ${i}): levels(max)=${lv[i] || 0}  levels_hold(peak)=${hold[i]}`);

  const fs = hot.reduce((a, i) => Math.max(a, hold[i]), 0);
  if (fs > 0) {
    console.log(`\nPeak-hold on the hottest channel = ${fs}  (this is the full-scale integer for a 0 dBFS tone)`);
    for (const [name, val] of [['2^15', 32768], ['2^15-1', 32767], ['2^23', 8388608], ['2^23-1', 8388607]]) {
      console.log(`  if meterFullScale=${val} (${name}): a ${fs}-peak reads ${(20 * Math.log10(fs / val)).toFixed(2)} dBFS`);
    }
    console.log(`  => to make this 0 dBFS tone read exactly 0 dBFS, set meterFullScale = ${fs}`);
  } else {
    console.log('\nNo signal on that module/section. Is the tone running and routed to those inputs? Try a different MERGING_METER_MODULE/SECTION.');
  }
  eng.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
