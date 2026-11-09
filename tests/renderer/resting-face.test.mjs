// Resting face (#99 step 3): neutral clears the mood, then the face settles
// into a chosen calm preset instead of the bare mesh, which already smiles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ExpressionController } from "../../renderer/expression-controller.js";
import { DEFAULT_RESTING_FACE, RESTING_FACE_KEY, bindRestingFaceToggle } from "../../renderer/resting-face.js";
import { syntheticFace } from "./transition-fixtures.mjs";

const SHIPPED = JSON.parse(await readFile(new URL("../../renderer/expressions.json", import.meta.url), "utf8"));

const CATALOG = {
  neutral: { morphs: {} },
  happy: { morphs: { smile: 1 } },
  calm: { morphs: { frown: 0.45, squint: 0.25 } },
  broken: { morphs: { missing: 1 } },
};

function face() {
  const mesh = syntheticFace(["smile", "frown", "squint"]);
  return { mesh, expressions: new ExpressionController(mesh, CATALOG) };
}

/** Run the springs long enough to settle. */
function settle(expressions) {
  for (let i = 0; i < 240; i += 1) expressions.update(1 / 60);
}

const weights = ({ mesh }) => Object.fromEntries(
  Object.entries(mesh.morphTargetDictionary).map(([name, index]) => [name, Math.round(mesh.morphTargetInfluences[index] * 1000) / 1000]),
);

function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), map };
}

function toggle() {
  const listeners = [];
  return {
    checked: false,
    addEventListener: (type, fn) => type === "change" && listeners.push(fn),
    flip(value) { this.checked = value; for (const fn of listeners) fn(); },
  };
}

test("without a resting face, neutral still shows the bare mesh", () => {
  const rig = face();
  rig.expressions.setExpression("happy");
  settle(rig.expressions);
  rig.expressions.setExpression("neutral");
  settle(rig.expressions);
  assert.deepEqual(weights(rig), { smile: 0, frown: 0, squint: 0 });
});

test("neutral settles into the resting face and stays named neutral", () => {
  const rig = face();
  assert.equal(rig.expressions.setRestingFace("calm"), true);
  settle(rig.expressions);
  assert.equal(rig.expressions.activeExpression, "neutral");
  assert.deepEqual(weights(rig), { smile: 0, frown: 0.45, squint: 0.25 });
});

test("a mood replaces the resting face instead of stacking on it", () => {
  const rig = face();
  rig.expressions.setRestingFace("calm");
  rig.expressions.setExpression("happy");
  settle(rig.expressions);
  assert.deepEqual(weights(rig), { smile: 1, frown: 0, squint: 0 });
  rig.expressions.setExpression("neutral");
  settle(rig.expressions);
  assert.deepEqual(weights(rig), { smile: 0, frown: 0.45, squint: 0.25 });
});

test("turning the resting face off clears it back to the bare mesh", () => {
  const rig = face();
  rig.expressions.setRestingFace("calm");
  settle(rig.expressions);
  assert.equal(rig.expressions.setRestingFace(null), true);
  settle(rig.expressions);
  assert.deepEqual(weights(rig), { smile: 0, frown: 0, squint: 0 });
});

test("changing the resting face does not interrupt an active mood", () => {
  const rig = face();
  rig.expressions.setExpression("happy");
  rig.expressions.setRestingFace("calm");
  settle(rig.expressions);
  assert.equal(rig.expressions.activeExpression, "happy");
  assert.deepEqual(weights(rig), { smile: 1, frown: 0, squint: 0 });
});

test("unknown, neutral or unavailable resting faces are refused and keep the previous one", () => {
  const rig = face();
  rig.expressions.setRestingFace("calm");
  for (const name of ["nope", "neutral", "broken", 3, ""]) {
    assert.equal(rig.expressions.setRestingFace(name), false, String(name));
  }
  assert.equal(rig.expressions.restingFace, "calm");
});

test("the shipped catalog has the calm presets, and the default resting face is one of them", () => {
  for (const name of ["serene", "composed", "attentive", "calm"]) {
    assert.ok(Object.hasOwn(SHIPPED, name), name);
    assert.ok(Object.keys(SHIPPED[name].morphs).length > 0, `${name} has morphs`);
  }
  assert.equal(DEFAULT_RESTING_FACE, "calm");
  assert.deepEqual(SHIPPED.neutral.morphs, {}, "neutral itself stays empty");
});

test("the page toggle starts on, applies the default and remembers being turned off", () => {
  const rig = face();
  const local = storage();
  const box = toggle();
  bindRestingFaceToggle(rig.expressions, box, { local, name: "calm" });
  assert.equal(box.checked, true);
  assert.equal(rig.expressions.restingFace, "calm");
  box.flip(false);
  assert.equal(rig.expressions.restingFace, null);
  assert.equal(local.map.get(RESTING_FACE_KEY), "0");

  const again = face();
  const reopened = toggle();
  bindRestingFaceToggle(again.expressions, reopened, { local, name: "calm" });
  assert.equal(reopened.checked, false);
  assert.equal(again.expressions.restingFace, null);
});

test("the toggle still works when storage throws", () => {
  const rig = face();
  const local = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const box = toggle();
  bindRestingFaceToggle(rig.expressions, box, { local, name: "calm" });
  assert.equal(rig.expressions.restingFace, "calm");
  box.flip(false);
  assert.equal(rig.expressions.restingFace, null);
});
