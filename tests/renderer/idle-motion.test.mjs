// Run with: node --test tests/renderer/*.test.mjs
// Idle motions for #71: glance, head tilt, sigh and the stretch before sleepy.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IDLE_ACTIONS, IDLE_MOTION, IdleMotion, SLEEP_ACTIONS, SLEEP_ACTIONS_KEY, SLEEP_ACTION_LABELS,
  bindSleepActionSettings, bump,
} from "../../renderer/idle-motion.js";
import { IDLE_TIMING } from "../../renderer/idle-behaviour.js";

const DEG = Math.PI / 180;
const ANGLES = ["tilt", "chest", "shoulders", "shoulderLeft", "shoulderRight", "back", "headPitch"];

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

/** A random roll that picks the named awake idle action, whatever the weights are. */
function rollFor(name) {
  let start = 0;
  for (const [key, action] of Object.entries(IDLE_ACTIONS)) {
    if (key === name) return start + action.weight / 2;
    start += action.weight;
  }
  throw new Error(`No idle action ${name}`);
}

const isRest = (pose) => pose.glance === null && pose.yawn === 0 && ANGLES.every((k) => Math.abs(pose[k]) < 1e-9);

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
  const motion = new IdleMotion({ random: scripted(0, rollFor("tilt"), 0.9, 0) });
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
  const motion = new IdleMotion({ random: scripted(0, rollFor("sigh")) });
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
  for (let i = 1; i <= 3600 * 30; i += 1) { // an hour, so 5 % shrugs come up too
    const pose = motion.update(1 / 30, "idle", i / 30);
    if (motion.current) kinds.add(motion.current.kind);
    assert.ok(Math.abs(pose.tilt) <= IDLE_MOTION.tilt.angle + 1e-9);
    assert.ok(pose.chest >= -1e-9 && pose.chest <= IDLE_MOTION.sigh.chest + 1e-9);
    if (pose.glance) assert.ok(Math.abs(pose.tilt) < 1e-3, "no tilt during a glance");
  }
  assert.deepEqual([...kinds].sort(), ["glance", "shrug-both", "shrug-left", "shrug-right", "sigh", "tilt"]);
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
  const motion = new IdleMotion({ random: scripted(0, rollFor("tilt"), 0.9, 0) });
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

test("she yawns slowly during the stretch: about three seconds, open then closed", () => {
  const motion = new IdleMotion({ random: seeded() });
  const poses = play(motion, "stretching", IDLE_TIMING.stretch);
  const yawn = poses.map((p) => p.yawn);
  const peakAt = yawn.indexOf(Math.max(...yawn));
  assert.ok(yawn[peakAt] > 0.9, `opens fully (${yawn[peakAt].toFixed(2)})`);
  assert.ok(yawn[Math.round(0.34 * 60)] < 0.15, "opens slowly, not in the usual 0.34 s");
  assert.ok(peakAt / 60 >= 1.2, `still opening after 1.2 s (peak at ${(peakAt / 60).toFixed(2)} s)`);
  const { open, hold, close } = IDLE_MOTION.yawn;
  assert.ok(open + hold + close >= 2.5 && open + hold + close <= IDLE_TIMING.stretch, "2.5 s up to the stretch length");
  for (let i = 1; i < yawn.length; i += 1) assert.ok(Math.abs(yawn[i] - yawn[i - 1]) < 0.03, `smooth at frame ${i}`);
  const after = play(motion, "sleepy", 1.5);
  assert.ok(after.at(-1).yawn < 0.01, "mouth closed again once she is sleepy");
});

test("no yawn while active, idle, sleepy or waking, and a block mid-yawn closes the mouth smoothly", () => {
  for (const state of ["active", "idle", "sleepy", "waking"]) {
    const motion = new IdleMotion({ random: seeded() });
    assert.ok(play(motion, state, 30, { fps: 10 }).every((p) => p.yawn === 0), state);
  }
  const motion = new IdleMotion({ random: seeded() });
  play(motion, "stretching", 1.6);
  const back = play(motion, "active", 1.5);
  assert.ok(back[0].yawn > 0.3, "eases, not snaps");
  assert.ok(back.at(-1).yawn < 0.01);
});

