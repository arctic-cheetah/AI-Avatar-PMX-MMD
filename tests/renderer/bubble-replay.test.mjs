// #152: a replay button on every spoken chat bubble.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectBridge, resetFrame } from "../../renderer/bridge-client.js";
import { ChatHistory } from "../../renderer/chat-history.js";
import { installPage } from "./fake-dom.mjs";

const CATALOG = { neutral: {}, happy: {}, thinking: {} };
const T1 = "1".repeat(16);
const T2 = "2".repeat(16);
const CLIP = "c".repeat(16);
const noop = () => {};

function storage() {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
  };
}

function connect(extra = {}) {
  return connectBridge({ catalog: CATALOG, onStart: noop, onFinish: noop, onExpression: noop, onText: noop, onSpeak: noop, ...extra });
}

const speak = (turn, text = "Hello.") => ({ type: "speak", id: CLIP, turn, expression: "happy", weight: 1, text });
const replayOf = (line) => line.querySelectorAll("button").find((button) => button.classList.contains("chat-replay")) ?? null;

test("an agent bubble gets a replay button once its turn is spoken", (t) => {
  const page = installPage(t);
  const replays = [];
  connect({ onReplayTurn: (turn) => replays.push(turn) });
  page.receive({ type: "agent", kind: "say", source: "Claude Code", text: "On it.", turn: T1 });
  const [line] = page.log().children;
  assert.equal(replayOf(line), null, "no button before any audio exists");
  page.receive({ type: "turn", id: T1 });
  page.receive(speak(T1));
  const button = replayOf(line);
  assert.ok(button, "spoken bubble has a replay button");
  assert.equal(button.textContent, "▶ Replay");
  assert.equal(button.getAttribute("type"), "button");
  assert.ok(button.getAttribute("aria-label"));
  page.receive(speak(T1, "Second sentence."));
  assert.equal(line.querySelectorAll("button").filter((b) => b.classList.contains("chat-replay")).length, 1);
  button.emit("click");
  assert.deepEqual(replays, [T1]);
});

test("each bubble replays its own turn", (t) => {
  const page = installPage(t);
  const replays = [];
  connect({ onReplayTurn: (turn) => replays.push(turn) });
  page.receive({ type: "agent", kind: "say", source: "A", text: "One.", turn: T1 });
  page.receive({ type: "agent", kind: "ask", source: "A", id: "ab12", text: "Two?", turn: T2 });
  page.receive({ type: "turn", id: T1 });
  page.receive(speak(T1));
  page.receive({ type: "turn", id: T2 });
  page.receive(speak(T2));
  const [one, two] = page.log().children;
  replayOf(two).emit("click");
  replayOf(one).emit("click");
  assert.deepEqual(replays, [T2, T1]);
});

test("a streamed reply's bubble replays its turn and the saved entry keeps it", (t) => {
  const page = installPage(t);
  const history = new ChatHistory({ storage: storage() });
  const spoken = [];
  connect({ history, onSpeak: (event) => spoken.push(event) });
  page.receive({ type: "start", turn: T1 });
  page.receive({ type: "say", text: "Hello." });
  page.receive({ type: "turn", id: T1 });
  page.receive(speak(T1));
  page.receive({ type: "end" });
  assert.ok(replayOf(page.log().children[0]));
  assert.equal(spoken[0].turn, T1, "the clip URL is built from its turn");
  assert.equal(history.entries.at(-1).turn, T1);
});

test("a bubble whose turn never spoke has no button and saves no turn", (t) => {
  const page = installPage(t);
  const history = new ChatHistory({ storage: storage() });
  connect({ history });
  page.receive({ type: "start", turn: T1 });
  page.receive({ type: "say", text: "Speech failed." });
  page.receive({ type: "end" });
  page.receive({ type: "agent", kind: "report", source: "A", status: "done", text: "Text only.", turn: T2 });
  for (const line of page.log().children) assert.equal(replayOf(line), null);
  assert.equal(history.entries[0].turn, undefined);
  assert.equal(history.entries[1].turn, undefined, "an agent entry is saved with its turn only once spoken");
});

test("an agent entry saved before speech gains its turn when the first clip arrives", (t) => {
  const page = installPage(t);
  const session = storage();
  connect({ history: new ChatHistory({ storage: session }) });
  page.receive({ type: "agent", kind: "say", source: "A", text: "Queued.", turn: T1 });
  assert.equal(new ChatHistory({ storage: session }).load().entries[0].turn, undefined);
  page.receive(speak(T1));
  assert.equal(new ChatHistory({ storage: session }).load().entries[0].turn, T1);
});

