// Run with: node --test tests/renderer/*.test.mjs
// Idle arm drift (#193): slow, small arm, elbow and wrist motion while idle and
// asleep, eased in and out with the idle state and settling exactly to rest.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARM_CHANNELS, ARM_DRIFT_KEY, IDLE_MOTION, IdleMotion, armDriftAngles, bindArmDriftSetting,
} from "../../renderer/idle-motion.js";

const DEG = Math.PI / 180;
const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Little"];
const { armDrift } = IDLE_MOTION;

/** Step the motion through a state for some seconds; returns every pose. */
function play(motion, state, seconds, fps = 60) {
  const poses = [];
  for (let i = 1; i <= Math.round(seconds * fps); i += 1) poses.push(motion.update(1 / fps, state, i / fps));
  return poses;
}

/** Largest absolute value of a channel over some poses. */
const peak = (poses, key) => Math.max(...poses.map((pose) => Math.abs(pose[key])));

function checkbox(checked) {
  const listeners = [];
  return {
    checked,
    addEventListener: (type, fn) => { if (type === "change") listeners.push(fn); },
    set(value) { this.checked = value; for (const fn of listeners) fn(); },
  };
}
function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), map };
}

test("arm channels are named by screen side for the upper arm, elbow, forearm, wrist and fingers", () => {
  assert.deepEqual([...ARM_CHANNELS].sort(), [
    "armOutLeft", "armOutRight", "armSwayLeft", "armSwayRight",
    "curlIndexLeft", "curlIndexRight", "curlLittleLeft", "curlLittleRight",
    "curlMiddleLeft", "curlMiddleRight", "curlRingLeft", "curlRingRight",
    "curlThumbLeft", "curlThumbRight", "elbowLeft", "elbowRight",
    "forearmLeft", "forearmRight", "spreadLeft", "spreadRight", "wristLeft", "wristRight",
  ]);
});

test("no drift amount means every arm angle is exactly zero", () => {
  for (const clock of [0, 3.7, 125]) {
    const angles = armDriftAngles(clock, 0);
    for (const key of ARM_CHANNELS) assert.equal(angles[key], 0, `${key} at ${clock}s`);
  }
});

test("full drift stays within a few degrees, one-sided where clipping is a risk", () => {
  for (let clock = 0; clock < 600; clock += 0.25) {
    const a = armDriftAngles(clock, 1);
    for (const side of ["Left", "Right"]) {
      assert.ok(Math.abs(a[`armSway${side}`]) <= armDrift.sway + 1e-9, `sway ${clock}`);
      // Out only (never toward the torso) and bend only (never past straight).
      // Out further than in, so the hands only brush toward the thighs.
      assert.ok(a[`armOut${side}`] >= -armDrift.in - 1e-9 && a[`armOut${side}`] <= armDrift.out + 1e-9, `out ${clock}`);
      assert.ok(a[`elbow${side}`] >= 0 && a[`elbow${side}`] <= armDrift.elbow + 1e-9, `elbow ${clock}`);
      assert.ok(Math.abs(a[`wrist${side}`]) <= armDrift.wrist + 1e-9, `wrist ${clock}`);
      assert.ok(Math.abs(a[`forearm${side}`]) <= armDrift.forearm + 1e-9, `forearm ${clock}`);
      for (const finger of FINGERS) {
        assert.ok(Math.abs(a[`curl${finger}${side}`]) <= armDrift.curl + 1e-9, `curl ${finger} ${clock}`);
      }
      assert.ok(Math.abs(a[`spread${side}`]) <= armDrift.spread + 1e-9, `spread ${clock}`);
    }
  }
  assert.ok(armDrift.in > 0 && armDrift.in < armDrift.out, "the arms sway in a little, less than out");
  for (const key of ["sway", "out", "in", "elbow", "wrist", "forearm", "curl", "spread"]) {
    assert.ok(armDrift[key] > 0 && armDrift[key] <= 5 * DEG, `${key} is a few degrees`);
  }
});

test("the two sides are phase-offset, never mirrored or identical", () => {
  let same = 0;
  let mirrored = 0;
  let samples = 0;
  for (let clock = 0; clock < 120; clock += 0.5) {
    const a = armDriftAngles(clock, 1);
    for (const part of ["armSway", "armOut", "elbow", "wrist", "forearm", "curlMiddle", "spread"]) {
      samples += 1;
      if (Math.abs(a[`${part}Left`] - a[`${part}Right`]) < 0.05 * DEG) same += 1;
      if (Math.abs(a[`${part}Left`] + a[`${part}Right`]) < 0.05 * DEG) mirrored += 1;
    }
  }
  assert.ok(same / samples < 0.1, `identical ${same}/${samples}`);
  assert.ok(mirrored / samples < 0.1, `mirrored ${mirrored}/${samples}`);
});

