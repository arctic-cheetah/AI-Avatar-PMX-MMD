// Run with: node --test tests/renderer/*.test.mjs
// Idle motions (#71, #149): one set of actions, played while idle and while asleep,
// plus the stretch with its yawn on the way into sleepy.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS, ACTIONS_KEY, ACTION_LABELS, IDLE_MOTION, IdleMotion, bindActionSettings, bump, manualPlayBlocked,
} from "../../renderer/idle-motion.js";
import { IDLE_TIMING } from "../../renderer/idle-behaviour.js";

const DEG = Math.PI / 180;
const ANGLES = ["tilt", "chest", "shoulders", "shoulderLeft", "shoulderRight", "back", "headPitch"];
const NAMES = Object.keys(ACTIONS);

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
function play(motion, state, seconds, { fps = 60, from = 0, every = 0 } = {}) {
  const poses = [];
  const frames = Math.round(seconds * fps);
  for (let i = 1; i <= frames; i += 1) poses.push(motion.update(1 / fps, state, from + i / fps, every));
  return poses;
}

/** A random roll that picks the named action when all are ticked, whatever the weights are. */
function rollFor(name) {
  let start = 0;
  for (const [key, action] of Object.entries(ACTIONS)) {
    if (key === name) return start + action.weight / 2;
    start += action.weight;
  }
  throw new Error(`No action ${name}`);
}

/** Play the named action while awake and idle, until it has eased back. */
function awake(name, seconds = 5) {
  const motion = new IdleMotion({ random: scripted(0, rollFor(name), 0.9, 0) });
  play(motion, "idle", IDLE_MOTION.gap[0] + 0.02);
  const kind = motion.current?.kind;
  return { kind, poses: play(motion, "idle", seconds) };
}

/** Play the named action as the first sleep action (interval 30 s), until it has eased back. */
function asleep(name, seconds = 5) {
  const motion = new IdleMotion({ random: scripted(rollFor(name), 0.9, 0) });
  play(motion, "sleepy", 29.9, { every: 30 });
  const poses = play(motion, "sleepy", seconds, { from: 29.9, every: 30 });
  return { kind: motion.sleepAction, poses };
}

const isRest = (pose) => pose.glance === null && pose.yawn === 0 && ANGLES.every((k) => Math.abs(pose[k]) < 1e-9);
const peak = (poses, key) => Math.max(...poses.map((p) => Math.abs(p[key])));
const signedPeak = (poses, key) => poses.reduce((best, p) => (Math.abs(p[key]) > Math.abs(best) ? p[key] : best), 0);

test("bump eases in, holds and eases out within its duration", () => {
  assert.equal(bump(0, 2, 0.5), 0);
  assert.equal(bump(1, 2, 0.5), 1);
  assert.equal(bump(2, 2, 0.5), 0);
  assert.equal(bump(-1, 2, 0.5), 0);
  assert.equal(bump(3, 2, 0.5), 0);
  assert.ok(bump(0.25, 2, 0.5) > 0 && bump(0.25, 2, 0.5) < 1);
  assert.ok(Math.abs(bump(0.5, 0.6, 0.5) - bump(0.1, 0.6, 0.5)) < 1e-12, "short bumps stay symmetric");
});

// ---- one registry (#149) ----

test("one set of actions serves both idle and sleep, with the user's mix: shrugs stay rare", () => {
  assert.deepEqual(NAMES, ["glance", "tilt-left", "tilt-right", "shrug-left", "shrug-right", "shrug-both", "sigh", "stretch-yawn", "nod"]);
  // The user's mix (12 Nov 2026): glances 10 %, stretch-and-yawn 30 %, shrugs rare.
  const mix = { glance: 0.1, "tilt-left": 0.1, "tilt-right": 0.1, "shrug-left": 0.05, "shrug-right": 0.05,
    "shrug-both": 0.05, sigh: 0.15, "stretch-yawn": 0.3, nod: 0.1 };
  for (const [name, action] of Object.entries(ACTIONS)) {
    assert.ok(Math.abs(action.weight - mix[name]) < 1e-9, `${name} has its ${mix[name] * 100} % chance`);
    assert.equal(typeof action.create, "function", name);
    assert.equal(typeof action.apply, "function", name);
  }
  assert.deepEqual(Object.keys(ACTION_LABELS), NAMES, "every action has a panel label");
});

