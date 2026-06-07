'use strict';

// Feedback (settings-echo -> param event) parsing, pinned to the TWO echo
// granularities observed on real hardware (live capture 2026-06-05):
//   - narrow:      $._modules[?(@.id==N)][0].custom.outs   value={attenuation:-399}   (attenuation)
//   - module-root: $._modules[?(@.id==N)][0]               value={...module..,custom:{outs:{mute:true,...}}}
//                  (mute / roll_off_filter / out_max_level / channel trim from web UI or front panel)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { RavennaEngine, paths } = require('../index');

const tree = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'full-tree.json'), 'utf8')).data.value;

// Build a module-root echo frame whose custom.outs equals the seeded baseline
// except for the fields in `changes` — mirrors how the device echoes the WHOLE
// module node when a non-attenuation control is changed via the web UI.
function moduleRootEcho(eng, moduleId, changes) {
  const c = eng._outsCache[moduleId];
  const outs = {
    attenuation: c.attenuation,
    mute: c.mute,
    roll_off_filter: c.roll_off_filter,
    out_max_level: c.out_max_level,
    channels: (c.trims || []).map((t) => ({ trim: t }))
  };
  Object.assign(outs, changes.scalars || {});
  if (changes.trim) outs.channels[changes.trim.index] = { trim: changes.trim.value };
  return { path: `$._modules[?(@.id==${moduleId})][0]`, value: { id: moduleId, custom: { outs } } };
}

function seeded() {
  const eng = new RavennaEngine({ host: 'x' });
  eng._ingestTree(tree);   // seeds _outsCache from the real tree
  const events = [];
  eng.on('param', (p) => events.push(p));
  return { eng, events };
}

test('narrow attenuation echo still resolves (backward compatible)', () => {
  const eng = new RavennaEngine({ host: 'x' });
  const events = [];
  eng.on('param', (p) => events.push(p));
  eng._maybeEmitParam({ path: '$._modules[?(@.id==60)][0].custom.outs', value: { attenuation: -300 } });
  assert.deepStrictEqual(events, [{ moduleId: 60, key: 'attenuation', raw: -300, value: -30, unit: 'dB' }]);
});

test('module-root mute echo emits ONLY mute, not unchanged siblings', () => {
  const { eng, events } = seeded();
  eng._maybeEmitParam(moduleRootEcho(eng, 60, { scalars: { mute: true } }));
  assert.deepStrictEqual(events, [{ moduleId: 60, key: 'mute', raw: true, value: true, unit: 'bool' }]);
});

test('module-root roll_off_filter echo emits roll_off_filter', () => {
  const { eng, events } = seeded();
  eng._maybeEmitParam(moduleRootEcho(eng, 60, { scalars: { roll_off_filter: 0 } }));
  assert.deepStrictEqual(events, [{ moduleId: 60, key: 'roll_off_filter', raw: 0, value: 0, unit: 'enum' }]);
});

test('module-root out_max_level echo emits out_max_level (0/1 toggle)', () => {
  const { eng, events } = seeded();
  eng._maybeEmitParam(moduleRootEcho(eng, 60, { scalars: { out_max_level: 1 } }));
  assert.deepStrictEqual(events, [{ moduleId: 60, key: 'out_max_level', raw: 1, value: 1, unit: 'enum' }]);
});

test('module-root channel_trim echo emits only the changed channel, with channelIndex', () => {
  const { eng, events } = seeded();
  eng._maybeEmitParam(moduleRootEcho(eng, 60, { trim: { index: 2, value: -30 } }));
  assert.deepStrictEqual(events, [{ moduleId: 60, key: 'channel_trim', channelIndex: 2, raw: -30, value: -3, unit: 'dB' }]);
});

test('identical echo does not re-emit (change-detected feedback)', () => {
  const { eng, events } = seeded();
  const echo = moduleRootEcho(eng, 60, { scalars: { mute: true } });
  eng._maybeEmitParam(echo);   // mute false -> true : emits
  eng._maybeEmitParam(echo);   // mute true -> true  : no change
  assert.strictEqual(events.length, 1);
});

