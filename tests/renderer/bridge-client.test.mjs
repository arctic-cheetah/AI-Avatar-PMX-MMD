// Run with: node --test tests/renderer/
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFrame, resetFrame, agentEvent, connectBridge } from "../../renderer/bridge-client.js";

test("typed and spoken prompts share one start frame; history lives in the bridge", () => {
  assert.deepEqual(JSON.parse(startFrame("another one")), { type: "start", prompt: "another one" });
  assert.deepEqual(JSON.parse(startFrame(null)), { type: "start" });
});

test("new chat sends a reset frame", () => {
  assert.deepEqual(JSON.parse(resetFrame()), { type: "reset" });
});

const CATALOG = { neutral: {}, happy: {}, thinking: {} };

test("agent say events keep the source and text for the chat log", () => {
  assert.deepEqual(agentEvent({ type: "agent", kind: "say", source: "Claude Code", text: "On it." }, CATALOG),
    { kind: "say", source: "Claude Code", text: "On it." });
});

test("agent mood events are checked against the catalog and clamped", () => {
  assert.deepEqual(agentEvent({ type: "agent", kind: "mood", source: "Agent", name: "thinking", weight: 3 }, CATALOG),
    { kind: "mood", source: "Agent", name: "thinking", weight: 1 });
  assert.throws(() => agentEvent({ type: "agent", kind: "mood", source: "Agent", name: "evil", weight: 1 }, CATALOG));
  assert.throws(() => agentEvent({ type: "agent", kind: "mood", source: "Agent", name: "toString", weight: 1 }, CATALOG));
});

test("malformed agent events are rejected", () => {
  for (const event of [
    { type: "agent", kind: "say", source: "Agent" },
    { type: "agent", kind: "say", source: 1, text: "x" },
    { type: "agent", kind: "shell", source: "Agent", text: "x" },
    { type: "agent", kind: "mood", source: "Agent", name: "happy", weight: NaN },
  ]) assert.throws(() => agentEvent(event, CATALOG));
});

test("agent reports keep the full text and a known status for the collapsible bubble", () => {
  assert.deepEqual(agentEvent({ type: "agent", kind: "report", source: "Claude Code", status: "done", text: "line 1\nline 2" }, CATALOG),
    { kind: "report", source: "Claude Code", status: "done", text: "line 1\nline 2" });
  assert.throws(() => agentEvent({ type: "agent", kind: "report", source: "Agent", status: "panic", text: "x" }, CATALOG));
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
