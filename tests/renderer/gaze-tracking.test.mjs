// Run with: node --test tests/renderer/gaze-tracking.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { THINKING_POSE } from "../../renderer/thinking-pose.js";
import {
  GazeController,
  clampTarget,
  clampEyePitch,
  normalisePointer,
  targetToAngles,
  LIMITS,
} from "../../renderer/gaze-tracking.js";

test("centre pointer is a neutral gaze target", () => {
  assert.deepEqual(normalisePointer(500, 400, 1000, 800), { x: 0, y: 0 });
  assert.deepEqual(targetToAngles({ x: 0, y: 0 }), {
    eyeYaw: 0, eyePitch: 0, headYaw: 0, headPitch: 0,
  });
});

test("pointer normalisation maps edges to +/-1 and clamps outside", () => {
  assert.deepEqual(normalisePointer(0, 0, 1000, 800), { x: -1, y: -1 });
  assert.deepEqual(normalisePointer(1000, 800, 1000, 800), { x: 1, y: 1 });
  assert.deepEqual(normalisePointer(5000, -50, 1000, 800), { x: 1, y: -1 });
  assert.deepEqual(normalisePointer(10, 10, 0, 0), { x: 0, y: 0 });
});

test("targets clamp to the normalised square", () => {
  assert.deepEqual(clampTarget({ x: 2, y: -3 }), { x: 1, y: -1 });
  assert.deepEqual(clampTarget({ x: 0.25, y: -0.5 }), { x: 0.25, y: -0.5 });
  assert.deepEqual(clampTarget(null), { x: 0, y: 0 });
});

test("angles clamp at the eye/head limits and head follows at a fraction", () => {
  const angles = targetToAngles({ x: 1, y: 1 });
  assert.equal(angles.eyeYaw, LIMITS.eyeYaw);
  assert.equal(angles.eyePitch, LIMITS.eyePitch);
  assert.ok(Math.abs(angles.headYaw) < Math.abs(angles.eyeYaw));
  assert.ok(Math.abs(angles.headPitch) < Math.abs(angles.eyePitch));
  assert.equal(angles.headYaw, angles.eyeYaw * LIMITS.headScale);
});

test("upward eye travel stops safely without reducing head tracking", () => {
  const angles = targetToAngles(normalisePointer(500, -5000, 1000, 800));
  assert.equal(angles.eyePitch, -LIMITS.eyePitchUp);
  assert.equal(angles.headPitch, -LIMITS.eyePitch * LIMITS.headScale);
  assert.equal(clampEyePitch(0.05), 0.05);
  assert.equal(clampEyePitch(10), LIMITS.eyePitch);
  assert.equal(clampEyePitch(-10), -LIMITS.eyePitchUp);
});

test("the combined thinking offset and gaze cannot exceed the eye pitch limits", () => {
  for (const y of [-1, -0.5, 0, 0.5, 1]) {
    for (const weight of [0, 0.25, 0.5, 1]) {
      const { eyePitch } = targetToAngles({ x: 0, y });
      const pitch = clampEyePitch(eyePitch, THINKING_POSE.eyePitch * weight);
      assert.ok(pitch >= -LIMITS.eyePitchUp && pitch <= LIMITS.eyePitch);
    }
  }
  assert.equal(clampEyePitch(-LIMITS.eyePitchUp, THINKING_POSE.eyePitch), -LIMITS.eyePitchUp);
});

test("cursor and camera sources both obey the upward eye limit", () => {
  for (const source of ["cursor", "camera"]) {
    const gaze = new GazeController({ rate: 1000 });
    if (source === "cursor") gaze.setCursor({ x: 1, y: -1 }, true);
    else gaze.setCamera({ x: 1, y: -1 }, true, 1000);
    const angles = gaze.update(1, 1000);
    assert.equal(angles.eyePitch, -LIMITS.eyePitchUp);
    assert.equal(angles.eyeYaw, LIMITS.eyeYaw);
  }
});

test("controller eases toward the target without overshoot", () => {
  const gaze = new GazeController({ rate: 8 });
  gaze.setCursor({ x: 1, y: 0 }, true);
  let previous = 0;
  for (let i = 0; i < 120; i += 1) {
    const { eyeYaw } = gaze.update(1 / 60);
    assert.ok(eyeYaw >= previous, "monotonic approach");
    assert.ok(eyeYaw <= LIMITS.eyeYaw, "never overshoots");
    previous = eyeYaw;
  }
  assert.ok(previous > LIMITS.eyeYaw * 0.99, "converges");
});

test("camera wins over cursor while a face is present, cursor resumes after", () => {
  const gaze = new GazeController({ rate: 1000 });
  gaze.setCursor({ x: -1, y: 0 }, true);
  gaze.setCamera({ x: 1, y: 0 }, true);
  assert.ok(gaze.update(0.1).eyeYaw > 0, "camera target");
  gaze.setCamera(null, false);
  assert.ok(gaze.update(0.1).eyeYaw < 0, "cursor resumes");
});

test("disabled or stale sources fall back to centre", () => {
  const gaze = new GazeController({ rate: 1000 });
  gaze.setCursor({ x: 1, y: 1 }, true);
  gaze.update(0.1);
  gaze.setCursor({ x: 1, y: 1 }, false);
  assert.deepEqual(gaze.update(0.1), { eyeYaw: 0, eyePitch: 0, headYaw: 0, headPitch: 0 });
});

test("stale camera frames expire instead of freezing the gaze", () => {
  const gaze = new GazeController({ rate: 1000, cameraTimeout: 250 });
  gaze.setCamera({ x: 1, y: 0 }, true, 1000);
  assert.ok(gaze.update(0.01, 1100).eyeYaw > 0);
  gaze.update(0.5, 1600);
  gaze.update(0.5, 2100);
  assert.equal(gaze.update(0.5, 2600).eyeYaw, 0, "expired -> centre (no cursor)");
});
