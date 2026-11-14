// Run with: node --test tests/renderer/facial-layers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EYE_CLOSURE, EYE_CLOSURE_BY_SIDE, composeBlink, composeWink, eyeClosure, eyeClosures, splitBlink,
} from "../../renderer/facial-layers.js";

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

// #99: playful holds a wink as a mood, so winks and blinks must respect it.
test("the wink channel combines with a mood's own wink instead of wiping it", () => {
  close(composeWink(1, 0), 1);
  close(composeWink(0, 0.5), 0.5);
  close(composeWink(0.6, 0.5), 0.8);
});

test("closure is read per eye: a wink closes one side, the smile both", () => {
  const face = {
    morphTargetDictionary: { "笑い": 0, "ウィンク": 1, "ウィンク右": 2 },
    morphTargetInfluences: [0, 1, 0],
  };
  assert.deepEqual(eyeClosures(face), { left: 1, right: 0 });
  face.morphTargetInfluences = [0.6, 0, 0];
  assert.deepEqual(eyeClosures(face), { left: 0.6, right: 0.6 });
  assert.deepEqual(eyeClosures(null), { left: 0, right: 0 });
  assert.equal(EYE_CLOSURE_BY_SIDE.left["ウィンク右"], undefined);
  assert.equal(EYE_CLOSURE_BY_SIDE.right["ウィンク"], undefined);
});

test("with both eyes open or equally closed, the blink stays on まばたき as before", () => {
  const open = splitBlink(1, 0, 0);
  close(open.both, 1); close(open.left, 0); close(open.right, 0);
  const smiling = splitBlink(0.5, 0.6, 0.6);
  close(smiling.both, composeBlink(0, 0.5, 0.6));
  close(smiling.left, 0); close(smiling.right, 0);
  const shut = splitBlink(1, 1, 1);
  close(shut.both, 0); close(shut.left, 0); close(shut.right, 0);
});

test("while one eye winks, the open eye still blinks through its own wink morph", () => {
  const winkingLeft = splitBlink(1, 1, 0);
  close(winkingLeft.both, 0); close(winkingLeft.left, 0); close(winkingLeft.right, 1);
  const half = splitBlink(0.5, 0, 1);
  close(half.both, 0); close(half.left, 0.5); close(half.right, 0);
  const smileAndWink = splitBlink(1, 1, 0.7);
  close(smileAndWink.both, 0); close(smileAndWink.right, 0.3);
});
