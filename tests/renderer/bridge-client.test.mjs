// Run with: node --test tests/renderer/
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFrame, resetFrame, connectBridge, evidenceText } from "../../renderer/bridge-client.js";

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

test("source evidence stays visible as text and is not spoken", (t) => {
  const previousDocument = globalThis.document;
  const previousSocket = globalThis.WebSocket;
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previousSocket;
  });
  const element = () => ({
    textContent: '', innerHTML: '', children: [], classList: { toggle() {} },
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
  socket.onmessage({ data: JSON.stringify({
    type: 'evidence', kind: 'search', provider: 'bing', query: 'capital of France',
    results: [{ title: 'Paris <script>', url: 'https://example.com/paris', snippet: 'Capital city' }],
  }) });
  const line = nodes.get('#chat-log').children[0];
  assert.equal(line.children[0].textContent, 'Sources');
  assert.match(line.children[1].textContent, /https:\/\/example.com\/paris/);
  assert.match(line.children[1].textContent, /Transport success is not relevance/);
  assert.equal(line.children[1].innerHTML, '');
  assert.deepEqual(text, []);
  assert.deepEqual(spoken, []);
  assert.match(evidenceText({
    type: 'evidence', kind: 'webpage', requested_url: 'https://example.com/paris',
    final_url: 'https://example.com/paris', title: 'Paris', text: 'Capital city', truncated: false,
  }), /untrusted/);
});
