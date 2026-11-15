// Run with: node --test tests/renderer/
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFrame, resetFrame, agentEvent, answerFrame, connectBridge, bridgeEnabled } from "../../renderer/bridge-client.js";
import { installPage } from "./fake-dom.mjs";

test("typed and spoken prompts share one start frame; history lives in the bridge", () => {
  assert.deepEqual(JSON.parse(startFrame("another one")), { type: "start", prompt: "another one" });
  assert.deepEqual(JSON.parse(startFrame(null)), { type: "start" });
});

test("new chat sends a reset frame", () => {
  assert.deepEqual(JSON.parse(resetFrame()), { type: "reset" });
});

const CATALOG = { neutral: {}, happy: {}, thinking: {} };

test("a turn event opens speech and an agent bubble does not", (t) => {
  const page = installPage(t);
  const turns = [];
  const bubbles = [];
  connectBridge({
    catalog: CATALOG, onStart() {}, onFinish() {}, onExpression() {}, onText() {}, onSpeak() {},
    onTurn: () => turns.push("turn"),
    onAgentSay: () => bubbles.push("bubble"),
  });
  const receive = page.receive;
  receive({ type: "agent", kind: "say", source: "Copilot", text: "On it." });
  receive({ type: "turn" });
  assert.deepEqual(bubbles, ["bubble"]);
  assert.deepEqual(turns, ["turn"]);
});

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

test("agent asks carry an id; the next chat message answers it", () => {
  assert.deepEqual(agentEvent({ type: "agent", kind: "ask", source: "Claude Code", id: "ab12", text: "Commit?" }, CATALOG),
    { kind: "ask", source: "Claude Code", id: "ab12", text: "Commit?" });
  assert.deepEqual(agentEvent({ type: "agent", kind: "ask-closed", source: "Claude Code", id: "ab12" }, CATALOG),
    { kind: "ask-closed", source: "Claude Code", id: "ab12" });
  assert.throws(() => agentEvent({ type: "agent", kind: "ask", source: "A", text: "Commit?" }, CATALOG));
  assert.deepEqual(JSON.parse(answerFrame("ab12", "Yes please")), { type: "answer", id: "ab12", text: "Yes please" });
});

test("tool notices stay in the chat log without becoming reply or speech text", (t) => {
  const page = installPage(t);
  const text = [], spoken = [];
  connectBridge({ catalog: {}, onStart() {}, onFinish() {}, onExpression() {},
    onText: (value) => text.push(value), onSpeak: (value) => spoken.push(value) });
  const receive = page.receive;
  receive({ type: 'start' });
  receive({ type: 'notice', text: 'Using get_time…' });
  receive({ type: 'say', text: 'Good morning.' });
  receive({ type: 'end' });
  const lines = page.log().children;
  assert.equal(lines[1].children[0].textContent, 'Status');
  assert.equal(lines[1].children[1].textContent, 'Using get_time…');
  assert.equal(lines[0].children[1].textContent, 'Good morning.');
  assert.deepEqual(text, ['Good morning.']);
  assert.deepEqual(spoken, []);
});

const noop = () => {};
function connect(page, extra = {}) {
  connectBridge({ catalog: CATALOG, onStart: noop, onFinish: noop, onExpression: noop, onText: noop, onSpeak: noop, ...extra });
}
const bodyOf = (line) => line.children[1];

test("a streamed reply renders Markdown while speech text keeps the raw chunks", (t) => {
  const page = installPage(t);
  const text = [];
  connect(page, { onText: (value) => text.push(value) });
  const chunks = ["Here is **bo", "ld**.\n\n```", "js\nx = 1\n", "```"];
  page.receive({ type: "start" });
  page.receive({ type: "say", text: chunks[0] });
  const body = bodyOf(page.log().children[0]);
  assert.equal(body.textContent, "Here is **bo");
  assert.equal(body.querySelectorAll("strong").length, 0);
  page.receive({ type: "say", text: chunks[1] });
  page.receive({ type: "say", text: chunks[2] });
  assert.equal(body.querySelector("code").textContent, "x = 1");
  page.receive({ type: "say", text: chunks[3] });
  page.receive({ type: "end" });
  assert.equal(body.innerHTML, '<p>Here is <strong>bold</strong>.</p><pre><code class="language-js">x = 1</code></pre>');
  assert.deepEqual(text, chunks);
});

