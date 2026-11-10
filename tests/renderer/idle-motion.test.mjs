// Run with: node --test tests/renderer/*.test.mjs
// Idle motions for #71: glance, head tilt, sigh and the stretch before sleepy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IDLE_MOTION, IdleMotion, bump } from "../../renderer/idle-motion.js";
import { IDLE_TIMING } from "../../renderer/idle-behaviour.js";

const DEG = Math.PI / 180;
const ANGLES = ["tilt", "chest", "shoulders", "back", "headPitch"];

/** Random numbers from a fixed list, repeating the last one. */
const scripted = (...values) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

/** Small deterministic generator for long runs. */
function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Step the motion through a state for some seconds; returns every pose. */
function play(motion, state, seconds, { fps = 60, from = 0 } = {}) {
  const poses = [];
  const frames = Math.round(seconds * fps);
  for (let i = 1; i <= frames; i += 1) poses.push(motion.update(1 / fps, state, from + i / fps));
  return poses;
}

const isRest = (pose) => pose.glance === null && ANGLES.every((k) => Math.abs(pose[k]) < 1e-9);

test("bump eases in, holds and eases out within its duration", () => {
  assert.equal(bump(0, 2, 0.5), 0);
  assert.equal(bump(1, 2, 0.5), 1);
  assert.equal(bump(2, 2, 0.5), 0);
  assert.equal(bump(-1, 2, 0.5), 0);
  assert.equal(bump(3, 2, 0.5), 0);
  assert.ok(bump(0.25, 2, 0.5) > 0 && bump(0.25, 2, 0.5) < 1);
  assert.ok(Math.abs(bump(0.5, 0.6, 0.5) - bump(0.1, 0.6, 0.5)) < 1e-12, "short bumps stay symmetric");
});

test("no motion while active, sleepy or waking", () => {
  for (const state of ["active", "sleepy", "waking"]) {
    const motion = new IdleMotion({ random: seeded() });
    for (const pose of play(motion, state, 60, { fps: 10 })) assert.ok(isRest(pose), state);
  }
});

test("the first idle motion waits for the gap", () => {
  const motion = new IdleMotion({ random: scripted(0) });
  const before = play(motion, "idle", IDLE_MOTION.gap[0] - 0.1);
  assert.ok(before.every(isRest));
  play(motion, "idle", 0.2);
  assert.equal(motion.current?.kind, "glance");
});

test("a glance looks to one side, then lets go of the gaze", () => {
  // gap 8 s, glance, left, shortest duration, smallest sideways, lowest pitch.
  const motion = new IdleMotion({ random: scripted(0) });
  play(motion, "idle", IDLE_MOTION.gap[0] + 0.05);
  const pose = motion.update(1 / 60, "idle", 9);
  assert.ok(pose.glance, "glance target set");
  assert.ok(Math.abs(pose.glance.x) >= IDLE_MOTION.glance.x[0] - 1e-9);
  assert.ok(Math.abs(pose.glance.y) <= Math.max(...IDLE_MOTION.glance.y.map(Math.abs)) + 1e-9);
  const after = play(motion, "idle", IDLE_MOTION.glance.duration[0] + 0.1);
  assert.equal(after.at(-1).glance, null);
});

test("glances go both ways", () => {
  const left = new IdleMotion({ random: scripted(0, 0, 0.1) });
  const right = new IdleMotion({ random: scripted(0, 0, 0.9) });
  play(left, "idle", IDLE_MOTION.gap[0] + 0.1);
  play(right, "idle", IDLE_MOTION.gap[0] + 0.1);
  assert.ok(left.update(0, "idle", 9).glance.x < 0);
  assert.ok(right.update(0, "idle", 9).glance.x > 0);
});

test("a head tilt leans to one side within its angle and comes back", () => {
  // gap, then kind 0.5 = tilt.
  const motion = new IdleMotion({ random: scripted(0, 0.5, 0.9, 0) });
  play(motion, "idle", IDLE_MOTION.gap[0] + 0.05);
  assert.equal(motion.current?.kind, "tilt");
  const poses = play(motion, "idle", IDLE_MOTION.tilt.duration[0] + 1.5);
  const peak = Math.max(...poses.map((p) => Math.abs(p.tilt)));
  assert.ok(peak > IDLE_MOTION.tilt.angle * 0.8, `peak ${peak / DEG}°`);
  assert.ok(peak <= IDLE_MOTION.tilt.angle + 1e-9);
  assert.ok(Math.abs(poses.at(-1).tilt) < 0.05 * DEG, "back upright");
});