/** Step a sleepy motion from `from` for `seconds`, with sleep actions every `every` s. */
function sleepy(motion, from, seconds, every) {
  const poses = [];
  for (let i = 1; i <= Math.round(seconds * 60); i += 1) poses.push(motion.update(1 / 60, "sleepy", from + i / 60, every));
  return poses;
}
const peak = (poses, key) => Math.max(...poses.map((p) => Math.abs(p[key])));

test("sleep actions are stretch-and-yawn and head tilts left and right, ready for more", () => {
  assert.deepEqual(Object.keys(SLEEP_ACTIONS), ["stretch-yawn", "tilt-left", "tilt-right", "nod"]);
  for (const [name, action] of Object.entries(SLEEP_ACTIONS)) {
    assert.ok(action.duration > 0 && action.duration < 30, name);
    assert.equal(typeof action.apply, "function", name);
  }
});

test("a sleep action plays on every interval while sleepy, then she settles", () => {
  const motion = new IdleMotion({ random: scripted(0.1) }); // stretch-yawn every time
  assert.ok(sleepy(motion, 0, 29.9, 30).every((p) => p.back === 0 && p.yawn === 0 && p.tilt === 0), "nothing before the first interval");
  const first = sleepy(motion, 29.9, IDLE_TIMING.stretch + 1.6, 30);
  assert.equal(motion.sleepAction, "stretch-yawn");
  assert.ok(peak(first, "back") > IDLE_MOTION.stretch.back * 0.7, "stretches at 30 s");
  assert.ok(peak(first, "yawn") > 0.9, "and yawns");
  assert.ok(first.at(-1).back < 0.05 * DEG && first.at(-1).yawn < 0.01, "then settles");
  const quiet = sleepy(motion, 29.9 + IDLE_TIMING.stretch + 1.6, 30 - IDLE_TIMING.stretch - 1.7, 30);
  assert.ok(quiet.every((p) => p.yawn < 0.01), "quiet in between");
  assert.ok(peak(sleepy(motion, 59.9, IDLE_TIMING.stretch, 30), "yawn") > 0.9, "again at 60 s");
});

test("a sleepy head tilt leans to one side, without stretching or yawning, and comes back", () => {
  for (const [roll, name, sign] of [[0.3, "tilt-left", 1], [0.6, "tilt-right", -1]]) {
    const motion = new IdleMotion({ random: scripted(roll) });
    const poses = sleepy(motion, 29.9, SLEEP_ACTIONS[name].duration + 1.6, 30);
    assert.equal(motion.sleepAction, name);
    const lean = poses.reduce((best, p) => (Math.abs(p.tilt) > Math.abs(best) ? p.tilt : best), 0);
    assert.equal(Math.sign(lean), sign, `${name} leans ${sign > 0 ? "to screen left" : "to screen right"}`);
    assert.ok(Math.abs(lean) > IDLE_MOTION.tilt.angle * 0.8, `${name} leans clearly`);
    assert.ok(peak(poses, "back") === 0 && peak(poses, "yawn") === 0, `${name} alone`);
    assert.ok(Math.abs(poses.at(-1).tilt) < 0.05 * DEG, `${name} comes back upright`);
  }
});

test("each interval picks its sleep action at random", () => {
  const motion = new IdleMotion({ random: seeded(5) });
  const seen = new Set();
  for (let k = 1; k <= 30; k += 1) {
    sleepy(motion, k * 20 - 0.05, 0.1, 20);
    seen.add(motion.sleepAction);
  }
  assert.deepEqual([...seen].sort(), ["nod", "stretch-yawn", "tilt-left", "tilt-right"]);
});

