// Run with: node --test tests/renderer/*.test.mjs
// Thinking fidget (#218): a small, slow idle of her fingers and right fist
// while she holds the thinking pose. It only turns bones below the elbows'
// twist, so the #217 clearance holds: the right fist stays under her chin,
// the forearm bones stay out of the bust and the left hand stays at the
// right elbow.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FIDGET_CHANNELS, THINKING_FIDGET, handAngles, thinkingFidgetAngles } from "../../renderer/thinking-fidget.js";
import { ThinkingPose } from "../../renderer/thinking-pose.js";
import { buildThinkingRig } from "../../renderer/thinking-rig.js";
import { buildHandDriftRig } from "../../renderer/hand-drift-rig.js";
import { relaxArms } from "../../renderer/rest-pose.js";
import { ARM_CHANNELS } from "../../renderer/idle-motion.js";
import { DIGITS, bustDepth, fixture } from "./arm-fixture.mjs";

const DEG = Math.PI / 180;
const FRAME = 1 / 60;
const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Little"];
const at = (object) => object.getWorldPosition(new THREE.Vector3());

/** Sample the fidget at full weight every frame for `seconds`. */
function sample(seconds, sizes) {
  const frames = [];
  for (let clock = 0; clock <= seconds; clock += FRAME) frames.push({ clock, angles: thinkingFidgetAngles(clock, 1, sizes) });
  return frames;
}

test("the fidget only uses the forearm twist and finger channels of the hand drift rig", () => {
  assert.ok(FIDGET_CHANNELS.length > 0);
  for (const channel of FIDGET_CHANNELS) {
    assert.ok(ARM_CHANNELS.includes(channel), `${channel} is a hand drift channel`);
    assert.match(channel, /^(?:forearm|curl(?:Thumb|Index|Middle|Ring|Little))(?:Left|Right)$/,
      `${channel} never moves a shoulder, elbow or wrist`);
  }
  // Her right arm is on the left of the screen: the fist rolls, and the left hand's fingers tap.
  assert.ok(FIDGET_CHANNELS.includes("forearmLeft"), "the right fist rolls on its twist bone");
  assert.ok(FIDGET_CHANNELS.some((channel) => /^curl.*Right$/.test(channel)), "the left hand's fingers move");
});

test("no thinking weight means every fidget angle is exactly zero", () => {
  for (const clock of [0, 3.7, 41, 600]) {
    for (const amount of [0, -1, Number.NaN]) {
      const angles = thinkingFidgetAngles(clock, amount);
      assert.deepEqual(Object.keys(angles).sort(), [...FIDGET_CHANNELS].sort());
      for (const [channel, angle] of Object.entries(angles)) assert.equal(angle, 0, `${channel} at ${clock}s, amount ${amount}`);
    }
  }
});

test("the fidget is small and slow: a few degrees, with tiny steps per frame", () => {
  const frames = sample(120);
  for (const channel of FIDGET_CHANNELS) {
    const values = frames.map(({ angles }) => angles[channel]);
    assert.ok(values.every(Number.isFinite), `${channel} stays finite`);
    assert.ok(Math.max(...values.map(Math.abs)) <= 12 * DEG, `${channel} stays within 12°`);
    for (let i = 1; i < values.length; i += 1) {
      assert.ok(Math.abs(values[i] - values[i - 1]) < 1.5 * DEG, `${channel} moves less than 1.5° per frame at ${frames[i].clock}s`);
    }
  }
  const roll = frames.map(({ angles }) => angles.forearmLeft);
  assert.ok(Math.max(...roll.map(Math.abs)) <= THINKING_FIDGET.roll + 1e-12, "the fist roll stays within its size");
  assert.ok(Math.max(...roll.map(Math.abs)) > THINKING_FIDGET.roll / 2, "the fist really rolls");
  for (let i = 1; i < roll.length; i += 1) assert.ok(Math.abs(roll[i] - roll[i - 1]) < 0.05 * DEG, "the roll is slow");
});

test("the left fingers tap in turn, little finger first, with rests between taps", () => {
  const frames = sample(3 * THINKING_FIDGET.tapEvery);
  assert.ok(THINKING_FIDGET.tapEvery >= 3, "taps are occasional, not a constant drum");
  const tapping = ["Index", "Middle", "Ring", "Little"];
  const peaks = Object.fromEntries(tapping.map((finger) => {
    const channel = `curl${finger}Right`;
    // The first tap's strongest frame for this finger.
    let best = frames[0];
    for (const frame of frames) {
      if (frame.clock > THINKING_FIDGET.tapEvery) break;
      if (Math.abs(frame.angles[channel]) > Math.abs(best.angles[channel])) best = frame;
    }
    assert.ok(Math.abs(best.angles[channel]) > THINKING_FIDGET.tap * 0.9, `${finger} reaches its tap`);
    return [finger, best.clock];
  }));
  assert.ok(peaks.Little < peaks.Ring && peaks.Ring < peaks.Middle && peaks.Middle < peaks.Index,
    `fingers tap from little to index: ${JSON.stringify(peaks)}`);
  const resting = frames.filter(({ angles }) => tapping.every((finger) => Math.abs(angles[`curl${finger}Right`]) < 1e-9));
  assert.ok(resting.length > frames.length * 0.5, "the hand rests still for most of the time between taps");
  assert.ok(frames.every(({ angles }) => (angles.curlThumbRight ?? 0) === 0), "the thumb holds the elbow and never taps");
});

