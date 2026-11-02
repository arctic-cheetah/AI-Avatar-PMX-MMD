// Run with: node --test tests/renderer/
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFrame, resetFrame, connectBridge } from "../../renderer/bridge-client.js";

test("typed and spoken prompts share one start frame; history lives in the bridge", () => {
  assert.deepEqual(JSON.parse(startFrame("another one")), { type: "start", prompt: "another one" });
  assert.deepEqual(JSON.parse(startFrame(null)), { type: "start" });
});

test("new chat sends a reset frame", () => {
  assert.deepEqual(JSON.parse(resetFrame()), { type: "reset" });
});

test("tool notices stay in the chat log without becoming reply or speech text", (t) => {
  const previousDocument = globalThis.document;
  const previousSocket = globalThis.WebSocket;
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previousSocket;
  });
  const element = () => ({
    textContent: '', children: [], classList: { toggle() {} },
    append(...nodes) { this.children.push(...nodes); },
    addEventListener() {}, setAttribute() {}, focus() {},
  });
  const nodes = new Map();
  globalThis.document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
    createElement: element,
  };
  let socket;
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() { socket = this; this.readyState = 1; }
  };
  const text = [], spoken = [];
  connectBridge({ catalog: {}, onStart() {}, onFinish() {}, onExpression() {},
    onText: (value) => text.push(value), onSpeak: (value) => spoken.push(value) });
  const receive = (event) => socket.onmessage({ data: JSON.stringify(event) });
  receive({ type: 'start' });
  receive({ type: 'notice', text: 'Using get_time…' });
  receive({ type: 'say', text: 'Good morning.' });
  receive({ type: 'end' });
  const lines = nodes.get('#chat-log').children;
  assert.equal(lines[1].children[0].textContent, 'Status');
  assert.equal(lines[1].children[1].textContent, 'Using get_time…');
  assert.equal(lines[0].children[1].textContent, 'Good morning.');
  assert.deepEqual(text, ['Good morning.']);
  assert.deepEqual(spoken, []);
});
