'use strict';

// Offline coverage for the shippable validator's pure logic (scripts/validate-device.js).
// The script guards its live driver behind `require.main === module`, so requiring it
// here only pulls in the helpers — no device connection.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { buildCatalog } = require('../index');
const V = require('../scripts/validate-device.js');

const tree = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'full-tree.json'), 'utf8')).data.value;
const cat = buildCatalog(tree);
const da = (key, ch) => cat.find((e) => e.moduleId === 60 && e.key === key && (ch == null || e.channelIndex === ch));
const close = (a, b) => Math.abs(a - b) < 1e-6;

test('nudgeTarget produces a reversible, in-range target for each param kind', () => {
  const att = da('attenuation');
  assert.ok(close(V.nudgeTarget(att), att.value + (att.value + (att.step || 0.1) <= att.max ? (att.step || 0.1) : -(att.step || 0.1))));
  assert.strictEqual(V.nudgeTarget(da('mute')), !da('mute').value);
  const ro = da('roll_off_filter');
  assert.notStrictEqual(V.nudgeTarget(ro), ro.value);
  assert.ok(Object.values(ro.enum).includes(V.nudgeTarget(ro)));
  assert.strictEqual(V.nudgeTarget(da('out_max_level')), da('out_max_level').value === 0 ? 1 : 0);
  // trim max is 0 dB, so a 0 baseline must nudge DOWN, staying in range
  const tr = da('channel_trim', 0);
  assert.ok(V.nudgeTarget(tr) <= (tr.max == null ? Infinity : tr.max));
});

test('narrowFrame builds the library .custom.outs set frame (tenths for dB params)', () => {
  assert.deepStrictEqual(V.narrowFrame(da('attenuation'), -20), {
    path: '$._modules[?(@.id==60)][0].custom.outs', value: { attenuation: -200 }
  });
  assert.deepStrictEqual(V.narrowFrame(da('mute'), true), {
    path: '$._modules[?(@.id==60)][0].custom.outs', value: { mute: true }
  });
  const tf = V.narrowFrame(da('channel_trim', 2), -3);
  assert.strictEqual(tf.path, '$._modules[?(@.id==60)][0].custom.outs');
  assert.deepStrictEqual(tf.value.channels[2], { trim: -30 });
  assert.deepStrictEqual(tf.value.channels[0], {});
});

test('rootFrame addresses the same change at the module-root path', () => {
  assert.deepStrictEqual(V.rootFrame(da('mute'), true), {
    path: '$._modules[?(@.id==60)][0]', value: { custom: { outs: { mute: true } } }
  });
  const rf = V.rootFrame(da('channel_trim', 2), -3);
  assert.strictEqual(rf.path, '$._modules[?(@.id==60)][0]');
  assert.deepStrictEqual(rf.value.custom.outs.channels[2], { trim: -30 });
});

test('readEntryValue reads each settable param back in display units (matches catalog)', () => {
  for (const e of cat.filter((x) => x.settable)) {
    assert.ok(close(V.readEntryValue(tree, e), e.value) || V.readEntryValue(tree, e) === e.value,
      `${V.entryId(e)} readback ${V.readEntryValue(tree, e)} != catalog ${e.value}`);
  }
});

test('extractEchoValue handles BOTH narrow and module-root echo shapes', () => {
  assert.strictEqual(V.extractEchoValue('mute', { mute: true }), true);                                   // narrow
  assert.strictEqual(V.extractEchoValue('mute', { custom: { outs: { mute: true } } }), true);             // module-root
  assert.strictEqual(V.extractEchoValue('attenuation', { attenuation: -200 }), -20);
  assert.strictEqual(V.extractEchoValue('channel_trim', { custom: { outs: { channels: [{ trim: -30 }, {}] } } }, 0), -3);
});

test('classifyEcho labels narrow vs module-root vs none', () => {
  const att = da('attenuation');
  assert.deepStrictEqual(
    V.classifyEcho([{ path: '$._modules[?(@.id==60)][0].custom.outs', value: { attenuation: -200 } }], att, -20),
    { granularity: 'narrow', path: '$._modules[?(@.id==60)][0].custom.outs' });
  const mute = da('mute');
  assert.strictEqual(
    V.classifyEcho([{ path: '$._modules[?(@.id==60)][0]', value: { custom: { outs: { mute: true } } } }], mute, true).granularity,
    'module-root');
  assert.strictEqual(V.classifyEcho([], mute, true).granularity, 'none');
});

test('inventoryUnmodeled never reports a modeled key', () => {
  const known = new Set(['attenuation', 'mute', 'roll_off_filter', 'out_max_level', 'channel_trim']);
  const inv = V.inventoryUnmodeled(tree);
  assert.ok(Array.isArray(inv));
  for (const leaf of inv) assert.ok(!known.has(leaf.key), `unmodeled inventory leaked modeled key ${leaf.key}`);
});