test("agent say, ask and report bubbles render Markdown", (t) => {
  const page = installPage(t);
  connect(page);
  page.receive({ type: "agent", kind: "say", source: "Claude Code", text: "**Done**, see `x`" });
  page.receive({ type: "agent", kind: "ask", source: "Claude Code", id: "ab12", text: "Commit **now**?" });
  const [say, ask] = page.log().children;
  assert.equal(bodyOf(say).innerHTML, "<p><strong>Done</strong>, see <code>x</code></p>");
  assert.equal(bodyOf(ask).textContent, "❓ Commit now?");
  assert.equal(bodyOf(ask).querySelectorAll("strong").length, 1);
});

test("a report keeps a plain-text summary and renders its expanded body", (t) => {
  const page = installPage(t);
  connect(page);
  const long = `## Fixed **the bug** ${"x".repeat(100)}`;
  page.receive({ type: "agent", kind: "report", source: "Claude Code", status: "done", text: `${long}\n\n- one\n- two` });
  const body = bodyOf(page.log().children[0]);
  const summary = body.querySelector("summary");
  assert.equal(summary.children.length, 1);
  assert.equal(summary.textContent, `Report · done: Fixed the bug ${"x".repeat(80 - "Fixed the bug ".length)}…`);
  const details = body.querySelector("details");
  assert.equal(details.querySelectorAll("h2").length, 1);
  assert.deepEqual(details.querySelectorAll("li").map((item) => item.textContent), ["one", "two"]);
  assert.equal(details.querySelectorAll("pre").length, 0);
});

test("unsafe HTML in an agent message stays text", (t) => {
  const page = installPage(t);
  connect(page);
  page.receive({ type: "agent", kind: "say", source: "Agent", text: '<img src=x onerror="alert(1)"> [x](javascript:alert(1))' });
  const body = bodyOf(page.log().children[0]);
  assert.equal(body.querySelectorAll("img").length + body.querySelectorAll("a").length, 0);
  assert.match(body.textContent, /^<img src=x onerror="alert\(1\)"> x$/);
});

test("the user's own message is shown exactly as typed", (t) => {
  const page = installPage(t);
  connect(page);
  page.nodes.get("#chat-input").value = "**hi** <b>there</b>";
  page.nodes.get("#chat-bar").listeners.submit[0]({ preventDefault() {} });
  const body = bodyOf(page.log().children[0]);
  assert.equal(body.textContent, "**hi** <b>there</b>");
  assert.equal(body.descendants().length, 0);
});

test("an open agent ask is reported so idle behaviours wait for the answer (#71)", (t) => {
  const page = installPage(t);
  const asks = [];
  connect(page, { onAskChange: (open) => asks.push(open) });
  page.receive({ type: "agent", kind: "ask", source: "Claude Code", id: "a1", text: "Commit?" });
  page.receive({ type: "agent", kind: "ask-closed", source: "Claude Code", id: "a1" });
  page.receive({ type: "agent", kind: "ask", source: "Claude Code", id: "a2", text: "Push?" });
  page.nodes.get("#chat-input").value = "Yes";
  page.nodes.get("#chat-bar").listeners.submit[0]({ preventDefault() {} });
  page.receive({ type: "agent", kind: "ask", source: "Claude Code", id: "a3", text: "Merge?" });
  page.receive({ type: "reset" });
  assert.deepEqual(asks, [true, false, true, false, true, false], "open, closed, open, answered, open, reset");
});

