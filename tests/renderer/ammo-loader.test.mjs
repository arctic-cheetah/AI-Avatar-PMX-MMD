// Run with: node --test tests/renderer/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAmmoLoader } from "../../renderer/ammo-loader.js";

/** A fake document whose <script> elements "load" when the test says so. */
function fakeDocument() {
  const scripts = [];
  return {
    scripts,
    createElement: (tag) => {
      assert.equal(tag, "script");
      const script = { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
      return script;
    },
    head: { append: (script) => scripts.push(script) },
  };
}

const URL_ = "https://cdn.example/three/examples/jsm/libs/ammo.wasm.js";

test("injects one classic script, awaits the factory and publishes the global Ammo", async () => {
  const doc = fakeDocument();
  const global = {};
  const lib = { btVector3: class {} };
  const load = createAmmoLoader({ url: URL_, doc, global });
  const loading = load();
  assert.equal(doc.scripts.length, 1);
  assert.equal(doc.scripts[0].src, URL_);
  assert.equal(doc.scripts[0].async, true);
  global.Ammo = async () => lib; // what ammo.wasm.js defines
  doc.scripts[0].listeners.load();
  assert.equal(await loading, lib);
  assert.equal(global.Ammo, lib, "MMDPhysics reads the global Ammo");
});

test("loads at most once, however many callers ask", async () => {
  const doc = fakeDocument();
  const global = {};
  const load = createAmmoLoader({ url: URL_, doc, global });
  const a = load();
  const b = load();
  global.Ammo = async () => ({});
  doc.scripts[0].listeners.load();
  assert.equal(await a, await b);
  assert.equal(doc.scripts.length, 1);
});

test("a script error rejects with the URL, and a later call retries", async () => {
  const doc = fakeDocument();
  const global = {};
  const load = createAmmoLoader({ url: URL_, doc, global });
  const first = load();
  doc.scripts[0].listeners.error();
  await assert.rejects(first, (error) => error.message.includes(URL_));
  const second = load();
  assert.equal(doc.scripts.length, 2);
  global.Ammo = async () => ({ ok: true });
  doc.scripts[1].listeners.load();
  assert.deepEqual(await second, { ok: true });
});

test("a script that defines no Ammo factory is an error, not a hang", async () => {
  const doc = fakeDocument();
  const load = createAmmoLoader({ url: URL_, doc, global: {} });
  const loading = load();
  doc.scripts[0].listeners.load();
  await assert.rejects(loading, /Ammo/);
});