test('a module-root echo with multiple real changes emits one event per changed key', () => {
  const { eng, events } = seeded();
  eng._maybeEmitParam(moduleRootEcho(eng, 60, { scalars: { mute: true, out_max_level: 1 } }));
  assert.strictEqual(events.length, 2);
  assert.deepStrictEqual(events.map((e) => e.key).sort(), ['mute', 'out_max_level']);
});

// Real frames captured from the device (web-UI trim nudges, 2026-06-05). Trim echoes
// at the module-root path with the whole custom.outs.channels[] array. Two shapes:
// the 8-ch D/A (id 60) and the 2-ch Headphone (id 30, which has NO out_max_level and
// no factory_settings in the echo). Parser must pick out exactly the changed channel.
// Subscribe-to-anything invariant: every settable PARAMS key MUST produce a feedback
// param event. If someone adds a param to PARAMS but forgets to wire it into
// _maybeEmitParam, this fails — so node-red can always subscribe to anything it can set.
test('feedback covers EVERY settable PARAMS key (no subscribe gap)', () => {
  const eng = new RavennaEngine({ host: 'x' });
  eng._outsCache = { 60: { attenuation: -100, mute: false, roll_off_filter: 2, out_max_level: 0, trims: [0, 0, 0, 0, 0, 0, 0, 0] } };
  const events = [];
  eng.on('param', (p) => events.push(p));
  eng._maybeEmitParam({
    path: '$._modules[?(@.id==60)][0]',
    value: { id: 60, custom: { outs: {
      attenuation: -200, mute: true, roll_off_filter: 0, out_max_level: 1,
      channels: [{ trim: -10 }, { trim: 0 }, { trim: 0 }, { trim: 0 }, { trim: 0 }, { trim: 0 }, { trim: 0 }, { trim: 0 }]
    } } }
  });
  const emitted = [...new Set(events.map((e) => e.key))].sort();
  assert.deepStrictEqual(emitted, Object.keys(paths.PARAMS).sort(),
    'every settable PARAMS key must emit a feedback param event — _maybeEmitParam is out of sync with PARAMS');
});

test('real captured trim echoes (module-root) resolve to per-channel events', () => {
  const da = new RavennaEngine({ host: 'x' });
  da._outsCache = { 60: { attenuation: -400, mute: false, roll_off_filter: 2, out_max_level: 0, trims: [0, 0, 0, 0, 0, 0, 0, 0] } };
  const daEv = [];
  da.on('param', (p) => daEv.push(p));
  da._maybeEmitParam({
    path: '$._modules[?(@.id==60)][0]',
    value: { id: 60, custom: { outs: { mute: false, attenuation: -400, out_max_level: 0, roll_off_filter: 2,
      channels: [{ trim: 0 }, { trim: 0 }, { trim: -3 }, { trim: 0 }, { trim: 0 }, { trim: 0 }, { trim: 0 }, { trim: 0 }] } } }
  });
  assert.deepStrictEqual(daEv, [{ moduleId: 60, key: 'channel_trim', channelIndex: 2, raw: -3, value: -0.3, unit: 'dB' }]);

  const hp = new RavennaEngine({ host: 'x' });
  hp._outsCache = { 30: { attenuation: -150, mute: false, roll_off_filter: 2, trims: [0, 0] } };
  const hpEv = [];
  hp.on('param', (p) => hpEv.push(p));
  hp._maybeEmitParam({
    path: '$._modules[?(@.id==30)][0]',
    value: { id: 30, custom: { outs: { mute: false, attenuation: -150, roll_off_filter: 2, channels: [{ trim: -1 }, { trim: 0 }] } } }
  });
  assert.deepStrictEqual(hpEv, [{ moduleId: 30, key: 'channel_trim', channelIndex: 0, raw: -1, value: -0.1, unit: 'dB' }]);
});
