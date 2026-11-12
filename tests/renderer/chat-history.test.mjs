// #105: the chat log survives a page refresh (sessionStorage, display only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatHistory, CHAT_LOG_KEY } from "../../renderer/chat-history.js";
import { connectBridge } from "../../renderer/bridge-client.js";
import { installPage } from "./fake-dom.mjs";

function storage() {
  const items = new Map();
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
  };
}

const blocked = {
  getItem() { throw new Error("blocked"); },
  setItem() { throw new Error("blocked"); },
  removeItem() { throw new Error("blocked"); },
};

test("entries saved in one page load come back in order in the next", () => {
  const session = storage();
  const before = new ChatHistory({ storage: session });
  assert.deepEqual(before.load(), { entries: [], damaged: false });
  before.add({ who: "you", text: "Hello" });
  before.add({ who: "yidhari", text: "**Hi!**" });
  before.add({ who: "agent", kind: "report", source: "Claude Code", status: "done", text: "line 1\nline 2" });
  const after = new ChatHistory({ storage: session }).load();
  assert.equal(after.damaged, false);
  assert.deepEqual(after.entries, [
    { who: "you", text: "Hello" },
    { who: "yidhari", text: "**Hi!**" },
    { who: "agent", kind: "report", source: "Claude Code", status: "done", text: "line 1\nline 2" },
  ]);
});

test("the oldest entries go first when the count or character limit is reached", () => {
  const session = storage();
  const byCount = new ChatHistory({ storage: session, maxEntries: 2 });
  byCount.load();
  for (const text of ["one", "two", "three"]) byCount.add({ who: "you", text });
  assert.deepEqual(new ChatHistory({ storage: session }).load().entries.map((e) => e.text), ["two", "three"]);

  const other = storage();
  const byChars = new ChatHistory({ storage: other, maxChars: 10 });
  byChars.load();
  for (const text of ["aaaa", "bbbb", "cccc"]) byChars.add({ who: "you", text });
  assert.deepEqual(new ChatHistory({ storage: other }).load().entries.map((e) => e.text), ["bbbb", "cccc"]);
});

test("damaged saved data is reported and invalid entries are dropped", () => {
  const session = storage();
  session.setItem(CHAT_LOG_KEY, "{not json");
  assert.deepEqual(new ChatHistory({ storage: session }).load(), { entries: [], damaged: true });

  session.setItem(CHAT_LOG_KEY, JSON.stringify({ version: 1, entries: [
    { who: "you", text: "kept" },
    { who: "root", text: "unknown role" },
    { who: "yidhari", text: 42 },
    { who: "agent", kind: "report", source: "A", status: "panic", text: "bad status" },
    null,
  ] }));
  const loaded = new ChatHistory({ storage: session }).load();
  assert.equal(loaded.damaged, true);
  assert.deepEqual(loaded.entries, [{ who: "you", text: "kept" }]);
});

test("blocked storage never throws; it only reports that nothing was saved", () => {
  const history = new ChatHistory({ storage: blocked });
  assert.deepEqual(history.load(), { entries: [], damaged: false });
  assert.equal(history.add({ who: "you", text: "Hello" }), false);
  assert.equal(history.clear(), false);
});

test("clear removes the saved log", () => {
  const session = storage();
  const history = new ChatHistory({ storage: session });
  history.load();
  history.add({ who: "you", text: "Hello" });
  assert.equal(history.clear(), true);
  assert.deepEqual(new ChatHistory({ storage: session }).load().entries, []);
});

// --- connectBridge: saving the live log and rebuilding it after a refresh ---

function open(page, session, calls = []) {
  const record = (name) => (...args) => calls.push([name, ...args]);
  const unload = [];
  connectBridge({
    catalog: { happy: {} },
    onStart: record("start"), onFinish() {}, onExpression: record("expression"),
    onText: record("text"), onSpeak: record("speak"), onAgentSay: record("agentSay"),
    onAgentMood: record("agentMood"), onTurn: record("turn"), onGreeting: record("greeting"),
    greeting: { text: "Good morning! Ready for today?", mood: "happy", weight: 0.9 },
    history: new ChatHistory({ storage: session }),
    win: { addEventListener: (type, listener) => { if (type === "pagehide") unload.push(listener); } },
  });
  return { unload: () => unload.forEach((listener) => listener()) };
}