test("a new sleepy period starts its interval count again", () => {
  const motion = new IdleMotion({ random: scripted(0.1) });
  sleepy(motion, 29.9, 1, 30);
  motion.update(1 / 60, "waking", 0, 30);
  assert.equal(motion.sleepAction, null);
  const again = sleepy(motion, 0, 29.9, 30).slice(90); // the interrupted yawn eases shut in the first 1.5 s
  assert.ok(again.every((p) => p.yawn < 0.01 && p.back < 0.05 * DEG), "waits a full interval again");
});

test("an interval of 0 means no sleep actions, only the stretch before sleepy", () => {
  const motion = new IdleMotion({ random: seeded() });
  for (let i = 1; i <= 300 * 10; i += 1) {
    const pose = motion.update(0.1, "sleepy", i / 10, 0);
    assert.ok(pose.back === 0 && pose.yawn === 0 && pose.tilt === 0);
  }
});

// ---- #149: idle action library ----

test("awake idle actions live in one registry with rare shrugs, chances adding up to 1", () => {
  assert.deepEqual(Object.keys(IDLE_ACTIONS), ["glance", "tilt", "shrug-left", "shrug-right", "shrug-both", "sigh"]);
  const total = Object.values(IDLE_ACTIONS).reduce((sum, action) => sum + action.weight, 0);
  // The user's mix: shrugs stay rare (equal chances made them too common).
  const mix = { glance: 0.4, tilt: 0.25, "shrug-left": 0.05, "shrug-right": 0.05, "shrug-both": 0.05, sigh: 0.2 };
  for (const [name, action] of Object.entries(IDLE_ACTIONS)) {
    assert.ok(Math.abs(action.weight - mix[name]) < 1e-9, `${name} has its ${mix[name] * 100} % chance`);
  }
  assert.ok(Math.abs(total - 1) < 1e-9);
  for (const [name, action] of Object.entries(IDLE_ACTIONS)) {
    assert.ok(action.weight > 0, name);
    assert.equal(typeof action.create, "function", name);
    assert.equal(typeof action.apply, "function", name);
  }
});

/** Play one awake idle action picked by `roll`, until it has eased back. */
function idleAction(roll) {
  const motion = new IdleMotion({ random: scripted(0, roll, 0.9, 0) });
  play(motion, "idle", IDLE_MOTION.gap[0] + 0.02);
  const kind = motion.current?.kind;
  const poses = play(motion, "idle", 3.5);
  return { kind, poses };
}

test("a left or right shrug lifts only that shoulder, then lets it down", () => {
  for (const [roll, kind, side, other] of [[rollFor("shrug-left"), "shrug-left", "shoulderLeft", "shoulderRight"], [rollFor("shrug-right"), "shrug-right", "shoulderRight", "shoulderLeft"]]) {
    const { kind: picked, poses } = idleAction(roll);
    assert.equal(picked, kind);
    const lift = Math.max(...poses.map((p) => p[side]));
    assert.ok(lift > IDLE_MOTION.shrug.angle * 0.8, `${kind} lifts clearly`);
    assert.ok(lift <= IDLE_MOTION.shrug.angle + 1e-9, `${kind} stays within its limit`);
    assert.ok(poses.every((p) => p[other] === 0 && p.shoulders === 0 && p.tilt === 0), `${kind} moves one shoulder only`);
    assert.ok(poses.at(-1)[side] < 0.05 * DEG, `${kind} comes back down`);
  }
});

test("a both-shoulder shrug lifts both shoulders evenly", () => {
  const { kind, poses } = idleAction(rollFor("shrug-both"));
  assert.equal(kind, "shrug-both");
  const peakAt = poses.reduce((best, p, i) => (p.shoulderLeft > poses[best].shoulderLeft ? i : best), 0);
  assert.ok(poses[peakAt].shoulderLeft > IDLE_MOTION.shrug.angle * 0.8);
  assert.ok(Math.abs(poses[peakAt].shoulderLeft - poses[peakAt].shoulderRight) < 1e-9);
});

