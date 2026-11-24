// Run with: node --test tests/renderer/smoothing.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_FRAME_DELTA, PoseEase, Spring, TIMING, exponentialBlend, frameDelta, springStep } from "../../renderer/smoothing.js";

test("frame delta is in seconds, never negative, and capped", () => {
  assert.equal(frameDelta(1016, 1000), 0.016);
  assert.equal(frameDelta(1000, 1016), 0);
  assert.equal(frameDelta(Number.NaN, 0), 0);
  assert.equal(frameDelta(60_000, 0), MAX_FRAME_DELTA);
  assert.ok(MAX_FRAME_DELTA >= 0.2, "reduced frame rates down to 5 fps keep real-time easing");
});

test("exponential blend is 1 - exp(-dt / tau) with tau = 1 / rate", () => {
  assert.equal(exponentialBlend(0.05, 20), 1 - Math.exp(-0.05 * 20));
  assert.equal(exponentialBlend(-1, 20), 0);
  // Two half frames equal one whole frame: frame-rate independent.
  const half = exponentialBlend(0.01, 35);
  assert.ok(Math.abs((1 - (1 - half) ** 2) - exponentialBlend(0.02, 35)) < 1e-12);
});

test("every channel has a positive rate, and speech stays fastest", () => {
  for (const [name, rate] of Object.entries(TIMING)) assert.ok(rate > 0, name);
  for (const name of ["expression", "thinkingPose", "gaze", "wink", "swayFade"]) {
    assert.ok(TIMING.speechShape > TIMING[name], `${name} is slower than lip-sync`);
  }
});

test("spring eases in from rest without overshoot and settles", () => {
  const spring = new Spring(0);
  let previous = 0;
  const first = spring.step(1, 1 / 60, 14);
  assert.ok(first < 0.05, "starts gently instead of at full speed");
  for (let i = 0; i < 120; i += 1) {
    const value = spring.step(1, 1 / 60, 14);
    assert.ok(value >= previous && value <= 1, "monotonic, no overshoot");
    previous = value;
  }
  assert.ok(previous > 0.999);
});

test("spring follows wall time exactly at any frame rate", () => {
  const fast = new Spring(0);
  const slow = new Spring(0);
  for (let i = 0; i < 24; i += 1) fast.step(1, 1 / 60, 14);
  for (let i = 0; i < 6; i += 1) slow.step(1, 1 / 15, 14);
  assert.ok(Math.abs(fast.value - slow.value) < 1e-9);
  assert.ok(Math.abs(fast.velocity - slow.velocity) < 1e-9);
});

test("an interrupted spring keeps its momentum instead of reversing instantly", () => {
  const spring = new Spring(0);
  for (let i = 0; i < 6; i += 1) spring.step(1, 1 / 60, 14);
  const before = spring.velocity;
  assert.ok(before > 0);
  spring.step(0, 1 / 60, 14);
  assert.ok(spring.velocity > 0 && spring.velocity < before, "decelerates first");
});

test("springStep works on a plain state and ignores negative time", () => {
  const state = { value: 0.5, velocity: 0 };
  assert.equal(springStep(state, 1, -1, 14), 0.5);
  assert.equal(state.velocity, 0);
  assert.equal(springStep(state, 1, 10, 14), 1);
});

// Pose ease (#49): the transition the user asked for on the Blender poses and
// the thinking pose. From rest it is a smootherstep over its duration; turned
// back midway it keeps its speed and curves round instead of snapping.
const smootherstep = (p) => p * p * p * (p * (6 * p - 15) + 10);

test("from rest a pose ease is a smootherstep over its seconds", () => {
  const ease = new PoseEase(1.5);
  ease.setTarget(1);
  for (const t of [0.15, 0.5, 0.75, 1.2]) {
    const fresh = new PoseEase(1.5);
    fresh.setTarget(1);
    fresh.update(t);
    assert.ok(Math.abs(fresh.value - smootherstep(t / 1.5)) < 1e-12, `t=${t}`);
  }
  ease.update(1.5);
  assert.equal(ease.value, 1);
  assert.equal(ease.velocity, 0);
});

test("a pose ease is the same at any frame rate", () => {
  const coarse = new PoseEase(1);
  const fine = new PoseEase(1);
  coarse.setTarget(1);
  fine.setTarget(1);
  coarse.update(0.3);
  for (let i = 0; i < 30; i += 1) fine.update(0.01);
  assert.ok(Math.abs(coarse.value - fine.value) < 1e-12);
});

test("turned back midway it keeps moving a moment, then returns without a jump", () => {
  const ease = new PoseEase(1);
  ease.setTarget(1);
  ease.update(0.3);
  const rising = ease.value;
  ease.setTarget(0);
  ease.update(1 / 60);
  assert.ok(ease.value > rising, "decelerates before it turns back");
  assert.ok(ease.value - rising < 0.02, "no jump");
  let lowest = 1;
  for (let i = 0; i < 120; i += 1) {
    ease.update(1 / 60);
    lowest = Math.min(lowest, ease.value);
  }
  assert.equal(ease.value, 0);
  assert.ok(lowest >= 0, "never below 0");
});

test("a new duration applies from the next change", () => {
  const ease = new PoseEase(1);
  ease.duration = 2;
  ease.setTarget(1);
  ease.update(1);
  assert.ok(Math.abs(ease.value - 0.5) < 1e-12);
});

test("negative or broken deltas do not move a pose ease", () => {
  const ease = new PoseEase(1);
  ease.setTarget(1);
  ease.update(-1);
  ease.update(Number.NaN);
  assert.equal(ease.value, 0);
});
