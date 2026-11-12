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
  shrug: Object.freeze({ duration: Object.freeze([2.4, 3.0]), angle: 12 * DEG, rise: 1.2 }),
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

/** A head tilt; sign 1 leans toward the left of the screen. */
const tilt = (sign) => ({
  create: (random) => ({ duration: within(IDLE_MOTION.tilt.duration, random()) }),
  apply: (motion, target) => {
    target.tilt = sign * IDLE_MOTION.tilt.angle * bump(motion.t, motion.duration, IDLE_MOTION.tilt.rise);
    return null;
  },
});

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

const NOD = 3.2;

/**
 * Every action she may do (#149), while awake and idle and while asleep,
 * picked by weight among the ticked ones; the weights sum to 1. Shrugs stay
 * rare: equal chances made them too common. create(random) draws the action's
 * own parameters, including its duration; apply(motion, target) writes pose
 * targets for motion.t seconds in, and returns a glance target or null.
 * To add one: an entry here, an ACTION_LABELS entry and a test.
 */
export const ACTIONS = Object.freeze({
  glance: Object.freeze({
    weight: 0.3,
    create: (random) => {
      const dir = random() < 0.5 ? -1 : 1;
      const duration = within(IDLE_MOTION.glance.duration, random());
      return { duration, x: dir * within(IDLE_MOTION.glance.x, random()), y: within(IDLE_MOTION.glance.y, random()) };
    },
    apply: (motion) => ({ x: motion.x, y: motion.y }),
  }),
  "tilt-left": Object.freeze({ weight: 0.1, ...tilt(1) }),
  "tilt-right": Object.freeze({ weight: 0.1, ...tilt(-1) }),
  "shrug-left": Object.freeze({ weight: 0.05, ...shrug(true, false) }),
  "shrug-right": Object.freeze({ weight: 0.05, ...shrug(false, true) }),
  "shrug-both": Object.freeze({ weight: 0.05, ...shrug(true, true) }),
  sigh: Object.freeze({
    weight: 0.15,
    create: () => ({ duration: IDLE_MOTION.sigh.inhale + IDLE_MOTION.sigh.exhale }),
    apply: (motion, target) => {
      const breath = sighCurve(motion.t);
      target.chest = breath * IDLE_MOTION.sigh.chest;
      target.shoulders = breath * IDLE_MOTION.sigh.shoulders;
      return null;
    },
  }),
  "stretch-yawn": Object.freeze({
    weight: 0.1,
    create: () => ({ duration: IDLE_TIMING.stretch }),
    apply: (motion, target) => {
      stretchYawn(motion.t, target);
      return null;
    },
  }),
  nod: Object.freeze({
    weight: 0.1,
    create: () => ({ duration: NOD }),
    apply: (motion, target) => {
      target.headPitch = -IDLE_MOTION.nod.angle * bump(motion.t, NOD, IDLE_MOTION.nod.rise);
      return null;
    },
  }),
});

/** Panel labels for the action checkboxes (#149). */
export const ACTION_LABELS = Object.freeze({
  glance: "Glance",
  "tilt-left": "Tilt head left",
  "tilt-right": "Tilt head right",
  "shrug-left": "Shrug left",
  "shrug-right": "Shrug right",
  "shrug-both": "Shrug both",
  sigh: "Sigh",
  "stretch-yawn": "Stretch & yawn",
  nod: "Dozing nod",
});

export const ACTIONS_KEY = "yidhari.actions";

/**
 * Turns the idle state into one small action at a time: every 8-20 s while
 * idle, and on every sleep action interval while asleep.
 * update() returns `{ glance, tilt, chest, shoulders, shoulderLeft, shoulderRight, back, headPitch, yawn }`:
 * glance is a normalised gaze target or null, yawn is a 0-1 weight for
 * IDLE_MOTION.yawn.morphs, and the rest are radians.
 */