test("the dozing nod drops the head slowly while sleepy, then lifts it again", () => {
  const motion = new IdleMotion({ random: scripted(0.9) }); // the 4th of 4 sleep actions
  const poses = [];
  for (let i = 1; i <= Math.round((SLEEP_ACTIONS.nod.duration + 1.6) * 60); i += 1) {
    poses.push(motion.update(1 / 60, "sleepy", 29.9 + i / 60, 30));
  }
  assert.equal(motion.sleepAction, "nod");
  const dip = Math.min(...poses.map((p) => p.headPitch));
  assert.ok(dip < -IDLE_MOTION.nod.angle * 0.8, `head drops (${(dip / DEG).toFixed(1)}°)`);
  assert.ok(dip >= -IDLE_MOTION.nod.angle - 1e-9, "within its limit");
  assert.ok(poses.every((p) => p.yawn === 0 && p.back === 0));
  assert.ok(Math.abs(poses.at(-1).headPitch) < 0.05 * DEG, "lifts back up");
});

test("only the chosen sleep actions are picked; none chosen means none", () => {
  const motion = new IdleMotion({ random: seeded(9) });
  motion.setSleepActions(["tilt-left", "made-up"]);
  assert.deepEqual(motion.sleepActions, ["tilt-left"], "unknown names are ignored");
  for (let k = 1; k <= 10; k += 1) {
    motion.update(1 / 60, "sleepy", k * 20 + 0.01, 20);
    assert.equal(motion.sleepAction, "tilt-left");
  }
  const none = new IdleMotion({ random: seeded(9) });
  none.setSleepActions([]);
  for (let i = 1; i <= 100 * 10; i += 1) {
    const pose = none.update(0.1, "sleepy", i / 10, 20);
    assert.ok(pose.back === 0 && pose.yawn === 0 && pose.tilt === 0 && pose.headPitch === 0);
  }
  assert.equal(none.sleepAction, null);
});

/** A checkbox double with change listeners. */
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

test("the panel offers every sleep action with a label, all ticked by default", () => {
  assert.deepEqual(Object.keys(SLEEP_ACTION_LABELS), Object.keys(SLEEP_ACTIONS));
  const motion = new IdleMotion();
  const boxes = Object.fromEntries(Object.keys(SLEEP_ACTIONS).map((name) => [name, checkbox(false)]));
  bindSleepActionSettings(motion, boxes, { local: storage() });
  assert.ok(Object.values(boxes).every((box) => box.checked));
  assert.deepEqual(motion.sleepActions, Object.keys(SLEEP_ACTIONS));
});

test("unticking a sleep action saves the choice and restores it after a reload", () => {
  const local = storage();
  const first = new IdleMotion();
  const boxes = Object.fromEntries(Object.keys(SLEEP_ACTIONS).map((name) => [name, checkbox(true)]));
  bindSleepActionSettings(first, boxes, { local });
  boxes["stretch-yawn"].set(false);
  boxes.nod.set(false);
  assert.deepEqual(first.sleepActions, ["tilt-left", "tilt-right"]);
  assert.deepEqual(JSON.parse(local.map.get(SLEEP_ACTIONS_KEY)), ["tilt-left", "tilt-right"]);

  const next = new IdleMotion();
  const again = Object.fromEntries(Object.keys(SLEEP_ACTIONS).map((name) => [name, checkbox(true)]));
  bindSleepActionSettings(next, again, { local });
  assert.deepEqual(next.sleepActions, ["tilt-left", "tilt-right"]);
  assert.equal(again["stretch-yawn"].checked, false);
  assert.equal(again["tilt-left"].checked, true);
});

test("corrupt or blocked storage keeps every sleep action", () => {
  for (const local of [storage({ [SLEEP_ACTIONS_KEY]: "{oops" }), storage({ [SLEEP_ACTIONS_KEY]: "42" }),
    { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }]) {
    const motion = new IdleMotion();
    bindSleepActionSettings(motion, {}, { local });
    assert.deepEqual(motion.sleepActions, Object.keys(SLEEP_ACTIONS));
  }
});
