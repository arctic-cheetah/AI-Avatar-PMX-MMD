// Idle motions for issue #71: glances, head tilts and sighs while idle, and a
// stretch with a slow yawn just before sleepy, then random sleep actions while sleepy. No DOM or Three.js imports, so node --test
// covers it (tests/renderer/idle-motion.test.mjs). main.js turns the pose into
// a gaze target and small bone rotations on top of the rest pose.
// See docs/idle-behaviours.md#idle-motions.

import { Spring } from "./smoothing.js";
import { IDLE_TIMING } from "./idle-behaviour.js";

const DEG = Math.PI / 180;

/** Timings in seconds, angles in radians, glance sizes as normalised gaze targets. */
export const IDLE_MOTION = Object.freeze({
  /** Quiet seconds before each motion, picked uniformly. */
  gap: Object.freeze([8, 20]),
  glance: Object.freeze({
    duration: Object.freeze([1.2, 2.2]),
    x: Object.freeze([0.45, 0.75]),
    y: Object.freeze([-0.15, 0.15]),
  }),
  tilt: Object.freeze({ duration: Object.freeze([2, 3.5]), angle: 5 * DEG, rise: 0.6 }),
  sigh: Object.freeze({ inhale: 1.1, exhale: 1.7, chest: 2 * DEG, shoulders: 2.5 * DEG }),
  /** One or both shoulders lift and drop (#149). */
  shrug: Object.freeze({ duration: Object.freeze([1.6, 2.2]), angle: 6 * DEG, rise: 0.7 }),
  /** The dozing nod sleep action: head dips forward and lifts (#149). */
  nod: Object.freeze({ angle: 6 * DEG, rise: 1 }),
  stretch: Object.freeze({ rise: 1, back: 5 * DEG, headPitch: 7 * DEG, shoulders: 6 * DEG }),
  /** The yawn during the stretch: the user's mouth pick, opened slowly (#71). */
  yawn: Object.freeze({ open: 1.4, hold: 0.6, close: 1.0, morphs: Object.freeze({ "あ": 1, "お": 0.4 }) }),
  /** Spring rate for every angle, so interrupted motions ease back. */
  rate: 8,
});

const ANGLES = ["tilt", "chest", "shoulders", "shoulderLeft", "shoulderRight", "back", "headPitch", "yawn"];
const LIMITS = Object.freeze({
  tilt: [-IDLE_MOTION.tilt.angle, IDLE_MOTION.tilt.angle],
  chest: [0, IDLE_MOTION.sigh.chest],
  shoulders: [0, Math.max(IDLE_MOTION.sigh.shoulders, IDLE_MOTION.stretch.shoulders)],
  shoulderLeft: [0, IDLE_MOTION.shrug.angle],
  shoulderRight: [0, IDLE_MOTION.shrug.angle],
  back: [0, IDLE_MOTION.stretch.back],
  headPitch: [-IDLE_MOTION.nod.angle, IDLE_MOTION.stretch.headPitch],
  yawn: [0, 1],
});

const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const within = ([min, max], r) => min + (max - min) * r;

/**
 * Authored envelope: ease in over `rise`, hold at 1, ease out over `rise`.
 * Short durations shrink the ramps so the curve stays symmetric.
 * @param {number} t Seconds since the motion began.
 * @param {number} duration Total seconds.
 * @param {number} rise Ramp seconds at each end.
 * @returns {number} Weight from 0 to 1.
 */
export function bump(t, duration, rise) {
  if (!(t > 0) || !(t < duration)) return 0;
  const ramp = Math.min(rise, duration / 2);
  return smoothstep(t / ramp) * smoothstep((duration - t) / ramp);
}

/** Breath in over `inhale`, out over `exhale`. */
function sighCurve(t) {
  const { inhale, exhale } = IDLE_MOTION.sigh;
  if (!(t > 0) || t >= inhale + exhale) return 0;
  return t < inhale ? smoothstep(t / inhale) : 1 - smoothstep((t - inhale) / exhale);
}

/** Yawn: open slowly, hold, close; 0 outside its length. */
function yawnCurve(t) {
  const { open, hold, close } = IDLE_MOTION.yawn;
  if (!(t > 0) || t >= open + hold + close) return 0;
  if (t < open) return smoothstep(t / open);
  if (t < open + hold) return 1;
  return 1 - smoothstep((t - open - hold) / close);
}

/** The stretch with its yawn; also the step into sleepy. */
function stretchYawn(t, target) {
  const { rise, back, headPitch, shoulders } = IDLE_MOTION.stretch;
  const weight = bump(t, IDLE_TIMING.stretch, rise);
  target.back = weight * back;
  target.headPitch = weight * headPitch;
  target.shoulders = weight * shoulders;
  target.yawn = yawnCurve(t);
}

/** A slow sleepy head tilt; positive leans toward the left of the screen. */
const sleepyTilt = (sign) => (t, target) => {
  target.tilt = sign * IDLE_MOTION.tilt.angle * bump(t, SLEEPY_TILT, 0.8);
};
const SLEEPY_TILT = 3.2;

