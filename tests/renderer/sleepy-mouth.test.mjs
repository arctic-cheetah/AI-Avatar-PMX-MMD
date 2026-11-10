// Run with: node --test tests/renderer/*.test.mjs
// Sleepy mouth and slow, yawn-like easing for #71.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadExpressionCatalog } from "../../renderer/expression-catalog.js";
import { ExpressionController } from "../../renderer/expression-controller.js";
import { TIMING } from "../../renderer/smoothing.js";

const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const REAL = await read("../../renderer/expressions.json");
const SHAPES = await read("../../renderer/speech-shapes.json");
/** Morphs lip sync drives; speech holds them, so a mood mouth made of them never stacks. */
const SPEECH_MORPHS = new Set(Object.values(SHAPES).flatMap((shape) => Object.keys(shape.morphs)));
const MOUTH = /^(あ|い|う|え|お|□|ワ|ワ２|え２|い２|お２)$/;

function serve(t, catalog) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => structuredClone(catalog) });
  t.after(() => { globalThis.fetch = original; });
}

test("the sleepy face parts the mouth, using only morphs lip sync takes over", () => {
  const mouth = Object.entries(REAL.sleepy.morphs).filter(([morph]) => MOUTH.test(morph));
  assert.ok(mouth.length > 0, "sleepy has an open mouth");
  assert.ok(mouth.reduce((sum, [, weight]) => sum + weight, 0) >= 0.5, "open enough to read at a glance");
  for (const [morph] of mouth) assert.ok(SPEECH_MORPHS.has(morph), `${morph} is a speech morph`);
  assert.ok(REAL.sleepy.morphs["じと目"] > 0, "the drowsy eyelids stay");
});

test("sleepy eases in slowly, like a yawn, and still settles within two seconds", () => {
  assert.ok(Number.isFinite(REAL.sleepy.ease));
  assert.ok(REAL.sleepy.ease < TIMING.expression / 2, "clearly slower than a normal mood change");
  assert.ok(REAL.sleepy.ease >= 2.5, "settles within two seconds");
});

test("the catalog accepts a positive ease and rejects anything else", async (t) => {
  const base = { neutral: { description: "Rest.", morphs: {} } };
  serve(t, { ...base, slow: { description: "Slow.", morphs: {}, ease: 3 } });
  assert.equal((await loadExpressionCatalog()).slow.ease, 3);
  for (const ease of [0, -1, Number.NaN, "3", 61, null]) {
    serve(t, { ...base, slow: { description: "Slow.", morphs: {}, ease } });
    await assert.rejects(loadExpressionCatalog(), /ease/i, String(ease));
  }
});

const CATALOG = {
  neutral: { morphs: {} },
  sleepy: { morphs: { lids: 1, jaw: 1 }, ease: 3 },
  happy: { morphs: { smile: 1 } },
};
function face() {
  const names = ["lids", "jaw", "smile"];
  return {
    morphTargetDictionary: Object.fromEntries(names.map((name, i) => [name, i])),
    morphTargetInfluences: names.map(() => 0),
  };
}
function settle(controller, seconds, fps = 60) {
  for (let i = 0; i < Math.round(seconds * fps); i += 1) controller.update(1 / fps);
}

test("a preset with its own ease opens slowly instead of at the mood rate", () => {
  const slow = new ExpressionController(face(), CATALOG);
  slow.setExpression("sleepy");
  settle(slow, 0.34);
  const jaw = slow.mesh.morphTargetInfluences[1];
  assert.ok(jaw < 0.5, `only part-way after the usual 0.34 s (${jaw.toFixed(2)})`);
  assert.ok(jaw > 0.05, "but already moving");
  settle(slow, 1.7);
  assert.ok(slow.mesh.morphTargetInfluences[1] > 0.98, "settled by about 2 s");
});

test("the slow opening is smooth and frame-rate independent", () => {
  const at = (fps) => {
    const controller = new ExpressionController(face(), CATALOG);
    controller.setExpression("sleepy");
    let previous = 0;
    let biggest = 0;
    for (let i = 0; i < fps; i += 1) {
      controller.update(1 / fps);
      const jaw = controller.mesh.morphTargetInfluences[1];
      biggest = Math.max(biggest, jaw - previous);
      previous = jaw;
    }
    return { value: previous, step: biggest };
  };
  const sixty = at(60);
  assert.ok(Math.abs(sixty.value - at(15).value) < 1e-9, "same curve at 15 and 60 fps");
  assert.ok(sixty.step < 0.03, `no visible jump per 60 fps frame (${sixty.step.toFixed(3)})`);
});

test("leaving the slow preset uses the next preset's rate, so waking up is quick", () => {
  const controller = new ExpressionController(face(), CATALOG);
  controller.setExpression("sleepy");
  settle(controller, 3);
  controller.setExpression("happy");
  settle(controller, 0.4);
  const [lids, jaw, smile] = controller.mesh.morphTargetInfluences;
  assert.ok(jaw < 0.1 && lids < 0.1, "the sleepy face is gone");
  assert.ok(smile > 0.9, "happy is nearly there");
  assert.equal(controller.rate, TIMING.expression);
});

test("neutral after a slow preset goes back to the mood rate", () => {
  const controller = new ExpressionController(face(), CATALOG);
  controller.setExpression("sleepy");
  controller.setExpression("neutral");
  assert.equal(controller.rate, TIMING.expression);
});
