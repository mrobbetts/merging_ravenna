'use strict';

// System-domain read model, pinned to a REAL (sanitized) full settings tree captured
// from a Hapi MkII (fw 1.9.0b62872). The reduced full-tree.json fixture only has
// _modules/identity/state; this one has the real top-level keys (ios, network.PTP,
// capabilities, etc.) where the system data actually lives.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { readSystem, groupSystem, bootTimeMs, systemWriteFrame } = require('../src/system');
const { RavennaEngine } = require('../index');

const tree = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'full-tree-system.json'), 'utf8'));

function find(snap, key) { return snap.find((e) => e.key === key); }

test('reads the current sample rate with a kHz enum from capabilities', () => {
  const snap = readSystem(tree);
  const sr = find(snap, 'sample_rate');
  assert.ok(sr, 'sample_rate present');
  assert.strictEqual(sr.raw, 44100);
  assert.strictEqual(sr.unit, 'Hz');
  assert.strictEqual(sr.value, '44.1 kHz', 'value resolves to a friendly label');
  assert.deepStrictEqual(sr.enum, {
    '44.1 kHz': 44100, '48 kHz': 48000, '88.2 kHz': 88200, '96 kHz': 96000,
    '176.4 kHz': 176400, '192 kHz': 192000, '352.8 kHz': 352800, '384 kHz': 384000
  });
});

test('reads frame size with the device-advertised integer enum', () => {
  const fs2 = find(readSystem(tree), 'frame_size');
  assert.strictEqual(fs2.raw, 48);
  assert.strictEqual(fs2.unit, 'samples');
  assert.deepStrictEqual(fs2.enum, { '6': 6, '12': 12, '16': 16, '32': 32, '48': 48, '64': 64 });
});

test('reads clock source as a labeled enum built from the Sync module sources', () => {
  const ss = find(readSystem(tree), 'sync_source');
  assert.strictEqual(ss.raw, 0);
  assert.strictEqual(ss.value, 'Internal', 'current source resolves to its name');
  assert.deepStrictEqual(ss.enum, { 'Internal': 0, 'RAVENNA/AES67': 1, 'WCK': 2, 'Video': 3 });
});

test('reads PTP status telemetry as read-only', () => {
  const snap = readSystem(tree);
  const gmid = find(snap, 'ptp_grandmaster_id');
  assert.strictEqual(gmid.raw, '00-00-00-00-00-00-00-00');
  assert.strictEqual(gmid.readonly, true);
  assert.strictEqual(gmid.settable, false);
  assert.strictEqual(find(snap, 'ptp_is_master').raw, true);
  assert.strictEqual(find(snap, 'ptp_lock_status').raw, 3);
});

test('reads health telemetry from the ZMAN module', () => {
  const snap = readSystem(tree);
  assert.strictEqual(find(snap, 'temperature').unit, 'celsius');
  assert.strictEqual(typeof find(snap, 'temperature').raw, 'number');
  assert.strictEqual(find(snap, 'panic').raw, false);
});

test('derives uptime in seconds from boot_time using an injectable now', () => {
  const boot = '2026-06-06 20:13:27';
  const now = bootTimeMs(boot) + 3661 * 1000; // +1h 1m 1s
  const up = find(readSystem(tree, { now }), 'uptime');
  assert.strictEqual(up.raw, boot);
  assert.strictEqual(up.value, 3661);
  assert.strictEqual(up.unit, 'seconds');
});

test('settability matches probe-confirmed write shapes (read-only never settable)', () => {
  const snap = readSystem(tree);
  // pure telemetry can never be settable
  for (const e of snap) if (e.readonly) assert.strictEqual(e.settable, false, `${e.key} is read-only`);
  // probe-confirmed writables
  for (const key of ['sample_rate', 'frame_size', 'sync_source', 'ptp_domain', 'auto_save', 'spdif_physical_mode']) {
    assert.strictEqual(find(snap, key).settable, true, `${key} confirmed settable`);
  }
  // priorities are settable but carry a dependency note (manual-master only)
  for (const key of ['ptp_priority1', 'ptp_priority2']) {
    const e = find(snap, key);
    assert.strictEqual(e.settable, true, `${key} settable under manual master`);
    assert.match(e.note, /manual/, `${key} notes the manual-master dependency`);
  }
  // consumer_mode did NOT apply via standard set -> not settable, with a note
  const cm = find(snap, 'consumer_mode');
  assert.strictEqual(cm.settable, false, 'consumer_mode not settable');
  assert.ok(cm.note, 'consumer_mode carries an explanatory note');
});

test('absent fields are simply skipped (degrades on unknown firmware)', () => {
  const snap = readSystem({ identity: { product: 'X', serial: 'Y' } });
  assert.ok(find(snap, 'product'));
  assert.ok(!find(snap, 'sample_rate'), 'no ios -> no sample_rate entry');
  assert.ok(!find(snap, 'ptp_grandmaster_id'), 'no network -> no PTP entry');
});