export class IdleMotion {
  /** @param {{ random?: () => number }} [options] Random source in [0, 1). */
  constructor({ random = Math.random } = {}) {
    this.random = random;
    /** @type {null | { kind: string, t: number, duration: number }} The action playing while idle. */
    this.current = null;
    this.gapLeft = null;
    /** The action picked for the current sleepy interval, its name, and the interval. */
    this.sleepMotion = null;
    this.sleepAction = null;
    this.sleepCycle = null;
    /** Actions that may be picked, in ACTIONS order. */
    this.actions = Object.keys(ACTIONS);
    this.springs = Object.fromEntries(ANGLES.map((key) => [key, new Spring(0)]));
  }

  /**
   * @param {number} delta Seconds since the previous frame; invalid values count as 0.
   * @param {string} state IdleController state.
   * @param {number} stateTime Seconds in that state.
   * @param {number} [sleepActionEvery=0] While sleepy, do a random action this often (s); 0 = never.
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
        if (this.gapLeft <= 0) {
          this.current = this.#pick();
          if (!this.current) this.gapLeft = this.#gap(); // nothing ticked: stay still
        }
      }
      if (this.current) glance = ACTIONS[this.current.kind].apply(this.current, target);
    } else {
      this.current = null;
      this.gapLeft = null;
      if (state === "stretching") stretchYawn(stateTime, target);
      if (state === "sleepy" && sleepActionEvery > 0 && stateTime >= sleepActionEvery) {
        // A random action at the start of every interval while sleepy.
        const cycle = Math.floor(stateTime / sleepActionEvery);
        if (cycle !== this.sleepCycle) {
          this.sleepCycle = cycle;
          this.sleepMotion = this.#pick();
          this.sleepAction = this.sleepMotion?.kind ?? null;
        }
        const motion = this.sleepMotion;
        if (motion) {
          motion.t = stateTime - cycle * sleepActionEvery;
          if (motion.t < motion.duration) glance = ACTIONS[motion.kind].apply(motion, target);
        }
      } else if (state !== "sleepy") {
        this.sleepMotion = null;
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
   * Choose which actions may be picked, awake or asleep; unknown names are ignored.
   * @param {Iterable<string>} names
   * @returns {void}
   */
  setActions(names) {
    const chosen = new Set(names);
    this.actions = Object.keys(ACTIONS).filter((name) => chosen.has(name));
  }

  #gap() {
    return within(IDLE_MOTION.gap, this.random());
  }

  /** A new instance of a ticked action, by weight; null when nothing is ticked. */
  #pick() {
    const names = this.actions;
    if (names.length === 0) return null;
    // Ticked actions keep their relative chances.
    const total = names.reduce((sum, name) => sum + ACTIONS[name].weight, 0);
    const roll = this.random() * total;
    let kind = names.at(-1);
    let reach = 0;
    for (const name of names) {
      reach += ACTIONS[name].weight;
      if (roll < reach) {
        kind = name;
        break;
      }
    }
    return { kind, t: 0, ...ACTIONS[kind].create(this.random) };
  }
}

/**
 * Bind the panel's action checkboxes (#149): all ticked by default, the
 * choice saved as a JSON list of names when storage allows.
 * @param {IdleMotion} motion
 * @param {Record<string, { checked: boolean, addEventListener(type: string, fn: () => void): void }>} boxes By action name.
 * @param {{ local?: Storage }} [options]
 * @returns {void}
 */
export function bindActionSettings(motion, boxes, { local } = {}) {
  try {
    local ??= globalThis.localStorage;
  } catch { /* Storage access itself can throw. */ }
  const names = Object.keys(ACTIONS);
  let chosen = names;
  try {
    const saved = JSON.parse(local?.getItem(ACTIONS_KEY) ?? "null");
    if (Array.isArray(saved)) chosen = saved;
  } catch { /* Missing, blocked or corrupt: all of them. */ }
  motion.setActions(chosen);
  for (const [name, box] of Object.entries(boxes)) {
    if (!box) continue;
    box.checked = motion.actions.includes(name);
    box.addEventListener("change", () => {
      motion.setActions(names.filter((action) => (boxes[action] ? boxes[action].checked : motion.actions.includes(action))));
      try {
        local?.setItem(ACTIONS_KEY, JSON.stringify(motion.actions));
      } catch { /* Session-only. */ }
    });
  }
}