/** A dozing nod; negative headPitch dips the head forward. */
function nod(t, target) {
  target.headPitch = -IDLE_MOTION.nod.angle * bump(t, SLEEPY_TILT, IDLE_MOTION.nod.rise);
}

/**
 * What she may do on each sleepy interval, picked at random with equal chances
 * among the ones chosen in the panel. To add one: a duration in seconds,
 * apply(t, target) writing pose targets, and a SLEEP_ACTION_LABELS entry.
 */
export const SLEEP_ACTIONS = Object.freeze({
  "stretch-yawn": Object.freeze({ duration: IDLE_TIMING.stretch, apply: stretchYawn }),
  "tilt-left": Object.freeze({ duration: SLEEPY_TILT, apply: sleepyTilt(1) }),
  "tilt-right": Object.freeze({ duration: SLEEPY_TILT, apply: sleepyTilt(-1) }),
  "nod": Object.freeze({ duration: SLEEPY_TILT, apply: nod }),
});

/** Panel labels for the sleep action checkboxes (#149). */
export const SLEEP_ACTION_LABELS = Object.freeze({
  "stretch-yawn": "Stretch & yawn",
  "tilt-left": "Tilt head left",
  "tilt-right": "Tilt head right",
  "nod": "Dozing nod",
});

export const SLEEP_ACTIONS_KEY = "yidhari.sleep-actions";

/** One or both shoulders (left/right of the screen) lift and drop. */
const shrug = (left, right) => ({
  create: (random) => ({ duration: within(IDLE_MOTION.shrug.duration, random()) }),
  apply: (motion, target) => {
    const lift = IDLE_MOTION.shrug.angle * bump(motion.t, motion.duration, IDLE_MOTION.shrug.rise);
    if (left) target.shoulderLeft = lift;
    if (right) target.shoulderRight = lift;
    return null;
  },
});

/**
 * Awake idle actions (#149), all equally likely: each gets weight 1 / count,
 * so adding one rebalances the rest. create(random) draws the action's own
 * parameters (it needs a duration); apply(motion, target) writes pose targets
 * and returns a glance target or null.
 */
const AWAKE_ACTIONS = {
  glance: {
    create: (random) => {
      const dir = random() < 0.5 ? -1 : 1;
      const duration = within(IDLE_MOTION.glance.duration, random());
      return { dir, duration, x: dir * within(IDLE_MOTION.glance.x, random()), y: within(IDLE_MOTION.glance.y, random()) };
    },
    apply: (motion) => ({ x: motion.x, y: motion.y }),
  },
  tilt: {
    create: (random) => {
      const dir = random() < 0.5 ? -1 : 1;
      return { dir, duration: within(IDLE_MOTION.tilt.duration, random()) };
    },
    apply: (motion, target) => {
      target.tilt = motion.dir * IDLE_MOTION.tilt.angle * bump(motion.t, motion.duration, IDLE_MOTION.tilt.rise);
      return null;
    },
  },
  "shrug-left": shrug(true, false),
  "shrug-right": shrug(false, true),
  "shrug-both": shrug(true, true),
  sigh: {
    create: () => ({ dir: 1, duration: IDLE_MOTION.sigh.inhale + IDLE_MOTION.sigh.exhale }),
    apply: (motion, target) => {
      const breath = sighCurve(motion.t);
      target.chest = breath * IDLE_MOTION.sigh.chest;
      target.shoulders = breath * IDLE_MOTION.sigh.shoulders;
      return null;
    },
  },
};
const AWAKE_COUNT = Object.keys(AWAKE_ACTIONS).length;
export const IDLE_ACTIONS = Object.freeze(Object.fromEntries(Object.entries(AWAKE_ACTIONS)
  .map(([name, action]) => [name, Object.freeze({ ...action, weight: 1 / AWAKE_COUNT })])));

/**
 * Turns the idle state into one small motion at a time.
 * update() returns `{ glance, tilt, chest, shoulders, shoulderLeft, shoulderRight, back, headPitch, yawn }`:
 * glance is a normalised gaze target or null, yawn is a 0–1 weight for
 * IDLE_MOTION.yawn.morphs, and the rest are radians.
 */
export class IdleMotion {
  /** @param {{ random?: () => number }} [options] Random source in [0, 1). */
  constructor({ random = Math.random } = {}) {
    this.random = random;
    /** @type {null | { kind: string, t: number, duration: number }} The awake idle action playing. */
    this.current = null;
    this.gapLeft = null;
    /** Current sleep action's name, and the sleepy interval it belongs to. */
    this.sleepAction = null;
    this.sleepCycle = null;
    /** Sleep actions that may be picked, in SLEEP_ACTIONS order. */
    this.sleepActions = Object.keys(SLEEP_ACTIONS);
    this.springs = Object.fromEntries(ANGLES.map((key) => [key, new Spring(0)]));
  }