test('readSystem returns [] for junk input', () => {
  assert.deepStrictEqual(readSystem(null), []);
  assert.deepStrictEqual(readSystem(42), []);
});

test('groupSystem buckets by group in descriptor order', () => {
  const groups = groupSystem(readSystem(tree));
  const names = groups.map((g) => g.group);
  assert.deepStrictEqual(names, ['Clock', 'Sync', 'PTP', 'Device', 'Health', 'Advanced']);
  assert.ok(groups[0].params.length >= 1);
});

// ---- write model (probe-confirmed shapes) ---------------------------------

test('systemWriteFrame builds the confirmed top-level / module / network shapes', () => {
  assert.deepStrictEqual(systemWriteFrame('frame_size', 32, tree),
    { path: '$', value: { _frame_size_at_1FS: 32 } });
  assert.deepStrictEqual(systemWriteFrame('auto_save', false, tree),
    { path: '$', value: { _auto_save: false } });
  assert.deepStrictEqual(systemWriteFrame('wordclock_termination', true, tree),
    { path: '$._modules[?(@.id==2)][0]', value: { wordclock_termination: true } });
  assert.deepStrictEqual(systemWriteFrame('ptp_domain', 1, tree),
    { path: '$.network.PTP', value: { Domain: 1 } });
  assert.deepStrictEqual(systemWriteFrame('ptp_manual_master', true, tree),
    { path: '$.network.PTP.Master', value: { Manual: true } });
  assert.deepStrictEqual(systemWriteFrame('spdif_physical_mode', 0, tree),
    { path: '$._modules[?(@.id==100)][0]', value: { physical_mode: 0 } });
});

test('systemWriteFrame resolves enum labels (sample rate, clock source)', () => {
  assert.deepStrictEqual(systemWriteFrame('sample_rate', '48 kHz', tree),
    { path: '$.ios[?(@.id=="1")][0].configuration', value: { sampleRate: 48000 } });
  assert.deepStrictEqual(systemWriteFrame('sample_rate', 96000, tree).value, { sampleRate: 96000 });
  // clock source by name (case-insensitive) and by raw input_id
  assert.deepStrictEqual(systemWriteFrame('sync_source', 'RAVENNA/AES67', tree),
    { path: '$._modules[?(@.id==2)][0]', value: { sync_source: { module_id: 2, input_id: 1 } } });
  assert.deepStrictEqual(systemWriteFrame('sync_source', 'internal', tree).value.sync_source.input_id, 0);
  assert.deepStrictEqual(systemWriteFrame('sync_source', 3, tree).value.sync_source.input_id, 3);
});

test('systemWriteFrame coerces bool/int and rejects junk + non-settable keys', () => {
  assert.strictEqual(systemWriteFrame('auto_save', 'true', tree).value._auto_save, true);
  assert.strictEqual(systemWriteFrame('auto_save', 0, tree).value._auto_save, false);
  assert.strictEqual(systemWriteFrame('frame_size', '16', tree).value._frame_size_at_1FS, 16);
  assert.throws(() => systemWriteFrame('frame_size', 'nonsense', tree), /Invalid numeric/);
  assert.throws(() => systemWriteFrame('consumer_mode', true, tree), /not settable/);
  assert.throws(() => systemWriteFrame('serial', 'x', tree), /not settable/);
  assert.throws(() => systemWriteFrame('nope', 1, tree), /Unknown system parameter/);
});

test('engine.setSystem publishes the resolved frame', () => {
  const eng = new RavennaEngine({ host: 'x' });
  eng._ingestTree(tree);
  eng.clientId = 'c';
  const sent = [];
  eng.publishSettings = (path, value) => { sent.push({ path, value }); return true; };
  eng.setSystem('sample_rate', '48 kHz');
  eng.setSystem('sync_source', 'WCK');
  assert.deepStrictEqual(sent[0], { path: '$.ios[?(@.id=="1")][0].configuration', value: { sampleRate: 48000 } });
  assert.deepStrictEqual(sent[1].value.sync_source, { module_id: 2, input_id: 2 });
  assert.throws(() => eng.setSystem('consumer_mode', true), /not settable/);
});

test('engine exposes getSystem()/getTree()/getSubtree() and emits a system event', () => {
  const eng = new RavennaEngine({ host: 'x' });
  const events = [];
  eng.on('system', (s) => events.push(s));
  eng._ingestTree(tree);

  assert.strictEqual(events.length, 1, 'one system event per tree ingest');
  assert.ok(eng.getSystem().length > 10, 'snapshot populated');
  assert.strictEqual(eng.getTree(), tree, 'raw tree exposed');

  // getSubtree: dotted path + $ + missing
  assert.strictEqual(eng.getSubtree('identity.serial'), 'H10000');
  assert.strictEqual(eng.getSubtree('network.PTP.Status.LockStatus'), 3);
  assert.strictEqual(eng.getSubtree('$'), tree);
  assert.strictEqual(eng.getSubtree('nope.not.here'), null);
});
