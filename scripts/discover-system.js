'use strict';

/**
 * discover-system.js — READ-ONLY discovery of the device's SYSTEM domain.
 *
 * We model the audio cards (D/A, Headphone) well, but the system modules a Hapi
 * advertises — ZMAN (clock/network), Stream (RTP), Sync (PTP), SPDIF — arrive
 * with an EMPTY `custom` in the settings tree we subscribe to. The things we want
 * (sample rate, PTP grandmaster/lock/offset, uptime, stream state) must therefore
 * live somewhere else: either behind a different command, or on a CometD channel
 * the web UI subscribes to that we don't.
 *
 * This tool connects, asks for the full tree, and then:
 *   1. Dumps the FULL system modules (ids 0/1/2/100) so we can see if they expand.
 *   2. Captures EVERY frame on EVERY channel for a window (via the engine's 'raw'
 *      event), keeping full payloads for any non-standard channel.
 *   3. Speculatively SUBSCRIBES to a few candidate system channels — harmless in
 *      CometD (a nonexistent channel just replies unsuccessful) — to see if any of
 *      them start streaming clock/PTP/system data.
 *   4. Writes a JSON report you can attach for modeling, and prints a summary.
 *
 * It NEVER writes a setting. Safe to run with audio playing.
 *
 *   MERGING_HOST=192.168.0.150 node scripts/discover-system.js
 *
 * Env:
 *   MERGING_HOST        device IP (required; absent -> no-op skip)
 *   MERGING_WINDOW_MS   observation window in ms (default 20000)
 *   MERGING_REPORT      output path (default ./system-discovery-<serial|host>.json)
 */

const fs = require('node:fs');
const { RavennaEngine } = require('../index');
const PKG = require('../package.json');

const HOST = process.env.MERGING_HOST;
const WINDOW_MS = parseInt(process.env.MERGING_WINDOW_MS || '20000', 10);

if (!HOST) {
  console.error('discover-system: set MERGING_HOST=<device ip> to run (read-only, safe with audio on).');
  process.exit(2);
}

// Channels the engine already subscribes to / knows about — everything else is "interesting".
const KNOWN_CHANNELS = new Set([
  '/meta/handshake', '/meta/connect', '/meta/subscribe', '/meta/unsubscribe',
  '/ravenna/settings', '/ravenna/status', '/ravenna/errors', '/ravenna/meter',
  '/service/ravenna/commands', '/service/ravenna/settings'
]);

// Candidate system/clock channels the web UI MIGHT use. Subscribing to a channel
// that doesn't exist is harmless: the broker replies { successful: false }.
const CANDIDATE_CHANNELS = [
  '/ravenna/ptp', '/ravenna/clock', '/ravenna/sync', '/ravenna/system',
  '/ravenna/info', '/ravenna/io', '/ravenna/network', '/ravenna/device',
  '/ravenna/streams', '/ravenna/zone', '/ravenna/aes67'
];

// Non-audio "system" modules on a Hapi MkII (by id). Audio cards are 30 & 60.
const SYSTEM_MODULE_IDS = [0, 1, 2, 100];

const eng = new RavennaEngine({ host: HOST });

const channelCounts = {};         // channel -> count of frames seen
const interestingFrames = [];     // full payloads for non-standard channels
const subscribeResults = {};      // subscription -> successful?
let tree = null;
let nextId = 100000;              // ids well clear of the engine's own counter

function ts() { return new Date().toISOString(); }

eng.on('error', (e) => console.error('  [error]', e && e.message ? e.message : e));

eng.on('raw', (m) => {
  if (!m || !m.channel) return;
  const ch = m.channel;
  channelCounts[ch] = (channelCounts[ch] || 0) + 1;

  // Record subscribe outcomes (ours + the engine's).
  if (ch === '/meta/subscribe' && m.subscription) subscribeResults[m.subscription] = !!m.successful;

  // Keep FULL payloads for anything off the beaten path — that's where undiscovered
  // system data would surface. Cap to avoid an unbounded report.
  if (!KNOWN_CHANNELS.has(ch) && interestingFrames.length < 200) {
    interestingFrames.push({ at: ts(), channel: ch, data: m.data, message: m });
  }
});

eng.on('tree', (t) => { tree = t; });

// Once the engine has handshaken + subscribed (status 'connected'), fire our own
// speculative subscriptions on the same socket using the engine's clientId.
let probed = false;
eng.on('status', (s) => {
  console.log(`  [${ts()}] status: ${s}`);
  if (s === 'connected' && !probed) {
    probed = true;
    setTimeout(() => {
      if (!eng.clientId) return;
      console.log(`  [${ts()}] probing ${CANDIDATE_CHANNELS.length} candidate channels (subscribe-only, harmless)…`);
      eng._send(CANDIDATE_CHANNELS.map((subscription) => ({
        channel: '/meta/subscribe', subscription, id: String(nextId++), clientId: eng.clientId
      })));
      // Nudge another full update too, in case modules expand on a second pass.
      eng.requestUpdate();
    }, 1200);
  }
});

