// Renamed moods keep their old names as catalog aliases (#99).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadExpressionCatalog } from "../../renderer/expression-catalog.js";

const REAL = JSON.parse(await readFile(new URL("../../renderer/expressions.json", import.meta.url), "utf8"));

function serve(t, catalog) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => structuredClone(catalog) });
  t.after(() => { globalThis.fetch = original; });
}

const glad = { description: "Glad.", morphs: {} };
const withEntries = (entries) => ({ neutral: { description: "Rest.", morphs: {} }, ...entries });

test("the shipped catalog loads with new names and old names only as aliases", async (t) => {
  serve(t, REAL);
  const catalog = await loadExpressionCatalog();
  const renames = { "sad-v2": "sorrowful", "sad-sceptical": "rueful", "wtf-dude": "exasperated", "super-angry": "furious" };
  for (const [old, name] of Object.entries(renames)) {
    assert.ok(Object.hasOwn(catalog, name), name);
    assert.ok(!Object.hasOwn(catalog, old), old);
    assert.ok(catalog[name].aliases.includes(old), `${name} keeps ${old}`);
  }
});

test("valid aliases are accepted", async (t) => {
  serve(t, withEntries({ glad: { ...glad, aliases: ["glad-v2"] } }));
  assert.deepEqual((await loadExpressionCatalog()).glad.aliases, ["glad-v2"]);
});

test("malformed or colliding aliases are rejected", async (t) => {
  const bad = [
    { glad: { ...glad, aliases: "glad-v2" } },
    { glad: { ...glad, aliases: ["Glad"] } },
    { glad: { ...glad, aliases: [""] } },
    { glad: { ...glad, aliases: [3] } },
    { glad: { ...glad, aliases: ["glad"] } },
    { glad: { ...glad, aliases: ["neutral"] } },
    { glad: { ...glad, aliases: ["cheery"] }, happy: { ...glad, aliases: ["cheery"] } },
  ];
  for (const entries of bad) {
    serve(t, withEntries(entries));
    await assert.rejects(loadExpressionCatalog(), /alias/i, JSON.stringify(entries));
  }
});