test("a shrug is 12°, the size the user picked from rendered comparisons", () => {
  assert.ok(Math.abs(IDLE_MOTION.shrug.angle - 12 * DEG) < 1e-12);
});

// ---- awake idle ----

test("no motion while active or waking", () => {
  for (const state of ["active", "waking"]) {
    const motion = new IdleMotion({ random: seeded() });
    for (const pose of play(motion, state, 60, { fps: 10, every: 30 })) assert.ok(isRest(pose), state);
  }
});

test("the first idle action waits for the gap", () => {
  const motion = new IdleMotion({ random: scripted(0) });
  assert.ok(play(motion, "idle", IDLE_MOTION.gap[0] - 0.1).every(isRest));
  play(motion, "idle", 0.2);
  assert.equal(motion.current?.kind, "glance");
});

test("a glance drifts slowly to one side and back: eased in and out, over 2-3 s", () => {
  const { glance } = IDLE_MOTION;
  assert.ok(glance.duration[0] >= 2 && glance.duration[1] <= 3.5, "slow enough not to look darting");
  assert.ok(glance.rise >= 0.8, "eases in and out over most of a second");
  const motion = new IdleMotion({ random: scripted(0) });
  play(motion, "idle", IDLE_MOTION.gap[0] + 0.02);
  const weights = play(motion, "idle", glance.duration[0]).map((p) => p.glance?.weight ?? 0);
  assert.ok(weights[Math.round(0.2 * 60)] < 0.15, `starts gently (${weights[12].toFixed(2)} after 0.2 s)`);
  assert.ok(Math.max(...weights) > 0.99, "reaches the full glance");
  for (let i = 1; i < weights.length; i += 1) assert.ok(Math.abs(weights[i] - weights[i - 1]) < 0.05, `smooth at frame ${i}`);
  assert.ok(weights.at(-1) < 0.15, "eases back before letting go");
});

test("a glance looks to one side, then lets go of the gaze", () => {
  const motion = new IdleMotion({ random: scripted(0) });
  play(motion, "idle", IDLE_MOTION.gap[0] + 0.05);
  const pose = motion.update(1 / 60, "idle", 9);
  assert.ok(pose.glance, "glance target set");
  assert.ok(Math.abs(pose.glance.x) >= IDLE_MOTION.glance.x[0] - 1e-9);
  assert.ok(Math.abs(pose.glance.y) <= Math.max(...IDLE_MOTION.glance.y.map(Math.abs)) + 1e-9);
  assert.equal(play(motion, "idle", IDLE_MOTION.glance.duration[0] + 0.1).at(-1).glance, null);
});

test("glances go both ways", () => {
  const left = new IdleMotion({ random: scripted(0, 0, 0.1) });
  const right = new IdleMotion({ random: scripted(0, 0, 0.9) });
  play(left, "idle", IDLE_MOTION.gap[0] + 0.1);
  play(right, "idle", IDLE_MOTION.gap[0] + 0.1);
  assert.ok(left.update(0, "idle", 9).glance.x < 0);
  assert.ok(right.update(0, "idle", 9).glance.x > 0);
});

test("head tilts lean left or right of the screen within their angle, then come back", () => {
  for (const [name, sign] of [["tilt-left", 1], ["tilt-right", -1]]) {
    const { kind, poses } = awake(name);
    assert.equal(kind, name);
    const lean = signedPeak(poses, "tilt");
    assert.equal(Math.sign(lean), sign, name);
    assert.ok(Math.abs(lean) > IDLE_MOTION.tilt.angle * 0.8 && Math.abs(lean) <= IDLE_MOTION.tilt.angle + 1e-9, name);
    assert.ok(Math.abs(poses.at(-1).tilt) < 0.05 * DEG, `${name} back upright`);
  }
});

test("a sigh lifts the chest and shoulders, then lets them fall", () => {
  const { kind, poses } = awake("sigh", IDLE_MOTION.sigh.inhale + IDLE_MOTION.sigh.exhale + 1);
  assert.equal(kind, "sigh");
  const peakAt = poses.reduce((best, p, i) => (p.chest > poses[best].chest ? i : best), 0);
  assert.ok(poses[peakAt].chest > IDLE_MOTION.sigh.chest * 0.8);
  assert.ok(poses[peakAt].shoulders > 0);
  assert.ok(peakAt / 60 > IDLE_MOTION.sigh.inhale * 0.7 && peakAt / 60 < IDLE_MOTION.sigh.inhale + 0.5);
  assert.ok(Math.abs(poses.at(-1).chest) < 0.05 * DEG, "breathes out fully");
});

