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
        { id: 60, type: 20, meters: { outs: { levels: daOutLevels, levels_hold: daOutLevels } } }
      ] } }
    }
  };
}

test("opts.meters subscribes /ravenna/meter on connect and emits 'meter' frames", () => {
  const eng = new RavennaEngine({ host: 'x', meters: true });
  try {
    const sent = [];
    eng._send = (frames) => sent.push(...frames);
    eng._handleMessage({ channel: '/meta/handshake', successful: true, clientId: 'c1' });
    assert.ok(sent.some((f) => f.channel === '/meta/subscribe' && f.subscription === '/ravenna/meter'),
      'meter subscription missing from the connect batch');

    const got = [];
    eng.on('meter', (d) => got.push(d));
    eng._handleMessage(meterFrame([5, 0, 0, 0, 0, 0, 0, 0]));
    assert.strictEqual(got.length, 1);
    assert.deepStrictEqual(RavennaEngine.meterLevelsFor({ data: got[0] }, 60, 'outs'), [5, 0, 0, 0, 0, 0, 0, 0]);
  } finally { eng.close(); }
});

test('default (meters off): no meter subscription, no meter events', () => {
  const eng = new RavennaEngine({ host: 'x' });
  try {
    const sent = [];
    eng._send = (frames) => sent.push(...frames);
    eng._handleMessage({ channel: '/meta/handshake', successful: true, clientId: 'c1' });
    assert.ok(!sent.some((f) => f.subscription === '/ravenna/meter'));
    // a stray meter frame (e.g. another client's traffic) still emits nothing surprising:
    // 'meter' fires only for subscribers; nobody listens, and 'raw' still sees it
    const raw = [];
    eng.on('raw', (m) => raw.push(m));
    eng._handleMessage(meterFrame([1, 0, 0, 0, 0, 0, 0, 0]));
    assert.strictEqual(raw.length, 1);
  } finally { eng.close(); }
});
