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
  /** Cumulative chances: glance 40 %, tilt 30 %, sigh 30 %. */
  chance: Object.freeze({ glance: 0.4, tilt: 0.7 }),
  glance: Object.freeze({
    duration: Object.freeze([1.2, 2.2]),
    x: Object.freeze([0.45, 0.75]),
    y: Object.freeze([-0.15, 0.15]),
  }),
  tilt: Object.freeze({ duration: Object.freeze([2, 3.5]), angle: 5 * DEG, rise: 0.6 }),
  sigh: Object.freeze({ inhale: 1.1, exhale: 1.7, chest: 2 * DEG, shoulders: 2.5 * DEG }),
  stretch: Object.freeze({ rise: 1, back: 5 * DEG, headPitch: 7 * DEG, shoulders: 6 * DEG }),
  /** The yawn during the stretch: the user's mouth pick, opened slowly (#71). */
  yawn: Object.freeze({ open: 1.4, hold: 0.6, close: 1.0, morphs: Object.freeze({ "あ": 1, "お": 0.4 }) }),
  /** Spring rate for every angle, so interrupted motions ease back. */
  rate: 8,
});

const ANGLES = ["tilt", "chest", "shoulders", "back", "headPitch", "yawn"];
const LIMITS = Object.freeze({
  tilt: [-IDLE_MOTION.tilt.angle, IDLE_MOTION.tilt.angle],
  chest: [0, IDLE_MOTION.sigh.chest],
  shoulders: [0, Math.max(IDLE_MOTION.sigh.shoulders, IDLE_MOTION.stretch.shoulders)],
  back: [0, IDLE_MOTION.stretch.back],
  headPitch: [0, IDLE_MOTION.stretch.headPitch],
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

/**
 * What she may do on each sleepy interval, picked at random with equal chances.
 * To add one: a duration in seconds and apply(t, target) writing pose targets.
 */
export const SLEEP_ACTIONS = Object.freeze({
  "stretch-yawn": Object.freeze({ duration: IDLE_TIMING.stretch, apply: stretchYawn }),
  "tilt-left": Object.freeze({ duration: SLEEPY_TILT, apply: sleepyTilt(1) }),
  "tilt-right": Object.freeze({ duration: SLEEPY_TILT, apply: sleepyTilt(-1) }),
});

/**
 * Turns the idle state into one small motion at a time.
 * update() returns `{ glance, tilt, chest, shoulders, back, headPitch, yawn }`:
 * glance is a normalised gaze target or null, yawn is a 0–1 weight for
 * IDLE_MOTION.yawn.morphs, and the rest are radians.
 */
export class IdleMotion {
  /** @param {{ random?: () => number }} [options] Random source in [0, 1). */
  constructor({ random = Math.random } = {}) {
    this.random = random;
    /** @type {null | { kind: "glance"|"tilt"|"sigh", t: number, duration: number, dir: number, x?: number, y?: number }} */
    this.current = null;
    this.gapLeft = null;
    /** Current sleep action's name, and the sleepy interval it belongs to. */
    this.sleepAction = null;
    this.sleepCycle = null;
    this.springs = Object.fromEntries(ANGLES.map((key) => [key, new Spring(0)]));
  }

  /**
   * @param {number} delta Seconds since the previous frame; invalid values count as 0.
   * @param {string} state IdleController state.
   * @param {number} stateTime Seconds in that state.
   * @param {number} [sleepActionEvery=0] While sleepy, do a random sleep action this often (s); 0 = never.
   * @returns {{glance:{x:number,y:number}|null,tilt:number,chest:number,shoulders:number,back:number,headPitch:number,yawn:number}}
   */
  update(delta, state, stateTime, sleepActionEvery = 0) {
    const dt = Number.isFinite(delta) && delta > 0 ? delta : 0;
    const target = { tilt: 0, chest: 0, shoulders: 0, back: 0, headPitch: 0, yawn: 0 };
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
        if (t < action.duration) action.apply(t, target);
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

  #pickSleepAction() {
    const names = Object.keys(SLEEP_ACTIONS);
    return names[Math.min(names.length - 1, Math.floor(this.random() * names.length))];
  }

  #gap() {
    return within(IDLE_MOTION.gap, this.random());
  }

  #pick() {
    const roll = this.random();
    const kind = roll < IDLE_MOTION.chance.glance ? "glance" : roll < IDLE_MOTION.chance.tilt ? "tilt" : "sigh";
    if (kind === "sigh") {
      return { kind, t: 0, duration: IDLE_MOTION.sigh.inhale + IDLE_MOTION.sigh.exhale, dir: 1 };
    }
    const dir = this.random() < 0.5 ? -1 : 1;
    const motion = { kind, t: 0, dir, duration: within(IDLE_MOTION[kind].duration, this.random()) };
    if (kind === "glance") {
      motion.x = dir * within(IDLE_MOTION.glance.x, this.random());
      motion.y = within(IDLE_MOTION.glance.y, this.random());
    }
    return motion;
  }

  /** Write the current motion's targets; returns the glance target, if any. */
  #apply(target) {
    const motion = this.current;
    if (!motion) return null;
    if (motion.kind === "glance") return { x: motion.x, y: motion.y };
    if (motion.kind === "tilt") {
      const { angle, rise } = IDLE_MOTION.tilt;
      target.tilt = motion.dir * angle * bump(motion.t, motion.duration, rise);
    } else {
      const breath = sighCurve(motion.t);
      target.chest = breath * IDLE_MOTION.sigh.chest;
      target.shoulders = breath * IDLE_MOTION.sigh.shoulders;
    }
    return null;
  }
}