/** A page refresh: fresh DOM nodes and a fresh connectBridge on the same sessionStorage. */
function reload(page, session, calls) {
  page.nodes.clear();
  page.sent.length = 0;
  return open(page, session, calls);
}

function lines(page) {
  return page.log().children.map((line) => ({
    className: line.className,
    who: line.children[0].textContent,
    text: line.children[1].textContent,
  }));
}

function chat(page) {
  page.receive({ type: "start" });
  page.receive({ type: "say", text: "Hello " });
  page.receive({ type: "say", text: "**there**" });
  page.receive({ type: "end" });
  page.receive({ type: "notice", text: "Using get_time…" });
  page.receive({ type: "agent", kind: "say", source: "Claude Code", text: "On it." });
  page.receive({ type: "agent", kind: "report", source: "Claude Code", status: "done", text: "All done\n\n- tests pass" });
}

test("a refresh rebuilds the same log in order, without the greeting, and adds a memory note", (t) => {
  const page = installPage(t);
  const session = storage();
  open(page, session);
  page.socket.onopen();
  page.nodes.get("#chat-input").value = "Hi Yidhari";
  page.nodes.get("#chat-bar").listeners.submit[0]({ preventDefault() {} });
  chat(page);
  const before = lines(page).slice(1); // The first line is the page-open greeting.

  reload(page, session);
  const after = lines(page);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.equal(after.length, before.length + 1, "only one extra line: the restored-history note");
  const note = after.at(-1);
  assert.match(note.className, /chat-restored/);
  assert.match(note.text, /won't remember/);
  assert.ok(!after.some((line) => line.text.includes("Good morning")), "the greeting is not saved");
});

test("restoring is display only: no speech, mood, tool or question side effects", (t) => {
  const page = installPage(t);
  const session = storage();
  open(page, session);
  chat(page);
  page.receive({ type: "agent", kind: "ask", source: "Claude Code", id: "ab12", text: "Commit?" });

  const calls = [];
  reload(page, session, calls);
  assert.deepEqual(calls, [], "restoring must not call speech, text, mood or agent hooks");
  assert.deepEqual(page.sent, [], "restoring must not send anything to the bridge");
  const ask = lines(page).find((line) => line.text.includes("Commit?"));
  assert.match(ask.className, /chat-ask-closed/);

  // The restored question is no longer pending: the next message starts a chat reply.
  page.nodes.get("#chat-input").value = "Yes please";
  page.nodes.get("#chat-bar").listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(page.sent.map((frame) => JSON.parse(frame).type), ["start"]);
});

test("a reply cut off by a refresh, a dropped bridge or an error is restored as interrupted", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); // Keep the reconnect timer from firing after the test.
  const page = installPage(t);
  const session = storage();
  const first = open(page, session);
  page.receive({ type: "start" });
  page.receive({ type: "say", text: "Half a th" });
  first.unload(); // The page unloads mid-stream.
  reload(page, session);
  let restored = lines(page).find((line) => line.text === "Half a th");
  assert.match(restored.className, /chat-interrupted/);
  assert.match(restored.who, /interrupted/);

  page.receive({ type: "start" });
  page.receive({ type: "say", text: "Dropped" });
  page.socket.onclose();
  page.receive({ type: "start" });
  page.receive({ type: "say", text: "Errored" });
  page.receive({ type: "error", text: "Upstream failed" });
  reload(page, session);
  for (const text of ["Dropped", "Errored"]) {
    restored = lines(page).find((line) => line.text === text);
    assert.match(restored.className, /chat-interrupted/, `${text} should be marked interrupted`);
  }
  assert.equal(lines(page).filter((line) => line.text === "Half a th").length, 1, "no duplicates");
});