test("a left or right shrug lifts only that shoulder 12°, then lets it down", () => {
  for (const [name, side, other] of [["shrug-left", "shoulderLeft", "shoulderRight"], ["shrug-right", "shoulderRight", "shoulderLeft"]]) {
    const { kind, poses } = awake(name);
    assert.equal(kind, name);
    const lift = peak(poses, side);
    assert.ok(lift > IDLE_MOTION.shrug.angle * 0.8 && lift <= IDLE_MOTION.shrug.angle + 1e-9, `${name} lifts`);
    assert.ok(poses.every((p) => p[other] === 0 && p.shoulders === 0 && p.tilt === 0), `${name} alone`);
    assert.ok(poses.at(-1)[side] < 0.05 * DEG, `${name} comes back down`);
  }
});

test("a both-shoulder shrug lifts both shoulders evenly", () => {
  const { kind, poses } = awake("shrug-both");
  assert.equal(kind, "shrug-both");
  const top = poses.reduce((best, p) => (p.shoulderLeft > best.shoulderLeft ? p : best), poses[0]);
  assert.ok(top.shoulderLeft > IDLE_MOTION.shrug.angle * 0.8);
  assert.ok(Math.abs(top.shoulderLeft - top.shoulderRight) < 1e-9);
});

test("the stretch with its yawn and the dozing nod can also happen while awake", () => {
  const stretch = awake("stretch-yawn");
  assert.equal(stretch.kind, "stretch-yawn");
  assert.ok(peak(stretch.poses, "back") > IDLE_MOTION.stretch.back * 0.7 && peak(stretch.poses, "yawn") > 0.9);
  const nod = awake("nod");
  assert.equal(nod.kind, "nod");
  assert.ok(Math.min(...nod.poses.map((p) => p.headPitch)) < -IDLE_MOTION.nod.angle * 0.8, "head dips");
});

test("every action comes up while idle over an hour, one at a time, within its limits", () => {
  const motion = new IdleMotion({ random: seeded(11) });
  const kinds = new Set();
  for (let i = 1; i <= 3600 * 30; i += 1) {
    const pose = motion.update(1 / 30, "idle", i / 30);
    if (motion.current) kinds.add(motion.current.kind);
    assert.ok(Math.abs(pose.tilt) <= IDLE_MOTION.tilt.angle + 1e-9);
    assert.ok(pose.chest >= -1e-9 && pose.chest <= IDLE_MOTION.sigh.chest + 1e-9);
    if (pose.glance) assert.ok(Math.abs(pose.tilt) < 1e-3, "no tilt during a glance");
  }
  assert.deepEqual([...kinds].sort(), [...NAMES].sort());
});

test("motions are smooth from frame to frame", () => {
  const motion = new IdleMotion({ random: seeded(3) });
  let previous = motion.update(0, "idle", 0);
  for (let i = 1; i < 300 * 60; i += 1) {
    const state = i < 200 * 60 ? "idle" : i < 200 * 60 + 192 ? "stretching" : "sleepy";
    const stateTime = state === "idle" ? i / 60 : (i - 200 * 60) / 60;
    const pose = motion.update(1 / 60, state, stateTime, 20);
    for (const key of ANGLES) {
      assert.ok(Math.abs(pose[key] - previous[key]) < 0.25 * DEG, `${key} jumped at frame ${i}`);
    }
    assert.ok(Math.abs(pose.yawn - previous.yawn) < 0.03, `yawn jumped at frame ${i}`);
    previous = { ...pose };
  }
});

