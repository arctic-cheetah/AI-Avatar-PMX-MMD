// Run with: node --test tests/renderer/facial-layers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { EYE_CLOSURE, composeBlink, eyeClosure } from "../../renderer/facial-layers.js";

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
