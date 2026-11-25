// Run with: node --test tests/renderer/facial-layers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { EYE_CLOSURE, EYE_GROUPS, capEyeClosure, clampMorphs, composeBlink, eyeClosure } from "../../renderer/facial-layers.js";

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);

test("idle blink keeps a mood's own blink weight between blinks", () => {
  // furious holds まばたき at 0.3; the blink used to overwrite it with 0.
  close(composeBlink(0.3, 0), 0.3);
  close(composeBlink(0, 0.5), 0.5);
});

test("a full blink still closes the eyes completely over a partial mood", () => {
  close(composeBlink(0.3, 1), 1);
  close(composeBlink(0.3, 0.5), 0.65);
});

test("eyes already closed by the mood or a wink do not blink on top", () => {
  close(composeBlink(0, 1, 1), 0);
  close(composeBlink(0, 1, 0.6), 0.4);
  close(composeBlink(0.3, 1, 1), 0.3);
});

test("eye closure reads the strongest closing morph on the face", () => {
  const face = {
    morphTargetDictionary: { "笑い": 0, "ウィンク": 1, other: 2 },
    morphTargetInfluences: [0.6, 0, 1],
  };
  close(eyeClosure(face), 0.6);
  face.morphTargetInfluences[1] = 1;
  close(eyeClosure(face), 1);
  assert.equal(eyeClosure({ morphTargetDictionary: {}, morphTargetInfluences: [] }), 0);
  assert.equal(eyeClosure(null), 0);
});

test("closure table covers the closed-eye smile and both winks", () => {
  for (const name of ["笑い", "ウィンク", "ウィンク右"]) assert.ok(EYE_CLOSURE[name] > 0, name);
  assert.equal(EYE_CLOSURE["まばたき"], undefined, "the blink morph itself is never a closure source");
});

// Eye budget (#49): a held pose's wink on top of the happy mood's 笑い closed
// the right eye twice over, and the lids clipped. Each eye's closing morphs
// together stay at or under 1.
const face = (weights) => {
  const names = ["笑い", "ウィンク", "ウィンク右", "ウィンク２", "ウィンク２右", "まばたき", "あ"];
  return {
    morphTargetDictionary: Object.fromEntries(names.map((name, i) => [name, i])),
    morphTargetInfluences: names.map((name) => weights[name] ?? 0),
  };
};
const weight = (mesh, name) => mesh.morphTargetInfluences[mesh.morphTargetDictionary[name]];
const eyeSum = (mesh, side) => EYE_GROUPS[side].reduce((sum, name) => sum + weight(mesh, name), 0);

test("a wink on top of a closed-eye smile is scaled so each eye closes once", () => {
  const mesh = face({ "笑い": 1, "ウィンク右": 1 });
  capEyeClosure(mesh);
  assert.ok(Math.abs(eyeSum(mesh, "right") - 1) < 1e-12);
  assert.ok(eyeSum(mesh, "left") <= 1 + 1e-12);
  assert.ok(Math.abs(weight(mesh, "笑い") - 0.5) < 1e-12);
  assert.ok(Math.abs(weight(mesh, "ウィンク右") - 0.5) < 1e-12);
});

test("both eyes end at or under 1 when every closer is busy", () => {
  const mesh = face({ "笑い": 0.6, "まばたき": 0.6, "ウィンク": 0.6, "ウィンク右": 0.3, "ウィンク２右": 0.4 });
  capEyeClosure(mesh);
  assert.ok(eyeSum(mesh, "left") <= 1 + 1e-12);
  assert.ok(eyeSum(mesh, "right") <= 1 + 1e-12);
  assert.ok(Math.abs(weight(mesh, "笑い") / weight(mesh, "まばたき") - 1) < 1e-12, "shared closers keep their ratio");
});

test("a face within budget and other morphs are left alone", () => {
  const mesh = face({ "笑い": 0.4, "ウィンク右": 0.5, "あ": 1 });
  const before = [...mesh.morphTargetInfluences];
  capEyeClosure(mesh);
  assert.deepEqual(mesh.morphTargetInfluences, before);
  capEyeClosure({});
  capEyeClosure({ morphTargetDictionary: { "笑い": 0 }, morphTargetInfluences: [2] });
});

// Each morph ≤ 1 (#49, the user's pick): layers add up (pose, mood, speech,
// audition sliders), so the last pass keeps every influence within 0–1. Sums
// across different morphs are left alone: 上左 + 上右 move different brows.
test("every morph ends within 0 to 1, and sums across morphs are kept", () => {
  const mesh = { morphTargetDictionary: { "あ": 0, "ワ": 1, "上左": 2, "上右": 3, "x": 4 },
    morphTargetInfluences: [1.4, -0.2, 0.8, 0.9, Number.NaN] };
  clampMorphs(mesh);
  assert.deepEqual(mesh.morphTargetInfluences, [1, 0, 0.8, 0.9, 0]);
  clampMorphs({});
});

test("only the teeth may go below 0, down to −1", () => {
  const mesh = { morphTargetDictionary: { "齿下": 0, "齿上": 1, "あ": 2 }, morphTargetInfluences: [-0.32, -1.5, -0.2] };
  clampMorphs(mesh);
  assert.deepEqual(mesh.morphTargetInfluences, [-0.32, -1, 0]);
});

// Review on #263: with both eyes over budget, one pass per eye left them
// uneven (笑い ⅓, ウィンク ½, ウィンク右 ⅔: the left eye summed 0.83).
test("both eyes over budget are scaled together and both close exactly once", () => {
  const mesh = face({ "笑い": 1, "ウィンク": 1, "ウィンク右": 1 });
  capEyeClosure(mesh);
  assert.ok(Math.abs(eyeSum(mesh, "left") - 1) < 1e-12);
  assert.ok(Math.abs(eyeSum(mesh, "right") - 1) < 1e-12);
  assert.ok(Math.abs(weight(mesh, "笑い") - 0.5) < 1e-12);
});