test("the drift is slow: tens of seconds per swing and tiny per-frame steps", () => {
  let crossings = 0;
  let previous = armDriftAngles(0, 1);
  for (let frame = 1; frame <= 120 * 60; frame += 1) {
    const a = armDriftAngles(frame / 60, 1);
    for (const key of ARM_CHANNELS) {
      assert.ok(Math.abs(a[key] - previous[key]) < 0.02 * DEG, `${key} step at frame ${frame}`);
    }
    if (Math.sign(a.armSwayLeft) !== Math.sign(previous.armSwayLeft)) crossings += 1;
    previous = a;
  }
  // A 10 s or longer swing crosses zero at most about twice per 10 s.
  assert.ok(crossings <= 24, `armSwayLeft crossed zero ${crossings} times in 2 min`);
  assert.ok(crossings >= 2, "it still moves");
});

test("the wrist follows the elbow a moment later, like a relaxed hand trailing the arm", () => {
  const lag = armDrift.wristLag;
  assert.ok(lag >= 0.5 && lag <= 2, "a lag of about a second");
  for (let clock = lag; clock < 120; clock += 0.37) {
    const now = armDriftAngles(clock, 1);
    const before = armDriftAngles(clock - lag, 1);
    for (const side of ["Left", "Right"]) {
      // The elbow only bends one way (0..size); the wrist swings both ways around rest.
      const elbow = (2 * before[`elbow${side}`]) / armDrift.elbow - 1;
      assert.ok(Math.abs(now[`wrist${side}`] / armDrift.wrist - elbow) < 1e-9, `${side} wrist at ${clock}`);
    }
  }
});

test("the forearm roll and finger curl move on their own, not with the elbow", () => {
  let forearmMoves = 0;
  let curlMoves = 0;
  for (let clock = 0; clock < 120; clock += 0.5) {
    const a = armDriftAngles(clock, 1);
    const b = armDriftAngles(clock + 0.5, 1);
    if (Math.sign(b.forearmLeft - a.forearmLeft) !== Math.sign(b.elbowLeft - a.elbowLeft)) forearmMoves += 1;
    if (Math.sign(b.curlMiddleLeft - a.curlMiddleLeft) !== Math.sign(b.elbowLeft - a.elbowLeft)) curlMoves += 1;
  }
  assert.ok(forearmMoves > 40 && curlMoves > 40, `independent ${forearmMoves}, ${curlMoves} of 240`);
});

test("the arms sway inward as well as out", () => {
  let inward = 0;
  let outward = 0;
  for (let clock = 0; clock < 600; clock += 1) {
    const a = armDriftAngles(clock, 1);
    for (const side of ["Left", "Right"]) {
      if (a[`armOut${side}`] < -0.5 * armDrift.in) inward += 1;
      if (a[`armOut${side}`] > 0.5 * armDrift.out) outward += 1;
    }
  }
  assert.ok(inward > 50 && outward > 50, `inward ${inward}, outward ${outward} of 1200`);
});

test("the finger curl ripples from the index finger to the little finger", () => {
  const lag = armDrift.rippleLag;
  assert.ok(lag > 0 && lag <= 0.6, "a short ripple");
  const order = ["Index", "Middle", "Ring", "Little"];
  for (let clock = 2; clock < 90; clock += 0.73) {
    for (const side of ["Left", "Right"]) {
      const now = armDriftAngles(clock, 1);
      for (const [step, finger] of order.entries()) {
        const lead = armDriftAngles(clock - step * lag, 1);
        assert.ok(Math.abs(now[`curl${finger}${side}`] - lead[`curlIndex${side}`]) < 1e-12, `${finger} ${side} at ${clock}`);
      }
      // The thumb curls on the index finger's timing.
      assert.equal(now[`curlThumb${side}`], now[`curlIndex${side}`]);
    }
  }
});

test("the fingers spread and close on their own slow waves", () => {
  let changes = 0;
  let previous = armDriftAngles(0, 1).spreadLeft;
  for (let clock = 1; clock < 120; clock += 1) {
    const spread = armDriftAngles(clock, 1).spreadLeft;
    if (Math.sign(spread) !== Math.sign(previous)) changes += 1;
    previous = spread;
  }
  assert.ok(changes >= 4 && changes <= 30, `spread changed sides ${changes} times in 2 min`);
});

