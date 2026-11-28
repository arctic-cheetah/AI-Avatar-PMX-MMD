// Run with: node --test tests/renderer/*.test.mjs
// Speech buffering (#278): the renderer's choice of when the bridge announces clips.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUFFERING_KEY,
  BUFFERING_MODES,
  bindBufferingSelect,
  bufferingLabel,
  connectFrame,
  settingsFrame,
  storedBuffering,
} from "../../renderer/speech-buffering.js";

function memoryStorage(entries = {}) {
  const data = new Map(Object.entries(entries));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    data,
  };
}

function select(value = "") {
  const listeners = [];
  return { value, addEventListener: (_, fn) => listeners.push(fn), fire() { listeners.forEach((fn) => fn()); } };
}

test("the three modes match the bridge's", () => {
  assert.deepEqual(BUFFERING_MODES, ["stream", "full", "adaptive"]);
});

test("a settings frame names a mode, or null for the launch flag's mode", () => {
  assert.deepEqual(JSON.parse(settingsFrame("full")), { type: "settings", speechBuffering: "full" });
  assert.deepEqual(JSON.parse(settingsFrame(null)), { type: "settings", speechBuffering: null });
  assert.deepEqual(JSON.parse(settingsFrame("turbo")), { type: "settings", speechBuffering: null });
});

test("on connect a stored mode is set, and no choice only asks (#279 review)", () => {
  assert.deepEqual(JSON.parse(connectFrame("full")), { type: "settings", speechBuffering: "full" });
  assert.deepEqual(JSON.parse(connectFrame(null)), { type: "settings" });
  assert.deepEqual(JSON.parse(connectFrame("turbo")), { type: "settings" });
});

test("only a known stored mode is used", () => {
  assert.equal(storedBuffering(memoryStorage({ [BUFFERING_KEY]: "adaptive" })), "adaptive");
  assert.equal(storedBuffering(memoryStorage({ [BUFFERING_KEY]: "turbo" })), null);
  assert.equal(storedBuffering(memoryStorage()), null);
  const throwing = { getItem() { throw new Error("blocked"); } };
  assert.equal(storedBuffering(throwing), null);
});

test("the select starts from storage, then saves and reports each change", () => {
  const local = memoryStorage({ [BUFFERING_KEY]: "full" });
  const seen = [];
  const box = select();
  bindBufferingSelect(box, (mode) => seen.push(mode), { local });
  assert.equal(box.value, "full");
  assert.deepEqual(seen, [], "the starting mode is sent when the bridge connects, not here");
  box.value = "adaptive";
  box.fire();
  assert.equal(local.data.get(BUFFERING_KEY), "adaptive");
  box.value = "";
  box.fire();
  assert.equal(local.data.has(BUFFERING_KEY), false, "the launch default is not stored");
  assert.deepEqual(seen, ["adaptive", null]);
});

test("storage that throws keeps the choice for the session", () => {
  const local = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); }, removeItem() { throw new Error("x"); } };
  const seen = [];
  const box = select();
  bindBufferingSelect(box, (mode) => seen.push(mode), { local });
  box.value = "full";
  box.fire();
  assert.deepEqual(seen, ["full"]);
});

test("labels name what the bridge is using", () => {
  assert.equal(bufferingLabel("stream"), "Stream");
  assert.equal(bufferingLabel("full"), "Wait for full reply");
  assert.equal(bufferingLabel("adaptive"), "Adaptive");
});