test("New chat clears the saved log, so a refresh shows an empty chat", (t) => {
  const page = installPage(t);
  const session = storage();
  open(page, session);
  chat(page);
  page.receive({ type: "reset" });
  reload(page, session);
  assert.deepEqual(lines(page), []);
});

test("damaged saved data shows a notice instead of breaking the chat", (t) => {
  const page = installPage(t);
  const session = storage();
  session.setItem(CHAT_LOG_KEY, "{not json");
  open(page, session);
  assert.match(page.nodes.get("#chat-log").children[0].className, /chat-restored/);
  assert.match(page.nodes.get("#chat-log").children[0].children[1].textContent, /could not be restored/i);
  chat(page);
  assert.ok(new ChatHistory({ storage: session }).load().entries.length > 0, "new lines are saved again");
});

// --- #154: the log survives closing the tab (localStorage, display only) ---

test("the log is kept in localStorage by default, so it survives closing the tab", (t) => {
  const local = storage();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
  const history = new ChatHistory();
  history.load();
  history.add({ who: "you", text: "Hello" });
  assert.ok(local.items.has(CHAT_LOG_KEY));
  assert.deepEqual(new ChatHistory().load().entries, [{ who: "you", text: "Hello" }]);
});

test("a log saved in sessionStorage by an older version is moved over once", () => {
  const local = storage();
  const session = storage();
  const old = new ChatHistory({ storage: session, legacy: null });
  old.add({ who: "you", text: "From before" });
  const moved = new ChatHistory({ storage: local, legacy: session }).load();
  assert.deepEqual(moved.entries, [{ who: "you", text: "From before" }]);
  assert.equal(session.items.has(CHAT_LOG_KEY), false, "the old copy is removed");
  assert.ok(local.items.has(CHAT_LOG_KEY));

  session.setItem(CHAT_LOG_KEY, JSON.stringify({ version: 1, entries: [{ who: "you", text: "stale" }] }));
  assert.deepEqual(new ChatHistory({ storage: local, legacy: session }).load().entries.map((e) => e.text),
    ["From before"], "an existing localStorage log wins");
});

test("two tabs add to one saved log instead of overwriting each other", () => {
  const shared = storage();
  const a = new ChatHistory({ storage: shared, legacy: null });
  const b = new ChatHistory({ storage: shared, legacy: null });
  a.load();
  b.load();
  a.add({ who: "you", text: "from A" });
  b.add({ who: "you", text: "from B" });
  a.add({ who: "you", text: "A again" });
  assert.deepEqual(new ChatHistory({ storage: shared }).load().entries.map((e) => e.text),
    ["from A", "from B", "A again"]);
});

test("a spoken turn is saved on the right entry after another tab wrote", () => {
  const shared = storage();
  const a = new ChatHistory({ storage: shared, legacy: null });
  const b = new ChatHistory({ storage: shared, legacy: null });
  a.load();
  b.load();
  a.add({ who: "agent", kind: "say", source: "A", text: "Spoken." });
  const id = a.last().id;
  b.add({ who: "you", text: "Meanwhile" });
  assert.equal(a.setTurn(id, "1".repeat(16)), true);
  assert.deepEqual(new ChatHistory({ storage: shared }).load().entries, [
    { who: "agent", kind: "say", source: "A", text: "Spoken.", turn: "1".repeat(16) },
    { who: "you", text: "Meanwhile" },
  ]);
});

test("New chat in one tab is not undone by the other tab's next message", () => {
  const shared = storage();
  const a = new ChatHistory({ storage: shared, legacy: null });
  const b = new ChatHistory({ storage: shared, legacy: null });
  a.load();
  b.load();
  a.add({ who: "you", text: "old" });
  b.add({ who: "you", text: "old too" });
  a.clear();
  b.add({ who: "you", text: "new" });
  assert.deepEqual(new ChatHistory({ storage: shared }).load().entries.map((e) => e.text), ["new"]);
});