test("the hand mix hands the drift over to the fidget as the pose comes in", () => {
  const idle = Object.fromEntries(ARM_CHANNELS.map((channel, index) => [channel, (index % 5 - 2) * DEG]));
  const fidget = thinkingFidgetAngles(1.3, 1);
  assert.deepEqual(handAngles(idle, fidget, 0), { ...idle, ...Object.fromEntries(FIDGET_CHANNELS.map((c) => [c, idle[c] + fidget[c]])) });
  const posed = handAngles(idle, fidget, 1);
  for (const channel of ARM_CHANNELS) assert.equal(posed[channel], fidget[channel] ?? 0, `${channel} at full pose`);
  const half = handAngles(idle, thinkingFidgetAngles(1.3, 0.5), 0.5);
  assert.equal(half.wristLeft, 0.5 * idle.wristLeft, "a channel the fidget does not use fades with the pose");
});

test("the thinking pose runs the fidget on its own clock and stops it when released", () => {
  const pose = new ThinkingPose();
  pose.update(1);
  assert.equal(pose.clock, 0, "no clock before thinking");
  assert.ok(Object.values(pose.fidget()).every((angle) => angle === 0));
  pose.setActive(true);
  for (let i = 0; i < 120; i += 1) pose.update(FRAME);
  assert.ok(Math.abs(pose.clock - 2) < 1e-9, "the clock counts while she thinks");
  const easing = new ThinkingPose();
  easing.setActive(true);
  easing.update(FRAME);
  easing.clock = pose.clock;
  assert.ok(Math.abs(easing.fidget().forearmLeft) < Math.abs(pose.fidget().forearmLeft), "the fidget eases in with the pose");
  pose.setActive(false);
  for (let i = 0; i < 600; i += 1) pose.update(FRAME);
  assert.equal(pose.weight, 0);
  assert.equal(pose.clock, 0, "the next thinking starts its fidget afresh");
  assert.ok(Object.values(pose.fidget()).every((angle) => angle === 0), "nothing is left behind");
});

/** The posed fixture with its rigs, as main.js builds them. */
function posedRig() {
  const rig = fixture();
  relaxArms(rig.mesh);
  const thinking = buildThinkingRig(rig.mesh);
  const rewritten = new Set(thinking.map(({ bone }) => bone));
  const hand = buildHandDriftRig(rig.mesh).map((entry) => ({ ...entry, rest: rewritten.has(entry.bone) ? null : entry.bone.quaternion.clone() }));
  const tip = (side, digit) => rig.mesh.getObjectByName(`${side}${digit}先`);
  /** One frame as main.js applies it: the pose at full weight, then the hand angles. */
  function frame(angles) {
    for (const { bone, posed } of thinking) bone.quaternion.copy(posed);
    const restored = new Set();
    for (const { bone, rest, axis, channel, scale } of hand) {
      if (rest && !restored.has(bone)) bone.quaternion.copy(rest);
      restored.add(bone);
      const angle = scale * (angles[channel] ?? 0);
      if (angle !== 0) bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
    }
    rig.mesh.updateMatrixWorld(true);
  }
  return { ...rig, frame, tip };
}

test("on the posed rig the fidget keeps the arms where #217 put them", () => {
  const { get, frame, tip } = posedRig();
  frame({});
  const still = (name) => at(get(name));
  const joints = ["右ひじ", "右手首", "左ひじ", "左手首"].map((name) => [name, still(name)]);
  const tips = DIGITS.flatMap((digit) => ["右", "左"].map((side) => [side, digit, at(tip(side, digit))]));
  const forearm = (side) => {
    const elbow = at(get(`${side}ひじ`));
    const wrist = at(get(`${side}手首`));
    return Math.max(...Array.from({ length: 11 }, (_, i) => bustDepth(elbow.clone().lerp(wrist, i / 10))));
  };
  const depth = { right: forearm("右"), left: forearm("左") };
  let moved = { 右: 0, 左: 0 };
  for (let clock = 0; clock <= 2 * THINKING_FIDGET.tapEvery; clock += 0.05) {
    frame(thinkingFidgetAngles(clock, 1));
    for (const [name, position] of joints) {
      assert.ok(at(get(name)).distanceTo(position) < 1e-6, `${name} stays put at ${clock.toFixed(2)}s`);
    }
    assert.ok(Math.abs(forearm("右") - depth.right) < 1e-6 && Math.abs(forearm("左") - depth.left) < 1e-6,
      "the forearm bones keep their bust clearance");
    for (const [side, digit, position] of tips) {
      const now = at(tip(side, digit));
      const shift = now.distanceTo(position);
      moved[side] = Math.max(moved[side], shift);
      assert.ok(shift < 0.25, `${side}${digit} fingertip stays within 0.25 of the still pose (${shift.toFixed(3)})`);
      if (side === "右") assert.ok(now.y - position.y < 0.1, `${side}${digit} rises less than 0.1, staying under her chin`);
    }
  }
  assert.ok(moved.右 > 0.01, `the right fist moves (${moved.右.toFixed(3)})`);
  assert.ok(moved.左 > 0.03, `the left fingers move (${moved.左.toFixed(3)})`);
});

test("sizes can be overridden for comparison grids, without changing the defaults", () => {
  const before = JSON.stringify(THINKING_FIDGET);
  const still = thinkingFidgetAngles(2, 1, { roll: 0, squeeze: 0, tap: 0 });
  for (const channel of FIDGET_CHANNELS) assert.equal(still[channel], 0, `${channel} is still with zero sizes`);
  const doubled = thinkingFidgetAngles(2, 1, { roll: 2 * THINKING_FIDGET.roll });
  assert.ok(Math.abs(doubled.forearmLeft - 2 * thinkingFidgetAngles(2, 1).forearmLeft) < 1e-12);
  assert.equal(JSON.stringify(THINKING_FIDGET), before);
  assert.ok(FINGERS.every((finger) => typeof thinkingFidgetAngles(0, 1)[`curl${finger}Left`] === "number"), "the fist squeezes with every finger");
});
