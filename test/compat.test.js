'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { compat } = require('../index');

const base = { identity: { product: 'HAPI_MkII' }, _firmware_generation: 2, _firmware_version: '1.9.0b62872' };

test('exact seeded fingerprint is known-good', () => {
  const c = compat.checkCompat(base);
  assert.strictEqual(c.level, 'known-good');
  assert.ok(c.entry);
  assert.deepStrictEqual(c.entry.confirmedShapes, ['attenuation', 'mute', 'roll_off_filter', 'out_max_level', 'channel_trim']);
  assert.deepStrictEqual(c.entry.inferredShapes, []);
});

test('same product+generation but newer point release is known-generation', () => {
  const c = compat.checkCompat(Object.assign({}, base, { _firmware_version: '1.9.0b70000' }));
  assert.strictEqual(c.level, 'known-generation');
});

test('same product, different generation is unknown-generation', () => {
  const c = compat.checkCompat(Object.assign({}, base, { _firmware_generation: 3 }));
  assert.strictEqual(c.level, 'unknown-generation');
});

test('unseen product is unknown', () => {
  const c = compat.checkCompat({ identity: { product: 'ANUBIS' }, _firmware_generation: 2, _firmware_version: 'x' });
  assert.strictEqual(c.level, 'unknown');
  assert.strictEqual(c.entry, null);
});

test('describeCompat produces a non-empty line for each level', () => {
  for (const lvl of ['known-good', 'known-generation', 'unknown-generation', 'unknown']) {
    const s = compat.describeCompat({ level: lvl, product: 'X', firmware: 'y', generation: 1 });
    assert.ok(typeof s === 'string' && s.length > 0);
  }
});