function summariseModule(m) {
  const custom = m && m.custom ? m.custom : {};
  const sections = Object.keys(custom);
  return {
    id: m.id, type: m.type, sub_type: m.sub_type, name: m.name,
    customSections: sections,
    customEmpty: sections.length === 0,
    custom // full content — the whole point
  };
}

function finish() {
  const ident = (tree && tree.identity) || {};
  const serial = ident.serial || HOST.replace(/[^\w.-]/g, '_');
  const reportPath = process.env.MERGING_REPORT || `./system-discovery-${serial}.json`;

  const mods = (tree && Array.isArray(tree._modules)) ? tree._modules : [];
  const systemModules = mods
    .filter((m) => SYSTEM_MODULE_IDS.includes(m.id))
    .map(summariseModule);

  const report = {
    tool: 'discover-system',
    toolVersion: PKG.version,
    timestamp: ts(),
    host: HOST,
    windowMs: WINDOW_MS,
    identity: ident,
    state: (tree && tree.state) || null,
    moduleIndex: mods.map((m) => ({ id: m.id, type: m.type, sub_type: m.sub_type, name: m.name,
      customSections: m.custom ? Object.keys(m.custom) : [] })),
    systemModules,                       // full custom for ids 0/1/2/100
    channelsSeen: channelCounts,
    candidateSubscribeResults: subscribeResults,
    interestingFrames,                   // full payloads off the standard channels
    fullTree: tree                       // everything, so nothing is lost
  };

  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } catch (e) {
    console.error('  could not write report:', e.message);
  }

  // ---- human summary ----
  console.log('\n================ SYSTEM DISCOVERY SUMMARY ================');
  console.log(`device   : ${ident.vendor || '?'} ${ident.product || '?'}  serial ${ident.serial || '?'}`);
  console.log(`state    : ${JSON.stringify(report.state)}`);
  console.log('\nsystem modules (do their custom sections carry anything?):');
  if (!systemModules.length) console.log('  (no tree received — is the host reachable?)');
  for (const m of systemModules) {
    const tag = m.customEmpty ? 'EMPTY' : `[${m.customSections.join(', ')}]`;
    console.log(`  id=${m.id} ${String(m.name).padEnd(8)} type=${m.type} → custom ${tag}`);
    if (!m.customEmpty) console.log('     ' + JSON.stringify(m.custom).slice(0, 400));
  }
  console.log('\nchannels seen (frame counts):');
  for (const [ch, n] of Object.entries(channelCounts)) console.log(`  ${String(n).padStart(4)}  ${ch}`);
  const accepted = Object.entries(subscribeResults).filter(([, ok]) => ok).map(([c]) => c);
  const candidatesAccepted = accepted.filter((c) => CANDIDATE_CHANNELS.includes(c));
  console.log('\ncandidate channels that ACCEPTED a subscription:');
  console.log('  ' + (candidatesAccepted.length ? candidatesAccepted.join(', ') : '(none — system data is not on any guessed channel)'));
  if (interestingFrames.length) {
    console.log(`\n${interestingFrames.length} frame(s) arrived on NON-standard channels — see report.`);
  }
  console.log(`\nfull report written to: ${reportPath}`);

  console.log('\n---------------- the most useful next step ----------------');
  console.log('The web UI definitely shows sample rate / PTP / uptime, so its WebSocket frames');
  console.log('reveal the exact mechanism. To capture them:');
  console.log('  1. Open the Hapi web UI in Chrome, then DevTools (Cmd-Opt-I) → Network → filter "WS".');
  console.log('  2. Click the cometd/handshake socket → "Messages" tab.');
  console.log('  3. Navigate the UI pages that show CLOCK / PTP / SYNC / STATUS / ABOUT, and watch new');
  console.log('     frames appear. Right-click a frame → "Copy message", or screenshot the list.');
  console.log('  4. Send me: any /meta/subscribe to channels NOT in the list above, and any frame whose');
  console.log('     payload contains sample rate / ptp / grandmaster / uptime. That pins down channel + shape.');
  console.log('===========================================================\n');

  try { eng.close(); } catch (e) { /* ignore */ }
  process.exit(0);
}

console.log(`discover-system: connecting to ${HOST} (READ-ONLY; safe with audio on). Observing ${WINDOW_MS} ms…`);
eng.connect();
setTimeout(finish, WINDOW_MS);

process.on('SIGINT', () => { console.log('\n(interrupted — writing what we have)'); finish(); });
