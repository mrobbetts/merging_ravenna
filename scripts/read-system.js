'use strict';

/**
 * read-system.js — READ-ONLY: print the live system-domain snapshot (getSystem()),
 * grouped, plus a couple of raw subtrees. Never writes. Safe with audio playing.
 *
 *   MERGING_HOST=192.168.0.152 node scripts/read-system.js
 */

const { RavennaEngine, system } = require('../index');

const HOST = process.env.MERGING_HOST;
if (!HOST) { console.error('set MERGING_HOST=<device ip>'); process.exit(2); }

const eng = new RavennaEngine({ host: HOST });
let done = false;

function fmt(e) {
  let v = e.value;
  if (e.unit === 'seconds' && typeof v === 'number') {
    const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), s = v % 60;
    v = `${v} s  (${h}h ${m}m ${s}s)`;
  }
  if (e.unit === 'celsius') v = v + ' °C';
  const tag = e.readonly ? '  (read-only)' : '';
  return `    ${e.label.padEnd(34)} ${String(v)}${tag}`;
}

function finish(reason) {
  if (done) return; done = true;
  const snap = eng.getSystem();
  if (!snap.length) {
    console.log(`\n(no snapshot — ${reason}. Is ${HOST} reachable / powered on?)`);
  } else {
    console.log('\n================ LIVE SYSTEM SNAPSHOT ================');
    for (const g of system.groupSystem(snap)) {
      console.log(`\n[${g.group}]`);
      for (const e of g.params) console.log(fmt(e));
    }
    console.log('\n---- a couple of raw subtrees (generic passthrough) ----');
    console.log('network.PTP.Status =', JSON.stringify(eng.getSubtree('network.PTP.Status')));
    console.log('identity           =', JSON.stringify(eng.getSubtree('identity')).slice(0, 200));
  }
  try { eng.close(); } catch (e) { /* ignore */ }
  process.exit(0);
}

eng.on('error', (e) => console.error('  [error]', e && e.message ? e.message : e));
eng.on('system', () => finish('system event'));   // fires as soon as the first full tree lands

console.log(`read-system: connecting to ${HOST} (READ-ONLY)…`);
eng.connect();
setTimeout(() => finish('timeout'), 8000);
