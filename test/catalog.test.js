'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildCatalog, groupByModule, paths } = require('../index');
const { RavennaEngine } = require('../src/engine');

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'full-tree.json'), 'utf8')
);
const tree = fixture.data.value;

test('catalog flattens D/A attenuation with correct unit + range', () => {
  const cat = buildCatalog(tree);
  const da = cat.find((e) => e.moduleId === 60 && e.key === 'attenuation');
  assert.ok(da, 'D/A attenuation present');
  assert.strictEqual(da.unit, 'dB');
  assert.strictEqual(da.value, -33.5, 'tenths -335 -> -33.5 dB');
  assert.strictEqual(da.min, -60);
  assert.strictEqual(da.max, 0);
  assert.strictEqual(da.step, 0.1);
  assert.strictEqual(da.settable, true);
  assert.strictEqual(da.confidence, 'confirmed');
});

test('catalog enumerates per-channel trim for all 8 D/A channels', () => {
  const cat = buildCatalog(tree);
  const trims = cat.filter((e) => e.moduleId === 60 && e.key === 'channel_trim');
  assert.strictEqual(trims.length, 8);
  assert.strictEqual(trims[0].unit, 'dB');
});

test('catalog exposes roll-off enum with label map', () => {
  const cat = buildCatalog(tree);
  const ro = cat.find((e) => e.moduleId === 60 && e.key === 'roll_off_filter');
  assert.ok(ro);
  assert.deepStrictEqual(ro.enum, { Slow: 0, Sharp: 1, Apodizing: 2, Brickwall: 3 });
});

test('groupByModule regroups flat catalog by module', () => {
  const groups = groupByModule(buildCatalog(tree));
  const da = groups.find((g) => g.moduleId === 60);
  assert.ok(da);
  assert.ok(da.params.length >= 3);
});

test('dB <-> tenths conversions round-trip', () => {
  assert.strictEqual(paths.dbToTenths(-33.5), -335);
  assert.strictEqual(paths.tenthsToDb(-335), -33.5);
  assert.strictEqual(paths.dbToTenths(-12.34), -123); // rounds
});

test('setParam builds the CONFIRMED attenuation frame and clamps to range', () => {
  // Drive a fake engine: capture what publishSettings would send.
  const eng = new RavennaEngine({ host: '10.0.0.1' });
  eng._ingestTree(tree);            // load capabilities
  const sent = [];
  eng.publishSettings = (p, v) => { sent.push({ path: p, value: v }); return true; };
  eng.clientId = 'x';               // pretend connected

  eng.setParam(60, 'attenuation', -20);   // dB
  assert.deepStrictEqual(sent[0], {
    path: '$._modules[?(@.id==60)][0].custom.outs',
    value: { attenuation: -200 }
  });

  eng.setParam(60, 'attenuation', 50);     // above max 0 dB -> clamps to 0
  assert.strictEqual(sent[1].value.attenuation, 0);

  eng.setParam(60, 'attenuation', -999);   // below -60 dB -> clamps to -600
  assert.strictEqual(sent[2].value.attenuation, -600);
});

test('settings echo resolves into a param event', () => {
  const eng = new RavennaEngine({ host: '10.0.0.1' });
  const events = [];
  eng.on('param', (p) => events.push(p));
  eng._maybeEmitParam({
    path: '$._modules[?(@.id==60)][0].custom.outs',
    value: { attenuation: -300 }
  });
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual(events[0], { moduleId: 60, key: 'attenuation', raw: -300, value: -30, unit: 'dB' });
});

// ---- per-parameter set-frame shape coverage (hermetic) --------------------
// These assert the exact { path, value } each known parameter produces, so the
// offline suite is the source of truth for shapes the live harness then confirms.

function captureSet(key, value, ctx) {
  const eng = new RavennaEngine({ host: '10.0.0.1' });
  eng._ingestTree(tree);
  const sent = [];
  eng.publishSettings = (p, v) => { sent.push({ path: p, value: v }); return true; };
  eng.clientId = 'x';
  eng.setParam(60, key, value, ctx || {});
  return sent[0];
}

test('mute set-frame shape', () => {
  assert.deepStrictEqual(captureSet('mute', true), {
    path: '$._modules[?(@.id==60)][0].custom.outs', value: { mute: true }
  });
});

test('roll_off_filter set-frame shape', () => {
  assert.deepStrictEqual(captureSet('roll_off_filter', 3), {
    path: '$._modules[?(@.id==60)][0].custom.outs', value: { roll_off_filter: 3 }
  });
});

test('out_max_level set-frame shape', () => {
  assert.deepStrictEqual(captureSet('out_max_level', 1), {
    path: '$._modules[?(@.id==60)][0].custom.outs', value: { out_max_level: 1 }
  });
});

test('enum params accept a label string OR the integer', () => {
  // model-supplied enum (out_max_level): +18 dBu = 0, +24 dBu = 1
  assert.deepStrictEqual(captureSet('out_max_level', '+24 dBu').value, { out_max_level: 1 });
  assert.deepStrictEqual(captureSet('out_max_level', '+18 dBu').value, { out_max_level: 0 });
  // device-supplied enum (roll_off_filter), case-insensitive
  assert.deepStrictEqual(captureSet('roll_off_filter', 'Brickwall').value, { roll_off_filter: 3 });
  assert.deepStrictEqual(captureSet('roll_off_filter', 'sharp').value, { roll_off_filter: 1 });
  // integers still work unchanged
  assert.deepStrictEqual(captureSet('out_max_level', 0).value, { out_max_level: 0 });
  assert.deepStrictEqual(captureSet('roll_off_filter', 2).value, { roll_off_filter: 2 });
});

test('catalog exposes the out_max_level label map', () => {
  const e = buildCatalog(tree).find((x) => x.moduleId === 60 && x.key === 'out_max_level');
  assert.ok(e);
  assert.strictEqual(e.unit, 'enum');
  assert.deepStrictEqual(e.enum, { '+18 dBu': 0, '+24 dBu': 1 });
});

test('channel_trim set-frame targets one channel within the channels array', () => {
  const f = captureSet('channel_trim', -3, { channelIndex: 2 }); // -3 dB on ch index 2
  assert.strictEqual(f.path, '$._modules[?(@.id==60)][0].custom.outs');
  assert.strictEqual(f.value.channels.length, 8, 'all 8 channels represented');
  assert.deepStrictEqual(f.value.channels[2], { trim: -30 }, 'target channel carries the trim (tenths)');
  assert.deepStrictEqual(f.value.channels[0], {}, 'other channels left empty');
});

test('every settable catalog entry has a known builder (no orphans)', () => {
  const cat = buildCatalog(tree);
  for (const e of cat) {
    if (e.settable) assert.ok(paths.PARAMS[e.key], `missing PARAMS descriptor for ${e.key}`);
  }
});
