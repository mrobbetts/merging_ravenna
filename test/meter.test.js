'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RavennaEngine } = require('../index');

function meterFrame(daOutLevels) {
  return {
    channel: '/ravenna/meter',
    data: {
      path: '$._modules[?(@.id==3)][0]',
      value: { state: { _modules: [
        { id: 1, type: 3, meters: {
          ins: { levels: [1,1,1,1,0,0,0,0], levels_hold: [1,1,1,1,0,0,0,0] },
          outs: { levels: [0,0,0,0,0,0,0,0], levels_hold: [0,0,0,0,0,0,0,0] }
        } },
        { id: 60, type: 20, meters: {
          outs: { levels: daOutLevels, levels_hold: daOutLevels }
        } }
      ] } }
    }
  };
}

// Real timers, short window. sampleMeters resolves on its own ~SAMPLE_MS timer
// after we feed a frame; eng.close() then clears the 7 s liveness watchdog that
// _handleMessage arms (otherwise it would keep the event loop alive). This
// replaces the old hand-rolled fake-clock shim, which fired the wrong timer
// (the liveness watchdog instead of the resolve) and hung the await.
const SAMPLE_MS = 25;

test('meterLevelsFor extracts the gated module output levels', () => {
  const lv = RavennaEngine.meterLevelsFor(meterFrame([0,0,0,0,0,0,0,0]), 60, 'outs');
  assert.deepStrictEqual(lv, [0,0,0,0,0,0,0,0]);
});

test('meterLevelsFor can read the latched peak-hold field', () => {
  const lv = RavennaEngine.meterLevelsFor(meterFrame([7,7,7,7,0,0,0,0]), 60, 'outs', 'levels_hold');
  assert.deepStrictEqual(lv, [7,7,7,7,0,0,0,0]);
});

// Calibration regression guard. Locks in the central finding from the live
// capture: meter integers are LINEAR amplitude. Stream(1) in -> D/A(60) out with
// the D/A at -40.0 dB (gain 0.01) must satisfy daOut == floor(streamIn * 0.01)
// on every active channel. If this ever fails, the linear-amplitude assumption
// (and thus dbFromLevel / maxDb) is wrong.
test('live capture: D/A out == floor(stream in * 0.01) confirms linear amplitude', () => {
  const frame = require('./fixtures/meter-frame-live.json');
  const streamIn = RavennaEngine.meterLevelsFor(frame, 1, 'ins', 'levels_hold');
  const daOut = RavennaEngine.meterLevelsFor(frame, 60, 'outs', 'levels_hold');
  const gain = 0.01; // -40.0 dB attenuation on the D/A (custom.outs.attenuation == -400)
  for (let ch = 0; ch < 4; ch++) {
    assert.strictEqual(daOut[ch], Math.floor(streamIn[ch] * gain),
      `channel ${ch}: streamIn=${streamIn[ch]} daOut=${daOut[ch]}`);
  }
  // The same relationship is a 40 dB drop in the calibrated domain.
  const dropDb = RavennaEngine.dbFromLevel(streamIn[0]) - RavennaEngine.dbFromLevel(daOut[0]);
  assert.ok(Math.abs(dropDb - 40) < 0.5, `expected ~40 dB drop, got ${dropDb.toFixed(2)}`);
});

test('dbFromLevel: 0 is digital black, fullScale is 0 dBFS, /10 is -20 dB', () => {
  assert.strictEqual(RavennaEngine.dbFromLevel(0), -Infinity);
  assert.strictEqual(RavennaEngine.dbFromLevel(-5), -Infinity);
  assert.strictEqual(RavennaEngine.dbFromLevel(32768, 32768), 0);
  assert.ok(Math.abs(RavennaEngine.dbFromLevel(3276.8, 32768) - -20) < 1e-9);
  assert.ok(Math.abs(RavennaEngine.dbFromLevel(16384, 32768) - -6.0206) < 1e-3);
});

test('meterFullScale default is 65535 (2^16-1), confirmed via a 0 dBFS tone', () => {
  assert.strictEqual(new RavennaEngine({ host: 'x' }).meterFullScale, 65535);
  assert.strictEqual(RavennaEngine.dbFromLevel(65535), 0);             // default fullScale
  assert.ok(Math.abs(RavennaEngine.dbFromLevel(65535 / 2) - -6.0206) < 1e-3);
  // sanity: the captured 0 dBFS tone (65534) is ~0 dBFS under the default
  assert.ok(Math.abs(RavennaEngine.dbFromLevel(65534)) < 0.001);
});

test('sampleMeters confirms silence when D/A outs are all zero', async () => {
  const eng = new RavennaEngine({ host: 'x' });
  try {
    const p = eng.sampleMeters(SAMPLE_MS, { moduleId: 60, section: 'outs' });
    eng._handleMessage(meterFrame([0,0,0,0,0,0,0,0]));
    const r = await p;
    assert.strictEqual(r.confirmed, true);
    assert.strictEqual(r.silent, true);
    assert.strictEqual(r.maxRaw, 0);
    assert.strictEqual(r.maxDb, null);     // null, not -Infinity, when silent
    assert.ok(r.maxRawAnywhere > 0);       // stream inputs are hot
  } finally { eng.close(); }
});

test('sampleMeters reports signal when D/A outs are non-zero', async () => {
  const eng = new RavennaEngine({ host: 'x' });
  try {
    const p = eng.sampleMeters(SAMPLE_MS, { moduleId: 60, section: 'outs' });
    eng._handleMessage(meterFrame([0,0,5,0,0,0,0,0]));
    const r = await p;
    assert.strictEqual(r.silent, false);
    assert.strictEqual(r.maxRaw, 5);
    assert.strictEqual(r.maxRawHold, 5);             // fixture sets levels_hold == levels
    assert.ok(Math.abs(r.maxDb - RavennaEngine.dbFromLevel(5, r.fullScale)) < 1e-9);
    assert.ok(r.maxDb < 0 && Number.isFinite(r.maxDb));
  } finally { eng.close(); }
});

test('sampleMeters fails safe (unconfirmed) when no meter frame arrives', async () => {
  const eng = new RavennaEngine({ host: 'x' });
  try {
    const r = await eng.sampleMeters(SAMPLE_MS);
    assert.strictEqual(r.confirmed, false);
    assert.strictEqual(r.silent, null);
  } finally { eng.close(); }
});
