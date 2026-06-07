'use strict';

/**
 * probe-ptp-priority.js — confirm whether PTP Prio1/Prio2 become settable once
 * manual-grandmaster mode is on. The general probe set them while Manual=false and
 * they did NOT apply; this establishes Manual=true FIRST, then nudges a priority,
 * re-reads, and restores BOTH the priority and Manual.
 *
 * WRITES TO THE DEVICE (PTP policy). Run with audio OFF.
 *   MERGING_HOST=192.168.0.152 MERGING_I_UNDERSTAND=1 node scripts/probe-ptp-priority.js
 */

const { RavennaEngine } = require('../index');

const HOST = process.env.MERGING_HOST;
const I_UNDERSTAND = process.env.MERGING_I_UNDERSTAND === '1';
const SKIP_METER = process.env.MERGING_SKIP_METER_CHECK === '1';
const TIMEOUT_MS = parseInt(process.env.MERGING_TIMEOUT_MS || '3000', 10);
const SETTLE_MS = 350;
if (!HOST) { console.error('set MERGING_HOST=<device ip>'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const eng = new RavennaEngine({ host: HOST });
  eng.on('error', (e) => console.error('engine error:', e && e.message));
  const waitOnce = (event, ms) => new Promise((resolve) => {
    let done = false; const to = setTimeout(() => { if (!done) { done = true; eng.off(event, h); resolve(null); } }, ms);
    function h(a) { if (done) return; done = true; clearTimeout(to); eng.off(event, h); resolve(a); }
    eng.on(event, h);
  });
  const readMaster = async () => { eng.requestUpdate(); await waitOnce('tree', TIMEOUT_MS); return eng.getSubtree('network.PTP.Master'); };

  console.log(`probe-ptp-priority → ${HOST} (${I_UNDERSTAND ? 'WRITE' : 'DRY RUN'})`);
  eng.connect();
  if (!(await waitOnce('system', 8000))) { console.error('ABORT: no snapshot.'); eng.close(); process.exit(1); }

  const base = eng.getSubtree('network.PTP.Master');
  console.log(`baseline: Manual=${base.Manual}  Prio1=${base.Prio1}  Prio2=${base.Prio2}`);
  if (!I_UNDERSTAND) { console.log('Dry run — nothing written. Add MERGING_I_UNDERSTAND=1 (audio OFF).'); eng.close(); process.exit(0); }

  // meter gate (output silence)
  if (!SKIP_METER) {
    const s = await eng.sampleMeters(1500);
    let maxOut = 0;
    for (const fr of (s.raw || [])) {
      const mods = fr.data && fr.data.value && fr.data.value.state && fr.data.value.state._modules;
      if (Array.isArray(mods)) for (const mod of mods) { const lv = mod.meters && mod.meters.outs && mod.meters.outs.levels; if (Array.isArray(lv)) for (const x of lv) if (x > maxOut) maxOut = x; }
    }
    if (!s.raw || !s.raw.length) { console.error('ABORT: no meter frames.'); eng.close(); process.exit(1); }
    if (maxOut > 64) { console.error(`ABORT: output meters show signal (peak ${maxOut}). Stop audio first.`); eng.close(); process.exit(1); }
    console.log(`meter pre-flight: outputs silent (peak ${maxOut}).`);
  }

  // crash-safe restore of both fields
  const restore = () => {
    try { eng.publishSettings('$.network.PTP.Master', { Prio1: base.Prio1, Prio2: base.Prio2 }); } catch (_) {}
    try { eng.publishSettings('$.network.PTP.Master', { Manual: base.Manual }); } catch (_) {}
  };
  process.on('SIGINT', () => { console.error('\nInterrupted — restoring…'); restore(); setTimeout(() => process.exit(130), 1000); });

  // 1) enable manual grandmaster
  eng.publishSettings('$.network.PTP.Master', { Manual: true });
  await sleep(SETTLE_MS);
  let m = await readMaster();
  const manualOn = m.Manual === true;
  console.log(`set Manual=true → now Manual=${m.Manual}  ${manualOn ? '(precondition met)' : '(FAILED to enable manual)'}`);

  // 2) nudge Prio1 under manual mode
  const target = base.Prio1 + 1 <= 255 ? base.Prio1 + 1 : base.Prio1 - 1;
  eng.publishSettings('$.network.PTP.Master', { Prio1: target });
  await sleep(SETTLE_MS);
  m = await readMaster();
  const prioApplied = m.Prio1 === target;
  console.log(`set Prio1=${target} (under manual) → now Prio1=${m.Prio1}  ${prioApplied ? 'APPLIED' : 'NOT_APPLIED'}`);

  // 3) restore both + verify
  restore();
  await sleep(SETTLE_MS);
  m = await readMaster();
  const restored = m.Manual === base.Manual && m.Prio1 === base.Prio1 && m.Prio2 === base.Prio2;
  console.log(`restore → Manual=${m.Manual} Prio1=${m.Prio1} Prio2=${m.Prio2}  ${restored ? 'RESTORED' : 'RESTORE-FAILED'}`);

  console.log('\nCONCLUSION:');
  if (prioApplied && manualOn) console.log('  PTP priorities ARE settable, but only when ptp_manual_master is true. Shape: $.network.PTP.Master ⇐ {Prio1|Prio2: n}');
  else if (manualOn) console.log('  PTP priorities did NOT apply even under manual mode — keep non-settable; mechanism unknown.');
  else console.log('  Could not enable manual mode — inconclusive.');

  eng.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
