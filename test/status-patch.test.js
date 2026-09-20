'use strict';

// Live status patches: the device broadcasts `/ravenna/status` with a PATHED value
// ($.network.PTP.Status, every ~2 s — observed on the VAD 2026-09-19) between full
// settings trees. The engine must fold those into its tree and re-read the system
// domain, or PTP lock stays frozen at whatever the last full tree said.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { RavennaEngine } = require('../index');

const tree = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'full-tree-system.json'), 'utf8'));
const find = (snap, key) => snap.find((e) => e.key === key);
const status = (p, value) => ({ channel: '/ravenna/status', data: { path: p, value } });

function seeded() {
  const eng = new RavennaEngine({ host: 'x', setTimeout: () => 0, clearTimeout: () => {} });
  eng._ingestTree(tree());
  const systems = [];
  eng.on('system', (s) => systems.push(s));
  return { eng, systems };
}

test('a pathed PTP status push updates the tree and re-emits the system snapshot', () => {
  const { eng, systems } = seeded();
  assert.strictEqual(find(eng.system, 'ptp_lock_status').raw, 3);
  eng._handleMessage(status('$.network.PTP.Status', Object.assign({}, eng.getTree().network.PTP.Status, { LockStatus: 2, ClockJitter: 41 })));
  assert.strictEqual(systems.length, 1, 'one system emission');
  assert.strictEqual(find(systems[0], 'ptp_lock_status').raw, 2);
  assert.strictEqual(find(systems[0], 'ptp_clock_jitter').raw, 41);
  assert.strictEqual(eng.getSubtree('network.PTP.Status.LockStatus'), 2);
});

test('an unchanged status push emits nothing; capabilities and catalog survive', () => {
  const { eng, systems } = seeded();
  const caps = JSON.stringify(eng.capabilities);
  const catalog = JSON.stringify(eng.catalog);
  eng._handleMessage(status('$.network.PTP.Status', Object.assign({}, eng.getTree().network.PTP.Status)));
  assert.strictEqual(systems.length, 0);
  assert.strictEqual(JSON.stringify(eng.capabilities), caps);
  assert.strictEqual(JSON.stringify(eng.catalog), catalog);
});

test('the reduced "$" status tree is still NOT ingested (it would wipe capabilities)', () => {
  const { eng, systems } = seeded();
  const caps = JSON.stringify(eng.capabilities);
  eng._handleMessage(status('$', { _modules: [{ id: 60, state: 1, type: 'x' }] }));
  assert.strictEqual(systems.length, 0);
  assert.strictEqual(JSON.stringify(eng.capabilities), caps);
});

test('filtered paths and pushes before any tree are ignored', () => {
  const { eng, systems } = seeded();
  eng._handleMessage(status('$._modules[?(@.id==60)][0].custom.outs', { attenuation: -100 }));
  assert.strictEqual(systems.length, 0);
  const fresh = new RavennaEngine({ host: 'x', setTimeout: () => 0, clearTimeout: () => {} });
  fresh.on('system', () => assert.fail('no tree yet'));
  fresh._handleMessage(status('$.network.PTP.Status', { LockStatus: 3 }));
});