test("leaving idle mid-action drops the glance at once and eases the rest back", () => {
  const motion = new IdleMotion({ random: scripted(0, rollFor("tilt-left"), 0.9, 0) });
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

test("a new idle period waits for a fresh gap, and invalid deltas hold the pose", () => {
  const motion = new IdleMotion({ random: scripted(0) });
  play(motion, "idle", IDLE_MOTION.gap[0] - 1);
  play(motion, "active", 1);
  assert.ok(play(motion, "idle", IDLE_MOTION.gap[0] - 0.1).every(isRest), "the gap restarts after activity");
  const still = new IdleMotion({ random: scripted(0) });
  for (const delta of [Number.NaN, -1, Number.POSITIVE_INFINITY]) assert.ok(isRest(still.update(delta, "idle", 0)));
  assert.equal(still.current, null);
});

// ---- the stretch into sleepy ----

test("the stretch into sleepy arches back, lifts the head and shoulders, then settles", () => {
  const motion = new IdleMotion({ random: seeded() });
  const poses = play(motion, "stretching", IDLE_TIMING.stretch);
  const mid = poses[Math.round(poses.length / 2)];
  assert.ok(mid.back > IDLE_MOTION.stretch.back * 0.7);
  assert.ok(mid.headPitch > IDLE_MOTION.stretch.headPitch * 0.7);
  assert.ok(mid.shoulders > IDLE_MOTION.stretch.shoulders * 0.7);
  assert.equal(motion.current, null, "no other action during the stretch");
  const settled = play(motion, "sleepy", 1.5);
  assert.ok(ANGLES.every((k) => Math.abs(settled.at(-1)[k]) < 0.05 * DEG));
});

test("she yawns slowly during that stretch: about three seconds, open then closed", () => {
  const motion = new IdleMotion({ random: seeded() });
  const yawn = play(motion, "stretching", IDLE_TIMING.stretch).map((p) => p.yawn);
  const peakAt = yawn.indexOf(Math.max(...yawn));
  assert.ok(yawn[peakAt] > 0.9, `opens fully (${yawn[peakAt].toFixed(2)})`);
  assert.ok(yawn[Math.round(0.34 * 60)] < 0.15, "opens slowly, not in the usual 0.34 s");
  assert.ok(peakAt / 60 >= 1.2, "still opening after 1.2 s");
  const { open, hold, close } = IDLE_MOTION.yawn;
  assert.ok(open + hold + close >= 2.5 && open + hold + close <= IDLE_TIMING.stretch);
  for (let i = 1; i < yawn.length; i += 1) assert.ok(Math.abs(yawn[i] - yawn[i - 1]) < 0.03, `smooth at frame ${i}`);
  assert.ok(play(motion, "sleepy", 1.5).at(-1).yawn < 0.01, "mouth closed again once she is sleepy");
});

test("no yawn while active or waking, and a block mid-yawn closes the mouth smoothly", () => {
  for (const state of ["active", "waking"]) {
    const motion = new IdleMotion({ random: seeded() });
    assert.ok(play(motion, state, 30, { fps: 10 }).every((p) => p.yawn === 0), state);
  }
  const motion = new IdleMotion({ random: seeded() });
  play(motion, "stretching", 1.6);
  const back = play(motion, "active", 1.5);
  assert.ok(back[0].yawn > 0.3, "eases, not snaps");
  assert.ok(back.at(-1).yawn < 0.01);
});

// ---- asleep ----

test("an action plays on every interval while sleepy, then she settles", () => {
  const motion = new IdleMotion({ random: scripted(rollFor("stretch-yawn")) });
  assert.ok(play(motion, "sleepy", 29.9, { every: 30 }).every(isRest), "nothing before the first interval");
  const first = play(motion, "sleepy", IDLE_TIMING.stretch + 1.6, { from: 29.9, every: 30 });
  assert.equal(motion.sleepAction, "stretch-yawn");
  assert.ok(peak(first, "back") > IDLE_MOTION.stretch.back * 0.7 && peak(first, "yawn") > 0.9);
  assert.ok(first.at(-1).back < 0.05 * DEG && first.at(-1).yawn < 0.01, "then settles");
  assert.ok(peak(play(motion, "sleepy", IDLE_TIMING.stretch, { from: 59.9, every: 30 }), "yawn") > 0.9, "again at 60 s");
});

/** What each action visibly does, by name. */
const SHOWS = {
  glance: (poses) => poses.some((p) => p.glance),
  "tilt-left": (poses) => signedPeak(poses, "tilt") > IDLE_MOTION.tilt.angle * 0.8,
  "tilt-right": (poses) => signedPeak(poses, "tilt") < -IDLE_MOTION.tilt.angle * 0.8,
  "shrug-left": (poses) => peak(poses, "shoulderLeft") > IDLE_MOTION.shrug.angle * 0.8 && peak(poses, "shoulderRight") === 0,
  "shrug-right": (poses) => peak(poses, "shoulderRight") > IDLE_MOTION.shrug.angle * 0.8 && peak(poses, "shoulderLeft") === 0,
  "shrug-both": (poses) => peak(poses, "shoulderLeft") > IDLE_MOTION.shrug.angle * 0.8 && peak(poses, "shoulderRight") > IDLE_MOTION.shrug.angle * 0.8,
  sigh: (poses) => peak(poses, "chest") > IDLE_MOTION.sigh.chest * 0.8,
  "stretch-yawn": (poses) => peak(poses, "yawn") > 0.9,
  nod: (poses) => Math.min(...poses.map((p) => p.headPitch)) < -IDLE_MOTION.nod.angle * 0.8,
};

test("every action also plays while asleep", () => {
  for (const name of NAMES) {
    const { kind, poses } = asleep(name);
    assert.equal(kind, name);
    assert.ok(SHOWS[name](poses), `${name} shows while asleep`);
    assert.ok(isRest(play(new IdleMotion(), "sleepy", 0.1)[0]));
  }
});

test("each sleepy interval picks its action at random from all of them", () => {
  const motion = new IdleMotion({ random: seeded(5) });
  const seen = new Set();
  for (let k = 1; k <= 300; k += 1) {
    play(motion, "sleepy", 0.1, { from: k * 20 - 0.05, every: 20 });
    seen.add(motion.sleepAction);
  }
  assert.deepEqual([...seen].sort(), [...NAMES].sort());
});

test("a new sleepy period starts its interval count again", () => {
  const motion = new IdleMotion({ random: scripted(rollFor("stretch-yawn")) });
  play(motion, "sleepy", 1, { from: 29.9, every: 30 });
  motion.update(1 / 60, "waking", 0, 30);
  assert.equal(motion.sleepAction, null);
  const again = play(motion, "sleepy", 29.9, { every: 30 }).slice(90); // the interrupted yawn eases shut first
  assert.ok(again.every((p) => p.yawn < 0.01 && p.back < 0.05 * DEG), "waits a full interval again");
});

test("an interval of 0 means no actions while asleep, only the stretch before sleepy", () => {
  const motion = new IdleMotion({ random: seeded() });
  assert.ok(play(motion, "sleepy", 300, { fps: 10, every: 0 }).every(isRest));
});

// ---- choosing actions ----

test("only the ticked actions play, awake and asleep; unknown names are ignored", () => {
  const motion = new IdleMotion({ random: seeded(4) });
  motion.setActions(["shrug-left", "made-up"]);
  assert.deepEqual(motion.actions, ["shrug-left"]);
  const kinds = new Set();
  for (let i = 1; i <= 600 * 10; i += 1) {
    motion.update(0.1, "idle", i / 10);
    if (motion.current) kinds.add(motion.current.kind);
  }
  assert.deepEqual([...kinds], ["shrug-left"]);
  for (let k = 1; k <= 10; k += 1) {
    play(motion, "sleepy", 0.1, { from: k * 20 - 0.05, every: 20 });
    assert.equal(motion.sleepAction, "shrug-left");
  }
});

test("ticked actions keep their relative chances", () => {
  const pick = (roll) => {
    const motion = new IdleMotion({ random: scripted(0, roll, 0.9, 0) });
    motion.setActions(["glance", "tilt-left", "sigh"]);
    motion.update(IDLE_MOTION.gap[0] + 0.01, "idle", 0);
    return motion.current?.kind;
  };
  // glance 0.1 : tilt-left 0.1 : sigh 0.15, rescaled over 0.35
  assert.equal(pick(0.1 / 0.35 - 0.01), "glance");
  assert.equal(pick(0.1 / 0.35 + 0.01), "tilt-left");
  assert.equal(pick(0.2 / 0.35 + 0.01), "sigh");
});

test("with nothing ticked she stays still, awake and asleep", () => {
  const motion = new IdleMotion({ random: seeded(4) });
  motion.setActions([]);
  assert.ok(play(motion, "idle", 600, { fps: 10 }).every(isRest));
  assert.ok(play(motion, "sleepy", 300, { fps: 10, every: 20 }).every(isRest));
  assert.equal(motion.current, null);
  assert.equal(motion.sleepAction, null);
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

test("the panel ticks every action by default", () => {
  const motion = new IdleMotion();
  const boxes = Object.fromEntries(NAMES.map((name) => [name, checkbox(false)]));
  bindActionSettings(motion, boxes, { local: storage() });
  assert.ok(Object.values(boxes).every((box) => box.checked));
  assert.deepEqual(motion.actions, NAMES);
});

test("unticking actions saves the choice and restores it after a reload", () => {
  const local = storage();
  const first = new IdleMotion();
  const boxes = Object.fromEntries(NAMES.map((name) => [name, checkbox(true)]));
  bindActionSettings(first, boxes, { local });
  boxes["shrug-both"].set(false);
  boxes.nod.set(false);
  const kept = NAMES.filter((name) => name !== "shrug-both" && name !== "nod");
  assert.deepEqual(first.actions, kept);
  assert.deepEqual(JSON.parse(local.map.get(ACTIONS_KEY)), kept);

  const next = new IdleMotion();
  const again = Object.fromEntries(NAMES.map((name) => [name, checkbox(true)]));
  bindActionSettings(next, again, { local });
  assert.deepEqual(next.actions, kept);
  assert.equal(again["shrug-both"].checked, false);
  assert.equal(again["shrug-left"].checked, true);
});

test("corrupt or blocked storage keeps every action", () => {
  for (const local of [storage({ [ACTIONS_KEY]: "{oops" }), storage({ [ACTIONS_KEY]: "42" }),
    { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }]) {
    const motion = new IdleMotion();
    bindActionSettings(motion, {}, { local });
    assert.deepEqual(motion.actions, NAMES);
  }
});

// Manual play (#164): the Animation actions buttons play one action on demand.

/** Step one frame at 60 fps in a state; stateTime is not used by manual play. */
const frame = (motion, state = "active", every = 0) => motion.update(1 / 60, state, 0, every);

test("each action plays once on demand while active, shows, then settles back to rest", () => {
  for (const name of NAMES) {
    const motion = new IdleMotion({ random: scripted(0.9) });
    assert.equal(motion.play(name), true, name);
    assert.equal(motion.playing, name);
    const poses = play(motion, "active", 6);
    assert.ok(SHOWS[name](poses), `${name} shows`);
    assert.equal(motion.playing, null, `${name} ends`);
    assert.ok(isRest(play(motion, "active", 1).at(-1)), `${name} settles`);
  }
});

test("manual actions stay within their limits and move smoothly, in every state they may play in", () => {
  for (const state of ["active", "idle", "sleepy"]) {
    for (const name of NAMES) {
      const motion = new IdleMotion({ random: scripted(0.9) });
      motion.play(name);
      let previous = motion.update(0, state, 0);
      for (let i = 1; i <= 6 * 60; i += 1) {
        const pose = motion.update(1 / 60, state, i / 60);
        assert.ok(Math.abs(pose.tilt) <= IDLE_MOTION.tilt.angle + 1e-9, `${state} ${name} tilt`);
        assert.ok(pose.yawn >= 0 && pose.yawn <= 1, `${state} ${name} yawn`);
        for (const key of ANGLES) {
          assert.ok(Math.abs(pose[key] - previous[key]) < 0.25 * DEG, `${state} ${name} ${key} jumped at frame ${i}`);
        }
        assert.ok(Math.abs(pose.yawn - previous.yawn) < 0.03, `${state} ${name} yawn jumped at frame ${i}`);
        previous = { ...pose };
      }
    }
  }
});

test("unknown or empty names are ignored and change nothing", () => {
  const motion = new IdleMotion();
  for (const name of ["", "dance", "__proto__", "constructor", undefined, null]) {
    assert.equal(motion.play(name), false, String(name));
    assert.equal(motion.toggle(name), null, String(name));
  }
  assert.equal(motion.playing, null);
  assert.ok(isRest(frame(motion)));
});

test("a second click on the same button stops it; another button switches without a jump", () => {
  const motion = new IdleMotion({ random: scripted(0.9) });
  assert.equal(motion.toggle("tilt-left"), "playing");
  play(motion, "active", 1.5);
  assert.equal(motion.toggle("tilt-left"), "stopped");
  assert.equal(motion.playing, null);
  const back = play(motion, "active", 1);
  assert.ok(back[0].tilt > 0, "eases back, not snaps");
  assert.ok(Math.abs(back.at(-1).tilt) < 0.05 * DEG);

  motion.toggle("tilt-left");
  play(motion, "active", 1.5);
  const before = frame(motion).tilt;
  assert.equal(motion.toggle("tilt-right"), "playing");
  assert.equal(motion.playing, "tilt-right");
  const after = frame(motion).tilt;
  assert.ok(Math.abs(after - before) < 0.25 * DEG, "switch blends from the current pose");
  assert.ok(signedPeak(play(motion, "active", 3), "tilt") < -IDLE_MOTION.tilt.angle * 0.8, "then tilts right");
});

test("stop() eases back to rest and drops a glance at once", () => {
  const motion = new IdleMotion({ random: scripted(0.9) });
  motion.play("glance");
  play(motion, "active", 1);
  motion.play("sigh");
  play(motion, "active", 1);
  motion.stop();
  assert.equal(motion.playing, null);
  const back = play(motion, "active", 2);
  assert.equal(back[0].glance, null);
  assert.ok(back[0].chest > 0, "eases, not snaps");
  assert.ok(isRest(back.at(-1)));
});

test("a manual action replaces the idle auto action, and auto play waits a fresh gap after it", () => {
  const motion = new IdleMotion({ random: scripted(0, rollFor("tilt-left"), 0.9, 0) });
  play(motion, "idle", IDLE_MOTION.gap[0] + 0.5);
  assert.equal(motion.current?.kind, "tilt-left");
  motion.play("tilt-right");
  assert.equal(motion.current, null, "the auto action gives way");
  const length = motion.manual.duration;
  assert.ok(signedPeak(play(motion, "idle", length + 0.05), "tilt") < 0, "only the manual tilt shows");
  assert.equal(motion.playing, null);
  const quiet = play(motion, "idle", IDLE_MOTION.gap[0] - 0.5);
  assert.equal(motion.current, null, "no auto action straight after");
  assert.ok(isRest(quiet.at(-1)));
});

test("a manual action overrides the sleep action while asleep", () => {
  const motion = new IdleMotion({ random: scripted(rollFor("tilt-left"), 0.9) });
  play(motion, "sleepy", 30.5, { every: 30 });
  assert.equal(motion.sleepAction, "tilt-left");
  motion.play("nod");
  const poses = play(motion, "sleepy", 2, { from: 30.5, every: 30 });
  assert.ok(Math.abs(poses.at(-1).tilt) < 0.05 * DEG, "the sleep tilt eases away");
  assert.ok(SHOWS.nod(poses));
});

test("the stretch into sleepy and waking up end a manual action", () => {
  for (const state of ["stretching", "waking"]) {
    const motion = new IdleMotion({ random: scripted(0.9) });
    motion.play("shrug-both");
    play(motion, "active", 1);
    frame(motion, state);
    assert.equal(motion.playing, null, state);
  }
});

test("manual play never touches the ticked actions or the stored choice", () => {
  const motion = new IdleMotion();
  motion.setActions(["sigh"]);
  for (const name of NAMES) motion.play(name);
  assert.deepEqual(motion.actions, ["sigh"]);
});

test("the buttons wait for the model, idle on, no block, no held pose and a calm state", () => {
  const ok = { loaded: true, idleEnabled: true, blocked: false, held: false, state: "active" };
  assert.equal(manualPlayBlocked(ok), null);
  for (const state of ["active", "idle", "sleepy"]) assert.equal(manualPlayBlocked({ ...ok, state }), null, state);
  assert.match(manualPlayBlocked({ ...ok, loaded: false }), /model/i);
  assert.match(manualPlayBlocked({ ...ok, idleEnabled: false }), /idle/i);
  assert.match(manualPlayBlocked({ ...ok, blocked: true }), /busy|speech|thinking/i);
  assert.match(manualPlayBlocked({ ...ok, held: true }), /held|preview/i);
  assert.match(manualPlayBlocked({ ...ok, state: "stretching" }), /stretch/i);
  assert.match(manualPlayBlocked({ ...ok, state: "waking" }), /waking/i);
});
