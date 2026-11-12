// Run with: node --test tests/renderer/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { bindStoredToggle } from "../../renderer/stored-toggle.js";

function memoryStorage(entries = {}) {
  const data = new Map(Object.entries(entries));
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), data };
}

function checkbox() {
  const listeners = [];
  return { checked: false, addEventListener: (_, fn) => listeners.push(fn), fire() { listeners.forEach((fn) => fn()); } };
}

test("with nothing stored, a toggle starts on by default", () => {
  const seen = [];
  const toggle = checkbox();
  bindStoredToggle(toggle, "k", (on) => seen.push(on), { local: memoryStorage() });
  assert.deepEqual(seen, [true]);
  assert.equal(toggle.checked, true);
});

test("defaultOn: false starts off until the user turns it on, then remembers", () => {
  const local = memoryStorage();
  const seen = [];
  const toggle = checkbox();
  bindStoredToggle(toggle, "k", (on) => seen.push(on), { local, defaultOn: false });
  assert.deepEqual(seen, [false]);
  assert.equal(toggle.checked, false);
  toggle.checked = true;
  toggle.fire();
  assert.equal(local.data.get("k"), "1");
  const again = [];
  bindStoredToggle(checkbox(), "k", (on) => again.push(on), { local, defaultOn: false });
  assert.deepEqual(again, [true]);
});

test("a stored choice wins over the default either way", () => {
  const off = [];
  bindStoredToggle(checkbox(), "k", (on) => off.push(on), { local: memoryStorage({ k: "0" }) });
  const on = [];
  bindStoredToggle(checkbox(), "k", (v) => on.push(v), { local: memoryStorage({ k: "1" }), defaultOn: false });
  assert.deepEqual([off, on], [[false], [true]]);
});

test("storage that throws falls back to the default", () => {
  const local = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const seen = [];
  bindStoredToggle(checkbox(), "k", (on) => seen.push(on), { local, defaultOn: false });
  assert.deepEqual(seen, [false]);
});
