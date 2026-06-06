'use strict';

const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');
const { RavennaEngine } = require('../src/engine');

// --- Fake clock ------------------------------------------------------------
function makeClock() {
  let now = 0;
  let seq = 1;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { const id = seq++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      // fire due timers in time order until we reach target
      while (true) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= target && (next === null || t.at < next.at)) next = { id, ...t };
        if (!next) break;
        now = next.at;
        timers.delete(next.id);
        next.fn();
      }
      now = target;
    }
  };
}

// --- Fake WebSocket --------------------------------------------------------
// Lets a test simulate: successful open, inbound frames, drops, and dead hosts.
class FakeWS extends EventEmitter {
  constructor() { super(); this.readyState = 0; this.sent = []; FakeWS.instances.push(this); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit('close'); }
  // helpers for tests
  fireOpen() { this.readyState = 1; this.emit('open'); }
  fireMessage(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}
FakeWS.OPEN = 1;
FakeWS.instances = [];

function freshEngine(clock, opts = {}) {
  FakeWS.instances.length = 0;
  return new RavennaEngine(Object.assign({
    host: '10.0.0.99',
    livenessMs: 7000,
    backoff: [2000, 5000, 15000, 30000],
    WebSocket: FakeWS,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  }, opts));
}

function handshakeReply(clientId) {
  return [{ id: '1', channel: '/meta/handshake', successful: true, clientId }];
}

test('emits online only after full tree, exactly once', () => {
  const clock = makeClock();
  const eng = freshEngine(clock);
  let onlineCount = 0;
  eng.on('online', () => onlineCount++);
  eng.connect();

  const ws = FakeWS.instances[0];
  ws.fireOpen();
  ws.fireMessage(handshakeReply('0xabc-1'));
  // connected, but no tree yet -> not online
  assert.strictEqual(eng.online, false);

  ws.fireMessage([{ channel: '/ravenna/settings', data: { path: '$', value: { _modules: [] } } }]);
  assert.strictEqual(eng.online, true);
  assert.strictEqual(onlineCount, 1);

  // another tree update must NOT re-fire online
  ws.fireMessage([{ channel: '/ravenna/settings', data: { path: '$', value: { _modules: [] } } }]);
  assert.strictEqual(onlineCount, 1);
});

test('reduced /ravenna/status full-tree does not clobber the settings catalog/capabilities', () => {
  const clock = makeClock();
  const eng = freshEngine(clock);
  eng.connect();
  const ws = FakeWS.instances[0];
  ws.fireOpen();
  ws.fireMessage(handshakeReply('id1'));

  // Authoritative full tree on /ravenna/settings: module 60 carries custom + capabilities.
  const full = { _modules: [{ id: 60, name: 'D/A 1',
    custom: { outs: { attenuation: -100, capabilities: { mute: true, attenuation: true, attenuation_info: { min: -600, max: 0, step: 1 } } } } }] };
  ws.fireMessage([{ channel: '/ravenna/settings', data: { path: '$', value: full } }]);
  assert.ok(eng.capabilities[60], 'capabilities seeded from the settings tree');
  const catLen = eng.catalog.length;

  // Periodic REDUCED status tree (modules have only {state,id,type}, no custom).
  let treeEvents = 0;
  eng.on('tree', () => treeEvents++);
  const reduced = { _modules: [{ id: 60, type: 20, sub_type: 218, state: { panic: false } }] };
  ws.fireMessage([{ channel: '/ravenna/status', data: { path: '$', value: reduced } }]);

  assert.ok(eng.capabilities[60], 'capabilities NOT wiped by the reduced status tree');
  assert.strictEqual(eng.catalog.length, catLen, 'catalog NOT wiped by the reduced status tree');
  // The reduced status module has no `custom`; if it had clobbered the tree this would be undefined.
  assert.ok(eng.tree._modules[0].custom && eng.tree._modules[0].custom.outs,
    'tree still the full settings tree (custom.outs present), not the reduced status tree');
  assert.strictEqual(treeEvents, 0, 'reduced status tree does not emit a tree event');
});

test('liveness watchdog fires offline after silence, once', () => {
  const clock = makeClock();
  const eng = freshEngine(clock);
  const offline = [];
  eng.on('offline', (r) => offline.push(r));
  eng.connect();
  const ws = FakeWS.instances[0];
  ws.fireOpen();
  ws.fireMessage(handshakeReply('0xabc-1'));
  ws.fireMessage([{ channel: '/ravenna/status', data: { path: '$', value: { _modules: [] } } }]);
  assert.strictEqual(eng.online, true);

  // 6 s: still alive (under 7 s window)
  clock.advance(6000);
  assert.strictEqual(eng.online, true);
  // a frame arrives, resetting the window
  ws.fireMessage([{ channel: '/ravenna/status', data: { path: 'x', value: {} } }]);
  clock.advance(6000);
  assert.strictEqual(eng.online, true, 'frame reset the watchdog');

  // now go silent past the window
  clock.advance(7001);
  assert.strictEqual(eng.online, false);
  assert.deepStrictEqual(offline, ['timeout']);
});

test('exponential backoff schedule on a dead host, then recovers', () => {
  const clock = makeClock();
  const eng = freshEngine(clock);
  const transitions = [];
  eng.on('offline', (r) => transitions.push('offline:' + r));
  eng.on('online', () => transitions.push('online'));
  eng.connect();

  // First socket opens, handshakes, gets tree -> online
  let ws = FakeWS.instances[0];
  ws.fireOpen();
  ws.fireMessage(handshakeReply('id1'));
  ws.fireMessage([{ channel: '/ravenna/status', data: { path: '$', value: { _modules: [] } } }]);
  assert.strictEqual(transitions[0], 'online');

  // Device powers off: socket closes. Expect offline + a reconnect scheduled at 2000.
  ws.close();
  assert.strictEqual(transitions[1], 'offline:closed');
  const before = FakeWS.instances.length;

  clock.advance(2000);                 // first backoff step
  assert.strictEqual(FakeWS.instances.length, before + 1, 'reconnect attempt #1 created a socket');

  // That socket also fails immediately (host still dead)
  let ws2 = FakeWS.instances[before];
  ws2.emit('close');                   // close before open => connect-failed path
  // next backoff step is 5000; nothing should happen at 4999
  clock.advance(4999);
  assert.strictEqual(FakeWS.instances.length, before + 1);
  clock.advance(2);                    // cross 5000 boundary
  assert.strictEqual(FakeWS.instances.length, before + 2, 'reconnect attempt #2 after 5 s');

  // Device returns: this socket opens and completes
  let ws3 = FakeWS.instances[before + 1];
  ws3.fireOpen();
  ws3.fireMessage(handshakeReply('id2'));
  ws3.fireMessage([{ channel: '/ravenna/status', data: { path: '$', value: { _modules: [] } } }]);
  assert.strictEqual(transitions[transitions.length - 1], 'online', 'recovered after power-cycle');
});

test('reconnect re-runs handshake+update so post-power-cycle state is fresh', () => {
  const clock = makeClock();
  const eng = freshEngine(clock);
  eng.connect();
  let ws = FakeWS.instances[0];
  ws.fireOpen();
  // verify a handshake frame was sent on open
  assert.ok(ws.sent.some((s) => s.includes('/meta/handshake')), 'handshake sent on first open');
  ws.fireMessage(handshakeReply('id1'));
  // after handshake, the subscribe+update batch goes out
  assert.ok(ws.sent.some((s) => s.includes('"command":"update"')), 'update requested after handshake');

  ws.close();
  clock.advance(2000);
  let ws2 = FakeWS.instances[1];
  ws2.fireOpen();
  assert.ok(ws2.sent.some((s) => s.includes('/meta/handshake')), 'handshake re-sent on reconnect');
  ws2.fireMessage(handshakeReply('id2'));
  assert.ok(ws2.sent.some((s) => s.includes('"command":"update"')), 'update re-requested on reconnect');
});
