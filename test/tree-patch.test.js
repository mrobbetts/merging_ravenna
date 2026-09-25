'use strict';

// Live tree patching, all shapes seen on hardware (probe-system-H96149.json):
//   - a settings echo at "$" carrying ONE key ({ _auto_sample_rate: false }) — not a tree
//   - pathed settings echoes: $.ios, $.network.PTP, $._modules[?(@.id==2)][0]
//   - the periodic REDUCED status "$" (modules carry only { state, id, type })
// plus the socket-level guards: a refused reply is not a sign of life, and a socket
// that never opens is still torn down.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const { RavennaEngine } = require('../index');

const tree = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'full-tree-system.json'), 'utf8'));
const find = (snap, key) => snap.find((e) => e.key === key);
const frame = (channel, p, value) => ({ channel, data: { path: p, value } });
const inert = { setTimeout: () => 0, clearTimeout: () => {} };

function seeded() {
  const eng = new RavennaEngine({ host: 'x', ...inert });
  eng._ingestTree(tree());
  const systems = [];
  const trees = [];
  eng.on('system', (s) => systems.push(s));
  eng.on('tree', (t) => trees.push(t));
  return { eng, systems, trees, caps: JSON.stringify(eng.capabilities), catalog: eng.catalog.length };
}

test('a one-key settings echo at "$" merges into the tree instead of replacing it', () => {
  const { eng, systems, trees, caps, catalog } = seeded();
  assert.strictEqual(find(eng.system, 'auto_sample_rate').raw, true);
  eng._handleMessage(frame('/ravenna/settings', '$', { _auto_sample_rate: false }));
  assert.strictEqual(trees.length, 0, 'not ingested as a tree');
  assert.strictEqual(JSON.stringify(eng.capabilities), caps);
  assert.strictEqual(eng.catalog.length, catalog);
  assert.ok(Array.isArray(eng.getTree()._modules), 'modules survive');
  assert.strictEqual(find(systems[0], 'auto_sample_rate').raw, false);
});

test('a full settings tree at "$" (with _modules) is still ingested authoritatively', () => {
  const { eng, trees } = seeded();
  eng._handleMessage(frame('/ravenna/settings', '$', tree()));
  assert.strictEqual(trees.length, 1);
});

test('pathed settings echoes ($.ios, $.network.PTP) refresh the system domain', () => {
  const { eng, systems } = seeded();
  const ios = tree().ios;
  ios[0].configuration.sampleRate = 48000;
  eng._handleMessage(frame('/ravenna/settings', '$.ios', ios));
  assert.strictEqual(find(systems.at(-1), 'sample_rate').raw, 48000);
  const before = systems.length;
  eng._handleMessage(frame('/ravenna/settings', '$.network.PTP', { Status: { LockStatus: 1 } }));
  assert.strictEqual(find(systems.at(-1), 'ptp_lock_status').raw, 1);
  assert.strictEqual(systems.length, before + 1);
  // a merge: the rest of network.PTP survived
  assert.ok(Object.keys(eng.getTree().network.PTP).length > 1);
});

test('a module addressed by id merges into that module, keeping everything beside the change', () => {
  const { eng, systems } = seeded();
  const m2 = eng.getTree()._modules.find((m) => m.id === 2);
  const keysBefore = Object.keys(m2).length;
  eng._handleMessage(frame('/ravenna/settings', '$._modules[?(@.id==2)][0]', { id: 2, sync_source: { input_id: 1 } }));
  assert.strictEqual(find(systems.at(-1), 'sync_source').raw, 1);
  assert.strictEqual(Object.keys(m2).length, keysBefore, 'no keys lost');
  assert.strictEqual(m2.sync_source.module_id, 2, 'sibling key inside the merged object kept');
});

test('the reduced status "$" folds module health state only; capabilities untouched', () => {
  const { eng, systems, trees, caps } = seeded();
  const m0 = eng.getTree()._modules.find((m) => m.id === 0);
  const custom = JSON.stringify(m0.custom ?? null);
  eng._handleMessage(frame('/ravenna/status', '$', { _modules: [{ id: 0, type: m0.type, state: { temperature: 70, panic: true } }], state: { muted: true } }));
  assert.strictEqual(trees.length, 0);
  assert.strictEqual(JSON.stringify(eng.capabilities), caps);
  assert.strictEqual(JSON.stringify(m0.custom ?? null), custom);
  assert.strictEqual(find(systems.at(-1), 'temperature').raw, 70);
  assert.strictEqual(find(systems.at(-1), 'panic').raw, true);
  assert.ok(m0.state.cpu_load != null, 'unmentioned health fields kept');
});

test('a refused reply tears the session down instead of counting as life', () => {
  const eng = new RavennaEngine({ host: 'x', ...inert });
  eng._ingestTree(tree());
  eng.online = true;
  const offline = [];
  eng.on('offline', (r) => offline.push(r));
  eng.on('error', () => {});
  eng._handleMessage({ channel: '/meta/subscribe', successful: false, error: '402::Unknown client' });
  assert.deepStrictEqual(offline, ['refused']);
});

// ---- socket that never opens ---------------------------------------------------------
function makeClock() {
  let now = 0, seq = 1;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { const id = seq++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= target && (next === null || t.at < next.at)) next = { id, ...t };
        if (!next) break;
        now = next.at; timers.delete(next.id); next.fn();
      }
      now = target;
    },
  };
}
class NeverOpens extends EventEmitter {
  constructor(url, opts) { super(); NeverOpens.opts = opts; NeverOpens.count++; this.readyState = 0; }
  send() {}
  close() { this.readyState = 3; }
}
NeverOpens.OPEN = 1;
NeverOpens.count = 0;

test('a socket that never completes the upgrade is torn down and retried', () => {
  const clock = makeClock();
  const eng = new RavennaEngine({ host: 'x', WebSocket: NeverOpens, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, livenessMs: 7000, probeGraceMs: 3000, backoff: [2000] });
  const status = [];
  eng.on('status', (s) => status.push(s));
  eng.on('error', () => {});
  eng.connect();
  assert.strictEqual(NeverOpens.opts.handshakeTimeout, 10000, 'ws is told to time the upgrade out');
  assert.strictEqual(NeverOpens.count, 1);
  clock.advance(10001); // liveness + grace with no frame ever
  assert.ok(status.includes('stale'), 'declared stale without ever opening');
  clock.advance(2000); // backoff
  assert.strictEqual(NeverOpens.count, 2, 'a fresh socket was attempted');
});
