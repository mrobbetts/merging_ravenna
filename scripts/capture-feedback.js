'use strict';

/**
 * capture-feedback.js — PASSIVE protocol observer. NO writes are ever sent to the
 * device (no /service/ravenna/settings, no commands beyond the standard read-only
 * handshake/subscribe/update the engine does on connect). Use it to reverse-engineer
 * how the device reports parameter changes: run this, then toggle a parameter in the
 * device WEB UI, and watch which channel/path/value comes back.
 *
 *   MERGING_HOST=192.168.0.150 node scripts/capture-feedback.js
 *   MERGING_CAPTURE_MS=600000   (auto-close after N ms; default 10 min)
 *
 * What it logs (timestamped, sequence-numbered):
 *   - /ravenna/settings  : VERBATIM (this is where `attenuation` echoes land)
 *   - /ravenna/errors    : VERBATIM
 *   - /ravenna/status (path '$', the ~2s full tree) : suppressed to a one-line diff of
 *     WATCHED leaves (m30/m60 custom.outs scalars + channel trims) so a change that only
 *     surfaces in the full tree is still caught, without dumping the whole tree each tick.
 *   - /ravenna/status (deltas) : VERBATIM if the path mentions m30/m60, else suppressed
 *     (sink/session status churn is noise for this purpose).
 */

const { RavennaEngine } = require('../index');

const HOST = process.env.MERGING_HOST;
if (!HOST) { console.error('SKIP: set MERGING_HOST=<device-ip> (e.g. 192.168.0.150).'); process.exit(0); }

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(3).padStart(8);

const WATCH_MODULES = [30, 60];
function extractWatched(tree) {
  const out = {};
  if (!tree || !Array.isArray(tree._modules)) return out;
  for (const id of WATCH_MODULES) {
    const m = tree._modules.find((x) => x && x.id === id);
    const o = m && m.custom && m.custom.outs;
    if (!o) continue;
    out[id] = {
      attenuation: o.attenuation,
      mute: o.mute,
      roll_off_filter: o.roll_off_filter,
      out_max_level: o.out_max_level,
      trims: Array.isArray(o.channels) ? o.channels.map((c) => c && c.trim) : null
    };
  }
  return out;
}
function diffWatched(prev, cur) {
  const changes = [];
  for (const id of WATCH_MODULES) {
    const a = (prev && prev[id]) || {}; const b = (cur && cur[id]) || {};
    for (const k of ['attenuation', 'mute', 'roll_off_filter', 'out_max_level', 'trims']) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
        changes.push(`m${id}.${k}: ${JSON.stringify(a[k])} -> ${JSON.stringify(b[k])}`);
      }
    }
  }
  return changes;
}

const eng = new RavennaEngine({ host: HOST });
let watched = null;
let seq = 0;
let suppressed = 0;

eng.on('raw', (m) => {
  const ch = m && m.channel;
  if (!ch || ch.startsWith('/meta/') || ch === '/ravenna/meter') return;

  if (ch === '/ravenna/settings' || ch === '/ravenna/errors') {
    const d = m.data;
    if (ch === '/ravenna/settings' && d && d.path === '$') { // a full tree can arrive on settings too
      const cur = extractWatched(d.value); const changes = watched ? diffWatched(watched, cur) : []; watched = cur;
      console.log(`[${ts()}] #${++seq} ${ch} [full tree] ${changes.length ? 'CHANGED: ' + changes.join(' | ') : '(no watched change)'}`);
      return;
    }
    console.log(`[${ts()}] #${++seq} ${ch}  path=${d && d.path}`);
    console.log(`           value=${JSON.stringify(d && d.value)}`);
    return;
  }

  if (ch === '/ravenna/status') {
    const d = m.data;
    if (d && d.path === '$') {
      const cur = extractWatched(d.value); const changes = watched ? diffWatched(watched, cur) : []; watched = cur;
      if (changes.length) console.log(`[${ts()}] #${++seq} ${ch} [full tree] CHANGED: ${changes.join(' | ')}`);
      return; // quietly absorb unchanged ~2s full-tree ticks
    }
    if (/id==(30|60)/.test(String(d && d.path))) {
      console.log(`[${ts()}] #${++seq} ${ch}  path=${d.path}`);
      console.log(`           value=${JSON.stringify(d.value)}`);
    } else { suppressed++; }
    return;
  }

  console.log(`[${ts()}] #${++seq} OTHER ${ch}: ${JSON.stringify(m).slice(0, 400)}`);
});

eng.on('online', () => console.log(`[${ts()}] ONLINE ${HOST} — baseline watched = ${JSON.stringify(watched)}`));
eng.on('offline', (r) => console.log(`[${ts()}] OFFLINE (${r})`));
eng.on('error', (e) => console.log(`[${ts()}] engine error: ${e.message}`));

console.log('PASSIVE capture — this process NEVER writes to the device.');
console.log(`Connecting to ${HOST}. When ONLINE, toggle ONE parameter at a time in the WEB UI,`);
console.log('pausing ~2s between each so they are easy to tell apart by timestamp.');
console.log('Suggested: m60 D/A mute on/off, then roll-off filter, then a channel trim, then out_max_level (+18/+24).');
console.log('-----------------------------------------------------------------------------------------------');
eng.connect();

const MAX_MS = parseInt(process.env.MERGING_CAPTURE_MS || '600000', 10);
const closer = setTimeout(() => { console.log(`[${ts()}] window elapsed (${MAX_MS}ms); suppressed ${suppressed} non-watched status deltas; closing.`); eng.close(); process.exit(0); }, MAX_MS);
closer.unref && closer.unref();
const bye = (sig) => { console.log(`\n[${ts()}] ${sig} — closing (suppressed ${suppressed} non-watched status deltas).`); eng.close(); process.exit(0); };
process.on('SIGINT', () => bye('SIGINT'));
process.on('SIGTERM', () => bye('SIGTERM'));
