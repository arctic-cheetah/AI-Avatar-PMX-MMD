import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketForHour, greetingForDate, GreetingGate } from '../../renderer/greeting.js';
import { connectBridge } from '../../renderer/bridge-client.js';

function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), map };
}
const at = (hour) => new Date(2026, 10, 8, hour, 0, 0);

test('time buckets cover the whole day at their boundaries', () => {
  assert.equal(bucketForHour(4), 'late');
  assert.equal(bucketForHour(5), 'morning');
  assert.equal(bucketForHour(11), 'morning');
  assert.equal(bucketForHour(12), 'afternoon');
  assert.equal(bucketForHour(16), 'afternoon');
  assert.equal(bucketForHour(17), 'evening');
  assert.equal(bucketForHour(21), 'evening');
  assert.equal(bucketForHour(22), 'late');
  assert.equal(bucketForHour(0), 'late');
});

test('invalid hours have no bucket', () => {
  for (const hour of [-1, 24, NaN, '9', null]) assert.equal(bucketForHour(hour), null);
});

test('each bucket greeting fits its mood and uses a fixed phrase', () => {
  assert.match(greetingForDate(at(9)).text, /good morning/i);
  assert.equal(greetingForDate(at(9)).bucket, 'morning');
  assert.match(greetingForDate(at(14)).text, /good afternoon/i);
  assert.match(greetingForDate(at(19)).text, /good evening/i);
  const late = greetingForDate(at(23));
  assert.match(late.text, /up late|rest/i);
  for (const hour of [9, 14, 19, 23, 2]) {
    const g = greetingForDate(at(hour));
    assert.ok(['soft-smile', 'happy', 'sleepy', 'tender'].includes(g.mood), g.mood);
    assert.ok(g.weight > 0 && g.weight <= 1);
  }
});

test('once per page load: a second claim is silent, but a new page load greets again', () => {
  const session = storage();
  const gate = new GreetingGate({ session, local: storage() });
  assert.ok(gate.claim(at(9)));
  assert.equal(gate.claim(at(9)), null, 'same page load must not greet twice');
  // sessionStorage is copied into new windows and restored tabs, so it must
  // not suppress the greeting: a new gate (a new page load) greets again.
  assert.ok(new GreetingGate({ session, local: storage() }).claim(at(9)), 'new window/page load should greet');
});

test('greeting can be switched off persistently, and off does not consume the session greeting', () => {
  const session = storage();
  const local = storage();
  const gate = new GreetingGate({ session, local });
  gate.setEnabled(false);
  assert.equal(gate.enabled, false);
  assert.equal(gate.claim(at(9)), null);
  assert.equal(new GreetingGate({ session, local }).enabled, false);
  gate.setEnabled(true);
  assert.ok(gate.claim(at(9)), 're-enabling in the same session should still greet once');
});

test('page open posts the greeting once in the chat log and asks the bridge to speak it, even across a reconnect', (t) => {
  const prevDoc = globalThis.document; const prevSock = globalThis.WebSocket;
  t.after(() => {
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
    if (prevSock === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = prevSock;
  });
  const element = () => ({
    textContent: '', placeholder: '', hidden: false, disabled: false, className: '', children: [],
    classList: { toggle() {} }, append(...n) { this.children.push(...n); },
    addEventListener() {}, setAttribute() {}, focus() {},
  });
  const nodes = new Map();
  globalThis.document = {
    querySelector: (s) => { if (!nodes.has(s)) nodes.set(s, element()); return nodes.get(s); },
    createElement: element,
  };
  let socket;
  const sent = [];
  globalThis.WebSocket = class { static OPEN = 1; constructor() { socket = this; this.readyState = 1; } send(frame) { sent.push(JSON.parse(frame)); } };
  const moods = [];
  const greeting = { bucket: 'morning', text: 'Good morning! Ready for today?', mood: 'soft-smile', weight: 0.9 };
  connectBridge({
    catalog: { 'soft-smile': {} }, greeting, onGreeting: (g) => moods.push(g),
    onStart() {}, onFinish() {}, onExpression() {}, onText() {}, onSpeak() {},
  });
  socket.onopen();
  socket.onopen(); // A reconnect must not greet a second time.
  const lines = nodes.get('#chat-log').children;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].children[1].textContent, 'Good morning! Ready for today?');
  assert.deepEqual(moods, [greeting]);
  // #129: the bridge speaks it, so it goes over the socket exactly once.
  assert.deepEqual(sent, [{ type: 'greet', text: 'Good morning! Ready for today?', mood: 'soft-smile', weight: 0.9 }]);
});

test('blocked storage still keeps the once-per-session rule in memory', () => {
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  const gate = new GreetingGate({ session: blocked, local: blocked });
  assert.ok(gate.claim(at(9)));
  assert.equal(gate.claim(at(9)), null);
});