test("every bridge event counts as activity for the idle timer (#71)", (t) => {
  const page = installPage(t);
  let activity = 0;
  connect(page, { onActivity: () => { activity += 1; } });
  page.receive({ type: "agent", kind: "mood", source: "Agent", name: "happy", weight: 1 });
  page.receive({ type: "agent", kind: "say", source: "Agent", text: "Hi" });
  page.receive({ type: "turn" });
  assert.equal(activity, 3);
});

test("sending a chat message or answering an ask counts as activity before any reply (#71)", (t) => {
  const page = installPage(t);
  let activity = 0;
  connect(page, { onActivity: () => { activity += 1; } });
  page.nodes.get("#chat-input").value = "Hello";
  page.nodes.get("#chat-bar").listeners.submit[0]({ preventDefault() {} });
  assert.equal(activity, 1, "the sent chat");
  page.receive({ type: "end" });
  page.receive({ type: "agent", kind: "ask", source: "Claude Code", id: "a1", text: "Commit?" });
  const before = activity;
  page.nodes.get("#chat-input").value = "Yes";
  page.nodes.get("#chat-bar").listeners.submit[0]({ preventDefault() {} });
  assert.equal(activity - before, 1, "the answer");
});

test("the chat log evicts the oldest bubbles beyond the history cap (#24)", (t) => {
  const page = installPage(t);
  connect(page);
  for (let index = 0; index < 205; index += 1) {
    page.receive({ type: "agent", kind: "say", source: "Agent", text: `message ${index}` });
  }
  const lines = page.log().children;
  assert.equal(lines.length, 200);
  assert.match(bodyOf(lines[0]).textContent, /message 5/);
  assert.match(bodyOf(lines[lines.length - 1]).textContent, /message 204/);
});

test("the in-flight reply bubble is never evicted mid-stream (#24)", (t) => {
  const page = installPage(t);
  connect(page);
  page.receive({ type: "start" });
  for (let index = 0; index < 250; index += 1) {
    page.receive({ type: "notice", text: `notice ${index}` });
  }
  page.receive({ type: "say", text: "still here" });
  page.receive({ type: "end" });
  const texts = [...page.log().children].map((line) => bodyOf(line).textContent);
  assert.ok(texts.some((text) => text.includes("still here")), "reply bubble survived the flood");
});

test("an empty chat submit is not activity (#71)", (t) => {
  const page = installPage(t);
  let activity = 0;
  connect(page, { onActivity: () => { activity += 1; } });
  page.nodes.get("#chat-input").value = "   ";
  page.nodes.get("#chat-bar").listeners.submit[0]({ preventDefault() {} });
  assert.equal(activity, 0);
});

// #215: a test page opened with ?bridge=off must never take the live avatar's voice.
test("only ?bridge=off turns the bridge off", () => {
  assert.equal(bridgeEnabled("?bridge=off"), false);
  assert.equal(bridgeEnabled("?mmd=x&bridge=off"), false);
  assert.equal(bridgeEnabled(""), true);
  assert.equal(bridgeEnabled("?bridge=on"), true);
  assert.equal(bridgeEnabled("?bridge=offline"), true);
});

test("with the bridge off no socket opens, the status says so and chat stays disabled", (t) => {
  const page = installPage(t);
  let constructed = 0;
  globalThis.WebSocket = class { static OPEN = 1; constructor() { constructed += 1; } };
  connect(page, { bridge: false });
  assert.equal(constructed, 0);
  assert.equal(page.nodes.get("#bridge-status").textContent, "Bridge off (test page)");
  assert.equal(page.nodes.get("#bridge-start").disabled, true);
  assert.equal(page.nodes.get("#chat-input").disabled, true);
  assert.equal(page.nodes.get("#chat-send").disabled, true);
});

test("the bridge still connects by default", (t) => {
  const page = installPage(t);
  connect(page);
  assert.ok(page.socket);
});