test("the drift does not repeat on a short loop", () => {
  // Two incommensurate waves per channel: no lag up to two minutes brings it back.
  const at = (clock) => armDriftAngles(clock, 1);
  for (let lag = 5; lag <= 120; lag += 0.5) {
    let diff = 0;
    for (let clock = 0; clock < 30; clock += 1) {
      const a = at(clock);
      const b = at(clock + lag);
      diff = Math.max(diff, ...ARM_CHANNELS.map((key) => Math.abs(a[key] - b[key])));
    }
    assert.ok(diff > 0.1 * DEG, `the pose repeats after ${lag} s`);
  }
});

test("arms drift while idle, easing in rather than jumping", () => {
  const motion = new IdleMotion({ random: () => 0.99 });
  const poses = play(motion, "idle", 20);
  assert.ok(poses[0].armDrift > 0 && poses[0].armDrift < 0.05, "starts near zero");
  assert.ok(poses.at(-1).armDrift > 0.99, "fully in after 20 s");
  for (const key of ARM_CHANNELS) assert.ok(peak(poses.slice(-600), key) > 0, `${key} moves`);
  assert.ok(peak(poses, "armSwayLeft") <= armDrift.sway + 1e-9);
});

test("arms drift while asleep, smaller than while idle", () => {
  const motion = new IdleMotion({ random: () => 0.99 });
  const poses = play(motion, "sleepy", 30);
  assert.ok(Math.abs(poses.at(-1).armDrift - armDrift.sleepy) < 0.01);
  for (const key of ["armSwayLeft", "elbowRight"]) {
    assert.ok(peak(poses.slice(-600), key) > 0, `${key} moves asleep`);
  }
  assert.ok(peak(poses, "elbowLeft") <= armDrift.sleepy * armDrift.elbow + 1e-6);
});

test("going active settles every arm angle exactly to rest", () => {
  const motion = new IdleMotion({ random: () => 0.99 });
  play(motion, "idle", 15);
  const back = play(motion, "active", 8);
  const last = back.at(-1);
  assert.equal(last.armDrift, 0);
  for (const key of ARM_CHANNELS) assert.equal(last[key], 0, key);
  // It eases out: no frame jumps.
  for (let i = 1; i < back.length; i += 1) {
    assert.ok(Math.abs(back[i].armSwayLeft - back[i - 1].armSwayLeft) < 0.05 * DEG);
  }
});

test("many idle and active cycles leave no leftover drift", () => {
  const motion = new IdleMotion({ random: () => 0.99 });
  for (let cycle = 0; cycle < 20; cycle += 1) {
    play(motion, "idle", 3 + (cycle % 4));
    play(motion, cycle % 2 ? "active" : "sleepy", 2);
  }
  const last = play(motion, "active", 8).at(-1);
  for (const key of [...ARM_CHANNELS, "armDrift"]) assert.equal(last[key], 0, key);
});

test("arm drift can be switched off and eases out to exact rest", () => {
  const motion = new IdleMotion({ random: () => 0.99 });
  assert.equal(motion.armDriftEnabled, true, "on by default");
  play(motion, "idle", 15);
  motion.setArmDrift(false);
  const last = play(motion, "idle", 8).at(-1);
  for (const key of [...ARM_CHANNELS, "armDrift"]) assert.equal(last[key], 0, key);
  motion.setArmDrift(true);
  assert.ok(play(motion, "idle", 10).at(-1).armDrift > 0.9);
});

test("idle actions and button plays leave the arm drift running", () => {
  const motion = new IdleMotion({ random: () => 0.1 });
  play(motion, "idle", 15);
  motion.play("shrug-both");
  const poses = play(motion, "idle", 2);
  assert.ok(poses.every((pose) => pose.armDrift > 0.9));
});

test("the arm drift tick is on by default and its choice is saved", () => {
  const local = storage();
  const motion = new IdleMotion();
  const box = checkbox(false);
  bindArmDriftSetting(motion, box, { local });
  assert.equal(box.checked, true);
  assert.equal(motion.armDriftEnabled, true);
  box.set(false);
  assert.equal(motion.armDriftEnabled, false);
  assert.equal(local.map.get(ARM_DRIFT_KEY), "0");

  const next = new IdleMotion();
  const again = checkbox(true);
  bindArmDriftSetting(next, again, { local });
  assert.equal(again.checked, false);
  assert.equal(next.armDriftEnabled, false);
});

test("blocked storage keeps the arm drift on for the session", () => {
  const motion = new IdleMotion();
  const box = checkbox(true);
  const local = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  bindArmDriftSetting(motion, box, { local });
  assert.equal(motion.armDriftEnabled, true);
  box.set(false);
  assert.equal(motion.armDriftEnabled, false);
});