test("a malformed turn ID is dropped, never turned into a clip path", (t) => {
  const page = installPage(t);
  const spoken = [];
  connect({ onSpeak: (event) => spoken.push(event) });
  page.receive(speak("../../../etc"));
  page.receive(speak("A".repeat(16)));
  assert.deepEqual(spoken, []);
});

test("restored bubbles keep their replay button after a refresh", (t) => {
  const page = installPage(t);
  const session = storage();
  const before = new ChatHistory({ storage: session });
  before.add({ who: "agent", kind: "say", source: "A", text: "Spoken.", turn: T1 });
  before.add({ who: "you", text: "Thanks" });
  before.add({ who: "yidhari", text: "Reply.", turn: T2 });
  const replays = [];
  connect({ history: new ChatHistory({ storage: session }), onReplayTurn: (turn) => replays.push(turn) });
  const [say, you, reply] = page.log().children;
  assert.ok(replayOf(say));
  assert.equal(replayOf(you), null);
  replayOf(reply).emit("click");
  assert.deepEqual(replays, [T2]);
});

test("an unknown or invalid saved turn is dropped from the entry, not the entry", () => {
  const session = storage();
  session.setItem("yidhari.chat-log.v1", JSON.stringify({ version: 1, entries: [
    { who: "yidhari", text: "kept", turn: "../x" },
    { who: "you", text: "mine", turn: T1 },
  ] }));
  assert.deepEqual(new ChatHistory({ storage: session }).load().entries, [
    { who: "yidhari", text: "kept" },
    { who: "you", text: "mine" },
  ]);
});

test("replay buttons follow the busy state, and a pruned turn stays too old", (t) => {
  const page = installPage(t);
  const api = connect();
  page.receive({ type: "agent", kind: "say", source: "A", text: "One.", turn: T1 });
  page.receive(speak(T1));
  page.receive({ type: "agent", kind: "say", source: "A", text: "Two.", turn: T2 });
  page.receive(speak(T2));
  const [one, two] = page.log().children.map(replayOf);
  api.setReplayEnabled(false);
  assert.equal(one.disabled && two.disabled, true);
  api.setReplayEnabled(true);
  assert.equal(one.disabled || two.disabled, false);
  api.turnGone(T1);
  assert.equal(one.disabled, true);
  assert.equal(one.textContent, "Too old to replay");
  api.setReplayEnabled(true);
  assert.equal(one.disabled, true, "a pruned turn never comes back");
  assert.equal(two.disabled, false);
});

test("a turn with no audio says so instead of offering replay", (t) => {
  const page = installPage(t);
  const api = connect();
  page.receive({ type: "agent", kind: "say", source: "A", text: "One.", turn: T1 });
  page.receive(speak(T1));
  api.turnEmpty(T1);
  const button = replayOf(page.log().children[0]);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "No audio to replay");
});

test("the greeting bubble replays the greeting's turn", (t) => {
  const page = installPage(t);
  const replays = [];
  connect({ greeting: { text: "Good evening!", mood: "happy", weight: 1 }, onReplayTurn: (turn) => replays.push(turn) });
  page.socket.onopen();
  page.receive({ type: "turn", id: T1, greeting: true });
  page.receive(speak(T1));
  replayOf(page.log().children[0]).emit("click");
  assert.deepEqual(replays, [T1]);
});

test("new chat asks the bridge to delete its bubbles' audio", (t) => {
  const page = installPage(t);
  const session = storage();
  new ChatHistory({ storage: session }).add({ who: "yidhari", text: "Earlier.", turn: T1 });
  connect({ history: new ChatHistory({ storage: session }) });
  page.receive({ type: "agent", kind: "say", source: "A", text: "Now.", turn: T2 });
  page.receive(speak(T2));
  page.nodes.get("#chat-new").emit("click");
  assert.deepEqual(JSON.parse(page.sent.at(-1)), { type: "reset", turns: [T1, T2] });
});

test("reset frames name turns only when there are some", () => {
  assert.deepEqual(JSON.parse(resetFrame()), { type: "reset" });
  assert.deepEqual(JSON.parse(resetFrame([])), { type: "reset" });
  assert.deepEqual(JSON.parse(resetFrame([T1, "../x", T1])), { type: "reset", turns: [T1] });
});