  /**
   * @param {number} delta Seconds since the previous frame; invalid values count as 0.
   * @param {string} state IdleController state.
   * @param {number} stateTime Seconds in that state.
   * @param {number} [sleepActionEvery=0] While sleepy, do a random sleep action this often (s); 0 = never.
   * @returns {{glance:{x:number,y:number}|null,tilt:number,chest:number,shoulders:number,shoulderLeft:number,shoulderRight:number,back:number,headPitch:number,yawn:number}}
   */
  update(delta, state, stateTime, sleepActionEvery = 0) {
    const dt = Number.isFinite(delta) && delta > 0 ? delta : 0;
    const target = Object.fromEntries(ANGLES.map((key) => [key, 0]));
    let glance = null;
    if (state === "idle") {
      this.gapLeft ??= this.#gap();
      if (this.current) {
        this.current.t += dt;
        if (this.current.t >= this.current.duration) {
          this.current = null;
          this.gapLeft = this.#gap();
        }
      } else {
        this.gapLeft -= dt;
        if (this.gapLeft <= 0) this.current = this.#pick();
      }
      glance = this.#apply(target);
    } else {
      this.current = null;
      this.gapLeft = null;
      if (state === "stretching") stretchYawn(stateTime, target);
      if (state === "sleepy" && sleepActionEvery > 0 && stateTime >= sleepActionEvery) {
        // A random sleep action at the start of every interval while sleepy.
        const cycle = Math.floor(stateTime / sleepActionEvery);
        if (cycle !== this.sleepCycle) {
          this.sleepCycle = cycle;
          this.sleepAction = this.#pickSleepAction();
        }
        const action = SLEEP_ACTIONS[this.sleepAction];
        const t = stateTime - cycle * sleepActionEvery;
        if (action && t < action.duration) action.apply(t, target);
      } else if (state !== "sleepy") {
        this.sleepAction = null;
        this.sleepCycle = null;
      }
    }
    const pose = { glance };
    for (const key of ANGLES) {
      const spring = this.springs[key];
      spring.step(target[key], dt, IDLE_MOTION.rate);
      spring.clamp(...LIMITS[key]);
      pose[key] = spring.settle(target[key], 1e-6);
    }
    return pose;
  }

  /**
   * Choose which sleep actions may be picked; unknown names are ignored.
   * @param {Iterable<string>} names
   * @returns {void}
   */
  setSleepActions(names) {
    const chosen = new Set(names);
    this.sleepActions = Object.keys(SLEEP_ACTIONS).filter((name) => chosen.has(name));
  }

  #pickSleepAction() {
    const names = this.sleepActions;
    if (names.length === 0) return null;
    return names[Math.min(names.length - 1, Math.floor(this.random() * names.length))];
  }

  #gap() {
    return within(IDLE_MOTION.gap, this.random());
  }

  #pick() {
    const roll = this.random();
    const names = Object.keys(IDLE_ACTIONS);
    let kind = names.at(-1);
    let reach = 0;
    for (const name of names) {
      reach += IDLE_ACTIONS[name].weight;
      if (roll < reach) {
        kind = name;
        break;
      }
    }
    return { kind, t: 0, ...IDLE_ACTIONS[kind].create(this.random) };
  }

  /** Write the current motion's targets; returns the glance target, if any. */
  #apply(target) {
    const motion = this.current;
    return motion ? IDLE_ACTIONS[motion.kind].apply(motion, target) : null;
  }
}

/**
 * Bind the panel's sleep action checkboxes (#149). All are ticked by default;
 * the choice is saved as a JSON list of names when storage allows.
 * @param {IdleMotion} motion
 * @param {Record<string, { checked: boolean, addEventListener(type: string, fn: () => void): void }>} boxes By action name.
 * @param {{ local?: Storage }} [options]
 * @returns {void}
 */
export function bindSleepActionSettings(motion, boxes, { local } = {}) {
  try {
    local ??= globalThis.localStorage;
  } catch { /* Storage access itself can throw. */ }
  let chosen = Object.keys(SLEEP_ACTIONS);
  try {
    const saved = JSON.parse(local?.getItem(SLEEP_ACTIONS_KEY) ?? "null");
    if (Array.isArray(saved)) chosen = saved;
  } catch { /* Missing, blocked or corrupt: all of them. */ }
  motion.setSleepActions(chosen);
  for (const [name, box] of Object.entries(boxes)) {
    if (!box) continue;
    box.checked = motion.sleepActions.includes(name);
    box.addEventListener("change", () => {
      const ticked = Object.keys(SLEEP_ACTIONS).filter((action) =>
        (boxes[action] ? boxes[action].checked : motion.sleepActions.includes(action)));
      motion.setSleepActions(ticked);
      try {
        local?.setItem(SLEEP_ACTIONS_KEY, JSON.stringify(motion.sleepActions));
      } catch { /* Session-only. */ }
    });
  }
}