test("a sigh lifts the chest and shoulders, then lets them fall", () => {
  // gap, then kind 0.9 = sigh.
  const motion = new IdleMotion({ random: scripted(0, 0.9) });
  play(motion, "idle", IDLE_MOTION.gap[0] + 0.05);
  assert.equal(motion.current?.kind, "sigh");
  const { inhale, exhale } = IDLE_MOTION.sigh;
  const poses = play(motion, "idle", inhale + exhale + 1);
  const peakAt = poses.reduce((best, p, i) => (p.chest > poses[best].chest ? i : best), 0);
  assert.ok(poses[peakAt].chest > IDLE_MOTION.sigh.chest * 0.8);
  assert.ok(poses[peakAt].shoulders > 0);
  assert.ok(peakAt / 60 > inhale * 0.7 && peakAt / 60 < inhale + 0.5, "peaks at the end of the breath in");
  assert.ok(Math.abs(poses.at(-1).chest) < 0.05 * DEG, "breathes out fully");
});

test("one motion at a time, and every angle stays within its limit", () => {
  const motion = new IdleMotion({ random: seeded(11) });
  const kinds = new Set();
  for (let i = 1; i <= 600 * 30; i += 1) {
    const pose = motion.update(1 / 30, "idle", i / 30);
    if (motion.current) kinds.add(motion.current.kind);
    assert.ok(Math.abs(pose.tilt) <= IDLE_MOTION.tilt.angle + 1e-9);
    assert.ok(pose.chest >= -1e-9 && pose.chest <= IDLE_MOTION.sigh.chest + 1e-9);
    if (pose.glance) assert.ok(Math.abs(pose.tilt) < 1e-3, "no tilt during a glance");
  }
  assert.deepEqual([...kinds].sort(), ["glance", "sigh", "tilt"]);
});

test("motions are smooth from frame to frame", () => {
  const motion = new IdleMotion({ random: seeded(3) });
  let previous = motion.update(0, "idle", 0);
  for (let i = 1; i < 120 * 60; i += 1) {
    const state = i < 100 * 60 ? "idle" : "stretching";
    const pose = motion.update(1 / 60, state, state === "idle" ? i / 60 : (i - 6000) / 60);
    for (const key of ANGLES) {
      assert.ok(Math.abs(pose[key] - previous[key]) < 0.25 * DEG, `${key} jumped at frame ${i}`);
    }
    previous = { ...pose };
  }
});

test("the stretch arches back, lifts the head and shoulders, then settles", () => {
  const motion = new IdleMotion({ random: seeded() });
  const poses = play(motion, "stretching", IDLE_TIMING.stretch);
  const mid = poses[Math.round(poses.length / 2)];
  assert.ok(mid.back > IDLE_MOTION.stretch.back * 0.7);
  assert.ok(mid.headPitch > IDLE_MOTION.stretch.headPitch * 0.7);
  assert.ok(mid.shoulders > IDLE_MOTION.stretch.shoulders * 0.7);
  assert.equal(motion.current, null, "no glance or tilt during the stretch");
  const settled = play(motion, "sleepy", 1.5);
  assert.ok(ANGLES.every((k) => Math.abs(settled.at(-1)[k]) < 0.05 * DEG));
});

test("leaving idle mid-motion drops the glance at once and eases the rest back", () => {
  const motion = new IdleMotion({ random: scripted(0, 0.5, 0.9, 0) });
  play(motion, "idle", IDLE_MOTION.gap[0] + 1);
  assert.ok(Math.abs(motion.update(0, "idle", 9).tilt) > 0);
  const back = play(motion, "active", 1);
  assert.equal(motion.current, null);
  assert.ok(Math.abs(back[0].tilt) > 0, "eases, not snaps");
  assert.ok(Math.abs(back.at(-1).tilt) < 0.05 * DEG);

  const glancing = new IdleMotion({ random: scripted(0) });
  play(glancing, "idle", IDLE_MOTION.gap[0] + 0.1);
  assert.equal(glancing.update(1 / 60, "active", 0).glance, null);
});

test("a new idle period waits for a fresh gap", () => {
  const motion = new IdleMotion({ random: scripted(0) });
  play(motion, "idle", IDLE_MOTION.gap[0] - 1);
  play(motion, "active", 1);
  const again = play(motion, "idle", IDLE_MOTION.gap[0] - 0.1);
  assert.ok(again.every(isRest), "the gap restarts after activity");
});

test("invalid deltas hold the pose", () => {
  const motion = new IdleMotion({ random: scripted(0) });
  for (const delta of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.ok(isRest(motion.update(delta, "idle", 0)));
  }
  assert.equal(motion.current, null);
});
