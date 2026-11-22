// Per-frame Goo shader inputs (#252): the face shadow and light terms that the
// Blender `faceLogic` and `[Light Facing Forward]` nodes compute, done once per
// frame on the CPU in Blender's world space (Z up, the face looks along −Y).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  blenderToThree, faceTerms, headVectors, lightDirection, sampleRamp, threeToBlender,
} from "../../renderer/goo-frame.js";

const close = (actual, expected, eps = 1e-6) => {
  if (Array.isArray(expected)) expected.forEach((e, i) => close(actual[i], e, eps));
  else assert.ok(Math.abs(actual - expected) <= eps, `${actual} ≈ ${expected}`);
};

// V1.3 rest values: the Main Light is rotated 90° about X, so it shines from the front.
const LIGHT_EULER = [Math.PI / 2, 0, 0];
const FORWARD = [0, -0.5, 0];
const UP = [0, 0, 0.5];
const FROM_FRONT = { cameraForward: [0, 1, 0], cameraBack: [0, -1, 0] };

test("Blender and three.js axes convert both ways", () => {
  close(blenderToThree([1, 2, 3]), [1, 3, -2]);
  close(threeToBlender(blenderToThree([1, 2, 3])), [1, 2, 3]);
  // The face looks along Blender −Y, which is three.js +Z (towards the default camera).
  close(blenderToThree(FORWARD), [0, 0, 0.5]);
});

test("the light direction is +Z rotated by the Main Light's XYZ Euler", () => {
  close(lightDirection(LIGHT_EULER), [0, -1, 0]);
  close(lightDirection([0, 0, 0]), [0, 0, 1]);
  // Blender XYZ Euler applies X, then Y, then Z.
  close(lightDirection([Math.PI / 2, 0, Math.PI / 2]), [1, 0, 0]);
});

test("light straight at the face: almost no face shadow, lightmap not mirrored", () => {
  const t = faceTerms({ light: [0, -1, 0], lightEuler: LIGHT_EULER, headForward: FORWARD, headUp: UP, ...FROM_FRONT });
  close(t.shadowRange, 0.999 ** 0.421875);
  assert.equal(t.mirrorU, false);
});

test("side light: half range, and the lightmap mirrors for the other side", () => {
  const right = faceTerms({ light: [1, 0, 0], lightEuler: LIGHT_EULER, headForward: FORWARD, headUp: UP, ...FROM_FRONT });
  const left = faceTerms({ light: [-1, 0, 0], lightEuler: LIGHT_EULER, headForward: FORWARD, headUp: UP, ...FROM_FRONT });
  close(right.shadowRange, 0.5 ** 0.421875);
  close(left.shadowRange, 0.5 ** 0.421875);
  assert.equal(right.mirrorU, false);
  assert.equal(left.mirrorU, true);
});

test("light from behind the head gives a zero range (fully shadowed face)", () => {
  const t = faceTerms({ light: [0, 1, 0], lightEuler: LIGHT_EULER, headForward: FORWARD, headUp: UP, ...FROM_FRONT });
  close(t.shadowRange, 0);
});

test("only the horizontal part of the light and head matter for the face", () => {
  const tilted = faceTerms({ light: [0, -1, 5], lightEuler: LIGHT_EULER, headForward: FORWARD, headUp: UP, ...FROM_FRONT });
  close(tilted.shadowRange, 0.999 ** 0.421875);
});

test("facing terms follow the camera like the Blender nodes", () => {
  const t = faceTerms({ light: [0, -1, 0], lightEuler: LIGHT_EULER, headForward: FORWARD, headUp: UP, ...FROM_FRONT });
  // headForward is not normalised in Blender: 0.5 long, opposite the camera's view.
  close(t.facingDot, -0.5);
  close(t.facingForward, 0);
  // Camera back (0,−1,0) rotated 90° about X is (0,0,−1): z = −1.
  close(t.lightFacingPow, 1);
  close(t.edgeLight, 0);
});

test("head vectors turn with the head bone", () => {
  const bind = new THREE.Quaternion();
  const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const rest = headVectors({ bindQuaternion: bind, currentQuaternion: bind, restForward: FORWARD, restUp: UP });
  close(rest.forward, FORWARD);
  close(rest.up, UP);
  const moved = headVectors({ bindQuaternion: bind, currentQuaternion: turned, restForward: FORWARD, restUp: UP });
  // three.js +Z turned 90° about +Y is +X; Blender +X too.
  close(moved.forward, [0.5, 0, 0]);
  close(moved.up, UP);
});

test("head vectors use the change from the bind pose, not the bind pose itself", () => {
  const bind = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3);
  const t = headVectors({ bindQuaternion: bind, currentQuaternion: bind.clone(), restForward: FORWARD, restUp: UP });
  close(t.forward, FORWARD);
});

test("sampleRamp reads a baked LUT with linear steps between samples", () => {
  const lut = [1, 0, 1];
  close(sampleRamp(lut, 0), 1);
  close(sampleRamp(lut, 0.25), 0.5);
  close(sampleRamp(lut, 0.5), 0);
  close(sampleRamp(lut, 2), 1);
  close(sampleRamp(lut, -1), 1);
});
